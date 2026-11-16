/**
 * 全站互動：行動選單、音效開關、捲動狀態、進場動畫、複製引用連結。
 * 所有功能都採漸進增強：停用 JS 時內容仍可閱讀與導覽。
 */

import {
  isMuted,
  toggleMuted,
  unlockAudio,
  setMuted,
} from "./lib/audio.js";
import { showToast } from "./lib/ui.js";

const header = document.querySelector("[data-header]");
const navToggle = document.querySelector("[data-nav-toggle]");
const nav = document.querySelector("#primary-nav");
const audioButtons = document.querySelectorAll("[data-audio-toggle]");

/* 1. 站頭捲動狀態 ------------------------------------------------------- */
function updateHeader() {
  if (!header) return;
  header.classList.toggle("is-scrolled", window.scrollY > 8);
}

updateHeader();
window.addEventListener("scroll", updateHeader, { passive: true });

/* 2. 行動選單 ------------------------------------------------------------ */
function setMenu(open) {
  if (!navToggle || !nav) return;
  navToggle.setAttribute("aria-expanded", String(open));
  nav.classList.toggle("is-open", open);
  document.body.classList.toggle("nav-open", open);
}

if (navToggle && nav) {
  navToggle.addEventListener("click", () => {
    setMenu(navToggle.getAttribute("aria-expanded") !== "true");
    unlockAudio();
  });

  nav.addEventListener("click", (event) => {
    if (event.target.closest("a")) setMenu(false);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && nav.classList.contains("is-open")) {
      setMenu(false);
      navToggle.focus();
    }
  });

  document.addEventListener("click", (event) => {
    if (
      nav.classList.contains("is-open") &&
      !nav.contains(event.target) &&
      !navToggle.contains(event.target)
    ) {
      setMenu(false);
    }
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth > 860) setMenu(false);
  });
}

/* 3. 音效開關 ------------------------------------------------------------ */
function syncAudioButtons() {
  const muted = isMuted();
  for (const button of audioButtons) {
    button.setAttribute("aria-pressed", String(muted));
    button.setAttribute("aria-label", muted ? "開啟音效" : "關閉音效");
    button.title = muted ? "開啟音效" : "關閉音效";
  }
}

if (audioButtons.length) {
  syncAudioButtons();
  for (const button of audioButtons) {
    button.addEventListener("click", () => {
      toggleMuted();
      if (!isMuted()) unlockAudio();
    });
  }
  document.addEventListener("luckyforge:audiochange", syncAudioButtons);
}

/* 第一次手勢解鎖 Web Audio（iOS Safari 必要流程） */
let audioUnlockAttached = true;
function firstGesture() {
  if (!audioUnlockAttached) return;
  unlockAudio().then((unlocked) => {
    if (unlocked) {
      audioUnlockAttached = false;
      window.removeEventListener("pointerdown", firstGesture, true);
      window.removeEventListener("keydown", firstGesture, true);
    }
  });
}
window.addEventListener("pointerdown", firstGesture, true);
window.addEventListener("keydown", firstGesture, true);

/* 若使用者曾經靜音，維持狀態；若曾開啟，手勢後自動恢復 */
if (isMuted()) setMuted(true);

/* 4. 進場動畫（尊重 reduced-motion） -------------------------------------- */
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
if (!reduceMotion && "IntersectionObserver" in window) {
  const targets = document.querySelectorAll("[data-reveal]");
  targets.forEach((target) => target.classList.add("reveal"));
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
  );
  targets.forEach((target) => observer.observe(target));
}

/* 5. 複製引用連結（GEO：方便 AI 與讀者引用） ------------------------------ */
document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy-link]");
  if (!button) return;
  const value = button.dataset.copyLink || window.location.href;
  try {
    await navigator.clipboard.writeText(value);
    showToast("已複製連結");
  } catch (error) {
    console.warn("[site] 剪貼簿不可用：", error);
    showToast("請手動複製網址：" + value, 4200);
  }
});

/* 6. 年份 ----------------------------------------------------------------- */
document.querySelectorAll("[data-current-year]").forEach((node) => {
  node.textContent = String(new Date().getFullYear());
});

/* 7. 新視窗連結安全屬性 ---------------------------------------------------- */
document.querySelectorAll('a[target="_blank"]').forEach((link) => {
  link.rel = "noopener noreferrer";
});

/* 8. 行動選單焦點管理 ------------------------------------------------------ */
document.addEventListener("keydown", (event) => {
  if (event.key !== "Tab" || !nav?.classList.contains("is-open")) return;
  const focusable = [
    ...nav.querySelectorAll("a[href], button:not([disabled])"),
  ];
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});
