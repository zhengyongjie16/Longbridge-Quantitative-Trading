# 非周期自动换标与订阅维护事件驱动重构方案

**Goal:** 在不改变现有业务语义的前提下，把“除周期换标外的自动换标域”从主循环轮询推进迁移为显式事件驱动。迁移范围包括：空席位自动寻标、距离换标入口、pending switch 后续推进、`ACTIVATING -> SEAT_REFRESH -> ACTIVE` 激活链路，以及运行时行情订阅集合维护。最终要求是：周期换标继续由时间驱动 owner 负责，其余自动换标相关链路与订阅切换不再依赖主循环每秒观察后推进。

**Architecture:** 保留当前混合架构中的时间控制平面，但把非周期自动换标域收敛为四个显式 owner：`MonitorQuoteEventRuntime` 负责监控标的 quote 触发的距离换标入口，`SwitchWakeupRuntime` 负责 pending switch 的 order/freshness/quote/timer 推进，新增 `AutoSearchWakeupRuntime` 负责运行时空席位自动寻标的事件与 timer 推进，新增 `QuoteSubscriptionRuntime` 作为稳态运行期 quote 订阅集合的唯一 owner。另增一个受 lifecycle 显式 start/stop 管理的 `SeatActivationDispatcher`，它只负责把 runtime 阶段的 `ACTIVATING` seat 变化转成 `SEAT_REFRESH` producer，不持有 seat 真相，也不消费 bootstrap/open rebuild 过程中的过渡事件。`SEAT_REFRESH` 仍保留现有激活屏障与订单/风控缓存初始化语义，但不再直接调用 `subscribeSymbols(...)`；它改为由 `SeatActivationDispatcher` 触发，并显式等待 `QuoteSubscriptionRuntime` 完成所需 symbol 的 quote admission。

**Tech Stack:** TypeScript, Bun, Longbridge QuoteContext(WebSocket), 当前 `monitorQuoteEventRuntime` / `switchWakeupRuntime` / `postTradeConsistencyRuntime` / `orderMonitor` / `symbolRegistry` / `autoSymbolManager` / lifecycle cache domains / `marketDataClient.subscribeSymbols(...)`。

---

## 0. 最终结论

### 0.1 本次方案的核心判断

结论分为两层：

1. 在“自动换标域”内部，**周期换标是唯一应该保留为时间驱动 owner 的业务链路**。
2. 在整个系统层面，仍然存在生命周期、末日保护、延迟验证时间轴等天然时间语义；这些不是本次方案的改造对象，也不是兼容性兜底，而是与自动换标域不同的真相源。

因此，本方案的精确定义不是“除了周期换标外整个系统都纯事件驱动”，而是：

- **除了周期换标外，自动换标域及其订阅切换域全部改为事件 owner 推进。**
- **系统级时间控制平面保持存在，但不再承担非周期自动换标推进职责。**

### 0.2 本次必须实现的 owner 收敛

迁移完成后，自动换标域必须满足以下 owner 边界：

1. 距离换标入口只能由 `monitorSymbol` quote 事件启动。
2. pending switch 只能由 `SwitchWakeupRuntime` 推进。
3. 运行时空席位自动寻标只能由 `AutoSearchWakeupRuntime` 推进。
4. `ACTIVATING -> SEAT_REFRESH` 只能由 `SeatActivationDispatcher` 在 runtime 阶段根据 seat 变化事件触发。
5. 稳态运行期 quote 订阅集合只能由 `QuoteSubscriptionRuntime` 维护。
6. `AUTO_SYMBOL_TICK` 只能剩下周期换标检查，不能再承担空席位寻标、距离换标、激活刷新或订阅切换。
7. `QuoteSubscriptionRuntime` 必须先完成启动期真相投影，再允许 `SeatActivationDispatcher` 与 `AutoSearchWakeupRuntime` 接管运行时事件。

### 0.3 本次明确不允许的实现

1. 不允许保留 `mainProgram` 中的 `collectRuntimeQuoteSymbols -> diff -> subscribe/unsubscribe` 作为最终收敛兜底。
2. 不允许保留 `processMonitor -> syncSeatState` 观察 `ACTIVATING` 后再触发 `SEAT_REFRESH` 的旧路径。
3. 不允许保留 `AUTO_SYMBOL_TICK` 驱动空席位自动寻标。
4. 不允许保留“事件入口已生效，但主循环每秒还会再扫一次”的双轨。
5. 不允许新增任何“若事件没来就每秒再扫一次”的补丁式 fallback。
6. 不允许在新 runtime 中引入独立的事实缓存副本，导致 seat/order/position/quote retain reason 出现第二真相源。

---

## 1. 范围与硬约束

### 1.1 本次必须完成的范围

1. 把空席位自动寻标从 `AUTO_SYMBOL_TICK` 中拆出，改为事件+timer 驱动。
2. 保留现有 `monitorQuoteEventRuntime` 与 `switchWakeupRuntime` 的业务语义，并把其 owner 边界固定为唯一真相源。
3. 把 `ACTIVATING -> SEAT_REFRESH` 从主循环观察式调度改为 seat event 直驱。
4. 把运行时 `allTradingSymbols` 维护从主循环 diff 改为独立订阅 owner。
5. 把 `AUTO_SYMBOL_TICK` 收缩为仅处理周期换标。

### 1.2 本次明确不改的范围

1. 周期换标的时间驱动语义保持不变。
2. 生命周期 `dayLifecycleManager.tick(...)` 保持不变。
3. 末日保护、延迟验证、指标采样时间轴保持不变。
4. `SEAT_REFRESH` 作为激活屏障的业务目的保持不变：仍负责激活阶段的订单/风控缓存刷新与失败回 EMPTY；但 quote admission owner 从 handler 内部剥离到 `QuoteSubscriptionRuntime`。
5. `orderMonitor`、`postTradeConsistencyRuntime`、`tradingRiskEventRuntime` 现有业务语义保持不变，只扩展必要事件端口与接线。

### 1.3 关键业务约束

1. 不允许在 seat 进入 `ACTIVATING` 后延迟到主循环下一拍才接入新标的订阅。
2. 不允许在旧标的仍有持仓、挂单、pending switch wakeup、静态清仓 retry 时提前退订。
3. 不允许把 `lastState.allTradingSymbols` 继续作为“主循环扫描结果缓存”；在稳态运行期它必须变成 `QuoteSubscriptionRuntime` 的受控运行态，而 startup/open rebuild/midnight clear 仍可在生命周期过渡点初始化或清空它。
4. 不允许把 `positions`、`orderHoldSymbols`、`seatState` 的快照在 runtime 内长期持有后重复使用；每次事件推进都必须重新读取权威状态。
5. `QuoteSubscriptionRuntime` 在 startup/open rebuild 成功后，必须先对当前权威 seat/order-hold/position/runtime retain 做一次全量投影，然后才能开始消费增量事件。
6. `SeatActivationDispatcher` 与 `AutoSearchWakeupRuntime` 只能在 `QuoteSubscriptionRuntime` 完成首轮投影后启动；二者 start 时只接管当下仍处于 `ACTIVATING` / `EMPTY` 的 seat，不补消费 bootstrap 期间历史事件。
7. `SEAT_REFRESH` 失败写回 `EMPTY` 时，不允许制造零冷却空席位；回到 `EMPTY` 后仍必须服从自动寻标冷却语义。
8. `quote admission ready` 只表示订阅 mutation 已完成且 symbol 已进入 `QuoteSubscriptionRuntime` 已提交成功的 subscribed committed set，不表示已收到第一笔 realtime push，也不保证 `getQuotes(...)` 返回非 `null`。
9. `SEAT_REFRESH` 若仍会读取 `previousSymbol` quote 做旧标的订单记录清理，则该 symbol 在 refresh 完成前也必须有显式 retain reason；不允许只给 `nextSymbol` admission 而让 `previousSymbol` 在 refresh 期间提前退订。

---

## 2. 当前实现的关键问题

### 2.1 距离换标推进已经大体事件化，但激活链路仍未脱离主循环

当前分层是：

1. `monitorQuoteEventRuntime` 已监听 `onQuoteUpdated(...)`，可直接启动距离换标。
2. `switchWakeupRuntime` 已监听 quote / order / freshness / retry timer，可继续推进 pending switch。
3. 但状态机写入 `ACTIVATING` 后，并不会立刻进入激活流程。
4. 现有实现必须等主循环执行 `processMonitor -> syncSeatState(...)`，由它观察 seat 变化后才入队 `SEAT_REFRESH`。

这意味着：

- 距离换标 owner 已经不是主循环。
- 但换标完成后的“激活新席位并接入订阅”仍存在 1 秒心跳依赖。

### 2.2 空席位自动寻标仍绑定在 `AUTO_SYMBOL_TICK`

当前 `AUTO_SYMBOL_TICK` 同时承担：

1. 空席位自动寻标。
2. 周期换标到期判断。

这导致：

1. 空席位补齐并不由 seat 变化 owner 驱动，而是由市场处理节拍顺手触发。
2. “空席位进入 EMPTY”与“冷却到期后再次尝试寻标”之间缺少显式 owner。
3. 只要保留这条链路，就无法宣称“除周期换标外自动换标域已经事件驱动”。

### 2.3 运行时订阅集合的权威 owner 仍在主循环

当前 `mainProgram` 每拍都会：

1. 收集 monitor symbol、seat symbol、positions、orderHoldSymbols。
2. 计算 `desiredSymbols`。
3. 与 `lastState.allTradingSymbols` 做 diff。
4. 调用 `subscribeSymbols(...)` / `unsubscribeSymbols(...)`。

这条链路的问题不在于逻辑错误，而在于 owner 错位：

1. 订阅集合变化的真实触发因子不是“每秒一次”，而是 seat/order/position/wakeup retain reason 的变化。
2. 主循环并不知道“为什么这个 symbol 当前必须保留订阅”，它只是被动扫描全量状态。
3. 只要主循环仍是订阅集合 owner，就会天然保留一个轮询兜底路径。

### 2.4 `SEAT_REFRESH` 当前既是激活屏障，也是订阅切换的事实入口

当前 `SEAT_REFRESH` handler 内会：

1. 对 `nextSymbol` 和可选 `previousSymbol` 执行 `subscribeSymbols(...)`。
2. 拉取执行态 quotes。
3. 重建订单记录、账户/持仓、浮亏与牛熊证缓存。
4. 成功后把 seat 切到 `ACTIVE`。

这说明：

1. 现有系统已经承认“seat 激活是一条独立链路”。
2. 真正缺失的是“谁负责在 seat 进入 `ACTIVATING` 时立刻触发它”。
3. 但如果同时要求 `QuoteSubscriptionRuntime` 成为唯一订阅 owner，就不能再保留 `SEAT_REFRESH` 直接调用 `subscribeSymbols(...)`。
4. 因此，本方案必须把“激活屏障”与“订阅 owner”拆开：保留 `SEAT_REFRESH` 作为激活屏障，但把 quote admission 前移到 `QuoteSubscriptionRuntime`。

---

## 3. 目标架构

## 3.1 总体原则

本次重构后，自动换标域收敛为四个 owner：

1. `MonitorQuoteEventRuntime`
   - 负责 monitor quote 驱动的距离换标入口与静态清仓入口。
2. `SwitchWakeupRuntime`
   - 负责 pending switch 的 quote/order/freshness/timer 推进。
3. `AutoSearchWakeupRuntime`
   - 负责运行时空席位自动寻标的 seat/gate/timer 推进。
4. `QuoteSubscriptionRuntime`
   - 负责稳态运行期 quote 订阅集合的唯一维护，并对激活链路提供 quote admission 完成信号。

辅助边界：

5. `SymbolRegistry` 扩展 seat change event port。
6. `OrderHoldRegistry` 或 `Trader` 扩展 order-hold change event port。
7. `SeatActivationDispatcher` 作为 runtime-only producer，由 lifecycle 显式 start/stop；它只把 seat event 转成 `SEAT_REFRESH` 调度，不持有 seat 事实副本。
8. `SEAT_REFRESH` handler 不再直接操作 `subscribe/unsubscribe`。

## 3.2 每个 owner 的职责边界

### A. `MonitorQuoteEventRuntime`

保留当前职责，不扩权：

1. 自动寻标开启时，收到 `monitorSymbol` quote 后判断是否启动距离换标。
2. 自动寻标关闭时，收到 `monitorSymbol` quote 后执行静态距回收价清仓入口。
3. 若距离换标启动结果返回 `WAIT`，把后续推进权交给 `SwitchWakeupRuntime`。

明确禁止：

1. 不允许它继续推进已 handoff 的 pending switch。
2. 不允许它承担 seat 激活或订阅集合收敛。

### B. `SwitchWakeupRuntime`

保留当前职责，并显式纳入订阅 retain 通知：

1. 继续监听 `onQuoteUpdated(...)`、`onOrderStateChanged(...)`、`onFreshReached(...)`、retry timer。
2. 每次合法 wakeup 后重新读取当前权威 seat / positions / pending orders。
3. 当 drive result 中要求等待 old/new symbol quote 时，向 `QuoteSubscriptionRuntime` 注册/撤销 retain reason。

明确禁止：

1. 不允许直接做 `subscribe/unsubscribe`。
2. 不允许启动新的距离换标入口。

### C. `AutoSearchWakeupRuntime`

这是本次新增 owner，负责运行时空席位自动寻标。

它只处理以下触发因子：

1. 运行时 seat 进入 `EMPTY`。
2. runtime start 时，对 bootstrap 结束时仍处于 `EMPTY` 的 seat 做一次 seed，并建立后续 wakeup。
3. 搜索冷却 timer 到期。
4. 早盘延迟 timer 到期。
5. 连续交易门禁从关闭变为打开。

它不处理：

1. 周期换标。
2. 距离换标。
3. `SEAT_REFRESH`。

### D. `QuoteSubscriptionRuntime`

这是本次新增 owner，作为稳态运行期 `allTradingSymbols` 的唯一 owner。

它维护 `symbol -> retain reasons` 的真相，retain reason 至少包括：

1. `MONITOR_BASE`
   - 每个 monitorSymbol 的基础订阅。
2. `SEAT_BOUND`
   - 当前 seat 绑定的 symbol，包括 `SWITCHING` / `ACTIVATING` / `ACTIVE` 三类占用。
3. `POSITION_HOLD`
   - 当前持仓中的 symbol。
4. `ORDER_HOLD`
   - 当前未完成订单保留集中的 symbol。
5. `SWITCH_WAKEUP`
   - `SwitchWakeupRuntime` 注册的 old/new symbol quote wakeup 需求。
6. `STATIC_LIQUIDATION_WAIT`
   - 静态清仓 retry 注册的 trading symbol wakeup 需求。
7. `SEAT_REFRESH_WAIT`
   - `SEAT_REFRESH` 激活屏障阶段临时保留的 symbol，至少覆盖 `nextSymbol`，以及仍被 refresh 读取的 `previousSymbol`。

运行规则：

1. 某 symbol 只要 retain reasons 非空，就必须保持订阅。
2. 只有 retain reasons 为空，且不属于 lifecycle stop/rebuild 中的保留阶段，才允许退订。
3. runtime start 之后，`lastState.allTradingSymbols` 只允许由该 runtime 写入；在 startup/open rebuild/midnight clear 这些生命周期过渡点，仍允许生命周期流程初始化或清空该字段。
4. startup/open rebuild 成功后，必须先执行一次 `reconcileFromCurrentTruth()`：把 `MONITOR_BASE`、当前 seat、当前 order-hold、当前持仓以及已恢复 runtime retain 一次性投影到 retain set，再开始监听增量事件。
5. 对外暴露的 admission-ready 协议只表示“订阅 mutation 已成功提交，并且 symbol 已进入 `QuoteSubscriptionRuntime` 的 subscribed committed set”，不能把“收到第一笔 quote push”当成 admission 完成条件。
6. `QuoteSubscriptionRuntime` 必须提供临时 retain API，供 `SEAT_REFRESH` 在 refresh 开始前申请 `SEAT_REFRESH_WAIT`，在 refresh 结束后释放；不能假设 `SEAT_BOUND` / `POSITION_HOLD` / `ORDER_HOLD` 一定覆盖 `previousSymbol`。
7. 所有 runtime-owned retain（`SWITCH_WAKEUP` / `STATIC_LIQUIDATION_WAIT` / `SEAT_REFRESH_WAIT`）都必须是 owner 生命周期绑定的：owner 路由删除、seatVersion 失效、任务失败、stopAndDrain 时，都必须显式释放，不能依赖后续某次 diff 自然收敛。

### E. `SeatActivationDispatcher`

这是新增的 lifecycle-owned producer，不是新的 seat 真相源。

它只负责：

1. 监听 `SeatStateChangedEvent`。
2. seat 在 runtime 阶段进入 `ACTIVATING` 时立即 `scheduleLatest(SEAT_REFRESH)`。
3. start 时按当前权威 seat 做一次 seed，把 rebuild 完成后仍处于 `ACTIVATING` 的 seat 补齐到激活链路。
4. stop 时取消监听，不补消费停机或 open rebuild 期间错过的过渡事件。

明确禁止：

1. 不允许在 dispatcher 内缓存 seat 副本。
2. 不允许在 startup/open rebuild 未完成前启用。
3. 不允许绕过 `QuoteSubscriptionRuntime` 直接调用订阅 API。

---

## 4. 事件模型与端口设计

## 4.1 `SymbolRegistry` 新增 seat 事件端口

新增最小端口：

```ts
interface SymbolRegistry {
  onSeatStateChanged: (listener: (event: SeatStateChangedEvent) => void) => Unsubscribe;
}
```

事件载荷建议：

```ts
type SeatStateChangedEvent = Readonly<{
  monitorSymbol: string;
  direction: 'LONG' | 'SHORT';
  previousState: SeatState;
  nextState: SeatState;
  previousVersion: number;
  nextVersion: number;
}>;
```

事件语义：

1. `updateSeatState(...)` 后发事件。
2. 若本次更新触发了 `bumpSeatVersion(...)`，事件中的 `nextVersion` 必须反映 bump 后版本。
3. `bumpSeatVersion(...)` 单独调用但 state 未改动时，不额外发第二条 seat-state 事件；版本变化由调用方在状态更新事件中一并表达。

消费方：

1. `AutoSearchWakeupRuntime`
2. `QuoteSubscriptionRuntime`
3. `SeatActivationDispatcher`

## 4.2 `OrderHoldRegistry` 新增保留集变化端口

新增最小端口：

```ts
interface Trader {
  onOrderHoldSymbolsChanged: (
    listener: (event: OrderHoldSymbolsChangedEvent) => void,
  ) => Unsubscribe;
}
```

事件载荷建议：

```ts
type OrderHoldSymbolsChangedEvent = Readonly<{
  symbol: string;
  action: 'ADDED' | 'REMOVED';
}>;
```

消费方：

1. `QuoteSubscriptionRuntime`

约束：

1. 该事件只表达 hold-set 变化，不表达订单业务真相。
2. 不能由主循环重新扫描 holdSymbols 来替代。

## 4.3 持仓快照刷新与 `POSITION_HOLD`

`POSITION_HOLD` 不能只绑定在 freshness 事件上，因为当前运行时还有非 post-trade 路径会直接刷新 `lastState.cachedPositions`。

约束：

1. `SwitchWakeupRuntime` 继续复用 `PostTradeConsistencyRuntime.onFreshReached(...)`。
2. `QuoteSubscriptionRuntime` 必须在每次权威 `cachedPositions` 写入后重投影 `POSITION_HOLD`，不能仅依赖 `onFreshReached(...)`。
3. 当前至少有两类 writer：
   - `postTradeConsistencyRuntime` fresh 完成后写入的持仓快照。
   - `SEAT_REFRESH` / 其他直接调用 `refreshAccountCaches()` 的路径。
4. 因此，本次不引入新的 positions 事实副本；而是要求所有权威 writer 在提交 `lastState.cachedPositions` 后显式调用 `QuoteSubscriptionRuntime.reconcilePositionHoldFromCurrentTruth()`。

## 4.4 连续交易门禁变化端口

`AutoSearchWakeupRuntime` 需要一个显式 gate-open producer，不能只在文档里声明 `GATE_OPEN` wakeup 类型却没有事实来源。

新增最小端口：

```ts
interface TradingGateStatePort {
  onGateStateChanged: (listener: (event: TradingGateStateChangedEvent) => void) => Unsubscribe;
}
```

事件载荷建议：

```ts
type TradingGateStateChangedEvent = Readonly<{
  previousCanTrade: boolean | null;
  nextCanTrade: boolean;
  timestampMs: number;
}>;
```

生产者约束：

1. 该事件由现有系统级时间控制平面产生，最短路径实现是复用当前 `mainProgram`/gate 计算在 `lastState.canTrade` 变化时发射。
2. `AutoSearchWakeupRuntime` 只消费从 `false/null -> true` 的转换来触发 `GATE_OPEN`。
3. 这不是回退轮询；时间真相仍由现有时间控制平面维护，只是把 gate-open 显式事件化。

## 4.5 非周期自动寻标的 wakeup 类型

`AutoSearchWakeupRuntime` 需要显式 wakeup 类型：

```ts
type AutoSearchWakeup =
  | { kind: 'SEAT_EMPTY' }
  | { kind: 'GATE_OPEN' }
  | { kind: 'SEARCH_COOLDOWN_TIMER'; atMs: number }
  | { kind: 'OPEN_DELAY_TIMER'; atMs: number };
```

补充语义：

1. `SeatStateChanged(-> EMPTY)` 只是候选 wakeup，不等价于“立即寻标”；是否立刻执行仍由 `freeze / cooldown / open delay / gate` 统一判定。
2. `SEAT_REFRESH` 或其他激活失败把 seat 写回 `EMPTY` 时，不得清空自动寻标冷却边界；至少要保留 `lastSearchAt` 或等价的“下一次允许寻标时点”。
3. 激活失败回空不增加 `searchFailCountToday`，但也不允许绕过既有冷却语义形成即时重搜循环。
4. `GATE_OPEN` 必须来自上节定义的显式 gate-state producer，不能靠 runtime 自己猜测或靠隐藏扫描补发。
5. bootstrap/open rebuild 结束后的 `EMPTY` seat 接管，由 `AutoSearchWakeupRuntime.start()` 时的 seed 行为一次性完成；不再额外定义独立的 `REBUILD_READY` producer。

约束：

1. 这些 wakeup 是显式事件，不构成回退轮询。
2. runtime 只在 wakeup 到达时重新评估，不做每秒扫。

---

## 5. 目标链路设计

## 5.1 空席位自动寻标链路

目标：

1. 运行时 seat 进入 `EMPTY` 后立即由事件 owner 接管。
2. 冷却未到时只登记 one-shot timer。
3. 早盘延迟窗口内只登记 one-shot timer。
4. 满足条件即直接执行寻标。

目标链路：

```text
SeatStateChanged(-> EMPTY)
  -> AutoSearchWakeupRuntime
     -> 校验 autoSearchEnabled / gate / freeze / cooldown / open delay
     -> 若未到时点，登记 SEARCH_COOLDOWN_TIMER / OPEN_DELAY_TIMER
     -> 若可执行，调用 autoSymbolManager.maybeSearchOnEvent(...)
        -> 成功时写 seat=ACTIVATING
        -> 寻标失败时写回 EMPTY 并更新 failCount/freeze
```

必要改造：

1. `createAutoSearch(...)` 新增 `maybeSearchOnEvent(...)`，替代运行时 `maybeSearchOnTick(...)` 成为空席位寻标唯一业务入口。
2. `AUTO_SYMBOL_TICK` 中删除 `maybeSearchOnTick(...)` 调用。
3. `AutoSearchWakeupRuntime` 只负责唤醒和条件判定，不复制 auto-search 业务规则。
4. `SEAT_REFRESH` 失败写回 `EMPTY` 时，必须保留 auto-search cooldown 边界，禁止写出 `lastSearchAt = null` 且可立即重搜的空席位。

关键约束：

1. `maybeSearchOnEvent(...)` 必须与现有运行时 `maybeSearchOnTick(...)` 业务语义完全一致。
2. 成功时仍然把 seat 写成 `ACTIVATING`，不直接越过 `SEAT_REFRESH`。
3. startup/open rebuild 阶段的同步恢复寻标仍保留在 lifecycle/bootstrap 流程中，只抽取共享的纯寻标决策逻辑，不把 bootstrap owner 迁给 `AutoSearchWakeupRuntime`。

## 5.2 距离换标入口链路

目标链路保持现有方向，仅固定边界：

```text
monitorSymbol quote push
  -> MonitorQuoteEventRuntime
     -> waitForFresh + gate 校验
     -> autoSymbolManager.startSwitchOnDistance(...)
     -> 若 WAIT，handoffPendingSwitch(...)
```

必要改造：

1. `AUTO_SYMBOL_TICK` 中彻底移除距离换标入口。
2. 不允许再由 `processMonitor` 间接调度任何 `AUTO_SYMBOL_SWITCH_DISTANCE` 类任务。

## 5.3 pending switch 推进链路

目标链路保持现有方向，并新增订阅保留联动：

```text
WAIT(old/new symbol quote | order event | freshness | retry timer)
  -> SwitchWakeupRuntime
     -> 重新读取 seat / positions / pending orders
     -> advancePendingSwitch(...)
     -> 重建 wakeups
     -> 同步增删 SWITCH_WAKEUP retain reasons
```

约束：

1. 旧 owner 不得继续推进已经 handoff 的 pending switch。
2. `SwitchWakeupRuntime` 只负责推进，不负责订阅 API 调用。
3. 旧/new symbol quote 保留需求必须通过 `QuoteSubscriptionRuntime` 表达。
4. route 被删除、seatVersion 失效、runtime stopAndDrain 时，`SwitchWakeupRuntime` 持有的 `SWITCH_WAKEUP` retain 必须同步清空。

## 5.4 `ACTIVATING -> SEAT_REFRESH -> ACTIVE` 链路

目标链路：

```text
SeatActivationDispatcher.start() seedCurrentActivatingSeats / SeatStateChanged(-> ACTIVATING)
  -> SeatActivationDispatcher
     -> 立即 scheduleLatest(SEAT_REFRESH)
        -> handleSeatRefresh(...)
           -> acquireSeatRefreshRetain(nextSymbol, optional previousSymbol)
           -> waitUntilQuoteAdmissionReady(nextSymbol, optional previousSymbol)
           -> refresh orders/account/risk
           -> finally releaseSeatRefreshRetain(nextSymbol, optional previousSymbol)
           -> 成功后 seat=ACTIVE
           -> 失败后 seat=EMPTY
```

必要改造：

1. 删除 `processMonitor -> syncSeatState` 观察 `ACTIVATING` 再触发 `SEAT_REFRESH` 的逻辑。
2. 保留 `SEAT_REFRESH` 作为激活屏障的业务语义，但移除其内部 `subscribe/unsubscribe` owner 身份。
3. `SeatActivationDispatcher` 只在 seat 进入 `ACTIVATING` 或 symbol 变化时触发，不做重复触发。
4. `SeatActivationDispatcher.start()` 必须在 `QuoteSubscriptionRuntime` 首轮 `reconcileFromCurrentTruth()` 完成后执行。
5. `SeatActivationDispatcher.start()` 时要对当前仍为 `ACTIVATING` 的 seat 做一次 seed，确保 rebuild 结束时已存在的激活态不会丢失。
6. startup/open rebuild 期间 `SeatActivationDispatcher` 保持关闭；bootstrap 过程中的 seat 变化不由它补消费。
7. 若 `SEAT_REFRESH` 仍会读取 `previousSymbol` quote 清理旧订单记录，则 refresh 开始前必须显式申请 `SEAT_REFRESH_WAIT(previousSymbol)`；不能仅等待 `nextSymbol` admission。
8. `SEAT_REFRESH_WAIT` 的释放必须放在 `finally` 语义中；即使 refresh 中途报错、seat snapshot 失效、或 lifecycle 停机中断，也不能残留 retain。

关键收益：

1. 自动寻标成功与距离换标完成共享同一条激活链路。
2. 激活链路从主循环中完全脱离。
3. `QuoteSubscriptionRuntime` 与 `SEAT_REFRESH` 的 owner 边界不再冲突。

## 5.5 订阅集合维护链路

目标链路：

```text
startup/open rebuild completed
  -> QuoteSubscriptionRuntime.reconcileFromCurrentTruth()
     -> 注入 MONITOR_BASE retain reasons
     -> 从当前 seat / order-hold / cachedPositions / runtime retain 全量投影 retain set
     -> 计算 added / removed
     -> subscribeSymbols(added)
     -> unsubscribeSymbols(removed)
     -> 写回 lastState.allTradingSymbols

SeatChanged / OrderHoldChanged / PositionHoldReconcile / SwitchWakeupChanged / SeatRefreshRetainChanged
  -> QuoteSubscriptionRuntime
     -> 按当前权威真相重投影对应 retain reasons
     -> 计算 added / removed
     -> subscribeSymbols(added)
     -> unsubscribeSymbols(removed)
     -> 写回 lastState.allTradingSymbols
```

关键规则：

1. `monitorSymbol` 的 `MONITOR_BASE` retain reason 在 runtime start 后始终存在。
2. seat 处于 `SWITCHING` / `ACTIVATING` / `ACTIVE` 时，对应 seat symbol 必须有 `SEAT_BOUND` retain。
3. `POSITION_HOLD` 必须在每次权威 `cachedPositions` 写入后重投影；`onFreshReached(...)` 只是其中一条 producer，不是唯一 producer。
4. `ORDER_HOLD` 只来自 `OrderHoldRegistry` 事件。
5. `SWITCH_WAKEUP` / `STATIC_LIQUIDATION_WAIT` 由对应 runtime 显式注册和释放。
6. `SEAT_REFRESH_WAIT` 由 `SEAT_REFRESH` 激活屏障显式注册和释放，至少覆盖 `nextSymbol`，以及 refresh 仍会读取的 `previousSymbol`。
7. runtime-owned retain 在 owner 路由删除、任务结束、异常失败、stopAndDrain 时必须同步清空，不能把“释放”寄希望于后续别的事件。
8. startup/open rebuild 成功后必须先执行一次 `reconcileFromCurrentTruth()`；在这一步完成前，不允许把增量事件作为运行态真相来源。
9. `admission-ready` 的精确定义是：`QuoteSubscriptionRuntime` 已完成本次 retain 变更导致的 `subscribeSymbols(...)` mutation，且目标 symbol 已进入 runtime 自己的 subscribed committed set。
10. `admission-ready` 不等待第一笔 realtime quote push；`SEAT_REFRESH` 后续若拿到 `null` quote，继续沿用现有业务语义处理，而不是把 admission 语义偷换成“行情已 warm”。

明确禁止：

1. 不允许主循环再以全量扫描结果覆写 `allTradingSymbols`。
2. 不允许 seat refresh、switch wakeup runtime 各自直接操作 subscribe/unsubscribe。
3. 不允许定义一个没有 producer 的 `StartupRebuildLoaded` 幽灵事件来兜底首轮投影；startup/open rebuild 的首轮投影必须由 lifecycle 显式调用。
4. 若激活链路需要在 `getQuotes(...)` 前确保 symbol 已接入，必须通过 `QuoteSubscriptionRuntime` 暴露的 admission-ready 协议完成，不能绕过 owner 直接订阅。

---

## 6. lifecycle / startup / cleanup 顺序

## 6.1 startup 成功路径

固定顺序：

1. 创建 `postGateRuntime`。
2. 加载 startup snapshot，得到初始 orders / positions / seats / quotes。
3. 执行 `rebuildTradingDayState(...)`。
4. `postTradeConsistencyRuntime.start()`。
5. `postTradeConsistencyRuntime.completeRebuildBaseline()`。
6. `await QuoteSubscriptionRuntime.reconcileFromCurrentTruth()`。
7. 启动 `QuoteSubscriptionRuntime`。
8. 启动 `SeatActivationDispatcher`，并 seed 当前仍为 `ACTIVATING` 的 seat。
9. 启动 `AutoSearchWakeupRuntime`，并只接管当前仍为 `EMPTY` 的 seat。
10. 启动 `tradingRiskEventRuntime` / `monitorQuoteEventRuntime` / `switchWakeupRuntime`。
11. 启动 `monitorTaskProcessor` / `buyProcessor` / `sellProcessor` / `trader.startOrderMonitorRuntime()`。

约束：

1. `QuoteSubscriptionRuntime` 的首轮 `reconcileFromCurrentTruth()` 必须在 runtime 快照恢复完成后执行，且必须先于 `SeatActivationDispatcher` / `AutoSearchWakeupRuntime`。
2. `SeatActivationDispatcher.start()` 必须在 `QuoteSubscriptionRuntime` 完成首轮投影后执行，且只接管 bootstrap 结束时仍处于 `ACTIVATING` 的 seat。
3. `AutoSearchWakeupRuntime.start()` 必须在 rebuild baseline 完成且 `QuoteSubscriptionRuntime` 完成首轮投影后启动，且只接管 bootstrap 结束时仍处于 `EMPTY` 的 seat，不能重复覆盖 startup 同步恢复寻标。

## 6.2 startupRebuildPending 路径

约束：

1. 若 startup snapshot 失败并进入 `startupRebuildPending`，新增 runtimes 均不得提前启动。
2. 只有后续 lifecycle open rebuild 成功后，才允许统一启动。
3. startup/open rebuild 期间同步恢复席位与同步恢复寻标仍由 lifecycle/bootstrap 流程负责，不由 `AutoSearchWakeupRuntime` 代行。

## 6.3 午夜清理顺序

固定顺序：

1. `postTradeConsistencyRuntime.abortWaiting()`
2. 停 `tradingRiskEventRuntime`
3. 停 `monitorQuoteEventRuntime`
4. 停 `switchWakeupRuntime`
5. 停 `AutoSearchWakeupRuntime`
6. 停 `SeatActivationDispatcher`
7. 停各 processor 与 `trader.stopOrderMonitorRuntimeAndDrain()`
8. 停 `QuoteSubscriptionRuntime`
9. 停 `postTradeConsistencyRuntime`
10. 清队列、取消延迟验证、清指标缓存
11. 进入 marketData / seat / order / risk / global 各 domain 清理

关键约束：

1. 先停会继续制造 seat/order/wakeup 变化的 event owners，再清事实缓存。
2. `QuoteSubscriptionRuntime` 必须存活到 `SEAT_REFRESH` / order-monitor 等在途任务排空之后，避免 admission 等待中的任务在 drain 期间失去 owner。
3. 不允许在 stopAndDrain 里顺手重建或重算 retain reasons。

## 6.4 开盘重建顺序

固定顺序：

1. `globalStateDomain.openRebuild()` 先完成 `executeTradingDayOpenRebuild(...)`
2. 之后 `signalRuntimeDomain.openRebuild()` 启动各 runtime
3. 启动顺序与 startup 成功路径一致：
   - post-trade baseline
   - quote subscription 首轮全量投影与启动
   - seat activation seed / auto-search seed
   - trading risk / monitor quote / switch wakeup
   - processors / order monitor runtime

---

## 7. 详细实施步骤

## Phase 1: 锁定周期换标唯一时间 owner

- [ ] 把 `AUTO_SYMBOL_TICK` 语义收敛为“仅负责周期换标检查”
- [ ] 删除 `handleAutoSymbolTick(...)` 中对 `maybeSearchOnTick(...)` 的调用
- [ ] 为“周期换标仍可正常推进、非周期链路不再由 tick 触发”补齐测试

涉及文件：

- `src/main/processMonitor/autoSymbolTasks.ts`
- `src/main/asyncProgram/monitorTaskProcessor/handlers/autoSymbol.ts`
- `src/services/autoSymbolManager/index.ts`
- `tests/main/asyncProgram/monitorTaskProcessor/**`
- `tests/services/autoSymbolManager/**`

## Phase 2: 为 `SymbolRegistry` 建立 seat change event port

- [ ] 给 `SymbolRegistry` 扩展 `onSeatStateChanged(...)`
- [ ] 由 `createSymbolRegistry(...)` 统一实现事件发射
- [ ] 保证所有 seat state 更新都通过同一端口发事件
- [ ] 补齐版本 bump 与 state 变化的测试

涉及文件：

- `src/types/seat.ts`
- `src/services/autoSymbolManager/utils.ts`
- `tests/services/autoSymbolManager/**`

## Phase 3: 新增 `AutoSearchWakeupRuntime`

- [ ] 新增 runtime 模块与类型定义
- [ ] 为 `EMPTY` seat 建 route key：`monitorSymbol + direction + seatVersion`
- [ ] 接入 runtime seat empty / gate open / cooldown timer / open delay timer 四类 wakeup，并在 runtime.start() 时 seed 当前 `EMPTY` seat
- [ ] 为 `GATE_OPEN` 接入显式 gate-state producer，禁止用隐藏扫描补发
- [ ] 在 runtime 中调用新的 `autoSymbolManager.maybeSearchOnEvent(...)`
- [ ] 删除旧运行时 `maybeSearchOnTick(...)` 业务入口或仅保留为内部兼容别名后立即移除
- [ ] 保持 startup/open rebuild 同步恢复寻标语义不变，仅抽取共享决策逻辑

涉及文件：

- `src/main/autoSearchWakeupRuntime/index.ts` 或同级命名模块
- `src/services/autoSymbolManager/autoSearch.ts`
- `src/services/autoSymbolManager/types.ts`
- `src/services/autoSymbolManager/index.ts`
- `tests/services/autoSymbolManager/**`
- `tests/main/autoSearchWakeupRuntime/**`

## Phase 4: 把 `SEAT_REFRESH` producer 从主循环迁到 seat event

- [ ] 新增 `SeatActivationDispatcher`
- [ ] 监听 `SeatStateChangedEvent`
- [ ] 当 seat 进入 `ACTIVATING` 时立即 `scheduleLatest(SEAT_REFRESH)`
- [ ] `SeatActivationDispatcher.start()` 时 seed 当前仍为 `ACTIVATING` 的 seat，避免 rebuild 结束后的首个激活态丢失
- [ ] `SeatActivationDispatcher` 只在 lifecycle 允许后启动，startup/open rebuild 期间保持关闭
- [ ] 让 `SEAT_REFRESH` 在执行前通过 `QuoteSubscriptionRuntime` 等待所需 symbol 的 quote admission 完成
- [ ] 若 `SEAT_REFRESH` 仍读取 `previousSymbol` quote，则在 refresh 前显式注册并在结束后释放 `SEAT_REFRESH_WAIT`
- [ ] `SEAT_REFRESH_WAIT` 释放采用 `finally` 语义，异常/跳过/停机中断都不允许残留 retain
- [ ] 调整 `SEAT_REFRESH` 失败回 `EMPTY` 的写回语义，保留 auto-search cooldown 边界，禁止零冷却即时重搜
- [ ] 删除 `syncSeatState(...)` 中调度 `SEAT_REFRESH` 的逻辑
- [ ] 保留 `handleSeatRefresh(...)` 作为激活屏障的业务语义，但移除其直接订阅 owner

涉及文件：

- `src/main/processMonitor/seatSync.ts`
- `src/main/asyncProgram/monitorTaskProcessor/handlers/seatRefresh.ts`
- `src/app/runtime/createAsyncRuntime.ts`
- `tests/main/processMonitor/**`
- `tests/main/asyncProgram/monitorTaskProcessor/**`

## Phase 5: 新增 `QuoteSubscriptionRuntime`

- [ ] 新增 retain reason 类型与 runtime store
- [ ] 将 `MONITOR_BASE` 在 `reconcileFromCurrentTruth()` 中与其他 retain reason 一起投影
- [ ] 新增 `reconcileFromCurrentTruth()`，供 startup/open rebuild 成功后显式调用
- [ ] 接入 seat change 事件，投影 `SEAT_BOUND`
- [ ] 接入 order-hold change 事件，投影 `ORDER_HOLD`
- [ ] 接入 freshness reached 事件，以及所有直接刷新 `cachedPositions` 的 writer hook，投影 `POSITION_HOLD`
- [ ] 接入 switch/static-liquidation runtime retain 注册，投影 `SWITCH_WAKEUP` / `STATIC_LIQUIDATION_WAIT`
- [ ] 接入 `SEAT_REFRESH_WAIT` retain 注册，覆盖 refresh 期间临时需要保留订阅的 symbol
- [ ] 约束所有 runtime-owned retain 在 route 删除、任务结束、异常失败、stopAndDrain 时同步清空
- [ ] 成为唯一的 `subscribeSymbols(...)` / `unsubscribeSymbols(...)` owner
- [ ] 向 `SEAT_REFRESH` 暴露 quote admission ready 协议，定义为“订阅 mutation 已提交且 symbol 已进入 runtime committed set”
- [ ] 明确 admission-ready 不等待第一笔 quote push，避免把安静行情误当成未接入
- [ ] 删除 `mainProgram` 中的订阅集合 diff 逻辑

涉及文件：

- `src/main/quoteSubscriptionRuntime/index.ts` 或同级命名模块
- `src/main/utils.ts`
- `src/main/mainProgram/index.ts`
- `src/main/asyncProgram/monitorTaskProcessor/helpers/refreshHelpers.ts`
- `src/types/state.ts`
- `src/core/trader/orderHoldRegistry.ts`
- `src/core/trader/index.ts`
- `src/types/services.ts`
- `tests/main/quoteSubscriptionRuntime/**`
- `tests/integration/**`

## Phase 6: 把非周期寻标与 seat 激活接入 lifecycle / cleanup

- [ ] 在 `createPostGateRuntime(...)` 中创建 `AutoSearchWakeupRuntime`、`QuoteSubscriptionRuntime` 与 `SeatActivationDispatcher`
- [ ] 在 `runApp.ts` startup 成功路径中接线启动
- [ ] 在 `runApp.ts` / lifecycle open rebuild 中先 `await QuoteSubscriptionRuntime.reconcileFromCurrentTruth()`，再启动 dispatcher / auto-search / 其他 runtimes
- [ ] 在 `signalRuntimeDomain` 中补齐 stop/start 顺序
- [ ] 在 `createCleanup(...)` 中补齐停机顺序
- [ ] 确保 `startupRebuildPending` 时不提前启动

涉及文件：

- `src/app/runtime/createPostGateRuntime.ts`
- `src/app/runApp.ts`
- `src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts`
- `src/app/createCleanup.ts`
- `src/app/types.ts`
- `tests/app/**`
- `tests/main/lifecycle/**`

## Phase 7: 移除旧轮询入口并完成全链路回归

- [ ] 删除主循环对运行时订阅集合维护的剩余逻辑
- [ ] 删除 `AUTO_SYMBOL_TICK` 对自动寻标的剩余依赖
- [ ] 删除 `syncSeatState(...)` 对 `SEAT_REFRESH` 的剩余 producer 逻辑
- [ ] 运行 lint / type-check / 相关业务测试 / 集成测试

涉及文件：

- `src/main/mainProgram/index.ts`
- `src/main/processMonitor/autoSymbolTasks.ts`
- `src/main/processMonitor/seatSync.ts`
- `tests/integration/**`

---

## 8. 验证矩阵

## 8.1 空席位自动寻标

1. 运行时 seat 进入 `EMPTY` 后，不依赖主循环即可触发寻标。
2. 冷却未到时，仅注册 timer，不做循环重试。
3. 早盘延迟窗口内不寻标，延迟结束后由 timer 唤醒。
4. 连续交易门禁重新打开时，已有 `EMPTY` seat 会收到显式 `GATE_OPEN` wakeup，不依赖主循环补扫。
5. 寻标失败后正确累计失败次数并冻结。
6. 寻标成功后 seat 进入 `ACTIVATING`，并立即触发 `SEAT_REFRESH`。
7. startup/open rebuild 阶段仍保持同步恢复寻标语义；runtime 只接管遗留 `EMPTY` seat 的后续 wakeup。
8. `SEAT_REFRESH` 失败回 `EMPTY` 后不会立刻零冷却重搜，只会按既有 cooldown 语义登记后续 wakeup。

## 8.2 距离换标

1. 入口只由 monitor quote 触发。
2. handoff 后只由 `SwitchWakeupRuntime` 推进。
3. old/new symbol quote retain reason 正确注册与释放。
4. 候选与当前标的一致时，只记录抑制，不错误启动。
5. 周期 pending 已存在时，距离换标仍可按现有语义接管。

## 8.3 seat 激活

1. 自动寻标成功进入 `ACTIVATING` 后立即入队 `SEAT_REFRESH`。
2. 距离换标完成进入 `ACTIVATING` 后立即入队 `SEAT_REFRESH`。
3. `SEAT_REFRESH` 成功后 seat 进入 `ACTIVE`。
4. `SEAT_REFRESH` 失败后 seat 回 `EMPTY`，旧任务被正确隔离。
5. startup/open rebuild 完成时已经处于 `ACTIVATING` 的 seat，会被 `SeatActivationDispatcher` seed 到激活链路，不会丢首个刷新。
6. 若 refresh 仍会读取 `previousSymbol`，则该 symbol 在 refresh 完成前不会被提前退订。

## 8.4 订阅集合维护

1. monitor symbol 始终保留基础订阅。
2. `SWITCHING` / `ACTIVATING` / `ACTIVE` seat symbol 均被正确保留订阅。
3. 持仓 symbol 在 freshness 追平后被正确保留订阅。
4. 由 `SEAT_REFRESH` / `refreshAccountCaches()` 等直接刷新出来的持仓变化，也会触发 `POSITION_HOLD` 重投影。
5. 未完成订单 hold symbol 被正确保留订阅。
6. switch/static-liquidation wait symbol 在等待期间被正确保留订阅。
7. `SEAT_REFRESH_WAIT` symbol 在激活屏障期间被正确保留订阅。
8. `SEAT_REFRESH` 异常失败、任务跳过或 lifecycle stopAndDrain 后，不会残留 `SEAT_REFRESH_WAIT` retain。
9. `SWITCH_WAKEUP` / `STATIC_LIQUIDATION_WAIT` 在 route 删除、版本失效或 runtime stopAndDrain 后会被正确释放。
10. 所有 retain reasons 清空后 symbol 才退订。
11. 主循环不再覆盖稳态运行期 `allTradingSymbols`。
12. startup/open rebuild 后 `QuoteSubscriptionRuntime.reconcileFromCurrentTruth()` 会先恢复当前 ACTIVE seat、持仓与挂单订阅，再开始消费增量事件。
13. admission-ready 只要求 symbol 已进入 runtime committed set；即使 realtime quote 仍为 `null`，激活链路也不会被错误卡死。

## 8.5 lifecycle / cleanup

1. startupRebuildPending 场景下新增 runtimes 不提前启动。
2. 午夜清理先停 event owners，再清事实缓存。
3. 开盘重建完成后新增 runtimes 正确恢复；`SeatActivationDispatcher` / `AutoSearchWakeupRuntime` 只接管重建结束后仍处于 `ACTIVATING` / `EMPTY` 的席位。
4. stopAndDrain 后旧 timer/旧 wakeup 不会再写回运行态。

---

## 9. 明确拒绝的错误实现

1. **错误实现：** 继续保留 `mainProgram` 中的订阅集合 diff，只是额外新增事件 runtime。  
   **拒绝原因：** 这会形成双 owner，最终逻辑正确性无法证明。

2. **错误实现：** 新增 auto-search runtime，但 `AUTO_SYMBOL_TICK` 仍保留 `maybeSearchOnTick(...)`。  
   **拒绝原因：** 这是最典型的双轨推进。

3. **错误实现：** seat 进入 `ACTIVATING` 后仍等待主循环 `syncSeatState(...)` 观察。  
   **拒绝原因：** 激活链路仍然依赖心跳，重构目标未完成。

4. **错误实现：** `QuoteSubscriptionRuntime` 只负责新增订阅，退订仍交给主循环兜底。  
   **拒绝原因：** 单一 owner 被破坏。

5. **错误实现：** `QuoteSubscriptionRuntime` 被定义成唯一订阅 owner，但 `SEAT_REFRESH` 仍直接调用 `subscribeSymbols(...)`。  
   **拒绝原因：** 这会形成订阅双 owner，且无法证明激活链路的一致性。

6. **错误实现：** 为了保险，在事件没到时每秒再扫 seat/order/position 一次。  
   **拒绝原因：** 这是隐藏轮询兜底，违反本次方案目标。

7. **错误实现：** 在 runtime 中复制 seat/order/position 的事实缓存，后续基于副本做 retain 决策。  
   **拒绝原因：** 会引入第二真相源，无法证明一致性。

8. **错误实现：** 把 startup/open rebuild 的同步恢复寻标整体迁给 `AutoSearchWakeupRuntime`。  
   **拒绝原因：** 这会改变当前 bootstrap 完成时机、早盘延迟跳过语义与失败计数语义，不符合“业务语义不变”。

9. **错误实现：** 把周期换标也一并迁入新的 auto-search runtime。  
   **拒绝原因：** 周期换标的真实触发因子就是时间到期，本方案明确不改。

10. **错误实现：** `SeatActivationDispatcher` 常驻监听 seat event，bootstrap/open rebuild 期间也照常消费。  
    **拒绝原因：** 这会让同步恢复阶段与 runtime producer 重叠，重新引入双 owner 与事件乱序。

11. **错误实现：** `QuoteSubscriptionRuntime` 启动后只等待未来 seat/order/position 事件，不先做首轮全量投影。  
    **拒绝原因：** 当前已恢复的 ACTIVE seat、持仓与挂单会在第一次 diff 中被错误退订。

12. **错误实现：** 把 quote admission 定义为“收到第一笔 realtime push”。  
    **拒绝原因：** 安静行情会把激活链路无故卡死，而且这不是 `getQuotes(...)` 的真实前置条件。

13. **错误实现：** `SEAT_REFRESH` 失败回空时清空 `lastSearchAt`，让 `AutoSearchWakeupRuntime` 立刻再次寻标。  
    **拒绝原因：** 这会把激活失败变成无冷却重试循环，改变原有自动寻标的冷却语义。

14. **错误实现：** 只给 `nextSymbol` 做 admission，就让 `SEAT_REFRESH` 去读取仍未保留订阅的 `previousSymbol`。  
    **拒绝原因：** 当前 `getQuotes(...)` 对未订阅 symbol 会直接报错，这会把激活屏障变成自触发失败链路。

15. **错误实现：** 把 `POSITION_HOLD` 只绑定在 `onFreshReached(...)`，忽略 `refreshAccountCaches()` 等直接写 `cachedPositions` 的路径。  
    **拒绝原因：** 这会让 `QuoteSubscriptionRuntime` 丢失部分真实持仓订阅语义，最终出现漏保留或迟退订。

16. **错误实现：** 定义了 `GATE_OPEN` wakeup，但没有任何 gate-state producer。  
    **拒绝原因：** 这会让休市前已是 `EMPTY` 的 seat 在开市后没有唤醒源，自动寻标链路无法闭环。

17. **错误实现：** `SEAT_REFRESH_WAIT` / `SWITCH_WAKEUP` 等 retain 只在成功路径释放，异常或 stopAndDrain 时不释放。  
    **拒绝原因：** 这会制造隐性订阅泄漏，破坏 quote owner 的可证明收敛性。

---

## 10. 最终结论

本方案的最终目标不是把整个系统改成“无主循环的纯事件驱动程序”，而是把**非周期自动换标域**从主循环中完整切走，形成正确的 owner 边界：

1. 周期换标保留为唯一时间驱动的 auto-symbol 业务链路。
2. 空席位自动寻标、距离换标、seat 激活、订阅集合维护全部改为事件 owner。
3. `mainProgram` 不再负责自动换标域的非周期推进，也不再负责订阅集合收敛。
4. 不引入任何兼容式兜底或回退逻辑。

只要按本方案落地，系统就能在不改变业务语义的前提下，实现以下结果：

1. 非周期自动换标域彻底脱离主循环轮询推进。
2. 订阅切换与激活链路响应更及时，owner 更清晰。
3. lifecycle、post-trade consistency、order monitor 与自动换标之间的边界更加稳定。
4. 最终架构符合“优先事件驱动设计、最短路径实现、无兼容兜底、全链路逻辑可验证”的要求。
