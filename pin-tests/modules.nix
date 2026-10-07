# Evaluate just these modules, without the rest of the user's configuration.
# Ambient pkgs are poisoned; HM contributes only its activation DAG API.
let
  pkgs = import ../pinned-nixpkgs.nix { };
  moduleArgs = {
    config = { };
    pkgs = throw "DSH must not consume the ambient channel package set";
    lib.hm.dag.entryAfter = after: data: { inherit after data; };
  };
  cliModule = import ../dsh.nix (moduleArgs // {
    dshTui = tuiModule._module.args.dshTui;
  });
  tuiModule = import ../tui.nix moduleArgs;
  desktopModule = import ../desktop.nix (moduleArgs // {
    dsh = cliModule._module.args.dsh;
  });
  codexModule = import ../presets/codex/dsh-codex.nix moduleArgs;
in
{
  inherit pkgs cliModule tuiModule desktopModule codexModule;
}
