'use strict';
/* 权限策略：决定每个工具调用是「直接执行 / 先问用户 / 直接拒绝」
 * 纯函数，方便单测。真正的执行决策由 agent 运行时调用。
 */

const LEVEL_ORDER = { low: 0, mid: 1, high: 2 };

/** 默认策略 */
const DEFAULT_POLICY = {
  mode: 'confirm',              // confirm | auto | readonly
  allow: {},                    // { toolName: true } 用户勾选「以后都允许」
  deny: {},                     // { toolName: true }
  confirmHighRisk: true,        // 高危工具即使 auto 也要问
  maxSteps: 0                   // 0 = 不限次数（能干多久干多久，随时可停）
};

// 高危命令黑名单（命中即拒绝，需用户手动改文件或换方式）
const HARD_BLOCK = [
  { re: /\bformat\s+[a-z]:/i, why: '格式化磁盘' },
  { re: /\bdiskpart\b/i, why: '磁盘分区操作' },
  { re: /\b(shutdown|logoff)\b/i, why: '关机/注销' },
  { re: /\bcipher\s+\/w/i, why: '擦除磁盘剩余空间' },
  { re: /\bvssadmin\s+delete\s+shadows/i, why: '删除卷影副本' },
  { re: /\bbcdedit\b/i, why: '修改启动配置' },
  { re: /reg(\.exe)?\s+delete\s+HKLM/i, why: '删除系统注册表项' },
  { re: /\bnet\s+user\b.*\/add/i, why: '新建系统账户' },
  { re: /(Invoke-Expression|iex)\s*\(?\s*(New-Object\s+Net\.WebClient|Invoke-WebRequest|iwr)/i, why: '远程下载并执行脚本' },
  { re: /curl\s+[^\n|]*\|\s*(ba)?sh/i, why: '远程脚本管道执行' },
  { re: /\btaskkill\b[^\n]*\/f[^\n]*\b(explorer|winlogon|csrss|services)\b/i, why: '强杀系统关键进程' }
];

// 需要用户明确确认的高危命令（不直接拒）
const SOFT_WARN = [
  { re: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i, why: '递归强制删除' },
  { re: /\b(del|erase)\b[^\n]*\/[sq]/i, why: '批量删除文件' },
  { re: /\b(rmdir|rd)\b[^\n]*\/s/i, why: '递归删除目录' },
  { re: /\breg\s+(add|delete|import)\b/i, why: '修改注册表' },
  { re: /\b(sc|net)\s+(start|stop|config)\b/i, why: '操作系统服务' },
  { re: /\bSet-ExecutionPolicy\b/i, why: '修改脚本执行策略' },
  { re: /\b(netsh|New-NetFirewallRule)\b/i, why: '修改网络/防火墙设置' },
  { re: /\bwmic\b|\bGet-CimInstance\b.*-Method/i, why: '系统管理接口调用' },
  { re: /\bgit\s+(push|reset\s+--hard|clean\s+-fd)/i, why: '不可逆的 git 操作' },
  { re: /\b(npm|pip|winget|choco|scoop)\s+(install|uninstall|remove)/i, why: '安装/卸载软件' },
  { re: />>?\s*[A-Za-z]:\\Windows/i, why: '写入系统目录' },
  { re: /\bicacls\b|\btakeown\b/i, why: '修改文件权限/所有者' }
];

const PROTECTED_PATH_PATTERNS = [
  { re: /^[a-z]:\\windows(\\|$)/i, why: 'Windows 系统目录' },
  { re: /^[a-z]:\\program files( \(x86\))?(\\|$)/i, why: 'Program Files' },
  { re: /^[a-z]:\\programdata(\\|$)/i, why: 'ProgramData' },
  { re: /^[a-z]:\\users\\[^\\]+\\appdata(\\|$)/i, why: 'AppData' },
  { re: /^[a-z]:\\[^\\]*$/i, why: '盘符根目录' },
  { re: /^[a-z]:\\users\\[^\\]+$/i, why: '用户主目录' }
];

/** 命令风险检测 */
function inspectCommand(cmd) {
  const s = String(cmd || '');
  for (const rule of HARD_BLOCK) {
    if (rule.re.test(s)) return { risk: 'blocked', why: rule.why };
  }
  for (const rule of SOFT_WARN) {
    if (rule.re.test(s)) return { risk: 'high', why: rule.why };
  }
  return { risk: 'normal', why: '' };
}

function inspectPath(p, extraRoots) {
  let abs = String(p || '');
  try { abs = require('path').resolve(abs); } catch (e) { /* 浏览器/测试环境 */ }
  for (const rule of PROTECTED_PATH_PATTERNS) {
    if (rule.re.test(abs)) return { risk: 'high', why: rule.why };
  }
  for (const root of (extraRoots || [])) {
    const path = require('path');
    const base = path.resolve(String(root)).toLowerCase();
    const target = abs.toLowerCase();
    if (target === base || target.startsWith(base + path.sep)) return { risk: 'blocked', why: '程序自身目录' };
  }
  return { risk: 'normal', why: '' };
}

/**
 * 判定一个工具调用该怎么处理
 * @param {object} tool   工具定义 {name, level}
 * @param {object} args   调用参数
 * @param {object} policy 策略
 * @returns {{decision:'allow'|'ask'|'deny', reason:string}}
 */
function evaluate(tool, args, policy) {
  const p = Object.assign({}, DEFAULT_POLICY, policy || {});
  const name = tool.name;
  if (tool.enabled === false) return { decision: 'deny', reason: '工具已被禁用' };
  if (p.deny && p.deny[name]) return { decision: 'deny', reason: '你在设置里禁用了「' + name + '」' };

  // 命令与路径的硬拦截
  if (name === 'run_command') {
    const r = inspectCommand(args && args.command);
    if (r.risk === 'blocked') return { decision: 'deny', reason: '禁止执行：' + r.why };
  }
  if (name === 'write_file' || name === 'delete_path' || name === 'move_path' || name === 'copy_path' || name === 'mkdir') {
    const targets = args ? [args.path, args.from, args.to].filter(Boolean) : [];
    for (const target of targets) {
      const r = inspectPath(target, p.selfRoot ? [p.selfRoot] : []);
      if (r.risk === 'blocked') return { decision: 'deny', reason: '受保护路径：' + r.why };
    }
  }

  if (p.mode === 'readonly') {
    if (tool.level === 'low') return { decision: 'allow', reason: '' };
    return { decision: 'deny', reason: '当前是「只读」模式，只能看不能动' };
  }
  if (tool.level === 'high') return { decision: 'ask', reason: '高危操作' };
  if (p.allow && p.allow[name]) return { decision: 'allow', reason: '已加入白名单' };
  if (tool.level === 'low') return { decision: 'allow', reason: '' };
  if (p.mode === 'auto') return { decision: 'allow', reason: '' };
  return { decision: 'ask', reason: '' };
}

/** 用户点了「本任务自动」之后，仍然必须逐步确认的工具 */
function stillNeedsConfirm(tool, policy) {
  const p = Object.assign({}, DEFAULT_POLICY, policy || {});
  if (!p.confirmHighRisk) return false;
  return tool.level === 'high';
}

module.exports = {
  DEFAULT_POLICY,
  LEVEL_ORDER,
  HARD_BLOCK,
  SOFT_WARN,
  PROTECTED_PATH_PATTERNS,
  inspectCommand,
  inspectPath,
  evaluate,
  stillNeedsConfirm
};
