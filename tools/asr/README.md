# ASR 薄壳：sherpa-onnx + SenseVoice

给 `dsh-watch-together` 补"无字幕视频的台词"用的本机识别服务。

**它做什么**：把视频音轨（16k 单声道 WAV）转成**带时间码的句子**，走 OpenAI `/audio/transcriptions` 方言。

**它不做什么**（这一条最容易误会）：

| 能力 | 是不是这个 | 谁在做 |
|---|---|---|
| 视频里的人说什么（音频 → 文字） | ✅ 就是这个 | 本文件 |
| 助手说话（文字 → 音频，TTS） | ❌ 完全不碰 | Orb `dist/voice/`、watch_together 的 `tts-interface` / edge-tts |
| 麦克风 / 唤醒词（音频 → 文字） | ❌ 不碰 | Orb 自己的 `voiceModels.asr` |
| 音乐、音效识别 | ❌ 做不到 | 没人做 |

也不需要改插件源码：`dsh-video-storyboard` 的两条识别路径（分镜 `transcript-pass.js`、台词 `lines-util.js`）都会自己读 `asr.json`、自己拉起本机服务、自己加缓存。

---

## 1. 装包（这条要你自己跑）

```powershell
cd "E:\file\agent\ai assistant"
.venv\Scripts\python.exe -m pip install -U pip
.venv\Scripts\python.exe -m pip install sherpa-onnx
```

- **不需要 torch**，也不需要 CUDA。`sherpa-onnx` 自带 onnxruntime，CPU 就能跑。
- 如果 PyPI 慢或不通，换镜像：
  ```powershell
  .venv\Scripts\python.exe -m pip install sherpa-onnx -i https://pypi.tuna.tsinghua.edu.cn/simple
  ```
- 装完验证（应该打印版本号）：
  ```powershell
  .venv\Scripts\python.exe -c "import sherpa_onnx; print(sherpa_onnx.__version__)"
  ```

`.venv` 里原有的 mss / pywinauto / numpy 不会被这条命令动到。

## 2. 模型

已经下好放在 `tools/asr/models/sensevoice-small/`：

| 文件 | 大小 | 用途 |
|---|---|---|
| `model.int8.onnx` | ~228 MB | SenseVoiceSmall 的 int8 导出 |
| `tokens.txt` | ~309 KB | 词表 |

重新下载（GitHub 直连在本机不通，走 HF 镜像；`curl` 必须加 `--ssl-no-revoke`，否则报
`CRYPT_E_NO_REVOCATION_CHECK`）：

```powershell
$dir = "E:\file\agent\ai assistant\tools\asr\models\sensevoice-small"
$base = "https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main"
curl.exe -L --fail --ssl-no-revoke -o "$dir\tokens.txt" "$base/tokens.txt"
curl.exe -L --fail --ssl-no-revoke -o "$dir\model.int8.onnx" "$base/model.int8.onnx"
```

## 3. 自检（分三层，出问题时能立刻定位到哪一层）

```powershell
# ① 文件对不对（不需要装了 sherpa）
.venv\Scripts\python.exe tools\asr\sensevoice_server.py --print-only

# ② 壳对不对：不加载模型，用占位识别器把 HTTP / multipart / WAV / VAD 全跑一遍
.venv\Scripts\python.exe tools\asr\sensevoice_server.py --stub --port 8010
node tools\asr\check_asr_contract.mjs --baseUrl http://127.0.0.1:8010/v1

# ③ 模型对不对：真加载 + 真解码
.venv\Scripts\python.exe tools\asr\sensevoice_server.py --selftest
.venv\Scripts\python.exe tools\asr\sensevoice_server.py --selftest --wav 某个有人说话的16k.wav
```

②③ 都过之后，起真服务再跑一遍契约检查：

```powershell
.venv\Scripts\python.exe tools\asr\sensevoice_server.py --port 8100
# 另开一个窗口
node tools\asr\check_asr_contract.mjs
node tools\asr\check_asr_contract.mjs --wav 有人说话的.wav --expect-text
```

`check_asr_contract.mjs` 逐条验的是**契约**（不是识别质量）：探活、2xx、`segments` 形状、
时间戳相对本次上传、静音不报错、坏音频真的 4xx、以及 ffmpeg 管道头（`0xFFFFFFFF` 长度）
能不能解析。它自己能先用 `--fake` 自检：

```powershell
node tools\asr\check_asr_contract.mjs --fake     # 6 项全过 = 检查器本身没写错
```

## 4. 接进插件

写 `C:\Users\Mio\.dsh\asr.json`（内容同 `tools/asr/asr.json.example`）：

```json
{
  "baseUrl": "http://127.0.0.1:8100/v1",
  "model": "sensevoice-small-int8",
  "language": "auto",
  "manage": {
    "start": [
      "E:/file/agent/ai assistant/.venv/Scripts/python.exe",
      "E:/file/agent/ai assistant/tools/asr/sensevoice_server.py",
      "--port", "8100"
    ],
    "waitMs": 120000,
    "idleMs": 1800000,
    "healthPath": "/health"
  }
}
```

要点：

- **本机地址不需要 key**（`127.0.0.1` 被识别为 loopback）。云端才需要 `"key"`。
- 配置按文件 mtime **热生效**，改完不用重启 DSH。
- `manage.start` 用**数组**形式：插件会直接起这个 exe，不经过 `cmd /c`（数组形式不会闪黑框，也不受批处理编码影响）。
- `manage` 只在端点不通时才拉起；端点已经在跑就一根手指都不碰。
- `idleMs` 是"最后一次转写之后再空闲多久就关掉"。这里设 **60 秒**：实测冷启动到 `/health` 就绪 **2.4 秒**、常驻内存 **330MB**，为了省 2.4 秒把 330MB 挂半小时不值。陪看进行中不用担心——`watch-run.js` 会传 `minIdleMs = 段长 + 30s` 自动延长空闲窗口，两段之间不会被关；停陪看后 1 分钟内自己退。
- 服务支持 `POST /shutdown`，插件停它会优先走这个，而不是 `taskkill`。
- 注意：**只有插件自己拉起的实例才会被它停掉**（`owned`）。手动起的那个插件不管，需要的话自己 `curl -X POST /shutdown`。

## 5. 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | `{"ok":true,"model":…,"pid":…}`，插件探活首选 |
| GET | `/v1/models` | 兼容只探 OpenAI 形态的客户端 |
| POST | `/v1/audio/transcriptions` | multipart：`file` / `model` / `response_format` / `language` / `hotword` |
| POST | `/shutdown` | 优雅退出 |

响应：

```json
{ "text": "整段文字", "model": "sensevoice-small-int8", "language": "auto",
  "segments": [ {"start": 0.29, "end": 1.02, "text": "第一句"} ], "duration": 3.0 }
```

`start`/`end` **相对本次上传的音频**（不是视频绝对时间）。插件会自己加上片段起点；服务端再加一次就会整体偏移。`hotword` 收到但忽略（SenseVoice 没有热词偏置，术语靠 `asr.json` 的 `terms` 表做后处理替换）。

## 6. 时间戳怎么来的（诚实地说明）

sherpa-onnx 的 SenseVoice 只给整段文字、没有词级时间码。这里的做法是：

1. 按能量做 VAD（20ms 帧 / 10ms 步），静音处切开，得到若干语音区间；
2. 每个区间单独识别，区间边界就是这一句的 `start`/`end`；
3. VAD 一个区间都没找到但整片确实有响动时，**整片当一句**再识别一次 —— 宁可粗，也不吞掉真台词；
4. 太长的区间（>12s）在能量最低处再切一刀。

所以给的是"**句子级**"时间码，精度取决于停顿是否明显，不是强制对齐（forced alignment）那种词级精度。对"陪看时按点评论"够用；对逐字字幕不够。

### 三道防"编台词"的闸门（都是实测踩出来的）

| 闸门 | 阈值 | 为什么 |
|---|---|---|
| 整片先判"像不像人说话" | 过零率 std < 0.03 **且** 谱质心 std < 30 | 纯正弦（440Hz）会被识别成 "Yeah. The."；真人说话实测 zcr_std 0.065–0.17、centroid_std 147–631，差距很大 |
| 整片兜底要够门槛 | 峰值 ≥ 0.006 且上面那条通过 | 纯静音会被编出 "그."；契约要求静音返回空段 |
| 丢弃太短/太碎的片段 | 区间 ≥ 0.45s；识别结果 ≥ 2 个实义字符 | 0.26–0.31 秒的过场音会变成 "喂。" / "や。" |

`--language zh` 也是这么来的：`auto` 会把短促音效判成日语/韩语（"や。" "おざ。"），强制 `zh` 至少让它落在中文里。

## 7. 实测结果（这台机器，2026-11-12）

| 项 | 数值 |
|---|---|
| 硬件 | RTX 3070 Laptop（没用到）、16 逻辑核、16GB |
| 模型 | SenseVoiceSmall int8，228MB |
| 单段 12s 对白 | **0.36s**（约 33× 实时） |
| 120s（切成 45+45+30 三片） | **4.4s**，50 段（约 27× 实时） |
| 冷启动（含加载模型） | 约 **1.5s**；`manage.start` 拉起 + 转写 12s 合计 3.0s |

真实对白样例（用户视频 240–262s，未经任何手工修正）：

```text
240.00–240.49  手机里。
240.60–242.19  伊尔默的照片一模一样。
242.54–243.11  下一秒。
243.28–248.40  X的子弹竟从我们背后射出，直接击杀了这个伊尔默形象的空想故知。
248.53–251.79  并动用异能强制将我们从这个意向空间登出。
252.01–254.35  我们因此落入一个画风不同的地方。
254.54–256.63  这里出现了一个白发少女。
256.89–259.70  他引导我们在这片空间探索了孤僻少年X。
```

### 已知限制

1. **音乐/音效段**：能量 VAD 分不出"人在说话"和"配乐里有响动"。配乐密集处仍会出 "记的危胁。" 这种碎句。上游 `filterSuspectSegments` 只管"长时段 + 极低字/秒"，管不到短碎片；要更干净得上真正的语音 VAD（silero），本次没接。
2. **45 秒切片边界**会把两句话拼在一起（上面 "探索了孤僻少年X" 就是合并结果），个别句子会串。
3. 专有名词仍会错；`asr.json` 的 `terms` 表能做确定性替换，本次没建表。
4. 缓存命中没有端到端验证：`bin/asr-check.mjs` 直接调 `transcribeLong`，绕过了 pipeline 的 `transcript-cache`。缓存键（`asrBackendId`）含 baseUrl/model/language/maxChunk/hotwords，改配置即重新转写，这点已核对代码。

## 8. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `ModuleNotFoundError: sherpa_onnx` | 装到了别的解释器 | 用 **`.venv\Scripts\python.exe -m pip**（不是 `python`） |
| `sherpa-onnx 加载失败（版本 x）` | 版本之间 API 有差异 | 把整段报错发给我，按你的版本改 |
| `ECONNREFUSED 127.0.0.1:8100` | 没起 / 端口被占 | 先手动起一次看报错；`netstat -ano \| findstr :8100` |
| 有人说话但 `segments` 为空 | 音量太低，VAD 判成静音 | 加 `--verbose` 看区间；或先用 `--selftest --wav` 验证这一片能不能识别 |
| 第一次转写很慢（1–3s） | 模型加载 | 正常；之后每片是百毫秒级 |
| CPU 打满 | 线程给多了 | `--threads 4` |
| `CRYPT_E_NO_REVOCATION_CHECK` | curl 的证书吊销检查 | 加 `--ssl-no-revoke` |
| 插件日志 `no-key` | `asr.json` 没被读到 | 确认路径是 `C:\Users\Mio\.dsh\asr.json`（不是项目目录） |
| 插件日志 `asr-unreachable` | 服务没起且没配 `manage.start` | 要么手动起，要么补 `manage` 段 |
