/**
 * =====================================================================
 *  客户端匹配管理（core/matchManager.js）
 * =====================================================================
 *  职责：
 *    1. start()：调用 matchPlayer(MATCH_RANDOM) 发起随机匹配。
 *    2. role='A'：等待方 → setInterval 轮询 GET_STATUS，
 *       配对成功后将 roomId/role 落盘并调用 bootstrap.joinGame。
 *    3. role='B'：已配对 → 直接落盘并调用 bootstrap.joinGame。
 *    4. 落盘键：roomId / playerId / role（与 bootstrap 入房参数对应）。
 *
 *  解耦约定：
 *    - 本模块不持有游戏渲染/状态机，只负责「入房前」的匹配编排；
 *    - 入房成功后所有游戏逻辑交给 bootstrap（joinGame）。
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

/**
 * 匹配入口。
 * @param {string} [mode] 'random'（本期仅支持随机匹配）
 */
function start(mode) {
  if (mode && mode !== 'random') {
    bootstrap.setHint('本期仅支持随机匹配');
    return;
  }
  doRandomMatch();
}

/**
 * 随机匹配主流程。
 */
async function doRandomMatch() {
  // ---- 0. 已有房间上下文 → 尝试重连（仍在 PLAYING 则直接入房）----
  const existingRoomId = wx.getStorageSync(STORAGE_KEYS.ROOM_ID);
  if (existingRoomId) {
    const playerId = wx.getStorageSync(STORAGE_KEYS.PLAYER_ID);
    const resp = await callCloud(CLOUD_ROUND_FN, { action: 'GET_ROOM', roomId: existingRoomId });
    if (resp && resp.code === 0 && resp.data && resp.data.room) {
      const room = resp.data.room;
      if (room.state === 'PLAYING' && playerId) {
        const role = wx.getStorageSync(STORAGE_KEYS.ROLE) || (room.playerA_Id === playerId ? 'A' : 'B');
        bootstrap.joinGame({ roomId: existingRoomId, playerId, role });
        return;
      }
    }
    // 房间失效 → 清理旧上下文
    clearRoomStorage();
  }

  // ---- 1. 发起匹配 ----
  bootstrap.setHint('匹配中，寻找对手…');

  const resp = await callCloud(CLOUD_MATCH_FN, { action: 'MATCH_RANDOM' });
  if (!resp || resp.code !== 0) {
    bootstrap.setHint('匹配失败，请重试');
    return;
  }

  const data = resp.data || {};
  if (!data.playerId) {
    bootstrap.setHint('匹配异常，请重试');
    return;
  }

  if (data.role === 'A') {
    // ---- 2a. 等待方（A）：落盘身份 + 轮询 GET_STATUS ----
    wx.setStorageSync(STORAGE_KEYS.PLAYER_ID, data.playerId);
    wx.setStorageSync(STORAGE_KEYS.ROLE, 'A');
    pollWaiting(data.playerId);
  } else if (data.role === 'B') {
    // ---- 2b. 已配对（B）：直接入房 ----
    enterRoom({
      roomId: data.roomId,
      playerId: data.playerId,
      role: 'B',
    });
  } else {
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
      bootstrap.setHint('匹配超时，请重试');
      return;
    }

    const resp = await callCloud(CLOUD_MATCH_FN, { action: 'GET_STATUS' });
    if (resp && resp.code === 0 && resp.data && resp.data.matched && resp.data.roomId) {
      stopPoll();
      enterRoom({
        roomId: resp.data.roomId,
        playerId,
        role: 'A',
      });
    }
  }, POLL_INTERVAL);
}

/**
 * 入房成功：落盘 + 交给 bootstrap 初始化对局。
 * @param {{roomId:string, playerId:string, role:string}} data
 */
function enterRoom(data) {
  if (!data || !data.roomId || !data.playerId) {
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