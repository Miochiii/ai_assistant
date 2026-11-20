import { runOfflineCheck } from './offline-check.js';
import { ModelCheck } from './model-check.js';
import { ModelWatch } from './model-watch.js';
import { PanelSession } from './panel-session.js';
import { PanelChatModel } from './panel-model.js';

export const name = 'dsh-assistant-host';
export const inject = ['commands', 'attachments', 'llm', 'sessionController'];

/**
 * RH04: human commands only. `/assistant-check` is offline; the model probe is
 * an explicit one-frame async wake. No automatic capture, input or actions.
 */
export function apply(ctx) {
  const disposers = [];
  const checks = new Map();
  const watches = new Map();
  const panels = new Map();

  const sessionIdOf = invocation => {
    const id = invocation?.agent?.session?.header?.id;
    if (typeof id !== 'string' || !id) throw new Error('当前命令没有会话 ID');
    return id;
  };

  const modelRoute = session => {
    const { model, provider } = session.header.config ?? {};
    return { model, provider };
  };

  const checkFor = (sessionId, session) => {
    let check = checks.get(sessionId);
    if (!check) {
      check = new ModelCheck({
        ctx,
        sessionId,
        route: modelRoute(session),
        onReply: text => panels.get(sessionId)?.publish(text),
      });
      check.start();
      checks.set(sessionId, check);
    }
    return check;
  };

  const panelFor = (sessionId, session) => {
    let panel = panels.get(sessionId);
    if (!panel) {
      panel = new PanelSession({
        sessionId,
        ctx,
        route: modelRoute(session),
        model: new PanelChatModel({ ctx, sessionId, session, route: modelRoute(session) }),
      });
      panels.set(sessionId, panel);
    }
    return panel;
  };

  disposers.push(ctx.commands.register({
    definitionId: 'dsh-assistant-host/assistant-check',
    name: 'assistant-check',
    description: '离线检查常驻助手状态机、任务隔离和消息通道；不截图、不请求模型、不操作桌面',
    recordInput: false,
    async handler(invocation) {
      if (invocation.rawInput?.trim() || invocation.attachments?.length) {
        return { kind: 'error', text: '请只执行 /assistant-check，不附带文字或文件。' };
      }
      try {
        const report = await runOfflineCheck();
        return {
          kind: 'success',
          text: `常驻助手离线自检通过：${report.checks.length} 项；未截图、未请求模型、未操作桌面。\n记录：${report.root}`,
        };
      } catch (error) {
        return { kind: 'error', text: `常驻助手离线自检失败：${error?.message ?? error}` };
      }
    },
  }));

  disposers.push(ctx.commands.register({
    definitionId: 'dsh-assistant-host/assistant-model-check',
    name: 'assistant-model-check',
    description: '抓取当前屏幕一帧并异步交给独立看屏请求；不执行鼠标键盘，不等待模型回复',
    recordInput: false,
    async handler(invocation) {
      if (invocation.rawInput?.trim() || invocation.attachments?.length) {
        return { kind: 'error', text: '请只执行 /assistant-model-check，不附带文字或文件。' };
      }
      try {
        const check = checkFor(sessionIdOf(invocation), invocation.agent.session);
        const result = await check.request();
        if (!result.ok) {
          return { kind: 'error', text: `模型探测未发送：${result.reason}（${result.request_id ?? ''}）` };
        }
        return {
          kind: 'success',
          text: `已提交独立看屏请求，可在面板查看发言。\n`
            + `request：${result.request_id}\nframe：${result.frame_id}\n`
            + `不要重复执行；稍后可用 /assistant-model-status 查看是否收到回复。\n`
            + '本次没有执行鼠标键盘或桌面动作。',
        };
      } catch (error) {
        return { kind: 'error', text: `模型探测失败：${error?.message ?? error}` };
      }
    },
  }));

  disposers.push(ctx.commands.register({
    definitionId: 'dsh-assistant-host/assistant-highlight',
    name: 'assistant-highlight',
    description: '在当前屏幕用 OCR 定位并显示一个只读高亮框；可选目标文字，不执行输入',
    input: { hint: '屏幕上要引导的目标文字', attachments: false },
    recordInput: false,
    async handler(invocation) {
      if (invocation.attachments?.length) {
        return { kind: 'error', text: '这个命令不接受附件。' };
      }
      const target = invocation.rawInput?.trim() ?? '';
      if (!target) return { kind: 'error', text: '用法：/assistant-highlight 要定位的文字' };
      try {
        const sessionId = sessionIdOf(invocation);
        const panel = panelFor(sessionId, invocation.agent.session);
        await panel.open();
        const highlight = await panel.highlightTarget(target);
        return {
          kind: 'success',
          text: `已高亮目标“${target}”。\n`
            + `框：${highlight.rect.join(',')}\n`
            + '只显示，不点击、不输入。用 /assistant-highlight-clear 隐藏。',
        };
      } catch (error) {
        return { kind: 'error', text: `高亮失败：${error?.message ?? error}` };
      }
    },
  }));

  disposers.push(ctx.commands.register({
    definitionId: 'dsh-assistant-host/assistant-highlight-clear',
    name: 'assistant-highlight-clear',
    description: '隐藏当前只读高亮框；不执行输入',
    recordInput: false,
    async handler(invocation) {
      if (invocation.rawInput?.trim() || invocation.attachments?.length) {
        return { kind: 'error', text: '请只执行 /assistant-highlight-clear。' };
      }
      try {
        const panel = panels.get(sessionIdOf(invocation));
        if (!panel) return { kind: 'success', text: '本会话没有打开助手面板。' };
        panel.clearHighlight('command');
        return { kind: 'success', text: '高亮已隐藏。' };
      } catch (error) {
        return { kind: 'error', text: `隐藏高亮失败：${error?.message ?? error}` };
      }
    },
  }));

  disposers.push(ctx.commands.register({
    definitionId: 'dsh-assistant-host/assistant-open',
    name: 'assistant-open',
    description: '打开 Orb 悬浮球助手；不截图、不启动模型、不操作桌面',
    recordInput: false,
    async handler(invocation) {
      if (invocation.rawInput?.trim() || invocation.attachments?.length) {
        return { kind: 'error', text: '请只执行 /assistant-open，不附带文字或文件。' };
      }
      try {
        const sessionId = sessionIdOf(invocation);
        const panel = panelFor(sessionId, invocation.agent.session);
        const result = await panel.open();
        return {
          kind: 'success',
          text: `Orb 悬浮球助手已${result.already ? '在运行' : '打开'}。\n`
            + `ui_pid：${result.ui_pid ?? '-'}\n`
            + '悬停展开、点击固定、拖动移动；Enter 发送，Shift+Enter 换行。右键打开菜单。不会自动启动模型观察。',
        };
      } catch (error) {
        return { kind: 'error', text: `打开助手面板失败：${error?.message ?? error}` };
      }
    },
  }));

  disposers.push(ctx.commands.register({
    definitionId: 'dsh-assistant-host/assistant-close',
    name: 'assistant-close',
    description: '关闭紧凑常驻助手面板；不做桌面输入',
    recordInput: false,
    async handler(invocation) {
      if (invocation.rawInput?.trim() || invocation.attachments?.length) {
        return { kind: 'error', text: '请只执行 /assistant-close，不附带文字或文件。' };
      }
      try {
        const sessionId = sessionIdOf(invocation);
        const panel = panels.get(sessionId);
        if (!panel) return { kind: 'success', text: '本会话没有打开助手面板。' };
        await panel.close('command');
        panels.delete(sessionId);
        return { kind: 'success', text: '助手面板已关闭。' };
      } catch (error) {
        return { kind: 'error', text: `关闭助手面板失败：${error?.message ?? error}` };
      }
    },
  }));

  disposers.push(ctx.commands.register({
    definitionId: 'dsh-assistant-host/assistant-model-watch',
    name: 'assistant-model-watch',
    description: '显式启动 mss 观察 + SceneWake + 当前 DSH 模型；可选扫描间隔秒数，常驻直到手动停止',
    input: { hint: '扫描间隔秒数（1–60，可选，默认 8）', attachments: false },
    recordInput: false,
    async handler(invocation) {
      if (invocation.attachments?.length) {
        return { kind: 'error', text: '这个命令不接受附件。' };
      }
      const raw = invocation.rawInput?.trim() ?? '';
      const seconds = raw === '' ? 8 : Number(raw);
      if (!Number.isFinite(seconds) || seconds < 1 || seconds > 60) {
        return { kind: 'error', text: '用法：/assistant-model-watch [扫描间隔秒数 1–60]，默认 8。' };
      }
      const scanIntervalMs = Math.round(seconds * 1000);
      try {
        const sessionId = sessionIdOf(invocation);
        const panel = panelFor(sessionId, invocation.agent.session);
        await panel.open();
        let watch = watches.get(sessionId);
        if (watch && watch.scanIntervalMs !== scanIntervalMs) {
          watch.stop('interval-change');
          watches.delete(sessionId);
          watch = null;
        }
        if (!watch) {
          const route = modelRoute(invocation.agent.session);
          watch = new ModelWatch({
            ctx, sessionId,
              isSuppressed: () => {
                const task=panels.get(sessionId)?.host?.state.task;
                return Boolean(task && task.status !== 'complete');
              },
            makeCheck: () => new ModelCheck({ ctx, sessionId, route }),
            scanIntervalMs,
            captureIntervalMs: Math.min(2000, scanIntervalMs),
            onReply: text => panels.get(sessionId)?.publish(text),
          });
          watches.set(sessionId, watch);
        }
        const result = await watch.start();
        return {
          kind: 'success',
          text: `模型观察已${result.already ? '在运行' : '启动'}，扫描间隔 ${seconds} 秒；`
            + '本地门控只放行候选帧，SceneWake 限速后才调用模型。\n'
            + '只把 speak=true 写入助手面板；静默会退避但不会自动停止，'
            + '循环保持常驻直到 /assistant-model-stop。\n'
            + '不执行鼠标键盘。',
        };
      } catch (error) {
        return { kind: 'error', text: `启动模型观察失败：${error?.message ?? error}` };
      }
    },
  }));

  disposers.push(ctx.commands.register({
    definitionId: 'dsh-assistant-host/assistant-model-stop',
    name: 'assistant-model-stop',
    description: '停止由 /assistant-model-watch 启动的观察和模型唤醒；不做桌面输入',
    recordInput: false,
    async handler(invocation) {
      if (invocation.rawInput?.trim() || invocation.attachments?.length) {
        return { kind: 'error', text: '请只执行 /assistant-model-stop，不附带文字或文件。' };
      }
      try {
        const sessionId = sessionIdOf(invocation);
        const watch = watches.get(sessionId);
        if (!watch) return { kind: 'success', text: '本会话没有正在运行的模型观察。' };
        watch.stop('command');
        watches.delete(sessionId);
        return { kind: 'success', text: '模型观察已停止；不会继续抓帧或唤醒模型。' };
      } catch (error) {
        return { kind: 'error', text: `停止模型观察失败：${error?.message ?? error}` };
      }
    },
  }));

  disposers.push(ctx.commands.register({
    definitionId: 'dsh-assistant-host/assistant-model-status',
    name: 'assistant-model-status',
    description: '查看独立看屏请求的结果或常驻观察状态；不请求模型',
    recordInput: false,
    async handler(invocation) {
      if (invocation.rawInput?.trim() || invocation.attachments?.length) {
        return { kind: 'error', text: '请只执行 /assistant-model-status，不附带文字或文件。' };
      }
      try {
        const sessionId = sessionIdOf(invocation);
        const watch = watches.get(sessionId);
        const watchStatus = watch?.status?.() ?? null;
        const watchLine = watchStatus
          ? `\n观察：${watchStatus.started ? '运行中' : '已停止'}；`
            + `模型调用 ${watchStatus.model_calls}/${watchStatus.max_model_calls}；`
            + `静默连击 ${watchStatus.gate?.silent_streak ?? 0}/${watchStatus.gate?.max_silent ?? 3}；`
            + `门控 ${watchStatus.gate?.last_reason ?? '-'}`
          : '';
        const check = checks.get(sessionId);
        if (!check) {
          if (!watchStatus) return { kind: 'success', text: '还没有在本会话发起模型探测。' };
          return {
            kind: 'success',
            text: `模型观察${watchStatus.started ? '运行中' : '已停止'}。` + watchLine,
          };
        }
        const status = await check.status();
        if (status.status === 'pending') {
          return { kind: 'success', text: `模型探测等待回复：${status.request_id}` + watchLine };
        }
        if (status.status === 'failed') return { kind: 'error', text: '独立看屏请求失败。' };
        if (status.status === 'received') {
          return {
            kind: 'success',
            text: `模型回复（${status.result.request_id}）：\n${status.result.text}\n`
              + `speak：${status.result.speak}\nframe：${status.result.frame_id ?? '-'}`
              + watchLine + '\n未执行桌面动作。',
          };
        }
        return { kind: 'success', text: '本会话没有待处理的模型探测。' + watchLine };
      } catch (error) {
        return { kind: 'error', text: `读取模型探测状态失败：${error?.message ?? error}` };
      }
    },
  }));

  return () => {
    for (const watch of watches.values()) watch.stop('plugin-dispose');
    watches.clear();
    for (const check of checks.values()) check.stop();
    checks.clear();
    for (const panel of panels.values()) { void panel.close('plugin-dispose'); }
    panels.clear();
    for (const dispose of disposers) {
      try { dispose?.(); } catch { /* cleanup best effort */ }
    }
  };
}
