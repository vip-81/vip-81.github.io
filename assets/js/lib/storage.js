/**
 * localStorage 安全封裝
 * Safari 無痕模式、企業政策或空間不足時可能拋錯，因此全部包在 try/catch。
 */

const PREFIX = "luckyforge:v1:";

export function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    return JSON.parse(raw);
  } catch (error) {
    console.warn("[storage] 讀取失敗，使用預設值：", error);
    return fallback;
  }
}

export function saveJSON(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch (error) {
    console.warn("[storage] 寫入失敗（可能為無痕模式或空間不足）：", error);
    return false;
  }
}

export function removeKey(key) {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch (error) {
    console.warn("[storage] 刪除失敗：", error);
  }
}

/** 數字格式化：保留最多兩位小數，使用繁中千分位 */
export function formatCredits(value, maximumFractionDigits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return number.toLocaleString("zh-Hant-TW", {
    maximumFractionDigits,
    minimumFractionDigits: 0,
  });
}

/** 限制數值範圍 */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** 建立 DOM 節點的小工具，避免到處拼 innerHTML */
export function el(tagName, className, text) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
