/** `dsh tui` entrypoint: connect to the web profile or start its host. */

import { readFileSync } from 'node:fs'
import { TuiApp, interactionHandlers, parseTuiArguments } from './app.ts'
import { safeUrl, TuiError } from './error.ts'
import {
  normalizeEntryUrl,
  spawnWebHost,
  type WebHost,
} from './host.ts'
import { TuiRemoteClient, type RemoteInteractionHandlers } from './remote.ts'
import { bundledPluginPath, ensureNextPromptEntry, SUGGEST_ENV } from './suggest.ts'

/** Inputs supplied by the CLI launcher and overridable by tests. */
export interface RunTuiOptions {
  readonly args: readonly string[]
  readonly entrypoint?: string | undefined
  readonly execArgv?: readonly string[]
  readonly env?: NodeJS.ProcessEnv
  readonly stdin?: NodeJS.ReadStream
  readonly stdout?: NodeJS.WriteStream
  readonly stderr?: NodeJS.WriteStream
}

const HELP = `Usage: dsh tui [--resume [session-id]] [--prompt <text>]

Run the terminal frontend against the normal web profile.

No TUI profile is created. If DSH_URL is unset, this command starts
\`dsh web --no-open --port 0\` on an available loopback port and uses the
authenticated URL it prints.

Options:
  -r, --resume [id]  open the newest Session or the named Session
  -p, --prompt <t>   submit <t> as the first prompt, then exit when the turn ends
  -h, --help         show this help

Environment:
  DSH_URL   tokenized dsh web URL, for example http://127.0.0.1:3080/?token=...
`

/**
 * Run the TUI until exit or failure.
 * @param options - launcher arguments, streams, environment, and host process identity.
 * @returns process exit code.
 */
export async function runTui(options: RunTuiOptions): Promise<number> {
  const parsed = parseTuiArguments(options.args)
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  if (parsed.help) {
    stdout.write(HELP)
    return 0
  }
  const stdin = options.stdin ?? process.stdin
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new TuiError('TUI_NOT_TTY', 'dsh tui requires an interactive terminal on stdin and stdout')
  }

  let host: WebHost | undefined
  let remote: TuiRemoteClient | undefined
  let app: TuiApp | undefined
  try {
    const env = options.env ?? process.env
    const configured = env.DSH_URL
    const handlers: RemoteInteractionHandlers = {
      approval: request => app === undefined
        ? Promise.reject(new Error('TUI is still starting'))
        : interactionHandlers(app).approval(request),
      question: request => app === undefined
        ? Promise.reject(new Error('TUI is still starting'))
        : interactionHandlers(app).question(request),
      sessionStatus: (sessionId, running) => { app?.setRunning(sessionId, running) },
      sessionError: (sessionId, message) => { app?.remoteError(sessionId, message) },
    }
    ensureSuggestions(options.env ?? process.env, configured)
    // The host starts and connects behind the first frame instead of in front of it.
    const connecting = (async () => {
      host = configured === undefined || configured.trim() === ''
        ? await spawnWebHost({
          entrypoint: options.entrypoint ?? requireEntrypoint(),
          execArgv: options.execArgv ?? process.execArgv,
          env: options.env ?? process.env,
        })
        : {
          ...normalizeEntryUrl(configured),
          close: async () => {},
        }
      remote = await TuiRemoteClient.connect(host, handlers)
      return remote
    })()
    // A Host that restarts writes its new tokenized URL here (`dsh-host` does); a dropped
    // connection reads it to log in to the new Host, since the old login is no good there.
    const urlFile = env.DSH_URL_FILE
    let currentUrl = configured?.trim()
    const reconnect = configured === undefined || configured.trim() === '' || urlFile === undefined || urlFile === ''
      ? undefined
      : async (): Promise<TuiRemoteClient | undefined> => {
        let url: string
        try {
          url = readFileSync(urlFile, 'utf8').trim()
        } catch {
          return undefined
        }
        if (url === '' || url === currentUrl) return undefined
        const next = await TuiRemoteClient.connect({ ...normalizeEntryUrl(url), close: async () => {} }, handlers)
        currentUrl = url
        remote = next
        return next
      }
    // Quitting during startup leaves this unawaited; its failure is reported through `run`.
    connecting.catch(() => {})
    return await TuiApp.run({
      remote: connecting,
      // A host still starting is waited for, so quitting early cannot leave it behind.
      hostClose: async () => {
        await connecting.catch(() => {})
        await host?.close()
      },
      resume: parsed.resume,
      prompt: parsed.prompt,
      reconnect,
      stdin,
      stdout,
      env: options.env ?? process.env,
      onApp: (created) => { app = created },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    stderr.write(`dsh tui: ${message}\n`)
    if (error instanceof TuiError && error.code === 'CONNECT_FAILED' && host !== undefined) {
      stderr.write(`dsh tui: host ${safeUrl(host.origin)}\n`)
    }
    return 1
  } finally {
    await remote?.close().catch(() => {})
    await host?.close().catch(() => {})
  }
}

function requireEntrypoint(): string {
  const entrypoint = process.argv[1]
  if (entrypoint === undefined) throw new TuiError('HOST_START_FAILED', 'cannot locate the dsh entrypoint')
  return entrypoint
}

export { TuiError } from './error.ts'

/**
 * Keep the Web profile loading the next-prompt plugin, for a Host on this machine. A failure
 * only costs the suggestions, so it never stops the TUI.
 * @param env - launcher environment.
 * @param configured - the DSH_URL in use, if any.
 */
function ensureSuggestions(env: NodeJS.ProcessEnv, configured: string | undefined): void {
  if (env[SUGGEST_ENV] === 'off') return
  if (configured !== undefined && configured.trim() !== '' && !isLoopback(configured)) return
  const plugin = bundledPluginPath()
  if (plugin === undefined) return
  try {
    ensureNextPromptEntry(plugin, undefined, env)
  } catch {
    // The profile stays as it was; the TUI runs without suggestions.
  }
}

function isLoopback(url: string): boolean {
  try {
    const { hostname } = new URL(url)
    return hostname === 'localhost' || hostname === '[::1]' || hostname.startsWith('127.')
  } catch {
    return false
  }
}
