{ config, pkgs, lib, ... }:

let
  # Keep the TUI and its vendored std dependency on immutable commits.  The
  # submodules are materialized below because GitHub source archives contain
  # only empty submodule directories.
  dshTuiVersion = "0.10.0";
  dshTuiSrc = pkgs.fetchFromGitHub {
    owner = "baizhu945";
    repo = "dsh-TUI";
    rev = "86d183884012421daa6d8035e26f3cf46be5584e";
    hash = "sha256-wiImdXn20drwu69vll61Ib1JOjmL1IbOKwgaP8XLsvY=";
  };

  dshEcosystemSpecSrc = pkgs.fetchFromGitHub {
    owner = "T-Auto";
    repo = "dsh-ecosystem-spec";
    rev = "d28c267fe7fd775428ec2dccd65b0b7efd4dacee";
    hash = "sha256-hhp/UUMo2engw0SyrB0Gq6Xc6BUYgvEmYh0F4OBdZEw=";
  };

  dshStdSrc = pkgs.fetchFromGitHub {
    owner = "Yan-Zero";
    repo = "dsh-std";
    rev = "614dfa1ac168db79fcf4577cf0ebb34e2e3b944b";
    hash = "sha256-aJEykWAXEKTUsNte51+ZEhFAgLT6QNNplNZTNPhgb00=";
  };

  sourceWithSubmodules = pkgs.runCommand "dsh-tui-${dshTuiVersion}-source" { } ''
    mkdir -p $out
    cp -r ${dshTuiSrc}/. $out/
    chmod -R u+w $out
    mkdir -p $out/dsh-ecosystem-spec $out/vendor/dsh-std
    cp -r ${dshEcosystemSpecSrc}/. $out/dsh-ecosystem-spec/
    cp -r ${dshStdSrc}/. $out/vendor/dsh-std/
  '';

  fetchPnpmDepsArgs = {
    fetcherVersion = 4;
    prePnpmInstall = ''
      export NIX_NPM_REGISTRY=https://registry.npmmirror.com
      pnpm config set fetch-timeout 600000
      pnpm config set fetch-retries 5
      pnpm config set network-concurrency 4
    '';
  };

  dshStdPnpmDeps = pkgs.fetchPnpmDeps (fetchPnpmDepsArgs // {
    pname = "dsh-std";
    src = dshStdSrc;
    hash = "sha256-6b+GkosWdqzXbYypLghuCpB6ioMSdA4Jcr9XUs5XNX8=";
  });

  dshTuiPnpmDeps = pkgs.fetchPnpmDeps (fetchPnpmDepsArgs // {
    pname = "dsh-tui";
    src = sourceWithSubmodules;
    hash = "sha256-CBqN0QBDs8ZPd+TDztjwFAJSPxw7WtdegEZ8MIWGNLE=";
  });

  dshTui = pkgs.stdenv.mkDerivation {
    pname = "dsh-tui";
    version = dshTuiVersion;
    src = sourceWithSubmodules;
    pnpmDeps = dshTuiPnpmDeps;

    nativeBuildInputs = [
      pkgs.nodejs_22
      pkgs.pnpm_11
      pkgs.pnpmConfigHook
      pkgs.sqlite
      pkgs.typescript
    ];

    __structuredAttrs = true;
    strictDeps = true;
    pnpmInstallFlags = [ "--frozen-lockfile" "--shamefully-hoist" ];

    postPatch = ''
      # The hoisted layout is intentional: the installed plugin must share
      # the dsh installation's Cordis and Harness peer instances.
      echo 'verifyDepsBeforeRun: false' >> pnpm-workspace.yaml
    '';

    preBuild = ''
      export HOME=$TMPDIR
      export CI=true
      root=$PWD

      restorePnpmStore() {
        archive="$1"
        store="$2"
        mkdir -p "$store"
        tar --zstd -xf "$archive/pnpm-store.tar.zst" -C "$store"
        chmod -R u+rwX "$store"
        if [ -f "$store/v11/index.db.sql" ]; then
          sqlite3 "$store/v11/index.db" < "$store/v11/index.db.sql"
          node -e 'require("node:fs").rmSync(process.argv[1], { force: true })' \
            "$store/v11/index.db.sql"
        fi
      }

      stdStore=$TMPDIR/dsh-std-store
      restorePnpmStore ${dshStdPnpmDeps} "$stdStore"

      (
        cd "$root/vendor/dsh-std"
        pnpm --offline --store-dir "$stdStore" \
          --config.confirmModulesPurge=false \
          install --ignore-scripts --frozen-lockfile
      )
    '';

    buildPhase = ''
      runHook preBuild
      root=$PWD

      for package in core manifest connection presentation command storage messages; do
        packageDir="$root/vendor/dsh-std/packages/$package"
        (
          cd "$packageDir"
          "$root/vendor/dsh-std/node_modules/.bin/tsdown"
        )
      done

      node scripts/clean-lib.mjs
      "$root/node_modules/.bin/tsc" -p tsconfig.json
      runHook postBuild
    '';

    installPhase = ''
      # Keep the root package's production dependency closure.  Harness peer
      # packages deliberately remain outside it and are supplied by dsh's
      # shared profiles/node_modules fallback at runtime.
      node --input-type=module - <<'NODE'
      import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
      import { execFileSync } from 'node:child_process'
      import { dirname, join, resolve } from 'node:path'

      const root = process.cwd()
      const nodeModules = join(root, 'node_modules')
      const stagedNodeModules = join(root, '.runtime-node_modules')
      execFileSync('cp', ['-rL', nodeModules, stagedNodeModules], { stdio: 'inherit' })
      rmSync(nodeModules, { recursive: true, force: true })
      renameSync(stagedNodeModules, nodeModules)

      const keep = new Set()
      const visited = new Set()
      const readPackage = dir => {
        try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) }
        catch { return null }
      }
      const resolveDependency = (from, name) => {
        let dir = from
        while (true) {
          const candidate = join(dir, 'node_modules', ...name.split('/'))
          if (existsSync(join(candidate, 'package.json'))) return candidate
          const parent = dirname(dir)
          if (parent === dir) return null
          dir = parent
        }
      }
      const visit = dir => {
        if (!dir || visited.has(dir)) return
        const pkg = readPackage(dir)
        if (!pkg) return
        visited.add(dir)
        keep.add(resolve(dir))
        for (const field of ['dependencies', 'optionalDependencies']) {
          for (const name of Object.keys(pkg[field] ?? {})) {
            const dependency = resolveDependency(dir, name)
            if (dependency) visit(dependency)
          }
        }
      }
      visit(root)

      for (const entry of readdirSync(nodeModules)) {
        if (entry.startsWith('.')) continue
        const entryPath = join(nodeModules, entry)
        if (entry.startsWith('@')) {
          for (const child of readdirSync(entryPath)) {
            const childPath = join(entryPath, child)
            if (!keep.has(resolve(childPath))) rmSync(childPath, { recursive: true, force: true })
          }
          if (readdirSync(entryPath).length === 0) rmSync(entryPath, { recursive: true, force: true })
        } else if (!keep.has(resolve(entryPath))) {
          rmSync(entryPath, { recursive: true, force: true })
        }
      }
      for (const metadata of ['.pnpm', '.package-map.json', '.modules.yaml', '.pnpm-workspace-state-v1.json']) {
        rmSync(join(nodeModules, metadata), { recursive: true, force: true })
      }
      NODE

      mkdir -p $out/package
      cp -r bin lib cordis.patch.yml cordis.yml dsh-ecosystem-spec presets package.json $out/package/
      cp -rL node_modules $out/node_modules
    '';

    dontFixup = true;
  };

  dshTuiProfileManifest = pkgs.writeText "dsh-tui-profile-package.json" (builtins.toJSON {
    name = "dsh-profile-dsh-tui";
    private = true;
    dependencies = {
      "@deepseek-harness-tui/dsh-tui" = "file:${dshTui}/package";
    };
    dsh.profile = {
      bundles = [ "@deepseek-ai/dsh-base" "@deepseek-harness-tui/dsh-tui" ];
      patchReload = "live";
    };
  });

  dshTuiProfileEmptyPatch = pkgs.writeText "dsh-tui-profile-empty-cordis.patch.yml" "[]\n";
  dshTuiProfilePatch = pkgs.writeText "dsh-tui-profile-cordis.patch.yml" ''
    # The TUI profile is intentionally aligned with the user's Web profile:
    # `confirm` gives full access while the local plugin asks before every
    # write/execute tool. This is profile configuration, not a TUI package
    # default, so deployments without it keep DSH's three stock presets.
    - insert:
        - id: confirm-writes
          name: './plugins/confirm-writes.mjs'
          config:
            preset: confirm
            askTools:
              - write
              - edit
              - str_replace_editor
              - bash
              - pwsh
              - terminal_send

    - id: permission
      config:
        defaultPreset: confirm
        presets:
          read-only:
            sandbox: read-only
            approval: ask
          workspace-write:
            sandbox: workspace-write
            approval: ask
          danger-full-access:
            sandbox: danger-full-access
            approval: never
          confirm:
            sandbox: danger-full-access
            approval: ask
            name: Confirm (ask)
            description: Full access, but every write and command asks for your approval
  '';
  dshTuiProfileWorkspace = pkgs.writeText "dsh-tui-profile-pnpm-workspace.yaml" ''
    packages:
      - .
    nodeLinker: hoisted
    autoInstallPeers: false
  '';

  dshTuiManagedMarker = pkgs.writeText "dsh-tui-managed" ''
    home-manager
    @deepseek-harness-tui/dsh-tui
  '';

  dshTuiLauncher = pkgs.writeShellScriptBin "dsh-tui" ''
    exec ${pkgs.nodejs_22}/bin/node ${dshTui}/package/bin/dsh-tui.js "$@"
  '';

  dstLauncher = pkgs.writeShellScriptBin "dst" ''
    exec ${pkgs.nodejs_22}/bin/node ${dshTui}/package/bin/dsh-tui.js "$@"
  '';
in
{
  home.packages = [
    dshTuiLauncher
    dstLauncher
  ];

  # This is a real file deployment rather than a home.file symlink.  The TUI
  # bundle imports peer packages by bare ESM names and therefore must execute
  # from the profile's own node_modules tree.
  home.activation.dshTui = lib.hm.dag.entryAfter [ "dshRuntimePatches" "dshPlugins" ] ''
    tuiProfile="$HOME/.dsh/profiles/dsh-tui"
    tuiModules="$tuiProfile/node_modules"
    tuiScope="$tuiModules/@deepseek-harness-tui"
    tuiManifest="$tuiProfile/package.json"
    tuiPlugins="$tuiProfile/plugins"

    run mkdir -p "$tuiScope" "$tuiPlugins"

    # Replace only the package owned by this deployment. Other files in
    # the profile (including a user's cordis patch and extra plugins) survive.
    target="$tuiScope/dsh-tui"
    if [ -e "$target" ] || [ -L "$target" ]; then
      run /run/current-system/sw/bin/remove-without-permission -rf "$target"
    fi
    # Remove the old bundled auth package from profiles created by the prior
    # module revision. Only the exact package owned by dsh-tui is targeted.
    tuiAuth="$tuiScope/dsh-auth"
    if [ -e "$tuiAuth" ] || [ -L "$tuiAuth" ]; then
      run /run/current-system/sw/bin/remove-without-permission -rf "$tuiAuth"
    fi
    run cp -rL ${dshTui}/node_modules/. "$tuiModules/"
    run cp -rL ${dshTui}/package "$tuiScope/dsh-tui"
    # The profile patch below references a local plugin. Keep it a real file
    # so Node resolves the profile-relative import rather than a Nix-store
    # symlink, and reconcile only this file owned by the TUI deployment.
    if [ -L "$tuiPlugins/confirm-writes.mjs" ]; then
      run /run/current-system/sw/bin/remove-without-permission -f "$tuiPlugins/confirm-writes.mjs"
    fi
    run install -m 644 ${./profiles/web/plugins/confirm-writes.mjs} "$tuiPlugins/confirm-writes.mjs"

    # The lean fork no longer ships Liangshen. Remove only a prior dsh-tui
    # managed copy; an unmanaged user preset with the same id is untouched.
    tuiLiangshen="$HOME/.dsh/.agent-presets/liangshen"
    if [ -f "$tuiLiangshen/.dsh-tui-managed.json" ] \
      && ${pkgs.jq}/bin/jq -e \
        '(.owner == "@deepseek-harness-tui/dsh-tui" and .preset == "liangshen")' \
        "$tuiLiangshen/.dsh-tui-managed.json" >/dev/null 2>&1; then
      run /run/current-system/sw/bin/remove-without-permission -rf "$tuiLiangshen"
    fi

    if [ -L "$tuiManifest" ]; then
      run /run/current-system/sw/bin/remove-without-permission -f "$tuiManifest"
    fi
    if [ ! -e "$tuiManifest" ]; then
      run install -m 644 ${dshTuiProfileManifest} "$tuiManifest"
    else
      # Keep user-added dependencies and bundle layers, but ensure the
      # declarative TUI bundle and the in-box base layer are present exactly
      # once. The store path makes the package source explicit without asking
      # pnpm to mutate the profile during activation.
      run ${pkgs.jq}/bin/jq \
        --arg bundle '@deepseek-harness-tui/dsh-tui' \
        --arg source 'file:${dshTui}/package' \
        '.dependencies = ((.dependencies // {}) + {($bundle): $source})
        | .dsh = (.dsh // {})
        | .dsh.profile = (.dsh.profile // {})
        | .dsh.profile.bundles = (((.dsh.profile.bundles // [])
          | if index("@deepseek-ai/dsh-base") == null then ["@deepseek-ai/dsh-base"] + . else . end)
          | if index($bundle) == null then . + [$bundle] else . end)
        | .dsh.profile.patchReload = (.dsh.profile.patchReload // "live")' \
        "$tuiManifest" > "$tuiManifest.tmp"
      run mv "$tuiManifest.tmp" "$tuiManifest"
    fi

    tuiPatch="$tuiProfile/cordis.patch.yml"
    if [ -L "$tuiPatch" ]; then
      run /run/current-system/sw/bin/remove-without-permission -f "$tuiPatch"
    fi
    if [ ! -e "$tuiPatch" ]; then
      run install -m 644 ${dshTuiProfilePatch} "$tuiProfile/cordis.patch.yml"
    elif cmp -s "$tuiPatch" ${dshTuiProfileEmptyPatch}; then
      # The old module seeded an empty patch. Upgrade that module-owned file
      # to the declarative permission profile, while preserving any real
      # user-edited patch that is no longer the empty seed.
      run install -m 644 ${dshTuiProfilePatch} "$tuiPatch.tmp"
      run mv "$tuiPatch.tmp" "$tuiPatch"
    fi
    if [ ! -e "$tuiProfile/pnpm-workspace.yaml" ]; then
      run install -m 644 ${dshTuiProfileWorkspace} "$tuiProfile/pnpm-workspace.yaml"
    fi
    run install -m 644 ${dshTuiManagedMarker} "$tuiProfile/.home-manager-managed"
    run chmod -R u+rwX "$tuiProfile"
  '';
}
