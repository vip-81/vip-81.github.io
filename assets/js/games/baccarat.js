/**
 * 百家樂 Baccarat：8 副牌靴、完整補牌規則、珠盤路、公平性指紋、斷線恢復
 * ---------------------------------------------------------------------------
 * 規則：閒家 0–5 補牌；莊家依「閒家第三張牌」套用標準補牌表；莊贏抽 5%。
 * 公平性：牌靴以 crypto.getRandomValues 洗牌，並以 SHA-256 產生牌靴指紋。
 * 正式環境應改為伺服器建立牌靴、公開 commitment、局後揭示 seed 並簽章。
 */

import {
  cardMarkup,
  createShoe,
  baccaratValue,
  isPair,
  RANKS,
  shoeFingerprint,
} from "../lib/cards.js";
import { formatCredits, loadJSON, saveJSON } from "../lib/storage.js";
import { sfx, unlockAudio } from "../lib/audio.js";

const $ = (id) => document.getElementById(id);
const playerCardsEl = $("bac-player-cards");
const bankerCardsEl = $("bac-banker-cards");
const playerPointsEl = $("bac-player-points");
const bankerPointsEl = $("bac-banker-points");
const playerHandEl = $("bac-player-hand");
const bankerHandEl = $("bac-banker-hand");
const balanceEl = $("bac-balance");
const totalBetEl = $("bac-total-bet");
const shoeLeftEl = $("bac-shoe-left");
const roundsEl = $("bac-rounds");
const resultTitleEl = $("bac-result-title");
const resultDetailEl = $("bac-result-detail");
const dealBtn = $("bac-deal");
const clearBtn = $("bac-clear");
const repeatBtn = $("bac-repeat");
const resetBtn = $("bac-reset");
const statusEl = $("bac-status");
const srEl = $("bac-sr");
const roadEl = $("bac-road");
const roadEmptyEl = $("bac-road-empty");
const fingerprintEl = $("bac-fingerprint");
const statPlayerEl = $("bac-stat-player");
const statBankerEl = $("bac-stat-banker");
const statTieEl = $("bac-stat-tie");
const statPairsEl = $("bac-stat-pairs");
const betSpots = [...document.querySelectorAll("[data-bac-bet]")];
const chipButtons = [...document.querySelectorAll("[data-bac-chip]")];

if (!playerCardsEl || !dealBtn) {
  console.warn("[baccarat] 缺少必要 DOM");
}

const BET_KEYS = ["player", "banker", "tie", "playerPair", "bankerPair"];
const OUTCOME_LABEL = { player: "閒家勝", banker: "莊家勝", tie: "和局" };
const DEFAULT_STATE = { balance: 10000, chip: 100 };
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

let state = {
  balance: DEFAULT_STATE.balance,
  chip: DEFAULT_STATE.chip,
  shoe: [],
  shoeIndex: 0,
  fingerprint: "",
  bets: emptyBets(),
  lastBets: emptyBets(),
  road: [],
  stats: { rounds: 0, player: 0, banker: 0, tie: 0, pairs: 0 },
};
let phase = "idle";
let fingerprintReady = false;
let restored = false;

function emptyBets() {
  return { player: 0, banker: 0, tie: 0, playerPair: 0, bankerPair: 0 };
}

function totalBets(bets = state.bets) {
  return BET_KEYS.reduce((sum, key) => sum + bets[key], 0);
}

function isValidShoe(shoe) {
  return (
    Array.isArray(shoe) &&
    shoe.length > 0 &&
    shoe.every(
      (card) =>
        card &&
        RANKS.includes(card.rank) &&
        Number.isInteger(card.suit) &&
        card.suit >= 0 &&
        card.suit <= 3,
    )
  );
}

/* --------------------------------------------------------------------------
   初始化與恢復
   -------------------------------------------------------------------------- */
async function refreshFingerprint() {
  try {
    const fingerprint = await shoeFingerprint(state.shoe);
    state.fingerprint = fingerprint.short;
    if (fingerprintEl) fingerprintEl.textContent = fingerprint.short;
    fingerprintReady = true;
  } catch (error) {
    console.warn("[baccarat] 無法產生牌靴指紋：", error);
    fingerprintReady = false;
    if (fingerprintEl) fingerprintEl.textContent = "Web Crypto 不可用";
  }
  updateControls();
}

function newShoe() {
  state.shoe = createShoe(8);
  state.shoeIndex = 0;
  state.fingerprint = "";
  fingerprintReady = false;
  if (fingerprintEl) fingerprintEl.textContent = "計算中…";
  refreshFingerprint();
}

function restoreOrCreate() {
  const saved = loadJSON("baccarat", null);
  if (
    saved &&
    Number.isFinite(saved.balance) &&
    isValidShoe(saved.shoe) &&
    Number.isInteger(saved.shoeIndex) &&
    saved.shoeIndex >= 0 &&
    saved.shoeIndex < saved.shoe.length
  ) {
    const safeBets = (value) => {
      const result = emptyBets();
      for (const key of BET_KEYS) {
        const amount = Number(value?.[key]);
        result[key] = Number.isFinite(amount) && amount > 0 ? Math.round(amount) : 0;
      }
      return result;
    };
    state = {
      ...state,
      balance: Math.max(0, Math.round(saved.balance)),
      chip: [10, 50, 100, 500].includes(saved.chip) ? saved.chip : DEFAULT_STATE.chip,
      shoe: saved.shoe,
      shoeIndex: saved.shoeIndex,
      fingerprint: typeof saved.fingerprint === "string" ? saved.fingerprint : "",
      bets: safeBets(saved.bets),
      lastBets: safeBets(saved.lastBets),
      road: Array.isArray(saved.road)
        ? saved.road.filter((item) => ["P", "B", "T"].includes(item)).slice(-30)
        : [],
      stats: {
        rounds: Math.max(0, Number(saved.stats?.rounds) || 0),
        player: Math.max(0, Number(saved.stats?.player) || 0),
        banker: Math.max(0, Number(saved.stats?.banker) || 0),
        tie: Math.max(0, Number(saved.stats?.tie) || 0),
        pairs: Math.max(0, Number(saved.stats?.pairs) || 0),
      },
    };
    restored = true;
    if (state.fingerprint) {
      fingerprintReady = true;
      if (fingerprintEl) fingerprintEl.textContent = state.fingerprint;
      refreshFingerprint(); // 背景重新計算，避免舊資料被竄改
    } else {
      refreshFingerprint();
    }
  } else {
    state.balance = DEFAULT_STATE.balance;
    state.chip = DEFAULT_STATE.chip;
    state.bets = emptyBets();
    state.lastBets = emptyBets();
    state.road = [];
    state.stats = { rounds: 0, player: 0, banker: 0, tie: 0, pairs: 0 };
    newShoe();
  }
}

function persist() {
  saveJSON("baccarat", {
    balance: state.balance,
    chip: state.chip,
    shoe: state.shoe,
    shoeIndex: state.shoeIndex,
    fingerprint: state.fingerprint,
    bets: state.bets,
    lastBets: state.lastBets,
    road: state.road,
    stats: state.stats,
  });
}

/* --------------------------------------------------------------------------
   HUD 與下注
   -------------------------------------------------------------------------- */
function announce(message) {
  if (srEl) srEl.textContent = message;
  if (statusEl) statusEl.textContent = message;
}

function updateHud() {
  if (balanceEl) balanceEl.textContent = formatCredits(state.balance);
  if (totalBetEl) totalBetEl.textContent = formatCredits(totalBets());
  if (shoeLeftEl) {
    shoeLeftEl.textContent = formatCredits(Math.max(0, state.shoe.length - state.shoeIndex));
  }
  if (roundsEl) roundsEl.textContent = formatCredits(state.stats.rounds);
  if (statPlayerEl) statPlayerEl.textContent = formatCredits(state.stats.player);
  if (statBankerEl) statBankerEl.textContent = formatCredits(state.stats.banker);
  if (statTieEl) statTieEl.textContent = formatCredits(state.stats.tie);
  if (statPairsEl) statPairsEl.textContent = formatCredits(state.stats.pairs);
  if (fingerprintEl && state.fingerprint) fingerprintEl.textContent = state.fingerprint;

  for (const spot of betSpots) {
    const key = spot.dataset.bacBet;
    const chip = spot.querySelector(".bet-spot__chip");
    if (chip) chip.textContent = state.bets[key] > 0 ? formatCredits(state.bets[key]) : "";
    spot.dataset.selected = state.bets[key] > 0 ? "true" : "false";
    spot.setAttribute(
      "aria-label",
      `${spot.dataset.bacLabel || betLabel(key)}，目前下注 ${formatCredits(
        state.bets[key],
      )} 點`,
    );
  }

  for (const button of chipButtons) {
    const active = Number(button.dataset.bacChip) === state.chip;
    button.setAttribute("aria-pressed", String(active));
  }

  renderRoad();
  updateControls();
}

function updateControls() {
  const busy = phase !== "idle";
  const hasBets = totalBets() > 0;
  if (dealBtn) dealBtn.disabled = busy || !hasBets || !fingerprintReady;
  if (clearBtn) clearBtn.disabled = busy || !hasBets;
  if (repeatBtn) {
    repeatBtn.disabled = busy || totalBets(state.lastBets) === 0;
  }
  if (resetBtn) resetBtn.disabled = busy;
  for (const spot of betSpots) spot.disabled = busy;
  for (const button of chipButtons) button.disabled = busy;
}

function placeBet(key) {
  if (phase !== "idle") return;
  if (!BET_KEYS.includes(key)) return;
  if (state.balance < state.chip) {
    announce("虛擬籌碼不足，請降低籌碼或按「補充籌碼」。");
    sfx("lose");
    return;
  }
  state.balance -= state.chip;
  state.bets[key] += state.chip;
  sfx("chip");
  updateHud();
  persist();
  announce(
    `已下注 ${formatCredits(state.chip)} 點於${betLabel(key)}，總投注 ${formatCredits(totalBets())} 點。`,
  );
}

function betLabel(key) {
  return {
    player: "閒家",
    banker: "莊家",
    tie: "和局",
    playerPair: "閒對",
    bankerPair: "莊對",
  }[key];
}

function clearBets(refund = true) {
  if (phase !== "idle") return;
  const amount = totalBets();
  if (!amount) return;
  if (refund) state.balance += amount;
  state.bets = emptyBets();
  updateHud();
  persist();
  if (refund) {
    sfx("click");
    announce(`已退回 ${formatCredits(amount)} 點投注。`);
  }
}

function repeatBets() {
  if (phase !== "idle") return;
  const previous = { ...state.lastBets };
  const amount = totalBets(previous);
  if (!amount) return;
  // 先退回目前桌面上的投注，再嘗試重複上一局
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
   發牌與規則
   -------------------------------------------------------------------------- */
function cardValue(card) {
  if (card.rank === 1) return 1;
  if (card.rank >= 10) return 0;
  return card.rank;
}

function drawCard() {
  const card = state.shoe[state.shoeIndex];
  state.shoeIndex += 1;
  return card;
}

function appendCard(container, card) {
  container.insertAdjacentHTML("beforeend", cardMarkup(card));
}

function updatePoints(handEl, pointsEl, cards) {
  if (pointsEl) pointsEl.textContent = String(baccaratValue(cards));
  if (handEl) handEl.classList.remove("baccarat-hand__winner");
}

function resetTable() {
  playerCardsEl.replaceChildren();
  bankerCardsEl.replaceChildren();
  if (playerPointsEl) playerPointsEl.textContent = "0";
  if (bankerPointsEl) bankerPointsEl.textContent = "0";
  playerHandEl?.classList.remove("baccarat-hand__winner");
  bankerHandEl?.classList.remove("baccarat-hand__winner");
  if (resultTitleEl) resultTitleEl.textContent = "準備發牌";
  if (resultDetailEl) resultDetailEl.textContent = "下注後按「發牌」";
}

function bankerShouldDraw(bankerTotal, playerThirdValue) {
  if (playerThirdValue === null) return bankerTotal <= 5;
  if (bankerTotal <= 2) return true;
  if (bankerTotal === 3) return playerThirdValue !== 8;
  if (bankerTotal === 4) return playerThirdValue >= 2 && playerThirdValue <= 7;
  if (bankerTotal === 5) return playerThirdValue >= 4 && playerThirdValue <= 7;
  if (bankerTotal === 6) return playerThirdValue >= 6 && playerThirdValue <= 7;
  return false;
}

function settleRound(round, roundBets) {
  const playerTotal = baccaratValue(round.player);
  const bankerTotal = baccaratValue(round.banker);
  let outcome = "tie";
  if (playerTotal > bankerTotal) outcome = "player";
  else if (bankerTotal > playerTotal) outcome = "banker";

  const playerPair = round.player.length >= 2 && isPair(round.player);
  const bankerPair = round.banker.length >= 2 && isPair(round.banker);
  const pairCount = Number(playerPair) + Number(bankerPair);

  let returned = 0;
  const lines = [];

  if (roundBets.player > 0) {
    if (outcome === "player") {
      returned += roundBets.player * 2;
      lines.push(`閒家 +${formatCredits(roundBets.player)}`);
    } else if (outcome === "tie") {
      returned += roundBets.player;
      lines.push("閒家退回");
    }
  }
  if (roundBets.banker > 0) {
    if (outcome === "banker") {
      const commissionWin = Math.round(roundBets.banker * 0.95);
      returned += roundBets.banker + commissionWin;
      lines.push(`莊家 +${formatCredits(commissionWin)}（抽水 5%）`);
    } else if (outcome === "tie") {
      returned += roundBets.banker;
      lines.push("莊家退回");
    }
  }
  if (roundBets.tie > 0) {
    if (outcome === "tie") {
      returned += roundBets.tie * 9;
      lines.push(`和局 +${formatCredits(roundBets.tie * 8)}`);
    }
  }
  if (roundBets.playerPair > 0) {
    if (playerPair) {
      returned += roundBets.playerPair * 12;
      lines.push(`閒對 +${formatCredits(roundBets.playerPair * 11)}`);
    }
  }
  if (roundBets.bankerPair > 0) {
    if (bankerPair) {
      returned += roundBets.bankerPair * 12;
      lines.push(`莊對 +${formatCredits(roundBets.bankerPair * 11)}`);
    }
  }

  const stake = totalBets(roundBets);
  const profit = returned - stake;
  state.balance += returned;

  state.stats.rounds += 1;
  state.stats[outcome] += 1;
  state.stats.pairs += pairCount;
  state.road.push(outcome === "player" ? "P" : outcome === "banker" ? "B" : "T");
  state.road = state.road.slice(-30);
  state.lastBets = { ...roundBets };
  state.bets = emptyBets();

  if (outcome !== "tie") {
    const winnerEl = outcome === "player" ? playerHandEl : bankerHandEl;
    winnerEl?.classList.add("baccarat-hand__winner");
  }

  if (resultTitleEl) resultTitleEl.textContent = OUTCOME_LABEL[outcome];
  const netZero = profit === 0 && lines.length > 0;
  if (resultDetailEl) {
    const profitText = profit > 0
      ? `本局 +${formatCredits(profit)} 點`
      : profit < 0
        ? `本局 ${formatCredits(profit)} 點`
        : netZero
          ? "本局淨額 0 點"
          : "本局投注退回";
    resultDetailEl.textContent = `閒 ${playerTotal} : 莊 ${bankerTotal} · ${profitText}${
      pairCount ? ` · 對子 ×${pairCount}` : ""
    }`;
  }

  const pairText = pairCount
    ? `，${playerPair ? "閒對" : ""}${playerPair && bankerPair ? "、" : ""}${bankerPair ? "莊對" : ""}`
    : "";
  announce(
    `${OUTCOME_LABEL[outcome]}。閒家 ${playerTotal} 點，莊家 ${bankerTotal} 點${pairText}。${
      profit > 0
        ? `本局贏得 ${formatCredits(profit)} 點。`
        : profit < 0
          ? `本局損失 ${formatCredits(Math.abs(profit))} 點。`
          : netZero
            ? "本局淨額 0 點。"
            : "投注退回。"
    }`,
  );
  if (profit > 0) sfx("win");
  else if (profit < 0) sfx("lose");
  if (profit >= stake * 8 && stake > 0) sfx("bigwin");

  updateHud();
  persist();
  if (lines.length) {
    // 保留在 console 供驗證，不干擾畫面
    console.info("[baccarat] 派彩：", lines.join("；"));
  }
}

async function deal() {
  if (phase !== "idle") return;
  if (totalBets() <= 0) {
    announce("請先選擇下注區域與籌碼。");
    return;
  }
  unlockAudio();
  phase = "dealing";
  updateControls();

  // 牌靴剩餘少於 16 張時換靴（正式規則通常會使用 cut card）
  if (state.shoe.length - state.shoeIndex < 16) {
    newShoe();
    announce("牌靴剩餘不足，已自動換新靴。下一局將使用新牌靴。");
    await sleep(200);
  }

  const roundBets = { ...state.bets };
  const totalStake = totalBets(roundBets);
  resetTable();
  if (resultTitleEl) resultTitleEl.textContent = "發牌中…";
  if (resultDetailEl) resultDetailEl.textContent = `本局投注 ${formatCredits(totalStake)} 點`;
  announce(`開始發牌，總投注 ${formatCredits(totalStake)} 點。`);

  const round = { player: [], banker: [] };
  const delay = reduceMotion ? 70 : 380;

  for (let i = 0; i < 4; i += 1) {
    const side = i % 2 === 0 ? "player" : "banker";
    const card = drawCard();
    round[side].push(card);
    appendCard(side === "player" ? playerCardsEl : bankerCardsEl, card);
    updatePoints(
      side === "player" ? playerHandEl : bankerHandEl,
      side === "player" ? playerPointsEl : bankerPointsEl,
      round[side],
    );
    sfx("deal");
    await sleep(delay);
  }

  let playerTotal = baccaratValue(round.player);
  let bankerTotal = baccaratValue(round.banker);
  let playerThirdValue = null;
  const natural = playerTotal >= 8 || bankerTotal >= 8;

  if (!natural) {
    if (playerTotal <= 5) {
      const third = drawCard();
      round.player.push(third);
      playerThirdValue = cardValue(third);
      appendCard(playerCardsEl, third);
      updatePoints(playerHandEl, playerPointsEl, round.player);
      sfx("deal");
      await sleep(delay);
    }

    playerTotal = baccaratValue(round.player);
    bankerTotal = baccaratValue(round.banker);

    if (bankerShouldDraw(bankerTotal, playerThirdValue)) {
      const third = drawCard();
      round.banker.push(third);
      appendCard(bankerCardsEl, third);
      updatePoints(bankerHandEl, bankerPointsEl, round.banker);
      sfx("deal");
      await sleep(delay);
    }
  }

  updatePoints(playerHandEl, playerPointsEl, round.player);
  updatePoints(bankerHandEl, bankerPointsEl, round.banker);
  await sleep(reduceMotion ? 120 : 340);
  settleRound(round, roundBets);
  phase = "idle";
  updateHud();
  if (state.balance < 10) {
    announce("虛擬籌碼已不足，可按「補充籌碼」重新開始。");
  }
}

/* --------------------------------------------------------------------------
   珠盤路
   -------------------------------------------------------------------------- */
function renderRoad() {
  if (!roadEl) return;
  roadEl.replaceChildren();
  if (!state.road.length) {
    if (roadEmptyEl) roadEmptyEl.hidden = false;
    return;
  }
  if (roadEmptyEl) roadEmptyEl.hidden = true;
  const labels = { P: "閒", B: "莊", T: "和" };
  state.road.forEach((outcome, index) => {
    const bead = document.createElement("span");
    bead.className = `bead bead--${
      outcome === "P" ? "player" : outcome === "B" ? "banker" : "tie"
    }`;
    bead.textContent = outcome;
    bead.setAttribute(
      "aria-label",
      `第 ${index + 1} 局：${outcome === "P" ? "閒家勝" : outcome === "B" ? "莊家勝" : "和局"}`,
    );
    bead.title = `第 ${index + 1} 局：${labels[outcome]}`;
    roadEl.append(bead);
  });
}

/* --------------------------------------------------------------------------
   事件
   -------------------------------------------------------------------------- */
betSpots.forEach((spot) => {
  spot.addEventListener("click", () => {
    unlockAudio();
    placeBet(spot.dataset.bacBet);
  });
});

chipButtons.forEach((button) => {
  button.addEventListener("click", () => {
    if (phase !== "idle") return;
    state.chip = Number(button.dataset.bacChip);
    sfx("click");
    updateHud();
    persist();
    announce(`籌碼面額切換為 ${formatCredits(state.chip)} 點。`);
  });
});

dealBtn?.addEventListener("click", () => {
  unlockAudio();
  deal();
});

clearBtn?.addEventListener("click", () => {
  clearBets(true);
});

repeatBtn?.addEventListener("click", () => {
  repeatBets();
});

resetBtn?.addEventListener("click", () => {
  if (phase !== "idle") return;
  state.balance = DEFAULT_STATE.balance;
  state.bets = emptyBets();
  sfx("cash");
  updateHud();
  persist();
  announce("已補充 10,000 點虛擬籌碼。");
});

document.addEventListener("keydown", (event) => {
  if ((event.code === "Space" || event.key === " ") && event.target === document.body) {
    if (phase === "idle" && totalBets() > 0) {
      event.preventDefault();
      deal();
    }
  }
});

/* 初始化 */
restoreOrCreate();
updateHud();
resetTable();
if (restored) {
  announce(
    `已恢復上次局況：第 ${state.stats.rounds} 局後，牌靴剩餘 ${state.shoe.length - state.shoeIndex} 張。`,
  );
} else {
  announce("百家樂已就緒。請選擇籌碼並點擊下注區，然後按「發牌」。所有點數皆為虛擬點數。");
}
