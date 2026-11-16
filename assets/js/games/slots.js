/**
 * 老虎機 Slots：5×3、10 條固定賠付線、Free Spin、Big Win 分級演出
 * ---------------------------------------------------------------------------
 * 架構重點：
 * - FSM 控制 Idle → Spinning → Evaluating → FreeSpin / BigWin，避免重複下注。
 * - 滾輪以「目標位置 + 時間緩動」呈現，停輪後加入位移回彈（bounce）。
 * - 符號紋理預先繪製到 OffscreenCanvas（或隱藏 canvas）快取。
 * - 粒子使用固定容量物件池，避免每次得獎都 new 物件造成 GC 抖動。
 * - 結果使用 crypto.getRandomValues；正式環境請改由伺服器回傳 signed spin。
 */

import { StateMachine } from "../lib/fsm.js";
import { pickWeighted, randomInt } from "../lib/rng.js";
import { formatCredits, loadJSON, saveJSON } from "../lib/storage.js";
import { sfx, unlockAudio } from "../lib/audio.js";

const canvas = document.getElementById("slot-canvas");
const spinBtn = document.getElementById("slot-spin");
const betDown = document.getElementById("slot-bet-down");
const betUp = document.getElementById("slot-bet-up");
const resetBtn = document.getElementById("slot-reset");
const balanceEl = document.getElementById("slot-balance");
const betEl = document.getElementById("slot-bet");
const betStepperEl = document.getElementById("slot-bet-stepper");
const winEl = document.getElementById("slot-win");
const fsEl = document.getElementById("slot-fs");
const statusEl = document.getElementById("slot-status");
const srEl = document.getElementById("slot-sr");
const stateEl = document.getElementById("slot-state");
const bigWinEl = document.getElementById("slot-bigwin");
const bigWinTierEl = document.getElementById("slot-bigwin-tier");
const bigWinAmountEl = document.getElementById("slot-bigwin-amount");
const bigWinContinue = document.getElementById("slot-bigwin-continue");
const freeBanner = document.getElementById("slot-freespin");
const freeCountEl = document.getElementById("slot-freespin-count");

if (!canvas || !spinBtn) {
  // 非老虎機頁面不應載入此模組；安靜退出避免 console 噪音
  console.warn("[slots] 找不到必要的 canvas 或控制項");
}

const LOGICAL_W = 900;
const LOGICAL_H = 540;
const PAD_X = 26;
const PAD_Y = 20;
const GAP = 8;
const REEL_COUNT = 5;
const ROW_COUNT = 3;
const REEL_W = (LOGICAL_W - PAD_X * 2 - GAP * (REEL_COUNT - 1)) / REEL_COUNT;
const CELL_H = (LOGICAL_H - PAD_Y * 2) / ROW_COUNT;
const STRIP_LENGTH = 42;
const BET_LEVELS = [10, 20, 50, 100, 200, 500];
const DEFAULT_STATE = { balance: 10000, bet: 20 };
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** 賠付表：線獎為「每線投注」倍數；SCATTER 為「總投注」倍數 */
const SYMBOLS = {
  "10": { pay: { 3: 2, 4: 5, 5: 10 }, weight: 24, accent: "#9fb7c8" },
  J: { pay: { 3: 2, 4: 6, 5: 15 }, weight: 22, accent: "#5ed8aa" },
  Q: { pay: { 3: 3, 4: 8, 5: 25 }, weight: 20, accent: "#ff9d8f" },
  K: { pay: { 3: 4, 4: 12, 5: 40 }, weight: 18, accent: "#c4a7ff" },
  A: { pay: { 3: 5, 4: 15, 5: 60 }, weight: 16, accent: "#f0c76a" },
  GEM: { pay: { 3: 10, 4: 30, 5: 120 }, weight: 12 },
  COIN: { pay: { 3: 15, 4: 50, 5: 200 }, weight: 9 },
  SEVEN: { pay: { 3: 20, 4: 75, 5: 300 }, weight: 6 },
  WILD: { pay: { 3: 25, 4: 100, 5: 500 }, weight: 3 },
  SCATTER: { pay: { 3: 2, 4: 10, 5: 50 }, weight: 2, scatter: true },
};

const PAYLINES = [
  [1, 1, 1, 1, 1],
  [0, 0, 0, 0, 0],
  [2, 2, 2, 2, 2],
  [0, 1, 2, 1, 0],
  [2, 1, 0, 1, 2],
  [1, 0, 0, 0, 1],
  [1, 2, 2, 2, 1],
  [0, 0, 1, 2, 2],
  [2, 2, 1, 0, 0],
  [1, 0, 1, 2, 1],
];

const weightedEntries = Object.entries(SYMBOLS).map(([key, value]) => [
  key,
  value.weight,
]);
const lineCandidates = Object.keys(SYMBOLS).filter((key) => !SYMBOLS[key].scatter);

/** 建立滾輪條：確保每條至少有一個 WILD 與 SCATTER，避免 RNG 造成死輪 */
function buildStrip() {
  const strip = Array.from({ length: STRIP_LENGTH }, () =>
    pickWeighted(weightedEntries),
  );
  if (!strip.includes("WILD")) strip[randomInt(STRIP_LENGTH)] = "WILD";
  if (!strip.includes("SCATTER")) strip[randomInt(STRIP_LENGTH)] = "SCATTER";
  return strip;
}

const reels = Array.from({ length: REEL_COUNT }, () => {
  const strip = buildStrip();
  return {
    strip,
    position: randomInt(strip.length),
    finalPos: 0,
    anim: null,
    bounceAt: 0,
    flashUntil: 0,
  };
});

let saved = loadJSON("slots", DEFAULT_STATE);
if (
  !saved ||
  !Number.isFinite(saved.balance) ||
  !BET_LEVELS.includes(saved.bet)
) {
  saved = { ...DEFAULT_STATE };
}
let balance = Math.max(0, Math.round(saved.balance));
let bet = BET_LEVELS.includes(saved.bet) ? saved.bet : DEFAULT_STATE.bet;
let lastWin = 0;
let currentSpinWasFree = false;
let fsRemaining = 0;
let fsTotal = 0;
let freeRoundWin = 0;
let pendingFreeAward = 0;
let spinCounter = 0;
let evaluatingRound = false;
let highlight = null;
let countUpFrame = 0;
let lastFocused = null;
let autoSpinTimer = 0;
let evaluateTimer = 0;
let spinGuardTimer = 0;

/* --------------------------------------------------------------------------
   物件池：固定 180 個粒子，重複利用，避免動畫期間產生垃圾
   -------------------------------------------------------------------------- */
class ParticlePool {
  constructor(size) {
    this.items = Array.from({ length: size }, () => ({
      active: false,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      life: 0,
      maxLife: 1,
      size: 8,
      rotation: 0,
      spin: 0,
      kind: "coin",
    }));
    this.cursor = 0;
  }

  spawn(options) {
    const particle = this.items[this.cursor];
    this.cursor = (this.cursor + 1) % this.items.length;
    Object.assign(particle, {
      active: true,
      x: options.x,
      y: options.y,
      vx: options.vx,
      vy: options.vy,
      life: options.life ?? 1,
      maxLife: options.life ?? 1,
      size: options.size ?? 7,
      rotation: options.rotation ?? 0,
      spin: options.spin ?? 0,
      kind: options.kind ?? "coin",
    });
    return particle;
  }

  update(dt) {
    let active = false;
    for (const particle of this.items) {
      if (!particle.active) continue;
      particle.life -= dt;
      if (particle.life <= 0) {
        particle.active = false;
        continue;
      }
      particle.vy += 620 * dt;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.rotation += particle.spin * dt;
      if (particle.y > LOGICAL_H + 40) particle.active = false;
      else active = true;
    }
    return active;
  }

  draw(ctx) {
    for (const particle of this.items) {
      if (!particle.active) continue;
      const alpha = Math.min(1, particle.life / (particle.maxLife * 0.35));
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(particle.x, particle.y);
      ctx.rotate(particle.rotation);
      if (particle.kind === "spark") {
        ctx.fillStyle = "#ffe6a6";
        ctx.fillRect(-particle.size / 2, -1, particle.size, 2);
        ctx.fillRect(-1, -particle.size / 2, 2, particle.size);
      } else {
        const r = particle.size;
        ctx.fillStyle = "#e9b95c";
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 244, 210, .85)";
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.62, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  hasActive() {
    return this.items.some((particle) => particle.active);
  }
}

const particles = new ParticlePool(180);

/* --------------------------------------------------------------------------
   離屏符號紋理：每種符號只繪製一次，之後 drawImage 成本極低
   -------------------------------------------------------------------------- */
const symbolTextures = new Map();
const TEXTURE_SIZE = 256;

function roundRectPath(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function createTexture(draw) {
  const texture = document.createElement("canvas");
  texture.width = TEXTURE_SIZE;
  texture.height = TEXTURE_SIZE;
  const ctx = texture.getContext("2d");
  draw(ctx);
  return texture;
}

function drawStar(ctx, cx, cy, outer, inner, points = 8) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i += 1) {
    const radius = i % 2 === 0 ? outer : inner;
    const angle = (Math.PI * i) / points - Math.PI / 2;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function drawLowCard(ctx, key) {
  const accent = SYMBOLS[key].accent;
  const gradient = ctx.createLinearGradient(30, 20, 220, 236);
  gradient.addColorStop(0, "#fffdf5");
  gradient.addColorStop(0.58, "#f2ead8");
  gradient.addColorStop(1, "#d6c8ad");
  roundRectPath(ctx, 34, 20, 188, 216, 24);
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 4;
  ctx.stroke();

  ctx.strokeStyle = "rgba(20, 20, 20, .16)";
  ctx.lineWidth = 2;
  roundRectPath(ctx, 47, 33, 162, 190, 16);
  ctx.stroke();

  const isTen = key === "10";
  ctx.fillStyle = "#171712";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${isTen ? 90 : 116}px Georgia, "Times New Roman", serif`;
  ctx.fillText(key, 128, isTen ? 112 : 118);
  ctx.fillStyle = accent;
  ctx.font = "700 42px Georgia, serif";
  ctx.fillText(["♠", "♥", "♦", "♣"][Object.keys(SYMBOLS).indexOf(key) % 4], 128, 186);

  ctx.fillStyle = "rgba(255,255,255,.7)";
  ctx.beginPath();
  ctx.arc(205, 42, 4, 0, Math.PI * 2);
  ctx.fill();
}

function drawGem(ctx) {
  ctx.save();
  ctx.shadowColor = "rgba(94, 190, 255, .8)";
  ctx.shadowBlur = 28;
  const gradient = ctx.createLinearGradient(60, 40, 200, 220);
  gradient.addColorStop(0, "#d8f7ff");
  gradient.addColorStop(0.32, "#72d7ff");
  gradient.addColorStop(0.68, "#2f8ff0");
  gradient.addColorStop(1, "#1446a8");
  ctx.beginPath();
  ctx.moveTo(128, 18);
  ctx.lineTo(224, 96);
  ctx.lineTo(186, 224);
  ctx.lineTo(70, 224);
  ctx.lineTo(32, 96);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.strokeStyle = "rgba(230, 250, 255, .9)";
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(128, 18);
  ctx.lineTo(224, 96);
  ctx.lineTo(186, 224);
  ctx.lineTo(70, 224);
  ctx.lineTo(32, 96);
  ctx.closePath();
  ctx.clip();
  ctx.strokeStyle = "rgba(255,255,255,.55)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(128, 18);
  ctx.lineTo(128, 224);
  ctx.moveTo(32, 96);
  ctx.lineTo(224, 96);
  ctx.moveTo(70, 224);
  ctx.lineTo(96, 96);
  ctx.moveTo(186, 224);
  ctx.lineTo(160, 96);
  ctx.stroke();
  ctx.restore();

  drawStar(ctx, 181, 67, 12, 5, 4);
  ctx.fillStyle = "rgba(255,255,255,.92)";
  ctx.fill();
}

function drawCoin(ctx) {
  ctx.save();
  ctx.shadowColor = "rgba(233, 185, 92, .9)";
  ctx.shadowBlur = 26;
  const gradient = ctx.createRadialGradient(100, 82, 10, 128, 128, 100);
  gradient.addColorStop(0, "#fff5c8");
  gradient.addColorStop(0.36, "#f4d277");
  gradient.addColorStop(0.76, "#c89232");
  gradient.addColorStop(1, "#8a5a17");
  ctx.beginPath();
  ctx.arc(128, 128, 98, 0, Math.PI * 2);
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.strokeStyle = "#ffe9a7";
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.restore();

  ctx.strokeStyle = "rgba(105, 63, 9, .45)";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(128, 128, 78, 0, Math.PI * 2);
  ctx.stroke();
  drawStar(ctx, 128, 123, 46, 19, 5);
  ctx.fillStyle = "#7b4f0d";
  ctx.fill();
  ctx.fillStyle = "rgba(255, 248, 210, .78)";
  ctx.font = "700 25px Georgia, serif";
  ctx.textAlign = "center";
  ctx.fillText("LUCKY", 128, 206);
}

function drawSeven(ctx) {
  ctx.save();
  ctx.shadowColor = "rgba(255, 73, 63, .78)";
  ctx.shadowBlur = 30;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const gradient = ctx.createLinearGradient(60, 50, 190, 220);
  gradient.addColorStop(0, "#ffd8cf");
  gradient.addColorStop(0.35, "#ff6d5f");
  gradient.addColorStop(1, "#a51220");
  ctx.font = "700 196px Georgia, serif";
  ctx.fillStyle = gradient;
  ctx.fillText("7", 128, 132);
  ctx.restore();

  ctx.lineWidth = 4;
  ctx.strokeStyle = "rgba(255, 223, 182, .7)";
  ctx.font = "700 196px Georgia, serif";
  ctx.strokeText("7", 128, 132);

  ctx.fillStyle = "#ffe8b1";
  drawStar(ctx, 55, 58, 12, 4, 4);
  ctx.fill();
  drawStar(ctx, 203, 201, 9, 3, 4);
  ctx.fill();
}

function drawWild(ctx) {
  ctx.save();
  ctx.shadowColor = "rgba(255, 111, 97, .75)";
  ctx.shadowBlur = 26;
  const gradient = ctx.createLinearGradient(20, 30, 230, 230);
  gradient.addColorStop(0, "#ffb08d");
  gradient.addColorStop(0.4, "#e85473");
  gradient.addColorStop(0.75, "#8f2c8f");
  gradient.addColorStop(1, "#3a246d");
  roundRectPath(ctx, 24, 40, 208, 176, 30);
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 238, 206, .85)";
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = "rgba(255,255,255,.18)";
  roundRectPath(ctx, 38, 52, 180, 58, 20);
  ctx.fill();

  ctx.fillStyle = "#fff8e8";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "700 68px Georgia, serif";
  ctx.fillText("WILD", 128, 126);
  ctx.font = "700 24px ui-monospace, monospace";
  ctx.fillStyle = "rgba(255, 238, 206, .82)";
  ctx.fillText("×2 IN FREE SPIN", 128, 176);
}

function drawScatter(ctx) {
  ctx.save();
  ctx.shadowColor = "rgba(94, 216, 170, .8)";
  ctx.shadowBlur = 34;
  const gradient = ctx.createRadialGradient(128, 112, 8, 128, 128, 112);
  gradient.addColorStop(0, "#fff7cf");
  gradient.addColorStop(0.35, "#8ff0c8");
  gradient.addColorStop(0.75, "#2ca57d");
  gradient.addColorStop(1, "#0e5a47");
  drawStar(ctx, 128, 122, 104, 42, 8);
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 247, 207, .9)";
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = "#f5fff8";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "700 40px Georgia, serif";
  ctx.fillText("FREE", 128, 122);
  ctx.font = "700 17px ui-monospace, monospace";
  ctx.fillStyle = "rgba(255,255,255,.82)";
  ctx.fillText("3+ TRIGGER", 128, 163);
}

function buildSymbolTexture(key) {
  if (symbolTextures.has(key)) return symbolTextures.get(key);
  let texture;
  if (["10", "J", "Q", "K", "A"].includes(key)) {
    texture = createTexture((ctx) => drawLowCard(ctx, key));
  } else if (key === "GEM") texture = createTexture(drawGem);
  else if (key === "COIN") texture = createTexture(drawCoin);
  else if (key === "SEVEN") texture = createTexture(drawSeven);
  else if (key === "WILD") texture = createTexture(drawWild);
  else texture = createTexture(drawScatter);
  symbolTextures.set(key, texture);
  return texture;
}

/* 預先建立全部紋理，避免第一次旋轉時卡頓 */
Object.keys(SYMBOLS).forEach(buildSymbolTexture);

/* --------------------------------------------------------------------------
   Canvas 尺寸與 DPR
   -------------------------------------------------------------------------- */
const ctx = canvas.getContext("2d", { alpha: false });
let viewScale = 1;
let lastFrameTime = 0;
let rafId = 0;
let stopCheckPending = false;

function fitCanvas() {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.width * (LOGICAL_H / LOGICAL_W) * dpr);
  viewScale = canvas.width / LOGICAL_W;
  draw(performance.now());
}

function inviewScale() {
  return viewScale;
}

/* --------------------------------------------------------------------------
   繪圖
   -------------------------------------------------------------------------- */
function mod(value, length) {
  return ((value % length) + length) % length;
}

function reelX(index) {
  return PAD_X + index * (REEL_W + GAP);
}

function rowCenterY(row) {
  return PAD_Y + row * CELL_H + CELL_H / 2;
}

function drawBackground(ctx, now) {
  const bg = ctx.createLinearGradient(0, 0, 0, LOGICAL_H);
  bg.addColorStop(0, "#0a211c");
  bg.addColorStop(0.55, "#071b17");
  bg.addColorStop(1, "#04100e");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);

  const glow = ctx.createRadialGradient(
    LOGICAL_W / 2,
    LOGICAL_H * 0.12,
    20,
    LOGICAL_W / 2,
    LOGICAL_H * 0.12,
    LOGICAL_W * 0.7,
  );
  glow.addColorStop(0, "rgba(94, 216, 170, .14)");
  glow.addColorStop(1, "rgba(94, 216, 170, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);

  // 極細的賭桌紋理
  ctx.save();
  ctx.globalAlpha = 0.05;
  ctx.strokeStyle = "#d7c39a";
  ctx.lineWidth = 1;
  for (let x = -LOGICAL_H; x < LOGICAL_W; x += 24) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + LOGICAL_H, LOGICAL_H);
    ctx.stroke();
  }
  ctx.restore();

  // 頂部與底部漸暗，增加景深
  const topShade = ctx.createLinearGradient(0, 0, 0, 80);
  topShade.addColorStop(0, "rgba(0,0,0,.45)");
  topShade.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = topShade;
  ctx.fillRect(0, 0, LOGICAL_W, 80);
  const bottomShade = ctx.createLinearGradient(0, LOGICAL_H - 90, 0, LOGICAL_H);
  bottomShade.addColorStop(0, "rgba(0,0,0,0)");
  bottomShade.addColorStop(1, "rgba(0,0,0,.5)");
  ctx.fillStyle = bottomShade;
  ctx.fillRect(0, LOGICAL_H - 90, LOGICAL_W, 90);

  // 環境光點
  const t = now / 1000;
  ctx.save();
  ctx.globalAlpha = 0.28;
  ctx.fillStyle = "#a7f3d0";
  for (let i = 0; i < 9; i += 1) {
    const x = 80 + ((i * 137 + t * 9) % (LOGICAL_W - 160));
    const y = 40 + ((i * 73 + Math.sin(t + i) * 18) % 430);
    ctx.beginPath();
    ctx.arc(x, y, 1.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawReelFrame(ctx, index) {
  const x = reelX(index);
  roundRectPath(ctx, x, PAD_Y, REEL_W, CELL_H * ROW_COUNT, 15);
  const gradient = ctx.createLinearGradient(x, PAD_Y, x + REEL_W, PAD_Y + CELL_H * ROW_COUNT);
  gradient.addColorStop(0, "#0d2822");
  gradient.addColorStop(0.5, "#09201b");
  gradient.addColorStop(1, "#061612");
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.strokeStyle = "rgba(233, 185, 92, .22)";
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // 固定列分隔線
  ctx.save();
  ctx.globalAlpha = 0.22;
  ctx.strokeStyle = "rgba(233, 185, 92, .32)";
  ctx.lineWidth = 1;
  for (let row = 1; row < ROW_COUNT; row += 1) {
    const y = PAD_Y + row * CELL_H;
    ctx.beginPath();
    ctx.moveTo(x + 10, y);
    ctx.lineTo(x + REEL_W - 10, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawSymbolAt(ctx, key, x, y, size) {
  const texture = buildSymbolTexture(key);
  ctx.drawImage(texture, x - size / 2, y - size / 2, size, size);
}

function drawReelStrip(ctx, reel, index, now) {
  const x = reelX(index);
  const bounceProgress = reel.bounceAt
    ? Math.min(1, (now - reel.bounceAt) / 260)
    : 1;
  const bounceY = bounceProgress < 1
    ? Math.sin(bounceProgress * Math.PI) * 10 * (1 - bounceProgress)
    : 0;

  ctx.save();
  roundRectPath(ctx, x + 2, PAD_Y + 2, REEL_W - 4, CELL_H * ROW_COUNT - 4, 13);
  ctx.clip();
  ctx.translate(0, bounceY);

  const position = reel.position;
  const base = Math.floor(position);
  const frac = position - base;
  const size = Math.min(REEL_W * 0.88, CELL_H * 0.88);
  const fast = Boolean(reel.anim) && (now - reel.anim.start) / reel.anim.duration < 0.86;

  for (let row = -1; row <= ROW_COUNT + 1; row += 1) {
    const stripIndex = mod(base + row, reel.strip.length);
    const key = reel.strip[stripIndex];
    const centerX = x + REEL_W / 2;
    const centerY = PAD_Y + (row - frac) * CELL_H + CELL_H / 2;

    // 旋轉中的輕微動態模糊：以低透明度重複繪製一次
    if (fast) {
      ctx.globalAlpha = 0.22;
      drawSymbolAt(ctx, key, centerX, centerY - 13, size);
      ctx.globalAlpha = 1;
    }
    drawSymbolAt(ctx, key, centerX, centerY, size);
  }

  // 頂部與底部淡出，模擬實體滾輪的陰影
  const shade = ctx.createLinearGradient(0, PAD_Y, 0, PAD_Y + CELL_H * ROW_COUNT);
  shade.addColorStop(0, "rgba(0,0,0,.42)");
  shade.addColorStop(0.18, "rgba(0,0,0,0)");
  shade.addColorStop(0.82, "rgba(0,0,0,0)");
  shade.addColorStop(1, "rgba(0,0,0,.42)");
  ctx.fillStyle = shade;
  ctx.fillRect(x, PAD_Y, REEL_W, CELL_H * ROW_COUNT);
  ctx.restore();

  if (reel.flashUntil > now) {
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = "#ffe6a6";
    ctx.lineWidth = 2;
    roundRectPath(ctx, x + 1, PAD_Y + 1, REEL_W - 2, CELL_H * ROW_COUNT - 2, 15);
    ctx.stroke();
    ctx.restore();
  }
}

function cellRect(reelIndex, row, inset = 5) {
  return {
    x: reelX(reelIndex) + inset,
    y: PAD_Y + row * CELL_H + inset,
    width: REEL_W - inset * 2,
    height: CELL_H - inset * 2,
  };
}

function drawHighlights(ctx, now) {
  if (!highlight) return;
  const elapsed = now - highlight.startedAt;
  const fade = Math.min(1, elapsed / 260);
  const pulse = 0.72 + Math.sin(now / 180) * 0.28;

  ctx.save();
  ctx.globalAlpha = fade;
  ctx.shadowColor = "rgba(233, 185, 92, .85)";
  ctx.shadowBlur = 18;
  for (const cell of highlight.cells) {
    const rect = cellRect(cell.reel, cell.row, 6);
    roundRectPath(ctx, rect.x, rect.y, rect.width, rect.height, 13);
    ctx.fillStyle = `rgba(233, 185, 92, ${0.1 * pulse})`;
    ctx.fill();
    ctx.strokeStyle = `rgba(255, 228, 160, ${0.75 * pulse})`;
    ctx.lineWidth = 2.2;
    ctx.stroke();
  }

  // 每條中獎線依序畫出
  const lineDuration = reduceMotion ? 1 : 420;
  const lineProgress = Math.min(1, (elapsed - 80) / lineDuration);
  if (lineProgress > 0) {
    highlight.lines.forEach((win) => {
      const points = win.line.map((row, reelIndex) => ({
        x: reelX(reelIndex) + REEL_W / 2,
        y: rowCenterY(row),
      }));
      const segmentCount = points.length - 1;
      const totalToDraw = lineProgress * segmentCount;
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 0; i < segmentCount; i += 1) {
        const local = Math.max(0, Math.min(1, totalToDraw - i));
        if (local <= 0) break;
        const next = points[i + 1];
        ctx.lineTo(
          points[i].x + (next.x - points[i].x) * local,
          points[i].y + (next.y - points[i].y) * local,
        );
      }
      ctx.strokeStyle = "rgba(255, 224, 144, .85)";
      ctx.lineWidth = 2.4;
      ctx.shadowColor = "rgba(233, 185, 92, .9)";
      ctx.shadowBlur = 14;
      ctx.stroke();
      for (const point of points) {
        ctx.beginPath();
        ctx.arc(point.x, point.y, 3, 0, Math.PI * 2);
        ctx.fillStyle = "#ffe8b1";
        ctx.fill();
      }
    });
  }
  ctx.restore();
}

let shakeUntil = 0;

function draw(now) {
  if (!ctx) return;
  ctx.setTransform(viewScale, 0, 0, viewScale, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.clearRect(0, 0, LOGICAL_W, LOGICAL_H);

  if (shakeUntil > now && !reduceMotion) {
    const power = ((shakeUntil - now) / 300) * 5;
    ctx.translate(
      (Math.random() - 0.5) * power,
      (Math.random() - 0.5) * power,
    );
  }

  drawBackground(ctx, now);
  for (let i = 0; i < REEL_COUNT; i += 1) drawReelFrame(ctx, i);
  for (let i = 0; i < REEL_COUNT; i += 1) {
    drawReelStrip(ctx, reels[i], i, now);
  }
  drawHighlights(ctx, now);
  particles.draw(ctx);

  // 畫布內的小型狀態字樣（不影響 DOM 的可存取資訊）
  ctx.save();
  ctx.globalAlpha = 0.42;
  ctx.fillStyle = "#d9cfb6";
  ctx.font = "600 12px ui-monospace, monospace";
  ctx.textAlign = "left";
  ctx.fillText("LUCKYFORGE LAB · 5×3 · 10 LINES", PAD_X, LOGICAL_H - 12);
  ctx.textAlign = "right";
  ctx.fillText("DEMO CREDITS ONLY", LOGICAL_W - PAD_X, LOGICAL_H - 12);
  ctx.restore();
}

/* --------------------------------------------------------------------------
   動畫主迴圈：只有需要時才 requestAnimationFrame
   -------------------------------------------------------------------------- */
function needsAnimation(now) {
  if (reels.some((reel) => reel.anim)) return true;
  if (particles.hasActive()) return true;
  if (highlight && now - highlight.startedAt < 1900) return true;
  if (shakeUntil > now) return true;
  if (machine && (machine.state === "evaluating" || machine.state === "bigwin")) return true;
  if (reels.some((reel) => now - reel.bounceAt < 280)) return true;
  return false;
}

function frame(now) {
  rafId = 0;
  const dt = Math.min(0.05, Math.max(0, (now - lastFrameTime) / 1000));
  lastFrameTime = now;

  updateReels(now);
  particles.update(dt);
  draw(now);

  if (needsAnimation(now)) {
    rafId = window.requestAnimationFrame(frame);
  }
}

function requestDraw() {
  if (rafId) return;
  lastFrameTime = performance.now();
  rafId = window.requestAnimationFrame(frame);
}

/* --------------------------------------------------------------------------
   滾輪更新與停止判定
   -------------------------------------------------------------------------- */
function updateReels(now) {
  let stoppedThisFrame = false;
  for (const reel of reels) {
    if (!reel.anim) continue;
    const progress = Math.min(1, (now - reel.anim.start) / reel.anim.duration);
    if (progress >= 1) {
      reel.position = reel.anim.finalPos;
      reel.anim = null;
      reel.bounceAt = now;
      reel.flashUntil = now + 260;
      sfx("reel");
      stoppedThisFrame = true;
    } else {
      const eased = 1 - Math.pow(1 - progress, 4);
      reel.position = reel.anim.startPos + reel.anim.delta * eased;
    }
  }

  if (
    stoppedThisFrame &&
    !stopCheckPending &&
    reels.every((reel) => !reel.anim) &&
    machine.state === "spinning"
  ) {
    stopCheckPending = true;
    window.setTimeout(() => {
      stopCheckPending = false;
      if (machine.state === "spinning") {
        machine.send("REELS_STOPPED");
      }
    }, 240);
  }
}

/* --------------------------------------------------------------------------
   遊戲流程
   -------------------------------------------------------------------------- */
function saveState() {
  saveJSON("slots", { balance, bet });
}

function updateHud() {
  if (balanceEl) balanceEl.textContent = formatCredits(balance);
  if (betEl) betEl.textContent = formatCredits(bet);
  if (betStepperEl) betStepperEl.textContent = formatCredits(bet);
  if (winEl) winEl.textContent = formatCredits(lastWin);
  if (fsEl) fsEl.textContent = fsRemaining > 0 ? `${fsRemaining} 轉` : "—";
  if (freeCountEl) {
    freeCountEl.textContent = `${fsRemaining} / ${fsTotal}`;
  }
  if (freeBanner) freeBanner.hidden = !(fsRemaining > 0);
}

function announce(message) {
  if (srEl) srEl.textContent = message;
  if (statusEl) statusEl.textContent = message;
}

function refreshControls() {
  if (!machine) return;
  const state = machine.state;
  const busy = state === "spinning" || state === "evaluating" || state === "bigwin";
  const inFree = state === "freespin";
  if (spinBtn) {
    spinBtn.disabled = busy || inFree || (state === "idle" && balance < bet);
    spinBtn.textContent = inFree ? "免費旋轉中" : "旋轉";
  }
  if (betDown) betDown.disabled = busy || state !== "idle";
  if (betUp) betUp.disabled = busy || state !== "idle";
  if (resetBtn) resetBtn.disabled = busy || inFree;
  if (stateEl) stateEl.textContent = state.toUpperCase();
  updateHud();
}

function setBet(nextBet) {
  if (machine.state !== "idle") return;
  bet = nextBet;
  saveState();
  sfx("click");
  updateHud();
  refreshControls();
  announce(`投注額調整為 ${formatCredits(bet)} 點，每線 ${formatCredits(bet / 10)} 點。`);
}

function chooseBet(direction) {
  const index = BET_LEVELS.indexOf(bet);
  const nextIndex = Math.max(0, Math.min(BET_LEVELS.length - 1, index + direction));
  if (nextIndex === index) return;
  setBet(BET_LEVELS[nextIndex]);
}

function buildGrid() {
  return reels.map((reel, reelIndex) => {
    const top = reel.finalPos || reel.position;
    const base = Math.floor(top);
    return Array.from({ length: ROW_COUNT }, (_, row) =>
      reel.strip[mod(base + row, reel.strip.length)],
    );
  });
}

function evaluateGrid(grid) {
  const lineBet = bet / 10;
  const wins = [];
  let lineTotal = 0;

  PAYLINES.forEach((line, lineIndex) => {
    const first = grid[0][line[0]];
    if (first === "SCATTER") return;

    let best = null;
    for (const candidate of lineCandidates) {
      let count = 0;
      for (let reelIndex = 0; reelIndex < REEL_COUNT; reelIndex += 1) {
        const symbol = grid[reelIndex][line[reelIndex]];
        if (symbol === candidate || symbol === "WILD") count += 1;
        else break;
      }
      if (count < 3) continue;
      const pay = SYMBOLS[candidate].pay[count] || 0;
      if (!best || pay > best.pay) {
        best = { candidate, count, pay };
      }
    }

    if (best) {
      const amount = Math.round(best.pay * lineBet);
      lineTotal += amount;
      wins.push({
        lineIndex,
        line,
        symbol: best.candidate,
        count: best.count,
        amount,
      });
    }
  });

  const scatterCells = [];
  grid.forEach((column, reelIndex) => {
    column.forEach((symbol, row) => {
      if (symbol === "SCATTER") scatterCells.push({ reel: reelIndex, row });
    });
  });

  const scatterCount = scatterCells.length;
  // 5 個以上 SCATTER 一律套用最高賠付（盤面最多可出現 15 個）
  const scatterPay = scatterCount >= 5
    ? SYMBOLS.SCATTER.pay[5]
    : SYMBOLS.SCATTER.pay[scatterCount] || 0;
  const scatterWin = Math.round(scatterPay * bet);
  const baseWin = lineTotal + scatterWin;
  const totalWin = Math.round(baseWin * (currentSpinWasFree ? 2 : 1));

  return {
    wins,
    lineTotal,
    scatterCells,
    scatterCount,
    scatterWin,
    totalWin,
    freeAward: scatterCount >= 3
      ? scatterCount >= 5
        ? 20
        : scatterCount === 4
          ? 15
          : 10
      : 0,
  };
}

function startSpin() {
  if (!["idle", "freespin"].includes(machine.state)) return;
  if (machine.state === "idle" && balance < bet) {
    announce("虛擬籌碼不足，請按「補充籌碼」重新開始。");
    sfx("lose");
    return;
  }

  unlockAudio();
  currentSpinWasFree = machine.state === "freespin";
  if (!currentSpinWasFree) {
    balance -= bet;
  }
  spinCounter += 1;
  lastWin = 0;
  highlight = null;
  freeRoundWin = 0;
  updateHud();

  const now = performance.now();
  reels.forEach((reel, index) => {
    const finalPos = randomInt(reel.strip.length);
    const startPos = reel.position % reel.strip.length;
    const forward = mod(finalPos - startPos, reel.strip.length);
    const extraTurns = 4 + index * 2 + randomInt(2);
    reel.finalPos = finalPos;
    reel.anim = {
      start: now,
      startPos,
      delta: forward + extraTurns * reel.strip.length,
      duration: reduceMotion ? 320 + index * 60 : 980 + index * 165,
      finalPos,
    };
    reel.bounceAt = 0;
  });

  if (!machine.send("SPIN")) {
    // 理論上不會發生；若發生，退還投注避免卡住
    if (!currentSpinWasFree) balance += bet;
    updateHud();
    return;
  }

  sfx("spin");
  announce(
    currentSpinWasFree
      ? `免費旋轉開始，剩餘 ${fsRemaining} 轉，獎金加倍。`
      : `第 ${spinCounter} 轉開始，投注 ${formatCredits(bet)} 點。`,
  );
  requestDraw();

  /* 安全網：rAF 被背景或低階裝置凍結時，滾輪可能永遠停在 spinning。
     逾時後直接把滾輪推到最終停位並結算，避免「扣了籌碼卻卡住」。 */
  window.clearTimeout(spinGuardTimer);
  spinGuardTimer = window.setTimeout(() => {
    if (machine.state !== "spinning") return;
    let forced = false;
    const now = performance.now();
    for (const reel of reels) {
      if (!reel.anim) continue;
      reel.position = reel.anim.finalPos;
      reel.anim = null;
      reel.bounceAt = now;
      forced = true;
    }
    if (forced) {
      requestDraw();
      machine.send("REELS_STOPPED");
    }
  }, 2800);
}

function evaluateRound() {
  if (evaluatingRound) return;
  evaluatingRound = true;
  const grid = buildGrid();
  const result = evaluateGrid(grid);
  const free = currentSpinWasFree;

  if (result.freeAward > 0) {
    pendingFreeAward = result.freeAward;
  }
  if (free) {
    freeRoundWin += result.totalWin;
  }

  lastWin = result.totalWin;
  balance += result.totalWin;
  saveState();

  if (result.totalWin > 0) {
    const cells = new Map();
    for (const win of result.wins) {
      win.line.slice(0, win.count).forEach((row, reelIndex) => {
        cells.set(`${reelIndex}-${row}`, { reel: reelIndex, row });
      });
    }
    for (const cell of result.scatterCells) {
      cells.set(`${cell.reel}-${cell.row}`, cell);
    }
    highlight = {
      cells: [...cells.values()],
      lines: result.wins,
      startedAt: performance.now(),
    };

    // 從中獎格噴出金幣
    if (!reduceMotion) {
      for (const cell of cells.values()) {
        const rect = cellRect(cell.reel, cell.row, 0);
        for (let i = 0; i < 3; i += 1) {
          particles.spawn({
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
            vx: (Math.random() - 0.5) * 180,
            vy: -120 - Math.random() * 180,
            life: 0.8 + Math.random() * 0.5,
            size: 4 + Math.random() * 4,
            rotation: Math.random() * Math.PI,
            spin: (Math.random() - 0.5) * 12,
            kind: Math.random() > 0.3 ? "coin" : "spark",
          });
        }
      }
    }
    sfx(result.totalWin >= bet * 10 ? "bigwin" : "win");
  } else {
    sfx("lose");
  }

  updateHud();
  refreshControls();

  const parts = [];
  if (result.wins.length) {
    parts.push(`${result.wins.length} 條連線`);
  }
  if (result.scatterCount >= 3) {
    parts.push(`${result.scatterCount} 個 SCATTER`);
  }
  if (result.totalWin > 0) {
    parts.push(`贏得 ${formatCredits(result.totalWin)} 點`);
  } else {
    parts.push("本轉無中獎");
  }
  if (result.freeAward > 0) {
    parts.push(`觸發 ${result.freeAward} 次免費旋轉`);
  }
  announce(parts.join("，"));

  const delay = reduceMotion ? 350 : 1450;
  window.clearTimeout(evaluateTimer);
  evaluateTimer = window.setTimeout(finishEvaluation, delay);
  requestDraw();
}

function finishEvaluation() {
  const grandTotal = lastWin;
  let award = pendingFreeAward;
  pendingFreeAward = 0;

  if (currentSpinWasFree) {
    fsRemaining = Math.max(0, fsRemaining - 1);
  }

  if (award > 0) {
    fsRemaining += award;
    fsTotal += award;
    fsRemaining = Math.min(50, fsRemaining);
    freeBanner?.classList.add("is-triggered");
    sfx("freespin");
    announce(
      `觸發免費遊戲！獲得 ${award} 次免費旋轉，剩餘 ${fsRemaining} 轉。所有獎金 ×2。`,
    );
    window.setTimeout(() => freeBanner?.classList.remove("is-triggered"), 1600);
  }

  updateHud();

  if (grandTotal >= bet * 10) {
    machine.send("BIGWIN");
    return;
  }
  if (fsRemaining > 0) {
    machine.send("FS_START");
  } else {
    machine.send("END");
  }
}

function enterFreeSpin() {
  if (fsRemaining <= 0) {
    machine.send("END");
    return;
  }
  updateHud();
  refreshControls();
  announce(`免費遊戲進行中，剩餘 ${fsRemaining} 轉，所有獎金 ×2。`);
  window.clearTimeout(autoSpinTimer);
  autoSpinTimer = window.setTimeout(() => {
    if (machine.state === "freespin") startSpin();
  }, reduceMotion ? 350 : 1100);
}

function exitFreeSpin() {
  window.clearTimeout(autoSpinTimer);
  freeBanner?.classList.remove("is-triggered");
  if (fsRemaining <= 0) {
    if (freeRoundWin > 0) {
      announce(`免費遊戲結束，本輪免費遊戲共贏得 ${formatCredits(freeRoundWin)} 點。`);
    } else {
      announce("免費遊戲結束。");
    }
    fsTotal = 0;
    freeRoundWin = 0;
    updateHud();
  }
}

function showBigWin() {
  if (!bigWinEl) return;
  const ratio = bet > 0 ? lastWin / bet : 0;
  let tier = "NICE WIN";
  if (ratio >= 100) tier = "LEGENDARY";
  else if (ratio >= 50) tier = "MEGA WIN";
  else if (ratio >= 25) tier = "BIG WIN";
  if (bigWinTierEl) bigWinTierEl.textContent = tier;
  if (bigWinAmountEl) {
    bigWinAmountEl.replaceChildren();
    const value = document.createElement("span");
    value.textContent = "0";
    const unit = document.createElement("small");
    unit.textContent = " 點";
    bigWinAmountEl.append(value, unit);
    bigWinAmountEl.dataset.prefix = "+";
  }

  lastFocused = document.activeElement;
  bigWinEl.hidden = false;
  window.setTimeout(() => bigWinContinue?.focus(), 30);

  if (!reduceMotion) {
    shakeUntil = performance.now() + 400;
    const count = tier === "LEGENDARY" ? 90 : ratio >= 50 ? 70 : 50;
    for (let i = 0; i < count; i += 1) {
      particles.spawn({
        x: LOGICAL_W / 2 + (Math.random() - 0.5) * 120,
        y: LOGICAL_H / 2 + (Math.random() - 0.5) * 60,
        vx: (Math.random() - 0.5) * 720,
        vy: -260 - Math.random() * 480,
        life: 1.4 + Math.random() * 1.1,
        size: 4 + Math.random() * 7,
        rotation: Math.random() * Math.PI,
        spin: (Math.random() - 0.5) * 16,
        kind: Math.random() > 0.22 ? "coin" : "spark",
      });
    }
  }

  const start = performance.now();
  const duration = reduceMotion ? 0 : 1250;
  const valueNode = bigWinAmountEl?.querySelector("span");
  window.cancelAnimationFrame(countUpFrame);

  const tick = (now) => {
    const progress = duration === 0 ? 1 : Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    if (valueNode) {
      valueNode.textContent = `${bigWinAmountEl.dataset.prefix || ""}${formatCredits(
        Math.round(lastWin * eased),
      )}`;
    }
    if (progress < 1) {
      countUpFrame = window.requestAnimationFrame(tick);
    }
  };
  countUpFrame = window.requestAnimationFrame(tick);
  requestDraw();
}

function hideBigWin() {
  window.cancelAnimationFrame(countUpFrame);
  if (bigWinEl) bigWinEl.hidden = true;
  if (lastFocused instanceof HTMLElement && lastFocused.isConnected) {
    lastFocused.focus();
  }
  lastFocused = null;
}

/* --------------------------------------------------------------------------
   FSM 設定
   -------------------------------------------------------------------------- */
const machine = new StateMachine(
  "idle",
  {
    idle: {
      onEnter: () => {
        updateHud();
        refreshControls();
      },
      on: {
        SPIN: { target: "spinning" },
      },
    },
    spinning: {
      on: {
        REELS_STOPPED: { target: "evaluating", action: evaluateRound },
      },
    },
    evaluating: {
      on: {
        BIGWIN: { target: "bigwin" },
        FS_START: { target: "freespin" },
        END: { target: "idle" },
      },
    },
    bigwin: {
      onEnter: showBigWin,
      onExit: hideBigWin,
      on: {
        CONTINUE: { target: "idle" },
        CONTINUE_FS: { target: "freespin" },
      },
    },
    freespin: {
      onEnter: enterFreeSpin,
      onExit: exitFreeSpin,
      on: {
        SPIN: { target: "spinning" },
        END: { target: "idle" },
      },
    },
  },
  { balance, bet },
);

machine.onTransition(() => {
  evaluatingRound = false;
  refreshControls();
});

/* --------------------------------------------------------------------------
   事件綁定
   -------------------------------------------------------------------------- */
spinBtn?.addEventListener("click", () => {
  unlockAudio();
  if (machine.state === "freespin") return; // 免費遊戲由計時器自動進行
  startSpin();
});
betDown?.addEventListener("click", () => chooseBet(-1));
betUp?.addEventListener("click", () => chooseBet(1));
resetBtn?.addEventListener("click", () => {
  if (!["idle"].includes(machine.state)) return;
  balance = DEFAULT_STATE.balance;
  lastWin = 0;
  spinCounter = 0;
  fsRemaining = 0;
  fsTotal = 0;
  freeRoundWin = 0;
  pendingFreeAward = 0;
  highlight = null;
  saveState();
  updateHud();
  refreshControls();
  sfx("cash");
  announce("已補充 10,000 點虛擬籌碼。");
  requestDraw();
});

bigWinContinue?.addEventListener("click", () => {
  if (machine.state !== "bigwin") return;
  sfx("click");
  if (fsRemaining > 0) machine.send("CONTINUE_FS");
  else machine.send("CONTINUE");
});

document.addEventListener("keydown", (event) => {
  if (
    (event.code === "Space" || event.key === " ") &&
    !event.target.closest("button, a, input, select, textarea, [contenteditable]") &&
    (!bigWinEl || bigWinEl.hidden)
  ) {
    if (machine.state === "idle") {
      event.preventDefault();
      unlockAudio();
      startSpin();
    }
  }

  /* Big Win 對話框：鎖住 Tab 焦點，避免焦點跑到背景內容 */
  if (event.key === "Tab" && bigWinEl && !bigWinEl.hidden) {
    const focusables = [
      ...bigWinEl.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((node) => node.offsetParent !== null);
    if (!focusables.length) {
      event.preventDefault();
      bigWinEl.focus();
    } else {
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && (document.activeElement === first || !bigWinEl.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !bigWinEl.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  if (event.key === "Escape" && bigWinEl && !bigWinEl.hidden) {
    bigWinContinue?.click();
  }
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    lastFrameTime = performance.now();
    requestDraw();
  }
});

/* 初始化 */
if (canvas && ctx) {
  fitCanvas();
  if ("ResizeObserver" in window) {
    const observer = new ResizeObserver(() => fitCanvas());
    observer.observe(canvas);
  } else {
    window.addEventListener("resize", fitCanvas, { passive: true });
  }
  updateHud();
  refreshControls();
  announce(
    "老虎機已就緒。按「旋轉」或空白鍵開始；投注可調整，所有點數皆為虛擬點數。",
  );
  draw(performance.now());
}
