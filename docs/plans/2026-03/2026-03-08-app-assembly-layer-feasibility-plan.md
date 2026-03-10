# `src/app` 组装层系统性重构可行性与完整方案评估

## 1. 文档目的

本文档用于对“新增 `src/app` 作为专门组装层”进行全链路、系统性、完整性分析，并回答以下问题：

1. 这次重构的逻辑是否正确无误。
2. 这是否是一套优秀的重构方案。
3. 该方案是否会引入循环依赖、职责重叠或“为重构而重构”的问题。
4. 该方案如何在严格遵守 `typescript-project-specifications` 规范的前提下落地。

本文档只讨论架构边界与重构方案，不涉及交易业务语义变更，不允许兼容性、补丁式和临时性方案。

---

## 2. 当前现状与问题本质

### 2.1 `src/index.ts` 已经不是薄入口

当前 [src/index.ts](/D:/code/Longbridge-Quantitative-Trading/src/index.ts) 同时承担以下职责：

1. env 初始化
2. 配置创建与校验
3. `Trader`、`MarketDataClient`、`RiskChecker` 等共享依赖创建
4. startup gate 组装与执行
5. startup snapshot load
6. runtime symbol validation 输入收集与校验
7. `MonitorContext` 构建
8. `DelayedSignalVerifier` 回调注册
9. async processors / lifecycle / cleanup 装配
10. 主循环驱动

这说明当前问题不是“一个文件太长”这么简单，而是“顶层装配、运行时编排、业务使用点”混在了同一个入口中。

### 2.2 `src/main` 不是组装层，而是运行时编排层

当前 `src/main` 的主要职责是 runtime orchestration，而不是 composition。

典型模块：

1. [src/main/mainProgram/index.ts](/D:/code/Longbridge-Quantitative-Trading/src/main/mainProgram/index.ts)
2. [src/main/processMonitor/index.ts](/D:/code/Longbridge-Quantitative-Trading/src/main/processMonitor/index.ts)
3. [src/main/lifecycle/dayLifecycleManager.ts](/D:/code/Longbridge-Quantitative-Trading/src/main/lifecycle/dayLifecycleManager.ts)
4. [src/main/asyncProgram/buyProcessor/index.ts](/D:/code/Longbridge-Quantitative-Trading/src/main/asyncProgram/buyProcessor/index.ts)
5. [src/main/asyncProgram/sellProcessor/index.ts](/D:/code/Longbridge-Quantitative-Trading/src/main/asyncProgram/sellProcessor/index.ts)

这些模块负责：

1. 时序推进
2. 生命周期门禁
3. 单标的流水线
4. 异步任务消费
5. 运行期决策

因此，`main` 不能被整体迁入 `app`，否则会制造新的层级混乱。

### 2.3 当前已经存在散落的“装配主导职责”与“目录语义漂移模块”

当前代码库里，确实已经自然演化出一批装配主导职责，但不能把“装配主导”与“应整体迁入 `app`”混为一谈。

更准确的分类应分为两组。

第一组：可直接视为装配主导职责的模块或子职责

1. [src/services/monitorContext/index.ts](/D:/code/Longbridge-Quantitative-Trading/src/services/monitorContext/index.ts)
2. [src/services/cleanup/index.ts](/D:/code/Longbridge-Quantitative-Trading/src/services/cleanup/index.ts)
3. [src/main/bootstrap/runtimeValidation.ts](/D:/code/Longbridge-Quantitative-Trading/src/main/bootstrap/runtimeValidation.ts)
4. [src/main/bootstrap/rebuild.ts](/D:/code/Longbridge-Quantitative-Trading/src/main/bootstrap/rebuild.ts) 中与顶层启动接线直接相关的子职责
5. [src/main/startup/utils.ts](/D:/code/Longbridge-Quantitative-Trading/src/main/startup/utils.ts) 中与 run mode / gate policy 解析直接相关的子职责

第二组：当前目录名已经失真，但不应因此整体迁入 `app` 的模块

1. [src/main/bootstrap/queueCleanup.ts](/D:/code/Longbridge-Quantitative-Trading/src/main/bootstrap/queueCleanup.ts) 名义上位于 `bootstrap`，实际用于运行期自动换标队列清理，更接近 runtime support，而不是启动装配。
2. [src/main/startup/gate.ts](/D:/code/Longbridge-Quantitative-Trading/src/main/startup/gate.ts) 是启动门禁状态机与轮询逻辑，不是纯 wiring；`app` 应组装和调用它，而不是吞并其实现。
3. [src/main/startup/seat.ts](/D:/code/Longbridge-Quantitative-Trading/src/main/startup/seat.ts) 名义上位于 `startup`，但其 `prepareSeatsOnStartup()` 已被启动快照与开盘重建共同复用，更接近恢复能力模块。
4. [src/main/startup/utils.ts](/D:/code/Longbridge-Quantitative-Trading/src/main/startup/utils.ts) 中的 `applyStartupSnapshotFailureState()` 实际写入 lifecycle 状态字段，属于恢复状态协同，而不是单纯 startup 辅助。

这说明当前问题不是“缺一个 `app` 目录”这么简单，而是同时存在两类问题：

1. 顶层装配职责缺少统一承接点。
2. 多个运行期能力模块被错误目录名承载，导致边界语义持续漂移。

还需要注意一个边界细节：

1. `services/monitorContext` 是“装配主导模块”，不是“100% 纯 wiring 模块”。
2. 其 `createMonitorContext()` 属于上下文装配职责，但其中使用的指标画像编译逻辑更接近 strategy capability，不能在引入 `app` 后继续原样夹带进 composition layer。

还存在一个额外的目录语义问题：

1. [src/main/bootstrap/accountDisplay.ts](/D:/code/Longbridge-Quantitative-Trading/src/main/bootstrap/accountDisplay.ts) 当前位于 `bootstrap`，但它实际被 lifecycle 重建和 post-trade refresher 复用，更接近“可复用展示能力”而不是一次性启动装配。
2. 因此，本次重构不仅要收拢 `app`，还要同时修正“被错误目录名承载的非装配模块”。

### 2.4 当前没有实际循环依赖，但存在明显的语义回流

本次分析对 `src/**/*.ts` 的相对 import 图进行了扫描，当前源码没有检测到实际循环依赖。

这意味着：

1. 当前代码库不是靠“真实 import 环”维持运行。
2. 这次重构的首要目标不是“打破已有环”，而是“防止在重构时制造新的环”。

但当前存在明显的语义回流：

1. `services -> main` 方向已经存在，例如：
   - [src/services/cleanup/types.ts](/D:/code/Longbridge-Quantitative-Trading/src/services/cleanup/types.ts) 通过 `import type` 导入 `main/asyncProgram` 下的 `Processor`、`MonitorTaskProcessor`、`OrderMonitorWorker`、`PostTradeRefresher`、`IndicatorCache` 等类型
   - [src/services/monitorContext/types.ts](/D:/code/Longbridge-Quantitative-Trading/src/services/monitorContext/types.ts) 通过 `import type` 导入 `main/asyncProgram/delayedSignalVerifier` 的类型
2. 当前这些回流均为 `import type`，在编译产物中不产生运行时依赖，但仍然违反了理想的单向层级方向：`services` 层的类型定义不应依赖 `main` 层的类型。
3. 这些类型（如 `Processor`、`MonitorTaskProcessor`）本质上是被 `app` 装配时注入的依赖接口，类型定义应跟随装配层而非留在被注入侧。重构后这些 `import type` 将随类型文件迁移到 `app` 层而自然消除。

因此，本次重构必须解决的是“边界回流问题”，而不是做一次表面的目录美化。

---

## 3. 根因判断

本次重构真正要解决的根因有四个：

1. 缺少显式的顶层组装层，导致装配职责散落在 `index.ts`、`services/*`、`main/bootstrap/*`。
2. `main` 既承担运行时编排，又被局部拿来承载装配辅助，语义不纯。
3. 缺少稳定的放置规则，导致新增装配代码容易继续堆回入口或散落在错误目录。
4. 缺少单向 import 规则，导致未来极容易在 `app` 重构过程中制造新的依赖回流或类型环。

如果不同时解决这四个根因，只是把 `index.ts` 拆成几个文件，最终只会得到“新的大目录”，而不是新的架构边界。

---

## 4. 对 `src/app` 方案的全链路正确性分析

## 4.1 可行性

新增 `src/app` 是可行的。

原因：

1. 当前确实存在明确的装配职责聚合需求。
2. 当前已经有一批可直接归类为装配职责的模块，迁移对象明确。
3. 该方案不要求改变交易业务语义，只改变装配边界与依赖方向。
4. 当前没有真实循环依赖，说明可以在较干净的 import 图基础上建立新层。

## 4.2 合理性

新增 `src/app` 是合理的，但只有在它被定义为“顶层 composition layer”时才合理。

`app` 负责：

1. 顶层依赖图装配
2. 启动接线
3. monitor contexts 装配
4. async runtime 装配
5. lifecycle runtime 装配
6. shutdown 接线

`app` 不负责：

1. 信号生成逻辑
2. 风控逻辑
3. 自动寻标/换标逻辑
4. 主循环 tick
5. monitor pipeline
6. 买卖处理规则

如果 `app` 侵入这些职责，它就会和 `main` 形成重叠，方案将立即失去合理性。

## 4.3 全链路时序正确性

这次重构要被认定为“逻辑正确无误”，不能只保留一个粗粒度顺序，而必须同时保留“正常启动链路”和“启动快照失败回退链路”的分支语义。

### 4.3.1 正常启动链路

当前 [src/index.ts](/D:/code/Longbridge-Quantitative-Trading/src/index.ts) 的正常启动链路，核心顺序必须保持不变：

1. `dotenv` / env 初始化
2. 配置解析与配置校验
3. pre-gate 共享依赖创建（如 `symbolRegistry`、warrant list cache、`MarketDataClient`、run mode / gate policy resolver、trading day info resolver）
4. startup gate 组装与等待
5. post-gate 共享运行时状态创建（如 `liquidationCooldownTracker`、`dailyLossTracker`、`lossOffsetLifecycleCoordinator`、`refreshGate`、`lastState`）
6. `Trader` / trade log hydrator / runtime snapshot loader 创建
7. startup snapshot load
8. 核心运行模块创建（如 `marketMonitor`、`doomsdayProtection`、`signalProcessor`）
9. async runtime 基础设施创建（尤其是 `indicatorCache`、task queues）
10. runtime symbol validation 输入收集与校验
11. `MonitorContext` 创建
12. 初次 `rebuildTradingDayState`
13. `DelayedSignalVerifier` 回调注册
14. async processors / lifecycle 创建
15. processors 启动
16. `cleanup` 创建
17. 注册退出清理
18. 主循环开始

其中第 12 步不能被省略。至于“第 12 步是否绝对不能晚于第 13 步”，当前代码能证明的是“现状顺序为先初次重建，再注册延迟验证回调”，而不能单凭现状直接推出“反向顺序必错”。

因此，本次方案应采用更严格也更准确的约束：

1. 默认保留当前顺序：先初次 `rebuildTradingDayState`，再注册 `DelayedSignalVerifier` 回调。
2. 若未来要调整这两个步骤的相对顺序，必须先证明不会影响首轮 monitor context 同步、订单记录重建、风控缓存重建与订单追踪恢复。
3. 在没有额外证明前，本方案不允许擅自改变这两个步骤的相对顺序。

### 4.3.2 启动快照失败回退链路

当前实现还存在一条必须保留的失败分支：

1. 若 startup snapshot load 失败，则必须立即执行 `applyStartupSnapshotFailureState`
2. 将 `lastState.lifecycleState` 切换为 `OPEN_REBUILD_FAILED`
3. 将 `lastState.isTradingEnabled` 置为 `false`
4. 将 `lastState.pendingOpenRebuild` 置为 `true`
5. 将 `lastState.targetTradingDayKey` 写入当前时间对应的 HK 交易日 key，作为需保留的恢复状态字段
6. 同时标记局部控制变量 `startupRebuildPending = true`
7. 仍执行 runtime symbol validation，但跳过其失败判定与退出
8. 跳过初次 `rebuildTradingDayState`
9. 仍然完成 monitor contexts、processors、lifecycle、cleanup 的装配
10. 进入主循环后，由 `dayLifecycleManager.tick()` 在满足当前运行模式门禁语义时触发开盘重建恢复：

- `prod / strict` 下，仍受 `isTradingDay=true`、`canTradeNow=true` 与退避窗口约束
- `dev / skip` 下，恢复触发不应被误写成必须依赖真实交易日与真实连续交易时段

其中必须明确区分两个层级：

1. `startupRebuildPending` 只是启动函数内部用于分支控制的局部变量。
2. `pendingOpenRebuild` 是当前生命周期管理器进入“待重建”状态的核心状态契约，但并不是唯一条件；实际执行仍受 `isTradingDay`、`canTradeNow` 与 retry backoff 共同约束。
3. `pendingOpenRebuild` 有两条来源：启动快照失败，以及跨日午夜清理完成后进入待开盘重建；重构后不得只保留单一路径。
4. `targetTradingDayKey` 当前必须保留，但在现有实现中主要承担“目标交易日标识/状态观测”职责，而不是 `dayLifecycleManager.tick()` 的直接触发条件。

若未来重构后只保留前者而丢掉 `pendingOpenRebuild`，系统将会停留在“失败态已记录但无法自动恢复”的错误状态。若未来把 `pendingOpenRebuild` 只保留为“启动失败专用状态”，而遗漏了跨日午夜清理后的同名状态来源，跨日恢复链路同样会被破坏。若未来要把 `targetTradingDayKey` 升级为真实的重建判定输入，必须在新方案中显式增加读取点与一致性约束，而不能在当前文档里把它表述成已经生效的触发契约。

这条失败分支不是异常兜底，而是当前运行时设计的一部分。若 `app` 重构后把它误改成“启动失败直接退出”或“失败后仍继续初次重建”，都会破坏现有业务语义。

### 4.3.3 启动与开盘重建内部恢复流水线契约

当前文档只写到“startup snapshot load / open rebuild snapshot load”这一层，还不够完整。

真正的恢复语义不是单函数，而是两段刚性契约共同组成：

1. [src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts](/D:/code/Longbridge-Quantitative-Trading/src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts) 负责“快照加载链”
2. [src/main/lifecycle/rebuildTradingDayState.ts](/D:/code/Longbridge-Quantitative-Trading/src/main/lifecycle/rebuildTradingDayState.ts) 负责“状态重建链”

本次重构必须把这两段子链路同时显式固化。

#### A. 快照加载链（`loadTradingDayRuntimeSnapshot()`）

1. 若 `requireTradingDay=true`，先校验交易日并写回 `cachedTradingDayInfo` / `isHalfDay`
2. `trader.initializeOrderMonitor()`
3. 刷新账户与持仓缓存
4. 拉取全量订单
5. `trader.seedOrderHoldSymbols(allOrders)`
6. `prepareSeatsOnStartup()` 恢复或寻标席位
7. 按配置决定是否从 trade log 水合冷却状态与分段边界
8. `dailyLossTracker.recalculateFromAllOrders()` 按恢复出的边界回算日内亏损偏移
9. 按场景决定是否重置 runtime 行情订阅
10. 收集并订阅全部运行时行情标的
11. 订阅所有监控标的 K 线
12. 获取并返回 quotes 快照

#### B. 状态重建链（`rebuildTradingDayState()`）

1. 同步 `symbolRegistry` 与 `quotesMap` 到所有 `MonitorContext`
2. 基于全量订单重建订单记录
3. 预热交易日历快照
4. 重建牛熊证风险缓存
5. 重建浮亏缓存
6. `trader.recoverOrderTrackingFromSnapshot(allOrders)`
7. 展示账户与持仓

这两段内部恢复流水线都必须被视为刚性契约，而不是“实现细节”，原因是：

1. 快照加载链决定席位恢复、冷却恢复、亏损偏移恢复和运行时行情订阅是否正确。
2. 状态重建链决定 MonitorContext 同步、订单记录恢复、风控缓存恢复和订单追踪恢复是否正确。
3. 两者共同服务于“启动时快照加载”和“开盘重建快照加载”，属于共享恢复语义。
4. 若只在 `runApp` 层保留粗粒度顺序，而没有保留这两条子链路，业务逻辑仍可能在重构中被破坏。

同时，当前 `loadTradingDayRuntimeSnapshot()` 还携带一组不能漂移的调用语义：

1. `now`（时间源，必须由调用链路入口传入，不能内部再取 `new Date()`）
2. `requireTradingDay`
3. `failOnOrderFetchError`
4. `resetRuntimeSubscriptions`
5. `hydrateCooldownFromTradeLog`
6. `forceOrderRefresh`

本次重构不得改变这些参数在“启动阶段”和“开盘重建阶段”的现有取值语义。

### 4.3.4 生命周期顺序契约

当前跨日与开盘重建正确性还依赖一条隐含但关键的顺序契约，必须在方案中显式固化：

1. `cacheDomains.midnightClear` 必须按注册顺序执行
2. `cacheDomains.openRebuild` 必须按注册逆序执行
3. 当前注册顺序是：
   1. `signalRuntime`
   2. `marketData`
   3. `seat`
   4. `order`
   5. `risk`
   6. `globalState`
4. 因此当前开盘重建顺序实际是：
   1. `globalState`
   2. `risk`
   3. `order`
   4. `seat`
   5. `marketData`
   6. `signalRuntime`

这套“顺序 + 逆序”机制本身必须固化，但当前真正承载业务依赖的关键点需要写得更准确：

1. `globalState.openRebuild` 中统一执行“快照加载 -> 状态重建”
2. `signalRuntime.openRebuild` 只能在统一重建完成后重启处理器并恢复 refresh gate
3. `risk` / `order` / `seat` / `marketData` 当前 `openRebuild` 默认为空操作，但其顺序槽位仍要保留为未来扩展点
4. cache domains 的注册顺序必须收口为显式常量或唯一注册点，不能继续以内联数组散落在入口装配中
5. 其他缓存域默认不自行重复执行完整重建流水线

如果 `app` 在重构时改变这些域的注册顺序，或把 lifecycle runtime 的组装拆散后丢失“顺序 + 逆序”语义，跨日清理和开盘恢复都会出现逻辑错误。

## 4.4 当前方案还不完整的地方

若 `src/app` 方案缺少以下约束，就还不能被认定为最终优秀方案；本次最终版文档必须逐项补齐这些约束：

1. 未把 import 方向规则写成刚性约束。
2. 未把 `typescript-project-specifications` 对 `types.ts/utils.ts` 的要求落实到 `app` 子域。
3. 未明确禁止兼容性转发壳。
4. 未明确旧装配模块迁移后必须彻底删除，不能保留双轨路径。
5. 未把“启动失败回退链路”写成刚性约束。
6. 未明确区分 `pendingOpenRebuild` 是当前重建触发契约，而 `targetTradingDayKey` 是当前必须保留但并非直接触发条件的恢复状态字段。
7. 未明确区分“局部启动分支控制变量”和“生命周期恢复状态”的不同层级。
8. 未把恢复契约拆分为“快照加载链 + 状态重建链”两个阶段。
9. 未把 lifecycle cache domains 的注册顺序与逆序重建规则写成刚性约束。
10. 未明确 cache domain 注册顺序不能继续以内联数组形式散落在入口装配中，而必须收口为显式常量或唯一注册点。
11. 未充分处理 `queueCleanup`、`startup/gate`、`startup/seat`、`applyStartupSnapshotFailureState` 这类“目录名失真但不应整体迁入 app”的模块。
12. 未定义完整的共享运行时状态唯一创建点与所有权边界。
13. 未明确类型层边界也必须同步迁移，不能只迁移实现。
14. 未把目录边界约束落到 lint / CI 级别自动校验。
15. 未把启动流程显式拆分为 `pre-gate runtime` 与 `post-gate runtime` 两个创建阶段，仍有退化成单一“大组装工厂”的风险。
16. 未把 `marketMonitor`、`doomsdayProtection`、`signalProcessor`、`monitorTaskProcessor`、`buyProcessor`、`sellProcessor`、`dayLifecycleManager` 这类同样由顶层单次创建并跨模块共享的对象纳入统一所有权定义，所有权清单仍不完整。
17. 当前 `src/app` 目录提案粒度偏细，`runtime` / `composition` / `bootstrap` 存在命名重叠，仍有把入口复杂度平移到新目录的风险。
18. 未把 lifecycle cache-domain 级测试、`executeTradingDayOpenRebuild` / `runtimeValidation` 测试与关键业务集成测试纳入硬验收，仍不足以支撑“符合当前业务逻辑”的结论。

---

## 5. 是否属于优秀重构方案

## 5.1 结论

“新增 `src/app` 作为专门组装层”可以成为优秀的重构方案，但前提是升级为一套系统性、完整性的架构方案，而不是一次“目录搬家”。

## 5.2 优秀方案的判定标准

要称为优秀方案，至少必须同时满足以下条件：

1. 解决根因，而不是只缩短入口文件。
2. 不改变业务语义，只调整边界与依赖方向。
3. 不制造新的职责重叠。
4. 不制造新的循环依赖和类型回流。
5. 不依赖兼容壳和补丁层。
6. 完全符合 `typescript-project-specifications`。
7. 能形成长期稳定的目录与 import 规则。
8. 目录方案本身不过度设计，新增层级数量与当前复杂度相匹配。

## 5.3 本方案在什么条件下是优秀方案

只有当以下条件同时成立时，本方案才是优秀方案：

1. `app` 只做 composition，不做 runtime orchestration。
2. `main` 保留 runtime orchestration 职责，不反向依赖 `app`。
3. 所有迁移均为“全量替换”，不保留旧路径代理新路径。
4. `app` 内部按子域建立 `types.ts` / `utils.ts` 组织。
5. 全程禁止 re-export。
6. 建立明确的单向 import 规则。
7. `app` 目录设计保持最小必要复杂度，不再为装配层额外制造新的“子架构框架”。

---

## 6. 必须采用的最终边界定义

### 6.1 `src/app`

职责：顶层组装层。

负责：

1. `runApp`
2. app runtime 创建
3. shared runtime 组装
4. startup / rebuild 装配
5. monitor contexts 装配
6. async runtime 装配
7. lifecycle runtime 装配
8. cleanup runtime 装配

不负责：

1. 主循环业务逻辑
2. 生命周期状态机实现
3. 单标的处理逻辑
4. 买卖执行规则
5. 自动寻标/换标状态机

### 6.2 `src/main`

职责：运行时编排层。

负责：

1. 主循环
2. lifecycle tick
3. monitor pipeline
4. async processors
5. monitor task handlers

不负责：

1. 顶层装配
2. 顶层启动 wiring
3. 顶层退出 wiring

### 6.3 `src/core` / `src/services`

职责：业务能力与基础设施。

负责：

1. 业务规则
2. 领域工厂
3. 外部服务适配
4. 技术型服务实现
5. 被 `app` 组装时复用的非装配型能力函数（例如策略相关的指标画像编译）

不负责：

1. 顶层依赖图连接
2. 应用启动装配

### 6.4 `app runtime` 状态所有权

`src/app` 不是一个“函数搬运目录”，而必须是共享运行时状态的唯一组装入口。

必须明确由 `app runtime` 统一创建并向下游注入的共享对象至少包括：

1. `lastState`
2. `symbolRegistry`
3. `monitorContexts`
4. `refreshGate`
5. `dailyLossTracker`
6. `dailyLossFilteringEngine`（`createOrderFilteringEngine()`，作为 `dailyLossTracker` 的依赖注入）
7. `liquidationCooldownTracker`
8. `lossOffsetLifecycleCoordinator`
9. warrant list cache 与其配置
10. `marketDataClient`
11. `trader`
12. `tradeLogHydrator`（`createTradeLogHydrator()`，被 `loadTradingDayRuntimeSnapshot` 消费）
13. `marketMonitor`
14. `doomsdayProtection`
15. `signalProcessor`
16. `loadTradingDayRuntimeSnapshot`
17. `rebuildTradingDayState`
18. `indicatorCache`
19. `buyTaskQueue`
20. `sellTaskQueue`
21. `monitorTaskQueue`
22. `monitorTaskProcessor`
23. `buyProcessor`
24. `sellProcessor`
25. `orderMonitorWorker`
26. `postTradeRefresher`
27. `dayLifecycleManager`
28. `cleanup`

此外，`tradingConfig`（`createMultiMonitorTradingConfig()`）与 `config`（`createConfig()`）也由 `app` 层顶层创建并被多个下游消费，但它们属于配置层产物而非运行时状态。`app` 负责创建它们，但不将其归入"共享运行时状态"所有权清单。

必须明确的边界规则：

1. 这些对象只能在 `app` 顶层组装阶段创建一次
2. `main/core/services` 只能消费这些对象，不能各自再创建第二份同类运行时实例
3. `app` 负责声明对象所有权，不负责吞并对象对应的业务实现
4. 若需要新增共享运行时对象，必须进入 `app runtime` 的统一定义，而不能散落回 `index.ts` 或 `services/*`
5. 共享对象所有权不仅约束实现文件，也约束对应的 `types.ts`，防止类型层继续跨层回流
6. 所有权清单必须覆盖当前全部“顶层单次创建 + 被多个下游消费”的运行时对象，不能只覆盖一部分基础设施对象

### 6.5 启动期必须拆分为两阶段 runtime

当前真实启动链路存在不可合并的时序边界，因此 `app runtime` 不能被实现成一个无阶段感知的单体工厂。

必须拆分为：

1. `pre-gate runtime`：只创建启动门禁前必需对象，例如 `tradingConfig`、`config`、`symbolRegistry`、warrant list cache、`marketDataClient`、run mode / gate policy、trading day info resolver、startup gate。
2. `post-gate runtime`：只在 startup gate 通过后创建共享运行态对象，例如 `liquidationCooldownTracker`、`dailyLossFilteringEngine`、`dailyLossTracker`、`lossOffsetLifecycleCoordinator`、`refreshGate`、`lastState`、`trader`、`tradeLogHydrator`、`loadTradingDayRuntimeSnapshot`。

必须明确的约束：

1. `runApp` 负责串联 `createPreGateRuntime -> startupGate.wait -> createPostGateRuntime`。
2. `lastState` 不得在 `pre-gate runtime` 中提前创建。
3. `startupTradingDayInfo` 必须先产生，再进入 `lastState` 与后续 post-gate 运行时组装。
4. 若保留 `createAppRuntime` 这一名字，也只能作为编排 facade，内部仍必须显式体现两阶段拆分，不能回退为单一“大工厂”。
5. 同一个启动或重建调用链路内应使用同一个时间源（即在链路入口处取一次 `new Date()`，沿调用链向下传递），避免 `runApp`、`loadTradingDayRuntimeSnapshot()`、`executeTradingDayOpenRebuild()`、`rebuildTradingDayState()` 各自再取一份 `new Date()` 造成跨链路时间漂移。不要求引入全局时间源工厂。

---

## 7. 必须采用的 `src/app` 目录设计

`src/app` 必须是“最小必要复杂度”的组装层，目录设计目标是承接顶层装配，而不是再为装配层制造一套新的多层框架。

因此，本方案不再把 `runtime` / `composition` / `bootstrap` 预先细分成固定三层，而采用“先最小成形，再按真实复杂度拆分”的约束。

推荐的初始形态应控制在以下范围：

```text
src/app/
├── runApp.ts
├── types.ts
├── createCleanupRuntime.ts
├── runtime/
│   ├── createPreGateRuntime.ts
│   ├── createPostGateRuntime.ts
│   └── types.ts
└── composition/
    ├── createMonitorContexts.ts
    ├── createAsyncRuntime.ts
    ├── createLifecycleRuntime.ts
    ├── registerDelayedSignalHandlers.ts
    └── types.ts
```

补充约束：

1. `runApp.ts` 负责表达完整启动链路，而不是把时序拆散到多个同层 facade 中。
2. `runtime/` 只承接 pre-gate / post-gate 两阶段 runtime 创建，不再额外引入 `createStartupRuntime` 一类与 `createPreGateRuntime` 语义重叠的包装层。
3. `composition/` 只承接确实独立的装配片段；若文件数量很少，可以继续收缩，避免为了目录对称性拆文件。
4. `createCleanupRuntime.ts` 当前仅为单文件，直接放在 `app/` 根下，不为其单独建立 `shutdown/` 子目录。当且仅当 cleanup 相关装配在未来确实增长到多文件时，才允许下沉为子目录。
5. `composition/` 下不预设 `utils.ts`；仅当实际存在需要复用的非装配型辅助函数时才创建。不为了目录对称性而预建空文件。
6. 只有当某个子域同时满足”职责稳定 + 文件数量持续增长 + 可独立复用”时，才允许再下钻目录；不能先假设未来复杂度，再提前铺开目录。
7. `typescript-project-specifications` 对 `types.ts` / `utils.ts` 的要求仍然成立，但不能把”必须有 types/utils”误用为”必须制造更多层级”。

采用这版目录约束的原因：

1. 保留 pre-gate / post-gate 这条真实存在的关键时序边界。
2. 避免 `app` 内部出现 `runtime -> bootstrap -> composition` 这类语义重叠的多层包装。
3. 让维护者优先看到启动链路，而不是先理解 `app` 自身的元结构。
4. 既满足 TypeScript 组织规范，也避免把一次必要重构扩大成目录工程。

---

## 8. 必须执行的 import 规则

本次重构若要彻底避免循环依赖与语义回流，必须把下列 import 方向作为硬规则：

1. `src/index.ts` 只允许 import `src/app/runApp`、启动所必需的第三方依赖，以及用于顶层异常输出的最小 `utils` 依赖
2. `src/app/*` 可以 import `config/constants/core/main/services/types/utils`
3. `src/main/*` 不能 import `src/app/*`
4. `src/services/*` 不能 import `src/app/*`
5. `src/core/*` 不能 import `src/app/*`
6. `src/types/*` 不能 import `src/app/*`
7. 迁移完成后，`src/services/*` 不应再 import `src/main/*`
8. 上述规则不因 `import type` 而放宽，类型层同样受约束

这组规则的意义是：

1. `app` 只能位于依赖图顶部。
2. `index.ts` 仍可保留最小启动职责，但不再承载业务装配。
3. 任何下层都不能反向依赖 `app`。
4. `services -> main` 的当前语义回流必须被消除，而不是被带入新结构。

为了让这些规则具备长期稳定性，本次方案必须把它们落到自动化校验：

1. 至少通过现有 `eslint` 体系中的 import 规则做目录边界校验。
2. `bun lint` 必须能直接失败于 `app -> lower -> app` 或 `services -> main` 这类反向依赖。
3. 文档规则不能只停留在人肉 review。

建议直接落地为明确的 `eslint` 规则矩阵，而不是笼统描述“接入 lint”：

1. 对 `src/main/**` 增加 `no-restricted-imports`，禁止导入 `src/app/**`。
2. 对 `src/services/**` 增加 `no-restricted-imports`，禁止导入 `src/app/**` 与 `src/main/**`。
3. 对 `src/core/**` 与 `src/types/**` 增加 `no-restricted-imports`，禁止导入 `src/app/**`。
4. 对 `src/index.ts` 增加 `no-restricted-imports`，仅允许导入 `src/app/runApp`、最小第三方依赖与顶层异常输出所需最小 utils。
5. 上述规则不因 `import type` 而豁免；若 lint 规则天然区分 type import，则必须额外补齐覆盖。
6. 规则配置必须直接提交到仓库中的 `eslint.config.js`，并进入 CI；不能只写在方案文档里。

---

## 9. 第一批迁移范围与明确禁止项

## 9.1 第一批应迁移

第一批只迁移“装配主导职责”，包括：

1. `src/index.ts` 中的对象创建、上下文构建、回调注册、处理器启动与关闭 wiring
2. `src/services/monitorContext/index.ts`
3. `src/services/cleanup/index.ts`
4. `src/main/bootstrap/runtimeValidation.ts`
5. `src/main/bootstrap/rebuild.ts` 中真正属于顶层启动接线的子职责
6. `src/main/startup/utils.ts` 中 `resolveRunMode` / `resolveGatePolicies` 这类启动策略解析子职责
7. 与上述实现对应的边界类型文件：
   1. `src/services/monitorContext/types.ts`
   2. `src/services/cleanup/types.ts`
   3. `src/main/bootstrap/types.ts` 中与 runtime validation / account display 迁移直接相关的类型
   4. `src/main/startup/types.ts` 中与 run mode / gate policy 迁移直接相关的类型

补充约束：

1. 以上迁移必须实现与类型同步完成，禁止“实现迁了、类型仍跨层依赖旧目录”的半迁移状态。
2. 迁移 `src/services/monitorContext/index.ts` 时，只允许把“上下文组装”收口到 `app`；`compileIndicatorUsageProfile()` 这类非装配能力只要不进入 `app` 即可，不应为了本次重构被强制二次下沉到新目录。
3. 若后续确认 `compileIndicatorUsageProfile()` 需要被多个非装配模块共享，或当前所在目录继续造成边界混淆，再单独评估是否迁到更稳定的能力模块；这不是本次 `app` 重构的硬前置条件。
4. `src/main/bootstrap/accountDisplay.ts` 不属于 `app` 纯装配职责，但也不能继续停留在 `bootstrap` 目录名下；它必须迁到一个不再带有“启动一次性逻辑”语义的稳定边界，`src/services/accountDisplay/*` 只是可选落点之一，不应在方案阶段过早锁死唯一目录。
5. `src/main/bootstrap/rebuild.ts` 若继续保留，不允许继续承担目录名与职责不一致的混合语义；要么拆分为 app 侧启动接线 helper 与下层恢复能力调用点，要么迁入更准确的边界。
6. 第一批迁移完成后，旧路径必须直接删除，不能保留双轨。

## 9.2 第一批明确禁止迁移

下列模块不能因为“会在启动时被创建”就迁入 `app`：

1. `src/main/mainProgram/*`
2. `src/main/processMonitor/*`
3. `src/main/lifecycle/*`
4. `src/main/asyncProgram/buyProcessor/*`
5. `src/main/asyncProgram/sellProcessor/*`
6. `src/main/startup/seat.ts`
7. `src/main/startup/gate.ts`
8. `src/main/bootstrap/queueCleanup.ts`
9. `src/main/startup/utils.ts` 中 `applyStartupSnapshotFailureState()` 这类 lifecycle 恢复状态协同子职责
10. `src/services/autoSymbolManager/*`
11. `src/core/*`

原因：

1. 这些模块本质上是 runtime/business 模块，不是 composition 模块。
2. 把它们迁入 `app` 会直接破坏 `app` 的纯装配边界。
3. `src/main/startup/gate.ts` 是门禁状态机与轮询逻辑，`app` 应组装和调用它，而不是吞并其实现。
4. `src/main/bootstrap/queueCleanup.ts` 虽然当前目录名不准确，但其职责属于运行期自动换标队列清理，不属于顶层 composition。
5. `src/main/startup/seat.ts` 同时被 startup snapshot 与 open rebuild 复用，当前更接近“重建流水线能力模块”，而不是单纯的顶层 wiring。
6. `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts` 与 `src/main/lifecycle/rebuildTradingDayState.ts` 必须保留为恢复能力模块；`app` 只负责组装和调用，不负责吞并其实现。

---

## 10. 必须明确否决的错误方案

本次重构中，以下方案必须直接否决：

1. 只把 `index.ts` 拆成几个文件，但仍放在 `src/` 根层，不建立 `app` 边界。
2. 新建 `src/app`，但把 `main` 中的 runtime orchestration 整体搬进去。
3. 新建 `src/app/index.ts` 大文件，继续集中堆装配逻辑。
4. 迁移后保留 `services/cleanup -> app/createCleanupRuntime` 这类兼容转发壳。
5. 在 `app` 中使用 barrel/re-export。
6. 在 `app` 中继续内联定义大量类型或工具函数，不建立 `types.ts/utils.ts`。
7. 把 `startup/gate.ts`、`startup/seat.ts`、`queueCleanup.ts` 这类运行能力模块因为“启动时会被调用”就整体搬入 `app`。

这些方案的问题分别是：

1. 只换文件，不换边界。
2. 制造双编排层。
3. 把问题从一个大文件搬到另一个大文件。
4. 违反“无兼容性代码”的项目规范。
5. 违反“禁止 re-export”的项目规范。
6. 违反 `typescript-project-specifications` 的代码组织规范。
7. 会把 composition 层与运行能力层重新混在一起，导致新架构再次失去边界稳定性。

---

## 11. 分阶段系统性落地方案

## 阶段 0：建立约束

目标：

1. 明确 `app` 的单向 import 规则
2. 明确 `types.ts/utils.ts` 组织规则
3. 明确禁止兼容壳与 re-export
4. 明确边界规则将通过 `eslint` 自动校验
5. 明确关键回归测试将作为硬验收项保留

阶段结果：

1. 先把边界规则和测试约束定清楚，再进入代码迁移

## 阶段 1：建立 `app` 顶层入口

目标：

1. 引入 `src/app/runApp.ts`
2. 引入 `src/app/runtime/createPreGateRuntime.ts`
3. 引入 `src/app/runtime/createPostGateRuntime.ts`
4. 在 post-gate runtime 中显式创建完整的共享运行时状态与唯一所有权对象
5. 让 `src/index.ts` 只负责 env 初始化、异常处理、调用 `runApp()`

阶段结果：

1. `index.ts` 退化为薄入口

## 阶段 2：迁移装配模块

目标：

1. 迁移 `monitorContext` 装配
2. 迁移 `cleanup` 装配
3. 迁移 `runtimeValidation` 与 `rebuild` 中的装配辅助子职责
4. 只迁移 `startup/utils.ts` 中与启动策略解析直接相关的子职责，不迁移 `startup/gate.ts` 实现本体
5. 同步迁移边界类型文件，消除类型层 `services -> main`
6. 处理 `accountDisplay.ts` 的目录语义错误，迁到不再带有 `bootstrap` 语义的稳定边界
7. 处理 `queueCleanup`、`startup/seat`、`applyStartupSnapshotFailureState` 的目录语义问题，但不将其错误归入 `app`
8. 对 `compileIndicatorUsageProfile()` 保持“仅禁止进入 app、暂不强制再分层”的最小变更策略，避免扩 scope

阶段结果：

1. 旧目录不再承载纯装配职责

## 阶段 3：拆解 `index.ts` 中的装配段

目标：

1. monitor contexts 创建迁入 `app` 下的稳定装配子域
2. async runtime 创建迁入 `app` 下的稳定装配子域
3. lifecycle runtime 创建迁入 `app` 下的稳定装配子域
4. delayed signal handler 注册迁入 `app` 下的稳定装配子域
5. 将“正常启动链路”和“启动快照失败回退链路”都收口到 `runApp`
6. 把失败回退链路中的 `pendingOpenRebuild` 明确定义为当前触发契约，并把 `targetTradingDayKey` 明确定义为当前需保留但非直接触发条件的恢复状态字段
7. 把恢复契约定义为“快照加载链 + 状态重建链”
8. 把 lifecycle cache domains 的注册顺序定义为显式常量或唯一注册点，而不是内联数组约定
9. 保持 `src/app` 目录为最小必要形态，不再新增语义重叠的 facade 或包装层

阶段结果：

1. 顶层装配逻辑全部收口到 `app`

## 阶段 4：删除旧路径并完成全量替换

目标：

1. 删除旧装配模块
2. 删除旧路径引用
3. 删除旧类型层跨层依赖
4. 确保没有双轨并存

阶段结果：

1. `app` 成为唯一 composition layer

---

## 12. TypeScript 规范约束

本次重构必须完全遵守 `typescript-project-specifications`，至少包括：

1. 全部使用工厂函数模式，不引入 class 式 app 容器。
2. 所有依赖通过参数注入，不在 `app` 内部偷偷创建额外全局对象。
3. `app` 子域显式建立 `types.ts` 与必要的 `utils.ts`。
4. 禁止 re-export，所有模块直接从源文件 import。
5. 所有导出函数使用对象参数，避免参数超过 7 个。
6. 工厂内部不依赖闭包的 helper 必须外提到模块顶层或 `utils.ts`。
7. 文件命名保持 camelCase。
8. 不引入兼容式、补丁式和临时性代码。
9. 所有共享运行时状态类型必须进入 `types.ts`，不能在 `runApp.ts` 或各阶段 runtime 工厂文件中内联漂移。
10. 不为了满足目录对称性而拆出语义重复的工厂或 facade，目录复杂度必须服务于真实边界，而不是服务于形式整齐。
11. 同一个启动或重建调用链路内必须共享同一个时间源（在链路入口处取一次 `new Date()`，沿调用链向下传递），不能在链路中散落多处无约束的 `new Date()`。不要求引入全局时间源工厂。

特别说明：

1. `create*` 只能用于工厂函数命名。
2. 纯函数不应滥用 `create` 前缀，例如应使用 `runRuntimeSymbolValidation`，而不是 `createRuntimeValidationRunner` 这类语义漂移命名。
3. 若存在启动阶段 runtime 工厂，命名必须显式表达阶段语义，例如 `createPreGateRuntime` / `createPostGateRuntime`，避免 `createAppRuntime` 这类会遮蔽时序边界的模糊命名。

---

## 12.1 测试验收约束

本次重构不是普通目录整理，必须保留并通过以下关键回归测试语义：

1. 启动快照失败后，`pendingOpenRebuild=true`、`lifecycleState=OPEN_REBUILD_FAILED`、`isTradingEnabled=false` 的切换语义。
2. `dayLifecycleManager` 对午夜清理顺序、开盘重建逆序、失败重试退避的语义。
3. `loadTradingDayRuntimeSnapshot()` 的参数化行为，包括 `requireTradingDay`、`hydrateCooldownFromTradeLog`、`forceOrderRefresh` 等取值语义。
4. `rebuildTradingDayState()` 的重建主链路、交易日历预热、失败即中断语义。
5. `globalStateDomain` 仍然是统一的开盘重建入口，而不是被其他 cache domain 分散复制。
6. `signalRuntimeDomain` 仍然在统一重建完成后重启处理器并恢复 `refreshGate`。
7. `executeTradingDayOpenRebuild()` 与 `runtimeValidation` 的参数和输入收集语义不发生漂移。
8. 顶层装配重构后，主循环、末日保护、自动寻标一致性等关键业务场景不发生行为回归。
9. `prod / strict` 与 `dev / skip` 两套门禁模式下，启动失败后的恢复触发语义都保持与现状一致。
10. 启动失败与跨日午夜清理两条 `pendingOpenRebuild` 来源在重构后都仍然有效。
11. 启动、重建、失败回退链路的时间源语义不发生漂移。

至少应把以下现有测试纳入硬验收范围，并在重构中保持通过：

1. `tests/main/startup/utils.test.ts`
2. `tests/main/lifecycle/dayLifecycleManager.test.ts`
3. `tests/main/lifecycle/loadTradingDayRuntimeSnapshot.test.ts`
4. `tests/main/lifecycle/rebuildTradingDayState.test.ts`
5. `tests/main/lifecycle/integration.test.ts`
6. `tests/main/lifecycle/cacheDomains/globalStateDomain.test.ts`
7. `tests/main/lifecycle/cacheDomains/signalRuntimeDomain.test.ts`
8. `tests/main/lifecycle/cacheDomains/marketDataDomain.test.ts`
9. `tests/main/lifecycle/cacheDomains/orderDomain.test.ts`
10. `tests/main/lifecycle/cacheDomains/seatDomain.test.ts`
11. `tests/main/lifecycle/cacheDomains/riskDomain.test.ts`
12. `tests/integration/full-business-simulation.integration.test.ts`
13. `tests/integration/main-program-strict.integration.test.ts`
14. `tests/integration/doomsday.integration.test.ts`
15. `tests/integration/auto-search-policy-consistency.integration.test.ts`

若当前仓库尚未具备以下测试，则应在重构前补齐并纳入同级硬验收：

1. `executeTradingDayOpenRebuild()` 的参数固定语义测试
2. `runtimeValidation` 的输入收集与去重语义测试
3. 启动快照失败分支的顶层装配级测试（覆盖 `startupRebuildPending` 分支，而不仅是 `applyStartupSnapshotFailureState()`）
4. `dev / skip` 与 `prod / strict` 模式矩阵下的恢复触发测试
5. `pendingOpenRebuild` 双来源测试（启动失败 / 午夜清理）
6. 统一时间源策略测试

若重构导致这些测试文件路径变化，可以同步迁移测试，但不得降低断言强度或删除关键场景。

另外，CI 侧不能只保留 `bun lint` 与 `bun type-check`；还应增加自动循环依赖检测，防止重构后重新引入 import 环。

---

## 13. 验收标准

完成本次重构后，应满足以下标准：

1. `src/index.ts` 为薄入口
2. 顶层装配逻辑集中在 `src/app`
3. `src/main` 只保留 runtime orchestration
4. `src/app` 不包含交易规则、风控规则、策略规则
5. `src/services` 不再反向依赖 `src/main`
6. `src/main` / `src/core` / `src/services` / `src/types` 均不反向依赖 `src/app`
7. 无循环依赖
8. 无 re-export
9. 无兼容壳
10. 启动快照失败时，仍能进入 `OPEN_REBUILD_FAILED -> OPEN_REBUILDING -> ACTIVE` 的恢复链路
11. 启动快照失败时，`pendingOpenRebuild` 被明确固定为当前恢复触发契约，`targetTradingDayKey` 被明确固定为当前需保留但非直接触发条件的恢复状态字段
12. 恢复契约已明确拆分为“快照加载链 + 状态重建链”
13. lifecycle cache domains 的注册顺序与逆序重建语义被明确固定，且不再以内联数组作为唯一契约载体
14. `services -> main` 的实现层与类型层回流全部消除
15. `accountDisplay.ts` 不再留在 `bootstrap` 目录语义下
16. `compileIndicatorUsageProfile()` 等策略能力不位于 `app` 目录下
17. `startup/gate.ts`、`startup/seat.ts`、`queueCleanup.ts` 等运行能力模块未被错误迁入 `app`
18. 目录边界规则已接入 `eslint` 自动校验
19. CI 已增加自动循环依赖检测
20. `bun lint` 通过
21. `bun type-check` 通过
22. 启动流程被显式拆分为 `pre-gate runtime` 与 `post-gate runtime`
23. `app runtime` 所有权清单覆盖当前全部“顶层单次创建且跨模块共享”的运行时对象
24. `src/app` 目录保持最小必要复杂度，不存在语义重复的 facade / 工厂分层
25. `prod / strict` 与 `dev / skip` 两套门禁模式下的恢复触发语义保持一致
26. `pendingOpenRebuild` 的两条来源（启动失败 / 午夜清理）在重构后都仍然有效
27. 启动、重建、失败回退链路使用统一时间源策略，不发生时间漂移
28. `tests/main/startup/utils.test.ts` 通过
29. `tests/main/lifecycle/dayLifecycleManager.test.ts` 通过
30. `tests/main/lifecycle/loadTradingDayRuntimeSnapshot.test.ts` 通过
31. `tests/main/lifecycle/rebuildTradingDayState.test.ts` 通过
32. `tests/main/lifecycle/integration.test.ts` 通过
33. `tests/main/lifecycle/cacheDomains/globalStateDomain.test.ts` 通过
34. `tests/main/lifecycle/cacheDomains/signalRuntimeDomain.test.ts` 通过
35. `tests/main/lifecycle/cacheDomains/marketDataDomain.test.ts` 通过
36. `tests/main/lifecycle/cacheDomains/orderDomain.test.ts` 通过
37. `tests/main/lifecycle/cacheDomains/seatDomain.test.ts` 通过
38. `tests/main/lifecycle/cacheDomains/riskDomain.test.ts` 通过
39. `tests/integration/full-business-simulation.integration.test.ts` 通过
40. `tests/integration/main-program-strict.integration.test.ts` 通过
41. `tests/integration/doomsday.integration.test.ts` 通过
42. `tests/integration/auto-search-policy-consistency.integration.test.ts` 通过

---

## 14. 最终结论

新增 `src/app` 作为专门组装层，这个方向是正确的、可行的、合理的。

但只有在以下前提同时成立时，它才是一套优秀的系统性重构方案：

1. `app` 被严格定义为顶层 composition layer
2. `main` 被保留为 runtime orchestration layer
3. `core/services` 保留业务能力与基础设施职责
4. 建立刚性的单向 import 规则
5. 严格遵守 `typescript-project-specifications`
6. 全量直接迁移，不保留兼容性壳
7. 明确禁止把 runtime/business 模块迁入 `app`
8. 保留启动失败回退与开盘重建恢复的原有语义，并显式固化 `pendingOpenRebuild` 的触发契约与 `targetTradingDayKey` 的保留语义
9. 固化 lifecycle cache domains 的顺序契约
10. 同时修正目录名失真但不应迁入 `app` 的运行能力模块
11. 补齐完整的顶层运行时对象所有权清单
12. 将 `app` 目录控制在最小必要复杂度，避免为了重构再引入新的内部架构层
13. 用 lifecycle 级测试与关键业务集成测试共同约束行为不回归

因此，本次推荐的最终方案不是“把 `index.ts` 里的函数挪到 `src/app`”，而是：

“建立一个严格位于依赖图顶部、只承担顶层装配职责、具备完整 TypeScript 组织规范与单向 import 约束的 `src/app` 组装层；同时将 `main` 保持为运行时编排层，并把散落在 `index.ts`、`services/monitorContext`、`services/cleanup` 以及 `main/bootstrap` / `main/startup` 中真正属于顶层装配的子职责系统性收口到 `app` 中；对于像 `accountDisplay`、`queueCleanup`、`startup/seat`、`startup/gate` 这类被错误目录名承载但本质不属于 composition 的模块，则同步迁移或重归位到其正确的稳定边界中。”

在这个定义下，本次重构不是为重构而重构，而是一次真正解决顶层装配失序、目录语义漂移和未来依赖回流风险的优秀重构。
