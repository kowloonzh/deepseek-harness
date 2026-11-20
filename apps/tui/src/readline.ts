/** Readline-style multiline editor state for the terminal prompt. */

const MAX_KILL_RING_ENTRIES = 10

interface YankState {
  readonly start: number
  readonly length: number
  readonly index: number
}

/**
 * Mutable prompt editor with Emacs/readline kill-and-yank behavior.
 *
 * Cursor positions count Unicode code points, not UTF-16 code units.
 */
export class ReadlineEditor {
  private value: string
  private index: number
  private ring: string[] = []
  private yankState: YankState | undefined

  /**
   * @param initial - initial prompt text; the cursor starts at its end.
   */
  constructor(initial = '') {
    this.value = initial
    this.index = chars(initial).length
  }

  /** Current prompt text. */
  get text(): string {
    return this.value
  }

  /** Current cursor position in Unicode code points. */
  get cursor(): number {
    return this.index
  }

  /** Most recent kills, newest first. */
  get killRing(): readonly string[] {
    return this.ring
  }

  /**
   * Replace the complete prompt and place the cursor at its end.
   * @param value - replacement text.
   */
  setText(value: string): void {
    this.value = value
    this.index = chars(value).length
    this.yankState = undefined
  }

  /** Clear the prompt and reset transient yank state. */
  clear(): void {
    this.setText('')
  }

  /**
   * Insert text at the cursor.
   * @param value - text, including newlines, to insert.
   */
  insert(value: string): void {
    if (value === '') return
    const current = chars(this.value)
    const inserted = chars(value)
    current.splice(this.index, 0, ...inserted)
    this.value = current.join('')
    this.index += inserted.length
    this.yankState = undefined
  }

  /** Move one code point left. */
  moveLeft(): void {
    this.index = Math.max(0, this.index - 1)
    this.yankState = undefined
  }

  /** Move one code point right. */
  moveRight(): void {
    this.index = Math.min(chars(this.value).length, this.index + 1)
    this.yankState = undefined
  }

  /** Move to the start of the current logical line. */
  moveLineStart(): void {
    const current = chars(this.value)
    let index = this.index
    while (index > 0 && current[index - 1] !== '\n') index -= 1
    this.index = index
    this.yankState = undefined
  }

  /** Move to the end of the current logical line. */
  moveLineEnd(): void {
    const current = chars(this.value)
    let index = this.index
    while (index < current.length && current[index] !== '\n') index += 1
    this.index = index
    this.yankState = undefined
  }

  /** Move to the start of the previous word. */
  moveWordLeft(): void {
    const current = chars(this.value)
    let index = this.index
    while (index > 0 && isWhitespace(current[index - 1])) index -= 1
    while (index > 0 && !isWhitespace(current[index - 1])) index -= 1
    this.index = index
    this.yankState = undefined
  }

  /** Move to the end of the next word. */
  moveWordRight(): void {
    const current = chars(this.value)
    let index = this.index
    while (index < current.length && isWhitespace(current[index])) index += 1
    while (index < current.length && !isWhitespace(current[index])) index += 1
    this.index = index
    this.yankState = undefined
  }

  /** Delete one code point before the cursor. */
  deleteBackward(): void {
    if (this.index === 0) return
    const current = chars(this.value)
    current.splice(this.index - 1, 1)
    this.value = current.join('')
    this.index -= 1
    this.yankState = undefined
  }

  /** Delete one code point at the cursor. */
  deleteForward(): void {
    const current = chars(this.value)
    if (this.index >= current.length) return
    current.splice(this.index, 1)
    this.value = current.join('')
    this.yankState = undefined
  }

  /** Kill from the cursor to the start of the current line. */
  killToLineStart(): void {
    const current = chars(this.value)
    let start = this.index
    while (start > 0 && current[start - 1] !== '\n') start -= 1
    this.kill(start, this.index)
  }

  /** Kill from the cursor to the end of the current line. */
  killToLineEnd(): void {
    const current = chars(this.value)
    let end = this.index
    while (end < current.length && current[end] !== '\n') end += 1
    this.kill(this.index, end)
  }

  /** Kill the previous word, matching readline's backward-word boundary. */
  killWordBackward(): void {
    const current = chars(this.value)
    let start = this.index
    while (start > 0 && isWhitespace(current[start - 1])) start -= 1
    while (start > 0 && !isWhitespace(current[start - 1])) start -= 1
    this.kill(start, this.index)
  }

  /** Kill the next word, matching readline's forward-word boundary. */
  killWordForward(): void {
    const current = chars(this.value)
    let end = this.index
    while (end < current.length && isWhitespace(current[end])) end += 1
    while (end < current.length && !isWhitespace(current[end])) end += 1
    this.kill(this.index, end)
  }

  /** Insert the newest kill-ring entry at the cursor. */
  yank(): void {
    const value = this.ring[0]
    if (value === undefined) return
    const current = chars(this.value)
    const inserted = chars(value)
    const start = this.index
    current.splice(start, 0, ...inserted)
    this.value = current.join('')
    this.index += inserted.length
    this.yankState = { start, length: inserted.length, index: 0 }
  }

  /** Replace the most recent yank with the next older kill-ring entry. */
  yankPop(): void {
    const previous = this.yankState
    if (previous === undefined || this.ring.length <= 1) return
    const index = (previous.index + 1) % this.ring.length
    const value = this.ring[index]
    if (value === undefined) return
    const current = chars(this.value)
    const replacement = chars(value)
    current.splice(previous.start, previous.length, ...replacement)
    this.value = current.join('')
    this.index = previous.start + replacement.length
    this.yankState = { start: previous.start, length: replacement.length, index }
  }

  private kill(start: number, end: number): void {
    if (start === end) {
      this.yankState = undefined
      return
    }
    const current = chars(this.value)
    const killed = current.slice(start, end).join('')
    current.splice(start, end - start)
    this.value = current.join('')
    this.index = start
    this.yankState = undefined
    this.ring.unshift(killed)
    this.ring.length = Math.min(this.ring.length, MAX_KILL_RING_ENTRIES)
  }
}

function chars(value: string): string[] {
  return Array.from(value)
}

function isWhitespace(value: string | undefined): boolean {
  return value !== undefined && /\s/u.test(value)
}
