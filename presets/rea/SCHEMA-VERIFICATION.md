# DSH REA schema portability verification

## REA 6.8.0 schema audit — package gates pass

Pin: `160d821ac9a0310afcb8d1fc427862dd6508add5`. The old local 6.1 projection
patch was deleted. REA 6.8's canonical schemas include one request-path
lookahead; `schema-portability-6.8.patch` rewrites it to an equivalent
Rust-compatible expression. The MCP server defaults to compact input-schema
advertisements, so the DSH integration explicitly selects
`REA_MCP_INPUT_SCHEMA_PROFILE=full` for nested constraints and PTC SDK parity.

The installed-package schema gate passes for 229 tools, all 2,333 pattern
occurrences (145 unique patterns), JavaScript/Rust regex acceptance, and the
live canonical/AJV Unicode/newline fixtures. The Nix install check also passes
Ghidra-startup budget validation and the production SQLite MCP smoke on Node
24.22.1. The exact-SDK fixture suite passes against patched DSH 0.2.2: selected
and parallel roots, 229-tool first request, blank recomposition, cancellation,
permission approval, and non-REA surface equality. It ran without `realReaExe`,
so it does not establish target Ghidra/JS/EVM acceptance. Real Codex list/schema
admission remains the parent's compatibility gate; JS/Rust parsing alone cannot
prove that client integration.

## Historical 6.1.0 deployed verification — 2026-10-09

Traditional Home Manager build/switch completed at generation2151:
`/nix/store/mawrvf5amvjl1ayyqbbh6mymkw4h7w8d-home-manager-generation`.
Independent DSH REA6.1.0 package:
`/nix/store/2dqf5yz2nwc7sqm5jw1vzq5mn7bvc6r8-rea-agents-6.1.0`.

DSH shipped the same upstream ObjC-name pattern `^[^\s[\]]+$` and forwards it
as model parameters, so strict-regex schema rejection risk was shared. The local
`schema-portability.patch` is applied before TypeScript compilation. Its local
`tests/schema-portability.mjs` has no other client configuration dependency.

Equivalent bracket escaping and known NUL spelling normalization avoid invalid
Rust regex syntax. Two lookahead constraints become JSON Schema not/allOf;
reserved run-token names and invalid relative roots remain prohibited. Runtime
canonical validation, effects/permissions, tool names and138-tool count stay.
Examples, descriptions, defaults and other data are not traversed as schemas.

Both actual input/output projections:1171 pattern occurrences,91 unique patterns
compile inJS/Rust. CanonicalZod versusAJV, Unicode/newline/NUL and ownership/path
rejection cases plus immutability/memoization pass. Gate executes real official
MCP tools/list against the final compiled package, not just source string checks.

Final deployed suites pass on CLI/TUI SDK and Desktop peer graph:
- Every nonREA preset standard/ptc/minimal/cordis/codex complete tools/schema/
  prompt/PTC SDK/first-request equality, zero cold MCP spawn.
- Independent parallel roots, default/delegated child exclusion, blank switch,
  preset lock, malformed/failure rollback, initialize/list cancellation,
  actual approval/permission and physical process teardown.
- True DSH ToolRuntime/ApprovalService JS graph, Ghidra function recovery /
  decompilation and new offline EVMole bytecode inspection.
- Schema names138 and source/runtime Codex hashes unchanged; not a Codex-native
  integration or an automatic REA mode switch. Ordinary headless unchanged.

Logs: `/tmp/rea-regex-dsh-package-build.log`,
`/tmp/rea-regex-home-manager-build.log`, `/tmp/rea-regex-home-manager-switch.log`,
`/tmp/rea-regex-dsh-functional.log`, `/tmp/rea-regex-desktop-functional.log`.

Restart DSH and select REA in a new session to replace the existing connection.
No full Electron GUI click-through or every138-operation execution claim.
