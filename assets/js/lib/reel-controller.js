/**
 * LuckyForge Lab — 5×3 Reel Spin / Stop Controller
 * ------------------------------------------------------------------
 * 純 JavaScript 模組，不綁定任何渲染引擎。每次 update(now) 回傳「每幀位移資料」
 * （symbol 單位與像素單位），由呼叫端自行畫到 Canvas / DOM / WebGL。
 *
 * 【重要設計約束】
 * 本模組**不計算中獎，也不解讀 paylines**。
 * matrix（5×3 結果）、paylines（中獎線索引）、seed 全部由後端傳入，
 * 控制器只負責：滾動 → 依序減速 → 向下超調 → 向上回彈 → 交出結果。
 * 那個「結果」就是原樣回傳的後端資料，客戶端沒有任何改寫機會。
 *
 * 狀態機：Idle → SpinUp → LoopScroll → SpinDown → Bounce → ResultShow
 */

export const REEL_COUNT = 5;
export const ROW_COUNT = 3;

/** 全域狀態（供 UI / 測試訂閱） */
export const REEL_STATE = Object.freeze({
  IDLE: 'Idle',
  SPIN_UP: 'SpinUp',
  LOOP_SCROLL: 'LoopScroll',
  SPIN_DOWN: 'SpinDown',
  BOUNCE: 'Bounce',
  RESULT_SHOW: 'ResultShow',
});

/** 單軸階段（比全域狀態更細） */
export const REEL_PHASE = Object.freeze({
  STOPPED: 'stopped',
  SPIN_UP: 'spinUp',
  LOOP: 'loop',
  SPIN_DOWN: 'spinDown',
  BOUNCE: 'bounce',
  LOCKED: 'locked',
});

const DEFAULTS = Object.freeze({
  /** 每軸共用的 symbol strip（長度建議 ≥ 24） */
  strip: [
    'A', 'B', 'C', 'D', 'E', 'A', 'B', 'C',
    'D', 'E', 'A', 'B', 'C', 'D', 'E', 'A',
    'B', 'C', 'D', 'E', 'A', 'B', 'C', 'D',
  ],
  /** 一個 symbol 的高度（px）。只用於換算 offsetPx，不參與邏輯。 */
  symbolHeight: 96,
  /** 啟動加速時間（ms）：0 → maxVelocity */
  spinUpMs: 420,
  /** 最早可開始減速前，至少維持等速滾動的時間（ms） */
  minLoopMs: 720,
  /** 單軸減速時間（ms） */
  spinDownMs: 780,
  /** 單軸回彈時間（ms） */
  bounceMs: 460,
  /** 相鄰兩軸開始減速的間隔（ms），需求指定 200ms */
  staggerMs: 200,
  /** 等速階段最大速度（symbol / 秒） */
  maxVelocity: 18,
  /** 停止時向下超調量（symbol 單位） */
  overshoot: 0.32,
  /**
   * 若 strip 中找不到後端指定的 3-symbol 連續視窗，
   * 是否在「本地副本」上把該視窗釘成後端值（預設 true）。
   * 這只是視覺對齊，不會回寫共享 strip，也不會改變 matrix。
   */
  pinWindow: true,
});

function mod(n, m) {
  return ((n % m) + m) % m;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 三次 Hermite：給定起點、終點、起始速度、結束速度 0，回傳位置與速度 */
function hermite(p0, p1, v0, durationMs, u) {
  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;
  const m0 = v0 * durationMs; // symbol/ms * ms = symbol

  const position = h00 * p0 + h10 * m0 + h01 * p1 + h11 * 0;

  const dh00 = 6 * u2 - 6 * u;
  const dh10 = 3 * u2 - 4 * u + 1;
  const dh01 = -6 * u2 + 6 * u;
  const dh11 = 3 * u2 - 2 * u;
  // 回傳 symbol/ms；上層再 *1000 轉成 symbol/sec
  const velocity = (dh00 * p0 + dh10 * m0 + dh01 * p1) / durationMs;

  return { position, velocity };
}

/**
 * 建立控制器
 * @param {Partial<typeof DEFAULTS>} [options]
 */
export function createReelController(options = {}) {
  const cfg = Object.assign({}, DEFAULTS, options);
  const L = cfg.strip.length;
  if (L < ROW_COUNT) {
    throw new Error(`strip 長度至少要有 ${ROW_COUNT}，目前為 ${L}`);
  }

  // 每軸一份本地 strip 副本：pinWindow 只改自己那軸，不影響其他軸，也不回寫外部陣列
  let localStrips = [];
  let matrix = null;
  let paylines = [];
  let seed = 0;
  let stopIndices = [];
  let startedAt = 0;
  let started = false;
  let resultEmitted = false;
  let state = REEL_STATE.IDLE;
  let previousFrame = null;
  let timeScale = 1;

  const onStateChange = typeof options.onStateChange === 'function' ? options.onStateChange : null;
  const onResult = typeof options.onResult === 'function' ? options.onResult : null;
  const onReelStop = typeof options.onReelStop === 'function' ? options.onReelStop : null;

  const vMaxPerMs = cfg.maxVelocity / 1000;
  // 加速階段 v(t) = vMax * u²，積分距離 = vMax * T / 3
  const spinUpDistance = vMaxPerMs * cfg.spinUpMs / 3;
  const firstStopOffset = cfg.spinUpMs + cfg.minLoopMs;
  const spinDownEndOffset = (i) => firstStopOffset + i * cfg.staggerMs + cfg.spinDownMs;
  const bounceEndOffset = (i) => spinDownEndOffset(i) + cfg.bounceMs;
  const resultOffset = bounceEndOffset(REEL_COUNT - 1);

  /** 在指定軸的 strip 中找出符合 [top, mid, bottom] 的連續視窗起點 */
  function findWindow(column, strip) {
    for (let i = 0; i < L; i++) {
      let ok = true;
      for (let r = 0; r < ROW_COUNT; r++) {
        if (strip[mod(i + r, L)] !== column[r]) { ok = false; break; }
      }
      if (ok) return i;
    }
    return -1;
  }

  /** 依後端 payload 建立本地 strip 與每軸停位 */
  function prepare(payload) {
    if (!payload || !Array.isArray(payload.matrix)) {
      throw new Error('payload.matrix 必須是 5×3 陣列');
    }
    if (payload.matrix.length !== REEL_COUNT ||
        payload.matrix.some((col) => !Array.isArray(col) || col.length !== ROW_COUNT)) {
      throw new Error('payload.matrix 必須是 5 軸 × 3 行');
    }
    if (payload.paylines !== undefined && !Array.isArray(payload.paylines)) {
      throw new Error('payload.paylines 必須是陣列');
    }

    matrix = payload.matrix.map((col) => col.slice());
    localStrips = matrix.map(() => cfg.strip.slice());
    paylines = Object.freeze((payload.paylines || []).slice());
    seed = Number(payload.seed) || 0;

    if (Array.isArray(payload.stopIndices) && payload.stopIndices.length === REEL_COUNT) {
      stopIndices = payload.stopIndices.map((i) => mod(Math.trunc(Number(i) || 0), L));
    } else {
      stopIndices = matrix.map((column, reelIndex) => {
        const strip = localStrips[reelIndex];
        const found = findWindow(column, strip);
        if (found >= 0) return found;
        if (!cfg.pinWindow) {
          throw new Error(`軸 ${reelIndex} 的 strip 找不到視窗 ${column.join(',')}，且 pinWindow=false`);
        }
        // 以中間 symbol 挑一個落點，然後在「本軸副本」把 3 格釘成後端值
        let idx = strip.indexOf(column[1]);
        if (idx < 0) idx = 0;
        for (let r = 0; r < ROW_COUNT; r++) {
          strip[mod(idx + r, L)] = column[r];
        }
        return idx;
      });
    }
  }

  function setState(next) {
    if (state === next) return;
    const from = state;
    state = next;
    if (onStateChange) onStateChange(from, next);
  }

  /** 計算單軸在時間軸上的位置（symbol 單位）與速度（symbol/sec） */
  function reelAt(i, elapsed) {
    const startOffset = firstStopOffset + i * cfg.staggerMs;
    const sdEnd = spinDownEndOffset(i);
    const bEnd = bounceEndOffset(i);
    const targetIndex = stopIndices[i];

    if (elapsed <= cfg.spinUpMs) {
      const u = clamp01(elapsed / cfg.spinUpMs);
      // v = vMax*u² → p = ∫v dt = vMax*T*u³/3
      return {
        position: spinUpDistance * u * u * u,
        velocitySymbolPerSec: cfg.maxVelocity * u * u,
        phase: REEL_PHASE.SPIN_UP,
        locked: false,
      };
    }

    if (elapsed < startOffset) {
      const loopMs = elapsed - cfg.spinUpMs;
      return {
        position: spinUpDistance + vMaxPerMs * loopMs,
        velocitySymbolPerSec: cfg.maxVelocity,
        phase: REEL_PHASE.LOOP,
        locked: false,
      };
    }

    // 在減速起點做 snapshot（以 startAt 為基準，純函式、可重入）
    const p0 = spinUpDistance + vMaxPerMs * (startOffset - cfg.spinUpMs);
    const v0 = vMaxPerMs;
    const base = mod(targetIndex - p0, L);
    // 讓減速距離至少等於 v0*T/2，Hermite 才不會出現倒退
    const minDistance = v0 * cfg.spinDownMs * 0.5;
    let distance = base;
    while (distance < minDistance) distance += L;
    const p1 = p0 + distance; // ≡ targetIndex (mod L)

    if (elapsed < sdEnd) {
      const u = clamp01((elapsed - startOffset) / cfg.spinDownMs);
      const h = hermite(p0, p1, v0, cfg.spinDownMs, u);
      return {
        position: h.position,
        velocitySymbolPerSec: h.velocity * 1000,
        phase: REEL_PHASE.SPIN_DOWN,
        locked: false,
      };
    }

    if (elapsed < bEnd) {
      const u = clamp01((elapsed - sdEnd) / cfg.bounceMs);
      // 向下超調再回到 p1：sin(πu)*(1-u)，u=0/1 時為 0，最大值約在 u≈0.3
      const wave = Math.sin(Math.PI * u) * (1 - u);
      const position = p1 + cfg.overshoot * wave;
      const du = 0.0001;
      const u2 = clamp01(u + du);
      const wave2 = Math.sin(Math.PI * u2) * (1 - u2);
      const velocity = ((cfg.overshoot * (wave2 - wave)) / (du * cfg.bounceMs)) * 1000;
      return {
        position,
        velocitySymbolPerSec: velocity,
        phase: REEL_PHASE.BOUNCE,
        locked: false,
      };
    }

    return {
      position: p1,
      velocitySymbolPerSec: 0,
      phase: REEL_PHASE.LOCKED,
      locked: true,
    };
  }

  function visibleWindow(position, reelIndex) {
    const strip = localStrips[reelIndex] || cfg.strip;
    // +1e-6 吸收 Hermite 累加的浮點誤差，避免最終停位 26.0 被 floor 成 25
    const base = mod(Math.floor(position + 1e-6), L);
    return [
      strip[mod(base, L)],
      strip[mod(base + 1, L)],
      strip[mod(base + 2, L)],
    ];
  }

  const controller = {
    /** 目前全域狀態 */
    get state() { return state; },
    /** 是否正在旋轉 */
    get spinning() { return started && state !== REEL_STATE.IDLE && state !== REEL_STATE.RESULT_SHOW; },
    /** 總時長（ms），可供測試與排程 */
    get totalDurationMs() { return resultOffset; },
    /** 單軸開始減速的絕對時間點（相對於 start） */
    getStopStartOffset(i) { return firstStopOffset + i * cfg.staggerMs; },

    /**
     * 啟動一次旋轉
     * @param {{matrix: string[][], paylines?: number[], seed?: number, stopIndices?: number[]}} payload
     * @param {number} now 目前的 performance.now()
     */
    start(payload, now = 0) {
      prepare(payload);
      startedAt = now;
      started = true;
      resultEmitted = false;
      previousFrame = null;
      setState(REEL_STATE.SPIN_UP);
      return this.update(now);
    },

    /** 重設回 Idle */
    reset() {
      started = false;
      resultEmitted = false;
      matrix = null;
      paylines = [];
      stopIndices = [];
      previousFrame = null;
      setState(REEL_STATE.IDLE);
    },

    /** 時間縮放（除錯用：2 = 兩倍速；不影響結果） */
    setTimeScale(scale) {
      timeScale = Math.max(0.01, Number(scale) || 1);
    },

    /**
     * 推進一幀
     * @param {number} now performance.now() 絕對毫秒
     * @returns {{
     *   state: string, elapsedMs: number, reels: Array<object>,
     *   result: {matrix: string[][], paylines: readonly number[], seed: number}|null
     * }}
     */
    update(now) {
      if (!started) {
        return {
          state: REEL_STATE.IDLE,
          elapsedMs: 0,
          reels: Array.from({ length: REEL_COUNT }, (_, i) => ({
            index: i,
            position: 0,
            offsetPx: 0,
            velocity: 0,
            phase: REEL_PHASE.STOPPED,
            stopped: true,
            visible: visibleWindow(0, i),
          })),
          result: null,
        };
      }

      const elapsed = Math.max(0, (now - startedAt) * timeScale);

      if (elapsed < cfg.spinUpMs) setState(REEL_STATE.SPIN_UP);
      else if (elapsed < firstStopOffset) setState(REEL_STATE.LOOP_SCROLL);
      else if (elapsed < spinDownEndOffset(REEL_COUNT - 1)) setState(REEL_STATE.SPIN_DOWN);
      else if (elapsed < resultOffset) setState(REEL_STATE.BOUNCE);
      else setState(REEL_STATE.RESULT_SHOW);

      const reels = [];
      for (let i = 0; i < REEL_COUNT; i++) {
        const r = reelAt(i, elapsed);
        const frac = r.position - Math.floor(r.position);
        reels.push({
          index: i,
          /** 連續位置（symbol 單位，向下增大） */
          position: r.position,
          /** 小數部分（0..1） */
          fraction: frac,
          /** 給渲染層的 translateY；符號列往下滾時用負值 */
          offsetPx: -frac * cfg.symbolHeight,
          /** 速度（symbol / 秒） */
          velocity: r.velocitySymbolPerSec,
          phase: r.phase,
          stopped: r.locked,
          /** 該軸目前應該顯示的三個 symbol（由 strip 決定，不是中獎判斷） */
          visible: visibleWindow(r.position, i),
          /** 後端指定停位（symbol 單位） */
          targetIndex: stopIndices[i],
        });

        if (r.locked && previousFrame && !previousFrame.reels[i].stopped && onReelStop) {
          onReelStop(i, reels[i]);
        }
      }

      const frame = {
        state,
        elapsedMs: elapsed,
        reels,
        /**
         * 結果原樣透傳：客戶端只讀，不解讀、不重算。
         * paylines 是後端給的「中獎線索引」，這裡只是帶著走。
         */
        result: state === REEL_STATE.RESULT_SHOW ? Object.freeze({
          matrix: matrix.map((col) => Object.freeze(col.slice())),
          paylines,
          seed,
        }) : null,
      };

      if (state === REEL_STATE.RESULT_SHOW && !resultEmitted) {
        resultEmitted = true;
        if (onResult) onResult(frame.result);
      }

      previousFrame = frame;
      return frame;
    },

    /** 給測試：直接跳到結果（不改矩陣、不計算中獎） */
    settleImmediately(now = 0) {
      if (!started) this.start({ matrix: [], paylines: [] }, now);
      return this.update(now + resultOffset + 1);
    },
  };

  return controller;
}

export default createReelController;
