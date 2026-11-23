/** Width-aware deterministic terminal rendering. */

import { describe, expect, it } from 'vitest'
import {
  renderMarkdownLines,
  renderView,
  selectedText,
  TerminalRenderer,
  wrapText,
} from '../src/render.ts'
import { initialTranscript } from '../src/transcript.ts'

describe('terminal rendering', () => {
  it('wraps CJK text by terminal cells', () => {
    expect(wrapText('中文abc', 5)).toEqual(['中文a', 'bc'])
  })

  it('distinguishes roles with color and no copy-visible markers or labels', () => {
    const state = initialTranscript()
    state.items = [
      { id: 'u', kind: 'user', text: 'hello' },
      { id: 'a', kind: 'assistant', text: 'reply' },
    ]
    const raw = renderView({
      rows: 20, columns: 80, state, input: '', cursor: 0,
      overlay: undefined, expandedTools: false, scroll: 0, notice: undefined,
    }).text
    const rendered = stripAnsi(raw)
    expect(rendered).toContain('hello')
    expect(rendered).toContain('reply')
    expect(raw).toContain('\u001b[97m\u001b[48;5;238m\u001b[36m›\u001b[97m\u001b[48;5;238m hello')
    expect(rendered).not.toContain('❯ hello')
    expect(rendered).not.toContain('● reply')
    expect(rendered).not.toContain('You hello')
    expect(rendered).not.toContain('DSH reply')
    expect(rendered.split('\n').find(line => line.includes('hello'))).toMatch(/^  › hello/u)
    expect(rendered.split('\n').find(line => line.includes('reply'))).toMatch(/^  reply/u)
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
      scroll: 0,
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
      scroll: 0,
      notice: undefined,
    })
    const lines = stripAnsi(frame.text).split('\n')
    const top = lines.findIndex(line => line.startsWith('╭─'))
    const bottom = lines.findIndex(line => line.startsWith('╰─'))
    expect(top).toBeGreaterThan(0)
    expect(bottom - top).toBeGreaterThanOrEqual(4)
    expect(lines.at(-1)).toContain('| idle')
    expect(lines.at(-1)).toContain('|')
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
        overlay: undefined, expandedTools: false, scroll: 0, notice: undefined,
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
    expect(oneLine.lines[oneLine.bottom + 1]).toBe('')
    expect(twoLines.height).toBe(3)
  })

  it('renders queue and submission rows above the composer with model context and permission', () => {
    const state = initialTranscript()
    state.model = { provider: 'p', model: 'model-x', reasoningEffort: 'high' }
    state.context = { pressureTokens: 400, projectedTokens: 500, contextWindow: 1000 }
    state.permission = 'workspace-write'
    state.queue = [
      { id: 'q1', placement: 'queued', text: 'later', imageCount: 0, fileCount: 0, editable: true },
      { id: 'q2', placement: 'steering', text: 'adjust course', imageCount: 0, fileCount: 0, editable: true },
    ]
    const frame = renderView({
      rows: 24, columns: 120, state, input: '', cursor: 0,
      submission: { mode: 'steer', text: 'current', imageCount: 1 },
      overlay: undefined, expandedTools: false, scroll: 0, notice: undefined,
    })
    expect(frame.text).toContain('sending steer: current [1 image]')
    expect(frame.text).toContain('queued: later')
    expect(frame.text).toContain('steer: adjust course')
    const status = stripAnsi(frame.text).split('\n').at(-1) ?? ''
    expect(status).toContain('model-x:high')
    expect(status).toContain('ctx 50%')
    expect(status).toContain('workspace-write')
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
    const frame = (expandedTools: boolean, scroll = 0) => stripAnsi(renderView({
      rows: 50, columns: 80, state, input: '', cursor: 0,
      overlay: undefined, expandedTools, scroll, notice: undefined,
    }).text)
    const folded = frame(false)
    expect(folded).toContain('Edited notes.md (+2 -1)')
    expect(folded).toContain('Ran · failed false')
    expect(folded).toContain('Read notes.md')
    expect(folded).toContain('Searched web · running news')
    expect(folded).toContain('Fetched 2 pages · failed')
    expect(folded).toContain('+ Show details')
    expect(folded).not.toContain('arguments:')
    expect(folded).not.toContain('exit 1')

    const expanded = frame(true)
    expect(expanded).toContain('tool:edit [ok] path: notes.md')
    expect(expanded).toContain('tool:bash [failed] command: false')
    expect(expanded).toContain('arguments: {"command":"false"}')
    expect(expanded).toContain('output: permission denied')
    expect(expanded).toContain('exit 1')
    expect(expanded).toContain('tool:web_fetch')
    expect(expanded).not.toContain('+ Show details')

    const scrolled = frame(false, 3)
    expect(scrolled).toContain('web_search running')
    expect(scrolled).toContain('↓ bottom · Esc')
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
      overlay: undefined, expandedTools: false, scroll: 0, notice: undefined,
    }).text)
    expect(frame).toContain('❯ /icai Research workflow [skill]')
    expect(frame).toContain('/install Install something')
  })

  it('repaints only changed rows for incremental scroll frames', () => {
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
    const first = renderer.render({ ...options, scroll: 0 })
    const second = renderer.render({ ...options, scroll: 3 }, true)
    expect(first.text).toContain('\u001b[2J')
    expect(second.text).not.toContain('\u001b[2J')
    expect(second.text).toMatch(/\u001b\[\d+;1H\u001b\[2K/u)
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
      scroll: 0,
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
    expect(rendered).toContain('go')
    expect(rendered).toContain('fmt.Println("ok")')
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
})

function stripAnsi(value: string): string {
  return value.replaceAll(
    /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\](?:[^\u0007\u001b]|\u001b(?!\\))*(?:\u0007|\u001b\\)/gu,
    '',
  )
}
