/**
 * Which upstream release the TUI branch should move to, if any.
 *
 * A release qualifies when upstream tagged it (`dsh-v<version>`) and `@deepseek-ai/dsh@<version>`
 * is on npm: the standalone package pins that Host, so it cannot follow a release npm does not
 * carry yet. Of the qualifying releases newer than the branch's version, the newest wins.
 *
 * Usage: `tsx apps/tui/scripts/upstream-release.ts <current version>` after fetching upstream's
 * `dsh-v*` tags. Prints the version to move to, or nothing when the branch is current.
 */

import { execFileSync } from 'node:child_process'
import semver from 'semver'

const HOST_PACKAGE = '@deepseek-ai/dsh'
const TAG = /^dsh-v(.+)$/u

/**
 * Pick the release to sync onto.
 * @param current - the version the branch is on (root `package.json`).
 * @param tags - upstream tag names.
 * @param published - versions of `@deepseek-ai/dsh` on npm.
 * @returns the newest tagged and published version above `current`, or undefined.
 */
export function upstreamRelease(current: string, tags: readonly string[], published: readonly string[]): string | undefined {
  const onNpm = new Set(published)
  const candidates = tags
    .map(tag => TAG.exec(tag)?.[1])
    .filter((version): version is string => version !== undefined && semver.valid(version) === version)
    .filter(version => onNpm.has(version) && semver.gt(version, current))
  return candidates.sort(semver.rcompare)[0]
}

function main(): void {
  const current = process.argv[2]
  if (current === undefined || semver.valid(current) === null) throw new Error('usage: upstream-release.ts <current version>')
  const tags = execFileSync('git', ['tag', '--list', 'dsh-v*'], { encoding: 'utf8' }).split('\n').filter(Boolean)
  const published = JSON.parse(execFileSync('npm', ['view', HOST_PACKAGE, 'versions', '--json'], { encoding: 'utf8' })) as string[]
  process.stdout.write(upstreamRelease(current, tags, published) ?? '')
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) main()
