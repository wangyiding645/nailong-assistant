'use strict';
/* 引擎路由：pi 内核 / 内置引擎，一套对外接口
 *
 * 选择规则（settings.agent.engine）：
 *   'pi'      用 pi 当大脑（默认，能用就用）
 *   'builtin' 用奶蛙自带的轻量引擎
 *   'auto'    pi 能用就用 pi，起不来就静默退回内置（默认值）
 *
 * 对外方法名与旧版 agent-service 完全一致，IPC 层不用改。
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const P = require('../paths.js');
const { createBridge } = require('./bridge.js');
const { createPiEngine } = require('./pi.js');
const { piMessagesToTranscript, piStatsToUsage, readSessionCwd, repairSessionCwd } = require('./pi-history.js');
const preflightLib = require('./pi-preflight.js');
const agentDirLib = require('./pi-agent-dir.js');
const mcpLib = require('./mcp.js');
const providers = require('../agent/providers.js');
const catalog = require('../agent/model-catalog.js');

function fileMeta(file) {
  const out = { file: file, id: path.basename(file, '.jsonl'), title: '', createdAt: 0, updatedAt: 0, count: 0 };
  try {
    const st = fs.statSync(file);
    out.createdAt = st.birthtimeMs || st.ctimeMs;
    out.updatedAt = st.mtimeMs;
  } catch (e) { /* ignore */ }
  try {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    out.count = lines.length;
    for (let i = 0; i < lines.length; i++) {
      let rec = null;
      try { rec = JSON.parse(lines[i]); } catch (e) { continue; }
      if (i === 0) {
        out.id = String(rec.id || rec.sessionId || out.id);
        if (rec.timestamp || rec.createdAt || rec.time) out.createdAt = Number(rec.timestamp || rec.createdAt || rec.time) || out.createdAt;
        if (rec.name) out.title = String(rec.name);
      }
      // 会话名可能在后面被改名，取最后一个看到的
      if (rec.type === 'session_info' || rec.type === 'session_name' || rec.name) {
        if (rec.name) out.title = String(rec.name);
      }
      // 兜底：用第一条用户消息当标题
      if (!out.title && rec.type === 'message' && rec.message && rec.message.role === 'user') {
        const c = rec.message.content;
        const txt = typeof c === 'string' ? c : (Array.isArray(c) ? c.map((p) => (p && p.text) || '').join(' ') : '');
        if (txt) out.title = txt.replace(/\s+/g, ' ').slice(0, 22);
      }
    }
  } catch (e) { /* ignore */ }
  if (!out.title) out.title = '对话 ' + out.id.slice(0, 8);
  return out;
}

function createEngineRouter(deps) {
  const { builtin, settings, log, services, host, emit, getLocale, getForeground } = deps;
  function limitTask(message) { bridge.cancelPending(); pi.abort().catch(e => log.warn('[pi] 中止失败：' + e.message)); emit('agent-event', { type: 'error', message }); }

  const bridge = createBridge({
    host, services, log,
    onLimit: limitTask,
    toolset: builtin.toolset,
    getPolicy: () => builtin.policy(),
    askUser: (req) => new Promise((resolve) => {
      deps.pendingAsk = resolve;
      emit(req.kind === 'question' ? 'agent-question' : 'agent-pending', req);
    }),
    getModelConfig: () => {
      const c = builtin.rawConfig();
      const agentSettings = settings.agentCfg();
      return {
        baseUrl: c.baseUrl,
        model: c.model,
        key: c.key,
        provider: c.provider,
        modelCatalog: catalog.fromConfig(c),
        temperature: c.temperature,
        useCustomProvider: agentSettings.useCustomProvider !== false,
        maxTokens: c.maxTokens,
        contextWindow: agentSettings.contextWindow || 128000
      };
    },
    getMeta: () => ({ version: deps.version, locale: getLocale() }),
    getRuntimeFlags: () => ({ planMode: !!settings.agentCfg().planMode }),
    // 计划审批走和“每步确认”同一套回调，UI 那边只是多一种卡片
    askPlan: (plan) => new Promise((resolve) => {
      deps.pendingAsk = resolve;
      emit('agent-plan', plan);
    })
  });

  const pi = createPiEngine({
    bridge, log, services, emit,
    getLocale, getForeground
  });

  const sessionDir = path.join(P.userData, 'pi-sessions');
  let lastDisabled = JSON.stringify(settings.agentCfg().disabledTools || {});
  let lastPiFingerprint = '';
  let preflightCache = null;

  /** 'bundled' = 用应用自带的一套 pi 配置（默认，不读 ~/.pi）；'system' = 用机器上 pi 自己的配置 */
  function piConfigMode() {
    return settings.agentCfg().piConfig === 'system' ? 'system' : 'bundled';
  }

  function activeAgentDir() {
    return piConfigMode() === 'bundled' ? P.piAgent : preflightLib.agentDir();
  }

  /**
   * bundled 模式：把奶蛙的模型配置写进自带 agent 目录，并合成 --model nailong/<模型>。
   * 没配齐（缺 Base URL / Key / 模型）就不传 --model —— 让 pi 自己报“没有可用模型”，
   * 比强行传一个解析不了的模型名好排查。
   */
  function prepareBundledAgent() {
    const c = builtin.rawConfig();
    const a = settings.agentCfg();
    const usable = a.useCustomProvider !== false && !!(c.baseUrl && c.key && c.model);
    const info = agentDirLib.ensure(P.piAgent, {
      model: usable ? c.model : '',
      thinking: a.thinking || 'off',
      selectedModel: a.selectedModel || '',
      log: log
    });
    return { dir: info.dir, usable: usable, model: c.model, wrote: info.wrote };
  }

  function runtimeFingerprint() {
    const a = settings.agentCfg();
    return JSON.stringify({
        ext: !!a.loadUserExtensions,
        mode: piConfigMode(),
        noMcp: !!a.noMcp,
        noSkills: !!a.noSkills,
        noContextFiles: !!a.noContextFiles,
        skillPaths: Array.isArray(a.skillPaths) ? a.skillPaths : [],
        workspace: a.workspace || P.ROOT,
        contextWindow: a.contextWindow || 128000
      });
  }

  function persistAgent(patch) {
    const before = Object.assign({}, settings.agentCfg());
    settings.setKey('agent', Object.assign({}, before, patch));
    if (settings.store && settings.store.saveNow() === false) {
      settings.setKey('agent', before);
      throw new Error('运行配置写入失败，本次未保存');
    }
  }

  /** 助手当前的工作目录：设置里指定的工作区，没设就用数据根 */
  function agentCwd() {
    const a = settings.agentCfg();
    return a.workspace || P.ROOT;
  }

  /** pi 的启动参数由设置决定；改了设置就重启子进程让它生效 */
  function piStartOpts() {
    const a = settings.agentCfg();
    const opts = {
      sessionDir: sessionDir,
      cwd: agentCwd(),
      sessionFile: pi.state.sessionFile || '',
      thinking: a.thinking || 'off',
      loadUserExtensions: !!a.loadUserExtensions,
      noMcp: !!a.noMcp,
      noSkills: !!a.noSkills,
      noContextFiles: !!a.noContextFiles,
      skillPaths: Array.isArray(a.skillPaths) ? a.skillPaths.filter(Boolean) : []
    };
    if (piConfigMode() === 'bundled') {
      const prepared = prepareBundledAgent();
      opts.agentDir = prepared.dir;
      if (prepared.usable) opts.model = a.selectedModel || 'nailong/' + prepared.model;
    }
    return opts;
  }

  // ------------------------------------------------------------ MCP
  function mcpFile() {
    return path.join(activeAgentDir(), 'mcp.json');
  }

  /** 只有自带目录才让我们改；用户自己的 ~/.pi/agent 不替他动 */
  function mcpWritable() {
    return piConfigMode() === 'bundled';
  }

  /** 用 pi 自己的 CLI 查 MCP 真实状态（连上了没、暴露了哪些工具）——比我们自己猜准得多 */
  let mcpStatusCache = null;
  function runPiCli(args, timeout) {
    const cli = pi.cliPath();
    if (!cli) return Promise.resolve({ code: -1, stdout: '', stderr: '找不到自带的 pi' });
    const rt = pi.resolveRuntime();
    const env = Object.assign({}, process.env, rt.env);
    if (piConfigMode() === 'bundled') env.PI_CODING_AGENT_DIR = P.piAgent;
    else delete env.PI_CODING_AGENT_DIR;
    return new Promise((resolve) => {
      execFile(rt.exe, [cli].concat(args), {
        env: env, timeout: timeout || 25000, windowsHide: true, maxBuffer: 4 * 1024 * 1024
      }, (err, stdout, stderr) => {
        resolve({ code: err ? 1 : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err ? String(err.message || err) : '' });
      });
    });
  }

  /** @param {boolean} force 忽略缓存（刷新/登录完成后用） */
  async function mcpStatus(force) {
    if (!force && mcpStatusCache && Date.now() - mcpStatusCache.at < 5000) return mcpStatusCache.value;
    const r = await runPiCli(['mcp', 'list', '--json']);
    let data = null;
    try { data = JSON.parse(r.stdout); } catch (e) { data = null; }
    const value = {
      ok: !!data,
      error: data ? '' : (r.stderr || r.error || 'pi mcp list 没返回可解析的内容').slice(0, 300),
      servers: (data && data.servers) || []
    };
    mcpStatusCache = { at: Date.now(), value: value };
    return value;
  }

  function readMcp() {
    const file = mcpFile();
    const r = mcpLib.read(file);
    return {
      ok: r.ok,
      error: r.error || '',
      path: file,
      writable: mcpWritable(),
      mode: piConfigMode(),
      // MCP 是靠 pi 的内置扩展接的，关掉扩展就没人去连它
      extensionsEnabled: !!settings.agentCfg().loadUserExtensions,
      disabledByFlag: !!settings.agentCfg().noMcp,
      servers: mcpLib.describe(r.config),
      raw: mcpLib.serialize(r.config)
    };
  }

  /** 配置 + 真实状态合并后给界面 */
  async function mcpView(force) {
    const base = readMcp();
    if (!base.writable && !base.extensionsEnabled) return base;
    const st = await mcpStatus(force);
    if (st.ok) {
      const byName = {};
      st.servers.forEach((s) => { byName[s.name] = s; });
      base.servers = base.servers.map((s) => {
        const live = byName[s.name];
        if (!live) return s;
        return Object.assign({}, s, {
          state: String(live.state || ''),
          liveTools: Array.isArray(live.tools) ? live.tools : [],
          liveError: String(live.error || ''),
          liveEnabled: live.enabled !== false
        });
      });
      // 配置里没有、但 pi 认为是注册过的，也列出来（比如扩展注册的）
      st.servers.forEach((s) => {
        if (!base.servers.some((x) => x.name === s.name)) {
          base.servers.push({ name: s.name, type: 'extension', target: s.transport || '', enabled: s.enabled !== false, state: s.state, liveTools: s.tools || [], liveError: s.error || '' });
        }
      });
    } else {
      base.statusError = st.error;
    }
    base.statusChecked = true;
    return base;
  }

  async function mcpLogout(name) {
    const r = await runPiCli(['mcp', 'logout', String(name || '')]);
    mcpStatusCache = null;
    return { ok: r.code === 0, output: (r.stdout + r.stderr).slice(0, 300) };
  }

  function writeMcp(mutator) {
    if (!mcpWritable()) {
      return { ok: false, error: '当前用的是机器上 pi 自己的配置，奶蛙不替你改那份 mcp.json。'
        + '要么在设置里切到「应用自带」，要么自己用 `pi mcp` 命令改。' };
    }
    const file = mcpFile();
    const r = mcpLib.read(file);
    if (!r.ok) return { ok: false, error: '现有的 mcp.json 读不了：' + r.error };
    const next = mutator(r.config);
    if (!next || next.ok === false) return next || { ok: false, error: '修改失败' };
    mcpLib.write(file, next.config || next);
    // 改完必须重启 pi 才会去连新服务器
    try { pi.stop(); } catch (e) { /* ignore */ }
    return readMcp();
  }

  async function mcpAdd(name, rawText) {
    const ex = mcpLib.extractEntry(rawText);
    if (!ex.ok) return { ok: false, error: ex.error };
    if (ex.multi) {
      return writeMcp((cfg) => {
        let cur = cfg;
        for (const n of Object.keys(ex.multi)) {
          const r = mcpLib.upsert(cur, n, ex.multi[n]);
          if (!r.ok) return r;
          cur = r.config;
        }
        return { ok: true, config: cur };
      });
    }
    const n = String(name || ex.name || '').trim();
    if (!n) return { ok: false, error: '请填一个服务器名' };
    return writeMcp((cfg) => mcpLib.upsert(cfg, n, ex.single));
  }

  async function mcpRemove(name) {
    return writeMcp((cfg) => ({ ok: true, config: mcpLib.remove(cfg, name) }));
  }

  async function mcpToggle(name, enabled) {
    return writeMcp((cfg) => ({ ok: true, config: mcpLib.setEnabled(cfg, name, enabled) }));
  }

  /** 自检：看的是**当前生效**的 agent 目录，外加奶蛙自己的接口配置是否齐 */
  async function runPreflight(force) {
    if (!force && preflightCache && Date.now() - preflightCache.at < 60000) return preflightCache.value;
    let v;
    if (piConfigMode() === 'bundled') {
      const c = builtin.rawConfig();
      const a = settings.agentCfg();
      const usable = a.useCustomProvider !== false && !!(c.baseUrl && c.key && c.model);
      const info = agentDirLib.inspect(P.piAgent);
      v = {
        mode: 'bundled',
        agentDir: P.piAgent,
        settingsFile: info.settingsFile,
        settingsReadable: !info.error,
        credentials: { file: '(由奶蛙设置提供)', ok: usable },
        proxy: { configured: !!info.proxy, url: info.proxy || '', host: '', port: 0, reachable: info.proxy ? false : null },
        model: (info.settings && info.settings.defaultModel) || '',
        warnings: []
      };
      if (info.error) v.warnings.push('自带 agent 目录的 settings.json 读不了（' + info.error + '）：' + info.settingsFile);
      if (info.proxy) v.warnings.push('应用自带的 pi 配置里出现了代理 ' + info.proxy + '，这不正常（奶蛙不会写代理），建议把这一项删掉。');
      if (!usable) {
        v.warnings.push('pi 内核还没有可用的接口配置：请在上面的「模型接口」里填好 Base URL、API Key 和模型名。'
          + '在那之前奶蛙会用「内置引擎」干活（日程、番茄钟、提醒都不受影响）。');
      }
    } else {
      v = await preflightLib.preflight({ agentDir: preflightLib.agentDir() });
      v.mode = 'system';
    }
    preflightCache = { at: Date.now(), value: v };
    return v;
  }

  async function piUp() {
    await ensureBridge();
    try {
      const pf = await runPreflight();
      pf.warnings.forEach((w) => log.warn('[pi] 环境提醒：' + w));
    } catch (e) { /* 自检失败不影响主流程 */ }
    await pi.start(piStartOpts());
    if (!lastPiFingerprint) lastPiFingerprint = runtimeFingerprint();
    // 跟着设置把自动压缩/重试同步过去（pi 默认也是开的，这里只是尊重用户的开关）
    const a = settings.agentCfg();
    if (pi.ready) {
      try { await pi.setAutoCompaction(a.autoCompaction !== false); } catch (e) { /* ignore */ }
      try { await pi.setAutoRetry(a.autoRetry !== false); } catch (e) { /* ignore */ }
    }
    return pi;
  }

  function engineSetting() {
    const e = settings.agentCfg().engine;
    return e === 'builtin' || e === 'pi' ? e : 'auto';
  }

  /** 实际生效的引擎：auto 时按 pi 可用性决定 */
  function activeEngine() {
    const want = engineSetting();
    if (want === 'builtin') return 'builtin';
    if (want === 'pi') return 'pi';
    // auto：
    //   pi 已就绪且有模型 → pi
    //   pi 已就绪但没模型 → 内置（那边的报错是“去填 Base URL / API Key”，能直接照做）
    //   pi 正在启动      → 先当 pi（预热期间不要把用户的消息路由到内置）
    //   其它（没起、失败）→ 内置
    if (pi.ready) return pi.model ? 'pi' : 'builtin';
    if (pi.starting) return 'pi';
    const c = builtin.rawConfig();
    if (!pi.lastError && pi.cliPath() && c.baseUrl && c.key && c.model) return 'pi';
    return 'builtin';
  }

  async function ensureBridge() {
    if (!bridge.isRunning) await bridge.start();
    return bridge;
  }

  // ------------------------------------------------------------ pi 会话
  function listPiSessions() {
    const out = [];
    const walk = (dir, depth) => {
      if (depth > 4) return;
      let names = [];
      try { names = fs.readdirSync(dir); } catch (e) { return; }
      for (const n of names) {
        const full = path.join(dir, n);
        let st = null;
        try { st = fs.statSync(full); } catch (e) { continue; }
        if (st.isDirectory()) { walk(full, depth + 1); continue; }
        if (!n.endsWith('.jsonl')) continue;
        out.push(fileMeta(full));
      }
    };
    walk(sessionDir, 0);
    return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 60);
  }

  // ------------------------------------------------------------ 对外接口
  return {
    bridge, pi,
    get toolset() { return builtin.toolset; },
    get sessions() { return builtin.sessions; },

    engine: activeEngine,
    engineSetting,
    piConfigMode,
    /** pi 侧环境自检（带缓存，避免每次刷界面都探一遍端口） */
    preflight: (force) => runPreflight(!!force),
    engineInfo() {
      return {
        setting: engineSetting(),
        configMode: piConfigMode(),
        agentDir: activeAgentDir(),
        active: activeEngine(),
        pi: {
          ready: pi.ready,
          starting: pi.starting,
          cli: pi.cliPath(),
          extension: pi.extensionPath(),
          sessionId: pi.sessionId,
          sessionName: pi.sessionName,
          model: pi.model,
          thinking: pi.thinkingLevel,
          provider: pi.state.modelProvider,
          streaming: pi.streaming,
          error: pi.lastError,
          stderr: pi.stderrTail.slice(-5),
          loadUserExtensions: !!settings.agentCfg().loadUserExtensions,
          preflight: preflightCache ? preflightCache.value : null
        },
        configured: { model: builtin.rawConfig().model, thinking: settings.agentCfg().thinking || 'off', workspace: settings.agentCfg().workspace || P.ROOT },
        bridge: { running: bridge.isRunning, port: bridge.port }
      };
    },

    // ---- 配置（两个引擎共用同一份 Base URL / Key / 模型） ----
    publicConfig() {
      const c = builtin.publicConfig();
      return Object.assign(c, {
        engine: engineSetting(),
        activeEngine: activeEngine(),
        piReady: pi.ready,
        piError: pi.lastError
      });
    },
    rawConfig: () => builtin.rawConfig(),
    saveConfig: (patch) => {
      if (pi.streaming) throw new Error('请先停止当前任务再修改接口配置');
      const r = builtin.saveConfig(patch);
      if (patch && (patch.baseUrl !== undefined || patch.provider !== undefined || patch.model !== undefined)) persistAgent({ selectedModel: '' });
      if (patch && patch.engine) settings.setKey('agent', Object.assign({}, settings.agentCfg(), { engine: patch.engine }));
      // 改了接口配置，pi 侧要重启才能用新的 provider
      if (patch && ['baseUrl', 'key', 'model', 'modelCatalog', 'provider', 'clearKey', 'maxTokens', 'temperature'].some(k => patch[k] !== undefined)) {
        lastPiFingerprint = '';
        preflightCache = null;
        if (pi.streaming) throw new Error('请先停止当前任务再修改接口配置');
        if (pi.ready) { try { pi.stop(); } catch (e) { /* ignore */ } }
      }
      return r;
    },
    /** 换了必须重启才生效的设置（如用户扩展开关）時调一下 */
    /** 换了必须重启才生效的设置（用户扩展开关 / agent 目录模式 / 那一堆 pi 开关）时调一下 */
    restartPiIfNeeded() {
      const fingerprint = runtimeFingerprint();
      if (fingerprint !== lastPiFingerprint) {
        lastPiFingerprint = fingerprint;
        return true;
      }
      return false;
    },
    async restartPi() {
      try { pi.stop(); } catch (e) { /* ignore */ }
      await new Promise((r) => setTimeout(r, 300));
      if (activeEngine() === 'builtin') return { ready: false, reason: '当前用的是内置引擎' };
      await piUp();
      return pi.status();
    },
    /**
     * 开机预热。必须走这个入口而不是直接 pi.start()：
     * piStartOpts() 里含 agent 目录与 --model，绕过它就会变成“静默用机器上的 pi 配置”。
     */
    async warmUp() {
      // 不要用 activeEngine() 判断：那时 pi 还没起来，auto 模式下会被判成 builtin，
      // 结果就是“预热直接被跳过”（打包后实测踩到过）。
      if (engineSetting() === 'builtin') return { ready: false, reason: 'builtin' };
      // 自带模式但接口还没配：起来了也没模型可用，不如不浪费一个进程
      if (piConfigMode() === 'bundled') {
        const c = builtin.rawConfig();
        const a = settings.agentCfg();
        if (a.useCustomProvider === false || !(c.baseUrl && c.key && c.model)) {
          return { ready: false, reason: 'no-config' };
        }
      }
      await piUp();
      return pi.status();
    },
    policy: () => builtin.policy(),
    applyToolSettings() {
      builtin.applyToolSettings();
      // 工具开关变了：pi 那份工具清单是启动时拉的，得重启才能生效
      const now = JSON.stringify(settings.agentCfg().disabledTools || {});
      if (now !== lastDisabled) {
        lastDisabled = now;
        if (pi.ready) { try { pi.stop(); } catch (e) { /* ignore */ } }
      }
      return true;
    },
    rebuildPrompt: () => true,

    // ---- 连通性 ----
    async testConnection() {
      if (activeEngine() === 'pi') {
        await piUp();
        const st = await pi.status();
        if (st.ready) return { reply: 'pi 内核就绪（' + (st.model || '未选模型') + '）；此检查仅验证内核启动，模型接口需通过实际对话验证', provider: 'pi', engine: 'pi', connectionVerified: false };
        throw new Error(st.error || 'pi 内核没起来');
      }
      const r = await builtin.testConnection();
      return Object.assign(r, { engine: 'builtin' });
    },
    async detectModel(overrides) {
      const r = await builtin.detectModel(overrides && overrides.baseUrl, overrides && overrides.key);
      return r;
    },
    /** pi 内核能用的模型（含用户订阅登录的） */
    async listPiModels() {
      if (engineSetting() === 'builtin') return catalog.fromConfig(builtin.rawConfig()).map(m => Object.assign({}, m, { provider: 'nailong', input: m.vision ? ['text', 'image'] : ['text'] }));
      await piUp();
      return pi.models();
    },

    // ---- MCP 服务器 ----
    mcp: (p) => mcpView(!!(p && p.force)),
    mcpAdd: (name, raw) => mcpAdd(name, raw),
    mcpRemove: (name) => mcpRemove(name),
    mcpToggle: (name, on) => mcpToggle(name, on),
    mcpLogout: (name) => mcpLogout(name),
    mcpStatus,
    runPiCli,

    // ---- 对话 ----
    async send(text, opts) {
      const o = opts || {};
      if (activeEngine() === 'builtin') {
        return builtin.send(text, o);
      }
      await piUp();
      // 附件优先用界面传进来的（拖图/粘贴），其次才是“附带当前屏幕”
      if (!pi.streaming) {
        bridge.resetTask(o.auto);
      }
      let images = [];
      (Array.isArray(o.images) ? o.images : []).forEach((url) => {
        const m = /^data:([^;]+);base64,(.*)$/s.exec(String(url || ''));
        if (m) images.push({ type: 'image', data: m[2], mimeType: m[1] });
      });
      if (!images.length && o.withShot) {
        try {
          const shot = await host.screenshot({});
          const m = /^data:([^;]+);base64,(.*)$/s.exec(shot.dataUrl);
          if (m) images.push({ type: 'image', data: m[2], mimeType: m[1] });
        } catch (e) {
          log.warn('[pi] 附带截图失败：' + e.message);
        }
      }
      const payload = {};
      // 正在跑的时候再发一句，必须告诉 pi 是“插入当前任务”还是“排在后面”
      if (pi.streaming) payload.streamingBehavior = o.mode === 'followUp' ? 'followUp' : 'steer';
      const res = await pi.command('prompt', Object.assign({ message: String(text || '') }, images.length ? { images: images } : {}, payload), 60000);
      return { ok: true, engine: 'pi', disposition: res && res.disposition, steered: !!payload.streamingBehavior };
    },
    confirm(value) {
      // 桥侧挂着的确认
      if (deps.pendingAsk) {
        const r = deps.pendingAsk;
        deps.pendingAsk = null;
        r(value === undefined ? 'deny' : String(value));
        return true;
      }
      return builtin.confirm(value);
    },
    stop() {
      if (deps.pendingAsk) { const r = deps.pendingAsk; deps.pendingAsk = null; r('deny'); }
      bridge.cancelPending();
      if (activeEngine() === 'pi') { pi.abort(); return true; }
      return builtin.stop();
    },
    async clear() {
      if (activeEngine() === 'pi') {
        bridge.cancelPending();
        const created = await pi.newSession(); await pi.status(); return created;
      }
      return builtin.clear();
    },

    // ---- 会话 ----
    listSessions() {
      if (activeEngine() === 'pi') {
        const list = listPiSessions().map((s) => ({
          id: s.file, file: s.file, sessionId: s.id, title: s.title,
          createdAt: s.createdAt, updatedAt: s.updatedAt, count: s.count
        }));
        // 当前会话按文件路径比。以前拿文件路径去比 pi 的 sessionId，永远不相等，
        // 于是历史列表里标不出「你现在在这条」。
        const cur = String(pi.state.sessionFile || '');
        const hit = cur ? list.find((x) => path.resolve(x.file) === path.resolve(cur)) : null;
        return { list: list, current: hit ? hit.id : null, engine: 'pi' };
      }
      return Object.assign(builtin.listSessions(), { engine: 'builtin' });
    },
    async newSession() {
      if (activeEngine() === 'pi') {
        await piUp();
        const created = await pi.newSession(); await pi.status(); return created;
      }
      return builtin.newSession();
    },
    async loadSession(id) {
      if (activeEngine() === 'pi') {
        await piUp();
        const target = String(id || '');
        const switchTo = async () => pi.command('switch_session', { sessionPath: target }, 20000);
        let r = null;
        let repaired = null;
        try {
          r = await switchTo();
        } catch (e) {
          // 会话记的工作目录被删了（换过盘、搬过文件夹、覆盖安装换了数据根）。
          // pi 自己的交互式界面这时会问一句「用当前工作目录继续吗」，RPC 模式没有这个兜底，
          // 只会抛 MissingSessionCwdError，于是历史会话永远点不开 —— 我们按同一套语义改目录再试一次。
          const msg = String((e && e.message) || '');
          if (!/working directory does not exist|MissingSessionCwd/i.test(msg)) throw e;
          const from = readSessionCwd(target);
          const to = agentCwd();
          if (!repairSessionCwd(target, to)) throw e;
          log.warn('[pi] 会话工作目录已失效，改用当前目录打开：' + from + ' → ' + to);
          repaired = { from: from, to: to };
          r = await switchTo();
        }
        if (r && r.cancelled) return null;
        await pi.status();
        const meta = fileMeta(target);
        const transcript = piMessagesToTranscript(await pi.messages());
        return { id: target, title: meta.title, messages: [], transcript: transcript, repaired: repaired };
      }
      return builtin.loadSession(id);
    },
    async renameSession(name) {
      if (activeEngine() !== 'pi') return false;
      await piUp();
      return pi.rename(name);
    },
    /** 从当前会话的某条消息处开个分支 */
    async forkSession(entryId) {
      if (activeEngine() !== 'pi') return { unsupported: true };
      await piUp();
      const r = await pi.fork(entryId); await pi.status();
      if (r && !r.cancelled) {
        // 分支后会话变了，把新会话的历史推给界面
        const transcript = piMessagesToTranscript(await pi.messages());
        emit('agent-event', { type: 'history-reset' });
        return Object.assign({}, r, { transcript: transcript });
      }
      return r;
    },
    async forkMessages() {
      if (activeEngine() !== 'pi') return [];
      await piUp();
      return pi.forkMessages();
    },
    async cloneSession() {
      if (activeEngine() !== 'pi') return { unsupported: true };
      await piUp();
      const r = await pi.clone(); await pi.status(); return r;
    },
    async sessionTree() {
      if (activeEngine() !== 'pi') return { tree: [], leafId: '' };
      await piUp();
      return pi.tree();
    },

    // ---- 模型 / 思考档位 ----
    async piSetModel(provider, modelId) {
      if (pi.streaming) throw new Error('请先停止当前任务再切换模型');
      if (!provider || !modelId) throw new Error('请选择有效的模型');
      if (engineSetting() === 'builtin') {
        const m = catalog.fromConfig(builtin.rawConfig()).find(x => x.id === modelId);
        if (provider !== 'nailong' || !m) throw new Error('当前接口没有这个模型');
        builtin.saveConfig({ model: modelId });
        return { id: modelId, provider };
      }
      await piUp();
      const models = await pi.models();
      if (!models.some(m => m.provider === provider && m.id === modelId)) throw new Error('模型不在可用目录中');
      const previous = await pi.command('get_state', {}, 10000);
      const previousConfig = { model: builtin.rawConfig().model, maxTokens: builtin.rawConfig().maxTokens };
      try {
        const result = await pi.setModel(provider, modelId);
        if (provider === 'nailong') builtin.saveConfig({ model: modelId, maxTokens: models.find(m => m.id === modelId && m.provider === provider).maxTokens || builtin.rawConfig().maxTokens });
        persistAgent({ selectedModel: provider + '/' + modelId, thinking: pi.thinkingLevel });
        return result;
      } catch (e) {
        if (provider === 'nailong') builtin.saveConfig(previousConfig);
        if (previous.model) { await pi.setModel(previous.model.provider, previous.model.id); await pi.setThinking(previous.thinkingLevel || 'off'); }
        throw e;
      }
    },
    async piCycleModel() {
      const models = await this.listPiModels();
      if (!models.length) throw new Error('没有可用模型');
      const at = models.findIndex(m => m.id === pi.model);
      const next = models[(at + 1) % models.length];
      return this.piSetModel(next.provider, next.id);
    },
    async piThinkingLevels() {
      if (engineSetting() === 'builtin') return ['off'];
      await piUp();
      return pi.thinkingLevels();
    },
    async piSetThinking(level) {
      if (engineSetting() === 'builtin') throw new Error('思考强度需要 pi 内核；请在运行配置中切换');
      if (pi.streaming) throw new Error('请先停止当前任务再修改思考强度');
      await piUp();
      const levels = await pi.thinkingLevels();
      if (!levels.includes(level)) throw new Error('当前模型不支持该思考强度：' + level);
      const previous = pi.thinkingLevel;
      const effective = await pi.setThinking(level);
      try { persistAgent({ thinking: effective }); }
      catch (e) { await pi.setThinking(previous || 'off'); throw e; }
      return effective;
    },
    async applyRuntimeSettings() {
      if (pi.ready) {
        const a = settings.agentCfg();
        await pi.setAutoCompaction(a.autoCompaction !== false);
        await pi.setAutoRetry(a.autoRetry !== false);
      }
    },
    async piCompact(instructions) {
      if (activeEngine() !== 'pi') return { unsupported: true };
      await piUp();
      return pi.compact(instructions);
    },
    async piCommands() {
      if (activeEngine() !== 'pi') return [];
      await piUp();
      return pi.commands();
    },
    async deleteSession(id) {
      if (activeEngine() === 'pi') {
        try { fs.unlinkSync(String(id)); } catch (e) { /* ignore */ }
        return true;
      }
      return builtin.deleteSession(id);
    },

    // ---- 用量 ----
    usage: () => (activeEngine() === 'pi' ? pi.usage : builtin.usage()),
    async usageDetail() {
      if (activeEngine() === 'pi') {
        const s = piStatsToUsage(await pi.stats());
        return { total: s || pi.usage, byDay: [], stats: s };
      }
      return builtin.usageDetail();
    },
    async sessionStats() {
      if (activeEngine() !== 'pi') return null;
      return pi.stats();
    }
  };
}

module.exports = { createEngineRouter, fileMeta };
