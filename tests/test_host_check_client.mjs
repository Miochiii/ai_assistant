import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../plugins/dsh-desktop-observe/client.js', import.meta.url), 'utf8');
function mount() {
  let descriptor, listener, disposed = false;
  const notifications = [];
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: value => { descriptor = value; } } } });
  assert.equal(descriptor.id, 'dsh-desktop-observe');
  const scope = { get: name => name === 'conversation' ? {input:{for: actual => {
    assert.equal(actual, scope);return {notify:(level,text)=>notifications.push({level,text})};
  }}} : undefined };
  const dispose = descriptor.factory().apply({
    sessions: {scope: id => id === 'test-session' ? scope : undefined},
    on: (event, fn) => {assert.equal(event, 'command/executed');listener = fn;return ()=>{disposed=true;};},
  });
  return {fire:(...args)=>listener(...args),notifications,dispose,isDisposed:()=>disposed};
}
test('fresh-session command success appears without any chat timeline or model message',()=>{
  const app=mount();app.fire('test-session','desktop-check',{kind:'success',text:'检查通过'});
  assert.deepEqual(app.notifications,[{level:'info',text:'检查通过'}]);
  app.dispose();assert.equal(app.isDisposed(),true);
});

test('isolated trial command returns its result through the same visible notice',()=>{
  const app=mount();app.fire('test-session','desktop-trial',{kind:'success',text:'离线识别通道通过'});
  assert.deepEqual(app.notifications,[{level:'info',text:'离线识别通道通过'}]);
});

test('dedicated offline command result is visible',()=>{
  const app=mount();app.fire('test-session','desktop-offline',{kind:'success',text:'零费用自检通过'});
  assert.deepEqual(app.notifications,[{level:'info',text:'零费用自检通过'}]);
});
test('command failure is visible and unrelated commands remain untouched',()=>{
  const app=mount();app.fire('test-session','desktop-check',{kind:'error',text:'读取失败'});
  app.fire('test-session','feedback',{kind:'success',text:'unrelated'});
  assert.deepEqual(app.notifications,[{level:'error',text:'读取失败'}]);
});
test('closed sessions and malformed results do not notify another conversation',()=>{
  const app=mount();app.fire('closed-session','desktop-check',{kind:'success',text:'old result'});
  for(const value of [undefined,{}, {kind:'success',text:''},{kind:'unexpected',text:'bad'}])
    app.fire('test-session','desktop-check',value);
  assert.deepEqual(app.notifications,[]);
});
