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

/** Kinds rendered in the terminal conversation. */
export type TranscriptKind = 'user' | 'assistant' | 'reasoning' | 'tool' | 'system' | 'error'

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
  context?: ContextStatus | undefined
  permission?: string | undefined
  retryAvailable?: boolean | undefined
  queue: QueuePrompt[]
  imageLimits?: ImageSubmissionLimits | undefined
  liveAssistantId?: string | undefined
  liveReasoningId?: string | undefined
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
  }
  for (const record of frame.records) next.items = applyEvent(next.items, record.event)
  return applyProjectionValues(next, frame.projections.values)
}

/** Apply one public follow frame and return a new state. */
export function applyFollowFrame(state: TranscriptState, frame: SessionFollowFrame): TranscriptState {
  if (frame.type === 'snapshot') return applySnapshot(state, frame)
  if (frame.type === 'event') {
    const running = runningAfterEvent(state.running, frame.event.type, frame.event.data)
    return { ...state, running, items: applyEvent(state.items, frame.event) }
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
  event: { readonly type: string; readonly seq: number; readonly data: unknown },
): TranscriptItem[] {
  const data = recordValue(event.data)
  if (data === undefined) return items
  if (event.type === 'user/message') {
    const source = recordValue(data.source)
    if (source?.kind !== 'user' && source?.kind !== 'retry') return items
    const text = messageBlocks(data.content).text
    if (text.trim() === '') return items
    return [...items, { id: `user-${String(event.seq)}`, kind: 'user', text }]
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
    return [{
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
