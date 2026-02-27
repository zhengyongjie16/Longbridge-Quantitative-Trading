# 订单监控实时改单失效与 JS 浮点问题系统性修复方案（2026-02-27）

## 1. 背景与问题定义

### 1.1 问题现象

- 2026-02-27 15:47:01，系统提交卖出订单 `1211942554682003456`（`69767.HK`，委托价 `0.059`）。
- 在后续未成交期间，行情最新价已到 `0.058`，但系统未执行实时改单，导致订单长期挂在 `0.059`。
- 该订单最终成交并非系统自动改单结果，而是人工手动操作后成交。

### 1.2 问题边界（本方案严格范围）

- 仅处理两件事：
  - 订单监控的实时改单触发逻辑。
  - JS 浮点比较导致的阈值误判问题。
- 不处理：
  - 超时转市价逻辑。
  - 末日保护逻辑。
  - 信号生成、智能平仓策略口径。

## 2. 全链路定位结论

### 2.1 主链路正常

- 在可交易时段，`mainProgram` 每秒循环并调度 `orderMonitorWorker.schedule(quotesMap)`。
- `orderMonitorWorker` 采用“最新覆盖 + 串行执行”模型，能持续触发 `orderMonitor.processWithLatestQuotes`。
- 订单提交后 `trackOrder` 已成功加入追踪。

结论：不是“订单监控完全失效”，而是“改单触发条件在特定价差边界被错误跳过”。

### 2.2 根因：1 tick 边界被浮点误判

当前逻辑（`src/core/trader/orderMonitor.ts`）：

- `priceDiff = Math.abs(currentPrice - order.submittedPrice)`
- `if (priceDiff < config.priceDiffThreshold) continue`
- 阈值 `ORDER_PRICE_DIFF_THRESHOLD = 0.001`

在 JS 中：

- `Math.abs(0.058 - 0.059)` 实际为 `0.000999999999999994`
- 该值 `< 0.001` 为 `true`
- 导致“正好 1 tick（0.001）”被误判为“小于阈值”，从而不改单

这与业务期望冲突：`0.059 -> 0.058` 属于应触发改单的最小有效价差。

## 3. 修复目标

- 保证“价差达到阈值（含等于）”必触发改单。
- 消除二进制浮点在阈值边界的不可预期行为。
- 保持现有业务语义不变：仍使用固定阈值 `0.001`，不改变超时、席位、风控等规则。
- 保证“触发判定口径”和“改单提交/追踪回写口径”一致，避免一次改单后继续受精度噪声影响。

## 4. 设计原则

- 使用 `Decimal`（LongPort SDK）完成改单触发判定，不再用 `number` 做阈值比较。
- 判定语义固定为：`abs(current - submitted) >= threshold` 触发改单。
- 判定阶段使用原始价格的 Decimal 差值，不做 3 位四舍五入，避免边界外值被误收敛到阈值上。
- 3 位价格标准化仅用于改单提交与 `trackedOrder.submittedPrice` 回写。

## 5. 代码改造方案

### 5.1 改造文件

- `src/core/trader/orderMonitor.ts`
- `tests/core/trader/orderMonitor.business.test.ts`
- `tests/regression/order-monitor-regression.test.ts`

### 5.2 订单监控判定改造（核心）

位置：`processWithLatestQuotes`

改造前：

- 用 `Math.abs(currentPrice - order.submittedPrice)` 得到 `number` 差值。
- 用 `< 0.001` 判断是否跳过。

改造后：

- 引入 Decimal 差值计算：
  - `currentPriceDecimal = toDecimal(currentPrice)`
  - `submittedPriceDecimal = toDecimal(order.submittedPrice)`
  - `priceDiffDecimal = currentPriceDecimal.sub(submittedPriceDecimal).abs()`
- 预构建 `thresholdDecimal = toDecimal(config.priceDiffThreshold)` 并复用。
- 改为：
  - 当 `priceDiffDecimal.comparedTo(thresholdDecimal) < 0` 时跳过
  - 否则执行 `replaceOrderPrice`

效果：

- `0.059 -> 0.058` 的差值判定稳定命中阈值，不再因浮点误差被误跳过。

### 5.3 改单价格标准化

位置：`replaceOrderPrice`

改造点：

- 提交前将价格规范化为 3 位精度：
  - `normalizedNewPriceText = newPrice.toFixed(3)`
  - `normalizedNewPriceDecimal = toDecimal(normalizedNewPriceText)`
  - `normalizedNewPriceNumber = Number(normalizedNewPriceText)`
- 下单参数使用 `normalizedNewPriceDecimal`。
- 本地 `trackedOrder.submittedPrice` 回写 `normalizedNewPriceNumber`。

目的：

- 保持后续循环中“委托价”和“行情价”比较口径一致，减少精度噪声累积。

### 5.4 前提声明（显式）

- 本修复以当前系统交易范围为前提：改单提交与本地追踪回写按 3 位小数处理，阈值固定为 `0.001`。
- 本修复不扩展价格精度体系，不修改阈值业务语义，仅修正边界比较失真问题。

## 6. 测试方案

### 6.1 业务测试新增

文件：`tests/core/trader/orderMonitor.business.test.ts`

新增场景矩阵：

| 场景             | 初始价 -> 行情价             | 预期                     |
| ---------------- | ---------------------------- | ------------------------ |
| 等于阈值（下跌） | `0.059 -> 0.058`             | `replaceOrder` 调用 1 次 |
| 等于阈值（上涨） | `0.058 -> 0.059`             | `replaceOrder` 调用 1 次 |
| 小于阈值         | `0.059 -> 0.0581`            | `replaceOrder` 调用 0 次 |
| 大于阈值         | `0.059 -> 0.057`             | `replaceOrder` 调用 1 次 |
| 同价重复处理     | `0.058 -> 0.058`（连续两轮） | 不重复改单               |

统一前置条件：`orderMonitorPriceUpdateInterval=0`，排除时间间隔干扰。

### 6.2 回归测试新增

文件：`tests/regression/order-monitor-regression.test.ts`

新增场景：

- 复现 `0.059 -> 0.058` 的历史边界值。
- 固化“`diff == 0.001` 必改单、`diff < 0.001` 不改单”的边界契约，防止后续改动回归。

## 7. 验收标准

- 代码层：
  - `orderMonitor` 不再使用 `Math.abs(number - number)` 进行改单阈值判定。
  - 判定逻辑明确为 `>= 0.001` 触发改单。
  - `replaceOrderPrice` 提交价格与 `trackedOrder.submittedPrice` 回写价格使用同一标准化口径。
- 测试层：
  - 新增业务测试覆盖“`== 阈值`（双向）/ `< 阈值` / `> 阈值` / 同价幂等”场景并通过。
  - 新增回归测试固化历史边界问题并通过。
  - 原有订单监控测试无回归失败。
- 运行层（日志）：
  - 当委托价 `0.059`、最新价 `0.058` 时，出现“更新委托价：0.059 -> 0.058”以及“订单修改成功”日志。

## 8. 实施顺序

1. 先补测试：新增边界矩阵与回归用例，确保问题可稳定复现且契约可被断言。
2. 修改 `orderMonitor.ts` 的价差判定与价格标准化实现。
3. 执行：
   - `bun test tests/core/trader/orderMonitor.business.test.ts tests/regression/order-monitor-regression.test.ts`
   - `bun run lint`
   - `bun run type-check`
4. 用日志回放场景确认 `0.059 -> 0.058` 可触发自动改单。

## 9. 风险与控制

- 风险 1：Decimal 与 number 混用导致日志与内部状态不一致。
- 控制 1：仅在“触发判定 + 改单提交 + trackedOrder 回写”三处统一 Decimal/标准化口径，不改动其他业务流程。
- 风险 2：3 位口径前提未显式声明，后续维护可能误用到不同精度场景。
- 控制 2：在方案中显式固化“3 位 + `0.001` 阈值”的当前业务前提，并在测试中固化边界契约。

---

本方案为“系统性修复”，仅覆盖你明确要求的监控改单与 JS 浮点问题，不引入超时转市价或其他策略级变更。
