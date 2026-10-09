{ config, pkgs, lib, dsh, ... }:

let
  runtimeSource = lib.cleanSourceWith {
    src = ./presets/rea;
    filter = path: type: type == "directory"
      || baseNameOf path == "rea-runtime.mjs";
  };
  runtime = pkgs.stdenvNoCC.mkDerivation {
    pname = "dsh-rea-session-runtime";
    version = "1.0.0";
    src = runtimeSource;
    nativeBuildInputs = [ pkgs.nodejs_22 ];
    dontConfigure = true;
    buildPhase = ''
      runHook preBuild
      node --check rea-runtime.mjs
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p "$out"
      cp rea-runtime.mjs "$out/"
      runHook postInstall
    '';
  };
  relativeTarget = file: lib.removePrefix "${config.home.homeDirectory}/" file.target;
  presetFiles = lib.filterAttrs (_name: file:
    lib.hasPrefix ".dsh/.agent-presets/" (relativeTarget file)
  ) config.home.file;
  presetFixture = pkgs.linkFarm "dsh-rea-declared-presets" (
    lib.mapAttrsToList (_name: file: {
      name = lib.removePrefix ".dsh/.agent-presets/" (relativeTarget file);
      path = file.source;
    }) presetFiles ++ [ { name = "rea/runtime"; path = runtime; } ]
  );
  testSources = lib.cleanSourceWith {
    src = ./presets/rea/tests;
    filter = path: type: type == "directory" || lib.hasSuffix ".mjs" path;
  };
  frontendSources = pkgs.linkFarm "dsh-rea-frontend-regression-sources" [
    { name = "scripts/register-desktop-presets.mjs"; path = ./scripts/register-desktop-presets.mjs; }
    { name = "presets/rea/rea-registrar.mjs"; path = ./presets/rea/rea-registrar.mjs; }
    { name = "presets/rea/dsh-rea.nix"; path = ./presets/rea/dsh-rea.nix; }
  ];
  checks = pkgs.runCommand "dsh-rea-all-preset-regressions" {
    nativeBuildInputs = [ pkgs.nodejs_22 pkgs.coreutils ];
  } ''
    export DSH_TELEMETRY_DISABLED=1
    export DSH_REA_PRESETS_ROOT=${presetFixture}
    export DSH_REA_SOURCE_ROOT=${frontendSources}
    export DSH_REA_PROFILES_ROOT="$TMPDIR/empty-profiles"
    mkdir -p "$DSH_REA_PROFILES_ROOT"
    cp -R ${testSources} "$TMPDIR/dsh-rea-tests"
    chmod -R u+w "$TMPDIR/dsh-rea-tests"
    ${pkgs.nodejs_22}/bin/node "$TMPDIR/dsh-rea-tests/run.mjs" \
      ${dsh} ${presetFixture}/rea
    touch "$out"
  '';
in
{
  imports = [ ./presets/rea/dsh-rea.nix ];
  _module.args.dshReaRuntime = runtime;
  home.extraDependencies = [ checks ];
}
