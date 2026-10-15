# DSH REA schema portability verification

## 6.4.0 upgrade audit (deployment verification pending)

Pin: `a2d8b94dd50dab8d966239dd63ab84718aa8b4b4`, 187 tools / 6 prompts.
The existing locally corrected `schema-portability.patch` is retained unchanged
as a historical artifact, **not applied** to 6.4.0. Upstream now spells ObjC
brackets as `\x5b/\x5d`, NUL as `\x00`, relative-root paths as a segment grammar,
and reserved process environment names as a lookaround-free complement.
No downstream wire projection is needed. This also avoids hashing output
validator identities before rewriting their schemas.

Upstream's root-path grammar intentionally tightens old newline loopholes:
`a\n//b`, `a\n/../b`, `a\n/./b`, `a\n/b/` are now rejected. The live MCP gate
compares advertised constraints to the **new canonical parser**, with exhaustive
short Unicode/newline fixtures, rather than claiming old-language equivalence.
It audits every schema-position input/output pattern with JS Unicode and Rust,
checks exact ordered contracts/effects, and preserves metadata memoization tests.
The 6.1 projection-helper sentinel tests no longer describe production code.

This scoped edit has passed JS syntax, Nix parsing and static catalog checks.
Nix package/install checks and real DSH/Ghidra/JS/EVM/SQLite acceptance require
the parent-built package. Real Codex list/schema admission remains the parent's
compatibility gate; JS/Rust parsing alone is not a claim that it passed.
No Home Manager build/switch was run in this scoped task.

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
