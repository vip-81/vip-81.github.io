/**
 * Web Audio 合成音效（不載入任何音檔，節省請求與頻寬）
 * iOS / Safari 限制：AudioContext 必須在使用者手勢中建立或 resume。
 * 因此本模組只在使用者第一次 pointerdown / keydown 後解鎖。
 */

import { loadJSON, saveJSON } from "./storage.js";

let audioCtx = null;
let masterGain = null;
let noiseBuffer = null;
let muted = Boolean(loadJSON("audio-muted", false));

const MASTER_VOLUME = 0.16;

function createContext() {
  if (audioCtx) return audioCtx;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;

  try {
    audioCtx = new AudioContextClass();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = muted ? 0 : MASTER_VOLUME;
    masterGain.connect(audioCtx.destination);
    return audioCtx;
  } catch (error) {
    console.warn("[audio] 無法建立 AudioContext：", error);
    return null;
  }
}

function emitChange() {
  document.dispatchEvent(
    new CustomEvent("luckyforge:audiochange", { detail: { muted } }),
  );
}

/** 在使用者手勢中呼叫；重複呼叫安全 */
export async function unlockAudio() {
  const ctx = createContext();
  if (!ctx) return false;
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch (error) {
      console.warn("[audio] resume 失敗：", error);
      return false;
    }
  }
  return ctx.state === "running";
}

export function isMuted() {
  return muted;
}

export function setMuted(nextMuted) {
  muted = Boolean(nextMuted);
  saveJSON("audio-muted", muted);
  if (masterGain && audioCtx) {
    masterGain.gain.cancelScheduledValues(audioCtx.currentTime);
    masterGain.gain.setTargetAtTime(
      muted ? 0 : MASTER_VOLUME,
      audioCtx.currentTime,
      0.02,
    );
  }
  emitChange();
}

export function toggleMuted() {
  setMuted(!muted);
  if (!muted) unlockAudio();
  return muted;
}

function noise(duration, volume, filterType, filterFreq, delay = 0) {
  if (!audioCtx || muted) return;
  if (!noiseBuffer) {
    const length = Math.floor(audioCtx.sampleRate * 0.5);
    noiseBuffer = audioCtx.createBuffer(1, length, audioCtx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) {
      data[i] = Math.random() * 2 - 1;
    }
  }

  const now = audioCtx.currentTime + delay;
  const source = audioCtx.createBufferSource();
  source.buffer = noiseBuffer;
  const filter = audioCtx.createBiquadFilter();
  filter.type = filterType;
  filter.frequency.value = filterFreq;
  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(volume, now + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  source.connect(filter);
  filter.connect(gain);
  gain.connect(masterGain);
  source.start(now);
  source.stop(now + duration + 0.02);
}

function tone({
  from,
  to = from,
  duration = 0.12,
  type = "sine",
  volume = 0.1,
  delay = 0,
}) {
  if (!audioCtx || muted) return;
  const now = audioCtx.currentTime + delay;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(Math.max(20, from), now);
  osc.frequency.exponentialRampToValueAtTime(
    Math.max(20, to),
    now + duration,
  );
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(volume, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  osc.connect(gain);
  gain.connect(masterGain);
  osc.start(now);
  osc.stop(now + duration + 0.03);
}

/** 依名稱播放合成音效；音效未解鎖時自動忽略 */
export function sfx(name) {
  if (!audioCtx || muted || audioCtx.state !== "running") return;

  switch (name) {
    case "click":
      tone({ from: 900, to: 720, duration: 0.035, type: "square", volume: 0.035 });
      break;
    case "chip":
      tone({ from: 1280, to: 900, duration: 0.04, type: "triangle", volume: 0.05 });
      break;
    case "spin":
      noise(0.28, 0.045, "bandpass", 900);
      tone({ from: 190, to: 90, duration: 0.32, type: "sawtooth", volume: 0.025 });
      break;
    case "reel":
      noise(0.045, 0.05, "highpass", 1600);
      tone({ from: 330, to: 150, duration: 0.09, type: "triangle", volume: 0.055 });
      break;
    case "deal":
      noise(0.06, 0.05, "highpass", 2200);
      break;
    case "win":
      [523.25, 659.25, 783.99].forEach((freq, index) => {
        tone({ from: freq, duration: 0.16, type: "sine", volume: 0.07, delay: index * 0.075 });
      });
      break;
    case "bigwin":
      [392, 523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((freq, index) => {
        tone({ from: freq, duration: 0.28, type: "triangle", volume: 0.075, delay: index * 0.11 });
      });
      tone({ from: 98, duration: 0.8, type: "sine", volume: 0.05 });
      break;
    case "freespin":
      [880, 1174.66, 1567.98].forEach((freq, index) => {
        tone({ from: freq, duration: 0.22, type: "sine", volume: 0.055, delay: index * 0.1 });
      });
      break;
    case "bullet":
      tone({ from: 740, to: 260, duration: 0.07, type: "sine", volume: 0.035 });
      break;
    case "hit":
      noise(0.055, 0.045, "bandpass", 1300);
      break;
    case "explosion":
      noise(0.36, 0.11, "lowpass", 420);
      tone({ from: 120, to: 45, duration: 0.4, type: "sine", volume: 0.075 });
      break;
    case "cash":
      tone({ from: 1568, to: 1568, duration: 0.09, type: "triangle", volume: 0.05 });
      tone({ from: 2093, to: 2093, duration: 0.12, type: "triangle", volume: 0.045, delay: 0.07 });
      break;
    case "lose":
      tone({ from: 300, to: 150, duration: 0.25, type: "triangle", volume: 0.045 });
      break;
    case "roulette":
      tone({ from: 1400, to: 1180, duration: 0.022, type: "square", volume: 0.016 });
      break;
    default:
      break;
  }
}
