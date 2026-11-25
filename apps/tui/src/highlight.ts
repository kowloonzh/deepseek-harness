/**
 * A small syntax highlighter for fenced code in assistant Markdown.
 *
 * codex colors code blocks; a full grammar engine (shiki, highlight.js) would add a dependency
 * and a lockfile change that conflicts with upstream, so this tokenizer covers the languages a
 * coding agent writes most with keywords, strings, comments, and numbers. Unknown languages come
 * back as plain spans, which is what an unlabeled fence shows too.
 */

const ESC = '\u001b['

/** Token styles, as SGR sequences. */
const STYLE = {
  keyword: `${ESC}35m`,
  string: `${ESC}32m`,
  comment: `${ESC}2m`,
  number: `${ESC}33m`,
  literal: `${ESC}36m`,
  added: `${ESC}32m`,
  removed: `${ESC}31m`,
  hunk: `${ESC}36m`,
} as const

/** One run of source text and the SGR style it paints with ('' for plain). */
export interface HighlightSpan {
  readonly text: string
  readonly style: string
}

interface Grammar {
  readonly keywords: ReadonlySet<string>
  readonly literals: ReadonlySet<string>
  readonly lineComments: readonly string[]
  readonly blockComment?: readonly [string, string]
  readonly quotes: string
  /** Whether `$name` and `@name` belong to the identifier (shell variables, decorators). */
  readonly sigils?: boolean
  /**
   * The cautious mode for fences of unknown content (command output, trees, prose): a comment
   * marker counts only at the start of a line or after a space, and a string that does not close
   * on its line stays plain, so `don't` or `issue#12` never recolor the rest of a row.
   */
  readonly cautious?: boolean
}

const words = (text: string): ReadonlySet<string> => new Set(text.split(/\s+/u).filter(word => word !== ''))

const C_LIKE_LITERALS = words('true false null nil undefined NaN Infinity this self super')

const GRAMMARS: Record<string, Grammar> = {
  typescript: {
    keywords: words(`abstract as async await break case catch class const continue debugger declare default delete do else
      enum export extends finally for from function get if implements import in instanceof interface is keyof let namespace
      new of private protected public readonly return satisfies set static switch throw try type typeof var void while with yield`),
    literals: C_LIKE_LITERALS,
    lineComments: ['//'],
    blockComment: ['/*', '*/'],
    quotes: '\'"`',
  },
  go: {
    keywords: words(`break case chan const continue default defer else fallthrough for func go goto if import interface map
      package range return select struct switch type var`),
    literals: words('true false nil iota'),
    lineComments: ['//'],
    blockComment: ['/*', '*/'],
    quotes: '\'"`',
  },
  rust: {
    keywords: words(`as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move
      mut pub ref return static struct trait type unsafe use where while`),
    literals: words('true false self Self super None Some Ok Err'),
    lineComments: ['//'],
    blockComment: ['/*', '*/'],
    quotes: '"',
  },
  python: {
    keywords: words(`and as assert async await break class continue def del elif else except finally for from global if
      import in is lambda nonlocal not or pass raise return try while with yield match case`),
    literals: words('True False None self cls'),
    lineComments: ['#'],
    quotes: '\'"',
    sigils: true,
  },
  c: {
    keywords: words(`auto break case char class const constexpr continue default delete do double else enum extern float for
      goto if inline int long namespace new private protected public register return short signed sizeof static struct switch
      template throw try typedef typename union unsigned using virtual void volatile while bool`),
    literals: words('true false NULL nullptr this'),
    lineComments: ['//'],
    blockComment: ['/*', '*/'],
    quotes: '\'"',
  },
  java: {
    keywords: words(`abstract assert break case catch class const continue default do else enum extends final finally for if
      implements import instanceof interface native new package private protected public return static super switch
      synchronized throw throws try void volatile while var val fun object when is in out override data sealed`),
    literals: words('true false null this'),
    lineComments: ['//'],
    blockComment: ['/*', '*/'],
    quotes: '\'"',
    sigils: true,
  },
  shell: {
    keywords: words(`if then else elif fi for while until do done case esac in function return local export readonly
      declare set unset shift exit break continue source alias`),
    literals: words('true false'),
    lineComments: ['#'],
    quotes: '\'"',
    sigils: true,
  },
  sql: {
    keywords: words(`select from where and or not insert into values update set delete create table alter drop index on join
      left right inner outer full group by order having limit offset as distinct union all case when then else end primary
      key foreign references default exists in is like between begin commit rollback with returning
      SELECT FROM WHERE AND OR NOT INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE ALTER DROP INDEX ON JOIN LEFT RIGHT INNER
      OUTER FULL GROUP BY ORDER HAVING LIMIT OFFSET AS DISTINCT UNION ALL CASE WHEN THEN ELSE END PRIMARY KEY FOREIGN
      REFERENCES DEFAULT EXISTS IN IS LIKE BETWEEN BEGIN COMMIT ROLLBACK WITH RETURNING`),
    literals: words('true false null TRUE FALSE NULL'),
    lineComments: ['--'],
    blockComment: ['/*', '*/'],
    quotes: '\'"',
  },
  json: {
    keywords: words(''),
    literals: words('true false null'),
    lineComments: [],
    quotes: '"',
  },
  yaml: {
    keywords: words(''),
    literals: words('true false null yes no on off ~'),
    lineComments: ['#'],
    quotes: '\'"',
  },
}

/** Unlabeled fences whose language cannot be guessed: common keywords, strings, and numbers. */
const GENERIC: Grammar = {
  keywords: words(`if else elif for while do return function func fn def class struct interface import from export const
    let var type package use pub async await try catch except finally throw raise new switch case break continue`),
  literals: words('true false null nil None True False undefined'),
  lineComments: ['//', '#'],
  blockComment: ['/*', '*/'],
  quotes: '"`',
  cautious: true,
}

/**
 * Guess the language of an unlabeled fence from telltale lines, most specific first.
 * @param code - the fence's body.
 * @returns a language tag the highlighter knows, or undefined.
 */
export function guessLanguage(code: string): string | undefined {
  const text = code.trim()
  if (text === '') return undefined
  const has = (pattern: RegExp): boolean => pattern.test(text)
  if (has(/^(?:diff --git |@@ -\d)/mu) || (has(/^--- \S/mu) && has(/^\+\+\+ \S/mu))) return 'diff'
  if (/^[[{]/u.test(text)) {
    try {
      JSON.parse(text)
      return 'json'
    } catch {
      // Not JSON; a brace-led fence is still worth the other checks.
    }
  }
  if (has(/^#!.*\b(?:ba|z)?sh\b/u)) return 'bash'
  if (has(/^package \w+$/mu) || (has(/^func /mu) && has(/:=/u))) return 'go'
  if (has(/^\s*(?:pub )?fn \w+.*(?:->|\{)/mu) || has(/\blet mut\b|^use \w+::/mu)) return 'rust'
  if (has(/^\s*(?:def|class) \w+.*:\s*$/mu) || has(/^from [\w.]+ import /mu) || has(/^import \w+(?:\.\w+)*$/mu)) return 'python'
  if (has(/^#include\s*[<"]/mu)) return 'c'
  if (has(/^\s*(?:public|private) (?:static |final )*(?:class|void|interface)\b/mu)) return 'java'
  if (has(/^\s*(?:SELECT|INSERT INTO|UPDATE|DELETE FROM|CREATE (?:TABLE|INDEX)|ALTER TABLE|WITH)\b/imu) && has(/\b(?:FROM|INTO|SET|TABLE|WHERE|AS)\b/iu)) return 'sql'
  if (has(/^\s*(?:import .* from |export (?:default |const |function |interface |type )|(?:const|let) \w+ = |interface \w+ \{|function \w*\()/mu) || has(/\) => \{?/u)) return 'typescript'
  const lines = text.split('\n')
  const commands = `cd ls git npm pnpm npx yarn node curl wget kubectl helm docker make go cargo python python3 pip pip3 echo
    export sudo cat grep rg sed awk mkdir rm cp mv chmod ssh tar brew apt apt-get`.split(/\s+/u).filter(word => word !== '')
  const commandLine = new RegExp(`^\\s*(?:\\$ )?(?:${commands.join('|')})(?:\\s|$)`, 'u')
  if (lines.filter(line => commandLine.test(line)).length * 2 >= lines.length) return 'bash'
  const yamlLine = /^\s*(?:- )?[\w.-]+:(?:\s|$)|^\s*- \S|^\s*#/u
  if (lines.length >= 2 && !has(/[;{}]/u) && lines.every(line => line.trim() === '' || yamlLine.test(line))) return 'yaml'
  return undefined
}

const ALIASES: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', typescript: 'typescript', js: 'typescript', jsx: 'typescript',
  javascript: 'typescript', mjs: 'typescript', cjs: 'typescript',
  go: 'go', golang: 'go',
  rs: 'rust', rust: 'rust',
  py: 'python', python: 'python', python3: 'python',
  c: 'c', h: 'c', cpp: 'c', 'c++': 'c', cc: 'c', hpp: 'c', cs: 'c', csharp: 'c',
  java: 'java', kotlin: 'java', kt: 'java', scala: 'java', swift: 'java',
  sh: 'shell', bash: 'shell', zsh: 'shell', shell: 'shell', console: 'shell', fish: 'shell', dockerfile: 'shell',
  makefile: 'shell', make: 'shell',
  sql: 'sql', mysql: 'sql', postgres: 'sql', postgresql: 'sql', sqlite: 'sql',
  json: 'json', jsonc: 'typescript', json5: 'typescript',
  yaml: 'yaml', yml: 'yaml', toml: 'yaml', ini: 'yaml',
}

/**
 * Split code into styled spans, one array per source line.
 * @param code - the fence's body.
 * @param language - the fence's info string; only its first word counts.
 * @returns styled spans per line; plain spans when the language is unknown.
 */
export function highlightCode(code: string, language: string | undefined): HighlightSpan[][] {
  const lines = code.split('\n')
  const labeled = (language ?? '').trim().split(/\s+/u)[0]?.toLowerCase() ?? ''
  // An unlabeled fence gets a guessed language, else the cautious generic style; a labeled
  // one the highlighter does not know stays plain rather than being colored by a wrong guess.
  const tag = labeled === '' ? guessLanguage(code) ?? '' : labeled
  if (tag === 'diff' || tag === 'patch') return lines.map(diffLine)
  const name = ALIASES[tag]
  const grammar = name === undefined ? labeled === '' ? GENERIC : undefined : GRAMMARS[name]
  if (grammar === undefined) return lines.map(line => [{ text: line, style: '' }])
  const state: ScanState = { blockComment: false, quote: undefined }
  return lines.map(line => scanLine(line, grammar, state))
}

function diffLine(line: string): HighlightSpan[] {
  if (line.startsWith('+++') || line.startsWith('---')) return [{ text: line, style: STYLE.comment }]
  if (line.startsWith('+')) return [{ text: line, style: STYLE.added }]
  if (line.startsWith('-')) return [{ text: line, style: STYLE.removed }]
  if (line.startsWith('@@')) return [{ text: line, style: STYLE.hunk }]
  return [{ text: line, style: '' }]
}

interface ScanState {
  /** Inside a block comment that an earlier line opened. */
  blockComment: boolean
  /** The quote of a string an earlier line left open (template literals, Python triple quotes). */
  quote: string | undefined
}

function scanLine(line: string, grammar: Grammar, state: ScanState): HighlightSpan[] {
  const spans: HighlightSpan[] = []
  const push = (text: string, style: string): void => {
    if (text === '') return
    const last = spans.at(-1)
    if (last !== undefined && last.style === style) spans[spans.length - 1] = { text: last.text + text, style }
    else spans.push({ text, style })
  }
  let index = 0
  if (state.blockComment && grammar.blockComment !== undefined) {
    const end = line.indexOf(grammar.blockComment[1])
    if (end < 0) return [{ text: line, style: STYLE.comment }]
    index = end + grammar.blockComment[1].length
    push(line.slice(0, index), STYLE.comment)
    state.blockComment = false
  }
  if (state.quote !== undefined) {
    const end = closingQuote(line, 0, state.quote)
    if (end < 0) return [{ text: line, style: STYLE.string }]
    index = end
    push(line.slice(0, index), STYLE.string)
    state.quote = undefined
  }
  while (index < line.length) {
    const rest = line.slice(index)
    const commentAllowed = grammar.cautious !== true || index === 0 || /\s/u.test(line[index - 1] ?? '')
    const lineComment = commentAllowed ? grammar.lineComments.find(marker => rest.startsWith(marker)) : undefined
    if (lineComment !== undefined) {
      push(rest, STYLE.comment)
      break
    }
    if (commentAllowed && grammar.blockComment !== undefined && rest.startsWith(grammar.blockComment[0])) {
      const close = line.indexOf(grammar.blockComment[1], index + grammar.blockComment[0].length)
      if (close < 0 && grammar.cautious === true) {
        push(line[index] ?? '', '')
        index += 1
        continue
      }
      if (close < 0) {
        push(rest, STYLE.comment)
        state.blockComment = true
        break
      }
      const end = close + grammar.blockComment[1].length
      push(line.slice(index, end), STYLE.comment)
      index = end
      continue
    }
    const char = line[index] ?? ''
    if (grammar.quotes.includes(char)) {
      // Python's triple quotes and template literals may span lines; other strings end here.
      const quote = rest.startsWith(char.repeat(3)) && char !== '`' ? char.repeat(3) : char
      const end = closingQuote(line, index + quote.length, quote)
      if (end < 0 && grammar.cautious === true) {
        push(char, '')
        index += 1
        continue
      }
      if (end < 0) {
        push(rest, STYLE.string)
        if (quote.length === 3 || quote === '`') state.quote = quote
        break
      }
      push(line.slice(index, end), STYLE.string)
      index = end
      continue
    }
    const number = /^(?:0[xX][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)n?/u.exec(rest)
    if (number !== null && !/[\w$#]/u.test(line[index - 1] ?? '')) {
      push(number[0], STYLE.number)
      index += number[0].length
      continue
    }
    const word = (grammar.sigils === true ? /^[$@]?[A-Za-z_]\w*/u : /^[A-Za-z_$][\w$]*/u).exec(rest)
    if (word !== null) {
      const text = word[0]
      const style = grammar.keywords.has(text) ? STYLE.keyword : grammar.literals.has(text) ? STYLE.literal : text.startsWith('$') ? STYLE.literal : ''
      push(text, style)
      index += text.length
      continue
    }
    push(char, '')
    index += 1
  }
  return spans
}

/**
 * Where a string that opened before `from` ends.
 * @returns the index just past the closing quote, or -1 when the line ends first.
 */
function closingQuote(line: string, from: number, quote: string): number {
  for (let index = from; index < line.length; index += 1) {
    if (line[index] === '\\') {
      index += 1
      continue
    }
    if (line.startsWith(quote, index)) return index + quote.length
  }
  return -1
}
