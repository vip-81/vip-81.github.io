/** 5×3 Reel 滾動／停止控制器型別定義（對應 reel-controller.js） */

export declare const REEL_COUNT: 5;
export declare const ROW_COUNT: 3;

export declare const REEL_STATE: {
  readonly IDLE: 'Idle';
  readonly SPIN_UP: 'SpinUp';
  readonly LOOP_SCROLL: 'LoopScroll';
  readonly SPIN_DOWN: 'SpinDown';
  readonly BOUNCE: 'Bounce';
  readonly RESULT_SHOW: 'ResultShow';
};
export type ReelState = (typeof REEL_STATE)[keyof typeof REEL_STATE];

export declare const REEL_PHASE: {
  readonly STOPPED: 'stopped';
  readonly SPIN_UP: 'spinUp';
  readonly LOOP: 'loop';
  readonly SPIN_DOWN: 'spinDown';
  readonly BOUNCE: 'bounce';
  readonly LOCKED: 'locked';
};
export type ReelPhase = (typeof REEL_PHASE)[keyof typeof REEL_PHASE];

export interface ReelControllerOptions {
  /** 每軸共用的 symbol strip */
  strip?: string[];
  /** 一個 symbol 的高度（px），僅用於 offsetPx 換算 */
  symbolHeight?: number;
  /** 啟動加速（ms） */
  spinUpMs?: number;
  /** 最早開始減速前的最低等速時間（ms） */
  minLoopMs?: number;
  /** 單軸減速時間（ms） */
  spinDownMs?: number;
  /** 單軸回彈時間（ms） */
  bounceMs?: number;
  /** 相鄰軸開始減速間隔（ms），需求為 200 */
  staggerMs?: number;
  /** 等速最大速度（symbol/sec） */
  maxVelocity?: number;
  /** 停止時向下超調（symbol 單位） */
  overshoot?: number;
  /** strip 找不到連續視窗時，是否在本機副本釘成後端值 */
  pinWindow?: boolean;
  /** 全域狀態變化回呼 */
  onStateChange?: (from: ReelState, to: ReelState) => void;
  /** 全部軸停止後回呼，payload 由後端決定 */
  onResult?: (result: SpinResult) => void;
  /** 單軸鎖定回呼 */
  onReelStop?: (index: number, reel: ReelFrame) => void;
}

/**
 * 後端回傳資料。控制器不計算中獎，只透傳。
 * matrix 為 5 軸 × 3 行；paylines 為中獎線索引（由後端給定）。
 */
export interface SpinPayload {
  matrix: [string, string, string][];
  paylines?: readonly number[];
  seed?: number;
  /** 選擇性：每軸在 strip 上的停位索引 */
  stopIndices?: readonly number[];
}

export interface SpinResult {
  readonly matrix: readonly (readonly string[])[];
  readonly paylines: readonly number[];
  readonly seed: number;
}

export interface ReelFrame {
  index: number;
  /** 連續位置（symbol 單位，向下增大） */
  position: number;
  /** 小數部分 0..1 */
  fraction: number;
  /** 渲染用 translateY（px） */
  offsetPx: number;
  /** 速度（symbol / 秒） */
  velocity: number;
  phase: ReelPhase;
  stopped: boolean;
  /** 目前應顯示的三個 symbol */
  visible: [string, string, string];
  targetIndex: number;
}

export interface ReelFrameSet {
  state: ReelState;
  elapsedMs: number;
  reels: ReelFrame[];
  result: SpinResult | null;
}

export interface ReelController {
  readonly state: ReelState;
  readonly spinning: boolean;
  readonly totalDurationMs: number;
  getStopStartOffset(index: number): number;
  start(payload: SpinPayload, now?: number): ReelFrameSet;
  reset(): void;
  setTimeScale(scale: number): void;
  update(now: number): ReelFrameSet;
  settleImmediately(now?: number): ReelFrameSet;
}

export declare function createReelController(options?: ReelControllerOptions): ReelController;
export default createReelController;
