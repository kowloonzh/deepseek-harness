/** Window titles and desktop notifications written around the painted screen. */

import { describe, expect, it } from 'vitest'
import {
  notificationMethod,
  notificationSequence,
  terminalTitle,
  titleSequence,
  turnCompleteMessage,
} from '../src/terminal-signals.ts'

describe('terminal signals', () => {
  it('titles a session as codex does: spinner while running, action required when blocked', () => {
    const base = { running: false, actionRequired: false, sessionTitle: 'Fix wrap', cwd: '/work/dsh', frame: 0 }
    expect(terminalTitle(base)).toBe('Fix wrap | dsh')
    expect(terminalTitle({ ...base, running: true, frame: 1 })).toBe('⠙ Fix wrap | dsh')
    expect(terminalTitle({ ...base, running: true, actionRequired: true })).toBe('[ ! ] Action Required | Fix wrap | dsh')
    expect(terminalTitle({ ...base, sessionTitle: undefined })).toBe('dsh')
  })

  it('strips escapes from a title before writing it', () => {
    expect(titleSequence('a\u001b]0;evil\u0007 b​')).toBe('\u001b]0;a ]0;evil b\u0007')
    expect(titleSequence(' \u0007 ')).toBe('')
  })

  it('picks OSC 9 for terminals that show it, else the bell, and honours DSH_TUI_NOTIFY', () => {
    expect(notificationMethod({ TERM_PROGRAM: 'ghostty' })).toBe('osc9')
    expect(notificationMethod({ KITTY_WINDOW_ID: '1' })).toBe('osc9')
    expect(notificationMethod({ TERM: 'xterm-256color' })).toBe('bel')
    expect(notificationMethod({ TERM_PROGRAM: 'ghostty', DSH_TUI_NOTIFY: 'off' })).toBe('off')
  })

  it('writes notifications with control characters removed and tmux passthrough', () => {
    expect(notificationSequence('done\nnow', 'osc9', {})).toBe('\u001b]9;done now\u0007')
    expect(notificationSequence('a;b', 'osc777', {})).toBe('\u001b]777;notify;DSH;a；b\u001b\\')
    expect(notificationSequence('x', 'osc9', { TMUX: '/tmp/t' })).toBe('\u001bPtmux;\u001b\u001b]9;x\u0007\u001b\\')
    expect(notificationSequence('x', 'bel', {})).toBe('\u0007')
    expect(notificationSequence('x', 'off', {})).toBe('')
  })

  it('previews the final answer in a turn-complete notification', () => {
    expect(turnCompleteMessage('  Fixed\n\nthe  wrap ')).toBe('Fixed the wrap')
    expect(turnCompleteMessage(undefined)).toBe('Agent turn complete')
    expect(Array.from(turnCompleteMessage('字'.repeat(300)))).toHaveLength(200)
  })
})
