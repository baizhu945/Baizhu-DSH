{ pkgs, lib, dsh, ... }:

let
  # zhu1090093659/dsh-web-ui @ 0e5b5a642a8f15681e9da901f1da3e524a8621bc
  skinCenterSrc = pkgs.fetchFromGitHub {
    owner = "zhu1090093659";
    repo = "dsh-web-ui";
    rev = "0e5b5a642a8f15681e9da901f1da3e524a8621bc";
    hash = "sha256-8mAkfgeZm9ZqhIAkPh5JC2/APAFpy9pkx7PRlPtTl88=";
  };

  # Upstream v0.2.2 embeds every built-in skin in skin-center itself.
  # dsh-skins is only a retired compatibility carrier and is intentionally
  # not installed.
  skinCenter = pkgs.runCommand "dsh-client-ui-skin-center" { } ''
    mkdir -p "$out"
    cp -r ${skinCenterSrc}/packages/skins/skin-center/lib "$out/"
    cp -r ${skinCenterSrc}/packages/skins/skin-center/contracts "$out/"
    cp -r ${skinCenterSrc}/packages/skins/skin-center/skins "$out/"
    cp ${skinCenterSrc}/packages/skins/skin-center/package.json "$out/package.json"
    cp ${skinCenterSrc}/packages/skins/skin-center/cordis.patch.yml "$out/cordis.patch.yml"
    cp ${skinCenterSrc}/packages/skins/skin-center/LICENSE "$out/LICENSE"
    cp ${skinCenterSrc}/packages/skins/skin-center/README.md "$out/README.md"
    cp ${skinCenterSrc}/packages/skins/skin-center/README.zh.md "$out/README.zh.md"
  '';
in
{
  # Pass the already-built dsh dependency tree to this module so the host-side
  # CSS sanitizer can reuse its pinned lightningcss native package.
  home.activation.dshSkinCenter = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
    linkRuntimeDependency() {
      target="$1"
      source="$2"
      parent="$(dirname "$target")"
      run mkdir -p "$parent"
      run chmod u+rwx "$parent"
      if [ -L "$target" ]; then
        run /run/current-system/sw/bin/remove-without-permission -f "$target"
      elif [ -e "$target" ]; then
        run chmod -R u+w "$target"
        run /run/current-system/sw/bin/remove-without-permission -rf "$target"
      fi
      run ln -s "$source" "$target"
    }

    # Remove the previous standalone Maid Whale package and its scope.
    legacy="$HOME/.dsh/profiles/web/node_modules/@dsh-external/dsh-client-ui-skin-maid-whale-webui"
    if [ -L "$legacy" ]; then
      run /run/current-system/sw/bin/remove-without-permission -f "$legacy"
    elif [ -e "$legacy" ]; then
      run chmod -R u+w "$legacy"
      run /run/current-system/sw/bin/remove-without-permission -rf "$legacy"
    fi

    dest="$HOME/.dsh/profiles/web/node_modules/@linxin666/dsh-client-ui-skin-center"
    run mkdir -p "$(dirname "$dest")"
    run chmod u+rwx "$(dirname "$dest")"
    if [ -L "$dest" ]; then
      run /run/current-system/sw/bin/remove-without-permission -f "$dest"
    elif [ -e "$dest" ]; then
      run chmod -R u+w "$dest"
      run /run/current-system/sw/bin/remove-without-permission -rf "$dest"
    fi
    run mkdir -p "$dest"
    run cp -r ${skinCenter}/. "$dest/"

    # Runtime dependencies of skin-center's host-side CSS safety pipeline.
    linkRuntimeDependency \
      "$HOME/.dsh/profiles/web/node_modules/lightningcss" \
      "${dsh}/node_modules/lightningcss"
    linkRuntimeDependency \
      "$HOME/.dsh/profiles/web/node_modules/schemastery" \
      "${dsh}/node_modules/@deepseek-ai/schemastery"
  '';
}
