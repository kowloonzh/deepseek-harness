import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { exportDirectory, exportTarget } from '../src/export.ts'

describe('/export target', () => {
  const env = { DSH_HOME: '/data/dsh' }

  it('writes Markdown under $DSH_HOME/exports by default, and the ZIP with `zip`', () => {
    expect(exportTarget('', 'ses/1', '/work', env)).toEqual({ format: 'markdown', path: '/data/dsh/exports/dsh-ses_1.md' })
    expect(exportTarget('md', 'ses1', '/work', env).format).toBe('markdown')
    expect(exportTarget('ZIP', 'ses1', '/work', env)).toEqual({ format: 'zip', path: '/data/dsh/exports/dsh-ses1.zip' })
  })

  it('takes a path relative to the session directory, expands ~, and picks the ZIP by extension', () => {
    expect(exportTarget('notes/run.md', 'ses1', '/work', env)).toEqual({ format: 'markdown', path: '/work/notes/run.md' })
    expect(exportTarget('/tmp/run.zip', 'ses1', '/work', env)).toEqual({ format: 'zip', path: '/tmp/run.zip' })
    expect(exportTarget('~/run.md', 'ses1', '/work', env).path).toBe(join(homedir(), 'run.md'))
  })

  it('falls back to ~/.dsh without DSH_HOME', () => {
    expect(exportDirectory({})).toBe(join(homedir(), '.dsh', 'exports'))
  })
})
