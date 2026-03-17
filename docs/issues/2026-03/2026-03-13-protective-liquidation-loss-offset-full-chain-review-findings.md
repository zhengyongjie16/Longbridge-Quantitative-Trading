# 保护性清仓偏移重构全链路复核问题清单（2026-03-13）

## 1. 审查目标

本次审查以第一性原理为基准，不预设“文档方案正确”或“当前实现正确”，仅以业务不变量判断：

1. `dailyLossOffset` 的切段边界是否严格由“保护性清仓业务事件完成”驱动。
2. 运行时与重启恢复后的偏移语义是否一致。
3. 清仓冷却是否仅保留买入门禁职责，不再驱动偏移切段。

---

## 2. 审查范围

核心链路文件：

1. `src/core/riskController/dailyLossTracker.ts`
2. `src/core/trader/orderMonitor/settlementFlow.ts`
3. `src/core/trader/protectiveLiquidationEpisodeTracker/index.ts`
4. `src/main/asyncProgram/postTradeRefresher/index.ts`
5. `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts`
6. `src/services/liquidationCooldown/*`
7. `src/core/orderRecorder/utils.ts`

---

## 3. 结论总览

### 3.1 主链路通过项

1. 运行时链路已改为“成交记进度、完成后切段”，切段入口集中在 `postTradeRefresher`。
2. `dailyLossTracker` 已采用严格边界过滤：仅纳入 `executedTimeMs > boundary` 的成交。
3. 刷新失败时会跳过完成判定，避免基于陈旧持仓推进边界。
4. 冷却链路已从偏移切段职责解耦。

### 3.2 仍存在的问题

当前仍有 2 个需要处理的问题，其中 1 个为严重问题，会直接破坏重启一致性语义。

---

## 4. 问题清单

## [严重-必须修复] ISSUE-01：启动恢复在“已完成事件 + 新进行中事件并存”时会丢失已完成边界

### 证据位置

1. `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts:155-230`
2. `src/core/trader/protectiveLiquidationEpisodeTracker/index.ts:108-110`
3. `src/core/trader/protectiveLiquidationEpisodeTracker/index.ts:133-137`

### 问题描述

恢复链按方向只保留一个 `latestExecutedTimeMs`，并在 completed/in-progress 二选一写入。  
当同方向出现“历史已完成保护性清仓 + 当前新一轮进行中清仓”并存时，当前实现会只保留进行中进度，导致已完成边界未写入 `latestProtectionBoundaryByDirection`。

### 业务影响

1. `dailyLossTracker.recalculateFromAllOrders(...)` 拿不到应有边界。
2. 边界之前的成交会在重启后重新进入当前周期计算。
3. 破坏“重启前后偏移一致性”不变量。

### 二次确认

已用脚本复现实例（同方向先完成一次，再出现新进行中事件）：

1. `restoreCompletedBoundary` 未被调用。
2. `restoreInProgressEpisode` 被调用。
3. 传给 `dailyLossTracker` 的边界 map 为空。

该问题可稳定复现，非误报。

### 修复必要性

必须修复。该问题属于边界恢复建模错误，不是日志或注释层问题。

---

## [重要-建议按必须处理] ISSUE-02：重算链忽略部分成交后 CANCELED/REJECTED 的真实成交，导致运行时与重启后账本不一致

### 证据位置

1. `src/core/trader/orderMonitor/settlementFlow.ts:475-534`
2. `src/core/orderRecorder/utils.ts:130-162`
3. `src/core/riskController/dailyLossTracker.ts:203-230`

### 问题描述

运行时结算链会将 `CANCELED/REJECTED` 下的已成交部分写入 `dailyLossTracker`（通过 `recordFilledOrder`）。  
但重启回算使用 `classifyAndConvertOrders`，仅采集 `OrderStatus.Filled`，会丢失这类部分成交事实。

### 业务影响

1. 运行中 `dailyLossOffset` 与重启后回算结果不一致。
2. 浮亏阈值抬升口径在重启后可能突变。
3. 重启一致性不变量被破坏。

### 二次确认

已通过脚本构造“买单部分成交后取消 + 卖单成交”场景验证：  
重算结果输出 `lossOffset = 0`，与成交事实不一致，确认问题真实存在。

### 修复必要性

建议按必须处理。若目标包含“重启前后语义一致”，该问题即为必须修复。

---

## 5. 测试执行结果

已执行与本次重构直接相关测试集，结果如下：

1. `34 pass / 0 fail`
2. `bun type-check` 通过
3. `bun lint` 通过

说明：当前测试覆盖了主链路可运行性，但尚未覆盖上述两个问题场景，因此未能拦截该类缺陷。

---

## 6. 建议补充测试

1. 启动恢复：同方向“历史已完成 + 新进行中”并存场景，断言边界与进行中状态同时保真。
2. 日内亏损回算：覆盖 `CANCELED/REJECTED` 且存在已成交数量的订单，断言重启后偏移与运行时一致。
3. 集成场景：保护性清仓完成后再触发下一轮部分成交，重启前后 `dailyLossOffset` 一致性断言。

---

## 7. 最终判定

本次重构方向正确，但在“恢复链边界保真”和“部分成交跨重启一致性”上仍有缺口。  
在 ISSUE-01 与 ISSUE-02 修复前，不应判定为“重构已完全正确且逻辑全部正确”。
