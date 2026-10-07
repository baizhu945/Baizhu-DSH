#!/usr/bin/env bash
# Evaluation only. Never updates channels, builds packages, or activates HM.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
while IFS= read -r -d '' file; do
  nix-instantiate --parse "$file" >/dev/null
done < <(find "$ROOT" -name '*.nix' -print0)

baseline="$(nix-instantiate --eval --strict --json \
  --option allow-import-from-derivation false "$HERE/identities.nix")"
without_channel="$(NIX_PATH=nixpkgs=/dsh-pin-test-nonexistent-channel \
  nix-instantiate --eval --strict --json \
  --option allow-import-from-derivation false "$HERE/identities.nix")"
if [ "$baseline" != "$without_channel" ]; then
  echo 'FAIL: DSH identities depend on ambient NIX_PATH' >&2
  exit 1
fi
printf '%s\n' 'PASS: Nix syntax, poisoned ambient pkgs/lib, and channel-independent identities'
printf '%s\n' "$baseline"
