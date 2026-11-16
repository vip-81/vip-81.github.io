/**
 * 極簡有限狀態機（FSM）
 * 設計目標：
 * 1. 明確限制「哪個狀態可以接收哪個事件」，避免旋轉中重複下注。
 * 2. 可注入 guard（條件）與 action（副作用），方便接伺服器。
 * 3. 不依賴框架，易於單元測試。
 *
 * 設定格式：
 * {
 *   idle: {
 *     onEnter(ctx, payload, machine) {},
 *     onExit(ctx, payload, machine) {},
 *     on: {
 *       SPIN: { target: "spinning", guard(ctx, payload) { return true; }, action(ctx, payload) {} }
 *     }
 *   }
 * }
 */

export class StateMachine {
  #state;
  #states;
  #context;
  #listeners = new Set();
  #log = [];

  constructor(initialState, states, context = {}) {
    if (!states[initialState]) {
      throw new Error(`FSM 初始狀態不存在：${initialState}`);
    }
    this.#state = initialState;
    this.#states = states;
    this.#context = context;
    // 注意：不在建構時呼叫初始狀態的 onEnter。
    // 讓呼叫端在完成所有依賴初始化後，自行呼叫 UI 初始化，
    // 可避免 onEnter 讀取尚未賦值的 machine 變數（TDZ）。
    this.#record(initialState, "__init__", initialState, undefined);
  }

  get state() {
    return this.#state;
  }

  get context() {
    return this.#context;
  }

  /** 取得最近 20 筆轉移紀錄，方便除錯 */
  get history() {
    return [...this.#log];
  }

  /** 檢查目前狀態是否能處理事件 */
  can(eventName) {
    return Boolean(this.#states[this.#state]?.on?.[eventName]);
  }

  /**
   * 發送事件
   * @returns {boolean} 是否成功轉移
   */
  send(eventName, payload) {
    const currentName = this.#state;
    const transition = this.#states[currentName]?.on?.[eventName];
    if (!transition) {
      console.warn(`[FSM] 狀態「${currentName}」不接受事件「${eventName}」`);
      return false;
    }

    const { target, guard, action } = transition;
    if (!this.#states[target]) {
      console.error(`[FSM] 目標狀態不存在：${target}`);
      return false;
    }
    if (guard && !guard(this.#context, payload, this)) {
      return false;
    }

    const fromName = currentName;
    this.#states[fromName].onExit?.(this.#context, payload, this);
    action?.(this.#context, payload, this);
    this.#state = target;
    this.#states[target].onEnter?.(this.#context, payload, this);
    this.#record(fromName, eventName, target, payload);

    for (const listener of this.#listeners) {
      try {
        listener({ from: fromName, event: eventName, to: target, payload });
      } catch (error) {
        console.error("[FSM] 轉移監聽器錯誤：", error);
      }
    }
    return true;
  }

  /** 訂閱狀態轉移 */
  onTransition(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #record(from, event, to, payload) {
    this.#log.push({ from, event, to, at: Date.now(), payload });
    if (this.#log.length > 20) this.#log.shift();
  }
}
