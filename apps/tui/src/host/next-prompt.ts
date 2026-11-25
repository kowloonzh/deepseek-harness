/**
 * Host plugin behind the TUI's composer suggestion: after a turn, guess the operator's next
 * message from the conversation, as Claude Code's prompt suggestions do.
 *
 * It runs inside the Host, which owns the model routes, and is reached through one Host command
 * so the TUI needs no new Remote surface. The TUI hides that command from its menus and its
 * transcript. The TUI writes this plugin into the Web profile patch, whose live reload loads it
 * into a Host that is already running.
 */

import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { extractTextContent } from '@deepseek-ai/dsh-llm/message'
import type {} from '@deepseek-ai/dsh-commands'
import { NEXT_PROMPT_COMMAND } from '../suggest.ts'

export const name = NEXT_PROMPT_COMMAND
export const inject = ['commands', 'llm']

const MAX_TRANSCRIPT_CHARS = 12_000
const MAX_OUTPUT_TOKENS = 200
const TIMEOUT_MS = 30_000
const MAX_SUGGESTION_CHARS = 200

const SYSTEM = [
  'You predict what the user of an AI coding assistant will type next.',
  'You get the recent conversation. Reply with only the single next message the user is most likely to send:',
  'one short line in the language the user writes in, phrased as the user would type it, with no quotes,',
  'prefix, explanation or Markdown. Prefer the concrete next step the assistant offered or asked about,',
  'such as approving a proposal. If nothing natural follows, reply with an empty line.',
].join('\n')

/** The slice of a Session this plugin reads. */
interface SessionView {
  requestHeader(): { readonly config: { readonly provider: string; readonly model: string } } | undefined
  deriveMessages(): readonly { readonly role: string; readonly content: unknown }[]
}

/** What the route reports about itself: only its reasoning efforts matter here. */
interface RouteInfo {
  readonly reasoning?: { readonly efforts: readonly { readonly id: string }[] }
}

/** The slice of the LLM service this plugin calls. */
interface LlmView {
  prepareCall(
    config: { readonly provider: string; readonly model: string; readonly maxTokens: number },
    signal: AbortSignal,
    configure: (controls: Record<string, unknown>, model: RouteInfo) => Record<string, unknown>,
  ): Promise<{ readonly config: Record<string, unknown>; stream(options: Record<string, unknown>): AsyncIterable<unknown> }>
}

/**
 * The recent conversation as plain text, newest last, cut to a bound from the front.
 * @param messages - the Session's model-visible messages.
 * @returns role-labelled lines.
 */
export function transcriptText(messages: readonly { readonly role: string; readonly content: unknown }[]): string {
  const lines: string[] = []
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    if (!Array.isArray(message.content)) continue
    const text = extractTextContent(message.content as Parameters<typeof extractTextContent>[0], { separator: '\n', trim: true })
    if (text !== '') lines.push(`${message.role === 'user' ? 'User' : 'Assistant'}: ${text}`)
  }
  const joined = lines.join('\n\n')
  return joined.length <= MAX_TRANSCRIPT_CHARS ? joined : joined.slice(joined.length - MAX_TRANSCRIPT_CHARS)
}

/**
 * The suggestion from model output: its first non-empty line, unquoted and bounded.
 * @param text - the model's text.
 * @returns one line, or '' when the model offered nothing.
 */
export function suggestionFromOutput(text: string): string {
  const line = text.split(/\r?\n/u).map(item => item.trim()).find(item => item !== '') ?? ''
  const unquoted = line.replace(/^["'“‘`]+|["'”’`]+$/gu, '').trim()
  return Array.from(unquoted).slice(0, MAX_SUGGESTION_CHARS).join('')
}

/**
 * Register the suggestion command.
 * @param ctx - Host context with the command registry and the LLM service.
 */
export function apply(ctx: Context): void {
  const llm = (ctx as unknown as { llm: LlmView }).llm
  ctx.commands.register({
    name: NEXT_PROMPT_COMMAND,
    description: 'Suggest the next prompt for the TUI composer (used by dsh tui)',
    recordInput: false,
    async handler({ agent, signal }) {
      const session = (agent as unknown as { session: SessionView }).session
      const route = session.requestHeader()?.config
      const transcript = transcriptText(session.deriveMessages())
      if (route === undefined || transcript === '') return { kind: 'success', text: '' }
      const timeout = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
      const call = await llm.prepareCall(
        { provider: route.provider, model: route.model, maxTokens: MAX_OUTPUT_TOKENS },
        timeout,
        (controls, model) => {
          // The cheapest effort the route offers: this is a guess, not a task.
          const effort = model.reasoning?.efforts[0]?.id
          return effort === undefined ? controls : { ...controls, reasoningEffort: effort }
        },
      )
      const assembler = new BlockAssembler()
      for await (const chunk of call.stream({
        ...call.config,
        system: SYSTEM,
        messages: [createUserMessage({
          content: [{ type: 'text', text: `Conversation so far:\n\n${transcript}\n\nThe user's next message:` }],
          source: { kind: 'dsh-tui-next-prompt' },
        } as unknown as Parameters<typeof createUserMessage>[0])],
        purpose: 'tui-next-prompt',
        signal: timeout,
      })) {
        assembler.push(chunk as Parameters<BlockAssembler['push']>[0])
      }
      return { kind: 'success', text: suggestionFromOutput(extractTextContent(assembler.blocks(), { separator: '\n' })) }
    },
  })
}
