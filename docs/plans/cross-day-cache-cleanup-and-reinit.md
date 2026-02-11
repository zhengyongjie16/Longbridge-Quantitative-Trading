# 跨日缓存清理与下次开盘重新初始化 - 重构方案

## 1. 目标与约束

- **目标**：跨日后对部分缓存进行清理（零点钟检测到日期变化时执行），在下次开盘后根据跨日标志执行一次“类启动”的初始化，保证新交易日使用新数据；程序启动时仍按现有逻辑完整初始化。
- **约束**：系统性、完整性重构，不允许兼容性或补丁式代码；逻辑清晰、职责单一。

## 2. 当前缓存清单与维护方式

### 2.1 需长期维护的缓存（程序运行期间持续使用）

| 缓存 | 位置 | 用途 | 当前更新方式 |
|------|------|------|--------------|
| `lastState.cachedAccount` | LastState | 账户快照 | 启动时 refreshAccountAndPositions；交易后 postTradeRefresher 刷新 |
| `lastState.cachedPositions` | LastState | 持仓列表 | 同上 |
| `lastState.positionCache` | LastState | 持仓 O(1) 查找 | 随 cachedPositions 更新而 update(positions) |
| `lastState.cachedTradingDayInfo` | LastState | 交易日/半日市 | 启动门控后写入；主循环跨日时重取 |
| `lastState.currentDayKey` | LastState | 港股日期键，跨日检测 | 主循环每轮用 getHKDateKey 比较并更新 |
| `lastState.allTradingSymbols` | LastState | 运行时订阅标的集合 | 主循环根据 positions/orderHoldSymbols/配置 动态 diff 并维护 |
| `lastState.monitorStates` | LastState | 各监控标的状态（价格、信号、待验证信号等） | 主循环 processMonitor 更新 |
| OrderCacheManager | trader | 未成交订单缓存（TTL 30s） | getPendingOrders 读/写；订单变更后 clearCache |
| IndicatorCache | main/asyncProgram/indicatorCache | 按监控标的环形缓冲，存历史指标快照 | push 写入；延迟验证 getAt 读取；退出时 clearAll |
| OrderRecorder/OrderAPIManager | orderRecorder | 按标的订单缓存 + allOrdersCache | refreshOrdersFromAllOrders/cacheOrdersForSymbol；clearCacheForSymbol |
| WarrantListCache | services/autoSymbolFinder | 牛熊证列表 TTL 缓存 | fetchWarrantsWithCache 读/写 |
| TradingDayCache | quoteClient 内部 | 按日期交易日信息 | isTradingDay/setBatch 读/写，带 TTL |
| quoteCache / prevCloseCache / staticInfoCache | quoteClient 内部 | 行情、昨收、静态信息 | 推送与 getQuotes 更新 |
| DailyLossTracker | 独立实例 | 按监控标的的日内亏损状态 | resetIfNewDay；initializeFromOrders；运行时更新 |
| DelayedSignalVerifier | 每监控标的一个 | 待验证延迟信号 | 验证/取消/销毁时清理 |
| services/indicators 内 IndicatorCalculationCache | 模块级 Map | buildIndicatorSnapshot 的计算缓存 | TTL + 容量清理 |

### 2.2 跨日应清理的缓存及原因

| 缓存 | 是否跨日清理 | 原因 |
|------|--------------|------|
| lastState.cachedAccount | 是 | 隔夜后需用新交易日数据 |
| lastState.cachedPositions | 是 | 同上 |
| lastState.positionCache | 是 | 与 cachedPositions 一致，update([]) |
| lastState.cachedTradingDayInfo | 已在跨日分支刷新 | 保持现有逻辑即可 |
| lastState.allTradingSymbols | 是 | 跨日后订阅集合应由新持仓/订单/配置重新收集 |
| lastState.monitorStates（待验证信号等） | 是 | 取消所有待验证信号；可选重置价格/信号等可变字段 |
| OrderCacheManager | 是 | 未成交订单为新交易日重新拉取 |
| IndicatorCache | 是 | 历史指标为新交易日重新积累 |
| OrderRecorder/OrderAPIManager | 是 | 订单记录与全量订单缓存按新日重新拉取并刷新 |
| WarrantListCache | 可选 | TTL 会过期，为一致性可跨日清空 |
| TradingDayCache / prevCloseCache | 可选 | 新日 prevClose 含义变化，建议清 prevCloseCache；TradingDayCache 可按需清 |
| DailyLossTracker | 否 | 已有 resetIfNewDay，在主循环开头执行 |
| DelayedSignalVerifier | 是 | 跨日取消所有待验证信号，与“非交易时段”行为一致 |
| services/indicators IndicatorCalculationCache | 是 | 避免隔夜残留，新日重新计算 |

### 2.3 不需跨日清理或仅自然失效的组件

- **DoomsdayProtection** 内部 cancelCheckExecutedDate / lastClearanceNoticeKey：按日期字符串，跨日自然不匹配。
- **席位/配置/策略实例**：不按日重置，仅数据类缓存在跨日清理。

## 3. 时机与流程

### 3.1 跨日检测（已有）

- 主循环中：`currentDayKey = getHKDateKey(currentTime)`，若 `currentDayKey !== lastState.currentDayKey` 视为跨日。
- 当前已在跨日分支中：更新 `currentDayKey`、刷新 `cachedTradingDayInfo`（strict 模式）、置空 `canTrade`/`isHalfDay`/`openProtectionActive`、各 monitor 的 `autoSymbolManager.resetDailySwitchSuppression()`。

### 3.2 跨日后“立即清理”（零点钟）

- **时机**：在上述跨日分支内，在现有逻辑之后**集中执行一次跨日缓存清理**。
- **含义**：“零点钟”即主循环第一次检测到日期变化的那一轮（可能是 00:00:01 或下一轮），不依赖定时器，与现有跨日检测一致。

### 3.3 下次开盘后“再次初始化”

- **时机**：主循环中，在**已进入连续交易时段**（`canTradeNow === true`）且**尚未执行本次开盘的初始化**时。
- **标志**：在 LastState 上新增 `crossDayPendingReinit: boolean`。跨日清理完成后置为 `true`；执行完“开盘后初始化”后置为 `false`。
- **条件**：当 `lastState.crossDayPendingReinit === true` 且 `canTradeNow === true` 时，执行一次开盘后初始化，然后置 `crossDayPendingReinit = false`。
- **程序启动**：启动时**不**依赖该标志，仍按现有流程完整初始化；启动完成进入主循环后，若未跨日则 `crossDayPendingReinit` 为 false，不会误触发。

## 4. 重构设计

### 4.1 新增类型与状态

- **LastState** 增加字段：
  - `crossDayPendingReinit: boolean` — 默认 `false`；跨日清理后设为 `true`；开盘后初始化完成后设为 `false`。

### 4.2 跨日清理职责（集中在一处执行）

在跨日分支内依次执行（建议抽成独立函数，便于测试与阅读）：

1. **LastState 数据缓存**
   - `lastState.cachedAccount = null`
   - `lastState.cachedPositions = []`
   - `lastState.positionCache.update([])`
   - `lastState.allTradingSymbols = new Set()`（清空订阅集合，下次开盘根据新数据重新收集并 subscribe/unsubscribe）

2. **监控状态**
   - 对每个 `monitorContext` 调用 `delayedSignalVerifier.cancelAllForSymbol(monitorSymbol)`，清空待验证信号。
   - 可选：对 `lastState.monitorStates` 中每个 state 重置可变字段（如 `monitorPrice/longPrice/shortPrice/signal/pendingDelayedSignals` 等），避免沿用昨日数据；若 cancelAll 已清空 pendingDelayedSignals，至少保证无残留。

3. **订单与指标缓存**
   - `trader` 内部 OrderCacheManager：`cacheManager.clearCache()`
   - `indicatorCache.clearAll()`
   - OrderRecorder：新增并调用 `clearAllCache()`（见下），清空所有标的缓存及 allOrdersCache。

4. **可选**
   - WarrantListCache：若实现 `clear()` 则在此调用。
   - MarketDataClient：若暴露 `clearDayCaches()`（清 prevCloseCache 等）则在此调用。
   - services/indicators：若暴露 `clearCalculationCache()` 则在此调用。

5. **设置跨日待初始化标志**
   - `lastState.crossDayPendingReinit = true`

注意：`cachedTradingDayInfo` 已在同一跨日分支内按新日期刷新，无需在“清理”中再清；`currentDayKey` 已更新；`canTrade/isHalfDay/openProtectionActive` 已置 null。

### 4.3 开盘后初始化职责（与启动时数据初始化对齐）

执行条件：主循环中 `canTradeNow === true` 且 `lastState.crossDayPendingReinit === true`。执行后置 `lastState.crossDayPendingReinit = false`。

步骤（仅数据与缓存，不重复创建实例或注册回调）：

1. **账户与持仓**
   - `await refreshAccountAndPositions(trader, lastState)`

2. **全量订单与挂单标的、日内亏损**
   - `allOrders = await trader._orderRecorder.fetchAllOrdersFromAPI(true)`（强制刷新）
   - `trader.seedOrderHoldSymbols(allOrders)`
   - `dailyLossTracker.initializeFromOrders(allOrders, tradingConfig.monitors, new Date())`

3. **订阅集合与行情订阅**
   - 使用 `collectRuntimeQuoteSymbols` 基于当前 `lastState.cachedPositions`、`trader.getOrderHoldSymbols()`、配置等得到 `desiredSymbols`。
   - 与 `lastState.allTradingSymbols` 做 diff（added/removed）；对 added 调用 `marketDataClient.subscribeSymbols(added)`；对 removed 且无持仓的调用 `unsubscribeSymbols`。
   - 更新 `lastState.allTradingSymbols` 为新的 Set（与主循环现有逻辑一致，可抽共用函数）。

4. **订单记录**
   - 对每个 monitorContext：取 longSeatSymbol/shortSeatSymbol，若有则取对应 quote，调用 `orderRecorder.refreshOrdersFromAllOrders(symbol, isLong, allOrders, quote)`（使用上面拉取的 allOrders 与当前 getQuotes 或已有 quotesMap）。

5. **浮亏监控**
   - 对每个配置了 `maxUnrealizedLossPerSymbol` 的 monitorContext，对 long/short 席位标的调用 `riskChecker.refreshUnrealizedLossData(orderRecorder, symbol, isLong, quote, dailyLossOffset)`。

6. **可选**
   - `displayAccountAndPositions` 打日志，便于与启动时行为一致。

以上与 `docs/flow/startup-initialization-flow.md` 中“订单记录与浮亏初始化”及“运行期行情订阅”对齐，不包含创建 trader、monitorContexts、席位 prepareSeatsOnStartup、tradeLogHydrator、处理器 start 等。

### 4.4 主循环中的调用顺序（关键）

1. `currentTime`、`dailyLossTracker.resetIfNewDay(currentTime)`（保持现有）。
2. **跨日检测**：若 `currentDayKey !== lastState.currentDayKey`，则更新 `currentDayKey`、刷新 `cachedTradingDayInfo`、置空 canTrade/isHalfDay/openProtectionActive、resetDailySwitchSuppression，**并执行跨日清理 + 设置 crossDayPendingReinit = true**。
3. 计算 `isTradingDayToday` / `isHalfDayToday`（无缓存时再拉取，保持现有）。
4. 交易时段判断：若非交易日则 return；否则计算 `canTradeNow`、开盘保护等，更新 `lastState.canTrade` 等。
5. **开盘后初始化检测**：若 `canTradeNow === true` 且 `lastState.crossDayPendingReinit === true`，则执行“开盘后初始化”并置 `lastState.crossDayPendingReinit = false`，然后**继续本轮回合**（同一轮内可继续后续行情订阅与 processMonitor，或按你希望的在初始化后 return 一次再下一轮再跑行情逻辑，两种都合理；建议同一轮继续，避免少跑一秒）。
6. 末日保护检查（保持现有）。
7. 收集行情标的、diff、subscribe/unsubscribe、更新 allTradingSymbols（若未在开盘初始化中做过，这里会基于当前 lastState 再算一遍，保持一致即可）。
8. 批量 getQuotes、processMonitor、orderMonitorWorker、postTradeRefresher（保持现有）。

建议：开盘后初始化中已更新 allTradingSymbols 并完成 subscribe/unsubscribe，故第 7 步会与当前 lastState 一致，无需重复订阅；若实现上先做 7 再在“开盘后初始化”里只做账户/订单/浮亏等也可，只要保证 allTradingSymbols 与订阅状态一致。

### 4.5 程序启动时逻辑（不变）

- 启动时不设置 `crossDayPendingReinit`（保持为 false）。
- 仍执行：refreshAccountAndPositions → fetchAllOrdersFromAPI → seedOrderHoldSymbols → initializeFromOrders → prepareSeatsOnStartup → … → 订单记录与浮亏初始化 → 进入主循环。
- 主循环第一次执行时，若未跨日，不会进入跨日分支；若已跨日（例如程序在 00:00 后启动），会进入跨日分支并设置 crossDayPendingReinit，待进入交易时段后执行开盘后初始化，逻辑一致。

## 5. 模块级修改清单

### 5.1 必须修改

| 模块 | 修改内容 |
|------|----------|
| `src/types/index.ts` | LastState 增加 `crossDayPendingReinit: boolean` |
| `src/main/mainProgram/index.ts` | 跨日分支内调用跨日清理并设 crossDayPendingReinit；在 canTradeNow 为 true 时检查并执行开盘后初始化 |
| `src/core/orderRecorder/orderApiManager.ts` | 新增 `clearAllCache(): void`（清空 ordersCache 与 allOrdersCache） |
| `src/core/orderRecorder/index.ts` | 暴露 `clearAllCache()`，转发给 apiManager |
| `src/core/orderRecorder/types.ts` | OrderAPIManager / OrderRecorder 接口增加 clearAllCache |
| `src/index.ts` | lastState 初始化时增加 `crossDayPendingReinit: false`；若开盘后初始化需要用到 monitorContexts/trader/dailyLossTracker 等，这些已在 main 中创建并传入 mainProgram，无需在 index 中新增，仅保证 mainProgram 入参足够 |

### 5.2 跨日清理与开盘后初始化的放置方式

- **方案 A**：在 `src/main/mainProgram/index.ts` 内实现两段逻辑（跨日清理 inline 或抽成该文件内函数），开盘后初始化也内联或同文件内函数。依赖通过 MainProgramContext 传入（trader、indicatorCache、monitorContexts、marketDataClient、tradingConfig、dailyLossTracker 等已有）。
- **方案 B**：新建 `src/main/crossDay/index.ts`（或 `src/main/mainProgram/crossDay.ts`），导出 `executeCrossDayCleanup(context)` 与 `executePostOpenReinit(context)`，mainProgram 在适当时机调用。context 包含上述依赖。

推荐 **方案 B**，便于单测与阅读，且与“主循环只做编排”的风格一致。

### 5.3 可选增强

| 模块 | 修改内容 |
|------|----------|
| `src/services/autoSymbolFinder/utils.ts`（或 types + 实现） | WarrantListCache 增加 `clear(): void`，跨日清理时调用 |
| `src/services/quoteClient/index.ts` | MarketDataClient 增加 `clearDayCaches(): void`（清 prevCloseCache，可选 tradingDayCache），跨日清理时调用 |
| `src/services/indicators/index.ts` | 导出 `clearIndicatorCalculationCache(): void`，跨日清理时调用 |
| `src/main/mainProgram/types.ts` | MainProgramContext 若需传入 warrantListCache / marketDataClient 的 clear 能力，在 context 中已有 marketDataClient，可选增加 getWarrantListCache 等 |

## 6. 可行性说明

- **跨日只在一处检测**：主循环内现有 `currentDayKey` 比较，无竞态；清理在同一分支内同步执行，顺序明确。
- **下次开盘只执行一次**：用 `crossDayPendingReinit` 保证仅在新交易日首次进入交易时段时执行一次初始化，执行后立即置 false。
- **启动与跨日语义分离**：启动始终走完整初始化；跨日只做清理 + 设标志；开盘后初始化只做数据与缓存，不重建实例或注册回调。
- **与末日保护清仓的区分**：末日保护清仓时清空的是账户/持仓/订单记录等（因已全部平仓），与“跨日清理”不同：跨日清理是为新日做准备，不执行交易；二者可共用“清空 cachedAccount/cachedPositions/positionCache”等写法，但触发时机与后续逻辑不同，建议跨日清理独立成函数，末日保护保持现有实现。

## 7. 测试建议

- 单测：`executeCrossDayCleanup` 与 `executePostOpenReinit` 的入参为 mock context，断言各缓存被清空/刷新、crossDayPendingReinit 被正确置位。
- 集成：启动后 mock 时间跨日，再 mock 进入交易时段，断言只执行一次开盘后初始化且 refreshAccountAndPositions、fetchAllOrdersFromAPI、refreshOrdersFromAllOrders、refreshUnrealizedLossData 等被调用且 allTradingSymbols 与订阅状态一致。

## 8. 总结

- **跨日**：在主循环检测到日期变化时，集中执行缓存清理（账户/持仓/订阅集合/订单缓存/指标缓存/待验证信号等），并设置 `crossDayPendingReinit = true`。
- **下次开盘**：主循环在 `canTradeNow === true` 且 `crossDayPendingReinit === true` 时执行一次与启动时数据初始化对齐的流程（账户与持仓、全量订单与订单记录、订阅集合与行情订阅、浮亏监控），然后置 `crossDayPendingReinit = false`。
- **程序启动**：保持现有完整初始化流程不变；不依赖跨日标志。

该方案满足“跨日后立即清理、下次开盘再次初始化、程序启动必须初始化”的需求，且为系统性重构，无补丁式逻辑。
