/**
 * =====================================================================
 *  小游戏入口（game.js）
 * =====================================================================
 *  启动顺序（SOP 2.1，严格按序，杜绝 JSBridge 未就绪即触发底层 API）：
 *    1. 按需引入模块：require 仅加载定义，不在全局作用域调用任何 wx.* API；
 *    2. 初始化云开发（wx.cloud.init 为云开发前置，须最先执行）；
 *    3. render.initSystem()：在此收敛 wx.getSystemInfoSync()（含兜底），
 *       计算 scaleX/scaleY，确保坐标映射不为 NaN；
 *    4. bootstrap.init()：创建画布（render.initRender）、注册输入（注入缩放）、
 *       启动主循环；
 *    5. matchManager.start(queryRoomId)：解析分享卡片 roomId 分派入房，
 *       否则进入大厅。
 *
 *  保证：所有 wx.* API 调用均发生在函数内且晚于入口执行，jsbridge 已就绪。
 * =====================================================================
 */

// ---- 1. 初始化微信云开发（必须先于云函数/watch）----
wx.cloud.init({
  env: 'cloud1-d7g9uo3la0e6ce2c4', // 云开发环境 ID
  traceUser: true,
});

// ---- 2. 按需引入（仅定义，不触发 wx.*）----
const render = require('./core/render');
const bootstrap = require('./core/bootstrap');
const matchManager = require('./core/matchManager');

// ---- 3. 渲染初始化：系统信息 + 缩放（唯一执行 getSystemInfoSync 的地方）----
render.initSystem();

// ---- 4. 调度初始化：画布 / 输入（注入缩放）/ 主循环 ----
bootstrap.init();

// ---- 5. 解析分享卡片携带的房间 ID（冷启动）----
function getLaunchRoomId() {
  try {
    const opts = wx.getLaunchOptionsSync();
    return (opts && opts.query && opts.query.roomId) || '';
  } catch (err) {
    console.warn('[game] getLaunchOptionsSync failed', err);
    return '';
  }
}

// ---- 6. 热启动（分享卡片再次进入）实时监听 query 更新 ----
try {
  wx.onShow((res) => {
    const roomId = (res && res.query && res.query.roomId) || '';
    if (roomId) matchManager.joinRoom(roomId);
  });
} catch (err) {
  console.warn('[game] wx.onShow 注册失败', err);
}

// ---- 7. 分派：有邀请房间 → 入房；否则进入大厅 ----
matchManager.start(getLaunchRoomId());