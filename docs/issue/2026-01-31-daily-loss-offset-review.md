# 当日亏损偏移审查问题 (2026-01-31)

## 范围
- 计划: docs/plans/2026-01-31-daily-direction-pnl-unrealized-loss.md
- 目标: 将当日亏损偏移按 (monitorSymbol + direction) 应用于浮亏检查与买入风控
- 涉及代码路径: dailyLossTracker, unrealizedLossChecker, riskChecker, orderMonitor, mainProgram, processMonitor

## 已确认问题（需要修复）

### 1) 日切未刷新浮亏缓存
**现象**
- `dailyLossTracker.resetIfNewDay()` 会清空 tracker，但 `unrealizedLossData` 缓存未刷新。
- `riskChecker.checkUnrealizedLossBeforeBuy()` 读取的 `r1` 仍包含前一日偏移。

**影响**
- 跨日时买入风控可能继续使用昨天的当日亏损偏移。
- 违反“新北京日必须重置当日亏损偏移”的需求。

**建议修复**
- 让 `resetIfNewDay()` 返回布尔值（`didReset`）。
- 若 `didReset`，对当前活跃席位（LONG/SHORT）逐一刷新浮亏数据，使用新的（0）偏移。

### 2) 换标后旧标的成交未刷新当前席位缓存
**现象**
- 旧标的成交会更新 `dailyLossTracker` 的偏移（通过 `monitorSymbol`），但主刷新流程只按成交 `symbol` 刷新。
- 换标后该 `symbol` 不在活跃席位映射中，导致当前席位不刷新。

**影响**
- 当日亏损偏移已变化，但当前席位的 `r1` 仍是旧值。
- 买入风控可能在偏移更新后仍放行交易。

**建议修复**
- 成交时按 `monitorSymbol + direction` 解析当前席位 symbol，并对该席位 enqueue 刷新。
- 若席位未就绪，回退使用成交 `symbol`。

## 非阻断备注（可选清理）
- `dailyLossTracker.ts` 与 `risk/utils.ts` 中存在重复工具函数（`resolveBeijingDayKey`、`sumOrderCost`），建议按规范下沉至 `risk/utils.ts`。
- `dailyLossTracker.ts` 存在未使用导入：`OrderStatus`。

## 验证缺口
- 当前检查脚本仅覆盖“做多单标的”的简单场景。
- 建议补充：
  - 做空方向案例
  - 多监控标的分组
  - 跨日 reset 场景
  - 换标后旧标的成交场景
