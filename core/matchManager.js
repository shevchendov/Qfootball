/**
 * =====================================================================
 *  客户端匹配管理（core/matchManager.js）
 * =====================================================================
 *  职责：
 *    1. start()：启动流程——有 Storage roomId 则尝试断线重连
 *       （PLAYING → 恢复对局；FINISHED/不存在 → 清 Storage 回大厅）；
 *       否则直接进入大厅等待「开始比赛」。
 *    2. 注册大厅/结算 UI 回调（开始比赛 / 再来一局 / 返回主页）。
 *    3. role='A'：等待方轮询 GET_STATUS；role='B'：直接入房。
 *
 *  解耦约定：
 *    - 本模块不持有游戏渲染/状态机，只负责「入房前」的匹配编排与重连；
 *    - 入房成功后所有游戏逻辑交给 bootstrap（joinGame / leaveRoom）。
 * =====================================================================
 */
const bootstrap = require('./bootstrap');

// ---- Storage 键（本地自管，bootstrap 不再读取 Storage 入房）----
const STORAGE_KEYS = Object.freeze({
  ROOM_ID: 'roomId',
  PLAYER_ID: 'playerId',
  ROLE: 'role',
});

// ---- 常量 ----
const POLL_INTERVAL = 1000;      // GET_STATUS 轮询间隔 ms
const MATCH_TIMEOUT = 30000;     // 匹配超时 ms
const CLOUD_MATCH_FN = 'matchPlayer';
const CLOUD_ROUND_FN = 'resolveRound';

// 运行中状态
let pollTimer = null;            // 等待方轮询句柄
let uiBound = false;             // UI 回调只注册一次

/**
 * 通用云函数调用（失败兜底为结构化响应）。
 */
function callCloud(name, data) {
  return wx.cloud
    .callFunction({ name, data })
    .then((res) => (res && res.result) || null)
    .catch((err) => {
      console.error(`[matchManager] callFunction(${name}) error`, err);
      return {
        code: -1,
        msg: 'network_error',
        detail: (err && (err.errMsg || err.message)) || String(err),
      };
    });
}

/** 清理本地入房上下文 */
function clearRoomStorage() {
  wx.removeStorageSync(STORAGE_KEYS.ROOM_ID);
  wx.removeStorageSync(STORAGE_KEYS.ROLE);
}

/** 停止轮询（幂等） */
function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** 注册大厅/结算 UI 回调（只注册一次） */
function bindUiHandlers() {
  if (uiBound) return;
  uiBound = true;
  bootstrap.setUiHandlers({
    onStart: () => {
      bootstrap.setMatching(true);
      doRandomMatch();
    },
    onRematch: () => {
      bootstrap.leaveRoom();
      clearRoomStorage();
      doRandomMatch();
    },
    onHome: () => {
      bootstrap.leaveRoom();
      clearRoomStorage();
      bootstrap.showLobby();
    },
  });
}

/**
 * 启动入口：断线重连分派 → 否则进大厅。
 * @param {string} [mode] 'random'（本期仅支持随机匹配）
 */
function start(mode) {
  if (mode && mode !== 'random') {
    bootstrap.setHint('本期仅支持随机匹配');
    return;
  }
  bindUiHandlers();

  // ---- 0. 尝试断线重连 ----
  const existingRoomId = wx.getStorageSync(STORAGE_KEYS.ROOM_ID);
  if (existingRoomId) {
    tryReconnect(existingRoomId);
    return;
  }
  // 无历史房间 → 大厅
  bootstrap.showLobby();
}

/**
 * 断线重连：查房间状态分派。
 * role 优先取本地 Storage 记录，其次用服务端鉴权后返回的 mySide。
 * @param {string} roomId
 */
async function tryReconnect(roomId) {
  const playerId = wx.getStorageSync(STORAGE_KEYS.PLAYER_ID);
  const resp = await callCloud(CLOUD_ROUND_FN, { action: 'GET_ROOM', roomId });

  if (resp && resp.code === 0 && resp.data && resp.data.room) {
    const room = resp.data.room;
    const role = wx.getStorageSync(STORAGE_KEYS.ROLE) || resp.data.mySide || 'A';
    if (room.state === 'PLAYING' && playerId) {
      bootstrap.joinGame({ roomId, playerId, role });
      return;
    }
    // state === 'FINISHED' → 清 Storage 回大厅
  }
  // 房间不存在 / 无权限 / 其它异常 → 清 Storage 回大厅
  clearRoomStorage();
  bootstrap.showLobby();
}

/**
 * 随机匹配主流程（由「开始比赛 / 再来一局」触发）。
 */
async function doRandomMatch() {
  stopPoll();
  bootstrap.setMatching(true);
  bootstrap.setHint('匹配中，寻找对手…');

  const resp = await callCloud(CLOUD_MATCH_FN, { action: 'MATCH_RANDOM' });
  if (!resp || resp.code !== 0) {
    bootstrap.setMatching(false);
    bootstrap.setHint('匹配失败，请重试');
    return;
  }

  const data = resp.data || {};
  if (!data.playerId) {
    bootstrap.setMatching(false);
    bootstrap.setHint('匹配异常，请重试');
    return;
  }

  if (data.role === 'A') {
    // 等待方（A）：落盘身份 + 轮询 GET_STATUS
    wx.setStorageSync(STORAGE_KEYS.PLAYER_ID, data.playerId);
    wx.setStorageSync(STORAGE_KEYS.ROLE, 'A');
    pollWaiting(data.playerId);
  } else if (data.role === 'B') {
    // 已配对（B）：直接入房
    enterRoom({ roomId: data.roomId, playerId: data.playerId, role: 'B' });
  } else {
    bootstrap.setMatching(false);
    bootstrap.setHint('匹配异常，请重试');
  }
}

/**
 * 等待方轮询 GET_STATUS。
 * @param {string} playerId 我的 openid
 */
function pollWaiting(playerId) {
  stopPoll();
  const startTs = Date.now();

  pollTimer = setInterval(async () => {
    // 超时处理：取消匹配 + 提示
    if (Date.now() - startTs > MATCH_TIMEOUT) {
      stopPoll();
      callCloud(CLOUD_MATCH_FN, { action: 'CANCEL' });
      clearRoomStorage();
      bootstrap.setMatching(false);
      bootstrap.setHint('匹配超时，请重试');
      return;
    }

    const resp = await callCloud(CLOUD_MATCH_FN, { action: 'GET_STATUS' });
    if (resp && resp.code === 0 && resp.data && resp.data.matched && resp.data.roomId) {
      stopPoll();
      enterRoom({ roomId: resp.data.roomId, playerId, role: 'A' });
    }
  }, POLL_INTERVAL);
}

/**
 * 入房成功：落盘 + 交给 bootstrap 初始化对局。
 * @param {{roomId:string, playerId:string, role:string}} data
 */
function enterRoom(data) {
  if (!data || !data.roomId || !data.playerId) {
    bootstrap.setMatching(false);
    bootstrap.setHint('入房失败，请重试');
    return;
  }
  wx.setStorageSync(STORAGE_KEYS.ROOM_ID, data.roomId);
  wx.setStorageSync(STORAGE_KEYS.PLAYER_ID, data.playerId);
  wx.setStorageSync(STORAGE_KEYS.ROLE, data.role);
  bootstrap.joinGame({ roomId: data.roomId, playerId: data.playerId, role: data.role });
}

/** 取消匹配（客户端主动） */
function cancel() {
  stopPoll();
  callCloud(CLOUD_MATCH_FN, { action: 'CANCEL' });
  clearRoomStorage();
  bootstrap.setHint('');
}

module.exports = {
  start,
  cancel,
};