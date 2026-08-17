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
in
{
  home.file = {
    # vision subagent 已移除:直接安装上游纯净 preset。
    ".dsh/.agent-presets/anchored-standard" = {
      source = "${dshPresetSrc}/preset";
      recursive = true;
    };
  };
}
