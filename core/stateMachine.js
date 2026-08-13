/**
 * =====================================================================
 *  状态机模块（core/stateMachine.js）
 * =====================================================================
 *  管理玩法四状态：IDLE → SUBMITTING → ANIMATING → NEXT_ROUND → IDLE
 *  - 提供状态查询、合法切换、订阅通知。
 *  - 仅 IDLE 状态下允许划屏（canAcceptSwipe），避免手势与状态耦合。
 * =====================================================================
 */

// ---- 状态枚举 ----
const State = Object.freeze({
  IDLE: 'IDLE',             // 等待划屏
  SUBMITTING: 'SUBMITTING', // 已划屏，云函数提交中（禁输入）
  ANIMATING: 'ANIMATING',   // 双方齐，播放结算动画
  NEXT_ROUND: 'NEXT_ROUND', // 动画结束，横幅停留，准备下一轮
});

// ---- 当前状态 ----
let current = State.IDLE;

// ---- 状态变更订阅者 ----
const transitionListeners = [];

/** 获取当前状态 */
function getState() {
  return current;
}

/** 是否允许接收划屏手势（仅 IDLE） */
function canAcceptSwipe() {
  return current === State.IDLE;
}

/**
 * 切换到指定状态。
 * @param {string} next 目标状态（须为 State 的合法值）
 * @returns {boolean} 是否成功切换
 */
function to(next) {
  if (!Object.prototype.hasOwnProperty.call(State, next)) {
    console.error(`[stateMachine] 非法状态: ${next}`);
    return false;
  }
  if (current === next) {
    return true; // 幂等：同状态切换视为成功，不重复通知
  }
  const from = current;
  current = next;

  // 通知订阅者（逐个 try-catch，隔离单个监听器异常）
  transitionListeners.forEach((cb) => {
    try {
      cb(from, next);
    } catch (err) {
      console.error('[stateMachine] listener error', err);
    }
  });
  return true;
}

/**
 * 订阅状态变更。
 * @param {(from: string, to: string) => void} cb
 * @returns {() => void} 取消订阅函数
 */
function onTransition(cb) {
  if (typeof cb === 'function') {
    transitionListeners.push(cb);
  }
  return () => {
    const idx = transitionListeners.indexOf(cb);
    if (idx >= 0) transitionListeners.splice(idx, 1);
  };
}

module.exports = {
  State,
  getState,
  canAcceptSwipe,
  to,
  onTransition,
};