{ pkgs, ... }:

let
  # Codex's PTY backend must not assume /bin/bash: NixOS intentionally keeps
  # /bin minimal, while terminal-bash otherwise defaults to that FHS path.
  codexComposition = pkgs.replaceVars ./codex/agent.cordis.yml {
    bashPath = "${pkgs.bashInteractive}/bin/bash";
  };
in
{
  home.file = {
    ".dsh/.agent-presets/codex/agent.cordis.yml".source = codexComposition;
    ".dsh/.agent-presets/codex/preset.yml".source = ./codex/preset.yml;
    ".dsh/.agent-presets/codex/codex-surface.mjs".source = ./codex/codex-surface.mjs;
    ".dsh/.agent-presets/codex/codex-approval.mjs".source = ./codex/codex-approval.mjs;
    ".dsh/.agent-presets/codex/tool-restrictions.mjs".source = ./codex/tool-restrictions.mjs;
  };
}
