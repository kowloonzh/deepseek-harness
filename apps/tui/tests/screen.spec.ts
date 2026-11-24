/** The cell grid keeps every row inside its own cells, and its diffs reproduce full paints. */

import { describe, expect, it } from 'vitest'
import { diffScreens, paintScreen, ScreenBuffer } from '../src/screen.ts'
import { EmulatedTerminal } from './terminal.ts'

const HOME = { row: 1, column: 1 }

async function show(width: number, height: number, lines: readonly string[]): Promise<EmulatedTerminal> {
  const terminal = new EmulatedTerminal(width, height)
  await terminal.write(paintScreen(undefined, ScreenBuffer.fromLines(width, height, lines), HOME))
  return terminal
}

describe('screen buffer', () => {
  it('clips a row at the right margin instead of folding it onto the next row', async () => {
    const terminal = await show(6, 3, ['abcdefghij', 'second'])
    expect(terminal.rows()).toEqual(['abcdef', 'second', ''])
  })

  it('drops rows past the bottom instead of scrolling the screen', async () => {
    const terminal = await show(10, 2, ['one', 'two', 'three'])
    expect(terminal.rows()).toEqual(['one', 'two'])
  })

  it('blanks a double-width glyph that would straddle the margin', async () => {
    // 5 columns: `ab中` fills 4, the next wide glyph has one cell left and cannot fit.
    const screen = ScreenBuffer.fromLines(5, 2, ['ab中中', 'next'])
    expect(screen.rowText(0)).toBe('ab中')
    expect(screen.cell(4, 0).symbol).toBe(' ')
    const terminal = await show(5, 2, ['ab中中', 'next'])
    expect(terminal.rows()).toEqual(['ab中', 'next'])
  })

  it('keeps a wide glyph as a leader and a continuation cell', () => {
    const screen = ScreenBuffer.fromLines(6, 1, ['中文x'])
    expect(screen.cell(0, 0)).toMatchObject({ symbol: '中', width: 2 })
    expect(screen.cell(1, 0)).toMatchObject({ symbol: '', width: 0 })
    expect(screen.cell(4, 0)).toMatchObject({ symbol: 'x', width: 1 })
  })

  it('drops control characters and non-SGR escapes', async () => {
    const terminal = await show(20, 3, ['a\rb\u0007c\u001b[2Jd\u001b[5;5He', 'kept'])
    expect(terminal.rows()).toEqual(['abcde', 'kept', ''])
  })

  it('carries SGR styling and closes hyperlinks', async () => {
    const screen = ScreenBuffer.fromLines(20, 1, ['\u001b[7mon\u001b[27m off \u001b]8;;https://x.test\u001b\\link\u001b]8;;\u001b\\'])
    expect(screen.cell(0, 0).sgr).toBe('7')
    expect(screen.cell(3, 0).sgr).toBe('')
    expect(screen.cell(7, 0).link).toBe('https://x.test')
    expect(screen.cell(11, 0).link).toBeUndefined()
    const paint = paintScreen(undefined, screen, HOME)
    expect(paint).toContain('\u001b]8;;https://x.test\u001b\\link\u001b]8;;\u001b\\')
    const terminal = new EmulatedTerminal(20, 1)
    await terminal.write(paint)
    expect(terminal.inverse(0, 0)).toBe(true)
    expect(terminal.inverse(3, 0)).toBe(false)
  })

  it('writes nothing when the screen did not change', () => {
    const screen = ScreenBuffer.fromLines(10, 2, ['same', '中文'])
    expect(diffScreens(screen, ScreenBuffer.fromLines(10, 2, ['same', '中文']))).toBe('')
  })

  it('blanks the orphaned half when a narrow glyph overwrites a wide one', () => {
    const screen = ScreenBuffer.fromLines(6, 1, ['中文'])
    screen.writeAnsi(1, 0, 'x')
    expect(screen.rowText(0)).toBe(' x文')
  })

  it('wraps each paint in a synchronized update and places the cursor', () => {
    const paint = paintScreen(undefined, ScreenBuffer.fromLines(10, 4, ['a']), { row: 3, column: 5 })
    expect(paint.startsWith('\u001b[?2026h')).toBe(true)
    expect(paint.endsWith('\u001b[3;5H\u001b[?25h\u001b[?2026l')).toBe(true)
  })

  it('reproduces a full repaint at every step of a random incremental sequence', async () => {
    // Mixed widths and styles shift glyph boundaries between frames, which is where a cell diff
    // can leave half a wide glyph or a stale style behind.
    let seed = 7
    const random = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed / 2_147_483_648
    }
    const pieces = ['a', 'bc', '中', '文字', ' ', '\u001b[7m', '\u001b[0m', '\u001b[1;31m', '\u001b[48;5;238m', '─']
    const row = (): string => Array.from({ length: Math.floor(random() * 14) }, () => pieces[Math.floor(random() * pieces.length)]).join('')
    const width = 13
    const height = 5
    const incremental = new EmulatedTerminal(width, height)
    let previous: ScreenBuffer | undefined
    const offenders: string[] = []
    for (let step = 0; step < 200; step += 1) {
      const lines = Array.from({ length: height }, row)
      const next = ScreenBuffer.fromLines(width, height, lines)
      await incremental.write(paintScreen(previous, next, HOME))
      previous = next
      const full = await show(width, height, lines)
      if (incremental.text() !== full.text()) offenders.push(`step ${String(step)}: ${JSON.stringify(lines)}`)
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          if (incremental.inverse(x, y) !== full.inverse(x, y)) offenders.push(`step ${String(step)}: inverse at ${String(x)},${String(y)}`)
        }
      }
      full.dispose()
      if (offenders.length > 0) break
    }
    expect(offenders).toEqual([])
  })
})
