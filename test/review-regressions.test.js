'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createBridge } = require('../src/main/engines/bridge');
const { createAgent } = require('../src/main/agent/agent');
const perms = require('../src/main/agent/permissions');
const { createHost } = require('../src/main/host');
const { createComputerTools } = require('../src/main/tools/computer');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
test('review: pi abort first clears queued work', async () => {
  const { createPiEngine } = require('../src/main/engines/pi');
  const engine = createPiEngine({ log: quiet });
  const sent = [];
  engine.state.proc = { stdin: { writable: true, write(line) {
    const record = JSON.parse(line); sent.push(record.type);
    setImmediate(() => engine.handleRecord({ type: 'response', id: record.id, command: record.type, success: true, data: {} }));
  } } };
  await engine.abort();
  assert.deepEqual(sent, ['clear_queue', 'abort']);
});
test('review: denied bridge tools are displayed as failures in pi events', () => {
  const { createPiEngine } = require('../src/main/engines/pi');
  const events = [];
  const engine = createPiEngine({ log: quiet, emit: (channel, event) => events.push(event) });
  engine.handleRecord({ type: 'tool_execution_end', toolCallId: 'denied', toolName: 'write_file', result: { content: [{ type: 'text', text: 'denied' }], details: { ok: false } }, isError: false });
  assert.equal(events.at(-1).ok, false);
});
function bridgeFor(spec, overrides = {}) {
  return createBridge({
    toolset: { all: [spec], get: n => n === spec.name ? spec : null }, services: {}, log: quiet,
    getPolicy: () => ({ mode: 'confirm' }), askUser: async () => 'exec', ...overrides
  });
}
test('review: an exiting old pi process cannot invalidate a restarted kernel', { timeout: 10000 }, async () => {
  const { createPiEngine } = require('../src/main/engines/pi');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nailong-restart-'));
  const bridge = bridgeFor({ name: 'fixture_read', level: 'low', parameters: { type: 'object', properties: {} } });
  await bridge.start();
  const engine = createPiEngine({ bridge, log: quiet, emit() {} });
  const owned = [];
  const opts = { agentDir: path.join(dir, 'pi-agent'), sessionDir: path.join(dir, 'sessions'), cwd: dir };
  try {
    await engine.start(opts);
    const old = engine.state.proc;
    owned.push(old);
    engine.stop();
    const restarted = engine.start(opts);
    owned.push(engine.state.proc);
    await restarted;
    assert.notEqual(engine.state.proc, old);
    assert.equal((await engine.status()).ready, true);
    engine.stop();
    const interrupted = engine.start(opts).catch(e => e);
    owned.push(engine.state.proc);
    engine.stop();
    const next = engine.start(opts);
    owned.push(engine.state.proc);
    await next;
    assert.ok(await interrupted instanceof Error);
    assert.equal((await engine.status()).ready, true);
  } finally {
    const proc = engine.state.proc;
    const exited = proc ? new Promise(r => proc.once('exit', r)) : Promise.resolve();
    engine.stop(); bridge.stop();
    for (const child of owned) if (child && child.exitCode === null) child.kill();
    await exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('review: high risk cannot bypass confirmation through a whitelist', () => {
  for (const name of ['run_command', 'delete_path', 'lock_screen']) {
    assert.equal(perms.evaluate({ name, level: 'high' }, {}, { mode: 'auto', allow: { [name]: true } }).decision, 'ask');
  }
});
test('review: both copy and move destinations are protected', () => {
  for (const name of ['copy_path', 'move_path']) {
    assert.equal(perms.evaluate({ name, level: 'mid' }, { from: 'D:\\safe\\a', to: 'D:\\app\\child\\a' }, { selfRoot: 'D:\\app', mode: 'auto' }).decision, 'deny');
  }
});
test('review: bridge executes only explicit approval choices', async () => {
  let runs = 0;
  const spec = { name: 'danger', level: 'high', run: async () => { runs++; return 'ran'; } };
  for (const choice of ['reject', '', undefined, 'bogus', 'deny', 'skip']) {
    const bridge = bridgeFor(spec, { askUser: async () => choice });
    assert.equal((await bridge.runTool('danger', {})).ok, false, String(choice));
  }
  assert.equal(runs, 0);
});
test('review: cancelling an approval prevents later execution', async () => {
  let approve;
  let runs = 0;
  const bridge = bridgeFor({ name: 'danger', level: 'high', run: async () => { runs++; } }, { askUser: () => new Promise(r => { approve = r; }) });
  const p = bridge.runTool('danger', {});
  await new Promise(r => setImmediate(r));
  bridge.cancelPending();
  approve('exec');
  assert.equal((await p).ok, false);
  assert.equal(runs, 0);
});
test('review: config carries provider opt-out and model limits', async () => {
  const bridge = bridgeFor({ name: 'x', level: 'low' }, { getModelConfig: () => ({ useCustomProvider: false, provider: 'anthropic', maxTokens: 1234, contextWindow: 32100 }) });
  await bridge.start();
  try {
    const r = await fetch(bridge.url + '/config', { headers: { 'x-nailong-token': bridge.token } });
    const c = await r.json();
    assert.equal(c.useCustomProvider, false);
    assert.equal(c.maxTokens, 1234);
    assert.equal(c.contextWindow, 32100);
  } finally { bridge.stop(); }
});
test('review: a non-ASCII token with the same character count is unauthorized', async () => {
  const bridge = bridgeFor({ name: 'x', level: 'low' });
  await bridge.start();
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.get(bridge.url + '/health', { headers: { 'x-nailong-token': 'é'.repeat(48) } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.setTimeout(2000, () => req.destroy(new Error('unauthorized request did not receive a response')));
    });
    assert.equal(status, 401);
  } finally { bridge.stop(); }
});
function sse(content, calls) {
  return new Response('data: ' + JSON.stringify({ choices: [{ delta: calls ? { tool_calls: calls } : { content } }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}
test('review: builtin refuses unknown confirmation and disabled tools', async () => {
  for (const scenario of ['reject', 'disabled']) {
    let requests = 0, runs = 0;
    const agent = createAgent({
      tools: [{ name: 'danger', level: 'high', enabled: scenario !== 'disabled', run: async () => { runs++; return 'ran'; } }],
      getConfig: () => ({ baseUrl: 'http://fake/v1', model: 'fake', key: 'fake', provider: 'openai' }),
      getPolicy: () => ({ mode: 'confirm' }), confirm: async () => 'reject', onEvent() {},
      fetchImpl: async () => ++requests === 1 ? sse('', [{ index: 0, id: 'x', function: { name: 'danger', arguments: '{}' } }]) : sse('done')
    });
    await agent.run('test');
    assert.equal(runs, 0, scenario);
  }
});
test('review: crop and secondary display coordinates reach the correct physical point', async () => {
  const commands = [];
  const tools = createComputerTools({ lastShot: () => ({ physW: 2560, physH: 1440, sentW: 500, sentH: 200, scaleX: 2, scaleY: 2, originX: -1920, originY: 0, cropX: 200, cropY: 100 }), input: cmd => commands.push(cmd), pause: async () => {}, afterShot: async () => [] });
  await tools.find(x => x.name === 'click').run({ x: 25, y: 30 });
  assert.equal(commands[0], 'click -1670 160');
});
test('review: PowerShell working directory is literal even with dollar expressions and quotes', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nailong-review-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, "a'$(Write-Output INJECTED)");
  fs.mkdirSync(dir);
  const host = createHost({ paths: { ROOT: base, code: base }, log: quiet, native: {}, services: {} });
  const r = await host.runCommand('(Get-Location).Path', dir, 10000);
  assert.equal(r.code, 0);
  // Windows runner 的 TEMP 可能使用 RUNNER~1 短路径；PowerShell 会返回对应长路径。
  // 比较实际目录仍可捕获引号/表达式注入、错误工作区和额外输出。
  assert.equal(fs.realpathSync.native(r.stdout.trim()), fs.realpathSync.native(dir));
});
test('review: guard blocks code directory and junction aliases for protected directories', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nailong-review-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const code = path.join(base, 'code'), data = path.join(base, 'data'), alias = path.join(base, 'alias');
  fs.mkdirSync(code); fs.mkdirSync(data);
  fs.symlinkSync(code, alias, 'junction');
  const host = createHost({ paths: { ROOT: data, code }, log: quiet, native: {}, services: {} });
  assert.equal(host.guardPath(path.join(code, 'new.txt')).ok, false);
  assert.equal(host.guardPath(path.join(alias, 'new.txt')).ok, false);
});
test('review: bridge plan mode blocks writes until an approved plan and resets per task', async () => {
  let runs = 0;
  const plan = { name: 'propose_plan', level: 'low', run: async (args, ctx) => ({ ok: (await ctx.askPlan(args)) === 'approve', text: 'plan' }) };
  const write = { name: 'write', level: 'mid', run: async () => { runs++; return 'written'; } };
  const b = bridgeFor(write, { toolset: { all: [plan, write], get: n => [plan, write].find(x => x.name === n) }, getPolicy: () => ({ mode: 'auto', planMode: true }), askPlan: async () => 'approve' });
  assert.equal((await b.runTool('write', {})).ok, false);
  await b.runTool('propose_plan', { steps: ['write'] });
  assert.equal((await b.runTool('write', {})).ok, true);
  b.resetTask();
  assert.equal((await b.runTool('write', {})).ok, false);
  assert.equal(runs, 1);
});
test('review: task-auto applies to later mid-risk tools but never overrides readonly', async () => {
  let asks = 0;
  const b = bridgeFor({ name: 'click', level: 'mid', run: async () => 'clicked' }, { askUser: async () => { asks++; return 'auto'; } });
  await b.runTool('click', {}); await b.runTool('click', {});
  assert.equal(asks, 1);
});
test('review: data-root writable probe never overwrites an existing user file', t => {
  const { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nailong-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sentinel = path.join(dir, '.nailong-write-probe');
  fs.writeFileSync(sentinel, 'keep');
  execFileSync(process.execPath, ['-e', "require('./src/main/paths')"], { cwd: path.join(__dirname, '..'), env: { ...process.env, NAILONG_DATA_DIR: dir } });
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
});
test('review: launch never uses a command shell for a literal target', async () => {
  const vm = require('node:vm');
  const code = fs.readFileSync(path.join(__dirname, '../src/main/host.js'), 'utf8');
  const calls = [];
  const sandbox = { module: { exports: {} }, process, Buffer, setTimeout, require: n => n === 'child_process' ? { spawn(file) { calls.push(file); const p = new (require('node:events').EventEmitter)(); queueMicrotask(() => p.emit('error', new Error('ENOENT'))); return p; } } : n === './agent/providers.js' ? {} : require(n) };
  vm.runInNewContext(code, sandbox);
  const host = sandbox.module.exports.createHost({ paths: { ROOT: 'D:\\data', code: 'D:\\code' }, log: quiet, native: {}, services: {} });
  await assert.rejects(host.launch('nonexistent & echo harmless'));
  assert.equal(calls.length, 1);
  assert.ok(calls.every(file => !/^(cmd|powershell)(\.exe)?$/i.test(file)));
});
