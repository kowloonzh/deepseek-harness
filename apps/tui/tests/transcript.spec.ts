/** Public Session event and assistant-stream projection. */

import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { LlmAttemptId, MessageId } from '@deepseek-ai/dsh-llm/types'
import type { SessionState } from '@deepseek-ai/dsh-api-session-controller/types'
import type {
  SessionFollowFrame,
  SessionId,
  SessionSummary,
} from '@deepseek-ai/dsh-api-remotes/client'
import {
  applyFollowFrame,
  applyControlFrame,
  applySessionState,
  applySummary,
  initialTranscript,
  steerResend,
} from '../src/transcript.ts'

const sessionId = brandString<SessionId>('session-test')

describe('terminal transcript projection', () => {
  it('updates the model and token counters from the live control stream', () => {
    const state = { ...initialTranscript(), sessionId }
    const next = applyControlFrame(state, {
      type: 'projection', sessionId, seq: 2,
      changes: [
        { key: 'modelSelection', val: { next: { provider: 'p', model: 'live-model', reasoningEffort: 'high' }, lastUsed: null } },
        { key: 'tokenUsage', val: { uncachedInputTokens: 7, outputTokens: 3, cacheReadTokens: 2 } },
        { key: 'contextPressure', val: { pressureTokens: 400, projectedTokens: 500, contextWindow: 1000 } },
        { key: 'contextBreakdown', val: { systemTokens: 100, toolsTokens: 200, messageTokens: 200 } },
        { key: 'permissions', val: { currentValue: 'workspace-write' } },
        { key: 'conversationContinuation', val: 9 },
      ],
    })
    expect(next.model).toEqual({ provider: 'p', model: 'live-model', reasoningEffort: 'high' })
    expect(next.tokens).toEqual({ input: 7, output: 3, cacheRead: 2, cacheWrite: 0 })
    expect(next.context).toEqual({
      pressureTokens: 400, projectedTokens: 500, contextWindow: 1000,
      systemTokens: 100, toolsTokens: 200, messageTokens: 200,
    })
    expect(next.permission).toBe('workspace-write')
    expect(next.retryAvailable).toBe(true)
    expect(applyControlFrame(next, {
      type: 'projection', sessionId: brandString<SessionId>('other-session'), seq: 4,
      changes: [{ key: 'modelSelection', val: null }],
    })).toBe(next)
  })

  it('projects live queue rows and completion state from Session state', () => {
    const state = { ...initialTranscript(), sessionId }
    const next = applySessionState(state, {
      cursor: 4, active: true, running: true, pendingInput: [],
      queue: [
        {
          id: brandString<MessageId>('queued-1'), placement: 'queued',
          content: [{ type: 'text', text: 'later' }],
        },
        {
          id: brandString<MessageId>('steer-1'), placement: 'steering',
          content: [{ type: 'image', attachment: { name: 'shot.png' } }],
        },
      ],
    } satisfies SessionState)
    expect(next.running).toBe(true)
    expect(next.queue).toEqual([
      { id: 'queued-1', placement: 'queued', text: 'later', imageCount: 0, fileCount: 0, editable: true },
      { id: 'steer-1', placement: 'steering', text: '[Image] shot.png', imageCount: 1, fileCount: 0, editable: false },
    ])
  })

  it('projects cached title, model, and token usage from a Session summary', () => {
    const summary = {
      sessionId,
      updatedAt: 1,
      running: false,
      blank: false,
      cwd: '/work',
      projections: {
        kind: 'cached',
        asOfSeq: 3,
        values: {
          title: 'Fix tests',
          modelSelection: { next: { provider: 'deepseek', model: 'deepseek-chat' } },
          tokenUsage: { uncachedInputTokens: 12, outputTokens: 4, cacheReadTokens: 8 },
        },
      },
    } satisfies SessionSummary
    const state = applySummary(initialTranscript(), summary)
    expect(state.title).toBe('Fix tests')
    expect(state.model).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(state.tokens).toEqual({ input: 12, output: 4, cacheRead: 8, cacheWrite: 0 })
  })

  it('renders user, assistant, reasoning, and tool events', () => {
    let state = initialTranscript()
    state = applyFollowFrame(state, {
      type: 'event',
      event: {
        type: 'user/message',
        seq: 1,
        time: 1,
        data: {
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'hello' }],
        },
      },
    })
    state = applyFollowFrame(state, {
      type: 'event',
      event: {
        type: 'tool/call',
        seq: 2,
        time: 2,
        data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"cmd":"pwd"}' },
      },
    })
    state = applyFollowFrame(state, {
      type: 'event',
      event: {
        type: 'tool/result',
        seq: 3,
        time: 3,
        data: {
          turn: 1,
          step: 1,
          message: {
            role: 'tool',
            source: { callId: 'call-1' },
            content: [{ type: 'text', text: '/work' }],
          },
        },
      },
    })
    state = applyFollowFrame(state, {
      type: 'event',
      event: {
        type: 'assistant/message',
        seq: 4,
        time: 4,
        data: {
          turn: 1,
          step: 1,
          message: {
            role: 'assistant',
            content: [
              { type: 'reasoning', text: 'checking' },
              { type: 'text', text: 'done' },
            ],
          },
        },
      },
    })
    expect(state.items.map(item => [item.kind, item.text, item.detail])).toEqual([
      ['user', 'hello', undefined],
      ['tool', '/work', '/work'],
      ['reasoning', 'checking', undefined],
      ['assistant', 'done', undefined],
    ])
    expect(state.items[1]).toMatchObject({
      toolStatus: 'ok',
      toolArguments: '{"cmd":"pwd"}',
      toolOutput: '/work',
    })
  })

  it('shows a running tool call and preserves its failed result', () => {
    let state = applyFollowFrame(initialTranscript(), {
      type: 'event',
      event: {
        type: 'tool/call', seq: 1, time: 1,
        data: { turn: 1, step: 1, callId: 'call-fail', name: 'bash', arguments: '{"command":"false"}' },
      },
    })
    expect(state.items[0]).toMatchObject({
      kind: 'tool',
      text: 'command: false',
      toolStatus: 'running',
      toolArguments: '{"command":"false"}',
    })
    state = applyFollowFrame(state, {
      type: 'event',
      event: {
        type: 'tool/result', seq: 2, time: 2,
        data: {
          turn: 1, step: 1,
          message: {
            role: 'tool', isError: true, source: { callId: 'call-fail' },
            content: [{ type: 'text', text: 'permission denied\nexit 1' }],
          },
        },
      },
    })
    expect(state.items[0]).toMatchObject({
      kind: 'tool',
      text: 'permission denied',
      toolStatus: 'error',
      toolOutput: 'permission denied\nexit 1',
    })
  })

  it('keeps image-only user messages visible as attachment markers', () => {
    const state = applyFollowFrame(initialTranscript(), {
      type: 'event',
      event: {
        type: 'user/message',
        seq: 1,
        time: 1,
        data: {
          role: 'user',
          source: { kind: 'user' },
          content: [{
            type: 'image',
            attachment: {
              attachmentId: 'image-1',
              mediaType: 'image/png',
              bytes: 1,
              width: 1,
              height: 1,
              name: 'shot.png',
            },
          }],
        },
      },
    })
    expect(state.items).toEqual([{
      id: 'user-1',
      kind: 'user',
      text: '[Image 1] shot.png',
      forkSeq: 0,
    }])
  })

  it('accumulates live assistant deltas and clears them at settlement', () => {
    let state = initialTranscript()
    state = applyFollowFrame(state, {
      type: 'assistant-stream',
      frame: {
        type: 'chunk',
        attemptId: brandString<LlmAttemptId>('attempt-1'),
        revision: 1,
        index: 0,
        time: 1,
        chunk: { type: 'text-delta', text: 'hel' },
      },
    })
    state = applyFollowFrame(state, {
      type: 'assistant-stream',
      frame: {
        type: 'chunk',
        attemptId: brandString<LlmAttemptId>('attempt-1'),
        revision: 1,
        index: 1,
        time: 2,
        chunk: { type: 'text-delta', text: 'lo' },
      },
    })
    expect(state.items.at(-1)).toMatchObject({ kind: 'assistant', text: 'hello', transient: true })
    state = applyFollowFrame(state, {
      type: 'event',
      event: {
        type: 'assistant/message',
        seq: 5,
        time: 5,
        data: {
          turn: 1,
          step: 1,
          message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        },
      },
    })
    expect(state.items).toEqual([{ id: 'assistant-5', kind: 'assistant', text: 'hello' }])
  })

  it('resets history and status from a snapshot', () => {
    const frame = {
      type: 'snapshot',
      header: { version: 4, id: sessionId, createdAt: 1, cwd: '/work', isSeeded: false },
      cursor: 1,
      records: [{
        type: 'event',
        event: {
          type: 'user/message',
          seq: 1,
          time: 1,
          data: {
            role: 'user',
            source: { kind: 'user' },
            content: [{ type: 'text', text: 'restored' }],
          },
        },
      }],
      hasMore: false,
      projections: { asOfSeq: 1, values: { title: 'Restored' } },
    } satisfies Extract<SessionFollowFrame, { type: 'snapshot' }>
    const state = applyFollowFrame(initialTranscript(), frame)
    expect(state.title).toBe('Restored')
    expect(state.items).toEqual([{ id: 'user-1', kind: 'user', text: 'restored', forkSeq: 0 }])
  })
  it('keeps a Worked for marker above the final answer of a turn that ran tools', () => {
    const events: Array<{ type: string; time: number; data: unknown }> = [
      { type: 'turn/start', time: 1_000, data: { turn: 1 } },
      { type: 'tool/call', time: 2_000, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' } },
      { type: 'tool/result', time: 3_000, data: { turn: 1, step: 1, message: { role: 'tool', source: { callId: 'c1' }, content: [{ type: 'text', text: 'a' }] } } },
      { type: 'assistant/message', time: 4_000, data: { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } } },
      { type: 'turn/end', time: 66_000, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', time: 70_000, data: { turn: 2 } },
      { type: 'assistant/message', time: 71_000, data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } } },
      { type: 'turn/end', time: 72_000, data: { turn: 2, reason: { kind: 'completed' } } },
    ]
    let state = initialTranscript()
    for (const [seq, event] of events.entries()) {
      state = applyFollowFrame(state, { type: 'event', event: { ...event, seq: seq + 1 } } as never)
    }
    // Only the turn with tools keeps its marker, placed between the work and the answer.
    expect(state.items.map(item => item.kind)).toEqual(['tool', 'turn', 'assistant', 'assistant'])
    expect(state.items[1]).toMatchObject({ kind: 'turn', elapsedMs: 65_000 })
  })
  it('appends a tool result whose call is missing instead of replacing the transcript', () => {
    let state = applyFollowFrame(initialTranscript(), {
      type: 'event',
      event: { type: 'user/message', seq: 1, time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] } },
    } as never)
    state = applyFollowFrame(state, {
      type: 'event',
      event: {
        type: 'tool/result', seq: 2, time: 2,
        data: { message: { role: 'tool', source: { callId: 'gone' }, content: [{ type: 'text', text: 'orphan' }] } },
      },
    } as never)
    expect(state.items.map(item => item.kind)).toEqual(['user', 'tool'])
    expect(state.items[0]).toMatchObject({ text: 'hello' })
    expect(state.items[1]).toMatchObject({ id: 'tool-result-2', toolOutput: 'orphan', toolStatus: 'ok' })
  })
  it('records where a fork restarts from each user message', () => {
    const events: Array<{ type: string; seq: number; data: unknown }> = [
      { type: 'turn/start', seq: 5, data: { turn: 1 } },
      { type: 'user/message', seq: 6, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'first' }] } },
      { type: 'user/message', seq: 9, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'steer' }] } },
    ]
    let state = initialTranscript()
    for (const event of events) state = applyFollowFrame(state, { type: 'event', event: { ...event, time: event.seq } } as never)
    // The turn's first message cuts before its turn/start; a steer cuts just before itself.
    expect(state.items.filter(item => item.kind === 'user').map(item => item.forkSeq)).toEqual([4, 8])
  })
  it('resends unread steers merged after an interrupt, unless it cannot do so faithfully', () => {
    const prompt = (id: string, placement: 'queued' | 'steering' | 'context', text: string, editable = true) => ({
      id, placement, text, imageCount: editable ? 0 : 1, fileCount: 0, editable,
    })
    expect(steerResend([])).toEqual({ kind: 'none' })
    expect(steerResend([prompt('c', 'context', 'runtime')])).toEqual({ kind: 'none' })
    const first = prompt('a', 'steering', ' first ')
    const second = prompt('b', 'steering', 'second')
    expect(steerResend([first, prompt('c', 'context', 'runtime'), second]))
      .toEqual({ kind: 'send', items: [first, second], text: 'first\n\nsecond' })
    // A resend would join the back of the queue, after a message already queued.
    expect(steerResend([prompt('q', 'queued', 'later'), first])).toEqual({ kind: 'behind-queue' })
    // Only the text of a pending message is known, so an attachment would be dropped.
    expect(steerResend([first, prompt('i', 'steering', 'shot', false)])).toEqual({ kind: 'attachments' })
  })

  it('leaves the TUI\'s own suggestion command out of the transcript', () => {
    const event = (seq: number, type: string, data: unknown): SessionFollowFrame =>
      ({ type: 'event', event: { type, seq, time: seq, data } }) as unknown as SessionFollowFrame
    let state = { ...initialTranscript(), sessionId }
    for (const frame of [
      event(1, 'command/run', { commandId: 'cmd-1', name: 'tui-next-prompt', source: 'user' }),
      event(2, 'command/done', { commandId: 'cmd-1', kind: 'success', text: 'sort them' }),
      event(3, 'command/run', { commandId: 'cmd-2', name: 'status', source: 'user' }),
      event(4, 'command/done', { commandId: 'cmd-2', kind: 'success', text: 'all good' }),
    ]) state = applyFollowFrame(state, frame)
    expect(state.items.map(item => item.text)).toEqual(['all good'])
  })
})
