# Shared DSH build/runtime environment. Import once per surface and inherit
# pkgs, runtimePath and/or keepBuildInputs as needed.
{ }:
let
  # Private, complete package-set pin for every pinned DSH surface. Do not
  # import <nixpkgs> or inherit the caller's config/overlays: both follow channels.
  # This immutable release archive is the exact package set used on 2026-10-06.
  source = builtins.fetchTarball {
    url = "https://releases.nixos.org/nixos/unstable/nixos-26.11pre1085777.494ce7fd23ff/nixexprs.tar.xz";
    sha256 = "02inprq5g2hlmrrbrfapy117d32mdam6vmfrrl3a7jp2n2xsknqb";
  };
  pkgs = import source {
    system = "x86_64-linux";
    overlays = [ ];
    config = {
      allowUnfree = true;
      # Preserve the existing package variants without inheriting ambient config.
      cudaSupport = true;
    };
  };

  # Private PATH instead of exporting frozen generic tools into home.packages.
  # This avoids collisions with newer channel packages while keeping DSH's
  # subprocesses on its own Node/pnpm and sandbox/search tools.
  runtimePath = pkgs.lib.makeBinPath [
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
  ];

  # A Home Manager reference to this link farm keeps build-only materials and
  # tools alive across GC. Retain actual outputs, not just .drv files (which do
  # not keep their input outputs alive with Nix's default keep-outputs = false).
  # Accept pkgs explicitly: REA retains inputs from its own caller's package set.
  keepBuildInputs = { pkgs, name, packages, extraInputs ? [ ] }:
    let
      inputsFor = package:
        [ package package.stdenv ]
        ++ pkgs.lib.optional (package ? src) package.src
        ++ pkgs.lib.optional (package ? cargoDeps) package.cargoDeps
        ++ (package.nativeBuildInputs or [ ])
        ++ (package.buildInputs or [ ])
        ++ (package.propagatedNativeBuildInputs or [ ])
        ++ (package.propagatedBuildInputs or [ ])
        ++ (package.buildSources or [ ]);
      # Build dependencies can select dev/bin instead of their default output.
      # Retain those standard outputs explicitly, without pulling unused docs or
      # debug outputs into this closure. Preserve explicitly selected paths too.
      outputsFor = input:
        [ input ] ++ pkgs.lib.optionals (pkgs.lib.isDerivation input) (
          map (output: input.${output}) (builtins.filter
            (output: builtins.hasAttr output input) [ "out" "bin" "dev" "lib" ])
        );
      paths = pkgs.lib.unique (map toString (pkgs.lib.concatMap outputsFor (
        extraInputs ++ pkgs.lib.concatMap inputsFor packages
      )));
    in
    pkgs.linkFarm "${name}-retained-build-inputs" (pkgs.lib.imap0 (index: path: {
      name = "${toString index}-${builtins.unsafeDiscardStringContext (builtins.baseNameOf path)}";
      inherit path;
    }) paths);
in
{
  inherit pkgs runtimePath keepBuildInputs;
}
