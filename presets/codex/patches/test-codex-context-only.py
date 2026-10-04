#!/usr/bin/env python3
"""Scoped regression probe; no credentials, DSH imports, or active pinned catalog.

python3 test-codex-context-only.py --source /nix/store/...-source \
    --binary /nix/store/...-codex-preset-runtime.../bin/codex \
    --baseline /nix/store/...-unpatched.../bin/codex
Use --source-only before the Nix build completes. Rustc must be Nix-provided.
"""
import argparse
import importlib.util
import itertools
import json
import queue
import re
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent


def source_check(source, tmp):
    original = (source / "codex-rs/models-manager/src/model_info.rs").read_text()
    target = tmp / "models-manager/src/model_info.rs"
    target.parent.mkdir(parents=True)
    target.write_text(original)
    patch = HERE / "codex-context-only.patch"
    applied = subprocess.run(["patch", "--fuzz=0", "-p1", "-d", str(tmp), "-i", str(patch)],
                             text=True, capture_output=True, check=True)
    assert "fuzz" not in applied.stdout and "offset" not in applied.stdout
    added = "\n".join(line[1:] for line in patch.read_text().splitlines()
                      if line.startswith("+") and not line.startswith("+++")) + "\n"
    assert not any(line.startswith("-") and not line.startswith("---")
                   for line in patch.read_text().splitlines())
    assert set(re.findall(r"model\.(\w+)\s*=\s*(?![=])", added)) == {
        "context_window", "max_context_window"}
    assert target.read_text().replace(added, "", 1) == original
    text = target.read_text()
    fn = text[text.index("pub fn with_config_overrides"):text.index(
        "    if let Some(auto_compact_token_limit)")] + "    model\n}\n"
    rust = tmp / "probe.rs"
    rust.write_text('''use std::io::{self, BufRead};
#[derive(Clone, Debug, PartialEq)]
struct ModelInfo { slug: String, context_window: Option<i64>,
    max_context_window: Option<i64>, used_fallback_model_metadata: bool, other: String }
struct ModelsManagerConfig { model_context_window: Option<i64> }
fn opt(s: &str) -> Option<i64> { if s == "-" { None } else { Some(s.parse().unwrap()) } }
''' + fn.replace("pub fn", "fn", 1) + '''
fn main() {
    for line in io::stdin().lock().lines() {
        let line = line.unwrap(); let p: Vec<_> = line.split('\\t').collect();
        let m = ModelInfo { slug: p[0].into(), context_window: opt(p[1]),
            max_context_window: opt(p[2]), used_fallback_model_metadata: p[3] == "1",
            other: "instructions|capabilities|reasoning|source|default".into() };
        let before = m.clone();
        let out = with_config_overrides(m, &ModelsManagerConfig { model_context_window: opt(p[4]) });
        assert_eq!(out.slug, before.slug); assert_eq!(out.other, before.other);
        assert_eq!(out.used_fallback_model_metadata, before.used_fallback_model_metadata);
        println!("{:?}\\t{:?}", out.context_window, out.max_context_window);
    }
}
''')
    subprocess.run(["rustc", "--edition=2024", "-o", str(tmp / "probe"), str(rust)], check=True)
    spec = importlib.util.spec_from_file_location("manual", HERE / "fix-gpt56-context.py")
    manual = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(manual)
    slugs = ["gpt-6", "gpt-6-luna", "gpt-6.1-sol", "gpt-6.2", "gpt-5.6", "gpt-5.6-sol",
             "gpt-5.6.1", "gpt-60", "gpt-6x", "gpt-5.60", "gpt-5.6x", "gpt-5.5", "o3",
             "custom/gpt-6-luna", "a_B-9/gpt-5.6.1", "bad.ns/gpt-6", "/gpt-6",
             "custom/nested/gpt-6", "gpt-6-luna/alias"]
    windows = [None, 272000, 872000, 1050000, 2000000]
    cases = list(itertools.product(slugs, windows, windows, [False, True],
                                   [None, 128000, 900000, 1050000, 2000000]))
    def token(value):
        return "-" if value is None else str(value)
    inputs = "".join("\t".join([slug, token(c), token(m), str(int(f)), token(cfg)]) + "\n"
                     for slug, c, m, f, cfg in cases)
    outputs = subprocess.run([str(tmp / "probe")], input=inputs, text=True,
                             capture_output=True, check=True).stdout.splitlines()
    assert len(outputs) == len(cases)
    for case, output in zip(cases, outputs):
        slug, c, m, fallback, config = case
        match = re.fullmatch(r"[A-Za-z0-9_-]+/([^/]*)", slug)
        canonical = match[1] if match else slug
        if not fallback and manual.needs_extended_context(canonical):
            c = 1050000 if c == 272000 else c
            m = 1050000 if m in (272000, 872000) else m
        if config is not None:
            c = config if m is None else min(config, m)
        expected = "\t".join("None" if v is None else f"Some({v})" for v in (c, m))
        assert output == expected, (case, output, expected)
    print(f"PASS source: zero-fuzz, only two assignments, {len(cases)} Rust/Python parity+clamp cases")


def isolated_env(root, proxy="http://127.0.0.1:9"):
    for name in ("home", "codex", "config", "cache", "tmp"):
        (root / name).mkdir(parents=True, exist_ok=True)
    return {"PATH": "/run/current-system/sw/bin:/usr/bin:/bin", "HOME": str(root / "home"),
            "CODEX_HOME": str(root / "codex"), "XDG_CONFIG_HOME": str(root / "config"),
            "XDG_CACHE_HOME": str(root / "cache"), "TMPDIR": str(root / "tmp"),
            "LANG": "C.UTF-8", "DO_NOT_TRACK": "1", "OTEL_SDK_DISABLED": "true",
            **{k: proxy for k in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy",
                                  "https_proxy", "all_proxy")},
            "NO_PROXY": "localhost,127.0.0.1", "no_proxy": "localhost,127.0.0.1"}


def schema_check(binary, baseline, tmp):
    bundles = []
    for i, executable in enumerate((baseline, binary)):
        root = tmp / f"schema-{i}"
        subprocess.run([str(executable), "app-server", "generate-json-schema", "--experimental",
                        "--out", str(root / "schema")], env=isolated_env(root), check=True)
        bundles.append({str(p.relative_to(root / "schema")): json.loads(p.read_text())
                        for p in (root / "schema").rglob("*.json")})
    assert bundles[0] == bundles[1], "The protocol/schema must not change"
    schema = bundles[1]
    props = schema["v2/ModelListResponse.json"]["definitions"]["Model"]["properties"]
    assert not any("context" in name.lower() for name in props)
    config = schema["v2/ConfigReadResponse.json"]["definitions"]["Config"]["properties"]
    assert "model_context_window" in config
    usage = schema["v2/ThreadTokenUsageUpdatedNotification.json"]["definitions"]
    assert any("modelContextWindow" in definition.get("properties", {}) for definition in usage.values())
    print(f"PASS schema: {len(schema)} unchanged JSON schemas; model/list has no capacity field")


class Mock(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        if self.path != "/v1/responses" or self.headers.get("Authorization"):
            self.server.errors.append("unexpected route or credentials")
            self.send_error(403)
            return
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.requests.append(body)
        events = [{"type": "response.created", "response": {"id": "local"}},
                  {"type": "response.output_item.done", "item": {"type": "message",
                   "id": "answer", "role": "assistant", "content": [
                       {"type": "output_text", "text": "capacity probe"}]}},
                  {"type": "response.completed", "response": {"id": "local", "usage": {
                   "input_tokens": 10, "output_tokens": 3, "total_tokens": 13}}}]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        for event in events:
            self.wfile.write(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n".encode())


class AppServer:
    def __init__(self, binary, root, mock, window=None, catalog=None):
        root.mkdir(parents=True, exist_ok=True)
        (root / "workspace").mkdir()
        self.cwd = str(root / "workspace")
        self.messages, self.notifications, self.logs = queue.Queue(), [], []
        self.id = 0
        env = isolated_env(root, f"http://127.0.0.1:{mock.server_port}")
        config = ['model_provider = "mock"', 'web_search = "disabled"',
                  '[model_providers.mock]', 'name = "local authless probe"',
                  f'base_url = "http://127.0.0.1:{mock.server_port}/v1"',
                  'wire_api = "responses"', 'requires_openai_auth = false',
                  'request_max_retries = 0', 'stream_max_retries = 0',
                  'stream_idle_timeout_ms = 5000']
        if window is not None:
            config.insert(0, f"model_context_window = {window}")
        if catalog is not None:  # Explicit fixture ONLY; normal runs never force a catalog.
            config.insert(0, f"model_catalog_json = {json.dumps(str(catalog))}")
        (root / "codex/config.toml").write_text("\n".join(config) + "\n")
        self.child = subprocess.Popen([str(binary), "app-server"], cwd=self.cwd, env=env,
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE, text=True)
        def reader():
            for line in self.child.stdout:
                self.messages.put(json.loads(line))
        def stderr():
            self.logs.extend(self.child.stderr)
        threading.Thread(target=reader, daemon=True).start()
        threading.Thread(target=stderr, daemon=True).start()
        self.rpc("initialize", {"clientInfo": {"name": "context_probe", "version": "1"},
                                "capabilities": {"experimentalApi": True}})
        self.send({"method": "initialized"})

    def send(self, msg):
        self.child.stdin.write(json.dumps(msg) + "\n")
        self.child.stdin.flush()

    def until(self, predicate):
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            try:
                message = self.messages.get(timeout=max(0.01, deadline - time.monotonic()))
            except queue.Empty:
                raise AssertionError("app-server timeout: " + "".join(self.logs[-8:]))
            if "method" in message:
                self.notifications.append(message)
            if predicate(message):
                return message
        raise AssertionError("app-server timeout")

    def rpc(self, method, params):
        self.id += 1
        self.send({"id": self.id, "method": method, "params": params})
        msg = self.until(lambda msg: msg.get("id") == self.id)
        assert "error" not in msg, msg
        return msg["result"]

    def capacity(self, model, thread=None):
        if thread is None:
            thread = self.rpc("thread/start", {"model": model, "modelProvider": "mock",
                "cwd": self.cwd, "approvalPolicy": "never", "sandbox": "workspace-write"})["thread"]["id"]
        self.notifications.clear()
        turn = self.rpc("turn/start", {"threadId": thread, "model": model,
            "input": [{"type": "text", "text": "Report the local probe.", "text_elements": []}]})["turn"]
        self.until(lambda m: m.get("method") == "turn/completed"
                   and m["params"]["turn"]["id"] == turn["id"])
        usages = [n["params"]["tokenUsage"]["modelContextWindow"] for n in self.notifications
                  if n.get("method") == "thread/tokenUsage/updated" and n["params"]["threadId"] == thread]
        assert usages, self.notifications
        return usages[-1], thread

    def close(self):
        self.child.stdin.close()
        try:
            self.child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.child.kill()
            self.child.wait()


def native_check(binary, baseline, source, tmp):
    mock = ThreadingHTTPServer(("127.0.0.1", 0), Mock)
    mock.requests, mock.errors = [], []
    threading.Thread(target=mock.serve_forever, daemon=True).start()
    rows = json.loads((source / "codex-rs/models-manager/models.json").read_text())["models"]
    by_slug = {row["slug"]: row for row in rows}
    models = [row["slug"] for row in rows if row["slug"].startswith(("gpt-6", "gpt-5.6"))]
    snapshots = []
    try:
        for i, executable in enumerate((baseline, binary)):
            server = AppServer(executable, tmp / f"native-{i}", mock)
            try:
                config = server.rpc("config/read", {"includeLayers": True})["config"]
                assert config.get("model_context_window") is None
                assert config.get("model_catalog_json") is None
                listed = server.rpc("model/list", {"includeHidden": True})
                snapshots.append(listed)
                assert {m["model"] for m in listed["data"]} >= set(models + ["gpt-5.5"])
                capacities = {}
                for model in models + ["gpt-5.5", "custom/gpt-6-luna", "gpt-6-unknown"]:
                    # Longest-prefix matching resolves gpt-6-unknown to fallback if no base slug exists.
                    row = by_slug.get(model.removeprefix("custom/"))
                    expected = (1050000 if i and row and model != "gpt-5.5" else 272000) * 95 // 100
                    actual, thread = server.capacity(model)
                    assert actual == expected, (model, actual, expected)
                    capacities[model] = actual
                    if model == "gpt-6-luna":
                        again, _ = server.capacity(model, thread)
                        assert again == actual, "Native capacity must survive continuation"
                        switched, _ = server.capacity("gpt-5.5", thread)
                        assert switched == 272000 * 95 // 100, "Model changes must replace native capacity"
                print(f"PASS native {'patched' if i else 'baseline'}: {json.dumps(capacities, sort_keys=True)}")
            finally:
                server.close()
        assert snapshots[0] == snapshots[1], "All live/bundled model-list metadata must remain official"
        server = AppServer(binary, tmp / "manual", mock, 2000000)
        try:
            config = server.rpc("config/read", {})["config"]
            assert config["model_context_window"] == 2000000, "Config read reports the user's request, not effective capacity"
            assert server.capacity("gpt-6-luna")[0] == 1050000 * 95 // 100
            assert server.capacity("gpt-5.5")[0] == 272000 * 95 // 100
        finally:
            server.close()
        # An explicit official-shaped remote fixture must use the same context-only hook.
        remote = json.loads((source / "codex-rs/models-manager/models.json").read_text())
        for row in remote["models"]:
            if row["slug"] == "gpt-6-luna":
                row["max_context_window"] = 272000
                row["effective_context_window_percent"] = 87
        fixture = tmp / "remote.json"
        fixture.write_text(json.dumps(remote))
        server = AppServer(binary, tmp / "remote", mock, 900000, fixture)
        try:
            assert server.rpc("config/read", {})["config"]["model_context_window"] == 900000
            assert server.capacity("custom/gpt-6-luna")[0] == 900000 * 87 // 100
        finally:
            server.close()
        assert not mock.errors, mock.errors
        print("PASS native: official model/list unchanged; config/read vs effective clamp; namespace, fallback, remote fixture, thread lifetime")
    finally:
        mock.shutdown()
        mock.server_close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--source-only", action="store_true")
    parser.add_argument("--binary", type=Path)
    parser.add_argument("--baseline", type=Path)
    args = parser.parse_args()
    if not args.source_only and not (args.binary and args.baseline):
        parser.error("--binary and --baseline are required unless --source-only")
    with tempfile.TemporaryDirectory(prefix="codex-context-only-") as directory:
        tmp = Path(directory)
        source_check(args.source, tmp / "source")
        if not args.source_only:
            schema_check(args.binary, args.baseline, tmp)
            native_check(args.binary, args.baseline, args.source, tmp)


if __name__ == "__main__":
    main()
