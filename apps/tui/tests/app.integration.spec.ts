/** Full terminal send/reply lifecycle through the keyless Web replay host. */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { launchWebScaffold } from '../../web/tests/scaffold.ts'
import { TuiApp } from '../src/app.ts'
import { normalizeEntryUrl } from '../src/host.ts'
import { TuiRemoteClient } from '../src/remote.ts'
import { EmulatedTerminal } from './terminal.ts'

/**
 * Text the composer currently holds for `app`, or '' when it is not painted yet.
 * @param app - running terminal app, or undefined before it is created.
 * @returns the composer row's content after its prompt marker.
 */
/**
 * The draft text alone: the composer row's content without its right border and padding.
 * @param app - running terminal app, or undefined before it is created.
 * @returns the trimmed draft the composer shows.
 */
function draftText(app: TuiApp | undefined): string {
  return composerDraft(app).replace(/\s*│\s*$/u, '').trimEnd()
}

function composerDraft(app: TuiApp | undefined): string {
  // Only the composer is drawn as a boxed row, so the left border selects it;
  // the suggestion list also contains '❯ ' and would match a looser search.
  const row = (app?.screenLines() ?? []).find(line => line.trimStart().startsWith('│ ❯ '))
  if (row === undefined) return ''
  return row.slice(row.indexOf('❯ ') + 2)
}

describe('terminal prompt lifecycle', () => {
  it('shows the default model, streams a reply, and stays idle when acceptance arrives after completion', async () => {
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
    let text = ''
    // Frames are cell diffs, so the reply is asserted on the emulated screen, not the raw bytes.
    const terminal = new EmulatedTerminal(120, 24)
    let painted = Promise.resolve()
    output.on('data', (chunk: Buffer) => {
      text += chunk.toString()
      painted = painted.then(() => terminal.write(chunk))
    })
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
    const catalog = await remote.modelCatalog()
    const settled = host.whenTurnSettled()
    const prompt = remote.prompt.bind(remote)
    remote.prompt = async (...args) => {
      await prompt(...args)
      await settled
    }
    const running = TuiApp.run({
      remote, hostClose: async () => {}, resume: sessionId, stdin, stdout, env: {},
      onApp: (value) => { app = value },
    })
    try {
      await expect.poll(() => text).toContain(catalog.default.model)
      input.write('first')
      input.write('\u001b[13;2u')
      input.write('second')
      await expect.poll(() => (app?.screenLines() ?? []).join('\n')).toMatch(/first[\s\S]*second/u)
      expect((app?.screenLines() ?? []).join('\n')).not.toContain('You first')
      input.write('\u001b[117;5u')
      await expect.poll(() => (app?.screenLines() ?? []).join('\n')).not.toContain('second')
      input.write('\u001b[121;5u')
      await expect.poll(() => (app?.screenLines() ?? []).join('\n')).toContain('second')
      input.write('\u0003')
      await expect.poll(() => (app?.screenLines() ?? []).join('\n')).not.toContain('first')
      input.write('Reply with a one-sentence description of event sourcing, then stop.\r')
      await expect.poll(() => (app?.screenLines() ?? []).join('\n'))
        .toContain('sending queue: Reply with a one-sentence description')
      await settled
      // The status row marks a running turn and drops the marker when the turn settles.
      await expect.poll(() => (app?.screenLines() ?? []).join('\n')).not.toContain('· running')
      await painted
      expect(terminal.text()).toContain('Event sourcing')
      expect(terminal.text()).toMatch(/event.sourc/iu)
      expect(text).not.toContain('model: default')
      expect(text).not.toContain('kill/yank')
      // The composer only appears once a frame has been painted, so wait for the
      // box edges and for the accepted prompt to leave the draft before snapshotting.
      // Clearing the draft is a repaint the host acknowledgement schedules, so reading
      // the box as soon as it exists catches the pre-clear frame under load.
      await expect.poll(() => (app?.screenLines() ?? []).join('\n')).toContain('╰')
      await expect.poll(() => draftText(app)).toBe('')
      const finalRows = (app?.screenLines() ?? []).join('\n')
        .replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '').split('\n')
      const top = finalRows.findIndex(row => row.startsWith('╭'))
      const bottom = finalRows.findIndex(row => row.startsWith('╰'))
      expect({ composer: finalRows.slice(top, bottom + 1), model: catalog.default.model }).toMatchSnapshot()

      const directPrompts: string[] = []
      remote.command = async () => undefined
      remote.prompt = async (_sessionId, content) => {
        directPrompts.push(content.filter(part => part.type === 'text').map(part => part.text).join(''))
      }
      input.write('/icai analyze this\r')
      await expect.poll(() => directPrompts).toEqual(['/icai analyze this'])

      input.write('/retry\r')
      await expect.poll(() => (app?.screenLines() ?? []).join('\n'))
        .toContain('No failed turn is eligible')

      remote.prompt = async () => { throw new Error('admission failed') }
      input.write('keep this draft\r')
      await expect.poll(() => (app?.screenLines() ?? []).join('\n')).toContain('admission failed')
      expect((app?.screenLines() ?? []).join('\n')).toContain('keep this draft')
      input.write('\u0003')
    } finally {
      input.write('\u0003/quit\r')
      await running
      expect(text).toContain(`dsh tui --resume ${sessionId}`)
      input.destroy()
      output.destroy()
      terminal.dispose()
      await host.close()
    }
  }, 60_000)

  it('steers with Enter, manages the dock through /queue, and sends unread steers on Escape', async () => {
    const host = await launchWebScaffold({
      replayFixture: resolve(import.meta.dirname, '../../../snapshots/web/live-interactions/session.v3.jsonl'),
      compareReplaySession: false,
      paceMs: 600,
    })
    const input = new PassThrough()
    const output = new PassThrough()
    const stdin = input as NodeJS.ReadStream
    const stdout = output as NodeJS.WriteStream
    stdin.setRawMode = () => stdin
    stdout.rows = 24
    stdout.columns = 120
    let text = ''
    output.on('data', (chunk: Buffer) => { text += chunk.toString() })
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
    const settled = host.whenTurnSettled()
    const running = TuiApp.run({
      remote, hostClose: async () => {}, resume: sessionId, stdin, stdout, env: {},
      onApp: (value) => { app = value },
    })
    const frame = (): string => (app?.screenLines() ?? []).join('\n')
      .replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    try {
      await expect.poll(() => text).toContain('deepseek-v4-flash')
      input.write('Reply with a one-sentence description of event sourcing, then stop.\r')
      await expect.poll(frame).toContain('· running')
      // Enter hands the message to the running turn, which restates it as steering.
      input.write('queued follow-up\r')
      await expect.poll(frame).toContain('steer: queued follow-up')
      // Alt+Up recalls that message into the editor instead.
      input.write('\u001b[1;3A')
      await expect.poll(frame).not.toContain('steer: queued follow-up')
      expect(frame()).toContain('queued follow-up')
      input.write('\u0015')
      input.write('queued follow-up\r')
      await expect.poll(frame).toContain('steer: queued follow-up')
      input.write('second steer\r')
      await expect.poll(frame).toContain('steer: second steer')
      // /queue removes a pending message.
      input.write('/queue\r')
      await expect.poll(frame).toContain('Pending messages')
      input.write('\u001b[B')
      input.write('d')
      await expect.poll(frame).not.toContain('steer: second steer')
      // Escape stops the turn and sends the steer it had not read yet as a new turn, instead
      // of leaving it to wait for the next message.
      // The replay's error notice can replace the "sent" notice, so the transcript is the
      // evidence: the steer leaves the dock and opens its own turn after the interrupted one.
      input.write('\u001b')
      await expect.poll(frame).toMatch(/› queued follow-up[\s\S]*script exhausted/u)
      expect(frame()).not.toContain('steer: queued follow-up')
      await remote.cancel(sessionId).catch(() => {})
      await settled
    } finally {
      input.write('\u0003/quit\r')
      await running
      input.destroy()
      output.destroy()
      await host.close()
    }
  }, 60_000)

  it('exports the Session through the Host routes as Markdown and as the log ZIP', async () => {
    // No model calls: the Session is only created and exported.
    const host = await launchWebScaffold({})
    const remote = await TuiRemoteClient.connect({
      ...normalizeEntryUrl(host.authenticatedUrl), close: async () => {},
    }, {
      approval: () => Promise.resolve('rejected'),
      question: () => Promise.resolve({ answers: [] }),
      sessionStatus: () => {},
      sessionError: () => {},
    })
    try {
      const sessionId = await remote.createSession(host.workspaceCwd)
      const markdown = new TextDecoder().decode(await remote.exportSession(sessionId, 'markdown'))
      expect(markdown.length).toBeGreaterThan(0)
      const zip = await remote.exportSession(sessionId, 'zip')
      // A ZIP starts with the local file header signature `PK\x03\x04`.
      expect([...zip.slice(0, 4)]).toEqual([0x50, 0x4B, 0x03, 0x04])

      // `/export` in the terminal writes the file and prints where it went.
      const dshHome = await mkdtemp(join(tmpdir(), 'dsh-tui-export-'))
      const input = new PassThrough()
      const output = new PassThrough()
      const stdin = input as NodeJS.ReadStream
      const stdout = output as NodeJS.WriteStream
      stdin.setRawMode = () => stdin
      stdout.rows = 24
      stdout.columns = 160
      let app: TuiApp | undefined
      const running = TuiApp.run({
        remote, hostClose: async () => {}, resume: sessionId, stdin, stdout, env: { DSH_HOME: dshHome },
        onApp: (value) => { app = value },
      })
      const file = join(dshHome, 'exports', `dsh-${String(sessionId)}.md`)
      try {
        await expect.poll(() => app?.screenLines().length ?? 0).toBeGreaterThan(0)
        input.write('/export\r')
        await expect.poll(() => (app?.screenLines() ?? []).some(line => line.includes(file)), { timeout: 10_000 }).toBe(true)
        // By now the Session is stored, so the transcript also names its log file.
        expect(await readFile(file, 'utf8')).toMatch(/^# Untitled Session\n/u)
        // Up steps back through what was sent, newest first; Down returns to the empty draft.
        input.write('/help\r')
        await expect.poll(() => draftText(app)).toBe('')
        input.write('\u001b[A')
        await expect.poll(() => draftText(app)).toBe('/help')
        input.write('\u001b[A')
        await expect.poll(() => draftText(app)).toBe('/export')
        input.write('\u001b[B')
        await expect.poll(() => draftText(app)).toBe('/help')
        input.write('\u001b[B')
        await expect.poll(() => draftText(app)).toBe('')

        // Wheel back through the transcript: the gap above the composer shows codex's
        // "back to bottom" control, and a click on it returns to the latest rows.
        const control = (): { readonly row: number; readonly column: number } | undefined => {
          const lines = app?.screenLines() ?? []
          const row = lines.findIndex(line => line.includes('Back to bottom'))
          return row < 0 ? undefined : { row: row + 1, column: (lines[row]?.indexOf('Back') ?? 0) + 1 }
        }
        for (let step = 0; step < 6; step += 1) input.write('\u001b[<64;10;5M')
        await expect.poll(control).toBeDefined()
        const at = control()
        input.write(`\u001b[<0;${String(at?.column)};${String(at?.row)}M\u001b[<0;${String(at?.column)};${String(at?.row)}m`)
        await expect.poll(control).toBeUndefined()
      } finally {
        // Ctrl+U first, so a draft a failed step left behind cannot swallow `/quit`.
        input.write('\u0015/quit\r')
        await running
        input.destroy()
        output.destroy()
        await rm(dshHome, { recursive: true, force: true })
      }
    } finally {
      await remote.close()
      await host.close()
    }
  }, 30_000)

  it('completes Host commands and user-invocable skills after slash', async () => {
    const host = await launchWebScaffold({ compareReplaySession: false })
    const input = new PassThrough()
    const output = new PassThrough()
    const stdin = input as NodeJS.ReadStream
    const stdout = output as NodeJS.WriteStream
    stdin.setRawMode = () => stdin
    stdout.rows = 24
    stdout.columns = 100
    let text = ''
    output.on('data', (chunk: Buffer) => { text += chunk.toString() })
    let app: TuiApp | undefined
    const remote = await TuiRemoteClient.connect({
      ...normalizeEntryUrl(host.authenticatedUrl), close: async () => {},
    }, {
      approval: request => app?.requestApproval(request) ?? Promise.resolve('rejected'),
      question: request => app?.requestQuestion(request) ?? Promise.resolve({ answers: [] }),
      sessionStatus: (id, running) => { app?.setRunning(id, running) },
      sessionError: (id, message) => { app?.remoteError(id, message) },
    })
    remote.listCommands = async () => [{ name: 'goal', description: 'Set the session goal' }]
    remote.listSkills = async () => [{ name: 'icai', description: 'Research workflow' }]
    const sessionId = await remote.createSession(host.workspaceCwd)
    const running = TuiApp.run({
      remote, hostClose: async () => {}, resume: sessionId, stdin, stdout, env: {},
      onApp: (value) => { app = value },
    })
    const frame = (): string => (app?.screenLines() ?? []).join('\n')
      .replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    try {
      await expect.poll(() => text).toContain('deepseek-v4-flash')
      input.write('/new')
      await expect.poll(frame).toContain('❯ /new Create a new session')
      input.write('\u0015')
      input.write('/resume')
      await expect.poll(frame).toContain('❯ /resume Choose a recent session')
      input.write('\u0015')
      input.write('/')
      await expect.poll(frame).toContain('/help Show commands')
      input.write('\u0015')
      input.write('/ic')
      await expect.poll(frame).toContain('❯ /icai Research workflow [skill]')
      input.write('\t')
      // Assert the composer row itself: the suggestion list also contains "/icai",
      // so a whole-frame containment check passes even when Tab completes nothing.
      await expect.poll(() => draftText(app)).toBe('/icai')
      input.write('\u0003')
    } finally {
      input.write('\u0003/quit\r')
      await running
      input.destroy()
      output.destroy()
      await host.close()
    }
  }, 30_000)

  it('offers the Host\'s guess at the next message after a turn, and Right takes it', async () => {
    const host = await launchWebScaffold({ compareReplaySession: false })
    const input = new PassThrough()
    const output = new PassThrough()
    const stdin = input as NodeJS.ReadStream
    const stdout = output as NodeJS.WriteStream
    stdin.setRawMode = () => stdin
    stdout.rows = 24
    stdout.columns = 100
    let text = ''
    output.on('data', (chunk: Buffer) => { text += chunk.toString() })
    let app: TuiApp | undefined
    const remote = await TuiRemoteClient.connect({
      ...normalizeEntryUrl(host.authenticatedUrl), close: async () => {},
    }, {
      approval: request => app?.requestApproval(request) ?? Promise.resolve('rejected'),
      question: request => app?.requestQuestion(request) ?? Promise.resolve({ answers: [] }),
      sessionStatus: (id, running) => { app?.setRunning(id, running) },
      sessionError: (id, message) => { app?.remoteError(id, message) },
    })
    const lines: string[] = []
    remote.listCommands = async () => [
      { name: 'goal', description: 'Set the session goal' },
      { name: 'tui-next-prompt', description: 'internal' },
    ]
    remote.command = async (_id, line) => {
      lines.push(line)
      return { commandId: 'cmd-1', result: { kind: 'success', text: 'sort them by count' } } as never
    }
    const sessionId = await remote.createSession(host.workspaceCwd)
    const running = TuiApp.run({
      remote, hostClose: async () => {}, resume: sessionId, stdin, stdout, env: {},
      onApp: (value) => { app = value },
    })
    const frame = (): string => (app?.screenLines() ?? []).join('\n')
      .replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    try {
      await expect.poll(() => text).toContain('deepseek-v4-flash')
      input.write('/')
      await expect.poll(frame).toContain('/help Show commands')
      input.write('\u0015')
      input.write('/go')
      await expect.poll(frame).toContain('/goal Set the session goal')
      input.write('\u0015')
      input.write('/tui')
      await expect.poll(() => draftText(app)).toBe('/tui')
      expect(frame()).not.toContain('tui-next-prompt')
      input.write('\u0015')
      app?.setRunning(sessionId, true)
      await expect.poll(frame).toContain('Working')
      app?.setRunning(sessionId, false)
      await expect.poll(frame).toContain('❯ sort them by count')
      expect(lines).toEqual(['/tui-next-prompt'])
      input.write('\u001b[C')
      await expect.poll(() => draftText(app)).toBe('sort them by count')
      input.write('\u0015')
      await expect.poll(() => draftText(app)).toBe('')
      expect(frame()).not.toContain('sort them by count')
    } finally {
      input.write('\u0003/quit\r')
      await running
      input.destroy()
      output.destroy()
      await host.close()
    }
  }, 30_000)
})
