# Goal：实现最小可用的 `dsh tui`

在当前仓库的 `feat/dsh-tui-profile` 分支上，实现一个最小可用、可长期跟随官方更新的 `dsh tui`。

## 不可违背的约束

1. `dsh tui` 必须直接使用现有 `web` profile 的配置。读取 `$DSH_HOME/profiles/web/package.json`、`$DSH_HOME/profiles/web/cordis.patch.yml` 和 `$DSH_HOME/cordis.patch.yml`，不得复制、镜像或生成第二份 TUI 专属 Cordis 配置。
2. 不创建 `$DSH_HOME/profiles/tui`，也不修改用户的 web profile 配置。除非用户明确要求，否则不得改写任何 profile 文件。
3. 将 `dsh tui` 定义为 web profile 的终端前端或别名，而不是另一套 Agent 组合。Session、Agent、Tool、审批、凭据、模型和插件状态仍由 web profile host 拥有。
4. 所有新增产品代码、测试、文档和资源集中放在新的独立目录 `apps/tui/`。不得把 TUI 行为加入 `dsh-base`、`dsh-web-app`、agent loop、session、工具、sandbox、API gateway 或现有 client UI。
5. 对官方代码的修改必须尽可能少，并限制在启动路由或构建发现所需的明确接入点。优先通过新增文件和公开契约实现；不要复制或重构官方实现。
6. 如果现有公开契约无法支持某项需求，不要私自修改核心语义或建立平行协议。停止该部分并报告缺失的 seam、影响范围和最小上游改动建议。
7. 不得引入对上游发布节奏敏感的生成文件改动。所有 TUI 测试和文档归 `apps/tui/` 自己维护。
8. 遵循仓库根 `AGENTS.md`、`docs/architecture.md`、`docs/defensive-patterns/README.md` 及相关技能要求。

## 目标结构

- 在 `apps/tui/` 放置 TUI 入口、终端渲染、输入编辑、Remote client、状态投影、locale、测试和文档。
- `dsh tui` 的命令适配只负责选择这个前端，不承载业务逻辑。
- 尝试复用现有 `@deepseek-ai/dsh-api-remotes`、`@deepseek-ai/dsh-client-connection` 或等价公开 Client/Remote 契约。不要直接依赖 Host 内部私有服务。
- 若已有 `dsh web` 在运行，连接它。若没有，由 `dsh tui` 启动 `dsh web --no-open` 子进程，并等待 host ready。
- 默认地址为 `http://127.0.0.1:3080`，支持 `DSH_URL` 覆盖。认证、trust 和连接方式必须复用 web host 现有机制。
- 只清理由 `dsh tui` 自己启动的 host；不得终止用户已有的 Web host。

## 最小功能范围

1. 启动与连接：`dsh tui` 一键启动；检测现有 host；不存在时启动 web profile host；错误必须明确报告。
2. 对话：显示用户消息、流式助手文本、基础 Markdown、代码块和可折叠的 tool call/result 卡片。
3. 输入：多行输入、粘贴、输入历史、发送和取消；`Enter` 发送，`Shift+Enter` 或 `Ctrl+J` 换行，`Esc` 中断当前回合。
4. 会话：支持 `dsh tui --resume [id]`、`/new`、`/resume` 和最近会话列表；必须与 Web 共用 `$DSH_HOME/sessions`。
5. 命令：首版支持 `/help`、`/new`、`/resume`、`/model`、`/compact`、`/status`、`/quit`，并提供 `/` 命令补全。
6. 文件引用：支持基础 `@path` 补全与插入。暂不实现行号跳转、文件预览、图片或内联 diff 交互。
7. 审批与问答：工具审批支持“本次允许/拒绝”；`ask_user_question` 支持单选、多选和文本回答；弹出层必须能关闭和取消。
8. 状态栏：显示当前工作目录、模型、运行/空闲状态和基础 token 或 context 用量。
9. 终端生命周期：使用 alternate screen，处理 resize；正常退出、`Ctrl+C`、SIGTERM 和异常时恢复终端、光标、鼠标及输入模式。
10. 连接错误：host 不可达、版本不兼容、认证失败或配置加载失败时明确报错；不得静默切换到其他 profile。

## 首版明确不做

- 鼠标交互、文本选择、图片、Mermaid、LaTeX、Sixel/Kitty。
- 主题、宠物、动画、系统通知。
- Vim 模式和可配置 keymap。
- 侧栏、Todo 面板、多面板布局。
- session tree、fork、rewind、worktree、代码审查面板。
- Claude、Codex 或其他多后端切换。
- TUI 独立插件市场、TUI 专属设置系统或 TUI 专属 profile 配置。

## 实现要求

1. 先核对当前 DSH 的 public client/remote contract、web host 启动方式、会话 API、审批 API 和用户问答 API，再确定最小实现路径。
2. 将跨层类型和行为投影保存在 `apps/tui/` 内，UI 不直接读取 Host 私有状态。
3. 使用 typed, structured failures；不得把连接、认证或协议错误吞掉。
4. 网络和流处理必须支持取消、断线提示和幂等清理，不能留下子进程、端口、锁或监听器。
5. 为新增 UI 文案使用 locale-owned 文案；若首版只提供中文或英文，也必须通过字典而非散落字符串。
6. 添加一个仓库边界检查或测试，证明除明确白名单外没有修改官方 TUI 之外的代码。边界测试本身也放在 `apps/tui/`。
7. 添加单元测试和可无真实 API Key 运行的集成测试。至少覆盖：
   - 直接解析并使用 web profile；
   - 已运行 host 与自动启动 host 两条路径；
   - 流式回复、tool card、审批、用户问答；
   - 中断、退出和终端恢复；
   - Web 与 TUI 会话互见；
   - TUI 运行前后 web profile patch 哈希不变。
8. 按改动范围运行仓库要求的 focused tests、构建和类型检查；不要默认执行完整测试套件。使用 `dsh-pre-push-checks` 决定最终检查集。

## 完成标准

- `dsh tui` 可以连接或启动使用 `web` profile 的 host。
- `dsh web` 与 `dsh tui` 看到相同的模型、工具、插件、用户 patch 和 Session。
- 仓库中不存在 `profiles/tui` 配置或复制出来的 web 配置。
- TUI 运行前后 `$DSH_HOME/profiles/web/cordis.patch.yml` 哈希不变。
- 所有 TUI 产品代码和测试集中在 `apps/tui/`，官方核心目录只有最少且列明的接入改动。
- 断线、审批、取消和退出路径可验证；终端和子进程均完全清理。
- 最终报告列出实际修改文件、外部接入点、测试命令及结果，并明确说明尚未实现的首版非目标。
