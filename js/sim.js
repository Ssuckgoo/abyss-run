// 호스트 전용 게임 시뮬레이션. 방장 브라우저에서만 돌아가고 결과를 스냅샷으로 뿌려요.
import { T, TICK, MATCH_TIME, PORTAL_TIMES, FOG_START, FOG_END, CLASSES, MOBS, RARITY, LOOT, POTION_HEAL, START_POTIONS, PLAYER_R } from './data.js';
import { genMap, rng, free, slide, nextCell, cellOf, randomFloorIn } from './map.js';

const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };

export class Sim {
  constructor(seed, roster) {
    this.seed = seed;
    this.R = rng(seed ^ 0x5eed);
    this.map = genMap(seed);
    this.t = 0;
    this.events = [];
    this.pending = [];
    this.nextId = 1;
    this.over = false;

    // 플레이어: 팀마다 같은 스폰 방
    this.players = {};
    const teams = [...new Set(roster.map(p => p.team))];
    for (const p of roster) {
      const room = this.map.spawnRooms[teams.indexOf(p.team) % this.map.spawnRooms.length];
      const [x, z] = randomFloorIn(this.map, room, this.R);
      const c = CLASSES[p.cls];
      this.players[p.id] = {
        id: p.id, name: p.name, cls: p.cls, team: p.team, x, z, rot: 0, moving: false,
        hp: c.hp, maxHp: c.hp, alive: true, escaped: false,
        atkCd: 0, skillCd: 0, potCd: 0, block: 0, stealth: 0,
        a: '', aSeq: 0, gold: 0, items: [], potions: START_POTIONS, kills: 0,
        hold: false, ch: null, outSince: 0,
      };
    }

    // 몬스터
    this.mobs = [];
    const types = Object.keys(MOBS);
    for (const r of this.map.rooms) {
      if (r.spawn) continue;
      const n = Math.floor(this.R() * 3.2);
      for (let k = 0; k < n; k++) {
        const ty = types[Math.floor(this.R() * types.length)];
        const [x, z] = randomFloorIn(this.map, r, this.R);
        this.mobs.push({ id: this.nextId++, ty, x, z, hx: x, hz: z, rot: this.R() * 6.28, hp: MOBS[ty].hp, cd: 0, target: null, a: '', aSeq: 0, moving: false, dead: 0, path: null, pathT: 0 });
      }
    }

    this.chests = this.map.chests.map(c => ({ ...c, opened: false }));
    this.bags = [];
    this.projs = [];
    this.portals = [];

    // 안개: 스폰 방이 아닌 방 중 하나로 수렴
    const mid = this.map.rooms.filter(r => !r.spawn);
    const fr = mid[Math.floor(this.R() * mid.length)];
    this.fog = { cx: fr.cx * T, cz: fr.cy * T, r: 140, r0: 140, r1: 7 };
    this.portalPlan = PORTAL_TIMES.map((at, k) => {
      let room;
      if (k === PORTAL_TIMES.length - 1) room = fr;
      else room = mid[Math.floor(this.R() * mid.length)];
      const [x, z] = randomFloorIn(this.map, room, this.R);
      return { at, x, z };
    });
  }

  feed(text, cls = '') { this.events.push({ e: 'feed', text, cls }); }

  leave(id) {
    const p = this.players[id];
    if (!p || !p.alive || p.escaped) return;
    p.hp = 0;
    this.killPlayer(p, null, `${p.name} 님이 연결을 끊었어요`);
  }

  // ---------- 입력 ----------
  input(id, m) {
    const p = this.players[id];
    if (!p || !p.alive || p.escaped) return;
    if (m.t === 'pos') {
      const c = CLASSES[p.cls];
      const maxStep = c.speed * 1.6 * Math.max(0.05, m.dt || TICK) + 0.6;
      const dx = m.x - p.x, dz = m.z - p.z;
      if (dx * dx + dz * dz <= maxStep * maxStep && free(this.map, m.x, m.z, PLAYER_R - 0.05)) {
        p.x = m.x; p.z = m.z;
      } else {
        p.fix = true;
      }
      p.rot = m.rot; p.moving = !!m.moving; p.hold = !!m.hold;
      return;
    }
    if (m.t === 'atk') this.attack(p, m.rot);
    else if (m.t === 'skill') this.skill(p, m.rot);
    else if (m.t === 'potion') this.potion(p);
  }

  act(p, anim) { p.a = anim; p.aSeq++; }

  attack(p, rot) {
    if (p.atkCd > 0) return;
    const c = CLASSES[p.cls], a = c.atk;
    p.atkCd = a.cd; p.rot = rot; p.stealth = 0;
    this.act(p, a.anim);
    this.pending.push({ at: this.t + a.hitDelay, fn: () => {
      if (!p.alive) return;
      if (a.proj) {
        this.projs.push({ id: this.nextId++, k: 'fire', x: p.x + Math.sin(p.rot) * 0.8, z: p.z + Math.cos(p.rot) * 0.8,
          vx: Math.sin(p.rot) * a.pspeed, vz: Math.cos(p.rot) * a.pspeed, life: a.life, dmg: a.dmg, owner: p.id, team: p.team });
      } else {
        this.melee(p, a.range, a.arc, a.dmg);
      }
    } });
  }

  melee(p, range, arc, dmg) {
    for (const t of this.targets(p)) {
      const d2 = dist2(p, t);
      if (d2 > range * range) continue;
      const ang = Math.atan2(t.x - p.x, t.z - p.z);
      if (d2 > 0.5 && Math.abs(angDiff(ang, p.rot)) > arc) continue;
      this.hurt(t, dmg, p);
    }
  }

  // p가 때릴 수 있는 대상: 살아 있는 몬스터 + 다른 팀 플레이어
  targets(p) {
    const out = this.mobs.filter(m => !m.dead);
    for (const q of Object.values(this.players)) if (q.alive && !q.escaped && q.team !== p.team) out.push(q);
    return out;
  }

  skill(p, rot) {
    if (p.skillCd > 0) return;
    const c = CLASSES[p.cls], s = c.skill;
    p.skillCd = s.cd; p.rot = rot;
    this.act(p, s.anim);
    if (p.cls === 'knight') p.block = s.dur;
    else if (p.cls === 'rogue') { p.stealth = s.dur; this.events.push({ e: 'fx', k: 'smoke', x: p.x, z: p.z }); }
    else if (p.cls === 'mage') {
      const sx = p.x, sz = p.z;
      const dx = Math.sin(rot), dz = Math.cos(rot);
      let x = p.x, z = p.z;
      for (let d = 0.25; d <= s.dist; d += 0.25) {
        const nx = p.x + dx * d, nz = p.z + dz * d;
        if (!free(this.map, nx, nz)) break;
        x = nx; z = nz;
      }
      p.x = x; p.z = z; p.fix = true;
      this.events.push({ e: 'fx', k: 'blink', x: sx, z: sz }, { e: 'fx', k: 'blink', x, z });
    } else if (p.cls === 'barbarian') {
      this.pending.push({ at: this.t + s.hitDelay, fn: () => { if (p.alive) this.melee(p, s.radius, 7, s.dmg); } });
    }
  }

  potion(p) {
    if (p.potions <= 0 || p.potCd > 0 || p.hp >= p.maxHp) return;
    p.potions--; p.potCd = 1.2;
    p.hp = Math.min(p.maxHp, p.hp + POTION_HEAL);
    this.act(p, 'Use_Item');
    this.events.push({ e: 'heal', id: p.id, v: POTION_HEAL });
  }

  // ---------- 피해 ----------
  hurt(t, dmg, src) {
    const isPlayer = !!t.cls;
    if (isPlayer) {
      if (t.block > 0) dmg = Math.round(dmg * 0.35);
      t.stealth = 0;
    }
    const crit = !isPlayer && src && src.cls && this.R() < 0.15;
    if (crit) dmg = Math.round(dmg * 1.6);
    t.hp -= dmg;
    this.events.push({ e: 'hit', id: t.id, mob: !isPlayer, dmg, crit, x: t.x, z: t.z });
    if (!isPlayer && src && src.cls && !t.target) t.target = src.id;
    if (t.hp > 0) {
      if (!isPlayer && t.a !== MOBS[t.ty].anim.attack) this.act(t, 'Hit_A');
      return;
    }
    t.hp = 0;
    if (isPlayer) this.killPlayer(t, src);
    else {
      t.dead = this.t; this.act(t, 'Death_A');
      if (src && src.cls) {
        const [a, b] = MOBS[t.ty].gold;
        const g = a + Math.floor(this.R() * (b - a + 1));
        src.gold += g;
        this.events.push({ e: 'gold', id: src.id, v: g, x: t.x, z: t.z });
      }
    }
  }

  killPlayer(p, src, why) {
    p.alive = false; p.ch = null;
    this.act(p, 'Death_A');
    if (p.items.length || p.gold) {
      this.bags.push({ id: this.nextId++, x: p.x, z: p.z, name: p.name, items: p.items, gold: p.gold });
    }
    p.items = []; p.gold = 0;
    if (why) this.feed(why, 'r');
    else if (src && src.cls) { src.kills++; this.feed(`${src.name} → ${p.name} 처치`, 'r'); }
    else if (src && src.ty) this.feed(`${p.name} 님이 ${MOBS[src.ty].name}에게 쓰러졌어요`, 'r');
    else this.feed(`${p.name} 님이 저주의 안개에 삼켜졌어요`, 'v');
  }

  rollLoot(gold) {
    const out = [];
    const n = gold ? 3 : 1 + Math.floor(this.R() * 2);
    for (let k = 0; k < n; k++) {
      // 황금 상자는 좋은 등급 가중치가 커요
      const ws = RARITY.map((r, i) => r.w * (gold ? [0.3, 1.2, 2.2, 3.5][i] : 1));
      let w = this.R() * ws.reduce((a, b) => a + b), ri = 0;
      while (ri < ws.length - 1 && w >= ws[ri]) { w -= ws[ri]; ri++; }
      const base = LOOT[Math.floor(this.R() * LOOT.length)];
      out.push({ name: base.name, icon: base.icon, r: ri, v: Math.round(base.v * RARITY[ri].mul * (0.8 + this.R() * 0.4)) });
    }
    return { items: out, gold: (gold ? 60 : 15) + Math.floor(this.R() * (gold ? 80 : 30)) };
  }

  // ---------- 진행 ----------
  step() {
    const dt = TICK;
    this.t += dt;
    const t = this.t;

    for (let k = this.pending.length - 1; k >= 0; k--) {
      if (this.pending[k].at <= t) { const f = this.pending[k].fn; this.pending.splice(k, 1); f(); }
    }

    // 안개
    const fk = Math.min(1, Math.max(0, (t - FOG_START) / (FOG_END - FOG_START)));
    this.fog.r = this.fog.r0 + (this.fog.r1 - this.fog.r0) * (1 - (1 - fk) * (1 - fk));
    for (const pl of this.portalPlan) {
      if (!pl.done && t >= pl.at) {
        pl.done = true;
        this.portals.push({ id: this.nextId++, x: pl.x, z: pl.z });
        this.feed('어딘가에 탈출 포털이 열렸어요', 'c');
        this.events.push({ e: 'portal' });
      }
    }

    for (const p of Object.values(this.players)) {
      if (!p.alive || p.escaped) continue;
      p.atkCd = Math.max(0, p.atkCd - dt);
      p.skillCd = Math.max(0, p.skillCd - dt);
      p.potCd = Math.max(0, p.potCd - dt);
      p.block = Math.max(0, p.block - dt);
      p.stealth = Math.max(0, p.stealth - dt);
      // 안개 피해
      const out = Math.hypot(p.x - this.fog.cx, p.z - this.fog.cz) > this.fog.r;
      if (out) {
        p.outSince += dt;
        if (p.outSince >= 1) { p.outSince = 0; this.hurt(p, Math.round(4 + fk * 10), null); if (!p.alive) continue; }
      } else p.outSince = 0;
      if (t >= MATCH_TIME) { p.hp = 0; this.killPlayer(p, null); continue; }
      this.interact(p, dt);
    }

    this.stepMobs(dt);
    this.stepProjs(dt);
    this.mobs = this.mobs.filter(m => !m.dead || t - m.dead < 4);

    const live = Object.values(this.players).filter(p => p.alive && !p.escaped);
    if (!live.length && !this.over) { this.over = true; this.events.push({ e: 'over' }); }
  }

  interact(p, dt) {
    // 포털: 서 있기만 하면 2초 뒤 탈출
    const portal = this.portals.find(o => dist2(p, o) < 1.6 * 1.6);
    if (portal) {
      if (!p.ch || p.ch.k !== 'portal') p.ch = { k: 'portal', t: 0, need: 2, id: portal.id };
      p.ch.t += dt;
      if (p.ch.t >= p.ch.need) {
        p.escaped = true; p.ch = null;
        this.feed(`${p.name} 님이 탈출했어요`, 'g');
        this.events.push({ e: 'escape', id: p.id });
      }
      return;
    }
    if (!p.hold || p.moving) { p.ch = null; return; }
    if (!p.ch) {
      const chest = this.chests.find(c => !c.opened && dist2(p, c) < 2.6 * 2.6);
      const bag = this.bags.find(b => dist2(p, b) < 2.2 * 2.2);
      if (chest) p.ch = { k: 'chest', t: 0, need: chest.gold ? 2.2 : 1.4, id: chest.id };
      else if (bag) p.ch = { k: 'bag', t: 0, need: 1.0, id: bag.id };
      else return;
      this.act(p, 'Interact');
    }
    p.ch.t += dt;
    if (p.ch.t < p.ch.need) return;
    const ch = p.ch; p.ch = null;
    if (ch.k === 'chest') {
      const c = this.chests.find(c => c.id === ch.id);
      if (!c || c.opened) return;
      c.opened = true;
      const l = this.rollLoot(c.gold);
      p.items.push(...l.items); p.gold += l.gold;
      this.events.push({ e: 'loot', id: p.id, items: l.items, gold: l.gold, x: c.x, z: c.z });
      const best = l.items.reduce((a, b) => (b.r > a.r ? b : a));
      if (best.r >= 2) this.feed(`${p.name} 님이 ${RARITY[best.r].name} · ${best.name} 획득`, 'y');
    } else {
      const k = this.bags.findIndex(b => b.id === ch.id);
      if (k < 0) return;
      const b = this.bags[k];
      this.bags.splice(k, 1);
      p.items.push(...b.items); p.gold += b.gold;
      this.events.push({ e: 'loot', id: p.id, items: b.items, gold: b.gold, x: b.x, z: b.z });
    }
  }

  stepMobs(dt) {
    const players = Object.values(this.players).filter(p => p.alive && !p.escaped);
    for (const m of this.mobs) {
      if (m.dead) continue;
      const d = MOBS[m.ty];
      m.cd = Math.max(0, m.cd - dt);
      m.moving = false;
      let tgt = m.target && this.players[m.target];
      if (tgt && (!tgt.alive || tgt.escaped || tgt.stealth > 0 || dist2(m, tgt) > (d.sight * 1.8) ** 2)) tgt = null;
      if (!tgt) {
        let best = d.sight * d.sight;
        for (const p of players) {
          if (p.stealth > 0) continue;
          const dd = dist2(m, p);
          if (dd < best) { best = dd; tgt = p; }
        }
      }
      m.target = tgt ? tgt.id : null;
      const home = { x: m.hx, z: m.hz };
      if (tgt && dist2(m, home) > 24 * 24) { m.target = null; tgt = null; }
      if (m.attacking) continue;

      const goal = tgt || (dist2(m, home) > 1 ? home : null);
      if (!goal) continue;
      const dd = Math.sqrt(dist2(m, goal));
      if (tgt) m.rot = Math.atan2(goal.x - m.x, goal.z - m.z);
      if (tgt && dd <= d.range && (!d.ranged || this.losClear(m, tgt))) {
        if (m.cd <= 0) {
          m.cd = d.cd; m.attacking = true;
          this.act(m, d.anim.attack);
          this.pending.push({ at: this.t + d.hitDelay, fn: () => {
            m.attacking = false;
            if (m.dead) return;
            const q = this.players[m.target];
            if (!q || !q.alive || q.escaped) return;
            if (d.ranged) {
              const r = Math.atan2(q.x - m.x, q.z - m.z);
              this.projs.push({ id: this.nextId++, k: 'dark', x: m.x + Math.sin(r) * .6, z: m.z + Math.cos(r) * .6, vx: Math.sin(r) * 10, vz: Math.cos(r) * 10, life: 1.2, dmg: d.dmg, owner: m.id, mob: true });
            } else if (dist2(m, q) < (d.range + 0.7) ** 2) this.hurt(q, d.dmg, m);
          } });
        }
        continue;
      }
      // 이동: 같은 칸/옆 칸이면 직진, 아니면 BFS 다음 칸
      let wx = goal.x, wz = goal.z;
      const mi = cellOf(m.x), mj = cellOf(m.z), gi = cellOf(goal.x), gj = cellOf(goal.z);
      if (Math.abs(mi - gi) + Math.abs(mj - gj) > 1) {
        if (!m.path || this.t - m.pathT > 0.5) { m.path = nextCell(this.map, mi, mj, gi, gj); m.pathT = this.t; }
        if (m.path) { wx = m.path[0] * T; wz = m.path[1] * T; }
      }
      const ang = Math.atan2(wx - m.x, wz - m.z);
      const sp = d.speed * (tgt ? 1 : 0.8) * dt;
      const [nx, nz] = slide(this.map, m.x, m.z, Math.sin(ang) * sp, Math.cos(ang) * sp, 0.45);
      if (nx !== m.x || nz !== m.z) { m.x = nx; m.z = nz; m.moving = true; m.rot = ang; }
    }
  }

  losClear(a, b) {
    const n = Math.ceil(Math.sqrt(dist2(a, b)) / 0.8);
    for (let k = 1; k < n; k++) {
      const x = a.x + (b.x - a.x) * k / n, z = a.z + (b.z - a.z) * k / n;
      if (!this.map.floor(cellOf(x), cellOf(z))) return false;
    }
    return true;
  }

  stepProjs(dt) {
    for (const pr of this.projs) {
      pr.x += pr.vx * dt; pr.z += pr.vz * dt; pr.life -= dt;
      if (!this.map.floor(cellOf(pr.x), cellOf(pr.z))) { pr.life = 0; continue; }
      const list = pr.mob
        ? Object.values(this.players).filter(p => p.alive && !p.escaped)
        : this.targets(this.players[pr.owner] || { team: -1 });
      for (const t of list) {
        if (dist2(pr, t) < 0.9 * 0.9) {
          this.hurt(t, pr.dmg, pr.mob ? this.mobs.find(m => m.id === pr.owner) : this.players[pr.owner]);
          pr.life = 0;
          this.events.push({ e: 'fx', k: pr.k === 'fire' ? 'boom' : 'darkboom', x: pr.x, z: pr.z });
          break;
        }
      }
    }
    this.projs = this.projs.filter(p => p.life > 0);
  }

  // ---------- 스냅샷 ----------
  snapshot(forId) {
    const r1 = v => Math.round(v * 100) / 100;
    const s = {
      t: 'snap', time: r1(this.t),
      fog: [r1(this.fog.cx), r1(this.fog.cz), r1(this.fog.r)],
      p: Object.values(this.players).map(p => [p.id, r1(p.x), r1(p.z), r1(p.rot), Math.ceil(p.hp), p.maxHp,
        (p.alive ? 1 : 0) | (p.escaped ? 2 : 0) | (p.stealth > 0 ? 4 : 0) | (p.block > 0 ? 8 : 0) | (p.moving ? 16 : 0),
        p.a, p.aSeq, p.ch ? r1(p.ch.t / p.ch.need) : -1]),
      m: this.mobs.map(m => [m.id, m.ty, r1(m.x), r1(m.z), r1(m.rot), Math.ceil(m.hp), m.dead ? 1 : 0, m.a, m.aSeq, m.moving ? 1 : 0]),
      pr: this.projs.map(p => [p.id, p.k, r1(p.x), r1(p.z)]),
      ch: this.chests.filter(c => c.opened).map(c => c.id),
      bg: this.bags.map(b => [b.id, r1(b.x), r1(b.z), b.name]),
      po: this.portals.map(o => [o.id, r1(o.x), r1(o.z)]),
      ev: this.events,
    };
    const me = this.players[forId];
    if (me) {
      s.me = { hp: me.hp, gold: me.gold, items: me.items, potions: me.potions, atkCd: r1(me.atkCd), skillCd: r1(me.skillCd), kills: me.kills,
        ch: me.ch ? me.ch.k : null };
      if (me.fix) { s.me.fix = [r1(me.x), r1(me.z)]; }
    }
    return s;
  }
  clearFrame() {
    this.events = [];
    for (const p of Object.values(this.players)) p.fix = false;
  }
  results() {
    return Object.values(this.players).map(p => ({ id: p.id, name: p.name, cls: p.cls, team: p.team, escaped: p.escaped, kills: p.kills,
      gold: p.escaped ? p.gold : 0, value: p.escaped ? p.items.reduce((a, b) => a + b.v, 0) + p.gold : 0, items: p.escaped ? p.items : [] }));
  }
}
