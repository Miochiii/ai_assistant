//#region src/speak-text.ts
/**
* An ASCII `.` `!` `?` ends a sentence only at a real boundary.
* Testing `/^\s|$/` against the single next character is not that check:
* `$` matches the end of every string, so `voice.mjs` would split.
*/
function asciiSentenceBoundary(buffer, index) {
	const next = buffer[index + 1];
	const atBoundary = next === void 0 || /\s/.test(next);
	const previous = buffer[index - 1] ?? "";
	return atBoundary && !/[0-9]/.test(previous);
}
const ZH_MAP = [
	[/；/g, "，"],
	[/;/g, "，"],
	[/[（(]/g, "，"],
	[/[）)]/g, "，"],
	[/[《》【】“”‘’]/g, ""],
	[/…+/g, "，"],
	[/—+|\s*[-－]{1,2}\s*/g, "，"],
	[/·/g, "，"],
	[/(\d+(?:\.\d+)?)\s*[％%]/g, "百分之$1"],
	[/\s*→\s*/g, "，变成，"],
	[/[←↑↓]/g, "，"],
	[/×/g, "乘"],
	[/÷/g, "除以"],
	[/≈/g, "大约"],
	[/[＋+]/g, "，加，"],
	[/[＝=]/g, "，等于，"],
	[/[~～]/g, "，"],
	[/@/g, "，艾特，"],
	[/[#＃]/g, "，井号，"],
	[/&/g, "，和，"],
	[/[\\/*|<>[\]{}^`$€¥°•]/g, "，"],
	[/!/g, "！"],
	[/\t/g, " "],
	[/\n{1,}/g, "。"],
	[/[,]/g, "，"]
];
/** Drop Markdown the engines would read as symbols. A code block becomes one short phrase. */
function stripMarkdown(markdown) {
	let text = String(markdown);
	text = text.replace(/```[\s\S]*?```/g, "，省略一段代码，");
	text = text.replace(/`([^`]*)`/g, "$1");
	text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
	text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, (_match, label) => label.trim() ? label : "链接");
	text = text.replace(/^\s{0,3}#{1,6}\s+/gm, "");
	text = text.replace(/^\s{0,3}>\s?/gm, "");
	text = text.replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, "");
	text = text.replace(/^\s*[-*+]\s+/gm, "，");
	text = text.replace(/^\s*(\d{1,2})[.)]\s+/gm, "第$1，");
	text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
	text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2");
	text = text.replace(/\s*\|\s*/g, "，");
	text = text.replace(/<[^>]{1,60}>/g, "");
	return text;
}
function normalizeZh(text) {
	let next = text.replace(/(\d)\s*[~～]\s*(\d)/g, "$1 到 $2");
	for (const [pattern, replacement] of ZH_MAP) next = next.replace(pattern, replacement);
	next = next.replace(/[，]{2,}/g, "，");
	next = next.replace(/[，]\s*([。！？])/g, "$1");
	next = next.replace(/([。！？])[，]+/g, "$1");
	next = next.replace(/(^|[\n。！？])\s*[，]\s*/g, "$1");
	return next.replace(/^[，\s]+/, "").replace(/\s+$/, "");
}
function normalizeEn(text) {
	const marks = {
		"，": ", ",
		"。": ". ",
		"！": "! ",
		"？": "? ",
		"：": ": ",
		"、": ", "
	};
	return text.replace(/[，。！？：、]/g, (mark) => marks[mark] ?? mark).replace(/\s{2,}/g, " ").trim();
}
/** Chinese and Latin run on different engines. Digits stay with the run they follow. */
function segmentLanguages(text) {
	const pieces = [];
	let current;
	const push = (lang, char) => {
		if (current?.lang === lang) current.buf += char;
		else pieces.push(current = {
			lang,
			buf: char
		});
	};
	for (const char of text) if (/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/.test(char)) push("zh", char);
	else if (/[A-Za-z]/.test(char)) push("en", char);
	else if (current) current.buf += char;
	else pieces.push(current = {
		lang: "zh",
		buf: char
	});
	const merged = [];
	for (const piece of pieces) {
		if (!piece.buf.trim()) continue;
		const last = merged.at(-1);
		if (last?.lang === piece.lang) merged[merged.length - 1] = {
			lang: last.lang,
			text: last.text + piece.buf
		};
		else merged.push({
			lang: piece.lang,
			text: piece.buf
		});
	}
	return merged.filter((piece) => /[^\s]/.test(piece.text));
}
/** Markdown in, language runs out, each run normalized for its engine. */
function prepare(markdown) {
	return segmentLanguages(stripMarkdown(markdown)).map((piece) => ({
		lang: piece.lang,
		text: piece.lang === "zh" ? normalizeZh(piece.text) : normalizeEn(piece.text)
	})).filter((piece) => piece.text.trim() !== "");
}
/** Short sentences. An ASCII period only splits on a real boundary, same as {@link takeReadyPrefix}. */
function splitSentences(text, lang, maxLen = 46) {
	const parts = [];
	const chars = [...text];
	let buffer = "";
	for (let i = 0; i < chars.length; i += 1) {
		const char = chars[i] ?? "";
		buffer += char;
		const chineseEnd = "。！？".includes(char);
		const englishEnd = lang === "en" && ".!?".includes(char) && asciiSentenceBoundary(text, i);
		if (chineseEnd || englishEnd) {
			parts.push(buffer);
			buffer = "";
		}
	}
	if (buffer.trim()) parts.push(buffer);
	const out = [];
	for (const part of parts) {
		if (part.trim().length <= maxLen) {
			out.push(part.trim());
			continue;
		}
		let current = "";
		for (const char of part) {
			current += char;
			if ("，、：,;".includes(char) && current.length >= maxLen * .6) {
				out.push(current.trim());
				current = "";
			}
		}
		if (current.trim()) out.push(current.trim());
	}
	return out.filter(Boolean);
}
/** Pause after a sentence, shortened as the model speed rises. */
function gapFor(text, speed) {
	const trimmed = text.trim();
	const base = /[。！？.!?]["')\]]*$/.test(trimmed) ? 150 : /[，、：,:;]["')\]]*$/.test(trimmed) ? 80 : 110;
	return Math.round(base / Math.max(speed, .1));
}
const SPEED_CURVES = {
	zh: [
		[1, 1],
		[1.2, 1.2],
		[1.5, 1.43],
		[1.8, 1.73],
		[2, 1.78],
		[2.5, 2.23],
		[3, 2.68]
	],
	en: [
		[1, .99],
		[1.2, 1.22],
		[1.5, 1.52],
		[1.8, 1.83],
		[2, 2.04],
		[2.5, 2.54],
		[3, 3.03]
	]
};
/** Measured model speed → how fast the audio actually is. */
function actualSpeed(kind, param) {
	const curve = SPEED_CURVES[kind];
	const first = curve[0];
	if (!first || param <= first[0]) return first?.[1] ?? param;
	for (let i = 1; i < curve.length; i += 1) {
		const right = curve[i];
		const left = curve[i - 1];
		if (!right || !left || param > right[0]) continue;
		const span = right[0] - left[0];
		return left[1] + (param - left[0]) * (right[1] - left[1]) / span;
	}
	const last = curve[curve.length - 1];
	if (!last) return param;
	return last[1] / last[0] * param;
}
/**
* Split a target speed into model speeds and one SOLA ratio.
* Chinese stays at or below 1.5. English is slowed by the same SOLA ratio
* so both languages land on the target.
*/
function planSpeeds(target) {
	const clamped = Math.min(3, Math.max(1, target));
	const modelZh = Math.min(clamped, 1.5);
	const solaRatio = clamped / actualSpeed("zh", modelZh);
	return {
		target: clamped,
		modelZh,
		modelEn: Math.min(3, Math.max(.8, Math.round(clamped / solaRatio * 100) / 100)),
		solaRatio
	};
}
/** Time-compress without changing pitch. Frames are dropped, not phonemes. */
function sola(samples, rate, ratio) {
	if (!(ratio > 1.001) || samples.length === 0) return samples;
	const frame = Math.max(64, Math.round(40 / 1e3 * rate));
	const hopOut = Math.max(32, Math.round(frame / 2));
	const hopIn = Math.max(1, Math.round(hopOut * ratio));
	const search = Math.max(0, Math.round(12 / 1e3 * rate));
	const window = new Float32Array(frame);
	for (let i = 0; i < frame; i += 1) window[i] = .5 - .5 * Math.cos(2 * Math.PI * i / frame);
	const outLen = Math.ceil(samples.length / hopIn * hopOut) + frame;
	const out = new Float32Array(outLen);
	const weight = new Float32Array(outLen);
	let previous = -1;
	let outPos = 0;
	for (let pos = 0; pos + frame <= samples.length; pos += hopIn) {
		let best = 0;
		if (previous >= 0 && search > 0) {
			const tail = previous + hopOut;
			let bestScore = -Infinity;
			for (let delta = -search; delta <= search; delta += 2) {
				const start = pos + delta;
				if (start < 0 || tail + hopOut > samples.length || start + hopOut > samples.length) continue;
				let score = 0;
				for (let i = 0; i < hopOut; i += 2) score += (samples[tail + i] ?? 0) * (samples[start + i] ?? 0);
				if (score > bestScore) {
					bestScore = score;
					best = delta;
				}
			}
		}
		const start = Math.max(0, Math.min(samples.length - frame, pos + best));
		for (let i = 0; i < frame; i += 1) {
			out[outPos + i] = (out[outPos + i] ?? 0) + (samples[start + i] ?? 0) * (window[i] ?? 0);
			weight[outPos + i] = (weight[outPos + i] ?? 0) + (window[i] ?? 0);
		}
		previous = start;
		outPos += hopOut;
	}
	for (let i = 0; i < outLen; i += 1) {
		const scale = weight[i] ?? 0;
		if (scale > .35) out[i] = (out[i] ?? 0) / scale;
	}
	return out.slice(0, Math.min(outLen, outPos + Math.round(frame / 2)));
}
function trimSilence(samples, rate) {
	let start = 0;
	let end = samples.length - 1;
	while (start < samples.length && Math.abs(samples[start] ?? 0) < .006) start += 1;
	while (end > start && Math.abs(samples[end] ?? 0) < .006) end -= 1;
	if (end <= start) return /* @__PURE__ */ new Float32Array(0);
	const keep = Math.round(15 / 1e3 * rate);
	return samples.slice(Math.max(0, start - keep), Math.min(samples.length, end + keep + 1));
}
/**
* The same assembly, one awaited sentence at a time.
* Electron-as-Node cannot take sherpa's synchronous `generate()` result: the native
* addon hands back an external ArrayBuffer, which Electron rejects. The async path
* delivers PCM through `onProgress`, and this is what the child uses in production.
*/
async function renderSpeechAsync(text, speed, synth) {
	const plan = planSpeeds(speed);
	const parts = [];
	let rate = 22050;
	let pendingGap = 0;
	for (const piece of prepare(text)) {
		const modelSpeed = piece.lang === "en" ? plan.modelEn : plan.modelZh;
		for (const sentence of splitSentences(piece.text, piece.lang)) {
			const rendered = await synth(sentence, piece.lang, modelSpeed);
			if (rendered.samples.length === 0) {
				pendingGap = Math.max(pendingGap, gapFor(sentence, modelSpeed));
				continue;
			}
			rate = rendered.sampleRate;
			if (pendingGap) parts.push(silence(pendingGap, rate));
			parts.push(trimSilence(rendered.samples, rendered.sampleRate));
			pendingGap = gapFor(sentence, modelSpeed);
		}
	}
	let samples = concatAudio(parts);
	if (plan.solaRatio > 1.02 && samples.length > 0) samples = sola(samples, rate, plan.solaRatio);
	return {
		samples,
		sampleRate: rate
	};
}
function silence(ms, rate) {
	return new Float32Array(Math.max(0, Math.round(ms / 1e3 * rate)));
}
function concatAudio(parts) {
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
//#endregion
export { stripMarkdown as n, renderSpeechAsync as t };
