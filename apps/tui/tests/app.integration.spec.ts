/** Full terminal send/reply lifecycle through the keyless Web replay host. */

import { resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { launchWebScaffold } from '../../web/tests/scaffold.ts'
import { TuiApp } from '../src/app.ts'
import { normalizeEntryUrl } from '../src/host.ts'
import { TuiRemoteClient } from '../src/remote.ts'

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
      await expect.poll(() => text.slice(text.lastIndexOf('\u001b[2J'))).toMatch(/first[\s\S]*second/u)
      expect(text.slice(text.lastIndexOf('\u001b[2J'))).not.toContain('You first')
      input.write('\u001b[117;5u')
      await expect.poll(() => text.slice(text.lastIndexOf('\u001b[2J'))).not.toContain('second')
      input.write('\u001b[121;5u')
      await expect.poll(() => text.slice(text.lastIndexOf('\u001b[2J'))).toContain('second')
      input.write('\u0003')
      await expect.poll(() => text.slice(text.lastIndexOf('\u001b[2J'))).not.toContain('first')
      input.write('Reply with a one-sentence description of event sourcing, then stop.\r')
      await expect.poll(() => text.slice(text.lastIndexOf('\u001b[2J')))
        .toContain('sending queue: Reply with a one-sentence description')
      await settled
      await expect.poll(() => text.slice(text.lastIndexOf('\u001b[2J'))).toContain('| idle')
      expect(text).toContain('Event sourcing')
      expect(text).toMatch(/event.sourc/iu)
      expect(text).not.toContain('model: default')
      expect(text).not.toContain('kill/yank')
      const finalRows = text.slice(text.lastIndexOf('\u001b[2J'))
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
      await expect.poll(() => text.slice(text.lastIndexOf('\u001b[2J')))
        .toContain('No failed turn is eligible')

      remote.prompt = async () => { throw new Error('admission failed') }
      input.write('keep this draft\r')
      await expect.poll(() => text.slice(text.lastIndexOf('\u001b[2J'))).toContain('admission failed')
      expect(text.slice(text.lastIndexOf('\u001b[2J'))).toContain('keep this draft')
      input.write('\u0003')
    } finally {
      input.write('\u0003/quit\r')
      await running
      expect(text).toContain(`dsh tui --resume ${sessionId}`)
      input.destroy()
      output.destroy()
      await host.close()
    }
  }, 60_000)

  it('queues with Tab while running and manages the dock through /queue', async () => {
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
    const frame = (): string => text.slice(text.lastIndexOf('\u001b[2J'))
      .replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    try {
      await expect.poll(() => text).toContain('deepseek-v4-flash')
      input.write('Reply with a one-sentence description of event sourcing, then stop.\r')
      await expect.poll(frame).toContain('| running')
      input.write('queued follow-up')
      input.write('\t')
      await expect.poll(frame).toContain('queued: queued follow-up')
      input.write('\u001b[1;3A')
      await expect.poll(frame).not.toContain('queued: queued follow-up')
      expect(frame()).toContain('queued follow-up')
      input.write('\u0015')
      input.write('queued follow-up')
      input.write('\t')
      await expect.poll(frame).toContain('queued: queued follow-up')
      input.write('/queue\r')
      await expect.poll(frame).toContain('Pending messages')
      input.write('d')
      await expect.poll(frame).not.toContain('queued: queued follow-up')
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
    const frame = (): string => text.slice(text.lastIndexOf('\u001b[2J'))
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
      await expect.poll(frame).toContain('/icai ')
      input.write('\u0003')
    } finally {
      input.write('\u0003/quit\r')
      await running
      input.destroy()
      output.destroy()
      await host.close()
    }
  }, 30_000)
})
