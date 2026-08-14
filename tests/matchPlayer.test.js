/**
 * =====================================================================
 *  单测：房间邀请模式 · 建房/入房/开局/离房（tests/matchPlayer.test.js）
 * =====================================================================
 *  运行：node tests/matchPlayer.test.js
 *
 *  覆盖点（强制卡点）：
 *    - CREATE_ROOM：建房返回 roomId、state=WAITING、hostId=OPENID、幂等防重复；
 *    - JOIN_ROOM：访客原子占位成功置 READY；房主重进幂等；
 *    - 并发抢房：两个 Guest 同时请求 JOIN_ROOM，断言只有一个成功、另一个收到房间已满；
 *    - START_GAME：仅房主、仅 READY 可开局，重置 roundIndex/score 并置 PLAYING；
 *    - LEAVE_ROOM：房主离开置 DISBANDED；访客离开回 WAITING 且腾出空位。
 *
 *  说明：本地无 wx-server-sdk，通过 Module._load 注入内存桩模拟
 *    database 的条件更新语义（_.exists(false)/_.remove()/_.in/_.neq），
 *    保证与云数据库「原子条件更新」行为一致。
 * =====================================================================
 */
const assert = require('assert');
const Module = require('module');

// ---- 内存数据库桩：模拟 wx-server-sdk 的 collection/doc/where/add ----
function createMemoryDb() {
  // 集合名 -> Map<文档id, 文档>
  const store = new Map();

  // 命令标记语义（与真实 wx-server-sdk 一致）：exists/remove/in/neq/eq
  const command = {
    exists: (v) => ({ __cmd: 'exists', value: v }),
    remove: () => ({ __cmd: 'remove' }),
    in: (v) => ({ __cmd: 'in', value: v }),
    neq: (v) => ({ __cmd: 'neq', value: v }),
    eq: (v) => ({ __cmd: 'eq', value: v }),
  };

  // 判断文档是否满足查询条件
  function matches(doc, query) {
    for (const key of Object.keys(query)) {
      const cond = query[key];
      if (cond && typeof cond === 'object' && '__cmd' in cond) {
        switch (cond.__cmd) {
          case 'exists':
            if (cond.value === false && Object.prototype.hasOwnProperty.call(doc, key)) return false;
            if (cond.value === true && !Object.prototype.hasOwnProperty.call(doc, key)) return false;
            break;
          case 'in':
            if (!cond.value.includes(doc[key])) return false;
            break;
          case 'neq':
            if (doc[key] === cond.value) return false;
            break;
          case 'eq':
            if (doc[key] !== cond.value) return false;
            break;
        }
      } else if (doc[key] !== cond) {
        return false;
      }
    }
    return true;
  }

  // 应用更新（_.remove() 删除字段；普通值覆盖）
  function applyUpdate(doc, data) {
    for (const key of Object.keys(data)) {
      const val = data[key];
      if (val && typeof val === 'object' && val.__cmd === 'remove') {
        delete doc[key];
      } else {
        doc[key] = val;
      }
    }
  }

  function collection(name) {
    if (!store.has(name)) store.set(name, new Map());
    const coll = store.get(name);

    return {
      // doc(id)：单文档操作
      doc(id) {
        return {
          async get() {
            const doc = coll.get(id);
            if (!doc) {
              const err = new Error('document not exists');
              err.errCode = -502004;
              throw err;
            }
            return { data: JSON.parse(JSON.stringify(doc)) };
          },
          async update({ data }) {
            const doc = coll.get(id);
            if (!doc) return { stats: { updated: 0 } };
            applyUpdate(doc, data);
            return { stats: { updated: 1 } };
          },
        };
      },
      // where(query)：条件查询/条件更新（原子：同步扫描+更新）
      where(query) {
        return {
          async update({ data }) {
            let updated = 0;
            for (const [id, doc] of coll) {
              if (matches(doc, query)) {
                applyUpdate(doc, data);
                updated++;
                // 单文档条件（含 _id）命中即止
                if (query._id) break;
              }
            }
            return { stats: { updated } };
          },
          async get() {
            const docs = [];
            for (const [id, doc] of coll) {
              if (matches(doc, query)) docs.push(JSON.parse(JSON.stringify(doc)));
            }
            return { data: docs };
          },
        };
      },
      // add({ data })
      async add({ data }) {
        const id = data._id || `room_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const doc = JSON.parse(JSON.stringify(data));
        doc._id = id;
        coll.set(id, doc);
        return { _id: id };
      },
    };
  }

  return { command, collection, _store: store }; // _store 供测试内省
}

// ---- 桩：拦截 wx-server-sdk（db 由测试注入到处理器，此桩仅防模块加载失败）----
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') {
    return {
      DYNAMIC_CURRENT_ENV: 'test',
      init() {},
      database() {
        return createMemoryDb();
      },
      getWXContext() {
        return { OPENID: 'test-openid' };
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const m = require('../cloudfunctions/matchPlayer/index.js');
const { ErrCode, ROOM_STATES } = m;

// =====================================================================
//  用例执行器（支持 async）
// =====================================================================
let passCount = 0;
let failCount = 0;
const failDetails = [];

async function run(name, fn) {
  try {
    await fn();
    passCount++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failCount++;
    failDetails.push(`  [FAIL] ${name}\n         ${err.message}`);
    console.log(`  [FAIL] ${name}\n         ${err.message}`);
  }
}

/** 便捷：在内存库建一个房间 */
async function seedRoom(db, { roomId, hostId, guestId, state = 'WAITING' }) {
  db.collection('rooms'); // 确保集合注册到 _store
  const map = db._store.get('rooms');
  const doc = m.buildRoomDoc(hostId, Date.now());
  doc._id = roomId;
  doc.state = state;
  if (guestId != null) doc.guestId = guestId;
  map.set(roomId, doc);
  return doc;
}

async function main() {
  console.log('=== 房间邀请模式单测开始 ===\n');

  // ---- 用例 1：CREATE_ROOM 建房 ----
  await run('用例1: CREATE_ROOM → 返回 roomId, state=WAITING, hostId=OPENID', async () => {
    const db = createMemoryDb();
    const r = await m.createRoom(db, 'hostA');
    assert.strictEqual(r.code, ErrCode.OK);
    assert.ok(r.data.roomId);
    assert.strictEqual(r.data.state, ROOM_STATES.WAITING);
    assert.strictEqual(r.data.recreated, true);
    const doc = db._store.get('rooms').get(r.data.roomId);
    assert.strictEqual(doc.hostId, 'hostA');
    // guestId 缺席（不存在即空位，配合乐观锁）
    assert.ok(!('guestId' in doc));
  });

  // ---- 用例 2：CREATE_ROOM 幂等 ----
  await run('用例2: CREATE_ROOM 重复调用 → 返回同一 roomId（幂等）', async () => {
    const db = createMemoryDb();
    const r1 = await m.createRoom(db, 'hostA');
    const r2 = await m.createRoom(db, 'hostA');
    assert.strictEqual(r2.data.roomId, r1.data.roomId);
    assert.strictEqual(r2.data.recreated, false);
  });

  // ---- 用例 3：JOIN_ROOM 成功占位 ----
  await run('用例3: JOIN_ROOM → guestId 写入, state=READY', async () => {
    const db = createMemoryDb();
    const roomId = 'r1';
    await seedRoom(db, { roomId, hostId: 'hostA' });
    const r = await m.joinRoom(db, 'guestB', roomId);
    assert.strictEqual(r.code, ErrCode.OK);
    assert.strictEqual(r.data.state, ROOM_STATES.READY);
    assert.strictEqual(r.data.role, 'GUEST');
    const doc = db._store.get('rooms').get(roomId);
    assert.strictEqual(doc.guestId, 'guestB');
    assert.strictEqual(doc.state, ROOM_STATES.READY);
  });

  // ---- 用例 4：房主重进自己房间幂等 ----
  await run('用例4: 房主重进自己房间 → 幂等返回 role=HOST', async () => {
    const db = createMemoryDb();
    const roomId = 'r1';
    await seedRoom(db, { roomId, hostId: 'hostA' });
    const r = await m.joinRoom(db, 'hostA', roomId);
    assert.strictEqual(r.code, ErrCode.OK);
    assert.strictEqual(r.data.role, 'HOST');
    // 不改变 guestId
    assert.ok(!('guestId' in db._store.get('rooms').get(roomId)));
  });

  // ---- 用例 5：访客重复入房幂等 ----
  await run('用例5: 访客已是该房 guest 再入 → 幂等返回 role=GUEST', async () => {
    const db = createMemoryDb();
    const roomId = 'r1';
    await seedRoom(db, { roomId, hostId: 'hostA', guestId: 'guestB', state: 'READY' });
    const r = await m.joinRoom(db, 'guestB', roomId);
    assert.strictEqual(r.code, ErrCode.OK);
    assert.strictEqual(r.data.role, 'GUEST');
  });

  // ---- 用例 6：房间已满（已有 guest）----
  await run('用例6: 房间已满 → 新访客收到 ROOM_FULL', async () => {
    const db = createMemoryDb();
    const roomId = 'r1';
    await seedRoom(db, { roomId, hostId: 'hostA', guestId: 'guestB', state: 'READY' });
    const r = await m.joinRoom(db, 'guestC', roomId);
    assert.strictEqual(r.code, ErrCode.ROOM_FULL);
  });

  // ---- 用例 7（强制卡点）：并发抢房 —— 两个 Guest 同时 JOIN_ROOM ----
  await run('用例7: 并发抢房 → 仅一个成功, 另一个 ROOM_FULL', async () => {
    const db = createMemoryDb();
    const roomId = 'r1';
    await seedRoom(db, { roomId, hostId: 'hostA' });

    // 同时发起两个访客入房请求（真实云端为两个请求并发到达）
    const [rB, rC] = await Promise.all([
      m.joinRoom(db, 'guestB', roomId),
      m.joinRoom(db, 'guestC', roomId),
    ]);

    const codes = [rB.code, rC.code];
    // 断言：恰好一个成功、一个房间已满
    assert.strictEqual(codes.filter((c) => c === ErrCode.OK).length, 1, `成功数应为 1, 实际 ${JSON.stringify(codes)}`);
    assert.strictEqual(codes.filter((c) => c === ErrCode.ROOM_FULL).length, 1, `失败数应为 1, 实际 ${JSON.stringify(codes)}`);

    // 断言：guestId 最终只有一个（原子性）
    const doc = db._store.get('rooms').get(roomId);
    assert.ok(doc.guestId === 'guestB' || doc.guestId === 'guestC', `guestId 应为二选一, 实际 ${doc.guestId}`);
    assert.strictEqual(doc.state, ROOM_STATES.READY);
  });

  // ---- 用例 8：房间不存在 ----
  await run('用例8: JOIN_ROOM 房间不存在 → ROOM_NOT_FOUND', async () => {
    const db = createMemoryDb();
    const r = await m.joinRoom(db, 'guestB', 'no_such_room');
    assert.strictEqual(r.code, ErrCode.ROOM_NOT_FOUND);
  });

  // ---- 用例 9：房间已开始/已结束不可加入 ----
  await run('用例9: JOIN_ROOM state=PLAYING → ROOM_CLOSED', async () => {
    const db = createMemoryDb();
    const roomId = 'r1';
    await seedRoom(db, { roomId, hostId: 'hostA', guestId: 'guestB', state: 'PLAYING' });
    const r = await m.joinRoom(db, 'guestC', roomId);
    assert.strictEqual(r.code, ErrCode.ROOM_CLOSED);
  });

  // ---- 用例 10：START_GAME 非房主被拒 ----
  await run('用例10: START_GAME 非房主 → NOT_HOST', async () => {
    const db = createMemoryDb();
    const roomId = 'r1';
    await seedRoom(db, { roomId, hostId: 'hostA', guestId: 'guestB', state: 'READY' });
    const r = await m.startGame(db, 'guestB', roomId);
    assert.strictEqual(r.code, ErrCode.NOT_HOST);
  });

  // ---- 用例 11：START_GAME 未就绪被拒 ----
  await run('用例11: START_GAME state=WAITING → ROOM_NOT_READY', async () => {
    const db = createMemoryDb();
    const roomId = 'r1';
    await seedRoom(db, { roomId, hostId: 'hostA' });
    const r = await m.startGame(db, 'hostA', roomId);
    assert.strictEqual(r.code, ErrCode.ROOM_NOT_READY);
  });

  // ---- 用例 12：START_GAME 成功重置对局字段 ----
  await run('用例12: START_GAME 房主+READY → PLAYING, 重置 roundIndex/score', async () => {
    const db = createMemoryDb();
    const roomId = 'r1';
    await seedRoom(db, { roomId, hostId: 'hostA', guestId: 'guestB', state: 'READY' });
    const r = await m.startGame(db, 'hostA', roomId);
    assert.strictEqual(r.code, ErrCode.OK);
    const doc = db._store.get('rooms').get(roomId);
    assert.strictEqual(doc.state, ROOM_STATES.PLAYING);
    assert.strictEqual(doc.roundIndex, 0);
    assert.deepStrictEqual(doc.score, { A: 0, B: 0 });
    assert.strictEqual(doc.roundShooter, 'A');
  });

  // ---- 用例 13：房主离开 → DISBANDED ----
  await run('用例13: LEAVE_ROOM 房主离开 → DISBANDED', async () => {
    const db = createMemoryDb();
    const roomId = 'r1';
    await seedRoom(db, { roomId, hostId: 'hostA', guestId: 'guestB', state: 'READY' });
    const r = await m.leaveRoom(db, 'hostA', roomId);
    assert.strictEqual(r.code, ErrCode.OK);
    assert.strictEqual(r.data.action, 'DISBAND');
    assert.strictEqual(db._store.get('rooms').get(roomId).state, ROOM_STATES.DISBANDED);
  });

  // ---- 用例 14：访客离开 → 回 WAITING 且腾出空位 ----
  await run('用例14: LEAVE_ROOM 访客离开 → WAITING + guestId 移除', async () => {
    const db = createMemoryDb();
    const roomId = 'r1';
    await seedRoom(db, { roomId, hostId: 'hostA', guestId: 'guestB', state: 'READY' });
    const r = await m.leaveRoom(db, 'guestB', roomId);
    assert.strictEqual(r.code, ErrCode.OK);
    assert.strictEqual(r.data.action, 'LEAVE');
    const doc = db._store.get('rooms').get(roomId);
    assert.strictEqual(doc.state, ROOM_STATES.WAITING);
    assert.ok(!('guestId' in doc), 'guestId 应被移除（空位）');
  });

  // ---- 用例 15：访客离开后，新访客可再次入房 ----
  await run('用例15: 访客离开后新访客可入房（空位可复用）', async () => {
    const db = createMemoryDb();
    const roomId = 'r1';
    await seedRoom(db, { roomId, hostId: 'hostA', guestId: 'guestB', state: 'READY' });
    await m.leaveRoom(db, 'guestB', roomId);
    const r = await m.joinRoom(db, 'guestC', roomId);
    assert.strictEqual(r.code, ErrCode.OK);
    assert.strictEqual(db._store.get('rooms').get(roomId).guestId, 'guestC');
  });

  // ---- 用例 16：访客退出旧房加入新房 ----
  await run('用例16: 访客退出旧房加入新房 → 旧房释放空位', async () => {
    const db = createMemoryDb();
    await seedRoom(db, { roomId: 'old', hostId: 'hostO', guestId: 'guestB', state: 'WAITING' });
    await seedRoom(db, { roomId: 'new', hostId: 'hostN' });
    const r = await m.joinRoom(db, 'guestB', 'new');
    assert.strictEqual(r.code, ErrCode.OK);
    // 旧房 guestId 被腾出
    const old = db._store.get('rooms').get('old');
    assert.strictEqual(old.state, ROOM_STATES.WAITING);
    assert.ok(!('guestId' in old), '旧房 guestId 应被移除');
    // 新房占位成功
    assert.strictEqual(db._store.get('rooms').get('new').guestId, 'guestB');
  });

  // ---- 用例 17：访客作为他房房主时加入新房 → 旧房解散 ----
  await run('用例17: 房主加入他房 → 旧房解散(DISBANDED)', async () => {
    const db = createMemoryDb();
    await seedRoom(db, { roomId: 'old', hostId: 'userX' });
    await seedRoom(db, { roomId: 'new', hostId: 'hostN' });
    const r = await m.joinRoom(db, 'userX', 'new');
    assert.strictEqual(r.code, ErrCode.OK);
    assert.strictEqual(db._store.get('rooms').get('old').state, ROOM_STATES.DISBANDED);
    assert.strictEqual(db._store.get('rooms').get('new').guestId, 'userX');
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
  console.log('  1. CREATE_ROOM 建房/幂等（用例1/2）');
  console.log('  2. JOIN_ROOM 占位/房主重进/访客重进/已满/不存在/已开始（用例3-6/8/9）');
  console.log('  3. 并发抢房：两 Guest 同时入房仅一成功（用例7，强制卡点）');
  console.log('  4. START_GAME 鉴权/未就绪/重置开局（用例10-12）');
  console.log('  5. LEAVE_ROOM 解散/腾空位/空位复用/旧房释放（用例13-17）');
  console.log('========================================================');

  if (failCount > 0) {
    console.log('\n失败明细:');
    failDetails.forEach((d) => console.log(d));
    process.exit(1);
  }
  console.log('\n全部用例通过 ✅');
  process.exit(0);
}

main().catch((err) => {
  console.error('[matchPlayer.test] 执行异常', err);
  process.exit(1);
});