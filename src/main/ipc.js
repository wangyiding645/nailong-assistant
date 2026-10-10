'use strict';
/* IPC 路由：所有渲染层能做的事都在这里登记，方便一眼看清攻击面 */

const fs = require('fs');
const path = require('path');
const { ipcMain, app, shell: electronShell, clipboard, dialog } = require('electron');

const P = require('./paths.js');
const updateLib = require('./update.js');
const L = require('../shared/logic.js');
const T = require('../shared/task.js');
const R = require('../shared/repeat.js');
const NL = require('../shared/nl.js');

function registerIpc(ctx) {
  const { services, windows, host, agentSvc, shell, log, appState } = ctx;
  const h = (channel, fn) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (e, payload) => {
      try {
        return await fn(payload, e);
      } catch (err) {
        log.warn('[ipc] ' + channel + ' 失败：' + String((err && err.message) || err));
        return { error: String((err && err.message) || err) };
      }
    });
  };

  // ------------------------------------------------------------ 初始化数据
  const initPayload = () => ({
    tasks: services.schedule.readText(),
    countdown: services.countdown.readText(),
    state: services.stateObj(),
    settings: services.settings.get(),
    petScale: windows.petScale(),
    theme: services.settings.getKey('theme', 0),
    locale: services.settings.getKey('locale', 'zh-CN'),
    mode: appState.mode,
    version: app.getVersion(),
    tools: agentSvc.toolset.catalog(),
    usage: agentSvc.usage(),
    focus: services.focus.status(),
    reminders: services.reminders.firedMap()
  });

  h('app-init', initPayload);
  h('pet-init', () => initPayload());
  h('panel-init', () => initPayload());

  // ------------------------------------------------------------ 日程 / 倒数日
  h('save-schedule', (text) => {
    services.schedule.writeText(String(text || ''));
    windows.broadcast('tasks-changed', services.schedule.readText());
    return true;
  });
  h('save-countdown', (text) => {
    services.countdown.writeText(String(text || ''));
    windows.broadcast('countdown-changed', services.countdown.readText());
    return true;
  });
  h('toggle-done', (p) => {
    if (!p || !p.date || !p.key) return services.stateObj();
    const r = services.schedule.toggleDone(p.date, p.key, !!p.undo);
    const payload = services.stateObj();
    windows.broadcast('state-changed', payload);
    if (r.becameComplete && p.date === L.todayStr()) windows.broadcast('celebrate', true);
    return payload;
  });
  h('schedule-add', (task) => services.schedule.add(task));
  h('schedule-remove', (p) => services.schedule.remove((t) => T.keyOf(t) === p.key));
  h('schedule-update', (p) => services.schedule.update(p.old, p.patch));
  h('nl-parse', (p) => {
    const parsed = NL.parseQuickAdd(String((p && p.text) || ''), new Date());
    const task = { date: parsed.date || '', time: parsed.time || '', text: parsed.text || '' };
    if (parsed.repeat) task.repeat = parsed.repeat;
    if (parsed.alarm) task.alarm = parsed.alarm;
    if (parsed.tag) task.tag = parsed.tag;
    if (parsed.prio && parsed.prio !== 'mid') task.prio = parsed.prio;
    if (parsed.dur) task.dur = parsed.dur;
    return { task: task, summary: NL.describeQuickAdd(parsed), repeatText: R.describeRepeat(parsed.repeat) };
  });
  h('countdown-add', (p) => services.countdown.add(p.date, p.text));
  h('countdown-remove', (p) => services.countdown.remove(p.date, p.text));

  // ------------------------------------------------------------ 设置
  function applySettings(patch) {
    const before = JSON.parse(JSON.stringify(services.settings.get()));
    const a = patch && patch.agent;
    if (a) {
      if (agentSvc.pi.streaming && ['piConfig', 'engine', 'workspace', 'noSkills', 'noContextFiles', 'loadUserExtensions', 'noMcp', 'contextWindow', 'disabledTools', 'skillPaths'].some(k => JSON.stringify(a[k]) !== JSON.stringify((before.agent || {})[k]))) throw new Error('请先停止当前任务再修改运行配置');
      if (a.workspace && (!path.isAbsolute(a.workspace) || !fs.statSync(a.workspace).isDirectory())) throw new Error('工作区必须是存在的绝对目录');
      const pol = a.policy || {};
      if (pol.maxSteps !== undefined && (!Number.isInteger(Number(pol.maxSteps)) || pol.maxSteps < 3 || pol.maxSteps > 80)) throw new Error('任务步数必须为 3–80');
      if (a.contextWindow !== undefined && (!Number.isInteger(Number(a.contextWindow)) || a.contextWindow < 1024 || a.contextWindow > 2000000)) throw new Error('上下文窗口必须为 1024–2000000');
    }
    const pet = patch && patch.pet;
    if (pet && pet.scale !== undefined) pet.scale = L.clampPetScale(pet.scale);
    services.settings.set(patch || {});
    if (services.settings.store.saveNow() === false) { services.settings.set(before); throw new Error('设置写入失败，本次未保存'); }
    const after = services.settings.get();
    if (JSON.stringify(before.hotkeys) !== JSON.stringify(after.hotkeys)) shell.applyHotkeys();
    if (before.autoStart !== after.autoStart) shell.applyAutoStart();
    if (JSON.stringify(before.agent) !== JSON.stringify(after.agent)) {
      agentSvc.applyToolSettings();
      if (agentSvc.applyRuntimeSettings) agentSvc.applyRuntimeSettings().catch(e => log.warn('[pi] 运行设置同步失败：' + e.message));
      // 加载用户扩展这个开关改了必须重启 pi 才能生效
      if (agentSvc.restartPiIfNeeded && agentSvc.restartPiIfNeeded()) {
        agentSvc.restartPi().catch((e) => log.warn('[pi] 重启失败：' + e.message));
      }
    }
    if (JSON.stringify(before.pet) !== JSON.stringify(after.pet)) {
      windows.applyPetScale();
      windows.send('pet', 'pet-ping', { action: 'scale', scale: windows.petScale() });
    }
    windows.broadcast('settings-changed', after);
    return after;
  }

  h('workspace-choose', async () => {
    const result = await dialog.showOpenDialog(windows.get('settings') || null, { title: '选择助手工作区', properties: ['openDirectory'] });
    return result.canceled ? { canceled: true } : { path: result.filePaths[0] };
  });
  h('settings-get', () => services.settings.get());
  h('settings-save', (patch) => applySettings(patch));
  h('settings-reset', () => {
    services.settings.set({ agent: { disabledTools: {}, policy: { mode: 'confirm', allow: {}, deny: {}, confirmHighRisk: true, maxSteps: 24 }, locale: 'zh-CN' } });
    agentSvc.applyToolSettings();
      if (agentSvc.applyRuntimeSettings) agentSvc.applyRuntimeSettings().catch(e => log.warn('[pi] 运行设置同步失败：' + e.message));
    return services.settings.get();
  });
  h('tools-list', () => agentSvc.toolset.catalog());
  h('app-info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    root: P.ROOT,
    logs: P.logs,
    autoStart: shell.autoStartEnabled(),
    hotkeys: shell.hotkeys(),
    platform: process.platform,
    arch: process.arch,
    memory: process.memoryUsage().rss
  }));
  h('open-path', (p) => electronShell.openPath(String(p || P.ROOT)));
  h('open-external', (url) => electronShell.openExternal(String(url || '')));

  // ------------------------------------------------------------ 助手（agent）
  h('agent-cfg-get', () => agentSvc.publicConfig());
  const broadcastAgentConfig = () => windows.broadcast('agent-config-changed', agentSvc.publicConfig());
  h('agent-cfg-save', (c) => {
    const saved = agentSvc.saveConfig(c);
    broadcastAgentConfig();
    return saved;
  });
  h('agent-test', async () => {
    try { return Object.assign({ ok: true }, await agentSvc.testConnection()); }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  h('agent-detect-model', async () => {
    try { return Object.assign({ ok: true }, await agentSvc.detectModel()); }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  h('read-image', (p) => {
    const f = String((p && p.path) || '');
    if (!f) return { ok: false, error: '没有路径' };
    const r = host.readImageFile(f, (p && p.maxSide) || 1400);
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || '读不了这张图' };
    return { ok: true, dataUrl: r.dataUrl, width: r.width, height: r.height, bytes: r.bytes, path: f };
  });

  h('agent-shot', async () => {
    try {
      const s = await host.screenshot({});
      return { dataUrl: s.dataUrl, sentW: s.sentW, sentH: s.sentH, physW: s.physW, physH: s.physH };
    } catch (e) { return { error: String(e.message || e) }; }
  });
  h('agent-send', (p) => agentSvc.send(String((p && p.text) || ''), p || {}));
  h('agent-confirm', (p) => {
    const payload = p || {};
    const value = payload.answer !== undefined ? String(payload.answer) : (payload.choice || 'exec');
    return agentSvc.confirm(value);
  });
  h('agent-stop', () => agentSvc.stop());
  h('agent-clear', () => agentSvc.clear());
  h('agent-sessions', () => agentSvc.listSessions());
  h('agent-session-new', () => agentSvc.newSession());
  h('agent-session-load', (p) => {
    const s = agentSvc.loadSession(String((p && p.id) || ''));
    return s ? { ok: true, session: s } : { ok: false, error: '找不到这个会话' };
  });
  h('agent-session-delete', (p) => agentSvc.deleteSession(String((p && p.id) || '')));
  h('agent-usage', () => agentSvc.usageDetail());
  h('agent-engine', async () => {
    const info = agentSvc.engineInfo();
    // 把 pi 侧环境自检（代理 / 凭据）一并带上，界面才能给出“为什么发不出去”的答案
    try { if (agentSvc.preflight) info.pi.preflight = await agentSvc.preflight(); } catch (e) { /* ignore */ }
    return info;
  });
  h('agent-engine-set', (p) => {
    const mode = String((p && p.engine) || 'auto');
    applySettings({ agent: Object.assign({}, services.settings.agentCfg(), { engine: mode }) });
    // 换引擎时把旧的一侧收干净，免得两个进程同时挂在后台
    if (mode === 'builtin') { try { agentSvc.pi.stop(); } catch (e) { /* ignore */ } }
    return agentSvc.engineInfo();
  });
  h('agent-session-stats', () => agentSvc.sessionStats());
  // ---- MCP 服务器 ----
  h('mcp-list', (p) => agentSvc.mcp(p || {}));
  h('mcp-add', (p) => agentSvc.mcpAdd((p && p.name) || '', (p && p.json) || ''));
  h('mcp-remove', (p) => agentSvc.mcpRemove((p && p.name) || ''));
  h('mcp-toggle', (p) => agentSvc.mcpToggle((p && p.name) || '', !!(p && p.enabled)));
  h('mcp-open', () => { const f = agentSvc.mcp(); return electronShell.openPath(f.path); });
  h('mcp-logout', async (p) => agentSvc.mcpLogout((p && p.name) || ''));
  h('mcp-status', async (p) => {
    const st = await agentSvc.mcpStatus(!!(p && p.force));
    return { ok: st.ok, error: st.error, servers: st.servers };
  });
  ipcMain.removeHandler('mcp-check-logged-in');
  h('mcp-check-logged-in', async (p) => {
    const name = String((p && p.name) || '');
    const st = await agentSvc.mcpStatus(true);
    const hit = (st.servers || []).find((s) => s.name === name);
    if (!hit) return { ok: false, state: 'unknown' };
    return { ok: hit.state !== 'failed', state: String(hit.state || ''), tools: hit.tools || [], error: String(hit.error || '') };
  });
  h('mcp-login', (p) => {
    const name = String((p && p.name) || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) return { ok: false, error: '服务器名不对' };
    const cli = agentSvc.pi.cliPath();
    if (!cli) return { ok: false, error: '找不到自带的 pi' };
    const { spawn } = require('child_process');
    const env = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' });
    delete env.PI_CODING_AGENT_DIR;
    if (agentSvc.piConfigMode() === 'bundled') env.PI_CODING_AGENT_DIR = P.piAgent;
    // 用 start 开一个可见窗口：pi 要在浏览器里完成授权，还会需要粘贴回调地址
    const inner = '"' + process.execPath + '" "' + cli + '" mcp login ' + name;
    spawn('cmd', ['/c', 'start', '""', 'cmd', '/k', inner], { windowsHide: false, env: env, detached: true, stdio: 'ignore' }).unref();
    return { ok: true, hint: '已打开一个终端窗口，按提示在浏览器里完成授权（如果要粘贴回调地址就粘进去）。完成后回来点「刷新」。' };
  });

  h('agent-preflight', async (p) => {
    try { return { ok: true, result: await agentSvc.preflight(!!(p && p.force)) }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  // ---- pi 内核的进阶能力（模型 / 思考 / 上下文 / 会话树 / 命令） ----
  h('agent-models', async () => {
    try { return { ok: true, models: await agentSvc.listPiModels() }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  h('agent-set-model', async (p) => {
    try {
      const model = await agentSvc.piSetModel(String((p && p.provider) || ''), String((p && p.modelId) || ''));
      broadcastAgentConfig();
      return { ok: true, model };
    }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  h('agent-cycle-model', async () => {
    try { const result = await agentSvc.piCycleModel(); broadcastAgentConfig(); return { ok: true, result }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  h('agent-thinking-levels', async () => {
    try { return { ok: true, levels: await agentSvc.piThinkingLevels() }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  h('agent-set-thinking', async (p) => {
    try { return { ok: true, level: await agentSvc.piSetThinking(String((p && p.level) || 'off')) }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  h('agent-compact', async (p) => {
    try { return { ok: true, result: await agentSvc.piCompact((p && p.instructions) || '') }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  h('agent-commands', async () => {
    try { return { ok: true, commands: await agentSvc.piCommands() }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  h('agent-transcript', async () => {
    try {
      const info = agentSvc.engineInfo();
      if (info.active !== 'pi') return { ok: true, transcript: [] };
      await agentSvc.listPiModels(); // 顺手确保内核已起来
      const { piMessagesToTranscript } = require('./engines/pi-history.js');
      const msgs = await agentSvc.pi.messages();
      return { ok: true, transcript: piMessagesToTranscript(msgs) };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  h('agent-session-rename', async (p) => {
    try { await agentSvc.renameSession(String((p && p.name) || '')); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  h('agent-session-clone', async () => {
    try { return { ok: true, result: await agentSvc.cloneSession() }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  h('agent-session-fork', async (p) => {
    try { return { ok: true, result: await agentSvc.forkSession(String((p && p.entryId) || '')) }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  h('agent-fork-messages', async () => {
    try { return { ok: true, messages: await agentSvc.forkMessages() }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  h('agent-session-tree', async () => {
    try {
      const t = await agentSvc.sessionTree();
      return { ok: true, tree: (t && t.tree) || [], leafId: (t && t.leafId) || '' };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  // 下载更新包并启动它（不引入 electron-updater：直接下 release 资产更可控）
  h('app-download-update', async (p) => {
    const url = String((p && p.url) || '');
    if (!/^https:\/\//.test(url)) return { ok: false, error: '下载地址不对' };
    const fetchImpl = host.fetchImpl || globalThis.fetch;
    const fs2 = require('fs');
    const os2 = require('os');
    const name = (String((p && p.name) || '').trim()) || (url.split('/').pop() || 'nailong-update.exe');
    const safe = name.replace(/[^\w.\-]/g, '_');
    const dest = path.join(os2.tmpdir(), 'nailong-update-' + Date.now(), safe);
    fs2.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      const res = await fetchImpl(url, { headers: { 'user-agent': 'nailong-assistant/' + app.getVersion() } });
      if (!res.ok) throw new Error('下载失败：HTTP ' + res.status);
      const total = Number(res.headers.get('content-length') || 0);
      const buf = Buffer.from(await res.arrayBuffer());
      fs2.writeFileSync(dest, buf);
      if (total && buf.length !== total) throw new Error('下载不完整（' + buf.length + '/' + total + '）');
      return { ok: true, path: dest, bytes: buf.length };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  h('app-run-update', async (p) => {
    const f = String((p && p.path) || '');
    if (!f || !fs.existsSync(f)) return { ok: false, error: '安装包不在了' };
    await electronShell.openPath(f);
    return { ok: true };
  });

  h('app-check-update', async () => {
    try {
      const fetchImpl = host.fetchImpl || globalThis.fetch;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      let res;
      try {
        res = await fetchImpl('https://api.github.com/repos/wangyiding645/nailong-assistant/releases/latest', {
          signal: ctrl.signal,
          headers: { 'user-agent': 'nailong-assistant/' + app.getVersion(), accept: 'application/vnd.github+json' }
        });
      } finally { clearTimeout(timer); }
      if (!res.ok) throw new Error('GitHub 返回 ' + res.status);
      const data = await res.json();
      return Object.assign({ ok: true }, updateLib.summarizeRelease(data, app.getVersion()));
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });

  // ------------------------------------------------------------ 专注 / 统计
  h('focus-status', () => services.focus.status());
  h('focus-start', (p) => {
    services.focus.start((p && p.minutes) || 25, (p && p.label) || '');
    // 返回给界面的必须是 status 形状（里面 label 是阶段名），
    // 而不是内部 state（那里 label 是“这段专注干什么”的任务名）——两者同名不同义，混用会让
    // 番茄钟点开始后阶段显示成“待开始”
    const st = services.focus.status();
    windows.broadcast('focus-changed', st);
    return st;
  });
  h('focus-pause', () => { services.focus.pause(); windows.broadcast('focus-changed', services.focus.status()); return services.focus.status(); });
  h('focus-resume', () => { services.focus.resume(); windows.broadcast('focus-changed', services.focus.status()); return services.focus.status(); });
  h('focus-stop', () => { services.focus.stop(); windows.broadcast('focus-changed', services.focus.status()); return services.focus.status(); });
  h('focus-skip', () => { services.focus.skip(); windows.broadcast('focus-changed', services.focus.status()); return services.focus.status(); });
  h('focus-config', (p) => services.focus.setConfig(p || {}));
  h('focus-sessions', () => services.focus.sessions());
  h('stats-get', (p) => {
    const days = Math.max(3, Math.min(180, (p && p.days) || 14));
    return {
      today: services.stats.today(),
      range: services.stats.range(days),
      usage: services.stats.usage()
    };
  });

  // ------------------------------------------------------------ 剪贴板 / 记忆
  h('clipboard-history', (p) => services.clipboard.history((p && p.query) || '', (p && p.limit) || 30));
  h('clipboard-clear', () => { services.clipboard.clear(); return true; });
  h('clipboard-set', (p) => { clipboard.writeText(String((p && p.text) || '')); services.clipboard.setLast(String((p && p.text) || '')); return true; });
  h('memory-list', () => services.memory.list());
  h('memory-add', (p) => services.memory.add(String((p && p.text) || ''), String((p && p.tag) || '')));
  h('memory-remove', (p) => services.memory.remove(String((p && p.id) || '')));
  h('memory-clear', () => services.memory.clear());

  // ------------------------------------------------------------ 声音兜底
  h('play-system-sound', (p) => host.playSystemSound((p && p.kind) || 'asterisk'));

  // ------------------------------------------------------------ 提醒
  h('reminder-snooze', (p) => {
    const key = String((p && p.key) || '');
    const min = Math.max(1, Math.min(240, (p && p.minutes) || 10));
    const at = services.reminders.snooze(key, min);
    windows.send('pet', 'pet-ping', { action: 'snooze-ok', minutes: min });
    return { at: at };
  });

  // ------------------------------------------------------------ 备份 / 导入
  h('data-export', async () => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const res = await dialog.showSaveDialog(windows.get('settings') || null, {
      title: '导出奶蛙数据',
      defaultPath: path.join(app.getPath('desktop'), 'nailong-backup-' + stamp + '.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    const data = { __app: 'nailong-assistant', version: app.getVersion(), exportedAt: Date.now(), files: {} };
    P.backupFiles.forEach((name) => {
      const full = path.join(P.ROOT, name);
      try { if (fs.existsSync(full)) data.files[name] = fs.readFileSync(full, 'utf8'); } catch (e) { /* ignore */ }
    });
    fs.writeFileSync(res.filePath, JSON.stringify(data, null, 2), 'utf8');
    return { ok: true, path: res.filePath };
  });
  h('data-import', async () => {
    const res = await dialog.showOpenDialog(windows.get('settings') || null, {
      title: '选择奶蛙备份文件',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    const raw = fs.readFileSync(res.filePaths[0], 'utf8');
    const data = JSON.parse(raw);
    if (!data || data.__app !== 'nailong-assistant' || !data.files) throw new Error('这不是奶蛙导出的备份文件');
    // 先备份当前数据再覆盖，避免手滑
    const dir = path.join(P.backups, String(Date.now()));
    fs.mkdirSync(dir, { recursive: true });
    P.backupFiles.forEach((name) => {
      const full = path.join(P.ROOT, name);
      try { if (fs.existsSync(full)) fs.copyFileSync(full, path.join(dir, name)); } catch (e) { /* ignore */ }
    });
    Object.keys(data.files).forEach((name) => {
      if (P.backupFiles.indexOf(name) < 0) return;
      fs.writeFileSync(path.join(P.ROOT, name), String(data.files[name]), 'utf8');
    });
    return { ok: true, restored: Object.keys(data.files).length, safetyCopy: dir, restart: true };
  });
  h('data-path', () => ({ root: P.ROOT, logs: P.logs, backups: P.backups }));
  h('logs-tail', (p) => log.tail(Math.max(20, Math.min(1000, (p && p.lines) || 200))));
  h('open-logs', () => electronShell.openPath(P.logs));

  // ------------------------------------------------------------ 窗口 / 模式
  h('open-assistant', () => { ctx.setMode('assistant'); return true; });
  h('assistant-hide', () => { ctx.setMode('normal'); return true; });
  h('open-settings', (p) => {
    const w = windows.show('settings');
    const tab = p && p.tab;
    if (w && ['connection', 'models', 'runtime', 'resources'].includes(tab)) {
      const send = () => w.webContents.send('settings-view', { tab });
      if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send); else send();
    }
    return true;
  });
  h('open-mode-menu', () => {
    const w = windows.ensure('menu');
    if (!w) return false;
    setTimeout(() => {
      windows.placeNearPet(w, windows.SIZES.menu.w, windows.SIZES.menu.h);
      w.show();
      w.focus();
      windows.send('menu', 'mode-current', appState.mode);
    }, 60);
    return true;
  });
  h('set-mode', (m) => ctx.setMode(String(m || 'normal')));
  h('menu-hide', () => { windows.hide('menu'); return true; });
  h('mode-get', () => appState.mode);
  h('asst-pin-get', () => ({ pinned: appState.asstPinned }));
  h('asst-pin-set', (v) => { appState.asstPinned = !!v; ctx.applyAsstPin(); return { pinned: appState.asstPinned }; });
  h('tool-hide', () => { ctx.setMode(appState.mode === 'assistant' ? 'assistant' : 'normal'); return true; });
  h('toggle-popup', () => ctx.togglePanel());
  h('hide-popup', () => { windows.hide('panel'); windows.broadcast('panel-state', false); return true; });
  h('reset-panel-pos', () => { try { fs.unlinkSync(P.popupCfg); } catch (e) { /* ignore */ } windows.placePanel(); return true; });
  h('save-panel-pos', (p) => { try { fs.writeFileSync(P.popupCfg, Math.round(p.x) + ',' + Math.round(p.y), 'utf8'); } catch (e) { /* ignore */ } return true; });
  h('refresh-panel-backdrop', () => { ctx.refreshBackdrop('panel'); return true; });
  h('refresh-asst-backdrop', () => { ctx.refreshBackdrop('assistant'); return true; });
  h('window-minimize', (p) => { const w = windows.get(p && p.kind); if (w) w.minimize(); return true; });
  h('window-close', (p) => { windows.hide(p && p.kind); return true; });
  h('close-app', () => { app.quit(); return true; });

  // ------------------------------------------------------------ 桌宠交互
  h('save-theme', (t) => {
    const v = Math.max(0, Math.min(5, Math.round(Number(t) || 0)));
    services.settings.setKey('theme', v);
    windows.broadcast('theme-changed', v);
    return v;
  });
  h('save-settings', (p) => {
    if (p && typeof p.sound === 'boolean') {
      const st = services.stateObj();
      st.settings.sound = p.sound;
      services.saveState();
      windows.broadcast('settings-changed', services.settings.get());
    }
    return true;
  });
  // 吃文件长大：一份食物 +10%（规模与上限见 shared/logic.js，屏幕上装不下时由 windows 层封顶）
  h('pet-grow', () => {
    const pet = Object.assign({}, services.settings.getKey('pet', {}));
    pet.scale = L.growPetScale(pet.scale, 1);
    applySettings({ pet: pet });
    return pet.scale;
  });
  h('pet-move', (p) => {
    const w = windows.get('pet');
    if (w && p) { const s = windows.petSize(); w.setBounds({ x: Math.round(p.x), y: Math.round(p.y), width: s.w, height: s.h }); }
    return true;
  });
  h('pet-move-by', (p) => {
    const w = windows.get('pet');
    if (w && p) {
      const b = w.getBounds();
      const s = windows.petSize();
      w.setBounds({ x: b.x + Math.round(p.dx || 0), y: b.y + Math.round(p.dy || 0), width: s.w, height: s.h });
    }
    return true;
  });
  h('pet-ping', (p) => { windows.send('pet', 'pet-ping', p || {}); return true; });
  h('pet-event', (p, e) => {
    if (p && p.type === 'catch-hit') {
      const pet = windows.get('pet');
      if (!pet || e.sender !== pet.webContents) return false;
      return ctx.catchPet();
    }
    windows.send('tool', 'pet-event', p || {});
    return true;
  });
  h('recycle-paths', (paths) => host.recycle(paths));
  h('drop-submit', (paths) => ctx.handleDrop(paths));
  h('ask-done-event', () => { ctx.returnPetHome(); return true; });
  ipcMain.on('set-ignore', (e, ignore) => {
    const w = windows.get('pet');
    if (w) { try { w.setIgnoreMouseEvents(!!ignore, { forward: true }); } catch (err) { /* ignore */ } }
  });

  // ------------------------------------------------------------ 调试
  h('debug-dump', (d) => {
    if (process.env.WIDGET_DEBUG !== '1') return false;
    try { fs.writeFileSync(path.join(P.ROOT, 'debug_panel.json'), JSON.stringify(d, null, 2), 'utf8'); } catch (e) { /* ignore */ }
    return true;
  });
  h('debug-dump-asst', (d) => {
    if (process.env.WIDGET_DEBUG !== '1') return false;
    try { fs.writeFileSync(path.join(P.ROOT, 'debug_asst.json'), JSON.stringify(d, null, 2), 'utf8'); } catch (e) { /* ignore */ }
    return true;
  });

  return { registerIpc };
}

module.exports = { registerIpc };
