# 重构方案：保护性清仓冷却改为监控标的双方向冻结（第二轮）

> 日期：2026-03-13  
> 范围：仅重构“买入冷却门禁作用域”，不改动保护性清仓触发、持仓处理、卖出链路

## 1. 原始需求（不可偏离）

当前系统：保护性清仓达到触发次数后会进入交易冷却，但只冻结该监控标的的单方向买入。  
目标系统：一旦该监控标的触发交易冷却，做多和做空两个方向都禁止买入。  
明确约束：若某方向已有持仓，不做额外处理；仅禁用买入。

## 2. 第一性原理拆解

### 2.1 问题本质

1. 冷却的本质是“买入门禁”。
2. 需求变化的是“门禁作用域”，从“方向级”变为“监控标的级（双方向）”。
3. 需求没有要求改变“触发计数语义”和“保护性清仓完成判定语义”。

### 2.2 目标函数

在不改变现有保护性清仓业务闭环的前提下，保证同一监控标的任一方向处于冷却中时，两个方向买入都被拒绝。

### 2.3 最短路径判定标准

1. 只修改唯一买入入口处的冷却判定逻辑。
2. 不引入开关、兼容分支或双实现并行。
3. 不扩散到与需求无关的链路（保护性清仓事件、日内偏移分段、卖出执行）。

## 3. 现状全链路复核（代码事实）

### 3.1 冷却触发写入链路（方向维度）

1. 保护性清仓完成后，在 post-trade 刷新阶段写入冷却触发：`recordLiquidationTrigger(symbol, direction, ...)`。  
   代码位置：`src/main/asyncProgram/postTradeRefresher/index.ts`。
2. 冷却追踪器内部按 `symbol:direction` 存储冷却时间与触发计数。  
   代码位置：`src/services/liquidationCooldown/index.ts`、`src/services/liquidationCooldown/utils.ts`。

### 3.2 买入门禁链路（当前仅单方向）

1. 全系统买入信号只经过 `buyProcessor -> signalProcessor.applyRiskChecks`。  
   代码位置：`src/main/asyncProgram/buyProcessor/index.ts`。
2. 风控中冷却检查当前只查当前买入方向：
   - BUYCALL 查 LONG
   - BUYPUT 查 SHORT  
   代码位置：`src/core/signalProcessor/riskCheckPipeline.ts`。

### 3.3 重启恢复与跨日

1. 启动恢复从日志按 `monitorSymbol:direction` 恢复冷却与计数。  
   代码位置：`src/services/liquidationCooldown/tradeLogHydrator.ts`。
2. 午夜清理对每个 monitor 清理 LONG/SHORT 两个冷却 key，并重置触发计数。  
   代码位置：`src/main/lifecycle/cacheDomains/riskDomain.ts`。

### 3.4 卖出与持仓不受该门禁影响

1. 卖出由独立 `sellProcessor` 处理，不走买入冷却门禁。  
   代码位置：`src/main/asyncProgram/sellProcessor/index.ts`。
2. 因此“仅禁买、不动持仓”可直接通过买入门禁改造满足，无需额外持仓操作。

## 4. 根因定位

根因只有一个：买入冷却判定在 `riskCheckPipeline` 内使用了“当前买入方向”单查，导致冷却作用域是方向级，而不是监控标的级。

## 5. 最终重构方案（唯一方案）

## 5.1 设计决策

将冷却门禁作用域提升为“监控标的级”，但保留现有“方向级触发计数与存储”机制。

理由：

1. 需求只要求“冷却触发后双方向禁买”，未要求改变触发次数统计规则。
2. 当前系统中买入冷却只有一个消费点（`riskCheckPipeline`），在此收口是最短路径。
3. 不改 tracker/hydrator/lifecycle，可避免对保护性清仓与恢复链路引入额外风险。

### 5.2 实施方式（非兼容、非补丁）

在 `riskCheckPipeline` 中移除“按当前方向单查”的逻辑，改为“同一 monitor 同时查询 LONG 与 SHORT 的剩余冷却时间，取最大值作为门禁依据”。

伪代码：

```ts
const nowMs = Date.now();
const longRemainingMs = liquidationCooldownTracker.getRemainingMs({
  symbol: context.config.monitorSymbol,
  direction: 'LONG',
  cooldownConfig: context.config.liquidationCooldown,
  currentTimeMs: nowMs,
});
const shortRemainingMs = liquidationCooldownTracker.getRemainingMs({
  symbol: context.config.monitorSymbol,
  direction: 'SHORT',
  cooldownConfig: context.config.liquidationCooldown,
  currentTimeMs: nowMs,
});
const monitorRemainingMs = Math.max(longRemainingMs, shortRemainingMs);

if (monitorRemainingMs > 0) {
  // 拒绝 BUYCALL 与 BUYPUT
}
```

约束：

1. 不新增配置项。
2. 不保留旧分支。
3. 不引入“若新逻辑失败回退旧逻辑”之类兼容路径。

### 5.3 改动文件

1. `src/core/signalProcessor/riskCheckPipeline.ts`
2. `tests/core/signalProcessor/riskCheckPipeline.business.test.ts`
3. `tests/regression/risk-pipeline-regression.test.ts`
4. `tests/integration/liquidation-cooldown-recovery.integration.test.ts`

说明：

1. `services/liquidationCooldown/*` 不改。
2. `postTradeRefresher`、`tradeLogHydrator`、`riskDomain` 不改。

## 6. 全链路正确性验证

### 6.1 运行时验证

| 场景 | 预置状态 | 动作 | 期望 |
| --- | --- | --- | --- |
| A1 | LONG 冷却中，SHORT 无冷却 | BUYCALL | 拒绝 |
| A2 | LONG 冷却中，SHORT 无冷却 | BUYPUT | 拒绝 |
| A3 | SHORT 冷却中，LONG 无冷却 | BUYCALL | 拒绝 |
| A4 | SHORT 冷却中，LONG 无冷却 | BUYPUT | 拒绝 |
| A5 | LONG/SHORT 都无冷却 | BUYCALL / BUYPUT | 按原风控继续执行 |
| A6 | 任一方向冷却中且有现存持仓 | BUY* | 仅拒买，不触发额外清仓 |

### 6.2 启动恢复验证

| 场景 | 日志恢复结果 | 动作 | 期望 |
| --- | --- | --- | --- |
| B1 | 仅恢复 LONG 冷却 | BUYPUT | 仍拒绝 |
| B2 | 仅恢复 SHORT 冷却 | BUYCALL | 仍拒绝 |
| B3 | 两方向都无有效冷却 | BUYCALL/BUYPUT | 不因冷却拒绝 |

### 6.3 跨日验证

| 场景 | 前提 | 动作 | 期望 |
| --- | --- | --- | --- |
| C1 | half-day/one-day 模式午夜清理执行 | 次日 BUY* | 不受前一日冷却影响 |
| C2 | minutes 模式冷却跨日未到期 | 次日 BUY* | 继续拒绝直到自然过期 |

### 6.4 不变性验证（防回归）

1. 保护性清仓触发计数仍按 monitor+direction 维护。
2. 保护性清仓完成事件判定与日内偏移分段逻辑不变。
3. 卖出流程不受影响。

## 7. 测试方案

### 7.1 新增/修改测试点

1. `riskCheckPipeline.business.test.ts`
   - 新增用例：LONG 冷却时，BUYPUT 被拒绝。
   - 新增用例：SHORT 冷却时，BUYCALL 被拒绝。
2. `risk-pipeline-regression.test.ts`
   - 新增回归用例：同 monitor 任一方向冷却均阻断双方向买入。

### 7.2 执行清单

1. `bun test tests/core/signalProcessor/riskCheckPipeline.business.test.ts`
2. `bun test tests/regression/risk-pipeline-regression.test.ts`
3. `bun test tests/integration/liquidation-cooldown-recovery.integration.test.ts`
4. `bun test tests/services/liquidationCooldown/business.test.ts`
5. `bun test tests/services/liquidationCooldown/tradeLogHydrator.business.test.ts`

## 8. 验收标准

1. 任一方向进入冷却后，同监控标的 BUYCALL/BUYPUT 都被拒绝。
2. 冷却到期后，双方向买入同时恢复。
3. 系统不增加任何与该需求无关的行为变化。
4. 不新增兼容开关，不保留旧判定分支。

## 9. 实施顺序

1. 修改 `riskCheckPipeline` 冷却判定为 monitor 级。
2. 更新单测与回归测试。
3. 执行测试并确认链路通过。
4. 如需同步文档口径，再更新 README 风控描述。
