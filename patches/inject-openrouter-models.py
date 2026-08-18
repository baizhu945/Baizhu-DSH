#!/usr/bin/env python3
"""把 DeepSeek V4 正式版模型注入 pi-ai 的 OpenRouter 内置目录快照。

dsh 构建锁定的 @earendil-works/pi-ai 内置目录快照早于 0731 / 0813
正式版上线,只收录了 0423 预览版;而 dsh 的模型 discovery 对目录路由
直接短路返回内置目录,从不联网查询 OpenRouter 的 /models 端点。因此
这里在构建期把正式版条目补进 pi-ai 的目录数据文件,重启后 4 个版本
(flash/pro × 预览/正式)都会出现在 dsh 的模型列表中。

用法:inject-openrouter-models.py EXTRA_MODELS_JSON
EXTRA_MODELS_JSON 是 {"<model-id>": {<pi-ai Model 字段>}} 的 JSON。
"""

import json
import os
import sys

CATALOGS = (
    "node_modules/@earendil-works/pi-ai/dist/providers/data/openrouter.json",
    "node_modules/@earendil-works/pi-ai/src/providers/data/openrouter.json",
)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(f"usage: {sys.argv[0]} EXTRA_MODELS_JSON")
    with open(sys.argv[1], "r", encoding="utf-8") as fp:
        extra = json.load(fp)
    for catalog in CATALOGS:
        if not os.path.exists(catalog):
            continue
        with open(catalog, "r", encoding="utf-8") as fp:
            doc = json.load(fp)
        group = doc["openai-completions"]
        added = [model_id for model_id in extra if model_id not in group]
        group.update({model_id: extra[model_id] for model_id in added})
        with open(catalog, "w", encoding="utf-8") as fp:
            json.dump(doc, fp, ensure_ascii=False)
        print(f"dsh: injected {len(added)} DeepSeek V4 stable models into {catalog}")


if __name__ == "__main__":
    main()
