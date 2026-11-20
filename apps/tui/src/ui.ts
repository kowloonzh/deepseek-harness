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

/** One selectable model and its provider. */
export interface ModelChoice {
  readonly provider: string
  readonly providerName: string
  readonly model: string
  readonly modelName: string
}

/** Session picker state. */
export interface SessionPicker {
  readonly kind: 'sessions'
  readonly items: readonly SessionSummary[]
  index: number
}

/** Model picker state. */
export interface ModelPicker {
  readonly kind: 'models'
  readonly items: readonly ModelChoice[]
  index: number
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

/** Current modal interaction, if any. */
export type Overlay = SessionPicker | ModelPicker | QueuePicker | ApprovalPrompt | QuestionPrompt

/** Flatten a model catalog into picker rows. */
export function modelChoices(catalog: ModelCatalog): readonly ModelChoice[] {
  return catalog.groups.flatMap(group => group.models.map(model => ({
    provider: group.id,
    providerName: group.name,
    model: model.id,
    modelName: model.name,
  })))
}
