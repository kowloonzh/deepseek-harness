/** Keep the local TUI feature isolated from upstream source trees. */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../../..')

/**
 * The upstream baseline this fork tracks.
 *
 * A fork checks out `upstream` as the official repository and `origin` as its own
 * copy, while a clone of the official repository has only `origin`. Try both so the
 * boundary means the same thing in either layout.
 */
function upstreamRef(): string {
  for (const candidate of ['upstream/master', 'origin/master']) {
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', candidate], { cwd: ROOT, encoding: 'utf8' })
      return candidate
    } catch (_missingRef) {
      continue
    }
  }
  throw new Error('fork boundary needs an upstream master ref (upstream/master or origin/master)')
}
const ALLOWED = [
  '.agents/goals/',
  '.github/workflows/dsh-tui-publish.yml',
  'apps/tui/',
  'apps/cli/src/bin.ts',
  'apps/cli/package.json',
  'apps/cli/tsconfig.json',
  'scripts/check-workspace-constraints.ts',
  'tsconfig.client.json',
  'pnpm-lock.yaml',
]

describe('TUI fork boundary', () => {
  it('changes only the isolated app and its explicit launcher integration points', () => {
    const tracked = execFileSync('git', ['diff', '--name-only', upstreamRef(), '--'], { cwd: ROOT, encoding: 'utf8' })
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
    const files = [...new Set([...tracked.split('\n'), ...untracked.split('\n')].filter(Boolean))].sort()
    const outside = files.filter(file => !ALLOWED.some(prefix => file === prefix || file.startsWith(prefix)))
    expect(outside).toEqual([])
  })

  it('keeps the TUI package at the upstream release version', () => {
    // Upstream bumps every workspace package at release time, but never this one: after a
    // rebase onto a new tag, set apps/tui/package.json `version` to the root version.
    const version = (path: string): string => (JSON.parse(readFileSync(resolve(ROOT, path), 'utf8')) as { version: string }).version
    expect(version('apps/tui/package.json'), 'apps/tui/package.json version must follow the root package.json').toBe(version('package.json'))
  })
})
