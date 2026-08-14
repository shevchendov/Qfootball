/**
 * =====================================================================
 *  手势采集模块（core/input.js）
 * =====================================================================
 *  职责：
 *    1. 监听 wx.onTouchStart / wx.onTouchEnd，采集起点/终点坐标与时间戳。
 *    2. 接收由 render.initSystem() 计算好的 scaleX/scaleY，
 *       将屏幕物理坐标（逻辑像素）精确转换为 750 设计空间坐标。
 *    3. 输出与后端 resolveRound 入参一致的 SwipeData：{ dx, dy, duration }。
 *
 *  时序安全（SOP 2.1）：
 *    - 本模块全局作用域不调用任何 wx.* API；
 *    - wx.onTouch* 仅在 init() 内注册，且 init() 由 bootstrap 在
 *      render.initSystem() 之后调用，保证 JSBridge 已就绪；
 *    - 屏幕参数与缩放由 render 统一计算后注入，避免在此重复
 *      wx.getSystemInfoSync() 而引发 jsbridge not ready。
 *
 *  约定（Gemini 决议 D1）：
 *    - 微信 touch 的 clientX/clientY 为逻辑像素；
 *    - 上报前统一放大到 750 设计空间，后端 MAX_DIST=800 / MAX_VELO=10 同口径。
 *    - duration 单位必须为毫秒，与后端 MIN_DURATION/MAX_DURATION(3000) 对齐。
 *
 *  Tap 判定（SOP 2.1）：
 *    - 用 Math.hypot 计算 touchstart 与 touchend 之间的物理位移（逻辑像素），
 *      距离 < 10 视为有效点按，防止滑动误触；
 *    - setTapHandler 内植入一行 console.log 打印物理坐标与设计坐标，便于排查。
 * =====================================================================
 */
const config = require('../config/config');

const DESIGN_W = config.DESIGN_W;
const DESIGN_H = config.DESIGN_H;
const MIN_DIST = config.MIN_DIST;

// 有效 Tap 最大物理位移（逻辑像素，与 MIN_DIST=10 口径一致）
const TAP_MAX_DIST = 10;

// 屏幕参数与缩放（init 时由 render.initSystem() 结果注入）
let windowWidth = 375;          // 兜底逻辑宽度
let windowHeight = 667;         // 兜底逻辑高度
let dpr = 2;                    // 兜底像素比
let scaleX = 1;                 // 设计空间 → 画布 横向缩放（render 计算）
let scaleY = 1;                 // 设计空间 → 画布 纵向缩放（render 计算）

// 物理坐标（逻辑像素）→ 设计空间 的换算系数
let scaleToDesignX = DESIGN_W / 375; // 兜底 2.0
let scaleToDesignY = DESIGN_H / 667;

// 滑屏完成回调
let swipeHandler = null;

// 点按（Tap）回调：{ x, y } 设计坐标
let tapHandler = null;

// 触摸起点：{ x, y, rawX, rawY, t }（raw 为物理逻辑像素，t 为毫秒时间戳）
let touchStart = null;

/**
 * 初始化：注入屏幕参数与缩放，注册全局触摸事件。
 * 注意：不在此处调用 wx.getSystemInfoSync()，参数由 render.initSystem() 提供。
 * @param {{windowWidth?:number, windowHeight?:number, dpr?:number,
 *          scaleX?:number, scaleY?:number}} [screen]
 */
function init(screen) {
  const s = screen || {};
  windowWidth = s.windowWidth || windowWidth;
  windowHeight = s.windowHeight || windowHeight;
  dpr = s.dpr || dpr;
  scaleX = s.scaleX || scaleX;
  scaleY = s.scaleY || scaleY;

  // 物理(逻辑)坐标 → 设计坐标：design = raw * dpr / scaleX（render 同源口径）
  scaleToDesignX = DESIGN_W / windowWidth;
  scaleToDesignY = DESIGN_H / windowHeight;

  config.setScreen({ width: windowWidth, height: windowHeight, dpr });

  wx.onTouchStart(onTouchStart);
  wx.onTouchEnd(onTouchEnd);
  wx.onTouchCancel(onTouchCancel);

  console.log(
    `[input] 已注册触摸事件 scaleX=${scaleX} scaleY=${scaleY} ` +
    `toDesignX=${scaleToDesignX} toDesignY=${scaleToDesignY}`,
  );
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
 * 回调接收设计坐标 { x, y }；内部植入排查日志，打印物理坐标与设计坐标。
 * @param {({x:number, y:number}) => void} fn
 */
function setTapHandler(fn) {
  const userHandler = typeof fn === 'function' ? fn : null;
  tapHandler = (rawX, rawY, designX, designY) => {
    // 排查日志：物理坐标 → 设计坐标
    console.log(`[Tap] 物理坐标: ${rawX}, ${rawY} | 设计坐标: ${designX}, ${designY}`);
    if (userHandler) {
      try {
        userHandler({ x: designX, y: designY });
      } catch (err) {
        console.error('[input] tap handler error', err);
      }
    }
  };
}

/**
 * 屏幕物理坐标（逻辑像素） → 750 设计空间坐标。
 * @param {number} clientX 屏幕逻辑像素 x
 * @param {number} clientY 屏幕逻辑像素 y
 */
function toDesignCoords(clientX, clientY) {
  return {
    x: (clientX || 0) * scaleToDesignX,
    y: (clientY || 0) * scaleToDesignY,
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
 * touchstart：记录起点（物理坐标 + 设计坐标 + 时间戳）。
 */
function onTouchStart(e) {
  const t = e.touches && e.touches[0];
  if (!t) return;
  const p = toDesignCoords(t.clientX, t.clientY);
  touchStart = {
    x: p.x,
    y: p.y,
    rawX: t.clientX,
    rawY: t.clientY,
    t: e.timeStamp || Date.now(),
  };
}

/**
 * touchend：计算物理位移与耗时，过滤误触（Tap）后回调。
 */
function onTouchEnd(e) {
  const t = e.changedTouches && e.changedTouches[0];
  if (!t || !touchStart) {
    touchStart = null;
    return;
  }

  // 物理位移（逻辑像素）：Math.hypot 计算 touchstart 与 touchend 距离
  const start = touchStart;
  const rawDX = t.clientX - start.rawX;
  const rawDY = t.clientY - start.rawY;
  const rawDistance = Math.hypot(rawDX, rawDY);

  const end = toDesignCoords(t.clientX, t.clientY);
  const endT = e.timeStamp || Date.now();
  const duration = endT - start.t;
  touchStart = null;

  // 位移 < 10（物理逻辑像素）→ 视为有效点按，防止滑动误触
  if (rawDistance < TAP_MAX_DIST) {
    if (tapHandler) {
      tapHandler(t.clientX, t.clientY, end.x, end.y);
    }
    return;
  }

  const swipe = computeSwipe({ x: start.x, y: start.y }, end, duration);

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