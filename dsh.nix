{ config, lib, dshTui, ... }:

let
  inherit (import ./environment.nix { }) pkgs runtimePath keepBuildInputs;

  # deepseek-harness dsh-v0.2.0-rc.2 (2026-09-29)
  dshSrc = pkgs.fetchFromGitHub {
    owner = "deepseek-ai";
    repo = "deepseek-harness";
    rev = "639ed015397290b3745d163aafe02ffee4aa3f84";
    hash = "sha256-ZtO+bdoYbIkIgLTge5Eh7KYwTVh8FpFAAvx58dSY1PI=";
  };

  # 声明式 pnpm 依赖(fetchPnpmDeps 为 fixed-output 派生,沙箱内可联网下载;
  # hash 由仓库自带 pnpm-lock.yaml 固定,升级源码后需重新 prefetch)
  dshPnpmDeps = pkgs.fetchPnpmDeps {
    pname = "dsh";
    src = dshSrc;
    # fetchPnpmDeps 默认使用 nixpkgs 当前的 pnpm；channel 更新后该默认值
    # 升到 pnpm 12，而上游锁文件由 pnpm 11 生成。pnpm 12 会把 workspace
    # override 错误地按 apps/cli 解析，导致 frozen-lockfile 校验失败。
    pnpm = pkgs.pnpm_11;
    fetcherVersion = 4; # 26.11 起 pnpm_11 仅支持 fetcherVersion 4

    # 锁定依赖需要离线 fixed-output store。镜像在最后
    # 一个包长时间停滞；改用 npm 官方 CDN，适度提高并发并保留重试。
    prePnpmInstall = ''
      export NIX_NPM_REGISTRY=https://registry.npmjs.org
      pnpm config set fetch-timeout 600000
      pnpm config set fetch-retries 8
      pnpm config set network-concurrency 12
    '';

    hash = "sha256-+7jFaROKpN8XHFpulloK2lb0GsYXbEdMs/V7ZO9leKE=";
  };

  dsh = pkgs.stdenv.mkDerivation {
    pname = "dsh";
    version = "0.2.0-rc.2";
    src = dshSrc;

    pnpmDeps = dshPnpmDeps;
    # Refuse a silently fuzzy patch application when the pinned host changes.
    patchFlags = [ "-p1" "--fuzz=0" ];

    patches = [
      ./patches/tool-bottom-collapse.patch
      ./patches/bash-command-hscroll.patch
      ./patches/web-fetch-clash-fake-ip.patch
      # Native approval remains the sole composer/detail-slot owner. The user
      # addon may replace its presentation without changing request/answer semantics.
      ./patches/approval-presenter.patch
      # Nix Node exposes internals through --expose-internals; its addon getter
      # probe is incompatible with the packaged Node 22 and 24 binaries.
      ./patches/profile-resolution-expose-internals.patch

      # Optional trusted terminal/FS seams used only by the Codex preset.
      # Existing callers omit the new fields/methods and retain upstream behavior.
      ./presets/codex/patches/codex-runtime-parity.patch

      # Codex-scoped UI patches keep live, replay, and trajectory rendering together.
      ./presets/codex/patches/codex-readable-tools.patch

      # Promote only marked Codex Code Mode children to native tool rows.
      ./presets/codex/patches/codex-native-display.patch
    ];

    nativeBuildInputs = [
      pkgs.nodejs_22 # dsh engines 要求 ^22.19 || >=24
      pkgs.pnpm_11   # 与仓库 packageManager 一致的 pnpm 11
      pkgs.pnpmConfigHook # 离线恢复 pnpm store 并执行 pnpm install
      pkgs.python3   # node-gyp 编译 node-pty 原生模块所需
      pkgs.node-gyp
      pkgs.stdenv.cc # dsh 0.1.5+ 编译 native/system 的 flock addon
    ];

    __structuredAttrs = true;
    strictDeps = true;

    # pnpm 默认隔离式 node_modules,dsh 的插件 loader(vendor/loader)运行时动态
    # import '@deepseek-ai/*',需要扁平布局(与 npm 发布版行为一致)
    pnpmInstallFlags = [ "--shamefully-hoist" ];

    postPatch = ''
      # pnpm 11 在每次 `pnpm run` 前验证 node_modules,与 --shamefully-hoist 冲突
      echo 'verifyDepsBeforeRun: false' >> pnpm-workspace.yaml
    '';

    # 全量构建:host/client 双面 tsc + tsdown 打包,以及 web 前端 vite build
    buildPhase = ''
      runHook preBuild
      # node-pty 的 pty.node 由 install script 用 node-gyp 编译(--ignore-scripts 跳过)
      cd node_modules/node-pty && node-gyp rebuild && cd ../..
      export DSH_CLIENT_COMMIT_HASH=${dshSrc.rev}
      npm run build
      runHook postBuild
      # pi-ai 的 OpenAI API 与 OpenAI Codex 目录都把 GPT-6 的
      # 272000 价格分层阈值误当成上下文上限。fix-gpt56-context.py（旧文件名）
      # 现在仅修正 GPT-6；OpenAI 账号默认走 openai-codex，必须同时修正
      # 两个目录，避免 Web 仍显示/记录 272K。
      python3 ${./patches/fix-gpt56-context.py}
      # Guard the original model-window behavior even if pi-ai moves its data.
      node --input-type=module - <<'NODE'
      import assert from 'node:assert/strict'
      import { readFileSync } from 'node:fs'
      for (const provider of ['openai', 'openai-codex']) {
        const catalog = JSON.parse(readFileSync('node_modules/@earendil-works/pi-ai/dist/providers/data/' + provider + '.json', 'utf8'))
        const rows = Object.values(catalog).flatMap(models => Object.entries(models))
          .filter(([id]) => id === 'gpt-6' || id.startsWith('gpt-6-'))
        assert.ok(rows.length > 0, provider + ': GPT-6 catalog disappeared')
        for (const [id, model] of rows) assert.equal(model.contextWindow, 1050000, provider + '/' + id)
      }
      NODE
    '';

    # 产物 = 完整源码树 + node_modules(运行时经扁平链接加载 @deepseek-ai/* 插件)
    installPhase = ''
      runHook preInstall
      mkdir -p $out
      cp -r . $out/
      # dsh 的 HMR/loader 需要访问 node 内部模块(--expose-internals),
      # 而 node-addon-require-builtin 的 prebuilt 与当前 node 版本不兼容,故用 wrapper 启动
      mkdir -p $out/bin
      cat > $out/bin/dsh <<EOF
      #!/bin/sh
      # Clash/Mihomo TUN resolves public hostnames to 198.18.0.0/15 fake IPs.
      # The patched fetch provider accepts this synthetic range only for DNS
      # hostnames; callers can opt out with DSH_WEB_FETCH_ALLOW_FAKE_IP=0.
      export DSH_WEB_FETCH_ALLOW_FAKE_IP="''${DSH_WEB_FETCH_ALLOW_FAKE_IP:-1}"
      # Codex web.run must load pi-ai from the same installation instance as
      # dsh-llm-pi-ai; the launcher must not depend on a shared profiles/node_modules link.
      export DSH_PI_AI_ROOT="$out/packages/llm/llm-pi-ai/node_modules/@earendil-works/pi-ai"
      exec ${pkgs.nodejs_22}/bin/node --expose-internals $out/apps/cli/lib/bin.js "\$@"
      EOF
      chmod +x $out/bin/dsh
      # 恢复 node-pty 预编译 spawn-helper 的可执行位(--ignore-scripts 跳过 postinstall)
      find $out/node_modules/node-pty -name "spawn-helper" -exec chmod 755 {} + 2>/dev/null || true
      runHook postInstall
    '';

    dontFixup = true;

    meta = {
      description = "DeepSeek Harness — plugin-based agent harness (everything is a plugin)";
      homepage = "https://github.com/deepseek-ai/deepseek-harness";
      license = pkgs.lib.licenses.mit;
      mainProgram = "dsh";
    };
  };

  # Keep PATH isolation outside the full source build, so adding the private
  # launcher does not itself recompile the CLI or Desktop runtime.
  dshLauncher = pkgs.writeShellScriptBin "dsh" ''
    export PATH="${runtimePath}:$PATH"
    exec ${dsh}/bin/dsh "$@"
  '';

  # Files copied by dshPlugins rather than linked through home.file. The
  # previous manifest lets activation remove only files it owned when a
  # managed plugin is later removed from this list.
  dshManagedPluginPaths = pkgs.writeText "dsh-managed-plugin-paths" ''
    profiles/web/plugins/codex-registrar.mjs
    profiles/web/plugins/provider-codex.mjs
    profiles/web/node_modules/dsh-baizhu-approval/package.json
    profiles/web/node_modules/dsh-baizhu-approval/index.mjs
    profiles/web/node_modules/dsh-baizhu-approval/client.js
  '';

in
{
  _module.args.dsh = dsh;

  imports = [
    ./presets/codex/dsh-codex.nix
    ./rea.nix
    ./tui.nix
   
    # Official Electron Desktop, packaged against the same immutable runtime above.
    ./desktop.nix
  ];

  home.packages = [
    dshLauncher
    # Generic tools are private launcher dependencies, not global profile
    # packages: a later channel update must not introduce binary collisions.

    # 便捷启动(生命周期与浏览器窗口绑定,脚本主体见 ./dsh-web.sh):
    # 用法:dsh-web [port]  (默认 3080;浏览器可用 DSH_BROWSER 覆盖)
    (pkgs.writeShellScriptBin "dsh-web" (''
      export PATH="${dsh}/bin:${runtimePath}:$PATH"
    '' + builtins.readFile ./dsh-web.sh))
  ];

  home.file = {
    ".dsh/AGENTS.md".source = ../agent-context.md;

    # Keep build-only pnpm stores in the Home Manager generation closure so GC
    # does not discard them while the installed DSH packages remain in use.
    ".local/share/dsh-nix-pnpm-deps/dsh".source = dshPnpmDeps;
    ".local/share/dsh-nix-build-inputs/nixpkgs".source = pkgs.path;
    ".local/share/dsh-nix-build-inputs/cli".source = keepBuildInputs {
      inherit pkgs;
      name = "dsh-cli";
      packages = [ dsh dshPnpmDeps ];
    };

    ".dsh/profiles/web/plugins/confirm-writes.mjs".source = ./profiles/web/plugins/confirm-writes.mjs;

  };

  # Web/profile cordis patches are runtime-owned files. dsh rewrites them
  # atomically, so they must not be home.file symlinks into /nix/store. Keep
  # Home Manager-owned rows declarative while preserving any new rows that
  # dsh imports from settings.yaml into the profile patch. Otherwise a
  # later home-manager switch silently discards model/UI/provider preferences.
  home.activation.dshRuntimePatches = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
    seedRuntimePatch() {
      target="$1"
      template="$2"
      if [ -L "$target" ]; then
        run /run/current-system/sw/bin/remove-without-permission -f "$target"
      fi
      if [ ! -e "$target" ]; then
        run mkdir -p "$(dirname "$target")"
        run install -m 644 "$template" "$target"
      else
        run chmod u+rw "$target"
        if ! cmp -s "$target" "$template"; then
          # Reconcile only managed entry ids; runtime-owned settings rows
          # remain in the Web patch across future Home Manager switches.
          run ${pkgs.nodejs_22}/bin/node --input-type=module - "$template" "$target" "${dsh}/apps/cli/package.json" <<'NODE'
          import { readFileSync, renameSync, writeFileSync } from 'node:fs'
          import { createRequire } from 'node:module'
          const [template, target, anchor] = process.argv.slice(2)
          const yaml = createRequire(anchor)('js-yaml')
          const managedText = readFileSync(template, 'utf8')
          const existingText = readFileSync(target, 'utf8')
          const managed = yaml.load(managedText)
          const existing = yaml.load(existingText)
          if (!Array.isArray(managed) || !Array.isArray(existing)) {
            throw new Error('dsh: expected YAML patch lists; refusing to overwrite runtime settings')
          }
          const managedIds = new Set()
          for (const patch of managed) {
            if (typeof patch?.id === 'string') managedIds.add(patch.id)
            for (const entry of patch?.insert ?? []) {
              if (typeof entry?.id === 'string') managedIds.add(entry.id)
            }
          }
          const extra = []
          for (const patch of existing) {
            if (typeof patch?.id === 'string') {
              if (!managedIds.has(patch.id)) extra.push(patch)
            } else if (Array.isArray(patch?.insert)) {
              const insert = patch.insert.filter(entry => !managedIds.has(entry?.id))
              if (insert.length) extra.push({ ...patch, insert })
            } else {
              extra.push(patch)
            }
          }
          const next = managedText.trimEnd() + '\n' + (extra.length ? '\n' + yaml.dump(extra, { noRefs: true, lineWidth: -1 }) : "")
          if (next !== existingText) {
            writeFileSync(target + '.tmp', next, { mode: 0o644 })
            renameSync(target + '.tmp', target)
          }
    NODE
        fi
      fi
    }

    # Remove only the former Home Manager-owned global symlink. A regular
    # file or an unrelated user symlink must survive subsequent switches.
    globalPatch="$HOME/.dsh/cordis.patch.yml"
    if [ -L "$globalPatch" ]; then
      case "$(readlink "$globalPatch")" in
        /nix/store/*-home-manager-files/.dsh/cordis.patch.yml|/nix/store/*-home-cordis.patch.yml)
          run /run/current-system/sw/bin/remove-without-permission -f "$globalPatch" ;;
      esac
    fi
    seedRuntimePatch "$HOME/.dsh/profiles/web/cordis.patch.yml" "${./profiles/web/cordis.patch.yml}"
    # Settings imported by a first headless startup are runtime-owned too.
    seedRuntimePatch "$HOME/.dsh/profiles/headless/cordis.patch.yml" "${./profiles/headless/cordis.patch.yml}"
  '';

  # The old account bridge used to leave Codex model selections under the
  # non-existent `openai` route. Migrate only that exact stale shape once;
  # other providers and later user choices are left untouched.
  home.activation.dshOpenAICodexMigration = lib.hm.dag.entryAfter [ "dshRuntimePatches" ] ''
    settings="$HOME/.dsh/settings.yaml"
    marker="$HOME/.dsh/.home-manager-openai-codex-migrated"
    if [ ! -e "$marker" ] && [ -f "$settings" ]; then
      provider="$(${pkgs.gawk}/bin/awk '
        /^agent-default-model:$/ { section = 1; next }
        section && /^[^[:space:]]/ { exit }
        section && /^  provider: / { print $2; exit }
      ' "$settings")"
      model="$(${pkgs.gawk}/bin/awk '
        /^agent-default-model:$/ { section = 1; next }
        section && /^[^[:space:]]/ { exit }
        section && /^  model: / { print $2; exit }
      ' "$settings")"
      case "$provider:$model" in
        openai:gpt-5.3-codex-spark|\
        openai:gpt-5.4|\
        openai:gpt-5.4-mini|\
        openai:gpt-5.5|\
        openai:gpt-5.6-*|\
        openai:gpt-6-astra)
          run ${pkgs.gawk}/bin/awk '
            /^agent-default-model:$/ { section = 1 }
            section && /^[^[:space:]]/ && $0 !~ /^agent-default-model:$/ { section = 0 }
            section && /^  provider: openai$/ { sub(/^  provider: openai$/, "  provider: openai-codex") }
            { print }
          ' "$settings" > "$settings.tmp"
          run mv "$settings.tmp" "$settings"
          run touch "$marker"
          ;;
      esac
    fi
  '';

  # 插件文件的真实文件部署
  #
  # home.file 的所有产物(含 .text)都是符号链接;Node ESM 加载插件时会
  # realpath 到 /nix/store,插件内部的 bare import(@deepseek-ai/dsh-* 等)
  # 就找不到 ~/.dsh/profiles/node_modules(dsh 每次启动 heal 的扁平链接,
  # 指向 apps/cli 自己的依赖树 —— 必须从这条路径导入,才能与内置插件共享
  # 同一份 cordis 模块实例)。因此这些插件目录用激活脚本把 store 里的
  # 文件真实拷贝到 ~/.dsh(linkGeneration 之后运行,install 会原子替换
  # 旧的符号链接)。
  home.activation.dshPlugins = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
    removeManagedPluginPath() {
      rel="$1"
      case "$rel" in
        profiles/headless/plugins/*|profiles/web/plugins/*|\
        profiles/web/node_modules/dsh-baizhu-approval/*|\
        profiles/web/node_modules/dsh-openai-account-ui/*)
          ;;
        *) return 0 ;;
      esac
      target="$HOME/.dsh/$rel"
      if [ -L "$target" ] || [ -f "$target" ]; then
        run /run/current-system/sw/bin/remove-without-permission -f "$target"
      fi
    }

    managedPluginManifest="$HOME/.dsh/.home-manager-dsh-plugin-paths"
    if [ -f "$managedPluginManifest" ]; then
      while IFS= read -r rel; do
        [ -n "$rel" ] && removeManagedPluginPath "$rel"
      done < "$managedPluginManifest"
    fi

    # Migrate away from the old hand-written OpenAI bridge. The paths are
    # explicit so the migration also works after the old ownership manifest
    # has already been replaced by a newer generation.
    for rel in \
      profiles/headless/plugins/openai-codex-account.mjs \
      profiles/web/plugins/openai-codex-account.mjs \
      profiles/web/node_modules/dsh-openai-account-ui/package.json \
      profiles/web/node_modules/dsh-openai-account-ui/index.mjs \
      profiles/web/node_modules/dsh-openai-account-ui/client.js; do
      removeManagedPluginPath "$rel"
    done
    legacyOpenAIUi="$HOME/.dsh/profiles/web/node_modules/dsh-openai-account-ui"
    if [ -e "$legacyOpenAIUi" ] || [ -L "$legacyOpenAIUi" ]; then
      run /run/current-system/sw/bin/remove-without-permission -rf "$legacyOpenAIUi"
    fi

    # dsh heals the current dependency closure into these node_modules
    # directories, but older releases are not removed by its healer. Remove
    # only symlinks into an old dsh store path; user files and links to other
    # packages remain untouched.
    removeStaleDshStoreLink() {
      link="$1"
      [ -L "$link" ] || return 0
      target="$(readlink "$link" 2>/dev/null || true)"
      case "$target" in
        /nix/store/*-dsh-*)
          resolved="$(readlink -f "$link" 2>/dev/null || true)"
          case "$resolved" in
            "${dsh}"/*) ;;
            *) run /run/current-system/sw/bin/remove-without-permission -f "$link" ;;
          esac
          ;;
      esac
    }

    cleanDshNodeModules() {
      root="$1"
      [ -d "$root" ] || return 0
      find "$root" -type l -print | while IFS= read -r link; do
        removeStaleDshStoreLink "$link"
      done
    }

    find "$HOME/.dsh/profiles" -type d -name node_modules -print 2>/dev/null \
      | while IFS= read -r nodeModules; do
          cleanDshNodeModules "$nodeModules"
        done

    run mkdir -p \
      "$HOME/.dsh/profiles/headless/plugins" \
      "$HOME/.dsh/profiles/web/plugins" \
      "$HOME/.dsh/profiles/web/node_modules/dsh-baizhu-approval" \
      "$HOME/.dsh/profiles/node_modules/@deepseek-ai"

    run install -m 644 ${./presets/codex/codex-registrar.mjs} \
      "$HOME/.dsh/profiles/web/plugins/codex-registrar.mjs"
    run install -m 644 ${./profiles/web/plugins/provider-codex.mjs} \
      "$HOME/.dsh/profiles/web/plugins/provider-codex.mjs"
    run install -m 644 ${./profiles/web/node_modules/dsh-baizhu-approval/package.json} \
      "$HOME/.dsh/profiles/web/node_modules/dsh-baizhu-approval/package.json"
    run install -m 644 ${./profiles/web/node_modules/dsh-baizhu-approval/index.mjs} \
      "$HOME/.dsh/profiles/web/node_modules/dsh-baizhu-approval/index.mjs"
    run install -m 644 ${./profiles/web/node_modules/dsh-baizhu-approval/client.js} \
      "$HOME/.dsh/profiles/web/node_modules/dsh-baizhu-approval/client.js"

    # OAuth now lives in dsh-tui/oauth, not a separately fetched dsh-auth.
    # Deploy the canonical package (without mounting its TUI bundle) to Web,
    # headless and the shared fallback used by Codex web.run. Keep its private
    # production dependencies nested so user-installed profile packages and
    # the host's Cordis/LLM peer instances are not overwritten.
    installDshOAuth() {
      profile="$1"
      if [ "$profile" = shared ]; then
        scope="$HOME/.dsh/profiles/node_modules/@deepseek-harness-tui"
      else
        scope="$HOME/.dsh/profiles/$profile/node_modules/@deepseek-harness-tui"
      fi
      for target in "$scope/dsh-auth" "$scope/dsh-tui"; do
        if [ -e "$target" ] || [ -L "$target" ]; then
          if [ ! -L "$target" ]; then run chmod -R u+rwX "$target"; fi
          run /run/current-system/sw/bin/remove-without-permission -rf "$target"
        fi
      done
      run mkdir -p "$scope"
      run cp -rL --no-preserve=mode ${dshTui}/package "$scope/dsh-tui"
      run cp -rL --no-preserve=mode ${dshTui}/node_modules "$scope/dsh-tui/node_modules"
    }
    installDshOAuth web
    installDshOAuth headless
    installDshOAuth shared

    # User-authored Codex modules resolve bare imports relative to the shared
    # profile. DSH's healer does not link every package used by that preset;
    # keep the PTY, sandbox-policy and LLM imports on the *same* DSH instance.
    for package in dsh-terminal dsh-terminal-bash dsh-tool-terminal dsh-tools \
      dsh-sandbox dsh-sandbox-policy dsh-llm dsh-atomic-write; do
      target="$HOME/.dsh/profiles/node_modules/@deepseek-ai/$package"
      if [ -L "$target" ]; then
        run /run/current-system/sw/bin/remove-without-permission -f "$target"
      elif [ -e "$target" ]; then
        run /run/current-system/sw/bin/remove-without-permission -rf "$target"
      fi
      case "$package" in
        dsh-tools) run ln -s "${dsh}/packages/core/tools" "$target" ;;
        dsh-atomic-write) run ln -s "${dsh}/packages/util/atomic-write" "$target" ;;
        dsh-sandbox*) run ln -s "${dsh}/packages/sandbox/''${package#dsh-}" "$target" ;;
        dsh-llm) run ln -s "${dsh}/packages/llm/llm" "$target" ;;
        *) run ln -s "${dsh}/packages/terminal/''${package#dsh-}" "$target" ;;
      esac
    done

    # Codex's diff preview imports the exact root 'diff' package from this
    # shared profile too. Without a link Node cannot find it from the
    # user-authored preset (the host package itself uses a different root).
    diffTarget="$HOME/.dsh/profiles/node_modules/diff"
    if [ -L "$diffTarget" ]; then
      run /run/current-system/sw/bin/remove-without-permission -f "$diffTarget"
    fi
    if [ ! -e "$diffTarget" ]; then
      run ln -s "${dsh}/node_modules/diff" "$diffTarget"
    fi

    run install -m 644 ${dshManagedPluginPaths} "$managedPluginManifest"
  '';
}
