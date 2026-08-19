# Baizhu DSH

这是一个以 Home Manager/Nix 构建的 DeepSeek Harness（DSH）发行版式配置，而不只是几行 Web UI 设置。它把固定版本的 DSH 源码、构建补丁、运行时插件、权限策略、会话持久化、技能和 Agent preset 组合成一个可复用的本地 Agent 工作台。

## 配置特色

- **源码级可复现构建**：`dsh.nix` 固定 `deepseek-harness` 的 Git revision 和 pnpm 依赖，使用 Node.js 22、pnpm 11 构建 host/client 两端，并生成带 `--expose-internals` 的 `dsh` 启动包装器。
- **Web 与 headless 双 profile**：Web profile 面向交互式浏览器；headless profile 面向脚本和 `cc-connect`，两者共享模型、技能、会话和权限语义。
- **第四种 Confirm 权限模式**：保留 DSH 原有的 Read Only、Workspace Write、Full Access，另加默认的 `confirm`：使用完整访问范围，但每次文件写入或命令执行都先询问。
- **Codex-compatible preset**：`Codex Mode` 把 DSH 的底层能力映射为 `shell_command`、`apply_patch`、Plan、图片查看、用户提问和 Luna V1 子代理等 Codex 形状的工具，同时仍由主机统一掌管沙箱、审批、文件系统和会话持久化。
- **面向长任务的会话保护**：`durable-session-lease.patch` 为持久化日志增加跨进程租约和 revision guard，避免 headless 审批、恢复或多个进程同时写入同一个 session 时产生交错事件和序号回退。
- **声明式的插件化扩展**：权限询问、审批面板、OpenAI 账号、headless JSONL runner、皮肤和 skills 都通过 profile/preset 注入，而不是长期维护一份分叉的 DSH 源码。

## 分层结构

```text
dsh.nix
├── 构建 DSH 源码与 pnpm 依赖
├── 应用 patches/                          # UI、会话和模型修复
├── 导入 skills.nix、skin-center 和 presets/
├── 部署 .dsh/profile 的运行时 patch/plugin
└── 安装 dsh、Node.js、rg、bubblewrap、dsh-web

profiles/web/                               # 浏览器交互
profiles/headless/                          # 一次性/JSONL 驱动
presets/codex/                              # Codex 工具边界与 persona
presets/dsh-*-standard.nix                  # 实验性路由/工具渐进注入
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
| `--model` | 仅覆盖本次运行的模型 |
| `--mode` | `read-only`、`workspace-write`、`danger-full-access` 或 `confirm` |
| `--jsonl` | stdout 流式输出 text/thinking/tool/approval/result/done 事件，并从 stdin 接收审批 |

`--jsonl` 的审批回应用一行 JSON，例如：

```json
{"type":"approval/response","id":"<request id>","outcome":"allowed-once"}
```

headless 的权限映射是：Read Only = `read-only + ask`，Workspace Write = `workspace-write + ask`，Full Access = `danger-full-access + never`，Confirm = `danger-full-access + ask`。Confirm 模式会额外拦截 `write`、`edit`、`str_replace_editor`、`bash`、`pwsh` 和 `terminal_send`。

## Web 权限与审批体验

`profiles/web/cordis.patch.yml` 把 `confirm` 设为新会话默认，并把 approval 默认策略固定为 `ask`。读取、搜索和技能加载保持顺畅；写文件和执行命令通过 `confirm-writes.mjs` 转交审批服务。

审批面板由 `dsh-baizhu-approval` 的 client half 接管，提供：

- **拒绝 / 允许一次 / 总是允许** 三个按钮；
- `Esc` 拒绝，`Ctrl/Cmd+Enter` 允许一次，`Ctrl/Cmd+Shift+Enter` 总是允许；
- “总是允许”只在当前页面、当前 session 的内存中生效，刷新或重启后恢复逐次询问。

这与 Codex preset 中的 `codex-approval` 配合使用：Codex 形状的 `shell_command` 和 `apply_patch` 在 `confirm` 下也会进入同一审批边界，preset 本身不会扩大主机权限。

## Preset：从渐进工具注入到 Codex Mode

| Preset | 重点 |
| --- | --- |
| `anchored-standard` | 首次请求只给 Minimal 对齐的双工具目录；出现持久化晋升信号后开放完整 Standard 工具目录。 |
| `router-standard` | 首轮注入 RL-interface 风格 persona 与 shell/editor，首次工具调用后开放完整 Standard。 |
| `router-spec` | 按任务分类注入 persona 和完整 prompt sections，强调 deep-think-first。 |
| `codex` | Codex persona、环境与 `AGENTS.md`、Code Mode、沙箱 shell、`apply_patch`、Skills、Plan Mode、用户提问、图片查看、时间和 Luna V1 子代理。 |

Codex preset 只改变选中该 preset 的 session 的 model-facing surface：SSH 等主机额外工具会被隐藏，但沙箱、审批、附件、文件系统、模型路由和 durable session 仍由 DSH 主机服务提供。NixOS 不保证 `/bin/bash` 存在，因此 `dsh-codex.nix` 会把 Codex PTY 的 bash 路径替换为 nixpkgs 中的 `bashInteractive`。

## 模型、账号与 UI 修复

- 构建期把 OpenRouter 的 DeepSeek V4 Flash 0731、V4 Pro 0813 正式版注入 pi-ai 内置目录，和原有预览版一起出现在模型选择器中。
- 修正 pi-ai 将 GPT-5.6 的价格分层阈值误当成上下文上限的问题，相关 OpenAI/Codex 条目使用约 105 万上下文窗口。
- `openai-codex-account.mjs` 复用 pi-ai 的 OAuth 流程，支持 ChatGPT Plus/Pro token plan；凭据保存为 `~/.dsh/openai-codex-credentials.json`（权限 0600），并在请求前自动刷新 access token。
- Web 中可使用 `/openai-login`、`/openai-logout`、`/openai-status`，也可在设置页的 **OpenAI 账号** 分节操作。
- `expand-running.patch` 让运行中的思考和工具卡片自动展开；`tool-bottom-collapse.patch` 在长卡片底部提供折叠按钮；`bash-command-hscroll.patch` 保留长命令原文并让状态/复制控件固定可见。

## 持久化、技能与皮肤

- `home-cordis.patch.yml` 将 DeepSeek provider 和 pi-ai 的 `minimax-cn` provider 的重试次数声明为 5，避免依赖源码级默认值。
- `skills.nix` 合并本地 `agent/skills` 与 Anthropic 的 docx/pptx/xlsx/pdf/canvas-design、media-processor、idea-refine 以及 superpowers；技能由 `~/.dsh/skills/` 自动发现。
- `skin-center.nix` 安装包含内置皮肤集合的 skin-center，并复用 DSH 已构建的 `lightningcss`/`schemastery` 运行时依赖；不再安装已废弃的单独 Maid Whale 包。

## 维护提示

修改 `dsh.nix` 的源码 revision、`pnpm-lock.yaml` 对应依赖或 patches 后，需要重新确认 fixed-output hash，并检查 `node-pty`、loader 和模型目录补丁是否仍适配新版本。跨进程 session 的写入问题应优先通过 `durable-session-lease.patch` 的租约/revision 设计排查，而不是直接删除日志。

当前 `skills.nix` 的几个外部 `builtins.fetchGit` 使用 `main` 而未固定 `rev`/hash；这与本目录其余固定源码的可复现目标不完全一致，若追求严格复现，升级技能时应一并固定它们。
