{ pkgs, lib, ... }:

let
  # OpenAI/codex @ 76d98a771e6cd44a79a3ab895a9f7c49d27d6deb.
  # Keep the model instructions as a reviewable pinned asset, then indent them
  # only while producing the preset's YAML block scalar.
  codexPrompt = lib.concatMapStringsSep "\n" (line: "      ${line}") (
    lib.splitString "\n" (lib.removeSuffix "\n" (builtins.readFile ./codex-luna-prompt.md))
  );

  # Codex's PTY backend must not assume /bin/bash: NixOS intentionally keeps
  # /bin minimal, while terminal-bash otherwise defaults to that FHS path.
  codexComposition = pkgs.replaceVars ./agent.cordis.yml {
    bashPath = "${pkgs.bashInteractive}/bin/bash";
    inherit codexPrompt;
  };
in
{
  home.file = {
    ".dsh/.agent-presets/codex/agent.cordis.yml".source = codexComposition;
    ".dsh/.agent-presets/codex/preset.yml".source = ./preset.yml;
    ".dsh/.agent-presets/codex/codex-surface.mjs".source = ./codex-surface.mjs;
    ".dsh/.agent-presets/codex/codex-web-search.mjs".source = ./codex-web-search.mjs;
    ".dsh/.agent-presets/codex/codex-luna-prompt.md".source = ./codex-luna-prompt.md;
    ".dsh/.agent-presets/codex/codex-web-run-description.md".source = ./codex-web-run-description.md;
    ".dsh/.agent-presets/codex/codex-subagent-v1-description.md".source = ./codex-subagent-v1-description.md;
    ".dsh/.agent-presets/codex/codex-approval.mjs".source = ./codex-approval.mjs;
    ".dsh/.agent-presets/codex/tool-restrictions.mjs".source = ./tool-restrictions.mjs;
  };
}
