# Native Codex preset

The enabled composition runs the **official Codex CLI/app-server core**, pinned
to upstream release-prepared **0.162.0-alpha.11**, commit
`260f9619e07037e307a09eab0ed1bfeee86e725d`. It is not a DSH reconstruction of
Codex prompts or tools. Its version is the real upstream Cargo version, not a
spoofed request header. A raw main build's `0.0.0` was rejected by the live Luna
backend even though genuine official 0.159.3 successfully generated responses.

## Boundary

- Official Codex owns model requests, instruction roles/order, model switches,
  freeform/Lark tool declarations, Code Mode/V8 cells, media helpers, shell and
  patch execution, network/file sandboxing, permissions, subagents, Skills and
  conversation compaction. DSH does **not** execute these tools a second time.
- Only newly admitted direct user messages and explicit attachment inputs cross
  the bridge. DSH prompts, runtime snapshots, skills catalogs, summaries, tool
  schemas and human-readable result projections never enter native model history.
- DSH remains the human UI. Native events are projected to ordinary terminal,
  patch, search, image and collaboration cards, with readable text fallbacks.
  A path-restricted read-only rollout observer supplies genuine exec/wait/media
  helper outputs absent from ThreadItems; it never executes or fabricates them.
  JSON is used internally for RPC/storage, not as the human tool-body format.
- UI observations are immediately shadowed by empty **model-only** surface
  replacements. Human append-origin cards/replay are retained, but switching
  to standard cannot send orphan native tool outputs to its model/provider.
- All source/configuration changes live under `presets/codex/`. No overlay,
  global Codex executable replacement, shared provider registration, global
  permission-table modification or shared provider monkeypatch is used. The UI
  patch's new branches recognize only marked native observations; unmarked
  standard calls retain their existing rendering.

The old `codex-model-parity.mjs`, `codex-surface.mjs`, etc. are inactive reference
implementations. `agent.compat.cordis.yml` exists solely for their regression
suite; it is never mounted by the native composition.

## State and login

Runtime files are confined to `~/.dsh/.agent-presets/codex/`:

- `bin/`: private pinned CLI and its code-mode host, managed by Home Manager.
- `native/`: adjacent immutable ESM modules, managed by Home Manager.
- `native-home/`: the native `CODEX_HOME`, owned by Codex.
- `threads/`: atomic DSH-session/native-thread/delivery/observer journals (mode 0600).

The ordinary global `AGENTS.md` / `AGENTS.override.md` candidates are mirrored
read-only from the user's normal Codex home. Project instructions are discovered
by upstream Codex. Global Codex config, memories, plugins and auth files are not
copied or modified. Native-home settings are independent and can be supplied
through the preset's declarative `nativeConfig` option.

Default authentication uses the existing DSH OpenAI account login
(`/auth login openai-codex` or `/provider`). Access tokens are supplied to the
app-server over stdin as host-managed tokens; token refresh uses the existing
OAuth store's cross-process locking. Tokens are never copied to thread journals,
command-line arguments, UI tool calls, or a separate independently rotating
refresh-token store. The private native auth store is ephemeral. This mode
requires a ChatGPT/OpenAI Codex model; arbitrary DSH provider routes are not
silently translated into equivalent Codex providers.

Advanced users can select `authMode: native`, `modelProvider`, and `nativeConfig`
in this preset's composition to use upstream authentication/provider behavior
inside the private Codex home. These options do not change other presets.

## Context window exception

The official model manager retains its normal **dynamic remote catalog,
bundled catalog, longest-prefix matching and unknown-model fallback**. A forced
`model_catalog_json` would freeze remote model instructions/capabilities, so the
production bridge does not set it.

`patches/fix-gpt56-context.py` remains unchanged. The private runtime's narrowly
scoped context-only patch applies the same two-field rules to resolved model
metadata: GPT-6/GPT-5.6 families (including dotted versions), 272K base and
272K/872K caps become 1,050,000. It changes no prompt, tool, capability, catalog
selection, other model, or global Codex binary. The deployed patched JSON is a
reference/verification artifact, not an authoritative replacement for the live
catalog. A larger client-side window does not guarantee a larger server limit.

This covers **all GPT models**, not just Luna. Real payload comparisons cover
all ten GPT entries in the pinned catalog, the auto-review model, historical
GPT-5.4/5.3-Codex/5.2-Codex/GPT-4.1/GPT-4o, a dated alias and a safe provider
namespace. Older/unknown models use the official tool-aware fallback, never
Luna's instructions. DSH's older advisory metadata cannot veto a GPT alias;
missing metadata uses a temporary middleware route whose original header is
restored before leaving the Codex step.

## Preset-only commands

| Command | Effect |
| --- | --- |
| `/codex-runtime` | Show pinned revision, native home and current native thread. |
| `/codex-permission codex-read-only` | Native read-only sandbox with on-request escalation. |
| `/codex-permission codex-on-request` | Native workspace-write sandbox with on-request escalation. |
| `/codex-permission codex-full-access` | Explicit native full access; approval policy never. |
| `/codex-mode default` / `plan` | Use upstream collaboration-mode instructions on the next turn. |
| `/codex-persistent on` / `off` | Select upstream persistent reasoning effort. |
| `/codex-compact` | Queue official compaction, never DSH summarization or pruning. |
| `/codex-new-thread confirm` | Explicitly start fresh native model history while keeping the visible DSH transcript. |

Without an explicit native profile, standing read-only is preserved; otherwise
workspace-write/on-request is the default, except standing full-access/never.
Native selections are stored in this preset's thread journal, not in the DSH
session's shared permission overrides. Switching back to standard therefore does
not inherit a Codex-only permission selection.

## Existing sessions

Use a **new Codex session** after installing the native preset. A session created
by the old emulation does not contain an authentic native rollout, encrypted
reasoning history or native tool records. The bridge refuses to silently invent
these. `/codex-new-thread confirm` is the explicit alternative: old visible
messages stay in DSH, but are not injected into the fresh native thread.

Native sessions resume by their real Codex thread ID. DSH's mirrored transcript
is never replayed into Codex as a substitute for the native history. Background
control identities, pending compaction and queued async answers are journaled;
control messages are filtered again after loading a journal. Thread reset and
disposal cancel outstanding question lifetimes, so delayed answers cannot enter
a fresh thread. Explicit steering refusals preserve an answer; ambiguous
transport failures are reported for explicit retry rather than silently replayed.

Private state directories must be real, user-owned directories and are repaired
to mode 0700. State/mirrored instruction writes are atomic, synced, mode 0600,
and refuse symlinked paths. These are defensive checks, not protection against
a same-UID process already granted full filesystem authority.

## Verification and honest limits

Run the offline suites with **evaluated, pinned Nix inputs**, not cached store
hashes or a temporary upstream checkout:

```sh
cd ~/.config/home-manager/agent/dsh/presets/codex
bash ./verify.sh
# Optional: validate a separately built DSH before switching it.
bash ./verify.sh /nix/store/…-dsh-0.2.0-rc.2
```

`verification.nix` builds the private core, an independent unpatched upstream
baseline, exact source/catalog fixtures and verification tools. The runner uses
the selected/installed DSH and requires all native integration checks: missing
fixtures fail explicitly, rather than reporting success through skips. It also
checks the compiled context-only exception, not just a patched JSON file.

The private runtime has build/install checks. The bridge suites cover native
protocol framing, authentication locking, session isolation, direct-input
filtering, tool observation, cancellation, resume, permissions and readable
presentation. These tests do not contact a paid model or read real credentials.

Reusing the upstream engine removes the old fake-helper, tool-schema, role,
compaction and sandbox approximations. It does **not** prove universal equality
for every third-party client/UI workflow. In particular, unsupported MCP
elicitation schemas, secret-input surfaces and attestation requests must fail
closed rather than approve or fabricate answers. Background interactions and
platform-specific sandbox behavior require runtime verification. The transport
bounds its queues and cleans its owned POSIX process group; a subprocess that
creates a separate session/process group is outside that fallback containment.
Native interruption/shutdown remains responsible for its shell/PTY descendants.
OAuth callers abort promptly, but an abort-ignoring provider holds the credential
rotation lock until it returns; dropping an aborted rotated credential can require
re-login. JWT claims are parsed for routing metadata, not signature verification;
the official backend authenticates the token.

Usage telemetry accumulates native cumulative counters over the whole DSH turn,
not just its last model request. Native remote-v2 compaction does not include all
spending in that particular counter; the bridge does not invent missing usage.
Compare model
requests only with the same model, configuration, user input and native history;
UI branding, storage paths and process ancestry are not hidden or attested.
