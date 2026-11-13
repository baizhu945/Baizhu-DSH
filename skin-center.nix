# Import alongside dsh.nix; no frontdoor/bundle insertion and no global npm deps.
# Same-name package only. npm 0.4.18 was published from dsh-skins commit
# d55e374897232a6c3a7ee8c595de74e280e0e126 (not the dsh-web-ui umbrella).
{ config, lib, dsh, ... }:
let
  inherit (import ./environment.nix { }) pkgs;
  archive = pkgs.fetchurl {
    url = "https://registry.npmjs.org/@linxin666/dsh-client-ui-skin-center/-/dsh-client-ui-skin-center-0.4.18.tgz";
    hash = "sha256-ponAxHyZe/GoT/H30MJwuv7zHrUKXMIieEKf9nz6Q6s=";
  };
  skinCenter = pkgs.runCommand "dsh-skin-center-0.4.18" {
    nativeBuildInputs = [ pkgs.nodejs_24 ];
    passthru = { inherit archive; };
  } ''
    mkdir -p "$out"
    tar -xzf ${archive} --strip-components=1 -C "$out"
    # No npm/pnpm installation or lifecycle scripts. The two direct runtime
    # dependencies resolve privately to the SAME objects/native binary as dsh.
    mkdir -p "$out/node_modules/@deepseek-ai"
    test -d ${dsh}/node_modules/@deepseek-ai/schemastery
    test -d ${dsh}/node_modules/lightningcss
    ln -s ${dsh}/node_modules/@deepseek-ai/schemastery "$out/node_modules/@deepseek-ai/schemastery"
    ln -s ${dsh}/node_modules/lightningcss "$out/node_modules/lightningcss"
    SKIN_CENTER_PACKAGE="$out" node --input-type=module <<'JS'
    import assert from 'node:assert/strict';
    import { pathToFileURL } from 'node:url';
    const root = process.env.SKIN_CENTER_PACKAGE;
    const host = await import(pathToFileURL(root + '/lib/index.js'));
    assert.ok(host.Config);
    assert.equal(typeof host.apply, 'function');
    assert.equal(host.inject.includes('webServer'), true);
    const css = await import(pathToFileURL(root + '/lib/css-safety.js'));
    assert.equal(typeof css.transformSkinCss, 'function');
    JS
  '';
in
{
  # Accessible to the parent verification module without installing a CLI or
  # exposing plugin dependencies in the ambient profile node_modules.
  _module.args.dshSkinCenter = skinCenter;
  home.activation.dshSkinCenterCompatibility = lib.hm.dag.entryAfter [ "dshPlugins" ] ''
    # Installed-but-inactive plugin only; an absent/newer install is a no-op.
    # DSH should be stopped during this directory replacement. Complete old
    # package is retained under the profile's .skin-center-backups/ directory
    # (outside node_modules, so inventory cannot load it); no config is edited.
    run ${pkgs.nodejs_24}/bin/node ${./scripts/migrate-skin-center.mjs} \
      ${lib.escapeShellArg "${config.home.homeDirectory}/.dsh/profiles/web"} \
      ${skinCenter} ${dsh}
  '';
}
