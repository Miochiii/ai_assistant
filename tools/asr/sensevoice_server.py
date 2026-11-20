#!/usr/bin/env python3
"""sensevoice_server.py — OpenAI `/audio/transcriptions` 方言的薄壳，跑 sherpa-onnx 的 SenseVoice。

为什么要有这个文件：

  `dsh-watch-together` / `dsh-video-storyboard` 的台词层只认一个契约（见依赖包里的
  docs/asr-contract.md）：

      POST {baseUrl}/audio/transcriptions      multipart：file / model / response_format / language / hotword
      → { text, model, language, segments:[{start,end,text}] }   **start/end 相对本次上传的音频**

  它自己会用 ffmpeg 把视频切成 ≤45 秒、切点落在静音中间的 16k 单声道 WAV 再发过来。
  所以这里**不需要**再切长音频，只需要：收 WAV → 识别 → 给出相对时间戳。

  sherpa-onnx 的 SenseVoice 只吐整段文字、没有词级时间戳。为了仍然给出"逐句"的时间码，
  这里做一个很小的能量 VAD：先按静音把这一片切成若干语音区间，逐区间识别，区间边界就是
  句子的 from/to。VAD 找不到区间但整片确实有声音时，退回"整片一句"，绝不吞掉内容。

依赖：sherpa-onnx（pip），numpy（项目 .venv 已有）。**不需要 torch。**
模型：sherpa-onnx 的 SenseVoice 导出（model.int8.onnx + tokens.txt）。

用法：

    python tools/asr/sensevoice_server.py --model-dir tools/asr/models/sensevoice-small
    python tools/asr/sensevoice_server.py --selftest          # 只验证模型能加载、能解码
    python tools/asr/sensevoice_server.py --print-only        # 打印解析到的模型信息后退出

端点：

    GET  /health                       探活（asr.json 的 manage.healthPath 默认就探这个）
    GET  /v1/models                    兼容只探 OpenAI 形态的服务
    POST /v1/audio/transcriptions      转写
    POST /shutdown                     请它自己退出（托管方优先走这个，而不是 taskkill）
"""

from __future__ import annotations

import argparse
import email.parser
import email.policy
import io
import json
import logging
import math
import os
import signal
import struct
import sys
import threading
import time
import wave  # noqa: F401  (只用于 --selftest 写临时 wav，正常路径不用)

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = logging.getLogger("asr-server")

TARGET_RATE = 16000
# ffmpeg 写管道时 RIFF/data 的 size 字段是 0xFFFFFFFF（没法回填），必须按这个值兜住。
UNKNOWN_SIZE = 0xFFFFFFFF
MAX_UPLOAD_BYTES = 200 * 1024 * 1024
# 整片兜底解码的门槛：低于它说明这一段**根本没有能量**（数字静音、极低的底噪）。
# 不加这道门，SenseVoice 会在纯静音上凭空编出一句（实测 "그."），而契约要求静音返回空段。
FALLBACK_PEAK = 0.006
# 稳态音（纯正弦/长鸣）也骗不过识别器，会编出 "Yeah. The." 这种句子。
# 这类区间用廉价的谱统计就能认出来；太短的区间统计不可靠，不判。
STEADY_MIN_SEC = 0.8
STEADY_ZCR_STD = 0.03
STEADY_CENT_STD = 30.0


# ---------------------------------------------------------------------------
# WAV 读取：不信任头部长度字段
# ---------------------------------------------------------------------------

def read_wav(data: bytes) -> tuple["__import__('numpy').ndarray", int]:
    """把 WAV 字节解成 float32 单声道。**专门容忍 ffmpeg 管道写出来的坏头。**

    客户端是用 `ffmpeg … -f wav -` 直接写 stdout 的：RIFF 的 size 和 data 的 size 都是
    0xFFFFFFFF，而且默认还带一个 LIST/INFO chunk（data 不在偏移 36）。按教科书解析会
    直接失败，所以这里按 chunk 走，长度认不出来就"读到哪算哪"。
    """
    import numpy as np

    if len(data) < 12 or data[0:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError("不是 RIFF/WAVE 数据")

    fmt = None
    payload = None
    pos = 12
    while pos + 8 <= len(data):
        cid = data[pos:pos + 4]
        size = struct.unpack("<I", data[pos + 4:pos + 8])[0]
        body = pos + 8
        if cid == b"data":
            end = len(data) if size == UNKNOWN_SIZE else min(len(data), body + size)
            payload = data[body:end - ((end - body) & 1)]
            break
        if cid == b"fmt " and size >= 16 and body + 16 <= len(data):
            fmt = data[body:body + 16]
        if size == UNKNOWN_SIZE or body + size > len(data):
            break
        pos = body + size + (size & 1)

    if fmt is None:
        raise ValueError("WAV 缺少 fmt 块")
    if payload is None:
        raise ValueError("WAV 缺少 data 块")

    audio_format, channels, rate = struct.unpack("<HHI", fmt[0:8])
    bits = struct.unpack("<H", fmt[14:16])[0]
    if bits != 16:
        raise ValueError(f"只支持 PCM16，收到 {bits} bit")
    if audio_format not in (1, 0xFFFE):  # PCM / WAVE_FORMAT_EXTENSIBLE
        raise ValueError(f"只支持 PCM，收到 format={audio_format}")

    samples = np.frombuffer(payload, dtype="<i2").astype("float32") / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    if rate != TARGET_RATE and samples.size:
        # 客户端理论上只会发 16k；真发了别的采样率也尽量救一下（线性插值，够 VAD 和识别用）。
        count = max(1, int(round(samples.size * TARGET_RATE / rate)))
        x_old = np.arange(samples.size, dtype="float64")
        x_new = np.linspace(0, samples.size - 1, count, dtype="float64")
        samples = np.interp(x_new, x_old, samples).astype("float32")
        rate = TARGET_RATE
    return samples, rate


# ---------------------------------------------------------------------------
# 能量 VAD：把一片音频切成语音区间（区间边界 = 句子的时间码）
# ---------------------------------------------------------------------------

def speech_regions(samples, rate: int = TARGET_RATE, *, min_speech: float = 0.45,
                   merge_gap: float = 0.30, pad: float = 0.10,
                   max_region: float = 12.0) -> list[tuple[float, float]]:
    """返回 [(from, to), …]（秒，相对本片）。没有语音就返回空列表。

    阈值用**自适应**：先看这一片的底噪（10 分位），再取底噪的若干倍；底噪很高（音乐/噪声）
    时给出一个绝对值兜底，免得整片被判成"一直在说话"。

    `min_speech` 定在 0.45 秒：再短的区间基本都是音效/杂音，模型会把它认成一两个字
    （实测 0.26–0.31 秒的过场音变成 "喂。" / "や。"），丢掉比留在台词里强。
    """
    import numpy as np

    if samples.size == 0:
        return []
    frame = max(1, int(rate * 0.02))
    hop = max(1, int(rate * 0.01))
    if samples.size < frame:
        return []
    frames = 1 + (samples.size - frame) // hop
    # 逐帧 RMS（用 stride 视图算，避免 Python 循环）
    view = np.lib.stride_tricks.sliding_window_view(samples, frame)[::hop][:frames]
    rms = np.sqrt(np.mean(view.astype("float64") ** 2, axis=1))
    if not rms.size:
        return []

    floor = float(np.percentile(rms, 10))
    peak = float(rms.max())
    threshold = max(floor * 3.0, 0.006)
    # 整片都很"响"的时候（纯音乐），抬阈值到峰值的一半，否则会一直判成有语音
    if peak >threshold * 6:
        threshold = max(threshold, peak * 0.15)
    if peak < 0.004:
        return []

    voiced = rms > threshold
    regions: list[list[float]] = []
    start = None
    for i, on in enumerate(voiced):
        t = i * hop / rate
        if on and start is None:
            start = t
        elif not on and start is not None:
            regions.append([start, t + frame / rate])
            start = None
    if start is not None:
        regions.append([start, samples.size / rate])

    merged: list[list[float]] = []
    for a, b in regions:
        if merged and a - merged[-1][1] <= merge_gap:
            merged[-1][1] = b
        else:
            merged.append([a, b])

    out: list[tuple[float, float]] = []
    duration = samples.size / rate
    for a, b in merged:
        a = max(0.0, a - pad)
        b = min(duration, b + pad)
        if b - a < min_speech:
            continue
        # 太长的区间在能量最低处切一刀，让时间码仍然"像句子的长度"
        while b - a > max_region:
            window = rms[int(a * rate / hop):int((a + max_region) * rate / hop)]
            if window.size < 4:
                break
            cut_frame = int(np.argmin(window)) + int(a * rate / hop)
            cut = max(a + 1.0, cut_frame * hop / rate)
            out.append((a, cut))
            a = cut
        out.append((a, b))
    return out


def looks_like_speech(samples, rate: int = TARGET_RATE) -> bool:
    """够不够像人说话。**只用来挡"稳态音"**，不承担 VAD 的职责。

    实测：给识别器一段 440Hz 正弦，它会输出 "Yeah. The."；给纯静音会输出 "그."。
    这两类都不该变成台词。真人说话的谱质心与过零率一直在动（实测 12 秒对白里
    zcr_std 0.065–0.17、centroid_std 147–631），而纯音是 zcr_std≈0.017、centroid_std≈0。
    判据取的是"两个都极稳"，宁可漏判（多识别一段噪声），也不误杀真台词。
    """
    import numpy as np

    if samples.size < rate * STEADY_MIN_SEC:
        return True
    frame = int(rate * 0.02)
    hop = int(rate * 0.01)
    view = np.lib.stride_tricks.sliding_window_view(samples, frame)[::hop]
    if view.shape[0] < 8:
        return True
    rms = np.sqrt(np.mean(view.astype("float64") ** 2, axis=1))
    signs = np.signbit(view)
    zcr = np.mean(signs[:, 1:] != signs[:, :-1], axis=1)
    # 只拿能量较高的那些帧算质心，别让静音帧把 std 拉低
    keep = view[rms >= max(rms.mean() * 0.5, 1e-5)]
    if keep.shape[0] < 4:
        keep = view
    spec = np.abs(np.fft.rfft(keep.astype("float64") * np.hanning(frame), axis=1))
    power = spec ** 2
    freqs = np.fft.rfftfreq(frame, 1 / rate)
    centroid = (power * freqs).sum(axis=1) / (power.sum(axis=1) + 1e-12)
    return not (zcr.std() < STEADY_ZCR_STD and centroid.std() < STEADY_CENT_STD)


# ---------------------------------------------------------------------------
# sherpa-onnx 加载（对 API 差异做退让，失败要说清楚）
# ---------------------------------------------------------------------------

def find_model_file(model_dir: str) -> tuple[str, str]:
    tokens = os.path.join(model_dir, "tokens.txt")
    if not os.path.isfile(tokens):
        raise FileNotFoundError(f"缺少 tokens.txt：{tokens}")
    for name in ("model.int8.onnx", "model.onnx", "model.fp16.onnx"):
        path = os.path.join(model_dir, name)
        if os.path.isfile(path):
            return path, tokens
    raise FileNotFoundError(f"{model_dir} 里没有 model*.onnx")


def build_recognizer(model_dir: str, threads: int, provider: str, language: str, itn: bool):
    """加载 recognizer。

    sherpa-onnx 的 Python API 在小版本之间动过（`from_sense_voice` 的入参、以及
    config 对象两种写法），所以按"能用的那条"依次尝试；全都不行时把版本和缺失的
    属性一起报出来 —— 这类错误不该只有一句 AttributeError。
    """
    try:
        import sherpa_onnx
    except ImportError as exc:  # 最常见的失败：包没装
        raise SystemExit(
            "没有找到 sherpa_onnx。请在项目虚拟环境里装：\n"
            "  .venv\\Scripts\\python.exe -m pip install sherpa-onnx\n"
            f"（原始错误：{exc}）"
        ) from exc

    model, tokens = find_model_file(model_dir)
    errors: list[str] = []

    # 路线 1：from_sense_voice 便捷构造（大多数版本都有）
    factory = getattr(sherpa_onnx.OfflineRecognizer, "from_sense_voice", None)
    if factory is not None:
        base = dict(model=model, tokens=tokens, num_threads=threads, use_itn=itn,
                    debug=False, provider=provider)
        for extra in ({"language": language}, {}):
            try:
                return factory(**base, **extra)
            except TypeError as exc:
                errors.append(f"from_sense_voice{'+language' if extra else ''}: {exc}")
            except Exception as exc:  # noqa: BLE001 - 记下来继续试下一条
                errors.append(f"from_sense_voice{'+language' if extra else ''}: {exc}")

    # 路线 2：config 对象（老版本/新版都可能有）
    try:
        sense_cfg = getattr(sherpa_onnx, "OfflineSenseVoiceModelConfig")(
            model=model, tokens=tokens, use_itn=itn, language=language,
        )
        model_cfg = sherpa_onnx.OfflineModelConfig(sense_voice=sense_cfg)
        cfg = sherpa_onnx.OfflineRecognizerConfig(model_config=model_cfg)
        cfg.decoding_method = "greedy_search"
        if hasattr(cfg, "feat_config"):
            cfg.feat_config.sample_rate = TARGET_RATE
            cfg.feat_config.feature_dim = 80
        return sherpa_onnx.OfflineRecognizer(cfg)
    except Exception as exc:  # noqa: BLE001
        errors.append(f"config 对象: {exc}")

    version = getattr(sherpa_onnx, "__version__", "未知")
    raise SystemExit(
        "sherpa-onnx 加载失败（版本 %s）。试过的写法都不行：\n  %s\n"
        "请把上面的报错发给我，我按你这个版本改适配。"
        % (version, "\n  ".join(errors) or "（没有可用的构造入口）")
    )


def decode_text(recognizer, samples) -> str:
    """跑一次识别，返回清洗后的文本。"""
    import numpy as np

    stream = recognizer.create_stream()
    stream.accept_waveform(TARGET_RATE, np.ascontiguousarray(samples, dtype="float32"))
    decoder = getattr(recognizer, "decode_stream", None)
    if decoder is not None:
        decoder(stream)
    else:  # 少数版本只有批量入口
        recognizer.decode_streams([stream])
    text = getattr(stream.result, "text", "") or ""
    return clean_text(text)


def clean_text(text: str) -> str:
    """去掉 SenseVoice 的 `<|zh|><|NEUTRAL|>` 之类标签与多余空白。"""
    out = []
    i = 0
    while i < len(text):
        if text.startswith("<|", i):
            j = text.find("|>", i + 2)
            if j > 0:
                i = j + 2
                continue
        out.append(text[i])
        i += 1
    cleaned = "".join(out).replace("\u200b", "")
    return " ".join(cleaned.split()).strip()


def meaningful_chars(text: str) -> int:
    """去掉标点和空白之后的字数。只用来挡"一个字都没有实质内容"的碎片。"""
    return sum(1 for ch in text if not ch.isspace() and not ch in "，。、！？；：,.!?;:\"'（）()[]【】…—-~～")


# ---------------------------------------------------------------------------
# 转写主流程
# ---------------------------------------------------------------------------

class Transcriber:
    def __init__(self, model_dir: str, *, threads: int, provider: str, language: str, itn: bool,
                 stub: bool = False):
        self.model_dir = model_dir
        self.stub = stub
        # stub 模式不加载模型：用来在没有 sherpa-onnx 的机器上验证 HTTP/multipart/WAV/VAD
        # 这一整层（约 90% 的代码），把"包没装"和"壳写错了"分开。
        self.recognizer = None if stub else build_recognizer(model_dir, threads, provider, language, itn)
        self.language = language
        self.model_name = "stub" if stub else (os.path.basename(os.path.normpath(model_dir)) or "sensevoice")
        self.lock = threading.Lock()

    def _decode(self, samples) -> str:
        if self.recognizer is None:
            import numpy as np

            peak = float(np.sqrt(np.mean(samples.astype("float64") ** 2))) if samples.size else 0.0
            return "这是一句占位台词" if peak > 0.01 else ""
        return decode_text(self.recognizer, samples)

    def transcribe(self, samples) -> dict:
        import numpy as np

        duration = round(samples.size / TARGET_RATE, 3)
        peak = float(np.max(np.abs(samples))) if samples.size else 0.0
        # 整片先过一道"像不像人说话"：纯正弦/长鸣这种稳态音，识别器会凭空编出
        # "Yeah. The."，而它每一段都只有零点几秒 —— 逐段判会被"太短不判"放过，
        # 所以必须在整片这一层挡一次。
        speechlike = looks_like_speech(samples)
        regions = [r for r in speech_regions(samples)
                   if looks_like_speech(samples[int(r[0] * TARGET_RATE):int(r[1] * TARGET_RATE)])] if speechlike else []
        segments: list[dict] = []
        started = time.time()
        with self.lock:
            if not regions:
                # VAD 没找到区间：要么真安静，要么全是稳态音，要么阈值把它判没了。
                # 兜底解码要同时满足两条：**有能量**、**整片看着像人说话**。
                # 只看能量的话，纯正弦/长鸣还是会被编出一句（实测 "Yeah. The."）。
                text = self._decode(samples) if (peak >= FALLBACK_PEAK and speechlike) else ""
                if text:
                    segments.append({"start": 0.0, "end": duration, "text": text})
            else:
                for a, b in regions:
                    chunk = samples[int(a * TARGET_RATE):int(b * TARGET_RATE)]
                    if chunk.size < TARGET_RATE * 0.1:
                        continue
                    text = self._decode(chunk)
                    if not text:
                        continue
                    # 一两个字的碎片基本都是音效/气口被认成了话；台词里留着只会误导模型。
                    if meaningful_chars(text) < 2:
                        continue
                    if segments and segments[-1]["text"] == text and a - segments[-1]["end"] < 0.4:
                        continue  # 同一句被切两刀时不重复报
                    segments.append({"start": round(a, 3), "end": round(b, 3), "text": text})
        elapsed = time.time() - started
        return {
            "text": " ".join(s["text"] for s in segments).strip(),
            "model": self.model_name,
            "language": self.language,
            "segments": segments,
            "duration": duration,
            "elapsed": round(elapsed, 2),
            "peak": round(peak, 4),
        }


# ---------------------------------------------------------------------------
# multipart 解析（标准库；Python 3.13 起 cgi 已被移除，所以不能用 FieldStorage）
# ---------------------------------------------------------------------------

def parse_multipart(body: bytes, content_type: str) -> tuple[dict[str, str], dict[str, bytes]]:
    msg = email.message.Message()
    msg["content-type"] = content_type
    boundary = msg.get_param("boundary")
    if not boundary:
        raise ValueError("Content-Type 里没有 boundary")
    raw = b"Content-Type: multipart/form-data; boundary=" + str(boundary).encode() + b"\r\n\r\n" + body
    parsed = email.parser.BytesParser(policy=email.policy.compat32).parsebytes(raw)
    fields: dict[str, str] = {}
    files: dict[str, bytes] = {}
    for part in parsed.walk():
        if part.get_content_maintype() == "multipart":
            continue
        name = part.get_param("name", header="content-disposition")
        if not name:
            continue
        payload = part.get_payload(decode=True) or b""
        if part.get_param("filename", header="content-disposition"):
            files[name] = payload
        else:
            fields[name] = payload.decode("utf-8", "replace")
    return fields, files


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "sensevoice-server/1.0"
    transcriber: Transcriber = None  # 由 main() 注入
    quiet_paths = ("/health", "/v1/models")

    def log_message(self, fmt, *args):  # noqa: A003 - 基类签名
        LOG.debug("%s - %s", self.address_string(), fmt % args)

    def _send(self, status: int, payload: bytes, content_type: str = "application/json; charset=utf-8"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, status: int, obj: dict):
        self._send(status, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def do_GET(self):  # noqa: N802 - 基类命名
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        if path in ("/health", "/healthz"):
            self._json(200, {
                "ok": True,
                "model": self.transcriber.model_name,
                "language": self.transcriber.language,
                "pid": os.getpid(),
            })
            return
        if path in ("/v1/models", "/models"):
            self._json(200, {
                "object": "list",
                "data": [{"id": self.transcriber.model_name, "object": "model", "owned_by": "local"}],
            })
            return
        self._json(404, {"error": "not-found"})

    def do_POST(self):  # noqa: N802
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        if path == "/shutdown":
            self._json(200, {"ok": True, "stopping": True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        if path not in ("/v1/audio/transcriptions", "/audio/transcriptions"):
            self._json(404, {"error": "not-found"})
            return

        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            self._json(400, {"error": "empty body"})
            return
        if length > MAX_UPLOAD_BYTES:
            self._json(413, {"error": f"body too large ({length} bytes)"})
            return

        content_type = self.headers.get("Content-Type") or ""
        if "multipart/form-data" not in content_type:
            self._json(415, {"error": "expect multipart/form-data"})
            return

        body = self.rfile.read(length)
        try:
            fields, files = parse_multipart(body, content_type)
        except Exception as exc:  # noqa: BLE001
            self._json(400, {"error": f"bad multipart: {exc}"})
            return

        audio = files.get("file") or (next(iter(files.values())) if files else None)
        if not audio:
            self._json(400, {"error": "missing form field `file`"})
            return
        try:
            samples, rate = read_wav(audio)
        except Exception as exc:  # noqa: BLE001
            self._json(400, {"error": f"bad audio: {exc}"})
            return
        if samples.size < rate * 0.05:
            # 太短：按契约回"跑了但没听到话"，而不是错误（客户端会记 asr-empty）。
            self._json(200, {"text": "", "model": self.transcriber.model_name,
                             "language": self.transcriber.language, "segments": []})
            return

        started = time.time()
        try:
            result = self.transcriber.transcribe(samples)
        except Exception as exc:  # noqa: BLE001
            LOG.exception("transcribe failed")
            self._json(500, {"error": f"transcribe failed: {exc}"})
            return

        LOG.info("transcribe %.2fs audio -> %d seg in %.2fs (model=%s, lang=%s, response_format=%s)",
                 result["duration"], len(result["segments"]), time.time() - started,
                 result["model"], result["language"], fields.get("response_format", "verbose_json"))

        if fields.get("response_format") == "text":
            self._send(200, result["text"].encode("utf-8"), "text/plain; charset=utf-8")
            return
        payload = {k: result[k] for k in ("text", "model", "language", "segments", "duration")}
        self._json(200, payload)


def serve(args) -> int:
    transcriber = Transcriber(
        args.model_dir, threads=args.threads, provider=args.provider,
        language=args.language, itn=not args.no_itn, stub=args.stub,
    )
    Handler.transcriber = transcriber
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True

    def stop(*_a):
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, stop)
    try:
        signal.signal(signal.SIGTERM, stop)
    except (ValueError, AttributeError):
        pass

    LOG.info("ready on http://%s:%d/v1 · model=%s · threads=%d · language=%s · pid=%d",
             args.host, args.port, transcriber.model_name, args.threads, args.language, os.getpid())
    try:
        httpd.serve_forever(poll_interval=0.3)
    finally:
        httpd.server_close()
        LOG.info("stopped")
    return 0


def selftest(args) -> int:
    """只验证"能加载、能解码"，不做网络。用来在接进 asr.json 之前排除环境问题。"""
    import numpy as np

    transcriber = Transcriber(
        args.model_dir, threads=args.threads, provider=args.provider,
        language=args.language, itn=not args.no_itn, stub=args.stub,
    )
    print(f"[selftest] model={os.path.join(args.model_dir, '')} threads={args.threads} stub={args.stub}")
    if args.wav:
        with open(args.wav, "rb") as fh:
            samples, rate = read_wav(fh.read())
        print(f"[selftest] wav={args.wav} {samples.size / rate:.2f}s")
    else:
        # 0.6 秒静音 + 0.9 秒 440Hz 正弦：没有语音，期望 segments 为空（证明不会瞎编）
        samples = np.concatenate([
            np.zeros(int(TARGET_RATE * 0.6), dtype="float32"),
            0.2 * np.sin(2 * math.pi * 440 * np.arange(int(TARGET_RATE * 0.9)) / TARGET_RATE).astype("float32"),
        ])
        print(f"[selftest] synthetic {samples.size / TARGET_RATE:.2f}s (silence + tone)")
    started = time.time()
    result = transcriber.transcribe(samples)
    print(f"[selftest] decoded in {time.time() - started:.2f}s → {len(result['segments'])} 段")
    for seg in result["segments"]:
        print(f"    {seg['start']:.2f}-{seg['end']:.2f}  {seg['text']}")
    if not args.wav:
        print("[selftest] 合成音频没有语音，0 段是正确结果；'能加载 + 能解码'本身已通过。")
    return 0


def main(argv=None) -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser(description="sherpa-onnx SenseVoice 的 OpenAI 兼容薄壳")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8100)
    parser.add_argument("--model-dir", default=os.path.join(here, "models", "sensevoice-small"))
    parser.add_argument("--threads", type=int, default=max(1, min(8, (os.cpu_count() or 4))))
    parser.add_argument("--provider", default="cpu", choices=["cpu", "cuda"])
    parser.add_argument("--language", default="zh",
                        help="识别语言（zh / en / ja / ko / yue / auto）。中文视频用 zh："
                             "auto 会把短促音效判成日语/韩语，输出 'や。' 'おざ。' 这种碎片")
    parser.add_argument("--no-itn", action="store_true", help="关掉数字/标点规整（ITN）")
    parser.add_argument("--selftest", action="store_true")
    parser.add_argument("--wav", default=None, help="配合 --selftest 解码指定 wav")
    parser.add_argument("--stub", action="store_true",
                        help="不加载模型，用占位识别器验证 HTTP/WAV/VAD 层（没有 sherpa-onnx 也能跑）")
    parser.add_argument("--print-only", action="store_true", help="只打印模型信息后退出")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        stream=sys.stderr,
    )

    if args.print_only:
        model, tokens = find_model_file(args.model_dir)
        size = os.path.getsize(model) / (1024 * 1024)
        print(json.dumps({"model": model, "tokens": tokens, "sizeMB": round(size, 1),
                          "threads": args.threads, "language": args.language}, ensure_ascii=False, indent=2))
        return 0
    if args.selftest:
        return selftest(args)
    return serve(args)


if __name__ == "__main__":
    raise SystemExit(main())
