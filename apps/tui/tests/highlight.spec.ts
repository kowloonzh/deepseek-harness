/** Shell command coloring for `Ran` cards. */

import { describe, expect, it } from 'vitest'
import { highlightCommand } from '../src/highlight.ts'

const COMMAND = '\u001b[34m'
const KEYWORD = '\u001b[35m'
const STRING = '\u001b[32m'
const VARIABLE = '\u001b[36m'
const COMMENT = '\u001b[2m'

/** The text of every run drawn in one style. */
function runs(line: string, style: string): string[] {
  return highlightCommand(line).filter(span => span.style === style).map(span => span.text)
}

describe('command highlighting', () => {
  it('colors each pipeline stage program, operators, and strings', () => {
    const line = 'cd /repo && grep -rl "copy-az" . 2>/dev/null | head -20; echo ---'
    expect(highlightCommand(line).map(span => span.text).join('')).toBe(line)
    expect(runs(line, COMMAND)).toEqual(['cd', 'grep', 'head', 'echo'])
    expect(runs(line, KEYWORD)).toEqual(['&&', '2>', '|', ';'])
    expect(runs(line, STRING)).toEqual(['"copy-az"'])
  })

  it('treats a redirection target, assignments, variables, and comments apart from programs', () => {
    expect(runs('FOO=1 make build > out.log', COMMAND)).toEqual(['make'])
    expect(runs('FOO=1 make build > out.log', VARIABLE)).toEqual(['FOO=1'])
    expect(runs('echo $HOME ${X} $(date) # note', VARIABLE)).toEqual(['$HOME', '${X}', '$('])
    expect(runs('echo $HOME ${X} $(date) # note', COMMAND)).toEqual(['echo', 'date'])
    expect(runs('echo $HOME ${X} $(date) # note', COMMENT)).toEqual(['# note'])
    expect(runs('if test -f x; then cat x; fi', COMMAND)).toEqual(['test', 'cat'])
    expect(runs("git log --format='%h #1'", STRING)).toEqual(["'%h #1'"])
  })
})
