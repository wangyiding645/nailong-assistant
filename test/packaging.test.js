'use strict';
/* 打包相关的回归测试
 *
 * 这些断言看着“像在看源码”，但对应的都是打包后才会暴露、而且一暴露就是白屏/数据丢失级别的坑：
 *   1. 数据目录落在只读的 app.asar 里 → 什么都写不进去
 *   2. portable 版把数据写在 %TEMP% 解压目录里 → 一关就没了
 *   3. 外部进程（PowerShell / pi 子进程）去读 asar 内的文件 → 直接报找不到
 *   4. auto 模式下预热被误判成“用内置”而跳过 → pi 内核永远起不来
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const P = require(path.join(SRC, 'main', 'paths.js'));

test('打包：数据目录绝不会落在 app.asar 里', () => {
  assert.equal(/app\.asar/.test(P.ROOT), false, 'ROOT 不能是 asar 内部路径：' + P.ROOT);
  // 开发时应当就是源码目录，保持既有数据不搬家
  assert.equal(P.ROOT, ROOT);
});

test('打包：portable 用 exe 目录，安装版用 %APPDATA%（覆盖安装不会删掉数据）', () => {
  const body = fs.readFileSync(path.join(SRC, 'main', 'paths.js'), 'utf8');
  assert.ok(/PORTABLE_EXECUTABLE_DIR/.test(body), 'exeDir() 必须优先看 PORTABLE_EXECUTABLE_DIR');

  const writable = () => true;
  const base = { explicit: '', packaged: true, portable: false, devRoot: 'C:\dev', exeDir: 'C:\install', roaming: 'C:\roaming', writable };
  assert.equal(P.chooseDataRoot(base), 'C:\roaming', '安装版的数据必须在 %APPDATA%，不能放安装目录');
  assert.equal(P.chooseDataRoot(Object.assign({}, base, { portable: true })), 'C:\install', '免安装版数据在 exe 旁边');
  assert.equal(P.chooseDataRoot(Object.assign({}, base, { packaged: false })), 'C:\dev', '源码跑保持源码目录，不搬家');
  assert.equal(P.chooseDataRoot(Object.assign({}, base, { explicit: 'C:\tmp\d' })), 'C:\tmp\d', '显式指定优先');
  assert.equal(P.chooseDataRoot(Object.assign({}, base, { writable: (d) => d !== 'C:\roaming' })), 'C:\install', '%APPDATA% 不可写时退回老行为');
});

test('打包：第一次启动会把旧位置（安装目录）里的用户数据搬到新家', () => {
  const os = require('node:os');
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'nailong-old-'));
  const neu = fs.mkdtempSync(path.join(os.tmpdir(), 'nailong-new-'));
  try {
    // 旧位置：装着密钥的设置、历史会话、pi 登录，以及一堆程序文件
    fs.writeFileSync(path.join(old, 'settings.json'), '{"agentCfg":{"key":"dpapi:user:v1:xxx"}}');
    fs.writeFileSync(path.join(old, 'reminders.json'), '{}');
    fs.mkdirSync(path.join(old, '.userdata', 'pi-agent'), { recursive: true });
    fs.mkdirSync(path.join(old, '.userdata', 'pi-sessions', '--cwd--'), { recursive: true });
    fs.mkdirSync(path.join(old, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(old, '.userdata', 'pi-agent', 'auth.json'), '{"p":1}');
    fs.writeFileSync(path.join(old, '.userdata', 'pi-sessions', '--cwd--', 's.jsonl'), '{}');
    fs.writeFileSync(path.join(old, 'nailong-assistant.exe'), 'MZ');
    fs.writeFileSync(path.join(old, 'resources', 'app.asar'), 'x');

    const moved = P.migrateLegacy(neu, old);
    assert.ok(moved.length >= 4, '至少要搬走设置、提醒、pi 登录和历史会话：' + JSON.stringify(moved));
    assert.equal(fs.existsSync(path.join(neu, 'settings.json')), true, '密钥所在的 settings.json 必须搬过来');
    assert.equal(fs.existsSync(path.join(neu, '.userdata', 'pi-agent', 'auth.json')), true, 'pi 的登录要保住');
    assert.equal(fs.existsSync(path.join(neu, '.userdata', 'pi-sessions', '--cwd--', 's.jsonl')), true, '历史会话要保住');
    assert.equal(fs.existsSync(path.join(old, 'settings.json')), false, '搬走的东西不留旧副本');
    // 程序文件不能被当成用户数据搬走
    assert.equal(fs.existsSync(path.join(neu, 'nailong-assistant.exe')), false);
    assert.equal(fs.existsSync(path.join(neu, 'resources')), false);
    // 再跑一次：新家已有就不动，安全
    fs.writeFileSync(path.join(neu, 'settings.json'), '{"newer":true}');
    P.migrateLegacy(neu, old);
    assert.equal(fs.readFileSync(path.join(neu, 'settings.json'), 'utf8'), '{"newer":true}', '已有文件不能被旧数据覆盖');
    // 同一个目录不算搬家
    assert.deepEqual(P.migrateLegacy(neu, neu), []);
  } finally {
    fs.rmSync(old, { recursive: true, force: true });
    fs.rmSync(neu, { recursive: true, force: true });
  }
});

test('打包：外部进程要用的资源走解包后的真实路径', () => {
  // native / pi-ext 是给 PowerShell 和 pi 子进程用的，绝不能指向 asar 内部
  assert.equal(/app\.asar[\\/]/.test(P.native + path.sep), false);
  assert.equal(/app\.asar[\\/]/.test(P.piExt + path.sep), false);
  assert.ok(P.unpacked, 'unpacked() 工具函数要保留（将来重新启用 asar 时用得上）');
  assert.equal(P.unpacked(P.native), P.native, '非 asar 路径应当原样返回');
});

test('打包：代码目录与数据目录是两个概念，不能混用', () => {
  assert.ok(P.code, '必须有 code 根（renderer/native/assets/node_modules 都靠它）');
  assert.notEqual(P.code, undefined);
  assert.ok(fs.existsSync(path.join(P.code, 'renderer', 'ui.css')), 'code 根下要能找到 renderer');
  assert.ok(fs.existsSync(path.join(P.native, 'win.ps1')), 'native 目录下要能找到脚本');
  assert.ok(fs.existsSync(path.join(P.piExt, 'nailong.mjs')), 'pi-ext 下要能找到扩展');
});

test('打包：auto 模式预热不能被 activeEngine() 误判掉', () => {
  const src = fs.readFileSync(path.join(SRC, 'main', 'engines', 'index.js'), 'utf8');
  const body = src.slice(src.indexOf('async warmUp()'), src.indexOf('async warmUp()') + 900);
  // 只看代码行：注释里提到 activeEngine() 不算数
  const code = body.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(/engineSetting\(\) === 'builtin'/.test(code), 'warmUp 应当按“设置”判断，而不是当前生效引擎');
  assert.equal(/activeEngine\(\)/.test(code), false,
    'warmUp 里不能用 activeEngine()：pi 未启动时它返回 builtin，会把预热直接跳过：\n' + code);
});

test('打包：activeEngine() 的优先级正确（已就绪/启动中/失败）', () => {
  const src = fs.readFileSync(path.join(SRC, 'main', 'engines', 'index.js'), 'utf8');
  const body = src.slice(src.indexOf('function activeEngine()'), src.indexOf('function activeEngine()') + 800);
  assert.ok(/if \(pi\.ready\) return pi\.model \? 'pi' : 'builtin'/.test(body), '就绪但没模型要退回内置');
  assert.ok(/if \(pi\.starting\) return 'pi'/.test(body), '启动中就先当 pi，别把消息路由到内置');
});

test('打包：electron-builder 配置能支持“点开即用”', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const b = pkg.build;
  assert.equal(b.asar, false, '这里刻意关掉 asar（外部进程读不了 asar），要留着这个决定');
  const targets = b.win.target.map((t) => t.target);
  assert.ok(targets.indexOf('portable') >= 0, '必须有 portable：双击就跑，不需要装');
  assert.ok(targets.indexOf('nsis') >= 0, '也要有 nsis 安装包');
  assert.equal(b.nsis.deleteAppDataOnUninstall, false, '卸载不能删用户数据');
  assert.ok(b.files.indexOf('pi-ext/**') >= 0, 'pi 扩展必须打进包');
  assert.ok(b.files.indexOf('native/**') >= 0, 'PowerShell 脚本必须打进包');
  assert.ok(b.files.indexOf('!**/scripts/**') >= 0, '开发脚本不该进包');
});
