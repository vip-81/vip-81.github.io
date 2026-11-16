/**
 * 捕魚機 Fish Shooting：物件池、魚群 AI、碰撞判定、砲台倍率
 * ---------------------------------------------------------------------------
 * 展示重點：
 * - 魚、子彈、粒子皆使用固定容量物件池，避免長局遊玩造成 GC 尖峰。
 * - 子彈使用「線段 vs 圓」碰撞，避免高速穿透（tunneling）。
 * - 小魚以簡化 boids（分離、對齊、凝聚）成群；大魚以正弦路徑巡航。
 * - 前端僅為娛樂展示；正式產品的魚群生成、命中與派彩須由伺服器結算。
 */

import { sfx, unlockAudio } from "../lib/audio.js";
import { formatCredits, loadJSON, saveJSON, clamp } from "../lib/storage.js";

const canvas = document.getElementById("fish-canvas");
const balanceEl = document.getElementById("fish-balance");
const costEl = document.getElementById("fish-cost");
const levelEl = document.getElementById("fish-level");
const accuracyEl = document.getElementById("fish-accuracy");
const killsEl = document.getElementById("fish-kills");
const statusEl = document.getElementById("fish-status");
const srEl = document.getElementById("fish-sr");
const autoBtn = document.getElementById("fish-auto");
const resetBtn = document.getElementById("fish-reset");
const levelButtons = [...document.querySelectorAll("[data-fish-level]")];

if (!canvas) {
  console.warn("[fish] 找不到 fish-canvas");
}

const W = 960;
const H = 540;
const CANNON_X = W / 2;
const CANNON_Y = 505;
const DEFAULT_STATE = { balance: 5000, level: 1 };
const LEVELS = [
  { id: 1, cost: 1, damage: 1, mult: 1, color: "#7fd8c2" },
  { id: 2, cost: 2, damage: 2, mult: 2, color: "#79b9ff" },
  { id: 3, cost: 5, damage: 3, mult: 3, color: "#c9a2ff" },
  { id: 4, cost: 10, damage: 4, mult: 4, color: "#ffb170" },
  { id: 5, cost: 20, damage: 5, mult: 5, color: "#ff7566" },
];

const FISH_TYPES = {
  CLOWN: {
    label: "小丑魚",
    hp: 1,
    reward: 2,
    radius: 21,
    speed: 78,
    weight: 42,
    body: "#ff9a4d",
    belly: "#ffd2a3",
    fin: "#d95c1d",
    school: true,
  },
  PUFFER: {
    label: "河豚",
    hp: 2,
    reward: 5,
    radius: 29,
    speed: 48,
    weight: 24,
    body: "#d7e37a",
    belly: "#f4f6c8",
    fin: "#95a13d",
    school: false,
  },
  TURTLE: {
    label: "海龜",
    hp: 4,
    reward: 10,
    radius: 38,
    speed: 34,
    weight: 18,
    body: "#5cbb8f",
    belly: "#bde8c8",
    fin: "#2f7a5c",
    school: false,
  },
  SHARK: {
    label: "鯊魚",
    hp: 8,
    reward: 24,
    radius: 54,
    speed: 58,
    weight: 11,
    body: "#8199b3",
    belly: "#d8e3ee",
    fin: "#516b86",
    school: false,
  },
  DRAGON: {
    label: "龍王",
    hp: 16,
    reward: 70,
    radius: 76,
    speed: 27,
    weight: 5,
    body: "#e8b65b",
    belly: "#ffe8b1",
    fin: "#a96c1d",
    school: false,
  },
};

const TYPE_ENTRIES = Object.entries(FISH_TYPES).map(([key, type]) => [
  key,
  type.weight,
]);

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let saved = loadJSON("fish", DEFAULT_STATE);
if (!saved || !Number.isFinite(saved.balance)) saved = { ...DEFAULT_STATE };
let balance = Math.max(0, Math.round(saved.balance));
let levelIndex = LEVELS.findIndex((level) => level.id === saved.level);
if (levelIndex < 0) levelIndex = 0;
let level = LEVELS[levelIndex];
let autoMode = false;
let running = true;
let aimAngle = -Math.PI / 2;
let targetAim = -Math.PI / 2;
let pointerDown = false;
let lastShotAt = 0;
let shots = 0;
let hits = 0;
let kills = 0;
let spawnTimer = 0.5;
let bossTimer = 26;
let fishId = 0;
let shakeUntil = 0;
let saveTimer = 0;
let lastFrame = 0;
let rafId = 0;
let viewScale = 1;
let backgroundCache = null;

/* --------------------------------------------------------------------------
   物件池：魚、子彈、粒子
   -------------------------------------------------------------------------- */
const FISH_POOL_SIZE = 36;
const BULLET_POOL_SIZE = 48;
const PARTICLE_POOL_SIZE = 180;

const fishPool = Array.from({ length: FISH_POOL_SIZE }, () => ({
  active: false,
  type: "CLOWN",
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  angle: 0,
  hp: 0,
  maxHp: 0,
  phase: 0,
  seed: 0,
  school: 0,
  dying: 0,
  hitFlash: 0,
  radius: 20,
}));

const bulletPool = Array.from({ length: BULLET_POOL_SIZE }, () => ({
  active: false,
  x: 0,
  y: 0,
  prevX: 0,
  prevY: 0,
  vx: 0,
  vy: 0,
  damage: 1,
  mult: 1,
  life: 0,
}));

const particlePool = Array.from({ length: PARTICLE_POOL_SIZE }, () => ({
  active: false,
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  life: 0,
  maxLife: 1,
  size: 2,
  color: "#fff",
  gravity: 0,
}));

let fishCursor = 0;
let bulletCursor = 0;
let particleCursor = 0;

function spawnParticle(options) {
  const particle = particlePool[particleCursor];
  particleCursor = (particleCursor + 1) % PARTICLE_POOL_SIZE;
  Object.assign(particle, {
    active: true,
    x: options.x,
    y: options.y,
    vx: options.vx,
    vy: options.vy,
    life: options.life ?? 0.6,
    maxLife: options.life ?? 0.6,
    size: options.size ?? 2.5,
    color: options.color ?? "#ffe6a6",
    gravity: options.gravity ?? 120,
  });
}

function spawnBurst(x, y, count, color, power = 140) {
  if (reduceMotion) count = Math.min(4, count);
  for (let i = 0; i < count; i += 1) {
    const angle = Math.random() * Math.PI * 2;
    const speed = power * (0.25 + Math.random() * 0.9);
    spawnParticle({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 0.35 + Math.random() * 0.55,
      size: 1.6 + Math.random() * 3.2,
      color,
      gravity: 140,
    });
  }
}

/* --------------------------------------------------------------------------
   魚群生成與 AI
   -------------------------------------------------------------------------- */
function weightedFishType() {
  const total = TYPE_ENTRIES.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = Math.random() * total;
  for (const [key, weight] of TYPE_ENTRIES) {
    roll -= weight;
    if (roll < 0) return key;
  }
  return "CLOWN";
}

function activeFishCount() {
  return fishPool.reduce((sum, fish) => sum + (fish.active ? 1 : 0), 0);
}

function spawnFish(typeKey = weightedFishType(), options = {}) {
  const slot = fishPool.find((fish) => !fish.active);
  if (!slot) return null;
  const type = FISH_TYPES[typeKey];
  const edge = options.edge || ["left", "right", "top"][Math.floor(Math.random() * 3)];
  const speed = type.speed * (0.85 + Math.random() * 0.3);
  let x = 0;
  let y = 0;
  let vx = 0;
  let vy = 0;

  if (edge === "left") {
    x = -type.radius * 2;
    y = 70 + Math.random() * (H - 190);
    vx = speed;
    vy = (Math.random() - 0.5) * speed * 0.24;
  } else if (edge === "right") {
    x = W + type.radius * 2;
    y = 70 + Math.random() * (H - 190);
    vx = -speed;
    vy = (Math.random() - 0.5) * speed * 0.24;
  } else {
    x = 100 + Math.random() * (W - 200);
    y = -type.radius * 2;
    vx = (Math.random() - 0.5) * speed * 0.7;
    vy = speed;
  }

  Object.assign(slot, {
    active: true,
    type: typeKey,
    x,
    y,
    vx,
    vy,
    angle: Math.atan2(vy, vx),
    hp: type.hp,
    maxHp: type.hp,
    phase: Math.random() * Math.PI * 2,
    seed: Math.random() * 100,
    school: options.school ?? 0,
    dying: 0,
    hitFlash: 0,
    radius: type.radius,
    id: (fishId += 1),
  });
  return slot;
}

function spawnSchool() {
  const school = Math.floor(Math.random() * 100000);
  const count = 4 + Math.floor(Math.random() * 3);
  const edge = Math.random() > 0.5 ? "left" : "right";
  for (let i = 0; i < count; i += 1) {
    const fish = spawnFish("CLOWN", { edge, school });
    // 同一群錯開位置，避免完全重疊
    if (fish) {
      fish.y += (i - count / 2) * 24;
      fish.x += (Math.random() - 0.5) * 50;
    }
  }
}

function respawnWave() {
  const count = activeFishCount();
  const roll = Math.random();
  if (roll < 0.28 && count < 24) {
    spawnSchool();
  } else {
    spawnFish();
  }
}

/* --------------------------------------------------------------------------
   射擊
   -------------------------------------------------------------------------- */
function muzzlePosition() {
  return {
    x: CANNON_X + Math.cos(aimAngle) * 64,
    y: CANNON_Y + Math.sin(aimAngle) * 64,
  };
}

function fire() {
  if (!running) return;
  const now = performance.now();
  if (now - lastShotAt < 125) return;
  if (balance < level.cost) {
    pointerDown = false;
    setStatus("虛擬籌碼不足，請降低火力或按「補充籌碼」。");
    announce("虛擬籌碼不足，已停止射擊。");
    if (autoMode) setAuto(false);
    return;
  }

  const bullet = bulletPool[bulletCursor];
  bulletCursor = (bulletCursor + 1) % BULLET_POOL_SIZE;
  const muzzle = muzzlePosition();
  Object.assign(bullet, {
    active: true,
    x: muzzle.x,
    y: muzzle.y,
    prevX: muzzle.x,
    prevY: muzzle.y,
    vx: Math.cos(aimAngle) * 1120,
    vy: Math.sin(aimAngle) * 1120,
    damage: level.damage,
    mult: level.mult,
    life: 1.4,
  });

  balance -= level.cost;
  shots += 1;
  lastShotAt = now;
  sfx("bullet");
  updateHud();
  scheduleSave();
}

function segmentCircleHit(x1, y1, x2, y2, cx, cy, radius) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy || 1;
  let t = ((cx - x1) * dx + (cy - y1) * dy) / lengthSquared;
  t = clamp(t, 0, 1);
  const px = x1 + dx * t;
  const py = y1 + dy * t;
  return (px - cx) ** 2 + (py - cy) ** 2 <= radius * radius;
}

function handleHit(bullet, fish) {
  hits += 1;
  fish.hp -= bullet.damage;
  fish.hitFlash = 0.15;
  spawnBurst(bullet.x, bullet.y, 6, "#bdeaff", 90);
  sfx("hit");

  if (fish.hp > 0) {
    updateHud();
    return;
  }

  const type = FISH_TYPES[fish.type];
  const reward = type.reward * bullet.mult;
  balance += reward;
  kills += 1;
  fish.dying = 0.42;
  fish.hp = 0;
  spawnBurst(fish.x, fish.y, fish.type === "DRAGON" ? 34 : 16, "#ffe2a0", fish.radius * 3.2);
  sfx(fish.type === "DRAGON" ? "explosion" : "cash");
  if (fish.type === "DRAGON" || fish.type === "SHARK") {
    shakeUntil = performance.now() + (reduceMotion ? 0 : 260);
    announce(`擊破${type.label}，獲得 ${formatCredits(reward)} 點。`);
  } else {
    setStatus(`擊破${type.label}，獲得 ${formatCredits(reward)} 點。`);
  }
  updateHud();
  scheduleSave();
}

/* --------------------------------------------------------------------------
   更新
   -------------------------------------------------------------------------- */
function updateFish(dt, now) {
  const active = fishPool.filter((fish) => fish.active);
  for (const fish of active) {
    if (fish.dying > 0) {
      fish.dying -= dt;
      if (fish.dying <= 0) fish.active = false;
      continue;
    }
    const type = FISH_TYPES[fish.type];
    fish.phase += dt;
    fish.hitFlash = Math.max(0, fish.hitFlash - dt);

    let ax = 0;
    let ay = 0;

    // 小魚群：分離 + 凝聚（簡化 boids，控制 O(n²) 在 36 隻內可接受）
    if (type.school) {
      let centerX = 0;
      let centerY = 0;
      let neighbors = 0;
      let separateX = 0;
      let separateY = 0;
      for (const other of active) {
        if (other === fish || other.dying || !other.active) continue;
        if (other.school !== fish.school) continue;
        const dx = fish.x - other.x;
        const dy = fish.y - other.y;
        const distSq = dx * dx + dy * dy;
        if (distSq > 130 * 130) continue;
        centerX += other.x;
        centerY += other.y;
        neighbors += 1;
        if (distSq < 55 * 55 && distSq > 0.01) {
          const dist = Math.sqrt(distSq);
          separateX += (dx / dist) * 40;
          separateY += (dy / dist) * 40;
        }
      }
      if (neighbors > 0) {
        centerX /= neighbors;
        centerY /= neighbors;
        ax += (centerX - fish.x) * 0.06;
        ay += (centerY - fish.y) * 0.06;
      }
      ax += separateX * 3.2;
      ay += separateY * 3.2;
    }

    // 大魚的巡航波浪與細微轉向
    const wobble = Math.sin(fish.phase * 1.6 + fish.seed) * (type.school ? 14 : 26);
    const vx = fish.vx + ax + Math.cos(fish.phase * 0.7 + fish.seed) * 6;
    const vy = fish.vy + ay + wobble;
    fish.x += vx * dt;
    fish.y += vy * dt;
    fish.angle = Math.atan2(vy, vx);

    // 離開畫面後回收
    const margin = fish.radius * 3 + 80;
    if (
      fish.x < -margin ||
      fish.x > W + margin ||
      fish.y < -margin ||
      fish.y > H + margin
    ) {
      fish.active = false;
    }
  }
}

function updateBullets(dt) {
  for (const bullet of bulletPool) {
    if (!bullet.active) continue;
    bullet.life -= dt;
    if (bullet.life <= 0) {
      bullet.active = false;
      continue;
    }
    bullet.prevX = bullet.x;
    bullet.prevY = bullet.y;
    bullet.x += bullet.vx * dt;
    bullet.y += bullet.vy * dt;

    if (bullet.x < -40 || bullet.x > W + 40 || bullet.y < -40 || bullet.y > H + 40) {
      bullet.active = false;
      continue;
    }

    for (const fish of fishPool) {
      if (!fish.active || fish.dying > 0) continue;
      if (
        segmentCircleHit(
          bullet.prevX,
          bullet.prevY,
          bullet.x,
          bullet.y,
          fish.x,
          fish.y,
          fish.radius * 0.82,
        )
      ) {
        bullet.active = false;
        handleHit(bullet, fish);
        break;
      }
    }
  }
}

function updateParticles(dt) {
  for (const particle of particlePool) {
    if (!particle.active) continue;
    particle.life -= dt;
    if (particle.life <= 0) {
      particle.active = false;
      continue;
    }
    particle.vy += particle.gravity * dt;
    particle.x += particle.vx * dt;
    particle.y += particle.vy * dt;
  }
}

const bubbles = Array.from({ length: 26 }, () => ({
  x: Math.random() * W,
  y: Math.random() * H,
  radius: 1.5 + Math.random() * 4,
  speed: 8 + Math.random() * 22,
  phase: Math.random() * Math.PI * 2,
}));

function updateBubbles(dt) {
  for (const bubble of bubbles) {
    bubble.y -= bubble.speed * dt;
    bubble.x += Math.sin(bubble.y * 0.02 + bubble.phase) * 6 * dt;
    if (bubble.y < -10) {
      bubble.y = H + 10;
      bubble.x = Math.random() * W;
    }
  }
}

function autoTarget() {
  let best = null;
  let bestScore = -Infinity;
  for (const fish of fishPool) {
    if (!fish.active || fish.dying > 0) continue;
    const type = FISH_TYPES[fish.type];
    const distance = Math.hypot(fish.x - CANNON_X, fish.y - CANNON_Y);
    const score = (type.reward * level.mult) / Math.max(1, fish.hp) - distance * 0.02;
    if (score > bestScore) {
      best = fish;
      bestScore = score;
    }
  }
  return best;
}

function updateAim(dt) {
  if (autoMode) {
    const target = autoTarget();
    if (target) {
      targetAim = Math.atan2(target.y - CANNON_Y, target.x - CANNON_X);
    } else {
      targetAim = -Math.PI / 2;
    }
  }
  targetAim = clamp(targetAim, -Math.PI + 0.22, -0.22);
  const diff = targetAim - aimAngle;
  aimAngle += diff * Math.min(1, dt * 14);
}

function update(dt, now) {
  updateAim(dt);
  updateFish(dt, now);
  updateBullets(dt);
  updateParticles(dt);
  updateBubbles(dt);

  spawnTimer -= dt;
  if (spawnTimer <= 0) {
    const count = activeFishCount();
    if (count < 26) respawnWave();
    spawnTimer = count < 12 ? 0.45 + Math.random() * 0.6 : 1.1 + Math.random() * 1.2;
  }

  bossTimer -= dt;
  if (bossTimer <= 0) {
    if (activeFishCount() < 28) {
      spawnFish("DRAGON", { edge: Math.random() > 0.5 ? "left" : "right" });
      setStatus("龍王出現！擊破可獲得高額虛擬點數。");
      announce("龍王出現。");
      sfx("freespin");
    }
    bossTimer = 42 + Math.random() * 20;
  }

  if ((autoMode || pointerDown) && now - lastShotAt >= (autoMode ? 270 : 170)) {
    if (autoMode) {
      const target = autoTarget();
      if (!target) return;
      if (Math.abs(targetAim - aimAngle) < 0.08) fire();
    } else {
      fire();
    }
  }
}

/* --------------------------------------------------------------------------
   繪圖
   -------------------------------------------------------------------------- */
function createBackground() {
  const offscreen = document.createElement("canvas");
  offscreen.width = W;
  offscreen.height = H;
  const g = offscreen.getContext("2d");

  const ocean = g.createLinearGradient(0, 0, 0, H);
  ocean.addColorStop(0, "#062a40");
  ocean.addColorStop(0.42, "#06384c");
  ocean.addColorStop(0.72, "#042b3a");
  ocean.addColorStop(1, "#021923");
  g.fillStyle = ocean;
  g.fillRect(0, 0, W, H);

  // 水面光柱
  for (let i = 0; i < 7; i += 1) {
    const x = 70 + i * 145;
    const beam = g.createLinearGradient(x, 0, x + 60, H);
    beam.addColorStop(0, "rgba(155, 236, 255, .12)");
    beam.addColorStop(0.65, "rgba(155, 236, 255, .025)");
    beam.addColorStop(1, "rgba(155, 236, 255, 0)");
    g.fillStyle = beam;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x + 70, 0);
    g.lineTo(x + 175, H);
    g.lineTo(x - 50, H);
    g.closePath();
    g.fill();
  }

  // 遠景珊瑚剪影
  g.save();
  g.globalAlpha = 0.34;
  g.fillStyle = "#031c28";
  for (let i = 0; i < 12; i += 1) {
    const x = i * 92 - 30;
    const height = 80 + ((i * 47) % 110);
    g.beginPath();
    g.moveTo(x, H);
    g.bezierCurveTo(x + 20, H - height * 0.5, x - 10, H - height, x + 18, H - height);
    g.bezierCurveTo(x + 44, H - height, x + 34, H - height * 0.4, x + 58, H);
    g.closePath();
    g.fill();
  }
  g.restore();

  // 海床
  const sand = g.createLinearGradient(0, H - 70, 0, H);
  sand.addColorStop(0, "rgba(72, 71, 48, 0)");
  sand.addColorStop(1, "rgba(111, 94, 58, .45)");
  g.fillStyle = sand;
  g.fillRect(0, H - 70, W, 70);

  // 細微水波紋
  g.save();
  g.globalAlpha = 0.055;
  g.strokeStyle = "#b6f0ff";
  g.lineWidth = 1;
  for (let y = 30; y < H; y += 34) {
    g.beginPath();
    for (let x = 0; x <= W; x += 12) {
      const wave = Math.sin(x * 0.02 + y * 0.05) * 5;
      if (x === 0) g.moveTo(x, y + wave);
      else g.lineTo(x, y + wave);
    }
    g.stroke();
  }
  g.restore();

  return offscreen;
}

function drawFish(fish, now) {
  const type = FISH_TYPES[fish.type];
  const r = fish.radius;
  const dyingScale = fish.dying > 0 ? Math.max(0, fish.dying / 0.42) : 1;
  const flash = fish.hitFlash > 0 ? 1 : 0;

  ctx.save();
  ctx.translate(fish.x, fish.y);
  if (fish.dying > 0) {
    ctx.globalAlpha = Math.max(0, fish.dying / 0.42);
    ctx.scale(1 + (1 - dyingScale) * 0.5, 1 + (1 - dyingScale) * 0.5);
    ctx.rotate((1 - dyingScale) * 0.5);
  }
  const facingLeft = Math.cos(fish.angle) < 0;
  ctx.rotate(fish.angle);
  if (facingLeft) ctx.scale(1, -1);

  // 龍王光暈
  if (fish.type === "DRAGON" && !reduceMotion) {
    ctx.save();
    ctx.shadowColor = "rgba(255, 210, 110, .85)";
    ctx.shadowBlur = 26;
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 1.25, r * 0.85, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 210, 110, .1)";
    ctx.fill();
    ctx.restore();
  }

  // 尾鰭
  ctx.beginPath();
  ctx.moveTo(-r * 0.82, 0);
  ctx.lineTo(-r * 1.65, -r * 0.62);
  ctx.lineTo(-r * 1.42, 0);
  ctx.lineTo(-r * 1.65, r * 0.62);
  ctx.closePath();
  ctx.fillStyle = type.fin;
  ctx.fill();

  // 身體
  const bodyGradient = ctx.createLinearGradient(-r, -r * 0.6, r, r * 0.7);
  bodyGradient.addColorStop(0, type.fin);
  bodyGradient.addColorStop(0.38, type.body);
  bodyGradient.addColorStop(1, type.belly);
  ctx.beginPath();
  ctx.ellipse(0, 0, r * (fish.type === "SHARK" ? 1.28 : 1.02), r * 0.68, 0, 0, Math.PI * 2);
  ctx.fillStyle = flash ? "#ffffff" : bodyGradient;
  ctx.fill();
  ctx.strokeStyle = "rgba(4, 20, 28, .38)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // 背鰭
  ctx.beginPath();
  ctx.moveTo(-r * 0.2, -r * 0.56);
  ctx.quadraticCurveTo(r * 0.1, -r * 1.05, r * 0.42, -r * 0.5);
  ctx.closePath();
  ctx.fillStyle = type.fin;
  ctx.fill();

  // 眼睛
  ctx.beginPath();
  ctx.arc(r * 0.52, -r * 0.16, r * 0.14, 0, Math.PI * 2);
  ctx.fillStyle = "#fffdf6";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(r * 0.56, -r * 0.16, r * 0.07, 0, Math.PI * 2);
  ctx.fillStyle = "#07151a";
  ctx.fill();

  // 嘴
  ctx.beginPath();
  ctx.moveTo(r * 0.86, r * 0.08);
  ctx.quadraticCurveTo(r * 0.98, r * 0.2, r * 0.8, r * 0.27);
  ctx.strokeStyle = "rgba(40, 20, 10, .55)";
  ctx.lineWidth = Math.max(1.5, r * 0.06);
  ctx.stroke();

  // 各魚種特徵
  if (fish.type === "CLOWN") {
    ctx.save();
    ctx.globalAlpha = 0.78;
    ctx.strokeStyle = "#fff6e4";
    ctx.lineWidth = r * 0.15;
    for (const offset of [-0.38, 0.16]) {
      ctx.beginPath();
      ctx.ellipse(r * offset, 0, r * 0.09, r * 0.6, 0, -Math.PI / 2, Math.PI / 2);
      ctx.stroke();
    }
    ctx.restore();
  } else if (fish.type === "PUFFER") {
    ctx.strokeStyle = type.fin;
    ctx.lineWidth = Math.max(2, r * 0.08);
    for (let i = 0; i < 10; i += 1) {
      const angle = (Math.PI * i) / 5;
      ctx.beginPath();
      ctx.moveTo(Math.cos(angle) * r * 0.94, Math.sin(angle) * r * 0.62);
      ctx.lineTo(Math.cos(angle) * r * 1.2, Math.sin(angle) * r * 0.86);
      ctx.stroke();
    }
  } else if (fish.type === "TURTLE") {
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = "#1f5b45";
    ctx.lineWidth = 2;
    for (let i = -2; i <= 2; i += 1) {
      ctx.beginPath();
      ctx.ellipse(0, 0, r * (0.25 + Math.abs(i) * 0.18), r * 0.5, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
    // 龜鰭
    ctx.beginPath();
    ctx.ellipse(r * 0.18, r * 0.58, r * 0.34, r * 0.16, -0.4, 0, Math.PI * 2);
    ctx.fillStyle = type.fin;
    ctx.fill();
  } else if (fish.type === "SHARK") {
    ctx.beginPath();
    ctx.moveTo(-r * 0.2, -r * 0.55);
    ctx.lineTo(r * 0.08, -r * 1.14);
    ctx.lineTo(r * 0.4, -r * 0.46);
    ctx.closePath();
    ctx.fillStyle = type.fin;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(r * 0.45, r * 0.2);
    ctx.lineTo(r * 0.64, r * 0.55);
    ctx.lineTo(r * 0.28, r * 0.45);
    ctx.closePath();
    ctx.fillStyle = "rgba(255,255,255,.55)";
    ctx.fill();
  } else if (fish.type === "DRAGON") {
    // 龍角
    ctx.strokeStyle = "#fff0bd";
    ctx.lineWidth = Math.max(2, r * 0.05);
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(r * 0.3, -r * 0.52 * side);
      ctx.quadraticCurveTo(r * 0.48, -r * 0.9 * side, r * 0.62, -r * 0.82 * side);
      ctx.stroke();
    }
    // 龍鬚
    ctx.strokeStyle = "rgba(255, 237, 183, .8)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(r * 0.86, r * 0.15);
    ctx.quadraticCurveTo(r * 1.25, r * 0.05, r * 1.38, r * 0.35);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(r * 0.86, r * 0.25);
    ctx.quadraticCurveTo(r * 1.2, r * 0.3, r * 1.3, r * 0.55);
    ctx.stroke();
    // 龍鱗
    ctx.globalAlpha = 0.28;
    ctx.strokeStyle = "#7c4b10";
    for (let i = 0; i < 6; i += 1) {
      ctx.beginPath();
      ctx.arc(-r * 0.42 + i * r * 0.17, 0, r * 0.13, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.restore();

  // 血條
  if (fish.hp < fish.maxHp && fish.dying <= 0) {
    const width = r * 1.7;
    const x = fish.x - width / 2;
    const y = fish.y - r - 14;
    ctx.fillStyle = "rgba(0, 0, 0, .5)";
    ctx.beginPath();
    ctx.roundRect?.(x, y, width, 5, 3);
    if (!ctx.roundRect) ctx.rect(x, y, width, 5);
    ctx.fill();
    ctx.fillStyle = "#65e0b0";
    ctx.beginPath();
    ctx.roundRect?.(x + 1, y + 1, (width - 2) * (fish.hp / fish.maxHp), 3, 2);
    if (!ctx.roundRect) ctx.rect(x + 1, y + 1, (width - 2) * (fish.hp / fish.maxHp), 3);
    ctx.fill();
  }

  // 龍王標籤
  if (fish.type === "DRAGON" && fish.dying <= 0) {
    ctx.save();
    ctx.textAlign = "center";
    ctx.font = "700 11px ui-monospace, monospace";
    ctx.fillStyle = "rgba(255, 230, 166, .9)";
    ctx.fillText("DRAGON KING", fish.x, fish.y - r - 22);
    ctx.restore();
  }
}

function drawCannon() {
  const grad = ctx.createLinearGradient(CANNON_X - 50, CANNON_Y, CANNON_X + 50, CANNON_Y + 25);
  grad.addColorStop(0, "#23364b");
  grad.addColorStop(0.5, "#4f6b85");
  grad.addColorStop(1, "#1a2838");
  ctx.beginPath();
  ctx.ellipse(CANNON_X, CANNON_Y + 18, 58, 20, 0, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = "rgba(233, 185, 92, .45)";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.save();
  ctx.translate(CANNON_X, CANNON_Y);
  ctx.rotate(aimAngle);
  const barrel = ctx.createLinearGradient(0, -10, 70, 10);
  barrel.addColorStop(0, "#7c91a8");
  barrel.addColorStop(0.55, level.color);
  barrel.addColorStop(1, "#dfe9f2");
  ctx.beginPath();
  ctx.roundRect?.(8, -9, 58, 18, 9);
  if (!ctx.roundRect) ctx.rect(8, -9, 58, 18);
  ctx.fillStyle = barrel;
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 255, 255, .45)";
  ctx.lineWidth = 1.4;
  ctx.stroke();
  ctx.restore();

  // 底座
  ctx.beginPath();
  ctx.arc(CANNON_X, CANNON_Y + 6, 32, 0, Math.PI * 2);
  ctx.fillStyle = "#17273a";
  ctx.fill();
  ctx.strokeStyle = "rgba(233, 185, 92, .62)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = "#f4e3b6";
  ctx.font = "700 15px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`×${level.mult}`, CANNON_X, CANNON_Y + 7);
}

function drawAimGuide() {
  const muzzle = muzzlePosition();
  const endX = muzzle.x + Math.cos(aimAngle) * 260;
  const endY = muzzle.y + Math.sin(aimAngle) * 260;
  ctx.save();
  ctx.globalAlpha = 0.42;
  ctx.setLineDash([6, 8]);
  ctx.strokeStyle = "rgba(151, 225, 255, .8)";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(muzzle.x, muzzle.y);
  ctx.lineTo(endX, endY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(endX, endY, 3.5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function draw(now) {
  if (!ctx) return;
  ctx.setTransform(viewScale, 0, 0, viewScale, 0, 0);
  ctx.clearRect(0, 0, W, H);

  let shakeX = 0;
  let shakeY = 0;
  if (shakeUntil > now && !reduceMotion) {
    const power = ((shakeUntil - now) / 260) * 6;
    shakeX = (Math.random() - 0.5) * power;
    shakeY = (Math.random() - 0.5) * power;
  }
  ctx.translate(shakeX, shakeY);

  if (backgroundCache) ctx.drawImage(backgroundCache, 0, 0);

  // 氣泡
  ctx.save();
  for (const bubble of bubbles) {
    ctx.globalAlpha = 0.22;
    ctx.beginPath();
    ctx.arc(bubble.x, bubble.y, bubble.radius, 0, Math.PI * 2);
    ctx.strokeStyle = "#c7f3ff";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.restore();

  // 魚（先畫大魚再畫小魚，讓小魚在前景）
  for (const fish of fishPool) {
    if (!fish.active) continue;
    if (["DRAGON", "SHARK", "TURTLE"].includes(fish.type)) drawFish(fish, now);
  }
  for (const fish of fishPool) {
    if (!fish.active) continue;
    if (!["DRAGON", "SHARK", "TURTLE"].includes(fish.type)) drawFish(fish, now);
  }

  // 子彈
  ctx.save();
  for (const bullet of bulletPool) {
    if (!bullet.active) continue;
    ctx.strokeStyle = "rgba(155, 235, 255, .35)";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(bullet.x - bullet.vx * 0.018, bullet.y - bullet.vy * 0.018);
    ctx.lineTo(bullet.x, bullet.y);
    ctx.stroke();
    ctx.fillStyle = "#dff8ff";
    ctx.beginPath();
    ctx.arc(bullet.x, bullet.y, 3.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // 粒子
  for (const particle of particlePool) {
    if (!particle.active) continue;
    const alpha = Math.max(0, particle.life / particle.maxLife);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = particle.color;
    ctx.beginPath();
    ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  drawCannon();
  drawAimGuide();

  // 畫面暗角
  const vignette = ctx.createRadialGradient(
    W / 2,
    H / 2,
    H * 0.34,
    W / 2,
    H / 2,
    H * 0.92,
  );
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,.42)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, W, H);
}

/* --------------------------------------------------------------------------
   HUD 與控制
   -------------------------------------------------------------------------- */
function setStatus(message) {
  if (statusEl) statusEl.textContent = message;
}

function announce(message) {
  if (srEl) srEl.textContent = message;
}

function updateHud() {
  if (balanceEl) balanceEl.textContent = formatCredits(balance);
  if (costEl) costEl.textContent = formatCredits(level.cost);
  if (levelEl) levelEl.textContent = `×${level.mult}`;
  if (accuracyEl) {
    accuracyEl.textContent = shots > 0 ? `${Math.round((hits / shots) * 100)}%` : "—";
  }
  if (killsEl) killsEl.textContent = formatCredits(kills);
  levelButtons.forEach((button) => {
    button.setAttribute(
      "aria-pressed",
      String(Number(button.dataset.fishLevel) === level.id),
    );
  });
}

function setAuto(next) {
  autoMode = Boolean(next);
  if (autoBtn) {
    autoBtn.setAttribute("aria-pressed", String(autoMode));
    autoBtn.textContent = autoMode ? "停止自動捕魚" : "自動捕魚";
  }
  if (autoMode) {
    unlockAudio();
    setStatus("自動捕魚已開啟：系統會優先鎖定高價值魚種。");
    announce("自動捕魚已開啟。");
  } else {
    setStatus("自動捕魚已關閉。");
  }
}

function setLevel(nextLevel) {
  levelIndex = LEVELS.findIndex((item) => item.id === nextLevel);
  if (levelIndex < 0) return;
  level = LEVELS[levelIndex];
  saved.level = level.id;
  updateHud();
  scheduleSave();
  sfx("click");
  setStatus(`火力切換為 ×${level.mult}，每發消耗 ${formatCredits(level.cost)} 點。`);
}

function scheduleSave() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveJSON("fish", { balance, level: level.id });
  }, 300);
}

function resetGame() {
  balance = DEFAULT_STATE.balance;
  shots = 0;
  hits = 0;
  kills = 0;
  level = LEVELS[0];
  levelIndex = 0;
  setAuto(false);
  saveJSON("fish", { balance, level: level.id });
  updateHud();
  setStatus("已補充 5,000 點虛擬籌碼，統計已歸零。");
  announce("已補充虛擬籌碼，統計歸零。");
  sfx("cash");
}

/* --------------------------------------------------------------------------
   指標與鍵盤
   -------------------------------------------------------------------------- */
function pointerToWorld(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * W,
    y: ((event.clientY - rect.top) / rect.height) * H,
  };
}

canvas?.addEventListener("pointermove", (event) => {
  if (event.pointerType === "touch" && !pointerDown) return;
  const point = pointerToWorld(event);
  targetAim = Math.atan2(point.y - CANNON_Y, point.x - CANNON_X);
  targetAim = clamp(targetAim, -Math.PI + 0.22, -0.22);
});

canvas?.addEventListener("pointerdown", (event) => {
  unlockAudio();
  const point = pointerToWorld(event);
  targetAim = clamp(
    Math.atan2(point.y - CANNON_Y, point.x - CANNON_X),
    -Math.PI + 0.22,
    -0.22,
  );
  aimAngle = targetAim;
  pointerDown = true;
  fire();
  canvas.setPointerCapture?.(event.pointerId);
});

function releasePointer() {
  pointerDown = false;
}
canvas?.addEventListener("pointerup", releasePointer);
canvas?.addEventListener("pointercancel", releasePointer);
canvas?.addEventListener("pointerleave", releasePointer);

canvas?.addEventListener("keydown", (event) => {
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    const step = event.shiftKey ? 0.14 : 0.055;
    targetAim += event.key === "ArrowLeft" ? -step : step;
    targetAim = clamp(targetAim, -Math.PI + 0.22, -0.22);
    setAuto(false);
  } else if (event.code === "Space" || event.key === " " || event.key === "Enter") {
    event.preventDefault();
    unlockAudio();
    setAuto(false);
    fire();
  }
});

autoBtn?.addEventListener("click", () => {
  unlockAudio();
  setAuto(!autoMode);
});

resetBtn?.addEventListener("click", resetGame);
levelButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setLevel(Number(button.dataset.fishLevel));
  });
});

document.addEventListener("visibilitychange", () => {
  running = !document.hidden;
  if (running) {
    lastFrame = performance.now();
    if (!rafId) rafId = requestAnimationFrame(loop);
  } else {
    cancelAnimationFrame(rafId);
    rafId = 0;
    saveJSON("fish", { balance, level: level.id });
  }
});

window.addEventListener("pagehide", () => {
  saveJSON("fish", { balance, level: level.id });
});

/* --------------------------------------------------------------------------
   Canvas 尺寸與主迴圈
   -------------------------------------------------------------------------- */
function fitCanvas() {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.width * (H / W) * dpr);
  viewScale = canvas.width / W;
  draw(performance.now());
}

function loop(now) {
  rafId = 0;
  if (!running) return;
  const dt = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  update(dt, now);
  draw(now);
  rafId = requestAnimationFrame(loop);
}

const ctx = canvas?.getContext("2d", { alpha: false });

if (canvas && ctx) {
  backgroundCache = createBackground();
  fitCanvas();
  if ("ResizeObserver" in window) {
    const observer = new ResizeObserver(fitCanvas);
    observer.observe(canvas);
  } else {
    window.addEventListener("resize", fitCanvas, { passive: true });
  }

  // 初始魚群
  spawnFish("CLOWN", { edge: "left", school: 1 });
  spawnFish("CLOWN", { edge: "left", school: 1 });
  spawnFish("PUFFER", { edge: "right" });
  spawnFish("TURTLE", { edge: "left" });
  spawnFish("SHARK", { edge: "right" });
  spawnFish("CLOWN", { edge: "top" });
  spawnFish("CLOWN", { edge: "top", school: 1 });
  spawnFish("PUFFER", { edge: "top" });

  updateHud();
  lastFrame = performance.now();
  rafId = requestAnimationFrame(loop);
  setStatus("點擊或拖曳海面射擊；也可開啟「自動捕魚」。所有點數皆為虛擬點數。");
}
