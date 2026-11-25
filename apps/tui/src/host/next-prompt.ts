/**
 * Host plugin behind the TUI's composer suggestion: after a turn, guess the operator's next
 * message from the conversation.
 *
 * It runs inside the Host, which owns the model routes, and is reached through one Host command
 * so the TUI needs no new Remote surface. The TUI hides that command from its menus and its
 * transcript. The TUI writes this plugin into the Web profile patch, whose live reload loads it
 * into a Host that is already running; `config:` under that entry overrides the defaults below.
 */

import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { CommandDefinitionId } from '@deepseek-ai/dsh-commands/types'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { extractTextContent, type Message } from '@deepseek-ai/dsh-llm/message'
import { NEXT_PROMPT_COMMAND } from '../suggest.ts'

declare module '@deepseek-ai/dsh-llm/types' {
  interface LlmRequestPurposeMap {
    'tui-next-prompt': true
  }
}

export const name = NEXT_PROMPT_COMMAND
export const inject = ['commands', 'llm']

const MAX_SUGGESTION_CHARS = 200

const SYSTEM = [
  'You predict what the user of an AI coding assistant will type next.',
  'You get the recent conversation. Reply with only the single next message the user is most likely to send:',
  'one short line in the language the user writes in, phrased as the user would type it, with no quotes,',
  'prefix, explanation or Markdown. Prefer the concrete next step the assistant offered or asked about,',
  'such as approving a proposal. If nothing natural follows, reply with an empty line.',
].join('\n')

/** Plugin options, set under the entry's `config:` in the profile patch. */
export interface Config {
  /** Provider route for suggestions; with `model`, replaces the Session's own model. */
  readonly provider?: string | undefined
  /** Model id for suggestions; with `provider`, replaces the Session's own model. */
  readonly model?: string | undefined
  /** Output token bound for one suggestion. */
  readonly maxTokens: number
  /** How long one suggestion may take, in milliseconds. */
  readonly timeoutMs: number
  /** How much of the conversation, newest last, the model reads, in characters. */
  readonly maxTranscriptChars: number
}

const DEFAULTS: Config = { maxTokens: 200, timeoutMs: 30_000, maxTranscriptChars: 12_000 }

interface ConfigIssue {
  readonly message: string
  readonly path?: readonly PropertyKey[]
}

/**
 * Standard Schema validator for {@link Config}, which the loader runs on the entry's `config:`.
 * Written by hand: the TUI carries no schema library, and the shape is small.
 */
export const Config = {
  '~standard': {
    version: 1 as const,
    vendor: 'dsh-tui',
    validate(value: unknown): { readonly value: Config } | { readonly issues: readonly ConfigIssue[] } {
      if (value === undefined || value === null) return { value: DEFAULTS }
      if (typeof value !== 'object' || Array.isArray(value)) return { issues: [{ message: 'expected an object' }] }
      const input = value as Readonly<Record<string, unknown>>
      const issues: ConfigIssue[] = []
      const text = (key: 'provider' | 'model'): string | undefined => {
        const item = input[key]
        if (item === undefined || (typeof item === 'string' && item !== '')) return item
        issues.push({ message: 'expected a non-empty string', path: [key] })
        return undefined
      }
      const count = (key: 'maxTokens' | 'timeoutMs' | 'maxTranscriptChars'): number => {
        const item = input[key]
        if (item === undefined) return DEFAULTS[key]
        if (typeof item === 'number' && Number.isInteger(item) && item > 0) return item
        issues.push({ message: 'expected a positive integer', path: [key] })
        return DEFAULTS[key]
      }
      const config: Config = {
        provider: text('provider'),
        model: text('model'),
        maxTokens: count('maxTokens'),
        timeoutMs: count('timeoutMs'),
        maxTranscriptChars: count('maxTranscriptChars'),
      }
      if ((config.provider === undefined) !== (config.model === undefined)) {
        issues.push({ message: 'set provider and model together', path: [config.provider === undefined ? 'provider' : 'model'] })
      }
      return issues.length > 0 ? { issues } : { value: config }
    },
  },
}

/**
 * The recent conversation as plain text, newest last, cut to a bound from the front.
 * @param messages - the Session's model-visible messages.
 * @param maxChars - the most characters kept.
 * @returns role-labelled lines.
 */
export function transcriptText(messages: readonly Pick<Message, 'role' | 'content'>[], maxChars = DEFAULTS.maxTranscriptChars): string {
  const lines: string[] = []
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const text = extractTextContent(message.content, { separator: '\n', trim: true })
    if (text !== '') lines.push(`${message.role === 'user' ? 'User' : 'Assistant'}: ${text}`)
  }
  const joined = lines.join('\n\n')
  return joined.length <= maxChars ? joined : joined.slice(joined.length - maxChars)
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
 * Guess the next message of the invoking Session.
 * @param ctx - Host context holding the LLM service.
 * @param config - plugin options.
 * @param invocation - the command call, carrying the Session's Agent.
 * @returns the guess as the command's text; '' when there is nothing to go on.
 */
async function suggest(ctx: Context, config: Config, { agent, signal }: CommandInvocation): Promise<CommandResult> {
  // The route the next step would use, so a model just picked with /model is honored.
  const route = config.provider !== undefined && config.model !== undefined
    ? { provider: config.provider, model: config.model }
    : agent.model.current()
  const transcript = transcriptText(agent.session.deriveMessages(), config.maxTranscriptChars)
  if (route === undefined || transcript === '') return { kind: 'success', text: '' }
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)])
  const call = await ctx.llm.prepareCall(
    { provider: route.provider, model: route.model, maxTokens: config.maxTokens },
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
      source: { kind: 'user' },
    })],
    purpose: 'tui-next-prompt',
    signal: timeout,
  })) {
    assembler.push(chunk)
  }
  return { kind: 'success', text: suggestionFromOutput(extractTextContent(assembler.blocks(), { separator: '\n' })) }
}

/**
 * Register the suggestion command for this plugin's lifetime.
 * @param ctx - Host context with the command registry and the LLM service.
 * @param config - plugin options.
 */
export function apply(ctx: Context, config: Config = DEFAULTS): void {
  const active = new Set<Promise<CommandResult>>()
  const handler = (invocation: CommandInvocation): Promise<CommandResult> => {
    const operation = suggest(ctx, config, invocation)
    active.add(operation)
    const retire = (): void => { active.delete(operation) }
    void operation.then(retire, retire)
    return operation
  }
  ctx.effect(function* () {
    // Teardown runs last-in first-out: the command goes first, then in-flight guesses settle,
    // so a live reload never cuts a guess off midway.
    yield async () => { await Promise.allSettled(active) }
    yield ctx.commands.register({
      definitionId: brandString<CommandDefinitionId>('@deepseek-ai/dsh-tui-next-prompt'),
      name: NEXT_PROMPT_COMMAND,
      description: 'Suggest the next prompt for the TUI composer (used by dsh tui)',
      recordInput: false,
      handler,
    })
  }, `${NEXT_PROMPT_COMMAND} lifecycle`)
}
