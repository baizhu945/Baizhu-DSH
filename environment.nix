# Shared DSH build/runtime environment. Import once per surface and inherit
# pkgs, runtimePath and/or keepBuildInputs as needed.
{ }:
let
  # Private, complete package-set pin for every pinned DSH surface. Do not
  # import <nixpkgs> or inherit the caller's config/overlays: both follow channels.
  # Pin the main package set and use the 26.05 Node 24.22.1 build: REA 6.8.0
  # requires that release line (24.21 lacks native DatabaseSync.limits), while
  # dsh 0.2.2 requires Node >=24.9. Node 22.23.4 remains available for REA's
  # alternate supported runtime range.
  source = builtins.fetchTarball {
    url = "https://github.com/NixOS/nixpkgs/archive/1d060086d60cb76a40cf37109f979d88a5bd6396.tar.gz";
    sha256 = "0br4sv8vf37pbasihv20kq62cmpxl925x4q40i5nghfvmg07a2ld";
  };
  node24Source = builtins.fetchTarball {
    url = "https://github.com/NixOS/nixpkgs/archive/7dcdd87373d72e7a2173e4db02e20d3d7f495cfd.tar.gz";
    sha256 = "09f5ys7xly8gaip09yxpp1xawqm4dlzrjq0ib8x80y9wsdpnp2xl";
  };
  node24Pkgs = import node24Source {
    system = "x86_64-linux";
    overlays = [ ];
    config = { allowUnfree = true; cudaSupport = true; };
  };
  pkgs = import source {
    system = "x86_64-linux";
    overlays = [ (final: prev: {
      nodejs_24 = node24Pkgs.nodejs_24;
      # Nix's npm dependency prefetch uses libcurl over HTTP/2, which fails through
      # this host's Clash tunnel. Limit the prefetch helper to HTTP/1.1; runtime
      # Node/fetch behavior and the project package sources are untouched.
      prefetch-npm-deps = prev.prefetch-npm-deps.overrideAttrs (old: {
        src = prev.applyPatches {
          name = "prefetch-npm-deps-http11-source";
          src = old.src;
          patches = [ ./patches/prefetch-npm-deps-http1.patch ];
        };
      });
    }) ];
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
    pkgs.nodejs_24
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
