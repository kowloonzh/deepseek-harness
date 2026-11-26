# @kowloonzh/dsh-tui

A codex-style terminal frontend for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

> Unofficial. Built and maintained by a community member, not by DeepSeek.

`dsh-tui` connects to the `web` profile Host over the public Client Remote contract. It
creates no profile of its own: sessions, models, tools, approvals, credentials, and plugins
are the web profile's, the same ones `dsh web` uses.

## Install

Requires Node `^24.22.3 || >=26.13.1`.

```sh
npm install -g @kowloonzh/dsh-tui
dsh-tui
```

The package depends on an exact release of [`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh),
installed with it, and starts that release's Host. Each `dsh-tui` version is built and tested
against the Host version it pins; `npm ls -g @deepseek-ai/dsh` shows which one.

On an older Node, `npm install -g @kowloonzh/dsh-tui` stops with
`No matching version found for @kowloonzh/dsh-tui@*`: every release is a semver prerelease
(it follows the Host version, such as `0.2.3-alpha.2.tui.1`), and npm passes over `latest`
when its engine range excludes the running Node. Upgrade Node; `npm install -g
@kowloonzh/dsh-tui@latest` installs anyway, but the Host then runs on an unsupported Node.

## Usage

```sh
dsh-tui                          # start a lean local Host and open a new Session
dsh-tui --resume                 # open the newest Session
dsh-tui --resume <session-id>    # open a named Session
dsh-tui --prompt '<task text>'   # submit one task, exit when its turn ends
DSH_URL='http://127.0.0.1:3080/?token=...' dsh-tui   # use a running dsh web Host
```

Configure models and credentials the way `dsh web` expects them; `dsh-tui` reads the same
configuration under `$DSH_HOME` (default `~/.dsh`).

Inside the TUI, `/help` lists the commands and keys. Highlights:

- streaming Markdown with highlighted code and tables, compact tool cards (Ctrl+O expands them);
- tool approvals and `ask_user_question`;
- Enter steers a running turn, Ctrl+Enter interrupts and sends, Esc interrupts, Alt+Up recalls;
- slash completion for local commands, Host commands, and skills, plus `@path` completion;
- `/model` with reasoning effort, `/status` tabs (Status, Stats, Context), `/export`;
- reconnection after a Host restart when `DSH_URL_FILE` names the file holding the Host's URL.

## Source

The code lives in `apps/tui` on the
[`feat/dsh-tui-profile`](https://github.com/kowloonzh/deepseek-harness/tree/feat/dsh-tui-profile/apps/tui)
branch of a fork of `deepseek-ai/deepseek-harness`, rebased onto each upstream release.
Issues: <https://github.com/kowloonzh/deepseek-harness/issues>.

MIT licensed; the bundle includes DeepSeek Harness code under its MIT license.
