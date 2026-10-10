'use strict';
/* 桌宠动作：抓奶蛙小游戏、跑到桌面图标旁、拖文件回收的走位 */

const path = require('path');
const { screen } = require('electron');

const P = require('./paths.js');

const CATCH = {
  SPEED: 520,
  LAUGH_MS: 900,
  MAX_MS: 30000,
  TICK_MS: 16,
  MAXVY: 0.62,
  DODGE_R: 96,
  DODGE_MIN: 1.25,
  DODGE_MAX: 1.7,
  OX: 47,
  OY: 126,
  SIZE_TOL: 24
};

function createPetActions(deps) {
  const { windows, native, log, onAskRecycle, onCatchEnd } = deps;
  let catchGame = null;
  let returnTimer = null;
  let walkToken = 0;
  let dropHome = null;
  let petWalking = false;

  const petSize = () => windows.petSize();
  // 抓奶蛙的偏移量是按基准窗口量的（47/126 是角色左上角，+48/+52 到中心），体型放大要等比跟上
  const petScale = () => (typeof windows.petScale === 'function' ? windows.petScale() : 1);
  const send = (p) => windows.send('pet', 'pet-ping', p || {});

  function setPetBounds(x, y) {
    const s = petSize();
    const w = windows.get('pet');
    if (w) w.setBounds({ x: Math.round(x), y: Math.round(y), width: s.w, height: s.h });
  }

  function petBounds() {
    const w = windows.get('pet');
    if (!w) return null;
    return w.getBounds();
  }

  // ------------------------------------------------------------ 抓奶蛙
  function tune(g, want) {
    const sp = Math.hypot(g.vx, g.vy) || 1;
    let vx = g.vx / sp * want;
    let vy = g.vy / sp * want;
    const maxVy = want * CATCH.MAXVY;
    if (Math.abs(vy) > maxVy) {
      const sgn = vy < 0 ? -1 : 1;
      vy = sgn * maxVy;
      vx = (vx < 0 ? -1 : 1) * Math.sqrt(Math.max(0, want * want - vy * vy));
    }
    g.vx = vx;
    g.vy = vy;
  }

  function start() {
    const b = petBounds();
    if (!b) return false;
    if (returnTimer) { clearTimeout(returnTimer); returnTimer = null; }
    if (catchGame) stop(false, 'restart');
    const s = petSize();
    const sc = petScale();
    const wa = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea;
    const g = {
      homeX: b.x, homeY: b.y,
      minX: wa.x - CATCH.OX * sc, minY: wa.y - CATCH.OY * sc,
      maxX: wa.x + wa.width - s.w + CATCH.OX * sc, maxY: wa.y + wa.height - s.h,
      x: b.x, y: b.y,
      vx: 0, vy: 0, dir: '', startAt: Date.now(), last: 0, timer: null, auto: null, dodges: 0
    };
    const side = Math.random() < 0.5 ? -1 : 1;
    const ang = (0.22 + Math.random() * 0.5) * (Math.random() < 0.5 ? -1 : 1);
    g.vx = side * Math.cos(ang);
    g.vy = Math.sin(ang);
    tune(g, CATCH.SPEED * (0.85 + Math.random() * 0.35));
    g.dir = g.vx >= 0 ? 'running-right' : 'running-left';
    catchGame = g;
    send({ action: 'catch-start' });
    g.auto = setTimeout(() => { if (catchGame === g) stop(false, 'timeout'); }, CATCH.MAX_MS);
    g.timer = setTimeout(() => {
      if (catchGame !== g) return;
      g.last = Date.now();
      g.timer = setInterval(step, CATCH.TICK_MS);
    }, CATCH.LAUGH_MS);
    return true;
  }

  function step() {
    const g = catchGame;
    const b = petBounds();
    if (!g || !b) return;
    const now = Date.now();
    let dt = (now - g.last) / 1000;
    g.last = now;
    if (!(dt > 0)) dt = 0;
    if (dt > 0.08) dt = 0.08;
    g.x += g.vx * dt;
    g.y += g.vy * dt;
    let hit = false;
    if (g.x <= g.minX) { g.x = g.minX; g.vx = Math.abs(g.vx); hit = true; }
    else if (g.x >= g.maxX) { g.x = g.maxX; g.vx = -Math.abs(g.vx); hit = true; }
    if (g.y <= g.minY) { g.y = g.minY; g.vy = Math.abs(g.vy); hit = true; }
    else if (g.y >= g.maxY) { g.y = g.maxY; g.vy = -Math.abs(g.vy); hit = true; }
    if (hit) {
      g.vx += (Math.random() - 0.5) * 140;
      g.vy += (Math.random() - 0.5) * 140;
      tune(g, CATCH.SPEED * (0.85 + Math.random() * 0.4));
    }
    const cp = screen.getCursorScreenPoint();
    let dx = (g.x + (CATCH.OX + 48) * petScale()) - cp.x;
    let dy = (g.y + (CATCH.OY + 52) * petScale()) - cp.y;
    let dist = Math.hypot(dx, dy);
    if (dist < CATCH.DODGE_R) {
      if (dist < 6) { dx = -g.vx; dy = -g.vy; dist = Math.hypot(dx, dy); }
      if (dist < 6) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; dist = Math.hypot(dx, dy) || 1; }
      const sp = Math.hypot(g.vx, g.vy) || CATCH.SPEED;
      const want = Math.min(CATCH.SPEED * CATCH.DODGE_MAX, Math.max(sp, CATCH.SPEED * CATCH.DODGE_MIN));
      const nx = dx / dist, ny = dy / dist;
      g.vx = g.vx * 0.2 + nx * want * 0.8;
      g.vy = g.vy * 0.2 + ny * want * 0.8;
      tune(g, want);
      g.dodges++;
    }
    const dir = g.vx >= 0 ? 'running-right' : 'running-left';
    if (dir !== g.dir) { g.dir = dir; send({ action: 'catch-dir', dir: dir }); }
    setPetBounds(g.x, g.y);
  }

  function stop(caught, reason = caught ? 'caught' : 'cancelled') {
    const g = catchGame;
    catchGame = null;
    if (!g) return 0;
    if (g.timer) { clearTimeout(g.timer); clearInterval(g.timer); }
    if (g.auto) clearTimeout(g.auto);
    const ms = Math.max(0, Date.now() - g.startAt - CATCH.LAUGH_MS);
    const result = { caught: !!caught, ms, reason };
    send({ action: 'catch-end', ...result });
    const back = () => setPetBounds(g.homeX, g.homeY);
    if (caught) returnTimer = setTimeout(() => { returnTimer = null; back(); }, 2600); else back();
    if (onCatchEnd) onCatchEnd(result);
    return ms;
  }

  const isCatching = () => !!catchGame;

  // ------------------------------------------------------------ 走过去
  function walkTo(tx, ty) {
    if (returnTimer) { clearTimeout(returnTimer); returnTimer = null; }
    return new Promise((resolve) => {
      const b = petBounds();
      if (!b) return resolve();
      const token = ++walkToken;
      const sx = b.x, sy = b.y;
      const s = petSize();
      const dist = Math.hypot(tx - sx, ty - sy);
      if (dist < 24) return resolve();
      const dur = Math.min(2800, Math.max(420, (dist / 1150) * 1000));
      const t0 = Date.now();
      let dirLast = '';
      petWalking = true;
      const stepOnce = () => {
        if (token !== walkToken) { petWalking = false; return resolve(); }
        const p = Math.min(1, (Date.now() - t0) / dur);
        const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
        const x = Math.round(sx + (tx - sx) * e);
        const y = Math.round(sy + (ty - sy) * e);
        const dir = tx >= sx ? 'running-right' : 'running-left';
        if (dir !== dirLast) { dirLast = dir; send({ action: 'walk', dir: dir }); }
        const w = windows.get('pet');
        if (!w) { petWalking = false; return resolve(); }
        w.setBounds({ x: x, y: y, width: s.w, height: s.h });
        if (p >= 1) {
          petWalking = false;
          send({ action: 'walk', dir: '' });
          return resolve();
        }
        setTimeout(stepOnce, 16);
      };
      stepOnce();
    });
  }

  function desktopIconPos(p) {
    return new Promise((resolve) => {
      let name = '';
      try { name = path.basename(p); } catch (e) { /* ignore */ }
      if (!name) return resolve(null);
      const b64 = Buffer.from(name, 'utf8').toString('base64');
      native.runScript(path.join(P.native, 'deskpos.ps1'), ['-B64', b64], { timeout: 12000 })
        .then((out) => {
          if (out && typeof out.x === 'number') resolve({ x: out.x, y: out.y });
          else resolve(null);
        })
        .catch(() => resolve(null));
    });
  }

  async function handleDrop(paths) {
    const list = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && p.trim() !== '');
    if (!list.length) return { ok: false };
    if (!dropHome) {
      const b = petBounds();
      if (b) dropHome = { x: b.x, y: b.y };
    }
    let walked = false;
    const ip = await desktopIconPos(list[0]);
    if (ip) {
      const disp = screen.getPrimaryDisplay();
      const s = disp.scaleFactor || 1;
      const wa = disp.workArea;
      const size = petSize();
      let wx = Math.round(ip.x / s - 100 - 95);
      let wy = Math.round(ip.y / s - 178);
      wx = Math.max(wa.x, Math.min(wx, wa.x + wa.width - size.w));
      wy = Math.max(wa.y, Math.min(wy, wa.y + wa.height - size.h));
      await walkTo(wx, wy);
      walked = true;
    }
    send({ action: 'drop-ask', paths: list });
    if (onAskRecycle) onAskRecycle(list);
    return { ok: true, walked: walked };
  }

  function returnHome() {
    if (dropHome && !petWalking) {
      const h = dropHome;
      dropHome = null;
      walkTo(h.x, h.y);
    }
    return true;
  }

  function isWalking() { return petWalking; }
  function cancelWalk() { walkToken++; petWalking = false; }

  return { start, stop, isCatching, walkTo, handleDrop, returnHome, isWalking, cancelWalk, desktopIconPos, CATCH };
}

module.exports = { createPetActions, CATCH };
