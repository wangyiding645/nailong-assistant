'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const S = path.join(__dirname, '..', 'src', 'shared');
const L = require(path.join(S, 'logic.js'));
const R = require(path.join(S, 'repeat.js'));
const T = require(path.join(S, 'task.js'));
const NL = require(path.join(S, 'nl.js'));
const P = require(path.join(S, 'pomodoro.js'));
const ST = require(path.join(S, 'stats.js'));

test('logic: 日期与时间基础', () => {
  assert.equal(L.pad2(3), '03');
  assert.equal(L.parseTime('9:5'), '09:05');
  assert.equal(L.parseTime('9点'), null);
  assert.equal(L.parseTime('23:59'), '23:59');
  assert.equal(L.parseDate('2026/10/8'), '2026-10-08');
  assert.equal(L.parseDate('2026-2-30'), null);
  assert.equal(L.dateAdd('2026-02-28', 1), '2026-03-01');
  assert.equal(L.dateAdd('2024-02-28', 1), '2024-02-29');
  assert.equal(L.daysBetween('2026-01-01', '2026-03-01'), 59);
  assert.equal(L.isoDow('2026-10-08'), 4);
  assert.equal(L.addMinutes('23:50', 20), '00:10');
  assert.equal(L.addMinutes('00:10', -20), '23:50');
  assert.equal(L.humanDuration(3725), '1 小时 2 分');
});

test('logic: 桌宠体型规则（吃文件 +10%，中间不封顶）', () => {
  assert.equal(L.clampPetScale(undefined), 1, '没配过就是 100%');
  assert.equal(L.clampPetScale(0), 1, '无效倍率（0/负数/非数字）当没配过');
  assert.equal(L.clampPetScale('abc'), 1);
  assert.equal(L.clampPetScale(0.3), 0.5, '下限 50%');
  assert.equal(L.clampPetScale(1e9), 9.99, '只在 999% 封顶');
  assert.equal(L.growPetScale(1, 1), 1.1, '吃一份 +10%');
  assert.equal(L.growPetScale(1.1, 3), 1.4, '多份按份数累加');
  assert.equal(L.growPetScale(3, 1), 3.1, '中间不设上限');
  assert.equal(L.growPetScale(9.9, 5), 9.99);
});

test('logic: 倒数日解析与排序', () => {
  const list = L.parseCountdown('# 注释\n2026-12-25|圣诞节\r\n2026-01-01|元旦\r\nbadline');
  assert.equal(list.length, 2);
  assert.equal(list[0].text, '元旦');
  assert.equal(L.serializeCountdown(list), '2026-01-01|元旦\r\n2026-12-25|圣诞节\r\n');
  const nx = L.nextCountdowns(list, '2026-01-01', 5);
  assert.equal(nx[0].days, 0);
});

test('repeat: 规格字符串双向转换', () => {
  assert.deepEqual(R.parseRepeat('每天'), { kind: 'daily' });
  assert.deepEqual(R.parseRepeat('工作日'), { kind: 'weekly', dow: [1, 2, 3, 4, 5] });
  assert.deepEqual(R.parseRepeat('每周一,周三'), { kind: 'weekly', dow: [1, 3] });
  assert.deepEqual(R.parseRepeat('每周日'), { kind: 'weekly', dow: [7] });
  assert.deepEqual(R.parseRepeat('每月1,15'), { kind: 'monthly', dom: [1, 15] });
  assert.deepEqual(R.parseRepeat('every:2d'), { kind: 'interval', every: 2, unit: 'd' });
  assert.deepEqual(R.parseRepeat('每3个月'), { kind: 'interval', every: 3, unit: 'm' });
  assert.equal(R.parseRepeat('随便乱写'), null);

  assert.equal(R.serializeRepeat({ kind: 'weekly', dow: [1, 2, 3, 4, 5] }), 'weekdays');
  assert.equal(R.serializeRepeat({ kind: 'interval', every: 3, unit: 'm' }), 'every:3m');
  for (const spec of ['daily', 'weekdays', 'weekends', 'weekly:1,3,5', 'monthly:1,15', 'yearly', 'every:2w']) {
    assert.equal(R.serializeRepeat(R.parseRepeat(spec)), spec, 'roundtrip ' + spec);
  }
  assert.equal(R.describeRepeat(R.parseRepeat('每周一,周三')), '每周 周一、周三');
});

test('repeat: occursOn 各种规则', () => {
  // 无日期且无重复 = 每天（v2 兼容语义）
  assert.equal(R.occursOn({ date: '', time: '09:00', text: 'a' }, '2026-10-08'), true);
  assert.equal(R.occursOn({ date: '2026-10-08', time: '09:00', text: 'a' }, '2026-10-08'), true);
  assert.equal(R.occursOn({ date: '2026-10-08', time: '09:00', text: 'a' }, '2026-10-09'), false);

  const daily = { date: '2026-10-08', time: '09:00', text: 'a', repeat: { kind: 'daily' } };
  assert.ok(R.occursOn(daily, '2026-10-08'));
  assert.ok(R.occursOn(daily, '2030-01-01'));
  assert.ok(!R.occursOn(daily, '2026-10-07'), '开始日之前不出现');

  const wd = { date: '', time: '09:00', text: 'a', repeat: { kind: 'weekly', dow: [1, 2, 3, 4, 5] } };
  assert.ok(R.occursOn(wd, '2026-10-08'));   // 周四
  assert.ok(!R.occursOn(wd, '2026-10-10'));  // 周六

  const mon = { date: '2026-01-01', time: '09:00', text: 'a', repeat: { kind: 'monthly', dom: [1, 15] } };
  assert.ok(R.occursOn(mon, '2026-03-15'));
  assert.ok(!R.occursOn(mon, '2026-03-16'));

  const ev2 = { date: '2026-10-08', time: '09:00', text: 'a', repeat: { kind: 'interval', every: 2, unit: 'd' } };
  assert.ok(R.occursOn(ev2, '2026-10-10'));
  assert.ok(!R.occursOn(ev2, '2026-10-11'));

  const until = { date: '2026-10-08', time: '09:00', text: 'a', repeat: { kind: 'daily' }, until: '2026-10-10' };
  assert.ok(R.occursOn(until, '2026-10-10'));
  assert.ok(!R.occursOn(until, '2026-10-11'));
});

test('repeat: nextOccurrence', () => {
  const wd = { date: '', time: '09:00', text: 'a', repeat: { kind: 'weekly', dow: [1] } };
  assert.equal(R.nextOccurrence(wd, '2026-10-08'), '2026-10-12'); // 周四 → 下周一
  const once = { date: '2026-10-20', time: '09:00', text: 'a' };
  assert.equal(R.nextOccurrence(once, '2026-10-08'), '2026-10-20');
  assert.equal(R.nextOccurrence(once, '2026-10-21'), null);
});

test('task: 纯文本格式解析/序列化往返', () => {
  const text = [
    '# 注释行被忽略',
    '09:00|晨会',
    '2026-10-08 09:30|组会',
    '09:00|喝水|repeat=every:2d;alarm=5',
    '10:00|交报告|repeat=monthly:1,15;prio=high;tag=工作;dur=60'
  ].join('\r\n');
  const items = T.parseTasks(text);
  assert.equal(items.length, 4);
  const water = items.find((t) => t.text === '喝水');
  assert.deepEqual(water.repeat, { kind: 'interval', every: 2, unit: 'd' });
  assert.equal(water.alarm, 5);
  const rep = items.find((t) => t.text === '交报告');
  assert.equal(rep.prio, 'high');
  assert.equal(rep.tag, '工作');
  assert.equal(rep.dur, 60);
  assert.deepEqual(T.parseTasks(T.serializeTasks(items)).map(T.taskToLine), items.map(T.taskToLine));
});

test('task: 文本里含竖线不会被当成修饰符', () => {
  const t = T.taskFromLine('09:00|前端 | 后端 联调');
  assert.equal(t.text, '前端 | 后端 联调');
  assert.equal(t.repeat, undefined);
});

test('task: key 与 v2 完全兼容', () => {
  assert.equal(T.keyOf({ date: '', time: '09:00', text: '晨会' }), '09:00|晨会');
  assert.equal(T.keyOf({ date: '2026-10-08', time: '09:00', text: '晨会' }), '2026-10-08 09:00|晨会');
});

test('task: itemsOn 展开重复', () => {
  const items = T.parseTasks('09:00|站会|repeat=weekdays\r\n09:30|周报|repeat=weekly:5');
  assert.deepEqual(T.itemsOn(items, '2026-10-08').map((t) => t.text), ['站会']);     // 周四
  assert.deepEqual(T.itemsOn(items, '2026-10-09').map((t) => t.text), ['站会', '周报']); // 周五
  assert.deepEqual(T.itemsOn(items, '2026-10-10').map((t) => t.text), []);            // 周六
});

test('task: 排序与查找', () => {
  const items = T.parseTasks('10:00|B\r\n08:00|A\r\n09:00|C');
  assert.deepEqual(items.map((t) => t.text), ['A', 'C', 'B']);
  assert.equal(T.findTask(items, 'A').text, 'A');
  assert.equal(T.findTask(items, '08:00|A').text, 'A');
  assert.equal(T.findTask(items, 'zzz'), null);
});

test('nl: 基础时间与日期', () => {
  const p = NL.parseQuickAdd('明天下午3点半和设计组评审 #工作 提前10分钟', '2026-10-08');
  assert.equal(p.date, '2026-10-09');
  assert.equal(p.time, '15:30');
  assert.equal(p.text, '和设计组评审');
  assert.equal(p.tag, '工作');
  assert.equal(p.alarm, 10);
});

test('nl: 相对时间', () => {
  const base = new Date(2026, 9, 8, 10, 0);
  const p = NL.parseQuickAdd('30分钟后提醒我喝水', base);
  assert.equal(p.date, '2026-10-08');
  assert.equal(p.time, '10:30');
  assert.equal(p.text, '提醒我喝水');
  const q = NL.parseQuickAdd('2小时后交作业', base);
  assert.equal(q.time, '12:00');
});

test('nl: 重复规则识别', () => {
  assert.deepEqual(NL.parseQuickAdd('每天早上8点吃药', '2026-10-08').repeat, { kind: 'daily' });
  assert.deepEqual(NL.parseQuickAdd('每周一三五 10:00 组会', '2026-10-08').repeat, { kind: 'weekly', dow: [1, 3, 5] });
  assert.deepEqual(NL.parseQuickAdd('每月1号交房租', '2026-10-08').repeat, { kind: 'monthly', dom: [1] });
  assert.deepEqual(NL.parseQuickAdd('每隔2天浇花', '2026-10-08').repeat, { kind: 'interval', every: 2, unit: 'd' });
});

test('nl: 时间点解析边界', () => {
  assert.equal(NL.parseQuickAdd('晚上7点15分吃饭', '2026-10-08').time, '19:15');
  assert.equal(NL.parseQuickAdd('中午12点吃饭', '2026-10-08').time, '12:00');
  assert.equal(NL.parseQuickAdd('凌晨1点看球', '2026-10-08').time, '01:00');
  assert.equal(NL.parseQuickAdd('下午两点半开会', '2026-10-08').time, '14:30');
  assert.equal(NL.parseQuickAdd('8:30 站会', '2026-10-08').time, '08:30');
  assert.equal(NL.parseQuickAdd('没什么时间信息的一句话', '2026-10-08').time, null);
});

test('nl: 周几解析', () => {
  assert.equal(NL.parseQuickAdd('下周一交作业', '2026-10-08').date, '2026-10-12');
  assert.equal(NL.parseQuickAdd('周五团建', '2026-10-08').date, '2026-10-09');
  assert.equal(NL.parseQuickAdd('这周日看电影', '2026-10-08').date, '2026-10-11');
});

test('pomodoro: 完整循环', () => {
  let s = P.createState({ focusMin: 25, shortMin: 5, longMin: 15, cyclesBeforeLong: 2, autoStartBreak: true, autoStartFocus: true });
  let now = 1000;
  s = P.start(s, now, '写代码');
  assert.equal(s.phase, 'focus');
  assert.equal(P.remainMs(s, now), 25 * 60000);

  let r = P.tick(s, now + 25 * 60000);
  assert.equal(r.event, 'focus-done');
  s = r.state;
  assert.equal(s.phase, 'short');
  assert.equal(s.completedFocus, 1);

  r = P.tick(s, s.endsAt);
  assert.equal(r.event, 'break-done');
  s = r.state;
  assert.equal(s.phase, 'focus');
  assert.equal(s.cycle, 2);

  r = P.tick(s, s.endsAt);
  s = r.state;
  assert.equal(s.phase, 'long', '第 2 个番茄后应进入长休息');
  assert.equal(s.completedFocus, 2);
});

test('pomodoro: 暂停恢复与停止', () => {
  let s = P.start(P.createState({ focusMin: 10 }), 0);
  s = P.pause(s, 5 * 60000).state;
  assert.equal(s.phase, 'paused');
  assert.equal(P.remainMs(s, 9e9), 5 * 60000);
  s = P.resume(s, 100000).state;
  assert.equal(s.phase, 'focus');
  assert.equal(s.endsAt, 100000 + 5 * 60000);
  const done = P.stop(s);
  assert.equal(done.phase, 'idle');
});

test('stats: 进度 / 连签 / 热力图', () => {
  const tasks = T.parseTasks('09:00|A\r\n10:00|B');
  const done = { '2026-10-06': ['09:00|A', '10:00|B'], '2026-10-07': ['09:00|A', '10:00|B'], '2026-10-08': ['09:00|A'] };
  const p = ST.todayProgress(tasks, done, '2026-10-08');
  assert.deepEqual([p.total, p.done, p.pct, p.complete], [2, 1, 50, false]);
  assert.equal(ST.streak(['2026-10-06', '2026-10-07', '2026-10-08'], '2026-10-08'), 3);
  assert.equal(ST.streak(['2026-10-06', '2026-10-07'], '2026-10-08'), 2, '今天没完成从昨天起算');
  assert.equal(ST.longestStreak(['2026-10-01', '2026-10-02', '2026-10-05']), 2);
  const hm = ST.heatmap(tasks, done, 3, '2026-10-08');
  assert.equal(hm.length, 3);
  assert.equal(hm[2].pct, 50);
  assert.equal(hm[1].level, 4);
});
