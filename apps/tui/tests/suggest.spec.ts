/** The Web profile entry behind composer suggestions, kept current at each launch. */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureNextPromptEntry, entryBlock, webProfilePatchPath, withEntry } from '../src/suggest.ts'
import { Config, suggestionFromOutput, transcriptText } from '../src/host/next-prompt.ts'

const EXISTING = '# operator notes\n- id: llm-pi-ai # magpie\n  config:\n    key: kept\n'
const homes: string[] = []

function profileHome(patch?: string): { readonly env: NodeJS.ProcessEnv; readonly path: string } {
  const home = mkdtempSync(join(tmpdir(), 'dsh-tui-suggest-'))
  homes.push(home)
  const env = { DSH_HOME: home }
  const path = webProfilePatchPath(env)
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
  writeFileSync(join(home, 'profiles', 'web', 'package.json'), '{}')
  if (patch !== undefined) writeFileSync(path, patch)
  return { env, path }
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('next-prompt profile entry', () => {
  it('appends the block once and leaves the rest of the patch as it was', () => {
    const { env, path } = profileHome(EXISTING)
    expect(ensureNextPromptEntry('/opt/tui/lib/host/next-prompt.js', undefined, env)).toBe('added')
    const once = readFileSync(path, 'utf8')
    expect(once.startsWith(EXISTING)).toBe(true)
    expect(once).toContain('name: "/opt/tui/lib/host/next-prompt.js"')
    expect(ensureNextPromptEntry('/opt/tui/lib/host/next-prompt.js', undefined, env)).toBe('unchanged')
    expect(readFileSync(path, 'utf8')).toBe(once)
    expect(readdirSync(join(path, '..')).filter(name => name.endsWith('.tui-tmp'))).toEqual([])
  })

  it('keeps a config the operator added inside the block', () => {
    const configured = entryBlock('/old/next-prompt.js').replace(
      'next-prompt.js"\n',
      'next-prompt.js"\n      config:\n        maxTokens: 80\n',
    )
    const { env, path } = profileHome(`${EXISTING}${configured}`)
    expect(ensureNextPromptEntry('/old/next-prompt.js', undefined, env)).toBe('unchanged')
    expect(ensureNextPromptEntry('/new/next-prompt.js', undefined, env)).toBe('updated')
    expect(readFileSync(path, 'utf8')).toBe(`${EXISTING}${configured.replace('/old/', '/new/')}`)
  })

  it('rewrites only its own block when the plugin moved', () => {
    const { env, path } = profileHome(`${EXISTING}${entryBlock('/old/next-prompt.js')}- id: after\n  disabled: true\n`)
    expect(ensureNextPromptEntry('/new/next-prompt.js', undefined, env)).toBe('updated')
    expect(readFileSync(path, 'utf8')).toBe(`${EXISTING}${entryBlock('/new/next-prompt.js')}- id: after\n  disabled: true\n`)
  })

  it('creates the patch of an existing profile, and never a profile', () => {
    const { env, path } = profileHome()
    expect(ensureNextPromptEntry('/p.js', undefined, env)).toBe('added')
    expect(readFileSync(path, 'utf8')).toBe(entryBlock('/p.js'))
    expect(ensureNextPromptEntry('/p.js', undefined, { DSH_HOME: join(tmpdir(), 'dsh-tui-no-such-home') })).toBe('skipped')
  })

  it('leaves a hand-written entry or a half-removed block alone', () => {
    expect(withEntry(`${EXISTING}- id: tui-next-prompt\n  name: /mine.js\n`, '/p.js')).toEqual({ outcome: 'skipped' })
    const [begin] = entryBlock('/p.js').split('\n')
    expect(withEntry(`${EXISTING}${begin}\n- insert: []\n`, '/p.js')).toEqual({ outcome: 'skipped' })
  })

  it('adds a newline before the block when the patch lacks a final one', () => {
    expect(withEntry('- id: a', '/p.js').text).toBe(`- id: a\n${entryBlock('/p.js')}`)
  })
})

describe('next-prompt plugin config', () => {
  it('fills defaults and rejects a half route or a bad bound', () => {
    expect(Config['~standard'].validate(undefined)).toEqual({ value: { maxTokens: 200, timeoutMs: 30_000, maxTranscriptChars: 12_000 } })
    expect(Config['~standard'].validate({ provider: 'p', model: 'm', maxTokens: 80 })).toMatchObject({
      value: { provider: 'p', model: 'm', maxTokens: 80, timeoutMs: 30_000 },
    })
    expect(Config['~standard'].validate({ provider: 'p' })).toMatchObject({ issues: [{ path: ['model'] }] })
    expect(Config['~standard'].validate({ timeoutMs: -1 })).toMatchObject({ issues: [{ path: ['timeoutMs'] }] })
  })
})

describe('next-prompt plugin text', () => {
  it('keeps the newest conversation text within its bound', () => {
    const text = transcriptText([
      { role: 'user', content: [{ type: 'text', text: 'old' }] },
      { role: 'tool', content: [{ type: 'text', text: 'skipped' }] } as never,
      { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(20_000) }, { type: 'text', text: 'Want me to sort?' }] },
    ])
    expect(text.length).toBe(12_000)
    expect(text.endsWith('Want me to sort?')).toBe(true)
    expect(text).not.toContain('skipped')
  })

  it('takes one unquoted line of the model output', () => {
    expect(suggestionFromOutput('\n  "要，按数量排序"  \nwhy: because')).toBe('要，按数量排序')
    expect(suggestionFromOutput('   \n')).toBe('')
  })
})
