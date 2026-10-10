'use strict';
/* 助手对话窗：流式输出 + 工具时间线 + 权限确认 + 会话管理 */

const $ = (id) => document.getElementById(id);
const api = window.widget;
const I = window.WidgetI18n || { t: (k) => k, setLocale() {}, applyDom() {} };

const S = {
  auto: false,
  withShot: false,
  busy: false,
  pending: null,
  pinned: true,
  streamEl: null,
  streamText: '',
  thinkEl: null,
  thinkText: '',
  engine: '',
  attach: [],
  plan: null,
  toolEls: {},
  started: false
};

// ---------------------------------------------------------------- 小工具
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 极简 markdown：够用就好（加粗、行内代码、标题、列表、链接） */
function md(text) {
  let s = esc(text);
  s = s.replace(/```([\s\S]*?)```/g, (m, code) => '<code style="display:block;padding:6px 8px;margin:4px 0;white-space:pre-wrap">' + code.trim() + '</code>');
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/^#{1,4}\s+(.+)$/gm, '<span class="md-h">$1</span>');
  s = s.replace(/^\s*[-*]\s+(.+)$/gm, '<span class="md-li">$1</span>');
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" style="color:var(--accent)">$1</a>');
  return s;
}

/** 切会话 / 清屏时把流式状态也一并清干净，否则会往旧气泡里继续追加 */
function flushStreamState() {
  S.streamEl = null;
  S.streamText = '';
  S.thinkEl = null;
  S.thinkText = '';
  S.toolEls = {};
  setBusy(false);
}

function scrollBottom() {
  const m = $('msgs');
  m.scrollTop = m.scrollHeight;
}

function addMsg(kind, text, opts) {
  const div = document.createElement('div');
  div.className = 'msg ' + kind;
  if (opts && opts.markdown) div.innerHTML = md(text);
  else div.textContent = text;
  if (opts && opts.shot) {
    const img = document.createElement('img');
    img.className = 'shot';
    img.src = opts.shot;
    div.appendChild(img);
  }
  if ($('assistantWelcome')) $('assistantWelcome').remove();
  $('msgs').appendChild(div);
  scrollBottom();
  return div;
}

function show(view) {
  $('v-setup').className = 'view setup' + (view === 'setup' ? '' : ' hidden');
  $('v-setup').style.display = view === 'setup' ? '' : 'none';
  $('v-chat').style.display = view === 'chat' ? '' : 'none';
  if (view === 'setup') $('v-setup').style.display = 'flex';
  if (view === 'chat') $('v-chat').style.display = 'flex';
}

function renderWelcome() {
  if ($('msgs').children.length) return;
  const welcome = document.createElement('div');
  welcome.id = 'assistantWelcome';
  welcome.innerHTML = '<img src="../assets/naifrog/icon.png" alt="奶娃"><h2>奶娃在这儿</h2><p>说说你想做什么，我来帮忙。</p><button data-starter="看看我屏幕上有什么">看看屏幕</button><button data-starter="列出我今天的日程">查看今日日程</button><button data-starter="25 分钟后提醒我休息">安排提醒</button>';
  $('msgs').appendChild(welcome);
  welcome.querySelectorAll('button').forEach(button => { button.onclick = () => { $('msgInput').value = button.dataset.starter; $('msgInput').focus(); }; });
}

// ---------------------------------------------------------------- 工具卡片
function toolCard(evt) {
  if (S.toolEls[evt.id]) {
    if (evt.running) S.toolEls[evt.id].querySelector('.ms').textContent = '运行中…';
    return S.toolEls[evt.id];
  }
  const el = document.createElement('div');
  el.className = 'tool' + (evt.parent ? ' nested' : '');
  const args = JSON.stringify(evt.args || {}, null, 2);
  el.innerHTML = '<div class="th"><span class="nm">' + esc(evt.name) + '</span>'
    + '<span class="ds">' + esc(evt.desc || '') + '</span><span class="ms">运行中…</span></div>'
    + '<div class="tb">输入\n' + esc(args) + '</div>';
  el.querySelector('.th').onclick = () => el.classList.toggle('open');
  if ($('assistantWelcome')) $('assistantWelcome').remove();
  $('msgs').appendChild(el);
  S.toolEls[evt.id] = el;
  scrollBottom();
  return el;
}

function toolResult(evt) {
  const el = S.toolEls[evt.id];
  if (!el) {
    addMsg('sys', '工具 ' + evt.name + '（' + (evt.ok ? '完成' : '失败') + '）：' + String(evt.text || '').slice(0, 200));
    return;
  }
  if (!evt.ok) el.classList.add('fail');
  el.querySelector('.ms').textContent = (evt.ok ? '' : '失败 · ') + (evt.ms || 0) + 'ms';
  const body = el.querySelector('.tb');
  body.textContent = (body.textContent ? body.textContent + '\n\n输出\n' : '') + String(evt.text || '');
  (evt.images || []).forEach((url) => {
    const img = document.createElement('img');
    img.className = 'shot';
    img.src = url;
    img.style.cursor = 'zoom-in';
    img.onclick = () => {
      img.style.maxWidth = img.style.maxWidth === '100%' ? '150px' : '100%';
    };
    body.appendChild(img);
  });
  delete S.toolEls[evt.id];
  scrollBottom();
}

// ---------------------------------------------------------------- 待确认
function setPending(p) {
  S.pending = p || null;
  const box = $('pending');
  if (!p) { box.style.display = 'none'; return; }
  box.style.display = '';
  const isQ = p.kind === 'question';
  $('pendingDesc').textContent = (isQ ? '❓ 奶蛙问你：' : '即将执行：') + (p.question || p.desc || p.tool) + (!isQ && p.reason ? '（' + p.reason + '）' : '');
  $('pendingArgs').textContent = isQ ? '' : (p.preview || (p.args && Object.keys(p.args).length ? JSON.stringify(p.args, null, 1) : ''));
  $('pendingAnswer').style.display = isQ ? '' : 'none';
  $('execBtn').textContent = isQ ? '提交回答' : '执行';
  $('skipBtn').textContent = isQ ? '取消' : '跳过';
  $('autoBtn').style.display = isQ ? 'none' : '';
  if (isQ) setTimeout(() => $('answerInput').focus(), 50);
  scrollBottom();
}

// ---------------------------------------------------------------- 计划审批
function showPlan(plan) {
  S.plan = plan || null;
  const box = $('planBox');
  if (!plan) { box.style.display = 'none'; return; }
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  $('planTitle').textContent = I.t('asst.planTitle', { n: steps.length });
  $('planSteps').innerHTML = steps.map((t) => '<li>' + esc(t) + '</li>').join('');
  const notes = String(plan.notes || '');
  $('planNotes').textContent = notes ? (I.t('asst.planNotes') + notes) : '';
  $('planNotes').style.display = notes ? '' : 'none';
  $('planEditBox') && $('planEditBox').remove();
  box.style.display = '';
  scrollBottom();
}

function planEditMode() {
  if (!S.plan) return;
  if ($('planEditBox')) return;
  const ta = document.createElement('textarea');
  ta.id = 'planEditBox';
  ta.rows = 4;
  ta.value = (S.plan.steps || []).map((t, i) => (i + 1) + '. ' + t).join('\n');
  ta.placeholder = '每行一步，序号可留可去';
  const acts = $('planBox').querySelector('.acts');
  $('planBox').insertBefore(ta, acts);
  ta.focus();
  $('planOk').textContent = I.t('asst.planApproved');
  $('planEdit').textContent = I.t('common.cancel');
  $('planEdit').onclick = () => { ta.remove(); bindPlanButtons(); };
}

async function answerPlan(choice) {
  const plan = S.plan;
  showPlan(null);
  let value = choice;
  if (choice === 'edit') {
    const ta = $('planEditBox');
    const text = ta ? ta.value.split(/\r?\n/).map((x) => x.replace(/^\s*\d+[.、)]\s*/, '').trim()).filter(Boolean).join('\n') : '';
    if (!text) { addMsg('sys', '没改成东西，当作没批准'); value = 'reject'; }
    else value = 'edit:' + text;
  }
  setBusy(true);
  const res = await api.agentConfirm({ choice: value });
  if (res && res.error) { setBusy(false); addMsg('err', 'x ' + res.error); return; }
  if (S.engine !== 'pi') { finishStream(); setBusy(false); }
  if (plan) addMsg('sys', I.t(choice === 'approve' ? 'asst.planApproved' : choice === 'reject' ? 'asst.planRejected' : 'asst.planEdited'));
}

function bindPlanButtons() {
  $('planOk').textContent = I.t('asst.planOk');
  $('planEdit').textContent = I.t('asst.planEdit');
  $('planOk').onclick = () => {
    const ta = $('planEditBox');
    answerPlan(ta ? 'edit' : 'approve');
  };
  $('planEdit').onclick = () => planEditMode();
  $('planNo').onclick = () => answerPlan('reject');
}

// ---------------------------------------------------------------- 附件（拖图）
const IMG_RE = /\.(png|jpe?g|gif|bmp|webp|ico)$/i;

async function addAttachments(paths) {
  const files = (paths || []).filter((p) => IMG_RE.test(p));
  if (!files.length) { addMsg('sys', I.t('asst.noImage')); return; }
  for (const p of files) {
    const r = await api.readImage({ path: p, maxSide: 1400 });
    if (!r || !r.ok) { addMsg('err', 'x 读不了 ' + p + '：' + ((r && r.error) || '')); continue; }
    S.attach.push({ path: p, dataUrl: r.dataUrl, width: r.width, height: r.height });
  }
  renderAttach();
}

function renderAttach() {
  const strip = $('attachStrip');
  if (!S.attach.length) { strip.style.display = 'none'; strip.innerHTML = ''; return; }
  strip.style.display = '';
  strip.innerHTML = S.attach.map((a, i) =>
    '<div class="attach" title="' + esc(a.path) + '"><img src="' + a.dataUrl + '"><span class="x" data-i="' + i + '">x</span></div>').join('');
  Array.prototype.forEach.call(strip.querySelectorAll('.x'), (el) => {
    el.onclick = () => { S.attach.splice(parseInt(el.getAttribute('data-i'), 10), 1); renderAttach(); };
  });
}

// ---------------------------------------------------------------- 用量 / 模式
function renderUsage(u) {
  if (u) S.usage = u;
  const label = S.engine === 'pi' ? 'pi' : (S.engine ? '内置' : '');
  const percent = S.usage && S.usage.context && Number(S.usage.context.percent);
  const ctx = Number.isFinite(percent) && S.usage && S.usage.context ? ' · 上下文 ' + (Math.round(percent * 10) / 10) + '%' : '';
  if (!S.usage) { $('usage').textContent = label + ctx; return; }
  const usd = S.usage.usd ? '$' + (S.usage.usd < 0.01 ? S.usage.usd.toFixed(4) : S.usage.usd.toFixed(3)) : '';
  $('usage').textContent = [label, (S.usage.calls || 0) + ' 次', ((S.usage.total || 0) / 1000).toFixed(1) + 'k tok', usd].filter(Boolean).join(' · ') + ctx;
}

function renderMode() {
  $('modeToggle').className = 'pill warn' + (S.auto ? ' on' : '');
  $('modeToggle').textContent = S.auto ? ('⚡ ' + I.t('asst.autoMode')) : I.t('asst.confirmMode');
}

function setBusy(b) {
  S.busy = b;
  $('sendBtn').className = b ? 'busy' : '';
  // 忙的时候按钮变成“插入指令”：点下去是给正在跑的任务插话，而不是排队等
  $('sendBtn').textContent = b ? I.t('asst.steer') : I.t('asst.send');
}

// ---------------------------------------------------------------- 选择面板
function openPicker(title, rows) {
  $('pickerTitle').textContent = title;
  const search = $('pickerSearch');
  search.value = '';
  $('pickerStatus').textContent = '';
  const render = () => {
    const query = search.value.trim().toLowerCase();
    const filtered = rows.map((row, index) => ({ row, index })).filter(({ row }) => [row.name, row.sub, row.hint].join(' ').toLowerCase().includes(query));
    $('pickerList').innerHTML = filtered.map(({ row: r, index: i }) =>
      '<button type="button" class="pickrow' + (r.cur ? ' cur' : '') + '" data-i="' + i + '"' + (!r.onPick ? ' disabled' : '') + '>'
      + '<span class="nm">' + esc(r.name) + (r.sub ? ' <span class="sub">' + esc(r.sub) + '</span>' : '') + '</span>'
      + (r.hint ? '<span class="sub">' + esc(r.hint) + '</span>' : '') + '</button>').join('') || '<div class="empty">没有匹配项</div>';
    Array.prototype.forEach.call($('pickerList').querySelectorAll('.pickrow'), el => {
      el.onclick = async () => {
        const row = rows[Number(el.getAttribute('data-i'))];
        if (!row || !row.onPick) return;
        const buttons = $('pickerList').querySelectorAll('button');
        buttons.forEach(b => { b.disabled = true; });
        $('pickerStatus').textContent = '正在应用…';
        try { await row.onPick(); closePicker(); }
        catch (e) { $('pickerStatus').textContent = '未应用：' + (e.message || e); buttons.forEach(b => { b.disabled = false; }); }
      };
    });
  };
  search.oninput = render;
  render();
  $('picker').className = 'on';
  search.focus();
}

function closePicker() { $('picker').className = ''; }

async function pickModel() {
  openPicker('选择模型', [{ name: '正在向 pi 要模型列表…' }]);
  const r = await api.agentModels();
  if (!r || !r.ok) { openPicker('选择模型', [{ name: 'x ' + ((r && r.error) || '失败') }]); return; }
  if (!r.models.length) {
    openPicker('选择模型', [{ name: 'pi 现在没有可用模型', hint: '去 pi 里登录，或在设置里填 Base URL + Key' }]);
    return;
  }
  const info = await api.agentEngine();
  const cur = (info && info.pi && info.pi.model) || (info && info.configured && info.configured.model) || '';
  openPicker('选择模型（' + r.models.length + ' 个）', r.models.map((m) => ({
    name: (m.provider ? m.provider + ' / ' : '') + m.id,
    sub: m.name && m.name !== m.id ? m.name : '',
    hint: (m.reasoning ? '可思考 ' : '') + (m.contextWindow ? Math.round(m.contextWindow / 1000) + 'k' : ''),
    cur: m.id === cur && (!info.pi.provider || m.provider === info.pi.provider),
    onPick: async () => {
      const res = await api.agentSetModel({ provider: m.provider, modelId: m.id });
      if (!res || !res.ok || res.model && res.model.unsupported) throw new Error(res && res.error || '当前内核不能切换模型');
      addMsg('sys', '已切到 ' + m.id + '，下次启动仍使用此模型');
      await refreshPills();
    }
  })));
}

async function pickThinking() {
  const r = await api.agentThinkingLevels();
  if (!r || !r.ok) { openPicker('推理档位', [{ name: 'x ' + ((r && r.error) || '失败') }]); return; }
  const info = await api.agentEngine();
  const cur = (info && info.pi && info.pi.thinking) || '';
  const label = { off: '关（最快）', minimal: '极简', low: '低', medium: '中（推荐）', high: '高', xhigh: '很高', max: '最高' };
  openPicker('推理档位', r.levels.map((lv) => ({
    name: label[lv] || lv,
    sub: lv,
    cur: lv === cur,
    onPick: async () => {
      const res = await api.agentSetThinking({ level: lv });
      if (!res || !res.ok || typeof res.level !== 'string') throw new Error(res && res.error || '当前内核不能设置思考强度');
      addMsg('sys', '思考强度：' + res.level + '，已保存');
      await refreshPills();
    }
  })));
}

async function openMore() {
  openPicker('更多', [
    { name: '＋ 开一段新对话', onPick: () => startNewSession() },
    { name: '历史会话…', onPick: () => { $('sessPanel').className = 'on'; renderSessions(); } },
    { name: '压缩上下文（省 token）', hint: 'compact', onPick: async () => {
      addMsg('sys', '正在压缩上下文…');
      const r = await api.agentCompact({});
      addMsg('sys', r && r.ok ? '上下文已压缩' : ('压缩失败：' + ((r && r.error) || '')));
      refreshPills();
    } },
    { name: '复制当前会话（开分支）', hint: 'clone', onPick: async () => {
      const r = await api.agentSessionClone();
      addMsg('sys', r && r.ok ? '已复制成新会话' : ('失败：' + ((r && r.error) || '仅 pi 内核支持')));
      renderSessions();
      refreshPills();
    } },
    { name: '从某条消息重来（fork）', hint: 'fork', onPick: () => pickForkPoint() },
    { name: 'pi 的命令与技能…', onPick: () => pickCommands() }
  ]);
}

/** 从历史里挑一条用户消息，从那里开个新分支（原来的对话不动） */
async function pickForkPoint() {
  openPicker('从哪条消息开分支', [{ name: '正在取可分支的消息…' }]);
  const r = await api.agentForkMessages();
  if (!r || !r.ok) { openPicker('从哪条消息开分支', [{ name: 'x ' + ((r && r.error) || '失败') }]); return; }
  const list = r.messages || [];
  if (!list.length) { openPicker('从哪条消息开分支', [{ name: '这个会话还没有可分支的用户消息' }]); return; }
  openPicker('从哪条消息开分支（' + list.length + ' 条）', list.map((m, i) => ({
    name: (i + 1) + '. ' + String(m.text || '').replace(/\s+/g, ' ').slice(0, 60),
    hint: '从这里重来',
    onPick: async () => {
      const res = await api.agentSessionFork({ entryId: m.entryId });
      if (!res || !res.ok) { addMsg('err', '分支失败：' + ((res && res.error) || '')); return; }
      $('msgs').innerHTML = '';
      flushStreamState();
      replay((res.result && res.result.transcript) || []);
      addMsg('sys', '已从这条消息开了一个新分支（原来的对话还在，去「历史会话」能找回来）');
      refreshPills();
      renderSessions();
    }
  })));
}

async function pickCommands() {
  openPicker('pi 的命令与技能', [{ name: '正在获取…' }]);
  const r = await api.agentCommands();
  if (!r || !r.ok) { openPicker('pi 的命令与技能', [{ name: 'x ' + ((r && r.error) || '失败') }]); return; }
  const list = r.commands || [];
  if (!list.length) { openPicker('pi 的命令与技能', [{ name: '这个内核没有可用的命令或技能' }]); return; }
  openPicker('pi 的命令与技能（' + list.length + '）', list.map((c) => ({
    name: '/' + c.name,
    sub: c.source || '',
    hint: c.description || '',
    onPick: () => { $('msgInput').value = '/' + c.name + ' '; $('msgInput').focus(); }
  })));
}

async function startNewSession() {
  await api.agentSessionNew();
  $('msgs').innerHTML = '';
  finishStream();
  renderWelcome();
  refreshPills();
}

// ---------------------------------------------------------------- 顶栏状态
async function refreshPills() {
  const info = await api.agentEngine();
  if (!info) return;
  S.engine = info.active;
  if (info.active === 'pi') {
    $('modelPill').textContent = I.t('asst.model') + ' ' + (info.pi.model || I.t('asst.notSet'));
    $('thinkPill').textContent = I.t('asst.thinking') + ' ' + (info.pi.thinking || 'off');
    $('modelPill').className = 'pill';
    $('thinkPill').className = 'pill';
  } else {
    $('modelPill').textContent = I.t('asst.model') + ' ' + (info.configured && info.configured.model || I.t('asst.notSet'));
    $('thinkPill').textContent = I.t('asst.thinking') + ' · ' + I.t('asst.na');
    $('modelPill').className = 'pill dim';
    $('thinkPill').className = 'pill dim';
  }
  if ($('workspacePill')) {
    const workspace = info.configured && info.configured.workspace || '';
    $('workspacePill').textContent = '工作区 · ' + (workspace.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || workspace);
    $('workspacePill').title = workspace;
    $('workspacePill').onclick = () => api.openSettings({ tab: 'runtime' });
  }
  renderUsage(S.usage);
}

// ---------------------------------------------------------------- 发送
function finishStream() {
  if (S.streamEl) {
    S.streamEl.innerHTML = md(S.streamText);
    S.streamEl = null;
    S.streamText = '';
  }
  if (S.thinkEl) {
    S.thinkEl.querySelector('.tb').textContent = S.thinkText;
    S.thinkEl.querySelector('.ms').textContent = '思考完成';
    S.thinkEl = null;
    S.thinkText = '';
  }
}

/** pi 内核的思考过程单独放一张可折叠卡片，不污染正文 */
function pushThinking(delta, noScroll) {
  if (!S.thinkEl) {
    const el = document.createElement('div');
    el.className = 'tool';
    el.innerHTML = '<div class="th"><span class="nm">💭 思考</span><span class="ds"></span><span class="ms">思考中…</span></div><div class="tb"></div>';
    el.querySelector('.th').onclick = () => el.classList.toggle('open');
    $('msgs').appendChild(el);
    S.thinkEl = el;
    S.thinkText = '';
  }
  S.thinkText += delta;
  S.thinkEl.querySelector('.tb').textContent = S.thinkText;
  if (!noScroll) scrollBottom();
}

async function send(steerForce) {
  const text = $('msgInput').value.trim();
  if (!text) return;
  // 正在跑的时候再按发送 = 给正在跑的任务插一句话（pi 的 steering）
  const steer = !!S.busy && S.engine === 'pi';
  if (S.busy && !steer) return;
  $('msgInput').value = '';
  $('msgInput').style.height = '';
  if (steer) {
    addMsg('user', '↪ ' + text);
  } else {
    addMsg('user', text);
    setPending(null);
    setBusy(true);
    if (S.withShot) addMsg('sys', '📷 附带当前屏幕截图');
  }
  void steerForce;
  const images = steer ? [] : S.attach.map((a) => a.dataUrl);
  if (images.length) addMsg('sys', I.t('asst.attached', { n: images.length }));
  const res = await api.agentSend({
    text: text,
    withShot: S.withShot && !steer,
    auto: S.auto,
    mode: steer ? 'steer' : undefined,
    images: images
  });
  if (!steer) { S.attach = []; renderAttach(); }
  if (res && res.error) {
    finishStream();
    setBusy(false);
    addMsg('err', '⚠ ' + res.error);
    return;
  }
  if (steer) {
    addMsg('sys', res && res.steered ? '已插入当前任务，它会在这一步之后看到' : '已排队（等这一轮结束）');
    return;
  }
  // pi 内核下 agentSend 只代表「任务已被接受」，真正结束要看 done 事件
  if (!res || res.engine !== 'pi') {
    finishStream();
    setBusy(false);
  }
}

async function confirm(choice) {
  const isQ = S.pending && S.pending.kind === 'question';
  const payload = (isQ && choice === 'exec') ? { answer: $('answerInput').value.trim() } : { choice: choice };
  setPending(null);
  setBusy(true);
  if (choice === 'auto') { S.auto = true; renderMode(); }
  const res = await api.agentConfirm(payload);
  if (res && res.error) {
    finishStream();
    setBusy(false);
    addMsg('err', '⚠ ' + res.error);
    return;
  }
  if (S.engine !== 'pi') {
    finishStream();
    setBusy(false);
  }
}

async function stop() {
  await api.agentStop();
  setPending(null);
  setBusy(false);
  finishStream();
  addMsg('sys', '已停止');
}

// ---------------------------------------------------------------- 会话
function treeLabel(entry) {
  if (!entry) return '';
  const t = String(entry.type || '');
  if (t === 'message') {
    const m = entry.message || {};
    const c = m.content;
    const s = typeof c === 'string' ? c : (Array.isArray(c) ? c.map((x) => (x && x.text) || '').join(' ') : '');
    const who = m.role === 'user' ? '你：' : m.role === 'assistant' ? '奶蛙：' : String(m.role || '') + '：';
    return who + String(s).replace(/[\r\n\s]+/g, ' ').slice(0, 46);
  }
  if (t === 'compaction') return '（上下文压缩点）';
  if (t === 'branch_summary') return '（分支摘要）';
  if (t === 'custom') return String(entry.customType || '自定义条目');
  return t;
}

async function renderTree() {
  const box = $('sessTree');
  box.innerHTML = '<div class="empty">正在取会话结构…</div>';
  const r = await api.agentSessionTree();
  if (!r || !r.ok) { box.innerHTML = '<div class="empty">x ' + esc((r && r.error) || '取不到') + '</div>'; return; }
  const rows = [];
  const leaf = String(r.leafId || '');
  const walk = (nodes, depth) => {
    (nodes || []).forEach((n) => {
      if (!n || !n.entry) return;
      const e = n.entry;
      const canFork = e.type === 'message' && e.message && e.message.role === 'user';
      const isLeaf = leaf && e.id === leaf;
      rows.push('<div class="sess' + (isLeaf ? ' cur' : '') + '" style="padding-left:' + (9 + depth * 14) + 'px" title="' + esc(e.id || '') + '">'
        + '<span class="ttl">' + esc(treeLabel(e)) + '</span>'
        + (isLeaf ? '<span class="badge ok">当前位置</span>' : '')
        + (canFork ? '<span class="x" data-fork="' + esc(e.id) + '" title="从这里开分支">⑂</span>' : '')
        + '</div>');
      walk(n.children, depth + 1);
    });
  };
  walk(r.tree || [], 0);
  box.innerHTML = rows.length ? rows.join('') : '<div class="empty">这个会话还没有结构</div>';
  Array.prototype.forEach.call(box.querySelectorAll('[data-fork]'), (el) => {
    el.onclick = async () => {
      const res = await api.agentSessionFork({ entryId: el.getAttribute('data-fork') });
      if (!res || !res.ok) { addMsg('err', '分支失败：' + ((res && res.error) || '')); return; }
      $('msgs').innerHTML = '';
      flushStreamState();
      replay((res.result && res.result.transcript) || []);
      addMsg('sys', '已从这一条开了一个新分支（原来的对话还在）');
      $('sessPanel').className = '';
      refreshPills();
    };
  });
}

async function renderSessions() {
  const d = await api.agentSessions();
  const list = (d && d.list) || [];
  const cur = d && d.current;
  $('sessList').innerHTML = list.length
    ? list.map((s) => '<div class="sess' + (s.id === cur ? ' cur' : '') + '" data-id="' + esc(s.id) + '">'
      + '<span class="ttl">' + esc(s.title || '新对话') + '</span>'
      + '<span class="tm">' + new Date(s.updatedAt).toLocaleDateString('zh-CN') + ' · ' + (s.count || 0) + ' 条</span>'
      + '<span class="x" data-del="' + esc(s.id) + '">✕</span></div>').join('')
    : '<div class="empty">还没有历史会话</div>';
  Array.prototype.forEach.call($('sessList').querySelectorAll('.sess'), (el) => {
    el.onclick = async (e) => {
      const del = e.target.getAttribute && e.target.getAttribute('data-del');
      if (del) {
        e.stopPropagation();
        await api.agentSessionDelete({ id: del });
        await renderSessions();
        return;
      }
      const r = await api.agentSessionLoad({ id: el.getAttribute('data-id') });
      if (!r || !r.ok) {
        // 以前这里失败是什么都不做 —— 用户只看到“点开没反应”。现在把面板关掉、把原因写进对话区（
        // 不关的话提示会被历史面板盖住，等于白说）
        $('sessPanel').className = '';
        addMsg('err', '打不开这条会话：' + String((r && r.error) || '未知原因'));
        return;
      }
      $('msgs').innerHTML = '';
      flushStreamState();
      replay(r.session.transcript || openAiHistoryToTranscript(r.session.messages));
      $('sessPanel').className = '';
      setPending(null);
      refreshPills();
      if (r.session.repaired) {
        addMsg('sys', '这条会话原来的工作目录 ' + r.session.repaired.from + ' 已不存在，已改用 ' + r.session.repaired.to + ' 打开（原文件备份为 .bak-cwd）');
      }
      if (!(r.session.transcript || []).length) addMsg('sys', '这个会话还没对话记录');
    };
  });
}

// 历史回放：pi 侧已经是归一条目；内置引擎侧转成同一套再喂进来
function replay(transcript) {
  (transcript || []).forEach((e) => {
    if (e.kind === 'user') {
      addMsg('user', e.text);
    } else if (e.kind === 'assistant') {
      if (e.thinking) pushThinking(e.thinking, true);
      finishStream();
      if (e.text) addMsg('bot', e.text, { markdown: true });
    } else if (e.kind === 'tool') {
      const el = toolCard({ id: e.id, name: e.name, args: e.args, desc: '' });
      el.querySelector('.ms').textContent = e.ok ? '已完成' : '失败';
      if (!e.ok) el.classList.add('fail');
      const body = el.querySelector('.tb');
      body.textContent = String(e.text || '');
      (e.images || []).forEach((url) => {
        const img = document.createElement('img');
        img.className = 'shot';
        img.src = url;
        img.onclick = () => { img.style.maxWidth = img.style.maxWidth === '100%' ? '150px' : '100%'; };
        body.appendChild(img);
      });
      delete S.toolEls[e.id];
    } else if (e.kind === 'note') {
      const el = document.createElement('div');
      el.className = 'note';
      el.textContent = e.text;
      $('msgs').appendChild(el);
    }
  });
  scrollBottom();
}

/** 内置引擎的历史是 OpenAI 形状，就地转成同一套条目 */
function openAiHistoryToTranscript(messages) {
  const out = [];
  const tools = {};
  (messages || []).forEach((m) => {
    if (m.role === 'user') {
      const t = typeof m.content === 'string' ? m.content : (m.content || []).map((p) => p.text || '').join(' ');
      if (!t || t.indexOf('（这是上一步操作后的最新截图）') === 0) return;
      out.push({ kind: 'user', text: t });
    } else if (m.role === 'assistant') {
      if (m.content) out.push({ kind: 'assistant', text: m.content, thinking: '' });
      (m.tool_calls || []).forEach((tc) => {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) { args = {}; }
        const entry = { kind: 'tool', id: tc.id, name: tc.function.name, args: args, ok: true, text: '', images: [] };
        tools[tc.id] = entry;
        out.push(entry);
      });
    } else if (m.role === 'tool') {
      const t = tools[m.tool_call_id];
      if (t) t.text = String(m.content || '');
    }
  });
  return out;
}

// ---------------------------------------------------------------- 配置
let configRevision = 0;
let currentConfig = null;
let savingConfig = false;
function applyCfg(c) {
  if (!c) return;
  configRevision++;
  currentConfig = c;
  $('cfgBase').value = c.baseUrl || '';
  $('cfgModel').value = c.model || '';
  $('cfgKey').value = c.hasKey ? '••••••••••••' : '';
  S.engine = c.activeEngine || '';
  renderMode();
  const unavailable = c.keyPersistence === 'unavailable';
  $('setupStatus').className = unavailable ? 'err' : '';
  $('setupStatus').textContent = unavailable ? '原密钥无法解密，密文已保留，请重新填写密钥。' : '';
  if (!savingConfig) show(c.baseUrl && c.hasKey && c.model ? 'chat' : 'setup');
}
async function loadCfg() {
  const revision = configRevision;
  const c = await api.agentCfgGet();
  if (revision === configRevision) applyCfg(c);
  return currentConfig || c;
}

async function saveCfg(needDetect) {
  if (savingConfig) return;
  savingConfig = true;
  try {
  const baseUrl = $('cfgBase').value.trim();
  const key = $('cfgKey').value.trim();
  let model = $('cfgModel').value.trim();
  const st = $('setupStatus');
  if (!baseUrl || (!key && !$('cfgKey').value)) {
    st.className = 'err';
    st.textContent = 'Base URL 和 API Key 至少都要填';
    return;
  }
  st.className = '';
  st.textContent = '保存中…';
  const saved = await api.agentCfgSave({ baseUrl: baseUrl, key: key, model: model });
  if (saved.keyPersistence === 'unavailable') throw new Error('原密钥无法解密，密文已保留，请重新填写密钥。');
  $('cfgKey').value = saved.hasKey ? '••••••••••••' : '';

  if (needDetect && !model) {
    st.textContent = '没填模型，正在从 /models 里挑…';
    const d = await api.agentDetectModel();
    if (d && d.ok && d.picked) {
      model = d.picked;
      $('cfgModel').value = model;
      await api.agentCfgSave({ model: model });
      st.textContent = '已选择模型：' + model;
    } else {
      st.className = 'err';
      st.textContent = '自动检测失败：' + ((d && d.error) || '请手动填模型名');
      return;
    }
  }
  st.textContent = '正在测试连接…';
  const r = await api.agentTest();
  if (r && r.ok) {
    st.className = 'ok';
    st.textContent = '✓ 连接成功（' + (r.provider || 'openai') + '）：' + (r.reply || 'ok');
    setTimeout(() => show('chat'), 700);
  } else {
    st.className = 'err';
    st.textContent = '✗ ' + ((r && r.error) || '未知错误');
  }
  } catch (e) {
    $('setupStatus').className = 'err';
    $('setupStatus').textContent = '✗ ' + (e.message || e);
  } finally { savingConfig = false; }
}

// ---------------------------------------------------------------- 事件
api.onAgentEvent((evt) => {
  if (!evt) return;
  if (evt.type === 'thinking') {
    pushThinking(String(evt.delta || ''));
    return;
  }
  if (evt.type === 'history-reset') {
    $('msgs').innerHTML = '';
    flushStreamState();
    addMsg('sys', '已切换到历史会话');
    return;
  }
  if (evt.type === 'text') {
    if (!S.streamEl) {
      S.streamEl = addMsg('bot', '');
      S.streamText = '';
    }
    S.streamText += evt.delta;
    S.streamEl.textContent = S.streamText;
    scrollBottom();
    return;
  }
  if (evt.type === 'assistant') {
    if (S.streamEl) { S.streamText = evt.text || S.streamText; return; }
    addMsg('bot', evt.text || '', { markdown: true });
    return;
  }
  if (evt.type === 'tool-call') {
    finishStream();
    toolCard(evt);
    return;
  }
  if (evt.type === 'tool-nested') {
    // 子代理/嵌套调用：缩进挂在父调用下面
    toolCard({ id: evt.id, name: evt.name, args: evt.args, parent: evt.parentToolCallId, desc: '' });
    return;
  }
  if (evt.type === 'tool-result') { toolResult(evt); return; }
  if (evt.type === 'tool-skipped') { addMsg('sys', '⏭ 已跳过 ' + evt.name); return; }
  if (evt.type === 'status') { return; }
  if (evt.type === 'usage') { renderUsage(evt.usage); return; }
  if (evt.type === 'error') {
    finishStream();
    addMsg('err', '⚠ ' + evt.message);
    // 模型发不出去时把“为什么”补上：pi 的 httpProxy 配置是最常见的坑
    if (/connection error|fetch failed/i.test(String(evt.message || ''))) {
      api.agentPreflight({ force: true }).then((r) => {
        const pf = r && r.ok && r.result;
        if (pf && pf.warnings && pf.warnings.length) pf.warnings.forEach((w) => addMsg('err', '💡 ' + w));
        else addMsg('sys', '连不上模型服务。检查：① 网络/代理 ② Base URL 是否为根地址 ③ Key 是否有效。也可以先切到「内置引擎」试试。');
      });
    }
    return;
  }
  if (evt.type === 'done') {
    const streamed = !!S.streamText;
    finishStream();
    setBusy(false);
    // 只在本轮什么都没流出时才补一条气泡，避免与流式内容重复
    if (evt.reply && !streamed) addMsg('bot', evt.reply, { markdown: true });
    if (evt.aborted) addMsg('sys', '已中止');
    // 一轮结束后用会话真实统计刷一次用量/上下文占用
    api.agentUsage().then((u) => { if (u && u.total) renderUsage(u.total); });
    refreshPills();
    return;
  }
});

api.onAgentPending((p) => {
  finishStream();
  if (p && p.kind === 'plan' && p.plan) { showPlan(p.plan); setBusy(false); return; }
  setPending(p);
  setBusy(false);
});

api.onAgentPlan((plan) => {
  finishStream();
  setPending(null);
  showPlan(plan);
  setBusy(false);
});

api.onAgentQuestion((q) => {
  finishStream();
  setPending(Object.assign({ kind: 'question' }, q || {}));
  setBusy(false);
});

api.onAgentUsage((u) => renderUsage(u));
api.onAgentConfigChanged((c) => { applyCfg(c); refreshPills(); });
api.onAgentModel(() => { refreshPills(); });
api.onAgentThinking(() => { refreshPills(); });
api.onAssistantBackdrop((url) => { $('backdrop').src = url; });
api.onAssistantState((open) => {
  if (open) loadCfg().then(() => {
    refreshPills();
    setTimeout(() => ($('v-chat').style.display === 'flex' ? $('msgInput') : $('cfgBase')).focus(), 120);
  }).catch(e => { $('setupStatus').className = 'err'; $('setupStatus').textContent = '读取配置失败：' + (e.message || e); });
});
api.onThemeChanged(t => { document.body.className = 't' + (Number(t) || 0); });

// ---------------------------------------------------------------- 初始化
(async function init() {
  const boot = await api.appInit();
  document.body.className = 't' + (Number(boot && boot.theme) || 0);
  I.setLocale(boot && boot.locale);
  I.applyDom();
  await loadCfg();
  await refreshPills();

  const pinState = await api.asstPinGet();
  S.pinned = !!(pinState && pinState.pinned);
  $('pin').className = 'icobtn' + (S.pinned ? ' on' : '');

  $('pin').onclick = async () => {
    S.pinned = !S.pinned;
    $('pin').className = 'icobtn' + (S.pinned ? ' on' : '');
    await api.asstPinSet(S.pinned);
  };
  $('settingsbtn').onclick = () => api.openSettings();
  $('close').onclick = () => api.assistantHide();
  $('saveCfg').onclick = () => saveCfg(true);
  $('detectBtn').onclick = async () => {
    try {
    const st = $('setupStatus');
    st.className = '';
    st.textContent = '正在获取模型列表…';
    await api.agentCfgSave({ baseUrl: $('cfgBase').value.trim(), key: $('cfgKey').value.trim(), model: $('cfgModel').value.trim() });
    const d = await api.agentDetectModel();
    if (d && d.ok) {
      $('cfgModel').value = d.picked;
      st.textContent = '共 ' + (d.models || []).length + ' 个模型，已选：' + d.picked;
    } else {
      st.className = 'err';
      st.textContent = '✗ ' + ((d && d.error) || '失败');
    }
    } catch (e) { $('setupStatus').className = 'err'; $('setupStatus').textContent = '✗ ' + (e.message || e); }
  };
  $('shotToggle').onclick = () => {
    S.withShot = !S.withShot;
    $('shotToggle').className = 'pill' + (S.withShot ? ' on' : '');
    $('shotToggle').textContent = S.withShot ? '📷 附图 ✓' : '📷 附图';
  };
  $('modeToggle').onclick = () => { S.auto = !S.auto; renderMode(); };
  $('modelPill').onclick = () => pickModel();
  $('thinkPill').onclick = () => pickThinking();
  $('moreBtn').onclick = () => openMore();
  $('pickerClose').onclick = () => closePicker();
  $('sendBtn').onclick = send;
  $('stopBtn').onclick = stop;
  $('execBtn').onclick = () => confirm('exec');
  $('skipBtn').onclick = () => confirm('skip');
  $('autoBtn').onclick = () => confirm('auto');
  $('sessbtn').onclick = async () => {
    const on = $('sessPanel').className === 'on';
    $('sessPanel').className = on ? '' : 'on';
    $('sessTree').style.display = 'none';
    $('sessList').style.display = '';
    $('sessTabList').className = 'pill on';
    $('sessTabTree').className = 'pill';
    if (!on) await renderSessions();
  };
  $('sessClose').onclick = () => { $('sessPanel').className = ''; };
  $('sessTabList').onclick = () => {
    $('sessTabList').className = 'pill on';
    $('sessTabTree').className = 'pill';
    $('sessList').style.display = '';
    $('sessTree').style.display = 'none';
  };
  $('sessTabTree').onclick = () => {
    $('sessTabTree').className = 'pill on';
    $('sessTabList').className = 'pill';
    $('sessList').style.display = 'none';
    $('sessTree').style.display = '';
    renderTree();
  };
  $('newSessBtn').onclick = async () => {
    $('sessPanel').className = '';
    await startNewSession();
  };

  bindPlanButtons();
  api.onFilesDropped((paths) => { addAttachments(paths); });
  api.onFilesDrag((on) => { $('composer').style.opacity = on ? '0.75' : ''; });

  const input = $('msgInput');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  $('answerInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirm('exec'); }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(110, input.scrollHeight) + 'px';
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if ($('picker').className === 'on') closePicker();
      else if ($('sessPanel').className === 'on') $('sessPanel').className = '';
      else api.assistantHide();
    }
  });

  renderWelcome();
  if (location.search.indexOf('debug=1') !== -1) {
    setInterval(() => api.debugDumpAsst({ busy: S.busy, auto: S.auto, pending: !!S.pending, msgs: $('msgs').children.length }), 1500);
  }
})();
