/** `!` one-shot shell execution from the composer. */

import { describe, expect, it } from 'vitest'
import {
  MAX_SHELL_OUTPUT_BYTES,
  runShellLine,
  shellCommand,
  shellLine,
  shellResultText,
  type RunShellLineOptions,
  type ShellResult,
} from '../src/shell.ts'

const ok = (stdout = '', stderr = ''): ShellResult => ({
  code: 0,
  signal: null,
  stdout,
  stderr,
  truncated: false,
  timedOut: false,
})

describe('! line recognition', () => {
  it('takes the command after the bang', () => {
    expect(shellLine('!ls -la')).toEqual({ command: 'ls -la' })
    expect(shellLine('!  git status  ')).toEqual({ command: 'git status' })
  })

  it('leaves negation an ordinary prompt', () => {
    // `!=` and `!==` are how people type negation mid-sentence.
    expect(shellLine('!= not a command')).toBeUndefined()
    expect(shellLine('!== compare')).toBeUndefined()
  })

  it('ignores a bare bang and non-bang drafts', () => {
    expect(shellLine('!')).toBeUndefined()
    expect(shellLine('!   ')).toBeUndefined()
    expect(shellLine('ls -la')).toBeUndefined()
  })

  it('claims only lines the slash and prompt routes would not take', () => {
    // A shell line is never a slash line, and a slash line is never a shell line,
    // so the dispatcher can test the bang first without ambiguity.
    expect(shellLine('/help')).toBeUndefined()
    expect(shellLine('!git log --oneline')?.command).toBe('git log --oneline')
    // A command may legitimately contain a slash or a pipe.
    expect(shellLine('!cat /etc/hostname | tr a-z A-Z')?.command).toBe('cat /etc/hostname | tr a-z A-Z')
  })
})

describe('shell selection', () => {
  it('prefers the operator shell and falls back per platform', () => {
    expect(shellCommand({ SHELL: '/bin/zsh' })).toBe('/bin/zsh')
    expect(shellCommand({})).toBe(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh')
  })
})

describe('! command execution', () => {
  it('captures stdout and a zero exit without a status line', async () => {
    const result = await runShellLine('printf hello')
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('hello')
    expect(shellResultText('printf hello', result)).toBe('$ printf hello\nhello')
  })

  it('reports the exit code of a failing command', async () => {
    const result = await runShellLine('exit 3')
    expect(result.code).toBe(3)
    expect(shellResultText('exit 3', result)).toContain('[exit 3]')
  })

  it('keeps stderr and never rejects', async () => {
    const result = await runShellLine('printf oops >&2; exit 0')
    expect(result.stderr).toBe('oops')
    expect(shellResultText('cmd', result)).toContain('oops')
  })

  it('truncates beyond the capture limit and says so', async () => {
    const result = await runShellLine('yes | head -c 400000', { maxBytes: 1024 })
    expect(result.stdout.length).toBeLessThanOrEqual(1024)
    expect(result.truncated).toBe(true)
    expect(shellResultText('big', result)).toContain(`[output truncated at ${String(MAX_SHELL_OUTPUT_BYTES / 1024)} KB]`)
  })

  it('stops a runaway command on the timeout', async () => {
    const result = await runShellLine('sleep 5', { timeoutMs: 150 })
    expect(result.timedOut).toBe(true)
    expect(shellResultText('sleep 5', result)).toContain('timed out')
  })

  it('accepts an injected runner so callers can avoid the real shell', async () => {
    const seen: string[] = []
    const options: RunShellLineOptions = {
      cwd: '/tmp',
      run: async (command, resolved) => {
        seen.push(`${command} @ ${resolved.cwd}`)
        return ok('injected')
      },
    }
    expect((await runShellLine('echo x', options)).stdout).toBe('injected')
    expect(seen).toEqual(['echo x @ /tmp'])
  })
})

describe('! result rendering', () => {
  it('prints the command then trimmed output', () => {
    expect(shellResultText('ls', ok('a\nb\n\n'))).toBe('$ ls\na\nb')
  })

  it('names the signal when the shell was killed', () => {
    const killed: ShellResult = { ...ok(), code: null, signal: 'SIGTERM' }
    expect(shellResultText('x', killed)).toContain('[command killed by SIGTERM]')
  })
})
