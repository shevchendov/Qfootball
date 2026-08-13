/**
 * =====================================================================
 *  动画引擎（core/animator.js）
 * =====================================================================
 *  职责：
 *    1. 提供二次贝塞尔曲线 bezier2 与缓动函数 ease。
 *    2. buildTimeline(result)：根据后端 RoundResult
 *       （含 code / shooterLane / keeperLane / shooterTier / keeperTier）
 *       查 RESULT_ANIM 预设，生成球/门将/特效的轨道时间线。
 *    3. tick(timeline, elapsedMs, pose)：推进时间轴，实时更新
 *       ball / keeper / fx 的 位置、缩放、旋转。
 *
 *  确定性约定：所有动画参数由 result 查表得出，不使用随机数，
 *  保证双端播放完全一致。
 * =====================================================================
 */
const config = require('../config/config');

const {
  BALL_START,
  KEEPER_START,
  GOAL,
  LANE_X,
  SHOT_PARAMS,
  DIVE_PARAMS,
  RESULT_ANIM,
} = config;

/** 数值钳制 */
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/** 线性插值 */
function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * 二次贝塞尔曲线。
 * @param {{x:number,y:number}} p0 起点
 * @param {{x:number,y:number}} c  控制点
 * @param {{x:number,y:number}} p1 终点
 * @param {number} t 参数 0..1
 */
function bezier2(p0, c, p1, t) {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x,
    y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y,
  };
}

/**
 * 缓动函数。
 * 支持的 kind：
 *   linear / easeInQuad / easeOutQuad / easeInOutQuad / easeOutBack（带过冲）
 */
function ease(kind, t) {
  const x = clamp(t, 0, 1);
  switch (kind) {
    case 'easeInQuad':
      return x * x;
    case 'easeOutQuad':
      return 1 - (1 - x) * (1 - x);
    case 'easeInOutQuad':
      return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
    case 'easeOutBack': {
      const c1 = 1.70158;
      const c3 = c1 + 1;
      return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
    }
    case 'linear':
    default:
      return x;
  }
}

/**
 * 根据结算结果构建时间线。
 * @param {object} result 后端结算结果（含 code/shooterLane/keeperLane/shooterTier/keeperTier/description）
 * @returns {{total:number, ball:object, keeper:object, fx:object[], banner:string}}
 */
function buildTimeline(result) {
  const preset =
    RESULT_ANIM[result.code] ||
    { ball: { tier: 'STANDARD', end: 'goal' }, keeper: { tier: 'STANDARD' }, fx: [] };

  const shot = SHOT_PARAMS[preset.ball.tier] || SHOT_PARAMS.STANDARD;
  const dive = DIVE_PARAMS[preset.keeper.tier] || DIVE_PARAMS.STANDARD;

  // ---- 球轨道 ----
  const ballFrom = { x: BALL_START.x, y: BALL_START.y };
  const shooterLane = LANE_X[result.shooterLane] != null ? LANE_X[result.shooterLane] : LANE_X.CENTER;
  const keeperLaneX = LANE_X[result.keeperLane] != null ? LANE_X[result.keeperLane] : LANE_X.CENTER;

  let ballTo;
  let ballDuration = shot.duration;
  let ballEasing = shot.speedProfile;
  let ballScale = [shot.scale, shot.scale];
  let ballLift = 0;

  switch (preset.ball.end) {
    case 'goal':
      ballTo = { x: shooterLane, y: GOAL.lineY };
      ballLift = shot.arc;
      break;
    case 'keeper':
      // 球飞向门将扑救手位
      ballTo = { x: shooterLane, y: KEEPER_START.y + 40 };
      ballLift = shot.arc * 0.8;
      break;
    case 'stay':
      // 踢飞脱脚：球留在原地小幅弹跳
      ballTo = { x: ballFrom.x + 20, y: ballFrom.y - 30 };
      ballDuration = 350;
      ballEasing = 'easeOutQuad';
      break;
    case 'space':
      // 飞向太空：球直冲屏幕外并缩小
      ballTo = { x: ballFrom.x + 40, y: -180 };
      ballScale = [shot.scale, 0.05];
      ballDuration = 700;
      ballEasing = 'linear';
      break;
    default:
      ballTo = { x: shooterLane, y: GOAL.lineY };
      ballLift = shot.arc;
      break;
  }

  // 脸刹慢速滚入：拉长时长、线性缓动
  if (preset.ball.slow) {
    ballDuration = 1600;
    ballEasing = 'linear';
  }

  const dy = ballFrom.y - ballTo.y;
  const midY = (ballFrom.y + ballTo.y) / 2;
  const ballControl = {
    x: (ballFrom.x + ballTo.x) / 2,
    y: midY - ballLift * dy,
  };

  // ---- 门将轨道 ----
  const keeperFrom = { x: KEEPER_START.x, y: KEEPER_START.y };
  let keeperTo;
  let keeperControl;
  let keeperDuration = dive.duration;
  let keeperEasing = 'easeOutQuad';
  let keeperRot = [0, 0];
  const facebrake = !!dive.facebrake;

  if (facebrake) {
    // 爆表脸刹：前扑滑倒，旋转近 90 度
    keeperTo = { x: keeperFrom.x, y: keeperFrom.y + 210 };
    keeperControl = { x: keeperFrom.x, y: keeperFrom.y - 20 };
    keeperDuration = 900;
    keeperEasing = 'easeOutQuad';
    keeperRot = [0, -1.45];
  } else {
    keeperTo = { x: keeperLaneX, y: GOAL.lineY + 30 };
    keeperControl = {
      x: (keeperFrom.x + keeperTo.x) / 2,
      y: keeperFrom.y - dive.jump,
    };
    if (preset.keeper.overshoot) keeperEasing = 'easeOutBack'; // 飞太早扑空
    const dir = keeperTo.x >= keeperFrom.x ? 1 : -1;
    keeperRot = [0, dir * 0.6];
  }

  // ---- 特效轨道 ----
  const fx = (preset.fx || [])
    .map((f) => buildFxTrack(f, ballTo, keeperTo, ballDuration, keeperDuration))
    .filter(Boolean);

  // ---- 总时长 = 各轨道最大完成时间 ----
  const fxMax = fx.reduce((m, f) => Math.max(m, f.delay + f.duration), 0);
  const total = Math.max(ballDuration, keeperDuration, fxMax);

  return {
    code: result.code,
    banner: result.description || '',
    total,
    ball: {
      from: ballFrom,
      to: ballTo,
      control: ballControl,
      duration: ballDuration,
      delay: 0,
      easing: ballEasing,
      scale: ballScale,
      rotation: 720, // 旋转总角度（度）
    },
    keeper: {
      from: keeperFrom,
      to: keeperTo,
      control: keeperControl,
      duration: keeperDuration,
      delay: 0,
      easing: keeperEasing,
      rotation: keeperRot,
      facebrake,
    },
    fx,
  };
}

/**
 * 构造单个特效轨道（提供 from/to/control 供 tick 用贝塞尔推进）。
 */
function buildFxTrack(f, ballTo, keeperTo, ballDuration, keeperDuration) {
  switch (f.kind) {
    case 'bubble':
      return {
        kind: 'bubble',
        text: f.text || '',
        from: { x: ballTo.x, y: ballTo.y - 40 },
        to: { x: ballTo.x, y: ballTo.y - 180 },
        control: { x: ballTo.x, y: (ballTo.y - 40 + ballTo.y - 180) / 2 - 30 },
        duration: 1300,
        delay: ballDuration * 0.5,
      };
    case 'star':
      return {
        kind: 'star',
        from: { x: keeperTo.x, y: keeperTo.y - 60 },
        to: { x: keeperTo.x + 24, y: keeperTo.y - 150 },
        control: { x: keeperTo.x, y: keeperTo.y - 110 },
        duration: 900,
        delay: keeperDuration * 0.5,
      };
    case 'speedline':
      // 速度线无独立移动，直接跟随球当前位置（kind 由 tick 特判）
      return {
        kind: 'speedline',
        duration: ballDuration,
        delay: 0,
      };
    case 'shoe':
      return {
        kind: 'shoe',
        from: { x: 355, y: 500 },
        to: { x: keeperTo.x, y: 290 },
        control: { x: 330, y: 380 },
        duration: 850,
        delay: 0,
      };
    default:
      return null;
  }
}

/**
 * 推进时间轴：按 elapsedMs 更新 pose。
 * @param {object} tl   buildTimeline 返回值
 * @param {number} elapsedMs 自动画开始的毫秒数
 * @param {object} pose 输出对象（ball/keeper/fx/done）
 */
function tick(tl, elapsedMs, pose) {
  const t = clamp(elapsedMs, 0, tl.total);
  pose.done = elapsedMs >= tl.total;

  // ---- 球 ----
  const tb = clamp((t - tl.ball.delay) / tl.ball.duration, 0, 1);
  const eb = ease(tl.ball.easing, tb);
  const bPos = bezier2(tl.ball.from, tl.ball.control, tl.ball.to, eb);
  pose.ball = {
    x: bPos.x,
    y: bPos.y,
    scale: lerp(tl.ball.scale[0], tl.ball.scale[1], eb),
    rotation: (tb * tl.ball.rotation * Math.PI) / 180,
  };

  // ---- 门将 ----
  const tk = clamp((t - tl.keeper.delay) / tl.keeper.duration, 0, 1);
  const ek = ease(tl.keeper.easing, tk);
  const kPos = bezier2(tl.keeper.from, tl.keeper.control, tl.keeper.to, ek);
  pose.keeper = {
    x: kPos.x,
    y: kPos.y,
    rotation: lerp(tl.keeper.rotation[0], tl.keeper.rotation[1], ek),
    facebrake: tl.keeper.facebrake,
  };

  // ---- 特效 ----
  pose.fx = tl.fx
    .map((f) => {
      const tf = clamp((t - f.delay) / f.duration, 0, 1);
      if (tf >= 1) return null;
      switch (f.kind) {
        case 'speedline': {
          const ang = Math.atan2(bPos.y - tl.ball.from.y, bPos.x - tl.ball.from.x);
          return {
            kind: 'speedline',
            x: bPos.x,
            y: bPos.y,
            angle: ang,
            alpha: 0.6 * (1 - tb),
            len: 70,
          };
        }
        case 'shoe': {
          const es = ease('easeOutQuad', tf);
          const sPos = bezier2(f.from, f.control, f.to, es);
          return {
            kind: 'shoe',
            x: sPos.x,
            y: sPos.y,
            rotation: tf * 4,
            alpha: 1,
          };
        }
        default: {
          const e = ease('easeOutQuad', tf);
          const pos = bezier2(f.from, f.control, f.to, e);
          const alpha = tf < 0.1 ? tf / 0.1 : tf > 0.8 ? (1 - tf) / 0.2 : 1;
          return {
            kind: f.kind,
            text: f.text,
            x: pos.x,
            y: pos.y,
            scale: 0.6 + 0.4 * (1 - tf),
            rot: tf * 3,
            alpha,
          };
        }
      }
    })
    .filter(Boolean);
}

module.exports = {
  clamp,
  lerp,
  bezier2,
  ease,
  buildTimeline,
  tick,
};