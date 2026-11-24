/** Minimal alternate-screen terminal application over the public DSH Client Remote API. */

import { readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import type {
  ModelCatalog,
  SessionId,
  SessionSummary,
} from '@deepseek-ai/dsh-api-remotes/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  AskUserQuestionAnswerItem,
} from '@deepseek-ai/dsh-user-questions/types'
import type { PromptContentPart } from '@deepseek-ai/dsh-api-session-controller/types'
import { readClipboard, writeClipboardText, type ClipboardImage } from './clipboard.ts'
import { TuiRemoteClient } from './remote.ts'
import { localized, messages } from './locale.ts'
import { ReadlineEditor } from './readline.ts'
import { runShellLine, shellLine, shellResultText } from './shell.ts'
import { HerdrReporter } from './herdr.ts'
import { TuiError } from './error.ts'
import {
  cacheHitPercent,
  selectedText,
  TerminalRenderer,
  type RenderedFrame,
  type TerminalPoint,
  type TerminalSelection,
} from './render.ts'
import {
  applyFollowFrame,
  applyControlFrame,
  applySessionState,
  applySummary,
  initialTranscript,
  type QueuePrompt,
  type TranscriptState,
} from './transcript.ts'
import {
  defaultEffortIndex,
  modelChoices,
  type ApprovalUiRequest,
  type ApprovalPrompt,
  type ModelChoice,
  type ModelPicker,
  type Overlay,
  type PendingSubmission,
  type QuestionPrompt,
  type QuestionUiRequest,
  type SlashSuggestion,
  type SessionPicker,
} from './ui.ts'

const LOCAL_COMMANDS = ['help', 'new', 'resume', 'model', 'compact', 'status', 'context', 'queue', 'retry', 'exit'] as const
/**
 * Aliases the terminal accepts without listing them in the slash menu.
 * `/quit` and `/q` are kept so existing habits, launcher scripts, and panes keep working.
 */
const LOCAL_COMMAND_ALIASES: Readonly<Record<string, (typeof LOCAL_COMMANDS)[number]>> = {
  quit: 'exit',
  q: 'exit',
}
const LOCAL_COMMAND_DESCRIPTIONS: Readonly<Record<(typeof LOCAL_COMMANDS)[number], string>> = {
  help: 'Show commands',
  new: 'Create a new session',
  resume: 'Choose a recent session',
  model: 'Choose a model',
  compact: 'Compact the current session',
  status: 'Show session status',
  context: 'Show context and token usage',
  queue: 'Manage pending messages',
  retry: 'Continue the latest failed turn',
  exit: 'Exit the TUI',
}
const MOUSE_TRACKING_ON = '\u001b[?1000h\u001b[?1002h\u001b[?1006h'
const MOUSE_TRACKING_OFF = '\u001b[?1000l\u001b[?1002l\u001b[?1006l'
const DEFAULT_IMAGE_LIMITS = {
  maxImageBytes: 50 * 1024 * 1024,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 200 * 1024 * 1024,
} as const
/** Grace after `stop` for `dispose` to finish before the process exits anyway. */
const FINAL_EXIT_GRACE_MS = 3_000

function compareSlashSuggestions(
  query: string,
  left: SlashSuggestion,
  right: SlashSuggestion,
): number {
  const match = slashMatchRank(query, left) - slashMatchRank(query, right)
  if (match !== 0) return match
  const source = slashSourceRank(left) - slashSourceRank(right)
  if (source !== 0) return source
  if (left.source === 'local' && right.source === 'local') {
    const leftIndex = LOCAL_COMMANDS.findIndex(command => command === left.name)
    const rightIndex = LOCAL_COMMANDS.findIndex(command => command === right.name)
    return leftIndex - rightIndex
  }
  return left.name.localeCompare(right.name)
}

function slashMatchRank(query: string, suggestion: SlashSuggestion): number {
  if (query === '') return 0
  const name = suggestion.name.toLowerCase()
  if (name === query) return 0
  if (name.startsWith(query)) return 1
  if (suggestion.description.toLowerCase().includes(query)) return 2
  return 3
}

function slashSourceRank(suggestion: SlashSuggestion): number {
  if (suggestion.source === 'local') return 0
  if (suggestion.source === 'command') return 1
  return 2
}

/** Parsed TUI-only arguments. */
export interface TuiArguments {
  readonly help: boolean
  readonly resume: string | true | undefined
  /** Initial prompt submitted once the Session is open and the terminal is raw. */
  readonly prompt: string | undefined
}

/** Parse arguments after `dsh tui`. */
export function parseTuiArguments(args: readonly string[]): TuiArguments {
  let resume: string | true | undefined
  let prompt: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) continue
    if (arg === '--help' || arg === '-h') return { help: true, resume: undefined, prompt: undefined }
    if (arg === '--prompt' || arg === '-p') {
      const next = args[index + 1]
      if (next !== undefined) {
        prompt = next
        index += 1
      }
      continue
    }
    if (arg === '--resume' || arg === '-r') {
      const next = args[index + 1]
      if (next !== undefined && !next.startsWith('-')) {
        resume = next
        index += 1
      } else {
        resume = true
      }
      continue
    }
    if (arg.startsWith('--resume=')) {
      const value = arg.slice('--resume='.length)
      resume = value === '' ? true : value
    }
  }
  return { help: false, resume, prompt }
}

/** Terminal application over one connected Remote client and owned host. */
export class TuiApp {
  private state: TranscriptState = initialTranscript()
  private defaultModel: TranscriptState['model']
  private readonly editor = new ReadlineEditor()
  private draftImages: ClipboardImage[] = []
  private history: string[] = []
  private historyIndex = 0
  private overlay: Overlay | undefined
  private readonly queuedInteractions: Array<ApprovalPrompt | QuestionPrompt> = []
  private readonly scroll = { value: 0 }
  private readonly renderer = new TerminalRenderer()
  private readonly expandedTools = { value: false }
  private notice: string | undefined
  private followAbort: AbortController | undefined
  private readonly subscriptions = new Set<Promise<void>>()
  private renderTimer: NodeJS.Timeout | undefined
  private renderMode: 'full' | 'incremental' = 'full'
  private stopped = false
  private ctrlCPending = false
  private clipboardBusy = false
  private selection: (TerminalSelection & { dragging: boolean }) | undefined
  private lastFrame: RenderedFrame | undefined
  private submission: PendingSubmission | undefined
  private queueEditId: string | undefined
  private slashSuggestions: SlashSuggestion[] = []
  private slashIndex = 0
  private slashLoading = false
  private slashCatalogAbort: AbortController | undefined
  private readonly terminalCleanup: () => void
  private readonly herdr: HerdrReporter
  /** Non-interactive bootstrap requested by `--prompt`; cleared once accepted. */
  private bootstrap: { readonly prompt: string; readonly thenExit: boolean } | undefined
  /** A `--prompt` submission may be steered or aborted while it is in flight. */
  private bootstrapPending = false
  /** This app was launched by the manager with `--prompt`; its exit is one-shot. */
  private readonly bootstrapRun: boolean
  /** Upper bound on teardown after `stop`, so a stuck host close cannot trap the terminal. */
  private exitTimer: NodeJS.Timeout | undefined
  private startupRendered = false

  private constructor(
    private readonly remote: TuiRemoteClient,
    private readonly hostClose: () => Promise<void>,
    private readonly stdin: NodeJS.ReadStream,
    private readonly stdout: NodeJS.WriteStream,
    env: NodeJS.ProcessEnv,
    bootstrap?: { readonly prompt: string; readonly thenExit: boolean },
  ) {
    this.terminalCleanup = this.enterTerminal()
    this.herdr = new HerdrReporter(env)
    this.bootstrap = bootstrap
    this.bootstrapRun = bootstrap !== undefined
  }

  private get input(): string {
    return this.editor.text
  }

  private get inputCursor(): number {
    return this.editor.cursor
  }

  /**
   * Connect and run until the user exits or a signal stops the application.
   * @param options - Remote client, host cleanup, optional bootstrap prompt, and terminal streams.
   * @returns process exit code.
   */
  static async run(options: {
    readonly remote: TuiRemoteClient
    readonly hostClose: () => Promise<void>
    readonly resume: string | true | undefined
    readonly prompt?: string | undefined
    readonly stdin?: NodeJS.ReadStream
    readonly stdout?: NodeJS.WriteStream
    readonly env?: NodeJS.ProcessEnv
    readonly onApp?: (app: TuiApp) => void
  }): Promise<number> {
    const app = new TuiApp(
      options.remote,
      options.hostClose,
      options.stdin ?? process.stdin,
      options.stdout ?? process.stdout,
      options.env ?? process.env,
      options.prompt === undefined ? undefined : { prompt: options.prompt, thenExit: true },
    )
    options.onApp?.(app)
    try {
      await app.openInitialSession(options.resume)
      app.bindInput()
      app.bindSignals()
      app.requestRender()
      app.startBootstrap()
      return await app.waitForExit()
    } finally {
      await app.dispose()
    }
  }

  private async openInitialSession(resume: string | true | undefined): Promise<void> {
    void this.loadDefaultModel()
    const summaries = await this.remote.listSessions()
    let sessionId: SessionId | undefined
    if (typeof resume === 'string') {
      sessionId = brandString<SessionId>(resume)
    } else if (resume === true) {
      sessionId = summaries[0]?.sessionId
    } else {
      sessionId = undefined
    }
    if (sessionId === undefined) {
      sessionId = await this.remote.createSession(process.cwd())
    }
    const summary = summaries.find(item => item.sessionId === sessionId)
    this.switchSession(sessionId, false)
    if (summary !== undefined) this.state = applySummary(this.state, summary)
  }

  private async loadDefaultModel(): Promise<void> {
    try {
      this.defaultModel = (await this.remote.modelCatalog()).default
      if (this.state.model === undefined && this.state.sessionId !== undefined) {
        this.state = { ...this.state, model: this.defaultModel }
        this.requestRender()
      }
    } catch (error) {
      this.setNotice(friendlyError(error))
    }
  }

  private bindInput(): void {
    this.stdin.on('data', this.onData)
    this.stdout.on('resize', this.onResize)
  }

  private readonly onResize = (): void => {
    // A resized terminal invalidates every row position, and the pane that resized the tty
    // may not have reported the new size when the pending incremental frame was queued.
    // Rebuilding the whole screen makes the paint independent of whether that frame ran
    // against the previous dimensions.
    this.requestRender(false)
  }

  private readonly onData = (data: Buffer): void => {
    for (const key of decodeTerminalInput(data.toString())) {
      this.onKeypress(key.sequence ?? '', key)
    }
  }

  private bindSignals(): void {
    process.once('SIGTERM', this.onSignal)
    process.once('SIGINT', this.onSignal)
  }

  private readonly onSignal = (): void => {
    // Server exit status carries SIGTERM (143); normal exits must not look killed.
    this.stop(143)
  }

  private readonly onKeypress = (sequence: string, key: Key): void => {
    if (this.stopped) return
    if (key.name === 'paste-start' || key.name === 'paste-end') return
    if (key.name === 'key-release') return
    if (key.mouse !== undefined) {
      this.handleMouse(key.mouse)
      return
    }
    if (key.ctrl && key.name === 'c' && this.selection !== undefined) {
      void this.copySelection()
      return
    }
    if (key.ctrl && key.name === 'c' && this.bootstrapPending) {
      void this.interrupt()
      return
    }
    if (key.name === 'escape' && this.bootstrapPending) {
      void this.interrupt()
      this.requestRender()
      return
    }
    if (this.selection !== undefined) this.clearSelection()
    if (this.submission !== undefined) return
    if (!(key.ctrl && key.name === 'c')) this.ctrlCPending = false
    if (this.overlay !== undefined) {
      this.handleOverlayKey(sequence, key)
      this.requestRender()
      return
    }
    if (key.ctrl && key.name === 'c') {
      this.handleCtrlC()
      return
    }
    if (key.ctrl && key.name === 'd' && this.input === '') {
      this.stop(0)
      return
    }
    if (key.ctrl && key.name === 'd') {
      this.editor.deleteForward()
      this.requestRender()
      return
    }
    if ((key.ctrl || key.meta) && key.name === 'v') {
      void this.pasteClipboard()
      return
    }
    if (key.name === 'escape') {
      if (this.queueEditId !== undefined) {
        this.queueEditId = undefined
        this.editor.clear()
        this.setNotice(messages.queueEditCancelled)
        return
      }
      if (this.scroll.value > 0) {
        this.scroll.value = 0
        this.requestRender()
        return
      }
      // Escape only stops things: it clears the notice, and it interrupts a running
      // turn. Sending is Enter's job, and interrupting *and* sending is Ctrl+Enter's.
      if (this.state.running) void this.interrupt()
      else this.setNotice(undefined)
      this.requestRender()
      return
    }
    if (this.slashMenuOpen()) {
      const suggestions = this.visibleSlashSuggestions()
      if (key.name === 'up') {
        this.slashIndex = Math.max(0, this.slashIndex - 1)
        this.requestRender()
        return
      }
      if (key.name === 'down') {
        this.slashIndex = Math.min(Math.max(0, suggestions.length - 1), this.slashIndex + 1)
        this.requestRender()
        return
      }
      if (key.name === 'tab' && suggestions.length > 0) {
        this.acceptSlashSuggestion(false)
        return
      }
      if ((key.name === 'return' || key.name === 'enter') && !key.ctrl && !key.meta && !key.shift
        && suggestions.length > 0) {
        this.acceptSlashSuggestion(true)
        return
      }
    }
    if (key.ctrl && key.name === 'o') {
      this.expandedTools.value = !this.expandedTools.value
      this.requestRender()
      return
    }
    if (key.name === 'pageup') {
      this.selection = undefined
      this.scroll.value += 10
      this.requestRender()
      return
    }
    if (key.meta && key.name === 'up') {
      void this.recallLatestQueue()
      return
    }
    if (key.name === 'pagedown') {
      this.selection = undefined
      this.scroll.value = Math.max(0, this.scroll.value - 10)
      this.requestRender()
      return
    }
    if (key.name === 'wheel-up') {
      this.selection = undefined
      this.scroll.value += 1
      this.requestRender()
      return
    }
    if (key.name === 'wheel-down') {
      this.selection = undefined
      this.scroll.value = Math.max(0, this.scroll.value - 1)
      this.requestRender()
      return
    }
    if (key.name === 'mouse-other') return
    if (key.name === 'up') {
      this.moveHistory(1)
      return
    }
    if (key.name === 'down') {
      this.moveHistory(-1)
      return
    }
    if (key.ctrl && key.name === 'p') {
      this.moveHistory(1)
      return
    }
    if (key.ctrl && key.name === 'n') {
      this.moveHistory(-1)
      return
    }
    if (key.name === 'left') {
      if (key.meta || key.ctrl) this.editor.moveWordLeft()
      else this.editor.moveLeft()
      this.requestRender()
      return
    }
    if (key.name === 'right') {
      if (key.meta || key.ctrl) this.editor.moveWordRight()
      else this.editor.moveRight()
      this.requestRender()
      return
    }
    if (key.name === 'home' || (key.ctrl && key.name === 'a')) {
      this.editor.moveLineStart()
      this.requestRender()
      return
    }
    if (key.name === 'end' || (key.ctrl && key.name === 'e')) {
      this.editor.moveLineEnd()
      this.requestRender()
      return
    }
    if (key.ctrl && key.name === 'b') {
      this.editor.moveLeft()
      this.requestRender()
      return
    }
    if (key.ctrl && key.name === 'f') {
      this.editor.moveRight()
      this.requestRender()
      return
    }
    if (key.meta && key.name === 'b') {
      this.editor.moveWordLeft()
      this.requestRender()
      return
    }
    if (key.meta && key.name === 'f') {
      this.editor.moveWordRight()
      this.requestRender()
      return
    }
    if (key.ctrl && key.name === 'u') {
      this.editor.killToLineStart()
      this.slashIndex = 0
      this.requestRender()
      return
    }
    if (key.ctrl && key.name === 'k') {
      this.editor.killToLineEnd()
      this.slashIndex = 0
      this.requestRender()
      return
    }
    if (key.ctrl && key.name === 'w') {
      this.editor.killWordBackward()
      this.slashIndex = 0
      this.requestRender()
      return
    }
    if (key.meta && key.name === 'd') {
      this.editor.killWordForward()
      this.slashIndex = 0
      this.requestRender()
      return
    }
    if (key.ctrl && key.name === 'y') {
      this.editor.yank()
      this.slashIndex = 0
      this.requestRender()
      return
    }
    if (key.meta && key.name === 'y') {
      this.editor.yankPop()
      this.slashIndex = 0
      this.requestRender()
      return
    }
    if (key.name === 'backspace') {
      if (key.meta) {
        this.editor.killWordBackward()
        this.requestRender()
        return
      }
      if (this.input === '' && this.draftImages.length > 0) {
        this.draftImages = this.draftImages.slice(0, -1)
        this.setNotice(undefined)
        return
      }
      this.deleteBackward()
      return
    }
    if (key.name === 'delete') {
      this.deleteForward()
      return
    }
    if (key.name === 'tab') {
      this.completeInput()
      return
    }
    if (key.name === 'return' || key.name === 'enter') {
      if (key.meta) {
        this.insertText('\n')
      } else if (key.ctrl) {
        void this.submit('queue', true)
      } else if (key.shift) {
        this.insertText('\n')
      } else {
        // Enter always queues. A running turn keeps its own progress, and the queued row is
        // what Esc promotes into that turn and Alt+Up recalls for editing, so nothing joins
        // a turn the operator did not explicitly interrupt.
        void this.submit('queue')
      }
      return
    }
    if (!key.ctrl && !key.meta && sequence !== '' && !isNavigationSequence(sequence)) {
      this.insertText(sequence.replaceAll('\r', '\n'))
    }
  }

  private handleCtrlC(): void {
    if (this.state.running) {
      void this.interrupt()
      return
    }
    if (this.input !== '' || this.draftImages.length > 0) {
      this.editor.clear()
      this.draftImages = []
      this.queueEditId = undefined
      this.requestRender()
      return
    }
    if (this.ctrlCPending) {
      this.stop(0)
      return
    }
    // A bootstrap run is one-shot: a single Ctrl+C ends it instead of arming a
    // second press, so a `--prompt` worker cannot linger in a pane.
    if (this.bootstrapRun) {
      this.stop(0)
      return
    }
    this.ctrlCPending = true
    this.setNotice(messages.exitHint)
  }

  private handleOverlayKey(sequence: string, key: Key): void {
    const overlay = this.overlay
    if (overlay === undefined) return
    if (overlay.kind === 'sessions') {
      if (key.name === 'up') overlay.index = Math.max(0, overlay.index - 1)
      else if (key.name === 'down') overlay.index = Math.min(overlay.items.length - 1, overlay.index + 1)
      else if (key.name === 'return' || key.name === 'enter') {
        const selected = overlay.items[overlay.index]
        if (selected !== undefined) this.switchSession(selected.sessionId, true)
      } else if (key.name === 'escape') this.closeOverlay()
      return
    }
    if (overlay.kind === 'models') {
      if (overlay.stage === 'model') {
        if (key.name === 'up') overlay.index = Math.max(0, overlay.index - 1)
        else if (key.name === 'down') overlay.index = Math.min(overlay.items.length - 1, overlay.index + 1)
        else if (key.name === 'return' || key.name === 'enter') this.advanceModelPicker(overlay)
        else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) this.closeOverlay()
        return
      }
      const chosen = overlay.chosen
      const efforts = chosen?.efforts ?? []
      if (key.name === 'up') overlay.effortIndex = Math.max(0, overlay.effortIndex - 1)
      else if (key.name === 'down') overlay.effortIndex = Math.min(efforts.length - 1, overlay.effortIndex + 1)
      else if (key.name === 'return' || key.name === 'enter') {
        if (chosen !== undefined) void this.selectModel(chosen, efforts[overlay.effortIndex]?.id)
      } else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        // Back to the model stage keeps the highlighted route in place.
        overlay.stage = 'model'
        overlay.effortIndex = 0
        this.requestRender()
      }
      return
    }
    if (overlay.kind === 'queue') {
      if (key.name === 'up') overlay.index = Math.max(0, overlay.index - 1)
      else if (key.name === 'down') overlay.index = Math.min(overlay.items.length - 1, overlay.index + 1)
      else if (key.name === 'escape') this.closeOverlay()
      else if (sequence === 'e') {
        const selected = overlay.items[overlay.index]
        if (selected !== undefined) this.beginQueueEdit(selected)
      } else if (sequence === 'd' || key.name === 'delete') {
        const selected = overlay.items[overlay.index]
        if (selected !== undefined) void this.removeQueueItem(selected)
      }
      return
    }
    if (overlay.kind === 'approval') {
      if (key.name === 'return' || key.name === 'enter') {
        overlay.resolve('allowed-once')
        this.closeOverlay()
      } else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        overlay.resolve('rejected')
        this.closeOverlay()
      }
      return
    }
    this.handleQuestionKey(overlay, sequence, key)
  }

  private handleQuestionKey(prompt: QuestionPrompt, sequence: string, key: Key): void {
    const progress = prompt.progress[prompt.questionIndex]
    if (progress === undefined) return
    const options = progress.question.options ?? []
    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
      prompt.reject(new Error('question cancelled by user'))
      this.closeOverlay()
      return
    }
    if (progress.mode === 'custom') {
      if (key.name === 'return' || key.name === 'enter') this.commitQuestion(prompt)
      else if (key.name === 'backspace') progress.custom = Array.from(progress.custom).slice(0, -1).join('')
      else if (!key.ctrl && !key.meta && sequence !== '') progress.custom += sequence
      return
    }
    if (key.name === 'up') progress.index = Math.max(0, progress.index - 1)
    else if (key.name === 'down') progress.index = Math.min(Math.max(0, options.length - 1), progress.index + 1)
    else if (key.name === 'space') {
      const option = options[progress.index]
      if (option !== undefined) {
        if (progress.question.multiSelect === true) {
          if (progress.selected.has(option.label)) progress.selected.delete(option.label)
          else progress.selected.add(option.label)
        } else {
          progress.selected.clear()
          progress.selected.add(option.label)
        }
      }
    } else if (key.name === 'tab') {
      progress.mode = 'custom'
    } else if (key.name === 'return' || key.name === 'enter') {
      this.commitQuestion(prompt)
    }
  }

  private commitQuestion(prompt: QuestionPrompt): void {
    if (commitQuestionAnswer(prompt)) this.closeOverlay()
  }

  private async interrupt(): Promise<void> {
    if (this.state.sessionId === undefined) return
    try {
      await this.remote.cancel(this.state.sessionId)
      this.state = { ...this.state, running: false }
      this.setNotice(messages.interrupted)
    } catch (error) {
      this.addError(error)
    }
  }

  private async removeQueueItem(item: QueuePrompt): Promise<void> {
    if (this.state.sessionId === undefined) return
    try {
      await this.remote.updateQueue(this.state.sessionId, item.id, { kind: 'remove' })
      this.state = { ...this.state, queue: this.state.queue.filter(candidate => candidate.id !== item.id) }
      this.closeOverlay()
      this.setNotice(messages.queueRemoved)
    } catch (error) {
      this.addError(error)
    }
  }

  private beginQueueEdit(item: QueuePrompt): void {
    if (this.input !== '' || this.draftImages.length > 0) {
      this.setNotice(messages.queueDraftNotEmpty)
      return
    }
    if (!item.editable) {
      this.setNotice(messages.queueEditUnsupported)
      return
    }
    this.queueEditId = item.id
    this.editor.setText(item.text)
    this.draftImages = []
    this.closeOverlay()
    this.setNotice(messages.queueEditing)
  }

  private async recallLatestQueue(): Promise<void> {
    if (this.input !== '' || this.draftImages.length > 0) {
      this.setNotice(messages.queueDraftNotEmpty)
      return
    }
    const item = [...this.state.queue].reverse().find(candidate => candidate.editable)
    if (item === undefined) {
      this.setNotice(messages.queueRecallUnavailable)
      return
    }
    await this.removeQueueItemForRecall(item)
  }

  private async removeQueueItemForRecall(item: QueuePrompt): Promise<void> {
    if (this.state.sessionId === undefined) return
    try {
      await this.remote.updateQueue(this.state.sessionId, item.id, { kind: 'remove' })
      this.state = { ...this.state, queue: this.state.queue.filter(candidate => candidate.id !== item.id) }
      this.editor.setText(item.text)
      this.draftImages = []
      this.setNotice(messages.queueRecalled)
    } catch (error) {
      this.addError(error)
    }
  }

  private async retryTurn(): Promise<void> {
    if (this.state.sessionId === undefined || this.state.running || this.submission !== undefined) return
    if (this.state.retryAvailable === false) {
      this.setNotice(messages.retryUnavailable)
      return
    }
    this.submission = { mode: 'queue', text: messages.continueGenerating, imageCount: 0 }
    this.requestRender()
    try {
      await this.remote.prompt(this.state.sessionId, [], 'queue')
      this.setNotice(messages.continueRequested)
    } catch (error) {
      this.addError(error)
    } finally {
      this.submission = undefined
      this.requestRender()
    }
  }

  private async pasteClipboard(): Promise<void> {
    if (this.clipboardBusy) return
    this.clipboardBusy = true
    this.setNotice(messages.clipboardReading)
    try {
      const limits = this.state.imageLimits ?? DEFAULT_IMAGE_LIMITS
      const content = await readClipboard({ maxImageBytes: limits.maxImageBytes })
      if (content === undefined) {
        this.setNotice(messages.clipboardEmpty)
        return
      }
      if (content.kind === 'text') {
        this.insertText(content.text)
        this.setNotice(undefined)
        return
      }
      if (this.draftImages.length >= limits.maxImagesPerMessage) {
        this.setNotice(localized.imageCountLimit(limits.maxImagesPerMessage))
        return
      }
      const bytes = this.draftImages.reduce((sum, image) => sum + image.bytes, content.bytes)
      if (bytes > limits.maxMessageImageBytes) {
        this.setNotice(localized.imageMessageLimit(Math.floor(limits.maxMessageImageBytes / (1024 * 1024))))
        return
      }
      const ordinal = this.draftImages.length + 1
      const name = content.name.replace(/^pasted-image/u, `pasted-image-${String(ordinal)}`)
      this.draftImages = [...this.draftImages, { ...content, name }]
      this.setNotice(localized.imageAdded(ordinal, name))
    } catch (error) {
      this.setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      this.clipboardBusy = false
    }
  }

  private async submit(mode: 'queue' | 'steer', interruptFirst = false): Promise<void> {
    const rawText = this.input
    const text = rawText.trim()
    const images = this.draftImages
    if (this.submission !== undefined) return
    if (text === '' && images.length === 0) return
    if (this.state.sessionId === undefined) return
    if (text.startsWith('/') && images.length > 0 && this.localCommandName(text) !== undefined) {
      this.setNotice(messages.imagesWithLocalCommand)
      return
    }
    const shell = shellLine(text)
    if (shell !== undefined) {
      if (images.length > 0) {
        this.setNotice(localized.shellImagesUnsupported)
        return
      }
      this.history.push(text)
      this.historyIndex = this.history.length
      this.editor.clear()
      this.scroll.value = 0
      await this.runShell(shell.command)
      this.requestRender()
      return
    }
    if (this.queueEditId !== undefined) {
      await this.commitQueueEdit(rawText.trim())
      return
    }
    if (text.startsWith('/')) {
      this.history.push(text)
      this.historyIndex = this.history.length
      this.editor.clear()
      this.scroll.value = 0
      if (this.localCommandName(text) !== undefined) await this.runTerminalCommand(text)
      else await this.runSlashLine(text, this.state.sessionId)
      this.requestRender()
      return
    }
    this.submission = {
      mode,
      text: text === '' ? localized.imageOnlyPrompt(images.length) : text,
      imageCount: images.length,
    }
    this.requestRender()
    try {
      if (interruptFirst && this.state.running) await this.interrupt()
      await this.remote.prompt(
        this.state.sessionId,
        buildPromptContent(rawText, images),
        mode,
      )
      this.history.push(text === '' ? localized.imageOnlyPrompt(images.length) : text)
      this.historyIndex = this.history.length
      this.editor.clear()
      this.draftImages = []
      this.scroll.value = 0
      this.setNotice(undefined)
    } catch (error) {
      this.addError(error)
    } finally {
      this.submission = undefined
      this.requestRender()
    }
  }

  private async commitQueueEdit(text: string): Promise<void> {
    if (this.state.sessionId === undefined || this.queueEditId === undefined) return
    if (text === '') {
      this.setNotice(messages.queueEditEmpty)
      return
    }
    try {
      await this.remote.updateQueue(this.state.sessionId, this.queueEditId, {
        kind: 'edit',
        content: [{ type: 'text', text }],
      })
      const edited = this.queueEditId
      this.queueEditId = undefined
      this.editor.clear()
      this.state = {
        ...this.state,
        queue: this.state.queue.map(item => item.id === edited ? { ...item, text } : item),
      }
      this.setNotice(messages.queueEditSaved)
    } catch (error) {
      this.addError(error)
    }
  }

  /**
   * Run one `!` line in this process and print what it produced.
   *
   * The command never reaches the Host or the model, so its output is transcript text
   * only. A non-zero exit is still a finished command: the status line carries the code
   * and nothing here raises a notice.
   * @param command - the shell command line after the leading `!`.
   */
  private async runShell(command: string): Promise<void> {
    this.setNotice(localized.shellRunning(command))
    try {
      const result = await runShellLine(command, { cwd: process.cwd() })
      this.addSystem(shellResultText(command, result))
    } catch (error: unknown) {
      this.addError(error)
    } finally {
      this.setNotice(undefined)
      this.requestRender()
    }
  }

  /**
   * Run one terminal builtin. A line whose leading token no local command owns belongs to
   * the Host and never reaches this method.
   * @param line - trimmed draft whose leading token names a local command.
   */
  private async runTerminalCommand(line: string): Promise<void> {
    const [name] = line.slice(1).split(/\s+/u, 1)
    if (name === 'help') {
      this.addSystem(messages.help)
      return
    }
    // `/exit` is the command launchers send to stop a worker; `/quit` and `/q`
    // stay as aliases so existing habits keep working.
    if (name === 'exit' || name === 'quit' || name === 'q') {
      this.stop(0)
      return
    }
    if (this.state.sessionId === undefined) return
    if (name === 'new') {
      const id = await this.remote.createSession(process.cwd())
      this.switchSession(id, true)
      return
    }
    if (name === 'resume') {
      const items = await this.remote.listSessions()
      if (items.length === 0) {
        this.addSystem(messages.noSavedSessions)
        return
      }
      this.overlay = { kind: 'sessions', items, index: 0 }
      return
    }
    if (name === 'model') {
      this.overlay = {
        kind: 'models',
        items: modelChoices(await this.remote.modelCatalog()),
        index: 0,
        stage: 'model',
        effortIndex: 0,
      }
      return
    }
    if (name === 'status') {
      this.showStatus()
      return
    }
    if (name === 'context') {
      this.showContext()
      return
    }
    if (name === 'queue') {
      if (this.state.queue.length === 0) {
        this.addSystem(messages.queueEmpty)
        return
      }
      this.overlay = { kind: 'queue', items: [...this.state.queue], index: 0 }
      return
    }
    if (name === 'retry') {
      await this.retryTurn()
    }
  }

  /**
   * The local command a `/` line names, or undefined when the Host owns it (including skills).
   * Local commands run in the terminal itself and never carry the composer's images.
   * @param line - trimmed draft beginning with `/`.
   * @returns the bare local command name when the line is one, else undefined.
   */
  private localCommandName(line: string): (typeof LOCAL_COMMANDS)[number] | undefined {
    return terminalCommandName(line)
  }

  /**
   * Execute one slash line whose leading token no local command owns, following
   * {@link slashRoute}.
   * @param line - the complete slash line.
   * @param sessionId - Session receiving the line.
   */
  private async runSlashLine(line: string, sessionId: SessionId): Promise<void> {
    const images = this.draftImages
    switch (slashRoute(line, images.length, this.slashSuggestions)) {
      case 'prompt':
        await this.submitDirectPrompt(line, false, images)
        return
      case 'refuse':
        this.setNotice(messages.attachmentsUnsupported(slashName(line)))
        return
      case 'command':
        await this.runHostCommand(line, sessionId)
    }
  }

  /**
   * Run one slash line through the Host's command executor.
   * Staged images are submitted as encoded command attachments, which only a command
   * declaring `input.attachments` accepts. A Host error keeps them staged so the line can
   * be corrected; a settled command consumes them exactly as a sent prompt would.
   * @param line - the complete slash line.
   * @param sessionId - Session receiving the line, already known to exist.
   */
  private async runHostCommand(line: string, sessionId: SessionId): Promise<void> {
    const images = this.draftImages
    const imageCount = images.length
    if (imageCount > 0) {
      this.submission = {
        mode: this.state.running ? 'steer' : 'queue',
        text: line,
        imageCount,
      }
      this.requestRender()
    }
    try {
      const result = await this.remote.command(sessionId, line, images.map(image => ({
        type: 'image' as const,
        mediaType: image.mediaType,
        data: image.data,
        name: image.name,
      })))
      if (result === undefined) {
        this.submission = undefined
        await this.submitDirectPrompt(line, false, images)
        return
      }
      if (imageCount > 0) this.draftImages = []
      if (result.result.text !== undefined) this.addSystem(result.result.text)
    } catch (error) {
      this.addError(error)
    } finally {
      if (imageCount > 0) {
        this.submission = undefined
        this.requestRender()
      }
    }
  }

  /**
   * Submit `--prompt` text once the terminal is interactive, then exit when the turn ends.
   * The submission is immediate, so it does not depend on a paste being submitted by Enter.
   * @param prompt - bootstrap prompt; defaults to the launcher-supplied one.
   * @returns the prompt actually submitted, or undefined when none was pending.
   */
  async submitBootstrap(prompt?: string): Promise<string | undefined> {
    const text = prompt ?? this.bootstrap?.prompt
    if (text === undefined || text.trim() === '' || this.state.sessionId === undefined) return undefined
    const thenExit = this.bootstrap?.thenExit ?? false
    this.bootstrap = undefined
    this.bootstrapPending = true
    this.setNotice(undefined)
    try {
      await this.submitDirectPrompt(text, thenExit)
    } finally {
      this.bootstrapPending = false
    }
    return text
  }

  private startBootstrap(): void {
    if (this.bootstrap === undefined) return
    void this.submitBootstrap()
  }

  private async submitDirectPrompt(
    text: string,
    thenExit = false,
    images: readonly ClipboardImage[] = [],
  ): Promise<void> {
    if (this.state.sessionId === undefined || this.submission !== undefined) return
    const mode = this.state.running ? 'steer' : 'queue'
    this.submission = { mode, text, imageCount: images.length }
    this.requestRender()
    try {
      await this.remote.prompt(this.state.sessionId, buildPromptContent(text, images), mode)
      this.history.push(text)
      this.historyIndex = this.history.length
      if (images.length > 0) this.draftImages = []
      this.setNotice(undefined)
    } catch (error) {
      this.addError(error)
      return
    } finally {
      this.submission = undefined
      this.requestRender()
    }
    if (thenExit) this.exitAfterTurn()
  }

  /**
   * Stop once the accepted turn settles: exit as soon as this app observes the
   * Session leave `running`, with a bounded fallback for a turn that never runs.
   */
  private exitAfterTurn(): void {
    const poll = (): void => {
      if (this.stopped) return
      if (!this.state.running) {
        clearInterval(timer)
        this.stop(0)
      }
    }
    const timer = setInterval(poll, 200)
    setTimeout(() => {
      clearInterval(timer)
      if (!this.stopped) this.stop(0)
    }, 6 * 60 * 60 * 1000).unref()
  }

  private showStatus(): void {
    const session = this.state.sessionId ?? '(none)'
    const model = this.state.model === undefined ? '(default)' : `${this.state.model.provider}/${this.state.model.model}`
    const tokens = this.state.tokens === undefined
      ? 'unavailable'
      : `${String(this.state.tokens.input)} input, ${String(this.state.tokens.output)} output, `
        + `${String(this.state.tokens.cacheRead)} cache read, ${String(this.state.tokens.cacheWrite)} cache write`
    const cache = cacheHitPercent(this.state.tokens)
    this.addSystem([
      `${messages.statusLabels.session}: ${session}`,
      `${messages.statusLabels.title}: ${this.state.title}`,
      `${messages.statusLabels.directory}: ${this.state.cwd}`,
      `${messages.statusLabels.model}: ${model}`,
      `${messages.statusLabels.effort}: ${this.state.model?.reasoningEffort ?? '(default)'}`,
      `${messages.statusLabels.tokens}: ${tokens}`,
      `${messages.statusLabels.cacheHit}: ${cache === undefined ? '(no billed input yet)' : `${String(cache)}%`}`,
      `${messages.statusLabels.context}: ${this.contextSummary()}`,
      `${messages.statusLabels.permission}: ${this.state.permission ?? '(unknown)'}`,
      `${messages.statusLabels.state}: ${this.state.running ? 'running' : 'idle'}`,
      // The frame is laid out against these two numbers, so a layout report can quote them.
      `${messages.statusLabels.terminal}: ${String(this.stdout.columns)}x${String(this.stdout.rows)}`,
    ].join('\n'))
  }

  private showContext(): void {
    const context = this.state.context
    if (context === undefined) {
      this.addSystem(messages.contextUnavailable)
      return
    }
    this.addSystem([
      `${messages.statusLabels.context}: ${this.contextSummary()}`,
      `${messages.statusLabels.pressure}: ${String(context.pressureTokens ?? 'unknown')}`,
      `${messages.statusLabels.projected}: ${String(context.projectedTokens ?? 'unknown')}`,
      `${messages.statusLabels.system}: ${String(context.systemTokens ?? 'unknown')}`,
      `${messages.statusLabels.tools}: ${String(context.toolsTokens ?? 'unknown')}`,
      `${messages.statusLabels.messages}: ${String(context.messageTokens ?? 'unknown')}`,
      `${messages.statusLabels.tokens}: ${this.state.tokens === undefined
        ? 'unavailable'
        : `${String(this.state.tokens.input)} input, ${String(this.state.tokens.output)} output, ${String(this.state.tokens.cacheRead)} cache read`}`,
    ].join('\n'))
  }

  private contextSummary(): string {
    const context = this.state.context
    if (context === undefined || context.contextWindow === undefined) return 'unavailable'
    const used = context.projectedTokens ?? context.pressureTokens
    if (used === undefined) return 'unavailable'
    const percent = Math.min(100, Math.round(used / context.contextWindow * 100))
    return `${String(percent)}% (${compactNumber(used)}/${compactNumber(context.contextWindow)})`
  }

  /**
   * Advance the model stage: a route with reasoning depths moves on to the depth stage,
   * while a route without them is selected directly because it has nothing else to choose.
   * @param overlay - the open model picker, mutated in place.
   */
  private advanceModelPicker(overlay: Extract<Overlay, { kind: 'models' }>): void {
    const selected = overlay.items[overlay.index]
    if (selected === undefined) return
    if (selected.efforts.length === 0) {
      void this.selectModel(selected)
      return
    }
    const current = this.state.model?.provider === selected.provider && this.state.model.model === selected.model
      ? this.state.model.reasoningEffort
      : undefined
    this.overlay = {
      ...overlay,
      stage: 'effort',
      chosen: selected,
      effortIndex: defaultEffortIndex(selected, current),
    }
    this.requestRender()
  }

  /**
   * Select a route and, when it accepts one, a reasoning depth.
   * @param choice - the route.
   * @param effort - depth identifier, or undefined to let the host apply its default.
   */
  private async selectModel(choice: ModelChoice, effort?: string): Promise<void> {
    if (this.state.sessionId === undefined) return
    this.closeOverlay()
    try {
      await this.remote.selectModel(this.state.sessionId, choice.provider, choice.model, effort)
      this.state = {
        ...this.state,
        model: {
          provider: choice.provider,
          model: choice.model,
          ...(effort === undefined ? {} : { reasoningEffort: effort }),
        },
      }
      this.addSystem(localized.selectedModel(choice.provider, choice.model, effort))
    } catch (error) {
      this.addError(error)
    }
  }

  private switchSession(sessionId: SessionId, announce: boolean): void {
    this.closeOverlay()
    this.followAbort?.abort()
    const abort = new AbortController()
    this.followAbort = abort
    this.queueEditId = undefined
    this.submission = undefined
    this.state = { ...initialTranscript(), sessionId, cwd: process.cwd(), model: this.defaultModel }
    this.slashSuggestions = this.localSlashSuggestions()
    this.slashIndex = 0
    this.scroll.value = 0
    if (announce) this.addSystem(localized.opened(sessionId))
    for (const task of [this.consumeFollow(sessionId, abort), this.consumeControl(abort), this.consumeState(sessionId, abort)]) {
      this.subscriptions.add(task)
      void task.finally(() => { this.subscriptions.delete(task) })
    }
    void this.refreshSlashCatalog(sessionId)
    // The transcript is a different one, so nothing on screen is reusable.
    this.requestRender(false)
  }

  private localSlashSuggestions(): SlashSuggestion[] {
    return LOCAL_COMMANDS.map(name => ({
      name,
      description: LOCAL_COMMAND_DESCRIPTIONS[name],
      source: 'local' as const,
    }))
  }

  private slashMenuOpen(): boolean {
    return this.input.startsWith('/') && !this.input.includes(' ') && !this.input.includes('\n')
      && (this.slashLoading || this.visibleSlashSuggestions().length > 0)
  }

  private visibleSlashSuggestions(): SlashSuggestion[] {
    if (!this.input.startsWith('/')) return []
    const query = this.input.slice(1).toLowerCase()
    return this.slashSuggestions
      .filter(suggestion =>
        suggestion.name.toLowerCase().startsWith(query)
        || (query !== '' && suggestion.description.toLowerCase().includes(query)))
      .sort((left, right) => compareSlashSuggestions(query, left, right))
  }

  private acceptSlashSuggestion(run: boolean): void {
    const suggestions = this.visibleSlashSuggestions()
    const selected = suggestions[Math.min(this.slashIndex, Math.max(0, suggestions.length - 1))]
    if (selected === undefined) return
    this.editor.setText(`/${selected.name}${run ? '' : ' '}`)
    this.slashIndex = 0
    if (run) void this.submit(this.state.running ? 'steer' : 'queue')
    else this.requestRender()
  }

  private async refreshSlashCatalog(sessionId: SessionId): Promise<void> {
    this.slashCatalogAbort?.abort()
    const abort = new AbortController()
    this.slashCatalogAbort = abort
    this.slashLoading = true
    this.requestRender()
    try {
      const [commands, skills] = await Promise.allSettled([
        this.remote.listCommands(sessionId),
        this.remote.listSkills(sessionId, abort.signal),
      ])
      if (abort.signal.aborted || this.state.sessionId !== sessionId) return
      const merged = new Map(this.localSlashSuggestions().map(item => [item.name, item]))
      if (commands.status === 'fulfilled') {
        for (const command of commands.value) {
          if (!merged.has(command.name)) {
            merged.set(command.name, {
              name: command.name,
              description: command.description,
              source: 'command',
              ...(command.attachments === true ? { attachments: true } : {}),
            })
          }
        }
      }
      if (skills.status === 'fulfilled') {
        for (const skill of skills.value) {
          if (!merged.has(skill.name)) {
            merged.set(skill.name, { ...skill, source: 'skill' })
          }
        }
      }
      this.slashSuggestions = [...merged.values()]
      this.slashIndex = Math.min(this.slashIndex, Math.max(0, this.slashSuggestions.length - 1))
    } finally {
      if (!abort.signal.aborted && this.state.sessionId === sessionId) {
        this.slashLoading = false
        this.requestRender()
      }
    }
  }

  private async consumeControl(abort: AbortController): Promise<void> {
    try {
      for await (const frame of this.remote.control(abort.signal)) {
        if (abort.signal.aborted) break
        this.state = applyControlFrame(this.state, frame)
        this.requestRender()
      }
    } catch (error) {
      if (!abort.signal.aborted) this.addError(error)
    }
  }

  private async consumeState(sessionId: SessionId, abort: AbortController): Promise<void> {
    try {
      for await (const state of this.remote.observeState(sessionId, abort.signal)) {
        if (abort.signal.aborted) break
        if (this.state.sessionId !== sessionId) continue
        this.state = applySessionState(this.state, state)
        this.requestRender()
      }
    } catch (error) {
      if (!abort.signal.aborted) this.addError(error)
    }
  }

  private async consumeFollow(sessionId: SessionId, abort: AbortController): Promise<void> {
    try {
      const stream = this.remote.followSession(sessionId, abort.signal)
      for await (const frame of stream) {
        if (abort.signal.aborted) break
        this.state = applyFollowFrame(this.state, frame)
        if (frame.type === 'event' && frame.event.type === 'turn/end') void this.refreshSummary()
        this.requestRender()
      }
    } catch (error) {
      if (!abort.signal.aborted) this.addError(error)
    }
  }

  private async refreshSummary(): Promise<void> {
    if (this.state.sessionId === undefined) return
    try {
      const summaries = await this.remote.listSessions()
      const summary = summaries.find(item => item.sessionId === this.state.sessionId)
      if (summary !== undefined) this.state = applySummary(this.state, summary)
      this.requestRender()
    } catch (error) {
      if (!(error instanceof Error)) throw error
    }
  }

  private moveHistory(direction: number): void {
    if (this.history.length === 0) return
    this.historyIndex = Math.min(this.history.length, Math.max(0, this.historyIndex + direction))
    this.editor.setText(this.historyIndex >= this.history.length ? '' : this.history[this.historyIndex] ?? '')
    this.slashIndex = 0
    this.requestRender()
  }

  private insertText(text: string): void {
    this.editor.insert(text)
    this.slashIndex = 0
    this.scroll.value = 0
    this.requestRender()
  }

  private deleteBackward(): void {
    this.editor.deleteBackward()
    this.slashIndex = 0
    this.requestRender()
  }

  private deleteForward(): void {
    this.editor.deleteForward()
    this.slashIndex = 0
    this.requestRender()
  }

  private completeInput(): void {
    if (this.input.startsWith('/') && !this.input.includes(' ')) {
      // The catalog carries local commands, Host commands, and skills; a skill or Host
      // command completes to its name plus a space so arguments can follow.
      const prefix = this.input.slice(1).toLowerCase()
      const candidate = this.visibleSlashSuggestions().find(
        suggestion => suggestion.name.toLowerCase().startsWith(prefix),
      ) ?? this.slashSuggestions.find(
        suggestion => suggestion.name.toLowerCase().startsWith(prefix),
      )
      if (candidate === undefined) return
      this.editor.setText(`/${candidate.name} `)
      this.slashIndex = 0
      this.requestRender()
      return
    }
    const at = this.input.lastIndexOf('@')
    if (at < 0 || (at > 0 && !/\s/u.test(this.input[at - 1] ?? ''))) return
    const fragment = this.input.slice(at + 1)
    const resolved = resolveCompletion(process.cwd(), fragment)
    if (resolved === undefined) return
    this.editor.setText(`${this.input.slice(0, at + 1)}${resolved}`)
    this.requestRender()
  }

  /**
   * Schedule a repaint, repainting only changed rows unless an override asks for a full one.
   * A full repaint clears the whole screen, which is expensive on large terminals, so
   * only the callers that replace the screen wholesale pass `false`.
   * @param incremental - repaint changed rows only; `false` clears and redraws everything.
   */
  private requestRender(incremental = true): void {
    if (!this.stopped && this.state.sessionId !== undefined) {
      const interaction = [this.overlay, ...this.queuedInteractions].find(
        item => item?.kind === 'approval' || item?.kind === 'question',
      )
      this.herdr.update({
        sessionId: this.state.sessionId,
        state: interaction !== undefined ? 'blocked' : this.state.running ? 'working' : 'idle',
        ...(interaction === undefined ? {} : {
          message: interaction.kind === 'approval' ? messages.approvals : messages.question,
        }),
      })
    }
    // "Type a message or /help" documents that input is accepted, so it is not
    // shown before the Session opens and a submitted key cannot be lost.
    if (this.state.sessionId === undefined) {
      this.renderStartup()
      return
    }
    // A queued request must keep the slower full-repaint window: upgrading an
    // incremental wait to a full repaint would clear the screen every 8ms.
    if (this.stopped) return
    if (!incremental) this.renderMode = 'full'
    if (this.renderTimer !== undefined) return
    if (incremental) this.renderMode = 'incremental'
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined
      const mode = this.renderMode
      this.renderMode = 'full'
      this.render(mode === 'incremental')
    }, incremental ? 8 : 33)
  }

  /**
   * Paint the header and footer before the Session exists so a launcher waiting on
   * screen text sees one stable frame regardless of how long Session creation takes.
   */
  private renderStartup(): void {
    if (this.stopped || this.startupRendered) return
    this.startupRendered = true
    this.stdout.write(`\u001b[2J\u001b[H${messages.appTitle}\r\n\r\n${messages.starting}`)
  }

  private render(incremental: boolean): void {
    const suggestions = this.slashMenuOpen() ? this.visibleSlashSuggestions() : []
    if (this.slashIndex >= suggestions.length) this.slashIndex = 0
    const frame = this.renderer.render({
      rows: this.stdout.rows,
      columns: this.stdout.columns,
      state: this.state,
      input: this.input,
      cursor: this.inputCursor,
      images: this.draftImages,
      submission: this.submission,
      slashSuggestions: suggestions,
      slashSuggestionIndex: this.slashIndex,
      slashLoading: this.slashLoading,
      overlay: this.overlay,
      expandedTools: this.expandedTools.value,
      scroll: this.scroll.value,
      notice: this.notice,
      selection: this.selection,
    }, incremental)
    this.lastFrame = frame
    this.stdout.write(frame.text)
    this.stdout.write(`\u001b[${String(frame.cursorRow)};${String(frame.cursorColumn)}H\u001b[?25h`)
  }

  /**
   * The rows currently on screen, without ANSI styling.
   * Incremental frames write only changed rows, so this is the only complete view.
   * @returns screen rows top to bottom, or an empty array before the first frame.
   */
  screenLines(): readonly string[] {
    return this.renderer.screenLines()
  }

  private addSystem(text: string): void {
    this.state = {
      ...this.state,
      items: [...this.state.items, { id: `system-${String(Date.now())}-${String(Math.random())}`, kind: 'system', text }],
    }
    this.requestRender()
  }

  private addError(error: unknown): void {
    const message = friendlyError(error)
    this.state = {
      ...this.state,
      running: false,
      items: [...this.state.items, { id: `error-${String(Date.now())}-${String(Math.random())}`, kind: 'error', text: message }],
    }
    this.setNotice(message)
  }

  private setNotice(message: string | undefined): void {
    this.notice = message
    this.requestRender()
  }

  private closeOverlay(): void {
    this.overlay = this.queuedInteractions.shift()
    this.requestRender()
  }

  requestApproval = (request: ApprovalUiRequest): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'> => {
    return new Promise((resolve) => {
      const prompt: ApprovalPrompt = { kind: 'approval', request, resolve: (outcome) => {
        request.signal?.removeEventListener('abort', aborted)
        resolve(outcome)
      } }
      const aborted = (): void => { prompt.resolve('cancelled'); this.removeQueued(prompt) }
      request.signal?.addEventListener('abort', aborted, { once: true })
      this.enqueueInteraction(prompt)
    })
  }

  requestQuestion = (request: QuestionUiRequest): Promise<{
    answers: AskUserQuestionAnswerItem[]
  }> => {
    return new Promise((resolve, reject) => {
      const prompt = createQuestionPrompt(request, resolve, reject)
      const aborted = (): void => {
        reject(new Error('question request was cancelled'))
        this.removeQueued(prompt)
      }
      request.signal?.addEventListener('abort', aborted, { once: true })
      this.enqueueInteraction(prompt)
    })
  }

  private enqueueInteraction(prompt: ApprovalPrompt | QuestionPrompt): void {
    if (this.overlay === undefined) this.overlay = prompt
    else this.queuedInteractions.push(prompt)
    this.requestRender()
  }

  private removeQueued(prompt: Overlay): void {
    const index = this.queuedInteractions.indexOf(prompt as ApprovalPrompt | QuestionPrompt)
    if (index >= 0) this.queuedInteractions.splice(index, 1)
    if (this.overlay === prompt) this.closeOverlay()
  }

  /** Update the running indicator from the Host's Session status event. */
  setRunning(sessionId: SessionId, running: boolean): void {
    if (this.state.sessionId !== sessionId) return
    this.state = { ...this.state, running }
    this.requestRender()
  }

  /** Surface a Host session error in the transcript. */
  remoteError(sessionId: SessionId, message: string): void {
    if (this.state.sessionId !== sessionId) return
    this.addError(new Error(message))
  }

  private handleMouse(mouse: MouseInput): void {
    const region = this.lastFrame?.selectionRegion
    if (region === undefined) {
      this.clearSelection()
      return
    }
    const bottom = region.top + region.rows.length - 1
    if (mouse.action === 'down') {
      if (mouse.button !== 'left' || mouse.row < region.top || mouse.row > bottom) {
        this.clearSelection()
        return
      }
      const point = this.clampSelectionPoint(mouse.column, mouse.row, region.top, bottom)
      this.selection = { anchor: point, head: point, dragging: true }
      this.requestRender()
      return
    }
    if (mouse.action === 'drag' && this.selection?.dragging === true) {
      this.selection = {
        ...this.selection,
        head: this.clampSelectionPoint(mouse.column, mouse.row, region.top, bottom),
      }
      this.requestRender()
      return
    }
    if (mouse.action === 'up' && mouse.button === 'left' && this.selection?.dragging === true) {
      this.selection = { ...this.selection, dragging: false }
      this.requestRender()
    }
  }

  private clampSelectionPoint(
    column: number,
    row: number,
    top: number,
    bottom: number,
  ): TerminalPoint {
    return {
      column: Math.max(1, Math.min(this.stdout.columns, column)),
      row: Math.max(top, Math.min(bottom, row)),
    }
  }

  private clearSelection(): void {
    if (this.selection === undefined) return
    this.selection = undefined
    this.requestRender()
  }

  private async copySelection(): Promise<void> {
    const text = selectedText(this.lastFrame?.selectionRegion, this.selection)
    if (text === '') {
      this.setNotice(messages.selectionEmpty)
      return
    }
    try {
      await writeClipboardText(text)
      this.selection = undefined
      this.setNotice(localized.selectionCopied(text.length))
    } catch (error) {
      this.addError(error)
    }
  }

  private enterTerminal(): () => void {
    this.stdin.setRawMode(true)
    this.stdin.resume()
    this.stdout.write(`\u001b[?1049h\u001b[?2004h${MOUSE_TRACKING_ON}\u001b[>1u\u001b[2J\u001b[H`)
    return () => {
      this.stdin.off('data', this.onData)
      this.stdout.off('resize', this.onResize)
      this.stdin.setRawMode(false)
      this.stdin.pause()
      this.stdout.write(`\u001b[<u${MOUSE_TRACKING_OFF}\u001b[?2004l\u001b[?1049l`)
    }
  }

  private waitForExit(): Promise<number> {
    return new Promise((resolve) => {
      this.resolveExit = resolve
    })
  }

  private resolveExit: (code: number) => void = () => {}

  private stop(code: number): void {
    if (this.stopped) return
    this.stopped = true
    if (this.renderTimer !== undefined) clearTimeout(this.renderTimer)
    this.followAbort?.abort()
    process.off('SIGTERM', this.onSignal)
    process.off('SIGINT', this.onSignal)
    // Tell the host this frontend is gone instead of leaving the disconnect
    // event as the only signal; the host decides whether the Session survives.
    void this.remote.close().catch(() => {})
    // A stalled host close must not hold the terminal in raw mode forever. The
    // timer stays unref'd so it never keeps a finished process alive on its own.
    this.exitTimer ??= setTimeout(() => {
      this.resolveExit(code)
    }, FINAL_EXIT_GRACE_MS)
    this.exitTimer.unref()
    this.resolveExit(code)
  }

  private async dispose(): Promise<void> {
    const sessionId = this.state.sessionId
    this.terminalCleanup()
    if (sessionId !== undefined) this.stdout.write(localized.resumeSession(String(sessionId)))
    // A fresh install does not have to wait for a child process to go away.
    if (this.exitTimer !== undefined) clearTimeout(this.exitTimer)
    this.followAbort?.abort()
    this.slashCatalogAbort?.abort()
    await Promise.all(this.subscriptions)
    await this.herdr.close()
    await this.remote.close().catch(() => {})
    await this.hostClose().catch(() => {})
  }
}

/** Convenience callback object attached to a connected TUI. */
export function interactionHandlers(app: TuiApp): {
  readonly approval: (request: ApprovalUiRequest) => ReturnType<TuiApp['requestApproval']>
  readonly question: (request: QuestionUiRequest) => ReturnType<TuiApp['requestQuestion']>
} {
  return {
    approval: request => app.requestApproval(request),
    question: request => app.requestQuestion(request),
  }
}

/** Create one question overlay with one editor per requested question. */
export function createQuestionPrompt(
  request: QuestionUiRequest,
  resolve: QuestionPrompt['resolve'],
  reject: QuestionPrompt['reject'],
): QuestionPrompt {
  return {
    kind: 'question',
    request,
    questionIndex: 0,
    answers: [],
    progress: request.questions.map(question => ({
      question,
      index: 0,
      mode: (question.options?.length ?? 0) === 0 ? 'custom' : 'options',
      selected: new Set<string>(),
      custom: '',
    })),
    resolve,
    reject,
  }
}

/**
 * Commit the visible question answer and advance or resolve the batch.
 * @param prompt - mutable question overlay.
 * @returns true when the whole batch settled.
 */
export function commitQuestionAnswer(prompt: QuestionPrompt): boolean {
  const progress = prompt.progress[prompt.questionIndex]
  if (progress === undefined) return false
  const custom = progress.custom.trim()
  prompt.answers.push({
    id: progress.question.id,
    selected: [...progress.selected],
    ...(custom === '' ? {} : { custom }),
  })
  if (prompt.questionIndex + 1 < prompt.progress.length) {
    prompt.questionIndex += 1
    return false
  }
  prompt.resolve({ answers: prompt.answers })
  return true
}

/**
 * The terminal's own command a `/` line names, following the aliases the menu omits.
 * @param line - trimmed draft beginning with `/`.
 * @returns the canonical local command name, or undefined when the Host owns the line.
 */
export function terminalCommandName(line: string): (typeof LOCAL_COMMANDS)[number] | undefined {
  const name = slashName(line)
  return LOCAL_COMMANDS.find(command => command === name) ?? LOCAL_COMMAND_ALIASES[name]
}

/** Where one slash line goes once the terminal's own commands decline it. */
type SlashRoute =
  /** A skill gesture is ordinary prompt text: images ride the prompt to the Host pre-step. */
  | 'prompt'
  /** A Host command accepts attachments only when it declares `input.attachments`. */
  | 'command'
  /** Nothing is dispatched, so the draft and its images stay for correction. */
  | 'refuse'

/**
 * The bare name a slash line addresses.
 * @param line - the complete slash line.
 * @returns the leading token without its slash.
 */
export function slashName(line: string): string {
  return line.slice(1).split(/\s+/u, 1)[0] ?? ''
}

/**
 * Route one slash line that no terminal-local command owns. With no staged images every
 * line goes to the Host command executor; with images, only a skill (which becomes a
 * prompt) or a command declaring `input.attachments` may carry them, and any other name
 * is refused so the images are never silently dropped.
 * @param line - the complete slash line.
 * @param imageCount - staged composer images.
 * @param suggestions - the session's slash catalog, the only attachment declaration the
 * terminal can see.
 * @returns where the line goes.
 */
export function slashRoute(
  line: string,
  imageCount: number,
  suggestions: readonly SlashSuggestion[],
): SlashRoute {
  if (imageCount === 0) return 'command'
  const name = slashName(line)
  const match = suggestions.find(candidate => candidate.name === name)
  if (match?.source === 'skill') return 'prompt'
  return match?.attachments === true ? 'command' : 'refuse'
}

/**
 * Build prompt content in the canonical Web order.
 * @param text - user-entered text, possibly empty for image-only prompts.
 * @param images - images collected in the composer.
 * @returns images first, followed by non-empty text.
 */
export function buildPromptContent(
  text: string,
  images: readonly ClipboardImage[],
): readonly PromptContentPart[] {
  return [
    ...images.map(image => ({
      type: 'image' as const,
      mediaType: image.mediaType,
      data: image.data,
      name: image.name,
    })),
    ...(text.trim() === '' ? [] : [{ type: 'text' as const, text }]),
  ]
}

interface Key {
  readonly name?: string
  readonly ctrl?: boolean
  readonly meta?: boolean
  readonly shift?: boolean
  readonly sequence?: string
  readonly mouse?: MouseInput
}

interface MouseInput {
  readonly action: 'down' | 'drag' | 'up'
  readonly button: 'left' | 'middle' | 'right' | 'none'
  readonly column: number
  readonly row: number
  readonly ctrl?: boolean
  readonly meta?: boolean
  readonly shift?: boolean
}

function isNavigationSequence(sequence: string): boolean {
  return sequence.startsWith('\u001b')
}

/** Decode the key sequences the first TUI accepts from a raw terminal. */
export function decodeTerminalInput(value: string): Key[] {
  const result: Key[] = []
  let text = ''
  let pasting = false
  const flush = (): void => {
    if (text === '') return
    result.push({ sequence: text })
    text = ''
  }
  for (let index = 0; index < value.length;) {
    const char = value[index]
    if (char === undefined) break
    if (char === '\u001b') {
      flush()
      const rest = value.slice(index)
      const mouse = decodeMouseSequence(rest)
      if (mouse !== undefined) {
        result.push(mouse.key)
        index += mouse.length
        continue
      }
      const modified = decodeModifiedKey(rest)
      if (modified !== undefined) {
        result.push(modified.key)
        index += modified.length
        continue
      }
      const known = [
        ['\u001b[200~', { name: 'paste-start' }],
        ['\u001b[201~', { name: 'paste-end' }],
        ['\u001b\r', { name: 'return', meta: true }],
        ['\u001b\u007f', { name: 'backspace', meta: true }],
        ['\u001b\b', { name: 'backspace', meta: true }],
        ['\u001b[A', { name: 'up' }],
        ['\u001b[B', { name: 'down' }],
        ['\u001b[C', { name: 'right' }],
        ['\u001b[D', { name: 'left' }],
        ['\u001b[1;5C', { name: 'right', ctrl: true }],
        ['\u001b[1;5D', { name: 'left', ctrl: true }],
        ['\u001b[1;3C', { name: 'right', meta: true }],
        ['\u001b[1;3D', { name: 'left', meta: true }],
        ['\u001b[1;3A', { name: 'up', meta: true }],
        ['\u001b[1;3B', { name: 'down', meta: true }],
        ['\u001b[1;5A', { name: 'up', ctrl: true }],
        ['\u001b[1;5B', { name: 'down', ctrl: true }],
        ['\u001b[H', { name: 'home' }],
        ['\u001b[F', { name: 'end' }],
        ['\u001bOH', { name: 'home' }],
        ['\u001bOF', { name: 'end' }],
        ['\u001b[Z', { name: 'tab', shift: true }],
        ['\u001b[13;2u', { name: 'return', shift: true }],
        ['\u001b[13;5u', { name: 'return', ctrl: true }],
        ['\u001b[27;2;13~', { name: 'return', shift: true }],
        ['\u001b[3~', { name: 'delete' }],
        ['\u001b[5~', { name: 'pageup' }],
        ['\u001b[6~', { name: 'pagedown' }],
      ] as const
      const match = known.find(([sequence]) => rest.startsWith(sequence))
      if (match !== undefined) {
        if (match[1].name === 'paste-start') pasting = true
        if (match[1].name === 'paste-end') {
          flush()
          pasting = false
        }
        result.push(match[1])
        index += match[0].length
      } else {
        const alt = rest[1]
        if (alt !== undefined && alt !== '[' && alt !== 'O') {
          result.push({ name: alt, meta: true, sequence: rest.slice(0, 2) })
          index += 2
        } else {
          result.push({ name: 'escape' })
          index += 1
        }
      }
      continue
    }
    if (pasting) {
      text += char
      index += 1
      continue
    }
    if (char === '\r') {
      flush()
      result.push({ name: 'return' })
      index += 1
      continue
    }
    if (char === '\n') {
      flush()
      result.push({ name: 'return' })
      index += 1
      continue
    }
    if (char === '\t') {
      flush()
      result.push({ name: 'tab' })
      index += 1
      continue
    }
    if (char === '\u007f' || char === '\b') {
      flush()
      result.push({ name: 'backspace' })
      index += 1
      continue
    }
    const control = controlKey(char)
    if (control !== undefined) {
      flush()
      result.push(control)
      index += 1
      continue
    }
    text += char
    index += 1
  }
  flush()
  return result
}

function decodeMouseSequence(sequence: string): { readonly key: Key; readonly length: number } | undefined {
  const match = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])/u.exec(sequence)
  if (match === null) return undefined
  const code = Number(match[1])
  const column = Number(match[2])
  const row = Number(match[3])
  const base = code & ~(4 | 8 | 16 | 32)
  if (base === 64 || base === 65) {
    return {
      key: { name: base === 64 ? 'wheel-up' : 'wheel-down' },
      length: match[0].length,
    }
  }
  const button = base === 0 ? 'left' : base === 1 ? 'middle' : base === 2 ? 'right' : 'none'
  const action = match[4] === 'm' || base === 3 ? 'up' : (code & 32) === 0 ? 'down' : 'drag'
  return {
    key: {
      name: 'mouse',
      mouse: {
        action,
        button,
        column,
        row,
        ...(code & 4 ? { shift: true } : {}),
        ...(code & 8 ? { meta: true } : {}),
        ...(code & 16 ? { ctrl: true } : {}),
      },
    },
    length: match[0].length,
  }
}

function controlKey(char: string): Key | undefined {
  const code = char.charCodeAt(0)
  if (code < 1 || code > 26) return undefined
  return {
    name: String.fromCharCode(96 + code),
    ctrl: true,
    sequence: char,
  }
}

function decodeModifiedKey(sequence: string): { readonly key: Key; readonly length: number } | undefined {
  const kitty = /^\u001b\[(\d+)(?::\d+)?(?:;(\d+)(?::(\d+))?)?(?:;\d+)*u/u.exec(sequence)
  const xterm = /^\u001b\[27;(\d+);(\d+)(?::(\d+))?~/u.exec(sequence)
  const match = kitty ?? xterm
  if (match === null) return undefined
  const codepoint = Number(kitty === null ? match[2] : match[1])
  const modifiers = Math.max(0, Number((kitty === null ? match[1] : match[2]) ?? '1') - 1)
  const event = Number(match[3] ?? '1')
  if (!Number.isInteger(codepoint) || !Number.isFinite(modifiers)) return undefined
  const key = keyFromCodepoint(codepoint, {
    ctrl: (modifiers & 4) !== 0,
    meta: (modifiers & 2) !== 0,
    shift: (modifiers & 1) !== 0,
  })
  return { key: event === 3 ? { name: 'key-release' } : key, length: match[0].length }
}

function keyFromCodepoint(
  codepoint: number,
  modifiers: Pick<Key, 'ctrl' | 'meta' | 'shift'>,
): Key {
  if (codepoint === 106 && modifiers.ctrl) return { name: 'return' }
  const special: Readonly<Record<number, string>> = {
    9: 'tab',
    13: 'return',
    27: 'escape',
    127: 'backspace',
  }
  const text = codepoint >= 32 ? String.fromCodePoint(codepoint) : undefined
  const name = special[codepoint] ?? text?.toLowerCase()
  return {
    ...(name === undefined ? {} : { name }),
    ...modifiers,
    ...(text === undefined || special[codepoint] !== undefined || modifiers.ctrl || modifiers.meta
      ? {}
      : { sequence: text }),
  }
}

function resolveCompletion(cwd: string, fragment: string): string | undefined {
  const slash = fragment.lastIndexOf('/')
  const directoryPart = slash < 0 ? '' : fragment.slice(0, slash + 1)
  const namePart = slash < 0 ? fragment : fragment.slice(slash + 1)
  const absoluteDirectory = resolve(cwd, directoryPart === '' ? '.' : directoryPart)
  let entries: string[]
  try {
    entries = readdirSync(absoluteDirectory)
  } catch (error) {
    void error
    return undefined
  }
  const matches = entries.filter(name => name.startsWith(namePart)).sort()
  if (matches.length === 0) return undefined
  let common = matches[0] ?? ''
  for (const match of matches.slice(1)) {
    while (!match.startsWith(common)) common = common.slice(0, -1)
  }
  const candidate = `${directoryPart}${common}`
  try {
    const absolute = resolve(cwd, candidate)
    if (statSync(absolute).isDirectory()) return `${candidate}/`
  } catch (error) {
    void error
  }
  return candidate
}

function compactNumber(value: number): string {
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}m`
}

/** Turn stable Host failures into terminal-readable recovery guidance. */
export function friendlyError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  if (!(error instanceof TuiError) || error.remoteCode === undefined) return error.message
  const code = error.remoteCode.toUpperCase()
  if (code.includes('QUOTA')) return `Provider quota is exhausted. ${error.message}`
  if (code.includes('RATE_LIMIT')) return `Provider rate limit reached. ${error.message}`
  if (code.includes('TIMEOUT')) return `The request timed out. ${error.message}`
  if (code.includes('TRANSPORT')) return `The model connection failed. ${error.message}`
  if (code.includes('STREAM_CLOSED')) return `The model stream closed early. ${error.message}`
  if (code.includes('EMPTY_RESPONSE')) return `The model returned no content. ${error.message}`
  return error.message
}

/** Format one model catalog for `/status` and diagnostics. */
export function catalogSummary(catalog: ModelCatalog): string {
  const choices = modelChoices(catalog)
  return choices.map(choice => `${choice.provider}/${choice.model}`).join('\n')
}

/**
 * Model picker factory kept outside the command method for tests.
 * @param catalog - host model catalog.
 * @returns a picker at the model stage, before any route is highlighted for depth.
 */
export function modelPicker(catalog: ModelCatalog): ModelPicker {
  return { kind: 'models', items: modelChoices(catalog), index: 0, stage: 'model', effortIndex: 0 }
}

/** Session picker factory kept outside the command method for tests. */
export function sessionPicker(items: readonly SessionSummary[]): SessionPicker {
  return { kind: 'sessions', items, index: 0 }
}
