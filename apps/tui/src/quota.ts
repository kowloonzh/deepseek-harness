/**
 * Subscription allowance for models served through a local magpie gateway.
 *
 * magpie tracks each subscription's rate-limit windows (a ChatGPT plan's 5-hour and weekly
 * windows) and reports them from the gateway on this computer through `magpie quota`, so the
 * TUI reads them there without the Host or any provider credentials. Account identities in the
 * report are never read.
 */

import { execFile } from 'node:child_process'
import type { ModelStatus } from './transcript.ts'

/** One allowance window: how much is left and when it refills. */
export interface QuotaWindow {
  /** Short label: `5h`, `weekly`, or magpie's own name for other windows. */
  readonly label: string
  /** Remaining allowance, 0 to 100. */
  readonly remaining: number
  /** When the window resets, in epoch milliseconds. */
  readonly resetsAt?: number | undefined
}

const QUOTA_TIMEOUT_MS = 10_000

/**
 * The magpie provider behind a model, or undefined when the model is not served through magpie.
 *
 * A DSH provider configured for the gateway is named after it (`magpie`, `magpie-responses`),
 * and its model ids carry magpie's provider prefix (`codex/gpt-…`).
 * @param model - the Session's model.
 * @returns magpie's provider id, such as `codex`.
 */
export function magpieProvider(model: ModelStatus | undefined): string | undefined {
  if (model === undefined || !/magpie/iu.test(model.provider)) return undefined
  const prefix = /^([\w.-]+)\//u.exec(model.model)?.[1]
  return prefix === undefined || prefix === '' ? undefined : prefix
}

/**
 * Read the windows of one provider from `magpie quota <provider> --json` output.
 * @param json - the command's standard output.
 * @param provider - the provider to keep.
 * @returns its windows, in magpie's order; empty when there are none.
 */
export function parseMagpieQuota(json: string, provider: string): QuotaWindow[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const entries = parsed.filter((entry): entry is Record<string, unknown> =>
    typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>).provider === provider)
  // With several accounts, the one that served the latest request is the one in use.
  const entry = entries.find(candidate => candidate.last === true) ?? entries[0]
  const windows = entry?.windows
  if (!Array.isArray(windows)) return []
  return windows.flatMap((window: unknown) => {
    if (typeof window !== 'object' || window === null) return []
    const { name, remaining, used, resetsAt } = window as Record<string, unknown>
    const left = typeof remaining === 'number' ? remaining : typeof used === 'number' ? 100 - used : undefined
    if (left === undefined || typeof name !== 'string') return []
    const reset = typeof resetsAt === 'string' ? Date.parse(resetsAt) : Number.NaN
    return [{
      label: windowLabel(name),
      remaining: Math.max(0, Math.min(100, Math.round(left))),
      resetsAt: Number.isNaN(reset) ? undefined : reset,
    }]
  })
}

function windowLabel(name: string): string {
  if (/^5\s*h(?:ours?)?$/iu.test(name)) return '5h'
  if (/^(?:7\s*d(?:ays?)?|week(?:ly)?)$/iu.test(name)) return 'weekly'
  return name
}

/**
 * The status-line text: `5h: 79% (19:20) | weekly: 59% (11-30 00:00)`.
 * A reset later today shows its time only; a later one adds the date.
 * @param windows - the windows to show.
 * @param now - the current time, in epoch milliseconds.
 * @returns the text, or undefined when there is nothing to show.
 */
export function formatQuota(windows: readonly QuotaWindow[], now: number): string | undefined {
  if (windows.length === 0) return undefined
  return windows.map((window) => {
    const reset = window.resetsAt === undefined ? '' : ` (${resetTime(window.resetsAt, now)})`
    return `${window.label}: ${String(window.remaining)}%${reset}`
  }).join(' | ')
}

function resetTime(at: number, now: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  return date.toDateString() === new Date(now).toDateString()
    ? time
    : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`
}

/** What one `magpie quota` call found. */
export interface QuotaReading {
  readonly windows: QuotaWindow[]
  /** No `magpie` command on this machine: asking again cannot help. */
  readonly missing: boolean
}

/**
 * Ask magpie for one provider's windows.
 *
 * Every failure is quiet: a machine without magpie, a gateway that is not running, or a report
 * without the provider all yield no windows, and the status line simply shows none.
 * @param provider - magpie's provider id.
 * @returns the windows, and whether the command is missing altogether.
 */
export function readMagpieQuota(provider: string): Promise<QuotaReading> {
  return new Promise((resolve) => {
    try {
      execFile('magpie', ['quota', provider, '--json'], { timeout: QUOTA_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
        if (error === null) resolve({ windows: parseMagpieQuota(stdout, provider), missing: false })
        else resolve({ windows: [], missing: (error as NodeJS.ErrnoException).code === 'ENOENT' })
      })
    } catch {
      resolve({ windows: [], missing: true })
    }
  })
}
