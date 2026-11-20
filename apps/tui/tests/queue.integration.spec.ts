/** Real Host queue projection and mutation through the public Remote contract. */

import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SessionState } from '@deepseek-ai/dsh-api-session-controller/types'
import { launchWebScaffold } from '../../web/tests/scaffold.ts'
import { normalizeEntryUrl } from '../src/host.ts'
import { TuiRemoteClient } from '../src/remote.ts'

describe('terminal queue integration', () => {
  it('observes, edits, and removes a pending live-Agent message', async () => {
    const host = await launchWebScaffold({
      replayFixture: resolve(import.meta.dirname, '../../../snapshots/web/live-interactions/session.v3.jsonl'),
      compareReplaySession: false,
    })
    const remote = await TuiRemoteClient.connect({
      ...normalizeEntryUrl(host.authenticatedUrl), close: async () => {},
    }, {
      approval: async () => 'rejected',
      question: async () => ({ answers: [] }),
    })
    const sessionId = await remote.createSession(host.workspaceCwd)
    const abort = new AbortController()
    const states = remote.observeState(sessionId, abort.signal)[Symbol.asyncIterator]()
    const settled = host.whenTurnSettled()
    try {
      await remote.prompt(sessionId, [{ type: 'text', text: 'Run the first turn.' }], 'queue')
      await nextState(states, state => state.running)
      await remote.prompt(sessionId, [{ type: 'text', text: 'queued later' }], 'queue')
      const queued = await nextState(states, state => state.queue?.some(item => textOf(item.content).includes('queued later')) === true)
      const item = queued.queue?.find(candidate => textOf(candidate.content).includes('queued later'))
      expect(item).toBeDefined()
      if (item === undefined) throw new Error('queued item was not projected')

      await remote.updateQueue(sessionId, String(item.id), {
        kind: 'edit', content: [{ type: 'text', text: 'queued edited' }],
      })
      await nextState(states, state => state.queue?.some(candidate => textOf(candidate.content).includes('queued edited')) === true)

      await remote.updateQueue(sessionId, String(item.id), { kind: 'remove' })
      await nextState(states, state => state.queue?.some(candidate => candidate.id === item.id) !== true)
      await settled
    } finally {
      abort.abort()
      await states.return?.()
      await remote.cancel(sessionId).catch(() => {})
      await remote.close()
      await host.close()
    }
  }, 60_000)
})

async function nextState(
  states: AsyncIterator<SessionState>,
  accept: (state: SessionState) => boolean,
): Promise<SessionState> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const result = await states.next()
    if (result.done) break
    if (accept(result.value)) return result.value
  }
  throw new Error('Session state did not reach the expected queue condition')
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.map((block) => {
    if (typeof block !== 'object' || block === null) return ''
    const value = block as Readonly<Record<string, unknown>>
    return value.type === 'text' && typeof value.text === 'string' ? value.text : ''
  }).join('\n')
}
