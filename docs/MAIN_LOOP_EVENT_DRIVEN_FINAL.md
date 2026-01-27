# 主循环事件驱动改造最终方案

## 目标与约束

目标：把主循环改为“每秒读取缓存 + 触发异步计算”的模式，避免 K 线获取与指标计算阻塞主循环；同时不做不必要的优化改动。

约束：
- 维持每秒 tick 节奏（`TRADING.INTERVAL_MS`）。
- 行情读取仍从 WebSocket 缓存获取（不新增 API 请求）。
- 只剥离“重计算链路”，不改动现有交易规则、风控逻辑和队列处理方式。

---

## 当前代码关键路径（必要性依据）

### 1. 主循环会等待所有监控标的完成
`src/index.ts` 的主循环每秒 `await mainProgram()`，而 `mainProgram` 内部使用 `Promise.allSettled` 等待所有 `processMonitor` 完成。  
当监控标的多或 K 线接口响应慢时，主循环会被拉长，出现“延迟累积”。

### 2. `processMonitor` 内包含重 I/O 与计算
`src/main/processMonitor/index.ts` 中每次循环都执行：
- `getCandlesticks()`（HTTP 调用）
- `buildIndicatorSnapshot()`（CPU 计算）
- 生成信号并分流  

这部分是**本次改造的唯一必要性来源**。行情读取本身已是缓存读取，非瓶颈。

### 3. 行情缓存已是事件驱动
`src/services/quoteClient/index.ts` 中 WebSocket 推送实时写入 `quoteCache`，`getQuotes()` 只是读取缓存，不会产生 HTTP 请求。  
因此“主循环只读取缓存”已经具备基础条件，改造重点应是剥离 K 线/指标链路。

---

## 方案复盘与取舍

### 方案 A：每秒触发 + 异步 IndicatorWorker（推荐）
**可行性**：高（与现有异步队列、延迟验证兼容）  
**合理性**：高（只去除阻塞点，不引入额外优化）

核心改造：主循环仍每秒触发，但 K 线与指标计算改为“触发后不等待”，计算完成后再写缓存并生成信号。

### 方案 B：行情推送驱动触发
不采用：推送频率高且 K 线是 1 分钟周期，容易造成 API 限流和无效计算。

### 方案 C：单飞节流（与 A 组合）
必要的保护手段，防止同标的并发调用 K 线或对象池释放冲突。  
该逻辑应内置在 IndicatorWorker 中，而非额外全局调度器。

### 方案 D：worker_threads
不采用：复杂度高，收益低（当前瓶颈主要是 HTTP 调用）。

---

## 最终方案（必要且最小改动）

**最终方案 = 方案 A + 方案 C**  
即：每秒触发异步 IndicatorWorker，单标的单飞节流，主循环不等待重计算。

### 1. 新增 IndicatorWorker（异步计算器）
新增模块：`src/main/asyncProgram/indicatorWorker/`
- 负责：K 线获取 → 指标计算 → 指标缓存更新 → 信号生成与分流
- 特性：每个监控标的单飞（`isCalculating`），防止并发重入

### 2. 轻量化 `processMonitor`
`processMonitor` 保留必要功能：
- 行情提取与缓存更新  
- 价格变化监控  
- 浮亏监控  
- 触发 `indicatorWorker.trigger()`（不等待）

移除：
- K 线获取
- 指标计算
- 信号生成与分流

### 3. 主循环不再被重计算阻塞
`mainProgram` 仍可保持 `Promise.allSettled`，因为 `processMonitor` 已被轻量化。  
这属于**必要且最小**的改动：只移除重计算链路，不改变主循环其它职责。

---

## 必要性结论（不做无谓优化）

本次改造只处理“**K 线获取与指标计算导致主循环延迟**”这一必要问题，其他模块保持不变。

保留：
- 交易日/时段判断与末日保护逻辑
- 价格变化监控与浮亏监控
- 信号处理与买卖队列机制
- 订单监控与缓存刷新流程

不新增：
- 额外的行情订阅策略
- 多线程计算
- 额外的风控或信号策略逻辑

---

## 关键实现细节（避免行为回归）

### 1. 触发条件与“值不同”的定义
每秒 tick 时读取缓存行情，只有当**监控标的行情发生变化**才触发 K 线与指标计算。  
建议以 `monitorQuote.timestamp` 作为变化判断依据（比仅比较价格更稳健，可覆盖无价变但有成交量变化的场景）。

### 2. 延迟验证采样连续性
延迟验证器依赖 `IndicatorCache` 的 T0/T1/T2 采样点。  
为避免“长期无变化导致缺少时间点数据”的回归，建议：
- 当行情无变化且存在上次快照时，向 `IndicatorCache` 追加**上次快照的副本**（不重新计算）。
- 这样保持 1s 级别时间序列连续性，同时仍避免重复 K 线请求。

### 3. 指标显示与对象池释放
`processMonitor` 不再计算指标后，`marketMonitor.monitorIndicatorChanges` 也需迁移到 `IndicatorWorker` 中执行，确保：
- 指标日志不丢失
- `monitorState.monitorValues` 与 `lastMonitorSnapshot` 的更新与释放逻辑保持一致

---

## 最终改动清单（最小范围）

新增：
- `src/main/asyncProgram/indicatorWorker/index.ts`
- `src/main/asyncProgram/indicatorWorker/types.ts`
- `src/main/asyncProgram/indicatorWorker/utils.ts`（可选，用于去重/节流/对象池释放辅助）

修改：
- `src/main/processMonitor/index.ts`
  - 移除 K 线获取、指标计算、信号生成
  - 触发 `indicatorWorker.trigger()`
- `src/main/mainProgram/index.ts`
  - 注入 `indicatorWorker` 到上下文
  - 保留 `Promise.allSettled`（必要最小）
- `src/main/mainProgram/types.ts`（补充 `indicatorWorker` 类型）
- `src/index.ts`（初始化 `indicatorWorker`）
- `src/services/cleanup/index.ts`（销毁 `indicatorWorker`）

---

## 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| 指标缓存采样变稀疏 | 延迟验证失败概率增大 | 无变化时写入上次快照 |
| 指标显示丢失 | 可观测性下降 | 将 `monitorIndicatorChanges` 移入 worker |
| 计算重入 | 并发 K 线调用 | worker 内单飞 `isCalculating` |

---

## 验证要点（不增加无关测试）

最小验证：
- 主循环仍保持 1 秒节奏（无明显延迟累积）
- 延迟验证信号仍可正常通过/拒绝（无“缺少时间点数据”爆量日志）
- 指标日志仍正常输出
- 队列与交易逻辑无行为变化

---

## 回滚方案

如需回滚，仅恢复以下文件到改造前版本：
- `src/main/processMonitor/index.ts`
- `src/main/mainProgram/index.ts`
- `src/index.ts`
- 删除新增的 `indicatorWorker` 模块
