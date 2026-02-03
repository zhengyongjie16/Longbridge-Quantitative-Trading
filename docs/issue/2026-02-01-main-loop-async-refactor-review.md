# 主循环异步拆分重构问题复核（2026-02-01）

## 范围与依据
- 计划文档：`docs/plans/2026-02-01-main-loop-async-refactor.md`
- 复核范围：主循环异步拆分新增的任务队列/处理器、订单监控后台化、成交后刷新合并、刷新门禁与清理接线。

## 结论概览
| 编号 | 问题 | 是否存在 | 是否必须修复 | 结论摘要 |
| --- | --- | --- | --- | --- |
| I1 | 等待刷新后未复核快照 | 是 | 是 | 违反 AsyncTaskSnapshotAndRecheck |
| I2 | 浮亏检查未 waitForFresh | 是 | 是 | 违反 RefreshGateCoversCachedReads |
| I3 | SeatVersionIsolation 顺序错误 | 是 | 是 | 先更新状态后 bump 版本 |
| I4 | markSeatAsEmpty 未立即清队列 | 是 | 是 | 违反 NonReadyClearsSignals |
| I5 | 刷新失败仍 markFresh | 是 | 是 | 可能放行旧缓存 |
| I6 | 非连续交易时段可能长期 stale | 条件成立 | 视业务而定 | 需确认“非连续时段成交”是否发生 |
| I7 | 监控任务清理方向判定过宽 | 是 | 否 | 低风险，可能跳过当轮任务 |

## 详细分析

### I1 等待刷新后未复核快照（必须修复）
**结论**：存在且必须修复。  
**原因**：`waitForFresh()` 可能等待期间席位切换，原有快照已失效，但任务仍继续执行，违反 “AsyncTaskSnapshotAndRecheck”。  
**涉及位置**：
- `src/main/asyncProgram/monitorTaskProcessor/index.ts`
  - `handleAutoSymbolSwitchDistance`
  - `handleLiquidationDistanceCheck`
**修复建议**：
1) 在 `waitForFresh()` 之后重新校验 `seatVersion + symbol`（对 long/short 分别复核）；  
2) 复核失败则直接 `skipped` 或将对应方向视为不就绪。

### I2 浮亏检查未 waitForFresh（必须修复）
**结论**：存在且必须修复。  
**原因**：浮亏检查读取 `unrealizedLossChecker` 的缓存数据（浮亏缓存），该缓存由成交后刷新更新，属于必须 waitForFresh 的异步读取路径。  
**涉及位置**：
- `src/main/asyncProgram/monitorTaskProcessor/index.ts` 的 `handleUnrealizedLossCheck`
- `src/core/risk/unrealizedLossChecker.ts` 读取内部缓存 `unrealizedLossData`
**修复建议**：
1) `handleUnrealizedLossCheck` 在读取 seat/quote 之前先 `await refreshGate.waitForFresh()`；  
2) 等待后重新校验快照（与 I1 同步修复）。

### I3 SeatVersionIsolation 顺序错误（必须修复）
**结论**：存在且必须修复。  
**原因**：计划要求“先 bump seatVersion，再更新状态/清队列”；当前 `clearSeat` 先更新 seatState 后 bump 版本，可能导致并发任务看到新状态但旧版本。  
**涉及位置**：
- `src/services/autoSymbolManager/index.ts` 的 `clearSeat`
**修复建议**：
1) 先 `bumpSeatVersion()`，再 `updateSeatState()`；  
2) 如有必要，日志中明确写出新版本。

### I4 markSeatAsEmpty 未立即清队列（必须修复）
**结论**：存在且必须修复。  
**原因**：席位被置空后未立即清空延迟验证、买入、卖出任务队列，违背 NonReadyClearsSignals（“进入非 READY 必须清理”）。  
**涉及位置**：
- `src/main/asyncProgram/monitorTaskProcessor/index.ts` 的 `markSeatAsEmpty`
**修复建议**：
1) 在 `markSeatAsEmpty` 内部触发“该方向队列清理”；  
2) 可抽取队列清理工具函数（与 `processMonitor` 共享）以避免逻辑分散。

### I5 刷新失败仍 markFresh（必须修复）
**结论**：存在且必须修复。  
**原因**：`PostTradeRefresher` 在 `finally` 中无条件 `markFresh`，即使刷新失败也放行等待者，导致读取旧缓存。与“刷新成功后 markFresh”的计划要求不一致。  
**涉及位置**：
- `src/main/asyncProgram/postTradeRefresher/index.ts` 的 `run`
**修复建议**：
1) `refreshAfterTrades` 返回成功标志；  
2) 仅在成功时 `markFresh`；  
3) 失败时保留 `pendingSymbols` 并调度重试（可加最小退避或限制重试频率，避免忙等）。

### I6 非连续交易时段可能长期 stale（条件成立）
**结论**：条件成立，是否修复取决于业务约束。  
**原因**：主循环在非连续交易时段直接 `return`，`postTradeRefresher` 不会被触发；若此期间发生成交并 `markStale`，则 `refreshGate` 长时间 stale。  
**影响**：若非连续时段仍可能成交或仍需处理卖出任务，可能导致任务等待。  
**修复建议（可选）**：
- 当 `pendingRefreshSymbols.length > 0` 时允许刷新（即便 `canTradeNow=false`）；  
- 或在成交回调处直接触发 `postTradeRefresher.enqueue`（不依赖主循环）。

### I7 监控任务清理方向判定过宽（低风险）
**结论**：存在但非必须修复。  
**原因**：`seatSnapshots`/`long+short` 类型任务会在任一方向非 READY 时被清理，可能导致另一方向当轮检查被跳过。  
**影响**：通常下一次 tick 会重新调度，风险较低。  
**修复建议（可选）**：
- 针对 `AUTO_SYMBOL_SWITCH_DISTANCE` / `UNREALIZED_LOSS_CHECK` 精确判断方向，或拆分为方向级任务。

## 误报/不需修复项
- **SEAT_REFRESH 未 waitForFresh**：该路径主要执行刷新写入（从 API 获取账户/持仓并更新缓存），不读取缓存做决策，因此不属于“读缓存前必须等待”的路径，不必强制等待。

## 附加测试建议（可选）
- 增加 `MonitorTaskProcessor` 的不变量测试：seatVersion 变化后旧任务被丢弃、`waitForFresh` 发生等待等。  
- 增加 `PostTradeRefresher` 失败路径测试：刷新失败时不 `markFresh`、重试策略有效。  
- 增加 `cleanup` 的停止新组件回归测试。

