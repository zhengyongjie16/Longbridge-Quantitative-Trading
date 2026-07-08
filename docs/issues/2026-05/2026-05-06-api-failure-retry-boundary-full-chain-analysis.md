# API 请求失败重试边界全链路分析与修复方案

**日期:** 2026-05-06

**审查范围:** 系统级时间唤醒、启动快照、生命周期重建、末日保护、订单缓存、自动寻标、异步任务处理器，以及直接调用 Longbridge SDK / MarketDataClient / Trader 的外部 API 边界。

## 1. 结论先行

当前程序确实存在两类边界错位：

1. **外部 API 请求失败可能被升级为进程级 fatal。**
   - 典型链路是 `marketDataClient.isTradingDay(...)` 或末日保护 API 失败，沿 `timeWakeupEvaluationProgram -> TimeWakeupRuntime.failFatal -> runApp -> index.ts process.exit(1)` 退出程序。
   - 这不符合“API 请求失败允许显式重试，不应直接导致程序退出”的要求。

2. **部分非 API 错误或权威事实不可确认被兜底成空事实、失败计数或普通任务失败。**
   - `todayOrders()` 失败被转换成 `[]`。
   - `todayOrders()` 返回非数组也被转换成 `[]`。
   - 启动快照失败返回 `allOrders: []` 与 `quotesMap: new Map()`。
   - 自动寻标 catch all 后把异常压成“无候选”，可能累计失败次数并冻结席位。
   - 生命周期重建 catch all 后统一进入 retry，可能把内部逻辑错误当作可恢复 API 失败。

因此，本次修复不应是“所有错误都重试”，也不应是“所有错误都不退出”。正确边界是：

```text
外部 API 请求失败
  -> 显式分类
  -> 有限重试或事件驱动 retry
  -> 不伪造空事实
  -> 不直接进程退出

非 API 程序错误 / 契约错误 / 状态不变量错误 / 非法计划
  -> fail-fast
  -> 不进入兜底、回退、重试
```

## 2. 错误分类边界

### 2.1 可进入 retry 的错误

只允许以下错误进入显式 retry：

- Longbridge SDK 网络请求失败。
- Longbridge SDK 请求被外部服务临时拒绝或超时。
- `marketDataClient`、`trader`、底层 `ctx.*` 真实请求失败。
- 订阅、退订、行情、交易日、账户、持仓、订单列表、订单详情等外部请求失败。

这些错误应统一表达为：

```text
ExternalApiRequestError
```

它表示“外部权威事实本轮不可确认”，而不是“事实为空”。

### 2.2 必须 fail-fast 的错误

以下错误不允许 retry：

- API 返回结构不符合内部契约，例如 `todayOrders()` 返回非数组。
- 时间唤醒计划非法，例如 `nextWakeupAtMs` 非有限数值。
- 交易日重建时返回“不是交易日”。这是业务事实与触发条件冲突，不是 API 请求失败。
- 空账户、持仓结构非法、配置错误。
- 本地订单同步失败，例如远端已提交但本地 `orderMonitor.trackOrder(...)` 失败。
- 状态机字段缺失、seatVersion 不变量破坏、重复交易标的映射等程序逻辑错误。
- TypeError、ContractError、InvariantError 等内部错误。

### 2.3 普通业务无结果

以下情况也不是 API 请求失败：

- realtime 暂无数据。
- 行情价格无效。
- 自动寻标没有候选。
- 无可处理持仓。
- 没有未成交订单。

这些应由显式业务结果表达，不能抛成 API 错误，也不能和 API 请求失败混用。

## 3. 当前全链路问题分析

## 3.1 时间唤醒 runtime 把所有评估异常都升级为 fatal

**位置:**

- `src/main/timeWakeupRuntime/index.ts:53`
- `src/main/timeWakeupRuntime/index.ts:74`
- `src/main/timeWakeupRuntime/index.ts:127`
- `src/main/timeWakeupRuntime/index.ts:132`
- `src/main/timeWakeupRuntime/index.ts:136`
- `src/main/timeWakeupRuntime/index.ts:187`

当前 `runEvaluationLoop()` 中：

```text
deps.evaluate() 抛出任意错误
  -> catch
  -> failFatal(error)
  -> running=false
  -> 清理 timer
  -> drainFatalError() reject
```

随后 `runApp` 中：

- `src/app/runApp.ts:276`
- `src/app/runApp.ts:308`

会通过 `Promise.race([... timeWakeupRuntime.drainFatalError()])` 接收 fatal。最终 `src/index.ts:14` 到 `src/index.ts:29` 捕获并 `process.exit(1)`。

**问题本质:**

`TimeWakeupRuntime` 当前只知道“evaluate 抛错”，不知道这是外部 API 临时失败还是内部逻辑错误。于是 API 请求失败会被误判成系统级不可恢复错误。

**正确边界:**

`TimeWakeupRuntime` 仍应保留 fail-fast 能力，但 fatal 只用于：

- 非 API 错误从 `evaluate()` 抛出。
- 调度计划非法。
- runtime 自身状态不变量破坏。

外部 API 请求失败不应从 `evaluate()` 以普通异常形式逃逸到 `TimeWakeupRuntime`，而应在 `timeWakeupEvaluationProgram` 中转成明确的 `API_RETRY` 候选。

## 3.2 交易日 API 失败会导致进程退出

**位置:** `src/main/timeWakeupEvaluationProgram/index.ts:235`

当前链路：

```text
timeWakeupEvaluationProgram
  -> marketDataClient.isTradingDay(currentTime)
  -> API 请求失败抛出
  -> TimeWakeupRuntime.failFatal
  -> runApp cleanup
  -> index.ts process.exit(1)
```

**业务影响:**

交易日信息是系统级权威事实，但 API 临时失败并不意味着程序逻辑错误。正确行为应是：

1. 不更新 `lastState.cachedTradingDayInfo`。
2. 不把交易日默认成 true 或 false。
3. 不更新 `lastState.canTrade`。
4. 不 emit gate change。
5. 不继续执行依赖交易日事实的生命周期和末日保护。
6. 安排下一次 API retry。

**不能采用的做法:**

- 失败时默认 `isTradingDay=true`。
- 失败时默认 `isTradingDay=false`。
- 沿用上一日缓存跨日继续。
- 继续执行 doomsday 或 lifecycle。

这些都会把“事实不可确认”伪装成某种事实。

## 3.3 末日保护 API 失败会导致 fatal 或伪成功

### 3.3.1 买入截止窗口未成交订单查询失败

**位置:** `src/core/doomsdayProtection/index.ts:496`

当前 `cancelPendingBuyOrders(...)` 首次进入窗口时调用：

```text
trader.getPendingOrders(symbolsArray, true)
```

`trader.getPendingOrders(...)` 当前最终依赖 `orderCacheManager.getPendingOrders(...)`。而 `orderCacheManager` 在 API 失败时会返回 `[]`，导致末日保护认为“无未成交买入订单”。

这不是 retry 问题，而是空事实兜底问题。

### 3.3.2 撤单单笔 API 失败被吞掉

**位置:** `src/core/doomsdayProtection/index.ts:513`

当前每笔撤单：

```text
try trader.cancelOrder(order.orderId)
catch -> logger.warn -> continue
```

并且 `cancelCheckExecutedDate` 在查询未成交订单后即设置：

- `src/core/doomsdayProtection/index.ts:498`

如果某笔撤单 API 失败，本窗口后续不会再执行买入截止检查。这会把“撤单结果不可确认”压成“本日已检查完成”。

**正确边界:**

- `cancelCheckExecutedDate` 只能表示“本日买入截止检查已权威完成”。
- 若未成交订单查询 API 失败，不应设置。
- 若部分撤单 API 失败，不应设置为完成；应返回 `nextRetryAtMs` 或记录待重试订单集合。
- 撤单重试必须基于订单 ID 重新执行可幂等撤单或先做 `orderDetail` 权威确认。

### 3.3.3 清仓行情和下单 API 失败

**位置:**

- `src/core/doomsdayProtection/index.ts:295`
- `src/core/doomsdayProtection/index.ts:356`

当前清仓流程：

```text
batchGetQuotes(...)
  -> marketDataClient.getQuotes(...)
  -> 抛错时向外传播
  -> timeWakeupEvaluationProgram
  -> TimeWakeupRuntime.failFatal
```

以及：

```text
trader.executeSignals(uniqueClearanceSignals)
  -> submitOrder / local sync / API 失败
  -> 抛错时向外传播
  -> TimeWakeupRuntime.failFatal
```

**正确边界:**

- 行情 API 失败：返回清仓 API retry，不 fatal。
- 行情缺失或价格无效：不是 API 失败，继续使用现有 quote retry 语义。
- 下单 API 失败：不能盲目重试同一组 signal，因为 `submitOrder` 属于可能产生远端副作用的非幂等操作。下一次 retry 必须重新读取权威持仓、订单或等待 WS 事实后再生成清仓动作。

## 3.4 生命周期重建 catch all 会把非 API 错误也重试

**位置:**

- `src/app/startup/startupSnapshot.ts:29`
- `src/app/startup/startupSnapshot.ts:45`
- `src/main/lifecycle/dayLifecycleManager.ts:189`
- `src/main/lifecycle/dayLifecycleManager.ts:198`

当前启动快照：

```text
loadTradingDayRuntimeSnapshot 抛任意错误
  -> catch
  -> applyStartupSnapshotFailureState
  -> 返回 allOrders: [] / quotesMap: new Map()
  -> startupRebuildPending=true
```

当前开盘重建：

```text
runOpenRebuildForDomains 抛任意错误
  -> catch
  -> OPEN_REBUILD_FAILED
  -> nextRetryAtMs
```

**问题本质:**

这会把两类完全不同的问题混为一类：

1. API 请求失败：可恢复，应关闭交易门禁并等待重建。
2. 内部逻辑错误：不可恢复，应 fail-fast。

例如 `prepareSeatsForRuntime(...)` 中如果存在状态不变量错误，当前也可能被开盘重建 retry 吞掉，形成无限重试的“程序 bug 伪装成外部失败”。

**正确边界:**

- catch `ExternalApiRequestError`：进入 pending / retry。
- catch 其他错误：重新抛出，交给顶层 fail-fast。

## 3.5 启动快照返回空快照会污染语义

**位置:** `src/app/startup/startupSnapshot.ts:48`

当前启动快照失败返回：

```text
allOrders: []
quotesMap: new Map()
startupRebuildPending: true
```

虽然 `runApp` 后续会用 `startupRebuildPending` 跳过运行时标的验证和初次重建，但 `allOrders=[]`、`quotesMap=new Map()` 仍然把“启动事实不可用”表示成“事实为空”。这会增加后续调用误用风险。

**更合理的结果类型:**

把 `StartupSnapshotResult` 改成显式 discriminated union：

```text
{ kind: 'READY'; allOrders; quotesMap; now }
{ kind: 'API_RETRY_PENDING'; now }
```

这样 pending 分支不携带伪空事实。所有消费方必须先判断 `kind`，不能误用空数组或空 Map。

## 3.6 交易日快照加载允许按空订单继续初始化

**位置:**

- `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts:153`
- `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts:157`
- `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts:161`

当前存在：

```text
failOnOrderFetchError=false
  -> 全量订单获取失败
  -> warn
  -> allOrders=[]
  -> 继续 prepareSeatsForRuntime
```

这会把“订单事实不可确认”伪装成“没有订单”。对席位恢复、订单持有标的、保护性清仓边界、水合冷却状态都有业务风险。

**正确边界:**

删除 `failOnOrderFetchError` 的空订单继续分支。订单 API 失败统一抛 `ExternalApiRequestError`，由启动或生命周期 owner 决定 retry。

## 3.7 订单缓存把 API 失败和契约错误都返回空数组

**位置:**

- `src/core/trader/orderCacheManager.ts:125`
- `src/core/trader/orderCacheManager.ts:126`
- `src/core/trader/orderCacheManager.ts:128`
- `src/core/trader/orderCacheManager.ts:167`
- `src/core/trader/orderCacheManager.ts:169`

当前：

```text
ctx.todayOrders() API 失败
  -> catch
  -> return []

ctx.todayOrders() 返回非数组
  -> logger.error
  -> return []
```

这违反两个边界：

1. API 失败不能伪造成空订单。
2. 返回结构不符合契约不是 API 临时失败，应 fail-fast。

**正确边界:**

- `ctx.todayOrders()` 请求失败：抛 `ExternalApiRequestError`。
- `todayOrdersRaw` 非数组：抛 `TypeError` 或 `ContractError`。
- 单条订单结构不符合预期：可以作为信任边界过滤，但必须评估是否需要记录计数；它不应被当成 API 请求失败。

## 3.8 自动寻标 catch all 会把 API 失败计入业务失败

**位置:**

- `src/services/autoSymbolManager/autoSearch.ts:91`
- `src/services/autoSymbolManager/autoSearch.ts:97`
- `src/services/autoSymbolManager/autoSearch.ts:101`
- `src/services/autoSymbolManager/autoSearch.ts:104`
- `src/services/autoSymbolManager/autoSearch.ts:115`

当前链路：

```text
seat -> SEARCHING
buildFindBestWarrantInput / findBestWarrant 抛任意错误
  -> catch
  -> best 仍为 null
  -> 进入 !best 分支
  -> searchFailCountToday +1
  -> 达上限冻结
```

**问题本质:**

API 请求失败、候选为空、内部逻辑错误被压扁成同一条业务路径。

**正确边界:**

- 候选为空：正常业务失败，可增加失败次数。
- API 请求失败：不增加失败次数，不冻结席位；恢复 seat 到 `EMPTY`，安排 API retry。
- 内部逻辑错误：恢复必要的本地中间状态后重新抛出，fail-fast。

这里的恢复不是兜底，而是撤销本轮 `SEARCHING` 中间态，避免 API 失败后席位永久停在处理中。

## 3.9 异步任务处理器 catch all 会隐藏非 API 错误

**位置:**

- `src/main/asyncProgram/buyProcessor/index.ts:222`
- `src/main/asyncProgram/sellProcessor/index.ts:298`
- `src/main/asyncProgram/monitorTaskProcessor/index.ts:156`

当前处理器通常：

```text
processTask 抛错
  -> logger.error
  -> return / failed
  -> 队列继续
```

这对单个 API 失败任务是合理的，但对内部程序错误不合理。否则核心交易逻辑中的 TypeError 或状态不变量错误会被记录后继续运行。

**正确边界:**

- `ExternalApiRequestError`：当前任务失败或进入显式 retry。
- 非 API 错误：进入 runtime fatal channel。

当前 async runtime 没有统一 fatal channel，这是 P1 级别结构缺口。

## 4. 修复方案可行性分析

## 4.1 方案方向可行

引入 `ExternalApiRequestError` 并不会要求大规模改变业务结构，因为当前项目已有多个 owner 能表达 retry：

- `TimeWakeupRuntime` 已经是 one-shot timer owner。
- `TimeWakeupPlanner` 已经支持候选 source 与 `nextWakeupAtMs`。
- `DayLifecycleManager` 已经有 `nextRetryAtMs`。
- `DoomsdayProtection.executeClearance` 已经有 `nextRetryAtMs`。
- `AutoSearchWakeupRuntime` 已经能给 route 安排 one-shot timer。

因此，“API 失败 -> 事件驱动 retry”可以复用现有架构，不需要引入轮询，也不需要全局定时器。

## 4.2 方案必须避免错误包装过宽

`wrapExternalApiRequest(...)` 必须只包真实外部请求表达式，不能把后续解析、校验、状态写入也包进去。

正确：

```text
const resp = await wrapExternalApiRequest('ctx.todayOrders', () => ctx.todayOrders());
if (!Array.isArray(resp)) throw new TypeError(...);
```

错误：

```text
await wrapExternalApiRequest('load orders', async () => {
  const resp = await ctx.todayOrders();
  if (!Array.isArray(resp)) throw new TypeError(...);
  return parse(resp);
});
```

后者会把契约错误错误地包装成 API 失败，破坏 fail-fast。

## 4.3 不应盲目重试非幂等交易 API

读 API 可以有限重试：

- `tradingDays`
- `realtimeQuote`
- `quote`
- `staticInfo`
- `accountBalance`
- `stockPositions`
- `todayOrders`
- `historyOrders`
- `orderDetail`

幂等或近似幂等 API 可以按业务语义有限重试：

- `subscribe`
- `unsubscribe`
- `cancelOrder`，但失败后仍应做 `orderDetail` 权威确认。

非幂等 API 不应盲目重试：

- `submitOrder`
- 可能产生远端状态变化但没有本地幂等键的操作。

`submitOrder` 请求失败后的正确处理不是简单重发，而是进入“远端结果不可确认”的错误分类，交给上层停止本轮信号、等待订单/持仓/WS 权威事实后重新决策。否则可能重复下单。

## 4.4 在 time wakeup 中返回 API_RETRY 比让 runtime catch 后判断更合理

可选方案有两种：

1. `TimeWakeupRuntime` catch `ExternalApiRequestError` 并自行安排 retry。
2. `timeWakeupEvaluationProgram` catch `ExternalApiRequestError` 并返回 `API_RETRY` candidate。

建议采用第 2 种。

原因：

- runtime 只负责调度，不理解业务上下文。
- evaluation program 知道失败发生在交易日、末日保护、生命周期还是清仓，可决定是否停止后续状态写入。
- 非 API 错误仍能自然抛到 runtime fatal。
- 符合当前事件驱动架构：评估程序产出候选，runtime 只调度候选。

## 4.5 生命周期 retry 分类可复用现有机制

`DayLifecycleManager` 当前已有 retry 状态和 `nextRetryAtMs`。修复不需要重写生命周期，只需要改变 catch 分类：

```text
ExternalApiRequestError
  -> OPEN_REBUILD_FAILED + nextRetryAtMs

其他错误
  -> throw
```

这样既保留 API 失败可恢复，又不会把内部 bug 伪装成生命周期重试。

## 4.6 启动快照结果类型需要调整，不能继续携带空事实

如果只是在 `startupRebuildPending=true` 时保留 `allOrders=[]` 和 `quotesMap=new Map()`，短期可能仍不会触发明显 bug，因为 `runApp` 已跳过验证和初次重建。但从类型语义看，它仍允许调用方误用。

更合理的修改是把 `StartupSnapshotResult` 改成 discriminated union。这样 TypeScript 会强制调用方区分：

```text
READY：可以使用 allOrders / quotesMap
API_RETRY_PENDING：没有启动快照事实，不能读取 allOrders / quotesMap
```

这是比“保留空字段但靠约定不读”更正确的 fail-fast 类型设计。

## 5. 完整修复方案

## 5.1 新增 API 失败基础设施

新增：

- `src/utils/apiFailure/types.ts`
- `src/utils/apiFailure/index.ts`

建议类型：

```text
ExternalApiRequestError
  - name: 'ExternalApiRequestError'
  - operation: string
  - attempts: number
  - cause: unknown
```

建议函数：

```text
isExternalApiRequestError(error: unknown): error is ExternalApiRequestError
wrapExternalApiRequest(operation, request, retryConfig): Promise<T>
```

约束：

- `wrapExternalApiRequest` 只包外部请求表达式。
- 默认 retry 次数有限。
- mutation API 默认不自动重试，除非调用方显式传入安全策略。
- 最终失败抛 `ExternalApiRequestError`。

## 5.2 修改 API 调用边界

优先覆盖：

- `src/services/quoteClient/index.ts`
  - `ctx.realtimeQuote`
  - `ctx.quote`
  - `ctx.staticInfo`
  - `ctx.subscribe`
  - `ctx.unsubscribe`
  - `ctx.subscribeCandlesticks`
  - `ctx.unsubscribeCandlesticks`
  - `ctx.tradingDays`
- `src/core/trader/accountService.ts`
  - `ctx.accountBalance`
  - `ctx.stockPositions`
- `src/core/orderRecorder/orderApiManager.ts`
  - `ctx.historyOrders`
  - `ctx.todayOrders`
- `src/core/trader/orderCacheManager.ts`
  - `ctx.todayOrders`
- `src/core/trader/orderMonitor/orderStatusQuery.ts`
  - `ctx.orderDetail`
- `src/core/trader/orderMonitor/orderOps.ts`
  - `ctx.cancelOrder`
  - `ctx.replaceOrder`
- `src/core/trader/orderExecutor/quantityResolver.ts`
  - `ctx.stockPositions`
- `src/core/trader/orderExecutor/submitFlow.ts`
  - `ctx.submitOrder`，但不做盲目自动重试。

## 5.3 修复 TimeWakeupEvaluationProgram

修改 `src/main/timeWakeupPlanner/types.ts`：

```text
TimeWakeupCandidateSource 增加 'API_RETRY'
```

修改 `src/main/timeWakeupEvaluationProgram/index.ts`：

- 增加固定 API retry 间隔常量或从 deps 注入。
- 增加 helper：

```text
pushApiRetryCandidate(candidates, currentMs)
```

处理 `isTradingDay`：

```text
try marketDataClient.isTradingDay
catch ExternalApiRequestError:
  push API_RETRY
  return createEvaluationResult(currentTime, candidates)
catch other:
  throw
```

处理 `dayLifecycleManager.tick`：

```text
catch ExternalApiRequestError:
  push API_RETRY
  return createEvaluationResult(currentTime, candidates)
catch other:
  throw
```

处理末日保护：

```text
catch ExternalApiRequestError:
  push API_RETRY
  return createEvaluationResult(currentTime, candidates)
catch other:
  throw
```

关键状态约束：

- 交易日 API 失败前不得写入 `lastState.cachedTradingDayInfo`。
- 交易日 API 失败时不得更新 `lastState.canTrade`。
- API 失败时不得 emit gate change。
- doomsday API 失败时不得伪造 `executed=false` 成功完成。

## 5.4 保持 TimeWakeupRuntime 的 fail-fast 语义

`src/main/timeWakeupRuntime/index.ts` 不应改成“所有错误 retry”。

建议仅更新注释和测试：

- `evaluate()` 抛出非 API 错误仍 `failFatal`。
- `scheduleAt` 遇到非法计划仍 `failFatal`。
- API retry 应由 evaluation result 的 `API_RETRY` candidate 表达。

如果短期实现选择 runtime catch `ExternalApiRequestError`，也必须只作为过渡方案；最终结构应回到 evaluation program 产出 retry candidate。

## 5.5 修复启动快照结果语义

修改 `StartupSnapshotResult` 为：

```text
READY
  - allOrders
  - quotesMap
  - now

API_RETRY_PENDING
  - now
```

修改 `src/app/startup/startupSnapshot.ts`：

```text
catch ExternalApiRequestError:
  applyStartupSnapshotFailureState
  return { kind: 'API_RETRY_PENDING', now }
catch other:
  throw
```

修改 `src/app/runApp.ts`：

- `READY` 分支执行运行时标的验证、构建带启动行情事实的上下文、初次重建。
- `API_RETRY_PENDING` 分支不读取 `allOrders` / `quotesMap`。
- 若 `buildMonitorContexts` 必须接收 `quotesMap`，应修改它的输入类型，显式表达启动行情不可用，而不是传空 Map。

## 5.6 修复生命周期重建 catch 分类

修改 `src/main/lifecycle/dayLifecycleManager.ts`：

```text
catch ExternalApiRequestError:
  rebuildFailureCount += 1
  OPEN_REBUILD_FAILED
  nextRetryAtMs = nowMs + retryDelay
catch other:
  throw
```

注意：

- `runOpenRebuildForDomains(...)` 中非 API 错误不应被 lifecycle 消化。
- API 失败 retry 时继续保持 `isTradingEnabled=false`。

## 5.7 删除订单空事实兜底

修改 `src/core/trader/orderCacheManager.ts`：

```text
ctx.todayOrders API 失败
  -> throw ExternalApiRequestError

todayOrdersRaw 非数组
  -> throw TypeError / ContractError
```

不得再：

```text
return []
```

修改 `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts`：

- 删除 `failOnOrderFetchError` 参数或至少删除 `false` 分支。
- `trader.fetchAllOrdersFromAPI(...)` 失败统一抛出。
- 不允许按空订单继续 `prepareSeatsForRuntime(...)`。

## 5.8 修复末日保护 retry 语义

修改 `src/core/doomsdayProtection/types.ts`：

`CancelPendingBuyOrdersResult` 建议增加：

```text
nextRetryAtMs: number | null
```

修改 `cancelPendingBuyOrders(...)`：

- 未成交订单查询 API 失败：抛 `ExternalApiRequestError` 或返回 `nextRetryAtMs`，由 time wakeup 统一接管。
- 不在撤单全部完成前设置 `cancelCheckExecutedDate`。
- 单笔撤单 API 失败：记录失败订单，返回 `nextRetryAtMs`。
- 业务终态确认、已成交、已撤销不算 API 失败。

修改 `executeClearance(...)`：

- 行情 API 请求失败：返回或抛 `ExternalApiRequestError` 给 time wakeup 安排 API retry。
- 行情缺失：保留现有 `nextRetryAtMs` 业务 quote retry。
- `executeSignals` 外部 API 失败：不更新持仓缓存，不清订单记录；下一次 retry 必须重新读取权威事实后再生成清仓信号。

## 5.9 修复自动寻标错误边界

修改 `src/services/autoSymbolManager/autoSearch.ts`：

```text
try buildFindBestWarrantInput / findBestWarrant
catch ExternalApiRequestError:
  seat 从 SEARCHING 恢复 EMPTY
  不增加 searchFailCountToday
  不冻结
  throw 或返回 API_RETRY result
catch other:
  seat 从 SEARCHING 恢复 EMPTY
  throw
```

更适合的结构是让 `maybeSearchOnEvent(...)` 返回显式结果：

```text
SEARCHED
NO_CANDIDATE
API_RETRY_REQUIRED
SKIPPED
```

但最短路径可以先保持 `Promise<void>`，由 `AutoSearchWakeupRuntime.processSeat(...)` catch `ExternalApiRequestError` 并调用现有 `scheduleRouteTimer(...)` 安排 retry。

## 5.10 补齐 async runtime fatal channel

P1 阶段修改：

- `src/main/asyncProgram/buyProcessor/index.ts`
- `src/main/asyncProgram/sellProcessor/index.ts`
- `src/main/asyncProgram/monitorTaskProcessor/index.ts`
- `src/app/runtime/createAsyncRuntime.ts`
- `src/app/runApp.ts`

增加类似：

```text
asyncRuntime.drainFatalError(): Promise<never>
```

处理：

```text
catch ExternalApiRequestError:
  任务失败 / 显式 retry
catch other:
  async fatal
```

`runApp` 中：

```text
Promise.race([
  waitForShutdown(),
  timeWakeupRuntime.drainFatalError(),
  asyncRuntime.drainFatalError(),
])
```

这样非 API 程序错误不会只写日志后继续运行。

## 6. 不采用的方案

### 6.1 不采用“TimeWakeupRuntime catch 所有错误后 retry”

这会把内部逻辑错误也变成 retry，违反 fail-fast。

### 6.2 不采用“API 失败时返回默认事实”

例如：

- `isTradingDay=false`
- `allOrders=[]`
- `quotesMap=new Map()`
- `pendingOrders=[]`
- `positions=[]`

这些都是空事实兜底，会导致业务状态偏移。

### 6.3 不采用无限重试或轮询

API retry 必须：

- 有有限 attempt。
- 有明确 nextRetryAtMs。
- 由现有事件 owner 或 one-shot timer 驱动。
- 可观测、有日志。

### 6.4 不采用盲目重试 submitOrder

没有幂等键时，重复 submit 可能导致重复订单。下单 API 失败必须按“远端结果不可确认”处理，等待权威事实后重新决策。

### 6.5 不采用仅依赖 `unhandledRejection`

当前 `src/utils/logger/index.ts:761` 只记录未处理 Promise 拒绝，不退出。即使改成退出，也不是良好的业务错误边界。正确做法是 runtime 显式 fatal channel。

## 7. 分阶段实施计划

### 阶段 1：错误分类与只读 API wrapper

1. 新增 `ExternalApiRequestError`。
2. 新增 `wrapExternalApiRequest(...)`。
3. 覆盖读 API：交易日、行情、账户、持仓、订单列表、订单详情。
4. 保证解析和契约校验在 wrapper 外部执行。

### 阶段 2：时间唤醒 API retry

1. `TimeWakeupCandidateSource` 增加 `API_RETRY`。
2. `timeWakeupEvaluationProgram` 捕获 `ExternalApiRequestError` 并返回 retry candidate。
3. 非 API 错误继续抛给 `TimeWakeupRuntime.failFatal`。
4. 增加测试验证 API 失败不触发 `drainFatalError()`。

### 阶段 3：生命周期与启动快照

1. `StartupSnapshotResult` 改为 union。
2. 启动 API 失败进入 pending，不返回空事实。
3. 生命周期重建只 catch `ExternalApiRequestError`。
4. 非 API 错误从 lifecycle 抛出。

### 阶段 4：订单与末日保护

1. 删除 `orderCacheManager` 的 `return []` 兜底。
2. 删除 `loadTradingDayRuntimeSnapshot` 的空订单继续分支。
3. `cancelPendingBuyOrders` 增加 `nextRetryAtMs`，修复 `cancelCheckExecutedDate` 完成语义。
4. 清仓 API 失败不更新缓存，不清订单记录，下一次基于权威事实重评估。

### 阶段 5：自动寻标与 async fatal

1. 自动寻标 API 失败不计失败次数，不冻结。
2. `AutoSearchWakeupRuntime` 安排 API retry timer。
3. async processor 区分 API 失败与非 API 错误。
4. 增加 `asyncRuntime.drainFatalError()`。

## 8. 测试计划

### 8.1 API 错误类型

- wrapper 对请求失败进行有限重试。
- 重试耗尽后抛 `ExternalApiRequestError`。
- wrapper 不包装后续 TypeError。

### 8.2 时间唤醒

- `isTradingDay` 抛 `ExternalApiRequestError`：
  - 返回 `API_RETRY`。
  - 不更新 `cachedTradingDayInfo`。
  - 不更新 `canTrade`。
  - 不 emit gate change。
  - `drainFatalError()` 不 reject。

- `isTradingDay` 抛 TypeError：
  - `TimeWakeupRuntime` fatal。

- 返回非法 `nextWakeupAtMs`：
  - 仍 fatal。

### 8.3 生命周期

- 启动快照 API 失败：返回 `API_RETRY_PENDING`，不携带空 `allOrders` / `quotesMap`。
- 启动快照非 API 错误：直接抛出。
- 开盘重建 API 失败：`OPEN_REBUILD_FAILED` 并安排 retry。
- 开盘重建非 API 错误：不 retry，向上抛出。

### 8.4 订单缓存

- `todayOrders()` API 失败：抛 `ExternalApiRequestError`。
- `todayOrders()` 返回非数组：抛 TypeError。
- 正常返回空数组：仅在 API 权威返回空数组时返回 `[]`。

### 8.5 末日保护

- 未成交订单查询 API 失败：不设置 `cancelCheckExecutedDate`。
- 单笔撤单 API 失败：返回 `nextRetryAtMs`。
- 全部撤单接受或终态确认：才设置当天完成标记。
- 清仓行情 API 失败：不 fatal，安排 API retry。
- 清仓行情缺失：保留 quote retry，不当作 API failure。
- 清仓下单 API 失败：不更新持仓缓存，不清订单记录。

### 8.6 自动寻标

- `findBestWarrant` API 失败：
  - 不增加 `searchFailCountToday`。
  - 不冻结。
  - seat 回到 `EMPTY`。
  - 安排 API retry。

- `findBestWarrant` 正常返回 null：
  - 增加失败次数。
  - 达上限冻结。

- 内部 TypeError：
  - fail-fast。

### 8.7 异步处理器

- buy/sell/monitor task 抛 `ExternalApiRequestError`：任务失败或进入显式 retry，runtime 不 fatal。
- buy/sell/monitor task 抛 TypeError：async fatal channel reject，`runApp` 清理后退出。

## 9. 验收标准

修复完成后应满足：

1. API 请求失败不会直接触发进程退出。
2. API 请求失败不会被表达为空订单、空行情、空持仓、非交易日或无候选。
3. 非 API 错误不会进入 lifecycle retry、time wakeup retry、auto search retry。
4. `TimeWakeupRuntime` 仍对非法计划和非 API 错误 fail-fast。
5. 所有 retry 都是有限、显式、可观测、事件驱动的。
6. 非幂等交易 API 不会盲目自动重试。
7. 测试覆盖 API 失败与非 API 错误的分流行为。
