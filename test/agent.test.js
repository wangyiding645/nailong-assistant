'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SRC = path.join(__dirname, '..', 'src');
const providers = require(path.join(SRC, 'main', 'agent', 'providers.js'));
const { createAgent } = require(path.join(SRC, 'main', 'agent', 'agent.js'));
const perms = require(path.join(SRC, 'main', 'agent', 'permissions.js'));
const usageLib = require(path.join(SRC, 'main', 'agent', 'usage.js'));
const memoryLib = require(path.join(SRC, 'main', 'agent', 'memory.js'));
const promptLib = require(path.join(SRC, 'main', 'agent', 'prompt.js'));
const { createTools } = require(path.join(SRC, 'main', 'tools', 'index.js'));

// ------------------------------------------------------------------ 辅助
function sseResponse(chunks, provider) {
  const lines = chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n';
  return new Response(lines, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
}

// ------------------------------------------------------------------ providers
test('providers: 协议识别与端点推导', () => {
  assert.equal(providers.detectProvider({ baseUrl: 'https://api.openai.com/v1' }), 'openai');
  assert.equal(providers.detectProvider({ baseUrl: 'https://api.anthropic.com' }), 'anthropic');
  assert.equal(providers.detectProvider({ baseUrl: 'https://x.example/v1', model: 'claude-sonnet-4' }), 'anthropic');
  assert.equal(providers.detectProvider({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta' }), 'gemini');
  assert.equal(providers.detectProvider({ baseUrl: 'https://x.example/v1', provider: 'gemini' }), 'gemini');

  assert.equal(providers.endpoint({ baseUrl: 'https://api.deepseek.com/v1' }, 'openai', true), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(providers.endpoint({ baseUrl: 'https://api.deepseek.com' }, 'openai', true), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(providers.endpoint({ baseUrl: 'https://api.anthropic.com' }, 'anthropic', true), 'https://api.anthropic.com/v1/messages');
  assert.equal(
    providers.endpoint({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash' }, 'gemini', true),
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse'
  );
});

test('providers: 三种协议的请求体形状', () => {
  const messages = [
    { role: 'system', content: '你是奶蛙' },
    { role: 'user', content: '看屏幕' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'click', arguments: '{"x":1,"y":2}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '已点击' }
  ];
  const tools = [{ name: 'click', description: '点击', parameters: { type: 'object', properties: { x: { type: 'integer' } }, required: ['x'] } }];

  const oa = providers.buildChatRequest({ baseUrl: 'https://a.com/v1', key: 'k', model: 'm' }, messages, { tools });
  assert.equal(oa.provider, 'openai');
  assert.equal(oa.body.tools[0].function.name, 'click');
  assert.equal(oa.body.stream, true);

  const an = providers.buildChatRequest({ baseUrl: 'https://api.anthropic.com', key: 'k', model: 'claude-sonnet-4' }, messages, { tools });
  assert.equal(an.provider, 'anthropic');
  assert.equal(an.headers['x-api-key'], 'k');
  assert.equal(an.body.system[0].text, '你是奶蛙');
  assert.equal(an.body.tools[0].input_schema.type, 'object');
  assert.equal(an.body.messages[0].content[0].text, '看屏幕');
  assert.equal(an.body.messages[1].content[0].type, 'tool_use');
  assert.equal(an.body.messages[2].content[0].type, 'tool_result');
  assert.equal(an.body.messages[2].content[0].tool_use_id, 'c1');

  const gm = providers.buildChatRequest({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta', key: 'k', model: 'gemini-2.5-flash' }, messages, { tools });
  assert.equal(gm.provider, 'gemini');
  assert.equal(gm.headers['x-goog-api-key'], 'k');
  assert.equal(gm.body.systemInstruction.parts[0].text, '你是奶蛙');
  assert.equal(gm.body.contents[0].role, 'user');
  assert.equal(gm.body.contents[1].role, 'model');
  assert.equal(gm.body.contents[1].parts[0].functionCall.name, 'click');
  assert.equal(gm.body.contents[2].parts[0].functionResponse.name, 'click', 'Gemini 的 functionResponse 需要函数名');
  // Gemini 的 schema 不接受 additionalProperties
  assert.equal(providers.toGeminiTools(tools)[0].functionDeclarations[0].parameters.type, 'OBJECT');
});

test('providers: OpenAI 流式增量归并', () => {
  const p = providers.createStreamParser('openai');
  const events = [];
  [
    { choices: [{ delta: { content: '好' } }] },
    { choices: [{ delta: { content: '的' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c9', function: { name: 'click', arguments: '{"x"' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':5}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }
  ].forEach((e) => events.push(...p.push(e)));
  const r = p.result();
  assert.equal(r.content, '好的');
  assert.deepEqual(r.toolCalls, [{ id: 'c9', name: 'click', args: '{"x":5}' }]);
  assert.equal(r.usage.input, 100);
  assert.equal(r.finishReason, 'tool_calls');
});

test('providers: Anthropic / Gemini 流式增量归并', () => {
  const a = providers.createStreamParser('anthropic');
  a.push({ type: 'message_start', message: { usage: { input_tokens: 50, output_tokens: 1 } } });
  a.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '看' } });
  a.push({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'screenshot' } });
  a.push({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } });
  a.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } });
  const ar = a.result();
  assert.equal(ar.content, '看');
  assert.deepEqual(ar.toolCalls, [{ id: 'tu1', name: 'screenshot', args: '{}' }]);
  assert.equal(ar.usage.input, 50);
  assert.equal(ar.usage.output, 30);

  const g = providers.createStreamParser('gemini');
  g.push({ candidates: [{ content: { parts: [{ text: '你好' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 } });
  g.push({ candidates: [{ content: { parts: [{ functionCall: { name: 'wait', args: { ms: 500 } } }] } }] });
  const gr = g.result();
  assert.equal(gr.content, '你好');
  assert.deepEqual(gr.toolCalls, [{ id: 'call_0', name: 'wait', args: '{"ms":500}' }]);
  assert.equal(gr.usage.input, 7);
});

test('providers: SSE 分片跨 chunk 也能解析', async () => {
  const enc = new TextEncoder();
  const parts = ['data: {"a":', '1}\n\ndata: {"a":2}\n', '\ndata: [DONE]\n\n'];
  const stream = new ReadableStream({
    start(c) {
      parts.forEach((p) => c.enqueue(enc.encode(p)));
      c.close();
    }
  });
  const res = new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  const got = [];
  for await (const d of providers.sseEvents(res)) got.push(JSON.parse(d));
  assert.deepEqual(got, [{ a: 1 }, { a: 2 }]);
});

// ------------------------------------------------------------------ permissions
test('permissions: 分级决策', () => {
  const low = { name: 'read_file', level: 'low' };
  const mid = { name: 'click', level: 'mid' };
  const high = { name: 'run_command', level: 'high' };

  assert.equal(perms.evaluate(low, {}, { mode: 'confirm' }).decision, 'allow', '只读工具不该每次都问');
  assert.equal(perms.evaluate(mid, {}, { mode: 'confirm' }).decision, 'ask');
  assert.equal(perms.evaluate(mid, {}, { mode: 'auto' }).decision, 'allow');
  assert.equal(perms.evaluate(high, { command: 'dir' }, { mode: 'auto', confirmHighRisk: false }).decision, 'allow', '自动执行 + 关掉「高危也要问」→ 高危也直接做，否则 agent 干不了活');
  assert.equal(perms.evaluate(high, { command: 'dir' }, { mode: 'auto', confirmHighRisk: true }).decision, 'ask', '勾了「高危也要问」就仍然要问');
  assert.equal(perms.evaluate(high, { command: 'dir' }, { mode: 'confirm' }).decision, 'ask', '每步确认模式下高危要问');
  assert.equal(perms.evaluate(mid, {}, { mode: 'readonly' }).decision, 'deny');
  assert.equal(perms.evaluate(mid, {}, { mode: 'confirm', allow: { click: true } }).decision, 'allow');
  assert.equal(perms.evaluate(mid, {}, { mode: 'confirm', deny: { click: true } }).decision, 'deny');
});

test('permissions: 危险命令拦截', () => {
  assert.equal(perms.inspectCommand('format c:').risk, 'blocked');
  assert.equal(perms.inspectCommand('rm -rf /tmp/x').risk, 'high');
  assert.equal(perms.inspectCommand('del /f /s /q C:\\tmp').risk, 'high');
  assert.equal(perms.inspectCommand('ls -la').risk, 'normal');
  assert.equal(perms.inspectCommand('git push --force origin main').risk, 'high');
  assert.equal(perms.evaluate({ name: 'run_command', level: 'high' }, { command: 'diskpart' }, { mode: 'auto' }).decision, 'deny');
});

test('permissions: 受保护路径', () => {
  assert.equal(perms.inspectPath('C:\\Windows\\System32\\x.dll').risk, 'high');
  assert.equal(perms.inspectPath('D:\\work\\a.txt').risk, 'normal');
});

// ------------------------------------------------------------------ usage
test('usage: 成本估算与汇总', () => {
  const c = usageLib.costOf('gpt-4o-mini', { input: 1000000, output: 1000000 });
  assert.equal(Math.round(c.usd * 100) / 100, 0.75);
  assert.equal(Math.round(usageLib.costOf('claude-sonnet-4-20250514', { input: 1e6, output: 0 }).usd), 3);
  const agg = usageLib.addUsage({ input: 10, output: 5, total: 15, calls: 1 }, { input: 20, output: 5, total: 25 });
  assert.equal(agg.input, 30);
  assert.equal(agg.calls, 2);
  assert.ok(usageLib.estimateTokens('你好世界') >= 4);
  assert.equal(usageLib.fmtUsd(0.0001234), '$0.0001');
});

// ------------------------------------------------------------------ memory / prompt
test('memory: 增删查与去重', () => {
  let list = [];
  list = memoryLib.add(list, { text: '项目文档在 D:\\work\\docs', tag: '项目' });
  list = memoryLib.add(list, { text: '项目文档在 D:\\work\\docs', tag: '项目' });
  assert.equal(list.length, 1, '重复内容只留一条');
  assert.equal(list[0].hits, 2);
  list = memoryLib.add(list, { text: '汇报要用中文' });
  assert.equal(list.length, 2);
  assert.equal(memoryLib.search(list, '文档').length, 1);
  assert.equal(memoryLib.search(list, '不存在的词').length, 0);
  assert.ok(memoryLib.toPromptBlock(list).indexOf('汇报要用中文') >= 0);
  list = memoryLib.remove(list, list[0].id);
  assert.equal(list.length, 1);
});

test('prompt: 系统提示包含环境与工具清单', () => {
  const text = promptLib.buildSystemPrompt({
    locale: 'zh-CN',
    tools: [{ name: 'click', level: 'mid', group: '电脑操作', description: '点一下' }],
    env: { datetime: '2026-10-08 09:00', weekday: '星期四' },
    mode: 'confirm',
    memoryBlock: '已知偏好：x'
  });
  assert.ok(text.includes('奶蛙'));
  assert.ok(text.includes('2026-10-08 09:00'));
  assert.ok(text.includes('click'));
  assert.ok(text.includes('已知偏好'));
  assert.ok(text.includes('每步确认'));
});

test('prompt: 历史裁剪保留协议完整性', () => {
  const msgs = [
    { role: 'system', content: 'S' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'a', function: { name: 'x', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'a', content: 'r' },
    { role: 'user', content: 'u' }
  ];
  const trimmed = promptLib.trimHistory(msgs, 1);
  assert.equal(trimmed[0].role, 'system');
  assert.notEqual(trimmed[1] && trimmed[1].role, 'tool', '开头不能是孤儿 tool 消息');
});

// ------------------------------------------------------------------ agent 循环
function fakeAgent(toolset, opts) {
  const events = [];
  const o = opts || {};
  const toolName = o.toolName || 'think';
  let call = 0;
  const fetchImpl = async (url, init) => {
    call++;
    if (o.onCall) o.onCall(call, JSON.parse(init.body));
    if (call === 1) {
      return sseResponse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: toolName, arguments: '{"thought":"规划"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
      ], 'openai');
    }
    return sseResponse([
      { choices: [{ delta: { content: '搞定' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 } }
    ], 'openai');
  };
  const agent = createAgent({
    getConfig: () => ({ baseUrl: 'https://fake/v1', key: 'k', model: 'fake', provider: 'openai' }),
    get tools() { return toolset; },
    getPolicy: () => ({ mode: o.mode || 'auto', ...(o.policy || {}) }),
    buildSystemPrompt: () => '你是奶蛙',
    confirm: o.confirm || (async () => 'exec'),
    onEvent: (e) => events.push(e),
    fetchImpl
  });
  return { agent, events, calls: () => call };
}

test('agent: 走完「工具调用 → 结果 → 回复」', async () => {
  const tools = [{
    name: 'think', level: 'low', description: '想一下', parameters: { type: 'object', properties: {} },
    run: async () => ({ ok: true, text: '想完了' })
  }];
  const { agent, events } = fakeAgent(tools);
  const r = await agent.run('开始');
  assert.equal(r.reply, '搞定');
  assert.ok(events.some((e) => e.type === 'tool-call' && e.name === 'think'));
  assert.ok(events.some((e) => e.type === 'tool-result' && e.text === '想完了'));
  assert.ok(events.some((e) => e.type === 'text' && e.delta.indexOf('搞') >= 0));
  assert.equal(events.filter((e) => e.type === 'text').map((e) => e.delta).join(''), '搞定', '流式片断拼起来应等于完整回复');
  const msgs = agent.getMessages();
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[1].role, 'user');
  assert.ok(msgs.some((m) => m.role === 'tool' && m.tool_call_id === 'c1'));
  assert.equal(agent.getUsage().calls, 2);
  assert.ok(agent.getUsage().input === 30);
});

test('agent: an old time limit cannot stop tools or follow-up reasoning after a day', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const tools = [{ name: 'think', level: 'low', description: 'fixture', parameters: {}, run: async () => { now += 86400000; return 'still working'; } }];
  const { agent } = fakeAgent(tools, { policy: { maxRuntimeMs: 60000 }, onCall: () => { now += 86400000; } });
  const result = await agent.run('continue');
  assert.equal(result.reply, '搞定');
  assert.equal(result.steps, 1);
});

test('agent: 中危工具会先问用户，跳过时回填给模型', async () => {
  const tools = [{
    name: 'click', level: 'mid', description: '点一下', parameters: { type: 'object', properties: {} },
    run: async () => ({ ok: true, text: '点了' })
  }];
  let asked = 0;
  const { agent, events } = fakeAgent(tools, {
    mode: 'confirm',
    toolName: 'click',
    confirm: async () => { asked++; return 'skip'; }
  });
  const r = await agent.run('点它');
  assert.ok(asked >= 1, '中危工具在确认模式下必须问用户');
  assert.ok(events.some((e) => e.type === 'tool-call' && e.verdict === 'ask'));
  assert.ok(events.some((e) => e.type === 'tool-skipped'));
  assert.ok(r.reply);
});

test('agent: 工具抛错不会炸掉整个循环', async () => {
  const tools = [{
    name: 'boom', level: 'low', description: '炸', parameters: { type: 'object', properties: {} },
    run: async () => { throw new Error('磁盘满了'); }
  }];
  let call = 0;
  const agent = createAgent({
    getConfig: () => ({ baseUrl: 'https://fake/v1', key: 'k', model: 'fake' }),
    get tools() { return tools; },
    getPolicy: () => ({ mode: 'auto' }),
    onEvent: () => {},
    confirm: async () => 'exec',
    fetchImpl: async () => {
      call++;
      if (call === 1) {
        return sseResponse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'b1', function: { name: 'boom', arguments: '{}' } }] } }] }]);
      }
      return sseResponse([{ choices: [{ delta: { content: '它失败了' } }] }]);
    }
  });
  const r = await agent.run('炸一下');
  assert.equal(r.reply, '它失败了');
  assert.ok(agent.getMessages().some((m) => m.role === 'tool' && String(m.content).indexOf('磁盘满了') >= 0));
});

test('agent: 接口报错会转成可读错误', async () => {
  const agent = createAgent({
    getConfig: () => ({ baseUrl: 'https://fake/v1', key: 'k', model: 'fake' }),
    get tools() { return []; },
    getPolicy: () => ({ mode: 'auto' }),
    onEvent: () => {},
    confirm: async () => 'exec',
    fetchImpl: async () => jsonResponse({ error: { message: '余额不足' } }, 402)
  });
  const r = await agent.run('hi');
  assert.ok(r.error);
  assert.ok(r.error.indexOf('402') >= 0);
  assert.ok(r.error.indexOf('余额不足') >= 0);
});

test('agent: 中止任务', async () => {
  const agent = createAgent({
    getConfig: () => ({ baseUrl: 'https://fake/v1', key: 'k', model: 'fake' }),
    get tools() { return []; },
    getPolicy: () => ({ mode: 'auto' }),
    onEvent: () => {},
    confirm: async () => 'exec',
    fetchImpl: async () => { agent.abort(); return sseResponse([{ choices: [{ delta: { content: 'x' } }] }]); }
  });
  const r = await agent.run('hi');
  assert.ok(r.stopped || r.error);
});

// ------------------------------------------------------------------ 工具
function stubHost(overrides) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nailong-test-'));
  const shell = [];
  const base = {
    paths: { root: path.join(dir, 'app'), home: dir, desktop: path.join(dir, 'Desktop'), downloads: path.join(dir, 'Downloads'), documents: path.join(dir, 'Documents') },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    lastShot: () => ({ physW: 2560, physH: 1440, sentW: 1280, sentH: 720 }),
    screenshot: async () => ({ dataUrl: 'data:image/jpeg;base64,AA', physW: 2560, physH: 1440, sentW: 1280, sentH: 720 }),
    afterShot: async () => [],
    pause: async () => {},
    input: (c) => shell.push(c),
    uiTree: async () => ({ window: 'w', count: 1, nodes: [{ id: 'e1', d: 0, role: 'Button', name: '确定', x: 10, y: 20, w: 40, h: 20, on: true, off: false }] }),
    findElement: async () => [{ id: 'e1', role: 'Button', name: '确定', x: 10, y: 20, w: 40, h: 20 }],
    elementAction: async (kind) => (kind === 'invoke' ? { invoked: true, name: '确定' } : { set: true, name: '输入框' }),
    windowControl: async (action) => ({ action: action, processes: [], screens: [{ w: 1920, h: 1080, primary: true }] }),
    windowList: async () => [{ title: '记事本', x: 0, y: 0, w: 400, h: 300, pid: 1, foreground: true, minimized: false }],
    screenInfo: async () => ({ screens: [{ w: 1920, h: 1080, primary: true }], scale: 1, cursor: { x: 5, y: 6 }, foreground: { title: '记事本', pid: 1 }, windows: [{ title: '记事本', x: 0, y: 0, w: 400, h: 300, pid: 1, minimized: false }] }),
    systemInfo: async () => ({ os: 'Windows 11', arch: 'x64', version: '10.0', host: 'PC', user: 'u', cpu: 'CPU', cores: 8, ramTotalGB: 16, ramFreeGB: 8, uptimeHours: 3, disks: [], battery: null }),
    runCommand: async () => ({ code: 0, stdout: 'hi', stderr: '', timedOut: false }),
    launch: async () => true,
    recycle: async () => ({ ok: 1, fail: 0, err: '' }),
    guardPath: () => ({ ok: true }),
    b64utf8: (s) => Buffer.from(String(s), 'utf8').toString('base64'),
    clipboard: { read: () => '剪贴板内容', write: () => {} },
    services: {
      schedule: {
        tasks: () => require(path.join(SRC, 'shared', 'task.js')).parseTasks('09:00|晨会\r\n2026-10-09 10:00|评审|repeat=weekly:5'),
        doneMap: () => ({}),
        add: (t) => t,
        remove: () => 1,
        toggleDone: () => ({}),
        progress: () => ({ total: 1, done: 0, pct: 0 })
      },
      countdown: { list: () => [{ date: '2027-01-01', text: '元旦' }], add: () => [] },
      focus: { start: (m) => ({ endsAt: Date.now() + m * 60000 }), status: () => ({ phase: 'idle', label: '待开始', remainMs: 0, config: {} }), stop: () => ({}) },
      stats: { today: () => ({ focusCount: 1, focusMinutes: 25, tasksDone: 1, tasksTotal: 2, streak: 3 }), range: () => ({ summary: { doneItems: 1, totalItems: 2, rate: 50, activeDays: 2 }, streak: 3, longest: 5, tags: [], hours: new Array(24).fill(0), focusCount: 2, focusMinutes: 50 }) },
      memory: { add: () => [], search: () => [{ text: 'x' }] },
      clipboard: { history: () => [{ at: Date.now(), text: '复制的文字' }] },
      notify: { show: () => {} }
    }
  };
  return Object.assign(base, overrides || {}, { _shell: shell, _dir: dir });
}

test('tools: 注册表完整且无重名', () => {
  const tools = createTools(stubHost());
  assert.ok(tools.all.length >= 30, '工具数量应 >= 30，实际 ' + tools.all.length);
  const names = tools.all.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  tools.all.forEach((t) => {
    assert.ok(t.name && t.description && typeof t.run === 'function');
    assert.ok(['low', 'mid', 'high'].indexOf(t.level) >= 0, t.name + ' 的 level 不合法');
  });
  const s = tools.stats();
  assert.ok(s.byGroup['电脑操作'] >= 8);
  assert.ok(s.byGroup['日程'] >= 3);
});

test('tools: 截图坐标会换算成物理像素', async () => {
  const host = stubHost();
  const tools = createTools(host);
  const click = tools.get('click');
  await click.run({ x: 640, y: 360 });
  assert.deepEqual(host._shell, ['click 1280 720'], '截图宽 1280 → 物理宽 2560，系数 2');
});

test('tools: click_element 走无障碍调用，不退化成坐标点击', async () => {
  const host = stubHost();
  const tools = createTools(host);
  await tools.get('click_element').run({ element_id: 'e1' });
  assert.deepEqual(host._shell, [], '能无障碍触发就不该动鼠标');
  const r = await tools.get('ui_tree').run({});
  assert.ok(r.text.indexOf('e1') >= 0);
  const f = await tools.get('find_element').run({ text: '确定' });
  assert.ok(f.text.indexOf('e1') >= 0);
});

test('tools: 文件读写与列举', async () => {
  const host = stubHost();
  const tools = createTools(host);
  const target = path.join(host._dir, 'sub', 'a.txt');
  const w = await tools.get('write_file').run({ path: target, content: '第一行\n第二行' });
  assert.ok(w.ok);
  const r = await tools.get('read_file').run({ path: target, offset: 2, limit: 1 });
  assert.ok(r.text.indexOf('第二行') >= 0);
  assert.ok(r.text.indexOf('第一行') < 0);
  const l = await tools.get('list_dir').run({ path: path.join(host._dir, 'sub') });
  assert.ok(l.text.indexOf('a.txt') >= 0);
  const info = await tools.get('file_info').run({ path: target });
  assert.ok(info.text.indexOf('文件') >= 0);
  const s = await tools.get('search_files').run({ root: host._dir, name: 'a.txt' });
  assert.ok(s.text.indexOf('a.txt') >= 0);
});

test('tools: 日程工具接得上服务层', async () => {
  const host = stubHost();
  const tools = createTools(host);
  const list = await tools.get('schedule_list').run({ date: '2026-10-09' });
  assert.ok(list.text.indexOf('评审') >= 0);
  const add = await tools.get('schedule_add').run({ text: '开会', when: '明天下午3点' });
  assert.equal(add.ok, true);
  const noTime = await tools.get('schedule_add').run({ text: '不知道几点' });
  assert.equal(noTime.ok, false, '没时间时应让模型去问用户');
  const cd = await tools.get('countdown_list').run({});
  assert.ok(cd.text.indexOf('元旦') >= 0);
});

test('tools: html → text', () => {
  const { htmlToText } = require(path.join(SRC, 'main', 'tools', 'system.js'));
  const t = htmlToText('<html><head><style>a{color:red}</style></head><body><h1>标题</h1><p>正文&nbsp;内容</p><ul><li>一</li><li>二</li></ul><script>bad()</script></body></html>');
  assert.ok(t.indexOf('标题') >= 0);
  assert.ok(t.indexOf('正文 内容') >= 0);
  assert.ok(t.indexOf('- 一') >= 0);
  assert.ok(t.indexOf('bad()') < 0);
  assert.ok(t.indexOf('color:red') < 0);
});

test('tools: 工具清单可被禁用', () => {
  const tools = createTools(stubHost());
  const left = tools.applyDisabled({ run_command: true, delete_path: true });
  assert.ok(!tools.get('run_command').enabled);
  assert.ok(left.every((t) => t.enabled));
});
