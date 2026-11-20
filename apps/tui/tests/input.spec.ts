/** Raw terminal input decoding. */

import { describe, expect, it } from 'vitest'
import { buildPromptContent, decodeTerminalInput, parseTuiArguments } from '../src/app.ts'
import type { ClipboardImage } from '../src/clipboard.ts'

describe('raw terminal input', () => {
  it('decodes editor controls and navigation', () => {
    expect(decodeTerminalInput('abc\r\u001b[A\u007f\u000f\u0015\u0019\u000b\u0017\u0016')).toMatchObject([
      { sequence: 'abc' },
      { name: 'return' },
      { name: 'up' },
      { name: 'backspace' },
      { name: 'o', ctrl: true },
      { name: 'u', ctrl: true },
      { name: 'y', ctrl: true },
      { name: 'k', ctrl: true },
      { name: 'w', ctrl: true },
      { name: 'v', ctrl: true },
    ])
  })

  it('decodes newline and modified navigation without collapsing them into submit', () => {
    expect(decodeTerminalInput('a\nb\u001b[1;5C\u001bv')).toMatchObject([
      { sequence: 'a' },
      { name: 'return' },
      { sequence: 'b' },
      { name: 'right', ctrl: true },
      { name: 'v', meta: true },
    ])
  })

  it('decodes terminal variants of Shift+Enter as modified return', () => {
    expect(decodeTerminalInput('\u001b[13;2u\u001b[27;2;13~\u001b\r')).toMatchObject([
      { name: 'return', shift: true },
      { name: 'return', shift: true },
      { name: 'return', meta: true },
    ])
  })

  it('decodes enhanced-keyboard control chords used after enabling modified keys', () => {
    expect(decodeTerminalInput('\u001b[117;5u\u001b[121;5u\u001b[27;5;117~\u001b[106;5u')).toMatchObject([
      { name: 'u', ctrl: true },
      { name: 'y', ctrl: true },
      { name: 'u', ctrl: true },
      { name: 'return' },
    ])
  })

  it('decodes Alt+Up and Alt+R queue shortcuts', () => {
    expect(decodeTerminalInput('\u001b[1;3A\u001br')).toMatchObject([
      { name: 'up', meta: true },
      { name: 'r', meta: true },
    ])
  })

  it('separates mouse wheel from arrow-key history navigation', () => {
    expect(decodeTerminalInput('\u001b[<64;10;5M\u001b[<65;10;5M\u001b[<0;10;5M\u001b[<32;11;5M\u001b[<0;11;5m')).toEqual([
      { name: 'wheel-up' },
      { name: 'wheel-down' },
      { name: 'mouse', mouse: { action: 'down', button: 'left', column: 10, row: 5 } },
      { name: 'mouse', mouse: { action: 'drag', button: 'left', column: 11, row: 5 } },
      { name: 'mouse', mouse: { action: 'up', button: 'left', column: 11, row: 5 } },
    ])
  })

  it('keeps newlines inside bracketed paste', () => {
    expect(decodeTerminalInput('\u001b[200~a\nb\u001b[201~')).toMatchObject([
      { name: 'paste-start' },
      { sequence: 'a\nb' },
      { name: 'paste-end' },
    ])
  })

  it('parses resume variants', () => {
    expect(parseTuiArguments(['--resume'])).toEqual({ help: false, resume: true, prompt: undefined })
    expect(parseTuiArguments(['--resume', 'session-1']))
      .toEqual({ help: false, resume: 'session-1', prompt: undefined })
    expect(parseTuiArguments(['--resume=session-2']))
      .toEqual({ help: false, resume: 'session-2', prompt: undefined })
  })

  it('parses an initial prompt that may start with a dash', () => {
    expect(parseTuiArguments(['--prompt', 'do the thing']).prompt).toBe('do the thing')
    expect(parseTuiArguments(['-p', '--resume', 'is text']).prompt).toBe('--resume')
    expect(parseTuiArguments(['-p', 'task', '--resume=session-3']))
      .toEqual({ help: false, resume: 'session-3', prompt: 'task' })
    expect(parseTuiArguments([]).prompt).toBeUndefined()
  })

  it('orders prompt images before text for the Web prompt contract', () => {
    const image: ClipboardImage = {
      kind: 'image',
      mediaType: 'image/png',
      data: 'AAAA',
      bytes: 3,
      name: 'shot.png',
    }
    expect(buildPromptContent('inspect this', [image])).toEqual([
      { type: 'image', mediaType: 'image/png', data: 'AAAA', name: 'shot.png' },
      { type: 'text', text: 'inspect this' },
    ])
    expect(buildPromptContent('', [image])).toEqual([
      { type: 'image', mediaType: 'image/png', data: 'AAAA', name: 'shot.png' },
    ])
  })
})
