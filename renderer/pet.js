'use strict';
/* 桌宠渲染层：动画状态机 + 气泡 + 拖动 + 形态联动 */

const L = window.WidgetLogic;
const T = window.WidgetTask;
const R = window.WidgetRepeat;
const $ = (id) => document.getElementById(id);
const api = window.widget;
const I = window.WidgetI18n || { t: (k, v) => { let s = String(k); if (v) Object.keys(v).forEach((x) => { s = s.split('{' + x + '}').join(String(v[x])); }); return s; }, setLocale() {}, applyDom() {} };

const ANIM = {
  idle: { row: 0, frames: 6, fps: 5 },
  waving: { row: 3, frames: 4, fps: 8 },
  jumping: { row: 4, frames: 5, fps: 7 },
  waiting: { row: 6, frames: 6, fps: 5 },
  failed: { row: 5, frames: 8, fps: 8 },
  'running-left': { row: 2, frames: 8, fps: 10 },
  'running-right': { row: 1, frames: 8, fps: 10 },
  work: { work: true, frames: 8, fps: 6 }
};
const WORK_IMG = '../assets/naifrog/work/coding-strip.png';
const WORK_COLS = 4;

const state = {
  allItems: [],
  items: [],
  countdown: [],
  settings: { sound: true },
  popupOpen: false,
  assistantOpen: false,
  actionLaugh: 0,
  mode: 'normal',
  cd: null,
  alarm: null,
  coin: { a: '', b: '' },
  coinSpin: 0,
  ping: null,
  alarmLoop: null,
  reminder: null,
  pre: null,
  celebrate: null,
  fired: {},
  preFired: {},
  cycleIdx: 0,
  hover: false,
  dragging: false,
  dragDir: 'running-right',
  lastBubbleKey: null,
  forceAnim: null,
  catchOn: false,
  catchDir: 'running-right',
  catchStartAt: 0,
  ask: null,
  dragHint: false,
  walkDir: null,
  focus: null
};

let animName = 'idle';
let catchTick = null;
let frameIdx = 0;
let lastFrameAt = 0;
let lastRenderedDay = L.todayStr();

function setAnim(name) {
  if (!ANIM[name] || name === animName) return;
  animName = name;
  frameIdx = 0;
}

function drawFrame() {
  const pet = $('pet');
  const a = ANIM[animName];
  if (!a) return;
  if (a.work) {
    pet.style.backgroundImage = 'url("' + WORK_IMG + '")';
    pet.style.backgroundSize = '384px 208px';
    pet.style.backgroundPosition = (-(frameIdx % WORK_COLS) * 96) + 'px ' + (-Math.floor(frameIdx / WORK_COLS) * 104) + 'px';
    return;
  }
  if (pet.style.backgroundImage.indexOf('coding-strip') >= 0) pet.style.backgroundImage = '';
  pet.style.backgroundSize = '768px 936px';
  pet.style.backgroundPosition = (-frameIdx * 96) + 'px ' + (-a.row * 104) + 'px';
}

function animLoop(t) {
  const a = ANIM[animName];
  if (!a) return;
  if (t - lastFrameAt > 1000 / a.fps) {
    lastFrameAt = t;
    frameIdx = (frameIdx + 1) % a.frames;
    drawFrame();
  }
}

function currentAnim() {
  if (state.forceAnim) return state.forceAnim;
  if (state.catchOn) {
    if (Date.now() - state.catchStartAt < 900) return 'jumping';
    return state.catchDir === 'running-left' ? 'running-left' : 'running-right';
  }
  if (state.walkDir) return state.walkDir;
  if (state.reminder || state.celebrate) return 'jumping';
  if (state.mode === 'coin' && Date.now() < state.coinSpin) return 'jumping';
  if (state.ping && state.ping.anim && Date.now() < state.ping.until) return state.ping.anim;
  // 闹钟响着就必须跳：这条要在形态判断前面，否则开助手时闹钟只是在响、角色没反应
  if (state.alarm && state.alarm.ringing) return 'jumping';
  if (state.mode === 'assistant' && Date.now() < state.actionLaugh) return 'jumping';
  if (state.mode === 'assistant') return 'work';
  if (state.mode === 'focus' && state.focus && state.focus.phase === 'short') return 'jumping';
  if (state.mode === 'focus' && state.focus && state.focus.phase === 'focus') return 'work';
  if (state.cd) return 'waiting';
  if (state.pre) return 'waving';
  if (state.dragging) return state.dragDir;
  if (state.popupOpen) return 'waiting';
  if (state.hover) return 'waving';
  return 'idle';
}

// ---------------------------------------------------------------- 声音
// 欢迎使用安迪音频；提醒和小游戏使用原版大笑。
const A = window.WidgetAudio;

if (A) {
  // 第一次交互时解锁音频管线（某些机器/策略下 AudioContext 会一直 suspended）
  const unlock = () => { try { A.unlock(); } catch (e) { /* ignore */ } };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });
  setTimeout(unlock, 800);
}

function audioEnabled() {
  return !!(state.settings && state.settings.sound);
}

function playPreReminder() {
  if (!A || !audioEnabled()) return;
  A.play('pre');
}

const playFire = () => { if (A && audioEnabled()) A.play('remind'); };
const synthHappy = () => { if (A && audioEnabled()) A.playSynth('happy', 1); };
const coinDing = () => { if (A && audioEnabled()) A.play('coin'); };
const timerEnd = () => { if (A && audioEnabled()) A.play('timerEnd'); };

function alarmRingStart() {
  if (!audioEnabled() || state.alarmLoop) return;
  if (A) A.play('alarm');
  state.alarmLoop = setInterval(() => { if (A && audioEnabled()) A.play('alarm'); }, 900);
}
function alarmRingStop() {
  if (state.alarmLoop) { clearInterval(state.alarmLoop); state.alarmLoop = null; }
  if (A) A.stop();
}

// 提醒和互动使用大笑，欢迎音效只在启动和打开助手时播放。
function playHappy(vol) {
  if (!audioEnabled() || !A) return;
  A.setEnabled(true);
  A.play('happy', typeof vol === 'number' ? vol : 1);
}

function bounce() {
  const pet = $('pet');
  pet.classList.add('bounce');
  setTimeout(() => pet.classList.remove('bounce'), 1100);
}
function spinPet(ms) {
  const pet = $('pet');
  pet.classList.remove('spin');
  void pet.offsetWidth;
  pet.classList.add('spin');
  setTimeout(() => pet.classList.remove('spin'), ms || 950);
}

// ---------------------------------------------------------------- 气泡
const baseName = (p) => { const s = String(p).split(/[\\/]/); return s[s.length - 1] || String(p); };

function askRecycle(paths) {
  if (!paths || !paths.length) return;
  state.ask = { paths: paths.slice(), until: Date.now() + 45000, result: '' };
  state.lastBubbleKey = null;
  renderBubble();
}

async function confirmRecycle() {
  const ask = state.ask;
  if (!ask || ask.result === 'busy') return;
  ask.result = 'busy';
  state.lastBubbleKey = null;
  renderBubble();
  let res = null;
  try { res = await api.recyclePaths(ask.paths); } catch (e) { res = null; }
  const ok = (res && res.ok) || 0;
  const fail = (res && typeof res.fail === 'number') ? res.fail : (ask.paths.length - ok);
  state.ask = null;
  if (ok > 0) { spinPet(1100); playHappy(0.95); api.petGrow().catch(() => {}); }
  if (ok > 0 && fail === 0) state.ping = { text: '🗑️ ' + I.t('pet.recycleOk', { n: ok }), anim: 'jumping', until: Date.now() + 8000 };
  else if (ok > 0) state.ping = { text: '🗑️ ' + I.t('pet.recyclePart', { n: ok, fail: fail }), anim: 'jumping', until: Date.now() + 8000 };
  else state.ping = { text: '⚠ ' + I.t('pet.recycleFail') + (res && res.err ? '：' + res.err : ''), until: Date.now() + 8000 };
  state.lastBubbleKey = null;
  renderBubble();
  api.askDone();
}

function doCoinFlip() {
  state.coinSpin = Date.now() + 900;
  spinPet(950);
  const a = (state.coin.a || '').trim();
  const b = (state.coin.b || '').trim();
  const head = Math.random() < 0.5;
  const res = (a && b) ? (head ? a : b) : (head ? '正面' : '反面');
  setTimeout(() => {
    coinDing();
    state.ping = { text: '🪙 ' + res, anim: 'jumping', until: Date.now() + 9000 };
    state.lastBubbleKey = null;
    bounce();
    api.petEvent({ type: 'coin-result', result: res });
    renderBubble();
    renderChip();
  }, 860);
}

function dismissCountdown() {
  if (state.cd && state.cd.done) {
    state.cd = null; state.ping = null; state.lastBubbleKey = null;
    renderBubble(); renderChip();
  }
}

function dismissAlarm() {
  if (state.alarm && state.alarm.ringing) {
    alarmRingStop();
    state.alarm = null; state.ping = null; state.lastBubbleKey = null;
    api.petEvent({ type: 'alarm-stopped' });
    renderBubble(); renderChip();
  }
}

// 闹钟响着、或倒计时已到点：不管此刻是什么形态，点一下就该停
function dismissPending() {
  if (state.alarm && state.alarm.ringing) { dismissAlarm(); return true; }
  if (state.cd && state.cd.done) { dismissCountdown(); return true; }
  return false;
}

// 体型：整个界面按倍率整体缩放（窗口大小由主进程按同样的倍率同步）
function applyPetZoom(scale) {
  const sc = Math.max(0.1, Math.min(10, Number(scale) || 1));
  document.body.style.zoom = String(sc);
}

function refreshToday() {
  const today = L.todayStr();
  state.items = T.itemsOn(state.allItems, today);
  if (state.cycleIdx >= Math.max(1, state.items.length)) state.cycleIdx = 0;
  state.lastBubbleKey = null;
}

function fmtMs(ms) {
  if (ms < 0) ms = 0;
  const t = Math.ceil(ms / 1000);
  return L.pad2(Math.floor(t / 60)) + ':' + L.pad2(t % 60);
}

function renderBubble() {
  const bubble = $('bubble');
  if (state.catchOn || state.walkDir) {
    if (bubble.className !== '') { bubble.className = ''; bubble.innerHTML = ''; }
    state.lastBubbleKey = null;
    return;
  }
  let key = '';
  let html = '';
  let flash = false;

  if (state.ask) {
    const ps = state.ask.paths;
    const raw = baseName(ps[0]);
    const nm = raw.length > 12 ? raw.slice(0, 11) + '…' : raw;
    const label = ps.length === 1 ? nm : I.t('pet.recycleMulti', { name: nm, n: ps.length });
    key = 'ask:' + ps.join('|') + ':' + state.ask.result;
    if (state.ask.result === 'busy') html = '<div class="bi"><span class="x">🗑️ ' + I.t('pet.recycling') + '</span></div>';
    else html = '<div class="bi"><span class="x">' + L.esc(I.t('pet.recycleAsk', { name: label })) + '</span></div>'
      + '<div class="askbtns"><div class="ab yes" data-act="recycle">' + I.t('pet.recycle') + '</div><div class="ab" data-act="cancel">' + I.t('common.cancel') + '</div></div>';
  } else if (state.dragHint) {
    key = 'draghint';
    html = '<div class="bi"><span class="x">' + I.t('pet.dropHint') + '</span></div>';
  } else if (state.ping && state.ping.source === 'catch' && Date.now() < state.ping.until) {
    key = 'catch-result:' + state.ping.text;
    html = '<div class="bi"><span class="x">' + L.esc(state.ping.text) + '</span></div>';
  } else if (state.celebrate) {
    key = 'celeb';
    html = '<div class="bi"><span class="x">' + I.t('pet.allDone') + '</span></div>';
  } else if (state.reminder) {
    key = 'r:' + state.reminder.key;
    flash = state.reminder.kind === 'due' || state.reminder.kind === 'missed';
    const label = state.reminder.kind === 'pre'
      ? L.esc(I.t('pet.soon', { n: state.reminder.minutes, text: state.reminder.text }))
      : (state.reminder.kind === 'missed' ? L.esc(I.t('pet.missed', { time: state.reminder.time, text: state.reminder.text }))
        : L.esc(I.t('pet.dueTodo', { text: state.reminder.text })));
    html = '<div class="bi now"><span class="t">' + L.esc(state.reminder.time || '') + '</span><span class="x">' + label + '</span></div>';
    if (state.reminder.key) {
      html += '<div class="askbtns"><div class="ab go" data-act="snooze">' + I.t('pet.snooze10') + '</div>'
        + '<div class="ab" data-act="done">' + I.t('pet.markDone') + '</div></div>';
    }
  } else if (state.ping && Date.now() < state.ping.until) {
    key = 'ping:' + state.ping.text;
    html = '<div class="bi"><span class="x">' + L.esc(state.ping.text) + '</span></div>';
  } else if (state.pre) {
    key = 'p:' + state.pre.key;
    html = '<div class="bi"><span class="x">5 分钟后：' + L.esc(state.pre.text) + '</span></div>';
  } else if (state.cd && (state.cd.done || state.mode === 'countdown')) {
    const left = state.cd.endAt - Date.now();
    key = 'cdn:' + (state.cd.done ? 'done' : Math.ceil(Math.max(0, left) / 1000));
    html = '<div class="bi now"><span class="t">⏳</span><span class="x">'
      + (state.cd.done ? I.t('pet.timeUp') : fmtMs(left)) + '</span></div>';
  } else if (state.alarm && (state.alarm.ringing || state.mode === 'alarm')) {
    key = 'alm:' + state.alarm.hm + (state.alarm.ringing ? ':on' : '');
    flash = !!state.alarm.ringing;
    html = '<div class="bi"><span class="t">⏰</span><span class="x">'
      + (state.alarm.ringing ? I.t('pet.alarmRing') : I.t('pet.alarmAt', { hm: state.alarm.hm })) + '</span></div>';
  } else if (state.hover) {
    key = 'h:' + state.items.map(T.keyOf).join(';');
    if (!state.items.length) html = '<div class="bi"><span class="x">' + I.t('pet.noSchedule') + '</span></div>';
    else {
      const max = 6;
      html = state.items.slice(0, max).map((it) => '<div class="bi"><span class="t">' + L.esc(it.time) + '</span><span class="x">' + L.esc(it.text) + '</span></div>').join('');
      if (state.items.length > max) html += '<div class="more">' + I.t('pet.more', { n: state.items.length }) + '</div>';
    }
  } else {
    const cds = L.nextCountdowns(state.countdown, null, 5);
    const showCd = cds.length > 0 && (state.cycleIdx % 5 === 4 || state.items.length === 0);
    if (state.mode === 'focus' && state.focus && state.focus.phase !== 'idle') {
      key = 'focus';
      html = '<div class="bi now"><span class="t">🍅</span><span class="x">' + L.esc(state.focus.label) + ' ' + fmtMs(state.focus.remainMs) + '</span></div>';
    } else if (state.assistantOpen && state.cycleIdx % 3 === 0) {
      key = 'asst';
      html = '<div class="bi"><span class="x">' + I.t('pet.assistantIdle') + '</span></div>';
    } else if (showCd) {
      const cd = cds[0];
      key = 'cd:' + cd.date + ':' + cd.text;
      html = '<div class="bi"><span class="t">' + (cd.days === 0 ? I.t('pet.today') : I.t('pet.days', { n: cd.days })) + '</span><span class="x">' + L.esc(cd.text) + '</span></div>';
    } else if (state.items.length) {
      const it = state.items[state.cycleIdx % state.items.length];
      key = 'c:' + T.keyOf(it);
      html = '<div class="bi"><span class="t">' + L.esc(it.time) + '</span><span class="x">' + L.esc(it.text) + '</span></div>';
    } else {
      key = 'empty';
      html = '<div class="bi"><span class="x">' + I.t('pet.noSchedule') + '</span></div>';
    }
  }

  if (key === state.lastBubbleKey && !flash) return;
  state.lastBubbleKey = key;
  let cls = 'show';
  if (flash) cls += ' flash';
  if (state.dragHint && !state.ask) cls += ' drop-hint';
  bubble.className = cls;
  bubble.innerHTML = html;
}

function renderChip() {
  const chip = $('chip');
  let txt = '';
  let hot = false;
  if (state.catchOn) {
    chip.className = 'show hot';
    chip.innerHTML = '<span class="m">🏃 ' + I.t('pet.catching', { sec: (Math.max(0, Date.now() - state.catchStartAt - 900) / 1000).toFixed(1) }) + '</span>';
    return;
  }
  if (state.mode === 'focus' && state.focus && state.focus.phase !== 'idle') {
    const left = state.focus.phase === 'focus' ? state.focus.remainMs : 0;
    txt = (state.focus.phase === 'focus' ? '🍅 ' : '☕ ') + fmtMs(state.focus.remainMs)
      + (state.focus.todayCount ? ' · 今日 ' + state.focus.todayCount : '');
    if (state.focus.phase === 'focus' && left <= 0) hot = true;
  } else if (state.cd) {
    const left = state.cd.endAt - Date.now();
    txt = '⏳ ' + fmtMs(left);
    if (left <= 0) hot = true;
  } else if (state.alarm) {
    txt = '⏰ ' + state.alarm.hm + (state.alarm.ringing ? ' !' : '');
    hot = !!state.alarm.ringing;
  } else if (state.mode === 'coin') {
    txt = '🪙 ' + I.t('tool.coinGo');
  } else if (state.mode === 'assistant') {
    txt = '🤖 ' + I.t('menu.assistant');
  }
  if (!txt) { chip.className = ''; chip.innerHTML = ''; return; }
  chip.className = hot ? 'show hot' : 'show';
  chip.innerHTML = '<span class="m">' + txt + '</span>';
}

// ---------------------------------------------------------------- 主循环
function tick() {
  const now = new Date();
  const hm = L.pad2(now.getHours()) + ':' + L.pad2(now.getMinutes());
  const today = L.todayStr();
  if (today !== lastRenderedDay) { lastRenderedDay = today; refreshToday(); }
  const in5 = new Date(now.getTime() + 5 * 60000);
  const hm5 = L.pad2(in5.getHours()) + ':' + L.pad2(in5.getMinutes());

  for (const it of state.items) {
    const k = T.keyOf(it);
    if (it.time === hm && state.fired[k] !== today && !it.repeat) {
      state.fired[k] = today;
      state.reminder = { key: k, time: it.time, text: it.text, kind: 'due', until: Date.now() + 60000 };
      state.lastBubbleKey = null;
      playFire();
      break;
    }
  }
  if (!state.reminder) {
    for (const it of state.items) {
      const k = T.keyOf(it);
      if (it.time === hm5 && state.preFired[k] !== today && state.fired[k] !== today && !state.reminder) {
        state.preFired[k] = today;
        state.pre = { key: k, text: it.text, until: Date.now() + 8000 };
        state.lastBubbleKey = null;
        bounce();
        break;
      }
    }
  }
  if (state.reminder && Date.now() > state.reminder.until && state.reminder.kind === 'pre') { state.reminder = null; state.lastBubbleKey = null; }
  if (state.pre && Date.now() > state.pre.until) { state.pre = null; state.lastBubbleKey = null; }
  if (state.celebrate && Date.now() > state.celebrate.until) { state.celebrate = null; state.lastBubbleKey = null; }
  if (state.ping && Date.now() > state.ping.until) { state.ping = null; state.lastBubbleKey = null; }
  if (state.ask && !state.ask.result && Date.now() > state.ask.until) { state.ask = null; state.lastBubbleKey = null; api.askDone(); }

  if (state.cd && !state.cd.done && Date.now() >= state.cd.endAt) {
    state.cd.done = true;
    timerEnd();
    state.ping = { text: '⏳ ' + I.t('pet.timeUp'), anim: 'jumping', until: Date.now() + 20000 };
    state.lastBubbleKey = null;
    bounce();
    api.petEvent({ type: 'countdown-done' });
  }

  if (state.alarm && state.alarm.hm === hm && !state.alarm.fired) {
    state.alarm.fired = true;
    state.alarm.ringing = true;
    alarmRingStart();
    state.ping = { text: '⏰ ' + I.t('pet.alarmAt', { hm: state.alarm.hm }), anim: 'jumping', until: Date.now() + 60000 };
    state.lastBubbleKey = null;
    bounce();
    api.petEvent({ type: 'alarm-ring' });
  }

  renderBubble();
  renderChip();
}

function setTasks(text) {
  state.allItems = T.parseTasks(text || '');
  refreshToday();
  renderBubble();
}
function setCountdown(text) {
  state.countdown = L.parseCountdown(text || '');
  state.lastBubbleKey = null;
  renderBubble();
}
function applyTheme(t) { document.body.className = 't' + (Number(t) || 0); }

function hitTest(e) {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  if (!el) return false;
  return $('pet').contains(el) || $('bubble').contains(el);
}

// ---------------------------------------------------------------- 拖动 / 点击
const drag = { active: false, moved: false, lastX: 0, lastY: 0, acc: 0 };

$('pet').addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (state.catchOn) { api.petEvent({ type: 'catch-hit' }); return; }
  drag.active = true;
  drag.moved = false;
  drag.acc = 0;
  drag.lastX = e.screenX;
  drag.lastY = e.screenY;
  state.dragging = false;
  try { $('pet').setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
});

$('pet').addEventListener('pointermove', (e) => {
  if (!drag.active) return;
  const dx = e.screenX - drag.lastX;
  const dy = e.screenY - drag.lastY;
  if (!drag.moved && (Math.abs(dx) + Math.abs(dy) > 3)) { drag.moved = true; state.dragging = true; }
  if (drag.moved) {
    drag.lastX = e.screenX;
    drag.lastY = e.screenY;
    drag.acc = drag.acc * 0.7 + dx;
    if (drag.acc > 3) state.dragDir = 'running-right';
    else if (drag.acc < -3) state.dragDir = 'running-left';
    api.petMoveBy({ dx: dx, dy: dy });
  }
});

$('pet').addEventListener('pointerup', (e) => {
  if (!drag.active) return;
  drag.active = false;
  state.dragging = false;
  try { $('pet').releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  if (!drag.moved) {
    if (state.ask) return;
    if (dismissPending()) return;
    if (state.mode === 'coin') doCoinFlip();
    else if (state.mode === 'countdown') dismissCountdown();
    else if (state.mode === 'alarm') dismissAlarm();
    else if (state.mode === 'assistant') api.openAssistant();
    else if (state.mode === 'focus') api.openAssistant();
    else if (state.mode !== 'catch') api.togglePopup();
  }
  state.lastBubbleKey = null;
});

$('bubble').addEventListener('click', async (e) => {
  const el = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
  if (el) {
    const act = el.getAttribute('data-act');
    if (act === 'recycle') { confirmRecycle(); return; }
    if (act === 'cancel') { state.ask = null; state.lastBubbleKey = null; renderBubble(); api.askDone(); return; }
    if (act === 'snooze' && state.reminder) {
      await api.reminderSnooze({ key: state.reminder.key, minutes: 10 });
      state.ping = { text: I.t('pet.snoozed'), until: Date.now() + 4000 };
      state.reminder = null;
      state.lastBubbleKey = null;
      renderBubble();
      return;
    }
    if (act === 'done' && state.reminder) {
      const today = L.todayStr();
      await api.toggleDone({ date: today, key: state.reminder.key });
      state.reminder = null;
      state.lastBubbleKey = null;
      playHappy(0.6);
      renderBubble();
      return;
    }
  }
  if (state.ask) return;
  if (dismissPending()) return;
  if (state.mode === 'coin') { doCoinFlip(); return; }
  if (state.mode === 'countdown') { dismissCountdown(); return; }
  if (state.mode === 'alarm') { dismissAlarm(); return; }
  if (state.mode === 'catch') return;
  api.togglePopup();
});

window.addEventListener('mousemove', (e) => {
  state.hover = hitTest(e);
  renderBubble();
});
window.addEventListener('mouseleave', () => { state.hover = false; renderBubble(); });

document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  api.openModeMenu();
  return false;
});

setInterval(() => {
  state.cycleIdx++;
  if (!state.hover && !state.reminder && !state.pre && !state.celebrate && !state.ping && !state.cd && !state.alarm
    && !state.ask && !state.dragHint && !(state.mode === 'focus' && state.focus && state.focus.phase !== 'idle')) {
    state.lastBubbleKey = null;
    renderBubble();
  }
}, 4500);

setInterval(tick, 1000);

(function animLoopTick() {
  requestAnimationFrame((t) => {
    setAnim(currentAnim());
    animLoop(t);
    animLoopTick();
  });
})();

// ---------------------------------------------------------------- 初始化
(async function init() {
  const qs = new URLSearchParams(location.search);
  const forced = qs.get('anim');
  const data = await api.petInit();
  if (window.WidgetI18n) window.WidgetI18n.setLocale(data.locale);
  applyPetZoom(data.petScale);
  state.settings = (data.state && data.state.settings) || { sound: true };
  if (data.settings && typeof data.settings.sound === 'boolean') state.settings.sound = data.settings.sound;
  if (A) { A.setEnabled(audioEnabled()); A.play('startup', 0.7); }
  const raw = data.tasks === null
    ? '09:00|晨会\n12:00|午餐\n18:00|下班回家\n'
    : data.tasks;
  setTasks(raw);
  if (data.tasks === null) await api.saveSchedule(raw);
  setCountdown(data.countdown || '');
  applyTheme(data.theme);
  state.mode = data.mode || 'normal';
  state.focus = data.focus || null;

  api.onTasksChanged((text) => setTasks(text));
  api.onCountdownChanged((text) => setCountdown(text));
  api.onThemeChanged((t) => applyTheme(t));
  api.onSettingsChanged((s) => {
    if (s && typeof s.sound === 'boolean') {
      state.settings.sound = s.sound;
      if (A) A.setEnabled(s.sound);
    }
  });
  api.onPanelState((open) => { state.popupOpen = open; state.lastBubbleKey = null; });
  let welcomeAssistantVisible = false;
  api.onAssistantState((open) => {
    if (open && !welcomeAssistantVisible && A && audioEnabled()) A.play('assistantOpen', 0.7);
    welcomeAssistantVisible = !!open;
    state.assistantOpen = !!open;
    $('ring').className = state.assistantOpen ? 'on' : '';
    state.lastBubbleKey = null;
    renderBubble();
  });
  api.onAgentEvent((evt) => {
    if (evt && evt.type === 'tool-call') {
      state.actionLaugh = Date.now() + 2000;
      state.lastBubbleKey = null;
      playHappy(0.5);
      bounce();
    }
  });
  api.onCelebrate(() => {
    state.celebrate = { until: Date.now() + 8000 };
    state.lastBubbleKey = null;
    playHappy();
    bounce();
  });
  api.onFocusChanged((st) => {
    state.focus = st;
    state.lastBubbleKey = null;
    renderBubble();
    renderChip();
  });
  api.onModeChanged((m) => {
    // 闹钟/倒计时不跟随形态：切形态（开助手、点通知、快捷键）只是换个界面，
    // 不该把它们悄悄清掉 —— 否则到点既不响也不笑。只有用户主动取消才消失。
    const nm = m || 'normal';
    state.mode = nm;
    state.assistantOpen = (nm === 'assistant');
    $('ring').className = state.assistantOpen ? 'on' : '';
    state.lastBubbleKey = null;
    renderBubble();
    renderChip();
  });

  api.onPetPing((p) => {
    const act = p.action;
    if (act === 'catch-start') {
      state.catchOn = true;
      state.catchStartAt = Date.now();
      state.catchDir = 'running-right';
      state.hover = false;
      state.dragging = false;
      state.cd = null;
      state.ping = null;
      state.lastBubbleKey = null;
      playHappy(0.95);
      bounce();
      renderBubble();
      renderChip();
      if (catchTick) clearInterval(catchTick);
      catchTick = setInterval(() => {
        if (!state.catchOn) { clearInterval(catchTick); catchTick = null; return; }
        renderChip();
      }, 100);
      return;
    }
    if (act === 'catch-dir') { state.catchDir = p.dir === 'running-left' ? 'running-left' : 'running-right'; return; }
    if (act === 'catch-end') {
      state.catchOn = false;
      if (catchTick) { clearInterval(catchTick); catchTick = null; }
      if (p.caught) {
        const sec = (Math.max(0, Number(p.ms) || 0) / 1000).toFixed(1);
        if (A && audioEnabled()) A.play('catchWin', 1);
        bounce();
        state.ping = { source: 'catch', text: '🎉 ' + I.t('pet.catchWin', { sec: sec }), anim: 'jumping', until: Date.now() + 4500 };
      } else if (p.reason === 'timeout') {
        state.ping = { source: 'catch', text: I.t('pet.catchEscape'), anim: 'waving', until: Date.now() + 4500 };
      }
      state.lastBubbleKey = null;
      renderBubble();
      renderChip();
      return;
    }
    if (act === 'reminder') {
      state.reminder = { key: p.key, time: p.time, text: p.text, kind: p.kind, minutes: p.minutes, until: Date.now() + 120000 };
      state.lastBubbleKey = null;
      if (p.kind === 'due' || p.kind === 'missed') { playFire(); bounce(); }
      else { playPreReminder(); bounce(); }
      renderBubble();
      return;
    }
    if (act === 'summary') { state.ping = { text: '📋 ' + p.text, until: Date.now() + 12000 }; state.lastBubbleKey = null; renderBubble(); return; }
    if (act === 'focus-tick') { state.focus = p.status; renderChip(); return; }
    if (act === 'focus-event') {
      state.focus = p.status;
      if (p.event === 'focus-done') {
        playHappy(0.8);
        bounce();
        state.ping = { text: '🍅 ' + I.t('pet.focusDone'), anim: 'jumping', until: Date.now() + 12000 };
      } else {
        playHappy();
        state.ping = { text: '☕ ' + I.t('pet.breakDone'), until: Date.now() + 12000 };
      }
      state.lastBubbleKey = null;
      renderBubble(); renderChip();
      return;
    }
    if (act === 'scale') { applyPetZoom(p.scale); return; }
    if (act === 'countdown-start') { state.cd = { endAt: Number(p.endAt) || 0, done: false }; state.ping = null; bounce(); }
    else if (act === 'countdown-cancel') { state.cd = null; state.ping = null; }
    else if (act === 'alarm-set') { alarmRingStop(); state.alarm = { hm: String(p.hm || ''), ringing: false, fired: false }; state.ping = null; bounce(); }
    else if (act === 'alarm-cancel') { alarmRingStop(); state.alarm = null; state.ping = null; }
    else if (act === 'coin-set') { state.coin = { a: String(p.a || ''), b: String(p.b || '') }; }
    else if (act === 'coin-flip') { state.coin = { a: String(p.a || ''), b: String(p.b || '') }; doCoinFlip(); return; }
    else if (act === 'drop-ask') { askRecycle(p.paths || []); return; }
    else if (act === 'walk') { state.walkDir = p.dir ? String(p.dir) : null; state.lastBubbleKey = null; renderBubble(); return; }
    state.lastBubbleKey = null;
    renderBubble();
    renderChip();
  });

  api.onFilesDropped((paths) => {
    state.dragHint = false;
    state.lastBubbleKey = null;
    renderBubble();
    if (paths && paths.length) api.dropSubmit(paths);
  });
  api.onFilesDrag((on) => {
    state.dragHint = !!on;
    state.lastBubbleKey = null;
    renderBubble();
  });

  if (forced && ANIM[forced]) state.forceAnim = forced;
  tick();
})();
