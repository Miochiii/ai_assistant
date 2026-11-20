import { installOrbMemoryCutover } from "./memory-extension/orb-host-adapter.js";
import { installOrbTaskMemory } from "../../../plugins/dsh-orb-memory/task-host.js";
import { installOrbCompanion } from "../../../plugins/dsh-assistant-host/orb-companion.js";
import { createRequire } from "node:module";
import { fork, spawn } from "node:child_process";
import { appendFileSync, cpSync, createReadStream, createWriteStream, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { access, chmod, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { accessibilityTrusted, promptAccessibility, selectionRuntimeAvailable, startSelectionMonitor } from "../native-selection/src/index.js";
import { createServer } from "node:net";
import { finished, pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
//#region src/native-images.ts
/**
* Native images (`.node`, `.dll`, `.exe`) and the in-app update on Windows.
*
* Under the desktop's Electron runtime (Node 24.18), deleting a link to a file
* some process has mapped as a loaded image fails, and so does removing the
* directory that holds it. The desktop runs pnpm on that runtime. pnpm replaces
* an installed package by staging the new copy beside it (hard links into the
* same store files) and deleting the old directory; while any process has
* koffi's addon loaded from inside the package, both deletions fail with
* `EPERM, Permission denied: \\?\…\dsh-orb_tmp_<pid>_<thread>\node_modules`
* and the live package is left with files missing.
*
* So the host loads koffi from a copy outside the package (real files, new
* inodes, one folder per koffi version), names it in {@link KOFFI_DIR_ENV} for
* every loader in the bundle, and probes the package before an update asks pnpm
* to replace it.
*/
/** The folder whose `node_modules` holds the koffi copy every loader in the bundle uses. */
const KOFFI_DIR_ENV = "DSH_ORB_KOFFI_DIR";
/** Written last into a copy, so a folder without it is a copy that never finished. */
const READY_MARKER = ".ready";
/** Leftover staging folders younger than this may belong to an install still running. */
const STALE_STAGE_MS = 6e5;
const IMAGE_EXTENSIONS = /* @__PURE__ */ new Set([
	".node",
	".dll",
	".exe"
]);
/**
* Load koffi from the copy named in {@link KOFFI_DIR_ENV}, or beside `from` when there is none.
* @param from - module URL the in-package fallback resolves from.
*/
function requireKoffi(from = import.meta.url) {
	const dir = process.env[KOFFI_DIR_ENV];
	if (dir !== void 0 && dir !== "") try {
		return createRequire(join(dir, "index.js"))("koffi");
	} catch (error) {
		console.error(`dsh-orb: koffi copy unusable, loading the packaged one: ${error instanceof Error ? error.message : String(error)}`);
	}
	return createRequire(from)("koffi");
}
/**
* The installed package's root folder: `dist/host/index.js` sits two levels below it.
* In the workspace this is `packages/`, which holds no `package.json`.
*/
function ownPackageRoot(url = import.meta.url) {
	return fileURLToPath(new URL("../../", url)).replace(/[\\/]+$/, "");
}
/**
* Copy the package's koffi (and its platform prebuilds) to `cacheRoot/koffi-<version>`.
* A finished copy is reused; a copy is only ever added, never rewritten, because an
* older one may itself be mapped by a process that has not exited yet.
* @returns the folder to name in {@link KOFFI_DIR_ENV}, or undefined when the package ships no koffi.
*/
function stageKoffi(packageRoot, cacheRoot) {
	const modules = join(packageRoot, "node_modules");
	const manifest = join(modules, "koffi", "package.json");
	if (!existsSync(manifest)) return void 0;
	const version = JSON.parse(readFileSync(manifest, "utf8")).version;
	if (typeof version !== "string" || !/^[\w.+-]+$/.test(version)) return void 0;
	const target = join(cacheRoot, `koffi-${version}`);
	if (existsSync(join(target, READY_MARKER))) return target;
	const partial = `${target}.partial-${process.pid}`;
	rmSync(partial, {
		recursive: true,
		force: true
	});
	for (const entry of ["koffi", "@koromix"]) {
		const from = join(modules, entry);
		if (existsSync(from)) cpSync(from, join(partial, "node_modules", entry), {
			recursive: true,
			dereference: true
		});
	}
	writeFileSync(join(partial, READY_MARKER), "");
	try {
		renameSync(partial, target);
	} catch (error) {
		rmSync(partial, {
			recursive: true,
			force: true
		});
		if (!existsSync(join(target, READY_MARKER))) throw error;
	}
	return target;
}
/**
* Native images inside the package that some process holds mapped, which would make
* pnpm's replace fail and leave the package half deleted. Each image is hard-linked into
* a scratch folder beside the package; a folder whose removal fails holds a mapped one.
* A scratch folder that cannot be removed is named like pnpm's own staging folders, so
* {@link removeStaleStages} clears it once the mapping process is gone.
* @returns the mapped images, relative to the package root; empty when nothing blocks a replace.
*/
function mappedImages(packageRoot) {
	const images = nativeImages(packageRoot);
	if (images.length === 0) return [];
	const scratch = join(dirname(packageRoot), `${basename(packageRoot)}_tmp_probe_${process.pid}`);
	const mapped = [];
	for (const [index, image] of images.entries()) {
		const dir = join(scratch, String(index));
		try {
			mkdirSync(dir, { recursive: true });
			linkSync(join(packageRoot, image), join(dir, "image"));
		} catch {
			rmSync(dir, {
				recursive: true,
				force: true
			});
			continue;
		}
		try {
			rmSync(dir, {
				recursive: true,
				force: true
			});
		} catch (error) {
			const code = error.code;
			if (code === "EPERM" || code === "EACCES" || code === "EBUSY") mapped.push(image);
		}
	}
	try {
		rmSync(scratch, {
			recursive: true,
			force: true
		});
	} catch {}
	return mapped;
}
/** Every `.node`, `.dll`, and `.exe` file in the package tree, relative to its root. */
function nativeImages(packageRoot) {
	const found = [];
	const walk = (relative) => {
		let entries;
		try {
			entries = readdirSync(join(packageRoot, relative));
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = relative === "" ? entry : join(relative, entry);
			let stat;
			try {
				stat = lstatSync(join(packageRoot, path));
			} catch {
				continue;
			}
			if (stat.isSymbolicLink()) continue;
			if (stat.isDirectory()) walk(path);
			else if (IMAGE_EXTENSIONS.has(extension(entry))) found.push(path);
		}
	};
	walk("");
	return found;
}
function extension(name) {
	const dot = name.lastIndexOf(".");
	return dot === -1 ? "" : name.slice(dot).toLowerCase();
}
/**
* Remove the `<name>_tmp_*` folders failed replaces left beside the package. They hold
* hard links into the store, which the process that mapped them kept alive. Young ones
* are left alone: they may belong to an install running right now.
*/
function removeStaleStages(packageRoot, now = Date.now()) {
	const parent = dirname(packageRoot);
	if (basename(parent) !== "node_modules") return;
	const prefix = `${basename(packageRoot)}_tmp_`;
	let entries;
	try {
		entries = readdirSync(parent);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.startsWith(prefix)) continue;
		const path = join(parent, entry);
		try {
			if (now - statSync(path).mtimeMs < STALE_STAGE_MS) continue;
			rmSync(path, {
				recursive: true,
				force: true
			});
		} catch {}
	}
}
//#endregion
//#region src/tcc.ts
/**
* Screen Recording and Accessibility status for the process that actually calls screencapture and osascript.
* The desktop host is the DeepSeek Harness executable. `dsh web` is the terminal's node process.
*/
const SETTINGS_URL = {
	screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
	accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
};
/** Remembers which panes were opened so a grant that needs a relaunch is visible. */
var TccMonitor = class {
	opened = /* @__PURE__ */ new Set();
	probe;
	probeFailed = false;
	status() {
		const appName = tccAppName();
		if (process.platform !== "darwin") return {
			applicable: false,
			appName,
			screen: "granted",
			accessibility: "granted"
		};
		const probe = this.loadProbe();
		return {
			applicable: true,
			appName,
			screen: this.right("screen", probe?.screen() ?? false),
			accessibility: this.right("accessibility", probe?.accessibility() ?? false)
		};
	}
	async open(right) {
		if (process.platform !== "darwin") return;
		this.opened.add(right);
		await openExternal(SETTINGS_URL[right]);
	}
	right(right, granted) {
		if (granted) return "granted";
		return this.opened.has(right) ? "needsRelaunch" : "missing";
	}
	loadProbe() {
		if (this.probe) return this.probe;
		if (this.probeFailed) return void 0;
		try {
			this.probe = loadMacProbe();
			return this.probe;
		} catch (error) {
			this.probeFailed = true;
			console.error(`dsh-orb: TCC probe unavailable: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
	}
};
function isDesktopHost() {
	if (typeof process.env.DSH_DESKTOP_NODE_EXECUTABLE === "string" && process.env.DSH_DESKTOP_NODE_EXECUTABLE !== "") return true;
	return process.execPath.includes("DeepSeek Harness");
}
function tccAppName() {
	if (isDesktopHost()) return "DeepSeek Harness";
	return `${process.env.LANG ?? ""}${process.env.LC_ALL ?? ""}`.toLowerCase().includes("zh") ? "终端" : "Terminal";
}
function isTccRight(value) {
	return value === "screen" || value === "accessibility";
}
function loadMacProbe() {
	const library = requireKoffi(import.meta.url).load("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices");
	const screen = library.func("bool CGPreflightScreenCaptureAccess()");
	const accessibility = library.func("bool AXIsProcessTrusted()");
	return {
		screen: () => screen() === true,
		accessibility: () => accessibility() === true
	};
}
/** Opens the system page where the user can allow the microphone. */
function openMicrophoneSettings() {
	return openExternal(process.platform === "win32" ? "ms-settings:privacy-microphone" : "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
}
function openExternal(url) {
	const command = process.platform === "win32" ? "cmd" : "open";
	const args = process.platform === "win32" ? [
		"/c",
		"start",
		"",
		url
	] : [url];
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: "ignore",
			windowsHide: true
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) resolve();
			else reject(/* @__PURE__ */ new Error(`open exited ${code ?? "unknown"}`));
		});
	});
}
//#endregion
//#region src/dock-suppression.ts
/**
* Keep the Desktop Host out of the Dock.
*
* The Host is spawned with the DeepSeek Harness executable in Node mode
* (`ELECTRON_RUN_AS_NODE=1`), so it carries the same bundle identity as the app
* that owns it — `com.deepseek.dsh`. That identity starts out invisible, but the
* moment the process takes part in any UI transaction LaunchServices registers it
* as a regular application and the Dock grows a second identical icon. Selecting
* text is what triggers it: the toolbar geometry and the broadcast that feeds it
* are Host-side work, so the first selection after launch is the moment the extra
* tile appears, and it never goes away again.
*
* `NSApplication.setActivationPolicy(.prohibited)` makes the process one the
* WindowServer never activates, which is what the Dock reads before creating a
* tile. The policy is process-wide and permanent, so it is set once at plugin
* start, before the socket opens or the helper launches.
*
* Only the Desktop Host needs it. `dsh web` is a plain terminal process with no
* `NSApplication` at all, and every other platform has no such notion.
*/
/** AppKit's `NSApplicationActivationPolicy` value for "never activate". */
const NS_APPLICATION_ACTIVATION_POLICY_PROHIBITED = 2;
/** libobjc carries the runtime entry points; NSApplication itself is in the shared cache. */
const OBJC_RUNTIME = "/usr/lib/libobjc.A.dylib";
/**
* Whether this process is the Desktop Host.
*
* `DSH_DESKTOP_NODE_EXECUTABLE` is injected by the desktop shell's package-manager
* plumbing, and the packaged Host also runs from the app's own executable. Both
* spellings are checked so an unpackaged run is covered too.
*/
function isDesktopHostProcess(environment = process.env, executable = process.execPath) {
	if (typeof environment.DSH_DESKTOP_NODE_EXECUTABLE === "string" && environment.DSH_DESKTOP_NODE_EXECUTABLE !== "") return true;
	return executable.includes("DeepSeek Harness");
}
/**
* Reach `NSApplication` through the Objective-C runtime and return a setter.
*
* `NSApplication` and `objc_msgSend` live in the dyld shared cache, so they are
* resolved by class and selector name rather than by loading AppKit by path.
* @returns a setter, or undefined when there is no `NSApplication` to address.
*/
function loadPolicySetter() {
	const library = requireKoffi(import.meta.url).load(OBJC_RUNTIME);
	const getClass = library.func("void *objc_getClass(const char *name)");
	const registerName = library.func("void *sel_registerName(const char *name)");
	const sendVoid = library.func("void *objc_msgSend(void *self, void *op)");
	const sendBoolLong = library.func("bool objc_msgSend(void *self, void *op, long arg)");
	const sendLong = library.func("long objc_msgSend(void *self, void *op)");
	const applicationClass = getClass("NSApplication");
	if (applicationClass === null || applicationClass === void 0) return void 0;
	const shared = sendVoid(applicationClass, registerName("sharedApplication"));
	if (shared === null || shared === void 0) return void 0;
	const setter = registerName("setActivationPolicy:");
	const reader = registerName("activationPolicy");
	return (policy) => {
		if (sendBoolLong(shared, setter, policy) === true) return true;
		try {
			return sendLong(shared, reader) === policy;
		} catch {
			return false;
		}
	};
}
/**
* Stop the Dock from ever creating a tile for the Desktop Host.
*
* Best effort by design: a Host that cannot reach AppKit still runs, it only keeps
* the cosmetic double icon. Failing the whole plugin over a Dock tile would cost
* the ball, voice, and selection for a problem no user work depends on.
* @param deps - platform, host detection, and loader seams for tests.
* @returns whether the policy is now prohibited.
*/
function suppressDockTile(deps = {}) {
	if ((deps.platform ?? process.platform) !== "darwin") return false;
	if (!(deps.isHost ?? (() => isDesktopHostProcess()))()) return false;
	try {
		const set = deps.load === void 0 ? loadPolicySetter() : deps.load();
		if (set === void 0) return false;
		const ok = set(NS_APPLICATION_ACTIVATION_POLICY_PROHIBITED);
		if (!ok) console.error("dsh-orb: the Dock could not be told to stay hidden; a second icon may appear");
		return ok;
	} catch (error) {
		console.error(`dsh-orb: Dock suppression unavailable: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}
const QWEN_SPEED_MIN = .5;
const DEFAULT_QWEN_VOICE = "Cherry";
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
const VOICE_SET = new Set(QWEN_VOICES.map((item) => item.voice));
/** Exact, case-sensitive match: the stored value is what goes on the wire. */
function isQwenVoice(value) {
	return typeof value === "string" && VOICE_SET.has(value);
}
/** Round to the settings step, then pull into 0.5–2.0. Non-numbers are the factory speed. */
function clampQwenSpeed(value) {
	if (!Number.isFinite(value)) return DEFAULT_QWEN_SPEED;
	const rounded = Math.round(value * 10) / 10;
	if (rounded < .5) return QWEN_SPEED_MIN;
	if (rounded > 2) return 2;
	return rounded;
}
/** What the settings page renders: `中文名 · 性别 · 一句话特点`. */
function qwenVoiceViews() {
	return QWEN_VOICES.map((item) => ({
		voice: item.voice,
		label: `${item.name} · ${item.gender} · ${item.note}`,
		group: item.group
	}));
}
/** Round to the settings' two decimals, then pull into range. Non-numbers are the factory volume. */
function clampTtsVolume(value) {
	if (!Number.isFinite(value)) return 1;
	const rounded = Math.round(value * 100) / 100;
	if (rounded < 0) return 0;
	if (rounded > 2) return 2;
	return rounded;
}
//#endregion
//#region ../voice/src/settings.ts
/**
* Voice choices stored in the profile.
* A missing or unreadable file becomes these defaults. A field outside its
* range is pulled back inside it; the other fields are kept.
*/
const DEFAULT_VOICE_SETTINGS = {
	voiceEnabled: false,
	wakeEnabled: true,
	wakeWords: ["你好大肥鱼"],
	wakeThreshold: .25,
	wakeScore: 1,
	wakeChunk: 8,
	wakeCooldownMs: 1500,
	wakeReply: "我在呢",
	commandEnabled: true,
	interjectKeyword: "大肥鱼",
	dismissPhrases: [
		"你退下吧",
		"退下吧",
		"退一下吧"
	],
	dismissReply: "好的，再见",
	ttsEnabled: true,
	ttsBackend: "local",
	qwenApiKey: "",
	qwenVoice: DEFAULT_QWEN_VOICE,
	qwenSpeed: DEFAULT_QWEN_SPEED,
	questionPrompt: "我有几个问题，你来选一下",
	ttsSpeed: 1.5,
	ttsVolume: 1,
	idleMs: 3e4
};
const PHRASE_LIMIT = 8;
const PHRASE_CHARS = 40;
const REPLY_CHARS = 80;
const SECRET_CHARS = 300;
/** Another part of the product treats an empty wake list as "no wake word at all". */
function hasWakeWord(words) {
	return words.some((word) => word.trim() !== "");
}
/**
* Whether the chosen speaker can take a sentence right now.
* The TTS switch is user intent; readiness is the selected backend's own requirement.
*/
function ttsReady(settings, localTtsPresent) {
	if (!settings.ttsEnabled) return false;
	return settings.ttsBackend === "qwen" ? settings.qwenApiKey.trim() !== "" : localTtsPresent;
}
/** Replace anything unreadable or out of range. Missing fields keep the factory value. */
function parseVoiceSettings(value, options = {}) {
	const item = record$1(value);
	if (item === void 0) return clone(DEFAULT_VOICE_SETTINGS);
	return {
		voiceEnabled: flag(item.voiceEnabled, options.legacyMaster === true),
		wakeEnabled: flag(item.wakeEnabled, DEFAULT_VOICE_SETTINGS.wakeEnabled),
		wakeWords: phrases(item.wakeWords, DEFAULT_VOICE_SETTINGS.wakeWords),
		wakeThreshold: numberIn(item.wakeThreshold, .05, .9, DEFAULT_VOICE_SETTINGS.wakeThreshold, 2),
		wakeScore: numberIn(item.wakeScore, .5, 4, DEFAULT_VOICE_SETTINGS.wakeScore, 2),
		wakeChunk: item.wakeChunk === 16 ? 16 : 8,
		wakeCooldownMs: numberIn(item.wakeCooldownMs, 500, 5e3, DEFAULT_VOICE_SETTINGS.wakeCooldownMs, 0),
		wakeReply: text(item.wakeReply, DEFAULT_VOICE_SETTINGS.wakeReply, REPLY_CHARS),
		commandEnabled: flag(item.commandEnabled, DEFAULT_VOICE_SETTINGS.commandEnabled),
		interjectKeyword: text(item.interjectKeyword, DEFAULT_VOICE_SETTINGS.interjectKeyword, PHRASE_CHARS),
		dismissPhrases: phrases(item.dismissPhrases, DEFAULT_VOICE_SETTINGS.dismissPhrases),
		dismissReply: text(item.dismissReply, DEFAULT_VOICE_SETTINGS.dismissReply, REPLY_CHARS),
		ttsEnabled: flag(item.ttsEnabled, DEFAULT_VOICE_SETTINGS.ttsEnabled),
		ttsBackend: item.ttsBackend === "qwen" ? "qwen" : "local",
		qwenApiKey: secret(item.qwenApiKey),
		qwenVoice: voiceName(item.qwenVoice),
		qwenSpeed: typeof item.qwenSpeed === "number" ? clampQwenSpeed(item.qwenSpeed) : DEFAULT_QWEN_SPEED,
		questionPrompt: text(item.questionPrompt, DEFAULT_VOICE_SETTINGS.questionPrompt, REPLY_CHARS),
		ttsSpeed: numberIn(item.ttsSpeed, 1, 3, DEFAULT_VOICE_SETTINGS.ttsSpeed, 1),
		ttsVolume: typeof item.ttsVolume === "number" ? clampTtsVolume(item.ttsVolume) : 1,
		idleMs: numberIn(item.idleMs, 5e3, 6e5, DEFAULT_VOICE_SETTINGS.idleMs, 0)
	};
}
function clone(settings) {
	return {
		...settings,
		wakeWords: [...settings.wakeWords],
		dismissPhrases: [...settings.dismissPhrases]
	};
}
function record$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function flag(value, fallback) {
	return typeof value === "boolean" ? value : fallback;
}
function text(value, fallback, max) {
	if (typeof value !== "string") return fallback;
	return value.trim().slice(0, max);
}
/** A pasted key: surrounding whitespace is not "filled"; control characters would break the header. */
function secret(value) {
	if (typeof value !== "string") return "";
	return value.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, SECRET_CHARS);
}
/** Only a catalogue voice is stored; anything else falls back to the factory voice. */
function voiceName(value) {
	if (typeof value !== "string") return DEFAULT_QWEN_VOICE;
	const trimmed = value.trim();
	return isQwenVoice(trimmed) ? trimmed : DEFAULT_QWEN_VOICE;
}
function phrases(value, fallback) {
	if (!Array.isArray(value)) return [...fallback];
	const next = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const trimmed = item.trim().slice(0, PHRASE_CHARS);
		if (!trimmed || next.includes(trimmed)) continue;
		next.push(trimmed);
		if (next.length >= PHRASE_LIMIT) break;
	}
	return next;
}
function numberIn(value, min, max, fallback, decimals) {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	const factor = 10 ** decimals;
	const rounded = Math.round(value * factor) / factor;
	if (rounded < min) return min;
	if (rounded > max) return max;
	return rounded;
}
//#endregion
//#region src/helper-path.ts
/**
* Where the helper's files are.
* Installed `dsh-orb` keeps them next to this file: `dist/host/index.js` and `dist/helper/lib/main.js`.
* In the workspace the helper is a separate package that Node resolves by name.
*/
const require = createRequire(import.meta.url);
/** Root folder of the helper: holds `lib/`, `assets/` and the preload scripts. */
function helperRoot() {
	const assembled = fileURLToPath(new URL("../helper", import.meta.url));
	if (existsSync(join(assembled, "lib", "main.js"))) return assembled;
	return dirname(require.resolve("@dsh-orb/helper/package.json"));
}
/** Electron entry script of the helper. */
function helperMain() {
	return join(helperRoot(), "lib", "main.js");
}
/** Bundled default avatar. */
function defaultAvatarPath() {
	return join(helperRoot(), "assets", "deepseek-avatar-square.gif");
}
/** Built-in avatar GIFs. The ball loads them from disk, the settings page over the route. */
function presetAvatarDir() {
	return join(helperRoot(), "assets", "avatars");
}
//#endregion
//#region src/avatar-presets.ts
/**
* Built-in ball avatars.
* The files are animated GIFs in the helper's `assets/avatars`. The ball picks one
* by relative path (a data URL would have to carry megabytes through the socket),
* while the settings page reads the same files through the avatar route.
*/
/** Gallery order is this order. */
const AVATAR_PRESETS = [
	{
		id: "point",
		file: "point.gif"
	},
	{
		id: "rice",
		file: "rice.gif"
	},
	{
		id: "heart",
		file: "heart.gif"
	},
	{
		id: "cheer",
		file: "cheer.gif"
	},
	{
		id: "cheeks",
		file: "cheeks.gif"
	},
	{
		id: "smile",
		file: "smile.gif"
	}
];
function findAvatarPreset(id) {
	return AVATAR_PRESETS.find((preset) => preset.id === id);
}
function isAvatarPresetId(value) {
	return typeof value === "string" && findAvatarPreset(value) !== void 0;
}
/** Absolute path of a shipped preset. Unknown ids resolve to nothing, so a request cannot walk the disk. */
function avatarPresetPath(id) {
	const preset = findAvatarPreset(id);
	return preset === void 0 ? void 0 : join(presetAvatarDir(), preset.file);
}
/** Source the ball page reads, relative to the ball's own document. */
function avatarPresetSrc(id) {
	const preset = findAvatarPreset(id);
	return preset === void 0 ? void 0 : `avatars/${preset.file}`;
}
//#endregion
//#region src/preferences.ts
/**
* Profile files the ball and the settings page share.
* Names match the desktop fork so an existing profile keeps its choices.
*
* `orb-agent-models.json` records only the tracks the user picked in the ball. A track
* without an entry follows the shared fallback in {@link ProfileStore.applyModelFallback},
* which `model-defaults.ts` resolves from the live catalog and the main window's default
* model — the route the official sign-in points at the account once the profile has no
* API key. {@link DEFAULT_MODEL} is the last resort, not the shipped default.
*/
const PERMISSION_FILE = "orb-permission.json";
const MODELS_FILE = "orb-agent-models.json";
const MILLIFRACTION_FILE = "millifraction-coordinates.json";
const OBSERVATION_FRAME_FILE = "observation-frame.json";
const SELECTION_FILE = "selection-toolbar.json";
const LASSO_FILE = "lasso-capture.json";
const BALL_FILE = "ball-enabled.json";
const AVATAR_FILE = "orb-avatar";
const AVATAR_META_FILE = "orb-avatar.json";
const UPDATE_FILE = "orb-update.json";
const HISTORY_FILE = "orb-history.json";
const WORKSPACE_FILE = "orb-workspace.json";
const VOICE_FILE = "orb-voice.json";
const WHATS_NEW_FILE = "orb-whats-new.json";
/** Retention choices shown in the settings select; 0 means forever. */
const HISTORY_RETENTION_DAYS = [
	0,
	1,
	7,
	14,
	30,
	60
];
/** True for the six choices the settings page can send. */
function isHistoryRetentionDays(value) {
	return HISTORY_RETENTION_DAYS.includes(value);
}
const PERMISSION_PRESETS = [
	"read-only",
	"workspace-write",
	"danger-full-access"
];
/** Same provider, model, and effort. Used to skip writes that would change nothing. */
function sameSelection(left, right) {
	return left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort;
}
const DEFAULT_UPDATE = {
	checkedAt: 0,
	latestVersion: "",
	notifiedVersion: "",
	autoCheck: true,
	lastError: ""
};
const DEFAULT_HISTORY = {
	retentionDays: 0,
	lastCleanupAt: 0,
	lastDeletedSessions: 0,
	lastMovedBytes: 0,
	restoredSessionIds: []
};
/** The floating-ball workspace when the profile names no other one. */
function defaultWorkspaceDirectory() {
	return resolve(dshHomePath("dsh_orb"));
}
/**
* The shipped DeepSeek pair. It is the fallback the unpicked tracks start on, and the
* last resort for a deployment whose catalog or main-window default names nothing the
* ball can route. `model-defaults.ts` decides which of those wins and installs it.
*/
const DEFAULT_MODEL = {
	provider: "deepseek-official",
	model: "deepseek-flash",
	reasoningEffort: "max"
};
/**
* Active official profile directory.
* Desktop and `dsh web` both provide `profileContext.dir`. The process directory is the fallback.
*/
function profileDirectory(ctx) {
	const profile = ctx.get("profileContext");
	if (typeof profile === "object" && profile !== null && "dir" in profile) {
		const dir = profile.dir;
		if (typeof dir === "string" && dir !== "") return dir;
	}
	return process.cwd();
}
function isPermissionPreset(value) {
	return typeof value === "string" && PERMISSION_PRESETS.includes(value);
}
function isAgentModelSelection(value) {
	return parseSelection(value) !== void 0;
}
/** The four shipped looks for the lasso satellite. */
const LASSO_BALL_SKINS = [
	"classic",
	"glass",
	"theme",
	"avatar"
];
/** Where the satellite sits on the main ball's rim. */
const LASSO_BALL_POSITIONS = [
	"top-left",
	"top",
	"top-right",
	"left",
	"right",
	"bottom-left",
	"bottom",
	"bottom-right"
];
const DEFAULT_LASSO_BALL = {
	skin: "classic",
	position: "bottom",
	length: 26,
	balance: true
};
function isLassoBallSkin(value) {
	return typeof value === "string" && LASSO_BALL_SKINS.includes(value);
}
function isLassoBallPosition(value) {
	return typeof value === "string" && LASSO_BALL_POSITIONS.includes(value);
}
/**
* Validate one partial change from the settings page or the ball menu.
* @returns the accepted fields, or undefined when the payload has none or an invalid one.
*/
function parseLassoBallPatch(value) {
	const recordValue = record(value);
	if (recordValue === void 0) return void 0;
	const patch = {};
	let fields = 0;
	if ("enabled" in recordValue) {
		if (typeof recordValue.enabled !== "boolean") return void 0;
		patch.enabled = recordValue.enabled;
		fields += 1;
	}
	if ("skin" in recordValue) {
		if (!isLassoBallSkin(recordValue.skin)) return void 0;
		patch.skin = recordValue.skin;
		fields += 1;
	}
	if ("position" in recordValue) {
		if (!isLassoBallPosition(recordValue.position)) return void 0;
		patch.position = recordValue.position;
		fields += 1;
	}
	if ("length" in recordValue) {
		const length = recordValue.length;
		if (typeof length !== "number" || !Number.isFinite(length)) return void 0;
		const rounded = Math.round(length);
		if (rounded < 26 || rounded > 56) return void 0;
		patch.length = rounded;
		fields += 1;
	}
	if ("balance" in recordValue) {
		if (typeof recordValue.balance !== "boolean") return void 0;
		patch.balance = recordValue.balance;
		fields += 1;
	}
	return fields === 0 ? void 0 : patch;
}
/** One stored or patched configuration; absent or invalid fields keep the defaults. */
function parseLassoBallConfig(value) {
	const recordValue = record(value);
	const length = recordValue?.length;
	return {
		skin: isLassoBallSkin(recordValue?.skin) ? recordValue.skin : DEFAULT_LASSO_BALL.skin,
		position: isLassoBallPosition(recordValue?.position) ? recordValue.position : DEFAULT_LASSO_BALL.position,
		length: typeof length === "number" && Number.isFinite(length) ? Math.min(56, Math.max(26, Math.round(length))) : DEFAULT_LASSO_BALL.length,
		balance: typeof recordValue?.balance === "boolean" ? recordValue.balance : DEFAULT_LASSO_BALL.balance
	};
}
/** In-memory view of the profile files. Writes update the cache and the disk together. */
var ProfileStore = class {
	dir;
	permissionValue;
	permissionFallbackValue;
	modelValue;
	/**
	* What a track the user never picked follows. Memory only: it is the main window's
	* default, refreshed by `model-defaults.ts`, and must not be mistaken for a choice.
	*/
	modelFallbackValue = DEFAULT_MODEL;
	millifractionValue;
	observationFrameValue;
	selectionValue;
	selectionLanguage;
	lassoValue;
	lassoBallValue;
	ballValue;
	updateValue;
	historyValue;
	whatsNewValue;
	voiceValue;
	constructor(dir) {
		this.dir = dir;
		const permission = readPermission(dir);
		this.permissionValue = permission.preset;
		this.permissionFallbackValue = permission.fallback;
		this.modelValue = readModels(dir);
		this.millifractionValue = readMillifraction(dir);
		this.observationFrameValue = readObservationFrame(dir);
		const selection = readSelection(dir);
		this.selectionValue = selection.enabled;
		this.selectionLanguage = selection.language;
		const lasso = readLasso(dir);
		this.lassoValue = lasso.enabled;
		this.lassoBallValue = lasso.ball;
		this.ballValue = readBall(dir);
		this.updateValue = readUpdate(dir);
		this.historyValue = readHistory(dir);
		this.whatsNewValue = readWhatsNew(dir);
		const voice = readJson$1(join(dir, VOICE_FILE));
		this.voiceValue = parseVoiceSettings(voice, { legacyMaster: legacyVoiceOn(voice) });
	}
	permission() {
		return this.permissionValue;
	}
	/** True when the permission file exists but cannot be used. Missing means full access. */
	permissionFallback() {
		return this.permissionFallbackValue;
	}
	setPermission(preset) {
		this.permissionValue = preset;
		this.permissionFallbackValue = false;
		writeJson(join(this.dir, PERMISSION_FILE), { preset });
	}
	/**
	* The two tracks: an explicit ball choice wins, a track the user never picked follows
	* the unpicked-track fallback. Nothing here is persisted — a track stays "following"
	* until the user picks a model for it.
	*/
	models() {
		return {
			overlay: this.modelValue.overlay ?? this.modelFallbackValue,
			background: this.modelValue.background ?? this.modelFallbackValue
		};
	}
	/**
	* Install what the unpicked tracks follow.
	* @param selection - the resolved fallback; invalid values are ignored.
	* @returns whether it moved, which is what makes a live session re-select.
	*/
	applyModelFallback(selection) {
		const next = parseSelection(selection);
		if (next === void 0 || sameSelection(next, this.modelFallbackValue)) return false;
		this.modelFallbackValue = next;
		return true;
	}
	setOverlay(selection) {
		this.modelValue = {
			...this.modelValue,
			overlay: selection
		};
		this.writeModels();
	}
	setBackground(selection) {
		this.modelValue = {
			...this.modelValue,
			background: selection
		};
		this.writeModels();
	}
	millifractionEnabled() {
		return this.millifractionValue;
	}
	setMillifractionEnabled(enabled) {
		this.millifractionValue = enabled;
		writeJson(join(this.dir, MILLIFRACTION_FILE), { enabled });
	}
	/** The coloured frame around the window Computer Use works on; on unless turned off. */
	observationFrameEnabled() {
		return this.observationFrameValue;
	}
	setObservationFrameEnabled(enabled) {
		this.observationFrameValue = enabled;
		writeJson(join(this.dir, OBSERVATION_FRAME_FILE), { enabled });
	}
	/** Pixel on macOS, millifraction on Windows, unless the profile file says otherwise. */
	coordinateMode() {
		return this.millifractionValue ? "millifraction" : "pixel";
	}
	selectionEnabled() {
		return this.selectionValue;
	}
	translateLanguage() {
		return this.selectionLanguage;
	}
	setTranslateLanguage(language) {
		this.selectionLanguage = language;
		writeJson(join(this.dir, SELECTION_FILE), {
			enabled: this.selectionValue,
			translateTargetLanguage: language
		});
	}
	setSelectionEnabled(enabled) {
		this.selectionValue = enabled;
		writeJson(join(this.dir, SELECTION_FILE), {
			enabled,
			translateTargetLanguage: this.selectionLanguage
		});
	}
	lassoEnabled() {
		return this.lassoValue;
	}
	setLassoEnabled(enabled) {
		this.lassoValue = enabled;
		this.writeLasso();
	}
	/** The handle's look, without the master switch. */
	lassoBall() {
		return { ...this.lassoBallValue };
	}
	/** Master switch and look together, for the settings card. */
	lassoSatellite() {
		return {
			enabled: this.lassoValue,
			...this.lassoBallValue
		};
	}
	/**
	* Apply one settings-card change. Invalid fields keep their current value, so a partial
	* update from the page can never reset a choice it did not send.
	*/
	setLassoBall(patch) {
		const current = this.lassoBallValue;
		const next = parseLassoBallConfig({
			skin: patch.skin ?? current.skin,
			position: patch.position ?? current.position,
			length: patch.length ?? current.length,
			balance: patch.balance ?? current.balance
		});
		this.lassoBallValue = next;
		this.writeLasso();
		return this.lassoSatellite();
	}
	writeLasso() {
		writeJson(join(this.dir, LASSO_FILE), {
			enabled: this.lassoValue,
			...this.lassoBallValue
		});
	}
	/** Missing file means the ball is on. `autoStart: false` is a separate patch switch. */
	ballEnabled() {
		return this.ballValue;
	}
	setBallEnabled(enabled) {
		this.ballValue = enabled;
		writeJson(join(this.dir, BALL_FILE), { enabled });
	}
	updateRecord() {
		return this.updateValue;
	}
	setUpdateRecord(patch) {
		this.updateValue = {
			...this.updateValue,
			...patch
		};
		writeJson(join(this.dir, UPDATE_FILE), this.updateValue);
	}
	/** Whether the user already closed this release note on this profile. */
	whatsNewDismissed(id) {
		return this.whatsNewValue.has(id);
	}
	/**
	* Remember a closed release note. The file is written before the in-memory set moves, so a
	* failed write leaves the note visible instead of pretending it was dismissed.
	*/
	dismissWhatsNew(id) {
		if (this.whatsNewValue.has(id)) return;
		const next = new Set(this.whatsNewValue);
		next.add(id);
		writeJson(join(this.dir, WHATS_NEW_FILE), { dismissed: [...next] });
		this.whatsNewValue = next;
	}
	history() {
		return this.historyValue;
	}
	setHistoryRecord(patch) {
		this.historyValue = {
			...this.historyValue,
			...patch
		};
		writeJson(join(this.dir, HISTORY_FILE), this.historyValue);
	}
	/** Wake, command, and speech settings. A bad file reads back as the factory values. */
	voice() {
		return this.voiceValue;
	}
	/** Persist a settings object. Out-of-range fields are corrected before they hit disk. */
	setVoice(value) {
		this.voiceValue = parseVoiceSettings(value);
		writeJson(join(this.dir, VOICE_FILE), this.voiceValue);
		return this.voiceValue;
	}
	/**
	* The workspace the ball creates its conversations in. The future workspace setting
	* writes `orb-workspace.json`; missing or relative paths keep the shipped default.
	*/
	workspaceDirectory() {
		const stored = record(readJson$1(join(this.dir, WORKSPACE_FILE)))?.path;
		if (typeof stored === "string" && isAbsolute(stored)) return resolve(stored);
		return defaultWorkspaceDirectory();
	}
	/** `null` restores the shipped default; any other absolute path is stored as-is. */
	setWorkspaceDirectory(path) {
		if (path === null || resolve(path) === defaultWorkspaceDirectory()) {
			removeIfPresent(join(this.dir, WORKSPACE_FILE));
			return;
		}
		writeJson(join(this.dir, WORKSPACE_FILE), { path: resolve(path) });
	}
	/** Bumped by every avatar change: the ball refetches on it, the settings preview re-renders on it. */
	avatarVersion() {
		for (const name of [AVATAR_META_FILE, AVATAR_FILE]) try {
			return statSync(join(this.dir, name)).mtimeMs;
		} catch {}
		return 0;
	}
	/**
	* Avatar the profile currently shows, checked against what is on disk.
	* An unknown preset id or a half-written upload falls back to the shipped GIF.
	*/
	avatarSelection() {
		const preset = record(readJson$1(join(this.dir, AVATAR_META_FILE)))?.preset;
		if (isAvatarPresetId(preset)) return {
			kind: "preset",
			id: preset
		};
		const custom = this.readAvatar();
		if (custom !== void 0) return {
			kind: "custom",
			mime: custom.mime
		};
		return { kind: "default" };
	}
	readAvatar() {
		let bytes;
		try {
			bytes = readFileSync(join(this.dir, AVATAR_FILE));
		} catch {
			return;
		}
		const sniffed = sniffAvatarMime(bytes);
		if (sniffed === void 0) return void 0;
		const declared = readAvatarMime(this.dir);
		if (declared !== void 0 && declared !== sniffed) return void 0;
		return {
			bytes,
			mime: declared ?? sniffed
		};
	}
	/** One avatar per profile: an uploaded image drops the preset pick and the other way round. */
	writeAvatar(bytes, mime) {
		writeBytes(join(this.dir, AVATAR_FILE), bytes);
		writeJson(join(this.dir, AVATAR_META_FILE), {
			kind: "custom",
			mime
		});
	}
	selectAvatarPreset(id) {
		writeJson(join(this.dir, AVATAR_META_FILE), {
			kind: "preset",
			preset: id
		});
		removeIfPresent(join(this.dir, AVATAR_FILE));
	}
	restoreAvatar() {
		for (const name of [AVATAR_FILE, AVATAR_META_FILE]) removeIfPresent(join(this.dir, name));
	}
	/**
	* Persist the explicit choices only. Writing a resolved value would freeze a track
	* the user never picked, and the reader already treats a missing entry as "follow
	* the main window".
	*/
	writeModels() {
		const { overlay, background } = this.modelValue;
		writeJson(join(this.dir, MODELS_FILE), {
			...overlay === void 0 ? {} : { overlay: serializeSelection(overlay) },
			...background === void 0 ? {} : { background: serializeSelection(background) }
		});
	}
};
function sniffAvatarMime(bytes) {
	if (bytes.length >= 6 && bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 56 && (bytes[4] === 55 || bytes[4] === 57) && bytes[5] === 97) return "image/gif";
	if (bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return "image/png";
	if (bytes.length >= 12 && bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70 && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) return "image/webp";
}
function defaultMillifraction(platform = process.platform) {
	return platform === "win32";
}
function readPermission(dir) {
	let raw;
	try {
		raw = readFileSync(join(dir, PERMISSION_FILE), "utf8");
	} catch (error) {
		if (isEnoent(error)) return {
			preset: "danger-full-access",
			fallback: false
		};
		return {
			preset: "workspace-write",
			fallback: true
		};
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {
			preset: "workspace-write",
			fallback: true
		};
	}
	const preset = record(parsed)?.preset;
	if (isPermissionPreset(preset)) return {
		preset,
		fallback: false
	};
	return {
		preset: "workspace-write",
		fallback: true
	};
}
/** Explicit choices, keyed by track. A track with no entry is resolved on read. */
function readModels(dir) {
	const value = record(readJson$1(join(dir, MODELS_FILE)));
	const overlay = parseSelection(value?.overlay);
	const background = parseSelection(value?.background);
	return {
		...overlay === void 0 ? {} : { overlay },
		...background === void 0 ? {} : { background }
	};
}
function readMillifraction(dir) {
	const enabled = record(readJson$1(join(dir, MILLIFRACTION_FILE)))?.enabled;
	return typeof enabled === "boolean" ? enabled : defaultMillifraction();
}
function readSelection(dir) {
	const value = record(readJson$1(join(dir, SELECTION_FILE)));
	const language = value?.translateTargetLanguage === "en" ? "en" : "zh";
	return {
		enabled: typeof value?.enabled === "boolean" ? value.enabled : true,
		language
	};
}
function readBall(dir) {
	const enabled = record(readJson$1(join(dir, BALL_FILE)))?.enabled;
	return typeof enabled === "boolean" ? enabled : true;
}
function readObservationFrame(dir) {
	const enabled = record(readJson$1(join(dir, OBSERVATION_FRAME_FILE)))?.enabled;
	return typeof enabled === "boolean" ? enabled : true;
}
function readLasso(dir) {
	const value = record(readJson$1(join(dir, LASSO_FILE)));
	return {
		enabled: typeof value?.enabled === "boolean" ? value.enabled : true,
		ball: parseLassoBallConfig(value)
	};
}
function readAvatarMime(dir) {
	const mime = record(readJson$1(join(dir, AVATAR_META_FILE)))?.mime;
	if (mime === "image/gif" || mime === "image/png" || mime === "image/webp") return mime;
}
function readUpdate(dir) {
	const stored = record(readJson$1(join(dir, UPDATE_FILE)));
	if (stored === void 0) return DEFAULT_UPDATE;
	return {
		checkedAt: typeof stored.checkedAt === "number" && Number.isFinite(stored.checkedAt) ? stored.checkedAt : 0,
		latestVersion: typeof stored.latestVersion === "string" ? stored.latestVersion : "",
		notifiedVersion: typeof stored.notifiedVersion === "string" ? stored.notifiedVersion : "",
		autoCheck: typeof stored.autoCheck === "boolean" ? stored.autoCheck : true,
		lastError: typeof stored.lastError === "string" ? stored.lastError : ""
	};
}
/** A missing or malformed file means nothing was dismissed: the note appears again. */
function readWhatsNew(dir) {
	const stored = record(readJson$1(join(dir, WHATS_NEW_FILE)));
	const list = Array.isArray(stored?.dismissed) ? stored.dismissed : [];
	return new Set(list.filter((id) => typeof id === "string" && id !== ""));
}
function readHistory(dir) {
	const stored = record(readJson$1(join(dir, HISTORY_FILE)));
	if (stored === void 0) return DEFAULT_HISTORY;
	const days = stored.retentionDays;
	return {
		retentionDays: typeof days === "number" && isHistoryRetentionDays(days) ? days : DEFAULT_HISTORY.retentionDays,
		lastCleanupAt: typeof stored.lastCleanupAt === "number" && Number.isFinite(stored.lastCleanupAt) ? stored.lastCleanupAt : 0,
		lastDeletedSessions: typeof stored.lastDeletedSessions === "number" && Number.isInteger(stored.lastDeletedSessions) && stored.lastDeletedSessions >= 0 ? stored.lastDeletedSessions : 0,
		lastMovedBytes: typeof stored.lastMovedBytes === "number" && Number.isFinite(stored.lastMovedBytes) && stored.lastMovedBytes >= 0 ? stored.lastMovedBytes : 0,
		restoredSessionIds: Array.isArray(stored.restoredSessionIds) ? stored.restoredSessionIds.filter((id) => typeof id === "string" && /^[A-Za-z0-9._-]+$/.test(id) && !id.includes("..")).slice(-1e3) : []
	};
}
function parseSelection(value) {
	const item = record(value);
	if (item === void 0) return void 0;
	if (typeof item.provider !== "string" || item.provider === "" || item.provider.length > 200) return void 0;
	if (typeof item.model !== "string" || item.model === "" || item.model.length > 200) return void 0;
	if (item.reasoningEffort !== void 0 && (typeof item.reasoningEffort !== "string" || item.reasoningEffort === "" || item.reasoningEffort.length > 80)) return;
	return {
		provider: item.provider,
		model: item.model,
		...typeof item.reasoningEffort === "string" ? { reasoningEffort: item.reasoningEffort } : {}
	};
}
function serializeSelection(selection) {
	return {
		provider: selection.provider,
		model: selection.model,
		...selection.reasoningEffort === void 0 ? {} : { reasoningEffort: selection.reasoningEffort }
	};
}
/** A pre-master voice file was running if any of its three columns was explicitly on. */
function legacyVoiceOn(value) {
	const item = record(value);
	if (item === void 0) return false;
	return item.wakeEnabled === true || item.commandEnabled === true || item.ttsEnabled === true;
}
function readJson$1(file) {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return;
	}
}
function record(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function writeJson(file, value) {
	writeBytes(file, Buffer.from(`${JSON.stringify(value, void 0, 2)}\n`));
}
function writeBytes(file, bytes) {
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, bytes);
	renameSync(tmp, file);
}
function removeIfPresent(file) {
	try {
		unlinkSync(file);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
}
function isEnoent(error) {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
//#endregion
//#region src/balance.ts
/**
* The signed-in DeepSeek account's recharge balance for the lasso satellite.
*
* The official account service owns the token and platform headers, so this module never
* stores or sees an API key. Only the normal (recharge) wallets count; granted bonus
* wallets are deliberately left out of the number on the ball.
* @module dsh-orb/host/balance
*/
/** Re-read the account balance while the satellite shows it. */
const BALANCE_REFRESH_MS = 3e5;
/** A settings change and the periodic poll may ask in the same breath; share that read. */
const MIN_REFRESH_GAP_MS = 15e3;
const EMPTY_BALANCE = {
	text: null,
	full: null,
	state: "unavailable"
};
/**
* Read one platform balance outcome.
* @param outcome - the account service's result: {@link null}, `{status:'ready', value}`, or `{status:'failed'}`.
* @returns the recharge amount, or why there is none.
*/
function readRechargeBalance(outcome) {
	if (outcome === null) return { kind: "signed-out" };
	if (typeof outcome !== "object") return { kind: "failed" };
	const record = outcome;
	if (record.status === "failed") return { kind: "failed" };
	if (record.status !== "ready") return { kind: "failed" };
	const wallets = readWallets(record.value);
	if (wallets.length === 0) return { kind: "unavailable" };
	const currency = wallets.some((wallet) => wallet.currency === "CNY") ? "CNY" : wallets.some((wallet) => wallet.currency === "USD") ? "USD" : wallets[0]?.currency;
	if (currency === void 0) return { kind: "unavailable" };
	const selected = wallets.filter((wallet) => wallet.currency === currency);
	let total = 0;
	for (const wallet of selected) {
		const amount = Number(wallet.balance);
		if (Number.isFinite(amount)) total += amount;
	}
	const symbol = currency === "CNY" ? "¥" : currency === "USD" ? "$" : `${currency} `;
	return {
		kind: "ready",
		text: compactBalance(total, symbol),
		full: formatBalance(total, symbol)
	};
}
function readWallets(value) {
	if (!Array.isArray(value)) return [];
	const wallets = [];
	for (const raw of value) {
		if (typeof raw !== "object" || raw === null) continue;
		const record = raw;
		if (typeof record.currency !== "string" || typeof record.balance !== "string") continue;
		if (!Number.isFinite(Number(record.balance))) continue;
		wallets.push({
			currency: record.currency,
			balance: record.balance
		});
	}
	return wallets;
}
/** Platform Web's two-decimal, sub-cent display rules. */
function formatBalance(amount, symbol) {
	if (amount === 0) return `${symbol}0.00`;
	if (amount < 0) return `-${symbol}${Math.abs(amount) < .01 ? "0.01" : grouped(Math.abs(amount).toFixed(2))}`;
	if (amount < .01) return `<${symbol}0.01`;
	return `${symbol}${grouped((Math.floor(amount * 100) / 100).toFixed(2))}`;
}
/** Keep the satellite readable: grouped digits fall back to thousands/millions. */
function compactBalance(amount, symbol) {
	const absolute = Math.abs(amount);
	const sign = amount < 0 ? "-" : "";
	if (absolute >= 1e6) return `${sign}${symbol}${trimZero((absolute / 1e6).toFixed(1))}m`;
	if (absolute >= 1e4) return `${sign}${symbol}${Math.round(absolute / 1e3)}k`;
	if (absolute >= 1e3) return `${sign}${symbol}${trimZero((absolute / 1e3).toFixed(1))}k`;
	return formatBalance(amount, symbol);
}
function trimZero(value) {
	return value.endsWith(".0") ? value.slice(0, -2) : value;
}
function grouped(value) {
	const [integer, fraction] = value.split(".");
	return `${Number(integer).toLocaleString("en-US")}.${fraction}`;
}
/**
* Cache one account balance and expose it as a widget-sized snapshot.
* The caller owns the refresh schedule: enabling the toggle, a five-minute timer, and a
* finished turn all call {@link refresh}.
*/
var BalanceMonitor = class {
	deps;
	value = EMPTY_BALANCE;
	inflight;
	/** Negative infinity so the first refresh is never mistaken for a recent read. */
	lastAt = Number.NEGATIVE_INFINITY;
	error = null;
	constructor(deps) {
		this.deps = deps;
	}
	current() {
		return this.value;
	}
	/** Diagnostic detail for the settings card; never rendered on the ball. */
	lastError() {
		return this.error;
	}
	/**
	* Read the account once and fold the outcome into {@link current}.
	* @param force - skip the short coalescing window (a settings toggle, not a poll).
	* @returns the snapshot now current.
	*/
	refresh(force = false) {
		if (this.inflight !== void 0) return this.inflight;
		const now = this.deps.now ?? Date.now;
		if (!force && now() - this.lastAt < MIN_REFRESH_GAP_MS) return Promise.resolve(this.value);
		this.lastAt = now();
		this.inflight = this.read().finally(() => {
			this.inflight = void 0;
		});
		return this.inflight;
	}
	/** Stop showing a value that no longer belongs to the account. */
	clear() {
		this.value = EMPTY_BALANCE;
		this.lastAt = Number.NEGATIVE_INFINITY;
		this.error = null;
	}
	async read() {
		const account = this.deps.account();
		if (account === void 0) {
			this.value = EMPTY_BALANCE;
			this.error = "account service missing";
			return this.value;
		}
		try {
			const read = readRechargeBalance(await account.getBalance(this.deps.client()));
			if (read.kind === "ready") {
				this.value = {
					text: read.text,
					full: read.full,
					state: "ready"
				};
				this.error = null;
			} else if (read.kind === "signed-out" || read.kind === "unavailable") {
				this.value = {
					text: null,
					full: null,
					state: read.kind === "signed-out" ? "signed-out" : "unavailable"
				};
				this.error = read.kind === "signed-out" ? "signed out" : "no recharge wallet";
			} else {
				this.value = {
					...this.value,
					state: "error"
				};
				this.error = "balance query failed";
			}
		} catch (error) {
			if (this.value.text === null) this.value = {
				text: null,
				full: null,
				state: "error"
			};
			else this.value = {
				...this.value,
				state: "error"
			};
			this.error = error instanceof Error ? error.message : String(error);
			this.deps.log?.(`balance read failed: ${this.error}`);
		}
		return this.value;
	}
};
//#endregion
//#region src/catalog.ts
/** Accept the official `modelCatalog()` object, or an empty catalog when it is missing. */
function normalizeCatalog(value) {
	const groups = asRecord$3(value)?.groups;
	if (!Array.isArray(groups)) return { groups: [] };
	const normalized = [];
	for (const group of groups) {
		const record = asRecord$3(group);
		if (record === void 0 || typeof record.id !== "string" || typeof record.name !== "string") continue;
		if (!Array.isArray(record.models)) continue;
		const models = [];
		for (const model of record.models) {
			const item = asRecord$3(model);
			if (item === void 0 || typeof item.id !== "string" || typeof item.name !== "string") continue;
			const reasoning = reasoningOf(item.reasoning);
			models.push({
				id: item.id,
				name: item.name,
				...reasoning === void 0 ? {} : { reasoning }
			});
		}
		if (models.length > 0) normalized.push({
			id: record.id,
			name: record.name,
			models
		});
	}
	return { groups: normalized };
}
function reasoningOf(value) {
	const record = asRecord$3(value);
	if (record === void 0 || !Array.isArray(record.efforts)) return void 0;
	const efforts = [];
	for (const effort of record.efforts) {
		const item = asRecord$3(effort);
		if (item === void 0 || typeof item.id !== "string" || typeof item.name !== "string") continue;
		efforts.push({
			id: item.id,
			name: item.name
		});
	}
	if (efforts.length === 0) return void 0;
	const defaultEffort = typeof record.defaultEffort === "string" && record.defaultEffort !== "" ? record.defaultEffort : void 0;
	return {
		efforts,
		...defaultEffort === void 0 ? {} : { defaultEffort }
	};
}
function asRecord$3(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
//#endregion
//#region src/history.ts
/**
* Retention for the floating-ball workspace history.
*
* A cleanup archives a conversation, packs its subagent directories and the images
* only it references into a hidden folder inside the root session directory, then
* hands that directory to the operating system's trash (macOS Trash / Windows
* Recycle Bin). Restoring the folder from the system trash puts it back in the
* sessions root; the restore scan below then moves the packed pieces back and
* unarchives the conversation. There is no plugin-owned trash and no copy: the
* files the user restores are the only copy.
*/
/** State shown when a Host has no persistence or no usable system trash. */
const EMPTY_HISTORY_STATE = {
	available: false,
	workspacePath: "",
	retentionDays: 0,
	cleaning: false,
	phase: "",
	error: null,
	lastCleanupAt: null,
	lastDeletedSessions: 0,
	lastMovedBytes: 0,
	warning: "",
	warningSessions: 0
};
/** First automatic check after startup; long enough for the app to settle. */
const HISTORY_FIRST_CHECK_MS = 6e4;
/** How often a finite retention is checked while the app stays open. */
const HISTORY_INTERVAL_MS = 864e5;
/** How often the sessions root is checked for folders restored from system trash. */
const HISTORY_RESTORE_INTERVAL_MS = 1e4;
const DAY_MS = 864e5;
const MOVE_ATTEMPTS = 5;
const MOVE_BACKOFF_MS = 50;
const SHA256_REF = /sha256:[0-9a-f]{64}/g;
/** Hidden folder inside a trashed root Session directory. */
const MARKER = ".dsh-orb-os-trash";
const MARKER_MANIFEST = "manifest.json";
var HistoryUnavailableError = class extends Error {};
/**
* Retention, preview, cleanup, and restoration from the operating system's trash.
* The class never decides whether a service exists; {@link HistoryDeps.available}
* and the injected functions keep every composition explicit.
*/
var HistoryCleaner = class {
	deps;
	cleaning = false;
	/** A cleanup was requested while {@link cleaning} was already held. */
	cleanPending = false;
	phase = "";
	error = null;
	warning = "";
	warningSessions = 0;
	timer;
	interval;
	restoreTimer;
	constructor(deps) {
		this.deps = deps;
	}
	/** State rendered by the settings card; never scans session logs. */
	state() {
		const history = this.deps.store.history();
		return {
			available: this.available(),
			workspacePath: this.deps.workspacePath(),
			retentionDays: history.retentionDays,
			cleaning: this.cleaning,
			phase: this.phase,
			error: this.error,
			lastCleanupAt: history.lastCleanupAt === 0 ? null : history.lastCleanupAt,
			lastDeletedSessions: history.lastDeletedSessions,
			lastMovedBytes: history.lastMovedBytes,
			warning: this.warning,
			warningSessions: this.warningSessions
		};
	}
	/** Persist a retention policy. 0 means forever and deletes nothing. */
	setRetention(days) {
		if (!isHistoryRetentionDays(days)) throw new Error("invalid-retention");
		this.deps.store.setHistoryRecord({ retentionDays: days });
		this.error = null;
		this.warning = "";
		this.warningSessions = 0;
	}
	/** Read-only count of what the current policy would move. */
	async preview(days) {
		this.assertAvailable();
		if (!isHistoryRetentionDays(days)) throw new Error("invalid-retention");
		if (days === 0) return {
			days,
			cutoff: 0,
			roots: 0,
			members: 0,
			images: 0,
			bytes: 0,
			oldest: null,
			newest: null,
			skipped: emptySkips(),
			sessions: []
		};
		const plan = await this.plan(days);
		let bytes = plan.logBytes;
		for (const size of plan.images.values()) bytes += size;
		return {
			days,
			cutoff: plan.cutoff,
			roots: plan.trees.length,
			members: plan.trees.reduce((sum, tree) => sum + tree.members.length, 0),
			images: plan.images.size,
			bytes,
			oldest: plan.trees.length === 0 ? null : Math.min(...plan.trees.map((tree) => tree.oldest)),
			newest: plan.trees.length === 0 ? null : Math.max(...plan.trees.map((tree) => tree.newest)),
			skipped: plan.skipped,
			sessions: plan.trees.slice(0, 20).map((tree) => ({
				id: tree.root.sessionId,
				title: tree.root.projections?.values?.title || tree.root.sessionId,
				updatedAt: tree.root.updatedAt ?? 0
			}))
		};
	}
	/**
	* Start a cleanup and return at once; the card polls {@link state}.
	* A request that arrives while a restore scan or another cleanup holds the
	* lock is kept and runs when that pass finishes, so a confirmed retention
	* change is not dropped.
	*/
	startClean() {
		this.cleanPending = true;
		this.startQueuedClean();
	}
	/** Run one queued cleanup once the shared lock is free. */
	startQueuedClean() {
		if (this.cleaning || !this.cleanPending) return;
		this.cleanPending = false;
		this.cleaning = true;
		this.phase = "scanning";
		this.error = null;
		this.warning = "";
		this.warningSessions = 0;
		this.clean().catch((error) => {
			this.error = messageOf(error);
			this.log(`history cleanup failed: ${this.error}`);
		}).finally(() => {
			this.cleaning = false;
			this.phase = "";
			this.startQueuedClean();
		});
	}
	/**
	* Unpack every conversation folder that came back from the system trash.
	* Runs at startup and on a timer so Finder's Put Back takes effect without a restart.
	*/
	async restoreStaged() {
		if (this.cleaning) return;
		this.cleaning = true;
		this.phase = "restoring";
		try {
			let projects;
			try {
				projects = await readdir(this.deps.sessionsRoot, { withFileTypes: true });
			} catch {
				return;
			}
			for (const project of projects) {
				if (!project.isDirectory()) continue;
				let sessions;
				try {
					sessions = await readdir(join(this.deps.sessionsRoot, project.name), { withFileTypes: true });
				} catch {
					continue;
				}
				for (const session of sessions) {
					if (!session.isDirectory()) continue;
					const dir = join(this.deps.sessionsRoot, project.name, session.name);
					const marker = join(dir, MARKER);
					if (!existsSync(join(marker, MARKER_MANIFEST))) continue;
					try {
						await this.recoverMarker(dir, marker);
					} catch (error) {
						this.log(`could not restore a conversation from ${dir}: ${messageOf(error)}`);
					}
				}
			}
		} finally {
			this.cleaning = false;
			this.phase = "";
			this.startQueuedClean();
		}
	}
	/** Schedule the restore scan and the daily retention check. */
	start() {
		this.restoreStaged();
		this.restoreTimer = setInterval(() => {
			this.restoreStaged();
		}, HISTORY_RESTORE_INTERVAL_MS);
		this.restoreTimer.unref();
		this.timer = setTimeout(() => {
			this.timer = void 0;
			this.startClean();
		}, HISTORY_FIRST_CHECK_MS);
		this.timer.unref();
		this.interval = setInterval(() => {
			this.startClean();
		}, HISTORY_INTERVAL_MS);
		this.interval.unref();
		return () => {
			if (this.timer !== void 0) clearTimeout(this.timer);
			if (this.interval !== void 0) clearInterval(this.interval);
			if (this.restoreTimer !== void 0) clearInterval(this.restoreTimer);
			this.timer = void 0;
			this.interval = void 0;
			this.restoreTimer = void 0;
		};
	}
	available() {
		try {
			return this.deps.available();
		} catch {
			return false;
		}
	}
	assertAvailable() {
		if (!this.available()) throw new HistoryUnavailableError("history-unavailable");
	}
	/** Plan one run. Preview skips the live-reference scan; cleanup needs it. */
	async plan(days) {
		const persistence = this.deps.persistence();
		if (persistence === void 0) throw new HistoryUnavailableError("history-unavailable");
		const cutoff = this.now() - days * DAY_MS;
		const [snapshots, rows, safety] = await Promise.all([
			persistence.list({ signal: AbortSignal.timeout(3e4) }),
			this.deps.listSessions(),
			this.deps.workspaceSafety()
		]);
		const rowById = new Map(rows.map((row) => [row.sessionId, row]));
		const snapshotById = new Map(snapshots.map((snapshot) => [snapshot.header.id, snapshot]));
		const pinned = new Set(safety.pinned);
		const archived = new Set(safety.archived);
		const restored = new Set(this.deps.store.history().restoredSessionIds);
		const children = /* @__PURE__ */ new Map();
		const addChild = (parent, id, origin) => {
			if (parent === void 0 || origin !== "subagent") return;
			const set = children.get(parent);
			if (set === void 0) children.set(parent, /* @__PURE__ */ new Set([id]));
			else set.add(id);
		};
		for (const snapshot of snapshots) addChild(snapshot.header.parentSession, snapshot.header.id, snapshot.header.origin);
		for (const row of rows) addChild(row.parentSessionId, row.sessionId, row.origin);
		const skipped = emptySkips();
		const trees = [];
		const workspace = resolve(this.deps.workspacePath());
		for (const row of rows) {
			if (!isOrbRoot(row, workspace)) continue;
			if (row.updatedAt === void 0 || !Number.isFinite(row.updatedAt) || row.updatedAt <= 0) {
				skipped.unchanged += 1;
				continue;
			}
			if (row.updatedAt >= cutoff) {
				skipped.unchanged += 1;
				continue;
			}
			const tree = await this.candidateTree(row, children, rowById, snapshotById, pinned, archived, restored, cutoff, skipped);
			if (tree !== void 0) trees.push(tree);
		}
		const readable = [];
		for (const tree of trees) try {
			readable.push(await this.readCandidate(tree));
		} catch (error) {
			skipped.unreadable += 1;
			this.log(`history cleanup skipped ${tree.root.sessionId}: ${messageOf(error)}`);
		}
		const images = /* @__PURE__ */ new Map();
		let logBytes = 0;
		for (const tree of readable) {
			logBytes += tree.logBytes;
			for (const [id, bytes] of tree.images) images.set(id, bytes);
		}
		return {
			cutoff,
			trees: readable,
			images,
			logBytes,
			skipped
		};
	}
	/** Resolve one root plus its subagent descendants, skipping anything protected. */
	async candidateTree(root, children, rowById, snapshotById, pinned, archived, restored, cutoff, skipped) {
		const members = [];
		const sessions = /* @__PURE__ */ new Map();
		const pending = [root.sessionId];
		const seen = /* @__PURE__ */ new Set();
		let newest = 0;
		let oldest = Number.POSITIVE_INFINITY;
		while (pending.length > 0) {
			const id = pending.pop();
			if (id === void 0 || seen.has(id)) continue;
			seen.add(id);
			const row = rowById.get(id);
			if (row === void 0) {
				skipped.unchanged += 1;
				return;
			}
			if (pinned.has(id)) {
				skipped.pinned += 1;
				return;
			}
			if (archived.has(id)) {
				skipped.archived += 1;
				return;
			}
			if (restored.has(id)) {
				skipped.restored += 1;
				return;
			}
			if (this.deps.currentSession() === id) {
				skipped.current += 1;
				return;
			}
			if (row.running === true || this.deps.isAttached(id)) {
				skipped.active += 1;
				return;
			}
			if (row.updatedAt === void 0 || !Number.isFinite(row.updatedAt) || row.updatedAt <= 0) {
				skipped.unchanged += 1;
				return;
			}
			if (row.updatedAt >= cutoff) {
				skipped.unchanged += 1;
				return;
			}
			const snapshot = snapshotById.get(id);
			if (snapshot === void 0) {
				skipped.unchanged += 1;
				return;
			}
			members.push(row);
			sessions.set(id, snapshot);
			newest = Math.max(newest, row.updatedAt);
			oldest = Math.min(oldest, row.updatedAt);
			for (const child of children.get(id) ?? []) pending.push(child);
		}
		const dirs = /* @__PURE__ */ new Map();
		for (const member of members) {
			const dir = await this.sessionDirectory(member.sessionId, sessions.get(member.sessionId));
			if (dir === void 0) {
				skipped.unreadable += 1;
				return;
			}
			dirs.set(member.sessionId, dir);
		}
		return {
			root,
			members,
			sessions,
			dirs,
			images: /* @__PURE__ */ new Map(),
			logBytes: 0,
			newest,
			oldest
		};
	}
	/** Read one candidate tree's events, image ids, and physical log bytes. */
	async readCandidate(tree) {
		const persistence = this.persistenceOrThrow();
		const images = /* @__PURE__ */ new Map();
		let logBytes = 0;
		for (const member of tree.members) {
			const snapshot = tree.sessions.get(member.sessionId);
			if (snapshot === void 0) throw new Error(`session ${member.sessionId} disappeared`);
			const statted = await persistence.stat(member.sessionId, { signal: AbortSignal.timeout(15e3) });
			logBytes += statted?.sizeBytes ?? snapshot.sizeBytes ?? 0;
			const handle = await persistence.open(member.sessionId, "read");
			try {
				const read = await handle.read();
				for (const id of structuredImageIds(read.events ?? [])) {
					if (images.has(id)) continue;
					images.set(id, await this.objectSize(id));
				}
			} finally {
				await handle.close().catch(() => void 0);
			}
		}
		return {
			...tree,
			images,
			logBytes
		};
	}
	async clean() {
		const days = this.deps.store.history().retentionDays;
		if (days <= 0) return;
		this.assertAvailable();
		this.phase = "planning";
		const plan = await this.plan(days);
		if (plan.trees.length === 0) return;
		const persistence = this.persistenceOrThrow();
		const deleting = new Set(plan.trees.flatMap((tree) => tree.members.map((member) => member.sessionId)));
		const workspace = resolve(this.deps.workspacePath());
		const live = await this.liveReferences(persistence, deleting, workspace);
		if (live.incomplete) {
			this.warning = "images-kept";
			this.warningSessions = live.unreadable;
		}
		const owners = /* @__PURE__ */ new Map();
		for (const tree of plan.trees) for (const id of tree.images.keys()) {
			const set = owners.get(id);
			if (set === void 0) owners.set(id, /* @__PURE__ */ new Set([tree.root.sessionId]));
			else set.add(tree.root.sessionId);
		}
		this.phase = "archiving";
		let deleted = 0;
		let bytes = 0;
		const failures = [];
		for (const tree of plan.trees) {
			const images = /* @__PURE__ */ new Map();
			if (!live.incomplete) for (const [id, size] of tree.images) {
				if (live.refs.has(id)) continue;
				if ((owners.get(id)?.size ?? 0) !== 1) continue;
				images.set(id, size);
			}
			const outcome = await this.trashTree(tree, images);
			if (outcome.ok) {
				deleted += outcome.sessions;
				bytes += outcome.bytes;
			} else failures.push(tree.root.sessionId);
		}
		if (deleted > 0) this.deps.store.setHistoryRecord({
			lastCleanupAt: this.now(),
			lastDeletedSessions: deleted,
			lastMovedBytes: bytes
		});
		if (failures.length > 0) throw new Error(`os-trash-failed:${String(failures.length)}`);
		this.error = null;
	}
	/**
	* Move conversations that never got a message to the operating system's trash.
	*
	* Every New Chat press used to mint a Session, so a profile that pressed it a few times carries
	* a pile of empty "untitled" rows. Neither window shows them again — the main window draws only
	* the selected blank, the ball now hides the rest — so what is left is to take them out of the
	* store once. Everything a window could be using is spared: the current conversation, anything
	* with an attached Agent, pinned or archived rows, and anything touched inside the grace window
	* (a draft someone is typing into).
	*
	* @param options.graceMs - how recently a blank must have been touched to be left alone.
	* @param options.limit - hard cap for one pass, so a backlog cannot hold the start path.
	* @returns how many conversations were moved to the trash.
	*/
	async sweepBlanks(options = {}) {
		if (!this.available()) throw new HistoryUnavailableError("history-unavailable");
		if (this.cleaning) throw new Error("history-busy");
		const now = this.now();
		const grace = options.graceMs ?? 3e5;
		const limit = options.limit ?? 60;
		const workspace = resolve(this.deps.workspacePath());
		const [rows, safety] = await Promise.all([this.deps.listSessions(), this.deps.workspaceSafety()]);
		const pinned = new Set(safety.pinned);
		const archived = new Set(safety.archived);
		let swept = 0;
		for (const row of rows) {
			if (swept >= limit) break;
			if (row.blank !== true || row.running === true) continue;
			if (!isOrbRoot(row, workspace)) continue;
			if (pinned.has(row.sessionId) || archived.has(row.sessionId)) continue;
			if (this.deps.currentSession() === row.sessionId) continue;
			if (this.deps.isAttached(row.sessionId)) continue;
			if (typeof row.updatedAt !== "number" || !Number.isFinite(row.updatedAt) || row.updatedAt <= 0) continue;
			if (now - row.updatedAt < grace) continue;
			const dir = await this.sessionDirectory(row.sessionId, void 0);
			if (dir === void 0) {
				this.log(`blank sweep skipped ${row.sessionId}: its directory could not be located`);
				continue;
			}
			const tree = {
				root: row,
				members: [row],
				sessions: /* @__PURE__ */ new Map(),
				dirs: /* @__PURE__ */ new Map([[row.sessionId, dir]]),
				images: /* @__PURE__ */ new Map(),
				logBytes: 0,
				newest: row.updatedAt,
				oldest: row.updatedAt
			};
			try {
				if ((await this.trashTree(tree, /* @__PURE__ */ new Map())).ok) swept += 1;
			} catch (error) {
				this.log(`blank sweep skipped ${row.sessionId}: ${messageOf(error)}`);
			}
		}
		this.phase = "";
		if (swept > 0) this.log(`blank sweep moved ${swept} empty conversation(s) to the system trash`);
		return swept;
	}
	/** Pack one conversation tree into its root directory and hand that directory to the OS trash. */
	async trashTree(tree, images) {
		const rootDir = tree.dirs.get(tree.root.sessionId);
		if (rootDir === void 0) return {
			ok: false,
			sessions: 0,
			bytes: 0
		};
		const marker = join(rootDir, MARKER);
		if (existsSync(marker)) {
			this.log(`history cleanup skipped ${tree.root.sessionId}: it already has a pending restore marker`);
			return {
				ok: false,
				sessions: 0,
				bytes: 0
			};
		}
		const movedImages = [...images.keys()].filter((id) => existsSync(this.objectPath(id)));
		let manifest = {
			version: 1,
			rootId: tree.root.sessionId,
			createdAt: this.now(),
			workspace: resolve(this.deps.workspacePath()),
			sessions: tree.members.map((member) => ({
				id: member.sessionId,
				dir: tree.dirs.get(member.sessionId)
			})),
			images: movedImages.map((id) => ({ id })),
			archived: tree.members.map((member) => member.sessionId)
		};
		try {
			await this.writeMarker(marker, manifest);
		} catch (error) {
			this.log(`history cleanup could not stage ${tree.root.sessionId}: ${messageOf(error)}`);
			return {
				ok: false,
				sessions: 0,
				bytes: 0
			};
		}
		if (!await this.archiveTree(tree)) {
			await rm(marker, {
				recursive: true,
				force: true
			}).catch(() => void 0);
			return {
				ok: false,
				sessions: 0,
				bytes: 0
			};
		}
		try {
			for (const member of tree.members) {
				if (member.sessionId === tree.root.sessionId) continue;
				const from = tree.dirs.get(member.sessionId);
				if (!existsSync(from)) throw new Error(`session directory ${member.sessionId} disappeared`);
				await movePath(from, join(marker, "sessions", member.sessionId));
			}
			for (const id of movedImages) await movePath(this.objectPath(id), join(marker, "objects", objectRelative(id)));
		} catch (error) {
			this.log(`history cleanup could not pack ${tree.root.sessionId}: ${messageOf(error)}`);
			await this.unpackMarker(rootDir, marker, manifest);
			return {
				ok: false,
				sessions: 0,
				bytes: 0
			};
		}
		try {
			manifest = {
				...manifest,
				trashed: true
			};
			await this.writeMarker(marker, manifest);
		} catch (error) {
			this.log(`history cleanup could not mark ${tree.root.sessionId}: ${messageOf(error)}`);
			await this.unpackMarker(rootDir, marker, manifest);
			return {
				ok: false,
				sessions: 0,
				bytes: 0
			};
		}
		this.phase = "trashing";
		try {
			await this.deps.trash(rootDir);
		} catch (error) {
			this.log(`history cleanup could not move ${tree.root.sessionId} to the system trash: ${messageOf(error)}`);
			await this.unpackMarker(rootDir, marker, manifest);
			return {
				ok: false,
				sessions: 0,
				bytes: 0
			};
		}
		const bytes = tree.logBytes + movedImages.reduce((sum, id) => sum + (images.get(id) ?? 0), 0);
		return {
			ok: true,
			sessions: tree.members.length,
			bytes
		};
	}
	/** Move packed children/images back into their original paths and unarchive the tree. */
	async unpackMarker(rootDir, marker, manifest) {
		let complete = true;
		for (const session of manifest.sessions) {
			if (session.id === manifest.rootId) continue;
			if (!isSessionId(session.id) || !isUnder(this.deps.sessionsRoot, session.dir)) {
				this.log(`history restore skipped an unsafe session entry ${String(session.id)}`);
				complete = false;
				continue;
			}
			const from = join(marker, "sessions", session.id);
			if (!existsSync(from)) {
				if (!existsSync(session.dir)) complete = false;
				continue;
			}
			if (existsSync(session.dir)) continue;
			try {
				await mkdir(dirname(session.dir), { recursive: true });
				await movePath(from, session.dir);
			} catch (error) {
				this.log(`history restore could not move ${session.id}: ${messageOf(error)}`);
				complete = false;
			}
		}
		for (const image of manifest.images) {
			if (!isImageId(image.id)) {
				this.log(`history restore skipped an unsafe image entry ${String(image.id)}`);
				complete = false;
				continue;
			}
			const from = join(marker, "objects", objectRelative(image.id));
			if (!existsSync(from)) {
				if (!existsSync(this.objectPath(image.id))) complete = false;
				continue;
			}
			const target = this.objectPath(image.id);
			if (existsSync(target)) continue;
			try {
				await mkdir(dirname(target), { recursive: true });
				await movePath(from, target);
			} catch (error) {
				this.log(`history restore could not move ${image.id}: ${messageOf(error)}`);
				complete = false;
			}
		}
		if (!complete) {
			this.log(`history restore for ${rootDir} is incomplete; its marker stays for the next scan`);
			return false;
		}
		for (const id of manifest.archived) await this.deps.unarchive(id).catch((error) => this.log(`history restore could not unarchive ${id}: ${messageOf(error)}`));
		await rm(marker, {
			recursive: true,
			force: true
		});
		return true;
	}
	async recoverMarker(rootDir, marker) {
		const manifest = await this.readMarker(marker);
		if (manifest === void 0) {
			this.log(`history restore skipped ${marker}: unreadable manifest`);
			return;
		}
		if (manifest.rootId !== basename(rootDir)) {
			this.log(`history restore skipped ${marker}: marker does not belong to its directory`);
			return;
		}
		if (!isUnder(this.deps.sessionsRoot, rootDir)) {
			this.log(`history restore skipped ${rootDir}: outside the sessions root`);
			return;
		}
		if (await this.unpackMarker(rootDir, marker, manifest) && manifest.trashed === true) this.protect(manifest.archived);
	}
	/** A manual system-trash restore is a keep decision; skip these in future runs. */
	protect(ids) {
		const history = this.deps.store.history();
		const merged = [.../* @__PURE__ */ new Set([...history.restoredSessionIds, ...ids])].slice(-1e3);
		this.deps.store.setHistoryRecord({ restoredSessionIds: merged });
	}
	/**
	* Collect every image id still referenced by a session that stays.
	* An unreadable session outside the orb workspace (a legacy v0 log, for example)
	* cannot own an orb screenshot in practice; ignoring it lets the cleanup proceed.
	* An unreadable orb session is unknown, so no image object is moved in that run.
	*/
	async liveReferences(persistence, deleting, workspace) {
		const refs = /* @__PURE__ */ new Set();
		let incomplete = false;
		let unreadable = 0;
		for (const snapshot of await persistence.list({ signal: AbortSignal.timeout(3e4) })) {
			if (deleting.has(snapshot.header.id)) continue;
			try {
				const handle = await persistence.open(snapshot.header.id, "read");
				try {
					const read = await handle.read();
					for (const id of referencedImageIds(read.events ?? [])) refs.add(id);
				} finally {
					await handle.close().catch(() => void 0);
				}
			} catch (error) {
				const cwd = snapshot.header.cwd;
				if (cwd === void 0 || resolve(cwd) === workspace || isUnder(workspace, cwd)) {
					incomplete = true;
					unreadable += 1;
					this.log(`history cleanup could not read orb session ${snapshot.header.id}: ${messageOf(error)}`);
				} else this.log(`history cleanup ignored unreadable session ${snapshot.header.id} outside the orb workspace: ${messageOf(error)}`);
			}
		}
		return {
			refs,
			incomplete,
			unreadable
		};
	}
	async archiveTree(tree) {
		const archived = [];
		try {
			for (const member of tree.members) {
				await this.deps.archive(member.sessionId);
				archived.push(member.sessionId);
			}
			return true;
		} catch (error) {
			this.log(`history cleanup skipped ${tree.root.sessionId}: ${messageOf(error)}`);
			for (const id of archived.reverse()) await this.deps.unarchive(id).catch(() => void 0);
			return false;
		}
	}
	async sessionDirectory(id, snapshot) {
		const persistence = this.persistenceOrThrow();
		const header = snapshot?.header ?? (await persistence.stat(id, { signal: AbortSignal.timeout(15e3) }))?.header;
		if (header === void 0) return void 0;
		const located = persistence.locate?.(header);
		if (typeof located?.path === "string" && located.path !== "") {
			const dir = dirname(located.path);
			return isUnder(this.deps.sessionsRoot, dir) ? dir : void 0;
		}
		try {
			for (const project of await readdir(this.deps.sessionsRoot, { withFileTypes: true })) {
				if (!project.isDirectory()) continue;
				const candidate = join(this.deps.sessionsRoot, project.name, id);
				if (!isUnder(this.deps.sessionsRoot, candidate)) continue;
				try {
					if (statSync(candidate).isDirectory()) return candidate;
				} catch {}
			}
		} catch {
			return;
		}
	}
	objectPath(id) {
		const hex = id.slice(7);
		return join(this.deps.objectsRoot, hex.slice(0, 2), hex);
	}
	async objectSize(id) {
		try {
			return (await stat(this.objectPath(id))).size;
		} catch {
			return 0;
		}
	}
	persistenceOrThrow() {
		const persistence = this.deps.persistence();
		if (persistence === void 0) throw new HistoryUnavailableError("history-unavailable");
		return persistence;
	}
	async writeMarker(marker, manifest) {
		await mkdir(join(marker, "sessions"), {
			recursive: true,
			mode: 448
		});
		await mkdir(join(marker, "objects"), {
			recursive: true,
			mode: 448
		});
		const file = join(marker, MARKER_MANIFEST);
		const staged = `${file}.tmp`;
		await writeFile(staged, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 384 });
		await rename(staged, file);
	}
	async readMarker(marker) {
		try {
			const parsed = JSON.parse(await readFile(join(marker, MARKER_MANIFEST), "utf8"));
			if (parsed.version !== 1 || typeof parsed.rootId !== "string" || !Array.isArray(parsed.sessions) || !Array.isArray(parsed.images)) return void 0;
			return parsed;
		} catch {
			return;
		}
	}
	now() {
		return this.deps.now?.() ?? Date.now();
	}
	log(message) {
		(this.deps.log ?? ((line) => console.error(`dsh-orb: ${line}`)))(message);
	}
};
/** Roots the ball's history shows: the workspace itself, an ordinary preset, not a subagent. */
function isOrbRoot(row, workspace) {
	if (row.origin === "subagent") return false;
	if (typeof row.cwd !== "string" || resolve(row.cwd) !== resolve(workspace)) return false;
	const preset = row.projections?.values?.agentPreset;
	return preset === void 0 || preset === "computer-use";
}
/** Image ids carried by structured ImageBlocks in persisted events. */
function structuredImageIds(events) {
	const ids = /* @__PURE__ */ new Set();
	visit(events, (value) => {
		if (typeof value.attachmentId !== "string" || !isImageId(value.attachmentId)) return;
		ids.add(value.attachmentId);
	});
	return ids;
}
/**
* All `sha256:` ids in a session, including text placeholders left by image offload.
* Used for remaining sessions so a conservative read never misses an id.
*/
function referencedImageIds(events) {
	const ids = /* @__PURE__ */ new Set();
	const text = JSON.stringify(events);
	for (const match of text.matchAll(SHA256_REF)) ids.add(match[0]);
	return ids;
}
function visit(value, onRecord) {
	if (Array.isArray(value)) {
		for (const item of value) visit(item, onRecord);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	const record = value;
	onRecord(record);
	for (const item of Object.values(record)) visit(item, onRecord);
}
function emptySkips() {
	return {
		active: 0,
		pinned: 0,
		archived: 0,
		current: 0,
		unchanged: 0,
		unreadable: 0,
		restored: 0
	};
}
function isImageId(id) {
	return /^sha256:[0-9a-f]{64}$/.test(id);
}
function isSessionId(id) {
	return /^[A-Za-z0-9._-]+$/.test(id) && !id.includes("..");
}
function objectRelative(id) {
	const hex = id.slice(7);
	return join(hex.slice(0, 2), hex);
}
function isUnder(root, path) {
	const rel = relative(resolve(root), resolve(path));
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
async function movePath(from, to) {
	await mkdir(dirname(to), { recursive: true });
	let last;
	for (let attempt = 0; attempt < MOVE_ATTEMPTS; attempt += 1) try {
		await rename(from, to);
		return;
	} catch (error) {
		last = error;
		const code = error.code;
		if (code !== "EXDEV") {
			if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") throw error;
			await new Promise((resolve) => setTimeout(resolve, MOVE_BACKOFF_MS));
			continue;
		}
		await cp(from, to, {
			recursive: true,
			errorOnExist: true,
			force: false
		});
		await rm(from, {
			recursive: true,
			force: true
		});
		return;
	}
	throw last;
}
function messageOf(error) {
	return error instanceof Error && error.message !== "" ? error.message : String(error);
}
//#endregion
//#region ../voice/src/manifest.ts
const WAKE_MODEL_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20.tar.bz2";
/**
* The wake files also ship as their own npm package (`models/kws` at the repository root),
* so a download is an 8.6 MB registry fetch instead of a 31 MB GitHub release.
*
* The version and the digest are pinned: the registry is immutable, so one tarball stays
* valid forever, and the same bytes answer from the mirror and from npmjs.
*/
const WAKE_MODEL_PACKAGE = "dsh-orb-kws";
const WAKE_MODEL_PACKAGE_VERSION = "2026.10.0";
const WAKE_MODEL_SHA256 = "23d4055c0c20b9d440ab47aa05965780aba01e6852a2182987cca479ea91e9d3";
/** hf-mirror's counterpart for npm: the only registry origin that is fast from mainland China. */
const WAKE_MODEL_NPM_MIRROR = `https://registry.npmmirror.com/${WAKE_MODEL_PACKAGE}/-/${WAKE_MODEL_PACKAGE}-${WAKE_MODEL_PACKAGE_VERSION}.tgz`;
const WAKE_MODEL_NPM_OFFICIAL = `https://registry.npmjs.org/${WAKE_MODEL_PACKAGE}/-/${WAKE_MODEL_PACKAGE}-${WAKE_MODEL_PACKAGE_VERSION}.tgz`;
/** What the mirror serves, and what the progress bar divides by: 8.6 MB. */
const WAKE_MODEL_BYTES = 9024132;
/**
* The Matcha engines and their vocoder are fetched file by file from the
* Hugging Face Hub. A commit's tree is immutable, but `main` is a moving ref:
* upstream produced three different digests for the same filename in ten days
* (see docs/04-addenda.md), and a fresh install kept downloading bytes the
* pinned list had never seen. Every URL therefore resolves a pinned
* commit, never `main`, so the digests below stay valid and the domestic
* mirror serves the same bytes as huggingface.co. `hf-mirror` goes first
* because GitHub is unreachable from mainland China while that mirror runs at
* several MB/s there.
*
* Bumping a revision is a deliberate release step: change the commit here,
* update the accepted digests if the file changed, and smoke-test synthesis.
* Never point these at `main` again.
*/
const TTS_ZH_REPO = "csukuangfj/matcha-icefall-zh-baker";
const TTS_EN_REPO = "csukuangfj/matcha-icefall-en_US-ljspeech";
const TTS_VOCODER_REPO = "k2-fsa/sherpa-onnx-models";
/**
* The 2026-10-24 builds, the same files a working local install already has.
* Verified through hf-mirror: `resolve/<commit>/model-steps-3.onnx` returns
* these exact digests. The 2026-10-29 re-export of the Chinese model
* (`78a9fd17…`) is deliberately not used until it has been smoke-tested.
*/
const TTS_ZH_REVISION = "4ddc32d1724e5ea167116096b860de07b8dcb781";
const TTS_EN_REVISION = "be5535c9e754d0dfd3ab66dac34f78c5b5d66d50";
const TTS_VOCODER_REVISION = "bee11a0c31f3054fa7e73752e59f50d1e05340af";
const TTS_ORIGINS = ["https://hf-mirror.com", "https://huggingface.co"];
/**
* Every legitimate digest of the acoustic model. Upstream re-exports the
* Matcha packages without renaming them, so several builds exist in the wild:
* the older one inside an already installed folder, the pinned one a fresh
* download now gets. Accepting both keeps an existing install valid and lets
* a fresh download pass. A digest is added only after that build has been
* verified; it is not a substitute for pinning the revision.
*/
const TTS_ZH_MODEL_SHA256 = ["47e82b11454edeeb65adc4e44a24fd54c6715cd4d875cc2a20f75545ecc32d4d", "ff1cc7f7abdedc4eeec668a4a0dc2e72a0c314c5637d5fce885345b490bd08de"];
const TTS_EN_MODEL_SHA256 = ["f8e8bae6f731310a1cda0012871ed5e91b0d19f1e2ceff077f62922bba95e3c1", "4d7771c0ec063ca74f2fa92ba0ecfe14f73fa3f61c236d9469b92e102d8e9574"];
const TTS_VOCODER_SHA256 = ["0574a135aa1db2de6e181050db2ec528496cacd4a4701fc5d7faf9f9804c0081"];
/** On-disk size the download dialog shows: about 197 MB. */
const TTS_MODEL_BYTES = 206100276;
/** Official SenseVoice int8 trio: model + tokens + silero. The dialog says about 230 MB. */
const ASR_MODEL_BYTES = 241357257;
const ASR_SOURCES = ["https://huggingface.co", "https://hf-mirror.com"];
/** What the settings page shows before any model file is on disk. */
function absentVoiceModels() {
	return {
		wake: view([WAKE_MODEL_NPM_MIRROR, WAKE_MODEL_NPM_OFFICIAL], WAKE_MODEL_BYTES),
		tts: view([
			`${TTS_ORIGINS[0]}/${TTS_ZH_REPO}`,
			`${TTS_ORIGINS[0]}/${TTS_EN_REPO}`,
			`${TTS_ORIGINS[0]}/${TTS_VOCODER_REPO}`
		], TTS_MODEL_BYTES),
		asr: view(ASR_SOURCES, ASR_MODEL_BYTES)
	};
}
function view(sources, bytes) {
	return {
		present: false,
		downloading: false,
		progress: 0,
		sources,
		bytes,
		error: ""
	};
}
//#endregion
//#region src/whats-new.ts
/**
* The one release note the settings page shows after installing or upgrading to this build.
*
* A note belongs to one exact version. The settings page only offers it when the installed
* package reports that version, so a later release that forgets to replace this constant does
* not show a stale note to its users. Each version keeps its own dismissal marker; adding a
* note for a new release means bumping both this value and the client copy.
*/
const WHATS_NEW_VERSION = "0.2.0";
/**
* Whether the settings page should offer the release note.
*
* @param supported - the ball exists on this platform (macOS or Windows).
* @param currentVersion - the installed bundle's version, empty when the layout is unknown.
* @param dismissed - the profile already closed this exact note.
* @returns the note to render, or null when any of the three gates says no.
*/
function visibleWhatsNew(supported, currentVersion, dismissed) {
	if (!supported || currentVersion !== "0.2.0" || dismissed) return null;
	return {
		id: WHATS_NEW_VERSION,
		version: WHATS_NEW_VERSION
	};
}
//#endregion
//#region src/routes.ts
/**
* Settings routes on the official web port.
* The main window calls these with a relative fetch, so the existing login cookie is enough.
* The helper may read only the avatar, and only with its socket token.
*/
const PREFIX = "/.dsh-orb";
const HELPER_HEADER = "x-dsh-orb-helper";
/** Mount `/.dsh-orb` and return the disposer. */
function registerOrbRoutes(deps) {
	return deps.ctx.webServer.register({
		kind: "prefix",
		path: PREFIX,
		handler: (req, res) => handle(deps, req, res).catch((error) => {
			if (res.headersSent) {
				res.end();
				return;
			}
			const status = errorStatus(error) ?? 500;
			if (status === 500) console.error(`dsh-orb: route failed: ${error instanceof Error ? error.message : String(error)}`);
			sendJson(res, status, { error: status === 500 ? "internal-error" : errorMessage(error) });
		})
	});
}
/** A status a rejected route asked for: `readBody` sets 413, `readJson` sets 400. */
function errorStatus(error) {
	const status = error?.status;
	return typeof status === "number" && status >= 400 && status < 600 ? status : void 0;
}
function historyAvailable$1(deps) {
	try {
		return deps.control.historyState?.().available === true && typeof deps.control.setHistoryRetention === "function" && typeof deps.control.previewHistory === "function" && typeof deps.control.cleanHistory === "function";
	} catch {
		return false;
	}
}
function errorMessage(error) {
	return error instanceof Error && error.message !== "" ? error.message : "request-failed";
}
function workspaceErrorStatus(error) {
	const code = errorMessage(error);
	if (code === "workspace-running" || code === "workspace-unavailable" || code === "workspace-picker-unavailable") return 409;
	if (code === "workspace-create-failed" || code === "workspace-picker-failed") return 500;
	if (code.startsWith("workspace-")) return 400;
	return 500;
}
function orbSupported(platform = process.platform) {
	return platform === "darwin" || platform === "win32";
}
async function handle(deps, req, res) {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	const path = url.pathname;
	if (!(req.method === "GET" && (path === `${PREFIX}/avatar` || path === `${PREFIX}/attachment`) && helperTokenOk(deps, req))) {
		const rejection = rejectionStatus(deps.ctx, req);
		if (rejection !== void 0) {
			res.writeHead(rejection);
			res.end();
			return;
		}
	}
	const method = req.method ?? "GET";
	if (path === `${PREFIX}/companion-settings` && (method === "GET" || method === "POST")) {
		try {
			const settings = method === "GET" ? await deps.control.companionSettings.read()
				: await deps.control.companionSettings.save(await readJson(req));
			sendJson(res, 200, settings);
		} catch (error) { sendJson(res, 400, { error: error.message }); }
		return;
	}
	// 状态面板：GET 是**纯读**（不建段、不启桥、不读 cookies、不调用付费模型或 ASR），
	// 前端可以每 2-3 秒问一次；控制走 POST，由 companion-status 里的串行队列执行。
	if (path === `${PREFIX}/companion-status` && method === "GET") {
		if (typeof deps.control.companionStatus !== "function") {
			sendJson(res, 503, { error: "companion-unavailable" });
			return;
		}
		try {
			sendJson(res, 200, await deps.control.companionStatus());
		} catch (error) {
			sendJson(res, 500, { error: errorMessage(error) });
		}
		return;
	}
	if (path === `${PREFIX}/companion-control` && method === "POST") {
		if (typeof deps.control.companionControl !== "function") {
			sendJson(res, 503, { error: "companion-unavailable" });
			return;
		}
		try {
			sendJson(res, 200, await deps.control.companionControl(await readJson(req)));
		} catch (error) {
			// `status` 带回最新快照：409 时前端能立刻用真实状态覆盖乐观显示，不必等下一拍轮询。
			sendJson(res, errorStatus(error) ?? 400, {
				error: errorMessage(error),
				code: error?.code ?? null,
				status: error?.payload ?? null
			});
		}
		return;
	}
	// 角色卡：一张全局人设 + 可选的"指导单独的"人设。文本上限与格式校验在 character-card.js 里，
	// 这里只做 HTTP。保存后进程内缓存立刻生效（面板、陪伴、指导下次调用就带上新卡）。
	if (path === `${PREFIX}/character` && (method === "GET" || method === "POST")) {
		if (typeof deps.control.characterSettings !== "object" || deps.control.characterSettings === null) {
			sendJson(res, 503, { error: "character-unavailable" });
			return;
		}
		try {
			const card = method === "GET"
				? await deps.control.characterSettings.read()
				: await deps.control.characterSettings.save(await readJson(req));
			sendJson(res, 200, card);
		} catch (error) {
			sendJson(res, 400, { error: errorMessage(error) });
		}
		return;
	}
	if (method === "GET" && path === `${PREFIX}/settings`) {
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "GET" && path === `${PREFIX}/models`) {
		sendJson(res, 200, await catalog(deps));
		return;
	}
	if (method === "GET" && path === `${PREFIX}/tcc`) {
		sendJson(res, 200, deps.tcc.status());
		return;
	}
	if (method === "GET" && path === `${PREFIX}/update`) {
		sendJson(res, 200, deps.control.updateState());
		return;
	}
	if (method === "POST" && path === `${PREFIX}/update/check`) {
		await deps.control.checkUpdate();
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "POST" && path === `${PREFIX}/update/install`) {
		const builds = stringListField(await readJson(req), "approvedBuilds");
		deps.control.installUpdate(builds);
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "POST" && path === `${PREFIX}/update/auto`) {
		const enabled = booleanField(await readJson(req));
		if (enabled === void 0) {
			sendJson(res, 400, { error: "invalid-auto-check" });
			return;
		}
		deps.control.setAutoCheck(enabled);
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "POST" && path === `${PREFIX}/whats-new/dismiss`) {
		if (asRecord$2(await readJson(req))?.id !== "0.2.0") {
			sendJson(res, 400, { error: "invalid-whats-new" });
			return;
		}
		deps.store.dismissWhatsNew(WHATS_NEW_VERSION);
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "GET" && path === `${PREFIX}/history`) {
		sendJson(res, 200, deps.control.historyState?.() ?? EMPTY_HISTORY_STATE);
		return;
	}
	if (method === "POST" && path === `${PREFIX}/history/retention`) {
		const days = integerField(await readJson(req), "days");
		if (!historyAvailable$1(deps) || days === void 0 || !isHistoryRetentionDays(days)) {
			sendJson(res, historyAvailable$1(deps) ? 400 : 409, { error: historyAvailable$1(deps) ? "invalid-retention" : "history-unavailable" });
			return;
		}
		deps.control.setHistoryRetention?.(days);
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "POST" && path === `${PREFIX}/history/preview`) {
		const days = integerField(await readJson(req), "days");
		if (!historyAvailable$1(deps) || days === void 0 || !isHistoryRetentionDays(days)) {
			sendJson(res, historyAvailable$1(deps) ? 400 : 409, { error: historyAvailable$1(deps) ? "invalid-retention" : "history-unavailable" });
			return;
		}
		sendJson(res, 200, { preview: await deps.control.previewHistory?.(days) });
		return;
	}
	if (method === "POST" && path === `${PREFIX}/history/clean`) {
		if (!historyAvailable$1(deps)) {
			sendJson(res, 409, { error: "history-unavailable" });
			return;
		}
		deps.control.cleanHistory?.();
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "POST" && path === `${PREFIX}/workspace/pick`) {
		if (typeof deps.control.pickWorkspaceDirectory !== "function") {
			sendJson(res, 409, { error: "workspace-picker-unavailable" });
			return;
		}
		const controller = new AbortController();
		const onClose = () => {
			if (!res.writableEnded) controller.abort();
		};
		res.on("close", onClose);
		try {
			const picked = await deps.control.pickWorkspaceDirectory(controller.signal);
			if (!res.writableEnded && !res.destroyed) sendJson(res, 200, { path: picked ?? null });
		} catch (error) {
			if (!res.writableEnded && !res.destroyed) sendJson(res, workspaceErrorStatus(error), { error: errorMessage(error) });
		} finally {
			res.off("close", onClose);
		}
		return;
	}
	if (method === "POST" && path === `${PREFIX}/workspace`) {
		if (typeof deps.control.setWorkspaceDirectory !== "function" || typeof deps.control.workspaceState !== "function") {
			sendJson(res, 409, { error: "workspace-unavailable" });
			return;
		}
		const next = asRecord$2(await readJson(req))?.path;
		if (typeof next !== "string" || next.trim() === "" || next.length > 4096) {
			sendJson(res, 400, { error: "workspace-invalid-path" });
			return;
		}
		try {
			await deps.control.setWorkspaceDirectory(next);
		} catch (error) {
			sendJson(res, workspaceErrorStatus(error), { error: errorMessage(error) });
			return;
		}
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "GET" && path === `${PREFIX}/jump`) {
		const target = deps.control.takeJump();
		sendJson(res, 200, {
			sessionId: target?.sessionId ?? null,
			at: target?.at ?? null
		});
		return;
	}
	if (method === "POST" && path === `${PREFIX}/jump`) {
		const sessionId = asRecord$2(await readJson(req))?.sessionId;
		if (typeof sessionId !== "string" || sessionId === "") {
			sendJson(res, 400, { error: "invalid-session" });
			return;
		}
		deps.control.confirmJump(sessionId);
		sendJson(res, 200, { ok: true });
		return;
	}
	if (method === "GET" && path === `${PREFIX}/settings-open`) {
		sendJson(res, 200, { at: deps.control.takeSettingsOpen()?.at ?? null });
		return;
	}
	if (method === "POST" && path === `${PREFIX}/settings-open`) {
		const at = asRecord$2(await readJson(req))?.at;
		if (typeof at !== "number" || !Number.isFinite(at)) {
			sendJson(res, 400, { error: "invalid-target" });
			return;
		}
		deps.control.confirmSettingsOpen(at);
		sendJson(res, 200, { ok: true });
		return;
	}
	if ((method === "GET" || method === "HEAD") && path === `${PREFIX}/avatar`) {
		await sendAvatar(deps.store, method, res);
		return;
	}
	if ((method === "GET" || method === "HEAD") && path === `${PREFIX}/attachment`) {
		await sendAttachment(deps, url, method, res);
		return;
	}
	if ((method === "GET" || method === "HEAD") && path.startsWith(`${PREFIX}/avatar/preset/`)) {
		const file = avatarPresetPath(decodeURIComponent(path.slice(`${PREFIX}/avatar/preset/`.length)));
		if (file === void 0 || !await sendFile(res, method, file, "image/gif")) {
			res.writeHead(404);
			res.end();
		}
		return;
	}
	if (!orbSupported()) {
		sendJson(res, 403, { error: "unsupported" });
		return;
	}
	if (method === "POST" && path === `${PREFIX}/overlay-model`) {
		const selection = selectionFrom(await readJson(req));
		if (selection === void 0) {
			sendJson(res, 400, { error: "invalid-model" });
			return;
		}
		await deps.control.setOverlayModel(selection);
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "POST" && path === `${PREFIX}/background-model`) {
		const selection = selectionFrom(await readJson(req));
		if (selection === void 0) {
			sendJson(res, 400, { error: "invalid-model" });
			return;
		}
		await deps.control.setBackgroundModel(selection);
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "POST" && path === `${PREFIX}/selection`) {
		const enabled = booleanField(await readJson(req));
		if (enabled === void 0) {
			sendJson(res, 400, { error: "invalid-selection" });
			return;
		}
		await deps.control.setSelectionEnabled(enabled);
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "POST" && path === `${PREFIX}/lasso-satellite`) {
		const patch = parseLassoBallPatch(await readJson(req));
		if (patch === void 0) {
			sendJson(res, 400, { error: "invalid-lasso" });
			return;
		}
		if (deps.control.setLassoConfig !== void 0) await deps.control.setLassoConfig(patch);
		else {
			if (patch.enabled !== void 0) deps.store.setLassoEnabled(patch.enabled);
			deps.store.setLassoBall(patch);
		}
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "POST" && path === `${PREFIX}/millifraction`) {
		const enabled = booleanField(await readJson(req));
		if (enabled === void 0) {
			sendJson(res, 400, { error: "invalid-millifraction" });
			return;
		}
		await deps.control.setMillifractionEnabled(enabled);
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "POST" && path === `${PREFIX}/observation-frame`) {
		const enabled = booleanField(await readJson(req));
		if (enabled === void 0) {
			sendJson(res, 400, { error: "invalid-observation-frame" });
			return;
		}
		await deps.control.setObservationFrameEnabled(enabled);
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "POST" && path === `${PREFIX}/ball`) {
		const enabled = booleanField(await readJson(req));
		if (enabled === void 0) {
			sendJson(res, 400, { error: "invalid-ball" });
			return;
		}
		await deps.control.setBallEnabled(enabled);
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "POST" && path === `${PREFIX}/runtime/redownload`) {
		if (typeof deps.control.redownloadRuntime !== "function") {
			sendJson(res, 404, { error: "unsupported" });
			return;
		}
		await deps.control.redownloadRuntime();
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "POST" && path === `${PREFIX}/avatar`) {
		const bytes = await readBody(req, 4194305).catch((error) => {
			if (error instanceof Error && error.message === "too-large") return void 0;
			throw error;
		});
		if (bytes === void 0 || bytes.length > 4194304) {
			sendJson(res, 413, { error: "too-large" });
			return;
		}
		const mime = sniffAvatarMime(bytes);
		if (mime === void 0) {
			sendJson(res, 400, { error: "invalid-type" });
			return;
		}
		deps.store.writeAvatar(bytes, mime);
		await deps.control.publishChrome();
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "POST" && path === `${PREFIX}/avatar/preset`) {
		const preset = asRecord$2(await readJson(req))?.preset;
		if (!isAvatarPresetId(preset)) {
			sendJson(res, 400, { error: "invalid-preset" });
			return;
		}
		deps.store.selectAvatarPreset(preset);
		await deps.control.publishChrome();
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "POST" && path === `${PREFIX}/avatar/restore`) {
		deps.store.restoreAvatar();
		await deps.control.publishChrome();
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "POST" && path === `${PREFIX}/voice/mic`) {
		await openMicrophoneSettings();
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "POST" && path === `${PREFIX}/voice`) {
		const saved = deps.store.setVoice(await readJson(req));
		await deps.control.applyVoiceSettings?.();
		sendJson(res, 200, await snapshot(deps, saved));
		return;
	}
	if (method === "POST" && path === `${PREFIX}/voice/download`) {
		const kind = asRecord$2(await readJson(req))?.kind;
		if (kind !== "wake" && kind !== "tts" && kind !== "asr") {
			sendJson(res, 400, { error: "invalid-voice-model" });
			return;
		}
		const current = await snapshot(deps);
		if (current.voiceModels[kind].downloading) {
			sendJson(res, 200, current);
			return;
		}
		const outcome = await deps.control.downloadVoiceModel?.(kind);
		const body = await snapshot(deps);
		if (outcome === "present") body.voiceModels[kind] = {
			...body.voiceModels[kind],
			notice: "present"
		};
		sendJson(res, 200, body);
		return;
	}
	if (method === "POST" && path === `${PREFIX}/tcc`) {
		const right = asRecord$2(await readJson(req))?.right;
		if (!isTccRight(right)) {
			sendJson(res, 400, { error: "invalid-tcc" });
			return;
		}
		await deps.tcc.open(right);
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	res.writeHead(404);
	res.end();
}
async function snapshot(deps, voice = deps.store.voice()) {
	const models = deps.store.models();
	const version = Math.trunc(deps.store.avatarVersion());
	const selection = deps.store.avatarSelection();
	const supported = orbSupported();
	const update = deps.control.updateState();
	return {
		supported,
		ballEnabled: deps.store.ballEnabled(),
		voice,
		voiceModels: deps.control.voiceModels?.() ?? absentVoiceModels(),
		qwenVoices: qwenVoiceViews(),
		voiceMic: deps.control.voiceMic?.() ?? null,
		avatarUrl: `${PREFIX}/avatar?v=${version}`,
		avatarPresetId: selection.kind === "preset" ? selection.id : null,
		avatarPresets: AVATAR_PRESETS.map((preset) => ({
			id: preset.id,
			url: `${PREFIX}/avatar/preset/${preset.id}`
		})),
		overlay: models.overlay,
		background: models.background,
		selectionEnabled: deps.store.selectionEnabled(),
		lassoSatellite: deps.store.lassoSatellite(),
		lassoBalance: deps.control.lassoBalance?.() ?? EMPTY_BALANCE,
		lassoBalanceError: deps.control.lassoBalanceError?.() ?? "",
		millifractionEnabled: deps.store.millifractionEnabled(),
		observationFrameEnabled: deps.store.observationFrameEnabled(),
		tcc: deps.tcc.status(),
		helperError: deps.control.helperStatus?.() ?? "",
		helperPhase: deps.control.helperPhase?.() ?? "",
		selectionAvailable: selectionRuntimeAvailable(),
		permissionFallback: deps.store.permissionFallback(),
		update,
		whatsNew: visibleWhatsNew(supported, update.currentVersion, deps.store.whatsNewDismissed(WHATS_NEW_VERSION)),
		history: deps.control.historyState?.() ?? EMPTY_HISTORY_STATE,
		workspace: deps.control.workspaceState?.() ?? {
			path: "",
			defaultPath: "",
			custom: false
		}
	};
}
async function catalog(deps) {
	try {
		return normalizeCatalog(await deps.ctx.sessionController.modelCatalog());
	} catch (error) {
		console.error(`dsh-orb: model catalog failed: ${error instanceof Error ? error.message : String(error)}`);
		return { groups: [] };
	}
}
const ALLOWED_IMAGE_TYPES = /* @__PURE__ */ new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif"
]);
/**
* Serve one durable image to the helper. The helper presents its socket token, so a
* hostile page cannot enumerate attachments; the bytes are verified by the store.
*/
async function sendAttachment(deps, url, method, res) {
	const id = url.searchParams.get("id") ?? "";
	const mediaType = url.searchParams.get("mediaType") ?? "";
	const bytes = Number(url.searchParams.get("bytes"));
	const width = Number(url.searchParams.get("width"));
	const height = Number(url.searchParams.get("height"));
	const thumb = url.searchParams.get("thumb") === "1";
	if (!/^[A-Za-z0-9:_-]{1,120}$/.test(id) || !ALLOWED_IMAGE_TYPES.has(mediaType)) {
		res.writeHead(404);
		res.end();
		return;
	}
	if (![
		bytes,
		width,
		height
	].every((value) => Number.isSafeInteger(value) && value > 0)) {
		res.writeHead(404);
		res.end();
		return;
	}
	const reader = deps.ctx.get?.("attachments");
	if (reader === void 0) {
		res.writeHead(404);
		res.end();
		return;
	}
	const ref = {
		attachmentId: id,
		mediaType,
		bytes,
		width,
		height
	};
	try {
		if (thumb && typeof reader.readImageRequest === "function") {
			const image = await reader.readImageRequest(ref, {
				width: 360,
				height: 240,
				maxBytes: 12e4
			});
			sendImage(res, method, Buffer.from(image.data), image.mediaType);
			return;
		}
		const image = await reader.readImage(ref);
		sendImage(res, method, Buffer.from(image.data), mediaType);
	} catch {
		res.writeHead(404);
		res.end();
	}
}
async function sendAvatar(store, method, res) {
	const selection = store.avatarSelection();
	if (selection.kind === "preset") {
		const file = avatarPresetPath(selection.id);
		if (file !== void 0 && await sendFile(res, method, file, "image/gif")) return;
	}
	const custom = selection.kind === "custom" ? store.readAvatar() : void 0;
	if (custom !== void 0) {
		sendImage(res, method, custom.bytes, custom.mime);
		return;
	}
	if (await sendFile(res, method, defaultAvatarPath(), "image/gif")) return;
	res.writeHead(404);
	res.end();
}
/** Reads the file and answers with the image; false means the caller still has to answer. */
async function sendFile(res, method, file, mime) {
	let body;
	try {
		body = await readFile(file);
	} catch {
		return false;
	}
	sendImage(res, method, body, mime);
	return true;
}
function sendImage(res, method, body, mime) {
	res.writeHead(200, {
		"content-type": mime,
		"cache-control": "no-store",
		"content-length": body.length
	});
	res.end(method === "HEAD" ? void 0 : body);
}
function helperTokenOk(deps, req) {
	const header = req.headers[HELPER_HEADER];
	return typeof header === "string" && deps.control.helperAuthorized(header);
}
function tokensMatch(given, expected) {
	const left = Buffer.from(given);
	const right = Buffer.from(expected);
	return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}
function rejectionStatus(ctx, req) {
	if (typeof ctx.connection.admit === "function") {
		const admitted = ctx.connection.admit(req);
		if (typeof admitted === "object" && admitted !== null && "rejection" in admitted && typeof admitted.rejection === "number") return admitted.rejection;
		return;
	}
	if (typeof ctx.connection.isAuthenticated === "function") return ctx.connection.isAuthenticated(req) ? void 0 : 401;
	return 401;
}
function selectionFrom(value) {
	return isAgentModelSelection(value) ? value : void 0;
}
function booleanField(value) {
	const enabled = asRecord$2(value)?.enabled;
	return typeof enabled === "boolean" ? enabled : void 0;
}
/** One integer field, undefined for a missing/non-integer value. */
function integerField(value, key) {
	const item = asRecord$2(value)?.[key];
	return typeof item === "number" && Number.isSafeInteger(item) ? item : void 0;
}
/** Optional list of package names, absent when the field is missing or empty. */
function stringListField(value, key) {
	const list = asRecord$2(value)?.[key];
	if (!Array.isArray(list)) return void 0;
	const names = list.filter((item) => typeof item === "string" && item !== "");
	return names.length === 0 ? void 0 : names;
}
function sendJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
async function readJson(req) {
	const bytes = await readBody(req, 65536);
	if (bytes.length === 0) return void 0;
	try {
		return JSON.parse(bytes.toString("utf8"));
	} catch {
		throw Object.assign(/* @__PURE__ */ new Error("invalid-json"), { status: 400 });
	}
}
function readBody(req, limit) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(Object.assign(/* @__PURE__ */ new Error("too-large"), { status: 413 }));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}
function asRecord$2(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
//#endregion
//#region src/services.ts
/**
* Optional services Computer Use already looks up, plus the Access preset pinned on orb sessions.
*/
/**
* Publish the two model/coordinate services for the life of the plugin.
* @param ctx - host context. `provide` is called once.
* @param store - profile preferences.
*/
function installOrbServices(ctx, store) {
	ctx.provide("orbCodeAgentModel", { currentSelection: () => store.models().background });
	ctx.provide("orbCoordinateMode", { currentMode: () => store.coordinateMode() });
}
/**
* Pin the stored Access preset on Computer Use and background sessions under the
* workspace the ball is using right now. Read on each create, so a switch applies
* to the next session without re-registering the listener.
* @returns a disposer for the create listener.
*/
function watchOrbPermissions(ctx, store) {
	const dispose = ctx.on("session/created", (session) => {
		pinSession(ctx, session, store.permission(), store.workspaceDirectory());
	});
	return typeof dispose === "function" ? dispose : () => {};
}
/**
* Pin one already-open session when the chip or a reopen asks for it.
* @param workspaceRoot - directory the floating-ball Agent is working in.
*/
function pinSessionId(ctx, sessionId, preset, workspaceRoot) {
	const session = ctx.get("sessions")?.get?.(sessionId);
	if (session) pinSession(ctx, session, preset, workspaceRoot);
}
function pinSession(ctx, session, preset, workspaceRoot) {
	if (!isOrbSession(session, workspaceRoot)) return;
	const presets = ctx.get("permissionPresets");
	if (typeof presets?.set !== "function") return;
	if (!isPermissionPreset(preset)) return;
	try {
		presets.set(session, preset);
	} catch (error) {
		console.error(`dsh-orb: permission preset failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}
function isOrbSession(session, workspaceRoot) {
	const preset = session.header?.agentPreset;
	const cwd = session.header?.cwd;
	if (preset !== "computer-use" && preset !== "standard" || cwd === void 0) return false;
	return isOrbWorkspace(cwd, workspaceRoot);
}
function isOrbWorkspace(cwd, orbCwd) {
	const resolved = resolve(cwd);
	const orb = resolve(orbCwd);
	if (resolved === orb) return true;
	const rel = relative(orb, resolved);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
//#endregion
//#region src/appearance.ts
function describeSettings(settings) {
	const describe = settings?.describe;
	if (typeof describe !== "function") return [];
	try {
		const rows = describe.call(settings);
		return Array.isArray(rows) ? rows : [];
	} catch {
		return [];
	}
}
/** Read the stored theme and locale preferences; unusable sections stay absent. */
function readAppearance(settings) {
	const appearance = {};
	for (const row of describeSettings(settings)) {
		if (row?.ns === "ui-theme") {
			const preference = row.value?.preference;
			if (preference === "light" || preference === "dark" || preference === "system") appearance.theme = preference;
		}
		if (row?.ns === "locale" && typeof row.value?.preference === "string") {
			const preference = row.value.preference;
			if (preference.length > 0 && preference.length <= 35) appearance.locale = preference;
		}
	}
	return appearance;
}
function sameAppearance(left, right) {
	return left.theme === right.theme && left.locale === right.locale;
}
/**
* Follow the live settings document: read once, then re-read whenever the
* theme or locale namespace changes. `settings/document-updated` fires for
* every namespace and describe() itself emits it, so the read is guarded
* against re-entry.
*/
function watchAppearance(ctx, onChange) {
	const settings = ctx.get("settings");
	if (typeof settings?.describe !== "function") return () => {};
	let reading = false;
	const read = () => {
		if (reading) return {};
		reading = true;
		try {
			return readAppearance(settings);
		} finally {
			reading = false;
		}
	};
	let current = read();
	onChange({ ...current });
	const detach = ctx.on("settings/document-updated", (ns) => {
		if (ns !== "ui-theme" && ns !== "locale") return;
		const next = read();
		if (sameAppearance(next, current)) return;
		current = next;
		onChange({ ...current });
	});
	return typeof detach === "function" ? detach : () => {};
}
//#endregion
//#region src/electron-runtime.ts
/**
* Locate the generic Electron binary used to open the ball.
* Official DeepSeek Harness is not a usable helper runtime: it has its own app payload and a single-instance lock.
*/
/** Matches the official app's Electron framework and the fork's desktop package. */
const ELECTRON_VERSION = "44.0.0";
const RELEASE_BASE = `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}`;
/** Official SHASUMS256.txt for Electron 44.0.0. The download is rejected when it disagrees. */
const PINNED_SHA256 = {
	"electron-v44.0.0-darwin-arm64.zip": "076d79742986e1b100b69ebecc691cb07368045e54c9087cef631b8622b76a80",
	"electron-v44.0.0-darwin-x64.zip": "28429e700ad68d9624aaa90b6543ffe891a48c14121fd904cd294e5edcee63ff",
	"electron-v44.0.0-linux-arm64.zip": "74b6f18bc29c0d52cf8e963c45d476800419097c6f3d53b27c5df335207e52bb",
	"electron-v44.0.0-linux-x64.zip": "d65286d812719f2b4c1a1b806a80f288a1058c89c7b058dae1e03ab25e499446",
	"electron-v44.0.0-win32-arm64.zip": "984c8f3b9ffaf3c0a3f3501c96277effc05a9f0df5a5d920b2610c09ebaf4368",
	"electron-v44.0.0-win32-x64.zip": "e61aa3bcea8152bc0730abd015e47c032d778a0ef10e2a1c78ba3c4ea47942f9"
};
/**
* Marker for a step the user aborted with a manual redownload. It is not a download failure:
* whoever cancelled the attempt owns the next one, so the caller must not count it.
*/
const CANCELLED_CODE = "dsh-orb-download-cancelled";
/** The one download this process can have in flight; the lock serialises attempts across processes. */
let active;
function cancelled() {
	return Object.assign(/* @__PURE__ */ new Error("dsh-orb: Electron download cancelled"), { code: CANCELLED_CODE });
}
/** Whether a rejection is this module's own cancellation rather than a real download failure. */
function isRuntimeDownloadCancelled(error) {
	return error?.code === CANCELLED_CODE;
}
/**
* Drop the download in flight, if any. The attempt unwinds at its next step and deletes its own
* partial zip and staging folder on the way out.
*/
function cancelRuntimeDownload() {
	const controller = active;
	active = void 0;
	controller?.abort();
}
/**
* Delete what a killed process left behind: half-written downloads and `.electron-staging-*`
* extraction folders. The resumable partial of this version's asset stays — a redownload
* continues those bytes rather than fetching them twice.
*/
async function purgeRuntimeArtifacts() {
	const dir = dshHomePath("dsh-orb");
	let entries;
	try {
		entries = await readdir(dir);
	} catch {
		return;
	}
	const kept = basename(partialPath(dir, assetName()));
	for (const name of entries) {
		if (!name.startsWith(".electron-")) continue;
		if (name === kept) continue;
		await rm(join(dir, name), {
			recursive: true,
			force: true
		}).catch(() => void 0);
	}
}
/** The file one asset's transfer writes, and the one a later attempt resumes. */
function partialPath(parent, fileName) {
	return join(parent, `.electron-${fileName}.partial`);
}
/** Size of a file, or 0 when it is not there: "no bytes to resume from" is not an error. */
async function fileSize(path) {
	try {
		return (await stat(path)).size;
	} catch {
		return 0;
	}
}
/**
* Resolve the helper executable.
* `DSH_ORB_ELECTRON_PATH` wins. Otherwise use the cached official zip, downloading it once.
* @param report - optional phase callback; fires only when a download is actually needed.
* @returns absolute path to the Electron executable.
*/
async function resolveElectronBinary(report) {
	const override = process.env.DSH_ORB_ELECTRON_PATH?.trim();
	if (override) {
		await access(override);
		return override;
	}
	const dest = dshHomePath("dsh-orb", "electron-runtime");
	const binary = join(dest, binaryRelative());
	const marker = join(dest, `.complete-${ELECTRON_VERSION}`);
	if (await exists(binary) && await exists(marker)) return binary;
	await downloadRuntime(dest, binary, marker, report);
	return binary;
}
async function downloadRuntime(dest, binary, marker, report) {
	const parent = dirname(dest);
	await mkdir(parent, { recursive: true });
	const controller = new AbortController();
	active = controller;
	const signal = controller.signal;
	try {
		await withDownloadLock(parent, async () => {
			if (signal.aborted) throw cancelled();
			if (await exists(binary) && await exists(marker)) return;
			const fileName = assetName();
			console.error(`dsh-orb: downloading Electron ${ELECTRON_VERSION} (${fileName})`);
			const expected = expectedHash(await fetchText("SHASUMS256.txt", signal), fileName);
			const zipPath = partialPath(parent, fileName);
			const staging = join(parent, `.electron-staging-${randomBytes(8).toString("hex")}`);
			try {
				report?.("downloading");
				const resumed = await fileSize(zipPath);
				if (resumed > 0) console.error(`dsh-orb: continuing from ${resumed} bytes left by an earlier attempt`);
				await downloadVerifiedZip(fileName, expected, zipPath, signal);
				report?.("extracting");
				await mkdir(staging, { recursive: true });
				await extractZip(zipPath, staging, signal);
				const stagedBinary = join(staging, binaryRelative());
				if (process.platform === "darwin") await spawnChecked("/usr/bin/xattr", [
					"-dr",
					"com.apple.quarantine",
					staging
				]).catch(() => void 0);
				if (signal.aborted) throw cancelled();
				await chmod(stagedBinary, 493);
				await access(stagedBinary);
				await writeFile(join(staging, `.complete-${ELECTRON_VERSION}`), `${ELECTRON_VERSION}\n`);
				await replaceDirectory(staging, dest);
			} finally {
				await rm(staging, {
					recursive: true,
					force: true
				});
			}
			await rm(zipPath, { force: true }).catch(() => void 0);
			console.error(`dsh-orb: Electron ${ELECTRON_VERSION} is ready`);
		}, signal);
	} finally {
		if (active === controller) active = void 0;
	}
}
/**
* Take the download lock. The owner file is written in a staging directory first, and the
* directory is renamed into place: the lock only ever appears with its owner already inside,
* so a second process can never read a half-made lock. A dead owner, or one past the
* 20-minute ceiling, can be taken over.
*/
async function withDownloadLock(parent, task, signal) {
	const lock = join(parent, "electron-runtime.download.lock");
	const deadline = Date.now() + 6e5;
	for (;;) {
		if (Date.now() > deadline) throw new Error("dsh-orb: Electron download is locked by another process");
		if (signal?.aborted) throw cancelled();
		const staging = `${lock}.${randomBytes(6).toString("hex")}.tmp`;
		try {
			await mkdir(staging);
			await writeFile(join(staging, "owner"), `${process.pid}\n${Date.now()}\n`);
		} catch (error) {
			await rm(staging, {
				recursive: true,
				force: true
			});
			throw error;
		}
		try {
			await rename(staging, lock);
			break;
		} catch (error) {
			await rm(staging, {
				recursive: true,
				force: true
			});
			if (!isLockTaken(error)) throw error;
			if (await lockExpired(lock)) {
				await rm(lock, {
					recursive: true,
					force: true
				});
				continue;
			}
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
	try {
		await task();
	} finally {
		await rm(lock, {
			recursive: true,
			force: true
		});
	}
}
/** Codes a failed rename of the staging directory onto the lock directory answers with when the lock is held. */
function isLockTaken(error) {
	const code = error?.code;
	return code === "EEXIST" || code === "ENOTEMPTY" || code === "EPERM" || code === "EACCES";
}
/**
* How long a lock's owner is believed before it is treated as a recycled pid. A transfer has no
* total time limit — a slow line is allowed to finish — so this only has to outlast the longest
* believable download, not the longest expected one.
*/
const STALE_OWNER_MS = 108e5;
async function lockExpired(lock) {
	let text;
	try {
		text = await readFile(join(lock, "owner"), "utf8");
	} catch (error) {
		if (error?.code !== "ENOENT") return false;
		try {
			const info = await stat(lock);
			return Date.now() - info.mtimeMs > 3e4;
		} catch {
			return false;
		}
	}
	const [pidText, startedText] = text.split("\n");
	const pid = Number(pidText);
	const started = Number(startedText);
	if (!Number.isInteger(pid) || pid <= 0) return true;
	if (Number.isFinite(started) && Date.now() - started > STALE_OWNER_MS) return true;
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return error?.code !== "EPERM";
	}
}
async function replaceDirectory(staging, dest) {
	const retired = `${dest}.retired-${randomBytes(4).toString("hex")}`;
	let moved = false;
	if (await exists(dest)) {
		await rename(dest, retired);
		moved = true;
	}
	try {
		await rename(staging, dest);
	} catch (error) {
		if (moved) await rename(retired, dest).catch(() => void 0);
		throw error;
	}
	if (moved) await rm(retired, {
		recursive: true,
		force: true
	}).catch(() => void 0);
}
function assetName() {
	const platform = process.platform;
	const arch = process.arch;
	if (platform !== "darwin" && platform !== "win32" && platform !== "linux") throw new Error(`dsh-orb: unsupported platform ${platform}`);
	if (arch !== "arm64" && arch !== "x64") throw new Error(`dsh-orb: unsupported architecture ${arch}`);
	return `electron-v${ELECTRON_VERSION}-${platform}-${arch}.zip`;
}
function binaryRelative() {
	if (process.platform === "darwin") return join("Electron.app", "Contents", "MacOS", "Electron");
	if (process.platform === "win32") return "electron.exe";
	return "electron";
}
/** The hash written in source. `sums` must list the same value or the download stops. */
function expectedHash(sums, fileName) {
	const pinned = PINNED_SHA256[fileName];
	if (pinned === void 0) throw new Error(`dsh-orb: ${fileName} has no pinned Electron ${ELECTRON_VERSION} checksum`);
	if (hashFromSums(sums, fileName) !== pinned) throw new Error(`dsh-orb: Electron ${ELECTRON_VERSION} checksum list does not match the pinned hash for ${fileName}`);
	return pinned;
}
function hashFromSums(sums, fileName) {
	for (const line of sums.split("\n")) {
		const match = /^([a-fA-F0-9]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
		if (match?.[2] === fileName) return match[1].toLowerCase();
	}
	throw new Error(`dsh-orb: ${fileName} is missing from Electron ${ELECTRON_VERSION} checksums`);
}
const CURL_HTTPS = [
	"--proto",
	"=https",
	"--proto-redir",
	"=https"
];
/** The Windows schannel backend aborts when a revocation check cannot complete
* (common behind proxies); every download is checksum-verified anyway. Other
* TLS backends ignore the flag. */
const CURL_TLS = process.platform === "win32" ? ["--ssl-no-revoke"] : [];
/** How long a dead host may burn before curl gives up and the next source is asked. */
const CONNECT_TIMEOUT_SECONDS = "5";
/**
* The stall floor, and how long a transfer may sit under it before curl gives up on it.
* This is the only thing that ends a transfer early: a slow line is not a dead one, and whatever
* it has already delivered is kept for the next attempt to resume. 20 KB/s for 30 s is a
* connection that has stopped — the runtime is 124–150 MB, so nothing sane sits below it for long.
*/
const STALL_BYTES_PER_SECOND = "20000";
const STALL_SECONDS = "30";
/**
* Mirrors of an Electron release, in the order they are asked.
* npmmirror goes first: github.com is unreachable for a large part of the audience,
* and a silently dropped connection there would otherwise stall the first ball launch.
* Every download is checked against the compiled-in SHA-256, so the order costs no trust.
*/
function releaseUrls(path) {
	return [`https://cdn.npmmirror.com/binaries/electron/v${ELECTRON_VERSION}/${path}`, `${RELEASE_BASE}/${path}`];
}
/** First source that answers wins; a dead host costs one connect timeout, not the whole transfer. */
async function fetchText(path, signal) {
	let lastError;
	for (const url of releaseUrls(path)) try {
		const { stdout } = await run$1("curl", [
			"-fsSL",
			...CURL_HTTPS,
			...CURL_TLS,
			"--connect-timeout",
			CONNECT_TIMEOUT_SECONDS,
			"--max-time",
			"60",
			url
		], signal);
		return stdout;
	} catch (error) {
		if (signal.aborted) throw cancelled();
		lastError = error;
		console.error(`dsh-orb: ${error instanceof Error ? error.message : String(error)}`);
	}
	throw lastError instanceof Error ? lastError : /* @__PURE__ */ new Error(`dsh-orb: failed to download ${path}`);
}
async function downloadVerifiedZip(fileName, expected, dest, signal) {
	if (await matchesHash(dest, expected)) {
		console.error("dsh-orb: the runtime zip on disk is already complete");
		return;
	}
	const urls = releaseUrls(fileName);
	let lastError;
	for (const url of urls) {
		const resume = await fileSize(dest) > 0;
		try {
			await run$1("curl", zipCurlArgs(url, dest, resume), signal);
			if (!sameHash(await sha256$1(dest), expected)) {
				await rm(dest, { force: true });
				throw new Error(`dsh-orb: Electron ${ELECTRON_VERSION} checksum did not match SHASUMS256.txt`);
			}
			return;
		} catch (error) {
			if (signal.aborted) throw cancelled();
			if (resume && isResumeRefused(error)) await rm(dest, { force: true }).catch(() => void 0);
			lastError = error;
			console.error(`dsh-orb: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	throw lastError instanceof Error ? lastError : /* @__PURE__ */ new Error(`dsh-orb: failed to download Electron ${ELECTRON_VERSION}`);
}
/**
* The curl that fetches one zip.
*
* There is deliberately no total time limit. A 124–150 MB runtime on a slow line can take longer
* than any cap worth writing, and cutting it off just means paying for the same bytes again —
* the stall guard (`--speed-limit`/`--speed-time`) is what catches a connection that has actually
* stopped delivering. `resume` continues an interrupted transfer instead of starting it over.
*
* @param url - mirror URL of the zip.
* @param dest - file the transfer writes; `-C -` appends to whatever is already there.
* @param resume - true when `dest` already holds bytes worth keeping.
* @returns argv for curl.
*/
function zipCurlArgs(url, dest, resume) {
	return [
		"-fsSL",
		...CURL_HTTPS,
		...CURL_TLS,
		"--retry",
		"2",
		"--retry-delay",
		"1",
		"--connect-timeout",
		CONNECT_TIMEOUT_SECONDS,
		"--speed-limit",
		STALL_BYTES_PER_SECOND,
		"--speed-time",
		STALL_SECONDS,
		...resume ? ["-C", "-"] : [],
		"-o",
		dest,
		url
	];
}
/**
* Whether curl refused the resume rather than the transfer. 33/36 are its "cannot resume" exits;
* a 416 arrives as the generic HTTP-failure exit 22, so the status has to be read out of the
* message. A 404 must not land here: that mirror is simply down, and the bytes stay for the next one.
*/
function isResumeRefused(error) {
	const code = error?.exitCode;
	if (code === 33 || code === 36) return true;
	return code === 22 && error instanceof Error && error.message.includes("416");
}
function run$1(command, args, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(cancelled());
			return;
		}
		const child = spawn(command, args, {
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			...signal === void 0 ? {} : { signal }
		});
		const out = [];
		const err = [];
		child.stdout?.on("data", (chunk) => out.push(chunk));
		child.stderr?.on("data", (chunk) => err.push(chunk));
		child.once("error", (error) => {
			reject(signal?.aborted ? cancelled() : error);
		});
		child.once("exit", (code) => {
			if (code === 0) {
				resolve({ stdout: Buffer.concat(out).toString("utf8") });
				return;
			}
			const detail = Buffer.concat(err).toString("utf8").trim();
			reject(Object.assign(/* @__PURE__ */ new Error(`dsh-orb: ${command} exited ${code ?? "unknown"}${detail ? `: ${detail}` : ""}`), { exitCode: code }));
		});
	});
}
async function sha256$1(path) {
	const hash = createHash("sha256");
	await pipeline(createReadStream(path), hash);
	return hash.digest("hex");
}
/**
* Whether a file already holds exactly the bytes the checksum names. A missing file never
* matches, and an unreadable one only means "not proven complete": the caller downloads.
*/
async function matchesHash(path, expected) {
	if (await fileSize(path) === 0) return false;
	try {
		return sameHash(await sha256$1(path), expected);
	} catch {
		return false;
	}
}
function sameHash(actual, expected) {
	const left = Buffer.from(actual, "hex");
	const right = Buffer.from(expected, "hex");
	return left.length === right.length && timingSafeEqual(left, right);
}
/**
* Unpack one zip into `dest`.
*
* Windows cannot use `Expand-Archive`: the cmdlet refuses any archive whose name does not end in
* `.zip`, and the transfer deliberately keeps its bytes in `<asset>.zip.partial` so a killed
* attempt can be resumed instead of paid for twice. The extension describes the download, not the
* archive, so the extractor must not read anything into it — .NET's `ZipFile` (the same library
* behind the cmdlet) does not.
*/
async function extractZip(zipPath, dest, signal) {
	if (process.platform === "win32") {
		await spawnChecked("powershell.exe", [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			[
				"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
				"$ErrorActionPreference = 'Stop'",
				"Add-Type -AssemblyName System.IO.Compression.FileSystem",
				`[System.IO.Compression.ZipFile]::ExtractToDirectory(${singleQuoted(zipPath)}, ${singleQuoted(dest)})`
			].join("; ")
		], signal);
		return;
	}
	await spawnChecked(process.platform === "darwin" ? "/usr/bin/unzip" : "unzip", [
		"-q",
		"-o",
		zipPath,
		"-d",
		dest
	], signal);
}
/** A PowerShell single-quoted string: the only character it interprets is `'`, doubled. */
function singleQuoted(value) {
	return `'${value.replaceAll("'", "''")}'`;
}
/** Cap on the extractor's stderr kept for one failure: enough for the reason, not a whole dump. */
const STDERR_LIMIT_BYTES = 4096;
function spawnChecked(command, args, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(cancelled());
			return;
		}
		const child = spawn(command, args, {
			stdio: [
				"ignore",
				"ignore",
				"pipe"
			],
			...signal === void 0 ? {} : { signal }
		});
		const err = [];
		let errBytes = 0;
		child.stderr?.on("data", (chunk) => {
			if (errBytes >= STDERR_LIMIT_BYTES) return;
			errBytes += chunk.length;
			err.push(chunk);
		});
		child.once("error", (error) => {
			reject(signal?.aborted ? cancelled() : error);
		});
		child.once("exit", (code) => {
			if (signal?.aborted) {
				reject(cancelled());
				return;
			}
			if (code === 0) {
				resolve();
				return;
			}
			const detail = Buffer.concat(err).toString("utf8").trim().split("\n").slice(0, 6).join("\n");
			reject(/* @__PURE__ */ new Error(`dsh-orb: ${command} exited ${code ?? "unknown"}${detail ? `: ${detail}` : ""}`));
		});
	});
}
async function exists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
//#endregion
//#region src/os-trash.ts
/**
* Move one path to the operating system's trash: the macOS Trash or the Windows
* Recycle Bin. The user restores it from there; this module never keeps a copy.
*/
/** Whether this platform has a user-facing trash this plugin can put a directory into. */
function osTrashAvailable() {
	return process.platform === "darwin" || process.platform === "win32";
}
/**
* Put one file or directory into the system trash.
* @param path - absolute path to move.
* @throws when the platform is unsupported or the system refuses the move.
*/
async function moveToOsTrash(path) {
	if (process.platform === "darwin") return trashOnMac(path);
	if (process.platform === "win32") return trashOnWindows(path);
	throw new Error("os-trash-unavailable");
}
/** Finder/NSFileManager records the original location, so Put Back works. */
const MAC_SCRIPT = `ObjC.import('Foundation');
function run(argv) {
  const fm = $.NSFileManager.defaultManager;
  if (!fm.fileExistsAtPath(argv[0])) throw new Error('missing path');
  const ok = fm.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(argv[0]), $(), $());
  if (!ok) throw new Error('the system trash refused the item');
  return 'ok';
}`;
function trashOnMac(path) {
	return run("osascript", [
		"-l",
		"JavaScript",
		"-e",
		MAC_SCRIPT,
		path
	], 3e4);
}
/** Microsoft.VisualBasic moves through the Shell, so Explorer can restore it. */
const WINDOWS_SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	"Add-Type -AssemblyName Microsoft.VisualBasic",
	"[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:DSH_ORB_TRASH_PATH, 'OnlyErrorDialogs', 'SendToRecycleBin')"
].join("; ");
function trashOnWindows(path) {
	return run("powershell.exe", [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		WINDOWS_SCRIPT
	], 6e4, { DSH_ORB_TRASH_PATH: path });
}
function run(command, args, timeoutMs, extraEnv = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, [...args], {
			env: {
				...process.env,
				...extraEnv
			},
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			windowsHide: true
		});
		let stderr = "";
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		const timer = setTimeout(() => {
			child.kill();
			reject(/* @__PURE__ */ new Error(`os trash timed out after ${String(timeoutMs)}ms`));
		}, timeoutMs);
		timer.unref();
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve();
			else reject(new Error(stderr.trim() || `os trash exited with ${String(code)}`));
		});
	});
}
//#endregion
//#region src/model-defaults.ts
/**
* Which model the two tracks use while the user has not picked one.
*
* The product owns that default: `agentDefaultModel.currentSelection()` is what a new Agent is
* created with, and the account sign-in flow rewrites it to the account route when no provider
* API key is configured. The ball follows it, so an account-only user is never left on the
* API-key route. Picking a model in the ball menu or the settings page pins that track; a track
* the user never touched keeps following.
*
* `refreshModelFallback` is called where the value has to be right: the plugin entry warms it
* for the settings page, `adopt` refreshes it just before a session gets its model, and
* `publishChrome` refreshes it for the ball menu and re-selects a live session when it moved.
*/
/** True when the live catalog advertises this exact provider and model. */
function catalogAdvertises(groups, selection) {
	return groups.some((group) => group.id === selection.provider && group.models.some((model) => model.id === selection.model));
}
/**
* The selection both tracks follow until the user pins one.
*
* The product default comes first even though the shipped pair is usually advertised too: the
* API-key route publishes its catalog without looking at credentials, so "is it advertised"
* alone would keep an account-only user on the route that cannot authenticate. The shipped pair
* is the fallback for a deployment whose catalog or product default predates the account
* provider; the first advertised model is the last resort before the shipped pair.
*/
function fallbackSelection(groups, product) {
	if (product !== void 0 && catalogAdvertises(groups, product)) return product;
	if (catalogAdvertises(groups, DEFAULT_MODEL)) return DEFAULT_MODEL;
	return firstAdvertised(groups) ?? DEFAULT_MODEL;
}
/** The product's default model, or undefined when the service is missing or unusable. */
function readProductDefault(source) {
	let selection;
	try {
		selection = source.agentDefaultModel?.currentSelection();
	} catch {
		return;
	}
	if (selection === void 0) return void 0;
	if (typeof selection.provider !== "string" || selection.provider === "") return void 0;
	if (typeof selection.model !== "string" || selection.model === "") return void 0;
	return {
		provider: selection.provider,
		model: selection.model,
		...typeof selection.reasoningEffort === "string" && selection.reasoningEffort !== "" ? { reasoningEffort: selection.reasoningEffort } : {}
	};
}
/**
* Read the live catalog and the product default, then adopt the fallback on the store.
* `changed` never reports an explicit pick: only the value the unpicked tracks follow.
*/
async function refreshModelFallback(source, store) {
	const catalog = normalizeCatalog(await source.sessionController.modelCatalog());
	return {
		catalog,
		changed: store.applyModelFallback(fallbackSelection(catalog.groups, readProductDefault(source)))
	};
}
/** First advertised model, carrying the effort its catalog entry defaults to. */
function firstAdvertised(groups) {
	const group = groups[0];
	const model = group?.models[0];
	if (group === void 0 || model === void 0) return void 0;
	const defaultEffort = model.reasoning?.defaultEffort;
	return {
		provider: group.id,
		model: model.id,
		...defaultEffort === void 0 ? {} : { reasoningEffort: defaultEffort }
	};
}
//#endregion
//#region src/open-main.ts
/**
* Focus the official desktop window, or open the local web page.
* The credentialed page address is never written to the log.
*/
/**
* Desktop uses the app's `dsh://open` protocol.
* `dsh web` has no main window, so the menu item stays disabled and this returns undefined.
* The credentialed loopback URL is never passed to `open` or `cmd`.
*/
function mainWindowTarget(_ctx, desktop = isDesktopHost()) {
	if (desktop) return "dsh://open";
}
/** Command used to focus that window. The target is never logged. */
function openCommand(target, platform = process.platform) {
	if (platform === "win32") return {
		command: "cmd",
		args: [
			"/c",
			"start",
			"",
			target
		]
	};
	return {
		command: "open",
		args: [target]
	};
}
/**
* Environment for the opener.
* The desktop host runs under `ELECTRON_RUN_AS_NODE=1`, and a child that keeps it makes
* Windows start the protocol handler in Node mode: the app never reaches its
* single-instance forwarding, so `dsh://open` silently does nothing. The helper spawn
* drops the same marker for the same reason. macOS launches through `open`, which starts
* the app from LaunchServices and never sees this environment.
* @param env - environment to copy, `process.env` by default.
* @returns a copy without the Node-mode marker.
*/
function openEnvironment(env = process.env) {
	const clean = { ...env };
	delete clean.ELECTRON_RUN_AS_NODE;
	return clean;
}
/** Focus the desktop main window. Does nothing when this host is `dsh web`. */
async function openMainWindow(ctx) {
	const target = mainWindowTarget(ctx);
	if (target === void 0) return;
	await spawnOpen(target);
}
function spawnOpen(target) {
	const { command, args } = openCommand(target);
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			stdio: "ignore",
			windowsHide: true,
			env: openEnvironment()
		});
		child.once("error", () => {
			console.error("dsh-orb: could not open the main window");
			resolve();
		});
		child.once("exit", (code) => {
			if (code !== 0) console.error("dsh-orb: could not open the main window");
			resolve();
		});
	});
}
//#endregion
//#region ../../node_modules/.pnpm/pinyin-pro@3.29.5/node_modules/pinyin-pro/dist/esm/common/constant.mjs
const DoubleUnicodePrefixReg = /^[\uD800-\uDBFF]$/;
const DoubleUnicodeSuffixReg = /^[\uDC00-\uDFFF]$/;
const DoubleUnicodeReg = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;
var Probability;
(function(Probability) {
	Probability[Probability["Unknown"] = 1e-13] = "Unknown";
	Probability[Probability["Rule"] = 1e-12] = "Rule";
	Probability[Probability["DICT"] = 2e-8] = "DICT";
	Probability[Probability["Surname"] = 1] = "Surname";
	Probability[Probability["Custom"] = 1] = "Custom";
})(Probability || (Probability = {}));
const Priority = {
	Normal: 1,
	Surname: 10,
	Custom: 100
};
//#endregion
//#region ../../node_modules/.pnpm/pinyin-pro@3.29.5/node_modules/pinyin-pro/dist/esm/common/utils.mjs
function stringLength(text) {
	var _a;
	return text.length - (((_a = text.match(DoubleUnicodeReg)) === null || _a === void 0 ? void 0 : _a.length) || 0);
}
function splitString(text) {
	DoubleUnicodeReg.lastIndex = 0;
	if (!DoubleUnicodeReg.test(text)) return text.split("");
	const result = [];
	let i = 0;
	while (i < text.length) {
		const char = text[i];
		if (DoubleUnicodePrefixReg.test(char) && DoubleUnicodeSuffixReg.test(text[i + 1])) {
			result.push(text.substring(i, i + 2));
			i += 2;
		} else {
			result.push(char);
			i += 1;
		}
	}
	return result;
}
var FastDictFactory = class {
	constructor() {
		this.NumberDICT = [];
		this.StringDICT = /* @__PURE__ */ new Map();
	}
	get(word) {
		if (word.length > 1) return this.StringDICT.get(word);
		else {
			const code = word.charCodeAt(0);
			return this.NumberDICT[code];
		}
	}
	set(word, pinyin) {
		if (word.length > 1) this.StringDICT.set(word, pinyin);
		else {
			const code = word.charCodeAt(0);
			this.NumberDICT[code] = pinyin;
		}
	}
	clear() {
		this.NumberDICT = [];
		this.StringDICT.clear();
	}
};
//#endregion
//#region ../../node_modules/.pnpm/pinyin-pro@3.29.5/node_modules/pinyin-pro/dist/esm/data/special.mjs
const InitialList = [
	"zh",
	"ch",
	"sh",
	"z",
	"c",
	"s",
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
	"y",
	"w",
	""
];
const SpecialInitialList = [
	"j",
	"q",
	"x"
];
const SpecialFinalList = [
	"uān",
	"uán",
	"uǎn",
	"uàn",
	"uan",
	"uē",
	"ué",
	"uě",
	"uè",
	"ue",
	"ūn",
	"ún",
	"ǔn",
	"ùn",
	"un",
	"ū",
	"ú",
	"ǔ",
	"ù",
	"u"
];
const SpecialFinalMap = {
	uān: "üān",
	uán: "üán",
	uǎn: "üǎn",
	uàn: "üàn",
	uan: "üan",
	uē: "üē",
	ué: "üé",
	uě: "üě",
	uè: "üè",
	ue: "üe",
	ūn: "ǖn",
	ún: "ǘn",
	ǔn: "ǚn",
	ùn: "ǜn",
	un: "ün",
	ū: "ǖ",
	ú: "ǘ",
	ǔ: "ǚ",
	ù: "ǜ",
	u: "ü"
};
const doubleFinalList = [
	"ia",
	"ian",
	"iang",
	"iao",
	"ie",
	"iu",
	"iong",
	"ua",
	"uai",
	"uan",
	"uang",
	"ue",
	"ui",
	"uo",
	"üan",
	"üe",
	"van",
	"ve"
];
/**
* @description: 数量词 + 特殊词 音调处理
*/
const Numbers = {
	一: "yì",
	二: "èr",
	三: "sān",
	四: "sì",
	五: "wǔ",
	六: "liù",
	七: "qī",
	八: "bā",
	九: "jiǔ",
	十: "shí",
	百: "bǎi",
	千: "qiān",
	万: "wàn",
	亿: "yì",
	单: "dān",
	两: "liǎng",
	双: "shuāng",
	多: "duō",
	几: "jǐ",
	十一: "shí yī",
	零一: "líng yī",
	第一: "dì yī",
	一十: "yī shí",
	一十一: "yī shí yī"
};
const NumberWordMap = {
	重: "chóng",
	行: "háng",
	斗: "dǒu",
	更: "gēng"
};
function genNumberDict() {
	const dict = {
		零一: "líng yī",
		〇一: "líng yī",
		十一: "shí yī",
		一十: "yī shí",
		第一: "dì yī",
		一十一: "yī shí yī"
	};
	for (let number in Numbers) for (let key in NumberWordMap) {
		const word = `${number}${key}`;
		dict[word] = `${Numbers[number]} ${NumberWordMap[key]}`;
	}
	return dict;
}
const NumberDict = genNumberDict();
const PatternNumberDict = Object.keys(NumberDict).map((key) => ({
	zh: key,
	pinyin: NumberDict[key],
	probability: 1e-12,
	length: stringLength(key),
	priority: Priority.Normal,
	dict: Symbol("rule")
}));
/**
* @description: 连续变调处理：https://zh.wiktionary.org/wiki/Appendix:%E2%80%9C%E4%B8%80%E2%80%9D%E5%8F%8A%E2%80%9C%E4%B8%8D%E2%80%9D%E7%9A%84%E5%8F%98%E8%B0%83
*/
const toneSandhiMap = {
	不: { bú: [4] },
	一: {
		yí: [4],
		yì: [
			1,
			2,
			3
		]
	}
};
const toneSandhiIgnoreSuffix = {
	不: [
		"的",
		"而",
		"之",
		"后",
		"也",
		"还",
		"地"
	],
	一: [
		"的",
		"而",
		"之",
		"后",
		"也",
		"还",
		"是"
	]
};
const toneSandhiList = Object.keys(toneSandhiMap);
//#endregion
//#region ../../node_modules/.pnpm/pinyin-pro@3.29.5/node_modules/pinyin-pro/dist/esm/data/dict1.mjs
const map = {
	"bǎng páng pāng": ["膀"],
	líng: [
		"〇",
		"伶",
		"凌",
		"刢",
		"囹",
		"坽",
		"夌",
		"姈",
		"婈",
		"孁",
		"岺",
		"彾",
		"掕",
		"昤",
		"朎",
		"柃",
		"棂",
		"櫺",
		"欞",
		"泠",
		"淩",
		"澪",
		"灵",
		"燯",
		"爧",
		"狑",
		"玲",
		"琌",
		"瓴",
		"皊",
		"砱",
		"祾",
		"秢",
		"竛",
		"笭",
		"紷",
		"綾",
		"绫",
		"羐",
		"羚",
		"翎",
		"聆",
		"舲",
		"苓",
		"菱",
		"蓤",
		"蔆",
		"蕶",
		"蛉",
		"衑",
		"裬",
		"詅",
		"跉",
		"軨",
		"輘",
		"酃",
		"醽",
		"鈴",
		"錂",
		"铃",
		"閝",
		"陵",
		"零",
		"霊",
		"霗",
		"霛",
		"霝",
		"靈",
		"駖",
		"魿",
		"鯪",
		"鲮",
		"鴒",
		"鸰",
		"鹷",
		"麢",
		"齡",
		"齢",
		"龄",
		"龗",
		"㥄"
	],
	yī: [
		"一",
		"乊",
		"伊",
		"依",
		"医",
		"吚",
		"咿",
		"噫",
		"壱",
		"壹",
		"夁",
		"嫛",
		"嬄",
		"弌",
		"揖",
		"撎",
		"檹",
		"毉",
		"洢",
		"渏",
		"漪",
		"瑿",
		"畩",
		"祎",
		"禕",
		"稦",
		"繄",
		"蛜",
		"衤",
		"譩",
		"辷",
		"郼",
		"醫",
		"銥",
		"铱",
		"鷖",
		"鹥",
		"黟",
		"黳"
	],
	"dīng zhēng": ["丁"],
	"kǎo qiǎo yú": ["丂"],
	qī: [
		"七",
		"倛",
		"僛",
		"凄",
		"嘁",
		"墄",
		"娸",
		"悽",
		"慼",
		"慽",
		"戚",
		"捿",
		"柒",
		"桤",
		"桼",
		"棲",
		"榿",
		"欺",
		"沏",
		"淒",
		"漆",
		"紪",
		"緀",
		"萋",
		"褄",
		"諆",
		"迉",
		"郪",
		"鏚",
		"霋",
		"魌",
		"鶈"
	],
	shàng: [
		"丄",
		"尙",
		"尚",
		"恦",
		"緔",
		"绱"
	],
	xià: [
		"丅",
		"下",
		"乤",
		"圷",
		"夏",
		"夓",
		"懗",
		"梺",
		"疜",
		"睱",
		"罅",
		"鎼",
		"鏬"
	],
	hǎn: [
		"丆",
		"喊",
		"浫",
		"罕",
		"豃",
		"㘎"
	],
	"wàn mò": ["万"],
	zhàng: [
		"丈",
		"仗",
		"墇",
		"嶂",
		"帐",
		"帳",
		"幛",
		"扙",
		"杖",
		"涱",
		"痮",
		"瘬",
		"瘴",
		"瞕",
		"粀",
		"胀",
		"脹",
		"賬",
		"账",
		"障"
	],
	sān: [
		"三",
		"厁",
		"叁",
		"弎",
		"毵",
		"毶",
		"毿",
		"犙",
		"鬖"
	],
	"shàng shǎng shang": ["上"],
	"qí jī": [
		"丌",
		"其",
		"奇"
	],
	"bù fǒu": ["不"],
	"yǔ yù yú": ["与"],
	miǎn: [
		"丏",
		"偭",
		"免",
		"冕",
		"勉",
		"勔",
		"喕",
		"娩",
		"愐",
		"汅",
		"沔",
		"湎",
		"睌",
		"緬",
		"缅",
		"腼",
		"葂",
		"靦",
		"鮸",
		"𩾃"
	],
	gài: [
		"丐",
		"乢",
		"匃",
		"匄",
		"戤",
		"概",
		"槩",
		"槪",
		"溉",
		"漑",
		"瓂",
		"葢",
		"鈣",
		"钙",
		"𬮿"
	],
	chǒu: [
		"丑",
		"丒",
		"侴",
		"吜",
		"杽",
		"瞅",
		"矁",
		"醜",
		"魗"
	],
	zhuān: [
		"专",
		"叀",
		"嫥",
		"専",
		"專",
		"瑼",
		"甎",
		"砖",
		"磗",
		"磚",
		"蟤",
		"諯",
		"鄟",
		"顓",
		"颛",
		"鱄",
		"䏝"
	],
	"qiě jū": ["且"],
	pī: [
		"丕",
		"伓",
		"伾",
		"噼",
		"坯",
		"岯",
		"憵",
		"批",
		"披",
		"炋",
		"狉",
		"狓",
		"砒",
		"磇",
		"礔",
		"礕",
		"秛",
		"秠",
		"耚",
		"豾",
		"邳",
		"鈚",
		"鉟",
		"銔",
		"錃",
		"錍",
		"霹",
		"駓",
		"髬",
		"魾",
		"𬳵"
	],
	shì: [
		"世",
		"丗",
		"亊",
		"事",
		"仕",
		"侍",
		"冟",
		"势",
		"勢",
		"卋",
		"呩",
		"嗜",
		"噬",
		"士",
		"奭",
		"嬕",
		"室",
		"市",
		"式",
		"弑",
		"弒",
		"恀",
		"恃",
		"戺",
		"拭",
		"揓",
		"是",
		"昰",
		"枾",
		"柿",
		"栻",
		"澨",
		"烒",
		"煶",
		"眂",
		"眎",
		"眡",
		"睗",
		"示",
		"礻",
		"筮",
		"簭",
		"舐",
		"舓",
		"襫",
		"視",
		"视",
		"觢",
		"試",
		"誓",
		"諡",
		"謚",
		"试",
		"谥",
		"貰",
		"贳",
		"軾",
		"轼",
		"逝",
		"遾",
		"釈",
		"释",
		"釋",
		"鈰",
		"鉃",
		"鉽",
		"铈",
		"飾",
		"餙",
		"餝",
		"饰",
		"鰘",
		"䏡",
		"𬤊"
	],
	qiū: [
		"丘",
		"丠",
		"坵",
		"媝",
		"恘",
		"恷",
		"楸",
		"秋",
		"秌",
		"穐",
		"篍",
		"緧",
		"萩",
		"蘒",
		"蚯",
		"蝵",
		"蟗",
		"蠤",
		"趥",
		"邱",
		"鞦",
		"鞧",
		"鰌",
		"鰍",
		"鳅",
		"鶖",
		"鹙",
		"龝"
	],
	bǐng: [
		"丙",
		"屛",
		"怲",
		"抦",
		"昞",
		"昺",
		"柄",
		"棅",
		"炳",
		"禀",
		"秉",
		"稟",
		"苪",
		"蛃",
		"邴",
		"鈵",
		"陃",
		"鞆",
		"餅",
		"餠",
		"饼"
	],
	yè: [
		"业",
		"亱",
		"僷",
		"墷",
		"夜",
		"嶪",
		"嶫",
		"抴",
		"捙",
		"擛",
		"擪",
		"擫",
		"晔",
		"曄",
		"曅",
		"曗",
		"曳",
		"曵",
		"枼",
		"枽",
		"業",
		"洂",
		"液",
		"澲",
		"烨",
		"燁",
		"爗",
		"璍",
		"皣",
		"瞱",
		"瞸",
		"礏",
		"腋",
		"葉",
		"謁",
		"谒",
		"邺",
		"鄴",
		"鍱",
		"鐷",
		"靥",
		"靨",
		"頁",
		"页",
		"餣",
		"饁",
		"馌",
		"驜",
		"鵺",
		"鸈"
	],
	cóng: [
		"丛",
		"从",
		"叢",
		"婃",
		"孮",
		"従",
		"徔",
		"徖",
		"悰",
		"樷",
		"欉",
		"淙",
		"灇",
		"爜",
		"琮",
		"藂",
		"誴",
		"賨",
		"賩",
		"錝"
	],
	dōng: [
		"东",
		"倲",
		"冬",
		"咚",
		"埬",
		"岽",
		"崬",
		"徚",
		"昸",
		"東",
		"氡",
		"氭",
		"涷",
		"笗",
		"苳",
		"菄",
		"蝀",
		"鮗",
		"鯟",
		"鶇",
		"鶫",
		"鸫",
		"鼕",
		"𬟽"
	],
	sī: [
		"丝",
		"俬",
		"凘",
		"厮",
		"司",
		"咝",
		"嘶",
		"噝",
		"媤",
		"廝",
		"恖",
		"撕",
		"斯",
		"楒",
		"泀",
		"澌",
		"燍",
		"禗",
		"禠",
		"私",
		"糹",
		"絲",
		"緦",
		"纟",
		"缌",
		"罳",
		"蕬",
		"虒",
		"蛳",
		"蜤",
		"螄",
		"蟖",
		"蟴",
		"鉰",
		"銯",
		"鍶",
		"鐁",
		"锶",
		"颸",
		"飔",
		"騦",
		"鷥",
		"鸶",
		"鼶",
		"㟃"
	],
	chéng: [
		"丞",
		"呈",
		"城",
		"埕",
		"堘",
		"塍",
		"塖",
		"宬",
		"峸",
		"惩",
		"懲",
		"成",
		"承",
		"挰",
		"掁",
		"揨",
		"枨",
		"棖",
		"橙",
		"檙",
		"洆",
		"溗",
		"澂",
		"珵",
		"珹",
		"畻",
		"程",
		"窚",
		"筬",
		"絾",
		"脭",
		"荿",
		"誠",
		"诚",
		"郕",
		"酲",
		"鋮",
		"铖",
		"騬",
		"鯎"
	],
	diū: [
		"丟",
		"丢",
		"銩",
		"铥"
	],
	liǎng: [
		"両",
		"两",
		"兩",
		"唡",
		"啢",
		"掚",
		"緉",
		"脼",
		"蜽",
		"裲",
		"魉",
		"魎",
		"𬜯"
	],
	yǒu: [
		"丣",
		"卣",
		"友",
		"梄",
		"湵",
		"牖",
		"禉",
		"羑",
		"聈",
		"苃",
		"莠",
		"蜏",
		"酉",
		"銪",
		"铕",
		"黝"
	],
	yán: [
		"严",
		"厳",
		"啱",
		"喦",
		"嚴",
		"塩",
		"壛",
		"壧",
		"妍",
		"姸",
		"娫",
		"娮",
		"岩",
		"嵒",
		"嵓",
		"巌",
		"巖",
		"巗",
		"延",
		"揅",
		"昖",
		"楌",
		"檐",
		"櫩",
		"欕",
		"沿",
		"炎",
		"炏",
		"狿",
		"琂",
		"盐",
		"碞",
		"筵",
		"簷",
		"莚",
		"蔅",
		"虤",
		"蜒",
		"言",
		"訁",
		"訮",
		"詽",
		"讠",
		"郔",
		"閆",
		"閻",
		"闫",
		"阎",
		"顏",
		"顔",
		"颜",
		"鹽",
		"麣",
		"𫄧"
	],
	bìng: [
		"並",
		"併",
		"倂",
		"傡",
		"垪",
		"摒",
		"栤",
		"病",
		"窉",
		"竝",
		"誁",
		"靐",
		"鮩"
	],
	"sàng sāng": ["丧"],
	gǔn: [
		"丨",
		"惃",
		"滚",
		"滾",
		"磙",
		"緄",
		"绲",
		"蓘",
		"蔉",
		"衮",
		"袞",
		"輥",
		"辊",
		"鮌",
		"鯀",
		"鲧"
	],
	jiū: [
		"丩",
		"勼",
		"啾",
		"揪",
		"揫",
		"朻",
		"究",
		"糾",
		"纠",
		"萛",
		"赳",
		"阄",
		"鬏",
		"鬮",
		"鳩",
		"鸠"
	],
	"gè gě": [
		"个",
		"個",
		"各"
	],
	yā: [
		"丫",
		"圧",
		"孲",
		"庘",
		"押",
		"枒",
		"桠",
		"椏",
		"錏",
		"鐚",
		"鴉",
		"鴨",
		"鵶",
		"鸦",
		"鸭"
	],
	pán: [
		"丬",
		"媻",
		"幋",
		"槃",
		"洀",
		"瀊",
		"爿",
		"盘",
		"盤",
		"磐",
		"縏",
		"蒰",
		"蟠",
		"蹒",
		"蹣",
		"鎜",
		"鞶"
	],
	"zhōng zhòng": ["中"],
	jǐ: [
		"丮",
		"妀",
		"己",
		"戟",
		"挤",
		"掎",
		"撠",
		"擠",
		"橶",
		"泲",
		"犱",
		"脊",
		"虮",
		"蟣",
		"魢",
		"鱾",
		"麂"
	],
	jiè: [
		"丯",
		"介",
		"借",
		"唶",
		"堺",
		"屆",
		"届",
		"岕",
		"庎",
		"徣",
		"戒",
		"楐",
		"犗",
		"玠",
		"琾",
		"界",
		"畍",
		"疥",
		"砎",
		"蚧",
		"蛶",
		"衸",
		"褯",
		"誡",
		"诫",
		"鎅",
		"骱",
		"魪"
	],
	fēng: [
		"丰",
		"仹",
		"偑",
		"僼",
		"凨",
		"凬",
		"凮",
		"妦",
		"寷",
		"封",
		"峯",
		"峰",
		"崶",
		"枫",
		"楓",
		"檒",
		"沣",
		"沨",
		"渢",
		"灃",
		"烽",
		"犎",
		"猦",
		"琒",
		"疯",
		"瘋",
		"盽",
		"砜",
		"碸",
		"篈",
		"蘴",
		"蜂",
		"蠭",
		"豐",
		"鄷",
		"酆",
		"鋒",
		"鎽",
		"鏠",
		"锋",
		"霻",
		"靊",
		"飌",
		"麷"
	],
	"guàn kuàng": ["丱"],
	chuàn: [
		"串",
		"汌",
		"玔",
		"賗",
		"釧",
		"钏"
	],
	chǎn: [
		"丳",
		"产",
		"冁",
		"剷",
		"囅",
		"嵼",
		"旵",
		"浐",
		"滻",
		"灛",
		"產",
		"産",
		"簅",
		"蒇",
		"蕆",
		"諂",
		"譂",
		"讇",
		"谄",
		"鏟",
		"铲",
		"閳",
		"闡",
		"阐",
		"骣",
		"𬊤"
	],
	lín: [
		"临",
		"冧",
		"壣",
		"崊",
		"嶙",
		"斴",
		"晽",
		"暽",
		"林",
		"潾",
		"瀶",
		"燐",
		"琳",
		"璘",
		"瞵",
		"碄",
		"磷",
		"粦",
		"粼",
		"繗",
		"翷",
		"臨",
		"轔",
		"辚",
		"遴",
		"邻",
		"鄰",
		"鏻",
		"阾",
		"隣",
		"霖",
		"驎",
		"鱗",
		"鳞",
		"麐",
		"麟",
		"𬴊",
		"𬭸"
	],
	zhuó: [
		"丵",
		"劅",
		"卓",
		"啄",
		"圴",
		"妰",
		"娺",
		"撯",
		"擆",
		"擢",
		"斫",
		"斮",
		"斱",
		"斲",
		"斵",
		"晫",
		"椓",
		"浊",
		"浞",
		"濁",
		"灼",
		"烵",
		"琸",
		"硺",
		"禚",
		"窡",
		"籗",
		"籱",
		"罬",
		"茁",
		"蠗",
		"蠿",
		"諁",
		"諑",
		"謶",
		"诼",
		"酌",
		"鐲",
		"镯",
		"鵫",
		"鷟",
		"䓬",
		"𬸦"
	],
	zhǔ: [
		"丶",
		"主",
		"劯",
		"嘱",
		"囑",
		"宔",
		"帾",
		"拄",
		"渚",
		"濐",
		"煑",
		"煮",
		"燝",
		"瞩",
		"矚",
		"罜",
		"詝",
		"陼",
		"鸀",
		"麈",
		"𬣞"
	],
	bā: [
		"丷",
		"仈",
		"八",
		"叭",
		"哵",
		"夿",
		"岜",
		"巴",
		"捌",
		"朳",
		"玐",
		"疤",
		"笆",
		"粑",
		"羓",
		"芭",
		"蚆",
		"豝",
		"釟"
	],
	wán: [
		"丸",
		"刓",
		"完",
		"岏",
		"抏",
		"捖",
		"汍",
		"烷",
		"玩",
		"琓",
		"笂",
		"紈",
		"纨",
		"翫",
		"芄",
		"貦",
		"頑",
		"顽"
	],
	dān: [
		"丹",
		"勯",
		"匰",
		"単",
		"妉",
		"媅",
		"殚",
		"殫",
		"甔",
		"眈",
		"砃",
		"箪",
		"簞",
		"耼",
		"耽",
		"聃",
		"聸",
		"褝",
		"襌",
		"躭",
		"郸",
		"鄲",
		"酖",
		"頕"
	],
	"wèi wéi": ["为"],
	"jǐng dǎn": ["丼"],
	"lì lí": ["丽"],
	jǔ: [
		"举",
		"弆",
		"挙",
		"擧",
		"椇",
		"榉",
		"榘",
		"櫸",
		"欅",
		"矩",
		"筥",
		"聥",
		"舉",
		"莒",
		"蒟",
		"襷",
		"踽",
		"齟",
		"龃"
	],
	piě: [
		"丿",
		"苤",
		"鐅",
		"𬭯"
	],
	fú: [
		"乀",
		"伏",
		"俘",
		"凫",
		"刜",
		"匐",
		"咈",
		"哹",
		"垘",
		"孚",
		"岪",
		"巿",
		"帗",
		"幅",
		"幞",
		"弗",
		"彿",
		"怫",
		"扶",
		"柫",
		"栿",
		"桴",
		"氟",
		"泭",
		"浮",
		"涪",
		"澓",
		"炥",
		"玸",
		"甶",
		"畉",
		"癁",
		"祓",
		"福",
		"稪",
		"符",
		"箙",
		"紱",
		"紼",
		"絥",
		"綍",
		"绂",
		"绋",
		"罘",
		"罦",
		"翇",
		"艀",
		"芙",
		"芣",
		"苻",
		"茀",
		"茯",
		"菔",
		"葍",
		"虙",
		"蚨",
		"蜉",
		"蝠",
		"袚",
		"袱",
		"襆",
		"襥",
		"諨",
		"豧",
		"踾",
		"輻",
		"辐",
		"郛",
		"鉘",
		"鉜",
		"韍",
		"韨",
		"颫",
		"髴",
		"鮄",
		"鮲",
		"鳧",
		"鳬",
		"鴔",
		"鵩",
		"黻"
	],
	"yí jí": ["乁"],
	yì: [
		"乂",
		"义",
		"亄",
		"亦",
		"亿",
		"伇",
		"伿",
		"佾",
		"俋",
		"億",
		"兿",
		"刈",
		"劓",
		"劮",
		"勚",
		"勩",
		"匇",
		"呓",
		"呭",
		"呹",
		"唈",
		"囈",
		"圛",
		"坄",
		"垼",
		"埸",
		"奕",
		"嫕",
		"嬑",
		"寱",
		"屹",
		"峄",
		"嶧",
		"帟",
		"帠",
		"幆",
		"廙",
		"异",
		"弈",
		"弋",
		"役",
		"忆",
		"怈",
		"怿",
		"悒",
		"意",
		"憶",
		"懌",
		"懿",
		"抑",
		"挹",
		"敡",
		"易",
		"晹",
		"曀",
		"曎",
		"杙",
		"枍",
		"棭",
		"榏",
		"槸",
		"檍",
		"歝",
		"殔",
		"殪",
		"殹",
		"毅",
		"浂",
		"浥",
		"浳",
		"湙",
		"溢",
		"潩",
		"澺",
		"瀷",
		"炈",
		"焲",
		"熠",
		"熤",
		"熼",
		"燚",
		"燡",
		"燱",
		"獈",
		"玴",
		"異",
		"疫",
		"痬",
		"瘗",
		"瘞",
		"瘱",
		"癔",
		"益",
		"瞖",
		"穓",
		"竩",
		"篒",
		"縊",
		"繶",
		"繹",
		"绎",
		"缢",
		"義",
		"羿",
		"翊",
		"翌",
		"翳",
		"翼",
		"耴",
		"肄",
		"肊",
		"膉",
		"臆",
		"艗",
		"艺",
		"芅",
		"苅",
		"萟",
		"蓺",
		"薏",
		"藙",
		"藝",
		"蘙",
		"虉",
		"蜴",
		"螠",
		"衪",
		"袣",
		"裔",
		"裛",
		"褹",
		"襼",
		"訲",
		"訳",
		"詍",
		"詣",
		"誼",
		"譯",
		"議",
		"讛",
		"议",
		"译",
		"诣",
		"谊",
		"豙",
		"豛",
		"豷",
		"貖",
		"贀",
		"跇",
		"轶",
		"逸",
		"邑",
		"鄓",
		"醷",
		"釴",
		"鈠",
		"鎰",
		"鐿",
		"镒",
		"镱",
		"阣",
		"隿",
		"霬",
		"饐",
		"駅",
		"驛",
		"驿",
		"骮",
		"鮨",
		"鶂",
		"鶃",
		"鶍",
		"鷁",
		"鷊",
		"鷧",
		"鷾",
		"鸃",
		"鹝",
		"鹢",
		"黓",
		"齸",
		"𬬩",
		"㑊",
		"𫄷",
		"𬟁"
	],
	nǎi: [
		"乃",
		"倷",
		"奶",
		"嬭",
		"廼",
		"氖",
		"疓",
		"艿",
		"迺",
		"釢"
	],
	wǔ: [
		"乄",
		"五",
		"仵",
		"伍",
		"侮",
		"倵",
		"儛",
		"午",
		"啎",
		"妩",
		"娬",
		"嫵",
		"庑",
		"廡",
		"忤",
		"怃",
		"憮",
		"摀",
		"武",
		"潕",
		"熓",
		"牾",
		"玝",
		"珷",
		"瑦",
		"甒",
		"碔",
		"舞",
		"躌",
		"迕",
		"逜",
		"陚",
		"鵡",
		"鹉",
		"𣲘"
	],
	jiǔ: [
		"久",
		"乆",
		"九",
		"乣",
		"奺",
		"杦",
		"汣",
		"灸",
		"玖",
		"紤",
		"舏",
		"酒",
		"镹",
		"韭",
		"韮"
	],
	"tuō zhé": [
		"乇",
		"杔",
		"馲"
	],
	"me mó ma yāo": ["么"],
	zhī: [
		"之",
		"倁",
		"卮",
		"巵",
		"搘",
		"支",
		"栀",
		"梔",
		"椥",
		"榰",
		"汁",
		"泜",
		"疷",
		"祗",
		"祬",
		"秓",
		"稙",
		"綕",
		"肢",
		"胑",
		"胝",
		"脂",
		"芝",
		"蘵",
		"蜘",
		"衼",
		"隻",
		"鳷",
		"鴲",
		"鼅",
		"𦭜"
	],
	"wū wù": ["乌"],
	zhà: [
		"乍",
		"咤",
		"宱",
		"搾",
		"榨",
		"溠",
		"痄",
		"蚱",
		"詐",
		"诈",
		"醡",
		"霅",
		"䃎"
	],
	hū: [
		"乎",
		"乯",
		"匢",
		"匫",
		"呼",
		"唿",
		"嘑",
		"垀",
		"寣",
		"幠",
		"忽",
		"惚",
		"昒",
		"歑",
		"泘",
		"淴",
		"滹",
		"烀",
		"苸",
		"虍",
		"虖",
		"謼",
		"軤",
		"轷",
		"雐"
	],
	fá: [
		"乏",
		"伐",
		"傠",
		"坺",
		"垡",
		"墢",
		"姂",
		"栰",
		"浌",
		"瞂",
		"笩",
		"筏",
		"罚",
		"罰",
		"罸",
		"藅",
		"閥",
		"阀"
	],
	"lè yuè yào lào": ["乐", "樂"],
	yín: [
		"乑",
		"吟",
		"噖",
		"嚚",
		"圁",
		"垠",
		"夤",
		"婬",
		"寅",
		"峾",
		"崟",
		"崯",
		"檭",
		"殥",
		"泿",
		"淫",
		"滛",
		"烎",
		"犾",
		"狺",
		"璌",
		"硍",
		"碒",
		"荶",
		"蔩",
		"訔",
		"訚",
		"訡",
		"誾",
		"鄞",
		"鈝",
		"銀",
		"银",
		"霪",
		"鷣",
		"齦"
	],
	pīng: [
		"乒",
		"俜",
		"娉",
		"涄",
		"甹",
		"砯",
		"聠",
		"艵",
		"頩"
	],
	pāng: [
		"乓",
		"滂",
		"胮",
		"膖",
		"雱",
		"霶"
	],
	qiáo: [
		"乔",
		"侨",
		"僑",
		"嫶",
		"憔",
		"桥",
		"槗",
		"樵",
		"橋",
		"櫵",
		"犞",
		"瞧",
		"硚",
		"礄",
		"荍",
		"荞",
		"蕎",
		"藮",
		"譙",
		"趫",
		"鐈",
		"鞒",
		"鞽",
		"顦"
	],
	hǔ: [
		"乕",
		"琥",
		"萀",
		"虎",
		"虝",
		"錿",
		"鯱"
	],
	guāi: ["乖"],
	"chéng shèng": [
		"乗",
		"乘",
		"娍"
	],
	yǐ: [
		"乙",
		"乛",
		"以",
		"倚",
		"偯",
		"嬟",
		"崺",
		"已",
		"庡",
		"扆",
		"攺",
		"敼",
		"旑",
		"旖",
		"檥",
		"矣",
		"礒",
		"笖",
		"舣",
		"艤",
		"苡",
		"苢",
		"蚁",
		"螘",
		"蟻",
		"裿",
		"踦",
		"輢",
		"轙",
		"逘",
		"酏",
		"釔",
		"鈘",
		"鉯",
		"钇",
		"顗",
		"鳦",
		"齮",
		"𫖮",
		"𬺈"
	],
	"háo yǐ": ["乚"],
	"niè miē": ["乜"],
	qǐ: [
		"乞",
		"企",
		"启",
		"唘",
		"啓",
		"啔",
		"啟",
		"婍",
		"屺",
		"杞",
		"棨",
		"玘",
		"盀",
		"綺",
		"绮",
		"芑",
		"諬",
		"起",
		"邔",
		"闙"
	],
	yě: [
		"也",
		"冶",
		"嘢",
		"埜",
		"壄",
		"漜",
		"野"
	],
	xí: [
		"习",
		"喺",
		"媳",
		"嶍",
		"席",
		"椺",
		"檄",
		"漝",
		"習",
		"蓆",
		"袭",
		"襲",
		"覡",
		"觋",
		"謵",
		"趘",
		"郋",
		"鎴",
		"隰",
		"霫",
		"飁",
		"騱",
		"騽",
		"驨",
		"鰼",
		"鳛",
		"𠅤",
		"𫘬"
	],
	xiāng: [
		"乡",
		"厢",
		"廂",
		"忀",
		"楿",
		"欀",
		"湘",
		"瓖",
		"稥",
		"箱",
		"緗",
		"缃",
		"膷",
		"芗",
		"萫",
		"葙",
		"薌",
		"襄",
		"郷",
		"鄉",
		"鄊",
		"鄕",
		"鑲",
		"镶",
		"香",
		"驤",
		"骧",
		"鱜",
		"麘",
		"𬙋"
	],
	shū: [
		"书",
		"倏",
		"倐",
		"儵",
		"叔",
		"姝",
		"尗",
		"抒",
		"掓",
		"摅",
		"攄",
		"書",
		"枢",
		"梳",
		"樞",
		"殊",
		"殳",
		"毹",
		"毺",
		"淑",
		"瀭",
		"焂",
		"疎",
		"疏",
		"紓",
		"綀",
		"纾",
		"舒",
		"菽",
		"蔬",
		"踈",
		"軗",
		"輸",
		"输",
		"鄃",
		"陎",
		"鮛",
		"鵨"
	],
	dǒu: [
		"乧",
		"抖",
		"枓",
		"蚪",
		"鈄",
		"阧",
		"陡"
	],
	shǐ: [
		"乨",
		"使",
		"兘",
		"史",
		"始",
		"宩",
		"屎",
		"榁",
		"矢",
		"笶",
		"豕",
		"鉂",
		"駛",
		"驶"
	],
	jī: [
		"乩",
		"僟",
		"击",
		"刉",
		"刏",
		"剞",
		"叽",
		"唧",
		"喞",
		"嗘",
		"嘰",
		"圾",
		"基",
		"墼",
		"姬",
		"屐",
		"嵆",
		"嵇",
		"撃",
		"擊",
		"朞",
		"机",
		"枅",
		"樭",
		"機",
		"毄",
		"激",
		"犄",
		"玑",
		"璣",
		"畸",
		"畿",
		"癪",
		"矶",
		"磯",
		"积",
		"積",
		"笄",
		"筓",
		"箕",
		"簊",
		"緁",
		"羁",
		"羇",
		"羈",
		"耭",
		"肌",
		"芨",
		"虀",
		"覉",
		"覊",
		"譏",
		"譤",
		"讥",
		"賫",
		"賷",
		"赍",
		"跻",
		"踑",
		"躋",
		"躸",
		"銈",
		"錤",
		"鐖",
		"鑇",
		"鑙",
		"隮",
		"雞",
		"鞿",
		"韲",
		"飢",
		"饑",
		"饥",
		"魕",
		"鳮",
		"鶏",
		"鶺",
		"鷄",
		"鸄",
		"鸡",
		"齎",
		"齏",
		"齑",
		"𬯀",
		"𫓯",
		"𫓹",
		"𫌀"
	],
	náng: [
		"乪",
		"嚢",
		"欜",
		"蠰",
		"饢"
	],
	jiā: [
		"乫",
		"佳",
		"傢",
		"加",
		"嘉",
		"抸",
		"枷",
		"梜",
		"毠",
		"泇",
		"浃",
		"浹",
		"犌",
		"猳",
		"珈",
		"痂",
		"笳",
		"糘",
		"耞",
		"腵",
		"葭",
		"袈",
		"豭",
		"貑",
		"跏",
		"迦",
		"鉫",
		"鎵",
		"镓",
		"鴐",
		"麚",
		"𬂩"
	],
	jù: [
		"乬",
		"倨",
		"倶",
		"具",
		"剧",
		"劇",
		"勮",
		"埧",
		"埾",
		"壉",
		"姖",
		"屦",
		"屨",
		"岠",
		"巨",
		"巪",
		"怇",
		"惧",
		"愳",
		"懅",
		"懼",
		"拒",
		"拠",
		"昛",
		"歫",
		"洰",
		"澽",
		"炬",
		"烥",
		"犋",
		"秬",
		"窭",
		"窶",
		"簴",
		"粔",
		"耟",
		"聚",
		"虡",
		"蚷",
		"詎",
		"讵",
		"豦",
		"距",
		"踞",
		"躆",
		"遽",
		"邭",
		"醵",
		"鉅",
		"鐻",
		"钜",
		"颶",
		"飓",
		"駏",
		"鮔"
	],
	shí: [
		"乭",
		"十",
		"埘",
		"塒",
		"姼",
		"实",
		"実",
		"寔",
		"實",
		"峕",
		"嵵",
		"时",
		"旹",
		"時",
		"榯",
		"湜",
		"溡",
		"炻",
		"祏",
		"竍",
		"蚀",
		"蝕",
		"辻",
		"遈",
		"鉐",
		"飠",
		"饣",
		"鮖",
		"鰣",
		"鲥",
		"鼫",
		"鼭"
	],
	mǎo: [
		"乮",
		"冇",
		"卯",
		"峁",
		"戼",
		"昴",
		"泖",
		"笷",
		"蓩",
		"鉚",
		"铆"
	],
	mǎi: [
		"买",
		"嘪",
		"荬",
		"蕒",
		"買",
		"鷶"
	],
	luàn: [
		"乱",
		"亂",
		"釠"
	],
	rǔ: [
		"乳",
		"擩",
		"汝",
		"肗",
		"辱",
		"鄏"
	],
	xué: [
		"乴",
		"学",
		"學",
		"峃",
		"嶨",
		"斈",
		"泶",
		"澩",
		"燢",
		"穴",
		"茓",
		"袕",
		"踅",
		"鷽",
		"鸴"
	],
	yǎn: [
		"䶮",
		"乵",
		"俨",
		"偃",
		"儼",
		"兖",
		"兗",
		"厣",
		"厴",
		"噞",
		"孍",
		"嵃",
		"巘",
		"巚",
		"弇",
		"愝",
		"戭",
		"扊",
		"抁",
		"掩",
		"揜",
		"曮",
		"椼",
		"檿",
		"沇",
		"渷",
		"演",
		"琰",
		"甗",
		"眼",
		"罨",
		"萒",
		"蝘",
		"衍",
		"褗",
		"躽",
		"遃",
		"郾",
		"隒",
		"顩",
		"魇",
		"魘",
		"鰋",
		"鶠",
		"黡",
		"黤",
		"黬",
		"黭",
		"黶",
		"鼴",
		"鼹",
		"齴",
		"龑",
		"𬸘",
		"𬙂",
		"𪩘"
	],
	fǔ: [
		"乶",
		"俌",
		"俛",
		"俯",
		"府",
		"弣",
		"抚",
		"拊",
		"撫",
		"斧",
		"椨",
		"滏",
		"焤",
		"甫",
		"盙",
		"簠",
		"腐",
		"腑",
		"蜅",
		"輔",
		"辅",
		"郙",
		"釜",
		"釡",
		"阝",
		"頫",
		"鬴",
		"黼",
		"㕮",
		"𫖯"
	],
	shā: [
		"乷",
		"唦",
		"杀",
		"桬",
		"殺",
		"毮",
		"猀",
		"痧",
		"砂",
		"硰",
		"紗",
		"繺",
		"纱",
		"蔱",
		"裟",
		"鎩",
		"铩",
		"閷",
		"髿",
		"魦",
		"鯊",
		"鯋",
		"鲨"
	],
	nǎ: ["乸", "雫"],
	qián: [
		"乹",
		"亁",
		"仱",
		"偂",
		"前",
		"墘",
		"媊",
		"岒",
		"拑",
		"掮",
		"榩",
		"橬",
		"歬",
		"潛",
		"潜",
		"濳",
		"灊",
		"箝",
		"葥",
		"虔",
		"軡",
		"鈐",
		"鉗",
		"銭",
		"錢",
		"鎆",
		"钤",
		"钱",
		"钳",
		"靬",
		"騚",
		"騝",
		"鰬",
		"黔",
		"黚"
	],
	suǒ: [
		"乺",
		"唢",
		"嗩",
		"所",
		"暛",
		"溑",
		"溹",
		"琐",
		"琑",
		"瑣",
		"索",
		"褨",
		"鎖",
		"鎻",
		"鏁",
		"锁"
	],
	yú: [
		"乻",
		"于",
		"亐",
		"伃",
		"余",
		"堣",
		"堬",
		"妤",
		"娛",
		"娯",
		"娱",
		"嬩",
		"崳",
		"嵎",
		"嵛",
		"愚",
		"扵",
		"揄",
		"旟",
		"楡",
		"楰",
		"榆",
		"欤",
		"歈",
		"歟",
		"歶",
		"渔",
		"渝",
		"湡",
		"漁",
		"澞",
		"牏",
		"狳",
		"玗",
		"玙",
		"瑜",
		"璵",
		"盂",
		"睮",
		"窬",
		"竽",
		"籅",
		"羭",
		"腴",
		"臾",
		"舁",
		"舆",
		"艅",
		"茰",
		"萮",
		"萸",
		"蕍",
		"蘛",
		"虞",
		"虶",
		"蝓",
		"螸",
		"衧",
		"褕",
		"覦",
		"觎",
		"諛",
		"謣",
		"谀",
		"踰",
		"輿",
		"轝",
		"逾",
		"邘",
		"酑",
		"鍝",
		"隅",
		"雓",
		"雩",
		"餘",
		"馀",
		"騟",
		"骬",
		"髃",
		"魚",
		"魣",
		"鮽",
		"鯲",
		"鰅",
		"鱼",
		"鷠",
		"鸆",
		"齵"
	],
	zhù: [
		"乼",
		"伫",
		"佇",
		"住",
		"坾",
		"墸",
		"壴",
		"嵀",
		"拀",
		"杼",
		"柱",
		"樦",
		"殶",
		"注",
		"炷",
		"疰",
		"眝",
		"祝",
		"祩",
		"竚",
		"筯",
		"箸",
		"篫",
		"簗",
		"紵",
		"紸",
		"纻",
		"羜",
		"翥",
		"苎",
		"莇",
		"蛀",
		"註",
		"貯",
		"贮",
		"跓",
		"軴",
		"鉒",
		"鋳",
		"鑄",
		"铸",
		"馵",
		"駐",
		"驻"
	],
	zhě: [
		"乽",
		"者",
		"褶",
		"襵",
		"赭",
		"踷",
		"鍺",
		"锗"
	],
	"qián gān": ["乾"],
	"zhì luàn": ["乿"],
	guī: [
		"亀",
		"圭",
		"妫",
		"媯",
		"嫢",
		"嬀",
		"帰",
		"归",
		"摫",
		"椝",
		"槻",
		"槼",
		"櫷",
		"歸",
		"珪",
		"瑰",
		"璝",
		"瓌",
		"皈",
		"瞡",
		"硅",
		"茥",
		"蘬",
		"規",
		"规",
		"邽",
		"郌",
		"閨",
		"闺",
		"騩",
		"鬶",
		"鬹"
	],
	"lǐn lìn": ["亃"],
	jué: [
		"亅",
		"决",
		"刔",
		"劂",
		"匷",
		"厥",
		"噊",
		"孒",
		"孓",
		"崛",
		"崫",
		"嶥",
		"彏",
		"憠",
		"憰",
		"戄",
		"抉",
		"挗",
		"掘",
		"攫",
		"桷",
		"橛",
		"橜",
		"欮",
		"氒",
		"決",
		"灍",
		"焳",
		"熦",
		"爑",
		"爴",
		"爵",
		"獗",
		"玃",
		"玦",
		"玨",
		"珏",
		"瑴",
		"瘚",
		"矍",
		"矡",
		"砄",
		"絕",
		"絶",
		"绝",
		"臄",
		"芵",
		"蕝",
		"蕨",
		"虳",
		"蟨",
		"蟩",
		"觖",
		"觮",
		"觼",
		"訣",
		"譎",
		"诀",
		"谲",
		"貜",
		"赽",
		"趉",
		"蹷",
		"躩",
		"鈌",
		"鐍",
		"鐝",
		"钁",
		"镢",
		"鴂",
		"鴃",
		"鷢",
		"𫘝",
		"㵐",
		"𫔎"
	],
	"le liǎo": ["了"],
	"gè mā": ["亇"],
	"yǔ yú": ["予", "懙"],
	zhēng: [
		"争",
		"佂",
		"凧",
		"姃",
		"媜",
		"峥",
		"崝",
		"崢",
		"征",
		"徰",
		"炡",
		"烝",
		"爭",
		"狰",
		"猙",
		"癥",
		"眐",
		"睁",
		"睜",
		"筝",
		"箏",
		"篜",
		"聇",
		"脀",
		"蒸",
		"踭",
		"鉦",
		"錚",
		"鏳",
		"鬇"
	],
	èr: [
		"二",
		"刵",
		"咡",
		"弍",
		"弐",
		"樲",
		"誀",
		"貮",
		"貳",
		"贰",
		"髶"
	],
	chù: [
		"亍",
		"傗",
		"儊",
		"怵",
		"憷",
		"搐",
		"斶",
		"歜",
		"珿",
		"琡",
		"矗",
		"竌",
		"絀",
		"绌",
		"臅",
		"触",
		"觸",
		"豖",
		"鄐",
		"閦",
		"黜"
	],
	kuī: [
		"亏",
		"刲",
		"岿",
		"巋",
		"盔",
		"窥",
		"窺",
		"聧",
		"虧",
		"闚",
		"顝"
	],
	yún: [
		"云",
		"伝",
		"勻",
		"匀",
		"囩",
		"妘",
		"愪",
		"抣",
		"昀",
		"橒",
		"沄",
		"涢",
		"溳",
		"澐",
		"熉",
		"畇",
		"秐",
		"筼",
		"篔",
		"紜",
		"縜",
		"纭",
		"耘",
		"芸",
		"蒷",
		"蕓",
		"郧",
		"鄖",
		"鋆",
		"雲"
	],
	hù: [
		"互",
		"冱",
		"嗀",
		"嚛",
		"婟",
		"嫭",
		"嫮",
		"岵",
		"帍",
		"弖",
		"怙",
		"戶",
		"户",
		"戸",
		"戽",
		"扈",
		"护",
		"昈",
		"槴",
		"沍",
		"沪",
		"滬",
		"熩",
		"瓠",
		"祜",
		"笏",
		"簄",
		"粐",
		"綔",
		"蔰",
		"護",
		"豰",
		"鄠",
		"鍙",
		"頀",
		"鱯",
		"鳠",
		"鳸",
		"鸌",
		"鹱"
	],
	qí: [
		"亓",
		"剘",
		"埼",
		"岐",
		"岓",
		"崎",
		"嵜",
		"愭",
		"掑",
		"斉",
		"斊",
		"旂",
		"旗",
		"棊",
		"棋",
		"檱",
		"櫀",
		"歧",
		"淇",
		"濝",
		"猉",
		"玂",
		"琦",
		"琪",
		"璂",
		"畦",
		"疧",
		"碁",
		"碕",
		"祁",
		"祈",
		"祺",
		"禥",
		"竒",
		"簯",
		"簱",
		"籏",
		"粸",
		"綥",
		"綦",
		"肵",
		"脐",
		"臍",
		"艩",
		"芪",
		"萁",
		"萕",
		"蕲",
		"藄",
		"蘄",
		"蚑",
		"蚚",
		"蛴",
		"蜝",
		"蜞",
		"螧",
		"蠐",
		"褀",
		"軝",
		"鄿",
		"釮",
		"錡",
		"锜",
		"陭",
		"頎",
		"颀",
		"騎",
		"騏",
		"騹",
		"骐",
		"骑",
		"鬐",
		"鬿",
		"鯕",
		"鰭",
		"鲯",
		"鳍",
		"鵸",
		"鶀",
		"麒",
		"麡",
		"𨙸",
		"𬨂",
		"䓫"
	],
	jǐng: [
		"井",
		"儆",
		"刭",
		"剄",
		"坓",
		"宑",
		"幜",
		"憬",
		"暻",
		"殌",
		"汫",
		"汬",
		"澋",
		"璄",
		"璟",
		"璥",
		"穽",
		"肼",
		"蟼",
		"警",
		"阱",
		"頚",
		"頸"
	],
	sì: [
		"亖",
		"佀",
		"価",
		"儩",
		"兕",
		"嗣",
		"四",
		"姒",
		"娰",
		"孠",
		"寺",
		"巳",
		"柶",
		"榹",
		"汜",
		"泗",
		"泤",
		"洍",
		"洠",
		"涘",
		"瀃",
		"牭",
		"祀",
		"禩",
		"竢",
		"笥",
		"耜",
		"肂",
		"肆",
		"蕼",
		"覗",
		"貄",
		"釲",
		"鈶",
		"鈻",
		"飤",
		"飼",
		"饲",
		"駟",
		"騃",
		"驷"
	],
	suì: [
		"亗",
		"嬘",
		"岁",
		"嵗",
		"旞",
		"檖",
		"歲",
		"歳",
		"澻",
		"煫",
		"燧",
		"璲",
		"砕",
		"碎",
		"祟",
		"禭",
		"穂",
		"穗",
		"穟",
		"繀",
		"繐",
		"繸",
		"襚",
		"誶",
		"譢",
		"谇",
		"賥",
		"邃",
		"鐆",
		"鐩",
		"隧",
		"韢",
		"𫟦",
		"𬭼"
	],
	gèn: [
		"亘",
		"亙",
		"揯",
		"搄",
		"茛"
	],
	yà: [
		"亚",
		"亜",
		"俹",
		"冴",
		"劜",
		"圔",
		"圠",
		"埡",
		"娅",
		"婭",
		"揠",
		"氩",
		"氬",
		"犽",
		"砑",
		"稏",
		"聐",
		"襾",
		"覀",
		"訝",
		"讶",
		"迓",
		"齾"
	],
	"xiē suò": ["些"],
	"qí zhāi": ["亝", "齊"],
	"yā yà": [
		"亞",
		"压",
		"垭",
		"壓",
		"铔"
	],
	"jí qì": ["亟", "焏"],
	tóu: [
		"亠",
		"投",
		"頭",
		"骰"
	],
	"wáng wú": ["亡"],
	"kàng háng gāng": ["亢"],
	dà: ["亣", "眔"],
	jiāo: [
		"交",
		"僬",
		"娇",
		"嬌",
		"峧",
		"嶕",
		"嶣",
		"憍",
		"椒",
		"浇",
		"澆",
		"焦",
		"礁",
		"穚",
		"簥",
		"胶",
		"膠",
		"膲",
		"茭",
		"茮",
		"蕉",
		"虠",
		"蛟",
		"蟭",
		"跤",
		"轇",
		"郊",
		"鐎",
		"驕",
		"骄",
		"鮫",
		"鲛",
		"鵁",
		"鷦",
		"鷮",
		"鹪",
		"䴔"
	],
	hài: [
		"亥",
		"嗐",
		"害",
		"氦",
		"餀",
		"饚",
		"駭",
		"駴",
		"骇"
	],
	"hēng pēng": ["亨"],
	mǔ: [
		"亩",
		"姆",
		"峔",
		"拇",
		"母",
		"牡",
		"牳",
		"畂",
		"畆",
		"畒",
		"畝",
		"畞",
		"畮",
		"砪",
		"胟",
		"踇",
		"鉧",
		"𬭁",
		"𧿹"
	],
	ye: ["亪"],
	xiǎng: [
		"享",
		"亯",
		"响",
		"想",
		"晑",
		"蚃",
		"蠁",
		"響",
		"飨",
		"餉",
		"饗",
		"饷",
		"鮝",
		"鯗",
		"鱶",
		"鲞"
	],
	jīng: [
		"京",
		"亰",
		"兢",
		"坕",
		"坙",
		"婛",
		"惊",
		"旌",
		"旍",
		"晶",
		"橸",
		"泾",
		"涇",
		"猄",
		"睛",
		"秔",
		"稉",
		"粳",
		"精",
		"経",
		"經",
		"綡",
		"聙",
		"腈",
		"茎",
		"荆",
		"荊",
		"菁",
		"葏",
		"驚",
		"鯨",
		"鲸",
		"鶁",
		"鶄",
		"麖",
		"麠",
		"鼱",
		"䴖"
	],
	tíng: [
		"亭",
		"停",
		"婷",
		"嵉",
		"庭",
		"廷",
		"楟",
		"榳",
		"筳",
		"聤",
		"莛",
		"葶",
		"蜓",
		"蝏",
		"諪",
		"邒",
		"霆",
		"鼮",
		"䗴"
	],
	liàng: [
		"亮",
		"喨",
		"悢",
		"晾",
		"湸",
		"諒",
		"谅",
		"輌",
		"輛",
		"辆",
		"鍄"
	],
	"qīn qìng": ["亲", "親"],
	bó: [
		"亳",
		"仢",
		"侼",
		"僰",
		"博",
		"帛",
		"愽",
		"懪",
		"挬",
		"搏",
		"欂",
		"浡",
		"淿",
		"渤",
		"煿",
		"牔",
		"狛",
		"瓝",
		"礴",
		"秡",
		"箔",
		"簙",
		"糪",
		"胉",
		"脖",
		"膊",
		"舶",
		"艊",
		"萡",
		"葧",
		"袯",
		"襏",
		"襮",
		"謈",
		"踣",
		"郣",
		"鈸",
		"鉑",
		"鋍",
		"鎛",
		"鑮",
		"钹",
		"铂",
		"镈",
		"餺",
		"馎",
		"馛",
		"馞",
		"駁",
		"駮",
		"驳",
		"髆",
		"鵓",
		"鹁"
	],
	yòu: [
		"亴",
		"佑",
		"佦",
		"侑",
		"又",
		"右",
		"哊",
		"唀",
		"囿",
		"姷",
		"宥",
		"峟",
		"幼",
		"狖",
		"祐",
		"蚴",
		"誘",
		"诱",
		"貁",
		"迶",
		"酭",
		"釉",
		"鼬"
	],
	xiè: [
		"亵",
		"伳",
		"偞",
		"偰",
		"僁",
		"卨",
		"卸",
		"噧",
		"塮",
		"夑",
		"媟",
		"屑",
		"屧",
		"廨",
		"徢",
		"懈",
		"暬",
		"械",
		"榍",
		"榭",
		"泻",
		"洩",
		"渫",
		"澥",
		"瀉",
		"瀣",
		"灺",
		"炧",
		"炨",
		"燮",
		"爕",
		"獬",
		"祄",
		"禼",
		"糏",
		"紲",
		"絏",
		"絬",
		"繲",
		"纈",
		"绁",
		"缷",
		"薢",
		"薤",
		"蟹",
		"蠏",
		"褉",
		"褻",
		"謝",
		"谢",
		"躞",
		"邂",
		"靾",
		"韰",
		"齂",
		"齘",
		"齛",
		"齥",
		"𬹼",
		"𤫉"
	],
	"dǎn dàn": ["亶", "馾"],
	lián: [
		"亷",
		"劆",
		"匲",
		"匳",
		"嗹",
		"噒",
		"奁",
		"奩",
		"嫾",
		"帘",
		"廉",
		"怜",
		"憐",
		"涟",
		"漣",
		"濂",
		"濓",
		"瀮",
		"熑",
		"燫",
		"簾",
		"籢",
		"籨",
		"縺",
		"翴",
		"联",
		"聨",
		"聫",
		"聮",
		"聯",
		"臁",
		"莲",
		"蓮",
		"薕",
		"螊",
		"蠊",
		"裢",
		"褳",
		"覝",
		"謰",
		"蹥",
		"连",
		"連",
		"鎌",
		"鐮",
		"镰",
		"鬑",
		"鰱",
		"鲢"
	],
	duǒ: [
		"亸",
		"哚",
		"嚲",
		"埵",
		"崜",
		"朵",
		"朶",
		"綞",
		"缍",
		"趓",
		"躱",
		"躲",
		"軃"
	],
	"wěi mén": ["亹", "斖"],
	rén: [
		"人",
		"亻",
		"仁",
		"壬",
		"忈",
		"忎",
		"朲",
		"秂",
		"芢",
		"魜",
		"鵀"
	],
	jí: [
		"亼",
		"亽",
		"伋",
		"佶",
		"偮",
		"卙",
		"即",
		"卽",
		"及",
		"叝",
		"吉",
		"堲",
		"塉",
		"姞",
		"嫉",
		"岌",
		"嵴",
		"嶯",
		"彶",
		"忣",
		"急",
		"愱",
		"戢",
		"揤",
		"极",
		"棘",
		"楫",
		"極",
		"槉",
		"檝",
		"殛",
		"汲",
		"湒",
		"潗",
		"疾",
		"瘠",
		"皍",
		"笈",
		"箿",
		"籍",
		"級",
		"级",
		"膌",
		"艥",
		"蒺",
		"蕀",
		"蕺",
		"蝍",
		"螏",
		"襋",
		"觙",
		"谻",
		"踖",
		"蹐",
		"躤",
		"輯",
		"轚",
		"辑",
		"郆",
		"銡",
		"鍓",
		"鏶",
		"集",
		"雧",
		"霵",
		"鹡",
		"㴔"
	],
	wáng: [
		"亾",
		"仼",
		"兦",
		"莣",
		"蚟"
	],
	"shén shí": ["什"],
	lè: [
		"仂",
		"叻",
		"忇",
		"氻",
		"泐",
		"玏",
		"砳",
		"簕",
		"艻",
		"阞",
		"韷",
		"餎",
		"鰳",
		"鱳",
		"鳓"
	],
	dīng: [
		"仃",
		"叮",
		"帄",
		"玎",
		"疔",
		"盯",
		"耵",
		"虰",
		"靪"
	],
	zè: [
		"仄",
		"崱",
		"庂",
		"捑",
		"昃",
		"昗",
		"汄"
	],
	"jǐn jìn": [
		"仅",
		"僅",
		"嫤"
	],
	"pú pū": ["仆"],
	"chóu qiú": ["仇"],
	zhǎng: [
		"仉",
		"幥",
		"掌",
		"礃"
	],
	jīn: [
		"今",
		"堻",
		"巾",
		"惍",
		"斤",
		"津",
		"珒",
		"琻",
		"璡",
		"砛",
		"筋",
		"荕",
		"衿",
		"襟",
		"觔",
		"金",
		"釒",
		"釿",
		"钅",
		"鹶",
		"黅",
		"𬬱"
	],
	bīng: [
		"仌",
		"仒",
		"兵",
		"冫",
		"冰",
		"掤",
		"氷",
		"鋲"
	],
	réng: [
		"仍",
		"礽",
		"芿",
		"辸",
		"陾"
	],
	fó: [
		"仏",
		"坲",
		"梻"
	],
	"jīn sǎn": ["仐"],
	lún: [
		"仑",
		"伦",
		"侖",
		"倫",
		"囵",
		"圇",
		"婨",
		"崘",
		"崙",
		"棆",
		"沦",
		"淪",
		"磮",
		"腀",
		"菕",
		"蜦",
		"踚",
		"輪",
		"轮",
		"錀",
		"陯",
		"鯩",
		"𬬭"
	],
	cāng: [
		"仓",
		"仺",
		"倉",
		"凔",
		"嵢",
		"沧",
		"滄",
		"濸",
		"獊",
		"舱",
		"艙",
		"苍",
		"蒼",
		"螥",
		"鸧"
	],
	"zǎi zǐ zī": ["仔"],
	tā: [
		"他",
		"塌",
		"它",
		"榙",
		"溻",
		"牠",
		"祂",
		"褟",
		"趿",
		"遢",
		"闧"
	],
	fù: [
		"付",
		"偩",
		"傅",
		"冨",
		"副",
		"咐",
		"坿",
		"复",
		"妇",
		"婦",
		"媍",
		"嬔",
		"富",
		"復",
		"椱",
		"祔",
		"禣",
		"竎",
		"緮",
		"縛",
		"缚",
		"腹",
		"萯",
		"蕧",
		"蚹",
		"蛗",
		"蝜",
		"蝮",
		"袝",
		"複",
		"覄",
		"覆",
		"訃",
		"詂",
		"讣",
		"負",
		"賦",
		"賻",
		"负",
		"赋",
		"赙",
		"赴",
		"輹",
		"鍑",
		"鍢",
		"阜",
		"附",
		"馥",
		"駙",
		"驸",
		"鮒",
		"鰒",
		"鲋",
		"鳆",
		"㳇"
	],
	xiān: [
		"仙",
		"仚",
		"佡",
		"僊",
		"僲",
		"先",
		"嘕",
		"奾",
		"屳",
		"廯",
		"忺",
		"憸",
		"掀",
		"暹",
		"杴",
		"氙",
		"珗",
		"祆",
		"秈",
		"籼",
		"繊",
		"纎",
		"纖",
		"苮",
		"褼",
		"襳",
		"跹",
		"蹮",
		"躚",
		"酰",
		"鍁",
		"锨",
		"韯",
		"韱",
		"馦",
		"鱻",
		"鶱",
		"𬸣"
	],
	"tuō chà duó": ["仛"],
	hóng: [
		"仜",
		"吰",
		"垬",
		"妅",
		"娂",
		"宏",
		"宖",
		"弘",
		"彋",
		"汯",
		"泓",
		"洪",
		"浤",
		"渱",
		"潂",
		"玒",
		"玜",
		"竑",
		"竤",
		"篊",
		"粠",
		"紘",
		"紭",
		"綋",
		"纮",
		"翃",
		"翝",
		"耾",
		"苰",
		"荭",
		"葒",
		"葓",
		"谹",
		"谼",
		"鈜",
		"鉷",
		"鋐",
		"閎",
		"闳",
		"霐",
		"霟",
		"鞃",
		"魟",
		"鴻",
		"鸿",
		"黉",
		"黌",
		"𫟹",
		"𬭎"
	],
	tóng: [
		"仝",
		"佟",
		"哃",
		"峂",
		"峝",
		"庝",
		"彤",
		"晍",
		"曈",
		"桐",
		"氃",
		"浵",
		"潼",
		"犝",
		"獞",
		"眮",
		"瞳",
		"砼",
		"秱",
		"童",
		"粡",
		"膧",
		"茼",
		"蚒",
		"詷",
		"赨",
		"酮",
		"鉖",
		"鉵",
		"銅",
		"铜",
		"餇",
		"鮦",
		"鲖",
		"𫍣",
		"𦒍"
	],
	rèn: [
		"仞",
		"仭",
		"刃",
		"刄",
		"妊",
		"姙",
		"屻",
		"岃",
		"扨",
		"牣",
		"祍",
		"紉",
		"紝",
		"絍",
		"纫",
		"纴",
		"肕",
		"腍",
		"衽",
		"袵",
		"訒",
		"認",
		"认",
		"讱",
		"軔",
		"轫",
		"鈓",
		"靭",
		"靱",
		"韌",
		"韧",
		"飪",
		"餁",
		"饪"
	],
	qiān: [
		"仟",
		"佥",
		"僉",
		"千",
		"圲",
		"奷",
		"孯",
		"岍",
		"悭",
		"愆",
		"慳",
		"扦",
		"拪",
		"搴",
		"撁",
		"攐",
		"攑",
		"攓",
		"杄",
		"櫏",
		"汘",
		"汧",
		"牵",
		"牽",
		"竏",
		"签",
		"簽",
		"籖",
		"籤",
		"粁",
		"芊",
		"茾",
		"蚈",
		"褰",
		"諐",
		"謙",
		"谦",
		"谸",
		"迁",
		"遷",
		"釺",
		"鈆",
		"鉛",
		"鏲",
		"钎",
		"阡",
		"韆",
		"顅",
		"騫",
		"骞",
		"鬜",
		"鬝",
		"鵮",
		"鹐"
	],
	"gǎn hàn": ["仠"],
	"yì gē": ["仡"],
	dài: [
		"代",
		"侢",
		"叇",
		"垈",
		"埭",
		"岱",
		"帒",
		"带",
		"帯",
		"帶",
		"廗",
		"怠",
		"戴",
		"曃",
		"柋",
		"殆",
		"瀻",
		"玳",
		"瑇",
		"甙",
		"簤",
		"紿",
		"緿",
		"绐",
		"艜",
		"蝳",
		"袋",
		"襶",
		"貣",
		"贷",
		"蹛",
		"軑",
		"軚",
		"軩",
		"轪",
		"迨",
		"霴",
		"靆",
		"鴏",
		"黛",
		"黱"
	],
	"lìng líng lǐng": ["令"],
	chào: [
		"仦",
		"耖",
		"觘"
	],
	"cháng zhǎng": [
		"仧",
		"兏",
		"長",
		"长"
	],
	sā: ["仨"],
	cháng: [
		"仩",
		"偿",
		"償",
		"嘗",
		"嚐",
		"嫦",
		"尝",
		"常",
		"徜",
		"瑺",
		"瓺",
		"甞",
		"肠",
		"腸",
		"膓",
		"苌",
		"萇",
		"镸",
		"鱨",
		"鲿"
	],
	yí: [
		"仪",
		"侇",
		"儀",
		"冝",
		"匜",
		"咦",
		"圯",
		"夷",
		"姨",
		"宐",
		"宜",
		"宧",
		"寲",
		"峓",
		"嶬",
		"嶷",
		"巸",
		"彛",
		"彜",
		"彝",
		"彞",
		"怡",
		"恞",
		"扅",
		"暆",
		"栘",
		"椬",
		"椸",
		"沂",
		"洟",
		"熪",
		"瓵",
		"痍",
		"移",
		"簃",
		"籎",
		"羠",
		"胰",
		"萓",
		"蛦",
		"螔",
		"觺",
		"謻",
		"貽",
		"贻",
		"跠",
		"迻",
		"遺",
		"鏔",
		"頉",
		"頤",
		"頥",
		"顊",
		"颐",
		"饴",
		"鮧",
		"鴺"
	],
	mù: [
		"仫",
		"凩",
		"募",
		"墓",
		"幕",
		"幙",
		"慔",
		"慕",
		"暮",
		"暯",
		"木",
		"楘",
		"毣",
		"沐",
		"炑",
		"牧",
		"狇",
		"目",
		"睦",
		"穆",
		"艒",
		"苜",
		"莯",
		"蚞",
		"鉬",
		"钼",
		"雮",
		"霂"
	],
	"men mén": ["们"],
	fǎn: [
		"仮",
		"反",
		"橎",
		"返"
	],
	"chào miǎo": ["仯"],
	"yǎng áng": ["仰"],
	zhòng: [
		"仲",
		"众",
		"堹",
		"妕",
		"媑",
		"狆",
		"眾",
		"祌",
		"筗",
		"茽",
		"蚛",
		"衆",
		"衶",
		"諥"
	],
	"pǐ pí": ["仳"],
	wò: [
		"仴",
		"偓",
		"卧",
		"媉",
		"幄",
		"握",
		"楃",
		"沃",
		"渥",
		"濣",
		"瓁",
		"瞃",
		"硪",
		"肟",
		"腛",
		"臥",
		"齷",
		"龌"
	],
	jiàn: [
		"件",
		"俴",
		"健",
		"僭",
		"剑",
		"剣",
		"剱",
		"劍",
		"劎",
		"劒",
		"劔",
		"墹",
		"寋",
		"建",
		"徤",
		"擶",
		"旔",
		"楗",
		"毽",
		"洊",
		"涧",
		"澗",
		"牮",
		"珔",
		"瞷",
		"磵",
		"礀",
		"箭",
		"糋",
		"繝",
		"腱",
		"臶",
		"舰",
		"艦",
		"荐",
		"薦",
		"覸",
		"諓",
		"諫",
		"譛",
		"谏",
		"賎",
		"賤",
		"贱",
		"趝",
		"践",
		"踐",
		"踺",
		"轞",
		"鉴",
		"鍳",
		"鍵",
		"鐱",
		"鑑",
		"鑒",
		"鑬",
		"鑳",
		"键",
		"間",
		"餞",
		"饯",
		"𬣡"
	],
	"jià jiè jie": ["价"],
	"yǎo fó": ["仸"],
	"rèn rén": ["任"],
	"fèn bīn": ["份"],
	dī: [
		"仾",
		"低",
		"啲",
		"埞",
		"堤",
		"岻",
		"彽",
		"樀",
		"滴",
		"磾",
		"秪",
		"羝",
		"袛",
		"趆",
		"隄",
		"鞮",
		"䃅"
	],
	fǎng: [
		"仿",
		"倣",
		"旊",
		"昉",
		"昘",
		"瓬",
		"眆",
		"紡",
		"纺",
		"舫",
		"訪",
		"访",
		"髣",
		"鶭"
	],
	zhōng: [
		"伀",
		"刣",
		"妐",
		"幒",
		"彸",
		"忠",
		"柊",
		"汷",
		"泈",
		"炂",
		"盅",
		"籦",
		"終",
		"终",
		"舯",
		"蔠",
		"蜙",
		"螤",
		"螽",
		"衳",
		"衷",
		"蹱",
		"鈡",
		"鍾",
		"鐘",
		"钟",
		"锺",
		"鴤",
		"鼨"
	],
	pèi: [
		"伂",
		"佩",
		"姵",
		"帔",
		"斾",
		"旆",
		"沛",
		"浿",
		"珮",
		"蓜",
		"轡",
		"辔",
		"配",
		"霈",
		"馷"
	],
	diào: [
		"伄",
		"吊",
		"弔",
		"掉",
		"瘹",
		"盄",
		"窎",
		"窵",
		"竨",
		"訋",
		"釣",
		"鈟",
		"銱",
		"鋽",
		"鑃",
		"钓",
		"铞",
		"雿",
		"魡"
	],
	dùn: [
		"伅",
		"潡",
		"炖",
		"燉",
		"盾",
		"砘",
		"碷",
		"踲",
		"逇",
		"遁",
		"遯",
		"鈍",
		"钝"
	],
	wěn: [
		"伆",
		"刎",
		"吻",
		"呅",
		"抆",
		"桽",
		"稳",
		"穏",
		"穩",
		"紊",
		"肳",
		"脗"
	],
	xǐn: ["伈"],
	kàng: [
		"伉",
		"匟",
		"囥",
		"抗",
		"炕",
		"鈧",
		"钪"
	],
	ài: [
		"伌",
		"僾",
		"塧",
		"壒",
		"嫒",
		"嬡",
		"愛",
		"懓",
		"暧",
		"曖",
		"爱",
		"瑷",
		"璦",
		"皧",
		"瞹",
		"砹",
		"硋",
		"碍",
		"礙",
		"薆",
		"譺",
		"賹",
		"鑀",
		"隘",
		"靉",
		"餲",
		"馤",
		"鱫",
		"鴱"
	],
	"jì qí": ["伎", "薺"],
	"xiū xǔ": ["休"],
	"jìn yín": ["伒"],
	dǎn: [
		"伔",
		"刐",
		"撢",
		"玬",
		"瓭",
		"紞",
		"胆",
		"膽",
		"衴",
		"賧",
		"赕",
		"黕",
		"𬘘"
	],
	fū: [
		"伕",
		"呋",
		"娐",
		"孵",
		"尃",
		"怤",
		"懯",
		"敷",
		"旉",
		"玞",
		"砆",
		"稃",
		"筟",
		"糐",
		"綒",
		"肤",
		"膚",
		"荂",
		"荴",
		"衭",
		"趺",
		"跗",
		"邞",
		"鄜",
		"酜",
		"鈇",
		"麩",
		"麬",
		"麱",
		"麸",
		"𫓧"
	],
	tǎng: [
		"伖",
		"傥",
		"儻",
		"埫",
		"戃",
		"曭",
		"爣",
		"矘",
		"躺",
		"鎲",
		"钂",
		"镋"
	],
	yōu: [
		"优",
		"優",
		"呦",
		"嚘",
		"峳",
		"幽",
		"忧",
		"悠",
		"憂",
		"攸",
		"櫌",
		"滺",
		"瀀",
		"纋",
		"羪",
		"耰",
		"逌",
		"鄾",
		"麀"
	],
	huǒ: [
		"伙",
		"夥",
		"火",
		"煷",
		"邩",
		"鈥",
		"钬"
	],
	"huì kuài": [
		"会",
		"會",
		"浍",
		"璯"
	],
	yǔ: [
		"伛",
		"俁",
		"俣",
		"偊",
		"傴",
		"匬",
		"噳",
		"圄",
		"圉",
		"宇",
		"寙",
		"屿",
		"嶼",
		"庾",
		"挧",
		"敔",
		"斞",
		"楀",
		"瑀",
		"瘐",
		"祤",
		"禹",
		"穥",
		"窳",
		"羽",
		"與",
		"萭",
		"貐",
		"鄅",
		"頨",
		"麌",
		"齬",
		"龉",
		"㺄"
	],
	cuì: [
		"伜",
		"啛",
		"忰",
		"悴",
		"毳",
		"淬",
		"焠",
		"疩",
		"瘁",
		"竁",
		"粋",
		"粹",
		"紣",
		"綷",
		"翆",
		"翠",
		"脃",
		"脆",
		"脺",
		"膬",
		"膵",
		"臎",
		"萃",
		"襊",
		"顇"
	],
	sǎn: [
		"伞",
		"傘",
		"糤",
		"繖",
		"饊",
		"馓"
	],
	wěi: [
		"伟",
		"伪",
		"偉",
		"偽",
		"僞",
		"儰",
		"娓",
		"寪",
		"屗",
		"崣",
		"嶉",
		"徫",
		"愇",
		"捤",
		"暐",
		"梶",
		"洧",
		"浘",
		"渨",
		"炜",
		"煒",
		"猥",
		"玮",
		"瑋",
		"痿",
		"緯",
		"纬",
		"腲",
		"艉",
		"芛",
		"苇",
		"荱",
		"萎",
		"葦",
		"蒍",
		"蔿",
		"蜼",
		"諉",
		"诿",
		"踓",
		"鍡",
		"韑",
		"韙",
		"韡",
		"韪",
		"頠",
		"颹",
		"骩",
		"骪",
		"骫",
		"鮪",
		"鲔",
		"𫇭",
		"𬀩",
		"𬱟"
	],
	"chuán zhuàn": ["传", "傳"],
	"chē jū": [
		"伡",
		"俥",
		"车"
	],
	"jū chē": ["車"],
	yá: [
		"伢",
		"厑",
		"厓",
		"堐",
		"岈",
		"崕",
		"崖",
		"涯",
		"漄",
		"牙",
		"玡",
		"琊",
		"睚",
		"笌",
		"芽",
		"蚜",
		"衙",
		"齖"
	],
	qiàn: [
		"伣",
		"俔",
		"倩",
		"儙",
		"刋",
		"壍",
		"嬱",
		"悓",
		"棈",
		"椠",
		"槧",
		"欠",
		"歉",
		"皘",
		"篏",
		"篟",
		"縴",
		"芡",
		"蒨",
		"蔳",
		"輤",
		"𬘬"
	],
	shāng: [
		"伤",
		"傷",
		"商",
		"墒",
		"慯",
		"殇",
		"殤",
		"滳",
		"漡",
		"熵",
		"蔏",
		"螪",
		"觞",
		"觴",
		"謪",
		"鬺"
	],
	chāng: [
		"伥",
		"倀",
		"娼",
		"昌",
		"椙",
		"淐",
		"猖",
		"琩",
		"菖",
		"裮",
		"錩",
		"锠",
		"閶",
		"阊",
		"鯧",
		"鲳",
		"鼚"
	],
	"chen cāng": ["伧"],
	xùn: [
		"伨",
		"侚",
		"卂",
		"噀",
		"巺",
		"巽",
		"徇",
		"愻",
		"殉",
		"殾",
		"汛",
		"潠",
		"狥",
		"蕈",
		"訊",
		"訓",
		"訙",
		"训",
		"讯",
		"迅",
		"迿",
		"逊",
		"遜",
		"鑂",
		"顨",
		"馴",
		"驯"
	],
	xìn: [
		"伩",
		"囟",
		"孞",
		"脪",
		"舋",
		"衅",
		"訫",
		"釁",
		"阠",
		"顖"
	],
	chǐ: [
		"伬",
		"侈",
		"卶",
		"叺",
		"呎",
		"垑",
		"恥",
		"歯",
		"耻",
		"肔",
		"胣",
		"蚇",
		"裭",
		"褫",
		"豉",
		"鉹",
		"齒",
		"齿"
	],
	"xián xuán": ["伭"],
	"nú nǔ": ["伮"],
	"bó bǎi": ["伯"],
	"gū gù": ["估"],
	nǐ: [
		"伱",
		"你",
		"儞",
		"孴",
		"拟",
		"擬",
		"旎",
		"晲",
		"狔",
		"苨",
		"薿",
		"隬"
	],
	"nì ní": ["伲"],
	bàn: [
		"伴",
		"办",
		"半",
		"姅",
		"怑",
		"扮",
		"瓣",
		"秚",
		"絆",
		"绊",
		"辦",
		"鉡",
		"靽"
	],
	xù: [
		"伵",
		"侐",
		"勖",
		"勗",
		"卹",
		"叙",
		"垿",
		"壻",
		"婿",
		"序",
		"恤",
		"敍",
		"敘",
		"旭",
		"昫",
		"朂",
		"槒",
		"欰",
		"殈",
		"汿",
		"沀",
		"洫",
		"溆",
		"漵",
		"潊",
		"烅",
		"烼",
		"煦",
		"獝",
		"珬",
		"盢",
		"瞁",
		"稸",
		"絮",
		"続",
		"緒",
		"緖",
		"續",
		"绪",
		"续",
		"聓",
		"聟",
		"蓄",
		"藚",
		"訹",
		"賉",
		"酗",
		"頊",
		"鱮",
		"㳚"
	],
	zhòu: [
		"伷",
		"僽",
		"冑",
		"呪",
		"咒",
		"咮",
		"宙",
		"昼",
		"晝",
		"甃",
		"皱",
		"皺",
		"籀",
		"籒",
		"籕",
		"粙",
		"紂",
		"縐",
		"纣",
		"绉",
		"胄",
		"荮",
		"葤",
		"詋",
		"酎",
		"駎",
		"驟",
		"骤",
		"㤘",
		"㑇"
	],
	shēn: [
		"伸",
		"侁",
		"兟",
		"呻",
		"堔",
		"妽",
		"娠",
		"屾",
		"峷",
		"扟",
		"敒",
		"曑",
		"柛",
		"氠",
		"深",
		"燊",
		"珅",
		"甡",
		"甧",
		"申",
		"眒",
		"砷",
		"穼",
		"籶",
		"籸",
		"糂",
		"紳",
		"绅",
		"罙",
		"罧",
		"葠",
		"蓡",
		"蔘",
		"薓",
		"裑",
		"訷",
		"詵",
		"诜",
		"身",
		"駪",
		"鯓",
		"鯵",
		"鰺",
		"鲹",
		"鵢",
		"𬳽"
	],
	qū: [
		"伹",
		"佉",
		"匤",
		"呿",
		"坥",
		"屈",
		"岖",
		"岴",
		"嶇",
		"憈",
		"抾",
		"敺",
		"浀",
		"煀",
		"祛",
		"筁",
		"粬",
		"胠",
		"蛆",
		"蛐",
		"袪",
		"覻",
		"詘",
		"诎",
		"趍",
		"躯",
		"軀",
		"阹",
		"駆",
		"駈",
		"驅",
		"驱",
		"髷",
		"魼",
		"鰸",
		"鱋",
		"鶌",
		"麯",
		"麴",
		"麹",
		"黢",
		"㭕",
		"𪨰",
		"䓛"
	],
	"sì cì": ["伺"],
	bēng: [
		"伻",
		"嘣",
		"奟",
		"崩",
		"嵭",
		"閍"
	],
	"sì shì": ["似"],
	"jiā qié gā": ["伽"],
	"yǐ chì": ["佁"],
	"diàn tián": ["佃", "钿"],
	"hān gàn": ["佄"],
	mài: [
		"佅",
		"劢",
		"勱",
		"卖",
		"唛",
		"売",
		"脈",
		"衇",
		"賣",
		"迈",
		"邁",
		"霡",
		"霢",
		"麥",
		"麦",
		"鿏"
	],
	dàn: [
		"但",
		"僤",
		"啖",
		"啗",
		"啿",
		"噉",
		"嚪",
		"帎",
		"憺",
		"旦",
		"柦",
		"氮",
		"沊",
		"泹",
		"淡",
		"狚",
		"疍",
		"癚",
		"禫",
		"窞",
		"腅",
		"萏",
		"蓞",
		"蛋",
		"蜑",
		"觛",
		"訑",
		"誕",
		"诞",
		"贉",
		"霮",
		"餤",
		"饏",
		"駳",
		"髧",
		"鴠",
		"𫢸"
	],
	bù: [
		"佈",
		"勏",
		"吥",
		"咘",
		"埗",
		"埠",
		"布",
		"廍",
		"怖",
		"悑",
		"步",
		"歨",
		"歩",
		"瓿",
		"篰",
		"荹",
		"蔀",
		"踄",
		"部",
		"郶",
		"鈈",
		"钚",
		"餢"
	],
	bǐ: [
		"佊",
		"俾",
		"匕",
		"夶",
		"妣",
		"彼",
		"朼",
		"柀",
		"比",
		"毞",
		"沘",
		"疕",
		"秕",
		"笔",
		"筆",
		"粃",
		"聛",
		"舭",
		"貏",
		"鄙"
	],
	"zhāo shào": ["佋"],
	cǐ: [
		"佌",
		"此",
		"泚",
		"皉",
		"𫚖"
	],
	wèi: [
		"位",
		"卫",
		"味",
		"喂",
		"墛",
		"媦",
		"慰",
		"懀",
		"未",
		"渭",
		"煟",
		"熭",
		"犚",
		"猬",
		"畏",
		"緭",
		"罻",
		"胃",
		"苿",
		"菋",
		"藯",
		"蘶",
		"蝟",
		"螱",
		"衛",
		"衞",
		"褽",
		"謂",
		"讆",
		"讏",
		"谓",
		"躗",
		"躛",
		"軎",
		"轊",
		"鏏",
		"霨",
		"餧",
		"餵",
		"饖",
		"魏",
		"鮇",
		"鳚"
	],
	zuǒ: [
		"佐",
		"左",
		"繓"
	],
	yǎng: [
		"佒",
		"傟",
		"养",
		"坱",
		"岟",
		"慃",
		"懩",
		"攁",
		"氧",
		"氱",
		"炴",
		"痒",
		"癢",
		"礢",
		"紻",
		"蝆",
		"軮",
		"養",
		"駚"
	],
	"tǐ tī": ["体", "體"],
	zhàn: [
		"佔",
		"偡",
		"嶘",
		"战",
		"戦",
		"戰",
		"栈",
		"桟",
		"棧",
		"湛",
		"站",
		"綻",
		"绽",
		"菚",
		"蘸",
		"虥",
		"虦",
		"譧",
		"轏",
		"驏"
	],
	"hé hē hè": ["何"],
	bì: [
		"佖",
		"咇",
		"哔",
		"嗶",
		"坒",
		"堛",
		"壁",
		"奰",
		"妼",
		"婢",
		"嬖",
		"币",
		"幣",
		"幤",
		"庇",
		"庳",
		"廦",
		"弊",
		"弻",
		"弼",
		"彃",
		"必",
		"怭",
		"愊",
		"愎",
		"敝",
		"斃",
		"梐",
		"毕",
		"毖",
		"毙",
		"湢",
		"滗",
		"滭",
		"潷",
		"煏",
		"熚",
		"狴",
		"獘",
		"獙",
		"珌",
		"璧",
		"畀",
		"畢",
		"疪",
		"痹",
		"痺",
		"皕",
		"睤",
		"碧",
		"筚",
		"箅",
		"箆",
		"篦",
		"篳",
		"粊",
		"綼",
		"縪",
		"繴",
		"罼",
		"腷",
		"苾",
		"荜",
		"萆",
		"萞",
		"蓖",
		"蓽",
		"蔽",
		"薜",
		"蜌",
		"袐",
		"襅",
		"襞",
		"襣",
		"觱",
		"詖",
		"诐",
		"貱",
		"贔",
		"赑",
		"跸",
		"蹕",
		"躃",
		"躄",
		"避",
		"邲",
		"鄨",
		"鄪",
		"鉍",
		"鏎",
		"鐴",
		"铋",
		"閇",
		"閉",
		"閟",
		"闭",
		"陛",
		"韠",
		"飶",
		"饆",
		"馝",
		"駜",
		"驆",
		"髀",
		"魓",
		"鮅",
		"鷝",
		"鷩",
		"鼊"
	],
	tuó: [
		"佗",
		"坨",
		"堶",
		"岮",
		"槖",
		"橐",
		"沱",
		"砣",
		"砤",
		"碢",
		"紽",
		"詑",
		"跎",
		"酡",
		"阤",
		"陀",
		"陁",
		"駝",
		"駞",
		"騨",
		"驒",
		"驝",
		"驼",
		"鮀",
		"鴕",
		"鸵",
		"鼉",
		"鼍",
		"鼧",
		"𬶍"
	],
	shé: [
		"佘",
		"舌",
		"虵",
		"蛥"
	],
	"yì dié": [
		"佚",
		"昳",
		"泆",
		"軼"
	],
	"fó fú bì bó": ["佛"],
	"zuò zuō": ["作"],
	gōu: [
		"佝",
		"沟",
		"溝",
		"痀",
		"篝",
		"簼",
		"緱",
		"缑",
		"袧",
		"褠",
		"鈎",
		"鉤",
		"钩",
		"鞲",
		"韝"
	],
	nìng: [
		"佞",
		"侫",
		"倿",
		"寕",
		"泞",
		"澝",
		"濘"
	],
	qú: [
		"佢",
		"劬",
		"戵",
		"斪",
		"欋",
		"欔",
		"氍",
		"淭",
		"灈",
		"爠",
		"璖",
		"璩",
		"癯",
		"磲",
		"籧",
		"絇",
		"胊",
		"臞",
		"菃",
		"葋",
		"蕖",
		"蘧",
		"蟝",
		"蠷",
		"蠼",
		"衐",
		"衢",
		"躣",
		"軥",
		"鑺",
		"鴝",
		"鸜",
		"鸲",
		"鼩"
	],
	"yōng yòng": ["佣"],
	wǎ: [
		"佤",
		"咓",
		"砙",
		"邷"
	],
	kǎ: [
		"佧",
		"垰",
		"胩",
		"裃",
		"鉲"
	],
	bāo: [
		"佨",
		"勹",
		"包",
		"孢",
		"煲",
		"笣",
		"胞",
		"苞",
		"蕔",
		"裦",
		"褒",
		"襃",
		"闁",
		"齙",
		"龅"
	],
	"huái huí": ["佪"],
	"gé hè": ["佫"],
	lǎo: [
		"佬",
		"咾",
		"恅",
		"栳",
		"狫",
		"珯",
		"硓",
		"老",
		"耂",
		"荖",
		"蛯",
		"轑",
		"銠",
		"铑",
		"鮱"
	],
	xiáng: [
		"佭",
		"庠",
		"栙",
		"祥",
		"絴",
		"翔",
		"詳",
		"跭"
	],
	gé: [
		"佮",
		"匌",
		"呄",
		"嗝",
		"塥",
		"愅",
		"挌",
		"搿",
		"槅",
		"櫊",
		"滆",
		"膈",
		"臵",
		"茖",
		"觡",
		"諽",
		"輵",
		"轕",
		"閣",
		"阁",
		"隔",
		"鞷",
		"韐",
		"韚",
		"騔",
		"骼",
		"鮯"
	],
	yáng: [
		"佯",
		"劷",
		"垟",
		"崸",
		"徉",
		"扬",
		"揚",
		"敭",
		"旸",
		"昜",
		"暘",
		"杨",
		"楊",
		"洋",
		"炀",
		"珜",
		"疡",
		"瘍",
		"眻",
		"蛘",
		"諹",
		"輰",
		"鍚",
		"钖",
		"阦",
		"阳",
		"陽",
		"霷",
		"颺",
		"飏",
		"鰑",
		"鴹",
		"鸉"
	],
	bǎi: [
		"佰",
		"捭",
		"摆",
		"擺",
		"栢",
		"百",
		"竡",
		"粨",
		"襬"
	],
	fǎ: [
		"佱",
		"峜",
		"法",
		"灋",
		"砝",
		"鍅"
	],
	mǐng: [
		"佲",
		"凕",
		"姳",
		"慏",
		"酩"
	],
	"èr nài": ["佴"],
	hěn: [
		"佷",
		"很",
		"狠",
		"詪",
		"𬣳"
	],
	huó: ["佸", "活"],
	guǐ: [
		"佹",
		"匦",
		"匭",
		"厬",
		"垝",
		"姽",
		"宄",
		"庋",
		"庪",
		"恑",
		"晷",
		"湀",
		"癸",
		"祪",
		"簋",
		"蛫",
		"蟡",
		"觤",
		"詭",
		"诡",
		"軌",
		"轨",
		"陒",
		"鬼"
	],
	quán: [
		"佺",
		"全",
		"啳",
		"埢",
		"姾",
		"峑",
		"巏",
		"拳",
		"搼",
		"权",
		"楾",
		"権",
		"權",
		"泉",
		"洤",
		"湶",
		"牷",
		"犈",
		"瑔",
		"痊",
		"硂",
		"筌",
		"縓",
		"荃",
		"葲",
		"蜷",
		"蠸",
		"觠",
		"詮",
		"诠",
		"跧",
		"踡",
		"輇",
		"辁",
		"醛",
		"銓",
		"铨",
		"闎",
		"顴",
		"颧",
		"駩",
		"騡",
		"鬈",
		"鰁",
		"鳈",
		"齤"
	],
	tiāo: [
		"佻",
		"庣",
		"旫",
		"祧",
		"聎"
	],
	jiǎo: [
		"佼",
		"儌",
		"孂",
		"挢",
		"搅",
		"撟",
		"撹",
		"攪",
		"敫",
		"敽",
		"敿",
		"晈",
		"暞",
		"曒",
		"灚",
		"燞",
		"狡",
		"璬",
		"皎",
		"皦",
		"絞",
		"纐",
		"绞",
		"腳",
		"臫",
		"蟜",
		"譑",
		"賋",
		"踋",
		"鉸",
		"铰",
		"餃",
		"饺",
		"鱎",
		"龣"
	],
	cì: [
		"佽",
		"刾",
		"庛",
		"朿",
		"栨",
		"次",
		"絘",
		"茦",
		"莿",
		"蛓",
		"螆",
		"賜",
		"赐"
	],
	xíng: [
		"侀",
		"刑",
		"哘",
		"型",
		"娙",
		"形",
		"洐",
		"硎",
		"蛵",
		"邢",
		"郉",
		"鈃",
		"鉶",
		"銒",
		"钘",
		"铏",
		"陉",
		"陘",
		"餳",
		"𫰛"
	],
	tuō: [
		"侂",
		"咃",
		"咜",
		"圫",
		"托",
		"拕",
		"拖",
		"汑",
		"脫",
		"脱",
		"莌",
		"袥",
		"託",
		"讬",
		"飥",
		"饦",
		"魠",
		"鮵"
	],
	kǎn: [
		"侃",
		"偘",
		"冚",
		"坎",
		"惂",
		"砍",
		"莰",
		"輡",
		"轗",
		"顑"
	],
	zhí: [
		"侄",
		"値",
		"值",
		"埴",
		"執",
		"姪",
		"嬂",
		"戠",
		"执",
		"摭",
		"植",
		"樴",
		"淔",
		"漐",
		"直",
		"禃",
		"絷",
		"縶",
		"聀",
		"职",
		"職",
		"膱",
		"蟙",
		"跖",
		"踯",
		"蹠",
		"躑",
		"軄",
		"釞",
		"馽"
	],
	gāi: [
		"侅",
		"垓",
		"姟",
		"峐",
		"晐",
		"畡",
		"祴",
		"荄",
		"該",
		"该",
		"豥",
		"賅",
		"賌",
		"赅",
		"陔"
	],
	lái: [
		"來",
		"俫",
		"倈",
		"崃",
		"崍",
		"庲",
		"来",
		"梾",
		"棶",
		"涞",
		"淶",
		"猍",
		"琜",
		"筙",
		"箂",
		"莱",
		"萊",
		"逨",
		"郲",
		"錸",
		"铼",
		"騋",
		"鯠",
		"鶆",
		"麳"
	],
	kuǎ: [
		"侉",
		"咵",
		"垮",
		"銙"
	],
	gōng: [
		"侊",
		"公",
		"功",
		"匑",
		"匔",
		"塨",
		"宫",
		"宮",
		"工",
		"幊",
		"弓",
		"恭",
		"攻",
		"杛",
		"碽",
		"糼",
		"糿",
		"肱",
		"觥",
		"觵",
		"躬",
		"躳",
		"髸",
		"龔",
		"龚",
		"䢼"
	],
	lì: [
		"例",
		"俐",
		"俪",
		"傈",
		"儮",
		"儷",
		"凓",
		"利",
		"力",
		"励",
		"勵",
		"历",
		"厉",
		"厤",
		"厯",
		"厲",
		"叓",
		"吏",
		"呖",
		"唎",
		"唳",
		"嚦",
		"囇",
		"坜",
		"塛",
		"壢",
		"娳",
		"婯",
		"屴",
		"岦",
		"悧",
		"悷",
		"慄",
		"戾",
		"搮",
		"暦",
		"曆",
		"曞",
		"朸",
		"枥",
		"栃",
		"栗",
		"栛",
		"檪",
		"櫔",
		"櫪",
		"欐",
		"歴",
		"歷",
		"沥",
		"沴",
		"涖",
		"溧",
		"濿",
		"瀝",
		"爏",
		"犡",
		"猁",
		"珕",
		"瑮",
		"瓅",
		"瓑",
		"瓥",
		"疬",
		"痢",
		"癧",
		"盭",
		"睙",
		"砅",
		"砺",
		"砾",
		"磿",
		"礪",
		"礫",
		"礰",
		"禲",
		"秝",
		"立",
		"笠",
		"篥",
		"粒",
		"粝",
		"糲",
		"脷",
		"苈",
		"茘",
		"荔",
		"莅",
		"莉",
		"蒚",
		"蒞",
		"藶",
		"蚸",
		"蛎",
		"蛠",
		"蜧",
		"蝷",
		"蠇",
		"蠣",
		"詈",
		"讈",
		"赲",
		"轢",
		"轣",
		"轹",
		"酈",
		"鉝",
		"隶",
		"隷",
		"雳",
		"靂",
		"靋",
		"鬁",
		"鳨",
		"鴗",
		"鷅",
		"麜",
		"𫵷",
		"𬍛"
	],
	yīn: [
		"侌",
		"凐",
		"喑",
		"噾",
		"囙",
		"因",
		"垔",
		"堙",
		"姻",
		"婣",
		"愔",
		"慇",
		"栶",
		"氤",
		"洇",
		"溵",
		"濦",
		"瘖",
		"禋",
		"秵",
		"筃",
		"絪",
		"緸",
		"茵",
		"蒑",
		"蔭",
		"裀",
		"諲",
		"銦",
		"铟",
		"闉",
		"阥",
		"阴",
		"陰",
		"陻",
		"隂",
		"霒",
		"霠",
		"鞇",
		"音",
		"韾",
		"駰",
		"骃",
		"齗",
		"𬘡",
		"𬤇",
		"𬮱"
	],
	mǐ: [
		"侎",
		"孊",
		"弭",
		"敉",
		"洣",
		"渳",
		"灖",
		"米",
		"粎",
		"羋",
		"脒",
		"芈",
		"葞",
		"蔝",
		"銤"
	],
	zhū: [
		"侏",
		"株",
		"槠",
		"橥",
		"櫧",
		"櫫",
		"洙",
		"潴",
		"瀦",
		"猪",
		"珠",
		"硃",
		"秼",
		"絑",
		"茱",
		"蕏",
		"蛛",
		"蝫",
		"蠩",
		"袾",
		"誅",
		"諸",
		"诛",
		"诸",
		"豬",
		"跦",
		"邾",
		"銖",
		"铢",
		"駯",
		"鮢",
		"鯺",
		"鴸",
		"鼄"
	],
	ān: [
		"侒",
		"偣",
		"媕",
		"安",
		"峖",
		"庵",
		"桉",
		"氨",
		"盦",
		"盫",
		"腤",
		"菴",
		"萻",
		"葊",
		"蓭",
		"誝",
		"諳",
		"谙",
		"鞌",
		"鞍",
		"韽",
		"馣",
		"鮟",
		"鵪",
		"鶕",
		"鹌",
		"𩽾"
	],
	lù: [
		"侓",
		"僇",
		"勎",
		"勠",
		"圥",
		"坴",
		"塶",
		"娽",
		"峍",
		"廘",
		"彔",
		"录",
		"戮",
		"摝",
		"椂",
		"樚",
		"淕",
		"淥",
		"渌",
		"漉",
		"潞",
		"琭",
		"璐",
		"甪",
		"盝",
		"睩",
		"硉",
		"祿",
		"禄",
		"稑",
		"穋",
		"箓",
		"簏",
		"簬",
		"簵",
		"簶",
		"籙",
		"粶",
		"蔍",
		"蕗",
		"虂",
		"螰",
		"賂",
		"赂",
		"趢",
		"路",
		"踛",
		"蹗",
		"輅",
		"轆",
		"辂",
		"辘",
		"逯",
		"醁",
		"錄",
		"録",
		"錴",
		"鏴",
		"陸",
		"騄",
		"騼",
		"鯥",
		"鴼",
		"鵦",
		"鵱",
		"鷺",
		"鹭",
		"鹿",
		"麓",
		"𫘧"
	],
	móu: [
		"侔",
		"劺",
		"恈",
		"眸",
		"蛑",
		"謀",
		"谋",
		"踎",
		"鍪",
		"鴾",
		"麰"
	],
	ér: [
		"侕",
		"儿",
		"児",
		"兒",
		"峏",
		"栭",
		"洏",
		"粫",
		"而",
		"胹",
		"荋",
		"袻",
		"輀",
		"轜",
		"陑",
		"隭",
		"髵",
		"鮞",
		"鲕",
		"鴯",
		"鸸"
	],
	"dòng tǒng tóng": ["侗"],
	chà: [
		"侘",
		"奼",
		"姹",
		"岔",
		"汊",
		"詫",
		"诧"
	],
	chì: [
		"侙",
		"傺",
		"勅",
		"勑",
		"叱",
		"啻",
		"彳",
		"恜",
		"慗",
		"憏",
		"懘",
		"抶",
		"敕",
		"斥",
		"杘",
		"湁",
		"灻",
		"炽",
		"烾",
		"熾",
		"痓",
		"痸",
		"瘛",
		"翄",
		"翅",
		"翤",
		"翨",
		"腟",
		"赤",
		"趩",
		"遫",
		"鉓",
		"雴",
		"飭",
		"饬",
		"鶒",
		"鷘"
	],
	"gòng gōng": ["供", "共"],
	zhōu: [
		"侜",
		"周",
		"喌",
		"州",
		"徟",
		"洲",
		"淍",
		"炿",
		"烐",
		"珘",
		"矪",
		"舟",
		"謅",
		"譸",
		"诌",
		"賙",
		"赒",
		"輈",
		"輖",
		"辀",
		"週",
		"郮",
		"銂",
		"霌",
		"駲",
		"騆",
		"鵃",
		"鸼"
	],
	rú: [
		"侞",
		"儒",
		"嚅",
		"如",
		"嬬",
		"孺",
		"帤",
		"曘",
		"桇",
		"渪",
		"濡",
		"筎",
		"茹",
		"蕠",
		"薷",
		"蝡",
		"蠕",
		"袽",
		"襦",
		"邚",
		"醹",
		"銣",
		"铷",
		"顬",
		"颥",
		"鱬",
		"鴑",
		"鴽"
	],
	"jiàn cún": ["侟"],
	xiá: [
		"侠",
		"俠",
		"匣",
		"峡",
		"峽",
		"敮",
		"暇",
		"柙",
		"炠",
		"烚",
		"狎",
		"狭",
		"狹",
		"珨",
		"瑕",
		"硖",
		"硤",
		"碬",
		"祫",
		"筪",
		"縖",
		"翈",
		"舝",
		"舺",
		"蕸",
		"赮",
		"轄",
		"辖",
		"遐",
		"鍜",
		"鎋",
		"陜",
		"陿",
		"霞",
		"騢",
		"魻",
		"鶷",
		"黠"
	],
	lǚ: [
		"侣",
		"侶",
		"儢",
		"吕",
		"呂",
		"屡",
		"屢",
		"履",
		"挔",
		"捛",
		"旅",
		"梠",
		"焒",
		"祣",
		"稆",
		"穭",
		"絽",
		"縷",
		"缕",
		"膂",
		"膐",
		"褛",
		"褸",
		"郘",
		"鋁",
		"铝"
	],
	ta: ["侤"],
	"jiǎo yáo": [
		"侥",
		"僥",
		"徺"
	],
	zhēn: [
		"侦",
		"偵",
		"寊",
		"帧",
		"帪",
		"幀",
		"搸",
		"斟",
		"桢",
		"楨",
		"榛",
		"樼",
		"殝",
		"浈",
		"湞",
		"潧",
		"澵",
		"獉",
		"珍",
		"珎",
		"瑧",
		"甄",
		"眞",
		"真",
		"砧",
		"碪",
		"祯",
		"禎",
		"禛",
		"箴",
		"胗",
		"臻",
		"葴",
		"蒖",
		"蓁",
		"薽",
		"貞",
		"贞",
		"轃",
		"遉",
		"酙",
		"針",
		"鉁",
		"錱",
		"鍼",
		"针",
		"鱵"
	],
	"cè zè zhāi": ["侧", "側"],
	kuài: [
		"侩",
		"儈",
		"凷",
		"哙",
		"噲",
		"圦",
		"块",
		"塊",
		"巜",
		"廥",
		"快",
		"旝",
		"欳",
		"狯",
		"獪",
		"筷",
		"糩",
		"脍",
		"膾",
		"郐",
		"鄶",
		"鱠",
		"鲙"
	],
	chái: [
		"侪",
		"儕",
		"喍",
		"柴",
		"犲",
		"祡",
		"豺"
	],
	nóng: [
		"侬",
		"儂",
		"农",
		"哝",
		"噥",
		"檂",
		"欁",
		"浓",
		"濃",
		"燶",
		"禯",
		"秾",
		"穠",
		"脓",
		"膿",
		"蕽",
		"襛",
		"譨",
		"農",
		"辳",
		"醲",
		"鬞",
		"𬪩"
	],
	jǐn: [
		"侭",
		"儘",
		"卺",
		"厪",
		"巹",
		"槿",
		"漌",
		"瑾",
		"紧",
		"緊",
		"菫",
		"蓳",
		"謹",
		"谨",
		"錦",
		"锦",
		"饉",
		"馑"
	],
	"hóu hòu": ["侯", "矦"],
	jiǒng: [
		"侰",
		"僒",
		"冏",
		"囧",
		"泂",
		"澃",
		"炯",
		"烱",
		"煚",
		"煛",
		"熲",
		"燛",
		"窘",
		"綗",
		"褧",
		"迥",
		"逈",
		"顈",
		"颎",
		"䌹"
	],
	"chěng tǐng": ["侱"],
	"zhèn zhēn": ["侲", "揕"],
	zuò: [
		"侳",
		"做",
		"唑",
		"坐",
		"岝",
		"岞",
		"座",
		"祚",
		"糳",
		"胙",
		"葃",
		"葄",
		"蓙",
		"袏",
		"阼"
	],
	qīn: [
		"侵",
		"兓",
		"媇",
		"嵚",
		"嶔",
		"欽",
		"衾",
		"誛",
		"钦",
		"顉",
		"駸",
		"骎",
		"鮼"
	],
	jú: [
		"侷",
		"啹",
		"婅",
		"局",
		"巈",
		"椈",
		"橘",
		"泦",
		"淗",
		"湨",
		"焗",
		"犑",
		"狊",
		"粷",
		"菊",
		"蘜",
		"趜",
		"跼",
		"蹫",
		"輂",
		"郹",
		"閰",
		"駶",
		"驧",
		"鵙",
		"鵴",
		"鶪",
		"鼰",
		"鼳",
		"䴗"
	],
	"shù dōu": ["侸"],
	tǐng: [
		"侹",
		"圢",
		"娗",
		"挺",
		"涏",
		"烶",
		"珽",
		"脡",
		"艇",
		"誔",
		"頲",
		"颋"
	],
	shèn: [
		"侺",
		"愼",
		"慎",
		"昚",
		"涁",
		"渗",
		"滲",
		"瘆",
		"瘮",
		"眘",
		"祳",
		"肾",
		"胂",
		"脤",
		"腎",
		"蜃",
		"蜄",
		"鋠"
	],
	"tuì tuó": ["侻"],
	nán: [
		"侽",
		"喃",
		"娚",
		"抩",
		"暔",
		"枏",
		"柟",
		"楠",
		"男",
		"畘",
		"莮",
		"萳",
		"遖"
	],
	xiāo: [
		"侾",
		"哓",
		"嘵",
		"嚻",
		"囂",
		"婋",
		"宯",
		"宵",
		"庨",
		"彇",
		"揱",
		"枭",
		"枵",
		"梟",
		"櫹",
		"歊",
		"毊",
		"消",
		"潇",
		"瀟",
		"灱",
		"灲",
		"烋",
		"焇",
		"猇",
		"獢",
		"痚",
		"痟",
		"硝",
		"硣",
		"窙",
		"箫",
		"簘",
		"簫",
		"綃",
		"绡",
		"翛",
		"膮",
		"萧",
		"蕭",
		"虈",
		"虓",
		"蟂",
		"蟏",
		"蟰",
		"蠨",
		"踃",
		"逍",
		"銷",
		"销",
		"霄",
		"颵",
		"驍",
		"骁",
		"髇",
		"髐",
		"魈",
		"鴞",
		"鴵",
		"鷍",
		"鸮"
	],
	"biàn pián": [
		"便",
		"緶",
		"缏"
	],
	tuǐ: [
		"俀",
		"腿",
		"蹆",
		"骽"
	],
	xì: [
		"係",
		"匸",
		"卌",
		"呬",
		"墍",
		"屃",
		"屓",
		"屭",
		"忥",
		"怬",
		"恄",
		"椞",
		"潝",
		"潟",
		"澙",
		"熂",
		"犔",
		"磶",
		"禊",
		"細",
		"綌",
		"縘",
		"细",
		"绤",
		"舃",
		"舄",
		"蕮",
		"虩",
		"衋",
		"覤",
		"赩",
		"趇",
		"郤",
		"釳",
		"阋",
		"隙",
		"隟",
		"霼",
		"餼",
		"饩",
		"鬩",
		"黖"
	],
	cù: [
		"促",
		"媨",
		"憱",
		"猝",
		"瘄",
		"瘯",
		"簇",
		"縬",
		"脨",
		"蔟",
		"誎",
		"趗",
		"踧",
		"踿",
		"蹙",
		"蹴",
		"蹵",
		"醋",
		"顣",
		"鼀"
	],
	é: [
		"俄",
		"囮",
		"娥",
		"峉",
		"峨",
		"峩",
		"涐",
		"珴",
		"皒",
		"睋",
		"磀",
		"莪",
		"訛",
		"誐",
		"譌",
		"讹",
		"迗",
		"鈋",
		"鋨",
		"锇",
		"頟",
		"額",
		"额",
		"魤",
		"鵝",
		"鵞",
		"鹅"
	],
	qiú: [
		"俅",
		"叴",
		"唒",
		"囚",
		"崷",
		"巯",
		"巰",
		"扏",
		"梂",
		"殏",
		"毬",
		"求",
		"汓",
		"泅",
		"浗",
		"湭",
		"煪",
		"犰",
		"玌",
		"球",
		"璆",
		"皳",
		"盚",
		"紌",
		"絿",
		"肍",
		"芁",
		"莍",
		"虬",
		"虯",
		"蛷",
		"裘",
		"觓",
		"觩",
		"訄",
		"訅",
		"賕",
		"赇",
		"逎",
		"逑",
		"遒",
		"酋",
		"釚",
		"釻",
		"銶",
		"頄",
		"鮂",
		"鯄",
		"鰽",
		"鼽",
		"𨱇"
	],
	xú: [
		"俆",
		"徐",
		"禑"
	],
	"guàng kuāng": ["俇"],
	kù: [
		"俈",
		"喾",
		"嚳",
		"库",
		"庫",
		"廤",
		"瘔",
		"絝",
		"绔",
		"袴",
		"裤",
		"褲",
		"酷"
	],
	wù: [
		"俉",
		"务",
		"務",
		"勿",
		"卼",
		"坞",
		"塢",
		"奦",
		"婺",
		"寤",
		"屼",
		"岉",
		"嵨",
		"忢",
		"悞",
		"悟",
		"悮",
		"戊",
		"扤",
		"晤",
		"杌",
		"溩",
		"焐",
		"熃",
		"物",
		"痦",
		"矹",
		"窹",
		"粅",
		"蘁",
		"誤",
		"误",
		"鋈",
		"阢",
		"隖",
		"雾",
		"霚",
		"霧",
		"靰",
		"騖",
		"骛",
		"鶩",
		"鹜",
		"鼿",
		"齀"
	],
	jùn: [
		"俊",
		"儁",
		"呁",
		"埈",
		"寯",
		"峻",
		"懏",
		"捃",
		"攟",
		"晙",
		"棞",
		"燇",
		"珺",
		"畯",
		"竣",
		"箟",
		"蜠",
		"賐",
		"郡",
		"陖",
		"餕",
		"馂",
		"駿",
		"骏",
		"鵔",
		"鵕",
		"鵘",
		"䐃"
	],
	liáng: [
		"俍",
		"墚",
		"梁",
		"椋",
		"樑",
		"粮",
		"粱",
		"糧",
		"良",
		"輬",
		"辌",
		"𫟅"
	],
	zǔ: [
		"俎",
		"唨",
		"爼",
		"祖",
		"組",
		"组",
		"詛",
		"诅",
		"鎺",
		"阻",
		"靻"
	],
	"qiào xiào": ["俏"],
	yǒng: [
		"俑",
		"勇",
		"勈",
		"咏",
		"埇",
		"塎",
		"嵱",
		"彮",
		"怺",
		"恿",
		"悀",
		"惥",
		"愑",
		"愹",
		"慂",
		"柡",
		"栐",
		"永",
		"泳",
		"湧",
		"甬",
		"蛹",
		"詠",
		"踊",
		"踴",
		"鯒",
		"鲬"
	],
	hùn: [
		"俒",
		"倱",
		"圂",
		"尡",
		"慁",
		"掍",
		"溷",
		"焝",
		"睴",
		"觨",
		"諢",
		"诨"
	],
	jìng: [
		"俓",
		"傹",
		"境",
		"妌",
		"婙",
		"婧",
		"弪",
		"弳",
		"径",
		"徑",
		"敬",
		"曔",
		"桱",
		"梷",
		"浄",
		"瀞",
		"獍",
		"痉",
		"痙",
		"竞",
		"竟",
		"竫",
		"競",
		"竸",
		"胫",
		"脛",
		"莖",
		"誩",
		"踁",
		"迳",
		"逕",
		"鏡",
		"镜",
		"靖",
		"静",
		"靜",
		"鵛"
	],
	sàn: ["俕", "閐"],
	pěi: ["俖"],
	sú: ["俗"],
	xī: [
		"俙",
		"僖",
		"兮",
		"凞",
		"卥",
		"厀",
		"吸",
		"唏",
		"唽",
		"嘻",
		"噏",
		"嚱",
		"夕",
		"奚",
		"嬆",
		"嬉",
		"屖",
		"嵠",
		"巇",
		"希",
		"徆",
		"徯",
		"息",
		"悉",
		"悕",
		"惁",
		"惜",
		"昔",
		"晞",
		"晰",
		"晳",
		"曦",
		"析",
		"桸",
		"榽",
		"樨",
		"橀",
		"欷",
		"氥",
		"汐",
		"浠",
		"淅",
		"渓",
		"溪",
		"烯",
		"焁",
		"焈",
		"焟",
		"熄",
		"熈",
		"熙",
		"熹",
		"熺",
		"熻",
		"燨",
		"爔",
		"牺",
		"犀",
		"犠",
		"犧",
		"琋",
		"瘜",
		"皙",
		"睎",
		"瞦",
		"矽",
		"硒",
		"磎",
		"礂",
		"稀",
		"穸",
		"窸",
		"粞",
		"糦",
		"緆",
		"繥",
		"羲",
		"翕",
		"翖",
		"肸",
		"肹",
		"膝",
		"舾",
		"莃",
		"菥",
		"蒠",
		"蜥",
		"螅",
		"蟋",
		"蠵",
		"西",
		"觹",
		"觽",
		"觿",
		"譆",
		"谿",
		"豀",
		"豨",
		"豯",
		"貕",
		"赥",
		"邜",
		"鄎",
		"酅",
		"醯",
		"釸",
		"錫",
		"鏭",
		"鐊",
		"鑴",
		"锡",
		"隵",
		"餏",
		"饎",
		"饻",
		"鯑",
		"鵗",
		"鸂",
		"鼷"
	],
	lǐ: [
		"俚",
		"娌",
		"峢",
		"峲",
		"李",
		"欚",
		"浬",
		"澧",
		"理",
		"礼",
		"禮",
		"粴",
		"裏",
		"裡",
		"豊",
		"逦",
		"邐",
		"醴",
		"鋰",
		"锂",
		"鯉",
		"鱧",
		"鱱",
		"鲤",
		"鳢"
	],
	bǎo: [
		"保",
		"堢",
		"媬",
		"宝",
		"寚",
		"寳",
		"寶",
		"珤",
		"緥",
		"葆",
		"藵",
		"褓",
		"賲",
		"靌",
		"飹",
		"飽",
		"饱",
		"駂",
		"鳵",
		"鴇",
		"鸨"
	],
	"yú shù yù": ["俞"],
	"sì qí": ["俟"],
	"xìn shēn": ["信"],
	xiū: [
		"俢",
		"修",
		"咻",
		"庥",
		"樇",
		"烌",
		"羞",
		"脙",
		"脩",
		"臹",
		"貅",
		"銝",
		"鎀",
		"飍",
		"饈",
		"馐",
		"髤",
		"髹",
		"鮴",
		"鱃",
		"鵂",
		"鸺",
		"䗛"
	],
	dì: [
		"俤",
		"偙",
		"僀",
		"埊",
		"墑",
		"墬",
		"娣",
		"帝",
		"怟",
		"旳",
		"梊",
		"焍",
		"玓",
		"甋",
		"眱",
		"睇",
		"碲",
		"祶",
		"禘",
		"第",
		"締",
		"缔",
		"腣",
		"菂",
		"蒂",
		"蔕",
		"蝃",
		"蝭",
		"螮",
		"諦",
		"谛",
		"踶",
		"递",
		"逓",
		"遞",
		"遰",
		"鉪",
		"𤧛",
		"䗖"
	],
	chóu: [
		"俦",
		"儔",
		"嬦",
		"惆",
		"愁",
		"懤",
		"栦",
		"燽",
		"畴",
		"疇",
		"皗",
		"稠",
		"筹",
		"籌",
		"絒",
		"綢",
		"绸",
		"菗",
		"詶",
		"讎",
		"讐",
		"踌",
		"躊",
		"酧",
		"酬",
		"醻",
		"雔",
		"雠",
		"雦"
	],
	zhì: [
		"俧",
		"偫",
		"儨",
		"制",
		"劕",
		"垁",
		"娡",
		"寘",
		"帙",
		"帜",
		"幟",
		"庢",
		"庤",
		"廌",
		"彘",
		"徏",
		"徝",
		"志",
		"忮",
		"懥",
		"懫",
		"挃",
		"挚",
		"掷",
		"摯",
		"擲",
		"旘",
		"晊",
		"智",
		"栉",
		"桎",
		"梽",
		"櫍",
		"櫛",
		"治",
		"洷",
		"滍",
		"滞",
		"滯",
		"潌",
		"瀄",
		"炙",
		"熫",
		"狾",
		"猘",
		"璏",
		"瓆",
		"痔",
		"痣",
		"礩",
		"祑",
		"秩",
		"秷",
		"稚",
		"稺",
		"穉",
		"窒",
		"紩",
		"緻",
		"置",
		"翐",
		"膣",
		"至",
		"致",
		"芖",
		"蛭",
		"袟",
		"袠",
		"製",
		"覟",
		"觗",
		"觯",
		"觶",
		"誌",
		"豑",
		"豒",
		"貭",
		"質",
		"贄",
		"质",
		"贽",
		"跱",
		"踬",
		"躓",
		"輊",
		"轾",
		"郅",
		"銍",
		"鋕",
		"鑕",
		"铚",
		"锧",
		"陟",
		"隲",
		"雉",
		"駤",
		"騭",
		"騺",
		"驇",
		"骘",
		"鯯",
		"鴙",
		"鷙",
		"鸷",
		"𬃊"
	],
	"liǎ liǎng": ["俩"],
	jiǎn: [
		"俭",
		"倹",
		"儉",
		"减",
		"剪",
		"堿",
		"弿",
		"彅",
		"戩",
		"戬",
		"拣",
		"挸",
		"捡",
		"揀",
		"撿",
		"枧",
		"柬",
		"梘",
		"检",
		"検",
		"檢",
		"減",
		"湕",
		"瀽",
		"瑐",
		"睑",
		"瞼",
		"硷",
		"碱",
		"礆",
		"笕",
		"筧",
		"简",
		"簡",
		"絸",
		"繭",
		"翦",
		"茧",
		"藆",
		"蠒",
		"裥",
		"襇",
		"襉",
		"襺",
		"詃",
		"謇",
		"謭",
		"譾",
		"谫",
		"趼",
		"蹇",
		"鐗",
		"鬋",
		"鰎",
		"鹸",
		"鹻",
		"鹼"
	],
	huò: [
		"俰",
		"咟",
		"嚯",
		"嚿",
		"奯",
		"彠",
		"惑",
		"或",
		"擭",
		"旤",
		"曤",
		"檴",
		"沎",
		"湱",
		"瀖",
		"獲",
		"癨",
		"眓",
		"矐",
		"祸",
		"禍",
		"穫",
		"窢",
		"耯",
		"臛",
		"艧",
		"获",
		"蒦",
		"藿",
		"蠖",
		"謋",
		"貨",
		"货",
		"鍃",
		"鑊",
		"镬",
		"雘",
		"霍",
		"靃",
		"韄",
		"㸌"
	],
	"jù jū": [
		"俱",
		"据",
		"鋸",
		"锯"
	],
	xiào: [
		"俲",
		"傚",
		"効",
		"咲",
		"哮",
		"啸",
		"嘋",
		"嘨",
		"嘯",
		"孝",
		"效",
		"斅",
		"斆",
		"歗",
		"涍",
		"熽",
		"笑",
		"詨",
		"誟"
	],
	pái: [
		"俳",
		"徘",
		"牌",
		"犤",
		"猅",
		"簰",
		"簲",
		"輫"
	],
	biào: [
		"俵",
		"鰾",
		"鳔"
	],
	"chù tì": ["俶"],
	fèi: [
		"俷",
		"剕",
		"厞",
		"吠",
		"屝",
		"废",
		"廃",
		"廢",
		"昲",
		"曊",
		"櫠",
		"沸",
		"濷",
		"狒",
		"癈",
		"肺",
		"萉",
		"費",
		"费",
		"鐨",
		"镄",
		"陫",
		"靅",
		"鼣"
	],
	fèng: [
		"俸",
		"凤",
		"奉",
		"湗",
		"焨",
		"煈",
		"賵",
		"赗",
		"鳯",
		"鳳",
		"鴌"
	],
	ǎn: [
		"俺",
		"唵",
		"埯",
		"揞",
		"罯",
		"銨",
		"铵"
	],
	bèi: [
		"俻",
		"倍",
		"偝",
		"偹",
		"備",
		"僃",
		"备",
		"悖",
		"惫",
		"愂",
		"憊",
		"昁",
		"梖",
		"焙",
		"牬",
		"犕",
		"狈",
		"狽",
		"珼",
		"琲",
		"碚",
		"禙",
		"糒",
		"苝",
		"蓓",
		"蛽",
		"褙",
		"貝",
		"贝",
		"軰",
		"輩",
		"辈",
		"邶",
		"郥",
		"鄁",
		"鋇",
		"鐾",
		"钡",
		"鞁",
		"鞴",
		"𬇙"
	],
	yù: [
		"俼",
		"儥",
		"喅",
		"喩",
		"喻",
		"域",
		"堉",
		"妪",
		"嫗",
		"寓",
		"峪",
		"嶎",
		"庽",
		"彧",
		"御",
		"愈",
		"慾",
		"戫",
		"昱",
		"棛",
		"棜",
		"棫",
		"櫲",
		"欎",
		"欝",
		"欲",
		"毓",
		"浴",
		"淯",
		"滪",
		"潏",
		"澦",
		"灪",
		"焴",
		"煜",
		"燏",
		"燠",
		"爩",
		"狱",
		"獄",
		"玉",
		"琙",
		"瘉",
		"癒",
		"砡",
		"硢",
		"硲",
		"礇",
		"礖",
		"礜",
		"禦",
		"秗",
		"稢",
		"稶",
		"篽",
		"籞",
		"籲",
		"粖",
		"緎",
		"罭",
		"聿",
		"肀",
		"艈",
		"芋",
		"芌",
		"茟",
		"蒮",
		"蓣",
		"蓹",
		"蕷",
		"蘌",
		"蜟",
		"蜮",
		"袬",
		"裕",
		"誉",
		"諭",
		"譽",
		"谕",
		"豫",
		"軉",
		"輍",
		"逳",
		"遇",
		"遹",
		"郁",
		"醧",
		"鈺",
		"鋊",
		"錥",
		"鐭",
		"钰",
		"閾",
		"阈",
		"雤",
		"霱",
		"預",
		"预",
		"飫",
		"饇",
		"饫",
		"馭",
		"驈",
		"驭",
		"鬰",
		"鬱",
		"鬻",
		"魊",
		"鱊",
		"鳿",
		"鴥",
		"鴧",
		"鴪",
		"鵒",
		"鷸",
		"鸒",
		"鹆",
		"鹬"
	],
	xīn: [
		"俽",
		"噺",
		"妡",
		"嬜",
		"廞",
		"心",
		"忄",
		"忻",
		"惞",
		"新",
		"昕",
		"杺",
		"欣",
		"歆",
		"炘",
		"盺",
		"薪",
		"訢",
		"辛",
		"邤",
		"鈊",
		"鋅",
		"鑫",
		"锌",
		"馨",
		"馫",
		"䜣",
		"𫷷"
	],
	"hǔ chí": ["俿"],
	jiù: [
		"倃",
		"僦",
		"匓",
		"匛",
		"匶",
		"厩",
		"咎",
		"就",
		"廄",
		"廏",
		"廐",
		"慦",
		"捄",
		"救",
		"旧",
		"柩",
		"柾",
		"桕",
		"欍",
		"殧",
		"疚",
		"臼",
		"舅",
		"舊",
		"鯦",
		"鷲",
		"鹫",
		"麔",
		"齨",
		"㠇"
	],
	yáo: [
		"倄",
		"傜",
		"嗂",
		"垚",
		"堯",
		"姚",
		"媱",
		"尧",
		"尭",
		"峣",
		"嶢",
		"嶤",
		"徭",
		"揺",
		"搖",
		"摇",
		"摿",
		"暚",
		"榣",
		"烑",
		"爻",
		"猺",
		"珧",
		"瑤",
		"瑶",
		"磘",
		"窑",
		"窯",
		"窰",
		"肴",
		"蘨",
		"謠",
		"謡",
		"谣",
		"軺",
		"轺",
		"遙",
		"遥",
		"邎",
		"顤",
		"颻",
		"飖",
		"餆",
		"餚",
		"鰩",
		"鱙",
		"鳐"
	],
	"cuì zú": ["倅"],
	"liǎng liǎ": ["倆"],
	wǎn: [
		"倇",
		"唍",
		"婉",
		"惋",
		"挽",
		"晚",
		"晥",
		"晩",
		"晼",
		"梚",
		"椀",
		"琬",
		"畹",
		"皖",
		"盌",
		"碗",
		"綩",
		"綰",
		"绾",
		"脘",
		"萖",
		"踠",
		"輓",
		"鋔"
	],
	zǒng: [
		"倊",
		"偬",
		"傯",
		"嵸",
		"总",
		"惣",
		"捴",
		"搃",
		"摠",
		"燪",
		"総",
		"緫",
		"縂",
		"總",
		"蓗"
	],
	guān: [
		"倌",
		"关",
		"官",
		"棺",
		"瘝",
		"癏",
		"窤",
		"蒄",
		"関",
		"闗",
		"關",
		"鰥",
		"鱞",
		"鳏"
	],
	tiǎn: [
		"倎",
		"唺",
		"忝",
		"悿",
		"晪",
		"殄",
		"淟",
		"睓",
		"腆",
		"舔",
		"覥",
		"觍",
		"賟",
		"錪",
		"餂"
	],
	mén: [
		"們",
		"扪",
		"捫",
		"璊",
		"菛",
		"虋",
		"鍆",
		"钔",
		"門",
		"閅",
		"门",
		"𫞩"
	],
	"dǎo dào": ["倒"],
	"tán tàn": ["倓", "埮"],
	"juè jué": ["倔"],
	chuí: [
		"倕",
		"垂",
		"埀",
		"捶",
		"搥",
		"桘",
		"棰",
		"槌",
		"箠",
		"腄",
		"菙",
		"錘",
		"鎚",
		"锤",
		"陲",
		"顀"
	],
	xìng: [
		"倖",
		"姓",
		"婞",
		"嬹",
		"幸",
		"性",
		"悻",
		"杏",
		"涬",
		"緈",
		"臖",
		"荇",
		"莕",
		"葕"
	],
	péng: [
		"倗",
		"傰",
		"塜",
		"塳",
		"弸",
		"憉",
		"捀",
		"朋",
		"棚",
		"椖",
		"樥",
		"硼",
		"稝",
		"竼",
		"篷",
		"纄",
		"膨",
		"芃",
		"蓬",
		"蘕",
		"蟚",
		"蟛",
		"袶",
		"輣",
		"錋",
		"鑝",
		"韸",
		"韼",
		"騯",
		"髼",
		"鬅",
		"鬔",
		"鵬",
		"鹏"
	],
	"tǎng cháng": ["倘"],
	hòu: [
		"候",
		"厚",
		"后",
		"垕",
		"堠",
		"後",
		"洉",
		"茩",
		"豞",
		"逅",
		"郈",
		"鮜",
		"鱟",
		"鲎",
		"鲘"
	],
	tì: [
		"倜",
		"剃",
		"嚏",
		"嚔",
		"屉",
		"屜",
		"悌",
		"悐",
		"惕",
		"惖",
		"戻",
		"掦",
		"替",
		"朑",
		"歒",
		"殢",
		"涕",
		"瓋",
		"笹",
		"籊",
		"薙",
		"褅",
		"逖",
		"逷",
		"髰",
		"鬀",
		"鬄"
	],
	gàn: [
		"倝",
		"凎",
		"幹",
		"榦",
		"檊",
		"淦",
		"灨",
		"盰",
		"紺",
		"绀",
		"詌",
		"贑",
		"赣",
		"骭",
		"㽏"
	],
	"liàng jìng": ["倞", "靓"],
	suī: [
		"倠",
		"哸",
		"夊",
		"滖",
		"濉",
		"眭",
		"睢",
		"芕",
		"荽",
		"荾",
		"虽",
		"雖",
		"鞖"
	],
	"chàng chāng": ["倡"],
	jié: [
		"倢",
		"偼",
		"傑",
		"刦",
		"刧",
		"刼",
		"劫",
		"劼",
		"卩",
		"卪",
		"婕",
		"媫",
		"孑",
		"岊",
		"崨",
		"嵥",
		"嶻",
		"巀",
		"幯",
		"截",
		"捷",
		"掶",
		"擮",
		"昅",
		"杢",
		"杰",
		"桀",
		"桝",
		"楬",
		"楶",
		"榤",
		"洁",
		"滐",
		"潔",
		"狤",
		"睫",
		"礍",
		"竭",
		"節",
		"羯",
		"莭",
		"蓵",
		"蛣",
		"蜐",
		"蠘",
		"蠞",
		"蠽",
		"衱",
		"袺",
		"訐",
		"詰",
		"誱",
		"讦",
		"踕",
		"迼",
		"鉣",
		"鍻",
		"镼",
		"頡",
		"鮚",
		"鲒",
		"㛃"
	],
	"kǒng kōng": ["倥"],
	juàn: [
		"倦",
		"劵",
		"奆",
		"慻",
		"桊",
		"淃",
		"狷",
		"獧",
		"眷",
		"睊",
		"睠",
		"絭",
		"絹",
		"绢",
		"罥",
		"羂",
		"腃",
		"蔨",
		"鄄",
		"餋"
	],
	zōng: [
		"倧",
		"堫",
		"宗",
		"嵏",
		"嵕",
		"惾",
		"朡",
		"棕",
		"椶",
		"熧",
		"猣",
		"磫",
		"緃",
		"翪",
		"腙",
		"葼",
		"蝬",
		"豵",
		"踨",
		"踪",
		"蹤",
		"鍐",
		"鑁",
		"騌",
		"騣",
		"骔",
		"鬃",
		"鬉",
		"鬷",
		"鯮",
		"鯼"
	],
	ní: [
		"倪",
		"坭",
		"埿",
		"尼",
		"屔",
		"怩",
		"淣",
		"猊",
		"籾",
		"聣",
		"蚭",
		"蜺",
		"觬",
		"貎",
		"跜",
		"輗",
		"郳",
		"鈮",
		"铌",
		"霓",
		"馜",
		"鯢",
		"鲵",
		"麑",
		"齯",
		"𫐐",
		"𫠜"
	],
	zhuō: [
		"倬",
		"拙",
		"捉",
		"桌",
		"梲",
		"棁",
		"棳",
		"槕",
		"涿",
		"窧",
		"鐯",
		"䦃"
	],
	"wō wēi": ["倭"],
	luǒ: [
		"倮",
		"剆",
		"曪",
		"瘰",
		"癳",
		"臝",
		"蓏",
		"蠃",
		"裸",
		"躶"
	],
	sōng: [
		"倯",
		"凇",
		"娀",
		"崧",
		"嵩",
		"庺",
		"憽",
		"松",
		"枀",
		"枩",
		"柗",
		"梥",
		"檧",
		"淞",
		"濍",
		"硹",
		"菘",
		"鬆"
	],
	lèng: [
		"倰",
		"堎",
		"愣",
		"睖",
		"踜"
	],
	zì: [
		"倳",
		"剚",
		"字",
		"恣",
		"渍",
		"漬",
		"牸",
		"眥",
		"眦",
		"胔",
		"胾",
		"自",
		"茡",
		"荢"
	],
	bèn: [
		"倴",
		"坌",
		"捹",
		"撪",
		"渀",
		"笨",
		"逩"
	],
	cǎi: [
		"倸",
		"啋",
		"婇",
		"彩",
		"採",
		"棌",
		"毝",
		"睬",
		"綵",
		"跴",
		"踩"
	],
	zhài: [
		"债",
		"債",
		"寨",
		"瘵",
		"砦"
	],
	yē: [
		"倻",
		"吔",
		"噎",
		"擨",
		"暍",
		"椰",
		"歋",
		"潱",
		"蠮"
	],
	shà: [
		"倽",
		"唼",
		"喢",
		"歃",
		"箑",
		"翜",
		"翣",
		"萐",
		"閯",
		"霎"
	],
	qīng: [
		"倾",
		"傾",
		"卿",
		"圊",
		"寈",
		"氢",
		"氫",
		"淸",
		"清",
		"蜻",
		"軽",
		"輕",
		"轻",
		"郬",
		"錆",
		"鑋",
		"靑",
		"青",
		"鯖"
	],
	yīng: [
		"偀",
		"嘤",
		"噟",
		"嚶",
		"婴",
		"媖",
		"嫈",
		"嬰",
		"孆",
		"孾",
		"愥",
		"撄",
		"攖",
		"朠",
		"桜",
		"樱",
		"櫻",
		"渶",
		"煐",
		"珱",
		"瑛",
		"璎",
		"瓔",
		"甇",
		"甖",
		"碤",
		"礯",
		"緓",
		"纓",
		"绬",
		"缨",
		"罂",
		"罃",
		"罌",
		"膺",
		"英",
		"莺",
		"蘡",
		"蝧",
		"蠳",
		"褮",
		"譻",
		"賏",
		"軈",
		"鑍",
		"锳",
		"霙",
		"韺",
		"鴬",
		"鶑",
		"鶧",
		"鶯",
		"鷪",
		"鷹",
		"鸎",
		"鸚",
		"鹦",
		"鹰",
		"䓨"
	],
	"chēng chèn": ["偁", "爯"],
	ruǎn: [
		"偄",
		"朊",
		"瑌",
		"瓀",
		"碝",
		"礝",
		"腝",
		"軟",
		"輭",
		"软",
		"阮"
	],
	"zhòng tóng": ["偅"],
	chǔn: [
		"偆",
		"惷",
		"睶",
		"萶",
		"蠢",
		"賰"
	],
	"jiǎ jià": ["假"],
	"jì jié": ["偈"],
	"bǐng bìng": ["偋"],
	ruò: [
		"偌",
		"叒",
		"嵶",
		"弱",
		"楉",
		"焫",
		"爇",
		"箬",
		"篛",
		"蒻",
		"鄀",
		"鰙",
		"鰯",
		"鶸"
	],
	tí: [
		"偍",
		"厗",
		"啼",
		"嗁",
		"崹",
		"漽",
		"瑅",
		"睼",
		"禵",
		"稊",
		"緹",
		"缇",
		"罤",
		"蕛",
		"褆",
		"謕",
		"趧",
		"蹄",
		"蹏",
		"醍",
		"鍗",
		"題",
		"题",
		"騠",
		"鮷",
		"鯷",
		"鳀",
		"鵜",
		"鷤",
		"鹈",
		"𫘨"
	],
	wēi: [
		"偎",
		"危",
		"喴",
		"威",
		"媙",
		"嶶",
		"巍",
		"微",
		"愄",
		"揋",
		"揻",
		"椳",
		"楲",
		"溦",
		"烓",
		"煨",
		"燰",
		"癓",
		"縅",
		"葨",
		"葳",
		"薇",
		"蜲",
		"蝛",
		"覣",
		"詴",
		"逶",
		"隇",
		"隈",
		"霺",
		"鰃",
		"鰄",
		"鳂"
	],
	piān: [
		"偏",
		"囨",
		"媥",
		"楄",
		"犏",
		"篇",
		"翩",
		"鍂"
	],
	yàn: [
		"偐",
		"厌",
		"厭",
		"唁",
		"喭",
		"嚈",
		"嚥",
		"堰",
		"妟",
		"姲",
		"嬊",
		"嬿",
		"宴",
		"彥",
		"彦",
		"敥",
		"晏",
		"暥",
		"曕",
		"曣",
		"滟",
		"灎",
		"灔",
		"灧",
		"灩",
		"焔",
		"焰",
		"焱",
		"熖",
		"燄",
		"牪",
		"猒",
		"砚",
		"硯",
		"艳",
		"艶",
		"艷",
		"覎",
		"觃",
		"觾",
		"諺",
		"讌",
		"讞",
		"谚",
		"谳",
		"豓",
		"豔",
		"贋",
		"贗",
		"赝",
		"軅",
		"酀",
		"酽",
		"醼",
		"釅",
		"雁",
		"餍",
		"饜",
		"騐",
		"験",
		"騴",
		"驗",
		"驠",
		"验",
		"鬳",
		"鳫",
		"鴈",
		"鴳",
		"鷃",
		"鷰",
		"齞"
	],
	"tǎng dàng": ["偒"],
	è: [
		"偔",
		"匎",
		"卾",
		"厄",
		"呝",
		"咢",
		"噩",
		"垩",
		"堊",
		"堮",
		"岋",
		"崿",
		"廅",
		"悪",
		"愕",
		"戹",
		"扼",
		"搤",
		"搹",
		"擜",
		"櫮",
		"歞",
		"歺",
		"湂",
		"琧",
		"砈",
		"砐",
		"硆",
		"腭",
		"苊",
		"萼",
		"蕚",
		"蚅",
		"蝁",
		"覨",
		"諤",
		"讍",
		"谔",
		"豟",
		"軛",
		"軶",
		"轭",
		"遌",
		"遏",
		"遻",
		"鄂",
		"鈪",
		"鍔",
		"鑩",
		"锷",
		"阨",
		"阸",
		"頞",
		"顎",
		"颚",
		"餓",
		"餩",
		"饿",
		"鰐",
		"鰪",
		"鱷",
		"鳄",
		"鶚",
		"鹗",
		"齃",
		"齶",
		"𫫇",
		"𥔲"
	],
	xié: [
		"偕",
		"勰",
		"协",
		"協",
		"嗋",
		"垥",
		"奊",
		"恊",
		"愶",
		"拹",
		"携",
		"撷",
		"擕",
		"擷",
		"攜",
		"斜",
		"旪",
		"熁",
		"燲",
		"綊",
		"緳",
		"縀",
		"缬",
		"翓",
		"胁",
		"脅",
		"脇",
		"脋",
		"膎",
		"蝢",
		"衺",
		"襭",
		"諧",
		"讗",
		"谐",
		"鞋",
		"鞵",
		"龤",
		"㙦"
	],
	chě: [
		"偖",
		"扯",
		"撦"
	],
	shěng: [
		"偗",
		"渻",
		"眚"
	],
	chā: [
		"偛",
		"嗏",
		"扠",
		"挿",
		"插",
		"揷",
		"疀",
		"臿",
		"艖",
		"銟",
		"鍤",
		"锸",
		"餷"
	],
	huáng: [
		"偟",
		"凰",
		"喤",
		"堭",
		"墴",
		"媓",
		"崲",
		"徨",
		"惶",
		"楻",
		"湟",
		"煌",
		"獚",
		"瑝",
		"璜",
		"癀",
		"皇",
		"磺",
		"穔",
		"篁",
		"簧",
		"艎",
		"葟",
		"蝗",
		"蟥",
		"諻",
		"趪",
		"遑",
		"鍠",
		"鐄",
		"锽",
		"隍",
		"韹",
		"餭",
		"騜",
		"鰉",
		"鱑",
		"鳇",
		"鷬",
		"黃",
		"黄",
		"𨱑"
	],
	yǎo: [
		"偠",
		"咬",
		"婹",
		"宎",
		"岆",
		"杳",
		"柼",
		"榚",
		"溔",
		"狕",
		"窅",
		"窈",
		"舀",
		"苭",
		"闄",
		"騕",
		"鷕",
		"齩"
	],
	"chǒu qiào": ["偢"],
	yóu: [
		"偤",
		"尤",
		"庮",
		"怣",
		"沋",
		"油",
		"浟",
		"游",
		"犹",
		"猶",
		"猷",
		"由",
		"疣",
		"秞",
		"肬",
		"莜",
		"莸",
		"蕕",
		"蚰",
		"蝣",
		"訧",
		"輏",
		"輶",
		"逰",
		"遊",
		"邮",
		"郵",
		"鈾",
		"铀",
		"駀",
		"魷",
		"鮋",
		"鱿",
		"鲉",
		"𬨎"
	],
	xū: [
		"偦",
		"墟",
		"媭",
		"嬃",
		"楈",
		"欨",
		"歔",
		"燸",
		"疞",
		"盱",
		"綇",
		"縃",
		"繻",
		"胥",
		"蕦",
		"虗",
		"虚",
		"虛",
		"蝑",
		"裇",
		"訏",
		"許",
		"諝",
		"譃",
		"谞",
		"鑐",
		"需",
		"須",
		"须",
		"顼",
		"驉",
		"鬚",
		"魆",
		"魖",
		"𬣙",
		"𦈡"
	],
	zhā: [
		"偧",
		"哳",
		"抯",
		"挓",
		"揸",
		"摣",
		"樝",
		"渣",
		"皶",
		"觰",
		"譇",
		"齄",
		"齇"
	],
	cī: [
		"偨",
		"疵",
		"蠀",
		"趀",
		"骴",
		"髊",
		"齹"
	],
	bī: [
		"偪",
		"屄",
		"楅",
		"毴",
		"豍",
		"逼",
		"鰏",
		"鲾",
		"鵖"
	],
	xún: [
		"偱",
		"噚",
		"寻",
		"尋",
		"峋",
		"巡",
		"廵",
		"循",
		"恂",
		"揗",
		"攳",
		"旬",
		"杊",
		"栒",
		"桪",
		"樳",
		"洵",
		"浔",
		"潯",
		"燅",
		"燖",
		"珣",
		"璕",
		"畃",
		"紃",
		"荀",
		"蟳",
		"詢",
		"询",
		"鄩",
		"鱏",
		"鱘",
		"鲟",
		"𬘓",
		"𬩽",
		"𬍤",
		"𬊈"
	],
	"cāi sī": ["偲"],
	duān: [
		"偳",
		"媏",
		"端",
		"褍",
		"鍴"
	],
	ǒu: [
		"偶",
		"吘",
		"嘔",
		"耦",
		"腢",
		"蕅",
		"藕",
		"𬉼",
		"𠙶"
	],
	tōu: [
		"偷",
		"偸",
		"鍮"
	],
	"zán zá zǎ": ["偺"],
	"lǚ lóu": ["偻", "僂"],
	fèn: [
		"偾",
		"僨",
		"奋",
		"奮",
		"弅",
		"忿",
		"愤",
		"憤",
		"瀵",
		"瞓",
		"秎",
		"粪",
		"糞",
		"膹",
		"鱝",
		"鲼"
	],
	"kuǐ guī": ["傀"],
	sǒu: [
		"傁",
		"叜",
		"叟",
		"嗾",
		"櫢",
		"瞍",
		"薮",
		"藪"
	],
	"zhì sī tí": ["傂"],
	sù: [
		"傃",
		"僳",
		"嗉",
		"塐",
		"塑",
		"夙",
		"嫊",
		"愫",
		"憟",
		"榡",
		"樎",
		"樕",
		"殐",
		"泝",
		"涑",
		"溯",
		"溸",
		"潚",
		"潥",
		"玊",
		"珟",
		"璛",
		"簌",
		"粛",
		"粟",
		"素",
		"縤",
		"肃",
		"肅",
		"膆",
		"蔌",
		"藗",
		"觫",
		"訴",
		"謖",
		"诉",
		"谡",
		"趚",
		"蹜",
		"速",
		"遡",
		"遬",
		"鋉",
		"餗",
		"驌",
		"骕",
		"鱐",
		"鷫",
		"鹔",
		"𫗧"
	],
	xiā: [
		"傄",
		"煆",
		"瞎",
		"虲",
		"谺",
		"颬",
		"鰕"
	],
	"yuàn yuán": ["傆", "媛"],
	rǒng: [
		"傇",
		"冗",
		"宂",
		"氄",
		"軵"
	],
	nù: ["傉", "怒"],
	yùn: [
		"傊",
		"孕",
		"恽",
		"惲",
		"愠",
		"慍",
		"枟",
		"腪",
		"蕴",
		"薀",
		"藴",
		"蘊",
		"褞",
		"貟",
		"运",
		"運",
		"郓",
		"鄆",
		"酝",
		"醖",
		"醞",
		"韗",
		"韞",
		"韵",
		"韻",
		"餫"
	],
	"gòu jiǎng": ["傋"],
	mà: [
		"傌",
		"嘜",
		"榪",
		"睰",
		"祃",
		"禡",
		"罵",
		"閁",
		"駡",
		"骂",
		"鬕"
	],
	bàng: [
		"傍",
		"塝",
		"棒",
		"玤",
		"稖",
		"艕",
		"蒡",
		"蜯",
		"謗",
		"谤",
		"鎊",
		"镑"
	],
	diān: [
		"傎",
		"厧",
		"嵮",
		"巅",
		"巓",
		"巔",
		"掂",
		"攧",
		"敁",
		"槇",
		"滇",
		"癫",
		"癲",
		"蹎",
		"顚",
		"顛",
		"颠",
		"齻"
	],
	táng: [
		"傏",
		"唐",
		"啺",
		"坣",
		"堂",
		"塘",
		"搪",
		"棠",
		"榶",
		"溏",
		"漟",
		"煻",
		"瑭",
		"磄",
		"禟",
		"篖",
		"糃",
		"糖",
		"糛",
		"膅",
		"膛",
		"蓎",
		"螗",
		"螳",
		"赯",
		"踼",
		"鄌",
		"醣",
		"鎕",
		"隚",
		"餹",
		"饄",
		"鶶",
		"䣘"
	],
	hào: [
		"傐",
		"哠",
		"恏",
		"昊",
		"昦",
		"晧",
		"暠",
		"暤",
		"暭",
		"曍",
		"浩",
		"淏",
		"澔",
		"灏",
		"灝",
		"皓",
		"皜",
		"皞",
		"皡",
		"皥",
		"耗",
		"聕",
		"薃",
		"號",
		"鄗",
		"顥",
		"颢",
		"鰝"
	],
	"xī xì": ["傒"],
	shān: [
		"傓",
		"删",
		"刪",
		"剼",
		"圸",
		"山",
		"挻",
		"搧",
		"柵",
		"檆",
		"潸",
		"澘",
		"煽",
		"狦",
		"珊",
		"笘",
		"縿",
		"羴",
		"羶",
		"脠",
		"舢",
		"芟",
		"衫",
		"跚",
		"軕",
		"邖",
		"閊",
		"鯅"
	],
	"qiàn jiān": ["傔"],
	"què jué": ["傕", "埆"],
	"cāng chen": ["傖"],
	róng: [
		"傛",
		"媶",
		"嫆",
		"嬫",
		"容",
		"峵",
		"嵘",
		"嶸",
		"戎",
		"搈",
		"曧",
		"栄",
		"榕",
		"榮",
		"榵",
		"毧",
		"溶",
		"瀜",
		"烿",
		"熔",
		"狨",
		"瑢",
		"穁",
		"絨",
		"绒",
		"羢",
		"肜",
		"茙",
		"茸",
		"荣",
		"蓉",
		"蝾",
		"融",
		"螎",
		"蠑",
		"褣",
		"鎔",
		"镕",
		"駥"
	],
	"tà tàn": ["傝"],
	suō: [
		"傞",
		"唆",
		"嗍",
		"嗦",
		"娑",
		"摍",
		"桫",
		"梭",
		"睃",
		"簑",
		"簔",
		"羧",
		"莏",
		"蓑",
		"趖",
		"鮻"
	],
	dǎi: ["傣", "歹"],
	zài: [
		"傤",
		"儎",
		"再",
		"在",
		"扗",
		"洅",
		"載",
		"酨"
	],
	gǔ: [
		"傦",
		"古",
		"啒",
		"尳",
		"愲",
		"榖",
		"榾",
		"汩",
		"淈",
		"濲",
		"瀔",
		"牯",
		"皷",
		"皼",
		"盬",
		"瞽",
		"穀",
		"罟",
		"羖",
		"股",
		"脵",
		"臌",
		"薣",
		"蛊",
		"蠱",
		"詁",
		"诂",
		"轂",
		"逧",
		"鈷",
		"钴",
		"餶",
		"馉",
		"鼓",
		"鼔",
		"𦙶"
	],
	bīn: [
		"傧",
		"宾",
		"彬",
		"斌",
		"椕",
		"滨",
		"濒",
		"濱",
		"濵",
		"瀕",
		"繽",
		"缤",
		"虨",
		"豩",
		"豳",
		"賓",
		"賔",
		"邠",
		"鑌",
		"镔",
		"霦",
		"顮"
	],
	chǔ: [
		"储",
		"儲",
		"杵",
		"椘",
		"楚",
		"楮",
		"檚",
		"濋",
		"璴",
		"础",
		"礎",
		"禇",
		"處",
		"齭",
		"齼",
		"𬺓"
	],
	nuó: [
		"傩",
		"儺",
		"挪",
		"梛",
		"橠"
	],
	"cān càn": ["傪"],
	lěi: [
		"傫",
		"儡",
		"厽",
		"垒",
		"塁",
		"壘",
		"壨",
		"櫐",
		"灅",
		"癗",
		"矋",
		"磊",
		"礨",
		"耒",
		"蕌",
		"蕾",
		"藟",
		"蘽",
		"蠝",
		"誄",
		"讄",
		"诔",
		"鑸",
		"鸓"
	],
	cuī: [
		"催",
		"凗",
		"墔",
		"崔",
		"嵟",
		"慛",
		"摧",
		"榱",
		"獕",
		"磪",
		"鏙"
	],
	yōng: [
		"傭",
		"嗈",
		"墉",
		"壅",
		"嫞",
		"庸",
		"廱",
		"慵",
		"拥",
		"擁",
		"滽",
		"灉",
		"牅",
		"痈",
		"癕",
		"癰",
		"臃",
		"邕",
		"郺",
		"鄘",
		"鏞",
		"镛",
		"雍",
		"雝",
		"饔",
		"鱅",
		"鳙",
		"鷛"
	],
	"zāo cáo": ["傮"],
	sǒng: [
		"傱",
		"嵷",
		"怂",
		"悚",
		"愯",
		"慫",
		"竦",
		"耸",
		"聳",
		"駷",
		"㧐"
	],
	ào: [
		"傲",
		"坳",
		"垇",
		"墺",
		"奡",
		"嫯",
		"岙",
		"岰",
		"嶴",
		"懊",
		"擙",
		"澳",
		"鏊",
		"驁",
		"骜"
	],
	"qī còu": ["傶"],
	chuǎng: [
		"傸",
		"磢",
		"闖",
		"闯"
	],
	shǎ: ["傻", "儍"],
	hàn: [
		"傼",
		"垾",
		"悍",
		"憾",
		"扞",
		"捍",
		"撖",
		"撼",
		"旱",
		"晘",
		"暵",
		"汉",
		"涆",
		"漢",
		"瀚",
		"焊",
		"猂",
		"皔",
		"睅",
		"翰",
		"莟",
		"菡",
		"蛿",
		"蜭",
		"螒",
		"譀",
		"輚",
		"釬",
		"銲",
		"鋎",
		"雗",
		"頷",
		"顄",
		"颔",
		"駻",
		"鶾"
	],
	zhāng: [
		"傽",
		"嫜",
		"张",
		"張",
		"彰",
		"慞",
		"暲",
		"樟",
		"漳",
		"獐",
		"璋",
		"章",
		"粻",
		"蔁",
		"蟑",
		"遧",
		"鄣",
		"鏱",
		"餦",
		"騿",
		"鱆",
		"麞"
	],
	"yān yàn": [
		"傿",
		"墕",
		"嬮"
	],
	"piào biāo": ["僄", "骠"],
	liàn: [
		"僆",
		"堜",
		"媡",
		"恋",
		"戀",
		"楝",
		"殓",
		"殮",
		"湅",
		"潋",
		"澰",
		"瀲",
		"炼",
		"煉",
		"瑓",
		"練",
		"纞",
		"练",
		"萰",
		"錬",
		"鍊",
		"鏈",
		"链",
		"鰊",
		"𬶠"
	],
	màn: [
		"㵘",
		"僈",
		"墁",
		"幔",
		"慢",
		"曼",
		"漫",
		"澷",
		"熳",
		"獌",
		"縵",
		"缦",
		"蔄",
		"蘰",
		"鄤",
		"鏝",
		"镘",
		"𬜬"
	],
	"tàn tǎn": ["僋"],
	yíng: [
		"僌",
		"営",
		"塋",
		"嬴",
		"攍",
		"楹",
		"櫿",
		"溁",
		"溋",
		"滢",
		"潆",
		"濙",
		"濚",
		"濴",
		"瀅",
		"瀛",
		"瀠",
		"瀯",
		"灐",
		"灜",
		"熒",
		"營",
		"瑩",
		"盁",
		"盈",
		"禜",
		"籝",
		"籯",
		"縈",
		"茔",
		"荧",
		"莹",
		"萤",
		"营",
		"萦",
		"萾",
		"蓥",
		"藀",
		"蛍",
		"蝇",
		"蝿",
		"螢",
		"蠅",
		"謍",
		"贏",
		"赢",
		"迎",
		"鎣"
	],
	dòng: [
		"働",
		"冻",
		"凍",
		"动",
		"動",
		"姛",
		"戙",
		"挏",
		"栋",
		"棟",
		"湩",
		"硐",
		"胨",
		"胴",
		"腖",
		"迵",
		"霘",
		"駧"
	],
	zhuàn: [
		"僎",
		"啭",
		"囀",
		"堟",
		"撰",
		"灷",
		"瑑",
		"篆",
		"腞",
		"蒃",
		"襈",
		"譔",
		"饌",
		"馔"
	],
	xiàng: [
		"像",
		"勨",
		"向",
		"嚮",
		"姠",
		"嶑",
		"曏",
		"橡",
		"珦",
		"缿",
		"蟓",
		"衖",
		"襐",
		"象",
		"鐌",
		"項",
		"项",
		"鱌"
	],
	shàn: [
		"僐",
		"善",
		"墠",
		"墡",
		"嬗",
		"擅",
		"敾",
		"椫",
		"樿",
		"歚",
		"汕",
		"灗",
		"疝",
		"磰",
		"繕",
		"缮",
		"膳",
		"蟮",
		"蟺",
		"訕",
		"謆",
		"譱",
		"讪",
		"贍",
		"赡",
		"赸",
		"鄯",
		"鐥",
		"饍",
		"騸",
		"骟",
		"鱓",
		"鱔",
		"鳝",
		"𫮃"
	],
	"tuí tuǐ": ["僓"],
	zǔn: [
		"僔",
		"噂",
		"撙",
		"譐"
	],
	pú: [
		"僕",
		"匍",
		"圤",
		"墣",
		"濮",
		"獛",
		"璞",
		"瞨",
		"穙",
		"莆",
		"菐",
		"菩",
		"葡",
		"蒱",
		"蒲",
		"贌",
		"酺",
		"鏷",
		"镤"
	],
	láo: [
		"僗",
		"劳",
		"労",
		"勞",
		"哰",
		"崂",
		"嶗",
		"憥",
		"朥",
		"浶",
		"牢",
		"痨",
		"癆",
		"窂",
		"簩",
		"醪",
		"鐒",
		"铹",
		"顟",
		"髝",
		"𫭼"
	],
	chǎng: [
		"僘",
		"厰",
		"廠",
		"敞",
		"昶",
		"氅",
		"鋹",
		"𬬮"
	],
	guāng: [
		"僙",
		"光",
		"咣",
		"垙",
		"姯",
		"洸",
		"灮",
		"炗",
		"炚",
		"炛",
		"烡",
		"珖",
		"胱",
		"茪",
		"輄",
		"銧",
		"黆",
		"𨐈"
	],
	liáo: [
		"僚",
		"嘹",
		"嫽",
		"寥",
		"寮",
		"尞",
		"屪",
		"嵺",
		"嶚",
		"嶛",
		"廫",
		"憀",
		"敹",
		"暸",
		"橑",
		"獠",
		"璙",
		"疗",
		"療",
		"竂",
		"簝",
		"繚",
		"缭",
		"聊",
		"膋",
		"膫",
		"藔",
		"蟟",
		"豂",
		"賿",
		"蹘",
		"辽",
		"遼",
		"飉",
		"髎",
		"鷯",
		"鹩"
	],
	dèng: [
		"僜",
		"凳",
		"墱",
		"嶝",
		"櫈",
		"瞪",
		"磴",
		"覴",
		"邓",
		"鄧",
		"隥"
	],
	"chán zhàn zhuàn": ["僝"],
	bō: [
		"僠",
		"嶓",
		"拨",
		"撥",
		"播",
		"波",
		"溊",
		"玻",
		"癶",
		"盋",
		"砵",
		"碆",
		"礡",
		"缽",
		"菠",
		"袰",
		"蹳",
		"鉢",
		"钵",
		"餑",
		"饽",
		"驋",
		"鱍",
		"𬭛"
	],
	huì: [
		"僡",
		"匯",
		"卉",
		"喙",
		"嘒",
		"嚖",
		"圚",
		"嬒",
		"寭",
		"屶",
		"屷",
		"彗",
		"彙",
		"彚",
		"徻",
		"恚",
		"恵",
		"惠",
		"慧",
		"憓",
		"懳",
		"晦",
		"暳",
		"槥",
		"橞",
		"檅",
		"櫘",
		"汇",
		"泋",
		"滙",
		"潓",
		"烩",
		"燴",
		"獩",
		"璤",
		"瞺",
		"硊",
		"秽",
		"穢",
		"篲",
		"絵",
		"繪",
		"绘",
		"翙",
		"翽",
		"荟",
		"蔧",
		"蕙",
		"薈",
		"薉",
		"蟪",
		"詯",
		"誨",
		"諱",
		"譓",
		"譿",
		"讳",
		"诲",
		"賄",
		"贿",
		"鐬",
		"闠",
		"阓",
		"靧",
		"頮",
		"顪",
		"颒",
		"餯",
		"𬤝",
		"𬭬"
	],
	chuǎn: [
		"僢",
		"喘",
		"舛",
		"荈",
		"踳"
	],
	"tiě jiàn": ["僣"],
	sēng: ["僧", "鬙"],
	xiàn: [
		"僩",
		"僴",
		"哯",
		"垷",
		"塪",
		"姭",
		"娊",
		"宪",
		"岘",
		"峴",
		"憲",
		"撊",
		"晛",
		"橌",
		"橺",
		"涀",
		"瀗",
		"献",
		"獻",
		"现",
		"現",
		"県",
		"睍",
		"粯",
		"糮",
		"絤",
		"綫",
		"線",
		"线",
		"缐",
		"羡",
		"羨",
		"腺",
		"臔",
		"臽",
		"苋",
		"莧",
		"誢",
		"豏",
		"鋧",
		"錎",
		"限",
		"陥",
		"陷",
		"霰",
		"餡",
		"馅",
		"麲",
		"鼸",
		"𬀪",
		"𪾢"
	],
	"yù jú": ["僪"],
	"è wū": ["僫"],
	"tóng zhuàng": ["僮"],
	lǐn: [
		"僯",
		"凛",
		"凜",
		"廩",
		"廪",
		"懍",
		"懔",
		"撛",
		"檁",
		"檩",
		"澟",
		"癛",
		"癝"
	],
	gù: [
		"僱",
		"凅",
		"固",
		"堌",
		"崓",
		"崮",
		"故",
		"梏",
		"棝",
		"牿",
		"痼",
		"祻",
		"錮",
		"锢",
		"雇",
		"顧",
		"顾",
		"鯝",
		"鲴"
	],
	jiāng: [
		"僵",
		"壃",
		"姜",
		"橿",
		"殭",
		"江",
		"畕",
		"疅",
		"礓",
		"繮",
		"缰",
		"翞",
		"茳",
		"葁",
		"薑",
		"螀",
		"螿",
		"豇",
		"韁",
		"鱂",
		"鳉"
	],
	mǐn: [
		"僶",
		"冺",
		"刡",
		"勄",
		"悯",
		"惽",
		"愍",
		"慜",
		"憫",
		"抿",
		"敃",
		"敏",
		"敯",
		"泯",
		"潣",
		"皿",
		"笢",
		"笽",
		"簢",
		"蠠",
		"閔",
		"閩",
		"闵",
		"闽",
		"鰵",
		"鳘",
		"黽"
	],
	jìn: [
		"僸",
		"凚",
		"噤",
		"嚍",
		"墐",
		"壗",
		"妗",
		"嬧",
		"搢",
		"晉",
		"晋",
		"枃",
		"殣",
		"浕",
		"浸",
		"溍",
		"濅",
		"濜",
		"烬",
		"煡",
		"燼",
		"琎",
		"瑨",
		"璶",
		"盡",
		"祲",
		"縉",
		"缙",
		"荩",
		"藎",
		"覲",
		"觐",
		"賮",
		"贐",
		"赆",
		"近",
		"进",
		"進",
		"靳",
		"齽"
	],
	"jià jie": ["價"],
	qiào: [
		"僺",
		"峭",
		"帩",
		"撬",
		"殻",
		"窍",
		"竅",
		"誚",
		"诮",
		"躈",
		"陗",
		"鞩",
		"韒",
		"髚"
	],
	pì: [
		"僻",
		"媲",
		"嫓",
		"屁",
		"澼",
		"甓",
		"疈",
		"譬",
		"闢",
		"鷿",
		"鸊",
		"䴙"
	],
	sài: [
		"僿",
		"簺",
		"賽",
		"赛"
	],
	"chán tǎn shàn": ["儃"],
	"dāng dàng": [
		"儅",
		"当",
		"闣"
	],
	xuān: [
		"儇",
		"喧",
		"塇",
		"媗",
		"宣",
		"愃",
		"愋",
		"揎",
		"昍",
		"暄",
		"煊",
		"煖",
		"瑄",
		"睻",
		"矎",
		"禤",
		"箮",
		"翧",
		"翾",
		"萱",
		"萲",
		"蓒",
		"蕿",
		"藼",
		"蘐",
		"蝖",
		"蠉",
		"諠",
		"諼",
		"譞",
		"谖",
		"軒",
		"轩",
		"鍹",
		"駽",
		"鰚",
		"𫓶",
		"𫍽"
	],
	"dān dàn": [
		"儋",
		"擔",
		"瘅"
	],
	càn: [
		"儏",
		"澯",
		"灿",
		"燦",
		"璨",
		"粲",
		"薒",
		"謲"
	],
	"bīn bìn": ["儐"],
	"án àn": ["儑"],
	tái: [
		"儓",
		"坮",
		"嬯",
		"抬",
		"擡",
		"檯",
		"炱",
		"炲",
		"籉",
		"臺",
		"薹",
		"跆",
		"邰",
		"颱",
		"鮐",
		"鲐"
	],
	lán: [
		"儖",
		"兰",
		"囒",
		"婪",
		"岚",
		"嵐",
		"幱",
		"拦",
		"攔",
		"斓",
		"斕",
		"栏",
		"欄",
		"欗",
		"澜",
		"瀾",
		"灆",
		"灡",
		"燣",
		"燷",
		"璼",
		"篮",
		"籃",
		"籣",
		"繿",
		"葻",
		"蓝",
		"藍",
		"蘫",
		"蘭",
		"褴",
		"襕",
		"襤",
		"襴",
		"襽",
		"譋",
		"讕",
		"谰",
		"躝",
		"鑭",
		"镧",
		"闌",
		"阑",
		"韊",
		"𬒗"
	],
	"nǐ yì ài yí": ["儗"],
	méng: [
		"儚",
		"幪",
		"曚",
		"朦",
		"橗",
		"檬",
		"氋",
		"溕",
		"濛",
		"甍",
		"甿",
		"盟",
		"礞",
		"艨",
		"莔",
		"萌",
		"蕄",
		"虻",
		"蝱",
		"鄳",
		"鄸",
		"霿",
		"靀",
		"顭",
		"饛",
		"鯍",
		"鸏",
		"鹲",
		"𫑡",
		"㠓"
	],
	níng: [
		"儜",
		"凝",
		"咛",
		"嚀",
		"嬣",
		"柠",
		"橣",
		"檸",
		"狞",
		"獰",
		"聍",
		"聹",
		"薴",
		"鑏",
		"鬡",
		"鸋"
	],
	qióng: [
		"儝",
		"卭",
		"宆",
		"惸",
		"憌",
		"桏",
		"橩",
		"焪",
		"焭",
		"煢",
		"熍",
		"琼",
		"瓊",
		"睘",
		"穷",
		"穹",
		"窮",
		"竆",
		"笻",
		"筇",
		"舼",
		"茕",
		"藑",
		"藭",
		"蛩",
		"蛬",
		"赹",
		"跫",
		"邛",
		"銎",
		"䓖"
	],
	liè: [
		"儠",
		"冽",
		"列",
		"劣",
		"劽",
		"埒",
		"埓",
		"姴",
		"峛",
		"巤",
		"挒",
		"捩",
		"栵",
		"洌",
		"浖",
		"烈",
		"烮",
		"煭",
		"犣",
		"猎",
		"猟",
		"獵",
		"聗",
		"脟",
		"茢",
		"蛚",
		"趔",
		"躐",
		"迾",
		"颲",
		"鬛",
		"鬣",
		"鮤",
		"鱲",
		"鴷",
		"䴕",
		"𫚭"
	],
	kuǎng: [
		"儣",
		"夼",
		"懭"
	],
	bào: [
		"儤",
		"勽",
		"報",
		"忁",
		"报",
		"抱",
		"曓",
		"爆",
		"犦",
		"菢",
		"虣",
		"蚫",
		"豹",
		"鉋",
		"鑤",
		"铇",
		"骲",
		"髱",
		"鮑",
		"鲍"
	],
	biāo: [
		"儦",
		"墂",
		"幖",
		"彪",
		"标",
		"標",
		"滮",
		"瀌",
		"熛",
		"爂",
		"猋",
		"瘭",
		"磦",
		"膘",
		"臕",
		"謤",
		"贆",
		"鏢",
		"鑣",
		"镖",
		"镳",
		"颮",
		"颷",
		"飆",
		"飇",
		"飈",
		"飊",
		"飑",
		"飙",
		"飚",
		"驫",
		"骉",
		"髟"
	],
	zǎn: [
		"儧",
		"儹",
		"噆",
		"攅",
		"昝",
		"趱",
		"趲"
	],
	háo: [
		"儫",
		"嗥",
		"嘷",
		"噑",
		"嚎",
		"壕",
		"椃",
		"毜",
		"毫",
		"濠",
		"獆",
		"獔",
		"竓",
		"籇",
		"蚝",
		"蠔",
		"譹",
		"豪"
	],
	qìng: [
		"儬",
		"凊",
		"庆",
		"慶",
		"櫦",
		"濪",
		"碃",
		"磬",
		"罄",
		"靘"
	],
	chèn: [
		"儭",
		"嚫",
		"榇",
		"櫬",
		"疢",
		"衬",
		"襯",
		"讖",
		"谶",
		"趁",
		"趂",
		"齓",
		"齔",
		"龀"
	],
	téng: [
		"儯",
		"幐",
		"滕",
		"漛",
		"疼",
		"籐",
		"籘",
		"縢",
		"腾",
		"藤",
		"虅",
		"螣",
		"誊",
		"謄",
		"邆",
		"駦",
		"騰",
		"驣",
		"鰧",
		"䲢"
	],
	"lǒng lóng lòng": ["儱"],
	"chán chàn": ["儳"],
	"ráng xiāng": ["儴", "勷"],
	"huì xié": ["儶"],
	luó: [
		"儸",
		"攞",
		"椤",
		"欏",
		"猡",
		"玀",
		"箩",
		"籮",
		"罗",
		"羅",
		"脶",
		"腡",
		"萝",
		"蘿",
		"螺",
		"覼",
		"逻",
		"邏",
		"鏍",
		"鑼",
		"锣",
		"镙",
		"饠",
		"騾",
		"驘",
		"骡",
		"鸁"
	],
	léi: [
		"儽",
		"嫘",
		"檑",
		"欙",
		"瓃",
		"畾",
		"縲",
		"纍",
		"纝",
		"缧",
		"罍",
		"羸",
		"蔂",
		"蘲",
		"虆",
		"轠",
		"鐳",
		"鑘",
		"镭",
		"雷",
		"靁",
		"鱩",
		"鼺"
	],
	"nàng nāng": ["儾"],
	"wù wū": ["兀"],
	yǔn: [
		"允",
		"喗",
		"夽",
		"抎",
		"殒",
		"殞",
		"狁",
		"磒",
		"荺",
		"賱",
		"鈗",
		"阭",
		"陨",
		"隕",
		"霣",
		"馻",
		"齫",
		"齳"
	],
	zān: [
		"兂",
		"橵",
		"簪",
		"簮",
		"糌",
		"鐕",
		"鐟",
		"鵤"
	],
	yuán: [
		"元",
		"円",
		"原",
		"厡",
		"厵",
		"园",
		"圆",
		"圎",
		"園",
		"圓",
		"垣",
		"塬",
		"媴",
		"嫄",
		"援",
		"榞",
		"榬",
		"橼",
		"櫞",
		"沅",
		"湲",
		"源",
		"溒",
		"爰",
		"猨",
		"猿",
		"笎",
		"緣",
		"縁",
		"缘",
		"羱",
		"茒",
		"薗",
		"蝝",
		"蝯",
		"螈",
		"袁",
		"褤",
		"謜",
		"轅",
		"辕",
		"邍",
		"邧",
		"酛",
		"鈨",
		"鎱",
		"騵",
		"魭",
		"鶢",
		"鶰",
		"黿",
		"鼋",
		"𫘪"
	],
	xiōng: [
		"兄",
		"兇",
		"凶",
		"匂",
		"匈",
		"哅",
		"忷",
		"恟",
		"汹",
		"洶",
		"胷",
		"胸",
		"芎",
		"訩",
		"詾",
		"讻"
	],
	chōng: [
		"充",
		"嘃",
		"忡",
		"憃",
		"憧",
		"摏",
		"沖",
		"浺",
		"珫",
		"罿",
		"翀",
		"舂",
		"艟",
		"茺",
		"衝",
		"蹖",
		"㳘"
	],
	zhào: [
		"兆",
		"垗",
		"旐",
		"曌",
		"枛",
		"櫂",
		"照",
		"燳",
		"狣",
		"瞾",
		"笊",
		"罀",
		"罩",
		"羄",
		"肁",
		"肇",
		"肈",
		"詔",
		"诏",
		"赵",
		"趙",
		"鮡",
		"𬶐"
	],
	"duì ruì yuè": [
		"兊",
		"兌",
		"兑"
	],
	kè: [
		"克",
		"刻",
		"勀",
		"勊",
		"堁",
		"娔",
		"客",
		"恪",
		"愙",
		"氪",
		"溘",
		"碦",
		"緙",
		"缂",
		"艐",
		"衉",
		"課",
		"课",
		"錁",
		"锞",
		"騍",
		"骒"
	],
	tù: [
		"兎",
		"兔",
		"堍",
		"迌",
		"鵵"
	],
	dǎng: [
		"党",
		"攩",
		"欓",
		"譡",
		"讜",
		"谠",
		"黨",
		"𣗋"
	],
	dōu: [
		"兜",
		"兠",
		"唗",
		"橷",
		"篼",
		"蔸"
	],
	huǎng: [
		"兤",
		"奛",
		"幌",
		"怳",
		"恍",
		"晄",
		"炾",
		"熀",
		"縨",
		"詤",
		"謊",
		"谎"
	],
	rù: [
		"入",
		"嗕",
		"媷",
		"扖",
		"杁",
		"洳",
		"溽",
		"縟",
		"缛",
		"蓐",
		"褥",
		"鳰"
	],
	nèi: [
		"內",
		"氝",
		"氞",
		"錗"
	],
	"yú shù": ["兪"],
	"liù lù": ["六"],
	han: ["兯", "爳"],
	tiān: [
		"兲",
		"天",
		"婖",
		"添",
		"酟",
		"靔",
		"靝",
		"黇"
	],
	"xīng xìng": ["兴"],
	diǎn: [
		"典",
		"嚸",
		"奌",
		"婰",
		"敟",
		"椣",
		"点",
		"碘",
		"蒧",
		"蕇",
		"踮",
		"點"
	],
	"zī cí": ["兹"],
	jiān: [
		"兼",
		"冿",
		"囏",
		"坚",
		"堅",
		"奸",
		"姦",
		"姧",
		"尖",
		"幵",
		"惤",
		"戋",
		"戔",
		"搛",
		"椾",
		"樫",
		"櫼",
		"歼",
		"殱",
		"殲",
		"湔",
		"瀐",
		"瀸",
		"煎",
		"熞",
		"熸",
		"牋",
		"瑊",
		"睷",
		"礛",
		"礷",
		"笺",
		"箋",
		"緘",
		"縑",
		"缄",
		"缣",
		"肩",
		"艰",
		"艱",
		"菅",
		"菺",
		"葌",
		"蒹",
		"蔪",
		"蕑",
		"蕳",
		"虃",
		"譼",
		"豜",
		"鑯",
		"雃",
		"鞯",
		"韀",
		"韉",
		"餰",
		"馢",
		"鰔",
		"鰜",
		"鰹",
		"鲣",
		"鳒",
		"鵑",
		"鵳",
		"鶼",
		"鹣",
		"麉"
	],
	shòu: [
		"兽",
		"受",
		"售",
		"壽",
		"夀",
		"寿",
		"授",
		"狩",
		"獣",
		"獸",
		"痩",
		"瘦",
		"綬",
		"绶",
		"膄"
	],
	jì: [
		"兾",
		"冀",
		"剂",
		"剤",
		"劑",
		"勣",
		"坖",
		"垍",
		"塈",
		"妓",
		"季",
		"寂",
		"寄",
		"廭",
		"彑",
		"徛",
		"忌",
		"悸",
		"惎",
		"懻",
		"技",
		"旡",
		"既",
		"旣",
		"暨",
		"暩",
		"曁",
		"梞",
		"檕",
		"檵",
		"洎",
		"漃",
		"漈",
		"瀱",
		"痵",
		"癠",
		"禝",
		"稩",
		"稷",
		"穄",
		"穊",
		"穧",
		"紀",
		"継",
		"績",
		"繋",
		"繼",
		"继",
		"绩",
		"罽",
		"臮",
		"芰",
		"茍",
		"茤",
		"葪",
		"蓟",
		"蔇",
		"薊",
		"蘎",
		"蘮",
		"蘻",
		"裚",
		"襀",
		"覬",
		"觊",
		"計",
		"記",
		"誋",
		"计",
		"记",
		"跡",
		"跽",
		"蹟",
		"迹",
		"际",
		"際",
		"霁",
		"霽",
		"驥",
		"骥",
		"髻",
		"鬾",
		"魝",
		"魥",
		"鯚",
		"鯽",
		"鰶",
		"鰿",
		"鱀",
		"鱭",
		"鲚",
		"鲫",
		"鵋",
		"鷑",
		"齌",
		"𪟝",
		"𬶨",
		"𬶭"
	],
	jiōng: [
		"冂",
		"冋",
		"坰",
		"埛",
		"扃",
		"蘏",
		"蘔",
		"駉",
		"駫",
		"𬳶"
	],
	mào: [
		"冃",
		"冐",
		"媢",
		"帽",
		"愗",
		"懋",
		"暓",
		"柕",
		"楙",
		"毷",
		"瑁",
		"皃",
		"眊",
		"瞀",
		"耄",
		"茂",
		"萺",
		"蝐",
		"袤",
		"覒",
		"貌",
		"貿",
		"贸",
		"鄚",
		"鄮"
	],
	rǎn: [
		"冄",
		"冉",
		"姌",
		"媣",
		"染",
		"珃",
		"苒",
		"蒅",
		"䎃"
	],
	"nèi nà": ["内"],
	gāng: [
		"冈",
		"冮",
		"刚",
		"剛",
		"堈",
		"堽",
		"岡",
		"掆",
		"摃",
		"棡",
		"牨",
		"犅",
		"疘",
		"綱",
		"纲",
		"缸",
		"罁",
		"罡",
		"肛",
		"釭",
		"鎠",
		"㭎"
	],
	cè: [
		"冊",
		"册",
		"厕",
		"厠",
		"夨",
		"廁",
		"恻",
		"惻",
		"憡",
		"敇",
		"测",
		"測",
		"笧",
		"策",
		"筞",
		"筴",
		"箣",
		"荝",
		"萗",
		"萴",
		"蓛"
	],
	guǎ: [
		"冎",
		"剐",
		"剮",
		"叧",
		"寡"
	],
	"mào mò": ["冒"],
	gòu: [
		"冓",
		"啂",
		"坸",
		"垢",
		"够",
		"夠",
		"媾",
		"彀",
		"搆",
		"撀",
		"构",
		"構",
		"煹",
		"覯",
		"觏",
		"訽",
		"詬",
		"诟",
		"購",
		"购",
		"遘",
		"雊"
	],
	xǔ: [
		"冔",
		"喣",
		"暊",
		"栩",
		"珝",
		"盨",
		"糈",
		"詡",
		"諿",
		"诩",
		"鄦",
		"醑"
	],
	mì: [
		"冖",
		"冪",
		"嘧",
		"塓",
		"宻",
		"密",
		"峚",
		"幂",
		"幎",
		"幦",
		"怽",
		"榓",
		"樒",
		"櫁",
		"汨",
		"淧",
		"滵",
		"漞",
		"濗",
		"熐",
		"羃",
		"蔤",
		"蜜",
		"覓",
		"覔",
		"覛",
		"觅",
		"謐",
		"谧",
		"鼏"
	],
	"yóu yín": ["冘"],
	xiě: [
		"写",
		"冩",
		"藛"
	],
	jūn: [
		"军",
		"君",
		"均",
		"桾",
		"汮",
		"皲",
		"皸",
		"皹",
		"碅",
		"莙",
		"蚐",
		"袀",
		"覠",
		"軍",
		"鈞",
		"銁",
		"銞",
		"鍕",
		"钧",
		"頵",
		"鮶",
		"鲪",
		"麏"
	],
	mí: [
		"冞",
		"擟",
		"瀰",
		"爢",
		"猕",
		"獼",
		"祢",
		"禰",
		"縻",
		"蒾",
		"藌",
		"蘪",
		"蘼",
		"袮",
		"詸",
		"謎",
		"迷",
		"醚",
		"醾",
		"醿",
		"釄",
		"镾",
		"鸍",
		"麊",
		"麋",
		"麛"
	],
	"guān guàn": [
		"冠",
		"覌",
		"観",
		"觀",
		"观"
	],
	měng: [
		"冡",
		"勐",
		"懵",
		"掹",
		"猛",
		"獴",
		"艋",
		"蜢",
		"蠓",
		"錳",
		"锰",
		"鯭",
		"鼆"
	],
	zhǒng: [
		"冢",
		"塚",
		"尰",
		"歱",
		"煄",
		"瘇",
		"肿",
		"腫",
		"踵"
	],
	zuì: [
		"冣",
		"嶵",
		"晬",
		"最",
		"栬",
		"槜",
		"檇",
		"檌",
		"祽",
		"絊",
		"罪",
		"蕞",
		"辠",
		"酔",
		"酻",
		"醉",
		"錊"
	],
	yuān: [
		"冤",
		"剈",
		"囦",
		"嬽",
		"寃",
		"棩",
		"淵",
		"渁",
		"渆",
		"渊",
		"渕",
		"灁",
		"眢",
		"肙",
		"葾",
		"蒬",
		"蜎",
		"蜵",
		"駌",
		"鳶",
		"鴛",
		"鵷",
		"鸢",
		"鸳",
		"鹓",
		"鼘",
		"鼝"
	],
	míng: [
		"冥",
		"名",
		"明",
		"暝",
		"朙",
		"榠",
		"洺",
		"溟",
		"猽",
		"眀",
		"眳",
		"瞑",
		"茗",
		"螟",
		"覭",
		"詺",
		"鄍",
		"銘",
		"铭",
		"鳴",
		"鸣"
	],
	kòu: [
		"冦",
		"叩",
		"宼",
		"寇",
		"扣",
		"敂",
		"滱",
		"窛",
		"筘",
		"簆",
		"蔲",
		"蔻",
		"釦",
		"鷇"
	],
	tài: [
		"冭",
		"太",
		"夳",
		"忲",
		"态",
		"態",
		"汰",
		"汱",
		"泰",
		"溙",
		"肽",
		"舦",
		"酞",
		"鈦",
		"钛"
	],
	"féng píng": ["冯", "馮"],
	"chōng chòng": ["冲"],
	kuàng: [
		"况",
		"圹",
		"壙",
		"岲",
		"懬",
		"旷",
		"昿",
		"曠",
		"框",
		"況",
		"爌",
		"眖",
		"眶",
		"矿",
		"砿",
		"礦",
		"穬",
		"絋",
		"絖",
		"纊",
		"纩",
		"貺",
		"贶",
		"軦",
		"邝",
		"鄺",
		"鉱",
		"鋛",
		"鑛",
		"黋"
	],
	lěng: ["冷"],
	pàn: [
		"冸",
		"判",
		"叛",
		"沜",
		"泮",
		"溿",
		"炍",
		"牉",
		"畔",
		"盼",
		"聁",
		"袢",
		"襻",
		"詊",
		"鋬",
		"鑻",
		"頖",
		"鵥"
	],
	fā: [
		"冹",
		"彂",
		"沷",
		"発",
		"發"
	],
	xiǎn: [
		"冼",
		"尟",
		"尠",
		"崄",
		"嶮",
		"幰",
		"攇",
		"显",
		"櫶",
		"毨",
		"灦",
		"烍",
		"燹",
		"狝",
		"猃",
		"獫",
		"獮",
		"玁",
		"禒",
		"筅",
		"箲",
		"藓",
		"蘚",
		"蚬",
		"蜆",
		"譣",
		"赻",
		"跣",
		"鍌",
		"险",
		"険",
		"險",
		"韅",
		"顕",
		"顯",
		"㬎"
	],
	qià: [
		"冾",
		"圶",
		"帢",
		"恰",
		"殎",
		"洽",
		"硈",
		"胢",
		"髂"
	],
	"jìng chēng": [
		"净",
		"凈",
		"淨"
	],
	sōu: [
		"凁",
		"嗖",
		"廀",
		"廋",
		"捜",
		"搜",
		"摉",
		"溲",
		"獀",
		"艘",
		"蒐",
		"螋",
		"鄋",
		"醙",
		"鎪",
		"锼",
		"颼",
		"飕",
		"餿",
		"馊",
		"騪"
	],
	měi: [
		"凂",
		"媄",
		"媺",
		"嬍",
		"嵄",
		"挴",
		"毎",
		"每",
		"浼",
		"渼",
		"燘",
		"美",
		"躾",
		"鎂",
		"镁",
		"黣"
	],
	tú: [
		"凃",
		"図",
		"图",
		"圖",
		"圗",
		"塗",
		"屠",
		"峹",
		"嵞",
		"庩",
		"廜",
		"徒",
		"悇",
		"揬",
		"涂",
		"瘏",
		"筡",
		"腯",
		"荼",
		"蒤",
		"跿",
		"途",
		"酴",
		"鈯",
		"鍎",
		"馟",
		"駼",
		"鵌",
		"鶟",
		"鷋",
		"鷵",
		"𬳿"
	],
	zhǔn: [
		"准",
		"凖",
		"埻",
		"準",
		"𬘯"
	],
	"liáng liàng": [
		"凉",
		"涼",
		"量"
	],
	diāo: [
		"凋",
		"刁",
		"刟",
		"叼",
		"奝",
		"弴",
		"彫",
		"汈",
		"琱",
		"碉",
		"簓",
		"虭",
		"蛁",
		"貂",
		"錭",
		"雕",
		"鮉",
		"鯛",
		"鲷",
		"鵰",
		"鼦"
	],
	còu: [
		"凑",
		"湊",
		"腠",
		"輳",
		"辏"
	],
	ái: [
		"凒",
		"啀",
		"嘊",
		"捱",
		"溰",
		"癌",
		"皑",
		"皚"
	],
	duó: [
		"凙",
		"剫",
		"夺",
		"奪",
		"痥",
		"踱",
		"鈬",
		"鐸",
		"铎"
	],
	dú: [
		"凟",
		"匵",
		"嬻",
		"椟",
		"櫝",
		"殰",
		"涜",
		"牍",
		"牘",
		"犊",
		"犢",
		"独",
		"獨",
		"瓄",
		"皾",
		"裻",
		"読",
		"讀",
		"讟",
		"豄",
		"贕",
		"錖",
		"鑟",
		"韇",
		"韣",
		"韥",
		"騳",
		"髑",
		"黩",
		"黷"
	],
	"jǐ jī": ["几"],
	fán: [
		"凡",
		"凢",
		"凣",
		"匥",
		"墦",
		"杋",
		"柉",
		"棥",
		"樊",
		"瀿",
		"烦",
		"煩",
		"燔",
		"璠",
		"矾",
		"礬",
		"笲",
		"籵",
		"緐",
		"羳",
		"舤",
		"舧",
		"薠",
		"蘩",
		"蠜",
		"襎",
		"蹯",
		"釩",
		"鐇",
		"鐢",
		"钒",
		"鷭",
		"𫔍",
		"𬸪"
	],
	jū: [
		"凥",
		"匊",
		"娵",
		"婮",
		"居",
		"崌",
		"抅",
		"挶",
		"掬",
		"梮",
		"椐",
		"檋",
		"毩",
		"毱",
		"泃",
		"涺",
		"狙",
		"琚",
		"疽",
		"砠",
		"罝",
		"腒",
		"艍",
		"蜛",
		"裾",
		"諊",
		"跔",
		"踘",
		"躹",
		"陱",
		"雎",
		"鞠",
		"鞫",
		"駒",
		"驹",
		"鮈",
		"鴡",
		"鶋",
		"𬶋"
	],
	"chù chǔ": ["処", "处"],
	zhǐ: [
		"凪",
		"劧",
		"咫",
		"址",
		"坧",
		"帋",
		"恉",
		"扺",
		"指",
		"旨",
		"枳",
		"止",
		"汦",
		"沚",
		"洔",
		"淽",
		"疻",
		"砋",
		"祉",
		"秖",
		"紙",
		"纸",
		"芷",
		"藢",
		"衹",
		"襧",
		"訨",
		"趾",
		"軹",
		"轵",
		"酯",
		"阯",
		"黹"
	],
	píng: [
		"凭",
		"凴",
		"呯",
		"坪",
		"塀",
		"岼",
		"帡",
		"帲",
		"幈",
		"平",
		"慿",
		"憑",
		"枰",
		"洴",
		"焩",
		"玶",
		"瓶",
		"甁",
		"竮",
		"箳",
		"簈",
		"缾",
		"荓",
		"萍",
		"蓱",
		"蚲",
		"蛢",
		"評",
		"评",
		"軿",
		"輧",
		"郱",
		"鮃",
		"鲆"
	],
	kǎi: [
		"凯",
		"凱",
		"剀",
		"剴",
		"垲",
		"塏",
		"恺",
		"愷",
		"慨",
		"暟",
		"蒈",
		"輆",
		"鍇",
		"鎧",
		"铠",
		"锴",
		"闓",
		"闿",
		"颽"
	],
	gān: [
		"凲",
		"坩",
		"尲",
		"尴",
		"尶",
		"尷",
		"柑",
		"泔",
		"漧",
		"玕",
		"甘",
		"疳",
		"矸",
		"竿",
		"筸",
		"粓",
		"肝",
		"苷",
		"迀",
		"酐",
		"魐"
	],
	"kǎn qiǎn": ["凵"],
	tū: [
		"凸",
		"堗",
		"嶀",
		"捸",
		"涋",
		"湥",
		"痜",
		"禿",
		"秃",
		"突",
		"葖",
		"鋵",
		"鵚",
		"鼵",
		"㻬"
	],
	"āo wā": ["凹"],
	chū: [
		"出",
		"初",
		"岀",
		"摴",
		"榋",
		"樗",
		"貙",
		"齣",
		"䢺",
		"䝙"
	],
	dàng: [
		"凼",
		"圵",
		"垱",
		"壋",
		"档",
		"檔",
		"氹",
		"璗",
		"瓽",
		"盪",
		"瞊",
		"砀",
		"碭",
		"礑",
		"簜",
		"荡",
		"菪",
		"蕩",
		"蘯",
		"趤",
		"逿",
		"雼",
		"𬍡"
	],
	hán: [
		"函",
		"凾",
		"含",
		"圅",
		"娢",
		"寒",
		"崡",
		"晗",
		"梒",
		"浛",
		"涵",
		"澏",
		"焓",
		"琀",
		"甝",
		"筨",
		"蜬",
		"邗",
		"邯",
		"鋡",
		"韓",
		"韩"
	],
	záo: ["凿", "鑿"],
	dāo: [
		"刀",
		"刂",
		"忉",
		"氘",
		"舠",
		"螩",
		"釖",
		"魛",
		"鱽"
	],
	chuāng: [
		"刅",
		"摐",
		"牎",
		"牕",
		"疮",
		"瘡",
		"窓",
		"窗",
		"窻"
	],
	"fēn fèn": ["分"],
	"qiè qiē": ["切"],
	kān: [
		"刊",
		"勘",
		"堪",
		"戡",
		"栞",
		"龕",
		"龛"
	],
	cǔn: ["刌", "忖"],
	chú: [
		"刍",
		"厨",
		"幮",
		"廚",
		"橱",
		"櫉",
		"櫥",
		"滁",
		"犓",
		"篨",
		"耡",
		"芻",
		"蒢",
		"蒭",
		"蜍",
		"蟵",
		"豠",
		"趎",
		"蹰",
		"躇",
		"躕",
		"鉏",
		"鋤",
		"锄",
		"除",
		"雏",
		"雛",
		"鶵"
	],
	"huà huá": ["划"],
	lí: [
		"刕",
		"剓",
		"剺",
		"劙",
		"厘",
		"喱",
		"嚟",
		"囄",
		"嫠",
		"孷",
		"廲",
		"悡",
		"梨",
		"梸",
		"棃",
		"漓",
		"灕",
		"犁",
		"犂",
		"狸",
		"琍",
		"璃",
		"瓈",
		"盠",
		"睝",
		"离",
		"穲",
		"竰",
		"筣",
		"篱",
		"籬",
		"糎",
		"縭",
		"缡",
		"罹",
		"艃",
		"荲",
		"菞",
		"蓠",
		"蔾",
		"藜",
		"蘺",
		"蜊",
		"蟍",
		"蟸",
		"蠫",
		"褵",
		"謧",
		"貍",
		"醨",
		"鋫",
		"錅",
		"鏫",
		"鑗",
		"離",
		"驪",
		"骊",
		"鯏",
		"鯬",
		"鱺",
		"鲡",
		"鵹",
		"鸝",
		"鹂",
		"黎",
		"黧",
		"㰀"
	],
	yuè: [
		"刖",
		"嬳",
		"岄",
		"岳",
		"嶽",
		"恱",
		"悅",
		"悦",
		"戉",
		"抈",
		"捳",
		"月",
		"樾",
		"瀹",
		"爚",
		"玥",
		"礿",
		"禴",
		"篗",
		"籆",
		"籥",
		"籰",
		"粤",
		"粵",
		"蘥",
		"蚎",
		"蚏",
		"説",
		"越",
		"跀",
		"跃",
		"躍",
		"軏",
		"鈅",
		"鉞",
		"鑰",
		"钺",
		"閱",
		"閲",
		"阅",
		"鸑",
		"鸙",
		"黦",
		"龠",
		"𫐄",
		"𬸚"
	],
	liú: [
		"刘",
		"劉",
		"嚠",
		"媹",
		"嵧",
		"旈",
		"旒",
		"榴",
		"橊",
		"流",
		"浏",
		"瀏",
		"琉",
		"瑠",
		"瑬",
		"璢",
		"畄",
		"留",
		"畱",
		"疁",
		"瘤",
		"癅",
		"硫",
		"蒥",
		"蓅",
		"蟉",
		"裗",
		"鎏",
		"鏐",
		"鐂",
		"镠",
		"飀",
		"飅",
		"飗",
		"駠",
		"駵",
		"騮",
		"驑",
		"骝",
		"鰡",
		"鶹",
		"鹠",
		"麍"
	],
	zé: [
		"则",
		"則",
		"啧",
		"嘖",
		"嫧",
		"帻",
		"幘",
		"択",
		"樍",
		"歵",
		"沢",
		"泎",
		"溭",
		"皟",
		"瞔",
		"矠",
		"礋",
		"箦",
		"簀",
		"舴",
		"蔶",
		"蠌",
		"襗",
		"謮",
		"賾",
		"赜",
		"迮",
		"鸅",
		"齚",
		"齰"
	],
	"chuàng chuāng": ["创", "創"],
	qù: [
		"刞",
		"厺",
		"去",
		"閴",
		"闃",
		"阒",
		"麮",
		"鼁"
	],
	"bié biè": ["別", "别"],
	"páo bào": ["刨"],
	"chǎn chàn": [
		"刬",
		"剗",
		"幝"
	],
	guā: [
		"刮",
		"劀",
		"桰",
		"歄",
		"煱",
		"瓜",
		"胍",
		"踻",
		"颪",
		"颳",
		"騧",
		"鴰",
		"鸹"
	],
	gēng: [
		"刯",
		"庚",
		"椩",
		"浭",
		"焿",
		"畊",
		"絚",
		"羮",
		"羹",
		"耕",
		"菮",
		"賡",
		"赓",
		"鶊",
		"鹒"
	],
	dào: [
		"到",
		"噵",
		"悼",
		"椡",
		"檤",
		"燾",
		"瓙",
		"盗",
		"盜",
		"稲",
		"稻",
		"纛",
		"翿",
		"艔",
		"菿",
		"衜",
		"衟",
		"軇",
		"道"
	],
	chuàng: [
		"刱",
		"剏",
		"剙",
		"怆",
		"愴"
	],
	kū: [
		"刳",
		"哭",
		"圐",
		"堀",
		"枯",
		"桍",
		"矻",
		"窟",
		"跍",
		"郀",
		"骷",
		"鮬"
	],
	duò: [
		"刴",
		"剁",
		"墯",
		"尮",
		"惰",
		"憜",
		"挅",
		"桗",
		"舵",
		"跥",
		"跺",
		"陊",
		"陏",
		"飿",
		"饳",
		"鵽"
	],
	"shuā shuà": ["刷"],
	"quàn xuàn": ["券"],
	"chà shā": ["刹", "剎"],
	"cì cī": ["刺"],
	guì: [
		"刽",
		"刿",
		"劊",
		"劌",
		"撌",
		"攰",
		"昋",
		"桂",
		"椢",
		"槶",
		"樻",
		"櫃",
		"猤",
		"禬",
		"筀",
		"蓕",
		"襘",
		"貴",
		"贵",
		"跪",
		"鐀",
		"鑎",
		"鞼",
		"鱖",
		"鱥"
	],
	lóu: [
		"剅",
		"娄",
		"婁",
		"廔",
		"楼",
		"樓",
		"溇",
		"漊",
		"熡",
		"耧",
		"耬",
		"艛",
		"蒌",
		"蔞",
		"蝼",
		"螻",
		"謱",
		"軁",
		"遱",
		"鞻",
		"髅",
		"髏",
		"𪣻"
	],
	cuò: [
		"剉",
		"剒",
		"厝",
		"夎",
		"挫",
		"措",
		"棤",
		"莝",
		"莡",
		"蓌",
		"逪",
		"銼",
		"錯",
		"锉",
		"错"
	],
	"xiāo xuē": ["削"],
	"kēi kè": ["剋", "尅"],
	"là lá": ["剌"],
	tī: [
		"剔",
		"梯",
		"踢",
		"銻",
		"锑",
		"鷈",
		"鷉",
		"䏲",
		"䴘"
	],
	pōu: ["剖"],
	wān: [
		"剜",
		"塆",
		"壪",
		"帵",
		"弯",
		"彎",
		"湾",
		"潫",
		"灣",
		"睕",
		"蜿",
		"豌"
	],
	"bāo bō": ["剝", "剥"],
	duō: [
		"剟",
		"咄",
		"哆",
		"嚉",
		"多",
		"夛",
		"掇",
		"毲",
		"畓",
		"裰",
		"㙍"
	],
	qíng: [
		"剠",
		"勍",
		"夝",
		"情",
		"擎",
		"晴",
		"暒",
		"棾",
		"樈",
		"檠",
		"氰",
		"甠",
		"硘",
		"葝",
		"黥"
	],
	"yǎn shàn": ["剡"],
	"dū zhuó": ["剢"],
	yān: [
		"剦",
		"嫣",
		"崦",
		"嶖",
		"恹",
		"懕",
		"懨",
		"樮",
		"淊",
		"淹",
		"漹",
		"烟",
		"焉",
		"焑",
		"煙",
		"珚",
		"篶",
		"胭",
		"臙",
		"菸",
		"鄢",
		"醃",
		"閹",
		"阉",
		"黫"
	],
	huō: [
		"剨",
		"劐",
		"吙",
		"攉",
		"秴",
		"耠",
		"锪",
		"騞",
		"𬴃"
	],
	shèng: [
		"剩",
		"剰",
		"勝",
		"圣",
		"墭",
		"嵊",
		"晠",
		"榺",
		"橳",
		"琞",
		"聖",
		"蕂",
		"貹",
		"賸"
	],
	"duān zhì": ["剬"],
	wū: [
		"剭",
		"呜",
		"嗚",
		"圬",
		"屋",
		"巫",
		"弙",
		"杇",
		"歍",
		"汙",
		"汚",
		"污",
		"洿",
		"烏",
		"窏",
		"箼",
		"螐",
		"誈",
		"誣",
		"诬",
		"邬",
		"鄔",
		"鎢",
		"钨",
		"鰞",
		"鴮"
	],
	gē: [
		"割",
		"哥",
		"圪",
		"彁",
		"戈",
		"戓",
		"戨",
		"歌",
		"滒",
		"犵",
		"肐",
		"袼",
		"謌",
		"鎶",
		"鴚",
		"鴿",
		"鸽"
	],
	"dá zhá": ["剳"],
	chuán: [
		"剶",
		"暷",
		"椽",
		"篅",
		"舡",
		"舩",
		"船",
		"輲",
		"遄"
	],
	"tuán zhuān": [
		"剸",
		"漙",
		"篿"
	],
	"lù jiū": ["剹"],
	pēng: [
		"剻",
		"匉",
		"嘭",
		"怦",
		"恲",
		"抨",
		"梈",
		"烹",
		"砰",
		"軯",
		"駍"
	],
	piāo: [
		"剽",
		"勡",
		"慓",
		"旚",
		"犥",
		"翲",
		"螵",
		"飃",
		"飄",
		"飘",
		"魒"
	],
	kōu: [
		"剾",
		"彄",
		"抠",
		"摳",
		"眍",
		"瞘",
		"芤",
		"𫸩"
	],
	"jiǎo chāo": [
		"剿",
		"劋",
		"勦",
		"摷"
	],
	qiāo: [
		"劁",
		"勪",
		"墝",
		"幧",
		"敲",
		"橇",
		"毃",
		"燆",
		"硗",
		"磽",
		"繑",
		"趬",
		"跷",
		"踍",
		"蹺",
		"蹻",
		"郻",
		"鄡",
		"鄥",
		"鍫",
		"鍬",
		"鐰",
		"锹",
		"頝"
	],
	"huá huà": ["劃"],
	"zhā zhá": ["劄"],
	"pī pǐ": ["劈", "悂"],
	tāng: [
		"劏",
		"嘡",
		"羰",
		"薚",
		"蝪",
		"蹚",
		"鞺",
		"鼞"
	],
	chán: [
		"劖",
		"嚵",
		"壥",
		"婵",
		"嬋",
		"巉",
		"廛",
		"棎",
		"毚",
		"湹",
		"潹",
		"潺",
		"澶",
		"瀍",
		"瀺",
		"煘",
		"獑",
		"磛",
		"緾",
		"纏",
		"纒",
		"缠",
		"艬",
		"蝉",
		"蟐",
		"蟬",
		"蟾",
		"誗",
		"讒",
		"谗",
		"躔",
		"鄽",
		"酁",
		"鋋",
		"鑱",
		"镵",
		"饞",
		"馋"
	],
	zuān: [
		"劗",
		"躜",
		"躦",
		"鉆",
		"鑚"
	],
	mó: [
		"劘",
		"嫫",
		"嬤",
		"嬷",
		"尛",
		"摹",
		"擵",
		"橅",
		"糢",
		"膜",
		"藦",
		"蘑",
		"謨",
		"謩",
		"谟",
		"饃",
		"饝",
		"馍",
		"髍",
		"魔",
		"魹"
	],
	zhú: [
		"劚",
		"斸",
		"曯",
		"欘",
		"灟",
		"炢",
		"烛",
		"燭",
		"爥",
		"瘃",
		"竹",
		"笁",
		"笜",
		"舳",
		"茿",
		"蓫",
		"蠋",
		"蠾",
		"躅",
		"逐",
		"逫",
		"钃",
		"鱁"
	],
	quàn: [
		"劝",
		"勧",
		"勸",
		"牶",
		"韏"
	],
	"jìn jìng": [
		"劤",
		"劲",
		"勁"
	],
	kēng: [
		"劥",
		"坑",
		"牼",
		"硁",
		"硜",
		"誙",
		"銵",
		"鍞",
		"鏗",
		"铿",
		"阬"
	],
	"xié liè": ["劦"],
	"zhù chú": ["助"],
	nǔ: [
		"努",
		"弩",
		"砮",
		"胬"
	],
	shào: [
		"劭",
		"卲",
		"哨",
		"潲",
		"紹",
		"綤",
		"绍",
		"袑",
		"邵"
	],
	miǎo: [
		"劰",
		"杪",
		"淼",
		"渺",
		"眇",
		"秒",
		"篎",
		"緲",
		"缈",
		"藐",
		"邈"
	],
	kǒu: ["劶", "口"],
	wā: [
		"劸",
		"娲",
		"媧",
		"屲",
		"挖",
		"攨",
		"洼",
		"溛",
		"漥",
		"瓾",
		"畖",
		"穵",
		"窊",
		"窪",
		"蛙",
		"韈",
		"鼃"
	],
	kuāng: [
		"劻",
		"匡",
		"匩",
		"哐",
		"恇",
		"洭",
		"筐",
		"筺",
		"誆",
		"诓",
		"軭",
		"邼"
	],
	hé: [
		"劾",
		"咊",
		"啝",
		"姀",
		"峆",
		"敆",
		"曷",
		"柇",
		"楁",
		"毼",
		"河",
		"涸",
		"渮",
		"澕",
		"熆",
		"皬",
		"盇",
		"盉",
		"盍",
		"盒",
		"禾",
		"篕",
		"籺",
		"粭",
		"翮",
		"菏",
		"萂",
		"覈",
		"訸",
		"詥",
		"郃",
		"釛",
		"鉌",
		"鑉",
		"閡",
		"闔",
		"阂",
		"阖",
		"鞨",
		"頜",
		"餄",
		"饸",
		"魺",
		"鹖",
		"麧",
		"齕",
		"龁",
		"龢",
		"𬌗"
	],
	gào: [
		"勂",
		"吿",
		"告",
		"峼",
		"祮",
		"祰",
		"禞",
		"筶",
		"誥",
		"诰",
		"郜",
		"鋯",
		"锆"
	],
	"bó bèi": ["勃"],
	láng: [
		"勆",
		"嫏",
		"廊",
		"斏",
		"桹",
		"榔",
		"樃",
		"欴",
		"狼",
		"琅",
		"瑯",
		"硠",
		"稂",
		"艆",
		"蓈",
		"蜋",
		"螂",
		"躴",
		"郒",
		"郞",
		"鋃",
		"鎯",
		"锒"
	],
	xūn: [
		"勋",
		"勛",
		"勲",
		"勳",
		"嚑",
		"坃",
		"埙",
		"塤",
		"壎",
		"壦",
		"曛",
		"燻",
		"獯",
		"矄",
		"纁",
		"臐",
		"薫",
		"薰",
		"蘍",
		"醺",
		"𫄸"
	],
	"juàn juān": ["勌", "瓹"],
	"lè lēi": ["勒"],
	kài: [
		"勓",
		"炌",
		"烗",
		"鎎"
	],
	"wěng yǎng": ["勜"],
	qín: [
		"勤",
		"嗪",
		"噙",
		"嶜",
		"庈",
		"懃",
		"懄",
		"捦",
		"擒",
		"斳",
		"檎",
		"澿",
		"珡",
		"琴",
		"琹",
		"瘽",
		"禽",
		"秦",
		"耹",
		"芩",
		"芹",
		"菦",
		"螓",
		"蠄",
		"鈙",
		"鈫",
		"雂",
		"靲",
		"鳹",
		"鵭"
	],
	jiàng: [
		"勥",
		"匞",
		"匠",
		"嵹",
		"弜",
		"弶",
		"摾",
		"櫤",
		"洚",
		"滰",
		"犟",
		"糡",
		"糨",
		"絳",
		"绛",
		"謽",
		"酱",
		"醤",
		"醬"
	],
	fān: [
		"勫",
		"嬏",
		"帆",
		"幡",
		"忛",
		"憣",
		"旙",
		"旛",
		"繙",
		"翻",
		"藩",
		"轓",
		"颿",
		"飜",
		"鱕"
	],
	juān: [
		"勬",
		"姢",
		"娟",
		"捐",
		"涓",
		"蠲",
		"裐",
		"鎸",
		"鐫",
		"镌",
		"鹃"
	],
	"tóng dòng": [
		"勭",
		"烔",
		"燑",
		"狪"
	],
	lǜ: [
		"勴",
		"垏",
		"嵂",
		"律",
		"慮",
		"氯",
		"滤",
		"濾",
		"爈",
		"箻",
		"綠",
		"繂",
		"膟",
		"葎",
		"虑",
		"鑢"
	],
	chè: [
		"勶",
		"坼",
		"彻",
		"徹",
		"掣",
		"撤",
		"澈",
		"烢",
		"爡",
		"瞮",
		"硩",
		"聅",
		"迠",
		"頙",
		"㬚"
	],
	sháo: [
		"勺",
		"玿",
		"韶"
	],
	"gōu gòu": ["勾"],
	cōng: [
		"匆",
		"囪",
		"囱",
		"忩",
		"怱",
		"悤",
		"暰",
		"樬",
		"漗",
		"瑽",
		"璁",
		"瞛",
		"篵",
		"繱",
		"聡",
		"聦",
		"聪",
		"聰",
		"苁",
		"茐",
		"葱",
		"蓯",
		"蔥",
		"蟌",
		"鍯",
		"鏓",
		"鏦",
		"騘",
		"驄",
		"骢"
	],
	"táo yáo": ["匋", "陶"],
	páo: [
		"匏",
		"咆",
		"垉",
		"庖",
		"爮",
		"狍",
		"袍",
		"褜",
		"軳",
		"鞄",
		"麅"
	],
	dá: [
		"匒",
		"妲",
		"怛",
		"炟",
		"燵",
		"畣",
		"笪",
		"羍",
		"荙",
		"薘",
		"蟽",
		"詚",
		"达",
		"迏",
		"迖",
		"迚",
		"逹",
		"達",
		"鐽",
		"靼",
		"鞑",
		"韃",
		"龖",
		"龘",
		"𫟼"
	],
	"huà huā": ["化"],
	"běi bèi": ["北"],
	nǎo: [
		"匘",
		"垴",
		"堖",
		"嫐",
		"恼",
		"悩",
		"惱",
		"瑙",
		"碯",
		"脑",
		"脳",
		"腦"
	],
	"chí shi": ["匙"],
	fāng: [
		"匚",
		"堏",
		"方",
		"淓",
		"牥",
		"芳",
		"邡",
		"鈁",
		"錺",
		"钫",
		"鴋"
	],
	zā: [
		"匝",
		"咂",
		"帀",
		"沞",
		"臜",
		"臢",
		"迊",
		"鉔",
		"魳"
	],
	qiè: [
		"匧",
		"厒",
		"妾",
		"怯",
		"悏",
		"惬",
		"愜",
		"挈",
		"穕",
		"窃",
		"竊",
		"笡",
		"箧",
		"篋",
		"籡",
		"踥",
		"鍥",
		"锲",
		"鯜"
	],
	"zāng cáng": ["匨"],
	fěi: [
		"匪",
		"奜",
		"悱",
		"棐",
		"榧",
		"篚",
		"翡",
		"蕜",
		"誹",
		"诽"
	],
	"kuì guì": ["匮", "匱"],
	suǎn: ["匴"],
	pǐ: [
		"匹",
		"噽",
		"嚭",
		"圮",
		"庀",
		"痞",
		"癖",
		"脴",
		"苉",
		"銢",
		"鴄"
	],
	"qū ōu": ["区", "區"],
	"kē qià": ["匼"],
	"yǎn yàn": ["匽", "棪"],
	biǎn: [
		"匾",
		"惼",
		"揙",
		"碥",
		"稨",
		"窆",
		"藊",
		"褊",
		"貶",
		"贬",
		"鴘"
	],
	nì: [
		"匿",
		"堄",
		"嫟",
		"嬺",
		"惄",
		"愵",
		"昵",
		"暱",
		"氼",
		"眤",
		"睨",
		"縌",
		"胒",
		"腻",
		"膩",
		"逆",
		"𨺙"
	],
	niàn: [
		"卄",
		"唸",
		"埝",
		"廿",
		"念",
		"惗",
		"艌"
	],
	sà: [
		"卅",
		"櫒",
		"脎",
		"萨",
		"蕯",
		"薩",
		"鈒",
		"隡",
		"颯",
		"飒",
		"馺"
	],
	zú: [
		"卆",
		"哫",
		"崪",
		"族",
		"箤",
		"足",
		"踤",
		"镞"
	],
	shēng: [
		"升",
		"呏",
		"声",
		"斘",
		"昇",
		"曻",
		"枡",
		"殅",
		"泩",
		"湦",
		"焺",
		"牲",
		"珄",
		"生",
		"甥",
		"竔",
		"笙",
		"聲",
		"鉎",
		"鍟",
		"阩",
		"陞",
		"陹",
		"鵿",
		"鼪"
	],
	wàn: [
		"卍",
		"卐",
		"忨",
		"杤",
		"瞣",
		"脕",
		"腕",
		"萬",
		"蟃",
		"贎",
		"輐",
		"錽",
		"𬇕"
	],
	"huá huà huā": ["华", "華"],
	bēi: [
		"卑",
		"悲",
		"揹",
		"杯",
		"桮",
		"盃",
		"碑",
		"藣",
		"鵯",
		"鹎"
	],
	"zú cù": ["卒"],
	"dān shàn chán": ["单", "單"],
	"nán nā": ["南"],
	"shuài lǜ": ["卛"],
	"bǔ bo pú": ["卜"],
	"kuàng guàn": ["卝"],
	biàn: [
		"卞",
		"变",
		"変",
		"峅",
		"弁",
		"徧",
		"忭",
		"抃",
		"昪",
		"汳",
		"汴",
		"玣",
		"艑",
		"苄",
		"覍",
		"諚",
		"變",
		"辡",
		"辧",
		"辨",
		"辩",
		"辫",
		"辮",
		"辯",
		"遍",
		"釆",
		"𨚕"
	],
	bǔ: [
		"卟",
		"哺",
		"捕",
		"补",
		"補",
		"鸔",
		"𬷕"
	],
	"zhàn zhān": ["占", "覱"],
	"kǎ qiǎ": ["卡"],
	lú: [
		"卢",
		"嚧",
		"垆",
		"壚",
		"庐",
		"廬",
		"曥",
		"枦",
		"栌",
		"櫨",
		"泸",
		"瀘",
		"炉",
		"爐",
		"獹",
		"玈",
		"瓐",
		"盧",
		"矑",
		"籚",
		"纑",
		"罏",
		"胪",
		"臚",
		"舮",
		"舻",
		"艫",
		"芦",
		"蘆",
		"蠦",
		"轤",
		"轳",
		"鈩",
		"鑪",
		"顱",
		"颅",
		"馿",
		"髗",
		"魲",
		"鱸",
		"鲈",
		"鸕",
		"鸬",
		"黸",
		"𬬻"
	],
	lǔ: [
		"卤",
		"塷",
		"掳",
		"擄",
		"樐",
		"橹",
		"櫓",
		"氌",
		"滷",
		"澛",
		"瀂",
		"硵",
		"磠",
		"穞",
		"艣",
		"艪",
		"蓾",
		"虏",
		"虜",
		"鏀",
		"鐪",
		"鑥",
		"镥",
		"魯",
		"鲁",
		"鹵"
	],
	guà: [
		"卦",
		"啩",
		"挂",
		"掛",
		"罣",
		"褂",
		"詿",
		"诖"
	],
	"áng yǎng": ["卬"],
	yìn: [
		"印",
		"垽",
		"堷",
		"廕",
		"慭",
		"憖",
		"憗",
		"懚",
		"洕",
		"湚",
		"猌",
		"癊",
		"胤",
		"茚",
		"酳",
		"鮣",
		"䲟"
	],
	què: [
		"却",
		"卻",
		"塙",
		"崅",
		"悫",
		"愨",
		"慤",
		"搉",
		"榷",
		"燩",
		"琷",
		"皵",
		"确",
		"確",
		"礭",
		"闋",
		"阕",
		"鵲",
		"鹊",
		"𬒈"
	],
	luǎn: ["卵"],
	"juàn juǎn": ["卷", "巻"],
	"chǎng ān hàn": ["厂"],
	"wěi yán": ["厃"],
	tīng: [
		"厅",
		"厛",
		"听",
		"庁",
		"廰",
		"廳",
		"汀",
		"烃",
		"烴",
		"綎",
		"耓",
		"聴",
		"聼",
		"聽",
		"鞓",
		"𬘩"
	],
	"zhé zhái": ["厇"],
	"hàn àn": ["厈", "屽"],
	yǎ: [
		"厊",
		"唖",
		"庌",
		"痖",
		"瘂",
		"蕥"
	],
	shè: [
		"厍",
		"厙",
		"弽",
		"慑",
		"慴",
		"懾",
		"摂",
		"欇",
		"涉",
		"涻",
		"渉",
		"滠",
		"灄",
		"社",
		"舎",
		"蔎",
		"蠂",
		"設",
		"设",
		"赦",
		"騇",
		"麝"
	],
	dǐ: [
		"厎",
		"呧",
		"坘",
		"弤",
		"抵",
		"拞",
		"掋",
		"牴",
		"砥",
		"菧",
		"觝",
		"詆",
		"诋",
		"軧",
		"邸",
		"阺",
		"骶",
		"鯳"
	],
	"zhǎ zhǎi": ["厏"],
	páng: [
		"厐",
		"嫎",
		"庞",
		"徬",
		"舽",
		"螃",
		"逄",
		"鰟",
		"鳑",
		"龎",
		"龐"
	],
	"zhì shī": ["厔"],
	máng: [
		"厖",
		"吂",
		"哤",
		"娏",
		"忙",
		"恾",
		"杗",
		"杧",
		"汒",
		"浝",
		"牻",
		"痝",
		"盲",
		"硭",
		"笀",
		"芒",
		"茫",
		"蘉",
		"邙",
		"釯",
		"鋩",
		"铓",
		"駹"
	],
	zuī: [
		"厜",
		"樶",
		"纗",
		"蟕"
	],
	"shà xià": ["厦", "廈"],
	áo: [
		"厫",
		"嗷",
		"嗸",
		"廒",
		"敖",
		"滶",
		"獒",
		"獓",
		"璈",
		"翱",
		"翶",
		"翺",
		"聱",
		"蔜",
		"螯",
		"謷",
		"謸",
		"遨",
		"鏖",
		"隞",
		"鰲",
		"鳌",
		"鷔",
		"鼇"
	],
	"lán qiān": ["厱"],
	"sī mǒu": ["厶"],
	"gōng hóng": ["厷"],
	"lín miǎo": ["厸"],
	"qiú róu": ["厹"],
	dū: [
		"厾",
		"嘟",
		"督",
		"醏"
	],
	"xiàn xuán": ["县", "縣"],
	"cān shēn cēn sān": [
		"参",
		"參",
		"叄",
		"叅"
	],
	"ài yǐ": ["叆"],
	"chā chà chǎ chá": ["叉"],
	shuāng: [
		"双",
		"孀",
		"孇",
		"欆",
		"礵",
		"艭",
		"雙",
		"霜",
		"騻",
		"驦",
		"骦",
		"鷞",
		"鸘",
		"鹴"
	],
	shōu: ["収", "收"],
	guái: ["叏"],
	bá: [
		"叐",
		"妭",
		"抜",
		"拔",
		"炦",
		"癹",
		"胈",
		"茇",
		"菝",
		"詙",
		"跋",
		"軷",
		"魃",
		"鼥"
	],
	"fā fà": ["发"],
	"zhuó yǐ lì jué": ["叕"],
	qǔ: [
		"取",
		"娶",
		"竬",
		"蝺",
		"詓",
		"齲",
		"龋"
	],
	"jiǎ xiá": ["叚", "徦"],
	"wèi yù": [
		"叞",
		"尉",
		"蔚"
	],
	dié: [
		"叠",
		"垤",
		"堞",
		"峌",
		"幉",
		"恎",
		"惵",
		"戜",
		"曡",
		"殜",
		"氎",
		"牃",
		"牒",
		"瓞",
		"畳",
		"疂",
		"疉",
		"疊",
		"碟",
		"絰",
		"绖",
		"耊",
		"耋",
		"胅",
		"艓",
		"苵",
		"蜨",
		"蝶",
		"褋",
		"詄",
		"諜",
		"谍",
		"跮",
		"蹀",
		"迭",
		"镻",
		"鰈",
		"鲽",
		"鴩",
		"𫶇"
	],
	ruì: [
		"叡",
		"枘",
		"汭",
		"瑞",
		"睿",
		"芮",
		"蚋",
		"蜹",
		"銳",
		"鋭",
		"锐"
	],
	"jù gōu": ["句"],
	lìng: [
		"另",
		"呤",
		"炩",
		"蘦"
	],
	"dāo dáo tāo": ["叨"],
	"zhī zhǐ": ["只"],
	jiào: [
		"叫",
		"呌",
		"嘂",
		"嘦",
		"噍",
		"嬓",
		"斍",
		"斠",
		"滘",
		"漖",
		"獥",
		"珓",
		"皭",
		"窖",
		"藠",
		"訆",
		"譥",
		"趭",
		"較",
		"轎",
		"轿",
		"较",
		"酵",
		"醮",
		"釂"
	],
	"zhào shào": ["召"],
	"kě kè": ["可"],
	"tái tāi": ["台", "苔"],
	pǒ: [
		"叵",
		"尀",
		"笸",
		"箥",
		"鉕",
		"钷",
		"駊"
	],
	"yè xié": ["叶"],
	"hào háo": ["号"],
	tàn: [
		"叹",
		"嘆",
		"探",
		"歎",
		"湠",
		"炭",
		"碳",
		"舕"
	],
	"hōng hóng": ["叿"],
	miē: [
		"吀",
		"咩",
		"哶",
		"孭"
	],
	"xū yū yù": ["吁"],
	chī: [
		"吃",
		"哧",
		"喫",
		"嗤",
		"噄",
		"妛",
		"媸",
		"彨",
		"彲",
		"摛",
		"攡",
		"殦",
		"瓻",
		"痴",
		"癡",
		"眵",
		"瞝",
		"笞",
		"粚",
		"胵",
		"蚩",
		"螭",
		"訵",
		"魑",
		"鴟",
		"鵄",
		"鸱",
		"黐",
		"齝",
		"𫄨"
	],
	"xuān sòng": ["吅"],
	yāo: [
		"吆",
		"喓",
		"夭",
		"妖",
		"幺",
		"楆",
		"殀",
		"祅",
		"腰",
		"葽",
		"訞",
		"邀",
		"鴁",
		"鴢",
		"㙘"
	],
	zǐ: [
		"吇",
		"姉",
		"姊",
		"子",
		"杍",
		"梓",
		"榟",
		"橴",
		"滓",
		"矷",
		"秭",
		"笫",
		"籽",
		"紫",
		"耔",
		"虸",
		"訿",
		"釨"
	],
	"hé gě": ["合", "鲄"],
	"cùn dòu": ["吋"],
	"tóng tòng": ["同"],
	"tǔ tù": ["吐", "唋"],
	"zhà zhā": ["吒", "奓"],
	"xià hè": ["吓"],
	"ā yā": ["吖"],
	"ma má mǎ": ["吗"],
	lìn: [
		"吝",
		"恡",
		"悋",
		"橉",
		"焛",
		"甐",
		"膦",
		"蔺",
		"藺",
		"賃",
		"赁",
		"蹸",
		"躏",
		"躙",
		"躪",
		"轥",
		"閵"
	],
	tūn: [
		"吞",
		"暾",
		"朜",
		"焞"
	],
	"bǐ pǐ": ["吡"],
	qìn: [
		"吢",
		"吣",
		"唚",
		"抋",
		"揿",
		"搇",
		"撳",
		"沁",
		"瀙",
		"菣",
		"藽"
	],
	"jiè gè": ["吤"],
	"fǒu pǐ": ["否"],
	"ba bā": ["吧"],
	dūn: [
		"吨",
		"噸",
		"墩",
		"墪",
		"惇",
		"撉",
		"撴",
		"犜",
		"獤",
		"礅",
		"蜳",
		"蹾",
		"驐"
	],
	fēn: [
		"吩",
		"帉",
		"昐",
		"朆",
		"梤",
		"棻",
		"氛",
		"竕",
		"紛",
		"纷",
		"翂",
		"芬",
		"衯",
		"訜",
		"躮",
		"酚",
		"鈖",
		"雰",
		"餴",
		"饙",
		"馚"
	],
	"é huā": ["吪"],
	"kēng háng": ["吭", "妔"],
	shǔn: ["吮"],
	"zhī zī": ["吱"],
	"yǐn shěn": ["吲"],
	wú: [
		"吳",
		"吴",
		"呉",
		"墲",
		"峿",
		"梧",
		"橆",
		"毋",
		"洖",
		"浯",
		"無",
		"珸",
		"璑",
		"祦",
		"芜",
		"茣",
		"莁",
		"蕪",
		"蜈",
		"蟱",
		"譕",
		"郚",
		"鋙",
		"铻",
		"鯃",
		"鵐",
		"鷡",
		"鹀",
		"鼯"
	],
	"chǎo chāo": ["吵"],
	"nà nè": ["吶"],
	"xuè chuò jué": ["吷"],
	chuī: [
		"吹",
		"炊",
		"龡"
	],
	"dōu rú": ["吺"],
	hǒu: ["吼", "犼"],
	"hōng hǒu ōu": ["吽"],
	"wú yù": ["吾"],
	"ya yā": ["呀"],
	"è e": ["呃"],
	dāi: [
		"呆",
		"懛",
		"獃"
	],
	"mèn qǐ": ["呇"],
	hōng: [
		"呍",
		"嚝",
		"揈",
		"灴",
		"烘",
		"焢",
		"硡",
		"薨",
		"訇",
		"谾",
		"軣",
		"輷",
		"轟",
		"轰",
		"鍧"
	],
	nà: [
		"呐",
		"捺",
		"笝",
		"納",
		"纳",
		"肭",
		"蒳",
		"衲",
		"豽",
		"貀",
		"軜",
		"郍",
		"鈉",
		"钠",
		"靹",
		"魶"
	],
	"tūn tiān": ["呑"],
	"fǔ ḿ": ["呒", "嘸"],
	"dāi tǎi": ["呔"],
	"ǒu ōu òu": ["呕"],
	"bài bei": ["呗"],
	"yuán yún yùn": ["员", "員"],
	guō: [
		"呙",
		"啯",
		"嘓",
		"埚",
		"堝",
		"墎",
		"崞",
		"彉",
		"彍",
		"懖",
		"猓",
		"瘑",
		"聒",
		"蝈",
		"蟈",
		"郭",
		"鈛",
		"鍋",
		"锅"
	],
	"huá qì": ["呚"],
	"qiàng qiāng": ["呛", "跄"],
	shī: [
		"呞",
		"失",
		"尸",
		"屍",
		"师",
		"師",
		"施",
		"浉",
		"湤",
		"湿",
		"溮",
		"溼",
		"濕",
		"狮",
		"獅",
		"瑡",
		"絁",
		"葹",
		"蒒",
		"蓍",
		"虱",
		"蝨",
		"褷",
		"襹",
		"詩",
		"诗",
		"邿",
		"釃",
		"鉇",
		"鍦",
		"鯴",
		"鰤",
		"鲺",
		"鳲",
		"鳾",
		"鶳",
		"鸤",
		"䴓",
		"𫚕"
	],
	juǎn: [
		"呟",
		"埍",
		"臇",
		"菤",
		"錈",
		"锩"
	],
	pěn: ["呠", "翸"],
	"wěn mǐn": ["呡"],
	"ne ní": ["呢"],
	"ḿ m̀ móu": ["呣"],
	rán: [
		"呥",
		"嘫",
		"然",
		"燃",
		"繎",
		"肰",
		"蚦",
		"蚺",
		"衻",
		"袇",
		"袡",
		"髥",
		"髯"
	],
	"tiè chè": ["呫"],
	"qì zhī": ["呮"],
	"zǐ cī": ["呰"],
	"guā gū guǎ": ["呱"],
	"cī zī": ["呲"],
	"hǒu xǔ gòu": ["呴"],
	"hē ā á ǎ à a": ["呵"],
	náo: [
		"呶",
		"夒",
		"峱",
		"嶩",
		"巎",
		"挠",
		"撓",
		"猱",
		"硇",
		"蛲",
		"蟯",
		"詉",
		"譊",
		"鐃",
		"铙"
	],
	"xiā gā": ["呷"],
	pēi: [
		"呸",
		"怌",
		"肧",
		"胚",
		"衃",
		"醅"
	],
	"háo xiāo": ["呺"],
	mìng: ["命", "掵"],
	"dá dàn": ["呾"],
	"zuǐ jǔ": ["咀"],
	"xián gān": ["咁"],
	pǒu: [
		"咅",
		"哣",
		"犃"
	],
	"yǎng yāng": ["咉"],
	"zǎ zé zhā": ["咋"],
	"hé hè huó huò hú": ["和"],
	hāi: ["咍"],
	dā: [
		"咑",
		"哒",
		"噠",
		"墶",
		"搭",
		"撘",
		"耷",
		"褡",
		"鎝",
		"𨱏"
	],
	"kǎ kā": ["咔"],
	gū: [
		"咕",
		"唂",
		"唃",
		"姑",
		"嫴",
		"孤",
		"巬",
		"巭",
		"柧",
		"橭",
		"沽",
		"泒",
		"稒",
		"笟",
		"箍",
		"箛",
		"篐",
		"罛",
		"苽",
		"菇",
		"菰",
		"蓇",
		"觚",
		"軱",
		"軲",
		"轱",
		"辜",
		"酤",
		"鈲",
		"鮕",
		"鴣",
		"鸪"
	],
	"kā gā": ["咖"],
	zuo: ["咗"],
	lóng: [
		"咙",
		"嚨",
		"嶐",
		"巃",
		"巄",
		"昽",
		"曨",
		"朧",
		"栊",
		"槞",
		"櫳",
		"湰",
		"滝",
		"漋",
		"爖",
		"珑",
		"瓏",
		"癃",
		"眬",
		"矓",
		"砻",
		"礱",
		"礲",
		"窿",
		"竜",
		"聋",
		"聾",
		"胧",
		"茏",
		"蘢",
		"蠪",
		"蠬",
		"襱",
		"豅",
		"鏧",
		"鑨",
		"霳",
		"靇",
		"驡",
		"鸗",
		"龍",
		"龒",
		"龙"
	],
	"xiàn xián": ["咞"],
	qì: [
		"咠",
		"唭",
		"噐",
		"器",
		"夡",
		"弃",
		"憇",
		"憩",
		"暣",
		"棄",
		"欫",
		"气",
		"気",
		"氣",
		"汔",
		"汽",
		"泣",
		"湆",
		"湇",
		"炁",
		"甈",
		"盵",
		"矵",
		"碛",
		"碶",
		"磜",
		"磧",
		"罊",
		"芞",
		"葺",
		"藒",
		"蟿",
		"訖",
		"讫",
		"迄",
		"鐑"
	],
	"xì dié": ["咥"],
	"liē liě lié lie": ["咧"],
	zī: [
		"咨",
		"嗞",
		"姕",
		"姿",
		"孜",
		"孳",
		"孶",
		"崰",
		"嵫",
		"栥",
		"椔",
		"淄",
		"湽",
		"滋",
		"澬",
		"玆",
		"禌",
		"秶",
		"粢",
		"紎",
		"緇",
		"緕",
		"纃",
		"缁",
		"茊",
		"茲",
		"葘",
		"諮",
		"谘",
		"貲",
		"資",
		"赀",
		"资",
		"赼",
		"趑",
		"趦",
		"輜",
		"輺",
		"辎",
		"鄑",
		"鈭",
		"錙",
		"鍿",
		"鎡",
		"锱",
		"镃",
		"頾",
		"頿",
		"髭",
		"鯔",
		"鰦",
		"鲻",
		"鶅",
		"鼒",
		"齍",
		"齜",
		"龇"
	],
	mī: ["咪"],
	"jī xī qià": ["咭"],
	"gē luò kǎ lo": ["咯"],
	"shù xún": ["咰"],
	"zán zá zǎ zan": ["咱"],
	"hāi ké": ["咳"],
	huī: [
		"咴",
		"噅",
		"噕",
		"婎",
		"媈",
		"幑",
		"徽",
		"恢",
		"拻",
		"挥",
		"揮",
		"晖",
		"暉",
		"楎",
		"洃",
		"瀈",
		"灰",
		"灳",
		"烣",
		"睳",
		"禈",
		"翚",
		"翬",
		"蘳",
		"袆",
		"褘",
		"詼",
		"诙",
		"豗",
		"輝",
		"辉",
		"鰴",
		"麾",
		"㧑"
	],
	"huài shì": ["咶"],
	táo: [
		"咷",
		"啕",
		"桃",
		"檮",
		"洮",
		"淘",
		"祹",
		"綯",
		"绹",
		"萄",
		"蜪",
		"裪",
		"迯",
		"逃",
		"醄",
		"鋾",
		"鞀",
		"鞉",
		"饀",
		"駣",
		"騊",
		"鼗",
		"𫘦"
	],
	xián: [
		"咸",
		"啣",
		"娴",
		"娹",
		"婱",
		"嫌",
		"嫺",
		"嫻",
		"弦",
		"挦",
		"撏",
		"涎",
		"湺",
		"澖",
		"甉",
		"痫",
		"癇",
		"癎",
		"絃",
		"胘",
		"舷",
		"藖",
		"蚿",
		"蛝",
		"衔",
		"衘",
		"誸",
		"諴",
		"賢",
		"贒",
		"贤",
		"輱",
		"醎",
		"銜",
		"鑦",
		"閑",
		"闲",
		"鷳",
		"鷴",
		"鷼",
		"鹇",
		"鹹",
		"麙",
		"𫍯"
	],
	"è àn": ["咹"],
	"xuān xuǎn": ["咺", "烜"],
	"wāi hé wǒ guǎ guō": ["咼"],
	"yàn yè yān": ["咽"],
	āi: [
		"哀",
		"哎",
		"埃",
		"溾",
		"銰",
		"鎄",
		"锿"
	],
	pǐn: ["品", "榀"],
	shěn: [
		"哂",
		"婶",
		"嬸",
		"审",
		"宷",
		"審",
		"弞",
		"曋",
		"渖",
		"瀋",
		"瞫",
		"矤",
		"矧",
		"覾",
		"訠",
		"諗",
		"讅",
		"谂",
		"谉",
		"邥",
		"頣",
		"魫"
	],
	"hǒng hōng hòng": ["哄"],
	"wā wa": ["哇"],
	"hā hǎ hà": ["哈"],
	zāi: [
		"哉",
		"栽",
		"渽",
		"溨",
		"災",
		"灾",
		"烖",
		"睵",
		"賳"
	],
	"dì diè": ["哋"],
	pài: [
		"哌",
		"沠",
		"派",
		"渒",
		"湃",
		"蒎",
		"鎃"
	],
	"gén hěn": ["哏"],
	"yǎ yā": ["哑", "雅"],
	"yuě huì": ["哕", "噦"],
	nián: [
		"哖",
		"年",
		"秊",
		"秥",
		"鮎",
		"鯰",
		"鲇",
		"鲶",
		"鵇",
		"黏"
	],
	"huá huā": ["哗", "嘩"],
	"jì jiē zhāi": ["哜", "嚌"],
	mōu: ["哞"],
	"yō yo": ["哟", "喲"],
	lòng: [
		"哢",
		"梇",
		"贚"
	],
	"ò ó é": ["哦"],
	"lī lǐ li": ["哩"],
	"nǎ na nǎi né něi": ["哪"],
	hè: [
		"哬",
		"垎",
		"壑",
		"寉",
		"惒",
		"焃",
		"煂",
		"燺",
		"爀",
		"癋",
		"碋",
		"翯",
		"褐",
		"謞",
		"賀",
		"贺",
		"赫",
		"靍",
		"靎",
		"靏",
		"鶴",
		"鸖",
		"鹤"
	],
	"bō pò bā": ["哱"],
	zhé: [
		"哲",
		"啠",
		"喆",
		"嚞",
		"埑",
		"悊",
		"摺",
		"晢",
		"晣",
		"歽",
		"矺",
		"砓",
		"磔",
		"籷",
		"粍",
		"虴",
		"蛰",
		"蟄",
		"袩",
		"詟",
		"謫",
		"謺",
		"讁",
		"讋",
		"谪",
		"輒",
		"輙",
		"轍",
		"辄",
		"辙",
		"鮿"
	],
	"liàng láng": ["哴"],
	"liè lǜ": ["哷"],
	hān: [
		"哻",
		"憨",
		"蚶",
		"谽",
		"酣",
		"頇",
		"顸",
		"馠",
		"魽",
		"鼾"
	],
	"hēng hng": ["哼"],
	gěng: [
		"哽",
		"埂",
		"峺",
		"挭",
		"梗",
		"綆",
		"绠",
		"耿",
		"莄",
		"郠",
		"骾",
		"鯁",
		"鲠",
		"𬒔"
	],
	"chuò yuè": ["哾"],
	"gě jiā": ["哿"],
	"bei bài": ["唄"],
	"hán hàn": ["唅"],
	chún: [
		"唇",
		"浱",
		"湻",
		"滣",
		"漘",
		"犉",
		"純",
		"纯",
		"脣",
		"莼",
		"蒓",
		"蓴",
		"醇",
		"醕",
		"錞",
		"陙",
		"鯙",
		"鶉",
		"鹑",
		"𬭚"
	],
	"ài āi": ["唉"],
	"jiá qiǎn": ["唊"],
	"yán dàn xián": ["唌"],
	chē: [
		"唓",
		"砗",
		"硨",
		"莗",
		"蛼"
	],
	"wú ńg ń": ["唔"],
	zào: [
		"唕",
		"唣",
		"噪",
		"慥",
		"梍",
		"灶",
		"煰",
		"燥",
		"皁",
		"皂",
		"竃",
		"竈",
		"簉",
		"艁",
		"譟",
		"趮",
		"躁",
		"造",
		"𥖨"
	],
	dí: [
		"唙",
		"啇",
		"嘀",
		"嚁",
		"嫡",
		"廸",
		"敌",
		"敵",
		"梑",
		"涤",
		"滌",
		"狄",
		"笛",
		"籴",
		"糴",
		"苖",
		"荻",
		"蔋",
		"蔐",
		"藡",
		"覿",
		"觌",
		"豴",
		"迪",
		"靮",
		"頔",
		"馰",
		"髢",
		"鸐",
		"𬱖"
	],
	"gòng hǒng gǒng": ["唝", "嗊"],
	dóu: ["唞"],
	"lào láo": [
		"唠",
		"嘮",
		"憦"
	],
	huàn: [
		"唤",
		"喚",
		"奂",
		"奐",
		"宦",
		"嵈",
		"幻",
		"患",
		"愌",
		"换",
		"換",
		"擐",
		"攌",
		"梙",
		"槵",
		"浣",
		"涣",
		"渙",
		"漶",
		"澣",
		"烉",
		"焕",
		"煥",
		"瑍",
		"痪",
		"瘓",
		"睆",
		"肒",
		"藧",
		"豢",
		"轘",
		"逭",
		"鯇",
		"鯶",
		"鰀",
		"鲩"
	],
	léng: [
		"唥",
		"塄",
		"楞",
		"碐",
		"薐"
	],
	"wō wěi": ["唩"],
	fěng: [
		"唪",
		"覂",
		"諷",
		"讽"
	],
	"yín jìn": ["唫"],
	"hǔ xià": ["唬"],
	wéi: [
		"唯",
		"围",
		"圍",
		"壝",
		"峗",
		"峞",
		"嵬",
		"帏",
		"帷",
		"幃",
		"惟",
		"桅",
		"沩",
		"洈",
		"涠",
		"湋",
		"溈",
		"潍",
		"潙",
		"潿",
		"濰",
		"犩",
		"矀",
		"維",
		"维",
		"蓶",
		"覹",
		"违",
		"違",
		"鄬",
		"醀",
		"鍏",
		"闈",
		"闱",
		"韋",
		"韦",
		"鮠",
		"𣲗",
		"𬶏"
	],
	shuā: ["唰"],
	chàng: [
		"唱",
		"怅",
		"悵",
		"暢",
		"焻",
		"畅",
		"畼",
		"誯",
		"韔",
		"鬯"
	],
	"ér wā": ["唲"],
	qiàng: [
		"唴",
		"炝",
		"熗",
		"羻"
	],
	yō: ["唷"],
	yū: [
		"唹",
		"淤",
		"瘀",
		"盓",
		"箊",
		"紆",
		"纡",
		"込",
		"迂",
		"迃",
		"陓"
	],
	lài: [
		"唻",
		"濑",
		"瀨",
		"瀬",
		"癞",
		"癩",
		"睐",
		"睞",
		"籁",
		"籟",
		"藾",
		"賚",
		"賴",
		"赉",
		"赖",
		"頼",
		"顂",
		"鵣"
	],
	tuò: [
		"唾",
		"嶞",
		"柝",
		"毤",
		"毻",
		"箨",
		"籜",
		"萚",
		"蘀",
		"跅"
	],
	"zhōu zhāo tiào": ["啁"],
	kěn: [
		"啃",
		"垦",
		"墾",
		"恳",
		"懇",
		"肎",
		"肯",
		"肻",
		"豤",
		"錹"
	],
	"zhuó zhào": ["啅", "濯"],
	"hēng hèng": ["啈", "悙"],
	"lín lán": ["啉"],
	"a ā á ǎ à": ["啊"],
	qiāng: [
		"啌",
		"嗴",
		"嶈",
		"戕",
		"摤",
		"斨",
		"枪",
		"槍",
		"溬",
		"牄",
		"猐",
		"獇",
		"羌",
		"羗",
		"腔",
		"蜣",
		"謒",
		"鏘",
		"锖",
		"锵"
	],
	"tūn zhūn xiāng duǐ": ["啍"],
	wèn: [
		"問",
		"妏",
		"揾",
		"搵",
		"璺",
		"问",
		"顐"
	],
	"cuì qi": ["啐"],
	"dié shà jié tì": ["啑"],
	"yuē wā": ["啘"],
	"zǐ cǐ": ["啙"],
	"bǐ tú": ["啚"],
	"chuò chuài": ["啜"],
	"yǎ yā è": ["啞"],
	fēi: [
		"啡",
		"婓",
		"婔",
		"扉",
		"暃",
		"渄",
		"猆",
		"緋",
		"绯",
		"裶",
		"霏",
		"非",
		"靟",
		"飛",
		"飝",
		"飞",
		"餥",
		"馡",
		"騑",
		"騛",
		"鯡",
		"鲱",
		"𬴂"
	],
	pí: [
		"啤",
		"壀",
		"枇",
		"毗",
		"毘",
		"焷",
		"琵",
		"疲",
		"皮",
		"篺",
		"罴",
		"羆",
		"脾",
		"腗",
		"膍",
		"蚍",
		"蚽",
		"蜱",
		"螷",
		"蠯",
		"豼",
		"貔",
		"郫",
		"鈹",
		"阰",
		"陴",
		"隦",
		"魮",
		"鮍",
		"鲏",
		"鵧",
		"鼙"
	],
	shá: ["啥"],
	"lā la": ["啦"],
	"yīng qíng": ["啨"],
	pā: [
		"啪",
		"妑",
		"舥",
		"葩",
		"趴"
	],
	"zhě shì": ["啫"],
	sè: [
		"啬",
		"嗇",
		"懎",
		"擌",
		"栜",
		"歮",
		"涩",
		"渋",
		"澀",
		"澁",
		"濇",
		"濏",
		"瀒",
		"瑟",
		"璱",
		"瘷",
		"穑",
		"穡",
		"穯",
		"繬",
		"譅",
		"轖",
		"銫",
		"鏼",
		"铯",
		"飋"
	],
	niè: [
		"啮",
		"嗫",
		"噛",
		"嚙",
		"囁",
		"囓",
		"圼",
		"孼",
		"孽",
		"嵲",
		"嶭",
		"巕",
		"帇",
		"敜",
		"枿",
		"槷",
		"櫱",
		"涅",
		"湼",
		"痆",
		"篞",
		"籋",
		"糱",
		"糵",
		"聂",
		"聶",
		"臬",
		"臲",
		"蘖",
		"蠥",
		"讘",
		"踂",
		"踗",
		"踙",
		"蹑",
		"躡",
		"錜",
		"鎳",
		"鑈",
		"鑷",
		"钀",
		"镊",
		"镍",
		"闑",
		"陧",
		"隉",
		"顳",
		"颞",
		"齧",
		"𫔶"
	],
	"luō luó luo": ["啰", "囉"],
	"tān chǎn tuō": ["啴"],
	bo: ["啵", "蔔"],
	dìng: [
		"啶",
		"定",
		"椗",
		"矴",
		"碇",
		"碠",
		"磸",
		"聢",
		"腚",
		"萣",
		"蝊",
		"訂",
		"订",
		"錠",
		"锭",
		"顁",
		"飣",
		"饤"
	],
	lāng: ["啷"],
	"án ān": ["啽"],
	kā: ["喀", "擖"],
	"yóng yú": ["喁"],
	"lā lá lǎ": ["喇"],
	jiē: [
		"喈",
		"喼",
		"嗟",
		"堦",
		"媘",
		"接",
		"掲",
		"擑",
		"湝",
		"煯",
		"疖",
		"痎",
		"癤",
		"皆",
		"秸",
		"稭",
		"脻",
		"蝔",
		"街",
		"謯",
		"阶",
		"階",
		"鞂",
		"鶛"
	],
	hóu: [
		"喉",
		"帿",
		"猴",
		"瘊",
		"睺",
		"篌",
		"糇",
		"翭",
		"葔",
		"鄇",
		"鍭",
		"餱",
		"骺",
		"鯸",
		"𬭤"
	],
	"dié zhá": ["喋"],
	wāi: [
		"喎",
		"歪",
		"竵"
	],
	"nuò rě": ["喏"],
	"xù huò guó": ["喐"],
	zán: ["喒"],
	"wō ō": ["喔"],
	hú: [
		"喖",
		"嘝",
		"囫",
		"壶",
		"壷",
		"壺",
		"媩",
		"弧",
		"搰",
		"斛",
		"楜",
		"槲",
		"湖",
		"瀫",
		"焀",
		"煳",
		"狐",
		"猢",
		"瑚",
		"瓳",
		"箶",
		"絗",
		"縠",
		"胡",
		"葫",
		"蔛",
		"蝴",
		"螜",
		"衚",
		"觳",
		"醐",
		"鍸",
		"頶",
		"餬",
		"鬍",
		"魱",
		"鰗",
		"鵠",
		"鶘",
		"鶦",
		"鹕"
	],
	"huàn yuán xuǎn hé": ["喛"],
	xǐ: [
		"喜",
		"囍",
		"壐",
		"屣",
		"徙",
		"憙",
		"枲",
		"橲",
		"歖",
		"漇",
		"玺",
		"璽",
		"矖",
		"禧",
		"縰",
		"葈",
		"葸",
		"蓰",
		"蟢",
		"謑",
		"蹝",
		"躧",
		"鈢",
		"鉨",
		"鉩",
		"鱚",
		"𬭳",
		"𬶮"
	],
	"hē hè yè": ["喝"],
	kuì: [
		"喟",
		"嘳",
		"媿",
		"嬇",
		"愦",
		"愧",
		"憒",
		"篑",
		"簣",
		"籄",
		"聩",
		"聭",
		"聵",
		"膭",
		"蕢",
		"謉",
		"餽",
		"饋",
		"馈"
	],
	"zhǒng chuáng": ["喠"],
	"wéi wèi": [
		"喡",
		"為",
		"爲"
	],
	"duó zhà": ["喥"],
	"sāng sàng": ["喪"],
	"qiáo jiāo": ["喬"],
	"pèn bēn": ["喯"],
	"cān sūn qī": ["喰"],
	"zhā chā": ["喳"],
	miāo: ["喵"],
	"pēn pèn": ["喷"],
	kuí: [
		"喹",
		"夔",
		"奎",
		"巙",
		"戣",
		"揆",
		"晆",
		"暌",
		"楏",
		"楑",
		"櫆",
		"犪",
		"睽",
		"葵",
		"藈",
		"蘷",
		"虁",
		"蝰",
		"躨",
		"逵",
		"鄈",
		"鍨",
		"鍷",
		"頯",
		"馗",
		"騤",
		"骙",
		"魁"
	],
	"lou lóu": ["喽"],
	"zào qiāo": ["喿"],
	"hè xiāo xiào hù": ["嗃"],
	"á shà": ["嗄"],
	xiù: [
		"嗅",
		"岫",
		"峀",
		"溴",
		"珛",
		"琇",
		"璓",
		"秀",
		"綉",
		"繍",
		"繡",
		"绣",
		"螑",
		"袖",
		"褎",
		"褏",
		"銹",
		"鏥",
		"鏽",
		"锈",
		"齅"
	],
	"qiāng qiàng": [
		"嗆",
		"戗",
		"戧",
		"蹌",
		"蹡"
	],
	"ài yì": ["嗌", "艾"],
	"má mǎ ma": ["嗎"],
	"kè kē": ["嗑"],
	"dā tà": ["嗒", "鎉"],
	sǎng: [
		"嗓",
		"搡",
		"磉",
		"褬",
		"鎟",
		"顙",
		"颡"
	],
	chēn: [
		"嗔",
		"抻",
		"琛",
		"瞋",
		"諃",
		"謓",
		"賝",
		"郴",
		"𬘭"
	],
	"wā gǔ": ["嗗"],
	"pǎng bēng": ["嗙"],
	"xián qiǎn qiān": ["嗛"],
	lào: [
		"嗠",
		"嫪",
		"橯",
		"涝",
		"澇",
		"耢",
		"耮",
		"躼",
		"軂",
		"酪"
	],
	wēng: [
		"嗡",
		"翁",
		"聬",
		"螉",
		"鎓",
		"鶲",
		"鹟",
		"𬭩"
	],
	wà: [
		"嗢",
		"腽",
		"膃",
		"袜",
		"襪",
		"韤"
	],
	"hēi hāi": ["嗨"],
	hē: [
		"嗬",
		"欱",
		"蠚",
		"訶",
		"诃"
	],
	zi: ["嗭"],
	sǎi: ["嗮"],
	"ǹg ńg ňg": ["嗯"],
	gě: ["嗰", "舸"],
	ná: [
		"嗱",
		"拏",
		"拿",
		"鎿",
		"镎"
	],
	diǎ: ["嗲"],
	"ài ǎi āi": ["嗳"],
	tōng: [
		"嗵",
		"樋",
		"炵",
		"蓪"
	],
	"zuī suī": ["嗺"],
	"zhē zhè zhù zhe": ["嗻"],
	mò: [
		"嗼",
		"圽",
		"塻",
		"墨",
		"妺",
		"嫼",
		"寞",
		"帞",
		"昩",
		"末",
		"枺",
		"歿",
		"殁",
		"沫",
		"漠",
		"爅",
		"獏",
		"瘼",
		"皌",
		"眽",
		"眿",
		"瞐",
		"瞙",
		"砞",
		"礳",
		"秣",
		"絈",
		"纆",
		"耱",
		"茉",
		"莈",
		"蓦",
		"蛨",
		"蟔",
		"貃",
		"貊",
		"貘",
		"銆",
		"鏌",
		"镆",
		"陌",
		"靺",
		"驀",
		"魩",
		"默",
		"黙",
		"𬙊"
	],
	sòu: ["嗽", "瘶"],
	tǎn: [
		"嗿",
		"坦",
		"忐",
		"憳",
		"憻",
		"暺",
		"毯",
		"璮",
		"菼",
		"袒",
		"襢",
		"醓",
		"鉭",
		"钽"
	],
	"jiào dǎo": ["嘄"],
	"kǎi gě": ["嘅"],
	"shān càn": ["嘇"],
	cáo: [
		"嘈",
		"嶆",
		"曹",
		"曺",
		"槽",
		"漕",
		"艚",
		"蓸",
		"螬",
		"褿",
		"鏪",
		"𥕢"
	],
	piào: [
		"嘌",
		"徱",
		"蔈",
		"驃"
	],
	"lóu lou": ["嘍"],
	gǎ: ["尕", "玍"],
	"gǔ jiǎ": ["嘏"],
	"jiāo xiāo": ["嘐"],
	"xū shī": ["嘘", "噓"],
	pó: [
		"嘙",
		"嚩",
		"婆",
		"櫇",
		"皤",
		"鄱"
	],
	"dē dēi": ["嘚"],
	"ma má": ["嘛"],
	"lē lei": ["嘞"],
	"gā gá gǎ": ["嘠"],
	sāi: [
		"嘥",
		"噻",
		"毢",
		"腮",
		"顋",
		"鰓"
	],
	"zuō chuài": ["嘬"],
	"cháo zhāo": [
		"嘲",
		"朝",
		"鼂"
	],
	zuǐ: [
		"嘴",
		"噿",
		"嶊",
		"璻"
	],
	"qiáo qiào": [
		"嘺",
		"翹",
		"谯"
	],
	"chù xù shòu": ["嘼"],
	"tān chǎn": ["嘽"],
	"dàn tán": [
		"嘾",
		"弾",
		"彈",
		"惔",
		"澹"
	],
	"hēi mò": ["嘿"],
	ě: [
		"噁",
		"砨",
		"頋",
		"騀",
		"鵈"
	],
	"fān bo": ["噃"],
	chuáng: [
		"噇",
		"床",
		"牀"
	],
	"cù zā hé": ["噈"],
	"tūn kuò": ["噋"],
	"cēng chēng": ["噌"],
	dēng: [
		"噔",
		"嬁",
		"灯",
		"燈",
		"璒",
		"登",
		"竳",
		"簦",
		"艠",
		"豋"
	],
	pū: [
		"噗",
		"扑",
		"撲",
		"攴",
		"攵",
		"潽",
		"炇",
		"陠"
	],
	juē: [
		"噘",
		"屩",
		"屫",
		"撧"
	],
	lū: [
		"噜",
		"嚕",
		"撸",
		"擼",
		"謢"
	],
	zhān: [
		"噡",
		"岾",
		"惉",
		"旃",
		"旜",
		"枬",
		"栴",
		"毡",
		"氈",
		"氊",
		"沾",
		"瞻",
		"薝",
		"蛅",
		"詀",
		"詹",
		"譫",
		"谵",
		"趈",
		"邅",
		"閚",
		"霑",
		"飦",
		"饘",
		"驙",
		"魙",
		"鱣",
		"鸇",
		"鹯",
		"𫗴"
	],
	ō: ["噢"],
	"zhòu zhuó": ["噣"],
	"jiào qiào chī": ["噭"],
	yuàn: [
		"噮",
		"妴",
		"怨",
		"愿",
		"掾",
		"瑗",
		"禐",
		"苑",
		"衏",
		"裫",
		"褑",
		"院",
		"願"
	],
	"ǎi ài āi": ["噯"],
	"yōng yǒng": ["噰", "澭"],
	"jué xué": ["噱"],
	"pēn pèn fèn": ["噴"],
	gá: [
		"噶",
		"尜",
		"釓",
		"錷",
		"钆"
	],
	"xīn hěn hèn": ["噷"],
	dāng: [
		"噹",
		"澢",
		"珰",
		"璫",
		"筜",
		"簹",
		"艡",
		"蟷",
		"裆",
		"襠"
	],
	làn: [
		"嚂",
		"滥",
		"濫",
		"烂",
		"燗",
		"爁",
		"爛",
		"爤",
		"瓓",
		"糷",
		"钄"
	],
	tà: [
		"嚃",
		"嚺",
		"崉",
		"挞",
		"搨",
		"撻",
		"榻",
		"橽",
		"毾",
		"涾",
		"澾",
		"濌",
		"禢",
		"粏",
		"誻",
		"譶",
		"蹋",
		"蹹",
		"躂",
		"躢",
		"遝",
		"錔",
		"闒",
		"闥",
		"闼",
		"阘",
		"鞜",
		"鞳"
	],
	"huō huò ǒ": ["嚄"],
	hāo: [
		"嚆",
		"茠",
		"蒿",
		"薅"
	],
	"hè xià": ["嚇"],
	"xiù pì": ["嚊"],
	"zhōu chóu": [
		"嚋",
		"盩",
		"诪"
	],
	mē: ["嚒"],
	"chā cā": ["嚓"],
	"bó pào bào": ["嚗"],
	"me mèi mò": ["嚜"],
	"xié hái": ["嚡"],
	"áo xiāo": ["嚣"],
	mō: ["嚤", "摸"],
	pín: [
		"嚬",
		"娦",
		"嫔",
		"嬪",
		"玭",
		"矉",
		"薲",
		"蠙",
		"貧",
		"贫",
		"顰",
		"颦",
		"𬞟"
	],
	mè: ["嚰", "濹"],
	"rǎng rāng": ["嚷"],
	lá: ["嚹", "旯"],
	"jiáo jué jiào": ["嚼"],
	chuò: [
		"嚽",
		"娖",
		"擉",
		"歠",
		"涰",
		"磭",
		"踀",
		"輟",
		"辍",
		"辵",
		"辶",
		"酫",
		"鑡",
		"餟",
		"齪",
		"龊"
	],
	"huān huàn": ["嚾"],
	"zá cà": ["囃"],
	chài: [
		"囆",
		"虿",
		"蠆",
		"袃",
		"訍"
	],
	"náng nāng": ["囊"],
	"zá zàn cān": ["囋"],
	sū: [
		"囌",
		"櫯",
		"甦",
		"稣",
		"穌",
		"窣",
		"蘇",
		"蘓",
		"酥",
		"鯂"
	],
	zèng: [
		"囎",
		"熷",
		"甑",
		"贈",
		"赠",
		"鋥",
		"锃"
	],
	"zá niè yàn": ["囐"],
	nāng: ["囔"],
	"luó luō luo": ["囖"],
	"wéi guó": ["囗"],
	huí: [
		"囘",
		"回",
		"囬",
		"廻",
		"廽",
		"恛",
		"洄",
		"痐",
		"茴",
		"蚘",
		"蛔",
		"蛕",
		"蜖",
		"迴",
		"逥",
		"鮰"
	],
	nín: [
		"囜",
		"您",
		"脌"
	],
	"jiǎn nān": ["囝"],
	nān: ["囡"],
	tuán: [
		"团",
		"団",
		"團",
		"慱",
		"抟",
		"摶",
		"檲",
		"糰",
		"鏄",
		"鷒",
		"鷻"
	],
	"tún dùn": ["囤", "坉"],
	guó: [
		"囯",
		"囶",
		"囻",
		"国",
		"圀",
		"國",
		"帼",
		"幗",
		"慖",
		"摑",
		"漍",
		"聝",
		"腘",
		"膕",
		"蔮",
		"虢",
		"馘",
		"𬇹"
	],
	kùn: [
		"困",
		"涃",
		"睏"
	],
	"wéi tōng": ["囲"],
	qūn: [
		"囷",
		"夋",
		"逡"
	],
	rì: [
		"囸",
		"日",
		"衵",
		"鈤",
		"馹",
		"驲"
	],
	tāi: [
		"囼",
		"孡",
		"胎"
	],
	pǔ: [
		"圃",
		"圑",
		"擈",
		"普",
		"暜",
		"樸",
		"檏",
		"氆",
		"浦",
		"溥",
		"烳",
		"諩",
		"譜",
		"谱",
		"蹼",
		"鐠",
		"镨"
	],
	"quān juàn juān": ["圈", "圏"],
	"chuí chuán": ["圌"],
	tuǎn: [
		"圕",
		"畽",
		"疃"
	],
	lüè: [
		"圙",
		"掠",
		"略",
		"畧",
		"稤",
		"鋝",
		"鋢",
		"锊",
		"䂮"
	],
	"huán yuán": ["圜"],
	luán: [
		"圝",
		"圞",
		"奱",
		"娈",
		"孌",
		"孪",
		"孿",
		"峦",
		"巒",
		"挛",
		"攣",
		"曫",
		"栾",
		"欒",
		"滦",
		"灤",
		"癴",
		"癵",
		"羉",
		"脔",
		"臠",
		"虊",
		"銮",
		"鑾",
		"鵉",
		"鸞",
		"鸾"
	],
	tǔ: [
		"土",
		"圡",
		"釷",
		"钍"
	],
	"xū wéi": ["圩"],
	"dì de": ["地", "嶳"],
	"qiān sú": ["圱"],
	zhèn: [
		"圳",
		"塦",
		"挋",
		"振",
		"朕",
		"栚",
		"甽",
		"眹",
		"紖",
		"絼",
		"纼",
		"誫",
		"賑",
		"赈",
		"鋴",
		"鎭",
		"鎮",
		"镇",
		"阵",
		"陣",
		"震",
		"鴆",
		"鸩"
	],
	"chǎng cháng": [
		"场",
		"場",
		"塲"
	],
	"qí yín": ["圻"],
	jiá: [
		"圿",
		"忦",
		"恝",
		"戞",
		"扴",
		"脥",
		"荚",
		"莢",
		"蛱",
		"蛺",
		"裌",
		"跲",
		"郏",
		"郟",
		"鋏",
		"铗",
		"頬",
		"頰",
		"颊",
		"鴶",
		"鵊"
	],
	"zhǐ zhì": ["坁"],
	bǎn: [
		"坂",
		"岅",
		"昄",
		"板",
		"版",
		"瓪",
		"粄",
		"舨",
		"蝂",
		"鈑",
		"钣",
		"阪",
		"魬"
	],
	qǐn: [
		"坅",
		"寑",
		"寝",
		"寢",
		"昑",
		"梫",
		"笉",
		"螼",
		"赾",
		"鋟",
		"锓"
	],
	"méi fén": ["坆"],
	"rǒng kēng": ["坈"],
	"fāng fáng": ["坊"],
	"fèn bèn": ["坋"],
	tān: [
		"坍",
		"怹",
		"摊",
		"擹",
		"攤",
		"滩",
		"灘",
		"瘫",
		"癱",
		"舑",
		"貪",
		"贪"
	],
	"huài pēi pī péi": ["坏"],
	"dì làn": ["坔"],
	tán: [
		"坛",
		"墰",
		"墵",
		"壇",
		"壜",
		"婒",
		"憛",
		"昙",
		"曇",
		"榃",
		"檀",
		"潭",
		"燂",
		"痰",
		"磹",
		"罈",
		"罎",
		"藫",
		"談",
		"譚",
		"譠",
		"谈",
		"谭",
		"貚",
		"郯",
		"醰",
		"錟",
		"顃"
	],
	bà: [
		"坝",
		"垻",
		"壩",
		"弝",
		"欛",
		"灞",
		"爸",
		"矲",
		"覇",
		"霸",
		"鮁",
		"鲅"
	],
	fén: [
		"坟",
		"墳",
		"妢",
		"岎",
		"幩",
		"枌",
		"棼",
		"汾",
		"焚",
		"燌",
		"燓",
		"羒",
		"羵",
		"蒶",
		"蕡",
		"蚠",
		"蚡",
		"豮",
		"豶",
		"轒",
		"鐼",
		"隫",
		"馩",
		"魵",
		"黂",
		"鼖",
		"鼢",
		"𣸣"
	],
	zhuì: [
		"坠",
		"墜",
		"惴",
		"甀",
		"畷",
		"礈",
		"綴",
		"縋",
		"缀",
		"缒",
		"腏",
		"膇",
		"諈",
		"贅",
		"赘",
		"醊",
		"錣",
		"鑆"
	],
	pō: [
		"坡",
		"岥",
		"泼",
		"溌",
		"潑",
		"釙",
		"鏺",
		"钋",
		"頗",
		"颇",
		"䥽"
	],
	"pǎn bàn": ["坢"],
	kūn: [
		"坤",
		"堃",
		"堒",
		"崐",
		"崑",
		"昆",
		"晜",
		"潉",
		"焜",
		"熴",
		"猑",
		"琨",
		"瑻",
		"菎",
		"蜫",
		"裈",
		"裩",
		"褌",
		"醌",
		"錕",
		"锟",
		"騉",
		"髠",
		"髡",
		"髨",
		"鯤",
		"鲲",
		"鵾",
		"鶤",
		"鹍"
	],
	diàn: [
		"坫",
		"垫",
		"墊",
		"壂",
		"奠",
		"婝",
		"店",
		"惦",
		"扂",
		"橂",
		"殿",
		"淀",
		"澱",
		"玷",
		"琔",
		"电",
		"癜",
		"簟",
		"蜔",
		"鈿",
		"電",
		"靛",
		"驔"
	],
	"mù mǔ": ["坶"],
	"kē kě": ["坷", "軻"],
	xuè: [
		"坹",
		"岤",
		"桖",
		"瀥",
		"狘",
		"瞲",
		"謔",
		"谑",
		"趐"
	],
	"dǐ chí": ["坻", "柢"],
	lā: [
		"垃",
		"柆",
		"菈",
		"邋"
	],
	lǒng: [
		"垄",
		"垅",
		"壟",
		"壠",
		"拢",
		"攏",
		"竉",
		"陇",
		"隴",
		"𬕂"
	],
	mín: [
		"垊",
		"姄",
		"岷",
		"崏",
		"捪",
		"旻",
		"旼",
		"民",
		"珉",
		"琘",
		"琝",
		"瑉",
		"痻",
		"盿",
		"砇",
		"緍",
		"緡",
		"缗",
		"罠",
		"苠",
		"鈱",
		"錉",
		"鍲",
		"鴖"
	],
	"dòng tóng": [
		"垌",
		"峒",
		"洞"
	],
	cí: [
		"垐",
		"嬨",
		"慈",
		"柌",
		"濨",
		"珁",
		"瓷",
		"甆",
		"磁",
		"礠",
		"祠",
		"糍",
		"茨",
		"詞",
		"词",
		"辝",
		"辞",
		"辤",
		"辭",
		"雌",
		"飺",
		"餈",
		"鴜",
		"鶿",
		"鷀",
		"鹚"
	],
	duī: [
		"垖",
		"堆",
		"塠",
		"痽",
		"磓",
		"鐓",
		"鐜",
		"鴭"
	],
	"duò duǒ": ["垛"],
	"duǒ duò": ["垜", "挆"],
	chá: [
		"垞",
		"察",
		"嵖",
		"搽",
		"槎",
		"檫",
		"猹",
		"茬",
		"茶",
		"詧",
		"靫",
		"𥻗"
	],
	shǎng: [
		"垧",
		"晌",
		"樉",
		"賞",
		"贘",
		"赏",
		"鋿",
		"鏛",
		"鑜"
	],
	shǒu: [
		"垨",
		"守",
		"手",
		"扌",
		"艏",
		"首"
	],
	da: [
		"垯",
		"繨",
		"跶"
	],
	háng: [
		"垳",
		"斻",
		"杭",
		"筕",
		"絎",
		"绗",
		"航",
		"苀",
		"蚢",
		"裄",
		"貥",
		"迒",
		"頏",
		"颃",
		"魧"
	],
	"ān ǎn": ["垵"],
	xīng: [
		"垶",
		"惺",
		"星",
		"曐",
		"煋",
		"猩",
		"瑆",
		"皨",
		"篂",
		"腥",
		"興",
		"觪",
		"觲",
		"謃",
		"騂",
		"骍",
		"鮏",
		"鯹"
	],
	"yuàn huán": ["垸"],
	bāng: [
		"垹",
		"帮",
		"幇",
		"幚",
		"幫",
		"捠",
		"梆",
		"浜",
		"邦",
		"邫",
		"鞤",
		"𠳐"
	],
	"póu fú": ["垺"],
	cén: [
		"埁",
		"岑",
		"涔"
	],
	"běng fēng": ["埄"],
	"dì fáng": ["埅"],
	"xiá jiā": ["埉"],
	"mái mán": ["埋"],
	làng: [
		"埌",
		"崀",
		"浪",
		"蒗",
		"閬",
		"㫰"
	],
	"shān yán": ["埏"],
	"qín jīn": ["埐"],
	"pǔ bù": ["埔"],
	huā: [
		"埖",
		"婲",
		"椛",
		"硴",
		"糀",
		"花",
		"蒊",
		"蘤",
		"誮",
		"錵"
	],
	"suì sù": ["埣"],
	"pí pì": ["埤"],
	"qīng zhēng": ["埥", "鲭"],
	"wǎn wān": ["埦"],
	lǔn: [
		"埨",
		"稐",
		"𫭢"
	],
	"zhēng chéng": ["埩"],
	kōng: [
		"埪",
		"崆",
		"箜",
		"躻",
		"錓",
		"鵼"
	],
	"cǎi cài": [
		"埰",
		"寀",
		"采"
	],
	"chù tòu": ["埱"],
	běng: [
		"埲",
		"琫",
		"菶",
		"鞛"
	],
	"kǎn xiàn": ["埳"],
	"yì shì": ["埶", "醳"],
	péi: [
		"培",
		"毰",
		"裴",
		"裵",
		"賠",
		"赔",
		"錇",
		"锫",
		"阫",
		"陪"
	],
	"sào sǎo": ["埽"],
	"jǐn qīn jìn": ["堇"],
	"péng bèng": ["堋"],
	"qiàn zàn jiàn": ["堑"],
	àn: [
		"堓",
		"屵",
		"岸",
		"按",
		"暗",
		"案",
		"胺",
		"荌",
		"豻",
		"貋",
		"錌",
		"闇",
		"隌",
		"黯"
	],
	"duò huī": ["堕", "墮"],
	huán: [
		"堚",
		"寏",
		"寰",
		"峘",
		"桓",
		"洹",
		"澴",
		"獂",
		"环",
		"環",
		"糫",
		"繯",
		"缳",
		"羦",
		"荁",
		"萈",
		"萑",
		"豲",
		"鍰",
		"鐶",
		"锾",
		"镮",
		"闤",
		"阛",
		"雈",
		"鬟",
		"鹮",
		"𬘫",
		"𤩽"
	],
	"bǎo bǔ pù": ["堡"],
	"máo móu wǔ": ["堥"],
	ruán: [
		"堧",
		"壖",
		"撋"
	],
	"ài è yè": ["堨"],
	gèng: ["堩", "暅"],
	méi: [
		"堳",
		"塺",
		"媒",
		"嵋",
		"徾",
		"攗",
		"枚",
		"栂",
		"梅",
		"楣",
		"楳",
		"槑",
		"湄",
		"湈",
		"煤",
		"猸",
		"玫",
		"珻",
		"瑂",
		"眉",
		"睂",
		"禖",
		"脄",
		"脢",
		"腜",
		"苺",
		"莓",
		"葿",
		"郿",
		"酶",
		"鎇",
		"镅",
		"霉",
		"鶥",
		"鹛",
		"黴"
	],
	dǔ: [
		"堵",
		"琽",
		"睹",
		"笃",
		"篤",
		"覩",
		"賭",
		"赌"
	],
	féng: [
		"堸",
		"綘",
		"艂",
		"逢"
	],
	hèng: ["堼"],
	chūn: [
		"堾",
		"媋",
		"旾",
		"春",
		"暙",
		"杶",
		"椿",
		"槆",
		"橁",
		"櫄",
		"瑃",
		"箺",
		"萅",
		"蝽",
		"輴",
		"鰆",
		"鶞",
		"䲠"
	],
	jiǎng: [
		"塂",
		"奖",
		"奨",
		"奬",
		"桨",
		"槳",
		"獎",
		"耩",
		"膙",
		"蒋",
		"蔣",
		"講",
		"讲",
		"顜"
	],
	huāng: [
		"塃",
		"巟",
		"慌",
		"肓",
		"荒",
		"衁"
	],
	duàn: [
		"塅",
		"断",
		"斷",
		"椴",
		"段",
		"毈",
		"煅",
		"瑖",
		"碫",
		"簖",
		"籪",
		"緞",
		"缎",
		"腶",
		"葮",
		"躖",
		"鍛",
		"锻"
	],
	tǎ: [
		"塔",
		"墖",
		"獭",
		"獺",
		"鮙",
		"鰨",
		"鳎"
	],
	wěng: [
		"塕",
		"奣",
		"嵡",
		"攚",
		"暡",
		"瞈",
		"蓊"
	],
	"sāi sài sè": ["塞"],
	zàng: [
		"塟",
		"弉",
		"臓",
		"臟",
		"葬",
		"蔵",
		"銺"
	],
	tián: [
		"塡",
		"屇",
		"恬",
		"沺",
		"湉",
		"璳",
		"甛",
		"甜",
		"田",
		"畋",
		"畑",
		"碵",
		"磌",
		"胋",
		"闐",
		"阗",
		"鴫",
		"鷆",
		"鷏"
	],
	zhèng: [
		"塣",
		"幁",
		"政",
		"証",
		"諍",
		"證",
		"证",
		"诤",
		"郑",
		"鄭",
		"靕",
		"鴊"
	],
	"tián zhèn": ["填"],
	wēn: [
		"塭",
		"昷",
		"榲",
		"殟",
		"温",
		"溫",
		"瑥",
		"瘟",
		"蕰",
		"豱",
		"輼",
		"轀",
		"辒",
		"鎾",
		"饂",
		"鰛",
		"鰮",
		"鳁"
	],
	liù: [
		"塯",
		"廇",
		"磟",
		"翏",
		"雡",
		"霤",
		"餾",
		"鬸",
		"鷚",
		"鹨"
	],
	hǎi: [
		"塰",
		"海",
		"烸",
		"酼",
		"醢"
	],
	lǎng: [
		"塱",
		"朖",
		"朗",
		"朤",
		"烺",
		"蓢",
		"㮾"
	],
	bèng: [
		"塴",
		"揼",
		"泵",
		"甏",
		"綳",
		"蹦",
		"迸",
		"逬",
		"鏰",
		"镚"
	],
	chén: [
		"塵",
		"宸",
		"尘",
		"忱",
		"敐",
		"敶",
		"晨",
		"曟",
		"栕",
		"樄",
		"沉",
		"煁",
		"瘎",
		"臣",
		"茞",
		"莀",
		"莐",
		"蔯",
		"薼",
		"螴",
		"訦",
		"諶",
		"軙",
		"辰",
		"迧",
		"鈂",
		"陈",
		"陳",
		"霃",
		"鷐",
		"麎"
	],
	"ōu qiū": ["塸"],
	"qiàn jiàn": ["塹"],
	"zhuān tuán": ["塼"],
	shuǎng: [
		"塽",
		"慡",
		"漺",
		"爽",
		"縔",
		"鏯"
	],
	shú: [
		"塾",
		"婌",
		"孰",
		"璹",
		"秫",
		"贖",
		"赎"
	],
	lǒu: [
		"塿",
		"嵝",
		"嶁",
		"甊",
		"篓",
		"簍"
	],
	chí: [
		"墀",
		"弛",
		"持",
		"池",
		"漦",
		"竾",
		"筂",
		"箎",
		"篪",
		"茌",
		"荎",
		"蚳",
		"謘",
		"貾",
		"赿",
		"踟",
		"迟",
		"迡",
		"遅",
		"遟",
		"遲",
		"鍉",
		"馳",
		"驰"
	],
	shù: [
		"墅",
		"庶",
		"庻",
		"怷",
		"恕",
		"戍",
		"束",
		"树",
		"樹",
		"沭",
		"漱",
		"潄",
		"濖",
		"竖",
		"竪",
		"絉",
		"腧",
		"荗",
		"蒁",
		"虪",
		"術",
		"裋",
		"豎",
		"述",
		"鉥",
		"錰",
		"鏣",
		"霔",
		"鶐",
		"𬬸"
	],
	"dì zhì": ["墆", "疐"],
	kàn: [
		"墈",
		"崁",
		"瞰",
		"矙",
		"磡",
		"衎",
		"鬫"
	],
	chěn: [
		"墋",
		"夦",
		"硶",
		"碜",
		"磣",
		"贂",
		"趻",
		"踸",
		"鍖"
	],
	"zhǐ zhuó": ["墌"],
	qiǎng: [
		"墏",
		"繈",
		"繦",
		"羥",
		"襁"
	],
	zēng: [
		"増",
		"增",
		"憎",
		"璔",
		"矰",
		"磳",
		"罾",
		"譄",
		"鄫",
		"鱛",
		"䎖"
	],
	qiáng: [
		"墙",
		"墻",
		"嫱",
		"嬙",
		"樯",
		"檣",
		"漒",
		"牆",
		"艢",
		"蔃",
		"蔷",
		"蘠"
	],
	"kuài tuí": ["墤"],
	"tuǎn dǒng": ["墥"],
	"qiáo què": ["墧"],
	"zūn dūn": ["墫"],
	"qiāo áo": ["墽"],
	"yì tú": ["墿"],
	"xué bó jué": ["壆"],
	lǎn: [
		"壈",
		"嬾",
		"孄",
		"孏",
		"懒",
		"懶",
		"揽",
		"擥",
		"攬",
		"榄",
		"欖",
		"浨",
		"漤",
		"灠",
		"纜",
		"缆",
		"罱",
		"覧",
		"覽",
		"览",
		"醂",
		"顲"
	],
	huài: [
		"壊",
		"壞",
		"蘾"
	],
	rǎng: [
		"壌",
		"壤",
		"攘",
		"爙"
	],
	"làn xiàn": ["壏"],
	dǎo: [
		"壔",
		"导",
		"導",
		"岛",
		"島",
		"嶋",
		"嶌",
		"嶹",
		"捣",
		"搗",
		"擣",
		"槝",
		"祷",
		"禂",
		"禱",
		"蹈",
		"陦",
		"隝",
		"隯"
	],
	ruǐ: [
		"壡",
		"桵",
		"橤",
		"繠",
		"蕊",
		"蕋",
		"蘂",
		"蘃"
	],
	san: ["壭"],
	zhuàng: [
		"壮",
		"壯",
		"壵",
		"撞",
		"焋",
		"状",
		"狀"
	],
	"ké qiào": ["壳", "殼"],
	kǔn: [
		"壸",
		"壼",
		"悃",
		"捆",
		"梱",
		"硱",
		"祵",
		"稇",
		"稛",
		"綑",
		"裍",
		"閫",
		"閸",
		"阃"
	],
	mǎng: [
		"壾",
		"漭",
		"茻",
		"莽",
		"莾",
		"蠎"
	],
	cún: ["壿", "存"],
	"zhǐ zhōng": ["夂"],
	"gǔ yíng": ["夃"],
	"jiàng xiáng": ["夅", "降"],
	"páng féng fēng": ["夆"],
	zhāi: [
		"夈",
		"捚",
		"摘",
		"斋",
		"斎",
		"榸",
		"粂",
		"齋"
	],
	"xuàn xiòng": ["夐"],
	wài: ["外", "顡"],
	"wǎn yuàn wān yuān": ["夗"],
	"mǎo wǎn": ["夘"],
	mèng: [
		"夢",
		"夣",
		"孟",
		"梦",
		"癦",
		"霥"
	],
	"dà dài": ["大"],
	"fū fú": [
		"夫",
		"姇",
		"枎",
		"粰"
	],
	guài: [
		"夬",
		"怪",
		"恠"
	],
	yāng: [
		"央",
		"姎",
		"抰",
		"殃",
		"泱",
		"秧",
		"胦",
		"鉠",
		"鍈",
		"雵",
		"鴦",
		"鸯"
	],
	"hāng bèn": ["夯"],
	gǎo: [
		"夰",
		"搞",
		"杲",
		"槀",
		"槁",
		"檺",
		"稁",
		"稾",
		"稿",
		"縞",
		"缟",
		"菒",
		"藁",
		"藳"
	],
	"tāo běn": ["夲"],
	"tóu tou": ["头"],
	"yǎn tāo": ["夵"],
	"kuā kuà": ["夸", "誇"],
	"jiá jiā gā xiá": ["夹"],
	huà: [
		"夻",
		"婳",
		"嫿",
		"嬅",
		"崋",
		"摦",
		"杹",
		"枠",
		"桦",
		"槬",
		"樺",
		"澅",
		"画",
		"畫",
		"畵",
		"繣",
		"舙",
		"話",
		"諙",
		"譮",
		"话",
		"黊"
	],
	"jiā jiá gā xiá": ["夾"],
	ēn: [
		"奀",
		"恩",
		"蒽"
	],
	"dī tì": ["奃"],
	"yǎn yān": ["奄", "渰"],
	pào: [
		"奅",
		"疱",
		"皰",
		"砲",
		"礟",
		"礮",
		"靤",
		"麭"
	],
	nài: [
		"奈",
		"柰",
		"渿",
		"耐",
		"萘",
		"褦",
		"錼",
		"鼐"
	],
	"quān juàn": [
		"奍",
		"弮",
		"棬"
	],
	zòu: ["奏", "揍"],
	"qì qiè xiè": ["契"],
	kāi: [
		"奒",
		"开",
		"揩",
		"鐦",
		"锎",
		"開"
	],
	"bēn bèn": ["奔", "泍"],
	tào: ["套"],
	"zàng zhuǎng": ["奘"],
	běn: [
		"奙",
		"本",
		"楍",
		"畚",
		"翉",
		"苯"
	],
	"xùn zhuì": ["奞"],
	shē: [
		"奢",
		"檨",
		"猞",
		"畭",
		"畲",
		"賒",
		"賖",
		"赊",
		"輋",
		"𪨶"
	],
	"hǎ pò tǎi": ["奤"],
	"ào yù": [
		"奥",
		"奧",
		"澚"
	],
	yūn: [
		"奫",
		"氲",
		"氳",
		"蒀",
		"蒕",
		"蝹",
		"贇",
		"赟",
		"𫖳"
	],
	"duǒ chě": ["奲"],
	"nǚ rǔ": ["女"],
	nú: [
		"奴",
		"孥",
		"笯",
		"駑",
		"驽"
	],
	"dīng dǐng tiǎn": ["奵"],
	"tā jiě": ["她"],
	nuán: ["奻"],
	"hǎo hào": ["好"],
	fàn: [
		"奿",
		"嬎",
		"梵",
		"汎",
		"泛",
		"滼",
		"瀪",
		"犯",
		"畈",
		"盕",
		"笵",
		"範",
		"范",
		"訉",
		"販",
		"贩",
		"軬",
		"輽",
		"飯",
		"飰",
		"饭"
	],
	shuò: [
		"妁",
		"搠",
		"朔",
		"槊",
		"烁",
		"爍",
		"矟",
		"蒴",
		"鎙",
		"鑠",
		"铄"
	],
	"fēi pèi": ["妃"],
	wàng: [
		"妄",
		"忘",
		"旺",
		"望",
		"朢"
	],
	zhuāng: [
		"妆",
		"妝",
		"娤",
		"庄",
		"庒",
		"桩",
		"梉",
		"樁",
		"粧",
		"糚",
		"荘",
		"莊",
		"装",
		"裝"
	],
	mā: ["妈", "媽"],
	"fū yōu": ["妋"],
	"hài jiè": ["妎"],
	dù: [
		"妒",
		"妬",
		"杜",
		"殬",
		"渡",
		"秺",
		"芏",
		"荰",
		"螙",
		"蠧",
		"蠹",
		"鍍",
		"镀",
		"靯",
		"𬭊"
	],
	miào: [
		"妙",
		"庙",
		"庿",
		"廟",
		"玅",
		"竗"
	],
	"fǒu pēi pī": ["妚"],
	"yuè jué": ["妜"],
	niū: ["妞"],
	"nà nàn": ["妠"],
	tuǒ: [
		"妥",
		"嫷",
		"庹",
		"椭",
		"楕",
		"橢",
		"鬌",
		"鰖",
		"鵎"
	],
	"wàn yuán": ["妧"],
	fáng: [
		"妨",
		"房",
		"肪",
		"防",
		"魴",
		"鲂"
	],
	nī: ["妮"],
	zhóu: ["妯", "碡"],
	zhāo: [
		"妱",
		"巶",
		"招",
		"昭",
		"釗",
		"鉊",
		"鍣",
		"钊",
		"駋",
		"𬬿"
	],
	"nǎi nǐ": ["妳"],
	tǒu: [
		"妵",
		"敨",
		"紏",
		"蘣",
		"黈"
	],
	"xián xuán xù": ["妶"],
	"zhí yì": ["妷", "秇"],
	ē: [
		"妸",
		"妿",
		"婀",
		"屙"
	],
	mèi: [
		"妹",
		"媚",
		"寐",
		"抺",
		"旀",
		"昧",
		"沬",
		"煝",
		"痗",
		"眛",
		"睸",
		"祙",
		"篃",
		"蝞",
		"袂",
		"跊",
		"鬽",
		"魅"
	],
	"qī qì": ["妻"],
	"xū xǔ": ["姁", "稰"],
	"shān shàn": [
		"姍",
		"姗",
		"苫",
		"釤",
		"钐"
	],
	mán: [
		"姏",
		"慲",
		"樠",
		"蛮",
		"蠻",
		"謾",
		"饅",
		"馒",
		"鬗",
		"鬘",
		"鰻",
		"鳗"
	],
	jiě: [
		"姐",
		"媎",
		"檞",
		"毑",
		"飷"
	],
	"wěi wēi": ["委"],
	pīn: [
		"姘",
		"拼",
		"礗",
		"穦",
		"馪",
		"驞"
	],
	"huá huó": ["姡"],
	"jiāo xiáo": ["姣"],
	"gòu dù": ["姤"],
	"lǎo mǔ": ["姥"],
	"nián niàn": ["姩"],
	zhěn: [
		"姫",
		"屒",
		"弫",
		"抮",
		"昣",
		"枕",
		"畛",
		"疹",
		"眕",
		"稹",
		"縝",
		"縥",
		"缜",
		"聄",
		"萙",
		"袗",
		"裖",
		"覙",
		"診",
		"诊",
		"軫",
		"轸",
		"辴",
		"駗",
		"鬒"
	],
	héng: [
		"姮",
		"恆",
		"恒",
		"烆",
		"珩",
		"胻",
		"蘅",
		"衡",
		"鑅",
		"鴴",
		"鵆",
		"鸻"
	],
	"jūn xún": ["姰"],
	"kuā hù": ["姱"],
	"è yà": ["姶"],
	"xiān shēn": ["姺"],
	wá: ["娃"],
	"ráo rǎo": ["娆", "嬈"],
	"shào shāo": ["娋"],
	xiē: [
		"娎",
		"揳",
		"楔",
		"歇",
		"蝎",
		"蠍"
	],
	"wǔ méi mǔ": ["娒"],
	"chuò lài": ["娕"],
	niáng: [
		"娘",
		"嬢",
		"孃"
	],
	"nà nuó": ["娜", "𦰡"],
	"pōu bǐ": ["娝"],
	"něi suī": ["娞"],
	tuì: [
		"娧",
		"煺",
		"蛻",
		"蜕",
		"退",
		"駾"
	],
	mǎn: [
		"娨",
		"屘",
		"満",
		"满",
		"滿",
		"螨",
		"蟎",
		"襔",
		"鏋"
	],
	"wú wù yú": ["娪"],
	"xī āi": ["娭"],
	"zhuì shuì": ["娷"],
	"dōng dòng": ["娻"],
	"ǎi ái è": ["娾"],
	"ē ě": ["娿"],
	mián: [
		"婂",
		"嬵",
		"宀",
		"杣",
		"棉",
		"檰",
		"櫋",
		"眠",
		"矈",
		"矊",
		"矏",
		"綿",
		"緜",
		"绵",
		"芇",
		"蝒"
	],
	"pǒu péi bù": ["婄"],
	biǎo: [
		"婊",
		"脿",
		"表",
		"裱",
		"褾",
		"諘",
		"錶"
	],
	"fù fàn": ["婏"],
	wǒ: [
		"婐",
		"婑",
		"我"
	],
	"ní nǐ": ["婗", "棿"],
	"quán juàn": ["婘", "惓"],
	hūn: [
		"婚",
		"昏",
		"昬",
		"棔",
		"涽",
		"睧",
		"睯",
		"碈",
		"荤",
		"葷",
		"蔒",
		"轋",
		"閽",
		"阍"
	],
	"qiān jǐn": ["婜"],
	"wān wà": ["婠"],
	"lái lài": [
		"婡",
		"徕",
		"徠"
	],
	"zhōu chōu": ["婤"],
	"chuò nào": ["婥"],
	"nüè àn": ["婩"],
	"hùn kūn": ["婫"],
	"dàng yáng": ["婸"],
	nàn: ["婻"],
	"ruò chuò": ["婼"],
	jiǎ: [
		"婽",
		"岬",
		"斚",
		"斝",
		"榎",
		"槚",
		"檟",
		"玾",
		"甲",
		"胛",
		"鉀",
		"钾"
	],
	"tōu yú": ["婾", "媮"],
	"yù yú": ["媀"],
	"wéi wěi": ["媁"],
	"dì tí": [
		"媂",
		"珶",
		"苐"
	],
	róu: [
		"媃",
		"揉",
		"柔",
		"渘",
		"煣",
		"瑈",
		"瓇",
		"禸",
		"粈",
		"糅",
		"脜",
		"腬",
		"葇",
		"蝚",
		"蹂",
		"輮",
		"鍒",
		"鞣",
		"騥",
		"鰇",
		"鶔",
		"𫐓"
	],
	"ruǎn nèn": ["媆"],
	miáo: [
		"媌",
		"嫹",
		"描",
		"瞄",
		"苗",
		"鶓",
		"鹋"
	],
	"yí pèi": ["媐"],
	"mián miǎn": ["媔"],
	"tí shì": ["媞", "惿"],
	"duò tuó": ["媠", "沲"],
	ǎo: [
		"媪",
		"媼",
		"艹",
		"芺",
		"袄",
		"襖",
		"镺"
	],
	"chú zòu": ["媰"],
	yìng: [
		"媵",
		"映",
		"暎",
		"硬",
		"膡",
		"鱦"
	],
	"qín shēn": ["嫀"],
	jià: [
		"嫁",
		"幏",
		"架",
		"榢",
		"稼",
		"駕",
		"驾"
	],
	sǎo: ["嫂"],
	"zhēn zhěn": ["嫃"],
	"jiē suǒ": ["嫅"],
	"míng mǐng": ["嫇"],
	niǎo: [
		"嫋",
		"嬝",
		"嬲",
		"茑",
		"蔦",
		"袅",
		"裊",
		"褭",
		"鸟"
	],
	tāo: [
		"嫍",
		"幍",
		"弢",
		"慆",
		"掏",
		"搯",
		"槄",
		"涛",
		"滔",
		"濤",
		"瑫",
		"絛",
		"縚",
		"縧",
		"绦",
		"詜",
		"謟",
		"轁",
		"鞱",
		"韜",
		"韬",
		"飸",
		"饕"
	],
	biáo: ["嫑"],
	"piáo piāo": ["嫖", "薸"],
	xuán: [
		"嫙",
		"悬",
		"懸",
		"暶",
		"檈",
		"漩",
		"玄",
		"璇",
		"璿",
		"痃",
		"蜁",
		"𫠊"
	],
	"màn mān": ["嫚"],
	kāng: [
		"嫝",
		"嵻",
		"康",
		"慷",
		"槺",
		"漮",
		"砊",
		"穅",
		"糠",
		"躿",
		"鏮",
		"鱇",
		"𡐓",
		"𩾌"
	],
	"hān nǎn": ["嫨"],
	nèn: ["嫩", "嫰"],
	zhē: ["嫬", "遮"],
	"mā má": ["嫲"],
	piè: ["嫳"],
	zhǎn: [
		"嫸",
		"展",
		"搌",
		"斩",
		"斬",
		"琖",
		"盏",
		"盞",
		"輾",
		"醆",
		"颭",
		"飐"
	],
	"xiān yǎn jìn": ["嬐"],
	liǎn: [
		"嬚",
		"敛",
		"斂",
		"琏",
		"璉",
		"羷",
		"脸",
		"臉",
		"蔹",
		"蘝",
		"蘞",
		"裣",
		"襝",
		"鄻"
	],
	"qióng huán xuān": ["嬛"],
	dǒng: [
		"嬞",
		"懂",
		"箽",
		"董",
		"蕫",
		"諌"
	],
	cān: [
		"嬠",
		"湌",
		"爘",
		"飡",
		"餐",
		"驂",
		"骖"
	],
	tiǎo: [
		"嬥",
		"宨",
		"晀",
		"朓",
		"窱",
		"脁"
	],
	bí: [
		"嬶",
		"荸",
		"鼻"
	],
	liǔ: [
		"嬼",
		"柳",
		"栁",
		"桞",
		"桺",
		"橮",
		"熮",
		"珋",
		"綹",
		"绺",
		"罶",
		"羀",
		"鋶",
		"锍"
	],
	"qiān xiān": ["孅", "欦"],
	"xié huī": ["孈"],
	"huān quán": ["孉"],
	"lí lì": ["孋", "麗"],
	"zhú chuò": ["孎"],
	kǒng: ["孔", "恐"],
	"mā zī": ["孖"],
	"sūn xùn": ["孙", "孫"],
	"bèi bó": ["孛", "誖"],
	"yòu niū": ["孧"],
	zhuǎn: [
		"孨",
		"竱",
		"轉"
	],
	hái: ["孩", "骸"],
	nāo: ["孬"],
	"chán càn": ["孱"],
	bò: [
		"孹",
		"檗",
		"蘗",
		"譒"
	],
	nái: ["孻", "腉"],
	"níng nìng": [
		"宁",
		"寍",
		"寗",
		"寜",
		"寧",
		"甯"
	],
	zhái: ["宅"],
	"tū jiā": ["宊"],
	sòng: [
		"宋",
		"訟",
		"誦",
		"讼",
		"诵",
		"送",
		"鎹",
		"頌",
		"颂",
		"餸"
	],
	ròu: [
		"宍",
		"肉",
		"譳"
	],
	zhūn: [
		"宒",
		"窀",
		"衠",
		"諄",
		"谆",
		"迍"
	],
	"mì fú": ["宓"],
	"dàng tàn": ["宕"],
	"wǎn yuān": ["宛"],
	chǒng: ["宠", "寵"],
	qún: [
		"宭",
		"峮",
		"帬",
		"羣",
		"群",
		"裙",
		"裠"
	],
	zǎi: ["宰", "崽"],
	"bǎo shí": ["宲"],
	"jiā jia jie": ["家"],
	"huāng huǎng": ["宺"],
	kuān: [
		"宽",
		"寛",
		"寬",
		"臗",
		"鑧",
		"髋",
		"髖"
	],
	"sù xiǔ xiù": ["宿"],
	"jié zǎn": ["寁"],
	"bìng bǐng": ["寎"],
	"jìn qǐn": ["寖"],
	"lóu jù": ["寠"],
	"xiě xiè": ["寫"],
	"qīn qìn": ["寴"],
	cùn: ["寸", "籿"],
	duì: [
		"对",
		"対",
		"對",
		"怼",
		"憝",
		"懟",
		"濧",
		"瀩",
		"碓",
		"祋",
		"綐",
		"薱",
		"譈",
		"譵",
		"轛",
		"队",
		"陮"
	],
	"lüè luó": ["寽"],
	"shè yè yì": ["射"],
	"jiāng jiàng qiāng": ["将"],
	"jiāng jiàng": [
		"將",
		"浆",
		"漿",
		"畺"
	],
	zūn: [
		"尊",
		"嶟",
		"樽",
		"罇",
		"遵",
		"鐏",
		"鱒",
		"鳟",
		"鶎",
		"鷷",
		"𨱔"
	],
	"shù zhù": ["尌", "澍"],
	xiǎo: [
		"小",
		"晓",
		"暁",
		"曉",
		"皛",
		"皢",
		"筱",
		"筿",
		"篠",
		"謏",
		"𫍲"
	],
	"jié jí": [
		"尐",
		"诘",
		"鞊"
	],
	"shǎo shào": ["少"],
	ěr: [
		"尒",
		"尓",
		"尔",
		"栮",
		"毦",
		"洱",
		"爾",
		"珥",
		"耳",
		"薾",
		"衈",
		"趰",
		"迩",
		"邇",
		"鉺",
		"铒",
		"餌",
		"饵",
		"駬"
	],
	"wāng yóu": ["尢"],
	wāng: [
		"尣",
		"尩",
		"尪",
		"尫",
		"汪"
	],
	liào: [
		"尥",
		"尦",
		"廖",
		"撂",
		"料",
		"炓",
		"窷",
		"鐐",
		"镣",
		"𪤗"
	],
	"méng máng lóng páng": ["尨"],
	gà: ["尬", "魀"],
	"kuì kuǐ": ["尯"],
	tuí: [
		"尵",
		"弚",
		"穨",
		"蘈",
		"蹪",
		"隤",
		"頹",
		"頺",
		"頽",
		"颓",
		"魋",
		"𬯎"
	],
	yǐn: [
		"尹",
		"嶾",
		"引",
		"朄",
		"檃",
		"檼",
		"櫽",
		"淾",
		"濥",
		"瘾",
		"癮",
		"粌",
		"蘟",
		"蚓",
		"螾",
		"讔",
		"赺",
		"趛",
		"輑",
		"鈏",
		"靷"
	],
	"chǐ chě": ["尺"],
	kāo: ["尻", "髛"],
	"jìn jǐn": ["尽"],
	"wěi yǐ": ["尾"],
	"niào suī": ["尿"],
	céng: [
		"层",
		"層",
		"嶒",
		"驓"
	],
	diǎo: ["屌"],
	"píng bǐng bīng": ["屏"],
	lòu: [
		"屚",
		"漏",
		"瘘",
		"瘺",
		"瘻",
		"鏤",
		"镂",
		"陋"
	],
	"shǔ zhǔ": ["属", "屬"],
	"xiè tì": ["屟"],
	"chè cǎo": ["屮"],
	"tún zhūn": ["屯"],
	"nì jǐ": ["屰"],
	"hóng lóng": ["屸"],
	"qǐ kǎi": ["岂", "豈"],
	áng: [
		"岇",
		"昂",
		"昻"
	],
	"gǎng gāng": ["岗", "崗"],
	kě: [
		"岢",
		"敤",
		"渇",
		"渴",
		"炣"
	],
	gǒu: [
		"岣",
		"狗",
		"玽",
		"笱",
		"耇",
		"耈",
		"耉",
		"苟",
		"豿"
	],
	tiáo: [
		"岧",
		"岹",
		"樤",
		"祒",
		"笤",
		"芀",
		"萔",
		"蓚",
		"蓨",
		"蜩",
		"迢",
		"鋚",
		"鎥",
		"鞗",
		"髫",
		"鯈",
		"鰷",
		"鲦",
		"齠",
		"龆"
	],
	"qū jū": ["岨"],
	lǐng: [
		"岭",
		"嶺",
		"領",
		"领"
	],
	pò: [
		"岶",
		"敀",
		"洦",
		"湐",
		"烞",
		"珀",
		"破",
		"砶",
		"粕",
		"蒪",
		"魄"
	],
	"bā kè": ["峇"],
	luò: [
		"峈",
		"摞",
		"洛",
		"洜",
		"犖",
		"珞",
		"笿",
		"纙",
		"荦",
		"詻",
		"雒",
		"駱",
		"骆",
		"鵅"
	],
	"fù niè": ["峊"],
	ěn: ["峎"],
	"zhì shì": ["峙", "崻"],
	qiǎ: [
		"峠",
		"跒",
		"酠",
		"鞐"
	],
	"qiáo jiào": ["峤", "癄"],
	"xié yé": ["峫"],
	bū: [
		"峬",
		"庯",
		"晡",
		"誧",
		"逋",
		"鈽",
		"錻",
		"钸",
		"餔",
		"鵏"
	],
	chóng: [
		"崇",
		"崈",
		"爞",
		"虫",
		"蝩",
		"蟲",
		"褈",
		"隀"
	],
	"zú cuì": ["崒", "椊"],
	"líng léng": ["崚"],
	"dòng dōng": ["崠"],
	xiáo: [
		"崤",
		"洨",
		"淆",
		"訤",
		"誵"
	],
	"pí bǐ": ["崥", "芘"],
	"zhǎn chán": [
		"崭",
		"嶃",
		"嶄"
	],
	"wǎi wēi": ["崴"],
	"yáng dàng": ["崵"],
	"shì dié": ["崼"],
	yào: [
		"崾",
		"曜",
		"熎",
		"燿",
		"矅",
		"穾",
		"窔",
		"筄",
		"耀",
		"艞",
		"药",
		"葯",
		"薬",
		"藥",
		"袎",
		"覞",
		"詏",
		"讑",
		"靿",
		"鷂",
		"鹞",
		"鼼"
	],
	"kān zhàn": ["嵁"],
	"hán dǎng": ["嵅"],
	"qiàn kàn": ["嵌"],
	"wù máo": ["嵍"],
	"kě jié": ["嵑", "嶱"],
	"wēi wěi": ["嵔"],
	kē: [
		"嵙",
		"柯",
		"棵",
		"榼",
		"樖",
		"牁",
		"牱",
		"犐",
		"珂",
		"疴",
		"瞌",
		"磕",
		"礚",
		"科",
		"稞",
		"窠",
		"萪",
		"薖",
		"蚵",
		"蝌",
		"趷",
		"轲",
		"醘",
		"鈳",
		"钶",
		"頦",
		"顆",
		"颗",
		"髁"
	],
	"dàng táng": ["嵣"],
	"róng yíng": ["嵤", "爃"],
	"ái kǎi": ["嵦"],
	"kāo qiāo": ["嵪"],
	cuó: [
		"嵯",
		"嵳",
		"痤",
		"矬",
		"蒫",
		"蔖",
		"虘",
		"鹺",
		"鹾"
	],
	"qiǎn qīn": ["嵰"],
	"dì dié": ["嵽"],
	cēn: ["嵾"],
	dǐng: [
		"嵿",
		"艼",
		"薡",
		"鐤",
		"頂",
		"顶",
		"鼎",
		"鼑"
	],
	"áo ào": ["嶅"],
	"pǐ pèi": ["嶏"],
	"jiào qiáo": ["嶠", "潐"],
	"jué guì": ["嶡", "鳜"],
	"zhān shàn": ["嶦", "鳣"],
	"xiè jiè": ["嶰"],
	"guī xī juàn": ["嶲"],
	rū: ["嶿"],
	"lì liè": [
		"巁",
		"棙",
		"爄",
		"綟"
	],
	"xī guī juàn": ["巂"],
	"yíng hōng": ["巆"],
	yǐng: [
		"巊",
		"廮",
		"影",
		"摬",
		"梬",
		"潁",
		"瘿",
		"癭",
		"矨",
		"穎",
		"郢",
		"鐛",
		"頴",
		"颍",
		"颕",
		"颖"
	],
	chǎo: [
		"巐",
		"炒",
		"煼",
		"眧",
		"麨"
	],
	cuán: [
		"巑",
		"櫕",
		"欑"
	],
	chuān: [
		"巛",
		"川",
		"氚",
		"瑏",
		"穿"
	],
	"jīng xíng": ["巠"],
	cháo: [
		"巢",
		"巣",
		"晁",
		"漅",
		"潮",
		"牊",
		"窲",
		"罺",
		"謿",
		"轈",
		"鄛",
		"鼌"
	],
	qiǎo: [
		"巧",
		"愀",
		"髜"
	],
	gǒng: [
		"巩",
		"廾",
		"拱",
		"拲",
		"栱",
		"汞",
		"珙",
		"輁",
		"鞏"
	],
	"chà chā chāi cī": ["差"],
	"xiàng hàng": ["巷"],
	shuài: [
		"帅",
		"帥",
		"蟀"
	],
	pà: [
		"帊",
		"帕",
		"怕",
		"袙"
	],
	"tǎng nú": ["帑"],
	"mò wà": ["帓"],
	"tiē tiě tiè": ["帖"],
	zhǒu: [
		"帚",
		"晭",
		"疛",
		"睭",
		"箒",
		"肘",
		"菷",
		"鯞"
	],
	"juǎn juàn": ["帣"],
	shuì: [
		"帨",
		"涗",
		"涚",
		"睡",
		"稅",
		"税",
		"裞"
	],
	"chóu dào": ["帱", "幬"],
	"jiǎn jiān sàn": ["帴"],
	"shà qiè": ["帹"],
	"qí jì": ["帺", "荠"],
	"shān qiāo shēn": ["幓"],
	"zhuàng chuáng": ["幢"],
	"chān chàn": ["幨"],
	miè: [
		"幭",
		"懱",
		"搣",
		"滅",
		"灭",
		"烕",
		"礣",
		"篾",
		"蔑",
		"薎",
		"蠛",
		"衊",
		"鑖",
		"鱴",
		"鴓"
	],
	"gān gàn": ["干"],
	"bìng bīng": ["并", "幷"],
	"jī jǐ": ["幾"],
	"guǎng ān": ["广"],
	guǎng: [
		"広",
		"廣",
		"犷",
		"獷"
	],
	me: ["庅"],
	"dùn tún": ["庉"],
	"bài tīng": ["庍"],
	"yìng yīng": ["应"],
	"dǐ de": ["底"],
	"dù duó": ["度"],
	"máng méng páng": ["庬"],
	"bìng píng": ["庰"],
	chěng: [
		"庱",
		"悜",
		"睈",
		"逞",
		"騁",
		"骋"
	],
	"jī cuò": ["庴"],
	qǐng: [
		"庼",
		"廎",
		"檾",
		"漀",
		"苘",
		"請",
		"謦",
		"请",
		"頃",
		"顷"
	],
	"guī wěi huì": ["廆"],
	"jǐn qín": ["廑"],
	kuò: [
		"廓",
		"扩",
		"拡",
		"擴",
		"濶",
		"筈",
		"萿",
		"葀",
		"蛞",
		"闊",
		"阔",
		"霩",
		"鞟",
		"鞹",
		"韕",
		"頢",
		"鬠"
	],
	"qiáng sè": ["廧", "薔"],
	"yǐn yìn": [
		"廴",
		"隐",
		"隠",
		"隱",
		"飮",
		"飲",
		"饮"
	],
	"pò pǎi": ["廹", "迫"],
	"nòng lòng": ["弄"],
	"dì tì tuí": ["弟"],
	"jué zhāng": ["弡"],
	"mí mǐ": [
		"弥",
		"彌",
		"靡"
	],
	chāo: [
		"弨",
		"怊",
		"抄",
		"欩",
		"訬",
		"超",
		"鈔",
		"钞"
	],
	yi: ["弬"],
	shāo: [
		"弰",
		"旓",
		"烧",
		"焼",
		"燒",
		"筲",
		"艄",
		"萷",
		"蕱",
		"輎",
		"髾",
		"鮹"
	],
	"xuān yuān": ["弲"],
	"qiáng qiǎng jiàng": ["強", "强"],
	"tán dàn": ["弹", "醈"],
	biè: ["彆"],
	"qiáng jiàng qiǎng": ["彊"],
	"jì xuě": ["彐"],
	tuàn: ["彖", "褖"],
	yuē: [
		"彟",
		"曰",
		"曱",
		"矱"
	],
	"shān xiǎn": ["彡"],
	wén: [
		"彣",
		"文",
		"炆",
		"珳",
		"瘒",
		"繧",
		"聞",
		"芠",
		"蚉",
		"蚊",
		"螡",
		"蟁",
		"閺",
		"閿",
		"闅",
		"闦",
		"闻",
		"阌",
		"雯",
		"馼",
		"駇",
		"魰",
		"鳼",
		"鴍",
		"鼤",
		"𫘜"
	],
	"péng bāng": ["彭"],
	"piāo piào": ["彯"],
	"zhuó bó": ["彴"],
	"tuǒ yí": ["彵"],
	"páng fǎng": ["彷"],
	wǎng: [
		"彺",
		"往",
		"徃",
		"惘",
		"枉",
		"棢",
		"網",
		"网",
		"罒",
		"罓",
		"罔",
		"罖",
		"菵",
		"蛧",
		"蝄",
		"誷",
		"輞",
		"辋",
		"魍"
	],
	cú: ["徂", "殂"],
	"dài dāi": ["待"],
	huái: [
		"徊",
		"怀",
		"懐",
		"懷",
		"槐",
		"淮",
		"耲",
		"蘹",
		"褢",
		"褱",
		"踝"
	],
	"wā wàng jiā": ["徍"],
	"chěng zhèng": ["徎"],
	"dé děi de": ["得"],
	"cóng zòng": ["從"],
	"shì tǐ": ["徥"],
	"tí chí": [
		"徲",
		"鶗",
		"鶙"
	],
	dé: [
		"徳",
		"德",
		"恴",
		"悳",
		"惪",
		"淂",
		"鍀",
		"锝"
	],
	"zhǐ zhēng": ["徴", "徵"],
	bié: [
		"徶",
		"癿",
		"莂",
		"蛂",
		"襒",
		"蹩"
	],
	"chōng zhǒng": ["徸"],
	"jiǎo jiào": [
		"徼",
		"笅",
		"筊"
	],
	"lòng lǒng": ["徿"],
	"qú jù": [
		"忂",
		"渠",
		"瞿",
		"螶"
	],
	"dìng tìng": ["忊"],
	gǎi: ["忋", "改"],
	rěn: [
		"忍",
		"栠",
		"栣",
		"秹",
		"稔",
		"綛",
		"荏",
		"荵",
		"躵"
	],
	chàn: [
		"忏",
		"懴",
		"懺",
		"硟",
		"羼",
		"韂",
		"顫"
	],
	tè: [
		"忑",
		"慝",
		"特",
		"蟘",
		"鋱",
		"铽"
	],
	"tè tēi tuī": ["忒"],
	"gān hàn": ["忓", "攼"],
	"yì qì": ["忔"],
	"tài shì": ["忕"],
	"xī liě": ["忚"],
	"yīng yìng": [
		"応",
		"應",
		"譍"
	],
	"mǐn wěn mín": ["忞", "忟"],
	"sōng zhōng": ["忪"],
	"yù shū": ["忬", "悆"],
	"qí shì": ["忯", "耆"],
	"tún zhūn dùn": ["忳"],
	"qián qín": ["忴", "扲"],
	hún: [
		"忶",
		"浑",
		"渾",
		"餛",
		"馄",
		"魂",
		"鼲"
	],
	niǔ: [
		"忸",
		"扭",
		"炄",
		"狃",
		"紐",
		"纽",
		"莥",
		"鈕",
		"钮",
		"靵"
	],
	"kuáng wǎng": ["忹"],
	"kāng hàng": ["忼"],
	"kài xì": ["忾", "愾"],
	òu: ["怄", "慪"],
	"bǎo bào": ["怉"],
	"mín mén": ["怋"],
	"zuò zhà": ["怍"],
	zěn: ["怎"],
	yàng: [
		"怏",
		"恙",
		"样",
		"様",
		"樣",
		"漾",
		"羕",
		"詇"
	],
	"kòu jù": ["怐"],
	"náo niú": ["怓"],
	"zhēng zhèng": [
		"怔",
		"掙",
		"钲",
		"铮"
	],
	"tiē zhān": ["怗"],
	"hù gù": ["怘"],
	"cū jù zū": ["怚"],
	"sī sāi": ["思"],
	"yóu chóu": ["怞"],
	"tū dié": ["怢"],
	"yōu yào": ["怮"],
	xuàn: [
		"怰",
		"昡",
		"楦",
		"泫",
		"渲",
		"炫",
		"琄",
		"眩",
		"碹",
		"絢",
		"縼",
		"繏",
		"绚",
		"蔙",
		"衒",
		"袨",
		"贙",
		"鉉",
		"鏇",
		"铉",
		"镟",
		"颴"
	],
	"xù xuè": ["怴"],
	"bì pī": ["怶"],
	"xī shù": ["怸"],
	"nèn nín": ["恁"],
	"tiāo yáo": ["恌"],
	"xī qī xù": ["恓"],
	"xiào jiǎo": ["恔"],
	"hū kuā": ["恗"],
	nǜ: [
		"恧",
		"朒",
		"衂",
		"衄"
	],
	hèn: ["恨"],
	"dòng tōng": ["恫"],
	"quán zhuān": ["恮"],
	"è wù ě wū": ["恶", "惡"],
	tòng: [
		"恸",
		"慟",
		"憅",
		"痛",
		"衕"
	],
	"yuān juàn": ["悁"],
	"qiāo qiǎo": ["悄"],
	"jiè kè": ["悈"],
	"hào jiào": ["悎"],
	huǐ: [
		"悔",
		"檓",
		"毀",
		"毁",
		"毇",
		"燬",
		"譭"
	],
	"mán mèn": ["悗", "鞔"],
	"yī yì": ["悘", "衣"],
	quān: [
		"悛",
		"箞",
		"鐉",
		"𨟠"
	],
	"kuī lǐ": ["悝"],
	"yì niàn": ["悥"],
	"mèn mēn": ["悶"],
	guàn: [
		"悹",
		"悺",
		"惯",
		"慣",
		"掼",
		"摜",
		"樌",
		"欟",
		"泴",
		"涫",
		"潅",
		"灌",
		"爟",
		"瓘",
		"盥",
		"礶",
		"祼",
		"罆",
		"罐",
		"貫",
		"贯",
		"躀",
		"遦",
		"鏆",
		"鑵",
		"鱹",
		"鸛",
		"鹳"
	],
	"kōng kǒng": ["悾"],
	"lǔn lùn": ["惀"],
	guǒ: [
		"惈",
		"果",
		"椁",
		"槨",
		"粿",
		"綶",
		"菓",
		"蜾",
		"裹",
		"褁",
		"輠",
		"餜",
		"馃"
	],
	"yuān wǎn": ["惌", "箢"],
	"lán lín": ["惏"],
	"yù xù": ["惐", "淢"],
	"chuò chuì": ["惙"],
	"hūn mèn": ["惛"],
	"chǎng tǎng": ["惝"],
	"suǒ ruǐ": ["惢"],
	cǎn: [
		"惨",
		"慘",
		"憯",
		"黪",
		"黲",
		"䅟"
	],
	cán: [
		"惭",
		"慙",
		"慚",
		"残",
		"殘",
		"蚕",
		"蝅",
		"蠶",
		"蠺"
	],
	"dàn dá": ["惮", "憚"],
	rě: ["惹"],
	"yú tōu": ["愉"],
	"kài qì": ["愒"],
	"dàng táng shāng yáng": ["愓"],
	"chén xìn dān": ["愖"],
	"kè qià": ["愘"],
	nuò: [
		"愞",
		"懦",
		"懧",
		"掿",
		"搦",
		"榒",
		"稬",
		"穤",
		"糑",
		"糥",
		"糯",
		"諾",
		"诺",
		"蹃",
		"逽",
		"鍩",
		"锘"
	],
	gǎn: [
		"感",
		"擀",
		"敢",
		"桿",
		"橄",
		"澉",
		"澸",
		"皯",
		"秆",
		"稈",
		"笴",
		"芉",
		"衦",
		"赶",
		"趕",
		"鱤",
		"鳡"
	],
	"còng sōng": ["愡"],
	"sāi sī sǐ": ["愢"],
	"gōng gòng hǒng": ["愩", "慐"],
	"shuò sù": ["愬", "洬"],
	"yáo yào": ["愮"],
	huàng: [
		"愰",
		"曂",
		"榥",
		"滉",
		"皝",
		"皩",
		"鎤",
		"㿠"
	],
	zhěng: [
		"愸",
		"抍",
		"拯",
		"整",
		"晸"
	],
	cǎo: [
		"愺",
		"艸",
		"草",
		"騲"
	],
	"xì xié": ["慀"],
	"cǎo sāo": ["慅"],
	"xù chù": ["慉"],
	"qiè qiàn": ["慊"],
	"cáo cóng": ["慒"],
	"ào áo": ["慠"],
	"lián liǎn": [
		"慩",
		"梿",
		"槤",
		"櫣"
	],
	"jìn qín jǐn": ["慬"],
	"dì chì": ["慸"],
	"zhí zhé": ["慹"],
	"lóu lǚ": ["慺", "鷜"],
	còng: ["憁", "謥"],
	"zhī zhì": [
		"憄",
		"知",
		"織",
		"织"
	],
	chēng: [
		"憆",
		"摚",
		"撐",
		"撑",
		"晿",
		"柽",
		"棦",
		"橕",
		"檉",
		"泟",
		"浾",
		"琤",
		"瞠",
		"碀",
		"緽",
		"罉",
		"蛏",
		"蟶",
		"赪",
		"赬",
		"鏿",
		"鐣",
		"阷",
		"靗",
		"頳",
		"饓"
	],
	biē: [
		"憋",
		"虌",
		"鱉",
		"鳖",
		"鼈",
		"龞"
	],
	"chéng dèng zhèng": ["憕"],
	"xǐ xī": ["憘"],
	"duì dùn tūn": ["憞"],
	"xiāo jiāo": ["憢"],
	"xián xiàn": ["憪"],
	"liáo liǎo": [
		"憭",
		"燎",
		"爎",
		"爒"
	],
	shéng: [
		"憴",
		"縄",
		"繉",
		"繩",
		"绳",
		"譝"
	],
	"náo nǎo náng": ["憹"],
	"jǐng jìng": ["憼"],
	"jǐ jiǎo": ["憿"],
	"xuān huān": ["懁"],
	"cǎo sāo sào": ["懆"],
	mèn: [
		"懑",
		"懣",
		"暪",
		"焖",
		"燜"
	],
	"mèng méng měng": ["懜"],
	"ài yì nǐ": ["懝"],
	"méng měng": [
		"懞",
		"瞢",
		"矒"
	],
	"qí jī jì": ["懠"],
	mǒ: ["懡"],
	"lán xiàn": ["懢"],
	"yōu yǒu": ["懮"],
	"liú liǔ": ["懰", "藰"],
	ràng: [
		"懹",
		"譲",
		"讓",
		"让"
	],
	huān: [
		"懽",
		"欢",
		"歓",
		"歡",
		"獾",
		"讙",
		"貛",
		"酄",
		"驩",
		"鴅",
		"鵍"
	],
	nǎn: [
		"戁",
		"揇",
		"湳",
		"煵",
		"腩",
		"蝻",
		"赧"
	],
	"mí mó": ["戂"],
	"gàng zhuàng": ["戅", "戆"],
	"zhuàng gàng": ["戇"],
	"xū qu": ["戌"],
	"xì hū": [
		"戏",
		"戯",
		"戲"
	],
	"jiá gā": ["戛"],
	zéi: [
		"戝",
		"蠈",
		"賊",
		"贼",
		"鰂",
		"鱡",
		"鲗"
	],
	děng: ["戥", "等"],
	"hū xì": ["戱"],
	chuō: [
		"戳",
		"踔",
		"逴"
	],
	"biǎn piān": ["扁"],
	"shǎng jiōng": ["扄"],
	"shàn shān": ["扇"],
	cái: [
		"才",
		"材",
		"纔",
		"裁",
		"財",
		"财"
	],
	"zhā zā zhá": ["扎"],
	"lè lì cái": ["扐"],
	"bā pá": ["扒"],
	"dǎ dá": ["打"],
	rēng: ["扔"],
	"fǎn fú": ["払"],
	"diǎo dí yuē lì": ["扚"],
	"káng gāng": ["扛"],
	"yū wū": ["扜"],
	"yū wū kū": ["扝"],
	"tuō chǐ yǐ": ["扡"],
	"gǔ jié xì gē": ["扢"],
	dèn: ["扥", "扽"],
	"sǎo sào": ["扫", "掃"],
	rǎo: [
		"扰",
		"擾",
		"隢"
	],
	"xī chā qì": ["扱"],
	"bān pān": ["扳"],
	"bā ào": ["扷"],
	"xī zhé": ["扸"],
	"zhì sǔn kǎn": ["扻"],
	zhǎo: [
		"找",
		"沼",
		"瑵"
	],
	"kuáng wǎng zài": ["抂"],
	"hú gǔ": [
		"抇",
		"鹄",
		"鹘"
	],
	"bǎ bà": ["把"],
	"dǎn shěn": ["抌"],
	"nè nì ruì nà": ["抐"],
	zhuā: [
		"抓",
		"檛",
		"簻",
		"膼",
		"髽"
	],
	póu: ["抔", "裒"],
	"zhé shé zhē": ["折"],
	"póu pōu fū": ["抙", "捊"],
	pāo: [
		"抛",
		"拋",
		"脬",
		"萢"
	],
	"ǎo ào niù": ["抝"],
	"lūn lún": ["抡", "掄"],
	"qiǎng qiāng chēng": ["抢"],
	"zhǐ zhǎi": ["抧"],
	"bù pū": ["抪", "柨"],
	"yǎo tāo": ["抭"],
	"hē hè qiā": ["抲"],
	"nǐ ní": ["抳"],
	"pī pēi": ["抷"],
	"mǒ mò mā": ["抹"],
	chōu: [
		"抽",
		"犨",
		"犫",
		"瘳",
		"篘"
	],
	"jiā yá": ["拁"],
	"fú bì": [
		"拂",
		"畐",
		"鶝"
	],
	zhǎ: [
		"拃",
		"眨",
		"砟",
		"鮺",
		"鲝"
	],
	"dān dàn dǎn": ["担"],
	"chāi cā": ["拆"],
	niān: ["拈", "蔫"],
	"lā lá lǎ là": ["拉"],
	"bàn pàn": ["拌"],
	pāi: ["拍"],
	līn: ["拎"],
	guǎi: [
		"拐",
		"枴",
		"柺"
	],
	"tuò tà zhí": ["拓"],
	"ào ǎo niù": ["拗"],
	"jū gōu": ["拘"],
	"pīn pàn fān": ["拚"],
	"bài bái": ["拜"],
	bài: [
		"拝",
		"敗",
		"稗",
		"粺",
		"薭",
		"贁",
		"败",
		"韛"
	],
	qiá: ["拤"],
	"nǐng níng nìng": ["拧"],
	"zé zhái": ["择", "擇"],
	hén: [
		"拫",
		"痕",
		"鞎"
	],
	"kuò guā": ["括"],
	"jié jiá": ["拮"],
	nǐn: ["拰"],
	shuān: [
		"拴",
		"栓",
		"閂",
		"闩"
	],
	"cún zùn": ["拵"],
	"zā zǎn": ["拶", "桚"],
	kǎo: [
		"拷",
		"攷",
		"栲",
		"烤",
		"考"
	],
	"yí chǐ hài": ["拸"],
	"cè sè chuò": ["拺"],
	"zhuài zhuāi yè": ["拽"],
	"shí shè": ["拾"],
	bāi: ["挀", "掰"],
	"kuò guāng": ["挄"],
	nòng: [
		"挊",
		"挵",
		"齈"
	],
	"jiào jiāo": [
		"挍",
		"敎",
		"教"
	],
	"kuà kū": ["挎"],
	"ná rú": ["挐"],
	"tiāo tiǎo": ["挑"],
	"dié shè": ["挕"],
	liě: ["挘", "毟"],
	"yà yǎ": ["挜", "掗"],
	"wō zhuā": ["挝"],
	"xié jiā": ["挟", "挾"],
	"dǎng dàng": ["挡", "擋"],
	"zhèng zhēng": [
		"挣",
		"正",
		"症"
	],
	"āi ái": ["挨"],
	"tuō shuì": ["挩", "捝"],
	"tǐ tì": ["挮"],
	"suō shā": ["挱"],
	"sā shā suō": ["挲"],
	"kēng qiān": ["挳", "摼"],
	"bàng péng": ["挷"],
	"ruó ruá": ["挼"],
	"jiǎo kù": ["捁"],
	"wǔ wú": ["捂"],
	tǒng: [
		"捅",
		"桶",
		"筒",
		"筩",
		"統",
		"綂",
		"统",
		"㛚"
	],
	"huò chì": ["捇"],
	"tú shū chá": ["捈"],
	"lǚ luō": ["捋"],
	"shāo shào": ["捎", "稍"],
	niē: ["捏", "揑"],
	"shù sǒng sōu": ["捒"],
	"yé yú": ["捓"],
	"jué zhuó": ["捔"],
	"bù pú zhì": ["捗"],
	zùn: ["捘", "銌"],
	lāo: [
		"捞",
		"撈",
		"粩"
	],
	sǔn: [
		"损",
		"損",
		"榫",
		"笋",
		"筍",
		"箰",
		"鎨",
		"隼"
	],
	"wàn wǎn wān yù": ["捥"],
	pěng: [
		"捧",
		"淎",
		"皏"
	],
	shě: ["捨"],
	"fǔ fù bǔ": ["捬"],
	dáo: ["捯"],
	"luò luǒ wǒ": ["捰"],
	"juǎn quán": ["捲"],
	"chēn tiǎn": ["捵"],
	"niǎn niē": ["捻"],
	"ruó wěi ré": ["捼"],
	zuó: [
		"捽",
		"昨",
		"秨",
		"稓",
		"筰",
		"莋",
		"鈼"
	],
	"wò xiá": ["捾"],
	"qìng qiàn": ["掅"],
	"póu pǒu": ["掊"],
	qiā: ["掐", "葜"],
	"pái pǎi": ["排"],
	"qiān wàn": ["掔"],
	"yè yē": ["掖"],
	"niè nǐ yì": ["掜"],
	"huò xù": ["掝"],
	"yàn shàn yǎn": ["掞"],
	"zhěng dìng": ["掟"],
	kòng: ["控", "鞚"],
	tuī: [
		"推",
		"蓷",
		"藬"
	],
	"zōu zhōu chōu": ["掫"],
	tiàn: ["掭", "舚"],
	kèn: [
		"掯",
		"裉",
		"褃"
	],
	pá: [
		"掱",
		"杷",
		"潖",
		"爬",
		"琶",
		"筢"
	],
	"guó guāi": ["掴"],
	"dǎn shàn": ["掸", "撣"],
	"chān xiān càn shǎn": ["掺"],
	sāo: [
		"掻",
		"搔",
		"溞",
		"繅",
		"缫",
		"螦",
		"騒",
		"騷",
		"鰠",
		"鱢",
		"鳋"
	],
	pèng: [
		"掽",
		"椪",
		"槰",
		"碰",
		"踫"
	],
	"zhēng kēng": ["揁"],
	"jiū yóu": ["揂"],
	"jiān jiǎn": ["揃", "籛"],
	"pì chè": ["揊"],
	"sāi zǒng cāi": ["揌"],
	"tí dī dǐ": ["提"],
	"zǒng sōng": ["揔"],
	"huáng yóng": ["揘"],
	"zǎn zuàn": ["揝"],
	"xū jū": ["揟"],
	"ké qiā": ["揢"],
	"chuāi chuǎi chuài tuán zhuī": ["揣"],
	"dì tì": ["揥"],
	"lá là": ["揦"],
	là: [
		"揧",
		"楋",
		"溂",
		"瓎",
		"瘌",
		"翋",
		"臘",
		"蝋",
		"蝲",
		"蠟",
		"辢",
		"辣",
		"鑞",
		"镴",
		"鬎",
		"鯻",
		"𬶟"
	],
	"jiē qì": ["揭"],
	"chòng dǒng": ["揰"],
	"dié shé yè": ["揲"],
	"jiàn qián jiǎn": ["揵"],
	yé: [
		"揶",
		"爷",
		"爺",
		"瑘",
		"鋣",
		"鎁",
		"铘"
	],
	chān: [
		"搀",
		"摻",
		"攙",
		"裧",
		"襜",
		"覘",
		"觇",
		"辿",
		"鋓"
	],
	"gē gé": ["搁", "擱"],
	"lǒu lōu": ["搂", "摟"],
	"chōu zǒu": ["搊"],
	chuāi: ["搋"],
	sūn: [
		"搎",
		"槂",
		"狲",
		"猻",
		"荪",
		"蓀",
		"蕵",
		"薞",
		"飧",
		"飱"
	],
	"róng náng nǎng": ["搑"],
	"péng bàng": ["搒"],
	cuō: [
		"搓",
		"瑳",
		"磋",
		"蹉",
		"遳",
		"醝"
	],
	"kē è": ["搕"],
	"nù nuò nòu": ["搙"],
	"lā xié xiàn": ["搚"],
	qiǔ: ["搝", "糗"],
	"xiǎn xiān": ["搟"],
	"jié zhé": ["搩"],
	"pán bān pó": ["搫"],
	bān: [
		"搬",
		"攽",
		"斑",
		"斒",
		"班",
		"瘢",
		"癍",
		"肦",
		"螁",
		"螌",
		"褩",
		"辬",
		"頒",
		"颁",
		"𨭉"
	],
	"zhì nái": ["搱"],
	"wā wǎ wà": ["搲"],
	huá: [
		"搳",
		"撶",
		"滑",
		"猾",
		"蕐",
		"螖",
		"譁",
		"鏵",
		"铧",
		"驊",
		"骅",
		"鷨"
	],
	"qiāng qiǎng chēng": ["搶"],
	"tián shēn": ["搷"],
	"ná nuò": ["搻"],
	èn: ["摁"],
	"shè niè": ["摄", "攝"],
	bìn: [
		"摈",
		"擯",
		"殡",
		"殯",
		"膑",
		"臏",
		"髌",
		"髕",
		"髩",
		"鬂",
		"鬓",
		"鬢"
	],
	"shā sà shǎi": ["摋"],
	"chǎn sùn": ["摌"],
	"jiū liú liáo jiǎo náo": ["摎"],
	"féng pěng": ["摓"],
	shuāi: ["摔"],
	"dì tú zhí": ["摕"],
	"qì jì chá": ["摖"],
	"sōu sǒng": ["摗"],
	"liǎn liàn": ["摙"],
	"gài xì": ["摡"],
	"hù chū": ["摢"],
	tàng: [
		"摥",
		"烫",
		"燙",
		"鐋"
	],
	"nái zhì": ["摨"],
	"mó mā": ["摩"],
	"jiāng qiàng": ["摪"],
	"áo qiáo": ["摮"],
	"niè chè": ["摰"],
	"mán màn": ["摱"],
	"chàn cán": ["摲"],
	"sè mí sù": ["摵"],
	"biāo biào": ["摽"],
	"juē jué": ["撅"],
	piē: [
		"撆",
		"暼",
		"氕",
		"瞥"
	],
	"piě piē": ["撇"],
	"zǎn zān zēn qián": ["撍"],
	"sā sǎ": ["撒"],
	hòng: [
		"撔",
		"訌",
		"讧",
		"闀",
		"鬨"
	],
	"héng guàng": ["撗"],
	niǎn: [
		"撚",
		"撵",
		"攆",
		"涊",
		"焾",
		"碾",
		"簐",
		"蹍",
		"蹨",
		"躎",
		"輦",
		"辇"
	],
	"chéng zhěng": ["撜"],
	"huī wéi": ["撝"],
	cāo: [
		"撡",
		"操",
		"糙"
	],
	"xiāo sōu": ["撨"],
	"liáo liāo": ["撩"],
	"cuō zuǒ": ["撮"],
	"wěi tuǒ": ["撱"],
	cuān: [
		"撺",
		"攛",
		"汆",
		"蹿",
		"躥",
		"鑹",
		"镩"
	],
	"qiào yāo jī": ["撽"],
	"zhuā wō": ["撾"],
	"lèi léi": ["擂"],
	nǎng: [
		"擃",
		"攮",
		"曩",
		"灢"
	],
	"qíng jǐng": ["擏"],
	kuǎi: [
		"擓",
		"蒯",
		"㧟"
	],
	"pǐ bò": ["擗"],
	"bò bāi": ["擘"],
	"jù jǐ": ["據"],
	mēng: ["擝"],
	"sǒu sòu": ["擞"],
	xǐng: [
		"擤",
		"箵",
		"醒"
	],
	cā: ["擦"],
	"níng nǐng nìng": ["擰"],
	"zhì jié": ["擳"],
	"là liè": ["擸", "爉"],
	"sòu sǒu": ["擻"],
	"lì luò yuè": ["擽"],
	"tī zhāi zhì": ["擿"],
	pān: [
		"攀",
		"潘",
		"眅",
		"萠"
	],
	lèi: [
		"攂",
		"泪",
		"涙",
		"淚",
		"禷",
		"类",
		"纇",
		"蘱",
		"酹",
		"銇",
		"錑",
		"頛",
		"頪",
		"類",
		"颣"
	],
	"cā sǎ": ["攃"],
	"jùn pèi": ["攈"],
	"lì luò": ["攊", "躒"],
	"là lài": ["攋", "櫴"],
	"lú luó": ["攎"],
	"zǎn cuán": ["攒"],
	"xiān jiān": ["攕"],
	"mí mǐ mó": ["攠"],
	"zǎn cuán zàn zuān": ["攢"],
	zuàn: ["攥"],
	"lì shài": ["攦"],
	"lì luǒ": ["攭"],
	"guǐ guì": ["攱"],
	"jī qī yǐ": ["攲"],
	fàng: ["放"],
	"wù móu": ["敄"],
	"chù shōu": ["敊"],
	"gé guó è": ["敋"],
	"duó duì": ["敓", "敚"],
	"duō què": ["敠", "敪"],
	"sàn sǎn": ["散"],
	"dūn duì": ["敦", "镦"],
	"qī yǐ jī": ["敧"],
	"xiào xué": ["敩"],
	"shù shǔ shuò": ["数", "數"],
	"ái zhú": ["敱", "敳"],
	"xiòng xuàn": ["敻"],
	"zhuó zhú": ["斀"],
	"yì dù": ["斁"],
	"lí tái": ["斄"],
	"fěi fēi": ["斐"],
	"yǔ zhōng": ["斔"],
	"dòu dǒu": ["斗"],
	"wò guǎn": ["斡"],
	"tǒu tiǎo": ["斢"],
	dòu: [
		"斣",
		"梪",
		"浢",
		"痘",
		"窦",
		"竇",
		"脰",
		"荳",
		"豆",
		"逗",
		"郖",
		"酘",
		"閗",
		"闘",
		"餖",
		"饾",
		"鬥",
		"鬦",
		"鬪",
		"鬬",
		"鬭"
	],
	"yín zhì": ["斦"],
	"chǎn jiè": ["斺"],
	"wū yū yú": ["於"],
	"yóu liú": ["斿"],
	"páng bàng": ["旁"],
	"máo mào": ["旄"],
	"pī bì": ["旇"],
	"xuán xuàn": ["旋"],
	"wú mó": ["无"],
	zǎo: [
		"早",
		"枣",
		"栆",
		"棗",
		"澡",
		"璪",
		"薻",
		"藻",
		"蚤"
	],
	gā: ["旮"],
	"gàn hàn": ["旰"],
	"tái yīng": ["旲"],
	"xū xù": ["旴"],
	"tūn zhùn": ["旽"],
	"wù wǔ": ["旿"],
	"pò pèi": ["昢"],
	zòng: [
		"昮",
		"猔",
		"疭",
		"瘲",
		"粽",
		"糉",
		"糭",
		"縦"
	],
	ǎi: [
		"昹",
		"毐",
		"矮",
		"蔼",
		"藹",
		"譪",
		"躷",
		"霭",
		"靄"
	],
	"huàng huǎng": ["晃"],
	xuǎn: [
		"晅",
		"癣",
		"癬",
		"选",
		"選"
	],
	"xù kuā": ["晇"],
	hǒng: ["晎"],
	shài: ["晒", "曬"],
	"yūn yùn": ["晕", "煴"],
	"shèng chéng": [
		"晟",
		"椉",
		"盛"
	],
	"jǐng yǐng": ["景"],
	shǎn: [
		"晱",
		"熌",
		"睒",
		"覢",
		"閃",
		"闪",
		"陕",
		"陝"
	],
	"qǐ dù": ["晵"],
	"ǎn àn yǎn": ["晻"],
	"wǎng wàng": ["暀"],
	zàn: [
		"暂",
		"暫",
		"瓉",
		"瓒",
		"瓚",
		"禶",
		"襸",
		"讃",
		"讚",
		"賛",
		"贊",
		"赞",
		"蹔",
		"鄼",
		"錾",
		"鏨",
		"饡"
	],
	"yùn yūn": ["暈"],
	"mín mǐn": ["暋"],
	"dǔ shǔ": ["暏"],
	shǔ: [
		"暑",
		"曙",
		"潻",
		"癙",
		"糬",
		"署",
		"薥",
		"薯",
		"藷",
		"蜀",
		"蠴",
		"襡",
		"襩",
		"鱪",
		"鱰",
		"黍",
		"鼠",
		"鼡"
	],
	"jiǎn lán": ["暕"],
	nuǎn: [
		"暖",
		"煗",
		"餪"
	],
	"bào pù": ["暴"],
	"xī xǐ": ["暿"],
	"pù bào": ["曝", "瀑"],
	"qū qǔ": ["紶"],
	"qǔ qū": ["曲"],
	"gèng gēng": ["更"],
	"hū hù": ["曶", "雽"],
	"zēng céng": ["曽", "橧"],
	"céng zēng": ["曾", "竲"],
	"cǎn qián jiàn": ["朁"],
	"qiè hé": ["朅"],
	"bì pí": [
		"朇",
		"禆",
		"笓",
		"裨"
	],
	"yǒu yòu": ["有"],
	"bān fén": ["朌", "鳻"],
	"fú fù": ["服", "洑"],
	"fěi kū": ["朏", "胐"],
	"qú xù chǔn": ["朐"],
	"juān zuī": ["朘"],
	"huāng máng wáng": ["朚"],
	"qī jī": ["期"],
	"tóng chuáng": ["朣", "橦"],
	zhá: [
		"札",
		"牐",
		"箚",
		"蚻",
		"譗",
		"鍘",
		"铡",
		"閘",
		"闸"
	],
	"zhú shù shú": ["朮"],
	"shù shú zhú": ["术"],
	"zhū shú": ["朱"],
	"pǔ pò pō piáo": ["朴"],
	"dāo tiáo mù": ["朷"],
	"guǐ qiú": ["朹"],
	xiǔ: [
		"朽",
		"滫",
		"潃",
		"糔"
	],
	"chéng chēng": ["朾"],
	zá: [
		"杂",
		"沯",
		"砸",
		"襍",
		"雑",
		"雜",
		"雥",
		"韴"
	],
	"yú wū": ["杅"],
	"gān gǎn": ["杆"],
	"chā chà": ["杈"],
	"shān shā": ["杉"],
	cūn: [
		"村",
		"皴",
		"竴",
		"膥",
		"踆",
		"邨"
	],
	"rèn ér": ["杒", "梕"],
	"sháo biāo": ["杓"],
	"dì duò": ["杕", "枤"],
	"gū gài": ["杚"],
	"yí zhì lí duò": ["杝"],
	"gàng gāng": ["杠"],
	"tiáo tiāo": ["条", "條"],
	"mà mǎ": ["杩"],
	"sì zhǐ xǐ": ["杫"],
	"yuán wán": ["杬", "蚖"],
	"bèi fèi": ["杮"],
	"shū duì": ["杸"],
	"niǔ chǒu": ["杻"],
	"wò yuè": ["枂", "臒"],
	máo: [
		"枆",
		"毛",
		"氂",
		"渵",
		"牦",
		"矛",
		"罞",
		"茅",
		"茆",
		"蝥",
		"蟊",
		"軞",
		"酕",
		"鉾",
		"錨",
		"锚",
		"髦",
		"鶜"
	],
	"pī mì": ["枈"],
	àng: [
		"枊",
		"盎",
		"醠"
	],
	"fāng bìng": ["枋"],
	"hù dǐ": ["枑"],
	xín: [
		"枔",
		"襑",
		"鐔",
		"鬵"
	],
	"yāo yǎo": ["枖"],
	"ě è": ["枙"],
	"zhī qí": ["枝"],
	"cōng zōng": ["枞", "樅"],
	"xiān zhēn": ["枮"],
	"tái sì": ["枱"],
	"gǒu jǔ gōu": ["枸"],
	"bāo fú": ["枹"],
	"yì xiè": ["枻", "栧"],
	"tuó duò": [
		"柁",
		"馱",
		"駄",
		"驮"
	],
	"yí duò lí": ["柂"],
	"nǐ chì": ["柅"],
	"pán bàn": ["柈", "跘"],
	"yǎng yàng yāng yīng": ["柍"],
	"fù fū fǔ": ["柎"],
	"bǎi bó bò": ["柏"],
	mǒu: ["某"],
	"sháo shào": ["柖"],
	zhè: [
		"柘",
		"樜",
		"浙",
		"淛",
		"蔗",
		"蟅",
		"這",
		"鷓",
		"鹧",
		"䗪"
	],
	"yòu yóu": ["柚", "櫾"],
	"guì jǔ": ["柜"],
	"zhà zuò": ["柞"],
	"dié zhì": ["柣", "眰"],
	"zhā zǔ zū": ["柤"],
	"chá zhā": ["查", "査"],
	"āo ào": ["柪", "軪"],
	"bā fú pèi bó biē": ["柭"],
	"duò zuó wù": ["柮"],
	"bì bié": ["柲"],
	"zhù chù": ["柷"],
	"bēi pēi": ["柸"],
	"shì fèi": ["柹"],
	"shān zhà shi cè": ["栅"],
	"lì yuè": ["栎", "櫟"],
	"qì qiè": ["栔", "砌"],
	"qī xī": ["栖", "蹊"],
	"guā kuò": ["栝"],
	"bīng bēn": ["栟"],
	"xiào jiào": ["校"],
	"jiàn zùn": ["栫", "袸"],
	"yǒu yù": ["栯"],
	"hé hú": ["核"],
	gēn: ["根", "跟"],
	"zhī yì": ["栺"],
	"gé gē": ["格"],
	"héng háng": ["桁"],
	"guàng guāng": ["桄"],
	"yí tí": ["桋", "荑"],
	sāng: [
		"桑",
		"桒",
		"槡"
	],
	"jú jié": ["桔"],
	"yú móu": ["桙"],
	"ráo náo": ["桡", "橈"],
	"guì huì": ["桧", "檜"],
	"chén zhèn": ["桭"],
	"tīng yíng": ["桯"],
	"bó po": ["桲"],
	"bèn fàn": ["桳"],
	"fēng fèng": ["桻", "葑"],
	"sù yìn": ["梀"],
	"tǐng tìng": ["梃"],
	"xuān juān xié": ["梋"],
	"tú chá": ["梌"],
	"āo yòu": ["梎"],
	kuǎn: [
		"梡",
		"欵",
		"款",
		"歀"
	],
	"shāo sào": ["梢"],
	"qín chén cén": ["梣"],
	"lí sì qǐ": ["梩"],
	"chān yán": ["梴"],
	"bīn bīng": [
		"梹",
		"槟",
		"檳"
	],
	"táo chóu dào": ["梼"],
	"cōng sōng": ["棇"],
	"gùn hùn": ["棍"],
	"dé zhé": ["棏"],
	"pái bèi pèi": ["棑"],
	"bàng pǒu bèi bēi": ["棓"],
	"dì dài tì": ["棣"],
	sēn: [
		"森",
		"椮",
		"槮",
		"襂"
	],
	"rěn shěn": ["棯"],
	"léng lēng líng": ["棱"],
	"fú sù": ["棴"],
	"zōu sǒu": ["棷"],
	zōu: [
		"棸",
		"箃",
		"緅",
		"諏",
		"诹",
		"邹",
		"郰",
		"鄒",
		"鄹",
		"陬",
		"騶",
		"驺",
		"鯫",
		"鲰",
		"黀",
		"齱",
		"齺"
	],
	"zhào zhuō": ["棹"],
	"chēn shēn": ["棽"],
	"jiē qiè": ["椄"],
	"yǐ yī": ["椅"],
	"chóu zhòu diāo": ["椆"],
	"qiāng kōng": ["椌"],
	"zhuī chuí": ["椎"],
	"bēi pí": ["椑"],
	mēn: ["椚"],
	"quān juàn quán": ["椦"],
	"duǒ chuán": ["椯"],
	"wěi huī": ["椲"],
	"jiǎ jiā": ["椵"],
	"hán jiān": ["椷"],
	"shèn zhēn": ["椹"],
	"yàn yà": ["椻"],
	"zhā chá": ["楂"],
	"guō kuǎ": ["楇"],
	"jí zhì": ["楖"],
	"kǔ hù": ["楛"],
	"yóu yǒu": ["楢"],
	"sǒng cōng": ["楤"],
	"yuán xuàn": ["楥"],
	"yǎng yàng yīng": ["楧"],
	pián: [
		"楩",
		"胼",
		"腁",
		"賆",
		"蹁",
		"駢",
		"騈",
		"骈",
		"骿",
		"㛹"
	],
	"dié yè": ["楪"],
	"dùn shǔn": ["楯"],
	"còu zòu": ["楱"],
	"dì dǐ shì": ["楴"],
	"kǎi jiē": ["楷"],
	"róu ròu": ["楺"],
	"lè yuè": ["楽"],
	"wēn yùn": ["榅", "鞰"],
	lǘ: [
		"榈",
		"櫚",
		"氀",
		"膢",
		"藘",
		"閭",
		"闾",
		"驢",
		"驴"
	],
	shén: [
		"榊",
		"神",
		"鉮",
		"鰰",
		"𬬹"
	],
	"bī pi": ["榌"],
	"zhǎn niǎn zhèn": ["榐"],
	"fú fù bó": ["榑"],
	"jiàn jìn": ["榗"],
	"bǎng bàng": ["榜"],
	"shā xiè": ["榝", "樧"],
	nòu: [
		"槈",
		"耨",
		"鎒",
		"鐞"
	],
	"qiǎn lián xiàn": ["槏"],
	gàng: [
		"槓",
		"焵",
		"焹",
		"筻",
		"鿍"
	],
	gāo: [
		"槔",
		"槹",
		"橰",
		"櫜",
		"睾",
		"篙",
		"糕",
		"羔",
		"臯",
		"韟",
		"餻",
		"高",
		"髙",
		"鷎",
		"鷱",
		"鼛"
	],
	"diān zhěn zhēn": ["槙"],
	"kǎn jiàn": ["槛"],
	"xí dié": ["槢"],
	"jī guī": ["槣"],
	"róng yōng": ["槦"],
	"tuán shuàn quán": ["槫"],
	"qì sè": ["槭"],
	"cuī zhǐ": ["槯"],
	"yǒu chǎo": ["槱"],
	"màn wàn": ["槾"],
	"lí chī": ["樆"],
	"léi lěi": [
		"樏",
		"櫑",
		"礌"
	],
	"cháo jiǎo chāo": ["樔"],
	"chēng táng": ["樘"],
	"jiū liáo": ["樛"],
	"mó mú": ["模"],
	"niǎo mù": ["樢"],
	"héng hèng": ["横", "橫"],
	xuě: [
		"樰",
		"膤",
		"艝",
		"轌",
		"雪",
		"鱈",
		"鳕"
	],
	"fá fèi": ["橃"],
	rùn: [
		"橍",
		"润",
		"潤",
		"膶",
		"閏",
		"閠",
		"闰"
	],
	"zhǎn jiǎn": ["橏"],
	shùn: [
		"橓",
		"瞚",
		"瞬",
		"舜",
		"蕣",
		"順",
		"顺",
		"鬊"
	],
	"tuí dūn": ["橔"],
	"táng chēng": ["橖"],
	"sù qiū": ["橚"],
	"tán diàn": ["橝"],
	"fén fèn fèi": ["橨"],
	"rǎn yān": ["橪"],
	"cū chu": ["橻"],
	"shū qiāo": ["橾"],
	"píng bò": ["檘"],
	"zhái shì tú": ["檡"],
	"biǎo biāo": ["檦"],
	"qiān lián": ["檶"],
	"nǐ mí": ["檷"],
	"jiàn kǎn": ["檻"],
	"nòu ruǎn rú": ["檽"],
	"jī jì": ["櫅", "禨"],
	"huǎng guǒ gǔ": ["櫎"],
	"lǜ chū": ["櫖"],
	"miè mèi": ["櫗"],
	ōu: [
		"櫙",
		"欧",
		"歐",
		"殴",
		"毆",
		"瓯",
		"甌",
		"膒",
		"藲",
		"謳",
		"讴",
		"鏂",
		"鴎",
		"鷗",
		"鸥"
	],
	"zhù zhuó": ["櫡"],
	"jué jì": ["櫭"],
	"huái guī": ["櫰"],
	"chán zhàn": ["欃"],
	"wéi zuì": ["欈"],
	cáng: ["欌", "鑶"],
	"yù yì": ["欥"],
	"chù qù xì": ["欪"],
	"kài ài": ["欬"],
	"yì yīn": ["欭"],
	"xì kài": ["欯"],
	"shuò sòu": ["欶"],
	"ǎi ēi éi ěi èi ê̄ ế ê̌ ề": ["欸"],
	"qī yī": ["欹"],
	"chuā xū": ["欻"],
	"chǐ chuài": ["欼"],
	"kǎn qiàn": ["欿"],
	"kǎn kè": ["歁"],
	"chuǎn chuán": ["歂"],
	"yīn yān": ["歅"],
	"jìn qūn": ["歏"],
	pēn: ["歕"],
	"xū chuā": ["歘"],
	"xī shè": ["歙"],
	"liǎn hān": ["歛"],
	"zhì chí": ["歭"],
	"sè shà": ["歰"],
	sǐ: ["死"],
	"wěn mò": ["歾"],
	piǎo: [
		"殍",
		"皫",
		"瞟",
		"醥",
		"顠"
	],
	"qíng jìng": ["殑"],
	"fǒu bó": ["殕"],
	"zhí shi": ["殖"],
	"yè yān yàn": ["殗"],
	"hūn mèi": ["殙"],
	chòu: [
		"殠",
		"臰",
		"遚"
	],
	"kuì huì": [
		"殨",
		"溃",
		"潰"
	],
	cuàn: [
		"殩",
		"熶",
		"爨",
		"窜",
		"竄",
		"篡",
		"簒"
	],
	"yīn yān yǐn": ["殷"],
	"qìng kēng shēng": ["殸"],
	"yáo xiáo xiào": ["殽"],
	"gū gǔ": ["毂", "蛄"],
	"guàn wān": ["毌"],
	"dú dài": ["毒"],
	"xún xùn": ["毥"],
	mú: ["毪", "氁"],
	"dòu nuò": ["毭"],
	"sāi suī": ["毸"],
	lu: ["氇"],
	sào: [
		"氉",
		"瘙",
		"矂",
		"髞"
	],
	"shì zhī": ["氏"],
	"dī dǐ": ["氐"],
	"máng méng": ["氓"],
	"yáng rì": ["氜"],
	shuǐ: [
		"水",
		"氵",
		"氺",
		"閖"
	],
	"zhěng chéng zhèng": ["氶"],
	tǔn: ["氽"],
	"fán fàn": ["氾"],
	"guǐ jiǔ": ["氿"],
	"bīn pà pā": ["汃"],
	"zhuó què": ["汋"],
	"dà tài": ["汏"],
	pìn: [
		"汖",
		"牝",
		"聘"
	],
	"hàn hán": ["汗", "馯"],
	tu: ["汢"],
	"tāng shāng": ["汤", "湯"],
	"zhī jì": ["汥"],
	"gàn hán cén": ["汵"],
	"wèn mén": ["汶"],
	"fāng pāng": ["汸"],
	"hǔ huǎng": ["汻"],
	"niú yóu": ["汼"],
	hàng: ["沆"],
	"shěn chén": ["沈"],
	"dùn zhuàn": ["沌"],
	"nǜ niǔ": ["沑"],
	"méi mò": ["沒", "没"],
	"tà dá": ["沓"],
	"mì wù": ["沕"],
	"hóng pāng": ["沗"],
	"shā shà": ["沙"],
	"zhuǐ zǐ": ["沝"],
	"ōu òu": ["沤", "漚"],
	"jǔ jù": ["沮"],
	"tuō duó": ["沰"],
	"mǐ lì": ["沵"],
	"yí chí": ["沶"],
	"xiè yì": ["泄"],
	"bó pō": ["泊"],
	"mì bì": ["泌", "秘"],
	"chù shè": ["泏"],
	"yōu yòu āo": ["泑"],
	"pēng píng": ["泙", "硑"],
	"pào pāo": ["泡"],
	"ní nì": ["泥", "秜"],
	"yuè sà": ["泧"],
	"jué xuè": ["泬", "疦"],
	"lóng shuāng": ["泷", "瀧"],
	"luò pō": ["泺", "濼"],
	"zé shì": ["泽", "澤"],
	"sǎ xǐ": ["洒"],
	"sè qì zì": ["洓"],
	"xǐ xiǎn": ["洗"],
	"kǎo kào": ["洘"],
	"àn yàn è": ["洝"],
	"lěi lèi": ["洡"],
	"qiè jié": ["洯"],
	"qiǎn jiān": ["浅"],
	"jì jǐ": [
		"济",
		"済",
		"濟",
		"纪"
	],
	"hǔ xǔ": ["浒", "滸"],
	"jùn xùn": ["浚", "濬"],
	"yǐng chéng yíng": ["浧"],
	"liàn lì": ["浰"],
	"féng hóng": ["浲", "溄"],
	"jiǒng jiōng": ["浻"],
	"suī něi": ["浽"],
	"yǒng chōng": ["涌"],
	"tūn yūn": ["涒"],
	"wō guō": ["涡", "渦"],
	hēng: ["涥", "脝"],
	"zhǎng zhàng": ["涨", "漲"],
	"shòu tāo": ["涭"],
	shuàn: ["涮", "腨"],
	"kōng náng": ["涳"],
	"wò wǎn yuān": ["涴"],
	"tuō tuò": ["涶"],
	wō: [
		"涹",
		"猧",
		"窝",
		"窩",
		"莴",
		"萵",
		"蜗",
		"蝸",
		"踒"
	],
	"qiè jí": ["淁"],
	"guǒ guàn": ["淉"],
	"lín lìn": [
		"淋",
		"獜",
		"疄"
	],
	"tǎng chǎng": ["淌"],
	"nào chuò zhuō": ["淖"],
	"péng píng": ["淜"],
	féi: [
		"淝",
		"肥",
		"腓",
		"蜰"
	],
	"pì pèi": ["淠"],
	"niǎn shěn": ["淰"],
	"biāo hǔ": ["淲"],
	"chún zhūn": ["淳"],
	"hùn hún": ["混"],
	qiǎn: [
		"淺",
		"繾",
		"缱",
		"肷",
		"膁",
		"蜸",
		"譴",
		"谴",
		"遣",
		"鑓"
	],
	"wèn mín": ["渂"],
	"rè ruò luò": ["渃"],
	"dú dòu": [
		"渎",
		"瀆",
		"读"
	],
	"jiàn jiān": [
		"渐",
		"溅",
		"漸",
		"濺"
	],
	"miǎn shéng": ["渑", "澠"],
	"nuǎn nuán": ["渜"],
	"qiú wù": ["渞"],
	"tíng tīng": ["渟"],
	"dì tí dī": ["渧"],
	"gǎng jiǎng": ["港"],
	"hōng qìng": ["渹"],
	tuān: ["湍", "煓"],
	"huì mǐn xū": ["湏"],
	"xǔ xù": ["湑"],
	pén: [
		"湓",
		"瓫",
		"盆",
		"葐"
	],
	"mǐn hūn": ["湣"],
	"tuàn nuǎn": ["湪"],
	"qiū jiǎo": ["湫", "湬"],
	"yān yīn": ["湮"],
	"bàn pán": ["湴"],
	"zhuāng hún": ["湷"],
	"yàn guì": ["溎"],
	"lián liǎn nián xián xiàn": ["溓"],
	"dá tǎ": ["溚", "鿎"],
	"liū liù": [
		"溜",
		"澑",
		"蹓"
	],
	lùn: ["溣"],
	mǎ: [
		"溤",
		"犸",
		"獁",
		"玛",
		"瑪",
		"码",
		"碼",
		"遤",
		"鎷",
		"馬",
		"马",
		"鰢",
		"鷌"
	],
	"zhēn qín": ["溱"],
	"nì niào": ["溺"],
	"chù xù": ["滀", "畜"],
	"wěng wēng": ["滃"],
	"hào xuè": ["滈"],
	"qì xì xiē": ["滊"],
	"xíng yíng": ["滎"],
	"zé hào": ["滜"],
	"piāo piào piǎo": ["漂"],
	"cóng sǒng": ["漎"],
	"féng péng": ["漨"],
	"luò tà": ["漯"],
	"pēng bēn": ["漰"],
	"chóng shuāng": ["漴"],
	"huǒ kuò huò": ["漷"],
	"liáo liú": ["漻"],
	"cuǐ cuī": ["漼"],
	"cóng zǒng": ["潀"],
	"cóng zōng": ["潈"],
	"pì piē": ["潎"],
	"dàng xiàng": ["潒"],
	"huáng guāng": ["潢"],
	"liáo lào lǎo": ["潦"],
	"cōng zòng": ["潨"],
	"zhí zhì": ["潪"],
	"tān shàn": ["潬"],
	"tú zhā": ["潳"],
	"sàn sǎ": ["潵"],
	hēi: [
		"潶",
		"黑",
		"黒",
		"𬭶"
	],
	"chéng dèng": ["澄", "瀓"],
	"cūn cún": ["澊"],
	"péng pēng": ["澎"],
	"hòng gǒng": ["澒", "銾"],
	"wàn màn": ["澫"],
	"kuài huì": ["澮"],
	"guō wō": ["濄"],
	"pēn fén": ["濆"],
	"jí shà": ["濈"],
	"huì huò": ["濊"],
	"dǐng tìng": ["濎"],
	"mǐ nǐ": ["濔"],
	"bì pì": ["濞"],
	"cuì zuǐ": ["濢"],
	"hù huò": ["濩"],
	"ǎi kài kè": ["濭"],
	"wěi duì": ["濻", "瀢"],
	"zàn cuán": ["濽", "灒"],
	"yǎng yàng": ["瀁"],
	"wǎng wāng": ["瀇"],
	"mò miè": ["瀎", "眜"],
	suǐ: [
		"瀡",
		"膸",
		"髓"
	],
	"huái wāi": ["瀤"],
	"zùn jiàn": ["瀳"],
	"yīng yǐng yìng": ["瀴"],
	"ráng ràng": ["瀼"],
	shuàng: ["灀"],
	"zhuó jiào zé": ["灂"],
	sǎ: [
		"灑",
		"訯",
		"靸"
	],
	"luán luàn": ["灓"],
	"dǎng tǎng": ["灙"],
	"xún quán quàn": ["灥"],
	"huǒ biāo": ["灬"],
	"zhà yù": ["灹"],
	"fén bèn": ["炃"],
	"jiǒng guì": ["炅"],
	"pàng fēng": ["炐"],
	quē: [
		"炔",
		"缺",
		"缼",
		"蒛"
	],
	biān: [
		"炞",
		"煸",
		"甂",
		"砭",
		"笾",
		"箯",
		"籩",
		"編",
		"编",
		"蝙",
		"邉",
		"邊",
		"鍽",
		"鞭",
		"鯾",
		"鯿",
		"鳊"
	],
	"zhāo zhào": ["炤"],
	"zhuō chù": ["炪"],
	"pào páo bāo": ["炮"],
	"páo fǒu": ["炰"],
	"shǎn qián shān": ["炶"],
	"zhà zhá": ["炸"],
	"jiǎo yào": ["烄"],
	quǎn: [
		"烇",
		"犬",
		"犭",
		"畎",
		"綣",
		"绻",
		"虇"
	],
	"yàng yáng": ["烊"],
	"lào luò": ["烙"],
	"huí huǐ": ["烠"],
	rè: ["热", "熱"],
	"fú páo": ["烰"],
	"xiè chè": ["烲", "焎"],
	"yàn shān": ["烻"],
	"hūn xūn": ["焄"],
	kào: [
		"焅",
		"犒",
		"銬",
		"铐",
		"靠",
		"鮳",
		"鯌",
		"鲓",
		"㸆"
	],
	"juān yè": ["焆"],
	"jùn qū": ["焌"],
	"tāo dào": ["焘"],
	"chǎo jù": ["焣"],
	"wò ài": ["焥"],
	"zǒng cōng": ["焧"],
	"xī yì": ["焬"],
	"xìn xīn": ["焮"],
	"chāo zhuō": ["焯"],
	"xiǒng yīng": ["焸", "焽"],
	kuǐ: [
		"煃",
		"跬",
		"蹞",
		"頍",
		"𫠆"
	],
	"huī yùn xūn": ["煇"],
	"jiǎo qiāo": ["煍"],
	"qián shǎn shān": ["煔"],
	"xī yí": ["煕"],
	"shà shā": ["煞"],
	"yè zhá": ["煠"],
	"yáng yàng": ["煬"],
	"ēn yūn": ["煾"],
	"yūn yǔn": ["熅"],
	"hè xiāo": ["熇"],
	xióng: [
		"熊",
		"熋",
		"雄"
	],
	"xūn xùn": ["熏", "爋"],
	gòng: [
		"熕",
		"貢",
		"贡"
	],
	liū: ["熘"],
	"cōng zǒng": ["熜"],
	"lù āo": ["熝"],
	"shú shóu": ["熟"],
	"fēng péng": ["熢"],
	"cuǐ suī": ["熣"],
	tēng: [
		"熥",
		"膯",
		"鼟"
	],
	"yùn yù": ["熨"],
	"áo āo": ["熬"],
	"hàn rǎn": ["熯"],
	"ōu ǒu": ["熰"],
	"huáng huǎng": ["熿"],
	"chǎn dǎn chàn": ["燀"],
	"jiāo zhuó qiáo jué": ["燋"],
	"yàn yān": ["燕"],
	"tài liè": ["燤"],
	āo: ["爊"],
	"yàn xún": ["爓"],
	"jué jiào": [
		"爝",
		"覐",
		"覚",
		"覺",
		"觉"
	],
	"lǎn làn": ["爦"],
	"zhuǎ zhǎo": ["爪"],
	"zhǎo zhuǎ": ["爫"],
	"fù fǔ": ["父"],
	diē: [
		"爹",
		"褺",
		"跌"
	],
	zāng: [
		"牂",
		"羘",
		"臧",
		"賍",
		"賘",
		"贓",
		"贜",
		"赃",
		"髒"
	],
	"piàn piān": ["片"],
	"biān miàn": ["牑"],
	bǎng: [
		"牓",
		"綁",
		"绑"
	],
	"yǒu yōng": ["牗"],
	"chēng chèng": ["牚", "竀"],
	niú: ["牛", "牜"],
	"jiū lè": ["牞"],
	"mù móu": ["牟"],
	māng: ["牤"],
	"gē qiú": ["牫"],
	"yòu chōu": ["牰"],
	"tè zhí": ["犆"],
	bēn: [
		"犇",
		"錛",
		"锛"
	],
	"jiān qián": ["犍", "玪"],
	má: [
		"犘",
		"痲",
		"蔴",
		"蟇",
		"麻"
	],
	"máo lí": ["犛"],
	"bá quǎn": ["犮"],
	"zhuó bào": ["犳"],
	"àn hān": ["犴"],
	"kàng gǎng": ["犺"],
	"pèi fèi": ["犻"],
	"fān huān": ["犿"],
	kuáng: [
		"狂",
		"狅",
		"誑",
		"诳",
		"軖",
		"軠",
		"鵟",
		"𫛭"
	],
	"yí quán chí": ["狋"],
	"xīng shēng": ["狌"],
	"tuó yí": ["狏"],
	kǔ: ["狜", "苦"],
	"huán huān": ["狟"],
	"hé mò": ["狢"],
	"tà shì": ["狧"],
	"máng dòu": ["狵"],
	"xī shǐ": ["狶"],
	suān: [
		"狻",
		"痠",
		"酸"
	],
	"bài pí": ["猈"],
	"jiān yàn": ["猏", "豣"],
	"yī yǐ": ["猗"],
	"yá wèi": ["猚"],
	cāi: ["猜"],
	"māo máo": ["猫", "貓"],
	"chuàn chuān": ["猭"],
	"tuān tuàn": ["猯", "貒"],
	"yà jiá qiè": ["猰"],
	"hè xiē gé hài": ["猲"],
	"biān piàn": ["猵", "獱"],
	"bó pò": ["猼"],
	"háo gāo": ["獋"],
	"fén fèn": ["獖"],
	"yào xiāo": ["獟"],
	"shuò xī": ["獡"],
	"gé liè xiē": ["獦"],
	"nòu rú": ["獳"],
	"náo nǎo yōu": ["獶"],
	ráng: [
		"獽",
		"瓤",
		"禳",
		"穣",
		"穰",
		"蘘",
		"躟",
		"鬤"
	],
	"náo yōu": ["獿"],
	"lǜ shuài": ["率"],
	"wáng wàng": ["王"],
	"yáng chàng": ["玚"],
	"mín wén": ["玟"],
	"bīn fēn": ["玢"],
	"mén yǔn": ["玧"],
	"qiāng cāng": [
		"玱",
		"瑲",
		"篬"
	],
	"án gān": ["玵"],
	"xuán xián": ["玹"],
	"cī cǐ": ["玼", "跐"],
	"yí tāi": ["珆"],
	"zǔ jù": ["珇"],
	fà: [
		"珐",
		"琺",
		"蕟",
		"髪",
		"髮"
	],
	"yín kèn": ["珢"],
	"huī hún": ["珲"],
	"xuán qióng": ["琁"],
	"fú fū": ["琈"],
	"bǐng pín": ["琕"],
	"cuì sè": ["琗"],
	"yù wéi": ["琟"],
	"tiǎn tiàn": ["琠"],
	"zhuó zuó": ["琢"],
	"běng pěi": ["琣"],
	guǎn: [
		"琯",
		"璭",
		"痯",
		"筦",
		"管",
		"舘",
		"輨",
		"錧",
		"館",
		"馆",
		"鳤"
	],
	"hún huī": ["琿"],
	"xié jiē": ["瑎"],
	"chàng dàng yáng": ["瑒"],
	"tiàn zhèn": ["瑱"],
	"bīn pián": ["瑸", "璸"],
	"tú shū": ["瑹"],
	cuǐ: [
		"璀",
		"皠",
		"趡"
	],
	"zǎo suǒ": ["璅"],
	"jué qióng": ["璚"],
	"lú fū": ["璷"],
	"jì zī": ["璾"],
	suí: [
		"瓍",
		"綏",
		"绥",
		"遀",
		"随",
		"隨",
		"髄"
	],
	"mí xǐ": ["瓕"],
	"qióng wěi wèi": ["瓗"],
	"huán yè yà": ["瓛"],
	"bó páo": ["瓟"],
	"zhí hú": ["瓡"],
	piáo: ["瓢", "闝"],
	"wǎ wà": ["瓦"],
	"xiáng hóng": ["瓨"],
	wèng: [
		"瓮",
		"甕",
		"罋",
		"蕹",
		"齆"
	],
	"shèn shén": ["甚"],
	ruí: [
		"甤",
		"緌",
		"蕤"
	],
	yòng: [
		"用",
		"砽",
		"苚",
		"蒏",
		"醟",
		"㶲"
	],
	shuǎi: ["甩"],
	béng: ["甭", "甮"],
	"yóu zhá": ["甴"],
	"diàn tián shèng": ["甸"],
	"tǐng dīng": ["町", "甼"],
	"zāi zī": ["甾"],
	"bì qí": ["畁"],
	"dá fú": ["畗"],
	"cè jì": ["畟"],
	"zāi zī tián": ["畠"],
	"zhì chóu shì": ["畤"],
	"fān pān": ["畨", "番"],
	"shē yú": ["畬"],
	"dāng dàng dǎng": ["當"],
	"jiāng qiáng": ["疆"],
	"pǐ yǎ shū": ["疋"],
	"jié qiè": ["疌"],
	"yí nǐ": ["疑"],
	nè: [
		"疒",
		"眲",
		"訥",
		"讷"
	],
	"gē yì": ["疙"],
	"nüè yào": ["疟", "瘧"],
	"lì lài": ["疠", "癘"],
	"yǎ xiā": ["疨"],
	xuē: [
		"疶",
		"蒆",
		"薛",
		"辥",
		"辪",
		"靴",
		"鞾"
	],
	"dǎn da": ["疸"],
	"fá biǎn": ["疺"],
	"fèi féi": ["疿", "痱"],
	"shān diàn": ["痁"],
	"téng chóng": ["痋"],
	"tōng tóng": ["痌"],
	"wěi yòu yù": ["痏"],
	"tān shǐ": ["痑"],
	"pū pù": ["痡", "鋪"],
	"bēng péng": ["痭"],
	"má lìn": ["痳"],
	"tiǎn diàn": ["痶"],
	"ān yè è": ["痷"],
	"kē ē": ["痾"],
	"zhì chì": ["瘈"],
	"jiǎ xiá xiā": ["瘕"],
	"lěi huì": ["瘣"],
	"chài cuó": ["瘥"],
	"diān chēn": ["瘨"],
	"da dá": ["瘩"],
	"biě biē": ["瘪"],
	qué: ["瘸"],
	"dàn dān": ["癉"],
	"guì wēi": ["癐"],
	"nòng nóng": ["癑"],
	"biē biě": ["癟"],
	"bō bǒ": ["癷"],
	bái: ["白"],
	"jí bī": ["皀"],
	"de dì dí dī": ["的"],
	"pā bà": ["皅"],
	"gāo háo": ["皋"],
	"gāo yáo": ["皐"],
	"lì luò bō": ["皪"],
	"zhā cǔ": ["皻"],
	"zhāo zhǎn dǎn": ["皽"],
	"jiān jiàn": [
		"监",
		"監",
		"鋻",
		"间",
		"鞬"
	],
	"gài gě hé": ["盖"],
	"máng wàng": ["盳"],
	yuǎn: [
		"盶",
		"逺",
		"遠"
	],
	"tián xián": ["盷"],
	"xiāng xiàng": ["相"],
	dǔn: [
		"盹",
		"趸",
		"躉"
	],
	"xì pǎn": ["盻"],
	"shěng xǐng": ["省"],
	"yún hùn": ["眃"],
	"miǎn miàn": ["眄"],
	"kàn kān": ["看"],
	"yìng yāng yǎng": ["眏"],
	"yǎo āo ǎo": ["眑"],
	"jū xū kōu": ["眗"],
	"yí chì": ["眙"],
	"dié tì": ["眣"],
	"bǐng fǎng": ["眪"],
	"pàng pán": ["眫"],
	"mī mí": ["眯", "瞇"],
	"xuàn shùn xún": ["眴"],
	tiào: [
		"眺",
		"粜",
		"糶",
		"覜",
		"趒"
	],
	"zhe zhuó zháo zhāo": ["着"],
	"qiáo shào xiāo": ["睄"],
	"cuó zhuài": ["睉"],
	gùn: ["睔", "謴"],
	"suì zuì": ["睟"],
	"pì bì": [
		"睥",
		"稫",
		"辟"
	],
	"yì zé gāo": ["睪"],
	"xǐng xìng": ["睲"],
	"guì wèi kuì": ["瞆"],
	"kòu jì": ["瞉"],
	"qióng huán": ["瞏"],
	"mán mén": ["瞒", "瞞"],
	"diāo dōu": ["瞗"],
	"lou lóu lǘ": ["瞜"],
	"shùn rún": ["瞤"],
	"liào liǎo": ["瞭", "钌"],
	"jiàn xián": ["瞯"],
	"wǔ mí": ["瞴"],
	"guì kuì": ["瞶"],
	"nǐng chēng": ["矃"],
	"huò yuè": ["矆"],
	"mēng méng": ["矇"],
	"kuàng guō": ["矌"],
	"guàn quán": ["矔"],
	"mǎn mán": ["矕"],
	"jīn guān qín": ["矜"],
	"jīn qín guān": ["矝"],
	"yù xù jué": ["矞"],
	"jiǎo jiáo": ["矫", "矯"],
	duǎn: ["短"],
	"shí dàn": ["石"],
	"gāng qiāng kòng": ["矼"],
	"huā xū": ["砉"],
	"pīn bīn fēn": ["砏"],
	"yán yàn": ["研", "硏"],
	"luǒ kē": ["砢"],
	"fú fèi": ["砩", "笰"],
	"zhǔ zhù": ["砫"],
	"lá lì lā": ["砬"],
	"kuāng guāng": ["硄"],
	"gè luò": ["硌"],
	"shuò shí": ["硕", "碩"],
	"wèi wéi ái": ["硙"],
	"què kè kù": ["硞"],
	"mǎng bàng": ["硥"],
	"luò lòng": ["硦"],
	"yǒng tóng": ["硧"],
	nüè: ["硸", "虐"],
	"kēng kěng": ["硻"],
	"yān yǎn": ["硽"],
	"zhuì chuí duǒ": ["硾"],
	"kōng kòng": ["硿"],
	"zòng cóng": ["碂"],
	"jiān zhàn": ["碊"],
	"lù liù": ["碌", "陆"],
	"què xī": ["碏"],
	"lún lǔn lùn": ["碖"],
	"náo gāng": ["碙"],
	"jié yà": ["碣"],
	"wèi wěi": ["碨"],
	"tí dī": ["碮"],
	"chá chā": ["碴"],
	"qiāo què": ["碻"],
	"sù xiè": ["碿"],
	"liú liù": [
		"磂",
		"遛",
		"鎦",
		"馏"
	],
	"sī tí": ["磃"],
	"bàng páng": ["磅"],
	"huá kě gū": ["磆"],
	"wěi kuǐ": ["磈"],
	"xiá qià yà": ["磍"],
	"lián qiān": ["磏"],
	"wèi ái gài": ["磑"],
	"lá lā": ["磖"],
	"áo qiāo": ["磝"],
	"pēng pèng": ["磞", "閛"],
	"yīn yǐn": ["磤"],
	"lěi léi": ["磥"],
	"mó mò": ["磨"],
	"qì zhú": ["磩"],
	"láo luò": ["磱"],
	"pán bō": ["磻"],
	"jí shé": ["磼"],
	"hé qiāo qiào": ["礉"],
	"kè huò": ["礊"],
	"què hú": ["礐"],
	"è qì": ["礘"],
	cǎ: ["礤", "礸"],
	"xián xín": ["礥"],
	"léi lěi lèi": ["礧"],
	"yán yǎn": ["礹"],
	"qí zhǐ": ["祇", "蚔"],
	"bēng fāng": ["祊"],
	"bì mì": ["祕"],
	suàn: [
		"祘",
		"笇",
		"筭",
		"算",
		"蒜"
	],
	"piào piāo": ["票"],
	"jì zhài": ["祭"],
	"shuì lèi": ["祱"],
	"jìn jīn": ["禁"],
	"chán shàn": ["禅"],
	"yáng shāng": ["禓"],
	"zhī zhǐ tí": ["禔"],
	"shàn chán": ["禪"],
	"yú yù ǒu": ["禺"],
	"zǐ zì": ["秄"],
	"chá ná": ["秅"],
	"zhǒng zhòng chóng": ["种"],
	"hào mào": ["秏"],
	"kù kū": ["秙"],
	zū: ["租", "葅"],
	chèng: ["秤", "穪"],
	"huó kuò": ["秮", "秳"],
	"chēng chèn chèng": ["称", "稱"],
	"shì zhì": ["秲", "銴"],
	"fù pū": ["秿"],
	"xùn zè": ["稄"],
	"tú shǔ": ["稌"],
	"zhùn zhǔn": ["稕"],
	"jī qí": [
		"稘",
		"綨",
		"觭"
	],
	"léng líng": ["稜"],
	"zuì zú sū": ["稡"],
	"xì qiè": ["稧", "郄"],
	"zhǒng zhòng": ["種"],
	"zōng zǒng": ["稯"],
	"xián jiān liàn": ["稴"],
	"zī jiū": ["稵"],
	"jī qǐ": ["稽"],
	ròng: ["穃"],
	"shān cǎn cēn": ["穇"],
	"mén méi": ["穈"],
	"jǐ jì": ["穖"],
	"xiāo rào": ["穘"],
	"zhuō bó": ["穛"],
	"tóng zhǒng zhòng": ["穜"],
	zuō: ["穝"],
	"biāo pāo": ["穮", "藨"],
	"zhuō jué": ["穱"],
	"cuán zàn": ["穳"],
	"kōng kòng kǒng": ["空"],
	"yū yǔ": ["穻"],
	zhǎi: ["窄", "鉙"],
	báo: ["窇", "雹"],
	"kū zhú": ["窋"],
	"jiào liáo liù": ["窌"],
	"wā guī": ["窐"],
	"tiǎo yáo": ["窕"],
	"xūn yìn": ["窨"],
	"yà yē": ["窫"],
	"tián diān yǎn": ["窴"],
	"chāo kē": ["窼"],
	"kuǎn cuàn": ["窽", "窾"],
	"chù qì": ["竐"],
	"qǔ kǒu": ["竘"],
	"jìng zhěn": ["竧"],
	"kǎn kàn": ["竷"],
	"zhú dǔ": ["竺"],
	"lè jīn": ["竻"],
	"zhuì ruì": ["笍"],
	"háng hàng": ["笐"],
	"cén jìn hán": ["笒"],
	"dā xiá nà": ["笚"],
	"zé zuó": ["笮"],
	"lóng lǒng": [
		"笼",
		"篭",
		"籠",
		"躘",
		"龓"
	],
	"zhù zhú": ["筑", "築"],
	"dá dā": ["答", "荅"],
	shāi: [
		"筛",
		"篩",
		"簁",
		"籭"
	],
	"yún jūn": ["筠"],
	"láng làng": [
		"筤",
		"郎",
		"阆"
	],
	"zhì zhǐ": ["筫"],
	o: ["筽"],
	"póu bù fú pú": ["箁"],
	"pái bēi": ["箄"],
	gè: [
		"箇",
		"虼",
		"鉻",
		"铬"
	],
	"tái chí": ["箈"],
	"guǎi dài": ["箉"],
	"zhào dào": ["箌"],
	"jīng qìng": ["箐"],
	"lín lǐn": ["箖"],
	"jùn qūn": ["箘"],
	"shī yí": ["箷", "釶"],
	"yuē yào chuò": ["箹"],
	"xiāo shuò qiào": ["箾"],
	"gōng gǎn lǒng": ["篢"],
	"páng péng": ["篣"],
	"zhuó huò": ["篧"],
	"jiǎn jiān": ["篯"],
	"dí zhú": ["篴"],
	"zān cēn cǎn": ["篸"],
	"zhuàn suǎn zuàn": ["篹"],
	"piǎo biāo": ["篻"],
	"guó guì": ["簂"],
	"cè jí": ["簎"],
	"mì miè": ["簚"],
	"shāi sī": ["簛"],
	"sǔn zhuàn": ["簨"],
	"gàn gǎn": ["簳"],
	"bò bǒ": ["簸"],
	"bó bù": ["簿"],
	shi: ["籂"],
	"zhēn jiān": ["籈"],
	"zhuàn zuǎn": ["籑"],
	"fān pān biān": ["籓"],
	"sǒu shǔ": ["籔"],
	zuǎn: [
		"籫",
		"繤",
		"纂",
		"纉",
		"纘",
		"缵"
	],
	nǚ: [
		"籹",
		"釹",
		"钕"
	],
	"shā chǎo": ["粆"],
	"kāng jīng": ["粇"],
	fěn: ["粉", "黺"],
	cū: [
		"粗",
		"觕",
		"麁",
		"麄",
		"麤"
	],
	"nián zhān": ["粘"],
	"cè sè": ["粣"],
	"zhōu yù": ["粥"],
	"shēn sǎn": ["糁"],
	"biān biǎn": ["糄", "萹"],
	miàn: [
		"糆",
		"面",
		"靣",
		"麪",
		"麫",
		"麵",
		"麺"
	],
	"hú hū hù": ["糊"],
	"gǔ gòu": ["糓"],
	"mí méi": ["糜"],
	"sǎn shēn": ["糝", "糣"],
	zāo: [
		"糟",
		"蹧",
		"遭",
		"醩"
	],
	"mì sī": ["糸"],
	"jiū jiǔ": ["糺"],
	"xì jì": ["系", "繫"],
	"zhēng zhěng": ["糽"],
	"chà chǎ": ["紁", "衩"],
	"yuē yāo": ["約", "约"],
	"hóng gōng": ["紅", "红"],
	"hé gē": ["紇", "纥"],
	"wén wèn": ["紋", "纹"],
	fóu: ["紑"],
	"jì jié jiè": ["紒"],
	"pī pí bǐ": ["紕", "纰"],
	"jīn jìn": ["紟"],
	"zhā zā": ["紥", "紮"],
	hā: ["紦"],
	"fū fù": ["紨"],
	"chōu chóu": ["紬"],
	"lèi léi lěi": ["累"],
	"bō bì": ["紴"],
	"tiǎn zhěn": ["紾"],
	"jiōng jiǒng": ["絅"],
	"jié jiē": [
		"結",
		"结",
		"节"
	],
	"guà kuā": ["絓"],
	"bǎi mò": ["絔"],
	"gēng huán": ["絙"],
	"jié xié": ["絜"],
	"quán shuān": ["絟"],
	"gǎi ǎi": ["絠"],
	"luò lào": ["絡", "络"],
	"bīng bēng pēng": ["絣"],
	"gěi jǐ": ["給", "给"],
	"tóng tōng dòng": ["絧"],
	"tiào diào dào": ["絩"],
	"lěi lèi léi": ["絫"],
	"gāi hài": ["絯"],
	"chī zhǐ": ["絺"],
	"wèn miǎn mán wàn": ["絻"],
	"huán huàn wàn": ["綄"],
	"qīn xiān": ["綅"],
	"tì tí": ["綈"],
	"yán xiàn": ["綖"],
	"zōng zèng zòng": ["綜"],
	"chēn lín": ["綝"],
	"zhǔn zhùn": ["綧"],
	"qiàn qīng zhēng": ["綪"],
	"qìng qǐ": ["綮"],
	"lún guān": ["綸", "纶"],
	"chuò chāo": ["綽", "绰"],
	"tián tǎn chān": ["緂"],
	"lǜ lù": ["緑", "绿"],
	"ruǎn ruàn": ["緛"],
	"jí qī": ["緝"],
	"zhòng chóng": ["緟", "重"],
	"miáo máo": ["緢"],
	"xiè yè": ["緤"],
	huǎn: [
		"緩",
		"缓",
		"㬊"
	],
	"gēng gèng": ["緪", "縆"],
	"tōu xū shū": ["緰"],
	"zōng zòng": ["緵", "繌"],
	"yùn gǔn": ["緷"],
	"guā wō": ["緺"],
	"yùn yūn wēn": ["緼", "縕"],
	"bāng bàng": ["縍"],
	"gǔ hú": ["縎", "鶻"],
	"cī cuò suǒ": ["縒"],
	"cuī shuāi": ["縗"],
	"róng rǒng ròng": ["縙"],
	"zài zēng": ["縡"],
	cài: [
		"縩",
		"菜",
		"蔡"
	],
	"féng fèng": ["縫"],
	"suō sù": ["縮", "缩"],
	"yǎn yǐn": ["縯", "酓"],
	"zòng zǒng": ["縱", "纵"],
	"zhuàn juàn": ["縳"],
	"mò mù": ["縸", "莫"],
	"piǎo piāo": ["縹", "缥"],
	"fán pó": ["繁"],
	"bēng bèng": ["繃"],
	"móu miù miào liǎo": ["繆"],
	"yáo yóu zhòu": ["繇"],
	"zēng zèng": ["繒", "缯"],
	"jú jué": ["繘"],
	"chuō chuò": ["繛"],
	"zūn zǔn": ["繜"],
	rào: [
		"繞",
		"绕",
		"遶"
	],
	"chǎn chán": ["繟"],
	"huì huí": [
		"繢",
		"缋",
		"藱"
	],
	"qiāo sāo zǎo": ["繰"],
	"jiǎo zhuó": ["繳", "缴"],
	"dàn tán chán": ["繵"],
	nǒng: ["繷"],
	"pú fú": ["纀"],
	"yào lì": ["纅"],
	"rǎng xiāng": ["纕"],
	"lí sǎ xǐ lǐ": ["纚"],
	"xiān qiàn": ["纤"],
	"jīng jìng": ["经"],
	"tí tì": ["绨"],
	"bēng běng bèng": ["绷"],
	"zōng zèng": ["综"],
	"jī qī": ["缉"],
	"wēn yùn yūn": ["缊"],
	"fèng féng": ["缝"],
	"shuāi cuī suī": ["缞"],
	"miù móu liáo miào mù": ["缪"],
	"qiāo sāo": ["缲"],
	fǒu: [
		"缶",
		"缹",
		"缻",
		"雬",
		"鴀"
	],
	"bà ba pí": ["罢", "罷"],
	"guà guǎi": ["罫"],
	"yáng xiáng": ["羊", "羏"],
	"měi gāo": ["羙"],
	"yì xī": ["羛"],
	"qiǎng qiān": ["羟"],
	"qiāng kòng": ["羫"],
	"qián xián yán": ["羬"],
	nóu: ["羺"],
	"hóng gòng": ["羾"],
	"pī bì pō": ["翍"],
	"qú yù": ["翑"],
	ké: ["翗"],
	"qiào qiáo": ["翘"],
	"zhái dí": ["翟"],
	"dào zhōu": ["翢"],
	"hóu qú": ["翵"],
	shuǎ: ["耍"],
	"ruǎn nuò": ["耎"],
	"ér nài": ["耏"],
	"zhuān duān": ["耑"],
	"pá bà": ["耙"],
	"chí sì": ["耛"],
	"qù chú": ["耝"],
	"lún lǔn": ["耣"],
	"jí jiè": ["耤"],
	"tāng tǎng": ["耥"],
	pǎng: ["耪", "覫"],
	"zhá zé": ["耫"],
	"yē yé": ["耶"],
	"yún yíng": ["耺"],
	"wà tuǐ zhuó": ["聉"],
	"ér nǜ": ["聏"],
	"tiē zhé": ["聑"],
	"dǐ zhì": ["聜"],
	qié: ["聺"],
	"nǐ jiàn": ["聻"],
	"lèi lē": ["肋"],
	cào: [
		"肏",
		"襙",
		"鄵",
		"鼜"
	],
	"bó dí": ["肑"],
	"xiào xiāo": ["肖"],
	"dù dǔ": ["肚"],
	chāi: [
		"肞",
		"釵",
		"钗"
	],
	"hán qín hàn": ["肣"],
	"pàng pán pàn": ["肨", "胖"],
	"zhūn chún": ["肫"],
	āng: ["肮", "骯"],
	"yù yō": ["育"],
	"pí bǐ bì": ["肶"],
	"fèi bì": ["胇"],
	"bèi bēi": ["背"],
	"fèi zǐ": ["胏"],
	"píng pēng": ["胓", "苹"],
	"fū fú zhǒu": ["胕"],
	"shèng shēng": ["胜"],
	kuà: [
		"胯",
		"跨",
		"骻"
	],
	"gǎi hǎi": ["胲"],
	"gē gé gā": ["胳"],
	"néng nài": ["能"],
	"guī kuì": ["胿"],
	"mài mò": ["脉"],
	"zāng zàng": ["脏"],
	"jiǎo jué": ["脚", "角"],
	cuǒ: ["脞"],
	"de te": ["脦"],
	"zuī juān": ["脧"],
	něi: [
		"脮",
		"腇",
		"餒",
		"馁",
		"鮾",
		"鯘"
	],
	"pú fǔ": ["脯"],
	niào: ["脲"],
	shuí: ["脽"],
	guò: [
		"腂",
		"過",
		"鐹"
	],
	"là xī": ["腊"],
	"yān ā": ["腌"],
	"gāo gào": ["膏"],
	"lù biāo": ["膔"],
	chuái: ["膗"],
	"zhuān chuán chún zhuǎn": ["膞"],
	chuài: ["膪", "踹"],
	"fán pán": ["膰"],
	"wǔ hū": ["膴"],
	"shān dàn": ["膻"],
	tún: [
		"臀",
		"臋",
		"蛌",
		"豘",
		"豚",
		"軘",
		"霕",
		"飩",
		"饨",
		"魨",
		"鲀",
		"黗"
	],
	"bì bei": ["臂"],
	"là gé": ["臈"],
	"sào sāo": ["臊"],
	nào: [
		"臑",
		"閙",
		"闹",
		"鬧"
	],
	"ní luán": ["臡"],
	"qiān xián": ["臤"],
	"guàng jiǒng": ["臦"],
	"guǎng jiǒng": ["臩"],
	"chòu xiù": ["臭"],
	"mián biān": ["臱"],
	"dié zhí": ["臷"],
	"zhī jìn": ["臸"],
	"shè shě": ["舍"],
	pù: ["舖", "舗"],
	"bān bō pán": ["般"],
	kuā: ["舿"],
	"gèn gěn": ["艮"],
	"sè shǎi": ["色"],
	"fú bó": ["艴"],
	"jiāo qiú": ["艽"],
	"chāi chā": ["芆"],
	"sháo què": ["芍"],
	"hù xià": ["芐"],
	"zì zǐ": ["芓"],
	"huì hū": ["芔"],
	"tún chūn": ["芚"],
	"jiè gài": ["芥"],
	"xù zhù": ["芧"],
	"yuán yán": ["芫"],
	"xīn xìn": ["芯"],
	"lún huā": ["芲"],
	"wù hū": ["芴"],
	"gōu gǒu": ["芶"],
	"mào máo": ["芼"],
	"fèi fú": ["芾"],
	"chán yín": ["苂"],
	qiē: ["苆"],
	"sū sù": ["苏"],
	"tiáo sháo": ["苕"],
	"lì jī": ["苙"],
	"kē hē": ["苛"],
	"jù qǔ": ["苣"],
	"ruò rě": ["若"],
	"zhù níng": ["苧"],
	"pā bó": ["苩"],
	xiú: ["苬"],
	"zhǎ zuó": ["苲"],
	"jū chá": ["苴"],
	nié: ["苶"],
	"shēng ruí": ["苼"],
	"qié jiā": ["茄"],
	"zǐ cí": ["茈"],
	"qiàn xī": ["茜"],
	chǎi: ["茝"],
	"fá pèi": ["茷"],
	ráo: [
		"荛",
		"蕘",
		"襓",
		"饒",
		"饶"
	],
	"yíng xíng": ["荥"],
	"qián xún": ["荨", "蕁"],
	"yìn yīn": ["荫"],
	"hé hè": ["荷"],
	"shā suō": ["莎"],
	"péng fēng": ["莑"],
	"shēn xīn": ["莘"],
	"wǎn guān guǎn": ["莞"],
	"yóu sù": ["莤"],
	"shāo xiāo": ["莦", "蛸"],
	"làng liáng": ["莨"],
	"piǎo fú": ["莩"],
	"wèn wǎn miǎn": ["莬"],
	"shì shí": ["莳", "蒔"],
	"tù tú": ["莵"],
	"xiān liǎn": ["莶", "薟"],
	"wǎn yù": ["菀"],
	"zōu chù": ["菆"],
	"lù lǜ": ["菉"],
	"jūn jùn": ["菌"],
	"niè rěn": ["菍"],
	"zī zì zāi": ["菑"],
	"tú tù": ["菟"],
	"jiē shà": ["菨"],
	"qiáo zhǎo": ["菬"],
	"tái zhī chí": ["菭"],
	"fēi fěi": ["菲", "蜚"],
	"qín qīn jīn": ["菳"],
	"zū jù": ["菹", "蒩"],
	"lǐn má": ["菻"],
	"tián tiàn": ["菾"],
	tiē: [
		"萜",
		"貼",
		"贴"
	],
	"luò là lào luō": ["落"],
	"zhù zhuó zhe": ["著"],
	"shèn rèn": ["葚"],
	"gě gé": ["葛"],
	"jùn suǒ": ["葰"],
	"kuì kuài": ["蒉"],
	"rú ná": ["蒘"],
	"méng mēng měng": ["蒙"],
	"yuán huán": ["蒝"],
	"xú shú": ["蒣"],
	"xí xì": ["蒵"],
	"mì míng": ["蓂"],
	"sōu sǒu": ["蓃"],
	"gài gě hé hài": ["蓋"],
	"yǎo zhuó": ["蓔"],
	"diào tiáo dí": ["蓧"],
	"xū qiū fū": ["蓲"],
	"zí jú": ["蓻"],
	"liǎo lù": ["蓼"],
	xu: ["蓿"],
	"hàn hǎn": ["蔊"],
	"màn wàn mán": ["蔓"],
	"pó bò": ["蔢"],
	"fān fán bō": ["蕃"],
	"hóng hòng": ["蕻"],
	"yù ào": ["薁", "隩"],
	"xí xiào": ["薂"],
	"báo bó bò": ["薄"],
	"cí zī": ["薋"],
	"wàn luàn": ["薍"],
	"kǎo hāo": ["薧"],
	"yuǎn wěi": ["薳"],
	"zhòu chóu": ["薵"],
	"wō mái": ["薶"],
	"xiāo hào": ["藃"],
	"yù xù xū": ["藇"],
	"jiè jí": ["藉"],
	"diào zhuó": ["藋"],
	"cáng zàng": ["藏"],
	lǎ: ["藞"],
	"chú zhū": ["藸"],
	"pín píng": ["蘋"],
	"gān hán": ["虷"],
	"hóng jiàng": ["虹"],
	"huī huǐ": ["虺"],
	"xiā há": ["虾"],
	"mǎ mà mā": ["蚂"],
	"fāng bàng": ["蚄"],
	"bàng bèng": ["蚌"],
	"jué quē": ["蚗"],
	"qín qián": ["蚙"],
	"gōng zhōng": ["蚣"],
	"fǔ fù": ["蚥"],
	"dài dé": ["蚮"],
	"gǒu qú xù": ["蚼"],
	"bǒ pí": ["蚾"],
	"shé yí": ["蛇"],
	tiě: [
		"蛈",
		"鉄",
		"銕",
		"鐡",
		"鐵",
		"铁",
		"驖"
	],
	"gé luò": ["蛒"],
	"máng bàng": ["蛖"],
	"yì xǔ": ["蛡"],
	"há gé": ["蛤"],
	"qiè ní": ["蛪"],
	"é yǐ": ["蛾"],
	"zhē zhé": ["蜇"],
	"là zhà": ["蜡"],
	suò: ["蜶", "逤"],
	"yóu qiú": ["蝤"],
	"xiā hā": ["蝦"],
	"xī qī": ["螇"],
	"bī pí": ["螕"],
	"nài něng": ["螚"],
	"hé xiá": ["螛"],
	"guì huǐ": ["螝"],
	"mǎ mā mà": ["螞"],
	"shì zhē": ["螫"],
	"zhì dié": ["螲"],
	"jiàn chán": ["螹"],
	"ma má mò": ["蟆"],
	"mǎng měng": ["蟒"],
	"biē bié": ["蟞"],
	"bēn fèi": ["蟦"],
	"láo liáo": ["蟧"],
	"yín xún": ["蟫"],
	"lí lǐ": ["蠡"],
	"xuè xiě": ["血"],
	"xíng háng hàng héng": ["行"],
	"shuāi cuī": ["衰"],
	"tuó tuō": ["袉"],
	"lǐng líng": ["袊"],
	"bào páo pào": ["袌"],
	"jù jiē": ["袓"],
	"hè kè": ["袔"],
	"yí yì": ["袘", "貤"],
	"nà jué": ["袦"],
	"bèi pī": ["被"],
	"chǐ nuǒ": ["袲"],
	"chǐ qǐ duǒ nuǒ": ["袳"],
	"jiá qiā jié": ["袷"],
	"bó mò": ["袹"],
	"guī guà": ["袿"],
	"liè liě": ["裂"],
	"chéng chěng": ["裎"],
	"jiē gé": ["裓"],
	"dāo chóu": ["裯"],
	"shang cháng": ["裳"],
	"yuān gǔn": ["裷"],
	"yǎn ān": ["裺"],
	"tì xī": ["裼"],
	"fù fú": ["褔"],
	"chǔ zhǔ": ["褚"],
	"tuì tùn": ["褪"],
	lǎi: ["襰"],
	"yào yāo": ["要"],
	"qín tán": ["覃"],
	"jiàn xiàn": ["見", "见"],
	piǎn: [
		"覑",
		"諞",
		"谝",
		"貵",
		"𡎚"
	],
	"piē miè": ["覕"],
	"yíng yǐng": ["覮"],
	"qù qū": [
		"覰",
		"覷",
		"觑"
	],
	"jiàn biǎn": ["覵"],
	"luó luǎn": ["覶"],
	"zī zuǐ": ["觜"],
	"huà xiè": ["觟"],
	"jiě jiè xiè": ["解", "觧"],
	"xué hù": ["觷"],
	"lì lù": ["觻"],
	tǎo: ["討", "讨"],
	zhùn: ["訰"],
	"zī zǐ": ["訾"],
	"yí dài": ["詒", "诒"],
	xiòng: ["詗", "诇"],
	"diào tiǎo": ["誂"],
	"yí chǐ chì": ["誃"],
	"lǎng làng": ["誏"],
	"ēi éi ěi èi xī": ["誒", "诶"],
	shuà: ["誜"],
	"yǔ yù": [
		"語",
		"语",
		"雨"
	],
	"shuō shuì yuè": ["說", "说"],
	"shuí shéi": ["誰", "谁"],
	"qū juè": ["誳"],
	"chī lài": ["誺"],
	"nì ná": ["誽"],
	"diào tiáo": ["調"],
	"pǐ bēi": ["諀"],
	"jì jī": ["諅"],
	"zé zuò zhǎ cuò": ["諎"],
	"chù jí": ["諔"],
	"háo xià": ["諕"],
	"lùn lún": ["論", "论"],
	"shì dì": ["諟"],
	"huà guā": ["諣"],
	"xǐ shāi āi": ["諰"],
	"nán nàn": ["諵", "難"],
	miù: ["謬", "谬"],
	zèn: ["譖", "谮"],
	"shí zhì": ["識", "识"],
	"juàn xuān": ["讂"],
	"yí tuī": ["讉"],
	zhán: ["讝"],
	"xǔ hǔ": ["许"],
	"xiáng yáng": ["详"],
	"tiáo diào zhōu": ["调"],
	"chén shèn": ["谌"],
	"mí mèi": ["谜"],
	"màn mán": ["谩"],
	"gǔ yù": ["谷"],
	"huō huò huá": ["豁"],
	"zhì zhài": ["豸"],
	"huān huán": ["貆"],
	"kěn kūn": ["貇"],
	"mò hé": ["貈"],
	"mò hé háo": ["貉"],
	"jù lóu": ["貗"],
	"zé zhài": ["責", "责"],
	"dài tè": ["貸"],
	"bì bēn": ["賁"],
	"jiǎ gǔ jià": ["賈"],
	"xiōng mín": ["賯"],
	càng: ["賶"],
	"zhuàn zuàn": ["賺", "赚"],
	"wàn zhuàn": ["贃"],
	"gàn gòng zhuàng": ["贛"],
	"yuán yùn": ["贠"],
	"bēn bì": ["贲"],
	"jiǎ gǔ": ["贾"],
	zǒu: [
		"走",
		"赱",
		"鯐"
	],
	"dié tú": ["趃"],
	"jū qiè": ["趄"],
	"qū cù": ["趋", "趨"],
	"jí jié": ["趌"],
	"guā huó": ["趏"],
	"què qì jí": ["趞"],
	"tàng tāng": ["趟"],
	"chuō zhuó": ["趠"],
	"qù cù": ["趣"],
	"yuè tì": ["趯"],
	"bō bào": ["趵"],
	"kuà wù": ["趶"],
	"guì jué": ["趹"],
	"fāng fàng páng": ["趽"],
	"páo bà": ["跁"],
	"qí qǐ": ["跂"],
	"jiàn chén": ["跈"],
	"pǎo páo": ["跑"],
	"diǎn diē tiē": ["跕"],
	"jū jù qiè": ["跙"],
	bǒ: ["跛"],
	"luò lì": ["跞"],
	"dài duò duō chí": ["跢"],
	zhuǎi: ["跩"],
	"bèng pián": ["跰"],
	"tiào táo": ["跳"],
	"shū chōu": ["跾"],
	"liàng liáng": ["踉"],
	"tà tā": ["踏"],
	chǎ: [
		"蹅",
		"鑔",
		"镲"
	],
	"dí zhí": ["蹢"],
	"dēng dèng": [
		"蹬",
		"鐙",
		"镫"
	],
	cèng: ["蹭"],
	"dūn cún": ["蹲"],
	"juě jué": ["蹶"],
	liāo: ["蹽"],
	"xiè sǎ": ["躠"],
	tǐ: [
		"躰",
		"軆",
		"骵"
	],
	"yà zhá gá": ["轧", "軋"],
	"xìn xiàn": ["軐"],
	"fàn guǐ": ["軓"],
	"zhuàn zhuǎn": ["転"],
	"zhóu zhòu": ["軸", "轴"],
	bú: [
		"轐",
		"醭",
		"鳪"
	],
	"zhuǎn zhuàn zhuǎi": ["转"],
	"zǎi zài": ["载"],
	"niǎn zhǎn": ["辗"],
	"biān bian": ["边"],
	"dào biān": ["辺"],
	"yǐ yí": [
		"迆",
		"迤",
		"迱"
	],
	"guò guo guō": ["过"],
	"wàng kuāng": ["迋"],
	"hái huán": ["还"],
	"zhè zhèi": ["这"],
	"yuǎn yuàn": ["远"],
	"zhì lì": ["迣"],
	"zhù wǎng": ["迬"],
	"zhuī duī": ["追"],
	"shì kuò": ["适"],
	tòu: ["透"],
	"tōng tòng": ["通"],
	guàng: ["逛"],
	"dǎi dài": ["逮"],
	"suì suí": ["遂"],
	"tí dì": ["遆"],
	"yí wèi": ["遗"],
	"shì dí zhé": ["適"],
	cà: ["遪"],
	"huán hái": ["還"],
	"lí chí": ["邌"],
	"kàng háng": ["邟"],
	"nà nèi nā": ["那"],
	"xié yá yé yú xú": ["邪"],
	"gāi hái": ["郂"],
	"huán xún": ["郇"],
	"chī xī": ["郗"],
	hǎo: ["郝"],
	"lì zhí": ["郦"],
	"xiáo ǎo": ["郩"],
	"dōu dū": ["都"],
	liǎo: [
		"曢",
		"鄝",
		"镽"
	],
	"zàn cuán cuó": ["酂", "酇"],
	"dīng dǐng": ["酊"],
	"cù zuò": ["酢"],
	"fā pō": ["酦"],
	"shāi shī": ["酾"],
	niàng: ["酿", "醸"],
	"qiú chōu": ["醔"],
	"pō fā": ["醗", "醱"],
	"chǎn chěn": ["醦"],
	"yàn liǎn xiān": ["醶"],
	"niàng niáng": ["釀"],
	"lǐ li": ["里"],
	"lí xǐ xī": ["釐"],
	"liǎo liào": ["釕"],
	"dīng dìng": ["釘", "钉"],
	"qiǎo jiǎo": ["釥"],
	"yú huá": ["釪"],
	"huá wū": ["釫"],
	"rì rèn jiàn": ["釰", "釼"],
	"dì dài": ["釱"],
	"pī zhāo": ["釽"],
	"yá yé": ["釾"],
	"bǎ pá": ["鈀", "钯"],
	"tā tuó": ["鉈", "铊"],
	běi: ["鉳"],
	"bǐng píng": ["鉼"],
	"hā kē": ["鉿", "铪"],
	chòng: ["銃", "铳"],
	"xiǎng jiōng": ["銄"],
	"yù sì": ["銉"],
	"xù huì": ["銊"],
	"rén rěn": ["銋"],
	"shàn shuò": ["銏"],
	"chì lì": ["銐"],
	"xiǎn xǐ": ["銑", "铣"],
	"hóu xiàng": ["銗"],
	"diào tiáo yáo": ["銚"],
	"xiān kuò tiǎn guā": [
		"銛",
		"銽",
		"铦"
	],
	"zhé niè": ["銸"],
	"zhōng yōng": ["銿"],
	"tōu tù dòu": ["鋀"],
	"méi méng": ["鋂"],
	"wàn jiǎn": ["鋄", "鎫"],
	"tǐng dìng": ["鋌", "铤"],
	"juān jiān cuān": ["鋑"],
	"sī tuó": ["鋖"],
	"juān xuān juàn": ["鋗"],
	"wú huá wū": ["鋘"],
	"zhuó chuò": ["鋜"],
	"xíng xìng jīng": ["鋞"],
	"jū jú": ["鋦", "锔"],
	"zuì niè": ["鋷"],
	"yuān yuǎn wǎn wān": ["鋺"],
	"gāng gàng": ["鋼", "钢"],
	zhuī: [
		"錐",
		"锥",
		"騅",
		"骓",
		"鵻"
	],
	ā: ["錒", "锕"],
	"cuō chā": ["鎈"],
	"suǒ sè": ["鎍"],
	"yáo zú": ["鎐"],
	"yè tà gé": ["鎑"],
	"qiāng chēng": ["鎗"],
	"gé lì": [
		"鎘",
		"镉",
		"鬲"
	],
	"bī pī bì": ["鎞"],
	"gǎo hào": ["鎬"],
	"zú chuò": ["鏃"],
	"xiū xiù": ["鏅"],
	"shòu sōu": ["鏉"],
	"dí dī": ["鏑", "镝"],
	"qiāo sǎn càn": ["鏒"],
	"lù áo": ["鏕"],
	"tāng táng": ["鏜"],
	"jiàn zàn": ["鏩"],
	"huì suì ruì": ["鏸"],
	"qiǎng qiāng": ["鏹", "镪"],
	"sǎn xiàn sà": ["鏾"],
	"jiǎn jiàn": ["鐧", "锏"],
	"dāng chēng": ["鐺", "铛"],
	"zuān zuàn": ["鑽"],
	"sà xì": ["钑"],
	"yào yuè": ["钥"],
	"tǒu dǒu": ["钭"],
	"zuàn zuān": ["钻"],
	"qiān yán": ["铅"],
	"pí pī": ["铍"],
	"yáo diào tiáo": ["铫"],
	"tāng tàng": ["铴"],
	"pù pū": ["铺"],
	"tán xiān": ["锬"],
	"liù liú": ["镏"],
	"hào gǎo": ["镐"],
	"táng tāng": ["镗"],
	"tán chán xín": ["镡"],
	"huò shǎn": ["閄"],
	"hàn bì": ["閈", "闬"],
	"kāng kàng": ["閌", "闶"],
	"xián jiàn jiān jiǎn": ["閒"],
	"xiā xiǎ": ["閕"],
	"xiǎ kě": ["閜"],
	"biàn guān": ["閞"],
	"hé gé": ["閤", "颌"],
	"hòng xiàng": ["閧"],
	"sē xī": ["閪"],
	"tíng tǐng": ["閮"],
	"è yān": ["閼", "阏"],
	"hòng juǎn xiàng": ["闂"],
	"bǎn pàn": ["闆"],
	"dū shé": ["闍", "阇"],
	"què quē": ["闕"],
	"tāng táng chāng": ["闛"],
	"kàn hǎn": ["闞", "阚"],
	"xì sè tà": ["闟"],
	"mēn mèn": ["闷"],
	"quē què": ["阙"],
	"yán diàn": ["阽"],
	"ā ē": ["阿"],
	"bēi pō pí": ["陂"],
	"yàn yǎn": ["隁"],
	"yú yáo shù": ["隃"],
	"lóng lōng": ["隆"],
	"duì zhuì": ["隊"],
	"suí duò": ["隋"],
	"gāi qí ái": ["隑"],
	"huī duò": ["隓", "隳"],
	"wěi kuí": ["隗"],
	"lì dài": ["隸"],
	"zhuī cuī wéi": ["隹"],
	"hè hú": ["隺", "鶮"],
	"jùn juàn": ["隽", "雋"],
	"nán nàn nuó": ["难"],
	"què qiāo qiǎo": ["雀"],
	"guàn huán": ["雚"],
	"guī xī": ["雟"],
	"sè xí": ["雭"],
	án: ["雸"],
	"wù méng": ["雺"],
	tèng: ["霯"],
	"lù lòu": ["露"],
	mái: ["霾"],
	"jìng liàng": ["靚"],
	"gé jí": ["革"],
	bǎ: ["靶"],
	"yāng yàng": ["鞅"],
	"gé tà sǎ": ["鞈"],
	"biān yìng": ["鞕"],
	"qiào shāo": ["鞘"],
	"juān xuān": ["鞙"],
	"shàng zhǎng": ["鞝"],
	"pí bǐng bì bēi": ["鞞"],
	la: ["鞡"],
	"xiè dié": ["鞢"],
	ēng: ["鞥"],
	"móu mù": ["鞪"],
	"bì bǐng": ["鞸"],
	"mèi wà": ["韎"],
	rǒu: ["韖"],
	"shè xiè": ["韘"],
	"yùn wēn": ["韫"],
	"dùn dú": ["頓", "顿"],
	duǐ: ["頧"],
	luō: ["頱"],
	"bīn pín": ["頻"],
	yóng: [
		"顒",
		"颙",
		"鰫"
	],
	mān: ["顢", "颟"],
	"jǐng gěng": ["颈"],
	"jié xié jiá": ["颉"],
	"kē ké": ["颏"],
	"pín bīn": ["频"],
	"chàn zhàn": ["颤"],
	"fēng fěng": ["風", "风"],
	"biāo diū": ["颩"],
	"bá fú": ["颰"],
	"sāo sōu": ["颾"],
	"liù liáo": ["飂"],
	"shí sì yì": ["食"],
	"yǎng juàn": ["飬"],
	"zhù tǒu": ["飳"],
	"yí sì": ["飴"],
	"zuò zé zhā": ["飵"],
	tiè: ["飻", "餮"],
	"xiǎng náng": ["饟"],
	"táng xíng": ["饧"],
	"gē le": ["饹"],
	"chā zha": ["馇"],
	"náng nǎng": ["馕"],
	"yūn wò": ["馧"],
	"zhī shì": ["馶"],
	"xìn jìn": ["馸"],
	"kuài jué": ["駃"],
	zǎng: ["駔", "驵"],
	"tái dài": ["駘"],
	"xún xuān": ["駨"],
	"liáng láng": ["駺"],
	piàn: [
		"騗",
		"騙",
		"骗",
		"魸"
	],
	"dài tái": ["骀"],
	"sāo sǎo": ["骚"],
	"gǔ gū": ["骨"],
	"bèi mó": ["骳"],
	"xiāo qiāo": ["骹"],
	"bǎng pǎng": ["髈"],
	"bó jué": ["髉"],
	"bì pǒ": ["髲"],
	"máo méng": ["髳"],
	"kuò yuè": ["髺"],
	"bā bà": ["魞", "鲃"],
	"jì cǐ": ["鮆"],
	"bó bà": ["鮊"],
	"zhǎ zhà": ["鮓", "鲊"],
	"chóu dài": ["鮘"],
	"luò gé": ["鮥"],
	"guī xié wā kuí": ["鮭"],
	"xiān xiǎn": ["鮮", "鲜"],
	"pū bū": ["鯆"],
	"yì sī": ["鯣"],
	"bà bó": ["鲌"],
	"guī xié": ["鲑"],
	"sāi xǐ": ["鳃"],
	"niǎo diǎo": ["鳥"],
	"diāo zhāo": ["鳭"],
	"gān hàn yàn": ["鳱"],
	"fū guī": ["鳺"],
	"jiān qiān zhān": ["鳽"],
	"hé jiè": ["鶡"],
	"piān biǎn": ["鶣"],
	"chuàn zhì": ["鶨"],
	"cāng qiāng": ["鶬"],
	"sǔn xùn": ["鶽"],
	"biāo páo": ["麃"],
	"zhù cū": ["麆"],
	"jūn qún": ["麇", "麕"],
	chi: ["麶"],
	"mó me": ["麼"],
	"mó me ma": ["麽"],
	"mí mǒ": ["麿"],
	"dàn shèn": ["黮"],
	"zhěn yān": ["黰"],
	"dǎn zhǎn": ["黵"],
	"miǎn mǐn měng": ["黾"],
	hōu: ["齁"],
	nàng: ["齉"],
	"qí jì zī zhāi": ["齐"],
	"yín kěn yǎn": ["龂"],
	"yín kěn": ["龈"],
	"gōng wò": ["龏"],
	"guī jūn qiū": ["龜", "龟"],
	"kuí wā": ["䖯"],
	lōu: ["䁖"],
	"ōu qū": ["𫭟"],
	"lóu lǘ": ["𦝼"],
	"gǎ gā gá": ["嘎"],
	"wā guà": ["坬"],
	"zhǐ dǐ": ["茋"],
	"gǒng hóng": ["硔"],
	"yáo xiào": ["滧"]
};
const DICT1 = new FastDictFactory();
Object.keys(map).forEach((key) => {
	const chars = map[key];
	for (let char of chars) DICT1.set(char, key);
});
//#endregion
//#region ../../node_modules/.pnpm/pinyin-pro@3.29.5/node_modules/pinyin-pro/dist/esm/core/custom/state.mjs
const customMultipleDict = new FastDictFactory();
new FastDictFactory();
//#endregion
//#region ../../node_modules/.pnpm/pinyin-pro@3.29.5/node_modules/pinyin-pro/dist/esm/data/surname.mjs
const Surnames = {
	南宫: "nán gōng",
	第五: "dì wǔ",
	万俟: "mò qí",
	司马: "sī mǎ",
	上官: "shàng guān",
	欧阳: "ōu yáng",
	夏侯: "xià hóu",
	诸葛: "zhū gě",
	闻人: "wén rén",
	东方: "dōng fāng",
	赫连: "hè lián",
	皇甫: "huáng fǔ",
	尉迟: "yù chí",
	公羊: "gōng yáng",
	澹台: "tán tái",
	公冶: "gōng yě",
	宗政: "zōng zhèng",
	濮阳: "pú yáng",
	淳于: "chún yú",
	太叔: "tài shū",
	申屠: "shēn tú",
	公孙: "gōng sūn",
	仲孙: "zhòng sūn",
	轩辕: "xuān yuán",
	令狐: "líng hú",
	钟离: "zhōng lí",
	宇文: "yǔ wén",
	长孙: "zhǎng sūn",
	慕容: "mù róng",
	鲜于: "xiān yú",
	闾丘: "lǘ qiū",
	司徒: "sī tú",
	司空: "sī kōng",
	亓官: "qí guān",
	司寇: "sī kòu",
	仉督: "zhǎng dū",
	子车: "zǐ jū",
	颛孙: "zhuān sūn",
	端木: "duān mù",
	巫马: "wū mǎ",
	公西: "gōng xī",
	漆雕: "qī diāo",
	乐正: "yuè zhèng",
	壤驷: "rǎng sì",
	公良: "gōng liáng",
	拓跋: "tuò bá",
	夹谷: "jiá gǔ",
	宰父: "zǎi fǔ",
	榖梁: "gǔ liáng",
	段干: "duàn gān",
	百里: "bǎi lǐ",
	东郭: "dōng guō",
	南门: "nán mén",
	呼延: "hū yán",
	羊舌: "yáng shé",
	梁丘: "liáng qiū",
	左丘: "zuǒ qiū",
	东门: "dōng mén",
	西门: "xī mén",
	句龙: "gōu lóng",
	毌丘: "guàn qiū",
	赵: "zhào",
	钱: "qián",
	孙: "sūn",
	李: "lǐ",
	周: "zhōu",
	吴: "wú",
	郑: "zhèng",
	王: "wáng",
	冯: "féng",
	陈: "chén",
	褚: "chǔ",
	卫: "wèi",
	蒋: "jiǎng",
	沈: "shěn",
	韩: "hán",
	杨: "yáng",
	朱: "zhū",
	秦: "qín",
	尤: "yóu",
	许: "xǔ",
	何: "hé",
	吕: "lǚ",
	施: "shī",
	张: "zhāng",
	孔: "kǒng",
	曹: "cáo",
	严: "yán",
	华: "huà",
	金: "jīn",
	魏: "wèi",
	陶: "táo",
	姜: "jiāng",
	戚: "qī",
	谢: "xiè",
	邹: "zōu",
	喻: "yù",
	柏: "bǎi",
	水: "shuǐ",
	窦: "dòu",
	章: "zhāng",
	云: "yún",
	苏: "sū",
	潘: "pān",
	葛: "gě",
	奚: "xī",
	范: "fàn",
	彭: "péng",
	郎: "láng",
	鲁: "lǔ",
	韦: "wéi",
	昌: "chāng",
	马: "mǎ",
	苗: "miáo",
	凤: "fèng",
	花: "huā",
	方: "fāng",
	俞: "yú",
	任: "rén",
	袁: "yuán",
	柳: "liǔ",
	酆: "fēng",
	鲍: "bào",
	史: "shǐ",
	唐: "táng",
	费: "fèi",
	廉: "lián",
	岑: "cén",
	薛: "xuē",
	雷: "léi",
	贺: "hè",
	倪: "ní",
	汤: "tāng",
	滕: "téng",
	殷: "yīn",
	罗: "luó",
	毕: "bì",
	郝: "hǎo",
	邬: "wū",
	安: "ān",
	常: "cháng",
	乐: "yuè",
	于: "yú",
	时: "shí",
	傅: "fù",
	皮: "pí",
	卞: "biàn",
	齐: "qí",
	康: "kāng",
	伍: "wǔ",
	余: "yú",
	元: "yuán",
	卜: "bǔ",
	顾: "gù",
	孟: "mèng",
	平: "píng",
	黄: "huáng",
	和: "hé",
	穆: "mù",
	萧: "xiāo",
	尹: "yǐn",
	姚: "yáo",
	邵: "shào",
	湛: "zhàn",
	汪: "wāng",
	祁: "qí",
	毛: "máo",
	禹: "yǔ",
	狄: "dí",
	米: "mǐ",
	贝: "bèi",
	明: "míng",
	臧: "zāng",
	计: "jì",
	伏: "fú",
	成: "chéng",
	戴: "dài",
	谈: "tán",
	宋: "sòng",
	茅: "máo",
	庞: "páng",
	熊: "xióng",
	纪: "jǐ",
	舒: "shū",
	屈: "qū",
	项: "xiàng",
	祝: "zhù",
	董: "dǒng",
	梁: "liáng",
	杜: "dù",
	阮: "ruǎn",
	蓝: "lán",
	闵: "mǐn",
	席: "xí",
	季: "jì",
	麻: "má",
	强: "qiáng",
	贾: "jiǎ",
	路: "lù",
	娄: "lóu",
	危: "wēi",
	江: "jiāng",
	童: "tóng",
	颜: "yán",
	郭: "guō",
	梅: "méi",
	盛: "shèng",
	林: "lín",
	刁: "diāo",
	钟: "zhōng",
	徐: "xú",
	邱: "qiū",
	骆: "luò",
	高: "gāo",
	夏: "xià",
	蔡: "cài",
	田: "tián",
	樊: "fán",
	胡: "hú",
	凌: "líng",
	霍: "huò",
	虞: "yú",
	万: "wàn",
	支: "zhī",
	柯: "kē",
	昝: "zǎn",
	管: "guǎn",
	卢: "lú",
	莫: "mò",
	经: "jīng",
	房: "fáng",
	裘: "qiú",
	缪: "miào",
	干: "gān",
	解: "xiè",
	应: "yīng",
	宗: "zōng",
	丁: "dīng",
	宣: "xuān",
	贲: "bēn",
	邓: "dèng",
	郁: "yù",
	单: "shàn",
	杭: "háng",
	洪: "hóng",
	包: "bāo",
	诸: "zhū",
	左: "zuǒ",
	石: "shí",
	崔: "cuī",
	吉: "jí",
	钮: "niǔ",
	龚: "gōng",
	程: "chéng",
	嵇: "jī",
	邢: "xíng",
	滑: "huá",
	裴: "péi",
	陆: "lù",
	荣: "róng",
	翁: "wēng",
	荀: "xún",
	羊: "yáng",
	於: "yū",
	惠: "huì",
	甄: "zhēn",
	曲: "qū",
	家: "jiā",
	封: "fēng",
	芮: "ruì",
	羿: "yì",
	储: "chǔ",
	靳: "jìn",
	汲: "jí",
	邴: "bǐng",
	糜: "mí",
	松: "sōng",
	井: "jǐng",
	段: "duàn",
	富: "fù",
	巫: "wū",
	乌: "wū",
	焦: "jiāo",
	巴: "bā",
	弓: "gōng",
	牧: "mù",
	隗: "wěi",
	山: "shān",
	谷: "gǔ",
	车: "chē",
	侯: "hóu",
	宓: "mì",
	蓬: "péng",
	全: "quán",
	郗: "xī",
	班: "bān",
	仰: "yǎng",
	秋: "qiū",
	仲: "zhòng",
	伊: "yī",
	宫: "gōng",
	宁: "nìng",
	仇: "qiú",
	栾: "luán",
	暴: "bào",
	甘: "gān",
	钭: "tǒu",
	厉: "lì",
	戎: "róng",
	祖: "zǔ",
	武: "wǔ",
	符: "fú",
	刘: "liú",
	景: "jǐng",
	詹: "zhān",
	束: "shù",
	龙: "lóng",
	叶: "yè",
	幸: "xìng",
	司: "sī",
	韶: "sháo",
	郜: "gào",
	黎: "lí",
	蓟: "jì",
	薄: "bó",
	印: "yìn",
	宿: "sù",
	白: "bái",
	怀: "huái",
	蒲: "pú",
	邰: "tái",
	从: "cóng",
	鄂: "è",
	索: "suǒ",
	咸: "xián",
	籍: "jí",
	赖: "lài",
	卓: "zhuó",
	蔺: "lìn",
	屠: "tú",
	蒙: "méng",
	池: "chí",
	乔: "qiáo",
	阴: "yīn",
	鬱: "yù",
	胥: "xū",
	能: "nài",
	苍: "cāng",
	双: "shuāng",
	闻: "wén",
	莘: "shēn",
	党: "dǎng",
	翟: "zhái",
	谭: "tán",
	贡: "gòng",
	劳: "láo",
	逄: "páng",
	姬: "jī",
	申: "shēn",
	扶: "fú",
	堵: "dǔ",
	冉: "rǎn",
	宰: "zǎi",
	郦: "lì",
	雍: "yōng",
	郤: "xì",
	璩: "qú",
	桑: "sāng",
	桂: "guì",
	濮: "pú",
	牛: "niú",
	寿: "shòu",
	通: "tōng",
	边: "biān",
	扈: "hù",
	燕: "yān",
	冀: "jì",
	郏: "jiá",
	浦: "pǔ",
	尚: "shàng",
	农: "nóng",
	温: "wēn",
	别: "bié",
	庄: "zhuāng",
	晏: "yàn",
	柴: "chái",
	瞿: "qú",
	阎: "yán",
	充: "chōng",
	慕: "mù",
	连: "lián",
	茹: "rú",
	习: "xí",
	宦: "huàn",
	艾: "ài",
	鱼: "yú",
	容: "róng",
	向: "xiàng",
	古: "gǔ",
	易: "yì",
	慎: "shèn",
	戈: "gē",
	廖: "liào",
	庾: "yǔ",
	终: "zhōng",
	暨: "jì",
	居: "jū",
	衡: "héng",
	步: "bù",
	都: "dū",
	耿: "gěng",
	满: "mǎn",
	弘: "hóng",
	匡: "kuāng",
	国: "guó",
	文: "wén",
	寇: "kòu",
	广: "guǎng",
	禄: "lù",
	阙: "quē",
	东: "dōng",
	欧: "ōu",
	殳: "shū",
	沃: "wò",
	利: "lì",
	蔚: "wèi",
	越: "yuè",
	夔: "kuí",
	隆: "lóng",
	师: "shī",
	巩: "gǒng",
	厍: "shè",
	聂: "niè",
	晁: "cháo",
	勾: "gōu",
	敖: "áo",
	融: "róng",
	冷: "lěng",
	訾: "zī",
	辛: "xīn",
	阚: "kàn",
	那: "nā",
	简: "jiǎn",
	饶: "ráo",
	空: "kōng",
	曾: "zēng",
	母: "mǔ",
	沙: "shā",
	乜: "niè",
	养: "yǎng",
	鞠: "jū",
	须: "xū",
	丰: "fēng",
	巢: "cháo",
	关: "guān",
	蒯: "kuǎi",
	相: "xiàng",
	查: "zhā",
	后: "hòu",
	荆: "jīng",
	红: "hóng",
	游: "yóu",
	竺: "zhú",
	权: "quán",
	逯: "lù",
	盖: "gě",
	益: "yì",
	桓: "huán",
	公: "gōng",
	牟: "móu",
	哈: "hǎ",
	言: "yán",
	福: "fú",
	肖: "xiāo",
	区: "ōu",
	覃: "qín",
	朴: "piáo",
	繁: "pó",
	员: "yùn",
	句: "gōu",
	要: "yāo",
	过: "guō",
	钻: "zuān",
	谌: "chén",
	折: "shé",
	召: "shào",
	郄: "qiè",
	撒: "sǎ",
	甯: "nìng",
	六: "lù",
	啜: "chuài",
	行: "xíng"
};
const PatternSurname = Object.keys(Surnames).map((key) => ({
	zh: key,
	pinyin: Surnames[key],
	probability: 1 + stringLength(key),
	length: stringLength(key),
	priority: Priority.Surname,
	dict: Symbol("surname")
}));
//#endregion
//#region ../../node_modules/.pnpm/pinyin-pro@3.29.5/node_modules/pinyin-pro/dist/esm/core/pinyin/all.mjs
/** 获取单字的全部拼音，供 pinyin、polyphonic 和 match 复用。 */
const getAllPinyin = (char, surname = "off") => {
	let pinyin = DICT1.get(char) ? DICT1.get(char).split(" ") : [];
	if (customMultipleDict.get(char)) pinyin = customMultipleDict.get(char).split(" ");
	else if (surname !== "off") {
		const surnamePinyin = Surnames[char];
		if (surnamePinyin) pinyin = [surnamePinyin].concat(pinyin.filter((py) => py !== surnamePinyin));
	}
	return pinyin;
};
//#endregion
//#region ../../node_modules/.pnpm/pinyin-pro@3.29.5/node_modules/pinyin-pro/dist/esm/data/dict2.mjs
const DICT2 = {
	这个: "zhè ge",
	成为: "chéng wéi",
	认为: "rèn wéi",
	作为: "zuò wéi",
	部分: "bù fen",
	要求: "yāo qiú",
	应该: "yīng gāi",
	增长: "zēng zhǎng",
	提供: "tí gōng",
	觉得: "jué de",
	任务: "rèn wu",
	那个: "nà ge",
	称为: "chēng wéi",
	为主: "wéi zhǔ",
	了解: "liǎo jiě",
	处理: "chǔ lǐ",
	皇上: "huáng shang",
	只要: "zhǐ yào",
	大量: "dà liàng",
	力量: "lì liàng",
	几乎: "jī hū",
	干部: "gàn bù",
	目的: "mù dì",
	行为: "xíng wéi",
	只见: "zhǐ jiàn",
	认识: "rèn shi",
	市长: "shì zhǎng",
	师父: "shī fu",
	调查: "diào chá",
	重新: "chóng xīn",
	分为: "fēn wéi",
	知识: "zhī shi",
	导弹: "dǎo dàn",
	质量: "zhì liàng",
	行款: "háng kuǎn",
	行列: "háng liè",
	行话: "háng huà",
	行业: "háng yè",
	隔行: "gé háng",
	在行: "zài háng",
	行家: "háng jia",
	内行: "nèi háng",
	外行: "wài háng",
	同行: "tóng háng",
	本行: "běn háng",
	行伍: "háng wǔ",
	洋行: "yáng háng",
	银行: "yín háng",
	商行: "shāng háng",
	支行: "zhī háng",
	总行: "zǒng háng",
	行情: "háng qíng",
	懂行: "dǒng háng",
	行规: "háng guī",
	行当: "háng dang",
	行货: "háng huò",
	太行: "tài háng",
	入行: "rù háng",
	中行: "zhōng háng",
	农行: "nóng háng",
	工行: "gōng háng",
	建行: "jiàn háng",
	各行: "gè háng",
	行号: "háng hào",
	行高: "háng gāo",
	行首: "háng shǒu",
	行尾: "háng wěi",
	行末: "háng mò",
	行长: "háng zhǎng",
	行距: "háng jù",
	换行: "huàn háng",
	行会: "háng huì",
	行辈: "háng bèi",
	行道: "háng dào",
	道行: "dào heng",
	参与: "cān yù",
	充分: "chōng fèn",
	尽管: "jǐn guǎn",
	生长: "shēng zhǎng",
	数量: "shù liàng",
	应当: "yīng dāng",
	院长: "yuàn zhǎng",
	强调: "qiáng diào",
	只能: "zhǐ néng",
	音乐: "yīn yuè",
	以为: "yǐ wéi",
	处于: "chǔ yú",
	部长: "bù zhǎng",
	蒙古: "měng gǔ",
	只有: "zhǐ yǒu",
	适当: "shì dàng",
	只好: "zhǐ hǎo",
	成长: "chéng zhǎng",
	高兴: "gāo xìng",
	不了: "bù liǎo",
	产量: "chǎn liàng",
	胖子: "pàng zi",
	显得: "xiǎn de",
	只是: "zhǐ shì",
	似的: "shì de",
	率领: "shuài lǐng",
	改为: "gǎi wéi",
	不禁: "bù jīn",
	成分: "chéng fèn",
	答应: "dā ying",
	少年: "shào nián",
	兴趣: "xìng qù",
	太监: "tài jian",
	休息: "xiū xi",
	校长: "xiào zhǎng",
	更新: "gēng xīn",
	合同: "hé tong",
	喝道: "hè dào",
	重庆: "chóng qìng",
	重建: "chóng jiàn",
	使得: "shǐ de",
	审查: "shěn chá",
	累计: "lěi jì",
	给予: "jǐ yǔ",
	极为: "jí wéi",
	冠军: "guàn jūn",
	仿佛: "fǎng fú",
	头发: "tóu fa",
	投降: "tóu xiáng",
	家长: "jiā zhǎng",
	仔细: "zǐ xì",
	要是: "yào shi",
	将领: "jiàng lǐng",
	含量: "hán liàng",
	更为: "gèng wéi",
	积累: "jī lěi",
	地处: "dì chǔ",
	县长: "xiàn zhǎng",
	少女: "shào nǚ",
	路上: "lù shang",
	只怕: "zhǐ pà",
	能量: "néng liàng",
	储量: "chǔ liàng",
	供应: "gōng yìng",
	挑战: "tiǎo zhàn",
	西藏: "xī zàng",
	记得: "jì de",
	总量: "zǒng liàng",
	当真: "dàng zhēn",
	将士: "jiàng shì",
	差别: "chā bié",
	较为: "jiào wéi",
	长老: "zhǎng lǎo",
	大夫: "dài fu",
	差异: "chā yì",
	懂得: "dǒng de",
	尽量: "jǐn liàng",
	模样: "mú yàng",
	的确: "dí què",
	为首: "wéi shǒu",
	便宜: "pián yi",
	更名: "gēng míng",
	石头: "shí tou",
	州长: "zhōu zhǎng",
	为止: "wéi zhǐ",
	漂亮: "piào liang",
	炮弹: "pào dàn",
	藏族: "zàng zú",
	角色: "jué sè",
	当作: "dàng zuò",
	尽快: "jǐn kuài",
	人为: "rén wéi",
	重复: "chóng fù",
	胡同: "hú tòng",
	差距: "chā jù",
	弟兄: "dì xiong",
	大将: "dà jiàng",
	睡觉: "shuì jiào",
	一觉: "yí jiào",
	团长: "tuán zhǎng",
	队长: "duì zhǎng",
	区长: "qū zhǎng",
	难得: "nán dé",
	丫头: "yā tou",
	会长: "huì zhǎng",
	弟弟: "dì di",
	王爷: "wáng ye",
	重量: "zhòng liàng",
	誉为: "yù wéi",
	家伙: "jiā huo",
	华山: "huà shān",
	椅子: "yǐ zi",
	流量: "liú liàng",
	长大: "zhǎng dà",
	勉强: "miǎn qiǎng",
	会计: "kuài jì",
	过分: "guò fèn",
	济南: "jǐ nán",
	调动: "diào dòng",
	燕京: "yān jīng",
	少将: "shào jiàng",
	中毒: "zhòng dú",
	晓得: "xiǎo de",
	变更: "biàn gēng",
	打更: "dǎ gēng",
	认得: "rèn de",
	苹果: "píng guǒ",
	念头: "niàn tou",
	挣扎: "zhēng zhá",
	三藏: "sān zàng",
	剥削: "bō xuē",
	丞相: "chéng xiàng",
	少量: "shǎo liàng",
	寻思: "xún si",
	夺得: "duó dé",
	干线: "gàn xiàn",
	呼吁: "hū yù",
	处罚: "chǔ fá",
	长官: "zhǎng guān",
	柏林: "bó lín",
	亲戚: "qīn qi",
	身分: "shēn fèn",
	胳膊: "gē bo",
	着手: "zhuó shǒu",
	炸弹: "zhà dàn",
	咳嗽: "ké sou",
	叶子: "yè zi",
	外长: "wài zhǎng",
	供给: "gōng jǐ",
	师长: "shī zhǎng",
	变量: "biàn liàng",
	应有: "yīng yǒu",
	下载: "xià zài",
	乐器: "yuè qì",
	间接: "jiàn jiē",
	底下: "dǐ xià",
	打扮: "dǎ bàn",
	子弹: "zǐ dàn",
	弹药: "dàn yào",
	热量: "rè liàng",
	削弱: "xuē ruò",
	骨干: "gǔ gàn",
	容量: "róng liàng",
	模糊: "mó hu",
	转动: "zhuàn dòng",
	称呼: "chēng hu",
	科长: "kē zhǎng",
	处置: "chǔ zhì",
	着重: "zhuó zhòng",
	着急: "zháo jí",
	强迫: "qiǎng pò",
	庭长: "tíng zhǎng",
	首相: "shǒu xiàng",
	喇嘛: "lǎ ma",
	镇长: "zhèn zhǎng",
	只管: "zhǐ guǎn",
	重重: "chóng chóng",
	免得: "miǎn de",
	着实: "zhuó shí",
	度假: "dù jià",
	真相: "zhēn xiàng",
	相貌: "xiàng mào",
	处分: "chǔ fèn",
	委屈: "wěi qu",
	为期: "wéi qī",
	伯伯: "bó bo",
	伯子: "bǎi zi",
	圈子: "quān zi",
	见识: "jiàn shi",
	笼罩: "lǒng zhào",
	与会: "yù huì",
	都督: "dū du",
	都市: "dū shì",
	成都: "chéng dū",
	首都: "shǒu dū",
	帝都: "dì dū",
	王都: "wáng dū",
	东都: "dōng dū",
	都护: "dū hù",
	都城: "dū chéng",
	建都: "jiàn dū",
	迁都: "qiān dū",
	故都: "gù dū",
	定都: "dìng dū",
	中都: "zhōng dū",
	六安: "lù ān",
	宰相: "zǎi xiàng",
	较量: "jiào liàng",
	对称: "duì chèn",
	总长: "zǒng zhǎng",
	相公: "xiàng gong",
	空白: "kòng bái",
	打量: "dǎ liang",
	水分: "shuǐ fèn",
	舌头: "shé tou",
	没收: "mò shōu",
	行李: "xíng li",
	判处: "pàn chǔ",
	散文: "sǎn wén",
	处境: "chǔ jìng",
	孙子: "sūn zi",
	拳头: "quán tou",
	打发: "dǎ fā",
	组长: "zǔ zhǎng",
	骨头: "gǔ tou",
	宁可: "nìng kě",
	更换: "gēng huàn",
	薄弱: "bó ruò",
	还原: "huán yuán",
	重修: "chóng xiū",
	重来: "chóng lái",
	只顾: "zhǐ gù",
	爱好: "ài hào",
	馒头: "mán tou",
	军长: "jūn zhǎng",
	首长: "shǒu zhǎng",
	厂长: "chǎng zhǎng",
	司长: "sī zhǎng",
	长子: "zhǎng zǐ",
	强劲: "qiáng jìng",
	恰当: "qià dàng",
	头儿: "tóu er",
	站长: "zhàn zhǎng",
	折腾: "zhē teng",
	相处: "xiāng chǔ",
	统率: "tǒng shuài",
	中将: "zhōng jiàng",
	命中: "mìng zhòng",
	名将: "míng jiàng",
	木头: "mù tou",
	动弹: "dòng tan",
	地壳: "dì qiào",
	干活: "gàn huó",
	少爷: "shào ye",
	水量: "shuǐ liàng",
	补给: "bǔ jǐ",
	尾巴: "wěi ba",
	来得: "lái de",
	好奇: "hào qí",
	钥匙: "yào shi",
	当做: "dàng zuò",
	沉着: "chén zhuó",
	哑巴: "yǎ ba",
	车子: "chē zi",
	上将: "shàng jiàng",
	恶心: "ě xīn",
	担子: "dàn zi",
	应届: "yīng jiè",
	主角: "zhǔ jué",
	运转: "yùn zhuǎn",
	兄长: "xiōng zhǎng",
	格式: "gé shì",
	正月: "zhēng yuè",
	营长: "yíng zhǎng",
	当成: "dàng chéng",
	女婿: "nǚ xu",
	咽喉: "yān hóu",
	重阳: "chóng yáng",
	化为: "huà wéi",
	吐蕃: "tǔ bō",
	钻进: "zuān jìn",
	乐队: "yuè duì",
	亮相: "liàng xiàng",
	被子: "bèi zi",
	舍得: "shě de",
	杉木: "shā mù",
	击中: "jī zhòng",
	排长: "pái zhǎng",
	假期: "jià qī",
	分量: "fèn liàng",
	数次: "shù cì",
	提防: "dī fáng",
	吆喝: "yāo he",
	查处: "chá chǔ",
	量子: "liàng zǐ",
	里头: "lǐ tou",
	调研: "diào yán",
	伺候: "cì hou",
	重申: "chóng shēn",
	枕头: "zhěn tou",
	拚命: "pīn mìng",
	社长: "shè zhǎng",
	归还: "guī huán",
	批量: "pī liàng",
	畜牧: "xù mù",
	点着: "diǎn zháo",
	甚为: "shèn wéi",
	小将: "xiǎo jiàng",
	着眼: "zhuó yǎn",
	处死: "chǔ sǐ",
	厌恶: "yàn wù",
	鼓乐: "gǔ yuè",
	树干: "shù gàn",
	秘鲁: "bì lǔ",
	大方: "dà fāng",
	外头: "wài tou",
	班长: "bān zhǎng",
	星宿: "xīng xiù",
	宁愿: "nìng yuàn",
	钦差: "qīn chāi",
	为数: "wéi shù",
	勾当: "gòu dàng",
	削减: "xuē jiǎn",
	间谍: "jiàn dié",
	埋怨: "mán yuàn",
	结实: "jiē shi",
	计量: "jì liáng",
	淹没: "yān mò",
	村长: "cūn zhǎng",
	连长: "lián zhǎng",
	自给: "zì jǐ",
	武将: "wǔ jiàng",
	温差: "wēn chā",
	直奔: "zhí bèn",
	供求: "gōng qiú",
	剂量: "jì liàng",
	道长: "dào zhǎng",
	泄露: "xiè lòu",
	王八: "wáng ba",
	切割: "qiē gē",
	间隔: "jiàn gé",
	一晃: "yì huǎng",
	长假: "cháng jià",
	令狐: "líng hú",
	为害: "wéi hài",
	句子: "jù zi",
	偿还: "cháng huán",
	疙瘩: "gē da",
	燕山: "yān shān",
	堵塞: "dǔ sè",
	夺冠: "duó guàn",
	扎实: "zhā shi",
	电荷: "diàn hè",
	看守: "kān shǒu",
	复辟: "fù bì",
	郁闷: "yù mèn",
	尽早: "jǐn zǎo",
	切断: "qiē duàn",
	指头: "zhǐ tou",
	为生: "wéi shēng",
	畜生: "chù sheng",
	切除: "qiē chú",
	着力: "zhuó lì",
	着想: "zhuó xiǎng",
	级差: "jí chā",
	投奔: "tóu bèn",
	棍子: "gùn zi",
	含糊: "hán hu",
	少妇: "shào fù",
	兴致: "xìng zhì",
	纳闷: "nà mèn",
	干流: "gàn liú",
	卷起: "juǎn qǐ",
	扇子: "shàn zi",
	更改: "gēng gǎi",
	笼络: "lǒng luò",
	喇叭: "lǎ ba",
	载荷: "zài hè",
	妥当: "tuǒ dàng",
	为难: "wéi nán",
	着陆: "zhuó lù",
	燕子: "yàn zi",
	干吗: "gàn má",
	白发: "bái fà",
	总得: "zǒng děi",
	夹击: "jiā jī",
	曝光: "bào guāng",
	曲调: "qǔ diào",
	相机: "xiàng jī",
	叫化: "jiào huà",
	角逐: "jué zhú",
	啊哟: "ā yō",
	载重: "zài zhòng",
	长辈: "zhǎng bèi",
	出差: "chū chāi",
	垛口: "duǒ kǒu",
	撇开: "piē kāi",
	厅长: "tīng zhǎng",
	组分: "zǔ fèn",
	误差: "wù chā",
	家当: "jiā dàng",
	传记: "zhuàn jì",
	个子: "gè zi",
	铺设: "pū shè",
	干事: "gàn shì",
	杆菌: "gǎn jūn",
	定量: "dìng liàng",
	运载: "yùn zài",
	会儿: "huì er",
	酋长: "qiú zhǎng",
	重返: "chóng fǎn",
	差额: "chā é",
	露面: "lòu miàn",
	钻研: "zuān yán",
	大城: "dài chéng",
	上当: "shàng dàng",
	销量: "xiāo liàng",
	作坊: "zuō fang",
	照相: "zhào xiàng",
	哎呀: "āi yā",
	调集: "diào jí",
	看中: "kàn zhòng",
	议长: "yì zhǎng",
	风筝: "fēng zheng",
	辟邪: "bì xié",
	空隙: "kòng xì",
	更迭: "gēng dié",
	偏差: "piān chā",
	声调: "shēng diào",
	适量: "shì liàng",
	屯子: "tún zi",
	无量: "wú liàng",
	空地: "kòng dì",
	调度: "diào dù",
	散射: "sǎn shè",
	创伤: "chuāng shāng",
	海参: "hǎi shēn",
	满载: "mǎn zài",
	重叠: "chóng dié",
	落差: "luò chā",
	单调: "dān diào",
	老将: "lǎo jiàng",
	人参: "rén shēn",
	间断: "jiàn duàn",
	重现: "chóng xiàn",
	夹杂: "jiā zá",
	调用: "diào yòng",
	萝卜: "luó bo",
	附着: "fù zhuó",
	应声: "yìng shēng",
	主将: "zhǔ jiàng",
	罪过: "zuì guo",
	咀嚼: "jǔ jué",
	为政: "wéi zhèng",
	过量: "guò liàng",
	乐曲: "yuè qǔ",
	负荷: "fù hè",
	枪弹: "qiāng dàn",
	悄然: "qiǎo rán",
	处方: "chǔ fāng",
	悄声: "qiǎo shēng",
	曲子: "qǔ zi",
	情调: "qíng diào",
	挑衅: "tiǎo xìn",
	代为: "dài wéi",
	了结: "liǎo jié",
	打中: "dǎ zhòng",
	酒吧: "jiǔ bā",
	懒得: "lǎn de",
	增量: "zēng liàng",
	衣着: "yī zhuó",
	部将: "bù jiàng",
	要塞: "yào sài",
	茶几: "chá jī",
	杠杆: "gàng gǎn",
	出没: "chū mò",
	鲜有: "xiǎn yǒu",
	间隙: "jiàn xì",
	重担: "zhòng dàn",
	重演: "chóng yǎn",
	重试: "chóng shì",
	应酬: "yìng chou",
	只当: "zhǐ dāng",
	毋宁: "wú nìng",
	包扎: "bāo zā",
	前头: "qián tou",
	卷烟: "juǎn yān",
	非得: "fēi děi",
	弹道: "dàn dào",
	杆子: "gān zi",
	门将: "mén jiàng",
	后头: "hòu tou",
	喝彩: "hè cǎi",
	暖和: "nuǎn huo",
	累积: "lěi jī",
	调遣: "diào qiǎn",
	倔强: "jué jiàng",
	宝藏: "bǎo zàng",
	丧事: "sāng shì",
	约莫: "yuē mo",
	纤夫: "qiàn fū",
	更替: "gēng tì",
	装载: "zhuāng zài",
	背包: "bēi bāo",
	帖子: "tiě zi",
	松散: "sōng sǎn",
	呼喝: "hū hè",
	可恶: "kě wù",
	自转: "zì zhuàn",
	供电: "gōng diàn",
	反省: "fǎn xǐng",
	坦率: "tǎn shuài",
	苏打: "sū dá",
	本分: "běn fèn",
	落得: "luò de",
	鄙薄: "bǐ bó",
	相间: "xiāng jiàn",
	单薄: "dān bó",
	混蛋: "hún dàn",
	贞观: "zhēn guān",
	附和: "fù hè",
	能耐: "néng nài",
	吓唬: "xià hu",
	未了: "wèi liǎo",
	引着: "yǐn zháo",
	抽调: "chōu diào",
	沙子: "shā zi",
	席卷: "xí juǎn",
	标的: "biāo dì",
	别扭: "biè niu",
	思量: "sī liang",
	喝采: "hè cǎi",
	论语: "lún yǔ",
	盖子: "gài zi",
	分外: "fèn wài",
	弄堂: "lòng táng",
	乐舞: "yuè wǔ",
	雨量: "yǔ liàng",
	毛发: "máo fà",
	差遣: "chāi qiǎn",
	背负: "bēi fù",
	转速: "zhuàn sù",
	声乐: "shēng yuè",
	夹攻: "jiā gōng",
	供水: "gōng shuǐ",
	主干: "zhǔ gàn",
	惩处: "chéng chǔ",
	长相: "zhǎng xiàng",
	公差: "gōng chāi",
	榴弹: "liú dàn",
	省得: "shěng de",
	条子: "tiáo zi",
	重围: "chóng wéi",
	阻塞: "zǔ sè",
	劲风: "jìng fēng",
	纠葛: "jiū gé",
	颠簸: "diān bǒ",
	点中: "diǎn zhòng",
	重创: "zhòng chuāng",
	姥姥: "lǎo lao",
	迷糊: "mí hu",
	公家: "gōng jia",
	几率: "jī lǜ",
	苦闷: "kǔ mèn",
	度量: "dù liàng",
	差错: "chā cuò",
	暑假: "shǔ jià",
	参差: "cēn cī",
	搭载: "dā zài",
	助长: "zhù zhǎng",
	相称: "xiāng chèn",
	红晕: "hóng yùn",
	舍命: "shě mìng",
	喜好: "xǐ hào",
	列传: "liè zhuàn",
	劲敌: "jìng dí",
	蛤蟆: "há ma",
	请假: "qǐng jià",
	钉子: "dīng zi",
	沉没: "chén mò",
	高丽: "gāo lí",
	休假: "xiū jià",
	无为: "wú wéi",
	巴结: "bā jie",
	了得: "liǎo dé",
	变相: "biàn xiàng",
	核弹: "hé dàn",
	亲家: "qìng jia",
	承载: "chéng zài",
	喝问: "hè wèn",
	还击: "huán jī",
	交还: "jiāo huán",
	将令: "jiàng lìng",
	单于: "chán yú",
	空缺: "kòng quē",
	绿林: "lù lín",
	胆量: "dǎn liàng",
	执着: "zhí zhuó",
	低调: "dī diào",
	闭塞: "bì sè",
	轻薄: "qīng bó",
	得当: "dé dàng",
	占卜: "zhān bǔ",
	扫帚: "sào zhou",
	龟兹: "qiū cí",
	年长: "nián zhǎng",
	外传: "wài zhuàn",
	头子: "tóu zi",
	裁缝: "cái feng",
	礼乐: "lǐ yuè",
	血泊: "xuè pō",
	散乱: "sǎn luàn",
	动量: "dòng liàng",
	倒腾: "dǎo teng",
	取舍: "qǔ shě",
	咱家: "zán jiā",
	长发: "cháng fà",
	爪哇: "zhǎo wā",
	弹壳: "dàn ké",
	省悟: "xǐng wù",
	嚷嚷: "rāng rang",
	连累: "lián lèi",
	应得: "yīng dé",
	族长: "zú zhǎng",
	柜子: "guì zi",
	擂鼓: "léi gǔ",
	眩晕: "xuàn yùn",
	调配: "tiáo pèi",
	躯干: "qū gàn",
	差役: "chāi yì",
	坎坷: "kǎn kě",
	少儿: "shào ér",
	乐团: "yuè tuán",
	养分: "yǎng fèn",
	退还: "tuì huán",
	格调: "gé diào",
	语调: "yǔ diào",
	音调: "yīn diào",
	乐府: "yuè fǔ",
	古朴: "gǔ pǔ",
	打点: "dǎ diǎn",
	差使: "chāi shǐ",
	匀称: "yún chèn",
	瘦削: "shòu xuē",
	膏药: "gāo yao",
	吞没: "tūn mò",
	调任: "diào rèn",
	散居: "sǎn jū",
	上头: "shàng tóu",
	风靡: "fēng mǐ",
	放假: "fàng jià",
	估量: "gū liang",
	失当: "shī dàng",
	中弹: "zhòng dàn",
	妄为: "wàng wéi",
	长者: "zhǎng zhě",
	起哄: "qǐ hòng",
	末了: "mò liǎo",
	相声: "xiàng sheng",
	校正: "jiào zhèng",
	劝降: "quàn xiáng",
	矢量: "shǐ liàng",
	沉闷: "chén mèn",
	给与: "jǐ yǔ",
	解法: "jiě fǎ",
	塞外: "sài wài",
	将校: "jiàng xiào",
	嗜好: "shì hào",
	没落: "mò luò",
	朴刀: "pō dāo",
	片子: "piān zi",
	切削: "qiē xiāo",
	弹丸: "dàn wán",
	稀薄: "xī bó",
	亏得: "kuī dé",
	间歇: "jiàn xiē",
	翘首: "qiáo shǒu",
	色调: "sè diào",
	处决: "chǔ jué",
	表率: "biǎo shuài",
	尺子: "chǐ zi",
	招降: "zhāo xiáng",
	称职: "chèn zhí",
	斗篷: "dǒu peng",
	铺子: "pù zi",
	底子: "dǐ zi",
	负载: "fù zài",
	干警: "gàn jǐng",
	倒数: "dào shǔ",
	将官: "jiàng guān",
	锄头: "chú tou",
	归降: "guī xiáng",
	疟疾: "nüè ji",
	唠叨: "láo dao",
	限量: "xiàn liàng",
	屏息: "bǐng xī",
	重逢: "chóng féng",
	器乐: "qì yuè",
	氢弹: "qīng dàn",
	脖颈: "bó gěng",
	妃子: "fēi zi",
	处事: "chǔ shì",
	参量: "cān liàng",
	轻率: "qīng shuài",
	缥缈: "piāo miǎo",
	中奖: "zhòng jiǎng",
	才干: "cái gàn",
	施舍: "shī shě",
	卷子: "juàn zi",
	游说: "yóu shuì",
	巷子: "xiàng zi",
	膀胱: "páng guāng",
	切勿: "qiè wù",
	看管: "kān guǎn",
	风头: "fēng tou",
	精干: "jīng gàn",
	高差: "gāo chā",
	恐吓: "kǒng hè",
	扁担: "biǎn dàn",
	给养: "jǐ yǎng",
	格子: "gé zi",
	供需: "gōng xū",
	反差: "fǎn chā",
	飞弹: "fēi dàn",
	微薄: "wēi bó",
	发型: "fà xíng",
	即兴: "jí xìng",
	攒动: "cuán dòng",
	间或: "jiàn huò",
	浅薄: "qiǎn bó",
	乐章: "yuè zhāng",
	顺差: "shùn chā",
	调子: "diào zi",
	相位: "xiàng wèi",
	转子: "zhuàn zǐ",
	劲旅: "jìng lǚ",
	咔嚓: "kā chā",
	了事: "liǎo shì",
	转悠: "zhuàn you",
	当铺: "dàng pù",
	爪子: "zhuǎ zi",
	单子: "dān zi",
	好战: "hào zhàn",
	燕麦: "yàn mài",
	只许: "zhǐ xǔ",
	干练: "gàn liàn",
	女将: "nǚ jiàng",
	酒量: "jiǔ liàng",
	划船: "huá chuán",
	伎俩: "jì liǎng",
	挑拨: "tiǎo bō",
	少校: "shào xiào",
	着落: "zhuó luò",
	憎恶: "zēng wù",
	刻薄: "kè bó",
	要挟: "yāo xié",
	用处: "yòng chu",
	还手: "huán shǒu",
	模具: "mú jù",
	执著: "zhí zhuó",
	喝令: "hè lìng",
	保长: "bǎo zhǎng",
	吸着: "xī zhe",
	症结: "zhēng jié",
	公转: "gōng zhuàn",
	校勘: "jiào kān",
	重提: "chóng tí",
	扫兴: "sǎo xìng",
	铺盖: "pū gài",
	长史: "zhǎng shǐ",
	差价: "chā jià",
	压根: "yà gēn",
	怔住: "zhèng zhù",
	应允: "yīng yǔn",
	切入: "qiē rù",
	战将: "zhàn jiàng",
	年少: "nián shào",
	舍身: "shě shēn",
	执拗: "zhí niù",
	处世: "chǔ shì",
	中风: "zhòng fēng",
	等量: "děng liàng",
	放量: "fàng liàng",
	腔调: "qiāng diào",
	老少: "lǎo shào",
	没入: "mò rù",
	瓜葛: "guā gé",
	将帅: "jiàng shuài",
	车载: "chē zài",
	窝囊: "wō nang",
	长进: "zhǎng jìn",
	可汗: "kè hán",
	并州: "bīng zhōu",
	供销: "gōng xiāo",
	切片: "qiē piàn",
	差事: "chāi shì",
	知会: "zhī hui",
	鹰爪: "yīng zhǎo",
	处女: "chǔ nǚ",
	切磋: "qiē cuō",
	日头: "rì tou",
	押解: "yā jiè",
	滋长: "zī zhǎng",
	道观: "dào guàn",
	脚色: "jué sè",
	当量: "dāng liàng",
	婆家: "pó jia",
	缘分: "yuán fèn",
	空闲: "kòng xián",
	好色: "hào sè",
	怒喝: "nù hè",
	笼统: "lǒng tǒng",
	边塞: "biān sài",
	何曾: "hé céng",
	重合: "chóng hé",
	零散: "líng sǎn",
	轰隆: "hōng lōng",
	化子: "huà zi",
	内蒙: "nèi měng",
	数落: "shǔ luò",
	逆差: "nì chā",
	牟利: "móu lì",
	栅栏: "zhà lan",
	中标: "zhòng biāo",
	调档: "diào dàng",
	佝偻: "gōu lóu",
	场子: "chǎng zi",
	甲壳: "jiǎ qiào",
	重温: "chóng wēn",
	炮制: "páo zhì",
	返还: "fǎn huán",
	自传: "zì zhuàn",
	高调: "gāo diào",
	殷红: "yān hóng",
	固着: "gù zhuó",
	强求: "qiǎng qiú",
	本相: "běn xiàng",
	骄横: "jiāo hèng",
	草率: "cǎo shuài",
	气闷: "qì mèn",
	着色: "zhuó sè",
	宁肯: "nìng kěn",
	兴头: "xìng tou",
	拘泥: "jū nì",
	夹角: "jiā jiǎo",
	发髻: "fà jì",
	猛将: "měng jiàng",
	约摸: "yuē mo",
	拖累: "tuō lěi",
	呢绒: "ní róng",
	钻探: "zuān tàn",
	夹层: "jiā céng",
	落魄: "luò pò",
	巷道: "hàng dào",
	运量: "yùn liàng",
	解闷: "jiě mèn",
	空儿: "kòng er",
	估摸: "gū mo",
	好客: "hào kè",
	钻孔: "zuān kǒng",
	糊弄: "hù nòng",
	荥阳: "xíng yáng",
	烦闷: "fán mèn",
	仓卒: "cāng cù",
	分叉: "fēn chà",
	厂子: "chǎng zi",
	小调: "xiǎo diào",
	少阳: "shào yáng",
	受降: "shòu xiáng",
	染坊: "rǎn fáng",
	胳臂: "gē bei",
	将门: "jiàng mén",
	模板: "mú bǎn",
	配给: "pèi jǐ",
	为伍: "wéi wǔ",
	跟头: "gēn tou",
	划算: "huá suàn",
	累赘: "léi zhui",
	哄笑: "hōng xiào",
	晕眩: "yūn xuàn",
	干掉: "gàn diào",
	缝制: "féng zhì",
	难处: "nán chù",
	着意: "zhuó yì",
	蛮横: "mán hèng",
	奇数: "jī shù",
	短发: "duǎn fà",
	生还: "shēng huán",
	还清: "huán qīng",
	看护: "kān hù",
	直率: "zhí shuài",
	奏乐: "zòu yuè",
	载客: "zài kè",
	专横: "zhuān hèng",
	湮没: "yān mò",
	空格: "kòng gé",
	铺垫: "pū diàn",
	良将: "liáng jiàng",
	哗啦: "huā lā",
	散漫: "sǎn màn",
	脱发: "tuō fà",
	送还: "sòng huán",
	埋没: "mái mò",
	累及: "lěi jí",
	薄雾: "bó wù",
	调离: "diào lí",
	舌苔: "shé tāi",
	机长: "jī zhǎng",
	栓塞: "shuān sè",
	配角: "pèi jué",
	切口: "qiē kǒu",
	创口: "chuāng kǒu",
	哈欠: "hā qian",
	实弹: "shí dàn",
	铺平: "pū píng",
	哈达: "hǎ dá",
	懒散: "lǎn sǎn",
	实干: "shí gàn",
	填空: "tián kòng",
	刁钻: "diāo zuān",
	乐师: "yuè shī",
	量变: "liàng biàn",
	诱降: "yòu xiáng",
	搪塞: "táng sè",
	征调: "zhēng diào",
	夹道: "jiā dào",
	干咳: "gān ké",
	止咳: "zhǐ ké",
	乐工: "yuè gōng",
	划过: "huá guò",
	着火: "zháo huǒ",
	更正: "gēng zhèng",
	给付: "jǐ fù",
	空子: "kòng zi",
	哪吒: "né zhā",
	正着: "zhèng zháo",
	刷子: "shuā zi",
	丧葬: "sāng zàng",
	夹带: "jiā dài",
	安分: "ān fèn",
	中意: "zhòng yì",
	长孙: "zhǎng sūn",
	校订: "jiào dìng",
	卷曲: "juǎn qū",
	载运: "zài yùn",
	投弹: "tóu dàn",
	柞蚕: "zuò cán",
	份量: "fèn liàng",
	调换: "diào huàn",
	了然: "liǎo rán",
	咧嘴: "liě zuǐ",
	典当: "diǎn dàng",
	寒假: "hán jià",
	长兄: "zhǎng xiōng",
	给水: "jǐ shuǐ",
	须发: "xū fà",
	枝干: "zhī gàn",
	属相: "shǔ xiàng",
	哄抢: "hōng qiǎng",
	刻划: "kè huà",
	塞子: "sāi zi",
	单干: "dān gàn",
	还乡: "huán xiāng",
	兆头: "zhào tou",
	寺观: "sì guàn",
	督率: "dū shuài",
	啊哈: "ā ha",
	割舍: "gē shě",
	抹布: "mā bù",
	好恶: "hào wù",
	下处: "xià chǔ",
	消长: "xiāo zhǎng",
	离间: "lí jiàn",
	准头: "zhǔn tou",
	校对: "jiào duì",
	什物: "shí wù",
	番禺: "pān yú",
	佛爷: "fó ye",
	吗啡: "mǎ fēi",
	盐分: "yán fèn",
	虎将: "hǔ jiàng",
	薄荷: "bò he",
	独处: "dú chǔ",
	空位: "kòng wèi",
	铺路: "pū lù",
	乌拉: "wū lā",
	调回: "diào huí",
	来头: "lái tou",
	闲散: "xián sǎn",
	胶卷: "jiāo juǎn",
	冒失: "mào shi",
	干劲: "gàn jìn",
	弦乐: "xián yuè",
	相国: "xiàng guó",
	丹参: "dān shēn",
	助兴: "zhù xìng",
	铺开: "pū kāi",
	次长: "cì zhǎng",
	发卡: "fà qiǎ",
	拮据: "jié jū",
	刹车: "shā chē",
	生发: "shēng fà",
	重播: "chóng bō",
	缝合: "féng hé",
	音量: "yīn liàng",
	少尉: "shào wèi",
	冲压: "chòng yā",
	苍劲: "cāng jìng",
	厚薄: "hòu báo",
	威吓: "wēi hè",
	外相: "wài xiàng",
	呼号: "hū háo",
	着迷: "zháo mí",
	挑担: "tiāo dàn",
	纹路: "wén lù",
	还俗: "huán sú",
	强横: "qiáng hèng",
	着数: "zhāo shù",
	降顺: "xiáng shùn",
	挑明: "tiǎo míng",
	眯缝: "mī feng",
	分内: "fèn nèi",
	更衣: "gēng yī",
	软和: "ruǎn huo",
	尽兴: "jìn xìng",
	号子: "hào zi",
	爪牙: "zhǎo yá",
	败将: "bài jiàng",
	猜中: "cāi zhòng",
	结扎: "jié zā",
	没空: "méi kòng",
	夹缝: "jiā fèng",
	拾掇: "shí duo",
	掺和: "chān huo",
	簸箕: "bò ji",
	电量: "diàn liàng",
	荷载: "hè zǎi",
	调式: "diào shì",
	处身: "chǔ shēn",
	打手: "dǎ shǒu",
	弹弓: "dàn gōng",
	横蛮: "hèng mán",
	能干: "néng gàn",
	校点: "jiào diǎn",
	加载: "jiā zài",
	干校: "gàn xiào",
	哄传: "hōng chuán",
	校注: "jiào zhù",
	淤塞: "yū sè",
	马扎: "mǎ zhá",
	月氏: "yuè zhī",
	高干: "gāo gàn",
	经传: "jīng zhuàn",
	曾孙: "zēng sūn",
	好斗: "hào dòu",
	关卡: "guān qiǎ",
	逃奔: "táo bèn",
	磨蹭: "mó ceng",
	牟取: "móu qǔ",
	颤栗: "zhàn lì",
	蚂蚱: "mà zha",
	撮合: "cuō he",
	趔趄: "liè qie",
	摔打: "shuāi dǎ",
	台子: "tái zi",
	分得: "fēn de",
	粘着: "nián zhuó",
	采邑: "cài yì",
	散装: "sǎn zhuāng",
	婀娜: "ē nuó",
	兴味: "xìng wèi",
	行头: "xíng tou",
	气量: "qì liàng",
	调运: "diào yùn",
	处治: "chǔ zhì",
	乐音: "yuè yīn",
	充塞: "chōng sè",
	恫吓: "dòng hè",
	论调: "lùn diào",
	相中: "xiāng zhòng",
	民乐: "mín yuè",
	炮仗: "pào zhang",
	丧服: "sāng fú",
	骁将: "xiāo jiàng",
	量刑: "liàng xíng",
	缝补: "féng bǔ",
	财会: "cái kuài",
	大干: "dà gàn",
	历数: "lì shǔ",
	校场: "jiào chǎng",
	塞北: "sài běi",
	识相: "shí xiàng",
	辱没: "rǔ mò",
	鲜亮: "xiān liàng",
	语塞: "yǔ sè",
	露脸: "lòu liǎn",
	凉快: "liáng kuai",
	腰杆: "yāo gǎn",
	溜达: "liū da",
	嘎嘎: "gā gā",
	公干: "gōng gàn",
	桔梗: "jié gěng",
	挑逗: "tiǎo dòu",
	看门: "kān mén",
	乐歌: "yuè gē",
	拓片: "tà piàn",
	挑动: "tiǎo dòng",
	准将: "zhǔn jiàng",
	遒劲: "qiú jìng",
	磨坊: "mò fáng",
	逶迤: "wēi yí",
	搅和: "jiǎo huo",
	摩挲: "mó suō",
	作弄: "zuò nòng",
	苗头: "miáo tou",
	打颤: "dǎ zhàn",
	大藏: "dà zàng",
	畜牲: "chù shēng",
	勾搭: "gōu da",
	树荫: "shù yīn",
	树杈: "shù chà",
	铁杆: "tiě gǎn",
	将相: "jiàng xiàng",
	份子: "fèn zi",
	视差: "shì chā",
	绿荫: "lǜ yīn",
	枪杆: "qiāng gǎn",
	缝纫: "féng rèn",
	愁闷: "chóu mèn",
	点将: "diǎn jiàng",
	华佗: "huà tuó",
	劲射: "jìng shè",
	箱笼: "xiāng lǒng",
	终了: "zhōng liǎo",
	鬓发: "bìn fà",
	结巴: "jiē ba",
	苦干: "kǔ gàn",
	看家: "kān jiā",
	正旦: "zhēng dàn",
	中肯: "zhòng kěn",
	厦门: "xià mén",
	东莞: "dōng guǎn",
	食量: "shí liàng",
	宫调: "gōng diào",
	间作: "jiàn zuò",
	弹片: "dàn piàn",
	差池: "chā chí",
	漂白: "piǎo bái",
	杠子: "gàng zi",
	调处: "tiáo chǔ",
	好动: "hào dòng",
	转炉: "zhuàn lú",
	屏气: "bǐng qì",
	夹板: "jiā bǎn",
	哀乐: "āi yuè",
	干道: "gàn dào",
	苦处: "kǔ chù",
	劈柴: "pǐ chái",
	长势: "zhǎng shì",
	天华: "tiān huá",
	共处: "gòng chǔ",
	校验: "jiào yàn",
	出塞: "chū sài",
	磨盘: "mò pán",
	萎靡: "wěi mǐ",
	奔丧: "bēn sāng",
	唱和: "chàng hè",
	大调: "dà diào",
	非分: "fēi fèn",
	钻营: "zuān yíng",
	夹子: "jiā zi",
	超载: "chāo zài",
	更始: "gēng shǐ",
	铃铛: "líng dang",
	披散: "pī sàn",
	发还: "fā huán",
	转轮: "zhuàn lún",
	横财: "hèng cái",
	泡桐: "pāo tóng",
	抛撒: "pāo sǎ",
	天呀: "tiān yā",
	糊糊: "hū hu",
	躯壳: "qū qiào",
	通量: "tōng liàng",
	奉还: "fèng huán",
	午觉: "wǔ jiào",
	闷棍: "mèn gùn",
	浪头: "làng tou",
	砚台: "yàn tái",
	油坊: "yóu fáng",
	学长: "xué zhǎng",
	过载: "guò zài",
	笔调: "bǐ diào",
	衣被: "yī bèi",
	畜产: "xù chǎn",
	调阅: "diào yuè",
	蛮干: "mán gàn",
	曾祖: "zēng zǔ",
	提干: "tí gàn",
	变调: "biàn diào",
	覆没: "fù mò",
	模子: "mú zi",
	乐律: "yuè lǜ",
	称心: "chèn xīn",
	木杆: "mù gān",
	重印: "chóng yìn",
	自省: "zì xǐng",
	提调: "tí diào",
	看相: "kàn xiàng",
	芋头: "yù tou",
	下切: "xià qiē",
	塞上: "sài shàng",
	铺张: "pū zhāng",
	藤蔓: "téng wàn",
	薄幸: "bó xìng",
	解数: "xiè shù",
	褪去: "tuì qù",
	霰弹: "xiàn dàn",
	柚木: "yóu mù",
	痕量: "hén liàng",
	雅乐: "yǎ yuè",
	号哭: "háo kū",
	诈降: "zhà xiáng",
	猪圈: "zhū juàn",
	咋舌: "zé shé",
	铣床: "xǐ chuáng",
	防弹: "fáng dàn",
	健将: "jiàn jiàng",
	丽水: "lí shuǐ",
	削发: "xuē fà",
	空当: "kòng dāng",
	多相: "duō xiàng",
	鲜见: "xiǎn jiàn",
	划桨: "huá jiǎng",
	载波: "zài bō",
	跳蚤: "tiào zao",
	俏皮: "qiào pí",
	吧嗒: "bā dā",
	结发: "jié fà",
	了断: "liǎo duàn",
	同调: "tóng diào",
	石磨: "shí mò",
	时差: "shí chā",
	鼻塞: "bí sè",
	挑子: "tiāo zi",
	推磨: "tuī mò",
	武侯: "wǔ hóu",
	抹煞: "mǒ shā",
	调转: "diào zhuǎn",
	籍没: "jí mò",
	还债: "huán zhài",
	调演: "diào yǎn",
	分划: "fēn huá",
	奇偶: "jī ǒu",
	断喝: "duàn hè",
	闷雷: "mèn léi",
	狼藉: "láng jí",
	饭量: "fàn liàng",
	还礼: "huán lǐ",
	转调: "zhuǎn diào",
	星相: "xīng xiàng",
	手相: "shǒu xiàng",
	配乐: "pèi yuè",
	盖头: "gài tou",
	连杆: "lián gǎn",
	簿记: "bù jì",
	刀把: "dāo bà",
	量词: "liàng cí",
	名角: "míng jué",
	步调: "bù diào",
	校本: "jiào běn",
	账簿: "zhàng bù",
	隽永: "juàn yǒng",
	稍为: "shāo wéi",
	易传: "yì zhuàn",
	乐谱: "yuè pǔ",
	牵累: "qiān lěi",
	答理: "dā li",
	喝斥: "hè chì",
	吟哦: "yín é",
	干渠: "gàn qú",
	海量: "hǎi liàng",
	精当: "jīng dàng",
	着床: "zhuó chuáng",
	月相: "yuè xiàng",
	庶几: "shù jī",
	宫观: "gōng guàn",
	论处: "lùn chǔ",
	征辟: "zhēng bì",
	厚朴: "hòu pò",
	介壳: "jiè qiào",
	吭哧: "kēng chī",
	咯血: "kǎ xiě",
	铺陈: "pū chén",
	重生: "chóng shēng",
	乐理: "yuè lǐ",
	哀号: "āi háo",
	藏历: "zàng lì",
	刚劲: "gāng jìng",
	削平: "xuē píng",
	浓荫: "nóng yīn",
	城垛: "chéng duǒ",
	当差: "dāng chāi",
	正传: "zhèng zhuàn",
	并处: "bìng chǔ",
	创面: "chuāng miàn",
	旦角: "dàn jué",
	薄礼: "bó lǐ",
	晃荡: "huàng dang",
	臊子: "sào zi",
	家什: "jiā shí",
	闷头: "mēn tóu",
	美发: "měi fà",
	度数: "dù shu",
	着凉: "zháo liáng",
	闯将: "chuǎng jiàng",
	几案: "jī àn",
	姘头: "pīn tou",
	差数: "chā shù",
	散碎: "sǎn suì",
	壅塞: "yōng sè",
	寒颤: "hán zhàn",
	牵强: "qiān qiǎng",
	无间: "wú jiàn",
	轮转: "lún zhuàn",
	号叫: "háo jiào",
	铺排: "pū pái",
	降伏: "xiáng fú",
	轧钢: "zhá gāng",
	东阿: "dōng ē",
	病假: "bìng jià",
	累加: "lěi jiā",
	梗塞: "gěng sè",
	弹夹: "dàn jiā",
	钻心: "zuān xīn",
	晃眼: "huǎng yǎn",
	魔爪: "mó zhǎo",
	标量: "biāo liàng",
	憋闷: "biē mèn",
	猜度: "cāi duó",
	处士: "chǔ shì",
	官差: "guān chāi",
	讨还: "tǎo huán",
	长门: "cháng mén",
	馏分: "liú fēn",
	里弄: "lǐ lòng",
	色相: "sè xiàng",
	雅兴: "yǎ xìng",
	角力: "jué lì",
	弹坑: "dàn kēng",
	枝杈: "zhī chà",
	夹具: "jiā jù",
	处刑: "chǔ xíng",
	悍将: "hàn jiàng",
	好学: "hào xué",
	好好: "hǎo hǎo",
	银发: "yín fà",
	扫把: "sào bǎ",
	法相: "fǎ xiàng",
	贵干: "guì gàn",
	供气: "gōng qì",
	空余: "kòng yú",
	捆扎: "kǔn zā",
	瘠薄: "jí bó",
	浆糊: "jiàng hu",
	嘎吱: "gā zhī",
	调令: "diào lìng",
	法帖: "fǎ tiè",
	淋病: "lìn bìng",
	调派: "diào pài",
	转盘: "zhuàn pán",
	供稿: "gōng gǎo",
	差官: "chāi guān",
	忧闷: "yōu mèn",
	教长: "jiào zhǎng",
	重唱: "chóng chàng",
	酒兴: "jiǔ xìng",
	乐坛: "yuè tán",
	花呢: "huā ní",
	叱喝: "chì hè",
	膀臂: "bǎng bì",
	得空: "dé kòng",
	转圈: "zhuàn quān",
	横暴: "hèng bào",
	哄抬: "hōng tái",
	引吭: "yǐn háng",
	载货: "zài huò",
	中计: "zhòng jì",
	官长: "guān zhǎng",
	相面: "xiàng miàn",
	看头: "kàn tou",
	盼头: "pàn tou",
	意兴: "yì xìng",
	军乐: "jūn yuè",
	累次: "lěi cì",
	骨嘟: "gǔ dū",
	燕赵: "yān zhào",
	报丧: "bào sāng",
	弥撒: "mí sa",
	挨斗: "ái dòu",
	扁舟: "piān zhōu",
	丑角: "chǒu jué",
	吊丧: "diào sāng",
	强将: "qiáng jiàng",
	重奏: "chóng zòu",
	发辫: "fà biàn",
	着魔: "zháo mó",
	着法: "zhāo fǎ",
	盛放: "shèng fàng",
	填塞: "tián sè",
	凶横: "xiōng hèng",
	稽首: "qǐ shǒu",
	碑帖: "bēi tiè",
	冲量: "chōng liàng",
	发菜: "fà cài",
	假发: "jiǎ fà",
	翻卷: "fān juǎn",
	小量: "xiǎo liàng",
	胶着: "jiāo zhuó",
	里子: "lǐ zi",
	调调: "diào diao",
	散兵: "sǎn bīng",
	高挑: "gāo tiǎo",
	播撒: "bō sǎ",
	夹心: "jiā xīn",
	扇动: "shān dòng",
	叨扰: "tāo rǎo",
	霓裳: "ní cháng",
	捻子: "niǎn zi",
	弥缝: "mí féng",
	撒布: "sǎ bù",
	场院: "cháng yuàn",
	省亲: "xǐng qīn",
	提拉: "tí lā",
	惯量: "guàn liàng",
	强逼: "qiáng bī",
	强征: "qiáng zhēng",
	晕车: "yùn chē",
	数道: "shù dào",
	带累: "dài lèi",
	拓本: "tà běn",
	嫌恶: "xián wù",
	宿将: "sù jiàng",
	龟裂: "jūn liè",
	缠夹: "chán jiā",
	发式: "fà shì",
	隔扇: "gé shàn",
	天分: "tiān fèn",
	癖好: "pǐ hào",
	四通: "sì tōng",
	白术: "bái zhú",
	划伤: "huá shāng",
	角斗: "jué dòu",
	听差: "tīng chāi",
	岁差: "suì chā",
	丧礼: "sāng lǐ",
	脉脉: "mò mò",
	削瘦: "xuē shòu",
	撒播: "sǎ bō",
	莎草: "suō cǎo",
	犍为: "qián wéi",
	调头: "diào tóu",
	龙卷: "lóng juǎn",
	外调: "wài diào",
	字帖: "zì tiè",
	卷发: "juǎn fà",
	揣度: "chuǎi duó",
	洋相: "yáng xiàng",
	散光: "sǎn guāng",
	骨碌: "gū lu",
	薄命: "bó mìng",
	笼头: "lóng tóu",
	咽炎: "yān yán",
	碌碡: "liù zhou",
	片儿: "piàn er",
	纤手: "qiàn shǒu",
	散体: "sǎn tǐ",
	内省: "nèi xǐng",
	强留: "qiáng liú",
	解送: "jiè sòng",
	反间: "fǎn jiàn",
	少壮: "shào zhuàng",
	留空: "liú kōng",
	告假: "gào jià",
	咳血: "ké xuè",
	薄暮: "bó mù",
	铺轨: "pū guǐ",
	磨削: "mó xuē",
	治丧: "zhì sāng",
	叉子: "chā zi",
	哄动: "hōng dòng",
	蛾子: "é zi",
	出落: "chū luò",
	股长: "gǔ zhǎng",
	贵处: "guì chù",
	还魂: "huán hún",
	例假: "lì jià",
	刹住: "shā zhù",
	身量: "shēn liàng",
	同好: "tóng hào",
	模量: "mó liàng",
	更生: "gēng shēng",
	服丧: "fú sāng",
	率直: "shuài zhí",
	字模: "zì mú",
	散架: "sǎn jià",
	答腔: "dā qiāng",
	交恶: "jiāo wù",
	薄情: "bó qíng",
	眼泡: "yǎn pāo",
	袅娜: "niǎo nuó",
	草垛: "cǎo duò",
	冲劲: "chòng jìn",
	呢喃: "ní nán",
	切中: "qiè zhòng",
	挑灯: "tiǎo dēng",
	还愿: "huán yuàn",
	激将: "jī jiàng",
	更鼓: "gēng gǔ",
	没药: "mò yào",
	败兴: "bài xìng",
	切面: "qiē miàn",
	散户: "sǎn hù",
	累进: "lěi jìn",
	背带: "bēi dài",
	秤杆: "chèng gǎn",
	碾坊: "niǎn fáng",
	簿子: "bù zi",
	扳手: "bān shǒu",
	铅山: "yán shān",
	儒将: "rú jiàng",
	重光: "chóng guāng",
	剪发: "jiǎn fà",
	长上: "zhǎng shàng",
	小传: "xiǎo zhuàn",
	压轴: "yā zhòu",
	弱冠: "ruò guàn",
	花卷: "huā juǎn",
	横祸: "hèng huò",
	夹克: "jiā kè",
	光晕: "guāng yùn",
	披靡: "pī mǐ",
	对调: "duì diào",
	夹持: "jiā chí",
	空额: "kòng é",
	平调: "píng diào",
	铺床: "pū chuáng",
	丧钟: "sāng zhōng",
	作乐: "zuò lè",
	少府: "shào fǔ",
	数数: "shuò shuò",
	奔头: "bèn tou",
	进给: "jìn jǐ",
	率性: "shuài xìng",
	乐子: "lè zi",
	绑扎: "bǎng zā",
	挑唆: "tiǎo suō",
	漂洗: "piǎo xǐ",
	夹墙: "jiā qiáng",
	咳喘: "ké chuǎn",
	乜斜: "miē xie",
	错处: "cuò chù",
	闷酒: "mèn jiǔ",
	时调: "shí diào",
	重孙: "chóng sūn",
	经幢: "jīng chuáng",
	圩场: "xū chǎng",
	调门: "diào mén",
	花头: "huā tóu",
	划拉: "huá la",
	套色: "tào shǎi",
	粗率: "cū shuài",
	相率: "xiāng shuài",
	款识: "kuǎn zhì",
	吁请: "yù qǐng",
	荫蔽: "yīn bì",
	文蛤: "wén gé",
	嘀嗒: "dī dā",
	调取: "diào qǔ",
	交差: "jiāo chāi",
	落子: "luò zǐ",
	相册: "xiàng cè",
	絮叨: "xù dao",
	落发: "luò fà",
	异相: "yì xiàng",
	浸没: "jìn mò",
	角抵: "jué dǐ",
	卸载: "xiè zài",
	春卷: "chūn juǎn",
	扎挣: "zhá zheng",
	畜养: "xù yǎng",
	吡咯: "bǐ luò",
	垛子: "duò zi",
	恶少: "è shào",
	发际: "fà jì",
	红苕: "hóng sháo",
	糨糊: "jiàng hu",
	哭丧: "kū sāng",
	稍息: "shào xī",
	晕船: "yùn chuán",
	校样: "jiào yàng",
	外差: "wài chā",
	脚爪: "jiǎo zhǎo",
	铺展: "pū zhǎn",
	芫荽: "yán sui",
	夹紧: "jiā jǐn",
	尿泡: "suī pào",
	丧乱: "sāng luàn",
	凶相: "xiōng xiàng",
	华发: "huá fà",
	打场: "dǎ cháng",
	云量: "yún liàng",
	正切: "zhèng qiē",
	划拳: "huá quán",
	划艇: "huá tǐng",
	评传: "píng zhuàn",
	拉纤: "lā qiàn",
	句读: "jù dòu",
	散剂: "sǎn jì",
	骨殖: "gǔ shi",
	塞音: "sè yīn",
	铺叙: "pū xù",
	阏氏: "yān zhī",
	冷颤: "lěng zhàn",
	煞住: "shā zhù",
	少男: "shào nán",
	管乐: "guǎn yuè",
	号啕: "háo táo",
	纳降: "nà xiáng",
	拥塞: "yōng sè",
	万乘: "wàn shèng",
	杆儿: "gǎn ér",
	葛藤: "gé téng",
	簿籍: "bù jí",
	皮夹: "pí jiā",
	校准: "jiào zhǔn",
	允当: "yǔn dàng",
	器量: "qì liàng",
	选调: "xuǎn diào",
	扮相: "bàn xiàng",
	干才: "gàn cái",
	基干: "jī gàn",
	割切: "gē qiē",
	国乐: "guó yuè",
	卡壳: "qiǎ ké",
	辟谷: "bì gǔ",
	磨房: "mò fáng",
	咿呀: "yī yā",
	芥末: "jiè mo",
	薄技: "bó jì",
	产假: "chǎn jià",
	诗兴: "shī xìng",
	重出: "chóng chū",
	转椅: "zhuàn yǐ",
	酌量: "zhuó liang",
	簿册: "bù cè",
	藏青: "zàng qīng",
	的士: "dī shì",
	调人: "diào rén",
	解元: "jiè yuán",
	茎干: "jīng gàn",
	巨量: "jù liàng",
	榔头: "láng tou",
	率真: "shuài zhēn",
	喷香: "pèn xiāng",
	锁钥: "suǒ yuè",
	虾蟆: "há má",
	相图: "xiàng tú",
	兴会: "xìng huì",
	灶头: "zào tóu",
	重婚: "chóng hūn",
	钻洞: "zuān dòng",
	忖度: "cǔn duó",
	党参: "dǎng shēn",
	调温: "diào wēn",
	杆塔: "gān tǎ",
	葛布: "gé bù",
	拱券: "gǒng xuàn",
	夹生: "jiā shēng",
	露馅: "lòu xiàn",
	恰切: "qià qiè",
	散见: "sǎn jiàn",
	哨卡: "shào qiǎ",
	烫发: "tàng fà",
	体量: "tǐ liàng",
	挺括: "tǐng kuò",
	系带: "jì dài",
	相士: "xiàng shì",
	羊圈: "yáng juàn",
	转矩: "zhuàn jǔ",
	吧台: "bā tái",
	苍术: "cāng zhú",
	菲薄: "fěi bó",
	蛤蚧: "gé jiè",
	蛤蜊: "gé lí",
	瓜蔓: "guā wàn",
	怪相: "guài xiàng",
	临帖: "lín tiè",
	女红: "nǚ gōng",
	刨床: "bào chuáng",
	翘楚: "qiáo chǔ",
	数九: "shǔ jiǔ",
	谈兴: "tán xìng",
	雄劲: "xióng jìng",
	扎染: "zā rǎn",
	遮荫: "zhē yīn",
	周正: "zhōu zhèng",
	赚头: "zhuàn tou",
	扒手: "pá shǒu",
	搀和: "chān huo",
	诚朴: "chéng pǔ",
	肚量: "dù liàng",
	干结: "gān jié",
	工尺: "gōng chě",
	家累: "jiā lěi",
	曲水: "qū shuǐ",
	沙参: "shā shēn",
	挑花: "tiǎo huā",
	阿门: "ā mén",
	背篓: "bēi lǒu",
	瘪三: "biē sān",
	裁处: "cái chǔ",
	创痛: "chuāng tòng",
	福相: "fú xiàng",
	更动: "gēng dòng",
	豪兴: "háo xìng",
	还阳: "huán yáng",
	还嘴: "huán zuǐ",
	借调: "jiè diào",
	卷云: "juǎn yún",
	流弹: "liú dàn",
	想头: "xiǎng tou",
	削价: "xuē jià",
	校阅: "jiào yuè",
	雅量: "yǎ liàng",
	别传: "bié zhuàn",
	薄酒: "bó jiǔ",
	春假: "chūn jià",
	发妻: "fà qī",
	哗哗: "huā huā",
	宽绰: "kuān chuo",
	了悟: "liǎo wù",
	切花: "qiē huā",
	审度: "shěn duó",
	应许: "yīng xǔ",
	转台: "zhuàn tái",
	仔猪: "zǐ zhū",
	裁量: "cái liáng",
	藏戏: "zàng xì",
	乘兴: "chéng xìng",
	绸缪: "chóu móu",
	摧折: "cuī zhé",
	调经: "tiáo jīng",
	调职: "diào zhí",
	缝缀: "féng zhuì",
	骨朵: "gū duǒ",
	核儿: "hú er",
	恒量: "héng liàng",
	还价: "huán jià",
	浑朴: "hún pǔ",
	苦差: "kǔ chāi",
	面糊: "miàn hù",
	煞车: "shā chē",
	省视: "xǐng shì",
	什锦: "shí jǐn",
	信差: "xìn chāi",
	余切: "yú qiē",
	攒眉: "cuán méi",
	炸糕: "zhá gāo",
	钻杆: "zuàn gǎn",
	扒灰: "pá huī",
	拌和: "bàn huò",
	长调: "cháng diào",
	大溜: "dà liù",
	抖搂: "dǒu lōu",
	飞转: "fēi zhuàn",
	干仗: "gàn zhàng",
	好胜: "hào shèng",
	画片: "huà piàn",
	搅混: "jiǎo hún",
	螺杆: "luó gǎn",
	木模: "mù mú",
	怒号: "nù háo",
	频数: "pín shù",
	无宁: "wú níng",
	遗少: "yí shào",
	邮差: "yóu chāi",
	占卦: "zhān guà",
	占星: "zhān xīng",
	重审: "chóng shěn",
	自量: "zì liàng",
	调防: "diào fáng",
	发廊: "fà láng",
	反调: "fǎn diào",
	缝子: "fèng zi",
	更夫: "gēng fū",
	骨子: "gǔ zi",
	光杆: "guāng gǎn",
	夹棍: "jiā gùn",
	居丧: "jū sāng",
	巨贾: "jù gǔ",
	看押: "kān yā",
	空转: "kōng zhuàn",
	量力: "liàng lì",
	炮烙: "páo luò",
	赔还: "péi huán",
	扑扇: "pū shān",
	散记: "sǎn jì",
	散件: "sǎn jiàn",
	删削: "shān xuē",
	射干: "shè gàn",
	条几: "tiáo jī",
	偷空: "tōu kòng",
	削壁: "xuē bì",
	校核: "jiào hé",
	阴干: "yīn gān",
	择菜: "zhái cài",
	重九: "chóng jiǔ",
	主调: "zhǔ diào",
	自禁: "zì jīn",
	吧唧: "bā jī",
	便溺: "biàn niào",
	词调: "cí diào",
	叨咕: "dáo gu",
	落枕: "lào zhěn",
	铺砌: "pū qì",
	刷白: "shuà bái",
	委靡: "wěi mǐ",
	系泊: "xì bó",
	相马: "xiàng mǎ",
	熨帖: "yù tiē",
	转筋: "zhuàn jīn",
	棒喝: "bàng hè",
	傧相: "bīn xiàng",
	镐头: "gǎo tóu",
	间苗: "jiàn miáo",
	乐池: "yuè chí",
	卖相: "mài xiàng",
	屏弃: "bǐng qì",
	铅弹: "qiān dàn",
	切变: "qiē biàn",
	请调: "qǐng diào",
	群氓: "qún méng",
	散板: "sǎn bǎn",
	省察: "xǐng chá",
	事假: "shì jià",
	纤绳: "qiàn shéng",
	重影: "chóng yǐng",
	耕种: "gēng zhòng",
	种地: "zhòng dì",
	种菜: "zhòng cài",
	栽种: "zāi zhòng",
	接种: "jiē zhòng",
	垦种: "kěn zhòng",
	种殖: "zhòng zhí",
	种瓜: "zhòng guā",
	种豆: "zhòng dòu",
	种树: "zhòng shù",
	睡着: "shuì zháo",
	笼子: "lóng zi",
	重启: "chóng qǐ",
	重整: "chóng zhěng",
	重弹: "chóng tán",
	重足: "chóng zú",
	重山: "chóng shān",
	重游: "chóng yóu",
	重峦: "chóng luán",
	爷爷: "yé ye",
	奶奶: "nǎi nai",
	姥爷: "lǎo ye",
	爸爸: "bà ba",
	妈妈: "mā ma",
	婶婶: "shěn shen",
	舅舅: "jiù jiu",
	姑姑: "gū gu",
	叔叔: "shū shu",
	姨夫: "yí fu",
	舅母: "jiù mu",
	姑父: "gū fu",
	姐夫: "jiě fu",
	婆婆: "pó po",
	公公: "gōng gong",
	舅子: "jiù zi",
	姐姐: "jiě jie",
	哥哥: "gē ge",
	妹妹: "mèi mei",
	妹夫: "mèi fu",
	姨子: "yí zi",
	宝宝: "bǎo bao",
	娃娃: "wá wa",
	孩子: "hái zi",
	日子: "rì zi",
	样子: "yàng zi",
	狮子: "shī zi",
	身子: "shēn zi",
	架子: "jià zi",
	嫂子: "sǎo zi",
	鼻子: "bí zi",
	亭子: "tíng zi",
	折子: "zhé zi",
	面子: "miàn zi",
	脖子: "bó zi",
	辈子: "bèi zi",
	帽子: "mào zi",
	拍子: "pāi zi",
	柱子: "zhù zi",
	辫子: "biàn zi",
	鸽子: "gē zi",
	房子: "fáng zi",
	丸子: "wán zi",
	摊子: "tān zi",
	牌子: "pái zi",
	胡子: "hú zi",
	鬼子: "guǐ zi",
	矮子: "ǎi zi",
	鸭子: "yā zi",
	小子: "xiǎo zi",
	影子: "yǐng zi",
	屋子: "wū zi",
	对子: "duì zi",
	点子: "diǎn zi",
	本子: "běn zi",
	种子: "zhǒng zi",
	儿子: "ér zi",
	兔子: "tù zi",
	骗子: "piàn zi",
	院子: "yuàn zi",
	猴子: "hóu zi",
	嗓子: "sǎng zi",
	侄子: "zhí zi",
	柿子: "shì zi",
	钳子: "qián zi",
	虱子: "shī zi",
	瓶子: "píng zi",
	豹子: "bào zi",
	筷子: "kuài zi",
	篮子: "lán zi",
	绳子: "shéng zi",
	嘴巴: "zuǐ ba",
	耳朵: "ěr duo",
	茄子: "qié zi",
	蚌埠: "bèng bù",
	崆峒: "kōng tóng",
	琵琶: "pí pa",
	蘑菇: "mó gu",
	葫芦: "hú lu",
	狐狸: "hú li",
	桔子: "jú zi",
	盒子: "hé zi",
	桌子: "zhuō zi",
	竹子: "zhú zi",
	师傅: "shī fu",
	衣服: "yī fu",
	袜子: "wà zi",
	杯子: "bēi zi",
	刺猬: "cì wei",
	麦子: "mài zi",
	队伍: "duì wu",
	知了: "zhī liǎo",
	鱼儿: "yú er",
	馄饨: "hún tun",
	灯笼: "dēng long",
	庄稼: "zhuāng jia",
	聪明: "cōng ming",
	镜子: "jìng zi",
	银子: "yín zi",
	盘子: "pán zi",
	了却: "liǎo què",
	力气: "lì qi",
	席子: "xí zi",
	林子: "lín zi",
	朝霞: "zhāo xiá",
	朝夕: "zhāo xī",
	朝气: "zhāo qì",
	翅膀: "chì bǎng",
	省长: "shěng zhǎng",
	臧否: "zāng pǐ",
	否泰: "pǐ tài",
	变得: "biàn de",
	丈夫: "zhàng fu",
	豆腐: "dòu fu",
	笔杆: "bǐ gǎn",
	枞阳: "zōng yáng",
	行人: "xíng rén",
	打着: "dǎ zhe",
	第一: "dì yī",
	万一: "wàn yī",
	之一: "zhī yī",
	得之: "dé zhī",
	统一: "tǒng yī",
	唯一: "wéi yī",
	专一: "zhuān yī",
	单一: "dān yī",
	如一: "rú yī",
	其一: "qí yī",
	合一: "hé yī",
	逐一: "zhú yī",
	周一: "zhōu yī",
	初一: "chū yī",
	研一: "yán yī",
	归一: "guī yī",
	假一: "jiǎ yī",
	闻一: "wén yī",
	了了: "liǎo liǎo",
	公了: "gōng liǎo",
	私了: "sī liǎo",
	一月: "yī yuè",
	一号: "yī hào",
	一级: "yī jí",
	一等: "yī děng",
	一哥: "yī gē",
	月一: "yuè yī",
	一一: "yī yī",
	二一: "èr yī",
	三一: "sān yī",
	四一: "sì yī",
	五一: "wǔ yī",
	六一: "liù yī",
	七一: "qī yī",
	八一: "bā yī",
	九一: "jiǔ yī",
	一〇: "yī líng",
	一零: "yī líng",
	一二: "yī èr",
	一三: "yī sān",
	一四: "yī sì",
	一五: "yī wǔ",
	一六: "yī liù",
	一七: "yī qī",
	一八: "yī bā",
	一九: "yī jiǔ",
	一又: "yī yòu",
	一饼: "yī bǐng",
	一楼: "yī lóu",
	为例: "wéi lì",
	为准: "wéi zhǔn",
	沧海: "cāng hǎi",
	难为: "nán wéi",
	责难: "zé nàn",
	患难: "huàn nàn",
	磨难: "mó nàn",
	大难: "dà nàn",
	刁难: "diāo nàn",
	殉难: "xùn nàn",
	落难: "luò nàn",
	罹难: "lí nàn",
	灾难: "zāi nàn",
	难民: "nàn mín",
	苦难: "kǔ nàn",
	危难: "wēi nàn",
	发难: "fā nàn",
	逃难: "táo nàn",
	避难: "bì nàn",
	遇难: "yù nàn",
	阻难: "zǔ nàn",
	厄难: "è nàn",
	徇难: "xùn nàn",
	空难: "kōng nàn",
	喜欢: "xǐ huan",
	朝朝: "zhāo zhāo",
	不行: "bù xíng",
	轧轧: "yà yà",
	弯曲: "wān qū",
	扭曲: "niǔ qū",
	曲直: "qū zhí",
	委曲: "wěi qū",
	酒曲: "jiǔ qū",
	曲径: "qū jìng",
	曲解: "qū jiě",
	歪曲: "wāi qū",
	曲线: "qū xiàn",
	曲阜: "qū fù",
	九曲: "jiǔ qū",
	曲折: "qū zhé",
	曲肱: "qū gōng",
	曲意: "qū yì",
	仡佬: "gē lǎo"
};
const Pattern2 = Object.keys(DICT2).map((key) => ({
	zh: key,
	pinyin: DICT2[key],
	probability: 2e-8,
	length: 2,
	priority: Priority.Normal,
	dict: Symbol("dict2")
}));
//#endregion
//#region ../../node_modules/.pnpm/pinyin-pro@3.29.5/node_modules/pinyin-pro/dist/esm/data/dict3.mjs
const DICT3 = {
	为什么: "wèi shén me",
	实际上: "shí jì shang",
	检察长: "jiǎn chá zhǎng",
	干什么: "gàn shén me",
	这会儿: "zhè huì er",
	尽可能: "jǐn kě néng",
	董事长: "dǒng shì zhǎng",
	了不起: "liǎo bù qǐ",
	参谋长: "cān móu zhǎng",
	朝鲜族: "cháo xiǎn zú",
	海内外: "hǎi nèi wài",
	禁不住: "jīn bú zhù",
	柏拉图: "bó lā tú",
	不在乎: "bú zài hu",
	洛杉矶: "luò shān jī",
	有点儿: "yǒu diǎn er",
	迫击炮: "pǎi jī pào",
	不得了: "bù dé liǎo",
	马尾松: "mǎ wěi sōng",
	运输量: "yùn shū liàng",
	发脾气: "fā pí qi",
	士大夫: "shì dà fū",
	鸭绿江: "yā lù jiāng",
	压根儿: "yà gēn er",
	对得起: "duì de qǐ",
	那会儿: "nà huì er",
	自个儿: "zì gě er",
	物理量: "wù lǐ liàng",
	怎么着: "zěn me zhāo",
	明晃晃: "míng huǎng huǎng",
	节假日: "jié jià rì",
	心里话: "xīn lǐ huà",
	发行量: "fā xíng liàng",
	兴冲冲: "xìng chōng chōng",
	分子量: "fēn zǐ liàng",
	国子监: "guó zǐ jiàn",
	老大难: "lǎo dà nán",
	党内外: "dǎng nèi wài",
	这么着: "zhè me zhāo",
	少奶奶: "shào nǎi nai",
	暗地里: "àn dì lǐ",
	更年期: "gēng nián qī",
	工作量: "gōng zuò liàng",
	背地里: "bèi dì lǐ",
	山里红: "shān li hóng",
	好好儿: "hǎo hāo er",
	交响乐: "jiāo xiǎng yuè",
	好意思: "hǎo yì si",
	吐谷浑: "tǔ yù hún",
	没意思: "méi yì si",
	理发师: "lǐ fà shī",
	塔什干: "tǎ shí gān",
	充其量: "chōng qí liàng",
	靠得住: "kào de zhù",
	车行道: "chē xíng dào",
	人行道: "rén xíng dào",
	中郎将: "zhōng láng jiàng",
	照明弹: "zhào míng dàn",
	烟幕弹: "yān mù dàn",
	没奈何: "mò nài hé",
	乱哄哄: "luàn hōng hōng",
	惠更斯: "huì gēng sī",
	载重量: "zài zhòng liàng",
	瞧得起: "qiáo de qǐ",
	纪传体: "jì zhuàn tǐ",
	阿房宫: "ē páng gōng",
	卷心菜: "juǎn xīn cài",
	戏班子: "xì bān zi",
	过得去: "guò de qù",
	花岗石: "huā gāng shí",
	外甥女: "wài sheng nǚ",
	团团转: "tuán tuán zhuàn",
	大堡礁: "dà bǎo jiāo",
	燃烧弹: "rán shāo dàn",
	劳什子: "láo shí zi",
	摇滚乐: "yáo gǔn yuè",
	夹竹桃: "jiā zhú táo",
	闹哄哄: "nào hōng hōng",
	三连冠: "sān lián guàn",
	重头戏: "zhòng tóu xì",
	二人转: "èr rén zhuàn",
	节骨眼: "jiē gǔ yǎn",
	知识面: "zhī shi miàn",
	护士长: "hù shi zhǎng",
	信号弹: "xìn hào dàn",
	干电池: "gān diàn chí",
	枪杆子: "qiāng gǎn zi",
	哭丧棒: "kū sāng bàng",
	鼻咽癌: "bí yān ái",
	瓦岗军: "wǎ gāng jūn",
	买得起: "mǎi de qǐ",
	癞蛤蟆: "lài há ma",
	脊梁骨: "jǐ liang gǔ",
	子母弹: "zǐ mǔ dàn",
	开小差: "kāi xiǎo chāi",
	女强人: "nǚ qiáng rén",
	英雄传: "yīng xióng zhuàn",
	爵士乐: "jué shì yuè",
	说笑话: "shuō xiào hua",
	碰头会: "pèng tóu huì",
	玻璃钢: "bō li gāng",
	曳光弹: "yè guāng dàn",
	少林拳: "shào lín quán",
	咏叹调: "yǒng tàn diào",
	少先队: "shào xiān duì",
	灵长目: "líng zhǎng mù",
	对着干: "duì zhe gàn",
	蒙蒙亮: "méng méng liàng",
	软骨头: "ruǎn gǔ tou",
	铺盖卷: "pū gài juǎn",
	和稀泥: "huò xī ní",
	背黑锅: "bēi hēi guō",
	红彤彤: "hóng tōng tōng",
	武侯祠: "wǔ hóu cí",
	打哆嗦: "dǎ duō suo",
	户口簿: "hù kǒu bù",
	马尾藻: "mǎ wěi zǎo",
	夜猫子: "yè māo zi",
	打手势: "dǎ shǒu shì",
	龙王爷: "lóng wáng yé",
	气头上: "qì tóu shang",
	糊涂虫: "hú tu chóng",
	笔杆子: "bǐ gǎn zi",
	占便宜: "zhàn pián yi",
	打主意: "dǎ zhǔ yì",
	多弹头: "duō dàn tóu",
	露一手: "lòu yì shǒu",
	堰塞湖: "yàn sè hú",
	保得住: "bǎo de zhù",
	趵突泉: "bào tū quán",
	奥得河: "ào de hé",
	司务长: "sī wù zhǎng",
	禁不起: "jīn bù qǐ",
	什刹海: "shí chà hǎi",
	莲花落: "lián huā lào",
	见世面: "jiàn shì miàn",
	豁出去: "huō chū qù",
	电位差: "diàn wèi chā",
	挨个儿: "āi gè er",
	那阵儿: "nà zhèn er",
	肺活量: "fèi huó liàng",
	大师傅: "dà shī fu",
	掷弹筒: "zhì dàn tǒng",
	打呼噜: "dǎ hū lu",
	广渠门: "ān qú mén",
	未见得: "wèi jiàn dé",
	大婶儿: "dà shěn er",
	谈得来: "tán de lái",
	脚丫子: "jiǎo yā zi",
	空包弹: "kōng bāo dàn",
	窝里斗: "wō li dòu",
	弹着点: "dàn zhuó diǎn",
	个头儿: "gè tóu er",
	看得起: "kàn de qǐ",
	糊涂账: "hú tu zhàng",
	大猩猩: "dà xīng xing",
	禁得起: "jīn de qǐ",
	法相宗: "fǎ xiàng zōng",
	可怜相: "kě lián xiàng",
	吃得下: "chī de xià",
	汉堡包: "hàn bǎo bāo",
	闹嚷嚷: "nào rāng rāng",
	数来宝: "shǔ lái bǎo",
	合得来: "hé de lái",
	干性油: "gān xìng yóu",
	闷葫芦: "mèn hú lu",
	呱呱叫: "guā guā jiào",
	西洋参: "xī yáng shēn",
	林荫道: "lín yīn dào",
	拉家常: "lā jiā cháng",
	卷铺盖: "juǎn pū gài",
	过得硬: "guò de yìng",
	飞将军: "fēi jiāng jūn",
	挑大梁: "tiǎo dà liáng",
	哈巴狗: "hǎ ba gǒu",
	过家家: "guò jiā jiā",
	催泪弹: "cuī lèi dàn",
	雨夹雪: "yǔ jiā xuě",
	敲竹杠: "qiāo zhú gàng",
	列车长: "liè chē zhǎng",
	华达呢: "huá dá ní",
	犯得着: "fàn de zháo",
	土疙瘩: "tǔ gē da",
	煞风景: "shā fēng jǐng",
	轻量级: "qīng liàng jí",
	羞答答: "xiū dā dā",
	石子儿: "shí zǐ er",
	达姆弹: "dá mǔ dàn",
	科教片: "kē jiào piān",
	侃大山: "kǎn dà shān",
	丁点儿: "dīng diǎn er",
	吃得消: "chī de xiāo",
	捋虎须: "luō hǔ xū",
	高丽参: "gāo lí shēn",
	众生相: "zhòng shēng xiàng",
	咽峡炎: "yān xiá yán",
	禁得住: "jīn de zhù",
	吃得开: "chī de kāi",
	柞丝绸: "zuò sī chóu",
	应声虫: "yìng shēng chóng",
	数得着: "shǔ de zháo",
	傻劲儿: "shǎ jìn er",
	铅玻璃: "qiān bō li",
	可的松: "kě dì sōng",
	划得来: "huá de lái",
	晕乎乎: "yūn hū hū",
	屎壳郎: "shǐ ke làng",
	尥蹶子: "liào juě zi",
	藏红花: "zàng hóng huā",
	闷罐车: "mèn guàn chē",
	卡脖子: "qiǎ bó zi",
	红澄澄: "hóng deng deng",
	赶得及: "gǎn de jí",
	当间儿: "dāng jiàn er",
	露马脚: "lòu mǎ jiǎo",
	鸡内金: "jī nèi jīn",
	犯得上: "fàn de shàng",
	钉齿耙: "dīng chǐ bà",
	饱和点: "bǎo hé diǎn",
	龙爪槐: "lóng zhǎo huái",
	喝倒彩: "hè dào cǎi",
	定冠词: "dìng guàn cí",
	担担面: "dàn dan miàn",
	吃得住: "chī de zhù",
	爪尖儿: "zhuǎ jiān er",
	支着儿: "zhī zhāo er",
	折跟头: "zhē gēn tou",
	阴着儿: "yīn zhāo er",
	烟卷儿: "yān juǎn er",
	宣传弹: "xuān chuán dàn",
	信皮儿: "xìn pí er",
	弦切角: "xián qiē jiǎo",
	缩砂密: "sù shā mì",
	说得来: "shuō de lái",
	水漂儿: "shuǐ piāo er",
	耍笔杆: "shuǎ bǐ gǎn",
	数得上: "shǔ de shàng",
	数不着: "shǔ bù zháo",
	数不清: "shǔ bù qīng",
	什件儿: "shí jiàn er",
	生死簿: "shēng sǐ bù",
	扇风机: "shān fēng jī",
	撒呓挣: "sā yì zheng",
	日记簿: "rì jì bù",
	热得快: "rè de kuài",
	亲家公: "qìng jia gōng",
	奇函数: "jī hán shù",
	拍纸簿: "pāi zhǐ bù",
	努劲儿: "nǔ jìn er",
	泥娃娃: "ní wá wa",
	内切圆: "nèi qiē yuán",
	哪会儿: "nǎ huì er",
	闷头儿: "mēn tóu er",
	没谱儿: "méi pǔ er",
	铆劲儿: "mǎo jìn er",
	溜肩膀: "liū jiān bǎng",
	了望台: "liào wàng tái",
	老来少: "lǎo lái shào",
	坤角儿: "kūn jué er",
	考勤簿: "kǎo qín bù",
	卷笔刀: "juǎn bǐ dāo",
	进给量: "jìn jǐ liàng",
	划不来: "huá bù lái",
	汗褂儿: "hàn guà er",
	鼓囊囊: "gǔ nāng nāng",
	够劲儿: "gòu jìn er",
	公切线: "gōng qiē xiàn",
	搁得住: "gé de zhù",
	赶浪头: "gǎn làng tóu",
	赶得上: "gǎn de shàng",
	干酵母: "gān jiào mǔ",
	嘎渣儿: "gā zhā er",
	嘎嘣脆: "gā bēng cuì",
	对得住: "duì de zhù",
	逗闷子: "dòu mèn zi",
	顶呱呱: "dǐng guā guā",
	滴溜儿: "dī liù er",
	大轴子: "dà zhòu zi",
	打板子: "dǎ bǎn zi",
	寸劲儿: "cùn jìn er",
	醋劲儿: "cù jìn er",
	揣手儿: "chuāi shǒu er",
	冲劲儿: "chòng jìn er",
	吃得来: "chī de lái",
	不更事: "bù gēng shì",
	奔头儿: "bèn tou er",
	百夫长: "bǎi fū zhǎng",
	娃娃亲: "wá wa qīn",
	死劲儿: "sǐ jìn er",
	骨朵儿: "gū duǒ er",
	功劳簿: "gōng láo bù",
	都江堰: "dū jiāng yàn",
	一担水: "yí dàn shuǐ",
	否极泰: "pǐ jí tài",
	泰来否: "tài lái pǐ",
	咳特灵: "ké tè líng",
	开户行: "kāi hù háng",
	郦食其: "lì yì jī",
	花事了: "huā shì liǎo",
	一更更: "yì gēng gēng",
	一重山: "yì chóng shān",
	风一更: "fēng yì gēng",
	雪一更: "xuě yì gēng",
	归一码: "guī yì mǎ",
	星期一: "xīng qī yī",
	礼拜一: "lǐ bài yī",
	一季度: "yī jì dù",
	一月一: "yī yuè yī",
	一字马: "yī zì mǎ",
	一是一: "yī shì yī",
	一次方: "yī cì fāng",
	一阳指: "yī yáng zhǐ",
	一字决: "yī zì jué",
	一年级: "yī nián jí",
	一不做: "yī bú zuò",
	屈戌儿: "qū qu ér",
	难为水: "nán wéi shuǐ",
	难为情: "nán wéi qíng",
	行一行: "xíng yì háng",
	别别的: "biè bié de",
	干哪行: "gàn nǎ háng",
	干一行: "gàn yì háng",
	曲别针: "qū bié zhēn"
};
const Pattern3 = Object.keys(DICT3).map((key) => ({
	zh: key,
	pinyin: DICT3[key],
	probability: 2e-8,
	length: 3,
	priority: Priority.Normal,
	dict: Symbol("dict3")
}));
//#endregion
//#region ../../node_modules/.pnpm/pinyin-pro@3.29.5/node_modules/pinyin-pro/dist/esm/data/dict4.mjs
const DICT4 = {
	成吉思汗: "chéng jí sī hán",
	四通八达: "sì tōng bā dá",
	一模一样: "yì mú yí yàng",
	青藏高原: "qīng zàng gāo yuán",
	阿弥陀佛: "ē mí tuó fó",
	解放思想: "jiè fàng sī xiǎng",
	所作所为: "suǒ zuò suǒ wéi",
	迷迷糊糊: "mí mí hu hū",
	荷枪实弹: "hè qiāng shí dàn",
	兴高采烈: "xìng gāo cǎi liè",
	无能为力: "wú néng wéi lì",
	布鲁塞尔: "bù lǔ sài ěr",
	为所欲为: "wéi suǒ yù wéi",
	克什米尔: "kè shí mǐ ěr",
	没完没了: "méi wán méi liǎo",
	不为人知: "bù wéi rén zhī",
	结结巴巴: "jiē jiē bā bā",
	前仆后继: "qián pū hòu jì",
	铺天盖地: "pū tiān gài dì",
	直截了当: "zhí jié liǎo dàng",
	供不应求: "gōng bú yìng qiú",
	御史大夫: "yù shǐ dà fū",
	不为瓦全: "bù wéi wǎ quán",
	不可收拾: "bù kě shōu shi",
	胡作非为: "hú zuò fēi wéi",
	分毫不差: "fēn háo bú chà",
	模模糊糊: "mó mó hu hū",
	不足为奇: "bù zú wéi qí",
	悄无声息: "qiǎo wú shēng xī",
	了如指掌: "liǎo rú zhǐ zhǎng",
	深恶痛绝: "shēn wù tòng jué",
	高高兴兴: "gāo gāo xìng xìng",
	唉声叹气: "āi shēng tàn qì",
	汉藏语系: "hàn zàng yǔ xì",
	处心积虑: "chǔ xīn jī lǜ",
	泣不成声: "qì bù chéng shēng",
	半夜三更: "bàn yè sān gēng",
	失魂落魄: "shī hún luò pò",
	二十八宿: "èr shí bā xiù",
	转来转去: "zhuàn lái zhuàn qù",
	数以万计: "shǔ yǐ wàn jì",
	相依为命: "xiāng yī wéi mìng",
	恋恋不舍: "liàn liàn bù shě",
	屈指可数: "qū zhǐ kě shǔ",
	神出鬼没: "shén chū guǐ mò",
	结结实实: "jiē jiē shí shí",
	有的放矢: "yǒu dì fàng shǐ",
	叽哩咕噜: "jī lǐ gū lū",
	调兵遣将: "diào bīng qiǎn jiàng",
	载歌载舞: "zài gē zài wǔ",
	转危为安: "zhuǎn wēi wéi ān",
	踏踏实实: "tā tā shi shí",
	桑给巴尔: "sāng jǐ bā ěr",
	装模作样: "zhuāng mú zuò yàng",
	见义勇为: "jiàn yì yǒng wéi",
	相差无几: "xiāng chā wú jǐ",
	叹为观止: "tàn wéi guān zhǐ",
	闷闷不乐: "mèn mèn bú lè",
	喜怒哀乐: "xǐ nù āi lè",
	鲜为人知: "xiǎn wéi rén zhī",
	张牙舞爪: "zhāng yá wǔ zhǎo",
	为非作歹: "wéi fēi zuò dǎi",
	含糊其辞: "hán hú qí cí",
	疲于奔命: "pí yú bēn mìng",
	勉为其难: "miǎn wéi qí nán",
	依依不舍: "yī yī bù shě",
	顶头上司: "dǐng tóu shàng si",
	不着边际: "bù zhuó biān jì",
	大模大样: "dà mú dà yàng",
	寻欢作乐: "xún huān zuò lè",
	一走了之: "yì zǒu liǎo zhī",
	字里行间: "zì lǐ háng jiān",
	含含糊糊: "hán hán hu hū",
	恰如其分: "qià rú qí fèn",
	破涕为笑: "pò tì wéi xiào",
	深更半夜: "shēn gēng bàn yè",
	千差万别: "qiān chā wàn bié",
	数不胜数: "shǔ bú shèng shǔ",
	据为己有: "jù wéi jǐ yǒu",
	天旋地转: "tiān xuán dì zhuàn",
	养尊处优: "yǎng zūn chǔ yōu",
	玻璃纤维: "bō li xiān wéi",
	吵吵闹闹: "chāo chao nào nào",
	晕头转向: "yūn tóu zhuàn xiàng",
	土生土长: "tǔ shēng tǔ zhǎng",
	宁死不屈: "nìng sǐ bù qū",
	不省人事: "bù xǐng rén shì",
	尽力而为: "jìn lì ér wéi",
	精明强干: "jīng míng qiáng gàn",
	唠唠叨叨: "láo lao dāo dāo",
	叽叽喳喳: "jī ji zhā zhā",
	功不可没: "gōng bù kě mò",
	锲而不舍: "qiè ér bù shě",
	排忧解难: "pái yōu jiě nàn",
	稀里糊涂: "xī li hú tú",
	各有所长: "gè yǒu suǒ cháng",
	的的确确: "dí dí què què",
	哄堂大笑: "hōng táng dà xiào",
	听而不闻: "tīng ér bù wén",
	刀耕火种: "dāo gēng huǒ zhòng",
	内分泌腺: "nèi fèn mì xiàn",
	化险为夷: "huà xiǎn wéi yí",
	百发百中: "bǎi fā bǎi zhòng",
	重见天日: "chóng jiàn tiān rì",
	反败为胜: "fǎn bài wéi shèng",
	一了百了: "yì liǎo bǎi liǎo",
	大大咧咧: "dà da liē liē",
	心急火燎: "xīn jí huǒ liǎo",
	粗心大意: "cū xīn dà yi",
	鸡皮疙瘩: "jī pí gē da",
	夷为平地: "yí wéi píng dì",
	日积月累: "rì jī yuè lěi",
	设身处地: "shè shēn chǔ dì",
	投其所好: "tóu qí suǒ hào",
	间不容发: "jiān bù róng fà",
	人满为患: "rén mǎn wéi huàn",
	穷追不舍: "qióng zhuī bù shě",
	为时已晚: "wéi shí yǐ wǎn",
	如数家珍: "rú shǔ jiā zhēn",
	心里有数: "xīn lǐ yǒu shù",
	以牙还牙: "yǐ yá huán yá",
	神不守舍: "shén bù shǒu shě",
	孟什维克: "mèng shí wéi kè",
	各自为战: "gè zì wéi zhàn",
	怨声载道: "yuàn shēng zài dào",
	救苦救难: "jiù kǔ jiù nàn",
	好好先生: "hǎo hǎo xiān sheng",
	怪模怪样: "guài mú guài yàng",
	抛头露面: "pāo tóu lù miàn",
	游手好闲: "yóu shǒu hào xián",
	无所不为: "wú suǒ bù wéi",
	调虎离山: "diào hǔ lí shān",
	步步为营: "bù bù wéi yíng",
	好大喜功: "hào dà xǐ gōng",
	众矢之的: "zhòng shǐ zhī dì",
	长生不死: "cháng shēng bù sǐ",
	蔚为壮观: "wèi wéi zhuàng guān",
	不可胜数: "bù kě shèng shǔ",
	鬼使神差: "guǐ shǐ shén chāi",
	洁身自好: "jié shēn zì hào",
	敢作敢为: "gǎn zuò gǎn wéi",
	茅塞顿开: "máo sè dùn kāi",
	走马换将: "zǒu mǎ huàn jiàng",
	为时过早: "wéi shí guò zǎo",
	为人师表: "wéi rén shī biǎo",
	阴差阳错: "yīn chā yáng cuò",
	油腔滑调: "yóu qiāng huá diào",
	重蹈覆辙: "chóng dǎo fù zhé",
	骂骂咧咧: "mà ma liē liē",
	絮絮叨叨: "xù xù dāo dāo",
	如履薄冰: "rú lǚ bó bīng",
	损兵折将: "sǔn bīng zhé jiàng",
	拐弯抹角: "guǎi wān mò jiǎo",
	像模像样: "xiàng mú xiàng yàng",
	供过于求: "gōng guò yú qiú",
	开花结果: "kāi huā jiē guǒ",
	仔仔细细: "zǐ zǐ xì xì",
	川藏公路: "chuān zàng gōng lù",
	河北梆子: "hé běi bāng zi",
	长年累月: "cháng nián lěi yuè",
	正儿八经: "zhèng er bā jīng",
	不识抬举: "bù shí tái ju",
	重振旗鼓: "chóng zhèn qí gǔ",
	气息奄奄: "qì xī yān yān",
	紧追不舍: "jǐn zhuī bù shě",
	服服帖帖: "fú fu tiē tiē",
	强词夺理: "qiǎng cí duó lǐ",
	噼里啪啦: "pī li pā lā",
	人才济济: "rén cái jǐ jǐ",
	发人深省: "fā rén shēn xǐng",
	不足为凭: "bù zú wéi píng",
	为富不仁: "wéi fù bù rén",
	连篇累牍: "lián piān lěi dú",
	呼天抢地: "hū tiān qiāng dì",
	落落大方: "luò luò dà fāng",
	自吹自擂: "zì chuī zì léi",
	乐善好施: "lè shàn hào shī",
	以攻为守: "yǐ gōng wéi shǒu",
	磨磨蹭蹭: "mó mó cèng cèng",
	削铁如泥: "xuē tiě rú ní",
	助纣为虐: "zhù zhòu wéi nüè",
	以退为进: "yǐ tuì wéi jìn",
	嘁嘁喳喳: "qī qī chā chā",
	枪林弹雨: "qiāng lín dàn yǔ",
	令人发指: "lìng rén fà zhǐ",
	转败为胜: "zhuǎn bài wéi shèng",
	转弯抹角: "zhuǎn wān mò jiǎo",
	在劫难逃: "zài jié nán táo",
	正当防卫: "zhèng dàng fáng wèi",
	不足为怪: "bù zú wéi guài",
	难兄难弟: "nàn xiōng nàn dì",
	咿咿呀呀: "yī yī yā yā",
	弹尽粮绝: "dàn jìn liáng jué",
	阿谀奉承: "ē yú fèng chéng",
	稀里哗啦: "xī li huā lā",
	返老还童: "fǎn lǎo huán tóng",
	好高骛远: "hào gāo wù yuǎn",
	鹿死谁手: "lù sǐ shéi shǒu",
	差强人意: "chā qiáng rén yì",
	大吹大擂: "dà chuī dà léi",
	成家立业: "chéng jiā lì yè",
	自怨自艾: "zì yuàn zì yì",
	负债累累: "fù zhài lěi lěi",
	古为今用: "gǔ wéi jīn yòng",
	入土为安: "rù tǔ wéi ān",
	下不为例: "xià bù wéi lì",
	一哄而上: "yì hōng ér shàng",
	没头苍蝇: "méi tóu cāng ying",
	天差地远: "tiān chā dì yuǎn",
	风卷残云: "fēng juǎn cán yún",
	多灾多难: "duō zāi duō nàn",
	乳臭未干: "rǔ xiù wèi gān",
	行家里手: "háng jiā lǐ shǒu",
	狼狈为奸: "láng bèi wéi jiān",
	处变不惊: "chǔ biàn bù jīng",
	一唱一和: "yí chàng yí hè",
	一念之差: "yí niàn zhī chā",
	金蝉脱壳: "jīn chán tuō qiào",
	滴滴答答: "dī dī dā dā",
	硕果累累: "shuò guǒ léi léi",
	好整以暇: "hào zhěng yǐ xiá",
	红得发紫: "hóng de fā zǐ",
	传为美谈: "chuán wéi měi tán",
	富商大贾: "fù shāng dà gǔ",
	四海为家: "sì hǎi wéi jiā",
	了若指掌: "liǎo ruò zhǐ zhǎng",
	大有可为: "dà yǒu kě wéi",
	出头露面: "chū tóu lù miàn",
	鼓鼓囊囊: "gǔ gu nāng nāng",
	窗明几净: "chuāng míng jī jìng",
	泰然处之: "tài rán chǔ zhī",
	怒发冲冠: "nù fà chōng guān",
	有机玻璃: "yǒu jī bō li",
	骨头架子: "gǔ tou jià zi",
	义薄云天: "yì bó yún tiān",
	一丁点儿: "yī dīng diǎn er",
	时来运转: "shí lái yùn zhuǎn",
	陈词滥调: "chén cí làn diào",
	化整为零: "huà zhěng wéi líng",
	火烧火燎: "huǒ shāo huǒ liǎo",
	干脆利索: "gàn cuì lì suǒ",
	吊儿郎当: "diào er láng dāng",
	广种薄收: "guǎng zhòng bó shōu",
	种瓜得瓜: "zhòng guā dé guā",
	种豆得豆: "zhòng dòu dé dòu",
	难舍难分: "nán shě nán fēn",
	歃血为盟: "shà xuè wéi méng",
	奋发有为: "fèn fā yǒu wéi",
	阴错阳差: "yīn cuò yáng chā",
	东躲西藏: "dōng duǒ xī cáng",
	烟熏火燎: "yān xūn huǒ liǎo",
	钻牛角尖: "zuān niú jiǎo jiān",
	乔装打扮: "qiáo zhuāng dǎ bàn",
	改弦更张: "gǎi xián gēng zhāng",
	河南梆子: "hé nán bāng zi",
	好吃懒做: "hào chī lǎn zuò",
	何乐不为: "hé lè bù wéi",
	大出风头: "dà chū fēng tóu",
	攻城掠地: "gōng chéng lüè dì",
	漂漂亮亮: "piào piào liang liang",
	折衷主义: "zhé zhōng zhǔ yì",
	大马哈鱼: "dà mǎ hǎ yú",
	绿树成荫: "lǜ shù chéng yīn",
	率先垂范: "shuài xiān chuí fàn",
	家长里短: "jiā cháng lǐ duǎn",
	宽大为怀: "kuān dà wéi huái",
	左膀右臂: "zuǒ bǎng yòu bì",
	一笑了之: "yí xiào liǎo zhī",
	天下为公: "tiān xià wéi gōng",
	还我河山: "huán wǒ hé shān",
	何足为奇: "hé zú wéi qí",
	好自为之: "hǎo zì wéi zhī",
	风姿绰约: "fēng zī chuò yuē",
	大雨滂沱: "dà yǔ pāng tuó",
	传为佳话: "chuán wéi jiā huà",
	吃里扒外: "chī lǐ pá wài",
	重操旧业: "chóng cāo jiù yè",
	小家子气: "xiǎo jiā zi qì",
	少不更事: "shào bù gēng shì",
	难分难舍: "nán fēn nán shě",
	添砖加瓦: "tiān zhuān jiā wǎ",
	是非分明: "shì fēi fēn míng",
	舍我其谁: "shě wǒ qí shuí",
	偏听偏信: "piān tīng piān xìn",
	量入为出: "liàng rù wéi chū",
	降龙伏虎: "xiáng lóng fú hǔ",
	钢化玻璃: "gāng huà bō li",
	正中下怀: "zhèng zhòng xià huái",
	以身许国: "yǐ shēn xǔ guó",
	一语中的: "yì yǔ zhòng dì",
	丧魂落魄: "sàng hún luò pò",
	三座大山: "sān zuò dà shān",
	济济一堂: "jǐ jǐ yì táng",
	好事之徒: "hào shì zhī tú",
	干净利索: "gàn jìng lì suǒ",
	出将入相: "chū jiàng rù xiàng",
	袅袅娜娜: "niǎo niǎo nuó nuó",
	狐狸尾巴: "hú li wěi ba",
	好逸恶劳: "hào yì wù láo",
	大而无当: "dà ér wú dàng",
	打马虎眼: "dǎ mǎ hu yǎn",
	板上钉钉: "bǎn shàng dìng dīng",
	吆五喝六: "yāo wǔ hè liù",
	虾兵蟹将: "xiā bīng xiè jiàng",
	水调歌头: "shuǐ diào gē tóu",
	数典忘祖: "shǔ diǎn wàng zǔ",
	人事不省: "rén shì bù xǐng",
	曲高和寡: "qǔ gāo hè guǎ",
	屡教不改: "lǚ jiào bù gǎi",
	互为因果: "hù wéi yīn guǒ",
	互为表里: "hù wéi biǎo lǐ",
	厚此薄彼: "hòu cǐ bó bǐ",
	过关斩将: "guò guān zhǎn jiàng",
	疙疙瘩瘩: "gē ge dā dā",
	大腹便便: "dà fù pián pián",
	走为上策: "zǒu wéi shàng cè",
	冤家对头: "yuān jia duì tóu",
	有隙可乘: "yǒu xì kě chèng",
	一鳞半爪: "yì lín bàn zhǎo",
	片言只语: "piàn yán zhǐ yǔ",
	开花结实: "kāi huā jié shí",
	经年累月: "jīng nián lěi yuè",
	含糊其词: "hán hú qí cí",
	寡廉鲜耻: "guǎ lián xiǎn chǐ",
	成年累月: "chéng nián lěi yuè",
	不徇私情: "bú xùn sī qíng",
	不当人子: "bù dāng rén zǐ",
	膀大腰圆: "bǎng dà yāo yuán",
	指腹为婚: "zhǐ fù wéi hūn",
	这么点儿: "zhè me diǎn er",
	意兴索然: "yì xīng suǒ rán",
	绣花枕头: "xiù huā zhěn tou",
	无的放矢: "wú dì fàng shǐ",
	望闻问切: "wàng wén wèn qiè",
	舍己为人: "shě jǐ wèi rén",
	穷年累月: "qióng nián lěi yuè",
	排难解纷: "pái nàn jiě fēn",
	处之泰然: "chǔ zhī tài rán",
	指鹿为马: "zhǐ lù wéi mǎ",
	危如累卵: "wēi rú lěi luǎn",
	天兵天将: "tiān bīng tiān jiàng",
	舍近求远: "shě jìn qiú yuǎn",
	南腔北调: "nán qiāng běi diào",
	苦中作乐: "kǔ zhōng zuò lè",
	厚积薄发: "hòu jī bó fā",
	臭味相投: "xiù wèi xiāng tóu",
	长幼有序: "zhǎng yòu yǒu xù",
	逼良为娼: "bī liáng wéi chāng",
	悲悲切切: "bēi bēi qiè qiē",
	败军之将: "bài jūn zhī jiàng",
	欺行霸市: "qī háng bà shì",
	削足适履: "xuē zú shì lǚ",
	先睹为快: "xiān dǔ wéi kuài",
	啼饥号寒: "tí jī háo hán",
	疏不间亲: "shū bú jiàn qīn",
	神差鬼使: "shén chāi guǐ shǐ",
	敲敲打打: "qiāo qiāo dǎ dǎ",
	平铺直叙: "píng pū zhí xù",
	没头没尾: "méi tóu mò wěi",
	寥寥可数: "liáo liáo kě shǔ",
	哼哈二将: "hēng hā èr jiàng",
	鹤发童颜: "hè fà tóng yán",
	各奔前程: "gè bèn qián chéng",
	弹无虚发: "dàn wú xū fā",
	大人先生: "dà rén xiān sheng",
	与民更始: "yǔ mín gēng shǐ",
	树碑立传: "shù bēi lì zhuàn",
	是非得失: "shì fēi dé shī",
	实逼处此: "shí bī chǔ cǐ",
	塞翁失马: "sài wēng shī mǎ",
	日薄西山: "rì bó xī shān",
	切身体会: "qiè shēn tǐ huì",
	片言只字: "piàn yán zhǐ zì",
	跑马卖解: "pǎo mǎ mài xiè",
	宁折不弯: "nìng zhé bù wān",
	零零散散: "líng líng sǎn sǎn",
	量体裁衣: "liàng tǐ cái yī",
	连中三元: "lián zhòng sān yuán",
	礼崩乐坏: "lǐ bēng yuè huài",
	不为已甚: "bù wéi yǐ shèn",
	转悲为喜: "zhuǎn bēi wéi xǐ",
	以眼还眼: "yǐ yǎn huán yǎn",
	蔚为大观: "wèi wéi dà guān",
	未为不可: "wèi wéi bù kě",
	童颜鹤发: "tóng yán hè fà",
	朋比为奸: "péng bǐ wéi jiān",
	莫此为甚: "mò cǐ wéi shèn",
	夹枪带棒: "jiā qiāng dài bàng",
	富商巨贾: "fù shāng jù jiǎ",
	淡然处之: "dàn rán chǔ zhī",
	箪食壶浆: "dān shí hú jiāng",
	创巨痛深: "chuāng jù tòng shēn",
	草长莺飞: "cǎo zhǎng yīng fēi",
	坐视不救: "zuò shī bú jiù",
	以己度人: "yǐ jǐ duó rén",
	随行就市: "suí háng jiù shì",
	文以载道: "wén yǐ zài dào",
	文不对题: "wén bú duì tí",
	铁板钉钉: "tiě bǎn dìng dīng",
	身体发肤: "shēn tǐ fà fū",
	缺吃少穿: "quē chī shǎo chuān",
	目无尊长: "mù wú zūn zhǎng",
	吉人天相: "jí rén tiān xiàng",
	毁家纾难: "huǐ jiā shū nàn",
	钢筋铁骨: "gāng jīn tiě gǔ",
	丢卒保车: "diū zú bǎo jū",
	丢三落四: "diū sān là sì",
	闭目塞听: "bì mù sè tīng",
	削尖脑袋: "xuē jiān nǎo dài",
	为非作恶: "wéi fēi zuò è",
	人才难得: "rén cái nán dé",
	情非得已: "qíng fēi dé yǐ",
	切中要害: "qiè zhòng yào hài",
	火急火燎: "huǒ jí huǒ liǎo",
	画地为牢: "huà dì wéi láo",
	好酒贪杯: "hào jiǔ tān bēi",
	长歌当哭: "cháng gē dàng kū",
	载沉载浮: "zài chén zài fú",
	遇难呈祥: "yù nàn chéng xiáng",
	榆木疙瘩: "yú mù gē da",
	以邻为壑: "yǐ lín wéi hè",
	洋为中用: "yáng wéi zhōng yòng",
	言为心声: "yán wéi xīn shēng",
	言必有中: "yán bì yǒu zhòng",
	图穷匕见: "tú qióng bǐ xiàn",
	滂沱大雨: "páng tuó dà yǔ",
	目不暇给: "mù bù xiá jǐ",
	量才录用: "liàng cái lù yòng",
	教学相长: "jiào xué xiāng zhǎng",
	悔不当初: "huǐ bù dāng chū",
	呼幺喝六: "hū yāo hè liù",
	不足为训: "bù zú wéi xùn",
	不拘形迹: "bù jū xíng jī",
	傍若无人: "páng ruò wú rén",
	罪责难逃: "zuì zé nán táo",
	自我吹嘘: "zì wǒ chuī xū",
	转祸为福: "zhuǎn huò wéi fú",
	勇冠三军: "yǒng guàn sān jūn",
	易地而处: "yì dì ér chǔ",
	卸磨杀驴: "xiè mò shā lǘ",
	玩儿不转: "wán ér bú zhuàn",
	天道好还: "tiān dào hǎo huán",
	身单力薄: "shēn dān lì bó",
	撒豆成兵: "sǎ dòu chéng bīng",
	片纸只字: "piàn zhǐ zhī zì",
	宁缺毋滥: "nìng quē wú làn",
	没没无闻: "mò mò wú wén",
	量力而为: "liàng lì ér wéi",
	历历可数: "lì lì kě shǔ",
	口碑载道: "kǒu bēi zài dào",
	君子好逑: "jūn zǐ hǎo qiú",
	好为人师: "hào wéi rén shī",
	豪商巨贾: "háo shāng jù jiǎ",
	各有所好: "gè yǒu suǒ hào",
	度德量力: "duó dé liàng lì",
	指天为誓: "zhǐ tiān wéi shì",
	逸兴遄飞: "yì xìng chuán fēi",
	心宽体胖: "xīn kuān tǐ pán",
	为德不卒: "wéi dé bù zú",
	天下为家: "tiān xià wéi jiā",
	视为畏途: "shì wéi wèi tú",
	三灾八难: "sān zāi bā nàn",
	沐猴而冠: "mù hóu ér guàn",
	哩哩啦啦: "lī li lā lā",
	见缝就钻: "jiàn fèng jiù zuān",
	夹层玻璃: "jiā céng bō li",
	急公好义: "jí gōng hào yì",
	积年累月: "jī nián lěi yuè",
	划地为牢: "huá dì wéi láo",
	更名改姓: "gēng míng gǎi xìng",
	奉为圭臬: "fèng wéi guī niè",
	多难兴邦: "duō nàn xīng bāng",
	不破不立: "bú pò bú lì",
	坐地自划: "zuò dì zì huá",
	坐不重席: "zuò bù chóng xí",
	坐不窥堂: "zuò bù kuī táng",
	作嫁衣裳: "zuò jià yī shang",
	左枝右梧: "zuǒ zhī yòu wú",
	左宜右有: "zuǒ yí yòu yǒu",
	钻头觅缝: "zuān tóu mì fèng",
	钻天打洞: "zuān tiān dǎ dòng",
	钻皮出羽: "zuān pí chū yǔ",
	钻火得冰: "zuān huǒ dé bīng",
	钻洞觅缝: "zuàn dòng mì féng",
	钻冰求火: "zuān bīng qiú huǒ",
	子为父隐: "zǐ wéi fù yǐn",
	擢发难数: "zhuó fà nán shǔ",
	着人先鞭: "zhuó rén xiān biān",
	斫雕为朴: "zhuó diāo wéi pǔ",
	锥处囊中: "zhuī chǔ náng zhōng",
	椎心饮泣: "chuí xīn yǐn qì",
	椎心泣血: "chuí xīn qì xuè",
	椎牛飨士: "chuí niú xiǎng shì",
	椎牛歃血: "chuí niú shà xuè",
	椎牛发冢: "chuí niú fà zhǒng",
	椎埋屠狗: "chuí mái tú gǒu",
	椎埋狗窃: "chuí mái gǒu qiè",
	壮发冲冠: "zhuàng fā chōng guàn",
	庄严宝相: "zhuāng yán bǎo xiàng",
	转愁为喜: "zhuǎn chóu wéi xǐ",
	转嗔为喜: "zhuǎn chēn wéi xǐ",
	拽巷啰街: "zhuài xiàng luó jiē",
	拽耙扶犁: "zhuāi pá fú lí",
	拽布拖麻: "zhuài bù tuō má",
	箸长碗短: "zhù cháng wǎn duǎn",
	铸剑为犁: "zhù jiàn wéi lí",
	杼柚其空: "zhù yòu qí kōng",
	杼柚空虚: "zhù yòu kōng xū",
	助天为虐: "zhù tiān wéi nüè",
	属垣有耳: "zhǔ yuán yǒu ěr",
	属毛离里: "zhǔ máo lí lǐ",
	属辞比事: "zhǔ cí bǐ shì",
	逐物不还: "zhú wù bù huán",
	铢量寸度: "zhū liáng cùn duó",
	铢两悉称: "zhū liǎng xī chèn",
	侏儒观戏: "zhū rú guān xì",
	朱轓皁盖: "zhū fān zào gài",
	昼度夜思: "zhòu duó yè sī",
	诪张为幻: "zhōu zhāng wéi huàn",
	重明继焰: "chóng míng jì yàn",
	众啄同音: "zhòng zhuó tóng yīn",
	众毛攒裘: "zhòng máo cuán qiú",
	众好众恶: "zhòng hào zhòng wù",
	擿埴索涂: "zhāi zhí suǒ tú",
	稚齿婑媠: "zhì chǐ wǒ tuó",
	至当不易: "zhì dàng bú yì",
	指皂为白: "zhǐ zào wéi bái",
	指雁为羹: "zhǐ yàn wéi gēng",
	指树为姓: "zhǐ shù wéi xìng",
	指山说磨: "zhǐ shān shuō mò",
	止戈为武: "zhǐ gē wéi wǔ",
	枝干相持: "zhī gàn xiāng chí",
	枝大于本: "zh dà yú běn",
	支吾其词: "zhī wú qí cí",
	正身率下: "zhèng shēn shuài xià",
	正冠李下: "zhèng guàn lǐ xià",
	整冠纳履: "zhěng guān nà lǚ",
	整躬率物: "zhěng gōng shuài wù",
	整顿干坤: "zhěng dùn gàn kūn",
	针头削铁: "zhēn tóu xuē tiě",
	贞松劲柏: "zhēn sōng jìng bǎi",
	赭衣塞路: "zhě yī sè lù",
	折箭为誓: "shé jiàn wéi shì",
	折而族之: "zhé ér zú zhī",
	昭德塞违: "zhāo dé sè wéi",
	章句小儒: "zhāng jù xiǎo rú",
	湛恩汪濊: "zhàn ēn wāng huì",
	占风望气: "zhān fēng wàng qì",
	斩将搴旗: "zhǎn jiàng qiān qí",
	曾母投杼: "zēng mǔ tóu zhù",
	曾参杀人: "zēng shēn shā rén",
	造谣中伤: "zào yáo zhòng shāng",
	早占勿药: "zǎo zhān wù yào",
	凿龟数策: "záo guī shǔ cè",
	攒三聚五: "cuán sān jù wǔ",
	攒眉蹙额: "cuán mei cù é",
	攒零合整: "cuán líng hé zhěng",
	攒锋聚镝: "cuán fēng jù dí",
	载笑载言: "zài xiào zài yán",
	载酒问字: "zài jiǔ wèn zì",
	殒身不恤: "yǔn shēn bú xù",
	云舒霞卷: "yún shū xiá juǎn",
	月中折桂: "yuè zhōng shé guì",
	月落参横: "yuè luò shēn héng",
	鬻驽窃价: "yù nú qiè jià",
	鬻鸡为凤: "yù jī wéi fèng",
	遇难成祥: "yù nàn chéng xiáng",
	郁郁累累: "yù yù lěi lěi",
	玉卮无当: "yù zhī wú dàng",
	语笑喧阗: "yǔ xiào xuān tián",
	与世沉浮: "yǔ shì chén fú",
	与时消息: "yǔ shí xiāo xi",
	逾墙钻隙: "yú qiáng zuān xì",
	渔夺侵牟: "yú duó qīn móu",
	杅穿皮蠹: "yú chuān pí dù",
	余勇可贾: "yú yǒng kě gǔ",
	予智予雄: "yú zhì yú xióng",
	予取予求: "yú qǔ yú qiú",
	于家为国: "yú jiā wéi guó",
	有借无还: "yǒu jiè wú huán",
	有加无已: "yǒu jiā wú yǐ",
	有国难投: "yǒu guó nán tóu",
	游必有方: "yóu bì yǒu fāng",
	油干灯尽: "yóu gàn dēng jìn",
	尤云殢雨: "yóu yún tì yǔ",
	庸中皦皦: "yōng zhōng jiǎo jiǎo",
	郢书燕说: "yǐng shū yān shuō",
	营蝇斐锦: "yíng yíng fēi jǐn",
	鹰心雁爪: "yīng xīn yàn zhǎo",
	莺吟燕儛: "yīng yín yàn wǔ",
	应天顺时: "yīng tiān shùn shí",
	印累绶若: "yìn léi shòu ruò",
	隐占身体: "yǐn zhàn shēn tǐ",
	饮犊上流: "yìn dú shàng liú",
	引绳切墨: "yǐn shéng qiē mò",
	龈齿弹舌: "yín chǐ dàn shé",
	因缘为市: "yīn yuán wéi shì",
	因树为屋: "yīn shù wéi wū",
	溢美溢恶: "yì měi yì wù",
	抑塞磊落: "yì sè lěi luò",
	倚闾望切: "yǐ lǘ wàng qiē",
	以意为之: "yǐ yì wéi zhī",
	以言为讳: "yǐ yán wéi huì",
	以疏间亲: "yǐ shū jiàn qīn",
	以水济水: "yǐ shuǐ jǐ shuǐ",
	以书为御: "yǐ shū wéi yù",
	以守为攻: "yǐ shǒu wéi gōng",
	以升量石: "yǐ shēng liáng dàn",
	以慎为键: "yǐ shèn wéi jiàn",
	以筌为鱼: "yǐ quán wéi yú",
	以利累形: "yǐ lì lěi xíng",
	以毁为罚: "yǐ huǐ wéi fá",
	以黑为白: "yǐ hēi wéi bái",
	以规为瑱: "yǐ guī wéi tiàn",
	以古为鉴: "yǐ gǔ wéi jiàn",
	以宫笑角: "yǐ gōng xiào jué",
	以法为教: "yǐ fǎ wéi jiào",
	以大恶细: "yǐ dà wù xì",
	遗世忘累: "yí shì wàng lěi",
	遗寝载怀: "yí qǐn zài huái",
	移的就箭: "yí dì jiù jiàn",
	依头缕当: "yī tóu lǚ dàng",
	衣租食税: "yì zū shí shuì",
	衣轻乘肥: "yì qīng chéng féi",
	衣裳之会: "yī shang zhī huì",
	衣单食薄: "yī dān shí bó",
	一还一报: "yì huán yí bào",
	叶公好龙: "yè gōng hào lóng",
	野调无腔: "yě diào wú qiāng",
	瑶池女使: "yáo chí nǚ shǐ",
	幺麽小丑: "yāo mó xiǎo chǒu",
	养精畜锐: "yǎng jīng xù ruì",
	卬首信眉: "áng shǒu shēn méi",
	洋洋纚纚: "yáng yáng sǎ sǎ",
	羊羔美酒: "yáng gāo měi jiǔ",
	扬风扢雅: "yáng fēng jié yǎ",
	燕昭市骏: "yān zhāo shì jùn",
	燕昭好马: "yān zhāo hǎo mǎ",
	燕石妄珍: "yān shí wàng zhēn",
	燕骏千金: "yān jùn qiān jīn",
	燕金募秀: "yān jīn mù xiù",
	燕驾越毂: "yān jià yuè gǔ",
	燕歌赵舞: "yān gē zhào wǔ",
	燕岱之石: "yān dài zhī shí",
	燕处危巢: "yàn chǔ wēi cháo",
	掞藻飞声: "shàn zǎo fēi shēng",
	偃革为轩: "yǎn gé wéi xuān",
	妍蚩好恶: "yán chī hǎo è",
	压良为贱: "yā liáng wéi jiàn",
	搀行夺市: "chān háng duó shì",
	泣数行下: "qì shù háng xià",
	当行出色: "dāng háng chū sè",
	秀出班行: "xiù chū bān háng",
	儿女成行: "ér nǚ chéng háng",
	大行大市: "dà háng dà shì",
	寻行数墨: "xún háng shǔ mò",
	埙篪相和: "xūn chí xiāng hè",
	血债累累: "xuè zhài lěi lěi",
	炫玉贾石: "xuàn yù gǔ shí",
	炫石为玉: "xuàn shí wéi yù",
	悬石程书: "xuán dàn chéng shū",
	悬狟素飡: "xuán huán sù cān",
	悬龟系鱼: "xuán guī xì yú",
	揎拳捋袖: "xuān quán luō xiù",
	轩鹤冠猴: "xuān hè guàn hóu",
	畜妻养子: "xù qī yǎng zǐ",
	羞人答答: "xiū rén dā dā",
	修鳞养爪: "xiū lín yǎng zhǎo",
	熊据虎跱: "xióng jù hǔ zhì",
	兄死弟及: "xiōng sǐ dì jí",
	腥闻在上: "xīng wén zài shàng",
	兴文匽武: "xīng wén yǎn wǔ",
	兴观群怨: "xìng guān qún yuàn",
	兴高彩烈: "xìng gāo cǎi liè",
	心手相应: "xīn shǒu xiāng yìng",
	心口相应: "xīn kǒu xiāng yīng",
	挟势弄权: "xié shì nòng quán",
	胁肩累足: "xié jiān lěi zú",
	校短量长: "jiào duǎn liáng cháng",
	小眼薄皮: "xiǎo yǎn bó pí",
	硝云弹雨: "xiāo yún dàn yǔ",
	鸮鸣鼠暴: "xiāo míng shǔ bào",
	削株掘根: "xuē zhū jué gēn",
	削铁无声: "xuē tiě wú shēng",
	削职为民: "xuē zhí wéi mín",
	削木为吏: "xuē mù wéi lì",
	想望风褱: "xiǎng wàng fēng huái",
	香培玉琢: "xiang pei yu zhuó",
	相鼠有皮: "xiàng shǔ yǒu pí",
	相时而动: "xiàng shí ér dòng",
	相切相磋: "xiāng qiē xiāng cuō",
	相女配夫: "xiàng nǚ pèi fū",
	相门有相: "xiàng mén yǒu xiàng",
	挦章撦句: "xián zhāng chě jù",
	先我着鞭: "xiān wǒ zhuó biān",
	习焉不察: "xí yān bù chá",
	歙漆阿胶: "shè qī ē jiāo",
	晰毛辨发: "xī máo biàn fà",
	悉索薄赋: "xī suǒ bó fù",
	雾鳞云爪: "wù lín yún zhǎo",
	物稀为贵: "wù xī wéi guì",
	碔砆混玉: "wǔ fū hùn yù",
	武断专横: "wǔ duàn zhuān héng",
	五石六鹢: "wǔ shí liù yì",
	五色相宣: "wǔ sè xiāng xuān",
	五侯七贵: "wǔ hóu qī guì",
	五侯蜡烛: "wǔ hòu là zhú",
	五羖大夫: "wǔ gǔ dà fū",
	吾自有处: "wú zì yǒu chǔ",
	无下箸处: "wú xià zhù chǔ",
	无伤无臭: "wú shāng wú xiù",
	无能为役: "wú néng wéi yì",
	无寇暴死: "wú kòu bào sǐ",
	无孔不钻: "wú kǒng bú zuàn",
	无间可乘: "wú jiān kě chéng",
	无间冬夏: "wú jiān dōng xià",
	无恶不为: "wú è bù wéi",
	无动为大: "wú dòng wéi dà",
	诬良为盗: "wū liáng wéi dào",
	握拳透爪: "wò quán tòu zhǎo",
	文武差事: "wén wǔ chāi shì",
	委委佗佗: "wēi wēi tuó tuó",
	惟日为岁: "wéi rì wéi suì",
	帷薄不修: "wéi bó bù xiū",
	为善最乐: "wéi shàn zuì lè",
	为山止篑: "wéi shān zhǐ kuì",
	为仁不富: "wéi rén bú fù",
	为裘为箕: "wéi qiú wéi jī",
	为民父母: "wéi mín fù mǔ",
	为虺弗摧: "wéi huǐ fú cuī",
	为好成歉: "wéi hǎo chéng qiàn",
	为鬼为蜮: "wéi guǐ wéi yù",
	望风响应: "wàng fēng xiǎng yīng",
	望尘僄声: "wàng chén piào shēng",
	往渚还汀: "wǎng zhǔ huán tīng",
	王贡弹冠: "wáng gòng dàn guàn",
	亡国大夫: "wáng guó dà fū",
	万贯家私: "wàn guàn jiā sī",
	晚食当肉: "wǎn shí dàng ròu",
	晚节不保: "wǎn jié bù bǎo",
	玩岁愒时: "wán suì kài shí",
	蛙蟆胜负: "wā má shèng fù",
	吞言咽理: "tūn yán yàn lǐ",
	颓垣断堑: "tuí yuán duàn qiàn",
	推干就湿: "tuī gàn jiù shī",
	剸繁决剧: "tuán fán jué jù",
	团头聚面: "tuán tóu jù miàn",
	兔丝燕麦: "tù sī yàn mài",
	兔头麞脑: "tù tóu zhāng nǎo",
	兔葵燕麦: "tù kuí yàn mài",
	吐哺握发: "tǔ bǔ wò fà",
	投传而去: "tóu zhuàn ér qù",
	头没杯案: "tóu mò bēi àn",
	头昏脑闷: "tóu hūn nǎo mèn",
	头会箕敛: "tóu kuài jī liǎn",
	头出头没: "tóu chū tóu mò",
	痛自创艾: "tòng zì chuāng yì",
	同恶相助: "tóng wù xiāng zhù",
	同恶相恤: "tóng wù xiāng xù",
	痌瘝在抱: "tōng guān zài bào",
	通文调武: "tōng wén diào wǔ",
	停留长智: "tíng liú zhǎng zhì",
	铁树开华: "tiě shù kāi huā",
	条贯部分: "tiáo guàn bù fēn",
	挑牙料唇: "tiǎo yá liào chún",
	挑么挑六: "tiāo yāo tiāo liù",
	挑唇料嘴: "tiǎo chún liào zuǐ",
	恬不为意: "tián bù wéi yì",
	恬不为怪: "tián bù wéi guài",
	天下为笼: "tiān xià wéi lóng",
	天台路迷: "tiān tái lù mí",
	天年不遂: "tiān nián bú suì",
	探囊胠箧: "tàn náng qū qiè",
	谭言微中: "tán yán wēi zhòng",
	谈言微中: "tán yán wēi zhòng",
	狧穅及米: "shì kāng jí mǐ",
	随物应机: "suí wù yīng jī",
	搜岩采干: "sōu yán cǎi gàn",
	宋斤鲁削: "sòng jīn lǔ xuē",
	松筠之节: "sōng yún zhī jié",
	四亭八当: "sì tíng bā dàng",
	四马攒蹄: "sì mǎ cuán tí",
	四不拗六: "sì bú niù liù",
	思所逐之: "sī suǒ zhú zhī",
	丝恩发怨: "sī ēn fà yuàn",
	硕望宿德: "shuò wàng xiǔ dé",
	铄古切今: "shuò gǔ qiē jīn",
	顺风而呼: "shùn fēng ér hū",
	顺风吹火: "shùn fēng chuī huǒ",
	水中著盐: "shuǐ zhōng zhuó yán",
	双柑斗酒: "shuāng gān dǒu jiǔ",
	数米而炊: "shǔ mǐ ér chuī",
	数米量柴: "shǔ mǐ liáng chái",
	数理逻辑: "shù lǐ luó ji",
	数黑论黄: "shǔ hēi lùn huáng",
	数白论黄: "shǔ bái lùn huáng",
	束缊还妇: "shù yūn huán fù",
	束蒲为脯: "shù pú wéi pú",
	束椽为柱: "shù chuán wéi zhù",
	书缺有间: "shū quē yǒu jiàn",
	手足重茧: "shǒu zú chóng jiǎn",
	手足异处: "shǒu zú yì chǔ",
	手脚干净: "shǒu jiǎo gàn jìng",
	手不应心: "shǒu bù yīng xīn",
	螫手解腕: "shì shǒu jiě wàn",
	释知遗形: "shì zhī yí xíng",
	适时应务: "shì shí yīng wù",
	适情率意: "shì qíng shuài yì",
	适当其冲: "shì dāng qí chōng",
	视为知己: "shì wéi zhī jǐ",
	使羊将狼: "shǐ yáng jiàng láng",
	食为民天: "shí wéi mín tiān",
	拾掇无遗: "shí duō wú yí",
	实与有力: "shí yù yǒu lì",
	石英玻璃: "shí yīng bō li",
	石室金匮: "shí shì jīn guì",
	什袭珍藏: "shí xí zhēn cáng",
	什伍东西: "shí wǔ dōng xī",
	什围伍攻: "shí wéi wǔ gōng",
	十魔九难: "shí mó jiǔ nàn",
	诗书发冢: "shī shū fà zhǒng",
	虱处裈中: "shī chǔ kūn zhōng",
	师直为壮: "shī zhí wéi zhuàng",
	尸居龙见: "shī jū lóng xiàn",
	圣经贤传: "shèng jīng xián zhuàn",
	圣君贤相: "shèng jūn xián xiàng",
	生拖死拽: "shēng tuō sǐ zhuài",
	审己度人: "shěn jǐ duó rén",
	神武挂冠: "shén wǔ guà guàn",
	神龙失埶: "shén lóng shī shì",
	深文曲折: "shēn wén qǔ shé",
	深厉浅揭: "shēn lì qiǎn qì",
	深谷为陵: "shēn gǔ wéi líng",
	深恶痛疾: "shēn wù tòng jí",
	深仇宿怨: "shēn chóu xiǔ yuàn",
	舍己为公: "shě jǐ wèi gōng",
	舍短取长: "shě duǎn qǔ cháng",
	舍策追羊: "shě cè zhuī yáng",
	蛇蝎为心: "shé xiē wéi xīn",
	少成若性: "shào chéng ruò xìng",
	上当学乖: "shàng dàng xué guāi",
	赏不当功: "shǎng bù dāng gōng",
	善自为谋: "shàn zì wéi móu",
	善为说辞: "shàn wéi shuō cí",
	善善恶恶: "shàn shàn wù è",
	善财难舍: "shàn cái nán shě",
	苫眼铺眉: "shān yǎn pū méi",
	讪牙闲嗑: "shàn yá xián kē",
	山阴乘兴: "shān yīn chéng xīng",
	山殽野湋: "shān yáo yě wéi",
	山溜穿石: "shān liù chuān shí",
	山节藻棁: "shān jié zǎo zhuō",
	杀鸡为黍: "shā jī wéi shǔ",
	色厉胆薄: "sè lì dǎn bó",
	桑荫未移: "sāng yīn wèi yí",
	桑荫不徙: "sāng yīn bù xǐ",
	桑土绸缪: "sāng tǔ chóu miù",
	桑户棬枢: "sāng hù juàn shū",
	三战三北: "sān zhàn sān běi",
	三瓦两舍: "sān wǎ liǎng shě",
	三人为众: "sān rén wèi zhòng",
	三差两错: "sān chā liǎng cuò",
	塞井焚舍: "sāi jǐng fén shě",
	洒心更始: "sǎ xīn gèng shǐ",
	洒扫应对: "sǎ sǎo yìng duì",
	软红香土: "ruǎn hóng xiāng tǔ",
	入吾彀中: "rù wú gòu zhōng",
	入铁主簿: "rù tiě zhǔ bù",
	入理切情: "rù lǐ qiē qíng",
	汝成人耶: "rǔ chéng rén yé",
	如水投石: "rú shuǐ tóu shí",
	如切如磋: "rú qiē rú cuō",
	如登春台: "rú dēng chūn tái",
	肉薄骨并: "ròu bó gǔ bìng",
	柔情绰态: "róu qíng chuò tài",
	戎马劻勷: "róng mǎ kuāng ráng",
	日中为市: "rì zhōng wéi shì",
	日月参辰: "rì yuè shēn chén",
	日省月修: "rì xǐng yuè xiū",
	日削月割: "rì xuē yuè gē",
	日省月试: "rì xǐng yuè shì",
	任达不拘: "rèn dá bù jū",
	人言藉藉: "rén yán jí jí",
	人模狗样: "rén mú gǒu yàng",
	人莫予毒: "rén mò yú dú",
	热熬翻饼: "rè áo fān bǐng",
	圈牢养物: "juàn láo yǎng wù",
	取予有节: "qǔ yǔ yǒu jié",
	诎要桡腘: "qū yāo ráo guó",
	穷形尽相: "qióng xíng jìn xiàng",
	情凄意切: "qíng qī yì qiè",
	情见势屈: "qíng xiàn shì qū",
	情见乎辞: "qíng xiàn hū cí",
	清都绛阙: "qīng dōu jiàng què",
	倾肠倒肚: "qīng cháng dào dǔ",
	青紫被体: "qīng zǐ pī tǐ",
	青林黑塞: "qīng lín hēi sài",
	螓首蛾眉: "qín shǒu é méi",
	琴瑟之好: "qín sè zhī hào",
	且住为佳: "qiě zhù wéi jiā",
	切树倒根: "qiē shù dǎo gēn",
	切理餍心: "qiē lǐ yàn xīn",
	切近的当: "qiē jìn de dāng",
	翘足引领: "qiáo zú yǐn lǐng",
	巧发奇中: "qiǎo fā qí zhòng",
	强嘴拗舌: "jiàng zuǐ niù shé",
	强直自遂: "qiáng zhí zì suí",
	强死强活: "qiǎng sǐ qiǎng huó",
	强食自爱: "qiǎng shí zì ài",
	强食靡角: "qiǎng shí mí jiǎo",
	强弓劲弩: "qiáng gōng jìng nǔ",
	强聒不舍: "qiǎng guō bù shě",
	强凫变鹤: "qiáng fú biàn hè",
	强而后可: "qiǎng ér hòu kě",
	强得易贫: "qiǎng dé yì pín",
	遣兴陶情: "qiǎn xìng táo qíng",
	牵羊担酒: "qiān yáng dān jiǔ",
	千了百当: "qiān liǎo bǎi dàng",
	泣下如雨: "qì xià rú yǔ",
	起偃为竖: "qǐ yǎn wéi shù",
	岂弟君子: "kǎi tì jūn zǐ",
	綦溪利跂: "qí xī lì qí",
	棋输先著: "qí shū xiān zhuó",
	齐王舍牛: "qí wáng shě niú",
	欺天诳地: "qī tiān kuáng dì",
	普天率土: "pǔ tiān shuài tǔ",
	铺胸纳地: "pū xiōng nà dì",
	铺锦列绣: "pū jǐn liè xiù",
	破家为国: "pò jiā wèi guó",
	破觚为圜: "pò gū wéi yuán",
	萍飘蓬转: "píng piāo péng zhuàn",
	帡天极地: "píng tiān jí dì",
	屏声息气: "bǐng shēng xī qì",
	凭几据杖: "píng jī jù zhàng",
	贫嘴薄舌: "pín zuǐ bó shé",
	片语只辞: "piàn yǔ zhī cí",
	披发文身: "pī fà wén shēn",
	烹龙炮凤: "pēng lóng páo fèng",
	炰鳖脍鲤: "fǒu biē kuài lǐ",
	庞眉皓发: "páng méi hào fà",
	攀花折柳: "pān huā zhé liǔ",
	攀蟾折桂: "pān chán shé guì",
	女大难留: "nǚ dà nán liú",
	弄玉吹箫: "nòng yù chuī xiāo",
	弄管调弦: "nòng guǎn tiáo xián",
	弄粉调朱: "nòng fěn diào zhū",
	浓抹淡妆: "nóng mò dàn zhuāng",
	捻土为香: "niǎn tǔ wéi xiāng",
	年谊世好: "nián yì shì hǎo",
	年华垂暮: "nián huá chuí mù",
	儗不于伦: "nǐ bù yú lún",
	泥而不滓: "ní ér bù zǐ",
	能者为师: "néng zhě wéi shī",
	能不称官: "néng bú chèn guān",
	挠直为曲: "náo zhí wéi qū",
	难进易退: "nán jìn yì tuì",
	难得糊涂: "nán dé hú tú",
	南蛮鴂舌: "nán mán jué shé",
	南贩北贾: "nán fàn běi gǔ",
	牧猪奴戏: "mù zhū nú xì",
	目眢心忳: "mù yuān xīn tún",
	目挑心招: "mù tiǎo xīn zhāo",
	目量意营: "mù liàng yì yíng",
	木头木脑: "mù tóu mù nǎo",
	木干鸟栖: "mù gàn niǎo qī",
	侔色揣称: "móu sè chuǎi chèn",
	莫予毒也: "mò yú dú yě",
	抹粉施脂: "mò fěn shī zhī",
	磨砻镌切: "mó lóng juān qiē",
	磨棱刓角: "mó léng wán jiǎo",
	摸门不着: "mō mén bù zháo",
	摸不着边: "mō bù zhuó biān",
	命中注定: "mìng zhōng zhù dìng",
	鸣鹤之应: "míng hè zhī yìng",
	明效大验: "míng xiào dà yàn",
	名我固当: "míng wǒ gù dāng",
	邈处欿视: "miǎo chǔ kǎn shì",
	黾穴鸲巢: "měng xué qú cháo",
	绵里薄材: "mián lǐ bó cái",
	靡有孑遗: "mǐ yǒu jié yí",
	靡衣偷食: "mǐ yī tōu shí",
	迷恋骸骨: "mí liàn hái gǔ",
	扪参历井: "mén shēn lì jǐng",
	门单户薄: "mén dān hù bó",
	昧旦晨兴: "mèi dàn chén xīng",
	冒名接脚: "mào míng jiē jiǎo",
	毛遂堕井: "máo suí duò jǐng",
	毛发倒竖: "máo fā dǎo shù",
	卖文为生: "mài wén wéi shēng",
	卖李钻核: "mài lǐ zuān hé",
	买椟还珠: "mǎi dú huán zhū",
	埋三怨四: "mán sān yuàn sì",
	马入华山: "mǎ rù huá shān",
	落魄江湖: "luò pò jiāng hú",
	落落难合: "luò luò nán hé",
	落草为寇: "luò cǎo wéi kòu",
	罗织构陷: "luó zhī gòu xiàn",
	鸾凤和鸣: "luán fèng hè míng",
	率由旧章: "shuài yóu jiù zhāng",
	率土同庆: "shuài tǔ tóng qìng",
	率兽食人: "shuài shòu shí rén",
	率土归心: "shuài tǔ guī xīn",
	率马以骥: "shuài mǎ yǐ jì",
	率尔成章: "shuài ěr chéng zhāng",
	鲁斤燕削: "lǔ jīn yàn xuē",
	漏尽更阑: "lòu jìn gēng lán",
	笼鸟槛猿: "lóng niǎo jiàn yuán",
	笼鸟池鱼: "lóng niǎo chí yú",
	龙游曲沼: "lóng yóu qū zhǎo",
	龙血玄黄: "lóng xuè xuán huáng",
	龙雕凤咀: "lóng diāo fèng jǔ",
	六尺之讬: "liù chǐ zhī tuō",
	令原之戚: "líng yuán zhī qī",
	令人捧腹: "lìng rén pěng fù",
	陵劲淬砺: "líng jìng cuì lì",
	临敌易将: "lín dí yì jiàng",
	裂裳衣疮: "liè shang yī chuāng",
	裂冠毁冕: "liè guàn huǐ miǎn",
	了无惧色: "liǎo wú jù sè",
	了身达命: "liǎo shēn dá mìng",
	了然无闻: "liǎo rán wú wén",
	了不可见: "liǎo bù kě jiàn",
	了不长进: "liǎo bù zhǎng jìn",
	燎发摧枯: "liǎo fà cuī kū",
	审时度势: "shěn shí duó shì",
	量小力微: "liàng xiǎo lì wēi",
	相时度力: "xiāng shí duó lì",
	量枘制凿: "liàng ruì zhì záo",
	量如江海: "liàng rú jiāng hǎi",
	量金买赋: "liàng jīn mǎi fù",
	量己审分: "liàng jǐ shěn fēn",
	敛骨吹魂: "liǎn gǔ chuī hún",
	詈夷为跖: "lì yí wéi zhí",
	利令志惛: "lì lìng zhì hūn",
	李广不侯: "lǐ guǎng bú hòu",
	礼为情貌: "lǐ wéi qíng mào",
	礼让为国: "lǐ ràng wéi guó",
	犁生骍角: "lí shēng xīng jiǎo",
	离本徼末: "lí běn jiǎo mò",
	楞眉横眼: "léng méi hèng yǎn",
	擂天倒地: "léi tiān dǎo dì",
	累足成步: "lěi zú chéng bù",
	累瓦结绳: "lěi wǎ jié shéng",
	累土至山: "lěi tǔ zhì shān",
	累土聚沙: "lěi tǔ jù shā",
	累卵之危: "lěi luǎn zhī wēi",
	累累如珠: "lěi lěi rú zhū",
	累块积苏: "lěi kuài jī sū",
	乐山乐水: "lè shān lè shuǐ",
	潦原浸天: "lǎo yuán jìn tiān",
	老师宿儒: "lǎo shī xiǔ rú",
	牢什古子: "láo shí gǔ zi",
	琅嬛福地: "láng huán fú dì",
	揆情度理: "kuí qíng duó lǐ",
	旷日累时: "kuàng rì lěi shí",
	匡救弥缝: "kuāng jiù mí fèng",
	枯树生华: "kū shù shēng huā",
	口轻舌薄: "kǒu qīng shé bó",
	口角生风: "kǒu jiǎo shēng fēng",
	口角春风: "kǒu jiǎo chūn fēng",
	口角风情: "kǒu jiǎo fēng qíng",
	口干舌焦: "kǒu gān shé jiāo",
	口腹之累: "kǒu fù zhī lěi",
	空腹便便: "kōng fù pián pián",
	嗑牙料嘴: "kē yá liào zuǐ",
	刻木为鹄: "kè mù wéi hú",
	咳珠唾玉: "ké zhū tuò yù",
	咳唾成珠: "ké tuò chéng zhū",
	抗颜为师: "kàng yán wéi shī",
	开华结果: "kāi huā jié guǒ",
	峻阪盐车: "jùn bǎn yán chē",
	嚼铁咀金: "jiáo tiě jǔ jīn",
	嚼墨喷纸: "jué mò pēn zhǐ",
	倔头强脑: "juè tóu jiàng nǎo",
	倔头倔脑: "juè tóu juè nǎo",
	倦鸟知还: "juàn niǎo zhī huán",
	卷席而葬: "juǎn xí ér zàng",
	卷甲倍道: "juǎn jiǎ bèi dào",
	聚米为山: "jù mǐ wéi shān",
	举手相庆: "jǔ shǒu xiāng qìng",
	举世混浊: "jǔ shì hún zhuó",
	鞠为茂草: "jū wéi mào cǎo",
	拘神遣将: "jū shén qiǎn jiàng",
	居下讪上: "jū xià shàn shàng",
	久要不忘: "jiǔ yāo bú wàng",
	九转功成: "jiǔ zhuǎn gōng chéng",
	九蒸三熯: "jiǔ zhēng sān hàn",
	敬业乐群: "jìng yè lè qún",
	井底虾蟆: "jǐng dǐ xiā má",
	旌旗卷舒: "jīng qí juǎn shū",
	荆棘载途: "jīng jí zài tú",
	禁舍开塞: "jìn shě kāi sāi",
	祲威盛容: "jìn wēi shèng róng",
	进退消长: "jìn tuì xiāo cháng",
	进退应矩: "jìn tuì yīng jǔ",
	进退触籓: "jìn tuì chù fān",
	进退跋疐: "jìn tuì bá zhì",
	尽多尽少: "jǐn duō jǐn shǎo",
	锦囊还矢: "jǐn náng huán shǐ",
	矜己自饰: "jīn jǐ zì shì",
	矜功负气: "jīn gōng fù qì",
	津关险塞: "jīn guān xiǎn sài",
	金吾不禁: "jīn wú bú jìn",
	金翅擘海: "jīn chì bāi hǎi",
	解衣衣人: "jiě yī yī rén",
	解人难得: "jiě rén nán dé",
	解铃系铃: "jiě líng xì líng",
	解发佯狂: "jiě fà yáng kuáng",
	诘屈磝碻: "jié qū áo qiāo",
	教猱升木: "jiāo náo shēng mù",
	较瘦量肥: "jiào shòu liàng féi",
	角立杰出: "jiǎo lì jié chū",
	焦沙烂石: "jiāo shā làn shí",
	骄儿騃女: "jiāo ér sì nǚ",
	浇风薄俗: "jiāo fēng bó sú",
	降妖捉怪: "xiáng yāo zhuō guài",
	将取固予: "jiāng qǔ gù yǔ",
	将门有将: "jiàng mén yǒu jiàng",
	将夺固与: "jiāng duó gù yǔ",
	槛花笼鹤: "jiàn huā lóng hè",
	鉴影度形: "jiàn yǐng duó xíng",
	渐不可长: "jiàn bù kě zhǎng",
	见素抱朴: "xiàn sù bào pǔ",
	见弃于人: "jiàn qì yú rén",
	简丝数米: "jiǎn sī shǔ mǐ",
	俭不中礼: "jiǎn bú zhòng lǐ",
	间见层出: "jiàn xiàn céng chū",
	尖嘴薄舌: "jiān zuǐ bó shé",
	甲冠天下: "jiǎ guàn tiān xià",
	葭莩之亲: "jiā fú zhī qīn",
	家累千金: "jiā lèi qiān jīn",
	家给人足: "jiā jǐ rén zú",
	家道从容: "jiā dào cóng róng",
	夹袋人物: "jiā dài rén wù",
	霁风朗月: "jì fēng lǎng yuè",
	寄兴寓情: "jì xìng yù qíng",
	计深虑远: "jì shēn lǜ yuǎn",
	计功量罪: "jì gōng liàng zuì",
	掎裳连襼: "jǐ shang lián yì",
	虮虱相吊: "jǐ shī xiāng diào",
	疾不可为: "jí bù kě wéi",
	极深研几: "jí shēn yán jī",
	及宾有鱼: "jí bīn yǒu yú",
	激薄停浇: "jī bó tíng jiāo",
	积素累旧: "jī sù lěi jiù",
	积时累日: "jī shí lěi rì",
	积露为波: "jī lù wéi bō",
	积德累功: "jī dé lěi gōng",
	积谗糜骨: "jī chán méi gǔ",
	击排冒没: "jī pái mào mò",
	祸为福先: "huò wéi fú xiān",
	祸福相依: "huò fú xiāng yī",
	获隽公车: "huò jùn gōng chē",
	混应滥应: "hùn yīng làn yīng",
	毁舟为杕: "huǐ zhōu wéi duò",
	毁钟为铎: "huǐ zhōng wéi duó",
	毁冠裂裳: "huǐ guān liè cháng",
	晦盲否塞: "huì máng pǐ sè",
	回船转舵: "huí chuán zhuàn duò",
	潢池盗弄: "huáng chí dào nòng",
	黄冠草履: "huáng guàn cǎo lǚ",
	黄发儿齿: "huáng fà ér chǐ",
	黄发垂髫: "huáng fà chuí tiáo",
	还珠返璧: "huán zhū fǎn bì",
	还年驻色: "huán nián zhù sè",
	还年却老: "huán nián què lǎo",
	坏裳为裤: "huài shang wéi kù",
	画荻和丸: "huà dí huò wán",
	化枭为鸠: "huà xiāo wéi jiū",
	化腐为奇: "huà fǔ wéi qí",
	化鸱为凤: "huà chī wéi fèng",
	花不棱登: "huā bu lēng dēng",
	户限为穿: "hù xiàn wéi chuān",
	呼卢喝雉: "hū lú hè zhì",
	呼来喝去: "hū lái hè qù",
	呼不给吸: "hū bù jǐ xī",
	厚味腊毒: "hòu wèi xī dú",
	厚德载物: "hòu dé zài wù",
	鸿渐于干: "hóng jiàn yú gàn",
	洪炉燎发: "hóng lú liáo fà",
	红绳系足: "hóng shéng jì zú",
	红不棱登: "hóng bu lēng dēng",
	横抢硬夺: "hèng qiǎng yìng duó",
	横恩滥赏: "hèng ēn làn shǎng",
	恨海难填: "hèn hǎi nán tián",
	鹤发鸡皮: "hè fà jī pí",
	涸思干虑: "hé sī gān lǜ",
	河涸海干: "hé hé hǎi gān",
	和颜说色: "hé yán yuè sè",
	合从连衡: "hé zòng lián héng",
	浩浩汤汤: "hào hào shāng shāng",
	好勇斗狠: "hào yǒng dòu hěn",
	好问则裕: "hào wèn zé yù",
	好为事端: "hào wéi shì duān",
	好问决疑: "hào wèn jué yí",
	好生之德: "hào shēng zhī dé",
	好奇尚异: "hǎo qí shàng yì",
	好恶不同: "hǎo è bù tóng",
	好丹非素: "hào dān fēi sù",
	豪干暴取: "háo gàn bào qǔ",
	毫发不爽: "háo fà bù shuǎng",
	寒酸落魄: "hán suān luò pò",
	含英咀华: "hán yīng jǔ huá",
	含糊不明: "hán hú bù míng",
	过为已甚: "guò wéi yǐ shèn",
	桂折兰摧: "guì shé lán cuī",
	规旋矩折: "guī xuán jǔ shé",
	广文先生: "guǎng wén xiān sheng",
	广陵散绝: "guǎng líng sǎn jué",
	冠山戴粒: "guàn shān dài lì",
	冠屦倒施: "guàn jù dǎo shī",
	挂席为门: "guà xí wéi mén",
	寡见鲜闻: "guǎ jiàn xiǎn wén",
	瓜葛相连: "guā gé xiāng lián",
	鼓吻奋爪: "gǔ wěn fèn zhǎo",
	古调单弹: "gǔ diào dān tán",
	古调不弹: "gǔ diào bù tán",
	姑射神人: "gū yè shén rén",
	苟合取容: "gǒu hé qǔ róng",
	狗续侯冠: "gǒu xù hòu guàn",
	钩爪锯牙: "gōu zhǎo jù yá",
	共枝别干: "gòng zhī bié gàn",
	共为唇齿: "gòng wéi chún chǐ",
	拱手而降: "gǒng shǒu ér xiáng",
	拱肩缩背: "gǒng jiān suō bèi",
	功薄蝉翼: "gōng bó chán yì",
	弓调马服: "gōng diào mǎ fú",
	更姓改物: "gēng xìng gǎi wù",
	更仆难数: "gēng pú nán shǔ",
	更令明号: "gēng lìng míng hào",
	更待干罢: "gèng dài gàn bà",
	更唱迭和: "gēng chàng dié hé",
	更长梦短: "gēng cháng mèng duǎn",
	各色名样: "gè sè míng yàng",
	格格不纳: "gé gé bú nà",
	格格不吐: "gé gé bù tǔ",
	告朔饩羊: "gù shuò xì yáng",
	膏车秣马: "gào chē mò mǎ",
	高义薄云: "gāo yì bó yún",
	岗头泽底: "gāng tóu zé dǐ",
	敢为敢做: "gǎn wéi gǎn zuò",
	甘分随时: "gān fèn suí shí",
	甘处下流: "gān chǔ xià liú",
	干啼湿哭: "gàn tí shī kū",
	干名犯义: "gàn míng fàn yì",
	干将莫邪: "gān jiāng mò yé",
	干城之将: "gān chéng zhī jiàng",
	腹载五车: "fù zài wǔ chē",
	父债子还: "fù zhài zǐ huán",
	父为子隐: "fù wéi zǐ yǐn",
	辅世长民: "fǔ shì zhǎng mín",
	福为祸始: "fú wéi huò shǐ",
	符号逻辑: "fú hào luó jí",
	浮收勒折: "fú shōu lè shé",
	肤受之愬: "fū shòu zhī sù",
	否终则泰: "pǐ zhōng zé tài",
	佛头著粪: "fó tóu zhuó fèn",
	奉为楷模: "fèng wéi kǎi mó",
	凤靡鸾吪: "fèng mǐ luán é",
	封豨修蛇: "fēng xī xiū shé",
	风影敷衍: "fēng yǐng fū yǎn",
	丰屋蔀家: "fēng wū bù jiā",
	粪土不如: "fèn tǔ bù rú",
	分风劈流: "fēn fēng pǐ liú",
	沸沸汤汤: "fèi fèi shāng shāng",
	菲食薄衣: "fěi shí bó yī",
	飞将数奇: "fēi jiàng shù qí",
	放辟邪侈: "fàng pì xié chǐ",
	方领圆冠: "fāng lǐng yuán guàn",
	犯而不校: "fàn ér bú jiào",
	返本还源: "fǎn běn huán yuán",
	反劳为逸: "fǎn láo wéi yì",
	法轮常转: "fǎ lún cháng zhuàn",
	罚不当罪: "fá bù dāng zuì",
	发引千钧: "fà yǐn qiān jūn",
	发奸擿伏: "fā jiān tī fú",
	发短心长: "fà duǎn xīn cháng",
	二竖为虐: "èr shù wéi nüè",
	儿女心肠: "ér nǚ xīn cháng",
	儿女亲家: "ér nǚ qìng jiā",
	遏恶扬善: "è wù yáng shàn",
	饿殍枕藉: "è piǎo zhěn jí",
	饿殍载道: "è piǎo zài dào",
	恶醉强酒: "wù zuì qiǎng jiǔ",
	恶意中伤: "è yì zhòng shāng",
	恶湿居下: "wù shī jū xià",
	恶居下流: "wù jū xià liú",
	恶不去善: "wù bú qù shàn",
	扼吭夺食: "è háng duó shí",
	扼襟控咽: "è jīn kòng yān",
	峨峨汤汤: "é é shāng shāng",
	屙金溺银: "ē jīn niào yín",
	朵颐大嚼: "duǒ yí dà jiáo",
	夺人所好: "duó rén suǒ hào",
	多言数穷: "duō yán shuò qióng",
	多文为富: "duō wén wéi fù",
	多端寡要: "duō duān guǎ yào",
	多财善贾: "duō cái shàn gǔ",
	遁世无闷: "dùn shì wú mèn",
	遁迹黄冠: "dùn jì huáng guàn",
	堆案盈几: "duī àn yíng jī",
	断还归宗: "duàn huán guī zōng",
	短见薄识: "duǎn jiàn bó shí",
	蠹居棊处: "dù jū qí chǔ",
	度己以绳: "duó jǐ yǐ shéng",
	杜默为诗: "dù mò wéi shī",
	杜鹃啼血: "dù juān tí xuè",
	笃近举远: "dǔ jìn jǔ yuǎn",
	独有千秋: "dú yǒu qiān qiū",
	读书得间: "dú shū dé jiàn",
	斗转参横: "dǒu zhuǎn shēn héng",
	兜肚连肠: "dōu dǔ lián cháng",
	洞见症结: "dòng jiàn zhèng jié",
	恫疑虚喝: "dòng yí xū hè",
	动中窾要: "dòng zhōng kuǎn yào",
	东鸣西应: "dōng míng xī yīng",
	东鳞西爪: "dōng lín xī zhǎo",
	东量西折: "dōng liàng xī shé",
	东家西舍: "dōng jiā xī shè",
	东扯西拽: "dōng chě xī zhuāi",
	鼎铛有耳: "dǐng chēng yǒu ěr",
	鼎铛玉石: "dǐng chēng yù shí",
	钉头磷磷: "dīng tóu lín lín",
	跌宕不羁: "diē dàng bù jī",
	跌弹斑鸠: "diē dàn bān jiū",
	雕心雁爪: "diāo xīn yàn zhǎo",
	颠倒衣裳: "diān dǎo yī cháng",
	德薄能鲜: "dé bó néng xiǎn",
	得马折足: "dé mǎ shé zú",
	蹈其覆辙: "dǎo qí fù zhé",
	捣虚撇抗: "dǎo xū piē kàng",
	倒载干戈: "dào zài gān gē",
	倒裳索领: "dào cháng suǒ lǐng",
	倒果为因: "dào guǒ wéi yīn",
	叨在知己: "tāo zài zhī jǐ",
	叨陪末座: "tāo péi mò zuò",
	党豺为虐: "dǎng chái wéi nüè",
	当轴处中: "dāng zhóu chǔ zhōng",
	当着不着: "dāng zhuó bù zhuó",
	当务始终: "dāng wù shǐ zhōng",
	淡汝浓抹: "dàn rǔ nóng mǒ",
	弹丸脱手: "tán wán tuō shǒu",
	弹铗无鱼: "dàn jiá wú yú",
	箪食瓢饮: "dān sì piáo yǐn",
	大璞不完: "dà pú bù wán",
	大明法度: "dà míng fǎ dù",
	大车以载: "dà chē yǐ zài",
	打闷葫芦: "dǎ mèn hú lu",
	沓来踵至: "tà lái zhǒng zhì",
	厝火燎原: "cuò huǒ liǎo yuán",
	撮科打哄: "cuō kē dǎ hòng",
	寸积铢累: "cùn jī zhū lěi",
	啛啛喳喳: "cuì cuì chā chā",
	摧折豪强: "cuī zhé háo qiáng",
	摧刚为柔: "cuī gāng wéi róu",
	从俗就简: "cóng sú jiù jiǎn",
	此发彼应: "cǐ fā bǐ yīng",
	此唱彼和: "cǐ chàng bǐ hè",
	慈悲为本: "cí bēi wéi běn",
	纯属骗局: "chún shǔ piàn jú",
	春笋怒发: "chūn sǔn nù fā",
	垂头搨翼: "chuí tóu tà yì",
	传为笑谈: "chuán wéi xiào tán",
	传风扇火: "chuán fēng shān huǒ",
	穿红着绿: "chuān hóng zhuó lǜ",
	触处机来: "chù chǔ jī lái",
	处尊居显: "chǔ zūn jū xiǎn",
	处堂燕雀: "chǔ táng yàn què",
	处实效功: "chǔ shí xiào gōng",
	处高临深: "chǔ gāo lín shēn",
	出入无间: "chū rù wú jiān",
	出门应辙: "chū mén yīng zhé",
	出处语默: "chū chǔ yǔ mò",
	出处殊途: "chū chǔ shū tú",
	出处进退: "chū chǔ jìn tuì",
	愁山闷海: "chóu shān mèn hǎi",
	冲冠眦裂: "chōng guàn zì liè",
	齿牙为祸: "chǐ yá wéi huò",
	尺二冤家: "chǐ èr yuān jia",
	尺短寸长: "chǐ duǎn cùn cháng",
	尺寸之功: "chǐ cùn zhī gōng",
	城北徐公: "chéng běi xú gōng",
	成败兴废: "chéng bài xīng fèi",
	趁水和泥: "chèn shuǐ huò ní",
	称雨道晴: "chēng yǔ dào qíng",
	称体载衣: "chēng tǐ zài yī",
	称体裁衣: "chèn tǐ cái yī",
	称家有无: "chèn jiā yǒu wú",
	称德度功: "chēng dé duó gōng",
	沉吟章句: "chén yín zhāng jù",
	沉吟不决: "chén yín bù jué",
	沉疴宿疾: "chén kē sù jí",
	扯纤拉烟: "chě qiàn lā yān",
	扯顺风旗: "chě shùn fēng qí",
	车载船装: "chē zǎi chuán zhuāng",
	朝升暮合: "zhāo shēng mù gě",
	朝攀暮折: "zhāo pān mù shé",
	超今冠古: "chāo jīn guàn gǔ",
	倡而不和: "chàng ér bú hè",
	畅所欲为: "chàng suǒ yù wéi",
	苌弘碧血: "cháng hóng bì xiě",
	长幼尊卑: "zhǎng yòu zūn bēi",
	长绳系日: "cháng shéng jì rì",
	长年三老: "zhǎng nián sān lǎo",
	长春不老: "cháng chūn bù lǎo",
	长傲饰非: "zhǎng ào shì fēi",
	昌亭旅食: "chāng tíng lǚ shí",
	禅絮沾泥: "chán xù zhān ní",
	差三错四: "chā sān cuò sì",
	层台累榭: "céng tái lěi xiè",
	层见迭出: "céng xiàn dié chū",
	藏踪蹑迹: "cáng zōng niè jì",
	苍蝇见血: "cāng yíng jiàn xiě",
	餐松啖柏: "cān sōng dàn bó",
	骖风驷霞: "cān fēng sì xiá",
	参伍错综: "cēn wǔ cuò zōng",
	参辰卯酉: "shēn chén mǎo yǒu",
	材优干济: "cái yōu gān jǐ",
	材薄质衰: "cái bó zhì shuāi",
	才大难用: "cái dà nán yòng",
	才薄智浅: "cái bó zhì qiǎn",
	不足为意: "bù zú wéi yì",
	不足为据: "bù zú wéi jù",
	不足为法: "bù zú wéi fǎ",
	不足齿数: "bù zú chǐ shǔ",
	不着疼热: "bù zhuó téng rè",
	不知薡蕫: "bù zhī dǐng dǒng",
	不越雷池: "bú yuè léi chí",
	不相为谋: "bù xiāng wéi móu",
	不贪为宝: "bù tān wéi bǎo",
	不了而了: "bù liǎo ér liǎo",
	不可揆度: "bù kě kuí duó",
	不遑启处: "bù huáng qǐ chǔ",
	不当不正: "bù dāng bú zhèng",
	不差什么: "bú chà shén me",
	不差累黍: "bù chā lěi shǔ",
	擘两分星: "bò liǎng fēn xīng",
	簸土扬沙: "bǒ tǔ yáng shā",
	薄物细故: "bó wù xì gù",
	薄寒中人: "bó hán zhòng rén",
	博文约礼: "bó wén yuē lǐ",
	播糠眯目: "bō kāng mí mù",
	剥皮抽筋: "bō pí chōu jīn",
	剥肤椎髓: "bō fū chuí suǐ",
	波属云委: "bō zhǔ yún wěi",
	波骇云属: "bō hài yún zhǔ",
	兵微将寡: "bīng wēi jiàng guǎ",
	兵强将勇: "bīng qiáng jiàng yǒng",
	兵多将广: "bīng duō jiàng guǎng",
	兵不由将: "bīng bù yóu jiàng",
	冰解的破: "bīng jiě dì pò",
	彬彬济济: "bīn bīn jǐ jǐ",
	摽梅之年: "biào méi zhī nián",
	表里为奸: "biǎo lǐ wéi jiān",
	飙发电举: "biāo fā diàn jǔ",
	变贪厉薄: "biàn tān lì bó",
	敝盖不弃: "bì gài bú qì",
	秕言谬说: "bǐ yán miù shuō",
	比物属事: "bǐ wù zhǔ shì",
	被山带河: "pī shān dài hé",
	被甲枕戈: "pī jiǎ zhěn gē",
	被甲据鞍: "pī jiǎ jù ān",
	被褐怀玉: "pī hè huái yù",
	被发缨冠: "pī fà yīng guàn",
	背曲腰躬: "bèi qǔ yāo gōng",
	北窗高卧: "běi chuāng gāo wò",
	北辰星拱: "běi chén xīng gǒng",
	北鄙之音: "běi bǐ zhī yīn",
	卑宫菲食: "bēi gōng fěi shí",
	暴衣露冠: "pù yī lù guàn",
	暴腮龙门: "pù sāi lóng mén",
	暴露文学: "bào lù wén xué",
	暴虎冯河: "bào hǔ píng hé",
	抱蔓摘瓜: "bào wàn zhāi guā",
	抱法处势: "bào fǎ chǔ shì",
	褒贬与夺: "bāo biǎn yǔ duó",
	帮闲钻懒: "bāng xián zuān lǎn",
	拜将封侯: "bài jiàng fēng hóu",
	百兽率舞: "bǎi shòu shuài wǔ",
	百孔千创: "bǎi kǒng qiān chuāng",
	白衣卿相: "bái yī qīng xiàng",
	白首为郎: "bái shǒu wéi láng",
	白首相知: "bái shǒu xiāng zhī",
	把玩无厌: "bǎ wán wú yàn",
	拔锅卷席: "bá guō juǎn xí",
	拔本塞源: "bá běn sè yuán",
	傲不可长: "ào bù kě zhǎng",
	熬更守夜: "áo gēng shǒu yè",
	安时处顺: "ān shí chǔ shùn",
	安身为乐: "ān shēn wéi lè",
	安老怀少: "ān lǎo huái shào",
	安步当车: "ān bù dàng chē",
	爱人好士: "ài rén hào shì",
	矮人观场: "ǎi rén guān chǎng",
	捱风缉缝: "ái fēng jī fèng",
	挨山塞海: "āi shān sè hǎi",
	阿家阿翁: "ā jiā ā wēng",
	阿党相为: "ē dǎng xiāng wéi",
	追亡逐北: "zhuī wáng zhú běi",
	竹篮打水: "zhú lán dá shuǐ",
	知疼着热: "zhī téng zháo rè",
	语不惊人: "yǔ bù jīng rén",
	于今为烈: "yú jīn wéi liè",
	一日三省: "yí rì sān xǐng",
	穴居野处: "xué jū yě chǔ",
	五脊六兽: "wǔ jǐ liù shòu",
	无声无臭: "wú shēng wú xiù",
	谓予不信: "wèi yú bú xìn",
	舍身为国: "shě shēn wéi guó",
	杀妻求将: "shā qī qiú jiàng",
	强作解人: "qiǎng zuò jiě rén",
	气冲斗牛: "qì chōng dǒu niú",
	临深履薄: "lín shēn lǚ bó",
	钧天广乐: "jūn tiān guǎng yuè",
	艰难竭蹶: "jiān nán jié jué",
	夹七夹八: "jiā qī jiā bā",
	混混噩噩: "hún hún è è",
	厚古薄今: "hòu gǔ bó jīn",
	鬼怕恶人: "guǐ pà è rén",
	伽马射线: "gā mǎ shè xiàn",
	佛头着粪: "fó tóu zhuó fèn",
	奉为至宝: "fèng wéi zhì bǎo",
	登坛拜将: "dēng tán bài jiàng",
	晨昏定省: "chén hūn dìng xǐng",
	察察为明: "chá chá wéi míng",
	博闻强识: "bó wén qiáng zhì",
	避难就易: "bì nán jiù yì",
	了无生机: "liǎo wú shēng jī",
	有一说一: "yǒu yī shuō yī",
	独一无二: "dú yī wú èr",
	说一不二: "shuō yī bù èr",
	举一反三: "jǔ yī fǎn sān",
	数一数二: "shǔ yī shǔ èr",
	杀一儆百: "shā yī jǐng bǎi",
	丁一卯二: "dīng yī mǎo èr",
	丁一确二: "dīng yī què èr",
	不一而止: "bù yī ér zhǐ",
	无一幸免: "wú yī xìng miǎn",
	表里不一: "biǎo lǐ bù yī",
	良莠不一: "liáng yǒu bù yī",
	心口不一: "xīn kǒu bù yī",
	言行不一: "yán xíng bù yī",
	政令不一: "zhèng lìng bù yī",
	参差不一: "cēn cī bù yī",
	纷纷不一: "fēn fēn bù yī",
	毁誉不一: "huǐ yù bù yī",
	不一而三: "bù yī ér sān",
	百不一遇: "bǎi bù yī yù",
	言行抱一: "yán xíng bào yī",
	瑜百瑕一: "yú bǎi xiá yī",
	背城借一: "bèi chéng jiè yī",
	凭城借一: "píng chéng jiè yī",
	劝百讽一: "quàn bǎi fěng yī",
	群居和一: "qún jū hé yī",
	百不获一: "bǎi bù huò yī",
	百不失一: "bǎi bù shī yī",
	百无失一: "bǎi wú shī yī",
	万不失一: "wàn bù shī yī",
	万无失一: "wàn wú shī yī",
	合而为一: "hé ér wéi yī",
	合两为一: "hé liǎng wéi yī",
	合二为一: "hé èr wéi yī",
	天下为一: "tiān xià wéi yī",
	相与为一: "xiāng yǔ wéi yī",
	较若画一: "jiào ruò huà yī",
	较如画一: "jiào rú huà yī",
	斠若画一: "jiào ruò huà yī",
	言行若一: "yán xíng ruò yī",
	始终若一: "shǐ zhōng ruò yī",
	终始若一: "zhōng shǐ ruò yī",
	惟精惟一: "wéi jīng wéi yī",
	众多非一: "zhòng duō fēi yī",
	不能赞一: "bù néng zàn yī",
	问一答十: "wèn yī dá shí",
	一不扭众: "yī bù niǔ zhòng",
	一以贯之: "yī yǐ guàn zhī",
	一以当百: "yī yǐ dāng bǎi",
	百不当一: "bǎi bù dāng yī",
	十不当一: "shí bù dāng yī",
	以一警百: "yǐ yī jǐng bǎi",
	以一奉百: "yǐ yī fèng bǎi",
	以一持万: "yǐ yī chí wàn",
	以一知万: "yǐ yī zhī wàn",
	百里挑一: "bǎi lǐ tiāo yī",
	整齐划一: "zhěng qí huà yī",
	一来二去: "yī lái èr qù",
	一路公交: "yī lù gōng jiāo",
	一路汽车: "yī lù qì chē",
	一路巴士: "yī lù bā shì",
	朝朝朝落: "zhāo cháo zhāo luò",
	曲意逢迎: "qū yì féng yíng",
	一行不行: "yì háng bù xíng",
	行行不行: "háng háng bù xíng"
};
const Pattern4 = Object.keys(DICT4).map((key) => ({
	zh: key,
	pinyin: DICT4[key],
	probability: 2e-8,
	length: 4,
	priority: Priority.Normal,
	dict: Symbol("dict4")
}));
//#endregion
//#region ../../node_modules/.pnpm/pinyin-pro@3.29.5/node_modules/pinyin-pro/dist/esm/data/dict5.mjs
const DICT5 = {
	巴尔干半岛: "bā ěr gàn bàn dǎo",
	巴尔喀什湖: "bā ěr kā shí hú",
	不幸而言中: "bú xìng ér yán zhòng",
	布尔什维克: "bù ěr shí wéi kè",
	何乐而不为: "hé lè ér bù wéi",
	苛政猛于虎: "kē zhèng měng yú hǔ",
	蒙得维的亚: "méng dé wéi dì yà",
	民以食为天: "mín yǐ shí wéi tiān",
	事后诸葛亮: "shì hòu zhū gě liàng",
	物以稀为贵: "wù yǐ xī wéi guì",
	先下手为强: "xiān xià shǒu wéi qiáng",
	行行出状元: "háng háng chū zhuàng yuan",
	亚得里亚海: "yà dé lǐ yà hǎi",
	眼不见为净: "yǎn bú jiàn wéi jìng",
	竹筒倒豆子: "zhú tǒng dào dòu zi"
};
//#endregion
//#region ../../node_modules/.pnpm/pinyin-pro@3.29.5/node_modules/pinyin-pro/dist/esm/data/patterns.mjs
const PatternsNormal = [
	...Object.keys(DICT5).map((key) => ({
		zh: key,
		pinyin: DICT5[key],
		probability: 2e-8,
		length: 5,
		priority: Priority.Normal,
		dict: Symbol("dict5")
	})),
	...Pattern4,
	...Pattern3,
	...Pattern2,
	...PatternNumberDict,
	...PatternSurname
];
//#endregion
//#region ../../node_modules/.pnpm/pinyin-pro@3.29.5/node_modules/pinyin-pro/dist/esm/common/segmentit/max-probability.mjs
function getMaxProbability(a, b) {
	if (!a) return b;
	if (a.decimal < b.decimal) return a;
	else if (a.decimal === b.decimal) return a.probability > b.probability ? a : b;
	else return b;
}
function checkDecimal(prob) {
	if (prob.probability < 1e-300) {
		prob.probability *= 1e300;
		prob.decimal += 1;
	}
}
function getPatternDecimal(pattern) {
	if (pattern.priority === Priority.Custom) return -(pattern.length * pattern.length * 100);
	if (pattern.priority === Priority.Surname) return -(pattern.length * pattern.length * 10);
	return 0;
}
function maxProbability(patterns, length) {
	const dp = [];
	const terminalDP = {
		probability: 1,
		decimal: 0,
		nextIndex: length
	};
	let patternIndex = patterns.length - 1;
	let pattern = patterns[patternIndex];
	for (let i = length - 1; i >= 0; i--) {
		const suffixDP = i + 1 >= length ? terminalDP : dp[i + 1];
		const nextIndex = suffixDP.pattern ? i + 1 : suffixDP.nextIndex;
		while (pattern && pattern.index + pattern.length - 1 === i) {
			const startIndex = pattern.index;
			const curDP = {
				probability: pattern.probability * suffixDP.probability,
				decimal: suffixDP.decimal + getPatternDecimal(pattern),
				pattern,
				nextIndex
			};
			checkDecimal(curDP);
			dp[startIndex] = getMaxProbability(dp[startIndex], curDP);
			pattern = patterns[--patternIndex];
		}
		const iDP = {
			probability: 1e-13 * suffixDP.probability,
			decimal: 0,
			nextIndex
		};
		checkDecimal(iDP);
		dp[i] = getMaxProbability(dp[i], iDP);
	}
	const result = [];
	let index = 0;
	while (index < length) {
		const item = dp[index];
		if (item.pattern) result.push(item.pattern);
		index = item.nextIndex;
	}
	return result;
}
//#endregion
//#region ../../node_modules/.pnpm/pinyin-pro@3.29.5/node_modules/pinyin-pro/dist/esm/common/segmentit/min-tokenization.mjs
function getMinCount(a, b) {
	if (!a) return b;
	return a.count <= b.count ? a : b;
}
function getPatternCount(pattern) {
	if (pattern.priority === Priority.Custom) return -(pattern.length * pattern.length * 1e5);
	if (pattern.priority === Priority.Surname) return -(pattern.length * pattern.length * 100);
	return 1;
}
function minTokenization(patterns, length) {
	const dp = [];
	let patternIndex = patterns.length - 1;
	let pattern = patterns[patternIndex];
	for (let i = length - 1; i >= 0; i--) {
		const suffixDP = i + 1 >= length ? {
			count: 0,
			patterns: []
		} : dp[i + 1];
		while (pattern && pattern.index + pattern.length - 1 === i) {
			const startIndex = pattern.index;
			const curDP = {
				count: getPatternCount(pattern) + suffixDP.count,
				patterns: suffixDP.patterns,
				concatPattern: pattern
			};
			dp[startIndex] = getMinCount(dp[startIndex], curDP);
			pattern = patterns[--patternIndex];
		}
		const iDP = {
			count: 1 + suffixDP.count,
			patterns: suffixDP.patterns
		};
		dp[i] = getMinCount(dp[i], iDP);
		if (dp[i].concatPattern) {
			dp[i].patterns = dp[i].patterns.concat(dp[i].concatPattern);
			dp[i].concatPattern = void 0;
			delete dp[i + 1];
		}
	}
	return dp[0].patterns.reverse();
}
//#endregion
//#region ../../node_modules/.pnpm/pinyin-pro@3.29.5/node_modules/pinyin-pro/dist/esm/common/segmentit/reverse-max-match.mjs
function isIgnorablePattern(cur, pre) {
	if (pre.index + pre.length <= cur.index) return false;
	if (pre.priority > cur.priority) return false;
	if (pre.priority === cur.priority && pre.length > cur.length) return false;
	return true;
}
function reverseMaxMatch(patterns) {
	const filteredArr = [];
	for (let i = patterns.length - 1; i >= 0;) {
		const { index } = patterns[i];
		let j = i - 1;
		while (j >= 0 && isIgnorablePattern(patterns[i], patterns[j])) j--;
		if (j < 0 || patterns[j].index + patterns[j].length <= index) filteredArr.push(patterns[i]);
		i = j;
	}
	return filteredArr.reverse();
}
//#endregion
//#region ../../node_modules/.pnpm/pinyin-pro@3.29.5/node_modules/pinyin-pro/dist/esm/common/segmentit/index.mjs
var TokenizationAlgorithm;
(function(TokenizationAlgorithm) {
	TokenizationAlgorithm[TokenizationAlgorithm["ReverseMaxMatch"] = 1] = "ReverseMaxMatch";
	TokenizationAlgorithm[TokenizationAlgorithm["MaxProbability"] = 2] = "MaxProbability";
	TokenizationAlgorithm[TokenizationAlgorithm["MinTokenization"] = 3] = "MinTokenization";
})(TokenizationAlgorithm || (TokenizationAlgorithm = {}));
var TrieNode = class {
	constructor(parent, key = "") {
		this.children = /* @__PURE__ */ new Map();
		this.fail = null;
		this.patterns = [];
		this.parent = parent;
		this.key = key;
	}
};
var AC = class {
	constructor() {
		this.dictMap = /* @__PURE__ */ new Map();
		this.queues = [];
		this.pendingBuild = null;
		this.root = new TrieNode(null);
	}
	build(patternList) {
		this.flushPendingBuild();
		this.buildTrie(patternList);
		this.buildFailPointer();
	}
	setPendingBuild(build) {
		this.pendingBuild = build;
	}
	clearPendingBuild() {
		this.pendingBuild = null;
	}
	flushPendingBuild() {
		const build = this.pendingBuild;
		if (!build) return;
		this.pendingBuild = null;
		build();
	}
	buildTrie(patternList) {
		for (let pattern of patternList) {
			const zhChars = splitString(pattern.zh);
			let cur = this.root;
			for (let i = 0; i < zhChars.length; i++) {
				let c = zhChars[i];
				let next = cur.children.get(c);
				if (!next) {
					next = new TrieNode(cur, c);
					cur.children.set(c, next);
					this.addNodeToQueues(next, i + 1);
				}
				cur = next;
			}
			this.insertPattern(cur.patterns, pattern);
			pattern.node = cur;
			this.addPatternToDictMap(pattern);
		}
	}
	buildFailPointer() {
		for (let depth = 1; depth < this.queues.length; depth++) {
			const queue = this.queues[depth];
			if (!queue) continue;
			for (const node of queue) {
				let failNode = node.parent && node.parent.fail;
				let key = node.key;
				while (failNode && !failNode.children.has(key)) failNode = failNode.fail;
				if (!failNode) node.fail = this.root;
				else node.fail = failNode.children.get(key);
			}
		}
		this.queues = [];
	}
	addPatternToDictMap(pattern) {
		if (!this.dictMap.has(pattern.dict)) this.dictMap.set(pattern.dict, /* @__PURE__ */ new Set());
		this.dictMap.get(pattern.dict).add(pattern);
	}
	addNodeToQueues(trieNode, depth) {
		if (!this.queues[depth]) this.queues[depth] = [];
		this.queues[depth].push(trieNode);
	}
	insertPattern(patterns, pattern) {
		for (let i = patterns.length - 1; i >= 0; i--) {
			const _pattern = patterns[i];
			if (pattern.priority === _pattern.priority && pattern.probability >= _pattern.probability) patterns[i + 1] = _pattern;
			else if (pattern.priority > _pattern.priority) patterns[i + 1] = _pattern;
			else {
				patterns[i + 1] = pattern;
				return;
			}
		}
		patterns[0] = pattern;
	}
	removeDict(dictName) {
		if (this.dictMap.has(dictName)) {
			this.dictMap.get(dictName).forEach((pattern) => {
				pattern.node.patterns = pattern.node.patterns.filter((_pattern) => _pattern !== pattern);
			});
			this.dictMap.delete(dictName);
		}
	}
	match(text, surname, zhChars = splitString(text)) {
		if (this.pendingBuild) this.flushPendingBuild();
		let cur = this.root;
		let result = [];
		for (let i = 0; i < zhChars.length; i++) {
			let c = zhChars[i];
			let next = cur.children.size ? cur.children.get(c) : void 0;
			while (!next && cur !== this.root) {
				if (!cur.fail) {
					cur = this.root;
					break;
				}
				cur = cur.fail;
				next = cur.children.size ? cur.children.get(c) : void 0;
			}
			if (next) {
				cur = next;
				const pattern = cur.patterns.find((item) => {
					if (surname === "off") return item.priority !== Priority.Surname;
					else if (surname === "head") return item.length - 1 - i === 0;
					else return true;
				});
				if (pattern) result.push(Object.assign(Object.assign({}, pattern), { index: i - pattern.length + 1 }));
				let failNode = cur.fail;
				while (failNode !== null) {
					const pattern = failNode.patterns.find((item) => {
						if (surname === "off") return item.priority !== Priority.Surname;
						else if (surname === "head") return item.length - 1 - i === 0;
						else return true;
					});
					if (pattern) result.push(Object.assign(Object.assign({}, pattern), { index: i - pattern.length + 1 }));
					failNode = failNode.fail;
				}
			}
		}
		return result;
	}
	search(text, surname, algorithm = 2, zhChars = splitString(text)) {
		const patterns = this.match(text, surname, zhChars);
		if (algorithm === 1) return reverseMaxMatch(patterns);
		else if (algorithm === 3) return minTokenization(patterns, zhChars.length);
		return maxProbability(patterns, zhChars.length);
	}
};
let acBuilt = false;
const acTree = new AC();
function ensureAcBuilt() {
	if (!acBuilt) {
		acTree.build(PatternsNormal);
		acBuilt = true;
	}
}
function scheduleAcBuild() {
	try {
		if (typeof requestIdleCallback === "function") requestIdleCallback(() => ensureAcBuilt());
	} catch (_a) {}
}
scheduleAcBuild();
//#endregion
//#region ../../node_modules/.pnpm/pinyin-pro@3.29.5/node_modules/pinyin-pro/dist/esm/core/traditional/index.mjs
const traditionalDict = [];
function getTraditionalDict() {
	return traditionalDict;
}
//#endregion
//#region ../../node_modules/.pnpm/pinyin-pro@3.29.5/node_modules/pinyin-pro/dist/esm/core/pinyin/handle.mjs
const getSingleWordPinyin = (char) => {
	const pinyin = DICT1.get(char);
	if (!pinyin) return char;
	const index = pinyin.indexOf(" ");
	return index === -1 ? pinyin : pinyin.slice(0, index);
};
const getTraditionalWords = (word) => {
	const traditionalWords = [];
	const traditionalDict = getTraditionalDict();
	for (let i = 0; i < word.length; i++) {
		const key = word[i];
		const code = key.charCodeAt(0);
		if (traditionalDict[code]) traditionalWords[i] = traditionalDict[code];
		else traditionalWords[i] = key;
	}
	return traditionalWords.join("");
};
const getPinyin = (word, list, surname, segmentit, traditional, zhChars = splitString(word)) => {
	ensureAcBuilt();
	const searchWord = traditional ? getTraditionalWords(word) : word;
	const searchChars = traditional ? splitString(searchWord) : zhChars;
	const matches = acTree.search(searchWord, surname, segmentit, searchChars);
	let matchIndex = 0;
	const processFuncs = getProcessFuncs(word);
	for (let i = 0; i < zhChars.length;) {
		const match = matches[matchIndex];
		if (match && i === match.index) {
			if (match.length === 1 && match.priority <= Priority.Normal) {
				const char = zhChars[i];
				match.zh = char;
				let pinyin = "";
				pinyin = processSepecialPinyin(char, zhChars[i - 1], zhChars[i + 1], processFuncs);
				list[i] = {
					origin: char,
					result: pinyin,
					isZh: pinyin !== char,
					originPinyin: pinyin
				};
				i++;
				matchIndex++;
				continue;
			}
			const pinyins = match.pinyin.split(" ");
			let pinyinIndex = 0;
			if (traditional) match.zh = zhChars.slice(match.index, match.index + match.length).join("");
			for (let j = 0; j < match.length; j++) {
				list[i + j] = {
					origin: zhChars[j + match.index],
					result: pinyins[pinyinIndex] || "",
					isZh: true,
					originPinyin: pinyins[pinyinIndex] || ""
				};
				pinyinIndex++;
			}
			i += match.length;
			matchIndex++;
		} else {
			const char = zhChars[i];
			let pinyin = "";
			pinyin = processSepecialPinyin(char, zhChars[i - 1], zhChars[i + 1], processFuncs);
			list[i] = {
				origin: char,
				result: pinyin,
				isZh: pinyin !== char,
				originPinyin: pinyin
			};
			i++;
		}
	}
	return {
		list,
		matches
	};
};
const getPinyinWithoutTone = (pinyin) => {
	return pinyin.replace(/(ā|á|ǎ|à)/g, "a").replace(/(ō|ó|ǒ|ò)/g, "o").replace(/(ē|é|ě|è)/g, "e").replace(/(ī|í|ǐ|ì)/g, "i").replace(/(ū|ú|ǔ|ù)/g, "u").replace(/(ǖ|ǘ|ǚ|ǜ)/g, "ü").replace(/(n̄|ń|ň|ǹ)/g, "n").replace(/(m̄|ḿ|m̌|m̀)/g, "m").replace(/(ê̄|ế|ê̌|ề)/g, "ê");
};
const getMultiplePinyin = (word, surname = "off") => {
	let pinyin = getAllPinyin(word, surname);
	if (pinyin.length > 0) return pinyin.map((value) => ({
		origin: word,
		result: value,
		isZh: true,
		originPinyin: value
	}));
	else return [{
		origin: word,
		result: word,
		isZh: false,
		originPinyin: word
	}];
};
const getInitialAndFinal = (pinyin, initialPattern) => {
	const pinyin_arr = pinyin.split(" ");
	const initial_arr = [];
	const final_arr = [];
	for (let _pinyin of pinyin_arr) for (let _initial of InitialList) if (_pinyin.startsWith(_initial)) {
		let _final = _pinyin.slice(_initial.length);
		if (SpecialInitialList.indexOf(_initial) !== -1 && SpecialFinalList.indexOf(_final) !== -1) _final = SpecialFinalMap[_final];
		initial_arr.push(_initial);
		final_arr.push(_final);
		break;
	}
	if (initialPattern === "standard") initial_arr.forEach((initial, index) => {
		if (initial === "y" || initial === "w") initial_arr[index] = "";
	});
	return {
		final: final_arr.join(" "),
		initial: initial_arr.join(" ")
	};
};
function getFinalPartsFromFinal(final) {
	let head = "", body = "", tail = "";
	if (doubleFinalList.indexOf(getPinyinWithoutTone(final)) !== -1) {
		head = final[0];
		body = final[1];
		tail = final.slice(2);
	} else {
		body = final[0] || "";
		tail = final.slice(1) || "";
	}
	return {
		head,
		body,
		tail
	};
}
const getFinalParts = (pinyin) => {
	const { final } = getInitialAndFinal(pinyin);
	return getFinalPartsFromFinal(final);
};
const getNumOfTone = (pinyin) => {
	const reg_tone1 = /(ā|ō|ē|ī|ū|ǖ|n̄|m̄|ê̄)/;
	const reg_tone2 = /(á|ó|é|í|ú|ǘ|ń|ḿ|ế)/;
	const reg_tone3 = /(ǎ|ǒ|ě|ǐ|ǔ|ǚ|ň|m̌|ê̌)/;
	const reg_tone4 = /(à|ò|è|ì|ù|ǜ|ǹ|m̀|ề)/;
	const reg_tone0 = /(a|o|e|i|u|ü|ê)/;
	const special_tone = /(n|m)$/;
	const tone_num_arr = [];
	pinyin.split(" ").forEach((_pinyin) => {
		if (reg_tone1.test(_pinyin)) tone_num_arr.push("1");
		else if (reg_tone2.test(_pinyin)) tone_num_arr.push("2");
		else if (reg_tone3.test(_pinyin)) tone_num_arr.push("3");
		else if (reg_tone4.test(_pinyin)) tone_num_arr.push("4");
		else if (reg_tone0.test(_pinyin)) tone_num_arr.push("0");
		else if (special_tone.test(_pinyin)) tone_num_arr.push("0");
		else tone_num_arr.push("");
	});
	return tone_num_arr.join(" ");
};
const getPinyinWithNum = (pinyin, originPinyin) => {
	const pinyin_arr = getPinyinWithoutTone(pinyin).split(" ");
	const tone_num_arr = getNumOfTone(originPinyin).split(" ");
	const res_arr = [];
	pinyin_arr.forEach((item, index) => {
		res_arr.push(`${item}${tone_num_arr[index]}`);
	});
	return res_arr.join(" ");
};
const getFirstLetter = (pinyin, isZh) => {
	const first_letter_arr = [];
	pinyin.split(" ").forEach((pinyin) => {
		first_letter_arr.push(isZh ? pinyin[0] : pinyin);
	});
	return first_letter_arr.join(" ");
};
function processToneSandhi(cur, pre, next) {
	if (toneSandhiList.indexOf(cur) === -1) return getSingleWordPinyin(cur);
	if (pre === next && pre && getSingleWordPinyin(pre) !== pre) return getPinyinWithoutTone(getSingleWordPinyin(cur));
	if (next && !toneSandhiIgnoreSuffix[cur].includes(next)) {
		const nextPinyin = getSingleWordPinyin(next);
		if (nextPinyin !== next) {
			const nextTone = getNumOfTone(nextPinyin);
			const pinyinMap = toneSandhiMap[cur];
			for (let pinyin in pinyinMap) if (pinyinMap[pinyin].indexOf(Number(nextTone)) !== -1) return pinyin;
		}
	}
}
function processToneSandhiLiao(cur, pre, _) {
	if (cur === "了" && (!pre || !DICT1.get(pre))) return "liǎo";
}
function processReduplicationChar(cur, pre, _) {
	if (cur === "々") {
		if (!pre || !DICT1.get(pre)) return "tóng";
		else return DICT1.get(pre).split(" ")[0];
	}
}
function getProcessFuncs(text) {
	const processes = [];
	if (text.includes("々")) processes.push(processReduplicationChar);
	processes.push(processToneSandhiLiao);
	processes.push(processToneSandhi);
	return processes;
}
function processSepecialPinyin(cur, pre, next, funcs) {
	for (let func of funcs) {
		const res = func(cur, pre, next);
		if (res) return res;
	}
	return getSingleWordPinyin(cur);
}
//#endregion
//#region ../../node_modules/.pnpm/pinyin-pro@3.29.5/node_modules/pinyin-pro/dist/esm/core/pinyin/middlewares.mjs
const validateType = (word) => {
	if (typeof word !== "string") {
		console.error("The first param of pinyin is error: " + word + " is not assignable to type \"string\".");
		return false;
	} else return true;
};
function isNonZhScope(char, scope) {
	if (scope instanceof RegExp) {
		if (scope.global || scope.sticky) scope.lastIndex = 0;
		return scope.test(char);
	}
	return true;
}
const middleWareNonZh = (list, options) => {
	let nonZh = options.nonZh;
	if (nonZh === "removed") return list.filter((item) => item.isZh || !isNonZhScope(item.origin, options.nonZhScope));
	else if (nonZh === "consecutive") {
		for (let i = list.length - 2; i >= 0; i--) {
			const cur = list[i];
			const pre = list[i + 1];
			if (!cur.isZh && !pre.isZh && isNonZhScope(cur.origin, options.nonZhScope) && isNonZhScope(pre.origin, options.nonZhScope)) {
				cur.origin += pre.origin;
				cur.result += pre.result;
				pre.delete = true;
			}
		}
		return list.filter((item) => !item.delete);
	} else return list;
};
const middlewareMultiple = (word, options) => {
	if (options.multiple && stringLength(word) === 1) return getMultiplePinyin(word, options.surname);
	else return false;
};
const middlewarePattern = (list, options) => {
	switch (options.pattern) {
		case "pinyin": break;
		case "num":
			list.forEach((item) => {
				item.result = item.isZh ? getNumOfTone(item.result) : "";
			});
			break;
		case "initial":
			list.forEach((item) => {
				item.result = item.isZh ? getInitialAndFinal(item.result, options.initialPattern).initial : "";
			});
			break;
		case "final":
			list.forEach((item) => {
				item.result = item.isZh ? getInitialAndFinal(item.result, options.initialPattern).final : "";
			});
			break;
		case "first":
			list.forEach((item) => {
				item.result = getFirstLetter(item.result, item.isZh);
			});
			break;
		case "finalHead":
			list.forEach((item) => {
				item.result = item.isZh ? getFinalParts(item.result).head : "";
			});
			break;
		case "finalBody":
			list.forEach((item) => {
				item.result = item.isZh ? getFinalParts(item.result).body : "";
			});
			break;
		case "finalTail": list.forEach((item) => {
			item.result = item.isZh ? getFinalParts(item.result).tail : "";
		});
	}
};
const middlewareToneType = (list, options) => {
	switch (options.toneType) {
		case "symbol": break;
		case "none":
			list.forEach((item) => {
				if (item.isZh) item.result = getPinyinWithoutTone(item.result);
			});
			break;
		case "num": list.forEach((item) => {
			if (item.isZh) item.result = getPinyinWithNum(item.result, item.originPinyin);
		});
	}
};
const middlewareV = (list, options) => {
	if (options.v) list.forEach((item) => {
		if (item.isZh) item.result = item.result.replace(/ü/g, typeof options.v === "string" ? options.v : "v");
	});
};
const middlewareType = (list, options, word) => {
	if (options.multiple && stringLength(word) === 1) {
		let last = "";
		list = list.filter((item) => {
			const res = item.result !== last;
			last = item.result;
			return res;
		});
	}
	if (options.type === "array") return list.map((item) => item.result);
	if (options.type === "all") return list.map((item) => {
		const pinyin = item.isZh ? item.result : "";
		const { initial, final } = getInitialAndFinal(pinyin, options.initialPattern);
		const { head, body, tail } = getFinalPartsFromFinal(final);
		let polyphonic = [];
		if (pinyin !== "") polyphonic = [pinyin].concat(getAllPinyin(item.origin, options.surname).filter((item) => item !== pinyin));
		return {
			origin: item.origin,
			pinyin,
			initial,
			final,
			first: getFirstLetter(item.result, item.isZh),
			finalHead: head,
			finalBody: body,
			finalTail: tail,
			num: Number(getNumOfTone(item.originPinyin)),
			isZh: item.isZh,
			polyphonic,
			inZhRange: !!DICT1.get(item.origin),
			result: item.result
		};
	});
	return list.map((item) => item.result).join(options.separator);
};
const thirdToneToSecondToneMap = {
	ǎ: "á",
	ǒ: "ó",
	ě: "é",
	ǐ: "í",
	ǔ: "ú",
	ǚ: "ǘ",
	ň: "ń",
	"m̌": "ḿ",
	"ê̌": "ế"
};
const thirdTonePattern = /ǎ|ǒ|ě|ǐ|ǔ|ǚ|ň|m̌|ê̌/;
const isThirdTone = (item) => item.isZh && thirdTonePattern.test(item.result);
const convertThirdToneToSecondTone = (pinyin) => {
	return pinyin.replace(thirdTonePattern, (thirdTone) => thirdToneToSecondToneMap[thirdTone]);
};
const resolveToneSandhi = (toneSandhi) => {
	var _a, _b, _c;
	if (toneSandhi === false) return {
		yi: false,
		bu: false,
		thirdTone: false
	};
	if (toneSandhi && typeof toneSandhi === "object") return {
		yi: (_a = toneSandhi.yi) !== null && _a !== void 0 ? _a : true,
		bu: (_b = toneSandhi.bu) !== null && _b !== void 0 ? _b : true,
		thirdTone: (_c = toneSandhi.thirdTone) !== null && _c !== void 0 ? _c : false
	};
	return {
		yi: true,
		bu: true,
		thirdTone: false
	};
};
const applyThirdToneSandhi = (list) => {
	for (let start = 0; start < list.length;) {
		if (!isThirdTone(list[start])) {
			start += 1;
			continue;
		}
		let end = start + 1;
		while (end < list.length && isThirdTone(list[end])) end += 1;
		if (end - start === 2) {
			const pinyin = convertThirdToneToSecondTone(list[start].result);
			list[start].result = pinyin;
			list[start].originPinyin = pinyin;
		}
		start = end;
	}
};
const middlewareToneSandhi = (list, toneSandhi) => {
	const { yi, bu, thirdTone } = resolveToneSandhi(toneSandhi);
	if (thirdTone) applyThirdToneSandhi(list);
	if (!yi || !bu) list.forEach((item) => {
		if (!yi && item.origin === "一") item.result = item.originPinyin = "yī";
		else if (!bu && item.origin === "不") item.result = item.originPinyin = "bù";
	});
	return list;
};
//#endregion
//#region ../../node_modules/.pnpm/pinyin-pro@3.29.5/node_modules/pinyin-pro/dist/esm/core/pinyin/index.mjs
const DEFAULT_OPTIONS = {
	pattern: "pinyin",
	toneType: "symbol",
	type: "string",
	multiple: false,
	mode: "normal",
	removeNonZh: false,
	nonZh: "spaced",
	v: false,
	separator: " ",
	toneSandhi: true,
	segmentit: 2
};
/**
* @description: 获取汉语字符串的拼音
* @param {string} word 要转换的汉语字符串
* @param {CompleteOptions=} options 配置项
* @return {string | string[] | AllData[]} options.type 为 string 时，返回字符串，中间用空格隔开；为 array 时，返回拼音字符串数组；为 all 时返回全部信息的数组
*/
function pinyin(word, options) {
	options = Object.assign(Object.assign({}, DEFAULT_OPTIONS), options || {});
	if (!validateType(word)) return word;
	if (word === "") return options.type === "array" || options.type === "all" ? [] : "";
	if (options.surname === void 0) {
		if (options.mode === "surname") options.surname = "all";
		else options.surname = "off";
	}
	if (options.type === "all") options.pattern = "pinyin";
	if (options.pattern === "num") options.toneType = "none";
	if (options.removeNonZh) options.nonZh = "removed";
	const zhChars = splitString(word);
	let _list = Array(zhChars.length);
	let { list } = getPinyin(word, _list, options.surname, options.segmentit, options.traditional, zhChars);
	list = middlewareToneSandhi(list, options.toneSandhi);
	list = middleWareNonZh(list, options);
	const multipleList = middlewareMultiple(word, options);
	if (multipleList) list = multipleList;
	middlewarePattern(list, options);
	middlewareToneType(list, options);
	middlewareV(list, options);
	return middlewareType(list, options, word);
}
//#endregion
//#region ../voice/src/dismiss.ts
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
	return phoneticHit(text, phrase, syllables(phrase).length >= 3 ? 1 : 0, true);
}
function phoneticHit(text, phrase, slack, anchorLast) {
	const wanted = syllables(phrase);
	if (wanted.length < 2) return false;
	const heard = syllables(text);
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
/**
* True when the utterance contains one of the configured phrases as a complete
* substring. A phrase in the middle of a longer sentence counts. An empty list
* never dismisses, and a phrase that normalizes to nothing is ignored.
*
* A two-syllable-or-longer phrase also matches its toneless pinyin homophone
* (「推下吧」 for 「退下吧」). One-syllable phrases stay exact: every homophone
* would match them, which is too broad for a command that ends the turn.
*/
function isDismiss(text, phrases) {
	return containsAny(text, phrases) || phrases.some((phrase) => syllables(phrase).length >= 2 && containsPhonetic(text, phrase));
}
/**
* True when the utterance contains any interject keyword, including a toneless
* pinyin homophone and (for three syllables or more) one wrong non-final syllable.
* Aliases are extra spellings for the same keyword, so a near-miss such as
* 「大灰鱼」 can be added without changing the spoken name.
*/
function isInterject(text, keywords) {
	return (typeof keywords === "string" ? [keywords] : keywords).some((keyword) => containsAny(text, [keyword]) || containsKeywordPhonetic(text, keyword));
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
//#endregion
//#region ../voice/src/idle.ts
function createIdle() {
	return { startedAt: null };
}
/**
* Advance the clock. `unpin` means the idle span elapsed; the caller only
* clears the pin. Collapse of the panel is a separate, pointer-based rule.
*/
function stepIdle(clock, sample) {
	if (!(sample.pinned && !sample.agentBusy && sample.translationBusy !== true && !sample.questionOpen && !sample.playbackBusy && !sample.speechOpen)) return {
		clock: { startedAt: null },
		unpin: false
	};
	const startedAt = sample.activity || clock.startedAt === null ? sample.now : clock.startedAt;
	if (sample.now - startedAt >= sample.idleMs) return {
		clock: { startedAt: null },
		unpin: true
	};
	return {
		clock: { startedAt },
		unpin: false
	};
}
//#endregion
//#region ../voice/src/listen.ts
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
* `off`, `wake`, `command`, or `interject`.
*
* A translation, a question card, a local reply, a stop that has not settled, or a closed
* microphone wins. A busy agent or agent body audio listens for an interjection
* when that column is on and, while body audio is playing, echo cancellation is
* present. Otherwise an unpinned ball listens for the wake word, and a pinned
* ball listens for a command — unless a finished translation is still on screen,
* which keeps the command decoder shut and listens for the wake word alone.
*/
function listenMode(input) {
	if (input.translationBusy === true) return "off";
	if (input.questionOpen || input.localBusy || input.stopping || !input.micOpen) return "off";
	if (input.agentBusy || input.bodyBusy) {
		if (!input.interjectEnabled) return "off";
		if (input.bodyBusy && !input.echoCancel) return "off";
		return "interject";
	}
	if (input.translationQuiet === true) return input.wakeEnabled ? "wake" : "off";
	if (!input.pinned && input.wakeEnabled) return "wake";
	if (input.pinned && input.commandEnabled) return "command";
	return "off";
}
/**
* 子进程要不要占着麦克风设备。
*
* 光看“哪一列开着”不够：唤醒只在收起时可达，语音输入只在固定时可达。只开唤醒
* 却把球固定，或只开语音输入却把球收起，当前固定状态没有任何解码器能跑，继续占
* 着设备只会让系统麦克风指示白亮。提问卡仍然一律放开。
*
* 执行中和播报中不看固定状态：只要插话这一列能跑（有语音输入、有关键词，
* 且正文播报时带回声消除），设备就要留着。回复、停止这类短暂的 off 不单独处理：
* 按同一套“当前固定状态有没有可达的列”判断，能恢复的列在就保持，不能恢复的就放开。
*/
function holdsDevice(input) {
	if (input.questionOpen) return false;
	if (input.translationBusy === true) return false;
	const wakeReady = input.wakeEnabled && hasWakeWord(input.wakeWords) && input.wakeModel;
	const commandReady = input.commandEnabled && input.asrModel;
	if (!wakeReady && !commandReady) return false;
	if (input.agentBusy || input.bodyBusy) {
		if (!commandReady || !input.interjectEnabled) return false;
		if (input.bodyBusy && !input.echoCancel) return false;
		return true;
	}
	if (input.translationQuiet === true) return wakeReady;
	return input.pinned ? commandReady : wakeReady;
}
//#endregion
//#region ../voice/src/speak-text.ts
/**
* Take a prefix that can be spoken now.
* A forced cut emits the whole buffer, which is how a turn's tail becomes closing text.
* ASCII periods inside numbers (`1.13.8`) and tokens (`voice.mjs`) stay put.
* Past 60 characters with no sentence end, cut at a comma unless that would
* split an unfinished Latin word or number.
*/
function takeReadyPrefix(buffer, force = false) {
	if (force) return {
		ready: buffer,
		rest: ""
	};
	let cut = -1;
	for (let i = 0; i < buffer.length; i++) {
		const ch = buffer[i] ?? "";
		if ("。！？".includes(ch)) cut = i + 1;
		else if (".!?".includes(ch) && asciiSentenceBoundary(buffer, i)) cut = i + 1;
	}
	if (cut > 0) return {
		ready: buffer.slice(0, cut),
		rest: buffer.slice(cut)
	};
	if (buffer.length >= 60 && !/[A-Za-z0-9.]+$/.test(buffer)) {
		const idx = Math.max(buffer.lastIndexOf("，"), buffer.lastIndexOf(","), buffer.lastIndexOf("；"));
		if (idx > 20) return {
			ready: buffer.slice(0, idx + 1),
			rest: buffer.slice(idx + 1)
		};
	}
	return {
		ready: "",
		rest: buffer
	};
}
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
//#endregion
//#region ../voice/src/queue.ts
/**
* What the speaker may say, and in which order.
* Mid-turn sentences that miss the speaker are dropped. A closing line and a
* question prompt each keep one slot and play in the order they first arrived.
* A later closing replaces the closing text without passing the prompt.
* An unfinished opening line still in the buffer is spoken when a tool call
* starts, if the speaker is free. If the speaker is busy, that line is dropped.
* A new assistant block drops the previous block's holding area; a sentence
* already playing keeps going.
*/
function createQueue(enabled) {
	return {
		enabled,
		buffer: "",
		held: [],
		playing: null,
		closing: null,
		question: null,
		nextId: 1,
		nextOrder: 1
	};
}
/** Speaker, closing slot, or question slot. Local replies count; parked mid-turn text does not. */
function playbackBusy(state) {
	return state.playing !== null || state.closing !== null || state.question !== null;
}
/** Agent 正文正在播，或收尾还在队列里。途中句、未归类句、收尾都算；提问提示语、本地短句不算。 */
function bodyBusy(state) {
	if (state.closing !== null) return true;
	const kind = state.playing?.kind;
	return kind === "unclassified" || kind === "mid" || kind === "closing";
}
/** 唤醒回复语或退下回复语正在播。 */
function localBusy(state) {
	return state.playing?.kind === "local";
}
/**
* The stop button stays up for a closing line or a question prompt only.
* A wake reply, a dismiss reply, and a mid-turn sentence do not hold it.
*/
function voiceHold(state) {
	if (state.closing !== null || state.question !== null) return true;
	return state.playing?.kind === "closing" || state.playing?.kind === "question";
}
function queueView(state) {
	const queued = [];
	const slots = [state.closing === null ? null : {
		...state.closing,
		kind: "closing"
	}, state.question === null ? null : {
		...state.question,
		kind: "question"
	}].filter((slot) => slot !== null);
	slots.sort((left, right) => left.order - right.order);
	for (const slot of slots) queued.push({
		id: slot.id,
		kind: slot.kind,
		text: slot.text
	});
	return {
		playbackBusy: playbackBusy(state),
		voiceHold: voiceHold(state),
		playing: state.playing,
		held: state.held,
		queued
	};
}
function reduceQueue(state, event) {
	switch (event.type) {
		case "enabled": return event.enabled ? {
			state: {
				...state,
				enabled: true
			},
			effects: []
		} : cleared(state, false);
		case "stop": return cleared(state, state.enabled);
		case "text": return state.enabled ? pushText(state, event.text) : {
			state,
			effects: []
		};
		case "block": return {
			state: {
				...state,
				buffer: "",
				held: []
			},
			effects: []
		};
		case "tool": return onTool(state);
		case "turn-end": return onTurnEnd(state);
		case "question": return state.enabled ? onQuestion(state, event.text) : {
			state,
			effects: []
		};
		case "question-closed": return onQuestionClosed(state);
		case "local": return state.enabled ? onLocal(state, event.text) : {
			state,
			effects: []
		};
		case "playback-ended": return onPlaybackEnded(state, event.id);
		default: return {
			state,
			effects: []
		};
	}
}
function cleared(state, enabled) {
	const effects = state.playing === null ? [] : [{
		type: "stop",
		id: state.playing.id
	}];
	return {
		state: {
			...state,
			enabled,
			buffer: "",
			held: [],
			playing: null,
			closing: null,
			question: null
		},
		effects
	};
}
function pushText(state, text) {
	let next = {
		...state,
		buffer: state.buffer + text
	};
	const effects = [];
	for (;;) {
		const cut = takeReadyPrefix(next.buffer);
		if (!cut.ready) break;
		next = {
			...next,
			buffer: cut.rest
		};
		const accepted = acceptSentence(next, cut.ready);
		next = accepted.state;
		effects.push(...accepted.effects);
	}
	return {
		state: next,
		effects
	};
}
/**
* A ready sentence plays only when nothing is held back and the speaker and
* the real queue are both idle. Otherwise it waits in the holding area.
* The speaker freeing up does not promote that area: a tool call drops it,
* and the end of the turn folds whatever remains into one closing line.
*/
function acceptSentence(state, text) {
	if (!text.trim()) return {
		state,
		effects: []
	};
	if (state.playing === null && state.held.length === 0 && !hasQueue(state)) return startPlay(state, "unclassified", text);
	return {
		state: {
			...state,
			held: [...state.held, text]
		},
		effects: []
	};
}
/**
* A tool call means the text so far was a mid-turn line, not the closing reply.
* Parked sentences are dropped. An opening line that has not reached a sentence
* boundary yet is spoken now when the speaker is free; otherwise it is dropped
* with the rest, and it is not saved for the closing line.
*/
function onTool(state) {
	const playing = state.playing?.kind === "unclassified" ? {
		...state.playing,
		kind: "mid"
	} : state.playing;
	const pending = state.buffer.trim();
	const cleared = {
		...state,
		held: [],
		buffer: "",
		playing
	};
	if (!pending || cleared.playing !== null || hasQueue(cleared)) return {
		state: cleared,
		effects: []
	};
	return startPlay(cleared, "mid", pending);
}
function onTurnEnd(state) {
	if (!state.enabled) return {
		state: {
			...state,
			buffer: "",
			held: []
		},
		effects: []
	};
	const tail = takeReadyPrefix(state.buffer, true).ready;
	const pieces = [...state.held];
	if (tail.trim()) pieces.push(tail);
	let next = {
		...state,
		buffer: "",
		held: [],
		playing: state.playing?.kind === "unclassified" ? {
			...state.playing,
			kind: "closing"
		} : state.playing
	};
	const text = pieces.join("").trim();
	if (text) next = enqueueClosing(next, text);
	return drain(next);
}
function onQuestion(state, text) {
	const prompt = text.trim();
	if (!prompt) return {
		state,
		effects: []
	};
	if (state.question !== null || state.playing?.kind === "question") return {
		state,
		effects: []
	};
	return drain(placeQuestion(state, prompt));
}
function onQuestionClosed(state) {
	const next = {
		...state,
		question: null
	};
	if (next.playing?.kind !== "question") return drain(next);
	return {
		state: next,
		effects: [{
			type: "stop",
			id: next.playing.id
		}]
	};
}
function onLocal(state, text) {
	if (!text.trim()) return {
		state,
		effects: []
	};
	const effects = [];
	let next = state;
	if (next.playing !== null) {
		effects.push({
			type: "stop",
			id: next.playing.id
		});
		next = {
			...next,
			playing: null
		};
	}
	const started = startPlay(next, "local", text.trim());
	return {
		state: started.state,
		effects: [...effects, ...started.effects]
	};
}
function onPlaybackEnded(state, id) {
	if (state.playing?.id !== id) return {
		state,
		effects: []
	};
	return drain({
		...state,
		playing: null
	});
}
function enqueueClosing(state, text) {
	if (state.closing !== null) return {
		...state,
		closing: {
			...state.closing,
			text
		}
	};
	const id = `v${state.nextId}`;
	return {
		...state,
		nextId: state.nextId + 1,
		nextOrder: state.nextOrder + 1,
		closing: {
			id,
			text,
			order: state.nextOrder
		}
	};
}
function placeQuestion(state, text) {
	const id = `v${state.nextId}`;
	return {
		...state,
		nextId: state.nextId + 1,
		nextOrder: state.nextOrder + 1,
		question: {
			id,
			text,
			order: state.nextOrder
		}
	};
}
function startPlay(state, kind, text) {
	const id = `v${state.nextId}`;
	const playing = {
		id,
		kind,
		text
	};
	return {
		state: {
			...state,
			nextId: state.nextId + 1,
			playing
		},
		effects: [{
			type: "play",
			id,
			kind,
			text
		}]
	};
}
function drain(state) {
	if (state.playing !== null) return {
		state,
		effects: []
	};
	const next = earlier(state);
	if (next === null) return {
		state,
		effects: []
	};
	const slot = next.kind === "closing" ? state.closing : state.question;
	if (slot === null) return {
		state,
		effects: []
	};
	const playing = {
		id: slot.id,
		kind: next.kind,
		text: slot.text
	};
	return {
		state: {
			...state,
			playing,
			closing: next.kind === "closing" ? null : state.closing,
			question: next.kind === "question" ? null : state.question
		},
		effects: [{
			type: "play",
			id: slot.id,
			kind: next.kind,
			text: slot.text
		}]
	};
}
function earlier(state) {
	if (state.closing === null && state.question === null) return null;
	if (state.closing === null) return { kind: "question" };
	if (state.question === null) return { kind: "closing" };
	return state.closing.order <= state.question.order ? { kind: "closing" } : { kind: "question" };
}
function hasQueue(state) {
	return state.closing !== null || state.question !== null;
}
//#endregion
//#region src/voice.ts
/**
* Host-side voice controller.
* The page owns the pin gesture. This decides whether the microphone feeds the
* wake word or a command, and which sentence the speaker may play.
* The child process only captures, recognizes, synthesizes, and plays.
*/
const RESTART_LIMIT = 3;
/**
* A child that cannot start is usually waiting on something outside the plugin
* (a model still downloading, a dependency being installed, a transient crash).
* The fast budget above stops a crash loop from spinning; this slow retry is what
* lets the feature come up by itself later instead of staying dead until the app
* is restarted.
*/
const SLOW_RETRY_MS = 3e4;
const VOICE_DEBUG_MARKER = join(tmpdir(), "dsh-orb-voice-debug.on");
const VOICE_DEBUG_LOG = join(tmpdir(), "dsh-orb-voice-debug.log");
/** Opt-in tracing for "the answer is on screen but nothing is spoken" reports. */
function debug(message) {
	if (!existsSync(VOICE_DEBUG_MARKER)) return;
	try {
		appendFileSync(VOICE_DEBUG_LOG, `${(/* @__PURE__ */ new Date()).toISOString()} host ${message}\n`);
	} catch {}
}
/** `b:turn:step:index` is the orb's assistant block key. Test-only keys parse to undefined. */
function blockOrder(key) {
	const match = /^b:(\d+):(\d+):(\d+)$/.exec(key);
	if (!match) return void 0;
	return [
		Number(match[1]),
		Number(match[2]),
		Number(match[3])
	];
}
function compareBlockOrder(left, right) {
	return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}
var VoiceController = class {
	options;
	queue = createQueue(false);
	idle = createIdle();
	link;
	timer;
	live = false;
	closing = false;
	restarts = 0;
	failed = false;
	/** Slow retry for a child that could not start at all; cleared on every new lifecycle. */
	slowRetry;
	pinned = false;
	agentBusy = false;
	/**
	* A selection-toolbar translation is streaming. It is not an agent turn, so it must not
	* set {@link agentBusy}: that flag would make the ball look like it owns the session. It
	* only needs the two side effects a translation wants back — a shut microphone and a
	* paused idle clock.
	*/
	translationBusy = false;
	/**
	* The last translation finished and the ball is still showing its answer. A translation
	* is not a conversation, so the ball keeps its command decoder shut until the user asks
	* for one on purpose — a wake word, a key, or a new prompt. Without this the pin that
	* keeps the answer visible would reopen the microphone the moment the stream settled.
	*/
	translationQuiet = false;
	questionOpen = false;
	speechOpen = false;
	micOpen = false;
	micKnown = false;
	mode = "off";
	/** 子进程最近一次采集带不带回声消除。还没收到 mic 时按没有算。 */
	echoCancel = false;
	/** 上次发给子进程的设备占用。提问卡关掉后重新打开时用来把种子清零。 */
	device = false;
	/** 停止或退下之后，被停的那一轮剩下的正文都不播，直到下一轮开始。 */
	muted = false;
	/** 停止或退下已经发出、执行还没真正停下。这段时间不听。 */
	stopping = false;
	/** 插话那一刻正在进行的步（`b:${turn}:${step}`）。这些步里的正文只上屏，不出声。 */
	silencedSteps = /* @__PURE__ */ new Set();
	/**
	* Audio from just before a command starts, kept so the first syllable survives the switch.
	* Factory 300; one wake with a spoken reply uses zero so that reply is not echoed.
	*/
	commandSeed = 300;
	hold = false;
	seen = /* @__PURE__ */ new Map();
	/** The assistant block currently streaming; a new key starts a new block. */
	assistantKey;
	/** Keys that belonged to a previous turn; late updates must not reach the new queue. */
	staleKeys = /* @__PURE__ */ new Set();
	constructor(options) {
		this.options = options;
		this.queue = createQueue(this.ttsOn());
	}
	/**
	* The master switch gates the three columns without rewriting them. The stored column
	* switches keep their values, so turning voice back on restores the user's combination.
	* Reads that do not drive voice behavior (the idle clock) still get the raw values.
	*/
	settings() {
		const settings = this.options.settings();
		if (settings.voiceEnabled !== false) return settings;
		return {
			...settings,
			wakeEnabled: false,
			commandEnabled: false,
			ttsEnabled: false
		};
	}
	/**
	* Start the child. A second call while it is up does nothing.
	*
	* `initial` is the state of the ball when this lifecycle starts. The helper is freshly
	* launched and its page starts unpinned, so the pin is always false here; a turn or a
	* question can already exist when the ball is switched back on.
	*/
	start(initial = {}) {
		if (this.live) return;
		this.fresh(initial);
		this.launchChild();
	}
	/**
	* Stop the child for this lifecycle. A later {@link start} is a new lifecycle: it must
	* not inherit `closing` or a spent restart budget, or switching the ball off and on
	* would leave voice dead until the whole app restarts.
	*/
	close() {
		this.closing = true;
		this.live = false;
		if (this.timer) clearInterval(this.timer);
		this.timer = void 0;
		if (this.slowRetry) clearTimeout(this.slowRetry);
		this.slowRetry = void 0;
		this.link?.close();
		this.link = void 0;
		this.resetPlayback();
		this.micOpen = false;
		this.micKnown = false;
		this.echoCancel = false;
		this.device = false;
		this.mode = "off";
		this.hold = false;
		this.translationQuiet = false;
		this.setSpeech(false);
		this.options.send({
			type: "voice-hold",
			hold: false
		});
		this.options.send({
			type: "voice-mode",
			mode: "off"
		});
		this.options.send({
			type: "voice-level",
			value: 0
		});
	}
	/**
	* Null until the child reports, or while the current pin/turn state does not need
	* an open microphone. False means the device is needed but could not be opened.
	*/
	microphone() {
		if (!this.deviceWanted()) return null;
		if (!this.live || !this.micKnown) return null;
		return this.micOpen;
	}
	/**
	* Whether the current pin/turn state has a column that can actually listen.
	* A wake-only ball is released while pinned, and a command-only ball while
	* collapsed, so the system does not show a microphone no decoder reads.
	*/
	deviceWanted(settings = this.settings(), presence = this.options.presence()) {
		return holdsDevice({
			wakeEnabled: settings.wakeEnabled,
			wakeWords: settings.wakeWords,
			wakeModel: presence.wake,
			commandEnabled: settings.commandEnabled,
			asrModel: presence.asr,
			pinned: this.pinned,
			agentBusy: this.agentBusy,
			translationBusy: this.translationBusy,
			translationQuiet: this.translationQuiet,
			questionOpen: this.questionOpen,
			bodyBusy: bodyBusy(this.queue),
			interjectEnabled: this.interjectEnabled(),
			echoCancel: this.echoCancel
		});
	}
	/** Whether the page should keep the panel up and the stop button for a closing line or prompt. */
	holdState() {
		return this.hold;
	}
	/** The settings file changed. Switches take effect without reloading a model. */
	applySettings() {
		debug(`apply-settings live=${this.live} tts=${this.ttsOn()} enabled=${this.queue.enabled}`);
		if (this.closing) return;
		if (!this.live) {
			this.start();
			return;
		}
		const enabled = this.ttsOn();
		if (enabled !== this.queue.enabled) this.apply({
			type: "enabled",
			enabled
		});
		this.pushConfigure();
		this.pushListen(true);
		this.poll();
	}
	/** The page owns the gesture; keep the state even while the child is restarting. */
	setPinned(pinned) {
		if (this.pinned === pinned) return;
		this.pinned = pinned;
		if (!pinned) this.idle = createIdle();
		if (!pinned) this.beginInteraction();
		this.pushListen(false);
		this.poll();
	}
	/** A keystroke, or a text command that was just sent. */
	activity() {
		if (!this.live) return;
		const step = stepIdle(this.idle, {
			...this.sample(),
			activity: true
		});
		this.idle = step.clock;
	}
	/**
	* A selection-toolbar translation started or ended.
	*
	* The microphone shuts for its duration even though no agent turn is running. The ball is
	* pinned while it streams, and a pinned idle ball would otherwise listen for a command.
	*
	* Ending it does not hand the microphone back: the answer stays on a pinned ball, and a
	* translation is not a conversation, so the ball drops to the wake word and waits for the
	* user to start talking on purpose. {@link beginInteraction} lifts that state.
	* @param busy - whether a translation is now streaming.
	*/
	setTranslationBusy(busy) {
		if (this.translationBusy === busy) return;
		this.translationBusy = busy;
		if (busy) {
			this.translationQuiet = false;
			this.idle = createIdle();
			this.pushListen(false);
			this.poll();
			return;
		}
		this.translationQuiet = true;
		this.pushListen(false);
		this.poll();
	}
	/**
	* Drop the translation state without leaving the after-translation quiet behind.
	*
	* Resetting or switching the conversation is not a translation finishing: there is no
	* answer on screen to protect from the microphone, so the ordinary pin rules apply again
	* straight away. This is also why it does not go through {@link setTranslationBusy},
	* whose whole point is to leave that quiet set.
	*/
	clearTranslation() {
		this.translationBusy = false;
		this.translationQuiet = false;
		this.pushListen(false);
		this.poll();
	}
	/**
	* The user asked for the ball's attention again.
	*
	* Any deliberate input lifts the quiet that a finished translation leaves behind: a wake
	* word, or unpinning the ball and pinning it again. Nothing here opens the microphone by
	* itself — it only stops the finished translation from holding the command decoder shut.
	*/
	beginInteraction() {
		if (!this.translationQuiet) return;
		this.translationQuiet = false;
		this.pushListen(false);
		this.poll();
	}
	beginTurn() {
		debug("beginTurn");
		this.translationQuiet = false;
		this.agentBusy = true;
		this.muted = false;
		this.stopping = false;
		this.silencedSteps.clear();
		this.assistantKey = void 0;
		this.staleKeys = new Set(this.seen.keys());
		this.apply({ type: "stop" });
		if (this.live) this.link?.send({
			type: "stop-speak",
			id: "new-turn"
		});
		this.pushListen(false);
		this.poll();
	}
	/**
	* A new user command arrived while the old turn may still be running. Stop the old
	* speaker immediately and keep the old turn's remaining text silent until {@link beginTurn}.
	*/
	prepareNewTurn() {
		debug("prepareNewTurn");
		this.muted = true;
		this.stopping = this.agentBusy;
		this.assistantKey = void 0;
		this.apply({ type: "stop" });
		if (this.live) this.link?.send({
			type: "stop-speak",
			id: "new-turn"
		});
		this.pushListen(false);
		this.poll();
	}
	/** The turn's assistant text is already in the queue. Fold the tail into a closing line. */
	endTurn() {
		debug(`endTurn live=${this.live} agentBusy=${this.agentBusy}`);
		this.agentBusy = false;
		this.stopping = false;
		if (!this.live) {
			this.pushListen(false);
			return;
		}
		this.apply({ type: "turn-end" });
		this.poll();
	}
	/** Full assistant text for one block. Only the newly arrived suffix is spoken. */
	noteAssistant(key, text) {
		if (this.staleKeys.has(key)) {
			debug(`stale key=${key}`);
			return;
		}
		if (this.assistantKey !== void 0 && this.assistantKey !== key) {
			const previous = blockOrder(this.assistantKey);
			const next = blockOrder(key);
			if (previous !== void 0 && next !== void 0 && compareBlockOrder(next, previous) <= 0) {
				debug(`skip-old key=${key} newest=${this.assistantKey}`);
				return;
			}
			this.apply({ type: "block" });
		}
		this.assistantKey = key;
		const previous = this.seen.get(key) ?? "";
		const starts = text.startsWith(previous);
		this.seen.set(key, text);
		const silenced = this.silencedSteps.has(stepOf(key));
		debug(`note key=${key} prev=${previous.length} next=${text.length} starts=${starts} muted=${this.muted} silenced=${silenced} live=${this.live} enabled=${this.queue.enabled}`);
		if (this.muted || silenced) return;
		let delta = "";
		if (starts) delta = text.slice(previous.length);
		else {
			let common = 0;
			const limit = Math.min(previous.length, text.length);
			while (common < limit && previous[common] === text[common]) common += 1;
			delta = text.slice(common);
			debug(`rewrite common=${common} speak=${delta.length}`);
		}
		if (delta && this.live) this.apply({
			type: "text",
			text: delta
		});
	}
	tool() {
		if (!this.live) return;
		this.apply({ type: "tool" });
	}
	questionOpened() {
		this.questionOpen = true;
		if (!this.live) {
			this.pushListen(false);
			return;
		}
		this.apply({
			type: "question",
			text: this.settings().questionPrompt
		});
		this.poll();
	}
	questionClosed() {
		if (!this.questionOpen) return;
		this.questionOpen = false;
		if (!this.live) {
			this.pushListen(false);
			return;
		}
		this.apply({ type: "question-closed" });
		this.poll();
	}
	/** Stop button: drop speech. The caller stops the agent turn separately when one is running. */
	haltSpeech() {
		debug(`haltSpeech live=${this.live} busy=${this.agentBusy}`);
		if (this.agentBusy) {
			this.muted = true;
			this.stopping = true;
		}
		if (!this.live) return;
		this.apply({ type: "stop" });
		this.poll();
	}
	/** The panel moved to another conversation. */
	clearSession() {
		this.seen.clear();
		this.assistantKey = void 0;
		this.staleKeys.clear();
		this.muted = false;
		this.stopping = false;
		this.silencedSteps.clear();
		this.questionOpen = false;
		this.agentBusy = false;
		if (!this.live) {
			this.pushListen(false);
			return;
		}
		this.apply({ type: "stop" });
		this.poll();
	}
	/** Advance the idle clock. Tests call this instead of waiting. */
	poll() {
		if (!this.live) return;
		const step = stepIdle(this.idle, this.sample());
		this.idle = step.clock;
		if (step.unpin) this.requestUnpin();
	}
	/** What the child was last told to listen for. Tests read this. */
	listenMode() {
		return this.mode;
	}
	/** Whether the child has an open VAD speech segment. A reloaded page seeds its ASR lamp from this. */
	speaking() {
		return this.speechOpen;
	}
	snapshot() {
		const view = queueView(this.queue);
		return {
			hold: this.hold,
			pinned: this.pinned,
			mode: this.mode,
			queued: [...view.playing ? [view.playing.text] : [], ...view.queued.map((item) => item.text)]
		};
	}
	onChild(message) {
		const record = asRecord$1(message);
		const type = record?.type;
		if (type === "mic") {
			this.micKnown = true;
			this.micOpen = record?.open === true;
			this.echoCancel = record?.aec === true;
			debug(`mic open=${this.micOpen} aec=${this.echoCancel}`);
			this.pushListen(false);
			return;
		}
		if (type === "wake") {
			this.onWake();
			return;
		}
		if (type === "speech") {
			const open = record?.open === true;
			this.setSpeech(open && transcribing(this.mode));
			if (!open) this.pushListen(false);
			this.poll();
			return;
		}
		if (type === "level" && typeof record?.value === "number") {
			if (transcribing(this.mode)) {
				const value = Math.max(0, Math.min(1, record.value));
				this.options.send({
					type: "voice-level",
					value
				});
			}
			return;
		}
		if (type === "utterance" && typeof record?.text === "string") {
			this.onUtterance(record.text, record.mode, record.keyword === true);
			return;
		}
		if (type === "playback" && typeof record?.id === "string" && record.phase === "end") {
			debug(`playback-end id=${record.id}`);
			this.apply({
				type: "playback-ended",
				id: record.id
			});
			this.poll();
		}
	}
	/**
	* Forward the VAD speech edge to the page's ASR lamp. The lamp means "this audio is being
	* fed to the recognizer", so a segment that opened before transcription ended must go dark
	* with the mode, and a repeated close must not send another message.
	*/
	setSpeech(open) {
		if (this.speechOpen === open) return;
		this.speechOpen = open;
		this.options.send({
			type: "voice-speech",
			open
		});
	}
	onWake() {
		if (this.mode !== "wake") return;
		this.translationQuiet = false;
		this.pinned = true;
		this.options.send({ type: "pin" });
		const reply = this.localReply(this.settings().wakeReply);
		this.commandSeed = reply ? 0 : 300;
		if (reply) this.apply({
			type: "local",
			text: reply
		});
		else this.pushListen(false);
		this.poll();
	}
	onUtterance(text, tagged, keyword = false) {
		const mode = tagged === "command" || tagged === "interject" ? tagged : this.mode;
		this.setSpeech(false);
		if (mode !== "command" && mode !== "interject") return this.poll();
		const finishable = this.canFinish(mode);
		debug(`utterance mode=${mode} finishable=${finishable} keyword=${keyword} mic=${this.micOpen} stopping=${this.stopping} text=${text.slice(0, 60)}`);
		if (!finishable) return this.poll();
		const settings = this.settings();
		if (mode === "command") {
			const spoken = stripWakePrefix(text, settings.wakeWords);
			if (!spoken) return this.poll();
			if (isDismiss(spoken, settings.dismissPhrases)) return this.dismiss();
			this.options.send({
				type: "voice-prompt",
				text: spoken
			});
			this.activity();
			return this.poll();
		}
		const spoken = text.trim();
		if (isDismiss(spoken, settings.dismissPhrases)) return this.dismiss();
		if (keyword || isInterject(spoken, settings.interjectKeyword)) return this.interject(spoken);
		this.poll();
	}
	/** 开口之后出现了「硬性关掉」的情况，这句就不要了。只是执行结束、正文播完这种变化不算。 */
	canFinish(mode) {
		if (this.questionOpen || this.stopping || localBusy(this.queue) || !this.micOpen) return false;
		return mode === "command" ? this.commandEnabled() : this.interjectEnabled();
	}
	commandEnabled() {
		return this.settings().commandEnabled && this.options.presence().asr;
	}
	interjectEnabled() {
		return this.commandEnabled() && normalizeUtterance(this.settings().interjectKeyword) !== "";
	}
	dismiss() {
		debug(`dismiss busy=${this.agentBusy} live=${this.live}`);
		if (this.agentBusy) {
			this.muted = true;
			this.stopping = true;
			this.options.stopTurn?.();
		}
		this.apply({ type: "stop" });
		const reply = this.localReply(this.settings().dismissReply);
		if (reply) this.apply({
			type: "local",
			text: reply
		});
		this.requestUnpin();
		this.poll();
	}
	interject(text) {
		debug(`interject busy=${this.agentBusy} live=${this.live}`);
		this.commandSeed = 0;
		if (this.agentBusy) {
			this.muted = true;
			this.stopping = true;
		}
		for (const key of this.seen.keys()) this.silencedSteps.add(stepOf(key));
		this.apply({ type: "stop" });
		this.options.interject?.(text);
		this.poll();
	}
	/**
	* The hard interjection could not cancel the old turn. Undo the muted/stopping state
	* so the turn that is still running keeps speaking and listening.
	*/
	resumeAfterInterjectFailure() {
		this.muted = false;
		this.stopping = false;
		this.commandSeed = 300;
		this.silencedSteps.clear();
		if (!this.live) return;
		this.pushListen(false);
		this.poll();
	}
	onChildExit(link) {
		if (link !== void 0 && link !== this.link) return;
		debug(`child-exit closing=${this.closing} restarts=${this.restarts}`);
		this.link = void 0;
		this.live = false;
		this.micOpen = false;
		this.micKnown = false;
		this.echoCancel = false;
		this.device = false;
		this.setSpeech(false);
		if (this.timer) clearInterval(this.timer);
		this.timer = void 0;
		if (this.closing) return;
		this.resetPlayback();
		this.idle = createIdle();
		this.commandSeed = 300;
		this.options.send({
			type: "voice-mode",
			mode: "off"
		});
		this.restartChild();
	}
	/** A new lifecycle starts with no inherited queue, pin, speech edge, or restart budget. */
	fresh(initial) {
		this.closing = false;
		this.restarts = 0;
		this.failed = false;
		if (this.slowRetry) clearTimeout(this.slowRetry);
		this.slowRetry = void 0;
		this.pinned = false;
		this.agentBusy = initial.agentBusy === true;
		this.questionOpen = initial.questionOpen === true;
		this.setSpeech(false);
		this.micOpen = false;
		this.micKnown = false;
		this.echoCancel = false;
		this.device = false;
		this.mode = "off";
		this.commandSeed = 300;
		this.hold = false;
		this.idle = createIdle();
		this.assistantKey = void 0;
		this.staleKeys.clear();
		this.queue = createQueue(this.ttsOn());
		this.options.send({
			type: "voice-hold",
			hold: false
		});
		this.options.send({
			type: "voice-mode",
			mode: "off"
		});
		this.options.send({
			type: "voice-level",
			value: 0
		});
	}
	launchChild() {
		if (this.live) return;
		let link;
		try {
			link = this.options.open();
		} catch {
			link = void 0;
		}
		if (link === void 0) {
			debug("launch failed: no link");
			this.failed = true;
			this.mode = "off";
			this.scheduleSlowRetry();
			return;
		}
		this.live = true;
		this.link = link;
		debug(`launch ok tts=${this.ttsOn()}`);
		const enabled = this.ttsOn();
		if (enabled !== this.queue.enabled) this.queue = createQueue(enabled);
		link.onMessage((message) => {
			if (this.link === link) this.onChild(message);
		});
		this.timer = setInterval(() => this.poll(), 250);
		this.timer.unref();
		link.onExit(() => this.onChildExit(link));
		this.pushConfigure();
		this.pushListen(true);
	}
	/** A crashed child gets a fresh process, up to the documented limit. */
	restartChild() {
		if (this.closing) return;
		this.restarts += 1;
		if (this.restarts > RESTART_LIMIT) {
			this.failed = true;
			this.mode = "off";
			this.scheduleSlowRetry();
			return;
		}
		this.launchChild();
	}
	/**
	* Keep a low-rate retry alive after the fast budget is spent. A missing model
	* download, an environment fix, or a one-off crash all heal on their own at the
	* next tick; a permanently broken install costs one fork every 30 seconds.
	*/
	scheduleSlowRetry() {
		if (this.closing || this.slowRetry !== void 0) return;
		this.slowRetry = setTimeout(() => {
			this.slowRetry = void 0;
			if (this.closing || this.live) return;
			this.restarts = 0;
			this.failed = false;
			this.launchChild();
		}, SLOW_RETRY_MS);
		this.slowRetry.unref?.();
	}
	resetPlayback() {
		this.queue = createQueue(this.ttsOn());
		if (this.hold) {
			this.hold = false;
			this.options.send({
				type: "voice-hold",
				hold: false
			});
		}
	}
	requestUnpin() {
		if (!this.pinned) return;
		this.pinned = false;
		this.idle = createIdle();
		this.options.send({ type: "unpin" });
		this.pushListen(false);
	}
	apply(event) {
		const step = reduceQueue(this.queue, event);
		this.queue = step.state;
		this.dispatch(step.effects);
		this.syncHold();
		this.pushListen(false);
	}
	dispatch(effects) {
		for (const effect of effects) {
			debug(`dispatch ${effect.type} id=${effect.id}${effect.type === "play" ? ` text=${effect.text.length}` : ""} link=${this.link !== void 0} live=${this.live}`);
			if (effect.type === "play") this.link?.send({
				type: "speak",
				id: effect.id,
				text: effect.text
			});
			else this.link?.send({
				type: "stop-speak",
				id: effect.id
			});
		}
	}
	syncHold() {
		const hold = voiceHold(this.queue);
		if (hold === this.hold) return;
		this.hold = hold;
		this.options.send({
			type: "voice-hold",
			hold
		});
	}
	pushConfigure() {
		this.link?.send({
			type: "configure",
			settings: this.settings(),
			paths: this.options.paths?.()
		});
	}
	pushListen(force) {
		const settings = this.settings();
		const presence = this.options.presence();
		const mode = listenMode({
			pinned: this.pinned,
			agentBusy: this.agentBusy,
			translationBusy: this.translationBusy,
			translationQuiet: this.translationQuiet,
			questionOpen: this.questionOpen,
			bodyBusy: bodyBusy(this.queue),
			localBusy: localBusy(this.queue),
			stopping: this.stopping,
			wakeEnabled: settings.wakeEnabled && hasWakeWord(settings.wakeWords) && presence.wake,
			commandEnabled: this.commandEnabled(),
			interjectEnabled: this.interjectEnabled(),
			echoCancel: this.echoCancel,
			micOpen: this.micOpen
		});
		if ((this.mode === "command" || this.mode === "interject") && !transcribing(mode) && this.speechOpen && this.canFinish(this.mode)) return;
		const device = this.deviceWanted(settings, presence);
		if (!force && mode === this.mode && device === this.device) return;
		if (transcribing(this.mode) && !transcribing(mode)) this.setSpeech(false);
		const entering = transcribing(mode) && !transcribing(this.mode);
		let seedMs = entering ? this.commandSeed : 0;
		if (entering) this.commandSeed = 300;
		if (!this.device && device) seedMs = 0;
		this.mode = mode;
		this.device = device;
		this.link?.send({
			type: "listen",
			mode,
			seedMs,
			device
		});
		this.options.send({
			type: "voice-mode",
			mode
		});
		if (!transcribing(mode)) this.options.send({
			type: "voice-level",
			value: 0
		});
	}
	localReply(text) {
		const reply = text.trim();
		if (!reply || !this.ttsOn()) return "";
		return reply;
	}
	ttsOn() {
		return ttsReady(this.settings(), this.options.presence().tts);
	}
	sample() {
		return {
			now: this.options.now(),
			pinned: this.pinned,
			agentBusy: this.agentBusy,
			translationBusy: this.translationBusy,
			questionOpen: this.questionOpen,
			playbackBusy: queueView(this.queue).playbackBusy,
			speechOpen: this.speechOpen,
			idleMs: this.settings().idleMs
		};
	}
};
/** `b:${turn}:${step}:${index}` → `b:${turn}:${step}`. Any other key is returned unchanged. */
function stepOf(key) {
	return /^b:\d+:\d+:\d+$/.test(key) ? key.slice(0, key.lastIndexOf(":")) : key;
}
/** A leading wake word is not a command. An empty remainder is dropped by the caller. */
function stripWakePrefix(text, words) {
	const spoken = text.trim();
	for (const word of words) {
		const phrase = word.trim();
		if (!phrase || !spoken.startsWith(phrase)) continue;
		return spoken.slice(phrase.length).trim();
	}
	return spoken;
}
/**
* Fork the voice child when this install has one beside the host.
* A test run does not start it; the voice tests pass their own script.
*/
function openVoiceChild() {
	if (process.env.NODE_TEST_CONTEXT) return void 0;
	const built = fileURLToPath(new URL("../voice/child.js", import.meta.url));
	if (existsSync(built)) return forkChild(built, []);
	const source = fileURLToPath(new URL("../../voice/src/child.ts", import.meta.url));
	if (existsSync(source)) return forkChild(source, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning"]);
}
function forkChild(script, execArgv) {
	return linkProcess(fork(script, [], {
		execArgv,
		env: {
			...process.env,
			ELECTRON_RUN_AS_NODE: "1"
		},
		stdio: [
			"pipe",
			"pipe",
			"inherit",
			"ipc"
		]
	}));
}
/** NDJSON over a child process's stdin and stdout. Lines that arrive before a handler are kept. */
function linkProcess(child) {
	const pending = [];
	let handler;
	const exits = /* @__PURE__ */ new Set();
	let exited = false;
	const finish = () => {
		if (exited) return;
		exited = true;
		for (const exit of exits) exit();
	};
	if (child.stdout) createInterface({ input: child.stdout }).on("line", (line) => {
		if (!line.trim()) return;
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		if (handler) handler(message);
		else pending.push(message);
	});
	child.once("error", finish);
	child.once("exit", finish);
	return {
		send(message) {
			if (exited || child.stdin === null || child.stdin.destroyed) return;
			try {
				child.stdin.write(`${JSON.stringify(message)}\n`);
			} catch {
				finish();
			}
		},
		close() {
			child.kill();
		},
		onMessage(next) {
			handler = next;
			const queued = pending.splice(0);
			for (const message of queued) next(message);
		},
		onExit(exit) {
			if (exited) queueMicrotask(exit);
			else exits.add(exit);
		}
	};
}
function asRecord$1(value) {
	return typeof value === "object" && value !== null ? value : void 0;
}
//#endregion
//#region src/tts-files.ts
const TTS_ZH_FILES = [
	{
		path: "date.fst",
		bytes: 59154
	},
	{
		path: "lexicon.txt",
		bytes: 1363705
	},
	{
		path: "model-steps-3.onnx",
		bytes: 75624188
	},
	{
		path: "number.fst",
		bytes: 64482
	},
	{
		path: "phone.fst",
		bytes: 88630
	},
	{
		path: "tokens.txt",
		bytes: 19591
	}
];
const TTS_EN_FILES = [
	{
		path: "espeak-ng-data/en_dict",
		bytes: 166944
	},
	{
		path: "espeak-ng-data/intonations",
		bytes: 2040
	},
	{
		path: "espeak-ng-data/lang/gmw/af",
		bytes: 123
	},
	{
		path: "espeak-ng-data/lang/gmw/de",
		bytes: 42
	},
	{
		path: "espeak-ng-data/lang/gmw/en",
		bytes: 140
	},
	{
		path: "espeak-ng-data/lang/gmw/en-029",
		bytes: 335
	},
	{
		path: "espeak-ng-data/lang/gmw/en-GB-scotland",
		bytes: 295
	},
	{
		path: "espeak-ng-data/lang/gmw/en-GB-x-gbclan",
		bytes: 238
	},
	{
		path: "espeak-ng-data/lang/gmw/en-GB-x-gbcwmd",
		bytes: 188
	},
	{
		path: "espeak-ng-data/lang/gmw/en-GB-x-rp",
		bytes: 249
	},
	{
		path: "espeak-ng-data/lang/gmw/en-US",
		bytes: 257
	},
	{
		path: "espeak-ng-data/lang/gmw/en-US-nyc",
		bytes: 271
	},
	{
		path: "espeak-ng-data/lang/gmw/lb",
		bytes: 31
	},
	{
		path: "espeak-ng-data/lang/gmw/nl",
		bytes: 23
	},
	{
		path: "espeak-ng-data/phondata",
		bytes: 550424
	},
	{
		path: "espeak-ng-data/phondata-manifest",
		bytes: 21821
	},
	{
		path: "espeak-ng-data/phonindex",
		bytes: 39074
	},
	{
		path: "espeak-ng-data/phontab",
		bytes: 55796
	},
	{
		path: "model-steps-3.onnx",
		bytes: 74157257
	},
	{
		path: "tokens.txt",
		bytes: 954
	}
];
const TTS_VOCODER = {
	repo: "k2-fsa/sherpa-onnx-models",
	path: "vocoder-models/vocos-22khz-univ.onnx",
	local: "vocos-22khz-univ.onnx",
	bytes: 53884024
};
//#endregion
//#region src/voice-models.ts
/**
* Whether the wake, speech-to-text, and TTS files are complete.
* A missing file means that column does not run. Hashes are for the update check.
*/
const ASR_FILES = [
	["models/sensevoice-onnx/model.int8.onnx", 239233841],
	["models/sensevoice-onnx/tokens.txt", 315894],
	["models/silero/silero_vad.onnx", 1807522]
];
function asrPresent(root) {
	return ASR_FILES.every(([file, bytes]) => sameSize(join(root, file), bytes)) && ASR_FILES.reduce((sum, [, bytes]) => sum + bytes, 0) === 241357257;
}
function kwsPresent(root) {
	const names = ["tokens.txt", "en.phone"];
	for (const chunk of [8, 16]) {
		const tag = `chunk-${chunk}`;
		names.push(`encoder-epoch-13-avg-2-${tag}-left-64.int8.onnx`, `decoder-epoch-13-avg-2-${tag}-left-64.onnx`, `joiner-epoch-13-avg-2-${tag}-left-64.int8.onnx`);
	}
	return names.every((name) => existsSync(join(root, name)));
}
function ttsPresent(root) {
	const zh = join(root, "matcha-icefall-zh-baker");
	const en = join(root, "matcha-icefall-en_US-ljspeech");
	return [
		"model-steps-3.onnx",
		"tokens.txt",
		"lexicon.txt",
		"date.fst",
		"number.fst",
		"phone.fst"
	].every((name) => existsSync(join(zh, name))) && ["model-steps-3.onnx", "tokens.txt"].every((name) => existsSync(join(en, name))) && existsSync(join(en, "espeak-ng-data")) && existsSync(join(root, "vocos-22khz-univ.onnx"));
}
function voicePresence(paths) {
	return {
		wake: kwsPresent(paths.kws),
		asr: asrPresent(paths.asr),
		tts: ttsPresent(paths.tts)
	};
}
function sameSize(file, bytes) {
	try {
		return statSync(file).size === bytes;
	} catch {
		return false;
	}
}
//#endregion
//#region src/voice-download.ts
/**
* Download the wake and TTS models the plugin owns, and ask DeepSeek Harness
* for the official ASR model. A second click while a transfer is running
* reports the current one instead of starting another.
*/
const NO_OFFICIAL_ASR = "当前 DeepSeek Harness 没有官方语音识别服务，插件不会自己另下一份";
/** Reads `ctx.get('speechToText')`. A missing service is not an error; the page explains it. */
function officialAsrFrom(service) {
	if (!service || typeof service !== "object") return void 0;
	const speech = service;
	if (typeof speech.prepare !== "function" || typeof speech.snapshot !== "function") return void 0;
	const prepare = speech.prepare.bind(speech);
	const snapshot = speech.snapshot.bind(speech);
	return {
		sources() {
			const provider = snapshot().providers?.find((item) => item.id === "sensevoice-local");
			if (!provider) return void 0;
			return (provider.downloadSources ?? []).filter((item) => item !== "");
		},
		prepare() {
			prepare("sensevoice-local");
		},
		state() {
			const provider = snapshot().providers?.find((item) => item.id === "sensevoice-local");
			const phase = provider?.preparation?.phase;
			return {
				phase: typeof phase === "string" ? phase : "unprepared",
				completedBytes: provider?.preparation?.completedBytes,
				totalBytes: provider?.preparation?.totalBytes,
				message: provider?.preparation?.message
			};
		}
	};
}
/**
* Where the wake archive comes from, in order. The npm package is the copy mainland China
* can actually reach (npmmirror first, then npmjs); the GitHub release stays as the last
* resort, which is also the only source that still needs the bzip2 path.
*/
function wakeModelSources() {
	return [
		{
			url: WAKE_MODEL_NPM_MIRROR,
			format: "tgz",
			sha256: WAKE_MODEL_SHA256
		},
		{
			url: WAKE_MODEL_NPM_OFFICIAL,
			format: "tgz",
			sha256: WAKE_MODEL_SHA256
		},
		{
			url: WAKE_MODEL_URL,
			format: "tbz2"
		}
	];
}
var VoiceDownloads = class {
	paths;
	onReady;
	speech;
	jobs = /* @__PURE__ */ new Map();
	errors = /* @__PURE__ */ new Map();
	install;
	asrTimer;
	constructor(paths, install, onReady, speech) {
		this.paths = paths;
		this.onReady = onReady;
		this.speech = speech;
		this.install = install ?? installVoiceModel;
	}
	view() {
		const base = absentVoiceModels();
		const paths = this.paths();
		const listed = this.official()?.sources();
		return {
			wake: this.decorate(base.wake, "wake", kwsPresent(paths.kws)),
			tts: this.decorate(base.tts, "tts", ttsPresent(paths.tts)),
			asr: {
				...this.decorate(base.asr, "asr", asrPresent(paths.asr)),
				official: listed !== void 0,
				...listed && listed.length > 0 ? { sources: listed } : {}
			}
		};
	}
	async begin(kind) {
		if (this.jobs.has(kind)) return "busy";
		if (await this.current(kind)) return "present";
		if (this.jobs.has(kind)) return "busy";
		if (kind === "asr") return this.beginAsr();
		this.errors.delete(kind);
		this.jobs.set(kind, {
			received: 0,
			total: 1,
			error: ""
		});
		this.install(kind, this.paths(), (received, total) => {
			const job = this.jobs.get(kind);
			if (!job) return;
			job.received = received;
			job.total = Math.max(total, 1);
		}).then(() => {
			this.jobs.delete(kind);
			this.errors.delete(kind);
			this.onReady?.();
		}).catch((error) => {
			this.jobs.delete(kind);
			this.errors.set(kind, error instanceof Error ? error.message : String(error));
		});
		return "started";
	}
	beginAsr() {
		const speech = this.official();
		if (!speech || speech.sources() === void 0) {
			this.errors.set("asr", NO_OFFICIAL_ASR);
			return "started";
		}
		this.errors.delete("asr");
		this.jobs.set("asr", {
			received: 0,
			total: ASR_MODEL_BYTES,
			error: ""
		});
		try {
			speech.prepare();
		} catch (error) {
			this.jobs.delete("asr");
			this.errors.set("asr", error instanceof Error ? error.message : String(error));
			return "started";
		}
		this.watchAsr();
		return "started";
	}
	official() {
		try {
			return this.speech?.();
		} catch {
			return;
		}
	}
	watchAsr() {
		if (this.asrTimer) clearInterval(this.asrTimer);
		this.pollAsr();
		this.asrTimer = setInterval(() => {
			this.pollAsr();
		}, 200);
	}
	stopAsr() {
		if (!this.asrTimer) return;
		clearInterval(this.asrTimer);
		this.asrTimer = void 0;
	}
	pollAsr() {
		if (!this.jobs.has("asr")) {
			this.stopAsr();
			return;
		}
		const state = this.official()?.state();
		if (!state) return;
		const job = this.jobs.get("asr");
		if (!job) return;
		if (state.phase === "downloading") {
			const total = state.totalBytes && state.totalBytes > 0 ? state.totalBytes : job.total;
			job.received = state.completedBytes ?? 0;
			job.total = total;
			return;
		}
		if (state.phase !== "ready" && state.phase !== "standby" && state.phase !== "failed" && state.phase !== "cancelled") return;
		this.stopAsr();
		this.jobs.delete("asr");
		if (state.phase === "failed" || state.phase === "cancelled") {
			this.errors.set("asr", state.message && state.message !== "" ? state.message : "下载失败");
			return;
		}
		if (asrPresent(this.paths().asr)) {
			this.errors.delete("asr");
			this.onReady?.();
			return;
		}
		this.errors.set("asr", "官方语音识别模型不完整");
	}
	decorate(base, kind, present) {
		const job = this.jobs.get(kind);
		return {
			...base,
			present: present && job === void 0,
			downloading: job !== void 0,
			progress: job === void 0 || job.total <= 0 ? 0 : Math.min(1, job.received / job.total),
			error: this.errors.get(kind) ?? ""
		};
	}
	async current(kind) {
		const paths = this.paths();
		if (kind === "wake") return kwsPresent(paths.kws);
		if (kind === "asr") return asrPresent(paths.asr);
		if (!ttsPresent(paths.tts)) return false;
		const zh = await sha256(join(paths.tts, "matcha-icefall-zh-baker", "model-steps-3.onnx"));
		const en = await sha256(join(paths.tts, "matcha-icefall-en_US-ljspeech", "model-steps-3.onnx"));
		const vocoder = await sha256(join(paths.tts, "vocos-22khz-univ.onnx"));
		const known = (accepted, digest) => accepted.includes(digest);
		return known(TTS_ZH_MODEL_SHA256, zh) && known(TTS_EN_MODEL_SHA256, en) && known(TTS_VOCODER_SHA256, vocoder);
	}
};
async function installVoiceModel(kind, paths, progress) {
	if (kind === "wake") {
		await installArchive(wakeModelSources(), paths.kws, progress);
		if (!kwsPresent(paths.kws)) throw new Error("语音唤醒模型不完整");
		return;
	}
	await installTts(paths.tts, progress);
}
const TTS_PARTS = [
	{
		repo: TTS_ZH_REPO,
		revision: TTS_ZH_REVISION,
		dir: "matcha-icefall-zh-baker",
		files: TTS_ZH_FILES
	},
	{
		repo: TTS_EN_REPO,
		revision: TTS_EN_REVISION,
		dir: "matcha-icefall-en_US-ljspeech",
		files: TTS_EN_FILES
	},
	{
		repo: TTS_VOCODER.repo,
		revision: TTS_VOCODER_REVISION,
		dir: "",
		files: [{
			path: TTS_VOCODER.path,
			bytes: TTS_VOCODER.bytes,
			local: TTS_VOCODER.local
		}]
	}
];
/** An HTTP answer worth retrying: the Hub replies 429 while it throttles a burst. */
var HubError = class extends Error {
	status;
	retryAfter;
	constructor(status, url, retryAfter) {
		super(`${status} ${url}`);
		this.status = status;
		this.retryAfter = retryAfter;
	}
};
/**
* File by file from the Hub. `hf-mirror.com` goes first because it is the only
* origin fast from mainland China; huggingface.co covers everywhere else. A
* throttled file is retried with backoff and then moved to the other origin,
* so one 429 cannot sink a 360-file install.
*/
async function installTts(root, progress) {
	const staging = `${root}.staging`;
	await rm(staging, {
		recursive: true,
		force: true
	});
	await mkdir(staging, { recursive: true });
	try {
		await downloadTts(TTS_ORIGINS.map((base) => ({
			base,
			failures: 0,
			down: false
		})), staging, progress);
		await verifyTts(staging);
		await rm(root, {
			recursive: true,
			force: true
		});
		await mkdir(dirname(root), { recursive: true });
		await rename(staging, root);
	} catch (error) {
		await rm(staging, {
			recursive: true,
			force: true
		});
		throw error;
	}
}
async function downloadTts(origins, root, progress) {
	const jobs = TTS_PARTS.flatMap((part) => part.files.map((file) => ({
		part,
		file
	})));
	let received = 0;
	progress(0, TTS_MODEL_BYTES);
	let failure;
	const queue = [...jobs];
	const worker = async () => {
		for (;;) {
			const job = queue.shift();
			if (job === void 0 || failure !== void 0) return;
			try {
				const local = job.file.local ?? job.file.path;
				await downloadHubFile(origins, job.part.repo, job.part.revision, job.file, join(root, job.part.dir, local));
				received += job.file.bytes;
				progress(received, TTS_MODEL_BYTES);
			} catch (error) {
				failure = error;
				return;
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(2, jobs.length) }, worker));
	if (failure !== void 0) throw failure;
}
/** One file at a pinned commit. `main` moves; a commit's bytes do not. */
function hubResolveUrl(base, repo, revision, path) {
	return `${base}/${repo}/resolve/${revision}/${path.split("/").map(encodeURIComponent).join("/")}`;
}
async function downloadHubFile(origins, repo, revision, file, dest) {
	await mkdir(dirname(dest), { recursive: true });
	let last;
	for (const origin of origins) {
		if (origin.down) continue;
		for (let attempt = 1; attempt <= 3; attempt += 1) try {
			await fetchToFile(hubResolveUrl(origin.base, repo, revision, file.path), dest, file.bytes);
			origin.failures = 0;
			return;
		} catch (error) {
			last = error;
			await rm(dest, { force: true });
			origin.failures += 1;
			if (origin.failures >= 10) {
				origin.down = true;
				break;
			}
			if (attempt < 3) await sleep(retryDelay(error, attempt));
			else break;
		}
	}
	throw last instanceof Error ? last : /* @__PURE__ */ new Error(`下载失败: ${file.path}`);
}
function retryDelay(error, attempt) {
	if (error instanceof HubError && error.retryAfter !== void 0) return Math.min(error.retryAfter * 1e3, 3e4);
	if (error instanceof HubError && error.status === 429) return 2e3 * attempt;
	return 500 * attempt;
}
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
async function fetchToFile(url, dest, expected) {
	const response = await fetch(url, {
		redirect: "follow",
		signal: AbortSignal.timeout(3e5)
	});
	if (response.status === 429 || response.status === 503) {
		const header = Number(response.headers.get("retry-after") ?? 0);
		throw new HubError(response.status, url, Number.isFinite(header) && header > 0 ? header : void 0);
	}
	if (!response.ok || response.body === null) throw new HubError(response.status, url);
	const file = createWriteStream(dest);
	let bytes = 0;
	let broken = false;
	try {
		const reader = response.body.getReader();
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			const buffer = Buffer.from(chunk.value);
			bytes += buffer.length;
			if (!file.write(buffer)) await onceDrain(file);
		}
	} catch (error) {
		broken = true;
		file.destroy();
		throw error;
	} finally {
		if (!broken && !file.destroyed) file.end();
	}
	await finished(file);
	if (bytes !== expected) throw new Error(`size ${bytes} != ${expected}: ${url}`);
}
async function verifyTts(root) {
	const checks = [
		[join(root, "matcha-icefall-zh-baker", "model-steps-3.onnx"), TTS_ZH_MODEL_SHA256],
		[join(root, "matcha-icefall-en_US-ljspeech", "model-steps-3.onnx"), TTS_EN_MODEL_SHA256],
		[join(root, "vocos-22khz-univ.onnx"), TTS_VOCODER_SHA256]
	];
	for (const [file, accepted] of checks) {
		const digest = await sha256(file).catch(() => "");
		if (!accepted.includes(digest)) {
			const expected = accepted.map((hash) => `${hash.slice(0, 8)}…`).join(" / ");
			throw new Error(`${relative(root, file)} 校验失败（实际 ${digest.slice(0, 8) || "无法读取"}，期望 ${expected}）`);
		}
	}
}
async function installArchive(sources, dest, progress) {
	const staging = `${dest}.staging`;
	const archive = `${dest}.download`;
	await rm(staging, {
		recursive: true,
		force: true
	});
	await rm(archive, { force: true });
	await mkdir(staging, { recursive: true });
	try {
		await extractArchive(archive, staging, (await downloadFirst(sources, archive, progress)).format);
		const found = await findModelDir(staging);
		await rm(dest, {
			recursive: true,
			force: true
		});
		await mkdir(dirname(dest), { recursive: true });
		await rename(found, dest);
	} finally {
		await rm(archive, { force: true });
		await rm(staging, {
			recursive: true,
			force: true
		});
	}
}
/**
* Where the model root ended up. The GitHub release unpacks to `sherpa-onnx-kws-…/`, and the
* npm tarball to `package/kws/`, so the search has to look two levels down, not one.
*/
async function findModelDir(root) {
	const { readdir } = await import("node:fs/promises");
	const level = [root];
	for (let depth = 0; depth <= 2 && level.length > 0; depth += 1) for (const dir of level.splice(0)) {
		if (kwsPresent(dir)) return dir;
		for (const name of await readdir(dir).catch(() => [])) level.push(join(dir, name));
	}
	throw new Error("解压后没有找到唤醒模型");
}
/** No bytes for this long means the origin is gone, not that it is slow. */
const STALL_MS = 2e4;
/** Past this mark, a source that is barely moving is worth abandoning for the next one. */
const SLOW_MS = 2e4;
const SLOW_BPS = 24576;
/** A 4xx that retrying cannot fix: the next source is the only way forward. */
var SourceGone = class extends Error {};
/**
* Try each source in turn, three times each; the first one that lands a complete, digest-clean
* archive wins. The last source is exempt from the speed floor: at that point a slow copy is
* better than no copy at all.
*/
async function downloadFirst(sources, dest, progress) {
	let last = "下载失败";
	for (const [index, source] of sources.entries()) {
		const floor = index < sources.length - 1;
		for (let attempt = 1; attempt <= 3; attempt += 1) try {
			await downloadOne(source.url, dest, progress, floor);
			if (source.sha256 !== void 0) {
				if (await sha256(dest).catch(() => "") !== source.sha256) {
					await rm(dest, { force: true });
					throw new Error(`校验失败 ${source.url}`);
				}
			}
			return source;
		} catch (error) {
			last = error instanceof Error ? error.message : String(error);
			if (error instanceof SourceGone) break;
			if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1e3 * attempt));
		}
		await rm(dest, { force: true });
	}
	throw new Error(last);
}
async function downloadOne(url, dest, progress, floor) {
	await mkdir(dirname(dest), { recursive: true });
	let already = 0;
	try {
		already = (await stat(dest)).size;
	} catch {
		already = 0;
	}
	const headers = already > 0 ? { range: `bytes=${already}-` } : {};
	const controller = new AbortController();
	let stall;
	const restart = () => {
		if (stall !== void 0) clearTimeout(stall);
		stall = setTimeout(() => {
			controller.abort(/* @__PURE__ */ new Error(`stalled: ${url}`));
		}, STALL_MS);
	};
	restart();
	try {
		const response = await fetch(url, {
			redirect: "follow",
			headers,
			signal: controller.signal
		});
		const body = response.body;
		if (response.status === 416 && already > 0) {
			progress(already, already);
			return;
		}
		if (!response.ok || body === null) {
			const message = `${response.status} ${url}`;
			throw response.status === 404 || response.status === 410 ? new SourceGone(message) : new Error(message);
		}
		const resume = response.status === 206 && already > 0;
		const length = Number(response.headers.get("content-length") ?? 0);
		const total = resume ? already + length : length;
		const file = createWriteStream(dest, { flags: resume ? "a" : "w" });
		const reader = body.getReader();
		let received = resume ? already : 0;
		const started = Date.now();
		let moved = 0;
		try {
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				restart();
				const bytes = Buffer.from(chunk.value);
				if (!file.write(bytes)) await onceDrain(file);
				received += bytes.length;
				moved += bytes.length;
				progress(received, total > 0 ? total : received);
				if (floor && Date.now() - started > SLOW_MS && moved / ((Date.now() - started) / 1e3) < SLOW_BPS) controller.abort(/* @__PURE__ */ new Error(`too slow: ${url}`));
			}
			if (controller.signal.aborted) throw new Error(`下载超时或太慢 ${url}`);
		} catch (error) {
			file.destroy();
			throw error;
		} finally {
			if (!file.destroyed) file.end();
		}
		await finished(file);
	} finally {
		if (stall !== void 0) clearTimeout(stall);
	}
}
function onceDrain(file) {
	return new Promise((resolve) => file.once("drain", () => resolve()));
}
function extractArchive(archive, dest, format) {
	const cwd = dirname(archive);
	return new Promise((resolve, reject) => {
		const child = spawn("tar", [
			format === "tgz" ? "-xzf" : "-xjf",
			basename(archive),
			"-C",
			basename(dest)
		], { cwd });
		let stderr = "";
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("exit", (code) => {
			if (code === 0) resolve();
			else reject(new Error(stderr.trim() || `tar exited ${code}`));
		});
	});
}
async function sha256(file) {
	const hash = createHash("sha256");
	hash.update(await readFile(file));
	return hash.digest("hex");
}
//#endregion
//#region src/overlay-guard.ts
/**
* Computer Use overlay cloak.
* Every capture runs inside an `overlay-capture` interval: the helper lifts the ball,
* toolbar, and observation frame out of screen captures for the interval, so the agent
* never sees its own chrome. HID bursts keep the `overlay-input` interval, which also
* holds the protection across the post-action screenshot inside the burst.
*/
const OVERLAY_GUARD_ACK_TIMEOUT_MS = 1e3;
function delay(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms).unref();
	});
}
function createOverlayGuard(transport) {
	let inputDepth = 0;
	let captureDepth = 0;
	/** True between the begin the helper counted and its matching end. */
	let captureOpen = false;
	const sleep = transport.sleep ?? delay;
	return {
		async withCapture(run, signal) {
			captureDepth += 1;
			const cloaked = captureDepth === 1 && inputDepth === 0 && transport.hasHelper();
			try {
				if (cloaked) {
					const begin = transport.send({
						type: "overlay-capture",
						id: randomUUID(),
						active: true
					}, signal);
					captureOpen = true;
					await begin;
					await sleep(50);
				}
				return await run({ excludeWindowIds: transport.chromeWindowIds?.() ?? [] });
			} finally {
				captureDepth -= 1;
				if (captureDepth === 0 && captureOpen) {
					captureOpen = false;
					try {
						await transport.send({
							type: "overlay-capture",
							id: randomUUID(),
							active: false
						});
					} catch {}
				}
			}
		},
		async withInput(run) {
			inputDepth += 1;
			const outer = inputDepth === 1;
			const cloaked = outer && transport.hasHelper();
			try {
				if (outer) {
					transport.setHidInput(true);
					if (cloaked) await transport.send({
						type: "overlay-input",
						id: randomUUID(),
						active: true
					});
				}
				const value = await run();
				if (cloaked) await sleep(80);
				return value;
			} finally {
				inputDepth -= 1;
				if (inputDepth === 0) try {
					if (cloaked) try {
						await transport.send({
							type: "overlay-input",
							id: randomUUID(),
							active: false
						});
					} catch {}
				} finally {
					transport.setHidInput(false);
				}
			}
		},
		async setObservationFrame(bounds, signal) {
			if (!transport.hasHelper()) return;
			const wanted = bounds === null || transport.observationFrameEnabled?.() === false ? null : bounds;
			if (wanted !== null && signal?.aborted) {
				await transport.send({
					type: "observation-frame",
					id: randomUUID(),
					bounds: null
				});
				return;
			}
			try {
				await transport.send({
					type: "observation-frame",
					id: randomUUID(),
					bounds: wanted
				}, signal);
			} catch (error) {
				if (wanted !== null && signal?.aborted) {
					await transport.send({
						type: "observation-frame",
						id: randomUUID(),
						bounds: null
					});
					return;
				}
				throw error;
			}
		}
	};
}
//#endregion
//#region src/lasso.ts
/**
* Lasso selections waiting for an instruction, and the capture each confirm-frame
* button asks for. The helper owns the overlay; this module owns the durable image,
* the clipboard copy, and the seed the next Computer Use turn consumes.
*/
const PENDING_TTL_MS = 6e5;
const MAX_PENDING = 8;
var LassoController = class {
	deps;
	pending = /* @__PURE__ */ new Map();
	now;
	constructor(deps) {
		this.deps = deps;
		this.now = deps.now ?? Date.now;
	}
	/** Handle one button press from the confirm frame. */
	async action(input) {
		const capture = this.deps.capture();
		const attachments = this.deps.attachments();
		if (capture === void 0 || attachments === void 0) {
			console.error(`dsh-orb: lasso ${input.action} unavailable: ${capture === void 0 ? "capture" : "attachments"} service is missing`);
			this.result(input.action, false, "截图服务不可用");
			return;
		}
		try {
			if (input.action === "copy") {
				await capture.capture({
					mode: "crop",
					rect: input.rect,
					physicalRect: input.physicalRect,
					display: input.display,
					physicalDisplay: input.physicalDisplay,
					copyToClipboard: true
				});
				this.result("copy", true);
				return;
			}
			if (input.action === "translate") {
				const crop = await capture.capture({
					mode: "crop",
					rect: input.rect,
					physicalRect: input.physicalRect,
					display: input.display,
					physicalDisplay: input.physicalDisplay
				});
				const image = await attachments.saveImage({
					data: crop.data,
					mediaType: crop.mediaType,
					name: "lasso-crop"
				});
				this.result("translate", true);
				this.deps.translate(image);
				return;
			}
			const shot = await capture.capture({
				mode: "highlight",
				rect: input.rect,
				physicalRect: input.physicalRect,
				display: input.display,
				physicalDisplay: input.physicalDisplay
			});
			const image = await attachments.saveImage({
				data: shot.data,
				mediaType: shot.mediaType,
				name: "lasso-screen"
			});
			const id = randomUUID();
			this.prune();
			this.pending.set(id, {
				id,
				sessionId: this.deps.currentSessionId(),
				image,
				screen: shot.screen,
				foreground: shot.foreground,
				size: {
					width: Math.round(input.rect.width),
					height: Math.round(input.rect.height)
				},
				at: this.now()
			});
			while (this.pending.size > MAX_PENDING) {
				const oldest = this.pending.keys().next().value;
				if (typeof oldest !== "string") break;
				this.pending.delete(oldest);
			}
			this.deps.broadcast({
				type: "lasso-attach",
				selectionId: id,
				image,
				size: {
					width: Math.round(input.rect.width),
					height: Math.round(input.rect.height)
				}
			});
			this.result("send", true);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`dsh-orb: lasso ${input.action} failed: ${message}`);
			this.result(input.action, false, lassoErrorMessage(error));
		}
	}
	/** The chip was removed before sending: drop the image and any queued seed. */
	dismiss(id) {
		const pending = this.pending.get(id);
		this.pending.delete(id);
		if (pending?.sessionId !== void 0) this.deps.seed()?.clear(pending.sessionId);
	}
	/**
	* Arm the first-frame seed for the prompt carrying this selection.
	* @returns true when the prompt should use the lasso screenshot instead of a live capture.
	*/
	takeForPrompt(id, sessionId) {
		const pending = this.pending.get(id);
		if (pending === void 0) return false;
		this.pending.delete(id);
		if (this.now() - pending.at > PENDING_TTL_MS) return false;
		if (pending.sessionId !== void 0 && pending.sessionId !== sessionId) return false;
		const seed = this.deps.seed();
		if (seed === void 0) return false;
		seed.set(sessionId, {
			screen: pending.screen,
			foreground: pending.foreground,
			image: pending.image
		});
		return true;
	}
	/** A transcript reset, a new session, or a switch drops a chip that no longer belongs. */
	clearSession(sessionId) {
		if (sessionId === void 0) {
			this.pending.clear();
			this.deps.seed()?.clear();
			return;
		}
		for (const [id, pending] of this.pending) if (pending.sessionId === void 0 || pending.sessionId === sessionId) this.pending.delete(id);
		this.deps.seed()?.clear(sessionId);
	}
	has(id) {
		return this.pending.has(id);
	}
	result(action, ok, message) {
		this.deps.broadcast({
			type: "lasso-result",
			action,
			ok,
			...message === void 0 ? {} : { message }
		});
	}
	prune() {
		const cutoff = this.now() - PENDING_TTL_MS;
		for (const [id, pending] of this.pending) if (pending.at < cutoff) this.pending.delete(id);
	}
};
function lassoErrorMessage(error) {
	const message = error instanceof Error ? error.message : String(error);
	if (/screen recording|Screen Recording|permission/i.test(message)) return "需要「屏幕录制」权限，请在系统设置中授权后重试";
	return message === "" ? "截图失败，请重试" : message;
}
/** Validate one helper action without trusting its shape. */
function readLassoAction(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const record = value;
	if (record.action !== "send" && record.action !== "translate" && record.action !== "copy") return void 0;
	const rect = readRect$1(record.rect);
	const display = readDisplay(record.display);
	if (rect === void 0 || display === void 0) return void 0;
	const physicalRect = readRect$1(record.physicalRect);
	const physicalDisplay = readDisplay(record.physicalDisplay);
	return {
		action: record.action,
		rect,
		display,
		...physicalRect === void 0 ? {} : { physicalRect },
		...physicalDisplay === void 0 ? {} : { physicalDisplay }
	};
}
function readRect$1(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const record = value;
	if (![
		record.x,
		record.y,
		record.width,
		record.height
	].every((field) => typeof field === "number" && Number.isFinite(field))) return void 0;
	if (record.width < 1 || record.height < 1) return void 0;
	return {
		x: record.x,
		y: record.y,
		width: record.width,
		height: record.height
	};
}
function readDisplay(value) {
	const rect = readRect$1(value);
	if (rect === void 0) return void 0;
	const scale = value.scale;
	if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0) return void 0;
	return {
		...rect,
		scale
	};
}
const SELECTION_ACCESSIBILITY_POLL_MS = 1e3;
/** A rectangle is usable only when every field is a finite number and it has an area. */
function readRect(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const record = value;
	if (typeof record.x !== "number" || typeof record.y !== "number" || typeof record.width !== "number" || typeof record.height !== "number") return;
	if (![
		record.x,
		record.y,
		record.width,
		record.height
	].every(Number.isFinite)) return void 0;
	if (record.width < 1 || record.height < 1) return void 0;
	return {
		x: record.x,
		y: record.y,
		width: record.width,
		height: record.height
	};
}
function selectionSearchUrl(text) {
	return `https://www.bing.com/search?q=${encodeURIComponent(text)}`;
}
/** Open a URL with the system handler. Search uses this and does not expand the ball. */
function openSystemUrl(url) {
	const command = process.platform === "win32" ? "cmd" : "open";
	const args = process.platform === "win32" ? [
		"/c",
		"start",
		"",
		url
	] : [url];
	const child = spawn(command, args, {
		stdio: "ignore",
		windowsHide: true
	});
	child.once("error", (error) => {
		console.error(`dsh-orb: open failed: ${error.message}`);
	});
	child.unref();
}
var SelectionController = class {
	host;
	startMonitor;
	monitor;
	lastText = "";
	lastAnchor = {
		x: 0,
		y: 0
	};
	lastRect;
	lastDedupe;
	lastPid;
	restoreTimer;
	sessionRunning = false;
	hidInput = false;
	lassoActive = false;
	promptedAccessibility = false;
	accessibilityPoll;
	constructor(host, startMonitor = startSelectionMonitor) {
		this.host = host;
		this.startMonitor = startMonitor;
	}
	/** Start while the helper is connected and the switch is on. */
	sync() {
		if (process.platform === "linux") return;
		if (this.host.helperConnected() && this.host.enabled()) this.start();
		else this.stop();
	}
	stop() {
		this.clearAccessibilityPoll();
		this.lassoActive = false;
		this.monitor?.stop();
		this.monitor = void 0;
		if (this.restoreTimer !== void 0) {
			clearTimeout(this.restoreTimer);
			this.restoreTimer = void 0;
		}
		this.host.hide();
	}
	setLanguage(language) {
		this.host.setLanguage(language);
	}
	/**
	* Hide the toolbar and tell the monitor, so it stops reporting the events that would only
	* dismiss a bar that is no longer there. Every dismissal path goes through here.
	*/
	hideToolbar() {
		this.host.hide();
		this.monitor?.setToolbarVisible?.(false);
	}
	setSessionRunning(running) {
		this.sessionRunning = running;
		if (running) this.hideToolbar();
	}
	setHidInput(active) {
		this.hidInput = active;
		if (active) this.hideToolbar();
	}
	/**
	* A lasso stroke would read as a text selection, so the monitor must not report one while
	* the helper owns the drag and the confirm frame.
	*/
	setLassoActive(active) {
		this.lassoActive = active;
		if (active) this.hideToolbar();
	}
	search() {
		if (this.lastText === "") return;
		this.hideToolbar();
		this.host.openExternal(selectionSearchUrl(this.lastText));
	}
	translate() {
		if (this.lastText === "") return;
		this.hideToolbar();
		this.host.translate(this.lastText, this.host.language());
		this.scheduleRestoreFrontApp();
	}
	sendToAgent() {
		if (this.lastText === "") return;
		this.hideToolbar();
		this.host.attach(this.lastText);
	}
	onHelperEvent(event) {
		switch (event.type) {
			case "ready":
				this.exclude();
				return;
			case "untrusted":
				if (!this.promptedAccessibility) {
					this.promptedAccessibility = true;
					this.host.requestAccessibility();
				}
				this.watchAccessibility();
				return;
			case "mouse-down":
				this.host.pointer(event.x, event.y);
				return;
			case "key":
			case "dismiss":
				this.hideToolbar();
				return;
			case "mouse-up":
				this.lastAnchor = {
					x: event.x,
					y: event.y
				};
				return;
			case "selection":
				this.onSelection(event);
				return;
		}
	}
	start() {
		if (this.monitor !== void 0) return;
		const started = this.startMonitor({ onEvent: (event) => {
			this.onHelperEvent(event);
		} });
		if (started === void 0) return;
		this.monitor = started;
		this.exclude();
	}
	exclude() {
		const pids = [process.pid];
		const helper = this.host.helperPid();
		if (helper !== void 0) pids.push(helper);
		this.monitor?.setExcludePids(pids);
	}
	pausedReads() {
		return this.sessionRunning || this.hidInput || this.lassoActive || !this.host.enabled();
	}
	onSelection(event) {
		if (this.pausedReads()) return;
		const key = `${String(event.pid ?? 0)}\0${event.bundle ?? ""}\0${event.text}`;
		const now = this.host.now();
		if (this.lastDedupe !== void 0 && this.lastDedupe.key === key && now - this.lastDedupe.at < 3e3) return;
		this.lastDedupe = {
			key,
			at: now
		};
		this.lastText = event.text;
		this.lastPid = event.pid;
		if (typeof event.x === "number" && typeof event.y === "number" && Number.isFinite(event.x) && Number.isFinite(event.y)) this.lastAnchor = {
			x: event.x,
			y: event.y
		};
		this.lastRect = readRect(event.bounds);
		this.host.show({
			text: event.text,
			x: this.lastAnchor.x,
			y: this.lastAnchor.y,
			...this.lastRect === void 0 ? {} : { bounds: this.lastRect },
			language: this.host.language()
		});
		this.monitor?.setToolbarVisible?.(true);
	}
	scheduleRestoreFrontApp() {
		this.restoreFrontApp();
		if (this.restoreTimer !== void 0) clearTimeout(this.restoreTimer);
		const timer = setTimeout(() => {
			this.restoreTimer = void 0;
			this.restoreFrontApp();
		}, 80);
		timer.unref();
		this.restoreTimer = timer;
	}
	restoreFrontApp() {
		const pid = this.lastPid;
		if (pid === void 0 || pid === process.pid) return;
		this.monitor?.activatePid(pid);
	}
	watchAccessibility() {
		if (this.accessibilityPoll !== void 0) return;
		const timer = setInterval(() => {
			if (!this.host.enabled() || this.monitor === void 0) {
				this.clearAccessibilityPoll();
				return;
			}
			if (!this.host.accessibilityTrusted()) return;
			this.rearm();
		}, SELECTION_ACCESSIBILITY_POLL_MS);
		timer.unref();
		this.accessibilityPoll = timer;
	}
	rearm() {
		this.clearAccessibilityPoll();
		this.monitor?.stop();
		this.monitor = void 0;
		this.start();
	}
	clearAccessibilityPoll() {
		if (this.accessibilityPoll === void 0) return;
		clearInterval(this.accessibilityPoll);
		this.accessibilityPoll = void 0;
	}
};
function productionAccessibility() {
	return {
		requestAccessibility: () => promptAccessibility(),
		accessibilityTrusted: () => accessibilityTrusted()
	};
}
//#endregion
//#region src/translate.ts
/**
* The selection toolbar's Translate action: one throwaway model call, rendered in the ball.
*
* This turn deliberately stays out of the session. It never touches `sessionController`, so
* nothing reaches the transcript log and no later turn pays for it — the ball shows the pair,
* the conversation history does not. That is why it speaks to `llm.stream` directly instead of
* prompting the agent: the agent route would carry the whole Computer Use policy, the GUI tool
* schemas, and a screenshot, all of which a translation has no use for.
*
* @module dsh-orb/host/translate
*/
/** Longest selection the toolbar will translate. Mirrors the ball composer's own limit. */
const TRANSLATION_TEXT_LIMIT = 8e3;
/** What the user sees above the answer: the instruction, then the text being translated. */
const TRANSLATION_PROMPT_ZH = "把下面这段文字翻译成中文：";
const TRANSLATION_PROMPT_EN = "Translate the following into English:";
const SYSTEM_PROMPT_ZH = "你是一名翻译。把用户给出的文字忠实译成中文，只输出译文本身，不要解释、不要加引号、不要重复原文。保留原文的段落、列表与 Markdown 结构。";
const SYSTEM_PROMPT_EN = "You are a translator. Translate the user text into English faithfully. Output only the translation: no commentary, no quotation marks, no repetition of the source. Preserve paragraphs, lists, and Markdown structure.";
/** The instruction line that heads the user bubble. */
function translationPrompt(target) {
	return target === "en" ? TRANSLATION_PROMPT_EN : TRANSLATION_PROMPT_ZH;
}
/** System prompt for the throwaway call. */
function translationSystemPrompt(target) {
	return target === "en" ? SYSTEM_PROMPT_EN : SYSTEM_PROMPT_ZH;
}
/**
* Cut the selection to the toolbar's budget.
* @param text - the selected text.
* @param limit - characters allowed; the shipped limit is {@link TRANSLATION_TEXT_LIMIT}.
* @returns the text to translate and whether it was cut.
*/
function clipTranslationText(text, limit = TRANSLATION_TEXT_LIMIT) {
	if (text.length <= limit) return {
		text,
		truncated: false
	};
	return {
		text: text.slice(0, limit),
		truncated: true
	};
}
/** The user bubble: the instruction, then the source, marked when it had to be cut. */
function translationUserText(source, target, truncated, truncatedMark) {
	const body = truncated ? `${source}${truncatedMark}` : source;
	return `${translationPrompt(target)}\n\n${body}`;
}
/**
* Consume one translation stream.
*
* `llm.stream` reports adapter, auth, routing, and empty-response failures as a terminal
* `finish` chunk; it does not throw them. Ignoring that chunk left the bubble with a question
* and no answer, and no reason on screen, so every terminal failure becomes a thrown error here.
* @param answer - the model chunk stream.
* @param signal - the caller's abort signal; an abort keeps the text already shown.
* @param onText - receives the whole answer so far, each time it grows.
* @returns the translated text.
*/
async function collectTranslation(answer, signal, onText) {
	let out = "";
	for await (const chunk of answer) {
		if (signal.aborted) break;
		const record = chunk;
		if (record.type === "text-delta") {
			if (typeof record.text === "string") {
				out += record.text;
				onText(out);
			}
			continue;
		}
		if (record.type !== "finish") continue;
		const reason = record.reason;
		if (reason?.kind === "aborted" && signal.aborted) break;
		if (reason?.kind === "error" || reason?.kind === "aborted") throw translationFailure(reason.failure);
		break;
	}
	if (out === "" && !signal.aborted) throw new Error("模型没有返回译文（EMPTY_RESPONSE）。");
	return out;
}
/** Turn a provider failure payload into the message the ball shows. */
function translationFailure(failure) {
	const message = typeof failure?.message === "string" && failure.message !== "" ? failure.message : "翻译请求失败。";
	const code = typeof failure?.code === "string" && failure.code !== "" ? `（${failure.code}）` : "";
	return /* @__PURE__ */ new Error(`${message}${code}`);
}
/**
* Run one translation and report the answer as it grows.
* @param request - source text, target language, route, and the delta sink.
* @returns the final text; empty only when the caller aborted it.
*/
async function runTranslation(request) {
	const { text } = clipTranslationText(request.source);
	return collectTranslation(request.llm.stream({
		provider: request.route.provider,
		model: request.route.model,
		...request.sessionId === void 0 ? {} : { sessionId: request.sessionId },
		messages: [{
			role: "user",
			content: [{
				type: "text",
				text
			}]
		}],
		system: translationSystemPrompt(request.target),
		signal: request.signal
	}), request.signal, request.onText);
}
const IMAGE_SYSTEM_PROMPT_ZH = "你是一名翻译。读出用户截图中的文字，忠实翻译成中文，只输出译文本身，不要描述图片、不要解释、不要加引号、不要重复原文。保留原有换行、列表与 Markdown 结构。";
const IMAGE_SYSTEM_PROMPT_EN = "You are a translator. Read the text in the user screenshot and translate it faithfully into English. Output only the translation: no description of the image, no commentary, no quotation marks, no repetition of the source. Preserve line breaks, lists, and Markdown structure.";
const IMAGE_TRANSLATION_PROMPT_ZH = "把这张截图里的文字翻译成中文：";
const IMAGE_TRANSLATION_PROMPT_EN = "Translate the text in this screenshot into English:";
/** User bubble that heads an image translation. */
function imageTranslationPrompt(target) {
	return target === "en" ? IMAGE_TRANSLATION_PROMPT_EN : IMAGE_TRANSLATION_PROMPT_ZH;
}
/** System prompt for the throwaway image call. */
function imageTranslationSystemPrompt(target) {
	return target === "en" ? IMAGE_SYSTEM_PROMPT_EN : IMAGE_SYSTEM_PROMPT_ZH;
}
/**
* Translate the text in one screenshot through the ball's overlay route.
* The image is an ordinary attachment; nothing here touches the session.
*/
async function runImageTranslation(request) {
	return collectTranslation(request.llm.stream({
		provider: request.route.provider,
		model: request.route.model,
		...request.sessionId === void 0 ? {} : { sessionId: request.sessionId },
		messages: [{
			role: "user",
			content: [{
				type: "text",
				text: imageTranslationPrompt(request.target)
			}, {
				type: "image",
				attachment: request.image
			}]
		}],
		system: imageTranslationSystemPrompt(request.target),
		signal: request.signal
	}), request.signal, request.onText);
}
//#endregion
//#region src/workspace.ts
/**
* Validate the floating-ball Agent workspace selected in the settings card.
* A custom workspace must be an existing directory and may already contain files.
* The old workspace is never touched.
*/
async function validateWorkspaceSelection(value, defaultPath, currentPath) {
	const raw = value.trim();
	if (raw === "" || raw.length > 4096 || raw.includes("\0") || !isAbsolute(raw)) throw new Error("workspace-invalid-path");
	const path = resolve(raw);
	const defaultValue = resolve(defaultPath);
	const current = resolve(currentPath);
	const custom = path !== defaultValue;
	if (path === current) return {
		path,
		custom,
		unchanged: true
	};
	if (custom) {
		let info;
		try {
			info = await stat(path);
		} catch (error) {
			const code = error.code;
			throw new Error(code === "ENOENT" ? "workspace-not-found" : "workspace-not-readable");
		}
		if (!info.isDirectory()) throw new Error("workspace-not-directory");
	}
	return {
		path,
		custom,
		unchanged: false
	};
}
//#endregion
//#region src/screen-owner.ts
/**
* Host-side view of the process-global desktop owner.
*
* The preset's tool layer refuses GUI and shell calls from any session that is not the owner; the
* orb host is the only component that knows which conversation the ball panel shows, so it publishes
* that here. The record itself lives on `globalThis` under a `Symbol.for` key — the host package and
* `@dsh-orb/computer-use` are separate builds sharing one process, and duplicating the four lines
* that touch a symbol-keyed global is the same trade `@dsh-orb/computer-use/src/gui-lock.ts` makes
* for the screen mutex. Keep the key in step with that module.
*/
const SCREEN_OWNER = Symbol.for("dsh-orb.screen-owner");
function state() {
	const holder = globalThis;
	holder[SCREEN_OWNER] ??= { ownerId: "" };
	return holder[SCREEN_OWNER];
}
/**
* Publish the session the ball shows. Every ball conversation except this one loses GUI and shell
* access; an empty id (no ball, or the helper stopped) leaves every session unrestricted.
* @param sessionId - the displayed conversation, or undefined to lift the restriction.
*/
function publishScreenOwner(sessionId) {
	state().ownerId = typeof sessionId === "string" ? sessionId : "";
}
//#endregion
//#region src/select-model.ts
/**
* Official `selectModel` always writes the chosen model as the global default.
* A later `saveSelection` is queued behind that write, so the previous default is restored.
* Those settings fields are volatile, so the write does not restart plugins.
*
* Calls are serialized across every copy of this module in the process, so the ball and `code_agent`
* cannot interleave their select and restore steps. A short window still remains: official
* `selectModel` has no session-only option, so another window that creates a session between the
* official write and the restore sees the chosen model once.
*/
const QUEUE = Symbol.for("dsh-orb.select-model.queue");
function enqueue(task) {
	const holder = globalThis;
	const run = (holder[QUEUE] ?? Promise.resolve()).then(task, task);
	holder[QUEUE] = run.catch(() => void 0);
	return run;
}
/** Apply a model to one session, then put the global default back if it changed. */
function selectModelKeepDefault(ctx, request) {
	return enqueue(() => selectAndRestore(ctx, request));
}
async function selectAndRestore(ctx, request) {
	const defaults = ctx.agentDefaultModel;
	const previous = defaults?.currentSelection();
	const chosen = {
		provider: request.provider,
		model: request.model,
		...request.reasoningEffort === void 0 ? {} : { reasoningEffort: request.reasoningEffort }
	};
	await ctx.sessionController.selectModel({
		sessionId: request.sessionId,
		...chosen
	});
	if (defaults === void 0) {
		console.error("dsh-orb: agentDefaultModel is missing; a session model may replace the global default");
		return;
	}
	if (previous === void 0 || sameSelection(previous, chosen)) return;
	await defaults.saveSelection(previous);
	console.error("dsh-orb: restored the global default model after a session-only selection");
}
/** `SetForegroundWindow` is ignored unless this process received the last input; a posted Alt satisfies that. */
const VK_MENU = 18;
const INPUT_KEYBOARD = 1;
const KEYEVENTF_KEYUP = 2;
/** `sizeof(INPUT)` on 64-bit Windows. */
const INPUT_SIZE = 40;
const FOREGROUND_RETRY_MS = 50;
/**
* Track the last foreground window that is not the helper's own chrome.
* @param options - chrome handles, interval, and an optional native layer.
* @returns the sampler.
*/
function createForegroundMemory(options) {
	const intervalMs = options.intervalMs ?? 250;
	let native = options.native;
	let loaded = options.native !== void 0;
	let timer;
	let remembered = 0;
	function api() {
		if (loaded) return native;
		loaded = true;
		if (process.platform !== "win32") return void 0;
		try {
			native = loadWindowsForeground();
		} catch (error) {
			console.error(`dsh-orb: foreground memory unavailable: ${error instanceof Error ? error.message : String(error)}`);
			native = void 0;
		}
		return native;
	}
	function sample() {
		const host = api();
		if (host === void 0) return;
		let foreground = 0;
		try {
			foreground = host.foreground();
		} catch {
			return;
		}
		if (foreground <= 0) return;
		const chrome = options.chromeWindowIds();
		if (chrome.length === 0) return;
		if (chrome.includes(foreground)) {
			if (remembered === foreground) remembered = 0;
			return;
		}
		remembered = foreground;
	}
	return {
		start() {
			if (timer !== void 0 || api() === void 0) return;
			sample();
			const created = setInterval(sample, intervalMs);
			created.unref();
			timer = created;
		},
		stop() {
			if (timer === void 0) return;
			clearInterval(timer);
			timer = void 0;
		},
		restore() {
			const host = api();
			if (host === void 0 || remembered <= 0) return;
			try {
				if (host.foreground() === remembered) return;
				host.focus(remembered);
			} catch {}
		}
	};
}
function handleValue(value) {
	const id = typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : NaN;
	return Number.isSafeInteger(id) && id > 0 ? id : 0;
}
function sleepSync$1(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
/** One `KEYBDINPUT` inside an `INPUT`, laid out for 64-bit Windows. */
function keyboardInput(virtualKey, down) {
	const input = Buffer.alloc(INPUT_SIZE);
	input.writeUInt32LE(INPUT_KEYBOARD, 0);
	input.writeUInt16LE(virtualKey, 8);
	input.writeUInt32LE(down ? 0 : KEYEVENTF_KEYUP, 12);
	return input;
}
function loadWindowsForeground() {
	const user32 = requireKoffi(import.meta.url).load("user32.dll");
	const getForeground = user32.func("void * __stdcall GetForegroundWindow()");
	const setForeground = user32.func("int __stdcall SetForegroundWindow(void *hWnd)");
	const isWindow = user32.func("int __stdcall IsWindow(void *hWnd)");
	const sendInput = user32.func("uint32 __stdcall SendInput(uint32 cInputs, void *pInputs, int cbSize)");
	function foreground() {
		return handleValue(getForeground());
	}
	function postKey(virtualKey, down) {
		sendInput(1, keyboardInput(virtualKey, down), INPUT_SIZE);
	}
	return {
		foreground,
		focus(target) {
			if (isWindow(target) === 0) return false;
			postKey(VK_MENU, true);
			try {
				setForeground(target);
				if (foreground() === target) return true;
				sleepSync$1(FOREGROUND_RETRY_MS);
				return foreground() === target;
			} finally {
				postKey(VK_MENU, false);
			}
		}
	};
}
//#endregion
//#region src/deferred-install.ts
/**
* An update that has to wait until this process exits.
* When a native image inside the package is still mapped (see `native-images.ts`),
* asking pnpm to replace the package now would fail and take the live package
* apart. The update is handed to a small detached script outside the package
* instead: it waits for this process to exit, then runs the same pnpm the
* official plugin manager uses. A status file marks the install as running so the
* next start does not load a package that is being replaced; its outcome is read
* back once the script writes one.
*/
/**
* How long a status file without an outcome is still trusted. The script runs at most three
* 15-minute pnpm attempts plus its waits (~45 minutes), so anything older cannot be live.
* The ceiling exists because the script runs pnpm as its own child: killing the script
* orphans that pnpm, which keeps replacing the package with nobody left to write an outcome.
*/
const DEFERRED_INSTALL_CEILING_MS = 282e4;
/**
* How long a job file whose owner has exited still counts as an install about to run. The
* script touches the job file every 500 ms while it waits for that exit, so a fresh job file
* means the script is in the seconds before it writes its status; a stale one means the
* script died before pnpm ever started, and nothing is being replaced.
*/
const DEFERRED_INSTALL_PENDING_MS = 3e4;
/** Folder under the profile that holds the job, the script, its log, and its outcome. */
function deferredDir(profileDir) {
	return join(profileDir, ".dsh-orb-update");
}
/**
* Write the job and start the detached script. It runs on this executable with
* `ELECTRON_RUN_AS_NODE`, so it needs no Node on PATH, and from the profile folder,
* so it holds nothing open inside the package it replaces.
*/
function scheduleInstallAfterExit(job) {
	const dir = deferredDir(job.profileDir);
	mkdirSync(dir, { recursive: true });
	rmSync(join(dir, "result.json"), { force: true });
	const jobFile = join(dir, "job.json");
	const script = join(dir, "apply.mjs");
	writeFileSync(jobFile, `${JSON.stringify(job, null, 2)}\n`);
	writeFileSync(script, APPLY_SCRIPT);
	spawn(process.execPath, [script, jobFile], {
		cwd: job.profileDir,
		env: {
			...process.env,
			ELECTRON_RUN_AS_NODE: "1"
		},
		detached: true,
		stdio: "ignore",
		windowsHide: true
	}).unref();
}
/** The outcome a previous run's script left, removed once read. */
function takeDeferredOutcome(profileDir) {
	const file = join(deferredDir(profileDir), "result.json");
	let raw;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return;
	}
	try {
		rmSync(file, { force: true });
	} catch (error) {
		console.error(`dsh-orb: could not clear the install outcome: ${errorDetail(error)}`);
	}
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed.spec !== "string" || typeof parsed.ok !== "boolean") return void 0;
		return {
			spec: parsed.spec,
			ok: parsed.ok,
			detail: typeof parsed.detail === "string" ? parsed.detail : ""
		};
	} catch {
		return;
	}
}
/**
* Whether the after-exit script is installing right now. The script's own status file is
* the signal: it exists while pnpm runs and is removed once the outcome is written. Before
* that file exists the script is either still waiting for its owner (the package is
* untouched, the ball may run) or in the seconds between that exit and pnpm, which
* {@link installPendingAfterExit} covers. A status whose script died is only trusted until
* the script's own ceiling passes; then the leftover is collected as a failed outcome so
* the host can start.
* @param profileDir - profile that scheduled the install.
* @returns true while a live install is running.
*/
function deferredInstallInProgress(profileDir) {
	const dir = deferredDir(profileDir);
	let raw;
	try {
		raw = readFileSync(join(dir, "status.json"), "utf8");
	} catch {
		return outcomeWritten(dir) ? false : installPendingAfterExit(dir);
	}
	if (outcomeWritten(dir)) return false;
	let status;
	try {
		status = JSON.parse(raw);
	} catch {
		status = void 0;
	}
	if (scriptAlive(Number(status?.pid))) return true;
	const started = Number(status?.startedAt);
	if (Number.isFinite(started) && Date.now() - started <= 282e4) return true;
	try {
		rmSync(join(dir, "status.json"), { force: true });
	} catch (error) {
		console.error(`dsh-orb: could not clear the stalled install status: ${errorDetail(error)}`);
		return false;
	}
	const spec = typeof status?.spec === "string" ? status.spec : "";
	try {
		writeFileSync(join(dir, "result.json"), `${JSON.stringify({
			spec,
			ok: false,
			detail: "deferred-install-stalled"
		})}\n`);
	} catch {}
	return false;
}
/**
* Whether the folder already holds an outcome for its install. The pair `status.json` /
* `result.json` is the whole state: the script writes the status first and the outcome last,
* and the outcome outlives the status file.
* @param dir - the profile's `.dsh-orb-update` folder.
* @returns true once the install has written its result.
*/
function outcomeWritten(dir) {
	try {
		return statSync(join(dir, "result.json")).isFile();
	} catch {
		return false;
	}
}
/**
* Whether a scheduled install's owner has exited, so its script is in the ~2 s before it
* writes its status file. The script touches the job file every 500 ms while it waits, so a
* fresh job file plus a dead owner is an install about to run; a stale one is a script that
* died before pnpm ever started, which replaced nothing.
* @param dir - the profile's `.dsh-orb-update` folder.
* @returns true while the install is about to touch the package.
*/
function installPendingAfterExit(dir) {
	const file = join(dir, "job.json");
	let parentPid;
	try {
		parentPid = JSON.parse(readFileSync(file, "utf8")).parentPid;
	} catch {
		return false;
	}
	const pid = Number(parentPid);
	if (!Number.isInteger(pid) || pid <= 0 || scriptAlive(pid)) return false;
	try {
		return Date.now() - statSync(file).mtimeMs <= DEFERRED_INSTALL_PENDING_MS;
	} catch {
		return false;
	}
}
/**
* The after-exit install queued for this profile, when it is still going to run.
* The job file outlives the plugin instance that wrote it, so a page reloaded by
* a bundle toggle can still say "installs once the app quits" instead of offering
* the same update again. A finished install (result on disk) and a job whose
* script never started (stale heartbeat) are not pending.
* @param profileDir - profile that scheduled the install.
* @returns the queued spec and version, or undefined when nothing is waiting.
*/
function pendingDeferredInstall(profileDir) {
	const dir = deferredDir(profileDir);
	if (outcomeWritten(dir)) return void 0;
	const status = readDeferredStatus(dir);
	if (status !== void 0 && statusIsLive(status)) return void 0;
	const job = readDeferredJob(dir);
	if (job === void 0) return void 0;
	const pid = Number(job.parentPid);
	if (Number.isInteger(pid) && pid > 0 && scriptAlive(pid)) return {
		spec: job.spec,
		version: textField(job.version) ?? versionFromSpec(job.spec)
	};
	try {
		if (Date.now() - statSync(join(dir, "job.json")).mtimeMs > 3e4) return void 0;
	} catch {
		return;
	}
	return {
		spec: job.spec,
		version: textField(job.version) ?? versionFromSpec(job.spec)
	};
}
/** The job a {@link scheduleInstallAfterExit} call wrote, when it is readable. */
function readDeferredJob(dir) {
	try {
		const parsed = JSON.parse(readFileSync(join(dir, "job.json"), "utf8"));
		if (typeof parsed.spec !== "string" || parsed.spec === "") return void 0;
		return parsed;
	} catch {
		return;
	}
}
/** The status file of a running script, when it is readable. */
function readDeferredStatus(dir) {
	try {
		const parsed = JSON.parse(readFileSync(join(dir, "status.json"), "utf8"));
		return parsed !== null && typeof parsed === "object" ? parsed : void 0;
	} catch {
		return;
	}
}
/** A status whose script is alive, or whose start is inside the script's own ceiling. */
function statusIsLive(status) {
	if (scriptAlive(Number(status.pid))) return true;
	const started = Number(status.startedAt);
	return Number.isFinite(started) && Date.now() - started <= 282e4;
}
/** A non-empty string field, or undefined for anything else. */
function textField(value) {
	return typeof value === "string" && value !== "" ? value : void 0;
}
/** The version a `name@version` spec ends with; undefined for a URL or an unscoped path. */
function versionFromSpec(spec) {
	const at = spec.lastIndexOf("@");
	return at > 0 && at < spec.length - 1 ? spec.slice(at + 1) : void 0;
}
/** Message of an unknown error, for the log lines that must never throw. */
function errorDetail(error) {
	return error instanceof Error ? error.message : String(error);
}
/** The script's own `alive()`: a process that answers EPERM is running under another user. */
function scriptAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}
/**
* Merge `builds` into the profile's top-level `allowBuilds` mapping, the key the shipped
* pnpm 11 reads for install-script approvals (the official plugin manager writes the same
* shape: `allowBuilds: { name: true }`). An existing `false` for an approved name is set
* back to `true` — the user just approved that build. Other keys, including the release-age
* exemption, are left exactly as they are. Unfamiliar shapes are left alone: pnpm's next
* write repairs them.
* @param text - current `pnpm-workspace.yaml`, empty when the profile has none.
* @param builds - approved package names.
* @returns the updated file, or undefined when nothing needs to change.
*/
function mergeApprovedBuilds(text, builds) {
	if (builds.length === 0) return void 0;
	const lines = text.split("\n");
	let key = -1;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (line === "allowBuilds:") {
			key = index;
			break;
		}
		if (/^allowBuilds\s*:/.test(line)) return void 0;
	}
	if (key === -1) return (text === "" || text.endsWith("\n") ? text : text + "\n") + "allowBuilds:\n" + builds.map((name) => "  " + yamlScalar(name) + ": true").join("\n") + "\n";
	const kept = [];
	const values = [];
	const at = /* @__PURE__ */ new Map();
	let indent = "  ";
	let index = key + 1;
	for (; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const written = /^([ \t]+)(\S.*?)\s*:\s*([^\s#]*)\s*(?:#.*)?$/u.exec(line);
		if (written === null) break;
		indent = written[1] ?? indent;
		at.set(unquote(written[2] ?? ""), kept.length);
		values.push(written[3] ?? "");
		kept.push(line);
	}
	let changed = false;
	const added = [];
	for (const name of builds) {
		const position = at.get(name);
		if (position === void 0) {
			added.push(indent + yamlScalar(name) + ": true");
			changed = true;
			continue;
		}
		if (values[position] === "false") {
			kept[position] = indent + yamlScalar(name) + ": true";
			changed = true;
		}
	}
	if (!changed) return void 0;
	return [
		...lines.slice(0, key + 1),
		...kept,
		...added,
		...lines.slice(index)
	].join("\n");
}
/** `@` cannot start a plain YAML scalar, so a scoped name is quoted the way pnpm writes one. */
function yamlScalar(name) {
	return name.startsWith("@") ? "'" + name.replaceAll("'", "''") + "'" : name;
}
function unquote(entry) {
	const first = entry.slice(0, 1);
	const last = entry.slice(-1);
	if ((first === "'" || first === "\"") && last === first) return entry.slice(1, -1);
	return entry;
}
/**
* The detached script. Self-contained: the package it replaces may be gone by the
* time it runs. On the desktop it uses the pnpm the app ships in `resources/runtime`
* with the environment the plugin manager gives it; elsewhere (`dsh web`) the `pnpm`
* on PATH.
* The approval helpers below are embedded as their own source, so the script and the
* tested functions cannot drift apart.
*/
const APPLY_SCRIPT = `import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'

const jobFile = process.argv[2]
const dir = dirname(jobFile)
const job = JSON.parse(readFileSync(jobFile, 'utf8'))
const log = (line) => appendFileSync(join(dir, 'apply.log'), new Date().toISOString() + ' ' + line + '\\n')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/** Replace a profile file atomically: a concurrent reader never sees a half-written YAML. */
function writeAtomic(file, text) {
  const staged = file + '.dsh-orb-tmp'
  writeFileSync(staged, text)
  renameSync(staged, file)
}

${yamlScalar.toString()}

${unquote.toString()}

${mergeApprovedBuilds.toString()}

function pnpm() {
  const support = join(dirname(process.execPath), 'resources', 'runtime')
  const bundled = join(support, 'pnpm', 'bin', 'pnpm.mjs')
  if (existsSync(bundled)) {
    return {
      command: process.execPath,
      args: ['--expose-internals', bundled],
      shell: false,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
        PATH: join(support, 'bin') + delimiter + (process.env.PATH ?? ''),
      },
    }
  }
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return { command: 'pnpm', args: [], shell: process.platform === 'win32', env }
}

log('waiting for process ' + job.parentPid + ' to exit before installing ' + job.spec)
while (alive(job.parentPid)) {
  // Touch the job file while waiting: a start that finds a dead owner and a fresh job knows
  // pnpm is about to run, which closes the gap before status.json exists. A stale job means
  // this script died before pnpm started, so nothing was replaced.
  try { utimesSync(jobFile, new Date(), new Date()) } catch (error) { log('could not touch the job file: ' + String(error)) }
  await sleep(500)
}
await sleep(1500)

// The status file marks this install as running before pnpm touches the profile, so a start
// during the install knows not to load the package being replaced. It goes away with the
// outcome: the pair is the whole state, and neither half is ever read alone.
writeFileSync(join(dir, 'status.json'), JSON.stringify({ phase: 'installing', spec: job.spec, version: job.version, pid: process.pid, startedAt: Date.now() }) + '\\n')
try {
  const approved = job.approvedBuilds ?? []
  if (approved.length > 0) {
    const file = join(job.profileDir, 'pnpm-workspace.yaml')
    const before = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const after = mergeApprovedBuilds(before, approved)
    if (after !== undefined) writeAtomic(file, after)
    log('approved builds: ' + approved.join(', '))
  }
} catch (error) {
  log('could not write approved builds: ' + String(error))
}

const { command, args, shell, env } = pnpm()
const argv = [...args, 'add', job.spec, '--save-exact', '--registry=' + job.registry]
let ok = false
let detail = ''
for (let attempt = 1; attempt <= 3 && !ok; attempt += 1) {
  const run = spawnSync(command, argv, { cwd: job.profileDir, env, shell, encoding: 'utf8', windowsHide: true, timeout: 15 * 60 * 1000 })
  const output = (run.stdout ?? '') + (run.stderr ?? '') + (run.error ? String(run.error) : '')
  log('attempt ' + attempt + ' exited ' + run.status + '\\n' + output)
  ok = run.status === 0
  if (!ok) {
    detail = output.split('\\n').map((line) => line.trim()).find((line) => line.includes('ERR_PNPM_')) ?? output.trim().split('\\n').pop() ?? 'pnpm failed'
    await sleep(3000)
  }
}
writeFileSync(join(dir, 'result.json'), JSON.stringify({ spec: job.spec, ok, detail: detail.slice(0, 200) }) + '\\n')
// The outcome is on disk now, so a lock on either leftover must not take the script down:
// status.json without result.json would read as a dead install, and job.json has to go or it
// reads as a pending one until its mtime ages out.
try { rmSync(join(dir, 'status.json'), { force: true }) } catch (error) { log('could not clear the status file: ' + String(error)) }
try { rmSync(jobFile, { force: true }) } catch (error) { log('could not clear the job file: ' + String(error)) }
log(ok ? 'installed ' + job.spec : 'gave up on ' + job.spec)
`;
//#endregion
//#region src/update.ts
/**
* Update check and one-click upgrade for the installed bundle.
* The check probes the package registries — npmmirror first: it mirrors npmjs
* and answers where GitHub stalls — and falls back to the repository's GitHub
* Releases when no registry knows the package. The upgrade installs
* `name@version` through the official plugin manager, asking the registry that
* answered the check first. A bare tarball URL is not an install spec: pnpm
* 11.7 records it without `integrity` and refuses it before downloading.
*/
/** The GitHub repository that publishes plugin releases, `plugin-v<version>` tags. */
const UPDATE_REPO = "mini-yifan/dsh-orb-cordis";
/** Registry sources probed before GitHub, in order. npmmirror syncs minutes after a publish. */
const REGISTRY_BASES = ["https://registry.npmmirror.com", "https://registry.npmjs.org"];
/** Delay before the first automatic check: the official host needs the network at boot. */
const FIRST_CHECK_DELAY_MS = 2e4;
const PERIODIC_CHECK_MS = 216e5;
/** Answer a host without an updater gives: the settings page then hides the whole card. */
const EMPTY_UPDATE_STATE = {
	currentVersion: "",
	installedVersion: "",
	latestVersion: null,
	available: false,
	checking: false,
	updating: false,
	canUpdate: false,
	autoCheck: false,
	checkedAt: null,
	restartRequired: false,
	deferred: false,
	installing: false,
	error: null,
	pendingBuilds: []
};
/**
* Read the installed manifest.
* The path assumes the assembled layout: `dist/host/index.js` next to the package's
* `package.json`, which holds both in the profile's `node_modules/dsh-orb` and in a
* `link:`ed source checkout. Running from `packages/host/lib` finds nothing, so callers
* treat an unknown version as "no update UI".
*/
function ownPackage(url = import.meta.url) {
	let raw;
	try {
		raw = readFileSync(new URL("../../package.json", url), "utf8");
	} catch {
		return;
	}
	try {
		const manifest = JSON.parse(raw);
		if (typeof manifest.name !== "string" || typeof manifest.version !== "string") return void 0;
		if (manifest.name === "" || manifest.version === "") return void 0;
		return {
			name: manifest.name,
			version: manifest.version
		};
	} catch {
		return;
	}
}
/** Order two dotted versions. A prerelease sorts below the release it precedes. */
function compareVersions(left, right) {
	const a = splitVersion(left);
	const b = splitVersion(right);
	for (let index = 0; index < Math.max(a.main.length, b.main.length); index += 1) {
		const one = a.main[index] ?? 0;
		const other = b.main[index] ?? 0;
		if (one !== other) return one < other ? -1 : 1;
	}
	if (a.pre === b.pre) return 0;
	if (a.pre === "") return 1;
	if (b.pre === "") return -1;
	return comparePrerelease(a.pre, b.pre);
}
function isPluginManager(value) {
	return typeof value === "object" && value !== null && typeof value.installBundle === "function";
}
/**
* Checks the repository's latest release and runs the official installer.
* Every failure stays inside this class: the update path must never break the ball.
*/
var UpdateChecker = class {
	store;
	deps;
	own;
	installed;
	latest;
	checking = false;
	updating = false;
	error = null;
	pendingBuilds = [];
	restartRequired = false;
	/** Version handed to the after-exit install; offering it again would only queue it twice. */
	deferred = null;
	/** The after-exit script is running right now (its status file says so). */
	installing = false;
	timer;
	interval;
	/** The registry base that answered the last check; GitHub is the fallback when none did. */
	source;
	/** Distinguishes install requests issued in the same millisecond. */
	requestSerial = 0;
	constructor(deps) {
		this.deps = deps;
		this.store = deps.store;
		this.own = "own" in deps ? deps.own : ownPackage();
		this.installed = this.own?.version ?? "";
		this.latest = this.store.updateRecord().latestVersion || null;
		const remembered = this.store.updateRecord().lastError;
		if (remembered !== "") {
			if (this.latest !== null && compareVersions(this.latest, this.installed) <= 0) this.store.setUpdateRecord({ lastError: "" });
			else this.error = remembered;
		}
		this.installing = deferredInstallInProgress(this.store.dir);
		this.adoptDeferredOutcome();
	}
	/**
	* Read the outcome an after-exit install left, and refresh whether one is still running.
	* Called once at construction and again by a start that waited for the install to finish.
	*/
	adoptDeferredOutcome() {
		const outcome = takeDeferredOutcome(this.store.dir);
		this.installing = deferredInstallInProgress(this.store.dir);
		if (outcome === void 0) return;
		if (outcome.ok) {
			this.error = null;
			this.pendingBuilds = [];
			this.store.setUpdateRecord({ lastError: "" });
			return;
		}
		this.error = outcome.detail === "" ? "deferred-install-failed" : outcome.detail;
	}
	/**
	* Whether the after-exit script is installing right now, re-read so a state can never
	* latch: the outcome and the status file are written back to back, and a host that reads
	* between them would otherwise hide the update card for the rest of the session.
	* @returns true while a live install is running.
	*/
	installInProgress() {
		this.installing = deferredInstallInProgress(this.store.dir);
		return this.installing;
	}
	state() {
		const latest = this.latest;
		const installed = this.installed;
		const installing = this.installInProgress();
		return {
			currentVersion: this.own?.version ?? "",
			installedVersion: installed,
			latestVersion: latest,
			available: this.available(),
			checking: this.checking,
			updating: this.updating,
			canUpdate: this.own?.name !== "dsh-orb-mio-dev" && this.own !== void 0 && isPluginManager(this.deps.manager()),
			autoCheck: this.store.updateRecord().autoCheck,
			checkedAt: this.store.updateRecord().checkedAt || null,
			restartRequired: this.restartRequired,
			deferred: this.deferredPending(),
			installing,
			error: this.error,
			pendingBuilds: [...this.pendingBuilds]
		};
	}
	/** Version waiting to be installed, when the check found one. */
	availableVersion() {
		return this.available() ? this.latest : null;
	}
	/** Schedule the automatic checks and return the disposer. */
	start() {
		this.timer = setTimeout(() => {
			this.timer = void 0;
			this.check();
		}, FIRST_CHECK_DELAY_MS);
		this.timer.unref();
		this.interval = setInterval(() => {
			this.check();
		}, PERIODIC_CHECK_MS);
		this.interval.unref();
		return () => {
			if (this.timer !== void 0) clearTimeout(this.timer);
			if (this.interval !== void 0) clearInterval(this.interval);
			this.timer = void 0;
			this.interval = void 0;
		};
	}
	/**
	* Ask the repository's latest release for the newest published version.
	* The automatic call is throttled by {@link AUTO_CHECK_INTERVAL_MS}; `/update/check` is not.
	*/
	async check(manual = false) {
		if (this.own?.name === "dsh-orb-mio-dev") return;
		if (this.checking || this.updating || this.own === void 0) return;
		const record = this.store.updateRecord();
		if (!manual && !record.autoCheck) return;
		if (!manual && Date.now() - record.checkedAt < 36e5) return;
		this.checking = true;
		try {
			const latest = await this.fetch();
			if (latest === null) {
				this.error = this.rememberedError();
				this.store.setUpdateRecord({ checkedAt: Date.now() });
				return;
			}
			if (latest === void 0) {
				this.error = "network";
				return;
			}
			this.latest = latest;
			const updateAvailable = compareVersions(latest, this.installed) > 0;
			this.error = updateAvailable ? this.rememberedError() : null;
			if (!updateAvailable) this.pendingBuilds = [];
			const announce = updateAvailable && record.notifiedVersion !== latest;
			this.store.setUpdateRecord({
				checkedAt: Date.now(),
				latestVersion: latest,
				...updateAvailable ? {} : { lastError: "" },
				...announce ? { notifiedVersion: latest } : {}
			});
			if (announce) this.deps.notify(latest);
		} finally {
			this.checking = false;
		}
	}
	/**
	* Install the version the check found through the official plugin manager.
	* The spec is `name@version` and the registry is the one that answered the
	* check, so pnpm resolves registry metadata — including `dist.integrity` —
	* instead of a bare tarball URL. The manager owns the profile lock, the
	* download and the manifest restore.
	*
	* A manager without HMR still installs over the package that is already there.
	* With HMR (every shipped desktop profile), that call fails before pnpm with
	* `already-installed`. The upgrade then follows the manager's own rule: remove
	* the bundle, then install the same spec. The removal stops this plugin; the
	* promise that called it keeps running and issues the install.
	*
	* On Windows a package whose native addon is loaded cannot be replaced: pnpm
	* fails with EPERM after it has already deleted part of the live package.
	* When the probe finds such an addon, or pnpm fails that way anyway, the
	* install waits for the app to quit instead (see `deferred-install.ts`).
	* That path runs pnpm directly, so the HMR refusal never applies to it.
	*/
	async install(approvedBuilds) {
		const version = this.availableVersion();
		const manager = this.deps.manager();
		if (version === null || this.updating || !isPluginManager(manager) || this.own === void 0) return;
		this.updating = true;
		this.error = null;
		this.pendingBuilds = [];
		const name = this.own.name;
		const previous = this.own.version;
		try {
			this.store.setUpdateRecord({ lastError: "" });
			exemptReleaseAge(this.store.dir, name);
			const spec = installSpec(version, name);
			const registry = installRegistry(this.source);
			if (this.lockedImages().length > 0) {
				this.deferUntilExit(version, spec, registry, approvedBuilds ?? []);
				return;
			}
			const result = await this.requestInstall(manager, spec, registry, approvedBuilds);
			if (result.application === "failed" && isLockedFileFailure(result.error)) {
				this.deferUntilExit(version, spec, registry, approvedBuilds ?? []);
				return;
			}
			if (result.application === "failed" && result.error?.code === "already-installed" && typeof manager.removeBundle === "function") {
				await this.replaceInstalled(manager, name, previous, version, spec, registry, approvedBuilds);
				return;
			}
			if (result.application === "failed") {
				this.noteFailure(result);
				return;
			}
			if (result.application === "cancelled") {
				this.error = "cancelled";
				return;
			}
			this.accept(version);
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.updating = false;
		}
	}
	/**
	* Remove the installed bundle and install `spec` in its place.
	* Called only after `installBundle` refused with `already-installed`, which
	* changes nothing. The removal is what unloads this plugin; `requestInstall`
	* then runs on the manager reference captured before that unload.
	* @param manager - the manager captured before the removal.
	* @param name - package name, which is the bundle name `removeBundle` takes.
	* @param previous - version running now, installed again if the new one fails.
	* @param version - version being installed.
	* @param spec - `name@version` for {@link version}.
	* @param registry - registry the check answered from.
	* @param approvedBuilds - install scripts the settings page approved.
	*/
	async replaceInstalled(manager, name, previous, version, spec, registry, approvedBuilds) {
		const removeBundle = manager.removeBundle;
		if (removeBundle === void 0) return;
		exemptReleaseAge(this.store.dir, name);
		let removed;
		try {
			removed = await removeBundle.call(manager, name);
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
			this.rememberFailure();
			await this.reenable(manager, name);
			return;
		}
		if (removed.application === "failed" || removed.application === "cancelled") {
			if (isLockedFileFailure(removed.error)) {
				this.deferUntilExit(version, spec, registry, approvedBuilds ?? []);
				if (this.error !== null) this.rememberFailure();
				if (!removalStoppedBeforeDisable(removed.error)) await this.reenable(manager, name);
				return;
			}
			if (removed.application === "cancelled") this.error = "cancelled";
			else this.noteFailure(removed);
			if (!removalStoppedBeforeDisable(removed.error)) {
				this.rememberFailure();
				await this.reenable(manager, name);
			}
			return;
		}
		let again;
		try {
			again = await this.requestInstall(manager, spec, registry, approvedBuilds);
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
			this.rememberFailure();
			await this.restorePrevious(manager, name, previous, registry, approvedBuilds);
			return;
		}
		if (again.application === "failed" && isLockedFileFailure(again.error)) {
			this.deferUntilExit(version, spec, registry, approvedBuilds ?? []);
			return;
		}
		if (again.application === "failed" || again.application === "cancelled") {
			if (again.application === "cancelled") this.error = "cancelled";
			else this.noteFailure(again);
			this.rememberFailure();
			await this.restorePrevious(manager, name, previous, registry, approvedBuilds);
			return;
		}
		this.accept(version);
	}
	/**
	* Install the version that was running before a failed replacement.
	* `already-installed` means that package is still on disk, which is the outcome
	* the rollback wanted; any other failure leaves the bundle missing and is logged.
	*/
	async restorePrevious(manager, name, previous, registry, approvedBuilds) {
		try {
			const rolled = await this.requestInstall(manager, exactSpec(previous, name), registry, approvedBuilds);
			if (rolled.application === "failed" && rolled.error?.code !== "already-installed") console.error(`dsh-orb: restoring ${name}@${previous} failed: ${reportedInstallError(rolled.error)}`);
		} catch (error) {
			console.error(`dsh-orb: restoring ${name}@${previous} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	/** Install one spec with the bundle left enabled. */
	requestInstall(manager, spec, registry, approvedBuilds) {
		this.requestSerial += 1;
		return manager.installBundle(spec, {
			enabled: true,
			requestId: `dsh-orb-update-${Date.now()}-${this.requestSerial}`,
			registry,
			...approvedBuilds === void 0 ? {} : { approvedBuilds }
		});
	}
	/** Record a failed install on this instance. A script approval stays a distinct code. */
	noteFailure(result) {
		this.error = reportedInstallError(result.error);
		this.pendingBuilds = result.pendingBuilds === void 0 ? [] : [...result.pendingBuilds];
		if (this.pendingBuilds.length > 0) this.error = "build-blocked";
	}
	/**
	* Keep {@link noteFailure}'s message where a plugin started by the next call can read it.
	* The call that follows reloads this bundle, and the reloaded page never sees `this.error`.
	*/
	rememberFailure() {
		if (this.error !== null && this.error !== "") this.store.setUpdateRecord({ lastError: this.error });
	}
	/** The remembered upgrade failure, or nothing when the last attempt did not leave one. */
	rememberedError() {
		const remembered = this.store.updateRecord().lastError;
		return remembered === "" ? null : remembered;
	}
	/** Select the bundle again after a removal disabled it and then failed. */
	async reenable(manager, name) {
		if (typeof manager.setBundleEnabled !== "function") return;
		try {
			await manager.setBundleEnabled(name, true);
		} catch (error) {
			console.error(`dsh-orb: could not turn the bundle back on after a failed removal: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	/** The install landed. The running code is still the previous build until a restart or reload. */
	accept(version) {
		const own = this.own;
		if (own === void 0) return;
		this.installed = version;
		this.latest = version;
		this.restartRequired = compareVersions(version, own.version) !== 0;
		this.store.setUpdateRecord({
			latestVersion: version,
			notifiedVersion: version,
			checkedAt: Date.now(),
			lastError: ""
		});
	}
	setAutoCheck(enabled) {
		this.store.setUpdateRecord({ autoCheck: enabled });
	}
	available() {
		return this.own !== void 0 && this.latest !== null && !this.deferredPending() && !this.installInProgress() && compareVersions(this.latest, this.installed) > 0;
	}
	/**
	* Whether an after-exit install is queued. The job file outlives this instance,
	* so the plugin a bundle toggle reloads still hides the update button and keeps
	* showing the deferred banner instead of offering the same install again.
	* @returns true while the upgrade waits for the app to quit.
	*/
	deferredPending() {
		if (this.deferred !== null) return true;
		return pendingDeferredInstall(this.store.dir) !== void 0;
	}
	lockedImages() {
		if (this.deps.mappedImages !== void 0) return this.deps.mappedImages();
		if (process.platform !== "win32" || this.own === void 0) return [];
		if (ownPackage(import.meta.url)?.name !== this.own.name) return [];
		try {
			return mappedImages(ownPackageRoot(import.meta.url));
		} catch {
			return [];
		}
	}
	deferUntilExit(version, spec, registry, approvedBuilds) {
		const job = {
			profileDir: this.store.dir,
			spec,
			version,
			registry,
			parentPid: process.pid,
			approvedBuilds
		};
		try {
			(this.deps.deferInstall ?? scheduleInstallAfterExit)(job);
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
			return;
		}
		this.deferred = version;
		this.restartRequired = true;
	}
	async fetch() {
		const own = this.own;
		if (own === void 0) return void 0;
		if (this.deps.fetchLatest !== void 0) return this.deps.fetchLatest(own.name);
		const forced = process.env.DSH_ORB_UPDATE_LATEST?.trim();
		if (forced !== void 0 && forced !== "") return forced;
		this.source = void 0;
		for (const base of registryBases()) {
			const body = await curlText(`${base}/${own.name}/latest`);
			if (body === void 0 || body === "") continue;
			const version = versionFromRegistry(body);
			if (version === void 0) continue;
			this.source = base;
			return version;
		}
		const body = await curlText(`${apiBase()}/releases/latest`);
		if (body === void 0) return void 0;
		return versionFromRelease(body) ?? null;
	}
};
/** The API base the check asks; `DSH_ORB_UPDATE_API` re-points it (tests, mirrors). */
function apiBase() {
	const configured = process.env.DSH_ORB_UPDATE_API?.trim();
	if (configured !== void 0 && configured !== "") return configured.replace(/\/+$/, "");
	return `https://api.github.com/repos/${UPDATE_REPO}`;
}
/** The registry sources the check probes; `DSH_ORB_UPDATE_REGISTRIES` re-points them (tests, mirrors). */
function registryBases() {
	const configured = process.env.DSH_ORB_UPDATE_REGISTRIES?.trim();
	if (configured === void 0 || configured === "") return [...REGISTRY_BASES];
	return configured.split(",").map((base) => base.trim().replace(/\/+$/, "")).filter((base) => base !== "");
}
/** The version a registry's dist-tag document names: `{"version":"0.2.0"}`. */
function versionFromRegistry(body) {
	try {
		const parsed = JSON.parse(body);
		if (typeof parsed.version !== "string") return void 0;
		const version = parsed.version.trim().replace(/^v/, "");
		return version === "" ? void 0 : version;
	} catch {
		return;
	}
}
/**
* The spec the installer receives.
* `name@version` makes pnpm read `dist.integrity` from registry metadata.
* pnpm 11.7 (the version the official client bundles) rejects a bare tarball
* URL whose lockfile entry has no integrity, before it downloads the file
* (`ERR_PNPM_MISSING_TARBALL_INTEGRITY`). `DSH_ORB_UPDATE_URL` overrides the
* whole spec (tests, staged releases).
*/
function installSpec(version, name) {
	const overridden = process.env.DSH_ORB_UPDATE_URL?.trim();
	if (overridden !== void 0 && overridden !== "") return overridden;
	return exactSpec(version, name);
}
/**
* `name@version`, ignoring the staged-update override. A rollback must restore the
* version that was running, not whatever `DSH_ORB_UPDATE_URL` points at.
*/
function exactSpec(version, name) {
	return `${name}@${version.trim().replace(/^v/, "")}`;
}
/**
* Registry the manager should ask first: the one that answered the check, or
* the primary mirror when this process has not checked yet. The manager still
* falls through to its own list when this registry is one of them.
*/
function installRegistry(source) {
	return source ?? REGISTRY_BASES[0] ?? "https://registry.npmmirror.com";
}
/**
* Text for a failed install. A specific manager code (incompatible version,
* and so on) wins. `operation-error` is the manager's wrapper around a pnpm
* failure, so the card shows the `ERR_PNPM_*` line from the diagnostic instead
* of that wrapper.
*/
function reportedInstallError(error) {
	const code = error?.code;
	const lines = error?.diagnostic?.split("\n").map((line) => line.trim()).filter((line) => line !== "") ?? [];
	if (code !== void 0 && code !== "" && code !== "operation-error") return code;
	const detail = lines.find((line) => line.includes("ERR_PNPM_")) ?? lines[0];
	if (detail !== void 0 && detail !== "") return detail.slice(0, 200);
	return code === void 0 || code === "" ? "operation-error" : code;
}
/** A pnpm failure from replacing a package whose files Windows keeps locked. */
function isLockedFileFailure(error) {
	const text = `${error?.code ?? ""}\n${error?.diagnostic ?? ""}`;
	return /ERR_PNPM_EPERM|ERR_PNPM_EBUSY|\bEPERM\b|\bEBUSY\b/.test(text);
}
/**
* A removal that failed before it deselected the bundle.
* `not-removable` and `stop-profile` are decided before `selectBundle(false)`.
* Anything later has already turned the bundle off, and leaving it that way
* hides the ball until something selects it again.
* @param error - the removal's error.
* @returns true when the bundle is still selected.
*/
function removalStoppedBeforeDisable(error) {
	return error?.code === "not-removable" || error?.code === "stop-profile";
}
/**
* Record the package as an explicit exemption from pnpm's minimum-release-age
* gate. pnpm v11 defaults `minimumReleaseAge` to 24 hours, so a registry-named
* resolution silently settles for an older version while a fresh release waits
* out the cutoff (observed 2026-10-06: `dsh-orb` resolved to 0.1.1 everywhere
* the hour after 0.1.2 shipped), and the manager's install pipeline verifies the
* lockfile against the gate before pnpm's own auto-exemption can apply. The
* entry is the bare package name — pnpm grants it to every version, and unlike
* exact `name@version` entries it passes the lockfile verification path
* reliably (observed: versioned entries still failed verification). The write
* puts that name first among its own rules, because pnpm honours only the first
* one (see `withReleaseAgeExclusion`).
*
* Called twice: once when the plugin starts, so the profile reads correctly
* whatever route installed the version (pnpm's own auto-exemption appends a
* `name@version` rule that an older rule shadows), and once before an update
* installs. Best-effort: an unreadable or unexpected file skips the write, and
* the caller proceeds on pnpm's own defaults.
*/
function exemptReleaseAge(profileDir, name) {
	const file = join(profileDir, "pnpm-workspace.yaml");
	let next;
	try {
		next = withReleaseAgeExclusion(readFileSync(file, "utf8"), name);
	} catch {
		return;
	}
	if (next === void 0) return;
	try {
		writeProfileFile(file, next);
	} catch (error) {
		console.error(`dsh-orb: could not write the release-age exemption into ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
/**
* Replace a profile file atomically. The after-exit install script writes the same
* `pnpm-workspace.yaml` (its build approvals), and a plain write would let a concurrent
* reader — or pnpm itself — see a truncated document.
*
* Windows refuses to replace a file another process is holding — pnpm itself, OneDrive, a
* scanner — with EPERM/EACCES/EBUSY, and the holder is normally gone within a moment, so the
* rename is retried. The staged file never survives a failure: leaving it behind would put a
* second copy of the profile's workspace file next to the real one.
* @param file - absolute path of the profile file.
* @param text - complete new contents.
*/
function writeProfileFile(file, text) {
	const staged = `${file}.dsh-orb-tmp`;
	writeFileSync(staged, text);
	try {
		renameWithRetry(staged, file);
	} catch (error) {
		rmSync(staged, { force: true });
		throw error;
	}
}
/** Attempts, and the pause before each one, for a rename the system may be refusing for now. */
const PROFILE_RENAME_ATTEMPTS = 5;
const PROFILE_RENAME_BACKOFF_MS = 50;
/**
* Rename with a short retry, for the destinations Windows can refuse while another process
* holds them. Exported so the retry can be exercised without a real lock.
* @param from - staged path.
* @param to - destination path.
* @param rename - the rename to perform; tests inject one that refuses.
* @throws the last rename error once every attempt is used.
*/
function renameWithRetry(from, to, rename = renameSync) {
	for (let attempt = 1;; attempt += 1) try {
		rename(from, to);
		return;
	} catch (error) {
		if (attempt >= PROFILE_RENAME_ATTEMPTS) throw error;
		sleepSync(PROFILE_RENAME_BACKOFF_MS * attempt);
	}
}
function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
/** The package an exemption entry names, with any version or version union dropped. */
function excludedPackageName(entry) {
	const at = entry.startsWith("@") ? entry.indexOf("@", 1) : entry.indexOf("@");
	return at === -1 ? entry : entry.slice(0, at);
}
/**
* Write the package's exemption as the first entry of the profile's
* `minimumReleaseAgeExclude` block, replacing whatever rules the file already
* carried for the same name.
*
* pnpm's `evaluateVersionPolicy` returns at the FIRST rule whose package name
* matches, so a rule only counts when nothing of the same name precedes it
* (pnpm #732). Appending the bare name — what this used to do — is therefore
* dead the moment any `name@version` rule sits earlier, and pnpm appends such a
* rule for every young version it installs, so the file grows one shadowing
* entry per release. The result is a profile where the package is not actually
* exempt: `pnpm remove` re-resolves the young dependency, produces a
* resolution-policy violation, and aborts with
* `ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED` (its remove path never wires
* the violation callback), which blocks uninstalling ANY other plugin until the
* version ages past the cutoff.
*
* A bare name exempts every version, so the same-name `name@version` rules a
* profile collected are dropped instead of being left to shadow it later, and
* the bare entry is written first. Other packages' lines keep their order and
* spelling. Returns the new text, or undefined when the file already reads that
* way or is not the block list pnpm writes.
*/
function withReleaseAgeExclusion(text, name) {
	if (name === "") return void 0;
	const lines = text.split("\n");
	let key = -1;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (line === "minimumReleaseAgeExclude:") {
			key = index;
			break;
		}
		if (/^minimumReleaseAgeExclude\s*:/.test(line)) return void 0;
	}
	const entry = name.startsWith("@") ? `'${name.replaceAll("'", "''")}'` : name;
	if (key === -1) return `${text === "" || text.endsWith("\n") ? text : `${text}\n`}minimumReleaseAgeExclude:\n  - ${entry}\n`;
	const kept = [];
	let indent;
	let seen = 0;
	let bareFirst = false;
	let index = key + 1;
	for (; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const written = /^([ \t]+)-[ \t]+\S/.exec(line);
		if (written === null) break;
		indent ??= written[1];
		const body = line.slice(line.indexOf("-") + 1).trim().replace(/^['"]|['"]$/g, "");
		if (excludedPackageName(body) === name) {
			if (seen === 0) bareFirst = body === name;
			seen += 1;
			indent = written[1] ?? indent;
			continue;
		}
		kept.push(line);
	}
	if (bareFirst && seen === 1) return void 0;
	const updated = [
		...lines.slice(0, key + 1),
		`${indent ?? "  "}- ${entry}`,
		...kept,
		...lines.slice(index)
	].join("\n");
	return updated === text ? void 0 : updated;
}
/** The version a release names: `plugin-v0.2.0` → `0.2.0`. */
function versionFromRelease(body) {
	try {
		const parsed = JSON.parse(body);
		if (typeof parsed.tag_name !== "string") return void 0;
		const version = parsed.tag_name.trim().replace(/^plugin-v/, "");
		return version === "" ? void 0 : version;
	} catch {
		return;
	}
}
function splitVersion(value) {
	const trimmed = value.trim().replace(/^v/, "");
	const dash = trimmed.indexOf("-");
	const head = dash === -1 ? trimmed : trimmed.slice(0, dash);
	const pre = dash === -1 ? "" : trimmed.slice(dash + 1);
	return {
		main: head.split(".").map((part) => {
			const parsed = Number.parseInt(part, 10);
			return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
		}),
		pre
	};
}
function comparePrerelease(left, right) {
	const a = left.split(".");
	const b = right.split(".");
	for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
		const one = a[index];
		const other = b[index];
		if (one === void 0) return -1;
		if (other === void 0) return 1;
		if (one === other) continue;
		const oneNumber = /^\d+$/.test(one) ? Number.parseInt(one, 10) : void 0;
		const otherNumber = /^\d+$/.test(other) ? Number.parseInt(other, 10) : void 0;
		if (oneNumber !== void 0 && otherNumber !== void 0) return oneNumber < otherNumber ? -1 : 1;
		if (oneNumber !== void 0) return -1;
		if (otherNumber !== void 0) return 1;
		return one < other ? -1 : 1;
	}
	return 0;
}
/**
* Fetch a plain-text body. HTTPS answers are pinned to https end to end; a
* plain-http address (the local mock) keeps its scheme so the loopback works.
* Resolves `''` when the server answers 404, `undefined` when the transfer
* fails or answers with another non-2xx status.
*/
async function curlText(url) {
	const proto = url.startsWith("https://") ? [
		"--proto",
		"=https",
		"--proto-redir",
		"=https"
	] : [];
	const tls = process.platform === "win32" ? ["--ssl-no-revoke"] : [];
	return new Promise((resolve) => {
		const child = spawn("curl", [
			"-sSL",
			...proto,
			...tls,
			"--connect-timeout",
			"5",
			"--max-time",
			"15",
			"-w",
			"\n%{http_code}",
			url
		], { stdio: [
			"ignore",
			"pipe",
			"pipe"
		] });
		const out = [];
		child.stdout.on("data", (chunk) => out.push(chunk));
		child.stderr.resume();
		child.once("error", () => {
			resolve(void 0);
		});
		child.once("exit", (code) => {
			if (code !== 0) return resolve(void 0);
			const text = Buffer.concat(out).toString("utf8");
			const cut = text.lastIndexOf("\n");
			const status = cut === -1 ? "" : text.slice(cut + 1).trim();
			const body = cut === -1 ? "" : text.slice(0, cut);
			if (status === "404") return resolve("");
			resolve(status.startsWith("2") ? body : void 0);
		});
	});
}
//#endregion
//#region src/orb.ts
/**
* NDJSON control plane for the ball, plus the Computer Use session it talks to.
* The helper never calls the official HTTP API. Messages arrive here and this process calls the host services.
*/
/** Cordis service name of {@link AgentBookmarkRegistry}. */
const CODE_AGENT_REGISTRY = "codeAgentRegistry";
/**
* Backoff before the first-run runtime download is retried; the last entry is
* the self-heal attempt. One dropped connection must not cost the user the ball
* until they find the toggle.
*/
const RUNTIME_RETRY_DELAYS_MS = [
	5e3,
	3e4,
	12e4
];
/** Same shape for a helper that exits right after launch; the last entry self-heals. */
const HELPER_RETRY_DELAYS_MS = [
	500,
	2e3,
	1e4,
	3e5
];
/** Strip poll cadence; the helper ticks elapsed clocks itself. */
const AGENT_POLL_MS = 1e3;
/** How long a ball-initiated main-window target (session jump, settings) stays valid: long enough for a cold app launch. */
const MAIN_WINDOW_TARGET_TTL_MS = 3e4;
/** Caller conversations cycle through this many attribution colors. */
const AGENT_COLOR_COUNT = 4;
/**
* Where the profile records that the empty conversations the old New Chat button left behind
* have been swept. One pass per profile, written only once the pass actually ran.
*/
const BLANK_SWEEP_FILE = "blank-sweep.json";
/** Let the first start settle before sweeping, so the conversation on screen is already known. */
const BLANK_SWEEP_DELAY_MS = 15e3;
/** One host lifetime of the ball: socket, helper process, and one Computer Use session. */
var OrbRuntime = class {
	ctx;
	store;
	token = randomBytes(32).toString("hex");
	sessionFile = dshHomePath("dsh-orb", "floating-session.json");
	server;
	port = 0;
	sockets = /* @__PURE__ */ new Set();
	buffers = /* @__PURE__ */ new Map();
	blocks = /* @__PURE__ */ new Map();
	blockOrder = [];
	pending;
	questionBody;
	turnRunning = false;
	turnInterrupted = false;
	/** Bumped every time a turn starts; stopTurn uses it to spot a turn that replaced its own. */
	turnEpoch = 0;
	/** The old turn is being stopped; send this text as a new task after its turn/end. */
	pendingPrompt;
	/** Pending lasso screenshots waiting for their instruction. */
	lasso;
	/** The signed-in account's recharge balance, read only while the satellite asks for it. */
	balance;
	balanceTimer;
	/** The user block a lasso observation's thumbnail belongs to. */
	lastUserBlockKey;
	/** Steps whose first tool-call delta already told voice that the preceding text was mid-turn. */
	toolVoiceSteps = /* @__PURE__ */ new Set();
	/**
	* The translation currently streaming into the ball, if any.
	*
	* A translation is shown exactly like an agent turn but is not one: it never touches the
	* session, so `turnRunning` must stay false while it runs. The ball still gets a
	* `turn: true` broadcast, and the completion wait that guards real turns does not apply —
	* nothing is queued behind a translation, so there is nothing to serialise.
	*/
	translation;
	/**
	* Bumped whenever the transcript is thrown away. A translation belongs to the transcript it
	* was rendered into, so one that outlives a reset must not settle its block into the new,
	* empty transcript — `abort()` only asks the stream to stop; the settle still runs after it.
	*/
	transcriptEpoch = 0;
	child;
	binary = "";
	failures = 0;
	halted = false;
	generation = 0;
	replaying = false;
	workspaceTask;
	retry;
	opening = false;
	pendingStart = false;
	helperError;
	/** 'downloading'/'extracting' while the helper runtime is prepared; '' otherwise. */
	runtimePhase = "";
	/**
	* True from the moment a runtime download is asked for until it lands or its budget is spent.
	* The waiting phase is only ever a promise this flag backs: while it is set, a `start()` that
	* merely relaunches must not blank the phase the settings page is polling on.
	*/
	runtimePending = false;
	runtimeRetries = 0;
	userData = "";
	/** Newer version waiting to be installed, or null once none is known. */
	updateAvailable = null;
	idleWarned = false;
	sessionId;
	sessionError;
	creating;
	watermark = 0;
	missingLogged = false;
	timer;
	giveUp;
	agentTimer;
	lastAgentsPayload = "";
	/**
	* Sessions whose *finished* bookmark the user clicked away. A running stretch is never in here:
	* a click during the run only jumps to the session, so the completion still raises an unread
	* bookmark. {@link agentItems} drops the id the moment that session runs again, which is what
	* gives a continued session a fresh unread bookmark for its next stretch.
	*/
	readAgentIds = /* @__PURE__ */ new Set();
	jumpTarget;
	/** One-shot "open the ball's own settings page" request for the main window's client plugin. */
	settingsTarget;
	callerColors = /* @__PURE__ */ new Map();
	callerTitles;
	callerTitlesTask;
	dirty = /* @__PURE__ */ new Set();
	dirtyTimer;
	/** Chunk frames carry no turn/step; only the attempt's start frame does. */
	attemptPositions = /* @__PURE__ */ new Map();
	lastAttemptByStep = /* @__PURE__ */ new Map();
	/** Transient block keys one streaming step created, in creation order. */
	stepBlocks = /* @__PURE__ */ new Map();
	liveStep;
	orphanFrameLogged = false;
	/** Keys of the newest settled assistant message: the turn's final answer so far. */
	responseKeys = [];
	helperPid;
	appearance = {};
	/** Set by the plugin entry; the settings routes and the ball menu both drive it. */
	updater;
	/** Retention for the floating-ball workspace history; routes and scheduling delegate here. */
	history;
	overlayWaiters = /* @__PURE__ */ new Map();
	/** Chrome window ids each helper reported, keyed by its socket. */
	chromeWindows = /* @__PURE__ */ new Map();
	tcc;
	selection;
	overlay = createOverlayGuard({
		hasHelper: () => this.sockets.size > 0,
		send: (message, signal) => this.waitAck(message, signal),
		setHidInput: (active) => {
			this.selection.setHidInput(active);
		},
		chromeWindowIds: () => this.chromeWindowIds(),
		observationFrameEnabled: () => this.store.observationFrameEnabled()
	});
	/** Wake, command, and speech. The child stays down until this install has one. */
	voice;
	voiceDownloads;
	/**
	* Windows only. Clicking the ball makes it the system foreground window, so the window
	* the user was actually working in is remembered and handed back on submit.
	*/
	foreground = createForegroundMemory({ chromeWindowIds: () => this.chromeWindowIds() });
	constructor(ctx, store, options = {}) {
		this.ctx = ctx;
		this.store = store;
		this.tcc = options.tcc ?? new TccMonitor();
		const access = productionAccessibility();
		this.selection = new SelectionController({
			enabled: () => this.store.selectionEnabled(),
			language: () => this.store.translateLanguage(),
			setLanguage: (language) => {
				this.store.setTranslateLanguage(language);
				this.broadcast({
					type: "selection-language",
					language
				});
			},
			helperConnected: () => this.sockets.size > 0,
			helperPid: () => this.helperPid,
			show: (payload) => {
				this.broadcast({
					type: "selection",
					...payload
				});
			},
			hide: () => {
				this.broadcast({ type: "selection-hide" });
			},
			pointer: (x, y) => {
				this.broadcast({
					type: "selection-pointer",
					x,
					y
				});
			},
			attach: (text) => {
				this.broadcast({
					type: "selection-attach",
					text
				});
			},
			translate: (text, language) => {
				this.run("translate", () => this.startTranslation(text, language));
			},
			openExternal: (url) => {
				openSystemUrl(url);
			},
			requestAccessibility: () => access.requestAccessibility(),
			accessibilityTrusted: () => access.accessibilityTrusted(),
			now: () => Date.now()
		}, options.startMonitor);
		this.history = new HistoryCleaner({
			store: this.store,
			workspacePath: () => this.store.workspaceDirectory(),
			currentSession: () => this.sessionId,
			listSessions: () => this.listHistoryRows(),
			isAttached: (id) => this.ctx.sessions.get(id) !== void 0,
			workspaceSafety: () => readWorkspaceSafety(this.ctx),
			archive: (id) => archiveHistorySession(this.ctx, id),
			unarchive: (id) => unarchiveHistorySession(this.ctx, id),
			persistence: () => historyPersistence(this.ctx),
			available: () => historyAvailable(this.ctx),
			sessionsRoot: dshHomePath("sessions"),
			objectsRoot: dshHomePath("attachments", "v1", "objects"),
			trash: (path) => moveToOsTrash(path),
			log: (message) => console.error(`dsh-orb: ${message}`)
		});
		ctx.provide("computerUseOverlayGuard", this.overlay);
		this.balance = new BalanceMonitor({
			account: () => this.ctx.get("deepseekAccount"),
			client: () => ({
				version: "0.0.0",
				locale: this.appearance.locale === "en" ? "en-US" : "zh-CN",
				timezoneOffsetSeconds: -(/* @__PURE__ */ new Date()).getTimezoneOffset() * 60
			}),
			log: (message) => console.error(`dsh-orb: ${message}`)
		});
		this.lasso = new LassoController({
			capture: () => this.ctx.get("computerUseLassoCapture"),
			attachments: () => this.ctx.get("attachments"),
			seed: () => this.ctx.get("computerUseLassoSeed"),
			broadcast: (message) => {
				this.broadcast(message);
			},
			status: (text) => {
				this.status(text);
			},
			currentSessionId: () => this.sessionId,
			translate: (image) => {
				this.run("translate", () => this.startImageTranslation(image));
			},
			now: () => Date.now()
		});
		this.voice = new VoiceController({
			settings: () => this.store.voice(),
			presence: () => voicePresence({
				kws: dshHomePath("dsh-orb", "voice", "kws"),
				asr: dshHomePath("speech-to-text", "sensevoice"),
				tts: dshHomePath("dsh-orb", "voice", "tts")
			}),
			now: () => Date.now(),
			paths: () => ({
				kws: dshHomePath("dsh-orb", "voice", "kws"),
				asrModel: dshHomePath("speech-to-text", "sensevoice", "models", "sensevoice-onnx", "model.int8.onnx"),
				asrTokens: dshHomePath("speech-to-text", "sensevoice", "models", "sensevoice-onnx", "tokens.txt"),
				asrVad: dshHomePath("speech-to-text", "sensevoice", "models", "silero", "silero_vad.onnx"),
				tts: dshHomePath("dsh-orb", "voice", "tts")
			}),
			send: (message) => this.broadcast(message),
			open: () => openVoiceChild(),
			interject: (text) => {
				this.onInterject(text);
			},
			stopTurn: () => {
				if (!this.turnRunning) return;
				const epoch = this.turnEpoch;
				this.run("stop", () => this.stopTurn(epoch));
			}
		});
		this.voiceDownloads = new VoiceDownloads(() => ({
			kws: dshHomePath("dsh-orb", "voice", "kws"),
			asr: dshHomePath("speech-to-text", "sensevoice"),
			tts: dshHomePath("dsh-orb", "voice", "tts")
		}), void 0, () => {
			this.voice.applySettings();
		}, () => officialAsrFrom(this.ctx.get("speechToText")));
		this.listenAssistantStream();
	}
	/**
	* Follow the loop's process-local assistant stream so text, thinking, and tool
	* calls reach the ball while the model is still producing them. The durable
	* log only records the settled message, which is what the 400 ms poll sees.
	*/
	listenAssistantStream() {
		try {
			this.ctx.on("agent/assistant-stream", (payload) => this.onAssistantStream(payload), { global: true });
		} catch (error) {
			console.error(`dsh-orb: assistant stream unavailable: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	onAssistantStream(payload) {
		if (this.sessionId === void 0) return;
		const record = asRecord(payload);
		if (asRecord(asRecord(record?.agent)?.session)?.id !== this.sessionId) return;
		const frame = asRecord(record?.frame);
		if (!frame) return;
		const attemptId = typeof frame.attemptId === "string" ? frame.attemptId : "";
		if (frame.type === "start") {
			if (attemptId === "") return;
			const turn = numberOf(frame.turn);
			const step = numberOf(frame.step);
			this.attemptPositions.set(attemptId, {
				turn,
				step
			});
			const stepKey = `${turn}:${step}`;
			const previous = this.lastAttemptByStep.get(stepKey);
			this.lastAttemptByStep.set(stepKey, attemptId);
			if (previous !== void 0 && previous !== attemptId) {
				this.attemptPositions.delete(previous);
				this.rewindLiveStep(turn, step);
			}
			return;
		}
		if (frame.type === "end") {
			this.attemptPositions.delete(attemptId);
			return;
		}
		if (frame.type !== "chunk") return;
		const position = this.attemptPositions.get(attemptId);
		if (position === void 0) {
			if (!this.orphanFrameLogged) {
				this.orphanFrameLogged = true;
				console.error("dsh-orb: assistant stream chunk arrived without its start frame");
			}
			return;
		}
		if (!asRecord(frame.chunk)) return;
		this.onChunk({
			turn: position.turn,
			step: position.step,
			chunk: frame.chunk
		});
	}
	/** A new attempt supersedes the dead one: drop its transient blocks so the retry streams into a clean slate. */
	rewindLiveStep(turn, step) {
		const tracked = this.stepBlocks.get(`${turn}:${step}`);
		if (!tracked) return;
		this.stepBlocks.delete(`${turn}:${step}`);
		for (const key of tracked) this.dropBlock(key);
	}
	/** Open the socket, prepare a session, and spawn the helper. A halted ball can start again. */
	async start() {
		if (process.platform === "linux") return;
		this.halted = false;
		this.failures = 0;
		this.helperError = void 0;
		if (!this.runtimePending) this.runtimePhase = "";
		if (this.child !== void 0 && this.child.exitCode === null && this.child.signalCode === null && this.server) return;
		if (this.retry) clearTimeout(this.retry);
		this.retry = void 0;
		if (this.opening) {
			this.generation += 1;
			this.pendingStart = true;
			return;
		}
		this.opening = true;
		this.generation += 1;
		const generation = this.generation;
		try {
			await this.begin(generation);
		} finally {
			this.opening = false;
			if (this.pendingStart) {
				this.pendingStart = false;
				if (!this.halted) await this.start();
			}
		}
	}
	/** The voice settings file changed. */
	applyVoiceSettings() {
		this.voice.applySettings();
	}
	/** What the settings page shows under each download button. */
	voiceModels() {
		return this.voiceDownloads.view();
	}
	/** Start a model download, or say the files are already current. */
	downloadVoiceModel(kind) {
		return this.voiceDownloads.begin(kind);
	}
	/** Null until the voice child has reported whether the microphone opened. */
	voiceMic() {
		return this.voice.microphone();
	}
	/** Short code the settings page can show after the helper gives up. */
	helperStatus() {
		return this.helperError ?? "";
	}
	/** What the runtime preparation is busy with, for the settings page's waiting line. */
	helperPhase() {
		return this.runtimePhase;
	}
	/**
	* The first-run runtime download retried with backoff. While attempts remain
	* the phase stays on screen; only a spent budget surfaces the failure.
	*/
	async beginRuntime(generation) {
		this.runtimePending = true;
		try {
			this.binary = await resolveElectronBinary((phase) => {
				this.runtimePhase = phase;
			});
			this.runtimePhase = "";
			this.runtimePending = false;
			this.runtimeRetries = 0;
			return true;
		} catch (error) {
			if (isRuntimeDownloadCancelled(error)) {
				this.runtimeRetries = 0;
				return false;
			}
			const message = error instanceof Error ? error.message : String(error);
			console.error(`dsh-orb: ${message}`);
			this.runtimeRetries += 1;
			const delay = RUNTIME_RETRY_DELAYS_MS[this.runtimeRetries - 1];
			if (delay !== void 0 && !this.halted && generation === this.generation) {
				this.runtimePhase = "downloading";
				console.error(`dsh-orb: retrying the runtime download in ${Math.round(delay / 1e3)}s`);
				this.retry = setTimeout(() => {
					this.retry = void 0;
					this.start().catch((error) => {
						console.error(`dsh-orb: ${error instanceof Error ? error.message : String(error)}`);
					});
				}, delay);
				this.retry.unref();
				return false;
			}
			this.runtimePhase = "";
			this.runtimePending = false;
			this.helperError = "runtime-download";
			this.server?.close();
			this.server = void 0;
			return false;
		}
	}
	async begin(generation) {
		if (!this.server) await this.listen();
		if (this.halted || generation !== this.generation) {
			this.server?.close();
			this.server = void 0;
			return;
		}
		console.error(`dsh-orb: helper socket 127.0.0.1:${this.port}`);
		this.startPolls();
		const sessionTask = this.ensureSession().catch((error) => {
			this.sessionError = error instanceof Error ? error.message : String(error);
			console.error(`dsh-orb: session setup failed: ${this.sessionError}`);
		});
		if (!await this.beginRuntime(generation)) return;
		await sessionTask;
		if (this.halted || generation !== this.generation) return;
		this.userData = helperDataDirectory(this.store.dir);
		await mkdir(this.userData, { recursive: true });
		this.launch();
		this.voice.start({
			agentBusy: this.turnRunning,
			questionOpen: this.pending !== void 0
		});
	}
	/**
	* Open the control socket without spawning the helper.
	* {@link start} listens and then launches the helper process.
	*/
	async bind() {
		if (!this.server) await this.listen();
		this.startPolls();
		return {
			port: this.port,
			token: this.token
		};
	}
	/** Stop the helper and the socket. Settings can call {@link start} again. */
	halt() {
		this.generation += 1;
		this.halted = true;
		this.pendingStart = false;
		this.runtimePhase = "";
		this.runtimePending = false;
		if (this.retry) clearTimeout(this.retry);
		this.retry = void 0;
		this.stopWatch();
		this.stopAgentPoll();
		this.stopBalancePoll();
		this.clearDirty();
		this.handQuestionBack();
		this.server?.close();
		this.server = void 0;
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		this.buffers.clear();
		this.chromeWindows.clear();
		this.helperPid = void 0;
		this.overlayWaiters.clear();
		this.jumpTarget = void 0;
		this.settingsTarget = void 0;
		this.selection.stop();
		this.voice.close();
		this.foreground.stop();
		this.killChild();
		publishScreenOwner(void 0);
	}
	/** Claim questions for this orb session. Register this while the plugin fiber is active. */
	attachQuestions() {
		try {
			const dispose = this.ctx.on("user-questions/request", (request, next) => this.onQuestion(request, next), { prepend: true });
			return typeof dispose === "function" ? dispose : () => {};
		} catch (error) {
			console.error(`dsh-orb: question listener failed: ${error instanceof Error ? error.message : String(error)}`);
			return () => {};
		}
	}
	async listen() {
		const server = createServer((socket) => {
			this.handle(socket);
		});
		this.server = server;
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => resolve());
		});
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("dsh-orb: helper socket has no port");
		this.port = address.port;
	}
	handle(socket) {
		socket.setEncoding("utf8");
		let authed = false;
		const timer = setTimeout(() => {
			if (!authed) socket.destroy();
		}, 3e3);
		timer.unref();
		socket.on("data", (chunk) => {
			const next = `${this.buffers.get(socket) ?? ""}${chunk}`;
			if (next.length > 1e6) {
				socket.destroy();
				return;
			}
			const parts = next.split("\n");
			this.buffers.set(socket, parts.pop() ?? "");
			for (const part of parts) {
				if (!part.trim()) continue;
				let message;
				try {
					message = JSON.parse(part);
				} catch {
					socket.destroy();
					return;
				}
				if (!authed) {
					if (!this.helloOk(message)) {
						socket.destroy();
						return;
					}
					authed = true;
					clearTimeout(timer);
					this.accept(socket, message);
					continue;
				}
				if (isPrompt(message)) this.onPrompt(message.text, message.lassoId);
				else if (isQuestionAnswer(message)) this.onQuestionAnswer(message.id, message.answers);
				else if (isQuestionCancel(message)) this.onQuestionCancel(message.id);
				else this.onControl(message, socket);
			}
		});
		socket.on("close", () => {
			this.sockets.delete(socket);
			this.buffers.delete(socket);
			this.chromeWindows.delete(socket);
			if (this.sockets.size === 0) {
				this.voice.setPinned(false);
				this.handQuestionBack();
				this.helperPid = void 0;
				this.selection.stop();
				this.foreground.stop();
			}
		});
		socket.on("error", () => {
			socket.destroy();
		});
	}
	helloOk(message) {
		if (typeof message !== "object" || message === null) return false;
		const record = message;
		if (record.type !== "hello" || typeof record.token !== "string") return false;
		const given = Buffer.from(record.token);
		const expected = Buffer.from(this.token);
		return given.length === expected.length && timingSafeEqual(given, expected);
	}
	accept(socket, hello) {
		const pid = asRecord(hello)?.pid;
		if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) this.helperPid = pid;
		this.sockets.add(socket);
		if (this.store.lassoSatellite().enabled && this.store.lassoBall().balance) {
			this.startBalancePoll();
			this.refreshBalance();
		}
		if (this.sessionId) this.send(socket, {
			type: "session",
			sessionId: this.sessionId
		});
		if (this.blockOrder.length === 0 && this.sessionId) {
			this.replaying = true;
			this.drain();
			this.replaying = false;
		} else for (const key of this.blockOrder) {
			const block = this.blocks.get(key);
			if (block) this.send(socket, block);
		}
		this.send(socket, {
			type: "turn",
			running: this.turnRunning
		});
		this.send(socket, {
			type: "voice-hold",
			hold: this.voice.holdState()
		});
		this.send(socket, {
			type: "voice-mode",
			mode: this.voice.listenMode()
		});
		this.send(socket, {
			type: "voice-level",
			value: 0
		});
		this.send(socket, {
			type: "voice-speech",
			open: this.voice.speaking()
		});
		if (Object.keys(this.appearance).length > 0) this.send(socket, {
			type: "appearance",
			...this.appearance
		});
		if (this.pending) this.send(socket, this.questionPayload(this.pending.id));
		this.publishChrome();
		this.selection.sync();
		this.foreground.start();
		this.pollAgents(true);
	}
	async onPrompt(text, lassoId) {
		this.memoryTasks?.abort();
		const trimmed = text.trim();
		if (!trimmed) return;
		const key = `user:${randomUUID()}`;
		this.lastUserBlockKey = key;
		this.block(key, "user", trimmed, false, "set");
		try {
			const routed = await this.observationWatch?.preparePrompt?.(trimmed, lassoId);
			if (this.lastUserBlockKey !== key) return;
			if (routed) return await this.preempt(routed, key, lassoId);
		} catch (error) {
			this.block(`watch-route:${key}`, "assistant", `陪伴请求未提交：${error?.message ?? error}`, false, "set", void 0, void 0, { local: true });
			return;
		}
		if (this.observationWatch?.handles(trimmed)) {
			try {
				const reply = await this.observationWatch.control(trimmed, lassoId);
				if (reply) this.block(`watch-control:${key}`, "assistant", reply, false, "set", void 0, void 0, { local: true });
			} catch (error) {
				console.error(`orb-watch: ${error?.message ?? error}`);
				this.block(`watch-control:${key}`, "assistant", "陪伴操作未完成，请发送“陪伴状态”后重试。", false, "set", void 0, void 0, { local: true });
			}
			return;
		}
		await this.observationWatch?.beforePrompt();
		const memory = this.ctx.get("orbMemory");
		memory?.abortRecall?.();
		if (memory?.handles(trimmed)) {
			try {
				const reply = lassoId !== void 0 ? "请单独发送纯文本记忆命令，不附带圈选截图。" : await memory.control(trimmed, await this.ensureSession(), key);
				this.block(`memory:${key}`, "assistant", reply, false, "set");
			} catch {
				this.block(`memory:${key}`, "assistant", "记忆服务暂不可用，本次操作未完成。", false, "set");
			}
			return;
		}
		if (lassoId === void 0 && !this.turnRunning && memory?.isMemoryQuestion?.(trimmed)) {
			const sessionId = await this.ensureSession();
			if (this.lastUserBlockKey !== key) return;
			const epoch = this.transcriptEpoch;
			let waiting = false;
			const answer = await memory.answerRecall(trimmed, sessionId, () => {
				if (this.lastUserBlockKey !== key || this.sessionId !== sessionId || this.transcriptEpoch !== epoch) return;
				waiting = true;
				this.block(`memory-answer:${key}`, "assistant", "正在查询有效记忆，首次检索可能需要约一分钟…", false, "set");
			});
			if (this.sessionId !== sessionId || this.transcriptEpoch !== epoch) return;
			if (this.lastUserBlockKey !== key) {
				if (waiting) this.block(`memory-answer:${key}`, "assistant", "本次记忆查询已取消。", false, "set");
				return;
			}
			if (answer !== null) {
				if (answer || waiting) this.block(`memory-answer:${key}`, "assistant", answer || "本次记忆查询已取消。", false, "set");
				return;
			}
		}
		await this.preempt(trimmed, key, lassoId);
	}
	/** Start one new turn on the current session. The caller owns the user bubble. */
	async submitPrompt(trimmed, lassoId) {
		this.voice.activity();
		this.turnInterrupted = false;
		this.beginTurn();
		if (this.sessionError && !this.sessionId) {
			this.finishTurn();
			this.status(this.sessionError);
			return;
		}
		try {
			this.foreground.restore();
			const sessionId = await this.ensureSession();
			if (!this.timer) this.syncWatermark();
			this.watch();
			const lassoArmed = lassoId !== void 0 && this.lasso.takeForPrompt(lassoId, sessionId);
			try {
				await this.ctx.sessionController.prompt({
					requestId: randomUUID(),
					sessionId,
					mode: "queue",
					content: [{
						type: "text",
						text: trimmed
					}],
					clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
				}, new AbortController().signal);
			} catch (error) {
				if (lassoArmed) this.ctx.get("computerUseLassoSeed")?.clear(sessionId);
				throw error;
			}
			this.drain();
		} catch (error) {
			this.finishTurn();
			const message = error instanceof Error ? error.message : String(error);
			console.error(`dsh-orb: prompt failed: ${message}`);
			this.status(message);
		}
	}
	/**
	* 一句最新的用户命令：停掉旧轮和旧语音，等旧轮真正结束后，把这句话当成新消息另起一轮。
	* 打字、语音命令和插话都走这里；旧轮还在跑时不能立刻开始下一轮（官方要求同一会话只有一轮）。
	*/
	async preempt(trimmed, key, lassoId) {
		this.settlePendingPrompt();
		this.voice.activity();
		if (!this.turnRunning || this.sessionId === void 0) {
			await this.submitPrompt(trimmed, lassoId);
			return;
		}
		const pending = {
			text: trimmed,
			key,
			sessionId: this.sessionId,
			...lassoId === void 0 ? {} : { lassoId }
		};
		this.pendingPrompt = pending;
		this.voice.prepareNewTurn();
		try {
			await this.ctx.sessionController.cancel({ sessionId: pending.sessionId });
			this.drain();
		} catch (error) {
			if (this.pendingPrompt !== pending) return;
			this.pendingPrompt = void 0;
			this.dropBlock(key);
			this.voice.resumeAfterInterjectFailure();
			const message = error instanceof Error ? error.message : String(error);
			console.error(`dsh-orb: prompt cancel failed: ${message}`);
			this.status(message);
		}
	}
	async onInterject(text) {
		if (this.observationWatch?.handles(text.trim())) return this.onPrompt(text);
		await this.observationWatch?.beforePrompt();
		this.memoryTasks?.abort();
		const trimmed = text.trim();
		if (!trimmed) return;
		const key = `user:${randomUUID()}`;
		this.lastUserBlockKey = key;
		this.block(key, "user", trimmed, false, "set");
		await this.preempt(trimmed, key);
	}
	/** Start the command waiting for the old turn's turn/end. */
	startPendingPrompt() {
		const pending = this.pendingPrompt;
		if (!pending) return;
		this.pendingPrompt = void 0;
		if (pending.sessionId !== this.sessionId) {
			this.dropBlock(pending.key);
			if (pending.lassoId !== void 0) this.lasso.dismiss(pending.lassoId);
			return;
		}
		this.submitPrompt(pending.text, pending.lassoId);
	}
	/** Drop a waiting command because a newer input or a stop replaced it. */
	settlePendingPrompt() {
		const pending = this.pendingPrompt;
		if (!pending) return;
		this.pendingPrompt = void 0;
		this.dropBlock(pending.key);
		if (pending.lassoId !== void 0) this.lasso.dismiss(pending.lassoId);
	}
	async ensureSession() {
		if (this.sessionId) return this.sessionId;
		this.creating ??= this.createSession().finally(() => {
			this.creating = void 0;
		});
		return this.creating;
	}
	async createSession() {
		const workspaceId = await this.workspaceId();
		const saved = await readSavedSession(this.sessionFile);
		if (saved !== void 0) {
			if (await this.openConversation(saved)) return this.adopt(saved);
			console.error("dsh-orb: saved session cannot be opened; creating a new one");
			await rm(this.sessionFile, { force: true });
		}
		const session = await this.ctx.sessionController.create({
			workspaceId,
			agentPreset: "computer-use"
		});
		return this.adopt(session.sessionId);
	}
	/**
	* Make one stored or already-live conversation current, keeping its identity.
	*
	* `sessionController.create` cannot open a conversation that has any history. Since dsh 0.2.1 a
	* named Session is reused only while it is still blank; one that has started a turn "stays
	* unchanged, and a new Session is created instead" — which is how clicking a history row used to
	* land the ball in an empty untitled chat. `resolveAgent` is the documented resolve-or-resume
	* entry: it keeps a live Agent, resumes a cold one, and re-mounts the preset the Session recorded.
	*/
	async openConversation(sessionId) {
		try {
			const resolved = await this.ctx.sessionController.resolveAgent(sessionId);
			if ("error" in resolved) {
				const reason = resolved.error instanceof Error ? resolved.error.message : JSON.stringify(resolved.error);
				console.error(`dsh-orb: session ${sessionId} cannot be opened: ${reason}`);
				return false;
			}
			return true;
		} catch (error) {
			console.error(`dsh-orb: session ${sessionId} cannot be opened: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}
	workspaceId() {
		this.workspaceTask ??= this.createWorkspace().catch((error) => {
			this.workspaceTask = void 0;
			throw error;
		});
		return this.workspaceTask;
	}
	async createWorkspace() {
		const workspace = this.store.workspaceDirectory();
		await mkdir(workspace, { recursive: true });
		return (await this.ctx.workspaceController.create({ path: workspace })).workspace.workspaceId;
	}
	async adopt(sessionId) {
		const id = await this.remember(sessionId);
		await this.refreshModelDefaults();
		await this.applyOverlayQuiet(id);
		pinSessionId(this.ctx, id, this.store.permission(), this.store.workspaceDirectory());
		return id;
	}
	/**
	* Refresh the unpicked-track fallback from the live catalog and the main-window
	* default, keeping the previous one when that read fails. The settings page calls this
	* through the plugin entry, so the value it shows is the one a session would use even
	* when the ball never starts.
	*/
	async refreshModelDefaults() {
		try {
			await refreshModelFallback(this.ctx, this.store);
		} catch (error) {
			console.error(`dsh-orb: model fallback failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	async remember(sessionId) {
		this.sessionId = sessionId;
		this.sessionError = void 0;
		publishScreenOwner(sessionId);
		try {
			await mkdir(dirname(this.sessionFile), { recursive: true });
			await writeFile(this.sessionFile, `${JSON.stringify({ sessionId })}\n`);
		} catch (error) {
			console.error(`dsh-orb: could not save session id: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.broadcast({
			type: "session",
			sessionId
		});
		console.error(`dsh-orb: session ${sessionId}`);
		return sessionId;
	}
	syncWatermark() {
		if (!this.sessionId) return;
		const session = this.ctx.sessions.get(this.sessionId);
		if (!session) return;
		for (const event of session.snapshotEvents()) {
			const seq = Number(event.seq);
			if (seq > this.watermark) this.watermark = seq;
		}
	}
	watch() {
		if (!this.timer) this.timer = setInterval(() => this.drain(), 400);
		this.armIdle();
	}
	/** Warn after 3 quiet minutes, but keep polling until the session goes idle. */
	armIdle() {
		if (this.giveUp) clearTimeout(this.giveUp);
		this.giveUp = setTimeout(() => {
			if (!this.turnRunning) return;
			if (this.pending) {
				this.armIdle();
				return;
			}
			if (!this.idleWarned) {
				this.idleWarned = true;
				this.status("等待超时");
			}
		}, 18e4);
	}
	stopWatch() {
		if (this.timer) clearInterval(this.timer);
		this.timer = void 0;
		if (this.giveUp) clearTimeout(this.giveUp);
		this.giveUp = void 0;
	}
	drain() {
		if (!this.sessionId) return;
		const session = this.ctx.sessions.get(this.sessionId);
		if (!session) {
			if (!this.missingLogged) {
				this.missingLogged = true;
				console.error("dsh-orb: session is not in the store yet");
			}
			return;
		}
		this.missingLogged = false;
		if (this.translation !== void 0) return;
		let fresh = false;
		try {
			for (const event of session.snapshotEvents()) {
				const seq = Number(event.seq);
				if (seq <= this.watermark) continue;
				this.watermark = seq;
				fresh = true;
				this.consume(event.type, event.data, seq);
			}
		} catch (error) {
			console.error(`dsh-orb: transcript read failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (fresh && this.turnRunning) {
			this.idleWarned = false;
			this.armIdle();
		}
	}
	consume(type, data, seq) {
		if (type === "user/message") {
			const record = asRecord(data);
			const sourceKind = asRecord(record?.source)?.kind;
			if (sourceKind === "user" || sourceKind === void 0) {
				if (!this.replaying) return;
				const text = userText(data);
				if (!text.trim()) return;
				const key = `user:${seq}`;
				this.lastUserBlockKey = key;
				this.block(key, "user", text, false, "set");
				return;
			}
			if (asRecord(record?.source)?.summary === "Lasso selection attached") {
				const image = imageFromContent(record?.content);
				const key = this.lastUserBlockKey;
				const item = key === void 0 ? void 0 : this.blocks.get(key);
				if (key !== void 0 && item !== void 0 && image !== void 0) this.block(key, item.kind, item.text, item.running, "set", item.detail, item.usage, { image });
				return;
			}
			const text = stripNoticeGuards(textOf(record?.content));
			if (!isCompletionNotice(text)) return;
			this.block(`notice:${seq}`, "notice", text, false, "set");
			return;
		}
		if (type === "turn/start") {
			if (this.turnRunning) return;
			this.turnInterrupted = false;
			this.beginTurn();
			this.armIdle();
			return;
		}
		if (type === "assistant/chunk") {
			this.onChunk(data);
			return;
		}
		if (type === "assistant/message") {
			this.onAssistant(data);
			return;
		}
		if (type === "tool/call") {
			const name = toolName(data);
			if (!name) return;
			const id = callId(data);
			const existing = id ? void 0 : this.runningTool(name);
			const key = id ? `tool:${id}` : existing ?? `tool:${seq}`;
			this.block(key, "tool", name, false, "set", { args: clip(toolArguments(data), 4e3) });
			return;
		}
		if (type === "tool/result") {
			this.onToolResult(data);
			return;
		}
		if (type === "turn/end") {
			this.finishTurn();
			this.startPendingPrompt();
		}
	}
	/** Join a settled result to its call by id, carrying error state and meta. */
	onToolResult(data) {
		const record = asRecord(data);
		if (!record) return;
		const id = callId(record);
		const message = asRecord(record.message);
		const callIdValue = id || (message ? callIdValueOf(message) : "");
		if (!callIdValue) return;
		const key = `tool:${callIdValue}`;
		const existing = this.blocks.get(key);
		const name = existing?.kind === "tool" ? existing.text : toolName(record) || "";
		const content = Array.isArray(message?.content) ? message?.content : [];
		const error = asRecord(record.error);
		const detail = {
			args: existing?.detail?.args ?? "",
			result: clip(resultText(content, error ?? void 0), 8e3),
			isError: message?.isError === true,
			...error === void 0 ? {} : { error: {
				name: typeof error.name === "string" ? error.name : "Error",
				code: typeof error.code === "string" ? error.code : "unknown",
				...typeof error.reason === "string" ? { reason: clip(error.reason, 2e3) } : {}
			} },
			meta: clip(jsonText(record.meta), 12e3),
			cwd: this.sessionCwd()
		};
		this.block(key, "tool", name, false, "set", detail);
	}
	sessionCwd() {
		if (!this.sessionId) return "";
		return this.ctx.sessions.get(this.sessionId)?.header?.cwd ?? "";
	}
	onChunk(data) {
		const record = asRecord(data);
		const chunk = asRecord(record?.chunk);
		if (!record || !chunk) return;
		const turn = numberOf(record.turn);
		const step = numberOf(record.step);
		const index = numberOf(chunk.index);
		const key = `b:${turn}:${step}:${index}`;
		this.liveStep = `${turn}:${step}`;
		try {
			if (chunk.type === "text-delta" && typeof chunk.text === "string") {
				this.block(key, "assistant", chunk.text, true, "append");
				return;
			}
			if (chunk.type === "reasoning-delta" && typeof chunk.text === "string") {
				this.block(key, "reasoning", chunk.text, true, "append");
				return;
			}
			if (chunk.type === "tool-call-delta") {
				const stepKey = `${turn}:${step}`;
				if (!this.replaying && !this.toolVoiceSteps.has(stepKey)) {
					this.toolVoiceSteps.add(stepKey);
					this.voice.tool();
				}
				const name = typeof chunk.name === "string" ? chunk.name : "";
				if (!name) return;
				const id = typeof chunk.id === "string" ? chunk.id : "";
				const delta = typeof chunk.argumentsDelta === "string" ? chunk.argumentsDelta : "";
				const toolKey = id ? `tool:${id}` : `b:${turn}:${step}:${index}`;
				const previous = this.blocks.get(toolKey);
				this.block(toolKey, "tool", name, true, "set", { args: clip(`${previous?.detail?.args ?? ""}${delta}`, 4e3) });
				return;
			}
			if (chunk.type === "block-end") this.applyContent(key, chunk.block, false);
		} finally {
			this.liveStep = void 0;
		}
	}
	/**
	* Settle one assistant message like Harness settleAssistant: the transient
	* streamed blocks are consumed in place (kind + order) and whatever the
	* message did not claim is dropped, so no stale copy can survive the fold.
	*/
	onAssistant(data) {
		const record = asRecord(data);
		if (!record) return;
		const turn = numberOf(record.turn);
		const step = numberOf(record.step);
		const usage = readUsage(record.usage);
		const previous = this.responseKeys;
		this.responseKeys = [];
		for (const key of previous) {
			const item = this.blocks.get(key);
			if (item?.response === true) this.block(key, item.kind, item.text, false, "set");
		}
		if (record.interrupted === true) this.turnInterrupted = true;
		const content = asRecord(record.message)?.content;
		const parts = typeof content === "string" ? [{
			type: "text",
			text: content
		}] : Array.isArray(content) ? content : [];
		const transient = this.stepBlocks.get(`${turn}:${step}`) ?? [];
		this.stepBlocks.delete(`${turn}:${step}`);
		const writtenKeys = [];
		let cursor = 0;
		for (const [index, part] of parts.entries()) {
			const wanted = partKind(asRecord(part));
			let key;
			if (wanted !== void 0) while (cursor < transient.length) {
				const candidate = transient[cursor];
				cursor += 1;
				if (this.blocks.get(candidate)?.kind === wanted) {
					key = candidate;
					break;
				}
				this.dropBlock(candidate);
			}
			key ??= `b:${turn}:${step}:${index}`;
			const written = this.applyContent(key, part, false);
			if (written === void 0 || written !== key) this.dropBlock(key);
			if (written !== void 0) writtenKeys.push(written);
		}
		while (cursor < transient.length) {
			this.dropBlock(transient[cursor]);
			cursor += 1;
		}
		this.responseKeys = writtenKeys;
		if (usage !== void 0) {
			const last = [...writtenKeys].reverse().find((key) => this.blocks.get(key)?.kind === "assistant");
			const settled = last === void 0 ? void 0 : this.blocks.get(last);
			if (last !== void 0 && settled) this.block(last, settled.kind, settled.text, false, "set", void 0, usage);
		}
	}
	/** Remove one block everywhere: map, order, and the ball's DOM. */
	dropBlock(key) {
		if (!this.blocks.delete(key)) return;
		const at = this.blockOrder.indexOf(key);
		if (at >= 0) this.blockOrder.splice(at, 1);
		this.dirty.delete(key);
		this.publish({
			type: "block-drop",
			key
		});
	}
	/** Write one content part. Returns the key it landed on, or `undefined` when the part is skipped. */
	applyContent(key, part, running) {
		const block = asRecord(part);
		if (!block) return void 0;
		if ((block.type === "text" || block.type === "reasoning" || block.type === "thinking") && typeof block.text === "string") {
			if (!block.text.trim()) return void 0;
			const kind = block.type === "text" ? "assistant" : "reasoning";
			this.block(key, kind, block.text, running, "set");
			return key;
		}
		if (block.type !== "tool-call" && block.type !== "tool_use") return void 0;
		const name = typeof block.name === "string" ? block.name : "";
		if (!name) return void 0;
		const id = typeof block.id === "string" ? block.id : typeof block.callId === "string" ? block.callId : "";
		const toolKey = id ? `tool:${id}` : key;
		this.block(toolKey, "tool", name, running, "set", { args: clip(typeof block.arguments === "string" ? block.arguments : "", 4e3) });
		return toolKey;
	}
	runningTool(name) {
		for (const key of this.blockOrder) {
			const block = this.blocks.get(key);
			if (block?.kind === "tool" && block.text === name && block.running) return key;
		}
	}
	/**
	* Start (or adopt) a turn. The epoch is what lets stopTurn tell whether its await
	* still owns the turn it was asked to cancel.
	*/
	beginTurn() {
		this.turnEpoch += 1;
		this.turnRunning = true;
		this.selection.setSessionRunning(true);
		this.broadcast({
			type: "turn",
			running: true
		});
		this.voice.beginTurn();
	}
	finishTurn() {
		this.turnRunning = false;
		this.idleWarned = false;
		this.selection.setSessionRunning(false);
		for (const key of [...this.blockOrder]) if (this.blocks.get(key)?.running) this.settleBlock(key);
		this.stepBlocks.clear();
		this.lastAttemptByStep.clear();
		this.toolVoiceSteps.clear();
		for (const key of [...this.responseKeys]) {
			const item = this.blocks.get(key);
			if (item) this.block(key, item.kind, item.text, false, "set");
		}
		this.responseKeys = [];
		this.broadcast({
			type: "turn",
			running: false,
			...this.turnInterrupted ? { interrupted: true } : {}
		});
		this.turnInterrupted = false;
		if (this.giveUp !== void 0) {
			clearTimeout(this.giveUp);
			this.giveUp = void 0;
		}
		const reply = [...this.blockOrder].reverse().map((key) => this.blocks.get(key)).find((item) => item?.kind === "assistant");
		console.error(`dsh-orb: turn done reply=${reply?.text.length ?? 0}`);
		this.voice.endTurn();
		this.refreshBalance(true);
	}
	/** Flip one leftover running block to settled, bypassing the empty-text guard in {@link block}. */
	settleBlock(key) {
		const previous = this.blocks.get(key);
		if (!previous) return;
		const message = {
			...previous,
			running: false,
			...this.turnInterrupted && previous.kind === "assistant" ? { interrupted: true } : {}
		};
		this.blocks.set(key, message);
		this.dirty.delete(key);
		this.publish(message);
	}
	block(key, kind, text, running, mode, detail, usage, flags) {
		const previous = this.blocks.get(key);
		const previousText = previous?.text ?? "";
		const next = clip(mode === "append" ? `${previousText}${text}` : text, 2e4);
		if (!next.trim() && kind !== "tool") return;
		const mergedDetail = detail === void 0 ? previous?.detail : {
			args: detail.args ?? previous?.detail?.args ?? "",
			result: detail.result ?? previous?.detail?.result ?? "",
			isError: detail.isError ?? previous?.detail?.isError ?? false,
			error: detail.error ?? previous?.detail?.error,
			meta: detail.meta ?? previous?.detail?.meta ?? "",
			cwd: detail.cwd ?? previous?.detail?.cwd ?? ""
		};
		const merged = mergedDetail === void 0 ? void 0 : {
			...mergedDetail,
			...mergedDetail.error === void 0 ? {} : { error: mergedDetail.error }
		};
		const mergedUsage = usage === void 0 ? previous?.usage : usage;
		const mergedImage = flags?.image ?? previous?.image;
		const message = {
			type: "block",
			key,
			kind,
			text: next,
			running,
			...this.turnInterrupted && kind === "assistant" && !running ? { interrupted: true } : {},
			...flags?.interrupted === true ? { interrupted: true } : {},
			...flags?.local === true ? { local: true } : {},
			...flags?.response === true ? { response: true } : {},
			...this.responseKeys.includes(key) ? { response: true } : {},
			...mergedImage === void 0 ? {} : { image: mergedImage },
			...merged === void 0 ? {} : { detail: merged },
			...mergedUsage === void 0 ? {} : { usage: mergedUsage }
		};
		if (!this.blocks.has(key)) {
			this.blockOrder.push(key);
			if (this.liveStep !== void 0) {
				const tracked = this.stepBlocks.get(this.liveStep);
				if (tracked) tracked.push(key);
				else this.stepBlocks.set(this.liveStep, [key]);
			}
			while (this.blockOrder.length > 200) {
				const oldest = this.blockOrder[0];
				if (oldest === void 0) break;
				if (!this.blocks.has(oldest)) {
					this.blockOrder.shift();
					continue;
				}
				this.dropBlock(oldest);
			}
		}
		this.blocks.set(key, message);
		const spoken = flags?.local !== true && message.local !== true;
		if (!this.replaying && spoken && kind === "assistant") this.voice.noteAssistant(key, next);
		if (!this.replaying && spoken && kind === "tool" && previous?.kind !== "tool") this.voice.tool();
		if (running) {
			this.dirty.add(key);
			this.dirtyTimer ??= setTimeout(() => this.flushDirty(), 60);
			return;
		}
		this.dirty.delete(key);
		this.publish(message);
	}
	/** Broadcast with global FIFO: pending coalesced updates go out before anything newer. */
	publish(message) {
		this.flushDirty();
		this.broadcast(message);
	}
	/** Coalesce per-token running-block updates; settled blocks always go out immediately. */
	flushDirty() {
		this.dirtyTimer = void 0;
		const keys = [...this.dirty];
		this.dirty.clear();
		for (const key of keys) {
			const message = this.blocks.get(key);
			if (message) this.broadcast(message);
		}
	}
	clearDirty() {
		if (this.dirtyTimer) clearTimeout(this.dirtyTimer);
		this.dirtyTimer = void 0;
		this.dirty.clear();
	}
	status(text) {
		this.broadcast({
			type: "status",
			text: clip(text, 500)
		});
	}
	onQuestion(request, next) {
		const agentId = typeof request.agent?.id === "string" ? request.agent.id : "";
		const questions = sanitizeQuestions(request.questions);
		if (this.sockets.size === 0 || !this.sessionId || agentId !== this.sessionId || this.pending || questions.length === 0) {
			if (this.sessionId && agentId === this.sessionId) console.error(`dsh-orb: question deferred sockets=${this.sockets.size} pending=${this.pending !== void 0} count=${questions.length}`);
			return next();
		}
		console.error(`dsh-orb: question card ${questions.length}`);
		const id = randomUUID();
		return new Promise((resolve, reject) => {
			this.pending = {
				id,
				resolve,
				reject,
				next
			};
			this.questionBody = questions;
			this.broadcast(this.questionPayload(id));
			this.voice.questionOpened();
			const signal = request.signal;
			const onAbort = () => {
				this.failQuestion("ask_user_question was aborted before the user answered", "ASK_ABORTED", id);
			};
			if (signal?.aborted) {
				onAbort();
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}
	onQuestionAnswer(id, answers) {
		const pending = this.pending;
		if (!pending || pending.id !== id) return;
		const parsed = parseAnswers(answers);
		if (!parsed) {
			this.broadcast({
				type: "question-error",
				id,
				text: "答案无效"
			});
			return;
		}
		this.pending = void 0;
		this.questionBody = void 0;
		this.broadcast({
			type: "question-clear",
			id
		});
		this.voice.questionClosed();
		console.error("dsh-orb: question answered");
		pending.resolve(parsed);
	}
	onQuestionCancel(id) {
		this.failQuestion("the user cancelled ask_user_question", "ASK_CANCELLED", id);
	}
	/** The ball is gone, so the main window can answer. Abort and cancel still reject. */
	handQuestionBack() {
		const pending = this.pending;
		if (!pending) return;
		this.pending = void 0;
		this.questionBody = void 0;
		this.broadcast({
			type: "question-clear",
			id: pending.id
		});
		this.voice.questionClosed();
		console.error("dsh-orb: question returned to the main window");
		pending.next().then(pending.resolve, pending.reject);
	}
	failQuestion(message, code, id = this.pending?.id) {
		const pending = this.pending;
		if (!pending || pending.id !== id) return;
		this.pending = void 0;
		this.questionBody = void 0;
		this.broadcast({
			type: "question-clear",
			id
		});
		this.voice.questionClosed();
		console.error(`dsh-orb: question ${code}`);
		pending.reject(questionError(message, code));
	}
	questionPayload(id) {
		return {
			type: "question",
			id,
			questions: this.questionBody ?? []
		};
	}
	broadcast(message) {
		for (const socket of this.sockets) this.send(socket, message);
	}
	/**
	* Every chrome handle the connected helpers reported.
	* The Windows observation walk skips these, so the ball never becomes the window the
	* agent believes the user is working in. Empty on macOS, where the ball is a
	* non-activating panel and the helper reports nothing.
	*/
	chromeWindowIds() {
		const ids = [];
		for (const reported of this.chromeWindows.values()) for (const id of reported) if (!ids.includes(id)) ids.push(id);
		return ids;
	}
	send(socket, message) {
		try {
			socket.write(`${JSON.stringify(message)}\n`);
		} catch {
			socket.destroy();
		}
	}
	launch() {
		if (this.halted || !this.binary) return;
		const generation = this.generation;
		const userData = this.userData || helperDataDirectory(this.store.dir);
		const env = {
			...process.env,
			DSH_ORB_TOKEN: this.token,
			DSH_ORB_SOCKET: `127.0.0.1:${this.port}`,
			DSH_ORB_WEB_PORT: String(this.ctx.webServer.port),
			...Object.keys(this.appearance).length > 0 ? { DSH_ORB_APPEARANCE: JSON.stringify(this.appearance) } : {}
		};
		delete env.ELECTRON_RUN_AS_NODE;
		const child = spawn(this.binary, [`--user-data-dir=${userData}`, helperMain()], {
			env,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			windowsHide: true
		});
		this.child = child;
		console.error(`dsh-orb: helper started pid ${child.pid ?? "unknown"}`);
		setTimeout(() => {
			if (this.child === child) this.failures = 0;
		}, 6e4).unref();
		const token = this.token;
		const log = (chunk) => {
			for (const line of chunk.split("\n")) {
				if (!line.trim() || line.includes(token) || /token=|api[_-]?key|authorization/i.test(line)) continue;
				console.error(`dsh-orb helper: ${line}`);
			}
		};
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", log);
		child.stderr?.on("data", log);
		let settled = false;
		const fail = (reason) => {
			if (settled || this.halted || generation !== this.generation) return;
			settled = true;
			if (this.child === child) this.child = void 0;
			this.failures += 1;
			const delay = HELPER_RETRY_DELAYS_MS[this.failures - 1];
			if (delay === void 0) {
				this.helperError = "helper-exited";
				console.error("dsh-orb: helper exited too many times; ball stays hidden");
				return;
			}
			console.error(`dsh-orb: helper exited (${reason}); retry ${this.failures}`);
			this.retry = setTimeout(() => this.launch(), delay);
			this.retry.unref();
		};
		child.once("error", (error) => fail(error.message));
		child.once("exit", (code, signal) => fail(String(code ?? signal)));
	}
	killChild() {
		const child = this.child;
		if (!child || child.exitCode !== null || child.signalCode !== null) return;
		child.kill("SIGTERM");
		const pid = child.pid;
		if (pid === void 0) return;
		setTimeout(() => {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}, 1e3).unref();
	}
	/** True when the helper presented this socket token. */
	helperAuthorized(token) {
		return tokensMatch(token, this.token);
	}
	/**
	* Push permission, both models, the catalog, and the avatar version to the ball.
	* Refreshing the model fallback here is also what keeps an unpicked track in step with
	* the main window: a sign-in moves the product default, and the ball follows.
	*/
	async publishChrome() {
		let catalog = { groups: [] };
		let moved = false;
		try {
			const refreshed = await refreshModelFallback(this.ctx, this.store);
			catalog = refreshed.catalog;
			moved = refreshed.changed;
		} catch (error) {
			console.error(`dsh-orb: model catalog failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		const models = this.store.models();
		const satellite = this.store.lassoSatellite();
		this.broadcast({
			type: "permission",
			preset: this.store.permission()
		});
		this.broadcast({
			type: "chrome",
			overlay: models.overlay,
			background: models.background,
			selectionEnabled: this.store.selectionEnabled(),
			lassoEnabled: satellite.enabled,
			lassoSatellite: satellite,
			lassoBalance: this.balance.current(),
			millifractionEnabled: this.store.millifractionEnabled(),
			openMain: isDesktopHost(),
			update: this.updateAvailable,
			catalog
		});
		this.broadcast(avatarMessage(this.store));
		if (moved && this.sessionId !== void 0) await this.applyOverlayQuiet(this.sessionId);
	}
	/**
	* Remember the version the check found and tell the ball.
	* The menu row and the status line both come from this; the settings page reads the checker.
	*/
	setUpdateAvailable(version) {
		if (this.updateAvailable === version) return;
		this.updateAvailable = version;
		if (version !== null) this.broadcast({
			type: "update",
			state: "available",
			version
		});
		this.publishChrome();
	}
	/**
	* Store the theme/locale preferences the ball mirrors and push them to a
	* connected helper. The raw preference travels; the helper resolves
	* `system` and an absent locale against its own environment.
	*/
	setAppearance(appearance) {
		const next = {
			...appearance.theme === void 0 ? {} : { theme: appearance.theme },
			...appearance.locale === void 0 ? {} : { locale: appearance.locale }
		};
		this.appearance = next;
		if (Object.keys(next).length > 0) this.broadcast({
			type: "appearance",
			...next
		});
	}
	async setOverlayModel(selection) {
		this.store.setOverlay(selection);
		if (this.sessionId) await this.applyOverlayQuiet(this.sessionId);
		await this.publishChrome();
	}
	async setBackgroundModel(selection) {
		this.store.setBackground(selection);
		await this.publishChrome();
	}
	async setSelectionEnabled(enabled) {
		this.store.setSelectionEnabled(enabled);
		this.selection.sync();
		await this.publishChrome();
	}
	async setLassoEnabled(enabled) {
		await this.setLassoConfig({ enabled });
	}
	/**
	* Apply one settings-card change to the satellite and push it to the ball.
	* @param patch - any of the master switch and the four look fields.
	* @returns the state after the change, including the switch.
	*/
	async setLassoConfig(patch) {
		const previous = this.store.lassoSatellite();
		if (patch.enabled !== void 0) this.store.setLassoEnabled(patch.enabled);
		const next = this.store.setLassoBall(patch);
		if (next.enabled && next.balance) {
			this.startBalancePoll();
			if (!previous.enabled || !previous.balance || this.balance.current().text === null) await this.balance.refresh(true);
		} else this.stopBalancePoll();
		await this.publishChrome();
		this.broadcastBalance();
		return next;
	}
	/** The current recharge balance, for the settings snapshot. */
	lassoBalance() {
		return this.balance.current();
	}
	/** Why the last balance read did not produce a number, for the settings card. */
	lassoBalanceError() {
		return this.balance.lastError() ?? "";
	}
	startBalancePoll() {
		if (this.balanceTimer !== void 0) return;
		const timer = setInterval(() => {
			this.refreshBalance();
		}, BALANCE_REFRESH_MS);
		timer.unref();
		this.balanceTimer = timer;
	}
	stopBalancePoll() {
		if (this.balanceTimer === void 0) return;
		clearInterval(this.balanceTimer);
		this.balanceTimer = void 0;
	}
	broadcastBalance() {
		const balance = this.balance.current();
		this.broadcast({
			type: "lasso-balance",
			text: balance.text,
			state: balance.state
		});
	}
	/** Poll or post-turn refresh; a disabled or hidden number costs no account request. */
	async refreshBalance(force = false) {
		const satellite = this.store.lassoSatellite();
		if (!satellite.enabled || !satellite.balance) return;
		const before = JSON.stringify(this.balance.current());
		const next = await this.balance.refresh(force);
		if (JSON.stringify(next) !== before) this.broadcastBalance();
	}
	async setMillifractionEnabled(enabled) {
		if (this.store.millifractionEnabled() === enabled) return;
		this.store.setMillifractionEnabled(enabled);
		if (this.sessionId) await this.newSession();
		else await this.publishChrome();
	}
	/** The observation ribbon. Turning it off takes any live frame down at once. */
	async setObservationFrameEnabled(enabled) {
		if (this.store.observationFrameEnabled() === enabled) return;
		this.store.setObservationFrameEnabled(enabled);
		if (!enabled) await this.overlay.setObservationFrame(null);
	}
	async setBallEnabled(enabled) {
		this.store.setBallEnabled(enabled);
		if (process.platform === "linux") return;
		if (enabled) {
			this.runtimeRetries = 0;
			this.start().catch((error) => {
				console.error(`dsh-orb: ${error instanceof Error ? error.message : String(error)}`);
			});
			return;
		}
		this.halt();
	}
	/**
	* Start the runtime download over from zero, on the user's explicit request. A download that
	* died with the previous process, stalled on a bad connection, or already spent its retry
	* budget is dropped — bytes, staging folder, and budget — and fetched again right away.
	*
	* Returns as soon as the new attempt is armed: the download itself runs for minutes and the
	* settings page follows it through `helperPhase`, exactly as it does a first launch.
	*/
	async redownloadRuntime() {
		if (process.platform === "linux") return;
		const live = this.child !== void 0 && this.child.exitCode === null && this.child.signalCode === null && this.server !== void 0;
		cancelRuntimeDownload();
		await purgeRuntimeArtifacts().catch((error) => {
			console.error(`dsh-orb: could not clear the leftover runtime files: ${error instanceof Error ? error.message : String(error)}`);
		});
		if (live) return;
		this.runtimeRetries = 0;
		this.helperError = void 0;
		this.runtimePending = true;
		this.start().catch((error) => {
			console.error(`dsh-orb: ${error instanceof Error ? error.message : String(error)}`);
		});
		this.runtimePhase = "downloading";
	}
	/** Take the checker the plugin entry owns. Without one the settings page hides its update card. */
	useUpdater(updater) {
		this.updater = updater;
		this.setUpdateAvailable(updater.availableVersion());
	}
	updateState() {
		return this.updater?.state() ?? EMPTY_UPDATE_STATE;
	}
	async checkUpdate() {
		await this.updater?.check(true);
		this.setUpdateAvailable(this.updater?.availableVersion() ?? null);
	}
	/**
	* Start the upgrade and return at once; the settings page polls {@link updateState}.
	* The ball hears the outcome through the same status line every other action uses.
	*/
	installUpdate(approvedBuilds) {
		const updater = this.updater;
		if (updater === void 0) return;
		const version = updater.availableVersion();
		if (version === null) return;
		this.run("update", async () => {
			this.broadcast({
				type: "update",
				state: "starting",
				version
			});
			await updater.install(approvedBuilds);
			const state = updater.state();
			this.setUpdateAvailable(updater.availableVersion());
			if (state.error !== null) {
				this.broadcast({
					type: "update",
					state: "failed",
					version,
					reason: state.pendingBuilds.length > 0 ? "build-blocked" : state.error
				});
				return;
			}
			this.broadcast({
				type: "update",
				state: state.deferred ? "deferred" : "done",
				version,
				restart: state.restartRequired
			});
		});
	}
	setAutoCheck(enabled) {
		this.updater?.setAutoCheck(enabled);
	}
	/** Current Agent workspace and whether it is the shipped default. */
	workspaceState() {
		const path = this.store.workspaceDirectory();
		const defaultPath = defaultWorkspaceDirectory();
		return {
			path,
			defaultPath,
			custom: resolve(path) !== resolve(defaultPath)
		};
	}
	/**
	* Ask the Host's directory-picker seam for one absolute directory. Native OS
	* panels are the desktop composition's capability; a remote browse-only Host
	* rejects this and the page keeps the manual input path.
	*/
	async pickWorkspaceDirectory(signal) {
		const service = this.ctx.get("directoryPicker");
		if (service === void 0 || typeof service.capability !== "function") throw new Error("workspace-picker-unavailable");
		const capability = service.capability();
		if (capability === null || typeof capability !== "object" || capability.kind !== "native" || typeof capability.pick !== "function") throw new Error("workspace-picker-unavailable");
		const picked = await capability.pick(signal ?? new AbortController().signal);
		return typeof picked === "string" && picked !== "" ? picked : null;
	}
	/**
	* Move the floating-ball Agent to a custom directory (or back to the default).
	* The old directory is never touched. A running turn is refused; an idle current
	* session is replaced by a fresh one in the new workspace.
	*/
	async setWorkspaceDirectory(value) {
		if (this.turnRunning) throw new Error("workspace-running");
		const previous = this.store.workspaceDirectory();
		const previousPath = resolve(previous);
		const defaultPath = resolve(defaultWorkspaceDirectory());
		const selection = await validateWorkspaceSelection(value, defaultPath, previousPath);
		if (selection.unchanged) return;
		const next = selection.path;
		const previousIsDefault = previousPath === defaultPath;
		this.store.setWorkspaceDirectory(selection.custom ? next : null);
		this.workspaceTask = void 0;
		try {
			if (this.sessionId !== void 0) await this.newSession();
			else await rm(this.sessionFile, { force: true });
		} catch {
			this.store.setWorkspaceDirectory(previousIsDefault ? null : previous);
			this.workspaceTask = void 0;
			throw new Error("workspace-create-failed");
		}
		this.sendHistory();
	}
	/** Start the daily retention check; the plugin effect owns the disposer. */
	startHistory() {
		this.sweepBlankSessionsOnce();
		return this.history.start();
	}
	/**
	* Take the empty conversations the pre-0.1.9 New Chat button left behind out of the store.
	* One pass per profile; see {@link scheduleBlankSweep} for the marker contract.
	*/
	sweepBlankSessionsOnce() {
		scheduleBlankSweep({
			marker: join(this.store.dir, BLANK_SWEEP_FILE),
			delayMs: BLANK_SWEEP_DELAY_MS,
			sweep: () => this.history.sweepBlanks()
		});
	}
	historyState() {
		return this.history.state();
	}
	setHistoryRetention(days) {
		this.history.setRetention(days);
	}
	previewHistory(days) {
		return this.history.preview(days);
	}
	cleanHistory() {
		this.history.startClean();
	}
	onControl(message, socket) {
		const record = asRecord(message);
		if (!record || typeof record.type !== "string") return;
		if (record.type === "chrome-windows") {
			this.chromeWindows.set(socket, readWindowIds(record.ids));
			return;
		}
		if (record.type === "overlay-ack" && typeof record.id === "string") {
			this.overlayWaiters.get(record.id)?.();
			this.overlayWaiters.delete(record.id);
			return;
		}
		if (record.type === "selection-action" && typeof record.action === "string") {
			this.onSelectionAction(record);
			return;
		}
		if (record.type === "lasso-action") {
			const action = readLassoAction(record);
			if (action !== void 0) this.run("lasso", () => this.lasso.action(action));
			return;
		}
		if (record.type === "lasso-dismiss" && typeof record.id === "string") {
			this.lasso.dismiss(record.id);
			return;
		}
		if (record.type === "lasso-active" && typeof record.active === "boolean") {
			this.selection.setLassoActive(record.active);
			return;
		}
		if (record.type === "history") {
			this.run("history", () => this.sendHistory());
			return;
		}
		if (record.type === "open" && typeof record.sessionId === "string") {
			this.run("open", () => this.openSession(record.sessionId));
			return;
		}
		if (record.type === "agent-open" && typeof record.sessionId === "string") {
			this.run("agent-open", () => this.openAgent(record.sessionId));
			return;
		}
		if (record.type === "agent-dismiss" && typeof record.sessionId === "string") {
			this.run("agent-dismiss", () => this.dismissAgent(record.sessionId));
			return;
		}
		if (record.type === "new") {
			this.run("new", () => this.newSession());
			return;
		}
		const preset = record.preset;
		if (record.type === "permission" && isPermissionPreset(preset)) {
			this.run("permission", () => this.setPermission(preset));
			return;
		}
		if (record.type === "stop") {
			this.voice.haltSpeech();
			this.stopTranslation();
			if (this.turnRunning) {
				const epoch = this.turnEpoch;
				this.run("stop", () => this.stopTurn(epoch));
			}
			return;
		}
		if (record.type === "pinned" && typeof record.pinned === "boolean") {
			this.voice.setPinned(record.pinned);
			return;
		}
		if (record.type === "activity") {
			this.voice.activity();
			return;
		}
		if (record.type === "menu") {
			this.run("menu", () => this.publishChrome());
			return;
		}
		const selection = record.selection;
		if (record.type === "set-overlay" && isAgentModelSelection(selection)) {
			this.run("overlay-model", () => this.setOverlayModel(selection));
			return;
		}
		if (record.type === "set-background" && isAgentModelSelection(selection)) {
			this.run("background-model", () => this.setBackgroundModel(selection));
			return;
		}
		if (record.type === "set-selection" && typeof record.enabled === "boolean") {
			this.run("selection", () => this.setSelectionEnabled(record.enabled === true));
			return;
		}
		if (record.type === "set-lasso" && typeof record.enabled === "boolean") {
			this.run("lasso-enabled", () => this.setLassoEnabled(record.enabled === true));
			return;
		}
		if (record.type === "set-millifraction" && typeof record.enabled === "boolean") {
			this.run("millifraction", () => this.setMillifractionEnabled(record.enabled === true));
			return;
		}
		if (record.type === "disable") {
			this.run("disable", () => this.setBallEnabled(false));
			return;
		}
		if (record.type === "update") {
			this.installUpdate();
			return;
		}
		if (record.type === "open-main") {
			this.run("open-main", () => this.openMain());
			return;
		}
		if (record.type === "open-settings") {
			this.run("open-settings", () => this.openSettings());
			return;
		}
		if (record.type === "tcc") {
			this.broadcast({
				type: "tcc",
				status: this.tcc.status()
			});
			return;
		}
		if (record.type === "tcc-open" && isTccRight(record.right)) {
			const right = record.right;
			this.run("tcc", async () => {
				await this.tcc.open(right);
				this.broadcast({
					type: "tcc",
					status: this.tcc.status()
				});
			});
		}
	}
	/** Keep a failed ball action inside this plugin. An unhandled rejection exits the official host. */
	run(label, task) {
		task().catch((error) => {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`dsh-orb: ${label} failed: ${message}`);
			this.status(message);
		});
	}
	async setPermission(preset) {
		this.store.setPermission(preset);
		if (this.sessionId) pinSessionId(this.ctx, this.sessionId, preset, this.store.workspaceDirectory());
		await this.publishChrome();
	}
	/**
	* Translate a selection into the ball's transcript without touching the conversation.
	*
	* The ball shows a user bubble and a streaming answer exactly as it would for a real turn,
	* but `turnRunning` stays false and nothing reaches `sessionController`: the pair is display
	* only, so no later request ever carries it and the user pays for the words once. Every
	* block carries `local: true`, which is how the panel marks it as outside the conversation.
	* @param source - the selected text, already trimmed by the monitor.
	* @param target - the language the toolbar's dropdown selects.
	*/
	async startTranslation(source, target) {
		const text = source.trim();
		if (!text) return;
		const llm = this.translationLlm();
		if (llm === void 0) return;
		const clipped = clipTranslationText(text);
		const userText = translationUserText(clipped.text, target, clipped.truncated, LOCAL_TRUNCATED_MARK);
		const route = this.store.models().overlay;
		await this.runLocalTranslation(userText, (signal, onText) => runTranslation({
			source: clipped.text,
			target,
			route: toTranslationRoute(route),
			truncatedMark: LOCAL_TRUNCATED_MARK,
			llm,
			sessionId: this.sessionId ?? "session-orb-translate",
			signal,
			onText
		}));
	}
	/**
	* Translate the text inside a lasso crop without touching the conversation.
	* The crop is already durable; the overlay route reads it as an image attachment.
	*/
	async startImageTranslation(image) {
		const llm = this.translationLlm();
		if (llm === void 0) return;
		const target = this.store.translateLanguage();
		const route = this.store.models().overlay;
		await this.runLocalTranslation(imageTranslationPrompt(target), (signal, onText) => runImageTranslation({
			image,
			target,
			route: toTranslationRoute(route),
			llm,
			sessionId: this.sessionId ?? "session-orb-translate",
			signal,
			onText
		}));
	}
	translationLlm() {
		const llm = this.ctx.get("llm");
		if (llm === void 0 || typeof llm.stream !== "function") {
			this.status("翻译不可用：当前宿主没有模型服务。");
			return;
		}
		return llm;
	}
	/**
	* Shared local-translation display: a user instruction and a streaming answer that
	* look exactly like a turn but never reach the session.
	*/
	async runLocalTranslation(userText, run) {
		this.stopTranslation();
		const key = `translate:${randomUUID()}`;
		const abort = new AbortController();
		this.translation = {
			abort,
			key
		};
		/** The transcript this translation was rendered into. A reset invalidates it. */
		const epoch = this.transcriptEpoch;
		let answer = "";
		/** The last text the panel was actually given, which is what a stop must keep. */
		let shown = "";
		try {
			this.block(`${key}:ask`, "user", userText, false, "set", void 0, void 0, { local: true });
			this.block(`${key}:say`, "assistant", "", true, "set", void 0, void 0, {
				local: true,
				response: true
			});
			this.broadcast({
				type: "turn",
				running: true
			});
			this.voice.setTranslationBusy(true);
			answer = await run(abort.signal, (soFar) => {
				if (this.transcriptEpoch !== epoch || this.translation?.key !== key) return;
				shown = soFar;
				this.block(`${key}:say`, "assistant", soFar, true, "set", void 0, void 0, {
					local: true,
					response: true
				});
			});
		} catch (error) {
			if (!abort.signal.aborted) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`dsh-orb: translate failed: ${message}`);
				this.status(message);
			}
		} finally {
			const live = this.transcriptEpoch === epoch;
			const current = this.translation?.key === key;
			if (current) this.translation = void 0;
			if (live) this.block(`${key}:say`, "assistant", answer || shown, false, "set", void 0, void 0, {
				local: true,
				response: true,
				...abort.signal.aborted ? { interrupted: true } : {}
			});
			if (!current) return;
			this.broadcast({
				type: "turn",
				running: false
			});
			this.voice.setTranslationBusy(false);
			this.drain();
		}
	}
	/** Halt the translation in flight, keeping the text already on screen. */
	stopTranslation() {
		this.translation?.abort.abort();
	}
	async stopTurn(epoch) {
		this.memoryTasks?.abort();
		this.ctx.get("orbMemory")?.abortRecall?.();
		this.settlePendingPrompt();
		const sessionId = this.sessionId;
		if (!sessionId || !this.turnRunning) return;
		try {
			await this.ctx.sessionController.cancel({ sessionId });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`dsh-orb: cancel failed: ${message}`);
			this.status(message);
			return;
		}
		if (this.turnEpoch !== epoch || this.sessionId !== sessionId) return;
		this.drain();
		if (this.turnEpoch !== epoch || this.sessionId !== sessionId) return;
		this.finishTurn();
	}
	async applyMemoryBinding(sessionId) {
    // The transaction already saved and verified sessionFile. Do not call remember.
    this.sessionId = sessionId;
    this.sessionError = void 0;
    publishScreenOwner(sessionId);
    await this.refreshModelDefaults();
    await this.applyOverlayQuiet(sessionId);
    pinSessionId(this.ctx, sessionId, this.store.permission(), this.store.workspaceDirectory());
    this.resetTranscript();
    this.broadcast({ type: "session", sessionId });
    await this.publishChrome();
  }
	async newSession() {
		this.memoryTasks?.abort();
		this.failQuestion("ask_user_question was aborted before the user answered", "ASK_ABORTED");
		if (await this.currentIsBlank()) {
			this.resetTranscript();
			await this.publishChrome();
			return;
		}
		const session = await this.ctx.sessionController.create({
			workspaceId: await this.workspaceId(),
			agentPreset: "computer-use"
		});
		await this.adopt(session.sessionId);
		this.resetTranscript();
		await this.publishChrome();
	}
	/**
	* True while the conversation on screen holds no turn. The official list marks it
	* (`blank`), and that mark is the same one the main window reads before it reuses a draft.
	* An unreadable list answers false: New Chat must still work when the list cannot be read.
	*/
	async currentIsBlank() {
		const current = this.sessionId;
		if (current === void 0) return false;
		try {
			return (await this.listHistoryRows()).find((row) => row.sessionId === current)?.blank === true;
		} catch (error) {
			console.error(`dsh-orb: could not tell whether the conversation is blank: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}
	async openSession(sessionId) {
		if (!sessionId.startsWith("session-") || sessionId.length > 80) return;
		const row = (await this.historyRecords()).find((item) => item.sessionId === sessionId);
		if (!row) return;
		this.failQuestion("ask_user_question was aborted before the user answered", "ASK_ABORTED");
		if (!await this.openConversation(sessionId)) return;
		await this.adopt(sessionId);
		this.resetTranscript();
		this.replaying = true;
		this.drain();
		this.replaying = false;
		if (row.running) {
			this.beginTurn();
			this.watch();
		}
	}
	async sendHistory() {
		const current = this.sessionId;
		const items = (await this.historyRecords()).slice(0, 40).map((row) => ({
			sessionId: row.sessionId,
			title: row.title,
			current: row.sessionId === current
		}));
		this.broadcast({
			type: "history",
			items
		});
	}
	async historyRecords() {
		try {
			const rows = await this.listHistoryRows();
			const orb = this.store.workspaceDirectory();
			const items = [];
			for (const row of rows) {
				const record = asRecord(row);
				if (!record || !isHistoryRow(record, orb) || typeof record.sessionId !== "string") continue;
				if (record.blank === true && record.sessionId !== this.sessionId) continue;
				const title = projection(record, "title");
				items.push({
					sessionId: record.sessionId,
					title: typeof title === "string" ? title.slice(0, 200) : "",
					running: record.running === true
				});
			}
			return items;
		} catch (error) {
			console.error(`dsh-orb: history failed: ${error instanceof Error ? error.message : String(error)}`);
			return [];
		}
	}
	/** One official list read, unfiltered, for both the ball history and retention. */
	async listHistoryRows() {
		const listed = await this.ctx.sessionController.list({}, AbortSignal.timeout(15e3));
		return Array.isArray(listed) ? listed : listed.items ?? [];
	}
	resetTranscript() {
		if (!this.memoryTasks?.switching) this.memoryTasks?.abort();
		this.ctx.get("orbMemory")?.abortRecall?.();
		this.transcriptEpoch += 1;
		this.stopTranslation();
		this.translation = void 0;
		this.voice.clearTranslation();
		this.pendingPrompt = void 0;
		this.lastUserBlockKey = void 0;
		this.lasso.clearSession();
		this.blocks.clear();
		this.blockOrder.length = 0;
		this.watermark = 0;
		this.turnRunning = false;
		this.attemptPositions.clear();
		this.lastAttemptByStep.clear();
		this.stepBlocks.clear();
		this.liveStep = void 0;
		this.responseKeys = [];
		this.clearDirty();
		this.selection.setSessionRunning(false);
		this.broadcast({ type: "reset" });
		this.broadcast({
			type: "turn",
			running: false
		});
		this.voice.clearSession();
	}
	onSelectionAction(record) {
		if (record.action === "search") this.selection.search();
		else if (record.action === "translate") this.selection.translate();
		else if (record.action === "send") this.selection.sendToAgent();
		else if (record.action === "language" && (record.language === "zh" || record.language === "en")) this.selection.setLanguage(record.language);
	}
	waitAck(message, signal) {
		if (this.sockets.size === 0) return Promise.resolve();
		return new Promise((resolve, reject) => {
			let settled = false;
			const finish = (error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				this.overlayWaiters.delete(message.id);
				if (error === void 0) resolve();
				else reject(error);
			};
			const timer = setTimeout(() => {
				finish(/* @__PURE__ */ new Error("dsh-orb: overlay ack timed out"));
			}, OVERLAY_GUARD_ACK_TIMEOUT_MS);
			timer.unref();
			const onAbort = () => {
				finish(signal?.reason instanceof Error ? signal.reason : /* @__PURE__ */ new Error("dsh-orb: overlay ack aborted"));
			};
			if (signal?.aborted) {
				onAbort();
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			this.overlayWaiters.set(message.id, () => {
				finish(void 0);
			});
			this.broadcast(message);
		});
	}
	async applyOverlayQuiet(sessionId) {
		const selection = this.store.models().overlay;
		try {
			await selectModelKeepDefault(this.ctx, {
				sessionId,
				provider: selection.provider,
				model: selection.model,
				...selection.reasoningEffort === void 0 ? {} : { reasoningEffort: selection.reasoningEffort }
			});
		} catch (error) {
			console.error(`dsh-orb: overlay model failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	async openMain() {
		if (!isDesktopHost()) return;
		await openMainWindow(this.ctx);
	}
	/**
	* The ball's "open floating-ball settings" click: arm the request the main window's
	* client plugin polls for, then bring that window forward. The window may be closed —
	* the target outlives the launch (`MAIN_WINDOW_TARGET_TTL_MS`) so a cold start still
	* lands on the settings page.
	*/
	async openSettings() {
		this.settingsTarget = { at: Date.now() };
		await this.openMain();
	}
	startAgentPoll() {
		if (this.agentTimer) return;
		this.agentTimer = setInterval(() => this.pollAgents(), AGENT_POLL_MS);
	}
	/**
	* The always-on polls: the bookmark registry, and the transcript drain. The
	* latter runs for the whole helper lifetime, not just during ball-initiated
	* turns — completion notices can wake the session into a new turn at any time.
	*/
	startPolls() {
		this.startAgentPoll();
		this.watch();
	}
	stopAgentPoll() {
		if (this.agentTimer) clearInterval(this.agentTimer);
		this.agentTimer = void 0;
		this.lastAgentsPayload = "";
	}
	/**
	* Poll the code-agent bookmark registry and push the strip on change.
	* The registry is provided by the preset's code-agent plugin; without it
	* (preset not mounted) the strip simply stays empty.
	*/
	pollAgents(force = false) {
		if (this.sockets.size === 0) return;
		const registry = this.agentRegistry();
		if (registry === void 0) return;
		let items;
		try {
			items = this.agentItems(registry);
		} catch (error) {
			console.error(`dsh-orb: agent bookmarks failed: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		this.refreshCallerTitles();
		const payload = JSON.stringify(items);
		if (!force && payload === this.lastAgentsPayload) return;
		this.lastAgentsPayload = payload;
		this.broadcast({
			type: "agents",
			items
		});
	}
	agentRegistry() {
		try {
			const registry = this.ctx.get(CODE_AGENT_REGISTRY);
			return registry !== void 0 && typeof registry.list === "function" ? registry : void 0;
		} catch {
			return;
		}
	}
	/** Running first (oldest start at the top), finished after (newest first); read ones dropped. */
	agentItems(registry) {
		const bookmarks = registry.list();
		for (const bookmark of bookmarks) if (bookmark.state === "running") this.readAgentIds.delete(bookmark.sessionId);
		const visible = bookmarks.filter((bookmark) => bookmark.state === "running" || !this.readAgentIds.has(bookmark.sessionId));
		visible.sort((left, right) => {
			const leftRunning = left.state === "running";
			if (leftRunning !== (right.state === "running")) return leftRunning ? -1 : 1;
			if (leftRunning) return left.startedAt - right.startedAt;
			return (right.endedAt ?? 0) - (left.endedAt ?? 0);
		});
		const titles = this.callerTitles?.byId;
		return visible.map((bookmark) => ({
			sessionId: bookmark.sessionId,
			callerId: bookmark.callerId,
			task: bookmark.task,
			cwd: bookmark.cwd,
			startedAt: bookmark.startedAt,
			state: bookmark.state,
			colorIndex: this.callerColor(bookmark.callerId),
			callerTitle: titles?.get(bookmark.callerId) ?? "",
			unread: bookmark.state !== "running" && !this.readAgentIds.has(bookmark.sessionId),
			...bookmark.endedAt === void 0 ? {} : { endedAt: bookmark.endedAt },
			...bookmark.outcome === void 0 ? {} : { outcome: bookmark.outcome }
		}));
	}
	callerColor(callerId) {
		let index = this.callerColors.get(callerId);
		if (index === void 0) {
			index = this.callerColors.size % AGENT_COLOR_COUNT;
			this.callerColors.set(callerId, index);
		}
		return index;
	}
	/** Caller conversation titles for the tooltips, refreshed at most every 10 seconds. */
	refreshCallerTitles() {
		if (this.callerTitles !== void 0 && Date.now() - this.callerTitles.at < 1e4) return;
		this.callerTitlesTask ??= this.historyRecords().then((rows) => {
			const byId = /* @__PURE__ */ new Map();
			for (const row of rows) if (row.title !== "") byId.set(row.sessionId, row.title);
			this.callerTitles = {
				at: Date.now(),
				byId
			};
		}).catch(() => {}).finally(() => {
			this.callerTitlesTask = void 0;
		});
	}
	/** One-shot jump target for the main window's client plugin. `null` once consumed or expired. */
	takeJump() {
		const target = this.jumpTarget;
		if (target === void 0) return null;
		if (Date.now() - target.at > MAIN_WINDOW_TARGET_TTL_MS) {
			this.jumpTarget = void 0;
			return null;
		}
		return {
			sessionId: target.sessionId,
			at: target.at
		};
	}
	confirmJump(sessionId) {
		if (this.jumpTarget?.sessionId === sessionId) this.jumpTarget = void 0;
	}
	/**
	* The armed floating-ball-settings request, for the main window's client plugin.
	* `null` once confirmed or expired; reading it does not consume it, so a window that
	* cannot open the section yet retries instead of losing the click.
	*/
	takeSettingsOpen() {
		const target = this.settingsTarget;
		if (target === void 0) return null;
		if (Date.now() - target.at > MAIN_WINDOW_TARGET_TTL_MS) {
			this.settingsTarget = void 0;
			return null;
		}
		return { at: target.at };
	}
	confirmSettingsOpen(at) {
		if (this.settingsTarget?.at === at) this.settingsTarget = void 0;
	}
	/**
	* A bookmark click: arm the main window's jump and focus the main window.
	*
	* Only a finished bookmark is consumed. Clicking one that is still running is a plain jump —
	* no matter how often it happens — so the completion that follows still raises an unread
	* bookmark with its outcome.
	*/
	async openAgent(sessionId) {
		if (!sessionId.startsWith("session-") || sessionId.length > 80) return;
		const state = this.bookmarkState(sessionId);
		if (state !== void 0 && state !== "running") {
			this.readAgentIds.add(sessionId);
			this.pollAgents(true);
		}
		this.jumpTarget = {
			sessionId,
			at: Date.now()
		};
		await this.openMain();
	}
	/**
	* Live state of one bookmark, or undefined when no record answers for it (already dropped, or the
	* registry is unavailable). A click falls back to a plain jump in that case.
	*/
	bookmarkState(sessionId) {
		try {
			return this.agentRegistry()?.list().find((bookmark) => bookmark.sessionId === sessionId)?.state;
		} catch {
			return;
		}
	}
	/**
	* The chip's dismiss control: retire a finished bookmark on the spot, without the main-window
	* jump {@link openAgent} performs — the whole point is not having to look at that session.
	*
	* A running stretch has no dismiss control and is refused here too: while it runs the chip is the
	* only trace of the task, and stopping it stays `code_agent_stop`'s job.
	*/
	async dismissAgent(sessionId) {
		if (!sessionId.startsWith("session-") || sessionId.length > 80) return;
		const state = this.bookmarkState(sessionId);
		if (state === void 0 || state === "running") return;
		if (this.readAgentIds.has(sessionId)) return;
		this.readAgentIds.add(sessionId);
		this.pollAgents(true);
	}
};
/** Per-profile Chromium data so desktop and `dsh web` do not share one lock. */
function helperDataDirectory(profileDir) {
	const id = createHash("sha256").update(profileDir).digest("hex").slice(0, 16);
	return dshHomePath("dsh-orb", "helper-data", id);
}
function isPrompt(message) {
	if (typeof message !== "object" || message === null) return false;
	const record = message;
	if (record.type !== "prompt" || typeof record.text !== "string" || record.text.length > 8e3) return false;
	return record.lassoId === void 0 || typeof record.lassoId === "string" && record.lassoId.length > 0 && record.lassoId.length <= 80;
}
/**
* Chrome window ids from one helper's `chrome-windows` report.
* A malformed payload yields no ids, which is the pre-report behaviour: the observation
* walk simply excludes nothing.
*/
function readWindowIds(value) {
	if (!Array.isArray(value) || value.length > 16) return [];
	const ids = [];
	for (const entry of value) {
		if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry <= 0) return [];
		if (!ids.includes(entry)) ids.push(entry);
	}
	return ids;
}
async function readSavedSession(file) {
	try {
		const parsed = JSON.parse(await readFile(file, "utf8"));
		if (typeof parsed.sessionId === "string" && parsed.sessionId.startsWith("session-")) return parsed.sessionId;
	} catch {}
}
function toolName(data) {
	if (typeof data !== "object" || data === null) return "";
	const name = data.name;
	return typeof name === "string" ? name : "";
}
/**
* Avatar descriptor for the ball. A preset travels as the relative asset path, so the
* ball reads it off disk: pushing megabytes of GIF through the socket as a data URL
* would stall every chrome publish.
*/
function avatarMessage(store) {
	const version = Math.trunc(store.avatarVersion());
	const selection = store.avatarSelection();
	if (selection.kind === "preset") {
		const src = avatarPresetSrc(selection.id);
		if (src !== void 0) return {
			type: "avatar",
			kind: "preset",
			src,
			version
		};
	}
	return {
		type: "avatar",
		kind: selection.kind === "custom" ? "custom" : "default",
		version
	};
}
function toolArguments(data) {
	if (typeof data !== "object" || data === null) return "";
	const args = data.arguments;
	return typeof args === "string" ? args : "";
}
function callIdValueOf(data) {
	const record = asRecord(data);
	if (!record) return "";
	const id = record.toolCallId ?? record.callId ?? record.id;
	return typeof id === "string" ? id : "";
}
/** Flatten result content blocks to display text (tool-call-model resultText). */
function resultText(content, error) {
	const parts = [];
	if (Array.isArray(content)) for (const block of content) {
		const record = asRecord(block);
		if (record?.type === "text" && typeof record.text === "string") parts.push(record.text);
		else parts.push(JSON.stringify(block, null, 2));
	}
	if (parts.length === 0 && error !== void 0) parts.push(`${typeof error.name === "string" ? error.name : "Error"}: ${typeof error.code === "string" ? error.code : "unknown"}`);
	return parts.join("\n");
}
function jsonText(value) {
	if (value === void 0 || value === null) return "";
	try {
		return JSON.stringify(value);
	} catch {
		return "";
	}
}
function isQuestionAnswer(message) {
	if (typeof message !== "object" || message === null) return false;
	const record = message;
	return record.type === "question-answer" && typeof record.id === "string";
}
function isQuestionCancel(message) {
	if (typeof message !== "object" || message === null) return false;
	const record = message;
	return record.type === "question-cancel" && typeof record.id === "string";
}
function isHistoryRow(record, orb) {
	if (record.origin === "subagent") return false;
	if (typeof record.cwd !== "string" || resolve(record.cwd) !== resolve(orb)) return false;
	const preset = projection(record, "agentPreset");
	return preset === void 0 || preset === "computer-use";
}
/**
* Run the empty-conversation sweep once per profile, a moment after startup.
*
* The marker file is the whole state: once it exists this profile has been swept, and it is
* written only after a pass actually ran — {@link HistoryCleaner.sweepBlanks} throws when its
* services are missing, the marker stays unwritten, and the next launch tries again instead of
* leaving the pile behind forever.
*
* @param options.marker - profile file that records the pass.
* @param options.delayMs - time to let the first start settle, so the adopted conversation is known.
* @param options.sweep - the pass; resolves with the number of conversations it moved.
* @param options.log - diagnostics sink, defaulting to the host's stderr.
*/
function scheduleBlankSweep(options) {
	if (existsSync(options.marker)) return;
	const log = options.log ?? ((message) => {
		console.error(message);
	});
	setTimeout(() => {
		(async () => {
			try {
				const swept = await options.sweep();
				await writeFile(options.marker, `${JSON.stringify({
					swept,
					at: Date.now()
				})}\n`);
				if (swept > 0) log(`dsh-orb: moved ${swept} empty conversation(s) to the system trash`);
			} catch (error) {
				log(`dsh-orb: blank conversation sweep failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		})();
	}, options.delayMs).unref();
}
/** The persistence service, when this Host exposes its read surface. */
function historyPersistence(ctx) {
	const value = ctx.get("sessionPersistence");
	if (typeof value !== "object" || value === null) return void 0;
	const candidate = value;
	if (typeof candidate.list !== "function" || typeof candidate.stat !== "function" || typeof candidate.open !== "function") return void 0;
	return value;
}
/** All services retention needs, checked before the card offers the action. */
function historyAvailable(ctx) {
	if (!osTrashAvailable()) return false;
	if (historyPersistence(ctx) === void 0) return false;
	const controller = ctx.workspaceController;
	if (typeof controller.archiveSession !== "function" || typeof controller.unarchiveSession !== "function") return false;
	return typeof controller.baseline === "function" || typeof controller.follow === "function";
}
/** Pinned and archived Session ids, read from the Workspace projection. */
async function readWorkspaceSafety(ctx) {
	const controller = ctx.workspaceController;
	if (typeof controller.baseline === "function") {
		const baseline = controller.baseline();
		return {
			pinned: [...baseline.pinnedSessionIds ?? []],
			archived: [...baseline.archivedSessionIds ?? []]
		};
	}
	if (typeof controller.follow === "function") {
		const abort = new AbortController();
		try {
			for await (const frame of controller.follow(abort.signal)) {
				if (frame.type !== "baseline" || frame.value === void 0) continue;
				return {
					pinned: [...frame.value.pinnedSessionIds ?? []],
					archived: [...frame.value.archivedSessionIds ?? []]
				};
			}
		} finally {
			abort.abort();
		}
	}
	throw new Error("workspace-safety-unavailable");
}
async function archiveHistorySession(ctx, sessionId) {
	const archive = ctx.workspaceController.archiveSession;
	if (typeof archive !== "function") throw new Error("workspace-archive-unavailable");
	await archive.call(ctx.workspaceController, { sessionId });
}
async function unarchiveHistorySession(ctx, sessionId) {
	const unarchive = ctx.workspaceController.unarchiveSession;
	if (typeof unarchive !== "function") throw new Error("workspace-unarchive-unavailable");
	await unarchive.call(ctx.workspaceController, { sessionId });
}
function projection(record, key) {
	return asRecord(asRecord(record.projections)?.values)?.[key];
}
function userText(data) {
	const record = asRecord(data);
	if (!record) return "";
	const source = asRecord(record.source);
	if (source && source.kind !== void 0 && source.kind !== "user") return "";
	return textOf(record.content);
}
/**
* Model-facing tails the code_agent completion notices append; the ball shows
* notices to the user, so the instructions come off. Unknown tails stay.
*/
const NOTICE_GUARDS = ["Another Computer Use chat is operating the screen right now. Report this result as text only; do not perform any GUI actions unless the user asks again in this chat.", "Do not restart this task and do not call code_agent for it again unless the user asks."];
/** Only the code_agent completion report becomes a card; the prefix is ours to define. */
function isCompletionNotice(text) {
	return text.startsWith("Background Code agent session ") || text.startsWith("The user stopped background Code agent session ");
}
function stripNoticeGuards(text) {
	let shown = text;
	for (const guard of NOTICE_GUARDS) while (shown.endsWith(guard)) shown = shown.slice(0, shown.length - guard.length).replace(/\n+$/, "");
	return shown;
}
function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const part of content) {
		const block = asRecord(part);
		if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}
/** Read the first durable image out of one message's content. */
function imageFromContent(content) {
	if (!Array.isArray(content)) return void 0;
	for (const part of content) {
		const block = asRecord(part);
		if (block?.type !== "image") continue;
		const attachment = asRecord(block.attachment);
		if (!attachment) continue;
		const { attachmentId, mediaType, bytes, width, height, name } = attachment;
		if (typeof attachmentId !== "string" || attachmentId === "" || typeof mediaType !== "string") continue;
		if (typeof bytes !== "number" || bytes <= 0) continue;
		if (typeof width !== "number" || width <= 0 || typeof height !== "number" || height <= 0) continue;
		return {
			attachmentId,
			mediaType,
			bytes,
			width,
			height,
			...typeof name === "string" && name !== "" ? { name } : {}
		};
	}
}
function asRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function numberOf(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
/** Validate the provider token-usage payload of an `assistant/message` event. */
function readUsage(value) {
	const record = asRecord(value);
	if (!record) return void 0;
	const count = (raw) => {
		const number = typeof raw === "number" ? raw : NaN;
		return Number.isFinite(number) && number >= 0 ? number : void 0;
	};
	const inputTokens = count(record.inputTokens);
	const outputTokens = count(record.outputTokens);
	if (inputTokens === void 0 || outputTokens === void 0) return void 0;
	return {
		inputTokens,
		outputTokens,
		...count(record.totalTokens) === void 0 ? {} : { totalTokens: count(record.totalTokens) },
		...count(record.cacheReadTokens) === void 0 ? {} : { cacheReadTokens: count(record.cacheReadTokens) },
		...count(record.cacheWriteTokens) === void 0 ? {} : { cacheWriteTokens: count(record.cacheWriteTokens) },
		...count(record.reasoningTokens) === void 0 ? {} : { reasoningTokens: count(record.reasoningTokens) }
	};
}
function partKind(part) {
	if (!part) return void 0;
	if (part.type === "text") return "assistant";
	if (part.type === "reasoning" || part.type === "thinking") return "reasoning";
	if (part.type === "tool-call" || part.type === "tool_use") return "tool";
}
function callId(data) {
	const record = asRecord(data);
	if (!record) return "";
	if (typeof record.id === "string") return record.id;
	if (typeof record.callId === "string") return record.callId;
	if (typeof record.toolCallId === "string") return record.toolCallId;
	const call = asRecord(record.call);
	return typeof call?.id === "string" ? call.id : "";
}
function bounded(value, max) {
	return typeof value === "string" && value.length > 0 && value.length <= max ? value : "";
}
function sanitizeQuestions(value) {
	if (!Array.isArray(value)) return [];
	const questions = [];
	for (const item of value.slice(0, 20)) {
		const record = asRecord(item);
		if (!record) continue;
		const id = bounded(record.id, 200);
		const question = bounded(record.question, 4e3);
		if (!id || !question) continue;
		const options = [];
		if (Array.isArray(record.options)) for (const option of record.options.slice(0, 20)) {
			const entry = asRecord(option);
			const label = entry ? bounded(entry.label, 500) : "";
			if (!label) continue;
			const description = entry ? bounded(entry.description, 2e3) : "";
			options.push(description ? {
				label,
				description
			} : { label });
		}
		const detail = bounded(record.detail, 8e3);
		const header = bounded(record.header, 200);
		questions.push({
			id,
			question,
			...detail ? { detail } : {},
			...header ? { header } : {},
			...options.length > 0 ? { options } : {},
			...record.multiSelect === true ? { multiSelect: true } : {}
		});
	}
	return questions;
}
function parseAnswers(value) {
	if (!Array.isArray(value) || value.length === 0 || value.length > 20) return void 0;
	const answers = [];
	for (const item of value) {
		const record = asRecord(item);
		if (!record || typeof record.id !== "string" || record.id.length > 200) return void 0;
		if (!Array.isArray(record.selected) || record.selected.length > 20) return void 0;
		const selected = [];
		for (const label of record.selected) {
			if (typeof label !== "string" || label.length > 4e3) return void 0;
			selected.push(label);
		}
		if (record.custom !== void 0 && (typeof record.custom !== "string" || record.custom.length > 4e3)) return void 0;
		const custom = typeof record.custom === "string" ? record.custom : "";
		answers.push({
			id: record.id,
			selected,
			...custom ? { custom } : {}
		});
	}
	return { answers };
}
function questionError(message, code) {
	const error = new Error(message);
	error.name = "UserQuestionError";
	return Object.assign(error, { code });
}
function clip(text, max) {
	return text.length <= max ? text : text.slice(0, max);
}
/**
* Appended to a translation's source when the selection was longer than the toolbar's budget.
* The panel already has a translated "truncated" string for the composer; this is the host's
* own copy so the marker travels with the stored bubble rather than being re-derived.
*/
const LOCAL_TRUNCATED_MARK = "\n\n…[已截断]";
/** The ball's model route, narrowed to what one throwaway call needs. */
function toTranslationRoute(route) {
	return {
		provider: route.provider,
		model: route.model
	};
}
//#endregion
//#region src/index.ts
/**
* Host-side Orb plugin.
* The ball is a separate Electron process. This plugin owns the socket, the preferences, and the Computer Use session.
*/
/** Cordis plugin name. */
const name = "orb-host";
/** Official services this plugin reads. Missing ones keep it pending. */
const inject = [
	"attachments",
	"llm",
	"webServer",
	"connection",
	"sessionController",
	"workspaceController",
	"sessions",
	"systemPrompt",
	"agents",
	"agentDefaultModel"
];
/**
* Register preferences, Computer Use services, and settings routes, then start the ball.
* Linux never starts the helper. `autoStart: false` and `ball-enabled.json` leave Computer Use in the main window.
* @param ctx - host services named in {@link inject}.
* @param config - patch config. `autoStart: false` skips the helper until settings turn it back on.
*/
function apply(ctx, config = {}) {
	suppressDockTile();
	logWebPort(ctx);
	const own = ownPackage();
	const profile = profileDirectory(ctx);
	const installing = deferredInstallInProgress(profile);
	if (installing) console.error("dsh-orb: an update install is running; the ball waits for it to finish");
	else if (process.platform === "win32" && own !== void 0) stageNativeImages();
	const store = new ProfileStore(profile);
	if (own !== void 0 && !installing) exemptReleaseAge(store.dir, own.name);
	const tcc = new TccMonitor();
	const runtime = new OrbRuntime(ctx, store, { tcc });
	if (config.memoryCutover) installOrbMemoryCutover(ctx, runtime, config.memoryCutover);
	if (config.taskMemory) installOrbTaskMemory(ctx, runtime, config.taskMemory);
	installOrbCompanion(ctx, runtime, config.companion);
	runtime.refreshModelDefaults();
	installOrbServices(ctx, store);
	const updater = new UpdateChecker({
		store,
		manager: () => ctx.get("pluginManager"),
		notify: (version) => {
			runtime.setUpdateAvailable(version);
		}
	});
	runtime.useUpdater(updater);
	console.error(`dsh-orb-mio-dev: loaded from ${ownPackageRoot()} (0.2.1-mio-dev.11)`);
	console.error(`dsh-orb: profile ${store.dir}`);
	console.error(`dsh-orb: version ${updater.state().currentVersion || "unknown"}`);
	ctx.effect(() => {
		const detachQuestions = runtime.attachQuestions();
		const detachPermissions = watchOrbPermissions(ctx, store);
		const detachRoutes = registerOrbRoutes({
			ctx,
			store,
			tcc,
			control: runtime
		});
		const detachAppearance = watchAppearance(ctx, (appearance) => {
			runtime.setAppearance(appearance);
		});
		const detachUpdates = () => {}; // local development package: no upstream updater
		const detachHistory = runtime.startHistory();
		const start = process.platform !== "linux" && config.autoStart !== false && store.ballEnabled();
		let cancelled = false;
		if (installing) waitForInstall(store.dir, () => cancelled).then(() => {
			if (cancelled) return;
			updater.adoptDeferredOutcome();
			if (own !== void 0) exemptReleaseAge(store.dir, own.name);
			if (process.platform === "win32" && own !== void 0) stageNativeImages();
			if (!start) return;
			return runtime.start();
		}).catch((error) => {
			console.error(`dsh-orb: ${error instanceof Error ? error.message : String(error)}`);
		});
		else if (start) runtime.start().catch((error) => {
			console.error(`dsh-orb: ${error instanceof Error ? error.message : String(error)}`);
		});
		return () => {
			cancelled = true;
			detachQuestions();
			detachPermissions();
			detachRoutes();
			detachAppearance();
			detachUpdates();
			detachHistory();
			runtime.halt();
		};
	});
}
/**
* Wait for the after-exit install to write its outcome, at most as long as the script itself
* can run. A status file past that ceiling is collected as a failed outcome by
* {@link deferredInstallInProgress}, so the wait always ends.
* @param profileDir - profile that scheduled the install.
* @param cancelled - true once the plugin was disposed; the wait then stops without starting.
*/
async function waitForInstall(profileDir, cancelled) {
	const deadline = Date.now() + DEFERRED_INSTALL_CEILING_MS;
	while (!cancelled() && Date.now() < deadline && deferredInstallInProgress(profileDir)) await new Promise((resolve) => setTimeout(resolve, 1e3));
}
/** Point every koffi loader at a copy outside the package and clear what failed updates left. */
function stageNativeImages() {
	const root = ownPackageRoot();
	try {
		const dir = stageKoffi(root, dshHomePath("dsh-orb", "native"));
		if (dir !== void 0) process.env[KOFFI_DIR_ENV] = dir;
	} catch (error) {
		console.error(`dsh-orb: koffi stays in the package: ${error instanceof Error ? error.message : String(error)}`);
	}
	removeStaleStages(root);
}
/** Print the loopback port. The authenticated URL contains credentials, so it is never logged. */
function logWebPort(ctx) {
	const port = ctx.webServer.port;
	try {
		const authed = ctx.connection.authenticatedUrl(`http://127.0.0.1:${port}`);
		const hostname = new URL(authed).hostname;
		if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "[::1]") console.error("dsh-orb: authenticated URL is not loopback");
	} catch {
		console.error("dsh-orb: authenticated URL is unavailable");
	}
	console.error(`dsh-orb: host web port ${port}`);
}
//#endregion
export { apply, inject, name };
