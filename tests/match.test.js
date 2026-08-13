/**
 * =====================================================================
 *  单测：回合结算「计分 + 攻守轮换」（tests/match.test.js）
 * =====================================================================
 *  运行：node tests/match.test.js
 *
 *  覆盖点（强制卡点 #1）：
 *    - settleRound 根据 room.roundShooter 动态判定攻守双方；
 *    - GOAL 时给射门方 score +1；
 *    - 结算后 roundShooter 翻转、roundIndex +1；
 *    - 旧房间缺失 score / roundShooter 字段的兼容性。
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
const {
  ShotPowerTier,
  DivePowerTier,
  ShotLane,
  RoundOutcome,
  RoundResultCode,
} = m.Enums;

// =====================================================================
//  测试数据辅助
// =====================================================================
/** 射门动作（tier 按射门方口径） */
function shot(power, lane) {
  return { playerId: 'pA', power, lane, tier: m.toTier(power, 'SHOOTER') };
}
/** 扑救动作（tier 按守门方口径） */
function dive(power, lane) {
  return { playerId: 'pB', power, lane, tier: m.toTier(power, 'KEEPER') };
}
/** 虚拟房间 */
function makeRoom(roundShooter, score, roundIndex) {
  return {
    roundIndex: roundIndex == null ? 0 : roundIndex,
    roundShooter,
    score: score || { A: 0, B: 0 },
    actionA: null,
    actionB: null,
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

console.log('=== 回合结算单测开始 ===\n');

// ---- 用例 1：A 射门命中 → A 计分、轮换 ----
run('用例1: A 大力死角命中 GOAL_CANNON → score.A+1, roundShooter→B', () => {
  const r = m.settleRound(makeRoom('A'), shot(80, 'RIGHT'), dive(30, 'RIGHT'));
  assert.strictEqual(r.result.code, RoundResultCode.GOAL_CANNON);
  assert.strictEqual(r.result.outcome, RoundOutcome.Goal);
  assert.deepStrictEqual(r.nextScore, { A: 1, B: 0 });
  assert.strictEqual(r.nextRoundShooter, 'B');
  assert.strictEqual(r.nextRoundIndex, 1);
});

// ---- 用例 2：扑救成功 → 不计分、仍轮换 ----
run('用例2: 极限扑救 SAVE_FLYING → 比分不变, roundShooter→B', () => {
  const r = m.settleRound(makeRoom('A'), shot(80, 'RIGHT'), dive(80, 'RIGHT'));
  assert.strictEqual(r.result.code, RoundResultCode.SAVE_FLYING);
  assert.strictEqual(r.result.outcome, RoundOutcome.Save);
  assert.deepStrictEqual(r.nextScore, { A: 0, B: 0 });
  assert.strictEqual(r.nextRoundShooter, 'B');
});

// ---- 用例 3：B 射门（攻守互换映射）→ B 计分、轮换回 A ----
run('用例3: roundShooter=B 时 B 射门命中 → score.B+1, roundShooter→A', () => {
  const r = m.settleRound(
    makeRoom('B'),
    dive(30, 'LEFT'),   // A 本回合守门（defender）
    shot(80, 'LEFT'),   // B 本回合射门（attacker）
  );
  assert.strictEqual(r.result.code, RoundResultCode.GOAL_CANNON);
  assert.deepStrictEqual(r.nextScore, { A: 0, B: 1 });
  assert.strictEqual(r.nextRoundShooter, 'A');
});

// ---- 用例 4：射门爆表踢飞 → MISS 不计分、仍轮换 ----
run('用例4: 射门爆表 MISS → 比分不变, roundShooter→B', () => {
  const r = m.settleRound(makeRoom('A'), shot(95, 'LEFT'), dive(50, 'RIGHT'));
  assert.strictEqual(r.result.outcome, RoundOutcome.Miss);
  assert.deepStrictEqual(r.nextScore, { A: 0, B: 0 });
  assert.strictEqual(r.nextRoundShooter, 'B');
});

// ---- 用例 5：连续两回合 A→B 轮换 + 比分累计 ----
run('用例5: 两回合轮换 A→B→A, 比分累计 A:1 B:1', () => {
  // 第 1 回合：A 射门命中
  let r1 = m.settleRound(makeRoom('A'), shot(80, 'RIGHT'), dive(30, 'RIGHT'));
  assert.deepStrictEqual(r1.nextScore, { A: 1, B: 0 });
  assert.strictEqual(r1.nextRoundShooter, 'B');

  // 第 2 回合：B 射门命中（构造下一回合房间状态）
  const room2 = makeRoom(r1.nextRoundShooter, r1.nextScore, r1.nextRoundIndex);
  const r2 = m.settleRound(room2, dive(60, 'CENTER'), shot(70, 'CENTER'));
  assert.deepStrictEqual(r2.nextScore, { A: 1, B: 1 });
  assert.strictEqual(r2.nextRoundShooter, 'A');
  assert.strictEqual(r2.nextRoundIndex, 2);
});

// ---- 用例 6：旧房间缺 score / roundShooter 字段兼容 ----
run('用例6: 旧房间缺 score/roundShooter → 默认 A 射门且不崩溃', () => {
  const r = m.settleRound({ roundIndex: 0 }, shot(60, 'CENTER'), dive(60, 'CENTER'));
  assert.deepStrictEqual(r.nextScore, { A: 0, B: 0 });
  assert.strictEqual(r.nextRoundShooter, 'B'); // 缺省按 'A' 射门翻转
  assert.strictEqual(r.nextRoundIndex, 1);
});

// ---- 用例 7：方向扑错 → GOAL 计分 ----
run('用例7: 扑错方向 GOAL_MISDIRECT_CANNON → score.A+1', () => {
  const r = m.settleRound(makeRoom('A'), shot(80, 'RIGHT'), dive(30, 'LEFT'));
  assert.strictEqual(r.result.code, RoundResultCode.GOAL_MISDIRECT_CANNON);
  assert.deepStrictEqual(r.nextScore, { A: 1, B: 0 });
});

// ---- 用例 8：getSide 身份判定 ----
run('用例8: getSide 返回 A/B/null', () => {
  const room = { playerA_Id: 'uA', playerB_Id: 'uB' };
  assert.strictEqual(m.getSide(room, 'uA'), 'A');
  assert.strictEqual(m.getSide(room, 'uB'), 'B');
  assert.strictEqual(m.getSide(room, 'uC'), null);
});

// ---- 用例 9：toTier 攻守档位映射（轮流射门的关键）----
run('用例9: toTier 攻守档位映射 POWER vs HARD', () => {
  assert.strictEqual(m.toTier(75, 'SHOOTER'), ShotPowerTier.Power);
  assert.strictEqual(m.toTier(75, 'KEEPER'), DivePowerTier.Hard);
  assert.strictEqual(m.toTier(95, 'SHOOTER'), ShotPowerTier.Overkill);
  assert.strictEqual(m.toTier(95, 'KEEPER'), DivePowerTier.Overkill);
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
console.log('  1. settleRound 按 roundShooter 动态判定攻守（用例1/3/6）');
console.log('  2. GOAL 时射门方 score+1（用例1/3/7），Save/Miss 不计分（用例2/4）');
console.log('  3. 结算后 roundShooter 翻转 + roundIndex+1（用例1-6）');
console.log('  4. 攻守互换映射：roundShooter=B 时 B 为射门方（用例3）');
console.log('  5. 旧房间缺字段兼容（用例6）');
console.log('  6. 身份判定与攻守档位映射（用例8/9）');
console.log('========================================================');

if (failCount > 0) {
  console.log('\n失败明细:');
  failDetails.forEach((d) => console.log(d));
  process.exit(1);
}
console.log('\n全部用例通过 ✅');
process.exit(0);