{ config, pkgs, lib, ... }:

let
  # dsh-TUI source and all git submodules are pinned to immutable revisions.
  # The upstream pnpm lockfile remains in the fetched source; no generated
  # dependency lockfile is kept in this Home Manager module.
  dshTuiRev = "4b60d89ddccc9fb64f1e7e10c841389c1b9505e2";
  dshTuiVersion = "0.10.0-beta.4";

  dshTuiSrc = pkgs.fetchFromGitHub {
    owner = "ccch1mneyyy";
    repo = "dsh-TUI";
    rev = dshTuiRev;
    hash = "sha256-I3blr+O+WkNlf1A/OhOjL42oLUDjDPWlDhPfh+kae04=";
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

  dshStdPnpmDeps = pkgs.fetchPnpmDeps {
    pname = "dsh-std";
    src = dshStdSrc;
    fetcherVersion = 4;
    prePnpmInstall = ''
      export NIX_NPM_REGISTRY=https://registry.npmmirror.com
      pnpm config set fetch-timeout 600000
      pnpm config set fetch-retries 5
      pnpm config set network-concurrency 4
    '';
    hash = "sha256-6b+GkosWdqzXbYypLghuCpB6ioMSdA4Jcr9XUs5XNX8=";
  };

  # The upstream lockfile still declares this local link, so provide only a
  # dependency-free build stub. The real dsh-auth source is neither fetched
  # nor compiled, and the link is removed from the final package metadata.
  dshAuthStub = pkgs.writeText "dsh-auth-package.json" (builtins.toJSON {
    name = "@deepseek-harness-tui/dsh-auth";
    version = "0.0.0-disabled";
    private = true;
    type = "module";
  });

  # Materialize the submodules into a single source tree without relying on
  # mutable git checkout state. Copying their contents also avoids a build
  # phase that would need to fetch or initialize git submodules.
  sourceWithSubmodules = pkgs.runCommand "dsh-tui-${dshTuiVersion}-source" { } ''
    mkdir -p $out
    cp -r ${dshTuiSrc}/. $out/
    chmod -R u+w $out
    mkdir -p $out/dsh-auth $out/dsh-ecosystem-spec $out/vendor/dsh-std
    cp ${dshAuthStub} $out/dsh-auth/package.json
    cp -r ${dshEcosystemSpecSrc}/. $out/dsh-ecosystem-spec/
    cp -r ${dshStdSrc}/. $out/vendor/dsh-std/
  '';

  dshTuiPnpmDeps = pkgs.fetchPnpmDeps {
    pname = "dsh-tui";
    src = sourceWithSubmodules;
    fetcherVersion = 4;
    prePnpmInstall = ''
      export NIX_NPM_REGISTRY=https://registry.npmmirror.com
      pnpm config set fetch-timeout 600000
      pnpm config set fetch-retries 5
      pnpm config set network-concurrency 4
    '';
    hash = "sha256-U4c5/enAwPbJypxngBwtMy1IY+7xdw1MEB+vJA0MZZo=";
  };

  dshTui = pkgs.stdenv.mkDerivation {
    pname = "dsh-tui";
    version = dshTuiVersion;
    src = sourceWithSubmodules;
    patches = [ ./patches/tui-persistent-preferences.patch ];
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
      # Remove the optional Liangshen mode from the user-visible command,
      # preset roster text, and tips before compiling the TUI bundle.
      node --input-type=module - <<'NODE'
      import { readFileSync, rmSync, writeFileSync } from "node:fs"

      const replace = (file, from, to) => {
        const original = readFileSync(file, "utf8")
        const updated = original.replace(from, to)
        if (updated === original) throw new Error(`expected source text was not found in ''${file}`)
        writeFileSync(file, updated)
      }

      replace("src/commands.ts",
        "  { name: 'preset', description: 'Switch the agent preset (including Liangshen mode)' },",
        "  { name: 'preset', description: 'Switch the agent preset' },")
      replace("src/dsh-adapter/channel.ts",
        "current?: (events: readonly SessionEvent[]) => unknown",
        "current?: (session: { events: readonly SessionEvent[] }) => unknown")
      replace("src/dsh-adapter/channel.ts",
        "        return { ok: false, reason: 'failed', error: message }\n      }\n      backgroundHandles.set(String(sessionId), handle)",
        "        return { ok: false, reason: 'failed', error: message }\n      }\n      applyPreferredPermission(handle.agent, true)\n      backgroundHandles.set(String(sessionId), handle)")
      replace("src/dsh-adapter/channel.ts",
        "        return { ok: false }\n      }\n      try {\n        await attachSessionToWorkspace(ctx, state.cwd, sessionId)\n      } catch {\n        // Optional ledger, same as dispatch.\n      }\n      const previousHandle = currentHandle",
        "        return { ok: false }\n      }\n      try {\n        await attachSessionToWorkspace(ctx, state.cwd, sessionId)\n      } catch {\n        // Optional ledger, same as dispatch.\n      }\n      applyPreferredPermission(handle.agent, true)\n      const previousHandle = currentHandle")
      replace("src/dsh-adapter/channel.ts",
        "  events: readonly SessionEvent[],\n): PermissionPresetSnapshot {",
        "  session: { events: readonly SessionEvent[] },\n): PermissionPresetSnapshot {")
      replace("src/dsh-adapter/channel.ts",
        "    const currentValue = current(events)",
        "    const currentValue = runtime.current(session)")
      replace("src/dsh-adapter/channel.ts",
        "    const current = runtime.current\n",
        "")
      replace("src/dsh-adapter/channel.ts",
        "    const optionOf = runtime.optionOf\n",
        "")
      replace("src/dsh-adapter/channel.ts",
        "    if (typeof current !== 'function' || typeof optionOf !== 'function') return unavailablePermissionPresetSnapshot()",
        "    if (typeof runtime.current !== 'function' || typeof runtime.optionOf !== 'function') return unavailablePermissionPresetSnapshot()")
      replace("src/dsh-adapter/channel.ts",
        "optionOf(name)",
        "runtime.optionOf(name)")
      replace("src/dsh-adapter/channel.ts",
        "optionOf(currentValue)",
        "runtime.optionOf(currentValue)")
      replace("src/dsh-adapter/channel.ts",
        "return permissionPresetSnapshotFromService(service, agent.session.events)",
        "return permissionPresetSnapshotFromService(service, agent.session)")
      replace("src/i18n.ts",
        "  'preset-name-liangshen': { zh: '梁神模式', en: 'Liangshen mode' },\n",
        "")
      replace("src/i18n.ts",
        "  'preset-desc-liangshen': { zh: '主 Agent 与子 Agent 首轮均保持 Minimal 双工具，首次工具调用后开放完整目录，压缩后重新锚定。', en: 'Root and delegated agents keep the minimal two-tool pair on the first turn; the full catalog opens after the first tool call and re-anchors after compaction.' },\n",
        "")
      replace("src/i18n.ts",
        "  'cmd-desc-preset': { zh: '切换 Agent 预设（含梁神模式）' },",
        "  'cmd-desc-preset': { zh: '切换 Agent 预设' },")
      replace("src/tips.ts",
        "    en: '/preset switches presets: standard/ptc/minimal/cordis/liangshen',",
        "    en: '/preset switches presets: standard/ptc/minimal/cordis',")
      replace("src/tips.ts",
        /\n  \{\n    id: 'cmd-preset-liangshen',[\s\S]*?\n  \},\n(?=  \{)/,
        "\n")

      // OAuth is provided by the existing local Web plugin. Remove the
      // upstream re-export so no dsh-auth module is needed by the build.
      rmSync("src/oauth.ts", { force: true })

      const packageFile = "package.json"
      const packageJson = JSON.parse(readFileSync(packageFile, "utf8"))
      for (const name of Object.keys(packageJson.scripts ?? {})) {
        if (name.includes("liangshen") || name === "build:dsh-auth") delete packageJson.scripts[name]
      }
      if (typeof packageJson.scripts?.compile === "string") {
        packageJson.scripts.compile = packageJson.scripts.compile
          .replace(" && npm run build:dsh-auth", "")
      }
      if (typeof packageJson.scripts?.["verify:build"] === "string") {
        packageJson.scripts["verify:build"] = packageJson.scripts["verify:build"]
          .split(" && ")
          .filter((command) => !command.includes("liangshen"))
          .join(" && ")
      }
      if (packageJson.exports) delete packageJson.exports["./oauth"]
      writeFileSync(packageFile, JSON.stringify(packageJson, null, 2) + "\n")
      NODE
    '';

    # pnpmConfigHook restores the root store. The two nested git submodules
    # have independent lockfiles, so restore their fixed-output stores and
    # install them offline before compiling the root package.
    preBuild = ''
      export HOME=$TMPDIR
      export CI=true
      root=$PWD

      stdStore=$TMPDIR/dsh-std-store
      mkdir -p "$stdStore"
      tar --zstd -xf ${dshStdPnpmDeps}/pnpm-store.tar.zst -C "$stdStore"
      chmod -R u+rwX "$stdStore"
      if [ -f "$stdStore/v11/index.db.sql" ]; then
        sqlite3 "$stdStore/v11/index.db" < "$stdStore/v11/index.db.sql"
        node -e 'require("node:fs").rmSync(process.argv[1], { force: true })' \
          "$stdStore/v11/index.db.sql"
      fi
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
      # pnpm's workspace install also materializes the root development and
      # peer graph. Keep only the TUI package's production dependency closure;
      # dsh supplies its peer packages through the profile fallback.
      node --input-type=module - <<'NODE'
      import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs"
      import { execFileSync } from "node:child_process"
      import { dirname, join, resolve } from "node:path"

      const root = process.cwd()
      const nodeModules = join(root, "node_modules")
      const stagedNodeModules = join(root, ".runtime-node_modules")
      execFileSync("cp", ["-rL", nodeModules, stagedNodeModules], { stdio: "inherit" })
      rmSync(nodeModules, { recursive: true, force: true })
      renameSync(stagedNodeModules, nodeModules)

      const keep = new Set()
      const visited = new Set()
      const packagePath = (dir) => join(dir, "package.json")
      const readPackage = (dir) => {
        try { return JSON.parse(readFileSync(packagePath(dir), "utf8")) }
        catch { return null }
      }
      const resolveDependency = (from, name) => {
        let dir = from
        while (true) {
          const candidate = join(dir, "node_modules", ...name.split("/"))
          if (existsSync(packagePath(candidate))) return candidate
          const parent = dirname(dir)
          if (parent === dir) return null
          dir = parent
        }
      }
      const visit = (dir) => {
        if (!dir || visited.has(dir)) return
        const pkg = readPackage(dir)
        if (!pkg) return
        visited.add(dir)
        keep.add(resolve(dir))
        for (const field of ["dependencies", "optionalDependencies"]) {
          for (const name of Object.keys(pkg[field] ?? {})) {
            const dependency = resolveDependency(dir, name)
            if (dependency) visit(dependency)
          }
        }
      }
      visit(root)

      for (const entry of readdirSync(nodeModules)) {
        if (entry.startsWith(".")) continue
        const entryPath = join(nodeModules, entry)
        if (entry.startsWith("@")) {
          for (const child of readdirSync(entryPath)) {
            const childPath = join(entryPath, child)
            if (!keep.has(resolve(childPath))) rmSync(childPath, { recursive: true, force: true })
          }
          if (readdirSync(entryPath).length === 0) rmSync(entryPath, { recursive: true, force: true })
        } else if (!keep.has(resolve(entryPath))) {
          rmSync(entryPath, { recursive: true, force: true })
        }
      }
      for (const metadata of [".pnpm", ".package-map.json", ".modules.yaml", ".pnpm-workspace-state-v1.json"]) {
        rmSync(join(nodeModules, metadata), { recursive: true, force: true })
      }
      NODE

      # Remove the optional preset and the disabled authentication module from
      # the final artifact.
      node --input-type=module - <<'NODE'
      import { readFileSync, rmSync, writeFileSync } from "node:fs"
      const packageJson = JSON.parse(readFileSync("package.json", "utf8"))
      delete packageJson.dependencies?.["@deepseek-harness-tui/dsh-auth"]
      delete packageJson.optionalDependencies?.["@deepseek-harness-tui/dsh-auth"]
      packageJson.bundledDependencies = (packageJson.bundledDependencies ?? [])
        .filter((name) => name !== "@deepseek-harness-tui/dsh-auth")
      if (packageJson.exports) delete packageJson.exports["./oauth"]
      writeFileSync("package.json", JSON.stringify(packageJson, null, 2) + "\n")
      rmSync("node_modules/@deepseek-harness-tui/dsh-auth", { recursive: true, force: true })
      rmSync("presets/liangshen", { recursive: true, force: true })
      for (const file of [
        "lib/types/oauth.js",
        "lib/types/oauth.d.ts",
        "lib/types/oauth.js.map",
        "lib/types/oauth.d.ts.map",
      ]) rmSync(file, { force: true })

      const cordisPatch = readFileSync("cordis.patch.yml", "utf8")
      const withoutDshAuth = cordisPatch.replace(
        /\n    # Subscription OAuth sign-in[\s\S]*?\n    - id: dsh-tui-auth\n      name: '@deepseek-harness-tui\/dsh-tui\/oauth'\n      inject: \[llm, commands\]\n/,
        "\n",
      )
      if (withoutDshAuth === cordisPatch) throw new Error("dsh-tui-auth row was not found")
      writeFileSync("cordis.patch.yml", withoutDshAuth)
      NODE

      mkdir -p $out/package
      cp -r bin lib cordis.patch.yml cordis.yml dsh-ecosystem-spec presets package.json $out/package/
      cp -rL node_modules $out/node_modules
    '';

    dontFixup = true;
  };

  # Profile files mirror the package layout under ~/.dsh/profiles/dsh-tui.
  # Keep them as ordinary source files so their contents are reviewable and
  # can be edited independently of the derivation logic below.
  dshTuiProfileManifest = ./profiles/dsh-tui/package.json;
  dshTuiProfileCordis = ./profiles/dsh-tui/cordis.yml;

  # The TUI bundle's dsh-auth row is removed during the build. The local Web
  # plugin is the sole owner of the OpenAI ChatGPT-account provider route.
  dshTuiProfilePatch = ./profiles/dsh-tui/cordis.patch.yml;
  dshTuiProfileWorkspace = ./profiles/dsh-tui/pnpm-workspace.yaml;

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

  home.activation.dshTui = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
    run mkdir -p \
      "$HOME/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui" \
      "$HOME/.dsh/profiles/dsh-tui/plugins"

    tuiProfile="$HOME/.dsh/profiles/dsh-tui"
    if [ -e "$tuiProfile/node_modules" ] || [ -L "$tuiProfile/node_modules" ]; then
      run /run/current-system/sw/bin/remove-without-permission -rf "$tuiProfile/node_modules"
    fi
    if [ -e "$tuiProfile/.dsh-module-fallback" ] || [ -L "$tuiProfile/.dsh-module-fallback" ]; then
      run /run/current-system/sw/bin/remove-without-permission -rf "$tuiProfile/.dsh-module-fallback"
    fi
    run mkdir -p "$tuiProfile/node_modules/@deepseek-harness-tui"
    run cp -rL ${dshTui}/node_modules/. "$tuiProfile/node_modules/"
    run cp -rL ${dshTui}/package \
      "$tuiProfile/node_modules/@deepseek-harness-tui/dsh-tui"
    run install -m 644 ${dshTuiProfileManifest} "$tuiProfile/package.json"
    run install -m 644 ${dshTuiProfileCordis} "$tuiProfile/cordis.yml"
    run install -m 644 ${dshTuiProfilePatch} "$tuiProfile/cordis.patch.yml"
    run install -m 644 ${dshTuiProfileWorkspace} "$tuiProfile/pnpm-workspace.yaml"
    run install -m 644 ${./profiles/dsh-tui/plugins/confirm-writes.mjs} \
      "$tuiProfile/plugins/confirm-writes.mjs"
    run install -m 644 ${./profiles/dsh-tui/plugins/openai-codex-account.mjs} \
      "$tuiProfile/plugins/openai-codex-account.mjs"

    # Remove only the preset previously materialized by dsh-TUI itself. A
    # matching unmarked path is user-owned and is intentionally preserved.
    liangshenPreset="$HOME/.dsh/.agent-presets/liangshen"
    if [ -f "$liangshenPreset/.dsh-tui-managed.json" ] \
      && grep -q '"owner"[[:space:]]*:[[:space:]]*"@deepseek-harness-tui/dsh-tui"' "$liangshenPreset/.dsh-tui-managed.json" \
      && grep -q '"preset"[[:space:]]*:[[:space:]]*"liangshen"' "$liangshenPreset/.dsh-tui-managed.json"; then
      run /run/current-system/sw/bin/remove-without-permission -rf "$liangshenPreset"
    fi
    run chmod -R u+rwX "$tuiProfile"
  '';
}
