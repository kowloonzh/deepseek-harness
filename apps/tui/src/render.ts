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
import { STATUS_TABS } from './ui.ts'
import type { ClipboardImage } from './clipboard.ts'
import { highlightCode, highlightCommand } from './highlight.ts'
import { formatQuota, type QuotaWindow } from './quota.ts'
import { messages } from './locale.ts'
import { activityReading, statusTabContent } from './status-panel.ts'
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
const REVERSE = `${ESC}7m`
const ITALIC = `${ESC}3m`
/** Columns left of the transcript; codex starts each cell's gutter at the edge. */
const TRANSCRIPT_LEFT_PADDING = 0
const USER_BLOCK_STYLE = `${ESC}97m${ESC}48;5;238m`
const USER_SELECTED_STYLE = `${ESC}97m${ESC}48;5;24m`
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
  /** Where the "back to bottom" control was drawn, for a click to hit; undefined when hidden. */
  readonly followControl?: FollowControl | undefined
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

/**
 * Rows above the conversation: the title, then one blank row that keeps it off the conversation
 * on a screen tall enough to spare it.
 * @param height - terminal rows.
 * @returns 2, or 1 on a short screen.
 */
export function headerRows(height: number): number {
  return height >= 16 ? 2 : 1
}
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

/** The clickable "back to bottom" control: one screen row and a 1-based column span. */
export interface FollowControl {
  readonly row: number
  readonly start: number
  readonly end: number
}

/** Longest first, as codex's follow control shortens to fit. */
const FOLLOW_LABELS = [' ↓ Back to bottom · esc ', ' ↓ Bottom · esc ', ' ↓ Bottom ', ' ↓ '] as const
const FOLLOW_STYLE = `${ESC}96m${ESC}48;5;238m`

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
  readonly highlight: string | undefined
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
  /** When the running turn started, in epoch milliseconds; the status row counts from it. */
  readonly runningSince?: number | undefined
  /** The clock the frame is drawn at; defaults to `Date.now()`. */
  readonly now?: number
  readonly notice: string | undefined
  readonly selection?: TerminalSelection | undefined
  /** The user message a backtrack selection points at, drawn highlighted. */
  readonly highlightItem?: string | undefined
  /** Allowance windows of the subscription serving the model, when known. */
  readonly quota?: readonly QuotaWindow[] | undefined
  /** A suggested next message, drawn dim in an empty composer; Tab takes it. */
  readonly placeholder?: string | undefined
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
    const headerHeight = headerRows(height)
    const area = height - headerHeight
    const limit = bottomPaneLimit(area)
    const paneRows = limit - STATUS_ROWS

    // Bottom pane: the composer first (two border rows around at least one inner row), then
    // whatever fits above it — an open view, or else the queue dock.
    const composer = composerLines(
      options.input,
      options.cursor,
      options.images ?? [],
      width,
      Math.max(1, paneRows - 2),
      options.placeholder,
    )
    const above = Math.max(0, paneRows - composer.lines.length)
    const indicator = options.overlay === undefined && options.state.running && above > 0
      ? [statusIndicatorLine(options.state, width, options.runningSince, options.now ?? Date.now())]
      : []
    const flexible = options.overlay === undefined
      ? [...indicator, ...queueDockLines(options.state.queue, options.submission, width, above - indicator.length)]
      : overlayLines(options.overlay, width, above, options).slice(0, above)
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
    const selectedBody = highlightSelection(paddedBody, headerHeight + 1, options.selection, width)
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

    // Reading back: codex's return-to-latest control, centred in the gap above the composer.
    // It stays out of a selection in progress and from under the slash menu.
    let followControl: FollowControl | undefined
    if (position.kind === 'reading' && gapRows > 0 && menuRows === 0 && options.selection === undefined) {
      const label = FOLLOW_LABELS.find(text => displayWidth(text) <= width)
      if (label !== undefined) {
        const labelWidth = displayWidth(label)
        const left = Math.floor((width - labelWidth) / 2)
        conversation[conversation.length - 1] = `${' '.repeat(left)}${FOLLOW_STYLE}${label}${RESET}`
        followControl = { row: headerHeight + conversation.length, start: left + 1, end: left + labelWidth }
      }
    }
    const status = statusLine(options.state, width, options.notice, options.quota ?? [], options.now ?? Date.now())
    const lines = [
      fitAnsi(header, width),
      ...Array.from({ length: headerHeight - 1 }, () => ''),
      ...conversation,
      ...pane.map(line => fitAnsi(line, width)),
      fitAnsi(status, width),
    ]
    const paneTop = headerHeight + conversation.length
    return {
      lines,
      cursorRow: paneTop + cursor.line + 1,
      cursorColumn: Math.min(width - 1, 5 + cursor.column),
      transcriptRows,
      position,
      scrollBy,
      layout: {
        header: headerHeight,
        transcript: transcriptRows,
        gap: gapRows,
        menu: menuRows,
        bottom: pane.length,
        status: STATUS_ROWS,
        total: lines.length,
      },
      selectionRegion: { top: headerHeight + 1, rows: shown },
      followControl,
    }
  }

  private cachedTranscriptLines(options: RenderViewOptions, width: number): { readonly lines: string[]; readonly owners: RowOwner[] } {
    const cached = this.transcriptCache
    if (cached !== undefined
      && cached.items === options.state.items
      && cached.width === width
      && cached.expandedTools === options.expandedTools
      && cached.highlight === options.highlightItem) {
      return cached
    }
    const { lines, owners } = transcriptLines(options.state.items, options.expandedTools, width, options.highlightItem)
    this.transcriptCache = {
      items: options.state.items,
      width,
      expandedTools: options.expandedTools,
      highlight: options.highlightItem,
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
  // The prompt marker and the cell gutters are chrome, not content.
  return line.replace(/^(?:› |[•■] )/u, '')
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
  highlight?: string,
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
    if (item.kind === 'user') {
      const prefixWidth = displayWidth(USER_PROMPT_PREFIX)
      const contentWidth = Math.max(8, width - prefixWidth - 1)
      const wrapped = wrapText(item.text, contentWidth)
      if (wrapped.length === 0) wrapped.push('')
      // A backtrack selection lifts its message onto a brighter block with a yellow marker.
      const selected = item.id === highlight
      const block = selected ? USER_SELECTED_STYLE : USER_BLOCK_STYLE
      for (const [lineIndex, line] of wrapped.entries()) {
        const marker = lineIndex === 0 ? `${selected ? YELLOW : CYAN}›${block} ` : ' '.repeat(prefixWidth)
        lines.push(`${block}${padAnsi(`${marker}${line}`, width)}${RESET}`)
      }
      lines.push('', '')
      claim(item.id)
      continue
    }
    // Reasoning stays out of the conversation, as in codex: its latest line rides in the
    // bottom pane while the turn runs, and Ctrl+O brings the full text back.
    if (item.kind === 'reasoning' && !expandedTools) continue
    if (item.kind === 'turn') {
      if (item.elapsedMs === undefined) continue
      lines.push(workedSeparator(item.elapsedMs, width), '')
      claim(item.id)
      continue
    }
    lines.push(...cellLines(item, width), '')
    claim(item.id)
  }
  if (lines.length === 0) return { lines: [`${DIM}${messages.emptyTranscript}${RESET}`], owners: [{ key: '', offset: 0 }] }
  return { lines, owners }
}

/**
 * Rows of one non-user, non-tool item under codex's gutter: `• ` before the first row and two
 * spaces before the rest, so every cell's text starts in the same column.
 * @param item - an assistant, reasoning, system, or error item.
 * @param width - columns available, gutter included.
 * @returns the cell's rows without a trailing spacer.
 */
function cellLines(item: TranscriptItem, width: number): string[] {
  const inner = Math.max(1, width - 2)
  switch (item.kind) {
    case 'assistant':
      return gutter(renderMarkdownLines(item.text, inner), `${DIM}•${RESET} `)
    case 'reasoning': {
      // Dim italic throughout: every reset inside a row re-applies it.
      const style = `${DIM}${ITALIC}`
      const rows = renderMarkdownLines(item.text, inner).map(row => `${style}${row.replaceAll(RESET, `${RESET}${style}`)}${RESET}`)
      return gutter(rows, `${DIM}•${RESET} `)
    }
    case 'error':
      return gutter(wrapText(item.text === '' ? item.title ?? '' : item.text, inner).map(row => `${RED}${row}${RESET}`), `${RED}■${RESET} `)
    default:
      return gutter(wrapText(item.text, inner).map(row => `${DIM}${row}${RESET}`), `${DIM}•${RESET} `)
  }
}

/**
 * codex's final-message separator: `─ Worked for 1m 05s ───…` across the row, dim.
 * @param elapsedMs - how long the turn ran.
 * @param width - columns to fill.
 * @returns the separator row.
 */
function workedSeparator(elapsedMs: number, width: number): string {
  const label = `─ ${messages.workedFor(compactElapsed(Math.floor(elapsedMs / 1000)))} `
  const fitted = fit(label, width)
  return `${DIM}${fitted}${'─'.repeat(Math.max(0, width - displayWidth(fitted)))}${RESET}`
}

/**
 * Elapsed time as codex's `fmt_elapsed_compact`: `45s`, `1m 05s`, `1h 02m 05s`.
 * @param seconds - whole seconds.
 * @returns the compact form.
 */
function compactElapsed(seconds: number): string {
  if (seconds < 60) return `${String(seconds)}s`
  const pad = (value: number): string => String(value).padStart(2, '0')
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))}m ${pad(seconds % 60)}s`
  return `${String(Math.floor(seconds / 3600))}h ${pad(Math.floor(seconds / 60) % 60)}m ${pad(seconds % 60)}s`
}

function gutter(rows: readonly string[], bullet: string): string[] {
  const body = rows.length === 0 ? [''] : rows
  return body.map((row, index) => `${index === 0 ? bullet : '  '}${row}`)
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

function wrapStyled(chars: readonly StyledChar[], width: number, firstWidth = width): string[] {
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
    if (cells + charWidth > (lines.length === 0 ? firstWidth : width) && line.length > 0) flush()
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
  // codex prints the code alone, indented, without the fence's language tag, colored by it.
  const lines: string[] = []
  // Tabs would otherwise sanitize to one space and flatten indented code.
  for (const spans of highlightCode(code.text.replaceAll('\t', '    '), code.lang)) {
    const chars: StyledChar[] = [{ char: ' ', style: '' }, { char: ' ', style: '' }]
    for (const span of spans) {
      for (const char of Array.from(sanitize(span.text))) chars.push({ char, style: span.style })
    }
    lines.push(...wrapStyled(chars, width))
  }
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

/** Output rows a collapsed card previews, as codex's `TOOL_CALL_MAX_LINES`. */
const TOOL_PREVIEW_ROWS = 5
/** Command rows a collapsed `Ran` card shows after its first, as codex's exec layout. */
const COMMAND_CONTINUATION_ROWS = 2
/** Diff rows a collapsed `Edited` card shows. */
const DIFF_PREVIEW_ROWS = 6
/** Tools whose calls fold into one `Explored` card. */
const EXPLORE_TOOLS = new Set(['read', 'grep', 'glob', 'ls'])
/** Tools that change files and render as a diff. */
const EDIT_TOOLS = new Set(['edit', 'write', 'str_replace_editor', 'apply_patch'])

/**
 * Cards for one run of consecutive tool calls, codex style.
 *
 * Each card opens with a status bullet and a verb, and hangs its detail under `└`. Consecutive
 * reads and searches fold into one `Explored` card; commands, edits, and other calls each get
 * their own. Collapsed cards preview a few rows of output or diff; expanded cards (Ctrl+O)
 * show all of it. Raw call arguments are never shown: each card says what they mean.
 * @param items - the run of tool items, oldest first.
 * @param expanded - show full output instead of a preview.
 * @param width - columns available to the cards.
 * @returns the cards' rows, each card followed by one blank row.
 */
function toolGroupLines(items: readonly TranscriptItem[], expanded: boolean, width: number): string[] {
  const lines: string[] = []
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item === undefined) continue
    const name = item.title ?? messages.tool
    if (EXPLORE_TOOLS.has(name)) {
      const group: TranscriptItem[] = [item]
      while (EXPLORE_TOOLS.has(items[index + 1]?.title ?? '')) {
        index += 1
        const next = items[index]
        if (next !== undefined) group.push(next)
      }
      lines.push(...exploreCard(group, expanded, width))
    } else {
      lines.push(...toolCard(item, name, expanded, width))
    }
    if (index < items.length - 1) lines.push('')
  }
  return lines
}

function toolStatusOf(item: TranscriptItem): ToolStatus {
  return item.toolStatus ?? (item.toolOutput === undefined ? 'running' : 'ok')
}

/**
 * The bullet a card opens with: yellow while running, red once failed, otherwise `done`.
 * @param status - the card's status.
 * @param done - the style of a finished bullet.
 * @returns the styled bullet and its trailing space.
 */
function cardBullet(status: ToolStatus, done = GREEN): string {
  const color = status === 'running' ? YELLOW : status === 'error' ? RED : done
  // codex draws a finished call's bullet bold green or red; a dimmed one stays plain dim.
  const weight = status !== 'running' && color !== DIM ? BOLD : ''
  return `${weight}${color}•${RESET} `
}

/**
 * A card's title row followed by wrapped continuation rows hung under `prefix`.
 * @param bullet - the styled bullet.
 * @param verb - the bold verb.
 * @param subject - the rest of the title.
 * @param width - columns available.
 * @returns the title rows.
 */
function cardTitle(bullet: string, verb: string, subject: string, width: number): string[] {
  const head = `${BOLD}${verb}${RESET}`
  if (subject === '') return [`${bullet}${head}`]
  const wrapped = wrapText(subject, Math.max(1, width - 2 - displayWidth(verb) - 1))
  return [`${bullet}${head} ${wrapped[0] ?? ''}`, ...wrapped.slice(1).map(line => `  ${line}`)]
}

/**
 * Rows hung under a card: `  └ ` before the first, four spaces before the rest.
 * @param rows - styled rows, already fitted to `width - 4`.
 * @returns the hung rows.
 */
function hang(rows: readonly string[]): string[] {
  return rows.map((row, index) => `${DIM}${index === 0 ? '  └ ' : '    '}${RESET}${row}`)
}

/**
 * Output rows, previewed as codex does: the head and tail of long output around one row that
 * counts what was left out.
 * @param text - the output.
 * @param expanded - show every row.
 * @param width - columns for each row.
 * @param style - the style each row is drawn in.
 * @returns styled rows.
 */
function outputRows(text: string, expanded: boolean, width: number, style = DIM): string[] {
  const rows = wrapText(text.replace(/\s+$/u, ''), Math.max(1, width))
  if (expanded || rows.length <= TOOL_PREVIEW_ROWS) return rows.map(row => `${style}${row}${RESET}`)
  const keep = Math.floor((TOOL_PREVIEW_ROWS - 1) / 2)
  return [
    ...rows.slice(0, keep).map(row => `${style}${row}${RESET}`),
    `${DIM}${omittedRows(rows.length - keep * 2)}${RESET}`,
    ...rows.slice(-keep).map(row => `${style}${row}${RESET}`),
  ]
}

function omittedRows(count: number): string {
  return `… +${String(count)} ${count === 1 ? 'line' : 'lines'} (Ctrl+O)`
}

/**
 * One `Explored` card for consecutive reads and searches.
 *
 * Consecutive reads share one `Read a, b` row; each search or listing gets its own row. A
 * failed call is marked on its row, and expanded cards hang each call's output under it.
 */
function exploreCard(items: readonly TranscriptItem[], expanded: boolean, width: number): string[] {
  const status = combinedStatus(items)
  const verb = status === 'running' ? 'Exploring' : 'Explored'
  const inner = Math.max(1, width - 4)
  const rows: string[] = []
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item === undefined) continue
    if (item.title === 'read' && !expanded) {
      const names = [readName(item)]
      let failed = toolStatusOf(item) === 'error'
      while (items[index + 1]?.title === 'read') {
        index += 1
        const next = items[index]
        if (next === undefined) continue
        names.push(readName(next))
        failed ||= toolStatusOf(next) === 'error'
      }
      rows.push(...exploreRow('Read', [...new Set(names)].join(', '), failed, inner))
      continue
    }
    const [action, subject] = exploreAction(item)
    rows.push(...exploreRow(action, subject, toolStatusOf(item) === 'error', inner))
    if (expanded && item.toolOutput !== undefined && item.toolOutput.trim() !== '') {
      rows.push(...outputRows(item.toolOutput, true, Math.max(1, inner - 2)).map(row => `  ${row}`))
    } else if (toolStatusOf(item) === 'error' && item.toolOutput !== undefined) {
      rows.push(...outputRows(item.toolOutput, false, Math.max(1, inner - 2), RED).map(row => `  ${row}`))
    }
  }
  return [`${cardBullet(status, DIM)}${BOLD}${verb}${RESET}`, ...hang(rows)]
}

function exploreRow(action: string, subject: string, failed: boolean, width: number): string[] {
  const mark = failed ? ` ${RED}(failed)${RESET}` : ''
  const wrapped = wrapText(subject, Math.max(1, width - displayWidth(action) - 1 - (failed ? 9 : 0)))
  return [
    `${CYAN}${action}${RESET} ${wrapped[0] ?? ''}${mark}`,
    ...wrapped.slice(1).map(line => `${' '.repeat(displayWidth(action) + 1)}${line}`),
  ]
}

function exploreAction(item: TranscriptItem): [string, string] {
  const args = parsedToolArguments(item)
  if (item.title === 'read') return ['Read', readSubject(item)]
  const pattern = stringField(args, 'pattern') ?? item.text
  const path = stringField(args, 'path')
  const scope = path === undefined ? '' : ` in ${path}`
  if (item.title === 'glob') return ['List', `${pattern}${scope}`]
  if (item.title === 'ls') return ['List', path ?? item.text]
  return ['Search', `${pattern}${scope}`]
}

function readName(item: TranscriptItem): string {
  const path = readSubject(item)
  return path.split(/[\\/]/u).at(-1) ?? path
}

/** One card for a call that is not a read or a search. */
function toolCard(item: TranscriptItem, name: string, expanded: boolean, width: number): string[] {
  const status = toolStatusOf(item)
  const inner = Math.max(1, width - 4)
  const output = item.toolOutput ?? ''
  const failure = status === 'error' && output.trim() !== '' ? outputRows(output, expanded, inner, RED) : []
  if (name === 'bash') return commandCard(item, status, expanded, width)
  if (EDIT_TOOLS.has(name)) {
    const change = fileChange(item, name)
    const verb = status === 'running' ? 'Editing' : change.added ? 'Added' : 'Edited'
    const counts = `${GREEN}+${String(change.plus)}${RESET} ${RED}-${String(change.minus)}${RESET}`
    const title = `${cardBullet(status)}${BOLD}${verb}${RESET} ${fit(change.path, Math.max(1, width - verb.length - 14))} (${counts})`
    return [title, ...hang(failure.length > 0 ? failure : diffRows(change.rows, expanded, inner))]
  }
  if (name === 'todo_write') {
    const todos = parsedToolArguments(item)?.todos
    const rows = Array.isArray(todos) ? todos.flatMap(todo => todoRow(todo, inner)) : []
    return [`${cardBullet(status, DIM)}${BOLD}Updated Plan${RESET}`, ...hang(failure.length > 0 ? failure : rows)]
  }
  const [verb, subject] = callTitle(item, name, status)
  if (verb === 'Called' || verb === 'Calling') {
    // codex's tool invocation: the tool in the accent color, its arguments dimmed.
    const detail = subject.startsWith(name) ? subject.slice(name.length).trimStart() : subject
    const title = `${cardBullet(status, DIM)}${BOLD}${verb}${RESET} ${CYAN}${name}${RESET}`
    const lead = displayWidth(verb) + displayWidth(name) + 4
    const chars: StyledChar[] = Array.from(sanitize(detail), char => ({ char, style: DIM }))
    const detailRows = detail === '' ? [] : wrapStyled(chars, Math.max(1, width - 2), Math.max(1, width - lead))
    const head = detailRows.length === 0 ? [title] : [`${title} ${detailRows[0] ?? ''}`, ...detailRows.slice(1).map(row => `  ${row}`)]
    return [...head, ...hang(failure.length > 0 ? failure : outputRows(output, expanded, inner))]
  }
  const preview = failure.length > 0
    ? failure
    : expanded || !['web_search', 'web_fetch', 'skill'].includes(name)
      ? outputRows(output, expanded, inner)
      : []
  return [...cardTitle(cardBullet(status, DIM), verb, subject, width), ...hang(preview)]
}

function callTitle(item: TranscriptItem, name: string, status: ToolStatus): [string, string] {
  const args = parsedToolArguments(item)
  if (name === 'web_search') return [status === 'running' ? 'Searching' : 'Searched', searchSubject(item)]
  if (name === 'web_fetch') return [status === 'running' ? 'Opening' : 'Opened', stringField(args, 'url') ?? item.text]
  if (name === 'skill') return ['Loaded skill', stringField(args, 'name') ?? item.text]
  const subject = subjectFromArguments(args) || item.text
  return [status === 'running' ? 'Calling' : 'Called', `${name}${subject === '' ? '' : ` ${subject}`}`]
}

/** A `Ran` card: the command, its continuation rows under `│`, then its output under `└`. */
function commandCard(item: TranscriptItem, status: ToolStatus, expanded: boolean, width: number): string[] {
  const verb = status === 'running' ? 'Running' : 'Ran'
  const command = commandSubject(item)
  // Highlighted per logical line, then wrapped: the first row sits after `• Ran `, the rest
  // after the four-column `  │ ` gutter.
  const rows = command.split(/\r?\n/u).flatMap((line, index) => {
    const chars: StyledChar[] = []
    for (const span of highlightCommand(line.replaceAll('\t', '    '))) {
      for (const char of Array.from(sanitize(span.text))) chars.push({ char, style: span.style })
    }
    return wrapStyled(chars, Math.max(1, width - 4), index === 0 ? Math.max(1, width - displayWidth(verb) - 3) : undefined)
  })
  const lines = [`${cardBullet(status)}${BOLD}${verb}${RESET} ${rows[0] ?? ''}`]
  const continuation = rows.slice(1)
  const shown = expanded ? continuation : continuation.slice(0, COMMAND_CONTINUATION_ROWS)
  for (const row of shown) lines.push(`${DIM}  │ ${RESET}${row}`)
  if (shown.length < continuation.length) {
    lines.push(`${DIM}  │ … +${String(continuation.length - shown.length)} lines${RESET}`)
  }
  if (status === 'running' && (item.toolOutput ?? '') === '') return lines
  const output = item.toolOutput ?? ''
  const preview = output.trim() === ''
    ? [`${DIM}(no output)${RESET}`]
    : outputRows(output, expanded, Math.max(1, width - 4), status === 'error' ? RED : DIM)
  return [...lines, ...hang(preview)]
}

interface FileChange {
  readonly path: string
  readonly added: boolean
  readonly plus: number
  readonly minus: number
  /** Diff rows with their `+` / `-` marker. */
  readonly rows: readonly string[]
}

/**
 * What one edit-like call changes, read from its arguments.
 * @param item - the tool item.
 * @param name - the tool name.
 * @returns the path, line counts, and diff rows.
 */
function fileChange(item: TranscriptItem, name: string): FileChange {
  const args = parsedToolArguments(item)
  if (name === 'apply_patch') {
    const patch = stringField(args, 'input') ?? stringField(args, 'patch') ?? ''
    const paths: string[] = []
    const rows: string[] = []
    let added = false
    for (const line of patch.split(/\r?\n/u)) {
      const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/u.exec(line)
      if (header !== null) {
        paths.push(header[2] ?? '')
        added ||= header[1] === 'Add'
        continue
      }
      if (/^[+-]/u.test(line)) rows.push(line)
    }
    const path = paths.length <= 1 ? paths[0] ?? item.text : `${String(paths.length)} files`
    return { path, added: added && paths.length === 1, ...diffCounts(rows), rows }
  }
  const path = stringField(args, 'file_path') ?? stringField(args, 'path') ?? item.text
  if (name === 'write') {
    const rows = splitLines(stringField(args, 'content')).map(line => `+${line}`)
    return { path, added: true, ...diffCounts(rows), rows }
  }
  const rows = [
    ...splitLines(stringField(args, 'old_string')).map(line => `-${line}`),
    ...splitLines(stringField(args, 'new_string')).map(line => `+${line}`),
  ]
  return { path, added: false, ...diffCounts(rows), rows }
}

function splitLines(value: string | undefined): string[] {
  return value === undefined || value === '' ? [] : value.replace(/\r?\n$/u, '').split(/\r?\n/u)
}

function diffCounts(rows: readonly string[]): { readonly plus: number; readonly minus: number } {
  return {
    plus: rows.filter(row => row.startsWith('+')).length,
    minus: rows.filter(row => row.startsWith('-')).length,
  }
}

function diffRows(rows: readonly string[], expanded: boolean, width: number): string[] {
  const shown = expanded ? rows : rows.slice(0, DIFF_PREVIEW_ROWS)
  const styled = shown.map(row => `${row.startsWith('+') ? GREEN : RED}${fit(row, width)}${RESET}`)
  if (shown.length < rows.length) styled.push(`${DIM}${omittedRows(rows.length - shown.length)}${RESET}`)
  return styled
}

function todoRow(todo: unknown, width: number): string[] {
  if (typeof todo !== 'object' || todo === null) return []
  const { content, status } = todo as { readonly content?: unknown; readonly status?: unknown }
  if (typeof content !== 'string') return []
  const mark = status === 'completed' ? `${GREEN}✔${RESET}` : status === 'in_progress' ? `${CYAN}□${RESET}` : `${DIM}□${RESET}`
  const text = status === 'completed' ? `${DIM}${content}${RESET}` : content
  const wrapped = wrapText(text, Math.max(1, width - 2))
  return [`${mark} ${wrapped[0] ?? ''}`, ...wrapped.slice(1).map(line => `  ${line}`)]
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

function combinedStatus(items: readonly TranscriptItem[]): ToolStatus {
  if (items.some(item => item.toolStatus === 'error')) return 'error'
  if (items.some(item => (item.toolStatus ?? 'ok') === 'running')) return 'running'
  return 'ok'
}

/**
 * The running turn's one-line status, as codex's status indicator: the latest line of the
 * model's reasoning (or `Working` before any), how long the turn has run, and how to stop it.
 * @param state - the transcript.
 * @param width - columns available.
 * @param since - when the turn started, if known.
 * @param now - the frame's clock.
 * @returns one styled row.
 */
function statusIndicatorLine(state: TranscriptState, width: number, since: number | undefined, now: number): string {
  const header = latestReasoningLine(state.items) ?? messages.working
  const seconds = since === undefined ? 0 : Math.max(0, Math.floor((now - since) / 1000))
  const tail = ` (${compactElapsed(seconds)} • esc to interrupt)`
  const room = Math.max(1, width - 2 - displayWidth(tail))
  return `${YELLOW}•${RESET} ${BOLD}${fit(header, room)}${RESET}${DIM}${tail}${RESET}`
}

/**
 * The latest non-empty line of the current turn's reasoning, without Markdown heading or bold
 * marks, as codex's `latest_summary_line`.
 * @param items - the transcript items.
 * @returns the line, or undefined when this turn has not reasoned yet.
 */
export function latestReasoningLine(items: readonly TranscriptItem[]): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item === undefined || item.kind === 'user') return undefined
    if (item.kind !== 'reasoning') continue
    for (const raw of item.text.split(/\r?\n/u).reverse()) {
      const line = raw.trim().replace(/^#+\s*/u, '').replaceAll('**', '').trim()
      if (line !== '' && !line.startsWith('<!--')) return line
    }
  }
  return undefined
}

const DOCK_ITEM = '  ↳ '
const DOCK_HINT = '    '

function queueDockLines(
  queue: TranscriptState['queue'],
  submission: PendingSubmission | undefined,
  width: number,
  limit: number,
): string[] {
  if (limit <= 0) return []
  const lines: string[] = []
  // Inset like codex's pending-message rows: each message under a `↳`, its hint under the
  // message text, so the dock lines up with the status indicator above it instead of the edge.
  const row = (text: string): string => `${DOCK_ITEM}${fit(text, Math.max(1, width - displayWidth(DOCK_ITEM)))}`
  const hint = (text: string): string => `${DOCK_HINT}${fit(text, Math.max(1, width - DOCK_HINT.length))}`
  if (submission !== undefined) {
    const images = submission.imageCount === 0 ? '' : ` [${String(submission.imageCount)} image]`
    lines.push(`${YELLOW}${row(`sending ${submission.mode}: ${submission.text}${images}`)}${RESET}`)
  }
  const budget = Math.max(0, 3 - lines.length)
  for (const item of queue.slice(0, budget)) {
    if (item.placement === 'context') {
      // Host-queued context, such as a finished background job: nothing to recall or manage.
      lines.push(`${DIM}${row(`${messages.queueContext}: ${item.summary ?? item.text}`)}${RESET}`)
      continue
    }
    const kind = item.placement === 'steering' ? 'steer' : 'queued'
    // The hint rides on the message itself so it stays visible however many are pending.
    lines.push(`${DIM}${row(`${kind}: ${item.text || '[attachment]'}`)}${RESET}`)
    // Only actions that apply to a queued row: a draft-level shortcut (Alt+Enter) belongs in
    // `/help`, where its condition is stated, not beside rows it cannot touch.
    lines.push(`${DIM}${hint('Alt+Up recall · /queue manage')}${RESET}`)
  }
  if (queue.length > budget) {
    lines.push(`${DIM}${hint(`${String(queue.length - budget)} more pending · /queue manage`)}${RESET}`)
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

// codex insets its footer two columns from the left edge instead of starting flush.
const STATUS_INDENT = '  '

function statusLine(
  state: TranscriptState,
  fullWidth: number,
  notice: string | undefined,
  quota: readonly QuotaWindow[],
  now: number,
): string {
  if (fullWidth <= STATUS_INDENT.length) return statusRow(state, fullWidth, notice, quota, now)
  return `${STATUS_INDENT}${statusRow(state, fullWidth - STATUS_INDENT.length, notice, quota, now)}`
}

function statusRow(
  state: TranscriptState,
  width: number,
  notice: string | undefined,
  quota: readonly QuotaWindow[],
  now: number,
): string {
  const allowance = formatQuota(quota, now)
  const lowest = Math.min(...quota.map(window => window.remaining))
  // Before the Session opens the model is not known yet, not the default.
  const model = state.model === undefined
    ? state.sessionId === undefined ? undefined : messages.defaultModel
    : `${state.model.model}${state.model.reasoningEffort === undefined ? '' : ` ${state.model.reasoningEffort}`}`
  const context = contextPercent(state)
  const cache = cacheHitPercent(state.tokens)
  const activity = activityReading(state.stats)
  // codex's footer status line: segments joined by a dim ` · `, each in its accent color (model
  // cyan, path and usage green). The run state is on the title row, not here. Token totals and
  // the permission mode live in `/status`; the running tool already has its own card and the status indicator.
  const segments: StatusSegment[] = [
    ...(model === undefined ? [] : [{ text: model, style: CYAN }]),
    { text: shortenHome(state.cwd), style: GREEN, shrinks: true },
    ...(context === undefined ? [] : [{ text: context, style: GREEN }]),
    ...(cache === undefined ? [] : [{ text: `cache ${String(cache)}%`, style: GREEN }]),
    // Whole-Session turns and steps; the times behind them are on the Stats tab of `/status`.
    ...(activity === undefined ? [] : [{ text: activity, style: GREEN, drops: true }]),
    // Subscription allowance left, yellow once a window runs low and red when nearly gone.
    ...(allowance === undefined ? [] : [{ text: allowance, style: lowest < 5 ? RED : lowest < 20 ? YELLOW : GREEN }]),
  ]
  if (notice === undefined || notice === '') return statusSegments(segments, width)
  const noticeWidth = displayWidth(notice)
  if (noticeWidth >= width) return `${YELLOW}${fit(notice, width)}${RESET}`
  return `${statusSegments(segments, Math.max(1, width - noticeWidth - 2))}  ${YELLOW}${fit(notice, noticeWidth)}${RESET}`
}

interface StatusSegment {
  readonly text: string
  readonly style: string
  /** Gives up its width first when the row is too narrow (the working directory). */
  readonly shrinks?: boolean
  /** Left out when the row is still too narrow after the shrinkable one gave way. */
  readonly drops?: boolean
}

const STATUS_SEPARATOR = ' · '

/**
 * Paint status segments into one row, shortening the shrinkable one before anything else so the
 * readings after it, the reading hint among them, stay visible.
 * @param segments - the readings, left to right.
 * @param width - columns available.
 * @returns the styled row.
 */
function statusSegments(segments: readonly StatusSegment[], width: number): string {
  let kept = segments.map(segment => ({ ...segment, text: sanitize(segment.text) }))
  const total = (): number => displayWidth(kept.map(segment => segment.text).join(STATUS_SEPARATOR))
  const overflow = total() - width
  const shrinkable = kept.findIndex(segment => segment.shrinks === true)
  const target = kept[shrinkable]
  if (overflow > 0 && target !== undefined) {
    const room = displayWidth(target.text) - overflow
    kept = room >= 4
      ? kept.map((segment, index) => index === shrinkable ? { ...segment, text: fit(segment.text, room) } : segment)
      : kept.filter((_, index) => index !== shrinkable)
  }
  if (total() > width) kept = kept.filter(segment => segment.drops !== true)
  if (total() > width) return `${DIM}${fit(kept.map(segment => segment.text).join(STATUS_SEPARATOR), width)}${RESET}`
  return kept.map(segment => `${segment.style}${segment.text}${RESET}`).join(`${DIM}${STATUS_SEPARATOR}${RESET}`)
}

function contextPercent(state: TranscriptState): string | undefined {
  const context = state.context
  if (context?.contextWindow === undefined) return undefined
  const used = context.projectedTokens ?? context.pressureTokens
  if (used === undefined) return undefined
  const percent = Math.min(100, Math.round(used / context.contextWindow * 100))
  return `ctx ${String(percent)}%`
}

function composerLines(
  input: string,
  cursor: number,
  images: readonly ClipboardImage[],
  width: number,
  maxInnerRows: number,
  placeholder?: string,
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
  if (input === '' && images.length === 0 && placeholder !== undefined && placeholder !== '') {
    // The cursor stays at the start: the suggestion is not text in the composer until Tab.
    innerRows[0] = boxContent(`${CYAN}❯${RESET}`, `${DIM}${fit(placeholder, contentWidth)}${RESET}`, width)
  }
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

function overlayLines(overlay: Overlay, width: number, height: number, view: RenderViewOptions): string[] {
  switch (overlay.kind) {
    case 'status':
      return statusPanelLines(overlay, width, height, view)
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

/**
 * The `/status` panel: a tab bar, the tab's aligned rows, and the key hint. The rows are read from
 * the frame's live state, so the figures move while a turn runs.
 */
function statusPanelLines(
  overlay: Extract<Overlay, { kind: 'status' }>,
  width: number,
  height: number,
  view: RenderViewOptions,
): string[] {
  const tabs = STATUS_TABS.map((tab) => {
    const name = ` ${messages.statusTabs[tab]} `
    return tab === overlay.tab ? `${CYAN}${BOLD}${REVERSE}${name}${RESET}` : `${DIM}${name}${RESET}`
  }).join(' ')
  const content = statusTabContent(overlay.tab, view.state, { columns: view.columns, rows: view.rows })
  const body = 'empty' in content
    ? [`${DIM}${fit(content.empty, width - 2)}${RESET}`]
    : panelRows(content.rows, width)
  // Rows that do not fit give way before the tab bar and the hint, which say how to get out.
  const room = Math.max(0, height - 4)
  return [
    fitAnsi(tabs, width),
    '',
    ...body.slice(0, room),
    '',
    `${DIM}${fit(messages.statusPanelHint, width)}${RESET}`,
  ]
}

function panelRows(rows: readonly { readonly label: string; readonly value: string }[], width: number): string[] {
  const labelWidth = Math.max(...rows.map(row => displayWidth(row.label)))
  return rows.map((row) => {
    const label = `${row.label}${' '.repeat(labelWidth - displayWidth(row.label))}`
    const valueWidth = Math.max(1, width - labelWidth - 4)
    return `  ${DIM}${label}${RESET}  ${fit(row.value, valueWidth)}`
  })
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
      const type = item.placement === 'steering'
        ? messages.queueSteering
        : item.placement === 'context' ? messages.queueContext : messages.queueQueued
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
