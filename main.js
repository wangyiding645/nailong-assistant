'use strict';
/* 奶蛙助手 v3 主进程入口：装配各模块 + 定时器循环 */

const path = require('path');
const { app, screen, desktopCapturer, clipboard, Notification, shell: electronShell, nativeImage } = require('electron');

const P = require('./src/main/paths.js');
const { createLogger, installCrashHandlers } = require('./src/main/log.js');
const { createNative } = require('./src/main/native.js');
const { createServices } = require('./src/main/services.js');
const { createWindows } = require('./src/main/windows.js');
const { createHost } = require('./src/main/host.js');
const { createAgentService } = require('./src/main/agent-service.js');
const { createEngineRouter } = require('./src/main/engines/index.js');
const { createShell } = require('./src/main/shell.js');
const { registerIpc } = require('./src/main/ipc.js');
const { createPetActions } = require('./src/main/pet-actions.js');
const L = require('./src/shared/logic.js');
const T = require('./src/shared/task.js');

const DEMO = process.env.WIDGET_DEMO === '1';

app.setPath('userData', P.userData);
app.setName('奶蛙助手');
if (process.platform === 'win32') app.setAppUserModelId('com.nailong.assistant');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  boot();
}

function boot() {
  const log = createLogger({ dir: P.logs, name: 'app', level: process.env.WIDGET_DEBUG === '1' ? 'debug' : 'info' });
  installCrashHandlers(log);
  log.info('启动，版本 ' + app.getVersion() + '，根目录 ' + P.ROOT);
  if (P.migrated && P.migrated.length) {
    log.info('[data] 已从旧位置搬来 ' + P.migrated.length + ' 项用户数据（密钥/历史会话/pi 登录等）：'
      + P.migrated.map((m) => path.basename(m.to)).join(' '));
  }

  const appState = { mode: 'normal', asstPinned: true, foreground: '' };
  let services = null;
  let windows = null;
  let native = null;
  let host = null;
  let agentSvc = null;
  let shell = null;
  let petActions = null;
  let timers = [];
  const backdropTimers = {};

  function emit(channel, payload) {
    windows.broadcast(channel, payload);
  }

  // ------------------------------------------------------------ 形态切换
  function setMode(mode) {
    const allowed = ['normal', 'assistant', 'focus', 'countdown', 'alarm', 'coin', 'catch'];
    const m = allowed.indexOf(mode) >= 0 ? mode : 'normal';
    appState.mode = m;
    emit('mode-changed', m);
    windows.hide('menu');

    if (m === 'assistant') {
      windows.hide('tool');
      const w = windows.show('assistant');
      if (w) {
        applyAsstPin();
        setTimeout(() => refreshBackdrop('assistant'), 250);
      }
      emit('assistant-state', true);
    } else {
      windows.hide('assistant');
      emit('assistant-state', false);
      if (['focus', 'countdown', 'alarm', 'coin'].indexOf(m) >= 0) {
        const w = windows.show('tool');
        if (w) w.webContents.send('tool-view', m);
      } else {
        windows.hide('tool');
      }
    }

    if (m === 'catch') petActions.start();
    else if (petActions.isCatching()) petActions.stop(false);

    refreshTraySoon();
    return m;
  }

  function applyAsstPin() {
    const w = windows.get('assistant');
    if (!w) return;
    if (appState.asstPinned) {
      try { w.setAlwaysOnTop(true, 'screen-saver'); } catch (e) { try { w.setAlwaysOnTop(true); } catch (e2) { /* ignore */ } }
      try { w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (e) { /* ignore */ }
    } else {
      try { w.setAlwaysOnTop(true, 'floating'); } catch (e) { try { w.setAlwaysOnTop(true); } catch (e2) { /* ignore */ } }
      try { w.setVisibleOnAllWorkspaces(false); } catch (e) { /* ignore */ }
    }
  }

  function togglePanel() {
    const w = windows.get('panel');
    if (!w) return false;
    if (w.isVisible()) { windows.hide('panel'); emit('panel-state', false); return false; }
    windows.placePanel();
    w.show();
    w.focus();
    emit('panel-state', true);
    refreshBackdrop('panel');
    return true;
  }

  // ------------------------------------------------------------ 毛玻璃背景
  function refreshBackdrop() { /* 使用稳定的主题底色，无需捕获桌面背景。 */ }

  function scheduleBackdrop(kind) {
    if (backdropTimers[kind]) clearTimeout(backdropTimers[kind]);
    backdropTimers[kind] = setTimeout(() => refreshBackdrop(kind), 500);
  }

  // ------------------------------------------------------------ 提醒
  let trayRefreshAt = 0;
  function refreshTraySoon() {
    if (Date.now() < trayRefreshAt) return;
    trayRefreshAt = Date.now() + 5000;
    if (shell) shell.refreshTray();
  }

  function handleReminder(r) {
    const s = services.settings.reminder();
    if (r.kind === 'summary') {
      services.notify.show('今日日程小结', r.text);
      windows.send('pet', 'pet-ping', { action: 'summary', text: r.text });
      return;
    }
    const t = r.task || {};
    const when = t.time || '';
    let title = '';
    let body = '';
    if (r.kind === 'pre') {
      title = when + ' 还有 ' + (r.minutes || 0) + ' 分钟';
      body = t.text;
    } else if (r.kind === 'missed') {
      title = '错过提醒：' + when + ' ' + t.text;
      body = '已经过去 ' + (r.lateMin || 0) + ' 分钟';
    } else {
      title = when + ' ' + t.text;
      body = '到点啦';
    }
    windows.send('pet', 'pet-ping', {
      action: 'reminder',
      kind: r.kind,
      time: when,
      text: t.text || '',
      key: r.key || '',
      minutes: r.minutes || 0,
      lateMin: r.lateMin || 0
    });
    if (s.toast && (r.kind === 'due' || r.kind === 'missed')) {
      services.notify.show(title, body);
    }
    log.info('[reminder] ' + r.kind + ' ' + when + ' ' + (t.text || r.text || ''));
  }

  // ------------------------------------------------------------ 计时循环
  function startLoops() {
    // 主心跳：提醒 + 专注
    timers.push(setInterval(() => {
      const now = Date.now();
      try { services.reminders.tick(now); } catch (e) { log.error('[reminder] tick 异常：' + e.message); }
      try {
        const ev = services.focus.tick(now);
        if (ev) {
          const st = services.focus.status();
          windows.send('pet', 'pet-ping', { action: 'focus-event', event: ev, status: st });
          emit('focus-changed', st);
          if (services.settings.getKey('sound', true)) {
            services.notify.show(ev === 'focus-done' ? '专注完成 🍅' : '休息结束', ev === 'focus-done' ? '该休息一下了' : '继续加油');
          }
          refreshTraySoon();
        } else {
          const st = services.focus.status();
          windows.send('pet', 'pet-ping', { action: 'focus-tick', status: st });
          if (st.phase !== 'idle') windows.send('tool', 'focus-changed', st);
        }
      } catch (e) { log.error('[focus] tick 异常：' + e.message); }
    }, 1000));

    // 后台窗口自动回来（Win+D 之后）
    timers.push(setInterval(() => {
      if (appState.mode !== 'assistant' || !appState.asstPinned) return;
      const w = windows.get('assistant');
      if (w && w.isVisible() && w.isMinimized()) { w.restore(); w.showInactive(); }
    }, 1500));

    // 剪贴板历史
    let lastClip = '';
    if (services.settings.getKey('privacy', {}).clipboardHistory !== false) {
      timers.push(setInterval(() => {
        try {
          const t = clipboard.readText();
          if (t && t !== lastClip) {
            lastClip = t;
            services.clipboard.push(t);
          }
        } catch (e) { /* 剪贴板偶尔会被别的进程锁住 */ }
      }, 900));
    }

    // 前台窗口（给系统提示用）
    let fgBusy = false;
    timers.push(setInterval(async () => {
      if (fgBusy) return;
      fgBusy = true;
      try {
        const list = await host.windowList();
        const fg = list.find((w) => w.foreground);
        appState.foreground = fg ? fg.title : '';
      } catch (e) { /* 忽略 */ }
      fgBusy = false;
    }, 8000));
  }

  // ------------------------------------------------------------ 启动
  function startPetWatchdog() {
    const child = require('child_process').spawn('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-File', path.join(P.native, 'watch.ps1'),
      '-ProcessId', String(process.pid),
      '-Title', '奶蛙助手'
    ], { windowsHide: true, stdio: 'ignore' });
    child.on('error', (e) => log.warn('[watch] 启动失败：' + e.message));
    app.on('will-quit', () => { try { child.kill(); } catch (e) { /* ignore */ } });
  }

  app.whenReady().then(() => {
    const startedAt = Date.now();

    if (DEMO) {
      process.env.WIDGET_DEMO = '1';
      log.info('演示模式');
    }

    services = createServices({
      onScheduleChange: () => emit('tasks-changed', services.schedule.readText()),
      onCountdownChange: () => emit('countdown-changed', services.countdown.readText()),
      onStateChange: (s) => emit('state-changed', s),
      onFocusChange: (s) => emit('focus-changed', services.focus.status()),
      onReminder: handleReminder,
      onNotify: (title, body) => { if (host) host.notifyNative(title, body); }
    });

    const level = services.settings.getKey('privacy', {}).logLevel;
    void level;

    native = createNative({ nativeDir: P.native, log });
    windows = createWindows({
      app, log, settings: services.settings,
      onPetMoved: (p) => windows.writePetPos(p),
      onPetClosed: () => app.quit(),
      onHidden: (kind) => { if (kind === 'panel') emit('panel-state', false); }
    });

    host = createHost({
      app, screen, desktopCapturer, clipboard, Notification, shell: electronShell, nativeImage,
      native, services, log, paths: P,
      overlayWindows: () => windows.allOverlays(),
      autoScreenshot: () => services.settings.getKey('agent', {}).autoScreenshotEveryAction !== false,
      onNotificationClick: () => setMode('assistant')
    });

    const builtinEngine = createAgentService({
      log, services, host, emit,
      getLocale: () => services.settings.getKey('locale', 'zh-CN'),
      getForeground: () => appState.foreground
    });
    builtinEngine.applyToolSettings();

    // 双内核：pi 当大脑（子进程），内置引擎兼底；上面那层路由对 IPC 完全透明
    agentSvc = createEngineRouter({
      builtin: builtinEngine,
      settings: services.settings,
      log, services, host, emit,
      getLocale: () => services.settings.getKey('locale', 'zh-CN'),
      getForeground: () => appState.foreground,
      version: app.getVersion()
    });

    // 开机后在后台把 pi 内核预热（首次对话就不用等启动）
    setTimeout(() => {
      agentSvc.warmUp()
        .then((st) => log.info('[pi] 预热完成，引擎=' + agentSvc.engine() + (st && st.ready ? '，模型=' + (st.model || '未指定') : '')))
        .catch((e) => log.warn('[pi] 预热失败（将使用内置引擎）：' + ((e && e.message) || e)));
    }, 3500);

    petActions = createPetActions({ windows, native, log,
      onCatchEnd: ({ reason }) => {
        if (reason !== 'restart' && appState.mode === 'catch') setMode('normal');
      }
    });

    shell = createShell({
      log, services, windows,
      onOpenAssistant: () => setMode('assistant'),
      onTogglePanel: () => togglePanel(),
      onOpenSettings: () => windows.show('settings'),
      onFocusStart: () => {
        if (services.focus.status().phase === 'idle') services.focus.start(25, '');
        setMode('focus');
      },
      onQuit: () => app.quit()
    });

    registerIpc({
      services, windows, host, agentSvc, shell, log, appState,
      setMode, applyAsstPin, togglePanel, refreshBackdrop,
      handleDrop: (paths) => petActions.handleDrop(paths),
      catchPet: () => {
        if (appState.mode !== 'catch' || !petActions.isCatching()) return false;
        petActions.stop(true);
        return true;
      },
      returnPetHome: () => petActions.returnHome()
    });

    windows.createPet();
    windows.createPanel();
    windows.createAssistant();
    windows.createTool();

    // 桌宠常驻置顶 + Win+D 之后自动回来（v2 踩过的坑，靠原生看门狗兜底）
    startPetWatchdog();

    shell.createTray();
    if (process.env.WIDGET_AUDIT !== '1') {
      shell.applyHotkeys();
      shell.applyAutoStart();
    }

    startLoops();

    // 启动后补报错过的提醒（限制在 30 分钟内）
    setTimeout(() => {
      try {
        const catchUp = services.settings.reminder().catchUpMinutes || 30;
        services.reminders.markAllTodaySeen(Date.now() - catchUp * 60000);
      } catch (e) { log.warn('[reminder] 补报失败：' + e.message); }
    }, 4000);

    // 首次运行 → 打开设置页做引导
    if (!services.settings.getKey('onboardingDone', false)) {
      setTimeout(() => windows.show('settings'), 1200);
    }

    // npm run audit：无头式界面自检，跑完自己退出
    if (process.env.WIDGET_AUDIT === '1') {
      setTimeout(async () => {
        try {
          const { runAudit } = require('./src/main/audit.js');
          const report = await runAudit({ windows, services, log, setMode });
          process.exitCode = report.problems.length ? 2 : 0;
        } catch (e) {
          log.error('[audit] 崩了：' + ((e && e.stack) || e));
          process.exitCode = 3;
        }
        app.quit();
      }, 4500);
    }

    log.info('就绪，用时 ' + (Date.now() - startedAt) + 'ms');
  });

  app.on('second-instance', () => {
    setMode('assistant');
  });

  app.on('window-all-closed', () => { /* 桌宠常驻，不随窗口关闭退出 */ });

  app.on('will-quit', () => {
    timers.forEach((t) => clearInterval(t));
    try { if (agentSvc) { agentSvc.bridge.stop(); agentSvc.pi.stop(); } } catch (e) { /* ignore */ }
    try { if (shell) shell.dispose(); } catch (e) { /* ignore */ }
    try { if (native) native.dispose(); } catch (e) { /* ignore */ }
    try { if (services) services.dispose(); } catch (e) { /* ignore */ }
    log.info('退出');
    log.flush();
  });
}
