/** Keep the local TUI feature isolated from upstream source trees. */

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../../..')
const ALLOWED = [
  '.agents/goals/',
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
    const tracked = execFileSync('git', ['diff', '--name-only', 'origin/master', '--'], { cwd: ROOT, encoding: 'utf8' })
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
    const files = [...new Set([...tracked.split('\n'), ...untracked.split('\n')].filter(Boolean))].sort()
    const outside = files.filter(file => !ALLOWED.some(prefix => file === prefix || file.startsWith(prefix)))
    expect(outside).toEqual([])
  })
})
