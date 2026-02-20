# 性能分析报告：对象池与性能优化

> 分析日期：2026-02-18
> 分析范围：src/ 全量代码

---

## 一、现有对象池体系（已完整）

系统已建立完整的 8 个专用对象池，覆盖所有每秒高频路径：

| 对象池                    | 复用对象                 | 容量 |
| ------------------------- | ------------------------ | ---- |
| `signalObjectPool`        | Signal                   | 100  |
| `indicatorRecordPool`     | `Record<string, number>` | 100  |
| `periodRecordPool`        | `Record<number, number>` | 100  |
| `kdjObjectPool`           | KDJ                      | 50   |
| `macdObjectPool`          | MACD                     | 50   |
| `monitorValuesObjectPool` | MonitorValues            | 20   |
| `positionObjectPool`      | Position                 | 10   |
| `verificationEntryPool`   | 验证历史条目             | 50   |

**结论：对象池体系无遗漏，不需要新增对象池。** 剩余未池化对象（TrackedOrder、PendingSignalEntry、Task 等）均在低频路径，池化收益不足以抵消复杂性。

---

## 二、RSI/EMA/MACD 改流式计算（建议实施）

### 问题描述

每次 K 线变化时，`buildIndicatorSnapshot` 触发全量指标计算。各指标算法内部大量创建中间数组，全部在计算完成后立即成为垃圾。

**调用链**（K 线变化时，每次触发）：

```
buildIndicatorSnapshot(200根K线)
  ├── validCloses[]                                    ← 200 元素新数组
  ├── calculateRSI × N周期
  │     ├── calculateRsiSeries() → output[]            ← 每周期 ~200 元素
  │     └── normalizeRsiSeries() → result.map() → []  ← 再次分配
  ├── calculateEMA × N周期
  │     └── calculateEmaSeriesWithSmaSeed()
  │           ├── values.slice(0, period)              ← 切片分配
  │           ├── [seed, ...values.slice(period)]      ← 展开分配
  │           └── calculateEmaSeries() → output[]      ← ~200 元素
  ├── calculateMACD()
  │     ├── calculateEmaSeriesWithSmaSeed(fast=12)     ← ~200 元素
  │     ├── calculateEmaSeriesWithSmaSeed(slow=26)     ← ~200 元素
  │     ├── difSeries[]                                ← ~175 元素
  │     ├── calculateEmaSeriesWithSmaSeed(signal=9)    ← ~175 元素
  │     └── output: MacdPoint[]                        ← ~175 元素
  └── calculateMFI()
        ├── validHighs[], validLows[], mfiCloses[], validVolumes[]  ← 4×200
        └── calculateMfiSeries() → output[]            ← ~186 元素
```

**量化分析**（200 根 K 线、RSI×2周期、EMA×3周期）：

| 分配来源               | 数组数量       | 元素规模         |
| ---------------------- | -------------- | ---------------- |
| `validCloses`          | 1              | ~200             |
| RSI（每周期 2 个数组） | 4              | ~200 each        |
| EMA（每周期 3 个数组） | 9              | ~200 each        |
| MACD 内部              | 5              | ~175-200 each    |
| MFI 内部               | 5              | ~200 each        |
| **合计**               | **~24 个数组** | **~4700 个元素** |

### 业务逻辑可行性分析

**RSI**：`calculateRsiSeries` 使用 Wilder 平滑递推公式（`smoothUp = (upward - smoothUp) * per + smoothUp`），每步只依赖前一步的两个标量 `smoothUp`/`smoothDown`。流式计算完全等价：遍历一次，维护两个标量，直接返回最终值，无需存储历史序列。`normalizeRsiSeries` 的 `.map()` 也随之消除。

**EMA**：`calculateEmaSeriesWithSmaSeed` 的递推公式 `value = (current - value) * per + value` 同样是纯标量递推。流式版本：用前 `period` 个值的 SMA 作为种子（保留现有 seed 逻辑），然后继续递推，只维护一个 `value` 标量。`slice` 和展开分配随之消除。

**MACD**：同时维护 `fastEmaVal`、`slowEmaVal`、`signalEmaVal` 三个标量。在 slow 序列就绪（第 26 根）后开始计算 DIF，在 DIF 序列积累足够（第 9 个 DIF 值）后开始计算信号线。数学上与当前序列实现完全等价。KDJ 的 `createEmaStream` 已经证明了这种流式 EMA 模式的正确性。

**MFI**：`calculateMfiSeries` 内部已使用 `BufferNewPush` 滑动窗口结构（环形缓冲区），本身已是流式实现，但调用前仍需提取 4 个辅助数组（`validHighs`/`validLows`/`mfiCloses`/`validVolumes`）。这 4 个数组可通过将提取逻辑内联到流式计算中消除，但 MFI 需要 high/low/volume 三个维度，与其他指标共用的 `validCloses` 无法复用，改动相对独立。

**结论：RSI、EMA、MACD 均可改为流式计算，数学等价，不影响业务逻辑。`validCloses` 数组随流式改造自然消失（流式计算直接遍历 candles，无需预提取）。**

### 实施注意事项

- KDJ 的 `createEmaStream` 是正确的参考实现，RSI/EMA/MACD 改造后应与其保持一致的模式
- 改造后需验证计算结果与现有实现数值一致（建议用相同 K 线数据对比输出）
- MFI 可单独评估，收益相对较小

---

## 三、`getAt` 直接遍历环形缓冲区（建议实施）

### 问题描述

- 位置：`main/asyncProgram/indicatorCache/index.ts:57` → `utils.ts:45`
- 调用频率：每次延迟验证触发时调用 3 次（T0、T0+5s、T0+10s）
- 缓冲区容量：`TIMESERIES_DEFAULT_MAX_ENTRIES = 100`（存储 100 秒数据）

```typescript
// 当前实现：getAt 先调用 getBufferEntries 物化整个缓冲区为新数组，再遍历
getAt(monitorSymbol, targetTime, toleranceMs) {
  const entries = getBufferEntries(buffer);  // 分配 100 元素新数组
  for (const entry of entries) { ... }
}
```

每次 `getAt` 分配一个 100 元素数组，3 次调用共分配 3 个 100 元素临时数组，用完即丢弃。

### 业务逻辑可行性分析

`getBufferEntries` 的遍历逻辑与 `getAt` 的查找逻辑完全独立，合并后逻辑完全等价：

```typescript
// 优化后：直接遍历环形缓冲区，零临时数组分配
getAt(monitorSymbol, targetTime, toleranceMs) {
  const startIndex = buffer.size < buffer.capacity ? 0 : buffer.head;
  let closestEntry = null;
  let minDiff = Infinity;
  for (let i = 0; i < buffer.size; i++) {
    const entry = buffer.entries[(startIndex + i) % buffer.capacity];
    if (!entry) continue;
    const diff = Math.abs(entry.timestamp - targetTime);
    if (diff <= toleranceMs && diff < minDiff) {
      minDiff = diff;
      closestEntry = entry;
    }
  }
  return closestEntry;
}
```

**结论：逻辑完全等价，零业务风险。改动范围仅限 `indicatorCache/index.ts` 的 `getAt` 实现，`getBufferEntries` 函数保留不动（其他地方可能使用）。**

---

## 四、`cloneIndicatorSnapshot` 每秒深拷贝（不建议优化）

### 问题描述

- 位置：`main/asyncProgram/indicatorCache/index.ts:48`
- 调用频率：每秒 1 次
- 每次创建：IndicatorSnapshot + kdj + macd + rsi + ema + psy 共 6 个新对象

### 不建议优化的原因

深拷贝的必要性来自真实的生命周期冲突：主循环每秒释放 `kdj`/`macd` 回对象池，而 indicatorCache 需要保留数据 100 秒。若为 indicatorCache 建立独立对象池，在 `pushToBuffer` 覆盖旧条目时归还对象，会引入一个**脆弱的隐式约定**：`getAt` 返回的对象有效性依赖于"调用方必须在同一个同步块内完成访问"。未来任何将 `performVerification` 改为异步的重构都会引入难以察觉的 bug。

此外，每秒 6 个小对象的分配对 V8 GC 压力极小——V8 新生代 GC 对短命小对象非常高效，这类分配几乎不产生 Stop-the-World 停顿。

**结论：引入的架构风险高于性能收益，维持现状。**

---

## 五、`validCloses` 缓存（随问题二一并解决，不单独实施）

### 分析

`validCloses` 是所有指标计算的共同输入，K 线指纹不变时内容不变，逻辑上可缓存到 `MonitorState`。但：

1. `calculateKDJ` 和 `calculateMFI` 接收原始 `candles`（需要 high/low/volume），无法用 `validCloses` 替代，这两个函数内部仍需自己提取数据
2. 实际只节省一个 ~200 元素数组，改动需修改 `buildIndicatorSnapshot` 函数签名
3. 若实施问题二（流式计算），流式版本直接遍历 `candles`，`validCloses` 数组自然消失

**结论：不单独实施，随问题二流式改造一并解决。**

---

## 六、优先级汇总

| 问题                      | 调用频率               | 分配规模               | 业务逻辑风险   | 实施难度         | 建议         |
| ------------------------- | ---------------------- | ---------------------- | -------------- | ---------------- | ------------ |
| 二：RSI/EMA/MACD 流式计算 | K线变化时（~1次/分钟） | ~24 个数组，~4700 元素 | 无（数学等价） | 高（需验证算法） | **建议实施** |
| 三：getAt 直接遍历        | 延迟验证触发时         | 3 个 100 元素数组      | 无（完全等价） | **低**           | **建议实施** |
| 四：cloneSnapshot 对象池  | 每秒 1 次              | 6 个小对象             | 引入脆弱约定   | 中               | 不建议       |
| 五：validCloses 缓存      | K线变化时              | 1 个 200 元素数组      | 无             | 中               | 随问题二解决 |

**建议实施顺序**：先实施问题三（改动最小，零风险，可独立验证），再实施问题二（收益最大，需仔细验证算法正确性）。

---

## 七、优化验证测试方案

### 7.1 问题三验证：`getAt` 直接遍历

**测试文件**：新增 `tests/main/asyncProgram/indicatorCache/business.test.ts`

**验证目标**：`getAt` 优化后的查找结果与原实现完全一致。

**测试场景**：

```typescript
// 场景1：正常查找——返回容忍度内最近时间点的条目
// 构造：push 5 个条目，时间戳间隔 1000ms
// 查询：targetTime = T0+2000ms，toleranceMs = 1500ms
// 期望：返回 T0+2000ms 的条目（精确匹配优先）

// 场景2：多个候选——返回时间差最小的条目
// 构造：push 3 个条目，时间戳为 T、T+800ms、T+1600ms
// 查询：targetTime = T+1000ms，toleranceMs = 600ms
// 期望：返回 T+800ms 的条目（diff=200ms < T+1600ms 的 diff=600ms）

// 场景3：超出容忍度——返回 null
// 构造：push 3 个条目，时间戳为 T、T+1000ms、T+2000ms
// 查询：targetTime = T+5000ms，toleranceMs = 500ms
// 期望：返回 null

// 场景4：环形缓冲区满后覆盖——仍能正确查找
// 构造：capacity=3，push 5 个条目（覆盖最旧的 2 个）
// 查询：targetTime = 最新条目的时间戳，toleranceMs = 100ms
// 期望：返回最新条目，不返回已被覆盖的旧条目

// 场景5：空缓冲区——返回 null
// 构造：不 push 任何条目
// 查询：任意 targetTime
// 期望：返回 null

// 场景6：延迟验证三点查询——模拟真实业务场景
// 构造：push 100 个条目（1 秒间隔，模拟 100 秒数据）
// 查询：T0、T0+5s、T0+10s 三个时间点（toleranceMs=5000ms）
// 期望：三次查询均返回非 null，且时间戳与目标时间差在容忍度内
```

**验证方式**：在同一测试中同时调用原实现（`getBufferEntries` + 遍历）和新实现（直接遍历），对比返回的条目引用是否相同（`toBe`）。

---

### 7.2 问题二验证：RSI/EMA/MACD 流式计算

**测试文件**：在现有 `tests/services/indicators/business.test.ts` 中新增 `describe` 块，或新增 `tests/services/indicators/streaming.test.ts`。

**核心验证原则**：流式实现与原实现在相同输入下，输出数值必须完全一致（`toBeCloseTo` 精度 10 位小数）。

#### RSI 流式验证场景

```typescript
// 场景1：标准上涨趋势——验证基础计算正确性
// 数据：200 根单调递增 K 线（step=0.5），周期 6
// 期望：流式结果 === 原实现结果（toBeCloseTo 10位）

// 场景2：标准下跌趋势——验证下跌动量计算
// 数据：200 根单调递减 K 线，周期 14
// 期望：流式结果 === 原实现结果

// 场景3：震荡行情——验证平滑递推稳定性
// 数据：200 根交替涨跌 K 线（奇数涨、偶数跌），周期 6 和 14
// 期望：两个周期的流式结果均与原实现一致

// 场景4：全部相同价格——验证边界（无下跌动量，RSI=100）
// 数据：200 根收盘价均为 100 的 K 线，周期 6
// 期望：流式结果 === 原实现结果（均为 100）

// 场景5：数据量恰好等于周期+1——验证最小有效数据量
// 数据：7 根 K 线，周期 6
// 期望：流式结果 === 原实现结果（非 null）
```

#### EMA 流式验证场景

```typescript
// 场景1：标准趋势——验证 SMA seed + EMA 递推
// 数据：200 根上涨 K 线，周期 5、20
// 期望：流式结果 === 原实现结果（toBeCloseTo 10位）

// 场景2：平坦价格——验证 EMA 收敛到常数
// 数据：200 根收盘价均为 50 的 K 线，周期 10
// 期望：流式结果 ≈ 50（toBeCloseTo 8位）

// 场景3：数据量恰好等于周期——验证边界（返回 null）
// 数据：5 根 K 线，周期 5
// 期望：流式结果 === 原实现结果（null）

// 场景4：多周期同时计算——验证各周期独立性
// 数据：200 根 K 线，周期 5、10、20 同时计算
// 期望：每个周期的流式结果均与原实现一致
```

#### MACD 流式验证场景

```typescript
// 场景1：标准参数（12/26/9）——验证完整 MACD 计算链
// 数据：200 根上涨 K 线
// 期望：dif、dea、macd 三个值均与原实现一致（toBeCloseTo 10位）

// 场景2：平坦价格——验证零值 MACD（现有测试已覆盖，需复用）
// 数据：60 根收盘价均为 100 的 K 线
// 期望：dif ≈ 0，dea ≈ 0，macd ≈ 0

// 场景3：下跌趋势——验证负值 DIF
// 数据：200 根单调递减 K 线
// 期望：流式 dif < 0，且与原实现一致

// 场景4：数据量不足——验证返回 null
// 数据：30 根 K 线（< slowPeriod + signalPeriod = 35）
// 期望：流式结果 === 原实现结果（null）

// 场景5：震荡行情——验证信号线计算稳定性
// 数据：200 根交替涨跌 K 线
// 期望：流式结果与原实现一致
```

#### `buildIndicatorSnapshot` 端到端验证

```typescript
// 场景：完整快照对比——流式改造后整体输出不变
// 数据：200 根真实形态 K 线（上涨+震荡+下跌混合），RSI×[6,14]，EMA×[5,10,20]，PSY×[13]
// 期望：
//   - snapshot.rsi[6]、rsi[14] 与改造前一致
//   - snapshot.ema[5]、ema[10]、ema[20] 与改造前一致
//   - snapshot.macd.dif、dea、macd 与改造前一致
//   - snapshot.kdj、mfi、psy 不受影响（未改动）
// 验证方式：改造前先记录基准值（hardcode 到测试中），改造后断言与基准值一致
```

**基准值固定方式**：在实施流式改造前，用当前实现跑一次，将输出值 hardcode 到测试的期望值中。这样即使改造后原实现被删除，测试仍能独立验证正确性。

---

### 7.3 回归保护

两项优化实施后，运行以下命令确认全量测试通过：

```bash
bun test
```

重点关注以下测试文件是否仍全部通过（这些文件覆盖了指标计算和缓存的下游逻辑）：

- `tests/services/indicators/business.test.ts`
- `tests/main/processMonitor/indicatorPipeline.business.test.ts`
- `tests/main/asyncProgram/delayedSignalVerifier/business.test.ts`
- `tests/integration/buy-flow.integration.test.ts`
- `tests/integration/full-business-simulation.integration.test.ts`
