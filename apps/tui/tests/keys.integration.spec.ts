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
} as const

/**
 * Mount the replay host and a terminal app on in-memory streams.
 * @returns the running app, its input stream, the rendered text, and a teardown.
 */
async function mountTerminal(): Promise<{
  app: () => TuiApp
  input: PassThrough
  screen: () => string
  /** Every byte written to the terminal so far, escapes included. */
  written: () => string
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
  let written = ''
  output.on('data', (chunk: Buffer) => { written += chunk.toString() })
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
    written: () => written,
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
    await expect.poll(() => terminal.screen()).toContain('· running')
    terminal.input.write('sent at once')
    terminal.input.write(key)
    await expect.poll(() => terminal.screen()).not.toContain('queued: sent at once')
    await expect.poll(() => terminal.screen()).toContain('sent at once')
  } finally {
    await terminal.stop()
  }
}

describe('composer keys', () => {
  it('queues on Enter and only interrupts on Escape', async () => {
    const terminal = await mountTerminal()
    try {
      await expect.poll(() => terminal.screen()).toContain('deepseek-v4-flash')
      // Start a turn and keep it running while the assertions press keys.
      terminal.input.write('Reply with a one-sentence description of event sourcing, then stop.\r')
      await expect.poll(() => terminal.screen()).toContain('· running')

      // Enter never interrupts: whatever the turn is doing, the message is accepted without
      // stopping it, so the running marker must survive the keypress.
      terminal.input.write('queued row\r')
      await expect.poll(() => terminal.screen()).toContain('queued row')

      // Escape stops the turn.
      terminal.input.write(KEY.escape)
      await expect.poll(() => terminal.screen()).not.toContain('· running')

    } finally {
      await terminal.stop()
    }
  }, 60_000)

  it('folds a large paste, notifies when an unfocused turn ends, and forks on Esc Esc Enter', async () => {
    const terminal = await mountTerminal()
    try {
      await expect.poll(() => terminal.screen()).toContain('deepseek-v4-flash')
      // A bracketed paste over the threshold shows as a placeholder, not as its text.
      const pasted = `Reply with a one-sentence description of event sourcing, then stop. ${'x'.repeat(1100)}`
      terminal.input.write(`\u001b[200~${pasted}\u001b[201~`)
      await expect.poll(() => terminal.screen()).toContain(`[Pasted Content ${String(pasted.length)} chars]`)
      expect(terminal.screen()).not.toContain('xxxxxxxxxx')
      // The operator looks away; the turn's end then posts a notification (BEL without OSC 9).
      terminal.input.write('\u001b[O')
      terminal.input.write(KEY.enter)
      await expect.poll(() => terminal.screen()).toContain('· running')
      // The title spins while the turn runs, and the full paste reached the transcript.
      await expect.poll(() => terminal.written()).toMatch(/\u001b\]0;[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /u)
      await expect.poll(() => terminal.screen(), { timeout: 30_000 }).toContain('· idle')
      expect(terminal.written()).toContain('\u0007')
      expect(terminal.app().screenLines().join('\n')).toContain('xxxxxxxxxx')

      // Esc arms the backtrack, a second Esc selects the latest message, Enter forks before it.
      terminal.input.write('\u001b[I')
      terminal.input.write(KEY.escape)
      await expect.poll(() => terminal.screen()).toContain('Esc again to edit a previous message')
      terminal.input.write(KEY.escape)
      await expect.poll(() => terminal.screen()).toContain('Enter edit from here')
      terminal.input.write(KEY.enter)
      await expect.poll(() => terminal.screen()).toContain('Forked before the selected message')
      // The fork starts before the message, so the composer holds it again and the
      // transcript no longer shows the earlier turn's reply.
      // The fork holds nothing of the selected message: no reply, and no carried-over queue row.
      await expect.poll(() => terminal.screen()).toContain('Type a message or /help')
      expect(terminal.screen()).not.toContain('queued:')
      expect(terminal.screen()).toContain('❯ Reply with a one-sentence description')
    } finally {
      await terminal.stop()
    }
  }, 90_000)

  it('interrupts and sends on Ctrl+Enter', async () => {
    await expectSentDraftBreaksOut(KEY.ctrlEnter)
  }, 60_000)
})
