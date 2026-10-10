'use strict';
/* Agent 运行时：流式对话 + 工具调用循环 + 权限确认 + 用量统计
 * 依赖全部注入 → 可以在没有 Electron 的环境里单测。
 */

const providers = require('./providers.js');
const usageLib = require('./usage.js');
const perms = require('./permissions.js');
const promptLib = require('./prompt.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function defaultFetch() {
  if (typeof globalThis.fetch !== 'function') throw new Error('当前 Node 版本没有 fetch，请升级到 Node 18+');
  return globalThis.fetch;
}

function summarizeArgs(args) {
  const s = JSON.stringify(args || {});
  return s.length > 160 ? s.slice(0, 157) + '…' : s;
}

/**
 * @param {object} deps
 * @param {() => object} deps.getConfig  返回 {baseUrl,key,model,provider,maxTokens,timeoutMs}
 * @param {Array} deps.tools             工具注册表
 * @param {() => object} [deps.getPolicy]
 * @param {(evt:object) => void} deps.onEvent
 * @param {(req:object) => Promise<'exec'|'skip'|'auto'|'deny'>} deps.confirm
 * @param {() => string} [deps.buildSystemPrompt]
 * @param {Function} [deps.fetchImpl]
 * @param {() => void} [deps.onUsage]    每次调用后回报累计用量
 */
function createAgent(deps) {
  const state = {
    messages: [],
    system: '',
    running: false,
    abort: false,
    autoTask: false,          // 本次任务是否已切换为「自动执行」
    planApproved: false,
    policyOverride: null,
    usage: { input: 0, output: 0, total: 0, cached: 0, usd: 0, calls: 0 },
    history: [],              // 用量明细
    pendingResolve: null,
    lastRequestId: 0
  };

  function emit(evt) {
    try { if (deps.onEvent) deps.onEvent(evt); } catch (e) { /* 渲染层崩了不该拖垮 agent */ }
  }

  function policy() {
    const base = Object.assign({}, deps.getPolicy ? deps.getPolicy() : {});
    const p = Object.assign({}, base, state.policyOverride || {});
    if (base.mode === 'readonly') p.mode = 'readonly';
    else if (state.autoTask) p.mode = 'auto';
    return p;
  }

  function setSystem(text) {
    state.system = String(text || '');
    state.messages = state.system ? [{ role: 'system', content: state.system }] : [];
  }

  function replaceHistory(messages) {
    state.messages = (messages || []).slice();
    const sys = state.messages.find((m) => m.role === 'system');
    state.system = sys ? sys.content : '';
  }

  function countUsage(usage, model) {
    const c = usageLib.costOf(model, usage || {});
    state.history.push({ at: Date.now(), day: new Date().toISOString().slice(0, 10), model, usage: usage || {}, usd: c.usd });
    state.usage = state.history.reduce((a, h) => ({
      input: a.input + (h.usage.input || 0),
      output: a.output + (h.usage.output || 0),
      total: a.total + (h.usage.total || 0),
      cached: a.cached + (h.usage.cached || 0),
      usd: a.usd + h.usd,
      calls: a.calls + 1
    }), { input: 0, output: 0, total: 0, cached: 0, usd: 0, calls: 0 });
    if (deps.onUsage) { try { deps.onUsage(state.usage); } catch (e) { /* ignore */ } }
    emit({ type: 'usage', usage: state.usage, last: c });
    return c;
  }

  /** 单次模型调用（含重试） */
  async function callModel(messages, toolSpecs) {
    const cfg = deps.getConfig() || {};
    if (!cfg.baseUrl || !cfg.key || !cfg.model) {
      throw new Error('还没配置接口。点右上角 ⚙ 填 Base URL、API Key 和模型名。');
    }
    const fetchImpl = deps.fetchImpl || defaultFetch();
    const req = providers.buildChatRequest(cfg, messages, { tools: toolSpecs, stream: true });
    const timeoutMs = cfg.timeoutMs || 180000;
    let attempt = 0;
    let lastErr = null;

    while (attempt < 3) {
      attempt++;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetchImpl(req.url, {
          method: 'POST',
          headers: req.headers,
          body: JSON.stringify(req.body),
          signal: ctrl.signal
        });
        if (!res.ok) {
          const raw = await res.text().catch(() => '');
          let msg = raw;
          try {
            const j = JSON.parse(raw);
            msg = (j.error && j.error.message) || j.message || raw;
          } catch (e) { /* 保持原文 */ }
          const err = new Error('接口返回 ' + res.status + '：' + String(msg).slice(0, 400));
          err.status = res.status;
          // 4xx 不重试（除了 429）
          if (res.status !== 429 && res.status >= 400 && res.status < 500) { throw err; }
          throw err;
        }
        const parser = providers.createStreamParser(req.provider);
        const ctype = res.headers.get('content-type') || '';
        if (req.stream && res.body && /event-stream/.test(ctype)) {
          for await (const data of providers.sseEvents(res, ctrl.signal)) {
            let evt;
            try { evt = JSON.parse(data); } catch (e) { continue; }
            for (const e of parser.push(evt)) {
              if (e.type === 'text') emit({ type: 'text', delta: e.delta });
              else if (e.type === 'error') throw new Error(e.message);
            }
          }
        } else {
          // 网关忽略了 stream 参数 → 退回一次性响应
          const data = await res.json();
          const full = providers.parseFullResponse(req.provider, data);
          if (full.content) emit({ type: 'text', delta: full.content });
          parser.state.text = full.content || '';
          parser.state.toolCalls = full.toolCalls.map((t) => ({ id: t.id, name: t.name, args: t.args }));
          parser.state.usage = full.usage;
          parser.state.finishReason = full.finishReason;
        }
        clearTimeout(timer);
        return parser.result();
      } catch (e) {
        clearTimeout(timer);
        lastErr = e;
        if (state.abort) throw new Error('已停止');
        const retriable = !e.status || e.status === 429 || e.status >= 500;
        if (!retriable || attempt >= 3) break;
        emit({ type: 'status', text: '连接不稳，' + attempt + ' 次重试…' });
        await sleep(attempt === 1 ? 1200 : 3000);
      }
    }
    throw new Error('模型调用失败：' + String((lastErr && lastErr.message) || lastErr));
  }

  /** 需要用户拍板时统一走这里：优先用注入的 confirm，否则退化成事件 + 内部 resolver */
  async function waitUser(req) {
    if (typeof deps.confirm === 'function') { return deps.confirm(req); }
    return new Promise((resolve) => {
      state.pendingResolve = resolve;
      emit(Object.assign({ type: req.kind === 'question' ? 'question' : 'pending' }, req));
    });
  }

  function toolByName(name) {
    return (deps.tools || []).find((t) => t.name === name) || null;
  }

  async function executeTool(call) {
    const spec = toolByName(call.name);
    if (!spec) {
      return { ok: false, text: '没有名为 ' + call.name + ' 的工具，请从工具列表里选。' };
    }
    let args = {};
    try { args = JSON.parse(call.args || '{}'); } catch (e) { args = {}; }

    const pol = policy();
    if (pol.planMode && !state.planApproved && spec.level !== 'low') {
      return { ok: false, text: '计划模式：请先调用 propose_plan 并获得用户批准' };
    }
    const verdict = perms.evaluate(spec, args, pol);
    emit({ type: 'tool-call', id: call.id, name: call.name, args, desc: spec.describe ? spec.describe(args) : call.name, level: spec.level, verdict: verdict.decision });

    if (verdict.decision === 'deny') {
      return { ok: false, text: '这个操作被拦下了：' + verdict.reason };
    }

    let needsAsk = verdict.decision === 'ask';
    if (!needsAsk && state.autoTask && perms.stillNeedsConfirm(spec, pol)) { needsAsk = true; }
    if (needsAsk) {
      const choice = String(await waitUser({
        kind: 'tool',
        id: ++state.lastRequestId,
        tool: call.name,
        args,
        desc: spec.describe ? spec.describe(args) : call.name,
        level: spec.level,
        reason: verdict.reason,
        preview: spec.preview ? safePreview(spec, args) : ''
      }));
      if (!['exec', 'auto'].includes(choice) || state.abort) {
        emit({ type: 'tool-skipped', id: call.id, name: call.name });
        return { ok: false, skipped: true, text: '用户拒绝/跳过了这一步。换一种方式，或直接说明你无法完成的原因。' };
      }
      if (choice === 'auto') { state.autoTask = true; }
    }

    if (state.abort || spec.enabled === false) return { ok: false, text: '任务已中止或工具已禁用' };

    const ctx = {
      emit,
      policy: pol,
      ask: async (question) => {
        const answer = await waitUser({ kind: 'question', id: ++state.lastRequestId, question: String(question || ''), desc: String(question || '') });
        return String(answer === undefined || answer === null ? '' : answer);
      },
      askPlan: async (plan) => {
        const answer = await waitUser({ kind: 'plan', id: ++state.lastRequestId, plan: plan, desc: '计划审批' });
        return String(answer === undefined || answer === null ? '' : answer);
      }
    };

    const t0 = Date.now();
    try {
      const out = await spec.run(args, ctx);
      const normalized = normalizeToolResult(out);
      if (call.name === 'propose_plan') state.planApproved = !state.abort && normalized.ok !== false;
      emit({ type: 'tool-result', id: call.id, name: call.name, ok: normalized.ok !== false, ms: Date.now() - t0, text: normalized.text, images: normalized.images });
      return normalized;
    } catch (e) {
      const msg = String((e && e.message) || e);
      emit({ type: 'tool-result', id: call.id, name: call.name, ok: false, ms: Date.now() - t0, text: '执行失败：' + msg, images: [] });
      return { ok: false, text: '执行失败：' + msg };
    }
  }

  function safePreview(spec, args) {
    try { return spec.preview(args); } catch (e) { return ''; }
  }

  function normalizeToolResult(out) {
    if (out === undefined || out === null) return { ok: true, text: '完成', images: [] };
    if (typeof out === 'string') return { ok: true, text: out, images: [] };
    return {
      ok: out.ok !== false,
      text: out.text === undefined ? '完成' : String(out.text),
      images: Array.isArray(out.images) ? out.images : [],
      data: out.data
    };
  }

  /**
   * 跑一轮对话（可能包含多步工具调用）
   * @param {string|Array} content 用户输入（字符串或 content parts）
   * @param {object} [opts] { maxSteps }
   */
  async function run(content, opts) {
    if (state.running) return { error: '上一个任务还在跑，先停止它' };
    const cfg = deps.getConfig() || {};
    const pol = policy();
    // 0 = 不限次数（默认）：只有用户显式设了正数才封顶
    const maxSteps = Number((opts && opts.maxSteps) || pol.maxSteps) || 0;

    state.running = true;
    state.abort = false;
    state.autoTask = false;
    state.planApproved = false;
    if (!state.system && deps.buildSystemPrompt) setSystem(deps.buildSystemPrompt());

    state.messages.push({ role: 'user', content });
    const toolSpecs = (deps.tools || []).filter((t) => t.enabled !== false);
    let steps = 0;
    let finalText = '';

    try {
      for (let i = 0; maxSteps === 0 || i < maxSteps; i++) {
        if (state.abort) { emit({ type: 'done', stopped: true }); return { stopped: true }; }
        const trimmed = promptLib.trimHistory(state.messages, cfg.historyChars || 160000);
        emit({ type: 'status', text: steps === 0 ? '思考中…' : '第 ' + steps + ' 步…' });
        const msg = await callModel(trimmed, toolSpecs);
        if (msg.usage) countUsage(msg.usage, cfg.model);
        if (state.abort) { emit({ type: 'done', stopped: true }); return { stopped: true }; }

        if (msg.toolCalls && msg.toolCalls.length) {
          state.messages.push({
            role: 'assistant',
            content: msg.content || '',
            tool_calls: providers.toolCallsToOpenAi(msg.toolCalls)
          });
          if (msg.content) { finalText = msg.content; emit({ type: 'assistant', text: msg.content }); }

          const images = [];
          for (const call of msg.toolCalls) {
            if (state.abort) break;
            if (maxSteps > 0 && steps >= maxSteps) { emit({ type: 'error', message: '任务工具调用已达到上限' }); return { error: 'task-limit' }; }
            steps++;
            const r = await executeTool(call);
            state.messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: r.text });
            if (r.images && r.images.length) images.push(...r.images);
          }
          if (images.length) {
            const parts = [{ type: 'text', text: '（这是上一步操作后的最新截图）' }];
            images.forEach((url) => parts.push({ type: 'image_url', image_url: { url } }));
            state.messages.push({ role: 'user', content: parts });
          }
          continue;
        }

        const text = msg.content || '';
        state.messages.push({ role: 'assistant', content: text });
        finalText = text;
        emit({ type: 'done', reply: text, steps });
        return { reply: text, steps, usage: state.usage };
      }
      emit({ type: 'done', reply: finalText, steps, truncated: true });
      return { reply: finalText || '（步骤太多，先停一下。要我继续吗？）', steps, truncated: true };
    } catch (e) {
      const message = String((e && e.message) || e);
      emit({ type: 'error', message });
      return { error: message };
    } finally {
      state.running = false;
      state.pendingResolve = null;
    }
  }

  function resolveConfirmation(choice) {
    const r = state.pendingResolve;
    state.pendingResolve = null;
    if (r) { r(choice); return true; }
    return false;
  }

  function abort() {
    state.abort = true;
    const r = state.pendingResolve;
    state.pendingResolve = null;
    if (r) r('deny');
    return true;
  }

  function reset(keepUsage) {
    state.messages = state.system ? [{ role: 'system', content: state.system }] : [];
    state.autoTask = false;
    if (!keepUsage) { state.usage = { input: 0, output: 0, total: 0, cached: 0, usd: 0, calls: 0 }; state.history = []; }
    return true;
  }

  return {
    state,
    setSystem,
    replaceHistory,
    run,
    abort,
    reset,
    resolveConfirmation,
    isRunning: () => state.running,
    getMessages: () => state.messages,
    getUsage: () => state.usage,
    getUsageHistory: () => state.history.slice(),
    setPolicyOverride: (p) => { state.policyOverride = p; }
  };
}

module.exports = { createAgent };
