/**
 * Contents of the `/status` panel's tabs, as label/value rows the renderer lays out.
 *
 * Status carries the Session's identity and settings, Stats its whole-Session conversation
 * figures (the Web composer's activity and usage pills), and Context the context-window
 * breakdown. Every row is read from the live transcript state, so an open panel follows the turn.
 */

import { messages } from './locale.ts'
import type { SessionStats, TranscriptState } from './transcript.ts'
import type { StatusTab } from './ui.ts'

/** One labelled reading. */
export interface PanelRow {
  readonly label: string
  readonly value: string
}

/** A tab's rows, or the sentence shown when it has nothing to show. */
export type PanelContent =
  | { readonly rows: readonly PanelRow[] }
  | { readonly empty: string }

/** Terminal size, quoted on the Status tab so a layout report can cite it. */
export interface TerminalSize {
  readonly columns: number
  readonly rows: number
}

const labels = messages.statusLabels

/**
 * Rows of one tab.
 * @param tab - the tab shown.
 * @param state - the live transcript state.
 * @param terminal - the terminal's size.
 * @returns the rows, or why there are none.
 */
export function statusTabContent(tab: StatusTab, state: TranscriptState, terminal: TerminalSize): PanelContent {
  switch (tab) {
    case 'status':
      return { rows: statusRows(state, terminal) }
    case 'stats':
      return statsContent(state)
    case 'context':
      return contextContent(state)
  }
}

function statusRows(state: TranscriptState, terminal: TerminalSize): PanelRow[] {
  return [
    { label: labels.session, value: state.sessionId ?? '(none)' },
    { label: labels.title, value: state.title },
    { label: labels.directory, value: state.cwd },
    { label: labels.model, value: state.model === undefined ? '(default)' : `${state.model.provider}/${state.model.model}` },
    { label: labels.effort, value: state.model?.reasoningEffort ?? '(default)' },
    { label: labels.permission, value: state.permission ?? '(unknown)' },
    { label: labels.state, value: state.running ? 'running' : 'idle' },
    { label: labels.terminal, value: `${String(terminal.columns)}x${String(terminal.rows)}` },
  ]
}

function statsContent(state: TranscriptState): PanelContent {
  const stats = state.stats
  const rows: PanelRow[] = []
  if (stats !== undefined && stats.steps > 0) {
    rows.push({ label: labels.activity, value: activityText(stats) })
    rows.push({ label: labels.stepsPerTurn, value: stats.turns > 0 ? (stats.steps / stats.turns).toFixed(1) : '-' })
    if (stats.llmMs > 0) rows.push({ label: labels.llmTime, value: formatDuration(stats.llmMs) })
    if (stats.toolMs > 0) rows.push({ label: labels.toolTime, value: formatDuration(stats.toolMs) })
    if (stats.ttftSteps > 0) rows.push({ label: labels.ttft, value: formatDuration(stats.ttftMs / stats.ttftSteps) })
    const speed = outputSpeed(stats)
    if (speed !== undefined) rows.push({ label: labels.speed, value: speed })
  }
  const tokens = state.tokens
  if (tokens !== undefined && tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output > 0) {
    const cache = cacheHit(tokens)
    if (cache !== undefined) rows.push({ label: labels.cacheHit, value: cache })
    rows.push({ label: labels.input, value: exact(tokens.input) })
    rows.push({ label: labels.cacheRead, value: exact(tokens.cacheRead) })
    if (tokens.cacheWrite !== 0) rows.push({ label: labels.cacheWrite, value: exact(tokens.cacheWrite) })
    rows.push({ label: labels.output, value: exact(tokens.output) })
  }
  if (rows.length > 0) return { rows }
  return { empty: stats === undefined && tokens === undefined ? messages.statsUnavailable : messages.statsEmpty }
}

function contextContent(state: TranscriptState): PanelContent {
  const context = state.context
  if (context === undefined) return { empty: messages.contextUnavailable }
  const known = (value: number | undefined): string => value === undefined ? 'unknown' : exact(value)
  return {
    rows: [
      { label: labels.context, value: contextSummary(state) },
      { label: labels.pressure, value: known(context.pressureTokens) },
      { label: labels.projected, value: known(context.projectedTokens) },
      { label: labels.system, value: known(context.systemTokens) },
      { label: labels.tools, value: known(context.toolsTokens) },
      { label: labels.messages, value: known(context.messageTokens) },
    ],
  }
}

/**
 * Context-window use, e.g. `7% (14.2k/200k)`.
 * @param state - the live transcript state.
 * @returns the reading, or 'unavailable' before the Host reports the window.
 */
export function contextSummary(state: TranscriptState): string {
  const context = state.context
  if (context === undefined || context.contextWindow === undefined) return 'unavailable'
  const used = context.projectedTokens ?? context.pressureTokens
  if (used === undefined) return 'unavailable'
  const percent = Math.min(100, Math.round(used / context.contextWindow * 100))
  return `${String(percent)}% (${compactNumber(used)}/${compactNumber(context.contextWindow)})`
}

/**
 * Turn and step counts, e.g. `12 turns · 48 steps`.
 * @param stats - whole-Session figures.
 * @returns the counts.
 */
export function activityText(stats: Pick<SessionStats, 'turns' | 'steps'>): string {
  return `${plural(stats.turns, 'turn')} · ${plural(stats.steps, 'step')}`
}

/**
 * The same counts for the status row, without the dot the row already uses between readings.
 * @param stats - whole-Session figures, or undefined when the Host serves none.
 * @returns e.g. `12 turns/48 steps`, or undefined before the first closed step.
 */
export function activityReading(stats: SessionStats | undefined): string | undefined {
  if (stats === undefined || stats.steps === 0) return undefined
  return `${plural(stats.turns, 'turn')}/${plural(stats.steps, 'step')}`
}

/**
 * Compact duration: `850ms`, `45.2s`, `2m42s`, `1h05m`.
 * @param ms - milliseconds.
 * @returns the reading.
 */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${String(Math.round(ms))}ms`
  const seconds = ms / 1_000
  if (seconds < 60) return `${(Math.round(seconds * 10) / 10).toFixed(1)}s`
  const whole = Math.round(seconds)
  if (whole < 3_600) return `${String(Math.floor(whole / 60))}m${String(whole % 60).padStart(2, '0')}s`
  return `${String(Math.floor(whole / 3_600))}h${String(Math.floor(whole % 3_600 / 60)).padStart(2, '0')}m`
}

/**
 * Decode speed over the steps reporting usage.
 * @param stats - whole-Session figures.
 * @returns e.g. `62 tok/s`, or undefined without decode time.
 */
export function outputSpeed(stats: SessionStats): string | undefined {
  if (stats.decodeMs <= 0 || stats.decodeTokens <= 0) return undefined
  const perSecond = stats.decodeTokens / (stats.decodeMs / 1_000)
  return `${perSecond < 10 ? perSecond.toFixed(1) : String(Math.round(perSecond))} tok/s`
}

function cacheHit(tokens: NonNullable<TranscriptState['tokens']>): string | undefined {
  const billed = tokens.input + tokens.cacheRead + tokens.cacheWrite
  if (billed <= 0) return undefined
  return `${String(Math.min(100, Math.round(tokens.cacheRead / billed * 100)))}%`
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`
}

function exact(value: number): string {
  return value.toLocaleString('en-US')
}

function compactNumber(value: number): string {
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}m`
}
