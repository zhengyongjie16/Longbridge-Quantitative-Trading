# orderMonitor 终态确认去对账化系统性重构方案

## 1. 文档目标

本文档用于在二次全链路分析基础上，给出一版新的、完整的、可执行的 `orderMonitor` 重构方案，目标是：

1. 彻底消除当前“关闭收口 + 定向对账”中的过度设计。
2. 将运行时订单终态确认收敛到最短正确路径。
3. 保留当前系统必须保留的业务语义与恢复严格性。
4. 明确替代旧方案中的错误前提，避免后续实现再次回到 `closeSyncQueue + 全量订单对账` 路线。

本文档不是兼容性补丁方案，也不是在现有 `closeSyncQueue` 上叠加一个 `orderDetail` 的局部修修补补方案，而是一次明确的语义级重构方案。

## 2. 历史文档关系与替代说明

本文档直接替代以下历史前提：

1. `docs/issues/2026-03/2026-03-03-order-monitor-systemic-remediation-plan.md` 中“运行时通过 `closeSyncQueue` 做定向对账”的核心方向。
2. `docs/plans/2026-03/2026-03-08-system-architecture-redesign-plan.md` 中关于“`closeSyncQueue` 是订单执行协议一部分”的相关前提。

本次结论明确认为：

1. `closeSyncQueue` 不应继续作为运行时终态确认的核心机制。
2. `NOT_FOUND` 不应继续作为业务终态的一部分。
3. 运行时终态确认不应再以 `historyOrders + todayOrders` 的全量拉单作为主路径。
4. 启动恢复和运行时异常确认是两个不同问题，必须拆开处理。

历史文档保留其历史记录属性，不回写旧文正文，但从本次任务开始，涉及 `orderMonitor` 终态确认与关闭收口的设计，应以本文档为准。

## 3. 适用范围

本方案直接覆盖以下模块：

1. `src/types/trader.ts`
2. `src/core/trader/types.ts`
3. `src/constants/index.ts`
4. `src/core/trader/orderMonitor/index.ts`
5. `src/core/trader/orderMonitor/types.ts`
6. `src/core/trader/orderMonitor/utils.ts`
7. `src/core/trader/orderMonitor/closeFlow.ts`
8. `src/core/trader/orderMonitor/settlementFlow.ts`
9. `src/core/trader/orderMonitor/orderOps.ts`
10. `src/core/trader/orderMonitor/quoteFlow.ts`
11. `src/core/trader/orderMonitor/eventFlow.ts`
12. `src/core/trader/orderMonitor/recoveryFlow.ts`
13. `src/core/trader/orderExecutor/submitFlow.ts`
14. `src/core/doomsdayProtection/index.ts`
15. `src/services/autoSymbolManager/switchStateMachine.ts`
16. 涉及 `trader.cancelOrder()` 结果判定的调用方与相关测试

本方案不改变以下业务定义：

1. 买单超时只撤单，不转市价。
2. 卖单超时仅在旧单确认不再继续活跃后，才允许转剩余数量的市价单。
3. WS 仍然是订单终态的主路径。
4. 启动/开盘重建仍然使用全量订单快照恢复 tracked orders。
5. `orderRecorder` 的买单记录、卖单占用、防重和低价优先扣减语义保持不变。
6. 本方案同时覆盖旧无限撤单修复文档中的“改单失败风暴”问题，但不再沿用其“错误即清追踪”的处理方式。
7. 以下改单风暴防护行为必须保留，不得在本次重构中退化：
   - `602012` 仍表示“订单类型永久不支持改单”，命中后该订单后续永久跳过改单。
   - `602013` 仍表示“当前状态暂不允许改单”，仅做临时退避，不得永久禁改。
   - 任意改单失败后都必须推进下一次改单评估时间，避免每秒重复改单。
8. `PartialFilled` 只做运行态更新，不触发 `orderDetail`，也不直接进入 `settlementFlow`。
9. `602013` 默认不触发 `orderDetail`；同一订单连续第 5 次命中 `602013` 时，必须立即升级为一次异常 `orderDetail` 查询。若查询结果仍为开放态，则停止时间轮询恢复，只等待后续 WS 状态变化。

## 4. 问题定义

当前模块最初希望解决的问题是：

1. 当 WS 正常时，依赖 WS 终态推送驱动订单关闭收口。
2. 当 WS 丢失或延迟时，避免本地继续把已经结束的订单当作“未结束订单”反复撤单或重复转单。

这个问题本质上是一个非常窄的“单订单终态确认”问题。

当前实现却把它扩张为以下复合问题：

1. 撤单 outcome 语义化。
2. 关闭收口统一化。
3. `closeSyncQueue` 队列调度。
4. 全量订单快照对账。
5. `NOT_FOUND` 终态化。
6. 恢复期间 close sync 与恢复对账耦合。

这导致模块的解决路径从“确认这一个订单是不是已经结束”偏成了“通过多路状态推理去判断订单最终可能是什么状态”。

## 5. 二次分析结论

### 5.1 当前实现的根本错误不是“少了一个兜底”，而是“兜底权威源选错了”

运行时终态确认当前并不直接查询该订单的当前状态，而是：

1. 先看 WS 是否到达。
2. 再看撤单 API 返回了什么错误码。
3. 再把结果塞进 `closeSyncQueue`。
4. 最后用全量订单快照去找该订单。

这是错误方向。

运行时订单异常确认的权威源应当是 `ctx.orderDetail(orderId)`。

### 5.2 当前所谓“定向对账”并不定向

当前 `closeFlow.processCloseSyncQueue()` 本质上执行的是：

1. `fetchAllOrdersFromAPI(true)`
2. `historyOrders + todayOrders`
3. 合并去重
4. 在全量订单数组里按 `orderId` 找快照

这不是“单订单定向状态确认”，而是“用全量快照找单个订单”。

这条路径有四个问题：

1. API 成本高。
2. 语义过重。
3. 失败面大。
4. 把单订单问题扩大成了全账户订单问题。

### 5.3 `NOT_FOUND` 被建模为终态，是语义错误

当前系统把 `NOT_FOUND` 放进 `OrderClosedReason`，等价于：

1. `FILLED`
2. `CANCELED`
3. `REJECTED`
4. `NOT_FOUND`

这是错误建模。

`NOT_FOUND` 不是业务终态，而是查询结果不确定或接口返回未命中。它最多只能表示：

1. 当前查询未能证明该订单仍可见。
2. 当前系统还不知道真实业务终态。

它绝不应该直接进入关闭收口。

### 5.4 重复撤单的根因是“未确认终态时仍保留超时动作资格”

当前重复撤单不是偶然 bug，而是结构性结果：

1. 订单超时。
2. 撤单返回 `ALREADY_CLOSED(FILLED/NOT_FOUND)` 或 `UNKNOWN_FAILURE`。
3. 调用方不立即做单订单状态确认。
4. 订单仍保留在 tracked 集合中。
5. 下一轮 tick 继续把它当成超时未终态订单。

所以日志风暴和重复撤单不是某个分支写错了，而是当前设计允许“终态未知订单继续拥有超时撤单资格”。

### 5.5 恢复严格性应该保留，但不应继续复用运行时 close sync 思路

恢复阶段需要保留以下能力：

1. 基于全量订单快照恢复 tracked orders。
2. 回放 `BOOTSTRAPPING` 期间订单事件。
3. 对 tracked orders、pending sell、replayed events 做严格一致性校验。

这些是恢复问题。

但恢复阶段如果遇到单订单状态不确定，正确路径也应当是单订单权威状态确认，而不是把运行时 `closeSyncQueue` 搬进恢复链路。

## 6. 新方案的一级原则

### 6.1 原则一：运行时终态确认只解决“这一个订单现在是什么状态”

不再通过全量订单对账推断终态。

### 6.2 原则二：WS 是主路径，`orderDetail` 只在撤单或改单 API 业务失败后作为异常确认权威源

只要 WS 正常到达，直接收口。

只要撤单或改单成功，就不查 `orderDetail(orderId)`。

只有在撤单或改单 API 返回业务失败，且失败语义表示“订单可能已关闭”或“当前状态未知”时，才允许调用 `orderDetail(orderId)`。

网络失败、超时、限流等“请求失败”不触发 `orderDetail`，只进入原动作的退避与重试。

补充例外：

1. 单次 `602013` 不触发 `orderDetail`，只进入改单临时退避。
2. 同一订单连续第 5 次命中 `602013` 时，视为“异常持续状态阻塞”，必须立即升级为一次 `orderDetail` 查询。
3. 若这次异常查询确认订单仍为开放态，则后续不再做时间轮询恢复，只等待 WS 状态变化。

### 6.3 原则三：未知不能伪装成已关闭

`NOT_FOUND` 或查询失败都不能直接走关闭收口。

未知就必须保持“未知”的显式状态，或进入显式的状态确认重试，而不是静默删除 tracking。

### 6.4 原则四：启动恢复与运行时确认分离

1. 启动恢复继续使用全量快照。
2. 运行时异常确认改为单订单状态查询。

两者不再共享同一套 close sync 机制。

### 6.5 原则五：旧收口层整体废弃，新建 `settlementFlow`

本次不是保留旧 `closeFlow` 再做职责收缩，而是：

1. 废弃当前 `closeFlow` 的整体现有语义。
2. 删除其与 `closeSyncQueue`、`NOT_FOUND`、快照推断耦合的所有历史前提。
3. 新建一个只承担终态结算副作用的 `settlementFlow`。

禁止性约束：

1. `settlementFlow` 不是对 `closeFlow.finalizeOrderClose` 的迁移、裁剪、重命名或局部改写。
2. 新收口逻辑的输入模型、状态映射、副作用编排和调用约束，必须按本文档重新定义，不得以旧收口实现作为保留基础。
3. 实现阶段允许参考旧代码理解业务语义，但不得以“沿用旧收口主干，只替换局部分支”的方式落地。

新的 `settlementFlow` 只负责：

1. 幂等。
2. 记账。
3. pending sell 结算。
4. refresh 标记。
5. tracked/hold 清理。

### 6.6 原则六：失败后的 `orderDetail` 确认只能有一个 owner

为避免 `quoteFlow`、`recoveryFlow`、`submitFlow`、`doomsdayProtection` 各自解释失败语义，本方案明确规定：

1. 撤单失败后的单订单状态确认，只能由 `orderMonitor.cancelOrder()` 内部完成。
2. 改单失败后的单订单状态确认，只能由 `orderMonitor.replaceOrderPrice()` 内部完成。
3. `orderStatusQuery` 是 `orderOps` 的内部辅助模块，不对其他流程开放为直接策略入口。
4. `quoteFlow`、`recoveryFlow`、`submitFlow`、`doomsdayProtection`、`switchStateMachine` 只能消费标准化后的结果，不得自行调用 `orderDetail`。

### 6.7 原则七：权威状态映射必须覆盖所有运行时可见终态

只要方案把 `orderDetail` 作为失败后的权威确认源，就必须完整定义其终态映射，至少包括：

1. `Filled`
2. `Canceled`
3. `Rejected`
4. `Expired`
5. `PartialWithdrawal`

其中：

1. `Expired` 归入非成交关闭，统一映射为 `CANCELED` 语义。
2. `PartialWithdrawal` 归入“带部分成交数量的非成交关闭”，统一映射为 `CANCELED` 语义，但必须保留 `executedQuantity / executedPrice / executedTime` 用于关闭收口。

## 7. 目标架构

## 7.1 目标链路总览

重构后，`orderMonitor` 只保留三条显式链路：

1. WS 终态链路。
2. 超时执行链路。
3. 启动恢复链路。

其中只有第二条链路会在撤单失败或改单失败后，通过 `orderOps` 内部触发单订单状态确认。

## 7.1.1 术语定义

为避免后续实现混淆，本方案中的两个术语必须严格区分：

1. `请求成功`：指撤单或改单 API 调用本身被接口正常接受并返回成功；它只表示这次请求没有报业务错误，也没有网络或超时失败。
2. `终态确认`：指系统已经拿到足够权威的证据，确认订单已进入最终结束状态；权威来源只能是终态 WS，或撤单/改单 API 业务失败后的 `orderDetail` 查询结果。

约束：

1. `请求成功` 不等于 `终态确认`。
2. 只有 `终态确认` 才允许进入 `settlementFlow`。
3. 卖单超时转市价、恢复放行、停止订单监控等动作，都必须基于 `终态确认`，不能只基于 `请求成功`。

## 7.2 运行时协议

### 7.2.1 正常路径

1. 订单提交成功后进入 tracked。
2. WS 推送更新订单状态。
3. 如果状态是 `Filled / Canceled / Rejected / Expired / PartialWithdrawal`，直接进入 `settlementFlow`。
4. 如果状态是 `PartialFilled`，只更新本地运行态，不进入 `settlementFlow`，也不触发 `orderDetail`。

### 7.2.2 不确定路径

触发条件：

1. 撤单 API 返回业务失败，且失败语义表示订单可能已关闭或当前状态未知。
2. 改单 API 返回业务失败，且失败语义表示订单可能已关闭或当前状态未知。

明确排除：

1. 网络失败、超时、限流、连接中断等“请求失败”不进入该路径。
2. `PartialFilled` 事件本身不进入该路径。
3. 单次或前 4 次 `602013` 不进入该路径，只进入改单临时退避。

补充异常升级规则：

1. 同一订单连续第 5 次命中 `602013` 时，允许立即进入一次 `orderStatusQuery`。
2. 若该次查询确认终态，则立即进入 `settlementFlow`。
3. 若该次查询仍为开放态或查询失败，则停止时间轮询恢复，只等待后续 WS。

处理方式统一为：

1. 由 `orderOps` 在失败后调用 `orderStatusQuery` 获取该订单当前权威状态。
2. 若是 `Filled`，立即按成交进入 `settlementFlow`。
3. 若是 `Canceled / Rejected / Expired / PartialWithdrawal`，立即按非成交终态进入 `settlementFlow`。
4. 若仍是 pending 状态，保留 tracked，仅允许后续退避后的下一次撤单或改单尝试。
5. 若 `orderDetail` 查询失败或未命中，不进入 `settlementFlow`，不执行额外动作，仅进入退避。

### 7.2.3 恢复路径

1. 使用调用方传入的 `allOrders` 恢复 tracked。
2. 回放 `BOOTSTRAPPING` 期间缓存事件。
3. 执行严格一致性校验。
4. 恢复阶段不主动做运行时状态确认；只有在恢复过程中对单订单执行撤单 API 业务失败时，才允许通过 `cancelOrder()` 的统一失败确认触发一次 `orderDetail`。

## 7.3 新的模块职责

### `eventFlow`

保留。

职责收缩为：

1. 处理 BOOTSTRAPPING/ACTIVE 分发。
2. 把 WS 终态事件交给 `settlementFlow`。
3. 处理 `PartialFilled` 的本地运行态更新。
4. 处理卖单部分成交的 pending sell 更新。

不再负责：

1. 未命中 tracked 时进入 close sync。
2. 终态迟到后的全量对账入队。
3. 因 `PartialFilled` 主动触发 `orderDetail`。

### `closeFlow`

废弃并删除，不再作为保留模块继续演化。

删除原因：

1. 它的现有语义边界已经被 `closeSyncQueue`、`NOT_FOUND`、快照推断和历史恢复耦合污染。
2. 在原模块上继续“收缩职责”仍然容易把旧前提残留到新实现里。
3. 本次重构要求的是新收口逻辑，不是旧收口逻辑的局部瘦身。

### `settlementFlow`

新建，作为唯一终态结算入口。

职责：

1. `FILLED / CANCELED / REJECTED` 幂等收口。
2. 更新 `orderRecorder`。
3. 释放 pending sell 占用。
4. 写入 `dailyLossTracker`。
5. 触发 `liquidationCooldownTracker`。
6. 标记 `refreshGate` 与 `pendingRefreshSymbols`。
7. 清理 tracked orders 与 hold registry。

明确不负责：

1. `closeSyncQueue`
2. `enqueueCloseSync`
3. `processCloseSyncQueue`
4. `CloseSyncTask`
5. `NOT_FOUND` 收口
6. 通过快照推断终态
7. 处理 `PartialFilled` 这类未终态状态推进

### `orderOps`

保留。

职责改为：

1. `trackOrder`
2. 发起 `cancelOrder`
3. 发起 `replaceOrder`
4. 在撤单或改单 API 业务失败后调用 `orderStatusQuery`
5. 把失败后的权威确认结果折叠回标准化 outcome

不再负责：

1. 把不确定结果转成 `closeSyncQueue` 任务。
2. 用 `NOT_FOUND` 驱动关闭语义。
3. 把未确认终态伪装成已关闭
4. 因 `PartialFilled` 主动触发 `orderDetail`

### `quoteFlow`

保留，但不再拥有 `orderDetail` 调用权。

职责改为：

1. 超时策略判断。
2. 消费 `orderOps` 返回的标准化撤单/改单结果。
3. 根据标准化结果决定：
   - 立即关闭
   - 暂停本轮动作并退避
   - 允许后续重试撤单或改单

### `recoveryFlow`

保留，但只做恢复与严格校验。

职责改为：

1. 恢复 tracked orders。
2. 回放 bootstrapping events。
3. 执行恢复一致性校验。
4. 恢复阶段如需撤单，只能复用 `orderMonitor.cancelOrder()` 的统一失败确认语义。

不再负责：

1. 创建 runtime close sync 任务。
2. 依赖 `NOT_FOUND` 终态化完成恢复闭环。

### 新增模块：`orderStatusQuery.ts`

新增一个非常窄的新模块，建议文件路径：

`src/core/trader/orderMonitor/orderStatusQuery.ts`

它只负责：

1. 在撤单或改单 API 业务失败后调用 `ctx.orderDetail(orderId)`。
2. 将返回结构转换为内部统一的“权威订单状态快照”。
3. 向调用方明确表达：
   - 已终态且是成交
   - 已终态且非成交
   - 仍在进行中
   - 查询失败

它不负责任何副作用，也不直接暴露给 `quoteFlow`、`recoveryFlow`、`submitFlow`、`doomsdayProtection`、`switchStateMachine`。
它也不用于 `PartialFilled` 的日常状态推进。

## 8. 类型与状态模型重构

## 8.1 `OrderClosedReason` 重构

旧模型：

```ts
type OrderClosedReason = 'FILLED' | 'CANCELED' | 'REJECTED' | 'NOT_FOUND';
```

新模型：

```ts
type OrderClosedReason = 'FILLED' | 'CANCELED' | 'REJECTED';
```

`NOT_FOUND` 从业务终态中移除。

补充约束：

1. `OrderStatus.Expired` 映射为 `TERMINAL(closedReason='CANCELED')`。
2. `OrderStatus.PartialWithdrawal` 映射为 `TERMINAL(closedReason='CANCELED')`，但必须保留成交数量信息参与 `settlementFlow`。

## 8.2 新增单订单状态确认结果模型

建议新增：

```ts
type OrderStateCheckResult =
  | {
      kind: 'TERMINAL';
      closedReason: OrderClosedReason;
      executedPrice: number | null;
      executedQuantity: number | null;
      executedTimeMs: number | null;
      status: OrderStatus;
    }
  | {
      kind: 'OPEN';
      status: OrderStatus;
      executedPrice: number | null;
      executedQuantity: number | null;
      updatedAtMs: number | null;
    }
  | {
      kind: 'QUERY_FAILED';
      reason: 'NOT_FOUND' | 'API_ERROR';
      errorCode: string | null;
      message: string;
    };
```

关键点：

1. `NOT_FOUND` 是查询失败类型，不再是关闭原因。
2. `OPEN` 与 `TERMINAL` 被显式分开。
3. `QUERY_FAILED` 不再伪装成终态。
4. `Expired / PartialWithdrawal` 不允许落入 `OPEN`。
5. 该结果类型只用于“撤单/改单 API 业务失败后的权威确认”，不用于 `PartialFilled` 的日常状态推进。

## 8.3 `CancelOrderOutcome` 重构

`CancelOrderOutcome` 保留“撤单执行结果”的语义，但其失败分支必须已经过 `orderMonitor.cancelOrder()` 内部的权威确认归一。

新的约束：

1. `ALREADY_CLOSED(FILLED)` 只能表示“撤单 API 告诉你订单已经结束”，不能替代最终 `settlementFlow`。
2. `CANCEL_CONFIRMED / ALREADY_CLOSED / RETRYABLE_FAILURE / UNKNOWN_FAILURE` 的边界，必须由 `orderOps` 在必要时结合 `orderDetail` 统一给出。
3. 只要调用方需要执行终态副作用，就必须走一次权威状态确认或 WS 终态。
4. 网络失败、超时、限流等“请求失败”不触发 `orderDetail`，直接返回重试类失败。

## 8.4 tracked lifecycle 简化

删除：

1. `CLOSE_SYNC_PENDING`

保留：

1. `OPEN`
2. `CLOSED`

如确实需要表达“暂时停止超时动作、只等待状态确认重试”，建议不再新增全局 close sync lifecycle，而是在 `TrackedOrder` 上增加非常窄的状态确认字段：

1. `nextStateCheckAt`
2. `stateCheckRetryCount`
3. `stateCheckBlockedUntilAt`
4. `replaceTempBlockedCount`
5. `replaceResumeMode`

这不是新的对账子系统，而只是对单订单权威查询的限流字段。

其中：

1. `replaceTempBlockedCount` 用于记录同一订单连续命中 `602013` 的次数。
2. `replaceResumeMode` 只允许两个值：
   - `TIME_BACKOFF`：按 1s / 2s / 4s / 8s 继续时间退避；若第 5 次仍命中 `602013`，立即升级为一次 `orderDetail` 查询
   - `WAIT_WS_ONLY`：停止时间轮询恢复，只等待 WS 状态变化

## 9. 模块级详细改造方案

## 9.1 `src/types/trader.ts`

修改内容：

1. 移除 `OrderClosedReason` 中的 `NOT_FOUND`。
2. 新增 `OrderStateCheckResult`。
3. 如果有必要，给 `CancelOrderOutcome` 增加更窄的注释语义，明确它不代表最终进入 `settlementFlow` 的结论。

修改原则：

1. 不保留“旧语义兼容别名”。
2. 不同时维持新旧两套关闭原因模型。

## 9.2 `src/core/trader/orderMonitor/types.ts`

修改内容：

1. 删除 `closeSyncQueue` 相关类型。
2. 删除 `CloseSyncTask`、`CloseSyncTriggerReason`。
3. 删除 `processCloseSyncQueue`、`enqueueCloseSync` 相关依赖注入声明。
4. 简化 `TrackedOrderLifecycleState`。
5. 为新 `orderStatusQuery` 增加依赖注入与结果类型。
6. 收拢 `cancelOrder` / `replaceOrderPrice` 的标准化返回契约，避免调用方各自解释失败语义。

## 9.3 `src/core/trader/orderMonitor/index.ts`

修改内容：

1. 删除 `closeSyncQueue` 运行态容器。
2. 删除 `closeFlow` 的全部装配。
3. 装配新的 `orderStatusQuery`。
4. 装配新的 `settlementFlow`。
5. 只让 `orderOps` 显式依赖 `orderStatusQuery`。

## 9.4 `src/core/trader/orderMonitor/closeFlow.ts`

修改内容：

1. 直接删除旧文件。
2. 不保留“精简后的 closeFlow”。
3. 不保留任何旧语义兼容入口。

原因：

1. 本次目标是新收口逻辑，不是旧收口模块裁剪。
2. 若继续保留 `closeFlow` 文件，后续实现极易回流旧语义。

## 9.5 `src/core/trader/orderMonitor/settlementFlow.ts`

新建文件。

设计原则：

1. 这是全新的终态结算模块，不是旧 `closeFlow` 的替身文件。
2. 不允许把旧 `finalizeOrderClose()` 直接搬运、删减后重命名，或保留其隐式状态判断前提。
3. 所有进入 `settlementFlow` 的数据，必须先由新协议完成“终态确认”，`settlementFlow` 本身不承担旧式终态推理职责。

输入要求：

1. 调用方传入的必须是已确认终态。
2. `FILLED` 必须附带必要成交信息；若信息缺失，则调用方不能直接进入 `settlementFlow`。
3. `CANCELED / REJECTED` 不允许再混入 `NOT_FOUND` 式未知终态。
4. `Expired / PartialWithdrawal` 必须在进入 `settlementFlow` 前已被映射成明确的非成交关闭语义。
5. `PartialFilled` 不允许进入 `settlementFlow`；它只允许留在运行态更新链路。

## 9.6 `src/core/trader/orderMonitor/orderOps.ts`

修改内容：

1. 保留 `trackOrder`。
2. 保留 `cancelOrderWithOutcome`，但其职责改为“仅在撤单 API 业务失败时完成失败后的权威确认并返回标准化结果”。
3. 删除 `enqueueCloseSync` 触发逻辑。
4. `replaceOrderPrice` 的关闭类业务错误也在内部完成失败后的权威确认，不再让调用方自行判断。

关键约束：

1. `orderOps` 不拥有 `settlementFlow` 副作用权。
2. `orderOps` 拥有失败后的单订单状态确认 owner 权。
3. `orderOps` 不再拥有对账调度权。
4. `orderOps` 不因网络失败、超时、限流或 `PartialFilled` 状态推进而调用 `orderStatusQuery`。
5. `orderOps` 对 `602013` 采用固定四段退避：1s / 2s / 4s / 8s。
6. 同一订单连续第 5 次命中 `602013` 时，`orderOps` 必须立即触发一次 `orderStatusQuery`。
7. 若该次异常查询确认订单已终态，则立即走 `settlementFlow`。
8. 若该次异常查询确认订单仍为开放态或查询失败，则将该订单的改单恢复模式切为 `WAIT_WS_ONLY`，后续不再做时间轮询恢复。

## 9.7 `src/core/trader/orderMonitor/orderStatusQuery.ts`

新建文件。

建议接口：

```ts
interface OrderStatusQuery {
  checkOrderState(orderId: string): Promise<OrderStateCheckResult>;
}
```

实现细节：

1. 调用 `ctx.orderDetail(orderId)`。
2. 将 `OrderDetail.status` 映射到：
   - `TERMINAL(FILLED/CANCELED/REJECTED)`
   - `OPEN`
3. 将接口抛错中的 `603001` 映射为 `QUERY_FAILED(reason='NOT_FOUND')`。
4. 其余异常映射为 `QUERY_FAILED(reason='API_ERROR')`。
5. `Expired` 与 `PartialWithdrawal` 必须落入 `TERMINAL(closedReason='CANCELED')`。
6. `PartialFilled` 必须落入 `OPEN`，不得被映射为终态。

## 9.8 `src/core/trader/orderMonitor/quoteFlow.ts`

这是本次重构的核心文件。

改造规则如下。

### 买单超时

1. 先按当前规则触发超时撤单。
2. 若撤单请求成功，不主动调用 `orderDetail`，继续等待后续 WS 终态；在终态到达前保留 tracking，并暂停本轮重复撤单。
3. 若撤单 API 业务失败，消费 `orderMonitor.cancelOrder()` 返回的标准化结果。
4. 若标准化结果确认 `FILLED`，立即进入 `settlementFlow`，禁止后续继续撤单。
5. 若标准化结果确认 `CANCELED / REJECTED / Expired / PartialWithdrawal`，立即进入 `settlementFlow`。
6. 若标准化结果仍是 pending 或查询失败，则仅做撤单退避，不删除 tracking。
7. 若撤单请求本身失败（网络、超时、限流等），不触发 `orderDetail`，只做撤单退避。

### 卖单超时

1. 先按当前规则触发超时撤单。
2. 若撤单请求成功，不主动调用 `orderDetail`，继续等待后续 WS 非成交终态；在旧单终态确认前禁止转市价。
3. 若撤单 API 业务失败，消费 `orderMonitor.cancelOrder()` 返回的标准化结果。
4. 只有在标准化结果确认旧单已 `CANCELED / REJECTED / Expired / PartialWithdrawal` 且剩余数量明确时，才允许转市价。
5. 若标准化结果确认 `FILLED`，必须直接进入 `settlementFlow`，禁止再次卖出。
6. 若标准化结果确认仍 pending、`PartialFilled`、`WaitToCancel`、`PendingCancel`，禁止转市价。
7. 若标准化结果为查询失败，不继续发起卖单转换，只进入状态确认退避。
8. 若撤单请求本身失败（网络、超时、限流等），不触发 `orderDetail`，不继续发起卖单转换，只进入原撤单动作退避。

### 额外约束

1. 删除 `processCloseSyncQueue()` 调度。
2. 删除 `NOT_FOUND` 对账日志语义。
3. `quoteFlow` 不直接调用 `orderDetail`。
4. 任何“不确定但未确认终态”的订单，在下一轮 tick 中不应继续无条件尝试撤单。
5. 对 `602013` 进入 `WAIT_WS_ONLY` 的订单，`quoteFlow` 后续不得再基于时间轮询主动触发改单，直到收到新的 WS 状态变化并恢复可评估资格。

## 9.9 `src/core/trader/orderMonitor/eventFlow.ts`

修改内容：

1. 保留对 tracked 订单的 WS 更新逻辑。
2. 收到 `Filled / Canceled / Rejected / Expired / PartialWithdrawal` 终态 WS 时直接进入 `settlementFlow`。
3. 收到 `PartialFilled` 时只更新本地运行态，不触发 `orderDetail`。
4. 对未命中 tracked 的迟到终态事件，不再进入 close sync 队列。

新的处理原则：

1. 如果订单已不在 tracked 集合中，迟到 WS 事件直接忽略或只记告警。
2. 不再为此构造额外的运行时对账子系统。

原因：

1. 运行时权威确认应在“不确定动作发生时”完成，而不是在“事件迟到后”补建一套对账协议。

## 9.10 `src/core/trader/orderMonitor/recoveryFlow.ts`

修改内容：

1. 保留快照恢复与一致性校验。
2. 删除 `enqueueCloseSync` 依赖。
3. 买单恢复期遇到不匹配并撤单请求成功时，不主动调用 `orderDetail`，必须等待 BOOTSTRAPPING 期间的后续 WS 终态；在终态确认前不得放行恢复。
4. 买单恢复期遇到不匹配并撤单 API 业务失败时，改为复用 `orderMonitor.cancelOrder()` 的统一失败确认结果。
5. 若确认已终态，则按确认结果处理。
6. 若仍 pending 或查询失败，则按严格恢复语义决定是否阻断恢复。

这里的规则必须更严格：

1. 查询失败不允许伪装成已关闭。
2. 恢复阶段若单订单状态无法确认，应继续阻断恢复，而不是“未知但先放行”。
3. 撤单请求成功但 WS 终态尚未确认时，也不得提前放行恢复。

## 9.11 `src/core/trader/orderExecutor/submitFlow.ts`

修改内容：

1. `CANCEL_AND_SUBMIT` 分支继续使用 `cancelOrder` outcome。
2. 但是否允许继续提交新卖单，不再只看 `isConfirmedNonFilledClose(outcome)`，而是在“撤单 API 业务失败”时使用 `orderMonitor.cancelOrder()` 已完成归一的结果。
3. `submitFlow` 不得直接调用 `orderStatusQuery`。

建议收口原则：

1. 普通卖单合并仍以 `orderMonitor.cancelOrder()` 为入口。
2. 若撤单失败且 outcome 不足以证明旧单已结束，则不继续提交新单，依赖 `orderMonitor.cancelOrder()` 的统一失败确认。
3. 不允许以 `NOT_FOUND` 作为“可继续提交”的证据。

## 9.12 `src/core/doomsdayProtection/index.ts` 及其他调用方

修改内容：

1. 复核所有 `trader.cancelOrder()` 调用方。
2. 删除任何将 `NOT_FOUND` 视为“可当作关闭”或“可继续后续动作”的逻辑。
3. 若调用方只需要“撤单是否完成”，则只接受明确非成交终态。
4. 调用方不得直接补查 `orderDetail`，统一依赖 `trader.cancelOrder()` 的标准化失败语义。
5. `switchStateMachine` 等依赖 `cancelOrder` 结果推进状态机的调用方，也必须切换到新语义。

## 10. 删除项清单

本次重构必须明确删除以下内容，不能保留为隐式旧路径：

1. `closeSyncQueue`
2. `CloseSyncTask`
3. `CloseSyncTriggerReason`
4. `enqueueCloseSync`
5. `processCloseSyncQueue`
6. `CLOSE_SYNC_PENDING`
7. `NOT_FOUND` 作为 `OrderClosedReason`
8. 运行时通过 `fetchAllOrdersFromAPI(true)` 确认单订单终态
9. 恢复阶段依赖 close sync 完成终态闭环

## 11. 实施阶段计划

## 阶段 1：模型收口

目标：

1. 切断 `NOT_FOUND` 终态语义。
2. 引入单订单权威状态确认模型。

实施内容：

1. 修改 `OrderClosedReason`。
2. 新增 `OrderStateCheckResult`。
3. 删除 types 中 close sync 相关声明。

验收标准：

1. 项目中不再存在 `NOT_FOUND` 被当作关闭原因的实现路径。
2. 编译通过。

## 阶段 2：引入 `orderStatusQuery`

目标：

1. 建立“撤单或改单失败后”的单订单权威确认能力。

实施内容：

1. 新建 `orderStatusQuery.ts`。
2. 接入 `ctx.orderDetail(orderId)`。
3. 补齐状态映射与错误映射。
4. 明确仅由撤单/改单 API 业务失败路径触发。

验收标准：

1. 存在单元测试覆盖：
   - `Filled`
   - `Canceled`
   - `Rejected`
   - `Expired`
   - `PartialWithdrawal`
   - `Pending`
   - `603001`
   - 一般 API 错误

## 阶段 3：重写 `quoteFlow`

目标：

1. 让超时逻辑在撤单失败后以权威状态确认驱动，不再以 close sync 驱动。

实施内容：

1. 删除 `processCloseSyncQueue` 调度。
2. 买单超时分支仅在撤单 API 业务失败时消费 `cancelOrder()` 的统一结果。
3. 卖单超时转市价分支仅在撤单 API 业务失败时消费 `cancelOrder()` 的统一结果。
4. 为 tracked order 增加窄化的状态确认退避字段。

验收标准：

1. 不再出现同一订单每秒重复撤单。
2. `sell-timeout + already-filled` 场景不会再次转市价。
3. `buy-timeout + ws missing + order filled` 场景不会继续撤单。

## 阶段 4：切换到 `settlementFlow`

目标：

1. 完成从旧收口层到 `settlementFlow` 的切换。

实施内容：

1. 删除 `closeFlow` 文件与全部装配。
2. 新建 `settlementFlow` 并接入 `eventFlow`、`quoteFlow`、`recoveryFlow`。
3. `orderOps` 删除 close sync 触发逻辑。
4. `eventFlow` 删除未命中 tracked 的 close sync 入队逻辑。

验收标准：

1. 项目中已不存在 runtime close sync 入口。
2. 项目中已不存在旧 `closeFlow` 运行路径。
3. `settlementFlow` 只接受已确认终态。

## 阶段 5：重写 `recoveryFlow`

目标：

1. 恢复严格性保留，但彻底与 runtime close sync 解耦。

实施内容：

1. 删除 `enqueueCloseSync` 依赖。
2. 恢复时仅通过 `cancelOrder()` 的统一失败确认获取权威结果。
3. 更新恢复一致性校验与错误路径。

验收标准：

1. 恢复仍保持严格模式。
2. 不存在“恢复阶段创建 close sync，切 ACTIVE 后继续消费”的旧设计。

## 阶段 6：调用方与测试收口

目标：

1. 让所有依赖 `cancelOrder` 的调用方遵守新语义。

实施内容：

1. 复核 `submitFlow`、`doomsdayProtection`、其他调用方。
2. 更新测试矩阵。
3. 删除与 close sync 相关的旧测试。

验收标准：

1. `bun lint`
2. `bun type-check`
3. `bun test`

## 12. 测试计划

必须新增或重写以下测试。

### 12.1 运行时终态确认

1. 买单超时，撤单报 `601012`，`orderDetail=Filled`，应立即进入 `settlementFlow`，不再重试撤单。
2. 买单超时，撤单报 `603001`，`orderDetail=Filled`，应立即进入 `settlementFlow`。
3. 买单超时，撤单失败，`orderDetail=Pending`，应仅退避，不删除 tracking。
4. 买单超时，撤单失败，`orderDetail` 查询失败，应仅做状态确认退避，不再每秒撤单。
5. 买单超时，撤单失败，`orderDetail=Expired`，应按非成交终态收口。
6. 买单超时，撤单失败，`orderDetail=PartialWithdrawal`，应按带成交数量的非成交终态收口。
7. 撤单请求因网络、超时、限流失败时，不得主动调用 `orderDetail`。
8. 未发生撤单/改单 API 业务失败时，不得主动调用 `orderDetail`。
9. `PartialFilled` 事件到达时，不得主动调用 `orderDetail`。
10. 买单超时，撤单请求成功后，在 WS 终态到达前不得额外主动调用 `orderDetail`，也不得继续无条件重复撤单。

### 12.2 卖单超时转市价

1. 卖单超时，撤单报 `601012`，`orderDetail=Filled`，不得再次提交市价单。
2. 卖单超时，撤单失败，`orderDetail=Canceled`，可在剩余数量明确时转市价。
3. 卖单超时，`orderDetail=PartialFilled + PendingCancel`，不得转市价。
4. 卖单超时，`orderDetail` 查询失败，不得转市价。
5. 卖单超时但撤单请求因网络、超时、限流失败时，不得额外主动调用 `orderDetail`。
6. 卖单超时但仅收到 `WS PartialFilled` 时，不得因该事件主动调用 `orderDetail`。
7. 卖单超时，撤单请求成功后，在旧单 WS 非成交终态确认前不得转市价，也不得额外主动调用 `orderDetail`。

### 12.3 WS 主路径

1. WS 终态 `Filled` 到达时，正确进入 `settlementFlow`。
2. 重复终态事件不重复记账。
3. 迟到终态事件不再创建额外 close sync 任务。
4. `WS PartialFilled` 只更新运行态，不进入 `settlementFlow`，也不触发 `orderDetail`。
5. `WS Expired / PartialWithdrawal` 到达时，直接进入 `settlementFlow`。

### 12.4 恢复路径

1. 恢复阶段不匹配买单撤单失败后，若统一结果确认 `Filled`，按成交处理。
2. 恢复阶段不匹配买单撤单失败后，若统一结果为查询失败，继续阻断恢复。
3. 恢复阶段不得自行调用 `orderDetail`。
4. 恢复后 tracked/pendingSell/replayed events 一致性校验仍然成立。
5. 恢复阶段不匹配买单撤单请求成功后，若 WS 终态未到达，必须继续阻断恢复。

### 12.5 改单风暴防护

1. 改单返回 `602012` 后，该订单后续不再进入改单尝试。
2. 改单连续返回 `602013` 时，该订单按 1s / 2s / 4s / 8s 进入四段短时退避。
3. 第 5 次连续命中 `602013` 时，必须立即触发一次 `orderDetail` 异常查询。
4. 若该次异常查询返回 `Filled / Canceled / Rejected / Expired / PartialWithdrawal`，应立即按对应终态收口。
5. 若该次异常查询返回开放态，则该订单后续停止时间轮询恢复，只等待 WS 状态变化。
6. 若该次异常查询失败，也不得继续时间轮询狂刷改单；应进入 `WAIT_WS_ONLY` 或等价模式。
7. 普通改单失败后，`lastPriceUpdateAt` 或等价退避时间必须被推进，避免下一秒再次尝试。
8. 改单失败且 `orderDetail=Expired` 时，应按非成交终态收口。
9. 本次去除 `closeSyncQueue` 后，不得回归出 `602012/602013` 高频日志风暴。

### 12.6 调用方一致性

1. `quoteFlow`、`submitFlow`、`recoveryFlow`、`doomsdayProtection`、`switchStateMachine` 不得直接调用 `orderDetail`。
2. `trader.cancelOrder()` 在不同调用方下，对同一失败输入必须返回一致的标准化结果。
3. `submitFlow` 的 `CANCEL_AND_SUBMIT` 与 `doomsdayProtection` 的撤单处理，不得再各自解释 `603001/NOT_FOUND`。

## 13. 风险与控制

### 风险一：把 `NOT_FOUND` 移出终态后，部分历史分支会失去“兜底关闭”路径

控制：

1. 这是刻意设计，不是副作用。
2. 未知就必须保持未知并显式告警，不能继续伪装为已关闭。

### 风险二：失败后的状态确认 owner 不唯一，会让调用方语义分叉

控制：

1. 只允许 `orderMonitor.cancelOrder()` 与 `orderMonitor.replaceOrderPrice()` 内部触发 `orderStatusQuery`。
2. `quoteFlow`、`recoveryFlow`、`submitFlow`、`doomsdayProtection` 只消费标准化结果。
3. 不再引入新的对账子系统。

### 风险三：遗漏 `Expired / PartialWithdrawal` 会留下新的悬空终态

控制：

1. 在 `orderStatusQuery` 中显式映射这两个状态。
2. `Expired` 统一按 `CANCELED` 处理。
3. `PartialWithdrawal` 统一按“带部分成交数量的 `CANCELED`”处理。

### 风险四：恢复阶段更严格，可能暴露更多历史数据问题

控制：

1. 这是正确暴露，不是负面回归。
2. 恢复严格性本就要求不确定则阻断。

## 14. 最终验收标准

当满足以下条件时，认为本次重构完成：

1. 运行时代码中不再存在 `closeSyncQueue`。
2. `NOT_FOUND` 不再属于 `OrderClosedReason`。
3. 运行时终态确认仅在撤单失败或改单失败后改为单订单 `orderDetail` 查询。
4. `orderDetail` 只允许由 `orderMonitor.cancelOrder()` 与 `orderMonitor.replaceOrderPrice()` 内部触发。
5. `Expired / PartialWithdrawal` 已被定义为可收口终态，不会落入未知状态。
6. 启动恢复仍保留全量快照恢复与严格一致性校验。
7. 买单超时不再因 WS 缺失而持续重复撤单。
8. 卖单超时在旧单已成交场景下不再重复卖出。
9. `settlementFlow` 只承担终态副作用，不再承担终态推理。
10. `bun lint`、`bun type-check`、`bun test` 全部通过。

## 15. 本次方案的最终判断

当前 `orderMonitor` 真正需要的不是“更强的对账能力”，而是“更窄、更直接、更权威的终态确认能力”。

因此本次重构的核心不是增强 `closeSyncQueue`，而是删除它。

最终结构应当是：

1. WS 负责正常终态流。
2. `orderDetail` 只负责撤单失败或改单失败后的单订单终态确认，且只能由 `orderOps` 内部触发。
3. `settlementFlow` 负责已确认终态的副作用收口。
4. 恢复流程继续负责全量快照恢复与严格一致性校验。

这才是解决当前问题的最短路径，也是符合系统性重构要求的正确路径。
