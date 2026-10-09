# Independent REA preset acceptance

Current source pin: REA 6.1.0, 138 tools / 6 prompts. `catalog.mjs` records
all exact canonical ordered names; the package install gate checks names/effects
and upstream Ghidra budget parsing/forwarding. Changes from 5.0.0: add
inspect_binary_layout, inspect_recorded_crash, inspect_evm_interface,
observe_native_calls, trace_dylib_resolution; remove set_current_document.
The 134-tool logs and 5.0.0 store paths below are retained historical evidence,
not fresh 6.1.0 validation. New package and exact-SDK fixture runs are pending.

Scope: only this `tests/` directory. No Home-Manager switch, live profile write,
Codex modification, provider installation, REA setup or paid model call.

All scripts use the same arguments:

```sh
node tests/run.mjs <dshRuntimeRoot> <installedReaPresetRoot> [realReaExe]
```

`installedReaPresetRoot` means the directory containing `agent.cordis.yml`,
`preset.yml` and `runtime/rea-runtime.mjs`, not DSH_HOME. It can be an isolated
staging directory; installing/switching Home-Manager is unnecessary.

The complete fixture suite runs without the optional executable. Passing it
also runs real REA acceptance. `run.mjs` reads the supplied deployment's `bin/dsh`
and uses its real Node executable with `--expose-internals` (needed for the
actual profile registrar's Loader API). For standalone scripts, use the same
Node executable/flag. `REA_TEST_FILTER=substring` is an explicit debug-only
subset selector for `fixture-tests.mjs`; skipped cases are never acceptance passes. Example pinned executable:

```
/nix/store/hwwf643bjxj7z2lysv8fk9ayc2fgin0w-rea-agents-5.0.0/bin/rea
```

## Real SDK, not fake DI

`sdk-host.mjs` uses `createRequire` anchored at the supplied actual installation
and imports its Cordis Context/Loader, AgentLoop, AgentPresetRegistry, ToolRuntime,
SystemPrompt, scope primitive, MCP client, sandbox, skills, PTC runtime and other
real host services. The only model provider is a zero-cost `LlmAdapter` which
captures the complete first request and yields a deterministic text reply.
The launcher's original `DSH_CODEX_REQUIRE_ANCHOR` selects every real SDK peer,
including Desktop's independent profile peer graph; temporary native Codex
imports use that same graph, never a second Cordis from the CLI store.
Native Codex is never turned: its genuine plugin composition, DSH assembly,
`nativeConfig`, and source bytehashes are examined instead. No real auth is used.

Every run sets isolated temporary HOME/DSH_HOME/workspace. Shipped standard,
ptc, minimal and cordis compositions come from the exact supplied SDK. All onsite
`.agent-presets` directories and profile-only extra declarations are discovered;
unknown extra presets cannot be silently skipped. Mandatory codex is read from
its installed composition. Source/template compositions containing unresolved
Nix substitutions are not deployable inputs.

The registration-view `tools.schemas()` is canonically ordered by name because
upstream asynchronous activation makes insertion order nondeterministic even
without REA. All schema fields are retained. The complete captured **model
request**, including its real tool order, is compared without sorting. Only
opaque IDs/timestamps/AbortSignal identity are omitted from request comparison.
Prompt, section metadata and generated TS/Python SDK remain exact comparisons.

## Scripts / coverage

- `host-smoke.mjs`: each actual non-REA preset starts clean twice, all tools,
  prompt, schema, TS/Python SDK and complete first requests match.
- `fixture-smoke.mjs`: checks our genuine newline stdio MCP138 fixture against
  the installed actual MCP client, readonly DSH pipeline and physical cleanup.
  This is **not** a claim about the new lazy bootstrap.
- `import-guard.mjs`: monkeypatches Node's public file/probe/process operations
  to throw, synchronizes built-in ESM exports, and imports runtime/registrar.
- `composition-tests.mjs`: actual Desktop generic registrar reads root metadata;
  roster/acquireScope never spawn; all existing model surfaces stay identical;
  separate profile registrar uses same metadata; Web/headless/TUI static shared
  composition constraints, ordinary headless unchanged; immutable Codex source
  SHA-256 inventory.
- `fixture-tests.mjs`: every non-REA preset absent-vs-registered-bootstrap full
  equality, cold roster/lease, selected root first pre-step, 138 tools/first
  request and readonly call, repeat-turn reuse, parallel-root isolation,
  physical cleanup, blank warm/cold REA-to-standard recomposition, first-turn
  selection lock, public `applyChildComposition`/toolFilter, default child
  noninheritance plus GLOBAL skills/AGENTS sentinels, startup failure,
  malformed catalog, initialize/tools-list cancellation, readonly/source-helper
  source/readonly effects authority, approval denial and durable audit pairs;
  actual PermissionPresetService Read Only deny / Full Access allow / Workspace
  ask. Upstream MCP deliberately uses exclusive scheduling rather than treating
  readOnlyHint as a parallel-execution grant.
- `real-acceptance.mjs`: selected actual REA catalog138, static JS fixture graph,
  tiny C fixture compiled by the preinstalled `cc`, Ghidra native analysis and
  pseudocode, all through actual DSH ToolRuntime. JDK/Ghidra/Chromium paths are
  read from deployed Config, never guessed. A fake model alone supplies the
  first request. Each approval is explicitly granted once through the real
  ApprovalService public event during a fixture turn. Results/catalog/complete
  first request/approval audit are saved in temporary artifact files.

Physical liveness is measured with a stdio process ledger and `kill(pid, 0)`,
not merely mocked close calls. The installed MCP SDK uses a transient
`server/discover` probe subprocess before falling back to v1: selected-root tests
count **live owners**, while unselected-preset tests require absolutely **zero
spawn events**, including probes.

## Execution status at handoff

Actual SDK: `/nix/store/asdxh9s7gswydivma3gjk0g697lsc0ky-dsh-0.2.0-rc.2`.
`host-smoke.pass.log` and `fixture-smoke.pass.log` pass. The deployment's actual
Node 22.23.3 + `--expose-internals` was used for the `.actual22.log` files.

The production runtime was copied byte-for-byte into
`/tmp/dsh-rea-preset-stage.bPP2az/runtime/rea-runtime.mjs` with the exact SDK's
standard rows + bootstrap metadata. Staging env paths `/tmp` are fixture-only;
they do **not** claim valid Ghidra/JDK deployment. Fixture overrides supply an
explicit host SDK anchor and public-effects JSON for readonly source operations.

Passing results:
- `non-rea.actual22.log`: all five onsite non-REA presets, full absent vs registered
  tools/prompt/schema/TS+Python SDK/complete-first-request equality, no MCP spawn;
  parallel-root isolation also passed.
- `fixture-tests.actual22.log`: selected root MCP134/readonly pipeline, parallel
  roots, warm and cold blank switch, locked selection, startup fail/malformed.
- `import-guard.actual.log`: runtime and registrar import without application IO
  or probes (Node's own module resolution/load operations are exempted).
- `composition-tests.actual.log`: Desktop actual generic registrar, roster/lease
  no-spawn, exact prior surfaces, profile registrar same metadata, Web/TUI shared
  constraints, unchanged headless and Codex source hashes.
- `approval.actual22.log` and `permissions.actual22.log`: debug subset passes for
  source/read effects, actual approval/audits and all three consequential modes.

**Two initial production runtime regressions found; do not claim full pass:**
1. Child complete first request includes BOTH GLOBAL AGENTS and global skill
   catalog sentinel. Evidence:
   `/tmp/dsh-rea-test-DMX1uR/child-complete-first-request.json` (lines 33 and 83).
   `child.actual22.log` also confirms public toolFilter denial and zero child
   process starts before the GLOBAL assertion.
2. Pending initialize AND tools/list cancellation exceeds 5 seconds; teardown
   also blocks. `cancel-init.actual22.log` and `cancel-list.actual22.log` record
   the exact deadline, then the external 15-second guard ends each debug process.
   Rerun both gated cases after the runtime fix.

Real REA catalog/JS/Ghidra acceptance remains **pending** a real rendered Config.
Run the aggregate against the corrected rendered staging/installed directory
and retain its log/artifacts. All `.mjs` files passed `node --check` at handoff.
