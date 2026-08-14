/**
 * =====================================================================
 *  全局配置模块（config.js）
 * =====================================================================
 *  集中管理：设计分辨率、布局坐标、动画/逻辑参数映射、错误码。
 *  所有坐标均基于 750x1334 设计空间，运行时由 input.js 将屏幕坐标归一化换算。
 *  本模块为纯数据，无业务副作用，供 core/net/render 等模块共享。
 * =====================================================================
 */

// ---- 设计分辨率（竖屏）----
const DESIGN_W = 750;
const DESIGN_H = 1334;

// ---- 有效滑屏最小距离（设计空间 px），与后端 MIN_DIST=10 对齐 ----
const MIN_DIST = 10;

// ---- 方向离散化阈值（与后端 LANE_THRESHOLD=0.3 对齐，供本地预览使用）----
const LANE_THRESHOLD = 0.3;

// ---- 方向枚举（与后端 ShotLane 字符串值一致）----
const ShotLane = Object.freeze({
  LEFT: 'LEFT',
  CENTER: 'CENTER',
  RIGHT: 'RIGHT',
});

// ---- 屏幕信息（运行时由 input.init 注入，全局共享）----
const SCREEN = { width: 0, height: 0, dpr: 1 };

/** 注入屏幕信息（bootstrap/input 初始化时调用） */
function setScreen(info) {
  if (!info) return;
  SCREEN.width = info.width || SCREEN.width;
  SCREEN.height = info.height || SCREEN.height;
  SCREEN.dpr = info.dpr || SCREEN.dpr;
}

// =====================================================================
//  布局坐标（设计空间 750x1334）
// =====================================================================
// 球门框：left/right 为门柱 x，top 为上横梁 y，lineY 为门线 y
const GOAL = { left: 150, right: 600, top: 140, lineY: 340 };
// 三路落点 x（球穿越门线 / 门将扑救到达位置）
const LANE_X = { LEFT: 250, CENTER: 375, RIGHT: 500 };
// 门将初始站位
const KEEPER_START = { x: 375, y: 320 };
// 足球起始位置（点球点）
const BALL_START = { x: 375, y: 1050 };
// 顶部状态栏高度
const STATUS_BAR_H = 90;

// 配色
const COLORS = {
  pitch: '#3a9d4b',   // 草地
  mow: '#2f8640',     // 草皮条纹
  line: '#ffffff',    // 白线 / 球门
  ball: '#111111',    // 足球
  keeper: '#f5a623',  // 门将球衣
  text: '#ffffff',    // 状态栏文字
  shadow: 'rgba(0,0,0,0.25)',
};

// =====================================================================
//  射门动画参数（按 shooterTier）
//  duration: 飞行总时长(ms)
//  arc     : 弧高抬升比例（相对射门纵向位移），越大弧度越高
//  speedProfile: 缓动类型（linear / easeInQuad / easeOutQuad）
//  scale   : 球体缩放
// =====================================================================
const SHOT_PARAMS = {
  SOFT: { duration: 1400, arc: 0.55, speedProfile: 'easeInQuad', scale: 1.0 },
  STANDARD: { duration: 800, arc: 0.35, speedProfile: 'easeOutQuad', scale: 1.0 },
  POWER: { duration: 420, arc: 0.15, speedProfile: 'linear', scale: 1.15 },
};

// =====================================================================
//  扑救动画参数（按 keeperTier）
//  duration: 扑救总时长(ms)
//  jump    : 起跳高度(px)
//  reach   : 横向可达距离（占门宽比例）
//  overshoot: 超过落点后的过冲比例（"飞太早扑空"用）
//  facebrake: 是否触发脸刹（爆表滑倒）
// =====================================================================
const DIVE_PARAMS = {
  SOFT: { duration: 650, jump: 40, reach: 0.15, overshoot: 0, facebrake: false },
  STANDARD: { duration: 500, jump: 120, reach: 0.5, overshoot: 0, facebrake: false },
  HARD: { duration: 360, jump: 160, reach: 1.0, overshoot: 0.25, facebrake: false },
  OVERKILL: { duration: 900, jump: 0, reach: 0, overshoot: 0, facebrake: true },
};

// =====================================================================
//  结果码 → 动画预设（供 animator 消费）
//  ball.end   : 'goal'(入网) | 'keeper'(被扑/没收) | 'stay'(原地/脱脚) | 'space'(飞向太空)
//  ball.tier  : 引用 SHOT_PARAMS 的档位（球速/弧度）
//  ball.slow  : 是否慢速滚入（脸刹场景）
//  keeper.tier: 引用 DIVE_PARAMS 的档位
//  keeper.overshoot / keeper.wrongDir: 门将"飞太早"或"扑错方向"
//  fx         : 特效列表（shoe 鞋飞 / star 星星 / bubble 气泡文字 / speedline 速度线）
//  —— 球与门将的左右方向由结算结果 result.shooterLane / result.keeperLane 决定
// =====================================================================
const RESULT_ANIM = {
  GOAL_SPOON: {
    ball: { tier: 'SOFT', end: 'goal' },
    keeper: { tier: 'HARD', overshoot: true },
    fx: [{ kind: 'bubble', text: '慢~' }],
  },
  GOAL_CANNON: {
    ball: { tier: 'POWER', end: 'goal' },
    keeper: { tier: 'SOFT' },
    fx: [{ kind: 'speedline' }],
  },
  GOAL_CLEAN: {
    ball: { tier: 'STANDARD', end: 'goal' },
    keeper: { tier: 'SOFT' },
    fx: [],
  },
  GOAL_FACEBRAKE: {
    ball: { tier: 'STANDARD', end: 'goal', slow: true },
    keeper: { tier: 'OVERKILL' },
    fx: [{ kind: 'star' }],
  },
  GOAL_MISDIRECT: {
    ball: { tier: 'STANDARD', end: 'goal' },
    keeper: { tier: 'STANDARD', wrongDir: true },
    fx: [{ kind: 'bubble', text: '?' }],
  },
  GOAL_MISDIRECT_SPOON: {
    ball: { tier: 'SOFT', end: 'goal' },
    keeper: { tier: 'STANDARD', wrongDir: true },
    fx: [{ kind: 'bubble', text: '?' }],
  },
  GOAL_MISDIRECT_CANNON: {
    ball: { tier: 'POWER', end: 'goal' },
    keeper: { tier: 'STANDARD', wrongDir: true },
    fx: [{ kind: 'speedline' }, { kind: 'bubble', text: '?' }],
  },
  SAVE_CATCH: {
    ball: { tier: 'SOFT', end: 'keeper' },
    keeper: { tier: 'SOFT' },
    fx: [{ kind: 'bubble', text: '嘿嘿' }],
  },
  SAVE_CLEAN: {
    ball: { tier: 'STANDARD', end: 'keeper' },
    keeper: { tier: 'STANDARD' },
    fx: [],
  },
  SAVE_FLYING: {
    ball: { tier: 'POWER', end: 'keeper' },
    keeper: { tier: 'HARD' },
    fx: [{ kind: 'star' }],
  },
  MISS_SHOE_FLOWN: {
    ball: { tier: 'SOFT', end: 'stay' },
    keeper: { tier: 'STANDARD' },
    fx: [{ kind: 'shoe' }],
  },
  MISS_TO_SPACE: {
    ball: { tier: 'POWER', end: 'space' },
    keeper: { tier: 'STANDARD' },
    fx: [{ kind: 'star' }],
  },
};

// =====================================================================
//  结算弹窗 / 大厅 UI 布局（设计空间 750x1334）
// =====================================================================
const SETTLEMENT = {
  dialog: { x: 95, y: 300, w: 560, h: 540 },
  bannerY: 400,                                   // 胜负 Banner 文案 y
  scoreY: 470,                                    // 大比分 y
  btnRematch: { x: 225, y: 660, w: 300, h: 88 },  // 再来一局
  btnHome: { x: 225, y: 772, w: 300, h: 88 },     // 返回主页
};

const LOBBY = {
  title: '1v1 点球大战',
  titleY: 400,
  subtitle: '实时对战 · 盲盒点球',
  subtitleY: 490,
  btnStart: { x: 225, y: 900, w: 300, h: 100 },   // 创建房间
};

// 房间等待态（建房/入房成功 → 开局前）
const ROOM = {
  title: '房间已就绪',
  titleY: 700,
  hintY: 790,                                      // 等待提示文案 y
  btnStart: { x: 225, y: 900, w: 300, h: 100 },   // 开始比赛（仅房主）
};

// =====================================================================
//  错误码（与后端 ErrCode 对齐，NETWORK 为本地新增）
// =====================================================================
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
  NETWORK: -1, // 本地调用失败（非后端返回）
});

// 错误码 → 用户提示文案
const ERROR_MSG = Object.freeze({
  [ErrCode.INVALID_PARAMS]: '参数错误，请重试',
  [ErrCode.PLAYER_NOT_IN_ROOM]: '你不在该房间',
  [ErrCode.STALE_ROUND]: '回合已更新',
  [ErrCode.ALREADY_SUBMITTED]: '已提交，等待对方…',
  [ErrCode.ROOM_NOT_PLAYING]: '房间未开局',
  [ErrCode.ROOM_NOT_FOUND]: '房间不存在',
  [ErrCode.SETTLE_CONFLICT]: '结算冲突，请重试',
  [ErrCode.DB_ERROR]: '服务繁忙，请稍后再试',
  [ErrCode.INTERNAL]: '服务器开小差了',
  [ErrCode.NETWORK]: '网络异常，请检查网络',
});

module.exports = {
  DESIGN_W,
  DESIGN_H,
  MIN_DIST,
  LANE_THRESHOLD,
  ShotLane,
  SCREEN,
  setScreen,
  GOAL,
  LANE_X,
  KEEPER_START,
  BALL_START,
  STATUS_BAR_H,
  COLORS,
  SHOT_PARAMS,
  DIVE_PARAMS,
  RESULT_ANIM,
  SETTLEMENT,
  LOBBY,
  ROOM,
  ErrCode,
  ERROR_MSG,
};