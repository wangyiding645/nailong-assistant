'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBridge } = require('../src/main/engines/bridge');
test('pi tool budget blocks execution beyond the limit and restores it for a new task', async () => {
  let runs = 0;
  const tool = { name: 'fixture', level: 'low', run: async () => { runs++; return { text: 'ran' }; } };
  const bridge = createBridge({ toolset: { all: [tool], get: () => tool }, log: { warn() {} }, getPolicy: () => ({ mode: 'readonly', maxSteps: 2 }) });
  bridge.resetTask(false);
  assert.equal((await bridge.runTool('fixture', {})).ok, true);
  assert.equal((await bridge.runTool('fixture', {})).ok, true);
  const blocked = await bridge.runTool('fixture', {});
  assert.equal(blocked.ok, false);
  assert.match(blocked.text, /上限/);
  assert.equal(runs, 2);
  bridge.resetTask(false);
  assert.equal((await bridge.runTool('fixture', {})).ok, true);
});
test('pi tools keep working after a day even with an old saved time limit', async (t) => {
  let now = 1000, runs = 0;
  t.mock.method(Date, 'now', () => now);
  const tool = { name: 'fixture', level: 'low', run: async () => { runs++; return 'ran'; } };
  const bridge = createBridge({ toolset: { all: [tool], get: () => tool }, log: { warn() {} }, getPolicy: () => ({ mode: 'readonly', maxRuntimeMs: 60000 }) });
  bridge.resetTask(false); now += 86400000;
  assert.equal((await bridge.runTool('fixture', {})).ok, true);
  assert.equal(runs, 1);
});

test('elapsed time while waiting for approval does not expire a task; manual cancellation still blocks it', async (t) => {
  let now = 1000, runs = 0, approve;
  t.mock.method(Date, 'now', () => now);
  const tool = { name: 'fixture', level: 'mid', run: async () => { runs++; return 'ran'; } };
  const bridge = createBridge({ toolset: { all: [tool], get: () => tool }, log: { warn() {} }, getPolicy: () => ({ mode: 'confirm', maxRuntimeMs: 60000 }), askUser: () => new Promise(r => { approve = r; }) });
  bridge.resetTask(false);
  const waiting = bridge.runTool('fixture', {});
  await Promise.resolve();
  now += 86400000; approve('exec');
  assert.equal((await waiting).ok, true);
  bridge.resetTask(false);
  const cancelled = bridge.runTool('fixture', {});
  await Promise.resolve();
  bridge.cancelPending(); approve('exec');
  assert.equal((await cancelled).ok, false);
  assert.equal(runs, 1);
});

test('没设上限（0 = 默认）时工具调用不封顶', async () => {
  let runs = 0;
  const tool = { name: 'fixture', level: 'low', run: async () => { runs++; return { text: 'ran' }; } };
  const bridge = createBridge({ toolset: { all: [tool], get: () => tool }, log: { warn() {} }, getPolicy: () => ({ mode: 'readonly', maxSteps: 0 }) });
  bridge.resetTask(false);
  for (let i = 0; i < 50; i++) assert.equal((await bridge.runTool('fixture', {})).ok, true, '第 ' + (i + 1) + ' 次不该被拦');
  assert.equal(runs, 50);
});
test('老配置里存的 24 次上限会迁移成 0 = 不限次数', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nailong-migrate-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    __v: 1,
    agent: { policy: { mode: 'confirm', allow: {}, deny: {}, confirmHighRisk: true, maxSteps: 24 } }
  }));
  const old = process.env.NAILONG_DATA_DIR;
  process.env.NAILONG_DATA_DIR = dir;
  try {
    const { createServices } = require('../src/main/services');
    const svc = createServices({});
    assert.equal(svc.settings.agentCfg().policy.maxSteps, 0, '升级后不该还卡在第 24 次');
    // 迁移必须落盘：只改内存的话文件里一直是旧值，每次启动都重迁一遍
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    assert.equal(onDisk.agent.policy.maxSteps, 0, '文件里也要是 0');
    assert.equal(onDisk.__v, 2, '版本号要落到盘上');
    svc.dispose();
  } finally {
    if (old === undefined) delete process.env.NAILONG_DATA_DIR; else process.env.NAILONG_DATA_DIR = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
