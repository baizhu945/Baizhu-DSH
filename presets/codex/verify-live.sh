#!/usr/bin/env bash
# Opt-in live validation, NEVER part of verify.sh or codex-*.test.mjs.
# No nix-build, activation, installs, shell tracing, or credential inspection.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
node_bin=$(command -v node) || { printf '%s\n' 'DEPENDENCY_MISSING' >&2; exit 1; }
exec "$node_bin" "$root/live-native-host.mjs" "$@"
