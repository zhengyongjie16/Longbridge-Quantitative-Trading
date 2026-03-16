# 周期换标在持仓状态下误触发问题分析与最短路径修复方案

## 1. 问题背景

2026-03-16 11:48:07，系统已经对 `57393.HK` 提交买入并开始订单追踪：

- `[订单提交成功] 买入做空标的（做空） 57393.HK 数量=150000`
- `[订单监控] 开始追踪订单 1218043025104576512`

但在 2026-03-16 11:48:37，系统仍然触发了周期换标：

- `[自动换标] HSI.HK SHORT 清空席位: 周期换标触发`

这违反了当前业务不变量：

1. 周期换标只能在当前席位真正空仓时触发。
2. 只要当前席位标的仍存在未平仓买单记录，或仍存在任何本地在途订单链路，就必须继续等待，不能切换席位。
3. 空仓判断必须发生在 `clearSeat(...)` 之前，不能等到换标状态机后续阶段再补救。

## 2. 现象与影响

本次误触发不是单纯日志问题，而是会直接破坏席位与真实交易链路的一致性。

### 2.1 直接表现

1. `SHORT` 席位被提前清空，旧标的 `57393.HK` 仍处于本地订单链路中。
2. 席位从 `READY` 退化后，会触发后续席位同步与任务清理。
3. 后续系统可能按新席位标的继续运行，而旧标的的订单生命周期尚未真正结束。

### 2.2 连锁风险

1. 旧标的可能脱离当前席位归属，后续风险检查与卖出路径归属可能漂移。
2. 席位相关待执行任务可能被错误清理。
3. 新旧链路交叉后，可能出现“新席位已经开始工作，但旧标的订单链路还没完结”的状态错位。

## 3. 现状实现链路复核

### 3.1 当前周期换标入口把“空仓”简化成了“orderRecorder 为空”

相关文件：

- `src/services/autoSymbolManager/switchStateMachine.ts`

当前 `maybeSwitchOnInterval(...)` 的关键判定只有：

- `orderRecorder.getBuyOrdersForSymbol(symbol, isLong)`

现状逻辑等价于：

1. 若 `buyOrders.length > 0`，认为当前席位仍被占用。
2. 若 `buyOrders.length === 0`，认为已经空仓，可以启动周期换标。

问题在于，这个定义遗漏了“本地仍有未完成订单链路”的窗口。

### 3.2 买单提交成功后，本地其实已经知道该标的仍被占用

相关文件：

- `src/core/trader/orderExecutor/submitFlow.ts`
- `src/core/trader/orderMonitor/orderOps.ts`
- `src/core/trader/orderHoldRegistry.ts`

关键事实：

1. 订单提交成功后，`orderMonitor.trackOrder(...)` 会立即执行。
2. `trackOrder(...)` 内部会立即调用 `orderHoldRegistry.trackOrder(orderId, symbol)`。
3. 因此在“买单刚提交、尚未成交、尚未写入 orderRecorder”的窗口里，本地已经有可信的 pending order 状态。
4. 当前周期换标没有消费这一路状态，所以会把该窗口误判为空仓。

### 3.3 本地在途订单状态是闭环维护的，不是临时补丁状态

相关文件：

- `src/core/trader/orderMonitor/orderOps.ts`
- `src/core/trader/orderMonitor/settlementFlow.ts`
- `src/core/trader/orderMonitor/recoveryFlow.ts`
- `src/core/trader/orderHoldRegistry.ts`
- `src/core/trader/index.ts`

关键事实：

1. 下单成功后立即进入 `orderHoldRegistry`。
2. 订单终态结算后会调用 `orderHoldRegistry.markOrderClosed(orderId)`，把本地 pending 状态清掉。
3. 启动恢复时，会从 pending orders 快照重新 seed 到本地 hold 集合并恢复追踪。
4. `Trader.getOrderHoldSymbols()` 已经对外暴露了这个本地状态源。

因此，`orderHoldRegistry` 不是临时兜底数据，而是系统正式维护的“本地仍有未完成订单链路”状态源。

### 3.4 只看 pending buy 不够，必须看本地 pending buy/sell

相关文件：

- `src/core/riskController/unrealizedLossMonitor.ts`
- `src/core/doomsdayProtection/index.ts`
- `src/core/trader/orderHoldRegistry.ts`

关键事实：

1. 保护性清仓卖单提交成功后，会立即 `clearBuyOrders(...)`。
2. 末日清仓路径也会在卖单提交后清空本地买单记录。
3. 这意味着在卖单已提交、但尚未终态结算的窗口里：
   - `orderRecorder` 可能已经为空
   - 但旧席位仍然不能换标
4. 如果周期换标只补“pending buy”，仍然会漏掉“卖出退出中”的窗口。
5. `orderHoldRegistry.getHoldSymbols()` 以 symbol 粒度表达“该标的存在未完成订单”，刚好能覆盖 buy 和 sell 两类在途链路。

因此，对周期换标而言，正确语义不是“是否有本地 pending buy”，而是：

- **当前席位标的是否仍有任何本地 pending order 链路。**

### 3.5 状态机后续阶段虽有暴露检查，但时机已经太晚

相关文件：

- `src/services/autoSymbolManager/switchStateMachine.ts`

当前状态机后续阶段会调用 `hasOpenBuyExposure(...)`，但这发生在 `startSwitchFlow(...)` 之后，而 `startSwitchFlow(...)` 一开始就会 `clearSeat(...)`。

因此：

1. 后续检查最多只能阻止后续推进。
2. 无法阻止“误清席位”本身。
3. 真正需要修复的是周期换标入口的前置判定，而不是后续状态机补救。

## 4. 根因结论

本问题的根因不是“少了一个 if”，而是周期换标在决策点使用了错误的席位占用模型。

### 4.1 根因一：空仓语义被错误收缩为 `orderRecorder` 单一来源

当前实现把“席位是否还能换标”错误简化为：

- `orderRecorder.getBuyOrdersForSymbol(...)` 是否为空

但对周期换标而言，真正需要判断的是：

- 是否仍有未平仓买单记录
- 是否仍有本地未完成订单链路

### 4.2 根因二：忽略了本地 order hold 这一正式状态源

系统在下单成功后、终态结算前、启动恢复后，都会持续维护 `orderHoldRegistry`。

这个状态源正好表达：

- 当前 symbol 是否仍有未完成订单

但周期换标入口没有使用它。

### 4.3 根因三：关键阻断发生在 `clearSeat(...)` 之后

系统后续阶段虽然并非完全不做暴露校验，但关键校验晚于 `clearSeat(...)`，因此无法阻止误清席位。

## 5. 修复目标

本次修复必须恢复以下业务不变量：

1. 周期换标只能在当前席位标的本地确认“未平仓买单记录为空且本地在途订单为空”时触发。
2. 周期换标到期判定与 pending 结束判定必须共用同一套本地占用逻辑。
3. 只要 `orderRecorder` 或本地 order hold 任一来源表明当前席位仍被占用，就不能执行 `clearSeat(...)`。
4. 修复必须是纯本地最短路径，不引入持仓缓存判定、刷新门禁等待或远端确认。

## 6. 不采用的方案

### 6.1 不再引入 `cachedPositions` / `positionCache`

不采用。原因：

1. 当前问题的直接缺口是本地 pending order 未被纳入周期换标判定。
2. `cachedPositions` 依赖成交后刷新链路，不是这次问题的最短修复路径。
3. `positionCache` 只缓存 `availableQuantity > 0`，语义也不适合作为空仓依据。

### 6.2 不再引入 `refreshGate.waitForFresh()`

不采用。原因：

1. 本次要修复的是“本地占用判定缺失”，不是“缓存刷新时机不一致”。
2. 改为纯本地 `orderRecorder + orderHold` 后，周期换标决策已经不再依赖持仓缓存新鲜度。
3. 在本地 pending order 尚未清空前继续阻断，本身就是保守且正确的行为。

### 6.3 不再引入远端权威确认

不采用。原因：

1. 当前问题可以由本地正式状态源闭环表达。
2. 每次 tick 之前做远端确认属于明显过度设计。
3. 本次修复目标是最短路径修复真实缺口，而不是扩散成远端一致性重构。

### 6.4 不再把“本地 pending”限制为 buy-only

不采用。原因：

1. 保护性清仓和末日清仓路径会在卖单提交后提前清空 `orderRecorder`。
2. 若只拦 pending buy，仍会漏掉“卖出退出中”的窗口。
3. 周期换标真正要阻断的是“旧席位标的仍有未完成订单链路”，不是只阻断买单。

## 7. 最短路径修复方案

本次修复应收敛为：

- **仅使用 `orderRecorder` + 本地在途买卖单（`orderHoldRegistry`）判断是否允许周期换标。**

### 7.1 建立统一的本地席位占用判定函数

在 `switchStateMachine.ts` 中抽出统一判定函数，供周期换标专用。

建议语义：

```ts
type PeriodicSeatBlockSource = 'ORDER_RECORDER' | 'LOCAL_PENDING_ORDER' | 'EMPTY';
```

统一判定规则：

1. 若 `orderRecorder.getBuyOrdersForSymbol(seatSymbol, isLong)` 非空，返回 `ORDER_RECORDER`
2. 若 `trader.getOrderHoldSymbols().has(seatSymbol)` 为 true，返回 `LOCAL_PENDING_ORDER`
3. 两者都不命中时，返回 `EMPTY`

这里的 `LOCAL_PENDING_ORDER` 语义是：

- 当前席位标的仍存在本地未完成订单链路
- 不区分 buy / sell
- 因为对周期换标而言，只要旧 symbol 还有任何未完成订单，就不允许切席位

### 7.2 周期换标两个分支必须共用同一判定函数

当前 `maybeSwitchOnInterval(...)` 有两个关键分支：

1. 周期到期但尚未进入 pending
2. 已经进入 pending，等待空仓结束

修复要求：

1. 两个分支都只能调用同一个本地占用判定函数
2. 不允许一个分支只看 `orderRecorder`，另一个分支再看 `orderHold`
3. 到期判定与 pending 结束判定必须使用完全一致的“可换标”语义

### 7.3 继续保留“入口前阻断”，不依赖后续状态机补救

修复后的关键原则：

1. 只要统一判定结果不是 `EMPTY`，就不能调用 `startSwitchFlow(...)`
2. 也就不能触发 `clearSeat(...)`
3. 状态机后续阶段的暴露检查仍可保留，但不再承担修复本 bug 的职责

### 7.4 `Trader.getOrderHoldSymbols()` 就是最短路径接入点

本次方案不需要新增重型运行态暴露接口。

原因：

1. `Trader` 已经对外提供 `getOrderHoldSymbols()`
2. `orderHoldRegistry` 已经具备提交、终态清理、启动恢复三段闭环
3. 周期换标只需要判断“当前 seat symbol 是否仍有未完成订单”
4. 这里用 symbol 粒度已经足够，不需要额外暴露内部 `trackedOrders`

因此，这次最短路径不是新增复杂接口，而是直接消费现有 `getOrderHoldSymbols()`。

### 7.5 日志只需补足本地阻塞来源

当前日志语义过粗。

修复后至少应做到：

1. 首次进入 pending 时输出阻塞来源
   - `blockedBy=ORDER_RECORDER`
   - `blockedBy=LOCAL_PENDING_ORDER`
2. pending 结束时输出“本地已空，开始换标”
3. 不需要扩展到远端确认日志

若实现上不想扩展状态类型，也可以只在日志里按当前阻塞来源输出，无需新增复杂状态结构。

## 8. 测试修复方案

### 8.1 业务测试

文件：

- `tests/services/autoSymbolManager/periodicSwitch.business.test.ts`

新增或改造场景：

1. `buyOrders=0`，但 `getOrderHoldSymbols()` 包含当前席位标的，周期换标必须进入 pending
2. `buyOrders>0`，`getOrderHoldSymbols()` 为空，周期换标必须进入 pending
3. `buyOrders=0` 且 `holdSymbols` 为空，周期换标才允许启动
4. 当前 pending 来源从 `ORDER_RECORDER` 变为 `LOCAL_PENDING_ORDER` 时，仍保持 waiting，不允许切席位
5. 卖单退出链路场景：`orderRecorder` 已空，但 `holdSymbols` 仍包含旧标的，周期换标必须继续等待

同时需要修正现有场景命名：

- 当前 `case3` 实际只覆盖 `buyOrders`
- 应拆分为“订单记录阻塞”“本地 pending order 阻塞”“清空后启动换标”三个独立场景

### 8.2 集成测试

文件：

- `tests/integration/periodic-auto-symbol-chain.integration.test.ts`

新增场景：

1. 模拟买单已提交并进入 `orderHoldRegistry`，但 `orderRecorder` 尚无本地买单记录，周期换标不能触发
2. 模拟保护性清仓/退出卖单已提交并导致 `orderRecorder` 被清空，但本地 hold 仍在，周期换标不能触发
3. 本地 buy orders 与 hold 都清空后，周期换标才允许真正启动
4. 断言在阻塞阶段不会调用 `clearSeat(...)`

### 8.3 回归验收日志

修复后必须能稳定观察到：

1. 有本地未平仓买单记录时，只输出“进入等待空仓状态（ORDER_RECORDER）”
2. `orderRecorder` 已空但本地仍有 pending order 时，只输出“继续等待（LOCAL_PENDING_ORDER）”
3. 只有两者都为空时，才输出“等待结束，检测到本地空仓开始换标”
4. 在上述阻塞场景中，绝不能再出现 `清空席位: 周期换标触发`

## 9. 实施顺序

建议按以下顺序实施：

1. 在 `switchStateMachine.ts` 中抽出统一的本地占用判定函数
2. 让 `maybeSwitchOnInterval(...)` 的到期分支与 pending 分支都改为使用该函数
3. 使用 `trader.getOrderHoldSymbols()` 补上本地 pending order 判断
4. 更新周期换标相关日志，使其带上本地阻塞来源
5. 补齐业务测试与集成测试
6. 执行 `bun test`、`bun lint`、`bun type-check`

## 10. 验收标准

以下条件必须全部满足，修复才算完成：

1. 当前席位标的存在未平仓买单记录时，周期换标绝不触发 `clearSeat`
2. 当前席位标的存在本地 pending buy order 时，周期换标绝不触发 `clearSeat`
3. 当前席位标的存在本地 pending sell order 时，周期换标绝不触发 `clearSeat`
4. 只有当 `orderRecorder` 为空且 `getOrderHoldSymbols()` 不包含当前席位标的时，周期换标才允许启动
5. 周期换标到期判定与 pending 结束判定共用同一套本地占用逻辑
6. 新增测试全部通过
7. `bun lint` 与 `bun type-check` 全部通过

## 11. 结论

本次 bug 的本质不是“周期换标少加了一个 if”，而是：

- **周期换标在席位切换决策点，把“是否还能换标”错误简化成了 `orderRecorder` 单点判定。**

经过重新分析，最短且逻辑闭合的修复方案已经明确：

1. 保留 `orderRecorder` 作为“未平仓买单记录”来源
2. 补上 `orderHoldRegistry`（通过 `Trader.getOrderHoldSymbols()`）作为“本地在途买卖单”来源
3. 两者共用一套本地占用判定逻辑，在 `clearSeat(...)` 前完成阻断
4. 不引入 `cachedPositions`、`refreshGate.waitForFresh()` 或远端确认

这样可以在不扩大改动面的前提下，准确恢复业务要求的正确语义：

- 有未平仓买单记录，不换标
- 有本地在途买单，不换标
- 有本地在途卖单，不换标
- 只有本地订单链路真正结束后，才允许周期换标
