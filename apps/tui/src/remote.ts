/** Public Client Remote connection used by the terminal frontend. */

import { Context } from '@deepseek-ai/cordis'
import type {
  ModelCatalog,
  RemoteResult,
  SessionFollowFrame,
  SessionId,
  SessionSummary,
} from '@deepseek-ai/dsh-api-remotes/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  ConnectionHandle,
  ConnectionWebSocket,
} from '@deepseek-ai/dsh-client-connection/client'
import type {
  MessageId,
  ToolCallId,
} from '@deepseek-ai/dsh-llm/types'
import type {
  PromptContentPart,
  QueueAction,
  SessionControlFrame,
  SessionState,
  SessionRequestId,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type {
  CommandExecution,
  CommandSubmitAttachment,
} from '@deepseek-ai/dsh-commands/types'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import type {
  AskUserQuestionAnswer,
} from '@deepseek-ai/dsh-user-questions/types'
import WebSocket from 'ws'
import { installConnection } from '@deepseek-ai/dsh-client-connection/client'
import * as Registry from '@deepseek-ai/dsh-typert-registry/client'
import * as Gateway from '@deepseek-ai/dsh-api-gateway/client'
import * as Remotes from '@deepseek-ai/dsh-api-remotes/client'
import { safeUrl, TuiError } from './error.ts'
import type { WebHost } from './host.ts'
import type { ApprovalUiRequest, QuestionUiRequest } from './ui.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    connection: ConnectionHandle
  }
}

/** Interactive callbacks owned by the terminal application. */
export interface RemoteInteractionHandlers {
  readonly approval: (request: ApprovalUiRequest) => Promise<ApprovalOutcome>
  readonly question: (request: QuestionUiRequest) => Promise<AskUserQuestionAnswer>
  readonly sessionStatus?: (sessionId: SessionId, running: boolean) => void
  readonly sessionError?: (sessionId: SessionId, message: string) => void
}

/** One slash command advertised by the Host command registry. */
export interface HostCommandChoice {
  readonly name: string
  readonly description: string
  /** Whether the command declares `input.attachments`, so a composer may submit images with it. */
  readonly attachments?: boolean
}

/** One user-invocable skill advertised for the current Session. */
export interface HostSkillChoice {
  readonly name: string
  readonly description: string
}

/** One authenticated, owned Client Remote composition. */
export class TuiRemoteClient {
  private closing: Promise<void> | undefined

  private constructor(
    private readonly context: Context,
    readonly hostHome: () => string | undefined,
  ) {}

  /**
   * Exchange the launch token for an API cookie and mount the public Client
   * Remote composition.
   * @param host - tokenized host entry and origin.
   * @param handlers - approval and question UI callbacks.
   * @returns connected Remote client.
   */
  static async connect(host: WebHost, handlers: RemoteInteractionHandlers): Promise<TuiRemoteClient> {
    const cookie = await connectCookie(host.entryUrl)
    const context = new Context()
    installConnection(context, {
      interactions: 'answer',
      transport: {
        fetch: authenticatedFetch(host.origin, cookie),
        createWebSocket: authenticatedWebSocket(cookie),
        streamBaseUrl: host.origin.href,
      },
      location: { hostname: host.origin.hostname },
    })
    try {
      await context.plugin(Registry).await()
      await context.plugin(Gateway).await()
      await context.plugin(Remotes).await()
      const client = new TuiRemoteClient(context, () => context.remote.$host.home)
      client.registerInteractions(handlers)
      await client.waitConnected()
      return client
    } catch (error) {
      await context.fiber.dispose()
      throw error
    }
  }

  private registerInteractions(handlers: RemoteInteractionHandlers): void {
    this.context.remote.$on('approval/request', async function (request, _next) {
      return handlers.approval({
        toolName: request.toolName,
        ...(request.callId === undefined ? {} : { callId: request.callId }),
        ...(request.reason === undefined ? {} : { reason: request.reason }),
        ...(request.displayReason === undefined ? {} : { displayReason: request.displayReason }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })
    })
    this.context.remote.$on('user-questions/request', async function (request, _next) {
      return handlers.question({
        questions: request.questions,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(request.wait === undefined ? {} : { wait: request.wait }),
      })
    })
    this.context.remote.$on('api-session/status', (sessionId, running) => {
      handlers.sessionStatus?.(sessionId, running)
    })
    this.context.remote.$on('api-session/error', (sessionId, message) => {
      handlers.sessionError?.(sessionId, message)
    })
  }

  private async waitConnected(): Promise<void> {
    const timeoutAt = Date.now() + 15_000
    while (Date.now() < timeoutAt) {
      if (this.context.connection.state.getSnapshot() === 'connected') return
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new TuiError(
      'CONNECTION_TIMEOUT',
      'connected to the session RPC endpoint, but the live event stream did not become ready',
    )
  }

  /** List durable Sessions without resuming an Agent. */
  async listSessions(): Promise<readonly SessionSummary[]> {
    return unwrap(await this.context.remote.session.list({}), 'session list').items
  }

  /** Create or reuse a blank Session for the current directory. */
  async createSession(cwd: string, sessionId?: SessionId): Promise<SessionId> {
    return unwrap(await this.context.remote.session.create({
      cwd,
      ...(sessionId === undefined ? {} : { sessionId }),
    }), 'session create').sessionId
  }

  /**
   * Fork a Session at an exact event, keeping that event and everything before it.
   * @param sessionId - the source Session, left unchanged.
   * @param atSeq - the last event seq the fork keeps.
   * @returns the new Session.
   */
  async forkSession(sessionId: SessionId, atSeq: number): Promise<SessionId> {
    return unwrap(await this.context.remote.session.fork({ sessionId, atSeq }), 'session fork').sessionId
  }

  /** Open the live Session journal with an initial history window. */
  followSession(sessionId: SessionId, signal: AbortSignal): AsyncIterable<SessionFollowFrame> {
    return this.context.remote.session.follow({
      address: { kind: 'session', sessionId },
      activate: true,
      assistantStream: true,
      maxMessages: 80,
    }, signal)
  }

  /** Follow Host-owned projection updates; cancellation closes this subscription. */
  control(signal: AbortSignal): AsyncIterable<SessionControlFrame> {
    return this.context.remote.session.control(signal)
  }

  /** Follow authoritative execution state, including the initial running state. */
  observeState(sessionId: SessionId, signal: AbortSignal): AsyncIterable<SessionState> {
    return this.context.remote.session.observeState({ sessionId }, signal)
  }

  /** Submit text and image prompt content. */
  async prompt(
    sessionId: SessionId,
    content: readonly PromptContentPart[],
    mode: 'queue' | 'steer',
  ): Promise<void> {
    unwrap(await this.context.remote.session.prompt({
      requestId: brandString<SessionRequestId>(randomUUID()),
      sessionId,
      mode,
      content,
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }), 'session prompt')
  }

  /** Cancel the active turn while retaining pending input. */
  async cancel(sessionId: SessionId): Promise<void> {
    unwrap(await this.context.remote.session.cancel({ sessionId }), 'session cancel')
  }

  /** Edit, remove, or steer one still-pending inbox occurrence. */
  async updateQueue(sessionId: SessionId, itemId: string, action: QueueAction): Promise<void> {
    unwrap(await this.context.remote.session.updateQueue({
      sessionId,
      itemId: brandString<MessageId>(itemId),
      action,
    }), 'session queue update')
  }

  /** Read the routed model catalog. */
  async modelCatalog(): Promise<ModelCatalog> {
    return unwrap(await this.context.remote.session.modelCatalog(), 'model catalog')
  }

  /** Select a model for the current Session. */
  async selectModel(
    sessionId: SessionId,
    provider: string,
    model: string,
    reasoningEffort?: string,
  ): Promise<void> {
    unwrap(await this.context.remote.session.selectModel({
      sessionId,
      provider,
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    }), 'session model selection')
  }

  /**
   * Execute a host slash command against one Session.
   * @param sessionId - receiving Session.
   * @param line - complete slash line.
   * @param attachments - encoded clipboard images staged for this submission; the Host
   * rejects them for a command that does not declare `input.attachments`.
   * @returns the command's own text and whether this line reached a command at all,
   * or undefined when no command claims the name (a skill, for example).
   */
  async command(
    sessionId: SessionId,
    line: string,
    attachments: readonly CommandSubmitAttachment[] = [],
  ): Promise<CommandExecution | undefined> {
    const execution = unwrap(
      await this.context.remote.commands.execute(sessionId, line, attachments),
      `command ${line}`,
    )
    if (execution === undefined || execution.result.kind === 'success') return execution
    return { ...execution, result: { kind: 'error', text: `error: ${execution.result.text}` } }
  }

  /** List Host slash commands visible to this Session. */
  async listCommands(sessionId: SessionId): Promise<readonly HostCommandChoice[]> {
    const commands = unwrap(await this.context.remote.commands.list(sessionId), 'command list')
    return commands.map(command => ({
      name: command.name,
      description: command.description,
      ...(command.input?.attachments === true ? { attachments: true } : {}),
    }))
  }

  /** List user-invocable skills visible to this Session. */
  async listSkills(
    sessionId: SessionId,
    signal: AbortSignal,
  ): Promise<readonly HostSkillChoice[]> {
    const result = unwrap(await this.context.remote.skills.list({ sessionId }, signal), 'skill list')
    return result.skills.map(skill => ({
      name: skill.name,
      description: skill.description,
    }))
  }

  /** Answer one pending continued question through its owning Session. */
  async answerQuestion(
    sessionId: SessionId,
    callId: string,
    answer: AskUserQuestionAnswer,
  ): Promise<boolean> {
    return unwrap(await this.context.remote.userQuestions.answer(
      sessionId,
      brandString<ToolCallId>(callId),
      answer,
    ), 'question answer')
  }

  /** Close streams, sockets, and all Client plugin effects. */
  close(): Promise<void> {
    this.closing ??= this.context.fiber.dispose()
    return this.closing
  }
}

async function connectCookie(entryUrl: URL): Promise<string> {
  const connectUrl = new URL('connect', new URL('/', entryUrl))
  connectUrl.searchParams.set('token', entryUrl.searchParams.get('token') ?? '')
  connectUrl.searchParams.set('interactions', 'answer')
  let response: Response
  try {
    response = await fetch(connectUrl, { redirect: 'manual' })
  } catch (error) {
    throw new TuiError('CONNECT_FAILED', `could not reach the DSH host at ${safeUrl(entryUrl)}`, { cause: error })
  }
  const cookie = response.headers.getSetCookie()
    .map(value => value.split(';', 1)[0] ?? '')
    .find(value => value.startsWith('dsh-auth-') && value.includes('='))
  if (!cookie) {
    throw new TuiError(
      'CONNECT_FAILED',
      `DSH host refused the API connection (HTTP ${String(response.status)}); use a fresh tokenized URL printed by dsh web`,
    )
  }
  return cookie
}

function authenticatedFetch(origin: URL, cookie: string): typeof fetch {
  return (input, init = {}) => {
    const url = input instanceof Request ? input.url : new URL(String(input), origin)
    const headers = new Headers(input instanceof Request ? input.headers : init.headers)
    headers.set('cookie', cookie)
    return fetch(url, { ...init, headers })
  }
}

function authenticatedWebSocket(cookie: string): (url: string) => ConnectionWebSocket {
  return url => new WebSocket(url, { headers: { cookie } })
}

function unwrap<T>(result: RemoteResult<T>, operation: string): T {
  if (result.ok) return result.value
  throw new TuiError(
    'REMOTE_FAILED',
    `${operation} failed: ${result.error.code}: ${result.error.message}`,
    undefined,
    result.error.code,
  )
}
