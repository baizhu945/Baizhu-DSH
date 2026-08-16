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
    hash = "sha256-oCh1BpS9K+tyzN+x1HXTNHi/D0tirLbuskiX7wyGlBA=";
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

  # agent preset:dsh-anchored-standard(xiaobright,社区实验性 preset)
  # Anchored Standard:首次请求用 Minimal 对齐的双工具目录(不注入工作区/技能
  # 上下文),会话出现首次持久晋升信号(tool/call 或 assistant/message)后开放
  # 完整 Standard 工具目录。固定 rev 而非分支;hash 由 nix-prefetch-url --unpack 计算。
  # dshPresetSrc = builtins.fetchGit {
    # url = "https://github.com/xiaobright/dsh-anchored-standard.git";
    # ref = "main";
  # };
  dshPresetSrc = pkgs.fetchFromGitHub {
    owner = "xiaobright";
    repo = "dsh-anchored-standard";
    rev = "6472c1c9431dcfd9072be23bff781b76fe7146c0";
    hash = "sha256-R+QCRXtB16fObeVTpz6aXPabGAkWtl/mR+hvW7dNmAw=";
  };

  # vision subagent 已移除:不再叠加 anchored-standard-vision.patch,
  # home.file 直接安装上游纯净 preset(该 patch 文件亦已删除)。

in
{
  imports = [
    ./skills.nix
    ./web-ui.nix
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

    ".dsh/profiles/web/cordis.patch.yml".source = ./profiles/web/cordis.patch.yml;

    ".dsh/profiles/headless/cordis.patch.yml".source = ./profiles/headless/cordis.patch.yml;

    # vision subagent 已移除:直接安装上游纯净 preset。
    ".dsh/.agent-presets/anchored-standard" = {
      source = "${dshPresetSrc}/preset";
      recursive = true;
    };
  };

  # 机器级 boot patch 的真实文件初始化(不用 home.file 符号链接):
  # dsh-web-ui 皮肤中心在运行时会把 ~/.dsh/cordis.patch.yml 原子改写为
  # 真实文件并维护 "dsh-skin managed" 区段(用户换肤选择);若继续用
  # home.file 管理,下一次 switch 的 linkGeneration 会判定现有文件
  # clobber 冲突。因此这里只负责播种:目标不存在或还是旧符号链接时,
  # 把模板真实安装过去;已经是真实文件(皮肤中心写过)则原样保留。
  home.activation.dshBootPatch = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
    bootPatch="$HOME/.dsh/cordis.patch.yml"
    if [ -L "$bootPatch" ]; then
      run /run/current-system/sw/bin/remove-without-permission -f "$bootPatch"
    fi
    if [ ! -e "$bootPatch" ]; then
      run mkdir -p "$HOME/.dsh"
      run install -m 644 ${./home-cordis.patch.yml} "$bootPatch"
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
  # 旧的符号链接)。dsh-web-ui 家族包(含皮肤中心)的真实文件部署位于
  # ./web-ui.nix(home.activation.dshWebUi),理由相同。
  home.activation.dshPlugins = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
    run mkdir -p \
      "$HOME/.dsh/profiles/headless/plugins" \
      "$HOME/.dsh/profiles/web/node_modules/dsh-baizhu-approval"
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
  '';
}
