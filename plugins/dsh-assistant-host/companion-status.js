/**
 * companion-status.js — 陪伴控制与状态面板的**薄适配层**（交接 03）。
 *
 * 面板要回答三个以前被一个下拉框混在一起的问题：
 *   已保存的是哪个模块 / 现在实际在跑哪个 / 视频这条链路通到了哪一层。
 *
 * 这里只做三件事：
 *   · 读——把两个模块各自的真实状态拼成一个稳定结构。GET 是纯读：不建段、不启桥、
 *     不读用户 cookies、不调用付费模型或 ASR；看不出就报"看不出"，null 不变成 0。
 *   · 控——start/pause/resume/stop 落到**原模块自己的入口**，不复制视频循环，
 *     也不为了停循环多发一轮模型请求。
 *   · 别撒谎——"没配置""不可达""没在播""正在启动"是四件事，四个字段。
 *
 * ## 为什么视频状态可以在这里读
 *
 * `watch_together` 的 public-api 不导出 `loopStatus`，循环是 `watch-loop.js` 里的
 * 模块级单例。DSH 从 profile 的 junction 加载插件，Node 的 ESM 按 realpath 认模块，
 * 所以从工作区同一路径 import 拿到的是**同一个** `loop` —— 这正是"别另起子进程查"
 * 的反面：子进程里那一个永远是空循环。读不到时如实降级，不假装"未运行"。
 *
 * 位置桥是例外：它本来就落盘（position.json / extension.json，见原插件
 * position-bridge.js），读文件即可，**完全不依赖模块实例**。所以桥的三层
 * （服务可达 / 扩展报过 / 位置新鲜）在模块读不到时依然可用。
 */

import { connect } from 'node:net';

/** 原插件的位置桥端口。改这个数要先改浏览器扩展，别为了排错随手换。 */
export const BRIDGE_PORT = 9377;
/** 探测端口最多等多久：loopback 上要么立刻连上，要么立刻 refuse。 */
const PROBE_TIMEOUT_MS = 400;
/** 服务探测缓存：面板每 2.5 秒问一次，没必要每次都摸一遍端口。 */
const PROBE_CACHE_MS = 1500;
/** 面板点了启动之后，等循环自己变成 active 的上限。超了才敢说"没启动起来"。 */
const START_TIMEOUT_MS = 90_000;
/** 幂等表最多记多少个 requestId。 */
const REQUEST_MEMORY = 64;

const WATCH_SRC = new URL('../../third_party/dsh-watch-together/src/', import.meta.url);

let modulesCache = null;

/**
 * 动态加载原插件的两个内部模块。
 *
 * **必须动态 import + 吞错**：这里是 Orb 的启动路径，原插件没装或依赖缺失时
 * 抛在顶层会让整个 Orb 起不来 —— 面板没了可以重开，球没了就什么都没了。
 */
export function watchModules() {
  modulesCache ??= (async () => {
    try {
      const [loop, bridge] = await Promise.all([
        import(new URL('watch-loop.js', WATCH_SRC).href),
        import(new URL('position-bridge.js', WATCH_SRC).href),
      ]);
      return { loop, bridge };
    } catch (error) {
      console.error(`orb-watch: watch modules unavailable: ${error?.message ?? error}`);
      return { loop: null, bridge: null };
    }
  })();
  return modulesCache;
}

/** 只问"这个端口有人听着吗"，不发请求，不留副作用。 */
export function probePort(port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/** 拒绝一个动作：带上稳定的 code（UI 按 code 出文案，不解析 message）与 409 语义。 */
function refusal(code, text, payload) {
  const error = new Error(text);
  error.code = code;
  error.status = 409;
  error.payload = payload;
  return error;
}

const MODES = ['screen', 'video'];
const ACTIONS = ['start', 'pause', 'resume', 'stop'];

/**
 * 组装面板状态与控制入口。
 *
 * @param {object} deps
 * @param {{read:Function}} deps.store          已保存的设置（companion-settings 的 store）
 * @param {{snapshot:Function}} deps.screen     屏幕陪伴：真实运行快照
 * @param {object} deps.screenControl           屏幕陪伴的四个动作（复用原命令入口）
 * @param {object} deps.video                   视频陪看：可用性、提交指令、停循环
 * @param {Function} [deps.modules]             原插件模块加载器（测试注入）
 * @param {Function} [deps.probe]              端口探测器（测试注入）
 * @param {Function} [deps.now]                 时钟（测试注入）
 */
export function createCompanionPanel({
  store, screen, screenControl = {}, video = {},
  modules = watchModules, probe = probePort, now = Date.now,
}) {
  let revision = 1;
  let updatedAt = null;
  let lastError = null;
  let lastVideoAction = null; // 'pause' | 'stop' | null：循环停了以后靠它区分"暂停"和"停止"
  let pendingStart = 0; // 面板提交启动的时刻；0 = 没在等
  let stopping = false;
  let serviceCache = { at: -Infinity, ok: null };
  let lastVideoActive = null;
  const seen = new Map();
  let queue = Promise.resolve();

  async function service() {
    if (now() - serviceCache.at < PROBE_CACHE_MS) return serviceCache.ok;
    const ok = await probe(BRIDGE_PORT, PROBE_TIMEOUT_MS).catch(() => false);
    serviceCache = { at: now(), ok };
    return ok;
  }

  /** `loopStatus()` 的值 → 本层只保留面板用得上的字段；读炸了就 null，不是"未运行"。 */
  function readLoop(mod) {
    if (!mod) return null;
    try {
      const st = mod.loopStatus();
      const seg = st.segment ?? null;
      return {
        active: st.active === true,
        paused: st.paused === true,
        sessionId: st.session ?? null,
        segments: Number.isFinite(st.segments) ? st.segments : null,
        spoken: Number.isFinite(st.spoken) ? st.spoken : null,
        segment: seg ? {
          index: seg.index ?? null, from: seg.from ?? null, to: seg.to ?? null, total: seg.total ?? null,
        } : null,
        reason: typeof st.reason === 'string' ? st.reason.slice(0, 200) : null,
        pos: Number.isFinite(st.pos) ? st.pos : null,
        confidence: st.confidence ?? 'unknown',
        transcript: st.transcript ?? null,
        speech: st.speech ?? null,
      };
    } catch {
      return null;
    }
  }

  /**
   * 桥的三层分开取。**目录存在 ≠ 扩展已加载，端口开着 ≠ 当前视频已连上**，
   * 所以 service / extension / fresh 各是各的字段。
   */
  async function readBridge(mod, t) {
    if (!mod) return null;
    const [hello, sample, disabled] = await Promise.all([
      mod.readHello({ now: t }).catch(() => null),
      mod.readBridge({ now: t }).catch(() => null),
      typeof mod.bridgeEnabled === 'function' ? mod.bridgeEnabled() === false : false,
    ]);
    return { hello, sample, disabled };
  }

  async function snapshot() {
    const t = now();
    let saved = null;
    try {
      saved = await store.read();
    } catch (error) {
      lastError ??= { code: 'settings-invalid', text: `设置读取失败：${error?.message ?? error}`, at: t };
    }
    const mods = await modules().catch(() => ({ loop: null, bridge: null }));
    const loop = readLoop(mods.loop);
    const bridge = await readBridge(mods.bridge, t).catch(() => null);
    const scr = screen?.snapshot?.() ?? { state: 'stopped' };
    const up = await service();

    // 启动等待有上限：真起来之后这句话就该失效，别再一直显示"启动中"。
    if (pendingStart && (loop?.active || t - pendingStart > START_TIMEOUT_MS)) {
      if (!loop?.active && !lastError) {
        lastError = {
          code: 'video-not-started',
          text: '视频陪看没有启动：请确认浏览器正在播放视频、位置桥扩展已加载，然后重试。',
          at: t,
        };
      }
      pendingStart = 0;
    }
    // 后来真的起来了，就把那条"没启动起来"撤掉 —— 留着会变成一条假警报。
    if (loop?.active && lastError?.code === 'video-not-started') lastError = null;

    const fresh = Boolean(bridge?.sample);
    const videoActive = loop?.active === true;
    // 循环"开始跑/停下来"是个边沿事件：面板之外（比如用户关了浮窗）也要能通知到宿主，
    // 否则那边记着的"正在陪看"会一直不还。只上报变化，不做任何读取以外的事。
    if (videoActive !== lastVideoActive) {
      lastVideoActive = videoActive;
      try { video.onActiveChange?.(videoActive); } catch { /* 通知失败不影响状态 */ }
    }
    const screenState = scr.state ?? 'stopped';
    const runningMode = videoActive ? 'video' : (screenState === 'running' || screenState === 'paused' ? 'screen' : null);

    let phase = 'stopped';
    if (videoActive) phase = loop.paused ? 'paused' : 'running';
    else if (screenState === 'running') phase = 'running';
    else if (screenState === 'paused') phase = 'paused';
    else if (stopping) phase = 'stopping';
    else if (pendingStart) phase = 'starting';
    else if (saved?.mode === 'video' && lastVideoAction === 'pause') phase = 'paused';
    // 原插件的模块读不到时，"是不是在跑"就是不知道 —— 这比谎报"未运行"诚实。
    else if (!mods.loop && saved?.mode === 'video') phase = 'unknown';

    const selected = MODES.includes(saved?.mode) ? saved.mode : null;
    const last = loop?.transcript?.last ?? null;
    // `ctx.get('tools')` 在服务没声明时会抛：探一个能力不能把整个状态接口打挂。
    let available = false;
    try { available = video.available ? video.available() === true : false; } catch { available = false; }

    return {
      ok: true,
      revision,
      updatedAt,
      selectedMode: selected,
      runningMode,
      // 已保存的和正在跑的不是同一个模块：这是最该被看见的一种"误会"。
      mismatch: Boolean(runningMode && selected && runningMode !== selected),
      sessionId: videoActive ? loop.sessionId : (scr.sessionId ?? null),
      phase,
      // 下面三块回答"视频链路通到哪一层"，null 表示这一层查不了，不是"没有"。
      bridge: {
        service: bridge?.disabled ? 'disabled' : (up ? 'up' : 'down'),
        extension: bridge?.disabled ? 'disabled'
          : (fresh ? 'live' : (bridge?.hello ? 'seen' : 'none')),
        fresh,
        ageMs: bridge?.sample ? Math.max(0, t - bridge.sample.at) : null,
        helloAgeMs: bridge?.hello ? Math.max(0, t - bridge.hello.at) : null,
      },
      media: {
        title: bridge?.sample?.title ?? null,
        positionSeconds: bridge?.sample?.pos ?? null,
        durationSeconds: bridge?.sample?.dur ?? null,
        confidence: fresh ? 'fresh' : 'unknown',
        paused: bridge?.sample?.paused === true,
        url: bridge?.sample?.url ?? null,
      },
      transcript: {
        // 原插件的来源词表见 dsh-video-storyboard 的 transcript-pass.js；
        // 这里原样透出，翻译成中文是 UI 的事。
        source: last?.source ?? null,
        phase: loop?.transcript?.inflight != null ? 'loading' : ((loop?.transcript?.ready ?? 0) > 0 ? 'ready' : 'idle'),
        ready: loop?.transcript?.ready ?? null,
        fed: loop?.transcript?.fed ?? null,
        inflight: loop?.transcript?.inflight ?? null,
        lines: last?.lines ?? null,
      },
      screen: {
        state: screenState,
        samples: scr.samples ?? null,
        calls: scr.calls ?? null,
        spoken: scr.spoken ?? null,
        intervalSeconds: scr.intervalMs ? scr.intervalMs / 1000 : null,
        lookSeconds: scr.minGapMs ? scr.minGapMs / 1000 : null,
        speakSeconds: scr.speakGapMs ? scr.speakGapMs / 1000 : null,
        proactive: scr.proactive ?? null,
        backoff: scr.backoff ?? null,
        reason: scr.reason ?? '',
      },
      video: {
        available,
        loop: loop ? true : null,
        active: videoActive,
        paused: loop?.paused ?? null,
        segments: loop?.segments ?? null,
        spoken: loop?.spoken ?? null,
        segment: loop?.segment ?? null,
        reason: loop?.reason ?? null,
      },
      lastError,
      sources: { loop: loop ? 'module' : 'none', bridge: bridge ? 'file' : 'none' },
    };
  }

  async function run(action, options) {
    const body = await snapshot();
    if (Number.isFinite(options.expectedRevision) && options.expectedRevision !== revision) {
      throw refusal('revision-mismatch', '状态已经变了，请刷新后再试。', body);
    }
    if (action === 'start' || action === 'resume') {
      if (!body.selectedMode) throw refusal('no-mode', '请先保存要使用的陪伴模块。', body);
      // 只在"要改变在跑的是什么"时拦；暂停/停止永远允许，否则错配状态下停不掉。
      if (body.mismatch) {
        throw refusal('mode-conflict', `当前实际在运行的是${body.runningMode === 'video' ? '视频陪看' : '屏幕陪伴'}，请先停止再启动。`, body);
      }
      if (body.phase === 'starting') throw refusal('already-starting', '正在启动，请稍候。', body);
      if (body.phase === 'running') {
        throw refusal('already-running', '陪伴已经在运行；要换模块请先停止。', body);
      }
      if (action === 'resume' && body.phase !== 'paused') throw refusal('not-paused', '当前没有暂停中的陪伴。', body);
      if (body.selectedMode === 'video' && !body.video.available) {
        throw refusal('plugin-missing', '视频陪看插件尚未加载，请重启 DSH 后重试。', body);
      }
    }
    if (action === 'pause' && body.phase !== 'running') {
      throw refusal('not-running', '当前没有在运行，无法暂停。', body);
    }
    if (action === 'stop' && body.phase === 'stopped') return { ...body, noop: true };

    stopping = action === 'stop';
    // 暂停/停止要作用在**正在跑的那个模块**上：已保存是屏幕、实际在跑视频时，
    // 按"已保存"去停只会停掉一个没在跑的东西，视频循环还在后台说话。
    const target = (action === 'pause' || action === 'stop') && body.runningMode
      ? body.runningMode
      : body.selectedMode;
    if (!target) throw refusal('no-mode', '请先保存要使用的陪伴模块。', body);
    try {
      if (target === 'video') {
        if (action === 'start' || action === 'resume') {
          await video.submit?.(action === 'resume' ? 'resume' : 'start');
          pendingStart = now();
          lastVideoAction = null;
        } else {
          await video.stop?.(action === 'pause' ? 'panel-pause' : 'panel-stop');
          pendingStart = 0;
          lastVideoAction = action === 'pause' ? 'pause' : 'stop';
        }
      } else {
        await screenControl[action]?.();
        lastVideoAction = null;
      }
      lastError = null;
      revision += 1;
      updatedAt = now();
    } catch (error) {
      lastError = { code: error?.code ?? 'control-failed', text: error?.message ?? String(error), at: now() };
      throw error;
    } finally {
      stopping = false;
    }
    return snapshot();
  }

  return {
    status: snapshot,
    /** 串行执行：连点两下只会跑第一个，第二个看到的是已经变过的状态。 */
    control(action, options = {}) {
      if (!ACTIONS.includes(action)) throw refusal('unknown-action', '未知的陪伴动作。', null);
      const requestId = typeof options.requestId === 'string' ? options.requestId.slice(0, 80) : null;
      if (requestId && seen.has(requestId)) return Promise.resolve({ ...(seen.get(requestId)), replay: true });
      const task = queue.then(async () => {
        const result = await run(action, options);
        if (requestId) {
          if (seen.size >= REQUEST_MEMORY) seen.clear();
          seen.set(requestId, result);
        }
        return result;
      });
      queue = task.catch(() => {});
      return task;
    },
    /** 停掉计时器/测试句柄；面板本身没有后台任务，这里只保留接口。 */
    dispose() {
      seen.clear();
    },
  };
}
