{ config, pkgs, lib, ... }:

let
  # deepseek-harness master (2026-09-15)
  dshSrc = pkgs.fetchFromGitHub {
    owner = "deepseek-ai";
    repo = "deepseek-harness";
    rev = "0d1f50007f9bca3f52b06e1c3074fa14d5fb0720";
    hash = "sha256-oXrdHSfkBsKvdP422F04B1d8IB9AQlnNNGW7jxrwKuU=";
  };

  # 声明式 pnpm 依赖(fetchPnpmDeps 为 fixed-output 派生,沙箱内可联网下载;
  # hash 由仓库自带 pnpm-lock.yaml 固定,升级源码后需重新 prefetch)
  dshPnpmDeps = pkgs.fetchPnpmDeps {
    pname = "dsh";
    src = dshSrc;
    fetcherVersion = 4; # 26.11 起 pnpm_11 仅支持 fetcherVersion 4

    # 更新 nix-channel 后 pnpm 11 fetchPnpmDeps 要从 npm registry 拉取全部
    # 平台可选依赖(1200+ 包);直连 registry.npmjs.org 在大并发下频繁超时
    # (curl error 23 / UND_ERR_SOCKET)。改用国内镜像并放宽 pnpm 网络参数。
    prePnpmInstall = ''
      export NIX_NPM_REGISTRY=https://registry.npmmirror.com
      pnpm config set fetch-timeout 600000
      pnpm config set fetch-retries 5
      pnpm config set network-concurrency 4
    '';

    hash = "sha256-DNGGgnec3hFUs3LDorlUGzzgRT88i33y8TqyXfoXVnY=";
  };

  # dsh-TUI 的 dsh-auth 子模块：提供 ChatGPT/Codex、Claude 和 Grok
  # 订阅账号 OAuth 登录、凭据存储/刷新与 provider 路由。固定到 TUI
  # 主仓库当前引用的子模块提交，避免跟随 main 分支漂移。
  dshAuthSrc = pkgs.fetchFromGitHub {
    owner = "ccch1mneyyy";
    repo = "dsh-auth";
    rev = "cc6ec5224b62b6e6508c0109ef19e93b0a5c0a0e";
    hash = "sha256-yL1ruV86qvi4RWfph9ANKcBrHi5p+ZpRPP5O/Q4PBJA=";
  };

  dshAuthPnpmDeps = pkgs.fetchPnpmDeps {
    pname = "dsh-auth";
    src = dshAuthSrc;
    fetcherVersion = 4;
    prePnpmInstall = ''
      export NIX_NPM_REGISTRY=https://registry.npmmirror.com
      pnpm config set fetch-timeout 600000
      pnpm config set fetch-retries 5
      pnpm config set network-concurrency 4
    '';
    hash = "sha256-+kj3H8dbEwL2ale+iQef0S+SXJgZ37qtvhjPs2Njxic=";
  };

  dsh = pkgs.stdenv.mkDerivation {
    pname = "dsh";
    version = "0.1.6-alpha.1";
    src = dshSrc;

    pnpmDeps = dshPnpmDeps;

    patches = [
      ./patches/tool-bottom-collapse.patch
      ./patches/bash-command-hscroll.patch
      ./patches/web-fetch-clash-fake-ip.patch

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
      export DSH_CLIENT_COMMIT_HASH=0d1f50007f9bca3f52b06e1c3074fa14d5fb0720
      npm run build
      runHook postBuild
      # pi-ai 的 OpenAI API 与 OpenAI Codex 目录都把 GPT-5.6 的
      # 272000 价格分层阈值误当成上下文上限。fix-gpt56-context.py 会同时
      # 修正两个 provider 的目录；OpenAI 账号默认走 openai-codex，不能只
      # 修改 openai.json，否则 Web 中仍会显示/记录 272K。
      python3 ${./patches/fix-gpt56-context.py}
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
      license = lib.licenses.mit;
      mainProgram = "dsh";
    };
  };

  dshAuth = pkgs.stdenv.mkDerivation {
    pname = "dsh-auth";
    version = "0.1.0";
    src = dshAuthSrc;
    pnpmDeps = dshAuthPnpmDeps;

    nativeBuildInputs = [
      pkgs.nodejs_22
      pkgs.pnpm_11
      pkgs.pnpmConfigHook
      pkgs.typescript
    ];

    __structuredAttrs = true;
    strictDeps = true;
    pnpmInstallFlags = [ "--frozen-lockfile" "--shamefully-hoist" ];

    postPatch = ''
      # pnpm 11's Nix hook verifies the dependency tree before every run;
      # the fixed pnpmDeps already performed that check during installation.
      echo 'verifyDepsBeforeRun: false' >> pnpm-workspace.yaml
    '';

    buildPhase = ''
      runHook preBuild
      pnpm run build
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p $out
      cp -r lib dsh-plugin.json cordis.patch.yml package.json README.md LICENSE $out/
      runHook postInstall
    '';

    dontFixup = true;

    meta = {
      description = "Subscription OAuth provider routes for DeepSeek Harness";
      homepage = "https://github.com/ccch1mneyyy/dsh-auth";
      license = lib.licenses.mit;
      mainProgram = "dsh-auth";
    };
  };

  # Files copied by dshPlugins rather than linked through home.file. The
  # previous manifest lets activation remove only files it owned when a
  # managed plugin is later removed from this list.
  dshManagedPluginPaths = pkgs.writeText "dsh-managed-plugin-paths" ''
    profiles/headless/plugins/cc-connect-startup.mjs
    profiles/headless/plugins/cc-connect-runner.mjs
    profiles/web/node_modules/dsh-baizhu-approval/package.json
    profiles/web/node_modules/dsh-baizhu-approval/index.mjs
    profiles/web/node_modules/dsh-baizhu-approval/client.js
  '';

in
{
  _module.args.dsh = dsh;
  _module.args.dshAuth = dshAuth;

  imports = [
    ./skills.nix
    ./presets/codex/dsh-codex.nix
    ./tui.nix
  ];

  home.packages = [
    dsh
    # dsh 运行时依赖(必须):
    pkgs.nodejs_22 # dsh 子进程/spawn helper 需要 node 在 PATH
    pkgs.ripgrep   # dsh-tool-fs-search 通过 ctx.subprocess 调用 rg
    pkgs.bubblewrap # dsh sandbox-local 的 Linux 沙箱后端(workspace-write/read-only 模式需要;
                    # 探测方式:spawnSync('bwrap', ...);缺它则报 "no sandbox backend usable")
    pkgs.curl       # dsh-web.sh 的 HTTP ready/token 检测

    # 便捷启动(生命周期与浏览器窗口绑定,脚本主体见 ./dsh-web.sh):
    # 用法:dsh-web [port]  (默认 3080;浏览器可用 DSH_BROWSER 覆盖)
    (pkgs.writeShellScriptBin "dsh-web" (builtins.readFile ./dsh-web.sh))
  ];

  home.file = {
    ".dsh/AGENTS.md".source = ../agent-context.md;

    ".dsh/profiles/web/plugins/confirm-writes.mjs".source = ./profiles/web/plugins/confirm-writes.mjs;

    ".dsh/profiles/headless/cordis.patch.yml".source = ./profiles/headless/cordis.patch.yml;
  };

  # Web/profile cordis patches are runtime-owned files. dsh rewrites them
  # atomically, so they must not be home.file symlinks into /nix/store. Seed a
  # missing target or replace an old Nix link; when an existing real file drifts
  # from the declarative template, reconcile it back to the template. The old
  # global home-cordis.patch.yml was removed because current retry defaults are
  # already five and a global full-config replacement broke TUI-specific rows.
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
          run install -m 644 "$template" "$target.tmp"
          run mv "$target.tmp" "$target"
        fi
      fi
    }

    # Remove the former Home Manager-owned global patch. It was intentionally
    # declarative, so deleting it here also prevents an old generation from
    # continuing to override the current profile/bundle configuration.
    if [ -L "$HOME/.dsh/cordis.patch.yml" ] || [ -f "$HOME/.dsh/cordis.patch.yml" ]; then
      run /run/current-system/sw/bin/remove-without-permission -f "$HOME/.dsh/cordis.patch.yml"
    fi
    seedRuntimePatch "$HOME/.dsh/profiles/web/cordis.patch.yml" "${./profiles/web/cordis.patch.yml}"
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

    run install -m 644 ${./profiles/headless/plugins/cc-connect-startup.mjs} \
      "$HOME/.dsh/profiles/headless/plugins/cc-connect-startup.mjs"
    run install -m 644 ${./profiles/headless/plugins/cc-connect-runner.mjs} \
      "$HOME/.dsh/profiles/headless/plugins/cc-connect-runner.mjs"
    run install -m 644 ${./profiles/web/node_modules/dsh-baizhu-approval/package.json} \
      "$HOME/.dsh/profiles/web/node_modules/dsh-baizhu-approval/package.json"
    run install -m 644 ${./profiles/web/node_modules/dsh-baizhu-approval/index.mjs} \
      "$HOME/.dsh/profiles/web/node_modules/dsh-baizhu-approval/index.mjs"
    run install -m 644 ${./profiles/web/node_modules/dsh-baizhu-approval/client.js} \
      "$HOME/.dsh/profiles/web/node_modules/dsh-baizhu-approval/client.js"

    # dsh-auth imports the exact pi-ai instance owned by dsh-llm-pi-ai. Keep
    # it as a real profile file (not a home.file symlink) and install the same
    # package into Web and headless profiles so both surfaces share its
    # DSH_AUTH_CREDENTIALS default and provider implementation.
    installDshAuth() {
      profile="$1"
      if [ "$profile" = shared ]; then
        target="$HOME/.dsh/profiles/node_modules/@deepseek-harness-tui/dsh-auth"
      else
        target="$HOME/.dsh/profiles/$profile/node_modules/@deepseek-harness-tui/dsh-auth"
      fi
      if [ -e "$target" ] || [ -L "$target" ]; then
        run chmod -R u+rwX "$target"
        run /run/current-system/sw/bin/remove-without-permission -rf "$target"
      fi
      run mkdir -p "$(dirname "$target")"
      run cp -rL ${dshAuth}/. "$target"
    }
    installDshAuth web
    installDshAuth headless
    installDshAuth shared

    # Codex preset's PTY backend is shipped in the dsh installation but is not
    # part of the Web bundle's automatic dependency heal set. Keep its three
    # bare imports resolvable from a user-authored preset without changing any
    # host composition or other preset.
    for package in dsh-terminal dsh-terminal-bash dsh-tool-terminal dsh-tools; do
      target="$HOME/.dsh/profiles/node_modules/@deepseek-ai/$package"
      if [ -L "$target" ]; then
        run /run/current-system/sw/bin/remove-without-permission -f "$target"
      elif [ -e "$target" ]; then
        run /run/current-system/sw/bin/remove-without-permission -rf "$target"
      fi
      if [ "$package" = dsh-tools ]; then
        run ln -s "${dsh}/packages/core/tools" "$target"
      else
        run ln -s "${dsh}/packages/terminal/''${package#dsh-}" "$target"
      fi
    done

    run install -m 644 ${dshManagedPluginPaths} "$managedPluginManifest"
  '';
}
