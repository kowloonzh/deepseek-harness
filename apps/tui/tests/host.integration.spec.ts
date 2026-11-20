/** Keyless integration through a real web profile host and public Remote client. */

import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnWebHost, type WebHost } from '../src/host.ts'
import { TuiRemoteClient } from '../src/remote.ts'

const ENTRYPOINT = resolve(import.meta.dirname, '../../cli/src/bin.ts')

describe('dsh tui web-profile integration', () => {
  let home: string
  let host: WebHost
  const clients: TuiRemoteClient[] = []

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-tui-integration-'))
    host = await spawnWebHost({
      entrypoint: ENTRYPOINT,
      execArgv: ['--import', 'tsx/esm'],
      env: { ...process.env, DSH_HOME: home },
      timeoutMs: 60_000,
      port: 0,
    })
  }, 90_000)

  afterAll(async () => {
    for (const client of clients.reverse()) await client.close()
    await host?.close()
    if (home !== undefined) rmSync(home, { recursive: true, force: true })
  })

  it('creates and lists the same Session through independent web-profile clients', async () => {
    const first = await connect()
    const created = await first.createSession(process.cwd())
    expect((await first.listSessions()).some(item => item.sessionId === created)).toBe(true)
    expect((await first.listCommands(created)).map(command => command.name)).toContain('compact')
    expect((await first.modelCatalog()).default).toBeDefined()

    const second = await connect()
    expect((await second.listSessions()).some(item => item.sessionId === created)).toBe(true)

    const abort = new AbortController()
    try {
      const stream = first.followSession(created, abort.signal)
      for await (const frame of stream) {
        expect(frame.type).toBe('snapshot')
        break
      }
    } finally {
      abort.abort()
    }
  }, 30_000)

  it('uses the web profile without creating a TUI profile or changing its patch', async () => {
    const web = join(home, 'profiles/web')
    const patch = join(web, 'cordis.patch.yml')
    expect(existsSync(patch)).toBe(true)
    const marker = '\n# tui integration marker\n'
    writeFileSync(patch, `${readFileSync(patch, 'utf8')}${marker}`)
    const before = hash(patch)

    const client = await connect()
    await client.listSessions()
    expect(hash(patch)).toBe(before)
    expect(existsSync(join(home, 'profiles/tui'))).toBe(false)
  })

  async function connect(): Promise<TuiRemoteClient> {
    const client = await TuiRemoteClient.connect(host, {
      approval: async () => 'rejected',
      question: async () => ({ answers: [] }),
    })
    clients.push(client)
    return client
  }
})

function hash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
