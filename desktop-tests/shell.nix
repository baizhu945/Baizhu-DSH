# Regression tooling follows the same immutable package set as the Desktop.
let
  pkgs = import ../pinned-nixpkgs.nix { };
in
pkgs.mkShell {
  packages = [ pkgs.xvfb-run pkgs.xdotool pkgs.python3 pkgs.libx11 ];
  DSH_TEST_X11_LIBRARY = "${pkgs.libx11}/lib/libX11.so.6";
}
