/** Width-aware deterministic terminal rendering. */

import { describe, expect, it } from 'vitest'
import {
  bottomPaneLimit,
  cacheHitPercent,
  LATEST,
  renderMarkdownLines,
  renderView,
  selectedText,
  TerminalRenderer,
  type RenderViewOptions,
  type TranscriptPosition,
  wrapText,
} from '../src/render.ts'
import { guessLanguage } from '../src/highlight.ts'
import { EmulatedTerminal } from './terminal.ts'
import { initialTranscript } from '../src/transcript.ts'
import type { SlashSuggestion } from '../src/ui.ts'

/**
 * The position `rows` back from the latest rows of a frame rendered with `options`.
 * @param options - the frame to scroll.
 * @param rows - how far back.
 * @returns a reading position.
 */
function scrolledBack(options: Omit<RenderViewOptions, 'scroll'>, rows: number): TranscriptPosition {
  return new TerminalRenderer().render({ ...options, scroll: LATEST }).scrollBy(-rows)
}

const suggest = (count: number): SlashSuggestion[] =>
  Array.from({ length: count }, (_, i) => ({ name: `cmd${i}`, description: 'd', source: 'command' }))

describe('terminal rendering', () => {
  it('colors fenced code by its language and leaves unknown labels plain', () => {
    const lines = renderMarkdownLines('```ts\nconst a = "x" // note\n```\n\n```brainfuck\nconst b\n```', 60)
    const code = lines.find(line => stripAnsi(line).includes('const a')) ?? ''
    expect(stripAnsi(code)).toBe('  const a = "x" // note')
    expect(code).toContain('\u001b[35mconst')
    expect(code).toContain('\u001b[32m"x"')
    expect(code).toContain('\u001b[2m// note')
    const plain = lines.find(line => stripAnsi(line).includes('const b')) ?? ''
    expect(plain).toBe('  const b')
  })

  it('guesses an unlabeled fence, else colors it cautiously', () => {
    expect(guessLanguage('package main\n\nfunc main() {}')).toBe('go')
    expect(guessLanguage('def f(x):\n    return x')).toBe('python')
    expect(guessLanguage('{"a": [1, true]}')).toBe('json')
    expect(guessLanguage('git status\nnpm test')).toBe('bash')
    expect(guessLanguage('import { a } from "b"\nconst c = a()')).toBe('typescript')
    expect(guessLanguage('SELECT id FROM users WHERE id = 1')).toBe('sql')
    expect(guessLanguage('name: dsh\nitems:\n  - one')).toBe('yaml')
    expect(guessLanguage('just some words')).toBeUndefined()
    const go = renderMarkdownLines('```\npackage main\n```', 40).join('\n')
    expect(go).toContain('\u001b[35mpackage')
    // Output and prose: an apostrophe, a mid-word `#`, or an open `/*` recolor nothing after it.
    const prose = renderMarkdownLines("```\ndon't stop at issue#12 in /usr/* please\n```", 60)
    const row = prose.find(line => stripAnsi(line).includes('please')) ?? ''
    expect(row).toBe("  don't stop at issue#12 in /usr/* please")
  })

  it('separates a finished turn that used tools with a Worked for row, and keeps tools off the status row', () => {
    const state = initialTranscript()
    state.running = true
    state.items = [
      { id: 'u', kind: 'user', text: 'go' },
      { id: 't', kind: 'tool', title: 'bash', text: '', toolArguments: '{"command":"sleep 9"}', toolStatus: 'running' },
      { id: 'turn', kind: 'turn', text: '', startedAt: 0 },
    ]
    const options = { rows: 20, columns: 50, input: '', cursor: 0, overlay: undefined, expandedTools: false, scroll: LATEST, notice: undefined } as const
    const running = stripAnsi(renderView({ ...options, state }).text)
    expect(running).not.toContain('Worked for')
    expect(running).not.toContain('bash running')
    state.running = false
    state.items = [
      ...state.items.slice(0, 2).map(item => ({ ...item, toolStatus: 'ok' as const, toolOutput: '' })),
      { id: 'turn', kind: 'turn', text: '', startedAt: 0, elapsedMs: 65_400 },
      { id: 'a', kind: 'assistant', text: 'done' },
    ]
    const rows = stripAnsi(renderView({ ...options, state }).text).split('\n')
    const separator = rows.findIndex(row => row.startsWith('─ Worked for 1m 05s ─'))
    expect(separator).toBeGreaterThan(rows.findIndex(row => row.startsWith('• Ran sleep 9')))
    expect(rows[separator]).toMatch(/^─ Worked for 1m 05s ─{20,}$/u)
    expect(rows.findIndex(row => row.startsWith('• done'))).toBeGreaterThan(separator)
  })

  it('wraps CJK text by terminal cells', () => {
    expect(wrapText('中文abc', 5)).toEqual(['中文a', 'bc'])
  })

  it('distinguishes roles with codex gutters and no role labels', () => {
    const state = initialTranscript()
    state.items = [
      { id: 'u', kind: 'user', text: 'hello' },
      { id: 'a', kind: 'assistant', text: 'reply' },
    ]
    const raw = renderView({
      rows: 20, columns: 80, state, input: '', cursor: 0,
      overlay: undefined, expandedTools: false, scroll: LATEST, notice: undefined,
    }).text
    const rendered = stripAnsi(raw)
    expect(rendered).toContain('hello')
    expect(rendered).toContain('reply')
    expect(raw).toContain('\u001b[97m\u001b[48;5;238m\u001b[36m›\u001b[97m\u001b[48;5;238m hello')
    expect(rendered).not.toContain('❯ hello')
    expect(rendered).not.toContain('● reply')
    expect(rendered).not.toContain('You hello')
    expect(rendered).not.toContain('DSH reply')
    // codex's gutters start at the edge: `›` for the prompt, a dim `•` for each other cell.
    expect(rendered.split('\n').find(line => line.includes('hello'))).toMatch(/^› hello/u)
    expect(rendered.split('\n').find(line => line.includes('reply'))).toMatch(/^• reply/u)
  })

  it('renders the composer, status, and approval choices', () => {
    const state = initialTranscript()
    state.items.push({ id: 'u', kind: 'user', text: 'hello' })
    const frame = renderView({
      rows: 20,
      columns: 80,
      state,
      input: 'next',
      cursor: 4,
      overlay: {
        kind: 'approval',
        request: { toolName: 'bash', reason: 'write outside workspace' },
        resolve: () => {},
      },
      expandedTools: false,
      scroll: LATEST,
      notice: undefined,
    })
    expect(frame.text).toContain('Approval required')
    expect(frame.text).toContain('allow once')
    expect(frame.text).toContain('next')
    expect(frame.cursorRow).toBeGreaterThan(0)
    expect(frame.cursorColumn).toBe(9)
  })

  it('draws a distinct growing composer with the status line underneath', () => {
    const state = initialTranscript()
    const frame = renderView({
      rows: 24,
      columns: 80,
      state,
      input: 'next line\nwith more context',
      cursor: 26,
      images: [{
        kind: 'image',
        mediaType: 'image/png',
        data: 'AAAA',
        bytes: 3,
        name: 'shot.png',
      }],
      overlay: undefined,
      expandedTools: false,
      scroll: LATEST,
      notice: undefined,
    })
    const lines = stripAnsi(frame.text).split('\n')
    const top = lines.findIndex(line => line.startsWith('╭─'))
    const bottom = lines.findIndex(line => line.startsWith('╰─'))
    expect(top).toBeGreaterThan(0)
    expect(bottom - top).toBeGreaterThanOrEqual(4)
    // Idle is no longer a permanent marker; the status row still owns the last line.
    expect(lines.at(-1)).toContain('~')
    expect(lines.at(-1)).toContain(' · ')
    expect(lines[top + 1]).toContain('[Image #1] shot.png')
    expect(lines[top + 2]).toContain('next line')
    expect(frame.cursorRow).toBe(top + 4)
    expect(frame.text).not.toContain('Message')
    expect(frame.text).not.toContain('kill/yank')
  })

  it('starts with one inner composer row and grows for multiline input', () => {
    const state = initialTranscript()
    const render = (input: string, cursor: number) => {
      const frame = renderView({
        rows: 24, columns: 80, state, input, cursor,
        overlay: undefined, expandedTools: false, scroll: LATEST, notice: undefined,
      })
      const lines = stripAnsi(frame.text).split('\n')
      const top = lines.findIndex(line => line.startsWith('╭'))
      const bottom = lines.findIndex(line => line.startsWith('╰'))
      return { lines, top, bottom, height: bottom - top }
    }
    const oneLine = render('', 0)
    const twoLines = render('first\nsecond', 12)
    expect(oneLine.height).toBe(2)
    expect(oneLine.lines[oneLine.top - 1]).toBe('')
    // The status row sits directly under the composer, as codex's footer does.
    expect(oneLine.lines[oneLine.bottom + 1]).toBe(oneLine.lines.at(-1))
    expect(oneLine.bottom + 2).toBe(oneLine.lines.length)
    expect(twoLines.height).toBe(3)
  })

  it('renders queue and submission rows above the composer with model context and permission', () => {
    const state = initialTranscript()
    state.model = { provider: 'p', model: 'model-x', reasoningEffort: 'high' }
    state.context = { pressureTokens: 400, projectedTokens: 500, contextWindow: 1000 }
    state.permission = 'workspace-write'
    // Cache share is the reading this row keeps; 2 of 10 billed prompt tokens were cached.
    state.tokens = { input: 6, output: 3, cacheRead: 2, cacheWrite: 2 }
    state.queue = [
      { id: 'q1', placement: 'queued', text: 'later', imageCount: 0, fileCount: 0, editable: true },
      { id: 'q2', placement: 'steering', text: 'adjust course', imageCount: 0, fileCount: 0, editable: true },
    ]
    const frame = renderView({
      rows: 24, columns: 120, state, input: '', cursor: 0,
      submission: { mode: 'steer', text: 'current', imageCount: 1 },
      overlay: undefined, expandedTools: false, scroll: LATEST, notice: undefined,
    })
    expect(frame.text).toContain('sending steer: current [1 image]')
    expect(frame.text).toContain('queued: later')
    expect(frame.text).toContain('steer: adjust course')
    const status = stripAnsi(frame.text).split('\n').at(-1) ?? ''
    expect(status).toContain('model-x high · ')
    expect(status).toContain('ctx 50%')
    // The permission mode moved to `/status`; cache share took its place on the row.
    expect(status).not.toContain('workspace-write')
    expect(status).toContain('cache 20%')
    // The dock explains the queued rows only. A draft-level shortcut listed here would read
    // as an action on a queued row, which Alt+Enter cannot perform.
    expect(frame.text).toContain('Alt+Up recall')
    expect(frame.text).not.toContain('Alt+Enter')
  })

  it('groups consecutive tool calls and expands individual details with Ctrl+O', () => {
    const state = initialTranscript()
    state.items = [
      ...Array.from({ length: 20 }, (_, index) => ({
        id: `system-${String(index)}`, kind: 'system' as const, text: `history ${String(index)}`,
      })),
      {
        id: 'tool-0', kind: 'tool', title: 'edit',
        text: 'path: notes.md', detail: 'updated', toolStatus: 'ok',
        toolArguments: '{"path":"notes.md","old_string":"one","new_string":"one\\ntwo"}',
        toolOutput: 'updated',
      },
      {
        id: 'tool-1', kind: 'tool', title: 'bash',
        text: 'command: false',
        detail: 'permission denied\nexit 1',
        toolStatus: 'error',
        toolArguments: '{"command":"false"}',
        toolOutput: 'permission denied\nexit 1',
      },
      {
        id: 'tool-2', kind: 'tool', title: 'read',
        text: 'path: notes.md', detail: 'notes', toolStatus: 'ok',
        toolArguments: '{"path":"notes.md"}', toolOutput: 'notes',
      },
      {
        id: 'tool-3', kind: 'tool', title: 'web_search',
        text: 'query: news', toolStatus: 'running',
        toolArguments: '{"query":"news"}',
      },
      {
        id: 'tool-4', kind: 'tool', title: 'web_fetch',
        text: 'url: https://a.test/one', detail: 'one', toolStatus: 'ok',
        toolArguments: '{"url":"https://a.test/one"}', toolOutput: 'one',
      },
      {
        id: 'tool-5', kind: 'tool', title: 'web_fetch',
        text: 'url: https://b.test/two', detail: 'two', toolStatus: 'error',
        toolArguments: '{"url":"https://b.test/two"}', toolOutput: 'two',
      },
    ]
    const frame = (expandedTools: boolean, back = 0) => {
      const options = {
        rows: 50, columns: 80, state, input: '', cursor: 0,
        overlay: undefined, expandedTools, notice: undefined,
      }
      return stripAnsi(renderView({ ...options, scroll: back === 0 ? LATEST : scrolledBack(options, back) }).text)
    }
    // Collapsed: one codex card per call (reads fold into Explored), a diff or output preview
    // hung under `└`, and never the raw arguments.
    const folded = frame(false)
    expect(folded).toContain('• Edited notes.md (+2 -1)')
    expect(folded).toMatch(/└ -one\n\s+\+one\n\s+\+two/u)
    expect(folded).toMatch(/• Ran false\n\s+└ permission denied\n\s+exit 1/u)
    expect(folded).toMatch(/• Explored\n\s+└ Read notes\.md/u)
    expect(folded).toContain('• Searching news')
    expect(folded).toContain('• Opened https://a.test/one')
    expect(folded).toMatch(/• Opened https:\/\/b\.test\/two\n\s+└ two/u)
    expect(folded).not.toContain('arguments')
    expect(folded).not.toContain('{"')

    // Expanded: the same cards with every call's output, still without raw arguments.
    const expanded = frame(true)
    expect(expanded).toMatch(/└ Read notes\.md\n\s+notes/u)
    expect(expanded).toMatch(/• Opened https:\/\/a\.test\/one\n\s+└ one/u)
    expect(expanded).not.toContain('{"')

    const scrolled = frame(false, 3)
    expect(scrolled).toContain('Searching news')
    expect(scrolled).toContain('↓ bottom · Esc')
  })

  it('keeps reasoning out of the conversation and shows its latest line in the status row', () => {
    const state = initialTranscript()
    state.running = true
    state.items = [
      { id: 'u', kind: 'user', text: 'fix it' },
      { id: 'r', kind: 'reasoning', text: '**Reading the renderer**\n\nLooking at wrapText next.\n' },
    ]
    const options = {
      rows: 24, columns: 80, state, input: '', cursor: 0,
      overlay: undefined, scroll: LATEST, notice: undefined, runningSince: 1_000, now: 76_000,
    }
    const collapsed = stripAnsi(renderView({ ...options, expandedTools: false }).text)
    expect(collapsed).not.toContain('Reading the renderer')
    expect(collapsed).toMatch(/• Looking at wrapText next\. \(1m 15s • esc to interrupt\)\n╭/u)
    const expanded = stripAnsi(renderView({ ...options, expandedTools: true }).text)
    expect(expanded).toMatch(/• Reading the renderer\n\s*\n?\s*Looking at wrapText next\./u)

    // A new prompt starts a turn that has not reasoned yet.
    state.items = [...state.items, { id: 'u2', kind: 'user', text: 'again' }]
    expect(stripAnsi(renderView({ ...options, expandedTools: false }).text)).toContain('• Working (1m 15s • esc to interrupt)')
    state.running = false
    expect(stripAnsi(renderView({ ...options, expandedTools: false }).text)).not.toContain('esc to interrupt')
  })

  it('previews long command output by its head and tail', () => {
    const state = initialTranscript()
    state.items = [{
      id: 't', kind: 'tool', title: 'bash', text: '', toolStatus: 'ok',
      toolArguments: JSON.stringify({ command: 'seq 20' }),
      toolOutput: Array.from({ length: 20 }, (_, i) => `n${String(i + 1)}`).join('\n'),
    }]
    const render = (expandedTools: boolean) => stripAnsi(renderView({
      rows: 40, columns: 80, state, input: '', cursor: 0,
      overlay: undefined, expandedTools, scroll: LATEST, notice: undefined,
    }).text)
    expect(render(false)).toMatch(/• Ran seq 20\n  └ n1\n    n2\n    … \+16 lines \(Ctrl\+O\)\n    n19\n    n20/u)
    expect(render(true)).toContain('    n10')
    expect(render(true)).not.toContain('… +')
  })

  it('summarizes patches and plans from their arguments', () => {
    const state = initialTranscript()
    const patch = ['*** Begin Patch', '*** Update File: a.ts', '@@', '-old', '+new', '+more', '*** End Patch'].join('\n')
    state.items = [
      { id: 'p', kind: 'tool', title: 'apply_patch', text: '', toolStatus: 'ok', toolArguments: JSON.stringify({ input: patch }), toolOutput: 'ok' },
      {
        id: 'todo', kind: 'tool', title: 'todo_write', text: '', toolStatus: 'ok', toolOutput: 'ok',
        toolArguments: JSON.stringify({ todos: [{ content: 'read', status: 'completed' }, { content: 'fix', status: 'pending' }] }),
      },
    ]
    const rendered = stripAnsi(renderView({
      rows: 30, columns: 80, state, input: '', cursor: 0,
      overlay: undefined, expandedTools: false, scroll: LATEST, notice: undefined,
    }).text)
    expect(rendered).toMatch(/• Edited a\.ts \(\+2 -1\)\n  └ -old\n    \+new\n    \+more/u)
    expect(rendered).toMatch(/• Updated Plan\n  └ ✔ read\n    □ fix/u)
  })

  it('renders slash command and skill completion above the composer', () => {
    const state = initialTranscript()
    const frame = stripAnsi(renderView({
      rows: 24, columns: 100, state, input: '/i', cursor: 2,
      slashSuggestions: [
        { name: 'icai', description: 'Research workflow', source: 'skill' },
        { name: 'install', description: 'Install something', source: 'command' },
      ],
      slashSuggestionIndex: 0,
      slashLoading: false,
      overlay: undefined, expandedTools: false, scroll: LATEST, notice: undefined,
    }).text)
    expect(frame).toContain('❯ /icai Research workflow [skill]')
    expect(frame).toContain('/install Install something')
  })

  it('repaints only changed cells for incremental scroll frames', async () => {
    const state = initialTranscript()
    state.items = Array.from({ length: 30 }, (_, index) => ({
      id: `system-${String(index)}`,
      kind: 'system' as const,
      text: `history ${String(index)}`,
    }))
    const renderer = new TerminalRenderer()
    const options = {
      rows: 20,
      columns: 80,
      state,
      input: '',
      cursor: 0,
      overlay: undefined,
      expandedTools: false,
      notice: undefined,
    }
    const first = renderer.render({ ...options, scroll: LATEST })
    const back = first.scrollBy(-3)
    const second = renderer.render({ ...options, scroll: back }, true)
    expect(first.paint).toContain('\u001b[2J')
    expect(second.paint).not.toContain('\u001b[2J')
    expect(second.paint.length).toBeLessThan(first.paint.length)
    // The diff leaves the terminal exactly where a full repaint of the second frame would.
    const incremental = new EmulatedTerminal(80, 20)
    await incremental.write(first.paint + second.paint)
    const full = new EmulatedTerminal(80, 20)
    await full.write(new TerminalRenderer().render({ ...options, scroll: back }).paint)
    expect(incremental.text()).toBe(full.text())
    expect(incremental.text()).toContain('history 26')
  })

  it('highlights and extracts a mouse-selected transcript range', () => {
    const state = initialTranscript()
    state.items = [
      { id: 'u', kind: 'user', text: 'hello world' },
      { id: 'a', kind: 'assistant', text: 'reply text' },
    ]
    const base = {
      rows: 20,
      columns: 40,
      state,
      input: '',
      cursor: 0,
      overlay: undefined,
      expandedTools: false,
      scroll: LATEST,
      notice: undefined,
    }
    const unselected = renderView(base)
    const index = unselected.selectionRegion?.rows.findIndex(row => row.includes('hello world')) ?? -1
    expect(index).toBeGreaterThanOrEqual(0)
    const row = (unselected.selectionRegion?.top ?? 1) + index
    const textRow = unselected.selectionRegion?.rows[index] ?? ''
    const startColumn = Array.from(textRow.slice(0, textRow.indexOf('hello world'))).length + 1
    const selection = {
      anchor: { column: startColumn, row },
      head: { column: startColumn + 'hello world'.length - 1, row },
    }
    const selected = renderView({ ...base, selection })
    expect(selected.text).toContain('\u001b[7mhello world\u001b[27m')
    expect(selectedText(selected.selectionRegion, selection)).toBe('hello world')
    expect(selectedText(selected.selectionRegion, {
      anchor: { column: 1, row },
      head: { column: 40, row },
    })).not.toContain('›')
  })

  it('renders assistant Markdown without source syntax markers', () => {
    const markdown = [
      '## MR 链接',
      '',
      '这是 **粗体** 和 `code`。',
      '',
      '- 第一项',
      '- 第二项',
      '',
      '| 项 | 值 |',
      '|---|---|',
      '| 状态 | open |',
      '',
      '```go',
      'fmt.Println("ok")',
      '```',
    ].join('\n')
    const raw = renderMarkdownLines(markdown, 60)
    const rendered = stripAnsi(raw.join('\n'))
    expect(rendered).toContain('MR 链接')
    expect(rendered).toContain('粗体')
    expect(rendered).toContain('code')
    expect(rendered).toContain('• 第一项')
    expect(rendered).toContain('项   │')
    expect(rendered).toContain('状态 │ open')
    // codex prints the code alone, indented, without the fence's language tag.
    expect(rendered).toMatch(/^  fmt\.Println\("ok"\)$/mu)
    expect(rendered).not.toMatch(/^go$/mu)
    expect(rendered).not.toContain('##')
    expect(rendered).not.toContain('**')
    expect(rendered).not.toContain('`code`')
    expect(rendered).not.toContain('```')
    expect(raw.join('\n')).toContain('\u001b[1m粗体')
  })

  it('wraps Markdown links in terminal hyperlink escape sequences', () => {
    const url = 'https://jira.qianxin-inc.cn/browse/YG-4021'
    const raw = renderMarkdownLines(`[YG-4021](${url})`, 80).join('\n')

    expect(raw).toContain(`\u001b]8;;${url}\u001b\\\u001b[4;34mYG-4021\u001b]8;;\u001b\\`)
    expect(stripAnsi(raw)).toBe('YG-4021')
  })

  it('does not emit terminal hyperlinks for unsupported Markdown URL schemes', () => {
    const raw = renderMarkdownLines('[unsafe](javascript:alert(1))', 80).join('\n')

    expect(raw).not.toContain('\u001b]8;;')
    expect(stripAnsi(raw)).toBe('unsafe')
  })

  it('keeps terminal hyperlinks inside table cells', () => {
    const url = 'https://jira.qianxin-inc.cn/browse/YG-4021'
    const markdown = ['| 问题 | 状态 |', '| --- | --- |', `| [YG-4021](${url}) | open |`].join('\n')
    const raw = renderMarkdownLines(markdown, 80).join('\n')

    expect(raw).toContain(`\u001b]8;;${url}\u001b\\`)
    expect(stripAnsi(raw)).toContain('YG-4021')
    // The status column stays unlinked, so the target must be closed before it.
    const cellLine = stripAnsi(raw).split('\n').find(line => line.includes('YG-4021')) ?? ''
    expect(cellLine).toContain('open')
  })

  it('closes an open hyperlink when a narrow table cell has to truncate it', () => {
    const url = 'https://jira.qianxin-inc.cn/browse/YG-4021'
    const markdown = ['| 编号 |', '| --- |', `| [YG-4021 很长的一个标题](${url}) |`].join('\n')
    // One column with a 12-cell budget forces the cell to truncate.
    const raw = renderMarkdownLines(markdown, 12).join('\n')

    // A truncated linked cell still opens and closes its target around the visible text.
    expect(raw).toContain('\u001b]8;;')
    expect(raw).toContain('…')
    const opened = raw.split('\u001b]8;;').length - 1
    expect(opened % 2).toBe(0)
  })

  it('shows reasoning depths for the picked route and marks the host default', () => {
    const state = initialTranscript()
    const choice = {
      provider: 'deepseek',
      providerName: 'DeepSeek',
      model: 'deepseek-v4',
      modelName: 'DeepSeek V4',
      efforts: [
        { id: 'off', name: 'Off' },
        { id: 'high', name: 'High', description: 'Deep reasoning for hard tasks' },
        { id: 'max', name: 'Max' },
      ],
      defaultEffort: 'high',
    }
    const rendered = stripAnsi(renderView({
      rows: 24, columns: 100, state, input: '', cursor: 0,
      overlay: { kind: 'models', items: [choice], index: 0, stage: 'effort', chosen: choice, effortIndex: 1 },
      expandedTools: false, scroll: LATEST, notice: undefined,
    }).text)
    expect(rendered).toContain('Reasoning depth')
    expect(rendered).toContain('DeepSeek / DeepSeek V4')
    expect(rendered).toContain('High')
    expect(rendered).toContain('(default)')
    // Only the highlighted row explains itself.
    expect(rendered).toContain('Deep reasoning for hard tasks')
  })

  it('marks routes that offer depths on the model stage', () => {
    const state = initialTranscript()
    const rendered = stripAnsi(renderView({
      rows: 24, columns: 100, state, input: '', cursor: 0,
      overlay: {
        kind: 'models',
        index: 0,
        stage: 'model',
        effortIndex: 0,
        items: [
          { provider: 'deepseek', providerName: 'DeepSeek', model: 'v4', modelName: 'V4', efforts: [{ id: 'off', name: 'Off' }] },
          { provider: 'plain', providerName: 'Plain', model: 'chat', modelName: 'Chat', efforts: [] },
        ],
      },
      expandedTools: false, scroll: LATEST, notice: undefined,
    }).text)
    expect(rendered).toContain('1 depths')
    expect(rendered).toContain('Plain / Chat')
  })

  it('strips OSC hyperlink parameters from untrusted header text', () => {
    // A model-authored title carrying an OSC 8 link must not leave `]8;;...` visible:
    // those bytes are measured as cells and paint rows over the composer.
    const state = initialTranscript()
    state.title = 'ok\u001b]8;;https://evil.test\u001b\\CLICK\u001b]8;;\u001b\\'
    state.items = [{ id: 'a', kind: 'assistant', text: 'hi' }]
    const rendered = renderView({
      rows: 20, columns: 60, state, input: '', cursor: 0,
      overlay: undefined, expandedTools: false, scroll: LATEST, notice: undefined,
    }).text
    expect(rendered).not.toContain('\u001b]8;;https')
    expect(stripAnsi(rendered)).not.toContain('8;;')
    expect(stripAnsi(rendered)).toContain('CLICK')
    // The header row still fits the terminal exactly.
    const header = stripAnsi(rendered).split('\n')[0] ?? ''
    expect(header.length).toBeLessThanOrEqual(60)
  })

  it('keeps transcript hyperlinks intact while dropping their visible parameters', () => {
    const state = initialTranscript()
    state.items = [{ id: 'a', kind: 'assistant', text: 'see [YG-4021](https://jira.test/browse/YG-4021)' }]
    const raw = renderView({
      rows: 20, columns: 60, state, input: '', cursor: 0,
      overlay: undefined, expandedTools: false, scroll: LATEST, notice: undefined,
    }).text
    const visible = stripAnsi(raw)
    expect(visible).toContain('YG-4021')
    expect(visible).not.toContain('8;;')
    expect(visible).not.toContain('jira.test')
    // The transcript still emits the clickable target.
    expect(raw).toContain('\u001b]8;;https://jira.test/browse/YG-4021\u001b\\')
  })

  it('never paints more rows than the terminal holds', () => {
    // An overshooting frame scrolls the terminal, which desynchronizes the row index an
    // incremental repaint addresses and paints transcript rows over the composer. Each
    // section used to budget itself against `height` alone, so a slash menu plus a queue
    // dock plus a multi-line composer together exceeded it.
    const offenders: string[] = []
    for (const rows of [10, 12, 16, 24, 40]) {
      for (const columns of [40, 80]) {
        for (const inputRows of [0, 1, 3, 6, 10]) {
          for (const dock of [0, 1, 3, 6]) {
            for (const slash of [0, 1, 6]) {
              const state = initialTranscript()
              state.items = Array.from({ length: 30 }, (_, i) => ({ id: `a${i}`, kind: 'assistant' as const, text: `line ${i}` }))
              state.queue = Array.from({ length: dock }, (_, i) => ({
                id: `q${i}`, placement: 'queued' as const, text: `queued ${i}`, imageCount: 0, fileCount: 0, editable: true,
              }))
              const input = Array.from({ length: inputRows }, (_, i) => `in${i}`).join('\n')
              const renderer = new TerminalRenderer()
              const frame = renderer.render({
                rows, columns, state, input, cursor: input.length,
                overlay: undefined, expandedTools: false, scroll: LATEST, notice: undefined,
                slashSuggestions: suggest(slash), slashSuggestionIndex: 0,
              })
              // A full frame clears and rewrites every row, so its row count is the frame height.
              const painted = frame.text.split('\n').length
              if (painted !== rows) {
                offenders.push(`rows=${String(rows)} input=${String(inputRows)} dock=${String(dock)} slash=${String(slash)} -> ${String(painted)}`)
              }
              if (frame.cursorRow > rows) {
                offenders.push(`cursor rows=${String(rows)} input=${String(inputRows)} dock=${String(dock)} slash=${String(slash)} -> ${String(frame.cursorRow)}`)
              }
            }
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('keeps the composer visible when the slash menu cannot fit', () => {
    // The menu gives up rows before the composer does.
    const state = initialTranscript()
    state.items = [{ id: 'a', kind: 'assistant', text: 'hello' }]
    const frame = new TerminalRenderer().render({
      rows: 10, columns: 60, state, input: 'typing', cursor: 6,
      overlay: undefined, expandedTools: false, scroll: LATEST, notice: undefined,
      slashSuggestions: suggest(6),
      slashSuggestionIndex: 0,
    })
    const rows = stripAnsi(frame.text).split('\n')
    const composerRow = rows.findIndex(line => line.includes('typing'))
    expect(composerRow).toBeGreaterThanOrEqual(0)
    expect(rows.length).toBe(10)
  })

  it('blanks control characters that would move the cursor', () => {
    // A carriage return returns to column 1 and overwrites the row; a raw newline adds a
    // row the frame never budgeted, which shifts the composer.
    const hostile = ['back\bspace', 'bell\u0007x', 'carriage\rreturn', 'new\nline', 'tab\there']
    const offenders: string[] = []
    for (const text of hostile) {
      for (const where of ['assistant', 'title', 'notice', 'tool'] as const) {
        const state = initialTranscript()
        if (where === 'assistant') state.items = [{ id: 'a', kind: 'assistant', text }]
        if (where === 'tool') {
          state.items = [{ id: 't', kind: 'tool', text, toolName: 'bash', toolOutput: text, toolStatus: 'ok' } as never]
        }
        if (where === 'title') state.title = text
        const frame = new TerminalRenderer().render({
          rows: 20, columns: 80, state, input: '', cursor: 0,
          overlay: undefined, expandedTools: true, scroll: LATEST,
          notice: where === 'notice' ? text : undefined,
        })
        // Strip the renderer's own escapes, then look for any remaining control character.
        const visible = stripAnsi(frame.text)
        if (visible.split('\n').length !== 20) {
          offenders.push(`${where}: ${JSON.stringify(text)} -> ${String(visible.split('\n').length)} rows`)
        }
        for (const line of visible.split('\n')) {
          if (/[\u0000-\u001f\u007f]/u.test(line)) offenders.push(`${where}: ${JSON.stringify(text)} leaked a control character`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('reports cache share over every billed prompt bucket', () => {
    // Denominator matches the Web composer: uncached input plus cache read plus cache write.
    expect(cacheHitPercent({ input: 6, output: 1, cacheRead: 2, cacheWrite: 2 })).toBe(20)
    expect(cacheHitPercent({ input: 0, output: 1, cacheRead: 10, cacheWrite: 0 })).toBe(100)
    // Nothing billed yet: no percentage rather than a division by zero.
    expect(cacheHitPercent({ input: 0, output: 5, cacheRead: 0, cacheWrite: 0 })).toBeUndefined()
    expect(cacheHitPercent(undefined)).toBeUndefined()
  })

  it('budgets every row to a section and paints incremental frames like full ones', async () => {
    // A frame that under-counts a section paints transcript rows over the composer, and an
    // incremental frame that disagrees with a full one leaves stale cells from earlier frames.
    const offenders: string[] = []
    for (const rows of [10, 16, 24, 40]) {
      for (const inputRows of [0, 1, 4]) {
        for (const dock of [0, 2, 5]) {
          for (const slash of [0, 3]) {
            const state = initialTranscript()
            state.items = Array.from({ length: 20 }, (_, i) => ({ id: `a${i}`, kind: 'assistant' as const, text: `line ${i}` }))
            state.queue = Array.from({ length: dock }, (_, i) => ({
              id: `q${i}`, placement: 'queued' as const, text: `queued ${i}`, imageCount: 0, fileCount: 0, editable: true,
            }))
            const input = Array.from({ length: inputRows }, (_, i) => `in${i}`).join('\n')
            const renderer = new TerminalRenderer()
            const options = {
              rows, columns: 80, state, input, cursor: input.length,
              overlay: undefined, expandedTools: false, scroll: LATEST, notice: undefined,
              slashSuggestions: suggest(slash), slashSuggestionIndex: 0,
            }
            const frame = renderer.render(options)
            const painted = frame.text.split('\r\n').length
            if (painted !== rows) offenders.push(`rows=${String(rows)} painted=${String(painted)}`)
            // Growing the draft by one row and back changes the composer's height, which moves
            // every section boundary at once.
            const grown = { ...options, input: `${input}\nx`, cursor: input.length + 2 }
            const incremental = new EmulatedTerminal(80, rows)
            await incremental.write(frame.paint)
            await incremental.write(renderer.render(grown, true).paint)
            await incremental.write(renderer.render(options, true).paint)
            const full = new EmulatedTerminal(80, rows)
            await full.write(new TerminalRenderer().render(options).paint)
            if (incremental.text() !== full.text()) offenders.push(`rows=${String(rows)} input=${String(inputRows)} dock=${String(dock)} slash=${String(slash)} diverged`)
            if (incremental.cursor().y !== full.cursor().y) offenders.push(`rows=${String(rows)} cursor diverged`)
            // Autowrap is restored at the end, or the shell wraps oddly after exit.
            if (!frame.paint.includes('\u001b[?7h')) offenders.push(`rows=${String(rows)} did not restore autowrap`)
            incremental.dispose()
            full.dispose()
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('caps the bottom pane at two thirds and gives the transcript every other row', () => {
    // codex's composer_height_limit: the transcript keeps at least a third of the screen however
    // tall the draft or the dock grows.
    const offenders: string[] = []
    for (const rows of [10, 16, 24, 40, 60]) {
      for (const inputRows of [0, 3, 12, 40]) {
        for (const dock of [0, 3, 8]) {
          const state = initialTranscript()
          state.items = Array.from({ length: 80 }, (_, i) => ({ id: `a${i}`, kind: 'assistant' as const, text: `line ${i}` }))
          state.queue = Array.from({ length: dock }, (_, i) => ({
            id: `q${i}`, placement: 'queued' as const, text: `queued ${i}`, imageCount: 0, fileCount: 0, editable: true,
          }))
          const input = Array.from({ length: inputRows }, (_, i) => `in${i}`).join('\n')
          const frame = renderView({
            rows, columns: 80, state, input, cursor: input.length,
            overlay: undefined, expandedTools: false, scroll: LATEST, notice: undefined,
          })
          const lines = stripAnsi(frame.text).split('\n')
          const area = rows - 1
          const top = lines.findIndex(line => line.startsWith('╭'))
          // Everything from the first dock row (or the composer) to the status row.
          const paneTop = lines.findIndex(line => /^(?:queued|   Alt\+Up|\d+ more pending|╭)/u.test(line))
          const bottomRows = rows - paneTop
          if (bottomRows > bottomPaneLimit(area)) offenders.push(`rows=${String(rows)} input=${String(inputRows)} dock=${String(dock)} bottom=${String(bottomRows)}`)
          // One gap row separates the two unless the screen is too short to spare it.
          const gap = area - bottomRows >= 2 ? 1 : 0
          if (frame.transcriptRows < 1 || frame.transcriptRows !== area - bottomRows - gap) offenders.push(`rows=${String(rows)} input=${String(inputRows)} dock=${String(dock)} transcript=${String(frame.transcriptRows)}`)
          if (top < 0 || frame.cursorRow <= top || frame.cursorRow >= rows) offenders.push(`rows=${String(rows)} input=${String(inputRows)} cursor=${String(frame.cursorRow)}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('paints slash suggestions over the transcript without moving the composer', () => {
    const state = initialTranscript()
    state.items = Array.from({ length: 40 }, (_, i) => ({ id: `a${i}`, kind: 'assistant' as const, text: `line ${i}` }))
    const base = {
      rows: 24, columns: 80, state, input: '/', cursor: 1,
      overlay: undefined, expandedTools: false, scroll: LATEST, notice: undefined,
    }
    const closed = stripAnsi(renderView(base).text).split('\n')
    const open = renderView({ ...base, slashSuggestions: suggest(4), slashSuggestionIndex: 0 })
    const opened = stripAnsi(open.text).split('\n')
    const composer = closed.findIndex(line => line.startsWith('╭'))
    expect(opened.findIndex(line => line.startsWith('╭'))).toBe(composer)
    // The four menu rows replace the gap and the three transcript rows above it; nothing else moves.
    expect(opened.slice(composer - 4, composer).map(line => line.trim().replace(/^❯ /u, ''))).toEqual(['/cmd0 d', '/cmd1 d', '/cmd2 d', '/cmd3 d'])
    expect(opened.slice(0, composer - 4)).toEqual(closed.slice(0, composer - 4))
    expect(opened.slice(composer)).toEqual(closed.slice(composer))
    // A covered row is not selectable.
    expect(open.selectionRegion?.rows.at(-1)).toBe('')
  })

  it('starts a short conversation at the top of the transcript area', () => {
    const state = initialTranscript()
    state.items = [{ id: 'a', kind: 'assistant', text: 'only reply' }]
    const lines = stripAnsi(renderView({
      rows: 24, columns: 80, state, input: '', cursor: 0,
      overlay: undefined, expandedTools: false, scroll: LATEST, notice: undefined,
    }).text).split('\n')
    expect(lines.findIndex(line => line.includes('only reply'))).toBeLessThanOrEqual(2)
  })

  it('keeps the transcript in view while an approval waits above the composer', () => {
    const state = initialTranscript()
    state.items = Array.from({ length: 40 }, (_, i) => ({ id: `a${i}`, kind: 'assistant' as const, text: `line ${i}` }))
    const frame = renderView({
      rows: 30, columns: 80, state, input: 'draft', cursor: 5,
      overlay: { kind: 'approval', request: { toolName: 'bash', reason: 'write outside workspace' }, resolve: () => {} },
      expandedTools: false, scroll: LATEST, notice: undefined,
    })
    const lines = stripAnsi(frame.text).split('\n')
    const approval = lines.findIndex(line => line.includes('Approval required'))
    const composer = lines.findIndex(line => line.startsWith('╭'))
    expect(lines.slice(1, approval).join('\n')).toContain('line 39')
    expect(approval).toBeGreaterThan(0)
    expect(approval).toBeLessThan(composer)
    expect(lines[composer + 1]).toContain('draft')
    expect(frame.scrollBy(-1).kind).toBe('reading')
  })

  it('keeps a reading position on its content as rows arrive and the terminal resizes', () => {
    const state = initialTranscript()
    const reply = (i: number) => ({ id: `a${String(i)}`, kind: 'assistant' as const, text: `reply ${String(i)} ${'word '.repeat(30)}` })
    state.items = Array.from({ length: 30 }, (_, i) => reply(i))
    const options = {
      rows: 24, columns: 80, state, input: '', cursor: 0,
      overlay: undefined, expandedTools: false, notice: undefined,
    }
    const renderer = new TerminalRenderer()
    const latest = renderer.render({ ...options, scroll: LATEST })
    const back = latest.scrollBy(-20)
    const reading = renderer.render({ ...options, scroll: back })
    const topText = (frame: { readonly selectionRegion: { readonly rows: readonly string[] } | undefined }) =>
      frame.selectionRegion?.rows.find(row => row.trim() !== '')?.trim()
    const pinned = topText(reading)
    expect(reading.position.kind).toBe('reading')
    expect(stripAnsi(reading.text)).toContain('↓ bottom · Esc')

    // New replies stream in below: a row count from the bottom would slide, the anchor does not.
    const grown = { ...state, items: [...state.items, reply(30), reply(31), reply(32)] }
    const after = renderer.render({ ...options, state: grown, scroll: reading.position })
    expect(topText(after)).toBe(pinned)

    // A narrower terminal rewraps every reply; the view still opens inside the same reply.
    const narrow = renderer.render({ ...options, columns: 50, state: grown, scroll: after.position })
    expect(after.position.kind === 'reading' && narrow.position.kind === 'reading').toBe(true)
    if (after.position.kind === 'reading' && narrow.position.kind === 'reading') {
      expect(narrow.position.key).toBe(after.position.key)
      expect(narrow.position.span).toBeGreaterThan(after.position.span)
    }
  })

  it('returns to the latest rows once scrolling reaches the bottom', () => {
    const state = initialTranscript()
    state.items = Array.from({ length: 40 }, (_, i) => ({ id: `a${String(i)}`, kind: 'assistant' as const, text: `line ${String(i)}` }))
    const options = {
      rows: 24, columns: 80, state, input: '', cursor: 0,
      overlay: undefined, expandedTools: false, notice: undefined,
    }
    const renderer = new TerminalRenderer()
    const back = renderer.render({ ...options, scroll: LATEST }).scrollBy(-5)
    const reading = renderer.render({ ...options, scroll: back })
    expect(reading.scrollBy(3).kind).toBe('reading')
    expect(reading.scrollBy(5)).toEqual(LATEST)
    // Scrolling far past the top stays on the first row instead of piling up offset.
    const top = renderer.render({ ...options, scroll: reading.scrollBy(Number.NEGATIVE_INFINITY) })
    expect(top.selectionRegion?.rows[0]).toContain('line 0')
    expect(top.scrollBy(1).kind).toBe('reading')
  })

  it('holds a reading position at the bottom while a selection pins it', () => {
    const state = initialTranscript()
    state.items = Array.from({ length: 40 }, (_, i) => ({ id: `a${String(i)}`, kind: 'assistant' as const, text: `line ${String(i)}` }))
    const options = {
      rows: 24, columns: 80, state, input: '', cursor: 0,
      overlay: undefined, expandedTools: false, notice: undefined,
    }
    const renderer = new TerminalRenderer()
    const pinned = renderer.render({ ...options, scroll: LATEST }).scrollBy(0)
    expect(renderer.render({ ...options, scroll: pinned }).position).toEqual(LATEST)
    const held = renderer.render({ ...options, scroll: pinned, holdPosition: true })
    expect(held.position.kind).toBe('reading')
    const grown = { ...state, items: [...state.items, { id: 'new', kind: 'assistant' as const, text: 'streamed' }] }
    const after = renderer.render({ ...options, state: grown, scroll: held.position, holdPosition: true })
    expect(after.selectionRegion?.rows).toEqual(held.selectionRegion?.rows)
  })

  it('keeps double-width glyphs off the last column of a row', () => {
    // A wide glyph cannot straddle the final column: the terminal folds it first, so a row
    // whose cell sum fits can still occupy two terminal rows — and every row below it, the
    // composer included, then lands one line lower than the frame budgeted.
    const offenders: string[] = []
    const cellWidth = (text: string): number =>
      Array.from(text).reduce((sum, char) => sum + ((char.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1), 0)
    for (const columns of [20, 21, 40, 41, 80]) {
      for (const text of ['a中a中a中a中', '中'.repeat(12), '中文中文中文中文中文中文', '1234567中x']) {
        const state = initialTranscript()
        state.items = [{ id: 'a', kind: 'assistant', text }]
        const frame = new TerminalRenderer().render({
          rows: 20, columns, state, input: '', cursor: 0,
          overlay: undefined, expandedTools: false, scroll: LATEST, notice: undefined,
        })
        const rows = stripAnsi(frame.text).split('\n')
        for (const [index, row] of rows.entries()) {
          const width = cellWidth(row)
          if (width > columns) offenders.push(`cols=${String(columns)} row=${String(index + 1)} width=${String(width)}`)
          // A row that ends exactly on a wide glyph would have been folded by the terminal.
          if (width === columns && /[\u2e80-\ua4cf\uac00-\ud7a3\uff00-\uff60]$/u.test(row)) {
            offenders.push(`cols=${String(columns)} row=${String(index + 1)} ends on a wide glyph`)
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('keeps a wide glyph off the last column so the terminal never folds a row', () => {
    // The transcript is indented after wrapping, so a row that ends exactly at the last column
    // makes the terminal fold a trailing wide glyph. That extra row is invisible to this
    // renderer but shifts everything below it, which is how transcript rows end up where the
    // composer should be.
    const offenders: string[] = []
    const cellWidth = (text: string): number =>
      Array.from(text).reduce((sum, char) => sum + ((char.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1), 0)
    for (const columns of [20, 21, 40, 41, 80]) {
      for (const text of ['中'.repeat(12), '中文中文中文中文中文中文', 'a中a中a中a中', '1234567中x']) {
        const state = initialTranscript()
        state.items = [{ id: 'a', kind: 'assistant', text }]
        const frame = new TerminalRenderer().render({
          rows: 20, columns, state, input: '', cursor: 0,
          overlay: undefined, expandedTools: false, scroll: LATEST, notice: undefined,
        })
        for (const [index, row] of stripAnsi(frame.text).split('\n').entries()) {
          const width = cellWidth(row)
          if (width > columns) offenders.push(`cols=${String(columns)} row=${String(index + 1)} wide`)
          if (width === columns && /[\u2e80-\ua4cf\uac00-\ud7a3\uff00-\uff60]$/u.test(row)) {
            offenders.push(`cols=${String(columns)} row=${String(index + 1)} ends on a wide glyph`)
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('shows a Host-queued notice by its summary, without the recall hint', () => {
    const state = initialTranscript()
    state.running = true
    state.queue = [{
      id: 'n1', placement: 'context', text: 'background job bash-1 finished', imageCount: 0, fileCount: 0, editable: false,
      summary: 'bash query.sh completed',
    }]
    const text = stripAnsi(renderView({
      rows: 16, columns: 80, state, input: '', cursor: 0, overlay: undefined, expandedTools: false, scroll: LATEST, notice: undefined,
    }).text)
    expect(text).toContain('notice: bash query.sh completed')
    expect(text).not.toContain('steer:')
    expect(text).not.toContain('Alt+Up recall')
  })

  it('draws a suggestion dim in an empty composer only', () => {
    const options = {
      rows: 12, columns: 60, state: initialTranscript(), cursor: 0, overlay: undefined, expandedTools: false,
      scroll: LATEST, notice: undefined,
    } as const
    const empty = renderView({ ...options, input: '', placeholder: 'sort them by count' }).text
    expect(stripAnsi(empty)).toMatch(/❯ sort them by count\s*│/u)
    expect(empty).toContain('\u001b[2msort them by count')
    const typed = stripAnsi(renderView({ ...options, input: 'no', cursor: 2, placeholder: 'sort them by count' }).text)
    expect(typed).not.toContain('sort them by count')
  })
})

function stripAnsi(value: string): string {
  return value
    .replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]|\u001b\](?:[^\u0007\u001b]|\u001b(?!\\))*(?:\u0007|\u001b\\)/gu, '')
    // Frames break rows with CRLF so the cursor returns to column 1 regardless of how the
    // terminal expands LF; the visible text keeps only the newline.
    .replaceAll('\r\n', '\n')
}
