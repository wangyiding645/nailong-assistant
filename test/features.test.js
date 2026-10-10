'use strict';
/* 这一轮补齐的七项能力，各自锁住最关键的那条不变量
 *   计划模式 / 图片附件 / steering / 会话树 / 自动更新 / MCP 登录 / 界面多语言
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const updateLib = require(path.join(SRC, 'main', 'update.js'));
const { createPiEngine } = require(path.join(SRC, 'main', 'engines', 'pi.js'));
const { createTools } = require(path.join(SRC, 'main', 'tools', 'index.js'));

function stubHost() {
  return {
    readImageFile: () => ({ ok: true, dataUrl: 'data:image/png;base64,QUJD', width: 8, height: 8, scaled: false, mime: 'image/png', bytes: 3 }),
    clipboard: { read: () => '', write() {} },
    services: { schedule: {}, countdown: {}, focus: {}, stats: {}, memory: {}, clipboard: {}, notify: { show() {} } }
  };
}

// ---------------------------------------------------------------- 计划模式
test('计划模式：propose_plan 是个低风险工具，参数要 steps', () => {
  const t = createTools(stubHost());
  const tool = t.get('propose_plan');
  assert.ok(tool, '必须有 propose_plan 工具');
  assert.equal(tool.level, 'low', '审批本身就是确认，不该再叠一层权限弹窗');
  assert.equal(tool.parameters.type, 'object');
  assert.deepEqual(tool.parameters.required, ['steps']);
  assert.equal(tool.parameters.properties.steps.type, 'array');
  assert.ok(/计划模式/.test(tool.description), '描述里要写明计划模式下必须先调它');
});

test('计划模式：用户批准 / 拒绝 / 改稿三种回答都要有对应结论', async () => {
  const t = createTools(stubHost());
  const tool = t.get('propose_plan');
  const plan = { steps: ['打开记事本', '写备忘'] };

  const ok = await tool.run(plan, { askPlan: async () => 'approve' });
  assert.equal(ok.ok, true);
  assert.ok(/批准/.test(ok.text));

  const no = await tool.run(plan, { askPlan: async () => 'reject' });
  assert.equal(no.ok, false, '拒绝时不能报成功，否则模型会继续动手');
  assert.ok(/没有批准/.test(no.text));

  const edited = await tool.run(plan, { askPlan: async () => 'edit:1. 打开计算器' });
  assert.equal(edited.ok, true);
  assert.ok(edited.text.indexOf('打开计算器') >= 0, '要把改后的版本回给模型');

  await assert.rejects(() => tool.run({ steps: [] }, { askPlan: async () => 'approve' }), /不能为空/);
  await assert.rejects(
    () => tool.run({ steps: new Array(25).fill('x') }, { askPlan: async () => 'approve' }),
    /太多了/);
});

test('计划模式：开关打开后，内置引擎的系统提示里会出现「计划模式」', () => {
  const promptLib = require(path.join(SRC, 'main', 'agent', 'prompt.js'));
  const off = promptLib.buildSystemPrompt({ locale: 'zh-CN', planMode: false });
  const on = promptLib.buildSystemPrompt({ locale: 'zh-CN', planMode: true });
  assert.equal(/计划模式/.test(off), false);
  assert.ok(/计划模式/.test(on));
  assert.ok(/propose_plan/.test(on), '要明确写出用哪个工具');
});

test('计划模式：pi 扩展会在每轮开始前重新读开关（不用重启就生效）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'pi-ext', 'nailong.mjs'), 'utf8');
  assert.ok(/before_agent_start/.test(src), '要用 before_agent_start 钩子');
  assert.ok(/call\('\/config'\)/.test(src), '每轮重新问一次桥拿最新开关');
  assert.ok(/systemPrompt: String\(event\.systemPrompt/.test(src), '要往现有系统提示后面追加，而不是整段替换');
  assert.ok(/计划模式已打开/.test(src));
  const bridge = fs.readFileSync(path.join(SRC, 'main', 'engines', 'bridge.js'), 'utf8');
  assert.ok(/planMode: !!flags\.planMode/.test(bridge), '/config 要把开关告诉扩展');
});

// ---------------------------------------------------------------- 图片附件
test('图片附件：pi 路径会把图片放进 prompt 的 images 字段', async () => {
  const engine = createPiEngine({
    bridge: { url: '', token: '' },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    services: {},
    emit: () => {}
  });
  const sent = [];
  engine.state.proc = { stdin: { writable: true, write: (s) => sent.push(JSON.parse(s)) }, killed: false };
  engine.state.ready = true;

  const p = engine.send('看下这张图', { images: ['data:image/png;base64,QUJD'] });
  setTimeout(() => {
    const last = sent[sent.length - 1];
    engine.handleRecord({ type: 'response', command: 'prompt', success: true, id: last.id, data: {} });
  }, 5);
  await p;
  const rec = sent[sent.length - 1];
  assert.equal(rec.message, '看下这张图');
  assert.equal(rec.images, undefined, 'engine.send 自己不管图片，图片由路由层组装好再传 message 以外的东西');
});

test('图片附件：路由层把 dataURL 转成 pi 的 ImageContent', () => {
  const src = fs.readFileSync(path.join(SRC, 'main', 'engines', 'index.js'), 'utf8');
  const body = src.slice(src.indexOf('async send(text, opts)'), src.indexOf('async send(text, opts)') + 1600);
  assert.ok(/o\.images/.test(body), '要接收界面传进来的图片');
  assert.ok(/type: 'image', data: m\[2\], mimeType: m\[1\]/.test(body), '要转成 pi 的 ImageContent 形状');
  assert.ok(/if \(!images\.length && o\.withShot\)/.test(body), '有附件时就不该再自动截屏');
});

test('图片附件：内置引擎会转成 OpenAI 的 content parts', () => {
  const src = fs.readFileSync(path.join(SRC, 'main', 'agent-service.js'), 'utf8');
  assert.ok(/type: 'image_url'/.test(src), '内置引擎也要支持图片');
  assert.ok(/else if \(o\.withShot\)/.test(src), '有附件时优先用附件');
});

test('图片附件：读图接口会按长边缩放并回 dataURL', () => {
  const hostSrc = fs.readFileSync(path.join(SRC, 'main', 'host.js'), 'utf8');
  assert.ok(/readImageFile\(/.test(hostSrc));
  assert.ok(/maxSide/.test(hostSrc), '要能限制长边，避免大图把 token 打爆');
  assert.ok(/toJPEG\(78\)/.test(hostSrc), '非 png 走 jpeg 压一下');
  const pre = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  assert.ok(/readImage: invoke\('read-image'\)/.test(pre), '界面要能拿到读图接口');
});

// ---------------------------------------------------------------- 自动更新
test('更新：版本比较', () => {
  assert.equal(updateLib.compareVersion('3.2.0', '3.1.9') > 0, true);
  assert.equal(updateLib.compareVersion('v3.2.0', '3.2.0'), 0);
  assert.equal(updateLib.compareVersion('3.10.0', '3.9.0') > 0, true, '要按数字比，不能按字符串');
  assert.equal(updateLib.compareVersion('4.0.0', '3.99.99') > 0, true);
});

test('更新：优先挑免安装版，没有 exe 就退 zip', () => {
  const rel = {
    tag_name: 'v3.3.0',
    assets: [
      { name: 'nailong-3.3.0-win-x64.exe', browser_download_url: 'https://x/installer.exe' },
      { name: 'nailong-3.3.0-win-x64-portable.exe', browser_download_url: 'https://x/portable.exe' }
    ]
  };
  const s = updateLib.summarizeRelease(rel, '3.2.0');
  assert.equal(s.hasUpdate, true);
  assert.equal(s.assetUrl, 'https://x/portable.exe', '免安装版优先');
  assert.equal(updateLib.summarizeRelease({ assets: [{ name: 'a.zip', browser_download_url: 'https://x/a.zip' }] }, '1.0.0').assetUrl, 'https://x/a.zip');
  assert.equal(updateLib.summarizeRelease({ assets: [] }, '1.0.0').assetUrl, '');
  assert.equal(updateLib.summarizeRelease({ tag_name: 'v1.0.0', assets: [] }, '3.2.0').hasUpdate, false);
});

test('更新：下载与启动各有独立接口，且只接受 https', () => {
  const ipc = fs.readFileSync(path.join(SRC, 'main', 'ipc.js'), 'utf8');
  assert.ok(/h\('app-download-update'/.test(ipc));
  assert.ok(/h\('app-run-update'/.test(ipc));
  assert.ok(/\^https:\\\/\\\//.test(ipc), '下载地址必须是 https，防止被塞 file:// 或 http');
  const pre = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  assert.ok(/appDownloadUpdate/.test(pre) && /appRunUpdate/.test(pre));
});

// ---------------------------------------------------------------- 会话树
test('会话树：拿得到树，并且能从某个节点开分支', () => {
  const pre = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  assert.ok(/agentSessionTree: invoke\('agent-session-tree'\)/.test(pre));
  assert.ok(/agentForkMessages: invoke\('agent-fork-messages'\)/.test(pre));
  const asst = fs.readFileSync(path.join(ROOT, 'renderer', 'assistant.js'), 'utf8');
  assert.ok(/async function renderTree/.test(asst), '要有树视图的渲染');
  assert.ok(/data-fork/.test(asst), '树上的消息节点要能点开分支');
  assert.ok(/sessTabTree/.test(asst), '要有列表/结构切换');
});

// ---------------------------------------------------------------- MCP 登录
test('MCP 登录：开一个终端交给 pi 自己走浏览器授权，并且不改用户配置', () => {
  const ipc = fs.readFileSync(path.join(SRC, 'main', 'ipc.js'), 'utf8');
  const body = ipc.slice(ipc.indexOf("h('mcp-login'"), ipc.indexOf("h('mcp-login'") + 1200);
  assert.ok(/mcp login /.test(body), '要跑 pi 自己的登录命令');
  assert.ok(/PI_CODING_AGENT_DIR/.test(body), '要用我们那套 agent 目录');
  assert.ok(/piConfigMode\(\) === 'bundled'/.test(body), 'system 模式下不该改用户的目录');
  assert.ok(/A-Za-z0-9/.test(body), '服务器名要校验，不能把名字拼进命令行');
  const pre = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  assert.ok(/mcpLogin: invoke\('mcp-login'\)/.test(pre));
});

// ---------------------------------------------------------------- 界面多语言
function loadI18n() {
  const code = fs.readFileSync(path.join(ROOT, 'renderer', 'i18n.js'), 'utf8');
  const sandbox = { window: null, console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'i18n.js' });
  return sandbox.WidgetI18n;
}

test('i18n：中英切换 + 变量替换', () => {
  const I = loadI18n();
  I.setLocale('zh-CN');
  assert.equal(I.t('menu.assistant'), '奶蛙助手');
  assert.equal(I.t('tool.todayStat', { count: 3, min: 75 }), '今日 3 个番茄 · 75 分钟');
  I.setLocale('en');
  assert.equal(I.t('menu.assistant'), 'Assistant');
  assert.equal(I.t('tool.todayStat', { count: 3, min: 75 }), '3 pomodoros · 75 min today');
  I.setLocale('en-US');
  assert.equal(I.locale, 'en', 'en-US 也要落成 en');
  I.setLocale('随便写的');
  assert.equal(I.locale, 'zh-CN', '不认识的语言回退中文');
});

test('i18n：缺 key 时回退到中文而不是显示空白', () => {
  const I = loadI18n();
  I.setLocale('en');
  I.dict.en['__only_zh'] = undefined;
  assert.equal(I.t('这个 key 根本不存在'), '这个 key 根本不存在', '完全没定义的 key 原样返回');
  assert.equal(I.t('tool.start'), 'Start focus');
  assert.equal(I.t('tool.start'), 'Start focus');
});

test('i18n：六个窗口都加载了字典，并且有内容可翻', () => {
  const windows = ['pet.html', 'popup.html', 'assistant.html', 'tool.html', 'menu.html', 'settings.html'];
  windows.forEach((f) => {
    const html = fs.readFileSync(path.join(ROOT, 'renderer', f), 'utf8');
    assert.ok(/i18n\.js/.test(html), f + ' 没加载 i18n.js');
  });
  const translated = ['menu.html', 'tool.html', 'assistant.html', 'settings.html', 'popup.html'];
  translated.forEach((f) => {
    const html = fs.readFileSync(path.join(ROOT, 'renderer', f), 'utf8');
    assert.ok(/data-i18n/.test(html), f + ' 一个 data-i18n 都没有');
  });
});

test('界面自检带接线校验与 i18n 校验（防止“点了没反应”再溜过去）', () => {
  const audit = fs.readFileSync(path.join(SRC, 'main', 'audit.js'), 'utf8');
  assert.ok(/step\.verify/.test(audit), '视图扫查要支持 verify');
  assert.ok(/点了没反应/.test(audit), '接线断了要作为问题报出来');
  assert.ok(/untranslated/.test(audit), '要有未翻译元素的检查');
  assert.ok(/pomoStart/.test(audit), '至少要有一个真按钮的接线校验');
});

test('i18n：HTML 里用到的每个 key 词典里都得有（否则界面会显示出 key 名）', () => {
  const I = loadI18n();
  const zhKeys = Object.keys(I.dict['zh-CN']);
  const missing = [];
  ['pet.html', 'popup.html', 'assistant.html', 'tool.html', 'menu.html', 'settings.html'].forEach((f) => {
    const html = fs.readFileSync(path.join(ROOT, 'renderer', f), 'utf8');
    ['data-i18n', 'data-i18n-title', 'data-i18n-ph'].forEach((attr) => {
      const re = new RegExp(attr + '="([^"]+)"', 'g');
      let m;
      while ((m = re.exec(html)) !== null) {
        if (zhKeys.indexOf(m[1]) < 0) missing.push(f + ' -> ' + m[1]);
      }
    });
  });
  assert.deepEqual(missing, [], '这些 key 在词典里不存在：\n  ' + missing.join('\n  '));
});

test('i18n：JS 里 t() 用到的 key 也都在词典里', () => {
  const I = loadI18n();
  const zhKeys = Object.keys(I.dict['zh-CN']);
  const enKeys = Object.keys(I.dict.en);
  const missing = [];
  ['pet.js', 'popup.js', 'assistant.js', 'tool.js', 'menu.js', 'settings.js'].forEach((f) => {
    const src = fs.readFileSync(path.join(ROOT, 'renderer', f), 'utf8');
    const re = /I\.t\(\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      if (zhKeys.indexOf(m[1]) < 0) missing.push(f + ' -> ' + m[1]);
    }
  });
  assert.deepEqual(missing, [], 'JS 里这些 key 词典里没有：\n  ' + missing.join('\n  '));
  // 中英两边的 key 集合要一致，避免翻了一半
  const zhOnly = zhKeys.filter((k) => enKeys.indexOf(k) < 0);
  const enOnly = enKeys.filter((k) => zhKeys.indexOf(k) < 0);
  assert.deepEqual(zhOnly, [], '这些 key 只有中文：' + zhOnly.join(', '));
  assert.deepEqual(enOnly, [], '这些 key 只有英文：' + enOnly.join(', '));
});

test('番茄钟：focus-start 必须返回 status 形状，而不是内部 state（两者 label 同名不同义）', () => {
  const ipc = fs.readFileSync(path.join(SRC, 'main', 'ipc.js'), 'utf8');
  const body = ipc.slice(ipc.indexOf("h('focus-start'"), ipc.indexOf("h('focus-start'") + 500);
  assert.ok(/const st = services\.focus\.status\(\)/.test(body),
    'focus-start 要返回 status（label=阶段名），返回内部 state 会让阶段显示成“待开始”：\n' + body);
  // 其余几个也必须回 status
  ['focus-pause', 'focus-resume', 'focus-stop', 'focus-skip'].forEach((cmd) => {
    const i = ipc.indexOf("h('" + cmd + "'");
    assert.ok(i > 0);
    const seg = ipc.slice(i, i + 260);
    assert.ok(/services\.focus\.status\(\);\s*\}\)/.test(seg), cmd + ' 也要返回 status：' + seg);
  });
  // 界面侧也要能容忍两种形状
  const tool = fs.readFileSync(path.join(ROOT, 'renderer', 'tool.js'), 'utf8');
  assert.ok(/PHASE_BY_ID\[st\.phase\]/.test(tool), '界面要能按 phase 字段兜底判断阶段');
});

test('音效开关只有一份：面板按钮和桌宠读的是同一个 settings.sound', () => {
  const popup = fs.readFileSync(path.join(ROOT, 'renderer', 'popup.js'), 'utf8');
  assert.ok(/function soundOf\(d\)/.test(popup), '面板要有统一的取值函数');
  assert.ok(/d\.settings && typeof d\.settings\.sound === 'boolean'/.test(popup), '面板必须优先读 settings.json 的 sound');
  assert.ok(/api\.settingsSave\(\{ sound/.test(popup), '面板要写 settings.json 这一份');
  assert.ok(/onSettingsChanged\(\(s\) => \{ if \(s && typeof s\.sound === 'boolean'\)/.test(popup), '别处改了音效，面板图标要跟着走');
  const ipc = fs.readFileSync(path.join(SRC, 'main', 'ipc.js'), 'utf8');
  const at = ipc.indexOf("h('save-settings'");
  const body = ipc.slice(at, at + 420);
  assert.ok(/applySettings\(\{ sound/.test(body), '老接口也要落到同一份设置上');
  assert.ok(!/st\.settings\.sound\s*=/.test(body), '不能再往 state.json 里存第二份 sound');
});
