/**
 * =====================================================================
 *  1v1 实时点球小游戏 · 回合结算云函数 (resolveRound)
 * =====================================================================
 *  运行环境 : Node.js 16.x + wx-server-sdk（微信云开发）
 *  职责     : 接收双端滑屏数据 → 计算力度/方向/档位 → 防重提交 → 双方齐后结算
 *
 *  安全约定 :
 *    - 玩家身份一律取自 wx.getWXContext().OPENID，忽略客户端上报的 playerId，
 *      防止越权提交 / 冒充对手；
 *    - GET_ROOM 仅房间内玩家可查，且响应剥离双方 openid，避免敏感信息泄露；
 *    - 错误响应只返回业务码与文案，不透传内部异常细节。
 *
 *  部署步骤 :
 *    1. 在微信开发者工具中，右键本目录 → 「上传并部署：云端安装依赖」
 *    2. 需先由「匹配/建房」云函数创建 rooms 文档，初始结构如下：
 *       {
 *         _id        : 房间ID,
 *         roundIndex : 0,                 // 当前回合（兼作结算随机种子）
 *         playerA_Id : 'A玩家openid',      // 建房者（边 A）
 *         playerB_Id : 'B玩家openid',      // 加入者（边 B）
 *         roundShooter: 'A',              // 本回合射门方（轮流射门）
 *         score      : { A: 0, B: 0 },    // 比分
 *         state      : 'PLAYING',         // WAITING / PLAYING / FINISHED
 *         actionA    : null,              // 边 A 玩家本回合动作
 *         actionB    : null,              // 边 B 玩家本回合动作
 *         lastResult : null               // 最近一次结算结果
 *       }
 *    3. 客户端通过 db.collection('rooms').doc(roomId).watch() 监听
 *       roundIndex / lastResult 变化，实现双端实时同步动画。
 * =====================================================================
 */

// ------------------------- 云开发 SDK 初始化 -------------------------
const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV, // 使用当前所在环境
});

const db = cloud.database();

// =====================================================================
//  一、调参常量（滑屏 → 力度，需实测校准）
// =====================================================================
const MIN_DIST = 10;    // 有效滑屏最小距离（设计空间 px），低于视为误触
const MAX_DIST = 800;   // 满力度参考距离（设计空间 px，对应 750 宽度归一化后的满屏滑动）
const MAX_VELO = 10;    // 满力度参考速度 px/ms（≈10000px/s）
const W_DIST = 0.35;    // 距离权重
const W_VELO = 0.65;    // 速度权重（速度为主，防止"慢速满屏拖"刷满力度）
const LANE_THRESHOLD = 0.3; // 方向离散化水平分量阈值

// 滑屏耗时钳制范围（ms），防止非法/异常时长导致速度畸变
const MIN_DURATION = 1;
const MAX_DURATION = 3000;

// =====================================================================
//  二、状态枚举定义
// =====================================================================
const Role = Object.freeze({
  Shooter: 'SHOOTER', // 射门方 A
  Keeper: 'KEEPER',   // 守门方 B
});

const ShotLane = Object.freeze({
  Left: 'LEFT',
  Center: 'CENTER',
  Right: 'RIGHT',
});

const ShotPowerTier = Object.freeze({
  Overkill: 'OVERKILL', // >90  爆表（踢飞）
  Power: 'POWER',       // 70-90 大力死角
  Standard: 'STANDARD', // 40-70 常规
  Soft: 'SOFT',         // <40  小力勺子
});

const DivePowerTier = Object.freeze({
  Overkill: 'OVERKILL', // >90  爆表（脸刹）
  Hard: 'HARD',         // 70-90 极限飞身
  Standard: 'STANDARD', // 40-70 常规侧扑
  Soft: 'SOFT',         // <40  原地不跳
});

const RoundOutcome = Object.freeze({
  Goal: 'GOAL',
  Save: 'SAVE',
  Miss: 'MISS',
});

const RoundResultCode = Object.freeze({
  // 踢飞 / 自身失误 (Miss)
  MISS_SHOE_FLOWN: 'MISS_SHOE_FLOWN',
  MISS_TO_SPACE: 'MISS_TO_SPACE',
  // 进球 (Goal)
  GOAL_SPOON: 'GOAL_SPOON',
  GOAL_CANNON: 'GOAL_CANNON',
  GOAL_CLEAN: 'GOAL_CLEAN',
  GOAL_FACEBRAKE: 'GOAL_FACEBRAKE',
  GOAL_MISDIRECT: 'GOAL_MISDIRECT',
  GOAL_MISDIRECT_SPOON: 'GOAL_MISDIRECT_SPOON',
  GOAL_MISDIRECT_CANNON: 'GOAL_MISDIRECT_CANNON',
  // 扑救成功 (Save)
  SAVE_CATCH: 'SAVE_CATCH',
  SAVE_CLEAN: 'SAVE_CLEAN',
  SAVE_FLYING: 'SAVE_FLYING',
});

// 结算状态码 → 搞笑文案（供前端弹幕/动画提示）
const DESCRIPTION = Object.freeze({
  [RoundResultCode.MISS_SHOE_FLOWN]: '力度爆表！鞋飞了，直冲门将！',
  [RoundResultCode.MISS_TO_SPACE]: '力度爆表！球飞向太空！',
  [RoundResultCode.GOAL_SPOON]: '门将飞太早扑空！慢球勺子羞辱入网！',
  [RoundResultCode.GOAL_CANNON]: '大力死角重炮！门将鞭长莫及！',
  [RoundResultCode.GOAL_CLEAN]: '门将没跳起来，球越过防线入网！',
  [RoundResultCode.GOAL_FACEBRAKE]: '门将用力过猛脸刹滑倒！球轻松滚入！',
  [RoundResultCode.GOAL_MISDIRECT]: '门将扑错方向，目送皮球入网！',
  [RoundResultCode.GOAL_MISDIRECT_SPOON]: '扑错方向！慢球羞辱性滚入！',
  [RoundResultCode.GOAL_MISDIRECT_CANNON]: '扑错方向！空门重炮入网！',
  [RoundResultCode.SAVE_CATCH]: '门将原地轻松没收慢球！',
  [RoundResultCode.SAVE_CLEAN]: '常规侧扑，皮球被扑出！',
  [RoundResultCode.SAVE_FLYING]: '极限飞身，封出皮球！',
});

// 业务错误码（与 HTTP 无关，自定协议）
const ErrCode = Object.freeze({
  OK: 0,
  UNKNOWN_ACTION: 1000,
  INVALID_PARAMS: 1001,
  PLAYER_NOT_IN_ROOM: 1002,
  STALE_ROUND: 1003,
  ALREADY_SUBMITTED: 1004,
  ROOM_NOT_PLAYING: 1005,
  ROOM_NOT_FOUND: 1006,
  SETTLE_CONFLICT: 2001,
  DB_ERROR: 5000,
  INTERNAL: 5001,
});

// =====================================================================
//  三、纯函数（无 DB 副作用，可单独单测）
// =====================================================================

/** 数值钳制 */
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * 力度合成：距离 × 速度 双重加权，输出 0-100。
 * 距离基于 dx/dy 重新计算，不信任客户端上报的 distance，防止作弊。
 * @param {number} dx 水平位移 dp
 * @param {number} dy 竖直位移 dp
 * @param {number} duration 耗时 ms
 */
function computePower(dx, dy, duration) {
  const distance = Math.hypot(dx, dy);

  // 误触 / 原地点击 / 非数值
  if (!Number.isFinite(distance) || distance < MIN_DIST) return 0;

  // 耗时非法时钳到合理区间，防止除零/速度畸变
  let dur = Number(duration);
  if (!Number.isFinite(dur)) dur = 0;
  dur = clamp(dur, MIN_DURATION, MAX_DURATION);

  const velocity = distance / dur; // dp/ms

  const distNorm = clamp(distance / MAX_DIST, 0, 1);
  const veloNorm = clamp(velocity / MAX_VELO, 0, 1);

  const power = Math.round(100 * (W_DIST * distNorm + W_VELO * veloNorm));
  return clamp(power, 0, 100);
}

/**
 * 方向离散化：滑屏向量 → 三路（左/中/右）。
 * 水平分量归一化后按阈值分档，与滑屏长度无关。
 */
function toLane(dx, dy) {
  const mag = Math.hypot(dx, dy);
  if (!Number.isFinite(mag) || mag < MIN_DIST) return ShotLane.Center; // 无效滑动默认中路
  const h = dx / mag; // -1..1
  if (h < -LANE_THRESHOLD) return ShotLane.Left;
  if (h > LANE_THRESHOLD) return ShotLane.Right;
  return ShotLane.Center;
}

/**
 * 力度 → 档位（边界约定：>90 爆表、>=70 大力/飞身、>=40 标准、<40 小力/原地）
 * 射门方与守门方在同一档位范围上语义不同（POWER vs HARD），故按角色区分。
 */
function toTier(power, role) {
  if (power > 90) {
    return role === Role.Shooter ? ShotPowerTier.Overkill : DivePowerTier.Overkill;
  }
  if (power >= 70) {
    return role === Role.Shooter ? ShotPowerTier.Power : DivePowerTier.Hard;
  }
  if (power >= 40) return ShotPowerTier.Standard; // 双端字符串值一致
  return ShotPowerTier.Soft; // 双端字符串值一致
}

/**
 * 构造结算结果对象（附搞笑文案）。
 * @param {string} outcome
 * @param {string} code
 * @param {string} shooterTier
 * @param {string} keeperTier
 * @param {boolean} laneMatched
 * @param {string} shooterLane 射门方实际方向（前端据此播放球的飞行方向）
 * @param {string} keeperLane  守门方实际方向（前端据此播放门将扑救方向）
 */
function buildResult(outcome, code, shooterTier, keeperTier, laneMatched, shooterLane, keeperLane) {
  return {
    outcome,
    code,
    description: DESCRIPTION[code] || '',
    shooterTier,
    keeperTier,
    laneMatched,
    shooterLane,
    keeperLane,
  };
}

/**
 * 核心结算：力度博弈与结算矩阵。
 * 判定优先级：射门爆表踢飞 → 门将爆表脸刹 → 方向是否一致 → 力度克制矩阵。
 * @param {{lane:string,power:number,tier:string}} attacker 射门方动作
 * @param {{lane:string,power:number,tier:string}} defender 守门方动作
 * @param {number} roundSeed 回合种子（roundIndex），用于确定性口味选择
 */
function resolveRound(attacker, defender, roundSeed) {
  const shooterLane = attacker.lane;
  const keeperLane = defender.lane;
  const shotTier = attacker.tier;
  const diveTier = defender.tier;
  const laneMatched = shooterLane === keeperLane;

  // ---- 优先级 1：射门方自身失误（爆表踢飞）----
  if (shotTier === ShotPowerTier.Overkill) {
    const code = pickMissFlavor(diveTier, roundSeed);
    return buildResult(
      RoundOutcome.Miss, code, shotTier, diveTier, laneMatched, shooterLane, keeperLane,
    );
  }

  // ---- 优先级 2：守门方自身失误（爆表滑倒脸刹）----
  if (diveTier === DivePowerTier.Overkill) {
    return buildResult(
      RoundOutcome.Goal,
      RoundResultCode.GOAL_FACEBRAKE,
      shotTier,
      diveTier,
      laneMatched,
      shooterLane,
      keeperLane,
    );
  }

  // ---- 优先级 3：方向判断（扑错方向 → 目送进球）----
  if (!laneMatched) {
    return buildResult(
      RoundOutcome.Goal,
      pickMisdirectCode(shotTier),
      shotTier,
      diveTier,
      laneMatched,
      shooterLane,
      keeperLane,
    );
  }

  // ---- 优先级 4：方向一致 → 力度克制矩阵 ----
  return resolvePowerMatrix(shotTier, diveTier, laneMatched, shooterLane, keeperLane);
}

/**
 * 力度克制矩阵（方向一致时）。
 * 克制环：SOFT 克 HARD（勺子）→ HARD 克 POWER（极限扑）→ POWER 克 SOFT/STANDARD（重炮）
 */
function resolvePowerMatrix(shot, dive, laneMatched, shooterLane, keeperLane) {
  // 门将：小力原地（不怎么起跳，只能挡慢球）
  if (dive === DivePowerTier.Soft) {
    if (shot === ShotPowerTier.Soft) {
      return buildResult(
        RoundOutcome.Save, RoundResultCode.SAVE_CATCH, shot, dive, laneMatched, shooterLane, keeperLane,
      );
    }
    if (shot === ShotPowerTier.Standard) {
      return buildResult(
        RoundOutcome.Goal, RoundResultCode.GOAL_CLEAN, shot, dive, laneMatched, shooterLane, keeperLane,
      );
    }
    return buildResult(
      RoundOutcome.Goal, RoundResultCode.GOAL_CANNON, shot, dive, laneMatched, shooterLane, keeperLane,
    );
  }

  // 门将：标准侧扑（常规扑救）
  if (dive === DivePowerTier.Standard) {
    if (shot === ShotPowerTier.Soft) {
      return buildResult(
        RoundOutcome.Save, RoundResultCode.SAVE_CLEAN, shot, dive, laneMatched, shooterLane, keeperLane,
      );
    }
    if (shot === ShotPowerTier.Standard) {
      return buildResult(
        RoundOutcome.Save, RoundResultCode.SAVE_CLEAN, shot, dive, laneMatched, shooterLane, keeperLane,
      );
    }
    return buildResult(
      RoundOutcome.Goal, RoundResultCode.GOAL_CANNON, shot, dive, laneMatched, shooterLane, keeperLane,
    );
  }

  // 门将：极限飞身（飞得极远）
  if (shot === ShotPowerTier.Soft) {
    return buildResult(
      RoundOutcome.Goal, RoundResultCode.GOAL_SPOON, shot, dive, laneMatched, shooterLane, keeperLane,
    );
  }
  if (shot === ShotPowerTier.Standard) {
    return buildResult(
      RoundOutcome.Save, RoundResultCode.SAVE_FLYING, shot, dive, laneMatched, shooterLane, keeperLane,
    );
  }
  return buildResult(
    RoundOutcome.Save, RoundResultCode.SAVE_FLYING, shot, dive, laneMatched, shooterLane, keeperLane,
  );
}

/**
 * 踢飞口味选择（必须确定性，避免双端动画不一致）。
 * 用 roundSeed 做种子，禁止 Math.random()。
 */
function pickMissFlavor(dive, roundSeed) {
  if (dive === DivePowerTier.Overkill) {
    return RoundResultCode.MISS_SHOE_FLOWN; // 鞋砸向正在脸刹的门将
  }
  const seed = Number(roundSeed) || 0;
  return seed % 2 === 0 ? RoundResultCode.MISS_SHOE_FLOWN : RoundResultCode.MISS_TO_SPACE;
}

/** 扑错方向时按射门力度细分表现 */
function pickMisdirectCode(shot) {
  if (shot === ShotPowerTier.Soft) return RoundResultCode.GOAL_MISDIRECT_SPOON;
  if (shot === ShotPowerTier.Power) return RoundResultCode.GOAL_MISDIRECT_CANNON;
  return RoundResultCode.GOAL_MISDIRECT;
}

// =====================================================================
//  四、响应协议与错误判定工具
// =====================================================================

function ok(data) {
  return { code: ErrCode.OK, msg: 'ok', data };
}

function fail(code, msg, detail) {
  const body = { code, msg };
  if (detail !== undefined) body.detail = detail;
  return body;
}

/**
 * 判断是否"事务并发冲突"错误，命中则重试。
 * 注：errCode 随 SDK 版本可能变化，这里同时用 code 与 message 双重匹配。
 */
function isConflictError(err) {
  const msg = String((err && (err.errMsg || err.message)) || '');
  const code = err && err.errCode;
  return code === -502005 || /conflict|并发|冲突/i.test(msg);
}

/** 判断是否"文档不存在"错误 */
function isNotFoundError(err) {
  const msg = String((err && (err.errMsg || err.message)) || '');
  const code = err && err.errCode;
  return code === -502004 || /not exist|不存在|does not exist/i.test(msg);
}

/**
 * 判断玩家所属边，返回 'A' | 'B' | null（攻守角色由 roundShooter 动态决定）。
 * 房间模式约定：hostId=边A（建房者），guestId=边B（入房者）。
 * 向后兼容旧房间字段 playerA_Id/playerB_Id。
 */
function getSide(room, playerId) {
  if (room.hostId && room.hostId === playerId) return 'A';
  if (room.guestId && room.guestId === playerId) return 'B';
  if (room.playerA_Id && room.playerA_Id === playerId) return 'A';
  if (room.playerB_Id && room.playerB_Id === playerId) return 'B';
  return null;
}

/**
 * 纯函数：胜负判定与加时判定（不依赖 DB，便于单测）。
 * 规则：
 *   ① 常规局：踢满 totalRounds 后比分高者胜；平局进入加时（suddenDeath=true）。
 *   ② 提前胜出：每脚结算后评估，某方落后分数 > 其剩余脚数 即提前结束。
 *   ③ 加时（Sudden Death）：每轮 A、B 各踢 1 脚，仅当 B 踢完（一对结束）才判胜负；
 *      无限加时，必分胜负（无 DRAW）。
 * @param {object} room 结算前快照（含 roundShooter/totalRounds/suddenDeath）
 * @param {{A:number,B:number}} nextScore 结算后比分
 * @param {number} nextRoundIndex 结算后已踢完脚数
 * @returns {{state:'PLAYING'|'FINISHED', winner:null|'A'|'B', suddenDeath:boolean}}
 */
function determineGame(room, nextScore, nextRoundIndex) {
  const totalRounds =
    typeof room.totalRounds === 'number' && room.totalRounds > 0 ? room.totalRounds : 10;
  const suddenDeath = !!room.suddenDeath;

  // ③ 加时赛：仅当 B 踢完（一对结束）才判胜负；仍平则继续
  if (suddenDeath) {
    if (room.roundShooter === 'B') {
      if (nextScore.A > nextScore.B) return { state: 'FINISHED', winner: 'A', suddenDeath: true };
      if (nextScore.B > nextScore.A) return { state: 'FINISHED', winner: 'B', suddenDeath: true };
    }
    return { state: 'PLAYING', winner: null, suddenDeath: true };
  }

  // ① 常规局踢满
  if (nextRoundIndex >= totalRounds) {
    if (nextScore.A > nextScore.B) return { state: 'FINISHED', winner: 'A', suddenDeath: false };
    if (nextScore.B > nextScore.A) return { state: 'FINISHED', winner: 'B', suddenDeath: false };
    // 平局 → 进入加时
    return { state: 'PLAYING', winner: null, suddenDeath: true };
  }

  // ② 提前胜出：落后分数 > 其剩余脚数（严格大于，能追平则继续）
  const per = Math.floor(totalRounds / 2);
  const kicksTakenA = Math.ceil(nextRoundIndex / 2);
  const kicksTakenB = Math.floor(nextRoundIndex / 2);
  const kicksLeftA = per - kicksTakenA;
  const kicksLeftB = per - kicksTakenB;
  if (nextScore.A - nextScore.B > kicksLeftB) {
    return { state: 'FINISHED', winner: 'A', suddenDeath: false };
  }
  if (nextScore.B - nextScore.A > kicksLeftA) {
    return { state: 'FINISHED', winner: 'B', suddenDeath: false };
  }

  return { state: 'PLAYING', winner: null, suddenDeath: false };
}

/**
 * 纯函数：结算一回合（不依赖 DB，便于单测）。
 * 根据 room.roundShooter 动态判定攻守双方（实现轮流射门）；
 * outcome 为 GOAL 时给射门方计分；结算后翻转 roundShooter；
 * 通过 determineGame 给出 game 级状态（state/winner/suddenDeath）。
 * @param {object} room 房间快照（含 roundIndex/roundShooter/score/totalRounds/suddenDeath）
 * @param {object} actionA 玩家 A 的本回合动作（含 tier）
 * @param {object} actionB 玩家 B 的本回合动作（含 tier）
 * @returns {{result:object, nextScore:{A:number,B:number}, nextRoundShooter:string,
 *            nextRoundIndex:number, game:{state:string,winner:string|null,suddenDeath:boolean}}}
 */
function settleRound(room, actionA, actionB) {
  const roundIndex = typeof room.roundIndex === 'number' ? room.roundIndex : 0;
  const shooterIsA = (room.roundShooter || 'A') === 'A';

  const attacker = shooterIsA ? actionA : actionB;
  const defender = shooterIsA ? actionB : actionA;

  const result = resolveRound(attacker, defender, roundIndex);

  // 计分：GOAL 时射门方 +1（兼容旧房间缺失 score 字段）
  const cur = room.score && typeof room.score === 'object' ? room.score : { A: 0, B: 0 };
  const nextScore = { A: cur.A || 0, B: cur.B || 0 };
  if (result.outcome === RoundOutcome.Goal) {
    nextScore[shooterIsA ? 'A' : 'B'] += 1;
  }

  const nextRoundShooter = shooterIsA ? 'B' : 'A';
  const nextRoundIndex = roundIndex + 1;
  const game = determineGame(room, nextScore, nextRoundIndex);

  return {
    result,
    nextScore,
    nextRoundShooter,
    nextRoundIndex,
    game,
  };
}

// =====================================================================
//  五、业务处理
// =====================================================================

/**
 * 提交动作主流程：参数校验 → 本地纯计算 → 事务提交/结算。
 * 身份以调用上下文 openid 为准，忽略客户端传入的 playerId，防止越权/冒充。
 */
async function handleSubmitAction(event, openid) {
  const { roomId, roundIndex, swipeData } = event;

  // 参数完整性校验
  if (!roomId || !openid || roundIndex === undefined || roundIndex === null || !swipeData) {
    return fail(ErrCode.INVALID_PARAMS, 'invalid_params');
  }

  // roundIndex 必须为整数
  const clientRoundIndex = Number(roundIndex);
  if (!Number.isInteger(clientRoundIndex) || clientRoundIndex < 0) {
    return fail(ErrCode.INVALID_PARAMS, 'invalid_round_index');
  }

  // 滑屏数据校验（dx/dy 必须为有限数值；duration 由 computePower 内部钳制）
  const dx = Number(swipeData.dx);
  const dy = Number(swipeData.dy);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
    return fail(ErrCode.INVALID_PARAMS, 'invalid_swipe');
  }

  // 本地纯计算（无 DB 副作用）
  const power = computePower(dx, dy, swipeData.duration);
  const lane = toLane(dx, dy);
  const swipeRes = {
    dx,
    dy,
    distance: Math.hypot(dx, dy),
    duration: Number(swipeData.duration) || 0,
    power,
    lane,
  };

  return await submitWithLock(roomId, openid, clientRoundIndex, swipeRes);
}

/**
 * 事务提交 + 结算（带并发冲突重试）。
 * 关键保证：
 *  1. 单文档事务序列化"读-改-写"，避免双人并发结算。
 *  2. roundIndex 一致性校验，杜绝陈旧提交与重复结算。
 */
async function submitWithLock(roomId, playerId, clientRoundIndex, swipeRes) {
  const MAX_RETRY = 3;

  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    let transaction;
    try {
      transaction = await db.startTransaction();

      // 事务内读取房间（单文档读取）
      const snap = await transaction.collection('rooms').doc(roomId).get();
      const room = snap.data;
      const serverRound = typeof room.roundIndex === 'number' ? room.roundIndex : 0;

      // ---- 玩家身份校验（按 A/B 边，攻守角色由 roundShooter 决定）----
      const side = getSide(room, playerId);
      if (!side) {
        await transaction.rollback();
        return fail(ErrCode.PLAYER_NOT_IN_ROOM, 'player_not_in_room');
      }

      // ---- 房间状态校验 ----
      if (room.state && room.state !== 'PLAYING') {
        await transaction.rollback();
        return fail(ErrCode.ROOM_NOT_PLAYING, 'room_not_playing', { state: room.state });
      }

      // ---- 防陈旧提交：客户端回合号必须等于服务器当前回合 ----
      if (clientRoundIndex !== serverRound) {
        await transaction.rollback();
        // 已结算过：顺手带回最新结果，让客户端直接补放动画
        let lastResult = null;
        try {
          const fresh = await db.collection('rooms').doc(roomId).get();
          lastResult = fresh.data.lastResult || null;
        } catch (_e) { /* 忽略，降级为空 */ }
        return fail(ErrCode.STALE_ROUND, 'stale_round', {
          serverRoundIndex: serverRound,
          lastResult,
        });
      }

      const actionKey = side === 'A' ? 'actionA' : 'actionB';
      const otherKey = side === 'A' ? 'actionB' : 'actionA';

      // ---- 防重提交：本回合该玩家已提交过 ----
      if (room[actionKey] && room[actionKey].playerId) {
        await transaction.rollback();
        return fail(ErrCode.ALREADY_SUBMITTED, 'already_submitted');
      }

      // ---- 本回合攻守角色（按 roundShooter，实现轮流射门）----
      const shooterIsA = (room.roundShooter || 'A') === 'A';
      const myRole = side === 'A'
        ? (shooterIsA ? Role.Shooter : Role.Keeper)
        : (shooterIsA ? Role.Keeper : Role.Shooter);

      // ---- 组装本回合动作数据 ----
      const actionData = {
        playerId,
        dx: swipeRes.dx,
        dy: swipeRes.dy,
        distance: swipeRes.distance,
        duration: swipeRes.duration,
        power: swipeRes.power,
        lane: swipeRes.lane,
        tier: toTier(swipeRes.power, myRole),
        submittedAt: Date.now(),
      };

      const otherAction = room[otherKey];

      // ---- 双方是否都已提交 ----
      if (otherAction && otherAction.playerId) {
        // 已齐 → 纯函数结算（含计分、攻守轮换与胜负判定）
        const fullActionA = actionKey === 'actionA' ? actionData : otherAction;
        const fullActionB = actionKey === 'actionB' ? actionData : otherAction;
        const { result, nextScore, nextRoundShooter, nextRoundIndex, game } = settleRound(
          room, fullActionA, fullActionB,
        );

        // 写结果 + 计分 + 轮换 + 回合 +1 + 胜负状态 + 清空双方动作
        await transaction.collection('rooms').doc(roomId).update({
          data: {
            actionA: null,
            actionB: null,
            roundIndex: nextRoundIndex,
            roundShooter: nextRoundShooter,
            score: nextScore,
            suddenDeath: game.suddenDeath,
            winner: game.winner,
            state: game.state,
            lastResult: Object.assign({}, result, {
              settledRound: serverRound,
              settledAt: Date.now(),
              game,
            }),
          },
        });

        await transaction.commit();
        return ok({
          submitted: true,
          settled: true,
          waiting: false,
          result,
          roundIndex: nextRoundIndex,
          roundShooter: nextRoundShooter,
          score: nextScore,
          game,
        });
      }

      // 单方提交 → 仅写入动作，等待对手
      await transaction.collection('rooms').doc(roomId).update({
        data: { [actionKey]: actionData },
      });

      await transaction.commit();
      return ok({
        submitted: true,
        settled: false,
        waiting: true,
        result: null,
        roundIndex: serverRound,
      });
    } catch (err) {
      // 尽力回滚（若已提交/已回滚则忽略二次回滚错误）
      if (transaction) {
        try { await transaction.rollback(); } catch (_e) { /* 忽略 */ }
      }

      // 房间不存在
      if (isNotFoundError(err)) {
        return fail(ErrCode.ROOM_NOT_FOUND, 'room_not_found');
      }

      // 并发冲突 → 重试（重新读取最新状态后再判）
      if (isConflictError(err) && attempt < MAX_RETRY - 1) {
        continue;
      }

      console.error('[submitWithLock] db error', err);
      return fail(
        isConflictError(err) ? ErrCode.SETTLE_CONFLICT : ErrCode.DB_ERROR,
        isConflictError(err) ? 'settle_conflict' : 'db_error',
      );
    }
  }

  return fail(ErrCode.SETTLE_CONFLICT, 'settle_conflict');
}

/**
 * 查询房间（供客户端拉取 latest 状态，作为 watch 的兜底）。
 * 鉴权：仅房间内玩家可查询；响应剥离双方 openid（playerA_Id/playerB_Id/action*.playerId）。
 */
async function handleGetRoom(event, openid) {
  const { roomId } = event;
  if (!roomId) return fail(ErrCode.INVALID_PARAMS, 'invalid_params');

  try {
    const snap = await db.collection('rooms').doc(roomId).get();
    const room = snap.data || {};

    // 鉴权：只有房间内玩家（A/B 边）才能查询该房间
    const mySide = getSide(room, openid);
    if (!mySide) {
      return fail(ErrCode.PLAYER_NOT_IN_ROOM, 'player_not_in_room');
    }

    // 剥离 openid，仅返回客户端对局所需的必要字段
    const safeRoom = {
      state: room.state,
      roundIndex: room.roundIndex,
      roundShooter: room.roundShooter,
      score: room.score,
      totalRounds: room.totalRounds,
      suddenDeath: !!room.suddenDeath,
      winner: room.winner,
      lastResult: room.lastResult,
    };
    return ok({ room: safeRoom, mySide });
  } catch (err) {
    if (isNotFoundError(err)) return fail(ErrCode.ROOM_NOT_FOUND, 'room_not_found');
    console.error('[handleGetRoom] db error', err);
    return fail(ErrCode.DB_ERROR, 'db_error');
  }
}

// =====================================================================
//  六、云函数入口
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

  // 权威身份：以微信调用上下文 openid 为准，绝不信任客户端传入的 playerId
  let openid = '';
  try {
    const ctx = cloud.getWXContext();
    openid = ctx.OPENID || '';
  } catch (err) {
    console.warn('[resolveRound] getWXContext failed', err);
  }
  if (!openid) {
    return fail(ErrCode.INVALID_PARAMS, 'no_openid');
  }

  const { action } = evt;

  try {
    switch (action) {
      case 'SUBMIT_ACTION':
        return await handleSubmitAction(evt, openid);
      case 'GET_ROOM':
        return await handleGetRoom(evt, openid);
      default:
        return fail(ErrCode.UNKNOWN_ACTION, 'unknown_action', { action });
    }
  } catch (err) {
    // 兜底异常，避免未捕获异常导致云函数直接失败且无结构化返回
    console.error('[main] unhandled error', err);
    return fail(ErrCode.INTERNAL, 'internal_error');
  }
};

// 导出核心纯函数，便于本地单元测试
exports.resolveRound = resolveRound;
exports.resolvePowerMatrix = resolvePowerMatrix;
exports.settleRound = settleRound;
exports.determineGame = determineGame;
exports.computePower = computePower;
exports.toLane = toLane;
exports.toTier = toTier;
exports.buildResult = buildResult;
exports.getSide = getSide;
exports.Enums = {
  Role,
  ShotLane,
  ShotPowerTier,
  DivePowerTier,
  RoundOutcome,
  RoundResultCode,
};
