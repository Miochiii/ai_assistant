// Offline renderer integration fixture; use only through preview_orb.mjs --smoke.
const { BrowserWindow, app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = process.argv[process.argv.indexOf('--channel-dir') + 1];
if (!fs.existsSync(path.join(root, 'offline-fixture'))) throw Error('Offline fixture required');
require('../plugins/dsh-assistant-host/orb-helper.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  await app.whenReady();
  for (let i = 0; i < 100 && !fs.existsSync(path.join(root, 'ui-ready.json')); i++) await delay(100);
  const win = BrowserWindow.getAllWindows()[0];
  const evaluate = code => win.webContents.executeJavaScript(code);
  assert.equal(await evaluate('typeof window.dshOrb'), 'object');
  await evaluate(`document.querySelector('#ball').dispatchEvent(new PointerEvent('pointerup', {button:0}))`);
  await delay(600);
  assert.ok(win.getBounds().width >= 320);
  await evaluate(`document.querySelector('#prompt').textContent = '离线通道测试';
    document.querySelector('#prompt').dispatchEvent(new Event('input', {bubbles:true}));
    document.querySelector('#composer').dispatchEvent(new Event('submit', {bubbles:true,cancelable:true}));`);
  let transcript = '';
  for (let i = 0; i < 50; i++) {
    await delay(100);
    transcript = await evaluate(`document.querySelector('#transcript').textContent`);
    if (transcript.includes('这是离线界面测试')) break;
  }
  assert.match(transcript, /离线通道测试/);
  assert.match(transcript, /这是离线界面测试/);
  const colors = await evaluate(`({dark:matchMedia('(prefers-color-scheme: dark)').matches,
    reply:getComputedStyle(document.querySelector('.am .md') ?? document.querySelector('.am')).color,
    input:getComputedStyle(document.querySelector('#prompt')).color})`);
  assert.equal(colors.dark,false);
  assert.equal(colors.reply,'rgb(0, 0, 0)');
  assert.equal(colors.input,'rgb(0, 0, 0)');
  fs.writeFileSync(path.join(root, 'capture-visibility.json'), JSON.stringify({id:'smoke-hide', expires:Date.now()+5000}));
  await delay(700);
  assert.equal(win.isVisible(), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'capture-hidden.json'))).id, 'smoke-hide');
  fs.unlinkSync(path.join(root,'capture-visibility.json'));
  await delay(700);
  assert.equal(win.isVisible(), true);
  fs.writeFileSync(path.join(root, 'smoke-result.json'), JSON.stringify({ok:true, checks:['renderer','expand','prompt','reply','black-text','hide-ack','restore']}));
})().catch(error => {
  fs.writeFileSync(path.join(root,'smoke-result.json'), JSON.stringify({ok:false,error:error.stack}));
});
