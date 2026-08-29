{ pkgs, lib, ... }:

let
  # OpenAI/codex model catalog @ 6478a751fde8884b2fdc76486fe23175a8e795d4.
  # The catalog is mounted only below the Codex preset. Its base_instructions
  # and capability fields are read by codex-model-parity.mjs per request, so a
  # model switch changes the model-facing contract without touching other
  # agent presets or the host model registry.
  codexModelsSource = pkgs.fetchurl {
    url = "https://raw.githubusercontent.com/openai/codex/6478a751fde8884b2fdc76486fe23175a8e795d4/codex-rs/models-manager/models.json";
    hash = "sha256-6w17ml3K8QOJXF+KFMFrJp30bgObN1pVupf2I4VC0u0=";
  };

  # The upstream catalog exposes GPT-5.6 with a 272K base window and an
  # 872K extension cap.  DSH's pi-ai provider is configured for the full 1M
  # context, so patch the preset-owned copy too; editing ~/.dsh directly would
  # be overwritten by Home Manager on the next activation.
  codexModels = pkgs.runCommand "dsh-codex-models-gpt56-context" {
    nativeBuildInputs = [ pkgs.python3 ];
  } ''
    cp ${codexModelsSource} $out
    chmod u+w $out
    python3 ${./patches/fix-gpt56-context.py} "$out"
  '';

  # Keep the official generic Codex prompt as the fallback for model ids not
  # present in the pinned catalog. Known models use catalog instructions.
  codexPrompt = lib.concatMapStringsSep "\n" (line: "      ${line}") (
    lib.splitString "\n" (lib.removeSuffix "\n" (builtins.readFile ./codex-default-prompt.md))
  );

  # Codex's PTY backend must not assume /bin/bash: NixOS intentionally keeps
  # /bin minimal, while terminal-bash otherwise defaults to that FHS path.
  codexComposition = pkgs.replaceVars ./agent.cordis.yml {
    bashPath = "${pkgs.bashInteractive}/bin/bash";
    inherit codexPrompt;
  };

  # Keep the shell path override scoped to the Codex surface. Other dsh
  # presets continue to use their own tool definitions and shell defaults.
  codexSurface = pkgs.replaceVars ./codex-surface.mjs {
    bashPath = "${pkgs.bashInteractive}/bin/bash";
  };
in
{
  home.file = {
    ".dsh/.agent-presets/codex/agent.cordis.yml".source = codexComposition;
    ".dsh/.agent-presets/codex/preset.yml".source = ./preset.yml;
    ".dsh/.agent-presets/codex/codex-surface.mjs".source = codexSurface;
    ".dsh/.agent-presets/codex/codex-model-parity.mjs".source = ./codex-model-parity.mjs;
    ".dsh/.agent-presets/codex/codex-models.json".source = codexModels;
    ".dsh/.agent-presets/codex/codex-default-prompt.md".source = ./codex-default-prompt.md;
    ".dsh/.agent-presets/codex/codex-web-search.mjs".source = ./codex-web-search.mjs;
    ".dsh/.agent-presets/codex/codex-luna-prompt.md".source = ./codex-luna-prompt.md;
    ".dsh/.agent-presets/codex/codex-web-run-description.md".source = ./codex-web-run-description.md;
    ".dsh/.agent-presets/codex/codex-subagent-v1-description.md".source = ./codex-subagent-v1-description.md;
    ".dsh/.agent-presets/codex/codex-approval.mjs".source = ./codex-approval.mjs;
    ".dsh/.agent-presets/codex/tool-restrictions.mjs".source = ./tool-restrictions.mjs;
  };
}
