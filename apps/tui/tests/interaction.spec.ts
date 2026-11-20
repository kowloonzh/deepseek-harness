/** Approval and structured-question interaction state. */

import { describe, expect, it, vi } from 'vitest'
import { commitQuestionAnswer, createQuestionPrompt } from '../src/app.ts'
import type { QuestionUiRequest } from '../src/ui.ts'

describe('question overlay', () => {
  it('collects single-select, multi-select, and custom answers across a batch', () => {
    const request: QuestionUiRequest = {
      questions: [
        {
          id: 'q1',
          question: 'Pick one',
          options: [{ label: 'A' }, { label: 'B' }],
        },
        {
          id: 'q2',
          question: 'Pick many',
          multiSelect: true,
          options: [{ label: 'C' }, { label: 'D' }],
        },
        {
          id: 'q3',
          question: 'Explain',
        },
      ],
    }
    const resolve = vi.fn()
    const prompt = createQuestionPrompt(request, resolve, vi.fn())

    prompt.progress[0]?.selected.add('B')
    expect(commitQuestionAnswer(prompt)).toBe(false)

    prompt.progress[1]?.selected.add('C')
    prompt.progress[1]?.selected.add('D')
    expect(commitQuestionAnswer(prompt)).toBe(false)

    const custom = prompt.progress[2]
    expect(custom?.mode).toBe('custom')
    if (custom !== undefined) custom.custom = ' details '
    expect(commitQuestionAnswer(prompt)).toBe(true)

    expect(resolve).toHaveBeenCalledWith({
      answers: [
        { id: 'q1', selected: ['B'] },
        { id: 'q2', selected: ['C', 'D'] },
        { id: 'q3', selected: [], custom: 'details' },
      ],
    })
  })
})
