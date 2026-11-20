import { n as stripMarkdown } from "./speak-text-DzmRFSNt.js";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { Worker } from "node:worker_threads";
import { appendFileSync, existsSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pinyin } from "pinyin-pro";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
//#region src/keywords.ts
/**
* Wake phrase → sherpa keyword-spotter token line.
* The line is `tokens @label` with no comment and no blank line.
* Sherpa crashes if the file contains anything else.
*/
const INITIAL_2 = [
	"zh",
	"ch",
	"sh"
];
const INITIAL_1 = /* @__PURE__ */ new Set([
	"b",
	"p",
	"m",
	"f",
	"d",
	"t",
	"n",
	"l",
	"g",
	"k",
	"h",
	"j",
	"q",
	"x",
	"r",
	"z",
	"c",
	"s",
	"y",
	"w"
]);
function contextFromFiles(modelDir) {
	return {
		tokens: loadTokens(join(modelDir, "tokens.txt")),
		lexicon: loadLexicon(join(modelDir, "en.phone"))
	};
}
/** One phrase, one token line. `display` is the label after `@`. */
function tokenizeKeyword(text, ctx, display = text) {
	const label = display.trim().replace(/\s+/g, "_");
	const tokens = [];
	const re = /([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+)|([A-Za-z][A-Za-z'-]*)/g;
	let last = 0;
	for (let match = re.exec(text); match !== null; match = re.exec(text)) {
		const gap = text.slice(last, match.index);
		if (/[^\s_]/.test(gap)) throw new Error(`unsupported character in "${gap.trim()}"`);
		last = re.lastIndex;
		if (match[1]) for (const syllable of pinyin(match[1], {
			toneType: "symbol",
			type: "array"
		})) tokens.push(...splitSyllable(syllable, ctx.tokens));
		else {
			const word = (match[2] ?? "").toUpperCase();
			const bare = word.replace(/['-]/g, "");
			const phones = ctx.lexicon.get(word) ?? ctx.lexicon.get(bare) ?? segmentOov(bare, ctx.lexicon);
			if (!phones) throw new Error(`no pronunciation for "${match[2]}"`);
			for (const phone of phones) if (!ctx.tokens.has(phone)) throw new Error(`phone "${phone}" is not in tokens.txt`);
			tokens.push(...phones);
		}
	}
	if (tokens.length === 0) throw new Error("empty wake phrase");
	return `${tokens.join(" ")} @${label}`;
}
/** Several phrases, one token line each. A phrase that cannot be tokenized is skipped. */
function keywordLines(phrases, ctx) {
	const lines = [];
	for (const phrase of phrases) {
		const text = phrase.trim();
		if (!text) continue;
		try {
			lines.push(tokenizeKeyword(text, ctx));
		} catch {}
	}
	return lines;
}
function splitSyllable(syllable, tokens) {
	const candidates = [];
	if (INITIAL_2.some((initial) => syllable.startsWith(initial))) candidates.push([syllable.slice(0, 2), syllable.slice(2)]);
	const first = syllable[0] ?? "";
	if (INITIAL_1.has(first)) candidates.push([first, syllable.slice(1)]);
	candidates.push([syllable]);
	for (const candidate of candidates) if (candidate.every((token) => token !== "" && tokens.has(token))) return candidate;
	throw new Error(`cannot split syllable "${syllable}"`);
}
function segmentOov(word, lexicon) {
	const memo = /* @__PURE__ */ new Map();
	const solve = (index, allowSingle) => {
		if (index === word.length) return [];
		const key = `${index}:${allowSingle ? 1 : 0}`;
		if (memo.has(key)) return memo.get(key);
		for (let len = word.length - index; len >= 1; len -= 1) {
			if (len === 1 && !allowSingle) continue;
			const piece = word.slice(index, index + len);
			const phones = lexicon.get(piece);
			if (phones === void 0) continue;
			const rest = solve(index + len, allowSingle);
			if (rest !== void 0) {
				const out = [...phones, ...rest];
				memo.set(key, out);
				return out;
			}
		}
		memo.set(key, void 0);
	};
	return solve(0, false) ?? solve(0, true);
}
function loadTokens(file) {
	const tokens = /* @__PURE__ */ new Set();
	for (const line of readFileSync(file, "utf8").split("\n")) {
		const token = line.trim().split(/\s+/)[0];
		if (token && !token.startsWith("<")) tokens.add(token);
	}
	return tokens;
}
function loadLexicon(file) {
	const lexicon = /* @__PURE__ */ new Map();
	let text = "";
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return lexicon;
	}
	for (const line of text.split("\n")) {
		const parts = line.trim().split(/\s+/);
		const word = parts[0];
		if (word && parts.length >= 2) lexicon.set(word, parts.slice(1));
	}
	return lexicon;
}
/** A level at or below this RMS is silence. Speech sits around 0.02 to 0.2. */
const FLOOR_RMS = 5e-4;
const MAX_RMS = .35;
/** A short attack and a slower release make the bar feel like it follows a voice. */
const RELEASE = .78;
var LevelMeter = class {
	sum = 0;
	count = 0;
	lastAt = -Infinity;
	value = 0;
	/** Add captured samples. Returns a new level when the reporting interval elapsed. */
	push(samples, now) {
		if (samples.length > 0) {
			let sum = 0;
			for (let i = 0; i < samples.length; i += 1) {
				const sample = samples[i] ?? 0;
				sum += sample * sample;
			}
			this.sum += sum;
			this.count += samples.length;
		}
		if (now - this.lastAt < 50) return void 0;
		this.lastAt = now;
		if (this.count === 0) return void 0;
		const rms = Math.sqrt(this.sum / this.count);
		this.sum = 0;
		this.count = 0;
		const target = normalize(rms);
		this.value = target >= this.value ? target : this.value * RELEASE + target * .21999999999999997;
		return round(this.value);
	}
	/** A new listening mode starts from silence, not from the previous phrase's tail. */
	reset() {
		this.sum = 0;
		this.count = 0;
		this.lastAt = -Infinity;
		this.value = 0;
	}
};
/**
* RMS to a 0..1 display value. A square-root curve keeps quiet speech visible instead
* of pinning the bar near zero until the user nearly shouts.
*/
function normalize(rms) {
	if (!(rms > FLOOR_RMS)) return 0;
	return round(Math.min(1, Math.sqrt(Math.min(rms, MAX_RMS) / MAX_RMS)));
}
function round(value) {
	return Math.round(value * 1e3) / 1e3;
}
const QWEN_TTS_URL = `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-tts-flash-realtime`;
/** 24 kHz, 16-bit, mono, little-endian PCM without a container. */
const QWEN_SAMPLE_RATE = 24e3;
const QWEN_SPEED_MIN = .5;
const DEFAULT_QWEN_SPEED = 1.4;
/** 普通话与多语种. */
const STANDARD = [
	{
		voice: "Cherry",
		name: "芊悦",
		gender: "女",
		note: "阳光亲切",
		group: "standard"
	},
	{
		voice: "Serena",
		name: "苏瑶",
		gender: "女",
		note: "温柔",
		group: "standard"
	},
	{
		voice: "Ethan",
		name: "晨煦",
		gender: "男",
		note: "阳光，略带北方口音",
		group: "standard"
	},
	{
		voice: "Chelsie",
		name: "千雪",
		gender: "女",
		note: "二次元",
		group: "standard"
	},
	{
		voice: "Momo",
		name: "茉兔",
		gender: "女",
		note: "撒娇搞怪",
		group: "standard"
	},
	{
		voice: "Vivian",
		name: "十三",
		gender: "女",
		note: "拽、小暴躁",
		group: "standard"
	},
	{
		voice: "Moon",
		name: "月白",
		gender: "男",
		note: "率性帅气",
		group: "standard"
	},
	{
		voice: "Maia",
		name: "四月",
		gender: "女",
		note: "知性温柔",
		group: "standard"
	},
	{
		voice: "Kai",
		name: "凯",
		gender: "男",
		note: "舒缓",
		group: "standard"
	},
	{
		voice: "Nofish",
		name: "不吃鱼",
		gender: "男",
		note: "不翘舌的设计师",
		group: "standard"
	},
	{
		voice: "Bella",
		name: "萌宝",
		gender: "女",
		note: "小萝莉",
		group: "standard"
	},
	{
		voice: "Jennifer",
		name: "詹妮弗",
		gender: "女",
		note: "美语电影质感",
		group: "standard"
	},
	{
		voice: "Ryan",
		name: "甜茶",
		gender: "男",
		note: "戏感强",
		group: "standard"
	},
	{
		voice: "Katerina",
		name: "卡捷琳娜",
		gender: "女",
		note: "御姐",
		group: "standard"
	},
	{
		voice: "Aiden",
		name: "艾登",
		gender: "男",
		note: "美语大男孩",
		group: "standard"
	},
	{
		voice: "Eldric Sage",
		name: "沧明子",
		gender: "男",
		note: "沉稳老者",
		group: "standard"
	},
	{
		voice: "Mia",
		name: "乖小妹",
		gender: "女",
		note: "乖巧",
		group: "standard"
	},
	{
		voice: "Mochi",
		name: "沙小弥",
		gender: "男",
		note: "早慧小大人",
		group: "standard"
	},
	{
		voice: "Bellona",
		name: "燕铮莺",
		gender: "女",
		note: "洪亮、字正腔圆",
		group: "standard"
	},
	{
		voice: "Vincent",
		name: "田叔",
		gender: "男",
		note: "沙哑烟嗓",
		group: "standard"
	},
	{
		voice: "Bunny",
		name: "萌小姬",
		gender: "女",
		note: "萌系小萝莉",
		group: "standard"
	},
	{
		voice: "Neil",
		name: "阿闻",
		gender: "男",
		note: "新闻主持人",
		group: "standard"
	},
	{
		voice: "Elias",
		name: "墨讲师",
		gender: "女",
		note: "讲课",
		group: "standard"
	},
	{
		voice: "Arthur",
		name: "徐大爷",
		gender: "男",
		note: "质朴、慢",
		group: "standard"
	},
	{
		voice: "Nini",
		name: "邻家妹妹",
		gender: "女",
		note: "软糯",
		group: "standard"
	},
	{
		voice: "Seren",
		name: "小婉",
		gender: "女",
		note: "助眠、舒缓",
		group: "standard"
	},
	{
		voice: "Pip",
		name: "顽屁小孩",
		gender: "男",
		note: "调皮童声",
		group: "standard"
	},
	{
		voice: "Stella",
		name: "少女阿月",
		gender: "女",
		note: "甜、少女音",
		group: "standard"
	},
	{
		voice: "Bodega",
		name: "博德加",
		gender: "男",
		note: "热情西班牙大叔",
		group: "standard"
	},
	{
		voice: "Sonrisa",
		name: "索尼莎",
		gender: "女",
		note: "开朗拉美大姐",
		group: "standard"
	},
	{
		voice: "Alek",
		name: "阿列克",
		gender: "男",
		note: "低沉、俄语口音",
		group: "standard"
	},
	{
		voice: "Dolce",
		name: "多尔切",
		gender: "男",
		note: "慵懒意大利大叔",
		group: "standard"
	},
	{
		voice: "Sohee",
		name: "素熙",
		gender: "女",
		note: "韩语欧尼",
		group: "standard"
	},
	{
		voice: "Ono Anna",
		name: "小野杏",
		gender: "女",
		note: "鬼灵精怪",
		group: "standard"
	},
	{
		voice: "Lenn",
		name: "莱恩",
		gender: "男",
		note: "理性德国青年",
		group: "standard"
	},
	{
		voice: "Emilien",
		name: "埃米尔安",
		gender: "男",
		note: "浪漫法国大哥哥",
		group: "standard"
	},
	{
		voice: "Andre",
		name: "安德雷",
		gender: "男",
		note: "磁性沉稳",
		group: "standard"
	},
	{
		voice: "Radio Gol",
		name: "拉迪奥·戈尔",
		gender: "男",
		note: "足球解说",
		group: "standard"
	}
];
/** 方言：仍是同一个 voice 字段，没有独立的方言参数。 */
const DIALECT = [
	{
		voice: "Jada",
		name: "上海-阿珍",
		gender: "女",
		note: "上海话",
		group: "dialect"
	},
	{
		voice: "Dylan",
		name: "北京-晓东",
		gender: "男",
		note: "北京话",
		group: "dialect"
	},
	{
		voice: "Li",
		name: "南京-老李",
		gender: "男",
		note: "南京话",
		group: "dialect"
	},
	{
		voice: "Marcus",
		name: "陕西-秦川",
		gender: "男",
		note: "陕西话",
		group: "dialect"
	},
	{
		voice: "Roy",
		name: "闽南-阿杰",
		gender: "男",
		note: "闽南语",
		group: "dialect"
	},
	{
		voice: "Peter",
		name: "天津-李彼得",
		gender: "男",
		note: "天津话",
		group: "dialect"
	},
	{
		voice: "Sunny",
		name: "四川-晴儿",
		gender: "女",
		note: "四川话",
		group: "dialect"
	},
	{
		voice: "Eric",
		name: "四川-程川",
		gender: "男",
		note: "四川话",
		group: "dialect"
	},
	{
		voice: "Rocky",
		name: "粤语-阿强",
		gender: "男",
		note: "粤语",
		group: "dialect"
	},
	{
		voice: "Kiki",
		name: "粤语-阿清",
		gender: "女",
		note: "粤语",
		group: "dialect"
	}
];
const QWEN_VOICES = [...STANDARD, ...DIALECT];
new Set(QWEN_VOICES.map((item) => item.voice));
/** Round to the settings step, then pull into 0.5–2.0. Non-numbers are the factory speed. */
function clampQwenSpeed(value) {
	if (!Number.isFinite(value)) return DEFAULT_QWEN_SPEED;
	const rounded = Math.round(value * 10) / 10;
	if (rounded < .5) return QWEN_SPEED_MIN;
	if (rounded > 2) return 2;
	return rounded;
}
/**
* One speaker sample at `gain`.
* A boost is clamped to full scale instead of wrapping around, and a NaN from a
* broken decoder becomes silence rather than a click.
*/
function scaledSample(sample, gain) {
	if (!Number.isFinite(sample)) return 0;
	if (gain === 1) return sample;
	const value = sample * gain;
	if (!Number.isFinite(value)) return 0;
	if (value > 1) return 1;
	if (value < -1) return -1;
	return value;
}
//#endregion
//#region src/settings.ts
/** Another part of the product treats an empty wake list as "no wake word at all". */
function hasWakeWord(words) {
	return words.some((word) => word.trim() !== "");
}
//#endregion
//#region src/listen.ts
/**
* Which decoder the one open microphone feeds.
* Host computes this from the ball's pin, the turn, the question card, playback,
* and whether each model is switched on and present. The child only applies it.
*/
/** command 和 interject 都是「转写开着」。 */
function transcribing(mode) {
	return mode === "command" || mode === "interject";
}
/**
* Whether the child must hold the microphone at all. TTS never needs it; only a
* listening column that is switched on and has a complete model does. When both
* columns are off or unready, the device is released so macOS stops showing the
* microphone indicator.
*/
function needsMicrophone(input) {
	return input.wakeEnabled && hasWakeWord(input.wakeWords) && input.wakeModel || input.commandEnabled && input.asrModel;
}
/**
* 子进程要不要用原生 VPIO 采集。
*
* VPIO 会压低整个系统输出，所以只在转写开着时用：`command` 只在面板固定时可达，
* `interject` 只在执行中或收尾播报把面板留住时可达，`wake` 就是收起状态。唤醒、
* 看视频、玩游戏这些时候走普通采集，系统音量不受影响。
*/
function wantsNativeCapture(mode, useCpal, helper) {
	return transcribing(mode) && !useCpal && helper;
}
//#endregion
//#region src/dismiss.ts
/**
* Dismiss phrases matched anywhere in the recognized sentence.
* Punctuation, spacing, width, and Latin case are ignored on both sides, so
*「好的，你给我退下吧。」contains the factory phrase「退下吧」.
*/
const IGNORED = /[\s\p{P}\p{S}]+/gu;
/** Drop punctuation, symbols, and whitespace; normalize width and Latin case. */
function normalizeUtterance(text) {
	return text.normalize("NFKC").toLowerCase().replace(IGNORED, "");
}
/** 整句完整带出任意一条，就命中。空白、标点、全半角、拉丁大小写都忽略。 */
function containsAny(text, phrases) {
	const spoken = normalizeUtterance(text);
	if (!spoken) return false;
	return phrases.some((phrase) => {
		const command = normalizeUtterance(phrase);
		return command.length > 0 && spoken.includes(command);
	});
}
/**
* The same containment check on toneless pinyin syllables, so an ASR homophone
* still counts: 「大飞鱼，把明天也查一下」contains the spoken keyword 「大肥鱼」.
* A one-syllable phrase is left to exact matching; every homophone would match it.
*/
function containsPhonetic(text, phrase) {
	return phoneticHit(text, phrase, 0, false);
}
/**
* The interject keyword is the weak spot: SenseVoice turns 「大肥鱼」 into
* 「贾飞鱼」/「大飞鱼」 often enough that an exact homophone loses half the
* interjections. A three-syllable-or-longer keyword therefore allows one wrong
* syllable, as long as the **last** syllable is still right — that anchor keeps
* 「大飞机」 or 「坐下吧」 from matching 「大肥鱼」/「退下吧」.
*/
function containsKeywordPhonetic(text, phrase) {
	return phoneticHit(text, phrase, syllables$1(phrase).length >= 3 ? 1 : 0, true);
}
function phoneticHit(text, phrase, slack, anchorLast) {
	const wanted = syllables$1(phrase);
	if (wanted.length < 2) return false;
	const heard = syllables$1(text);
	if (heard.length < wanted.length) return false;
	for (let start = 0; start <= heard.length - wanted.length; start += 1) {
		let missed = 0;
		let hit = true;
		for (let offset = 0; offset < wanted.length; offset += 1) {
			if (heard[start + offset] === wanted[offset]) continue;
			if (anchorLast && offset === wanted.length - 1) {
				hit = false;
				break;
			}
			missed += 1;
			if (missed > slack) {
				hit = false;
				break;
			}
		}
		if (hit && missed <= slack) return true;
	}
	return false;
}
/** The phrase is present exactly, or close enough by pinyin to be the same spoken word. */
function mentions(text, phrase) {
	return containsAny(text, [phrase]) || containsPhonetic(text, phrase) || containsKeywordPhonetic(text, phrase);
}
function syllables$1(text) {
	const cleaned = normalizeUtterance(text);
	if (!cleaned) return [];
	return pinyin(cleaned, {
		toneType: "none",
		type: "array",
		nonZh: "consecutive"
	}).map((part) => part.trim()).filter((part) => part.length > 0);
}
//#endregion
//#region src/echo.ts
/**
* Text echo check. Acoustic echo cancellation is the real filter; this only
* drops a transcript that is mostly the line we were just speaking.
*/
/**
* 这句转写是不是我们自己播出去的声音。
* 取和 [from - 500ms, to] 有重叠的播报句，把双方都转成不带声调的拼音音节，
* 求最长公共子序列。它占转写音节数的比例不低于 0.6，就算回声。
* 转写不足 2 个音节时，不按回声处理。
* 转写里带出了插话关键词或任意一条退下口令，而重叠的播报句里没有它，就不是回声。
*/
function isEcho(utterance, spoken, window, commands) {
	const heard = syllables(utterance);
	if (heard.length < 2) return false;
	const overlapping = spoken.filter((line) => overlaps(line, window));
	if (overlapping.length === 0) return false;
	for (const command of commands) {
		if (!mentions(utterance, command)) continue;
		if (!overlapping.some((line) => mentions(line.text, command))) return false;
	}
	const played = syllables(overlapping.map((line) => line.text).join(""));
	if (played.length === 0) return false;
	if (played.length >= heard.length * 4) return false;
	return longestCommon(heard, played) / heard.length >= .6;
}
function overlaps(line, window) {
	const start = window.from - 500;
	if (line.startedAt >= window.to) return false;
	if (line.endedAt !== void 0 && line.endedAt <= start) return false;
	return true;
}
function syllables(text) {
	const cleaned = normalizeUtterance(text);
	if (!cleaned) return [];
	return pinyin(cleaned, {
		toneType: "none",
		type: "array",
		nonZh: "consecutive"
	}).map((part) => part.trim()).filter((part) => part.length > 0);
}
function longestCommon(left, right) {
	const rows = left.length + 1;
	const cols = right.length + 1;
	const score = new Array(cols).fill(0);
	for (let row = 1; row < rows; row += 1) {
		let previous = 0;
		for (let col = 1; col < cols; col += 1) {
			const current = score[col] ?? 0;
			if (left[row - 1] === right[col - 1]) score[col] = previous + 1;
			else score[col] = Math.max(current, score[col - 1] ?? 0);
			previous = current;
		}
	}
	return score[cols - 1] ?? 0;
}
//#endregion
//#region src/qwen-tts.ts
/**
* Qwen realtime synthesis: one text segment in, PCM blocks out.
* The caller plays each block as it arrives, so the sentence starts on the
* first block instead of waiting for the whole synthesis.
*
* Protocol (Beijing region, `server_commit`): connect, `session.update`, wait
* for `session.updated`, append the text once, finish, and read
* `response.audio.delta` until `session.finished`. A cancel closes the socket,
* which is what actually stops the cloud request.
*/
/** The service caps one request at 5000 characters; leave room for cleaning. */
const QWEN_TEXT_LIMIT = 4e3;
const CONNECT_TIMEOUT_MS = 1e4;
const FIRST_AUDIO_TIMEOUT_MS = 3e3;
const IDLE_TIMEOUT_MS = 3e4;
const RETRY_DELAY_MS = 300;
/** Markdown out, one line of speakable text in. English stays in the same run. */
function prepareQwenText(text) {
	return stripMarkdown(String(text)).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").replace(/\s+/g, " ").trim();
}
/** Cut long text at sentence ends, then commas, then a hard boundary. */
function splitQwenText(text, max = QWEN_TEXT_LIMIT) {
	const source = text.trim();
	if (!source) return [];
	const limit = Math.max(1, Math.floor(max));
	const chunks = [];
	let rest = source;
	while (rest.length > limit) {
		const window = rest.slice(0, limit);
		let cut = -1;
		for (let i = window.length - 1; i >= Math.floor(limit * .5); i -= 1) {
			const char = window[i] ?? "";
			if ("。！？!?".includes(char)) {
				cut = i + 1;
				break;
			}
			if (char === "." && (i + 1 === window.length || /\s/.test(window[i + 1] ?? ""))) {
				cut = i + 1;
				break;
			}
		}
		if (cut < 0) {
			const breakAt = Math.max(window.lastIndexOf("，"), window.lastIndexOf(","), window.lastIndexOf("；"), window.lastIndexOf(";"), window.lastIndexOf(" "));
			cut = breakAt > limit * .5 ? breakAt + 1 : limit;
		}
		const head = rest.slice(0, cut).trim();
		if (head) chunks.push(head);
		rest = rest.slice(cut).trim();
	}
	if (rest) chunks.push(rest);
	return chunks;
}
/** `session.update` for one connection. Voice and speed are fixed for this sentence. */
function qwenSessionUpdate(voice, speed) {
	return {
		mode: "server_commit",
		voice,
		language_type: "Chinese",
		response_format: "pcm",
		sample_rate: QWEN_SAMPLE_RATE,
		speech_rate: clampQwenSpeed(speed)
	};
}
/** Base64 of 16-bit little-endian mono PCM into normalised floats. */
function decodeQwenPcm(delta) {
	const bytes = Buffer.from(delta, "base64");
	const count = Math.floor(bytes.length / 2);
	const samples = new Float32Array(count);
	for (let i = 0; i < count; i += 1) samples[i] = bytes.readInt16LE(i * 2) / 32768;
	return samples;
}
function eventId() {
	return `event_${randomBytes(16).toString("hex")}`;
}
/**
* Speak one queue item. Text longer than one request is sent as ordered
* segments over one playback; `onDone` fires after the last segment.
*/
function speakQwen(options) {
	const apiKey = options.apiKey.trim();
	const segments = splitQwenText(prepareQwenText(options.text));
	const connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
	const firstAudioTimeoutMs = options.firstAudioTimeoutMs ?? FIRST_AUDIO_TIMEOUT_MS;
	const idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
	const retries = Math.max(0, Math.floor(options.retries ?? 2));
	let settled = false;
	let current;
	const fail = (message) => {
		if (settled) return;
		settled = true;
		current = void 0;
		const text = message.trim() === "" ? "千问语音合成失败" : message;
		options.onError?.(redact(text, apiKey));
	};
	const complete = () => {
		if (settled) return;
		settled = true;
		current = void 0;
		options.onDone();
	};
	const start = (index, retry = 0) => {
		if (settled) return;
		const text = segments[index];
		if (text === void 0) {
			complete();
			return;
		}
		let gotAudio = false;
		current = openSegment(text, {
			apiKey,
			voice: options.voice,
			speed: options.speed,
			connectTimeoutMs,
			firstAudioTimeoutMs,
			idleTimeoutMs,
			socket: options.socket,
			onAudio: (samples, sampleRate) => {
				gotAudio = true;
				options.onAudio(samples, sampleRate);
			},
			onComplete: () => start(index + 1),
			onFailure: (message, retryable) => {
				if (settled) return;
				if (retryable && !gotAudio && retry < retries) {
					current = void 0;
					options.onRetry?.(message, retry + 1);
					setTimeout(() => {
						if (!settled) start(index, retry + 1);
					}, RETRY_DELAY_MS);
					return;
				}
				fail(message);
			}
		});
	};
	if (segments.length === 0) queueMicrotask(() => {
		if (!settled) complete();
	});
	else start(0);
	return { cancel() {
		if (settled) return;
		settled = true;
		const active = current;
		current = void 0;
		active?.close();
	} };
}
/** One connection for one text segment. All callbacks fire at most once. */
function openSegment(text, options) {
	let socket;
	try {
		socket = (options.socket ?? defaultSocket)(QWEN_TTS_URL, { headers: { Authorization: `Bearer ${options.apiKey}` } });
	} catch (error) {
		options.onFailure(error instanceof Error ? error.message : String(error), false);
		return { close() {} };
	}
	let settled = false;
	let sentText = false;
	let gotAudio = false;
	let timer;
	const clearTimer = () => {
		if (timer !== void 0) clearTimeout(timer);
		timer = void 0;
	};
	/** Returns false when this segment already settled; late socket events are then ignored. */
	const take = () => {
		if (settled) return false;
		settled = true;
		clearTimer();
		return true;
	};
	const close = () => {
		if (!take()) return;
		try {
			socket.close();
		} catch {}
	};
	const fail = (message, retryable = false) => {
		if (!take()) return;
		try {
			socket.close();
		} catch {}
		options.onFailure(message, retryable);
	};
	const complete = () => {
		if (!take()) return;
		try {
			socket.close();
		} catch {}
		options.onComplete();
	};
	const arm = (ms) => {
		clearTimer();
		timer = setTimeout(() => fail("千问语音合成超时", true), ms);
		timer.unref?.();
	};
	const send = (payload) => {
		socket.send(JSON.stringify({
			event_id: eventId(),
			...payload
		}));
	};
	socket.onOpen(() => {
		if (settled) return;
		try {
			send({
				type: "session.update",
				session: qwenSessionUpdate(options.voice, options.speed)
			});
		} catch (error) {
			fail(error instanceof Error ? error.message : String(error));
		}
	});
	socket.onMessage((data) => {
		if (settled) return;
		arm(gotAudio ? options.idleTimeoutMs : options.firstAudioTimeoutMs);
		let parsed;
		try {
			parsed = JSON.parse(data);
		} catch {
			return;
		}
		if (typeof parsed !== "object" || parsed === null) return;
		const message = parsed;
		const type = message.type;
		if (type === "error") {
			const error = message.error;
			const detail = typeof error === "object" && error !== null && "message" in error ? String(error.message ?? "") : "";
			fail(detail || "千问语音合成失败");
			return;
		}
		if (type === "session.updated") {
			if (sentText) return;
			sentText = true;
			try {
				send({
					type: "input_text_buffer.append",
					text
				});
				send({ type: "session.finish" });
			} catch (error) {
				fail(error instanceof Error ? error.message : String(error));
				return;
			}
			arm(options.firstAudioTimeoutMs);
			return;
		}
		if (type === "response.audio.delta") {
			const delta = message.delta;
			if (typeof delta !== "string" || delta === "") return;
			try {
				const samples = decodeQwenPcm(delta);
				if (samples.length > 0) {
					gotAudio = true;
					options.onAudio(samples, QWEN_SAMPLE_RATE);
					arm(options.idleTimeoutMs);
				}
			} catch (error) {
				fail(error instanceof Error ? error.message : String(error));
			}
			return;
		}
		if (type === "session.finished") complete();
	});
	socket.onError(() => fail("千问语音连接失败"));
	socket.onClose(() => fail("千问语音连接中断"));
	arm(options.connectTimeoutMs);
	return { close };
}
/** Production socket: Node's global WebSocket, which takes handshake headers. */
function defaultSocket(url, init) {
	const ws = new WebSocket(url, init);
	return {
		send(data) {
			ws.send(data);
		},
		close() {
			ws.close();
		},
		onOpen(listener) {
			ws.addEventListener("open", () => listener());
		},
		onMessage(listener) {
			ws.addEventListener("message", (event) => {
				const data = event.data;
				if (typeof data === "string") listener(data);
			});
		},
		onError(listener) {
			ws.addEventListener("error", () => listener("network error"));
		},
		onClose(listener) {
			ws.addEventListener("close", () => listener());
		}
	};
}
function redact(message, secret) {
	if (!secret || !message.includes(secret)) return message;
	return message.split(secret).join("***");
}
//#endregion
//#region src/speaker.ts
/**
* Speaker notices that are not failures.
* A cloud sentence is buffered as it arrives, so CPAL occasionally reports an
* underrun when the network pauses; its callback has already written silence and
* the next chunk resumes normally. Ending the sentence there would cut it short.
*/
function speakerErrorMessage(error) {
	if (error instanceof Error) return error.message;
	if (typeof error === "object" && error !== null && "message" in error) {
		const message = error.message;
		if (typeof message === "string") return message;
	}
	return String(error);
}
function isRecoverableSpeakerError(error) {
	return /underrun|overrun/i.test(speakerErrorMessage(error));
}
//#endregion
//#region src/capture.ts
/**
* Microphone capture for the voice child.
* A native helper supplies echo-cancelled PCM when it is installed. Otherwise
* node-cpal opens the default input and the host turns listening off while
* our own speech is playing.
*/
const TARGET_RATE$1 = 16e3;
const READY_MS = 5e3;
/** The helper named by the test env, or the prebuild next to this file. */
function captureBinary() {
	const fromEnv = process.env.DSH_ORB_CAPTURE_BIN;
	if (fromEnv) return fromEnv;
	const name = process.platform === "win32" ? "win32-x64/dsh-orb-voice-capture.exe" : "darwin-universal/dsh-orb-voice-capture";
	for (const url of [new URL(`./prebuilds/${name}`, import.meta.url), new URL(`../prebuilds/${name}`, import.meta.url)]) {
		const path = fileURLToPath(url);
		if (existsSync(path)) return path;
	}
}
var NativeCapture = class {
	binary;
	child;
	timer;
	settled = false;
	reportedError = false;
	constructor(binary) {
		this.binary = binary;
	}
	start(handlers) {
		const script = /\.(?:mjs|cjs|js)$/.test(this.binary);
		const child = spawn(script ? process.execPath : this.binary, script ? [this.binary] : [], { stdio: [
			"pipe",
			"pipe",
			"pipe"
		] });
		this.child = child;
		this.timer = setTimeout(() => {
			this.fail(handlers, "unavailable", "capture ready timed out");
			child.kill();
		}, READY_MS);
		let pending = Buffer.alloc(0);
		child.stdout.on("data", (chunk) => {
			if (this.settled) return;
			pending = Buffer.concat([pending, chunk]);
			const usable = pending.length - pending.length % 4;
			if (usable < 4) return;
			const slice = Buffer.from(pending.subarray(0, usable));
			pending = Buffer.from(pending.subarray(usable));
			const samples = new Float32Array(slice.buffer, slice.byteOffset, usable / 4);
			handlers.onPcm(new Float32Array(samples));
		});
		createInterface({ input: child.stderr }).on("line", (line) => {
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				process.stderr.write(`${line}\n`);
				return;
			}
			if (message.event === "ready") {
				if (this.settled) return;
				if (this.timer) clearTimeout(this.timer);
				this.timer = void 0;
				handlers.onReady({ aec: message.aec === true });
				return;
			}
			if (message.event === "error") {
				const code = message.code;
				const reason = code === "mic-denied" || code === "no-device" || code === "unavailable" || code === "failed" ? code : "failed";
				this.reportedError = true;
				this.fail(handlers, reason, typeof message.message === "string" ? message.message : reason);
			}
		});
		child.on("error", (error) => {
			this.fail(handlers, "failed", error.message);
		});
		child.on("exit", () => {
			if (this.settled || this.reportedError) return;
			this.fail(handlers, "crashed", "capture exited before ready");
		});
	}
	close() {
		this.settled = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = void 0;
		const child = this.child;
		this.child = void 0;
		if (!child) return;
		child.stdin.end();
	}
	fail(handlers, reason, detail) {
		if (this.settled) return;
		this.settled = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = void 0;
		handlers.onFailure(reason, detail);
	}
};
/** The previous node-cpal input. It does not cancel echo. */
var CpalCapture = class {
	native;
	stream;
	closed = false;
	constructor(native) {
		this.native = native;
	}
	start(handlers) {
		try {
			const { cpal, sherpa } = this.native;
			const device = cpal.defaultHost().defaultInputDevice();
			if (!device) {
				handlers.onFailure("no-device", "no input device");
				return;
			}
			const capture = pickCapture(cpal, device);
			const resampler = capture.needsResample ? new sherpa.LinearResampler(capture.rate, TARGET_RATE$1) : void 0;
			const stream = device.buildInputStream(capture.config, cpal.SampleFormat.F32, (data) => {
				if (this.closed) return;
				let mono = toMono(data, capture.channels);
				if (resampler) mono = resampler.resample(mono);
				handlers.onPcm(mono);
			}, (error) => {
				const message = error instanceof Error ? error.message : String(error);
				if (message.includes("underrun") || message.includes("overrun")) {
					try {
						stream.play();
					} catch {}
					return;
				}
				handlers.onFailure("failed", message);
			});
			handlers.onReady({ aec: false });
			stream.play();
			this.stream = stream;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			handlers.onFailure("failed", message);
		}
	}
	close() {
		this.closed = true;
		const stream = this.stream;
		this.stream = void 0;
		try {
			stream?.close();
		} catch {}
	}
};
function toMono(data, channels) {
	if (channels <= 1) return data;
	const frames = Math.floor(data.length / channels);
	const out = new Float32Array(frames);
	for (let frame = 0; frame < frames; frame += 1) {
		let sum = 0;
		for (let channel = 0; channel < channels; channel += 1) sum += data[frame * channels + channel] ?? 0;
		out[frame] = sum / channels;
	}
	return out;
}
function pickCapture(cpal, device) {
	const f32 = [...device.supportedInputConfigs()].filter((range) => range.sampleFormat() === cpal.SampleFormat.F32);
	const exact = f32.find((range) => range.channels() === 1 && range.containsRate(TARGET_RATE$1)) ?? f32.find((range) => range.containsRate(TARGET_RATE$1));
	if (exact) return {
		config: new cpal.StreamConfig({
			channels: exact.channels(),
			sampleRate: TARGET_RATE$1,
			bufferSize: cpal.BufferSize.Default
		}),
		channels: exact.channels(),
		rate: TARGET_RATE$1,
		needsResample: false
	};
	const config = device.defaultInputConfig().config();
	return {
		config,
		channels: config.channels,
		rate: config.sampleRate,
		needsResample: config.sampleRate !== TARGET_RATE$1
	};
}
//#endregion
//#region src/child.ts
/**
* Voice child process.
* One microphone is shared by wake and command; it is released when neither column
* can run. SenseVoice decode runs on a worker thread. This thread resamples, mixes,
* and runs VAD.
*/
const require = createRequire(import.meta.url);
const TARGET_RATE = 16e3;
const RING_SAMPLES = TARGET_RATE / 2;
/** Label of the interject keyword inside the spotter's keyword list. */
const INTERJECT_LABEL = "interject";
const VOICE_DEBUG_MARKER = join(tmpdir(), "dsh-orb-voice-debug.on");
const VOICE_DEBUG_LOG = join(tmpdir(), "dsh-orb-voice-debug.log");
/** Opt-in tracing shared with the host; inert unless the marker file exists. */
function debug(message) {
	if (!existsSync(VOICE_DEBUG_MARKER)) return;
	try {
		appendFileSync(VOICE_DEBUG_LOG, `${(/* @__PURE__ */ new Date()).toISOString()} child ${message}\n`);
	} catch {}
}
const emit = (message) => {
	writeSync(1, `${JSON.stringify(message)}\n`);
};
const fail = (error) => {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`dsh-orb voice: ${message}\n`);
};
var Ring = class {
	samples = new Float32Array(RING_SAMPLES);
	writeAt = 0;
	filled = 0;
	push(chunk) {
		for (let i = 0; i < chunk.length; i += 1) {
			this.samples[this.writeAt] = chunk[i] ?? 0;
			this.writeAt = (this.writeAt + 1) % RING_SAMPLES;
			if (this.filled < RING_SAMPLES) this.filled += 1;
		}
	}
	/** The newest `ms` of audio, in order. */
	last(ms) {
		const count = Math.min(this.filled, Math.round(TARGET_RATE * ms / 1e3));
		const out = new Float32Array(count);
		const start = (this.writeAt - count + RING_SAMPLES) % RING_SAMPLES;
		for (let i = 0; i < count; i += 1) out[i] = this.samples[(start + i) % RING_SAMPLES] ?? 0;
		return out;
	}
	/** Forget pre-playback audio, so the next command does not inherit the speaker's echo. */
	clear() {
		this.writeAt = 0;
		this.filled = 0;
	}
};
var VadEar = class {
	detector;
	frameSize = 512;
	padSamples;
	minSilenceSamples;
	absFed = 0;
	carry = /* @__PURE__ */ new Float32Array(0);
	history = [];
	lastEnd = -Infinity;
	detected = false;
	preroll;
	/** True while the VAD has an open phrase; the keyword spotter only arms inside one. */
	get speaking() {
		return this.detected;
	}
	onSpeech;
	onSegment;
	constructor(vad, padSeconds, minSilence, onSpeech, onSegment) {
		this.detector = vad;
		this.padSamples = Math.round(padSeconds * TARGET_RATE);
		this.minSilenceSamples = Math.round(minSilence * TARGET_RATE);
		this.onSpeech = onSpeech;
		this.onSegment = onSegment;
	}
	/** Keep the audio from just before the switch, and attach it to the next phrase only. */
	seed(samples) {
		if (samples.length === 0) return;
		this.preroll = samples;
	}
	push(samples) {
		if (samples.length === 0) return;
		this.history.push({
			abs: this.absFed,
			samples
		});
		this.absFed += samples.length;
		const all = this.carry.length ? concat(this.carry, samples) : samples;
		let index = 0;
		for (; index + this.frameSize <= all.length; index += this.frameSize) {
			this.detector.acceptWaveform(all.subarray(index, index + this.frameSize));
			this.noteDetected();
			this.drain();
		}
		this.carry = all.slice(index);
		this.trim();
	}
	noteDetected() {
		const now = this.detector.isDetected();
		if (now === this.detected) return;
		this.detected = now;
		this.onSpeech(now);
	}
	/**
	* The mode left transcription while the user may still be talking. Keep the phrase
	* that is already open — it was captured while listening was on — then clear state.
	*/
	flush() {
		if (!this.detected) {
			this.reset();
			return;
		}
		this.detector.flush();
		this.drain();
		this.reset();
	}
	/** The listening mode changed away from commands. Drop state that must not leak into the next phrase. */
	reset() {
		const wasSpeaking = this.detected;
		this.detected = false;
		this.preroll = void 0;
		this.carry = /* @__PURE__ */ new Float32Array(0);
		this.history = [];
		this.lastEnd = -Infinity;
		while (!this.detector.isEmpty()) this.detector.pop();
		if (wasSpeaking) this.onSpeech(false);
	}
	drain() {
		while (!this.detector.isEmpty()) {
			const segment = this.detector.front(false);
			const start = segment.start;
			const end = start + segment.samples.length;
			let speech = segment.samples;
			const gap = start - this.lastEnd;
			const needsPad = this.padSamples > 0 && (this.lastEnd === -Infinity || gap >= this.minSilenceSamples);
			if (this.preroll && this.preroll.length > 0) {
				speech = concat(this.preroll, speech);
				this.preroll = void 0;
			} else if (needsPad) {
				const head = this.slice(Math.max(0, start - this.padSamples), start);
				if (head.length) speech = concat(head, segment.samples);
			}
			this.lastEnd = end;
			this.detector.pop();
			this.onSegment(speech);
		}
	}
	slice(from, to) {
		const parts = [];
		for (const chunk of this.history) {
			const start = Math.max(chunk.abs, from);
			const end = Math.min(chunk.abs + chunk.samples.length, to);
			if (end > start) parts.push(chunk.samples.subarray(start - chunk.abs, end - chunk.abs));
		}
		return concat(...parts);
	}
	trim() {
		const keepFrom = this.absFed - 31.3 * TARGET_RATE;
		while (this.history.length > 0) {
			const first = this.history[0];
			if (!first || first.abs + first.samples.length >= keepFrom) break;
			this.history.shift();
		}
	}
};
function concat(...parts) {
	let total = 0;
	for (const part of parts) total += part.length;
	const out = new Float32Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}
function loadNative() {
	try {
		return {
			sherpa: require("sherpa-onnx-node"),
			cpal: require("node-cpal")
		};
	} catch (error) {
		fail(error);
		return;
	}
}
var Engine = class {
	native;
	mode = "off";
	settings;
	paths;
	ring = new Ring();
	kws;
	kwsStream;
	kwsKey = "";
	lastWake = 0;
	/** The acoustic keyword spotter fired inside the open phrase; the ASR text need not repeat it. */
	armedKeyword = false;
	vad;
	worker;
	workerReady = false;
	jobs = [];
	decoding = false;
	jobId = 0;
	pending = /* @__PURE__ */ new Map();
	/** The mode at the moment this utterance opened. command and interject share one segment. */
	segmentMode = "off";
	capture;
	/** False until the host's first listen, so a restart during a question card does not flash the mic. */
	hostDevice = false;
	/** Which source backs the current capture. A mode change can swap it. */
	captureKind;
	/** Once native capture cannot be used, this process stays on node-cpal. */
	useCpal = false;
	/** Native capture has been ready at least once; a failure after that is retried. */
	nativeReady = false;
	captureFailures = [];
	relaunchTimer;
	spoken = [];
	audioHost;
	ttsWorker;
	ttsWait = /* @__PURE__ */ new Map();
	ttsSeq = 0;
	speakToken = 0;
	/** A segment accepted by the synthesizer and not yet handed to the speaker. */
	armed;
	player;
	/** The cloud request for the current sentence, so a stop can close it. */
	qwen;
	/** Smoothed microphone level for the input meter. Commands only; never wake or playback. */
	meter = new LevelMeter();
	constructor(native) {
		this.native = native;
	}
	configure(message) {
		this.settings = message.settings;
		this.paths = message.paths;
		debug(`configure backend=${this.settings?.ttsBackend ?? "local"} key=${this.settings?.qwenApiKey?.trim() ? "yes" : "no"} voice=${this.settings?.qwenVoice ?? ""} speed=${this.settings?.qwenSpeed ?? ""} volume=${this.settings?.ttsVolume ?? 1} tts=${this.settings?.ttsEnabled === true}`);
		this.ensureKws();
		this.ensureAsr();
		this.syncMic();
	}
	listen(mode, seedMs, device = true) {
		const previous = this.mode;
		this.mode = mode;
		const wasTranscribing = transcribing(previous);
		const nowTranscribing = transcribing(mode);
		if (previous !== mode) debug(`listen ${previous}->${mode} device=${device}`);
		if (wasTranscribing && !nowTranscribing) {
			this.vad?.flush();
			emit({
				type: "level",
				value: 0
			});
		}
		if (mode === "wake" && previous !== "wake" && this.kws && this.kwsStream) this.kws.reset(this.kwsStream);
		if (previous === "wake" && mode !== "wake" && this.kws && this.kwsStream) this.kws.reset(this.kwsStream);
		if (mode !== "interject") this.armedKeyword = false;
		if (!wasTranscribing && nowTranscribing) {
			this.meter.reset();
			if (seedMs > 0) this.vad?.seed(this.ring.last(seedMs));
		}
		this.hostDevice = device;
		this.syncMic();
	}
	speak(id, text) {
		this.stopSpeak();
		const token = ++this.speakToken;
		debug(`speak id=${id} backend=${this.settings?.ttsBackend ?? "local"} chars=${text.length}`);
		this.cancelQwen();
		if (this.settings?.ttsBackend === "qwen") {
			this.speakWithQwen(id, text, token);
			return;
		}
		const speed = this.settings?.ttsSpeed ?? 1.5;
		const volume = this.settings?.ttsVolume ?? 1;
		const worker = this.ensureTts();
		if (!worker) {
			debug(`local id=${id} no-worker`);
			emit({
				type: "playback",
				id,
				phase: "start"
			});
			emit({
				type: "playback",
				id,
				phase: "end"
			});
			return;
		}
		this.armed = {
			id,
			token
		};
		const job = ++this.ttsSeq;
		worker.postMessage({
			id: job,
			text,
			speed
		});
		this.ttsWait.set(job, (message) => {
			if (token !== this.speakToken) return;
			if (this.armed?.token === token) this.armed = void 0;
			const samples = message.samples ? new Float32Array(message.samples) : /* @__PURE__ */ new Float32Array(0);
			const sampleRate = message.sampleRate ?? 22050;
			if (message.error || samples.length === 0) {
				debug(`local id=${id} error=${String(message.error ?? "empty")} samples=${samples.length}`);
				if (message.error) fail(new Error(message.error));
				emit({
					type: "playback",
					id,
					phase: "start"
				});
				emit({
					type: "playback",
					id,
					phase: "end"
				});
				return;
			}
			emit({
				type: "playback",
				id,
				phase: "start"
			});
			debug(`local id=${id} play samples=${samples.length} rate=${sampleRate}`);
			try {
				const line = {
					text,
					startedAt: Date.now(),
					endedAt: void 0
				};
				this.noteSpoken(line);
				this.player = playPcm(this.native.cpal, this.ensureHost(), samples, sampleRate, volume, (stopped) => {
					this.player = void 0;
					line.endedAt = Date.now();
					this.ring.clear();
					if (token !== this.speakToken && !stopped) return;
					emit({
						type: "playback",
						id,
						phase: "end",
						...stopped ? { stopped: true } : {}
					});
				});
			} catch (error) {
				fail(error);
				this.ring.clear();
				emit({
					type: "playback",
					id,
					phase: "end"
				});
			}
		});
	}
	/**
	* One queued sentence on the cloud backend. Voice and speed are read here, so a
	* settings change reaches the next sentence and never the one already speaking.
	*/
	speakWithQwen(id, text, token) {
		const apiKey = this.settings?.qwenApiKey ?? "";
		debug(`qwen id=${id} key=${apiKey.trim() ? "yes" : "no"} chars=${text.length}`);
		if (!apiKey.trim() || !text.trim()) {
			debug(`qwen id=${id} skipped empty`);
			emit({
				type: "playback",
				id,
				phase: "end"
			});
			return;
		}
		const voice = this.settings?.qwenVoice ?? "Cherry";
		const speed = this.settings?.qwenSpeed ?? 1.4;
		const volume = this.settings?.ttsVolume ?? 1;
		let player;
		let line;
		let job;
		let settled = false;
		this.armed = {
			id,
			token
		};
		const finish = (stopped) => {
			settled = true;
			debug(`qwen id=${id} finish stopped=${stopped} player=${player !== void 0}`);
			if (player && this.player === player) this.player = void 0;
			if (this.qwen === job) this.qwen = void 0;
			if (line) line.endedAt = Date.now();
			this.ring.clear();
			if (token !== this.speakToken && !stopped) return;
			emit({
				type: "playback",
				id,
				phase: "end",
				...stopped ? { stopped: true } : {}
			});
		};
		job = speakQwen({
			text,
			apiKey,
			voice,
			speed,
			onAudio: (samples, sampleRate) => {
				if (token !== this.speakToken) return;
				if (!player) {
					this.armed = void 0;
					try {
						player = createStreamPlayer(this.native.cpal, this.ensureHost(), sampleRate, volume, (stopped) => finish(stopped));
					} catch (error) {
						fail(error);
						this.armed = void 0;
						job?.cancel();
						finish(true);
						return;
					}
					this.player = player;
					debug(`qwen id=${id} first-audio rate=${sampleRate} first=${samples.length}`);
					const started = {
						text,
						startedAt: Date.now(),
						endedAt: void 0
					};
					line = started;
					this.noteSpoken(started);
					emit({
						type: "playback",
						id,
						phase: "start"
					});
				}
				player.push(samples);
			},
			onDone: () => {
				if (token !== this.speakToken) return;
				debug(`qwen id=${id} done player=${player !== void 0}`);
				settled = true;
				this.qwen = void 0;
				if (this.armed?.id === id) this.armed = void 0;
				if (player) player.end();
				else finish(false);
			},
			onRetry: (message, attempt) => {
				debug(`qwen id=${id} retry=${attempt} ${message.slice(0, 80)}`);
			},
			onError: (message) => {
				if (token !== this.speakToken) return;
				debug(`qwen id=${id} error ${message.slice(0, 120)}`);
				settled = true;
				this.qwen = void 0;
				if (this.armed?.id === id) this.armed = void 0;
				fail(new Error(message));
				if (player) player.stop();
				else finish(false);
			}
		});
		this.qwen = job;
		if (settled) {
			job.cancel();
			this.qwen = void 0;
		}
	}
	cancelQwen() {
		const job = this.qwen;
		this.qwen = void 0;
		job?.cancel();
	}
	stopSpeak() {
		debug(`stop-speak armed=${this.armed?.id ?? "none"} player=${this.player !== void 0}`);
		this.speakToken += 1;
		this.cancelQwen();
		const armed = this.armed;
		this.armed = void 0;
		const player = this.player;
		this.player = void 0;
		this.ring.clear();
		if (player) player.stop();
		else if (armed) emit({
			type: "playback",
			id: armed.id,
			phase: "end",
			stopped: true
		});
	}
	/** Keep the input device only while the host asked for it and a listening column can run. */
	micWanted() {
		if (!this.hostDevice) return false;
		const settings = this.settings;
		const paths = this.paths;
		if (!settings || !paths) return false;
		const kws = paths.kws ? kwsFiles(paths.kws, settings.wakeChunk) : void 0;
		const wakeModel = kws !== void 0 && existsSync(kws.tokens);
		const asrModel = Boolean(paths.asrModel && paths.asrTokens && paths.asrVad && existsSync(paths.asrModel) && existsSync(paths.asrTokens) && existsSync(paths.asrVad));
		return needsMicrophone({
			wakeEnabled: settings.wakeEnabled,
			wakeWords: settings.wakeWords,
			wakeModel,
			commandEnabled: settings.commandEnabled,
			asrModel
		});
	}
	syncMic() {
		if (!this.micWanted()) {
			this.stopMic();
			return;
		}
		const kind = this.wantsNative() ? "native" : "cpal";
		if (this.capture !== void 0 && this.captureKind === kind) return;
		this.switchMic(kind);
	}
	/**
	* Native VPIO only while transcription is on. `command` is only reachable while the panel
	* is pinned, and `interject` only while a running turn or a held closing line keeps it
	* open; `wake` is the collapsed state. VPIO ducks the whole system output, so keeping it
	* off in `wake` is what leaves the user's music and games alone.
	*/
	wantsNative() {
		return wantsNativeCapture(this.mode, this.useCpal, captureBinary() !== void 0);
	}
	/**
	* Swap the capture source without clearing the ring: the 300 ms before a wake→command
	* switch seeds the first phrase after the native unit starts.
	*/
	switchMic(kind) {
		if (this.relaunchTimer) clearTimeout(this.relaunchTimer);
		this.relaunchTimer = void 0;
		const capture = this.capture;
		this.capture = void 0;
		this.captureKind = void 0;
		try {
			capture?.close();
		} catch (error) {
			fail(error);
		}
		if (this.micWanted()) this.startMic(kind);
	}
	stopMic() {
		if (this.relaunchTimer) clearTimeout(this.relaunchTimer);
		this.relaunchTimer = void 0;
		const capture = this.capture;
		this.capture = void 0;
		this.captureKind = void 0;
		this.ring.clear();
		try {
			capture?.close();
		} catch (error) {
			fail(error);
		}
	}
	startMic(kind = "cpal") {
		if (this.capture) return;
		if (kind === "native" && !this.useCpal) {
			const binary = captureBinary();
			if (binary !== void 0) {
				this.openNative(binary);
				return;
			}
			this.useCpal = true;
			debug("capture helper missing; node-cpal has no echo cancellation");
		}
		this.openCpal();
	}
	openNative(binary) {
		const source = new NativeCapture(binary);
		this.capture = source;
		this.captureKind = "native";
		source.start({
			onPcm: (samples) => this.onAudio(samples),
			onReady: ({ aec }) => {
				this.nativeReady = true;
				debug(`mic open source=native aec=${aec}`);
				emit({
					type: "mic",
					open: true,
					aec
				});
			},
			onFailure: (reason, detail) => this.onCaptureFailure(reason, detail)
		});
	}
	openCpal() {
		const source = new CpalCapture(this.native);
		this.capture = source;
		this.captureKind = "cpal";
		source.start({
			onPcm: (samples) => this.onAudio(samples),
			onReady: ({ aec }) => {
				debug(`mic open source=cpal aec=${aec}`);
				emit({
					type: "mic",
					open: true,
					aec
				});
			},
			onFailure: (reason, detail) => this.onCaptureFailure(reason, detail)
		});
	}
	onCaptureFailure(reason, detail) {
		const capture = this.capture;
		const kind = this.captureKind;
		this.capture = void 0;
		this.captureKind = void 0;
		try {
			capture?.close();
		} catch {}
		if (reason === "mic-denied" || kind !== "native") {
			emit({
				type: "mic",
				open: false
			});
			return;
		}
		const now = Date.now();
		this.captureFailures = this.captureFailures.filter((at) => now - at < 6e4);
		this.captureFailures.push(now);
		if (!this.nativeReady || this.captureFailures.length >= 3) {
			this.useCpal = true;
			this.nativeReady = false;
			fail(/* @__PURE__ */ new Error(`capture fallback: ${reason} ${detail}`));
			if (this.micWanted()) this.startMic("cpal");
			return;
		}
		this.relaunchTimer = setTimeout(() => {
			this.relaunchTimer = void 0;
			if (this.micWanted()) this.startMic(this.wantsNative() ? "native" : "cpal");
		}, 1e3);
	}
	close() {
		this.stopSpeak();
		this.stopMic();
		this.stopAsr();
		this.ttsWorker?.terminate();
	}
	ensureHost() {
		this.audioHost ??= this.native.cpal.defaultHost();
		return this.audioHost;
	}
	ensureTts() {
		if (this.ttsWorker) return this.ttsWorker;
		const root = this.paths?.tts;
		if (!root) return void 0;
		const beside = new URL("./tts-worker.js", import.meta.url);
		const source = new URL("./tts-worker.ts", import.meta.url);
		const url = existsSync(fileURLToPath(beside)) ? beside : source;
		let worker;
		try {
			worker = new Worker(url, { workerData: { tts: root } });
		} catch (error) {
			fail(error);
			return;
		}
		worker.on("message", (message) => {
			if (typeof message.id !== "number") return;
			const done = this.ttsWait.get(message.id);
			this.ttsWait.delete(message.id);
			done?.(message);
		});
		worker.on("error", (error) => {
			fail(error);
			for (const done of this.ttsWait.values()) done({ error: error.message });
			this.ttsWait.clear();
			this.ttsWorker = void 0;
		});
		this.ttsWorker = worker;
		return worker;
	}
	/** 16 kHz mono PCM from the capture source. */
	onAudio(samples) {
		this.ring.push(samples);
		if (this.mode === "wake") {
			this.feedKeywords(samples);
			return;
		}
		if (!transcribing(this.mode)) return;
		const level = this.meter.push(samples, Date.now());
		if (level !== void 0) emit({
			type: "level",
			value: level
		});
		this.vad?.push(samples);
		this.feedKeywords(samples);
	}
	feedKeywords(samples) {
		const spotter = this.kws;
		const stream = this.kwsStream;
		if (!spotter || !stream) return;
		stream.acceptWaveform({
			sampleRate: TARGET_RATE,
			samples
		});
		while (spotter.isReady(stream)) {
			spotter.decode(stream);
			const result = spotter.getResult(stream);
			if (!result?.keyword) continue;
			spotter.reset(stream);
			const label = String(result.keyword);
			const now = Date.now();
			if (this.mode === "wake") {
				if (label === INTERJECT_LABEL) continue;
				const cooldown = this.settings?.wakeCooldownMs ?? 1500;
				if (now - this.lastWake < cooldown) continue;
				this.lastWake = now;
				emit({ type: "wake" });
				continue;
			}
			if (label !== INTERJECT_LABEL) continue;
			if (this.vad?.speaking !== true) continue;
			if (!this.armedKeyword) debug(`kws armed label=${label} mode=${this.mode}`);
			this.armedKeyword = true;
		}
	}
	ensureKws() {
		const settings = this.settings;
		const dir = this.paths?.kws;
		const keyword = settings?.interjectKeyword?.trim() ?? "";
		const wantsWake = settings?.wakeEnabled === true;
		const wantsInterject = settings?.commandEnabled === true && keyword !== "";
		if (!wantsWake && !wantsInterject || !dir) {
			this.clearKws();
			return;
		}
		const files = kwsFiles(dir, settings.wakeChunk);
		if (!files || !existsSync(files.tokens)) {
			this.clearKws();
			return;
		}
		let lines = [];
		try {
			const ctx = contextFromFiles(dir);
			lines = wantsWake ? keywordLines(settings.wakeWords, ctx) : [];
			if (wantsInterject) try {
				lines.push(tokenizeKeyword(keyword, ctx, INTERJECT_LABEL));
			} catch {}
		} catch (error) {
			fail(error);
			this.clearKws();
			return;
		}
		if (lines.length === 0) {
			this.clearKws();
			return;
		}
		const key = `${settings.wakeChunk}:${settings.wakeThreshold}:${settings.wakeScore}:${lines.join("|")}`;
		if (key === this.kwsKey && this.kws) return;
		const keywordsFile = join(tmpdir(), `dsh-orb-kws-${process.pid}.txt`);
		writeFileSync(keywordsFile, `${lines.join("\n")}\n`);
		try {
			const spotter = new this.native.sherpa.KeywordSpotter({
				featConfig: {
					sampleRate: TARGET_RATE,
					featureDim: 80
				},
				modelConfig: {
					transducer: {
						encoder: files.encoder,
						decoder: files.decoder,
						joiner: files.joiner
					},
					tokens: files.tokens,
					numThreads: 2,
					provider: "cpu",
					debug: 0
				},
				keywordsFile,
				keywordsScore: settings.wakeScore,
				keywordsThreshold: settings.wakeThreshold
			});
			this.kws = spotter;
			this.kwsStream = spotter.createStream();
			this.kwsKey = key;
		} catch (error) {
			fail(error);
			this.clearKws();
		}
	}
	clearKws() {
		this.kws = void 0;
		this.kwsStream = void 0;
		this.kwsKey = "";
	}
	ensureAsr() {
		const model = this.paths?.asrModel;
		const tokens = this.paths?.asrTokens;
		const vadModel = this.paths?.asrVad;
		if (!Boolean(this.settings?.commandEnabled && model && tokens && vadModel && existsSync(model) && existsSync(tokens) && existsSync(vadModel))) {
			this.stopAsr();
			return;
		}
		if (!this.vad) try {
			const detector = new this.native.sherpa.Vad({
				sileroVad: {
					model: vadModel,
					threshold: .5,
					minSilenceDuration: .5,
					minSpeechDuration: .25,
					maxSpeechDuration: 30,
					windowSize: 512
				},
				sampleRate: TARGET_RATE,
				numThreads: 1,
				provider: "cpu",
				debug: 0
			}, 31.5);
			this.vad = new VadEar(detector, .3, .5, (open) => {
				if (open) this.segmentMode = this.mode;
				debug(`vad open=${open} mode=${this.mode} segment=${this.segmentMode}`);
				emit({
					type: "speech",
					open
				});
			}, (samples) => this.enqueue(samples));
		} catch (error) {
			fail(error);
		}
		if (this.worker) return;
		let worker;
		try {
			worker = new Worker(new URL("./decode-worker.mjs", import.meta.url), { workerData: {
				model,
				tokens
			} });
		} catch (error) {
			fail(error);
			return;
		}
		worker.on("message", (message) => {
			if (this.worker !== worker) return;
			if (message.ready) {
				this.workerReady = true;
				this.pump();
				return;
			}
			this.decoding = false;
			const meta = typeof message.id === "number" ? this.pending.get(message.id) : void 0;
			if (typeof message.id === "number") this.pending.delete(message.id);
			if (message.error) fail(message.error);
			else if (message.text) {
				if (meta !== void 0 && meta.keyword !== true && isEcho(message.text, this.spoken, {
					from: meta.from,
					to: meta.to
				}, [this.settings?.interjectKeyword ?? "", ...this.settings?.dismissPhrases ?? []])) {
					debug(`asr echo-dropped mode=${meta?.mode} text=${message.text.slice(0, 60)}`);
					process.stderr.write("echo dropped\n");
				} else {
					debug(`asr text mode=${meta?.mode} keyword=${meta?.keyword === true} text=${message.text.slice(0, 80)}`);
					emit({
						type: "utterance",
						text: message.text,
						...meta ? { mode: meta.mode } : {},
						...meta?.keyword === true ? { keyword: true } : {}
					});
				}
			}
			emit({
				type: "speech",
				open: false
			});
			this.pump();
		});
		worker.on("error", (error) => {
			if (this.worker === worker) fail(error);
		});
		this.worker = worker;
	}
	/** Drop the recognizer and its queued segments; a later enable rebuilds them. */
	stopAsr() {
		const worker = this.worker;
		this.worker = void 0;
		this.workerReady = false;
		this.vad = void 0;
		this.jobs = [];
		this.decoding = false;
		this.pending.clear();
		if (worker) worker.terminate();
	}
	enqueue(samples) {
		const copy = new Float32Array(samples);
		const mode = transcribing(this.segmentMode) ? this.segmentMode : this.mode;
		const keyword = this.armedKeyword;
		this.armedKeyword = false;
		debug(`segment mode=${mode} samples=${copy.length} keyword=${keyword}`);
		this.jobs.push({
			samples: copy,
			mode,
			from: Date.now() - samples.length / 16 - 500,
			to: Date.now(),
			keyword
		});
		this.pump();
	}
	pump() {
		if (!this.workerReady || this.decoding || this.jobs.length === 0 || !this.worker) return;
		const job = this.jobs.shift();
		if (!job) return;
		this.decoding = true;
		const id = ++this.jobId;
		this.pending.set(id, {
			mode: job.mode,
			from: job.from,
			to: job.to,
			keyword: job.keyword
		});
		const bytes = new ArrayBuffer(job.samples.byteLength);
		new Uint8Array(bytes).set(new Uint8Array(job.samples.buffer, job.samples.byteOffset, job.samples.byteLength));
		this.worker.postMessage({
			id,
			samples: bytes
		}, [bytes]);
	}
	noteSpoken(line) {
		const cutoff = Date.now() - 3e4;
		this.spoken = this.spoken.filter((item) => item.endedAt === void 0 || item.endedAt >= cutoff);
		this.spoken.push(line);
	}
};
function kwsFiles(dir, chunk) {
	const tag = `chunk-${chunk}`;
	const files = {
		encoder: join(dir, `encoder-epoch-13-avg-2-${tag}-left-64.int8.onnx`),
		decoder: join(dir, `decoder-epoch-13-avg-2-${tag}-left-64.onnx`),
		joiner: join(dir, `joiner-epoch-13-avg-2-${tag}-left-64.int8.onnx`),
		tokens: join(dir, "tokens.txt")
	};
	if (!existsSync(files.encoder) || !existsSync(files.decoder) || !existsSync(files.joiner)) return void 0;
	return files;
}
/**
* The speaker end of a cloud sentence. Chunks arrive while the stream is already
* running; the callback pulls across them and writes silence when the network is
* behind playback. One call to `onEnded`, exactly like {@link playPcm}.
*/
function createStreamPlayer(cpal, host, sampleRate, volume, onEnded) {
	const chunks = [];
	let head = 0;
	let headOffset = 0;
	let ended = false;
	let finished = false;
	let rate = sampleRate;
	let stream;
	const finish = (stopped, defer = false) => {
		if (finished) return;
		finished = true;
		const close = () => {
			try {
				stream?.close();
			} catch {}
			onEnded(stopped);
		};
		if (defer) setImmediate(close);
		else close();
	};
	const device = host.defaultOutputDevice();
	if (!device) {
		finished = true;
		setImmediate(() => onEnded(false));
		return {
			push() {},
			end() {},
			stop() {}
		};
	}
	const pull = () => {
		while (head < chunks.length) {
			const chunk = chunks[head];
			if (chunk === void 0) {
				head += 1;
				headOffset = 0;
				continue;
			}
			if (headOffset < chunk.length) {
				const value = chunk[headOffset] ?? 0;
				headOffset += 1;
				if (headOffset >= chunk.length) {
					head += 1;
					headOffset = 0;
				}
				return scaledSample(value, volume);
			}
			head += 1;
			headOffset = 0;
		}
	};
	try {
		const chosen = pickOutput(cpal, device, sampleRate);
		rate = chosen.rate;
		const config = chosen.config;
		const output = device.buildOutputStream(config, cpal.SampleFormat.F32, (data) => {
			const channels = config.channels;
			const frames = Math.floor(data.length / channels);
			for (let frame = 0; frame < frames; frame += 1) {
				const sample = pull();
				for (let channel = 0; channel < channels; channel += 1) data[frame * channels + channel] = sample ?? 0;
			}
			if (ended && head >= chunks.length) finish(false, true);
		}, (error) => {
			if (isRecoverableSpeakerError(error)) return;
			fail(error);
			finish(true, true);
		});
		stream = output;
		output.play();
	} catch (error) {
		fail(error);
		finish(true);
	}
	return {
		push(samples) {
			if (finished || samples.length === 0) return;
			chunks.push(rate === sampleRate ? samples : resampleLinear(samples, sampleRate, rate));
		},
		end() {
			if (finished) return;
			ended = true;
			if (head >= chunks.length) finish(false);
		},
		stop() {
			finish(true);
		}
	};
}
function playPcm(cpal, host, samples, sampleRate, volume, onEnded) {
	const device = host.defaultOutputDevice();
	if (!device) {
		onEnded(false);
		return { stop() {} };
	}
	const chosen = pickOutput(cpal, device, sampleRate);
	const config = chosen.config;
	const pcm = chosen.rate === sampleRate ? samples : resampleLinear(samples, sampleRate, chosen.rate);
	let cursor = 0;
	let ended = false;
	let stream;
	const finish = (stopped) => {
		if (ended) return;
		ended = true;
		try {
			stream.close();
		} catch {}
		onEnded(stopped);
	};
	stream = device.buildOutputStream(config, cpal.SampleFormat.F32, (data) => {
		const channels = config.channels;
		const frames = Math.floor(data.length / channels);
		for (let frame = 0; frame < frames; frame += 1) {
			const sample = scaledSample(cursor < pcm.length ? pcm[cursor] ?? 0 : 0, volume);
			for (let channel = 0; channel < channels; channel += 1) data[frame * channels + channel] = sample;
			cursor += 1;
		}
		if (cursor >= pcm.length) setImmediate(() => finish(false));
	}, (error) => {
		fail(error);
		finish(true);
	});
	stream.play();
	return { stop() {
		finish(true);
	} };
}
function pickOutput(cpal, device, sampleRate) {
	const f32 = [...device.supportedOutputConfigs()].filter((range) => range.sampleFormat() === cpal.SampleFormat.F32);
	const exact = f32.find((range) => range.channels() === 1 && range.containsRate(sampleRate)) ?? f32.find((range) => range.containsRate(sampleRate));
	if (exact) {
		const supported = exact.tryWithSampleRate?.(sampleRate) ?? exact;
		const config = typeof supported.config === "function" ? supported.config() : new cpal.StreamConfig({
			channels: exact.channels(),
			sampleRate,
			bufferSize: cpal.BufferSize.Default
		});
		return {
			config,
			rate: config.sampleRate ?? sampleRate
		};
	}
	const fallback = device.defaultOutputConfig();
	return {
		config: fallback.config(),
		rate: fallback.config().sampleRate
	};
}
function resampleLinear(samples, from, to) {
	if (from === to || samples.length === 0) return samples;
	const length = Math.max(1, Math.round(samples.length * to / from));
	const out = new Float32Array(length);
	for (let i = 0; i < length; i += 1) {
		const position = i * from / to;
		const left = Math.floor(position);
		const right = Math.min(left + 1, samples.length - 1);
		const mix = position - left;
		out[i] = (samples[left] ?? 0) + ((samples[right] ?? 0) - (samples[left] ?? 0)) * mix;
	}
	return out;
}
function main() {
	const native = loadNative();
	const engine = native ? new Engine(native) : void 0;
	if (!engine) emit({
		type: "mic",
		open: false
	});
	const lines = createInterface({ input: process.stdin });
	lines.on("line", (line) => {
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		try {
			if (message.type === "configure") {
				engine?.configure(message);
				return;
			}
			if (message.type === "listen" && (message.mode === "off" || message.mode === "wake" || message.mode === "command" || message.mode === "interject")) {
				engine?.listen(message.mode, message.seedMs ?? 0, message.device !== false);
				return;
			}
			if (message.type === "speak" && typeof message.id === "string") {
				const spoken = typeof message.text === "string" ? message.text : "";
				debug(`stdin speak id=${message.id} chars=${spoken.length}`);
				if (engine) engine.speak(message.id, spoken);
				else {
					emit({
						type: "playback",
						id: message.id,
						phase: "start"
					});
					emit({
						type: "playback",
						id: message.id,
						phase: "end"
					});
				}
				return;
			}
			if (message.type === "stop-speak") engine?.stopSpeak();
		} catch (error) {
			fail(error);
			if (message.type === "speak" && typeof message.id === "string") emit({
				type: "playback",
				id: message.id,
				phase: "end"
			});
		}
	});
	lines.on("close", () => {
		try {
			engine?.close();
		} catch {}
		process.exit(0);
	});
	for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
		process.exit(0);
	});
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
//#endregion
export {};
