/** Host discovery and URL safety. */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  parseWebHostLine,
  normalizeEntryUrl,
  tuiHostOverlayPath,
  webHostArguments,
} from '../src/host.ts'
import { safeUrl, TuiError } from '../src/error.ts'

describe('web host discovery', () => {
  it('parses the authenticated startup line', () => {
    const url = parseWebHostLine('dsh web: http://127.0.0.1:3081/?token=secret')
    expect(url?.searchParams.get('token')).toBe('secret')
    expect(parseWebHostLine('other output')).toBeUndefined()
  })

  it('requires a tokenized URL', () => {
    expect(() => normalizeEntryUrl('http://127.0.0.1:3080/')).toThrow(TuiError)
    try {
      normalizeEntryUrl('http://127.0.0.1:3080/')
    } catch (error) {
      expect(error).toMatchObject({ code: 'HOST_URL_TOKEN_MISSING' })
    }
  })

  it('never renders the token in a diagnostic URL', () => {
    const url = new URL('http://127.0.0.1:3080/?token=secret&x=1')
    expect(safeUrl(url)).toBe('http://127.0.0.1:3080/')
  })

  it('ships the lean host overlay with both plugin batches', () => {
    const overlay = readFileSync(tuiHostOverlayPath(), 'utf8')
    for (const id of [
      'modules',
      'client-hmr',
      'ui-chat',
      'locale',
      'workspace-changes',
      'job-controller',
      'workspace-controller',
    ]) {
      expect(overlay).toContain(`- id: ${id}\n  disabled: true`)
    }
    // The TUI reads the whole-Session stats on its status row and the Stats tab of `/status`.
    expect(overlay).not.toContain('- id: session-stats')
  })

  it('uses an ephemeral port and the internal overlay for a self-started host', () => {
    const args = webHostArguments({
      entrypoint: '/tmp/dsh-bin.js',
      execArgv: ['--import', 'tsx/esm'],
    })
    expect(args.slice(0, 4)).toEqual(['--import', 'tsx/esm', '/tmp/dsh-bin.js', 'web'])
    expect(args).toContain('--patch')
    expect(args[args.indexOf('--patch') + 1]).toBe(tuiHostOverlayPath())
    expect(args[args.indexOf('--port') + 1]).toBe('0')
  })
})
