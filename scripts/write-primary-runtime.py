#!/usr/bin/env python3
"""Record the primary runtime payload's Python environment for DSH Desktop.

The Desktop Host reads `<primaryRuntime>/runtime.json` and hands `dependencies/python`
and its `site-packages` path to Office skills through `load_workspace_dependencies`.
Every distribution version is resolved from the exact interpreter this payload points
at, so the recorded map can never drift from what a skill will actually import.

Names are normalized the way `tool-workspace-dependencies` normalizes them, and every
recorded version is validated against the same pattern that parser applies, so a
generated manifest is always one the Host accepts.
"""

from __future__ import annotations

import importlib.metadata as metadata
import json
import re
import sys
from pathlib import Path

NAME_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
VERSION_PATTERN = re.compile(r"\d[\w.!+-]*")
DIGEST_PATTERN = re.compile(r"[a-f0-9]{64}")
VERSION_LINE_PATTERN = re.compile(r"\d+\.\d+\.\d+(?:[-+][\w.-]+)?")
PYTHON_ABI_PATTERN = re.compile(r"\d+\.\d+")


def normalized_distributions() -> dict[str, str]:
    """Resolve every distribution the active interpreter can import."""
    resolved: dict[str, str] = {}
    for distribution in metadata.distributions():
        raw = (distribution.metadata["Name"] or "").strip()
        if not raw:
            continue
        key = re.sub(r"[-_.]+", "-", raw.lower())
        version = (distribution.version or "").strip()
        if key in resolved and resolved[key] != version:
            raise SystemExit(f"ambiguous distribution {key}: {resolved[key]} != {version}")
        resolved[key] = version
    return resolved


def build_manifest(arguments: list[str]) -> tuple[dict[str, object], list[str]]:
    """Validate every argument the caller owns, then assemble the manifest."""
    manifest_path = Path(arguments[0])
    payload_digest = arguments[1]
    desktop_version = arguments[2]
    python_version = arguments[3]
    node_version = arguments[4]
    pnpm_version = arguments[5]
    required = json.loads(Path(arguments[6]).read_text(encoding="utf-8"))

    if not DIGEST_PATTERN.fullmatch(payload_digest):
        raise SystemExit(f"payload digest is not a sha256 hex digest: {payload_digest}")
    for label, value in (
        ("desktopVersion", desktop_version),
        ("python", python_version),
        ("node", node_version),
        ("pnpm", pnpm_version),
    ):
        if not VERSION_LINE_PATTERN.fullmatch(value):
            raise SystemExit(f"{label} is not a version line: {value}")
    # tool-workspace-dependencies derives the site-packages path from the first two
    # components of the recorded Python version.
    if PYTHON_ABI_PATTERN.fullmatch(python_version):
        raise SystemExit(f"python version needs major.minor.patch: {python_version}")

    distributions = normalized_distributions()
    for name, version in distributions.items():
        if not NAME_PATTERN.fullmatch(name):
            raise SystemExit(f"invalid distribution name: {name}")
        if not VERSION_PATTERN.fullmatch(version):
            raise SystemExit(f"invalid distribution version: {name}=={version}")

    missing = [name for name in required if name not in distributions]
    if missing:
        raise SystemExit(f"missing required distributions: {missing}")

    return {
        "desktopVersion": desktop_version,
        "platform": "linux",
        "arch": "x64",
        "payloadDigest": payload_digest,
        "python": python_version,
        "node": node_version,
        "pnpm": pnpm_version,
        "pythonPackages": dict(sorted(distributions.items())),
    }, required


def main() -> int:
    """Write the manifest and report each required distribution to the build log."""
    manifest, required = build_manifest(sys.argv[1:])
    packages: dict[str, str] = manifest["pythonPackages"]  # type: ignore[assignment]
    for name in required:
        print(f"primary runtime: {name}=={packages[name]}", file=sys.stderr)
    manifest_path = Path(sys.argv[1])
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"primary runtime: recorded {len(packages)} distributions", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())