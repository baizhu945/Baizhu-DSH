# Opt-in native live validation

`verify.sh` and `codex-*.test.mjs` **never run this harness**. Ownership here is limited to `live-native-host.mjs`, `live-support.mjs`, and this document; production bridge/Core/Nix changes belong to the parent.

## CLI and authorization

From `presets/codex`:

```sh
bash verify-live.sh --preflight
bash verify-live.sh --live-bootstrap
```

No arguments also means preflight. Both commands are offline: no credential-store construction/read, native app-server, auth API, or model call. Discovery performs a local `codex --version` query and forwards that actual version as `config.runtimeVersion`; an explicit official control binary does not inherit the private build's version. Dependencies/modules remain pinned across new Context mounts.

Preflight checks installed store paths/catalog/CodeMode companion, three local filesystem-boundary probes, real Cordis services, preset ownership, model metadata, commands, JSONL persistence, and cold SessionController restore. `--live-bootstrap` additionally imports the real auth dependency graph with forbidden in-memory callbacks, mounts the actual production installer twice, and cold-restores **canonical advertised tool-call/result history, native CodeMode metadata, and replacement surfaces**. This fixture is synthetic, not a claim that production native observations are correctly serialized.

Only the parent/caller may authorize actual model requests after auditing:

```sh
DSH_CODEX_ALLOW_LIVE=1 bash verify-live.sh --allow-live --task9-audited \
  --suite lifecycle --max-tokens 200000 --max-generations 14
```

Options:

```text
--suite all|tools|lifecycle|safety|features|approvals   # default all
--dsh-root STORE_ROOT
--binary STORE_BINARY
--catalog STORE_CATALOG
--deadline-seconds 900             # 30..1800
--max-generations 48               # 1..80
--max-tokens 100000                # 1..250000 per run
--xhigh                           # optional brief case; all/safety/approvals only
```

Every suite creates a new confined workspace/session and nonce. No arbitrary artifact-resume path is accepted, and lifecycle/safety do not replay the expensive initial tools phase. Unselected categories are `not-selected`; missing selected feature execution is `unexercised`, never PASS. Exit codes: `0` offline pass or selected live categories passed; `1` refused/stopped; `2` failed/incomplete live coverage. Original-provider generation is blocked before HTTP.

### Disjoint coverage

All suites require real native login/model routing and rpcId-idempotent SessionController admission. Main effort is low; PLAN questions use medium.

| Suite | Additional selected cases |
| --- | --- |
| tools | exec/store/load/yield/wait; shell PTY/stdin; apply_patch/readback; synthetic image intake/CodeMode display; long-output/UI/replay/standard isolation |
| lifecycle | Default-config utility availability; PLAN request_user_input; cold JSONL/native-thread resume; one V2 fork/message/wait with inherited nonce; official compaction/nonce recall |
| features | Lifecycle with only the official `tools.update_plan.enabled=true` option enabled in the isolated native thread; production defaults unchanged |
| safety | read-only denial; exact one-action approval; cancellation/recovery; optional xhigh |
| approvals | Targeted one-action approval and optional completed xhigh, without repeating denial/cancellation |
| all | Union of the original three; expensive and not recommended for diagnosis |

Upstream 0.162 disables `update_plan` by default. Its optional configuration is tested separately in DEFAULT, **not requested in PLAN where it is forbidden**. `functions.request_user_input` and `collaboration.*` are native top-level/DirectModelOnly tools, intentionally absent from the nested `ALL_TOOLS` catalog. V2 uses `fork_turns:"all"`, not V1 `fork_context`; `send_message` does not begin a new turn, and V2 has no `close_agent` function. PLAN question evidence requires the actual native request/broker answer, not a plan notification or prose question. Tools use a fixed literal yielded CodeMode cell, a separate load cell, and a separate literal native-shell readback cell. The bounded long output is 1000 lines (~17 KB), not the former 2000-line request.

Validators inspect paired native `tool/call`/`tool/result` metadata, native output fields, typed notifications, and exact no-symlink filesystem effects. They do not search assistant prose, rendered bodies that echo code, or stringified whole events for success. Nested CodeMode PTY/image/patch evidence is accepted only with executed harness-literal code and its linked successful wait output, plus the required actual file/media effects. Failed/declined native attempts fail the relevant case instead of being mislabeled as unexercised. Cancellation waits for a new native turn and the actual command-start file; nested tools need not expose a commandExecution ThreadItem.

After each completed foreground turn, the harness flushes and opens the actual JSONL backend in read mode. This enforces persisted advertised-tool lifecycle validation **before paying for another prompt**; detached `Session.fromRestore` alone does not enforce it. Cold restart explicitly validates the persisted query before invoking the real controller, preserving the source cause instead of only seeing `gateway/internal`.

## Critical findings from the genuine official 0.159.3 control

Parent-authorized control binary:

```text
/nix/store/ypg56widdyrd7q3rmhc321ia8vzk5g4r-codex-0.159.3/bin/codex
```

Original receipts (not rewritten):

- `/tmp/codex-real-luna-release-control-1.log`
- `/tmp/dsh-codex-live-LF7imf/report.json`

That control completed tools at low (9 observed generations) and PLAN at medium (3): **2 top turns, 12 generations, 188962 native tokens**. It demonstrated genuine login/model/CodeMode activity, but was not a full validation pass. Its old report marked several cases unexercised and stopped at the subsequent cold prompt with `gateway/internal`.

Offline reproduction copied **only that harness-generated synthetic JSONL** into a fresh scratch root, mounted real framework services, and forbade native/auth/provider callbacks:

```text
/tmp/codex-live-cold-debug-report.log
/tmp/dsh-codex-live-cold-debug-eQBrpy
```

Result: detached replay passes; real JSONL/query/controller restore fails with `SESSION_QUERY_CORRUPT_SESSION`. Deepest cause: `SessionFormatError` from `Relationships.tool`: **native tool row has no advertised tool lifecycle**. The first orphan is the native observer's `tool/call` at seq 8; the preceding assistant surface does not advertise that call. The disk format requires an advertised assistant tool-call before tool/call/result. This is a confirmed production serialization incompatibility, not invalid harness prompt mode, native rollout removal, or a reason to delete/repair stored rows in the harness. The production producer has since been fixed: privately marked canonical assistant advertisements precede observed tool calls; both advertisements and results are immediately model-only shadowed. Real released-V4 JSONL admission and cold controller restore now pass; no validator bypass or stored-row deletion is used.

The same synthetic fixture shows shell/PTY commands failing with `error building bubblewrap command: Read-only file system`, a declined patch, a failed wait, and failed write_stdin. These were **actual failures**, not successfully exercised tools merely missed by a validator. The old store/load/yield/wait PASS did not require a successful wait. Image display was not reached, and PLAN performed request_user_input but not update_plan. New validation is stricter and does not retroactively promote this control to PASS.

The outer harness mount used read-only `/tmp`; native nested sandbox setup needs temporary mount-target infrastructure there. It now gets a fresh writable `/tmp` tmpfs, never the host `/tmp`. A separate read-only synthetic work-root tmpfs preserves the sentinel/no-host-directory guarantees while the explicit workspace/native-home/TMP submounts remain writable. All three offline probes pass. This mount fix and production serialization fix were subsequently verified by the parent with actual private 0.162.0-alpha.11 Luna tool requests; the complete tools suite passed.

Latest canonical tool-rich offline bootstrap receipt:

```text
/tmp/codex-live-bootstrap-toolrich-report.log
/tmp/dsh-codex-live-XX4Nby/report.json
```

It passes both fresh mounts and canonical tool-rich cold replay with `binaryVersion: 0.159.3`, zero native starts, zero credential/auth/model/provider calls, and zero generations/tokens. This does not negate the orphan production-history failure above. No API/auth/model calls were made during this debugging work.

### Aggregate budget planning

The user has confirmed there is **no quota ceiling** and authorized exhaustive live validation. Per-invocation `--max-tokens`, `--max-generations` and `--deadline-seconds` remain as operational limits that keep a single run interruptible and diagnosable; they are not a spending authorization boundary. Prefer a targeted `--suite` over replaying an expensive case that already passed.

Observed usage is a receipt, not a dollar-cost meter: cumulative input, cached input, native child threads and usage-counter resets all contribute, and HTTP attempts failing before usage reporting cannot be counted at all. Caps close native clients, but in-flight work may overshoot slightly. Observed generations are a lower bound. More than one child thread stops a run.

### Official opt-in configuration facts (verified offline against the real alpha core)

- Upstream 0.162 keeps `update_plan` **disabled by default**. With `tools.update_plan.enabled=true` it appears only as a nested CodeMode tool documented inside the `exec` description (and `ALL_TOOLS`); it never becomes a top-level function or namespace. Regression: `native-live-update-plan.test.mjs` (authless loopback, no model calls).
- `functions.request_user_input` and `collaboration.*` are `DirectModelOnly`/top-level and are intentionally absent from nested `ALL_TOOLS`; searching `ALL_TOOLS` for them is a harness error, not an upstream bug.
- Alpha offers a three-element `proposedExecpolicyAmendment` **automatically** for escalated command approvals. Offering is not accepting: the one-shot broker compares the exact trusted shell argv, cwd, kind, phase and unconsumed counter, allows only the explicit `accept` decision, and never amendment/session acceptance, network grants or extra permissions (`exactOneActionCandidate`, `native-live-approval.test.mjs`).

## Boundary, authentication, and diagnostics

Native app-servers and their subprocess trees stay inside an outer bubblewrap boundary: read-only root/discovered Nix closures, isolated namespaces, dropped capabilities, essential resolver/hosts/CA/time files, generated workspace/native state, private native HOME/TMP, and read-only generated image attachments. Host DSH session/config/storage/credential directories and personal directories are not mounted. Workspace probes hold a directory inode and reject symlinks/nonregular files.

Canonical `CredentialFile` construction occurs only after both live confirmations and preflight. Real `createNativeAuth` uses the existing store lock/write protocol; refresh tokens are not copied. External auth travels only over native JSON-RPC stdin; native auth persistence is prohibited. Unknown requests, permissions/network grants, and persistent rules are denied. Only the exact synthetic one-action command may receive allowed-once: the approval must offer a three-element exec-policy argv that is exactly `<trusted store shell> -c <fixed synthetic script>`, the rendered command must equal that argv, and the broker may select only the explicit `accept` decision (never amendment/session acceptance, network grants or extra permissions). Without that offered argv the gate fails closed. Question answers use the actual SDK schema: `custom` is omitted or a string, never an array.

Networking is shared for official backend traffic; there is no CONNECT proxy/domain firewall. The harness uses no alternate model, provider endpoint override, TLS interception, or fake generation service.

Console, raw stdout/stderr, auth/provider errors, environment, RPC payloads, account identities, and arbitrary exception messages/stacks remain suppressed. Reports expose fixed restore-error grammar and **allowlisted public source function names only**, following bounded cause chains. Opaque errors stay opaque. Synthetic JSONL/native rollout artifacts remain private; aggregate report.json contains no auth responses.

The real SessionController is in-process, not browser WebSocket/DOM transport. UI assertions use installed pure projection models; standard isolation does not generate with the standard provider. No install/build/activation/commit or global Codex/config edit is performed by this harness.

## Final real GPT-6 Luna results (private 0.162.0-alpha.11)

Every category below was exercised against the real account and the private runtime, each in its own confined workspace, with per-run generation/token/deadline caps. Receipts: `/tmp/codex-real-luna-private-{tools-2,safety-1,features-2,subagent-6,compaction-1,questions-2,approvals-1,approval-once-2}.log`.

| Category | Result | Key evidence |
| --- | --- | --- |
| login / model-routing | pass | native `account/login/start` per session; zero original-provider calls |
| Code Mode store/load/yield/wait | pass | literal yielded cell, real `wait` completion, separate `load` cell |
| shell PTY / stdin | pass | `read line` + `write_stdin`, real `pty.txt`/`shell.txt` effects |
| apply_patch + readback | pass | real `patch.txt` change plus native shell readback |
| image intake + Code Mode display | pass | admitted PNG and `Image:` output inside the cell |
| long output / UI / replay / standard isolation | pass | 17000 native bytes, 10 readable cards, standard scope clean |
| read-only denial | pass | real read-only failure, no file created |
| cancellation + recovery | pass | `turn/interrupt` after real start, later turn healthy |
| one-action approval | pass | exactly one allowed-once, no session/amendment grant |
| brief xhigh | pass | xhigh route selected and honored |
| cold restart / native thread resume | pass | disk flush, remount, same native thread resumed |
| nested `update_plan` (official opt-in) | pass | real nested call plus `turn/plan/updated` |
| plan-mode question | pass | real `item/tool/requestUserInput`, harness answer used |
| V2 subagent fork/message/wait | pass | child rollout proves forked context, spawn task marker-free |
| official compaction + recall | pass | real compaction, marker recalled afterwards |

Model-level observations that are recorded but never used as pass criteria: whether the forked child re-reported the inherited marker, and whether a long conversation preserved it across compaction. Both varied between runs while the underlying delivery evidence stayed correct.

### User-global instructions

`mirrorUserInstructions` copies the DSH user-global instruction file into the private native
home so the official core loads it through its own native path. Candidates follow DSH exactly
(`AGENTS.md`, `CLAUDE.md`, `AGENTS.local.md`, `CLAUDE.local.md`, concatenated in that order with
trimmed duplicates collapsed), because DSH concatenates rather than overriding. `~/.codex` is used
only when DSH has no such file, an explicitly configured `globalInstructionsHome` keeps native
override precedence, symlinked or oversized files mirror nothing (with a warning) rather than a
partial or escaping prompt, and source removal deletes the mirror. Project `AGENTS.md` discovery
stays entirely upstream from the session cwd. Regression: `native-user-instructions.test.mjs`.
Live proof (`--suite instructions`, receipt `/tmp/codex-real-luna-private-instructions-3.log`):
with **no** workspace `AGENTS.md`, the model reproduced a marker that exists only in the
user-global file.
