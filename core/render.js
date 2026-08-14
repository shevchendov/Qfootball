/**
 * =====================================================================
 *  Canvas 绘制模块（core/render.js）
 * =====================================================================
 *  基于 750x1334 设计坐标系绘制全部场景元素。
 *  屏幕 dpr 缩放由 initSystem()/initRender() 计算，scaleX/scaleY 由此得出，
 *  initRenderer 据此计算 设计空间 → 画布 的缩放，beginFrame 每帧重置变换。
 *
 *  时序安全（SOP 2.1）：
 *    - 本模块全局作用域不调用任何 wx.* API；
 *    - wx.getSystemInfoSync() 仅在 initSystem() 函数内执行（含 try/catch 兜底），
 *      由 game.js 在 JSBridge 就绪后按顺序触发，杜绝 scaleX/scaleY=NaN；
 *    - scaleX/scaleY 通过 getScale() 导出，供 input 等模块做坐标映射。
 *
 *  所有绘制函数均以「设计坐标」为参数，内部负责具体图形。
 * =====================================================================
 */
const config = require('../config/config');

const {
  DESIGN_W,
  DESIGN_H,
  GOAL,
  KEEPER_START,
  BALL_START,
  STATUS_BAR_H,
  COLORS,
  SETTLEMENT,
  LOBBY,
  ROOM,
} = config;

// 兜底屏幕参数（wx.getSystemInfoSync 异常时使用，保证 scaleX/scaleY 永不为 NaN）
const FALLBACK_W = 375;
const FALLBACK_H = 667;
const FALLBACK_DPR = 2;

let ctx = null;        // 2D 上下文
let scaleX = 1;        // 设计空间 → 画布 横向缩放
let scaleY = 1;        // 设计空间 → 画布 纵向缩放
let systemInfo = null; // 系统信息缓存

/**
 * 初始化系统信息与缩放比例。
 * 计算物理画布尺寸（逻辑像素 × dpr）与 设计空间 → 画布 的 scaleX/scaleY。
 * 所有 wx.* 调用均收敛到此函数内（含兜底），可安全在游戏入口后调用。
 * @returns {{windowWidth:number, windowHeight:number, dpr:number,
 *            canvasWidth:number, canvasHeight:number, scaleX:number, scaleY:number}}
 */
function initSystem() {
  let sys = null;
  try {
    sys = wx.getSystemInfoSync() || {};
  } catch (err) {
    console.warn('[render] wx.getSystemInfoSync failed, use fallback 375x667', err);
    sys = {};
  }

  const windowWidth = sys.windowWidth || FALLBACK_W;
  const windowHeight = sys.windowHeight || FALLBACK_H;
  const dpr = sys.pixelRatio || FALLBACK_DPR;
  const canvasWidth = Math.round(windowWidth * dpr);
  const canvasHeight = Math.round(windowHeight * dpr);

  scaleX = canvasWidth / DESIGN_W;
  scaleY = canvasHeight / DESIGN_H;
  systemInfo = {
    windowWidth,
    windowHeight,
    dpr,
    canvasWidth,
    canvasHeight,
    scaleX,
    scaleY,
  };

  config.setScreen({ width: windowWidth, height: windowHeight, dpr });
  return systemInfo;
}

/**
 * 初始化渲染器（画布版）：设置画布物理尺寸并绑定 2D 上下文。
 * @param {HTMLCanvasElement} canvas wx.createCanvas() 创建的画布
 * @returns {CanvasRenderingContext2D|null}
 */
function initRender(canvas) {
  if (!canvas) return null;
  const system = initSystem();
  canvas.width = system.canvasWidth;
  canvas.height = system.canvasHeight;
  const canvasCtx = canvas.getContext('2d');
  initRenderer(canvasCtx, { width: canvas.width, height: canvas.height });
  return canvasCtx;
}

/**
 * 初始化渲染器（上下文版，兼容旧调用）。
 * @param {CanvasRenderingContext2D} canvasCtx 由 canvas.getContext('2d') 取得
 * @param {{width:number, height:number}} canvasSize 画布物理像素尺寸
 */
function initRenderer(canvasCtx, canvasSize) {
  ctx = canvasCtx;
  if (canvasSize && canvasSize.width && canvasSize.height) {
    scaleX = canvasSize.width / DESIGN_W;
    scaleY = canvasSize.height / DESIGN_H;
  }
}

/** 获取当前缩放比例（供 input 等模块做物理坐标 → 设计坐标映射） */
function getScale() {
  return { scaleX, scaleY };
}

/** 获取系统信息缓存（未初始化时自动初始化） */
function getSystem() {
  return systemInfo || initSystem();
}

/** 每帧开头调用：重置变换到设计坐标并清屏 */
function beginFrame() {
  if (!ctx) return;
  ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
  ctx.clearRect(0, 0, DESIGN_W, DESIGN_H);
}

/** 圆角矩形路径（绘制到当前 path） */
function roundRectPath(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// =====================================================================
//  1. 球场背景
// =====================================================================
function drawPitch() {
  if (!ctx) return;

  // 草地底色
  ctx.fillStyle = COLORS.pitch;
  ctx.fillRect(0, 0, DESIGN_W, DESIGN_H);

  // 深浅相间的草皮条纹
  ctx.fillStyle = COLORS.mow;
  for (let y = 0; y < DESIGN_H; y += 280) {
    ctx.fillRect(0, y, DESIGN_W, 140);
  }

  // 罚球区（大禁区）
  ctx.strokeStyle = COLORS.line;
  ctx.lineWidth = 4;
  ctx.strokeRect(GOAL.left - 90, GOAL.top, GOAL.right - GOAL.left + 180, 360);

  // 球门区（小禁区）
  ctx.lineWidth = 3;
  ctx.strokeRect(GOAL.left - 40, GOAL.top, GOAL.right - GOAL.left + 80, 200);

  // 点球点
  ctx.fillStyle = COLORS.line;
  ctx.beginPath();
  ctx.arc(BALL_START.x, BALL_START.y, 6, 0, Math.PI * 2);
  ctx.fill();
}

// =====================================================================
//  2. 球门（门柱 + 横梁 + 网）
// =====================================================================
function drawGoal() {
  if (!ctx) return;

  // 门柱
  ctx.strokeStyle = COLORS.goal;
  ctx.lineWidth = 8;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(GOAL.left, GOAL.top);
  ctx.lineTo(GOAL.left, GOAL.lineY);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(GOAL.right, GOAL.top);
  ctx.lineTo(GOAL.right, GOAL.lineY);
  ctx.stroke();

  // 横梁
  ctx.beginPath();
  ctx.moveTo(GOAL.left, GOAL.top);
  ctx.lineTo(GOAL.right, GOAL.top);
  ctx.stroke();

  // 门线
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(GOAL.left, GOAL.lineY);
  ctx.lineTo(GOAL.right, GOAL.lineY);
  ctx.stroke();

  // 球网（半透明网格）
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 2;
  for (let x = GOAL.left + 22; x < GOAL.right; x += 30) {
    ctx.beginPath();
    ctx.moveTo(x, GOAL.top);
    ctx.lineTo(x, GOAL.lineY);
    ctx.stroke();
  }
  for (let y = GOAL.top + 24; y < GOAL.lineY; y += 30) {
    ctx.beginPath();
    ctx.moveTo(GOAL.left, y);
    ctx.lineTo(GOAL.right, y);
    ctx.stroke();
  }
}

// =====================================================================
//  3. 门将（简易矢量形象，支持旋转/脸刹姿态）
//  pose: { x, y, rotation, facebrake }，不传则用初始站位
// =====================================================================
function drawKeeper(pose) {
  if (!ctx) return;

  const p = pose || { x: KEEPER_START.x, y: KEEPER_START.y, rotation: 0, facebrake: false };

  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.rotation || 0);

  // 地面阴影
  ctx.fillStyle = COLORS.shadow;
  ctx.beginPath();
  ctx.ellipse(0, 34, 28, 7, 0, 0, Math.PI * 2);
  ctx.fill();

  // 腿
  ctx.strokeStyle = COLORS.keeper;
  ctx.lineWidth = 10;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-8, 18);
  ctx.lineTo(-12, 34);
  ctx.moveTo(8, 18);
  ctx.lineTo(12, 34);
  ctx.stroke();

  // 身体
  ctx.fillStyle = COLORS.keeper;
  roundRectPath(-20, -12, 40, 40, 10);
  ctx.fill();

  // 手臂（张开扑救姿势）
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(-18, -4);
  ctx.lineTo(-34, 8);
  ctx.moveTo(18, -4);
  ctx.lineTo(34, 8);
  ctx.stroke();

  // 手套
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(-34, 8, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(34, 8, 7, 0, Math.PI * 2);
  ctx.fill();

  // 头部
  ctx.fillStyle = '#ffcc99';
  ctx.beginPath();
  ctx.arc(0, -26, 15, 0, Math.PI * 2);
  ctx.fill();

  // 护耳帽（上半圆）
  ctx.fillStyle = COLORS.keeper;
  ctx.beginPath();
  ctx.arc(0, -26, 15, Math.PI, 0);
  ctx.closePath();
  ctx.fill();

  // 眼睛
  ctx.fillStyle = '#222222';
  ctx.beginPath();
  ctx.arc(-5, -23, 2.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(5, -23, 2.6, 0, Math.PI * 2);
  ctx.fill();

  // 嘴
  ctx.strokeStyle = '#222222';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, -17, 5, 0.2 * Math.PI, 0.8 * Math.PI);
  ctx.stroke();

  ctx.restore();
}

// =====================================================================
//  4. 足球（白色球体 + 黑色五边形）
//  pose: { x, y, scale, rotation }，rotation 单位弧度
// =====================================================================
function drawBall(pose) {
  if (!ctx || !pose) return;

  ctx.save();
  ctx.translate(pose.x, pose.y);
  const s = pose.scale || 1;
  ctx.scale(s, s);
  ctx.rotate(pose.rotation || 0);

  // 球体
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(0, 0, 18, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#333333';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, 18, 0, Math.PI * 2);
  ctx.stroke();

  // 黑色五边形
  ctx.fillStyle = '#222222';
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
    const px = Math.cos(a) * 7;
    const py = Math.sin(a) * 7;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

// =====================================================================
//  5. 顶部状态栏
//  info: { roundIndex, hint }
// =====================================================================
function drawStatusBar(info) {
  if (!ctx) return;

  const data = info || {};

  // 半透明底
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(0, 0, DESIGN_W, STATUS_BAR_H);

  // 回合数（左）
  ctx.fillStyle = COLORS.text;
  ctx.font = 'bold 30px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(`回合 ${data.roundIndex}`, 22, STATUS_BAR_H / 2);

  // 提示标语（右）
  ctx.font = '26px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(data.hint || '', DESIGN_W - 22, STATUS_BAR_H / 2);
}

// =====================================================================
//  6. 中央提示（大字号，带半透明底）
// =====================================================================
function drawHint(text) {
  if (!ctx || !text) return;

  ctx.save();
  ctx.font = 'bold 40px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const tw = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  roundRectPath(DESIGN_W / 2 - tw / 2 - 20, 640, tw + 40, 64, 32);
  ctx.fill();

  ctx.fillStyle = COLORS.text;
  ctx.fillText(text, DESIGN_W / 2, 672);
  ctx.restore();
}

// =====================================================================
//  7. 结算弹幕（滑入 → 停留 → 淡出）
// =====================================================================
function drawBanner(text, progress) {
  if (!ctx || !text) return;

  const p = Math.max(0, Math.min(1, progress));
  let alpha = 1;
  let offset = 0;

  if (p < 0.15) {
    // 从左侧滑入
    const k = p / 0.15;
    offset = (1 - k) * 220;
  } else if (p > 0.85) {
    // 淡出
    alpha = Math.max(0, 1 - (p - 0.85) / 0.15);
  }

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = 'bold 44px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 8;
  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.strokeText(text, DESIGN_W / 2 + offset, 430);
  ctx.fillStyle = '#ffd93b';
  ctx.fillText(text, DESIGN_W / 2 + offset, 430);
  ctx.restore();
}

// =====================================================================
//  8. 特效（气泡弹幕 / 星星 / 速度线 / 飞鞋）
// =====================================================================
function drawFx(fxList) {
  if (!ctx || !fxList) return;

  fxList.forEach((fx) => {
    if (!fx) return;
    switch (fx.kind) {
      case 'bubble': {
        ctx.save();
        ctx.globalAlpha = fx.alpha || 1;
        ctx.translate(fx.x, fx.y);
        ctx.scale(fx.scale || 1, fx.scale || 1);
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        roundRectPath(-45, -26, 90, 52, 26);
        ctx.fill();
        ctx.strokeStyle = '#888888';
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.fillStyle = '#222222';
        ctx.font = 'bold 30px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(fx.text || '', 0, 2);
        ctx.restore();
        break;
      }
      case 'star': {
        drawStar(fx.x, fx.y, fx.scale || 1, fx.alpha || 1, fx.rot || 0);
        break;
      }
      case 'speedline': {
        ctx.save();
        ctx.globalAlpha = fx.alpha || 0.6;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        for (let i = -1; i <= 1; i++) {
          const ang = (fx.angle || 0) + i * 0.18;
          const len = fx.len || 60;
          ctx.beginPath();
          ctx.moveTo(fx.x - Math.cos(ang) * len, fx.y - Math.sin(ang) * len);
          ctx.lineTo(fx.x, fx.y);
          ctx.stroke();
        }
        ctx.restore();
        break;
      }
      case 'shoe': {
        drawShoe(fx.x, fx.y, fx.rotation || 0, fx.alpha || 1);
        break;
      }
      default:
        break;
    }
  });
}

/** 五角星 */
function drawStar(x, y, scale, alpha, rot) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.rotate(rot);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#ffd93b';
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? 12 : 5;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const px = Math.cos(a) * r;
    const py = Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** 飞鞋（简易靴子） */
function drawShoe(x, y, rot, alpha) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.globalAlpha = alpha;
  // 靴筒
  ctx.fillStyle = '#7b4a12';
  roundRectPath(-14, -6, 20, 30, 6);
  ctx.fill();
  // 鞋底
  roundRectPath(-20, 16, 30, 12, 5);
  ctx.fill();
  // 鞋带高光
  ctx.fillStyle = '#ffffff';
  roundRectPath(2, -6, 8, 22, 4);
  ctx.fill();
  ctx.restore();
}

// =====================================================================
//  通用按钮（圆角矩形 + 居中文字）
// =====================================================================
function drawButton(rect, text, bgColor, textColor) {
  if (!ctx) return;
  ctx.save();
  ctx.fillStyle = bgColor || '#3a9d4b';
  roundRectPath(rect.x, rect.y, rect.w, rect.h, 18);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = textColor || '#ffffff';
  ctx.font = 'bold 34px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, rect.x + rect.w / 2, rect.y + rect.h / 2 + 2);
  ctx.restore();
}

// =====================================================================
//  结算弹窗（比赛结束）
//  info: { winner: 'A'|'B'|null, mySide: 'A'|'B', score: {A,B} }
// =====================================================================
function drawSettlement(info) {
  if (!ctx) return;
  const data = info || {};
  const { winner, mySide, score } = data;
  const sc = score || { A: 0, B: 0 };
  const mySideText = mySide || 'A';

  // 全屏遮罩
  ctx.fillStyle = 'rgba(0,0,0,0.62)';
  ctx.fillRect(0, 0, DESIGN_W, DESIGN_H);

  // 面板
  ctx.fillStyle = '#2b3a55';
  roundRectPath(SETTLEMENT.dialog.x, SETTLEMENT.dialog.y, SETTLEMENT.dialog.w, SETTLEMENT.dialog.h, 24);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 4;
  ctx.stroke();

  // 胜负 Banner
  let bannerText;
  let bannerColor;
  if (winner === null || winner === undefined) {
    bannerText = '比赛结束';
    bannerColor = '#ffffff';
  } else if (winner === mySideText) {
    bannerText = '胜利！';
    bannerColor = '#ffd93b';
  } else {
    bannerText = '惜败…';
    bannerColor = '#9aa8c0';
  }
  ctx.save();
  ctx.font = 'bold 60px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 8;
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.strokeText(bannerText, DESIGN_W / 2, SETTLEMENT.bannerY);
  ctx.fillStyle = bannerColor;
  ctx.fillText(bannerText, DESIGN_W / 2, SETTLEMENT.bannerY);
  ctx.restore();

  // 大比分看板
  ctx.save();
  ctx.font = 'bold 96px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 10;
  ctx.strokeText(`${sc.A} - ${sc.B}`, DESIGN_W / 2, SETTLEMENT.scoreY);
  ctx.fillText(`${sc.A} - ${sc.B}`, DESIGN_W / 2, SETTLEMENT.scoreY);
  ctx.restore();

  // 按钮
  drawButton(SETTLEMENT.btnRematch, '再来一局', '#3a9d4b');
  drawButton(SETTLEMENT.btnHome, '返回主页', '#5a6b82');
}

// =====================================================================
//  大厅 UI（未入局 / 匹配等待）
//  info: { matching: boolean } 匹配中则隐藏按钮显示等待文案
// =====================================================================
function drawLobby(info) {
  if (!ctx) return;
  const data = info || {};

  // 标题
  ctx.save();
  ctx.font = 'bold 68px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 10;
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.strokeText(LOBBY.title, DESIGN_W / 2, LOBBY.titleY);
  ctx.fillStyle = '#ffd93b';
  ctx.fillText(LOBBY.title, DESIGN_W / 2, LOBBY.titleY);
  ctx.restore();

  // 副标题
  ctx.save();
  ctx.font = '30px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillText(LOBBY.subtitle, DESIGN_W / 2, LOBBY.subtitleY);
  ctx.restore();

  // 匹配中：显示等待文案；否则显示「创建房间」按钮
  if (data.matching) {
    ctx.save();
    ctx.font = 'bold 36px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(data.matchingText || '创建房间中…', DESIGN_W / 2, LOBBY.btnStart.y + LOBBY.btnStart.h / 2);
    ctx.restore();
  } else {
    drawButton(LOBBY.btnStart, '创建房间', '#3a9d4b');
  }
}

// 房间等待态：建房/入房成功后、开局前
// info: { myRole: 'HOST'|'GUEST', hint: string }（HOST 显示开始按钮）
function drawRoomWait(info) {
  if (!ctx) return;
  const data = info || {};
  const isHost = data.myRole === 'HOST';

  // 标题
  ctx.save();
  ctx.font = 'bold 48px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 8;
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.strokeText(ROOM.title, DESIGN_W / 2, ROOM.titleY);
  ctx.fillStyle = '#ffd93b';
  ctx.fillText(ROOM.title, DESIGN_W / 2, ROOM.titleY);
  ctx.restore();

  // 等待提示
  ctx.save();
  ctx.font = '30px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillText(data.hint || (isHost ? '等待好友加入…' : '等待房主开局…'), DESIGN_W / 2, ROOM.hintY);
  ctx.restore();

  // 房主显示「开始比赛」按钮（访客等待房主开局，不显示）
  if (isHost) {
    drawButton(ROOM.btnStart, '开始比赛', '#3a9d4b');
  }
}

module.exports = {
  initSystem,
  initRender,
  initRenderer,
  getScale,
  getSystem,
  beginFrame,
  drawPitch,
  drawGoal,
  drawKeeper,
  drawBall,
  drawStatusBar,
  drawHint,
  drawBanner,
  drawFx,
  drawSettlement,
  drawLobby,
};