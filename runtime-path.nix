# Private PATH instead of exporting frozen generic tools into home.packages.
# This avoids collisions with newer channel packages while keeping DSH's
# subprocesses on its own Node/pnpm and sandbox/search tools.
{ pkgs }:
pkgs.lib.makeBinPath [
  pkgs.bashInteractive
  pkgs.coreutils
  pkgs.findutils
  pkgs.gnugrep
  pkgs.gnused
  pkgs.git
  pkgs.nodejs_22
  pkgs.pnpm_11
  pkgs.ripgrep
  pkgs.bubblewrap
  pkgs.curl
]
