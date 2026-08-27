#!/usr/bin/env python3
"""修复 Codex preset 官方 GPT-5.6 模型目录的上下文长度。

OpenAI Codex 的官方 models.json 使用 snake_case 字段，并把 GPT-5.6
价格分层的 272000 阈值误当成了 context_window，同时留下了较小的
max_context_window 扩展上限。该目录只属于 Codex preset，因此这部分
逻辑不放进 dsh 通用的 pi-ai patch。
"""

import json
import os
import sys

TARGET_CONTEXT_WINDOW = 1_050_000
BROKEN_CONTEXT_WINDOW = 272_000
BROKEN_MAX_CONTEXT_WINDOW = 872_000


def is_gpt56(model_id: str) -> bool:
    return model_id == "gpt-5.6" or model_id.startswith("gpt-5.6-")


def model_entries(doc: object):
    # The official Codex catalog is a top-level {"models": [...]} list.
    if not isinstance(doc, dict) or not isinstance(doc.get("models"), list):
        return

    for model in doc["models"]:
        if not isinstance(model, dict):
            continue
        model_id = model.get("slug") or model.get("id")
        if isinstance(model_id, str):
            yield model_id, model


def fix_catalog(catalog: str) -> int:
    if not os.path.exists(catalog):
        return 0

    with open(catalog, "r", encoding="utf-8") as fp:
        doc = json.load(fp)

    changed = 0
    for model_id, model in model_entries(doc):
        if not is_gpt56(model_id):
            continue

        if model.get("context_window") == BROKEN_CONTEXT_WINDOW:
            model["context_window"] = TARGET_CONTEXT_WINDOW
            changed += 1

        if model.get("max_context_window") in (
            BROKEN_CONTEXT_WINDOW,
            BROKEN_MAX_CONTEXT_WINDOW,
        ):
            model["max_context_window"] = TARGET_CONTEXT_WINDOW
            changed += 1

    if changed:
        with open(catalog, "w", encoding="utf-8") as fp:
            json.dump(doc, fp, ensure_ascii=False)
    return changed


def main() -> None:
    catalogs = tuple(sys.argv[1:])
    if not catalogs:
        raise SystemExit("dsh: Codex context patch requires a models.json path")

    seen = set()
    existing = 0
    total = 0
    for catalog in catalogs:
        absolute = os.path.abspath(catalog)
        if absolute in seen:
            continue
        seen.add(absolute)
        if os.path.exists(catalog):
            existing += 1
        changed = fix_catalog(catalog)
        total += changed
        print(f"dsh: fixed Codex GPT-5.6 context metadata in {catalog}: {changed} fields")

    if existing == 0:
        raise SystemExit("dsh: no Codex model catalogs found to patch")
    print(f"dsh: fixed Codex GPT-5.6 context metadata: {total} fields in {existing} catalogs")


if __name__ == "__main__":
    main()
