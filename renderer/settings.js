'use strict';
/* 设置窗：模型 / 权限 / 外观 / 提醒专注 / 数据记忆 / 关于 */

const $ = (id) => document.getElementById(id);
const api = window.widget;

let SET = null;
let FOCUS_CFG = null;
let MODEL_CATALOG = [];
let MODEL_BASE = '';
let modelConfigRevision = 0;

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast show';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = 'toast'; }, 2200);
}

function sw(id, on, onChange) {
  const el = $(id);
  el.className = 'track' + (on ? ' on' : '');
  el.onclick = async () => {
    const now = el.className.indexOf('on') < 0;
    el.className = 'track' + (now ? ' on' : '');
    try { await onChange(now); } catch (e) { el.className = 'track' + (on ? ' on' : ''); toast('未保存：' + (e.message || e)); }
    on = el.className.indexOf('on') >= 0;
  };
}

function num(id, v) { $(id).value = v === undefined || v === null ? '' : v; }
function intOf(id, dflt) { const n = parseInt($(id).value, 10); return isNaN(n) ? dflt : n; }

function applyTheme(t) { document.body.className = 't' + (Number(t) || 0); }
api.onThemeChanged(applyTheme);

async function saveSettings(patch, quiet) {
  SET = await api.settingsSave(patch);
  if (!quiet) toast('已保存');
  applyTheme(SET.theme);
  if (window.WidgetAudio) window.WidgetAudio.setEnabled(SET.sound !== false);
  return SET;
}

// ---------------------------------------------------------------- 页面切换
Array.prototype.forEach.call(document.querySelectorAll('.navitem'), (el) => {
  el.onclick = () => {
    Array.prototype.forEach.call(document.querySelectorAll('.navitem'), (x) => { x.className = 'navitem'; });
    el.className = 'navitem on';
    const page = el.getAttribute('data-page');
    Array.prototype.forEach.call(document.querySelectorAll('.page'), (p) => { p.className = 'page' + (p.id === 'p-' + page ? ' on' : ''); });
    if (page === 'about') loadLogs();
    if (page === 'data') loadMemory();
  };
});

document.querySelectorAll('[data-config]').forEach(button => {
  button.onclick = async () => {
    document.querySelectorAll('[data-config]').forEach(tab => { const active = tab === button; tab.classList.toggle('on', active); tab.setAttribute('aria-selected', String(active)); });
    document.querySelectorAll('.config-panel').forEach(panel => { panel.hidden = panel.id !== 'config-' + button.dataset.config; });
    $('main').scrollTop = 0;
    if (button.dataset.config === 'runtime') await refreshThinkingControl();
  };
});

api.onSettingsView(request => {
  if (!request || !['connection', 'models', 'runtime', 'resources'].includes(request.tab)) return;
  document.querySelector('[data-page=model]').click();
  document.querySelector('[data-config=' + request.tab + ']').click();
});

async function refreshThinkingControl() {
  const select = $('thinkingDefault');
  let info = await api.agentEngine();
  if (info && info.active === 'pi' && !info.pi.model) {
    const started = await api.agentModels();
    if (started && started.ok) info = await api.agentEngine();
  }
  if (!info || info.active !== 'pi' || !info.pi.model) {
    select.innerHTML = '<option value="off">先配置模型并启动 pi 内核</option>'; select.disabled = true; return;
  }
  const r = await api.agentThinkingLevels();
  if (!r || !r.ok) { select.innerHTML = '<option value="off">读取能力失败，请重试</option>'; select.disabled = true; return; }
  const labels = { off: '关闭 · 最快', minimal: '极简', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高' };
  select.innerHTML = r.levels.map(level => '<option value="' + esc(level) + '">' + esc(labels[level] || level) + '</option>').join('');
  select.value = info.pi.thinking || 'off'; select.disabled = false;
}

function renderModelCatalog() {
  const query = $('modelSearch').value.trim().toLowerCase();
  const models = MODEL_CATALOG.filter(m => (m.id + ' ' + (m.name || '')).toLowerCase().includes(query));
  $('modelCatalogList').innerHTML = models.map(m => '<button class="model-item' + (m.id === $('model').value.trim() ? ' active' : '') + '" data-model="' + esc(m.id) + '"><span class="name">' + esc(m.id) + '</span><small>' + (m.reasoning ? '思考' : '基础') + ' · ' + (m.vision === false ? '文字' : '图片') + '</small></button>').join('') || '<div class="lead">' + (MODEL_CATALOG.length ? '没有匹配的模型' : '填写模型名并保存，或检测服务商模型列表。') + '</div>';
  $('modelCatalogList').querySelectorAll('[data-model]').forEach(button => {
    button.onclick = () => {
      const m = MODEL_CATALOG.find(x => x.id === button.dataset.model);
      $('model').value = m.id; $('catalogModel').value = m.id; $('modelReasoning').value = String(!!m.reasoning); $('modelVision').value = String(m.vision !== false); $('modelEffort').value = m.thinkingLevels ? 'discovered' : m.thinkingFormat || 'standard';
      num('maxTokens', m.maxTokens || 4096); num('contextWindow', m.contextWindow || 128000);
      $('modelStatus').textContent = '正在编辑 ' + m.id + '；保存后生效。'; $('profileStatus').textContent = $('modelStatus').textContent; renderModelCatalog();
    };
  });
}

// ---------------------------------------------------------------- 内核
function engineLabel(name) {
  return name === 'pi' ? 'pi 内核' : '内置引擎';
}

async function renderEngine() {
  const info = await api.agentEngine();
  if (!info) return;
  $('engine').value = info.setting || 'auto';
  if ($('piConfig') && info.configMode) $('piConfig').value = info.configMode;
  if ($('agentDirPath')) $('agentDirPath').textContent = info.agentDir || '';
  const bits = [];
  bits.push('当前生效：<b>' + engineLabel(info.active) + '</b>');
  if (info.setting === 'auto') bits.push('（自动模式）');
  bits.push(info.configMode === 'bundled' ? '配置：应用自带' : '配置：机器上的 pi');
  if (info.active === 'pi' && info.pi.ready) {
    bits.push('模型 ' + esc(info.pi.model || '未指定'));
    bits.push('思考 ' + (info.pi.thinking || 'off'));
    if (info.pi.sessionId) bits.push('会话 ' + String(info.pi.sessionId).slice(0, 8));
    if (info.pi.loadUserExtensions) bits.push('已开用户扩展');
  } else if (info.pi.starting) {
    bits.push('pi 正在启动…');
  } else if (info.pi.error) {
    bits.push('<span style="color:#ffb3a0">pi 未启动：' + esc(String(info.pi.error).slice(0, 160)) + '</span>');
  } else {
    bits.push('pi 还没启动（发第一条消息时自动拉起）');
  }
  if (info.bridge.running) bits.push('工具桥端口 ' + info.bridge.port);
  $('engineInfo').innerHTML = bits.filter(Boolean).join(' · ');

  // pi 侧环境自检：接口没配、代理挂了这类问题必须说人话，不能只丢一句 Connection error
  const pf = info.pi.preflight;
  const warn = $('piWarn');
  if (pf && pf.warnings && pf.warnings.length) {
    warn.style.display = '';
    warn.style.background = '';
    warn.style.boxShadow = '';
    warn.innerHTML = pf.warnings.map((w) => '⚠ ' + String(w).replace(/</g, '&lt;')).join('<br><br>')
      + '<br><br><span class="muted">检查对象：' + String(pf.settingsFile || pf.agentDir || '').replace(/</g, '&lt;') + '</span>';
    if (pf.mode === 'system') {
      warn.innerHTML += '<br><br><span class="pill" id="switchToBundled" style="cursor:pointer">改用应用自带的配置</span>';
      const btn = $('switchToBundled');
      if (btn) btn.onclick = () => { $('piConfig').value = 'bundled'; $('piConfig').onchange(); };
    }
  } else if (pf) {
    warn.style.display = '';
    warn.style.background = 'color-mix(in srgb, var(--ok) 14%, transparent)';
    warn.style.boxShadow = 'inset 0 0 0 1px var(--ok)';
    warn.textContent = '环境自检通过：' + (pf.credentials && pf.credentials.ok ? '接口已配好' : '还没有接口配置')
      + (pf.proxy && pf.proxy.configured ? '，代理 ' + pf.proxy.url + ' 可达' : '，没有代理干扰')
      + '（' + String(pf.settingsFile || '') + '）';
  } else {
    warn.style.display = 'none';
  }
}

async function initEngine() {
  const a = (SET && SET.agent) || {};
  $('piConfig').value = a.piConfig || 'bundled';
  $('thinkingDefault').value = a.thinking || 'off';
  $('workspace').value = a.workspace || '';
  $('workspaceChoose').onclick = async () => {
    try { const result = await api.chooseWorkspace(); if (result && result.path) { $('workspace').value = result.path; await saveSettings({ agent: Object.assign({}, SET.agent, { workspace: result.path }) }); } } catch (e) { toast('未保存：' + (e.message || e)); }
  };
  $('workspace').onchange = async () => { try { await saveSettings({ agent: Object.assign({}, SET.agent, { workspace: $('workspace').value.trim() }) }); } catch (e) { toast('未保存：' + (e.message || e)); } };
  sw('sw-customprovider', a.useCustomProvider !== false, async (v) => {
    SET = await api.settingsSave({ agent: Object.assign({}, SET.agent, { useCustomProvider: v }) });
    toast(v ? '已开启：奶蛙填的接口会注册给 pi' : '已关闭：pi 只能用它自己认识的 provider');
    setTimeout(renderEngine, 1200);
  });
  $('piConfig').onchange = async () => {
    SET = await api.settingsSave({ agent: Object.assign({}, SET.agent, { piConfig: $('piConfig').value }) });
    toast($('piConfig').value === 'bundled' ? '已切到应用自带的 pi 配置（不碰 ~/.pi）' : '已切到沿用系统 pi 的配置');
    await api.agentPreflight({ force: true });
    setTimeout(renderEngine, 2000);
  };
  sw('sw-plan', !!a.planMode, async (v) => {
    SET = await api.settingsSave({ agent: Object.assign({}, SET.agent, { planMode: v }) });
    toast(v ? '计划模式已开：下一次对话会先给你看计划' : '计划模式已关');
  });
  sw('sw-ext', !!a.loadUserExtensions, async (v) => {
    const r = await api.settingsSave({ agent: Object.assign({}, SET.agent, { loadUserExtensions: v }) });
    SET = r;
    toast(v ? '已开启：下次启动 pi 会加载你的扩展、MCP、子代理' : '已关闭：只加载奶蛙自己的工具');
    setTimeout(renderEngine, 2500);
  });
  sw('sw-compact', a.autoCompaction !== false, async (v) => {
    SET = await api.settingsSave({ agent: Object.assign({}, SET.agent, { autoCompaction: v }) });
    toast(v ? '已开启自动压缩' : '已关闭自动压缩');
  });
  sw('sw-retry', a.autoRetry !== false, async (v) => {
    SET = await api.settingsSave({ agent: Object.assign({}, SET.agent, { autoRetry: v }) });
    toast(v ? '已开启自动重试' : '已关闭自动重试');
  });
  $('thinkingDefault').onchange = async () => {
    try {
      const r = await api.agentSetThinking({ level: $('thinkingDefault').value });
      if (!r || !r.ok) throw new Error(r && r.error || '设置失败');
      SET = await api.settingsGet();
      toast('已生效并保存：' + r.level);
    } catch (e) { toast('未应用：' + (e.message || e)); }
    await refreshThinkingControl();
  };
  $('contextWindow').onchange = () => { $('modelStatus').textContent = '上下文窗口已编辑，点击保存后生效。'; };

  // ---- pi 资源开关（都要重启 pi 才生效）----
  const flagSwitch = (id, key, label) => sw(id, !!a[key], async (v) => {
    SET = await api.settingsSave({ agent: Object.assign({}, SET.agent, { [key]: v }) }, true);
    toast(label + (v ? '已关闭' : '已开启') + '（重启 pi 后生效）');
    setTimeout(renderEngine, 2500);
  });
  flagSwitch('sw-nomcp', 'noMcp', 'MCP 支持');
  flagSwitch('sw-noskills', 'noSkills', 'skills 发现');
  flagSwitch('sw-nocontext', 'noContextFiles', '上下文文件');
  $('skillPaths').value = (a.skillPaths || []).join('\n');
  $('skillPaths').onchange = async () => {
    const paths = $('skillPaths').value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    SET = await api.settingsSave({ agent: Object.assign({}, SET.agent, { skillPaths: paths }) }, true);
    toast('已保存 ' + paths.length + ' 个 skill 路径（重启 pi 后生效）');
  };

  await initMcp();

  await renderEngine();
  $('engine').onchange = async () => {
    await api.agentEngineSet({ engine: $('engine').value });
    toast('已切换内核');
    setTimeout(renderEngine, 600);
  };
  $('engineRestart').onclick = async () => {
    $('engineInfo').textContent = '正在重启 pi 内核…';
    await api.agentEngineSet({ engine: $('engine').value });
    const r = await api.agentTest();
    $('engineInfo').textContent = r && r.ok ? ('✓ ' + (r.reply || '已就绪')) : ('✗ ' + ((r && r.error) || '启动失败'));
    await api.agentPreflight({ force: true });
    setTimeout(renderEngine, 1200);
  };
  $('piModels').onclick = async () => {
    $('piModelList').textContent = '正在问 pi…';
    const r = await api.agentModels();
    if (r && r.ok) {
      $('piModelList').innerHTML = r.models.map(m => '<button class="model-item" data-provider="' + esc(m.provider) + '" data-id="' + esc(m.id) + '"><span class="name">' + esc(m.provider + ' / ' + m.id) + '</span><small>' + (m.reasoning ? '可思考' : '基础') + '</small></button>').join('') || '尚无可用模型';
      $('piModelList').querySelectorAll('button').forEach(button => { button.onclick = async () => {
        try { const result = await api.agentSetModel({ provider: button.dataset.provider, modelId: button.dataset.id }); if (!result || !result.ok) throw new Error(result && result.error || '切换失败'); SET = await api.settingsGet(); toast('模型已切换并保存'); await renderEngine(); await refreshThinkingControl(); }
        catch (e) { toast('未切换：' + (e.message || e)); }
      }; });
    } else $('piModelList').textContent = '读取失败：' + (r && r.error || '无法获取模型');
  };
  await refreshThinkingControl();
  setInterval(renderEngine, 15000);
}
// ---------------------------------------------------------------- 模型
function applyModelConfig(c) {
  if (!c) return;
  modelConfigRevision++;
  $('base').value = c.baseUrl || '';
  $('model').value = c.model || '';
  $('key').value = c.hasKey ? '••••••••••••' : '';
  $('provider').value = c.provider || 'auto';
  MODEL_CATALOG = (c.modelCatalog || []).slice(); MODEL_BASE = c.baseUrl || '';
  const selected = MODEL_CATALOG.find(m => m.id === c.model) || {};
  $('modelReasoning').value = String(!!selected.reasoning); $('modelVision').value = String(selected.vision !== false); $('modelEffort').value = selected.thinkingLevels ? 'discovered' : selected.thinkingFormat || 'standard';
  $('catalogModel').value = c.model || '';
  num('maxTokens', c.maxTokens || 4096);
  num('temperature', c.temperature === undefined ? 0.2 : c.temperature);
  num('contextWindow', selected.contextWindow || 128000);
  $('modelStatus').textContent = c.keyPersistence === 'unavailable' ? '原密钥无法解密，密文已保留，请重新填写密钥。' : c.hasKey ? '已加密保存，助手会自动使用此配置。' : '尚未填写 API 密钥。';
  renderModelCatalog();
}
api.onAgentConfigChanged(applyModelConfig);
async function initModel() {
  const revision = modelConfigRevision;
  const c = await api.agentCfgGet();
  if (revision === modelConfigRevision) applyModelConfig(c);
  $('modelSearch').oninput = renderModelCatalog;
  $('catalogModel').oninput = () => { $('model').value = $('catalogModel').value; };
  $('model').oninput = () => { $('catalogModel').value = $('model').value; };
  $('saveModelProfile').onclick = async () => { await $('save').onclick(); $('profileStatus').textContent = $('modelStatus').textContent; };

  let changing = false;
  const guarded = fn => async () => {
    if (changing) return; changing = true;
    ['save', 'detect', 'test', 'saveModelProfile'].forEach(id => { $(id).disabled = true; });
    try { await fn(); } catch (e) { $('modelStatus').textContent = '✗ ' + (e.message || e); }
    finally { changing = false; ['save', 'detect', 'test', 'saveModelProfile'].forEach(id => { $(id).disabled = false; }); }
  };
  $('save').onclick = guarded(async () => {
    const id = $('model').value.trim();
    if (!id) throw new Error('请填写模型名称');
    const mode = $('modelEffort').value;
    const prior = MODEL_CATALOG.find(m => m.id === id) || {};
    const thinkingLevels = mode === 'deepseek' ? ['off', 'low', 'high', 'max'] : mode === 'extended' ? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] : mode === 'discovered' ? prior.thinkingLevels : undefined;
    const profile = { thinkingLevels, thinkingFormat: mode === 'deepseek' ? 'deepseek' : mode === 'discovered' ? prior.thinkingFormat : 'standard', id, reasoning: $('modelReasoning').value === 'true', vision: $('modelVision').value !== 'false', maxTokens: intOf('maxTokens', 4096), contextWindow: intOf('contextWindow', 128000) };
    const list = (MODEL_BASE === $('base').value.trim() ? MODEL_CATALOG : []).filter(m => m.id !== id).concat([profile]);
    const saved = await api.agentCfgSave({
      modelCatalog: list,
      baseUrl: $('base').value.trim(),
      key: $('key').value.trim(),
      model: $('model').value.trim(),
      provider: $('provider').value,
      maxTokens: intOf('maxTokens', 4096),
      temperature: parseFloat($('temperature').value) || 0
    });
    MODEL_CATALOG = saved.modelCatalog || list; MODEL_BASE = saved.baseUrl || $('base').value.trim(); renderModelCatalog();
    $('key').value = saved.hasKey ? '••••••••••••' : '';
    $('modelStatus').textContent = saved.keyPersistence === 'unavailable' ? '原密钥无法解密，密文已保留，请重新填写密钥。' : saved.hasKey ? '已加密保存，重启后会自动读取。' : '配置已保存，尚未填写 API 密钥。';
    await refreshThinkingControl();
  });
  $('detect').onclick = guarded(async () => {
    $('modelStatus').textContent = '正在获取模型列表…';
    await api.agentCfgSave({ baseUrl: $('base').value.trim(), key: $('key').value.trim(), provider: $('provider').value });
    const d = await api.agentDetectModel();
    if (d && d.ok) {
      const old = MODEL_BASE === $('base').value.trim() ? MODEL_CATALOG : [];
      MODEL_CATALOG = (d.catalog || (d.models || []).map(id => ({ id, reasoning: false, vision: false }))).map(m => old.find(x => x.id === m.id) || m);
      const saved = await api.agentCfgSave({ modelCatalog: MODEL_CATALOG });
      MODEL_CATALOG = saved.modelCatalog || MODEL_CATALOG; MODEL_BASE = $('base').value.trim();
      renderModelCatalog();
      $('modelStatus').textContent = '已获取 ' + MODEL_CATALOG.length + ' 个模型，请在目录中选择并确认能力。';
    } else {
      $('modelStatus').textContent = '✗ ' + ((d && d.error) || '失败');
    }
  });
  $('test').onclick = guarded(async () => {
    $('modelStatus').textContent = '测试中…';
    await api.agentCfgSave({ baseUrl: $('base').value.trim(), key: $('key').value.trim(), model: $('model').value.trim(), provider: $('provider').value });
    $('key').value = $('key').value ? '••••••••••••' : '';
    const r = await api.agentTest();
    $('modelStatus').textContent = r && r.ok ? (r.connectionVerified === false ? '内核启动通过；模型接口尚未验证，请发送实际对话。' : '接口检查通过：' + (r.reply || '')) : ('✗ ' + ((r && r.error) || '失败'));
  });
}

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

function mcpStateBadge(s) {
  const st = String(s.state || '');
  if (!st) return '';
  const label = {
    connected: '已连接',
    failed: '连不上',
    needs_auth: '需授权',
    disabled: '已禁用',
    connecting: '连接中'
  }[st] || st;
  const cls = st === 'connected' ? ' ok' : (st === 'failed' ? ' high' : ' warn');
  const n = (s.liveTools || []).length;
  return '<span class="badge' + cls + '" title="' + esc(s.liveError || '') + '">' + esc(label) + (st === 'connected' ? ' · ' + n + ' 个工具' : '') + '</span>';
}

async function initMcp() {
  async function render(force) {
    const r = await api.mcpList({ force: !!force });
    if (!r || r.ok === false) { $('mcpList').innerHTML = '<div class="small muted">读不到 mcp.json：' + esc((r && r.error) || '') + '</div>'; return r; }
    $('mcpList').innerHTML = r.servers.length
      ? r.servers.map((s) => '<div class="toolrow">'
        + '<span class="nm">' + esc(s.name) + '</span>'
        + '<span class="badge">' + esc(s.type) + '</span>'
        + mcpStateBadge(s)
        + '<span class="ds" title="' + esc(s.target) + '">' + esc(s.target || s.description || '') + '</span>'
        + (s.exposureNeedsExtension ? '<span class="badge warn" title="codemode/deferred 暴露方式需要对应扩展；奶蛙默认不加载扩展，建议改成 direct">' + esc(s.exposure) + '</span>' : '')
        + (s.needsOAuth ? '<span class="badge warn">需登录</span>' : '')
        + '<span class="badge' + (s.enabled ? ' ok' : '') + '" data-tg="' + esc(s.name) + '" data-on="' + (s.enabled ? '1' : '0') + '" style="cursor:pointer">' + (s.enabled ? '启用' : '已禁用') + '</span>'
        + (s.needsOAuth ? '<span class="badge" data-login="' + esc(s.name) + '" style="cursor:pointer">登录</span>' : '')
        + (s.liveError || s.state === 'connected' ? '<span class="badge" data-out="' + esc(s.name) + '" style="cursor:pointer">登出</span>' : '')
        + '<span class="badge" data-rm="' + esc(s.name) + '" style="cursor:pointer">删除</span>'
        + '</div>'
        + (s.liveError ? '<div class="small muted" style="padding:0 8px 6px;white-space:pre-wrap">' + esc(String(s.liveError).slice(0, 200)) + '</div>' : ''))
        .join('')
      : '<div class="small muted">还没有 MCP 服务器</div>';
    Array.prototype.forEach.call($('mcpList').querySelectorAll('[data-rm]'), (el) => {
      el.onclick = async () => {
        const r2 = await api.mcpRemove({ name: el.getAttribute('data-rm') });
        $('mcpStatus').textContent = r2 && r2.ok ? ('已删除 ' + el.getAttribute('data-rm') + '，重启 pi 后生效') : ('删除失败：' + ((r2 && r2.error) || ''));
        render();
      };
    });
    Array.prototype.forEach.call($('mcpList').querySelectorAll('[data-login]'), (el) => {
      el.onclick = async () => {
        const name = el.getAttribute('data-login');
        const r2 = await api.mcpLogin({ name: name });
        if (!r2 || !r2.ok) { $('mcpStatus').textContent = 'x ' + ((r2 && r2.error) || ''); return; }
        $('mcpStatus').textContent = (r2.hint || '') + ' 正在等它完成…';
        // 浏览器授权可能要几十秒，轮询到连上为止（最多 3 分钟）
        let tries = 0;
        const timer = setInterval(async () => {
          tries++;
          const c = await api.mcpCheckLoggedIn({ name: name });
          if (c && c.ok && c.state === 'connected') {
            clearInterval(timer);
            $('mcpStatus').textContent = '✓ ' + name + ' 已连接，暴露 ' + (c.tools || []).length + ' 个工具';
            render(true);
            toast('MCP 服务器 ' + name + ' 登录成功');
          } else if (tries > 36) {
            clearInterval(timer);
            $('mcpStatus').textContent = '还没连上（' + ((c && c.state) || '未知') + '）。完成浏览器授权后点「刷新」。'
              + (c && c.error ? ' 最近错误：' + String(c.error).slice(0, 160) : '');
            render(true);
          }
        }, 5000);
      };
    });
    Array.prototype.forEach.call($('mcpList').querySelectorAll('[data-out]'), (el) => {
      el.onclick = async () => {
        const r2 = await api.mcpLogout({ name: el.getAttribute('data-out') });
        $('mcpStatus').textContent = r2 && r2.ok ? ('已登出 ' + el.getAttribute('data-out')) : ('x ' + ((r2 && r2.error) || ''));
        render(true);
      };
    });
    Array.prototype.forEach.call($('mcpList').querySelectorAll('[data-tg]'), (el) => {
      el.onclick = async () => {
        const on = el.getAttribute('data-on') === '1';
        await api.mcpToggle({ name: el.getAttribute('data-tg'), enabled: !on });
        render();
      };
    });
    const warn = [];
    if (!r.writable) warn.push('当前用的是机器上 pi 的配置，奶蛙不替你改那份 mcp.json。');
    if (!r.extensionsEnabled) warn.push('「同时加载你自己的 pi 扩展」现在是关的，MCP 不会生效。');
    if (r.disabledByFlag) warn.push('「禁用 MCP 支持」是开着的。');
    if (r.statusError) warn.push('拿不到服务器状态：' + r.statusError);
    if (r.servers.some((s) => s.exposureNeedsExtension)) warn.push('有服务器的暴露方式是 codemode/deferred，那需要对应扩展；建议删掉重加（奶蛙默认给 direct）。');
    $('mcpStatus').innerHTML = warn.length
      ? warn.map((w) => '⚠ ' + esc(w)).join('<br>')
      : ('配置文件：' + esc(r.path) + '（改完会自动重启 pi）');
    return r;
  }

  $('mcpReload').onclick = () => { render(true); toast('已刷新（含连接状态）'); };
  $('mcpOpen').onclick = () => api.mcpOpen();
  $('mcpAdd').onclick = async () => {
    const json = $('mcpJson').value.trim();
    if (!json) { $('mcpStatus').textContent = '请先粘贴一个服务器配置'; return; }
    const r = await api.mcpAdd({ name: $('mcpName').value.trim(), json: json });
    if (r && r.ok) {
      $('mcpName').value = '';
      $('mcpJson').value = '';
      $('mcpStatus').textContent = '已添加，重启 pi 后生效';
      render();
    } else {
      $('mcpStatus').textContent = '✗ ' + ((r && r.error) || '添加失败');
    }
  };
  await render(true);
}

// ---------------------------------------------------------------- 权限
async function initPerm(isFirst) {
  const s = SET || await api.settingsGet();
  SET = s;
  $('policyMode').value = (s.agent && s.agent.policy && s.agent.policy.mode) || 'confirm';
  num('maxSteps', (s.agent && s.agent.policy && s.agent.policy.maxSteps) || 0);
  // 这个开关以前是假的（写死 true 且点不动），于是「自动执行」永远被高危确认拦住
  sw('sw-high', (s.agent && s.agent.policy && s.agent.policy.confirmHighRisk) === true, async (v) => {
    const pol = Object.assign({}, SET.agent.policy, { confirmHighRisk: v });
    await saveSettings({ agent: Object.assign({}, SET.agent, { policy: pol }) });
    toast(v ? '高危操作（跑命令/删文件/锁屏）会先问你' : '高危操作也会直接做；危险命令与受保护路径仍然会被拒绝');
  });
  $('policyMode').onchange = async () => {
    const pol = Object.assign({}, SET.agent.policy, { mode: $('policyMode').value });
    await saveSettings({ agent: Object.assign({}, SET.agent, { policy: pol }) });
  };
  $('maxSteps').onchange = async () => {
    const pol = Object.assign({}, SET.agent.policy, { maxSteps: intOf('maxSteps', 0) });
    await saveSettings({ agent: Object.assign({}, SET.agent, { policy: pol }) });
  };

  const tools = await api.toolsList();
  const disabled = (s.agent && s.agent.disabledTools) || {};
  const groups = {};
  tools.forEach((t) => { (groups[t.group] = groups[t.group] || []).push(t); });
  let html = '';
  Object.keys(groups).forEach((g) => {
    html += '<div class="sect-title">' + g + '（' + groups[g].length + '）</div>';
    groups[g].forEach((t) => {
      const off = !!disabled[t.name];
      html += '<div class="toolrow"><span class="nm">' + t.name + (t.level === 'high' ? ' ⚠' : '') + '</span>'
        + '<span class="ds">' + (t.description || '').split('\n')[0].replace(/</g, '&lt;') + '</span>'
        + '<span class="badge' + (off ? '' : ' ok') + '" data-tool="' + t.name + '" style="cursor:pointer">' + (off ? '已禁用' : '启用') + '</span></div>';
    });
  });
  $('toolList').innerHTML = html;
  Array.prototype.forEach.call($('toolList').querySelectorAll('[data-tool]'), (el) => {
    el.onclick = async () => {
      const name = el.getAttribute('data-tool');
      const d2 = Object.assign({}, disabled);
      if (d2[name]) delete d2[name]; else d2[name] = true;
      await saveSettings({ agent: Object.assign({}, SET.agent, { disabledTools: d2 }) }, true);
      await initPerm();
    };
  });
  if (isFirst) return;
}

// ---------------------------------------------------------------- 外观
function syncPetScale() {
  const el = $('petScale');
  if (!el || !SET) return;
  const pct = Math.round((Number((SET.pet || {}).scale) || 1) * 100);
  el.value = String(Math.max(50, Math.min(999, pct)));
  $('petScaleVal').textContent = pct + '%';
}

async function initLook() {
  const s = SET;
  $('theme').value = String(s.theme || 0);
  $('theme').onchange = async () => {
    await saveSettings({ theme: parseInt($('theme').value, 10) });
    api.saveTheme(parseInt($('theme').value, 10));
  };
  $('locale').value = s.locale || 'zh-CN';
  $('locale').onchange = async () => {
    const loc = $('locale').value;
    await saveSettings({ locale: loc, agent: Object.assign({}, SET.agent, { locale: loc }) });
  };
  sw('sw-sound', s.sound !== false, async (v) => {
    await saveSettings({ sound: v });
    if (window.WidgetAudio) {
      window.WidgetAudio.setEnabled(v);
      if (v) window.WidgetAudio.unlock();
    }
  });
  sw('sw-autostart', !!s.autoStart, async (v) => { await saveSettings({ autoStart: v }, true); toast(v ? '开机自启已开启' : '开机自启已关闭'); });

  syncPetScale();
  let petTimer = null;
  $('petScale').oninput = () => {
    const pct = parseInt($('petScale').value, 10) || 100;
    $('petScaleVal').textContent = pct + '%';
    clearTimeout(petTimer);
    // 拖的时候别每像素都写盘；停手 250ms 再存，但界面上的百分比是即时的
    petTimer = setTimeout(() => { saveSettings({ pet: Object.assign({}, SET.pet, { scale: pct / 100 }) }, true).then(syncPetScale); }, 250);
  };
  $('petScaleReset').onclick = async () => {
    await saveSettings({ pet: Object.assign({}, SET.pet, { scale: 1 }) }, true);
    syncPetScale();
    toast('体型已回到 100%');
  };

  const hk = s.hotkeys || {};
  $('hk-assistant').value = hk.assistant || '';
  $('hk-panel').value = hk.panel || '';
  $('hk-focus').value = hk.focus || '';
  ['hk-assistant', 'hk-panel', 'hk-focus'].forEach((id) => {
    $(id).onchange = async () => {
      await saveSettings({
        hotkeys: {
          assistant: $('hk-assistant').value.trim(),
          panel: $('hk-panel').value.trim(),
          focus: $('hk-focus').value.trim()
        }
      }, true);
      toast('快捷键已更新');
    };
  });
}

// ---------------------------------------------------------------- 提醒 / 专注
function computeAudio() {
  const A = window.WidgetAudio;
  const box = $('audioProbe');
  if (!box) return;
  if (!A) { box.textContent = '声音模块未加载（renderer/audio.js 缺失）'; return; }
  const p = A.probe();
  box.textContent = [
    '唯一音效：原版大笑',
    p.htmlAudio ? '音频播放器可用' : '音频播放器不可用',
    '声音：' + (p.enabled ? '开启' : '关闭')
  ].join(' · ') + (p.errors.length ? ('\n最近报错：' + p.errors.slice(-2).join(' / ')) : '');
  box.style.whiteSpace = 'pre-wrap';
}

async function initRemind() {
  const s = SET;
  const r = s.reminder || {};
  num('preMinutes', r.preMinutes === undefined ? 5 : r.preMinutes);
  num('catchUp', r.catchUpMinutes === undefined ? 30 : r.catchUpMinutes);
  $('summaryAt').value = r.dailySummaryAt || '';
  sw('sw-toast', r.toast !== false, async (v) => {
    await saveSettings({ reminder: Object.assign({}, s.reminder, { toast: v }) }, true);
  });
  const saveR = async () => {
    await saveSettings({
      reminder: Object.assign({}, s.reminder, {
        preMinutes: intOf('preMinutes', 5),
        catchUpMinutes: intOf('catchUp', 30),
        dailySummaryAt: $('summaryAt').value || ''
      })
    }, true);
  };
  ['preMinutes', 'catchUp', 'summaryAt'].forEach((id) => { $(id).onchange = saveR; });

  computeAudio();
  // 唯一音效的试听，不越过用户的静音设置。
  Array.prototype.forEach.call(document.querySelectorAll('[data-sound]'), (el) => {
    el.onclick = () => {
      const name = el.getAttribute('data-sound');
      const A = window.WidgetAudio;
      if (!A) { toast('这个窗口拿不到声音模块'); return; }
      if (!A.isEnabled()) { toast('声音已关闭，请先打开音效开关'); return; }
      A.unlock();
      const ok = A.play(name);
      toast(ok ? '已请求播放原版大笑' : '大笑播放失败，请检查输出设备');
      setTimeout(computeAudio, 700);
    };
  });

  FOCUS_CFG = await api.focusConfig({});
  num('focusMin', FOCUS_CFG.focusMin);
  num('shortMin', FOCUS_CFG.shortMin);
  num('longMin', FOCUS_CFG.longMin);
  num('cycles', FOCUS_CFG.cyclesBeforeLong);
  num('goalPerDay', FOCUS_CFG.goalPerDay);
  sw('sw-autobreak', FOCUS_CFG.autoStartBreak, async (v) => { FOCUS_CFG = await api.focusConfig({ autoStartBreak: v }); toast('已保存'); });
  sw('sw-autofocus', FOCUS_CFG.autoStartFocus, async (v) => { FOCUS_CFG = await api.focusConfig({ autoStartFocus: v }); toast('已保存'); });
  ['focusMin', 'shortMin', 'longMin', 'cycles', 'goalPerDay'].forEach((id) => {
    $(id).onchange = async () => {
      FOCUS_CFG = await api.focusConfig({
        focusMin: intOf('focusMin', 25),
        shortMin: intOf('shortMin', 5),
        longMin: intOf('longMin', 15),
        cyclesBeforeLong: intOf('cycles', 4),
        goalPerDay: intOf('goalPerDay', 8)
      });
      toast('番茄钟设置已保存');
    };
  });
}

// ---------------------------------------------------------------- 数据
async function loadMemory() {
  const list = await api.memoryList();
  $('memList').innerHTML = list.length
    ? list.slice().reverse().map((m) => '<div class="memrow"><span class="tx">' + (m.tag ? '<span class="badge">' + m.tag + '</span> ' : '') + String(m.text).replace(/</g, '&lt;') + '</span>'
      + '<span class="x" data-id="' + m.id + '">✕</span></div>').join('')
    : '<div class="small muted">还没有记住任何东西</div>';
  Array.prototype.forEach.call($('memList').querySelectorAll('.x'), (el) => {
    el.onclick = async () => { await api.memoryRemove({ id: el.getAttribute('data-id') }); loadMemory(); };
  });
  const u = await api.agentUsage();
  const byDay = (u && u.byDay) || [];
  const calls = byDay.reduce((a, x) => a + x.calls, 0);
  const usd = byDay.reduce((a, x) => a + x.usd, 0);
  $('usageBox').innerHTML = calls
    ? '本会话共 ' + calls + ' 次调用 · 约 $' + usd.toFixed(4) + '<br>' + byDay.slice(-10).map((x) => x.day + '：' + x.calls + ' 次 / ' + ((x.input + x.output) / 1000).toFixed(1) + 'k tok / $' + x.usd.toFixed(4)).join('<br>')
    : '还没有调用过模型';
}

async function initData() {
  const s = SET;
  sw('sw-clip', (s.privacy || {}).clipboardHistory !== false, async (v) => {
    await saveSettings({ privacy: Object.assign({}, s.privacy, { clipboardHistory: v }) }, true);
    toast(v ? '已开启剪贴板历史' : '已关闭剪贴板历史');
  });
  num('clipLimit', (s.privacy || {}).clipboardLimit || 200);
  $('clipLimit').onchange = async () => {
    await saveSettings({ privacy: Object.assign({}, s.privacy, { clipboardLimit: intOf('clipLimit', 200) }) }, true);
  };
  $('export').onclick = async () => {
    const r = await api.dataExport();
    toast(r && r.ok ? '已导出到 ' + r.path : '已取消');
  };
  $('import').onclick = async () => {
    const r = await api.dataImport();
    if (r && r.ok) toast('已导入，正在重启奶蛙…');
    else toast('已取消');
    if (r && r.ok) setTimeout(() => api.close(), 1200);
  };
  $('openData').onclick = () => api.openPath((s.__root) || '');
  $('openLogs').onclick = () => api.openLogs();
  $('clearClip').onclick = async () => { await api.clipboardClear(); toast('剪贴板历史已清空'); };
  $('memAdd').onclick = async () => {
    const t = $('memInput').value.trim();
    if (!t) return;
    await api.memoryAdd({ text: t });
    $('memInput').value = '';
    loadMemory();
    toast('记住了');
  };
  $('memInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('memAdd').click(); });
  loadMemory();
}

// ---------------------------------------------------------------- 关于
async function loadLogs() {
  const txt = await api.logsTail({ lines: 200 });
  $('logBox').textContent = txt || '（还没有日志）';
}

async function initAbout() {
  const i = await api.appInfo();
  $('verLabel').textContent = 'v' + i.version;
  $('aboutInfo').innerHTML = [
    ['版本', 'v' + i.version],
    ['Electron', i.electron],
    ['Node', i.node],
    ['Chromium', i.chrome],
    ['平台', i.platform + ' ' + i.arch],
    ['数据目录', i.root],
    ['日志目录', i.logs],
    ['开机自启', i.autoStart ? '已开启' : '未开启'],
    ['快捷键', Object.keys(i.hotkeys || {}).map((k) => k + '=' + i.hotkeys[k]).join('  ')],
    ['内存占用', Math.round((i.memory || 0) / 1048576) + ' MB']
  ].map((x) => '<div class="kv"><span class="k">' + x[0] + '</span><span class="v">' + String(x[1]).replace(/</g, '&lt;') + '</span></div>').join('');

  $('checkUpdate').onclick = async () => {
    $('updateInfo').textContent = '正在问 GitHub…';
    const r = await api.appCheckUpdate();
    if (!r) { $('updateInfo').textContent = '检查失败'; return; }
    if (!r.ok) { $('updateInfo').textContent = '✗ ' + (r.error || '检查失败'); return; }
    if (r.hasUpdate) {
      $('updateInfo').innerHTML = '发现新版本 <b>' + esc(r.latest) + '</b>（当前 ' + esc(r.current) + '）<br>'
        + (r.url ? '<span class="pill" data-ext="' + esc(r.url) + '">到 Releases 下载</span>' : '');
      const link = $('updateInfo').querySelector('[data-ext]');
      if (link) { link.style.cursor = 'pointer'; link.onclick = () => api.openExternal(link.getAttribute('data-ext')); }
      if (r.assetUrl) $('downloadUpdate').style.display = '';
    } else if (r.latest) {
      $('updateInfo').textContent = '已经是最新版（' + r.current + '）';
    } else {
      $('updateInfo').textContent = '读不到版本号（仓库可能还没有 Release）';
    }
  };

  $('downloadUpdate').onclick = async () => {
    $('updateInfo').textContent = '正在下载更新包…（几十 MB，等一会儿）';
    const c = await api.appCheckUpdate();
    if (!c || !c.ok || !c.assetUrl) { $('updateInfo').textContent = 'x 找不到可下载的安装包'; return; }
    const d = await api.appDownloadUpdate({ url: c.assetUrl, name: c.assetName });
    if (!d || !d.ok) { $('updateInfo').textContent = 'x 下载失败：' + ((d && d.error) || ''); return; }
    $('updateInfo').innerHTML = '已下载到 <span class="mono">' + String(d.path).replace(/</g, '&lt;') + '</span>（'
      + Math.round(d.bytes / 1048576) + ' MB）<div class="row" style="margin-top:8px">'
      + '<div class="btn sm primary" id="runUpdate">现在安装 / 打开</div></div>';
    $('runUpdate').onclick = async () => {
      const r2 = await api.appRunUpdate({ path: d.path });
      toast(r2 && r2.ok ? '已启动安装包，按向导走就行' : ('x ' + ((r2 && r2.error) || '')));
    };
  };

  $('showTranscript').onclick = async () => {
    const r = await api.agentTranscript();
    if (!r || !r.ok) { toast('导出失败：' + ((r && r.error) || '')); return; }
    const lines = (r.transcript || []).map((e) => {
      const who = e.kind === 'user' ? '你' : e.kind === 'assistant' ? '奶蛙' : e.kind === 'tool' ? '工具:' + e.name : '—';
      return '【' + who + '】\n' + (e.text || '');
    });
    const text = lines.join('\n\n') || '（当前会话没有内容，或者用的是内置引擎）';
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'nailong-conversation.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    toast('已导出会话文本');
  };
}

async function renderOnboard() {
  const show = !SET || !SET.onboardingDone;
  $('onboard').style.display = show ? '' : 'none';
  $('onboardDone').onclick = async () => {
    SET = await api.settingsSave({ onboardingDone: true });
    renderOnboard();
    toast('设置随时可以从奶蛙右键菜单或托盘里再打开');
  };
}

// ---------------------------------------------------------------- 启动
(async function init() {
  SET = await api.settingsGet();
  if (window.WidgetI18n) { window.WidgetI18n.setLocale(SET.locale); window.WidgetI18n.applyDom(); }
  applyTheme(SET.theme);
  await renderOnboard();
  if (window.WidgetAudio) {
    window.WidgetAudio.setEnabled(SET.sound !== false);
    const unlock = () => { try { window.WidgetAudio.unlock(); } catch (e) { /* ignore */ } };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
  }
  sw('sw-shot', (SET.agent || {}).autoScreenshotEveryAction !== false, async (v) => {
    await saveSettings({ agent: Object.assign({}, SET.agent, { autoScreenshotEveryAction: v }) }, true);
    toast(v ? '每次操作后附截图' : '已关闭自动截图');
  });

  await initModel();
  await initEngine();
  await initPerm();
  await initLook();
  await initRemind();
  await initData();
  await initAbout();

  $('close').onclick = () => {
    api.windowClose({ kind: 'settings' });
  };
  $('minbtn').onclick = () => api.windowMinimize({ kind: 'settings' });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $('close').click();
  });
  api.onSettingsChanged((s) => { if (s) { SET = s; if (window.WidgetAudio) window.WidgetAudio.setEnabled(s.sound !== false); syncPetScale(); } });

  // 首次运行：给个提示，但不拦截
  const cfg = await api.agentCfgGet();
  if (!cfg.hasKey && cfg.keyPersistence !== 'unavailable') {
    $('modelStatus').textContent = '还没配接口。日程、番茄钟、提醒这些不用 AI 的功能已经可以用了；想让奶蛙动电脑，就填上 Base URL 和 API Key（或者确保 pi 已经登录过）。';
  }
})();
