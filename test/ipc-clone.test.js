'use strict';
/*
 * IPC 返回值必须能被结构化克隆。
 *
 * 为什么要有这个测试：`agent-session-load` 曾经把没 await 的 async 结果塞进返回对象，
 * 于是 Electron 克隆不了 Promise，整个 invoke 直接 reject（"An object could not be cloned"），
 * 界面只能看着没反应 —— 而且因为界面上失败是静默的，这个 bug 藏了很久。
 * 这里把所有「返回对象」的处理器都真调一遍，断言：
 *   1) 不会 reject
 *   2) 返回值能 structuredClone（Electron 内部用的就是这套序列化）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const handlers = new Map();
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') {
    return {
      ipcMain: {
        handle: (channel, fn) => handlers.set(channel, fn),
        removeHandler: (channel) => handlers.delete(channel),
        on: () => {}
      },
      app: { getVersion: () => '0.0.0-test', getPath: () => process.cwd(), quit() {}, on() {} },
      shell: { openPath: async () => '', openExternal: async () => true },
      clipboard: { readText: () => '', writeText: () => {}, readImage: () => ({ isEmpty: () => true }) },
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
    };
  }
  return originalLoad.call(this, name, ...args);
};
const { registerIpc } = require('../src/main/ipc.js');
Module._load = originalLoad;

// 假的服务层：async 方法一律真的 async（真实路由器也是这样），这样漏掉的 await 会被抓住
function fakeCtx() {
  const policy = { mode: 'auto', allow: {}, deny: {}, confirmHighRisk: false, maxSteps: 0 };
  const settings = {
    get: () => ({ sound: true, pet: { scale: 1 }, agent: { policy: policy, disabledTools: {}, locale: 'zh-CN' } }),
    getKey: (k, d) => d,
    set: () => {},
    setKey: () => {},
    agentCfg: () => ({ policy: policy, workspace: '', autoCompaction: true, autoRetry: true }),
    reminder: () => ({ preMinutes: 5, catchUpMinutes: 30, toast: true }),
    store: { saveNow: () => true }
  };
  const agentSvc = {
    async loadSession(id) { return { id: id, title: 't', messages: [], transcript: [{ kind: 'user', text: 'hi' }], repaired: null }; },
    async newSession() { return { id: 'new' }; },
    async deleteSession() { return true; },
    async usageDetail() { return { total: { calls: 0 }, byDay: [] }; },
    async sessionStats() { return {}; },
    async send() { return true; },
    async clear() { return true; },
    async cloneSession() { return { cancelled: false }; },
    async forkSession() { return { cancelled: false, transcript: [] }; },
    async sessionTree() { return { tree: [], leafId: '' }; },
    listSessions() { return { list: [], current: null, engine: 'pi' }; },
    engineInfo() { return { active: 'pi', pi: { ready: true } }; },
    publicConfig() { return { model: 'x', hasKey: true }; },
    toolset: { catalog: () => [] },
    stop() { return true; }
  };
  return {
    services: {
      settings,
      stateObj: () => ({ done: {}, completedDays: [], settings: { sound: true } }),
      schedule: { readText: () => '', toggleDone: () => ({}), writeText: () => {} },
      countdown: { readText: () => '', writeText: () => {} },
      focus: { status: () => ({ phase: 'idle' }), config: () => ({}), tick: () => null },
      memory: { list: () => [] },
      clipboard: { list: () => [], push: () => {} },
      stats: { summary: () => ({}) },
      reminders: { firedMap: () => ({}) },
      saveState: () => {}
    },
    windows: { broadcast: () => {}, send: () => {}, get: () => null, SIZES: { pet: { w: 190, h: 230 } }, petSize: () => ({ w: 190, h: 230 }), petScale: () => 1, applyPetScale: () => {} },
    host: { readImageFile: () => ({ ok: false }), recycle: async () => ({ ok: 0 }), playSystemSound: async () => ({}) },
    agentSvc,
    shell: { applyHotkeys: () => {}, applyAutoStart: () => {}, autoStartEnabled: () => false, hotkeys: () => ({}) },
    log: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
    appState: { mode: 'normal' },
    setMode: () => {},
    applyAsstPin: () => {},
    togglePanel: () => {},
    refreshBackdrop: () => {},
    handleDrop: () => ({}),
    catchPet: () => false,
    returnPetHome: () => true
  };
}

registerIpc(fakeCtx());

const cloneable = (label, value) => {
  assert.doesNotThrow(() => structuredClone(value), label + ' 的返回值不能被结构化克隆（大概率是把 Promise 塞进返回对象了）');
};

test('IPC：会话相关的处理器都不会 reject，返回值都能克隆', async () => {
  for (const [channel, payload] of [
    ['agent-sessions', undefined],
    ['agent-session-load', { id: 'D:\\x\\s.jsonl' }],
    ['agent-session-new', undefined],
    ['agent-session-delete', { id: 'D:\\x\\s.jsonl' }],
    ['agent-session-stats', undefined],
    ['agent-session-tree', undefined],
    ['agent-session-clone', undefined],
    ['agent-usage', undefined],
    ['agent-engine', undefined],
    ['agent-cfg-get', undefined],
    ['tools-list', undefined],
    ['settings-get', undefined],
    ['app-init', undefined],
    ['pet-init', undefined]
  ]) {
    const fn = handlers.get(channel);
    assert.ok(fn, '缺少处理器：' + channel);
    let result = null;
    await assert.doesNotReject(async () => { result = await fn({ sender: null, senderFrame: null }, payload); }, channel + ' 不该 reject');
    cloneable(channel, result);
  }
});

test('IPC：加载历史会话返回的是「已解析的对象」，不是嵌套的 Promise', async () => {
  const r = await handlers.get('agent-session-load')(null, { id: 'D:\\x\\s.jsonl' });
  assert.equal(r.ok, true);
  assert.equal(r.session.id, 'D:\\x\\s.jsonl');
  assert.equal(Array.isArray(r.session.transcript), true);
  assert.equal(r.session.transcript[0].text, 'hi');
  assert.equal(typeof r.session.then, 'undefined', 'session 不能是 Promise');
});
