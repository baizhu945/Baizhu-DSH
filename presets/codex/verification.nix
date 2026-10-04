{ pkgs ? import <nixpkgs> {} }:
let
  runtime = import ./codex-runtime.nix { inherit pkgs; };
  # Independent upstream baseline: identical source/dependencies, without the
  # explicitly permitted context-only patch. No global package is replaced.
  baseline = runtime.overrideAttrs (_: { patches = []; });
  contextCatalog = pkgs.runCommand "codex-preset-verification-catalog" {
    nativeBuildInputs = [ pkgs.python3 ];
  } ''
    cp ${runtime.src}/codex-rs/models-manager/models.json $out
    chmod u+w $out
    python3 ${./patches/fix-gpt56-context.py} $out
  '';
in pkgs.writeText "codex-preset-verification-inputs.json" (builtins.toJSON {
  inherit (runtime) rev runtimeVersion;
  binary = "${runtime}/bin/codex";
  baselineBinary = "${baseline}/bin/codex";
  source = "${runtime.src}";
  officialCatalog = "${runtime.src}/codex-rs/models-manager/models.json";
  manualCatalog = "${contextCatalog}";
  rustc = "${pkgs.rustc}/bin/rustc";
  python = "${pkgs.python3}/bin/python3";
  node = "${pkgs.nodejs_22}/bin/node";
})
