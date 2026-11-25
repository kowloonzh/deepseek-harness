/** The terminal opens before its host is up: input typed meanwhile is kept and sent. */

import { resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { launchWebScaffold } from '../../web/tests/scaffold.ts'
import { TuiApp } from '../src/app.ts'
import { normalizeEntryUrl } from '../src/host.ts'
import { TuiRemoteClient } from '../src/remote.ts'

function terminalStreams(): { input: PassThrough; stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream; output: PassThrough } {
  const input = new PassThrough()
  const output = new PassThrough()
  const stdin = input as NodeJS.ReadStream
  const stdout = output as NodeJS.WriteStream
  stdin.setRawMode = () => stdin
  stdout.rows = 24
  stdout.columns = 120
  return { input, stdin, stdout, output }
}

const plain = (lines: readonly string[]): string => lines.join('\n').replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')

describe('terminal startup', () => {
  it('paints the composer at once and sends a prompt entered before the host was up', async () => {
    const host = await launchWebScaffold({
      replayFixture: resolve(import.meta.dirname, '../../../snapshots/web/live-interactions/session.v3.jsonl'),
      compareReplaySession: false,
    })
    const { input, stdin, stdout, output } = terminalStreams()
    let app: TuiApp | undefined
    let connect: (remote: TuiRemoteClient) => void = () => {}
    const connecting = new Promise<TuiRemoteClient>((resolveConnect) => { connect = resolveConnect })
    const running = TuiApp.run({
      remote: connecting, hostClose: async () => {}, resume: undefined, stdin, stdout, env: {},
      onApp: (value) => { app = value },
    })
    const frame = (): string => plain(app?.screenLines() ?? [])
    try {
      await expect.poll(frame).toContain('Starting session...')
      expect(frame()).not.toContain('model: default')
      input.write('early words\r')
      await expect.poll(frame).toContain('sending queue: early words')

      const remote = await TuiRemoteClient.connect({
        ...normalizeEntryUrl(host.authenticatedUrl), close: async () => {},
      }, {
        approval: request => app?.requestApproval(request) ?? Promise.resolve('rejected'),
        question: request => app?.requestQuestion(request) ?? Promise.resolve({ answers: [] }),
        sessionStatus: (id, running) => { app?.setRunning(id, running) },
        sessionError: (id, message) => { app?.remoteError(id, message) },
      })
      // A fresh launch must not list saved Sessions; the scaffold's workspace is the cwd.
      let listed = 0
      remote.listSessions = async () => { listed += 1; return [] }
      const created = remote.createSession.bind(remote)
      remote.createSession = async () => created(host.workspaceCwd)
      const prompts: string[] = []
      const prompt = remote.prompt.bind(remote)
      remote.prompt = async (...args) => {
        prompts.push(JSON.stringify(args[1]))
        await prompt(...args)
      }
      const settled = host.whenTurnSettled()
      connect(remote)
      await expect.poll(() => prompts.length).toBe(1)
      expect(prompts[0]).toContain('early words')
      expect(listed).toBe(0)
      await expect.poll(frame).not.toContain('sending queue: early words')
      expect(frame()).not.toContain('Starting session...')
      await settled
    } finally {
      input.write('\u0003/quit\r')
      await running
      input.destroy()
      output.destroy()
      await host.close()
    }
  }, 60_000)

  it('quits during startup without waiting for the host', async () => {
    const { input, stdin, stdout, output } = terminalStreams()
    let closed = false
    const late = { close: async () => { closed = true } } as unknown as TuiRemoteClient
    let connect: (remote: TuiRemoteClient) => void = () => {}
    const connecting = new Promise<TuiRemoteClient>((resolveConnect) => { connect = resolveConnect })
    const running = TuiApp.run({ remote: connecting, hostClose: async () => {}, resume: undefined, stdin, stdout, env: {} })
    input.write('/exit\r')
    expect(await running).toBe(0)
    // The connection that arrives afterwards is released rather than left open.
    connect(late)
    await expect.poll(() => closed).toBe(true)
    input.destroy()
    output.destroy()
  })
})

describe('terminal exit', () => {
  it('interrupts the running turn before /exit leaves', async () => {
    const host = await launchWebScaffold({
      replayFixture: resolve(import.meta.dirname, '../../../snapshots/web/live-interactions/session.v3.jsonl'),
      compareReplaySession: false,
      paceMs: 600,
    })
    const { input, stdin, stdout, output } = terminalStreams()
    let app: TuiApp | undefined
    const remote = await TuiRemoteClient.connect({
      ...normalizeEntryUrl(host.authenticatedUrl), close: async () => {},
    }, {
      approval: request => app?.requestApproval(request) ?? Promise.resolve('rejected'),
      question: request => app?.requestQuestion(request) ?? Promise.resolve({ answers: [] }),
      sessionStatus: (id, running) => { app?.setRunning(id, running) },
      sessionError: (id, message) => { app?.remoteError(id, message) },
    })
    const sessionId = await remote.createSession(host.workspaceCwd)
    const cancelled: string[] = []
    const cancel = remote.cancel.bind(remote)
    remote.cancel = async (id) => {
      cancelled.push(String(id))
      await cancel(id)
    }
    const settled = host.whenTurnSettled()
    const running = TuiApp.run({
      remote, hostClose: async () => {}, resume: sessionId, stdin, stdout, env: {},
      onApp: (value) => { app = value },
    })
    const frame = (): string => plain(app?.screenLines() ?? [])
    try {
      await expect.poll(frame).toContain('deepseek-v4-flash')
      input.write('Reply with a one-sentence description of event sourcing, then stop.\r')
      await expect.poll(frame).toContain('· running')
      input.write('/exit\r')
      expect(await running).toBe(0)
      expect(cancelled).toEqual([String(sessionId)])
      await settled
    } finally {
      input.destroy()
      output.destroy()
      // The turn is cut short on purpose, so the recording's later model calls never happen.
      try {
        await host.close()
      } catch (error) {
        // Teardown gathers its failures; only the expected one is let through.
        const failures = error instanceof AggregateError ? error.errors : [error]
        const unexpected = failures.filter(failure => !String(failure).includes('fixture not fully consumed'))
        if (unexpected.length > 0) throw error
      }
    }
  }, 60_000)
})
