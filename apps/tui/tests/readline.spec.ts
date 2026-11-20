/** Readline-style prompt editing and kill/yank behavior. */

import { describe, expect, it } from 'vitest'
import { ReadlineEditor } from '../src/readline.ts'

describe('readline editor', () => {
  it('starts and restores history with the cursor at the code-point end', () => {
    const editor = new ReadlineEditor('a😀中')
    expect(editor.cursor).toBe(3)
    editor.setText('new text')
    expect(editor.cursor).toBe(8)
  })

  it('kills to line start and yanks it back', () => {
    const editor = new ReadlineEditor('first\nsecond line')
    editor.killToLineStart()
    expect(editor.text).toBe('first\n')
    expect(editor.killRing).toEqual(['second line'])
    editor.yank()
    expect(editor.text).toBe('first\nsecond line')
    expect(editor.cursor).toBe(17)
  })

  it('cycles kill-ring entries with yank-pop', () => {
    const editor = new ReadlineEditor('alpha beta')
    editor.killWordBackward()
    editor.killWordBackward()
    expect(editor.text).toBe('')
    editor.yank()
    expect(editor.text).toBe('alpha ')
    editor.yankPop()
    expect(editor.text).toBe('beta')
  })

  it('keeps line movement within one logical line of a multiline prompt', () => {
    const editor = new ReadlineEditor('one\ntwo')
    editor.moveLineStart()
    expect(editor.cursor).toBe(4)
    editor.moveLeft()
    expect(editor.cursor).toBe(3)
    editor.moveLineEnd()
    expect(editor.cursor).toBe(3)
  })
})
