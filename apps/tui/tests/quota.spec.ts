/** Subscription allowance read from a local magpie gateway. */

import { describe, expect, it } from 'vitest'
import { formatQuota, magpieProvider, parseMagpieQuota, readMagpieQuota } from '../src/quota.ts'

const REPORT = JSON.stringify([
  { provider: 'claude', windows: [{ name: '5 hours', used: 10, remaining: 90 }] },
  {
    provider: 'codex',
    user: 'someone@example.test',
    windows: [
      { name: '5 hours', used: 21, remaining: 79, resetsAt: '2026-11-25T19:20:00+08:00' },
      { name: '7 days', used: 41, resetsAt: '2026-11-30T00:00:00+08:00' },
    ],
    last: true,
  },
])

describe('magpie quota', () => {
  it('serves a model through magpie only when its provider is the gateway and its id has a prefix', () => {
    expect(magpieProvider({ provider: 'magpie-responses', model: 'codex/gpt-6.1-sol' })).toBe('codex')
    expect(magpieProvider({ provider: 'deepseek-official', model: 'deepseek-v4' })).toBeUndefined()
    expect(magpieProvider({ provider: 'magpie', model: 'plain-model' })).toBeUndefined()
    expect(magpieProvider(undefined)).toBeUndefined()
  })

  it('keeps the provider windows, filling remaining from used', () => {
    const windows = parseMagpieQuota(REPORT, 'codex')
    expect(windows.map(window => [window.label, window.remaining])).toEqual([['5h', 79], ['weekly', 59]])
    expect(parseMagpieQuota('not json', 'codex')).toEqual([])
    expect(parseMagpieQuota(REPORT, 'gemini')).toEqual([])
  })

  it('formats each window with its reset time, adding the date when it is not today', () => {
    const now = new Date(2026, 10, 25, 15, 0).getTime()
    const windows = [
      { label: '5h', remaining: 79, resetsAt: new Date(2026, 10, 25, 19, 20).getTime() },
      { label: 'weekly', remaining: 59, resetsAt: new Date(2026, 10, 30, 0, 0).getTime() },
    ]
    expect(formatQuota(windows, now)).toBe('5h: 79% (19:20) | weekly: 59% (11-30 00:00)')
    expect(formatQuota([], now)).toBeUndefined()
  })

  it('reports a machine without magpie as missing instead of failing', async () => {
    const path = process.env.PATH
    process.env.PATH = '/nonexistent'
    try {
      expect(await readMagpieQuota('codex')).toEqual({ windows: [], missing: true })
    } finally {
      process.env.PATH = path
    }
  })
})
