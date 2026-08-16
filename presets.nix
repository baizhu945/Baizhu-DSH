{ pkgs, ... }:

let
  # agent preset:dsh-anchored-standard(xiaobright,社区实验性 preset)
  # Anchored Standard:首次请求用 Minimal 对齐的双工具目录(不注入工作区/技能
  # 上下文),会话出现首次持久晋升信号(tool/call 或 assistant/message)后开放
  # 完整 Standard 工具目录。固定 rev 而非分支;hash 由 nix-prefetch-url --unpack 计算。
  # dshPresetSrc = builtins.fetchGit {
    # url = "https://github.com/xiaobright/dsh-anchored-standard.git";
    # ref = "main";
  # };
  dshPresetSrc = pkgs.fetchFromGitHub {
    owner = "xiaobright";
    repo = "dsh-anchored-standard";
    rev = "6472c1c9431dcfd9072be23bff781b76fe7146c0";
    hash = "sha256-R+QCRXtB16fObeVTpz6aXPabGAkWtl/mR+hvW7dNmAw=";
  };

  # agent preset:dsh-router-standard(yjh051108/dsh-routing-suite 的 preset 组件,
  # 只装 router-standard / router-spec 两个会话预设,不装 injector 与 mode-boost)。
  # Router Standard:首轮 RL 接口还原(RL 训练句 + bash/str_replace_editor),
  # 首次工具调用后放开完整 Standard 目录;Router Spec:按任务分类注入
  # persona + 首轮核心工具集,深度思考优先。两预设均由会话事件推导模式,
  # resume/reload 不丢状态;plan-mode section 保留。MIT,NOTICE 见上游仓库。
  # 固定 rev(子模块 pin,对应上游 tag v0.2.0);hash 由
  # nix-prefetch-url --unpack .../archive/<rev>.tar.gz 计算。
  routerPresetSrc = pkgs.fetchFromGitHub {
    owner = "yjh051108";
    repo = "dsh-router-standard";
    rev = "eff787e95132d6c7104214542104a84d656b497e";
    hash = "sha256-+sa3WYSXJe9lomRgYAfZQoTBiBNMwF4nf/iEXVqROpU=";
  };
in
{
  # 所有 agent preset 的统一声明(从 dsh.nix 拆出):
  # - anchored-standard:默认预设,来自 xiaobright/dsh-anchored-standard;
  # - router-standard / router-spec:yjh051108/dsh-routing-suite 的 preset 组件。
  # liangshen 不在此处管理:它由 @linxin666/dsh-liangshen 插件在 dsh 启动时
  # 同步进 ~/.dsh/.agent-presets(见 web-ui.nix)。
  home.file = {
    # vision subagent 已移除:直接安装上游纯净 preset。
    ".dsh/.agent-presets/anchored-standard" = {
      source = "${dshPresetSrc}/preset";
      recursive = true;
    };

    # dsh-routing-suite 的 preset 组件:分别安装两个会话预设
    # (注意必须各放到 <id>/ 直接子目录,preset 发现只扫描一层)。
    # 逐个文件声明而非整目录 recursive,因为上游 preset.yml 的 description
    # 未加引号,内部 `: ` 会被 dsh 的 js-yaml 判为非法 YAML → 元数据解析
    # 静默降级,GUI 只显示裸 id。这里用 .text 覆写为合法 YAML 修复显示名。
    ".dsh/.agent-presets/router-standard/agent.cordis.yml" = {
      source = "${routerPresetSrc}/preset/router-standard/agent.cordis.yml";
    };
    ".dsh/.agent-presets/router-standard/router-bootstrap.mjs" = {
      source = "${routerPresetSrc}/preset/router-standard/router-bootstrap.mjs";
    };
    ".dsh/.agent-presets/router-standard/router-bootstrap-v1.mjs" = {
      source = "${routerPresetSrc}/preset/router-standard/router-bootstrap-v1.mjs";
    };
    ".dsh/.agent-presets/router-standard/router-core.mjs" = {
      source = "${routerPresetSrc}/preset/router-standard/router-core.mjs";
    };
    ".dsh/.agent-presets/router-standard/preset.yml" = {
      text = "name: Router Standard (experimental)\ndescription: 'Task-aware routing — RL-interface restoration: one-sentence persona + shell/editor surface; think-act feedback loops. Full Standard tools after the first tool call.'\n";
    };

    ".dsh/.agent-presets/router-spec/agent.cordis.yml" = {
      source = "${routerPresetSrc}/preset/router-spec/agent.cordis.yml";
    };
    ".dsh/.agent-presets/router-spec/router-bootstrap.mjs" = {
      source = "${routerPresetSrc}/preset/router-spec/router-bootstrap.mjs";
    };
    ".dsh/.agent-presets/router-spec/router-bootstrap-v1.mjs" = {
      source = "${routerPresetSrc}/preset/router-spec/router-bootstrap-v1.mjs";
    };
    ".dsh/.agent-presets/router-spec/router-core.mjs" = {
      source = "${routerPresetSrc}/preset/router-spec/router-core.mjs";
    };
    ".dsh/.agent-presets/router-spec/preset.yml" = {
      text = "name: Router Spec (experimental)\ndescription: 'Task-aware routing — deep-think-first (spec): classified persona + full prompt sections; the long first-turn reasoning chain is the point. Full Standard tools after the first tool call.'\n";
    };
  };
}
