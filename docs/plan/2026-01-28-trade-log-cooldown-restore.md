# 交易日志成交化与冷却恢复方案

## 目标
- 交易记录日志只在**完全成交**后写入，避免提交记录污染冷却逻辑。
- 成交日志必须包含**成交时间**与**监控标的代码**，用于冷却计算与方向归属。
- 程序启动时读取**当日成交日志**，按监控标的方向取最后一条保护性清仓记录，恢复冷却缓存。

## 背景与问题
当前 `logs/trades/YYYY-MM-DD.json` 的记录来自下单提交阶段，状态多为 `SUBMITTED`，与实际成交时间不一致，且缺少监控标的代码。  
这会导致启动时无法准确判断保护性清仓冷却是否应当生效，影响风险控制准确性。

## 可行性与合理性分析
**可行性**
- `orderMonitor.handleOrderChanged` 在 `OrderStatus.Filled` 时已拿到成交价、成交量和 `updatedAt`，可作为成交日志唯一入口。
- `trackOrder` 与 `TrackedOrder` 可扩展注入 `monitorSymbol`，明确归属的监控标的与方向。
- 冷却机制 `LiquidationCooldownTracker` 已存在，只需启动回放日志即可恢复状态。

**合理性**
- 冷却必须基于**真实成交**时间，否则会出现误冷却或漏冷却。
- 监控标的维度聚合，能够满足“同方向多个交易标的仅取最后一条”的需求逻辑。
- 仅记录成交事件简化日志，使冷却恢复数据源可靠可用。

## 方案概述（最优方案）
1. **日志改造优先**：成交日志仅在完全成交后写入。
2. **日志结构补齐**：新增 `executedAt`/`executedAtMs` 与 `monitorSymbol`。
3. **启动冷却恢复**：读取当日成交日志，按 `monitorSymbol + direction` 取最后一条保护性清仓记录，计算剩余冷却并写入缓存。

## 详细设计
### 1) 成交日志结构（TradeRecord）
新增字段：
- `monitorSymbol`：监控标的代码（如 `HSI.HK`）
- `executedAt`：北京时间字符串
- `executedAtMs`：毫秒时间戳（用于冷却计算）

保留字段：
- `symbol`、`symbolName`、`action`、`side`、`quantity`、`price`、`orderType`
- `reason`、`signalTriggerTime`、`isProtectiveClearance`

### 2) 写入时机调整
成交日志只在 **OrderStatus.Filled** 发生时写入：
- 入口为 `orderMonitor.handleOrderChanged` 的完全成交分支。
- 写入 `executedAt` 与 `executedAtMs`，来源为 `event.updatedAt`；若缺失则写 `null`。
- 写入 `isProtectiveClearance`（来自追踪订单的保护性清仓标记）。
- 写入 `monitorSymbol` 与方向信息（由 `TrackedOrder` 持有）。

同时移除 `orderExecutor.recordTrade` 的提交阶段日志写入，避免出现 `SUBMITTED` 记录污染冷却数据源。

### 3) 监控标的注入
为确保日志包含监控标的：
- `trackOrder` 新增参数 `monitorSymbol`。
- `TrackedOrder` 新增字段 `monitorSymbol`。
- `orderExecutor` 在提交订单后调用 `trackOrder` 时，从 `monitorConfig.monitorSymbol` 传入。

### 4) 启动冷却恢复流程
新增启动阶段日志回放模块（例如 `tradeLogHydrator`）：
1. 读取**当日成交日志**文件。
2. 过滤 `isProtectiveClearance === true` 的记录。
3. 按 `monitorSymbol + direction` 分组，只保留每组最后一条记录（按 `executedAtMs` 比较）。
4. `executedAtMs` 或 `monitorSymbol` 缺失时写入 `null`，且该记录不参与冷却恢复计算。
5. 调用 `LiquidationCooldownTracker.recordCooldown` 写入冷却时间。
6. 立即用 `getRemainingMs` 判断是否过期，过期则忽略。

## 预期影响
正向影响：
- 冷却恢复基于真实成交时间，避免误冷却。
- 方向与监控标的归属明确，满足同方向多标的取最后一条的需求。

潜在影响：
- 成交日志不再包含提交/失败事件，本方案不提供其他事件日志。

## 修改清单（文件级别）
- `src/core/trader/types.ts`
  - 扩展 `TradeRecord`、`TrackedOrder` 增加成交与监控标的字段。
- `src/core/trader/orderExecutor.ts`
  - 调整 `trackOrder` 传参为含 `monitorSymbol`。
  - 移除提交阶段 `recordTrade` 写入逻辑。
- `src/core/trader/orderMonitor.ts`
  - `trackOrder` 保存 `monitorSymbol`。
  - 完全成交分支写入成交日志（含 `executedAt`/`executedAtMs`）。
- `src/core/liquidationCooldown/tradeLogHydrator.ts`
  - 读取当日日志并恢复冷却。
- `src/index.ts`
  - 启动阶段调用 `tradeLogHydrator`。

## 验证与验收
- `npm run type-check`
- `npm run lint`
- 手动验证：
  - 产生保护性清仓成交日志后重启，买入应被冷却拦截且日志显示剩余冷却。

## 关键假设
- 成交记录只在完全成交后写入。
- 监控标的与方向信息在成交日志中完整提供。
