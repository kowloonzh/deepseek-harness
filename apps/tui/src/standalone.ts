/**
 * The `dsh-tui` executable of the standalone npm package.
 *
 * Inside this repository the TUI runs as `dsh tui`, and the CLI hands it its own
 * entrypoint to start the Web host with. The standalone package has no such caller: it
 * depends on the published `@deepseek-ai/dsh` and starts that package's executable
 * instead, so the Host is always the exact release this TUI was built against.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runTui, type RunTuiOptions } from './index.ts'

/** The package whose `dsh` executable serves the Host. */
export const DSH_PACKAGE = '@deepseek-ai/dsh'

/**
 * Locate the `dsh` executable of the installed `@deepseek-ai/dsh`.
 *
 * Only the `node_modules` directories above this package are searched, never `NODE_PATH` or
 * the global folders: the Host must be the release installed with this TUI, not whichever
 * `dsh` the environment happens to expose.
 * @param from - URL of a file inside the package doing the lookup.
 * @returns the absolute path of the `dsh` bin script.
 * @throws {Error} when the package is not installed or declares no `dsh` bin.
 */
export function resolveDshEntrypoint(from: string = import.meta.url): string {
  const manifestPath = findInstalled(dirname(fileURLToPath(from)), join(DSH_PACKAGE, 'package.json'))
  if (manifestPath === undefined) {
    throw new Error(`dsh-tui: ${DSH_PACKAGE} is not installed next to this package; reinstall @kowloonzh/dsh-tui`)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { readonly bin?: string | Readonly<Record<string, string>> }
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
  if (bin === undefined) throw new Error(`dsh-tui: ${DSH_PACKAGE} declares no dsh executable`)
  return join(dirname(manifestPath), bin)
}

function findInstalled(start: string, relative: string): string | undefined {
  for (let directory = start; ; directory = dirname(directory)) {
    const candidate = join(directory, 'node_modules', relative)
    if (existsSync(candidate)) return candidate
    if (dirname(directory) === directory) return undefined
  }
}

/**
 * Run the TUI as the standalone `dsh-tui` command.
 * @param options - command-line arguments and process facts; the entrypoint is resolved here.
 * @returns the process exit code.
 */
export async function runStandalone(options: Omit<RunTuiOptions, 'entrypoint'>): Promise<number> {
  let entrypoint: string
  try {
    entrypoint = resolveDshEntrypoint()
  } catch (error) {
    ;(options.stderr ?? process.stderr).write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
  return runTui({ command: 'dsh-tui', ...options, entrypoint })
}
