#!/usr/bin/env bash
# Regression suite for the Nix DSH Desktop port.
#
# Every phase is isolated: temporary HOME, DSH_HOME, userData, and X display. Nothing
# reads or writes the invoking user's dsh profile, sessions, or credentials, and no test
# leaves a process running. Artifacts (logs, screenshots) are written to
# DSH_DESKTOP_ARTIFACTS and are never deleted.
#
# Usage: DSH_DESKTOP_PATHS=<desktop-paths.nix> ./run.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARTIFACTS="${DSH_DESKTOP_ARTIFACTS:?set DSH_DESKTOP_ARTIFACTS to a writable directory}"
PATHS="${DSH_DESKTOP_PATHS:?set DSH_DESKTOP_PATHS to the evaluated desktop/fixture paths expression}"
resolved="$(nix-instantiate --eval --raw --expr "import $PATHS")" \
  || { echo "cannot resolve desktop paths from $PATHS" >&2; exit 1; }
eval "$resolved"
export DSH_DESKTOP_BIN DSH_DESKTOP_STORE DSH_DESKTOP_PAYLOAD
export DSH_DESKTOP_NODE_BIN DSH_DESKTOP_HOST_NODE
export DSH_DESKTOP_PLUGIN_SYNC DSH_DESKTOP_PRESET_REGISTRAR DSH_TUI_STORE
: "${DSH_DESKTOP_PLUGIN_SYNC:?paths expression must include DSH_DESKTOP_PLUGIN_SYNC}"
: "${DSH_DESKTOP_PRESET_REGISTRAR:?paths expression must include DSH_DESKTOP_PRESET_REGISTRAR}"
: "${DSH_TUI_STORE:?set DSH_TUI_STORE to the configured dsh-tui Nix derivation}"
: "${DSH_CODEX_FIXTURE_ROOT:?set DSH_CODEX_FIXTURE_ROOT to evaluated Home Manager Codex source files}"
export DSH_CODEX_FIXTURE_ROOT DSH_DESKTOP_ARTIFACTS
mkdir -p "$DSH_DESKTOP_ARTIFACTS"

echo "desktop : $DSH_DESKTOP_BIN"
echo "runtime : $DSH_DESKTOP_STORE"
echo "payload : $DSH_DESKTOP_PAYLOAD"

failed=0
phase() {
  local name="$1"; shift
  echo "== $name"
  if "$@" >"$ARTIFACTS/$name.log" 2>&1; then
    tail -n 20 "$ARTIFACTS/$name.log"
  else
    failed=$((failed + 1))
    echo "!! $name FAILED (full log: $ARTIFACTS/$name.log)"
    tail -n 40 "$ARTIFACTS/$name.log"
  fi
}

phase static "$DSH_DESKTOP_HOST_NODE" --expose-internals "$HERE/static.mjs"
phase plugin-inheritance "$DSH_DESKTOP_HOST_NODE" --expose-internals --test "$HERE/plugin-inheritance.test.mjs" "$HERE/plugin-boundaries.test.mjs"
: "${DSH_APPROVAL_BEFORE:?set DSH_APPROVAL_BEFORE to the pre-repair approval client snapshot}"
: "${DSH_APPROVAL_NATIVE_BEFORE:?set DSH_APPROVAL_NATIVE_BEFORE to the pinned unpatched approval index.ts}"
export DSH_APPROVAL_BEFORE DSH_APPROVAL_NATIVE_BEFORE
phase approval-presenter "$DSH_DESKTOP_HOST_NODE" --experimental-vm-modules --expose-internals --test "$HERE/approval-presenter.test.mjs" "$HERE/../profiles/web/plugins/approval-client.test.mjs"
phase host-plugin-registration "$DSH_DESKTOP_HOST_NODE" --expose-internals "$HERE/host-plugin-registration.mjs"

# Unchanged Office coverage is opt-in, not repeatedly gated by plugin work.
if [ "${DSH_DESKTOP_TEST_OFFICE:-0}" = 1 ]; then
  phase primary-runtime "$DSH_DESKTOP_HOST_NODE" "$HERE/primary-runtime.mjs"
  phase office "$DSH_DESKTOP_HOST_NODE" "$HERE/office.mjs"
fi

# Actual Xvfb invocation (merely installing xvfb-run does not isolate DISPLAY).
# wm-close.py sends WM_DELETE_WINDOW directly; no window-manager destruction shortcut.
export DSH_TEST_X11_LIBRARY="$(nix-instantiate --eval --raw --expr 'let pkgs = import <nixpkgs> {}; in "${pkgs.libx11}/lib/libX11.so.6"')"
echo "== electron-smoke (xvfb)"
if nix-shell -p xvfb-run xdotool python3 --run "exec xvfb-run -a env DSH_DESKTOP_TEST_XVFB=1 '$DSH_DESKTOP_HOST_NODE' --expose-internals '$HERE/electron-smoke.mjs'" \
    >"$ARTIFACTS/electron-smoke.log" 2>&1; then
  tail -n 20 "$ARTIFACTS/electron-smoke.log"
else
  failed=$((failed + 1))
  echo "!! electron-smoke FAILED (full log: $ARTIFACTS/electron-smoke.log)"
  tail -n 60 "$ARTIFACTS/electron-smoke.log"
fi

echo
if [ "$failed" -eq 0 ]; then echo "ALL PHASES PASSED"; else echo "$failed PHASE(S) FAILED"; fi
echo "artifacts: $ARTIFACTS"
exit "$failed"