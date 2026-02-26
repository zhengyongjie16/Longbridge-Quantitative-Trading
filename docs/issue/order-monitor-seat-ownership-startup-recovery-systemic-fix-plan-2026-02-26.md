# 启动阶段席位归属与未成交恢复系统性修复方案（2026-02-26 / Rev.2）

## 1. 本次更新输入

本版方案基于以下新增要求重构：

1. 启动恢复未成交订单时，不再额外调用 `todayOrders`，直接复用启动阶段已获取的 `allOrders`（全量订单中已包含未成交订单）。
2. 订单记录过滤口径从“仅已成交订单”升级为“先在全量订单中统一过滤，再按状态分流处理”，不能忽略未成交订单。
3. 未成交订单恢复监控规则更新：
   - 未成交卖单：继续监控，直到成交/撤销完成。
   - 未成交买单：必须校验是否属于“该方向该席位标的”；不属于则直接撤单。

---

## 2. 可行性与合理性结论

结论：**可行且合理，必须作为一次系统性重构落地**。

原因：

1. 现有 `loadTradingDayRuntimeSnapshot` 已返回 `allOrders`，数据源完备，满足“单快照驱动恢复”的条件。
2. 当前重复拉取 `todayOrders` 仅用于未成交恢复，属于重复 IO 和时序分叉，重构后可消除。
3. 当前订单记录重建仅消费 `Filled` 订单，导致未成交订单在重建期语义缺失；升级为“全量过滤 + 状态分流”后，业务语义完整。
4. 未成交买单在启动阶段做席位一致性校验并主动撤单，可避免错误席位继续累积风险。
5. 未成交卖单持续跟踪并在成交后更新订单记录，符合“卖出前持仓仍存在”的业务事实。
6. 通过统一失败策略（拉单失败阻断、撤单失败阻断）并进入“门禁关闭 + 持续重建重试”，可保证系统不会在“未知挂单状态”下进入运行态。

---

## 3. 现状问题与差距

### 3.1 恢复输入源不统一

当前 `orderMonitor.recoverTrackedOrders()` 内部直接调用 `ctx.todayOrders()`，与启动阶段已获取的 `allOrders` 脱节，导致：

1. 冗余 API 调用。
2. 启动链路存在两套订单快照来源，增加竞态窗口。

### 3.2 订单记录重建口径过窄

当前 `classifyAndConvertOrders()` 仅处理 `OrderStatus.Filled`，未成交订单被直接忽略，无法在重建阶段参与“是否应继续跟踪/撤单”的统一决策。

### 3.3 未成交买单缺少启动期约束

当前恢复逻辑对未成交买单默认直接恢复追踪，没有执行“方向 + 席位标的一致性”判断，不满足本次新增规则。

### 3.4 默认方向仍是核心风险

`resolveSeatOwnership()` 在失败时默认 `LONG`，违反“归属必须可证明”的不变量。

---

## 4. 重构目标与不变量

必须同时满足以下不变量：

1. `单一快照输入`：启动与开盘重建的未成交恢复，仅使用调用方传入的 `allOrders`，恢复函数内禁止再次拉单。
2. `全量过滤先行`：订单重建先在全量订单中过滤目标标的，再按状态与买卖方向分流处理。
3. `未成交卖单持续跟踪`：不做启动期过滤扣减，持续监控直至成交/撤销。
4. `未成交买单严格校验`：不属于当前方向席位标的的未成交买单，启动期直接撤单。
5. `归属不可默认`：禁止默认 LONG/SHORT；未成交卖单无法解析时阻断恢复，未成交买单无法解析按不匹配直接撤单。
6. `启动与开盘重建同构`：两条链路使用同一恢复编排和同一恢复函数。

---

## 5. 全链路重构方案

### 5.1 Trader 初始化职责重构

`createTrader()` 只负责构建模块，不再内置运行期副作用：

1. 移除 `orderMonitor.initialize()` 自动调用。
2. 移除 `orderMonitor.recoverTrackedOrders()` 自动调用。
3. 由上层显式编排调用：
   - `trader.initializeOrderMonitor()`
   - `trader.recoverOrderTrackingFromSnapshot(allOrders)`

### 5.2 统一启动/重建顺序（单管线）

启动与开盘重建统一为同一序列：

1. 初始化订单监控订阅（进入 `BOOTSTRAPPING`，仅缓存事件不落业务状态）。
2. 刷新账户与持仓。
3. 拉取 `allOrders`（history + today 去重，去重时以 today 快照或 `updatedAt` 更新更晚者为准）。
4. 恢复席位（`prepareSeatsOnStartup`）。
5. 基于 `allOrders` 重建订单记录与风险缓存。
6. 基于同一 `allOrders` 恢复未成交订单追踪。
7. 回放 BOOTSTRAPPING 队列并切换 `ACTIVE`。

强约束：

1. 第 3 步拉单失败时，启动与开盘重建均必须 fail-fast，禁止按空订单继续。
2. `ACTIVE` 只能在步骤 1-7 全部成功后进入。
3. 启动或重建任一步失败后，不进入交易态；统一进入重建失败态并由生命周期执行指数退避重试。

### 5.3 全量订单过滤与状态分流

新增“订单重建分类器”，在每个席位标的上先做全量过滤，再分流：

1. 输入：`symbol 对应的 allOrders 子集`。
2. 输出四类集合：
   - `filledBuyOrders`
   - `filledSellOrders`
   - `pendingBuyOrders`
   - `pendingSellOrders`

分流规则：

1. `filledBuyOrders`：进入买单记录候选池。
2. `filledSellOrders`：作为扣减输入，执行低价优先整笔消除过滤。
3. `pendingSellOrders`：不参与扣减，不改变持仓记录，仅进入“待恢复卖单追踪集合”。
4. `pendingBuyOrders`：不写入持仓记录，交由订单监控恢复阶段执行“匹配/撤单”决策。

实现边界：

1. 新增专用分类函数（例如 `classifyOrdersForRebuild`），避免直接改写当前 `classifyAndConvertOrders` 的语义，防止影响日内亏损等仍依赖“仅 Filled”口径的模块。

### 5.4 订单记录过滤算法升级说明

过滤目标仍是“恢复当前持仓买单记录”，但处理口径改为“全量订单先参与判定”：

1. 过滤入口不再仅看 `Filled`，而是先识别全部状态订单。
2. 真正影响持仓扣减的只有 `filledSellOrders`（因为未成交卖单在成交前不应扣减）。
3. 未成交买单不进入持仓记录（成交后由订单监控回写本地记录）。

该设计与新增业务规则完全一致，不会提前扣减持仓，也不会忽略未成交订单的处理语义。

### 5.5 未成交订单恢复策略（核心更新）

新增恢复入口：`recoverOrderTrackingFromSnapshot(allOrders)`，内部不再调用 `todayOrders`。

恢复步骤：

1. 清空 `trackedOrders` 与恢复期临时队列。
2. 从 `allOrders` 中筛出未完成订单。
3. 对每笔未完成订单执行归属判定（`monitorSymbol + direction`）。
4. 分方向处理：
   - 卖单（`side=Sell`）：直接恢复追踪；若有部分成交，同步 `executedQuantity`；恢复 `pendingSell` 占用关系，持续监控直至成交/撤销。
   - 买单（`side=Buy`）：执行“席位匹配校验”。
5. 买单席位匹配校验：
   - 必须满足：订单归属方向 = 当前席位方向，且订单 `symbol` = 该方向席位当前 `READY` 标的。
   - 满足则恢复追踪。
   - 不满足或无法解析归属则立即撤单，不进入追踪集合。

失败策略：

1. 任一“不匹配买单”撤单失败，整次恢复失败并阻断进入 `ACTIVE`，同时保持门禁关闭并进入生命周期重建重试（指数退避）。
2. 撤单成功后，该订单不得留在跟踪集合与占用集合中。

### 5.6 归属解析器收敛（禁止默认方向）

统一归属解析器用于“订单记录重建 + 未成交恢复”：

1. 主判定：`stockName + orderOwnershipMapping` 解析 `monitorSymbol + direction`。
2. 席位一致性校验：解析结果与当前席位冲突时，卖单阻断恢复，买单直接撤单。
3. 无法解析时：卖单 fail-fast，买单按不匹配处理并撤单；全程禁止默认 LONG/SHORT。

### 5.7 竞态闭环

订单监控状态机固定为：

1. `BOOTSTRAPPING`：接收推送并按 `orderId` 缓存最新事件，不直接落业务状态。
2. `ACTIVE`：恢复完成后回放缓存事件，再进入实时处理。

这样可在“不额外拉 todayOrders”的前提下，保证快照与推送最终收敛。

### 5.8 状态一致性补齐（必须落地）

为保证方案不是补丁，以下一致性改造必须与主链路同步完成：

1. `orderHoldRegistry` 增加“订单关闭”语义（Filled/Canceled/Rejected/主动撤单成功统一回收），不能仅在 Filled 时移除。
2. 恢复追踪时保留原订单时间语义：
   - `TrackedOrder.submittedAt` 使用 API 原始下单时间（可解析时），避免超时策略被重启重置。
   - `pendingSell.submittedAt` 恢复原值（可解析时），保证卖单合并/排序语义稳定。
3. 恢复结束后执行一次“跟踪集 vs 占用集”一致性校验，发现孤儿占用或孤儿跟踪直接失败。

### 5.9 幂等性与可重复执行约束

恢复函数必须满足幂等：

1. 每次恢复前清空 `trackedOrders`、恢复期临时队列、待恢复映射。
2. 对同一 `allOrders` 重复执行，输出的：
   - 跟踪订单集合
   - pendingSell 占用关系
   - 需撤单订单集合
   必须一致。
3. 回放 BOOTSTRAPPING 事件后，再执行一次快照对账；若仍不一致，阻断进入 `ACTIVE`。

对账口径补充（强约束）：

1. 本轮恢复内的“再次对账”仅允许使用内存数据：
   - 本轮输入的 `allOrders`
   - BOOTSTRAPPING 阶段缓存并回放后的订单事件
   - 当前内存中的跟踪/占用状态
2. 本轮恢复内禁止为“再次对账”额外调用 `todayOrders` 或其他订单 API。
3. 若内存对账失败，不在本轮补拉 API；直接失败并交给生命周期下一轮重建重试（下一轮可重新拉取最新 `allOrders`）。

### 5.10 阻断与重建重试策略（最终决策）

本方案明确采用：

1. `撤单失败不允许运行`：禁止“后台继续尝试撤单但先放行交易”。
2. `阻断后持续重建`：失败后保持 `isTradingEnabled=false`，交由生命周期重建机制持续重试，直至恢复成功。
3. `一致性优先于可用性`：短时不可交易可接受，但不允许在不确定挂单状态下继续交易。

---

## 6. 关键接口与模块改造清单

1. `src/core/trader/index.ts`
   - 移除创建期自动恢复。
   - 暴露显式初始化/恢复 API（按新顺序由上层调用）。
2. `src/core/trader/orderMonitor.ts`
   - `recoverTrackedOrders()` 改为 `recoverOrderTrackingFromSnapshot(allOrders)`。
   - 删除恢复函数内 `ctx.todayOrders()` 调用。
   - 增加 BOOTSTRAPPING 事件队列与买单不匹配撤单逻辑。
3. `src/core/orderRecorder/utils.ts`
   - 将“仅 Filled 分类”升级为“全量分类 + 状态分流”工具函数。
4. `src/core/orderRecorder/index.ts`
   - 刷新订单记录时接入新分类结果。
   - 明确 pending buy/sell 在重建中的不同处理语义。
5. `src/main/lifecycle/rebuildTradingDayState.ts`
   - 在订单记录重建后，调用 `recoverOrderTrackingFromSnapshot(allOrders)`。
6. `src/types/services.ts` 与 `src/core/trader/types.ts`
   - 更新 Trader/OrderMonitor 接口签名，统一快照驱动恢复。
7. `src/core/orderRecorder/orderApiManager.ts`
   - 修正 history/today 去重策略，确保 pending 判断基于最新状态快照。
8. `src/core/trader/orderHoldRegistry.ts`
   - 增加取消/拒绝/主动撤单后的回收接口，保证 holdSymbols 不残留僵尸订单。
9. `src/index.ts` 与 `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts`
   - 启动阶段改为与开盘重建一致的失败语义：失败后进入重建重试流程，而非按空快照继续或直接进入交易态。

---

## 7. 测试与验收

### 7.1 单元测试

1. 全量分类器：同一 symbol 下可正确输出 filled/pending + buy/sell 四类集合。
2. 恢复函数：不依赖 `todayOrders`，仅使用传入 `allOrders`。
3. 买单匹配规则：匹配则恢复，不匹配则触发撤单。
4. 卖单恢复：部分成交数量、pendingSell 关联恢复正确。
5. 去重优先级：history 与 today 同 orderId 时，使用最新状态（today 或 updatedAt 更晚）。
6. 撤单失败策略：不匹配买单撤单失败时，恢复流程返回失败并阻断激活。
7. 状态回收：Canceled/Rejected/主动撤单成功后，orderHoldRegistry 与 trackedOrders 同步回收。
8. submittedAt 恢复：重启后超时判断基线不被重置。
9. 生命周期重试协同：恢复失败后门禁保持关闭，直到下一次重试成功才可激活。

### 7.2 集成测试

1. 启动存在未成交卖单：持续监控，成交后本地订单记录正确扣减。
2. 启动存在未成交买单且不属于当前席位：启动阶段自动撤单。
3. 启动存在未成交买单且属于当前席位：继续跟踪，成交后正确新增买单记录。
4. 启动与开盘重建复测上述场景，结果一致。
5. 启动阶段拉单失败：流程阻断，不进入运行态。
6. BOOTSTRAPPING 回放后对账：快照与推送交错情况下最终收敛且无残差。
7. 启动阶段撤单失败：进入重建失败态并按指数退避自动重试，期间不可交易。

### 7.3 回归测试

1. 智能平仓防重（`relatedBuyOrderIds`）不回归。
2. 日内亏损偏移重建不回归。
3. 浮亏缓存重建与成交后刷新不回归。

---

## 8. 分阶段实施计划

1. 阶段 A：抽离 `createTrader` 副作用，建立显式初始化/恢复入口。
2. 阶段 B：落地全量分类器与订单记录分流重建。
3. 阶段 C：完成 `recoverOrderTrackingFromSnapshot(allOrders)` 与买单不匹配撤单。
4. 阶段 D：接入 BOOTSTRAPPING/ACTIVE 状态机并完成事件回放。
5. 阶段 E：统一启动与开盘重建调用链，完成全量测试验收。

---

## 9. 通过/失败标准

通过标准：

1. 启动恢复未成交订单不再触发额外 `todayOrders` 调用。
2. 不存在“归属失败默认 LONG/SHORT”路径。
3. 未成交卖单全部持续跟踪，成交后正确更新订单记录。
4. 未成交买单全部执行席位匹配校验，不匹配订单被自动撤销。
5. 启动与开盘重建使用同一恢复函数与同一时序。
6. history/today 去重后 pending 状态与交易端一致（无旧状态覆盖新状态）。
7. 任一关键失败（拉单失败、撤单失败、对账失败）均阻断进入 `ACTIVE`。
8. 重试期间 `isTradingEnabled` 始终为 `false`，直至一次完整重建成功。

失败标准：

1. 恢复阶段仍二次拉取 `todayOrders`。
2. 未成交买单未做匹配校验或不匹配未撤单。
3. 未成交卖单在重建阶段被提前扣减持仓。
4. 启动与开盘重建出现分叉逻辑。
5. history/today 去重仍以旧状态覆盖新状态，导致 pending 识别偏差。
6. 关键失败后仍进入 `ACTIVE`（未阻断运行态）。
7. 撤单失败后系统仍继续交易（存在“失败但放行”路径）。
