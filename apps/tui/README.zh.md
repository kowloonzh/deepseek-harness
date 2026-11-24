# @deepseek-ai/dsh-tui-app

[English](README.md) | 中文

现有 `web` profile 的最简终端前端。`dsh tui` 通过公开的 Client Remote 接口
连接运行中的 `dsh web` 进程。未提供 host URL 时，
它会启动 `dsh web --no-open`，并连接该进程
输出的带 token 的 URL。自启动 host 使用可用的 loopback 端口，
因此不会与已经运行在 `3080` 的 Web host 冲突。

TUI 不单独维护 profile，不创建 `$DSH_HOME/profiles/tui`，
也不复制或重写 web profile 配置。会话、模型、
工具、审批、凭据和插件均由 web profile 的
host 管理。

当 TUI 自己启动 host 时，会应用一个内部 host-only overlay，禁用浏览器应用、
客户端模块/HMR 链、仅浏览器使用的投影，以及 TUI 不调用的 Remote controller。
该 overlay 同时禁用浏览器 UI 模块，因此打印出的 Web URL 是 API host，
不能替代正常的 `dsh web` 界面。

## 用法

```sh
dsh tui
dsh tui --resume
dsh tui --resume <session-id>
dsh tui --prompt '<task text>'
DSH_URL='http://127.0.0.1:3080/?token=...' dsh tui
```

`dsh tui --help` 输出 TUI 自身的选项。

`--prompt` 在 Session 打开后直接通过 Remote prompt 调用提交文本，并在该回合
停止运行时退出。它不依赖粘贴内容被 Enter 提交，单个 `Ctrl+C` 或 `Esc` 即可
中止，因此启动器可以在 pane 中拉起 TUI 并注入一个任务，无需轮询屏幕。文本
作为单个参数传入，所以仍需要交互式终端。

`DSH_URL` 会按原样连接已有 host；内部精简 overlay 不会应用到该 host。

退出时会打印当前 Session 的恢复命令：`dsh tui --resume <session-id>`。
`SIGTERM` 走同一路径：恢复 alternate screen、鼠标追踪和 raw 模式，并以退出码
143 结束，因此 pane 管理器停掉 worker 时不会留下卡死的终端。

Session 建立前 TUI 先画一帧启动画面（`DeepSeek Harness` 和
`Starting session...`），之后才画带 `Type a message or /help` 的首个完整画面。
启动器可以把该占位符当作“输入已被接受”的稳定依据。

### Shell 命令行

以 `!` 开头的输入会在前端自身进程中、于前端工作目录下执行，并把捕获的输出打印到 transcript：

```text
!pwd
!git log --oneline -5
```

该行不会进入 host 的命令执行器，也不会进入模型，因此输出是人阅读的 transcript 文本，
而不是模型会据以行动的提示词内容。shell 取自 `$SHELL`（Windows 回退 `cmd.exe`，
其余回退 `/bin/sh`）。每个流最多捕获 256 KB，命令超过 120 秒会被终止；截断、超时、
被信号终止和非零退出码都会在结果块中写明。`!` 行不能携带输入框图片，单独的 `!`
以及 `!=`、`!==` 仍按普通输入处理。

## 在 fork 中工作

本分支位于 `deepseek-ai/deepseek-harness` 的 fork 中。把 fork 命名为 `origin`，
官方仓库命名为 `upstream`，并把 TUI 工作放在独立分支而不是 `master` 上：

```sh
git remote add origin   git@github.com:<you>/deepseek-harness.git
git remote add upstream git@github.com:deepseek-ai/deepseek-harness.git
git config rerere.enabled true
git config pull.rebase true
```

用一个可移动的 tag 记录已同步的基线，下次同步就能列出本次改了什么：

```sh
git fetch upstream --tags
git log --oneline my-last-sync..upstream/master        # commits since the last sync
git diff --stat my-last-sync..upstream/master -- apps/tui  # empty means no TUI conflict
```

### 升级到新的 upstream tag

每次 upstream 同步都必须按顺序走完这三步。漏掉任一步构建，TUI 集成测试就会
针对新的 upstream 代码失败。

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

即使变基没有任何冲突，第 1 步也不能省：漏掉 `pnpm install` 会让测试报
`Cannot find package '@deepseek-ai/<new-package>/remote'`；漏掉 `build:artifacts`
时，包虽然存在但没有构建出的 `lib/`，报错相同。变基因冲突中断，说明改动越出了
TUI 声明的文件范围——`apps/tui/tests/fork-boundary.spec.ts` 正是在这种情况下失败，
从而保证该分支始终可变基。

### 让本地改动生效

`dsh tui` 执行的是打包产物 `apps/tui/lib/index.js`，从不读取 `src/`。因此修改源码后，
在重新打包之前界面不会有任何变化：

```sh
pnpm --filter @deepseek-ai/dsh-tui-app run bundle
```

测试通过 tsconfig paths 直接读 `src/`，不需要这一步，所以测试全绿并不代表运行中的终端
已经用上了改动。

### 为某个 Node 版本注册 `dsh`

全局链接的 `dsh` 只属于一个 Node 版本目录。用 `nvm` 装了新版本后，该版本下没有 `dsh`，
需要补上同样的链接；否则 shell 会静默沿用旧版本的 `dsh`，运行的也是旧产物：

```sh
N="$HOME/.nvm/versions/node/<version>"
mkdir -p "$N/lib/node_modules/@deepseek-ai"
ln -sfn <repo>/apps/cli "$N/lib/node_modules/@deepseek-ai/dsh"
ln -sfn ../lib/node_modules/@deepseek-ai/dsh/lib/bin.js "$N/bin/dsh"
```

在信任本地构建之前，先确认实际解析到的入口：

```sh
node -v; command -v dsh; readlink -f "$(command -v dsh)"
```

## 功能范围

首版实现：

- 流式助手文本和紧凑的工具卡片；
- 将助手 Markdown 渲染为终端标题、强调、列表、代码块和表格；
- 支持 readline 风格 kill/yank 编辑、历史记录、取消
  和会话滚动的多行输入；
- 从系统剪贴板读取文本和 PNG/JPEG/WebP/GIF 图片；
- 采用纯边框、随内容增长的输入框，状态栏位于其下方；
- `/help`、`/new`、`/resume`、`/model`、`/compact`、`/status` 和 `/exit`（别名 `/quit`）；
- queue/steer 投递、待处理消息管理和 Alt+Up 召回；
- `/queue`、`/retry` 和 `/context`，分别管理待处理输入、继续失败轮次和查看上下文明细；
- 命令和 `@path` 补全；
- 工具审批和 `ask_user_question`；
- 连续工具调用分组显示数量、名称和 running/failed 状态，Ctrl+O 展开每个工具的完整参数与输出；
- 显示工作目录、模型、reasoning effort、上下文、token、权限和运行状态的紧凑状态栏。

状态栏在首次发送前显示 web profile 的默认模型，并跟随 host 实时更新的模型选择、token 用量和执行状态。已提交提示词的确认响应不会把已结束的轮次重新标为运行中。

指针选择、主题、通知、侧面板、会话树、分叉、
工作树和其他 agent 后端暂不在功能范围内。

`Ctrl+U`、`Ctrl+K`、`Ctrl+W` 和 `Ctrl+Y` 采用 readline 的 kill/yank 操作。
`Shift+Enter` 插入换行。`Ctrl+V` 优先读取图片，未找到图片时回退到
剪贴板文本。

使用 `/<skill-name> [参数]` 调用允许用户触发的 skill。未匹配本地或 Host 命令的 slash 输入会作为提示词交给 web profile host，沿用 Web composer 的 skill 注入路径；自然语言中要求使用某个 skill 时，模型也可以通过 skill 工具加载。

输入 `/` 会打开补全菜单，合并 TUI 本地命令、Host 命令和允许用户触发的 skill。使用上下箭头选择，Tab 补全，Enter 执行选中项。

鼠标滚轮滚动上方会话记录；上下箭头仍用于输入历史和消息窗口内导航。按住鼠标左键拖选会话文本，再按 `Ctrl+C` 复制选中内容。

用户消息使用整行底色块，助手正文保持普通背景。界面不渲染可见角色标记，终端原生选择复制时只包含消息正文。

Enter 始终把消息放进队列，不会有消息自行插入正在运行的回合：该回合结束后队列中的消息才会投递。Alt+Enter 会中断正在运行的回合并立即发出草稿（Ctrl+Enter 等效）；按 Alt+Up 把最新的排队消息召回到输入框修改。Esc 只负责停止：有浮层时关闭浮层，否则中断正在运行的回合。Shift+Enter 插入换行，Tab 用于补全斜杠菜单或草稿。`/queue` 支持对待处理消息执行编辑和删除。提示词在 Host 接受前保持可见并显示 `sending` 行；准入失败会保留草稿。Remote 失败会按 quota、rate limit、timeout、transport、stream 和 empty response 分类给出提示。

## Herdr

在 Herdr pane 中，`dsh tui` 以 `dsh` 的名称上报 `idle`、`working` 或 `blocked` 状态；审批和用户提问上报 `blocked`。当 `HERDR_ENV=1` 时，上报使用继承的 `HERDR_BIN_PATH`、`HERDR_PANE_ID` 和 `HERDR_SOCKET_PATH`。上报异步执行并设有较短超时，退出时释放 pane 中的 agent 注册。Herdr 0.9.0 支持状态上报；对于本地启动的 host，0.9.2 及以上版本还会接收 `dsh tui --resume <session-id>`。通过 `DSH_URL` 建立的连接会上报状态和会话标识，但不会持久化带 token 的 URL 或恢复命令。参见 [Herdr agent 集成协议](https://herdr.dev/docs/add-herdr-support/)。

## 复用 Web profile

TUI 只启动或连接标准 web profile host。启动器
使用与 `dsh web` 相同的 profile 加载器解析 `web`；TUI
不自行组合 Cordis 插件。实现约定参见 `.agents/goals/2026-11-16-dsh-tui-profile.md`，
其中记录了实现要求。
