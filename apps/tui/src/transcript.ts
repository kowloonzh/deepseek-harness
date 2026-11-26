/** Terminal transcript projection over public Session follow frames. */

import type {
  SessionFollowFrame,
  SessionId,
  SessionSummary,
} from '@deepseek-ai/dsh-api-remotes/client'
import type {
  SessionControlFrame,
  SessionQueuedItem,
  SessionState,
} from '@deepseek-ai/dsh-api-session-controller/types'
import { NEXT_PROMPT_COMMAND } from './suggest.ts'

/** Kinds rendered in the terminal conversation. */
export type TranscriptKind = 'user' | 'assistant' | 'reasoning' | 'tool' | 'system' | 'error' | 'turn'

/** Terminal-visible lifecycle of one tool call. */
export type ToolStatus = 'running' | 'ok' | 'error'

/** One renderable transcript row. */
export interface TranscriptItem {
  readonly id: string
  readonly kind: TranscriptKind
  text: string
  title?: string | undefined
  detail?: string | undefined
  toolStatus?: ToolStatus | undefined
  toolArguments?: string | undefined
  toolOutput?: string | undefined
  transient?: boolean | undefined
  /**
   * A `turn` marker's start time in epoch milliseconds. The marker is invisible while the turn
   * runs; when it ends, a turn that used tools keeps it as codex's `Worked for` separator.
   */
  startedAt?: number | undefined
  /** How long a finished turn ran, in milliseconds; set only on a kept `turn` marker. */
  elapsedMs?: number | undefined
  /**
   * On a user item: the last event seq a fork keeps to start over from this message. A turn's
   * first message cuts before its `turn/start`; a message steered into a running turn cuts just
   * before itself.
   */
  forkSeq?: number | undefined
}

/** Token counters shown in the status line. */
export interface TokenStatus {
  /** Prompt-side input that missed the cache and was billed in full. */
  readonly input: number
  readonly output: number
  /** Prompt-side input served from the provider's cache. */
  readonly cacheRead: number
  /** Prompt-side input written into the provider's cache. */
  readonly cacheWrite: number
}

/**
 * Whole-Session conversation figures from the Host's `sessionStats` projection, counted over the
 * durable log so paging and compaction leave them alone. Times are summed wall milliseconds.
 */
export interface SessionStats {
  /** Turns with at least one closed step. */
  readonly turns: number
  /** Closed steps, whatever they ended with. */
  readonly steps: number
  /** Model time over the steps that assembled a message. */
  readonly llmMs: number
  /** Tool time from each call to its result. */
  readonly toolMs: number
  /** First-token latency, summed over `ttftSteps`. */
  readonly ttftMs: number
  readonly ttftSteps: number
  /** Decode time and output tokens over the steps reporting usage. */
  readonly decodeMs: number
  readonly decodeTokens: number
}

const SESSION_STATS_KEYS = ['turns', 'steps', 'llmMs', 'toolMs', 'ttftMs', 'ttftSteps', 'decodeMs', 'decodeTokens'] as const

/** Model identity shown in the status line. */
export interface ModelStatus {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Context occupancy published by the token meter. */
export interface ContextStatus {
  readonly pressureTokens?: number
  readonly projectedTokens?: number
  readonly contextWindow?: number
  readonly systemTokens?: number
  readonly toolsTokens?: number
  readonly messageTokens?: number
}

/** One pending live-Agent input row. */
export interface QueuePrompt {
  readonly id: string
  readonly placement: 'queued' | 'steering' | 'context'
  readonly text: string
  readonly imageCount: number
  readonly fileCount: number
  readonly editable: boolean
  /** A short label the Host gave a message it queued itself, such as a background job's notice. */
  readonly summary?: string | undefined
}

/** Host image-admission limits used by the composer before submission. */
export interface ImageSubmissionLimits {
  readonly maxImageBytes: number
  readonly maxImagesPerMessage: number
  readonly maxMessageImageBytes: number
}

/** Current Session projection retained by the terminal UI. */
export interface TranscriptState {
  sessionId?: SessionId
  title: string
  cwd: string
  running: boolean
  items: TranscriptItem[]
  model?: ModelStatus | undefined
  tokens?: TokenStatus | undefined
  /** Undefined while the Host serves no `sessionStats` value (the plugin is not mounted). */
  stats?: SessionStats | undefined
  context?: ContextStatus | undefined
  permission?: string | undefined
  retryAvailable?: boolean | undefined
  queue: QueuePrompt[]
  imageLimits?: ImageSubmissionLimits | undefined
  liveAssistantId?: string | undefined
  liveReasoningId?: string | undefined
  /**
   * The last seq before the next turn's input entered the log: the latest `turn/end`, or, before
   * the first turn, the event before the first inbox insertion. A fork cut here leaves that
   * input out entirely instead of carrying it over as a pending message.
   */
  turnBoundarySeq?: number | undefined
  /** Ids of command runs the TUI makes for itself, whose results stay out of the transcript. */
  hiddenCommands?: readonly string[] | undefined
}

/** Create an empty transcript. */
export function initialTranscript(): TranscriptState {
  return { title: 'New session', cwd: process.cwd(), running: false, items: [], queue: [] }
}

/** Replace the transcript with the opening snapshot. */
export function applySnapshot(state: TranscriptState, frame: Extract<SessionFollowFrame, { type: 'snapshot' }>): TranscriptState {
  const next: TranscriptState = {
    ...state,
    sessionId: frame.header.id,
    cwd: frame.header.cwd ?? state.cwd,
    items: [],
    queue: [],
    liveAssistantId: undefined,
    liveReasoningId: undefined,
    turnBoundarySeq: undefined,
  }
  next.hiddenCommands = undefined
  for (const record of frame.records) {
    next.hiddenCommands = hiddenAfter(next.hiddenCommands, record.event)
    if (isHidden(next.hiddenCommands, record.event)) continue
    next.items = applyEvent(next.items, record.event, next.turnBoundarySeq)
    next.turnBoundarySeq = boundaryAfter(next.turnBoundarySeq, record.event)
  }
  return applyProjectionValues(next, frame.projections.values)
}

/** Apply one public follow frame and return a new state. */
export function applyFollowFrame(state: TranscriptState, frame: SessionFollowFrame): TranscriptState {
  if (frame.type === 'snapshot') return applySnapshot(state, frame)
  if (frame.type === 'event') {
    const running = runningAfterEvent(state.running, frame.event.type, frame.event.data)
    const hiddenCommands = hiddenAfter(state.hiddenCommands, frame.event)
    return {
      ...state,
      running,
      hiddenCommands,
      items: isHidden(hiddenCommands, frame.event) ? state.items : applyEvent(state.items, frame.event, state.turnBoundarySeq),
      turnBoundarySeq: boundaryAfter(state.turnBoundarySeq, frame.event),
    }
  }
  return applyAssistantStream(state, frame.frame)
}

/** Apply a Session list summary, including cached title/model/token projections. */
export function applySummary(state: TranscriptState, summary: SessionSummary): TranscriptState {
  const values = summary.projections?.values
  return applyProjectionValues({
    ...state,
    cwd: summary.cwd ?? state.cwd,
    running: summary.running,
  }, values)
}

/** Apply Host projection publications only to the currently displayed Session. */
export function applyControlFrame(state: TranscriptState, frame: SessionControlFrame): TranscriptState {
  if (state.sessionId === undefined) return state
  if (frame.type === 'baseline') {
    return applyProjectionValues(state, frame.value.projections[state.sessionId]?.values)
  }
  if (frame.sessionId !== state.sessionId) return state
  return applyProjectionValues(state, Object.fromEntries(frame.changes.map(change => [change.key, change.val])))
}

/** Apply one live execution-state replacement, including durable pending inbox rows. */
export function applySessionState(state: TranscriptState, value: SessionState): TranscriptState {
  return {
    ...state,
    running: value.running,
    queue: (value.queue ?? []).map(queuePrompt),
  }
}

function applyProjectionValues(state: TranscriptState, values: unknown): TranscriptState {
  if (!isRecord(values)) return state
  const title = stringValue(values.title)
  const modelSelection = recordValue(values.modelSelection)
  const selected = modelSelection === undefined ? undefined : recordValue(modelSelection.next) ?? recordValue(modelSelection.lastUsed)
  const provider = selected === undefined ? undefined : stringValue(selected.provider)
  const model = selected === undefined ? undefined : stringValue(selected.model)
  const reasoningEffort = selected === undefined ? undefined : stringValue(selected.reasoningEffort)
  const usage = recordValue(values.tokenUsage)
  const input = usage === undefined ? undefined : numberValue(usage.uncachedInputTokens) ?? numberValue(usage.inputTokens)
  const output = usage === undefined ? undefined : numberValue(usage.outputTokens)
  const cacheRead = usage === undefined ? undefined : numberValue(usage.cacheReadTokens)
  const cacheWrite = usage === undefined ? undefined : numberValue(usage.cacheWriteTokens)
  const stats = sessionStats(values.sessionStats)
  const limitsValue = recordValue(values.imageLimits)
  const maxImageBytes = limitsValue === undefined ? undefined : numberValue(limitsValue.maxImageBytes)
  const maxImagesPerMessage = limitsValue === undefined ? undefined : numberValue(limitsValue.maxImagesPerMessage)
  const maxMessageImageBytes = limitsValue === undefined ? undefined : numberValue(limitsValue.maxMessageImageBytes)
  const contextValue = recordValue(values.contextPressure)
  const breakdownValue = recordValue(values.contextBreakdown)
  const permissionValue = recordValue(values.permissions)
  const permission = permissionValue === undefined ? undefined : stringValue(permissionValue.currentValue)
  const retryAvailable = 'conversationContinuation' in (values as Record<string, unknown>)
    ? values.conversationContinuation !== null
    : undefined
  const queue = queueFromProjection(values.inbox) ?? state.queue
  return {
    ...state,
    ...(title === undefined ? {} : { title }),
    ...(provider === undefined || model === undefined
      ? {}
      : { model: { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) } }),
    ...(input === undefined || output === undefined
      ? {}
      : { tokens: { input, output, cacheRead: cacheRead ?? 0, cacheWrite: cacheWrite ?? 0 } }),
    ...(stats === undefined ? {} : { stats }),
    ...(maxImageBytes === undefined || maxImagesPerMessage === undefined || maxMessageImageBytes === undefined
      ? {}
      : { imageLimits: { maxImageBytes, maxImagesPerMessage, maxMessageImageBytes } }),
    ...(contextValue === undefined && breakdownValue === undefined
      ? {}
      : {
        context: {
          ...contextNumber(contextValue, 'pressureTokens'),
          ...contextNumber(contextValue, 'projectedTokens'),
          ...contextNumber(contextValue, 'contextWindow'),
          ...contextNumber(breakdownValue, 'systemTokens'),
          ...contextNumber(breakdownValue, 'toolsTokens'),
          ...contextNumber(breakdownValue, 'messageTokens'),
        },
      }),
    ...(permission === undefined ? {} : { permission }),
    ...(retryAvailable === undefined ? {} : { retryAvailable }),
    queue,
  }
}

function sessionStats(value: unknown): SessionStats | undefined {
  const record = recordValue(value)
  if (record === undefined) return undefined
  const stats: Partial<Record<keyof SessionStats, number>> = {}
  for (const key of SESSION_STATS_KEYS) {
    const number = numberValue(record[key])
    if (number === undefined) return undefined
    stats[key] = number
  }
  return stats as SessionStats
}

function contextNumber(
  value: Readonly<Record<string, unknown>> | undefined,
  key: keyof Omit<ContextStatus, never>,
): Partial<ContextStatus> {
  const number = value === undefined ? undefined : numberValue(value[key])
  return number === undefined ? {} : { [key]: number }
}

function queueFromProjection(value: unknown): QueuePrompt[] | undefined {
  const inbox = recordValue(value)
  if (inbox === undefined) return undefined
  const result: QueuePrompt[] = []
  addProjectedQueue(result, inbox['next-turn'], 'queued')
  addProjectedQueue(result, inbox['next-step'], 'steering')
  return result
}

function addProjectedQueue(
  target: QueuePrompt[],
  value: unknown,
  placement: QueuePrompt['placement'],
): void {
  if (!Array.isArray(value)) return
  for (const [index, candidate] of value.entries()) {
    const message = recordValue(candidate)
    if (message === undefined) continue
    const blocks = queueBlocks(message.content)
    const source = recordValue(message.source)
    // As the Host's own queue state does: next-step input the operator did not write, such as a
    // background job's completion notice, is context for the model, not a steer to recall.
    if (placement === 'steering' && source !== undefined && source.kind !== 'user') {
      const summary = stringValue(source.summary)
      target.push({
        id: stringValue(message.id) ?? `context-${String(index)}`,
        placement: 'context',
        ...blocks,
        editable: false,
        ...(summary === undefined || summary.trim() === '' ? {} : { summary }),
      })
      continue
    }
    target.push({
      id: stringValue(message.id) ?? `${placement}-${String(index)}`,
      placement,
      ...blocks,
    })
  }
}

function queuePrompt(item: SessionQueuedItem): QueuePrompt {
  return {
    id: String(item.id),
    placement: item.placement,
    ...queueBlocks(item.content),
    ...(item.placement === 'context' ? { editable: false } : {}),
  }
}

function queueBlocks(content: unknown): Pick<QueuePrompt, 'text' | 'imageCount' | 'fileCount' | 'editable'> {
  if (!Array.isArray(content)) return { text: '', imageCount: 0, fileCount: 0, editable: false }
  const texts: string[] = []
  let imageCount = 0
  let fileCount = 0
  for (const candidate of content) {
    const block = recordValue(candidate)
    if (block === undefined) continue
    if (block.type === 'text') {
      const text = stringValue(block.text)
      if (text !== undefined) texts.push(text)
    }
    if (block.type === 'image') {
      imageCount += 1
      const name = recordValue(block.attachment)?.name
      const label = stringValue(name)
      if (label !== undefined) texts.push(`[Image] ${label}`)
    }
    if (block.type === 'file') {
      fileCount += 1
      const name = recordValue(block.attachment)?.name
      const label = stringValue(name)
      if (label !== undefined) texts.push(`[File] ${label}`)
    }
  }
  return {
    text: texts.join('\n'),
    imageCount,
    fileCount,
    editable: imageCount === 0 && fileCount === 0,
  }
}

function applyAssistantStream(
  state: TranscriptState,
  frame: Extract<SessionFollowFrame, { type: 'assistant-stream' }>['frame'],
): TranscriptState {
  if (frame.type === 'start') {
    return { ...state, liveAssistantId: undefined, liveReasoningId: undefined }
  }
  if (frame.type === 'end') {
    return { ...state, liveAssistantId: undefined, liveReasoningId: undefined }
  }
  const chunk = recordValue(frame.chunk)
  if (chunk === undefined) return state
  const type = stringValue(chunk.type)
  const text = stringValue(chunk.text)
  if (text === undefined) return state
  if (type === 'text-delta') {
    return appendLive(state, 'assistant', 'liveAssistantId', text)
  }
  if (type === 'reasoning-delta') {
    return appendLive(state, 'reasoning', 'liveReasoningId', text)
  }
  return state
}

function appendLive(
  state: TranscriptState,
  kind: 'assistant' | 'reasoning',
  key: 'liveAssistantId' | 'liveReasoningId',
  text: string,
): TranscriptState {
  const existingId = state[key]
  if (existingId !== undefined) {
    const index = state.items.findIndex(item => item.id === existingId)
    if (index >= 0) {
      const items = [...state.items]
      const existing = items[index]
      if (existing === undefined) return state
      items[index] = { ...existing, text: existing.text + text }
      return { ...state, items }
    }
  }
  const id = `${kind}-live-${String(state.items.length)}`
  return {
    ...state,
    [key]: id,
    items: [...state.items, { id, kind, text, transient: true }],
  }
}

function applyEvent(
  items: TranscriptItem[],
  event: { readonly type: string; readonly seq: number; readonly time?: number; readonly data: unknown },
  boundarySeq?: number,
): TranscriptItem[] {
  if (event.type === 'turn/start') {
    return [...items, { id: `turn-${String(event.seq)}`, kind: 'turn', text: '', startedAt: event.time }]
  }
  if (event.type === 'turn/end') return endTurn(items, event.time)
  const data = recordValue(event.data)
  if (data === undefined) return items
  if (event.type === 'user/message') {
    const source = recordValue(data.source)
    if (source?.kind !== 'user' && source?.kind !== 'retry') return items
    const text = messageBlocks(data.content).text
    if (text.trim() === '') return items
    return [...items, { id: `user-${String(event.seq)}`, kind: 'user', text, forkSeq: forkSeqFor(items, event.seq, boundarySeq) }]
  }
  if (event.type === 'assistant/message') {
    const message = recordValue(data.message)
    if (message === undefined) return items
    const blocks = messageBlocks(message.content)
    const withoutLive = items.filter(item => item.transient !== true)
    const next = [...withoutLive]
    if (blocks.reasoning.trim() !== '') {
      next.push({ id: `reasoning-${String(event.seq)}`, kind: 'reasoning', text: blocks.reasoning })
    }
    if (blocks.text.trim() !== '') {
      next.push({ id: `assistant-${String(event.seq)}`, kind: 'assistant', text: blocks.text })
    }
    return next
  }
  if (event.type === 'assistant/attempt') {
    return [...items, {
      id: `attempt-${String(event.seq)}`,
      kind: 'error',
      title: 'Model attempt ended without a message',
      text: '',
    }]
  }
  if (event.type === 'tool/call') {
    const name = stringValue(data.name) ?? 'tool'
    const callId = stringValue(data.callId) ?? `call-${String(event.seq)}`
    const args = stringValue(data.arguments) ?? ''
    return [...items, {
      id: `tool-${callId}`,
      kind: 'tool',
      title: name,
      text: summarizeToolArguments(name, args),
      detail: args,
      toolStatus: 'running',
      toolArguments: args,
    }]
  }
  if (event.type === 'tool/result') {
    const message = recordValue(data.message)
    if (message === undefined) return items
    const text = messageBlocks(message.content).text
    const callId = recordValue(message.source)?.callId
    const id = stringValue(callId) ?? `result-${String(event.seq)}`
    const toolStatus: ToolStatus = message.isError === true ? 'error' : 'ok'
    const index = items.findIndex(item => item.kind === 'tool' && item.id === `tool-${id}`)
    if (index >= 0) {
      const next = [...items]
      const existing = next[index]
      if (existing === undefined) return next
      next[index] = {
        ...existing,
        detail: text,
        text: summarizeToolOutput(text, toolStatus),
        toolStatus,
        toolOutput: text,
      }
      return next
    }
    // A result whose call is not in view (a snapshot cut between them) joins the transcript
    // as its own row; it must not replace everything shown so far.
    return [...items, {
      id: `tool-result-${String(event.seq)}`,
      kind: 'tool',
      title: 'tool result',
      text: summarizeToolOutput(text, toolStatus),
      detail: text,
      toolStatus,
      toolOutput: text,
    }]
  }
  if (event.type === 'command/done') {
    const text = stringValue(data.text)
    const kind = stringValue(data.kind)
    if (text === undefined || text.trim() === '') return items
    return [...items, { id: `command-${String(event.seq)}`, kind: kind === 'error' ? 'error' : 'system', text }]
  }
  return items
}

/**
 * Settle the open turn marker, as codex's final-message separator: a turn that ran tools keeps
 * it just above its final answer, so the answer stands apart from the work; a turn that only
 * talked drops it.
 * @param items - the transcript, holding the marker `turn/start` added.
 * @param time - when the turn ended, in epoch milliseconds.
 * @returns the transcript with the marker placed or removed.
 */
function endTurn(items: TranscriptItem[], time: number | undefined): TranscriptItem[] {
  const start = items.findLastIndex(item => item.kind === 'turn' && item.elapsedMs === undefined)
  const marker = items[start]
  if (marker === undefined) return items
  const next = [...items.slice(0, start), ...items.slice(start + 1)]
  const turn = next.slice(start)
  const lastTool = turn.findLastIndex(item => item.kind === 'tool')
  if (lastTool < 0 || marker.startedAt === undefined || time === undefined) return next
  const answer = turn.findLastIndex(item => item.kind === 'assistant')
  const at = start + (answer > lastTool ? answer : turn.length)
  next.splice(at, 0, { ...marker, elapsedMs: Math.max(0, time - marker.startedAt) })
  return next
}

/**
 * Where a fork that restarts from a new user message should cut the log.
 *
 * A turn's input is spliced into the inbox before its `turn/start`, so the first message of a
 * turn cuts at the turn boundary before that splice; cutting at `turn/start` would keep the
 * message as a pending inbox entry in the fork. A message steered into a running turn cuts
 * just before itself.
 * @param items - the transcript before the message.
 * @param seq - the message's event seq.
 * @param boundarySeq - the latest turn boundary, when the loaded history holds one.
 * @returns the last seq to keep.
 */
function forkSeqFor(items: readonly TranscriptItem[], seq: number, boundarySeq: number | undefined): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item === undefined || item.kind === 'user') break
    if (item.kind === 'turn' && item.elapsedMs === undefined) {
      const start = Number(item.id.slice('turn-'.length))
      if (boundarySeq !== undefined && boundarySeq < start) return boundarySeq
      if (Number.isInteger(start)) return start - 1
    }
  }
  return seq - 1
}

/**
 * Advance the turn boundary past one event.
 * @param boundary - the boundary before the event.
 * @param event - the event.
 * @returns the boundary after it.
 */
function boundaryAfter(
  boundary: number | undefined,
  event: { readonly type: string; readonly seq: number; readonly data: unknown },
): number | undefined {
  if (event.type === 'turn/end') return event.seq
  if (boundary === undefined && event.type === 'agent/inbox/spliced') {
    const inserted = recordValue(event.data)?.inserted
    if (Array.isArray(inserted) && inserted.length > 0) return event.seq - 1
  }
  return boundary
}

/** Command names whose runs the TUI makes for itself. */
const INTERNAL_COMMANDS: ReadonlySet<string> = new Set([NEXT_PROMPT_COMMAND])
const HIDDEN_COMMANDS_KEPT = 16

/** Remember the id of an internal command run, so its `command/done` can be left out. */
function hiddenAfter(
  hidden: readonly string[] | undefined,
  event: { readonly type: string; readonly data: unknown },
): readonly string[] | undefined {
  if (event.type !== 'command/run') return hidden
  const data = recordValue(event.data)
  const name = stringValue(data?.name)
  const id = stringValue(data?.commandId)
  if (name === undefined || id === undefined || !INTERNAL_COMMANDS.has(name)) return hidden
  return [...(hidden ?? []), id].slice(-HIDDEN_COMMANDS_KEPT)
}

function isHidden(hidden: readonly string[] | undefined, event: { readonly type: string; readonly data: unknown }): boolean {
  if (hidden === undefined || (event.type !== 'command/run' && event.type !== 'command/done')) return false
  const id = stringValue(recordValue(event.data)?.commandId)
  return id !== undefined && hidden.includes(id)
}

function runningAfterEvent(running: boolean, type: string, data: unknown): boolean {
  void data
  if (type === 'turn/start') return true
  if (type === 'turn/end') return false
  return running
}

function messageBlocks(content: unknown): { text: string; reasoning: string } {
  if (!Array.isArray(content)) return { text: '', reasoning: '' }
  const text: string[] = []
  const reasoning: string[] = []
  let imageIndex = 0
  for (const block of content) {
    const value = recordValue(block)
    const blockText = value === undefined ? undefined : stringValue(value.text)
    if (value?.type === 'text' && blockText !== undefined) text.push(blockText)
    if (value?.type === 'reasoning' && blockText !== undefined) reasoning.push(blockText)
    if (value?.type === 'image') {
      imageIndex += 1
      const attachment = recordValue(value.attachment)
      const name = attachment === undefined ? undefined : stringValue(attachment.name)
      text.push(name === undefined ? `[Image ${String(imageIndex)}]` : `[Image ${String(imageIndex)}] ${name}`)
    }
  }
  return { text: text.join('\n'), reasoning: reasoning.join('\n') }
}

function preview(value: string): string {
  const normalized = value.replaceAll(/\s+/gu, ' ').trim()
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 157)}...`
}

function summarizeToolArguments(name: string, argumentsText: string): string {
  const parsed = parseJson(argumentsText)
  if (parsed !== undefined) {
    for (const key of ['command', 'cmd', 'description', 'path', 'file_path', 'query', 'url', 'code']) {
      const value = parsed[key]
      if (typeof value !== 'string' || value.trim() === '') continue
      return preview(key === 'code' ? `${key}: ${firstLine(value)}` : `${key}: ${value}`)
    }
  }
  const fallback = argumentsText.trim()
  return fallback === '' ? `${name} started` : preview(fallback)
}

function summarizeToolOutput(output: string, status: ToolStatus): string {
  const first = firstLine(output)
  if (first !== '') return preview(first)
  return status === 'error' ? 'Tool failed' : 'Completed'
}

function firstLine(value: string): string {
  return value.split(/\r?\n/u).map(line => line.trim()).find(line => line !== '') ?? ''
}

function parseJson(value: string): Readonly<Record<string, unknown>> | undefined {
  try {
    return recordValue(JSON.parse(value))
  } catch (_invalidJson) {
    // Non-JSON arguments remain opaque text; validate only decoded JSON objects.
    return undefined
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isRecord(value) ? value : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** What Esc does with the steer messages a cancelled turn had not read yet. */
export type SteerResend =
  | { readonly kind: 'none' }
  | { readonly kind: 'behind-queue' | 'attachments' }
  | { readonly kind: 'send'; readonly items: readonly QueuePrompt[]; readonly text: string }

/**
 * Decide how to resend unread steer messages after an interrupt, as codex submits pending
 * steers as one new turn.
 *
 * A resend joins the back of the Host queue and carries text only, so the steers stay put when
 * queued messages are ahead of them (the resend would run after those) or when one of them has
 * attachments.
 * @param queue - the pending messages when Esc was pressed.
 * @returns the steers to remove and the merged text to send, or why they stay.
 */
export function steerResend(queue: readonly QueuePrompt[]): SteerResend {
  const steers = queue.filter(item => item.placement === 'steering')
  if (steers.length === 0) return { kind: 'none' }
  if (queue.some(item => item.placement === 'queued')) return { kind: 'behind-queue' }
  if (steers.some(item => !item.editable)) return { kind: 'attachments' }
  const text = steers.map(item => item.text.trim()).filter(part => part !== '').join('\n\n')
  return text === '' ? { kind: 'none' } : { kind: 'send', items: steers, text }
}
