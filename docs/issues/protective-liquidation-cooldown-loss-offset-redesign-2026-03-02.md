# 清仓冷却结束后偏移持续生效问题（三次全链路分析与最终重构方案）

## 0. 结论先行

1. 该问题**真实存在**，并且是交易可用性与风控语义一致性的关键缺陷。
2. 必须修复，且必须采用系统性重构，不应使用 `if` 特判类补丁。
3. 最终语义采用你确认的 **选项 1**：
   - 冷却结束后，旧分段偏移失效；
   - 冷却结束后，后续成交进入新分段继续记录偏移。
4. “换标导致亏损累计失效”的原始业务目标必须保留：
   - 在同一冷却有效期内，换标前后应共享同一分段偏移；
   - 只有冷却结束事件才能切段，换标事件本身不能切段。

---

## 1. 术语修正与最终语义

你指出“冷却周期窗口偏移”语义不准，这个判断正确。

建议统一术语为：

- **保护事件分段偏移（Protection Episode Segmented Offset）**

最终语义定义：

1. 偏移按 `monitorSymbol + direction` 维护，不按 seatSymbol 维护。
2. 偏移是“分段”概念，不是“仅冷却期间记录”。
3. **冷却结束是唯一切段边界**。
4. 同一分段内，允许发生换标，偏移持续累计以防亏损因换标丢失。
5. 切段后旧偏移失效，新成交进入新分段。

---

## 2. 当前实现全链路复核（现状证据）

### 2.1 成交写入链：偏移与冷却并行、无统一边界

- 成交后会写入 `dailyLossTracker.recordFilledOrder(...)`。
- 保护性清仓成交后会写入 `liquidationCooldownTracker.recordLiquidationTrigger(...)`。
- 两者是并行状态，无“冷却结束 -> 偏移切段”机制。

相关实现：

- `src/core/trader/orderMonitor/eventFlow.ts`

### 2.2 买入判定链：只拦冷却，不处理旧偏移失效

- 买入前先用 `getRemainingMs(...)` 判断是否冷却中。
- 冷却结束后会放行到 `riskChecker.checkBeforeOrder(...)`。
- 但 `checkBeforeOrder` 仍会读取包含旧偏移影响的浮亏数据。

相关实现：

- `src/core/signalProcessor/riskCheckPipeline.ts`
- `src/core/riskController/index.ts`

### 2.3 偏移生效链：旧偏移会继续抬高 R1

- 浮亏刷新时：`adjustedR1 = baseR1 - dailyLossOffset`。
- `dailyLossOffset <= 0`，因此会抬高成本口径。
- 即使 `n1=0`，只要 `r1>0`，买入风控仍可能拒买。

相关实现：

- `src/core/riskController/unrealizedLossChecker.ts`
- `src/core/riskController/index.ts`

### 2.4 冷却过期链：过期时只清冷却 map，不清偏移分段

- `getRemainingMs` 在过期时删除 `cooldownMap/triggerCountMap`。
- `dailyLossTracker` 仅在跨日 `resetAll` 清空。
- 同交易日内不存在“冷却结束触发偏移失效”的机制。

相关实现：

- `src/services/liquidationCooldown/index.ts`
- `src/core/riskController/dailyLossTracker.ts`
- `src/main/lifecycle/cacheDomains/riskDomain.ts`

### 2.5 启动恢复链：恢复顺序与分段语义不一致

当前 `loadTradingDayRuntimeSnapshot` 顺序：

1. `dailyLossTracker.recalculateFromAllOrders(...)`
2. `tradeLogHydrator.hydrate()`

这意味着先按“全天订单”回算偏移，再恢复冷却状态，无法表达“冷却结束后的切段边界”。

相关实现：

- `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts`
- `src/services/liquidationCooldown/tradeLogHydrator.ts`

---

## 3. 换标影响专项全链路分析（重点）

## 3.1 为什么偏移必须跨换标连续

系统的亏损偏移本质上是按“监控标的方向账本”计量，而不是按单一交易标的 seatSymbol 计量。换标（旧票 -> 新票）不应让亏损累计归零，否则会出现“换标规避亏损约束”。

该方向当前实现已具备正确基础：

- `dailyLossTracker` 按 `monitorSymbol + direction` 聚合。
- `tradeLogHydrator.collectLiquidationRecordsByMonitor(...)` 也按 `monitorSymbol + direction` 聚合保护性清仓。

相关实现：

- `src/core/riskController/dailyLossTracker.ts`
- `src/services/liquidationCooldown/utils.ts`

### 3.2 距离换标链路（会发生卖旧/买新）

距离换标状态机关键路径：

1. `CANCEL_PENDING` 撤旧标的挂买单。
2. `SELL_OUT` 对旧标的移仓卖出（有可用仓位时）。
3. `BIND_NEW` 绑定新标的。
4. `REBUY` 以卖出名义金额回补买入新标的。

这条链路会在同一 `monitor+direction` 下产生多笔成交，若在冷却未结束期间发生，应保持同一分段偏移连续累计。

相关实现：

- `src/services/autoSymbolManager/switchStateMachine.ts`

### 3.3 周期换标链路（不做移仓卖出/回补）

周期换标可在空仓条件下切换 seat，且显式约束“不提交 sell/rebuy”。其风险是 seatSymbol 变化后缓存刷新口径是否仍保持 `monitor+direction` 账本一致。

相关实现：

- `src/services/autoSymbolManager/switchStateMachine.ts`
- `tests/services/autoSymbolManager/periodicSwitch.business.test.ts`

### 3.4 SEAT_REFRESH 链路（换标后核心刷新）

`SEAT_REFRESH` 当前顺序：

1. `dailyLossTracker.recalculateFromAllOrders(...)`
2. `orderRecorder.refreshOrdersFromAllOrdersForLong/Short(nextSymbol, ...)`
3. 读取 `getLossOffset(monitorSymbol, isLong)`
4. `refreshUnrealizedLossData(...)`

说明：

- 换标后浮亏缓存仍读取 `monitor+direction` 偏移，而不是 nextSymbol 专属偏移。
- 因此“跨换标连续”在现状是存在的；问题不是“换标丢偏移”，而是“冷却结束后旧偏移不失效”。

相关实现：

- `src/main/asyncProgram/monitorTaskProcessor/handlers/seatRefresh.ts`

### 3.5 关键语义结论

1. 换标不应作为切段边界。
2. 冷却结束应作为切段边界。
3. 只要冷却未结束，换标前后必须同段累计（满足你强调的业务目的）。
4. 冷却结束后必须立刻切到新段，阻断旧偏移对新交易周期的污染。

---

## 4. 问题存在性与修复必要性

### 4.1 可复现后果 A：冷却结束后仍拒买

- 清仓后 `n1=0`，但旧偏移让 `r1>0`。
- 冷却结束后买入链放行到基础风控。
- 浮亏口径仍可能触发 `maxDailyLoss` 拒买。

### 4.2 可复现后果 B：冷却结束后新仓更易再次保护性清仓

- 新仓 `baseR1` 被旧偏移继续抬高。
- 相同价格波动更容易触发 `checkUnrealizedLoss`。

### 4.3 可复现后果 C：重启前后行为不一致风险

- 运行态没有切段。
- 重启恢复又基于全量订单与日志重放，顺序不统一。
- 容易出现“同一时间点，不停机与重启后行为差异”。

结论：必须修复。

---

## 5. 最终方案（系统性重构，非补丁）

## 5.1 设计原则

1. **单一边界原则**：仅 `COOLDOWN_EXPIRED` 触发切段。
2. **作用域原则**：只影响 `monitorSymbol + direction`。
3. **一致性原则**：运行态与重启态使用同一分段模型。
4. **换标连续原则**：换标期间不切段。

### 5.2 数据模型重构

#### A. liquidationCooldown 状态事件化

新增“过期事件”能力：

- `sweepExpired(nowMs): ReadonlyArray<CooldownExpiredEvent>`

事件字段建议：

- `monitorSymbol`
- `direction`
- `cooldownEndMs`
- `triggerCountAtExpire`

同时约束：

- `getRemainingMs` 变为纯查询，不再承担过期清理副作用。
- 过期清理与事件发射由 `sweepExpired` 统一负责。

#### B. dailyLossTracker 分段化

按 `monitor+direction` 增加分段元数据：

- `segmentStartMs`
- `lastResetByCooldownEndMs`（幂等保护）

新增接口：

- `resetDirectionSegment({ monitorSymbol, direction, segmentStartMs, cooldownEndMs })`

改造接口：

- `recalculateFromAllOrders(..., segmentStartByDirection)`
- `recordFilledOrder(...)` 仅接受 `executedTimeMs >= segmentStartMs`

#### C. 新增生命周期协调器

新增模块建议：

- `src/core/riskController/lossOffsetLifecycleCoordinator.ts`

职责：

1. 调 `liquidationCooldownTracker.sweepExpired(nowMs)` 拉取过期事件。
2. 对每个事件调用 `dailyLossTracker.resetDirectionSegment(...)`。
3. 输出结构化日志（用于审计和回放对账）。

### 5.3 主循环接入

在 `mainProgram` 每轮 tick 前段执行：

- `lossOffsetLifecycleCoordinator.sync(currentTimeMs)`

要求：

- 即使 `canTradeNow=false` 也要运行 sync，防止边界漂移。

### 5.4 启动恢复链重排

`loadTradingDayRuntimeSnapshot` 调整为：

1. 读取 `allOrders`
2. `tradeLogHydrator.hydrate()` 返回冷却与分段恢复结果（非 void）
3. `dailyLossTracker.recalculateFromAllOrders(..., segmentStartByDirection)`

目的：重启后的分段边界与运行态一致。

### 5.5 换标链路不改边界，只改一致性接入

`SEAT_REFRESH` 与换标状态机不应自行切段；仅共享 `dailyLossTracker` 的当前分段结果。

这样可保证：

- 冷却未结束：换标不丢亏损累计。
- 冷却已结束：不继承旧段偏移。

---

## 6. 方案可行性与合理性评估

### 6.1 可行性

- 架构已存在清晰模块边界（cooldown / riskController / lifecycle / main loop）。
- 关键主键 `monitor+direction` 已贯通。
- 主要改造集中在类型与生命周期联动，不需要重写交易主链。

结论：可行性高。

### 6.2 合理性

- 保留换标连续累计能力（符合你的业务初衷）。
- 修复冷却结束后旧偏移污染。
- 运行态、换标态、重启态语义统一。

结论：合理性高。

### 6.3 与 TypeScript 规范一致性要求

实现阶段必须满足 `typescript-project-specifications`：

1. 类型优先，禁止 `any`。
2. 接口扩展在 `types.ts` 完整定义，禁止行内 `import('...')`。
3. 采用工厂函数 + 依赖注入，不在内部隐式创建依赖。
4. 命名与语义一致（如 `sweepExpired` 必须只做过期扫描与事件产出）。
5. 最终必须通过 `bun lint` 与 `bun type-check`。

---

## 7. 边界问题矩阵（重点补充）

| 编号 | 场景                                | 风险点             | 期望行为                                               |
| ---- | ----------------------------------- | ------------------ | ------------------------------------------------------ |
| B01  | 冷却结束与买入同一 tick             | 竞态               | 先执行 `sync/sweepExpired`，再进入买入风控             |
| B02  | 冷却在非交易时段结束                | 延迟切段           | 非交易时段也执行 `sync`，开盘不带旧段偏移              |
| B03  | `triggerLimit > 1`，未达上限即换标  | 计数与偏移错位     | 仅计数累积，不激活冷却，不切段                         |
| B04  | 达上限激活冷却后发生距离换标        | 换标后亏损丢失     | 同段连续累计，直到冷却结束                             |
| B05  | 距离换标 `availableQuantity=0` 等待 | 状态挂起           | 未成交前不新增偏移，不切段                             |
| B06  | 距离换标失败回 EMPTY                | 脏状态残留         | 不切段；仅席位失败处理与队列清理                       |
| B07  | 周期换标 pending 等空仓             | 定时与仓位竞态     | pending 期间不切段，仍按当前冷却状态                   |
| B08  | 周期换标触发但候选同标被抑制        | 误切段             | 不切段；保持原分段                                     |
| B09  | 同日多次保护性清仓（多周期）        | 分段重复消费       | 每次过期事件只消费一次（幂等）                         |
| B10  | LONG/SHORT 同 monitor 并发          | 方向串扰           | 分段与过期事件按方向隔离                               |
| B11  | 多 monitor 并发                     | 标的串扰           | 分段按 monitor 隔离                                    |
| B12  | 分钟模式跨午夜                      | 日切与分钟冷却叠加 | 午夜 `resetAll` 后新交易日独立；分钟模式不跨日继承偏移 |
| B13  | half-day/one-day 跨午夜             | 冷却到点边界       | 按香港时区结束，结束即切段                             |
| B14  | 重启时冷却仍有效                    | 恢复一致性         | hydrate 恢复 segmentStart，再回算偏移                  |
| B15  | 重启时冷却已过期                    | 历史污染           | hydrate 产出已过期边界，回算仅保留新段                 |
| B16  | `SEAT_REFRESH` 与冷却过期同周期触发 | 顺序一致性         | 先 `sync` 切段，再 `SEAT_REFRESH` 回算                 |
| B17  | post-trade refresher 与切段并发     | 缓存抖动           | 通过幂等 reset + 单向事件消费保证最终一致              |

---

## 8. 重构后测试方案（详细且完整）

## 8.1 单元测试（新增/重构）

### A. liquidationCooldown

文件：`tests/services/liquidationCooldown/business.test.ts`

新增用例：

1. `sweepExpired` 只发一次过期事件（幂等）。
2. `getRemainingMs` 不再做删除副作用（纯查询）。
3. 三种模式（minutes/half-day/one-day）在香港时区边界的 `cooldownEndMs` 准确性。

### B. dailyLossTracker（建议新增文件）

文件建议：`tests/core/riskController/dailyLossTracker.segment.business.test.ts`

新增用例：

1. `segmentStartMs` 过滤历史成交。
2. `resetDirectionSegment` 幂等（同 `cooldownEndMs` 重放无副作用）。
3. monitor 隔离与方向隔离。
4. 回算 + 增量混合一致性（recalculate 后继续 record）。

### C. lossOffsetLifecycleCoordinator（新增）

文件建议：`tests/core/riskController/lossOffsetLifecycleCoordinator.business.test.ts`

新增用例：

1. 过期事件批量消费与顺序稳定性。
2. coordinator 重入安全。
3. 异常分支日志与不中断策略（按项目容错策略定义）。

### D. tradeLogHydrator

文件：`tests/services/liquidationCooldown/tradeLogHydrator.business.test.ts`

新增用例：

1. hydrate 返回 segment 边界数据。
2. 冷却活跃/已过期两种场景恢复分段差异。
3. 换标前后成交混合日志（同 monitor+direction）恢复正确。

## 8.2 集成测试（关键业务链）

1. `PL -> 冷却中 -> 距离换标(卖旧买新) -> 冷却结束 -> 首次买入`
   - 验证：换标期间偏移连续；结束后旧偏移失效；可买入。
2. `PL -> 周期换标 pending -> 空仓后换标 -> 冷却结束`
   - 验证：pending/换标不切段；仅过期切段。
3. `冷却结束后新分段首笔亏损 -> 再次保护性清仓`
   - 验证：新分段偏移生效，不依赖旧段。
4. `上述场景在重启后重复`
   - 验证：重启与不停机一致。

## 8.3 回归测试（现有链路覆盖加强）

1. `tests/integration/auto-symbol-switch.integration.test.ts`
   - 增补冷却与偏移断言。
2. `tests/main/asyncProgram/monitorTaskProcessor/business.test.ts`
   - 增补 `SEAT_REFRESH` 与分段边界顺序断言。
3. `tests/main/lifecycle/loadTradingDayRuntimeSnapshot.test.ts`
   - 增补 hydrate 与 dailyLoss 回算顺序断言。
4. `tests/main/lifecycle/rebuildTradingDayState.test.ts`
   - 增补按分段偏移重建浮亏缓存断言。

## 8.4 时序与并发专项测试

1. 同一秒内：过期事件 + 买入信号 + seatRefresh。
2. 双方向并发（LONG/SHORT）独立过期。
3. 多 monitor 并发下事件消费顺序确定性。

---

## 9. 实施计划（完整落地）

### 阶段 1：类型与接口定稿

1. 扩展 `liquidationCooldown/types.ts`。
2. 扩展 `riskController/types.ts`。
3. 扩展 `mainProgram/types.ts` 与注入链。

### 阶段 2：领域实现

1. 实现 `sweepExpired`。
2. 实现 `dailyLossTracker` 分段能力。
3. 新增 `lossOffsetLifecycleCoordinator`。

### 阶段 3：运行态接入

1. 主循环接入 coordinator `sync`。
2. 保证 `canTradeNow=false` 也执行。

### 阶段 4：启动恢复改造

1. `tradeLogHydrator.hydrate()` 返回结构化恢复结果。
2. `loadTradingDayRuntimeSnapshot` 调整调用顺序。

### 阶段 5：测试与验收

1. 单元/集成/回归补齐。
2. 执行 `bun lint`、`bun type-check`、目标测试集。

---

## 10. 验收标准（必须全部满足）

1. 冷却结束后，旧段偏移不参与买入风控。
2. 冷却结束后，旧段偏移不抬高浮亏监控 R1。
3. 冷却未结束时，换标前后偏移连续累计。
4. 冷却结束后，新成交进入新段并可再次累计。
5. 多 monitor、多方向严格隔离。
6. 重启与不停机行为一致。
7. minutes / half-day / one-day / triggerLimit>1 全覆盖通过。

---

## 11. 最终决议（已锁定）

本问题按你确认的 **选项 1** 执行，不再保留二选一：

- 冷却结束后旧段偏移失效；
- 冷却结束后继续记录新段偏移；
- 换标仅影响 seatSymbol，不构成分段边界。

该决议同时满足：

1. 防止换标导致亏损累计失效；
2. 防止冷却结束后旧偏移污染新交易周期。
