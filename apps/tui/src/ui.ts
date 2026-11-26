/** Shared terminal interaction models. */

import type {
  ModelCatalog,
  SessionSummary,
} from '@deepseek-ai/dsh-api-remotes/client'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  AskUserQuestionItem,
} from '@deepseek-ai/dsh-user-questions/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/types'
import type { QueuePrompt } from './transcript.ts'

/** Approval fields presented by the terminal UI. */
export interface ApprovalUiRequest {
  readonly toolName: string
  readonly callId?: ToolCallId
  readonly reason?: string
  readonly displayReason?: { readonly en: string; readonly [locale: string]: string }
  readonly signal?: AbortSignal
}

/** User-question fields presented by the terminal UI. */
export interface QuestionUiRequest {
  readonly questions: AskUserQuestionItem[]
  readonly signal?: AbortSignal
  readonly wait?: {
    readonly callId: ToolCallId
    readonly timed?: boolean
  }
}

/** One reasoning depth a model route accepts. */
export interface ModelEffortChoice {
  /** Effort identifier sent to the host. */
  readonly id: string
  /** Operator-facing label. */
  readonly name: string
  /** Optional explanation of when the effort suits a task. */
  readonly description?: string
}

/** One selectable model and its provider, plus the reasoning depths it accepts. */
export interface ModelChoice {
  readonly provider: string
  readonly providerName: string
  readonly model: string
  readonly modelName: string
  /** Depths this route accepts; empty when the model has no reasoning control. */
  readonly efforts: readonly ModelEffortChoice[]
  /** Depth the host applies when the selection names none. */
  readonly defaultEffort?: string
}

/** Session picker state. */
export interface SessionPicker {
  readonly kind: 'sessions'
  readonly items: readonly SessionSummary[]
  index: number
}

/**
 * Model picker state.
 *
 * The picker runs in two stages so a model and its reasoning depth are chosen
 * together, mirroring how Codex offers the depth per model instead of as a
 * separate setting: `stage` is `'model'` while choosing the route and
 * `'effort'` while choosing its depth.
 */
export interface ModelPicker {
  readonly kind: 'models'
  readonly items: readonly ModelChoice[]
  index: number
  /** Stage currently accepting input. */
  stage: 'model' | 'effort'
  /** Route picked in the model stage, once `stage` is `'effort'`. */
  readonly chosen?: ModelChoice
  /** Depth highlighted in the effort stage. */
  effortIndex: number
}

/** Pending queue manager. */
export interface QueuePicker {
  readonly kind: 'queue'
  readonly items: readonly QueuePrompt[]
  index: number
}

/** A prompt awaiting Host admission. */
export interface PendingSubmission {
  readonly mode: 'queue' | 'steer'
  readonly text: string
  readonly imageCount: number
}

/** One `/` completion candidate from the local TUI, Host commands, or skills. */
export interface SlashSuggestion {
  readonly name: string
  readonly description: string
  readonly source: 'local' | 'command' | 'skill'
  /** Host command declaring `input.attachments`; only such a name may carry composer images. */
  readonly attachments?: boolean
}

/** Approval overlay state and its unresolved waterfall result. */
export interface ApprovalPrompt {
  readonly kind: 'approval'
  readonly request: ApprovalUiRequest
  readonly resolve: (outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable') => void
}

/** One question-answer editor inside a request batch. */
export interface QuestionProgress {
  readonly question: AskUserQuestionItem
  index: number
  mode: 'options' | 'custom'
  selected: Set<string>
  custom: string
}

/** Structured-question overlay and its unresolved waterfall result. */
export interface QuestionPrompt {
  readonly kind: 'question'
  readonly request: QuestionUiRequest
  readonly progress: QuestionProgress[]
  readonly answers: AskUserQuestionAnswerItem[]
  questionIndex: number
  readonly resolve: (answer: AskUserQuestionAnswer) => void
  readonly reject: (error: Error) => void
}

/** The `/status` panel's tabs, in the order Tab and the arrows walk them. */
export const STATUS_TABS = ['status', 'stats', 'context'] as const

/** One `/status` tab. */
export type StatusTab = typeof STATUS_TABS[number]

/** The `/status` panel: tabs over live Session readings, redrawn as they change. */
export interface StatusPanel {
  readonly kind: 'status'
  tab: StatusTab
}

/** Current modal interaction, if any. */
export type Overlay = SessionPicker | ModelPicker | QueuePicker | StatusPanel | ApprovalPrompt | QuestionPrompt

/**
 * Flatten a model catalog into picker rows, carrying each route's reasoning depths.
 * @param catalog - host model catalog.
 * @returns one row per model, in catalog order.
 */
export function modelChoices(catalog: ModelCatalog): readonly ModelChoice[] {
  return catalog.groups.flatMap(group => group.models.map(model => ({
    provider: group.id,
    providerName: group.name,
    model: model.id,
    modelName: model.name,
    efforts: (model.reasoning?.efforts ?? []).map(effort => ({
      id: effort.id,
      name: effort.name,
      ...(effort.description === undefined ? {} : { description: effort.description }),
    })),
    ...(model.reasoning?.defaultEffort === undefined ? {} : { defaultEffort: model.reasoning.defaultEffort }),
  })))
}

/**
 * The effort index to highlight for one route.
 * @param choice - route whose depths are offered.
 * @param current - depth already selected for this Session, if any.
 * @returns the index of the current default depth, else the host default, else the first.
 */
export function defaultEffortIndex(choice: ModelChoice, current?: string): number {
  const wanted = current ?? choice.defaultEffort
  if (wanted === undefined) return 0
  const found = choice.efforts.findIndex(effort => effort.id === wanted)
  return found < 0 ? 0 : found
}
