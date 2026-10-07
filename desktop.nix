{ dsh, ... }:

let
  pkgs = import ./pinned-nixpkgs.nix { };
  lib = pkgs.lib;

  inherit (lib)
    concatStringsSep
    lessThan
    sort
    ;

  # The Host, the package manager, and every dsh child process run on the same Node the
  # Nix dsh derivation was built against, so nothing in the runtime tree is ever rebuilt
  # against Electron's ABI. Electron itself only ever runs the UI process.
  node = pkgs.nodejs_22;

  # The Nix shell launches the official Electron Desktop against an immutable store
  # runtime. dsh.nix already builds every Desktop library, preload, the private Host, and
  # the web frontend; this derivation republishes that same tree under its own name with
  # one added source seam (./patches/desktop-nix-linux.patch) and the runtime descriptor
  # the Desktop shell validates before it starts the Host. The unmodified dsh derivation
  # stays in home.packages for the CLI, web, and TUI surfaces.
  dshDesktopRuntime = dsh.overrideAttrs (previous: {
    pname = "dsh-desktop-runtime";

    # Refuse a fuzzy application: the seam only applies to the exact pinned sources.
    patches = previous.patches ++ [ ./patches/desktop-nix-linux.patch ];

    # `files` is deliberately empty. Upstream fills it with a portable per-file inventory
    # so a signed ASAR payload can be re-verified byte for byte. This input-addressed
    # derivation instead uses an immutable Nix-managed linked graph; `nix-store --verify`
    # checks store contents against their recorded NAR hashes. Like upstream's linked
    # runtime representation, the descriptor carries what readDesktopRuntime()
    # requires: the shared package set naming @deepseek-ai/dsh and
    # @deepseek-ai/dsh-desktop-host at the release version, each an immutable symlink
    # into this same store path.
    postInstall = (previous.postInstall or "") + ''
      export DSH_DESKTOP_RELEASE_VERSION="${dsh.version}"
      export DSH_DESKTOP_NODE_VERSION="${node.version}"
      node --input-type=module - <<'NODE'
      import assert from 'node:assert/strict'
      import { createRequire } from 'node:module'
      import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
      import { join } from 'node:path'

      const out = process.env.out
      const modules = join(out, 'node_modules')
      const require = createRequire(join(out, 'apps', 'desktop', 'package.json'))
      const { valid } = require('semver')

      const release = {
        schemaVersion: 1,
        version: process.env.DSH_DESKTOP_RELEASE_VERSION,
        hostProtocolVersion: 4,
        nodeVersion: process.env.DSH_DESKTOP_NODE_VERSION,
        pnpmVersion: JSON.parse(readFileSync(join(modules, 'pnpm', 'package.json'), 'utf8')).version,
      }
      assert.notEqual(valid(release.version), null, 'release version: ' + release.version)
      assert.notEqual(valid(release.nodeVersion), null, 'release nodeVersion: ' + release.nodeVersion)
      assert.notEqual(valid(release.pnpmVersion), null, 'release pnpmVersion: ' + release.pnpmVersion)

      // Upstream derives the shared set by mirroring the hoisted dependency directory
      // (apps/desktop/scripts/development-project.ts). The Nix tree already is that
      // directory, so the same names are read straight out of it.
      const names = []
      for (const entry of readdirSync(modules, { withFileTypes: true })) {
        if (entry.name === '.bin' || entry.name === '.pnpm') continue
        const target = join(modules, entry.name)
        if (entry.name.startsWith('@')) {
          for (const scoped of readdirSync(target, { withFileTypes: true })) {
            if (scoped.isDirectory() || scoped.isSymbolicLink()) names.push(entry.name + '/' + scoped.name)
          }
          continue
        }
        if (entry.isDirectory() || entry.isSymbolicLink()) names.push(entry.name)
      }

      const sharedPackages = []
      let skipped = 0
      for (const name of names.sort()) {
        const manifestPath = join(modules, ...name.split('/'), 'package.json')
        if (!existsSync(manifestPath)) continue
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
        if (manifest.name !== name || typeof manifest.version !== 'string') continue
        // readDesktopRuntime() rejects a record whose version is not valid semver.
        if (valid(manifest.version) === null) { skipped += 1; continue }
        sharedPackages.push({ name, version: manifest.version, path: 'node_modules/' + name })
      }
      for (const required of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host']) {
        const entry = sharedPackages.find(candidate => candidate.name === required)
        assert.ok(entry !== undefined, 'desktop runtime: ' + required + ' is not a shared package')
        assert.equal(entry.version, release.version,
          'desktop runtime: ' + required + '@' + String(entry?.version) + ' does not match release ' + release.version)
      }

      // Artifacts the Electron main process and the private Host load at startup.
      for (const artifact of [
        'apps/desktop/lib/main.js',
        'apps/desktop/lib/preload-app.cjs',
        'apps/desktop/lib/preload-welcome.cjs',
        'apps/desktop/lib/preload-mandatory.cjs',
        'apps/desktop/lib/preload-platform-account.cjs',
        'apps/desktop/lib/preload-update-dialog.cjs',
        'apps/desktop/resources/icon.png',
        'apps/desktop-host/lib/index.js',
        'apps/desktop-host/lib/cli.js',
        'packages/skill/skill-office/assets/scripts/check_office.py',
        'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html',
      ]) {
        assert.ok(existsSync(join(out, artifact)), 'desktop runtime: missing build artifact ' + artifact)
      }

      const descriptor = {
        schemaVersion: 1,
        release,
        platform: 'linux',
        arch: 'x64',
        sharedPackages,
        files: [],
      }
      writeFileSync(join(out, 'desktop-runtime.json'), JSON.stringify(descriptor, undefined, 2) + '\n')
      console.log('desktop runtime: ' + sharedPackages.length + ' shared packages, '
        + skipped + ' skipped as non-semver')
      NODE
    '';
  });

  # ---------------------------------------------------------------------------
  # Primary runtime payload
  #
  # apps/desktop-host/src/office.ts reads `<primaryRuntime>/runtime.json` and resolves
  # `dependencies/{python,node,pnpm}` from it. Nix supplies every entry as a symlink
  # into the store: nothing is downloaded, unpacked, or installed at run time, and no
  # upstream bundle needs ELF repair.
  # ---------------------------------------------------------------------------

  pythonEnv = pkgs.python3.withPackages (ps: [
    ps.numpy
    ps.pandas
    ps."python-docx"
    ps."python-pptx"
    ps.openpyxl
    ps.pillow
    ps.lxml
    ps.xlsxwriter
  ]);
  pythonAbi = lib.versions.majorMinor pkgs.python3.version;
  pythonSitePackages = "${pythonEnv}/lib/python${pythonAbi}/site-packages";

  # pnpm actually built into the runtime tree by the pinned lockfile.
  runtimePnpmVersion = "11.7.0";

  # Normalized names, exactly as tool-workspace-dependencies normalizes them.
  requiredPythonDistributions = [
    "lxml"
    "numpy"
    "openpyxl"
    "pandas"
    "pillow"
    "python-docx"
    "python-pptx"
    "xlsxwriter"
  ];

  # Locked identity of the payload: explicit store inputs and their versions, never a
  # timestamp, so an unchanged payload always produces the same digest.
  payloadIdentities = sort lessThan [
    "desktop-runtime=${dshDesktopRuntime}"
    "node=${node}"
    "node-version=${node.version}"
    "office-skills=${dshDesktopRuntime}/packages/skill/skill-office/assets"
    "pnpm=${dshDesktopRuntime}/node_modules/pnpm"
    "python=${pythonEnv}"
    "python-interpreter=${pkgs.python3.interpreter}"
    "python-version=${pkgs.python3.version}"
  ];
  payloadDigest = lib.hashString "sha256" (concatStringsSep "\n" payloadIdentities);

  dshDesktopPrimaryPayload = pkgs.runCommand "dsh-desktop-primary-payload" { } ''
    set -eu
    runtime="$out/primary-runtime"
    mkdir -p "$runtime/dependencies/python/bin" \
      "$runtime/dependencies/python/lib/python${pythonAbi}" \
      "$runtime/dependencies/node/bin"

    # office.ts resolves Office skills as a *sibling* of the payload directory.
    ln -s ${dshDesktopRuntime}/packages/skill/skill-office/assets "$out/office-skills"

    ln -s ${pythonEnv}/bin/python3 "$runtime/dependencies/python/bin/python3"
    ln -s ${pythonSitePackages} "$runtime/dependencies/python/lib/python${pythonAbi}/site-packages"
    ln -s ${node}/bin/node "$runtime/dependencies/node/bin/node"
    ln -s ${dshDesktopRuntime}/node_modules "$runtime/dependencies/node/node_modules"
    ln -s ${dshDesktopRuntime}/node_modules/pnpm "$runtime/dependencies/pnpm"

    # The recorded pnpm version must be the one this runtime actually carries.
    ${pythonEnv}/bin/python3 -c "
import json, sys
actual = json.load(open('$runtime/dependencies/pnpm/package.json'))['version']
sys.exit(0) if actual == '${runtimePnpmVersion}' else sys.exit('pnpm version mismatch: ' + actual)
"

    ${pythonEnv}/bin/python3 ${./scripts/write-primary-runtime.py} \
      "$runtime/runtime.json" ${payloadDigest} ${dsh.version} \
      ${pkgs.python3.version} ${node.version} ${runtimePnpmVersion} \
      ${pkgs.writeText "dsh-desktop-required-python.json" (builtins.toJSON requiredPythonDistributions)}

    # tool-workspace-dependencies validates every one of these before it hands a path to
    # a skill, so assert the same set here instead of discovering it at run time.
    test -f "$runtime/dependencies/python/bin/python3"
    test -f "$runtime/dependencies/node/bin/node"
    test -f "$runtime/dependencies/pnpm/bin/pnpm.mjs"
    test -d "$runtime/dependencies/python/lib/python${pythonAbi}/site-packages"
    test -d "$runtime/dependencies/node/node_modules"
    "$runtime/dependencies/python/bin/python3" -c \
      'import docx, lxml, numpy, openpyxl, pandas, PIL, pptx, xlsxwriter'

    touch $out
  '';

  # ---------------------------------------------------------------------------
  # The Electron launcher
  # ---------------------------------------------------------------------------

  dshDesktopAppRoot = "${dshDesktopRuntime}/apps/desktop";

  # Package scripts resolve a bare `node` through this directory. It never points at
  # Electron, so an install script cannot accidentally run in Electron's Node mode.
  nodeBin = pkgs.runCommand "dsh-desktop-node-bin" { } ''
    mkdir -p $out
    cat > $out/node <<'NODE_LAUNCHER'
    #!${pkgs.runtimeShell}
    exec ${node}/bin/node --expose-internals "$@"
    NODE_LAUNCHER
    chmod 0755 $out/node
    touch $out
  '';

  # Commands the runtime shells out to: dsh-tool-fs-search needs ripgrep, the sandbox
  # backend needs bubblewrap, the native directory picker needs zenity, and plugin
  # package scripts need git, coreutils, glib, and xdg-utils on PATH.
  launcherPath = lib.makeBinPath [
    pkgs.bashInteractive
    pkgs.bubblewrap
    pkgs.coreutils
    pkgs.git
    pkgs.glib
    pkgs.nodejs_22
    pkgs.ripgrep
    pkgs.xdg-utils
    pkgs.zenity
  ];

  dshDesktop = pkgs.stdenv.mkDerivation {
    pname = "dsh-desktop";
    version = dsh.version;

    dontUnpack = true;
    dontConfigure = true;
    dontBuild = true;
    dontStrip = true;

    nativeBuildInputs = [ pkgs.coreutils ];

    installPhase = ''
      runHook preInstall

      install -dm755 "$out/bin" "$out/libexec" "$out/share/applications"
      install -dm755 "$out/share/icons/hicolor/1104x1104/apps"
      install -dm755 "$out/share/icons/hicolor/scalable/apps"

      # The generic cross-platform official assets; the Windows-only icon would give the
      # Linux window and taskbar entry the wrong artwork.
      install -m 644 ${dshDesktopRuntime}/apps/desktop/resources/icon.png \
        "$out/share/icons/hicolor/1104x1104/apps/dsh-desktop.png"
      install -m 644 ${dshDesktopRuntime}/apps/desktop/resources/icon.svg \
        "$out/share/icons/hicolor/scalable/apps/dsh-desktop.svg"

      # Private node launcher directory handed to the Host for package operations.
      cp -r ${nodeBin} "$out/libexec/node-bin"

      install -m 644 ${pkgs.writeText "dsh-desktop.desktop" desktopEntry} \
        "$out/share/applications/dsh-desktop.desktop"

      # The quoted heredoc preserves shell runtime variables such as HOME and
      # WAYLAND_DISPLAY while Nix interpolates immutable package paths.
      # Every overrideable variable keeps the packaged value
      # only when the caller left it unset, so a smoke run and a user's own override
      # both still work.
      cat > "$out/bin/dsh-desktop" <<'LAUNCHER'
      #!${pkgs.runtimeShell}
      # Official DeepSeek Harness Desktop, packaged for Nix. Updates arrive through
      # Home Manager; this application carries no in-app updater.
      export DSH_DESKTOP_NIX="''${DSH_DESKTOP_NIX:-1}"
      export DSH_DESKTOP_LAUNCHER_BIN="''${DSH_DESKTOP_LAUNCHER_BIN-${pkgs.electron_44}/bin/electron}"
      export DSH_DESKTOP_APP_ROOT="''${DSH_DESKTOP_APP_ROOT-${dshDesktopAppRoot}}"
      export DSH_DESKTOP_HOST_NODE="''${DSH_DESKTOP_HOST_NODE-${node}/bin/node}"
      export DSH_DESKTOP_NODE_BIN="''${DSH_DESKTOP_NODE_BIN-${nodeBin}}"
      export DSH_DESKTOP_DSH_DIR="''${DSH_DESKTOP_DSH_DIR-${dshDesktopRuntime}}"
      export DSH_DESKTOP_PNPM_ENTRY="''${DSH_DESKTOP_PNPM_ENTRY-${dshDesktopRuntime}/node_modules/pnpm/bin/pnpm.mjs}"
      export DSH_DESKTOP_PRIMARY_RUNTIME_DIR="''${DSH_DESKTOP_PRIMARY_RUNTIME_DIR-${dshDesktopPrimaryPayload}/primary-runtime}"
      export DSH_DESKTOP_OPEN_DEVTOOLS="''${DSH_DESKTOP_OPEN_DEVTOOLS:-0}"
      export DSH_DESKTOP_PLUGIN_SYNC="''${DSH_DESKTOP_PLUGIN_SYNC-${./scripts/sync-desktop-plugins.mjs}}"
      export DSH_DESKTOP_PRESET_REGISTRAR="''${DSH_DESKTOP_PRESET_REGISTRAR-${./scripts/register-desktop-presets.mjs}}"
      export DSH_PI_AI_ROOT="''${DSH_PI_AI_ROOT-${dshDesktopRuntime}/packages/llm/llm-pi-ai/node_modules/@earendil-works/pi-ai}"
      export DSH_CODEX_REQUIRE_ANCHOR="''${DSH_CODEX_REQUIRE_ANCHOR-''${DSH_HOME:-$HOME/.dsh}/profiles/desktop/package.json}"
      export DSH_WEB_FETCH_ALLOW_FAKE_IP="''${DSH_WEB_FETCH_ALLOW_FAKE_IP:-1}"
      export PATH="${launcherPath}:''${PATH}"

      # An inherited Electron or Node launcher variable would silently start this command
      # in Node mode, or with a foreign module search path. Neither applies to the UI.
      unset ELECTRON_RUN_AS_NODE NODE_OPTIONS NODE_PATH

      user_data_dir="''${DSH_DESKTOP_USER_DATA_DIR:-''${XDG_CONFIG_HOME:-$HOME/.config}/dsh-desktop}"
      mkdir -p "$user_data_dir"

      # Native Wayland whenever the session offers it; otherwise X11/XWayland.
      if [ -n "''${WAYLAND_DISPLAY-}" ]; then
        ozone=(--ozone-platform=wayland --enable-wayland-ime --wayland-text-input-version=3)
      else
        ozone=(--ozone-platform=x11)
      fi

      # Chromium honours the last switch occurrence, so "$@" follows these defaults: a
      # user-supplied flag such as --ozone-platform=x11 still overrides this launcher.
      exec "$DSH_DESKTOP_LAUNCHER_BIN" "''${ozone[@]}" "$@" \
        --user-data-dir="$user_data_dir" "$DSH_DESKTOP_APP_ROOT"
      LAUNCHER
      chmod 0755 "$out/bin/dsh-desktop"

      runHook postInstall
    '';

    meta = {
      description = "DeepSeek Harness Desktop — official Electron shell on Nix";
      homepage = "https://github.com/deepseek-ai/deepseek-harness";
      license = lib.licenses.mit;
      mainProgram = "dsh-desktop";
      platforms = [ "x86_64-linux" ];
    };

    passthru = {
      inherit dshDesktopRuntime dshDesktopPrimaryPayload nodeBin;
      pluginSync = ./scripts/sync-desktop-plugins.mjs;
      presetRegistrar = ./scripts/register-desktop-presets.mjs;
    };
  };

  desktopEntry = ''
    [Desktop Entry]
    Type=Application
    Name=DeepSeek Harness
    Comment=DeepSeek Harness Desktop
    Exec=dsh-desktop %u
    Icon=dsh-desktop
    # Matches app.setName('DeepSeek Harness'), which the launcher sets before the
    # single-instance lock and which therefore also names the userData directory.
    StartupWMClass=DeepSeek Harness
    Terminal=false
    Categories=Development;Utility;
    MimeType=x-scheme-handler/dsh;
  '';
in
{
  _module.args.dshDesktopRuntime = dshDesktopRuntime;

  home.packages = [ dshDesktop ];
  home.file.".local/share/dsh-nix-build-inputs/desktop".source = import ./keep-build-inputs.nix {
    inherit pkgs;
    name = "dsh-desktop";
    packages = [ dshDesktopRuntime ];
  };
}