/**
 * A headless terminal emulator for asserting what the operator actually sees.
 *
 * Frames are cell diffs, so the bytes written for one frame hold only what changed: a word the
 * previous frame already showed may never appear in the output again. Tests that care about the
 * screen feed those bytes through xterm.js and read its grid instead.
 *
 * `@xterm/headless` is resolved through a workspace package that already depends on it, so the
 * TUI borrows it for tests without adding a dependency of its own (and a lockfile change that
 * would conflict with upstream).
 */

import { createRequire } from 'node:module'
import { resolve } from 'node:path'

interface XtermLine {
  translateToString(trimRight?: boolean): string
  getCell(x: number): { getChars(): string; getWidth(): number; isInverse(): number } | undefined
}

interface XtermTerminal {
  readonly rows: number
  readonly cols: number
  readonly buffer: { readonly active: { readonly cursorX: number; readonly cursorY: number; getLine(y: number): XtermLine | undefined } }
  write(data: string | Uint8Array, callback?: () => void): void
  resize(columns: number, rows: number): void
  dispose(): void
}

const require = createRequire(resolve(import.meta.dirname, '../../../packages/terminal/terminal-bash/package.json'))
const { Terminal } = require('@xterm/headless') as {
  Terminal: new (options: { cols: number; rows: number; allowProposedApi: boolean; scrollback: number }) => XtermTerminal
}

/** One emulated terminal screen. */
export class EmulatedTerminal {
  private readonly terminal: XtermTerminal

  constructor(columns: number, rows: number) {
    this.terminal = new Terminal({ cols: columns, rows, allowProposedApi: true, scrollback: 0 })
  }

  /**
   * Feed bytes and wait until the emulator has processed them.
   * @param data - terminal output.
   */
  async write(data: string | Uint8Array): Promise<void> {
    await new Promise<void>((resolveWrite) => {
      this.terminal.write(data, resolveWrite)
    })
  }

  /**
   * Rows the screen shows, top to bottom.
   *
   * Trailing blanks are removed whether they were never written or written as spaces: both look
   * the same, and a diff legitimately blanks old text by writing spaces over it.
   * @returns each row's text with trailing blanks removed.
   */
  rows(): string[] {
    return Array.from({ length: this.terminal.rows }, (_, y) => (this.terminal.buffer.active.getLine(y)?.translateToString(true) ?? '').trimEnd())
  }

  /**
   * The screen as one string, rows joined with newlines.
   * @returns the visible text.
   */
  text(): string {
    return this.rows().join('\n')
  }

  /**
   * Zero-based cursor position.
   * @returns column and row.
   */
  cursor(): { readonly x: number; readonly y: number } {
    return { x: this.terminal.buffer.active.cursorX, y: this.terminal.buffer.active.cursorY }
  }

  /**
   * Whether a cell is drawn in reverse video.
   * @param x - zero-based column.
   * @param y - zero-based row.
   * @returns true for an inverse cell.
   */
  inverse(x: number, y: number): boolean {
    return (this.terminal.buffer.active.getLine(y)?.getCell(x)?.isInverse() ?? 0) !== 0
  }

  resize(columns: number, rows: number): void {
    this.terminal.resize(columns, rows)
  }

  dispose(): void {
    this.terminal.dispose()
  }
}
