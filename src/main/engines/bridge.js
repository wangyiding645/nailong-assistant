'use strict';
/* 本地工具桥：pi 子进程 ↔ 本应用
 *
 * 为什么要这一层：计算机操作的能力（截图、无障碍树、鼠标键盘、桌面坐标、回收站）
 * 全部活在 Electron 主进程里，pi 是另一个进程。桥把我们的工具暴露成一个
 * 「只有本机、只有带 token 的调用者能用」的极小 HTTP 服务，pi 的扩展再代理过来。
 *
 * 安全约定：
 *   - 只监听 127.0.0.1，端口随机
 *   - 每次启动生成 24 字节随机 token，必须放在 x-nailong-token 头里
 *   - 只认 POST/GET 这几个固定路径，不接受任何文件路径参数以外的写操作
 *   - 审批（/approve）走的是同一套 permissions + 用户确认，不因为换了内核就放水
 */

const http = require('http');
const crypto = require('crypto');

const MAX_BODY = 8 * 1024 * 1024; // 截图 base64 可能比较大

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('请求体过大')); try { req.destroy(); } catch (e) { /* ignore */ } return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, code, obj) {
  const body = JSON.stringify(obj === undefined ? {} : obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

/**
 * @param {object} deps
 * @param {object} deps.host           host（给工具用）
 * @param {object} deps.toolset        createTools() 的结果
 * @param {object} deps.services       业务服务（设置/日程/记忆…）
 * @param {object} deps.log
 * @param {() => object} deps.getPolicy  权限策略
 * @param {(req) => Promise<string>} deps.askUser  弹确认框，返回 exec/skip/auto/deny
 * @param {() => object} deps.getModelConfig 当前 Base URL / Key / 模型
 * @param {() => object} deps.getMeta  { version, locale, name }
 */
function createBridge(deps) {
  const { toolset, services, log } = deps;
  const token = crypto.randomBytes(24).toString('hex');
  const pending = new Set();
  let server = null;
  let port = 0;
  let cancellation = 0;
  let autoTask = false;
  let planApproved = false;
  let usedSteps = 0;
  function limit(message) {
    if (deps.onLimit) deps.onLimit(message);
    return { ok: false, text: message };
  }

  function auth(req) {
    const t = req.headers['x-nailong-token'];
    if (typeof t !== 'string') return false;
    const supplied = Buffer.from(t);
    const expected = Buffer.from(token);
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  }

  function catalog() {
    return toolset.all.filter((t) => t.enabled !== false).map((t) => ({
      name: t.name,
      label: t.name,
      group: t.group,
      level: t.level,
      description: t.description,
      parameters: t.parameters,
      promptSnippet: (String(t.description || '').split('\n')[0] || '').slice(0, 110)
    }));
  }

  async function runTool(name, args) {
    const policyAtStart = deps.getPolicy ? deps.getPolicy() : {};
    // maxSteps = 0（默认）表示不限次数：能干多久干多久，由用户随时点停止；设了正数才拦。
    const cap = Number(policyAtStart.maxSteps) || 0;
    if (cap > 0 && usedSteps >= cap) return limit('已达到任务工具调用上限，请开始新任务');
    usedSteps++;
    const generation = cancellation;
    const spec = toolset.get(name);
    if (!spec) return { ok: false, text: '没有名为 ' + name + ' 的工具' };
    if (spec.enabled === false) return { ok: false, text: '工具 ' + name + ' 已在设置里被禁用' };

    // 权限判定沿用同一份实现，换内核不放水
    const perms = require('../agent/permissions.js');
    const policy = Object.assign({}, deps.getPolicy ? deps.getPolicy() : {});
    if (autoTask && policy.mode !== 'readonly') policy.mode = 'auto';
    if (policy.planMode && !planApproved && spec.level !== 'low') {
      return { ok: false, text: '计划模式：请先调用 propose_plan 并获得用户批准' };
    }
    const verdict = perms.evaluate(spec, args, policy);
    if (verdict.decision === 'deny') return { ok: false, text: '这个操作被拦下了：' + verdict.reason };

    if (verdict.decision === 'ask') {
      const req = {
        kind: 'tool',
        tool: name,
        args: args,
        desc: spec.describe ? spec.describe(args) : name,
        level: spec.level,
        reason: verdict.reason,
        preview: spec.preview ? safe(() => spec.preview(args)) : ''
      };
      const choice = await askUser(req);
      if (!['exec', 'auto'].includes(choice)) return { ok: false, skipped: true, text: '用户拒绝/跳过了这一步。换一种方式，或直接说明你无法完成的原因。' };
      if (choice === 'auto') autoTask = true;
    }

    if (generation !== cancellation) return { ok: false, skipped: true, text: '任务已中止' };
    if (spec.enabled === false) return { ok: false, text: '工具已被禁用' };

    const t0 = Date.now();
    try {
      const out = await spec.run(args, {
        emit: () => {},
        policy,
        ask: async (question) => String(await askUser({ kind: 'question', question: String(question || '') })),
        // 计划审批：返回 approve / reject / edit:<新步骤>
        askPlan: async (plan) => {
          if (typeof deps.askPlan !== 'function') return 'reject';
          return String(await deps.askPlan(plan));
        }
      });
      const r = normalize(out);
      if (generation !== cancellation) return { ok: false, skipped: true, text: '任务已中止' };
      if (name === 'propose_plan') planApproved = r.ok;
      return Object.assign(r, { ms: Date.now() - t0 });
    } catch (e) {
      const msg = String((e && e.message) || e);
      log.warn('[bridge] 工具 ' + name + ' 失败：' + msg);
      return { ok: false, text: '执行失败：' + msg, ms: Date.now() - t0 };
    }
  }

  function normalize(out) {
    if (out === undefined || out === null) return { ok: true, text: '完成', images: [] };
    if (typeof out === 'string') return { ok: true, text: out, images: [] };
    return {
      ok: out.ok !== false,
      text: out.text === undefined ? '完成' : String(out.text),
      images: Array.isArray(out.images) ? out.images : []
    };
  }

  function safe(fn) { try { return fn(); } catch (e) { return ''; } }

  function askUser(req) {
    return new Promise((resolve) => {
      const finish = (v) => {
        if (!pending.has(finish)) return;
        pending.delete(finish);
        clearTimeout(timer);
        resolve(v);
      };
      // 最多等 10 分钟，之后当作用户拒绝（总比一直悬着好）
      const timer = setTimeout(() => finish('deny'), 10 * 60000);
      if (timer.unref) timer.unref();
      pending.add(finish);
      Promise.resolve()
        .then(() => deps.askUser(req))
        .then((v) => finish(v), () => finish('deny'));
    });
  }

  /** 中止任务时把所有挂着的确认请求一起否掉，否则 pi 的 tool call 会一直悬着 */
  function cancelPending() {
    cancellation++;
    autoTask = false;
    planApproved = false;
    Array.from(pending).forEach((finish) => { try { finish('deny'); } catch (e) { /* ignore */ } });
    pending.clear();
  }

  async function handler(req, res) {
    if (!auth(req)) { send(res, 401, { error: 'unauthorized' }); return; }
    const url = (req.url || '').split('?')[0];
    try {
      if (req.method === 'GET' && url === '/health') {
        const meta = deps.getMeta ? deps.getMeta() : {};
        send(res, 200, { ok: true, name: meta.name || '奶蛙助手', version: meta.version || '', tools: toolset.all.length });
        return;
      }
      if (req.method === 'GET' && url === '/catalog') {
        send(res, 200, { tools: catalog() });
        return;
      }
      if (req.method === 'GET' && url === '/config') {
        const m = deps.getModelConfig ? deps.getModelConfig() : {};
        const meta = deps.getMeta ? deps.getMeta() : {};
        // 只把「注册 provider 需要的最小信息」传过去；key 仅走本地回环
        const flags = (deps.getRuntimeFlags ? deps.getRuntimeFlags() : {}) || {};
        send(res, 200, {
          name: meta.name || '奶蛙助手',
          locale: meta.locale || 'zh-CN',
          baseUrl: m.baseUrl || '',
          model: m.model || '',
          apiKey: m.key || '',
          provider: m.provider || 'auto',
          useCustomProvider: m.useCustomProvider !== false,
          maxTokens: m.maxTokens,
          temperature: m.temperature,
          modelCatalog: m.modelCatalog,
          contextWindow: m.contextWindow,
          planMode: !!flags.planMode
        });
        return;
      }
      if (req.method !== 'POST') { send(res, 405, { error: 'method not allowed' }); return; }
      const body = await readBody(req);

      if (url === '/tool') {
        const r = await runTool(String(body.name || ''), body.args || {});
        send(res, 200, r);
        return;
      }
      if (url === '/notify') {
        try { services.notify.show(String(body.title || '奶蛙助手'), String(body.body || '')); } catch (e) { /* ignore */ }
        send(res, 200, { ok: true });
        return;
      }
      if (url === '/log') {
        const lvl = ['debug', 'info', 'warn', 'error'].indexOf(body.level) >= 0 ? body.level : 'info';
        log[lvl]('[pi-ext] ' + String(body.message || '').slice(0, 500));
        send(res, 200, { ok: true });
        return;
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      log.warn('[bridge] ' + url + ' 处理失败：' + ((e && e.message) || e));
      send(res, 400, { error: String((e && e.message) || e) });
    }
  }

  function start() {
    return new Promise((resolve, reject) => {
      server = http.createServer((req, res) => { handler(req, res); });
      server.requestTimeout = 0;
      server.headersTimeout = 60000;
      server.keepAliveTimeout = 65000;
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        log.info('[bridge] 本地工具桥已就绪：http://127.0.0.1:' + port);
        resolve({ url: 'http://127.0.0.1:' + port, token: token, port: port });
      });
    });
  }

  function stop() {
    cancelPending();
    if (server) { try { server.close(); } catch (e) { /* ignore */ } server = null; }
  }

  return {
    start, stop, cancelPending, runTool, catalog,
    resetTask(automatic) { cancelPending(); autoTask = !!automatic; usedSteps = 0; },
    get url() { return 'http://127.0.0.1:' + port; },
    get token() { return token; },
    get port() { return port; },
    get isRunning() { return !!server; }
  };
}

module.exports = { createBridge };
