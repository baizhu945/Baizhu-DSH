{ pkgs }:

# Independent DSH REA package recipe. No imports or files from agent/pi.
# Nix may deduplicate the identical immutable output; this module stands alone.
let
  inherit (pkgs) lib;
  nodejs = pkgs.nodejs_24;
  revision = "a2d8b94dd50dab8d966239dd63ab84718aa8b4b4";
in
pkgs.buildNpmPackage {
  pname = "rea-agents";
  version = "6.4.0";

  src = pkgs.fetchzip {
    url = "https://github.com/morluto/rea/archive/${revision}.tar.gz";
    hash = "sha256-z9Hgl8LiXkgVmO8zyGOkXlLXPZM+jxFmeNDmHUfTJnw=";
  };
  inherit nodejs;
  # 6.4 fixes the canonical patterns upstream; do not apply the archived
  # 6.1 wire-projection patch. The live MCP JS/Rust/AJV gate remains below.
  npmDepsHash = "sha256-NNK1RLvEDF7Cj4BebTbEx5MNCEHZc2KQTmaoKmpAMYw=";

  npmRebuildFlags = [ "--ignore-scripts" ];
  env.HUSKY = "0";
  nativeBuildInputs = [ pkgs.autoPatchelfHook ];
  buildInputs = [ pkgs.stdenv.cc.cc.lib ];

  buildPhase = ''
    runHook preBuild
    # Foreign optional musl CSS variant is not loaded on this glibc host.
    autoPatchelfIgnoreMissingDeps=(libc.musl-x86_64.so.1)
    autoPatchelf node_modules
    unset autoPatchelfIgnoreMissingDeps
    node scripts/check-dependency-install.mjs
    npm run compile
    npm run artifacts:skills
    test ! -e dist/generatedMcpToolCatalog.js
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    npm prune --omit=dev --ignore-scripts
    runtime="$out/lib/rea-agents"
    mkdir -p "$runtime/scripts" "$out/bin"
    cp -r dist bridge skills third_party licenses node_modules "$runtime/"
    cp package.json package-lock.json README.md LICENSE DISCLAIMER.md \
      THIRD_PARTY_NOTICES.md install.sh "$runtime/"
    cp scripts/rea.mjs scripts/prepack.mjs scripts/prepare.mjs \
      scripts/electron-active-hook.cjs \
      scripts/electron-active-hook-boundaries.cjs scripts/hopper-demo-x11.py \
      scripts/verify-windows-native-artifact.mjs \
      "$runtime/scripts/"
    cat > "$out/bin/rea" <<EOF
#!${pkgs.runtimeShell}
export PATH="${pkgs.procps}/bin:\$PATH"
exec ${nodejs}/bin/node "$runtime/scripts/rea.mjs" "\$@"
EOF
    chmod +x "$out/bin/rea"
    ln -s rea "$out/bin/rea-agents"
    runHook postInstall
  '';
  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    export HOME="$TMPDIR/rea-install-check"
    export XDG_CONFIG_HOME="$HOME/config"
    export XDG_CACHE_HOME="$HOME/cache"
    mkdir -p "$HOME"
    env PATH=/nonexistent "$out/bin/rea" --version
    env PATH=/nonexistent "$out/bin/rea" mcp doctor --json > "$HOME/mcp-doctor.json"
    ${nodejs}/bin/node --input-type=module - "$HOME/mcp-doctor.json" <<'JS'
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    assert.equal(report.healthy, true, JSON.stringify(report));
    assert.equal(report.server.version, '6.4.0');
    assert.equal(report.inventory.tools.expected, report.inventory.tools.observed);
    assert.equal(report.inventory.tools.observed, 187);
    assert.equal(report.inventory.prompts.observed, 6);
    console.log(JSON.stringify(report));
JS
    ${nodejs}/bin/node ${./tests}/ghidra-startup-budget.mjs "$out/lib/rea-agents"
    ${nodejs}/bin/node ${./tests}/schema-portability.mjs \
      "$out/lib/rea-agents" ${pkgs.ripgrep}/bin/rg
    ${nodejs}/bin/node ${./tests}/sqlite-inspection.mjs "$out/lib/rea-agents" ${pkgs.procps}/bin
    runHook postInstallCheck
  '';
  passthru = { inherit revision nodejs; };
  meta = {
    description = "Reverse-engineering CLI and MCP server for the independent DSH REA preset";
    homepage = "https://github.com/morluto/rea";
    license = lib.licenses.mit;
    mainProgram = "rea";
    platforms = [ "x86_64-linux" ];
  };
}
