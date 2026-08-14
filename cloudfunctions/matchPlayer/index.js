/**
 * =====================================================================
 *  匹配/建房云函数（matchPlayer）· 房间邀请模式
 * =====================================================================
 *  运行环境 : Node.js 16.x + wx-server-sdk（微信云开发）
 *  职责     : 房主建房 → 分享 → 访客入房 → 房主开局 的完整生命周期。
 *
 *  action 支持（Phase 4 决议）：
 *    CREATE_ROOM : 创建 rooms 文档，state='WAITING'，hostId=OPENID，返回 roomId。
 *    JOIN_ROOM   : 访客原子占位入房（乐观锁条件更新），成功置 state='READY'；
 *                  失败返回友好报错；处理「房主重进自己房间」「退出旧房间加入新房间」。
 *    START_GAME  : 鉴权必须是房主且 state='READY'，重置对局字段并置 state='PLAYING'。
 *    LEAVE_ROOM  : 房主离开 → 'DISBANDED'；访客离开 → 'WAITING' 且腾出空位。
 *
 *  并发防抢房（DevSecOps 卡点）：
 *    访客入房使用「条件更新」—— 仅当 guestId 字段不存在时才能占位：
 *      where({ _id: roomId, guestId: _.exists(false) })
 *      .update({ data: { guestId: openid, state: 'READY' } })
 *    该操作在数据库服务端原子执行，B、C 同时点击同一张分享卡片时，
 *    系统保证只有一条 update 影响行数为 1，另一条 updated=0 收到「房间已满」。
 *
 *  身份安全：所有 action 的 openid 一律取自 wx.getWXContext().OPENID，
 *    不信任客户端传入的身份字段（沿用上一阶段安全加固）。
 *
 *  可测性：核心处理器以 db 为参数注入（main 内取真实 db，单测传桩），
 *    纯逻辑 buildRoomDoc 导出便于单测。
 * =====================================================================
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// ---- 错误码 ----
const ErrCode = Object.freeze({
  OK: 0,
  INVALID_PARAMS: 1001,
  ROOM_NOT_FOUND: 1006,
  PLAYER_NOT_IN_ROOM: 1002,
  ROOM_FULL: 2002,     // 房间已满（访客占位失败）
  ROOM_CLOSED: 2003,   // 房间已开始 / 已结束 / 已解散
  NOT_HOST: 2004,      // 非房主无权开局
  ROOM_NOT_READY: 2005, // 房间未就绪（缺少访客）
  DB_ERROR: 5000,
  INTERNAL: 5001,
});

// ---- 常量 ----
const ROOMS_COLL = 'rooms';
const TOTAL_ROUNDS = 10; // 单场总踢球数（各 5 次）

// 房间生命周期状态
const ROOM_STATES = Object.freeze({
  WAITING: 'WAITING',       // 已创建，仅房主，等待好友
  READY: 'READY',           // 双方就绪，等待房主开局
  PLAYING: 'PLAYING',       // 对局进行中
  FINISHED: 'FINISHED',     // 分出胜负
  DISBANDED: 'DISBANDED',   // 房主离开 / 异常回收
});

// =====================================================================
//  工具
// =====================================================================
function ok(data) {
  return { code: ErrCode.OK, msg: 'ok', data };
}

function fail(code, msg, detail) {
  const body = { code, msg };
  if (detail !== undefined) body.detail = detail;
  return body;
}

/** 判断是否"文档不存在"错误 */
function isNotFoundError(err) {
  const msg = String((err && (err.errMsg || err.message)) || '');
  const code = err && err.errCode;
  return code === -502004 || /not exist|不存在|does not exist/i.test(msg);
}

/**
 * 构造房间文档初始数据（房间邀请模式）。
 * 注意：guestId 字段在访客入房前【不存在】——「字段不存在」即空位，
 * 与乐观锁条件 `guestId: _.exists(false)` 保持一致（null 会让 exists(false) 失效）。
 */
function buildRoomDoc(hostId, now) {
  return {
    roomType: 'INVITE',
    state: ROOM_STATES.WAITING,
    hostId,                     // 房主 openid（对局固定为 A）
    // guestId 缺席 = 空位，访客入房后写入（对局固定为 B）
    roundIndex: 0,
    roundShooter: 'A',          // 首轮房主（A）射门
    score: { A: 0, B: 0 },
    totalRounds: TOTAL_ROUNDS,
    actionA: null,
    actionB: null,
    suddenDeath: false,
    winner: null,
    lastResult: null,
    createTime: now,
    updateTime: now,
  };
}

// =====================================================================
//  业务：CREATE_ROOM
// =====================================================================
/**
 * 房主建房。
 * 幂等：若该房主已有活跃房间（WAITING/READY/PLAYING），直接返回既有房间，
 * 避免重复点击「创建房间」产生多个空房。
 * @param {*} db 数据库实例
 * @param {string} openid 房主 openid
 * @returns {{roomId:string, state:string, recreated:boolean}}
 */
async function createRoom(db, openid) {
  const _ = db.command;
  const now = Date.now();

  // 幂等：查房主现存活跃房间
  const active = await db
    .collection(ROOMS_COLL)
    .where({ hostId: openid, state: _.in([ROOM_STATES.WAITING, ROOM_STATES.READY, ROOM_STATES.PLAYING]) })
    .get();

  const existing = active.data && active.data[0];
  if (existing && existing._id) {
    return ok({ roomId: existing._id, state: existing.state, recreated: false });
  }

  // 新建房间（_id 由 add 自动生成，作为分享 query 使用）
  const addRes = await db.collection(ROOMS_COLL).add({ data: buildRoomDoc(openid, now) });
  return ok({ roomId: addRes._id, state: ROOM_STATES.WAITING, recreated: true });
}

// =====================================================================
//  业务：JOIN_ROOM（并发防抢房核心）
// =====================================================================
/**
 * 清理该用户在其它房间的占位（「退出旧房间加入新房间」边界）。
 *  - 若他是其它 WAITING/READY 房的房主 → 解散旧房；
 *  - 若他是其它 WAITING 房的访客 → 腾出空位（guestId 移除，回到可加入）。
 * 均为尽力而为（best-effort），不影响本房间占位结果。
 */
async function leaveOtherInvolvement(db, openid, roomId, _) {
  await db
    .collection(ROOMS_COLL)
    .where({ hostId: openid, state: _.in([ROOM_STATES.WAITING, ROOM_STATES.READY]), _id: _.neq(roomId) })
    .update({ data: { state: ROOM_STATES.DISBANDED, updateTime: Date.now() } });

  await db
    .collection(ROOMS_COLL)
    .where({ guestId: openid, state: ROOM_STATES.WAITING, _id: _.neq(roomId) })
    .update({ data: { guestId: _.remove(), updateTime: Date.now() } });
}

/**
 * 访客入房（原子占位）。
 * @param {*} db 数据库实例
 * @param {string} openid 访客 openid
 * @param {string} roomId 目标房间 ID
 * @returns {roomId, state, role}
 */
async function joinRoom(db, openid, roomId) {
  const _ = db.command;
  if (!roomId || !openid) return fail(ErrCode.INVALID_PARAMS, 'invalid_params');

  // ---- 1. 读取房间（非事务读，仅前置校验与友好提示）----
  let room;
  try {
    const snap = await db.collection(ROOMS_COLL).doc(roomId).get();
    room = snap.data;
  } catch (err) {
    if (isNotFoundError(err)) return fail(ErrCode.ROOM_NOT_FOUND, '房间不存在');
    console.error('[joinRoom] read room error', err);
    return fail(ErrCode.DB_ERROR, 'db_error');
  }

  // ---- 2. 房主重进自己房间 → 幂等返回 ----
  if (room.hostId === openid) {
    return ok({ roomId, state: room.state, role: 'HOST' });
  }
  // ---- 3. 自己已是该房访客 → 幂等返回 ----
  if (room.guestId === openid) {
    return ok({ roomId, state: room.state, role: 'GUEST' });
  }
  // ---- 4. 生命周期校验（优先级高于"已满"）：已开始/已结束/已解散不可入 ----
  if (room.state === ROOM_STATES.PLAYING || room.state === ROOM_STATES.FINISHED || room.state === ROOM_STATES.DISBANDED) {
    return fail(ErrCode.ROOM_CLOSED, '房间已开始或已结束');
  }
  // ---- 5. 房间已满：guest 位已被他人占用 ----
  if (room.guestId != null) {
    return fail(ErrCode.ROOM_FULL, '房间已满');
  }
  // ---- 6. 状态兜底：非 WAITING（如异常 READY 无 guest）不可入 ----
  if (room.state !== ROOM_STATES.WAITING) {
    return fail(ErrCode.ROOM_CLOSED, '房间不可加入');
  }

  // ---- 7. 退出旧房间加入新房间：清理该用户在其它房的占位 ----
  await leaveOtherInvolvement(db, openid, roomId, _);

  // ---- 8. 原子占位（乐观锁）：仅当 guestId 不存在时才能写入 ----
  const res = await db
    .collection(ROOMS_COLL)
    .where({ _id: roomId, guestId: _.exists(false) })
    .update({
      data: {
        guestId: openid,
        state: ROOM_STATES.READY,
        updateTime: Date.now(),
      },
    });

  const updated = res && res.stats ? res.stats.updated : 0;
  if (updated !== 1) {
    // 条件不满足 → 空位已被并发抢占，或房间已非 WAITING
    return fail(ErrCode.ROOM_FULL, '房间已满');
  }

  return ok({ roomId, state: ROOM_STATES.READY, role: 'GUEST' });
}

// =====================================================================
//  业务：START_GAME
// =====================================================================
/**
 * 房主开局。
 * 鉴权：必须为房主（hostId===openid）且房间 state==='READY'（访客已在）。
 * 重置对局字段（roundIndex=0, score={A:0,B:0}, roundShooter='A'）并置 PLAYING。
 */
async function startGame(db, openid, roomId) {
  if (!roomId || !openid) return fail(ErrCode.INVALID_PARAMS, 'invalid_params');

  let room;
  try {
    const snap = await db.collection(ROOMS_COLL).doc(roomId).get();
    room = snap.data;
  } catch (err) {
    if (isNotFoundError(err)) return fail(ErrCode.ROOM_NOT_FOUND, '房间不存在');
    console.error('[startGame] read room error', err);
    return fail(ErrCode.DB_ERROR, 'db_error');
  }

  // 鉴权：仅房主可开局
  if (room.hostId !== openid) {
    return fail(ErrCode.NOT_HOST, '仅房主可开始比赛');
  }
  // 状态：必须双方就绪
  if (room.state !== ROOM_STATES.READY) {
    return fail(ErrCode.ROOM_NOT_READY, '房间未就绪（需好友加入）');
  }

  // 重置对局数据并置 PLAYING（后续回合由 resolveRound 接管）
  await db.collection(ROOMS_COLL).doc(roomId).update({
    data: {
      state: ROOM_STATES.PLAYING,
      roundIndex: 0,
      roundShooter: 'A',
      score: { A: 0, B: 0 },
      actionA: null,
      actionB: null,
      suddenDeath: false,
      winner: null,
      lastResult: null,
      updateTime: Date.now(),
    },
  });

  return ok({ roomId, state: ROOM_STATES.PLAYING });
}

// =====================================================================
//  业务：LEAVE_ROOM
// =====================================================================
/**
 * 离开房间。
 *  - 房主离开 → 房间置 DISBANDED（访客 watch 到后提示「房主已离开」）；
 *  - 访客离开 → 房间回 WAITING 并腾出空位（guestId 移除，下一好友可加入）。
 */
async function leaveRoom(db, openid, roomId) {
  const _ = db.command;
  if (!roomId || !openid) return fail(ErrCode.INVALID_PARAMS, 'invalid_params');

  let room;
  try {
    const snap = await db.collection(ROOMS_COLL).doc(roomId).get();
    room = snap.data;
  } catch (err) {
    if (isNotFoundError(err)) return fail(ErrCode.ROOM_NOT_FOUND, '房间不存在');
    console.error('[leaveRoom] read room error', err);
    return fail(ErrCode.DB_ERROR, 'db_error');
  }

  // 房主离开 → 解散
  if (room.hostId === openid) {
    await db.collection(ROOMS_COLL).doc(roomId).update({
      data: { state: ROOM_STATES.DISBANDED, updateTime: Date.now() },
    });
    return ok({ roomId, state: ROOM_STATES.DISBANDED, action: 'DISBAND' });
  }

  // 访客离开 → 回 WAITING、腾出空位（remove 保证下一次 exists(false) 可占位）
  if (room.guestId === openid) {
    await db.collection(ROOMS_COLL).doc(roomId).update({
      data: { state: ROOM_STATES.WAITING, guestId: _.remove(), updateTime: Date.now() },
    });
    return ok({ roomId, state: ROOM_STATES.WAITING, action: 'LEAVE' });
  }

  return fail(ErrCode.PLAYER_NOT_IN_ROOM, '你不在该房间');
}

// =====================================================================
//  云函数入口
// =====================================================================
exports.main = async (event) => {
  // 兜底：极小概率 event 为字符串（异常调用）
  let evt = event;
  if (typeof evt === 'string') {
    try { evt = JSON.parse(evt); } catch (_e) { /* 保持原样，后续校验拦截 */ }
  }
  if (!evt || typeof evt !== 'object') {
    return fail(ErrCode.INVALID_PARAMS, 'invalid_event');
  }

  // 权威身份：取自微信调用上下文，绝不信任客户端传入的 openid
  let openid = '';
  try {
    const ctx = cloud.getWXContext();
    openid = ctx.OPENID || '';
  } catch (err) {
    console.warn('[matchPlayer] getWXContext failed', err);
  }
  if (!openid) {
    return fail(ErrCode.INVALID_PARAMS, 'no_openid');
  }

  const db = cloud.database();
  const { action, roomId } = evt;

  try {
    switch (action) {
      case 'CREATE_ROOM':
        return await createRoom(db, openid);
      case 'JOIN_ROOM':
        return await joinRoom(db, openid, roomId);
      case 'START_GAME':
        return await startGame(db, openid, roomId);
      case 'LEAVE_ROOM':
        return await leaveRoom(db, openid, roomId);
      default:
        return fail(ErrCode.INVALID_PARAMS, 'unknown_action', { action });
    }
  } catch (err) {
    // 兜底异常，避免未捕获异常导致云函数直接失败且无结构化返回
    console.error('[matchPlayer] error', err);
    return fail(ErrCode.INTERNAL, 'internal_error');
  }
};

// 导出核心逻辑（db 以参数注入），便于本地单测
exports.createRoom = createRoom;
exports.joinRoom = joinRoom;
exports.startGame = startGame;
exports.leaveRoom = leaveRoom;
exports.leaveOtherInvolvement = leaveOtherInvolvement;
exports.buildRoomDoc = buildRoomDoc;
exports.isNotFoundError = isNotFoundError;
exports.ErrCode = ErrCode;
exports.ROOM_STATES = ROOM_STATES;
