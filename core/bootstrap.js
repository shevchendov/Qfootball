/**
 * =====================================================================
 *  核心调度与组装（core/bootstrap.js）
 * =====================================================================
 *  职责：
 *    1. 一次性初始化：主画布、dpr 缩放、渲染器、手势模块、主循环。
 *    2. 绑定 input 划屏事件，串起 状态机 → 云函数 → 动画 的完整流程。
 *    3. joinGame()：入房成功后由 matchManager 调用，拉取房间并开启 watchRoom。
 *    4. 开启 watchRoom 实时监听，支撑「被动接收对方结算」场景。
 *    5. 启动 requestAnimationFrame 主循环，按状态绘制画面。
 *
 *  状态流转：
 *    IDLE ─划屏─> SUBMITTING ─结算成功─> ANIMATING ─动画完─> NEXT_ROUND ─停留─> IDLE
 *                └─等待对方─> IDLE（显示"等待对方划屏"）
 *
 *  入房解耦：init() 不再直接入房，改由 matchManager 匹配成功后调用 joinGame()。
 * =====================================================================
 */
const config = require('../config/config');
const stateMachine = require('./stateMachine');
const input = require('./input');
const animator = require('./animator');
const render = require('./render');
const mainLoop = require('./mainLoop');
const cloud = require('../net/cloud');

const { State } = stateMachine;
const { ErrorKind } = cloud;

// NEXT_ROUND 停留时长（ms），用于展示结算横幅
const NEXT_ROUND_HOLD = 1600;
// 结算冲突自动重试上限
const CONFLICT_MAX_RETRY = 1;

// ---- 会话状态（房间 / 玩家 / 回合）----
const session = {
  roomId: '',
  playerId: '',
  mySide: null,          // 'A' | 'B'：我方所在边（joinGame 传入）
  roundShooter: 'A',     // 本回合射门方（服务端为准，watch/提交响应同步）
  roundIndex: 0,         // 当前回合号（以服务端为准）
  score: { A: 0, B: 0 }, // 比分（服务端为准）
  lastPlayedRound: -1,   // 已播放动画的最高 settledRound（防重复播放）
  waitingPrompt: '',     // 状态栏提示文案
  roundSubmitted: false, // 本轮是否已提交（防止重复划屏）
};

// ---- 运行期对象 ----
let ctx = null;
let currentTimeline = null; // 当前动画时间线
let pose = {};              // tick 输出（ball/keeper/fx/done）
let animStart = 0;          // 动画开始时间（Date.now）
let roundEnd = 0;           // NEXT_ROUND 进入时间
let conflictRetry = 0;      // 结算冲突重试计数
let inputReady = false;     // input.init 防重复注册
let watchStarted = false;   // watchRoom 防重复开启

// =====================================================================
//  一次性初始化（不再包含入房逻辑）
// =====================================================================
function init() {
  // ---- 1. 系统信息 + 画布（物理像素 = 逻辑像素 × dpr）----
  const sys = wx.getSystemInfoSync() || {};
  const windowWidth = sys.windowWidth || 375;
  const windowHeight = sys.windowHeight || 667;
  const dpr = sys.pixelRatio || 2;

  const canvas = wx.createCanvas();
  canvas.width = windowWidth * dpr;
  canvas.height = windowHeight * dpr;
  ctx = canvas.getContext('2d');

  config.setScreen({ width: windowWidth, height: windowHeight, dpr });
  render.initRenderer(ctx, { width: canvas.width, height: canvas.height });

  // ---- 2. 手势模块 ----
  if (!inputReady) {
    input.init();
    input.setSwipeHandler(onSwipe);
    inputReady = true;
  }

  // ---- 3. 大厅提示（未入房）----
  session.waitingPrompt = '匹配中，寻找对手…';

  // ---- 4. 启动主循环 ----
  mainLoop.start(frame);
}

// =====================================================================
//  入房（matchManager 匹配成功后调用）
// =====================================================================
function joinGame({ roomId, playerId, role }) {
  if (!roomId || !playerId) {
    session.waitingPrompt = '入房参数缺失';
    return;
  }
  session.roomId = roomId;
  session.playerId = playerId;
  session.mySide = role === 'B' ? 'B' : 'A';
  session.roundSubmitted = false;
  session.waitingPrompt = '房间加载中…';

  cloud
    .getRoom(roomId)
    .then((resp) => {
      if (cloud.isSuccess(resp) && resp.data && resp.data.room) {
        const room = resp.data.room;
        session.roundIndex = room.roundIndex || 0;
        session.roundShooter = room.roundShooter || 'A';
        session.score = room.score || { A: 0, B: 0 };
        // 若房间已有一笔结算，补足已播放游标，避免重放
        if (room.lastResult && room.lastResult.settledRound != null) {
          session.lastPlayedRound = room.lastResult.settledRound;
        }
        startWatch();
        session.waitingPrompt = '';
      } else {
        session.waitingPrompt = '房间加载失败';
      }
    })
    .catch((err) => {
      console.error('[bootstrap] getRoom failed', err);
      session.waitingPrompt = '房间加载失败';
    });
}

/** 设置大厅/提示文案（matchManager 使用） */
function setHint(text) {
  session.waitingPrompt = text || '';
}

// =====================================================================
//  划屏 → 提交
// =====================================================================
async function onSwipe(swipe) {
  if (!session.roomId || !session.playerId) {
    session.waitingPrompt = '未加入房间';
    return;
  }
  if (session.roundSubmitted) {
    // 本轮已提交，等待对方
    session.waitingPrompt = '已提交，等待对方划屏…';
    return;
  }
  if (!stateMachine.canAcceptSwipe()) return;

  stateMachine.to(State.SUBMITTING);
  session.waitingPrompt = '提交中…';
  conflictRetry = 0;

  await doSubmit(swipe);
}

async function doSubmit(swipe) {
  const resp = await cloud.submitSwipeData({
    roomId: session.roomId,
    playerId: session.playerId,
    roundIndex: session.roundIndex,
    swipeData: swipe,
  });
  handleSubmitResp(resp, swipe);
}

/**
 * 处理提交响应（按错误类别分支）。
 */
function handleSubmitResp(resp, swipe) {
  const kind = cloud.classifyError(resp.code);

  switch (kind) {
    case ErrorKind.OK: {
      const data = resp.data || {};
      if (data.settled) {
        // 我方触发了本轮结算（roundIndex 已 +1，settledRound = roundIndex - 1）
        session.roundSubmitted = false;
        session.roundIndex = data.roundIndex;
        if (data.roundShooter) session.roundShooter = data.roundShooter;
        if (data.score) session.score = data.score;
        // 防止 watch 与提交响应同时触发导致重复播放
        const settledRound = data.roundIndex - 1;
        if (settledRound > session.lastPlayedRound) {
          startAnimation(data.result, settledRound);
        }
      } else {
        // 已写入动作，等待对方
        session.roundSubmitted = true;
        stateMachine.to(State.IDLE);
        session.waitingPrompt = '已提交，等待对方划屏…';
      }
      break;
    }
    case ErrorKind.ALREADY_SUBMITTED: {
      // 幂等：保持等待
      session.roundSubmitted = true;
      stateMachine.to(State.IDLE);
      session.waitingPrompt = '已提交，等待对方划屏…';
      break;
    }
    case ErrorKind.STALE_ROUND: {
      const detail = resp.detail || {};
      stateMachine.to(State.IDLE);
      if (
        detail.lastResult &&
        detail.lastResult.settledRound != null &&
        detail.lastResult.settledRound > session.lastPlayedRound
      ) {
        // 已结算过，补放动画
        startAnimation(detail.lastResult, detail.lastResult.settledRound);
      } else {
        if (detail.serverRoundIndex != null) session.roundIndex = detail.serverRoundIndex;
        session.waitingPrompt = '回合已更新，请重新划屏';
      }
      break;
    }
    case ErrorKind.CONFLICT: {
      if (conflictRetry < CONFLICT_MAX_RETRY) {
        conflictRetry++;
        setTimeout(() => doSubmit(swipe), 200);
        return;
      }
      stateMachine.to(State.IDLE);
      session.waitingPrompt = '结算冲突，请重试';
      break;
    }
    case ErrorKind.ROOM_NOT_FOUND:
      stateMachine.to(State.IDLE);
      session.waitingPrompt = '房间不存在';
      break;
    case ErrorKind.NOT_IN_ROOM:
      stateMachine.to(State.IDLE);
      session.waitingPrompt = '你不在该房间';
      break;
    case ErrorKind.ROOM_NOT_PLAYING:
      stateMachine.to(State.IDLE);
      session.waitingPrompt = '房间未开局';
      break;
    case ErrorKind.NETWORK:
      stateMachine.to(State.IDLE);
      session.waitingPrompt = '网络异常，请重试';
      break;
    default:
      stateMachine.to(State.IDLE);
      session.waitingPrompt = resp.msg || '出错了，请重试';
      break;
  }
}

// =====================================================================
//  实时监听（被动接收结算 + 同步 roundShooter/score）
// =====================================================================
function startWatch() {
  if (watchStarted || !session.roomId) return;
  watchStarted = true;

  cloud.watchRoom(
    session.roomId,
    (room) => {
      if (room.roundIndex != null) session.roundIndex = room.roundIndex;
      if (room.roundShooter) session.roundShooter = room.roundShooter;
      if (room.score) session.score = room.score;

      const lr = room.lastResult;
      const settledRound = lr && lr.settledRound;
      if (settledRound != null && settledRound > session.lastPlayedRound) {
        const st = stateMachine.getState();
        // 当前不在动画中才触发（已在动画中的结果由提交响应处理）
        if (st !== State.ANIMATING && st !== State.NEXT_ROUND) {
          session.roundSubmitted = false;
          startAnimation(lr, settledRound);
        }
      }
    },
    (err) => {
      console.error('[bootstrap] watch error', err);
      // 监听失败不影响主流程，等待用户重新触发提交
    },
  );
}

// =====================================================================
//  动画触发
// =====================================================================
function startAnimation(result, settledRound) {
  currentTimeline = animator.buildTimeline(result);
  pose = {};
  animStart = Date.now();
  if (settledRound != null) session.lastPlayedRound = settledRound;
  session.waitingPrompt = '';
  stateMachine.to(State.ANIMATING);
}

// =====================================================================
//  主循环帧函数
// =====================================================================
function frame() {
  // 1. 清屏 + 场景
  render.beginFrame();
  render.drawPitch();
  render.drawGoal();

  const st = stateMachine.getState();
  render.drawStatusBar({ roundIndex: session.roundIndex, hint: buildHint() });

  // 2. 动画中：推进时间轴并绘制
  if (st === State.ANIMATING && currentTimeline) {
    const elapsed = Date.now() - animStart;
    animator.tick(currentTimeline, elapsed, pose);

    render.drawKeeper(pose.keeper);
    render.drawBall(pose.ball);
    render.drawFx(pose.fx);
    render.drawBanner(currentTimeline.banner, animator.clamp(elapsed / currentTimeline.total, 0, 1));

    if (pose.done) {
      stateMachine.to(State.NEXT_ROUND);
      roundEnd = Date.now();
    }
  } else if (st === State.NEXT_ROUND && currentTimeline) {
    // NEXT_ROUND：保持动画末态 + 结算横幅
    const elapsed = Math.max(Date.now() - animStart, currentTimeline.total);
    animator.tick(currentTimeline, elapsed, pose);
    render.drawKeeper(pose.keeper);
    render.drawBall(pose.ball);
    render.drawFx([]);
    render.drawBanner(currentTimeline.banner, 1);
  } else {
    // 静止场景：门将初始站位 + 球在点球点
    render.drawKeeper(null);
    render.drawBall({ x: config.BALL_START.x, y: config.BALL_START.y, scale: 1, rotation: 0 });
  }

  // 3. NEXT_ROUND：停留展示后回到 IDLE
  if (st === State.NEXT_ROUND && Date.now() - roundEnd > NEXT_ROUND_HOLD) {
    session.roundSubmitted = false;
    session.waitingPrompt = '';
    stateMachine.to(State.IDLE);
  }
}

/**
 * 状态栏提示合成：未入房/大厅提示优先；已入房则「比分 · 划屏指引」。
 */
function buildHint() {
  if (session.waitingPrompt) return session.waitingPrompt;
  if (!session.roomId) return '未加入房间';
  const sc = session.score || { A: 0, B: 0 };
  return `${sc.A}:${sc.B} · ${baseHint()}`;
}

/** 按本回合攻守角色给出划屏指引（轮流射门，roundShooter 为准） */
function baseHint() {
  const shooterIsA = (session.roundShooter || 'A') === 'A';
  const iAmShooter = session.mySide === 'A' ? shooterIsA : !shooterIsA;
  return iAmShooter ? '请划屏射门' : '请划屏扑救';
}

module.exports = {
  init,
  joinGame,
  setHint,
  getSession: () => session,
};