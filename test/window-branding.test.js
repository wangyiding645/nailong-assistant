'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nailong-brand-'));
process.env.NAILONG_DATA_DIR = temp;
class Window extends EventEmitter {
  constructor(options) { super(); this.options = options; this.webContents = { on() {} }; this.visible = false; this.destroyed = false; this.raises = 0; }
  loadFile() {} isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  isAlwaysOnTop() { return this.topmost; }
  setAlwaysOnTop(flag, level) { this.topmost = flag; this.level = level; }
  moveTop() { this.raises++; }
  showInactive() { this.visible = true; this.emit('show'); }
  destroy() { this.destroyed = true; this.emit('closed'); }
  setAppDetails(details) { this.details = details; }
}
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { BrowserWindow: Window, screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) } };
  return originalLoad.call(this, name, ...args);
};
const { createWindows } = require('../src/main/windows');
Module._load = originalLoad;
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
const make = () => createWindows({ app: { isPackaged: true }, log: { warn() {} }, settings: {} }).createSettings();
test('taskbar-visible windows declare a stable native character icon and app identity', () => {
  const win = make();
  assert.equal(win.details?.appId, 'com.nailong.assistant');
  assert.ok(win.details.appIconPath.startsWith(temp + path.sep));
  assert.equal(fs.existsSync(win.details.appIconPath), true);
  assert.deepEqual(fs.readFileSync(win.details.appIconPath), fs.readFileSync(path.join(__dirname, '../assets/icon.ico')));
  assert.equal(win.options.icon.endsWith('icon.ico'), true);
  assert.equal(win.details.relaunchDisplayName, '奶蛙助手');
});
test('portable relaunch targets the original exe rather than its temporary extracted process', () => {
  const old = process.env.PORTABLE_EXECUTABLE_FILE;
  const exe = path.join(temp, 'portable folder', '奶蛙助手.exe');
  process.env.PORTABLE_EXECUTABLE_FILE = exe;
  try { assert.equal(make().details?.relaunchCommand, '"' + exe + '"'); }
  finally { if (old === undefined) delete process.env.PORTABLE_EXECUTABLE_FILE; else process.env.PORTABLE_EXECUTABLE_FILE = old; }
});

test('pet starts at the highest overlay level and restores z-order without focusing', (t) => {
  const manager = createWindows({ app: { isPackaged: true }, log: { warn() {} }, settings: {} });
  t.after(() => manager.dispose());
  const pet = manager.createPet();
  pet.emit('ready-to-show');
  assert.equal(pet.level, 'screen-saver');
  assert.equal(pet.topmost, true);
  assert.ok(pet.raises > 0);
  const count = pet.raises; pet.emit('blur');
  assert.ok(pet.raises > count);
});

test('pet restores topmost on the next tick, respects hiding and releases its timer on close', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const manager = createWindows({ app: { isPackaged: true }, log: { warn() {} }, settings: {} });
  const pet = manager.createPet(); pet.emit('ready-to-show');
  pet.topmost = false; t.mock.timers.tick(1000);
  assert.equal(pet.topmost, true);
  pet.visible = false; const count = pet.raises;
  t.mock.timers.tick(2000); assert.equal(pet.raises, count);
  pet.destroy(); t.mock.timers.tick(2000); assert.equal(pet.raises, count);
});
