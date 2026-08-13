/**
 * =====================================================================
 *  核心调度与组装（core/bootstrap.js）
 * =====================================================================
 *  职责：
 *    1. 一次性初始化：主画布、dpr 缩放、渲染器、手势模块（滑屏 + 点按）、主循环。
 *    2. 大厅态：未入局时绘制大厅与「开始比赛」按钮，点按触发匹配。
 *    3. joinGame()：入房成功后拉取房间并开启 watchRoom（重连/再来一局可复用）。
 *    4. 对局态：划屏 → 云函数 → 动画；动画播完按 gameState 切 NEXT_ROUND 或 FINISHED。
 *    5. FINISHED 态：绘制结算弹窗，AABB 命中「再来一局 / 返回主页」。
 *
 *  状态流转：
 *    大厅(IDLE) ─开始比赛─> 匹配 ─入房─> IDLE ─划屏─> SUBMITTING ─结算─> ANIMATING
 *       ─gameState PLAYING─> NEXT_ROUND ─停留─> IDLE
 *       ─gameState FINISHED─> FINISHED ─(再来一局/返回主页)─> 大厅
 *
 *  解耦：本模块不 require matchManager，通过 setUiHandlers 接受入房/重开回调。
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

// ---- 会话状态（房间 / 玩家 / 回合 / 胜负）----
const session = {
  lobby: true,           // 是否处于大厅态（未入局）
  matching: false,       // 是否匹配中（大厅态下隐藏开始按钮）
  roomId: '',
  playerId: '',
  mySide: null,          // 'A' | 'B'：我方所在边（joinGame 传入）
  roundShooter: 'A',     // 本回合射门方（服务端为准，watch/提交响应同步）
  roundIndex: 0,         // 当前回合号（以服务端为准）
  score: { A: 0, B: 0 }, // 比分（服务端为准）
  gameState: 'PLAYING',  // 'PLAYING' | 'FINISHED'
  winner: null,          // 'A' | 'B'（无 DRAW）
  suddenDeath: false,    // 是否加时赛
  lastPlayedRound: -1,   // 已播放动画的最高 settledRound（防重复播放）
  waitingPrompt: '',     // 状态栏提示文案
  roundSubmitted: false, // 本轮是否已提交（防止重复划屏）
};

// ---- 运行期对象 ----
let ctx = null;
let watcher = null;         // watchRoom 句柄
let currentTimeline = null; // 当前动画时间线
let pose = {};              // tick 输出（ball/keeper/fx/done）
let animStart = 0;          // 动画开始时间（Date.now）
let roundEnd = 0;           // NEXT_ROUND 进入时间
let conflictRetry = 0;      // 结算冲突重试计数
let inputReady = false;     // input.init 防重复注册
let watchStarted = false;   // watchRoom 防重复开启

// ---- 大厅/结算按钮回调（由 matchManager 注册）----
const uiHandlers = {
  onStart: null,   // 大厅「开始比赛」
  onRematch: null, // 结算「再来一局」
  onHome: null,    // 结算「返回主页」
};

// =====================================================================
//  一次性初始化
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

  // ---- 2. 手势模块（滑屏 + 点按）----
  if (!inputReady) {
    input.init();
    input.setSwipeHandler(onSwipe);
    input.setTapHandler(onTap);
    inputReady = true;
  }

  // ---- 3. 大厅初始状态 ----
  session.lobby = true;
  session.waitingPrompt = '';

  // ---- 4. 启动主循环 ----
  mainLoop.start(frame);
}

// =====================================================================
//  大厅 / 入房 接口（供 matchManager 调用）
// =====================================================================
/** 注册 UI 回调（大厅开始 / 再来一局 / 返回主页） */
function setUiHandlers(handlers) {
  if (handlers && typeof handlers.onStart === 'function') uiHandlers.onStart = handlers.onStart;
  if (handlers && typeof handlers.onRematch === 'function') uiHandlers.onRematch = handlers.onRematch;
  if (handlers && typeof handlers.onHome === 'function') uiHandlers.onHome = handlers.onHome;
}

/** 设置大厅提示/匹配中状态 */
function setHint(text) {
  session.waitingPrompt = text || '';
}

/** 设置匹配中状态（大厅态隐藏「开始比赛」按钮） */
function setMatching(flag) {
  session.matching = !!flag;
}

/** 回到大厅（清空会话，返回空闲态） */
function showLobby() {
  leaveRoom();
  session.waitingPrompt = '';
}

/**
 * 离开当前对局/清理会话。
 * 关闭 watch、复位 session 与状态机，进入大厅态。
 */
function leaveRoom() {
  if (watcher && typeof watcher.close === 'function') {
    try { watcher.close(); } catch (_e) { /* 忽略 */ }
  }
  watcher = null;
  watchStarted = false;

  session.lobby = true;
  session.matching = false;
  session.roomId = '';
  session.playerId = '';
  session.mySide = null;
  session.roundShooter = 'A';
  session.roundIndex = 0;
  session.score = { A: 0, B: 0 };
  session.gameState = 'PLAYING';
  session.winner = null;
  session.suddenDeath = false;
  session.lastPlayedRound = -1;
  session.roundSubmitted = false;
  session.waitingPrompt = '';

  currentTimeline = null;
  pose = {};
  stateMachine.to(State.IDLE);
}

/**
 * 入房（匹配成功 / 断线重连 / 再来一局后调用）。
 * 可重复调用：会自动复位 watchStarted 并重建监听。
 */
function joinGame({ roomId, playerId, role }) {
  if (!roomId || !playerId) {
    session.waitingPrompt = '入房参数缺失';
    return;
  }

  watchStarted = false; // 允许重连/重开重建监听
  session.lobby = false;
  session.matching = false;
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
        session.suddenDeath = !!room.suddenDeath;
        session.gameState = room.state || 'PLAYING';
        session.winner = room.winner || null;
        // 离开期间已结算的回合不重放动画
        if (room.lastResult && room.lastResult.settledRound != null) {
          session.lastPlayedRound = room.lastResult.settledRound;
        }
        startWatch();
        session.waitingPrompt = '';
        // 防御：房间已是 FINISHED → 直接进结算弹窗态
        if (session.gameState === 'FINISHED') {
          stateMachine.to(State.FINISHED);
        }
      } else {
        session.waitingPrompt = '房间加载失败';
      }
    })
    .catch((err) => {
      console.error('[bootstrap] getRoom failed', err);
      session.waitingPrompt = '房间加载失败';
    });
}

// =====================================================================
//  划屏 → 提交
// =====================================================================
async function onSwipe(swipe) {
  if (session.lobby || !session.roomId || !session.playerId) {
    session.waitingPrompt = session.lobby ? '请点击开始比赛' : '未加入房间';
    return;
  }
  if (session.roundSubmitted) {
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
        // 结算响应中的 game 与 result 分离，需显式同步胜负状态
        if (data.game) {
          session.suddenDeath = !!data.game.suddenDeath;
          session.gameState = data.game.state || 'PLAYING';
          session.winner = data.game.winner || null;
        }
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
//  实时监听（被动接收结算 + 同步 roundShooter/score/胜负）
// =====================================================================
function startWatch() {
  if (watchStarted || !session.roomId) return;
  watchStarted = true;

  watcher = cloud.watchRoom(
    session.roomId,
    (room) => {
      if (room.roundIndex != null) session.roundIndex = room.roundIndex;
      if (room.roundShooter) session.roundShooter = room.roundShooter;
      if (room.score) session.score = room.score;
      if (room.suddenDeath != null) session.suddenDeath = room.suddenDeath;
      if (room.state) session.gameState = room.state;
      if (room.winner) session.winner = room.winner;

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
//  动画触发（含胜负状态同步）
// =====================================================================
function startAnimation(result, settledRound) {
  currentTimeline = animator.buildTimeline(result);
  pose = {};
  animStart = Date.now();
  if (settledRound != null) session.lastPlayedRound = settledRound;
  // 从结算结果同步胜负状态（result.game）
  if (result && result.game) {
    session.suddenDeath = !!result.game.suddenDeath;
    session.gameState = result.game.state || 'PLAYING';
    session.winner = result.game.winner || null;
  }
  session.waitingPrompt = '';
  stateMachine.to(State.ANIMATING);
}

// =====================================================================
//  点按处理（AABB 命中检测）
// =====================================================================
function onTap(p) {
  // 大厅态：命中「开始比赛」
  if (session.lobby) {
    if (!session.matching && uiHandlers.onStart && hitTest(p, config.LOBBY.btnStart)) {
      uiHandlers.onStart();
    }
    return;
  }
  // 结算弹窗态：命中「再来一局 / 返回主页」
  if (stateMachine.getState() === State.FINISHED) {
    if (uiHandlers.onRematch && hitTest(p, config.SETTLEMENT.btnRematch)) {
      uiHandlers.onRematch();
    } else if (uiHandlers.onHome && hitTest(p, config.SETTLEMENT.btnHome)) {
      uiHandlers.onHome();
    }
  }
}

/** AABB 碰撞检测：点是否落在矩形内 */
function hitTest(p, rect) {
  return (
    p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h
  );
}

// =====================================================================
//  主循环帧函数
// =====================================================================
function frame() {
  render.beginFrame();
  render.drawPitch();
  render.drawGoal();

  const st = stateMachine.getState();

  // ---- 大厅态 ----
  if (session.lobby) {
    render.drawStatusBar({ roundIndex: '-', hint: session.waitingPrompt || '大厅' });
    render.drawLobby({ matching: session.matching });
    return;
  }

  render.drawStatusBar({ roundIndex: session.roundIndex, hint: buildHint() });

  // ---- 结算弹窗态 ----
  if (st === State.FINISHED) {
    render.drawKeeper(null);
    render.drawBall({ x: config.BALL_START.x, y: config.BALL_START.y, scale: 1, rotation: 0 });
    render.drawSettlement({
      winner: session.winner,
      mySide: session.mySide,
      score: session.score,
    });
    return;
  }

  // ---- 动画中 ----
  if (st === State.ANIMATING && currentTimeline) {
    const elapsed = Date.now() - animStart;
    animator.tick(currentTimeline, elapsed, pose);

    render.drawKeeper(pose.keeper);
    render.drawBall(pose.ball);
    render.drawFx(pose.fx);
    render.drawBanner(currentTimeline.banner, animator.clamp(elapsed / currentTimeline.total, 0, 1));

    if (pose.done) {
      // 动画播完：按胜负状态决定进入 FINISHED 或 NEXT_ROUND
      if (session.gameState === 'FINISHED') {
        stateMachine.to(State.FINISHED);
      } else {
        stateMachine.to(State.NEXT_ROUND);
        roundEnd = Date.now();
      }
    }
  } else if (st === State.NEXT_ROUND && currentTimeline) {
    // NEXT_ROUND：保持动画末态 + 结算横幅
    const elapsed = Math.max(Date.now() - animStart, currentTimeline.total);
    animator.tick(currentTimeline, elapsed, pose);
    render.drawKeeper(pose.keeper);
    render.drawBall(pose.ball);
    render.drawFx([]);
    render.drawBanner(currentTimeline.banner, 1);

    if (Date.now() - roundEnd > NEXT_ROUND_HOLD) {
      // watch 延迟到达 FINISHED 时直接进弹窗态
      if (session.gameState === 'FINISHED') {
        stateMachine.to(State.FINISHED);
      } else {
        session.roundSubmitted = false;
        session.waitingPrompt = '';
        stateMachine.to(State.IDLE);
      }
    }
  } else {
    // 静止场景：门将初始站位 + 球在点球点
    render.drawKeeper(null);
    render.drawBall({ x: config.BALL_START.x, y: config.BALL_START.y, scale: 1, rotation: 0 });
  }
}

/**
 * 状态栏提示合成：大厅/提示优先；对局中「比分 · 划屏指引」。
 */
function buildHint() {
  if (session.waitingPrompt) return session.waitingPrompt;
  if (session.lobby || !session.roomId) return '大厅';
  const sc = session.score || { A: 0, B: 0 };
  const suffix = session.suddenDeath ? ' · 加时赛' : '';
  return `${sc.A}:${sc.B}${suffix} · ${baseHint()}`;
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
  showLobby,
  leaveRoom,
  setHint,
  setMatching,
  setUiHandlers,
  getSession: () => session,
};