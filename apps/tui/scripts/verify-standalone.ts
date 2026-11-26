/**
 * Install a packed `@kowloonzh/dsh-tui` tarball the way a user would, and run it.
 *
 * Everything happens in a fresh temporary directory: an empty consumer project, its own
 * `DSH_HOME`, and nothing from this workspace on the module path. The dependencies come from
 * the configured npm registry, so a dependency npm does not carry fails here, before publishing.
 *
 * 1. `npm install <tarball>` into the consumer.
 * 2. The installed `@deepseek-ai/dsh` is the exact version the tarball pins.
 * 3. `dsh-tui --help` names the command.
 * 4. In a pseudo-terminal, `dsh-tui` starts its Host, shows the empty Session, and `/quit`
 *    exits with code 0.
 *
 * Usage: `tsx apps/tui/scripts/verify-standalone.ts [tarball] [--cache <npm cache dir>] [--keep]`
 * (default: the newest tarball in `dist/standalone`). The pseudo-terminal is driven by Python's
 * standard `pty` module, so no package is added for it.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '../../..')
const HOST_PACKAGE = '@deepseek-ai/dsh'
const READY = 'Type a message or /help'

/** Runs `argv` in a pty, waits for READY, types `/quit`, and exits with the child's code. */
const PTY_DRIVER = String.raw`
import os, pty, re, select, sys, time
ready, timeout, argv = sys.argv[1], float(sys.argv[2]), sys.argv[3:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
import fcntl, struct, termios
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
plain = lambda data: re.sub(r'\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]', '', data)
seen, sent, deadline, status = '', False, time.monotonic() + timeout, None
while time.monotonic() < deadline:
    readable, _, _ = select.select([fd], [], [], 0.5)
    if readable:
        try:
            chunk = os.read(fd, 65536).decode('utf-8', 'replace')
        except OSError:
            chunk = ''
        seen += chunk
        if not chunk:
            break
    if not sent and ready in plain(seen):
        sent = True
        os.write(fd, b'\x15/quit\r')
    done, code = os.waitpid(pid, os.WNOHANG)
    if done:
        status = code
        break
if status is None:
    os.kill(pid, 9)
    _, status = os.waitpid(pid, 0)
tail = plain(seen)[-1500:]
print('ready' if sent else 'not-ready', os.waitstatus_to_exitcode(status))
if not sent or os.waitstatus_to_exitcode(status) != 0:
    print(tail)
    sys.exit(1)
`

function newestTarball(): string {
  const directory = join(ROOT, 'dist/standalone')
  const tarballs = readdirSync(directory).filter(name => name.endsWith('.tgz')).map(name => join(directory, name))
  const newest = tarballs.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0]
  if (newest === undefined) throw new Error('no tarball in dist/standalone; run pack:standalone first')
  return newest
}

function step(label: string): void {
  process.stdout.write(`\n== ${label}\n`)
}

function main(): void {
  const args = process.argv.slice(2)
  const cacheIndex = args.indexOf('--cache')
  const cache = cacheIndex >= 0 ? args[cacheIndex + 1] : undefined
  const positional = args.filter((arg, index) => !arg.startsWith('--') && index !== cacheIndex + 1)
  const tarball = resolve(positional[0] ?? newestTarball())
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-tui-verify-'))
  const consumer = join(scratch, 'consumer')
  const env = { ...process.env, DSH_HOME: join(scratch, 'dsh-home'), NODE_PATH: '' }
  delete env.DSH_URL
  delete env.DSH_URL_FILE
  try {
    step(`install ${tarball}`)
    execFileSync('mkdir', ['-p', consumer, env.DSH_HOME])
    writeFileSync(join(consumer, 'package.json'), '{"name":"consumer","private":true}\n')
    execFileSync('npm', ['install', '--no-audit', '--no-fund', ...(cache === undefined ? [] : ['--cache', resolve(cache)]), tarball], {
      cwd: consumer,
      stdio: 'inherit',
    })

    step('pinned Host')
    const tui = JSON.parse(readFileSync(join(consumer, 'node_modules/@kowloonzh/dsh-tui/package.json'), 'utf8')) as {
      readonly version: string
      readonly dependencies: Readonly<Record<string, string>>
    }
    const host = JSON.parse(readFileSync(join(consumer, 'node_modules', HOST_PACKAGE, 'package.json'), 'utf8')) as { readonly version: string }
    const pinned = tui.dependencies[HOST_PACKAGE]
    if (host.version !== pinned) throw new Error(`installed ${HOST_PACKAGE}@${host.version}, but the package pins ${pinned ?? 'nothing'}`)
    process.stdout.write(`@kowloonzh/dsh-tui@${tui.version} → ${HOST_PACKAGE}@${host.version}\n`)

    const bin = join(consumer, 'node_modules/.bin/dsh-tui')
    step('dsh-tui --help')
    const help = execFileSync(bin, ['--help'], { cwd: scratch, env, encoding: 'utf8' })
    if (!help.includes('dsh-tui')) throw new Error(`--help does not name dsh-tui:\n${help}`)
    process.stdout.write(`${help.split('\n').slice(0, 3).join('\n')}\n`)

    step('start in a terminal, then /quit')
    execFileSync('python3', ['-I', '-c', PTY_DRIVER, READY, '120', bin], { cwd: scratch, env, stdio: 'inherit' })
    process.stdout.write('\nstandalone package verified\n')
  } finally {
    if (args.includes('--keep')) process.stdout.write(`kept ${scratch}\n`)
    else rmSync(scratch, { recursive: true, force: true })
  }
}

main()
