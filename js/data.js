// 게임 규칙 데이터 (호스트/클라이언트 공통)

export const T = 4;              // 맵 1칸 = 4m
export const TICK = 1 / 20;      // 호스트 시뮬레이션 간격
export const MATCH_TIME = 480;   // 한 판 8분
export const PORTAL_TIMES = [150, 300, 390];  // 포털이 열리는 시각(초)
export const FOG_START = 60;     // 안개 수축 시작
export const FOG_END = 420;      // 안개 최소 반경 도달
export const PLAYER_R = 0.55;

export const TEAMS = [
  { name: '붉은', color: '#e0544a' },
  { name: '푸른', color: '#4a8ee0' },
  { name: '초록', color: '#4fbf6a' },
  { name: '노란', color: '#e0c04a' },
];

export const CLASSES = {
  knight: {
    name: '기사', en: 'KNIGHT', model: 'Knight', keep: ['1H_Sword', 'Round_Shield'],
    hp: 120, speed: 5.2,
    desc: '단단한 방패. 방어 태세로 받는 피해를 크게 줄여요.',
    atk: { dmg: 22, range: 2.4, arc: 1.25, cd: 0.75, hitDelay: 0.28, anim: '1H_Melee_Attack_Slice_Diagonal' },
    skill: { name: '방어 태세', cd: 10, dur: 3, anim: 'Blocking', icon: 'it/shield_round.gltf' },
    weaponIcon: 'it/sword_1handed.gltf',
  },
  rogue: {
    name: '도적', en: 'ROGUE', model: 'Rogue_Hooded', keep: ['Knife', 'Knife_Offhand'],
    hp: 85, speed: 6.2,
    desc: '빠른 쌍단검. 은신으로 몬스터와 적의 눈을 피해요.',
    atk: { dmg: 14, range: 2.0, arc: 1.1, cd: 0.42, hitDelay: 0.16, anim: 'Dualwield_Melee_Attack_Stab' },
    skill: { name: '은신', cd: 16, dur: 5, anim: 'Interact', icon: 'it/smokebomb.gltf' },
    weaponIcon: 'it/dagger.gltf',
  },
  mage: {
    name: '마법사', en: 'MAGE', model: 'Mage', keep: ['2H_Staff'],
    hp: 75, speed: 5.0,
    desc: '멀리서 불덩이를 날려요. 점멸로 순식간에 빠져나가요.',
    atk: { dmg: 26, proj: true, pspeed: 17, life: 0.9, cd: 0.95, hitDelay: 0.3, anim: 'Spellcast_Shoot' },
    skill: { name: '점멸', cd: 8, dist: 7, anim: 'Spellcast_Raise', icon: 'it/spellbook_closed.gltf' },
    weaponIcon: 'it/staff.gltf',
  },
  barbarian: {
    name: '바바리안', en: 'BARBARIAN', model: 'Barbarian', keep: ['2H_Axe'],
    hp: 145, speed: 4.9,
    desc: '느리지만 한 방이 묵직해요. 회전베기로 주변을 쓸어버려요.',
    atk: { dmg: 34, range: 2.6, arc: 1.4, cd: 1.1, hitDelay: 0.42, anim: '2H_Melee_Attack_Chop' },
    skill: { name: '회전베기', cd: 8, radius: 3.4, dmg: 30, hitDelay: 0.35, anim: '2H_Melee_Attack_Spin', icon: 'it/axe_2handed.gltf' },
    weaponIcon: 'it/axe_2handed.gltf',
  },
};

export const MOBS = {
  minion: {
    name: '해골 병사', model: 'Skeleton_Minion', weapon: 'Skeleton_Axe',
    hp: 40, dmg: 8, speed: 3.3, range: 1.7, cd: 1.4, hitDelay: 0.45, sight: 9, gold: [6, 16],
    anim: { idle: 'Idle', walk: 'Walking_D_Skeletons', attack: '1H_Melee_Attack_Chop' },
  },
  warrior: {
    name: '해골 전사', model: 'Skeleton_Warrior', weapon: 'Skeleton_Blade',
    hp: 75, dmg: 13, speed: 3.0, range: 1.9, cd: 1.6, hitDelay: 0.5, sight: 9, gold: [14, 30],
    anim: { idle: 'Idle_Combat', walk: 'Walking_D_Skeletons', attack: '1H_Melee_Attack_Slice_Diagonal' },
  },
  rogue: {
    name: '해골 도적', model: 'Skeleton_Rogue', weapon: 'Skeleton_Blade',
    hp: 45, dmg: 10, speed: 4.3, range: 1.7, cd: 1.0, hitDelay: 0.3, sight: 10, gold: [10, 22],
    anim: { idle: 'Idle_B', walk: 'Running_C', attack: '1H_Melee_Attack_Stab' },
  },
  mage: {
    name: '해골 마법사', model: 'Skeleton_Mage', weapon: 'Skeleton_Staff',
    hp: 38, dmg: 14, speed: 2.6, range: 9, cd: 2.4, hitDelay: 0.55, sight: 11, gold: [16, 34], ranged: true,
    anim: { idle: 'Idle', walk: 'Walking_A', attack: 'Spellcast_Shoot' },
  },
};

export const RARITY = [
  { name: '일반', color: '#c9c2b2', w: 58, mul: 1 },
  { name: '희귀', color: '#5aa0ff', w: 28, mul: 3 },
  { name: '영웅', color: '#c46bff', w: 11, mul: 8 },
  { name: '전설', color: '#ffb340', w: 3, mul: 25 },
];

// 상자에서 나오는 전리품 (가치만 있는 보물)
export const LOOT = [
  { name: '녹슨 반지', v: 12, icon: 'm/coin.gltf.glb' },
  { name: '은 술잔', v: 18, icon: 'it/mug_full.gltf' },
  { name: '고대 열쇠', v: 22, icon: 'm/key.gltf.glb' },
  { name: '독약 병', v: 15, icon: 'm/bottle_A_green.gltf.glb' },
  { name: '의식용 단검', v: 30, icon: 'it/dagger.gltf' },
  { name: '금지된 마법서', v: 40, icon: 'it/spellbook_closed.gltf' },
  { name: '기사의 방패', v: 34, icon: 'it/shield_round.gltf' },
  { name: '그림자 단검', v: 28, icon: 'it/dagger.gltf' },
  { name: '옛 왕의 검', v: 45, icon: 'it/sword_1handed.gltf' },
];

export const POTION_HEAL = 45;
export const START_POTIONS = 2;
