'use strict';
/* Agent 服务：把配置、会话、工具、权限、用量接起来，对 IPC 暴露一组方法 */

const fs = require('fs');
const { safeStorage } = require('electron');
const { createCredentials } = require('./credentials.js');

const P = require('./paths.js');
const providers = require('./agent/providers.js');
const catalog = require('./agent/model-catalog.js');
const { createAgent } = require('./agent/agent.js');
const { createSessionStore } = require('./agent/sessions.js');
const { createTools } = require('./tools/index.js');
const promptLib = require('./agent/prompt.js');
const usageLib = require('./agent/usage.js');
const { createStore } = require('./store.js');
const L = require('../shared/logic.js');
const T = require('../shared/task.js');

function createAgentService(deps) {
  const { log, services, host, emit, getLocale, getForeground } = deps;
  const credentials = deps.credentials || createCredentials({ safeStorage });
  const toolset = createTools(host);
  const sessions = createSessionStore(createStore(P.sessions, { list: [], current: null }, { version: 1 }));

  const cfgStore = createStore(P.agent, {
    baseUrl: '', model: '', provider: 'auto', maxTokens: 4096, temperature: 0.2,
    timeoutMs: 180000, historyChars: 160000, modelCatalog: []
  }, { version: 2 });

  // 兼容 v2 的加密字段 keyEnc / 明文 key
  let apiKey = '';
  let keyPersistence = 'none';
  try {
    const raw = JSON.parse(fs.readFileSync(P.agent, 'utf8'));
    if (raw.keyEnc) {
      try { apiKey = credentials.decrypt(raw.keyEnc); keyPersistence = 'encrypted'; }
      catch (e) {
        keyPersistence = 'unavailable';
        log.warn('[agent] 已保存的密钥暂时无法解密，保留原密文，请重新填写密钥或恢复原 Windows 账户环境');
      }
    } else if (raw.key) {
      apiKey = String(raw.key);
      keyPersistence = 'memory';
      try { persist(); } catch (e) { log.warn('[agent] 旧密钥迁移未完成，请重新保存'); }
    }
  } catch (e) { /* 首次运行 */ }

  function persist() {
    const out = Object.assign({}, cfgStore.all);
    delete out.key;
    if (apiKey) {
      try {
        out.keyEnc = credentials.encrypt(apiKey);
      } catch (e) {
        throw new Error('无法安全保存 API 密钥：Windows 加密不可用。请恢复 Windows 账户环境后重试；本次未保存。');
      }
    } else if (keyPersistence !== 'unavailable') {
      delete out.keyEnc;
    }
    delete cfgStore.all.key;
    delete cfgStore.all.keyEnc;
    Object.assign(cfgStore.all, out);
    if (cfgStore.saveNow() === false) throw new Error('配置文件写入失败，本次未保存。请检查数据目录权限及磁盘空间。');
    keyPersistence = apiKey ? 'encrypted' : out.keyEnc ? 'unavailable' : 'none';
  }

  function saveConfig(patch) {
    const p = Object.assign({}, patch || {});
    if (p.modelCatalog !== undefined) p.modelCatalog = catalog.normalize(p.modelCatalog);
    if (p.maxTokens !== undefined && (!Number.isInteger(Number(p.maxTokens)) || Number(p.maxTokens) < 256 || Number(p.maxTokens) > 1048576)) throw new Error('输出上限必须为 256–1048576');
    if (p.temperature !== undefined && (!Number.isFinite(Number(p.temperature)) || Number(p.temperature) < 0 || Number(p.temperature) > 2)) throw new Error('随机度必须为 0–2');
    const before = Object.assign({}, cfgStore.all);
    const oldKey = apiKey;
    const oldPersistence = keyPersistence;
    // 配置和密文一起同步提交，避免防抖写入覆盖密钥。
    if (typeof p.baseUrl === 'string') cfgStore.all.baseUrl = p.baseUrl.trim();
    if (typeof p.model === 'string') cfgStore.all.model = p.model.trim();
    if (typeof p.provider === 'string') cfgStore.all.provider = p.provider;
    if (p.modelCatalog !== undefined) cfgStore.all.modelCatalog = catalog.normalize(p.modelCatalog);
    if (p.maxTokens !== undefined) {
      const n = Number(p.maxTokens);
      if (!Number.isInteger(n) || n < 256 || n > 1048576) throw new Error('输出上限必须为 256–1048576');
      cfgStore.all.maxTokens = n;
    }
    if (p.temperature !== undefined) cfgStore.all.temperature = Math.max(0, Math.min(2, Number(p.temperature)));
    if (typeof p.key === 'string' && p.key.trim() !== '' && p.key.indexOf('\u2022') < 0) apiKey = p.key.trim();
    if (p.clearKey) { apiKey = ''; keyPersistence = 'none'; }
    try { persist(); } catch (e) {
      Object.keys(cfgStore.all).forEach(k => delete cfgStore.all[k]);
      Object.assign(cfgStore.all, before);
      apiKey = oldKey;
      keyPersistence = oldPersistence;
      throw e;
    }
    return publicConfig();
  }

  function publicConfig() {
    return {
      baseUrl: cfgStore.get('baseUrl'),
      model: cfgStore.get('model'),
      modelCatalog: catalog.fromConfig(cfgStore.all),
      provider: cfgStore.get('provider'),
      maxTokens: cfgStore.get('maxTokens'),
      temperature: cfgStore.get('temperature'),
      timeoutMs: cfgStore.get('timeoutMs'),
      hasKey: !!apiKey,
      keyPersistence,
      effectiveProvider: providers.detectProvider({ baseUrl: cfgStore.get('baseUrl'), model: cfgStore.get('model'),
      modelCatalog: catalog.fromConfig(cfgStore.all), provider: cfgStore.get('provider') })
    };
  }

  function rawConfig() {
    return {
      baseUrl: cfgStore.get('baseUrl'),
      model: cfgStore.get('model'),
      modelCatalog: catalog.fromConfig(cfgStore.all),
      provider: cfgStore.get('provider'),
      maxTokens: cfgStore.get('maxTokens'),
      temperature: cfgStore.get('temperature'),
      timeoutMs: cfgStore.get('timeoutMs'),
      historyChars: cfgStore.get('historyChars'),
      key: apiKey
    };
  }

  function policy() {
    const a = services.settings.agentCfg();
    const p = Object.assign({ mode: 'confirm', allow: {}, deny: {}, confirmHighRisk: true, maxSteps: 0 }, a.policy || {});
    delete p.maxRuntimeMs; // 兼容旧设置；任务不再设总时长上限。
    p.selfRoot = P.ROOT;
    p.planMode = !!a.planMode;
    return p;
  }

  function buildPrompt() {
    const now = new Date();
    const today = L.todayStr(now);
    const items = T.itemsOn(services.schedule.tasks(), today);
    return promptLib.buildSystemPrompt({
      locale: services.settings.getKey('agent', {}).locale || getLocale(),
      tools: toolset.all.filter((t) => t.enabled !== false),
      memoryBlock: services.memory.promptBlock(),
      mode: policy().mode,
      env: {
        os: 'Windows',
        datetime: today + ' ' + L.pad2(now.getHours()) + ':' + L.pad2(now.getMinutes()),
        weekday: L.weekdayCn(now),
        foreground: (getForeground && getForeground()) || ''
      },
      schedule: items.map((t) => t.time + ' ' + t.text + (t.repeat ? '（重复）' : '')),
      planMode: !!(services.settings.agentCfg() || {}).planMode
    });
  }

  let pendingConfirm = null;

  const agent = createAgent({
    getConfig: rawConfig,
    get tools() { return toolset.all.filter((t) => t.enabled !== false); },
    getPolicy: policy,
    buildSystemPrompt: buildPrompt,
    onEvent(evt) { forward(evt); },
    confirm(req) {
      return new Promise((resolve) => {
        pendingConfirm = resolve;
        emit(req.kind === 'plan' ? 'agent-plan' : req.kind === 'question' ? 'agent-question' : 'agent-pending', req.kind === 'plan' ? req.plan : req);
      });
    },
    onUsage(u) {
      emit('agent-usage', u);
    }
  });

  function forward(evt) {
    emit('agent-event', evt);
  }

  function attachSession(session) {
    if (!session) return;
    const messages = (session.messages || []).slice();
    messages.unshift({ role: 'system', content: buildPrompt() });
    agent.replaceHistory(messages);
    emit('agent-session', { id: session.id, title: session.title });
  }

  function persistSession() {
    const cur = sessions.current();
    const messages = agent.getMessages().filter((m) => m.role !== 'system');
    if (!cur) {
      const s = sessions.create({});
      sessions.put(Object.assign({}, s, { messages: messages, usage: agent.getUsage() }));
      return;
    }
    sessions.put(Object.assign({}, cur, { messages: messages, usage: agent.getUsage() }));
  }

  function detectModel(baseUrl, key) {
    const cfg = { baseUrl: baseUrl || rawConfig().baseUrl, key: key || apiKey, model: rawConfig().model, provider: rawConfig().provider };
    if (!cfg.baseUrl || !cfg.key) throw new Error('请先填写 Base URL 和 API Key');
    const req = providers.buildModelsRequest(cfg);
    const fetchImpl = host.fetchImpl || globalThis.fetch;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    return fetchImpl(req.url, { headers: req.headers, signal: ctrl.signal })
      .then((res) => {
        clearTimeout(timer);
        if (!res.ok) throw new Error('模型列表接口返回 ' + res.status);
        return res.json();
      })
      .then((data) => {
        const list = providers.listModels(data, req.provider);
        if (!list.length) throw new Error('没取到模型列表，请手动填写模型名');
        const preferred = pickModel(list.map((m) => m.id));
        return { models: list.map((m) => m.id), catalog: catalog.discover(list, cfg.baseUrl), picked: preferred };
      })
      .catch((e) => { clearTimeout(timer); throw new Error(String(e.message || e)); });
  }

  function pickModel(ids) {
    const prefer = [
      /claude.*(sonnet|opus)/i, /gpt-5/i, /gpt-4\.1/i, /gpt-4o/i, /gemini-2\.5-pro/i,
      /qwen.*vl/i, /glm-4v/i, /gemini-2\.5-flash/i, /gpt-4o-mini/i, /gemini-.*flash/i,
      /qwen/i, /deepseek.*(chat|vl)/i, /claude/i, /gpt/i, /gemini/i, /vl/i, /vision/i
    ];
    for (const re of prefer) {
      const hit = ids.find((id) => re.test(id));
      if (hit) return hit;
    }
    return ids[0] || '';
  }

  async function testConnection() {
    const cfg = rawConfig();
    if (!cfg.baseUrl || !cfg.key || !cfg.model) throw new Error('请先填好 Base URL、API Key 和模型名');
    const req = providers.buildChatRequest(cfg, [{ role: 'user', content: '只回复两个字：在线' }], { stream: false, tools: [], maxTokens: 32 });
    const fetchImpl = host.fetchImpl || globalThis.fetch;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const res = await fetchImpl(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: ctrl.signal });
      const text = await res.text();
      if (!res.ok) {
        let msg = text;
        try { const j = JSON.parse(text); msg = (j.error && j.error.message) || j.message || text; } catch (e) { /* 原文 */ }
        throw new Error('接口返回 ' + res.status + '：' + String(msg).slice(0, 300));
      }
      const data = JSON.parse(text);
      const full = providers.parseFullResponse(req.provider, data);
      return { reply: String(full.content || '').slice(0, 80), provider: req.provider };
    } finally { clearTimeout(timer); }
  }

  async function send(text, opts) {
    const o = opts || {};
    toolset.applyDisabled(services.settings.agentCfg().disabledTools);
    if (o.auto !== undefined) agent.setPolicyOverride({ mode: o.auto ? 'auto' : 'confirm' });
    if (!agent.getMessages().length) {
      const cur = sessions.currentOrCreate();
      attachSession(cur);
    }
    let content = String(text || '');
    const attach = (Array.isArray(o.images) ? o.images : []).filter(Boolean);
    if (attach.length) {
      const parts = [{ type: 'text', text: content + '（附了 ' + attach.length + ' 张图）' }];
      attach.forEach((u) => parts.push({ type: 'image_url', image_url: { url: u } }));
      content = parts;
    } else if (o.withShot) {
      const s = await host.screenshot({});
      content = [
        { type: 'text', text: content + '（这是当前屏幕截图，尺寸 ' + s.sentW + 'x' + s.sentH + '）' },
        { type: 'image_url', image_url: { url: s.dataUrl } }
      ];
    }
    const r = await agent.run(content, { maxSteps: o.maxSteps });
    persistSession();
    emit('agent-sessions', { list: sessions.list(), current: sessions.current() ? sessions.current().id : null });
    return r;
  }

  return {
    toolset, sessions, agent,
    publicConfig, rawConfig, saveConfig, policy,
    detectModel, testConnection, send,
    confirm(value) {
      if (pendingConfirm) { const r = pendingConfirm; pendingConfirm = null; r(value === undefined ? 'deny' : value); return true; }
      return false;
    },
    stop() { if (pendingConfirm) { const r = pendingConfirm; pendingConfirm = null; r('deny'); } return agent.abort(); },
    clear() {
      agent.reset(true);
      const s = sessions.create({});
      attachSession(s);
      emit('agent-sessions', { list: sessions.list(), current: s.id });
      return true;
    },
    newSession() {
      persistSession();
      const s = sessions.create({});
      attachSession(s);
      emit('agent-sessions', { list: sessions.list(), current: s.id });
      return s;
    },
    loadSession(id) {
      persistSession();
      const s = sessions.get(id);
      if (!s) return null;
      sessions.setCurrent(id);
      attachSession(s);
      emit('agent-sessions', { list: sessions.list(), current: id });
      return s;
    },
    deleteSession(id) {
      sessions.remove(id);
      emit('agent-sessions', { list: sessions.list(), current: sessions.current() ? sessions.current().id : null });
      return true;
    },
    listSessions() { return { list: sessions.list(), current: sessions.current() ? sessions.current().id : null }; },
    usage: () => agent.getUsage(),
    usageDetail: () => ({ total: agent.getUsage(), byDay: usageLib.byDay(agent.getUsageHistory()) }),
    applyToolSettings() { toolset.applyDisabled(services.settings.agentCfg().disabledTools); },
    rebuildPrompt() { agent.setSystem(buildPrompt()); return true; }
  };
}

module.exports = { createAgentService };
