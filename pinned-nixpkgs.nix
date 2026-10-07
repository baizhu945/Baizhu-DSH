# Private, complete package-set pin for every DSH surface. Do not import
# <nixpkgs> or inherit the caller's config/overlays here: both follow channels.
# This immutable release archive is the exact package set used on 2026-10-06.
{ }:
let
  source = builtins.fetchTarball {
    url = "https://releases.nixos.org/nixos/unstable/nixos-26.11pre1085777.494ce7fd23ff/nixexprs.tar.xz";
    sha256 = "02inprq5g2hlmrrbrfapy117d32mdam6vmfrrl3a7jp2n2xsknqb";
  };
in
import source {
  system = "x86_64-linux";
  overlays = [ ];
  config = {
    allowUnfree = true;
    # Preserve the existing package variants without inheriting ambient config.
    cudaSupport = true;
  };
}
