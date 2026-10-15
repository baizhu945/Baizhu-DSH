#!/usr/bin/env bash
# Derive inputs, never guess a cached /tmp tree or a stale /nix/store hash.
# Run with bash ./verify.sh [DSH runtime directory]. Does not activate anything.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
inputs=$(nix-build --no-out-link "$root/verification.nix")
# This JSON contains build paths/revision only, never account material.
eval "$(python3 - "$inputs" <<'PY'
import json, shlex, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
for key, var in {
    'binary': 'DSH_CODEX_TEST_BINARY',
    'baselineBinary': 'DSH_CODEX_TEST_BARE_BINARY',
    'officialCatalog': 'DSH_CODEX_TEST_OFFICIAL_CATALOG',
    'manualCatalog': 'DSH_CODEX_TEST_CATALOG',
    'node': 'VERIFY_NODE', 'python': 'VERIFY_PYTHON',
    'rustc': 'VERIFY_RUSTC', 'source': 'VERIFY_SOURCE', 'runtimeVersion': 'VERIFY_RUNTIME_VERSION',
}.items():
    print('export ' + var + '=' + shlex.quote(data[key]))
PY
)"
if [[ $# -gt 0 ]]; then
  dsh_root=$(readlink -f "$1")
else
  dsh_root=$("$VERIFY_NODE" --input-type=module - "$root/codex-test-environment.mjs" <<'NODE'
import { pathToFileURL } from 'node:url'
const { installedDshRoot } = await import(pathToFileURL(process.argv[2]).href)
console.log(installedDshRoot())
NODE
)
fi
[[ -d "$dsh_root/packages/core/agent-loop" ]] || { echo 'Not a DSH runtime directory' >&2; exit 1; }
export DSH_CODEX_TEST_DSH_ROOT="$dsh_root"
export DSH_NATIVE_HOST_ROOT="$dsh_root"
export DSH_NATIVE_HOST_BINARY="$DSH_CODEX_TEST_BINARY"
export DSH_NATIVE_HOST_CATALOG="$DSH_CODEX_TEST_CATALOG"
export DSH_PI_AI_ROOT="$dsh_root/packages/llm/llm-pi-ai/node_modules/@earendil-works/pi-ai"
# Query this runtime's own derivation for its clean UI baseline, including
# structured attributes. Source/build inputs are retained by Home Manager.
verifyDshDrv=$(nix-store --query --deriver "$dsh_root")
DSH_NATIVE_UI_SOURCE=$(nix-store --query --binding __json "$verifyDshDrv" |
  "$VERIFY_PYTHON" -c 'import json,sys; print(json.load(sys.stdin)["src"])')
export DSH_NATIVE_UI_SOURCE
export DSH_NATIVE_UI_INSTALLED="$dsh_root"
export DSH_CODEX_OBSERVATION_INTEGRATION=1
export DSH_CODEX_REQUIRE_NATIVE_TESTS=1
export PATH="$(dirname "$VERIFY_RUSTC"):$PATH"
# Git provenance is not the wire version: require genuine release-prepared
# Cargo identity on both independent binaries before any fixture runs.
version_home=$(mktemp -d)
trap 'remove-without-permission -rf -- "$version_home"' EXIT
for binary in "$DSH_CODEX_TEST_BINARY" "$DSH_CODEX_TEST_BARE_BINARY"; do
  [[ "$(HOME="$version_home" CODEX_HOME="$version_home/.codex" "$binary" --version)" == "codex-cli $VERIFY_RUNTIME_VERSION" ]] || {
    echo 'Native runtime release identity mismatch' >&2; exit 1;
  }
done
remove-without-permission -rf -- "$version_home"
trap - EXIT
"$VERIFY_NODE" --test "$root"/codex-*.test.mjs "$root"/native-*.test.mjs
"$VERIFY_PYTHON" "$root/patches/test-codex-context-only.py" \
  --source "$VERIFY_SOURCE" --binary "$DSH_CODEX_TEST_BINARY" \
  --baseline "$DSH_CODEX_TEST_BARE_BINARY"
