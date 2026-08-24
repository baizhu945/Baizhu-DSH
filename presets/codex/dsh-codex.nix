{ pkgs, lib, ... }:

let
  # OpenAI/codex model catalog @ 339751715c64496cb86246bfb3935f40e309dd3d.
  # The catalog is mounted only below the Codex preset. Its base_instructions
  # and capability fields are read by codex-model-parity.mjs per request, so a
  # model switch changes the model-facing contract without touching other
  # agent presets or the host model registry.
  codexModels = pkgs.fetchurl {
    url = "https://raw.githubusercontent.com/openai/codex/339751715c64496cb86246bfb3935f40e309dd3d/codex-rs/models-manager/models.json";
    hash = "sha256-6w17ml3K8QOJXF+KFMFrJp30bgObN1pVupf2I4VC0u0=";
  };

  # Keep the Luna prompt as a local fallback for model ids not present in the
  # pinned official catalog (for example a provider-local preview model).
  # Known official models use their catalog-provided base_instructions instead.
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
    ".dsh/.agent-presets/codex/codex-model-parity.mjs".source = ./codex-model-parity.mjs;
    ".dsh/.agent-presets/codex/codex-models.json".source = codexModels;
    ".dsh/.agent-presets/codex/codex-web-search.mjs".source = ./codex-web-search.mjs;
    ".dsh/.agent-presets/codex/codex-luna-prompt.md".source = ./codex-luna-prompt.md;
    ".dsh/.agent-presets/codex/codex-web-run-description.md".source = ./codex-web-run-description.md;
    ".dsh/.agent-presets/codex/codex-subagent-v1-description.md".source = ./codex-subagent-v1-description.md;
    ".dsh/.agent-presets/codex/codex-approval.mjs".source = ./codex-approval.mjs;
    ".dsh/.agent-presets/codex/tool-restrictions.mjs".source = ./tool-restrictions.mjs;
  };
}
