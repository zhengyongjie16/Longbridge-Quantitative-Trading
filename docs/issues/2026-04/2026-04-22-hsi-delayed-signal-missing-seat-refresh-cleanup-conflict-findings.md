# HSI 满足做多条件但未生成延迟信号的问题分析记录

## 1. 结论先行

本次问题的表象是：

- `2026-04-22 13:06:09.046` 的 `HSI.HK` 监控日志已经满足 BUYCALL 条件；
- 但系统没有为 HSI 对应做多标的创建延迟验证信号。

经过日志与代码双向复核，结论如下：

1. **这不是 delayed verifier 本身的单点判断 bug。**
2. **已经证实的问题是：HSI 在 `10:45` 周期换标后，没有处于后续普通信号生成所要求的 `ACTIVE` 席位状态。**
3. **已经证实的问题是：普通信号生成链路只接受 `ACTIVE` 席位；因此即使后续 `HSI.HK` 监控指标满足 BUYCALL，也不会创建 delayed signal。**
4. **当前最强根因假设是：周期换标后的席位恢复链路与队列清理链路发生结构性冲突，恢复该席位所必需的 `SEAT_REFRESH` monitor task 很可能被席位同步清理逻辑误删。**
5. 关于“`SEAT_REFRESH` 已被误删”这一点，当前代码和日志能够证明它**具备被误删的条件**，且现象与该路径高度一致；但在缺少 `SEAT_REFRESH scheduled / removed / skipped / processed` 直接日志前，不应把它升级为已证实事实。

换言之，本问题背后不是“延迟验证条件判断错了”，而是：

**已经证实的结果是 seat 未处于 `ACTIVE`，导致信号生成前提不成立；当前最强根因假设是 seat 恢复链路在 monitor task 清理阶段被切断。**

---

## 2. 问题现象与日志证据

### 2.1 触发点日志

`logs/system/2026-04-22.log:15591`

```text
[INFO] 2026-04-22 13:06:09.046 [监控标的] 恆生指數(HSI.HK) 价格=26094.350 涨跌幅=-1.48% RSI6=17.737 MFI=13.036 K=4.204 D=12.589 J=-12.565
```

结合当日配置日志：

`logs/system/2026-04-22.log:25`

```text
BUYCALL: (RSI:6<20,MFI<15,D<20,J<0)|(J<-25)
```

可知这组指标满足第一组条件：

- `RSI6 < 20`
- `MFI < 15`
- `D < 20`
- `J < 0`

因此，从“监控标的指标条件”角度看，这一时刻应当满足 BUYCALL 触发条件。

### 2.2 同时间窗没有 HSI 对应的延迟验证信号日志

在 `13:05` 到 `13:06` 的 debug 日志中，可以看到大量 `9988.HK / 60544.HK` 的 `[延迟验证信号]`，例如：

`logs/debug/2026-04-22.log:2277-2362`

但同一时间窗内：

- 没有 `HSI.HK`
- 没有 `55721.HK`
- 没有 `60054.HK`
- 没有对应 HSI LONG/SHORT 新旧标的的 `[延迟验证信号]`

这说明问题不是“HSI 创建了 delayed signal 但后续验证失败”，而是：

**HSI 在该时间窗里根本没有创建 delayed signal。**

### 2.3 HSI 在更早时间已经发生周期换标

`logs/system/2026-04-22.log:6891-6896`

```text
[INFO] 2026-04-22 10:45:00.747 [自动寻标] 主条件命中牛证：HSI.HK -> 60054.HK
[INFO] 2026-04-22 10:45:00.748 [自动换标] HSI.HK LONG 进入换标中状态: 周期换标触发
[INFO] 2026-04-22 10:45:01.306 [自动寻标] 主条件命中熊证：HSI.HK -> 66741.HK
[INFO] 2026-04-22 10:45:01.306 [自动换标] HSI.HK SHORT 进入换标中状态: 周期换标触发
```

说明 HSI 在 `10:45` 已经从旧席位标的：

- LONG：`55721.HK`
- SHORT：`66270.HK`

转向新的预寻标候选：

- LONG：`60054.HK`
- SHORT：`66741.HK`

### 2.4 换标后立即发生队列清理

`logs/system/2026-04-22.log:6900-6901`

```text
[DEBUG] 2026-04-22 10:45:01.533 [席位同步] HSI.HK LONG 清理待执行信号：延迟=0 买入=0 卖出=0 监控任务=2
[DEBUG] 2026-04-22 10:45:01.533 [席位同步] HSI.HK SHORT 清理待执行信号：延迟=0 买入=0 卖出=0 监控任务=2
```

这两条日志非常关键，说明在 HSI 换标进入非 ACTIVE 状态后，系统对两个方向都做了 monitor task 清理，并且每个方向都清掉了 `2` 个 monitor task。

### 2.5 后续没有看到 HSI 新席位进入激活完成或 ACTIVE 的证据

从 `10:45` 之后的系统日志看：

- 可以看到 HSI 监控标的指标继续刷新；
- 但没有看到 HSI 新标的进入 `ACTIVATING` / `ACTIVE` 的日志证据；
- 也没有看到 HSI 新标的对应的延迟信号日志；
- 到 `13:06` 时，问题仍然存在。

这与“席位恢复链路被切断”完全一致。

---

## 3. 代码级根因分析

## 3.1 普通信号生成只接受 ACTIVE 席位

关键代码：`src/utils/utils.ts:14-22`

```ts
function resolveActiveSeatSymbol(seatState: SeatState): string | null {
  if (seatState.status !== 'ACTIVE') {
    return null;
  }

  return typeof seatState.symbol === 'string' && seatState.symbol.length > 0
    ? seatState.symbol
    : null;
}
```

`resolveMonitorContextSeatSnapshot()` 只会为 `ACTIVE` seat 派生：

- `longSymbol`
- `shortSymbol`

见：`src/utils/utils.ts:32-49`

因此，只要 seat 不是 `ACTIVE`，下游看到的 `longSymbol/shortSymbol` 就是 `null`。

## 3.2 信号生成层拿不到 ACTIVE symbol 时，会直接不生成该方向信号

关键代码：`src/core/strategy/index.ts:295-350`

```ts
if (longSymbol) {
  const buyLongResult = generateSignal(... 'BUYCALL' ...);
}

if (shortSymbol) {
  const buyShortResult = generateSignal(... 'BUYPUT' ...);
}
```

这意味着：

- 如果 `longSymbol === ''` 或 `null`，就不会进入 BUYCALL 生成分支；
- 不是“生成后被 prepareSignal 丢掉”；
- 而是更早阶段根本不生成信号对象。

因此，`HSI.HK` 在 `13:06:09` 虽然监控指标满足 BUYCALL 条件，但只要对应 LONG seat 不是 `ACTIVE`，就会出现：

**监控日志满足条件，但 delayed signal 根本不存在。**

## 3.3 周期换标与席位同步清理存在顺序冲突

关键代码：`src/main/processMonitor/index.ts:44-59`

```ts
scheduleAutoSymbolTasks(...);

const seatInfo = syncSeatState(...);
```

当前时间循环中，先调度 `AUTO_SYMBOL_TICK`，再做 `syncSeatState`。

而 `syncSeatState()` 内部会调用 `syncSignalSeatState()`，当发现 seat 从 `ACTIVE` 退化为非 `ACTIVE` 时，会触发清理：

见：`src/main/processMonitor/seatSync.ts:90-106`

```ts
if (previousLongSeatState.status === 'ACTIVE' && longSeatState.status !== 'ACTIVE') {
  clearSignalDirectionRuntime(...);
}

if (previousShortSeatState.status === 'ACTIVE' && shortSeatState.status !== 'ACTIVE') {
  clearSignalDirectionRuntime(...);
}
```

这意味着一旦周期换标让 seat 从 `ACTIVE` 进入 `SWITCHING/ACTIVATING`，时间循环下一轮就会触发对应方向清理。

## 3.4 清理逻辑会删除该方向全部 monitor tasks

关键代码：`src/main/processMonitor/utils.ts:77-99`

```ts
const removedMonitorTasks = monitorTaskQueue.removeTasks(
  (task) => task.monitorSymbol === monitorSymbol && isMonitorTaskForDirection(task, direction),
);
```

而 `isMonitorTaskForDirection()` 的判断规则是：

见：`src/main/processMonitor/utils.ts:37-50`

```ts
const isDirectionMatch = task.data['direction'] === direction;
return isDirectionMatch || isSharedTask;
```

也就是说，只要 monitor task 的 `data.direction` 与当前方向一致，就会被视为该方向任务并被清理。

## 3.5 `SEAT_REFRESH` 正好满足被清理条件

`SEAT_REFRESH` 的 payload 定义见：`src/main/asyncProgram/monitorTaskProcessor/types.ts:41-49`

```ts
export type SeatRefreshTaskData = Readonly<{
  monitorSymbol: string;
  direction: 'LONG' | 'SHORT';
  seatVersion: number;
  previousSymbol: string | null;
  nextSymbol: string;
  callPrice?: number | null;
  symbolName: string | null;
}>;
```

其中明确带有：

- `direction`

因此它会被 `isMonitorTaskForDirection()` 判断为“属于该方向的 monitor task”。

也就是说：

**席位进入非 ACTIVE 后的方向性队列清理，会把 `SEAT_REFRESH` 一起删掉。**

## 3.6 但 `SEAT_REFRESH` 恰恰是 seat 从 ACTIVATING 回到 ACTIVE 的唯一恢复屏障

`SeatActivationDispatcher` 在 seat 进入 `ACTIVATING` 时，会 schedule 一个 `SEAT_REFRESH`：

见：`src/main/seatActivationDispatcher/index.ts:47-60`

```ts
params.deps.monitorTaskQueue.scheduleLatest({
  type: 'SEAT_REFRESH',
  dedupeKey: `${params.monitorSymbol}:SEAT_REFRESH:${params.direction}`,
  ...
});
```

`SEAT_REFRESH` 处理器的职责是：

- quote admission
- 订单记录刷新
- risk cache 初始化
- warrant info 初始化
- 最终把 seat 推进到 `ACTIVE`

见：`src/main/asyncProgram/monitorTaskProcessor/handlers/seatRefresh.ts:121-243`

最终推进 ACTIVE 的关键位置：

`src/main/asyncProgram/monitorTaskProcessor/handlers/seatRefresh.ts:236-241`

```ts
context.symbolRegistry.updateSeatState(data.monitorSymbol, data.direction, {
  ...latestSeatState,
  status: 'ACTIVE',
  lastSeatActivatedAt: Date.now(),
  callPrice: data.callPrice,
});
```

因此，如果 `SEAT_REFRESH` 被删：

- seat 会停在 `ACTIVATING` 或更早的非 ACTIVE 状态；
- 下游拿不到 ACTIVE symbol；
- 普通信号链路不会生成 delayed signal。

---

## 4. 对本次 HSI 问题的闭环解释

将日志与代码结合后，本次问题可以完整解释为：

1. `10:45` HSI 触发周期换标，LONG/SHORT 分别命中新候选 `60054.HK/66741.HK`。
2. 状态机把 seat 从 `ACTIVE` 推进到 `SWITCHING`，后续理论上应进入 `ACTIVATING`，并由 `SEAT_REFRESH` 推进到 `ACTIVE`。
3. seat 退化为非 `ACTIVE` 后，`syncSeatState()` 会触发方向性清理。
4. 该清理逻辑会删除该方向的 monitor tasks。
5. `SEAT_REFRESH` 恰好属于该方向的 monitor task，因此**存在被误删的高概率路径**；当前现象与该路径高度一致，但在缺少直接运行态日志前，仍应保持为根因假设，而不是已证实事实。
6. 已证实的结果是：到 `13:06:09`，虽然 `HSI.HK` 的监控指标满足 BUYCALL，但 LONG seat 不具备普通信号生成所要求的 `ACTIVE` 条件。
7. `strategy.generateSignals()` 因拿不到 `longSymbol`，不会创建 BUYCALL delayed signal。

所以，本问题的最准确表述不是：

- “HSI delayed verifier 没有工作”

而是：

- **“已经证实的结果是 HSI 在 13:06 不具备普通信号生成所要求的 ACTIVE 席位条件；当前最强根因假设是 10:45 周期换标后的 seat 恢复链路在 monitor task 清理阶段被切断。”**

---

## 5. 严重性评估

本问题属于**严重的结构性逻辑问题**，原因如下：

1. **影响核心交易前提**：seat 是否 ACTIVE 直接决定信号链路能否工作。
2. **不是局部条件 bug**：问题发生在状态机、事件驱动恢复、monitor task 清理三条链路交界处。
3. **会导致静默失效**：用户只能看到指标满足，但系统没有信号，排障难度高。
4. **具有系统性传播风险**：只要其他 monitor 在周期换标、距离换标或类似 ACTIVE→非 ACTIVE→恢复流程中复用同一清理逻辑，都可能命中同类问题。
5. **日志可观测性不足**：当前缺少 `SEAT_REFRESH scheduled / removed / skipped / processed` 的直接日志，容易把问题误判为 delayed verifier 问题。

---

## 6. 影响范围

当前已确认的直接影响范围包括：

1. `HSI.HK` 在 `2026-04-22 10:45` 周期换标后的普通信号生成链路。
2. 所有依赖 `ACTIVE` seat 的普通信号生成场景：
   - `BUYCALL`
   - `SELLCALL`
   - `BUYPUT`
   - `SELLPUT`
3. 所有依赖 `SEAT_REFRESH` 完成 activation barrier 的 seat 恢复链路。

潜在影响范围包括：

1. 其他 monitor symbol 的周期换标。
2. 距离换标或其他 seat phase 切换场景。
3. 任何“恢复任务本身会被恢复前清理逻辑删除”的 monitor task 语义。

---

## 7. 修复方向建议

本次文档只记录问题与根因，不直接展开完整修复方案；但复核后可确认的修复方向如下：

### 7.1 必须修正席位退化时的 monitor task 清理边界

目标：

- seat 从 `ACTIVE` 退化为 `SWITCHING/ACTIVATING` 时，不能把恢复 seat 所必需的 `SEAT_REFRESH` 删除。

最短路径要求：

- `clearMonitorDirectionQueues()` 不再无差别删除所有该方向 monitor tasks；
- 当前 bug 的最小修复应直接把 `SEAT_REFRESH` 排除出这条方向性 monitor task 清理范围。

这里的最小修复属于直接修正错误的任务边界，不属于兜底、回退或兼容补丁。

### 7.2 不把“任务拆层”作为当前问题的首选修复方案

当前 monitor task 把：

- `AUTO_SYMBOL_TICK`
- `SEAT_REFRESH`

放在同一队列、同一方向匹配规则下清理，语义确实偏粗糙；但在当前问题上，先做“恢复型任务与普通任务彻底拆层”会扩大改动面。

因此，本次问题的首选修复不应直接上升为任务体系重构；只有在最小边界修复不能闭合问题时，才应再评估是否需要更大的任务分层重构。

### 7.3 必须补回归测试

至少需要覆盖：

1. 周期换标完成后，seat 最终回到 `ACTIVE`。
2. `SEAT_REFRESH` 不会在 ACTIVE→SWITCHING/ACTIVATING 的清理中被误删。
3. 当 monitor 指标满足 BUYCALL 且 seat 已恢复 ACTIVE 时，能正常创建 delayed signal。

### 7.4 必须补运行态可观测日志

至少补充以下日志：

- `SEAT_REFRESH scheduled`
- `SEAT_REFRESH removed`
- `SEAT_REFRESH skipped`
- `SEAT_REFRESH processed`

这些日志不是兜底逻辑，而是为了把当前“高概率根因”提升为可直接证明的运行态证据。

---

## 8. 建议补充的代码定位索引

本次问题直接相关的关键文件如下：

1. seat 可消费 symbol 暴露：
   - `src/utils/utils.ts:14-49`
2. 周期换标状态机：
   - `src/services/autoSymbolManager/switchStateMachine.ts:820-971`
3. seat 进入 ACTIVATING 后调度 `SEAT_REFRESH`：
   - `src/main/seatActivationDispatcher/index.ts:34-60`
4. `SEAT_REFRESH` 把 seat 推进到 `ACTIVE`：
   - `src/main/asyncProgram/monitorTaskProcessor/handlers/seatRefresh.ts:121-243`
5. 时间循环中先调度自动换标，再做 seat sync：
   - `src/main/processMonitor/index.ts:44-59`
6. seat 从 ACTIVE 退化时触发清理：
   - `src/main/processMonitor/seatSync.ts:76-118`
7. monitor task 清理会删除该方向全部 monitor tasks：
   - `src/main/processMonitor/utils.ts:37-107`
8. 普通信号生成依赖 `longSymbol/shortSymbol`：
   - `src/core/strategy/index.ts:281-354`

---

## 9. 一句话结论

本次 HSI 满足做多条件但未生成延迟信号的根因，不是延迟验证器判断错误，而是：

**周期换标后 seat 恢复链路依赖的 `SEAT_REFRESH` 与 ACTIVE 退化清理链路发生冲突，导致席位未回到 `ACTIVE`，最终使普通信号链路根本没有创建 delayed signal。**
