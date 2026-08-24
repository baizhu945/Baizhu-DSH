#!/usr/bin/env python3
"""修复 pi-ai 内置 OpenAI API GPT-5.6 目录的上下文长度。

OpenAI API / OpenRouter 的 GPT-5.6 目录使用 1050000；OpenAI Codex
不是同一目录语义，官方 Codex CLI 当前模型目录明确使用 272000（并以
max_context_window 单独表示可扩展上限）。因此 Codex 目录不在这里改写，
由其上游值保持官方 Codex 语义。
"""

import json
import os


CATALOGS = (
    "node_modules/@earendil-works/pi-ai/dist/providers/data/openai.json",
    "node_modules/@earendil-works/pi-ai/src/providers/data/openai.json",
)
TARGET_CONTEXT_WINDOW = 1_050_000


def main() -> None:
    for catalog in CATALOGS:
        if not os.path.exists(catalog):
            continue
        with open(catalog, "r", encoding="utf-8") as fp:
            doc = json.load(fp)
        changed = []
        for models in doc.values():
            for model_id, model in models.items():
                if model_id.startswith("gpt-5.6-") and model.get("contextWindow") == 272_000:
                    model["contextWindow"] = TARGET_CONTEXT_WINDOW
                    changed.append(model_id)
        if changed:
            with open(catalog, "w", encoding="utf-8") as fp:
                json.dump(doc, fp, ensure_ascii=False)
        print(f"dsh: fixed GPT-5.6 contextWindow in {catalog}: {len(changed)} entries")


if __name__ == "__main__":
    main()
