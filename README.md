# Baizhu DSH

这是一个以 Home Manager/Nix 构建的 DeepSeek Harness（DSH）发行版式配置，而不只是几行 Web UI 设置。它把固定版本的 DSH 源码、构建补丁、运行时插件、权限策略、会话持久化、技能和 Agent preset 组合成一个可复用的本地 Agent 工作台。

## 配置特色

- **源码级可复现构建**：`dsh.nix` 固定 `deepseek-harness` 的 Git revision 和 pnpm 依赖，使用 Node.js 22、pnpm 11 构建 host/client 两端，并生成带 `--expose-internals` 的 `dsh` 启动包装器。
- **Web、TUI 与 headless profile**：共用 dsh 0.2.0-rc.2 的模型实现、技能与会话存储；Web 面向浏览器，headless 面向脚本。新版设置按 profile 保存，不再共享一份 `settings.yaml`。
- **第四种 Confirm 权限模式**：保留 DSH 原有的 Read Only、Workspace Write、Full Access，另加默认的 `confirm`：使用完整访问范围，但每次文件写入或命令执行都先询问。
- **Codex-compatible preset**：`Codex Mode` 把 DSH 的底层能力映射为 `exec_command`、`apply_patch`、Plan、图片查看、用户提问和 V1/V2 子代理等 Codex 形状的工具，指令面直接采用官方 model catalog，并复刻官方的 `<permissions instructions>` 与 `<environment_context>`，同时仍由主机统一掌管沙箱、审批、文件系统和会话持久化。
- **面向长任务的会话保护**：使用上游 `session-persistence-jsonl` 的 kernel-level `session.lock`，由操作系统负责跨进程写入排他和进程退出后的自动释放。
- **声明式的插件化扩展**：权限询问、审批面板、OpenAI 账号和 skills 都通过 profile/preset 注入，而不是长期维护一份分叉的 DSH 源码。

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

`dsh-tui` / `dst` 使用 `~/.dsh/profiles/dsh-tui/cordis.patch.yml`，保留 Confirm 和 Codex preset；不安装或注册 `liangshen preset`。TUI 的随包手册通过这两个启动器注入；直接运行 `dsh --profile dsh-tui` 不注入手册。`dst doctor` 还会检查未使用的旧路径 `~/.dsh-tui/cordis.yml`，显示“缺失”不影响当前 profile 启动。不要为了消除这条提示而覆盖用户现有配置。

### Headless

```bash
dsh --profile headless "run the tests"
dsh --profile headless --help
```

使用官方 `headless-startup` 和 `headless-runner`，保留上游支持的 `--session-id` / `--json`；不再安装 cc-connect 的 `--jsonl` 桥或扩展参数。原有独立 `cc-connect` 服务仍由 `agent/cc-connect.nix` 管理，若要继续使用它，需另行适配其 dsh 调用协议。

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
| `standard` / `ptc` / `minimal` / `cordis` | dsh 官方声明式 preset：Web/TUI 使用 bundle 及适配器；headless 使用上游默认工具。 |
| `codex` | 本地声明式 preset：Codex persona、Code Mode、沙箱 shell、`apply_patch`、Skills、Plan Mode、用户提问、图片查看和子代理。Web/TUI 显式注册；不安装 liangshen。 |

Codex preset 只改变选中该 preset 的 session 的 model-facing surface：SSH 等主机额外工具会被隐藏，但沙箱、审批、附件、文件系统、模型路由和 session persistence 仍由 DSH 主机服务提供。NixOS 不保证 `/bin/bash` 存在，因此 `dsh-codex.nix` 会把 Codex PTY 的 bash 路径替换为 nixpkgs 中的 `bashInteractive`。

### Codex 目录对齐

`dsh-codex.nix` 把官方 `codex-rs/models-manager/models.json` pin 到 `79932482…`（与 `agent.cordis.yml` 记录的参考 commit 一致）。`codex-model-parity.mjs` 按行读取它，因此升级只需改一处 pin 与 hash：

- **指令**：`model_messages.instructions_template` 逐字作为 persona，附 `<model_switch>`（换模型时一次性提示）、Code Mode 边界、catalog 的 `<collaboration_mode>`、`<multi_agent_role>` 与本地生成的 `<multi_agent_usage_hint>`。catalog 模板是字面文本，只有 `{{ personality }}` 被替换，persona section 以 `interpolate: false` 提交——GPT-6 模板里的 `app://{{connector_id}}` 不是 prompt 变量。
- **工具面**：`tool_mode`、`multi_agent_version`、`shell_type`、`apply_patch_tool_type`、`input_modalities`、`supports_search_tool` 等与官方一致；`experimental_supported_tools` 为 GPT-6 家族开启 `request_user_input_async` 与 `clock__curr_time` / `clock__sleep`。dsh 原生的 `subagent` / `send_message` / `exit_plan_mode` / `workflow` 等在直接面与嵌套 Code Mode SDK 中都被隐藏。
- **Token budget**：`token_budget.enabled` 默认为 false（`#[serde(default)]`），因此 `get_context_remaining` / `new_context` / `<context_window_guidance>` 与官方一样不出现；verbosity 的 `<model_response_preferences>` 仍保留。
- **未知 model**：catalog 未命中的 model id 会 `process.emitWarning` 提示需要重新 pin，而不是静默使用旧 prompt。

`prompts/` 是从 `codex-rs/prompts/templates/permissions/**` 逐字 vendored 的沙箱与审批文案。`<permissions instructions>` 按上游顺序拼装：sandbox 模板 → approval 模板 → writable roots → approved prefixes → `request_permissions` 段。

### 新增的可选模式

| 命令 | 作用 |
| --- | --- |
| `/codex-permission <codex-read-only\|codex-on-request\|codex-full-access>` | 在不改动全局权限表的前提下切换 Codex 权限档。 |
| `/codex-persistent on\|off` | 对应上游 `ReasoningEffort::Persistent`：开启后注入 catalog 的 `persistent_instructions`（GPT-6 家族），默认关闭。 |

### 已知的能力边界

- **网络**：`NetworkSandboxPolicy` 在上游是独立于文件沙箱的一层，dsh 的 `sandboxPolicy` 只有 `mode` 与 `workspaceRoot`。因此 preset 按上游规则声明网络状态（`danger-full-access` → enabled，managed → restricted），并且在 restricted 档下网络权限必须经过 `request_permissions` / `additional_permissions` 询问——但内核层没有丢包式的网络阻断。
- **approval 策略**：dsh 只有 `ask` / `never`，上游的 `untrusted`（依赖 exec policy 规则）与 `granular` 无法忠实复刻，因此不提供对应档位。
- **传输类型**：上游的 `exec` 与 `apply_patch` 是带 lark 语法的 freeform 工具，preset 中是 JSON function；工具结果带 Codex 的 `Chunk ID` / `Wall time` / `Original token count` 头部，Web/TUI 卡片会去掉该头部，保持与 standard preset 一致的可读性。
- **工具名**：Responses API 要求 `^[a-zA-Z0-9_-]+$`，因此 `clock` 命名空间以 `clock__curr_time` / `clock__sleep` 呈现（与 Codex 在 `exec` 内生成的标识符同名）。`codex-model-parity.mjs` 在挂载时会校验全部工具名，不合规会直接让 preset 加载失败而不是让整个请求失败。
- **JSON Schema**：dsh 的 `defineTool` 会丢弃 `additionalProperties`，因此所有 Codex 工具的入参都比上游宽松一档。

## 模型、账号与 UI 修复

- 内置 pi-ai 的 OpenAI/Codex **GPT-6 系列**条目改为 105 万上下文窗口，不再修改其 GPT-5.6 条目；Codex preset 独立目录也修正 GPT-6，同时保留已有的 GPT-5.6 修正。
- 固定 `dsh 0.2.0-rc.2`（`639ed015…`）和 `dsh-TUI 0.12.0`（`3066b291…`），后者明确支持前者；不再抓取、构建或安装独立的 `dsh-auth` 子模块。
- Web、TUI 和 headless profile 均使用 TUI 内置的 `@deepseek-harness-tui/dsh-tui/oauth`。ChatGPT/Codex、Claude 和 Grok 继续共用 `~/.dsh/dsh-auth/credentials.json`，无需重新登录；上游已实现跨实例重新读取及并发凭据锁，替代原 `dsh-auth-fresh-credentials.patch`。
- Web 保留 `/provider`（默认登录 OpenAI Codex Coding Plan，也支持 `status`、`logout`）和 `/auth login openai-codex`，会话内提问补丁已移植到 TUI 内置 OAuth。Codex `web.run` 也使用同一内置凭据实现。TUI 保留自身的 `/provider` 向导，并提供新版 DeepSeek 账号登录与随包手册；Web/headless 只挂载 OAuth，不启动 TUI。
- Codex `web.run` 在 TUI 的跨进程凭据锁内完成检查、刷新和保存；并发调用不会重复刷新，退出登录也不会被较早的网络请求恢复。
- `tool-bottom-collapse.patch` 在长卡片底部提供折叠按钮；`bash-command-hscroll.patch` 保留长命令原文并让状态/复制控件固定可见。`dsh-tui-wheel-six-lines.patch` 把短时间内同向的滚轮报告合为一次 6 行滚动。

## 持久化与技能

- provider 重试次数遵循当前 dsh 官方默认值；不再通过全局 `home-cordis.patch.yml` 覆盖各 profile 的完整 provider 配置，避免 TUI/Web/headless 之间互相丢失设置。
- `skills.nix` 合并本地 `agent/skills` 与 Anthropic 的 docx/pptx/xlsx/pdf/canvas-design、media-processor、idea-refine 以及 superpowers；技能由 `~/.dsh/skills/` 自动发现。

## 本次升级验证（2026-09-30）

- DSH 全量 host/client/Web 构建、TUI 构建和 Home Manager switch 均成功；7 个 DSH 补丁及 TUI 补丁使用 `--fuzz=0` 应用。
- 核心源码回归 586 项通过（3 项平台跳过），OAuth 130 项、Codex 75 项、Web 插件 7 项通过；另检查滚轮、选区和 MathJax。
- 已用实际安装的启动器在隔离 HOME 启动 Web、TUI、headless；Web/TUI 的四个官方 preset 与 Codex 均无加载错误，未安装或注册 Liangshen。
- 重复 activation 保留运行时设置、用户依赖和凭据；实际升级后的凭据文件校验和不变，Web 额外设置行保留，TUI 自定义 patch 字节未变。

## 维护提示

修改 `dsh.nix` 的源码 revision、`pnpm-lock.yaml` 对应依赖或 patches 后，需要重新确认 fixed-output hash，并检查 `node-pty`、native/system、loader 和模型目录补丁。首次启动可能把旧 `settings.yaml` 改名为 `.imported` 并导入**首先启动的 profile**；Web 运行时新增的设置行会由 Home Manager 保留。0.2.0 的 V4 会话写入采用新事件格式；恢复旧版时仅切换 generation 不足以回滚 v4 会话，应恢复升级前的 `~/.dsh` 备份。
