# Baizhu DSH

这是一个以 Home Manager/Nix 构建的 DeepSeek Harness（DSH）发行版式配置，而不只是几行 Web UI 设置。它把固定版本的 DSH 源码、构建补丁、运行时插件、权限策略、会话持久化、技能和 Agent preset 组合成一个可复用的本地 Agent 工作台。

## 配置特色

- **源码级可复现构建**：`dsh.nix` 固定 `deepseek-harness` 的 Git revision 和 pnpm 依赖，使用 Node.js 22、pnpm 11 构建 host/client 两端，并生成带 `--expose-internals` 的 `dsh` 启动包装器。
- **Web、TUI 与 headless profile**：共用 dsh 0.1.7-rc.2 的模型实现、技能与会话存储；Web 面向浏览器，headless 面向脚本和 `cc-connect`。新版设置按 profile 保存，不再共享一份 `settings.yaml`。
- **第四种 Confirm 权限模式**：保留 DSH 原有的 Read Only、Workspace Write、Full Access，另加默认的 `confirm`：使用完整访问范围，但每次文件写入或命令执行都先询问。
- **Codex-compatible preset**：`Codex Mode` 把 DSH 的底层能力映射为 `exec_command`、`apply_patch`、Plan、图片查看、用户提问和 Luna V1 子代理等 Codex 形状的工具，同时仍由主机统一掌管沙箱、审批、文件系统和会话持久化。
- **面向长任务的会话保护**：使用上游 `session-persistence-jsonl` 的 kernel-level `session.lock`，由操作系统负责跨进程写入排他和进程退出后的自动释放。
- **声明式的插件化扩展**：权限询问、审批面板、OpenAI 账号、headless JSONL runner 和 skills 都通过 profile/preset 注入，而不是长期维护一份分叉的 DSH 源码。

## 分层结构

```text
dsh.nix
├── 构建 DSH 源码与 pnpm 依赖
├── 应用 patches/                          # UI、会话和模型修复
├── 导入 skills.nix 和 presets/
├── 部署 .dsh/profile 的运行时 patch/plugin
└── 安装 dsh、Node.js、rg、bubblewrap、dsh-web

profiles/web/                               # 浏览器交互
profiles/headless/                          # 一次性/JSONL 驱动
presets/codex/                              # Codex 工具边界与 persona
presets/codex/codex-registrar.mjs          # Web/TUI 中注册 Codex；headless 由 official-presets 注册
```

`home.nix` 导入本目录的 `dsh.nix`；因此源码、插件和用户文件都由现有的非 flake Home Manager 配置管理。运行时会被 DSH 原子重写的 `cordis.patch.yml` 不直接做成 `/nix/store` 符号链接，而是由 activation 脚本 seed/reconcile 到 `~/.dsh/`。

### 为什么部分插件必须是真实文件

`home.file` 的普通产物是符号链接。DSH 的 ESM loader 会先 `realpath` 插件，再解析 `@deepseek-ai/*` 等 bare import；若插件落在 `/nix/store`，它就无法从 `~/.dsh/profiles/node_modules` 找到与 DSH 相同的依赖树。因此 `dsh.nix` 的 `dshPlugins` activation 会把 headless/web 插件真实拷贝到 `~/.dsh`，并重新建立 Codex PTY backend 的运行时链接。

## 启动方式

### Web 窗口

```bash
dsh-web [port]                 # 默认 3080
DSH_BROWSER=chromium dsh-web 3080
```

`dsh-web` 会在端口空闲时启动 `dsh web`，然后以临时 Chromium profile 打开独立应用窗口；端口已有实例时只复用它。关闭窗口、终端或按 `Ctrl+C` 后，仅回收本次启动的服务和临时 profile，不会误杀原先运行的实例。启动失败日志写入 `~/.dsh-web.log`；Wayland 下脚本自动使用兼容的 Ozone/IME 参数。

### Headless / cc-connect

```bash
dsh --profile headless "run the tests"
dsh --profile headless --session-id abc --model deepseek-v4-pro \
  --mode confirm --jsonl "inspect and fix the failing test"
```

自定义 `cc-connect-startup` 解析以下参数，`cc-connect-runner` 负责创建或恢复 session、覆盖模型、写入权限旋钮、运行一回合并退出：

| 参数 | 行为 |
| --- | --- |
| `--session-id` | 指定 id 时优先恢复已有持久化 session，恢复失败才以同 id 新建 |
| `--provider` | 覆盖本次运行的 provider route；与 `--model` 一起保证跨 provider 同名模型不歧义 |
| `--model` | 仅覆盖本次运行的模型 |
| `--reasoning-effort` | 覆盖本次运行的思考强度；`/reasoning` 会在下一轮传入 |
| `--mode` | `read-only`、`workspace-write`、`danger-full-access` 或 `confirm` |
| `--preset` | 选择 preset；已有历史的 session 不允许改 composition，空白 session 会记录 `agent-preset/selected` |
| `--list-models` | 输出 dsh 当前运行时 provider/model catalog 的 JSON，不创建 agent |
| `--jsonl` | stdout 流式输出 text/thinking/tool/approval/result/done 事件，并从 stdin 接收审批 |

### cc-connect JSONL 协议

这里保留自定义 `--jsonl`，而不是切换到 dsh/其他 CLI 的 `--json`：cc-connect 需要同时接收增量输出和审批请求，并在同一个进程的 stdin 回写审批决定。两端当前使用的调用和事件契约如下：

- 普通回合：`cc-connect` 调用 `dsh --profile headless --session-id <id> [--provider <provider>] [--model <model>] [--reasoning-effort <effort>] [--mode <mode>] [--preset <name>] --jsonl <task>`；选项置于 task 之前。
- 模型目录：调用 `--list-models`（不创建 session），读取一行 `{ "type": "models", "models": [...], "reasoningEfforts": [...] }` JSON。
- stdout 事件：`text {text}`、`thinking {text}`、`tool/call {callId,name,arguments}`、`tool/result {callId,name,content,isError?}`、`approval/request {id,toolName,reason?,callId?}`、`result {text}` 和 `done {success,sessionId}`。
- 审批：dsh 输出的 request `id` 在 cc-connect 内部会包装为 `dsh_<id>`；cc-connect 回写时去掉此前缀，发送 `{"type":"approval/response","id":"<id>","outcome":"allowed-once"}` 或 `outcome":"rejected"`，每条一行。

因此 `--jsonl` 是本地 dsh runner 与 cc-connect 的明确私有协议；若未来改用官方 `--json`，必须同步迁移参数构造、所有事件类型/字段、审批 stdin 回写、终局处理和对应测试，不能只替换一个 flag。

`--jsonl` 的审批回应用一行 JSON，例如：

```json
{"type":"approval/response","id":"<raw request id>","outcome":"allowed-once"}
```

协议静态回归测试（不需要加载构建后的 dsh 依赖树）：

```bash
node --test profiles/headless/plugins/cc-connect-protocol.test.mjs
```

headless 的权限映射是：Read Only = `read-only + ask`，Workspace Write = `workspace-write + ask`，Full Access = `danger-full-access + never`，Confirm = `danger-full-access + ask`。Confirm 模式会额外拦截 `write`、`edit`、`str_replace_editor`、`bash`、`pwsh` 和 `terminal_send`。

## Web 权限与审批体验

`profiles/web/cordis.patch.yml` 把 `confirm` 设为新会话默认，并把 approval 默认策略固定为 `ask`。读取、搜索和技能加载保持顺畅；写文件和执行命令通过 `confirm-writes.mjs` 转交审批服务。

审批面板由 `dsh-baizhu-approval` 的 client half 接管，提供：

- **拒绝 / 允许一次 / 总是允许** 三个按钮；
- `Esc` 拒绝，`Ctrl/Cmd+Enter` 允许一次，`Ctrl/Cmd+Shift+Enter` 总是允许；
- “总是允许”只在当前页面、当前 session 的内存中生效，刷新或重启后恢复逐次询问。

这与 Codex preset 中的 `codex-approval` 配合使用：`exec_command` 和 `apply_patch` 在 `confirm` 下仍逐次询问；受限模式则先在沙箱内运行，仅通过一次性授权扩大单次调用，preset 不会改变持久权限。

## Preset：从渐进工具注入到 Codex Mode

| Preset | 重点 |
| --- | --- |
| `standard` / `ptc` / `minimal` / `cordis` | dsh 官方声明式 preset：Web/TUI 使用 bundle 及适配器，headless 从已安装 Web bundle 注册相同的四份定义。 |
| `codex` | 本地声明式 preset：Codex persona、Code Mode、沙箱 shell、`apply_patch`、Skills、Plan Mode、用户提问、图片查看和子代理。三个 profile 都显式注册；不安装 liangshen。 |

Codex preset 只改变选中该 preset 的 session 的 model-facing surface：SSH 等主机额外工具会被隐藏，但沙箱、审批、附件、文件系统、模型路由和 session persistence 仍由 DSH 主机服务提供。NixOS 不保证 `/bin/bash` 存在，因此 `dsh-codex.nix` 会把 Codex PTY 的 bash 路径替换为 nixpkgs 中的 `bashInteractive`。

## 模型、账号与 UI 修复

- 内置 pi-ai 的 OpenAI/Codex **GPT-6 系列**条目改为 105 万上下文窗口，不再修改其 GPT-5.6 条目；Codex preset 独立目录也修正 GPT-6，同时保留已有的 GPT-5.6 修正。
- 从 dsh-TUI 引用的 `dsh-auth` 子模块（固定提交 `f44ccc74…`）构建订阅 OAuth provider；ChatGPT/Codex、Claude 和 Grok 共用 `~/.dsh/dsh-auth/credentials.json`，凭据原子保存、跨实例重新读取并在请求前自动刷新。
- Web、TUI 和 headless profile 都挂载 `dsh-auth`；Web 新增 `/provider`（默认登录 OpenAI Codex Coding Plan，也支持 `status`、`logout`），Web `/auth login openai-codex` 同样会把 OAuth 提问关联当前会话。TUI 保留自身的 `/provider` 向导；三个 profile 共用凭据文件。
- `tool-bottom-collapse.patch` 在长卡片底部提供折叠按钮；`bash-command-hscroll.patch` 保留长命令原文并让状态/复制控件固定可见。`dsh-tui-wheel-six-lines.patch` 把短时间内同向的滚轮报告合为一次 6 行滚动。

## 持久化与技能

- provider 重试次数使用当前 dsh 官方默认值 5；不再通过全局 `home-cordis.patch.yml` 覆盖各 profile 的完整 provider 配置，避免 TUI/Web/headless 之间互相丢失设置。
- `skills.nix` 合并本地 `agent/skills` 与 Anthropic 的 docx/pptx/xlsx/pdf/canvas-design、media-processor、idea-refine 以及 superpowers；技能由 `~/.dsh/skills/` 自动发现。

## 维护提示

修改 `dsh.nix` 的源码 revision、`pnpm-lock.yaml` 对应依赖或 patches 后，需要重新确认 fixed-output hash，并检查 `node-pty`、native/system、loader 和模型目录补丁。0.1.7 首次启动把旧 `settings.yaml` 改名为 `.imported` 并导入**首先启动的 profile**；Web 运行时新增的设置行会由 Home Manager 保留。恢复旧版时仅切换 generation 不足以回滚 v4 会话，应恢复升级前的 `~/.dsh` 备份。
