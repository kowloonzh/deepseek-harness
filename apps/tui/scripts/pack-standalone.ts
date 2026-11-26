/**
 * Pack the TUI as the standalone npm package `@kowloonzh/dsh-tui`.
 *
 * The workspace package stays `@deepseek-ai/dsh-tui-app`, wired into `dsh tui`, so the
 * branch keeps rebasing onto upstream. This script stages a separate package from the
 * same build: `standalone/package.json` supplies its identity, and the dependencies are
 * derived here rather than written by hand.
 *
 * - Every bare import left in the bundled JavaScript becomes a dependency. A workspace
 *   package is pinned to its exact checked-out version; a third-party one keeps the range
 *   `apps/tui/package.json` declares.
 * - `@deepseek-ai/dsh` is pinned to the exact version of `apps/cli`: the TUI starts that
 *   package's Host, and its overlay and Remote calls track that release, so a newer Host
 *   is never picked up silently.
 * - The version follows the pinned Host: see `standaloneVersion`.
 * - The Node engine range is the CLI's.
 *
 * Usage: `tsx apps/tui/scripts/pack-standalone.ts [--out <dir>]` (default `dist/standalone`).
 * It always rebuilds apps/tui first: a stale bundle would publish code the commit does not hold.
 * The workspace packages the TUI imports must already be compiled (`pnpm run typecheck`). Nothing is published: the tarball is handed to
 * `verify-standalone.ts` and then to `npm publish <tarball>`.
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '../../..')
const TUI = join(ROOT, 'apps/tui')
const HOST_PACKAGE = '@deepseek-ai/dsh'
/** The built files that run; the bin script imports the bundle. */
const BUNDLES = ['lib/index.js', 'lib/host/next-prompt.js']

interface WorkspacePackage {
  readonly name: string
  readonly version: string
  readonly private: boolean
  readonly path: string
}

interface Manifest {
  readonly name: string
  readonly version?: string
  readonly release?: number
  readonly files?: readonly string[]
  readonly dependencies?: Readonly<Record<string, string>>
  readonly engines?: Readonly<Record<string, string>>
  readonly [key: string]: unknown
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

/**
 * Every package in the pnpm workspace, by name.
 * @returns name to version, privacy, and directory.
 */
function workspacePackages(): Map<string, WorkspacePackage> {
  const listed = JSON.parse(execFileSync('pnpm', ['ls', '-r', '--json', '--depth', '-1'], { cwd: ROOT, encoding: 'utf8' })) as WorkspacePackage[]
  return new Map(listed.map(item => [item.name, item]))
}

/**
 * The package names a bundle still imports at run time.
 * @param source - bundled JavaScript.
 * @returns bare package names, without Node builtins.
 */
export function importedPackages(source: string): string[] {
  const names = new Set<string>()
  const builtins = new Set(builtinModules)
  // Statements the bundler emits at the start of a line (`import … from "x"`, `import "x"`,
  // `export … from "x"`) and dynamic `import("x")`; string contents never match.
  const name = String.raw`([@a-z][\w.@/-]*)`
  const pattern = new RegExp(
    String.raw`^\s*(?:import|export)\b[^;]*?\bfrom\s*["']${name}["']|^\s*import\s*["']${name}["']|\bimport\(\s*["']${name}["']\s*\)`,
    'gmu',
  )
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? ''
    if (specifier.startsWith('node:') || builtins.has(specifier)) continue
    const parts = specifier.split('/')
    names.add(specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0] ?? specifier)
  }
  return [...names].sort()
}

/**
 * The standalone package's dependencies.
 * @param imported - packages the bundles import.
 * @param declared - `apps/tui/package.json` dependency ranges.
 * @param workspace - workspace packages by name.
 * @returns name to exact version or declared range, the Host package included.
 */
export function standaloneDependencies(
  imported: readonly string[],
  declared: Readonly<Record<string, string>>,
  workspace: ReadonlyMap<string, Pick<WorkspacePackage, 'version' | 'private'>>,
): Record<string, string> {
  const dependencies: Record<string, string> = {}
  for (const name of imported) {
    const local = workspace.get(name)
    if (local !== undefined) {
      if (local.private) throw new Error(`${name} is private to the workspace; bundle it instead (tsdown alwaysBundle)`)
      dependencies[name] = local.version
      continue
    }
    const range = declared[name]
    if (range === undefined) throw new Error(`the bundle imports ${name}, which apps/tui/package.json does not declare`)
    dependencies[name] = range
  }
  const host = workspace.get(HOST_PACKAGE)
  if (host === undefined) throw new Error(`${HOST_PACKAGE} is missing from the workspace`)
  dependencies[HOST_PACKAGE] = host.version
  return Object.fromEntries(Object.entries(dependencies).sort(([left], [right]) => left.localeCompare(right)))
}

/**
 * The standalone package's version: the Host version it pins, then `tui.<release>`.
 *
 * A stable Host gets `-tui.<release>` (`0.2.3` → `0.2.3-tui.1`); `tui` sorts after `alpha`,
 * `beta`, and `rc`, where `0.2.3-1` would sort below them. A prerelease Host already has its
 * `-`, so the same identifiers follow a dot (`0.2.3-alpha.2` → `0.2.3-alpha.2.tui.1`), sorting
 * after that Host prerelease and before the next. `0.2.3-alpha.2-tui.1` would not: semver reads
 * `2-tui` as one alphanumeric identifier, which sorts after every numeric one, `alpha.3` too.
 * @param host - the exact `@deepseek-ai/dsh` version.
 * @param release - 1 for the first TUI release on that Host, counting up.
 * @returns the semver version to publish.
 */
export function standaloneVersion(host: string, release: number): string {
  if (!Number.isInteger(release) || release < 1) throw new Error(`release must be a positive integer, not ${release}`)
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(host)) throw new Error(`unexpected Host version ${host}`)
  return `${host}${host.includes('-') ? '.' : '-'}tui.${release}`
}

function main(): void {
  const args = process.argv.slice(2)
  const outIndex = args.indexOf('--out')
  const out = resolve(ROOT, outIndex >= 0 ? args[outIndex + 1] ?? '' : 'dist/standalone')
  // Build logs go to stderr: stdout carries only the JSON summary, for `| jq`.
  execFileSync('npx', ['tsc', '-b', 'apps/tui'], { cwd: ROOT, stdio: ['ignore', 2, 2] })
  execFileSync('npx', ['tsdown'], { cwd: TUI, stdio: ['ignore', 2, 2] })
  for (const bundle of BUNDLES) {
    if (!existsSync(join(TUI, bundle))) throw new Error(`missing ${bundle}; build apps/tui first`)
  }

  const template = readJson<Manifest>(join(TUI, 'standalone/package.json'))
  const declared = readJson<Manifest>(join(TUI, 'package.json')).dependencies ?? {}
  const cli = readJson<Manifest>(join(ROOT, 'apps/cli/package.json'))
  const workspace = workspacePackages()
  const imported = [...new Set(BUNDLES.flatMap(bundle => importedPackages(readFileSync(join(TUI, bundle), 'utf8'))))]
  const dependencies = standaloneDependencies(imported, declared, workspace)
  const { '//version': _note, release, ...identity } = template
  const manifest: Manifest = {
    ...identity,
    version: standaloneVersion(dependencies[HOST_PACKAGE] ?? '', release ?? Number.NaN),
    ...(cli.engines === undefined ? {} : { engines: cli.engines }),
    dependencies,
  }

  const stage = join(out, 'package')
  rmSync(stage, { recursive: true, force: true })
  // One tarball per run, so nothing older is mistaken for this build.
  if (existsSync(out)) for (const name of readdirSync(out)) if (name.endsWith('.tgz')) rmSync(join(out, name))
  mkdirSync(stage, { recursive: true })
  for (const path of ['bin/dsh-tui.js', ...BUNDLES, 'overlays']) {
    cpSync(join(TUI, path), join(stage, path), { recursive: true })
  }
  cpSync(join(TUI, 'standalone/README.md'), join(stage, 'README.md'))
  cpSync(join(ROOT, 'LICENSE'), join(stage, 'LICENSE'))
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  const packed = execFileSync('npm', ['pack', '--json', '--pack-destination', out], { cwd: stage, encoding: 'utf8' })
  const [result] = JSON.parse(packed) as { readonly filename: string; readonly size: number; readonly entryCount: number }[]
  if (result === undefined) throw new Error('npm pack reported no tarball')
  process.stdout.write(`${JSON.stringify({
    tarball: join(out, result.filename),
    name: manifest.name,
    version: manifest.version,
    host: `${HOST_PACKAGE}@${manifest.dependencies?.[HOST_PACKAGE] ?? '?'}`,
    files: result.entryCount,
    bytes: result.size,
    dependencies: manifest.dependencies,
  }, null, 2)}\n`)
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) main()
