# 自动换标（距离换标）移仓回补金额错误

## 二次分析确认与系统性修复方案（策略 B）

**日期**：2026-02-26  
**结论**：问题真实存在，且为执行链路级严重缺陷；必须系统性修复，不能补丁处理。

---

## 1. 问题背景

距离换标（超阈值换标）业务要求是：

1. 先卖出旧标的全部可用持仓。
2. 再按“旧标的卖出后的实际成交资金”回补买入新标的（按 lotSize 向下取整）。
3. 若无法得到该资金，不允许回退到配置目标金额下单（策略 B：失败并清席位）。

当前线上逻辑实际出现：

1. 回补买入数量未按旧标的卖出资金执行。
2. 在关键路径上被 `targetNotional` 覆盖，导致错误买入数量。

---

## 2. 二次分析范围与方法

本次二次分析覆盖“调度 -> 状态机 -> 信号 -> 执行 -> 订单记录”的完整链路：

1. `processMonitor / monitorTaskProcessor` 距离换标任务调度
2. `autoSymbolManager/switchStateMachine` 卖出与回补阶段
3. `signalBuilder` 回补信号构造
4. `core/trader/orderExecutor` 实际买单数量计算
5. `orderMonitor + orderRecorder` 卖出成交记录回写
6. 现有单测/集成测试的覆盖边界

---

## 3. 缺陷确认（证据级）

### 3.1 缺陷 A：回补阶段允许回退 `targetNotional`

在回补阶段，当前代码使用：

- `buyNotional = state.sellNotional ?? monitorConfig.targetNotional`
- 位置：`src/services/autoSymbolManager/switchStateMachine.ts:446`

这意味着只要 `sellNotional` 取不到，就会用配置目标金额回补，这与业务口径冲突。

### 3.2 缺陷 B：执行层买入路径忽略 `signal.quantity`

即使状态机已经算好回补数量并写入 `signal.quantity`，执行层买入分支仍固定按目标金额重算：

- `submittedQtyDecimal = calculateBuyQuantity(... targetNotional)`
- 位置：`src/core/trader/orderExecutor.ts:596`

而 `signal.quantity` 在执行器里仅用于卖出路径读取：

- 读取点：`src/core/trader/orderExecutor.ts:326`（卖出数量逻辑）

这会直接覆盖状态机传入的回补数量，是本问题的核心根因。

### 3.3 复现确认（执行层最小复现）

向 `orderExecutor.executeSignals` 传入买入信号：

1. `action=BUYCALL`
2. `quantity=200`
3. `price=1, lotSize=100`

实际提交结果为 `5000`（按 `targetNotional=5000` 重算）而不是 `200`，证实执行层覆盖问题。

---

## 4. 全链路可行性与合理性确认（策略 B）

### 4.1 可行性

修复不需要改变主程序架构，现有状态机与风控门禁可直接承载：

1. 状态机已有 `FAILED -> clearSeat(EMPTY)` 的失败收敛机制。
2. `orderRecorder/orderMonitor` 已具备成交后本地记录能力。
3. `orderExecutor` 已有买卖数量计算分支，可扩展“买入显式数量优先”语义。
4. 距离换标流程可在 REBUY 阶段实施严格阻断。

### 4.2 业务合理性

策略 B（无法确认卖出资金则不回补并失败）符合交易系统“正确性优先”原则：

1. 宁可错过回补，不可用错误资金口径下单。
2. 避免“仓位规模漂移”导致风险参数失真。
3. 与“不能带病交易”的生命周期原则一致。

### 4.3 全链路影响评估

1. 正常路径：卖出成交金额可得 -> 回补数量准确。
2. 异常路径：卖出金额不可得 -> 失败清席位，后续由自动寻标机制恢复。
3. 不会影响普通买入策略（未设置 `signal.quantity` 的场景仍按 `targetNotional`）。

---

## 5. 系统性修复方案（完整方案，非补丁）

## 5.1 执行层语义修复（必须）

目标：统一“买入数量来源”语义，支持回补场景显式数量。

改动点：`src/core/trader/orderExecutor.ts`

1. 买入分支新增“显式数量优先”规则：
   - 若 `signal.quantity` 有效，直接以该数量下单。
   - 仅当 `signal.quantity` 为空时，才按 `targetNotional` 计算。
2. 显式数量校验必须严格：
   - `>0`、有限数、整数、且满足 `lotSize` 整手约束。
   - 不合法则拒绝下单，不允许回退 `targetNotional`。
3. 日志区分两类买入：
   - `按显式数量下单`
   - `按目标金额换算下单`

---

## 5.2 换标状态机回补口径修复（必须）

目标：距离换标回补资金只能来自旧标的实际卖出。

改动点：`src/services/autoSymbolManager/switchStateMachine.ts`

1. 删除回补阶段 `state.sellNotional ?? monitorConfig.targetNotional` 回退。
2. REBUY 阶段必须满足 `state.sellNotional` 有效：
   - 无效时触发策略 B：`failAndClear()`，席位置 `EMPTY`。
3. 失败日志必须结构化输出：
   - monitorSymbol / direction / oldSymbol / nextSymbol / stage / reason

---

## 5.3 卖出金额来源强化（建议按本次修复一并完成）

目标：避免“按 symbol 取最新卖出记录”带来的潜在歧义，确保回补资金与本次换标卖单强绑定。

建议改动：

1. 为本次换标卖单建立唯一关联（按订单 ID）。
2. 在 `orderRecorder` 暴露按 `orderId` 查询成交记录能力。
3. 状态机以该 `orderId` 的实际成交价 \* 成交数量计算 `sellNotional`。

说明：这是系统性完整修复的重要部分，可避免未来并发路径下的误绑定风险。

---

## 6. 为什么当前测试没有测到

## 6.1 自动换标测试大多 stub 掉执行层

`switchStateMachine` 与相关集成测试普遍使用 `createTraderDouble`，`executeSignals` 只记录传入信号，不走真实 `orderExecutor`：

- `tests/helpers/testDoubles.ts:103`
- `tests/services/autoSymbolManager/switchStateMachine.business.test.ts:340`
- `tests/integration/auto-symbol-switch.integration.test.ts:79`

因此只能验证“状态机产出的信号数量”，不能验证“最终 submitOrder 数量”。

## 6.2 断言停在信号层，不在下单层

现有换标测试断言的是 `executedActions[1].quantity === 200`，但并未断言 `submitOrder.submittedQuantity`：

- `tests/services/autoSymbolManager/switchStateMachine.business.test.ts:448`
- `tests/integration/auto-symbol-switch.integration.test.ts:185`

## 6.3 真实执行层测试未覆盖“买入显式数量优先”

`buy-flow` 集成测试只覆盖“按 `targetNotional` 正常买入”：

- `tests/integration/buy-flow.integration.test.ts:72`

缺少“买入信号带 `quantity` 时应优先按 quantity 下单”的用例。

---

## 7. 测试补齐方案（必须）

## 7.1 执行层单元/集成测试

新增：

1. 买入信号带 `quantity` 时，`submitOrder.submittedQuantity` 必须等于该数量。
2. 买入信号 `quantity` 非整手/非法时必须拒单，且不回退 `targetNotional`。
3. 买入信号无 `quantity` 时仍按 `targetNotional` 计算（原行为保持）。

## 7.2 换标端到端测试（真实执行器链路）

新增：

1. 距离换标：卖出成交金额已知时，回补提交数量 =  
   `floor((sellExecutedPrice * sellExecutedQty) / newPrice / lotSize) * lotSize`
2. 卖出金额不可得时（策略 B）：
   - 不提交回补买单
   - 席位转 `EMPTY`
   - `hasPendingSwitch(direction) === false`

## 7.3 回归测试（防止重引入）

新增守护断言：

1. 自动换标回补路径中，不允许出现 `targetNotional` 回退。
2. 执行层买入路径读取 `signal.quantity` 的行为固定存在。

---

## 8. 实施顺序（建议）

1. 先改执行层买入语义（`orderExecutor`）。
2. 再改状态机 REBUY 口径（去回退、策略 B 阻断）。
3. 强化卖出金额来源绑定（orderId 关联）。
4. 补齐测试并跑全量：`bun run lint`、`bun run type-check`、`bun test`。

---

## 9. 验收标准

满足以下全部条件才算修复完成：

1. 距离换标回补不再按 `targetNotional` 下单。
2. 回补数量与旧标的卖出成交资金口径一致。
3. 卖出资金不可得时严格执行策略 B（失败并清席位，不下错误单）。
4. 新增测试可稳定捕获该缺陷并防回归。
5. 全量 lint/type-check/test 全通过。

---

## 10. 最终结论

该问题并非“单点逻辑瑕疵”，而是**状态机与执行器语义不一致**导致的链路级错误。  
采用本方案可在不破坏主架构前提下，实现：

1. 业务口径恢复正确
2. 异常路径可控收敛（策略 B）
3. 测试从“信号层”提升到“真实下单层”，避免同类问题再次漏检
