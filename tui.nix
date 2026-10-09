{ config, lib, ... }:

let
  inherit (import ./environment.nix { }) pkgs runtimePath keepBuildInputs;

  # Pin the upstream release and its submodules. GitHub source archives omit
  # submodule contents; materialize them below before fetching pnpm deps.
  # v0.12.0 embeds OAuth and supports both dsh 0.2.0 release candidates.
  # The GitHub API tree confirms both remaining submodule pins are unchanged.
  dshTuiVersion = "0.12.0";
  dshTuiSrc = pkgs.fetchFromGitHub {
    owner = "ccch1mneyyy";
    repo = "dsh-TUI";
    rev = "3066b29113bde90606921b64bcf7c25fad31068d";
    hash = "sha256-dKxdMGVu8DbV5i4OcD0a9Z1mluEUa5y8MLrjjq6JR5U=";
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
    # Keep dependency fetching on the same pnpm major used by these pnpm 11
    # workspaces instead of following nixpkgs' moving `pnpm` default.
    pnpm = pkgs.pnpm_11;
    fetcherVersion = 4;
    prePnpmInstall = ''
      export NIX_NPM_REGISTRY=https://registry.npmjs.org
      pnpm config set fetch-timeout 600000
      pnpm config set fetch-retries 8
      pnpm config set network-concurrency 12
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
    hash = "sha256-i4HpC5SShCUR3MX0fwWsrE2Pt/S3zUSshOP/NhcTEL8=";
  });

  dshTui = pkgs.stdenv.mkDerivation {
    pname = "dsh-tui";
    version = dshTuiVersion;
    src = sourceWithSubmodules;
    pnpmDeps = dshTuiPnpmDeps;
    patchFlags = [ "-p1" "--fuzz=0" ];
    patches = [
      ./patches/dsh-tui-no-liangshen.patch
      # OAuth is embedded now; Web /auth questions still need the live Agent.
      ./patches/dsh-auth-web-question-scope.patch
      # A hardware wheel notch can arrive as several terminal reports; apply
      # exactly one six-line vertical scroll to each short report burst.
      ./patches/dsh-tui-wheel-six-lines.patch
    ];

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
      # Legacy directory discovery must also see an empty shipped preset root.
      node -e 'require("node:fs").rmSync("presets/liangshen", { recursive: true, force: true })'
      # The current dsh-base supplies ptc-runtime/workflow-ptc. Remove the
      # obsolete worker-thread row INCLUDING its multi-line !!js expression;
      # deleting only the first lines leaves the YAML malformed.
      sed -i \
        -e '/^    - id: dsh-tui-code-runtime$/,/^    # 0.1.2 presets/{ /^    # 0.1.2 presets/!d; }' \
        -e '/^- id: workflow-worker-thread$/,+1d' \
        cordis.patch.yml
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

      # Optional LaTeX images use a bundled MathJax worker.
      # Its workspace dependency must be built before compiling the TUI.
      node vendor/mathjax-tex-svg/build.mjs
      node scripts/clean-lib.mjs
      "$root/node_modules/.bin/tsc" -p tsconfig.json
      node scripts/gen-settings-json.mjs
      node scripts/build-guide.mjs --check
      # The TUI's lock must contain its validated Harness packages.
      node --import tsx/esm scripts/verify-upstream-contract.ts
      # Includes external token/sign-in visibility, cross-process locking and
      # the local regression for session-scoped Web /auth questions.
      node scripts/verify-oauth.mjs
      node --input-type=module - <<'NODE'
      import assert from 'node:assert/strict'
      import { existsSync, readdirSync } from 'node:fs'
      import { registerBundledPresets } from './lib/types/dsh-adapter/bundled-presets.js'
      import { ensurePackagedPresets } from './lib/types/dsh-adapter/packaged-presets.js'
      const registered = []
      const registry = { register: async definition => {
        registered.push(definition.id)
        return async () => {}
      } }
      const ctx = {
        baseUrl: import.meta.url,
        get: name => name === 'agentPresets' ? registry : name === 'loader' ? {
          entries: () => [{ disabled: false, options: {
            name: '@deepseek-ai/dsh-agent-preset', config: { id: 'standard' },
          } }],
        } : undefined,
        extend: () => ctx,
        effect: () => {},
      }
      assert.equal(await registerBundledPresets(ctx), true)
      assert.deepEqual(registered, ['ptc', 'minimal', 'cordis'])
      assert.equal(existsSync('presets/liangshen'), false)
      assert.deepEqual(readdirSync('presets'), [])
      assert.deepEqual(ensurePackagedPresets({ sourceRoot: 'presets' }), [])
      console.log('no-liangshen: official presets only; no shipped or materialized custom preset')
      NODE
      node --input-type=module -e '
        import assert from "node:assert/strict";
        import { WHEEL_NOTCH_LINES, wheelNotchDelta } from "./lib/types/ink/wheel-notch.js";
        const state = { at: -Infinity, direction: 0 };
        assert.equal(WHEEL_NOTCH_LINES, 6);
        assert.deepEqual([
          wheelNotchDelta(state, 1, 1000),
          wheelNotchDelta(state, 1, 1005),
          wheelNotchDelta(state, 1, 1074),
          wheelNotchDelta(state, 1, 1075),
          wheelNotchDelta(state, -1, 1076),
          wheelNotchDelta(state, -1, 1080),
        ], [6, 0, 0, 6, -6, 0]);
      '
      node --import tsx/esm scripts/verify-wheel-selection.ts
      node --import tsx/esm scripts/verify-pointer-events.ts
      node --import tsx/esm scripts/verify-math-renderer.tsx
      # Baseline screen regressions cover the touched Chat/Ink input seam.
      node --import tsx/esm scripts/repro-askpanel.tsx
      node --import tsx/esm scripts/verify-askpanel-layout.tsx
      node --import tsx/esm scripts/repro-toolcards.tsx
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
      execFileSync('chmod', ['-R', 'u+rwX', stagedNodeModules], { stdio: 'inherit' })
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
      cp -r bin lib assets guide cordis.patch.yml cordis.yml dsh-ecosystem-spec package.json $out/package/
      # Keep the directory for legacy preset discovery, but do not ship or
      # register the upstream Liangshen preset (registration patched above).
      mkdir -p $out/package/presets
      cp -rL node_modules $out/node_modules
      # Test the actual distribution: presets stay empty; OAuth and its types,
      # the bundled guide, portrait assets and vendor runtime are all shipped.
      node --input-type=module - "$out" <<'NODE'
      import assert from 'node:assert/strict'
      import { existsSync, readdirSync } from 'node:fs'
      import { join } from 'node:path'
      const out = process.argv[2]
      assert.deepEqual(readdirSync(join(out, 'package/presets')), [])
      assert.equal(existsSync(join(out, 'node_modules/@deepseek-harness-tui/dsh-auth')), false)
      for (const path of [
        'lib/types/oauth.js', 'lib/types/oauth.d.ts',
        'guide/dsh-tui-guide/SKILL.md', 'guide/dsh-tui-guide/user-guide.en.md',
        'assets/whale-girl/whale-girl.png',
      ]) assert.ok(existsSync(join(out, 'package', path)), path)
      NODE
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
      bundles = [
        "@deepseek-ai/dsh-base"
        "@deepseek-harness-tui/dsh-tui"
        # TUI mounts embedded OAuth via its own /oauth row.
      ];
      patchReload = "live";
    };
  });

  dshTuiProfileEmptyPatch = pkgs.writeText "dsh-tui-profile-empty-cordis.patch.yml" "[]\n";

  # No global provider patch is applied after this profile. The TUI bundle's
  # complete llm-deepseek row therefore remains authoritative; the omitted
  # protocol follows dsh 0.2.0-rc.1's official Messages default.
  # Keep the previous seed for a safe, exact-match upgrade. A user-edited
  # runtime patch is never replaced just to add a new preset declaration.
  dshTuiProfilePatchText = ''
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
  dshTuiProfilePreviousPatch = pkgs.writeText "dsh-tui-profile-before-codex.patch.yml" dshTuiProfilePatchText;
  # TUI's adapter registers the four official presets. The Codex registrar
  # mounts user rows directly in the same registry, without an Include scope.
  dshTuiProfilePatch = pkgs.writeText "dsh-tui-profile-cordis.patch.yml" (dshTuiProfilePatchText + ''
    - insert:
        - id: codex-registrar
          name: './plugins/codex-registrar.mjs'
          inject: [agentPresets]
  '');
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
    export PATH="${runtimePath}:$PATH"
    exec ${pkgs.nodejs_22}/bin/node ${dshTui}/package/bin/dsh-tui.js "$@"
  '';

  dstLauncher = pkgs.writeShellScriptBin "dst" ''
    export PATH="${runtimePath}:$PATH"
    exec ${pkgs.nodejs_22}/bin/node ${dshTui}/package/bin/dsh-tui.js "$@"
  '';
in
{
  # Web/headless/shared profiles deploy this package but mount only ./oauth.
  _module.args.dshTui = dshTui;

  home.packages = [
    dshTuiLauncher
    dstLauncher
  ];

  # Keep both TUI dependency stores referenced by the Home Manager generation.
  home.file = {
    ".local/share/dsh-nix-pnpm-deps/dsh-std".source = dshStdPnpmDeps;
    ".local/share/dsh-nix-pnpm-deps/dsh-tui".source = dshTuiPnpmDeps;
    ".local/share/dsh-nix-build-inputs/tui".source = keepBuildInputs {
      inherit pkgs;
      name = "dsh-tui";
      packages = [ dshTui dshStdPnpmDeps dshTuiPnpmDeps ];
      extraInputs = [ dshTuiSrc dshEcosystemSpecSrc dshStdSrc ];
    };
  };

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
    # Remove the former package-owned auth install, never its credentials
    # ($DSH_HOME/dsh-auth remains the embedded module's credential location).
    # All unrelated profile packages survive.
    tuiAuth="$tuiScope/dsh-auth"
    if [ -e "$tuiAuth" ] || [ -L "$tuiAuth" ]; then
      if [ ! -L "$tuiAuth" ]; then
        run chmod -R u+rwX "$tuiAuth"
      fi
      run /run/current-system/sw/bin/remove-without-permission -rf "$tuiAuth"
    fi
    # Keep production dependencies inside the owned package: never replace
    # unrelated profile package versions. Old root copies may remain, but
    # nested canonical dependencies win. Harness peers stay excluded and
    # resolve upward through the host's shared fallback.
    # Store directories must be writable while cp descends into @dsh-std.
    run cp -rL --no-preserve=mode ${dshTui}/package "$target"
    run mkdir -p "$target/node_modules"
    run cp -rL --no-preserve=mode ${dshTui}/node_modules/. "$target/node_modules/"
    # The profile patch below references a local plugin. Keep it a real file
    # so Node resolves the profile-relative import rather than a Nix-store
    # symlink, and reconcile only this file owned by the TUI deployment.
    if [ -L "$tuiPlugins/confirm-writes.mjs" ]; then
      run /run/current-system/sw/bin/remove-without-permission -f "$tuiPlugins/confirm-writes.mjs"
    fi
    run install -m 644 ${./profiles/web/plugins/confirm-writes.mjs} "$tuiPlugins/confirm-writes.mjs"
    if [ -L "$tuiPlugins/codex-registrar.mjs" ]; then
      run /run/current-system/sw/bin/remove-without-permission -f "$tuiPlugins/codex-registrar.mjs"
    fi
    run install -m 644 ${./presets/codex/codex-registrar.mjs} "$tuiPlugins/codex-registrar.mjs"

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
      # once. Remove the former auth dependency and bundle: OAuth is now
      # compiled into the TUI package and mounted via its /oauth row.
      # The store path makes the package source explicit without asking
      # pnpm to mutate the profile during activation.
      run ${pkgs.jq}/bin/jq \
        --arg bundle '@deepseek-harness-tui/dsh-tui' \
        --arg source 'file:${dshTui}/package' \
        --arg authBundle '@deepseek-harness-tui/dsh-auth' \
        '.dependencies = ((.dependencies // {}) + {($bundle): $source} | del(.[$authBundle]))
        | .dsh = (.dsh // {})
        | .dsh.profile = (.dsh.profile // {})
        | .dsh.profile.bundles = (((.dsh.profile.bundles // [])
          | if index("@deepseek-ai/dsh-base") == null then ["@deepseek-ai/dsh-base"] + . else . end)
          | if index($bundle) == null then . + [$bundle] else . end
          | map(select(. != $authBundle)))
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
    elif cmp -s "$tuiPatch" ${dshTuiProfileEmptyPatch} \
      || cmp -s "$tuiPatch" ${dshTuiProfilePreviousPatch}; then
      # Upgrade either exact module-owned seed, while preserving real user
      # edits. A customized patch needs a manual Codex declaration merge.
      run install -m 644 ${dshTuiProfilePatch} "$tuiPatch.tmp"
      run mv "$tuiPatch.tmp" "$tuiPatch"
    fi
    # Remove the compatibility row written by the previous generation after
    # the TUI bundle stopped needing code-runtime-worker-thread. Keep this
    # migration idempotent and preserve all unrelated user rows.
    if [ -f "$tuiPatch" ] && grep -Fq -- '- id: dsh-tui-code-runtime' "$tuiPatch"; then
      run sed -i '/^- id: dsh-tui-code-runtime$/,+1d' "$tuiPatch"
    fi
    if [ ! -e "$tuiProfile/pnpm-workspace.yaml" ]; then
      run install -m 644 ${dshTuiProfileWorkspace} "$tuiProfile/pnpm-workspace.yaml"
    fi
    run install -m 644 ${dshTuiManagedMarker} "$tuiProfile/.home-manager-managed"
    run chmod -R u+rwX "$tuiProfile"
  '';
}
