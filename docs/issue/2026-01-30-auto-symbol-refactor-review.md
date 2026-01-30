# 自动寻标重构问题复核（2026-01-30）

## 复核范围
- 自动寻标与换标流程
- 风险信息刷新与距离回收价判断

## 已确认问题

### 1. 自动寻标完成后，距离回收价判断可能使用旧回收价
- 现象：同一 tick 内先 `maybeSearchOnTick()` 使席位 READY，再 `maybeSwitchOnDistance()` 使用 `riskChecker` 的旧 `WarrantInfo` 判断距离，可能误触发换标/清空。
- 证据：`processMonitor()` 先寻标后换标，再 `refreshSeatAfterSwitch()` 刷新风险信息；`getWarrantDistanceInfo()` 不校验标的一致性。
- 影响：席位抖动、刚寻到的标的被误判、信号被清理或无效交易。
- 修复必要性：明确需要修复。

#### 修复方案（详细）
1. **增加席位标的校验，避免使用旧回收价**
   - 修改 `RiskChecker.getWarrantDistanceInfo()` 签名为 `getWarrantDistanceInfo(isLongSymbol, seatSymbol, monitorCurrentPrice)`。
   - 在 `warrantRiskChecker` 内判断 `warrantInfo.symbol` 与 `seatSymbol` 是否一致，不一致直接返回 `null`（可加 debug 日志）。
   - 目的：同一 tick 内席位刚变更时，不再使用旧 `WarrantInfo` 做距离判断。

2. **更新调用点**
   - `processMonitor()` 中展示距离信息时传入当前席位标的。
   - `autoSymbolManager.maybeSwitchOnDistance()` 中距离判断时传入当前席位标的。

3. **保持现有刷新时机**
   - `refreshSeatAfterSwitch()` 仍在席位变化后刷新 `WarrantInfo`（已有逻辑）。
   - 若刷新失败，沿用 `markSeatAsEmpty()` 的兜底行为（已有逻辑）。

#### 术语与函数说明
- `maybeSearchOnTick()`：自动寻标入口函数，位于 `src/services/autoSymbolManager/index.ts`；当席位为空且满足冷却/开盘保护条件时调用 `findBestWarrant()` 寻找新标的并设置席位为 `READY`。
- `maybeSwitchOnDistance()`：自动换标入口函数，位于 `src/services/autoSymbolManager/index.ts`；在价格变化时根据距回收价阈值判断是否需要换标，触发后执行撤单、移仓卖出、寻标、移仓买入的流程。
- `processMonitor()`：单监控标的的主处理函数，位于 `src/main/processMonitor/index.ts`；负责拉行情、自动寻标/换标、计算指标、生成并分流信号。
- `refreshSeatAfterSwitch()`：换标后的刷新函数，位于 `src/main/processMonitor/index.ts`；刷新新标的订单记录、浮亏数据、牛熊证信息，并清理旧标的缓存。
- `getWarrantDistanceInfo()`：距回收价信息读取方法，位于 `src/core/risk/warrantRiskChecker.ts`（通过 `RiskChecker` 暴露）；用于展示或判断距离百分比。
- `RiskChecker.getWarrantDistanceInfo()`：风险检查接口定义，位于 `src/types/index.ts`；文档修复方案建议扩展签名以传入 `seatSymbol` 做一致性校验。
- `warrantRiskChecker`：牛熊证风险检查子模块，位于 `src/core/risk/warrantRiskChecker.ts`；负责牛熊证识别、回收价获取与距离计算。
- `WarrantInfo`：牛熊证信息结构，位于 `src/core/risk/types.ts`；包含 `symbol`、`warrantType`、`callPrice` 等字段。
- `riskChecker`：风险检查门面实例，位于 `src/core/risk/index.ts`；聚合牛熊证风险、持仓限制、浮亏等子检查器。
- `seatSymbol`：席位当前绑定的交易标的（牛/熊证）代码，由 `SymbolRegistry` 维护；修复方案要求把它传入距离判断以避免旧回收价。
- `monitorCurrentPrice`：监控标的当前价格（如恒指），来自行情 `quotesMap`；用于计算距回收价百分比。
- `markSeatAsEmpty()`：换标失败时的兜底函数，位于 `src/main/processMonitor/index.ts`；将席位置为空并清理待执行信号。

#### 验收要点
- 同一 tick 内新寻标不会因旧回收价触发立即换标。
- 下一 tick 使用新标的的 `WarrantInfo` 正常进行距离判断。
- 日志可追溯标的校验行为（建议 debug 级别输出）。
