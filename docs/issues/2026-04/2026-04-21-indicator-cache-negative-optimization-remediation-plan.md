# 指标缓存与全量对象池负优化清理方案（2026-04-21）

## 1. 文档目标

本方案用于在**不改变当前业务逻辑**的前提下，清理当前指标快照、延迟验证缓存、展示链路以及异步信号链路中的负优化设计。目标只有四个：

1. 保留现有业务语义：`T0 / T0+5s / T0+10s ±5s` 三点采样、相同通过/失败口径、相同失败原因分支、相同门禁顺序。
2. 保留 `indicatorCache` 的**按真实时间轴每秒采样**语义，不退化成 K 线事件采样。
3. 删除“对象池 -> 释放 -> 深拷贝补救 -> 再复制”的负优化链路。
4. 在收尾时**彻底删除所有对象池相关死代码**，不保留兼容层、空壳字段、no-op 释放器、残留类型或测试钩子。

本方案不是为了优化而修改业务判断，而是删除当前实现中**与业务无关的载荷、对象生命周期协议和历史包袱**。

---

## 2. 已确认的业务真相

### 2.1 不能改变的语义

以下语义必须保持不变：

1. `DelayedSignalVerifier` 继续按 `T0 / T0+5s / T0+10s` 三个目标时间点取样。
2. 每个时间点继续使用 `±5s` 容差窗口。
3. `indicatorCache.push(...)` 继续由 `timeDriverProgram` 在 tick 当下执行。
4. `indicatorCache` 继续沿真实时间轴推进，**不能改成仅在 K 线事件时写入**。
5. BUYCALL / SELLPUT 仍要求三个时间点均高于初始值；BUYPUT / SELLCALL 仍要求三个时间点均低于初始值。
6. ADX 仍保持现有“下降才通过”的业务口径。
7. 普通信号生成、席位校验、开盘保护、交易门禁、清仓接管窗口语义不变。
8. 自动换标清队列、午夜清理、退出清理、处理器 finally 清理的**发生时机**不变。

### 2.2 当前“每秒复制整份 snapshot”不是业务真相

当前每秒复制整份 `IndicatorSnapshot`，只是当前实现方式，不是业务要求。

业务真正需要的是：

1. 在每个 tick 时刻，为每个 monitor 记录一个**带时间戳的延迟验证样本**。
2. 样本里包含后续延迟验证会读取到的指标状态。
3. 这些状态在后续查询时保持稳定，不受对象池回收影响。

业务并不需要：

1. 每秒把 `price`、`changePercent`、`mfi`、展示专用 `ema/rsi/psy` 全量复制进 `indicatorCache`。
2. 每秒把整个 `IndicatorSnapshot` 存进环形缓存。
3. 为了缓存稳定性继续保留对象池快照对象。

结论：

1. **按秒采样是业务需要。**
2. **按秒复制整份 `IndicatorSnapshot` 不是业务需要，是可优化项。**

### 2.3 删除对象池实现，不等于删除业务清理时机

当前很多 `release` 路径承载的是“对象池回收”实现，但它们挂载的位置本身对应真实业务生命周期：

1. 信号被门禁拒绝后的丢弃时机。
2. 自动换标时的清队列时机。
3. 处理器 finally 的收尾时机。
4. 午夜清理与退出清理时机。

本次删除的是**对象池实现**，不是这些时机本身。重构后必须保留这些动作点，只删除其中的“归还对象池”语义。

---

## 3. 当前负优化链路

### 3.1 快照链路的负优化

当前热点链路如下：

1. `indicators/runtime` 在构造 `IndicatorSnapshot` 时，`ema/rsi/psy/kdj/macd` 使用对象池对象。
2. `indicatorPipeline` 写入新的 `lastMonitorSnapshot` 后，又释放旧快照中的池化对象。
3. `timeDriverProgram` 每秒把 `lastMonitorSnapshot` 整份推入 `indicatorCache`。
4. 因为 `indicatorCache` 需要跨 10-20 秒保留历史数据，只能再次深拷贝整份 `IndicatorSnapshot`。
5. `marketMonitor` 为了变化检测，又把 snapshot 再复制成一份 `monitorValues`。

因此当前不是“对象池减少分配”，而是：

1. 对象池先制造不稳定引用。
2. 上层为了保留历史语义和展示语义，被迫多次复制。
3. 最终形成更高的 CPU、GC 和生命周期复杂度。

### 3.2 `indicatorCache` 的过载设计

`indicatorCache` 实际只服务延迟验证，而延迟验证只消费：

1. `K / D / J`
2. `MACD / DIF / DEA`
3. `ADX`
4. `EMA:n`
5. `PSY:n`

因此把整份 `IndicatorSnapshot` 每秒写入缓存是过载设计。

### 3.3 剩余信号对象池的真实问题

当前剩余对象池为：

1. `signalObjectPool`
2. `indicatorRecordPool`
3. `verificationEntryPool`

它们当前带来的问题已经明确：

1. `Signal` 当前混入了“为了对象池 reset 而可变”的设计负担。
2. 信号跨 `strategy -> delayedSignalVerifier -> taskQueue -> processor -> retryState` 多个异步边界传递，所有路径都必须手工维护所有权协议。
3. `indicatorRecordPool` 的 `Record` 复位依赖 `deleteProperty`，本身存在 shape / hidden class 退化风险。
4. `verificationEntryPool` 当前没有真实创建链路，属于死池。

### 3.4 `signalObjectPool` 已带来真实正确性风险

`SellProcessor` 的 quote retry 会浅拷贝 `Signal`，把 `indicators1` 原样挂到重试副本上。

这会形成：

1. 原始任务信号在处理器 `finally` 中释放。
2. 重试副本后续也会再次释放。
3. `signalObjectPool.release(...)` 又会递归释放 `indicators1` 的子对象。

因此同一批嵌套对象存在被重复归还的风险，这不是理论复杂度，而是当前对象池设计引入的正确性隐患。

### 3.5 `verificationHistory` 应视为死字段

当前仓库内看不到 `verificationHistory` 的真实写入链路：

1. 立即信号只写 `null`。
2. 延迟信号只初始化空数组。
3. quote retry 只是浅拷贝。

因此本次不应再把它当成“可能保留的业务字段”，而应直接按死字段删除。

---

## 4. 方案结论

本次应执行的结论如下：

1. **保留 `indicatorCache` 的按秒时间轴采样。**
2. **删除 `indicatorCache` 对整份 `IndicatorSnapshot` 的存储语义。**
3. **将 `indicatorCache` 改为只存“延迟验证最小真相样本”。**
4. **删除快照/展示热路径中的对象池设计，改为普通小对象。**
5. **删除剩余 `signalObjectPool / indicatorRecordPool / verificationEntryPool`，把 `Signal` 与延迟验证初始指标改回普通值对象。**
6. **删除的是对象池实现，不是业务丢弃时机、清队列时机、午夜清理时机或退出清理时机。**
7. **不引入兼容双轨，不同时保留“整份 snapshot 缓存”和“最小样本缓存”。**
8. **不保留“旧 release 协议继续运行但对象已不是池化对象”的半残状态。**

---

## 5. 目标设计

### 5.1 `IndicatorSnapshot` 改为普通对象，不再承载对象池生命周期

目标：

1. 把 `IndicatorSnapshot` 恢复为普通快照对象。

实现口径：

1. `indicators/runtime` 构造 `ema/rsi/psy/kdj/macd` 时直接返回普通对象字面量。
2. 删除 `IndicatorSnapshot` 对对象池的依赖。
3. 删除 `releaseSnapshotObjects(...)` 及其调用链。
4. `indicatorPipeline` 只负责推进 runtime、构建最新 snapshot、写入 `state.lastMonitorSnapshot`。

业务影响判断：

1. 下游只依赖 snapshot 数值，不依赖对象池身份。
2. 释放旧快照对象不是业务动作，只是当前内存管理手段。
3. 改为普通对象后，`lastMonitorSnapshot` 的可观察值保持一致。

### 5.2 `indicatorCache` 只存延迟验证样本，不再存整份 snapshot

目标：

1. 把 `indicatorCache` 的缓存载荷从整份 `IndicatorSnapshot` 收缩为延迟验证最小样本。

样本结构：

```ts
type VerificationSamplePoint =
  | Readonly<{ kind: 'value'; value: number }>
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'invalid' }>;

type VerificationSampleValues = Readonly<Record<string, VerificationSamplePoint>>;

type IndicatorCacheEntry = {
  readonly timestamp: number;
  readonly values: VerificationSampleValues;
};
```

这样设计的原因：

1. 当前验证逻辑不只区分“成功 / 失败”，还区分“快照缺失”与“值无效”。
2. 只存 `Record<string, number>` 无法保留这两个失败原因分支。
3. 三态结构已经是保持现有业务语义的最小信息集，不是额外扩展。

样本内容边界：

1. 每个 monitor 的样本只保留该 monitor `verificationIndicatorsBySide.buy` 与 `verificationIndicatorsBySide.sell` 的并集。
2. 不保留 `price`、`changePercent`、`mfi`、`rsi`、展示专用字段。

写入 owner：

1. `indicatorCache.push(...)` 仍只由 `timeDriverProgram` 调用。
2. tick 时读取 `sampleTimestampMs`。
3. 读取 `monitorContext.state.lastMonitorSnapshot`。
4. 按 monitor 的延迟验证指标并集投影出 `VerificationSampleValues`。
5. 调用 `indicatorCache.push(monitorSymbol, sampleValues, sampleTimestampMs)`。

业务影响判断：

1. 当前 `DelayedSignalVerifier` 只关心延迟验证指标的“存在 / 无效 / 数值”三类状态。
2. 若新样本满足：
3. `kind: 'value'` 时，`value === getIndicatorValue(oldSnapshot, indicatorName)`。
4. `kind: 'missing'` 时，对应旧实现里的“快照缺失”分支。
5. `kind: 'invalid'` 时，对应旧实现里的“值无效”分支。
6. 则延迟验证链路的通过/失败结果、失败原因分支与日志口径均不变。

### 5.3 保留“每秒一个时间点条目”，但不再每秒复制整份数据

直接方案：

1. 每个 tick 仍写入一个新条目：`{ timestamp, values }`。
2. `values` 仅含延迟验证所需标量状态。

为什么不能改成事件采样：

1. 当前语义要求在真实时间轴附近取 `T0 / T0+5s / T0+10s`。
2. 事件采样会把本应命中的时间点变成“样本缺失”。
3. 这会把原本通过的信号改成失败。

结论：

1. 不能删除按秒采样。
2. 只能删除按秒整份复制。

### 5.4 `DelayedSignalVerifier` 直接消费样本值，不再回读完整 snapshot

目标：

1. 让延迟验证只依赖自己的业务最小输入。

实现口径：

1. `indicatorCache.getAt(...)` 返回 `timestamp + values`。
2. `performVerification(...)` 不再从 `entry.snapshot` 上调用 `getIndicatorValue(...)`。
3. 改为直接读取 `entry.values[indicatorName]` 的 `kind/value`。
4. `missing / invalid / value` 三种分支保持当前判断口径。
5. ADX 的特殊比较口径保持不变。

### 5.5 `marketMonitor` 改为普通显示缓存，不再使用对象池

目标：

1. 删除展示路径中的对象池负担。

实现口径：

1. `monitorValues` 继续只缓存 `displayPlan` 所需字段。
2. `buildMonitorValuesFromDisplayPlan(...)` 直接构造普通对象。
3. 删除 `monitorValuesObjectPool` 及其嵌套 `periodRecordPool / kdjObjectPool / macdObjectPool` 的展示用途。
4. 删除展示缓存 release 逻辑、pooled copy helper 与最终调用点。

业务影响判断：

1. `monitorValues` 只用于变化检测和日志展示。
2. 比较阈值、展示字段、日志内容均不改变。
3. 这里只是把缓存对象从池化可变对象改成普通值对象。

### 5.6 `indicatorRecordPool` 与 `verificationEntryPool` 直接删除

目标：

1. 把延迟验证辅助对象池改回普通数据对象。

实现口径：

1. `strategy.generateSignals(...)` 在创建延迟验证信号时，直接构造普通 `Record<string, number>` 作为 `signal.indicators1`。
2. 删除 `indicatorRecordPool`。
3. 删除 `verificationEntryPool`。
4. 删除 `verificationHistory` 字段及其测试、注释、命名残留。

业务影响判断：

1. 延迟验证真正依赖的是 `signal.indicators1` 内的 T0 指标值，不依赖该对象来自对象池。
2. `verificationEntryPool` 没有真实创建链路，不承载业务收益。
3. 删除对象池后，延迟验证通过/失败口径不变。

### 5.7 `signalObjectPool` 直接删除，`Signal` 改回普通值对象

目标：

1. 删除当前跨异步边界的信号对象池协议。

实现口径：

1. 删除 `signalObjectPool` 与 `acquireSignal()`。
2. `strategy`、`autoSymbolManager.signalBuilder`、`doomsdayProtection`、`unrealizedLossMonitor`、`staticLiquidationExecutor` 等所有创建点改为直接构造普通 `Signal` 对象。
3. 删除 `releaseSignal` 注入、调用、类型定义与工具函数。
4. 删除 `releaseAfterProcess` 的对象池释放语义，但保留原有业务处理结束时机。
5. `cloneSellSignal(...)` 改为普通值拷贝，避免共享 `indicators1`。
6. `Signal` 类型移除“为了对象池 reset 而可变”的设计前提，但保留业务确实需要的可变字段。

业务影响判断：

1. 当前所有信号路由、去重、席位校验、任务入队与执行都按字段内容工作，不按对象身份工作。
2. 删除对象池后，仍需保留现有的信号生成时机、延迟验证入队/取消时机、买卖任务出队时机、quote retry 重新入队时机、自动换标清队列时机、午夜清理与退出清理时机。

---

## 6. 执行顺序

### 6.1 阶段 A: 快照与展示去池化

目标：

1. 先把 `IndicatorSnapshot` 和 `monitorValues` 从对象池生命周期中摘出来。

动作：

1. 删除快照热路径对象池：`periodRecordPool / kdjObjectPool / macdObjectPool / monitorValuesObjectPool`。
2. 删除 `releaseSnapshotObjects(...)` 及其调用链。
3. 删除展示路径 release helper、copy helper 与类型残骸。

完成标准：

1. 仓库内 `releaseSnapshotObjects` import 与调用归零。
2. 仓库内不再有 `PoolableKDJ / PoolableMACD` 之类的 pooled 类型残留。

### 6.2 阶段 B: `indicatorCache` 与延迟验证最小样本化

目标：

1. 保留按秒时间轴。
2. 删除整份 snapshot 缓存。

动作：

1. `indicatorCache` 条目从 `snapshot` 改为 `values`。
2. `timeDriverProgram` 在写入时做样本投影。
3. `DelayedSignalVerifier` 直接消费三态样本。
4. `findClosestEntry(...)` 保持容差、等距优先级、环形覆盖语义不变。

完成标准：

1. 仓库内不再有 `entry.snapshot` 读取路径。
2. `indicatorCache` 不再携带非验证指标字段。

### 6.3 阶段 C: 信号对象池与释放协议清理

目标：

1. 删除 `signalObjectPool / indicatorRecordPool / verificationEntryPool`。
2. 删除所有围绕对象池存在的释放协议。

动作：

1. 先迁移所有 `acquire/release/releaseAfterProcess/releaseSignal` 调用方与注入点。
2. 同步把 `Signal` 创建点改成普通对象，把 `indicators1` 改成普通对象，并删除 `verificationHistory`。
3. 在同一阶段删除 `signalObjectPool.release(...)` 对子池的引用。
4. 最后一次性删除 `signalObjectPool / indicatorRecordPool / verificationEntryPool` 定义与导出。

完成标准：

1. 不允许出现“先删子池定义，但 `signalObjectPool.release(...)` 还在引用”的半残状态。
2. 仓库内 `releaseSignal`、`releaseAfterProcess`、`signalObjectPool`、`indicatorRecordPool`、`verificationEntryPool` 的运行时代码、类型引用与注释引用全部归零。

### 6.4 阶段 D: 死代码与测试残骸清扫

目标：

1. 收尾时彻底删除所有对象池相关残骸。

动作：

1. 删除 `src/utils/objectPool/index.ts` 与 `src/utils/objectPool/types.ts` 整个模块。
2. 删除所有围绕对象池存在的 dead helper、dead comment、dead type alias、dead test spy、dead monkey-patch。
3. 修正仍以 pooled/release 语义命名的测试标题与断言。

完成标准：

1. 仓库内不再出现 `objectPool`、`releaseSnapshotObjects`、`releaseSignal`、`releaseAfterProcess`、`Poolable`、`verificationHistory` 相关残留。

---

## 7. 文件级覆盖清单

### 7.1 快照与展示去池化

涉及文件：

1. `src/services/indicators/runtime/index.ts`
2. `src/services/indicators/runtime/kdj.ts`
3. `src/services/indicators/runtime/macd.ts`
4. `src/services/indicators/runtime/utils.ts`
5. `src/utils/helpers/index.ts`
6. `src/main/businessEventProgram/indicatorPipeline.ts`
7. `src/main/lifecycle/cacheDomains/globalStateDomain.ts`
8. `src/app/shutdown/createCleanup.ts`
9. `src/services/marketMonitor/index.ts`
10. `src/types/data.ts`
11. `src/utils/objectPool/index.ts`
12. `src/utils/objectPool/types.ts`

必须删除的内容：

1. snapshot release 逻辑。
2. pooled validator / pooled copy helper。
3. 展示缓存 release 逻辑。
4. 所有 `Poolable*` 类型。

### 7.2 `indicatorCache` 与 `DelayedSignalVerifier`

涉及文件：

1. `src/main/asyncProgram/indicatorCache/types.ts`
2. `src/main/asyncProgram/indicatorCache/index.ts`
3. `src/main/asyncProgram/indicatorCache/utils.ts`
4. `src/main/timeDriverProgram/index.ts`
5. `src/main/asyncProgram/delayedSignalVerifier/utils.ts`
6. `src/main/asyncProgram/delayedSignalVerifier/types.ts`
7. 如有需要，新增专门的样本投影 helper

必须删除的内容：

1. `indicatorCache` 条目中的 `snapshot` 字段。
2. 延迟验证对完整 snapshot 的读取依赖。
3. 任何“样本缺失时回读最新 snapshot”之类的兜底。

### 7.3 `indicatorRecordPool / verificationEntryPool / verificationHistory`

涉及文件：

1. `src/core/strategy/index.ts`
2. `src/types/signal.ts`
3. `src/utils/objectPool/index.ts`
4. `src/utils/objectPool/types.ts`
5. 直接依赖 `verificationHistory` 的测试与命名残留

必须删除的内容：

1. `indicatorRecordPool`
2. `verificationEntryPool`
3. `verificationHistory` 字段
4. 所有围绕 `verificationHistory` 存在的注释、测试标题与断言

### 7.4 `signalObjectPool` 与释放协议

涉及文件：

1. `src/core/strategy/index.ts`
2. `src/services/autoSymbolManager/index.ts`
3. `src/services/autoSymbolManager/signalBuilder.ts`
4. `src/services/autoSymbolManager/types.ts`
5. `src/core/doomsdayProtection/index.ts`
6. `src/core/riskController/unrealizedLossMonitor.ts`
7. `src/main/monitorQuoteEventRuntime/staticLiquidationExecutor.ts`
8. `src/main/businessEventProgram/index.ts`
9. `src/main/businessEventProgram/signalPipeline.ts`
10. `src/main/businessEventProgram/types.ts`
11. `src/main/asyncProgram/buyProcessor/index.ts`
12. `src/main/asyncProgram/sellProcessor/index.ts`
13. `src/main/asyncProgram/delayedSignalVerifier/index.ts`
14. `src/main/asyncProgram/types.ts`
15. `src/main/asyncProgram/utils.ts`
16. `src/main/processMonitor/index.ts`
17. `src/main/processMonitor/seatSync.ts`
18. `src/main/processMonitor/types.ts`
19. `src/main/processMonitor/utils.ts`
20. `src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts`
21. `src/main/lifecycle/cacheDomains/types.ts`
22. `src/app/runtime/createAsyncRuntime.ts`
23. `src/app/runtime/queueCleanup.ts`
24. `src/app/lifecycle/createLifecycleRuntime.ts`
25. `src/app/runApp.ts`
26. `src/app/types.ts`
27. `src/app/wiring/registerDelayedSignalHandlers.ts`
28. `src/types/signal.ts`
29. `src/utils/objectPool/index.ts`
30. `src/utils/objectPool/types.ts`

必须删除的内容：

1. `signalObjectPool`
2. `acquireSignal()`
3. `releaseSignal` 注入、调用、类型定义与工具函数
4. `releaseAfterProcess` 的对象池释放语义
5. quote retry 中共享 `indicators1` 的浅拷贝逻辑
6. auto-symbol 相关构造器中的 `signalObjectPool` DI

---

## 8. 测试与验收

### 8.1 必须新增或调整的测试

1. `indicatorCache` 在连续多个 tick 中 snapshot 未变化时，仍按秒保留三个可命中的时间点条目。
2. `DelayedSignalVerifier` 在新样本结构下，对 `K / D / J / MACD / DIF / DEA / ADX / EMA:n / PSY:n` 分别新增矩阵用例，验证结果、失败原因分支与旧实现完全一致。
3. `indicatorCache` 不再携带非验证指标字段。
4. `findClosestEntry(...)` 的容差、等距优先级与环形覆盖语义保持不变。
5. `marketMonitor` 去池化后，变化检测结果与日志触发条件保持一致。
6. `indicatorPipeline` 去掉 snapshot release 后，latest snapshot 仍能在事件链路、跨日清理与退出清理中正确替换。
7. 删除 `indicatorRecordPool` 后，延迟信号生成与延迟验证结果完全一致。
8. 删除 `signalObjectPool` 后，立即信号、延迟信号、卖出 quote retry、末日保护、保护性清仓、自动换标信号均保持现有行为。
9. 卖出 quote retry 不再出现共享 `indicators1` 引用或重复 release 风险。
10. 午夜清理、退出清理、换标清队列后，不得残留 pending signal / retry signal / verifier timer。

### 8.2 必跑验证

1. `tests/main/asyncProgram/delayedSignalVerifier/business.test.ts`
2. `tests/main/asyncProgram/indicatorCache/utils.test.ts`
3. `tests/main/processMonitor/indicatorPipeline.business.test.ts`
4. `tests/main/processMonitor/index.business.test.ts`
5. `tests/main/processMonitor/seatSync.business.test.ts`
6. `tests/main/processMonitor/signalPipeline.business.test.ts`
7. `tests/main/lifecycle/cacheDomains/signalRuntimeDomain.test.ts`
8. `tests/main/lifecycle/cacheDomains/globalStateDomain.test.ts`
9. `tests/services/marketMonitor/business.test.ts`
10. `tests/services/autoSymbolManager/periodicSwitch.business.test.ts`
11. `tests/services/autoSymbolManager/switchStateMachine.business.test.ts`
12. `tests/app/createCleanup.business.test.ts`
13. `tests/app/runtime/queueCleanup.test.ts`
14. `tests/app/registerDelayedSignalHandlers.business.test.ts`
15. `tests/architecture/typeOrganization.test.ts`
16. `tests/integration/main-loop-latency.integration.test.ts`
17. `tests/integration/full-business-simulation.integration.test.ts`
18. `tests/integration/auto-search-policy-consistency.integration.test.ts`
19. `tests/integration/doomsday.integration.test.ts`
20. `bun lint`
21. `bun type-check`

### 8.3 收尾前的零引用验收

以下符号在收尾前必须归零：

1. `releaseSnapshotObjects`
2. `releaseSignal`
3. `releaseAfterProcess`
4. `signalObjectPool`
5. `indicatorRecordPool`
6. `verificationEntryPool`
7. `verificationHistory`
8. `PoolableKDJ`
9. `PoolableMACD`
10. `objectPool`

---

## 9. 严格禁止

1. 不允许把 `indicatorCache` 改成 K 线事件采样。
2. 不允许保留“整份 snapshot 缓存”和“最小样本缓存”双轨并存。
3. 不允许为了兼容旧接口保留 `entry.snapshot` 空壳字段。
4. 不允许保留 `releaseSnapshotObjects(...)` 作为 no-op 兼容层。
5. 不允许在 `timeDriverProgram` 之外新增第二个 `indicatorCache.push(...)` owner。
6. 不允许新增“如果样本缺失则回读最新 snapshot / 再算一次指标”的兜底逻辑。
7. 不允许为了减少分配而把样本写入异步共享 route 后再延迟读取最新值。
8. 不允许把 `marketMonitor` 改成第二套独立事实缓存。
9. 不允许保留 `signalObjectPool`、`indicatorRecordPool` 或 `verificationEntryPool` 的兼容空壳。
10. 不允许保留“对象已经改成普通对象，但旧 `release` 协议继续运行”的半残状态。
11. 不允许把 `releaseSignal`、`releaseAfterProcess`、`releaseSnapshotObjects` 改成 no-op 以求编译通过。
12. 不允许在删除子池定义后继续保留 `signalObjectPool.release(...)` 对子池的引用。
13. 不允许为了减少改动面而保留 `Signal` 类型“因对象池而可变”的说明。
14. 不允许在本次方案中顺手扩展 signal owner、risk owner、quote owner 语义。
15. 不允许保留任何围绕对象池存在的死类型、死 helper、死注释、死测试钩子或 monkey-patch 断言。

---

## 10. 一句话结论

本次优化的正确做法不是删除 `indicatorCache` 的按秒采样，而是：

**保留按秒时间轴，删除整份 snapshot 复制；保留业务真相，彻底删除全仓库对象池机制及其全部死代码残骸。**
