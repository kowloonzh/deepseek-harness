# @deepseek-ai/dsh-tui-app

English | [中文](README.zh.md)

Minimal terminal frontend for the existing `web` profile. `dsh tui` connects to a
running `dsh web` process over the public Client Remote contract. When no
host URL is supplied, it starts `dsh web --no-open` and connects to the
tokenized URL printed by that process. The self-started host uses an available
loopback port, so an existing Web host on `3080` does not conflict.

The TUI does not own a profile, does not create `$DSH_HOME/profiles/tui`, and
does not copy or rewrite the web profile configuration. Sessions, models,
tools, approvals, credentials, and plugins remain owned by the web profile
host.

When the TUI starts its own host, it applies an internal host-only overlay that
disables the browser application, client module/HMR chain, browser-only
projections, and Remote controllers the TUI does not call. The overlay also
disables the browser UI modules, so the printed Web URL is an API host rather
than a usable replacement for `dsh web`.

## Usage

```sh
dsh tui
dsh tui --resume
dsh tui --resume <session-id>
dsh tui --prompt '<task text>'
DSH_URL='http://127.0.0.1:3080/?token=...' dsh tui
```

`dsh tui --help` prints the TUI's own options.

`--prompt` submits the text directly through the Remote prompt call as soon as
the Session is open, then exits when that turn stops running. It does not depend
on a paste being submitted by Enter, and a single `Ctrl+C` or `Esc` aborts it,
so a launcher can start the TUI in a pane and inject one task without watching
the screen. The text is passed as one argument, so an interactive terminal is
still required.

`DSH_URL` connects to an existing host as-is; the internal lean overlay is not
applied to that host.

On exit, the TUI prints `dsh tui --resume <session-id>` for the active Session.
`SIGTERM` takes the same path: the alternate screen, mouse tracking, and raw mode
are restored and the process exits with status 143, so a pane supervisor can stop
a worker without leaving a wedged terminal behind.

Before the Session exists the TUI paints one startup frame (`DeepSeek Harness`
and `Starting session...`) and only then the first full frame with
`Type a message or /help`. A launcher can treat that placeholder as stable proof
that input is accepted.

### Shell lines

A draft that starts with `!` runs in the frontend's own process, in the frontend's
working directory, and prints its captured output to the transcript:

```text
!pwd
!git log --oneline -5
```

The line never reaches the host command executor or the model, so the output is
transcript text a person reads rather than prompt content a model acts on. The
shell comes from `$SHELL` (or `/bin/sh`, `cmd.exe` on Windows). Output is capped at
256 KB per stream and the command is stopped after 120 seconds; truncation, a
timeout, a signal, and a non-zero exit are each named in the result block. A `!`
line cannot carry composer images, and `!` alone or `!=`/`!==` stays an ordinary
draft.

## Working in a fork

This branch lives in a fork of `deepseek-ai/deepseek-harness`. Name the fork
`origin` and the official repository `upstream`, then keep the TUI work on its own
branch rather than on `master`:

```sh
git remote add origin   git@github.com:<you>/deepseek-harness.git
git remote add upstream git@github.com:deepseek-ai/deepseek-harness.git
git config rerere.enabled true
git config pull.rebase true
```

Track the synced baseline with a movable tag so the next sync can list what
changed since the last one:

```sh
git fetch upstream --tags
git log --oneline my-last-sync..upstream/master        # commits since the last sync
git diff --stat my-last-sync..upstream/master -- apps/tui  # empty means no TUI conflict
```

### Upgrading to a new upstream tag

Every upstream sync needs all three steps in this order. Skipping either build
step makes the TUI integration tests fail against the new upstream code.

```sh
# 1. Take the new upstream code on master, then refresh dependencies and artifacts.
git checkout master
git pull --ff-only upstream master
pnpm install                # upstream may add workspace packages the TUI imports
pnpm run build:artifacts    # the integration tests run against built lib/ and dist/

# 2. Rebase the TUI branch onto it.
git checkout feat/dsh-tui-profile
git rebase master

# 3. Publish the rebased branch and move the baseline tag.
git push --force-with-lease origin feat/dsh-tui-profile
git tag -f -a my-last-sync dsh-v<new-version> -m "Last upstream sync: dsh-v<new-version>"
```

Step 1 is required even when the rebase is clean: a missing `pnpm install` fails
the suite with `Cannot find package '@deepseek-ai/<new-package>/remote'`, and a
missing `build:artifacts` fails it with the same error for a package that exists
but has no built `lib/`. A rebase that stops on a conflict means a change outside
the TUI's declared files — `apps/tui/tests/fork-boundary.spec.ts` fails exactly
then, which is what keeps this branch rebasable.

### Running local TUI changes

`dsh tui` executes the bundled `apps/tui/lib/index.js`, never `src/`. A source
edit therefore has no visible effect until the bundle is rebuilt:

```sh
pnpm --filter @deepseek-ai/dsh-tui-app run bundle
```

The tests read `src/` through tsconfig paths and pass without this step, so a
green suite does not mean a running terminal picked the change up.

### Registering `dsh` for a Node version

A globally linked `dsh` belongs to one Node version directory. After installing
another Node with `nvm`, that version has no `dsh` until the same link is added,
and a shell that silently keeps the older `dsh` runs the older bundle:

```sh
N="$HOME/.nvm/versions/node/<version>"
mkdir -p "$N/lib/node_modules/@deepseek-ai"
ln -sfn <repo>/apps/cli "$N/lib/node_modules/@deepseek-ai/dsh"
ln -sfn ../lib/node_modules/@deepseek-ai/dsh/lib/bin.js "$N/bin/dsh"
```

Confirm the resolved entrypoint before trusting a local build:

```sh
node -v; command -v dsh; readlink -f "$(command -v dsh)"
```

## Scope

The first version implements:

- streaming assistant text and compact tool cards;
- assistant Markdown rendered as terminal headings, emphasis, lists, code blocks, and tables;
- multiline input with readline-style kill/yank editing, history, cancellation,
  and transcript scrolling;
- text and PNG/JPEG/WebP/GIF image capture from the system clipboard;
- a growing composer with plain borders and the status line underneath;
- `/help`, `/new`, `/resume`, `/model`, `/compact`, `/status`, and `/exit` (alias `/quit`);
- queue/steer delivery, pending-message management, and Alt+Up recall;
- `/queue`, `/retry`, and `/context` for pending input, failed-turn continuation, and context details;
- command and `@path` completion;
- tool approvals and `ask_user_question`;
- grouped tool runs showing counts, names, and running/failed status, with each tool's arguments and output under Ctrl+O;
- a compact status line with cwd, model, reasoning effort, context, tokens, permission, and run state.

The status line shows the web profile's default model before the first prompt and follows live model-selection, token-usage, and execution-state updates from the host. A submitted prompt's acknowledgement does not mark a completed turn as running.

Pointer selection, themes, notifications, side panels, session trees, forks,
worktrees, and alternate agent backends are intentionally out of scope.

`Ctrl+U`, `Ctrl+K`, `Ctrl+W`, and `Ctrl+Y` follow readline kill/yank behavior.
`Shift+Enter` inserts a newline. `Ctrl+V` reads an image first, then falls back to
clipboard text.

Invoke a user-invocable skill with `/<skill-name> [arguments]`. Unmatched slash commands are submitted as prompt text through the web profile host, matching the Web composer's skill-injection path; natural-language requests that name a skill also work through the model's skill tool.

Typing `/` opens completion for local TUI commands, Host commands, and user-invocable skills. Use Up/Down to choose, Tab to complete, or Enter to run the selected item.

The mouse wheel scrolls the conversation transcript. Up/Down remain prompt history and multiline navigation. Drag-select transcript text with the left mouse button, then press `Ctrl+C` to copy the selection.

User messages render as a full-width shaded block while assistant text stays on the normal background. No visible role markers are added, so terminal-native selection copies only the message text.

Enter sends the message to whatever is running: a running turn reads it at its next step boundary, and an idle one starts a turn with it. Ctrl+Enter interrupts that turn first, and Esc only stops things — it closes the open overlay, and otherwise interrupts the turn. Alt+Up recalls the message handed to the running turn so it can be edited before that boundary, Shift+Enter inserts a newline, and Tab completes the slash menu or the draft. `/queue` provides edit and remove actions for the messages awaiting that boundary. A prompt stays visible with a `sending` row until the Host accepts it; admission failure restores the draft. Remote failures are classified into quota, rate-limit, timeout, transport, stream, and empty-response guidance.

## Work items

Checked items are done on this branch; unchecked ones are known follow-ups.

- [x] Transcript drawn as codex-style history cells: Markdown, highlighted code fences, OSC 8 links in tables, and colored tool cards.
- [x] Inline viewport painted through a cell grid, repainted whole after a resize, with untrusted control and OSC sequences stripped.
- [x] Composer keys: Enter sends (a running turn reads it at its next step), Ctrl+Enter interrupts and sends, Esc interrupts, Esc Esc backtracks, Alt+Up recalls, and large pastes fold into placeholders.
- [x] Queue dock and `/queue`; messages the Host queues itself, such as a finished background job, show as `notice:` instead of a steer.
- [x] `!` lines run as one-shot shell commands.
- [x] Slash completion for local commands, Host commands, and skills, plus `@path` completion.
- [x] `/model` chooses the model together with its reasoning effort.
- [x] Status row with model, cwd, context, cache share, and the magpie subscription allowance.
- [x] Desktop notification and window title when a turn ends or waits for input.
- [x] The screen opens before the Host is ready, and a prompt typed meanwhile is sent once the Session exists.
- [x] `/exit` interrupts a running turn before leaving.
- [x] A resident Host can be reused through `DSH_URL`.
- [x] Next-prompt suggestion: a dim guess in the empty composer that Tab takes; the TUI keeps its Host plugin entry in the Web profile patch at each launch, idempotently, and `DSH_TUI_SUGGEST=off` turns it off.
- [x] A blank row between the title and the conversation.
- [ ] The Web frontend still lists the `tui-next-prompt` command records the TUI hides (outside `apps/tui`).
- [ ] Move the suggestion plugin into its own package in a bundle, reached through a Remote service or a projection instead of a Host command.

## Herdr

Inside a Herdr pane, `dsh tui` reports itself as `dsh` with `idle`, `working`, or `blocked` status; approvals and user questions report `blocked`. Reports use the inherited `HERDR_BIN_PATH`, `HERDR_PANE_ID`, and `HERDR_SOCKET_PATH` when `HERDR_ENV=1`. They run asynchronously with a short timeout, and exiting releases the pane's agent registration. Herdr 0.9.0 supports status reporting; 0.9.2 or later also receives `dsh tui --resume <session-id>` for locally started hosts. Connections supplied through `DSH_URL` report status and session identity without persisting a tokenized URL or a restore command. See [Herdr's agent integration protocol](https://herdr.dev/docs/add-herdr-support/).

## Web profile reuse

The TUI only starts or connects to the normal web profile host. The launcher
resolves `web` through the same profile loader as `dsh web`; the TUI performs
no Cordis composition of its own. See `.agents/goals/2026-11-16-dsh-tui-profile.md`
for the implementation contract.
