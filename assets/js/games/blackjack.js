/**
 * 21 點 Blackjack：6 副牌、莊家 S17、Blackjack 3:2、一次分牌、斷線恢復
 * ---------------------------------------------------------------------------
 * 展示重點：
 * - 牌靴與手牌狀態存入 localStorage，重新載入可接續未完成的玩家回合。
 * - 結果在發牌時即由洗牌順序決定；前端只負責流程與賠付呈現。
 * - 尚未實作保險、投降、多次分牌；正式產品需由伺服器權威結算。
 */

import {
  cardMarkup,
  createShoe,
  blackjackValue,
  RANKS,
  shoeFingerprint,
} from "../lib/cards.js";
import { formatCredits, loadJSON, saveJSON } from "../lib/storage.js";
import { sfx, unlockAudio } from "../lib/audio.js";

const $ = (id) => document.getElementById(id);
const dealerCardsEl = $("bj-dealer-cards");
const dealerPointsEl = $("bj-dealer-points");
const playerHandsEl = $("bj-player-hands");
const balanceEl = $("bj-balance");
const betEl = $("bj-bet");
const totalBetEl = $("bj-total-bet");
const shoeLeftEl = $("bj-shoe-left");
const roundsEl = $("bj-rounds");
const fingerprintEl = $("bj-fingerprint");
const stateEl = $("bj-state");
const resultTitleEl = $("bj-result-title");
const resultTextEl = $("bj-result-text");
const dealBtn = $("bj-deal");
const hitBtn = $("bj-hit");
const standBtn = $("bj-stand");
const doubleBtn = $("bj-double");
const splitBtn = $("bj-split");
const resetBtn = $("bj-reset");
const statusEl = $("bj-status");
const srEl = $("bj-sr");
const chipButtons = [...document.querySelectorAll("[data-bj-chip]")];

const DEFAULT_STATE = { balance: 10000, bet: 50 };
const CHIP_VALUES = [10, 25, 50, 100];
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

let state = {
  balance: DEFAULT_STATE.balance,
  bet: DEFAULT_STATE.bet,
  shoe: [],
  shoeIndex: 0,
  fingerprint: "",
  dealer: [],
  hands: [],
  active: -1,
  phase: "idle",
  resultTitle: "等待下注",
  resultText: "選擇籌碼後按「發牌」",
  stats: { rounds: 0, wins: 0, losses: 0, pushes: 0, blackjacks: 0 },
};
let fingerprintReady = false;
let dealerBusy = false;
let restored = false;

function emptyStats() {
  return { rounds: 0, wins: 0, losses: 0, pushes: 0, blackjacks: 0 };
}

function isValidCard(card) {
  return (
    card &&
    RANKS.includes(card.rank) &&
    Number.isInteger(card.suit) &&
    card.suit >= 0 &&
    card.suit <= 3
  );
}

function isValidShoe(shoe) {
  return Array.isArray(shoe) && shoe.length > 0 && shoe.every(isValidCard);
}

function makeHand(cards = [], betAmount = state.bet, isSplit = false) {
  return {
    cards,
    bet: betAmount,
    done: false,
    doubled: false,
    isSplit,
    result: "",
    profit: 0,
  };
}

function newShoe() {
  state.shoe = createShoe(6);
  state.shoeIndex = 0;
  state.fingerprint = "";
  fingerprintReady = false;
  if (fingerprintEl) fingerprintEl.textContent = "計算中…";
  refreshFingerprint();
}

async function refreshFingerprint() {
  try {
    const fingerprint = await shoeFingerprint(state.shoe);
    state.fingerprint = fingerprint.short;
    if (fingerprintEl) fingerprintEl.textContent = fingerprint.short;
    fingerprintReady = true;
  } catch (error) {
    console.warn("[blackjack] 無法建立牌靴指紋：", error);
    fingerprintReady = false;
    if (fingerprintEl) fingerprintEl.textContent = "Web Crypto 不可用";
  }
  updateControls();
}

function restoreOrCreate() {
  const saved = loadJSON("blackjack", null);
  const validPhase = ["idle", "player", "dealer", "settled"].includes(saved?.phase);
  if (
    saved &&
    Number.isFinite(saved.balance) &&
    isValidShoe(saved.shoe) &&
    Number.isInteger(saved.shoeIndex) &&
    saved.shoeIndex >= 0 &&
    saved.shoeIndex <= saved.shoe.length &&
    validPhase
  ) {
    const safeHands = Array.isArray(saved.hands)
      ? saved.hands
          .filter(
            (hand) =>
              hand &&
              Array.isArray(hand.cards) &&
              hand.cards.every(isValidCard) &&
              Number.isFinite(hand.bet) &&
              hand.bet > 0,
          )
          .map((hand) => ({
            cards: hand.cards,
            bet: Math.round(hand.bet),
            done: Boolean(hand.done),
            doubled: Boolean(hand.doubled),
            isSplit: Boolean(hand.isSplit),
            result: typeof hand.result === "string" ? hand.result : "",
            profit: Number(hand.profit) || 0,
          }))
      : [];

    state = {
      ...state,
      balance: Math.max(0, Math.round(saved.balance)),
      bet: CHIP_VALUES.includes(saved.bet) ? saved.bet : DEFAULT_STATE.bet,
      shoe: saved.shoe,
      shoeIndex: saved.shoeIndex,
      fingerprint: typeof saved.fingerprint === "string" ? saved.fingerprint : "",
      dealer: Array.isArray(saved.dealer) ? saved.dealer.filter(isValidCard) : [],
      hands: safeHands,
      active: Number.isInteger(saved.active) ? saved.active : -1,
      phase: validPhase ? saved.phase : "idle",
      resultTitle: typeof saved.resultTitle === "string" ? saved.resultTitle : "等待下注",
      resultText: typeof saved.resultText === "string" ? saved.resultText : "選擇籌碼後按「發牌」",
      stats: {
        rounds: Math.max(0, Number(saved.stats?.rounds) || 0),
        wins: Math.max(0, Number(saved.stats?.wins) || 0),
        losses: Math.max(0, Number(saved.stats?.losses) || 0),
        pushes: Math.max(0, Number(saved.stats?.pushes) || 0),
        blackjacks: Math.max(0, Number(saved.stats?.blackjacks) || 0),
      },
    };

    if (["player", "dealer", "settled"].includes(state.phase)) {
      if (!state.hands.length) {
        state.phase = "idle";
        state.hands = [];
        state.dealer = [];
      }
    }

    restored = true;
    if (state.fingerprint) {
      fingerprintReady = true;
      if (fingerprintEl) fingerprintEl.textContent = state.fingerprint;
    }
    refreshFingerprint();
  } else {
    state.balance = DEFAULT_STATE.balance;
    state.bet = DEFAULT_STATE.bet;
    state.hands = [];
    state.dealer = [];
    state.phase = "idle";
    state.stats = emptyStats();
    newShoe();
  }
}

function persist() {
  saveJSON("blackjack", {
    balance: state.balance,
    bet: state.bet,
    shoe: state.shoe,
    shoeIndex: state.shoeIndex,
    fingerprint: state.fingerprint,
    dealer: state.dealer,
    hands: state.hands,
    active: state.active,
    phase: state.phase,
    resultTitle: state.resultTitle,
    resultText: state.resultText,
    stats: state.stats,
  });
}

/* --------------------------------------------------------------------------
   繪製 DOM
   -------------------------------------------------------------------------- */
function announce(message) {
  if (srEl) srEl.textContent = message;
  if (statusEl) statusEl.textContent = message;
}

function pointsText(cards) {
  if (!cards.length) return "0";
  const { total, soft } = blackjackValue(cards);
  return soft ? `${total} · 軟` : String(total);
}

function visibleDealerText() {
  const reveal = state.phase === "dealer" || state.phase === "settled";
  if (!state.dealer.length) return "—";
  if (!reveal) {
    const first = blackjackValue(state.dealer.slice(0, 1)).total;
    return state.dealer.length > 1 ? `${first} + ?` : String(first);
  }
  return String(blackjackValue(state.dealer).total);
}

function renderDealer(reveal = false) {
  if (!dealerCardsEl) return;
  const shouldReveal = reveal || state.phase === "dealer" || state.phase === "settled";
  dealerCardsEl.innerHTML = state.dealer
    .map((card, index) =>
      cardMarkup(card, {
        faceDown: !shouldReveal && index === 1,
      }),
    )
    .join("");
  if (dealerPointsEl) dealerPointsEl.textContent = visibleDealerText();
}

function appendDealerCard(card, faceDown = false) {
  dealerCardsEl?.insertAdjacentHTML("beforeend", cardMarkup(card, { faceDown }));
  if (dealerPointsEl) dealerPointsEl.textContent = visibleDealerText();
}

function handElementMarkup(hand, index) {
  const label = state.hands.length > 1 ? `手牌 ${index + 1}` : "玩家";
  const activeClass =
    state.phase === "player" && index === state.active ? " is-active" : "";
  const doneClass = hand.done ? " is-done" : "";
  return `<div class="blackjack-hand${activeClass}${doneClass}" data-hand="${index}">
    <div class="blackjack-hand__head">
      <span>${label} · 投注 <b>${formatCredits(hand.bet)}</b></span>
      <strong data-points>${pointsText(hand.cards)}</strong>
    </div>
    <div class="blackjack-cards" data-cards>
      ${hand.cards.map((card) => cardMarkup(card)).join("")}
    </div>
    <div class="blackjack-hand__result" data-result>${hand.result || ""}</div>
  </div>`;
}

function applyHandResultStyle(node, hand) {
  if (!node) return;
  node.classList.remove("is-win", "is-lose", "is-push");
  if (!hand.result) return;
  if (hand.profit > 0) node.classList.add("is-win");
  else if (hand.profit < 0) node.classList.add("is-lose");
  else node.classList.add("is-push");
}

function renderPlayerHands() {
  if (!playerHandsEl) return;
  playerHandsEl.innerHTML = state.hands
    .map((hand, index) => handElementMarkup(hand, index))
    .join("");
  playerHandsEl.querySelectorAll("[data-hand]").forEach((node) => {
    const hand = state.hands[Number(node.dataset.hand)];
    applyHandResultStyle(node.querySelector("[data-result]"), hand);
  });
}

function appendPlayerCard(index, card) {
  const handNode = playerHandsEl?.querySelector(`[data-hand="${index}"]`);
  if (!handNode) {
    renderPlayerHands();
    return;
  }
  handNode.querySelector("[data-cards]")?.insertAdjacentHTML(
    "beforeend",
    cardMarkup(card),
  );
  const hand = state.hands[index];
  const pointsNode = handNode.querySelector("[data-points]");
  if (pointsNode) pointsNode.textContent = pointsText(hand.cards);
}

function updateHandStateClasses() {
  playerHandsEl?.querySelectorAll("[data-hand]").forEach((node) => {
    const index = Number(node.dataset.hand);
    const hand = state.hands[index];
    node.classList.toggle(
      "is-active",
      state.phase === "player" && index === state.active,
    );
    node.classList.toggle("is-done", Boolean(hand?.done));
  });
}

function setResult(title, text) {
  state.resultTitle = title;
  state.resultText = text;
  if (resultTitleEl) resultTitleEl.textContent = title;
  if (resultTextEl) resultTextEl.textContent = text;
}

/* --------------------------------------------------------------------------
   HUD 與控制
   -------------------------------------------------------------------------- */
function totalStake() {
  if (!["player", "dealer", "settled"].includes(state.phase)) return state.bet;
  return state.hands.reduce((sum, hand) => sum + hand.bet, 0);
}

function updateHud() {
  if (balanceEl) balanceEl.textContent = formatCredits(state.balance);
  if (betEl) betEl.textContent = formatCredits(state.bet);
  if (totalBetEl) totalBetEl.textContent = formatCredits(totalStake());
  if (shoeLeftEl) {
    shoeLeftEl.textContent = formatCredits(Math.max(0, state.shoe.length - state.shoeIndex));
  }
  if (roundsEl) roundsEl.textContent = formatCredits(state.stats.rounds);
  if (fingerprintEl && state.fingerprint) fingerprintEl.textContent = state.fingerprint;
  if (stateEl) stateEl.textContent = state.phase.toUpperCase();
  if (dealerPointsEl) dealerPointsEl.textContent = visibleDealerText();

  for (const button of chipButtons) {
    button.setAttribute(
      "aria-pressed",
      String(Number(button.dataset.bjChip) === state.bet),
    );
  }
  updateControls();
}

function updateControls() {
  const betting = state.phase === "idle" || state.phase === "settled";
  const hand = state.hands[state.active];
  const playerTurn = state.phase === "player" && hand && !hand.done;
  const canDouble =
    playerTurn &&
    hand.cards.length === 2 &&
    !hand.doubled &&
    state.balance >= hand.bet;
  const canSplit =
    playerTurn &&
    state.hands.length === 1 &&
    hand.cards.length === 2 &&
    !hand.isSplit &&
    hand.cards[0].rank === hand.cards[1].rank &&
    state.balance >= hand.bet;

  if (dealBtn) {
    dealBtn.disabled = !betting || state.balance < state.bet || !fingerprintReady;
    dealBtn.textContent = state.phase === "settled" ? "下一局" : "發牌";
  }
  if (hitBtn) hitBtn.disabled = !playerTurn;
  if (standBtn) standBtn.disabled = !playerTurn;
  if (doubleBtn) doubleBtn.disabled = !canDouble;
  if (splitBtn) splitBtn.disabled = !canSplit;
  if (resetBtn) resetBtn.disabled = !betting;
  for (const button of chipButtons) button.disabled = !betting;
}

/* --------------------------------------------------------------------------
   牌靴
   -------------------------------------------------------------------------- */
function drawCard() {
  if (state.shoeIndex >= state.shoe.length) {
    newShoe();
  }
  const card = state.shoe[state.shoeIndex];
  state.shoeIndex += 1;
  return card;
}

/* --------------------------------------------------------------------------
   發牌與回合
   -------------------------------------------------------------------------- */
async function dealRound() {
  if (!(state.phase === "idle" || state.phase === "settled")) return;
  if (!fingerprintReady) {
    announce("牌靴指紋尚未就緒，請稍候。");
    return;
  }
  if (state.balance < state.bet) {
    announce("虛擬籌碼不足，請降低下注或按「補充籌碼」。");
    sfx("lose");
    return;
  }
  unlockAudio();
  if (state.shoe.length - state.shoeIndex < 52) {
    newShoe();
    announce("牌靴剩餘不足，已換新靴。");
    await sleep(180);
  }

  state.balance -= state.bet;
  state.phase = "dealing";
  state.dealer = [];
  state.hands = [makeHand()];
  state.active = 0;
  state.resultTitle = "發牌中…";
  state.resultText = `本局投注 ${formatCredits(state.bet)} 點`;
  setResult(state.resultTitle, state.resultText);
  if (dealerCardsEl) dealerCardsEl.replaceChildren();
  if (dealerPointsEl) dealerPointsEl.textContent = "—";
  renderPlayerHands();
  updateHud();

  const delay = reduceMotion ? 80 : 340;
  const order = ["player", "dealer", "player", "dealer"];
  for (const side of order) {
    const card = drawCard();
    if (side === "player") {
      state.hands[0].cards.push(card);
      appendPlayerCard(0, card);
    } else {
      state.dealer.push(card);
      appendDealerCard(card, state.dealer.length === 2);
    }
    sfx("deal");
    updateHud();
    await sleep(delay);
  }

  updateHandStateClasses();
  const playerValue = blackjackValue(state.hands[0].cards).total;
  const dealerValue = blackjackValue(state.dealer).total;
  const playerNatural = playerValue === 21;
  const dealerNatural = dealerValue === 21;

  if (playerNatural || dealerNatural) {
    state.phase = "dealer";
    updateHud();
    renderDealer(true);
    await sleep(reduceMotion ? 100 : 420);
    settleRound();
    return;
  }

  state.phase = "player";
  state.active = 0;
  const dealerUp = blackjackValue(state.dealer.slice(0, 1)).total;
  setResult("輪到你", `玩家 ${playerValue} 點 · 莊家明牌 ${dealerUp} 點`);
  updateHud();
  renderPlayerHands();
  persist();
  announce(
    `玩家 ${playerValue} 點，莊家明牌 ${dealerUp} 點。請選擇加牌、停牌、加倍或分牌。`,
  );
}

function nextHand() {
  const next = state.hands.findIndex((hand, index) => !hand.done && index !== state.active);
  if (next >= 0) {
    state.active = next;
    updateHud();
    updateHandStateClasses();
    persist();
    announce(`輪到手牌 ${next + 1}。目前 ${blackjackValue(state.hands[next].cards).total} 點。`);
    return;
  }
  if (state.hands.some((hand) => !hand.done)) {
    updateHud();
    return;
  }
  state.phase = "dealer";
  state.active = -1;
  updateHud();
  updateHandStateClasses();
  persist();
  announce("玩家回合結束，莊家開始補牌。");
  window.setTimeout(playDealer, reduceMotion ? 150 : 600);
}

function hit() {
  if (state.phase !== "player") return;
  const hand = state.hands[state.active];
  if (!hand || hand.done) return;
  unlockAudio();
  const card = drawCard();
  hand.cards.push(card);
  appendPlayerCard(state.active, card);
  sfx("deal");
  const total = blackjackValue(hand.cards).total;
  updateHud();
  persist();
  if (total > 21) {
    hand.done = true;
    hand.result = `爆牌 · ${formatCredits(-hand.bet)}`;
    hand.profit = -hand.bet;
    renderPlayerHands();
    setResult("爆牌", `玩家 ${total} 點，本手損失 ${formatCredits(hand.bet)} 點。`);
    announce(`爆牌，${total} 點。`);
    sfx("lose");
    window.setTimeout(nextHand, reduceMotion ? 120 : 650);
  } else if (total === 21) {
    hand.done = true;
    hand.result = "21 點 · 自動停牌";
    hand.profit = 0;
    renderPlayerHands();
    announce("玩家 21 點，自動停牌。");
    window.setTimeout(nextHand, reduceMotion ? 120 : 650);
  } else {
    announce(`玩家補牌後 ${total} 點。`);
  }
}

function stand() {
  if (state.phase !== "player") return;
  const hand = state.hands[state.active];
  if (!hand || hand.done) return;
  hand.done = true;
  hand.result = `停牌 · ${blackjackValue(hand.cards).total} 點`;
  sfx("click");
  renderPlayerHands();
  updateHud();
  persist();
  announce(`玩家停牌，${blackjackValue(hand.cards).total} 點。`);
  window.setTimeout(nextHand, reduceMotion ? 120 : 450);
}

function doubleDown() {
  if (state.phase !== "player") return;
  const hand = state.hands[state.active];
  if (!hand || hand.done || hand.cards.length !== 2 || state.balance < hand.bet) return;
  unlockAudio();
  state.balance -= hand.bet;
  hand.bet *= 2;
  hand.doubled = true;
  const card = drawCard();
  hand.cards.push(card);
  hand.done = true;
  hand.result = `加倍 · ${blackjackValue(hand.cards).total} 點`;
  sfx("chip");
  sfx("deal");
  renderPlayerHands();
  updateHud();
  persist();
  announce(`加倍下注，補一張牌後 ${blackjackValue(hand.cards).total} 點。`);
  window.setTimeout(nextHand, reduceMotion ? 150 : 650);
}

function splitHand() {
  if (state.phase !== "player") return;
  const hand = state.hands[state.active];
  if (
    state.hands.length !== 1 ||
    !hand ||
    hand.cards.length !== 2 ||
    hand.cards[0].rank !== hand.cards[1].rank ||
    state.balance < hand.bet
  ) {
    return;
  }
  unlockAudio();
  state.balance -= hand.bet;
  const [first, second] = hand.cards;
  const handA = makeHand([first], hand.bet, true);
  const handB = makeHand([second], hand.bet, true);
  handA.cards.push(drawCard());
  handB.cards.push(drawCard());
  const isAces = first.rank === 1;
  if (isAces) {
    handA.done = true;
    handB.done = true;
    handA.result = "分牌 A · 自動停牌";
    handB.result = "分牌 A · 自動停牌";
  } else {
    if (blackjackValue(handA.cards).total >= 21) {
      handA.done = true;
      handA.result = "21 點 · 自動停牌";
    }
    if (blackjackValue(handB.cards).total >= 21) {
      handB.done = true;
      handB.result = "21 點 · 自動停牌";
    }
  }
  state.hands = [handA, handB];
  state.active = handA.done ? (handB.done ? -1 : 1) : 0;
  sfx("chip");
  sfx("deal");
  renderPlayerHands();
  updateHud();
  persist();
  if (handA.done && handB.done) {
    state.phase = "dealer";
    updateHud();
    announce("分牌完成，莊家開始補牌。");
    window.setTimeout(playDealer, reduceMotion ? 150 : 600);
  } else {
    announce(
      `已分牌。手牌 1：${blackjackValue(handA.cards).total} 點，手牌 2：${blackjackValue(handB.cards).total} 點。`,
    );
  }
}

async function playDealer() {
  if (state.phase !== "dealer" || dealerBusy) return;
  dealerBusy = true;
  renderDealer(true);
  updateHud();
  const anyAlive = state.hands.some(
    (hand) => blackjackValue(hand.cards).total <= 21,
  );
  const delay = reduceMotion ? 120 : 480;

  if (anyAlive) {
    while (blackjackValue(state.dealer).total < 17) {
      await sleep(delay);
      const card = drawCard();
      state.dealer.push(card);
      appendDealerCard(card, false);
      sfx("deal");
      updateHud();
    }
  }
  await sleep(reduceMotion ? 120 : 520);
  settleRound();
  dealerBusy = false;
}

function settleRound() {
  const dealerValue = blackjackValue(state.dealer);
  const dealerTotal = dealerValue.total;
  const dealerBlackjack = state.dealer.length === 2 && dealerTotal === 21;
  let returned = 0;
  let stake = 0;
  let blackjackCount = 0;

  for (const hand of state.hands) {
    const total = blackjackValue(hand.cards).total;
    const isNatural = hand.cards.length === 2 && total === 21 && !hand.isSplit;
    if (isNatural) blackjackCount += 1;
    stake += hand.bet;
    let handReturn = 0;
    let profit = 0;
    let label = "";

    if (total > 21) {
      profit = -hand.bet;
      label = `爆牌 · ${formatCredits(-hand.bet)}`;
    } else if (isNatural && !dealerBlackjack) {
      handReturn = Math.round(hand.bet * 2.5);
      profit = handReturn - hand.bet;
      label = `Blackjack · +${formatCredits(profit)}`;
    } else if (isNatural && dealerBlackjack) {
      handReturn = hand.bet;
      label = "Blackjack 對決 · 和局";
    } else if (dealerBlackjack) {
      profit = -hand.bet;
      label = `莊家 Blackjack · ${formatCredits(-hand.bet)}`;
    } else if (dealerTotal > 21) {
      handReturn = hand.bet * 2;
      profit = hand.bet;
      label = `莊家爆牌 · +${formatCredits(profit)}`;
    } else if (total > dealerTotal) {
      handReturn = hand.bet * 2;
      profit = hand.bet;
      label = `勝 · +${formatCredits(profit)}`;
    } else if (total < dealerTotal) {
      profit = -hand.bet;
      label = `敗 · ${formatCredits(-hand.bet)}`;
    } else {
      handReturn = hand.bet;
      label = "和局 · 退回投注";
    }

    returned += handReturn;
    hand.profit = profit;
    hand.result = label;
    hand.done = true;
  }

  state.balance += returned;
  const profit = returned - stake;
  state.phase = "settled";
  state.active = -1;
  state.stats.rounds += 1;
  state.stats.blackjacks += blackjackCount;
  if (profit > 0) state.stats.wins += 1;
  else if (profit < 0) state.stats.losses += 1;
  else state.stats.pushes += 1;

  let title = "和局";
  if (dealerTotal > 21) title = "莊家爆牌";
  else if (profit > 0) title = blackjackCount > 0 ? "Blackjack！" : "玩家勝";
  else if (profit < 0) title = dealerBlackjack ? "莊家 Blackjack" : "莊家勝";
  else if (blackjackCount > 0) title = "Blackjack 和局";

  const profitText = profit > 0
    ? `本局 +${formatCredits(profit)} 點`
    : profit < 0
      ? `本局 ${formatCredits(profit)} 點`
      : "本局退回投注";
  setResult(
    title,
    `莊 ${dealerTotal} 點 · ${state.hands.length > 1 ? `${state.hands.length} 手牌` : `玩家 ${blackjackValue(state.hands[0].cards).total} 點`} · ${profitText}`,
  );

  renderDealer(true);
  renderPlayerHands();
  updateHud();
  persist();

  announce(
    `${title}。莊家 ${dealerTotal} 點。${profitText}。`,
  );
  sfx(profit > 0 ? "win" : "lose");
  if (blackjackCount > 0 && profit > 0) sfx("bigwin");
}

/* --------------------------------------------------------------------------
   事件
   -------------------------------------------------------------------------- */
dealBtn?.addEventListener("click", () => {
  unlockAudio();
  dealRound();
});

hitBtn?.addEventListener("click", hit);
standBtn?.addEventListener("click", stand);
doubleBtn?.addEventListener("click", doubleDown);
splitBtn?.addEventListener("click", splitHand);

chipButtons.forEach((button) => {
  button.addEventListener("click", () => {
    if (!["idle", "settled"].includes(state.phase)) return;
    state.bet = Number(button.dataset.bjChip);
    sfx("click");
    updateHud();
    persist();
    announce(`下注額調整為 ${formatCredits(state.bet)} 點。`);
  });
});

resetBtn?.addEventListener("click", () => {
  if (!["idle", "settled"].includes(state.phase)) return;
  state.balance = DEFAULT_STATE.balance;
  state.bet = DEFAULT_STATE.bet;
  state.hands = [];
  state.dealer = [];
  state.active = -1;
  state.phase = "idle";
  state.stats = emptyStats();
  setResult("等待下注", "選擇籌碼後按「發牌」");
  if (dealerCardsEl) dealerCardsEl.replaceChildren();
  if (playerHandsEl) playerHandsEl.replaceChildren();
  updateHud();
  persist();
  announce("已補充 10,000 點虛擬籌碼，統計歸零。");
  sfx("cash");
});

document.addEventListener("keydown", (event) => {
  const target = event.target;
  if (target.closest("input, select, textarea, [contenteditable]")) return;

  /* 只在遊戲區或頁面空白處攔截快捷鍵：
     焦點在導覽或頁尾連結時，按 H／S 不應誤觸遊戲操作。 */
  const inGame =
    target === document.body ||
    target === document.documentElement ||
    Boolean(target.closest(".game-shell"));
  if (!inGame) return;

  const onControl = Boolean(target.closest("button, a"));
  const isSpace = event.code === "Space" || event.key === " ";
  if (isSpace && !onControl && ["idle", "settled"].includes(state.phase)) {
    event.preventDefault();
    dealRound();
  } else if (state.phase === "player") {
    /* 字母快捷鍵不影響按鈕啟動，因此焦點在遊戲按鈕上時仍可使用。 */
    const key = event.key.toLowerCase();
    if (key === "h") hit();
    else if (key === "s") stand();
    else if (key === "d") doubleDown();
    else if (key === "p") splitHand();
  }
});

/* --------------------------------------------------------------------------
   初始化
   -------------------------------------------------------------------------- */
restoreOrCreate();
updateHud();
if (["player", "dealer", "settled"].includes(state.phase)) {
  renderDealer(state.phase !== "player");
  renderPlayerHands();
  setResult(state.resultTitle, state.resultText);
  if (state.phase === "dealer") {
    announce("已恢復未完成的牌局，莊家將繼續補牌。");
    window.setTimeout(playDealer, reduceMotion ? 200 : 700);
  } else if (state.phase === "player") {
    announce(
      `已恢復未完成的牌局。玩家 ${blackjackValue(state.hands[state.active]?.cards || []).total} 點，請繼續操作。`,
    );
  } else {
    announce("已恢復上一局結果。可按「下一局」繼續。");
  }
} else {
  setResult("等待下注", "選擇籌碼後按「發牌」");
  announce(
    "21 點已就緒。選擇籌碼後按「發牌」；所有點數皆為虛擬點數，莊家軟 17 停牌。",
  );
}
