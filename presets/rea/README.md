# Independent REA preset

独立 DSH preset：`rea` / **REA**。它不是 Codex 模式扩展，完全不依赖 Pi 的配置。
本目录 `rea-package.nix` 自行固定 REA 6.1.0 源码 commit、npm 依赖哈希和 Node 24
构建；不运行 `rea setup`，不安装全局 command，不修改普通 PATH、AGENTS 或 skills。

## 使用

重启 DSH Web/TUI/Desktop 后，在**新会话**的 preset 选择器选择 **REA**。
TUI 可通过 `/preset` 选择；已经开始 turn 的会话按 DSH 原生规则不能改 preset，
要关闭 REA 请新建会话并选择 standard/ptc/minimal/cordis/codex 或其他非 REA preset。
默认 preset 不会被本配置改成 REA。官方 headless runner 没有 preset registry，
此配置不改变普通 headless，也不伪造其 REA preset 支持。

## Ghidra 首次分析预算

原生目标省略 `provider_id` 时默认使用 Ghidra。`open_binary` 成功只代表目标已打开；
第一次深查询才触发 **完整** auto-analysis，大型可执行文件可能需要多分钟。
分析期间不要盲目重启/重复查询，子代理不得使用 REA。

REA 6.1.0 已原生支持 `REA_GHIDRA_STARTUP_TIMEOUT_MS`（#974），已移除旧本地补丁。
upstream 用 Number 解析正安全整数（最大 `2147483647` ms）；未设置或非法值回退
`330000` ms，配置和客户端始终包含解析后的预算；保留 upstream 取消语义。
DSH REA 局部配置为 `1800000` ms（30 分钟）、`GHIDRA_HEADLESS_MAXMEM=8G`，
外层 MCP tool-call 为 `1860000` ms（31 分钟）。不修改系统 Ghidra、全局环境或
非 REA/Codex 会话；额外预算不保证大型目标一定能完成分析。

## 隔离与生命周期

- Registry 的 eager 注册只加载标准基础 composition 和无进程的 bootstrap。
- roster、冷诊断、未选择 REA 的会话不会启动 MCP，也不注册 REA prompt/tools。
- 第一次选中 REA 的实际根 Agent assembly，才在该 Agent 自有 scope 启动 MCP。
- 模型看到 138 个 `mcp__rea__*` 操作、server 指令和 Evidence/Unknown 指导。
- 父 Agent 的局部 REA scope 不被其子代理继承；原有全局 AGENTS/skills 保持不变。
- 两个 REA 根会话有独立 MCP 实例，namespace 可以相同而不会共享数据库。
- 空白会话从 REA 改成其他 preset、Agent 结束/销毁、Host unload 都撤销局部实例。
- 取消 initialize/tools-list 时先关闭谈判中的 MCP child，再等 wrapper teardown，
  防止等待自己 activation 的死锁和迟到发布。
- 只使用 Host 的同一 Cordis/SDK peer graph；Desktop 遵从原启动器的 profile anchor。

## 权限

REA MCP 本身不是 DSH sandbox 路径。公开 effects 描述中的目标修改、文件写入、
进程实验、网络/UI 操作等：Read Only 拒绝，Full Access 按明确宿主模式允许，
Confirm/Workspace Write/未知模式走宿主 approval；无应答 channel 时拒绝。
普通纯观察及 session Evidence 记账不额外问；所有 direct/PTC 调用都保留原管线。
没有 model-callable 的“切换到 REA”工具。原有 shell/任意插件代码权限不是沙箱。

## 声明落点

- `agent/dsh/rea.nix`：只导入这个 preset，runtime 与全 preset regression gate。
- `presets/rea/dsh-rea.nix`：独立包、effects、标准 composition、profile registrar
  的 additive reconcile，保留用户配置和其他默认项。
- `~/.dsh/.agent-presets/rea/`：metadata、composition、局部 runtime。
- Web/TUI 有单独 registrar；Desktop 用现有 generic preset discovery。
- Codex 任何源码、nativeConfig、native-home 都不追加 REA。

## 验证

`tests/run.mjs <dshRuntimeRoot> <installedReaPresetRoot> [realReaExe]`：实际 SDK 的
工具、完整 schema、prompt、TS/Python PTC SDK、首次请求和进程 ledger。
动态枚举全部现场非 REA preset，不只默认 standard。目前包括 standard、ptc、
minimal、cordis、codex；新发现的其他 preset 也会进入验收。

包的 install-check 执行本目录 `tests/ghidra-startup-budget.mjs <reaPackage>/lib/rea-agents`，
检查编译产物的默认/自定义/非法值回退、生产 clientFactory 实际转发及取消不启动进程。
`tests/catalog.mjs` 固定 canonical TOOL_CONTRACTS 的完整 138 名称与顺序，并检查 effects 同集。
构建正常生成 skills；运行时复制 bridge、third_party 和所需 scripts。新增 Python
providers 是可选 BYO，不代表宿主已安装 pwntools/pwndbg 或已完成真实验证。

Nix 构建包含所有非 REA absent/registered 相等、冷注册零 spawn、并行/child
隔离、blank 切回、锁定选择、失败回滚、取消、物理退出和宿主 approval gate。
独立真实验收还连接本目录构建的 REA，执行静态 JS 和真实 Ghidra/JDK 分析。
这些程序用假模型避免账单；真实分析不是 mock，不声称 138 操作逐项实机执行。
