# Qfootball · 1v1 实时点球大战

基于微信小游戏 + 微信云开发的 1v1 实时点球对战游戏。通过**房间邀请**机制对战：房主建房 → 分享卡片 → 好友入房 → 房主开局，轮流射门/扑救，共 10 脚（各 5 次），平局进入无限加时，最终必分胜负。

- 小游戏端：原生 Canvas 2D 渲染 + 自研状态机/动画/主循环，无第三方前端依赖
- 服务端：微信云开发（wx-server-sdk）两个云函数：`matchPlayer`（建房/入房/开局/离房）、`resolveRound`（回合结算与胜负判定）
- 实时同步：`db.watch()` 监听房间文档，实现双端动画同步
- 核心玩法由服务端权威结算，客户端只负责输入采集与渲染，防作弊

---

## 游戏玩法

- **建房**：大厅点击「创建房间」→ 云端建房并自动拉起微信分享卡片（`query=roomId=...`）。
- **入房**：好友点击分享卡片进入（冷启动解析 `getLaunchOptionsSync().query`，热启动监听 `wx.onShow`），成功后自动入房等待。
- **开局**：房主在房间等待态点击「开始比赛」（双方就绪 `READY` 后）→ 进入对局。房主固定为 A 边、访客固定为 B 边。
- **轮流射门**：每回合一人射门、一人扑救（首轮 A 先射，之后轮流；射门方与服务端 `roundShooter` 保持一致）。
- **划屏输入**：射门/扑救都靠划屏——滑动方向决定三路方向（左/中/右），滑动距离与速度决定力度。
- **力度分档**（服务端权威计算）：
  - 射门：`SOFT 勺子`（慢速弧线） / `STANDARD 常规` / `POWER 大力死角` / `OVERKILL 爆表踢飞`
  - 扑救：`SOFT 原地` / `STANDARD 侧扑` / `HARD 极限飞身` / `OVERKILL 脸刹`
- **胜负判定**（`determineGame`）：
  - 提前胜出：落后分数 > 剩余踢球数时直接终场；
  - 常规局：踢满 10 脚按比分判胜负；
  - 加时赛：踢满 10 脚平局进入无限加时，双方各多踢完一轮后仍平则继续，最终必分胜负（无平局结果）。

---

## 技术架构

```
小游戏客户端 (game.js)
   └── core/              前端核心（见目录结构）
         ├── input.js     触摸采集：滑屏(swipe) + 点按(tap)
         ├── bootstrap.js 全局调度：大厅/房间等待态/对局/结算弹窗/重连/watch
         ├── matchManager.js 房间编排：createRoom/joinRoom/startGame/leaveRoom
         └── stateMachine  IDLE → SUBMITTING → ANIMATING → NEXT_ROUND → FINISHED
   └── net/cloud.js       云函数调用封装 + 错误码分类 + room watch
   └── config/config.js   设计分辨率/布局/动画参数/错误码（750×1334 设计空间）

云函数 (cloudfunctions/)
   ├── matchPlayer/   房间生命周期：CREATE_ROOM/JOIN_ROOM/START_GAME/LEAVE_ROOM
   └── resolveRound/  回合结算（力度/方向/档位） + 胜负判定 + 状态写回
```

### 房间生命周期

```
WAITING（已创建，仅房主）─好友入房─> READY（双方就绪）─房主开局─> PLAYING
  ──结算─> FINISHED（分出胜负）
WAITING ─房主离开─> DISBANDED（解散）    PLAYING/FINISHED ─> 不可再加入
```

### 核心设计

- **权威结算**：比分、回合、胜负全部由 `resolveRound` 云函数在事务内计算并写回 `rooms` 集合，客户端 `watch` 被动同步，无法篡改。
- **并发防抢房**（DevSecOps 卡点）：访客入房用「条件更新」乐观锁——`where({_id, guestId: _.exists(false)}).update({guestId, state:'READY'})` 在数据库服务端原子执行，两人同时点同一分享卡片时仅一条 update 生效，另一条返回「房间已满」（`ROOM_FULL`）。
- **身份安全**：所有云函数以 `wx.getWXContext().OPENID` 为权威身份，忽略客户端上报的身份字段；`GET_ROOM` 仅房间内玩家可查且剥离双方 openid。
- **防重复提交**：同一回合一人提交后标记 `action`，重复提交返回 `ALREADY_SUBMITTED`；回合陈旧返回 `STALE_ROUND`（可携带 `lastResult` 补放动画）。
- **断线重连**：客户端持久化 `roomId/role`，重启后经分享卡片或大厅重建会话；房间内 `joinGame` 幂等重建 watch 监听。
- **回合并发**：双方提交时可能同时触发结算，云函数用文档事务 + 冲突重试（`SETTLE_CONFLICT`）保证只结算一次。

---

## 目录结构

```
Qfootball/
├── game.js                  # 小游戏入口（云初始化 + 冷/热启动解析分享 roomId + bootstrap）
├── game.json                # 小游戏配置（竖屏、网络超时）
├── project.config.json      # 开发者工具项目配置（compileType: game）
├── config/
│   └── config.js            # 全局配置：设计分辨率/布局/动画参数/错误码/大厅与房间按钮 AABB
├── core/                    # 前端核心模块
│   ├── bootstrap.js         # 全局调度（大厅/房间等待态/对局/结算弹窗/重连/watch）
│   ├── matchManager.js      # 房间编排（createRoom/joinRoom/startGame/rematch/leaveRoom + 云错误告警）
│   ├── stateMachine.js      # 状态机（IDLE/SUBMITTING/ANIMATING/NEXT_ROUND/FINISHED）
│   ├── input.js             # 划屏 + 点按采集（设计空间坐标归一化，含缩放注入）
│   ├── render.js            # Canvas 渲染（球场/门将/足球/特效/横幅/结算弹窗/大厅/房间等待态）
│   ├── animator.js          # 射门/扑救动画时间线与 tick
│   └── mainLoop.js          # requestAnimationFrame 主循环
├── net/
│   └── cloud.js             # 云函数调用封装 + watchRoom + 错误分类
├── cloudfunctions/
│   ├── matchPlayer/         # 云函数：房间生命周期（CREATE_ROOM/JOIN_ROOM/START_GAME/LEAVE_ROOM）
│   └── resolveRound/        # 云函数：回合结算与胜负判定（SUBMIT_ACTION / GET_ROOM）
└── tests/                   # 本地 Node 单测（无 wx 依赖，Module._load 桩替换 wx-server-sdk）
    ├── match.test.js        # 回合结算计分与攻守轮换（9 用例）
    ├── determine.test.js    # 胜负判定算法（11 用例：提前胜出/加时/集成）
    └── matchPlayer.test.js  # 房间生命周期（17 用例，含并发抢房强制卡点）
```

---

## 运行与部署

### 1. 导入项目

1. 打开微信开发者工具 → 「小游戏」→ 导入本目录。
2. 项目已配置 `appid: wxda9b10556c8eb4b9`，`compileType: game`，`cloudfunctionRoot: cloudfunctions/`。

### 2. 开通云开发并创建集合

在开发者工具「云开发」控制台创建环境（如 `cloud1-d7g9uo3la0e6ce2c4`），并创建集合：

- `rooms`：对局房间（唯一必需集合，房间邀请模式不再使用 `matchPool`）

> 需确认云函数数据库权限允许客户端读取 `rooms`（watch 需要读权限）。

### 3. 部署云函数

在开发者工具中分别右键 `cloudfunctions/matchPlayer` 与 `cloudfunctions/resolveRound`，选择「上传并部署：云端安装依赖」。

> `game.js` 中的 `wx.cloud.init({ env })` 需改成你的云开发环境 ID。

### 4. 运行

预览 / 真机调试，需要两个微信账号（或开两个模拟器实例）：房主建房 → 分享卡片 → 另一账号打开链接入房 → 房主点「开始比赛」对局。

> 若真机报 `render.drawRoomWait is not a function`，先「清缓存 → 重新编译」，确认主包引用的确是最新的 `core/render.js`。

---

## 本地单测

云函数核心逻辑通过 `Module._load` 桩替换 `wx-server-sdk`，无需微信环境即可在 Node 下运行：

```bash
node tests/match.test.js       # 回合结算计分与攻守轮换，9 用例
node tests/determine.test.js   # 胜负判定算法，11 用例
node tests/matchPlayer.test.js # 房间生命周期，17 用例（含并发抢房卡点）
```

---

## 通信协议

后端统一返回 `{ code, msg, data }`，`code=0` 表示成功。主要错误码：

| code | 含义 |
|---|---|
| 1002 | 玩家不在房间 |
| 1003 | 回合陈旧（STALE_ROUND，可携带 lastResult 补动画） |
| 1004 | 已提交，幂等等待（ALREADY_SUBMITTED） |
| 1005 | 房间未开局 |
| 1006 | 房间不存在 |
| 2001 | 结算并发冲突（SETTLE_CONFLICT，可重试） |
| 2002 | 房间已满（ROOM_FULL，并发抢房失败） |
| 2003 | 房间已开始/已结束/已解散（ROOM_CLOSED） |
| 2004 | 非房主无权开局（NOT_HOST） |
| 2005 | 房间未就绪，缺少访客（ROOM_NOT_READY） |
| 5000 / 5001 | 数据库 / 服务内部异常 |

---

## 路线图（后续可扩展）

- [ ] 音效与震动反馈
- [ ] 排行榜 / 战绩统计
- [ ] 观战与回放