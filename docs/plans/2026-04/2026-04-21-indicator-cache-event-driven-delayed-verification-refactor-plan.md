# 指标缓存事件驱动化与延迟验证最近值匹配重构方案

## 1. 文档目标

本方案用于把当前“`timeDriverProgram` 每秒写入 `indicatorCache`”的延迟验证采样链路，重构为“`K` 线事件链路在指标计算完成后立即写入缓存”的事件驱动实现，并同步把延迟验证从“带时间容差的匹配”改为“在缓存保留窗口内直接匹配最近时间点的样本”。

这份方案是在对现有代码、现有测试和上一次方案再次复核后的收敛版本。目标只有四个：

1. 把 `indicatorCache` 的唯一写入 owner 从 `timeDriverProgram` 改为 `businessEventProgram`。
2. 保持延迟验证的初始值、验证时序、趋势比较口径不变，只修改采样来源与取点方式。
3. 严格避免兼容双轨、兜底、回退和补丁式设计。
4. 在实施时彻底删除旧的时间循环写入逻辑、旧接口、旧常量、旧注释和旧测试口径，不保留遗弃代码。

---

## 2. 已确认的现状真相

### 2.1 当前链路分工

当前实现已经是“指标计算事件驱动 + 缓存写入时间驱动”的混合模式：

1. `src/main/businessEventProgram/index.ts`
   - 监听 `marketDataClient.onCandlestickUpdated(...)`
   - 在事件链路中调用 `runIndicatorPipeline(...)`
   - 把结果写回 `monitorContext.state.lastMonitorSnapshot`
   - 在同一事件链路中调用 `runSignalPipeline(...)`

2. `src/main/timeDriverProgram/index.ts`
   - 每秒 tick 一次
   - 在末尾遍历所有 monitor
   - 把 `lastMonitorSnapshot` 投影为验证样本
   - 调用 `indicatorCache.push(...)`

3. `src/main/asyncProgram/delayedSignalVerifier/utils.ts`
   - 在验证时读取 `T0 / T0+5s / T0+10s`
   - 通过 `indicatorCache.getAt(..., toleranceMs)` 做最近匹配
   - 当前明确存在 `±5s` 容差限制

### 2.2 当前延迟验证的真正业务语义

当前不能改变的业务真相只有这些：

1. `Signal.triggerTime` 仍然表示“延迟验证基准时间 `T0`”。
2. 验证实际仍然在 `T0 + 10s` 左右执行。
3. 验证仍然检查三个目标点：
   - `T0`
   - `T0+5s`
   - `T0+10s`
4. 每个验证指标仍然与 `signal.indicators1` 中的初始值比较。
5. 趋势判定口径不变：
   - `BUYCALL / SELLPUT` 要求三点都高于初始值
   - `BUYPUT / SELLCALL` 要求三点都低于初始值
   - `ADX` 仍保持“三点都低于初始值”的特殊口径
6. 任一时间点取不到值，或任一指标值缺失/无效/比较失败，整次验证直接失败。

### 2.3 当前方案中的真实问题

当前问题不是“延迟验证算法错误”，而是“样本采集 owner 和业务语义错位”：

1. 指标已经在 `K` 线事件中算出来了，但缓存样本要等主循环下一秒才写。
2. 缓存时间戳是 tick 时间，不是指标刚计算完成的时间。
3. 当前 `±5s` 容差，本质上是在补偿“每秒采样”的稀疏性，而不是业务真相。
4. 旧的固定条目数环形缓存建立在“每秒一条样本”的隐含前提上，一旦改成事件驱动高频写入，这个前提立即失效。

---

## 3. 第二轮复核后的关键结论

### 3.1 事件驱动写入必须放在 monitor route 内，而不是原始 WS listener 外层

这一点是对上一版方案的关键修正。

正确位置：

1. `businessEventProgram` 单 monitor route 内
2. `runIndicatorPipeline(...)` 成功得到 `monitorSnapshot` 之后
3. `runSignalPipeline(...)` 之前

不能直接在原始 `onCandlestickUpdated(...)` callback 最外层写缓存，原因是：

1. 当前 `businessEventProgram` 有 `per-monitor single-flight + latest-only collapse` 语义。
2. 原始 listener 只说明“有新事件到达”，不说明这次事件最终会被当前 route 消费成哪一版权威 snapshot。
3. 如果绕开现有 route，直接在 raw callback 写缓存，会导致缓存样本与 `lastMonitorSnapshot`、信号生成所使用的 snapshot 脱节。

因此最终 owner 不是“原始推送回调函数本身”，而是“现有 `businessEventProgram` 内部的单 monitor 事件处理路径”。

### 3.2 固定条目数环形缓存不能继续保留

这一点也是本次复核后的核心结论。

如果继续保留当前这种“按条目数固定容量”的 ring buffer，即使把容量调大，也仍然是不正确的设计：

1. 旧模型默认“一秒一条样本”，所以 `100 entries` 大约等于 `100 秒历史`。
2. 改成事件驱动后，`100 entries` 只代表 `100 个事件`，不再代表稳定的时间跨度。
3. 在高频推送下，`T0` 样本可能在几秒内就被覆盖掉，导致验证错误失败。

因此本次不能保留：

1. `INDICATOR_CACHE.TIMESERIES_DEFAULT_MAX_ENTRIES`
2. `IndicatorCacheOptions.maxEntries`
3. `_RingBuffer`
4. `createRingBuffer(...)`
5. `pushToBuffer(...)` 的固定容量覆盖语义

最终应改为：

1. 每个 monitor 维护按时间升序的样本队列
2. 每次写入后按“时间窗口”裁剪旧样本
3. 只保留验证所需的最近一段时间样本

这不是过度设计，而是事件驱动高频写入下保持逻辑正确的最短路径。

### 3.3 缓存保留窗口仍应保持时间语义，并继续覆盖 `maxDelaySeconds + 25s`

当前 `createPostGateRuntime` 里：

1. `maxEntries = maxDelaySeconds + 15 + 10`

这个估算来自旧的“每秒采样 + 固定条目数缓存”模型。

复核后确认，事件驱动重构后虽然不能继续保留“固定条目数”语义，但仍然必须保留原有的**时间窗口语义**：

1. 延迟信号的 `triggerTime` 仍然是未来的 `T0`
2. 验证实际发生在 `T0 + 10s`
3. `signal.indicators1` 只负责保存“延迟信号生成当下”的初始比较值，不负责代替未来 `T0 / T0+5s / T0+10s` 的样本
4. 因此缓存仍需覆盖“从延迟信号生成时刻到验证完成时刻”的完整时间跨度

也就是说，缓存保留窗口仍应继续覆盖：

1. `maxDelaySeconds`
2. `READY_DELAY_SECONDS` 对应的 10 秒
3. 现有设计中的额外 15 秒安全余量

最终语义应保持为：

1. 旧实现按“约 `maxDelaySeconds + 25s` 的每秒样本”保留历史
2. 新实现改成按“约 `maxDelaySeconds + 25s` 的时间窗口”保留事件样本
3. 改掉的是存储结构，不是历史覆盖范围

### 3.4 “不设偏离范围”只影响匹配规则，不影响内部保留窗口

用户要求：

1. 匹配 `T0 / T0+5s / T0+10s` 时，不再设置偏离范围
2. 只取缓存范围内最接近目标时间点的值
3. 取不到就失败

这个要求只作用于“验证时如何挑选样本”，不等于“缓存实现不能有自己的裁剪窗口”。

两者必须分开：

1. 业务匹配规则：
   - 不设容差
   - 不做回退
   - 只取缓存窗口内的最近值
   - 没值即失败

2. 缓存保留规则：
   - 仍需保留最近一小段时间样本
   - 只是为了不把还可能被验证使用的历史样本过早删掉
   - 不改变验证通过/失败口径

因此允许存在一个很小的技术性保留窗口，但不能把它重新包装成“业务容差”。

---

## 4. 最终方案

## 4.1 owner 重构

最终 owner 划分如下：

1. `businessEventProgram`
   - 唯一负责在普通 `K` 线事件链路中推进指标
   - 唯一负责在该链路中把最新验证样本写入 `indicatorCache`
   - 继续负责普通 immediate / delayed signals 的生成与分流

2. `timeDriverProgram`
   - 保留交易日门禁、生命周期 tick、末日保护、周期换标等时间语义职责
   - 不再负责任何 `indicatorCache` 写入
   - 不再依赖 `indicatorCache`

3. `DelayedSignalVerifier`
   - 保留验证时序与趋势比较口径
   - 改为“按目标时间点读取缓存窗口内最近样本”，不再接收时间容差参数

## 4.2 `indicatorCache` 的新语义

`indicatorCache` 的目标收敛为：

1. 为延迟验证保存最近一段时间内的事件样本
2. 样本只包含验证最小真相，不保存整份 snapshot
3. 查询时返回缓存窗口内距离目标时间最近的样本

建议的数据结构：

```ts
type VerificationSamplePoint =
  | Readonly<{ kind: 'value'; value: number }>
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'invalid' }>;

type VerificationSampleValues = Readonly<
  Partial<Record<VerificationIndicator, VerificationSamplePoint>>
>;

type IndicatorCacheEntry = {
  readonly timestamp: number;
  readonly values: VerificationSampleValues;
};
```

内部结构不再叫 ring buffer，而应改成时间队列语义，例如：

```ts
type _SampleQueue = {
  readonly entries: IndicatorCacheEntry[];
};
```

对外接口收敛为：

1. `push(monitorSymbol, values, sampleTimestampMs)`
2. `getClosest(monitorSymbol, targetTime)`
3. `clearAll()`

创建参数也必须同步收敛为时间语义，例如：

1. `createIndicatorCache({ retentionWindowMs })`
2. 或其他等价但语义明确的“按时间窗口保留”参数

不允许继续沿用任何“按条目数容量”命名。

不再保留：

1. `getAt(..., toleranceMs)`
2. `IndicatorCacheOptions.maxEntries`
3. 固定容量覆盖逻辑

## 4.3 新的样本写入时机

`businessEventProgram` 内部每次成功处理一个 monitor route 时，按以下顺序执行：

1. 读取权威 `candlestick snapshot`
2. 调用 `runIndicatorPipeline(...)`
3. 若返回 `monitorSnapshot === null`，本次 route 结束，不写缓存
4. 计算当前 route 的样本时间：
   - 使用这次标准化 `K` 线业务事件进入业务链路的观测时间
   - 不使用 `candlestick snapshot.lastBarTimestamp`
5. 取该 monitor 的延迟验证指标并集：
   - `buy verification indicators`
   - `sell verification indicators`
6. 把 `monitorSnapshot` 投影为 `VerificationSampleValues`
7. 调用 `indicatorCache.push(monitorSymbol, values, sampleTimestampMs)`
8. 继续执行 `syncSignalSeatState(...)`
9. 继续执行 `runSignalPipeline(...)`

这里不使用 `candlestick snapshot.lastBarTimestamp`，原因如下：

1. 目标是记录真实业务事件时间轴，而不是 1 分钟 bar 时间轴
2. 若使用 bar 时间，同一分钟内多次推送会写出同一个时间点，直接违背这次重构目标
3. 若简单使用 route 内部晚到的 `Date.now()`，又会把 single-flight 排队等待时间错误写进样本时间轴

但这里有一个必须先补齐的实现前提：

1. 当前 `businessEventProgram` 的 route state 只有 `inFlight / dirty`
2. 当前 raw listener 进入 route 时并没有把“这次事件被 owner 观测到的时间”保存下来
3. 在 `single-flight + latest-only collapse` 语义下，多个事件可能会折叠成一次 route 执行
4. 如果不显式补一个 route 级时间字段，最终写入时就无法严格判定该样本时间到底代表：
   - 首个到达事件时间
   - 最后一个到达事件时间
   - 还是 route 真正执行时的处理时间

因此正确口径必须同时包括：

1. raw `onCandlestickUpdated(...)` callback 在确认 monitor 命中后，立刻捕获 `observedAtMs = Date.now()`
2. `triggerMonitorRoute(...)` 不再只传 `monitorSymbol`，而是把这次 `observedAtMs` 写进 route state
3. route state 需要从当前的 `{ inFlight, dirty }` 扩展为至少包含：
   - `inFlight`
   - `dirty`
   - `pendingObservedAtMs`
4. 若同一 monitor 在 route 执行期间再次收到新事件：
   - `dirty = true`
   - `pendingObservedAtMs` 直接覆盖为**最新一次**事件的观测时间
5. route 每轮消费时先读取并清空本轮要使用的 `pendingObservedAtMs`
6. 本轮 `runIndicatorPipeline(...)` 成功后，用这次被消费的 `pendingObservedAtMs` 写入 `indicatorCache`
7. 这样才能保证样本时间表达的是“当前这版权威 snapshot 在业务 owner 侧真正生效的事件时间”，而不是“bar 所属时刻”或“排队消费时刻”

## 4.4 `DelayedSignalVerifier` 的新匹配规则

新的验证规则如下：

1. 目标点仍然是：
   - `t0 = triggerTime`
   - `t1 = triggerTime + 5s`
   - `t2 = triggerTime + 10s`

2. 对每个目标点，执行：
   - `entry = indicatorCache.getClosest(monitorSymbol, targetTime)`

3. 不再做：
   - `diff <= toleranceMs` 判断
   - `±5s` 业务容差放行
   - 超出缓存窗口但“勉强接受”的逻辑

4. 失败口径保持严格：
   - 队列为空或取不到样本，直接失败
   - 样本里指标为 `missing`，直接失败
   - 样本里指标为 `invalid`，直接失败
   - 样本值不满足趋势比较，直接失败

5. 日志中仍可以记录：
   - 每个目标点与实际命中样本的时间差

但这个时间差只用于观测，不再参与通过判断。

这里再补一条执行时态边界：

1. “最近值”是基于**验证实际执行时** `indicatorCache` 中当前仍保留的样本集合来计算
2. 不额外冻结一份 “triggerTime 当下可见样本集”
3. 不额外引入“验证开始时先截断未来样本”的二次规则
4. 否则就会把当前已经明确的“最近值”需求重新改写成另一套隐式业务语义

5. 允许出现以下业务现象：
   - 若 `T0` 到 `T0+10s` 期间没有新的 `K` 线业务事件
   - 同一个旧样本可以同时覆盖 `T0 / T0+5s / T0+10s`
   - 这表示“同一最近样本同时成为三个目标点的最近值”，属于允许语义，不视为失败

6. 最近值匹配的方向性定义如下：
   - 不强制要求命中样本必须早于目标时间
   - 只要样本仍在缓存保留窗口内，且它距离目标时间最近，就允许命中
   - 因此允许某个目标点命中晚于该目标时间的样本
   - 这是本次需求显式要求的“最近值”语义，不是旧语义下的“前值”或“左值”

7. 等距规则必须固定：
   - 若两个样本与目标时间点完全等距
   - 优先命中时间更晚的样本
   - 这样与“最近值”语义保持一致，避免实现阶段出现摇摆

8. 这里必须明确一条边界：
   - 既然需求已经明确要求“最近值”
   - 那么实现上就不允许再偷偷收窄回“只取前值”或“只取不晚于目标时间的值”
   - 否则就会再次偏离当前需求

---

## 5. 必须删除的旧逻辑

本次必须成组删除，不能保留兼容空壳。

### 5.1 删除 `timeDriverProgram` 中的旧写入逻辑

必须删除：

1. `src/main/timeDriverProgram/index.ts` 中末尾遍历 `monitorContexts` 写 `indicatorCache` 的整段代码
2. 该文件中的：
   - `projectVerificationSampleValues` import
   - `VerificationIndicator` import
3. `src/main/timeDriverProgram/types.ts` 中的 `indicatorCache` 依赖
4. `runApp` 传给 `timeDriverProgram(...)` 的 `indicatorCache` 参数

### 5.2 删除旧的容差匹配接口

必须删除：

1. `VERIFICATION.TIME_TOLERANCE_MS`
2. `IndicatorCache.getAt(..., toleranceMs)`
3. `findClosestEntry(..., toleranceMs)` 中的容差过滤逻辑
4. 所有围绕“容差窗口命中”的注释、测试名称和断言

### 5.3 删除固定条目数缓存语义

必须删除：

1. `INDICATOR_CACHE.TIMESERIES_DEFAULT_MAX_ENTRIES`
2. `IndicatorCacheOptions`
3. `_RingBuffer`
4. `createRingBuffer(...)`
5. `pushToBuffer(...)`
6. `createPostGateRuntime(...)` 中基于“条目数”估算缓存容量的逻辑

必须保留：

1. `maxDelaySeconds + 25s` 这一时间覆盖范围
2. 只是把它从“每秒采样下的条目数”改写成“事件驱动下的时间窗口”
3. `createPostGateRuntime(...)` 必须把这个覆盖范围转换成明确的时间窗口参数，例如 `retentionWindowMs`

### 5.4 删除所有旧注释与文档口径

必须同步更新或删除：

1. `indicatorCache` 模块头注释里“timeDriverProgram 每秒 push(...)”
2. `DelayedSignalVerifier` 模块头注释里“时间容忍度 ±5 秒”
3. `core-program-business-logic` 中延迟验证的旧描述
4. 与旧接口绑定的类型注释、测试说明、集成测试说明

不允许出现“代码已改，注释还在描述旧实现”的遗留状态。

---

## 6. 文件级改动范围

### 6.1 核心实现

必须修改：

1. `src/main/businessEventProgram/index.ts`
2. `src/main/businessEventProgram/types.ts`
3. `src/main/businessEventProgram/indicatorPipeline.ts`
4. `src/main/asyncProgram/indicatorCache/index.ts`
5. `src/main/asyncProgram/indicatorCache/types.ts`
6. `src/main/asyncProgram/indicatorCache/utils.ts`
7. `src/main/asyncProgram/delayedSignalVerifier/index.ts`
8. `src/main/asyncProgram/delayedSignalVerifier/utils.ts`
9. `src/main/asyncProgram/delayedSignalVerifier/types.ts`
10. `src/main/timeDriverProgram/index.ts`
11. `src/main/timeDriverProgram/types.ts`
12. `src/app/runApp.ts`
13. `src/app/types.ts`
14. `src/app/runtime/createPostGateRuntime.ts`
15. `src/constants/index.ts`

### 6.2 注释 / 业务文档 / 类型契约

必须同步修改：

1. `src/types/monitorContextPorts.ts`
2. `src/types/state.ts`
3. `src/types/services.ts`
4. `docs/plans` 或 `docs/issues` 中与旧口径明确冲突的文档
5. `.codex/skills/core-program-business-logic/SKILL.md` 中延迟验证描述

最后一项不是功能代码，但如果保留旧描述，会变成仓库内部的业务死文档。

### 6.3 重点测试

必须修改：

1. `tests/main/asyncProgram/delayedSignalVerifier/business.test.ts`
2. `tests/main/asyncProgram/indicatorCache/utils.test.ts`
3. `tests/main/businessEventProgram/business.test.ts`
4. `tests/integration/main-loop-latency.integration.test.ts`
5. `tests/integration/full-business-simulation.integration.test.ts`
6. `tests/integration/main-program-strict.integration.test.ts`

---

## 7. 实施顺序

### Step 1: 先改 owner 接线

1. 给 `BusinessEventProgramDeps` 增加 `indicatorCache`
2. 给 `businessEventProgram` route 增加本次业务事件观测时间的传递能力
3. `runApp` 创建 `businessEventProgram` 时传入 `postGateRuntime.indicatorCache`
4. `timeDriverProgram` 类型和调用链移除 `indicatorCache`

完成标准：

1. `indicatorCache` 的唯一生产接线入口已经转到 `businessEventProgram`
2. `timeDriverProgram` 编译期不再知道 `indicatorCache`

### Step 2: 在事件链路中落样本

1. 在 `businessEventProgram` monitor route 内，`runIndicatorPipeline(...)` 成功后立即写缓存
2. 写入时间使用本次业务事件观测时间
3. 写入内容仍然只投影验证最小样本
4. `runSignalPipeline(...)` 保持在写缓存之后执行

完成标准：

1. 任何一次成功的指标推进，都会同步生成一条事件样本
2. 不存在“事件已算完指标，但要等主循环下一秒才写缓存”的旧行为

### Step 3: 改造 `indicatorCache`

1. 移除固定容量 ring buffer
2. 改成按时间窗口裁剪的时间队列
3. 对外只保留 `getClosest(...)`
4. 保留窗口继续使用 `maxDelaySeconds + 25s`

完成标准：

1. 缓存语义只和时间有关，不和“写入了多少条事件”有关
2. 高事件频率下，`T0` 样本不会因为固定条目数过小而被错误覆盖
3. 低事件频率下，只要旧样本仍在缓存保留窗口内，它仍可能作为三个目标点的最近样本被命中

### Step 4: 改造 `DelayedSignalVerifier`

1. 保留 `t0 / t0+5 / t0+10`
2. 删除容差参数
3. 改为“只取缓存窗口内最接近目标时间点的样本”
4. 缺值直接失败

完成标准：

1. 延迟验证不再依赖任何“允许偏离范围”
2. 通过/失败只由“缓存窗口内是否存在可用最近样本”以及趋势比较结果决定
3. 允许同一个旧样本覆盖多个目标点

### Step 5: 收尾删除旧代码

1. 删除旧常量
2. 删除旧类型
3. 删除旧注释
4. 删除旧测试口径
5. 删除旧集成测试中**仅服务于 `timeDriverProgram` 每秒写缓存语义**的 `indicatorCache` 注入和断言残留

完成标准：

1. 仓库内不再出现“每秒写缓存”“容差 ±5s”“maxEntries ring buffer”相关残留

---

## 8. 严格禁止

### 8.1 不允许的兜底 / 回退

1. 不允许保留 `timeDriverProgram` 写缓存作为兼容路径
2. 不允许新增“事件驱动写失败时由主循环补写”的回退
3. 不允许在匹配不到最近样本时，退回到任意更远样本或最新样本
4. 不允许保留 `toleranceMs` 参数但传一个极大值伪装为“最近值匹配”
5. 不允许出现“如果缓存太短就继续放大 maxEntries”的补丁方案

### 8.2 不允许的过度设计

1. 不引入新的跨模块 sample owner
2. 不让 `indicatorCache` 反向感知 `DelayedSignalVerifier.pendingSignals`
3. 不新增第二套持久化缓存
4. 不把验证样本扩展回整份 `IndicatorSnapshot`
5. 不为“也许以后还要兼容旧逻辑”保留 no-op 包装、别名方法或弃用字段

### 8.3 不允许保留的死代码

1. 不允许保留 `_RingBuffer`、`createRingBuffer`、`pushToBuffer`
2. 不允许保留 `IndicatorCacheOptions.maxEntries`
3. 不允许保留 `VERIFICATION.TIME_TOLERANCE_MS`
4. 不允许保留旧 `getAt(...)` 签名
5. 不允许保留任何仍然描述旧行为的注释和文档

---

## 9. 验收标准

### 9.1 结构验收

1. 在生产实现代码（`src/`）中，`indicatorCache.push(...)` 的唯一 owner 是 `businessEventProgram`
2. `timeDriverProgram` 中不再出现 `indicatorCache`
3. 仓库内不再有 `TIME_TOLERANCE_MS`
4. 仓库内不再有 `_RingBuffer`、`maxEntries`
5. 仓库内不再有“主循环每秒写验证缓存”的注释或测试说明

### 9.2 业务验收

1. `K` 线事件到达并成功推进指标后，缓存样本立即写入
2. 延迟验证仍然检查 `T0 / T0+5s / T0+10s`
3. 延迟验证不再设置偏离范围
4. 每个目标点只取缓存窗口内最近样本
5. 任一点取不到样本直接失败
6. 趋势比较口径与 ADX 特殊规则完全不变
7. 在长时间无新推送时，同一个旧样本允许覆盖多个目标点
8. 缓存时间覆盖范围继续保持 `maxDelaySeconds + 25s`
9. 等距时优先命中更晚样本

### 9.3 清理验收

1. 所有旧接口、旧常量、旧注释、旧测试口径全部删除
2. 不存在双轨
3. 不存在 no-op 兼容层
4. 不存在“虽然代码不再使用，但先留着”的遗弃实现

---

## 10. 一句话结论

这次重构的正确做法不是把旧的“每秒 ring buffer”简单搬到事件链路，而是：

**把验证样本写入 owner 改成 `businessEventProgram`，把缓存从固定条目数 ring buffer 改成按 `maxDelaySeconds + 25s` 时间窗口保留的事件样本队列，并把延迟验证改成“按目标时间点读取缓存窗口内最近样本”，彻底删除旧的主循环写入、容差匹配和固定容量语义。**
