# 订单监控买单追高控制方案

> 日期：2026-03-14  
> 范围：仅改造 `orderMonitor` 的买单实时跟价决策与对应全局配置，不改动下单触发、买入风控、卖单跟价、超时撤单和成交结算主语义

## 1. 原始需求

当前系统中，订单监控会持续追踪未成交订单，并把委托价实时改到标的当前价，只要求满足最小价差和最小时间间隔。

目标功能：

1. 在全局配置中新增一个布尔配置项，放在订单价格更新间隔配置附近。
2. 当该配置为 `true` 时，保持当前逻辑不变。
3. 当该配置为 `false` 时，买入订单禁止被跟价改到高于“该订单开始追踪时的基准委托价”。
4. 卖出订单逻辑完全不变。
5. 若因此更难成交，不做额外补偿；继续沿用现有超时撤单语义。

业务示例：

1. 买单初始委托价 `0.50`。
2. 当前价降到 `0.49` 时，允许改到 `0.49`。
3. 当前价升到 `0.51` 时，不允许改到 `0.51`。
4. 若后续回到 `0.50`，允许改到 `0.50`，因为它没有高于初始基准价。

## 2. 第一性原理拆解

### 2.1 问题本质

这个需求不是“是否继续跟价”的问题，而是“买单跟价是否允许突破订单初始成本上限”的问题。

真正要控制的是：

1. 订单监控可以继续参与买单成交管理。
2. 但它不能在没有重新生成交易信号、没有重新经过买入风控的情况下，主动把买入价格抬高到初始预算之上。

### 2.2 正确的控制面

这个约束属于“订单监控的跟价决策规则”，不属于：

1. 下单执行规则。
2. 风控规则。
3. 改单 API 执行层规则。

因此控制面必须放在 `orderMonitor` 的“是否发起改单”决策点，而不能放到通用 `replaceOrderPrice()` 执行层。

### 2.3 最短路径判定标准

满足以下条件才算最短且正确：

1. 只在已有唯一跟价决策点增加买单上限判断。
2. 不扩散到卖单链路。
3. 不引入新的补单、补成交或降级逻辑。
4. 不引入跨模块持久化改造。
5. 明确保留现有超时撤单闭环。

## 3. 现状全链路复核

## 3.1 配置链路

现有订单价格更新间隔配置路径如下：

1. `GlobalConfig.orderMonitorPriceUpdateInterval` 定义于 [src/types/config.ts](/D:/code/Longbridge-Quantitative-Trading/src/types/config.ts)。
2. 环境变量 `ORDER_MONITOR_PRICE_UPDATE_INTERVAL` 在 [src/config/config.trading.ts](/D:/code/Longbridge-Quantitative-Trading/src/config/config.trading.ts) 中解析。
3. `buildOrderMonitorConfig()` 在 [src/core/trader/orderMonitor/utils.ts](/D:/code/Longbridge-Quantitative-Trading/src/core/trader/orderMonitor/utils.ts) 中把它转换成运行时配置。
4. `createOrderMonitor()` 在 [src/core/trader/orderMonitor/index.ts](/D:/code/Longbridge-Quantitative-Trading/src/core/trader/orderMonitor/index.ts) 中组装 `quoteFlow`。
5. 主程序在 [src/main/mainProgram/index.ts](/D:/code/Longbridge-Quantitative-Trading/src/main/mainProgram/index.ts) 中调度 `orderMonitorWorker`，最终调用 `processWithLatestQuotes()`。

结论：

1. 订单跟价配置只有一条清晰路径。
2. 新配置最自然的位置就是与 `orderMonitorPriceUpdateInterval` 同级放在 `GlobalConfig`。

## 3.2 下单后追踪链路

新单提交成功后：

1. `submitFlow` 在 [src/core/trader/orderExecutor/submitFlow.ts](/D:/code/Longbridge-Quantitative-Trading/src/core/trader/orderExecutor/submitFlow.ts) 中调用 `orderMonitor.trackOrder(...)`。
2. `trackOrder()` 在 [src/core/trader/orderMonitor/orderOps.ts](/D:/code/Longbridge-Quantitative-Trading/src/core/trader/orderMonitor/orderOps.ts) 中创建运行态追踪订单。
3. 当前追踪模型 `TrackedOrder` 定义于 [src/core/trader/types.ts](/D:/code/Longbridge-Quantitative-Trading/src/core/trader/types.ts)。

当前事实：

1. `trackOrder()` 会把提交时价格写入 `submittedPrice`。
2. `submittedPrice` 后续会在改单成功后被覆盖。
3. 系统当前没有独立字段保存“首次委托价”。

结论：

1. 若直接拿 `submittedPrice` 做禁止追高判断，语义是错误的。
2. 必须新增一个不可变基准价字段，单独保存买单的跟价上限基准。

## 3.3 实时跟价链路

实时跟价逻辑集中在 [src/core/trader/orderMonitor/quoteFlow.ts](/D:/code/Longbridge-Quantitative-Trading/src/core/trader/orderMonitor/quoteFlow.ts) 的 `processWithLatestQuotes()`。

当前行为顺序为：

1. 遍历所有 tracked orders。
2. 先处理买卖单超时逻辑。
3. 排除不可改单类型和状态。
4. 检查最小改单时间间隔。
5. 读取最新行情价。
6. 比较当前价和 `submittedPrice` 的价差是否达到阈值。
7. 若达到阈值，则调用 `replaceOrderPrice(orderId, normalizedCurrentPriceNumber)`。

关键结论：

1. 买单和卖单共用这一段跟价决策。
2. 买卖差异只存在于超时处理，不存在于跟价处理。
3. 因此“禁止买单追高”的唯一正确切入点就是 `processWithLatestQuotes()` 中调用 `replaceOrderPrice()` 之前。

## 3.4 改单执行层

`replaceOrderPrice()` 在 [src/core/trader/orderMonitor/orderOps.ts](/D:/code/Longbridge-Quantitative-Trading/src/core/trader/orderMonitor/orderOps.ts) 中只承担：

1. 订单存在性校验。
2. 改单能力状态判断。
3. 数量计算。
4. 调用 API 执行改单。
5. 成功后回写 `submittedPrice` / `submittedQuantity` / `lastPriceUpdateAt`。

它不是业务决策层。

结论：

1. 不能把“禁止买单追高”塞进 `replaceOrderPrice()`。
2. 否则会污染卖单改价、卖单合并改单等其他语义。

## 3.5 恢复链路

恢复逻辑在 [src/core/trader/orderMonitor/recoveryFlow.ts](/D:/code/Longbridge-Quantitative-Trading/src/core/trader/orderMonitor/recoveryFlow.ts)。

当前恢复依据是交易 API 返回的 pending order 快照：

1. 恢复时读取 `order.price` 作为 tracked price。
2. 恢复后继续进入实时订单监控。

当前明确限制：

1. 系统没有独立持久化“首次委托价”。
2. 重启恢复时拿到的只是订单当前委托价，而不是第一次提交时的委托价。

本次用户已明确接受：

1. 不要求跨重启保留第一次原始委托价。

因此本次方案的恢复语义定义为：

1. 对恢复出来的 pending buy order，以恢复时快照中的当前委托价作为新的 `initialSubmittedPrice` 基准。

这个定义在当前系统边界内自洽，且无需扩展到生命周期快照或额外持久化。

## 4. 需求可行性与合理性结论

## 4.1 可行性

该需求完全可行，原因如下：

1. 跟价业务决策点只有一个，修改面集中。
2. 买单超时本来就是撤单而不是转市价，不会因禁止追高而破坏后续闭环。
3. 卖单逻辑可完全隔离。
4. 用户已确认不要求跨重启保留首次委托价，避免了持久化扩改。

## 4.2 合理性

该需求在业务上是合理的，原因如下：

1. 买单主动抬价本质上提高了实际成交成本。
2. 这类提高成本的动作当前没有重新经过信号和风控验证。
3. 在你的业务目标中，“宁可超时撤单，也不允许监控器追高成交”是明确优先级。
4. 现有超时撤单已足够处理“不成交”的后果，不需要再设计额外成交补偿逻辑。

## 4.3 风险边界

本次变更接受以下业务结果：

1. 买单成交率可能下降。
2. 买单可能更频繁走到超时撤单。
3. 这是需求本意，不属于回归。

本次变更不应引入以下非预期行为：

1. 卖单跟价被限制。
2. 买单在回到初始价时也被错误阻止。
3. 买单一旦下调后，连恢复到初始价都不允许。
4. 恢复期 pending buy order 因缺少历史初始价而无法继续跟踪。

## 5. 配置命名分析与最终命名

## 5.1 命名要求

命名必须直接表达真实业务语义：

1. 这个开关只影响买单。
2. 它只影响订单监控跟价。
3. 它限制的是“是否允许高于初始委托价”。

## 5.2 不采用的命名

以下命名不建议采用：

1. `allowBuyOrderChasing` 问题：过于口语化，且“追价”边界不清，不知道是信号追价还是订单监控追价。
2. `disableBuyPriceIncrease` 问题：否定式命名，且语义太宽，像是禁止所有买单提价。
3. `allowBuyOrderPriceIncrease` 问题：没有体现“仅相对初始委托价”的约束。

## 5.3 最终命名

推荐配置字段：

1. `allowBuyOrderTrackingAboveInitialPrice`

推荐环境变量：

1. `ALLOW_BUY_ORDER_TRACKING_ABOVE_INITIAL_PRICE`

理由：

1. `BuyOrder` 明确只影响买单。
2. `Tracking` 明确只影响订单监控跟价，不影响首次下单。
3. `AboveInitialPrice` 明确约束基准是初始委托价，而不是当前委托价。

## 6. 最终方案（唯一方案）

## 6.1 设计决策

在 `orderMonitor` 内引入“买单初始委托价基准”这一等价业务模型，并在跟价决策点基于该基准做上限判断。

定义如下：

1. 新单追踪时记录 `initialSubmittedPrice`。
2. 后续改单只更新 `submittedPrice`，不更新 `initialSubmittedPrice`。
3. 当 `allowBuyOrderTrackingAboveInitialPrice === false` 时：
   - 卖单不受影响。
   - 买单仅在 `targetPrice <= initialSubmittedPrice` 时允许改单。
4. 当 `allowBuyOrderTrackingAboveInitialPrice === true` 时：
   - 跟价逻辑完全按现状执行。

## 6.2 关键语义

在配置关闭追高时，买单允许的行为必须是：

1. 当前价低于初始价：允许改低。
2. 当前价等于初始价：允许改回初始价。
3. 当前价高于初始价：禁止改高。

示例：

1. 初始价 `0.50`。
2. 跟到 `0.49` 后，`submittedPrice=0.49`，`initialSubmittedPrice=0.50`。
3. 当前价到 `0.50` 时允许改到 `0.50`。
4. 当前价到 `0.51` 时禁止改到 `0.51`。

这一定义严格匹配原始需求。

## 6.3 修改文件

必须覆盖以下文件：

1. [src/types/config.ts](/D:/code/Longbridge-Quantitative-Trading/src/types/config.ts)
2. [src/config/config.trading.ts](/D:/code/Longbridge-Quantitative-Trading/src/config/config.trading.ts)
3. [src/core/trader/types.ts](/D:/code/Longbridge-Quantitative-Trading/src/core/trader/types.ts)
4. [src/core/trader/orderMonitor/utils.ts](/D:/code/Longbridge-Quantitative-Trading/src/core/trader/orderMonitor/utils.ts)
5. [src/core/trader/orderMonitor/orderOps.ts](/D:/code/Longbridge-Quantitative-Trading/src/core/trader/orderMonitor/orderOps.ts)
6. [src/core/trader/orderMonitor/recoveryFlow.ts](/D:/code/Longbridge-Quantitative-Trading/src/core/trader/orderMonitor/recoveryFlow.ts)
7. [src/core/trader/orderMonitor/quoteFlow.ts](/D:/code/Longbridge-Quantitative-Trading/src/core/trader/orderMonitor/quoteFlow.ts)
8. [mock/factories/configFactory.ts](/D:/code/Longbridge-Quantitative-Trading/mock/factories/configFactory.ts)
9. 相关业务测试与回归测试

建议同时覆盖但不要求扩展业务逻辑的文件：

1. [src/config/config.validator.ts](/D:/code/Longbridge-Quantitative-Trading/src/config/config.validator.ts)

作用仅限于打印配置摘要，让运行日志能明确展示该开关状态。

## 7. 模块级改造说明

## 7.1 配置层改造

### 目标

把新配置纳入全局配置单一来源。

### 方案

1. 在 `GlobalConfig` 中新增：
   - `allowBuyOrderTrackingAboveInitialPrice: boolean`
2. 在 `createMultiMonitorTradingConfig()` 中解析：
   - `ALLOW_BUY_ORDER_TRACKING_ABOVE_INITIAL_PRICE`
3. 默认值设为 `true`。

### 说明

这里的默认值不是兼容性补丁，而是需求本身定义的一部分：

1. 用户要求 `true` 时保持当前行为。
2. 用户要求 `false` 时启用新约束。

## 7.2 orderMonitor 运行时配置改造

### 目标

让 `quoteFlow` 能直接消费该配置，而不直接依赖全局配置对象。

### 方案

1. 在 trader 内部 `OrderMonitorConfig` 新增：
   - `allowBuyOrderTrackingAboveInitialPrice: boolean`
2. 在 `buildOrderMonitorConfig()` 中完成透传。

## 7.3 tracked order 模型改造

### 目标

建立不可变的初始价格基准。

### 方案

1. 在 `TrackOrderParams` 新增：
   - `initialSubmittedPrice: number`（必填）
2. 在 `TrackedOrder` 新增：
   - `readonly initialSubmittedPrice: number`

实现约束：

1. `initialSubmittedPrice` 只在 `trackOrder()` 初始化时写入。
2. `replaceOrderPrice()` 永远不能修改它。
3. `submittedPrice` 继续保留当前语义，表示“当前订单委托价”。

### 命名理由

不使用 `originalPrice`、`basePrice` 这类模糊命名，避免和：

1. 行情原价。
2. 恢复价格。
3. 标的基础价格。

产生歧义。

## 7.4 新单追踪写入规则

### 目标

保证新提交订单从第一刻开始就拥有清晰基准价。

### 方案

1. `submitFlow` 调用 `trackOrder()` 时，显式传入：
   - `price = 当前下单价格`
   - `initialSubmittedPrice = 当前下单价格`
2. `trackOrder()` 内部将：
   - `submittedPrice = price`
   - `initialSubmittedPrice = initialSubmittedPrice`

说明：

1. 不再使用可选参数与 `??` 回退推导基准价。
2. 新单与恢复单都必须显式传入 `initialSubmittedPrice`，由调用方承担语义选择，避免静默兜底。

## 7.5 恢复链路写入规则

### 目标

在不扩展持久化的前提下，让恢复后订单继续满足新规则。

### 方案

`restorePendingOrderTracking()` 恢复 pending order 时：

1. 读取 `order.price` 作为恢复时当前委托价。
2. 调用 `trackOrder()` 时显式传入：
   - `price = order.price`
   - `initialSubmittedPrice = order.price`
3. `trackOrder()` 按显式入参写入：
   - `submittedPrice`
   - `initialSubmittedPrice`

### 语义结论

这表示：

1. 同一进程生命周期内，`initialSubmittedPrice` 是真正的首次追踪基准。
2. 跨重启后，新的基准重置为恢复时委托价。

该语义已被本次需求明确接受。

## 7.6 跟价决策改造

### 目标

在唯一决策点精确限制买单追高。

### 方案

在 `quoteFlow.processWithLatestQuotes()` 的跟价分支中增加判断：

1. 先完成现有的：
   - 超时处理
   - 不可改单状态过滤
   - 最小时间间隔过滤
   - 行情有效性过滤
   - 价差阈值过滤
2. 在准备调用 `replaceOrderPrice()` 之前追加：
   - 若当前订单是卖单，直接保留原逻辑。
   - 若当前订单是买单且 `allowBuyOrderTrackingAboveInitialPrice === true`，保留原逻辑。
   - 若当前订单是买单且 `allowBuyOrderTrackingAboveInitialPrice === false`，先统一价格口径：
     - `normalizedInitialSubmittedPriceNumber = Number(normalizePriceText(order.initialSubmittedPrice))`
     - 仅当 `normalizedCurrentPriceNumber <= normalizedInitialSubmittedPriceNumber` 时继续改单。
   - 否则跳过本轮改单。

### 为什么不能放在更低层

因为这一判断属于：

1. “是否应该跟价”的业务规则。

而不是：

1. “如何执行改单”的通用规则。

放到 `replaceOrderPrice()` 会误伤：

1. 卖单实时跟价。
2. 卖单合并时的手动改单。

## 7.7 日志语义改造

### 目标

提升运行时可观测性，避免后续误判为“没触发改单”。

### 方案

当买单因为“超过初始价上限”而跳过改单时，新增 debug 日志，明确打印：

1. `orderId`
2. 当前价
3. 当前委托价
4. 初始委托价
5. 配置状态

该日志只用于解释“为什么没有改价”，不改变业务流程。

## 8. 全链路正确性验证

## 8.1 正向链路验证

### 场景 A：配置为 true

1. 买单初始价 `0.50`。
2. 当前价到 `0.51`。
3. 价差和间隔满足。

期望：

1. 继续改到 `0.51`。
2. 行为与当前系统完全一致。

### 场景 B：配置为 false，当前价下降

1. 买单初始价 `0.50`。
2. 当前价到 `0.49`。

期望：

1. 允许改到 `0.49`。

### 场景 C：配置为 false，当前价上升高于初始价

1. 买单初始价 `0.50`。
2. 当前价到 `0.51`。

期望：

1. 不发起改单。
2. 订单继续保持 pending，等待后续行情或超时撤单。

### 场景 D：配置为 false，买单先下调后回升

1. 买单初始价 `0.50`。
2. 先改到 `0.49`。
3. 后续当前价回到 `0.50`。

期望：

1. 允许从 `0.49` 改回 `0.50`。
2. 因为 `0.50` 没有高于 `initialSubmittedPrice`。

## 8.2 卖单不变性验证

### 场景 E：卖单上涨或下跌

期望：

1. 卖单仍按当前逻辑追踪到最新价。
2. 卖单超时转市价逻辑完全不变。

## 8.3 恢复语义验证

### 场景 F：恢复 pending buy

1. 系统重启。
2. API 快照显示买单当前委托价为 `0.49`。

期望：

1. 恢复后 `initialSubmittedPrice=0.49`。
2. 若配置关闭追高，则后续不能改到高于 `0.49`。

这是本次接受的恢复边界，不是缺陷。

## 8.4 超时闭环验证

### 场景 G：配置为 false 导致买单长期不成交

期望：

1. 订单继续由现有超时逻辑处理。
2. 到达超时阈值后进入撤单链路。
3. 不新增任何补单或转市价行为。

## 9. 测试方案

## 9.1 配置测试

新增或修改配置解析测试，验证：

1. 未配置时默认为 `true`。
2. 配置为 `true` 时解析为 `true`。
3. 配置为 `false` 时解析为 `false`。

建议文件：

1. `tests/config/*` 下新增对应业务测试，或在已有全局配置相关测试中覆盖。

## 9.2 orderMonitor 业务测试

必须新增以下测试：

1. 买单在配置为 `true` 时，允许向上改单。
2. 买单在配置为 `false` 时，允许向下改单。
3. 买单在配置为 `false` 时，不允许改到高于初始价。
4. 买单在配置为 `false` 时，先改低再回到初始价，允许改单。
5. 卖单在配置为 `false` 时，仍可正常向上或向下改单。

建议主文件：

1. [tests/core/trader/orderMonitor.business.test.ts](/D:/code/Longbridge-Quantitative-Trading/tests/core/trader/orderMonitor.business.test.ts)
2. [tests/regression/order-monitor-regression.test.ts](/D:/code/Longbridge-Quantitative-Trading/tests/regression/order-monitor-regression.test.ts)

## 9.3 恢复测试

必须新增恢复场景测试：

1. 恢复 pending buy 后，`initialSubmittedPrice` 以快照价格为基准。
2. 配置关闭追高时，恢复后的买单不能追到高于恢复价。

建议文件：

1. [tests/core/trader/orderMonitor.business.test.ts](/D:/code/Longbridge-Quantitative-Trading/tests/core/trader/orderMonitor.business.test.ts)

## 9.4 回归测试

必须确保以下旧语义不回归：

1. 卖单跟价阈值边界不变。
2. 买卖单超时逻辑不变。
3. 卖单合并改单逻辑不变。
4. 改单错误码处理不变。

## 10. 验收标准

满足以下条件才算完成：

1. 新增全局配置可正确解析并进入 `orderMonitor` 运行时配置。
2. 买单在配置关闭追高时，绝不能改到高于 `initialSubmittedPrice`。
3. 追高判断必须使用统一归一化口径比较：
   - `normalizedCurrentPriceNumber = Number(normalizePriceText(currentPrice))`
   - `normalizedInitialSubmittedPriceNumber = Number(normalizePriceText(initialSubmittedPrice))`
   - 仅当 `normalizedCurrentPriceNumber <= normalizedInitialSubmittedPriceNumber` 才允许改单。
4. 买单仍可改低，且可在之后改回初始价。
5. 卖单所有现有逻辑保持不变。
6. 恢复期 pending buy 仍可正常跟踪，且基准价按恢复价生效。
7. 超时撤单闭环保持不变。
8. 全量相关测试通过。

## 11. 实施顺序

1. 扩展全局配置与内部 `OrderMonitorConfig`。
2. 扩展 `TrackOrderParams` 与 `TrackedOrder`，新增 `initialSubmittedPrice`。
3. 在 `trackOrder()` 和 `restorePendingOrderTracking()` 写入初始基准价。
4. 在 `quoteFlow.processWithLatestQuotes()` 加入买单上限判断。
5. 更新 mock 配置工厂与测试基线。
6. 补齐配置测试、业务测试、恢复测试与回归测试。
7. 运行 `bun lint` 与 `bun type-check`，再执行相关测试集合。

## 12. 最终结论

在你已确认“不要求跨重启保留第一次原始委托价”的前提下，本需求可以通过一次局部但完整的 `orderMonitor` 改造完成。

这条路径同时满足：

1. 业务语义正确。
2. 改动边界最小。
3. 不引入补丁式兼容结构。
4. 不破坏现有买单超时撤单和卖单跟价主链路。

因此，本方案应作为该需求的唯一实施方案。
