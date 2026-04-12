# K线推送驱动业务主程序重构 Implementation Plan

**Goal:** 把当前“主循环驱动的普通指标/信号链路”重构为“`K` 线 push 直驱的普通业务主程序”，并把原 `mainProgram` 重命名为 `timeDriverProgram`，只保留天然时间语义职责。

这份版本是对上一版方案的直接修订，目标不变，但删掉了已经证明会引入错误或明显过度的设计。核心原则只有三条：

1. 普通信号主链路必须由市场事件驱动。
2. 清仓接管窗口内只能有一个清仓卖出 owner。
3. 时间轴采样不能为了抽象纯度破坏真实采样语义。
4. 启动 / 开盘重建后，不把“已存在于 candlestick cache 的首帧”主动折算成普通信号评估。

## 0. 先给结论

### 0.1 最终 owner 划分

1. **BusinessEventProgram（新增）**
   - 普通 `K` 线信号业务主程序 owner。
   - 只负责：
     - 消费 monitor symbol 的普通策略 `K` 线更新事件。
     - 推进增量指标运行态。
     - 写回 `lastMonitorSnapshot`。
     - 基于最新 snapshot 生成普通 immediate / delayed signals。
   - 不负责：
     - 生命周期 tick。
     - 末日保护。
     - 周期换标 tick。
     - `indicatorCache` 时间轴采样。
     - quote readiness 精确唤醒。

2. **TimeDriverProgram（由原 mainProgram 重命名）**
   - 时间语义 owner。
   - 只负责：
     - `dayLifecycleManager.tick(...)`
     - `canTrade` / `openProtectionActive` 更新
     - 按当前 tick 时刻计算清仓接管窗口状态，并驱动对应时间语义动作
     - 连续交易门禁关闭时取消普通 delayed signals
     - 清仓接管窗口期间冻结整条普通信号链路
     - 执行末日保护撤单与清仓
     - 周期换标 tick、展示刷新、席位同步等时间驱动维护
     - 以 tick 当下捕获的 snapshot 执行 `indicatorCache.push(...)`
   - 明确不再负责：
     - 读取 monitor candlestick 并推进指标
     - 调用普通 `runSignalPipeline(...)`

3. **现有独立 runtime owner 保持不变**
   - `monitorQuoteEventRuntime`
   - `switchWakeupRuntime`
   - `quoteSubscriptionRuntime`
   - `postTradeConsistencyRuntime`
   - `seatActivationDispatcher`
   - `autoSearchWakeupRuntime`
   - `tradingRiskEventRuntime`

不新增 `sharedMonitorRouteRuntime`。两个顶层 program 不追求“把所有 monitor 副作用统一串进一条新队列”，而是各自保持 owner 清晰，并在真正入队或提交前重新校验 seat/version/gate 真相。

### 0.2 明确修正的错误设计

1. **删除 `Shared Monitor Route Serial Boundary / sharedMonitorRouteRuntime`**
   - 原方案把它当成新 monitor 级基础设施，但并没有真正串住现有会改 seat truth 的 owner。
   - 这会制造“看起来有统一串行边界，实际上没有”的错误安全感。

2. **删除独立 `signalEvaluationLedger` 模块**
   - 不再引入任何普通信号补评估控制账本。
   - `businessEventProgram` 不再维护本地版本比较或 identity 去重状态。

3. **删除 `ordinarySignalFinalizer`**
   - delayed verification callback 不反向依赖 `businessEventProgram` owner。
   - 改为共享一个纯函数式普通信号准入检查 helper，immediate path 和 delayed path 共用。

4. **删除 `QUOTE_READY` wakeup 设计**
   - 当前仓库没有权威 “admitted + ready” 事件源。
   - 普通信号不把 quote readiness 当作触发源。
   - 买入 quote 不就绪时，本次买入 action 直接跳过，等待下一次 `K` 线事件或明确业务事件。

5. **删除清仓接管窗口下普通卖出继续运行的设计**
   - 清仓接管窗口期间普通链路全部冻结。
   - 末日清仓是唯一卖出 owner，避免与普通卖出竞争同一持仓。

6. **删除 `monitorPrice` 残留穿透链路**
   - 不只是删除 `MonitorState.monitorPrice` 字段本身。
   - 与该字段绑定的运行态读写、wake-up 传参、占位 `null` 透传都必须成组删除。
   - 但“距离换标首次触发所需的 monitor 当前价”仍保留，来源改为 monitor quote 事件本身，而不是 `MonitorState.monitorPrice` 缓存。
   - 不允许为了“先删状态、后续再清理调用方”而留下兼容层或空转字段。

### 0.3 这一版保留的增强

1. 普通信号主链路由 `K` 线 push 直接驱动，不再依赖每秒主循环重算。
2. 开盘保护期间允许 latest snapshot 持续推进，但不生成普通信号。
3. `mainProgram` 语义更正为 `timeDriverProgram`。
4. `indicatorCache` 继续按真实时间轴采样，不退化成事件采样。
5. `MonitorState.monitorPrice` 删除，而“距离换标首次触发所需的 monitor 当前价”继续直接来自 monitor quote 事件。
6. 启动 / 开盘重建后的普通信号恢复，以后续新的 `K` 线 push 为起点；不额外做 cache bootstrap 补算。
7. `monitorPrice` 残留状态和接口穿透链路必须被彻底移除，不保留兼容空壳。

### 0.4 2026-04-12 复核修订：K 线链路与 realtime quote 解耦

本次复核进一步收敛了 `businessEventProgram` 的行情边界，明确删除“K 线事件链路读取 realtime quote”的设计，不新增缓存、不新增兜底、不引入回退逻辑。

最终结论：

1. **普通 K 线业务链路不读取 realtime quote。**
   - `businessEventProgram` 只消费 `onCandlestickUpdated(...)`。
   - 事件到达后只读取 `getCandlestickSnapshot(...)`。
   - 后续只推进指标 runtime、写入 latest snapshot、同步无行情席位身份、生成普通 immediate / delayed signals。
   - `BusinessEventProgramDeps.marketDataClient` 只保留 `getCandlestickSnapshot` 与 `onCandlestickUpdated` 能力，不允许依赖 `getQuotes`。

2. **行情展示继续归属 `timeDriverProgram`。**
   - `timeDriverProgram` 每 tick 从 `marketDataClient.getQuotes(lastState.allTradingSymbols)` 读取 SDK realtime quote 状态。
   - `processMonitor -> syncSeatState -> riskTasks -> marketMonitor.monitorPriceChanges(...)` 只服务价格展示、距回收价展示、持仓市值/盈亏展示与订单数量展示。
   - 这里读取的是 SDK realtime 状态，不新增应用层 quote cache。

3. **监控标的指标展示不再由 K 线事件链路回读 quote。**
   - `indicatorPipeline` 不再调用 `marketMonitor.monitorIndicatorChanges(...)`。
   - `indicatorPipeline` 的职责收敛为 `candlestick snapshot -> incremental runtime -> latest snapshot`。
   - `indicatorCache.push(...)` 仍由 `timeDriverProgram` 按 tick 当下捕获的 latest snapshot 执行，保持延迟验证的真实时间轴采样。

4. **普通信号入队不依赖行情就绪。**
   - `signalPipeline` 不再使用 `longQuote / shortQuote`。
   - 买入普通信号不再因为 quote 未就绪而在 K 线链路提前丢弃。
   - 买入、卖出的执行时价格、lotSize、行情有效性仍由对应执行处理器在执行阶段读取 realtime quote 后校验，不能前移到 K 线事件链路。

5. **席位同步拆成同一模块内的两条明确入口。**
   - `syncSignalSeatState(...)`：无行情席位同步，供普通 K 线信号链路使用，只读取 `symbolRegistry`。
   - `syncSeatState(...)`：时间循环入口使用，在 `syncSignalSeatState(...)` 基础上结合 `quotesMap` 补充展示名称与风险展示行情。
   - 两者共享席位状态迁移、席位版本写入、ACTIVE 退化清队列和牛熊证距离缓存清理语义，不允许复制第二套清理规则。

6. **测试必须显式表达普通信号场景，不依赖真实当前时间。**
   - 普通信号入队测试应关闭 `doomsdayProtection`，否则在真实时间落入清仓接管窗口时，`ordinarySignalGuard` 会正确冻结普通信号，测试会出现时间依赖漂移。
   - 这不是生产逻辑问题，而是测试上下文必须固定业务门禁条件。

本次修订后的关键静态验收：

1. `businessEventProgram`、`indicatorPipeline`、`signalPipeline` 中不得出现 `getQuotes(`。
2. `businessEventProgram`、`indicatorPipeline`、`signalPipeline` 中不得出现 `monitorQuote`、`quotesMap`、`marketMonitor`、`longQuote`、`shortQuote`。
3. `runIndicatorPipeline(...)` 与 `runSignalPipeline(...)` 只能由 `businessEventProgram` 调用，不能重新回到 `timeDriverProgram` 或 `processMonitor`。
4. `indicatorCache.push(...)` 只能由 `timeDriverProgram` 调用。
5. `timeDriverProgram` 保留 `marketDataClient.getQuotes(...)`，但其输出只进入时间循环展示/风险展示路径，不进入普通 K 线信号链路。

本次修订后的验证记录：

1. `bun format` 通过。
2. `bun lint` 通过。
3. `bun type-check` 通过。
4. 目标测试通过：`tests/main/businessEventProgram/business.test.ts`、`tests/main/processMonitor/indicatorPipeline.business.test.ts`、`tests/main/processMonitor/signalPipeline.business.test.ts`、`tests/main/processMonitor/seatSync.business.test.ts`、`tests/main/processMonitor/index.business.test.ts`、`tests/main/processMonitor/riskTasks.business.test.ts`、`tests/integration/full-business-simulation.integration.test.ts`。
5. 全量测试通过：710 pass / 0 fail。

## 1. 第一性原理下的业务边界

### 1.1 什么事件应该驱动普通信号

普通信号是“市场状态 + 当前席位/订单上下文”的函数，但真正的主触发源只能是市场状态变化。

因此：

1. **主触发源是 monitor 的普通策略 `K` 线更新事件。**
2. **普通链路不存在任何非 `K` 线事件补评估。**
3. **quote readiness 不是普通信号触发源。**
4. **泛化的 order record changed 不是普通信号触发源。**

### 1.2 不保留任何普通信号补评估事件

这一版明确不保留任何普通信号补评估，包括但不限于：

1. 普通信号全局门禁恢复
2. `QUOTE_READY`
3. 泛化 `ORDER_RECORD_CHANGED`
4. 泛化 `SEAT_ACTIVE / seat identity changed`
5. `sellEligibilityRestored`

原因很简单：这些事件一旦放开，很容易把普通信号系统重新做回“非市场事件驱动”，并且会把 seat owner、quote owner、signal owner 的边界重新搅混。

### 1.3 普通策略的合法输入时段

当前 `quoteClient.subscribeCandlesticks(...)` 默认使用 `TradeSessions.All`。这意味着如果不改，竞价、午休或其他非连续交易时段 bar 也会进入本地 cache。

这一版必须明确：

1. **普通信号策略只消费连续交易时段的 `K` 线。**
2. 开盘保护在连续交易时段内部，因此：
   - `K` 线仍推进 latest snapshot。
   - 普通信号生成仍被阻断。
3. 非连续交易时段 bar 不允许进入普通策略快照推进链路。

实现方式只允许二选一：

1. `quoteClient` 直接按连续交易时段订阅普通策略 `K` 线。
2. 如果 SDK 只能给全时段 push，则必须在发布 `CandlestickUpdatedEvent` 前按连续交易时段过滤。

不允许的实现：

1. 接收全时段 `K` 线后直接推进普通 latest snapshot，再依赖门禁恢复消费旧 snapshot。
2. 把是否允许消费非连续时段 bar 交给下游 `businessEventProgram` 临时判断。

### 1.4 启动 / 开盘重建后的首帧语义

这一版明确接受以下容错：

1. 启动或开盘重建完成后，即使本地 candlestick cache 中已经存在 seed 数据，也**不**主动把这份已有 cache 真相折算成一次普通信号评估。
2. 普通链路的恢复起点是后续新的普通策略 `K` 线 push。
3. 这意味着启动 / 重建完成到下一次合法 `K` 线 push 到来前，普通信号链路存在短暂静默窗口。

这是刻意收敛后的业务取舍，不视为缺陷。原因只有两点：

1. 该窗口不会破坏持仓安全或 owner 边界，只影响“是否立即恢复普通入场/出场机会”。
2. 为消除这段窗口而额外引入 cache bootstrap / 首帧补算，会把普通链路重新拉回“非市场事件触发”的语义，得不偿失。

实现约束：

1. `businessEventProgram.start()` 不主动扫描 candlestick cache 生成首帧 snapshot。
2. `rebuildTradingDayState` 完成后不额外触发“基于 cache 现状”的普通信号评估。
3. 门禁恢复时，即使已经存在 `state.lastMonitorSnapshot`，也不会消费这份旧 snapshot。
4. 这意味着开盘保护结束或连续交易恢复时，保护/关闭期间最后一根已形成的 `latest snapshot` 会被直接放弃；普通链路恢复必须等待下一根新的合法 `K` 线 push。

### 1.5 `monitorPrice` 删除语义

这一版对 `monitorPrice` 的要求不是“字段弃用”，而是**删除状态缓存链路并保留真正需要的事件输入**：

1. `MonitorState.monitorPrice` 字段必须删除。
2. 所有以该字段为来源的写入、读取、转发、初始化、跨日清理都必须同步删除。
3. `switchWakeupRuntime -> state.monitorPrice -> advancePendingSwitch(...)` 这条残留传参链路必须删除。
4. 距离换标首次触发仍然需要 monitor 当前价，但该值必须直接来自 monitor quote 事件，并只用于 `startSwitchOnDistance(...)`。
5. 不允许保留任何“兼容过渡”写法：
   - 保留字段但不再使用
   - 继续从状态缓存读取后再向下传参
   - 为 `advancePendingSwitch(...)` 保留统一传 `null` 的占位参数
   - 为替代状态缓存而额外调用 `marketDataClient.getQuotes([monitorSymbol])` 回读 monitor 当前价
   - 保留运行态同步代码作为“以后可能还会用”

原因：

1. 当前 `monitorPrice` 已不是普通信号真相来源。
2. 距离换标的首次触发已经由 monitor quote 事件驱动，当前价并不需要先写入 `MonitorState` 再回读。
3. pending switch 的后续推进当前并不依赖 `monitorPrice`，继续保留只会留下伪输入和错误边界。
4. 这类残留最容易演化成新的隐性兜底或回退入口。

实现口径：

1. `startSwitchOnDistance(...)` 的 `monitorPrice` 直接使用 `QuoteUpdatedEvent.quote.price`。
2. 不新增“为了拿 monitor 当前价而再调用一次 `marketDataClient.getQuotes([monitorSymbol])`”的回读逻辑。
3. `marketDataClient.getQuotes(...)` 继续只用于换标执行阶段对交易标的/候选标的读取 realtime quote，而不是回补 monitor 事件已给出的当前价。

## 2. 关键业务语义

### 2.1 `清仓接管窗口` 语义

这里统一使用“清仓接管窗口”命名，不把当前默认窗口时长写进命名。

这一版强制收敛为：

1. 清仓接管窗口期间，**整条普通信号链路冻结**。
2. 包括：
   - 普通 immediate signal 不入队
   - 普通 delayed signal 不新增
   - 普通 delayed verification callback 不得 enqueue
3. 清仓接管窗口开始时取消全部普通 delayed signals。
4. 末日保护撤单与清仓继续由 `timeDriverProgram -> doomsdayProtection` 独占。

理由：

1. 当前系统里末日清仓唯一 owner 是靠主程序固定顺序保证的，而不是靠共享状态。
2. 如果清仓接管窗口还允许普通卖出继续，新的普通 owner 必须复制一份“末日清仓会不会接管这个方向”的判断，这在当前仓库里没有权威状态来源。
3. 对量化交易系统来说，把 exit owner 收到一条路径上，比继续追求“普通卖出也许还能更细粒度运行”更重要。

实现口径：

1. `timeDriverProgram` 可以在 tick 内计算 `previousTakeoverActive / currentTakeoverActive`，只用于：
   - 判断是否需要取消普通 delayed signals
   - 决定本 tick 是否执行 doomsdayProtection
2. 这个 takeover 状态不作为普通链路的共享准入真相向外暴露。

### 2.2 `indicatorCache` 采样语义

必须保持：

1. `DelayedSignalVerifier` 继续按 `T0 / T0+5s / T0+10s ±5s` 取样。
2. `indicatorCache.push(...)` 只能由 `timeDriverProgram` owner 调用。
3. `indicatorCache.push(...)` 必须接收 `sampleTimestampMs`。
4. `timeDriverProgram` 在 tick 当下捕获：
   - `sampleTimestampMs`
   - 当前 `state.lastMonitorSnapshot` 引用
5. 然后立刻调用 `indicatorCache.push(monitorSymbol, capturedSnapshot, sampleTimestampMs)`。

不允许：

1. 把采样 intent 放进异步共享 route，稍后再回读 `state.lastMonitorSnapshot`。
2. 只保时间戳，不保 snapshot identity。
3. 把时间轴采样改成 `K` 线事件采样。

### 2.3 普通信号准入口径

新增一个共享 helper，例如 `ordinarySignalGuard`，它只做纯判断，不持有 owner 私有状态。

最小口径固定为：

1. `lastState.isTradingEnabled === true`
2. `lastState.canTrade === true`
3. `lastState.openProtectionActive === false`
4. 当前时刻不在清仓接管窗口内：
   - 使用 `isWithinDoomsdayClearanceTakeoverWindow(now(), lastState.isHalfDay ?? false)` 实时判定
   - 不读取“上一 tick 留下的 doomsday 布尔缓存”作为普通链路准入真相

该 helper 供以下路径共用：

1. `businessEventProgram` 的 immediate / delayed signal 分流
2. `registerDelayedSignalHandlers.ts` 的 verified callback 最终 enqueue

不再引入：

1. `ordinarySignalFinalizer`
2. owner 私有 epoch/stopping/draining 反向注入 delayed handler

`businessEventProgram` 自己的运行态停止只由其本地 `running / epoch` 在 route 内判断；delayed handler 只复用共享准入 + seat 校验。

## 3. 运行态设计

### 3.1 BusinessEventProgram

#### 输入

1. `marketDataClient.onCandlestickUpdated(...)`

#### 路由

每个 `monitorSymbol` 维护一个本地 route state：

1. `inFlight`
2. `dirty`

#### 行为

1. **K 线 route**
   - 读取权威 candlestick cache snapshot
   - 推进增量指标 runtime
   - 更新 `state.lastMonitorSnapshot`
   - 按当前普通信号门禁决定是否运行普通 `runSignalPipeline(...)`

### 3.2 TimeDriverProgram

每次 tick 固定顺序：

1. 计算当前时间下的：
   - `canTrade`
   - `openProtectionActive`
   - `doomsdayTakeoverActive`
2. 调用 `dayLifecycleManager.tick(...)`
3. 连续交易门禁关闭时取消全部普通 delayed signals
4. 清仓接管窗口从 `false -> true` 时取消全部普通 delayed signals
5. 执行末日保护：
   - 撤销未成交买入
   - 自动清仓
6. 若本 tick 未被末日保护提前 return，则执行时间驱动维护：
   - 周期换标 tick
   - 风险展示刷新
   - 席位同步
   - `indicatorCache` 采样明确不做：

7. `runIndicatorPipeline(...)`
8. `runSignalPipeline(...)`

## 4. 文件改动

### 4.1 新增

- `src/main/businessEventProgram/index.ts`
  - 普通 `K` 线业务主程序
  - 本地 per-monitor single-flight
  - 暴露：
    - `start()`
    - `stopAndDrain()`

- `src/main/businessEventProgram/types.ts`
  - 依赖与局部 route state 类型
  - 不包含版本比较或 identity 去重字段

- `src/main/ordinarySignalGuard/index.ts`
  - 纯函数式普通信号准入判断
  - doomsday 部分按 `now()` + `isHalfDay` 实时判定，不读 tick 缓存布尔值

### 4.2 删除

- `src/main/sharedMonitorRouteRuntime/*`
- `src/main/businessEventProgram/signalEvaluationLedger.ts`
- `src/main/businessEventProgram/ordinarySignalFinalizer.ts`

### 4.3 重点修改

- `src/services/quoteClient/index.ts`
  - 新增 `onCandlestickUpdated(...)`
  - 发布前必须保证事件只代表普通策略允许消费的连续交易时段 `K` 线

- `src/types/services.ts`
  - 新增 `CandlestickUpdatedEvent`

- `src/main/processMonitor/indicatorPipeline.ts`
  - 改成纯“candlestick snapshot -> incremental runtime -> latest snapshot”
  - 删除 `indicatorCache.push(...)`

- `src/main/timeDriverProgram/index.ts`
  - 作为唯一时间驱动 owner
  - doomsday takeover 只在 tick 内本地计算，不作为普通链路共享布尔状态写入

- `src/main/asyncProgram/indicatorCache/index.ts`
  - `push(...)` 改为显式接收 `sampleTimestampMs`

- `src/app/registerDelayedSignalHandlers.ts`
  - verified callback 改为：
    - 共享 `ordinarySignalGuard`
    - 共享 seat 校验
    - direct queue push
  - 不再依赖 `businessEventProgram` 内部 finalizer

- `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts`
  - monitor candlestick 订阅改为普通策略合法 session

- `src/types/state.ts`
  - 删除 `MonitorState.monitorPrice`
  - 保留方向化距回收价百分比缓存

- `src/main/processMonitor/index.ts`
  - 删除 `state.monitorPrice` 的本地同步与变化比较逻辑

- `src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts`
  - 删除从 `monitorContext.state.monitorPrice` 读取并向 `advancePendingSwitch(...)` 传参的逻辑

- `src/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts`
  - 保留基于 `QuoteUpdatedEvent.quote.price` 直接调用 `startSwitchOnDistance(...)` 的距离换标触发
  - 不再依赖 `MonitorState.monitorPrice` 作为中间缓存
  - 不新增 `marketDataClient.getQuotes([monitorSymbol])` 的 monitor 价回读

- `src/types/monitorContextPorts.ts`
  - 保留 `startSwitchOnDistance(...)` 中的 `monitorPrice`
  - 删除 `advancePendingSwitch(...)` 中的 `monitorPrice`

- `src/services/autoSymbolManager/types.ts`
  - 保留 `StartSwitchOnDistanceParams.monitorPrice`
  - 删除 `AdvancePendingSwitchParams.monitorPrice`

- `src/services/autoSymbolManager/switchStateMachine.ts`
  - 保留 `startSwitchOnDistance(...)` 对 `monitorPrice` 的真实使用
  - 删除 `advancePendingSwitch(...)` 中的 `monitorPrice` 入参
  - 删除 `processSwitchState(...)` 的占位 `null` 透传与无效字段穿透

## 5. 严格禁止

1. 不允许保留“`timeDriverProgram` 继续驱动普通指标/信号”的双轨。
2. 不允许新增任何 `K` 线事件丢失后的主循环兜底重算。
3. 不允许把 `indicatorCache.push(...)` 放进异步共享 route，再回读最新 snapshot。
4. 不允许再引入 `QUOTE_READY`、`signalEvaluationLedger`、`ordinarySignalFinalizer`、`sharedMonitorRouteRuntime`。
5. 不允许在清仓接管窗口期间继续运行普通卖出。
6. 不允许让非连续交易时段 `K` 线推进普通 latest snapshot。
7. 不允许把所有 order recorder 变化都做成普通信号恢复评估事件。
8. 不允许为了“保持兼容”保留 `mainProgram -> timeDriverProgram` 薄包装。
9. 不允许保留 `MonitorState.monitorPrice` 兼容字段、`advancePendingSwitch(...)` 的占位 `monitorPrice` 参数、统一传 `null` 的透传、为替代状态缓存而新增 `getQuotes([monitorSymbol])` 回读或任何再次复用该弃用状态字段的写法。

## 6. 实施顺序

- [ ] **Step 1: 暴露普通策略 `K` 线更新事件**
  - 新增 `onCandlestickUpdated(...)`
  - 明确连续交易 session 过滤

- [ ] **Step 2: 从 `indicatorPipeline` 剥离 `indicatorCache.push(...)`**
  - 指标推进和时间轴采样彻底分离

- [ ] **Step 3: 实现 `businessEventProgram`**
  - 只消费 `K` 线事件
  - 本地 per-monitor single-flight
  - `start()` 不做 candlestick cache bootstrap
  - 不做本地 version / identity 比较

- [ ] **Step 4: 把 `mainProgram` 重命名并收缩为 `timeDriverProgram`**
  - 删除普通指标/信号链路
  - 按当前 tick 实时计算清仓接管窗口状态
  - 把 `indicatorCache` 采样移到 tick 本地

- [ ] **Step 5: 简化 delayed handler**
  - 使用共享 `ordinarySignalGuard`
  - 保留 direct queue push

- [ ] **Step 6: 删除 `monitorPrice` 残留链路**
  - 删除状态字段
  - 删除 `advancePendingSwitch(...)` 相关接口参数与类型
  - 删除本地同步、wake-up 传参与占位透传
  - 保留 `startSwitchOnDistance(...)` 对 quote 事件当前价的直接输入
  - 不保留兼容空壳

- [ ] **Step 7: 删除过度设计模块与引用**
  - `sharedMonitorRouteRuntime`
  - `signalEvaluationLedger`
  - `ordinarySignalFinalizer`
  - `QUOTE_READY` 相关事件契约

## 7. 关键测试

### 7.1 必须新增/修改的单测

1. `tests/main/businessEventProgram/business.test.ts`
   - `K` 线 push 直接推进 latest snapshot
   - 门禁恢复后不会消费已有 `latest snapshot`
   - `start()` 不会把已有 candlestick cache seed 主动折算成普通信号评估
   - push 到达后不做本地 version / identity 去重比较

2. `tests/main/timeDriverProgram/business.test.ts`
   - `timeDriverProgram` 不再调用普通指标/信号流水线
   - 连续交易 gate 关闭时取消全部普通 delayed signals
   - 清仓接管窗口开始时冻结全部普通信号链路，并取消全部普通 delayed signals
   - 清仓接管窗口下只允许 `doomsdayProtection` 负责退出
   - 普通链路的 doomsday 准入判定不读取 tick 缓存布尔值
   - 仓库内不存在对 `state.monitorPrice` 的读写残留

3. `tests/app/registerDelayedSignalHandlers.test.ts`
   - verified callback 仍 direct push queue
   - enqueue 前复用 `ordinarySignalGuard`
   - 清仓接管窗口 / gate closed 时 verified signal 被丢弃

4. `tests/services/quoteClient/business.test.ts`
   - `onCandlestickUpdated(...)` 只发布普通策略允许消费的 session 事件

5. `tests/main/lifecycle/rebuildTradingDayState.test.ts`
   - rebuild 完成后 businessEventProgram 才允许 start
   - rebuild 完成后不会基于 candlestick cache 现状主动触发普通信号评估

6. `tests/services/autoSymbolManager/*.test.ts`
   - `startSwitchOnDistance(...)` 继续要求 `monitorPrice`，且其值来自 quote 事件当前价
   - `advancePendingSwitch(...)` 不再要求 `monitorPrice`
   - 不存在占位 `null` 透传的兼容写法
   - 不存在为 monitor 当前价额外调用 `getQuotes([monitorSymbol])` 的回读逻辑

### 7.2 关键回归场景

1. **清仓接管窗口 owner 唯一性**
   - 进入清仓接管窗口后，普通卖出绝不与末日清仓并发争抢同一持仓

2. **采样时间轴正确性**
   - `indicatorCache` 中任一样本的 snapshot 值与 `sampleTimestampMs` 属于同一 tick 当下捕获

3. **不开倒车**
   - 不存在“主循环再次驱动普通指标/信号”的回退逻辑

## 8. 验收标准

### 8.1 结构验收

1. 仓库内不存在 `src/main/sharedMonitorRouteRuntime/`
2. 仓库内不存在 `signalEvaluationLedger.ts`
3. 仓库内不存在 `ordinarySignalFinalizer.ts`
4. `runApp` 无限循环只调用 `timeDriverProgram(...)`
5. `businessEventProgram` 是唯一普通 `K` 线信号主程序
6. 仓库内不存在 `MonitorState.monitorPrice`、`advancePendingSwitch(...)` 的 `monitorPrice` 参数及其兼容透传残留

### 8.2 业务验收

1. monitor `K` 线 push 到达后，不等待下一秒主循环，立即推进普通 latest snapshot
2. 开盘保护期间 latest snapshot 继续推进，但普通信号不生成
3. 非连续交易时段 `K` 线不会推进普通 latest snapshot
4. 开盘保护结束或连续交易门禁恢复后，不会消费门禁关闭期间保留的 latest snapshot；普通链路只等待下一根新的合法 `K` 线 push
5. 清仓接管窗口期间整条普通信号链路冻结，末日清仓是唯一退出 owner
6. `indicatorCache` 时间轴采样不漂移、不串样本
7. 启动 / 开盘重建后，在下一次合法 `K` 线 push 到来前允许普通链路保持静默

### 8.3 过程验收

1. 无双轨
2. 无兜底重算
3. 无新的兼容式薄包装
4. 无为了解决局部问题而新增一整套跨 lifecycle 控制面
5. 无 `MonitorState.monitorPrice` 弃用字段残留、无 `advancePendingSwitch(...)` 占位透传、无回退复用

## 9. 完成定义

- [ ] `businessEventProgram` 已成为唯一普通 `K` 线信号业务主程序
- [ ] `timeDriverProgram` 已成为唯一时间驱动器
- [ ] 清仓接管窗口期间不存在普通卖出与末日清仓的双 owner 竞争
- [ ] `indicatorCache` 的每个样本都使用 tick 当下捕获的 snapshot + `sampleTimestampMs`
- [ ] 非连续交易时段 `K` 线不再推进普通策略 snapshot
- [ ] 仓库内不存在 `sharedMonitorRouteRuntime` / `signalEvaluationLedger` / `ordinarySignalFinalizer` / `QUOTE_READY`
- [ ] 仓库内不存在 `MonitorState.monitorPrice` 状态字段、`advancePendingSwitch(...)` 的 `monitorPrice` 参数及其兼容占位透传残留
- [ ] `bun format`、`bun lint`、`bun type-check` 全部通过
