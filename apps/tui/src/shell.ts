/**
 * One-shot shell execution for `!` lines typed into the terminal composer.
 *
 * A `!` line runs in the terminal's own process, against the directory the
 * frontend was started in, and never reaches the Host or the model. Output is
 * transcript text only: it is not a prompt, so the model cannot act on it
 * unless the operator asks for that separately.
 */

import { spawn } from 'node:child_process'
import { localized } from './locale.ts'

/** Largest captured stdout+stderr one `!` line may produce. */
export const MAX_SHELL_OUTPUT_BYTES = 256 * 1024

/** Wall-clock budget for one `!` line. */
export const SHELL_TIMEOUT_MS = 120 * 1000

/** One finished `!` line. */
export interface ShellResult {
  /** Shell exit status, or null when the shell died from a signal. */
  readonly code: number | null
  /** Signal that ended the shell, when it did not exit normally. */
  readonly signal: NodeJS.Signals | null
  /** Captured stdout, truncated to the capture limit. */
  readonly stdout: string
  /** Captured stderr, truncated to the capture limit. */
  readonly stderr: string
  /** Whether any stream lost bytes to the capture limit. */
  readonly truncated: boolean
  /** Whether the call ended by the timeout rather than by the shell exiting. */
  readonly timedOut: boolean
}

/** How a `!` draft splits into the command to run and the images it carries. */
export interface ShellLine {
  /** The command text after the leading `!`. */
  readonly command: string
}

/**
 * Recognize a `!` line in the composer draft.
 *
 * A leading `!` alone is not enough: `!=` and `!==` are how people type
 * negation, so a draft that opens with those stays an ordinary prompt.
 * @param line - raw composer draft.
 * @returns the command to run when the draft is a `!` line, else undefined.
 */
export function shellLine(line: string): ShellLine | undefined {
  if (!line.startsWith('!')) return undefined
  if (line.startsWith('!=')) return undefined
  const command = line.slice(1).trim()
  return command === '' ? undefined : { command }
}

/**
 * The shell that runs a `!` line, following the operator's environment.
 * @param env - environment to inspect; defaults to this process's.
 * @returns the configured shell, else the platform default.
 */
export function shellCommand(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SHELL?.trim()
  if (configured !== undefined && configured !== '') return configured
  return process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
}

/** The arguments that make the selected shell run one command string. */
function shellArguments(shell: string, command: string): string[] {
  return /(?:^|[/\\])cmd\.exe$/iu.test(shell) ? ['/d', '/s', '/c', command] : ['-c', command]
}

/**
 * Working directory for a `!` line: the operator's home unless the frontend
 * runs inside a Session workspace.
 * @param cwd - candidate directory; undefined means this process's.
 * @returns the directory to spawn in.
 */
export function shellWorkingDirectory(cwd?: string): string {
  return cwd ?? process.cwd()
}

/**
 * Render a finished `!` line as transcript text.
 * @param command - the command that ran.
 * @param result - its captured outcome.
 * @returns one system block: the command, then captured output and status.
 */
export function shellResultText(command: string, result: ShellResult): string {
  const lines = [`$ ${command}`]
  const stdout = result.stdout.trimEnd()
  const stderr = result.stderr.trimEnd()
  if (stdout !== '') lines.push(stdout)
  if (stderr !== '') lines.push(stderr)
  if (result.truncated) lines.push(localized.shellOutputTruncated(MAX_SHELL_OUTPUT_BYTES / 1024))
  if (result.timedOut) lines.push(localized.shellTimedOut(SHELL_TIMEOUT_MS / 1000))
  else if (result.signal !== null) lines.push(localized.shellSignal(result.signal))
  else if (result.code !== 0) lines.push(localized.shellExitCode(result.code ?? -1))
  return lines.join('\n')
}

/** Options for {@link runShellLine}. */
export interface RunShellLineOptions {
  /** Working directory for the command. */
  readonly cwd?: string
  /** Command timeout; defaults to {@link SHELL_TIMEOUT_MS}. */
  readonly timeoutMs?: number
  /** Capture limit per stream; defaults to {@link MAX_SHELL_OUTPUT_BYTES}. */
  readonly maxBytes?: number
  /** Environment; defaults to this process's. */
  readonly env?: NodeJS.ProcessEnv
  /** Run one command string and stream its output; replaced in tests. */
  readonly run?: (command: string, options: RunShellCommandOptions) => Promise<ShellResult>
}

/** Options forwarded to one spawn. */
export interface RunShellCommandOptions {
  readonly shell: string
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly timeoutMs: number
  readonly maxBytes: number
}

/**
 * Run one `!` command and settle with everything it printed.
 * @param command - the shell command line.
 * @param options - directory, limits, environment, and runner override.
 * @returns the captured outcome; never rejects for a non-zero exit.
 */
export async function runShellLine(command: string, options: RunShellLineOptions = {}): Promise<ShellResult> {
  const run = options.run ?? runShellCommand
  return run(command, {
    shell: shellCommand(options.env),
    cwd: shellWorkingDirectory(options.cwd),
    env: options.env ?? process.env,
    timeoutMs: options.timeoutMs ?? SHELL_TIMEOUT_MS,
    maxBytes: options.maxBytes ?? MAX_SHELL_OUTPUT_BYTES,
  })
}

/**
 * Spawn the shell for one command and capture its output.
 * @param command - the shell command line.
 * @param options - resolved shell, directory, limits, and environment.
 * @returns the captured outcome.
 */
function runShellCommand(command: string, options: RunShellCommandOptions): Promise<ShellResult> {
  return new Promise((resolve) => {
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let captured = 0
    let truncated = false
    let timedOut = false
    let settled = false

    const collect = (target: Buffer[]) => (chunk: Buffer): void => {
      const remaining = options.maxBytes - captured
      if (remaining <= 0) {
        truncated = true
        return
      }
      const kept = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
      if (kept.length < chunk.length) truncated = true
      captured += kept.length
      target.push(kept)
    }

    // `stdio: 'ignore'` for stdin keeps an interactive command from stealing the
    // composer's keystrokes while it runs.
    const child = spawn(options.shell, shellArguments(options.shell, command), {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        truncated,
        timedOut,
      })
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      // A shell that ignores SIGTERM must not hold the composer hostage.
      setTimeout(() => { child.kill('SIGKILL') }, 2_000).unref()
    }, options.timeoutMs)
    timer.unref()

    child.stdout.on('data', collect(stdout))
    child.stderr.on('data', collect(stderr))
    child.once('error', (error: Error) => {
      stderr.push(Buffer.from(`${error.message}\n`))
      finish(null, null)
    })
    child.once('close', finish)
  })
}
