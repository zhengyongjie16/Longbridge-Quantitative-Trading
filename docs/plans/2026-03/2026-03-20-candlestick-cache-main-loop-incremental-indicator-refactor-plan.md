# Candlestick Cache + Main Loop Incremental Indicator Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 `setOnCandlestick` 将实时 K 线写入应用层本地缓存，主循环继续按 1 秒节拍读取该缓存推进指标与信号计算，并把当前“整批 K 线全量重算”重构为“未收线增量更新 + 收线后整体移位”的指标计算模型，同时不改变延迟验证与主循环业务门禁语义。

**Architecture:** K 线链路改为“订阅初始种子 + push 更新本地缓存 + 主循环每秒消费缓存”。`indicatorCache` 继续保持按主循环采样时间每秒写入的语义，延迟验证仍按 T0/T0+5s/T0+10s 的真实时间轴取样，不改为 K 线时间轴。增量指标计算采用“bootstrap 一次全量建立稳定状态，运行期纯增量推进”的单一路径，不保留运行期全量/增量双轨。

**Tech Stack:** TypeScript, Bun test, Longbridge Node.js SDK (`setOnCandlestick`, `subscribeCandlesticks`), 现有 main loop / delayedSignalVerifier / indicatorCache / indicator runtime.

---

## 0. 二次复核结论

本次方案二次复核后，结论为**逻辑正确、可以实施**，但实现时必须严格满足以下硬约束：

### 0.1 最高验收门禁：增量结果必须与当前全量结果一致

本次重构的最高优先级门禁不是“跑得更快”，而是：

> **重构后的增量计算结果，必须与当前仓库中的全量计算结果保持一致。**

这里的“一致”是指：

1. 对同一份 K 线输入序列，在同一个处理时刻：
   - 旧实现的全量 `buildIndicatorSnapshot(...)`
   - 新实现的 `bootstrap + 增量推进 + buildSnapshotFromRuntime(...)`
   输出的 `IndicatorSnapshot` 必须一致。
2. 不仅最终一拍要一致，运行过程中的每一拍也必须一致，包括：
   - bootstrap 初始拍
   - 同一活动 bar 的连续未收线更新
   - `isConfirmed=false -> true` 的收线确认
   - `confirmed + next bar` 在同一主循环间隔内同时发生
   - version 未变化时的复用拍
3. 一致性检查覆盖的字段包括：
   - `price`
   - `changePercent`
   - `ema`
   - `rsi`
   - `psy`
   - `mfi`
   - `kdj`
   - `macd`
   - `adx`
4. 对当前实现已做 round 的指标（如 RSI / MFI / ADX），必须与当前 round 后结果完全一致。
5. 对当前实现未做 round 的指标（如 EMA / PSY / MACD / KDJ），目标同样是完全一致；若出现极个别 JS 浮点表示层面的末位差异，不允许直接放宽，必须先定位原因并确认是否为实现偏差。
6. **在没有通过严格对拍测试前，不允许宣称本次重构完成。**
7. **如果某个指标无法证明与当前全量实现一致，则该指标的增量重构不算完成；整个方案也不算完成。**

因此，本次实施的正确流程是：

1. 保留当前全量实现作为 oracle / 对拍基准。
2. 新增增量实现。
3. 对同一输入序列做逐拍对拍。
4. 只有全部通过后，才允许移除运行期对旧全量路径的依赖并宣告交付。

1. **主循环仍然是业务推进时钟**：生命周期、交易门禁、末日保护、自动换标、风险任务、订单监控与成交后刷新都继续由主循环/现有异步处理器驱动，不能把指标与信号推进改成新的事件直驱业务总线。
2. **`setOnCandlestick` 只负责更新本地 K 线缓存**：不在 push 回调中直接做指标计算、信号生成或 `indicatorCache.push(...)`。主循环每秒消费缓存，本身就相当于 1 秒节流。
3. **`indicatorCache` 必须保持“每秒采样”语义**：即使本秒 K 线缓存没有变化，也要继续把 `lastMonitorSnapshot` 按当前采样时间写入 `indicatorCache`，避免延迟验证出现时间序列空窗。
4. **`indicatorCache` 的时间戳不能改成 K 线 `timestamp`**：延迟验证依赖的是触发时刻之后的真实时间轴，而不是 bar 所属时间轴。K 线时间只能用于识别活动 bar、确认收线和日志展示。
5. **K 线本地缓存必须记录 `isConfirmed` 的最后状态**：仅存 candles 数组不够。若同一根 bar 在主循环两拍之间发生 `false -> true` 变化，而下一根 bar 尚未 append，主循环必须能识别“同 timestamp 的收线确认”。
6. **运行期只能有一套指标推进语义**：允许 bootstrap 阶段从完整 candles 建立一次稳定状态；bootstrap 之后必须只走增量推进，不允许运行时继续随机回退到整批全量重算。
7. **必须覆盖“confirmed 与下一根新 bar 在同一秒内都到达”的场景**：主循环下一拍只看到最终缓存快照时，仍需通过“timestamp 前进 + confirmed 状态”正确推导出移位与新活动 bar 初始化。

---

## 1. 文件结构与职责落点

### 新增文件

- Create: `src/services/quoteClient/candlestickCache.ts`
  - 职责：维护单 symbol + period 的本地 K 线缓存，处理初始种子、push 更新、append / replace / ignore-old-event 规则，并输出只读快照。
- Create: `tests/services/indicators/runtime/incremental.business.test.ts`
  - 职责：对拍 bootstrap + 增量推进 vs 旧全量计算的结果一致性，覆盖未收线更新、收线确认、同秒跨 bar 等核心场景。

### 重点修改文件

- Modify: `src/services/quoteClient/types.ts`
  - 增加 `setOnCandlestick`、push event 类型、K 线缓存快照类型。
- Modify: `src/services/quoteClient/index.ts`
  - 注册 `setOnCandlestick`，在 `subscribeCandlesticks()` 完成初始种子化，暴露读取本地 K 线缓存的接口，并在 reset 时按退订成功范围清空缓存。
- Modify: `src/types/services.ts`
  - 为 `MarketDataClient` 增加 K 线缓存读取接口，保留现有订阅接口。
- Modify: `src/types/state.ts`
  - 为 `MonitorState` 增加缓存版本与增量运行态字段。
- Modify: `src/utils/helpers/index.ts`
  - 更新 `initMonitorState(...)`，初始化新增的 K 线缓存版本与增量运行态字段。
- Modify: `src/main/processMonitor/indicatorPipeline.ts`
  - 改为从本地 K 线缓存读取，不再每秒调用 `getRealtimeCandlesticks()`；无变化时复用 snapshot，但继续每秒 push `indicatorCache`。
- Modify: `src/services/indicators/runtime/index.ts`
  - 新增 bootstrap / active-update / confirmed-shift / snapshot-build 的主入口。
- Modify: `src/services/indicators/runtime/types.ts`
  - 定义增量运行态：闭合状态、活动 bar 状态、各指标子状态。
- Modify: `src/services/indicators/runtime/{ema,rsi,psy,mfi,kdj,macd,adx}.ts`
  - 暴露各指标的 bootstrap 与增量推进辅助函数；已有流式状态类型优先复用，不重复造轮子。
- Modify: `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts`
  - 确认 K 线订阅后本地缓存已被种子化；测试中明确覆盖。
- Modify: `src/main/lifecycle/cacheDomains/marketDataDomain.ts`
  - 依赖 `resetRuntimeSubscriptionsAndCaches()` 间接清空本地 K 线缓存；测试需覆盖。
- Modify: `src/main/lifecycle/cacheDomains/globalStateDomain.ts`
  - 午夜清理时重置新增的 `lastCandlestickCacheVersion` 与 `incrementalIndicatorRuntime`，避免跨日复用旧运行态。
- Modify: `tests/helpers/testDoubles.ts`
  - 为 `MonitorState` 默认构造补齐新增字段，避免测试误用旧结构。

### 主要测试文件

- Test: `tests/services/quoteClient/business.test.ts`
- Test: `tests/main/processMonitor/indicatorPipeline.business.test.ts`
- Test: `tests/services/indicators/runtime/index.business.test.ts`
- Test: `tests/services/indicators/runtime/incremental.business.test.ts`
- Test: `tests/main/lifecycle/loadTradingDayRuntimeSnapshot.test.ts`
- Test: `tests/main/lifecycle/cacheDomains/marketDataDomain.test.ts`
- Test: `tests/main/lifecycle/cacheDomains/globalStateDomain.test.ts`
- Test: `tests/main/asyncProgram/delayedSignalVerifier/business.test.ts`
- Test: `tests/chaos/candlestick-websocket-out-of-order.test.ts`

---

## 2. 目标状态定义

### 2.1 K 线数据源模型

重构后 K 线数据源固定为：

1. `subscribeCandlesticks(symbol, period)` 返回的初始 `Candlestick[]` 用于缓存种子化。
2. `setOnCandlestick(...)` 后续只以单条 push event 更新本地缓存。
3. 主循环每秒从 `MarketDataClient` 读取该缓存快照，而不是直接调用 `realtimeCandlesticks()`。
4. `realtimeCandlesticks()` 仅保留为底层能力，不再作为主循环每秒指标计算的直接数据源。

### 2.2 本地缓存快照字段

建议的只读快照至少包含：

```ts
export type CandlestickCacheSnapshot = {
  readonly symbol: string;
  readonly period: Period;
  readonly version: number;
  readonly candles: ReadonlyArray<CandleData>;
  readonly lastEventAt: number;
  readonly lastBarTimestamp: number | null;
  readonly lastBarConfirmed: boolean | null;
  readonly initialized: boolean;
};
```

### 2.3 增量指标运行态字段

建议在 `MonitorState` 中增加：

```ts
incrementalIndicatorRuntime: IndicatorIncrementalRuntime | null;
lastCandlestickCacheVersion: number | null;
```

其中 `IndicatorIncrementalRuntime` 需要能表达：

1. bootstrap 后的稳定闭合状态。
2. 当前活动 bar 的增量推导状态。
3. 上一次处理的 `lastBarTimestamp` 与 `lastBarConfirmed`。
4. 最近一次成功构造出的 `IndicatorSnapshot`。

### 2.4 `indicatorCache` 保持的语义

`indicatorCache` 的 entry 时间戳继续表示：

- **主循环采样写入时间**，不是 K 线 bar 时间。

因此：

1. 主循环本秒如果没有新 K 线，也要把 `lastMonitorSnapshot` 再 push 一次。
2. 延迟验证继续用真实 wall-clock 时间取样，不修改 `performVerification(...)` 的核心口径。

### 2.5 增量指标计算的精确正确性约束

这部分是本方案最容易在实现时出偏差的地方，以下约束必须视为**强约束**，否则即使架构方向正确，也可能得到与当前全量实现不一致的结果。所有约束都服务于 `0.1` 中定义的最高验收门禁。

#### 2.5.1 preview 与 commit 必须严格分离

对于“同一根活动 bar 多次未收线更新”的场景，增量运行态必须区分：

1. **committed / closed state**：只包含已经确认收线的稳定状态。
2. **preview / active state**：在 committed state 基础上，临时套用当前活动 bar 推导出的最新结果。

强约束：

1. preview 不能直接原地改写 committed state。
2. 同一根活动 bar 的第二次、第三次更新，必须始终从同一个 committed state 重新推导，而不是在上一次 preview 结果上继续累加。
3. 只有在 bar 真正 confirmed，或主循环通过 timestamp 前进推导出上一根已完成移位时，才允许把该 bar 的影响写入 committed state。

#### 2.5.2 运行态不能保存对象池快照对象

`lastMonitorSnapshot` / `indicatorCache` 当前会持有带对象池对象的 snapshot（如 `kdj`、`macd`）。新的增量运行态不能把这些 pooled snapshot 对象本身作为长期内部状态保存。

强约束：

1. runtime state 只能保存 primitive / stream state / ring buffer / window data。
2. 每次构造对外 `IndicatorSnapshot` 时，才按当前仓库语义生成新的 snapshot 结构。
3. 不能让 runtime state 指向会被 `releaseSnapshotObjects(...)` 回收的旧 snapshot 内部对象。

#### 2.5.3 `price` 与 `changePercent` 必须保持当前语义

当前 `buildIndicatorSnapshot(...)` 中：

1. `price` 取 **最后一个有效 close**。
2. `changePercent` 取 **最后两个有效 close 的相对变化**。

它**不是**基于 `monitorQuote.prevClose` 计算，也不是日级涨跌幅。

因此增量运行态必须显式保留：

1. 最近一个有效 close。
2. 上一个有效 close。

由此构造：

```ts
price = lastValidClose
changePercent = previousValidClose === null ? null : ((lastValidClose - previousValidClose) / previousValidClose) * 100
```

#### 2.5.4 各指标必须严格复刻当前实现的 seed / rounding / invalid 规则

增量实现不能只做到“数值接近”，必须做到与当前实现口径一致。尤其注意：

1. **EMA**：
   - 仅消费有效正数 close。
   - 不做 round。
2. **RSI**：
   - 使用当前 `RsiStreamState` 的 SMA seed + Wilder 平滑语义。
   - 仅在最终输出时 `roundToFixed2`。
   - 无下跌动量导致非有限值时，最终值按当前实现返回 `100`。
3. **PSY**：
   - 统计的是周期内上涨次数占比。
   - 不做 round。
4. **MACD**：
   - `dif/dea/macd` 都不做 round。
   - 仍保留当前 `validCloseCount >= slowPeriod + signalPeriod` 的门槛。
5. **MFI**：
   - 只把有效 `high/low/close/volume` 纳入有效序列。
   - 最终输出时 `roundToFixed2`。
6. **ADX**：
   - 保持当前 Wilder 平滑门槛。
   - 最终输出时 `roundToFixed2`，不是每步 round。
7. **KDJ**：
   - 必须保留当前实现中对 K/D 平滑的 seed 语义：两条 EMA 流都以 `50` 作为预热输入开始。
   - `J = 3K - 2D`，不做 round。

#### 2.5.5 各指标的最小必要状态不能省略

以下状态属于“实现精确增量语义的最低要求”，如果缺任何一组，就不能宣称该指标已实现与当前全量逻辑等价的增量版本：

1. **EMA(period)**：`seedCount`, `seedSum`, `emaValue`
2. **RSI(period)**：`previousClose`, `seedDiffCount`, `seedUpSum`, `seedDownSum`, `smoothUp`, `smoothDown`, `lastRawValue`
3. **PSY(period)**：`previousClose`, `validCloseCount`, `upFlags`, `windowCount`, `windowIndex`, `upCount`
4. **MACD**：`fastEmaState`, `slowEmaState`, `signalEmaState`, `validCloseCount`, `lastDif`, `lastSignal`, `lastHistogram`
5. **MFI**：`previousTypicalPrice`, `up/down` ring buffer 状态、有效 OHLCV 计数、最近原始值
6. **ADX**：`prevHigh`, `prevLow`, `prevClose`, `trDmCount`, `smoothTr`, `smoothPlusDm`, `smoothMinusDm`, `initialDxSum`, `dxCount`, `adx`
7. **KDJ**：
   - K / D 的平滑状态
   - 生成 RSV 所需的最近窗口高低价数据
   - 不能只保存最后一个 `k/d/j` 值

#### 2.5.6 KDJ / MFI / ADX 不能按“只看最后一根”偷简化

这是本次增量设计里最危险的误区。

1. **KDJ** 需要最新窗口的最高价 / 最低价与 K/D 平滑状态。
2. **MFI** 需要典型价与成交量形成的滚动正负资金流窗口。
3. **ADX** 需要前一根 OHLC 与多步 Wilder 平滑状态。

因此，这三类指标的“增量”不是“只替换最后一个数再算一个公式”，而是“在完整保留必要历史状态的前提下做增量推进”。

#### 2.5.7 若状态不足，必须补状态，不能在运行期偷偷退回全量重算

bootstrap 后的运行期，如果发现某个指标当前状态不足以精确 preview / commit：

1. 正确动作是补齐该指标的 runtime state 设计与测试。
2. 错误动作是把该指标单独放回“version 变化时整批 candles 全量重算”的隐藏分支。

本方案明确禁止第 2 种做法，因为它会让系统重新变成“部分指标增量、部分指标运行期全量”的双轨语义。

---

## 3. 任务拆分

### Task 1: 建立本地 K 线缓存并接入 `setOnCandlestick`

**Files:**
- Create: `src/services/quoteClient/candlestickCache.ts`
- Modify: `src/services/quoteClient/types.ts`
- Modify: `src/services/quoteClient/index.ts:1-708`
- Modify: `src/types/services.ts:48-111`
- Test: `tests/services/quoteClient/business.test.ts`
- Test: `tests/main/lifecycle/loadTradingDayRuntimeSnapshot.test.ts`
- Test: `tests/main/lifecycle/cacheDomains/marketDataDomain.test.ts`

- [ ] **Step 1: Write the failing tests for candlestick cache seed and push updates**

在 `tests/services/quoteClient/business.test.ts` 增加以下场景：

```ts
it('seeds local candlestick cache from subscribeCandlesticks result', async () => {
  // subscribeCandlesticks 返回 200 根初始 candles
  // 调用 getCandlestickSnapshot('BULL.HK', Period.Min_1)
  // 断言 initialized=true, version=1, candles.length=200
});

it('replaces active bar when push timestamp matches current last bar', async () => {
  // 初始最后一根 timestamp = T
  // push 一条同 timestamp 且 isConfirmed=false 的 event
  // 断言 candles.length 不变、最后一根被替换、version 自增
});

it('marks last bar confirmed when same-timestamp confirmed push arrives', async () => {
  // 同 timestamp 的 false -> true
  // 断言 lastBarConfirmed = true
});

it('appends next bar when push timestamp advances', async () => {
  // push 新 timestamp 的 bar
  // 断言长度裁剪到 TRADING.CANDLE_COUNT，最后一根为新 bar
});
```

- [ ] **Step 2: Run quoteClient tests to verify they fail**

Run: `bun test tests/services/quoteClient/business.test.ts`
Expected: FAIL，提示 `MarketDataClient` 缺少 K 线缓存读取接口，或 `QuoteContextLike` 缺少 `setOnCandlestick`，或相关断言失败。

- [ ] **Step 3: Add K 线缓存类型与 `QuoteContextLike` push callback 能力**

在 `src/services/quoteClient/types.ts` 增加：

```ts
export type PushCandlestickLike = Readonly<{
  readonly period: Period;
  readonly candlestick: Candlestick;
  readonly isConfirmed: boolean;
}>;

export type PushCandlestickEventLike = Readonly<{
  readonly symbol: string;
  readonly data: PushCandlestickLike;
}>;
```

并为 `QuoteContextLike` 增加：

```ts
readonly setOnCandlestick: (
  callback: (err: null | Error, event: PushCandlestickEventLike) => void,
) => void;
```

- [ ] **Step 4: Implement `candlestickCache.ts` with immutable snapshot replacement**

实现缓存 helper，至少包含：

```ts
createCandlestickCacheStore()
seedCandlestickSeries(params)
applyCandlestickPush(params)
getCandlestickSnapshot(symbol, period)
clearCandlestickSnapshots()
```

规则必须固定：

1. 同 timestamp：replace 最后一根，并更新 `lastBarConfirmed`。
2. 更大 timestamp：append 新 bar，必要时裁剪最旧 bar。
3. 更小 timestamp：忽略旧事件。
4. 每次有效更新都返回新的只读快照对象，`version += 1`。
5. 对“同 timestamp + `isConfirmed=true` 的重复 push”必须是幂等的：允许缓存版本递增，但不能在后续指标运行态里导致重复 commit / 重复移位。

- [ ] **Step 5: Wire `quoteClient` to seed and update the local candlestick cache**

在 `src/services/quoteClient/index.ts` 中：

1. 初始化本地 K 线缓存 store。
2. 创建 `QuoteContext` 后立即注册 `ctx.setOnCandlestick(...)`。
3. 在 `subscribeCandlesticks(...)` 成功后，把初始 candles 标准化并 seed 到缓存。
4. 在 push callback 中调用 `applyCandlestickPush(...)`。
5. 通过 `MarketDataClient` 暴露读取接口，例如：

```ts
getCandlestickSnapshot(symbol: string, period: Period): CandlestickCacheSnapshot | null
```

- [ ] **Step 6: Ensure runtime reset clears the local candlestick cache with partial-failure-safe semantics**

在 `resetRuntimeSubscriptionsAndCaches()` 路径中，确保：

1. 仅对“成功退订”的 candlestick key 清空本地缓存；退订失败的 key 必须与 `subscribedCandlesticks` 保持一致，避免留下“订阅仍保留但缓存被清空且后续无法重新 seed”的半状态。
2. 若同一 key 因 reset 退订失败而仍处于订阅集合，后续重建路径必须能够重新补种子，不能因为 dedup 直接返回空数组而跳过 seed。
3. 午夜清理测试能观察到：
   - 成功退订的 key 被清空；
   - 失败保留的 key 不会进入错误的空缓存半状态。

- [ ] **Step 7: Run targeted tests for quoteClient and lifecycle wiring**

Run: `bun test tests/services/quoteClient/business.test.ts tests/main/lifecycle/loadTradingDayRuntimeSnapshot.test.ts tests/main/lifecycle/cacheDomains/marketDataDomain.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/services/quoteClient/candlestickCache.ts src/services/quoteClient/types.ts src/services/quoteClient/index.ts src/types/services.ts tests/services/quoteClient/business.test.ts tests/main/lifecycle/loadTradingDayRuntimeSnapshot.test.ts tests/main/lifecycle/cacheDomains/marketDataDomain.test.ts
git commit -m "refactor: cache realtime candlesticks locally"
```

### Task 2: 让主循环从本地 K 线缓存消费，并保持 `indicatorCache` 每秒采样语义

**Files:**
- Modify: `src/types/state.ts:171-208`
- Modify: `src/main/processMonitor/indicatorPipeline.ts:1-212`
- Modify: `src/main/processMonitor/types.ts:100-111`
- Test: `tests/main/processMonitor/indicatorPipeline.business.test.ts`
- Test: `tests/main/processMonitor/index.business.test.ts`
- Test: `tests/main/asyncProgram/delayedSignalVerifier/business.test.ts`

- [ ] **Step 1: Write the failing tests for cache-version-based reuse and per-second cache push**

在 `tests/main/processMonitor/indicatorPipeline.business.test.ts` 增加两个关键场景：

```ts
it('reuses last snapshot when candlestick cache version is unchanged but still pushes indicatorCache once', async () => {
  // version 未变，主循环本秒不重算
  // 但 indicatorCache.push 仍然发生一次
});

it('returns null when local candlestick cache is missing or not initialized', async () => {
  // 缓存不存在 / initialized=false
  // runIndicatorPipeline 返回 null，不 push indicatorCache
});
```

- [ ] **Step 2: Run indicator pipeline tests to verify they fail**

Run: `bun test tests/main/processMonitor/indicatorPipeline.business.test.ts`
Expected: FAIL，提示 `marketDataClient` 尚无 `getCandlestickSnapshot` 依赖，或旧逻辑仍在调用 `getRealtimeCandlesticks()`。

- [ ] **Step 3: Extend `MonitorState` with cache-version and incremental runtime fields**

在 `src/types/state.ts` 的 `MonitorState` 中新增：

```ts
lastCandlestickCacheVersion: number | null;
incrementalIndicatorRuntime: IndicatorIncrementalRuntime | null;
```

并同步更新所有创建 `MonitorState` 的测试 double。

- [ ] **Step 4: Replace direct SDK K 线 reads in `indicatorPipeline` with local cache snapshot reads**

将 `src/main/processMonitor/indicatorPipeline.ts` 中：

```ts
marketDataClient.getRealtimeCandlesticks(...)
```

替换为：

```ts
marketDataClient.getCandlestickSnapshot(monitorSymbol, TRADING.CANDLE_PERIOD)
```

逻辑固定为：

1. 缓存不存在 / 未初始化 / `candles.length === 0` => 返回 `null`。
2. `version === state.lastCandlestickCacheVersion` 且 `state.lastMonitorSnapshot !== null` => 直接复用 snapshot。
3. 复用路径仍然执行：
   - `indicatorCache.push(monitorSymbol, snapshot)`
   - `marketMonitor.monitorIndicatorChanges(...)`
4. 只有 version 变化时才进入增量指标推进。

- [ ] **Step 5: Keep `indicatorCache` sampling on every main-loop tick**

显式保留这一行为，并在代码注释中说明：

```ts
// indicatorCache 继续按主循环采样时间每秒写入，供 delayed verification 按真实时间轴取样。
// 即使本秒 K 线缓存没有变化，也要 push 最近一次 snapshot，不能改成“仅事件时写入”。
```

- [ ] **Step 6: Update delayed-verification tests to assert no sampling gap regression**

在 `tests/main/asyncProgram/delayedSignalVerifier/business.test.ts` 或 `indicatorPipeline` 侧加断言：

1. snapshot 不变的连续两秒，`indicatorCache.push` 仍会发生两次。
2. `performVerification(...)` 的取样逻辑无需改动即可继续工作。

- [ ] **Step 7: Run targeted tests for pipeline and delayed verification**

Run: `bun test tests/main/processMonitor/indicatorPipeline.business.test.ts tests/main/processMonitor/index.business.test.ts tests/main/asyncProgram/delayedSignalVerifier/business.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/types/state.ts src/main/processMonitor/indicatorPipeline.ts src/main/processMonitor/types.ts tests/main/processMonitor/indicatorPipeline.business.test.ts tests/main/processMonitor/index.business.test.ts tests/main/asyncProgram/delayedSignalVerifier/business.test.ts
git commit -m "refactor: consume cached candlesticks in indicator pipeline"
```

### Task 3: 建立增量指标运行态的 bootstrap 语义

> **Task gate:** 这一任务完成的判定标准不是“bootstrap 跑起来”，而是“bootstrap 结果已经能作为旧全量实现的等价基准参与对拍”。若对拍不通过，则本任务不得标记完成。

**Files:**
- Modify: `src/services/indicators/runtime/types.ts:1-72`
- Modify: `src/services/indicators/runtime/index.ts:1-170`
- Modify: `src/services/indicators/runtime/{ema,rsi,psy,mfi,kdj,macd,adx}.ts`
- Test: `tests/services/indicators/runtime/index.business.test.ts`
- Test: `tests/services/indicators/runtime/incremental.business.test.ts`

- [ ] **Step 1: Write the failing tests for bootstrap runtime equivalence**

在 `tests/services/indicators/runtime/incremental.business.test.ts` 先写 bootstrap 对拍：

```ts
it('bootstraps incremental runtime from candles and matches full snapshot', () => {
  const runtime = bootstrapIndicatorRuntime('HSI.HK', candles, profile);
  const snapshotFromRuntime = buildSnapshotFromRuntime(runtime);
  const fullSnapshot = buildIndicatorSnapshot('HSI.HK', candles, profile);
  expect(snapshotFromRuntime).toEqual(fullSnapshot);
});
```

并补两个边界场景：

```ts
it('preserves current price and changePercent semantics from the last two valid closes', () => {
  // price / changePercent 必须与当前 buildIndicatorSnapshot 口径一致
});

it('matches current rounding and invalid-value semantics for RSI/MFI/ADX and non-rounded indicators', () => {
  // RSI/MFI/ADX 只在最终输出 round
  // EMA/PSY/MACD/KDJ 不 round
});
```

- [ ] **Step 2: Run runtime tests to verify they fail**

Run: `bun test tests/services/indicators/runtime/index.business.test.ts tests/services/indicators/runtime/incremental.business.test.ts`
Expected: FAIL，提示 bootstrap / snapshot-build 新 API 尚不存在。

- [ ] **Step 3: Define top-level incremental runtime state in `types.ts`**

新增：

```ts
export type IndicatorIncrementalRuntime = {
  readonly symbol: string;
  readonly profile: IndicatorUsageProfile;
  readonly closedBarTimestamp: number | null;
  readonly activeBarTimestamp: number | null;
  readonly activeBarConfirmed: boolean | null;
  readonly lastSnapshot: IndicatorSnapshot | null;
  // 各指标子状态
};
```

要求：

1. 复用已有 `EmaStreamState` / `RsiStreamState` / `PsyStreamState`，不要重新发明同类结构。
2. 新增 `Mfi/Kdj/Macd/Adx` 所需状态时，最小化建模，只保留增量推进所需字段。

- [ ] **Step 4: Implement bootstrap from complete candle series**

在 `src/services/indicators/runtime/index.ts` 中实现：

```ts
bootstrapIndicatorRuntime(symbol, candles, profile)
buildSnapshotFromRuntime(runtime)
```

规则：

1. bootstrap 允许遍历完整 candles。
2. bootstrap 完成后得到的 `lastSnapshot` 必须与旧 `buildIndicatorSnapshot(...)` 等价。
3. bootstrap 必须同时建立：
   - committed indicator states
   - 最近两个有效 close 的语义状态
   - 各指标自己的 seed / smoothing / rolling-window 状态
4. 旧 `buildIndicatorSnapshot(...)` 可以保留为对拍参考，但运行期不再作为主路径。

- [ ] **Step 5: Expose per-indicator bootstrap helpers without changing business semantics**

在各指标模块中补齐最小 helper：

- `ema.ts`: bootstrap EMA state
- `rsi.ts`: bootstrap RSI state
- `psy.ts`: bootstrap PSY state
- `mfi.ts`: bootstrap MFI rolling state
- `kdj.ts`: bootstrap KDJ state
- `macd.ts`: bootstrap MACD state
- `adx.ts`: bootstrap ADX state

- [ ] **Step 6: Run bootstrap equivalence tests**

Run: `bun test tests/services/indicators/runtime/index.business.test.ts tests/services/indicators/runtime/incremental.business.test.ts`
Expected: PASS，且含义必须明确为：bootstrap runtime 构造出的 `IndicatorSnapshot` 与当前全量 `buildIndicatorSnapshot(...)` 对同一输入完全一致；若只是“数值接近”，不能视为通过。

- [ ] **Step 7: Commit**

```bash
git add src/services/indicators/runtime/types.ts src/services/indicators/runtime/index.ts src/services/indicators/runtime/ema.ts src/services/indicators/runtime/rsi.ts src/services/indicators/runtime/psy.ts src/services/indicators/runtime/mfi.ts src/services/indicators/runtime/kdj.ts src/services/indicators/runtime/macd.ts src/services/indicators/runtime/adx.ts tests/services/indicators/runtime/index.business.test.ts tests/services/indicators/runtime/incremental.business.test.ts
git commit -m "refactor: bootstrap incremental indicator runtime"
```

### Task 4: 实现“未收线增量更新 + 收线后整体移位”

> **Task gate:** 这一任务完成的判定标准不是“运行期改成增量推进”，而是“所有运行期增量拍都能与当前全量实现逐拍对拍一致”。若任一指标、任一边界场景不一致，则不得标记完成。

**Files:**
- Modify: `src/services/indicators/runtime/index.ts`
- Modify: `src/services/indicators/runtime/{ema,rsi,psy,mfi,kdj,macd,adx}.ts`
- Modify: `src/main/processMonitor/indicatorPipeline.ts`
- Test: `tests/services/indicators/runtime/incremental.business.test.ts`
- Test: `tests/main/processMonitor/indicatorPipeline.business.test.ts`

- [ ] **Step 1: Write the failing tests for active-bar updates and confirmed-bar shift**

增加以下场景：

```ts
it('updates snapshot incrementally when active bar timestamp is unchanged and unconfirmed', () => {
  // 同一根活动 bar 多次更新 close/high/low/volume
  // 断言只通过 updateActiveBar 得到新 snapshot，且与全量结果一致
});

it('commits the active bar when confirmed flips to true on the same timestamp', () => {
  // 同 timestamp false -> true
  // 断言运行态进入 closed 状态，snapshot 与全量结果一致
});

it('is idempotent when the same confirmed push is replayed on the same timestamp', () => {
  // 同 timestamp confirmed=true 重复推送
  // 断言不会重复 commit / 重复移位，snapshot 保持稳定
});

it('shifts to next bar when timestamp advances within one main-loop interval', () => {
  // A bar confirmed + B bar append 发生在两拍之间
  // 主循环只读到最终缓存快照，也必须正确完成移位并初始化新 active bar
});
```

- [ ] **Step 2: Run incremental tests to verify they fail**

Run: `bun test tests/services/indicators/runtime/incremental.business.test.ts`
Expected: FAIL，提示 active-update / confirmed-shift API 尚不存在或结果不一致。

- [ ] **Step 3: Implement runtime transitions in `runtime/index.ts`**

新增主入口：

```ts
updateRuntimeForCandlestickSnapshot(runtime, cacheSnapshot)
```

内部必须明确处理三类分支：

1. **UNMODIFIED**：version 未变，直接返回旧 runtime。
2. **ACTIVE_BAR_UPDATE**：`lastBarTimestamp` 不变且 `lastBarConfirmed=false`。
3. **CONFIRMED_OR_SHIFT**：
   - 同 timestamp 的 `false -> true`
   - 或 timestamp 前进（即使 confirmed 与 append 同秒完成）

- [ ] **Step 4: Implement per-indicator active update and commit semantics**

各指标必须支持两种动作：

1. `preview / recompute-active-from-closed-state`
2. `commit-confirmed-bar`

实现要求：

- 未收线阶段不能整体重扫全部历史 candles。
- preview 必须基于 committed state 的克隆或临时派生值，不能原地污染 committed state。
- 收线阶段必须把活动 bar 正式写入稳定状态，然后再开始下一根活动 bar。
- 不能保留“未收线增量、收线时回退全量”的运行期双轨。
- `buildSnapshotFromRuntime(runtime)` 只能从 primitive / stream state 生成对外 snapshot，不能把 runtime state 直接暴露为 snapshot 内部对象。

- [ ] **Step 5: Integrate incremental transitions into `indicatorPipeline`**

`indicatorPipeline` 在 version 变化时固定流程为：

1. 若 `state.incrementalIndicatorRuntime === null`，先 bootstrap。
2. 否则根据缓存快照执行增量 transition。
3. 由 runtime 构造新的 `monitorSnapshot`。
4. 更新：
   - `state.incrementalIndicatorRuntime`
   - `state.lastMonitorSnapshot`
   - `state.lastCandlestickCacheVersion`

- [ ] **Step 6: Run targeted runtime and pipeline tests**

Run: `bun test tests/services/indicators/runtime/incremental.business.test.ts tests/main/processMonitor/indicatorPipeline.business.test.ts`
Expected: PASS，且含义必须明确为：活动 bar preview、confirmed commit、同秒 shift 等所有运行期增量拍，与“此刻若调用当前全量实现重算”的结果逐拍一致。

- [ ] **Step 7: Commit**

```bash
git add src/services/indicators/runtime/index.ts src/services/indicators/runtime/ema.ts src/services/indicators/runtime/rsi.ts src/services/indicators/runtime/psy.ts src/services/indicators/runtime/mfi.ts src/services/indicators/runtime/kdj.ts src/services/indicators/runtime/macd.ts src/services/indicators/runtime/adx.ts src/main/processMonitor/indicatorPipeline.ts tests/services/indicators/runtime/incremental.business.test.ts tests/main/processMonitor/indicatorPipeline.business.test.ts
git commit -m "refactor: incrementally update realtime indicator snapshots"
```

### Task 5: 做全链路回归验证并清理旧短路语义

**Files:**
- Modify: `src/main/processMonitor/indicatorPipeline.ts:1-212`
- Modify: `src/types/state.ts:177-208`
- Modify: `src/main/lifecycle/cacheDomains/globalStateDomain.ts:1-77`
- Test: `tests/main/asyncProgram/delayedSignalVerifier/business.test.ts`
- Test: `tests/integration/main-program-strict.integration.test.ts`
- Test: `tests/integration/full-business-simulation.integration.test.ts`
- Test: `tests/main/lifecycle/cacheDomains/globalStateDomain.test.ts`
- Test: `tests/chaos/candlestick-websocket-out-of-order.test.ts`

- [ ] **Step 1: Add failing regression tests for edge cases**

新增或扩展以下场景：

```ts
it('keeps delayed verification sampling continuous when cache version does not change for multiple ticks', () => {
  // 断言 indicatorCache 仍按秒推进
});

it('ignores out-of-order candlestick push events without regressing local series', () => {
  // 更小 timestamp push 被忽略
});

it('does not duplicate signal generation when multiple push updates collapse into one main-loop tick', () => {
  // 多次 push -> 主循环一拍只消费最终状态
});
```

并新增独立 chaos 文件 `tests/chaos/candlestick-websocket-out-of-order.test.ts`，不要复用现有订单 WS 乱序测试文件，避免语义混杂。

- [ ] **Step 2: Remove stale fingerprint-only short-circuit assumptions**

清理或收缩旧语义：

1. `lastCandleFingerprint` 不再作为运行期的主判定依据。
2. 若保留，只允许用于调试或兼容断言，不得继续主导是否重算。
3. 运行期主短路条件固定为 `lastCandlestickCacheVersion`。

- [ ] **Step 3: Run focused regressions and integration tests**

Run: `bun test tests/main/asyncProgram/delayedSignalVerifier/business.test.ts tests/integration/main-program-strict.integration.test.ts tests/integration/full-business-simulation.integration.test.ts tests/chaos/websocket-out-of-order.test.ts`
Expected: PASS

- [ ] **Step 4: Run project-wide quality gates**

Run: `bun lint && bun type-check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/processMonitor/indicatorPipeline.ts src/types/state.ts tests/main/asyncProgram/delayedSignalVerifier/business.test.ts tests/integration/main-program-strict.integration.test.ts tests/integration/full-business-simulation.integration.test.ts tests/chaos/websocket-out-of-order.test.ts
git commit -m "test: cover candlestick cache incremental runtime regressions"
```

---

## 4. 关键实现细则

### 4.1 为什么新方案不需要额外的 1 秒事件节流器

因为新的职责划分是：

1. push callback：只更新缓存。
2. 主循环：每秒消费缓存并决定是否重算。

因此主循环本身就是唯一的 1 秒采样器，额外在 push 层做节流只会增加状态复杂度，没有收益。

### 4.2 为什么必须保留每秒 `indicatorCache.push(...)`

当前 `DelayedSignalVerifier` 的业务口径是：

- 以 signal `triggerTime` 为 T0
- 再取 T0/T0+5s/T0+10s 附近的样本

若把 `indicatorCache` 改成“只有 K 线变化时才写入”，则无变化阶段会失去连续时间采样点，导致延迟验证样本空窗。这违反当前业务口径，因此不能改。

### 4.3 如何处理“confirmed + next bar 同秒到达”

主循环两拍之间若发生：

1. 活动 bar A 收线 confirmed
2. 新 bar B append

下一拍主循环可能只读到最终缓存：

- `lastBarTimestamp = B`
- `lastBarConfirmed = false`
- candles 中倒数第二根是 A

增量推进逻辑必须据此推导：

1. A 已完成移位并成为 closed bar。
2. B 是新的 active bar。

因此 transition 判断不能只靠 `isConfirmed=true` 这个单一布尔值，也必须支持“timestamp 前进即表示已移位”的规则。

### 4.4 为什么本次必须优先复用已有流式状态类型

`src/services/indicators/runtime/types.ts` 已经存在：

- `EmaStreamState`
- `RsiStreamState`
- `PsyStreamState`

这说明仓库内已经有部分流式计算基础。本次应在其上扩展，而不是另起一套并行状态模型。实现原则是：

1. 复用已有状态结构。
2. 补齐缺失的 bootstrap / preview / commit 辅助函数。
3. 对 MFI/KDJ/MACD/ADX 按同样思路补最小状态，不增加冗余抽象。

---

## 5. 验证清单

### 5.0 最高门禁验证

以下条目是最终交付前必须全部满足的硬门禁：

- [ ] 旧全量实现已保留为对拍 oracle，直到全部增量对拍通过前不得移除。
- [ ] bootstrap 阶段对拍通过。
- [ ] 运行期逐拍对拍通过。
- [ ] 各单指标对拍通过。
- [ ] 整体 `IndicatorSnapshot` 对拍通过。
- [ ] 任一指标若未能证明与当前全量实现一致，则本次重构不得宣告完成。


- [ ] `setOnCandlestick` 仅更新本地缓存，不做业务推进。
- [ ] 同一输入序列下，增量计算产出的每一拍 `IndicatorSnapshot` 与当前全量实现逐拍一致。
- [ ] `subscribeCandlesticks(...)` 返回的初始 candles 已种子化到本地缓存。
- [ ] 主循环不再每秒直接调用 `getRealtimeCandlesticks()`。
- [ ] `indicatorPipeline` 以 `lastCandlestickCacheVersion` 作为主短路条件。
- [ ] K 线缓存无变化时，`indicatorCache` 仍然每秒 push 一次最近 snapshot。
- [ ] `indicatorCache` 的 entry 时间仍然表示主循环采样时间，而不是 K 线 `timestamp`。
- [ ] 未收线 bar 更新只走增量推进，不回退整批全量重算。
- [ ] 收线确认与跨 bar append 都能触发整体移位。
- [ ] `confirmed + next bar 同秒到达` 场景有测试覆盖。
- [ ] websocket out-of-order push 场景有独立 chaos 测试覆盖。
- [ ] 同 timestamp 的重复 confirmed push 在缓存层与运行态层都具备幂等保障。
- [ ] reset / 午夜清理的部分退订失败不会造成“订阅保留但缓存丢失”的半状态。
- [ ] `bun lint` 与 `bun type-check` 最终通过。

---

## 6. 执行注意事项

0. 本次任务的成功标准不是“重构完成并能运行”，而是“重构完成后，增量结果已经被严格证明与当前全量实现一致”。如果没有证明，就不能进入完成态。

1. 先落本地 K 线缓存，再改 `indicatorPipeline` 数据源，最后切入增量指标运行态；不要同时改三层，避免难以定位偏差。
2. 每完成一个任务都要做对拍测试，尤其是 incremental runtime 与旧全量 snapshot 的等价性测试。
3. 运行期一旦切入增量状态后，不要再在主路径保留“version 变化时直接整批全量重算”的回退逻辑；这会把运行时语义重新分裂成双轨。
4. 若发现个别指标当前无法在一次任务中稳定实现增量状态，应停下来重新审视状态设计，而不是临时把该指标留在运行期全量分支中。
5. 最终验收以“业务语义不变 + 指标结果与旧实现等价 + 延迟验证无采样空窗 + 主循环仍为统一业务时钟”为准。
