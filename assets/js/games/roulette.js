/**
 * 歐洲輪盤 Roulette：37 格、Canvas 轉輪、下注板、籌碼與派彩
 * ---------------------------------------------------------------------------
 * 使用 crypto.getRandomValues 產生結果；轉輪與球以 easeOutQuint 收尾，
 * 確保「結果先決定、動畫只負責呈現」，不讓動畫影響機率。
 * 正式環境請由伺服器產生並簽章結果，前端只播放對應動畫。
 */

import { randomInt } from "../lib/rng.js";
import { formatCredits, loadJSON, saveJSON, clamp } from "../lib/storage.js";
import { sfx, unlockAudio } from "../lib/audio.js";

const $ = (id) => document.getElementById(id);
const canvas = $("roulette-canvas");
const balanceEl = $("roulette-balance");
const totalBetEl = $("roulette-total-bet");
const spinsEl = $("roulette-spins");
const resultNumberEl = $("roulette-result-number");
const resultTextEl = $("roulette-result-text");
const historyEl = $("roulette-history");
const spinBtn = $("roulette-spin");
const clearBtn = $("roulette-clear");
const repeatBtn = $("roulette-repeat");
const resetBtn = $("roulette-reset");
const numberGrid = $("roulette-number-grid");
const outsideGrid = $("roulette-outside-grid");
const statusEl = $("roulette-status");
const srEl = $("roulette-sr");
const chipButtons = [...document.querySelectorAll("[data-roulette-chip]")];

const WHEEL_SEQUENCE = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5,
  24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
];
const RED_NUMBERS = new Set([
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
]);
const CHIP_VALUES = [10, 50, 100, 500];
const DEFAULT_STATE = { balance: 10000, chip: 50 };
const BET_KEYS = [
  "red", "black", "odd", "even", "low", "high",
  "dozen:1", "dozen:2", "dozen:3",
  "col:1", "col:2", "col:3",
];
const OUTSIDE_BETS = [
  { key: "red", label: "紅色", odds: "1:1", color: "red" },
  { key: "black", label: "黑色", odds: "1:1", color: "black" },
  { key: "odd", label: "單數", odds: "1:1" },
  { key: "even", label: "雙數", odds: "1:1" },
  { key: "low", label: "小 1–18", odds: "1:1" },
  { key: "high", label: "大 19–36", odds: "1:1" },
  { key: "dozen:1", label: "第一打 1–12", odds: "2:1" },
  { key: "dozen:2", label: "第二打 13–24", odds: "2:1" },
  { key: "dozen:3", label: "第三打 25–36", odds: "2:1" },
  { key: "col:1", label: "直行 1,4,7…", odds: "2:1" },
  { key: "col:2", label: "直行 2,5,8…", odds: "2:1" },
  { key: "col:3", label: "直行 3,6,9…", odds: "2:1" },
];
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let state = {
  balance: DEFAULT_STATE.balance,
  chip: DEFAULT_STATE.chip,
  bets: {},
  lastBets: {},
  history: [],
  spins: 0,
};
let phase = "idle";
let spinAnimation = null;
let spinGuardTimer = 0;
let rafId = 0;
let viewScale = 1;
let wheelRotation = 0;
let ballAngle = -Math.PI / 2;
let ballRadius = 212;
let lastTickAt = 0;
let hitHighlight = null;

/* --------------------------------------------------------------------------
   初始化
   -------------------------------------------------------------------------- */
function sanitizeBets(value) {
  const result = {};
  if (!value || typeof value !== "object") return result;
  for (const [key, amount] of Object.entries(value)) {
    if (!isValidBetKey(key)) continue;
    const number = Number(amount);
    if (Number.isFinite(number) && number > 0) result[key] = Math.round(number);
  }
  return result;
}

function restoreState() {
  const saved = loadJSON("roulette", null);
  if (saved && Number.isFinite(saved.balance)) {
    state = {
      balance: Math.max(0, Math.round(saved.balance)),
      chip: CHIP_VALUES.includes(saved.chip) ? saved.chip : DEFAULT_STATE.chip,
      bets: sanitizeBets(saved.bets),
      lastBets: sanitizeBets(saved.lastBets),
      history: Array.isArray(saved.history)
        ? saved.history
            .filter((number) => Number.isInteger(number) && number >= 0 && number <= 36)
            .slice(0, 12)
        : [],
      spins: Math.max(0, Number(saved.spins) || 0),
    };
    if (state.history.length) {
      renderHistory();
      showLastResult(state.history[0], "已恢復上次結果");
    }
  }
}

function persist() {
  saveJSON("roulette", {
    balance: state.balance,
    chip: state.chip,
    bets: state.bets,
    lastBets: state.lastBets,
    history: state.history,
    spins: state.spins,
  });
}

/* --------------------------------------------------------------------------
   下注板建立
   -------------------------------------------------------------------------- */
function isValidBetKey(key) {
  if (/^n:(?:[0-9]|[12][0-9]|3[0-6])$/.test(key)) return true;
  return BET_KEYS.includes(key);
}

function colorOf(number) {
  if (number === 0) return "green";
  return RED_NUMBERS.has(number) ? "red" : "black";
}

function colorName(number) {
  return { green: "綠色", red: "紅色", black: "黑色" }[colorOf(number)];
}

function addBadge(button, className) {
  const badge = document.createElement("span");
  badge.className = className;
  button.append(badge);
  return badge;
}

function buildBoard() {
  if (!numberGrid || !outsideGrid) return;
  numberGrid.replaceChildren();
  outsideGrid.replaceChildren();

  for (let number = 1; number <= 36; number += 1) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "number-cell";
    button.dataset.rouletteNumber = String(number);
    button.dataset.rouletteBet = `n:${number}`;
    button.dataset.color = colorOf(number);
    button.dataset.baseLabel = `號碼 ${number}，${colorName(number)}`;
    button.setAttribute("aria-label", `${button.dataset.baseLabel}，尚未下注`);
    button.textContent = String(number);
    addBadge(button, "number-cell__chips");
    numberGrid.append(button);
  }

  for (const bet of OUTSIDE_BETS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "outside-cell";
    button.dataset.rouletteBet = bet.key;
    button.dataset.baseLabel = `${bet.label}，賠率 ${bet.odds}`;
    if (bet.color) button.dataset.color = bet.color;
    button.setAttribute("aria-label", `${bet.label}，尚未下注`);
    button.innerHTML = `${bet.label}<small>${bet.odds}</small>`;
    addBadge(button, "outside-cell__chips");
    outsideGrid.append(button);
  }
}

function renderHistory() {
  if (!historyEl) return;
  historyEl.replaceChildren();
  for (const number of state.history.slice(0, 8)) {
    const pill = document.createElement("span");
    pill.className = "history-pill";
    pill.dataset.color = colorOf(number);
    pill.textContent = String(number);
    pill.setAttribute("aria-label", `${colorName(number)} ${number}`);
    historyEl.append(pill);
  }
}

function totalBets(bets = state.bets) {
  return Object.values(bets).reduce((sum, amount) => sum + amount, 0);
}

function updateHud() {
  if (balanceEl) balanceEl.textContent = formatCredits(state.balance);
  if (totalBetEl) totalBetEl.textContent = formatCredits(totalBets());
  if (spinsEl) spinsEl.textContent = formatCredits(state.spins);

  for (const button of document.querySelectorAll("[data-roulette-bet]")) {
    const key = button.dataset.rouletteBet;
    const amount = state.bets[key] || 0;
    const badge = button.querySelector(".number-cell__chips, .outside-cell__chips");
    if (badge) badge.textContent = amount > 0 ? formatCredits(amount) : "";
    button.dataset.selected = amount > 0 ? "true" : "false";
    button.setAttribute(
      "aria-label",
      `${button.dataset.baseLabel}，目前下注 ${formatCredits(amount)} 點`,
    );
  }

  for (const button of chipButtons) {
    button.setAttribute(
      "aria-pressed",
      String(Number(button.dataset.rouletteChip) === state.chip),
    );
  }
  updateControls();
}

function updateControls() {
  const busy = phase !== "idle";
  if (spinBtn) spinBtn.disabled = busy || totalBets() === 0;
  if (clearBtn) clearBtn.disabled = busy || totalBets() === 0;
  if (repeatBtn) repeatBtn.disabled = busy || totalBets(state.lastBets) === 0;
  if (resetBtn) resetBtn.disabled = busy;
  for (const button of document.querySelectorAll("[data-roulette-bet]")) {
    button.disabled = busy;
  }
  for (const button of chipButtons) button.disabled = busy;
}

function announce(message) {
  if (srEl) srEl.textContent = message;
  if (statusEl) statusEl.textContent = message;
}

/* --------------------------------------------------------------------------
   下注
   -------------------------------------------------------------------------- */
function placeBet(key) {
  if (phase !== "idle" || !isValidBetKey(key)) return;
  if (state.balance < state.chip) {
    announce("虛擬籌碼不足，請降低籌碼或按「補充籌碼」。");
    sfx("lose");
    return;
  }
  state.balance -= state.chip;
  state.bets[key] = (state.bets[key] || 0) + state.chip;
  sfx("chip");
  updateHud();
  persist();
  announce(
    `已下注 ${formatCredits(state.chip)} 點，總投注 ${formatCredits(totalBets())} 點。`,
  );
}

function clearBets(refund = true) {
  if (phase !== "idle") return;
  const amount = totalBets();
  if (!amount) return;
  if (refund) state.balance += amount;
  state.bets = {};
  updateHud();
  persist();
  if (refund) announce(`已退回 ${formatCredits(amount)} 點投注。`);
}

function repeatBets() {
  if (phase !== "idle") return;
  const previous = { ...state.lastBets };
  const amount = totalBets(previous);
  if (!amount) return;
  clearBets(true);
  if (state.balance < amount) {
    announce(`籌碼不足，重複上一局需要 ${formatCredits(amount)} 點。`);
    sfx("lose");
    return;
  }
  state.balance -= amount;
  state.bets = previous;
  sfx("chip");
  updateHud();
  persist();
  announce(`已重複上一局投注，共 ${formatCredits(amount)} 點。`);
}

/* --------------------------------------------------------------------------
   派彩
   -------------------------------------------------------------------------- */
function betReturn(key, result, amount) {
  if (key.startsWith("n:")) {
    return Number(key.slice(2)) === result ? amount * 36 : 0;
  }
  const red = result !== 0 && RED_NUMBERS.has(result);
  switch (key) {
    case "red":
      return red ? amount * 2 : 0;
    case "black":
      return result !== 0 && !red ? amount * 2 : 0;
    case "odd":
      return result !== 0 && result % 2 === 1 ? amount * 2 : 0;
    case "even":
      return result !== 0 && result % 2 === 0 ? amount * 2 : 0;
    case "low":
      return result >= 1 && result <= 18 ? amount * 2 : 0;
    case "high":
      return result >= 19 && result <= 36 ? amount * 2 : 0;
    case "dozen:1":
      return result >= 1 && result <= 12 ? amount * 3 : 0;
    case "dozen:2":
      return result >= 13 && result <= 24 ? amount * 3 : 0;
    case "dozen:3":
      return result >= 25 && result <= 36 ? amount * 3 : 0;
    case "col:1":
      return result > 0 && (result - 1) % 3 === 0 ? amount * 3 : 0;
    case "col:2":
      return result > 0 && (result - 2) % 3 === 0 ? amount * 3 : 0;
    case "col:3":
      return result > 0 && result % 3 === 0 ? amount * 3 : 0;
    default:
      return 0;
  }
}

function settleSpin(result) {
  const roundBets = { ...state.bets };
  const stake = totalBets(roundBets);
  let returned = 0;
  const winningKeys = [];

  for (const [key, amount] of Object.entries(roundBets)) {
    const payout = betReturn(key, result, amount);
    if (payout > 0) {
      returned += payout;
      winningKeys.push(key);
    }
  }

  state.balance += returned;
  const profit = returned - stake;
  state.spins += 1;
  state.history = [result, ...state.history].slice(0, 12);
  state.lastBets = roundBets;
  state.bets = {};
  phase = "idle";

  if (resultNumberEl) {
    resultNumberEl.textContent = String(result);
    resultNumberEl.dataset.color = colorOf(result);
  }
  if (resultTextEl) {
    const profitText = profit > 0
      ? `本局 +${formatCredits(profit)} 點`
      : profit < 0
        ? `本局 ${formatCredits(profit)} 點`
        : "投注退回";
    resultTextEl.textContent = `${colorName(result)} ${result} · ${profitText}`;
  }

  renderHistory();
  updateHud();
  persist();

  hitHighlight = { result, until: performance.now() + 2200 };
  for (const key of winningKeys) {
    const selector = key.startsWith("n:")
      ? `[data-roulette-number="${key.slice(2)}"]`
      : `[data-roulette-bet="${key}"]`;
    document.querySelector(selector)?.classList.add("is-hit");
  }
  window.setTimeout(() => {
    document.querySelectorAll(".is-hit").forEach((node) => node.classList.remove("is-hit"));
  }, 2200);

  const winText = profit > 0
    ? `贏得 ${formatCredits(profit)} 點。`
    : profit < 0
      ? `損失 ${formatCredits(Math.abs(profit))} 點。`
      : "投注退回。";
  announce(`${colorName(result)} ${result}。${winText}`);
  sfx(profit > 0 ? "win" : "lose");

  if (profit >= stake * 10 && stake > 0) {
    sfx("bigwin");
  }
  requestDraw();
}

function showLastResult(number, prefix = "") {
  if (resultNumberEl) {
    resultNumberEl.textContent = String(number);
    resultNumberEl.dataset.color = colorOf(number);
  }
  if (resultTextEl) {
    resultTextEl.textContent = `${prefix ? `${prefix} · ` : ""}${colorName(number)} ${number}`;
  }
}

/* --------------------------------------------------------------------------
   轉輪動畫
   -------------------------------------------------------------------------- */
const easeOutQuint = (t) => 1 - Math.pow(1 - t, 5);
const modAngle = (value) => ((value % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);

function spin() {
  if (phase !== "idle") return;
  if (totalBets() <= 0) {
    announce("請先下注。");
    return;
  }
  unlockAudio();
  phase = "spinning";
  updateControls();

  const result = randomInt(37);
  const pocketIndex = WHEEL_SEQUENCE.indexOf(result);
  const segment = (Math.PI * 2) / WHEEL_SEQUENCE.length;
  const desired = modAngle(-pocketIndex * segment);
  const wheelTarget =
    wheelRotation + Math.PI * 2 * (5 + Math.random() * 2) + modAngle(desired - wheelRotation);
  const start = performance.now();

  sfx("spin");
  announce("輪盤正在旋轉，請稍候。");

  // 減少動態偏好：直接定位到結果，短暫停頓後結算
  if (reduceMotion) {
    wheelRotation = modAngle(desired);
    ballAngle = -Math.PI / 2;
    ballRadius = 205;
    spinAnimation = null;
    requestDraw();
    window.setTimeout(() => {
      if (phase === "spinning") settleSpin(result);
    }, 260);
    return;
  }

  spinAnimation = {
    result,
    start,
    duration: 4700,
    wheelStart: wheelRotation,
    wheelTarget,
    ballStart: -Math.PI / 2 + Math.PI * 2 * 2,
    ballEnd: -Math.PI / 2 - Math.PI * 2 * 9,
    ballStartRadius: 238,
    ballEndRadius: 205,
    settled: false,
  };
  lastTickAt = start;
  ballRadius = 238;
  requestDraw();

  /* 安全網：rAF 被凍結時仍要結算，避免籌碼已扣卻停在「旋轉中」。 */
  window.clearTimeout(spinGuardTimer);
  spinGuardTimer = window.setTimeout(() => {
    if (phase !== "spinning" || !spinAnimation) return;
    spinAnimation = null;
    wheelRotation = modAngle(wheelTarget);
    ballAngle = -Math.PI / 2;
    ballRadius = 205;
    requestDraw();
    settleSpin(result);
  }, 5600);
}

function updateSpinAnimation(now) {
  if (!spinAnimation) return false;
  const progress = Math.min(
    1,
    (now - spinAnimation.start) / spinAnimation.duration,
  );
  const eased = easeOutQuint(progress);
  wheelRotation =
    spinAnimation.wheelStart +
    (spinAnimation.wheelTarget - spinAnimation.wheelStart) * eased;
  ballAngle =
    spinAnimation.ballStart +
    (spinAnimation.ballEnd - spinAnimation.ballStart) * eased;
  ballRadius =
    spinAnimation.ballStartRadius +
    (spinAnimation.ballEndRadius - spinAnimation.ballStartRadius) * eased;

  // 球經過格線時發出短促 tick，節奏隨轉速放慢
  if (!reduceMotion && progress < 0.96) {
    const interval = 70 + progress * progress * 340;
    if (now - lastTickAt > interval) {
      lastTickAt = now;
      sfx("roulette");
    }
  }

  if (progress >= 1 && !spinAnimation.settled) {
    spinAnimation.settled = true;
    const result = spinAnimation.result;
    spinAnimation = null;
    wheelRotation = modAngle(wheelRotation);
    ballAngle = -Math.PI / 2;
    ballRadius = 205;
    settleSpin(result);
    return false;
  }
  return progress < 1;
}

/* --------------------------------------------------------------------------
   Canvas 繪製
   -------------------------------------------------------------------------- */
function drawWheel(now) {
  if (!ctx) return;
  ctx.setTransform(viewScale, 0, 0, viewScale, 0, 0);
  ctx.clearRect(0, 0, 560, 560);

  const cx = 280;
  const cy = 280;
  const outer = 244;

  // 底座陰影
  const base = ctx.createRadialGradient(cx, cy, outer * 0.4, cx, cy, outer + 16);
  base.addColorStop(0, "rgba(0,0,0,0)");
  base.addColorStop(1, "rgba(0,0,0,.5)");
  ctx.fillStyle = base;
  ctx.beginPath();
  ctx.arc(cx, cy, outer + 16, 0, Math.PI * 2);
  ctx.fill();

  // 木質外框
  const rim = ctx.createLinearGradient(cx - outer, cy - outer, cx + outer, cy + outer);
  rim.addColorStop(0, "#f3d797");
  rim.addColorStop(0.24, "#a9762a");
  rim.addColorStop(0.52, "#5b3a13");
  rim.addColorStop(0.78, "#d4a453");
  rim.addColorStop(1, "#6b4519");
  ctx.beginPath();
  ctx.arc(cx, cy, outer, 0, Math.PI * 2);
  ctx.fillStyle = rim;
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 238, 188, .5)";
  ctx.lineWidth = 2;
  ctx.stroke();

  // 內圈
  ctx.beginPath();
  ctx.arc(cx, cy, outer - 22, 0, Math.PI * 2);
  ctx.fillStyle = "#0b1a22";
  ctx.fill();
  ctx.strokeStyle = "rgba(233, 185, 92, .65)";
  ctx.lineWidth = 3;
  ctx.stroke();

  const segment = (Math.PI * 2) / WHEEL_SEQUENCE.length;
  const pocketOuter = outer - 28;
  const pocketInner = 174;

  for (let i = 0; i < WHEEL_SEQUENCE.length; i += 1) {
    const number = WHEEL_SEQUENCE[i];
    const centerAngle = -Math.PI / 2 + i * segment + wheelRotation;
    const startAngle = centerAngle - segment / 2;
    const endAngle = centerAngle + segment / 2;
    const color = colorOf(number);

    ctx.beginPath();
    ctx.arc(cx, cy, pocketOuter, startAngle, endAngle);
    ctx.arc(cx, cy, pocketInner, endAngle, startAngle, true);
    ctx.closePath();
    ctx.fillStyle = color === "red"
      ? "#a92f35"
      : color === "black"
        ? "#171d24"
        : "#1e7a56";
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 233, 180, .3)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // 數字：隨轉輪旋轉，保持從圓心向外閱讀
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(centerAngle + Math.PI / 2);
    ctx.translate(0, -(pocketOuter + pocketInner) / 2);
    ctx.fillStyle = "#fff7e4";
    ctx.font = "700 14px ui-monospace, Consolas, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(number), 0, 0);
    ctx.restore();
  }

  // 內圈裝飾
  ctx.beginPath();
  ctx.arc(cx, cy, pocketInner - 2, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(5, 14, 20, .75)";
  ctx.fill();
  ctx.strokeStyle = "rgba(233, 185, 92, .35)";
  ctx.lineWidth = 1;
  ctx.stroke();

  for (let i = 0; i < 37; i += 1) {
    const angle = -Math.PI / 2 + i * segment + wheelRotation;
    ctx.beginPath();
    ctx.arc(
      cx + Math.cos(angle) * (outer - 11),
      cy + Math.sin(angle) * (outer - 11),
      1.8,
      0,
      Math.PI * 2,
    );
    ctx.fillStyle = "rgba(255, 231, 174, .65)";
    ctx.fill();
  }

  // 中心輪轂
  const hub = ctx.createRadialGradient(cx - 20, cy - 20, 8, cx, cy, 104);
  hub.addColorStop(0, "#f6dfa7");
  hub.addColorStop(0.4, "#c08a36");
  hub.addColorStop(1, "#543211");
  ctx.beginPath();
  ctx.arc(cx, cy, 96, 0, Math.PI * 2);
  ctx.fillStyle = hub;
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 240, 196, .55)";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy, 74, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(8, 13, 20, .88)";
  ctx.fill();
  ctx.strokeStyle = "rgba(233, 185, 92, .5)";
  ctx.stroke();

  ctx.fillStyle = "#f8e2ad";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "700 26px Georgia, serif";
  ctx.fillText("LF", cx, cy - 10);
  ctx.font = "600 9px ui-monospace, monospace";
  ctx.fillStyle = "rgba(255, 241, 204, .68)";
  ctx.fillText("EUROPEAN", cx, cy + 16);
  ctx.fillText("37 POCKETS", cx, cy + 30);

  // 頂部指針
  ctx.beginPath();
  ctx.moveTo(cx, cy - outer - 10);
  ctx.lineTo(cx - 13, cy - outer + 12);
  ctx.lineTo(cx + 13, cy - outer + 12);
  ctx.closePath();
  ctx.fillStyle = "#ffe6a0";
  ctx.shadowColor = "rgba(233, 185, 92, .9)";
  ctx.shadowBlur = 18;
  ctx.fill();
  ctx.shadowBlur = 0;

  // 小球
  const ballX = cx + Math.cos(ballAngle) * ballRadius;
  const ballY = cy + Math.sin(ballAngle) * ballRadius;
  const ballGradient = ctx.createRadialGradient(ballX - 2, ballY - 3, 1, ballX, ballY, 9);
  ballGradient.addColorStop(0, "#ffffff");
  ballGradient.addColorStop(0.55, "#e9e6da");
  ballGradient.addColorStop(1, "#9aa0a6");
  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, .6)";
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 3;
  ctx.beginPath();
  ctx.arc(ballX, ballY, 8, 0, Math.PI * 2);
  ctx.fillStyle = ballGradient;
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = "rgba(255,255,255,.7)";
  ctx.lineWidth = 1;
  ctx.stroke();

  // 旋轉中的微弱光暈
  if (spinAnimation) {
    ctx.beginPath();
    ctx.arc(cx, cy, outer + 4, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255, 231, 174, .18)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // 中獎格高亮
  if (hitHighlight && hitHighlight.until > now && spinAnimation === null) {
    const index = WHEEL_SEQUENCE.indexOf(hitHighlight.result);
    if (index >= 0) {
      const centerAngle = -Math.PI / 2 + index * segment + wheelRotation;
      ctx.beginPath();
      ctx.arc(cx, cy, pocketOuter, centerAngle - segment / 2, centerAngle + segment / 2);
      ctx.arc(cx, cy, pocketInner, centerAngle + segment / 2, centerAngle - segment / 2, true);
      ctx.closePath();
      ctx.strokeStyle = "rgba(255, 240, 180, .9)";
      ctx.lineWidth = 3;
      ctx.shadowColor = "rgba(233, 185, 92, .9)";
      ctx.shadowBlur = 20;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
  }
}

const ctx = canvas?.getContext("2d");

function fitCanvas() {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.width * dpr);
  viewScale = canvas.width / 560;
  drawWheel(performance.now());
}

function frame(now) {
  rafId = 0;
  const animating = updateSpinAnimation(now);
  drawWheel(now);
  if (animating) rafId = requestAnimationFrame(frame);
}

function requestDraw() {
  if (rafId) return;
  rafId = requestAnimationFrame(frame);
}

/* --------------------------------------------------------------------------
   事件
   -------------------------------------------------------------------------- */
function bindBoardEvents() {
  for (const container of [numberGrid, outsideGrid]) {
    container?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-roulette-bet]");
      if (!button) return;
      unlockAudio();
      placeBet(button.dataset.rouletteBet);
    });
  }
}

chipButtons.forEach((button) => {
  button.addEventListener("click", () => {
    if (phase !== "idle") return;
    state.chip = Number(button.dataset.rouletteChip);
    sfx("click");
    updateHud();
    persist();
    announce(`籌碼面額切換為 ${formatCredits(state.chip)} 點。`);
  });
});

spinBtn?.addEventListener("click", () => {
  unlockAudio();
  spin();
});

clearBtn?.addEventListener("click", () => clearBets(true));

repeatBtn?.addEventListener("click", repeatBets);

resetBtn?.addEventListener("click", () => {
  if (phase !== "idle") return;
  state.balance = DEFAULT_STATE.balance;
  state.bets = {};
  state.lastBets = {};
  state.history = [];
  state.spins = 0;
  renderHistory();
  showLastResult(0, "尚未開轉");
  updateHud();
  persist();
  drawWheel(performance.now());
  announce("已補充 10,000 點虛擬籌碼，紀錄已清除。");
  sfx("cash");
});

document.addEventListener("keydown", (event) => {
  if (
    (event.code === "Space" || event.key === " ") &&
    !event.target.closest("button, a, input, select, textarea") &&
    phase === "idle" &&
    totalBets() > 0
  ) {
    event.preventDefault();
    unlockAudio();
    spin();
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  } else if (spinAnimation) {
    requestDraw();
  }
});

/* 初始化 */
buildBoard();
bindBoardEvents();
restoreState();
updateHud();
showLastResult(state.history[0] ?? 0, state.history.length ? "上局" : "尚未開轉");
announce(
  state.history.length
    ? "輪盤已恢復上次狀態。請選擇籌碼與下注區，然後按「轉動輪盤」。"
    : "輪盤已就緒。請選擇籌碼並點擊下注區，然後按「轉動輪盤」。所有點數皆為虛擬點數。",
);

if (canvas && ctx) {
  fitCanvas();
  if ("ResizeObserver" in window) {
    const observer = new ResizeObserver(fitCanvas);
    observer.observe(canvas);
  } else {
    window.addEventListener("resize", fitCanvas, { passive: true });
  }
  drawWheel(performance.now());
}
