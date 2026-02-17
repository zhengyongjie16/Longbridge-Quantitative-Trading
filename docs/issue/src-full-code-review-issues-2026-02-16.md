# src 全量代码审查问题清单（2026-02-16）

## 审查范围
- 目录：`src/`
- 文件数：158
- 审查方式：静态全量扫描 + 核心模块逐文件深查（主循环、行情订阅、交易执行、风控链路、异步任务、类型定义、注释）
- 自动检查结果：
  - `npm run type-check`：通过
  - `npm run lint`：通过
  - `npm test`：两次超时（124s、604s），未拿到完整测试结论

## 结论概览
- 严重（必须修复）：1 项
- 重要（应该修复）：2 项
- 建议（锦上添花）：2 项

---

## 严重问题（必须修复）

### 1) 行情订阅状态与缓存状态不一致，可能导致“已订阅却被判定未订阅”的运行时异常
- 位置：
  - `src/services/quoteClient/index.ts:279`
  - `src/services/quoteClient/index.ts:306`
  - `src/services/quoteClient/index.ts:309`
  - `src/services/quoteClient/index.ts:266`
- 问题描述：
  - `subscribeSymbols()` 中，`subscribedSymbols` 仅在 `ctx.quote(newSymbols)` 返回该标的初始行情时才 `add`。
  - 但随后会对 `newSymbols` 全量执行 `ctx.subscribe(newSymbols, [SubType.Quote])`。
  - 当某个标的成功订阅但初始行情未返回时，该标的不在 `subscribedSymbols`，后续 `getQuotes()` 会抛出“未订阅”错误。
- 影响：
  - 主流程在特定行情时机下可能直接异常，造成监控中断或本轮交易循环失败。
  - 该问题属于状态一致性缺陷，风险高。
- 触发条件（典型）：
  - 网络抖动、SDK 初始快照缺失、刚订阅阶段无可用报价返回。
- 修复建议：
  - 订阅成功后应以 `newSymbols` 为准维护 `subscribedSymbols`（订阅事实）。
  - 初始行情是否返回只影响 `quoteCache`，不应影响“是否已订阅”的状态判定。

---

## 重要问题（应该修复）

### 2) 交易日缓存键使用 UTC 日期，与系统 HK 日期体系不一致
- 位置：`src/index.ts:172`
- 问题描述：
  - `resolveTradingDayInfo()` 使用 `currentTime.toISOString().slice(0, 10)` 作为缓存键（UTC 语义）。
  - 系统其它交易日/生命周期逻辑大量使用 HK 日期键（如 `getHKDateKey`、`resolveHKDateKey`）。
- 影响：
  - 时区边界可能出现缓存命中错位，导致交易日状态与门禁判定出现偏差。
  - 在跨日、开盘前后窗口最敏感。
- 修复建议：
  - 统一交易日缓存键为 HK 日期键（`YYYY-MM-DD`，UTC+8 语义）。
  - 避免同一业务域混用 UTC 日期键与 HK 日期键。

### 3) 对外接口暴露内部能力，封装边界过弱
- 位置：
  - `src/types/services.ts:52`（`MarketDataClient._getContext`）
  - `src/types/services.ts:278`（`Trader._orderRecorder`）
  - `src/types/services.ts:307`（`Trader._canTradeNow`）
  - `src/types/services.ts:309`（`Trader._markBuyAttempt`）
  - 调用示例：`src/index.ts:421`、`src/core/signalProcessor/riskCheckPipeline.ts:169`
- 问题描述：
  - `_` 命名的内部方法/状态被公开到全局调用路径。
  - 上层可直接绕过门面抽象，降低模块内不变量保护能力。
- 影响：
  - 未来重构成本高，易出现跨模块行为漂移。
  - 边界责任不清晰，导致测试与错误归因困难。
- 修复建议：
  - 将内部能力收敛为正式领域接口（如 `canTradeNow`、`recordBuyAttempt`、`fetchAllOrders`）。
  - 逐步移除 `_` 内部接口的对外暴露，减少跨层耦合。

---

## 建议问题（锦上添花）

### 4) 注释数值与实现语义不一致（易误导维护者）
- 位置：`src/core/trader/rateLimiter.ts:55`
- 问题描述：
  - 注释写“0.02 秒”，文件头写“30ms”，实际使用常量 `API.MIN_CALL_INTERVAL_MS`。
- 影响：
  - 维护时易误判限流行为，影响排障和参数调优。
- 修复建议：
  - 统一注释为与常量一致的数值表达（建议统一写成毫秒）。

---

## 类型设计专项评估

### 类型：`Trader`（`src/types/services.ts:276`）
- 封装性：4/10
- 不变量表达：6/10
- 不变量实用性：7/10
- 不变量强制执行：5/10
- 主要关注点：
  - 内部接口对外暴露导致封装破口。
  - 关键交易约束更多依赖调用方纪律而非类型边界。

### 类型：`MarketDataClient`（`src/types/services.ts:50`）
- 封装性：5/10
- 不变量表达：7/10
- 不变量实用性：8/10
- 不变量强制执行：6/10
- 主要关注点：
  - `_getContext` 暴露底层 SDK 上下文，弱化抽象层价值。
  - “先订阅后读取”的约束主要由运行时异常兜底。

### 类型：`Signal`（`src/types/signal.ts:33`）
- 封装性：7/10
- 不变量表达：6/10
- 不变量实用性：8/10
- 不变量强制执行：5/10
- 主要关注点：
  - 对象池场景下可变设计合理，但字段间组合约束大多在运行时保障。

---

## 注释专项结论
- 严重错误注释：未发现事实性严重错误注释。
- 改进项：`src/core/trader/rateLimiter.ts:55` 数值描述与实现语义不一致。
- 正面发现：核心模块普遍具备文件头与流程注释，业务背景解释较充分。

---

## 残余风险与说明
- 当前 `type-check`、`lint` 已通过，说明基础类型与规范层面状态良好。
- 由于 `npm test` 超时，行为层完整性结论仍有缺口；建议后续补充可稳定完成的测试运行或分组测试策略。

## 推荐修复优先级（执行顺序）
1. 修复行情订阅状态一致性问题（严重）。
2. 统一交易日缓存键到 HK 日期语义（重要）。
3. 收敛 `_` 内部接口对外暴露（重要）。
4. 修正文档/注释不一致项。
