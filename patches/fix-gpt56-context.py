#!/usr/bin/env python3
"""修复 pi-ai 内置 GPT-5.6 目录的上下文长度。

pi-ai 0.82.1 把 GPT-5.6 的 OpenAI / OpenAI Codex 条目错误地写成
272000；这个数是价格分层的 inputTokensAbove 阈值，不是模型上下文上限。
OpenRouter 的公开模型目录对同一系列报告 1050000，上游条目应与之保持一致。
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
