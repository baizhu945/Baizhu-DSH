{ config, pkgs, lib, ... }:

let
  # 源码固定版本(deepseek-harness master @ 47f9438,对应 npm 0.1.0-rc.x)
  dshSrc = pkgs.fetchFromGitHub {
    owner = "deepseek-ai";
    repo = "deepseek-harness";
    rev = "47f943859bef60e4160492346772ded9b24f765a";
    hash = "sha256-ZPGCNoPXVjP76Tm/tFPDX2X95cd83M4iHLmVP5dR+Ps=";
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

    hash = "sha256-aySHq0ywTMM5q7YuGHZrV3yQE3bwppgGfWH3wRnHCXk=";
  };

  dsh = pkgs.stdenv.mkDerivation {
    pname = "dsh";
    version = "0.1.0-rc.5";
    src = dshSrc;

    pnpmDeps = dshPnpmDeps;

    patches = [
      ./patches/expand-running.patch
      ./patches/tool-bottom-collapse.patch
      ./patches/bash-command-hscroll.patch
      ./patches/durable-session-lease.patch
    ];

    nativeBuildInputs = [
      pkgs.nodejs_22 # dsh engines 要求 ^22.19 || >=24
      pkgs.pnpm_11   # 与仓库 packageManager 一致的 pnpm 11
      pkgs.pnpmConfigHook # 离线恢复 pnpm store 并执行 pnpm install
      pkgs.python3   # node-gyp 编译 node-pty 原生模块所需
      pkgs.node-gyp
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
      npm run build
      runHook postBuild
      # 把 DeepSeek V4 正式版注入 pi-ai 的 OpenRouter 目录快照。
      # 根因:dsh 构建时锁定的 @earendil-works/pi-ai@0.82.1 内置目录快照
      # 早于 0731 / 0813 正式版上线,只收录了 0423 预览版
      # (deepseek/deepseek-v4-flash、deepseek/deepseek-v4-pro);而 discovery
      # 对目录路由直接短路返回内置目录,从不联网查询 OpenRouter /models,
      # 所以列表永远无法自愈。这里在构建期把正式版补进内置目录数据,
      # 重启 dsh 后 4 个版本(flash/pro × 预览/正式)都会出现在模型列表。
      python3 ${./patches/inject-openrouter-models.py} ${./patches/openrouter-extra-models.json}
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

in
{
  imports = [
    ./skills.nix
    ./web-ui.nix
    ./presets/dsh-anchored-standard.nix
    ./presets/dsh-router-standard.nix
    ./presets/dsh-codex.nix
  ];

  home.packages = [
    dsh
    # dsh 运行时依赖(必须):
    pkgs.nodejs_22 # dsh 子进程/spawn helper 需要 node 在 PATH
    pkgs.ripgrep   # dsh-tool-fs-search 通过 ctx.subprocess 调用 rg
    pkgs.bubblewrap # dsh sandbox-local 的 Linux 沙箱后端(workspace-write/read-only 模式需要;
                    # 探测方式:spawnSync('bwrap', ...);缺它则报 "no sandbox backend usable")

    # 便捷启动(生命周期与浏览器窗口绑定,脚本主体见 ./dsh-web.sh):
    # 1. 端口空闲时启动 dsh web(端口已有实例则直接复用);
    # 2. 打开一个独立 chromium 应用窗口(临时 profile,可被脚本监控);
    # 3. 脚本挂起,直到关闭该窗口或按 Ctrl+C;
    # 4. 退出时杀掉本次运行启动的 webui 进程并清理临时 profile
    #    (复用的已有实例不会被杀)。
    # 用法:dsh-web [port]  (默认 3080;浏览器可用 DSH_BROWSER 覆盖)
    (pkgs.writeShellScriptBin "dsh-web" (builtins.readFile ./dsh-web.sh))
  ];

  home.file = {
    ".dsh/AGENTS.md".source = ../agent-context.md;

    ".dsh/profiles/web/plugins/confirm-writes.mjs".source = ./profiles/web/plugins/confirm-writes.mjs;

    ".dsh/profiles/headless/cordis.patch.yml".source = ./profiles/headless/cordis.patch.yml;
  };

  # Web/profile cordis patches are runtime-owned files. dsh and the Web UI
  # rewrite them atomically (the skin center maintains its managed section),
  # so they must not be home.file symlinks into /nix/store. Seed a missing
  # target or replace an old Nix link; when an existing real file drifts from
  # the declarative template (e.g. a plugin row was added/removed in dsh.nix),
  # reconcile it back to the template while preserving the skin center's
  # runtime-owned "dsh-skin managed" section (the user's skin choices).
  # 否则每次模板更新后运行时文件永远停留在旧播种,新加的行(如
  # web-ui-better-sidebar / web-ui-skin-center)不会生效,导致功能缺失。
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
          # 仅保留皮肤中心运行时维护的 auto-generated 区段,其余以模板为准。
          managed="$(sed -n '/^# --- dsh-skin managed/,$p' "$target" 2>/dev/null || true)"
          run install -m 644 "$template" "$target.tmp"
          if [ -n "$managed" ]; then
            printf '\n%s\n' "$managed" >> "$target.tmp"
          fi
          run mv "$target.tmp" "$target"
        fi
      fi
    }

    seedRuntimePatch "$HOME/.dsh/cordis.patch.yml" "${./home-cordis.patch.yml}"
    seedRuntimePatch "$HOME/.dsh/profiles/web/cordis.patch.yml" "${./profiles/web/cordis.patch.yml}"
  '';

  # 插件文件的真实文件部署
  #
  # home.file 的所有产物(含 .text)都是符号链接;Node ESM 加载插件时会
  # realpath 到 /nix/store,插件内部的 bare import(@deepseek-ai/dsh-* 等)
  # 就找不到 ~/.dsh/profiles/node_modules(dsh 每次启动 heal 的扁平链接,
  # 指向 apps/cli 自己的依赖树 —— 必须从这条路径导入,才能与内置插件共享
  # 同一份 cordis 模块实例)。因此这些插件目录用激活脚本把 store 里的
  # 文件真实拷贝到 ~/.dsh(linkGeneration 之后运行,install 会原子替换
  # 旧的符号链接)。dsh-web-ui 家族包(含皮肤中心)的真实文件部署位于
  # ./web-ui.nix(home.activation.dshWebUi),理由相同。
  home.activation.dshPlugins = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
    run mkdir -p \
      "$HOME/.dsh/profiles/headless/plugins" \
      "$HOME/.dsh/profiles/web/plugins" \
      "$HOME/.dsh/profiles/web/node_modules/dsh-baizhu-approval" \
      "$HOME/.dsh/profiles/web/node_modules/dsh-openai-account-ui" \
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
    run install -m 644 ${./profiles/web/node_modules/dsh-openai-account-ui/package.json} \
      "$HOME/.dsh/profiles/web/node_modules/dsh-openai-account-ui/package.json"
    run install -m 644 ${./profiles/web/node_modules/dsh-openai-account-ui/index.mjs} \
      "$HOME/.dsh/profiles/web/node_modules/dsh-openai-account-ui/index.mjs"
    run install -m 644 ${./profiles/web/node_modules/dsh-openai-account-ui/client.js} \
      "$HOME/.dsh/profiles/web/node_modules/dsh-openai-account-ui/client.js"

    # OpenAI 账号登录插件:带 bare import(pi-ai / dsh-llm),符号链接会被 ESM
    # realpath 到 /nix/store 导致找不到依赖,因此必须真实拷贝到 profile 插件目录。
    run install -m 644 ${./profiles/web/plugins/openai-codex-account.mjs} \
      "$HOME/.dsh/profiles/web/plugins/openai-codex-account.mjs"

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
  '';
}
