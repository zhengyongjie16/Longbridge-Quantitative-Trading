# 保护性清仓后浮亏偏移未归零问题全链路复核与最终修复方案（2026-03-13）

## 1. 文档目的

本文档用于给出“保护性清仓触发后，浮亏偏移必须从该次保护性清仓之后重新计算”的最终修复方案。

本文档结论基于对以下链路的二次全链路复核：

1. 浮亏清仓触发链：`src/core/riskController/unrealizedLossMonitor.ts`
2. 浮亏缓存计算链：`src/core/riskController/unrealizedLossChecker.ts`
3. 日内亏损偏移链：`src/core/riskController/dailyLossTracker.ts`
4. 订单成交结算链：`src/core/trader/orderMonitor/settlementFlow.ts`
5. 清仓冷却链：`src/services/liquidationCooldown/index.ts`
6. 买入风控链：`src/core/signalProcessor/riskCheckPipeline.ts`
7. 启动恢复链：`src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts`
8. 冷却日志恢复链：`src/services/liquidationCooldown/tradeLogHydrator.ts`
9. 主循环生命周期链：`src/main/mainProgram/index.ts`
10. 订单提交与恢复链：`src/core/trader/orderExecutor/submitFlow.ts`、`src/core/trader/orderMonitor/recoveryFlow.ts`

本文档同时明确废弃 `docs/issues/2026-03/2026-03-02-protective-liquidation-cooldown-loss-offset-redesign.md` 中“冷却结束是唯一切段边界”的语义。该语义不满足当前业务要求。

---

## 2. 结论先行

### 2.1 最终结论

当前问题真实存在，且属于实现语义错误，不是局部漏调。

当前系统把 `dailyLossOffset` 的切段边界绑定在“冷却结束”上，而不是“保护性清仓成交”上。这会导致旧亏损偏移在部分场景下继续污染下一次开仓后的浮亏计算。

### 2.2 必须落实的正确语义

唯一正确语义如下：

1. `dailyLossOffset` 的分段边界必须是“保护性清仓业务事件完成确认”。
2. 所谓“完成确认”，是指该 `monitorSymbol + direction` 的保护性清仓链路已经结束，且该方向持仓已经归零。
3. 一次保护性清仓业务事件完成后，该 `monitorSymbol + direction` 的旧偏移立即失效。
4. 之后的新成交，只能从该次保护性清仓事件完成之后重新累计。
5. 清仓冷却只负责“禁止买入”的门禁，不再承担偏移切段语义。

### 2.3 最短正确路径

最短且正确的修复路径不是继续修补“冷却到期切段”模型，也不是简单改成“保护性订单一成交就切段”，而是直接把“偏移分段”的领域边界改成“保护性清仓业务事件完成边界”，并移除与冷却生命周期的绑定。

这不是补丁，而是纠正错误领域建模。

---

## 3. 第一性原理与业务不变量

### 3.1 问题本质

`dailyLossOffset` 的目的不是描述冷却窗口，而是描述“当前交易周期已经实现的亏损对后续浮亏阈值的抬高作用”。

一旦保护性清仓成交，上一交易周期已经被系统主动终止。此后再开的仓位属于新的交易周期。

因此：

- 旧周期亏损不能继续抬高新周期的 `R1`
- 新周期必须从零开始重新累计

### 3.2 正确边界

从业务上看，能把旧周期和新周期隔开的事件只有一个：

- 保护性清仓业务事件完成确认

不是：

- 冷却开始
- 冷却结束
- 换标
- 重启
- 开盘重建

### 3.3 正确的不变量

修复后必须满足以下不变量：

1. 对任意 `monitorSymbol + direction`，最近一次“已完成保护性清仓事件边界”之前或等于边界的成交，不得参与当前周期 `dailyLossOffset`。
2. 对任意 `monitorSymbol + direction`，只有在最近一次“已完成保护性清仓事件边界”之后的成交，才参与当前周期 `dailyLossOffset`。
3. 保护性清仓是否触发买入冷却，不影响偏移是否切段。
4. 是否配置 `liquidationCooldown`，不影响偏移是否切段。
5. `liquidationTriggerLimit > 1` 时，即便本次未激活冷却，只要一轮保护性清仓业务事件已经完成，也必须切段。
6. 同一次保护性清仓事件即便拆成多笔终态订单，也只能切段一次，也只能累计一次冷却触发。

---

## 4. 当前实现为何错误

## 4.1 运行时触发链错误

当前保护性清仓提交成功后：

1. `unrealizedLossMonitor` 清空买单记录
2. `unrealizedLossMonitor` 刷新浮亏缓存
3. 但没有在此链路上重置 `dailyLossOffset`

这意味着运行时只做了“避免重复触发”的临时处理，没有完成“新周期起算”的账本边界切换。

## 4.2 成交结算链错误

当前 `settlementFlow` 在保护性清仓成交后会：

1. `dailyLossTracker.recordFilledOrder(...)`
2. `liquidationCooldownTracker.recordLiquidationTrigger(...)`
3. 根据是否激活冷却决定是否进入冷却

但不会在保护性清仓成交时立刻切分新的偏移分段。

因此：

- `liquidationCooldown = null` 时，旧偏移不会失效
- `liquidationTriggerLimit > 1` 且本次未达到上限时，旧偏移不会失效

这正是本问题的根因。

## 4.3 启动恢复链也沿用了错误边界

当前恢复链通过 `tradeLogHydrator` 恢复的是“冷却边界”，然后按“冷却边界”回算 `dailyLossOffset`。

这说明问题不是运行时局部缺陷，而是系统级领域边界定义错误。

## 4.4 旧方案为何必须废弃

`2026-03-02` 文档把“冷却结束”定义成唯一切段边界，目标是让换标在冷却期内连续累计。

该方案的根本错误是把两个不同问题混成了一个问题：

1. 买入门禁何时恢复
2. 新交易周期何时开始

这两件事不是一回事。

正确做法是：

- 新交易周期：保护性清仓业务事件完成时开始
- 买入门禁：按冷却配置独立控制

## 4.5 若按“订单级成交即切段”实现，会引入新的问题

第二轮复核确认，当前订单监控允许同一次保护性清仓业务事件拆成多笔终态订单：

1. 原保护性卖单可能部分成交后撤单
2. `quoteFlow` 会继续提交带保护性标记的市价单完成剩余卖出
3. 这些子订单都会沿用 `isProtectiveLiquidation=true`

因此若直接按“任一保护性订单终态成交就切段”，会出现：

1. 同一次保护性清仓被切成多个新周期
2. 同一次保护性清仓被重复累计冷却触发次数
3. 重启恢复时无法区分“已完成事件”和“未完成事件中的中间成交”

所以，最终边界必须再收紧一层：

- 不是保护性订单成交
- 而是保护性清仓业务事件完成

---

## 5. 最终修复方案

## 5.1 方案总述

将 `dailyLossOffset` 从“冷却驱动分段”重构为“保护性清仓业务事件完成驱动分段”。

### 明确要求

1. 删除“冷却结束触发偏移切段”的领域语义
2. 删除 `dailyLossTracker` 对 `cooldownEndMs` 的依赖
3. 删除主循环中为偏移切段服务的冷却生命周期协调逻辑
4. 将偏移边界改为“最近一次已完成保护性清仓事件时间”

这是唯一方案，不保留兼容模式，不保留双语义分支，不保留兜底回退。

---

## 5.2 数据模型重构

## A. `dailyLossTracker` 从“冷却边界”改为“保护性清仓边界”

当前 `dailyLossTracker` 的分段参数是：

- `segmentStartMs`
- `cooldownEndMs`

这套命名和语义都不对，必须替换。

### 新语义

按 `monitorSymbol + direction` 维护：

1. `latestProtectionBoundaryMs`
   - 表示最近一次已完成保护性清仓事件的边界时间
   - 所有 `executedTimeMs <= latestProtectionBoundaryMs` 的成交都不属于当前周期

2. `lastAppliedProtectionBoundaryMs`
   - 用于幂等保护
   - 只允许边界单向前进

### 过滤规则

`dailyLossTracker` 重新计算或增量写入时，统一使用以下规则：

- 仅接受 `executedTimeMs > latestProtectionBoundaryMs` 的成交进入当前周期

注意这里必须是严格大于，不是大于等于。

原因：

- 保护性清仓成交本身属于旧周期的结束事件
- 新周期从它之后开始
- 否则重启恢复时会把该笔保护性清仓卖单错误地纳入新周期

## B. 接口重命名

当前 `resetDirectionSegment(...)` 命名已经错误，不应继续沿用。

建议替换为语义明确的新接口：

`startNewProtectionEpisode({ monitorSymbol, direction, boundaryExecutedTimeMs })`

该接口职责固定为：

1. 将该方向当前周期状态清空
2. 写入新的保护性清仓边界
3. 保证边界只向前推进

---

## 5.3 运行时成交链改造

## A. 保护性清仓提交链保持现状，但不承担账本切段职责

`unrealizedLossMonitor` 在保护性清仓单提交成功后，继续保留：

1. 清空 `orderRecorder` 当前买单记录
2. 刷新浮亏缓存

这一步的目的仍然只是：

- 防止同一持仓在订单未成交前被重复判定为再次保护性清仓

它不是账本边界切换点，不在这里重置 `dailyLossOffset`。

### 原因

提交成功不等于成交成功。

若在提交阶段就切段，会在以下场景产生错误：

1. 清仓单撤单
2. 清仓单拒单
3. 清仓单部分成交但未形成完整清仓

因此账本边界只能放在成交结算阶段。

## B. 成交结算链成为唯一运行时切段入口

在 `settlementFlow` 的保护性清仓成交分支中，固定顺序改为：

1. 先按现有逻辑写入 `orderRecorder` 的卖出结果
2. 调用 `dailyLossTracker.recordFilledOrder(...)`
3. 若该成交属于保护性清仓订单且存在实际成交量，则记录“保护性清仓事件进行中”的进度状态
4. 继续现有 `tradeLog` 写入和 `markPostTradeRefresh(...)`

### 这个顺序为什么正确

先 `recordFilledOrder` 再记录事件进度，表示：

- 这笔保护性清仓卖单先正确结束旧周期
- 但是否已经进入新周期，取决于这轮保护性清仓是否真正完成

如果在这里直接切段，会把同一保护性清仓事件拆成多个边界，语义错误。

## C. 交易后刷新链成为唯一完成确认点

`markPostTradeRefresh(...)` 继续保留，`postTradeRefresher` 负责在刷新账户和持仓后确认：

1. 该方向是否已经真实空仓
2. 该方向是否还存在未完成的保护性卖单链路

只有在“已空仓 + 无未完成保护性卖单链路”同时满足时，才发出：

- `ProtectiveLiquidationCompleted`

这个完成事件是唯一权威入口，统一触发：

1. `dailyLossTracker.startNewProtectionEpisode(...)`
2. `liquidationCooldownTracker` 的一次保护性清仓完成计数

这样可保证：

1. 同一次保护性清仓事件只切段一次
2. 同一次保护性清仓事件只累计一次冷却触发
3. 部分成交、超时转市价、撤单后补卖都不会提前切段

---

## 5.4 启动恢复链改造

## A. 偏移边界必须从权威成交订单恢复，不再从冷却边界恢复

启动恢复时，当前周期边界不能只由“最新保护性成交订单”直接推导，而必须由“最新已完成保护性清仓事件”推导。

恢复判断必须同时结合：

1. 当日已成交保护性订单
2. 当日仍未完成的保护性 pending 订单
3. 当前真实持仓快照

原因：

1. 可能存在保护性清仓中间成交，但事件尚未完成
2. 可能存在部分成交后等待补卖的中间状态
3. 仅看最新保护性成交时间会把未完成事件误当成新周期边界

### 新恢复规则

对当日运行时快照，按以下规则恢复：

1. 先解析每个 `monitorSymbol + direction` 的最新保护性清仓执行进度
2. 再判断该方向当前是否已经真实空仓
3. 若已空仓且不存在未完成保护性卖单链路，则将该事件视为已完成，写入 `latestProtectionBoundaryMs`
4. 若未空仓或仍存在未完成保护性卖单链路，则不得推进边界
5. 最后仅回算 `executedTimeMs > latestProtectionBoundaryMs` 的成交，得到当前周期 `dailyLossOffset`

## B. `tradeLogHydrator` 职责收缩

`tradeLogHydrator` 继续保留，但职责只剩下：

1. 恢复冷却状态
2. 恢复当前未完成或已完成的保护性清仓计数口径

它不再输出 `segmentStartByDirection` 它不再参与 `dailyLossOffset` 的边界建模

## C. `loadTradingDayRuntimeSnapshot` 顺序调整

恢复顺序应改为：

1. 获取 `allOrders`
2. 获取当前真实持仓
3. 用 `tradeLogHydrator` 恢复冷却状态
4. 用 `allOrders + 当前持仓` 直接恢复已完成保护性清仓事件边界
5. 再回算 `dailyLossTracker` 当前周期偏移

关键点：

- 偏移恢复依赖订单事实
- 冷却恢复依赖交易日志
- 两者互相独立

这样可保证重启前后语义完全一致。

---

## 5.5 冷却链与偏移链彻底解耦

## A. 冷却链保留的职责

`liquidationCooldownTracker` 修复后只保留以下职责：

1. 记录保护性清仓触发计数
2. 在达到 `liquidationTriggerLimit` 时激活买入冷却
3. 提供 `getRemainingMs(...)` 给买入链做门禁判断
4. 在“保护性清仓完成事件”上累计一次触发计数并按需激活冷却
5. 在启动时恢复冷却与当前周期计数

## B. 冷却链删除的职责

删除以下职责：

1. 偏移切段事件来源
2. `cooldownEndMs` 作为 `dailyLossOffset` 的分段边界
3. 冷却结束驱动 `dailyLossTracker` 切段
4. 保护性订单级成交直接累计冷却次数

## C. 需要移除的模块和调用

以下与旧语义绑定的模块应整体删除或退场：

1. `src/core/riskController/lossOffsetLifecycleCoordinator/index.ts`
2. 其对应的 types、runtime 注入、主循环调用
3. `mainProgram` 中的 `lossOffsetLifecycleCoordinator.sync(...)`
4. `signalProcessor` 中的 `syncLossOffsetLifecycle` 注入与调用
5. `tradeLogHydrator` 中与 `segmentStartByDirection` 相关的输出和注释

## D. 新增完成事件跟踪器

为了避免同一次保护性清仓拆成多次边界，必须新增一个按 `monitorSymbol + direction` 维护的完成事件跟踪器。

建议新增独立模块，例如：

- `src/core/trader/protectiveLiquidationEpisodeTracker.ts`

职责：

1. 记录保护性清仓事件的最新执行进度
2. 在持仓刷新后判断事件是否真正完成
3. 只在完成时向上游发出一次完成事件

这是必须做的系统性收敛，不是可选优化。

---

## 5.6 换标链与其他清仓链说明

## A. 换标不再参与偏移边界

换标前后，`dailyLossOffset` 仍按 `monitorSymbol + direction` 维护。

因此：

1. 换标不是边界
2. 只要在最近一次保护性清仓之后，换标前后的成交都属于同一新周期

这既满足当前 bug 修复目标，也保留原有“不要因为换标丢失当前周期亏损累计”的正确部分。

## B. 非保护性清仓不切段

以下路径不应触发 `dailyLossOffset` 切段：

1. 距回收价清仓
2. 末日保护清仓
3. 普通卖出
4. 智能平仓

只有 `isProtectiveLiquidation === true` 的保护性清仓业务事件在“完成确认”后才切段。

---

## 6. 需要修改的代码范围

## 6.1 核心模块

1. `src/core/riskController/dailyLossTracker.ts`
2. `src/types/risk.ts`
3. `src/core/trader/orderMonitor/settlementFlow.ts`
4. `src/main/asyncProgram/postTradeRefresher/index.ts`
5. `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts`
6. `src/services/liquidationCooldown/tradeLogHydrator.ts`
7. `src/core/trader/protectiveLiquidationEpisodeTracker.ts`

## 6.2 需要删除或去耦的模块

1. `src/core/riskController/lossOffsetLifecycleCoordinator/index.ts`
2. `src/core/riskController/lossOffsetLifecycleCoordinator/types.ts`
3. `src/app/runtime/createPostGateRuntime.ts` 中相关注入
4. `src/main/mainProgram/index.ts` 中相关调用
5. `src/core/signalProcessor/index.ts`
6. `src/core/signalProcessor/riskCheckPipeline.ts` 中相关依赖

## 6.3 可能需要同步调整的测试与注释

1. `tests/services/liquidationCooldown/*`
2. `tests/main/lifecycle/loadTradingDayRuntimeSnapshot.test.ts`
3. `tests/core/riskController/*`
4. `tests/core/signalProcessor/*`
5. `tests/integration/*protective-liquidation*`

---

## 7. 实施步骤

## 阶段 1：定稿领域边界

1. 将 `dailyLossOffset` 正式定义为“保护性清仓分段偏移”
2. 删除所有“冷却结束切段”的注释、类型和命名

## 阶段 2：重构 `dailyLossTracker`

1. 用“最近一次已完成保护性清仓事件边界”替换当前 `cooldownEndMs` 分段模型
2. 新增严格的大于边界过滤规则
3. 将运行时增量写入与启动回算统一到同一边界模型

## 阶段 3：重构成交结算链

1. 在保护性清仓订单产生实际成交时记录事件进度
2. 在交易后持仓刷新确认“已空仓”时切入新周期
3. 冷却计数与偏移切段统一绑定到“完成事件”

## 阶段 4：重构恢复链

1. 将偏移边界恢复改为基于 `allOrders + 当前持仓 + pending protective orders`
2. `tradeLogHydrator` 收缩为冷却与完成计数恢复器

## 阶段 5：删除旧生命周期依赖

1. 删除 `lossOffsetLifecycleCoordinator`
2. 删除主循环和买入链中的相关 sync 调用

## 阶段 6：测试与验收

1. 补齐单元测试
2. 补齐恢复测试
3. 补齐集成测试
4. 通过 `bun lint`
5. 通过 `bun type-check`

---

## 8. 验证方案

## 8.1 单元测试

### A. `dailyLossTracker`

必须覆盖：

1. 无保护性清仓时，全天成交按正常规则累计
2. 存在一笔保护性清仓时，仅统计该成交之后的成交
3. 两笔保护性清仓同日出现时，仅统计最后一笔之后的成交
4. LONG / SHORT 相互隔离
5. 多 `monitorSymbol` 相互隔离
6. 边界为严格大于，等于边界时间的保护性清仓完成事件本身不得进入新周期
7. 存在保护性清仓中间成交但方向未空仓时，不得切段

### B. `settlementFlow`

必须覆盖：

1. 普通卖出成交不切段
2. 保护性清仓订单中间成交但未空仓时，只记录进度，不切段
3. 保护性清仓事件完成且方向空仓时切段
4. `liquidationCooldown = null` 时仍然切段
5. `liquidationTriggerLimit > 1` 且本次未激活冷却时仍然切段
6. 同一次保护性清仓事件拆成多笔终态订单时，只切段一次

### C. `tradeLogHydrator`

必须覆盖：

1. 只恢复冷却、完成计数和未完成事件所需最小状态
2. 不再产出冷却驱动的偏移边界

## 8.2 启动恢复测试

必须覆盖：

1. 当日存在已完成保护性清仓事件，重启后 `dailyLossOffset` 只基于其后的成交回算
2. 当日不存在已完成保护性清仓事件，重启后按全天成交回算
3. 当日存在保护性清仓提交但未完成，重启后不得切段
4. 当日存在保护性清仓部分成交但仍有剩余仓位，重启后不得切段

## 8.3 集成测试

必须覆盖以下关键业务场景：

1. `liquidationCooldown = null`
   - 开仓 -> 保护性清仓完成 -> 再开仓
   - 期望：第二次开仓不继承旧偏移

2. `liquidationTriggerLimit = 2`
   - 第一次保护性清仓完成 -> 未进入冷却 -> 再开仓
   - 期望：仍然不继承旧偏移

3. 存在冷却
   - 保护性清仓完成 -> 冷却期内拒买 -> 冷却结束后再开仓
   - 期望：新仓从零偏移开始

4. 保护性清仓订单部分成交后超时转市价
   - 期望：同一次事件只切段一次、只累计一次冷却触发

5. 保护性清仓后发生换标
   - 期望：只统计保护性清仓完成之后的新周期成交，且换标不再引入旧周期偏移

6. 重启恢复
   - 期望：重启前后 `dailyLossOffset` 与浮亏刷新结果一致

---

## 9. 验收标准

修复完成后，必须同时满足：

1. 每次保护性清仓业务事件完成且方向空仓后，当前方向 `dailyLossOffset` 立即失效并从新周期重新累计。
2. 新周期的第一笔新开仓，不继承该次保护性清仓事件完成之前的负偏移。
3. `liquidationCooldown = null` 场景下，问题仍被彻底修复。
4. `liquidationTriggerLimit > 1` 且本次未激活冷却时，问题仍被彻底修复。
5. 同一次保护性清仓事件拆成多笔终态订单时，只累计一次冷却触发，只切段一次。
6. 重启恢复后的 `dailyLossOffset` 与不停机运行时一致。
7. LONG / SHORT、多 monitor、多次保护性清仓都严格隔离且语义正确。
8. 系统中不再存在“冷却结束驱动偏移切段”的代码路径和文档语义。

---

## 10. 最终决议

本问题最终按以下唯一方案实施：

1. `dailyLossOffset` 的边界改为“最近一次已完成保护性清仓事件”
2. 清仓冷却仅保留买入门禁职责，并在保护性清仓完成事件上累计一次触发
3. 删除冷却驱动偏移切段的生命周期设计
4. 启动恢复按 `allOrders + 当前持仓 + pending protective orders` 恢复偏移边界

这是当前需求下唯一逻辑自洽、全链路一致、且能真正修复该 bug 的方案。
