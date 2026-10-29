#!/usr/bin/env python3
"""Qwen3-ASR 的常驻 worker。

Node 通过 stdin/stdout 一行一个 JSON 与它通信：
  {"id": 1, "path": "/tmp/input.wav", "hotwords": ["Elio"]}
  {"id": 1, "text": "……", "elapsedMs": 1234}

模型只在进程启动时加载一次；空闲时由 Node 结束进程来释放内存。
所有库日志都转到 stderr，stdout 只留给协议 JSON。
"""

from __future__ import annotations

import contextlib
import json
import os
import sys
import time
import traceback


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def main() -> None:
    model_name = os.environ.get("EH_ASR_MODEL", "mlx-community/Qwen3-ASR-1.7B-4bit")
    language = os.environ.get("EH_ASR_LANGUAGE", "Chinese").strip() or None
    if language and language.lower() == "auto":
        language = None

    started = time.time()
    try:
        # 库在加载时可能往 stdout 打日志，不能让它污染协议。
        with contextlib.redirect_stdout(sys.stderr):
            from mlx_audio.stt import load
            from mlx_audio.stt.utils import load_audio

            model = load(model_name)
    except Exception as error:
        log(f"模型加载失败：{error}")
        traceback.print_exc(file=sys.stderr)
        print(
            json.dumps(
                {"ready": False, "error": f"模型加载失败：{error}"},
                ensure_ascii=False,
            ),
            flush=True,
        )
        return

    print(
        json.dumps(
            {"ready": True, "loadMs": round((time.time() - started) * 1000)},
            ensure_ascii=False,
        ),
        flush=True,
    )

    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue

        request_id = None
        try:
            request = json.loads(raw)
            request_id = request.get("id")
            path = request.get("path")
            if not isinstance(path, str) or not path:
                raise ValueError("缺少音频路径")

            hotwords = request.get("hotwords")
            if not isinstance(hotwords, list):
                hotwords = []
            hotwords = [str(item).strip() for item in hotwords if str(item).strip()]

            begin = time.time()
            with contextlib.redirect_stdout(sys.stderr):
                audio = load_audio(path, sr=16_000)
                duration_ms = round(float(audio.shape[0]) / 16_000 * 1000)
                result = model.generate(
                    audio,
                    language=language,
                    hotwords=hotwords or None,
                    verbose=False,
                )
                text = getattr(result, "text", "") or ""

            print(
                json.dumps(
                    {
                        "id": request_id,
                        "text": text.strip(),
                        "durationMs": duration_ms,
                        "elapsedMs": round((time.time() - begin) * 1000),
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
        except Exception as error:
            log(f"识别失败：{error}")
            traceback.print_exc(file=sys.stderr)
            print(
                json.dumps(
                    {"id": request_id, "error": f"识别失败：{error}"},
                    ensure_ascii=False,
                ),
                flush=True,
            )


if __name__ == "__main__":
    main()
