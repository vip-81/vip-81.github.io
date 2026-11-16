/**
 * 密碼學安全隨機數工具
 * 所有遊戲結果一律使用 crypto.getRandomValues，不使用 Math.random。
 * 注意：此為前端展示；正式環境的結果必須由伺服器 RNG 產生並簽章。
 */

const UINT32_RANGE = 4294967296;

/** 回傳 [0, 1) 的密碼學安全隨機浮點數 */
export function secureRandom() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] / UINT32_RANGE;
}

/** 回傳 [0, maxExclusive) 的整數，使用拒絕取樣避免模數偏差 */
export function randomInt(maxExclusive) {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
    throw new RangeError("maxExclusive 必須是正整數");
  }
  const limit = Math.floor(UINT32_RANGE / maxExclusive) * maxExclusive;
  const buf = new Uint32Array(1);
  do {
    crypto.getRandomValues(buf);
  } while (buf[0] >= limit);
  return buf[0] % maxExclusive;
}

/** 以 Fisher–Yates 原地洗牌（使用安全隨機數） */
export function shuffleInPlace(list) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/**
 * 依權重挑選項目
 * @param {Array<[unknown, number]>} entries 例如 [["A", 20], ["B", 3]]
 */
export function pickWeighted(entries) {
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (total <= 0) throw new RangeError("權重總和必須大於 0");
  let roll = secureRandom() * total;
  for (const [value, weight] of entries) {
    roll -= weight;
    if (roll < 0) return value;
  }
  return entries[entries.length - 1][0];
}

/** 計算 SHA-256 十六進位字串；用於牌靴指紋與公平性展示 */
export async function sha256Hex(text) {
  if (!globalThis.crypto?.subtle) {
    throw new Error("此瀏覽器不支援 Web Crypto（需 HTTPS 或 localhost）");
  }
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
