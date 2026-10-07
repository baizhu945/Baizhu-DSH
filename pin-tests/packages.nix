# Optional dry-run/build target for only DSH's launchers and retained inputs.
# No profile activation, no unpatched Codex verification baseline.
let
  inherit (import ./modules.nix) pkgs cliModule tuiModule desktopModule codexModule;
  files = cliModule.home.file // tuiModule.home.file
    // desktopModule.home.file // codexModule.home.file;
  retained = pkgs.lib.filterAttrs (name: _: pkgs.lib.hasPrefix ".local/share/dsh-nix-" name) files;
  packages = cliModule.home.packages ++ tuiModule.home.packages ++ desktopModule.home.packages;
in
pkgs.linkFarm "dsh-pinned-installation-check" (
  pkgs.lib.imap0 (index: package: {
    name = "package-${toString index}";
    path = package;
  }) packages
  ++ pkgs.lib.imap0 (index: file: {
    name = "retained-${toString index}";
    path = file.source;
  }) (builtins.attrValues retained)
)
