/**
 * =====================================================================
 *  匹配/建房云函数（matchPlayer）
 * =====================================================================
 *  运行环境 : Node.js 16.x + wx-server-sdk（微信云开发）
 *  职责     : 提供随机匹配与匹配状态查询。
 *
 *  action 支持：
 *    MATCH_RANDOM : 通过 matchPool 单文档配对池原子匹配。
 *                   占位成功 → role='A'（等待），配对成功 → role='B'（建房 PLAYING）。
 *    GET_STATUS   : 供等待方（role='A'）轮询，反查 rooms 集合中
 *                   playerA_Id==我 且 state=='PLAYING' 的最新房间。
 *    CANCEL       : 等待方取消匹配（清理自己的池占位）。
 *
 *  原子性原理（Gemini 拍板：matchPool 单文档配对池）：
 *    占位与清空均使用「条件更新」：
 *      where({_id:'pool', waiter: exists(false)}).update(...)   —— 只有池空时我才能占位
 *      where({_id:'pool', waiter: other}).update(...)           —— 只有匹配到我才清空配对
 *    二者天然串行，彻底避免「两人同时建房 / 两人抢同一房间」。
 *
 *  需预先初始化 matchPool 集合及单文档：{ _id:'pool' }
 *  （本函数会惰性兜底创建，重复创建冲突自动忽略）。
 * =====================================================================
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

// ---- 错误码 ----
const ErrCode = Object.freeze({
  OK: 0,
  INVALID_PARAMS: 1001,
  MATCH_BUSY: 1201,   // 匹配繁忙（重试耗尽）
  DB_ERROR: 5000,
  INTERNAL: 5001,
});

// ---- 常量 ----
const POOL_ID = 'pool';           // 配对池固定文档 ID
const MATCH_POOL_COLL = 'matchPool';
const ROOMS_COLL = 'rooms';
const MATCH_RETRY = 3;            // 占位/清空重试次数
const TOTAL_ROUNDS = 10;          // 单场总踢球数（各 5 次）

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

/** 构造带业务码的异常 */
function createError(code, msg) {
  const err = new Error(msg);
  err.code = code;
  err.msg = msg;
  return err;
}

/** 判断是否"文档不存在"错误 */
function isNotFoundError(err) {
  const msg = String((err && (err.errMsg || err.message)) || '');
  const code = err && err.errCode;
  return code === -502004 || /not exist|不存在|does not exist/i.test(msg);
}

/**
 * 确保配对池文档存在（单文档 _id='pool'）。
 * 并发创建冲突（_id 重复）忽略，视为已存在。
 */
async function ensurePoolDoc() {
  try {
    await db.collection(MATCH_POOL_COLL).doc(POOL_ID).get();
    return;
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
  }
  try {
    await db.collection(MATCH_POOL_COLL).add({ data: { _id: POOL_ID } });
  } catch (err2) {
    // _id 冲突：并发下可能已被创建，忽略
    if (!isNotFoundError(err2)) {
      // 非"已存在"类错误仍记录
      console.warn('[matchPlayer] ensurePoolDoc add conflict', err2.errMsg || err2.message);
    }
  }
}

/** 构造房间文档初始数据 */
function createRoomDoc(playerA, playerB, now) {
  return {
    state: 'PLAYING',
    playerA_Id: playerA,
    playerB_Id: playerB,
    roundIndex: 0,
    roundShooter: 'A',      // 首轮由建房者（A）先射门
    score: { A: 0, B: 0 },
    totalRounds: TOTAL_ROUNDS,
    actionA: null,
    actionB: null,
    lastResult: null,
    createTime: now,
    updateTime: now,
  };
}

// =====================================================================
//  匹配核心：MATCH_RANDOM
// =====================================================================
/**
 * 随机匹配。
 * @param {string} openid 当前玩家 openid
 * @returns 占位成功: { matched:false, role:'A', state:'WAITING' }
 *          配对成功: { matched:true, role:'B', roomId, state:'PLAYING' }
 */
async function matchRandom(openid) {
  const now = Date.now();

  for (let attempt = 0; attempt < MATCH_RETRY; attempt++) {
    // ---- 1. 尝试占位：池空才能占位 ----
    const claim = await db
      .collection(MATCH_POOL_COLL)
      .where({ _id: POOL_ID, waiter: _.exists(false) })
      .update({ data: { waiter: openid, waiterTime: now } });

    if (claim.stats && claim.stats.updated === 1) {
      // 我成为等待者 → 我是 A
      return { matched: false, role: 'A', roomId: null, state: 'WAITING', playerId: openid };
    }

    // ---- 2. 池有等待者（或池文档缺失）→ 读取 ----
    let pool = null;
    try {
      const snap = await db.collection(MATCH_POOL_COLL).doc(POOL_ID).get();
      pool = snap.data || {};
    } catch (err) {
      if (isNotFoundError(err)) {
        await ensurePoolDoc();
        continue; // 建池后重试占位
      }
      throw err;
    }

    const other = pool.waiter;

    // 自己在池中（重复调用）→ 幂等返回等待
    if (other === openid) {
      return { matched: false, role: 'A', roomId: null, state: 'WAITING', playerId: openid };
    }

    // 池被并发清空 → 重试占位
    if (!other) {
      continue;
    }

    // ---- 3. 尝试清空配对：只有匹配到 other 才能清空 ----
    const clear = await db
      .collection(MATCH_POOL_COLL)
      .where({ _id: POOL_ID, waiter: other })
      .update({ data: { waiter: _.remove(), waiterTime: _.remove() } });

    if (clear.stats && clear.stats.updated === 1) {
      // ---- 4. 配对成功 → 建房（other=A 建房者，我=B 加入者）----
      const addRes = await db.collection(ROOMS_COLL).add({
        data: createRoomDoc(other, openid, Date.now()),
      });
      return {
        matched: true,
        role: 'B',
        roomId: addRes._id,
        state: 'PLAYING',
        playerId: openid,
        opponentId: other,
      };
    }

    // 清空被并发抢先 → 重试
  }

  throw createError(ErrCode.MATCH_BUSY, 'match_busy');
}

// =====================================================================
//  匹配状态查询：GET_STATUS（供等待方 role='A' 轮询）
// =====================================================================
/**
 * 反查等待方（A）是否已被配对建房。
 * @param {string} openid
 * @returns { matched, roomId, state, role, playerId }
 */
async function getStatus(openid) {
  const res = await db
    .collection(ROOMS_COLL)
    .where({ playerA_Id: openid, state: 'PLAYING' })
    .orderBy('updateTime', 'desc')
    .limit(1)
    .get();

  const doc = res.data && res.data[0];
  if (doc && doc._id) {
    return {
      matched: true,
      roomId: doc._id,
      state: 'PLAYING',
      role: 'A',
      playerId: openid,
    };
  }
  return { matched: false, roomId: null, state: 'WAITING', role: 'A', playerId: openid };
}

// =====================================================================
//  取消匹配：CANCEL
// =====================================================================
async function cancelMatch(openid) {
  // 仅当池中等待者仍是我时才清理，避免误伤他人占位
  await db
    .collection(MATCH_POOL_COLL)
    .where({ _id: POOL_ID, waiter: openid })
    .update({ data: { waiter: _.remove(), waiterTime: _.remove() } });
  return { cancelled: true };
}

// =====================================================================
//  云函数入口
// =====================================================================
exports.main = async (event) => {
  const evt = event || {};
  const action = evt.action;

  let openid = '';
  try {
    const ctx = cloud.getWXContext();
    openid = ctx.OPENID || '';
  } catch (err) {
    console.warn('[matchPlayer] getWXContext failed', err);
  }

  try {
    switch (action) {
      case 'MATCH_RANDOM':
        return ok(await matchRandom(openid));
      case 'GET_STATUS':
        return ok(await getStatus(openid));
      case 'CANCEL':
        return ok(await cancelMatch(openid));
      default:
        return fail(ErrCode.INVALID_PARAMS, 'unknown_action', { action });
    }
  } catch (err) {
    console.error('[matchPlayer] error', err);
    const code = err && err.code ? err.code : ErrCode.INTERNAL;
    const msg = (err && err.msg) || 'internal_error';
    return fail(code, msg, String((err && err.message) || err));
  }
};

// 导出核心逻辑，便于本地单测
exports.matchRandom = matchRandom;
exports.getStatus = getStatus;
exports.cancelMatch = cancelMatch;
exports.createRoomDoc = createRoomDoc;
