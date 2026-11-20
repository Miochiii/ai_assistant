# ASR 接入：本机 SenseVoice 服务（交接 02）

日期：2026-11-12。**只解决"视频里的人在说什么"**（音频 → 文字，模型的输入）。助手语音输出（TTS）、麦克风/唤醒词都是另外三条链路，本次一行没动。

## 1. 交付物

| 文件 | 作用 |
|---|---|
| `tools/asr/sensevoice_server.py` | OpenAI `/audio/transcriptions` 方言的薄壳：收 16k 单声道 WAV → SenseVoice → 句子级时间码。另带 `/health`、`/v1/models`、`/shutdown` |
| `tools/asr/check_asr_contract.mjs` | 按上游 `docs/asr-contract.md` 逐条验收端点，6 项；`--fake` 可先自检检查器本身 |
| `tools/asr/README.md` | 安装、模型、三层自检、配置、实测、限制、排障 |
| `tools/asr/asr.json.example` | 与生产配置同构的样例 |
| `tools/asr/models/sensevoice-small/` | `model.int8.onnx`（239,233,841 字节）+ `tokens.txt`（315,894 字节），来自 HF 镜像 |
| `C:\Users\Mio\.dsh\asr.json` | 生产配置（已写入） |
| `tests/test_asr_contract_validator.mjs` | 9 项单测，守住"检查器自己别写错" |

**没有改上游一行代码。** `dsh-video-storyboard` 的两条识别路径本来就都会读 `asr.json`、调 `ensureAsr()` 拉起本机服务、按 `asrBackendId()` 做缓存 —— 02 §4 的 HTTP 契约是现成的。

## 2. 为什么是这条路

选型对比（详见对话记录）：本机有 RTX 3070 Laptop（8GB，实际没用到）、16 核、16GB。`faster-whisper` / `sherpa-onnx` 都不需要 torch，PyPI 上有 win_amd64 + cp314 轮子，所以**项目 `.venv`（Python 3.14.9）直接能装**。选 SenseVoice 是因为它是上游默认模型、中文最好，且 sherpa-onnx 的 int8 ONNX 只有 228MB。

**宿主自带的 `speechToText`（DSH 里的 `dsh-experimental-speech-to-text`）没有用**：watch 的两条路径都不传 `hostAsr`（只有 storyboard 自己的 `video_*` 工具传），而且它只返回整段文字、没有词级时间戳（桥接只能按 30s 窗口给粗时间）。要用它得先给 watch 打补丁，收益也不如本机服务。

## 3. 配置与托管

```json
{
  "baseUrl": "http://127.0.0.1:8000/v1",
  "model": "sensevoice-small-int8",
  "language": "zh",
  "manage": {
    "start": ["E:/file/agent/ai assistant/.venv/Scripts/python.exe",
              "E:/file/agent/ai assistant/tools/asr/sensevoice_server.py",
              "--port", "8000", "--threads", "6", "--language", "zh"],
    "waitMs": 120000, "idleMs": 60000, "healthPath": "/health"
  }
}
```

- 本机 loopback → **不需要 key**（`isLoopback` 判据，和插件同源）。
- 改 `asr.json` 按 mtime 热生效，不用重启 DSH。
- `manage.start` 用数组形式（不经过 `cmd /c`，不闪黑框）。
- 实测：**插件自己拉起了服务**（`[asr] 已按 manage.start 拉起本机服务`），冷启动到转写完 12s 共 3.0s。
- `idleMs` 从最初设的 30 分钟改成 **60 秒**：实测冷启动 2.4 秒、常驻 330MB，不值当挂着；陪看进行中由 `watch-run.js` 的 `minIdleMs = 段长 + 30s` 自动延长，两段之间不会被关。
- **只有插件拉起的实例会被它停**（`owned` 语义）。手动起的那个插件不管，会一直挂着，要自己 `POST /shutdown`。

## 4. 实测（用户自己那支视频，1,319.8s）

```
[asr] 转写 250s–262s（≈375KB @16k 单声道）… 699ms，6 段
  250.34–251.79  从这个意向空间登出。
  252.02–254.19  我们因此落入一个画风不同的地方。
  254.54–256.63  这里出现了一个白发少女。
  256.90–258.57  他引导我们在这片空间探索。
  258.80–259.70  孤僻少年X。
  260.00–261.39  与电子少女乖的。
```

- 时间码是**视频绝对秒**（上游把片段起点加回去了，服务端returned的是切片相对时间 → 没有二次偏移）。
- 12s → 0.36s（33× 实时）；120s → 4.4s / 50 段 / 3 片（27× 实时）。
- 契约检查：合成音频 6/6、真实对白 7/7 全过。

## 5. 三道闸门（实测踩出来的，不是设计时想到的）

| 现象 | 原因 | 处理 |
|---|---|---|
| 纯静音返回 `"그."` | 整片兜底解码不看能量 | 峰值 < 0.006 不送识别 |
| 纯正弦返回 `"Yeah. The."` | 稳态音骗过识别器；碎片太短躲过逐段判 | 整片过零率 std 与谱质心 std 双低 → 判为非语音，直接空段 |
| 0.26–0.31s 过场音变成 `"喂。"` `"や。"` | 音效被当语音 | 区间下限 0.45s + 结果至少 2 个实义字符 |
| `auto` 语言混合日语/韩语碎片 | SenseVoice 语言自动判定 | 默认 `--language zh` |

真人说话的声学特征（实测 6 段）：过零率 std 0.065–0.17、谱质心 std 147–631；纯正弦分别是 0.017 与 0。阈值取在中间，留了余量。

## 6. 与 02 §7 验收清单的对照

| # | 项 | 结果 |
|---|---|---|
| 1 | 假 HTTP 服务测试（form 字段、相对时间戳、无重复偏移） | ✅ `check_asr_contract.mjs --fake` 6/6 + 单测 9/9 |
| 2 | 有字幕样例 ASR 调用为零 | ❌ 未测（需要站点字幕/带字幕轨的样例） |
| 3 | 同段重复请求命中缓存 | ❌ 未端到端验证（`bin/asr-check.mjs` 直接调 `transcribeLong`，绕过 pipeline 的 `transcript-cache`；缓存键维度已核对代码） |
| 4 | 无音轨/静音/401/错误模型/超时/非法响应 | 部分：静音 ✅ 空段、坏音频 ✅ 真 4xx；无音轨/401/超时未构造 |
| 5 | 暂停/停止/快进/换片无迟到评论 | ❌ 属于陪看循环侧，本次未测 |
| 6 | 用用户认可的视频实测 | ✅ 用用户自己的视频跑了 12s 与 120s 两段；未跑整片 |
| 7 | 回归原视频陪看、屏幕 Watch、Memory Evolve | ❌ 未做（等重启后一次真实陪看） |

## 7. 已知限制

1. 音乐/音效密集处仍会出碎句（示例："记的危胁。"）。能量 VAD 分不出语音与配乐，上游的 `music-like` 过滤只管长时段。
2. 45 秒切片边界会把两句话拼成一句（"探索了孤僻少年X"）。
3. 专有名词仍会错；术语校正表（`asr.json` 的 `terms`）没建。
4. 台词路径（`loadCues`）只在 **URL 且媒体已下载** 时才走 ASR —— 本地文件直接返回 `local-file-needs-sidecar`（要求同名 .srt）。所以"两条路径都验证过"要改成"两条路径共享同一个 `asr.js`/`transcribeLong` 层，该层已端到端验证；台词路径的入口分支本次未单独跑通"。交接文档 02 §2 的表述建议按这句修正。
5. 服务进程不由 DSH 常驻守护：`manage.start` 拉起后，`idleMs` 30 分钟没有转写才会退出；插件进程若先退出，服务会变成孤儿进程（不占 CPU，只占约 500MB 内存）。

## 8. 回退

1. 删 `C:\Users\Mio\.dsh\asr.json` → 回到"未配置 ASR"，插件报 `no-key`，无字幕视频不再尝试转写。
2. 想留着配置但临时不用：`asr.json` 里加 `"enabled": false`（`resolveAsrConfig` 认这个字段），或把 `manage` 段删掉并手动控制服务。
3. 停服务：`curl -X POST http://127.0.0.1:8000/shutdown`（或任务管理器结束 python）。
4. 完全移除：删 `tools/asr/`（含模型 228MB）与 `.dsh/asr.json`；`.venv` 里 `pip uninstall sherpa-onnx`。

上游插件、Orb 开发包、记忆模块**都没有改动**，所以回退不涉及任何版本/哈希回滚。
