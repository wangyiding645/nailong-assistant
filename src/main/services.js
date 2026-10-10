'use strict';
/* 业务服务层：日程、倒数日、专注、记忆、剪贴板历史、提醒引擎、设置、统计
 * 不碰 Electron 窗口，只负责数据与事件，方便单测与复用。
 */

const fs = require('fs');
const path = require('path');

const P = require('./paths.js');
const { createStore } = require('./store.js');
const L = require('../shared/logic.js');
const T = require('../shared/task.js');
const R = require('../shared/repeat.js');
const ST = require('../shared/stats.js');
const PM = require('../shared/pomodoro.js');
const memoryLib = require('./agent/memory.js');
const usageLib = require('./agent/usage.js');

// ------------------------------------------------------------------ 设置

function createSettings() {
  // 迁移过就立刻落盘：只改内存的话文件里一直留着旧值，下次启动又迁一遍（行为对但很难查）
  let migrated = false;
  const store = createStore(P.settings, {
    locale: 'zh-CN',
    theme: 0,
    sound: true,
    autoStart: false,
    startMinimized: false,
    hotkeys: { assistant: 'CommandOrControl+Alt+N', panel: 'CommandOrControl+Alt+Z', focus: 'CommandOrControl+Alt+F' },
    reminder: { preMinutes: 5, catchUpMinutes: 30, dailySummaryAt: '', toast: true, maxSnooze: 3 },
    agent: {
      engine: 'auto',                 // auto | pi | builtin
      piConfig: 'bundled',            // bundled = 用应用自带的 pi 配置；system = 用机器上 pi 自己的配置
      planMode: false,                // 动手前先出计划、让用户确认
      noMcp: false,                   // 关掉 pi 的 MCP 支持
      noSkills: false,                // 关掉 skills 发现
      noContextFiles: false,          // 关掉 AGENTS.md / CLAUDE.md 发现
      skillPaths: [],                 // 额外加载的 skill 文件或目录
      useCustomProvider: true,        // 把奶蛙填的 Base URL 注册成 pi 的 provider
      loadUserExtensions: false,      // 是否连带加载用户自己的 pi 扩展（MCP / 子代理 / 第三方）
      thinking: '',                   // 启动时的思考档位（空 = 跟随 pi）
      autoCompaction: true,
      autoRetry: true,
      contextWindow: 128000,
      disabledTools: {},
      policy: { mode: 'confirm', allow: {}, deny: {}, confirmHighRisk: true, maxSteps: 0 },
      locale: 'zh-CN',
      autoScreenshotEveryAction: true
    },
    pet: { scale: 1, alwaysOnTop: true, hideOnFullscreen: false },
    privacy: { clipboardHistory: true, clipboardLimit: 200, logLevel: 'info' },
    onboardingDone: false
  }, {
    version: 3,
    // v1 → v2：工具调用次数上限从「默认 24 次」改成 0 = 不限次数。
    //          老配置里存着 24 的用户如果只改默认值，升级后还是会被拦在第 24 次 —— 所以直接迁到 0。
    // v2 → v3：「高危操作始终单独确认」以前是写死的（开关是假的、点不动），自动执行模式形同虚设，
    //          而跑命令/删文件/锁屏正好都是高危 —— 于是 agent 根本干不了活。现在默认不强制确认，
    //          开关也能真的关了；危险命令与受保护路径仍然直接拒绝。
    migrate(d) {
      const pol = d && d.agent && d.agent.policy;
      if (pol) {
        if (pol.maxSteps !== 0) { pol.maxSteps = 0; migrated = true; }
        if (pol.confirmHighRisk !== false) { pol.confirmHighRisk = false; migrated = true; }
      }
      return d;
    }
  });
  if (migrated) store.saveNow();

  return {
    store,
    get: () => store.all,
    getKey(k, d) { return store.get(k, d); },
    set(patch) { return store.patch(patch); },
    setKey(k, v) { return store.set(k, v); },
    reminder() { return Object.assign({ preMinutes: 5, catchUpMinutes: 30, dailySummaryAt: '', toast: true, maxSnooze: 3 }, store.get('reminder', {})); },
    agentCfg() {
      return Object.assign({
        engine: 'auto',
        piConfig: 'bundled',
        planMode: false,
        noMcp: false,
        noSkills: false,
        noContextFiles: false,
        skillPaths: [],
        useCustomProvider: true,
        loadUserExtensions: false,
        thinking: '',
        autoCompaction: true,
        autoRetry: true,
        contextWindow: 128000,
        disabledTools: {},
        policy: { mode: 'confirm', allow: {}, deny: {}, confirmHighRisk: true, maxSteps: 0 },
        locale: 'zh-CN'
      }, store.get('agent', {}));
    }
  };
}

// ------------------------------------------------------------------ 日程

function createSchedule(opts) {
  const o = opts || {};
  let cache = null;
  let cacheStamp = 0;

  function readText() {
    try {
      const buf = fs.readFileSync(P.tasks);
      if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
        return buf.toString('utf16le').replace(/^\uFEFF/, '');
      }
      return buf.toString('utf8').replace(/^\uFEFF/, '');
    } catch (e) { return null; }
  }

  function tasks() {
    let stamp = 0;
    try { stamp = fs.statSync(P.tasks).mtimeMs; } catch (e) { stamp = 0; }
    if (cache && stamp === cacheStamp) return cache;
    cache = T.parseTasks(readText() || '');
    cacheStamp = stamp;
    return cache;
  }

  function writeText(text) {
    fs.writeFileSync(P.tasks, String(text), 'utf8');
    cache = null;
    cacheStamp = 0;
    if (o.onChange) o.onChange();
  }

  function saveAll(list) { writeText(T.serializeTasks(list)); }

  function add(task) {
    const list = tasks().slice();
    const t = Object.assign({ date: '', time: '', text: '' }, task);
    if (!t.time) throw new Error('日程必须有时间');
    if (t.repeat && !t.date) { t.date = L.todayStr(); }
    list.push(t);
    list.sort(T.byWhen);
    saveAll(list);
    return t;
  }

  function remove(pred) {
    const before = tasks();
    const list = before.filter((t) => !pred(t));
    saveAll(list);
    return before.length - list.length;
  }

  function update(task, patch) {
    const list = tasks().slice();
    const i = list.indexOf(task);
    if (i < 0) return null;
    list[i] = Object.assign({}, task, patch);
    list.sort(T.byWhen);
    saveAll(list);
    return list[i];
  }

  function doneMap() { return o.state().done || {}; }

  function toggleDone(date, key, undo) {
    const st = o.state();
    const day = st.done[date] || (st.done[date] = []);
    const i = day.indexOf(key);
    const wantDone = !undo;
    if (wantDone && i < 0) day.push(key);
    if (!wantDone && i >= 0) day.splice(i, 1);
    if (day.length === 0) delete st.done[date];
    const items = T.itemsOn(tasks(), date);
    const doneNow = st.done[date] || [];
    const complete = items.length > 0 && items.every((t) => doneNow.indexOf(T.keyOf(t)) >= 0);
    const cd = {};
    (st.completedDays || []).forEach((d) => { cd[d] = true; });
    let becameComplete = false;
    if (complete) { if (!cd[date]) becameComplete = true; cd[date] = true; } else { delete cd[date]; }
    st.completedDays = Object.keys(cd).sort();
    o.saveState();
    return { complete, becameComplete };
  }

  function progress(date) { return ST.dayProgress(tasks(), doneMap(), date || L.todayStr()); }

  return { readText, tasks, writeText, saveAll, add, remove, update, doneMap, toggleDone, progress, invalidate() { cache = null; } };
}

// ------------------------------------------------------------------ 倒数日

function createCountdown(opts) {
  const o = opts || {};
  function readText() {
    try { return fs.readFileSync(P.countdown, 'utf8').replace(/^\uFEFF/, ''); } catch (e) { return ''; }
  }
  function writeText(text) {
    fs.writeFileSync(P.countdown, String(text), 'utf8');
    if (o.onChange) o.onChange();
  }
  function list() { return L.parseCountdown(readText()); }
  function add(date, text) {
    const l = list().filter((x) => !(x.date === date && x.text === text));
    l.push({ date: date, text: text });
    l.sort((a, b) => (a.date < b.date ? -1 : 1));
    writeText(L.serializeCountdown(l));
    return l;
  }
  function remove(date, text) {
    const l = list().filter((x) => !(x.date === date && x.text === text));
    writeText(L.serializeCountdown(l));
    return l;
  }
  return { readText, writeText, list, add, remove };
}

// ------------------------------------------------------------------ 专注 / 番茄钟

function createFocus(opts) {
  const o = opts || {};
  const store = createStore(P.focus, { sessions: [], config: PM.DEFAULTS, today: { day: '', count: 0, minutes: 0 } }, { version: 1 });
  let state = PM.createState(store.get('config'));

  function emit() { if (o.onChange) o.onChange(state); }

  function config() { return store.get('config'); }

  function start(minutes, label) {
    const cfg = store.get('config');
    if (minutes) { store.set('config', Object.assign({}, cfg, { focusMin: Math.max(1, Math.min(600, Number(minutes) || 25)) })); }
    state = PM.start(PM.createState(store.get('config')), Date.now(), label || '');
    emit();
    return state;
  }

  function stop() { state = PM.stop(state); emit(); return state; }
  function pause() { const r = PM.pause(state, Date.now()); state = r.state; emit(); return state; }
  function resume() { const r = PM.resume(state, Date.now()); state = r.state; emit(); return state; }
  function skip() { state = PM.skip(state, Date.now()); emit(); return state; }

  function recordFocus(ms, label) {
    const now = new Date();
    const day = L.todayStr(now);
    const sessions = store.get('sessions', []).slice(-499);
    sessions.push({ at: now.getTime(), day: day, ms: ms, label: label || '', min: Math.round(ms / 60000) });
    store.set('sessions', sessions);
    const t = store.get('today', { day: '', count: 0, minutes: 0 });
    if (t.day !== day) { t.day = day; t.count = 0; t.minutes = 0; }
    t.count += 1;
    t.minutes += Math.round(ms / 60000);
    store.set('today', t);
  }

  /** 每秒调用；返回事件 'focus-done' | 'break-done' | null */
  function tick(now) {
    if (state.phase === 'idle' || state.phase === 'paused') return null;
    const prevEnd = state.endsAt;
    const r = PM.tick(state, now);
    state = r.state;
    if (r.event) {
      if (r.event === 'focus-done') { recordFocus(now - prevEnd + state.config.focusMin * 60000, state.label); }
      emit();
    } else if (o.onTick) {
      o.onTick(state);
    }
    return r.event;
  }

  function summarize() { return PM.summarize(store.get('sessions', []), L.todayStr()); }

  return {
    store, start, stop, pause, resume, skip, tick, emit, config, summarize,
    get state() { return state; },
    status() {
      const s = state;
      const sum = summarize();
      return {
        phase: s.phase, label: PM.phaseLabel(s), endsAt: s.endsAt,
        remainMs: PM.remainMs(s, Date.now()), progress: PM.progress(s, Date.now()),
        completedFocus: s.completedFocus, cycle: s.cycle,
        todayMinutes: sum.todayMin, todayCount: sum.todayCount, totalMinutes: sum.totalMin,
        config: s.config
      };
    },
    setConfig(patch) {
      store.set('config', PM.normalizeConfig(Object.assign({}, store.get('config'), patch)));
      state.config = store.get('config');
      return state.config;
    },
    sessions: () => store.get('sessions', [])
  };
}

// ------------------------------------------------------------------ 记忆

function createMemory() {
  const store = createStore(P.memory, { list: [] }, { version: 1 });
  return {
    store,
    list: () => memoryLib.normalize(store.get('list', [])),
    add(text, tag) { store.set('list', memoryLib.add(store.get('list', []), { text: text, tag: tag })); return this.list(); },
    remove(id) { store.set('list', memoryLib.remove(store.get('list', []), id)); return this.list(); },
    clear() { store.set('list', []); return []; },
    search(q, limit) { return memoryLib.search(store.get('list', []), q, limit); },
    promptBlock: () => memoryLib.toPromptBlock(store.get('list', []))
  };
}

// ------------------------------------------------------------------ 剪贴板历史

function createClipboardHistory(opts) {
  const o = opts || {};
  const store = createStore(P.clipboard, { items: [], seen: '' }, { version: 1 });
  let last = '';

  function limit() { return Math.max(20, Math.min(1000, (o.limit && o.limit()) || 200)); }

  function push(text) {
    const t = String(text || '');
    if (!t.trim() || t.length > 20000) return false;
    if (t === last) return false;
    last = t;
    const items = store.get('items', []).slice();
    const sig = t.slice(0, 400);
    const dup = items.findIndex((x) => x.sig === sig);
    if (dup >= 0) items.splice(dup, 1);
    items.push({ at: Date.now(), text: t.slice(0, 8000), sig: sig, len: t.length });
    while (items.length > limit()) items.shift();
    store.set('items', items);
    if (o.onChange) o.onChange(items.length);
    return true;
  }

  function history(query, n) {
    let items = store.get('items', []).slice().reverse();
    const q = String(query || '').toLowerCase();
    if (q) items = items.filter((x) => x.text.toLowerCase().indexOf(q) >= 0);
    return items.slice(0, n || 10);
  }

  return { store, push, history, clear() { store.set('items', []); }, all: () => store.get('items', []), setLast(v) { last = v; } };
}

// ------------------------------------------------------------------ 统计

function createStats(deps) {
  return {
    today() {
      const tasks = deps.schedule.tasks();
      const done = deps.schedule.doneMap();
      const p = ST.todayProgress(tasks, done);
      const state = deps.state();
      const f = deps.focus.summarize();
      return {
        day: L.todayStr(),
        tasksTotal: p.total, tasksDone: p.done, pct: p.pct,
        streak: ST.streak(state.completedDays),
        longestStreak: ST.longestStreak(state.completedDays),
        focusCount: f.todayCount, focusMinutes: f.todayMin,
        heatmap: ST.heatmap(tasks, done, 21)
      };
    },
    range(days) {
      const tasks = deps.schedule.tasks();
      const done = deps.schedule.doneMap();
      const state = deps.state();
      const f = deps.focus.summarize();
      return {
        days: days,
        summary: ST.windowSummary(tasks, done, days),
        streak: ST.streak(state.completedDays),
        longest: ST.longestStreak(state.completedDays),
        tags: ST.byTag(tasks, done, days),
        hours: ST.byHour(tasks, done, days),
        focusCount: f.totalCount,
        focusMinutes: f.totalMin,
        heatmap: ST.heatmap(tasks, done, days)
      };
    },
    usage: () => usageLib.byDay(deps.usageRecords ? deps.usageRecords() : [])
  };
}

// ------------------------------------------------------------------ 提醒引擎

function createReminderEngine(opts) {
  const o = opts || {};
  // fired: { 'YYYY-MM-DD HH:MM|text@HH:MM': true }  snoozed: { key: ts }
  const store = createStore(P.reminders, { fired: {}, snoozed: {}, missedSeen: {} }, { version: 1 });
  let lastDay = '';

  function prune() {
    const fired = store.get('fired', {});
    const days = Object.keys(fired).map((k) => k.slice(0, 10)).sort();
    if (days.length > 8) {
      const cutoff = days[days.length - 8];
      const next = {};
      Object.keys(fired).forEach((k) => { if (k.slice(0, 10) >= cutoff) next[k] = fired[k]; });
      store.set('fired', next);
    }
    const sn = store.get('snoozed', {});
    const now = Date.now();
    Object.keys(sn).forEach((k) => { if (sn[k] < now - 86400000) delete sn[k]; });
    store.set('snoozed', sn);
  }

  function snooze(key, minutes) {
    const sn = store.get('snoozed', {});
    sn[key] = Date.now() + Math.max(1, minutes) * 60000;
    store.set('snoozed', sn);
    return sn[key];
  }

  function clearSnooze(key) {
    const sn = store.get('snoozed', {});
    delete sn[key];
    store.set('snoozed', sn);
  }

  function snoozeInfo(key) {
    const sn = store.get('snoozed', {});
    return sn[key] || 0;
  }

  /** 每次 tick 检查；回调 (task, kind)，kind = 'pre' | 'due' | 'missed' | 'summary' */
  function tick(nowMs) {
    const now = new Date(nowMs);
    const today = L.todayStr(now);
    const hm = L.pad2(now.getHours()) + ':' + L.pad2(now.getMinutes());
    const cfg = o.settings.reminder();
    const tasks = o.schedule.tasks();
    const items = T.itemsOn(tasks, today);
    const fired = store.get('fired', {});

    if (today !== lastDay) {
      lastDay = today;
      prune();
      if (cfg.dailySummaryAt && cfg.dailySummaryAt === hm) {
        const p = o.schedule.progress(today);
        o.onReminder({ kind: 'summary', text: '今天有 ' + p.total + ' 条日程，已完成 ' + p.done + ' 条' }, nowMs);
        fired['summary:' + today] = true;
        store.set('fired', fired);
      }
    }

    items.forEach((t) => {
      const key = L.todayStr(now) + ' ' + T.keyOf(t);
      const tMin = L.hm2min(t.time);
      const nowMin = L.hm2min(hm);
      const snoozeAt = snoozeInfo(key);

      if (snoozeAt) {
        if (nowMs >= snoozeAt) {
          clearSnooze(key);
          fired[key + '@snooze' + snoozeAt] = true;
          store.set('fired', fired);
          o.onReminder({ kind: 'due', task: t, key: key, snoozed: true }, nowMs);
        }
        return;
      }

      const preMin = t.alarm !== undefined ? t.alarm : cfg.preMinutes;
      if (preMin > 0 && !fired[key + '@pre'] && nowMin >= tMin - preMin && nowMin < tMin) {
        fired[key + '@pre'] = true;
        store.set('fired', fired);
        o.onReminder({ kind: 'pre', task: t, key: key, minutes: tMin - nowMin }, nowMs);
        return;
      }
      if (!fired[key] && nowMin >= tMin) {
        fired[key] = true;
        store.set('fired', fired);
        const late = nowMin - tMin;
        o.onReminder({ kind: late > 1 ? 'missed' : 'due', task: t, key: key, lateMin: late }, nowMs);
      }
    });
  }

  function markAllTodaySeen(nowMs) {
    const today = L.todayStr(new Date(nowMs));
    const fired = store.get('fired', {});
    T.itemsOn(o.schedule.tasks(), today).forEach((t) => {
      const key = today + ' ' + T.keyOf(t);
      if (!fired[key] && L.hm2min(t.time) <= L.hm2min(L.pad2(new Date(nowMs).getHours()) + ':' + L.pad2(new Date(nowMs).getMinutes()))) {
        fired[key] = true;
      }
    });
    store.set('fired', fired);
  }

  return { tick, snooze, clearSnooze, snoozeInfo, store, prune, markAllTodaySeen, firedMap: () => store.get('fired', {}) };
}

// ------------------------------------------------------------------ 汇总

function createServices(opts) {
  const o = opts || {};
  const settings = createSettings();

  // v2 state.json：done / completedDays / settings.sound
  const stateStore = createStore(P.state, { done: {}, completedDays: [], settings: { sound: true } }, { version: 1 });
  function stateObj() {
    const s = stateStore.all;
    if (!s.done || typeof s.done !== 'object') s.done = {};
    if (!Array.isArray(s.completedDays)) s.completedDays = [];
    if (!s.settings || typeof s.settings !== 'object') s.settings = { sound: true };
    if (typeof s.settings.sound !== 'boolean') s.settings.sound = true;
    return s;
  }
  stateObj();
  const saveState = () => { stateStore.saveNow(); if (o.onStateChange) o.onStateChange(stateObj()); };

  const schedule = createSchedule({ state: stateObj, saveState, onChange: () => { if (o.onScheduleChange) o.onScheduleChange(); } });
  const countdown = createCountdown({ onChange: () => { if (o.onCountdownChange) o.onCountdownChange(); } });
  const focus = createFocus({ onChange: (s) => { if (o.onFocusChange) o.onFocusChange(s); } });
  const memory = createMemory();
  const clipboard = createClipboardHistory({ limit: () => settings.getKey('privacy', {}).clipboardLimit });
  const notify = {
    show(title, body) { if (o.onNotify) o.onNotify(String(title || ''), String(body || '')); }
  };

  const stats = createStats({ schedule, state: stateObj, focus });

  const reminders = createReminderEngine({
    settings, schedule,
    onReminder: (r, now) => { if (o.onReminder) o.onReminder(r, now); }
  });

  return {
    settings, stateStore, stateObj, saveState,
    schedule, countdown, focus, memory, clipboard, notify, stats, reminders,
    streak: () => ST.streak(stateObj().completedDays),
    dispose() {
      [settings.store, stateStore, focus.store, memory.store, clipboard.store, reminders.store].forEach((s) => {
        try { s.dispose(); } catch (e) { /* ignore */ }
      });
    }
  };
}

module.exports = {
  createSettings, createSchedule, createCountdown, createFocus, createMemory,
  createClipboardHistory, createStats, createReminderEngine, createServices
};
