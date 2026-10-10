'use strict';
/* contextBridge 桥：渲染层唯一的对外通道。渲染层没有 Node 权限，只能调这里列出来的方法。 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

let dropCb = null;
let dragCb = null;

function pathsFromTransfer(dt) {
  const out = [];
  try {
    const files = dt && dt.files ? Array.prototype.slice.call(dt.files) : [];
    for (let i = 0; i < files.length; i++) {
      try {
        const p = webUtils.getPathForFile(files[i]);
        if (p) out.push(p);
      } catch (e) { /* 忽略单个文件 */ }
    }
  } catch (e) { /* 忽略 */ }
  if (!out.length) {
    const texts = [];
    try { texts.push(dt.getData('text/uri-list') || ''); } catch (e) { /* ignore */ }
    try { texts.push(dt.getData('text/plain') || ''); } catch (e) { /* ignore */ }
    texts.join('\r\n').split(/\r?\n/).forEach((line) => {
      const s = line.trim();
      if (s.toLowerCase().indexOf('file:///') === 0) {
        try { out.push(decodeURIComponent(s.replace(/^file:\/\/\//i, '').replace(/\//g, '\\'))); } catch (e) { /* ignore */ }
      }
    });
  }
  return out;
}

window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (dragCb) dragCb(true);
}, true);
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  try { if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; } catch (err) { /* ignore */ }
}, true);
window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  if (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) {
    if (dragCb) dragCb(false);
  }
}, true);
window.addEventListener('drop', (e) => {
  e.preventDefault();
  if (dragCb) dragCb(false);
  const paths = pathsFromTransfer(e.dataTransfer);
  if (paths.length && dropCb) dropCb(paths);
}, true);

const invoke = (channel) => (payload) => ipcRenderer.invoke(channel, payload);
const on = (channel) => (cb) => { ipcRenderer.removeAllListeners(channel); ipcRenderer.on(channel, (e, v) => cb(v)); };

contextBridge.exposeInMainWorld('widget', {
  // 初始化 / 通用
  appInit: invoke('app-init'),
  petInit: invoke('pet-init'),
  panelInit: invoke('panel-init'),
  appInfo: invoke('app-info'),
  openPath: invoke('open-path'),
  openExternal: invoke('open-external'),
  logsTail: invoke('logs-tail'),
  openLogs: invoke('open-logs'),
  dataExport: invoke('data-export'),
  dataImport: invoke('data-import'),
  dataPath: invoke('data-path'),

  // 日程
  saveSchedule: invoke('save-schedule'),
  saveCountdown: invoke('save-countdown'),
  toggleDone: invoke('toggle-done'),
  scheduleAdd: invoke('schedule-add'),
  scheduleRemove: invoke('schedule-remove'),
  scheduleUpdate: invoke('schedule-update'),
  nlParse: invoke('nl-parse'),
  countdownAdd: invoke('countdown-add'),
  countdownRemove: invoke('countdown-remove'),

  // 设置
  settingsGet: invoke('settings-get'),
  settingsSave: async (payload) => { const r = await ipcRenderer.invoke('settings-save', payload); if (r && r.error) throw new Error(r.error); return r; },
  chooseWorkspace: invoke('workspace-choose'),
  settingsReset: invoke('settings-reset'),
  toolsList: invoke('tools-list'),

  // 助手
  agentCfgGet: invoke('agent-cfg-get'),
  agentCfgSave: async (payload) => {
    const saved = await ipcRenderer.invoke('agent-cfg-save', payload);
    if (!saved || saved.error) throw new Error(saved && saved.error || '配置未保存');
    return saved;
  },
  agentTest: invoke('agent-test'),
  agentDetectModel: invoke('agent-detect-model'),
  agentShot: invoke('agent-shot'),
  readImage: invoke('read-image'),
  agentSend: invoke('agent-send'),
  agentConfirm: invoke('agent-confirm'),
  agentStop: invoke('agent-stop'),
  agentClear: invoke('agent-clear'),
  agentSessions: invoke('agent-sessions'),
  agentSessionNew: invoke('agent-session-new'),
  agentSessionLoad: invoke('agent-session-load'),
  agentSessionDelete: invoke('agent-session-delete'),
  agentUsage: invoke('agent-usage'),
  agentEngine: invoke('agent-engine'),
  agentEngineSet: invoke('agent-engine-set'),
  agentSessionStats: invoke('agent-session-stats'),
  agentPreflight: invoke('agent-preflight'),
  mcpList: invoke('mcp-list'),
  mcpAdd: invoke('mcp-add'),
  mcpRemove: invoke('mcp-remove'),
  mcpToggle: invoke('mcp-toggle'),
  mcpOpen: invoke('mcp-open'),
  mcpLogin: invoke('mcp-login'),
  mcpLogout: invoke('mcp-logout'),
  mcpStatus: invoke('mcp-status'),
  mcpCheckLoggedIn: invoke('mcp-check-logged-in'),
  agentModels: invoke('agent-models'),
  agentSetModel: invoke('agent-set-model'),
  agentCycleModel: invoke('agent-cycle-model'),
  agentThinkingLevels: invoke('agent-thinking-levels'),
  agentSetThinking: invoke('agent-set-thinking'),
  agentCompact: invoke('agent-compact'),
  agentCommands: invoke('agent-commands'),
  agentTranscript: invoke('agent-transcript'),
  agentSessionRename: invoke('agent-session-rename'),
  agentSessionClone: invoke('agent-session-clone'),
  agentSessionFork: invoke('agent-session-fork'),
  agentForkMessages: invoke('agent-fork-messages'),
  agentSessionTree: invoke('agent-session-tree'),
  appCheckUpdate: invoke('app-check-update'),
  appDownloadUpdate: invoke('app-download-update'),
  appRunUpdate: invoke('app-run-update'),

  // 专注 / 统计
  focusStatus: invoke('focus-status'),
  focusStart: invoke('focus-start'),
  focusPause: invoke('focus-pause'),
  focusResume: invoke('focus-resume'),
  focusStop: invoke('focus-stop'),
  focusSkip: invoke('focus-skip'),
  focusConfig: invoke('focus-config'),
  focusSessions: invoke('focus-sessions'),
  statsGet: invoke('stats-get'),

  // 剪贴板 / 记忆
  clipboardHistory: invoke('clipboard-history'),
  clipboardClear: invoke('clipboard-clear'),
  clipboardSet: invoke('clipboard-set'),
  memoryList: invoke('memory-list'),
  memoryAdd: invoke('memory-add'),
  memoryRemove: invoke('memory-remove'),
  memoryClear: invoke('memory-clear'),

  // 提醒
  reminderSnooze: invoke('reminder-snooze'),
  playSystemSound: invoke('play-system-sound'),

  // 桌宠 / 形态
  openAssistant: invoke('open-assistant'),
  assistantHide: invoke('assistant-hide'),
  openSettings: invoke('open-settings'),
  openModeMenu: invoke('open-mode-menu'),
  setMode: invoke('set-mode'),
  menuHide: invoke('menu-hide'),
  modeGet: invoke('mode-get'),
  toolHide: invoke('tool-hide'),
  asstPinGet: invoke('asst-pin-get'),
  asstPinSet: invoke('asst-pin-set'),
  petPing: invoke('pet-ping'),
  petEvent: invoke('pet-event'),
  petMove: invoke('pet-move'),
  petMoveBy: invoke('pet-move-by'),
  petGrow: invoke('pet-grow'),
  recyclePaths: invoke('recycle-paths'),
  dropSubmit: invoke('drop-submit'),
  askDone: invoke('ask-done-event'),
  setIgnore: (b) => ipcRenderer.send('set-ignore', b),
  saveTheme: invoke('save-theme'),
  saveSettings: invoke('save-settings'),
  togglePopup: invoke('toggle-popup'),
  hidePopup: invoke('hide-popup'),
  resetPanelPos: invoke('reset-panel-pos'),
  savePanelPos: invoke('save-panel-pos'),
  refreshPanelBackdrop: invoke('refresh-panel-backdrop'),
  refreshAsstBackdrop: invoke('refresh-asst-backdrop'),
  windowMinimize: invoke('window-minimize'),
  windowClose: invoke('window-close'),
  close: invoke('close-app'),
  debugDump: invoke('debug-dump'),
  debugDumpAsst: invoke('debug-dump-asst'),

  // 事件订阅
  onFilesDropped: (cb) => { dropCb = cb; },
  onFilesDrag: (cb) => { dragCb = cb; },
  onTasksChanged: on('tasks-changed'),
  onCountdownChanged: on('countdown-changed'),
  onStateChanged: on('state-changed'),
  onSettingsChanged: on('settings-changed'),
  onSettingsView: on('settings-view'),
  onThemeChanged: on('theme-changed'),
  onCelebrate: on('celebrate'),
  onModeChanged: on('mode-changed'),
  onModeCurrent: on('mode-current'),
  onToolView: on('tool-view'),
  onPetPing: on('pet-ping'),
  onPetEvent: on('pet-event'),
  onPanelState: on('panel-state'),
  onPanelBackdrop: on('panel-backdrop'),
  onAssistantBackdrop: on('assistant-backdrop'),
  onAssistantState: on('assistant-state'),
  onAgentEvent: on('agent-event'),
  onAgentPending: on('agent-pending'),
  onAgentPlan: on('agent-plan'),
  onAgentQuestion: on('agent-question'),
  onAgentUsage: on('agent-usage'),
  onAgentConfigChanged: on('agent-config-changed'),
  onAgentModel: on('agent-model'),
  onAgentThinking: on('agent-thinking'),
  onAgentSessions: on('agent-sessions'),
  onAgentSession: on('agent-session'),
  onFocusChanged: on('focus-changed'),
  onReminder: on('reminder'),
  onPetBackdrop: on('pet-backdrop')
});
