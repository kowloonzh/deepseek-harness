import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import semver from 'semver'
import { afterEach, describe, expect, it } from 'vitest'
import { importedPackages, standaloneDependencies, standaloneVersion } from '../scripts/pack-standalone.ts'
import { upstreamRelease } from '../scripts/upstream-release.ts'
import { resolveDshEntrypoint } from '../src/standalone.ts'

describe('standalone package', () => {
  const scratch: string[] = []
  afterEach(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('lists the packages a bundle imports, not builtins, relative paths, or string contents', () => {
    const bundle = [
      'import { a } from "@deepseek-ai/dsh-llm/remote";',
      'import {',
      '  b,',
      '} from "marked";',
      'import "ws";',
      'import { readFileSync } from "node:fs";',
      'import path from "path";',
      'export { c } from "./local.js";',
      'const lazy = await import("@deepseek-ai/dsh-brand");',
      'const text = "import x from \\"not-a-dependency\\"";',
      "const help = 'see import notes';",
    ].join('\n')
    expect(importedPackages(bundle)).toEqual(['@deepseek-ai/dsh-brand', '@deepseek-ai/dsh-llm', 'marked', 'ws'])
  })

  it('pins workspace imports and the Host to exact versions and keeps third-party ranges', () => {
    const workspace = new Map([
      ['@deepseek-ai/dsh-llm', { version: '0.2.3-alpha.2', private: false }],
      ['@deepseek-ai/dsh', { version: '0.2.3-alpha.2', private: false }],
    ])
    expect(standaloneDependencies(['@deepseek-ai/dsh-llm', 'ws'], { ws: '^8.21.3' }, workspace)).toEqual({
      '@deepseek-ai/dsh': '0.2.3-alpha.2',
      '@deepseek-ai/dsh-llm': '0.2.3-alpha.2',
      ws: '^8.21.3',
    })
  })

  it('refuses an undeclared import and a private workspace package', () => {
    const workspace = new Map([
      ['@deepseek-ai/dsh', { version: '1.0.0', private: false }],
      ['@deepseek-ai/secret', { version: '1.0.0', private: true }],
    ])
    expect(() => standaloneDependencies(['left-pad'], {}, workspace)).toThrow(/does not declare/u)
    expect(() => standaloneDependencies(['@deepseek-ai/secret'], {}, workspace)).toThrow(/private/u)
  })

  it('versions the package after the Host it pins, in semver order', () => {
    expect(standaloneVersion('0.2.3-alpha.2', 1)).toBe('0.2.3-alpha.2.tui.1')
    expect(standaloneVersion('0.2.3-alpha.2', 3)).toBe('0.2.3-alpha.2.tui.3')
    expect(standaloneVersion('0.2.3', 2)).toBe('0.2.3-tui.2')
    expect(() => standaloneVersion('0.2.3', 0)).toThrow(/positive integer/u)
    // Ordered as npm orders them: alpha.2 < alpha.2.tui.N < alpha.3 < rc < 0.2.3-tui.N.
    const ordered = ['0.2.3-alpha.2', '0.2.3-alpha.2.tui.1', '0.2.3-alpha.2.tui.2', '0.2.3-alpha.3', '0.2.3-rc.5.tui.1', '0.2.3-tui.1', '0.2.3-tui.2']
    expect(semver.gt('0.2.3-alpha.2-tui.1', '0.2.3-alpha.3'), 'a dash after the Host prerelease breaks the order').toBe(true)
    for (const version of ordered) expect(semver.valid(version), version).toBe(version)
    expect([...ordered].reverse().sort(semver.compare)).toEqual(ordered)
    // A plain range never picks a TUI prerelease by accident; users install by dist-tag.
    expect(semver.satisfies('0.2.3-tui.1', '^0.2.3')).toBe(false)
  })

  it('syncs onto the newest upstream release that is tagged and on npm', () => {
    const tags = ['dsh-v0.2.3-alpha.2', 'dsh-v0.2.3-alpha.3', 'dsh-v0.2.3', 'dsh-v0.2.4-alpha.1', 'desktop-v9.0.0', 'dsh-vbad']
    expect(upstreamRelease('0.2.3-alpha.2', tags, ['0.2.3-alpha.2', '0.2.3-alpha.3', '0.2.3'])).toBe('0.2.3')
    // Tagged but not yet on npm: the standalone package could not pin it.
    expect(upstreamRelease('0.2.3', tags, ['0.2.3'])).toBeUndefined()
    expect(upstreamRelease('0.2.3', tags, ['0.2.3', '0.2.4-alpha.1'])).toBe('0.2.4-alpha.1')
    // On npm without an upstream tag: there is no commit to rebase onto.
    expect(upstreamRelease('0.2.3', ['dsh-v0.2.3'], ['0.2.3', '0.2.5'])).toBeUndefined()
  })

  it('finds the dsh executable of the installed Host package', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-tui-standalone-'))
    scratch.push(root)
    const host = join(root, 'node_modules/@deepseek-ai/dsh')
    mkdirSync(join(host, 'lib'), { recursive: true })
    writeFileSync(join(host, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', bin: { dsh: 'lib/bin.js' } }))
    const from = pathToFileURL(join(root, 'node_modules/@kowloonzh/dsh-tui/lib/index.js')).href
    expect(resolveDshEntrypoint(from)).toBe(join(host, 'lib/bin.js'))

    const bare = mkdtempSync(join(tmpdir(), 'dsh-tui-standalone-'))
    scratch.push(bare)
    expect(() => resolveDshEntrypoint(pathToFileURL(join(bare, 'index.js')).href)).toThrow(/not installed/u)
  })
})
