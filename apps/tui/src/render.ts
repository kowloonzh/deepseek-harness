/** Deterministic full-screen ANSI renderer for the terminal frontend. */

import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { marked, type Token, type Tokens } from 'marked'
import type {
  ModelChoice,
  Overlay,
  PendingSubmission,
  QuestionPrompt,
  SlashSuggestion,
} from './ui.ts'
import type { ClipboardImage } from './clipboard.ts'
import { messages } from './locale.ts'
import type {
  TranscriptItem,
  TranscriptState,
  ToolStatus,
} from './transcript.ts'
import { characterWidth, paintScreen, ScreenBuffer } from './screen.ts'

const ESC = '\u001b['
const RESET = `${ESC}0m`
const BOLD = `${ESC}1m`
const DIM = `${ESC}2m`
const CYAN = `${ESC}36m`
const YELLOW = `${ESC}33m`
const RED = `${ESC}31m`
const GREEN = `${ESC}32m`
const TRANSCRIPT_LEFT_PADDING = 2
const USER_BLOCK_STYLE = `${ESC}97m${ESC}48;5;238m`
const USER_PROMPT_PREFIX = '› '
const OSC = '\u001b]'
const ST = '\u001b\\'
const ANSI_SEQUENCE = /^(?:\u001b\[[0-?]*[ -/]*[@-~]|\u001b\](?:[^\u0007\u001b]|\u001b(?!\\))*(?:\u0007|\u001b\\))/u

/** One terminal cell position, using one-based screen coordinates. */
export interface TerminalPoint {
  readonly column: number
  readonly row: number
}

/** Inclusive mouse selection endpoints on the rendered screen. */
export interface TerminalSelection {
  readonly anchor: TerminalPoint
  readonly head: TerminalPoint
}

/** Plain transcript rows available to application-owned text selection. */
export interface RenderedSelectionRegion {
  readonly top: number
  readonly rows: readonly string[]
}

/** Complete frame and terminal cursor position. */
export interface RenderedFrame {
  /** The composed rows with their styling, joined by CRLF: what the frame shows. */
  readonly text: string
  /** Bytes that bring the terminal from the previous frame to this one, cursor included. */
  readonly paint: string
  readonly cursorRow: number
  readonly cursorColumn: number
  readonly selectionRegion: RenderedSelectionRegion | undefined
  /** Rows the transcript area holds this frame; a page scroll moves by one fewer. */
  readonly transcriptRows: number
  /** Where this frame's transcript view sits, resolved against what it showed. */
  readonly position: TranscriptPosition
  /**
   * The position `rows` away from this frame's top row, anchored to the content found there.
   * @param rows - negative toward older content, positive toward the latest.
   * @returns `LATEST` once the move reaches the bottom, otherwise a reading anchor.
   */
  scrollBy(rows: number): TranscriptPosition
}

/**
 * Where the transcript view sits, as codex's `Position::Latest | Reading(Anchor)`.
 *
 * Latest follows the newest rows. Reading pins the view's top row to content: the transcript
 * item that row belongs to and how far into that item it is. Rows appended below, a resize
 * that rewraps every item, or an item above growing all leave the same text at the top, which
 * a row count from either end cannot do.
 */
export type TranscriptPosition =
  | { readonly kind: 'latest' }
  | {
    readonly kind: 'reading'
    /** The item the top row belongs to. */
    readonly key: string
    /** Rows into that item. */
    readonly offset: number
    /** The item's height when anchored; a rewrapped item scales the offset to its new height. */
    readonly span: number
    /** The top row's index when anchored, used once the item itself is gone. */
    readonly index: number
  }

/** Follow the newest rows. */
export const LATEST: TranscriptPosition = { kind: 'latest' }

/** The transcript item, and the row within it, that one transcript row was rendered from. */
interface RowOwner {
  readonly key: string
  readonly offset: number
}

/** The title row above the conversation. */
const HEADER_ROWS = 1
/** The status row, which sits directly under the composer as codex's footer does. */
const STATUS_ROWS = 1
/** The blank row between the transcript and the bottom pane. */
const GAP_ROWS = 1
/** Most slash suggestions shown at once. */
const SLASH_MENU_ROWS = 6

/**
 * Tallest the bottom pane may grow: two thirds of the conversation area, but never under eight
 * rows, as codex's `composer_height_limit`. The transcript always keeps the rest.
 * @param area - rows below the header.
 * @returns the bottom pane's row budget, status row included.
 */
export function bottomPaneLimit(area: number): number {
  return Math.min(area, Math.max(8, Math.floor(area * 2 / 3)))
}

/** How many rows each section of one frame occupies. */
interface FrameLayout {
  readonly header: number
  readonly transcript: number
  readonly gap: number
  /** Slash suggestion rows painted over the bottom of the transcript and the gap. */
  readonly menu: number
  /** The queue dock or an open view, then the composer. */
  readonly bottom: number
  readonly status: number
  readonly total: number
}

interface TranscriptRenderCache {
  readonly items: readonly TranscriptItem[]
  readonly width: number
  readonly expandedTools: boolean
  readonly lines: string[]
  readonly owners: RowOwner[]
}

/** Inputs shared by the renderer and its tests. */
export interface RenderViewOptions {
  readonly rows: number
  readonly columns: number
  readonly state: TranscriptState
  readonly input: string
  readonly cursor: number
  readonly images?: readonly ClipboardImage[]
  readonly submission?: PendingSubmission | undefined
  readonly slashSuggestions?: readonly SlashSuggestion[]
  readonly slashSuggestionIndex?: number
  readonly slashLoading?: boolean
  readonly overlay: Overlay | undefined
  readonly expandedTools: boolean
  readonly scroll: TranscriptPosition
  /** Keep a reading position even at the bottom: a selection is pinned to the rows it covers. */
  readonly holdPosition?: boolean
  readonly notice: string | undefined
  readonly selection?: TerminalSelection | undefined
}

/**
 * Append one frame's drawing facts when `DSH_TUI_DEBUG_RENDER` names a file.
 * Records whether the frame repainted the whole screen, plus every row whose
 * measured width disagrees with the terminal's column count.
 * @param options - the frame's terminal dimensions and scroll offset.
 * @param incremental - whether the caller asked for a changed-cell repaint.
 * @param fullRepaint - whether the frame cleared the screen and wrote every cell.
 * @param lines - composed screen rows.
 * @param changedBytes - byte length of the update sent to the terminal.
 */
function dumpRenderTrace(
  options: RenderViewOptions,
  incremental: boolean,
  fullRepaint: boolean,
  lines: readonly string[],
  changedBytes: number,
  layout: FrameLayout | undefined,
): void {
  const path = process.env.DSH_TUI_DEBUG_RENDER
  if (path === undefined || path === '') return
  const columns = Math.max(20, options.columns)
  const rows = Math.max(10, options.rows)
  const wide: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const measured = displayWidth(lines[index] ?? '')
    if (measured > columns) wide.push(`${String(index + 1)}=${String(measured)}`)
  }
  const record = [
    `t=${String(Date.now())}`,
    `mode=${incremental ? 'incremental' : 'full'}`,
    `repaint=${fullRepaint ? 'whole-screen' : 'changed-cells'}`,
    `cols=${String(columns)}`,
    `rows=${String(rows)}`,
    `lines=${String(lines.length)}`,
    `scroll=${options.scroll.kind === 'latest' ? 'latest' : `${options.scroll.key}+${String(options.scroll.offset)}`}`,
    `bytes=${String(changedBytes)}`,
    `overwide=${wide.length === 0 ? '-' : wide.join(',')}`,
    // The section sizes the frame was composed from: an overlap here is a geometry bug, and
    // a frame that sums to `rows` without one still leaves a desync to the terminal itself.
    layout === undefined
      ? 'layout=-'
      : `layout=header${String(layout.header)}+transcript${String(layout.transcript)}+gap${String(layout.gap)}`
        + `+bottom${String(layout.bottom)}+status${String(layout.status)}`
        + `=${String(layout.total)}/${String(rows)} menu${String(layout.menu)}`,
  ].join(' ')
  try {
    appendFileSync(path, `${record}\n`)
  } catch (_traceWriteFailed) {
    // Diagnostics only: an unwritable trace path must never disturb rendering.
  }
}

/**
 * Render one complete alternate-screen frame.
 * @param options - terminal dimensions, transcript, composer, overlay, and scroll.
 * @returns frame body plus the absolute terminal cursor.
 */
export function renderView(options: RenderViewOptions): RenderedFrame {
  return new TerminalRenderer().render(options)
}

/** Stateful renderer that reuses transcript wrapping and updates changed cells only. */
export class TerminalRenderer {
  private transcriptCache: TranscriptRenderCache | undefined
  /** The grid the terminal shows after the last frame, which the next frame is diffed against. */
  private screen: ScreenBuffer | undefined
  private screenRows: readonly string[] = []

  /**
   * Rows of the most recent frame, without ANSI styling.
   * Incremental frames write only changed cells, so this is the only complete view.
   * @returns screen rows top to bottom, or an empty array before the first frame.
   */
  screenLines(): readonly string[] {
    return this.screenRows.map(line => stripAnsi(line))
  }

  /**
   * Render one frame, optionally updating only the cells that changed since the last one.
   *
   * The composed rows are written into a grid the size of the terminal, so a row that measures
   * wider than the terminal is clipped at the margin instead of folding onto the composer, and
   * rows past the bottom are dropped instead of scrolling the screen.
   * @param options - terminal dimensions, transcript, composer, overlay, and scroll.
   * @param incremental - diff against the previous frame; otherwise clear and redraw everything.
   * @returns the composed rows, the bytes to paint them, and the absolute terminal cursor.
   */
  render(options: RenderViewOptions, incremental = false): RenderedFrame {
    const frame = this.compose(options)
    const screen = ScreenBuffer.fromLines(Math.max(1, options.columns), Math.max(1, options.rows), frame.lines)
    const previous = incremental ? this.screen : undefined
    const fullRepaint = previous?.width !== screen.width || previous.height !== screen.height
    const paint = paintScreen(previous, screen, { row: frame.cursorRow, column: frame.cursorColumn })
    this.screen = screen
    this.screenRows = frame.lines
    dumpRenderTrace(options, incremental, fullRepaint, frame.lines, paint.length, frame.layout)
    return {
      ...frame,
      text: frame.lines.join('\r\n'),
      paint,
    }
  }

  /**
   * Lay out one frame the way codex lays out its conversation.
   *
   * The bottom pane is measured first and anchored to the bottom: the queue dock (or an open
   * view such as an approval, in its place), the composer, then the status row. It may take up
   * to `bottomPaneLimit` rows; inside it the composer keeps its rows and whatever sits above it
   * gives up rows first. Unlike codex, a view does not hide the composer, so the draft and its
   * cursor stay in sight while a view waits for an answer. The transcript
   * gets everything above it, less one gap row. Slash suggestions are painted over the bottom of
   * the transcript, so opening or closing the menu never moves the transcript or the composer.
   * @param options - terminal dimensions and everything the frame shows.
   * @returns exactly `height` rows, the cursor, and the size of each section.
   */
  private compose(options: RenderViewOptions): Omit<RenderedFrame, 'text' | 'paint'> & { readonly lines: string[]; readonly layout: FrameLayout } {
    const width = Math.max(20, options.columns)
    const height = Math.max(10, options.rows)
    const title = options.state.title || messages.unnamedSession
    const runState = options.state.running ? `${YELLOW}${messages.running}${RESET}` : `${GREEN}${messages.idle}${RESET}`
    const header = `${BOLD}${messages.appTitle}${RESET} ${DIM}·${RESET} ${sanitize(title)} ${DIM}·${RESET} ${runState}`
    const area = height - HEADER_ROWS
    const limit = bottomPaneLimit(area)
    const paneRows = limit - STATUS_ROWS

    // Bottom pane: the composer first (two border rows around at least one inner row), then
    // whatever fits above it — an open view, or else the queue dock.
    const composer = composerLines(options.input, options.cursor, options.images ?? [], width, Math.max(1, paneRows - 2))
    const above = Math.max(0, paneRows - composer.lines.length)
    const flexible = options.overlay === undefined
      ? queueDockLines(options.state.queue, options.submission, width, above)
      : overlayLines(options.overlay, width, above).slice(0, above)
    const pane = [...flexible, ...composer.lines]
    const cursor = { line: flexible.length + composer.cursorLine, column: composer.cursorColumn }
    const bottomRows = pane.length + STATUS_ROWS
    const gapRows = area - bottomRows >= GAP_ROWS + 1 ? GAP_ROWS : 0
    const transcriptRows = Math.max(0, area - bottomRows - gapRows)

    // Transcript: the rows that remain, top-aligned while the conversation is shorter than them.
    // One column of slack: the transcript is indented after wrapping, and a row that ends exactly
    // on the last column makes the terminal fold a trailing wide glyph.
    const { lines: body, owners } = this.cachedTranscriptLines(options, Math.max(8, width - TRANSCRIPT_LEFT_PADDING - 1))
    const maxTop = Math.max(0, body.length - transcriptRows)
    const top = resolveTop(options.scroll, owners, maxTop)
    const position = options.scroll.kind === 'reading' && (top < maxTop || options.holdPosition === true)
      ? anchorAt(owners, top)
      : LATEST
    const scrollBy = (rows: number): TranscriptPosition => {
      const next = Math.min(maxTop, Math.max(0, top + rows))
      return next >= maxTop && rows > 0 ? LATEST : anchorAt(owners, next)
    }
    const visible = body.slice(top, top + transcriptRows)
    while (visible.length < transcriptRows) visible.push('')
    const paddedBody = visible.map(line => fitAnsi(`${' '.repeat(TRANSCRIPT_LEFT_PADDING)}${line}`, width))
    const selectedBody = highlightSelection(paddedBody, HEADER_ROWS + 1, options.selection, width)
    const conversation = [...selectedBody, ...Array.from({ length: gapRows }, () => '')]
    const shown = paddedBody.map(stripAnsi)

    // Slash suggestions cover the rows just above the bottom pane; the highlighted row stays in view.
    const slashMenu = options.overlay === undefined
      ? slashMenuLines(options.slashSuggestions ?? [], options.slashSuggestionIndex ?? 0, options.slashLoading === true, width)
      : []
    const menuRows = Math.min(slashMenu.length, conversation.length)
    const menuStart = Math.min(
      slashMenu.length - menuRows,
      Math.max(0, (options.slashSuggestionIndex ?? 0) - Math.floor(menuRows / 2)),
    )
    for (const [offset, line] of slashMenu.slice(menuStart, menuStart + menuRows).entries()) {
      const row = conversation.length - menuRows + offset
      conversation[row] = fitAnsi(line, width)
      // A covered transcript row is not on screen, so it cannot be selected either.
      if (row < shown.length) shown[row] = ''
    }

    const status = statusLine(options.state, width, options.notice, position.kind === 'reading')
    const lines = [
      fitAnsi(header, width),
      ...conversation,
      ...pane.map(line => fitAnsi(line, width)),
      fitAnsi(status, width),
    ]
    const paneTop = HEADER_ROWS + conversation.length
    return {
      lines,
      cursorRow: paneTop + cursor.line + 1,
      cursorColumn: Math.min(width - 1, 5 + cursor.column),
      transcriptRows,
      position,
      scrollBy,
      layout: {
        header: HEADER_ROWS,
        transcript: transcriptRows,
        gap: gapRows,
        menu: menuRows,
        bottom: pane.length,
        status: STATUS_ROWS,
        total: lines.length,
      },
      selectionRegion: { top: HEADER_ROWS + 1, rows: shown },
    }
  }

  private cachedTranscriptLines(options: RenderViewOptions, width: number): { readonly lines: string[]; readonly owners: RowOwner[] } {
    const cached = this.transcriptCache
    if (cached !== undefined
      && cached.items === options.state.items
      && cached.width === width
      && cached.expandedTools === options.expandedTools) {
      return cached
    }
    const { lines, owners } = transcriptLines(options.state.items, options.expandedTools, width)
    this.transcriptCache = {
      items: options.state.items,
      width,
      expandedTools: options.expandedTools,
      lines,
      owners,
    }
    return { lines, owners }
  }
}

/**
 * Extract the text covered by a screen selection.
 * @param region - transcript rows captured by the rendered frame.
 * @param selection - inclusive mouse endpoints.
 * @returns selected rows joined with newlines and without trailing row padding.
 */
export function selectedText(
  region: RenderedSelectionRegion | undefined,
  selection: TerminalSelection | undefined,
): string {
  if (region === undefined || selection === undefined) return ''
  const ordered = orderSelection(selection)
  const firstRow = Math.max(region.top, ordered.start.row)
  const lastRow = Math.min(region.top + region.rows.length - 1, ordered.end.row)
  if (firstRow > lastRow) return ''
  const lines: string[] = []
  for (let row = firstRow; row <= lastRow; row += 1) {
    const text = region.rows[row - region.top] ?? ''
    const start = row === ordered.start.row ? ordered.start.column : 1
    const end = row === ordered.end.row ? ordered.end.column : Number.MAX_SAFE_INTEGER
    lines.push(stripPromptPrefix(sliceCells(text, start, end).trimEnd()))
  }
  return lines.join('\n')
}

function stripPromptPrefix(line: string): string {
  return line.replace(/^(\s*)› /u, '$1')
}

function highlightSelection(
  lines: readonly string[],
  top: number,
  selection: TerminalSelection | undefined,
  width: number,
): string[] {
  if (selection === undefined) return [...lines]
  const ordered = orderSelection(selection)
  return lines.map((line, index) => {
    const row = top + index
    if (row < ordered.start.row || row > ordered.end.row) return line
    const start = row === ordered.start.row ? ordered.start.column : 1
    const end = row === ordered.end.row ? ordered.end.column : width
    return highlightCells(line, start, end)
  })
}

function orderSelection(selection: TerminalSelection): {
  readonly start: TerminalPoint
  readonly end: TerminalPoint
} {
  const before = selection.anchor.row < selection.head.row
    || (selection.anchor.row === selection.head.row && selection.anchor.column <= selection.head.column)
  return before
    ? { start: selection.anchor, end: selection.head }
    : { start: selection.head, end: selection.anchor }
}

function highlightCells(line: string, startColumn: number, endColumn: number): string {
  let result = ''
  let index = 0
  let column = 1
  let highlighted = false
  while (index < line.length) {
    if (line[index] === '\u001b') {
      const match = ANSI_SEQUENCE.exec(line.slice(index))
      if (match !== null) {
        result += match[0]
        index += match[0].length
        if (highlighted) result += `${ESC}7m`
        continue
      }
    }
    const codePoint = line.codePointAt(index)
    if (codePoint === undefined) break
    const char = String.fromCodePoint(codePoint)
    index += char.length
    const charWidth = characterWidth(char)
    const selected = endColumn >= column && startColumn <= column + charWidth - 1
    if (selected !== highlighted) {
      result += selected ? `${ESC}7m` : `${ESC}27m`
      highlighted = selected
    }
    result += char
    column += charWidth
  }
  return highlighted ? `${result}${ESC}27m` : result
}

function sliceCells(text: string, startColumn: number, endColumn: number): string {
  let result = ''
  let column = 1
  for (const char of text) {
    const charWidth = characterWidth(char)
    if (endColumn >= column && startColumn <= column + charWidth - 1) result += char
    column += charWidth
  }
  return result
}

function slashMenuLines(
  suggestions: readonly SlashSuggestion[],
  selected: number,
  loading: boolean,
  width: number,
): string[] {
  if (suggestions.length === 0) return loading ? [`${DIM}${messages.loadingCommands}${RESET}`] : []
  const max = SLASH_MENU_ROWS
  const start = Math.min(Math.max(0, selected - Math.floor(max / 2)), Math.max(0, suggestions.length - max))
  return suggestions.slice(start, start + max).map((suggestion, offset) => {
    const index = start + offset
    const marker = index === selected ? `${CYAN}❯${RESET}` : ' '
    const source = suggestion.source === 'skill' ? ` ${DIM}[skill]${RESET}` : ''
    const description = suggestion.description === '' ? '' : ` ${DIM}${suggestion.description}${RESET}`
    return `${marker} ${fitAnsi(`/${suggestion.name}${description}${source}`, Math.max(1, width - 2))}`
  })
}

function transcriptLines(
  items: readonly TranscriptItem[],
  expandedTools: boolean,
  width: number,
): { readonly lines: string[]; readonly owners: RowOwner[] } {
  const lines: string[] = []
  const owners: RowOwner[] = []
  // Every row an item emits, its trailing spacer included, belongs to that item.
  const claim = (key: string): void => {
    const start = owners.length
    for (let row = start; row < lines.length; row += 1) owners.push({ key, offset: row - start })
  }
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item === undefined) continue
    if (item.kind === 'tool') {
      const group: TranscriptItem[] = [item]
      while (items[index + 1]?.kind === 'tool') {
        index += 1
        const next = items[index]
        if (next !== undefined) group.push(next)
      }
      lines.push(...toolGroupLines(group, expandedTools, width))
      lines.push('')
      claim(item.id)
      continue
    }
    const prefix = itemPrefix(item)
    if (item.kind === 'user') {
      const prefixWidth = displayWidth(USER_PROMPT_PREFIX)
      const contentWidth = Math.max(8, width - prefixWidth - 1)
      const wrapped = wrapText(item.text, contentWidth)
      if (wrapped.length === 0) wrapped.push('')
      for (const [lineIndex, line] of wrapped.entries()) {
        const marker = lineIndex === 0 ? `${CYAN}›${USER_BLOCK_STYLE} ` : ' '.repeat(prefixWidth)
        lines.push(`${USER_BLOCK_STYLE}${padAnsi(`${marker}${line}`, width)}${RESET}`)
      }
      lines.push('', '')
      claim(item.id)
      continue
    }
    if (item.kind === 'assistant') {
      lines.push(...renderMarkdownLines(item.text, width))
      lines.push('')
      claim(item.id)
      continue
    }
    const contentWidth = Math.max(8, width - displayWidth(prefix))
    const wrapped = wrapText(item.text, contentWidth)
    if (wrapped.length === 0) wrapped.push('')
    lines.push(`${prefix}${wrapped[0] ?? ''}`)
    for (const line of wrapped.slice(1)) lines.push(`${' '.repeat(displayWidth(prefix))}${line}`)
    lines.push('')
    claim(item.id)
  }
  if (lines.length === 0) return { lines: [`${DIM}${messages.emptyTranscript}${RESET}`], owners: [{ key: '', offset: 0 }] }
  return { lines, owners }
}

/**
 * The top row a position shows.
 * @param position - where the view sits.
 * @param owners - the item and in-item row behind each transcript row.
 * @param maxTop - the top row that shows the newest rows.
 * @returns a row index in `[0, maxTop]`.
 */
function resolveTop(position: TranscriptPosition, owners: readonly RowOwner[], maxTop: number): number {
  if (position.kind === 'latest') return maxTop
  const start = owners.findIndex(owner => owner.key === position.key)
  if (start < 0) return Math.min(maxTop, Math.max(0, position.index))
  let span = 0
  while (owners[start + span]?.key === position.key) span += 1
  // A rewrapped item keeps the same share of itself above the top row.
  const offset = span === position.span || position.span <= 0
    ? position.offset
    : Math.round(position.offset * span / position.span)
  return Math.min(maxTop, Math.max(0, start + Math.min(span - 1, offset)))
}

/**
 * A reading position whose top row is `top`.
 * @param owners - the item and in-item row behind each transcript row.
 * @param top - the row to pin to the top of the view.
 * @returns the anchor for that row.
 */
function anchorAt(owners: readonly RowOwner[], top: number): TranscriptPosition {
  const owner = owners[top] ?? { key: '', offset: 0 }
  let span = owner.offset + 1
  while (owners[top - owner.offset + span]?.key === owner.key) span += 1
  return { kind: 'reading', key: owner.key, offset: owner.offset, span, index: top }
}

interface InlineStyle {
  readonly bold?: boolean
  readonly italic?: boolean
  readonly underline?: boolean
  readonly strike?: boolean
  readonly code?: boolean
  readonly link?: boolean
  readonly heading?: boolean
}

interface StyledChar {
  readonly char: string
  readonly style: string
  readonly link?: string
}

/**
 * Render assistant Markdown into terminal-styled lines.
 * @param markdown - assistant Markdown source.
 * @param width - available terminal cells.
 * @returns styled lines without Markdown syntax markers.
 */
export function renderMarkdownLines(markdown: string, width: number): string[] {
  if (markdown.trim() === '') return ['']
  try {
    const tokens = marked.lexer(markdown, { gfm: true })
    const lines = renderMarkdownBlocks(tokens, Math.max(1, width))
    return noControls(lines.length === 0 ? [''] : lines)
  } catch (_invalidMarkdown) {
    // Streaming can expose incomplete syntax; preserve its visible text until the next delta.
    return noControls(wrapText(markdown, Math.max(1, width)))
  }
}

/**
 * Blank every C0 control character that survived block rendering.
 *
 * Markdown blocks build their rows from styled characters and never run the text through
 * `sanitize`, so a `\r`, a backspace, or a bell inside model output would reach the
 * terminal and move the cursor: `\r` returns to column 1 so later text overwrites, and a
 * raw line break adds a row the frame did not budget, which shifts the composer.
 * @param lines - rendered markdown rows.
 * @returns the same rows with control characters replaced by spaces.
 */
function noControls(lines: readonly string[]): string[] {
  // ESC stays: block rendering has already emitted the styles and OSC 8 targets this row
  // carries, and only the controls that move the cursor are a problem here.
  return lines.map(line => line.replaceAll(/[\u0000-\u001a\u001c-\u001f\u007f]/gu, ' '))
}

function renderMarkdownBlocks(tokens: readonly Token[], width: number): string[] {
  const lines: string[] = []
  for (const token of tokens) {
    const block = renderMarkdownBlock(token, width)
    if (block.length === 0) continue
    if (lines.length > 0 && lines.at(-1) !== '') lines.push('')
    lines.push(...block)
  }
  return lines
}

function renderMarkdownBlock(token: Token, width: number): string[] {
  switch (token.type) {
    case 'heading': {
      const heading = token as Tokens.Heading
      return renderInline(heading.tokens, width, {
        bold: true,
        heading: heading.depth <= 2,
      })
    }
    case 'paragraph':
      return renderInline((token as Tokens.Paragraph).tokens, width)
    case 'text':
      return renderInline((token as Tokens.Text).tokens ?? [token], width)
    case 'code':
      return codeBlockLines(token as Tokens.Code, width)
    case 'list':
      return listLines(token as Tokens.List, width)
    case 'blockquote': {
      const inner = renderMarkdownBlocks((token as Tokens.Blockquote).tokens, Math.max(1, width - 2))
      return inner.map(line => `${DIM}│${RESET} ${line}`)
    }
    case 'table':
      return tableLines(token as Tokens.Table, width)
    case 'hr':
      return [`${DIM}${'─'.repeat(Math.min(width, 48))}${RESET}`]
    case 'space':
    case 'def':
      return []
    case 'html':
      return wrapText((token as Tokens.HTML).text, width)
    default: {
      const children = tokenChildren(token)
      if (children !== undefined) return renderMarkdownBlocks(children, width)
      return wrapText(sanitize(token.raw), width)
    }
  }
}

function renderInline(
  tokens: readonly Token[],
  width: number,
  style: InlineStyle = {},
): string[] {
  return wrapStyled(inlineChars(tokens, style), Math.max(1, width))
}

function inlineChars(tokens: readonly Token[], style: InlineStyle): StyledChar[] {
  const chars: StyledChar[] = []
  for (const token of tokens) {
    switch (token.type) {
      case 'text': {
        const text = token as Tokens.Text
        if (text.tokens === undefined || text.tokens.length === 0) appendStyledText(chars, text.text, style)
        else chars.push(...inlineChars(text.tokens, style))
        break
      }
      case 'escape':
        appendStyledText(chars, (token as Tokens.Escape).text, style)
        break
      case 'strong':
        chars.push(...inlineChars((token as Tokens.Strong).tokens, { ...style, bold: true }))
        break
      case 'em':
        chars.push(...inlineChars((token as Tokens.Em).tokens, { ...style, italic: true }))
        break
      case 'del':
        chars.push(...inlineChars((token as Tokens.Del).tokens, { ...style, strike: true }))
        break
      case 'codespan':
        appendStyledText(chars, (token as Tokens.Codespan).text, { ...style, code: true })
        break
      case 'link': {
        const link = token as Tokens.Link
        const label = link.tokens.length === 0 ? link.href : link.text
        appendStyledText(chars, label, { ...style, link: true }, terminalLink(link.href))
        break
      }
      case 'image': {
        const image = token as Tokens.Image
        appendStyledText(
          chars,
          `[image: ${image.text || image.href}]`,
          { ...style, link: true },
          terminalLink(image.href),
        )
        break
      }
      case 'br':
        appendStyledText(chars, '\n', style)
        break
      case 'checkbox':
        appendStyledText(chars, (token as Tokens.Checkbox).checked ? '[x] ' : '[ ] ', style)
        break
      case 'html':
        appendStyledText(chars, (token as Tokens.HTML).text, style)
        break
      default:
        {
          const children = tokenChildren(token)
          if (children !== undefined) chars.push(...inlineChars(children, style))
          else appendStyledText(chars, sanitize(token.raw), style)
        }
        break
    }
  }
  return chars
}

function appendStyledText(
  target: StyledChar[],
  text: string,
  style: InlineStyle,
  link?: string,
): void {
  const sequence = inlineStyleSequence(style)
  for (const char of Array.from(text)) {
    target.push(link === undefined ? { char, style: sequence } : { char, style: sequence, link })
  }
}

/**
 * Resolve a Markdown target to a terminal hyperlink URL.
 * @param href - link destination from the assistant's Markdown.
 * @returns an absolute http, https, or mailto URL, or undefined when it must stay plain text.
 */
function terminalLink(href: string): string | undefined {
  try {
    const url = new URL(href)
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') {
      return undefined
    }
    return url.href
  } catch (_invalidUrl) {
    return undefined
  }
}

function inlineStyleSequence(style: InlineStyle): string {
  const codes: string[] = []
  if (style.bold || style.heading) codes.push('1')
  if (style.italic) codes.push('3')
  if (style.underline || style.link) codes.push('4')
  if (style.strike) codes.push('9')
  if (style.heading) codes.push('36')
  else if (style.link) codes.push('34')
  else if (style.code) codes.push('36')
  return codes.length === 0 ? '' : `${ESC}${codes.join(';')}m`
}

function wrapStyled(chars: readonly StyledChar[], width: number): string[] {
  const lines: StyledChar[][] = []
  let line: StyledChar[] = []
  let cells = 0
  const flush = (): void => {
    lines.push(line)
    line = []
    cells = 0
  }
  for (const char of chars) {
    if (char.char === '\n') {
      flush()
      continue
    }
    const charWidth = characterWidth(char.char)
    if (cells + charWidth > width && line.length > 0) flush()
    line.push(char)
    cells += charWidth
  }
  if (line.length > 0 || lines.length === 0) flush()
  return lines.map(formatStyledLine)
}

function formatStyledLine(chars: readonly StyledChar[]): string {
  let result = ''
  let currentStyle = ''
  let currentLink = ''
  for (const char of chars) {
    const link = char.link ?? ''
    if (link !== currentLink) {
      if (currentLink !== '') result += `${OSC}8;;${ST}`
      if (link !== '') result += `${OSC}8;;${link}${ST}`
      currentLink = link
    }
    if (char.style !== currentStyle) {
      if (currentStyle !== '') result += RESET
      if (char.style !== '') result += char.style
      currentStyle = char.style
    }
    result += char.char
  }
  if (currentLink !== '') result += `${OSC}8;;${ST}`
  return currentStyle === '' ? result : `${result}${RESET}`
}

function codeBlockLines(code: Tokens.Code, width: number): string[] {
  const language = code.lang?.trim().split(/\s+/u, 1)[0] ?? ''
  const lines = language === '' ? [] : [`${DIM}${language}${RESET}`]
  for (const line of code.text.split('\n')) lines.push(...wrapText(`  ${line}`, width))
  return lines
}

function listLines(list: Tokens.List, width: number): string[] {
  const lines: string[] = []
  const start = typeof list.start === 'number' ? list.start : 1
  for (const [index, item] of list.items.entries()) {
    const marker = item.task
      ? item.checked === true ? '☑ ' : '☐ '
      : list.ordered ? `${String(start + index)}. ` : '• '
    const markerWidth = displayWidth(marker)
    const innerWidth = Math.max(1, width - markerWidth)
    const block = renderMarkdownBlocks(item.tokens, innerWidth)
    if (block.length === 0) block.push('')
    lines.push(`${DIM}${marker}${RESET}${block[0] ?? ''}`)
    for (const line of block.slice(1)) lines.push(`${' '.repeat(markerWidth)}${line}`)
    if (list.loose && index < list.items.length - 1) lines.push('')
  }
  return lines
}

function tableLines(table: Tokens.Table, width: number): string[] {
  const columns = table.header.length
  if (columns === 0) return []
  const separatorWidth = 3
  const minimumTotal = columns * 3 + (columns - 1) * separatorWidth
  if (minimumTotal > width) return tableFallbackLines(table, width)
  const natural = table.header.map((cell, column) => Math.max(
    3,
    displayWidth(plainInline(cell.tokens)),
    ...table.rows.map(row => displayWidth(plainInline(row[column]?.tokens ?? []))),
  ))
  const limits = [...natural]
  while (limits.reduce((sum, value) => sum + value, 0) + (columns - 1) * separatorWidth > width) {
    let widest = 0
    for (let index = 1; index < limits.length; index += 1) {
      if ((limits[index] ?? 0) > (limits[widest] ?? 0)) widest = index
    }
    const current = limits[widest] ?? 3
    if (current <= 3) break
    limits[widest] = current - 1
  }
  const separator = limits.map(value => '─'.repeat(value)).join(`${DIM}─┼─${RESET}`)
  const lines = [
    tableRow(table.header, limits, table.align, true),
    separator,
    ...table.rows.map(row => tableRow(row, limits, table.align, false)),
  ]
  return lines
}

function tableRow(
  cells: readonly Tokens.TableCell[],
  widths: readonly number[],
  aligns: readonly ('center' | 'left' | 'right' | null)[],
  header: boolean,
): string {
  const values = widths.map((width, index) => {
    const cell = cells[index]
    const chars = padCell(fitChars(inlineChars(cell?.tokens ?? [], {}), width), width, cell?.align ?? aligns[index] ?? 'left')
    if (!header) return formatStyledLine(chars)
    return `${BOLD}${formatStyledLine(chars)}${RESET}`
  })
  return values.join(` ${DIM}│${RESET} `)
}

/**
 * Truncate one cell's styled characters to its column width, keeping each character's
 * terminal link. A cell that overflows ends in an ellipsis, so a linked value cannot be
 * silently shortened without a visible marker.
 * @param chars - the cell's inline characters with their styles and links.
 * @param width - the column width in terminal cells.
 * @returns characters whose displayed width is at most `width`.
 */
function fitChars(chars: readonly StyledChar[], width: number): StyledChar[] {
  if (chars.reduce((sum, char) => sum + characterWidth(char.char), 0) <= width) return [...chars]
  const kept: StyledChar[] = []
  let cells = 0
  for (const char of chars) {
    const charWidth = characterWidth(char.char)
    if (cells + charWidth > width - 1) break
    kept.push(char)
    cells += charWidth
  }
  kept.push({ char: '…', style: '' })
  return kept
}

/**
 * Pad a cell's characters to its column width on the requested side.
 * @param chars - characters already fitted to the column.
 * @param width - the column width in terminal cells.
 * @param align - cell, column, or default left alignment.
 * @returns characters plus trailing spaces reaching exactly `width` cells.
 */
function padCell(chars: readonly StyledChar[], width: number, align: 'center' | 'left' | 'right'): StyledChar[] {
  const remaining = Math.max(0, width - chars.reduce((sum, char) => sum + characterWidth(char.char), 0))
  const left = align === 'right' ? remaining : align === 'center' ? Math.floor(remaining / 2) : 0
  const right = remaining - left
  return [
    ...Array.from({ length: left }, () => ({ char: ' ', style: '' })),
    ...chars,
    ...Array.from({ length: right }, () => ({ char: ' ', style: '' })),
  ]
}

function tableFallbackLines(table: Tokens.Table, width: number): string[] {
  return table.rows.map((row) => {
    const value = table.header.map((header, index) => {
      const cell = row[index]
      return `${plainInline(header.tokens)}: ${plainInline(cell?.tokens ?? [])}`
    }).join(' · ')
    return fit(value, width)
  })
}

function plainInline(tokens: readonly Token[]): string {
  let result = ''
  for (const token of tokens) {
    switch (token.type) {
      case 'text':
        result += (token as Tokens.Text).text
        break
      case 'escape':
        result += (token as Tokens.Escape).text
        break
      case 'strong':
        result += plainInline((token as Tokens.Strong).tokens)
        break
      case 'em':
        result += plainInline((token as Tokens.Em).tokens)
        break
      case 'del':
        result += plainInline((token as Tokens.Del).tokens)
        break
      case 'codespan':
        result += (token as Tokens.Codespan).text
        break
      case 'link':
        result += (token as Tokens.Link).text
        break
      case 'image': {
        const image = token as Tokens.Image
        result += `[image: ${image.text || image.href}]`
        break
      }
      case 'br':
        result += '\n'
        break
      case 'checkbox':
        result += (token as Tokens.Checkbox).checked ? '[x] ' : '[ ] '
        break
      case 'html':
        result += (token as Tokens.HTML).text
        break
      default:
        {
          const children = tokenChildren(token)
          if (children !== undefined) result += plainInline(children)
          else result += sanitize(token.raw)
        }
        break
    }
  }
  return result
}

function tokenChildren(token: Token): readonly Token[] | undefined {
  if (!('tokens' in token)) return undefined
  const children = token.tokens
  return Array.isArray(children) ? children : undefined
}

function toolGroupLines(items: readonly TranscriptItem[], expanded: boolean, width: number): string[] {
  const summaries = semanticToolSummaries(items)
  const lines = summaries.map((summary) => {
    const color = summary.status === 'error' ? RED : summary.status === 'running' ? YELLOW : ''
    const styled = color === '' ? summary.text : `${color}${summary.text}${RESET}`
    return `  ${fitAnsi(styled, Math.max(1, width - 2))}`
  })
  // Collapsed keeps one row per summary. Expanded replaces the summaries with the
  // per-call details, so the same work is never listed twice.
  if (!expanded) {
    lines.push(`  ${DIM}${fit(messages.showToolDetails, Math.max(1, width - 2))}${RESET}`)
    return lines
  }
  return items.flatMap(item => toolLines(item, true, width).map(line => `  ${line}`))
}

interface ToolSummary {
  readonly text: string
  readonly status: ToolStatus
}

function semanticToolSummaries(items: readonly TranscriptItem[]): ToolSummary[] {
  const blocks: Array<
    | { readonly kind: 'single'; readonly item: TranscriptItem; readonly name: string }
    | {
      readonly kind: 'group'
      readonly items: TranscriptItem[]
      readonly verb: string
      readonly noun: string
      readonly alwaysCount: boolean
      readonly subject: (item: TranscriptItem) => string
    }
  > = []
  const groups = new Map<string, {
    items: TranscriptItem[]
    verb: string
    noun: string
    alwaysCount: boolean
    subject: (item: TranscriptItem) => string
  }>()
  for (const item of items) {
    const name = item.title ?? messages.tool
    const group = name === 'read'
      ? { key: 'read', verb: 'Read', noun: 'files', alwaysCount: false, subject: readSubject }
      : name === 'bash'
        ? { key: 'bash', verb: 'Ran', noun: 'commands', alwaysCount: false, subject: commandSubject }
        : name === 'web_search'
          ? { key: 'web', verb: 'Searched web', noun: 'queries', alwaysCount: false, subject: searchSubject }
          : name === 'web_fetch'
            ? { key: 'web-fetch', verb: 'Fetched', noun: 'pages', alwaysCount: true, subject: fetchSubject }
            : undefined
    if (group !== undefined) {
      const existing = groups.get(group.key)
      if (existing === undefined) {
        const created = {
          items: [item], verb: group.verb, noun: group.noun,
          alwaysCount: group.alwaysCount, subject: group.subject,
        }
        groups.set(group.key, created)
        blocks.push({ kind: 'group', ...created })
      } else {
        existing.items.push(item)
      }
      continue
    }
    blocks.push({ kind: 'single', item, name })
  }
  return blocks.map(block => block.kind === 'single'
    ? singleToolSummary(block.item, block.name)
    : groupedToolSummary(block.items, block.verb, block.noun, block.alwaysCount, block.subject))
}

function groupedToolSummary(
  items: readonly TranscriptItem[],
  verb: string,
  noun: string,
  alwaysCount: boolean,
  subject: (item: TranscriptItem) => string,
): ToolSummary {
  const status = combinedStatus(items)
  if (items.length === 1 && !alwaysCount) {
    const [item] = items
    const value = item === undefined ? '' : subject(item)
    return { text: `${statusPrefix(verb, status)}${value === '' ? '' : ` ${value}`}`, status }
  }
  return { text: `${verb} ${String(items.length)} ${noun} · ${statusText(status)}`, status }
}

function singleToolSummary(item: TranscriptItem, name: string): ToolSummary {
  const status = item.toolStatus ?? (item.toolOutput === undefined ? 'running' : 'ok')
  const args = parsedToolArguments(item)
  if (name === 'skill') {
    const skill = stringField(args, 'name')
    return { text: `Loaded skill${skill === undefined ? '' : ` ${skill}`}`, status }
  }
  if (['write', 'edit', 'str_replace_editor', 'apply_patch'].includes(name)) {
    const path = stringField(args, 'file_path') ?? stringField(args, 'path') ?? item.text
    const added = countLines(stringField(args, 'content') ?? stringField(args, 'new_string'))
    const removed = countLines(stringField(args, 'old_string'))
    return { text: `Edited ${path} (+${String(added)} -${String(removed)})`, status }
  }
  const value = subjectFromArguments(args) || item.text
  return { text: `${name === messages.tool ? 'Tool' : capitalize(name)}${value === '' ? '' : ` ${value}`}`, status }
}

function readSubject(item: TranscriptItem): string {
  const args = parsedToolArguments(item)
  return stringField(args, 'file_path') ?? stringField(args, 'path') ?? item.text
}

function commandSubject(item: TranscriptItem): string {
  const args = parsedToolArguments(item)
  return stringField(args, 'command') ?? stringField(args, 'cmd') ?? item.text
}

function searchSubject(item: TranscriptItem): string {
  const args = parsedToolArguments(item)
  const queries = args?.queries
  if (Array.isArray(queries)) {
    const first = queries.find(value => typeof value === 'string')
    if (typeof first === 'string') return first
  }
  return stringField(args, 'query') ?? item.text
}

function fetchSubject(item: TranscriptItem): string {
  const args = parsedToolArguments(item)
  const url = stringField(args, 'url')
  if (url === undefined) return item.text
  try {
    return new URL(url).hostname
  } catch (_invalidFetchUrl) {
    // A malformed URL remains its literal text; fetch validation owns the failure.
    return url
  }
}

function subjectFromArguments(args: Readonly<Record<string, unknown>> | undefined): string {
  if (args === undefined) return ''
  for (const key of ['description', 'query', 'path', 'file_path', 'url']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return ''
}

function parsedToolArguments(item: TranscriptItem): Readonly<Record<string, unknown>> | undefined {
  if (item.toolArguments === undefined) return undefined
  try {
    const value: unknown = JSON.parse(item.toolArguments)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Readonly<Record<string, unknown>>
      : undefined
  } catch (_invalidToolArguments) {
    // Invalid JSON stays opaque; the tool's own summary remains the safe fallback.
    return undefined
  }
}

function stringField(args: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined {
  const value = args?.[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function countLines(value: string | undefined): number {
  if (value === undefined) return 0
  return value === '' ? 0 : value.split(/\r?\n/u).length
}

function combinedStatus(items: readonly TranscriptItem[]): ToolStatus {
  if (items.some(item => item.toolStatus === 'error')) return 'error'
  if (items.some(item => (item.toolStatus ?? 'ok') === 'running')) return 'running'
  return 'ok'
}

function statusPrefix(verb: string, status: ToolStatus): string {
  return status === 'ok' ? verb : `${verb} · ${statusText(status)}`
}

function statusText(status: ToolStatus): string {
  return status === 'running' ? 'running' : status === 'error' ? 'failed' : 'ok'
}

function capitalize(value: string): string {
  return value === '' ? value : `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`
}

function toolLines(item: TranscriptItem, expanded: boolean, width: number): string[] {
  const status = item.toolStatus ?? (item.toolOutput === undefined ? 'running' : 'ok')
  const statusText = status === 'running'
    ? messages.toolRunning
    : status === 'error' ? messages.toolFailed : messages.toolCompleted
  const statusColor = status === 'running' ? YELLOW : status === 'error' ? RED : GREEN
  const prefix = `${YELLOW}${messages.tool}:${item.title ?? messages.tool}${RESET} ${statusColor}[${statusText}]${RESET} `
  const contentWidth = Math.max(8, width - displayWidth(prefix))
  const summary = wrapText(item.text, contentWidth)
  const lines = [`${prefix}${summary[0] ?? ''}`]
  const indent = ' '.repeat(displayWidth(prefix))
  for (const line of summary.slice(1)) lines.push(`${indent}${line}`)
  if (expanded) {
    if (item.toolArguments !== undefined && item.toolArguments.trim() !== '') {
      lines.push(...labeledBlock(messages.toolArguments, item.toolArguments, width))
    }
    if (item.toolOutput !== undefined) {
      lines.push(...labeledBlock(messages.toolOutput, item.toolOutput, width))
    }
  } else if (item.detail !== undefined) {
    lines.push(`${indent}${DIM}${messages.expandTools}${RESET}`)
  }
  return lines
}

function labeledBlock(label: string, value: string, width: number): string[] {
  const prefix = `  ${DIM}${label}:${RESET} `
  const contentWidth = Math.max(8, width - displayWidth(prefix))
  const wrapped = wrapText(value, contentWidth)
  return [
    `${prefix}${wrapped[0] ?? ''}`,
    ...wrapped.slice(1).map(line => `${' '.repeat(displayWidth(prefix))}${line}`),
  ]
}

function itemPrefix(item: TranscriptItem): string {
  switch (item.kind) {
    case 'user':
      return ''
    case 'assistant':
      return ''
    case 'reasoning':
      return `${DIM}${messages.thinking}${RESET} `
    case 'tool':
      return `${YELLOW}${messages.tool}:${item.title ?? messages.tool}${RESET} `
    case 'error':
      return `${RED}${messages.error}${RESET} `
    case 'system':
      return `${DIM}${messages.system}${RESET} `
  }
}

function queueDockLines(
  queue: TranscriptState['queue'],
  submission: PendingSubmission | undefined,
  width: number,
  limit: number,
): string[] {
  if (limit <= 0) return []
  const lines: string[] = []
  if (submission !== undefined) {
    const images = submission.imageCount === 0 ? '' : ` [${String(submission.imageCount)} image]`
    lines.push(`${YELLOW}${fit(`sending ${submission.mode}: ${submission.text}${images}`, width)}${RESET}`)
  }
  const budget = Math.max(0, 3 - lines.length)
  for (const item of queue.slice(0, budget)) {
    const kind = item.placement === 'steering' ? 'steer' : 'queued'
    // The hint rides on the message itself so it stays visible however many are pending.
    lines.push(`${DIM}${fit(`${kind}: ${item.text || '[attachment]'}`, width)}${RESET}`)
    // Only actions that apply to a queued row: a draft-level shortcut (Alt+Enter) belongs in
    // `/help`, where its condition is stated, not beside rows it cannot touch.
    lines.push(`${DIM}${fit('   Alt+Up recall · /queue manage', width)}${RESET}`)
  }
  if (queue.length > budget) {
    lines.push(`${DIM}${fit(`${String(queue.length - budget)} more pending · /queue manage`, width)}${RESET}`)
  }
  return lines.slice(0, limit)
}

/**
 * Share of prompt-side input served from the provider cache.
 *
 * Cache reads are billed at a fraction of uncached input, so this reading is the one number
 * in the status line that implies an action: a sustained drop means the prompt prefix is
 * changing, which raises cost. The denominator matches the Web composer's figure — every
 * prompt-side bucket, not just the uncached one.
 * @param tokens - session token counters, or undefined before the first response.
 * @returns an integer percentage, or undefined when nothing has been billed yet.
 */
export function cacheHitPercent(tokens: TranscriptState['tokens']): number | undefined {
  if (tokens === undefined) return undefined
  const billed = tokens.input + tokens.cacheRead + tokens.cacheWrite
  if (billed <= 0) return undefined
  return Math.min(100, Math.round((tokens.cacheRead / billed) * 100))
}

function statusLine(
  state: TranscriptState,
  width: number,
  notice: string | undefined,
  reading: boolean,
): string {
  const cwd = shortenHome(state.cwd)
  const model = state.model === undefined
    ? messages.defaultModel
    : `${state.model.model}${state.model.reasoningEffort === undefined ? '' : `:${state.model.reasoningEffort}`}`
  const context = contextPercent(state)
  // Token totals, the permission mode, and the idle flag live in `/status`: they change
  // slowly, and keeping them here crowded out the two readings that move during work.
  const cache = cacheHitPercent(state.tokens)
  const cacheReading = cache === undefined ? '' : ` | cache ${String(cache)}%`
  const activeTool = state.items.findLast(item => item.kind === 'tool' && item.toolStatus === 'running')
  const activity = activeTool === undefined ? '' : ` | ${activeTool.title ?? messages.tool} running`
  const bottom = reading ? ' | ↓ bottom · Esc' : ''
  // The run state is one paired reading: showing only the running half made an idle
  // terminal look like a frame that had failed to paint its tail.
  const runState = ` | ${state.running ? messages.running : messages.idle}`
  const base = `${cwd} | ${model}${context}${cacheReading}${activity}${runState}${bottom}`
  if (bottom !== '' && (notice === undefined || notice === '')) {
    const tail = `${activity}${bottom}`
    const head = `${cwd} | ${model}${context}${cacheReading}`
    return `${DIM}${fit(head, Math.max(1, width - displayWidth(tail)))}${tail}${RESET}`
  }
  if (notice === undefined || notice === '') return `${DIM}${fit(base, width)}${RESET}`
  const noticeWidth = displayWidth(notice)
  if (noticeWidth >= width) return `${YELLOW}${fit(notice, width)}${RESET}`
  const statusWidth = Math.max(1, width - noticeWidth - 2)
  return `${DIM}${fit(base, statusWidth)}${RESET}  ${YELLOW}${fit(notice, noticeWidth)}${RESET}`
}

function contextPercent(state: TranscriptState): string {
  const context = state.context
  if (context?.contextWindow === undefined) return ''
  const used = context.projectedTokens ?? context.pressureTokens
  if (used === undefined) return ''
  const percent = Math.min(100, Math.round(used / context.contextWindow * 100))
  return ` | ctx ${String(percent)}%`
}

function composerLines(
  input: string,
  cursor: number,
  images: readonly ClipboardImage[],
  width: number,
  maxInnerRows: number,
): {
  readonly lines: string[]
  readonly cursorLine: number
  readonly cursorColumn: number
} {
  const contentWidth = Math.max(1, width - 5)
  const allTextRows = wrapText(input, contentWidth)
  const cursorPosition = wrappedCursor(input, cursor, contentWidth)
  const chipText = images.map((image, index) => messages.imageChip(index + 1, image.name)).join('  ')
  const allChipRows = chipText === ''
    ? []
    : wrapText(chipText, contentWidth).map(line => `${DIM}${line}${RESET}`)
  const visibleChipRows = allChipRows.slice(0, Math.max(0, maxInnerRows - 1))
  const textBudget = Math.max(1, maxInnerRows - visibleChipRows.length)
  const start = Math.max(
    0,
    Math.min(
      Math.max(0, allTextRows.length - textBudget),
      cursorPosition.line - textBudget + 1,
    ),
  )
  const visibleTextRows = allTextRows.slice(start, start + textBudget)
  const innerRows: string[] = [
    ...visibleChipRows.map(line => boxContent(' ', line, width)),
    ...visibleTextRows.map((line, index) => {
      const lineIndex = start + index
      return boxContent(lineIndex === 0 ? `${CYAN}❯${RESET}` : ' ', line, width)
    }),
  ]
  while (innerRows.length < 1) innerRows.push(boxContent(' ', '', width))
  const cursorInnerLine = visibleChipRows.length + cursorPosition.line - start
  const lines = [
    borderedLabel('╭', '╮', '', width),
    ...innerRows,
    borderedLabel('╰', '╯', '', width),
  ]
  return {
    lines,
    cursorLine: 1 + cursorInnerLine,
    cursorColumn: cursorPosition.column,
  }
}

function overlayLines(overlay: Overlay, width: number, height: number): string[] {
  switch (overlay.kind) {
    case 'sessions':
      return sessionOverlayLines(overlay, width, height)
    case 'models':
      return modelOverlayLines(overlay, width, height)
    case 'queue':
      return queueOverlayLines(overlay, width, height)
    case 'approval':
      return [
        `${YELLOW}${BOLD}${messages.approvals}${RESET}`,
        '',
        `${BOLD}${messages.tool}${RESET} ${overlay.request.toolName}`,
        ...wrapText(overlay.request.reason ?? '', Math.max(8, width - 2)).map(line => `${DIM}${line}${RESET}`),
        '',
        `${GREEN}Enter${RESET} ${messages.allowOnce}`,
        `${RED}Esc${RESET} ${messages.reject}`,
      ]
    case 'question':
      return questionLines(overlay, width)
  }
}

function queueOverlayLines(
  overlay: Extract<Overlay, { kind: 'queue' }>,
  width: number,
  height: number,
): string[] {
  const window = pickerWindow(overlay.items.length, overlay.index, Math.max(1, height - 5))
  return [
    `${BOLD}${messages.queuePicker}${RESET}`,
    '',
    ...overlay.items.slice(window.start, window.end).map((item, offset) => {
      const index = window.start + offset
      const marker = index === overlay.index ? `${CYAN}>${RESET}` : ' '
      const type = item.placement === 'steering' ? messages.queueSteering : messages.queueQueued
      const attachment = item.imageCount + item.fileCount === 0
        ? ''
        : ` [${String(item.imageCount + item.fileCount)} attachment]`
      return `${marker} ${fit(`${type}: ${item.text || '[attachment]'}${attachment}`, width - 2)}`
    }),
    '',
    `${DIM}${messages.chooseQueue}${RESET}`,
  ]
}

function sessionOverlayLines(
  overlay: Extract<Overlay, { kind: 'sessions' }>,
  width: number,
  height: number,
): string[] {
  const window = pickerWindow(overlay.items.length, overlay.index, Math.max(1, height - 5))
  return [
    `${BOLD}${messages.sessionPicker}${RESET}`,
    '',
    ...overlay.items.slice(window.start, window.end).map((item, offset) => {
      const index = window.start + offset
      const marker = index === overlay.index ? `${CYAN}>${RESET}` : ' '
      const title = sessionTitle(item)
      const cwd = item.cwd === undefined ? '' : ` ${DIM}${item.cwd}${RESET}`
      return `${marker} ${fit(`${title}${cwd}`, width - 2)}`
    }),
    '',
    `${DIM}${messages.chooseSession}${RESET}`,
  ]
}

function modelOverlayLines(
  overlay: Extract<Overlay, { kind: 'models' }>,
  width: number,
  height: number,
): string[] {
  if (overlay.stage === 'effort' && overlay.chosen !== undefined) {
    return effortOverlayLines(overlay, overlay.chosen, width, height)
  }
  const window = pickerWindow(overlay.items.length, overlay.index, Math.max(1, height - 5))
  return [
    `${BOLD}${messages.modelPicker}${RESET}`,
    '',
    ...overlay.items.slice(window.start, window.end).map((item, offset) => {
      const index = window.start + offset
      const marker = index === overlay.index ? `${CYAN}>${RESET}` : ' '
      const depth = item.efforts.length === 0 ? '' : ` ${DIM}·${RESET}${DIM}${String(item.efforts.length)} depths${RESET}`
      return `${marker} ${fitAnsi(`${item.providerName} / ${item.modelName}${depth}`, width - 2)}`
    }),
    '',
    `${DIM}${messages.chooseModel}${RESET}`,
  ]
}

/**
 * Reasoning-depth stage of the model picker: the route being configured, then its depths.
 * @param overlay - open picker in the effort stage.
 * @param chosen - the route whose depths are listed.
 * @param width - available columns.
 * @param height - available rows.
 * @returns overlay rows, top to bottom.
 */
function effortOverlayLines(
  overlay: Extract<Overlay, { kind: 'models' }>,
  chosen: ModelChoice,
  width: number,
  height: number,
): string[] {
  const window = pickerWindow(chosen.efforts.length, overlay.effortIndex, Math.max(1, height - 7))
  const rows = chosen.efforts.slice(window.start, window.end).flatMap((effort, offset) => {
    const index = window.start + offset
    const marker = index === overlay.effortIndex ? `${CYAN}>${RESET}` : ' '
    const isDefault = effort.id === chosen.defaultEffort ? ` ${DIM}(default)${RESET}` : ''
    const label = `${marker} ${fitAnsi(`${effort.name}${isDefault}`, width - 2)}`
    if (index !== overlay.effortIndex || effort.description === undefined) return [label]
    return [label, `  ${DIM}${fitAnsi(effort.description, width - 4)}${RESET}`]
  })
  return [
    `${BOLD}${messages.modelPicker}${RESET} ${DIM}${fitAnsi(`${chosen.providerName} / ${chosen.modelName}`, width - 16)}${RESET}`,
    '',
    `${BOLD}${messages.reasoningDepth}${RESET}`,
    ...rows,
    '',
    `${DIM}${messages.chooseEffort}${RESET}`,
  ]
}

function pickerWindow(length: number, selected: number, height: number): { start: number; end: number } {
  const start = Math.min(Math.max(0, selected - Math.floor(height / 2)), Math.max(0, length - height))
  return { start, end: Math.min(length, start + height) }
}

function questionLines(prompt: QuestionPrompt, width: number): string[] {
  const progress = prompt.progress[prompt.questionIndex]
  if (progress === undefined) return [messages.noMatches]
  const question = progress.question
  const lines = [
    `${BOLD}${messages.question} ${String(prompt.questionIndex + 1)}/${String(prompt.progress.length)}${RESET}`,
    '',
    ...(question.header === undefined ? [] : [`${DIM}${question.header}${RESET}`]),
    ...wrapText(question.question, Math.max(8, width - 2)),
    ...(question.detail === undefined ? [] : wrapText(question.detail, Math.max(8, width - 2)).map(line => `${DIM}${line}${RESET}`)),
    '',
  ]
  const options = question.options ?? []
  if (progress.mode === 'custom') {
    lines.push(`${CYAN}>${RESET} ${progress.custom}`)
    lines.push('', `${DIM}${messages.questionCustom}${RESET}`)
    return lines
  }
  for (const [index, option] of options.entries()) {
    const marker = index === progress.index ? `${CYAN}>${RESET}` : ' '
    const checked = progress.selected.has(option.label) ? '[x]' : '[ ]'
    const selected = question.multiSelect === true ? `${checked} ` : ''
    lines.push(`${marker} ${fit(`${selected}${option.label}${option.description === undefined ? '' : ` ${DIM}${option.description}${RESET}`}`, width - 2)}`)
  }
  lines.push('', `${DIM}${messages.questionOptions}${RESET}`)
  return lines
}

function sessionTitle(item: { readonly projections?: { readonly values: unknown } }): string {
  const values = item.projections?.values
  if (isRecord(values)) {
    const title = values.title
    if (typeof title === 'string' && title.trim() !== '') return title
  }
  return messages.unnamedSession
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Wrap plain text to a terminal-cell width. */
export function wrapText(text: string, width: number): string[] {
  // Split before sanitizing: sanitize blanks every control character, including the line
  // breaks that define the paragraphs here. A lone `\r` is a line break too, because tool
  // output uses it to separate progress updates.
  const clean = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  if (clean === '') return ['']
  const lines: string[] = []
  for (const paragraph of clean.split('\n')) {
    if (paragraph === '') {
      lines.push('')
      continue
    }
    let current = ''
    let cells = 0
    for (const char of Array.from(sanitize(paragraph))) {
      const charWidth = characterWidth(char)
      // A double-width glyph cannot straddle the final column, so the terminal folds it and
      // the row consumes two rows. Break before it here for the same reason the terminal
      // would, keeping this row count equal to the one the screen shows.
      const foldsAtEdge = charWidth === 2 && cells === width - 1
      if ((cells + charWidth > width || foldsAtEdge) && current !== '') {
        lines.push(current)
        current = ''
        cells = 0
      }
      current += char
      cells += charWidth
    }
    lines.push(current)
  }
  return lines
}

const ANSI_SEQUENCE_GLOBAL = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\](?:[^\u0007\u001b]|\u001b(?!\\))*(?:\u0007|\u001b\\)/gu
/**
 * Remove every control sequence from untrusted text before it is measured or painted.
 *
 * Model-authored text reaches the header, the composer, and the status line. Both CSI
 * and OSC must go: an OSC 8 hyperlink left behind would render its parameters
 * (`]8;;https://...`) as visible cells and skew every width calculation that follows,
 * which paints rows over the composer.
 * @param text - text from a model, a host, or a shell result.
 * @returns the text with escape sequences and other control characters removed.
 */
function sanitize(text: string): string {
  return text
    .replaceAll(ANSI_SEQUENCE_GLOBAL, '')
    .replaceAll(/[\u0000-\u001f\u007f]/gu, ' ')
}

function boxContent(marker: string, content: string, width: number): string {
  const contentWidth = Math.max(0, width - 5)
  const fitted = padAnsi(content, contentWidth)
  return `${DIM}│${RESET} ${marker} ${fitted}${DIM}│${RESET}`
}

function borderedLabel(left: string, right: string, label: string, width: number): string {
  const innerWidth = Math.max(0, width - 2)
  const labelText = label === '' ? '' : `─ ${label} `
  const fitted = fit(labelText, innerWidth)
  const line = '─'.repeat(Math.max(0, innerWidth - displayWidth(fitted)))
  return `${DIM}${left}${BOLD}${fitted}${RESET}${DIM}${line}${right}${RESET}`
}

function padAnsi(text: string, width: number): string {
  const visible = stripAnsi(text)
  const cells = displayWidth(visible)
  if (cells > width) return fitAnsi(text, width)
  return `${text}${' '.repeat(width - cells)}`
}

function wrappedCursor(input: string, cursor: number, width: number): { line: number; column: number } {
  const chars = Array.from(input)
  const before = chars.slice(0, Math.max(0, Math.min(chars.length, cursor))).join('')
  const rows = wrapText(before, width)
  return {
    line: Math.max(0, rows.length - 1),
    column: displayWidth(rows[rows.length - 1] ?? ''),
  }
}

function shortenHome(path: string): string {
  const home = homedir()
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

function fit(text: string, width: number): string {
  const clean = sanitize(text)
  if (fitsOneRow(clean, width)) return clean
  let result = ''
  let cells = 0
  // The ellipsis and the wrapped glyph both need room, so the text stops before a wide glyph
  // that would otherwise land on the last column and make the terminal fold this row.
  const limit = width - 1
  for (const char of Array.from(clean)) {
    const charWidth = characterWidth(char)
    if (cells + charWidth > limit) break
    if (charWidth === 2 && cells + charWidth === width - 1) break
    result += char
    cells += charWidth
  }
  return `${result}…`
}

/**
 * Truncate ANSI-styled text to a terminal width without cutting an OSC 8 hyperlink open,
 * which would leave every following cell pointing at a stale target.
 * @param text - styled text, possibly carrying terminal hyperlinks.
 * @param width - available terminal cells.
 * @returns the original text when it fits, else truncated text with every link closed.
 */
function fitAnsi(text: string, width: number): string {
  if (fitsOneRow(text, width)) return text
  return `${fit(stripAnsi(text), width)}${OSC}8;;${ST}${RESET}`
}

/**
 * Whether the terminal will draw this text on a single row.
 *
 * A double-width glyph cannot straddle the last column: when one starts with only one cell
 * left, the terminal wraps it first and the row occupies two. Measuring the cell sum alone
 * therefore reports one row where the terminal shows two, and every such disagreement pushes
 * the rows below it — the composer among them — one line further than the frame budgeted.
 * @param text - row text, escapes included.
 * @param width - terminal columns.
 * @returns true when the row consumes exactly one terminal row.
 */
function fitsOneRow(text: string, width: number): boolean {
  let cells = 0
  for (const char of Array.from(stripAnsi(text))) {
    const charWidth = characterWidth(char)
    // The terminal folds before a wide glyph that cannot fit in the remaining columns.
    if (charWidth === 2 && cells === width - 1) return false
    cells += charWidth
    if (cells > width) return false
  }
  return true
}

function displayWidth(text: string): number {
  return Array.from(stripAnsi(text)).reduce((sum, char) => sum + characterWidth(char), 0)
}

export function stripAnsi(text: string): string {
  return text.replaceAll(ANSI_SEQUENCE_GLOBAL, '')
}
