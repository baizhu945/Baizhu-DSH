{ pkgs, lib, ... }:

let
  # The runtime and catalog share immutable official release source. This is a private
  # dependency of this preset, not a pkgs overlay or a global Codex upgrade.
  codexRuntime = import ./codex-runtime.nix { inherit pkgs lib; };
  codexRevision = codexRuntime.rev;
  codexModelsSource = pkgs.fetchurl {
    url = "https://raw.githubusercontent.com/openai/codex/${codexRevision}/codex-rs/models-manager/models.json";
    hash = "sha256-/SGb2fBhJ4J19SiTn4L1TS65ffSyXCOwIq2+SIE9kgs=";
  };

  # The pinned catalog exposes the GPT-6 family with a 272K base window and an
  # 872K extension cap. Patch the preset-owned copy to the same 1.05M window
  # as dsh's pi-ai catalog while retaining the existing GPT-5.6 corrections;
  # editing ~/.dsh directly would be overwritten by Home Manager.
  # This reference artifact retains the user's exact widening. The private
  # native core applies the same two-field exception to live/bundled metadata.
  codexModels = pkgs.runCommand "dsh-codex-models-gpt56-context" {
    nativeBuildInputs = [ pkgs.python3 ];
  } ''
    cp ${codexModelsSource} $out
    chmod u+w $out
    python3 ${./patches/fix-gpt56-context.py} "$out"
  '';

  codexComposition = pkgs.replaceVars ./agent.cordis.yml {
    codexBinary = "${codexRuntime}/bin/codex";
    inherit codexRevision;
    codexRuntimeVersion = codexRuntime.runtimeVersion;
  };

  # Bundle relative ESM imports together. Individually sourced Home Manager
  # files realpath into separate /nix/store files and lose adjacent imports.
  codexNative = pkgs.runCommand "dsh-codex-native-${builtins.substring 0 7 codexRevision}" {} ''
    mkdir -p $out
    cp ${./codex-native.mjs} $out/codex-native.mjs
    cp ${./codex-app-server.mjs} $out/codex-app-server.mjs
    cp ${./codex-native-auth.mjs} $out/codex-native-auth.mjs
    cp ${./codex-native-observation.mjs} $out/codex-native-observation.mjs
    cp ${./codex-native-usage.mjs} $out/codex-native-usage.mjs
    cp ${./native-input-admission.mjs} $out/native-input-admission.mjs
    cp ${./codex-native-interaction.mjs} $out/codex-native-interaction.mjs
    cp ${./codex-native-presentation.mjs} $out/codex-native-presentation.mjs
  '';

  # Retain the inactive compatibility files for legacy tests/reference only.
  # They are not mounted by agent.cordis.yml and cannot alter native requests.
  codexSurface = pkgs.replaceVars ./codex-surface.mjs {
    bashPath = "${pkgs.bashInteractive}/bin/bash";
  };
in
{
  home.file = {
    ".dsh/.agent-presets/codex/agent.cordis.yml".source = codexComposition;
    ".dsh/.agent-presets/codex/preset.yml".source = ./preset.yml;
    ".dsh/.agent-presets/codex/native".source = codexNative;
    ".dsh/.agent-presets/codex/bin/codex".source = "${codexRuntime}/bin/codex";
    ".dsh/.agent-presets/codex/bin/codex-code-mode-host".source = "${codexRuntime}/bin/codex-code-mode-host";
    ".dsh/.agent-presets/codex/README.md".source = ./README.md;
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
