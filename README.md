# Qfootball · 1v1 实时点球大战

基于微信小游戏 + 微信云开发的 1v1 实时点球对战游戏。两名玩家随机匹配，轮流射门/扑救，共 10 脚（各 5 次），平局进入无限加时，最终必分胜负。

- 小游戏端：原生 Canvas 2D 渲染 + 自研状态机/动画/主循环，无第三方前端依赖
- 服务端：微信云开发（wx-server-sdk）两个云函数：`matchPlayer`（匹配建房）、`resolveRound`（回合结算与胜负判定）
- 实时同步：`db.watch()` 监听房间文档，实现双端动画同步
- 核心玩法由服务端权威结算，客户端只负责输入采集与渲染，防作弊

---

## 游戏玩法

- **匹配**：点击「开始比赛」进入随机匹配，配对成功后自动入房建房。
- **轮流射门**：每回合一人射门、一人扑救（首轮 A 先射，之后轮流；射门方与服务端 `roundShooter` 保持一致）。
- **划屏输入**：射门/扑救都靠划屏——滑动方向决定射门或扑救的三路方向（左/中/右），滑动距离与速度决定力度。
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
         ├── bootstrap.js 全局调度：状态机/房间/动画/结算弹窗/重连
         ├── matchManager.js 匹配编排：开始比赛/轮询/断线重连
         └── stateMachine  IDLE → SUBMITTING → ANIMATING → NEXT_ROUND → FINISHED
   └── net/cloud.js       云函数调用封装 + 错误码分类 + room watch
   └── config/config.js   设计分辨率/布局/动画参数/错误码（750×1334 设计空间）

云函数 (cloudfunctions/)
   ├── matchPlayer/   随机匹配（matchPool 单文档配对池，原子占位/清空）
   └── resolveRound/  回合结算（力度/方向/档位） + 胜负判定 + 状态写回
```

### 核心设计

- **权威结算**：比分、回合、胜负全部由 `resolveRound` 云函数在事务内计算并写回 `rooms` 集合，客户端 `watch` 被动同步，无法篡改。
- **原子匹配**：`matchPool` 单文档配对池 + 条件更新（`waiter exists(false)` 才可占位、`waiter=other` 才可清空），天然串行，避免两人同时建房或抢同一房间。
- **防重复提交**：同一回合一人提交后标记 `action`，重复提交返回 `ALREADY_SUBMITTED`；回合陈旧返回 `STALE_ROUND`（可携带 `lastResult` 补放动画）。
- **断线重连**：客户端持久化 `roomId/playerId/role`，重启后自动查询房间——对局中恢复对局，已结束则清缓存回到大厅。
- **回合并发**：双方提交时可能同时触发结算，云函数用文档事务 + 冲突重试（`SETTLE_CONFLICT`）保证只结算一次。

---

## 目录结构

```
Qfootball/
├── game.js                  # 小游戏入口（云开发初始化 + bootstrap + matchManager）
├── game.json                # 小游戏配置（竖屏、网络超时）
├── project.config.json      # 开发者工具项目配置（compileType: game）
├── config/
│   └── config.js            # 全局配置：设计分辨率/布局/动画参数/错误码
├── core/                    # 前端核心模块
│   ├── bootstrap.js         # 全局调度（大厅/入房/结算弹窗/重连/watch）
│   ├── matchManager.js      # 匹配编排与断线重连分派
│   ├── stateMachine.js      # 状态机（IDLE/SUBMITTING/ANIMATING/NEXT_ROUND/FINISHED）
│   ├── input.js             # 划屏 + 点按采集（设计空间坐标归一化）
│   ├── render.js            # Canvas 渲染（球场/门将/足球/特效/横幅/结算弹窗/大厅）
│   ├── animator.js          # 射门/扑救动画时间线与 tick
│   └── mainLoop.js          # requestAnimationFrame 主循环
├── net/
│   └── cloud.js             # 云函数调用封装 + watchRoom + 错误分类
├── cloudfunctions/
│   ├── matchPlayer/         # 云函数：随机匹配（MATCH_RANDOM / GET_STATUS / CANCEL）
│   └── resolveRound/        # 云函数：回合结算与胜负判定（SUBMIT_ACTION / GET_ROOM）
└── tests/                   # 本地 Node 单测（无 wx 依赖，Module._load 桩替换 wx-server-sdk）
    ├── match.test.js        # 匹配建房与攻守轮换计分（9 用例）
    └── determine.test.js    # 胜负判定算法（11 用例：提前胜出/加时/集成）
```

---

## 运行与部署

### 1. 导入项目

1. 打开微信开发者工具 → 「小游戏」→ 导入本目录。
2. 项目已配置 `appid: wxda9b10556c8eb4b9`，`compileType: game`，`cloudfunctionRoot: cloudfunctions/`。

### 2. 开通云开发并创建集合

在开发者工具「云开发」控制台创建环境（如 `cloud1-d7g9uo3la0e6ce2c4`），并创建两个集合：

- `rooms`：对局房间
- `matchPool`：配对池，并手工添加一条固定文档 `{ _id: 'pool' }`（云函数也会惰性兜底创建）

> 需确认云函数数据库权限允许客户端读取 `rooms`（watch 需要读权限）。

### 3. 部署云函数

在开发者工具中分别右键 `cloudfunctions/matchPlayer` 与 `cloudfunctions/resolveRound`，选择「上传并部署：云端安装依赖」。

> `game.js` 中的 `wx.cloud.init({ env })` 需改成你的云开发环境 ID。

### 4. 运行

预览 / 真机调试，需要两个微信账号（或开两个模拟器实例）才能完整体验对战。

---

## 本地单测

云函数核心逻辑通过 `Module._load` 桩替换 `wx-server-sdk`，无需微信环境即可在 Node 下运行：

```bash
node tests/match.test.js       # 匹配建房 + 回合轮换计分，9 用例
node tests/determine.test.js   # 胜负判定算法，11 用例
```

---

## 通信协议

后端统一返回 `{ code, msg, data }`，`code=0` 表示成功。主要错误码见 `config/config.js`：

| code | 含义 |
|---|---|
| 1002 | 玩家不在房间 |
| 1003 | 回合陈旧（STALE_ROUND，可携带 lastResult 补动画） |
| 1004 | 已提交，幂等等待（ALREADY_SUBMITTED） |
| 1005 | 房间未开局 |
| 1006 | 房间不存在 |
| 2001 | 结算并发冲突（SETTLE_CONFLICT，可重试） |
| 5000 / 5001 | 数据库 / 服务内部异常 |

---

## 路线图（后续可扩展）

- [ ] 音效与震动反馈
- [ ] 排行榜 / 战绩统计
- [ ] 好友房（通过房间码加入）
- [ ] 观战与回放