# dsh-web: 生命周期与浏览器窗口绑定的启动脚本(由 dsh.nix 用 builtins.readFile 引入,
# 因此这里不要写 shebang,writeShellScriptBin 会自动生成)。
#
# 行为:
#   1. 端口空闲 → 启动 dsh web,并记录本次运行启动的 PID;端口已有实例 → 直接复用
#   2. 打开一个独立 chromium 应用窗口(临时 profile,进程可被脚本监控)
#   3. 挂起,直到该窗口被关闭(或 Ctrl+C / 终端关闭)
#   4. 退出时:杀掉本次运行启动的 webui 进程并清理临时 profile
#      (复用的已有实例不会被杀)
#
# 用法:dsh-web [port]  (默认 3080;浏览器可用 DSH_BROWSER 覆盖)

set -u

PORT="${1:-3080}"
URL="http://127.0.0.1:${PORT}/"

BROWSER_BIN="${DSH_BROWSER:-}"
if [ -z "${BROWSER_BIN}" ]; then
  BROWSER_BIN="$(command -v chromium 2>/dev/null || true)"
fi
if [ -z "${BROWSER_BIN}" ]; then
  echo "dsh-web: 未找到 chromium,请安装后用 DSH_BROWSER 指定浏览器" >&2
  exit 1
fi

WEB_PID=""
PROFILE_DIR=""
cleanup() {
  if [ -n "${WEB_PID}" ] && kill -0 "${WEB_PID}" 2>/dev/null; then
    echo "dsh-web: 停止本次启动的服务 (pid ${WEB_PID})" >&2
    kill "${WEB_PID}" 2>/dev/null
  fi
  if [ -n "${PROFILE_DIR}" ]; then
    remove-without-permission -rf "${PROFILE_DIR}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM HUP

# 端口无实例时由本次运行启动服务,并记录 PID 供退出时回收
if ! curl -sf -o /dev/null "${URL}" 2>/dev/null; then
  dsh web --no-open --port "${PORT}" > "${HOME}/.dsh-web.log" 2>&1 &
  WEB_PID=$!
  for _ in $(seq 1 30); do
    curl -sf -o /dev/null "${URL}" 2>/dev/null && break
    kill -0 "${WEB_PID}" 2>/dev/null || break
    sleep 1
  done
  if ! curl -sf -o /dev/null "${URL}" 2>/dev/null; then
    echo "dsh-web: 服务未能启动,请查看日志: ~/.dsh-web.log" >&2
    kill "${WEB_PID}" 2>/dev/null || true
    WEB_PID=""
    exit 1
  fi
  echo "dsh-web: 服务已启动 ${URL} (pid ${WEB_PID})"
else
  echo "dsh-web: 复用已有实例 ${URL}(关闭页面不会停止已有实例)"
fi

# 独立临时 profile:chromium 关闭该窗口后进程即退出,脚本 wait 得以返回;
# 同时避免与用户日常浏览器窗口共享 profile。
PROFILE_DIR="$(mktemp -d "${XDG_RUNTIME_DIR:-/tmp}/dsh-web-profile.XXXXXX")"

# Wayland 会话下的 Chromium 参数:
#   - 不强制 --ozone-platform=wayland:它与 Vulkan 不兼容,会打印
#     wayland_surface_factory.cc 报错(非致命,但很吵);改用桌面启动器同款
#     --ozone-platform-hint=auto
#   - 按 Chromium 该报错的建议加 --disable-vulkan 消除冲突(dsh 页面不需要
#     Vulkan,GL/软渲染足够)
#   - 保留 Wayland 窗口装饰与 IME 支持
OZONE_FLAGS=""
if [ -n "${WAYLAND_DISPLAY:-}" ]; then
  OZONE_FLAGS="--ozone-platform-hint=auto --enable-features=WaylandWindowDecorations --enable-wayland-ime=true --disable-vulkan"
fi

echo "dsh-web: 打开独立浏览器窗口;关闭该窗口(或 Ctrl+C)即退出并回收本次启动的服务"
"${BROWSER_BIN}" \
  --user-data-dir="${PROFILE_DIR}" \
  --no-first-run \
  --no-default-browser-check \
  ${OZONE_FLAGS} \
  --app="${URL}" &

BROWSER_PID=$!
wait "${BROWSER_PID}"
# 兜底清理该 profile 残留的 chromium 子进程
pkill -f -- "--user-data-dir=${PROFILE_DIR}" 2>/dev/null || true
