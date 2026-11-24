/** Width-aware deterministic terminal rendering. */

import { describe, expect, it } from 'vitest'
import {
  cacheHitPercent,
  renderMarkdownLines,
  renderView,
  selectedText,
  TerminalRenderer,
  wrapText,
} from '../src/render.ts'
import { initialTranscript } from '../src/transcript.ts'
import type { SlashSuggestion } from '../src/ui.ts'

const suggest = (count: number): SlashSuggestion[] =>
  Array.from({ length: count }, (_, i) => ({ name: `cmd${i}`, description: 'd', source: 'command' }))

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
    // Idle is no longer a permanent marker; the status row still owns the last line.
    expect(lines.at(-1)).toContain('~')
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
    // Cache share is the reading this row keeps; 2 of 10 billed prompt tokens were cached.
    state.tokens = { input: 6, output: 3, cacheRead: 2, cacheWrite: 2 }
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
      expandedTools: false, scroll: 0, notice: undefined,
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
      expandedTools: false, scroll: 0, notice: undefined,
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
      overlay: undefined, expandedTools: false, scroll: 0, notice: undefined,
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
      overlay: undefined, expandedTools: false, scroll: 0, notice: undefined,
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
                overlay: undefined, expandedTools: false, scroll: 0, notice: undefined,
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
      overlay: undefined, expandedTools: false, scroll: 0, notice: undefined,
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
          overlay: undefined, expandedTools: true, scroll: 0,
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

  it('budgets every row to a section and erases whatever sits below the frame', () => {
    // A frame that under-counts a section paints transcript rows over the composer, and a
    // frame that leaves rows below it keeps stale content from an earlier, taller screen.
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
            const frame = renderer.render({
              rows, columns: 80, state, input, cursor: input.length,
              overlay: undefined, expandedTools: false, scroll: 0, notice: undefined,
              slashSuggestions: suggest(slash), slashSuggestionIndex: 0,
            })
            const painted = frame.text.split('\r\n').length
            if (painted !== rows) offenders.push(`rows=${String(rows)} painted=${String(painted)}`)
            if (!frame.text.includes('\u001b[0J')) offenders.push(`rows=${String(rows)} left rows below the frame`)
            // An incremental frame stops at its last changed row, so erasing below it would
            // wipe the composer and status line sitting underneath.
            const incremental = renderer.render({
              rows, columns: 80, state, input: `${input}x`, cursor: input.length + 1,
              overlay: undefined, expandedTools: false, scroll: 0, notice: undefined,
              slashSuggestions: suggest(slash), slashSuggestionIndex: 0,
            }, true)
            if (incremental.text.includes('\u001b[0J')) offenders.push(`rows=${String(rows)} incremental frame erased below itself`)
            // Autowrap is restored after the erase, or the next frame wraps at the margin.
            if (!frame.text.endsWith('\u001b[?7h')) offenders.push(`rows=${String(rows)} did not restore autowrap`)
          }
        }
      }
    }
    expect(offenders).toEqual([])
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
          overlay: undefined, expandedTools: false, scroll: 0, notice: undefined,
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
          overlay: undefined, expandedTools: false, scroll: 0, notice: undefined,
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
})

function stripAnsi(value: string): string {
  return value
    .replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]|\u001b\](?:[^\u0007\u001b]|\u001b(?!\\))*(?:\u0007|\u001b\\)/gu, '')
    // Frames break rows with CRLF so the cursor returns to column 1 regardless of how the
    // terminal expands LF; the visible text keeps only the newline.
    .replaceAll('\r\n', '\n')
}
