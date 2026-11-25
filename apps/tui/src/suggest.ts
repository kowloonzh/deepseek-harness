/**
 * Wiring for the composer's next-prompt suggestion: the Host command behind it, and the entry in
 * the Web profile patch that loads the Host plugin serving that command.
 *
 * The TUI writes the entry at each launch. The profile reloads its patch live, so a Host that is
 * already running picks up the plugin, and one started later loads it with the profile. Writing is
 * idempotent: the entry lives between two marker lines the TUI owns, is left alone when current,
 * and has its plugin path rewritten in place when the plugin moved. Nothing else is touched,
 * including a `config:` the operator added inside the markers.
 */

import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The Host command that returns a suggestion; the TUI hides it from menus and the transcript. */
export const NEXT_PROMPT_COMMAND = 'tui-next-prompt'

/** Set to `off` to stop the TUI from writing the profile entry and asking for suggestions. */
export const SUGGEST_ENV = 'DSH_TUI_SUGGEST'

const BEGIN = '# >>> dsh tui: next-prompt suggestions (kept current by dsh tui; DSH_TUI_SUGGEST=off stops it)'
const END = '# <<< dsh tui: next-prompt suggestions'
const WRITE_ATTEMPTS = 3

/** What ensuring the entry did. */
export type EnsureOutcome = 'unchanged' | 'added' | 'updated' | 'skipped'

/**
 * The built Host plugin beside this module: `lib/host/next-prompt.js` next to the bundle.
 * @param moduleUrl - `import.meta.url` of the running TUI module.
 * @returns the absolute plugin path, or undefined when this build has none (source runs, tests).
 */
export function bundledPluginPath(moduleUrl: string = import.meta.url): string | undefined {
  if (!moduleUrl.startsWith('file:')) return undefined
  const path = join(dirname(fileURLToPath(moduleUrl)), 'host', 'next-prompt.js')
  return existsSync(path) ? path : undefined
}

/**
 * The Web profile's own patch layer.
 * @param env - environment holding an optional `DSH_HOME`.
 * @returns the absolute patch path.
 */
export function webProfilePatchPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DSH_HOME !== undefined && env.DSH_HOME !== '' ? env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'profiles', 'web', 'cordis.patch.yml')
}

/**
 * The marked block that loads the plugin.
 * @param pluginPath - absolute path of the built plugin.
 * @returns the block, ending with a newline.
 */
export function entryBlock(pluginPath: string): string {
  return [
    BEGIN,
    '- insert:',
    `    - id: ${NEXT_PROMPT_COMMAND}`,
    // A JSON string is a valid YAML double-quoted scalar, whatever the path holds.
    `      name: ${JSON.stringify(pluginPath)}`,
    END,
    '',
  ].join('\n')
}

/**
 * The patch text with the block current.
 * @param text - the patch as it stands ('' when the file does not exist).
 * @param pluginPath - absolute path of the built plugin.
 * @returns the new text and what changed; text is undefined when nothing should be written.
 */
export function withEntry(text: string, pluginPath: string): { readonly text?: string; readonly outcome: EnsureOutcome } {
  const block = entryBlock(pluginPath)
  const lines = text.split('\n')
  const begin = lines.indexOf(BEGIN)
  const end = lines.indexOf(END)
  if (begin < 0 && end < 0) {
    // An entry the operator wrote by hand wins over ours.
    if (new RegExp(`^\\s*-?\\s*id:\\s*["']?${NEXT_PROMPT_COMMAND}["']?\\s*$`, 'mu').test(text)) return { outcome: 'skipped' }
    const separator = text === '' || text.endsWith('\n') ? '' : '\n'
    return { text: `${text}${separator}${block}`, outcome: 'added' }
  }
  // A half-removed block was edited by hand: leave the file to the operator.
  if (begin < 0 || end < begin) return { outcome: 'skipped' }
  // Inside the block only the plugin path is ours: a `config:` the operator added stays.
  const body = lines.slice(begin + 1, end)
  const at = body.findIndex(line => /^\s+name:/u.test(line))
  if (at < 0 || !body.some(line => line.trim() === `- id: ${NEXT_PROMPT_COMMAND}`)) return { outcome: 'skipped' }
  const nameLine = `${/^\s*/u.exec(body[at] ?? '')?.[0] ?? ''}name: ${JSON.stringify(pluginPath)}`
  if (body[at] === nameLine) return { outcome: 'unchanged' }
  const next = [...lines.slice(0, begin + 1 + at), nameLine, ...lines.slice(begin + 2 + at)].join('\n')
  return { text: next, outcome: 'updated' }
}

/**
 * Make the Web profile load the plugin, writing its patch only when the entry is missing or stale.
 * The write goes through a temporary file and a rename, so a Host reloading the patch never reads
 * half of it; when another TUI changed the file meanwhile, the read and merge start over.
 * @param pluginPath - absolute path of the built plugin.
 * @param patchPath - the profile patch to keep current; defaults to the Web profile's under `env`.
 * @param env - environment holding an optional `DSH_HOME`.
 * @returns what was done; 'skipped' when there is no Web profile or the block was hand-edited.
 */
export function ensureNextPromptEntry(
  pluginPath: string,
  patchPath?: string,
  env: NodeJS.ProcessEnv = process.env,
): EnsureOutcome {
  patchPath ??= webProfilePatchPath(env)
  // Only a profile that exists is extended; the TUI never creates one.
  if (!existsSync(join(dirname(patchPath), 'package.json'))) return 'skipped'
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const before = readText(patchPath)
    const { text, outcome } = withEntry(before ?? '', pluginPath)
    if (text === undefined) return outcome
    const temporary = `${patchPath}.${String(process.pid)}.tui-tmp`
    const mode = before === undefined ? 0o644 : statSync(patchPath).mode & 0o777
    writeFileSync(temporary, text, { mode })
    if (readText(patchPath) !== before) {
      unlinkSync(temporary)
      continue
    }
    renameSync(temporary, patchPath)
    return outcome
  }
  return 'skipped'
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
