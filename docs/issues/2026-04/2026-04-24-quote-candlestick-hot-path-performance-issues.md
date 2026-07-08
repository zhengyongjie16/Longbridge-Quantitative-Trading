# 行情与 K 线推送高频路径性能问题审查

## 背景

本文件记录对当前项目中行情 quote 推送与 K 线 candlestick 推送高频业务链路的只读审查结论。

审查重点：

- Longbridge SDK quote / candlestick push 回调入口。
- quote fan-out 后的交易风险、显示、换标、订单监控链路。
- K 线 push 后的缓存、指标增量 runtime、信号生成与显示链路。
- 高频场景下的 CPU、对象分配、GC、异步堆积与旧任务消费风险。

总体判断：当前架构主方向正确，核心链路大量使用事件驱动、per-route single-flight、latest-only collapse、dirty 标记和 seatVersion 校验。但部分 quote 高频路径仍存在全局派生状态重建、routeStates 全量扫描和大对象复制问题，需要按优先级收敛。

## 总体结论

当前最值得优先处理的问题不是 Longbridge SDK 回调入口本身，而是下游高频消费者中的重复计算与同步 fan-out 放大：

1. `TradingRiskEventRuntime` 在 quote 高频路径中重复重建 `TradingRiskRoutingIndex`。
2. `TradingQuoteDisplayRuntime` 在显示路径中重复重建 routing index。
3. `monitorQuoteEventRuntime` 与 `switchWakeupRuntime` 的部分 wakeup 路径按 `routeStates` 全量扫描。
4. K 线缓存与指标 runtime 存在数组复制和 committed state clone 的叠加成本。
5. 普通信号门禁关闭时仍可能执行完整策略信号生成。
6. 买入队列为无去重 FIFO，旧任务可能在高频信号 burst 下占用处理时间。

## P0：TradingRiskEventRuntime 每条 quote 重建 routing index

### 位置

- `src/main/tradingRiskEventRuntime/tradingRiskEventRuntime.ts`
- `src/main/tradingRiskEventRuntime/routingIndex.ts`
- `src/main/tradingRiskEventRuntime/routeValidation.ts`

### 问题

`TradingRiskEventRuntime` 当前在 quote 事件进入时会重建完整 routing index；在 route 异步执行中，freshness wait 前后也会再次重建 routing index 做 current-route 校验。

该路径本质成本为：

```text
quote event × monitorContexts × directions
```

每次构建还会新建 `routesBySymbol`、`routesByKey` 两个 `Map` 以及 route 对象。

### 性能风险

高频 quote 下会形成稳定 CPU 和 GC 压力：

- 每条 quote 都遍历所有 monitor context。
- 同一 route pass 可能重建 2 到 3 次 routing index。
- 监控标的数量增加时，成本线性放大。
- 这是交易风险路径，优先级高于显示路径优化。

### 正确性边界

不能通过删除 current-route 校验来优化。以下语义必须保留：

- routeKey 校验。
- seatVersion 校验。
- freshness wait 前后都要复核 route 是否仍然 current。
- duplicate trading symbol 仍然 fail-fast。
- seat version-only bump 也必须触发 routing index 刷新。

### 建议方向

将 routing index 从“quote 事件触发重建”改为“seat truth changed 事件驱动缓存”：

```text
runtime start
-> 构建初始 routing index

seat truth changed / seat version changed
-> 重建 cached routing index

quote event
-> 只读 cached routing index
-> O(1) resolve route
-> current-route 校验继续读取 cached routing index
```

### 禁止方案

- quote miss 时 fallback rebuild。
- 定时重建 routing index。
- 删除 `isTradingRiskRouteCurrent` 校验。
- 缓存失效后静默继续使用旧 index。
- 为兼容旧行为保留 quote-path rebuild 分支。

## P1：TradingQuoteDisplayRuntime 显示路径重复重建 routing index

### 位置

- `src/main/tradingQuoteDisplayRuntime/index.ts`

### 问题

显示链路中，交易标的 quote 到达后会：

1. 在 `handleQuoteUpdated` 中重建 routing index。
2. 命中 route 后进入 per-route latest-only collapse。
3. 异步返回后再次重建 routing index 做 current-route 校验。

### 性能风险

这是显示辅助链路，但在高频 quote 下仍会产生重复的线性计算与对象分配：

- 每个交易标的 tick 至少一次 routing index rebuild。
- 异步阶段又一次 routing index rebuild。
- routing index 构建会遍历 monitor contexts，并重建 `routesBySymbol` / `routesByKey`。

### 建议方向

显示路径可以复用 `TradingRiskRoutingIndex` 的缓存维护语义：

```text
seat truth changed
-> 更新显示 routing index

quote event
-> cached routing index O(1) resolve
-> route latest-only collapse
-> current-route 校验继续读取 cached routing index
-> render
```

显示 owner 不能影响交易路径；该优化只应移除重复 routing index 构建。

## P1：普通信号门禁关闭时仍执行 generateSignals

### 位置

- `src/main/businessEventProgram/signalPipeline.ts`
- `src/main/ordinarySignalGuard/index.ts`
- `src/core/strategy/index.ts`

### 问题

当前普通信号链路先计算 `canEnqueue`，但即使 `canEnqueue === false`，仍可能继续执行 `strategy.generateSignals`，随后只是不入队。

门禁关闭场景包括：

- 生命周期交易开关关闭。
- `canTrade !== true`。
- 开盘保护窗口。
- 末日保护清仓接管窗口。

### 性能风险

在门禁关闭期间，策略信号生成会产生无效成本：

- 最多评估 BUYCALL / SELLCALL / BUYPUT / SELLPUT 四个方向。
- 构造 signal、reason、指标展示字符串和日志字符串。
- 高频 K 线下会形成稳定无效对象分配。

### 正确性边界

不能跳过这些步骤：

- K 线缓存更新。
- 指标 runtime 更新。
- `indicatorCache.push`。
- 必要的 seat state sync。
- monitor display snapshot 更新。

只能跳过普通信号生成与入队。

### 建议方向

当 `ordinarySignalGuard` 返回 false 时，直接跳过 `strategy.generateSignals`：

```text
K line event
-> indicator update
-> indicator cache update
-> display request
-> ordinarySignalGuard=false
-> skip generateSignals
```

## P1/P2：wakeup 路径按 routeStates 全量扫描

### 位置

- `src/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts`
- `src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts`

### 问题

部分 quote / order / freshness wakeup 路径会遍历全部 `routeStates`，再检查每个 route 是否包含当前 wakeup source。

典型形式：

```text
for routeState of routeStates
-> routeState.wakeupSymbols.has(event.symbol)
```

或：

```text
for routeState of routeStates
-> routeState.wakeups.some(...)
```

### 性能风险

route 数少时可接受，但以下场景会放大：

- 多 monitor 同时处于静态清仓 WAIT。
- pending switch route 增多。
- quote symbol 高频抖动但大多数 route 不匹配。
- order/freshness 事件频繁触发。

### 建议方向

维护反向索引，按事件 source 直接命中 route：

```text
quoteSymbol -> Set<routeKey>
orderSymbol -> Set<routeKey>
freshness -> Set<routeKey>
```

更新 route wakeups 时同步维护索引。事件到达后只遍历命中的 routeKeys。

### 优先级判断

该项低于 `TradingRiskEventRuntime` 和显示链路优化。只有当 WAIT / pending switch route 数量实际增长时，它才会成为明显热点。

## P2：K 线缓存与指标 runtime 复制成本叠加

### 位置

- `src/services/quoteClient/candlestickCache.ts`
- `src/services/indicators/runtime/index.ts`

### 问题

K 线缓存每次 seed / push / buildSnapshot 都会复制 candles 数组。指标 runtime 在 shifted / confirm / preview 分支又会 clone committed state。

因此 K 线推进链路存在叠加成本：

```text
candlestick push
-> copy candles array
-> build snapshot
-> indicator runtime update
-> clone committed state
-> build indicator snapshot
```

### 当前风险判断

当前配置下风险可控：

- `TRADING.CANDLE_PERIOD = Period.Min_1`
- `TRADING.CANDLE_COUNT = 200`

1 分钟 K 线、200 根窗口下，数组复制通常不是首要瓶颈。

### 未来风险

以下变化会提高风险：

- 增加更多监控标的。
- 同时订阅多个 K 线周期。
- 使用更高频 K 线周期。
- 指标 profile 变复杂。
- active bar push 频率增加。

### 建议方向

第二阶段再考虑低分配数据结构：

```text
内部 ring buffer / structure sharing
-> version 驱动更新
-> 对外仍暴露 readonly snapshot
```

指标 runtime 可考虑减少深拷贝范围：

- 只 clone 受影响的指标分支。
- preview 改为读时合成。
- 避免 confirm / shift 中重复 clone 全部 committed state。

### 禁止方案

- 不应直接把内部可变 candles 数组暴露给业务层。
- 不应为了性能破坏 readonly snapshot 边界。
- 不应优先重构该项而延后 quote routing index 优化。

## P2：买入队列无去重 FIFO 可能积压旧任务

### 位置

- `src/main/asyncProgram/tradeTaskQueue/index.ts`
- `src/main/asyncProgram/buyProcessor/index.ts`
- `src/main/asyncProgram/utils.ts`

### 问题

买入任务队列是无去重 FIFO，单消费者串行处理。买入执行过程中会进行行情、账户、持仓等网络调用。

### 性能风险

高频即时买入信号 burst 下可能出现：

- 旧任务积压。
- 旧 seatVersion 任务虽然最终会被执行前校验拦截，但仍占用处理时间。
- 新任务被旧任务排队延迟。
- 外部 API 时延抖动时积压被放大。

### 正确性边界

买入信号不能被粗暴全局去重。必须保持这些语义：

- seatVersion 一致性校验。
- monitorSymbol / direction 隔离。
- 买入风控冷却语义。
- 订单频率限制语义。
- 成交与待成交防重语义。

### 建议方向

如实盘观察到买入任务积压，可考虑按以下 key 做 latest-only 或显式合并：

```text
monitorSymbol + direction + seatVersion
```

该项需要单独业务验证，不应作为无脑队列替换。

## P2/P3：延迟验证 timer 与样本队列维护成本

### 位置

- `src/main/asyncProgram/delayedSignalVerifier/index.ts`
- `src/main/asyncProgram/indicatorCache/index.ts`
- `src/main/asyncProgram/indicatorCache/utils.ts`

### 问题

延迟验证当前可能为每个 delayed signal 创建一个 `setTimeout`。indicator cache 样本队列使用数组 push / splice / 线性 closest 查找。

### 性能风险

在 delayed signal 高频 burst 下：

- timer 数量增加。
- triggerTime 高离散时不易自然合并。
- 样本窗口大或样本密时，数组维护和 closest 查找为 O(n)。

### 建议方向

如果实盘出现 delayed verification 积压，可评估：

- 按 monitorSymbol 批处理验证。
- 使用时间轮或统一调度器。
- 样本队列改为更适合时间窗口查询的数据结构。

当前该项不是首要问题。

## P3：quoteSubscriptionRuntime retain diff 仍是全量扫描

### 位置

- `src/main/quoteSubscriptionRuntime/index.ts`

### 问题

seat/order retain 变更时会重扫 retains 与 seats，重新计算 desired / added / removed。

### 风险判断

该路径不是 tick 级热点，不应优先优化。但在席位频繁切换、retain owner 增多时，仍有 O(owners + committed) 成本。

### 建议方向

保持现有串行 mutation 语义，未来可按 symbol 维护 retain 引用计数，减少全量 diff。

## P3：类型不变量表达与测试缺口

### 类型问题位置

- `src/services/indicators/runtime/index.ts`
- `src/main/asyncProgram/monitorTaskQueue/index.ts`

### 问题

存在少量类型断言削弱不变量表达：

- `IndicatorIncrementalRuntime` 与内部 state 之间通过 brand + `as unknown as` 双向强转。
- `monitorTaskQueue.scheduleLatest` 构造任务时使用类型断言。

### 建议方向

这些不是性能首要问题，但可在后续规范清理中处理：

- 用不可伪造句柄或显式封装类型表达 indicator runtime 身份。
- 调整泛型构造方式，去掉 `as MonitorTask<...>`。

### 高频测试缺口

建议补充以下测试保护高频边界：

1. quote event 不触发 `TradingRiskRoutingIndex` rebuild。
2. runtime start 时构建初始 cached routing index。
3. seat state changed 后刷新 cached routing index。
4. seat version-only bump 后刷新 cached routing index。
5. freshness wait 前后仍使用最新 cached index 做 current-route 校验。
6. stale route 在 seatVersion 变化后不会继续生成清仓信号。
7. duplicate trading symbol 仍 fail-fast。
8. K 线 push callback 只更新缓存并发布 `CandlestickUpdatedEvent`。
9. display route state 在 seat/route 漂移后不会长期保留失活 key。

## 正向发现

以下设计应保留：

1. `quoteClient` 的 SDK callback 入口总体较轻，主要做校验、标准化、缓存投影和 listener fan-out。
2. K 线入口已有 per-monitor single-flight + latest-only collapse。
3. `monitorQuoteEventRuntime` 已按 monitorSymbol 做 latest-only collapse，并用 dirty / retry / wakeupSymbols 分离业务推进和 WAIT 唤醒。
4. `orderMonitor` route runtime 使用 symbol route state、generation、timer projection 和 dirty collapse，是较好的高频 route 设计参考。
5. `routeKey + seatVersion` current-route 校验能阻断旧 route、旧席位版本和错路由。
6. 风控缓存主要在午夜清理与 seat 激活时刷新，避免每 tick 全量重算。
7. 生命周期中的 marketDataDomain 午夜 reset 与开盘重建收口较清晰。
8. 订阅变更没有放在 push callback 内执行。

## 推荐实施顺序

```text
P0:
1. TradingRiskEventRuntime routing index 改为 seat truth-change 驱动缓存。

P1:
2. TradingQuoteDisplayRuntime 复用 cached routing index。
3. 普通信号 gate 关闭时跳过 generateSignals。
4. 为 routing index 缓存化和 K 线入口轻量性补齐测试。

P2:
5. monitorQuoteEventRuntime / switchWakeupRuntime 建 wakeup 反向索引。
6. 买入队列按 monitorSymbol + direction + seatVersion 评估 latest-only / 合并策略。
7. K 线缓存与 indicator runtime 降低复制成本。

P3:
8. delayed verification timer 批处理与样本队列优化。
9. quoteSubscriptionRuntime retain 引用计数增量化。
10. 清理少量类型断言与补充类型不变量表达。
```

## 不建议的方向

1. 不建议重写 Longbridge SDK push 入口。
2. 不建议把所有 listener 统一改成异步队列。
3. 不建议删除 seatVersion / routeKey / current-route 校验。
4. 不建议用定时 rebuild 替代 truth-change 事件。
5. 不建议在 quote miss 时 fallback rebuild。
6. 不建议优先重构 K 线缓存为复杂 ring buffer，而延后 quote routing index 优化。

## 最终判断

当前项目已经具备较好的事件驱动基础，高频链路最大问题集中在“事件到达后重复构建全局派生状态”。

优先完成 `TradingRiskEventRuntime` routing index 状态驱动缓存化后，quote 高频路径的主要线性成本会明显下降。随后可处理显示链路中的重复 routing index 构建。K 线缓存和指标 runtime 的复制成本应作为后续阶段优化，不应抢在 quote routing index 之前。
