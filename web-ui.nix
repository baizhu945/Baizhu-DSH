{ config, pkgs, lib, ... }:

let
  # ── dsh-web-ui 全家桶(zhu1090093659/dsh-web-ui)───────────────────────
  # https://github.com/zhu1090093659/dsh-web-ui
  # 官方推荐装法 `dsh plugin --profile web add @linxin666/dsh-web-ui-all`
  # 会经 pnpm 修改 profile 的 package.json/node_modules;这里做声明式等价:
  # 固定 rev 拉源码、fetchPnpmDeps 固定依赖,在 Nix 沙箱里把 13 个家族包
  # 全部构建出来,再由 home.activation 真实拷贝到
  # ~/.dsh/profiles/web/node_modules/@linxin666/。insert 行见
  # profiles/web/cordis.patch.yml,与聚合包 cordis.patch.yml 完全一致。
  # 最新正式 release v0.2.0 @ 3b52d49c；本地 staging 会排除梁神包。
  dshWebUiSrc = pkgs.fetchFromGitHub {
    owner = "zhu1090093659";
    repo = "dsh-web-ui";
    rev = "3b52d49c973e28db7a75398519b3e73db54dcf81";
    hash = "sha256-kbE25UiJfaIS3h7wCYMTcokwrc/7dkKero1uQRvq32c=";
  };

  # 声明式 pnpm 依赖(fetchPnpmDeps 为 fixed-output 派生;hash 由仓库自带
  # pnpm-lock.yaml 固定,升级源码后需重新 prefetch)。
  dshWebUiPnpmDeps = pkgs.fetchPnpmDeps {
    pname = "dsh-web-ui";
    src = dshWebUiSrc;
    fetcherVersion = 4;
    hash = "sha256-lvLWn56WKdq6Q7WNTi1PtJXEPm168YCzYZmTdGE+qEY=";
  };

  dshWebUi = pkgs.stdenv.mkDerivation {
    pname = "dsh-web-ui";
    version = "0.2.0";
    src = dshWebUiSrc;

    pnpmDeps = dshWebUiPnpmDeps;

    nativeBuildInputs = [
      pkgs.nodejs_22 # 仓库 engines 要求 ^22.19 || >=24
      pkgs.pnpm_11   # 与仓库 packageManager 一致的 pnpm 11
      pkgs.pnpmConfigHook
    ];

    __structuredAttrs = true;
    strictDeps = true;

    # 宿主侧运行时依赖需要在 profile node_modules 扁平解析,shamefully-hoist
    # 让 stage-web-ui.mjs 能从顶层 node_modules 直接取到完整闭包。
    pnpmInstallFlags = [ "--shamefully-hoist" ];

    postPatch = ''
      # pnpm 11 在每次 `pnpm run` 前验证 node_modules,与 --shamefully-hoist 冲突
      # (仓库文件末尾无换行,先补一个再追加,避免粘到上一行)。
      printf '\nverifyDepsBeforeRun: false\n' >> pnpm-workspace.yaml
    '';

    buildPhase = ''
      runHook preBuild
      pnpm -r build
      runHook postBuild
    '';

    # 产物只有可部署布局(13 个家族包 + 运行时依赖闭包 + manifests),
    # 不落整棵含 devDependencies 的 node_modules。
    installPhase = ''
      runHook preInstall
      mkdir -p $out
      node ${./stage-web-ui.mjs} . $out
      # cloudflared npm 包的 postinstall 会联网下载二进制,而 pnpmConfigHook
      # 以 --ignore-scripts 离线安装;把 nixpkgs 的 cloudflared 放到该包期望的
      # bin/ 位置即可,插件只需 spawn 该二进制。
      mkdir -p $out/deps/cloudflared/bin
      cp ${pkgs.cloudflared}/bin/cloudflared $out/deps/cloudflared/bin/cloudflared
      runHook postInstall
    '';

    dontFixup = true;

    meta = {
      description = "dsh-web-ui — plugin and skin collection for the dsh web GUI (task board, git graph, right panel, remote mobile UI, pet, live stats, skin center)";
      homepage = "https://github.com/zhu1090093659/dsh-web-ui";
      license = lib.licenses.asl20;
    };
  };
in
{
  # ─────────────────────────────────────────────────────────────────────────
  # dsh-web-ui 家族包 + 运行时依赖的真实文件部署
  #
  # 与 dshPlugins 相同的理由:home.file 的产物一律是符号链接,Node ESM
  # 加载插件时会 realpath 到 /nix/store,bare import(schemastery/ssh2 等)
  # 就找不到 ~/.dsh/profiles/node_modules 的 heal 层。因此用激活脚本把
  # store 里的文件真实拷贝到 ~/.dsh/profiles/web/node_modules。
  #
  # 只替换 manifests 里登记的目录:
  #   - 不动皮肤中心运行时创建的 dsh-client-ui-skin-* 符号链接;
  #   - 不动 web profile 里用户自装的其它插件。
  # 卸载配置模块后这些真实文件不会被 linkGeneration 清理,属预期行为。
  # ─────────────────────────────────────────────────────────────────────────
  home.activation.dshWebUi = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
    run mkdir -p \
      "$HOME/.dsh/profiles/web/node_modules/@linxin666" \
      "$HOME/.dsh/profiles/web/node_modules"

    # 先清掉本模块管理的旧版本家族包,再整层拷贝。store 源经 cp -r 部署后
    # 是只读文件/目录,先 chmod 恢复写权限;符号链接(皮肤中心运行时创建)
    # 直接删链接、绝不跟随。remove-without-permission 是系统预装的 rm
    # 包装,仓库规则不允许脚本直接 rm;激活脚本 PATH 不含系统 profile,
    # 故用 /run/current-system/sw/bin 绝对路径。
    while IFS= read -r name; do
      [ -z "$name" ] && continue
      dest="$HOME/.dsh/profiles/web/node_modules/$name"
      # 作用域父目录(@linxin666/@standard-schema)由 cp -r 保留为只读,
      # 删其子目录前必须先让父目录可写;mkidr -p 兜底确保父目录存在。
      run mkdir -p "$(dirname "$dest")"
      run chmod u+w "$(dirname "$dest")"
      if [ -L "$dest" ]; then
        run /run/current-system/sw/bin/remove-without-permission -f "$dest"
      elif [ -e "$dest" ]; then
        run chmod -R u+w "$dest"
        run /run/current-system/sw/bin/remove-without-permission -rf "$dest"
      fi
    done < ${dshWebUi}/packages.manifest

    run cp -r ${dshWebUi}/packages/. \
      "$HOME/.dsh/profiles/web/node_modules/"

    # v0.1.15 曾由本模块部署、v0.2.0 已移除的旧 family。只清理这两个
    # 明确属于本模块旧 staging 的目录，避免旧梁神行或 live-stats 行残留。
    for stale in dsh-liangshen dsh-live-stats; do
      dest="$HOME/.dsh/profiles/web/node_modules/@linxin666/$stale"
      if [ -L "$dest" ]; then
        run /run/current-system/sw/bin/remove-without-permission -f "$dest"
      elif [ -e "$dest" ]; then
        run chmod -R u+w "$dest"
        run /run/current-system/sw/bin/remove-without-permission -rf "$dest"
      fi
    done

    # 运行时依赖闭包(schemastery/zod/ssh2/ws/cloudflared/
    # dsh-better-sidebar + 传递依赖),
    # 同样先按 manifest 清理旧版本再整层拷贝。
    # 注意:新依赖可能引入全新 scope 父目录(@codemirror/@lezer/@marijn 等),
    # 它们尚未被 cp 创建,直接对 curdir 做 chmod 会因目录不存在而失败;
    # 在 set -eu 下会让整个激活提前退出(mkdir -p 幂等,先确保父目录存在再让其可写)。
    while IFS= read -r name; do
      [ -z "$name" ] && continue
      dest="$HOME/.dsh/profiles/web/node_modules/$name"
      run mkdir -p "$(dirname "$dest")"
      run chmod u+w "$(dirname "$dest")"
      if [ -L "$dest" ]; then
        run /run/current-system/sw/bin/remove-without-permission -f "$dest"
      elif [ -e "$dest" ]; then
        run chmod -R u+w "$dest"
        run /run/current-system/sw/bin/remove-without-permission -rf "$dest"
      fi
    done < ${dshWebUi}/deps.manifest

    run cp -r ${dshWebUi}/deps/. \
      "$HOME/.dsh/profiles/web/node_modules/"
  '';
}
