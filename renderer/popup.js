'use strict';
/* 日程面板：列表 / 日历 / 添加 / 统计 */

const L = window.WidgetLogic;
const T = window.WidgetTask;
const R = window.WidgetRepeat;
const NL = window.WidgetNl;
const $ = (id) => document.getElementById(id);
const api = window.widget;
const I = window.WidgetI18n || { t: (k) => k, setLocale() {}, applyDom() {} };

const THEMES = ['奶黄玻璃', '浅色玻璃', '琥珀玻璃', '科技青', '午夜紫', '深空灰'];

const state = {
  tasks: [],
  countdown: [],
  done: {},
  completedDays: [],
  streak: 0,
  settings: { sound: true },
  theme: 0,
  view: 'list',
  selectedDate: L.todayStr(),
  calY: 0,
  calM: 0,
  quickParsed: null,
  statsCache: null
};

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast show';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = 'toast'; }, 1800);
}

function clockHM() {
  const d = new Date();
  return L.pad2(d.getHours()) + ':' + L.pad2(d.getMinutes());
}

function applyTheme(t) {
  state.theme = Number(t) || 0;
  document.body.className = 't' + state.theme;
  $('themebtn').title = '主题：' + THEMES[state.theme] + '（点击切换）';
}

function renderSound() {
  $('soundbtn').className = 'icobtn' + (state.settings.sound ? '' : '');
  $('soundbtn').style.opacity = state.settings.sound ? '1' : '0.4';
  $('soundbtn').title = state.settings.sound ? '提醒音效：开' : '提醒音效：关';
}

// ---------------------------------------------------------------- 列表
function keyDone(date, key) { return (state.done[date] || []).indexOf(key) >= 0; }

function itemsOf(date) { return T.itemsOn(state.tasks, date); }

function renderProgress() {
  const today = L.todayStr();
  const items = itemsOf(today);
  const doneCount = items.filter((it) => keyDone(today, T.keyOf(it))).length;
  const pct = items.length ? Math.round(doneCount / items.length * 100) : 0;
  $('progFill').style.width = pct + '%';
  $('progText').textContent = items.length
    ? I.t('panel.todayProgress', { done: doneCount, total: items.length, pct: pct })
    : I.t('panel.noSchedule');
  $('streakText').textContent = state.streak > 0 ? ('🔥 ' + I.t('panel.streak', { n: state.streak })) : '';
}

function renderList() {
  const date = state.selectedDate;
  const d = L.dateObj(date);
  const hol = L.holiday(date);
  const rel = L.daysBetween(L.todayStr(), date);
  let title = date === L.todayStr() ? '今天' : (rel === 1 ? '明天' : (rel === -1 ? '昨天' : (d.getMonth() + 1) + '月' + d.getDate() + '日'));
  $('listTitle').innerHTML = L.esc(title + ' · ' + L.weekdayCn(d)) + (hol ? ' <span class="badge warn">' + L.esc(hol) + '</span>' : '');

  const items = itemsOf(date);
  const list = $('list');
  if (!items.length) {
    list.innerHTML = '<div class="empty">' + I.t('panel.emptyDay') + '<br>' + I.t('panel.emptyDayHint') + '</div>';
    return;
  }
  const now = clockHM();
  let html = '';
  items.forEach((it, i) => {
    const k = T.keyOf(it);
    const done = keyDone(date, k);
    const past = date < L.todayStr() || (date === L.todayStr() && it.time < now);
    const cls = 'row-item' + (done ? ' done' : '') + (past && !done ? ' past' : '');
    const badges = [];
    if (it.repeat) badges.push('<span class="badge">' + L.esc(R.describeRepeat(it.repeat)) + '</span>');
    if (it.prio === 'high') badges.push('<span class="badge high">重要</span>');
    if (it.tag) badges.push('<span class="badge">#' + L.esc(it.tag) + '</span>');
    if (it.alarm) badges.push('<span class="badge">提前' + it.alarm + '分</span>');
    html += '<div class="' + cls + '" data-i="' + i + '">'
      + '<span class="chk" data-act="done" data-i="' + i + '">✓</span>'
      + '<span class="time">' + L.esc(it.time) + '</span>'
      + '<span class="txt" title="' + L.esc(it.text) + '">' + L.esc(it.text) + '</span>'
      + (badges.length ? '<span style="display:flex;gap:3px;flex:none">' + badges.join('') + '</span>' : '')
      + '<span class="act" data-act="edit" data-i="' + i + '" title="编辑">✎</span>'
      + '<span class="del" data-act="del" data-i="' + i + '" title="删除">✕</span>'
      + '</div>';
  });
  list.innerHTML = html;
}

async function onListClick(e) {
  const el = e.target.closest ? e.target.closest('[data-act]') : null;
  if (!el) return;
  const i = parseInt(el.getAttribute('data-i'), 10);
  const it = itemsOf(state.selectedDate)[i];
  if (!it) return;
  const act = el.getAttribute('data-act');
  if (act === 'done') {
    const s = await api.toggleDone({ date: state.selectedDate, key: T.keyOf(it) });
    state.done = (s && s.done) || state.done;
    state.completedDays = (s && s.completedDays) || state.completedDays;
    state.streak = (s && s.streak) || 0;
    renderList();
    renderProgress();
  } else if (act === 'del') {
    await api.scheduleRemove({ key: T.keyOf(it) });
    state.tasks = state.tasks.filter((x) => x !== it);
    renderList();
    renderProgress();
    toast('已删除');
  } else if (act === 'edit') {
    openAdd(it);
  }
}

function renderCdStrip() {
  const strip = $('cdstrip');
  const cds = L.nextCountdowns(state.countdown, null, 8);
  let html = cds.map((cd) =>
    '<span class="cdchip' + (cd.days === 0 ? ' today' : '') + '" title="' + L.esc(cd.date) + '">'
    + L.esc(cd.text) + '<b>' + (cd.days === 0 ? '今天' : cd.days + '天') + '</b>'
    + '<span class="cdx" data-date="' + L.esc(cd.date) + '" data-text="' + L.esc(cd.text) + '">✕</span></span>'
  ).join('');
  html += '<span class="cdchip add" id="addCdChip">' + I.t('panel.addCountdown') + '</span>';
  strip.innerHTML = html;
  Array.prototype.forEach.call(strip.querySelectorAll('.cdx'), (x) => {
    x.onclick = async () => {
      await api.countdownRemove({ date: x.getAttribute('data-date'), text: x.getAttribute('data-text') });
      state.countdown = state.countdown.filter((c) => !(c.date === x.getAttribute('data-date') && c.text === x.getAttribute('data-text')));
      renderCdStrip();
      renderCal();
    };
  });
  $('addCdChip').onclick = () => { openAdd(null, 'cd'); };
}

// ---------------------------------------------------------------- 日历
function renderCal() {
  const y = state.calY, m = state.calM;
  $('calTitle').textContent = y + '年' + (m + 1) + '月';
  const first = new Date(y, m, 1);
  let lead = first.getDay() - 1;
  if (lead < 0) lead = 6;
  const start = new Date(y, m, 1 - lead);
  const today = L.todayStr();
  let html = '';
  for (let i = 0; i < 42; i++) {
    const dt = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const ds = L.fmtDateObj(dt);
    const other = dt.getMonth() !== m;
    const hasItem = itemsOf(ds).length > 0;
    const hasCd = state.countdown.some((c) => c.date === ds);
    const hol = L.holiday(ds);
    const cls = 'calcell' + (other ? ' other' : '') + (ds === today ? ' today' : '') + (ds === state.selectedDate ? ' sel' : '');
    html += '<div class="' + cls + '" data-date="' + ds + '">'
      + '<div>' + dt.getDate() + '</div>'
      + '<div class="dots">' + (hasItem ? '<span class="dot"></span>' : '') + (hasCd ? '<span class="dot cd"></span>' : '') + '</div>'
      + (hol ? '<div class="hol">' + L.esc(hol) + '</div>' : '')
      + '</div>';
  }
  const grid = $('calGrid');
  grid.innerHTML = html;
  Array.prototype.forEach.call(grid.querySelectorAll('.calcell'), (c) => {
    c.onclick = () => { state.selectedDate = c.getAttribute('data-date'); renderCal(); };
  });

  const items = itemsOf(state.selectedDate);
  $('calList').innerHTML = items.length
    ? items.map((it) => {
      const done = keyDone(state.selectedDate, T.keyOf(it));
      return '<div class="row-item' + (done ? ' done' : '') + '"><span class="chk" style="' + (done ? 'background:var(--ok);color:var(--ok-fg);border-color:transparent' : '') + '">✓</span>'
        + '<span class="time">' + L.esc(it.time) + '</span><span class="txt">' + L.esc(it.text) + '</span>'
        + (it.repeat ? '<span class="badge">' + L.esc(R.describeRepeat(it.repeat)) + '</span>' : '') + '</div>';
    }).join('')
    : '<div class="empty">这天没有日程</div>';
}

// ---------------------------------------------------------------- 快速添加
async function previewQuick() {
  const text = $('quickInput').value.trim();
  if (!text) { $('quickPrev').innerHTML = ''; state.quickParsed = null; return; }
  const r = await api.nlParse({ text: text });
  state.quickParsed = r;
  if (!r || !r.task) { $('quickPrev').innerHTML = ''; return; }
  const bits = [];
  if (r.task.date) bits.push(r.task.date === L.todayStr() ? '今天' : (r.task.date === L.dateAdd(L.todayStr(), 1) ? '明天' : r.task.date));
  if (r.task.time) bits.push('<b>' + r.task.time + '</b>');
  else bits.push('<b>需要时间</b>');
  if (r.task.repeat) bits.push(L.esc(R.describeRepeat(r.task.repeat)));
  if (r.task.alarm) bits.push('提前' + r.task.alarm + '分');
  if (r.task.tag) bits.push('#' + L.esc(r.task.tag));
  if (r.task.prio === 'high') bits.push('重要');
  bits.push('内容：' + L.esc(r.task.text || text));
  $('quickPrev').innerHTML = '解析为 → ' + bits.join(' · ');
}

async function quickAdd() {
  const text = $('quickInput').value.trim();
  if (!text) return;
  const r = state.quickParsed || await api.nlParse({ text: text });
  const task = (r && r.task) || null;
  if (!task || !task.time) {
    toast(I.t('panel.needTime'));
    openAdd(null, 'item');
    $('addText').value = task ? task.text : text;
    $('addNl').value = text;
    return;
  }
  await api.scheduleAdd(task);
  $('quickInput').value = '';
  $('quickPrev').innerHTML = '';
  state.quickParsed = null;
  await reload();
  toast('已添加：' + task.time + ' ' + task.text);
}

// ---------------------------------------------------------------- 添加表单
let editingTask = null;
let addMode = 'item';

function showView(v) {
  state.view = v;
  ['list', 'cal', 'add', 'stats'].forEach((k) => {
    $('v-' + k).className = 'view' + (v === k ? ' on' : '');
  });
  if (v === 'cal') renderCal();
  if (v === 'stats') renderStats();
}

function openAdd(task, mode) {
  addMode = mode || 'item';
  editingTask = task || null;
  if (addMode === 'cd') {
    $('addTitle').textContent = '添加倒数日';
    $('addText').placeholder = '倒数日名称，如：春节';
    $('addText').value = '';
    $('addNl').value = '';
    $('addDate').value = state.selectedDate;
    $('addTime').value = '00:00';
    $('addRepeat').value = 'yearly';
  } else {
    $('addTitle').textContent = task ? '编辑日程' : '添加日程';
    $('addText').placeholder = '要做什么？';
    const d = new Date();
    let h = d.getHours(), m = d.getMinutes() + 5;
    if (m >= 60) { m -= 60; h = (h + 1) % 24; }
    m = Math.floor(m / 5) * 5;
    $('addText').value = task ? task.text : '';
    $('addNl').value = '';
    $('addDate').value = task && task.date ? task.date : L.todayStr();
    $('addTime').value = task ? task.time : (L.pad2(h) + ':' + L.pad2(m));
    $('addRepeat').value = task && task.repeat ? R.serializeRepeat(task.repeat) : '';
    if ($('addRepeat').value !== (task && task.repeat ? R.serializeRepeat(task.repeat) : '')) {
      $('addRepeat').value = '__custom';
      $('addRepeatCustom').style.display = '';
      $('addRepeatCustom').value = R.serializeRepeat(task.repeat);
    }
    $('addAlarm').value = task && task.alarm !== undefined ? String(task.alarm) : '';
    $('addPrio').value = (task && task.prio) || 'mid';
    $('addTag').value = (task && task.tag) || '';
  }
  showView('add');
  setTimeout(() => $('addText').focus(), 80);
}

async function applyNlToForm() {
  const text = $('addNl').value.trim();
  if (!text) return;
  const r = await api.nlParse({ text: text });
  if (!r || !r.task) return;
  const t = r.task;
  if (t.date) $('addDate').value = t.date;
  if (t.time) $('addTime').value = t.time;
  if (t.repeat) {
    const spec = R.serializeRepeat(t.repeat);
    $('addRepeat').value = spec;
    if ($('addRepeat').value !== spec) {
      $('addRepeat').value = '__custom';
      $('addRepeatCustom').style.display = '';
      $('addRepeatCustom').value = spec;
    }
  }
  if (t.alarm) $('addAlarm').value = String(t.alarm);
  if (t.prio) $('addPrio').value = t.prio;
  if (t.tag) $('addTag').value = t.tag;
  if (!$('addText').value.trim()) $('addText').value = t.text || text;
  toast('已按「' + text + '」填好，确认后保存');
}

async function saveAdd() {
  const text = $('addText').value.trim();
  if (!text) { $('addText').classList.add('err'); setTimeout(() => $('addText').classList.remove('err'), 900); return; }
  if (addMode === 'cd') {
    await api.countdownAdd({ date: $('addDate').value, text: text });
    state.countdown = L.parseCountdown((await api.appInit()).countdown || '');
    renderCdStrip();
    showView('list');
    toast('倒数日已添加');
    return;
  }
  let spec = $('addRepeat').value;
  if (spec === '__custom') spec = $('addRepeatCustom').value.trim();
  const task = {
    text: text,
    time: $('addTime').value || '',
    date: $('addDate').value || '',
    repeat: spec || undefined,
    prio: $('addPrio').value,
    tag: $('addTag').value.trim() || undefined
  };
  const alarm = $('addAlarm').value;
  if (alarm !== '') task.alarm = parseInt(alarm, 10);
  if (!task.repeat && !task.date) task.date = '';
  if (task.repeat && !task.date) task.date = L.todayStr();
  if (editingTask) {
    await api.scheduleUpdate({ old: editingTask, patch: task });
  } else {
    await api.scheduleAdd(task);
  }
  editingTask = null;
  await reload();
  showView('list');
  toast('已保存');
}

// ---------------------------------------------------------------- 统计
async function renderStats() {
  const d = await api.statsGet({ days: 30 });
  if (!d || d.error) return;
  const t = d.today, rg = d.range;
  $('statGrid').innerHTML = [
    ['今日完成', t.tasksDone + '/' + t.tasksTotal],
    ['完成率（30天）', rg.summary.rate + '%'],
    ['当前连签', rg.streak + ' 天'],
    ['最长连签', rg.longest + ' 天'],
    ['番茄总数', rg.focusCount],
    ['专注分钟', rg.focusMinutes]
  ].map((x) => '<div class="stat"><div class="v">' + x[1] + '</div><div class="k">' + x[0] + '</div></div>').join('');

  $('heat').innerHTML = rg.heatmap.slice(-21).map((h) =>
    '<i class="l' + h.level + '" title="' + h.date + ' ' + h.done + '/' + h.total + '"></i>').join('');

  $('tagList').innerHTML = rg.tags.length
    ? rg.tags.slice(0, 8).map((x) => '<div class="tagline"><span>#' + L.esc(x.tag) + '</span>'
      + '<span class="tagbar"><i style="width:' + x.pct + '%"></i></span>'
      + '<span class="n">' + x.done + '/' + x.total + '</span></div>').join('')
    : '<div class="small muted">还没有带标签的日程</div>';

  const u = d.usage || [];
  const total = u.reduce((a, x) => a + x.usd, 0);
  const calls = u.reduce((a, x) => a + x.calls, 0);
  $('usageBox').innerHTML = calls
    ? '共 ' + calls + ' 次调用 · 约 $' + total.toFixed(4) + '<br>' + u.slice(-7).map((x) => x.day + '：' + x.calls + ' 次 / $' + x.usd.toFixed(4)).join('<br>')
    : I.t('panel.noKey');
}

// ---------------------------------------------------------------- 时钟
function tick() {
  const d = new Date();
  $('clock').textContent = L.pad2(d.getHours()) + ':' + L.pad2(d.getMinutes()) + ':' + L.pad2(d.getSeconds());
  $('date').textContent = d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 · ' + L.weekdayCn(d);
}

/** 音效开关只认 settings.json 那一份；state.json 里的是 v2 遗留，仅作兜底 */
function soundOf(d) {
  if (d && d.settings && typeof d.settings.sound === 'boolean') return d.settings.sound;
  if (d && d.state && d.state.settings && typeof d.state.settings.sound === 'boolean') return d.state.settings.sound;
  return true;
}

async function reload() {
  const d = await api.appInit();
  state.tasks = T.parseTasks(d.tasks || '');
  state.countdown = L.parseCountdown(d.countdown || '');
  state.done = (d.state && d.state.done) || {};
  state.completedDays = (d.state && d.state.completedDays) || [];
  state.settings = { sound: soundOf(d) };
  state.streak = 0;
  renderList();
  renderProgress();
  renderCdStrip();
  renderSound();
  if (state.view === 'cal') renderCal();
}

// ---------------------------------------------------------------- 事件
window.addEventListener('error', (e) => console.error('ERR ' + e.message + ' @' + e.lineno));
window.addEventListener('unhandledrejection', (e) => console.error('REJ ' + ((e.reason && e.reason.message) || e.reason)));

(async function init() {
  const d = await api.appInit();
  if (window.WidgetI18n) { window.WidgetI18n.setLocale(d.locale); window.WidgetI18n.applyDom(); }
  state.tasks = T.parseTasks(d.tasks || '');
  state.countdown = L.parseCountdown(d.countdown || '');
  state.done = d.state.done || {};
  state.completedDays = d.state.completedDays || [];
  state.settings = { sound: soundOf(d) };
  applyTheme(d.theme);
  const now = new Date();
  state.calY = now.getFullYear();
  state.calM = now.getMonth();

  tick();
  setInterval(tick, 1000);
  renderList();
  renderProgress();
  renderCdStrip();
  renderSound();

  api.statsGet({ days: 30 }).then((s) => { if (s && s.today) { state.streak = s.today.streak; renderProgress(); } });

  $('list').onclick = onListClick;
  $('quickAdd').onclick = quickAdd;
  $('quickInput').addEventListener('input', () => { clearTimeout(state._qt); state._qt = setTimeout(previewQuick, 260); });
  $('quickInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') quickAdd(); });
  $('okAdd').onclick = saveAdd;
  $('cancelAdd').onclick = () => { editingTask = null; showView('list'); };
  $('addNl').addEventListener('change', applyNlToForm);
  $('addRepeat').addEventListener('change', () => {
    $('addRepeatCustom').style.display = $('addRepeat').value === '__custom' ? '' : 'none';
  });
  $('openCalBtn').onclick = () => {
    const d2 = L.dateObj(state.selectedDate);
    state.calY = d2.getFullYear();
    state.calM = d2.getMonth();
    showView('cal');
  };
  $('addItemBtn').onclick = () => openAdd(null, 'item');
  $('backListBtn').onclick = () => showView('list');
  $('backFromStats').onclick = () => showView('list');
  $('prevMonth').onclick = () => { state.calM--; if (state.calM < 0) { state.calM = 11; state.calY--; } renderCal(); };
  $('nextMonth').onclick = () => { state.calM++; if (state.calM > 11) { state.calM = 0; state.calY++; } renderCal(); };
  $('statsbtn').onclick = () => showView('stats');
  $('settingsbtn').onclick = () => api.openSettings();
  $('themebtn').onclick = () => {
    state.theme = (state.theme + 1) % THEMES.length;
    applyTheme(state.theme);
    api.saveTheme(state.theme);
    api.refreshPanelBackdrop();
  };
  $('soundbtn').onclick = async () => {
    state.settings.sound = !state.settings.sound;
    renderSound();
    const saved = await api.settingsSave({ sound: state.settings.sound });
    state.settings.sound = !!(saved && typeof saved.sound === 'boolean' ? saved.sound : state.settings.sound);
    renderSound();
  };
  $('close').onclick = () => api.hidePopup();
  $('avatar').onclick = () => api.resetPanelPos();

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (state.view === 'list') api.hidePopup();
      else showView('list');
    }
  });

  // 里外只认一份设置：设置窗或别处改了音效，面板的图标也跟着走
  api.onSettingsChanged((s) => { if (s && typeof s.sound === 'boolean') { state.settings.sound = s.sound; renderSound(); } });
  api.onTasksChanged((text) => { state.tasks = T.parseTasks(text || ''); renderList(); renderProgress(); if (state.view === 'cal') renderCal(); });
  api.onThemeChanged((t) => { applyTheme(t); api.refreshPanelBackdrop(); });
  api.onCountdownChanged((text) => { state.countdown = L.parseCountdown(text || ''); renderCdStrip(); if (state.view === 'cal') renderCal(); });
  api.onStateChanged((s) => { state.done = (s && s.done) || state.done; state.completedDays = (s && s.completedDays) || state.completedDays; state.streak = (s && s.streak) || state.streak; renderList(); renderProgress(); });
  api.onPanelBackdrop((url) => { $('backdrop').src = url; });
  api.onFocusChanged(() => { /* 面板不展示专注 */ });

  if (location.search.indexOf('debug=1') !== -1) {
    setInterval(() => {
      api.debugDump({ view: state.view, date: state.selectedDate, streak: state.streak, tasks: state.tasks.length });
    }, 1500);
  }
})();
