// three.js 3D 화면: 맵 구성, 캐릭터/몬스터 애니메이션, 조명, 이펙트
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { T, CLASSES, MOBS } from './data.js';

const loader = new GLTFLoader();
const cache = {};
export function loadModel(url) {
  if (!cache[url]) cache[url] = loader.loadAsync('assets/' + url);
  return cache[url];
}
const propUrl = name => (name.startsWith('chest') ? `m/${name}.glb` : `m/${name}.gltf.glb`);

function shade(obj, cast = true) {
  obj.traverse(o => { if (o.isMesh) { o.castShadow = cast; o.receiveShadow = true; } });
  return obj;
}

const WEAPON_RE = /sword|shield|axe|mug|spellbook|wand|staff|crossbow|knife|throwable/i;
const LIGHTS = 8, PLAYER_LIGHTS = 3, PORTAL_LIGHTS = 3;
const INTERP_MS = 110, CHUNK = 16, ANIM_RANGE = 34;

// 원형 그라데이션 텍스처 (이펙트/글로우)
function glowTex(stops) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  stops.forEach(([o, col]) => grd.addColorStop(o, col));
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

class Actor {
  constructor(world, gltf, opt) {
    this.world = world;
    this.o = shade(SkeletonUtils.clone(gltf.scene));
    this.mats = [];
    this.o.traverse(m => {
      if (!m.isMesh) return;
      if (WEAPON_RE.test(m.name)) m.visible = (opt.keep || []).includes(m.name);
      m.material = m.material.clone();
      m.material.transparent = true;
      this.mats.push(m.material);
    });
    this.mixer = new THREE.AnimationMixer(this.o);
    this.clips = gltf.animations;
    this.actions = {};
    this.loco = '';
    this.oneShot = null;
    this.dead = false;
    this.opacity = 1;
    this.anim = opt.anim || {};
    this.mixer.addEventListener('finished', e => {
      if (e.action === this.oneShot && !this.dead) { this.oneShot = null; this.setLoco(this.loco, true); }
    });
    world.scene.add(this.o);
  }
  action(name) {
    const clip = this.clips.find(c => c.name === name) || this.clips.find(c => c.name.startsWith(name)) || this.clips.find(c => c.name === 'Idle');
    if (!clip) return null;
    return this.actions[clip.name] || (this.actions[clip.name] = this.mixer.clipAction(clip));
  }
  fadeTo(act, fade = 0.15) {
    if (!act || act === this.cur) return;
    act.enabled = true;
    act.reset().setEffectiveWeight(1).fadeIn(fade).play();
    if (this.cur) this.cur.fadeOut(fade);
    this.cur = act;
  }
  setLoco(name, force) {
    if (this.loco === name && !force) return;
    this.loco = name;
    if (this.oneShot || this.dead) return;
    const a = this.action(name);
    if (a) { a.setLoop(THREE.LoopRepeat); this.fadeTo(a); }
  }
  once(name, speed = 1) {
    const a = this.action(name);
    if (!a) return;
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.timeScale = speed;
    this.oneShot = a;
    if (a === this.cur) a.reset().play();
    else this.fadeTo(a, 0.08);
  }
  die() {
    if (this.dead) return;
    this.once('Death_A');
    this.dead = true;
  }
  setOpacity(v) {
    if (Math.abs(v - this.opacity) < 0.01) return;
    this.opacity = v;
    for (const m of this.mats) { m.opacity = v; m.depthWrite = v > 0.9; }
    this.o.visible = v > 0.01;
  }
  // 스냅샷 보간용 버퍼: 조금 과거 시점을 두 스냅샷 사이에서 선형 보간해 부드럽게 보여줘요
  push(x, z, rot) {
    const b = this.buf || (this.buf = []);
    b.push({ t: performance.now(), x, z, rot });
    if (b.length > 12) b.shift();
  }
  sample(now) {
    const b = this.buf;
    if (!b || !b.length) return;
    const rt = now - INTERP_MS, p = this.o.position;
    let k = b.length - 1;
    while (k > 0 && b[k - 1].t > rt) k--;
    const B = b[k], A = b[k - 1];
    if (!A || rt >= B.t) { p.x = B.x; p.z = B.z; this.o.rotation.y = B.rot; return; }
    const f = Math.max(0, Math.min(1, (rt - A.t) / (B.t - A.t)));
    p.x = A.x + (B.x - A.x) * f;
    p.z = A.z + (B.z - A.z) * f;
    let d = B.rot - A.rot;
    while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
    this.o.rotation.y = A.rot + d * f;
  }
  remove() { this.world.scene.remove(this.o); }
}

export class World {
  constructor(canvas) {
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x030305);
    this.scene.fog = new THREE.FogExp2(0x050408, 0.024);
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.5, 200);
    this.camOff = new THREE.Vector3(0, 17, 13.5);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);
    this.fps = false;
    this.low = 0;
    this.vm = new THREE.Group();
    this.camera.add(this.vm);
    this.vmT = 9;
    this.bob = 0;
    this.scene.add(new THREE.HemisphereLight(0x5a6a9a, 0x140c08, 0.5));
    const moon = new THREE.DirectionalLight(0x6f7fc0, 0.3);
    moon.position.set(-10, 30, 10);
    this.scene.add(moon);

    this.composer = new EffectComposer(r);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.45, 0.9);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    // 고정 개수 조명 풀 (조명 개수가 바뀌면 셰이더가 다시 컴파일돼서 끊겨요)
    this.torchLights = [];
    for (let k = 0; k < LIGHTS; k++) {
      const l = new THREE.PointLight(0xff7a2a, 0, 15, 1.6);
      this.scene.add(l); this.torchLights.push(l);
    }
    this.lantern = new THREE.PointLight(0xffb070, 22, 14, 1.4);
    this.lantern.castShadow = true;
    this.lantern.shadow.mapSize.set(1024, 1024);
    this.lantern.shadow.bias = -0.003;
    this.lantern.shadow.camera.far = 16;
    this.scene.add(this.lantern);
    this.otherLights = [];
    for (let k = 0; k < PLAYER_LIGHTS; k++) {
      const l = new THREE.PointLight(0xffa860, 0, 10, 1.5);
      this.scene.add(l); this.otherLights.push(l);
    }
    this.portalLights = [];
    for (let k = 0; k < PORTAL_LIGHTS; k++) {
      const l = new THREE.PointLight(0x4cc8ff, 0, 13, 1.6);
      this.scene.add(l); this.portalLights.push(l);
    }

    this.players = new Map();
    this.mobs = new Map();
    this.projs = new Map();
    this.bags = new Map();
    this.portals = new Map();
    this.fx = [];
    this.raycaster = new THREE.Raycaster();
    this.ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.tex = {
      fire: glowTex([[0, 'rgba(255,240,200,1)'], [.3, 'rgba(255,150,40,.9)'], [1, 'rgba(120,20,0,0)']]),
      dark: glowTex([[0, 'rgba(240,200,255,1)'], [.3, 'rgba(160,60,255,.85)'], [1, 'rgba(40,0,80,0)']]),
      smoke: glowTex([[0, 'rgba(150,150,160,.8)'], [1, 'rgba(60,60,70,0)']]),
      blink: glowTex([[0, 'rgba(220,250,255,1)'], [.4, 'rgba(90,200,255,.7)'], [1, 'rgba(0,40,120,0)']]),
      gold: glowTex([[0, 'rgba(255,240,180,.9)'], [1, 'rgba(255,180,40,0)']]),
    };
    addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  async prop(name, x, z, rot = 0, y = 0, cast = true, parent = this.statics) {
    const g = await loadModel(propUrl(name));
    const o = shade(g.scene.clone(), cast);
    o.position.set(x, y, z);
    o.rotation.y = rot;
    parent.add(o);
    return o;
  }

  // 고정 소품들을 16m 구역 × 재질별로 합쳐서 그리기 호출을 줄여요
  mergeStatic(src, dst) {
    src.updateMatrixWorld(true);
    const buckets = new Map(), mats = new Map();
    for (const root of src.children) {
      const ck = Math.floor(root.position.x / CHUNK) + ',' + Math.floor(root.position.z / CHUNK);
      root.traverse(m => {
        if (!m.isMesh || Array.isArray(m.material)) return;
        const mk = m.material.name + '|' + (m.material.map ? m.material.map.image.width : 0);
        if (!mats.has(mk)) mats.set(mk, m.material);
        let g = m.geometry.clone().applyMatrix4(m.matrixWorld);
        for (const a of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(a)) g.deleteAttribute(a);
        if (!g.attributes.uv || !g.attributes.normal) return;
        if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
        const key = ck + '|' + mk + '|' + m.castShadow;
        if (!buckets.has(key)) buckets.set(key, { mat: mats.get(mk), cast: m.castShadow, geos: [] });
        buckets.get(key).geos.push(g);
      });
    }
    for (const b of buckets.values()) {
      const mesh = new THREE.Mesh(mergeGeometries(b.geos), b.mat);
      mesh.castShadow = b.cast; mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      dst.add(mesh);
      b.geos.forEach(g => g.dispose());
    }
  }

  async build(map) {
    if (this.level) this.scene.remove(this.level);
    this.level = new THREE.Group();
    this.scene.add(this.level);
    this.statics = new THREE.Group();
    this.southSrc = new THREE.Group();
    this.south = new THREE.Group();
    this.level.add(this.south);
    this.map = map;
    const jobs = [];
    const { W, H, grid, floor } = map;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const v = grid[j * W + i];
      if (!v) continue;
      const x = i * T, z = j * T, h = (i * 73856093 ^ j * 19349663) >>> 0;
      let f = v === 2 ? 'floor_dirt_large' : (h % 13 === 0 ? 'floor_tile_large_rocks' : 'floor_tile_large');
      if (v === 1 && h % 23 === 0) f = 'floor_tile_big_grate';
      jobs.push(this.prop(f, x, z, f === 'floor_tile_big_grate' ? 0 : (h % 4) * Math.PI / 2, 0, false));
      if (!floor(i, j - 1)) jobs.push(this.prop(h % 7 === 3 ? 'wall_cracked' : 'wall', x, z - T / 2, 0));
      if (!floor(i - 1, j)) jobs.push(this.prop('wall', x - T / 2, z, Math.PI / 2));
      if (!floor(i + 1, j)) jobs.push(this.prop('wall', x + T / 2, z, -Math.PI / 2));
      // 남쪽 벽은 위에서 내려다볼 땐 시야를 가려서 1인칭일 때만 보여요
      if (!floor(i, j + 1)) jobs.push(this.prop('wall', x, z + T / 2, Math.PI, 0, true, this.southSrc));
    }
    this.torches = [];
    for (const t of map.torches) {
      jobs.push(this.prop('torch_mounted', t.x, t.z, 0, 1.6, false));
      this.torches.push({ x: t.x, y: 2.6, z: t.z + 0.55, power: 50, color: 0xff7a2a, seed: Math.random() * 100 });
      const g = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffc070 }));
      g.position.set(t.x, 2.6, t.z + 0.55);
      this.level.add(g);
    }
    for (const d of map.decor) {
      jobs.push(this.prop(d.name, d.x, d.z, d.rot, d.y || 0));
      if (d.light) this.torches.push({ x: d.x, y: 2.3, z: d.z, power: 8, color: 0xffa040, seed: Math.random() * 100 });
    }
    this.chests = new Map();
    for (const c of map.chests) {
      jobs.push(this.prop(c.gold ? 'chest_gold' : 'chest', c.x, c.z, c.rot, 0, true, this.level).then(o => {
        let lid; o.traverse(n => { if (/lid/.test(n.name)) lid = n; });
        const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex.gold, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: c.gold ? .55 : .25 }));
        glow.position.set(c.x, 0.9, c.z + 0.3); glow.scale.setScalar(c.gold ? 3 : 2);
        this.level.add(glow);
        this.chests.set(c.id, { o, lid, glow, opened: false });
      }));
    }
    await Promise.all(jobs);
    this.mergeStatic(this.statics, this.level);
    this.mergeStatic(this.southSrc, this.south);
    this.statics = this.southSrc = null;
    this.makeCeiling(map);
    this.makeFogWall();
    this.setView(this.fps);
  }

  makeCeiling(map) {
    const geos = [];
    for (let j = 0; j < map.H; j++) for (let i = 0; i < map.W; i++) {
      if (!map.grid[j * map.W + i]) continue;
      const g = new THREE.PlaneGeometry(T, T);
      g.rotateX(Math.PI / 2);
      g.translate(i * T, 4, j * T);
      geos.push(g);
    }
    this.ceiling = new THREE.Mesh(mergeGeometries(geos), new THREE.MeshStandardMaterial({ color: 0x17130f, roughness: 1 }));
    this.level.add(this.ceiling);
  }

  // 1인칭 / 쿼터뷰 전환
  setView(fps) {
    this.fps = fps;
    if (this.south) this.south.visible = fps;
    if (this.ceiling) this.ceiling.visible = fps;
    this.vm.visible = fps;
    this.lantern.intensity = fps ? 9 : 22;
    this.camera.fov = fps ? 72 : 38;
    this.camera.near = fps ? 0.05 : 0.5;
    this.camera.updateProjectionMatrix();
    this.applyQuality();
  }

  // 느린 PC면 단계적으로 품질을 낮춰요 (0: 최고, 1: 그림자 끔·해상도 1배, 2: 블룸 끔·해상도 더 낮춤)
  setLow(level) {
    this.low = level;
    this.applyQuality();
  }
  applyQuality() {
    const shadows = !this.fps && this.low < 1;
    if (this.lantern.castShadow !== shadows) {
      this.lantern.castShadow = shadows;
      this.renderer.shadowMap.needsUpdate = true;
    }
    this.bloom.enabled = this.low < 2;
    const pr = this.low >= 2 ? 0.8 : Math.min(devicePixelRatio, this.low ? 1 : 1.5);
    if (this.renderer.getPixelRatio() !== pr) { this.renderer.setPixelRatio(pr); this.resize(); }
  }

  // 1인칭 손에 든 무기: [모델, 위치, 회전, 크기]
  async setViewModel(list) {
    this.vm.clear();
    for (const [url, pos, rot, sc] of list) {
      const o = (await loadModel(url)).scene.clone();
      o.traverse(m => { if (m.isMesh) { m.castShadow = false; m.frustumCulled = false; } });
      o.position.set(...pos); o.rotation.set(...rot); o.scale.setScalar(sc || 1);
      o.userData.base = { pos: o.position.clone(), rot: o.rotation.clone() };
      this.vm.add(o);
    }
  }
  swing() { this.vmT = 0; }

  makeFogWall() {
    const c = document.createElement('canvas'); c.width = 4; c.height = 128;
    const g = c.getContext('2d'), grd = g.createLinearGradient(0, 128, 0, 0);
    grd.addColorStop(0, 'rgba(170,90,255,.75)'); grd.addColorStop(.6, 'rgba(110,40,200,.25)'); grd.addColorStop(1, 'rgba(60,0,140,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 4, 128);
    const m = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
    this.fogWall = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 7, 96, 1, true), m);
    this.fogWall.position.y = 3.5;
    this.scene.add(this.fogWall);
  }

  // ---------- 엔티티 ----------
  async addPlayer(info, isMe) {
    const c = CLASSES[info.cls];
    const g = await loadModel(`c/${c.model}.glb`);
    const a = new Actor(this, g, { keep: c.keep });
    a.info = info; a.isMe = isMe;
    a.o.position.set(info.x ?? 0, 0, info.z ?? 0);
    a.tx = a.o.position.x; a.tz = a.o.position.z; a.trot = 0;
    a.setLoco('Idle');
    this.players.set(info.id, a);
    return a;
  }

  async addMob(id, ty, x, z) {
    const d = MOBS[ty];
    const g = await loadModel(`c/${d.model}.glb`);
    const a = new Actor(this, g, { anim: d.anim });
    a.o.position.set(x, 0, z);
    a.tx = x; a.tz = z; a.trot = 0; a.ty = ty;
    const w = (await loadModel(`sk/${d.weapon}.gltf`)).scene.clone();
    shade(w);
    let hand; a.o.traverse(b => { if (!hand && /handslot.?r/i.test(b.name)) hand = b; });
    (hand || a.o).add(w);
    a.setLoco(d.anim.idle);
    this.mobs.set(id, a);
    return a;
  }

  clearEntities() {
    for (const m of [this.players, this.mobs]) { for (const a of m.values()) a.remove(); m.clear(); }
    for (const m of [this.projs, this.bags, this.portals]) { for (const o of m.values()) this.scene.remove(o); m.clear(); }
  }

  makePortal(id, x, z) {
    const grp = new THREE.Group();
    grp.position.set(x, 0, z);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.35, 0.1, 12, 64), new THREE.MeshStandardMaterial({ color: 0x0a2030, emissive: 0x47d8ff, emissiveIntensity: 1.8 }));
    ring.position.y = 1.7;
    grp.add(ring);
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const g = c.getContext('2d'), grd = g.createRadialGradient(128, 128, 10, 128, 128, 128);
    grd.addColorStop(0, 'rgba(220,250,255,0.95)'); grd.addColorStop(.35, 'rgba(90,200,255,0.6)'); grd.addColorStop(.8, 'rgba(30,80,200,0.25)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 256, 256);
    g.strokeStyle = 'rgba(200,245,255,.35)'; g.lineWidth = 3;
    for (let k = 0; k < 7; k++) { g.beginPath(); g.arc(128, 128, 20 + k * 15, k, k + 3.5); g.stroke(); }
    const disc = new THREE.Mesh(new THREE.CircleGeometry(1.3, 48), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, opacity: .7, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    disc.position.y = 1.7;
    grp.add(disc);
    const base = new THREE.Mesh(new THREE.RingGeometry(0.6, 1.9, 48), new THREE.MeshBasicMaterial({ color: 0x3bb8ff, transparent: true, opacity: .35, blending: THREE.AdditiveBlending, depthWrite: false }));
    base.rotation.x = -Math.PI / 2; base.position.y = 0.08;
    grp.add(base);
    const n = 60, pos = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) { pos[k * 3] = (Math.random() - .5) * 3; pos[k * 3 + 1] = Math.random() * 3.5; pos[k * 3 + 2] = (Math.random() - .5); }
    const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const pts = new THREE.Points(pg, new THREE.PointsMaterial({ color: 0x9fe8ff, size: .09, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    grp.add(pts);
    grp.userData = { disc, pts, ring };
    this.scene.add(grp);
    this.portals.set(id, grp);
  }

  makeProj(id, k, x, z) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: k === 'fire' ? this.tex.fire : this.tex.dark, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    s.scale.setScalar(1.3);
    s.position.set(x, 1.5, z);
    s.userData.buf = [{ t: performance.now(), x, z }];
    this.scene.add(s);
    this.projs.set(id, s);
  }

  async makeBag(id, x, z) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    const o = (await loadModel(propUrl('coin_stack_small'))).scene.clone();
    g.add(o);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.5, 5, 16, 1, true), new THREE.MeshBasicMaterial({ color: 0xffc860, transparent: true, opacity: .22, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    beam.position.y = 2.5;
    g.add(beam);
    this.scene.add(g);
    this.bags.set(id, g);
  }

  effect(kind, x, z) {
    const tex = { boom: this.tex.fire, darkboom: this.tex.dark, smoke: this.tex.smoke, blink: this.tex.blink }[kind] || this.tex.fire;
    const n = kind === 'smoke' ? 7 : 1;
    for (let k = 0; k < n; k++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, blending: kind === 'smoke' ? THREE.NormalBlending : THREE.AdditiveBlending }));
      s.position.set(x + (n > 1 ? (Math.random() - .5) * 2 : 0), 1.2 + (n > 1 ? Math.random() : 0), z + (n > 1 ? (Math.random() - .5) * 2 : 0));
      this.scene.add(s);
      this.fx.push({ s, t: 0, life: kind === 'smoke' ? 1.4 : 0.45, grow: kind === 'smoke' ? 3 : 4 });
    }
  }

  openChest(id) {
    const c = this.chests && this.chests.get(id);
    if (!c || c.opened) return;
    c.opened = true;
    if (c.lid) c.lid.rotation.x = -1.9;
    c.glow.visible = false;
  }

  // 마우스 위치 → 바닥 좌표
  groundAt(mx, my) {
    const v = new THREE.Vector2(mx / innerWidth * 2 - 1, -(my / innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(v, this.camera);
    const p = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.ground, p) ? p : null;
  }

  // 화면 좌표 (DOM 라벨용)
  toScreen(x, y, z) {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    return { x: (v.x + 1) / 2 * innerWidth, y: (1 - v.y) / 2 * innerHeight, vis: v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1 };
  }

  update(dt, focus, fog) {
    const t = performance.now() / 1000;
    const now = performance.now();
    for (const m of [this.players, this.mobs]) for (const a of m.values()) {
      if (!a.isMe) a.sample(now);
      // 멀리 있는 캐릭터는 애니메이션 계산을 건너뛰어요
      const far = focus && (a.o.position.x - focus.x) ** 2 + (a.o.position.z - focus.z) ** 2 > ANIM_RANGE * ANIM_RANGE;
      if (far && !a.isMe) { a.skipDt = (a.skipDt || 0) + dt; continue; }
      a.mixer.update(dt + (a.skipDt || 0));
      a.skipDt = 0;
    }
    // 횃불 조명: 화면 중심에 가까운 것부터 풀 배정
    if (this.torches && focus) {
      const near = this.torches.map(tc => ({ tc, d: (tc.x - focus.x) ** 2 + (tc.z - focus.z) ** 2 })).sort((a, b) => a.d - b.d);
      this.torchLights.forEach((l, k) => {
        const n = near[k];
        if (!n) { l.intensity = 0; return; }
        const tc = n.tc;
        l.position.set(tc.x, tc.y, tc.z);
        l.color.setHex(tc.color);
        l.intensity = tc.power * (0.82 + 0.18 * Math.sin(t * 13 + tc.seed) * Math.sin(t * 7.3 + tc.seed * 2));
      });
    }
    // 다른 플레이어 등불
    const others = [...this.players.values()].filter(a => !a.isMe && !a.dead && a.o.visible && focus)
      .sort((a, b) => ((a.o.position.x - focus.x) ** 2 + (a.o.position.z - focus.z) ** 2) - ((b.o.position.x - focus.x) ** 2 + (b.o.position.z - focus.z) ** 2));
    this.otherLights.forEach((l, k) => {
      const a = others[k];
      l.intensity = a ? 12 * a.opacity : 0;
      if (a) l.position.set(a.o.position.x, 4.2, a.o.position.z + 0.8);
    });
    const ps = [...this.portals.values()];
    this.portalLights.forEach((l, k) => {
      const p = ps[k];
      l.intensity = p ? 28 : 0;
      if (p) l.position.set(p.position.x, 1.8, p.position.z);
    });
    for (const p of ps) {
      p.userData.disc.rotation.z = -t * 1.4;
      p.userData.ring.material.emissiveIntensity = 1.6 + Math.sin(t * 3) * .4;
      const pa = p.userData.pts.geometry.attributes.position;
      for (let k = 0; k < pa.count; k++) { let y = pa.getY(k) + dt * .9; if (y > 3.6) y = 0; pa.setY(k, y); }
      pa.needsUpdate = true;
    }
    // 투사체는 마지막 두 스냅샷의 속도로 앞질러 그려요
    for (const o of this.projs.values()) {
      const b = o.userData.buf;
      if (!b || b.length < 2) continue;
      if (b.length > 2) b.splice(0, b.length - 2);
      const [A, B] = b, span = B.t - A.t;
      if (span <= 0) continue;
      const f = Math.min(now - B.t, 70) / span;
      o.position.x = B.x + (B.x - A.x) * f;
      o.position.z = B.z + (B.z - A.z) * f;
    }
    for (const b of this.bags.values()) b.children[1].material.opacity = .16 + Math.sin(t * 3) * .08;
    for (let k = this.fx.length - 1; k >= 0; k--) {
      const f = this.fx[k]; f.t += dt;
      const p = f.t / f.life;
      f.s.scale.setScalar(0.5 + p * f.grow);
      f.s.material.opacity = 1 - p;
      if (p >= 1) { this.scene.remove(f.s); this.fx.splice(k, 1); }
    }
    if (fog && this.fogWall) {
      this.fogWall.position.x = fog[0]; this.fogWall.position.z = fog[1];
      this.fogWall.scale.set(fog[2], 1, fog[2]);
    }
    if (focus && this.fps) {
      this.bob += dt * (focus.moving ? 9 : 0);
      const by = focus.moving ? Math.sin(this.bob * 2) * 0.035 : 0;
      this.camera.position.set(focus.x, 1.62 + by, focus.z);
      this.camera.rotation.set(focus.pitch || 0, focus.rot + Math.PI, 0);
      this.lantern.position.set(focus.x - Math.sin(focus.rot) * 0.6, 2.4, focus.z - Math.cos(focus.rot) * 0.6);
      this.vmT += dt;
      const s = Math.min(1, this.vmT / 0.32), k = s < 1 ? Math.sin(s * Math.PI) : 0;
      for (const o of this.vm.children) {
        const b = o.userData.base;
        o.position.set(b.pos.x + Math.sin(this.bob) * 0.012 - k * 0.12, b.pos.y + by * 0.5 - k * 0.05, b.pos.z - k * 0.18);
        o.rotation.set(b.rot.x - k * 1.3, b.rot.y + k * 0.5, b.rot.z);
      }
    } else if (focus) {
      this.lantern.position.set(focus.x, 5, focus.z + 1.2);
      this.camera.position.set(focus.x + this.camOff.x, this.camOff.y, focus.z + this.camOff.z);
      this.camera.rotation.set(0, 0, 0);
      this.camera.lookAt(focus.x, 1, focus.z);
    }
    this.composer.render();
  }
}

// 아이템/초상화 아이콘: 실제 모델을 작게 렌더해 dataURL로
let iconR, iconScene, iconCam;
const iconCache = {};
export async function icon(url, rot = [0.3, 0.6, 0.4]) {
  const key = url + rot.join();
  if (iconCache[key]) return iconCache[key];
  if (!iconR) {
    iconR = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    iconR.setSize(116, 116);
    iconR.toneMapping = THREE.ACESFilmicToneMapping;
    iconScene = new THREE.Scene();
    iconScene.add(new THREE.HemisphereLight(0xffffff, 0x332211, 2.2));
    const d = new THREE.DirectionalLight(0xffe0b0, 2); d.position.set(2, 3, 4); iconScene.add(d);
    iconCam = new THREE.PerspectiveCamera(30, 1, .1, 50);
  }
  const o = (await loadModel(url)).scene.clone();
  o.rotation.set(...rot);
  const box = new THREE.Box3().setFromObject(o), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  o.position.sub(c);
  iconScene.add(o);
  iconCam.position.set(0, 0, Math.max(size.x, size.y, size.z) * 2.1);
  iconCam.lookAt(0, 0, 0);
  iconR.render(iconScene, iconCam);
  iconScene.remove(o);
  return (iconCache[key] = iconR.domElement.toDataURL());
}

export async function portrait(cls) {
  const key = 'portrait:' + cls;
  if (iconCache[key]) return iconCache[key];
  await icon('m/coin.gltf.glb');
  const c = CLASSES[cls];
  const k = SkeletonUtils.clone((await loadModel(`c/${c.model}.glb`)).scene);
  k.traverse(m => { if (m.isMesh && WEAPON_RE.test(m.name)) m.visible = false; });
  iconScene.add(k);
  iconCam.position.set(0.5, 2.0, 2.6);
  iconCam.lookAt(0, 1.75, 0);
  iconR.render(iconScene, iconCam);
  iconScene.remove(k);
  return (iconCache[key] = iconR.domElement.toDataURL());
}
