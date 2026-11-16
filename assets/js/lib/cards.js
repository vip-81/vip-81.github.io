/**
 * 撲克牌共用工具：建立牌靴、點數、渲染牌面。
 * 牌面使用 DOM + CSS，方便螢幕閱讀器與文字縮放；不依賴圖片。
 */

import { shuffleInPlace } from "./rng.js";

export const SUITS = [
  { symbol: "♠", name: "黑桃", red: false },
  { symbol: "♥", name: "紅心", red: true },
  { symbol: "♦", name: "方塊", red: true },
  { symbol: "♣", name: "梅花", red: false },
];

export const RANKS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];

export function rankLabel(rank) {
  if (rank === 1) return "A";
  if (rank === 11) return "J";
  if (rank === 12) return "Q";
  if (rank === 13) return "K";
  return String(rank);
}

/** 建立並洗好 n 副牌；每張牌有唯一 id，供 SHA-256 指紋使用 */
export function createShoe(deckCount = 8) {
  const cards = [];
  for (let deck = 0; deck < deckCount; deck += 1) {
    for (let suit = 0; suit < SUITS.length; suit += 1) {
      for (const rank of RANKS) {
        cards.push({
          rank,
          suit,
          id: `d${deck}-s${suit}-r${rank}`,
        });
      }
    }
  }
  return shuffleInPlace(cards);
}

export function cardLabel(card) {
  return `${SUITS[card.suit].name}${rankLabel(card.rank)}`;
}

/** 21 點點數：A 可算 1 或 11，回傳總和與是否為軟牌 */
export function blackjackValue(cards) {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    if (card.rank === 1) {
      aces += 1;
      total += 11;
    } else if (card.rank >= 10) {
      total += 10;
    } else {
      total += card.rank;
    }
  }
  let soft = aces > 0;
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  if (aces === 0) soft = false;
  return { total, soft };
}

/** 百家樂點數：A=1，2–9 依面值，10/J/Q/K=0，總和取個位數 */
export function baccaratValue(cards) {
  return cards.reduce((sum, card) => {
    if (card.rank === 1) return sum + 1;
    if (card.rank >= 10) return sum;
    return sum + card.rank;
  }, 0) % 10;
}

export function isPair(cards) {
  return cards.length >= 2 && cards[0].rank === cards[1].rank;
}

/**
 * 產生撲克牌 HTML
 * @param {object} card
 * @param {{faceDown?: boolean, delayMs?: number}} options
 */
export function cardMarkup(card, options = {}) {
  const { faceDown = false, delayMs = 0 } = options;
  const suit = SUITS[card.suit];
  const rank = rankLabel(card.rank);
  const classes = [
    "playing-card",
    suit.red ? "playing-card--red" : "",
    faceDown ? "playing-card--back" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const label = faceDown ? "未翻開的牌" : cardLabel(card);
  const style = delayMs ? ` style="animation-delay:${delayMs}ms"` : "";
  const front = faceDown
    ? ""
    : `<div class="playing-card__face playing-card__face--front">
        <span class="playing-card__corner"><span>${rank}</span><span>${suit.symbol}</span></span>
        <span class="playing-card__pip" aria-hidden="true">${suit.symbol}</span>
        <span class="playing-card__corner playing-card__corner--bottom"><span>${rank}</span><span>${suit.symbol}</span></span>
      </div>`;

  return `<div class="${classes}" role="img" aria-label="${label}"${style}>
    <div class="playing-card__inner">
      ${front}
      <div class="playing-card__face playing-card__face--back" aria-hidden="true"></div>
    </div>
  </div>`;
}

/** 建立牌靴指紋（顯示用短碼） */
export async function shoeFingerprint(cards) {
  const { sha256Hex } = await import("./rng.js");
  const full = await sha256Hex(cards.map((card) => card.id).join("|"));
  return { full, short: full.slice(0, 16).toUpperCase() };
}
