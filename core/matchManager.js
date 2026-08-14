/**
 * =====================================================================
 *  客户端房间管理（core/matchManager.js）· 房间邀请模式
 * =====================================================================
 *  职责（Phase 4 决议：移除随机匹配，全面采用房间邀请）：
 *    1. createRoom()   : 房主建房 → 触发 wx.shareAppMessage 分享（携带 roomId）；
 *    2. joinRoom(id)   : 访客从分享卡片进入（query.roomId）→ JOIN_ROOM 入房；
 *    3. startGame()    : 房主点击「开始比赛」→ START_GAME 开局；
 *    4. 保留云调用错误捕获（[Cloud Error] 日志 + 中文排查建议）。
 *
 *  解耦：入房成功后游戏渲染交给 bootstrap.joinGame / leaveRoom。
 * =====================================================================
 */
const bootstrap = require('./bootstrap');

// ---- Storage 键（本地自管）----
const STORAGE_KEYS = Object.freeze({
  ROOM_ID: 'roomId',
  ROLE: 'role',
});

// ---- 常量 ----
const CLOUD_MATCH_FN = 'matchPlayer';

// 微信云开发常见错误码 → 中文排查建议（SOP 2.2 可观测性）
const CLOUD_ERROR_HINTS = Object.freeze({
  '-404011': '云函数可能未上传！请在开发者工具右键对应文件夹执行“上传并部署”。',
  '-502005': '数据库集合缺失！请前往云开发控制台手动创建对应的 Collection。',
  '-501000': '环境 ID (env) 配置错误或未启用云开发。',
});

/**
 * 提取微信云开发错误码（兼容 errCode 为数字/字符串/嵌套对象）。
 * @returns {string} 规范化错误码字符串（如 '-404011'），无法识别返回 ''
 */
function extractCloudErrorCode(err) {
  if (!err) return '';
  const code = err.errCode;
  if (typeof code === 'number' || typeof code === 'string') return String(code);
  if (code && typeof code === 'object' && code.errCode != null) return String(code.errCode);
  return '';
}

/**
 * 解析云调用异常 → { code, hint }。命中已知码给中文告警，否则回退错误首行（截断脱敏）。
 */
function parseCloudError(err) {
  const code = extractCloudErrorCode(err);
  if (code && CLOUD_ERROR_HINTS[code]) {
    return { code, hint: CLOUD_ERROR_HINTS[code] };
  }
  const rawMsg = (err && (err.errMsg || err.message)) || String(err);
  const firstLine = String(rawMsg).split('\n')[0].slice(0, 200);
  return { code: code || '-1', hint: firstLine || '未知云端错误' };
}

/**
 * 通用云函数调用（失败兜底为结构化响应，增强错误日志与中文告警）。
 * 返回 { code, msg, detail?, hint? }——code 非 0 时由调用方重置 UI。
 */
function callCloud(name, data) {
  return wx.cloud
    .callFunction({ name, data })
    .then((res) => (res && res.result) || null)
    .catch((err) => {
      const parsed = parseCloudError(err);
      console.error(`[Cloud Error] ${name} 请求失败，详细错误:`, err);
      if (parsed.hint) console.warn(`[排查建议] ${parsed.hint}`);
      return {
        code: -1,
        msg: 'network_error',
        detail: (err && (err.errMsg || err.message)) || String(err),
        hint: parsed.hint,
      };
    });
}

/** 房间 ID 落盘 */
function saveRoomId(roomId) {
  wx.setStorageSync(STORAGE_KEYS.ROOM_ID, roomId);
}

/**
 * 房主建房（点击「创建房间」）。
 * 成功后保存 roomId 并触发分享；返回 Promise<{ok, roomId?}>。
 */
function createRoom() {
  bootstrap.setMatching(true);
  bootstrap.setHint('创建房间中…');

  return callCloud(CLOUD_MATCH_FN, { action: 'CREATE_ROOM' }).then((resp) => {
    if (resp && resp.code === 0 && resp.data && resp.data.roomId) {
      const { roomId, state } = resp.data;
      saveRoomId(roomId);
      wx.setStorageSync(STORAGE_KEYS.ROLE, 'HOST');
      bootstrap.setMatching(false);
      // 入房等待态（不开启对局），由 START_GAME 后进入对局
      bootstrap.joinGame({ roomId, role: 'HOST' });
      // 触发微信分享卡片（携带 roomId）
      shareRoom(roomId);
      return { ok: true, roomId, state };
    }
    bootstrap.setMatching(false);
    const hint = resp && resp.hint ? resp.hint : '';
    bootstrap.setHint(hint || '创建房间失败');
    return { ok: false };
  });
}

/**
 * 被邀请者入房（从分享卡片 query.roomId 进入）。
 * @param {string} roomId 目标房间 ID
 * @returns {Promise<{ok, roomId?, state?}>}
 */
function joinRoom(roomId) {
  if (!roomId) {
    bootstrap.setHint('邀请参数无效');
    return Promise.resolve({ ok: false });
  }
  bootstrap.setMatching(true);
  bootstrap.setHint('加入房间中…');

  return callCloud(CLOUD_MATCH_FN, { action: 'JOIN_ROOM', roomId }).then((resp) => {
    if (resp && resp.code === 0 && resp.data && resp.data.roomId) {
      const { state } = resp.data;
      saveRoomId(roomId);
      wx.setStorageSync(STORAGE_KEYS.ROLE, 'GUEST');
      bootstrap.setMatching(false);
      // 入房就绪态（等待房主开局）
      bootstrap.joinGame({ roomId, role: 'GUEST' });
      return { ok: true, roomId, state };
    }
    bootstrap.setMatching(false);
    const hint = resp && resp.hint ? resp.hint : '';
    bootstrap.setHint(hint || '加入房间失败');
    return { ok: false };
  });
}

/**
 * 房主开局（点击「开始比赛」，双方就绪后触发）。
 * @returns {Promise<{ok}>}
 */
function startGame() {
  const roomId = wx.getStorageSync(STORAGE_KEYS.ROOM_ID);
  if (!roomId) {
    bootstrap.setHint('当前无房间');
    return Promise.resolve({ ok: false });
  }

  return callCloud(CLOUD_MATCH_FN, { action: 'START_GAME', roomId }).then((resp) => {
    if (resp && resp.code === 0) {
      bootstrap.setHint('比赛开始！');
      return { ok: true };
    }
    const hint = resp && resp.hint ? resp.hint : resp && resp.msg ? resp.msg : '';
    bootstrap.setHint(hint || '开局失败，请重试');
    return { ok: false };
  });
}

/**
 * 结算后「再来一局」：房主重新建房开新局；访客提示等待房主建房。
 * 房间 FINISHED 后 createRoom 幂等检测只认活跃房（WAITING/READY/PLAYING），
 * 故 FINISHED 会自然创建新房间，无需显式 leaveRoom。
 */
function rematch() {
  const role = wx.getStorageSync(STORAGE_KEYS.ROLE);
  if (role !== 'HOST') {
    bootstrap.setHint('等待房主再来一局…');
    return;
  }
  createRoom();
}

/**
 * 触发微信分享卡片（携带 roomId）。
 * @param {string} roomId
 */
function shareRoom(roomId) {
  wx.shareAppMessage({
    title: '来和我踢一场点球大战！',
    query: `roomId=${roomId}`, // 关键：通过 query 传递房间 ID
  });
}

/**
 * 启动入口：优先处理分享卡片带来的 roomId（冷启动 / 热启动），否则进入大厅。
 * 同时注册大厅「创建房间」/ 结算「再来一局 / 返回主页」回调。
 * @param {string} [queryRoomId] 外部传入的邀请房间 ID（由 game.js 从 launch/onShow 解析）
 */
function start(queryRoomId) {
  bootstrap.setUiHandlers({
    onStart: () => createRoom(),
    onStartMatch: () => startGame(),
    onRematch: () => rematch(),
    onHome: () => {
      leaveRoom();
      bootstrap.showLobby();
    },
  });

  if (queryRoomId) {
    joinRoom(queryRoomId);
    return;
  }
  bootstrap.showLobby();
}

/** 取消/离房（房主离开解散 / 访客离开腾位） */
function leaveRoom(roomId) {
  const id = roomId || wx.getStorageSync(STORAGE_KEYS.ROOM_ID);
  if (id) {
    callCloud(CLOUD_MATCH_FN, { action: 'LEAVE_ROOM', roomId: id });
  }
  wx.removeStorageSync(STORAGE_KEYS.ROOM_ID);
  wx.removeStorageSync(STORAGE_KEYS.ROLE);
  bootstrap.leaveRoom();
}

module.exports = {
  start,
  createRoom,
  joinRoom,
  startGame,
  rematch,
  leaveRoom,
  shareRoom,
};