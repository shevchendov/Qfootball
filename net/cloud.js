/**
 * =====================================================================
 *  云端网络层（net/cloud.js）
 * =====================================================================
 *  职责：
 *    1. 封装 wx.cloud.callFunction('resolveRound')，统一解包 result。
 *    2. 提供 submitSwipeData / getRoom / watchRoom 三个业务接口。
 *    3. 错误码分类（classifyError），供状态机按类别分支处理。
 *
 *  后端返回协议：{ code, msg, data }
 *    code=0 表示成功；其余为业务错误码（见 config.ErrCode）。
 * =====================================================================
 */
const config = require('../config/config');
const { ErrCode } = config;

// 云函数名与动作常量
const CLOUD_FN = 'resolveRound';
const ACTION = Object.freeze({
  SUBMIT_ACTION: 'SUBMIT_ACTION',
  GET_ROOM: 'GET_ROOM',
});

// 错误类别枚举（供前端分支处理）
const ErrorKind = Object.freeze({
  OK: 'OK',
  ALREADY_SUBMITTED: 'ALREADY_SUBMITTED', // 已提交，幂等等待
  STALE_ROUND: 'STALE_ROUND',             // 回合陈旧（可带 lastResult 补动画）
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',       // 房间不存在
  NOT_IN_ROOM: 'NOT_IN_ROOM',             // 玩家不在房间
  ROOM_NOT_PLAYING: 'ROOM_NOT_PLAYING',   // 房间未开局
  CONFLICT: 'CONFLICT',                   // 结算并发冲突（可重试）
  INVALID_PARAMS: 'INVALID_PARAMS',       // 参数错误
  SERVER: 'SERVER',                       // 服务端异常
  NETWORK: 'NETWORK',                     // 本地网络/调用失败
  UNKNOWN: 'UNKNOWN',
});

/** 判断业务响应是否成功 */
function isSuccess(resp) {
  return !!(resp && resp.code === ErrCode.OK);
}

/**
 * 错误码 → 错误类别（供状态机分支处理）。
 * @param {number} code
 */
function classifyError(code) {
  switch (code) {
    case ErrCode.OK: return ErrorKind.OK;
    case ErrCode.ALREADY_SUBMITTED: return ErrorKind.ALREADY_SUBMITTED;
    case ErrCode.STALE_ROUND: return ErrorKind.STALE_ROUND;
    case ErrCode.ROOM_NOT_FOUND: return ErrorKind.ROOM_NOT_FOUND;
    case ErrCode.PLAYER_NOT_IN_ROOM: return ErrorKind.NOT_IN_ROOM;
    case ErrCode.ROOM_NOT_PLAYING: return ErrorKind.ROOM_NOT_PLAYING;
    case ErrCode.SETTLE_CONFLICT: return ErrorKind.CONFLICT;
    case ErrCode.INVALID_PARAMS: return ErrorKind.INVALID_PARAMS;
    case ErrCode.DB_ERROR:
    case ErrCode.INTERNAL: return ErrorKind.SERVER;
    case ErrCode.NETWORK: return ErrorKind.NETWORK;
    default: return ErrorKind.UNKNOWN;
  }
}

/**
 * 云函数调用统一入口：解包 result、兜底异常为结构化响应。
 * @param {object} payload 传给云函数的参数
 * @returns {Promise<{code:number, msg:string, data?:any}>}
 */
async function callResolveRound(payload) {
  try {
    const res = await wx.cloud.callFunction({ name: CLOUD_FN, data: payload });
    const result = res && res.result;
    // 后端一定返回 { code, msg }；异常时给出兜底
    if (!result || typeof result.code !== 'number') {
      console.error('[cloud] 返回结构异常', result);
      return { code: ErrCode.INTERNAL, msg: 'invalid_cloud_result', data: result };
    }
    return result;
  } catch (err) {
    console.error('[cloud] callFunction 调用失败', err);
    return {
      code: ErrCode.NETWORK,
      msg: 'call_function_failed',
      detail: (err && (err.errMsg || err.message)) || String(err),
    };
  }
}

/**
 * 提交本回合划屏动作。
 * @param {object} args
 * @param {string} args.roomId     房间 ID
 * @param {string} args.playerId   玩家 openid
 * @param {number} args.roundIndex 当前回合号（客户端持有的值，用于防陈旧）
 * @param {{dx:number,dy:number,duration:number}} args.swipeData 设计空间划屏数据
 */
function submitSwipeData({ roomId, playerId, roundIndex, swipeData }) {
  return callResolveRound({
    action: ACTION.SUBMIT_ACTION,
    roomId,
    playerId,
    roundIndex,
    swipeData,
  });
}

/**
 * 拉取房间最新状态（watch 的兜底 / 断线重连用）。
 * @param {string} roomId
 */
function getRoom(roomId) {
  return callResolveRound({ action: ACTION.GET_ROOM, roomId });
}

/**
 * 实时监听房间文档变化（云开发 watch）。
 * 对方提交 / 结算结果写入时触发 onChange。
 * @param {string} roomId
 * @param {(room: object, snapshot: object) => void} onChange 每次变更回调（room 为文档 data）
 * @param {(err: any) => void} [onError] 监听错误回调
 * @returns {{ close: () => void }} watcher（可调用 close 停止监听）
 */
function watchRoom(roomId, onChange, onError) {
  const watcher = wx.cloud
    .database()
    .collection('rooms')
    .doc(roomId)
    .watch({
      onChange(snapshot) {
        const docs = snapshot && snapshot.docs;
        const room = docs && docs[0] ? docs[0].data : null;
        if (room && onChange) {
          try {
            onChange(room, snapshot);
          } catch (err) {
            console.error('[cloud] watch onChange 异常', err);
          }
        }
      },
      onError(err) {
        console.error('[cloud] watch 错误', err);
        if (onError) onError(err);
      },
    });
  return watcher;
}

module.exports = {
  CLOUD_FN,
  ACTION,
  ErrorKind,
  callResolveRound,
  submitSwipeData,
  getRoom,
  watchRoom,
  isSuccess,
  classifyError,
};