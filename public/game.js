'use strict';
/* ============================================================
 * 🐍 贪吃蛇大乱斗 - 网页客户端
 * 纯原生 JS + Canvas：无需任何安装 / 打包
 * ============================================================ */

// ---------- 与服务器一致的公共常量 ----------
const PALETTE = [
  '#ff5252', '#ff9f43', '#ffd93d', '#6ab04c', '#22d3ee', '#3d6cff',
  '#7c4dff', '#e84393', '#00b894', '#00cec9', '#fd79a8', '#a29bfe',
  '#fdcb6e', '#55efc4', '#74b9ff', '#d63031',
];
const CELL = 20;          // 逻辑像素 / 格
const DISPLAY_DELAY = 150; // 渲染回放延迟（ms），配合插值让画面平滑
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]]; // 0右 1下 2左 3上

// 玩法模式（与服务器一致）
const MODE_LABELS = { classic: '经典', wrap: '穿越', obstacle: '障碍' };
const MODE_DESC = {
  classic: '经典 · 场地没有墙，但撞到边缘就会出局',
  wrap: '穿越 · 可以从地图一侧穿到另一侧（不撞墙）',
  obstacle: '障碍 · 场上会随机出现灰色石块，撞墙撞石都会出局',
};

// ---------- 持久化个人资料 ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('snake_' + k); return v === null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('snake_' + k, v); } catch (e) {} },
};
const my = {
  name: store.get('name', ''),
  color: parseInt(store.get('color', '-1'), 10),
  muted: store.get('muted', '0') === '1',
};
// 玩家身份按“标签页”隔离（sessionStorage）：同浏览器开两个窗口 = 两个不同玩家。
// 刷新页面 / 断线时 sessionStorage 还在，可以无缝重连；关掉标签页则放弃席位重新加入。
function ensureCid() {
  try {
    let cid = sessionStorage.getItem('snake_cid');
    if (!cid) {
      cid = (crypto.randomUUID ? crypto.randomUUID() : 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36));
      sessionStorage.setItem('snake_cid', cid);
    }
    return cid;
  } catch (e) {
    return (crypto.randomUUID ? crypto.randomUUID() : 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36));
  }
}
const myCid = ensureCid();

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const el = {
  home: $('screen-home'), room: $('screen-room'),
  name: $('inp-name'), picker: $('color-picker'), create: $('btn-create'), code: $('inp-code'), join: $('btn-join'),
  addr: $('addr-line'),
  leave: $('btn-leave'), roomCode: $('room-code'), copy: $('btn-copy'), conn: $('conn-state'),
  phase: $('phase-info'), mute: $('btn-mute'),
  stage: $('stage'), netBanner: $('net-banner'),
  cdOverlay: $('overlay-cd'), cdNum: $('cd-num'),
  overOverlay: $('overlay-over'), overTitle: $('over-title'), overWinners: $('over-winners'), overStats: $('over-stats'), overNext: $('over-next'), btnNextRound: $('btn-next-round'),
  deadBanner: $('dead-banner'), toasts: $('toasts'), touchCtrl: $('touch-ctrl'),
  playerCount: $('player-count'), playerList: $('player-list'),
  hostPanel: $('host-panel'), duration: $('sel-duration'), start: $('btn-start'), waitMsg: $('wait-msg'),
  modeSeg: $('mode-seg'), curMode: $('cur-mode'), modeDesc: $('mode-desc'),
  netShare: $('net-share'), btnTunnel: $('btn-tunnel'), tunnelInfo: $('tunnel-info'),
};
const ctx2d = el.stage.getContext('2d');

// ---------- 贴图：nai（奶娃）/ sun（太阳毒药）—— 与单机版相同，白色背景抠除 ----------
const sprites = { sun: { canvas: null }, nai: { canvas: null } };
function buildSprite(img, target) {
  try {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const data = g.getImageData(0, 0, c.width, c.height);
    const px = data.data, W = c.width, H = c.height;
    const visited = new Uint8Array(W * H);
    const stack = [];
    const push = (x, y) => {
      const i = y * W + x;
      if (x >= 0 && x < W && y >= 0 && y < H && !visited[i]) { visited[i] = 1; stack.push(i); }
    };
    for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); }
    for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y); }
    // 从边缘泛洪：与白底连通的近白像素全部变透明
    while (stack.length) {
      const i = stack.pop(), o = i * 4;
      const min = Math.min(px[o], px[o + 1], px[o + 2]);
      if (min > 230) {
        px[o + 3] = 0;
        push((i % W) + 1, (i / W) | 0);
        push((i % W) - 1, (i / W) | 0);
        push(i % W, ((i / W) | 0) + 1);
        push(i % W, ((i / W) | 0) - 1);
      }
    }
    // 羽化残留的浅色描边像素，让轮廓平滑
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x, o = i * 4;
        if (px[o + 3] === 255) {
          const min = Math.min(px[o], px[o + 1], px[o + 2]);
          if (min > 225) px[o + 3] = Math.round(255 * Math.min(1, Math.max(0.3, (min - 225) / 30)));
        }
      }
    }
    g.putImageData(data, 0, 0);
    target.canvas = c;
  } catch (e) { target.canvas = null; }
}
(function loadSprites() {
  const nai = new Image();
  nai.onload = () => buildSprite(nai, sprites.nai);
  nai.onerror = () => { sprites.nai.canvas = null; };
  nai.src = 'nai.jpg';
  const sun = new Image();
  sun.onload = () => buildSprite(sun, sprites.sun);
  sun.onerror = () => { sprites.sun.canvas = null; };
  sun.src = 'sun.jpg';
})();

// 单机版像素比例换算：单机每格 24px → 本游戏每格 20px
const S = CELL / 24;

// ---------- 全局状态 ----------
let phase = 'lobby';          // lobby | countdown | playing | over
let roomCode = '';
let myPid = 0;
let amHost = false;
let gridW = 44, gridH = 30;
let players = new Map();      // pid -> {n,c,l,a,d,w}
let foods = [];               // 扁平 [x,y,v...]
let snakes = [];              // 最新快照 {i, c:[...]}
let hist = [];                // 插值历史 [{t, s}]
let obstacles = [];           // 扁平 [x,y,...] 障碍石块（障碍模式）
let poisons = [];             // 扁平 [x,y,...] 太阳毒药
let myMode = 'classic';
let pendingModeLocal = null;   // 房主对局中点击的模式：本地先高亮，服务器在下一局生效
let roundNo = 0, durMs = 300000, phEndAt = 0, phAt = 0, phWinners = [];
let lastEventTick = 0;

let ws = null;
let connState = 'off';        // off | ok | bad
let leaving = false;
let retryTimer = null;
let pendingRoom = '';         // 当前想进的房间
let joinAttempt = 0;

const particles = [];
const toastsQueue = [];

// ---------- 简易音效（WebAudio 合成，无音频文件） ----------
let AC = null;
function audio() { if (!AC) { try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} } return AC; }
function tone(freq, dur, type, vol, slideTo) {
  if (my.muted || !AC) return;
  const t0 = AC.currentTime;
  const o = AC.createOscillator(), g = AC.createGain();
  o.type = type || 'sine';
  o.frequency.setValueAtTime(freq, t0);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(slideTo, 30), t0 + dur);
  g.gain.setValueAtTime(vol || 0.15, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g); g.connect(AC.destination);
  o.start(t0); o.stop(t0 + dur + 0.02);
}
const snd = {
  click: () => tone(700, 0.06, 'triangle', 0.08),
  eat: () => tone(520, 0.07, 'square', 0.05, 900),
  die: () => { tone(380, 0.35, 'sawtooth', 0.09, 60); },
  kill: () => tone(200, 0.25, 'sawtooth', 0.08, 90),
  win: () => { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => tone(f, 0.18, 'triangle', 0.12), i * 130)); },
  lose: () => { [400, 320, 240].forEach((f, i) => setTimeout(() => tone(f, 0.2, 'triangle', 0.09), i * 170)); },
  tick: () => tone(880, 0.08, 'square', 0.07),
  go: () => tone(740, 0.35, 'square', 0.1),
};

// ---------- 背景音乐（与单机版同款：大厅音乐 + 每玩法专属音乐） ----------
// 大厅/等待：aud/bgm.mp3；经典：aud/bgm1.mp3；穿越：aud/bgm2.mp3；障碍：aud/bgm3.mp3
const TRACKS = { menu: 'aud/bgm.mp3', classic: 'aud/bgm1.mp3', wrap: 'aud/bgm2.mp3', obstacle: 'aud/bgm3.mp3' };
const musicEls = {};
let musicOn = '';
function trackForPhase() {
  if (!roomCode) return '';                       // 回到首页：静音
  if (phase === 'playing') return TRACKS[myMode];
  if (phase === 'lobby') return TRACKS.menu;
  return ''; // 倒计时 / 结算：静默（由提示音/结算音效接管）
}
function musicSync(force) {
  const src = my.muted ? '' : trackForPhase();
  if (src === musicOn && !force) return;
  if (musicOn && musicEls[musicOn]) {
    const a = musicEls[musicOn];
    a.pause(); a.currentTime = 0;
  }
  musicOn = src;
  if (!src) return;
  if (!musicEls[src]) {
    try {
      const a = new Audio(src);
      a.loop = true; a.volume = 0.45;
      musicEls[src] = a;
    } catch (e) { musicOn = ''; return; }
  }
  const p = musicEls[src].play();
  if (p && p.catch) p.catch(() => {});   // 浏览器未解锁时静默失败，等首次手势再试
}
// 浏览器要求用户手势后才能出声：每次点击/按键时补一次启动
document.addEventListener('pointerdown', () => { if (roomCode && !my.muted) { const s = trackForPhase(); if (s && musicEls[s]) { const p = musicEls[s].play(); if (p && p.catch) p.catch(() => {}); } } });
document.addEventListener('keydown', () => { if (roomCode && !my.muted) { const s = trackForPhase(); if (s && musicEls[s]) { const p = musicEls[s].play(); if (p && p.catch) p.catch(() => {}); } } });

// 死亡音效：与单机版相同的 die.mp4；失败时退回合成音
const dieAudio = (() => { try { const a = new Audio('aud/die.mp4'); a.volume = 0.8; return a; } catch (e) { return null; } })();
function dieSound() {
  if (my.muted) return;
  if (dieAudio) {
    try {
      dieAudio.currentTime = 0;
      const p = dieAudio.play();
      if (p && p.catch) p.catch(() => snd.die());
      return;
    } catch (e) {}
  }
  snd.die();
}

// ---------- 首页初始化 ----------
function init() {
  // 地址栏提示
  const proto = location.protocol === 'https:' ? 'https://' : 'http://';
  el.addr.textContent = '当前页面地址：' + proto + location.host + '  所有玩家打开同一个地址即可';

  // 昵称
  el.name.value = my.name || ('玩家' + Math.floor(1000 + Math.random() * 9000));
  el.name.addEventListener('keydown', (e) => { if (e.key === 'Enter') doCreate(); });

  // 颜色选择
  PALETTE.forEach((c, i) => {
    const d = document.createElement('div');
    d.className = 'color-dot' + (my.color === i ? ' sel' : '');
    d.style.background = c;
    d.title = '颜色 ' + (i + 1);
    d.addEventListener('click', () => {
      my.color = i; store.set('color', i);
      [...el.picker.children].forEach((x, j) => x.classList.toggle('sel', j === i));
      snd.click();
    });
    el.picker.appendChild(d);
  });
  if (my.color < 0) my.color = 0;

  el.create.addEventListener('click', doCreate);
  el.join.addEventListener('click', () => doJoin(el.code.value));
  el.code.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(el.code.value); });

  // 房间页按钮
  el.leave.addEventListener('click', leaveRoom);
  el.copy.addEventListener('click', () => {
    if (!roomCode) return;
    (navigator.clipboard ? navigator.clipboard.writeText(roomCode) : Promise.reject())
      .then(() => toast('房间号 ' + roomCode + ' 已复制', 'good'))
      .catch(() => toast('房间号：' + roomCode, 'good'));
    snd.click();
  });
  el.mute.addEventListener('click', () => {
    my.muted = !my.muted;
    store.set('muted', my.muted ? '1' : '0');
    el.mute.textContent = my.muted ? '🔇' : '🔊';
    musicSync();
  });
  el.mute.textContent = my.muted ? '🔇' : '🔊';
  el.start.addEventListener('click', () => { if (ws) ws.send(JSON.stringify({ t: 'start' })); snd.click(); });
  el.btnNextRound.addEventListener('click', () => { snd.click(); sendNext(); });
  el.duration.addEventListener('change', () => { if (ws) ws.send(JSON.stringify({ t: 'cfg', d: parseInt(el.duration.value, 10) })); });
  el.btnTunnel.addEventListener('click', () => { toggleNetShare(); snd.click(); });

  // 玩法模式按钮（房主任意阶段可切：大厅/倒计时/结算立即生效，对局中=本局结束后生效）
  for (const mm of ['classic', 'wrap', 'obstacle']) {
    const b = document.createElement('button');
    b.className = 'm-btn' + (mm === myMode ? ' on' : '');
    b.textContent = MODE_LABELS[mm];
    b.dataset.mode = mm;
    b.addEventListener('click', () => {
      const eff = pendingModeLocal || myMode;
      if (!amHost || mm === eff) return;
      snd.click();
      if (phase === 'playing') { pendingModeLocal = mm; syncModeUi(); } // 对局中：先本地高亮，服务器下局落盘
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'cfg', mode: mm }));
    });
    el.modeSeg.appendChild(b);
  }

  bindInput();
  requestAnimationFrame(renderLoop);
  setInterval(tickUi, 500);

  // 分享链接带 ?room=123456 时自动加入该房间
  const q = new URLSearchParams(location.search).get('room');
  if (q && /^\d{6}$/.test(q)) {
    el.code.value = q;
    setTimeout(() => doJoin(q), 400);
  }
}
init();

function readName() {
  let n = el.name.value.trim();
  if (!n) n = '玩家' + Math.floor(1000 + Math.random() * 9000);
  return n.slice(0, 12);
}

async function doCreate() {
  audio();
  my.name = readName(); store.set('name', my.name);
  snd.click();
  try {
    const r = await fetch('/api/rooms', { method: 'POST' });
    const j = await r.json();
    if (!j.code) throw new Error(j.m || '创建失败');
    enterRoom(j.code, true);
  } catch (e) {
    toast('创建房间失败：' + e.message, 'bad');
  }
}

function doJoin(code) {
  audio();
  const c = String(code || '').trim();
  if (!/^\d{6}$/.test(c)) { toast('请输入 6 位数字房间号', 'bad'); return; }
  my.name = readName(); store.set('name', my.name);
  snd.click();
  enterRoom(c, false);
}

// ---------- 房间页面展示 ----------
function enterRoom(code, isNew) {
  roomCode = code;
  leaving = false;
  joinAttempt = 0;
  pendingRoom = code;
  el.home.classList.add('hidden');
  el.room.classList.remove('hidden');
  el.roomCode.textContent = code;
  connect();
  if (location.search !== '?room=' + code) {
    try { history.replaceState(null, '', '?room=' + code); } catch (e) {}
  }
  showLobbyHint(isNew);
}

function showLobbyHint(isNew) {
  // 大厅提示用 DOM 展示（在 canvas 上层居中，玻璃卡片风）
  hideLobbyHint();
  const d = document.createElement('div');
  d.id = 'lobby-hint';
  d.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;z-index:4;pointer-events:none;padding:20px';
  const card = document.createElement('div');
  card.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:8px;padding:22px 34px;border-radius:20px;background:rgba(15,10,5,.52);border:1px solid rgba(255,229,180,.22);box-shadow:0 18px 50px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.06);backdrop-filter:blur(10px);max-width:min(520px,92vw)';
  const codeTxt = isNew ? '🎉 房间创建成功！' : '✅ 已加入房间 ' + roomCode;
  card.innerHTML =
    '<div style="font-size:23px;font-weight:900;color:#FFE5B4;letter-spacing:2px">' + codeTxt + '</div>' +
    '<div style="font-size:16px;color:#e6d7b6;margin-top:4px">把房间号告诉朋友：</div>' +
    '<div style="font-size:34px;font-weight:900;color:#FFE5B4;letter-spacing:8px;text-shadow:0 0 22px rgba(255,229,180,.55);margin:2px 0 6px">' + roomCode + '</div>' +
    '<div style="font-size:13.5px;color:#cbb187">朋友在<b style="color:#FFE5B4">同一个网址</b>里输入房间号即可加入</div>' +
    '<div style="font-size:13.5px;color:#cbb187">房主可切换玩法：经典 · 穿越 · 障碍（三种都有 ☀️ 毒太阳）</div>' +
    '<div style="font-size:13.5px;color:#cbb187">人齐后由房主点「开始游戏」（人数 ≥ 2）</div>';
  d.appendChild(card);
  el.stage.parentElement.appendChild(d);
}
function hideLobbyHint() {
  const d = document.getElementById('lobby-hint');
  if (d) d.remove();
}

// ---------- WebSocket ----------
function connect() {
  if (ws) { try { ws.onclose = null; ws.close(); } catch (e) {} ws = null; }
  connState = 'off';
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  const q = new URLSearchParams({
    room: pendingRoom, name: my.name, cid: myCid,
    color: String(my.color >= 0 ? my.color : ''),
  });
  setConnBad('连接中…');
  let s;
  try { s = new WebSocket(proto + location.host + '/ws?' + q.toString()); }
  catch (e) { scheduleReconnect(); return; }
  ws = s;
  s.onopen = () => { connState = 'ok'; setConnOk(); joinAttempt = 0; };
  s.onmessage = (ev) => { try { onMsg(JSON.parse(ev.data)); } catch (e) { console.error('消息处理出错:', e); } };
  s.onclose = () => {
    if (leaving) return;
    connState = 'off';
    if (ws === s) ws = null;
    scheduleReconnect();
  };
  s.onerror = () => {};
}

function scheduleReconnect() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    if (leaving) return;
    if (++joinAttempt > 3) {
      toast('多次连接失败，请确认服务器开着后刷新页面', 'bad');
    }
    connect();
  }, 1200);
}

function setConnOk() { el.conn.textContent = '● 已连接'; el.conn.className = 'conn ok'; el.netBanner.classList.add('hidden'); }
function setConnBad(t) { el.conn.textContent = t || '○ 重连中'; el.conn.className = 'conn bad'; }
function setConnLost() { el.conn.textContent = '○ 连接断开'; el.conn.className = 'conn bad'; el.netBanner.classList.remove('hidden'); }

// 触屏设备检测：手机 / 平板 / 触屏笔记本都显示方向按钮。
// 放在函数体内执行，避免被 init() 提前调用时踩中 const 的 TDZ。
function isTouchDevice() {
  return ('ontouchstart' in window) || (window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
}
function syncTouchCtrl() {
  if (!isTouchDevice()) { el.touchCtrl.classList.add('hidden'); return; }
  el.touchCtrl.classList.toggle('hidden', phase === 'lobby');
}

// ---------- 消息处理 ----------
function onMsg(m) {
  if (m.t === 'err') {
    handleErr(m.m);
    return;
  }
  if (m.t === 'welcome') {
    myPid = m.you.i;
    gridW = (m.room.g && m.room.g[0]) || 44;
    gridH = (m.room.g && m.room.g[1]) || 30;
    resizeStage();
    applyRoom(m);
    setConnOk();
    return;
  }
  if (m.t === 'room') {
    applyRoom(m);
    return;
  }
  if (m.t === 'tick') {
    // 系统消息
    if (m.m) for (const t of m.m) toast(t);
    // 死亡事件
    if (m.e && m.e.length) handleEvents(m.e);
    // 障碍 / 毒太阳（每 100ms 推送一次当前布局）
    if (Array.isArray(m.o)) obstacles = m.o;
    if (Array.isArray(m.p)) poisons = m.p;
    // 记录快照用于插值
    const t = performance.now();
    hist.push({ t, s: m.s || [], foods: m.f || [] });
    if (hist.length > 40) hist.splice(0, hist.length - 40);
    // 食物减少音效（自己吃到）
    const nf = (m.f || []).length;
    if (myPid && nf < prevFoodCount && phase === 'playing' && !deadMe) snd.eat();
    prevFoodCount = nf;
    return;
  }
}
let prevFoodCount = 0;
let deadMe = false;

function handleErr(msg) {
  if (!myPid) {
    // 加入阶段被拒：昵称冲突自动加后缀重试一次
    if (/昵称/.test(msg) && joinAttempt < 1) {
      joinAttempt++;
      my.name = (my.name.slice(0, 10) + Math.floor(Math.random() * 90 + 10));
      store.set('name', my.name);
      connect();
      return;
    }
    toast(msg, 'bad');
    backHome();
    return;
  }
  toast(msg, 'bad');
}

function handleEvents(evs) {
  for (const e of evs) {
    if (e.t !== 'death') continue;
    const nm = e.nm || (players.get(e.i) || {}).n || '某玩家';
    const lastHead = lastHeadPos.get(e.i);
    const col = players.get(e.i) ? PALETTE[players.get(e.i).c % PALETTE.length] : '#888';
    if (lastHead) burst(lastHead[0] * CELL, lastHead[1] * CELL, col, 26);
    let txt;
    if (e.r === 'wall') txt = `${nm} 撞墙阵亡`;
    else if (e.r === 'self') txt = `${nm} 撞到自己，出局`;
    else if (e.r === 'crash') txt = `${nm} 迎头相撞，出局`;
    else if (e.r === 'obs') txt = `${nm} 撞到石块，阵亡`;
    else if (e.r === 'poison') txt = `${nm} 吃到毒太阳，阵亡`;
    else txt = `${e.kn || ''} 淘汰了 ${nm}`;
    toast(txt, 'bad');
    if (e.i === myPid) {
      deadMe = true;
      el.deadBanner.classList.remove('hidden');
      dieSound();
    } else if (e.k === myPid) {
      snd.kill();
    }
  }
}

// ---------- 房间快照 ----------
function applyRoom(m) {
  if (m.m) for (const t of m.m) toast(t);
  // 玩家名单
  const list = m.players || [];
  players = new Map();
  refreshHost(list);
  for (const p of list) {
    players.set(p.i, { n: p.n, c: p.c, w: p.w, l: p.l, a: p.a, d: p.d, h: !!p.h });
  }
  if (m.room) {
    phase = m.room.ph;
    durMs = m.room.durMs;
    if (m.room.mode && m.room.mode !== myMode) { myMode = m.room.mode; pendingModeLocal = null; }
    if (phase === 'playing') { roundNo = m.room.r; phEndAt = m.room.endAt; }
    if (phase === 'over') { roundNo = m.room.r; phWinners = m.room.win || []; phAt = m.room.at; }
    if (phase === 'countdown') {
      const n = m.room.n;
      showCountdown(n);
      roundNo = m.room.r || (roundNo + 1);
      if (n !== lastCdN) {
        lastCdN = n;
        if (n === 3) snd.tick(); else if (n <= 2) snd.click();
      }
    }
  }
  if (phase === 'playing' || phase === 'over') {
    snakes = m.snakes || [];
    foods = m.foods || [];
    prevFoodCount = foods.length;
    // 更新存活长度到排行榜
    for (const s of snakes) {
      const p = players.get(s.i);
      if (p && s.c) p.l = s.c.length / 2;
    }
  }
  if (phase === 'playing') {
    hist = [{ t: performance.now() - DISPLAY_DELAY, s: snakes, foods }];
    hideLobbyHint();
    el.deadBanner.classList.add('hidden');
    deadMe = false;
    hideOverlays();
  } else if (phase === 'countdown') {
    hideLobbyHint();
    el.cdOverlay.classList.remove('hidden');
    el.overOverlay.classList.add('hidden');
  } else if (phase === 'lobby') {
    hideOverlays();
    showLobbyHint(false);
  } else if (phase === 'over') {
    // 定格本局最终画面
    hist = [
      { t: performance.now() - DISPLAY_DELAY, s: snakes, foods },
      { t: performance.now(), s: snakes, foods },
    ];
    // 结算期间有玩家离开时保持首次渲染的结果（避免胜者离场后被误显示为平局）
    const winPids = m.room.win || [];
    const winStillHere = winPids.some((pid) => list.some((p) => p.i === pid));
    if (roundNo !== lastOverShownRound || winStillHere) {
      showOver(m);
      lastOverShownRound = roundNo;
    }
    if (roundNo !== lastOverSfxRound) {
      lastOverSfxRound = roundNo;
      if (phWinners.includes(myPid)) snd.win(); else snd.lose();
    }
  }
  updatePlayerList();
  updateHostPanel();
  syncTouchCtrl();
  musicSync();
}

let lastOverShownRound = 0;
let lastOverSfxRound = 0;
let lastCdN = 0;

function showCountdown(n) {
  el.cdNum.textContent = String(n);
  el.cdNum.style.animation = 'none';
  void el.cdNum.offsetWidth;
  el.cdNum.style.animation = '';
}

function hideOverlays() {
  el.cdOverlay.classList.add('hidden');
  el.overOverlay.classList.add('hidden');
}

function showOver(m) {
  el.cdOverlay.classList.add('hidden');
  el.overOverlay.classList.remove('hidden');
  const ws2 = (phWinners || []).map((pid) => players.get(pid)).filter(Boolean);
  const names = ws2.length ? ws2.map((p) => p.n).join('、') : '无人（平局）';
  el.overWinners.textContent = names;
  el.overWinners.style.color = ws2.length ? '#ffd93d' : '#aaa';
  const rows = [...players.values()].sort((a, b) => (b.a - a.a) || (b.l - a.l));
  const myWin = ws2.some((p) => players.get(myPid) === p);
  el.overTitle.textContent = myWin ? '🎉 你赢了！' : '🏆 本局冠军';
  el.overStats.innerHTML = '';
  const me = players.get(myPid);
  rows.forEach((p, i) => {
    const row = document.createElement('div');
    const isMe = p === me;
    row.textContent = `${i + 1}. ${p.n} — 长度 ${p.l}${p.w ? ' · 胜 ' + p.w : ''}${isMe ? '（你）' : ''}`;
    el.overStats.appendChild(row);
  });
  el.overStats.scrollTop = 0;
}

// ---------- 侧栏：实时排行榜（存活优先，其次长度） ----------
function updatePlayerList() {
  const arr = [...players.entries()].map(([pid, p]) => ({ pid, ...p }));
  const sorted = arr.sort((a, b) => (b.a - a.a) || (b.l - a.l) || (a.n < b.n ? -1 : 1));
  el.playerCount.textContent = sorted.length + ' 人';
  el.playerList.innerHTML = '';
  const medal = ['r1', 'r2', 'r3'];
  sorted.forEach((p, idx) => {
    const row = document.createElement('div');
    row.className = 'ply' + (p.a ? '' : ' dead') + (p.pid === myPid ? ' me' : '');
    const rank = document.createElement('span');
    rank.className = 'rank' + (idx < 3 ? ' ' + medal[idx] : '');
    rank.textContent = String(idx + 1);
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = PALETTE[p.c % PALETTE.length];
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = p.n + (p.pid === myPid ? '（你）' : '');
    const flag = document.createElement('span');
    flag.className = 'flag';
    flag.textContent = (p.h ? '👑' : '') + (p.w ? '⭐' + p.w : '') + (p.d ? '掉线' : '');
    const len = document.createElement('span');
    len.className = 'len';
    len.textContent = p.a ? String(p.l) : '出局';
    row.appendChild(rank); row.appendChild(dot); row.appendChild(nm); row.appendChild(flag); row.appendChild(len);
    el.playerList.appendChild(row);
  });
}
let hostPid = 0;

// ---------- 公网分享（隧道由服务器静默托管，网页里一键开/关） ----------
let netShareUrl = '';     // 服务器托管的公网地址（就绪后非空）
let netBusy = false;
let netFetching = false;

async function fetchTunnelApi() {
  try { const r = await fetch('/api/tunnel', { cache: 'no-store' }); return await r.json(); }
  catch (e) { return null; }
}

async function refreshNetShare() {
  if (netFetching) return;
  netFetching = true;
  const j = await fetchTunnelApi();
  netFetching = false;
  if (j && j.url && !netShareUrl) { netShareUrl = j.url; paintNetShare(); }
}

async function toggleNetShare() {
  if (netBusy) return;
  if (netShareUrl) { // 关闭
    netBusy = true; paintNetShare();
    await fetch('/api/tunnel', { method: 'DELETE', cache: 'no-store' }).catch(() => {});
    netShareUrl = ''; netBusy = false;
    paintNetShare();
    toast('已关闭公网邀请', 'good');
    return;
  }
  netBusy = true;
  paintNetShare();
  let r0 = null;
  try { const r = await fetch('/api/tunnel', { method: 'POST', cache: 'no-store' }); r0 = await r.json(); }
  catch (e) { r0 = null; }
  if (!r0 || r0.ok === false) {
    netBusy = false;
    paintNetShare();
    toast('开启失败：' + ((r0 && r0.m) || '请确认 cloudflared.exe 在游戏目录内'), 'bad');
    return;
  }
  for (let i = 0; i < 30; i++) { // cloudflared 一般 5~15 秒就绪
    await new Promise((res) => setTimeout(res, 1000));
    const j = await fetchTunnelApi();
    if (j && j.url) { netShareUrl = j.url; break; }
  }
  netBusy = false;
  paintNetShare();
  if (netShareUrl) toast('公网邀请链接已生成！', 'good');
  else toast('生成超时，可稍后重试', 'bad');
}

function paintNetShare() {
  // https（云端部署或公网隧道）页面本身就已公开可访问，无需再开隧道
  if (!amHost || phase !== 'lobby' || location.protocol === 'https:') { el.netShare.classList.add('hidden'); return; }
  el.netShare.classList.remove('hidden');
  if (!netBusy && !netShareUrl) refreshNetShare(); // 进房/重连后同步服务器端状态
  const btn = el.btnTunnel;
  if (netBusy) { btn.disabled = true; btn.textContent = '⏳ 正在生成公网邀请…（约 5~15 秒）'; }
  else if (netShareUrl) { btn.disabled = false; btn.textContent = '🛑 关闭公网邀请'; }
  else { btn.disabled = false; btn.textContent = '🌐 生成公网邀请链接'; }
  const info = el.tunnelInfo;
  const link = netShareUrl ? netShareUrl + '/?room=' + roomCode : '';
  info.classList.toggle('hidden', !link);
  if (!link) return;
  info.innerHTML = '';
  const tip = document.createElement('div');
  tip.className = 'net-tip';
  tip.textContent = '把这个链接发给朋友（手机/电脑点开即进房，不用输房间号）：';
  const box = document.createElement('div');
  box.className = 'net-link';
  box.textContent = link;
  box.title = '点击复制';
  box.addEventListener('click', () => {
    (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject())
      .then(() => toast('邀请链接已复制，发给朋友吧', 'good'))
      .catch(() => toast('请长按/选中复制上面的链接', 'bad'));
  });
  info.appendChild(tip);
  info.appendChild(box);
}

function updateHostPanel() {
  syncModeUi();
  paintNetShare();
  const inLobby = phase === 'lobby';
  if (!amHost && !inLobby) { el.hostPanel.classList.add('hidden'); return; } // 客人只在看大厅时需要面板
  el.hostPanel.classList.remove('hidden');
  if (amHost) {
    // 玩法切换对房主全阶段开放（对局中切换=本局结束后生效）；开始按钮/时长仅大厅可改
    el.modeSeg.classList.remove('hidden');
    el.curMode.classList.add('hidden');
    el.waitMsg.classList.add('hidden');
    el.start.classList.toggle('hidden', !inLobby);
    el.duration.classList.toggle('hidden', !inLobby);
    if (inLobby) {
      el.start.disabled = players.size < 2;
      el.start.textContent = players.size < 2 ? '至少 2 人才能开始（当前 ' + players.size + ' 人）' : '▶ 开始游戏';
    }
  } else {
    el.start.classList.add('hidden');
    el.duration.classList.add('hidden');
    el.modeSeg.classList.add('hidden');
    el.curMode.classList.remove('hidden');
    el.waitMsg.classList.remove('hidden');
    el.waitMsg.textContent = `等待房主开始游戏…（当前 ${players.size} 人 · 玩法：${MODE_LABELS[myMode] || myMode}）`;
  }
}

// 同步玩法模式：段按钮高亮（对局中切换的待生效项也高亮）/ 当前玩法 / 说明文字
function syncModeUi() {
  const show = pendingModeLocal || myMode;
  for (const b of el.modeSeg.children) b.classList.toggle('on', b.dataset.mode === show);
  el.curMode.textContent = MODE_LABELS[myMode] || myMode;
  el.modeDesc.textContent = MODE_DESC[show] || '';
}

// host 判断：名单里带 h 标记的玩家就是房主
function refreshHost(plist) {
  hostPid = 0;
  for (const p of plist || []) if (p.h) hostPid = p.i;
  amHost = hostPid === myPid;
}

// ---------- Toast ----------
function toast(text, kind) {
  const d = document.createElement('div');
  d.className = 'toast' + (kind ? ' ' + kind : '');
  d.textContent = text;
  el.toasts.appendChild(d);
  while (el.toasts.children.length > 6) el.toasts.firstChild.remove();
  setTimeout(() => { d.style.transition = 'opacity .4s'; d.style.opacity = '0'; setTimeout(() => d.remove(), 400); }, 3200);
}

// ---------- 输入 ----------
const keyDir = {
  ArrowUp: 3, w: 3, W: 3, ArrowDown: 1, s: 1, S: 1,
  ArrowLeft: 2, a: 2, A: 2, ArrowRight: 0, d: 0, D: 0,
};
let boostHeld = false;

function bindInput() {
  document.addEventListener('keydown', (e) => {
    // 结算面板：任意玩家按【空格】跳过等待，立即开始下一局
    if (e.key === ' ' && phase === 'over') {
      e.preventDefault();
      if (!e.repeat) sendNext();
      return;
    }
    if (phase !== 'playing') return;
    if (keyDir[e.key] !== undefined) {
      e.preventDefault();
      if (!e.repeat) sendDir(keyDir[e.key]);
    } else if (e.key === ' ' || e.key === 'Shift') {
      e.preventDefault();
      if (!boostHeld) { boostHeld = true; sendBoost(true); }
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.key === ' ' || e.key === 'Shift') {
      if (boostHeld) { boostHeld = false; sendBoost(false); }
    }
  });
  // 鼠标按住 = 加速
  el.stage.addEventListener('pointerdown', (e) => { if (phase === 'playing') { boostHeld = true; sendBoost(true); } });
  window.addEventListener('pointerup', () => { if (boostHeld) { boostHeld = false; sendBoost(false); } });

  // 触屏按钮
  el.touchCtrl.querySelectorAll('.d-btn').forEach((b) => {
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); if (phase === 'playing') sendDir(parseInt(b.dataset.d, 10)); });
  });
  const tb = $('btn-boost-touch');
  tb.addEventListener('pointerdown', (e) => { e.preventDefault(); boostHeld = true; sendBoost(true); });
  tb.addEventListener('pointerup', () => { if (boostHeld) { boostHeld = false; sendBoost(false); } });
  tb.addEventListener('pointerleave', () => { if (boostHeld) { boostHeld = false; sendBoost(false); } });
  el.stage.addEventListener('contextmenu', (e) => e.preventDefault());
  syncTouchCtrl();
}

function sendDir(d) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'dir', d }));
}
function sendBoost(b) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'bo', b }));
}
function sendNext() {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'next' }));
}

function leaveRoom() {
  leaving = true;
  clearTimeout(retryTimer);
  if (ws) { try { ws.send(JSON.stringify({ t: 'leave' })); } catch (e) {} try { ws.close(); } catch (e) {} }
  ws = null;
  resetState();
  musicSync();
  el.room.classList.add('hidden');
  el.home.classList.remove('hidden');
  try { history.replaceState(null, '', location.pathname); } catch (e) {}
}
function backHome() {
  leaving = true;
  clearTimeout(retryTimer);
  if (ws) { try { ws.close(); } catch (e) {} }
  ws = null;
  resetState();
  musicSync();
  el.room.classList.add('hidden');
  el.home.classList.remove('hidden');
}
function resetState() {
  pendingRoom = ''; roomCode = ''; myPid = 0; phase = 'lobby';
  pendingModeLocal = null;
  players = new Map(); foods = []; snakes = []; hist = [];
  obstacles = []; poisons = [];
  hideOverlays(); hideLobbyHint();
  el.deadBanner.classList.add('hidden');
  el.netBanner.classList.add('hidden');
}

// ---------- 画布与渲染（任意屏幕等比缩放 + 高清渲染） ----------
let dpr = 1, cssW = 880, cssH = 600, viewScale = 1;
function resizeStage() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  const wrap = el.stage.parentElement;
  const availW = wrap.clientWidth, availH = wrap.clientHeight;
  if (availW > 8 && availH > 8) {
    // 始终按容器剩余空间等比缩放：电脑 / 平板 / 手机横竖屏都适用
    const s = Math.min(availW / (gridW * CELL), availH / (gridH * CELL));
    cssW = Math.round(gridW * CELL * s);
    cssH = Math.round(gridH * CELL * s);
  } else {
    cssW = 0; cssH = 0; // 布局未就绪（如在首页时）
  }
  viewScale = cssW > 0 ? (dpr * cssW) / (gridW * CELL) : dpr;
  el.stage.style.width = Math.max(1, cssW) + 'px';
  el.stage.style.height = Math.max(1, cssH) + 'px';
  el.stage.width = Math.max(2, Math.round(cssW * dpr));
  el.stage.height = Math.max(2, Math.round(cssH * dpr));
}
window.addEventListener('resize', () => { if (myPid) resizeStage(); });
window.addEventListener('orientationchange', () => {
  setTimeout(() => { if (myPid) resizeStage(); }, 150);
});

function drawBase() {
  ctx2d.setTransform(viewScale, 0, 0, viewScale, 0, 0);
  ctx2d.clearRect(0, 0, gridW * CELL, gridH * CELL);
  // 与单机版一致的纯黑场地
  ctx2d.fillStyle = '#000';
  ctx2d.fillRect(0, 0, gridW * CELL, gridH * CELL);
}

function rrPath(x, y, w, h, r) {
  ctx2d.beginPath();
  ctx2d.moveTo(x + r, y);
  ctx2d.arcTo(x + w, y, x + w, y + h, r);
  ctx2d.arcTo(x + w, y + h, x, y + h, r);
  ctx2d.arcTo(x, y + h, x, y, r);
  ctx2d.arcTo(x, y, x + w, y, r);
  ctx2d.closePath();
}

// 障碍物：灰色石块（与单机版一致）
function drawObstacles() {
  for (let i = 0; i < obstacles.length; i += 2) {
    const x = obstacles[i] * CELL, y = obstacles[i + 1] * CELL;
    rrPath(x + 1 * S, y + 1 * S, CELL - 2 * S, CELL - 2 * S, 4 * S);
    ctx2d.fillStyle = '#6a6a80';
    ctx2d.fill();
    ctx2d.strokeStyle = '#4a4a5e';
    ctx2d.lineWidth = Math.max(1, 1.5 * S);
    ctx2d.stroke();
    ctx2d.fillStyle = 'rgba(255,255,255,0.14)';
    ctx2d.fillRect(x + 4 * S, y + 4 * S, CELL - 8 * S, 3 * S);
  }
}

// 毒药：☀️ 太阳贴图（加载失败时画红色圆点兜底）
function drawPoisons() {
  if (!poisons.length) return;
  const c = sprites.sun.canvas;
  if (!c) {
    for (let i = 0; i < poisons.length; i += 2) {
      const cx = poisons[i] * CELL + CELL / 2, cy = poisons[i + 1] * CELL + CELL / 2;
      ctx2d.fillStyle = '#ff7043';
      ctx2d.beginPath(); ctx2d.arc(cx, cy, CELL * 0.42, 0, Math.PI * 2); ctx2d.fill();
      ctx2d.fillStyle = '#c62828';
      ctx2d.beginPath(); ctx2d.arc(cx, cy, CELL * 0.2, 0, Math.PI * 2); ctx2d.fill();
    }
    return;
  }
  for (let i = 0; i < poisons.length; i += 2) {
    const x = poisons[i] * CELL, y = poisons[i + 1] * CELL;
    const h = CELL + 2 * S, w = h * c.width / c.height;
    ctx2d.drawImage(c, x + (CELL - w) / 2, y + (CELL - h) / 2, w, h);
  }
}

// 奶糖：与单机版相同的棕色小点心（三层圆堆 + 大眼睛 + 微笑，会一起眨眼）
function drawFoods(nowT) {
  const eyes = Math.sin(nowT / 260) > -0.92;   // 偶尔一起眨眼
  for (let i = 0; i < foods.length; i += 3) {
    const cx = foods[i] * CELL + CELL / 2, cy = foods[i + 1] * CELL + CELL / 2;
    // 底层（最大圆，略扁）
    ctx2d.fillStyle = '#7A4A1F';
    ctx2d.beginPath();
    ctx2d.ellipse(cx, cy + 5 * S, CELL / 2 - 2 * S, CELL / 2 - 4 * S, 0, 0, Math.PI * 2);
    ctx2d.fill();
    // 中层
    ctx2d.fillStyle = '#8B5A2B';
    ctx2d.beginPath();
    ctx2d.ellipse(cx, cy - 1 * S, CELL / 2 - 4 * S, CELL / 2 - 6 * S, 0, 0, Math.PI * 2);
    ctx2d.fill();
    // 顶层（小圆尖）
    ctx2d.fillStyle = '#9C6B3A';
    ctx2d.beginPath();
    ctx2d.ellipse(cx, cy - 6 * S, CELL / 2 - 7 * S, CELL / 2 - 9 * S, 0, 0, Math.PI * 2);
    ctx2d.fill();
    // 高光
    ctx2d.fillStyle = 'rgba(255,255,255,0.3)';
    ctx2d.beginPath();
    ctx2d.arc(cx - 4 * S, cy - 3 * S, 2.2 * S, 0, Math.PI * 2);
    ctx2d.fill();
    if (!eyes) continue;
    // 左眼
    ctx2d.fillStyle = '#FFFFFF';
    ctx2d.beginPath();
    ctx2d.arc(cx - 4 * S, cy + 3 * S, 3.2 * S, 0, Math.PI * 2);
    ctx2d.fill();
    ctx2d.fillStyle = '#000';
    ctx2d.beginPath();
    ctx2d.arc(cx - 4 * S, cy + 3 * S, 1.6 * S, 0, Math.PI * 2);
    ctx2d.fill();
    // 右眼
    ctx2d.fillStyle = '#FFFFFF';
    ctx2d.beginPath();
    ctx2d.arc(cx + 4 * S, cy + 3 * S, 3.2 * S, 0, Math.PI * 2);
    ctx2d.fill();
    ctx2d.fillStyle = '#000';
    ctx2d.beginPath();
    ctx2d.arc(cx + 4 * S, cy + 3 * S, 1.6 * S, 0, Math.PI * 2);
    ctx2d.fill();
    // 微笑嘴
    ctx2d.strokeStyle = '#000';
    ctx2d.lineWidth = Math.max(1, 1.2 * S);
    ctx2d.beginPath();
    ctx2d.arc(cx, cy + 8 * S, 2.5 * S, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx2d.stroke();
  }
}

// 插值渲染（穿越模式做跨边最短路径修正，避免贴图横穿整场）
function lerpPx(ax, ay, bx, by, p) {
  if (myMode === 'wrap') {
    if (bx - ax > gridW / 2) bx -= gridW;
    else if (bx - ax < -gridW / 2) bx += gridW;
    if (by - ay > gridH / 2) by -= gridH;
    else if (by - ay < -gridH / 2) by += gridH;
  }
  return [(ax + (bx - ax) * p) * CELL + CELL / 2, (ay + (by - ay) * p) * CELL + CELL / 2];
}

function drawSnakes(nowT) {
  if (!hist.length) return;
  let T = nowT - DISPLAY_DELAY;
  // 找 [A,B] 快照区间
  let A = hist[hist.length - 1], B = A;
  for (let i = hist.length - 1; i >= 0; i--) {
    if (hist[i].t <= T) { A = hist[i]; B = hist[Math.min(i + 1, hist.length - 1)]; break; }
  }
  const p = A === B ? 1 : Math.max(0, Math.min(1, (T - A.t) / (B.t - A.t)));
  const mapA = new Map(), mapB = new Map();
  for (const s of A.s) mapA.set(s.i, s.c);
  for (const s of B.s) mapB.set(s.i, s.c);

  // 每个蛇：两条路径 -> 插值后的分段中心
  const segs = new Map(); // pid -> {pts:[[px,py],...], col}
  const pids = new Set([...mapA.keys(), ...mapB.keys()]);
  for (const pid of pids) {
    const cA = mapA.get(pid), cB = mapB.get(pid);
    const pmeta = players.get(pid);
    const dead = pmeta ? !pmeta.a : false;
    if (dead && !cA && !cB) { if (cB) { lastHeadPos.set(pid, [cB[0], cB[1]]); } continue; }
    const pts = [];
    if (cA && cB) {
      const La = cA.length / 2, Lb = cB.length / 2;
      const L = Math.min(La, Lb);
      for (let j = 0; j < L; j++) pts.push(lerpPx(cA[j * 2], cA[j * 2 + 1], cB[j * 2], cB[j * 2 + 1], p));
      // 新增的尾巴段（吃到奶糖的增长）：直接采用 B 的尾部坐标
      if (Lb > La) for (let j = La; j < Lb; j++) pts.push([cB[j * 2] * CELL + CELL / 2, cB[j * 2 + 1] * CELL + CELL / 2]);
    } else if (cB) {
      for (let j = 0; j < cB.length / 2; j++) pts.push([cB[j * 2] * CELL + CELL / 2, cB[j * 2 + 1] * CELL + CELL / 2]);
    }
    if (!pts.length) continue;
    const colIdx = pmeta ? pmeta.c : 0;
    segs.set(pid, { pts, col: PALETTE[colIdx % PALETTE.length] });
    lastHeadPos.set(pid, [pts[0][0] / CELL, pts[0][1] / CELL]);
  }

  // 身体：奶娃同款奶棕色链珠（越靠近尾巴越细），外圈用玩家颜色描边以便区分
  for (const [pid, g] of segs) {
    const pts = g.pts, n = pts.length;
    for (let i = n - 1; i >= 0; i--) {
      const k = 0.7 + 0.3 * Math.min(1, (n - 1 - i) / 3);   // 头部段全大，尾巴收窄（同单机版）
      const w = CELL * k, x0 = pts[i][0] - w / 2, y0 = pts[i][1] - w / 2;
      // 玩家颜色描边圈（相邻珠重叠时只有外轮廓露出）
      rrPath(x0 - 1.6, y0 - 1.6, w + 3.2, w + 3.2, Math.max(3, (w + 3.2) * 0.2));
      ctx2d.fillStyle = g.col;
      ctx2d.fill();
      // 奶棕主体
      rrPath(x0, y0, w, w, Math.max(3 * S, w * 0.2));
      ctx2d.fillStyle = '#E4C090';
      ctx2d.fill();
      // 顶部高光
      ctx2d.fillStyle = 'rgba(255,255,255,0.2)';
      rrPath(x0 + 2.5 * S, y0 + 2.5 * S, w * 0.45, w * 0.16, 2 * S);
      ctx2d.fill();
    }

    // 头：nai 奶娃贴图，脸朝向移动方向
    const [hx, hy] = pts[0];
    let ang = Math.PI / 2;   // 默认朝右
    if (n > 1) {
      const dx = pts[0][0] - pts[1][0], dy = pts[0][1] - pts[1][1];
      if (dx || dy) ang = Math.atan2(dy, dx) + Math.PI / 2;
    }
    const nai = sprites.nai.canvas;
    if (nai) {
      const size = CELL * 1.55;
      ctx2d.save();
      ctx2d.translate(hx, hy);
      ctx2d.rotate(ang);
      ctx2d.drawImage(nai, -size / 2, -size / 2, size, size);
      ctx2d.restore();
    } else {
      // 贴图未就绪的回退画法（单机版卡通圆头）
      const r = CELL / 2 - 1;
      ctx2d.fillStyle = '#FFE5B4';
      ctx2d.beginPath();
      ctx2d.arc(hx, hy, r, 0, Math.PI * 2);
      ctx2d.fill();
      ctx2d.strokeStyle = g.col;
      ctx2d.lineWidth = Math.max(1.5, 1.5 * S);
      ctx2d.stroke();
      // 眼睛位置随方向
      const off = 5 * S, ed = 5 * S, er = 3.5 * S;
      let e1x, e1y, e2x, e2y;
      const ux = Math.cos(ang - Math.PI / 2), uy = Math.sin(ang - Math.PI / 2);
      e1x = hx + ux * ed - uy * off; e1y = hy + uy * ed + ux * off;
      e2x = hx + ux * ed + uy * off; e2y = hy + uy * ed - ux * off;
      ctx2d.fillStyle = '#3DDC3D';
      ctx2d.beginPath(); ctx2d.arc(e1x, e1y, er, 0, Math.PI * 2); ctx2d.fill();
      ctx2d.beginPath(); ctx2d.arc(e2x, e2y, er, 0, Math.PI * 2); ctx2d.fill();
      ctx2d.fillStyle = '#000';
      ctx2d.beginPath(); ctx2d.arc(e1x, e1y, er * 0.45, 0, Math.PI * 2); ctx2d.fill();
      ctx2d.beginPath(); ctx2d.arc(e2x, e2y, er * 0.45, 0, Math.PI * 2); ctx2d.fill();
    }

    // 名字（自己白色，别人用对应颜色，方便对号入座）
    const pmeta = players.get(pid);
    if (pmeta) {
      ctx2d.font = 'bold 11px "Microsoft YaHei", sans-serif';
      ctx2d.textAlign = 'center';
      const label = pmeta.n + (pmeta.w > 0 ? ' ⭐' + pmeta.w : '') + (pid === myPid ? '（你）' : '');
      ctx2d.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx2d.lineWidth = 3;
      ctx2d.strokeText(label, hx, hy - CELL * 0.98);
      ctx2d.fillStyle = pid === myPid ? '#ffffff' : g.col;
      ctx2d.fillText(label, hx, hy - CELL * 0.98);
    }
  }
}
const lastHeadPos = new Map();

function burst(x, y, color, n) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, sp = 1 + Math.random() * 3.2;
    particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, color });
  }
}
function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx * dt * 0.06; p.y += p.vy * dt * 0.06;
    p.vx *= 0.96; p.vy *= 0.96;
    p.life -= dt * 0.0016;
    if (p.life <= 0) particles.splice(i, 1);
  }
}
function drawParticles() {
  for (const p of particles) {
    ctx2d.globalAlpha = Math.max(p.life, 0);
    ctx2d.fillStyle = p.color;
    ctx2d.beginPath();
    ctx2d.arc(p.x, p.y, 3 * p.life + 1, 0, Math.PI * 2);
    ctx2d.fill();
  }
  ctx2d.globalAlpha = 1;
}

let boostingMe = false;
function renderLoop(t) {
  const ts = performance.now();
  ctx2d.setTransform(viewScale, 0, 0, viewScale, 0, 0);
  ctx2d.clearRect(0, 0, gridW * CELL, gridH * CELL);
  if (!myPid || !roomCode) { requestAnimationFrame(renderLoop); return; }
  if (phase === 'playing' || phase === 'over') {
    drawBase();
    drawObstacles();
    drawPoisons();
    drawFoods(ts);
    drawSnakes(ts);
    // 自己加速提示
    if (boostHeld && phase === 'playing' && !deadMe) {
      const me = players.get(myPid);
      const h = lastHeadPos.get(myPid);
      if (me && me.a && h) {
        ctx2d.font = 'bold 12px sans-serif';
        ctx2d.textAlign = 'center';
        ctx2d.strokeStyle = 'rgba(0,0,0,.7)'; ctx2d.lineWidth = 3;
        ctx2d.strokeText('⚡ 加速中', h[0] * CELL, h[1] * CELL + CELL * 0.8);
        ctx2d.fillStyle = '#ffd93d';
        ctx2d.fillText('⚡ 加速中', h[0] * CELL, h[1] * CELL + CELL * 0.8);
      }
    }
    updateParticles(ts - (lastFrameTs || ts));
    lastFrameTs = ts;
    drawParticles();
    // 自己蛇身描边提示（观战时关闭）
    if (!deadMe) highlightSelf();
  } else if (phase === 'countdown') {
    drawBase();
    drawFoods(ts);
  } else {
    drawBase();
  }
  requestAnimationFrame(renderLoop);
}
let lastFrameTs = 0;

function highlightSelf() {
  // 简化：自己蛇头加个呼吸圈
  const h = lastHeadPos.get(myPid);
  const me = players.get(myPid);
  if (!h || !me || !me.a) return;
  const cx = h[0] * CELL + CELL / 2, cy = h[1] * CELL + CELL / 2;
  const r = CELL * 0.85 + Math.sin(performance.now() / 220) * 2.5;
  ctx2d.beginPath();
  ctx2d.arc(cx, cy, r, 0, Math.PI * 2);
  ctx2d.strokeStyle = 'rgba(255, 255, 255, 0.45)';
  ctx2d.lineWidth = 2;
  ctx2d.setLineDash([5, 5]);
  ctx2d.stroke();
  ctx2d.setLineDash([]);
}

// ---------- 顶栏/状态 ----------
function tickUi() {  if (!myPid || !roomCode) return;
  if (phase === 'playing') {
    const left = Math.max(0, Math.ceil((phEndAt - Date.now()) / 1000));
    const mm = String(Math.floor(left / 60)).padStart(2, '0');
    const ss = String(left % 60).padStart(2, '0');
    const alive = [...players.values()].filter((p) => p.a).length;
    el.phase.textContent = `第 ${roundNo} 局 · ${MODE_LABELS[myMode] || ''} · ⏱ ${mm}:${ss} · 存活 ${alive}/${players.size}`;
  } else if (phase === 'over') {
    const left = Math.max(0, Math.ceil((phAt - Date.now()) / 1000));
    el.overNext.textContent = `下一局 ${left} 秒后自动开始 · 按【空格】立即开始`;
    el.phase.textContent = `第 ${roundNo} 局结束`;
  } else {
    el.phase.textContent = '';
  }
}

// 更新 host 面板状态（welcome/room 更新时调用）
