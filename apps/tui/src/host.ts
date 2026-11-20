/** Web profile host discovery and lifecycle for the terminal frontend. */

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { TuiError } from './error.ts'

/** Tokenized Web entry URL and the child this invocation owns, if any. */
export interface WebHost {
  /** Tokenized URL used once to mint the API connection cookie. */
  readonly entryUrl: URL
  /** Normalized HTTP(S) origin with a trailing slash. */
  readonly origin: URL
  /** Stop the host only when this TUI process started it. */
  close(): Promise<void>
}

/** Inputs used to start a web host without coupling tests to the real CLI. */
export interface SpawnWebHostOptions {
  readonly entrypoint: string
  readonly execArgv: readonly string[]
  readonly env?: NodeJS.ProcessEnv
  readonly timeoutMs?: number
  readonly port?: number
}

const HOST_LINE = /^dsh web:\s+(http(?:s)?:\/\/\S+)\s*$/u
const HOST_OVERLAY = fileURLToPath(new URL('../overlays/lean-web-host.yml', import.meta.url))

/**
 * Resolve the host-only overlay used when the TUI starts its own Web profile.
 * @returns absolute path to the packaged overlay.
 */
export function tuiHostOverlayPath(): string {
  if (!existsSync(HOST_OVERLAY)) {
    throw new TuiError('HOST_START_FAILED', `TUI host overlay is missing: ${HOST_OVERLAY}`)
  }
  return HOST_OVERLAY
}

/**
 * Build child arguments for the TUI-owned Web host.
 * @param options - CLI entrypoint, inherited Node flags, and optional fixed port.
 * @returns arguments passed to Node for `dsh web`.
 */
export function webHostArguments(
  options: Pick<SpawnWebHostOptions, 'entrypoint' | 'execArgv' | 'port'>,
): string[] {
  return [
    ...options.execArgv,
    options.entrypoint,
    'web',
    '--patch',
    tuiHostOverlayPath(),
    '--no-open',
    '--port',
    String(options.port ?? 0),
  ]
}

/**
 * Parse the authenticated entry URL printed by `dsh web`.
 * @param line - one complete stdout line.
 * @returns the URL, or undefined when the line is not the startup line.
 */
export function parseWebHostLine(line: string): URL | undefined {
  const match = HOST_LINE.exec(line.trim())
  if (match?.[1] === undefined) return undefined
  try {
    return new URL(match[1])
  } catch (error) {
    throw new TuiError('HOST_URL_INVALID', 'dsh web printed an invalid startup URL', { cause: error })
  }
}

/**
 * Normalize a Web entry URL and require the launch token used by `/connect`.
 * @param value - `DSH_URL` or a URL captured from `dsh web`.
 * @returns tokenized entry URL and its origin.
 */
export function normalizeEntryUrl(value: string | URL): Pick<WebHost, 'entryUrl' | 'origin'> {
  let url: URL
  try {
    url = new URL(value)
  } catch (error) {
    throw new TuiError('HOST_URL_INVALID', `invalid DSH_URL: ${String(value)}`, { cause: error })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TuiError('HOST_URL_INVALID', 'DSH_URL must use http: or https:')
  }
  if (!url.searchParams.has('token')) {
    throw new TuiError(
      'HOST_URL_TOKEN_MISSING',
      'DSH_URL must be the tokenized URL printed by dsh web; unauthenticated local access is not supported',
    )
  }
  const origin = new URL(url.origin)
  origin.pathname = '/'
  return { entryUrl: url, origin }
}

/**
 * Start `dsh web --no-open --port 0` and wait for its authenticated entry URL.
 * @param options - current CLI entrypoint, inherited Node arguments, and startup bound.
 * @returns owned host handle.
 */
export async function spawnWebHost(options: SpawnWebHostOptions): Promise<WebHost> {
  const child = spawn(process.execPath, webHostArguments(options), {
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    const entryUrl = await waitForEntryUrl(child, options.timeoutMs ?? 30_000)
    child.stdout.resume()
    child.stderr.resume()
    const normalized = normalizeEntryUrl(entryUrl)
    let closing: Promise<void> | undefined
    return {
      ...normalized,
      close: () => {
        closing ??= stopChild(child)
        return closing
      },
    }
  } catch (error) {
    await stopChild(child)
    throw error
  }
}

function waitForEntryUrl(
  child: ChildProcessByStdio<null, Readable, Readable>,
  timeoutMs: number,
): Promise<URL> {
  return new Promise((resolve, reject) => {
    let settled = false
    let stderr = ''
    let stdout = ''
    const timer = setTimeout(() => {
      fail(new TuiError('HOST_READY_TIMEOUT', `dsh web did not become ready within ${String(timeoutMs)} ms`))
    }, timeoutMs)
    const finish = (): void => {
      settled = true
      clearTimeout(timer)
      child.stdout.off('data', onStdout)
      child.stderr.off('data', onStderr)
      child.off('error', onError)
      child.off('exit', onExit)
    }
    const fail = (error: Error): void => {
      if (settled) return
      finish()
      reject(error)
    }
    const onStdout = (chunk: Buffer): void => {
      stdout += chunk.toString()
      const lines = stdout.split(/\r?\n/u)
      stdout = lines.pop() ?? ''
      for (const line of lines) {
        const url = parseWebHostLine(line)
        if (url === undefined || settled) continue
        settled = true
        finish()
        resolve(url)
      }
    }
    const onStderr = (chunk: Buffer): void => {
      stderr = (stderr + chunk.toString()).slice(-16_384)
    }
    const onError = (error: Error): void => {
      fail(new TuiError('HOST_START_FAILED', `could not start dsh web: ${error.message}`, { cause: error }))
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      const detail = stderr.trim()
      fail(new TuiError(
        'HOST_EXITED',
        `dsh web exited before becoming ready (code ${String(code)}, signal ${String(signal)})${detail === '' ? '' : `: ${detail}`}`,
      ))
    }
    child.stdout.on('data', onStdout)
    child.stderr.on('data', onStderr)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

async function stopChild(child: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const closed = new Promise<void>((resolve) => { child.once('close', () => { resolve() }) })
  child.kill('SIGTERM')
  const timer = setTimeout(() => { child.kill('SIGKILL') }, 5_000)
  await closed
  clearTimeout(timer)
}
