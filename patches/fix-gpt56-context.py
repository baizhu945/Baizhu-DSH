#!/usr/bin/env python3
"""修复 dsh 内置 pi-ai GPT-5.6 目录的上下文长度。

pi-ai 同时维护 OpenAI API 和 OpenAI Codex（ChatGPT OAuth）两套目录。
两套目录都把 GPT-5.6 价格分层的 272000 阈值误当成了 contextWindow；
DSH 的 OpenAI 账号默认走 openai-codex，因此只修改 openai.json 不会生效。
这里统一把 dsh 内置 GPT-5.6 系列的上下文窗口恢复为 1050000。

Codex preset 使用的官方 snake_case 模型目录由其自己的 patch 处理。
"""

import json
import os


CATALOGS = (
    "node_modules/@earendil-works/pi-ai/dist/providers/data/openai.json",
    "node_modules/@earendil-works/pi-ai/dist/providers/data/openai-codex.json",
    "node_modules/@earendil-works/pi-ai/src/providers/data/openai.json",
    "node_modules/@earendil-works/pi-ai/src/providers/data/openai-codex.json",
)
TARGET_CONTEXT_WINDOW = 1_050_000
BROKEN_CONTEXT_WINDOW = 272_000


def is_gpt56(model_id: str) -> bool:
    return model_id == "gpt-5.6" or model_id.startswith("gpt-5.6-")


def model_entries(doc: object):
    # pi-ai catalogs are grouped dictionaries.
    if isinstance(doc, dict):
        for models in doc.values():
            if not isinstance(models, dict):
                continue
            for model_id, model in models.items():
                if isinstance(model_id, str):
                    yield model_id, model


def fix_catalog(catalog: str) -> int:
    if not os.path.exists(catalog):
        return 0

    with open(catalog, "r", encoding="utf-8") as fp:
        doc = json.load(fp)

    changed = 0
    for model_id, model in model_entries(doc):
        if not isinstance(model, dict) or not is_gpt56(model_id):
            continue

        if model.get("contextWindow") == BROKEN_CONTEXT_WINDOW:
            model["contextWindow"] = TARGET_CONTEXT_WINDOW
            changed += 1

    if changed:
        with open(catalog, "w", encoding="utf-8") as fp:
            json.dump(doc, fp, ensure_ascii=False)
    return changed


def main() -> None:
    seen = set()
    existing = 0
    total = 0
    for catalog in CATALOGS:
        if os.path.abspath(catalog) in seen:
            continue
        seen.add(os.path.abspath(catalog))
        if os.path.exists(catalog):
            existing += 1
        changed = fix_catalog(catalog)
        total += changed
        print(f"dsh: fixed GPT-5.6 context metadata in {catalog}: {changed} fields")

    if existing == 0:
        raise SystemExit("dsh: no GPT model catalogs found to patch")
    print(f"dsh: fixed GPT-5.6 context metadata: {total} fields in {existing} catalogs")


if __name__ == "__main__":
    main()
