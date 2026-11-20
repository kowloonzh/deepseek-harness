/** Optional, serialized lifecycle reports to the Herdr pane that launched DSH. */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const SOURCE = 'dsh-tui'

/** Lifecycle state understood by Herdr's agent sidebar. */
export interface HerdrState {
  readonly sessionId: string
  readonly state: 'idle' | 'working' | 'blocked'
  readonly message?: string
}

/** Injectable process runner; each invocation must settle within its timeout. */
export type HerdrRunner = (binary: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<string>

/** Best-effort Herdr reports; failures never interrupt the agent or write over its terminal. */
export class HerdrReporter {
  private readonly binary: string | undefined
  private readonly pane: string | undefined
  private pending: HerdrState | undefined
  private last: string | undefined
  private task: Promise<void> | undefined
  private closed = false
  private closing: Promise<void> | undefined
  private sequence = 0
  private resumeSupported: boolean | undefined

  /**
   * @param env - inherited pane identity and socket location.
   * @param run - bounded runner, replaceable for isolated tests.
   */
  constructor(private readonly env: NodeJS.ProcessEnv, private readonly run: HerdrRunner = runHerdr) {
    if (env.HERDR_ENV === '1' && env.HERDR_BIN_PATH && env.HERDR_PANE_ID && env.HERDR_SOCKET_PATH) {
      this.binary = env.HERDR_BIN_PATH
      this.pane = env.HERDR_PANE_ID
    }
  }

  /**
   * Queue the latest state without waiting for IPC; duplicate reports are suppressed.
   * @param state - current Session and lifecycle state.
   */
  update(state: HerdrState): void {
    if (this.closed || this.binary === undefined) return
    const key = JSON.stringify(state)
    if (key === this.last) return
    this.last = key
    this.pending = state
    this.start()
  }

  /** Stop new reports, await in-flight IPC, then release this source's pane ownership. */
  close(): Promise<void> {
    this.closing ??= this.dispose()
    return this.closing
  }

  private async dispose(): Promise<void> {
    this.closed = true
    this.pending = undefined
    await this.task
    await this.send(['pane', 'release-agent', this.pane ?? '', ...this.identity()])
  }

  private start(): void {
    this.task ??= this.drain().finally(() => {
      this.task = undefined
      if (!this.closed && this.pending !== undefined) this.start()
    })
  }

  private identity(): string[] {
    this.sequence = Math.max(this.sequence + 1, Date.now() * 1000)
    return ['--source', SOURCE, '--agent', 'dsh', '--seq', String(this.sequence)]
  }

  private async drain(): Promise<void> {
    if (this.resumeSupported === undefined) {
      const version = await this.send(['--version'])
      const match = /herdr (\d+)\.(\d+)\.(\d+)/u.exec(version ?? '')
      this.resumeSupported = match !== null && (
        Number(match[1]) > 0 || Number(match[2]) > 9 || (Number(match[2]) === 9 && Number(match[3]) >= 2)
      )
    }
    while (!this.closed && this.pending !== undefined) {
      const state = this.pending
      this.pending = undefined
      const args = [
        'pane', 'report-agent', this.pane ?? '', ...this.identity(),
        '--state', state.state, '--agent-session-id', state.sessionId,
        ...(state.message === undefined ? [] : ['--message', state.message]),
      ]
      // Herdr restore argv excludes bearer URLs and accepts no quotes or control characters.
      if (this.resumeSupported && /^[a-zA-Z0-9_-]+$/u.test(state.sessionId) && !this.env.DSH_URL) {
        args.push('--', 'dsh', 'tui', '--resume', state.sessionId)
      }
      await this.send(args)
    }
  }

  private async send(args: readonly string[]): Promise<string | undefined> {
    if (this.binary === undefined) return undefined
    try {
      return await this.run(this.binary, args, this.env)
    } catch (_reportFailed) {
      // Herdr owns display metadata only; unavailable IPC leaves DSH operation valid.
      return undefined
    }
  }
}

async function runHerdr(binary: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
  const result = await execute(binary, args, {
    env, timeout: 1500, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, windowsHide: true,
  })
  return result.stdout
}
