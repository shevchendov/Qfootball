/**
 * =====================================================================
 *  手势采集模块（core/input.js）
 * =====================================================================
 *  职责：
 *    1. 监听 wx.onTouchStart / wx.onTouchEnd，采集起点/终点坐标与时间戳。
 *    2. 将屏幕逻辑像素坐标按 (750 / windowWidth) 等比放大到 750 设计空间。
 *    3. 输出与后端 resolveRound 入参一致的 SwipeData：{ dx, dy, duration }。
 *
 *  约定（Gemini 决议 D1）：
 *    - 微信 touch 的 clientX/clientY 为逻辑像素；
 *    - 上报前统一放大到 750 设计空间，后端 MAX_DIST=800 / MAX_VELO=10 同口径。
 *    - duration 单位必须为毫秒，与后端 MIN_DURATION/MAX_DURATION(3000) 对齐。
 * =====================================================================
 */
const config = require('../config/config');

const DESIGN_W = config.DESIGN_W;
const MIN_DIST = config.MIN_DIST;

// 屏幕逻辑宽度 → 设计空间换算系数（init 时按实际 windowWidth 计算）
let scaleFactor = DESIGN_W / 375; // 默认 2.0，供极端环境下兜底

// 滑屏完成回调
let swipeHandler = null;

// 点按（Tap）回调：{ x, y } 设计坐标
let tapHandler = null;

// 触摸起点：{ x, y, t }（t 为毫秒时间戳）
let touchStart = null;

/**
 * 初始化：读取系统信息、换算系数、注册全局触摸事件。
 */
function init() {
  const sys = wx.getSystemInfoSync() || {};
  const windowWidth = sys.windowWidth || 375;
  scaleFactor = DESIGN_W / windowWidth;
  config.setScreen({
    width: sys.windowWidth,
    height: sys.windowHeight,
    dpr: sys.pixelRatio,
  });

  wx.onTouchStart(onTouchStart);
  wx.onTouchEnd(onTouchEnd);
  wx.onTouchCancel(onTouchCancel);

  console.log(`[input] 已注册触摸事件，scaleFactor=${scaleFactor}`);
}

/**
 * 注册滑屏完成回调。
 * @param {(swipe: { dx: number, dy: number, duration: number }) => void} fn
 */
function setSwipeHandler(fn) {
  swipeHandler = typeof fn === 'function' ? fn : null;
}

/**
 * 注册点按（Tap）回调。
 * 位移小于 MIN_DIST 的 touch 视为点按，回调接收设计坐标 { x, y }。
 * @param {({x:number, y:number}) => void} fn
 */
function setTapHandler(fn) {
  tapHandler = typeof fn === 'function' ? fn : null;
}

/**
 * 屏幕坐标 → 750 设计空间坐标。
 * @param {number} clientX 屏幕逻辑像素 x
 * @param {number} clientY 屏幕逻辑像素 y
 */
function toDesignCoords(clientX, clientY) {
  return {
    x: (clientX || 0) * scaleFactor,
    y: (clientY || 0) * scaleFactor,
  };
}

/**
 * 由起点/终点坐标与耗时构造 SwipeData（纯函数，便于测试）。
 * @param {{x:number,y:number}} s 起点（设计空间）
 * @param {{x:number,y:number}} e 终点（设计空间）
 * @param {number} dt 耗时 ms
 */
function computeSwipe(s, e, dt) {
  return {
    dx: e.x - s.x,
    dy: e.y - s.y,
    duration: dt,
  };
}

/**
 * 本地方向预览（口径与后端 toLane 一致，阈值 0.3）。
 * 注意：权威方向以后端结算结果 result.shooterLane / keeperLane 为准。
 * @param {number} dx 设计空间水平位移
 * @param {number} dy 设计空间竖直位移
 */
function toLaneLocal(dx, dy) {
  const mag = Math.hypot(dx, dy);
  if (!isFinite(mag) || mag < MIN_DIST) return config.ShotLane.CENTER;
  const h = dx / mag; // 归一化水平偏置 -1..1
  if (h < -config.LANE_THRESHOLD) return config.ShotLane.LEFT;
  if (h > config.LANE_THRESHOLD) return config.ShotLane.RIGHT;
  return config.ShotLane.CENTER;
}

/**
 * touchstart：记录起点（设计空间坐标 + 时间戳）。
 */
function onTouchStart(e) {
  const t = e.touches && e.touches[0];
  if (!t) return;
  const p = toDesignCoords(t.clientX, t.clientY);
  touchStart = { x: p.x, y: p.y, t: e.timeStamp || Date.now() };
}

/**
 * touchend：计算位移与耗时，过滤误触后回调。
 */
function onTouchEnd(e) {
  const t = e.changedTouches && e.changedTouches[0];
  if (!t || !touchStart) {
    touchStart = null;
    return;
  }

  const end = toDesignCoords(t.clientX, t.clientY);
  const endT = e.timeStamp || Date.now();
  const duration = endT - touchStart.t;
  const swipe = computeSwipe(touchStart, end, duration);
  touchStart = null;

  // 误触过滤：位移过短视为点按（Tap），否则视为滑屏
  const distance = Math.hypot(swipe.dx, swipe.dy);
  if (distance < MIN_DIST) {
    // 点按：以设计坐标回调（取触摸终点）
    if (tapHandler) {
      try {
        tapHandler({ x: end.x, y: end.y });
      } catch (err) {
        console.error('[input] tap handler error', err);
      }
    }
    return;
  }

  if (swipeHandler) {
    try {
      swipeHandler(swipe);
    } catch (err) {
      console.error('[input] swipe handler error', err);
    }
  }
}

/**
 * touchcancel：取消手势，清空起点。
 */
function onTouchCancel() {
  touchStart = null;
}

module.exports = {
  init,
  setSwipeHandler,
  setTapHandler,
  toDesignCoords,
  computeSwipe,
  toLaneLocal,
};