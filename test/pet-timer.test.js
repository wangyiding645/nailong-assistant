'use strict';
/* 桌宠形态机：闹钟/倒计时不能被形态切换清掉（原来切一次形态就静默消失，到点不响也不笑） */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function stubEl() {
  return {
    style: {}, className: '', innerHTML: '', textContent: '', offsetWidth: 0,
    classList: { add() {}, remove() {}, contains: () => false },
    addEventListener() {}, setAttribute() {}, getAttribute() { return null; },
    appendChild() {}, contains: () => false, setPointerCapture() {}, releasePointerCapture() {}
  };
}

function boot() {
  const els = {};
  const handlers = {};
  const api = {
    petInit: async () => ({
      tasks: '09:00|早会\n',
      countdown: '',
      state: { settings: { sound: true } },
      settings: { sound: true },
      theme: 0, locale: 'zh-CN', mode: 'normal', focus: null, petScale: 1
    }),
    saveSchedule: async () => true,
    recyclePaths: async () => ({ ok: 0 }),
    reminderSnooze: async () => {},
    toggleDone: async () => {},
    petGrow: async () => 1,
    petEvent() {}, petMoveBy() {}, togglePopup() {}, openModeMenu() {}, openAssistant() {},
    askDone() {}, dropSubmit() {}
  };
  ['onTasksChanged', 'onCountdownChanged', 'onThemeChanged', 'onSettingsChanged', 'onPanelState',
    'onAssistantState', 'onAgentEvent', 'onCelebrate', 'onFocusChanged', 'onModeChanged',
    'onPetPing', 'onFilesDropped', 'onFilesDrag'].forEach((k) => { api[k] = (cb) => { handlers[k] = cb; }; });

  const sandbox = {
    console,
    widgets: null,
    URLSearchParams,
    location: { search: '' },
    document: {
      body: stubEl(),
      getElementById(id) { return (els[id] = els[id] || stubEl()); },
      addEventListener() {}
    },
    requestAnimationFrame() {},
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    WidgetLogic: require(path.join(ROOT, 'src/shared/logic.js')),
    WidgetTask: require(path.join(ROOT, 'src/shared/task.js')),
    WidgetRepeat: require(path.join(ROOT, 'src/shared/repeat.js')),
    WidgetI18n: { t: (k) => k, setLocale() {}, applyDom() {} }
  };
  sandbox.window = sandbox;
  sandbox.widget = api;
  sandbox.window.addEventListener = () => {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'renderer', 'pet.js'), 'utf8'), sandbox, { filename: 'pet.js' });
  return {
    sandbox,
    ping: (p) => handlers.onPetPing(p),
    mode: (m) => handlers.onModeChanged(m),
    get: (expr) => vm.runInContext(expr, sandbox),
    run: (stmt) => vm.runInContext(stmt, sandbox)
  };
}

async function ready() {
  const ctx = boot();
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
  return ctx;
}

const hm = () => {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
};

test('切形态不会清掉闹钟和倒计时', async () => {
  const ctx = await ready();
  ctx.ping({ action: 'alarm-set', hm: '07:30' });
  ctx.ping({ action: 'countdown-start', endAt: Date.now() + 60000, min: 1 });
  ctx.mode('assistant');
  assert.equal(ctx.get('state.mode'), 'assistant');
  assert.ok(ctx.get('state.alarm'), '切到助手形态后闹钟还在');
  assert.ok(ctx.get('state.cd'), '切到助手形态后倒计时还在');
});

test('闹钟到点时不管在哪个形态都跳、都能点停', async () => {
  const ctx = await ready();
  ctx.ping({ action: 'alarm-set', hm: hm() });
  ctx.mode('assistant');
  ctx.run('tick()');
  assert.equal(ctx.get('state.alarm.ringing'), true, '到点要响');
  assert.equal(ctx.get('currentAnim()'), 'jumping', '助手形态下也要跳');
  assert.equal(ctx.get('dismissPending()'), true, '点一下能停');
  assert.equal(ctx.get('state.alarm'), null);
});

test('倒计时到点在别的形态也算数，并且能点掉', async () => {
  const ctx = await ready();
  ctx.ping({ action: 'countdown-start', endAt: Date.now() - 10, min: 1 });
  ctx.mode('normal');
  ctx.run('tick()');
  assert.equal(ctx.get('state.cd.done'), true, '到点要标记完成');
  assert.equal(ctx.get('dismissPending()'), true, '点一下能收掉');
  assert.equal(ctx.get('state.cd'), null);
});

test('没有闹钟也没倒计时时，点击照旧走原来的形态逻辑', async () => {
  const ctx = await ready();
  assert.equal(ctx.get('dismissPending()'), false);
});
