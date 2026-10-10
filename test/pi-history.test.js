'use strict';
/* 历史会话的工作目录读写：点开一条「工作目录已经不存在」的旧会话时靠它兜底 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readSessionCwd, repairSessionCwd } = require('../src/main/engines/pi-history.js');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nailong-sess-'));
  const file = path.join(dir, 's.jsonl');
  const header = { type: 'session', version: 3, id: '01abc', timestamp: '2026-01-01T00:00:00.000Z', cwd: 'D:\\gone' };
  const rest = [
    JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: '你好' }] } }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '在的' }] } })
  ].join('\n') + '\n';
  const original = JSON.stringify(header) + '\n' + rest;
  fs.writeFileSync(file, original, 'utf8');
  return { dir, file, original, rest };
}

test('会话工作目录：读得到、改得对、留备份、后面的记录一字不动', () => {
  const f = fixture();
  try {
    assert.equal(readSessionCwd(f.file), 'D:\\gone');
    assert.equal(repairSessionCwd(f.file, 'C:\\now'), true);
    assert.equal(readSessionCwd(f.file), 'C:\\now');
    const text = fs.readFileSync(f.file, 'utf8');
    assert.ok(text.endsWith(f.rest), '对话记录必须原样保留');
    assert.equal(text.split('\n')[0], JSON.stringify({ type: 'session', version: 3, id: '01abc', timestamp: '2026-01-01T00:00:00.000Z', cwd: 'C:\\now' }));
    assert.equal(fs.readFileSync(f.file + '.bak-cwd', 'utf8'), f.original, '备份必须是原文件');
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('会话工作目录：不该动的情况一个都不动', () => {
  const f = fixture();
  try {
    assert.equal(repairSessionCwd(f.file, ''), false, '没给目录就不改');
    assert.equal(repairSessionCwd(f.file, 'D:\\gone'), false, '目录本来就对，不写盘');
    assert.equal(fs.existsSync(f.file + '.bak-cwd'), false, '没改就不该有备份');
    const bad = path.join(f.dir, 'bad.jsonl');
    fs.writeFileSync(bad, '{"type":"别的"}\n', 'utf8');
    assert.equal(repairSessionCwd(bad, 'C:\\now'), false, '不是 pi 会话文件就不碰');
    assert.equal(fs.readFileSync(bad, 'utf8'), '{"type":"别的"}\n');
    assert.equal(readSessionCwd(path.join(f.dir, '不存在.jsonl')), '', '读不到就返回空串，不抛');
    // 头部缺 cwd 时也算「没有可用目录」
    const noCwd = path.join(f.dir, 'nocwd.jsonl');
    fs.writeFileSync(noCwd, '{"type":"session","id":"x"}\n', 'utf8');
    assert.equal(readSessionCwd(noCwd), '');
    assert.equal(repairSessionCwd(noCwd, 'C:\\now'), true, '缺 cwd 的会话头也可以补上');
    assert.equal(readSessionCwd(noCwd), 'C:\\now');
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
