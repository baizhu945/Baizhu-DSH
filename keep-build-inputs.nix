# A Home Manager reference to this link farm keeps build-only materials and
# tools alive across GC. Retain actual outputs, not just .drv files (which do
# not keep their input outputs alive with Nix's default keep-outputs = false).
{ pkgs, name, packages, extraInputs ? [ ] }:
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
}) paths)
