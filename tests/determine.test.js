/**
 * =====================================================================
 *  单测：胜负判定算法 determineGame（tests/determine.test.js）
 * =====================================================================
 *  运行：node tests/determine.test.js
 *
 *  覆盖点（强制卡点 #2）：
 *    - 提前胜出（如 3:0 且仅剩 2 脚时提前结束）；
 *    - 踢满 10 脚平局 → 进入加时（suddenDeath=true）；
 *    - 加时赛：仅当 B 踢完（一对结束）才判胜负；
 *    - 常规未提前/未踢满 → 继续 PLAYING。
 *
 *  说明：本地无 wx-server-sdk 依赖，通过拦截 Module._load 注入桩实现可运行。
 * =====================================================================
 */
const assert = require('assert');
const Module = require('module');

// ---- 桩：拦截 wx-server-sdk（本地无法安装该微信私有依赖）----
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') {
    return {
      DYNAMIC_CURRENT_ENV: 'test',
      init() {},
      database() {
        return { command: () => ({}) };
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const m = require('../cloudfunctions/resolveRound/index.js');
const { determineGame, settleRound, toTier, Enums } = m;
const { ShotPowerTier, DivePowerTier, ShotLane, RoundOutcome } = Enums;

// ---- 测试数据辅助 ----
/** 常规房间（非加时） */
function room(roundShooter, totalRounds, score, roundIndex) {
  return {
    roundIndex: roundIndex == null ? 0 : roundIndex,
    roundShooter,
    totalRounds: totalRounds == null ? 10 : totalRounds,
    score: score || { A: 0, B: 0 },
    suddenDeath: false,
  };
}
/** 加时房间 */
function suddenRoom(roundShooter, score) {
  return {
    roundIndex: 10,
    roundShooter,
    totalRounds: 10,
    score: score || { A: 0, B: 0 },
    suddenDeath: true,
  };
}

// =====================================================================
//  用例执行器
// =====================================================================
let passCount = 0;
let failCount = 0;
const failDetails = [];

function run(name, fn) {
  try {
    fn();
    passCount++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failCount++;
    failDetails.push(`  [FAIL] ${name}\n         ${err.message}`);
    console.log(`  [FAIL] ${name}\n         ${err.message}`);
  }
}

console.log('=== 胜负判定算法单测开始 ===\n');

// ---- 用例 1：提前胜出（3:0 且仅剩 2 脚 → A 提前胜）----
run('用例1: 3:0 且仅剩 2 脚 → 提前胜出 winner=A', () => {
  // 第 6 脚结束：双方各踢 3 脚，B 剩 2 脚；3-0 > 2
  const g = determineGame(room('B'), { A: 3, B: 0 }, 6);
  assert.strictEqual(g.state, 'FINISHED');
  assert.strictEqual(g.winner, 'A');
  assert.strictEqual(g.suddenDeath, false);
});

// ---- 用例 2：对称场景 B 提前胜出 ----
run('用例2: 0:3 且 A 剩 2 脚 → 提前胜出 winner=B', () => {
  const g = determineGame(room('B'), { A: 0, B: 3 }, 6);
  assert.strictEqual(g.state, 'FINISHED');
  assert.strictEqual(g.winner, 'B');
});

// ---- 用例 3：常规未踢满且差距可追 → 继续 ----
run('用例3: 2:1 第 5 脚后（差距可追）→ 继续 PLAYING', () => {
  const g = determineGame(room('A'), { A: 2, B: 1 }, 5);
  assert.strictEqual(g.state, 'PLAYING');
  assert.strictEqual(g.winner, null);
  assert.strictEqual(g.suddenDeath, false);
});

// ---- 用例 4：第 1 脚后 1:0 不误判提前胜出 ----
run('用例4: 1:0 第 1 脚后（B 仍 5 脚可追）→ 继续 PLAYING', () => {
  const g = determineGame(room('A'), { A: 1, B: 0 }, 1);
  assert.strictEqual(g.state, 'PLAYING');
});

// ---- 用例 5：踢满 10 脚分出胜负 ----
run('用例5: 踢满 10 脚 4:3 → FINISHED winner=A', () => {
  const g = determineGame(room('B'), { A: 4, B: 3 }, 10);
  assert.strictEqual(g.state, 'FINISHED');
  assert.strictEqual(g.winner, 'A');
});

// ---- 用例 6：踢满 10 脚平局 → 进入加时 ----
run('用例6: 踢满 10 脚 2:2 → PLAYING + suddenDeath=true', () => {
  const g = determineGame(room('B'), { A: 2, B: 2 }, 10);
  assert.strictEqual(g.state, 'PLAYING');
  assert.strictEqual(g.winner, null);
  assert.strictEqual(g.suddenDeath, true);
});

// ---- 用例 7：加时 A 踢完领先 → 不判（B 尚未踢）----
run('用例7: 加时 A 踢完 3:2 → 仍 PLAYING（B 未踢完一对）', () => {
  const g = determineGame(suddenRoom('A', { A: 2, B: 2 }), { A: 3, B: 2 }, 11);
  assert.strictEqual(g.state, 'PLAYING');
  assert.strictEqual(g.winner, null);
  assert.strictEqual(g.suddenDeath, true);
});

// ---- 用例 8：加时 B 踢完 A 领先 → A 胜 ----
run('用例8: 加时 B 踢完 3:2 → FINISHED winner=A', () => {
  const g = determineGame(suddenRoom('B', { A: 3, B: 2 }), { A: 3, B: 2 }, 12);
  assert.strictEqual(g.state, 'FINISHED');
  assert.strictEqual(g.winner, 'A');
  assert.strictEqual(g.suddenDeath, true);
});

// ---- 用例 9：加时 B 踢完仍平 → 继续 ----
run('用例9: 加时 B 踢完 3:3 → 继续 PLAYING', () => {
  const g = determineGame(suddenRoom('B', { A: 3, B: 3 }), { A: 3, B: 3 }, 12);
  assert.strictEqual(g.state, 'PLAYING');
  assert.strictEqual(g.winner, null);
  assert.strictEqual(g.suddenDeath, true);
});

// ---- 用例 10：settleRound 集成——进球触发提前胜出且 game 正确返回 ----
run('用例10: settleRound 集成——3:1 后 A 进球(提前胜出) game=FINISHED', () => {
  const preRoom = room('A', 10, { A: 3, B: 1 }, 6); // 第 7 脚，A 射
  const shot = { playerId: 'pA', power: 80, lane: ShotLane.RIGHT, tier: toTier(80, 'SHOOTER') };
  const dive = { playerId: 'pB', power: 30, lane: ShotLane.RIGHT, tier: toTier(30, 'KEEPER') };
  const r = settleRound(preRoom, shot, dive);
  assert.strictEqual(r.result.outcome, RoundOutcome.Goal);
  assert.deepStrictEqual(r.nextScore, { A: 4, B: 1 });
  // 第 7 脚：A 已踢 4 脚、B 已踢 3 脚，B 剩 2 脚；4-1=3 > 2 → A 提前胜
  assert.strictEqual(r.game.state, 'FINISHED');
  assert.strictEqual(r.game.winner, 'A');
  assert.strictEqual(r.game.suddenDeath, false);
});

// ---- 用例 11：settleRound 集成——踢满平局进入加时 ----
run('用例11: settleRound 集成——第 10 脚平局 → game.suddenDeath=true', () => {
  const preRoom = room('B', 10, { A: 2, B: 1 }, 9); // 第 10 脚，B 射，B 进则 2:2
  const dive = { playerId: 'pA', power: 40, lane: ShotLane.CENTER, tier: toTier(40, 'KEEPER') };
  const shot = { playerId: 'pB', power: 80, lane: ShotLane.CENTER, tier: toTier(80, 'SHOOTER') };
  const r = settleRound(preRoom, dive, shot); // roundShooter='B'：B 射、A 守
  assert.deepStrictEqual(r.nextScore, { A: 2, B: 2 });
  assert.strictEqual(r.game.state, 'PLAYING');
  assert.strictEqual(r.game.suddenDeath, true);
  assert.strictEqual(r.game.winner, null);
});

// =====================================================================
//  报告摘要
// =====================================================================
console.log('\n==================== 单测报告摘要 ====================');
console.log(`用例数   : ${passCount + failCount}`);
console.log(`通过数   : ${passCount}`);
console.log(`失败数   : ${failCount}`);
console.log('------------------------------------------------------');
console.log('覆盖点说明:');
console.log('  1. 提前胜出：落后分数 > 剩余脚数（用例1/2/4/10）');
console.log('  2. 常规局踢满判定胜负 / 平局进加时（用例5/6/11）');
console.log('  3. 加时赛仅 B 踢完才判胜负（用例7/8/9）');
console.log('  4. settleRound 与 determineGame 集成（用例10/11）');
console.log('========================================================');

if (failCount > 0) {
  console.log('\n失败明细:');
  failDetails.forEach((d) => console.log(d));
  process.exit(1);
}
console.log('\n全部用例通过 ✅');
process.exit(0);