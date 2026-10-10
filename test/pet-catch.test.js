'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { screen: { getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }), getCursorScreenPoint: () => ({ x: -1000, y: -1000 }) } };
  return originalLoad.call(this, name, ...args);
};
const { createPetActions } = require('../src/main/pet-actions');
Module._load = originalLoad;
function fixture(t, scale = 1) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1000 });
  let bounds = { x: 450, y: 360, width: 190 * scale, height: 230 * scale };
  const messages = [], endings = [];
  const win = { getBounds: () => ({ ...bounds }), setBounds: b => { bounds = { ...b }; } };
  const game = createPetActions({ windows: {
    petSize: () => ({ w: Math.round(190 * scale), h: Math.round(230 * scale) }),
    petScale: () => scale,
    get: () => win,
    send: (kind, channel, value) => messages.push(value)
  }, native: {}, log: {}, onCatchEnd: result => endings.push(result) });
  return { game, messages, endings, win };
}
test('catch success emits one finish and leaves the running state', t => {
  const { game, messages, endings } = fixture(t);
  game.start(); t.mock.timers.tick(1200); game.stop(true);
  assert.equal(game.isCatching(), false);
  assert.equal(messages.filter(m => m.action === 'catch-end' && m.caught).length, 1);
  assert.equal(endings.length, 1);
  assert.equal(endings[0].reason, 'caught');
  game.stop(true); assert.equal(endings.length, 1);
});
test('a finished round cannot teleport a newly started round', t => {
  const { game, win } = fixture(t);
  game.start(); game.stop(true);
  win.setBounds({ x: 220, y: 160, width: 190, height: 230 });
  game.start(); t.mock.timers.tick(2600);
  assert.notDeepEqual(win.getBounds(), { x: 450, y: 360, width: 190, height: 230 });
  game.stop(false);
});
test('timeout emits an explicit finish reason once', t => {
  const { game, endings } = fixture(t);
  game.start(); t.mock.timers.tick(30000);
  assert.equal(game.isCatching(), false);
  assert.equal(endings.length, 1);
  assert.equal(endings[0].reason, 'timeout');
  t.mock.timers.tick(30000); assert.equal(endings.length, 1);
});
test('restarting a round does not report it as a timeout or win', t => {
  const { game, endings } = fixture(t);
  game.start(); game.start();
  assert.equal(game.isCatching(), true);
  assert.equal(endings.length, 1);
  assert.equal(endings[0].reason, 'restart');
  game.stop(false);
});
test('长大后的奶蛙带着更大窗口和小游戏边界跑', t => {
  const { game, win } = fixture(t, 2);
  win.setBounds({ x: 450, y: 100, width: 380, height: 460 });
  game.start();
  t.mock.timers.tick(5000);
  const b = win.getBounds();
  assert.equal(b.width, 380, '窗口宽度跟着体型');
  assert.equal(b.height, 460, '窗口高度跟着体型');
  // 角色本体（窗口内 47/126 处，96×104）始终留在工作区里，偏移量要跟着体型一起放大
  const left = b.x + 47 * 2, top = b.y + 126 * 2;
  assert.ok(left >= 0 && top >= 0, '本体不能跑出左上角：' + left + ',' + top);
  assert.ok(left + 96 * 2 <= 1280 && top + 104 * 2 <= 720, '本体不能跑出右下角：' + left + ',' + top);
  game.stop(true);
});
