'use strict';
/* 所有路径集中在这里
 *
 * 打包后有两个坑必须在这里解决：
 *
 *   1. **数据目录不能落在 app.asar 里**
 *      打包后 __dirname 是 <安装目录>/resources/app.asar/src/main —— 只读。
 *      ROOT 必须换算成真正可写的目录。
 *
 *   2. **portable 版每次运行会解压到 %TEMP% 下的随机目录**
 *      electron-builder 通过 PORTABLE_EXECUTABLE_DIR 告诉我们 exe 在哪。
 *      必须以它为准，否则用户数据会写在临时目录里、一关就没了。
 *
 * 于是这里区分两套根目录：
 *   code —— 代码/资源在哪（renderer / native / assets / pi-ext / node_modules）
 *           打包后在 app.asar 里；**外部进程（PowerShell、pi 子进程）读不了 asar**，
 *           所以需要解包的那几项通过 unpacked() 换成 app.asar.unpacked 的真实路径
 *   ROOT —— 用户数据在哪（可写）：
 *           显式 NAILONG_DATA_DIR → 源码跑用源码目录 → portable 用 exe 目录
 *           → **安装版用 %APPDATA%\奶蛙助手**
 *
 *   3. **安装版的数据不能放安装目录**
 *      NSIS 覆盖安装会先跑旧版卸载器，卸载器最后一步是 RMDir /r $INSTDIR ——
 *      放里面的 API 密钥（settings.json）、历史会话（.userdata/pi-sessions）、
 *      pi 的登录（.userdata/pi-agent）会被一起删掉。所以安装版固定用 %APPDATA%，
 *      并且第一次启动会把旧位置（安装目录）里的那些东西搬过来。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const CODE_ROOT = path.resolve(__dirname, '..', '..');

// 判定是否「打包后运行」：
//   Electron 里跑源码（electron .）→ process.defaultApp === true
//   纯 Node（单测）→ 没有 electron 版本号，当作开发环境
//   打包后的 exe → 有 electron 版本号且 defaultApp 不是 true
const IN_ELECTRON = !!process.versions.electron;
const DEV = !IN_ELECTRON || process.defaultApp === true;
const PACKAGED = !DEV;

/** 打包后 __dirname 形如 <root>/resources/app.asar/src/main，取 app.asar 的上一级（resources） */
function dirBeforeAsar(dir) {
  const parts = String(dir).split(/[\\/]/);
  const i = parts.indexOf('app.asar');
  if (i > 0) return parts.slice(0, i).join(path.sep);
  return '';
}

/** app.asar 里的文件 → app.asar.unpacked 里的真实路径（外部进程只能读后者） */
function unpacked(p) {
  const s = String(p);
  if (!/[\\/]app\.asar[\\/]/.test(s)) return s;
  return s.replace(/[\\/]app\.asar[\\/]/, path.sep + 'app.asar.unpacked' + path.sep);
}

function exeDir() {
  // portable 版：exe 所在目录由 electron-builder 告诉我们
  if (process.env.PORTABLE_EXECUTABLE_DIR) return path.resolve(process.env.PORTABLE_EXECUTABLE_DIR);
  // asar 打包：resources 的上一级就是 exe 目录
  const resources = dirBeforeAsar(__dirname);
  if (resources) return path.dirname(resources);
  // 非 asar 打包：代码在 <exe 目录>/resources/app，往上两层就是 exe 目录
  if (PACKAGED) return path.resolve(CODE_ROOT, '..', '..');
  return '';
}

function isWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.nailong-write-probe-' + require('crypto').randomBytes(8).toString('hex'));
    fs.writeFileSync(probe, '1', { encoding: 'utf8', flag: 'wx' });
    fs.unlinkSync(probe);
    return true;
  } catch (e) {
    return false;
  }
}

/** 安装版的数据家：%APPDATA%\奶蛙助手 —— 覆盖安装/卸载都不会碰它 */
function roamingDir() {
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '奶蛙助手');
}

const PORTABLE = !!process.env.PORTABLE_EXECUTABLE_DIR;

/**
 * 选数据根。逻辑单独拿出来是为了能直接单测（不依赖真的打包环境）。
 * @param {object} o { explicit, packaged, portable, devRoot, exeDir, roaming, writable }
 */
function chooseDataRoot(o) {
  const writable = o.writable || isWritable;
  if (o.explicit && writable(o.explicit)) return o.explicit;      // 测试/开发显式指定，听它的
  if (!o.packaged) {                                              // 源码跑：还是源码目录
    if (writable(o.devRoot)) return o.devRoot;
    return o.roaming;
  }
  if (o.portable && o.exeDir && writable(o.exeDir)) {
    // 免安装版：数据就在 exe 旁边（README 承诺：整个文件夹拷走就是完整搬家）
    return o.exeDir;
  }
  // 安装版：**不**把数据放安装目录 —— 覆盖安装的卸载器会把那目录整个删掉
  if (writable(o.roaming)) return o.roaming;
  if (o.exeDir && writable(o.exeDir)) return o.exeDir;            // %APPDATA% 不可写时退回老行为
  return path.join(os.tmpdir(), 'nailong-assistant');
}

function pickDataRoot() {
  return chooseDataRoot({
    explicit: process.env.NAILONG_DATA_DIR ? path.resolve(process.env.NAILONG_DATA_DIR) : '',
    packaged: PACKAGED,
    portable: PORTABLE,
    devRoot: CODE_ROOT,
    exeDir: exeDir(),
    roaming: roamingDir()
  });
}

// 从旧位置（安装目录）搬到新家时，只搬用户的东西，不动程序文件
const LEGACY_FILES = [
  'schedule.txt', 'countdown.txt', 'state.json', 'agent.json', 'settings.json',
  'agent-memory.json', 'agent-sessions.json', 'focus.json', 'reminders.json', 'clipboard.json',
  'pet.cfg', 'widget.cfg', 'popup.cfg'
];
// .userdata 里只有这两块是命根子：pi 的登录/模型库，以及历史会话；
// 剩下的 Electron 缓存（Cache / GPUCache…）没必要搬。
const LEGACY_DIRS = [path.join('.userdata', 'pi-agent'), path.join('.userdata', 'pi-sessions'), 'backups'];

function moveEntry(from, to) {
  try {
    fs.renameSync(from, to);            // 同一个盘就是瞬间事
    return true;
  } catch (e) { /* 跟盘不一致 / 目标被占 */ }
  try {
    fs.cpSync(from, to, { recursive: true, errorOnExist: false, force: false });
    fs.rmSync(from, { recursive: true, force: true });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 一次性搬家：新家还没有的东西，从旧位置（安装目录）搬过来。
 * 逐个条目判断，已有就不动 —— 所以重复跑安全。
 * @returns {Array} [{ from, to }] 实际搬了哪些，给启动日志用
 */
function migrateLegacy(root, from) {
  if (!from || path.resolve(from) === path.resolve(root)) return [];
  const moved = [];
  const entries = LEGACY_FILES.concat(LEGACY_DIRS);
  for (const rel of entries) {
    const src = path.join(from, rel);
    const dst = path.join(root, rel);
    try {
      if (fs.existsSync(dst) || !fs.existsSync(src)) continue;
    } catch (e) { continue; }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (moveEntry(src, dst)) moved.push({ from: src, to: dst });
  }
  return moved;
}

const ROOT = pickDataRoot();
const MIGRATED = migrateLegacy(ROOT, exeDir());

/** 代码侧资源（需要外部进程读的走 unpacked） */
const nativeDir = unpacked(path.join(CODE_ROOT, 'native'));
const piExtDir = unpacked(path.join(CODE_ROOT, 'pi-ext'));
const rendererDir = path.join(CODE_ROOT, 'renderer');     // Electron 自己读，asar 内没问题
const assetsDir = unpacked(path.join(CODE_ROOT, 'assets'));
const piPkgDir = unpacked(path.join(CODE_ROOT, 'node_modules', '@earendil-works', 'pi-coding-agent'));

const P = {
  // ---- 数据侧（可写，用户的东西都在这） ----
  ROOT: ROOT,
  migrated: MIGRATED,        // 这次启动从旧位置搬过来的东西（启动日志会写一条）
  packaged: PACKAGED,
  portable: PORTABLE,
  cache: path.join(ROOT, '.cache'),
  logs: path.join(ROOT, '.cache', 'logs'),
  userData: path.join(ROOT, '.userdata'),
  backups: path.join(ROOT, 'backups'),

  // 用户数据（v2 路径保持不变，升级不丢数据）
  tasks: path.join(ROOT, 'schedule.txt'),
  countdown: path.join(ROOT, 'countdown.txt'),
  state: path.join(ROOT, 'state.json'),
  agent: path.join(ROOT, 'agent.json'),
  petCfg: path.join(ROOT, 'pet.cfg'),
  widgetCfg: path.join(ROOT, 'widget.cfg'),
  popupCfg: path.join(ROOT, 'popup.cfg'),
  settings: path.join(ROOT, 'settings.json'),
  sessions: path.join(ROOT, 'agent-sessions.json'),
  memory: path.join(ROOT, 'agent-memory.json'),
  clipboard: path.join(ROOT, 'clipboard.json'),
  focus: path.join(ROOT, 'focus.json'),
  reminders: path.join(ROOT, 'reminders.json'),
  piSessions: path.join(ROOT, '.userdata', 'pi-sessions'),
  piAgent: path.join(ROOT, '.userdata', 'pi-agent'),
  popupBackdrop: path.join(ROOT, '.cache', 'popup-backdrop.png'),
  asstBackdrop: path.join(ROOT, '.cache', 'asst-backdrop.png'),

  // ---- 代码侧（只读资源） ----
  code: CODE_ROOT,
  native: nativeDir,
  piExt: piExtDir,
  renderer: rendererDir,
  assets: assetsDir,
  piPkg: piPkgDir,
  icon: path.join(assetsDir, 'icon.ico'),
  windowIcon: path.join(assetsDir, 'naifrog', 'icon.png'),
  unpacked: unpacked,

  // 需要备份/导出的用户数据文件
  backupFiles: [
    'schedule.txt', 'countdown.txt', 'state.json', 'agent.json',
    'settings.json', 'agent-memory.json', 'agent-sessions.json',
    'focus.json', 'pet.cfg', 'widget.cfg', 'popup.cfg'
  ]
};

module.exports = P;
module.exports.chooseDataRoot = chooseDataRoot;
module.exports.migrateLegacy = migrateLegacy;
