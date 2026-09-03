'use strict';
/* ============================================================
 * 🐍 贪吃蛇大乱斗 - 联机服务器（零依赖，无需 npm install）
 * 启动： node server.js          （默认端口 3000）
 *        node server.js 8080     （指定端口）
 * 其他电脑/手机用浏览器打开本机显示的网址即可玩。
 * ============================================================ */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

// ---------------- 公共配置 ----------------
const PORT = parseInt(process.argv[2] || process.env.PORT || '3000', 10);
const GRID_W = 44;                 // 场地宽度（格）
const GRID_H = 30;                 // 场地高度（格）
const TICK_MS = 100;               // 基础速度：每 100ms 走 1 格（加速时 2 格）
const START_LEN = 3;               // 出生长度
const MAX_PLAYERS = 16;            // 房间人数上限
const BOOST_FLOOR = 5;             // 长度必须大于 5 才能加速
const PELLET_CAP = 90;             // 场上食物上限
const SEED_PELLETS = 46;           // 开局食物数量
const GRACE_MS = 15000;            // 掉线后保留席位时间（昵称/重连）
const DUR_OPTIONS = [180000, 300000, 600000, 900000];
const DUR_DEFAULT = 300000;
// 玩法模式（与单机版一致）：经典=撞墙即死；穿越=穿墙而过；障碍=撞墙/障碍即死
const MODES = { classic: '经典', wrap: '穿越', obstacle: '障碍' };
const MODE_DEFAULT = 'classic';
const OBSTACLE_COUNT = 12;        // 障碍模式：每局随机生成的石块数
const POISON_CAP = 14;            // 场上毒太阳（太阳毒药）上限
const POISON_CHANCE = 0.09;       // 每个 tick（100ms）生成一个毒太阳的概率（约每秒 1 个）
const COLORS = [
  '#ff5252', '#ff9f43', '#ffd93d', '#6ab04c', '#22d3ee', '#3d6cff',
  '#7c4dff', '#e84393', '#00b894', '#00cec9', '#fd79a8', '#a29bfe',
  '#fdcb6e', '#55efc4', '#74b9ff', '#d63031'
];

const rnd = Math.random;
const randInt = (n) => Math.floor(rnd() * n);
const now = () => Date.now();

// ============================================================
// 最小 WebSocket 服务端（RFC6455，浏览器自动带掩码，无需 npm 包）
// ============================================================
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WsConn {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.alive = true;
    this.lastActive = now();     // 心跳：超过 45s 无任何消息则判定掉线
    this.onMsg = null;           // (text) => void
    this.onClose = null;         // () => void
    sock.on('data', (d) => this._feed(d));
    sock.on('error', () => this._end());
    sock.on('close', () => this._end());
    this._hb = setInterval(() => {
      if (!this.alive) return clearInterval(this._hb);
      if (now() - this.lastActive > 45000) return this._end();
      this._frame(0x9, Buffer.alloc(0)); // ping（浏览器会自动回 pong）
    }, 15000);
    this._hb.unref && this._hb.unref();
  }
  _feed(d) {
    this.lastActive = now();
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.alive && this.buf.length >= 2) {
      const b1 = this.buf[0], b2 = this.buf[1];
      const fin = (b1 & 0x80) !== 0;
      const op = b1 & 0x0f;
      const masked = (b2 & 0x80) !== 0;
      let len = b2 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; const hi = this.buf.readUInt32BE(2), lo = this.buf.readUInt32BE(6); len = hi * 0x100000000 + lo; off = 10; }
      if (len > (1 << 20)) return this._end();           // 单条消息上限 1MB
      if (!masked) return this._end();                    // 客户端消息必须带掩码
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      this._handle(fin, op, payload);
    }
  }
  _handle(fin, op, payload) {
    if (op === 8) { this.sendClose(1000); this._end(); return; }   // close
    if (op === 9) { this._frame(0xA, payload); return; }           // ping -> pong
    if (op === 10) return;                                         // pong
    if (op === 1 && fin) { if (this.onMsg) { try { this.onMsg(payload.toString('utf8')); } catch (e) {} } }
  }
  _frame(op, data) {
    if (!this.alive) return;
    const len = data.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len >>> 0, 6); }
    try { this.sock.write(Buffer.concat([head, data])); } catch (e) {}
  }
  sendText(str) { this._frame(0x1, Buffer.from(str, 'utf8')); }
  sendClose(code) { const b = Buffer.alloc(2); b.writeUInt16BE(code || 1000, 0); this._frame(0x8, b); }
  _end() {
    if (!this.alive) return;
    this.alive = false;
    try { this.sock.destroy(); } catch (e) {}
    if (this.onClose) { const cb = this.onClose; this.onClose = null; try { cb(); } catch (e) {} }
  }
}

// ============================================================
// 房间与玩家
// ============================================================
const rooms = new Map(); // code -> room

function createRoom() {
  let code;
  do { code = String(100000 + randInt(900000)); } while (rooms.has(code));
  const room = {
    code,
    phase: 'lobby',          // lobby | countdown | playing | over
    players: new Map(),      // pid -> player
    foods: new Map(),        // 格索引 -> 食物分值(1或3)
    cfg: { durMs: DUR_DEFAULT, mode: MODE_DEFAULT },
    roundNo: 0,
    obstacles: new Set(),        // 本局障碍物：格索引（障碍模式外恒为空）
    poisons: new Map(),          // 本局毒太阳：格索引 -> 1
    nextPid: 1,
    hostCid: '',
    sysMsgs: [],
    ph: {},                  // 阶段附加信息
    pendingMode: null,       // 房主在对局中切换的玩法：当前局结束后生效
    cdEndAt: 0, cdLastN: 0,
    overAt: 0,
    winners: [], winSnakes: [],
  };
  rooms.set(code, room);
  return room;
}

function makePlayer(room, ws, cid, name, colorIdx) {
  const p = {
    pid: room.nextPid++, cid: cid || ('x' + Math.random().toString(36).slice(2)),
    name, connected: true, ws,
    colorIdx: -1,
    wins: 0,
    alive: false, snake: null, scoreLen: START_LEN,
  };
  // 分配不重复的颜色
  const used = new Set();
  for (const q of room.players.values()) used.add(q.colorIdx);
  let want = (Number.isInteger(colorIdx) && colorIdx >= 0 && colorIdx < COLORS.length) ? colorIdx : -1;
  if (want < 0 || used.has(want)) {
    want = -1;
    for (let i = 0; i < COLORS.length; i++) if (!used.has(i)) { want = i; break; }
  }
  p.colorIdx = want < 0 ? 0 : want;
  return p;
}

function occSet(room) {
  const occ = new Set();
  for (const q of room.players.values()) {
    if (q.alive && q.snake) for (const [x, y] of q.snake.cells) occ.add(y * GRID_W + x);
  }
  for (const idx of room.obstacles) occ.add(idx);
  for (const idx of room.poisons.keys()) occ.add(idx);
  return occ;
}

function addPellet(room, idx) {
  if (room.foods.size >= PELLET_CAP && !room.foods.has(idx)) return;
  if (room.obstacles.has(idx) || room.poisons.has(idx)) return;
  room.foods.set(idx, 1);
}

function seedPellets(room) {
  room.foods.clear();
  const occ = occSet(room);
  let placed = 0, guard = 0;
  while (placed < SEED_PELLETS && guard++ < 4000) {
    const idx = randInt(GRID_W * GRID_H);
    if (occ.has(idx) || room.foods.has(idx)) continue;
    room.foods.set(idx, 1);
    placed++;
  }
}

function ambientFood(room) {
  if (room.foods.size >= PELLET_CAP || rnd() >= 0.55) return;
  const occ = occSet(room);
  for (let t = 0; t < 60; t++) {
    const idx = randInt(GRID_W * GRID_H);
    if (!occ.has(idx) && !room.foods.has(idx)) {
      room.foods.set(idx, 1);
      return;
    }
  }
}

// 毒太阳定时生成（三种玩法都有，和单机版一致）
function ambientPoison(room) {
  if (room.poisons.size >= POISON_CAP || rnd() >= POISON_CHANCE) return;
  const occ = occSet(room);
  for (let t = 0; t < 60; t++) {
    const idx = randInt(GRID_W * GRID_H);
    if (!occ.has(idx) && !room.foods.has(idx)) {
      room.poisons.set(idx, 1);
      return;
    }
  }
}

// 障碍模式：开局随机铺石块（避开场地四周边线，保证永远有路可绕）
function genObstacles(room) {
  room.obstacles.clear();
  if (room.cfg.mode !== 'obstacle') return;
  let placed = 0, guard = 0;
  while (placed < OBSTACLE_COUNT && guard++ < 3000) {
    const x = 1 + randInt(GRID_W - 2), y = 1 + randInt(GRID_H - 2);
    const idx = y * GRID_W + x;
    if (room.obstacles.has(idx)) continue;
    room.obstacles.add(idx);
    placed++;
  }
}

// 从房间/对局中彻底移除一名玩家
function removePlayerFinal(room, p, announce) {
  room.players.delete(p.pid);
  if (announce && room.phase !== 'over') room.sysMsgs.push(`${p.name} 离开了房间`);
  if (room.hostCid === p.cid) {
    const next = [...room.players.values()].find((q) => q.connected);
    room.hostCid = next ? next.cid : '';
    console.log(`[log] 房间 ${room.code}: 房主 ${p.name} 离开，${next ? next.name + ' 接任房主' : '房间暂无房主'}`);
    if (next) room.sysMsgs.push(`${next.name} 成为房主`);
  }
  if (!room.players.size) rooms.delete(room.code);
}

// ============================================================
// 对局逻辑
// ============================================================
// 出生规则：出生线 3 格 + 头部正前方 1 格都必须为空且在场地内，避免开局即撞墙/撞人
function spawnSnakeAt(room, p, len) {
  const occ = occSet(room);
  for (let t = 0; t < 800; t++) {
    const x = randInt(GRID_W), y = randInt(GRID_H);
    const dir = randInt(4);
    const dx = [1, 0, -1, 0][dir], dy = [0, 1, 0, -1][dir];
    const cells = [];
    let cx = x, cy = y, ok = true;
    // 头前方预留一格
    const fx = x + dx, fy = y + dy;
    if (fx < 0 || fx >= GRID_W || fy < 0 || fy >= GRID_H || occ.has(fy * GRID_W + fx)) ok = false;
    for (let i = 0; ok && i < len; i++) {
      const idx = cy * GRID_W + cx;
      if (cx < 0 || cx >= GRID_W || cy < 0 || cy >= GRID_H || occ.has(idx)) { ok = false; break; }
      cells.push([cx, cy]);
      cx -= dx; cy -= dy;   // 尾巴向反方向延伸
    }
    if (ok) {
      p.alive = true;
      p.snake = { cells, dir, queue: [], boosting: false };
      return;
    }
  }
  // 极端拥挤的保底：任意空格
  for (let i = 0; i < GRID_W * GRID_H; i++) {
    const idx = randInt(GRID_W * GRID_H);
    if (!occ.has(idx) && !room.foods.has(idx)) {
      p.alive = true;
      p.snake = { cells: [[idx % GRID_W, Math.floor(idx / GRID_W)]], dir: 0, queue: [], boosting: false };
      return;
    }
  }
  p.alive = false;
  p.snake = null;
}

function startRound(room) {
  // 移除所有掉线者（掉线超时者已被调度器清理，这里兜底）
  for (const p of [...room.players.values()]) {
    if (!p.connected) removePlayerFinal(room, p, false);
  }
  room.roundNo++;
  room.ph = {};
  room.lastEvents = [];
  genObstacles(room);
  room.poisons.clear();
  seedPellets(room);
  for (const p of room.players.values()) {
    p.alive = false; p.snake = null;
    if (p.connected) spawnSnakeAt(room, p, START_LEN);
  }
  room.phase = 'playing';
  room.ph.endAt = now() + room.cfg.durMs;
  room.sysMsgs.push(`第 ${room.roundNo} 局开始！坚持到最后的蛇就是冠军`);
  emitRoom(room);
}

function computeWinners(room) {
  const alive = [...room.players.values()].filter((p) => p.alive && p.snake);
  if (!alive.length) return [];
  const maxLen = Math.max(...alive.map((p) => p.snake.cells.length));
  return alive.filter((p) => p.snake.cells.length === maxLen);
}

function endRound(room, winners) {
  room.phase = 'over';
  room.lastEvents = [];
  room.winners = winners.map((w) => w.pid);
  room.winSnakes = winners.map((w) => w.snake ? [...w.snake.cells].flat() : []);
  for (const p of room.players.values()) {
    if (p.alive && p.snake) p.scoreLen = p.snake.cells.length;
    if (p.alive) p.alive = false;
    if (p.snake && !room.winners.includes(p.pid)) p.snake = null;
  }
  for (const w of winners) w.wins++;
  room.overAt = now() + 8000;   // 8 秒后自动下一局；任意玩家可按【空格】立即跳过
  if (winners.length) room.sysMsgs.push(`🏆 ${winners.map((w) => w.name).join('、')} 获得第 ${room.roundNo} 局胜利！`);
  else room.sysMsgs.push('本局无人存活，平局！');
  emitRoom(room);
}

// 统一入口：任意阶段 → 3 秒倒计时。
// 若房主对局中切换过玩法，在这里落盘（本局保持原玩法，下一局起生效）。
function goCountdown(room, nowT) {
  if (room.pendingMode) {
    room.cfg.mode = room.pendingMode;
    room.pendingMode = null;
    room.sysMsgs.push(`玩法已切换为「${MODES[room.cfg.mode]}」`);
  }
  room.phase = 'countdown';
  room.cdEndAt = nowT + 3000;
  room.cdLastN = 3;   // 本次 emit 已带 n=3，避免 200ms 后重复广播一次 3
  room.ph = { n: 3 };
  room.sysMsgs.push(`第 ${room.roundNo + 1} 局即将开始！`);
  emitRoom(room);
}

// 一局的核心模拟（每个 tick 调用一次；加速者一 tick 走两格）
function simulate(room) {
  const events = [];
  const movers = [];
  for (const p of room.players.values()) {
    if (!p.alive || !p.snake) continue;
    p.snake.boosting = p.snake.boosting && p.snake.cells.length > BOOST_FLOOR;
    if (p.snake.boosting) {
      // 加速消耗 1 格长度，尾巴变为食物
      const tail = p.snake.cells[p.snake.cells.length - 1];
      addPellet(room, tail[1] * GRID_W + tail[0]);
      p.snake.cells.pop();
      p.snake.stepsLeft = 2;
    } else {
      p.snake.stepsLeft = 1;
    }
    movers.push(p);
  }
  const micros = movers.some((p) => p.snake.stepsLeft === 2) ? 2 : 1;
  const dx = [1, 0, -1, 0], dy = [0, 1, 0, -1];

  for (let mi = 0; mi < micros; mi++) {
    const active = movers.filter((p) => p.snake.stepsLeft > 0);
    if (!active.length) break;
    for (const p of active) p.snake.stepsLeft--;

    // 1) 每个存活蛇本步最多应用一个转向意图（禁止 180° 掉头）
    for (const p of active) {
      const s = p.snake;
      while (s.queue.length) {
        const d = s.queue.shift();
        if (d === (s.dir + 2) % 4) continue;
        s.dir = d;
        break;
      }
    }
    // 2) 头前进方向的目标格（穿越模式：从对侧穿出）
    const heads = new Map();
    const targetCount = new Map();
    for (const p of active) {
      const s = p.snake;
      let hx = s.cells[0][0] + dx[s.dir], hy = s.cells[0][1] + dy[s.dir];
      if (room.cfg.mode === 'wrap') {
        hx = ((hx % GRID_W) + GRID_W) % GRID_W;
        hy = ((hy % GRID_H) + GRID_H) % GRID_H;
      }
      heads.set(p.pid, [hx, hy]);
      const key = hy * GRID_W + hx;
      targetCount.set(key, (targetCount.get(key) || 0) + 1);
    }
    // 3) 占用表：蛇身（会离开的尾巴除外，吃到食物时尾巴会留下）
    const occupy = new Map(); // idx -> player
    const willEat = new Map(); // pid -> bool
    for (const p of active) {
      const s = p.snake;
      const [hx, hy] = heads.get(p.pid);
      willEat.set(p.pid, room.foods.has(hy * GRID_W + hx));
    }
    for (const q of room.players.values()) {
      if (!q.alive || !q.snake) continue;
      const cells = q.snake.cells;
      const vacatesTail = active.includes(q) && !willEat.get(q.pid) && cells.length > 1;
      for (let i = 0; i < cells.length; i++) {
        if (vacatesTail && i === cells.length - 1) continue;
        const key = cells[i][1] * GRID_W + cells[i][0];
        if (!occupy.has(key)) occupy.set(key, q);
      }
    }
    // 4) 死亡判定
    const dead = new Set();
    for (const p of active) {
      const [hx, hy] = heads.get(p.pid);
      const key = hy * GRID_W + hx;
      if (hx < 0 || hx >= GRID_W || hy < 0 || hy >= GRID_H) { p.deadReason = 'wall'; dead.add(p.pid); continue; }
      if (room.obstacles.has(key)) { p.deadReason = 'obs'; dead.add(p.pid); continue; }
      if (room.poisons.has(key)) { p.deadReason = 'poison'; dead.add(p.pid); continue; }
      if ((targetCount.get(key) || 0) > 1) { p.deadReason = 'crash'; dead.add(p.pid); continue; }
      const o = occupy.get(key);
      if (o) {
        if (o === p) p.deadReason = 'self';
        else { p.deadReason = 'kill'; p.killer = o.pid; }
        dead.add(p.pid);
      }
    }
    // 5) 幸存者前进 + 进食
    for (const p of active) {
      if (dead.has(p.pid)) continue;
      const s = p.snake;
      const [hx, hy] = heads.get(p.pid);
      const key = hy * GRID_W + hx;
      s.cells.unshift([hx, hy]);
      if (room.foods.has(key)) {
        const v = room.foods.get(key);
        room.foods.delete(key);
        const tail = s.cells[s.cells.length - 1];
        for (let i = 0; i < v; i++) s.cells.push([tail[0], tail[1]]);
      } else {
        s.cells.pop();
      }
    }
    // 6) 阵亡处理：身体变食物
    for (const p of active) {
      if (!dead.has(p.pid)) continue;
      if (!p.alive || !p.snake) continue;
      if (process.env.DBG) console.log(`[dbg] tick#${room.tickNo} ${p.name} 阵亡原因=${p.deadReason} 头部=(${p.snake.cells[0]}) len=${p.snake.cells.length} 队列=${p.snake.queue.length}`);
      events.push({
        t: 'death', i: p.pid, nm: p.name, r: p.deadReason,
        k: p.killer || 0,
        kn: p.killer ? (room.players.get(p.killer) || {}).name || '' : '',
      });
      p.scoreLen = p.snake.cells.length;
      for (const [x, y] of p.snake.cells) {
        if (room.foods.size >= PELLET_CAP) break;
        const idx = y * GRID_W + x;
        if (!room.foods.has(idx) && !room.obstacles.has(idx) && !room.poisons.has(idx)) room.foods.set(idx, 1);
      }
      p.alive = false;
      p.snake = null;
      delete p.killer;
    }
  }
  room.lastEvents = events;

  // 7) 胜负判定
  const alive = [...room.players.values()].filter((p) => p.alive && p.snake);
  if (process.env.DBG) {
    console.log(`[dbg] tick#${room.tickNo} 存活 ${alive.length}: ${alive.map((p) => `${p.name}@${p.snake.cells.length}`).join(' ')} | foods=${room.foods.size} pois=${room.poisons.size} stones=${room.obstacles.size} mode=${room.cfg.mode}`);
  }
  if (alive.length === 1) { endRound(room, alive); return; }
  if (alive.length === 0) { endRound(room, []); return; }
  if (now() >= room.ph.endAt) { endRound(room, computeWinners(room)); return; }
  ambientFood(room);
  ambientPoison(room);
}

// ============================================================
// 消息与广播
// ============================================================
function snapshotCore(room, mePid, drainMsgs) {
  const players = [];
  const inLobby = room.phase === 'lobby';
  for (const p of room.players.values()) {
    players.push({
      i: p.pid, n: p.name, c: p.colorIdx, w: p.wins,
      l: p.alive && p.snake ? p.snake.cells.length : (inLobby ? 0 : p.scoreLen),
      a: (inLobby || p.alive) ? 1 : 0, d: p.connected ? 0 : 1, h: room.hostCid === p.cid ? 1 : 0,
    });
  }
  players.sort((a, b) => (b.a - a.a) || (b.l - a.l) || (a.n < b.n ? -1 : 1));
  const ph = { ph: room.phase, durMs: room.cfg.durMs, g: [GRID_W, GRID_H], mode: room.cfg.mode };
  if (room.phase === 'countdown') { ph.n = room.ph.n; ph.r = room.roundNo + 1; } // 下一局的局号
  if (room.phase === 'playing') { ph.endAt = room.ph.endAt; ph.r = room.roundNo; }
  if (room.phase === 'over') { ph.win = room.winners; ph.at = room.overAt; ph.r = room.roundNo; }
  const core = { room: { code: room.code, ...ph }, players, me: mePid, m: drainMsgs ? room.sysMsgs.splice(0, 6) : [] };
  if (room.phase === 'playing' || room.phase === 'over') {
    const snakes = [], foods = [];
    if (room.phase === 'playing') {
      for (const p of room.players.values()) {
        if (p.alive && p.snake) snakes.push({ i: p.pid, c: p.snake.cells.flat() });
      }
    } else {
      for (let j = 0; j < room.winners.length; j++) {
        snakes.push({ i: room.winners[j], c: room.winSnakes[j] || [] });
      }
    }
    for (const [idx, v] of room.foods) foods.push(idx % GRID_W, Math.floor(idx / GRID_W), v);
    core.snakes = snakes;
    core.foods = foods;
  }
  return core;
}

function emitRoom(room) {
  const str = JSON.stringify({ t: 'room', ...snapshotCore(room, null, true) });
  for (const p of room.players.values()) if (p.connected && p.ws) p.ws.sendText(str);
}

function sendTick(room) {
  const str = JSON.stringify({
    t: 'tick', n: room.tickNo,
    s: room.tickSnakes, f: room.tickFoods,
    p: room.tickPoisons, o: room.tickObstacles,
    e: room.lastEvents && room.lastEvents.length ? room.lastEvents : undefined,
    m: room.sysMsgs.length ? room.sysMsgs.splice(0, 5) : undefined,
  });
  room.lastEvents = [];
  for (const p of room.players.values()) if (p.connected && p.ws) p.ws.sendText(str);
}

function prepareTick(room) {
  const snakes = [], foods = [], pois = [], obs = [];
  for (const p of room.players.values()) {
    if (p.alive && p.snake) snakes.push({ i: p.pid, c: p.snake.cells.flat() });
  }
  for (const [idx, v] of room.foods) foods.push(idx % GRID_W, Math.floor(idx / GRID_W), v);
  for (const idx of room.poisons.keys()) pois.push(idx % GRID_W, Math.floor(idx / GRID_W));
  for (const idx of room.obstacles) obs.push(idx % GRID_W, Math.floor(idx / GRID_W));
  room.tickSnakes = snakes;
  room.tickFoods = foods;
  room.tickPoisons = pois;
  room.tickObstacles = obs;
}

// ============================================================
// 连接处理
// ============================================================
function rejectAndClose(conn, msg) {
  conn.sendText(JSON.stringify({ t: 'err', m: msg }));
  setTimeout(() => { try { conn.sendClose(1000); } catch (e) {} }, 80);
}

function handleWs(room, conn, params) {
  let name = '', cid = '', colorIdx = -1;
  try { name = decodeURIComponent(params.get('name') || '').trim().slice(0, 12); } catch (e) {}
  try { cid = decodeURIComponent(params.get('cid') || '').slice(0, 64); } catch (e) {}
  const ci = parseInt(params.get('color') || '', 10);
  if (!Number.isNaN(ci)) colorIdx = ci;

  if (!name) return rejectAndClose(conn, '昵称不能为空');
  console.log(`[log] 连接请求: room=${room.code} name=${name} cid=${cid.slice(0, 12)}…`);

  // ---- 重连：同 cid 即视为同一身份（刷新竞态 / 同身份双开时抢占接管席位） ----
  let p = null;
  for (const q of room.players.values()) {
    if (q.cid && q.cid === cid) { p = q; break; }
  }
  if (p) {
    // 旧连接还活着：先踢掉它再接管，避免刷新瞬间新旧连接并存被当成两个玩家
    if (p.connected && p.ws && p.ws !== conn) {
      console.log(`[log] 同身份双连接: 踢掉 ${p.name} 的旧连接，新连接接管席位`);
      try { p.ws.close(); } catch (e) {}
      p.ws = null;
      p.connected = false;
    }
    p.connected = true;
    p.ws = conn;
    p.name = name;
    const used = new Set();
    for (const q of room.players.values()) if (q !== p) used.add(q.colorIdx);
    if (colorIdx >= 0 && !used.has(colorIdx)) p.colorIdx = colorIdx;
    // 原房主已不在：由重连者接任（否则房间可能永远没有房主）
    if (!room.hostCid || ![...room.players.values()].some((q) => q.cid === room.hostCid && q.connected)) {
      room.hostCid = p.cid;
      room.sysMsgs.push(`${p.name} 成为房主`);
    }
    room.sysMsgs.push(`${p.name} 重新连接`);
    if (room.phase === 'playing' && !p.alive) spawnSnakeAt(room, p, START_LEN); // 掉线期间阵亡，直接复活
  } else {
    // ---- 全新加入 ----
    console.log(`[log] 全新加入: name=${name} cid=${cid.slice(0, 12)}…（无同 cid 席位，身份未匹配）`);
    if (room.players.size >= MAX_PLAYERS) return rejectAndClose(conn, `房间已满（最多 ${MAX_PLAYERS} 人）`);
    for (const q of room.players.values()) {
      if (q.connected && q.name === name) return rejectAndClose(conn, '昵称已被占用');
    }
    p = makePlayer(room, conn, cid, name, colorIdx);
    room.players.set(p.pid, p);
    if (!room.hostCid || ![...room.players.values()].some((q) => q.cid === room.hostCid && q.connected)) {
      room.hostCid = p.cid;
      room.sysMsgs.push(`${p.name} 创建了房间，等待其他人输入房间号 ${room.code} 加入`);
    } else {
      room.sysMsgs.push(`${p.name} 加入了房间`);
    }
    if (room.phase === 'playing') {
      spawnSnakeAt(room, p, START_LEN);          // 对局进行中加入战斗
      if (!p.alive) {
        room.players.delete(p.pid);
        room.sysMsgs.pop();
        return rejectAndClose(conn, '场地已满，请稍后再试');
      }
    }
  }
  conn.onMsg = (data) => {
    let m;
    try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'dir' && p.alive && p.snake && Number.isInteger(m.d)) {
      const d = ((m.d % 4) + 4) % 4;
      if (p.snake.queue.length < 8) p.snake.queue.push(d);
    } else if (m.t === 'bo' && p.alive && p.snake) {
      p.snake.boosting = !!m.b;
    } else if (m.t === 'start' && room.hostCid === p.cid && room.phase === 'lobby') {
      if (room.players.size < 2) return p.ws.sendText(JSON.stringify({ t: 'err', m: '至少需要 2 名玩家才能开始' }));
      goCountdown(room, now());
    } else if (m.t === 'cfg' && room.hostCid === p.cid) {
      let changed = false;
      // 每局时长仅大厅可调
      if (room.phase === 'lobby' && DUR_OPTIONS.includes(m.d)) { room.cfg.durMs = m.d; changed = true; }
      // 玩法模式对房主全阶段开放：大厅/倒计时/结算立即生效；对局中则本局结束后生效
      if (MODES[m.mode] && m.mode !== (room.pendingMode || room.cfg.mode)) {
        changed = true;
        if (room.phase === 'playing') {
          room.pendingMode = m.mode;
          room.sysMsgs.push(`房主已将玩法切换为「${MODES[m.mode]}」——当前局结束后生效`);
        } else {
          room.pendingMode = null;
          room.cfg.mode = m.mode;
          room.sysMsgs.push(`房主将玩法切换为「${MODES[m.mode]}」`);
        }
      }
      if (changed) emitRoom(room);
    } else if (m.t === 'next' && room.phase === 'over') {
      // 任意玩家按【空格】跳过结算等待，立即进入下一局的 3 秒倒计时
      const ready = [...room.players.values()].filter((q) => q.connected);
      if (ready.length < 2) {
        return p.ws.sendText(JSON.stringify({ t: 'err', m: `还差 ${2 - ready.length} 名在线玩家，无法立即开始下一局` }));
      }
      goCountdown(room, now());
    } else if (m.t === 'leave') {
      leavePlayer(room, p);
      try { conn.sendClose(1000); } catch (e) {}
      conn._end();
    }
  };

  const welcome = { t: 'welcome', you: { i: p.pid, n: p.name, c: p.colorIdx }, ...snapshotCore(room, p.pid, false) };
  conn.sendText(JSON.stringify(welcome));
  // 让房间里其他玩家也能看到名单/消息变化（对局中每 100ms 有 tick，这里只在进出房间时触发，流量可忽略）
  emitRoom(room);
}

function leavePlayer(room, p) {
  if (!room.players.has(p.pid)) return;
  removePlayerFinal(room, p, true);
  if (room.players.size) emitRoom(room);
}

// 掉线处理：对局中立即把蛇变成食物，席位保留 GRACE_MS 供重连
function onPlayerDisconnect(room, conn) {
  for (const p of room.players.values()) {
    if (p.ws !== conn || !p.connected) continue;
    console.log(`[log] 房间 ${room.code}: ${p.name} 连接断开`);
    p.connected = false;
    p.ws = null;
    p.disconnectedAt = now();
    if (room.hostCid === p.cid) {
      // 不掉线转移房主：刷新/断网会在几百毫秒内重连回来，房主随席位保留。
      // 只有超时未归（removePlayerFinal）才把房主交给下一位在线玩家。
      room.sysMsgs.push(`${p.name} 掉线了，正在等待重连…（${Math.round(GRACE_MS / 1000)} 秒内未归将移交房主）`);
    } else {
      room.sysMsgs.push(`${p.name} 掉线了，正在等待重连…`);
    }
    if (room.phase === 'playing' && p.alive && p.snake) {
      // 对局中掉线：立即阵亡，身体变食物（席位仍保留供重连）
      p.scoreLen = p.snake.cells.length;
      for (const [x, y] of p.snake.cells) {
        if (room.foods.size >= PELLET_CAP) break;
        const idx = y * GRID_W + x;
        if (!room.foods.has(idx) && !room.obstacles.has(idx) && !room.poisons.has(idx)) room.foods.set(idx, 1);
      }
      p.alive = false;
      p.snake = null;
    }
    emitRoom(room);
    return;
  }
}

// ============================================================
// 定时器：倒计时 / 自动下一局 / 掉线清理
// ============================================================
function scheduler() {
  const nowT = now();
  for (const room of rooms.values()) {
    // 掉线超时者移除（房间空后自动删除）
    let removedAny = false;
    for (const p of [...room.players.values()]) {
      if (!p.connected && nowT - p.disconnectedAt > GRACE_MS) { removePlayerFinal(room, p, false); removedAny = true; }
    }
    if (!room.players.size) { rooms.delete(room.code); continue; }
    // 有掉线席位被清理时立刻刷新一遍房间消息，避免客户端残留“掉线中”的旧行
    if (removedAny) emitRoom(room);

    if (room.phase === 'countdown') {
      const remain = Math.ceil((room.cdEndAt - nowT) / 1000);
      if (remain <= 0) {
        room.phase = 'playing';
        startRound(room);
      } else if (remain !== room.cdLastN) {
        room.cdLastN = remain;
        room.ph.n = remain;
        emitRoom(room);
      }
    } else if (room.phase === 'over' && nowT >= room.overAt) {
      const ready = [...room.players.values()].filter((q) => q.connected);
      if (ready.length >= 2) {
        goCountdown(room, nowT);
      } else {
        if (room.pendingMode) {
          room.cfg.mode = room.pendingMode;
          room.pendingMode = null;
          room.sysMsgs.push(`玩法已切换为「${MODES[room.cfg.mode]}」`);
        }
        room.phase = 'lobby';
        room.ph = {};
        room.sysMsgs.push('人数不足，回到大厅等待新玩家…');
        emitRoom(room);
      }
    }
  }
}
setInterval(scheduler, 200);

// 对局心跳：100ms 一步
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.phase !== 'playing') continue;
    room.tickNo = (room.tickNo || 0) + 1;
    simulate(room);
    if (room.phase !== 'playing') continue; // 本步已分出胜负
    prepareTick(room);
    sendTick(room);
  }
}, TICK_MS);

// ============================================================
// HTTP 静态文件 + WebSocket 升级
// ============================================================
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2',
};

// ============================================================
// 网页内公网分享：隧道（cloudflared）由服务器静默托管，无额外窗口
// ============================================================
const CF_EXE = path.join(__dirname, 'cloudflared.exe');
let tunnelProc = null;
let tunnelUrl = '';

function tunnelStart() {
  if (tunnelProc) return { ok: true, starting: !tunnelUrl, url: tunnelUrl || null };
  if (!fs.existsSync(CF_EXE)) {
    return { ok: false, m: '缺少 cloudflared.exe（在游戏文件夹里双击「启动-互联网联机.bat」会自动补上它）' };
  }
  console.log('[log] 正在启动公网隧道（网页内开启，后台静默运行）…');
  try {
    tunnelProc = spawn(CF_EXE, ['tunnel', '--url', 'http://127.0.0.1:' + PORT], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (e) {
    console.log('[log] 公网隧道启动失败: ' + e.message);
    return { ok: false, m: '启动失败：' + e.message };
  }
  const parse = (buf) => {
    const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !tunnelUrl) {
      tunnelUrl = m[0];
      console.log(`[log] 公网隧道已就绪: ${tunnelUrl}`);
    }
  };
  tunnelProc.stdout.on('data', parse);
  tunnelProc.stderr.on('data', parse);
  tunnelProc.on('exit', (code) => {
    console.log(`[log] 公网隧道进程已退出 code=${code}`);
    tunnelProc = null;
    tunnelUrl = '';
  });
  return { ok: true, starting: true, url: null };
}

function tunnelStop() {
  if (tunnelProc) { try { tunnelProc.kill(); } catch (e) {} tunnelProc = null; }
  tunnelUrl = '';
  return { ok: true };
}

// 服务器退出时带走隧道进程，不留孤儿
const killTunnel = () => { if (tunnelProc) { try { tunnelProc.kill(); } catch (e) {} } };
process.on('exit', killTunnel);
process.on('SIGINT', () => { killTunnel(); process.exit(0); });
process.on('SIGTERM', () => { killTunnel(); process.exit(0); });

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/api/tunnel') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.method === 'POST') return res.end(JSON.stringify(tunnelStart()));
    if (req.method === 'DELETE') return res.end(JSON.stringify(tunnelStop()));
    return res.end(JSON.stringify({ ok: true, url: tunnelUrl || null }));
  }
  if (u.pathname === '/api/ping') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, time: now() }));
    return;
  }
  if (u.pathname === '/api/rooms' && req.method === 'POST') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (rooms.size >= 300) { res.end(JSON.stringify({ code: null, m: '服务器房间过多，请稍后再试' })); return; }
    const room = createRoom();
    res.end(JSON.stringify({ code: room.code }));
    return;
  }
  let p = u.pathname;
  if (p === '/') p = '/index.html';
  if (p.includes('..')) { res.writeHead(403); return res.end('Forbidden'); }
  const file = path.join(__dirname, 'public', p);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not Found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

server.on('upgrade', (req, sock) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname !== '/ws') { sock.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  if (!key) { sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  sock.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  const conn = new WsConn(sock);
  conn.onClose = () => onPlayerDisconnect(room, conn);

  const roomCode = (u.searchParams.get('room') || '').trim();
  const room = rooms.get(roomCode);
  if (!room) {
    conn.onClose = null;
    return rejectAndClose(conn, '房间不存在或已关闭');
  }
  handleWs(room, conn, u.searchParams);
});

// ============================================================
// 启动输出
// ============================================================
function lanIPs() {
  const list = [];
  for (const k of Object.keys(os.networkInterfaces())) {
    for (const it of os.networkInterfaces()[k] || []) {
      if (it.family === 'IPv4' && !it.internal) list.push(it.address);
    }
  }
  return list;
}

server.listen(PORT, '0.0.0.0', () => {
  const line = '='.repeat(54);
  console.log(line);
  console.log('  🐍 贪吃蛇大乱斗 · 服务器已启动');
  console.log('');
  console.log('  本机地址   : http://localhost:' + PORT);
  for (const ip of lanIPs()) console.log('  局域网地址 : http://' + ip + ':' + PORT);
  console.log('');
  console.log('  ▶ 局域网玩法（同一 WiFi / 网线）：');
  console.log('    其他电脑浏览器打开上面的【局域网地址】，创建房间后');
  console.log('    把 6 位房间号告诉朋友，他们输入房间号即可加入。');
  console.log('');
  console.log('  ▶ 互联网玩法（不同网络）：双击 启动-互联网联机.bat');
  console.log('    生成公网网址后发给朋友，打开网址输入房间号即可。');
  console.log('');
  console.log('  ⚠ 首次运行若弹出 Windows 防火墙提示，请点【允许访问】');
  console.log('    （没弹窗或之前拒绝了，可运行 放行防火墙.bat）');
  console.log(line);
});
