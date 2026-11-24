/**
 * Cell grid between the composed frame and the terminal.
 *
 * Every row the renderer composes is written into a fixed `width × height` grid of cells, and
 * only cells that differ from the previous grid are sent to the terminal. A row can therefore
 * never reach past its own grid row or the right margin: whatever does not fit is dropped here,
 * not folded by the terminal into the rows below, which is how transcript text used to land on
 * the composer. A double-width glyph occupies a leader cell and a continuation cell; one that
 * would straddle the right margin is replaced by a blank, as ratatui's buffer does.
 *
 * The approach follows codex's `custom_terminal::diff_buffers`, reduced to what this frontend
 * draws: SGR styling and OSC 8 hyperlinks.
 */

const CSI = '\u001b['
/** Pause the terminal's presentation until the frame is complete (DEC private mode 2026). */
const SYNC_BEGIN = `${CSI}?2026h`
const SYNC_END = `${CSI}?2026l`
/** With autowrap off, a cell written in the last column cannot push the cursor to a new row. */
const AUTOWRAP_OFF = `${CSI}?7l`
const AUTOWRAP_ON = `${CSI}?7h`
const OSC8_CLOSE = '\u001b]8;;\u001b\\'

/** Display style of one cell, kept as the SGR parameters that recreate it after a reset. */
interface CellStyle {
  readonly bold: boolean
  readonly dim: boolean
  readonly italic: boolean
  readonly underline: boolean
  readonly inverse: boolean
  readonly strike: boolean
  /** Foreground SGR parameters such as `31`, `38;5;238`, or `38;2;1;2;3`. */
  readonly fg: string | undefined
  /** Background SGR parameters such as `41`, `48;5;238`, or `48;2;1;2;3`. */
  readonly bg: string | undefined
}

/** One terminal cell. A continuation cell holds the right half of the glyph to its left. */
export interface Cell {
  readonly symbol: string
  /** 1 or 2 for a glyph's leader cell, 0 for a double-width glyph's continuation. */
  readonly width: 0 | 1 | 2
  /** SGR parameter list for this cell; empty means the terminal default. */
  readonly sgr: string
  readonly link: string | undefined
}

/** Terminal cursor target in one-based screen coordinates. */
export interface ScreenCursor {
  readonly row: number
  readonly column: number
}

const PLAIN: CellStyle = {
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
  strike: false,
  fg: undefined,
  bg: undefined,
}

const BLANK: Cell = { symbol: ' ', width: 1, sgr: '', link: undefined }
const CONTINUATION: Omit<Cell, 'sgr' | 'link'> = { symbol: '', width: 0 }

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * Terminal cells a code point occupies, using the East Asian wide ranges terminals draw at two.
 * @param char - one code point.
 * @returns 2 for a double-width glyph, otherwise 1.
 */
export function characterWidth(char: string): 1 | 2 {
  const code = char.codePointAt(0) ?? 0
  return code >= 0x1100 && (
    code <= 0x115f
    || code === 0x2329 || code === 0x232a
    || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe10 && code <= 0xfe19)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1faff)
  ) ? 2 : 1
}

/** Fixed-size grid of cells the terminal is brought in line with. */
export class ScreenBuffer {
  readonly width: number
  readonly height: number
  private readonly cells: Cell[]

  constructor(width: number, height: number) {
    this.width = Math.max(1, Math.floor(width))
    this.height = Math.max(1, Math.floor(height))
    this.cells = Array.from({ length: this.width * this.height }, () => BLANK)
  }

  /**
   * Build a grid from composed rows, one row each, dropping rows past the bottom.
   * @param width - terminal columns.
   * @param height - terminal rows.
   * @param lines - styled rows, top to bottom.
   * @returns the filled grid.
   */
  static fromLines(width: number, height: number, lines: readonly string[]): ScreenBuffer {
    const screen = new ScreenBuffer(width, height)
    for (const [row, line] of lines.entries()) {
      if (row >= screen.height) break
      screen.writeAnsi(0, row, line)
    }
    return screen
  }

  /**
   * The cell at a zero-based position.
   * @param x - column.
   * @param y - row.
   * @returns the cell, or a blank outside the grid.
   */
  cell(x: number, y: number): Cell {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return BLANK
    return this.cells[y * this.width + x] ?? BLANK
  }

  /**
   * Write styled text into one row, clipped at the right margin.
   *
   * SGR sequences set the style of the cells that follow and OSC 8 sequences their link; every
   * other escape sequence and control character is dropped, because it would move the cursor
   * or change terminal state behind the grid's back.
   * @param x - zero-based start column.
   * @param y - zero-based row; a row outside the grid writes nothing.
   * @param text - styled text without line breaks.
   * @returns the column after the last cell written.
   */
  writeAnsi(x: number, y: number, text: string): number {
    if (y < 0 || y >= this.height) return x
    let column = Math.max(0, x)
    let style = PLAIN
    let link: string | undefined
    let index = 0
    while (index < text.length && column < this.width) {
      if (text[index] === '\u001b') {
        const escape = parseEscape(text, index)
        index = escape.end
        if (escape.kind === 'sgr') style = applySgr(style, escape.params)
        if (escape.kind === 'link') link = escape.target === '' ? undefined : escape.target
        continue
      }
      const next = text.indexOf('\u001b', index)
      const run = text.slice(index, next === -1 ? text.length : next)
      index += run.length
      const sgr = styleSgr(style)
      for (const { segment } of SEGMENTER.segment(run)) {
        if (column >= this.width) break
        // Control characters would move the cursor; graphemes made only of them are dropped.
        const symbol = segment.replaceAll(/[\u0000-\u001f\u007f-\u009f]/gu, '')
        if (symbol === '') continue
        const width = characterWidth(symbol)
        if (width === 2 && column + 1 >= this.width) {
          // A wide glyph cannot straddle the margin; the terminal would fold it onto the next
          // row. Leave a blank in its place and stop, as the row is full either way.
          this.put(column, y, { ...BLANK, sgr })
          column += 1
          break
        }
        this.put(column, y, { symbol, width, sgr, link })
        if (width === 2) this.put(column + 1, y, { ...CONTINUATION, sgr, link })
        column += width
      }
    }
    return column
  }

  /**
   * Plain text of one row, as the terminal shows it.
   * @param y - zero-based row.
   * @returns the row's glyphs without styling, trailing blanks removed.
   */
  rowText(y: number): string {
    let text = ''
    for (let x = 0; x < this.width; x += 1) text += this.cell(x, y).symbol
    return text.trimEnd()
  }

  private put(x: number, y: number, cell: Cell): void {
    const index = y * this.width + x
    const previous = this.cells[index] ?? BLANK
    // Overwriting half of a double-width glyph leaves the other half orphaned; blank it, the
    // same way a terminal erases both halves when one is written.
    if (previous.width === 0 && cell.width !== 0 && x > 0) {
      this.cells[index - 1] = { ...BLANK, sgr: this.cells[index - 1]?.sgr ?? '' }
    }
    if (previous.width === 2 && cell.width !== 2 && x + 1 < this.width) {
      this.cells[index + 1] = { ...BLANK, sgr: previous.sgr }
    }
    this.cells[index] = cell
  }
}

/**
 * Bytes that bring the terminal from `previous` to `next`.
 *
 * Without a previous grid, or when the size changed, the screen is cleared and every cell that
 * differs from a blank is written. Otherwise only changed cells are written. The whole update is
 * wrapped in a synchronized update with autowrap off, and ends by placing the cursor.
 * @param previous - what the terminal currently shows, or undefined when unknown.
 * @param next - what it should show.
 * @param cursor - where the input cursor goes once the frame is drawn; undefined keeps it hidden.
 * @returns the escape sequence to write.
 */
export function paintScreen(previous: ScreenBuffer | undefined, next: ScreenBuffer, cursor: ScreenCursor | undefined): string {
  const known = previous !== undefined && previous.width === next.width && previous.height === next.height
  const base = known ? previous : new ScreenBuffer(next.width, next.height)
  const out: string[] = [SYNC_BEGIN, `${CSI}?25l`, AUTOWRAP_OFF]
  // Clearing uses the current background, so reset the style before the clear.
  if (!known) out.push(`${CSI}0m${CSI}H${CSI}2J`)
  out.push(diffScreens(base, next))
  out.push(AUTOWRAP_ON)
  if (cursor !== undefined) {
    const row = Math.min(next.height, Math.max(1, cursor.row))
    const column = Math.min(next.width, Math.max(1, cursor.column))
    out.push(`${CSI}${String(row)};${String(column)}H`, `${CSI}?25h`)
  }
  out.push(SYNC_END)
  return out.join('')
}

/**
 * Cell updates from one grid to another of the same size.
 * @param previous - the grid the terminal shows.
 * @param next - the grid it should show.
 * @returns cursor moves, style changes, and glyphs; style and link are reset at the end.
 */
export function diffScreens(previous: ScreenBuffer, next: ScreenBuffer): string {
  let out = ''
  let sgr = ''
  let link: string | undefined
  let cursorX = -1
  let cursorY = -1
  for (let y = 0; y < next.height; y += 1) {
    for (let x = 0; x < next.width; x += 1) {
      const cell = next.cell(x, y)
      // The leader paints both halves of a wide glyph.
      if (cell.width === 0) continue
      if (sameCell(cell, previous.cell(x, y))) continue
      if (cursorX !== x || cursorY !== y) out += `${CSI}${String(y + 1)};${String(x + 1)}H`
      if (cell.sgr !== sgr) {
        out += cell.sgr === '' ? `${CSI}0m` : `${CSI}0;${cell.sgr}m`
        sgr = cell.sgr
      }
      if (cell.link !== link) {
        out += cell.link === undefined ? OSC8_CLOSE : `\u001b]8;;${cell.link}\u001b\\`
        link = cell.link
      }
      out += cell.symbol
      cursorX = x + cell.width
      cursorY = y
    }
  }
  if (link !== undefined) out += OSC8_CLOSE
  if (sgr !== '') out += `${CSI}0m`
  return out
}

function sameCell(a: Cell, b: Cell): boolean {
  return a.symbol === b.symbol && a.width === b.width && a.sgr === b.sgr && a.link === b.link
}

type Escape =
  | { readonly kind: 'sgr'; readonly params: readonly string[]; readonly end: number }
  | { readonly kind: 'link'; readonly target: string; readonly end: number }
  | { readonly kind: 'other'; readonly end: number }

/**
 * Read one escape sequence starting at `start`.
 * @param text - the row text.
 * @param start - index of the ESC byte.
 * @returns what the sequence does and where it ends; unknown or truncated sequences are skipped.
 */
function parseEscape(text: string, start: number): Escape {
  const kind = text[start + 1]
  if (kind === '[') {
    let end = start + 2
    while (end < text.length && !/[@-~]/u.test(text[end] ?? '')) end += 1
    const final = text[end]
    const body = text.slice(start + 2, end)
    end = Math.min(text.length, end + 1)
    if (final === 'm' && /^[\d;:]*$/u.test(body)) return { kind: 'sgr', params: body === '' ? ['0'] : body.split(/[;:]/u), end }
    return { kind: 'other', end }
  }
  if (kind === ']') {
    let end = start + 2
    let terminator = 0
    while (end < text.length) {
      if (text[end] === '\u0007') {
        terminator = 1
        break
      }
      if (text[end] === '\u001b' && text[end + 1] === '\\') {
        terminator = 2
        break
      }
      end += 1
    }
    const body = text.slice(start + 2, end)
    end = Math.min(text.length, end + terminator)
    const match = /^8;[^;]*;(.*)$/su.exec(body)
    if (match !== null) return { kind: 'link', target: match[1] ?? '', end }
    return { kind: 'other', end }
  }
  // A two-byte escape such as ESC 7; skip both bytes so neither is drawn.
  return { kind: 'other', end: Math.min(text.length, start + 2) }
}

function applySgr(style: CellStyle, params: readonly string[]): CellStyle {
  let next: { -readonly [K in keyof CellStyle]: CellStyle[K] } = { ...style }
  for (let index = 0; index < params.length; index += 1) {
    const code = Number(params[index] ?? '0')
    if (code === 0) next = { ...PLAIN }
    else if (code === 1) next.bold = true
    else if (code === 2) next.dim = true
    else if (code === 3) next.italic = true
    else if (code === 4) next.underline = true
    else if (code === 7) next.inverse = true
    else if (code === 9) next.strike = true
    else if (code === 22) {
      next.bold = false
      next.dim = false
    } else if (code === 23) next.italic = false
    else if (code === 24) next.underline = false
    else if (code === 27) next.inverse = false
    else if (code === 29) next.strike = false
    else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) next.fg = String(code)
    else if (code === 39) next.fg = undefined
    else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) next.bg = String(code)
    else if (code === 49) next.bg = undefined
    else if (code === 38 || code === 48) {
      const mode = params[index + 1]
      const take = mode === '5' ? 2 : mode === '2' ? 4 : 0
      if (take === 0) break
      const color = [String(code), ...params.slice(index + 1, index + 1 + take)].join(';')
      if (code === 38) next.fg = color
      else next.bg = color
      index += take
    }
  }
  return next
}

function styleSgr(style: CellStyle): string {
  const params: string[] = []
  if (style.bold) params.push('1')
  if (style.dim) params.push('2')
  if (style.italic) params.push('3')
  if (style.underline) params.push('4')
  if (style.inverse) params.push('7')
  if (style.strike) params.push('9')
  if (style.fg !== undefined) params.push(style.fg)
  if (style.bg !== undefined) params.push(style.bg)
  return params.join(';')
}
