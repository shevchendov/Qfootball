/**
 * =====================================================================
 *  主循环（core/mainLoop.js）
 * =====================================================================
 *  基于 requestAnimationFrame 的 60fps 帧循环。
 *  计算上一帧到本帧的时间差 dt(ms)，回调给 onFrame。
 * =====================================================================
 */

let rafId = null;        // requestAnimationFrame 句柄
let lastTs = 0;          // 上一帧时间戳
let onFrame = null;      // 每帧回调
let running = false;

/** 内部循环 */
function loop(ts) {
  if (!lastTs) lastTs = ts;
  const dt = ts - lastTs;
  lastTs = ts;

  if (onFrame) {
    try {
      onFrame(dt, ts);
    } catch (err) {
      console.error('[mainLoop] onFrame error', err);
    }
  }

  if (running) {
    rafId = requestAnimationFrame(loop);
  }
}

/**
 * 启动帧循环。
 * @param {(dt:number, ts:number) => void} cb 每帧回调，dt 为距上帧毫秒数
 */
function start(cb) {
  if (running) return;
  running = true;
  lastTs = 0;
  onFrame = typeof cb === 'function' ? cb : null;

  // 兜底：个别环境无 requestAnimationFrame 时退化为 setTimeout
  if (typeof requestAnimationFrame === 'function') {
    rafId = requestAnimationFrame(loop);
  } else {
    rafId = setTimeout(function step() {
      loop(Date.now());
      if (running) rafId = setTimeout(step, 16);
    }, 16);
  }
}

/** 停止帧循环 */
function stop() {
  running = false;
  if (rafId != null) {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
    else clearTimeout(rafId);
    rafId = null;
  }
  lastTs = 0;
}

module.exports = {
  start,
  stop,
};