// 화면 흐름(첫 화면 → 대기실 → 던전 → 결과), 입력, HUD
import { World, icon, portrait, loadModel } from './render.js';
import { Sim } from './sim.js';
import { genMap, slide, cellOf, los } from './map.js';
import * as net from './net.js';
import { T, TICK, CLASSES, MOBS, TEAMS, RARITY, MATCH_TIME, PORTAL_TIMES, FOG_START, POTION_HEAL } from './data.js';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('abyss.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('abyss.' + k, JSON.stringify(v)); } catch { /* 저장 불가 */ } },
};
const fmt = s => { s = Math.max(0, Math.ceil(s)); return `${String(s / 60 | 0).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

let profile = store.get('profile', { name: '', cls: 'knight', team: 0 });
const S = { role: null, myId: null, net: null, code: null, lobby: [], inGame: false };
let G = null;               // 진행 중인 판
let sim = null, simTimer = null;
const world = new World($('cv'));

// 1인칭 손 무기: [모델, 카메라 기준 위치, 회전, 크기]
const VIEW_MODEL = {
  knight: [['it/sword_1handed.gltf', [0.3, -0.3, -0.5], [-0.7, 0, 0.3], 0.3],
    ['it/shield_round.gltf', [-0.44, -0.4, -0.58], [0, 0.6, 0], 0.4]],
  rogue: [['it/dagger.gltf', [0.26, -0.26, -0.45], [-0.9, 0, 0.25], 0.35],
    ['it/dagger.gltf', [-0.26, -0.28, -0.45], [-0.9, 0, -0.25], 0.35]],
  mage: [['it/staff.gltf', [0.3, -0.42, -0.55], [-0.35, 0, 0.2], 0.4]],
  barbarian: [['it/axe_2handed.gltf', [0.3, -0.42, -0.55], [-0.6, 0, 0.35], 0.38]],
};
// 마우스 감도 (설정값 1~20, 기본 6 → 픽셀당 0.0015 라디안)
let sens = store.get('sens', 6);
const SENS_K = 0.00025;
let rawMouse = store.get('rawMouse', true);
// 마우스 이동량은 이벤트마다 바로 돌리지 않고 모았다가 프레임마다 한 번에 적용해요
const look = { dx: 0, dy: 0, prev: 0, prevT: 0, lockT: 0 };
const locked = () => document.pointerLockElement === $('cv');

function show(id) {
  for (const s of ['home', 'lobby', 'game', 'result']) $(s).hidden = s !== id;
}
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), 2600);
}
function loading(msg) {
  $('loading').hidden = !msg;
  $('loading-msg').textContent = msg || '';
}

// ---------- 첫 화면 ----------
async function classCards(el, compact) {
  el.innerHTML = Object.entries(CLASSES).map(([k, c]) => `
    <div class="cls-card${profile.cls === k ? ' on' : ''}" data-cls="${k}">
      <img data-pf="${k}" alt="">
      <div class="n">${c.name}</div><div class="en">${c.en}</div>
      <div class="d">${c.desc}</div>
      <div class="st">체력 ${c.hp} · 속도 ${c.speed}</div>
    </div>`).join('');
  el.querySelectorAll('.cls-card').forEach(d => d.onclick = () => {
    profile.cls = d.dataset.cls; store.set('profile', profile);
    el.querySelectorAll('.cls-card').forEach(x => x.classList.toggle('on', x === d));
    if (compact) sendLobby();
  });
  for (const k of Object.keys(CLASSES)) {
    const src = await portrait(k);
    el.querySelectorAll(`[data-pf="${k}"]`).forEach(i => (i.src = src));
  }
}
function teamChips(el, compact) {
  el.innerHTML = TEAMS.map((t, k) => `<div class="team${profile.team === k ? ' on' : ''}" data-team="${k}"><i style="background:${t.color}"></i>${t.name} 팀</div>`).join('');
  el.querySelectorAll('.team').forEach(d => d.onclick = () => {
    profile.team = +d.dataset.team; store.set('profile', profile);
    el.querySelectorAll('.team').forEach(x => x.classList.toggle('on', x === d));
    if (compact) sendLobby();
  });
}
function renderStash() {
  const st = store.get('stash', { total: 0, runs: 0, escapes: 0, best: 0 });
  $('stash').innerHTML = `<span>보물 창고<b>${st.total.toLocaleString()}</b></span><span>탈출<b>${st.escapes}/${st.runs}</b></span><span>최고 한 판<b>${st.best.toLocaleString()}</b></span>`;
}

function myName() {
  const n = $('name').value.trim() || '모험가' + Math.floor(Math.random() * 90 + 10);
  profile.name = n; store.set('profile', profile);
  return n;
}

$('name').value = profile.name || '';
const urlCode = new URLSearchParams(location.search).get('room');
if (urlCode) $('code').value = urlCode.toUpperCase();
classCards($('classes'));
teamChips($('teams'));
renderStash();

$('btn-host').onclick = async () => {
  const name = myName();
  $('home-err').textContent = '';
  loading('방을 여는 중…');
  for (let tries = 0; tries < 3; tries++) {
    const code = net.makeCode();
    try {
      S.net = await net.host(code, { onJoin: hostJoin, onData: hostData, onLeave: hostLeave });
      S.role = 'host'; S.myId = 'host'; S.code = code;
      S.lobby = [{ id: 'host', name, cls: profile.cls, team: profile.team, host: true }];
      loading(null);
      enterLobby();
      return;
    } catch (e) {
      if (e.type !== 'unavailable-id') { loading(null); $('home-err').textContent = '방을 열 수 없어요: ' + (e.message || e.type); return; }
    }
  }
  loading(null);
};

$('btn-join').onclick = async () => {
  const code = $('code').value.trim().toUpperCase();
  if (code.length !== 5) { $('home-err').textContent = '방 코드 5자리를 입력하세요'; return; }
  const name = myName();
  $('home-err').textContent = '';
  loading('방에 연결하는 중…');
  try {
    S.net = await net.join(code, { onData: clientData, onClose: () => { if (S.role) { toast('방장과 연결이 끊겼어요'); leaveRoom(); } } });
    S.role = 'client'; S.myId = S.net.id; S.code = code;
    S.net.send({ t: 'hello', name, cls: profile.cls, team: profile.team });
    loading(null);
    enterLobby();
  } catch (e) {
    loading(null);
    $('home-err').textContent = e.message === 'timeout' ? '연결 시간이 초과됐어요' : (e.message || '연결 실패');
  }
};
$('code').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-join').click(); });

// ---------- 대기실 ----------
function enterLobby() {
  S.inGame = false;
  show('lobby');
  $('lb-code').textContent = S.code;
  classCards($('lb-classes'), true);
  teamChips($('lb-teams'), true);
  $('btn-start').hidden = S.role !== 'host';
  history.replaceState(null, '', '?room=' + S.code);
  renderLobby();
}
function renderLobby() {
  $('lb-list').innerHTML = S.lobby.map(p => `
    <div class="lb-p"><img data-pf="${p.cls}"><span class="t" style="background:${TEAMS[p.team].color}"></span>
      <span class="n">${esc(p.name)}${p.id === S.myId ? ' <span class="muted">(나)</span>' : ''}</span>
      <span class="muted">${CLASSES[p.cls].name}</span>${p.host ? '<span class="h">방장</span>' : ''}${p.waiting ? '<span class="muted">· 다음 판 대기</span>' : ''}</div>`).join('');
  $('lb-list').querySelectorAll('[data-pf]').forEach(async i => (i.src = await portrait(i.dataset.pf)));
  $('lb-wait').textContent = S.role === 'host' ? `${S.lobby.length}명` : '방장이 시작하길 기다리는 중…';
}
function sendLobby() {
  if (S.role === 'host') {
    const me = S.lobby.find(p => p.id === 'host');
    me.cls = profile.cls; me.team = profile.team;
    broadcastRoom();
  } else if (S.role === 'client') S.net.send({ t: 'lobby', cls: profile.cls, team: profile.team });
}
function broadcastRoom() {
  S.net.broadcast({ t: 'room', players: S.lobby, inGame: S.inGame });
  renderLobby();
}
$('btn-copy').onclick = () => {
  const url = location.origin + location.pathname + '?room=' + S.code;
  navigator.clipboard.writeText(url).then(() => toast('초대 링크를 복사했어요'), () => toast(url));
};
$('btn-leave').onclick = () => leaveRoom();
$('btn-start').onclick = () => hostStart();

function leaveRoom() {
  stopSim();
  if (S.net) S.net.close();
  S.role = null; S.net = null; S.lobby = []; S.inGame = false;
  G = null;
  world.clearEntities();
  $('tags').innerHTML = '';
  history.replaceState(null, '', location.pathname);
  show('home');
  renderStash();
}

// ---------- 방장: 네트워크 ----------
function hostJoin(id) { /* hello 메시지를 기다림 */ }
function hostData(id, m) {
  if (m.t === 'hello') {
    const name = String(m.name || '모험가').slice(0, 10);
    S.lobby = S.lobby.filter(p => p.id !== id);
    S.lobby.push({ id, name, cls: CLASSES[m.cls] ? m.cls : 'knight', team: (m.team | 0) % TEAMS.length, waiting: S.inGame });
    broadcastRoom();
    if (S.inGame) S.net.send(id, { t: 'busy' });
    return;
  }
  if (m.t === 'lobby') {
    const p = S.lobby.find(p => p.id === id);
    if (p) { if (CLASSES[m.cls]) p.cls = m.cls; p.team = (m.team | 0) % TEAMS.length; broadcastRoom(); }
    return;
  }
  if (sim && S.inGame) sim.input(id, m);
}
function hostLeave(id) {
  const p = S.lobby.find(p => p.id === id);
  S.lobby = S.lobby.filter(p => p.id !== id);
  if (sim && S.inGame) sim.leave(id);
  if (p) toast(`${p.name} 님이 나갔어요`);
  broadcastRoom();
}

function hostStart() {
  const seed = Math.floor(Math.random() * 2 ** 31);
  S.lobby.forEach(p => (p.waiting = false));
  const roster = S.lobby.map(({ id, name, cls, team }) => ({ id, name, cls, team }));
  S.inGame = true;
  broadcastRoom();
  S.net.broadcast({ t: 'start', seed, roster });
  sim = new Sim(seed, roster);
  startGame(seed, roster);
}

// 방장 탭이 백그라운드여도 멈추지 않게 워커 타이머 사용
function startSim() {
  stopSim();
  const blob = new Blob([`setInterval(() => postMessage(0), ${TICK * 1000})`], { type: 'text/javascript' });
  simTimer = new Worker(URL.createObjectURL(blob));
  let last = performance.now(), acc = 0;
  simTimer.onmessage = () => {
    const now = performance.now();
    acc += (now - last) / 1000; last = now;
    let n = 0;
    while (acc >= TICK && n < 10) { sim.step(); acc -= TICK; n++; }
    if (acc > TICK) acc = 0;
    if (!n) return;
    for (const p of S.lobby) if (p.id !== 'host' && !p.waiting) S.net.send(p.id, sim.snapshot(p.id));
    applySnap(sim.snapshot('host'));
    sim.clearFrame();
    if (sim.over && !sim.ended) {
      sim.ended = true;
      const results = sim.results();
      S.net.broadcast({ t: 'end', results });
      setTimeout(() => endGame(results), 1500);
    }
  };
}
function stopSim() {
  if (simTimer) { simTimer.terminate(); simTimer = null; }
}

// ---------- 참가자: 네트워크 ----------
function clientData(m) {
  if (m.t === 'room') {
    S.lobby = m.players;
    if (!S.inGame && !$('lobby').hidden) renderLobby();
    return;
  }
  if (m.t === 'busy') { toast('게임이 진행 중이에요. 다음 판에 참가해요'); return; }
  if (m.t === 'start') { S.inGame = true; startGame(m.seed, m.roster); return; }
  if (m.t === 'snap') { if (G && G.ready) applySnap(m); return; }
  if (m.t === 'end') { setTimeout(() => endGame(m.results), 1500); return; }
}

function sendInput(m) {
  if (S.role === 'host') { if (sim) sim.input('host', m); }
  else if (S.net) S.net.send(m);
}

// ---------- 게임 시작 ----------
async function startGame(seed, roster) {
  if (!roster.some(p => p.id === S.myId)) { toast('이번 판은 관전할 수 없어요. 다음 판을 기다려요'); return; }
  loading('던전을 만드는 중…');
  world.clearEntities();
  $('tags').innerHTML = '';
  $('feed').innerHTML = '';
  $('state').innerHTML = '';
  const map = genMap(seed);
  const meInfo = roster.find(p => p.id === S.myId);
  G = {
    seed, map, roster, ready: false, time: 0, fog: null,
    me: { x: 0, z: 0, rot: 0, alive: true, escaped: false, hp: CLASSES[meInfo.cls].hp, maxHp: CLASSES[meInfo.cls].hp, placed: false },
    info: meInfo, my: { gold: 0, items: [], potions: 2, atkCd: 0, skillCd: 0, kills: 0 },
    atkCd: 0, skillCd: 0, potCd: 0, hold: false, sendAcc: 0,
    pstate: new Map(), opened: new Set(), explored: new Set(), feedCount: 0,
    pending: new Set(), myAnimSeq: -1, pitch: 0, perf: { t: 0, n: 0, wait: 3 },
  };
  world.setView(true);
  await world.build(map);
  await world.setViewModel(VIEW_MODEL[meInfo.cls]);
  await Promise.all([...new Set(roster.map(p => CLASSES[p.cls].model)), ...Object.values(MOBS).map(m => m.model)]
    .map(m => loadModel(`c/${m}.glb`)));
  setupHud();
  if (S.role === 'host') startSim();
  G.ready = true;
  show('game');
  loading(null);
}

async function setupHud() {
  const c = CLASSES[G.info.cls];
  $('me-name').textContent = G.info.name;
  $('me-cls').textContent = c.en;
  $('pf').src = await portrait(G.info.cls);
  $('s-atk').querySelector('img').src = await icon(c.weaponIcon, [0, 0.4, -0.8]);
  $('s-skill').querySelector('img').src = await icon(c.skill.icon, [0.3, 0.5, 0]);
  $('s-skill').querySelector('.nm2').textContent = c.skill.name;
  $('s-pot').querySelector('img').src = await icon('m/bottle_A_labeled_brown.gltf.glb', [0.2, 0.4, 0.15]);
}

// ---------- 스냅샷 적용 ----------
function ensurePlayer(info) {
  const a = world.players.get(info.id);
  if (a || G.pending.has(info.id)) return a;
  G.pending.add(info.id);
  world.addPlayer(info, info.id === S.myId).then(() => G.pending.delete(info.id));
  return null;
}
function ensureMob(id, ty, x, z) {
  const a = world.mobs.get(id);
  if (a || G.pending.has('m' + id)) return a;
  G.pending.add('m' + id);
  world.addMob(id, ty, x, z).then(() => G.pending.delete('m' + id));
  return null;
}

function applySnap(s) {
  if (!G || !G.ready) return;
  G.time = s.time; G.fog = s.fog;
  const myCls = CLASSES[G.info.cls];
  const seenP = new Set();
  for (const [id, x, z, rot, hp, maxHp, f, an, aSeq, chp] of s.p) {
    const info = G.roster.find(p => p.id === id);
    if (!info) continue;
    seenP.add(id);
    const alive = !!(f & 1), escaped = !!(f & 2), stealth = !!(f & 4), block = !!(f & 8), moving = !!(f & 16);
    G.pstate.set(id, { x, z, hp, maxHp, alive, escaped, stealth, block, chp, info });
    const a = ensurePlayer({ ...info, x, z });
    if (id === S.myId) {
      G.me.hp = hp; G.me.maxHp = maxHp; G.me.block = block; G.me.stealth = stealth; G.me.chp = chp;
      if (!G.me.placed) { G.me.x = x; G.me.z = z; G.me.placed = true; }
      if (G.me.alive && !alive) onMyDeath();
      if (!G.me.escaped && escaped) onMyEscape();
      G.me.alive = alive; G.me.escaped = escaped;
      if (a) {
        if (aSeq !== G.myAnimSeq) {
          // 공격/스킬 모션은 누르는 순간 이미 재생했으니 서버 쪽은 생략
          if (G.myAnimSeq >= 0 && an && an !== myCls.atk.anim && an !== myCls.skill.anim && an !== 'Death_A') a.once(an);
          G.myAnimSeq = aSeq;
        }
        if (!alive) a.die();
        a.setOpacity(escaped ? 0 : stealth ? 0.35 : 1);
      }
      continue;
    }
    if (!a) continue;
    a.push(x, z, rot);
    if (a.aSeq !== undefined && aSeq !== a.aSeq && an && alive) a.once(an);
    a.aSeq = aSeq;
    if (!alive) a.die();
    else a.setLoco(moving ? 'Running_A' : block ? 'Blocking' : 'Idle');
    const ally = info.team === G.info.team;
    a.setOpacity(escaped ? 0 : stealth ? (ally ? 0.35 : 0) : 1);
  }

  const seenM = new Set();
  for (const [id, ty, x, z, rot, hp, dead, an, aSeq, moving] of s.m) {
    seenM.add(id);
    const a = ensureMob(id, ty, x, z);
    if (!a) continue;
    a.push(x, z, rot); a.hp = hp;
    if (a.aSeq !== undefined && aSeq !== a.aSeq && an && !dead) a.once(an);
    a.aSeq = aSeq;
    if (dead) a.die();
    else a.setLoco(moving ? MOBS[ty].anim.walk : MOBS[ty].anim.idle);
  }
  for (const [id, a] of world.mobs) if (!seenM.has(id)) { a.remove(); if (a.tag) a.tag.remove(); world.mobs.delete(id); }

  const seenPr = new Set();
  for (const [id, k, x, z] of s.pr) {
    seenPr.add(id);
    const o = world.projs.get(id);
    if (!o) world.makeProj(id, k, x, z);
    else (o.userData.buf || (o.userData.buf = [])).push({ t: performance.now(), x, z });
  }
  for (const [id, o] of world.projs) if (!seenPr.has(id)) { world.scene.remove(o); world.projs.delete(id); }

  for (const id of s.ch) if (!G.opened.has(id)) { G.opened.add(id); world.openChest(id); }
  const seenB = new Set();
  G.bags = s.bg;
  for (const [id, x, z] of s.bg) { seenB.add(id); if (!world.bags.has(id) && !G.pending.has('b' + id)) { G.pending.add('b' + id); world.makeBag(id, x, z); } }
  for (const [id, o] of world.bags) if (!seenB.has(id)) { world.scene.remove(o); world.bags.delete(id); }
  G.portals = s.po;
  for (const [id, x, z] of s.po) if (!world.portals.has(id)) world.makePortal(id, x, z);

  if (s.me) {
    G.my = s.me;
    if (s.me.fix) { G.me.x = s.me.fix[0]; G.me.z = s.me.fix[1]; }
  }
  for (const ev of s.ev) onEvent(ev);
}

function onEvent(ev) {
  if (ev.e === 'feed') return feed(ev.text, ev.cls);
  if (ev.e === 'hit') {
    const mine = ev.id === S.myId;
    pop(String(ev.dmg) + (ev.crit ? '!' : ''), ev.x, 2.6, ev.z, mine ? 'mine' : ev.crit ? 'crit' : '');
    if (mine) { const h = $('hurt'); h.style.opacity = 1; clearTimeout(h.t); h.t = setTimeout(() => (h.style.opacity = 0), 120); }
    if (!ev.mob && !mine) { const a = world.players.get(ev.id); if (a && !a.oneShot && !a.dead) a.once('Hit_A'); }
    return;
  }
  if (ev.e === 'gold' && ev.id === S.myId) return pop(`+${ev.v} 금화`, ev.x, 2.2, ev.z, 'gold');
  if (ev.e === 'heal' && ev.id === S.myId) return pop(`+${ev.v}`, G.me.x, 2.8, G.me.z, 'heal');
  if (ev.e === 'fx') return world.effect(ev.k, ev.x, ev.z);
  if (ev.e === 'loot' && ev.id === S.myId) {
    if (ev.gold) lootToast(`금화 +${ev.gold}`, '#ffe08a');
    for (const it of ev.items) lootToast(`${RARITY[it.r].name} · ${it.name}  (${it.v})`, RARITY[it.r].color);
    return;
  }
  if (ev.e === 'portal') return lootToast('탈출 포털이 열렸어요! 미니맵의 파란 점', '#9fe8ff');
}

// ---------- 결과 ----------
function onMyDeath() {
  $('state').innerHTML = '<div class="big dead">사 망</div><div class="s">가진 것을 모두 잃었어요 · 판이 끝날 때까지 관전해요</div>';
}
function onMyEscape() {
  $('state').innerHTML = '<div class="big esc">탈 출 성 공</div><div class="s">전리품을 지켰어요 · 판이 끝날 때까지 관전해요</div>';
}
function endGame(results) {
  if (!G) return;
  stopSim();
  const me = results.find(r => r.id === S.myId);
  const st = store.get('stash', { total: 0, runs: 0, escapes: 0, best: 0 });
  if (me) {
    st.runs++;
    if (me.escaped) { st.escapes++; st.total += me.value; st.best = Math.max(st.best, me.value); }
    store.set('stash', st);
  }
  $('rs-title').textContent = me && me.escaped ? '살아서 돌아왔다' : '심연에 잠들다';
  $('rs-title').style.color = me && me.escaped ? 'var(--ghost)' : '#d33a32';
  $('rs-me').innerHTML = me && me.escaped ? `이번 판 수확 <b>${me.value.toLocaleString()}</b> · 보물 창고 <b>${st.total.toLocaleString()}</b>` : `아무것도 챙기지 못했어요 · 보물 창고 <b>${st.total.toLocaleString()}</b>`;
  $('rs-table').innerHTML = '<tr><th>이름</th><th>직업</th><th>팀</th><th>결과</th><th>처치</th><th>가치</th></tr>' +
    results.sort((a, b) => b.value - a.value).map(r => `<tr><td>${esc(r.name)}</td><td>${CLASSES[r.cls].name}</td>
      <td><span style="color:${TEAMS[r.team].color}">●</span> ${TEAMS[r.team].name}</td>
      <td class="${r.escaped ? 'ok' : 'no'}">${r.escaped ? '탈출' : '사망'}</td><td>${r.kills}</td><td>${r.value.toLocaleString()}</td></tr>`).join('');
  G = null;
  sim = null;
  S.inGame = false;
  for (const p of pops.splice(0)) p.el.remove();
  $('prompt').hidden = true;
  $('hurt').classList.remove('fog');
  $('result').hidden = false;
  $('inv').hidden = true;
  $('xhair').hidden = $('lockhint').hidden = true;
  if (locked()) document.exitPointerLock();
}
$('btn-back').onclick = () => {
  $('result').hidden = true;
  world.clearEntities();
  $('tags').innerHTML = '';
  if (S.role === 'host') { S.lobby.forEach(p => (p.waiting = false)); broadcastRoom(); }
  if (S.role) enterLobby(); else show('home');
};

// ---------- HUD 보조 ----------
function feed(text, cls) {
  const d = document.createElement('div');
  d.className = cls || '';
  d.textContent = text;
  $('feed').prepend(d);
  while ($('feed').children.length > 6) $('feed').lastChild.remove();
  setTimeout(() => { d.style.opacity = 0; setTimeout(() => d.remove(), 1000); }, 9000);
}
function lootToast(text, color) {
  const d = document.createElement('div');
  d.textContent = text; d.style.color = color;
  $('toasts').appendChild(d);
  setTimeout(() => d.remove(), 2700);
}
const pops = [];
function pop(text, x, y, z, cls) {
  const el = document.createElement('div');
  el.className = 'dmg ' + (cls || '');
  el.textContent = text;
  document.body.appendChild(el);
  pops.push({ el, x: x + (Math.random() - .5) * .6, y, z, t: 0 });
}

function tagFor(a, cls) {
  if (!a.tag) { a.tag = document.createElement('div'); $('tags').appendChild(a.tag); }
  if (a.tagCls !== cls) { a.tag.className = 'tag ' + cls; a.tagCls = cls; }
  return a.tag;
}
function placeTag(a, el, html, vis) {
  // 1인칭에선 벽 너머 이름표가 보이면 위치가 들통나서 시야가 뚫린 것만 보여줘요
  if (vis && world.fps && !a.isMe && !los(G.map, G.me.x, G.me.z, a.o.position.x, a.o.position.z)) vis = false;
  if (!vis) { el.style.display = 'none'; return; }
  const p = world.toScreen(a.o.position.x, 2.9, a.o.position.z);
  if (!p.vis) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
  if (el._h !== html) { el.innerHTML = html; el._h = html; }
}

function updateTags() {
  for (const [id, a] of world.players) {
    const st = G.pstate.get(id);
    if (!st) continue;
    const mine = id === S.myId, ally = st.info.team === G.info.team;
    const cls = mine ? 'me' : ally ? 'ally' : 'enemy';
    const el = tagFor(a, cls);
    const hb = mine ? '' : `<div class="hb"><div style="width:${Math.max(0, st.hp / st.maxHp * 100)}%"></div></div>`;
    const name = st.alive ? esc(st.info.name) : '☠ ' + esc(st.info.name);
    placeTag(a, el, name + (st.alive ? hb : ''), !st.escaped && (!st.stealth || ally));
  }
  for (const a of world.mobs.values()) {
    const el = tagFor(a, 'mob');
    const d = MOBS[a.ty];
    const near = (a.o.position.x - G.me.x) ** 2 + (a.o.position.z - G.me.z) ** 2 < 100;
    placeTag(a, el, `${d.name}<div class="hb"><div style="width:${Math.max(0, (a.hp ?? d.hp) / d.hp * 100)}%"></div></div>`, !a.dead && (near || (a.hp ?? d.hp) < d.hp));
  }
  for (let k = pops.length - 1; k >= 0; k--) {
    const p = pops[k];
    p.t += 1 / 60; p.y += 0.02;
    const s = world.toScreen(p.x, p.y, p.z);
    p.el.style.left = s.x + 'px'; p.el.style.top = s.y + 'px';
    p.el.style.opacity = String(1 - p.t / 1.1);
    if (p.t > 1.1) { p.el.remove(); pops.splice(k, 1); }
  }
}

function nearestInteract() {
  if (!G.me.alive || G.me.escaped) return null;
  const d2 = (x, z) => (x - G.me.x) ** 2 + (z - G.me.z) ** 2;
  if (G.portals) for (const [, x, z] of G.portals) if (d2(x, z) < 1.6 * 1.6) return { k: 'portal', x, z };
  for (const c of G.map.chests) if (!G.opened.has(c.id) && d2(c.x, c.z) < 2.6 * 2.6) return { k: 'chest', x: c.x, z: c.z, gold: c.gold };
  if (G.bags) for (const [, x, z, name] of G.bags) if (d2(x, z) < 2.2 * 2.2) return { k: 'bag', x, z, name };
  return null;
}

function updatePrompt() {
  const it = nearestInteract(), el = $('prompt');
  if (!it) { el.hidden = true; return; }
  const p = world.toScreen(it.x, it.k === 'portal' ? 3.6 : 2.2, it.z);
  el.hidden = false;
  el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
  const prog = G.me.chp >= 0 ? G.me.chp : -1;
  const label = it.k === 'portal' ? '탈출 중…' : it.k === 'chest' ? (it.gold ? '황금 상자 열기' : '상자 열기') : `${esc(it.name)}의 전리품 줍기`;
  const html = (it.k === 'portal' ? '' : '<kbd>F</kbd> ') + label + (prog >= 0 ? `<div class="pb"><div style="width:${prog * 100}%"></div></div>` : '');
  if (el._h !== html) { el.innerHTML = html; el._h = html; }
}

let hudAcc = 0;
function updateHud(dt) {
  hudAcc += dt;
  if (hudAcc < 0.1) return;
  hudAcc = 0;
  const me = G.me, my = G.my, c = CLASSES[G.info.cls];
  $('me-hp').style.width = Math.max(0, me.hp / me.maxHp * 100) + '%';
  $('me-hpt').textContent = `${Math.max(0, Math.ceil(me.hp))} / ${me.maxHp}`;
  const t = G.time;
  if (t < FOG_START) { $('tm-lbl').textContent = '저주의 안개 수축까지'; $('tm').textContent = fmt(FOG_START - t); }
  else { $('tm-lbl').textContent = '던전 붕괴까지'; $('tm').textContent = fmt(MATCH_TIME - t); }
  const next = PORTAL_TIMES.find(p => p > t);
  $('tm-portal').textContent = next ? `다음 탈출 포털 ${fmt(next - t)}` : '';
  const outFog = G.fog && Math.hypot(me.x - G.fog[0], me.z - G.fog[1]) > G.fog[2];
  $('hurt').classList.toggle('fog', !!outFog && me.alive && !me.escaped);

  $('gold').textContent = my.gold.toLocaleString();
  $('value').textContent = (my.items.reduce((a, b) => a + b.v, 0) + my.gold).toLocaleString();
  $('kills').textContent = my.kills;
  const cd = (el, v, max) => { const d = el.querySelector('.cd'); d.style.display = v > 0.05 ? '' : 'none'; d.textContent = v >= 1 ? Math.ceil(v) : ''; d.style.clipPath = `inset(${(1 - v / max) * 100}% 0 0 0)`; };
  cd($('s-atk'), G.atkCd, c.atk.cd);
  cd($('s-skill'), Math.max(G.skillCd, my.skillCd || 0), c.skill.cd);
  $('s-pot').querySelector('.q').textContent = my.potions;
  $('s-pot').classList.toggle('empty', !my.potions);

  // 파티
  const mates = [...G.pstate.values()].filter(s => s.info.team === G.info.team && s.info.id !== S.myId);
  $('party').innerHTML = mates.map(s => `<div class="pm frame"><span class="dot" style="background:${s.alive ? TEAMS[s.info.team].color : '#555'}"></span>
    <span class="n">${esc(s.info.name)} <span class="muted">${s.escaped ? '탈출' : s.alive ? CLASSES[s.info.cls].name : '사망'}</span></span>
    <div class="mini"><div style="width:${s.alive ? s.hp / s.maxHp * 100 : 0}%"></div></div></div>`).join('');
  const all = [...G.pstate.values()];
  $('alive').textContent = `${all.filter(s => s.alive && !s.escaped).length} / ${all.length}`;
  $('escaped').textContent = all.filter(s => s.escaped).length;
  if (!$('inv').hidden) renderInv();
  drawMinimap();
}

function renderInv() {
  const my = G.my;
  const key = my.items.length + ':' + my.gold;
  if ($('inv')._k === key) return;
  $('inv')._k = key;
  const list = $('inv-list');
  if (!my.items.length) { list.innerHTML = '<div class="muted">아직 아무것도 없어요. 상자를 털어보세요.</div>'; return; }
  list.innerHTML = my.items.map((it, k) => `<div class="it"><img data-k="${k}"><span class="n" style="color:${RARITY[it.r].color}">${RARITY[it.r].name} · ${esc(it.name)}</span><span class="v">${it.v}</span></div>`).join('');
  list.querySelectorAll('img').forEach(async img => (img.src = await icon(my.items[+img.dataset.k].icon)));
}

function drawMinimap() {
  const cv = $('mm'), g = cv.getContext('2d'), map = G.map;
  const ci = cellOf(G.me.x), cj = cellOf(G.me.z);
  for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) G.explored.add((cj + dj) * map.W + ci + di);
  const S2 = 380 / Math.max(map.W, map.H);
  g.fillStyle = '#07060a'; g.fillRect(0, 0, 380, 380);
  for (const k of G.explored) {
    const i = k % map.W, j = (k / map.W) | 0;
    if (!map.floor(i, j)) continue;
    g.fillStyle = map.grid[k] === 2 ? '#3a3226' : '#4a4030';
    g.fillRect(i * S2, j * S2, S2 + .5, S2 + .5);
  }
  const px = x => (x / T + .5) * S2;
  if (G.fog) {
    g.strokeStyle = 'rgba(170,100,255,.9)'; g.lineWidth = 3;
    g.beginPath(); g.arc(px(G.fog[0]), px(G.fog[1]), G.fog[2] / T * S2, 0, 7); g.stroke();
  }
  const dot = (x, z, col, r) => { g.fillStyle = col; g.beginPath(); g.arc(px(x), px(z), r, 0, 7); g.fill(); };
  for (const [, x, z] of G.portals || []) { dot(x, z, 'rgba(95,216,255,.35)', 12); dot(x, z, '#5fd8ff', 6); }
  for (const s of G.pstate.values()) if (s.info.id !== S.myId && s.info.team === G.info.team && s.alive && !s.escaped) dot(s.x, s.z, TEAMS[s.info.team].color, 5);
  g.save();
  g.translate(px(G.me.x), px(G.me.z));
  g.rotate(-G.me.rot);
  g.fillStyle = '#ffd36a';
  g.beginPath(); g.moveTo(0, 9); g.lineTo(6, -6); g.lineTo(-6, -6); g.closePath(); g.fill();
  g.restore();
  g.strokeStyle = '#3a3024'; g.lineWidth = 2; g.strokeRect(1, 1, 378, 378);
}

// ---------- 입력 ----------
const keys = {};
const mouse = { x: innerWidth / 2, y: innerHeight / 2 };
const typing = () => document.activeElement && document.activeElement.tagName === 'INPUT';
addEventListener('keydown', e => {
  if (e.key === 'Escape' || e.key === '`') { toggleBoss(); return; }
  if (typing()) return;
  const k = e.key.toLowerCase();
  if ((k === '[' || k === ']') && G) {
    sens = Math.max(1, Math.min(20, sens + (k === ']' ? 1 : -1)));
    store.set('sens', sens);
    toast(`마우스 감도 ${sens}`);
    return;
  }
  if (k === 'm' && G) {
    rawMouse = !rawMouse;
    store.set('rawMouse', rawMouse);
    toast(rawMouse ? '마우스 원시 입력: 켬 (윈도우 가속 무시)' : '마우스 원시 입력: 끔 (윈도우 설정 그대로)');
    if (locked()) { document.exitPointerLock(); setTimeout(lockMouse, 150); }
    return;
  }
  if (e.key === 'Tab') { e.preventDefault(); if (G) { $('inv').hidden = !$('inv').hidden; $('inv')._k = null; } return; }
  keys[k] = true;
  if (!G || !G.ready) return;
  if (k === 'q') useSkill();
  if (k === '1' || k === 'r') sendInput({ t: 'potion' });
});
addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
addEventListener('mousemove', e => {
  mouse.x = e.clientX; mouse.y = e.clientY;
  if (!G || !locked() || !canAct()) return;
  // 잠금 직후 첫 이벤트와, 직전 움직임에 비해 갑자기 큰 값은 브라우저 버그로 튀는 값이라 버려요
  if (e.timeStamp - look.lockT < 120) return;
  const m = Math.hypot(e.movementX, e.movementY);
  if (e.timeStamp - look.prevT > 60) look.prev = 0;
  if (m > 90 && m > look.prev * 4 + 50) return;
  look.prev = m; look.prevT = e.timeStamp;
  look.dx += e.movementX; look.dy += e.movementY;
});
document.addEventListener('pointerlockchange', () => { look.lockT = performance.now(); look.dx = look.dy = 0; look.prev = 0; });
// OS 마우스 가속을 빼고 원시 입력으로 받아요 (지원 안 하는 브라우저는 일반 잠금)
function lockMouse() {
  const cv = $('cv');
  try {
    const r = cv.requestPointerLock(rawMouse ? { unadjustedMovement: true } : undefined);
    if (r && r.catch) r.catch(() => cv.requestPointerLock());
  } catch { cv.requestPointerLock(); }
}
addEventListener('contextmenu', e => { if (G) e.preventDefault(); });
$('cv').addEventListener('mousedown', e => {
  if (!G || !G.ready) return;
  if (world.fps && !locked()) { lockMouse(); return; }
  if (e.button === 0) attack();
  else if (e.button === 2) useSkill();
});

function canAct() { return G && G.ready && G.me.alive && !G.me.escaped; }
function attack() {
  if (!canAct() || G.atkCd > 0) return;
  const c = CLASSES[G.info.cls];
  G.atkCd = c.atk.cd;
  const a = world.players.get(S.myId);
  if (a) { a.once(c.atk.anim, c.atk.cd < 0.5 ? 1.5 : 1); a.o.rotation.y = G.me.rot; }
  world.swing();
  sendInput({ t: 'atk', rot: G.me.rot });
}
function useSkill() {
  if (!canAct() || G.skillCd > 0) return;
  const c = CLASSES[G.info.cls];
  G.skillCd = c.skill.cd;
  const a = world.players.get(S.myId);
  if (a && G.info.cls !== 'knight') a.once(c.skill.anim);
  sendInput({ t: 'skill', rot: G.me.rot });
}

function toggleBoss() {
  const b = $('boss');
  b.hidden = !b.hidden;
  if (!b.hidden) {
    if (locked()) document.exitPointerLock();
    const d = new Date();
    $('boss-date').textContent = `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()} 14:00`;
    document.title = '주간 업무 회의록';
  } else document.title = '심연 탈출';
}

// ---------- 메인 루프 ----------
let last = performance.now();
function frame(now) {
  const raw = (now - last) / 1000, dt = Math.min(0.05, raw);
  last = now;
  if (G && G.ready && !document.hidden) watchPerf(raw);
  fpsMeter(raw);
  if (G && G.ready) tickGame(dt);
  else world.update(dt, null, null);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// 화면 구석 FPS 표시 (가장 느린 프레임도 같이 보여서 끊김을 확인할 수 있어요)
const fm = { t: 0, n: 0, worst: 0 };
function fpsMeter(raw) {
  fm.t += raw; fm.n++; fm.worst = Math.max(fm.worst, raw);
  if (fm.t < 0.5) return;
  $('fpsc').textContent = `${Math.round(fm.n / fm.t)} fps · 최저 ${Math.round(1 / fm.worst)}`;
  fm.t = 0; fm.n = 0; fm.worst = 0;
}

// 3초 평균 프레임이 느리면 그래픽 품질을 한 단계씩 낮춰요
function watchPerf(raw) {
  const p = G.perf;
  if (raw > 0.25) return;
  p.t += raw; p.n++;
  if (p.t < p.wait) return;
  const avg = p.t / p.n;
  p.t = 0; p.n = 0; p.wait = 3;
  if (avg > 1 / 40 && world.low < 2) {
    world.setLow(world.low + 1);
    toast(world.low === 1 ? '버벅여서 그림자를 껐어요' : '버벅여서 빛 번짐 효과와 해상도를 낮췄어요');
  }
}

function tickGame(dt) {
  const me = G.me, c = CLASSES[G.info.cls];
  G.atkCd = Math.max(0, G.atkCd - dt);
  G.skillCd = Math.max(0, G.skillCd - dt);
  const a = world.players.get(S.myId);
  let moving = false;
  G.hold = !!keys.f;
  const fps = canAct();
  if (look.dx || look.dy) {
    me.rot -= look.dx * sens * SENS_K;
    G.pitch = Math.max(-1.2, Math.min(1.2, G.pitch - look.dy * sens * SENS_K));
    look.dx = look.dy = 0;
  }
  if (world.fps !== fps) world.setView(fps);
  $('xhair').hidden = !fps;
  $('lockhint').hidden = !fps || locked() || !$('boss').hidden;
  if (canAct() && me.placed && $('boss').hidden) {
    // 바라보는 방향 기준 이동 (앞 = sin/cos(rot), 오른쪽 = -cos/sin(rot))
    const fw = (keys.w ? 1 : 0) - (keys.s ? 1 : 0), rt = (keys.d ? 1 : 0) - (keys.a ? 1 : 0);
    const dx = fw * Math.sin(me.rot) - rt * Math.cos(me.rot);
    const dz = fw * Math.cos(me.rot) + rt * Math.sin(me.rot);
    if ((dx || dz) && !G.hold) {
      const l = Math.hypot(dx, dz);
      const sp = c.speed * (me.block ? 0.55 : 1) * dt;
      [me.x, me.z] = slide(G.map, me.x, me.z, dx / l * sp, dz / l * sp);
      moving = true;
      if (a) {
        let d = Math.atan2(dx, dz) - me.rot;
        while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
        const ad = Math.abs(d);
        a.setLoco(ad < 0.8 ? 'Running_A' : ad > 2.3 ? 'Walking_Backwards' : d > 0 ? 'Running_Strafe_Left' : 'Running_Strafe_Right');
      }
    } else if (a) a.setLoco(me.block ? 'Blocking' : 'Idle');
  }
  if (a) {
    a.o.position.set(me.x, 0, me.z);
    if (canAct()) a.o.rotation.y = me.rot;
    a.o.visible = !fps && a.opacity > 0.01;
  }
  G.sendAcc += dt;
  if (G.sendAcc >= TICK && canAct()) {
    sendInput({ t: 'pos', x: Math.round(me.x * 100) / 100, z: Math.round(me.z * 100) / 100, rot: Math.round(me.rot * 100) / 100, moving, hold: G.hold, dt: G.sendAcc });
    G.sendAcc = 0;
  }
  // 죽거나 탈출하면 살아 있는 팀원을 따라감
  let focus = { x: me.x, z: me.z, rot: me.rot, pitch: G.pitch, moving };
  if (!canAct()) {
    const mate = [...G.pstate.values()].find(s => s.info.team === G.info.team && s.alive && !s.escaped && s.info.id !== S.myId);
    if (mate) { const ma = world.players.get(mate.info.id); if (ma) focus = { x: ma.o.position.x, z: ma.o.position.z }; }
  }
  world.update(dt, focus, G.fog);
  updateTags();
  updatePrompt();
  updateHud(dt);
}

// 디버그/테스트용
window.__abyss = { S, get G() { return G; }, get sim() { return sim; }, world };
