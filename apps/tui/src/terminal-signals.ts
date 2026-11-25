/**
 * What DSH tells the terminal around the screen it paints: the window title and desktop
 * notifications, as codex does (`terminal_title.rs`, `notifications/`).
 */

import { basename } from 'node:path'

/** Braille spinner frames for a running turn, codex's terminal-title spinner. */
export const TITLE_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
/** Time between spinner frames. */
export const TITLE_SPINNER_INTERVAL_MS = 100
/** The title prefix while an approval or a question waits on the operator. */
export const ACTION_REQUIRED_PREFIX = '[ ! ] Action Required'
/** Longest turn-complete preview, as codex's `AGENT_NOTIFICATION_PREVIEW_GRAPHEMES`. */
const PREVIEW_CHARS = 200
const MAX_TITLE_CHARS = 120
// Controls, zero-width and bidi formatting characters, and the byte-order mark.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/gu

/** How notifications reach the desktop. */
export type NotificationMethod = 'osc9' | 'osc777' | 'bel' | 'off'

/** What the title shows. */
export interface TitleState {
  readonly running: boolean
  readonly actionRequired: boolean
  /** The Session title; the default placeholder is left out. */
  readonly sessionTitle: string | undefined
  readonly cwd: string
  /** Spinner frame counter while running. */
  readonly frame: number
}

/**
 * The window title, as codex's default `activity | thread-name | project-name`.
 * @param state - what the title reflects.
 * @returns plain title text.
 */
export function terminalTitle(state: TitleState): string {
  const project = basename(state.cwd) || state.cwd
  const parts = [state.sessionTitle, project].filter((part): part is string => part !== undefined && part.trim() !== '')
  if (state.actionRequired) return [ACTION_REQUIRED_PREFIX, ...parts].join(' | ')
  const body = parts.join(' | ')
  if (!state.running) return body
  const spinner = TITLE_SPINNER_FRAMES[state.frame % TITLE_SPINNER_FRAMES.length] ?? ''
  return body === '' ? spinner : `${spinner} ${body}`
}

/**
 * OSC 0 for a title, with control and invisible formatting characters removed and the length
 * bounded, so model-written session titles cannot inject escapes.
 * @param title - plain title text.
 * @returns the escape sequence, or '' when nothing visible remains.
 */
export function titleSequence(title: string): string {
  const clean = Array.from(title.replaceAll(INVISIBLE, ' ')
    .replaceAll(/\s+/gu, ' ').trim()).slice(0, MAX_TITLE_CHARS).join('')
  return clean === '' ? '' : `\u001b]0;${clean}\u0007`
}

/** Push the title the shell set, so it can be restored on exit (xterm title stack). */
export const SAVE_TITLE = '\u001b[22;0t'
/** Clear DSH's title, then pop the saved one where the terminal keeps a title stack. */
export const RESTORE_TITLE = '\u001b]0;\u0007\u001b[23;0t'

/**
 * Pick the notification method, as codex's `Auto`: OSC 9 for terminals known to show it,
 * otherwise the bell. `DSH_TUI_NOTIFY` overrides (`osc9`, `osc777`, `bel`, `off`).
 * @param env - the process environment.
 * @returns the method.
 */
export function notificationMethod(env: NodeJS.ProcessEnv): NotificationMethod {
  const forced = env.DSH_TUI_NOTIFY?.trim().toLowerCase()
  if (forced === 'osc9' || forced === 'osc777' || forced === 'bel' || forced === 'off') return forced
  const program = (env.TERM_PROGRAM ?? '').toLowerCase()
  const term = (env.TERM ?? '').toLowerCase()
  const osc9 = ['ghostty', 'iterm.app', 'wezterm', 'warpterminal'].includes(program)
    || env.LC_TERMINAL === 'iTerm2'
    || env.KITTY_WINDOW_ID !== undefined
    || env.GHOSTTY_RESOURCES_DIR !== undefined
    || env.WEZTERM_PANE !== undefined
    || term.includes('kitty') || term.includes('ghostty')
  return osc9 ? 'osc9' : 'bel'
}

/**
 * The bytes that post one desktop notification.
 * @param message - notification body.
 * @param method - how to post it.
 * @param env - the environment; inside tmux the sequence is wrapped for passthrough.
 * @returns the escape sequence, or '' when notifications are off.
 */
export function notificationSequence(message: string, method: NotificationMethod, env: NodeJS.ProcessEnv): string {
  if (method === 'off') return ''
  if (method === 'bel') return '\u0007'
  const body = Array.from(message, char => /[\u0000-\u001f\u007f-\u009f]/u.test(char) ? ' ' : method === 'osc777' && char === ';' ? '；' : char).join('')
  const sequence = method === 'osc9' ? `\u001b]9;${body}\u0007` : `\u001b]777;notify;DSH;${body}\u001b\\`
  return env.TMUX === undefined ? sequence : `\u001bPtmux;${sequence.replaceAll('\u001b', '\u001b\u001b')}\u001b\\`
}

/**
 * The turn-complete notification body: the final answer with whitespace collapsed and cut to a
 * preview, as codex's `agent_turn_preview`.
 * @param answer - the last assistant text of the turn, if any.
 * @returns the body.
 */
export function turnCompleteMessage(answer: string | undefined): string {
  const normalized = (answer ?? '').split(/\s+/u).filter(part => part !== '').join(' ')
  if (normalized === '') return 'Agent turn complete'
  const chars = Array.from(normalized)
  return chars.length <= PREVIEW_CHARS ? normalized : `${chars.slice(0, PREVIEW_CHARS - 1).join('')}…`
}
