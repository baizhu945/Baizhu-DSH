{ pkgs, lib, ... }:

let
  # OpenAI/codex model catalog @ 799324821d36a822923cee7814d3b80f7ec3cf99.
  # The catalog is mounted only below the Codex preset. Its instructions_template
  # and capability fields are read by codex-model-parity.mjs per request, so a
  # model switch changes the model-facing contract without touching other
  # agent presets or the host model registry.
  # Keep this rev aligned with the reference commit recorded in agent.cordis.yml.
  codexModelsSource = pkgs.fetchurl {
    url = "https://raw.githubusercontent.com/openai/codex/799324821d36a822923cee7814d3b80f7ec3cf99/codex-rs/models-manager/models.json";
    hash = "sha256-/SGb2fBhJ4J19SiTn4L1TS65ffSyXCOwIq2+SIE9kgs=";
  };

  # The pinned catalog exposes the GPT-6 family with a 272K base window and an
  # 872K extension cap. Patch the preset-owned copy to the same 1.05M window
  # as dsh's pi-ai catalog while retaining the existing GPT-5.6 corrections;
  # editing ~/.dsh directly would be overwritten by Home Manager.
  # This widening is deliberate; the patch is the only place it is applied.
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
    ".dsh/.agent-presets/codex/codex-web-run-description.md".source = ./codex-web-run-description.md;
    ".dsh/.agent-presets/codex/codex-default-mode.md".source = ./codex-default-mode.md;
    ".dsh/.agent-presets/codex/codex-subagent-v1-description.md".source = ./codex-subagent-v1-description.md;
    ".dsh/.agent-presets/codex/codex-approval.mjs".source = ./codex-approval.mjs;
    ".dsh/.agent-presets/codex/codex-permissions.mjs".source = ./codex-permissions.mjs;
    ".dsh/.agent-presets/codex/tool-restrictions.mjs".source = ./tool-restrictions.mjs;

    # Upstream sandbox/approval prose, vendored verbatim from
    # codex-rs/prompts/templates/permissions/**. codex-surface.mjs reads these
    # as data files at preset load, so plain Home Manager symlinks are enough.
    ".dsh/.agent-presets/codex/prompts/sandbox-read-only.md".source = ./prompts/sandbox-read-only.md;
    ".dsh/.agent-presets/codex/prompts/sandbox-workspace-write.md".source = ./prompts/sandbox-workspace-write.md;
    ".dsh/.agent-presets/codex/prompts/sandbox-danger-full-access.md".source = ./prompts/sandbox-danger-full-access.md;
    ".dsh/.agent-presets/codex/prompts/approval-never.md".source = ./prompts/approval-never.md;
    ".dsh/.agent-presets/codex/prompts/approval-unless-trusted.md".source = ./prompts/approval-unless-trusted.md;
    ".dsh/.agent-presets/codex/prompts/approval-on-request.md".source = ./prompts/approval-on-request.md;
    ".dsh/.agent-presets/codex/prompts/approval-on-request-request-permissions.md".source = ./prompts/approval-on-request-request-permissions.md;
  };
}
