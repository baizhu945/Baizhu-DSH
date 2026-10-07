# Evaluation-only regression: every package/helper must come from the pin.
let
  inherit (import ./modules.nix) pkgs cliModule tuiModule desktopModule codexModule;
  cli = cliModule._module.args.dsh;
  tui = tuiModule._module.args.dshTui;
  desktop = builtins.head desktopModule.home.packages;
  codex = import ../presets/codex/codex-runtime.nix { };
  files = cliModule.home.file // tuiModule.home.file
    // desktopModule.home.file // codexModule.home.file;
  retained = pkgs.lib.filterAttrs (name: _: pkgs.lib.hasPrefix ".local/share/dsh-nix-" name) files;
in
assert codexModule.home.file.".dsh/.agent-presets/codex/bin/codex".source == "${codex}/bin/codex";
{
  nixpkgsSource = toString pkgs.path;
  versions = {
    node = pkgs.nodejs_22.version;
    pnpm = pkgs.pnpm_11.version;
    nodeGyp = pkgs.node-gyp.version;
    python = pkgs.python3.version;
    rust = pkgs.rustc.version;
    electron = pkgs.electron_44.version;
  };
  derivations = {
    cli = cli.drvPath;
    cliLauncher = (builtins.head cliModule.home.packages).drvPath;
    webLauncher = (builtins.elemAt cliModule.home.packages 1).drvPath;
    tui = tui.drvPath;
    tuiLaunchers = map (package: package.drvPath) tuiModule.home.packages;
    desktop = desktop.drvPath;
    desktopRuntime = desktop.dshDesktopRuntime.drvPath;
    primaryPayload = desktop.dshDesktopPrimaryPayload.drvPath;
    codex = codex.drvPath;
    codexModels = codexModule.home.file.".dsh/.agent-presets/codex/codex-models.json".source.drvPath;
    codexNative = codexModule.home.file.".dsh/.agent-presets/codex/native".source.drvPath;
  };
  retainedInputs = builtins.mapAttrs (_: file: toString file.source) retained;
}
