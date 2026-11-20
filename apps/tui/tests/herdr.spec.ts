/** Lifecycle ordering, coalescing, and optional Herdr availability. */

import { describe, expect, it, vi } from 'vitest'
import { HerdrReporter, type HerdrRunner } from '../src/herdr.ts'

const ENV = {
  HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1',
  HERDR_BIN_PATH: '/fixture/herdr', HERDR_SOCKET_PATH: '/fixture/herdr.sock',
}

function harness(version = '0.9.5', extra: NodeJS.ProcessEnv = {}) {
  const calls: string[][] = []
  const run: HerdrRunner = async (_binary, args) => {
    calls.push([...args])
    return args[0] === '--version' ? `herdr ${version}` : ''
  }
  return { calls, reporter: new HerdrReporter({ ...ENV, ...extra }, run) }
}

describe('Herdr lifecycle reports', () => {
  it('does nothing outside a fully identified Herdr pane', async () => {
    const { calls, reporter } = harness('0.9.5', { HERDR_ENV: '0' })
    reporter.update({ sessionId: 'session-1', state: 'idle' })
    await reporter.close()
    expect(calls).toEqual([])
  })

  it('reports lifecycle and session switches, then releases with increasing sequence numbers', async () => {
    const { calls, reporter } = harness()
    for (const state of ['idle', 'working', 'blocked'] as const) {
      reporter.update({ sessionId: 'session-1', state })
      await vi.waitFor(() => { expect(calls.at(-1)).toContain(state) })
    }
    reporter.update({ sessionId: 'session-2', state: 'idle' })
    await vi.waitFor(() => { expect(calls.at(-1)).toContain('session-2') })
    await reporter.close()
    const reports = calls.filter(args => args[0] === 'pane')
    expect(reports.filter(args => args.includes('--state')).map(args => args[args.indexOf('--state') + 1])).toEqual([
      'idle', 'working', 'blocked', 'idle',
    ])
    expect(reports[3]?.slice(-5)).toEqual(['--', 'dsh', 'tui', '--resume', 'session-2'])
    expect(reports.at(-1)?.slice(0, 3)).toEqual(['pane', 'release-agent', 'w1:p1'])
    const seqs = reports.map(args => Number(args[args.indexOf('--seq') + 1]))
    expect(seqs.every((value, index) => index === 0 || value > (seqs[index - 1] ?? 0))).toBe(true)
  })

  it('uses legacy state reporting on Herdr 0.9.0 and never persists a remote URL', async () => {
    for (const options of [{ version: '0.9.0', extra: {} }, { version: '0.9.5', extra: { DSH_URL: 'https://fixture/?token=private' } }]) {
      const { calls, reporter } = harness(options.version, options.extra)
      reporter.update({ sessionId: 'session-1', state: 'idle' })
      await vi.waitFor(() => { expect(calls.at(-1)).toContain('report-agent') })
      await reporter.close()
      expect(calls.some(args => args.includes('--'))).toBe(false)
      expect(JSON.stringify(calls)).not.toContain('private')
    }
  })

  it('coalesces waiting reports and releases only after in-flight IPC settles', async () => {
    let begin: () => void = () => {}
    const started = new Promise<void>((resolve) => { begin = resolve })
    let finish: (value: string) => void = () => {}
    const release = new Promise<string>((resolve) => { finish = resolve })
    const calls: string[][] = []
    const reporter = new HerdrReporter(ENV, async (_binary, args) => {
      calls.push([...args])
      if (args[0] === '--version') return 'herdr 0.9.5'
      if (args.includes('working')) { begin(); return release }
      return ''
    })
    reporter.update({ sessionId: 's', state: 'working' })
    await started
    reporter.update({ sessionId: 's', state: 'blocked' })
    reporter.update({ sessionId: 's', state: 'idle' })
    const closing = reporter.close()
    expect(calls.some(args => args.includes('release-agent'))).toBe(false)
    finish('')
    await closing
    expect(calls.some(args => args.includes('blocked'))).toBe(false)
    expect(calls.at(-1)).toContain('release-agent')
    reporter.update({ sessionId: 's', state: 'working' })
    expect(calls).toHaveLength(3)
  })

  it('contains IPC failures without rejecting teardown', async () => {
    const reporter = new HerdrReporter(ENV, async () => { throw new Error('unavailable') })
    reporter.update({ sessionId: 's', state: 'idle' })
    await expect(reporter.close()).resolves.toBeUndefined()
  })
})
