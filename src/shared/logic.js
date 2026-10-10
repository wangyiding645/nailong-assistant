/* 奶蛙助手 · 纯日期/时间/文本工具（无 Electron 依赖，主进程与渲染进程共用）
 * v3.0：逻辑拆分到 repeat.js / task.js，本文件保持向后兼容的公共 API。
 * 加载方式：主进程 require('../shared/logic.js')；渲染层 <script src>（挂到 window.WidgetLogic）
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  else { root.WidgetLogic = api; }
})(typeof window !== 'undefined' ? window : this, function () {
  var CN_WEEK = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  // ISO 周几：1=周一 … 7=周日
  var CN_DOW = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7, '七': 7 };

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function trim(s) { return String(s == null ? '' : s).replace(/^\s+|\s+$/g, ''); }
  function fmtDateObj(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function todayStr(d) { return fmtDateObj(d || new Date()); }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** 解析 HH:MM / H:MM / HMM / 8点30 / 8:5 → '08:30' */
  function parseTime(t) {
    t = trim(t).replace(/：/g, ':');
    var m = /^([01]?[0-9]|2[0-3])(?::?([0-5][0-9]|[0-5]))$/.exec(t);
    if (!m) { return null; }
    return pad2(parseInt(m[1], 10)) + ':' + pad2(parseInt(m[2], 10));
  }

  function parseDate(s) {
    s = trim(s).replace(/[年月]/g, '-').replace(/[日号]/g, '').replace(/\/|\./g, '-');
    var m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(s);
    if (!m) { return null; }
    var y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = m[3] === undefined ? 1 : parseInt(m[3], 10);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) { return null; }
    var dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) { return null; }
    return y + '-' + pad2(mo) + '-' + pad2(d);
  }

  function dateObj(s) {
    var n = parseDate(s);
    if (!n) { return null; }
    var p = n.split('-');
    return new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
  }

  function isoDow(dateStr) { var d = dateObj(dateStr); if (!d) { return 0; } var w = d.getDay(); return w === 0 ? 7 : w; }
  function weekdayCn(d) { return CN_WEEK[d.getDay()]; }

  function dateAdd(dateStr, n) {
    var d = dateObj(dateStr);
    if (!d) { return null; }
    d.setDate(d.getDate() + n);
    return fmtDateObj(d);
  }

  function daysBetween(aStr, bStr) {
    var a = dateObj(aStr), b = dateObj(bStr);
    if (!a || !b) { return null; }
    return Math.round((b.getTime() - a.getTime()) / 86400000);
  }
  function daysUntil(dateStr, from) { return daysBetween(from || todayStr(), dateStr); }

  function addMinutes(hm, n) {
    var p = String(hm || '00:00').split(':');
    var total = (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0) + n;
    total = ((total % 1440) + 1440) % 1440;
    return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
  }

  function hm2min(hm) {
    var p = String(hm || '0:0').split(':');
    return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
  }

  function humanDuration(sec) {
    sec = Math.max(0, Math.round(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h > 0) { return h + ' 小时 ' + m + ' 分'; }
    if (m > 0) { return m + ' 分 ' + pad2(s) + ' 秒'; }
    return s + ' 秒';
  }

  var HOLIDAYS = {
    '01-01': '元旦', '02-14': '情人节', '03-08': '妇女节', '04-01': '愚人节',
    '05-01': '劳动节', '05-04': '青年节', '06-01': '儿童节', '07-01': '建党节',
    '08-01': '建军节', '09-10': '教师节', '10-01': '国庆节', '11-11': '双十一',
    '12-24': '平安夜', '12-25': '圣诞节'
  };
  function holiday(dateStr) {
    var n = parseDate(dateStr);
    if (!n) { return ''; }
    return HOLIDAYS[n.substring(5)] || '';
  }

  // ---------- 倒数日 ----------
  function parseCountdown(text) {
    var list = [];
    var lines = String(text || '').split(/\r\n|\r|\n/);
    for (var i = 0; i < lines.length; i++) {
      var ln = trim(lines[i]);
      if (ln === '' || ln.charAt(0) === '#') { continue; }
      var idx = ln.indexOf('|');
      if (idx < 0) { continue; }
      var d = parseDate(ln.substring(0, idx));
      var x = trim(ln.substring(idx + 1));
      if (!d || x === '') { continue; }
      list.push({ date: d, text: x });
    }
    list.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    return list;
  }
  function serializeCountdown(list) {
    if (!list || !list.length) { return ''; }
    return list.map(function (it) { return it.date + '|' + it.text; }).join('\r\n') + '\r\n';
  }
  function nextCountdowns(list, from, max) {
    var fromStr = from || todayStr();
    return (list || [])
      .map(function (it) { return { date: it.date, text: it.text, days: daysUntil(it.date, fromStr) }; })
      .filter(function (it) { return it.days !== null && it.days >= 0; })
      .sort(function (a, b) { return a.days - b.days; })
      .slice(0, max || 5);
  }

  // 桌宠体型：scale 是相对基准窗口的倍率（1 = 100%）。吃一份文件 +0.1，不设上限，
  // 只在物理上封顶（见 windows.js：屏幕装不下就按屏幕来，保证奶娃本体可见）。
  var PET_SCALE_MIN = 0.5;
  var PET_SCALE_MAX = 9.99;
  var PET_BITE = 0.1;
  function clampPetScale(v) {
    var n = Number(v);
    if (!isFinite(n) || n <= 0) { n = 1; }
    n = Math.round(n * 100) / 100;   // 存两位小数，免得 settings.json 里出现 1.4000000000000001
    return Math.min(PET_SCALE_MAX, Math.max(PET_SCALE_MIN, n));
  }
  function growPetScale(v, bites) {
    var n = Math.max(1, Math.round(Number(bites) || 1));
    return clampPetScale(clampPetScale(v) + PET_BITE * n);
  }

  return {
    CN_WEEK: CN_WEEK,
    PET_SCALE_MIN: PET_SCALE_MIN,
    PET_SCALE_MAX: PET_SCALE_MAX,
    PET_BITE: PET_BITE,
    clampPetScale: clampPetScale,
    growPetScale: growPetScale,
    CN_DOW: CN_DOW,
    pad2: pad2,
    trim: trim,
    todayStr: todayStr,
    fmtDateObj: fmtDateObj,
    esc: esc,
    parseTime: parseTime,
    parseDate: parseDate,
    dateObj: dateObj,
    isoDow: isoDow,
    weekdayCn: weekdayCn,
    dateAdd: dateAdd,
    daysBetween: daysBetween,
    daysUntil: daysUntil,
    addMinutes: addMinutes,
    hm2min: hm2min,
    humanDuration: humanDuration,
    holiday: holiday,
    HOLIDAYS: HOLIDAYS,
    parseCountdown: parseCountdown,
    serializeCountdown: serializeCountdown,
    nextCountdowns: nextCountdowns
  };
});
