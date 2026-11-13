# Traditional (non-flake) build/check entry point; does not activate a profile.
# nix-build verification.nix -A dsh -A tui -A checks
# nix-build verification.nix -A runtimeSmoke
let
  inherit (import ./environment.nix { }) pkgs;
  hm = import <home-manager/modules> {
    inherit pkgs;
    configuration = {
      imports = [ ./dsh.nix ];
      home.username = "baizhu945";
      home.homeDirectory = "/home/baizhu945";
      home.stateVersion = "26.11";
    };
  };
  inherit (hm._module.args) dsh dshTui dshSkinCenter;
  legacySkinArchive = pkgs.fetchurl {
    url = "https://registry.npmjs.org/@linxin666/dsh-client-ui-skin-center/-/dsh-client-ui-skin-center-0.2.2.tgz";
    hash = "sha256-OhGCtEwmVf2p6OJFhWYfat+ow7aZYI+nOrt0wq+Cksg=";
  };
  legacySkin = pkgs.runCommand "dsh-skin-center-legacy-fixture" { } ''
    mkdir -p "$out"
    tar -xzf ${legacySkinArchive} --strip-components=1 -C "$out"
  '';
  skinTests = pkgs.lib.cleanSourceWith {
    src = ./.;
    filter = path: type:
      (type == "directory" && baseNameOf path != ".git")
      || builtins.elem (baseNameOf path) [ "migrate-skin-center.mjs" "skin-center-compat.test.mjs" ];
  };
  packages = hm.config.home.packages;
  launchers = pkgs.linkFarm "dsh-verification-launchers" (map (package: {
    name = package.name;
    path = package;
  }) (builtins.filter (package:
    builtins.elem package.name [ "dsh" "dsh-tui" "dst" "dsh-web" ]
  ) packages));
in
{
  inherit dsh launchers;
  tui = dshTui;
  skinCenter = dshSkinCenter;
  skinCenterChecks = pkgs.runCommand "dsh-skin-center-compat-checks" {
    nativeBuildInputs = [ pkgs.nodejs_24 ];
  } ''
    export SKIN_CENTER_PACKAGE=${legacySkin}
    export SKIN_CENTER_RELEASE=${dshSkinCenter}
    export DSH_RUNTIME_DIR=${dsh}
    export DSH_RC2_SOURCE=${dsh.src}
    node --test ${skinTests}/tests/skin-center-compat.test.mjs
    touch "$out"
  '';
  desktop = builtins.head (builtins.filter (package:
    (package.pname or "") == "dsh-desktop"
  ) packages);
  checks = pkgs.linkFarm "dsh-rea-verification-checks" (pkgs.lib.imap0 (index: path: {
    name = toString index;
    inherit path;
  }) hm.config.home.extraDependencies);
  runtimeSmoke = pkgs.runCommand "dsh-runtime-smoke" {
    nativeBuildInputs = [ pkgs.nodejs_24 pkgs.python3 pkgs.coreutils ];
  } ''
    export DSH_TELEMETRY_DISABLED=1
    export DSH_SMOKE_NETNS=1
    node ${./tests}/runtime-smoke.mjs ${dsh} ${dshTui} ${launchers}
    touch "$out"
  '';
}
