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

当 **K 线获取失败** 或 **指标计算异常/返回 null** 时：

- **不写入上次快照**
- **写入无效快照作为占位**（保证时间序列连续）
- 延迟验证读取该占位快照时，`getIndicatorValue` 将返回 `null`，从而触发**验证失败**，符合预期

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
