# Independent DSH REA 6.4.0 — 2026-10-13

## DSH host 0.2.1-alpha.2 update acceptance

The REA package remains 6.4.0; this update changes the DSH host and adapters.
Verified CLI SDK: `/nix/store/4n89jfnisg7b5qawrnrv3znhn17560qr-dsh-0.2.1-alpha.2`.
The runtime now starts MCP in the Session's effective working directory rather
than its immutable original header. The SDK fixture mounts the new directory
owner and global `working_directory` tool. Complete-request comparisons normalize
only the sampled timestamp of an attributed `time-context` message and its
matching section; browser zone, elapsed facts, turn/step and other content remain
exact. User text resembling that timestamp is never normalized.

All five fixture suites passed, including native/ptc host defaults and late
global tool registration/removal without native Codex capability leakage.
Selected-root MCP cwd, 187 tools, child/root isolation, unchanged non-REA
surfaces, startup cancellation, physical process cleanup and permission/approval
gates passed. The required Nix regression derivation also passed in the parent
Home Manager build; activation is verified separately by the parent.

Real acceptance used the declared REA executable, Ghidra 12.1.4 and JDK 21:
catalog187, complete static JavaScript, offline EVM complete/summary and retained
Evidence paging, a compiled tiny C executable, procedures and pseudocode all
passed through real DSH ToolRuntime/ApprovalService. No paid model or real
account was used. This is not an all-187-operation execution claim.

Task receipts: `work/dsh-update/compat-rea-final-fixtures.log` and
`work/dsh-update/compat-rea-real-acceptance.log`; synthetic real-analysis artifacts:
`/tmp/dsh-rea-test-JED5AJ`.

## Prior REA package update receipt

Prior traditional Home Manager build/switch: **generation2155**,
`/nix/store/b2wgak02yc7qa8mry8n16x06k17m18nc-home-manager-generation`.
GitHub checkpoint checked at task start:
`a2d8b94dd50dab8d966239dd63ab84718aa8b4b4` / package6.4.0.
Current DSH package:
`/nix/store/by9bpkq4ww2h02qpm37glhrlc7ainmq4-rea-agents-6.4.0`.

The local schema portability patch is retired from the recipe: all relevant
canonical pattern fixes are upstream. Full official MCP input/output schemas
remain independently audited withJS/Rust andAJV/Zod;187 exact canonical names/
effects,1346 pattern occurrences/105 unique patterns pass. Six prompts unchanged.
Startup validation is now strict decimal/fail-closed. Existing30min provider /
31min MCP /8G heap is unchanged. No other client configuration/file imports.

New compile+runtime bundle+skills generation and complete bridge/dist-worker/
package-import/license/notice assets are installed. Private procps ps fixes
owned-child launch preflight on Nix; explicit limiter paths cover JS/EVM and
configured optional analysis lanes. Foreign optional musl CSS is not a selected
GNU runtime and is the sole prebuild missing-lib exemption. No optional
Frida/ADB/JEB/Python/TShark/sigrok/Hopper/IDA engine is installed or activated.

Package install gates pass: actual187/6 production stdio doctor/catalog identity,
Ghidra config/factory/cancellation, all full-profile schemas and readonly bounded
native SQLite selected-column sample with originalSHA/no source sidecars.

Deployed CLI/TUI Host SDK and Desktop exact peer graph both pass full suites:
- Every discovered nonREA preset standard/ptc/minimal/cordis/codex has complete
  tool/schema/prompt/TS+PythonSDK/first-request equality and zero coldMCP spawn.
- Independent parallel roots, child exclusion, blank switch/preset lock,
  malformed/failure rollback, initialize/list cancellation/physical cleanup,
  original approval and permission gates preserved.
- Actual DSH ToolRuntime/ApprovalService complete staticJS analysis, Ghidra12.1.2
  function recovery/decompile, EVMole inference, new summary receipt and retained
  bytecode-page retrieval all pass. Native Evidence producer identity is checked
  using6.4's direct Evidence representation, not the old envelope.
- Codex74 source/immutable runtime files remain byte-equal to preupdate hashes.
  Global instructions retain their originalSHA, defaults and model settings intact.

Logs: `/tmp/rea64-dsh-package-build.log`, `/tmp/rea64-home-manager-build.log`,
`/tmp/rea64-home-manager-switch.log`, `/tmp/rea64-dsh-deployed-functional.log`,
`/tmp/rea64-dsh-desktop-functional.log`.

No paid model/real credentials in these DSH suites; tested hostSDK, not a full
ElectronGUI click-through.187 catalog operations are not an all-operation or
all-platform execution claim. Ordinary headless remains unchanged. Restart DSH
and selectREA in a new session to replace an already-running connection.
Older6.1/SCHEMA-VERIFICATION reports are historical, not this deployment state.
