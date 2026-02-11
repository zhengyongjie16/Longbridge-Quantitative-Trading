# 7x24 跨日缓存生命周期重构 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将系统从“分散跨日复位”重构为“统一交易日生命周期管理”，实现 7x24 连续运行下的缓存新鲜度、状态一致性和可恢复性，且不引入补丁式兼容路径。  

**Architecture:** 以“统一生命周期状态机 + 缓存域（Cache Domain）标准接口 + 双阶段跨日策略（00:00 清理 / 开盘重建）”为核心。启动初始化与跨日后开盘初始化复用同一条重建流水线，所有交易相关处理器在重建窗口内受全局门禁约束，保证不读旧缓存、不执行旧信号。  

**Tech Stack:** TypeScript (ES2022), Node.js, LongPort OpenAPI SDK, 现有异步队列架构（Buy/Sell/MonitorTask Processor, OrderMonitorWorker, PostTradeRefresher）, RefreshGate。  

---

## 一、需求复述与硬约束

### 1.1 目标约束（必须同时满足）

1. 程序可 7x24 连续运行，不依赖每日重启。  
2. 跨日后必须清理应失效缓存，避免旧交易日状态污染。  
3. 下次开盘前后必须按新交易日重建关键缓存，且与启动初始化逻辑一致。  
4. 方案必须系统化、完整化，不允许“某模块加个 if new day”的补丁式修补。  
5. 在任意失败场景（API 失败、网络抖动）下，宁可暂停交易，也不能错单/乱单。  

### 1.2 非目标（本计划明确不做）

1. 不改变交易策略本身（买卖信号生成逻辑不变）。  
2. 不改变风控阈值含义（只改变缓存生命周期和重建时序）。  
3. 不引入“双路径长期并存”（旧跨日路径与新路径不能长期共存）。  

---

## 二、现状复核（基于当前代码）

### 2.1 目前跨日行为（不足点）

当前 `mainProgram` 中跨日检测仅做了局部复位：

- `lastState.currentDayKey` 切换；
- `lastState.cachedTradingDayInfo/canTrade/isHalfDay/openProtectionActive` 置空；
- `dailyLossTracker.resetIfNewDay()` 由主循环每秒调用；
- `autoSymbolManager.resetDailySwitchSuppression()` 清日内抑制。

问题：该逻辑未统一覆盖订单运行态、任务队列、延迟验证队列、席位换标状态机、API 层缓存与行情缓存，属于“局部 reset”，不满足 7x24 全局一致性要求。

### 2.2 当前启动初始化（可复用能力）

`src/index.ts` 启动流程已具备重建所需关键动作：

- 刷新账户/持仓；
- 拉取全量订单并初始化 `dailyLossTracker`；
- `prepareSeatsOnStartup` 完成席位恢复/自动寻标；
- 初始化并订阅行情/K 线；
- 初始化订单记录、浮亏数据、风险侧牛熊证信息；
- 启动异步处理器（Buy/Sell/MonitorTask/OrderMonitorWorker/PostTradeRefresher）。

结论：现有启动链条已经是“开盘重建”天然模板，可直接抽象复用。

### 2.3 当前退出清理（可借鉴能力）

`cleanup` 在进程退出时已做：

- 停止异步处理器；
- 销毁 delayed verifier；
- 清空 `indicatorCache`；
- 释放 monitor snapshots。

结论：已有“停机清理”模式可借鉴为“跨日软重置（不中断进程）”。

---

## 三、缓存全景与生命周期分域

本节将缓存按“业务域 + 生命周期”划分，作为后续统一重构边界。

### Domain A：信号与异步任务运行态（高时效、跨日必失效）

- `buyTaskQueue` / `sellTaskQueue` / `monitorTaskQueue` 内部队列数组；
- `delayedSignalVerifier.pendingSignals`；
- `indicatorCache.buffers`；
- `postTradeRefresher.pendingSymbols/latestQuotesMap/pendingVersion`；
- `orderMonitorWorker.latestQuotes`；
- 各 processor 的调度状态（running/inFlight）。

**跨日策略：** 00:00 必清 + 开盘后重建为空态（等待新 tick 写入）。

### Domain B：席位与自动换标运行态（交易日绑定）

- `symbolRegistry`（seat state + version）；
- `autoSymbolManager.switchStates`；
- `autoSymbolManager.switchSuppressions`；
- `warrantListCache.entries/inFlight`。

**跨日策略：**
- `switchStates/suppressions` 00:00 必清；
- `seat state` 开盘按“启动席位逻辑”整体重建；
- `warrantList cache` 00:00 清空（避免旧盘面选择偏差）。

### Domain C：订单与挂单运行态（需权威数据重建）

- `orderStorage`：long/short 买卖记录 + `pendingSells`；
- `orderApiManager.ordersCache/allOrdersCache`；
- `orderCacheManager.pendingOrdersCache`；
- `orderHoldRegistry`（orderId/symbol 双向索引 + holdSymbols）；
- `orderMonitor.trackedOrders`；
- `orderExecutor.lastBuyTime`。

**跨日策略：**
- 00:00 清空运行态；
- 开盘后强制从全量订单 + 今日待成交订单重建。

### Domain D：风控态（交易日语义强）

- `dailyLossTracker.statesByMonitor/dayKey`；
- `signalProcessor.lastRiskCheckTime`；
- `unrealizedLossChecker.unrealizedLossData`；
- `warrantRiskChecker.long/short warrant info`；
- `liquidationCooldown.cooldownMap`（策略相关，需按 mode 处理）。

**跨日策略：**
- `dailyLossTracker` 00:00 清 + 开盘重建；
- `lastRiskCheckTime` 00:00 清；
- `unrealizedLossData` 00:00 清 + 开盘刷新；
- `warrant info` 00:00 清 + 开盘按席位重建；
- `cooldownMap` 按配置 mode 执行策略清理（见后文）。

### Domain E：行情与交易日缓存

- `quoteClient.quoteCache/prevCloseCache/staticInfoCache/subscribedSymbols/subscribedCandlesticks`；
- `quoteClient.tradingDayCache`（24h TTL）；
- `lastState.cachedTradingDayInfo/allTradingSymbols`。

**跨日策略：**
- 00:00 清交易日相关状态与订阅集合快照；
- 开盘后按目标标的全集重新订阅并重建日基线。

### Domain F：可长期保留但需监控边界

- 对象池（signal/position/kdj/macd/period 等）；
- `rateLimiter.callTimestamps`（窗口内自然清理）；
- `positionCache`（开盘后会被新持仓覆盖）。

**跨日策略：**
- 不做强制清空；
- 保证“借出-释放”闭环与长期运行监控。

---

## 四、00:00 清理 + 开盘重建：两阶段生命周期方案

### 4.1 阶段 A：00:00 硬清理（跨日立即执行）

目标：将“日内运行态”归零，设置 `pendingOpenRebuild = true`，并锁交易。

**必须执行动作：**

1. **进入重置门禁**  
   - `canTrade = false`；  
   - 生命周期状态置为 `MIDNIGHT_CLEANED`；  
   - 拒绝新任务入队（或入队后立即丢弃并记录原因）。

2. **停止并排空异步运行态**  
   - 停止 Buy/Sell/MonitorTask/OrderMonitorWorker/PostTradeRefresher 调度；  
   - 清理三类任务队列；  
   - `delayedSignalVerifier.cancelAllForSymbol` 全量执行；  
   - `indicatorCache.clearAll()`。

3. **清理席位与自动换标临时态**  
   - 清 `switchStates`、`switchSuppressions`；  
   - 清 warrant list 缓存。

4. **清理订单与风控运行态**  
   - 清 order recorder/storage/API caches；  
   - 清 order hold registry 与 tracked orders；  
   - 清 `lastBuyTime`、`lastRiskCheckTime`、`unrealizedLossData`；
   - `dailyLossTracker` 仅保留 dayKey 或整体重置（建议整体）。

5. **清理交易日相关状态**  
   - `lastState.cachedTradingDayInfo = null`；  
   - `lastState.isHalfDay/canTrade/openProtectionActive = null`；  
   - 重置订阅目标集合快照。

6. **设置跨日标记**  
   - `pendingOpenRebuild = true`；  
   - 记录 `targetTradingDayKey`（跨日后目标日）。

### 4.2 阶段 B：开盘重建（触发一次）

触发条件：`canTradeNow = true && pendingOpenRebuild = true`。

**重建顺序（必须严格顺序）：**

1. 刷新交易日信息（含半日市判断）；  
2. 强制刷新账户/持仓；  
3. 拉取全量订单并重建 `dailyLossTracker`；  
4. 执行 `prepareSeatsOnStartup` 语义等价流程（不依赖历史进程态）；  
5. 重建行情/K 线订阅并初始化 `allTradingSymbols`；  
6. 刷新订单记录（按席位）与 pending hold registry；  
7. 刷新浮亏缓存、牛熊证信息缓存；  
8. 重启异步处理器；  
9. `refreshGate.markFresh(latestStaleVersion)`，释放等待；  
10. 清除 `pendingOpenRebuild`，生命周期状态回 `ACTIVE`。

**失败处理：**

- 任一步失败：保持 `canTrade=false`；  
- 进入 `OPEN_REBUILD_FAILED`，按退避重试；  
- 成功前禁止买卖任务执行。

---

## 五、统一生命周期架构设计（系统性重构核心）

### 5.1 新增模块边界

建议新增：

- `src/main/lifecycle/dayLifecycleManager.ts`
- `src/main/lifecycle/cacheDomains/*.ts`
- `src/main/lifecycle/types.ts`

### 5.2 核心接口

```ts
type LifecycleState =
  | 'ACTIVE'
  | 'MIDNIGHT_CLEANING'
  | 'MIDNIGHT_CLEANED'
  | 'OPEN_REBUILDING'
  | 'OPEN_REBUILD_FAILED';

interface CacheDomain {
  name: string;
  midnightClear(ctx: LifecycleContext): Promise<void> | void;
  openRebuild(ctx: LifecycleContext): Promise<void> | void;
}

interface DayLifecycleManager {
  tick(now: Date, runtime: RuntimeFlags): Promise<void>;
  getState(): LifecycleState;
  isTradingEnabled(): boolean;
}
```

### 5.3 缓存域实现建议

- `SignalRuntimeDomain`：队列、verifier、indicator、worker runtime；
- `SeatDomain`：symbolRegistry、autoSymbolManager、warrantList cache；
- `OrderDomain`：orderRecorder/orderMonitor/orderHold/orderCache；
- `RiskDomain`：dailyLoss/riskCooldown/unrealized/warrant info；
- `MarketDataDomain`：quote/kline/tradingDay/subscriptions；
- `GlobalStateDomain`：lastState 日级字段与 gate 标志。

### 5.4 统一门禁策略

`mainProgram` 与 `processMonitor` 执行前均依赖 `dayLifecycleManager.isTradingEnabled()`。  
当生命周期不在 `ACTIVE` 时，生成信号或入队动作直接拒绝，避免“清理中写入新脏数据”。

---

## 六、需要新增/改造的关键接口清单

为避免“靠内部变量隐式重置”，必须补齐以下显式 API：

### 6.1 Signal / Processor 侧

- `SignalProcessor.resetRiskCheckCooldown(): void`
- `OrderExecutor.resetBuyThrottle(): void`
- `Buy/Sell/MonitorTaskProcessor.restart(): void`（或 stop+start 封装）

### 6.2 订单域

- `OrderHoldRegistry.clear(): void`
- `OrderMonitor.clearTrackedOrders(): void`
- `OrderRecorder.resetAll(): void`（清 storage + api cache + pending sells）
- `OrderCacheManager.clearCache()`（已有，可纳入生命周期调用）

### 6.3 风控域

- `RiskChecker.clearUnrealizedLossData(symbol?)` 或全量清理接口
- `DailyLossTracker.resetAll(now: Date): void`（显式语义）

### 6.4 行情与自动寻标域

- `MarketDataClient.resetRuntimeSubscriptionsAndCaches(): Promise<void>`
- `WarrantListCache.clear(): void`
- `AutoSymbolManager.resetAllState(): void`（含 switchStates + suppressions）

### 6.5 状态域

- `resetMonitorStateForNewDay(monitorState)`（释放 snapshot + 清空字段）

---

## 七、可行性分析（技术可实现性）

### 7.1 为什么可行

1. 现有代码已有“启动重建链路”，跨日只需抽象并复用，不需重写业务策略。  
2. 多数关键缓存已有 clear/refresh 雏形（indicatorCache.clearAll、queue remove、dailyLoss initialize/recalc、orderRecorder refresh）。  
3. RefreshGate 已具备版本门禁能力，可直接作为重建期间一致性屏障。  
4. 当前异步处理器是模块化注入结构，适合引入生命周期管理器统一编排。  

### 7.2 主要实现难点与解决

1. **难点：处理器并发竞态**  
   - 解决：重建前先 stop，全局门禁阻止入队；重建完成后 restart。

2. **难点：订单相关缓存多点维护**  
   - 解决：以 `OrderDomain` 统一封装 clear/rebuild，不允许业务层分散调用。

3. **难点：席位与订单归属一致性**  
   - 解决：重建顺序固定为“席位先恢复 -> 再按席位刷新订单记录 -> 再刷风控”。

4. **难点：失败恢复**  
   - 解决：重建失败不放行交易，自动重试；状态机显式可观测。

---

## 八、合理性分析（方案优于替代方案）

### 8.1 方案对比

1. **仅在 mainProgram 继续加跨日 if-reset（不推荐）**  
   - 缺点：新增一个模块就可能漏 reset；长期演进不可控；典型补丁式。

2. **只做 00:00 清理，不做开盘重建（不推荐）**  
   - 缺点：开盘后会进入“空缓存运行”，风险与订单状态不完整。

3. **只做开盘重建，不做 00:00 清理（不推荐）**  
   - 缺点：午夜至开盘窗口仍保留旧状态，内存和行为漂移不可控。

4. **本方案：双阶段 + 统一生命周期（推荐）**  
   - 优点：语义清晰，可观测、可测试、可扩展，且与启动流程统一。

### 8.2 对 7x24 的长期收益

- 内存曲线稳定（避免 map/set 长期漂移）；  
- 跨日状态可预测（单一入口、单一真相）；  
- 故障恢复简单（失败保持冻结，成功一次性恢复）；  
- 便于未来新增缓存域时统一纳入治理。

---

## 九、正确性不变量（必须落地为测试）

1. **跨日原子性**：每个交易日最多一次午夜清理、每次开盘最多一次重建。  
2. **交易门禁**：`MIDNIGHT_CLEANED/OPEN_REBUILDING/OPEN_REBUILD_FAILED` 状态下不得执行交易。  
3. **席位一致性**：重建完成前不得以旧 seatVersion/旧 symbol 执行信号。  
4. **缓存一致性**：重建后 `dailyLoss/unrealized/order recorder` 必须来自同一批订单快照。  
5. **刷新门禁一致性**：任何读取持仓/浮亏缓存的异步路径必须先 `waitForFresh`。  
6. **资源回收闭环**：跨日清理移除的 signal/position/snapshot 均回对象池，无泄漏。  

---

## 十、实施任务拆解（按文件与模块）

### Task 1：建立生命周期框架

**Files:**
- Create: `src/main/lifecycle/types.ts`
- Create: `src/main/lifecycle/dayLifecycleManager.ts`
- Modify: `src/main/mainProgram/index.ts`
- Modify: `src/main/mainProgram/types.ts`

**目标：** 建立状态机与门禁，接管跨日触发入口。

### Task 2：实现 SignalRuntimeDomain

**Files:**
- Create: `src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts`
- Modify: `src/main/asyncProgram/*`（暴露 reset/restart 所需接口）
- Modify: `src/main/processMonitor/signalPipeline.ts`

**目标：** 队列/延迟验证/indicator/runtime 状态可统一清理。

### Task 3：实现 OrderDomain

**Files:**
- Create: `src/main/lifecycle/cacheDomains/orderDomain.ts`
- Modify: `src/core/trader/orderHoldRegistry.ts`
- Modify: `src/core/trader/orderMonitor.ts`
- Modify: `src/core/orderRecorder/index.ts` / `orderStorage.ts` / `orderApiManager.ts`

**目标：** 订单域支持 midnight clear + open rebuild。

### Task 4：实现 RiskDomain

**Files:**
- Create: `src/main/lifecycle/cacheDomains/riskDomain.ts`
- Modify: `src/core/signalProcessor/index.ts`
- Modify: `src/core/trader/orderExecutor.ts`
- Modify: `src/core/riskController/*`
- Modify: `src/services/liquidationCooldown/index.ts`

**目标：** 风控缓存按日清理与重建路径显式化。

### Task 5：实现 SeatDomain + MarketDataDomain

**Files:**
- Create: `src/main/lifecycle/cacheDomains/seatDomain.ts`
- Create: `src/main/lifecycle/cacheDomains/marketDataDomain.ts`
- Modify: `src/services/autoSymbolManager/*`
- Modify: `src/services/autoSymbolFinder/*`
- Modify: `src/services/quoteClient/index.ts`
- Modify: `src/main/startup/seat.ts`

**目标：** 席位/订阅/行情缓存统一由生命周期驱动。

### Task 6：统一“启动初始化”和“开盘重建”入口

**Files:**
- Create: `src/main/lifecycle/rebuildTradingDayState.ts`
- Modify: `src/index.ts`
- Modify: `src/main/startup/*`

**目标：** 消除双套初始化逻辑，复用同一流程。

### Task 7：验证与回归

**Files:**
- Create: `tests/lifecycle/*.test.ts`
- Modify: `tests/*`（按现有测试体系）

**目标：** 覆盖跨日、开盘、失败重试、并发竞态与长稳场景。

---

## 十一、测试与验收计划

### 11.1 单元测试（建议最小集）

1. 生命周期状态机转换测试；  
2. 各 Domain 的 `midnightClear/openRebuild` 顺序与幂等测试；  
3. 重建失败后 `canTrade=false` 保证测试；  
4. queue/verifier/snapshot 资源释放测试。

### 11.2 集成测试

1. 模拟跨日 -> 开盘，验证只触发一次重建；  
2. 模拟开盘重建中 API 失败 -> 重试成功；  
3. 模拟跨日时仍有旧任务/旧信号，验证不会执行交易。

### 11.3 长稳压测

1. 连续运行 72 小时（含至少 2 次跨日）；  
2. 观测 map/set 大小曲线不单调增长；  
3. 观测内存无持续爬升（对象池借还平衡）。

### 11.4 验收标准（全部满足才通过）

1. 跨日后至开盘前系统不交易，且无错误订单；  
2. 开盘后缓存来自新交易日权威数据；  
3. 无旧席位信号落单；  
4. 无明显内存泄漏与状态漂移。

---

## 十二、风险清单与缓解策略

1. **风险：重建窗口遗漏门禁导致意外下单**  
   - 缓解：全局 `isTradingEnabled` 强约束 + 关键路径断言日志。

2. **风险：订单域重建顺序错乱导致成本/浮亏异常**  
   - 缓解：固定“订单 -> dailyLoss -> unrealized”顺序并加集成断言。

3. **风险：行情订阅集合与运行态不一致**  
   - 缓解：重建前退订旧集合，重建后按目标集合一次性订阅。

4. **风险：`liquidationCooldown` 跨日策略不一致**  
   - 缓解：按 mode 明确规则并写入测试（minutes/half-day/one-day）。

---

## 十三、结论

该重构方案在现有代码基础上**可行且合理**，并且是满足你要求的“系统性、完整性”路径：

1. 以统一生命周期内核替代分散 reset，消除补丁式维护；  
2. 用双阶段跨日策略保证 7x24 下的缓存新鲜与行为一致；  
3. 用状态机+门禁+重建失败冻结机制保证逻辑正确与交易安全；  
4. 用域化接口和测试不变量保证长期可演进与可验证。  

---

## Execution Handoff

Plan complete and saved to `docs/plans/2026-02-11-7x24-cache-lifecycle-refactor.md`. Two execution options:

1. **Subagent-Driven (this session)** — 按任务逐个实现，每步完成后即时复核。  
2. **Parallel Session (separate)** — 新会话按 executing-plans 批量执行并在里程碑回报。  

请选择执行方式。
