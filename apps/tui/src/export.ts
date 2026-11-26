/**
 * `/export` in the terminal: the Host only answers the Web command with "download requested",
 * leaving the browser to fetch the file, so the TUI fetches it itself and writes it to disk.
 *
 *   /export              Markdown transcript under `$DSH_HOME/exports/`
 *   /export zip          the raw log ZIP (subagents and attachments included) there instead
 *   /export <path>       either one at that path; a `.zip` name picks the ZIP
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** What `/export` writes and where. */
export interface ExportTarget {
  readonly format: 'markdown' | 'zip'
  readonly path: string
}

/**
 * Read the `/export` arguments.
 * @param args - text after `/export`, trimmed.
 * @param sessionId - the Session exported, naming the default file.
 * @param cwd - directory a relative path is taken from.
 * @param env - environment holding an optional `DSH_HOME`.
 * @returns the format and absolute path to write.
 */
export function exportTarget(args: string, sessionId: string, cwd: string, env: NodeJS.ProcessEnv = process.env): ExportTarget {
  const safeId = sessionId.replaceAll(/[^\w.-]/gu, '_')
  if (args === '' || args.toLowerCase() === 'md' || args.toLowerCase() === 'markdown') {
    return { format: 'markdown', path: join(exportDirectory(env), `dsh-${safeId}.md`) }
  }
  if (args.toLowerCase() === 'zip') return { format: 'zip', path: join(exportDirectory(env), `dsh-${safeId}.zip`) }
  const path = expandHome(args)
  return {
    format: path.toLowerCase().endsWith('.zip') ? 'zip' : 'markdown',
    path: isAbsolute(path) ? path : resolve(cwd, path),
  }
}

/**
 * Where `/export` puts files when no path is given.
 * @param env - environment holding an optional `DSH_HOME`.
 * @returns the absolute directory.
 */
export function exportDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DSH_HOME !== undefined && env.DSH_HOME !== '' ? env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'exports')
}

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path
}
