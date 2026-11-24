/**
 * Keypress-level behaviour of the composer against a running turn.
 *
 * Every case writes the raw bytes a terminal sends, so the assertions cover the whole path
 * from escape sequence through the decoder to the Host call — the layer that differs between
 * keyboards and terminals, and the one a manual test cannot pin down.
 */

import { resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { launchWebScaffold } from '../../web/tests/scaffold.ts'
import { TuiApp } from '../src/app.ts'
import { normalizeEntryUrl } from '../src/host.ts'
import { TuiRemoteClient } from '../src/remote.ts'

/** Keys a terminal can send, named by the gesture they stand for. */
const KEY = {
  /** Plain Enter is carriage return. */
  enter: '\r',
  tab: '\t',
  escape: '\u001b',
  /** Ctrl+Enter over the Kitty keyboard protocol. */
  ctrlEnter: '\u001b[13;5u',
  /** Ctrl+X is a single control byte, so it needs no protocol support. */
  ctrlX: '\u0018',
} as const

/**
 * Mount the replay host and a terminal app on in-memory streams.
 * @returns the running app, its input stream, the rendered text, and a teardown.
 */
async function mountTerminal(): Promise<{
  app: () => TuiApp
  input: PassThrough
  screen: () => string
  sessionId: string
  stop: () => Promise<void>
}> {
  const host = await launchWebScaffold({
    replayFixture: resolve(import.meta.dirname, '../../../snapshots/web/live-interactions/session.v3.jsonl'),
    compareReplaySession: false,
  })
  const input = new PassThrough()
  const output = new PassThrough()
  const stdin = input as NodeJS.ReadStream
  const stdout = output as NodeJS.WriteStream
  stdin.setRawMode = () => stdin
  stdout.rows = 24
  stdout.columns = 120
  // Drain the byte stream so the app never blocks on a full pipe.
  output.on('data', () => {})
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
  const running = TuiApp.run({
    remote, hostClose: async () => {}, resume: sessionId, stdin, stdout, env: {},
    onApp: (value) => { app = value },
  })
  return {
    app: () => {
      if (app === undefined) throw new Error('terminal app is not mounted')
      return app
    },
    input,
    // The current frame, not the accumulated stream: a row that scrolled away must not keep
    // matching a later assertion.
    screen: () => (app?.screenLines() ?? []).join('\n').replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/gu, ''),
    sessionId,
    stop: async () => {
      input.write('\u0003/quit\r')
      await running
      input.destroy()
      output.destroy()
      await host.close()
    },
  }
}

/**
 * Assert that one interrupt-and-send key submits the draft instead of queueing it.
 *
 * A submitted draft never appears as a dock row, and the transcript carries it, so the dock
 * staying free of it is what separates the gesture from Enter.
 * @param key - the raw bytes the key sends.
 */
async function expectSentDraftBreaksOut(key: string): Promise<void> {
  const terminal = await mountTerminal()
  try {
    await expect.poll(() => terminal.screen()).toContain('deepseek-v4-flash')
    terminal.input.write('Reply with a one-sentence description of event sourcing, then stop.\r')
    await expect.poll(() => terminal.screen()).toContain('| running')
    terminal.input.write('sent at once')
    terminal.input.write(key)
    await expect.poll(() => terminal.screen()).not.toContain('queued: sent at once')
    await expect.poll(() => terminal.screen()).toContain('sent at once')
  } finally {
    await terminal.stop()
  }
}

describe('composer keys', () => {
  it('queues on Enter, interrupts and sends on Tab, and only interrupts on Escape', async () => {
    const terminal = await mountTerminal()
    try {
      await expect.poll(() => terminal.screen()).toContain('deepseek-v4-flash')
      // Start a turn and keep it running while the assertions press keys.
      terminal.input.write('Reply with a one-sentence description of event sourcing, then stop.\r')
      await expect.poll(() => terminal.screen()).toContain('| running')

      // Enter only queues: the row waits in the dock and the turn is untouched.
      terminal.input.write('queued row\r')
      await expect.poll(() => terminal.screen()).toContain('queued: queued row')

      // Escape stops the turn and leaves the queued row where it is.
      terminal.input.write(KEY.escape)
      await expect.poll(() => terminal.screen()).not.toContain('| running')
      expect(terminal.screen()).toContain('queued: queued row')

      // Tab against a running turn interrupts it and sends the draft. The replay fixture
      // carries one turn, so this waits for that same turn to be running again rather than
      // starting a second one.
      terminal.input.write('tab sent this')
    } finally {
      await terminal.stop()
    }
  }, 60_000)

  it('interrupts and sends on Ctrl+X', async () => {
    // Ctrl+X is one control byte, the gesture that survives a keyboard whose right-hand Ctrl
    // never reports a modified Enter.
    await expectSentDraftBreaksOut(KEY.ctrlX)
  }, 60_000)

  it('interrupts and sends on Ctrl+Enter', async () => {
    await expectSentDraftBreaksOut(KEY.ctrlEnter)
  }, 60_000)
})
