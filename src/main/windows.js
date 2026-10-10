'use strict';
/* 窗口管理：桌宠 / 面板 / 助手 / 工具 / 形态菜单 / 设置
 * 保留 v2 踩过的坑：透明无框窗口必须用 setBounds（setPosition 会每次撑大 1px）。
 */

const path = require('path');
const fs = require('fs');
const { BrowserWindow, screen } = require('electron');

const P = require('./paths.js');
const L = require('../shared/logic.js');
const { prepareWindowBranding } = require('./window-branding');

const SIZES = {
  pet: { w: 190, h: 230 },
  panel: { w: 360, h: 540 },
  assistant: { w: 420, h: 640 },
  tool: { w: 348, h: 448 },
  menu: { w: 210, h: 424 },
  settings: { w: 760, h: 600 }
};

const TITLES = {
  pet: '奶蛙助手',
  panel: '奶蛙面板',
  assistant: '奶蛙助手 · 对话',
  tool: '奶蛙工具',
  menu: '奶蛙形态',
  settings: '奶蛙设置'
};

function createWindows(deps) {
  const { app, log, settings, getPreload } = deps;
  const wins = {};
  const auditErrors = [];
  const moveTimers = {};
  let petPos = null;
  const branding = process.platform === 'win32' ? prepareWindowBranding(app, log) : null;

  // preload 由 Electron 自己读，asar 内也行；但打包后代码目录和数据目录不是一个地方
  const preload = () => path.join(P.code, 'preload.js');

  function baseOptions(kind, extra) {
    const s = SIZES[kind];
    return Object.assign({
      width: s.w,
      height: s.h,
      show: false,
      frame: false,
      transparent: true,
      resizable: kind === 'settings',
      skipTaskbar: kind !== 'settings' && kind !== 'assistant',
      hasShadow: false,
      alwaysOnTop: kind !== 'settings',
      thickFrame: false,
      title: TITLES[kind],
      icon: process.platform === 'win32' ? P.icon : P.windowIcon,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: preload(),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
        spellcheck: false
      }
    }, extra || {});
  }

  function forwardLogs(win, tag) {
    win.webContents.on('console-message', (e, legacyLevel, legacyMessage) => {
      const level = e.level === undefined ? legacyLevel : ({ debug: 0, info: 1, warning: 2, error: 3 })[e.level];
      const message = e.message === undefined ? legacyMessage : e.message;
      if (process.env.WIDGET_AUDIT === '1' && level >= 3) auditErrors.push('[' + tag + '] ' + message);
      if (level >= 2) log.warn('[' + tag + '] ' + message);
      else log.debug('[' + tag + '] ' + message);
    });
    win.webContents.on('render-process-gone', (e, d) => {
      const message = '[' + tag + '] renderer gone: ' + JSON.stringify(d);
      if (process.env.WIDGET_AUDIT === '1') auditErrors.push(message);
      log.error(message);
    });
  }

  function load(win, file, query) {
    if (branding) win.setAppDetails(branding);
    win.loadFile(path.join(P.renderer, file), query ? { query: query } : undefined);
  }

  // ---------------------------------------------------------------- 桌宠体型
  // settings.pet.scale 存的是「想要的倍率」；实际用多少还要看屏幕装不装得下。
  // 屏幕装不下时按屏幕封顶：窗口比屏幕还高的话奶蛙本体就掉到屏幕外了。
  function petDisplay() {
    const w = get('pet');
    if (w) {
      const b = w.getBounds();
      return screen.getDisplayNearestPoint({ x: b.x + Math.round(b.width / 2), y: b.y + Math.round(b.height / 2) });
    }
    return screen.getPrimaryDisplay();
  }

  function petScale() {
    const want = L.clampPetScale((settings && settings.getKey ? settings.getKey('pet', {}) : {}).scale);
    const wa = petDisplay().workArea;
    return Math.max(0.1, Math.min(want, wa.width / SIZES.pet.w, wa.height / SIZES.pet.h));
  }

  function petSize() {
    const sc = petScale();
    return { w: Math.round(SIZES.pet.w * sc), h: Math.round(SIZES.pet.h * sc) };
  }

  function clampPetPos(pos, size) {
    const p = pos || defaultPetPos();
    // 按“离它最近的那块屏”夹，否则多屏用户会被拽回主屏
    const wa = screen.getDisplayNearestPoint({ x: Math.round(p.x), y: Math.round(p.y) }).workArea;
    return {
      x: Math.max(wa.x, Math.min(Math.round(p.x), wa.x + wa.width - size.w)),
      y: Math.max(wa.y, Math.min(Math.round(p.y), wa.y + wa.height - size.h))
    };
  }

  /** 按当前体型重排桌宠窗口：左下角锚点（脚不动，往上长），并夹回屏幕内 */
  function applyPetScale() {
    const w = get('pet');
    const s = petSize();
    if (!w) return s;
    const b = w.getBounds();
    const wa = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea;
    const pos = {
      x: Math.max(wa.x, Math.min(Math.round(b.x), wa.x + wa.width - s.w)),
      y: Math.max(wa.y, Math.min(Math.round(b.y + b.height - s.h), wa.y + wa.height - s.h))
    };
    w.setMinimumSize(s.w, s.h);
    w.setMaximumSize(s.w, s.h);
    w.setBounds({ x: pos.x, y: pos.y, width: s.w, height: s.h });
    petPos = { x: pos.x, y: pos.y };
    return s;
  }

  // ---------------------------------------------------------------- 桌宠
  function createPet() {
    const size = petSize();
    const pos = clampPetPos(readPetPos(), size);
    wins.pet = new BrowserWindow(baseOptions('pet', {
      x: pos.x, y: pos.y, width: size.w, height: size.h,
      minWidth: size.w, minHeight: size.h, maxWidth: size.w, maxHeight: size.h
    }));
    load(wins.pet, 'pet.html', debugQuery());
    forwardLogs(wins.pet, 'pet');
    const pet = wins.pet;
    // moveTop 只调整层级，不抢键盘焦点；同为置顶的其他窗口也可能后来盖住桌宠。
    const keepPetOnTop = () => {
      if (pet.isDestroyed() || !pet.isVisible()) return;
      if (!pet.isAlwaysOnTop()) pet.setAlwaysOnTop(true, 'screen-saver');
      pet.moveTop();
    };
    pet.once('ready-to-show', () => {
      pet.setAlwaysOnTop(true, 'screen-saver');
      pet.showInactive();
      keepPetOnTop();
    });
    pet.on('show', keepPetOnTop);
    pet.on('restore', keepPetOnTop);
    pet.on('blur', keepPetOnTop);
    const topmostTimer = setInterval(keepPetOnTop, 1000);
    topmostTimer.unref();
    pet.once('closed', () => clearInterval(topmostTimer));
    wins.pet.on('move', () => {
      if (!wins.pet || wins.pet.isDestroyed()) return;
      const b = wins.pet.getBounds();
      petPos = { x: b.x, y: b.y };
      const now = petSize();
      if (b.width > now.w + 24 || b.height > now.h + 24) {
        wins.pet.setBounds({ x: b.x, y: b.y, width: now.w, height: now.h });
      }
      if (moveTimers.pet) clearTimeout(moveTimers.pet);
      moveTimers.pet = setTimeout(() => { if (deps.onPetMoved) deps.onPetMoved(petPos); }, 600);
    });
    wins.pet.on('closed', () => { wins.pet = null; if (deps.onPetClosed) deps.onPetClosed(); });
    return wins.pet;
  }

  function defaultPetPos() {
    const wa = screen.getPrimaryDisplay().workArea;
    const s = petSize();
    return { x: wa.x + wa.width - s.w - 36, y: wa.y + wa.height - s.h - 36 };
  }

  function readPetPos() {
    try {
      const s = fs.readFileSync(P.petCfg, 'utf8').split(',');
      const x = parseInt(s[0], 10), y = parseInt(s[1], 10);
      if (!isNaN(x) && !isNaN(y)) return { x: x, y: y };
    } catch (e) { /* 首次运行 */ }
    return defaultPetPos();
  }

  function writePetPos(p) {
    try { fs.writeFileSync(P.petCfg, p.x + ',' + p.y, 'utf8'); } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------- 面板
  function createPanel() {
    const s = SIZES.panel;
    wins.panel = new BrowserWindow(baseOptions('panel', {
      minWidth: s.w, minHeight: s.h, maxWidth: s.w, maxHeight: s.h
    }));
    load(wins.panel, 'popup.html', debugQuery());
    forwardLogs(wins.panel, 'panel');
    wins.panel.on('blur', () => { hide('panel'); });
    wins.panel.on('move', () => {
      if (!wins.panel || wins.panel.isDestroyed() || !wins.panel.isVisible()) return;
      if (moveTimers.panel) clearTimeout(moveTimers.panel);
      moveTimers.panel = setTimeout(() => {
        if (!wins.panel || wins.panel.isDestroyed()) return;
        const b = wins.panel.getBounds();
        try { fs.writeFileSync(P.popupCfg, b.x + ',' + b.y, 'utf8'); } catch (e) { /* ignore */ }
      }, 500);
    });
    return wins.panel;
  }

  // ---------------------------------------------------------------- 助手
  function createAssistant() {
    const s = SIZES.assistant;
    wins.assistant = new BrowserWindow(baseOptions('assistant', {
      minWidth: s.w, minHeight: 560, maxWidth: 1200, maxHeight: 1100, resizable: true, thickFrame: true
    }));
    load(wins.assistant, 'assistant.html', debugQuery());
    forwardLogs(wins.assistant, 'assistant');
    wins.assistant.on('closed', () => { wins.assistant = null; });
    return wins.assistant;
  }

  // ---------------------------------------------------------------- 工具
  function createTool() {
    const s = SIZES.tool;
    wins.tool = new BrowserWindow(baseOptions('tool', {
      minWidth: s.w, minHeight: s.h, maxWidth: s.w, maxHeight: s.h
    }));
    load(wins.tool, 'tool.html', debugQuery());
    forwardLogs(wins.tool, 'tool');
    wins.tool.on('closed', () => { wins.tool = null; });
    return wins.tool;
  }

  // ---------------------------------------------------------------- 形态菜单
  function createMenu() {
    const s = SIZES.menu;
    wins.menu = new BrowserWindow(baseOptions('menu', {
      minWidth: s.w, minHeight: s.h, maxWidth: s.w, maxHeight: s.h
    }));
    load(wins.menu, 'menu.html', debugQuery());
    forwardLogs(wins.menu, 'menu');
    wins.menu.on('blur', () => hide('menu'));
    wins.menu.on('closed', () => { wins.menu = null; });
    return wins.menu;
  }

  // ---------------------------------------------------------------- 设置
  function createSettings() {
    wins.settings = new BrowserWindow(baseOptions('settings', {
      minWidth: 640, minHeight: 480,
      alwaysOnTop: false,
      skipTaskbar: false,
      resizable: true,
      hasShadow: true
    }));
    load(wins.settings, 'settings.html', debugQuery());
    forwardLogs(wins.settings, 'settings');
    wins.settings.on('closed', () => { wins.settings = null; });
    return wins.settings;
  }

  function debugQuery() {
    return process.env.WIDGET_DEBUG === '1' ? { debug: '1' } : undefined;
  }

  // ---------------------------------------------------------------- 通用
  function get(kind) { return wins[kind] && !wins[kind].isDestroyed() ? wins[kind] : null; }

  function ensure(kind) {
    const creators = { pet: createPet, panel: createPanel, assistant: createAssistant, tool: createTool, menu: createMenu, settings: createSettings };
    return get(kind) || (creators[kind] ? creators[kind]() : null);
  }

  function show(kind, opts) {
    const w = ensure(kind);
    if (!w) return null;
    const o = opts || {};
    if (o.place !== false) place(kind);
    w.show();
    if (o.focus !== false) w.focus();
    const pet = get('pet');
    if (pet && pet.isVisible()) pet.moveTop();
    return w;
  }

  function hide(kind) {
    const w = get(kind);
    if (w && w.isVisible()) { w.hide(); if (deps.onHidden) deps.onHidden(kind); }
  }

  function place(kind) {
    const w = get(kind);
    if (!w) return;
    if (kind === 'panel') { placePanel(); return; }
    if (kind === 'settings') { centerWindow(w, SIZES.settings.w, SIZES.settings.h); return; }
    const s = SIZES[kind];
    if (!s) return;
    const size = kind === 'assistant' ? w.getBounds() : s;
    const wa = screen.getPrimaryDisplay().workArea;
    placeNearPet(w, Math.min(size.width || size.w, wa.width - 16), Math.min(size.height || size.h, wa.height - 16));
  }

  function centerWindow(w, width, height) {
    const wa = screen.getPrimaryDisplay().workArea;
    const b = w.getBounds();
    const width2 = Math.max(640, Math.min(b.width || width, wa.width - 40));
    const height2 = Math.max(480, Math.min(b.height || height, wa.height - 40));
    w.setBounds({
      x: Math.round(wa.x + (wa.width - width2) / 2),
      y: Math.round(wa.y + (wa.height - height2) / 2),
      width: width2,
      height: height2
    });
  }

  function petBounds() {
    const w = get('pet');
    const wa = screen.getPrimaryDisplay().workArea;
    if (w) return w.getBounds();
    const s = petSize();
    return { x: wa.x + wa.width - s.w - 60, y: wa.y + wa.height - s.h - 60, width: s.w, height: s.h };
  }

  function placeNearPet(w, width, height) {
    const wa = screen.getPrimaryDisplay().workArea;
    const pb = petBounds();
    let x = Math.round(pb.x + pb.width / 2 - width / 2);
    let y = pb.y - height - 10;
    if (y < wa.y + 8) y = pb.y + pb.height + 10;
    if (y + height > wa.y + wa.height - 8) y = wa.y + wa.height - height - 8;
    x = Math.max(wa.x + 8, Math.min(x, wa.x + wa.width - width - 8));
    w.setBounds({ x: x, y: y, width: width, height: height });
  }

  function placePanel() {
    const w = get('panel');
    if (!w) return;
    const s = SIZES.panel;
    const wa = screen.getPrimaryDisplay().workArea;
    let stored = null;
    try {
      const parts = fs.readFileSync(P.popupCfg, 'utf8').split(',');
      const x = parseInt(parts[0], 10), y = parseInt(parts[1], 10);
      if (!isNaN(x) && !isNaN(y)) stored = { x: x, y: y };
    } catch (e) { /* ignore */ }
    if (stored) {
      w.setBounds({
        x: Math.max(wa.x + 8, Math.min(stored.x, wa.x + wa.width - s.w - 8)),
        y: Math.max(wa.y + 8, Math.min(stored.y, wa.y + wa.height - s.h - 8)),
        width: s.w, height: s.h
      });
      return;
    }
    placeNearPet(w, s.w, s.h);
  }

  function send(kind, channel, payload) {
    const w = get(kind);
    if (w) { try { w.webContents.send(channel, payload); } catch (e) { /* ignore */ } }
  }

  function broadcast(channels, payload) {
    Object.keys(wins).forEach((k) => send(k, channels, payload));
  }

  function allOverlays() {
    return Object.keys(wins).map((k) => wins[k]).filter(Boolean);
  }

  function isFullscreenAppActive() {
    try {
      const d = screen.getPrimaryDisplay();
      return false && d; // 预留：Electron 无法直接判断，交给原生层
    } catch (e) { return false; }
  }

  function dispose() {
    Object.keys(wins).forEach((k) => {
      const w = wins[k];
      if (w && !w.isDestroyed()) { try { w.destroy(); } catch (e) { /* ignore */ } }
    });
  }

  return {
    wins, SIZES, TITLES, auditErrors,
    createPet, createPanel, createAssistant, createTool, createMenu, createSettings,
    get, ensure, show, hide, place, placeNearPet, placePanel, centerWindow,
    send, broadcast, allOverlays, petBounds, petSize, petScale, applyPetScale, writePetPos, defaultPetPos, isFullscreenAppActive, dispose
  };
}

module.exports = { createWindows, SIZES, TITLES };
