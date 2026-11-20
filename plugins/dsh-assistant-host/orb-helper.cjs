// Adapter for the MIT Orb renderer/placement, owned by our existing Host channel.
const { app, BrowserWindow, ipcMain, screen, Menu, clipboard, shell, nativeTheme } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const directory = process.argv[process.argv.indexOf('--channel-dir') + 1];
if (!directory || !path.isAbsolute(directory)) throw Error('Absolute channel directory required');
const read = name => {
  try { return JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')); } catch { return null; }
};
const instance = read('instance.json');
if (!instance?.assistant_session_id) throw Error('Missing Host instance');
app.setPath('userData', path.join(directory, 'orb-profile'));
// The project panel has a fixed light gradient, so its tokens must stay light too.
nativeTheme.themeSource = 'light';
let win, placement, sequence = 0, timer;
const seen = new Set();
const displayed = [];
function block(value) {
  send('block', { type: 'block', ...value });
  displayed.push(value.key);
  if (displayed.length > 100) send('block-drop', displayed.shift());
}
function write(name, value) {
  const dest = path.join(directory, name), temp = dest + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value));
  fs.renameSync(temp, dest);
}
function send(name, value) {
  if (win && !win.isDestroyed()) win.webContents.send('orb:' + name, value);
}
function submit(kind, payload = {}) {
  const state = read('state.json');
  if (state?.assistant_session_id !== instance.assistant_session_id || state.assistant === 'closed') return;
  const id = randomUUID();
  write('inbox/' + String(Date.now()).padStart(15, '0') + '-' + id + '.json', {
    schema_version: 1, event_id: id, assistant_session_id: instance.assistant_session_id,
    kind, client_seq: ++sequence, context_epoch: state.context_epoch, task_id: state.task?.task_id ?? null,
    created_at: new Date().toISOString(), payload,
  });
}
function prompt(text) {
  if (typeof text !== 'string' || !text.trim() || [...text].length > 8192) return;
  submit('chat_submit', { text: text.trim() });
  block({ key: randomUUID(), kind: 'user', text: text.trim() });
}
function fromWindow(event) { return event.sender === win?.webContents; }
function on(name, fn) {
  ipcMain.on('orb:' + name, (event, ...args) => { if (fromWindow(event)) fn(...args); });
}
function handle(name, fn) {
  ipcMain.handle('orb:' + name, (event, ...args) => {
    if (!fromWindow(event)) throw Error('Unknown renderer');
    return fn(...args);
  });
}
async function main() {
  const { FloatingPlacement, initialWindowBounds } = await import(pathToFileURL(path.join(__dirname, 'vendor/orb/geometry.js')));
  await app.whenReady();
  win = new BrowserWindow({
    ...initialWindowBounds(screen.getPrimaryDisplay().workArea),
    title: '鲸鱼助手', frame: false, transparent: true, alwaysOnTop: true,
    resizable: false, skipTaskbar: true, show: false, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'vendor/orb/preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  placement = new FloatingPlacement(win, point => screen.getDisplayNearestPoint(point),
    () => screen.getAllDisplays().map(display => display.bounds));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('console-message', (_event, details) => {
    if (details.level === 'error') console.error('Orb renderer:', details.message);
  });
  win.webContents.on('will-navigate', event => event.preventDefault());
  on('drag-press', () => placement.press(screen.getCursorScreenPoint()));
  on('drag-begin', () => placement.beginDrag());
  on('drag-move', canDock => placement.dragTo(screen.getCursorScreenPoint(), canDock !== false));
  handle('drag-end', canDock => placement.endDrag(screen.getCursorScreenPoint(), canDock !== false));
  handle('unsnap', () => placement.unsnap());
  handle('expand', expanded => placement.setExpanded(Boolean(expanded)));
  handle('sync-strip', () => placement.setStrip(0));
  handle('tcc-status', () => null);
  on('prompt', prompt);
  on('stop', () => submit('stop_response'));
  on('copy', text => { if (typeof text === 'string') clipboard.writeText(text.slice(0, 64000)); });
  on('open-external', url => { if (typeof url === 'string' && /^https?:\/\//i.test(url)) void shell.openExternal(url); });
  const openMenu = () => {
    Menu.buildFromTemplate([
      { label: '检查当前步骤', enabled: Boolean(read('state.json')?.task), click: () => submit('check_step') },
      { label: '暂停指导观察', enabled: Boolean(read('state.json')?.task), click: () => submit('pause_observation') },
      { label: '继续指导观察', enabled: Boolean(read('state.json')?.task), click: () => submit('resume_observation') },
      { label: '结束指导', enabled: Boolean(read('state.json')?.task), click: () => submit('end_task') },
      { type: 'separator' },
      { label: '指导时一次只说一步', click: () => prompt('指导时使用：一次只说一步') },
      { label: '指导时先给概览', click: () => prompt('指导时使用：先给概览') },
      { label: '查看指导偏好', click: () => prompt('查看指导偏好') },
      { label: '停用指导偏好', click: () => prompt('停用指导偏好') },
      { type: 'separator' },
      { label: '关闭助手', click: () => { submit('close_assistant'); app.quit(); } },
    ]).popup({ window: win });
  };
  handle('menu', openMenu);
  win.webContents.on('context-menu', openMenu);
  await win.loadFile(path.join(__dirname, 'vendor/orb/assets/floating.html'));
  send('appearance', { locale: 'zh-CN', theme: 'light' });
  send('permission', 'read-only');
  send('session', instance.assistant_session_id);
  win.showInactive();
  if (process.argv.includes('--diagnostics')) {
    const dom = await win.webContents.executeJavaScript(`({
      title: document.title, api: typeof window.dshOrb, classes: document.body.className,
      ball: document.querySelector('#ball').getBoundingClientRect().toJSON()
    })`);
    write('ui-diagnostics.json', dom);
  }
  write('ui-ready.json', { assistant_session_id: instance.assistant_session_id, pid: process.pid });
  let running, hiddenForCapture = false;
  timer = setInterval(() => {
    try {
      try { process.kill(instance.pid, 0); } catch { app.quit(); return; }
      const state = read('state.json');
      if (state?.assistant_session_id !== instance.assistant_session_id || state.assistant === 'closed') { app.quit(); return; }
      const capture = read('capture-visibility.json');
      if (capture?.id && Date.now() < capture.expires) {
        if (!hiddenForCapture) win.hide();
        hiddenForCapture = true;
        write('capture-hidden.json', { id: capture.id });
      } else if (hiddenForCapture) {
        hiddenForCapture = false;
        win.showInactive();
      }
      const busy = Boolean(state.model_request);
      if (running !== busy) { running = busy; send('turn', { running }); }
      send('status', state.task ? state.task.title : '鲸鱼助手');
      const files = fs.readdirSync(path.join(directory, 'outbox')).filter(name => name.endsWith('.json')).sort();
      const currentFiles = new Set(files);
      for (const file of seen) if (!currentFiles.has(file)) seen.delete(file);
      for (const file of files) {
        if (seen.has(file)) continue;
        const message = read('outbox/' + file);
        if (message?.assistant_session_id !== instance.assistant_session_id) continue;
        seen.add(file);
        block({ key: message.message_id, kind: 'assistant', text: message.text, response: true });
      }
      write('ui-heartbeat.json', { assistant_session_id: instance.assistant_session_id, pid: process.pid,
        focused: win.isFocused(), at: new Date().toISOString() });
    } catch (error) { send('status', '通道读取失败：' + error.message); }
  }, 250);
  win.on('closed', () => app.quit());
}
app.on('before-quit', () => clearInterval(timer));
main().catch(error => { console.error(error); app.exit(1); });
