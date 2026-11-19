// 던전 생성 + 충돌 (시드가 같으면 모두 같은 맵)
import { T, PLAYER_R } from './data.js';

export function rng(seed) {
  let s = seed | 0;
  return () => {
    s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const GW = 4, GH = 4, SLOT = 7;

export function genMap(seed) {
  const R = rng(seed);
  const ri = (a, b) => a + Math.floor(R() * (b - a + 1));
  const W = GW * SLOT, H = GH * SLOT;
  const grid = new Uint8Array(W * H);       // 0 벽, 1 방, 2 복도
  const set = (i, j, v) => { if (!grid[j * W + i] || v === 1) grid[j * W + i] = v; };

  const rooms = [];
  for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
    const w = ri(3, 5), h = ri(3, 5);
    const x0 = gx * SLOT + 1 + ri(0, SLOT - 2 - w), y0 = gy * SLOT + 1 + ri(0, SLOT - 2 - h);
    for (let j = y0; j < y0 + h; j++) for (let i = x0; i < x0 + w; i++) set(i, j, 1);
    rooms.push({ id: rooms.length, gx, gy, x0, y0, w, h, cx: x0 + (w >> 1), cy: y0 + (h >> 1) });
  }
  const at = (gx, gy) => rooms[gy * GW + gx];

  // 신장 트리(DFS) + 추가 고리
  const seen = new Set([0]), stack = [rooms[0]], links = [];
  while (stack.length) {
    const r = stack[stack.length - 1];
    const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]]
      .map(([dx, dy]) => [r.gx + dx, r.gy + dy])
      .filter(([x, y]) => x >= 0 && y >= 0 && x < GW && y < GH && !seen.has(y * GW + x));
    if (!nb.length) { stack.pop(); continue; }
    const [x, y] = nb[Math.floor(R() * nb.length)];
    const n = at(x, y);
    seen.add(n.id); links.push([r, n]); stack.push(n);
  }
  for (let k = 0; k < 5; k++) {
    const a = rooms[ri(0, rooms.length - 1)];
    const dirs = [[1, 0], [0, 1]].filter(([dx, dy]) => a.gx + dx < GW && a.gy + dy < GH);
    if (!dirs.length) continue;
    const [dx, dy] = dirs[ri(0, dirs.length - 1)];
    links.push([a, at(a.gx + dx, a.gy + dy)]);
  }
  for (const [a, b] of links) {
    let i = a.cx, j = a.cy;
    const horizFirst = a.gy === b.gy;
    const step = () => set(i, j, 2);
    if (horizFirst) {
      while (i !== b.cx) { i += Math.sign(b.cx - i); step(); }
      while (j !== b.cy) { j += Math.sign(b.cy - j); step(); }
    } else {
      while (j !== b.cy) { j += Math.sign(b.cy - j); step(); }
      while (i !== b.cx) { i += Math.sign(b.cx - i); step(); }
    }
  }

  const map = { seed, W, H, grid, rooms, obstacles: [], decor: [], torches: [], chests: [] };
  const floor = (i, j) => i >= 0 && j >= 0 && i < W && j < H && grid[j * W + i] > 0;
  map.floor = floor;

  // 스폰 방: 네 귀퉁이
  const corners = [at(0, 0), at(GW - 1, GH - 1), at(GW - 1, 0), at(0, GH - 1)];
  corners.forEach(r => r.spawn = true);
  map.spawnRooms = corners;

  const occupied = new Set();
  const key = (i, j) => i + ',' + j;
  const props = ['barrel_large', 'barrel_small_stack', 'crates_stacked', 'box_large', 'keg', 'trunk_large_A', 'barrel_large_decorated'];

  for (const r of rooms) {
    // 횃불: 북쪽 벽이 막힌 칸에 1~2개
    const north = [];
    for (let i = r.x0; i < r.x0 + r.w; i++) if (!floor(i, r.y0 - 1)) north.push(i);
    for (let k = 0; k < Math.min(2, north.length); k++) {
      const i = north[Math.floor(R() * north.length)];
      if (map.torches.some(t => t.i === i && t.j === r.y0)) continue;
      map.torches.push({ i, j: r.y0, x: i * T, z: r.y0 * T - T / 2 + 0.5 });
    }
    if (north.length > 2 && R() < 0.7) {
      const i = north[Math.floor(R() * north.length)];
      map.decor.push({ name: R() < 0.5 ? 'banner_patternA_red' : 'banner_patternC_red', x: i * T + (R() < .5 ? -1 : 1), z: r.y0 * T - T / 2, rot: 0, solid: 0 });
    }
    // 큰 방은 기둥
    if (r.w >= 5 && r.h >= 4) {
      for (const [i, j] of [[r.x0 + 1, r.y0 + 1], [r.x0 + r.w - 2, r.y0 + r.h - 2]]) {
        map.decor.push({ name: R() < .5 ? 'pillar' : 'pillar_decorated', x: i * T + T / 2, z: j * T + T / 2, rot: 0, solid: 0.85 });
      }
    }
    // 구석 소품
    const cornersCells = [[r.x0, r.y0, -1, -1], [r.x0 + r.w - 1, r.y0, 1, -1], [r.x0, r.y0 + r.h - 1, -1, 1], [r.x0 + r.w - 1, r.y0 + r.h - 1, 1, 1]];
    for (const [i, j, sx, sz] of cornersCells) {
      if (R() < 0.45) continue;
      if (floor(i + sx, j) || floor(i, j + sz)) continue;
      occupied.add(key(i, j));
      map.decor.push({ name: props[Math.floor(R() * props.length)], x: i * T + sx * 1.1, z: j * T + sz * 1.1, rot: R() * 6.28, solid: 0.9 });
    }
    // 상자
    if (!r.spawn && R() < 0.8) {
      const cand = [];
      for (let i = r.x0; i < r.x0 + r.w; i++) if (!floor(i, r.y0 - 1) && !occupied.has(key(i, r.y0))) cand.push(i);
      if (cand.length) {
        const i = cand[Math.floor(R() * cand.length)];
        occupied.add(key(i, r.y0));
        map.chests.push({ id: map.chests.length, x: i * T, z: r.y0 * T - 0.6, rot: 0, gold: R() < 0.18 });
      }
    }
    // 장식 테이블
    if (r.w * r.h >= 12 && R() < 0.5) {
      map.decor.push({ name: R() < .5 ? 'table_long_broken' : 'table_medium_decorated_A', x: r.cx * T, z: r.cy * T + 1, rot: R() < .5 ? 0 : Math.PI / 2, solid: 1.1 });
      map.decor.push({ name: 'candle_triple', x: r.cx * T, z: r.cy * T + 1, rot: 0, y: 1.05, solid: 0, light: true });
    }
  }
  map.obstacles = map.decor.filter(d => d.solid > 0).map(d => ({ x: d.x, z: d.z, r: d.solid }))
    .concat(map.chests.map(c => ({ x: c.x, z: c.z, r: 0.85 })));
  return map;
}

export const cellOf = x => Math.floor((x + T / 2) / T);

// 반지름 r 원이 서 있을 수 있는 자리인지
export function free(map, x, z, r = PLAYER_R) {
  for (const [dx, dz] of [[-r, -r], [r, -r], [-r, r], [r, r]]) {
    if (!map.floor(cellOf(x + dx), cellOf(z + dz))) return false;
  }
  for (const o of map.obstacles) {
    const ex = x - o.x, ez = z - o.z, rr = o.r + r;
    if (ex * ex + ez * ez < rr * rr) return false;
  }
  return true;
}

// 미끄러지듯 이동 (벽에 비비면 축 하나로)
export function slide(map, x, z, dx, dz, r = PLAYER_R) {
  if (free(map, x + dx, z + dz, r)) return [x + dx, z + dz];
  if (free(map, x + dx, z, r)) return [x + dx, z];
  if (free(map, x, z + dz, r)) return [x, z + dz];
  return [x, z];
}

// 칸 단위 BFS: from 칸에서 to 칸으로 가는 첫 걸음 칸
export function nextCell(map, fi, fj, ti, tj) {
  if (fi === ti && fj === tj) return null;
  const W = map.W, prev = new Int32Array(W * map.H).fill(-1);
  const start = fj * W + fi, goal = tj * W + ti;
  const q = [start]; prev[start] = start;
  for (let h = 0; h < q.length; h++) {
    const c = q[h];
    if (c === goal) break;
    const ci = c % W, cj = (c / W) | 0;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = ci + di, nj = cj + dj;
      if (!map.floor(ni, nj)) continue;
      const n = nj * W + ni;
      if (prev[n] !== -1) continue;
      prev[n] = c; q.push(n);
    }
  }
  if (prev[goal] === -1) return null;
  let c = goal;
  while (prev[c] !== start) c = prev[c];
  return [c % W, (c / W) | 0];
}

export function randomFloorIn(map, room, R) {
  for (let k = 0; k < 30; k++) {
    const x = (room.x0 + R() * (room.w - 1)) * T, z = (room.y0 + R() * (room.h - 1)) * T;
    if (free(map, x, z, 0.8)) return [x, z];
  }
  return [room.cx * T, room.cy * T];
}

// 두 점 사이가 벽에 막히지 않았는지 (칸 단위로 0.5m씩 확인)
export function los(map, x0, z0, x1, z1) {
  const d = Math.hypot(x1 - x0, z1 - z0), n = Math.ceil(d / 0.5);
  for (let k = 1; k < n; k++) {
    const f = k / n;
    if (!map.floor(cellOf(x0 + (x1 - x0) * f), cellOf(z0 + (z1 - z0) * f))) return false;
  }
  return true;
}
