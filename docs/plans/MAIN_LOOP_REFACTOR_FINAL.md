# 主循环异步重构最终方案

## 背景与目标

目标：主循环保持每秒 tick，不被 K 线获取与指标计算阻塞；其余业务逻辑保持不变。

问题根因：`processMonitor` 每秒同步执行 `getCandlesticks` + `buildIndicatorSnapshot`，再由 `mainProgram` 等待所有监控标的完成，导致延迟累积。

## 约束

- 保持交易规则、风控逻辑、队列调度与订单监控一致。
- 行情读取继续从 WebSocket 缓存获取，不新增行情 API 请求。
- 仅剥离“重计算链路”，不做额外性能优化。
- 不使用多线程，仅异步非阻塞。

## 最终方案概述

最终方案 = “异步 IndicatorWorker + 单标的单飞节流”。

核心思想：主循环每秒触发指标计算，但不等待；计算完成后再写入指标缓存并生成/分流信号。

## 设计细节补充（避免歧义）

为避免实现偏差，以下细节需在落地前达成一致：

### 1) 基线与迁移范围
- 当前基线：`processMonitor` 同步完成行情读取、K线获取、指标计算、指标监控、写缓存、信号生成与分流。
- 本次重构只迁移“重计算链路”到 Worker，其余交易/风控/队列/订单监控逻辑保持不变。

### 2) 单标的单飞/节流语义
- 同一监控标的一次只允许一个 Worker 任务在跑，避免并发重入。
- 若上一轮未完成，新 tick 的处理策略 = 直接跳过，不排队不并发。
- 若担心延迟验证缺时间点，可在“跳过 tick”时写入占位快照（见下）。

### 3) 时间戳与 T0/T1/T2 对齐
- IndicatorCache 的时间戳应与信号 `triggerTime` 的基准一致，避免时间漂移。
- 推荐：Worker 启动时捕获 `tickTime` 并贯穿使用（写缓存与生成信号时使用同一时间基准）。
- 若仍用分散的 `Date.now()`，需接受可能的时间漂移，并通过容忍度/占位快照缓解。

### 4) Worker 输入/输出与状态归属
- 输入：`monitorContext`（strategy/state/periods）、`monitorQuote`（prevClose）、`indicatorCache`、`marketMonitor`、`runtimeFlags`。
- 输出：`indicatorCache.push`、`monitorIndicatorChanges`、`state.lastMonitorSnapshot`、信号分流（队列或延迟验证器）。
- 对象池释放逻辑与原流程保持一致。

### 5) 开盘保护与交易时段语义
- `openProtectionActive=true` 时仍计算/写缓存，但不生成信号、不推队列、不进验证器。
- `canTradeNow=false` 时主循环已返回，不再触发 Worker；若 Worker 已在运行，完成后也应跳过信号生成（仅写缓存）。

### 6) 无效占位快照的边界
- 触发条件：K线获取失败、指标计算异常或返回 null、或单飞节流导致跳过 tick（如需保持时间序列连续）。
- 行为：写入占位快照，仅用于延迟验证；不监控指标变化、不生成信号。
- 占位快照不覆盖 `state.lastMonitorSnapshot`，避免影响后续风险检查与对象池释放。
- `price` 当前类型为 `number`，若使用 `NaN` 需明确其对风险检查的影响；如需避免影响，应保持 `monitorQuote` 优先或扩展类型支持 `null`。

### 模块职责调整

1. **`IndicatorWorker`（新增）**
   - 负责：K 线获取 → 指标计算 → 指标变化监控 → 指标缓存 → 信号生成与分流
   - 每个监控标的单飞，避免并发重入

2. **`processMonitor`（轻量化）**
   - 仅负责：
     - 行情写入 `monitorContext`（供处理器读取）
     - 价格变化监控
     - 浮亏监控（价格变化时）
     - 触发 `IndicatorWorker`（不等待）
   - 移除：K 线获取、指标计算、指标监控、信号生成与分流

3. **`mainProgram`（保持一致）**
   - 继续执行交易日/时段判断、末日保护、订单监控与缓存刷新
   - 仍可保留 `Promise.allSettled`（`processMonitor` 已轻量化）

## 关键业务逻辑保持一致

- **交易时段与末日保护**：仍在主循环中同步执行；不改变时序。
- **开盘保护**：开盘保护期间仍可计算指标与写缓存，但**不生成信号**。
- **延迟验证**：仍通过 `IndicatorCache` 获取 T0/T1/T2 时间点数据；验证逻辑不变。
- **买卖队列与处理器**：仍由 `BuyProcessor`/`SellProcessor` 异步消费，生命周期管理保持不变。

## 异常与占位规则（新增要求）

当 **K 线获取失败**、**指标计算异常/返回 null**，或 **单飞节流导致本 tick 跳过计算** 时：

- **不复用上次快照作为当前快照**
- **写入无效快照作为占位**（保证时间序列连续）
- 延迟验证读取该占位快照时，`getIndicatorValue` 将返回 `null`，从而触发**验证失败**，符合预期
- 无效快照仅用于缓存时间序列，不覆盖 `state.lastMonitorSnapshot`

建议的无效快照结构（示例）：

```
{
  symbol: monitorSymbol,
  price: NaN,
  changePercent: null,
  ema: null,
  rsi: null,
  psy: null,
  mfi: null,
  kdj: null,
  macd: null
}
```

说明：
- 占位快照必须写入 `IndicatorCache`，保证 T0/T1/T2 时间点存在。
- 无效快照不参与指标变化日志，也不触发信号生成。

## 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| 指标计算重入 | 并发 K 线调用与对象池冲突 | Worker 单标的单飞 |
| 异常导致延迟验证缺数据 | 大量“缺少时间点数据”日志 | 异常时写入无效占位快照 |
| 指标日志丢失 | 可观测性下降 | `monitorIndicatorChanges` 迁移到 Worker |

## 改动清单（最小范围）

新增：
- `src/main/asyncProgram/indicatorWorker/index.ts`
- `src/main/asyncProgram/indicatorWorker/types.ts`
- （可选）`src/main/asyncProgram/indicatorWorker/utils.ts`

修改：
- `src/main/processMonitor/index.ts`：移除重计算链路，改为触发 Worker
- `src/main/mainProgram/index.ts`：注入 Worker（逻辑保持）
- `src/main/mainProgram/types.ts`：补充 Worker 类型
- `src/index.ts`：初始化并注入 Worker
- `src/services/cleanup/index.ts`：销毁 Worker

## 验证要点

- 主循环 tick 仍保持 1 秒节奏（无明显延迟累积）
- 延迟验证无“缺少时间点数据”爆量日志（异常时应为“验证失败”而非缺数据）
- 指标日志仍正常输出
- 买卖队列与风控逻辑无行为变化

## 回滚方案

恢复以下文件至改造前版本并移除新增模块：

- `src/main/processMonitor/index.ts`
- `src/main/mainProgram/index.ts`
- `src/index.ts`
- 删除新增 `indicatorWorker` 目录
