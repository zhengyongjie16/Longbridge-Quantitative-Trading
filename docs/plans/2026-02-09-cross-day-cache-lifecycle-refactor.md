# 跨日缓存清理与开盘重建的系统性重构方案（详细版）

> 目标：在不采用补丁式兼容代码的前提下，建立统一的“缓存生命周期管理体系”，实现“跨日零点清理 + 下次开盘后重建”，且与启动初始化逻辑完全对齐。

## 1. 约束与总目标

### 1.1 强约束
- 必须是系统性、完整性重构，**不允许**局部补丁或兼容性逻辑堆叠。
- 程序启动仍需完整初始化，跨日逻辑不得削弱启动路径的严谨性。
- 跨日清理发生在“检测到香港日期变化的第一轮主循环”（等价于零点），非定时器驱动。
- 开盘重建仅在**通过启动门禁**后触发一次（与启动门禁对齐），且需具备严格的交易门禁。

### 1.2 总目标
- 形成清晰的缓存生命周期模型（按日、按交易时段、跨运行期）。
- 所有缓存必须显式注册并由统一生命周期管理器控制清理与重建。
- 交易信号与任务必须被严格门禁控制：初始化未完成前不得交易。

## 2. 现状与核心问题

### 2.1 现状简述
- 跨日逻辑只做了少量状态清空与交易日信息刷新，**未对大多数缓存体系化处理**。
- 缓存分散在多个模块中，且部分为模块级静态 Map（不可统一清理）。
- 各类缓存的“日内有效性”未被显式建模，存在“旧日数据污染新日逻辑”的风险。

### 2.2 关键问题
1. **生命周期边界不清晰**：哪些缓存应该跨日清理、哪些应延续，缺乏统一规范。
2. **清理入口分散**：清理逻辑多处散落，难以保证一致性与正确顺序。
3. **初始化与跨日重建不对齐**：启动流程完整，但跨日只做部分清理，没有对等的重建流程。
4. **任务/信号门禁缺失**：跨日清理与开盘重建期间仍可能产生旧任务或旧信号。

## 3. 缓存生命周期分类（系统性重构基础）

> 以“生命周期边界”为主轴，统一约束所有缓存的清理/重建时机。

### 3.1 生命周期类型
- **DAY（按交易日）**：跨日必须清理，开盘（启动门禁通过）必须重建。
- **SESSION（按交易时段）**：跨日或非连续交易时段清理，开盘（启动门禁通过）重建。
- **RUNTIME（跨运行期）**：仅在进程退出时清理，不随跨日变化（但席位状态需在跨日清理中重置为 EMPTY）。
- **EPHEMERAL（批次内）**：仅在某个批次处理内有效。

### 3.2 缓存分类清单（示例）
- DAY：账户/持仓缓存、订单缓存、本地订单存储、指标时序缓存、延迟验证队列、行情缓存（含 prevClose）、日内亏损状态。
- SESSION：监控状态中与行情/指标相关字段、任务队列中的交易任务。
- RUNTIME：配置、策略实例、核心服务实例（symbolRegistry 实例保留，但席位状态跨日需清空）。
- EPHEMERAL：监控任务处理中的批次缓存。

## 4. 设计原则与不变式

1. **单一入口原则**：跨日清理与开盘重建必须由统一生命周期管理器发起。
2. **显式缓存注册**：所有缓存必须显式注册到缓存注册表，不允许隐式模块级缓存。
3. **严格门禁**：初始化未完成前，任何交易任务不得执行。
4. **启动与跨日重建对齐**：跨日重建必须与启动初始化遵循同样的核心步骤（账号、持仓、订单、风控），且必须等待启动门禁通过后执行。
5. **可测试性**：所有生命周期流程需可单元测试，且可通过模拟时间触发。

## 5. 新架构设计（系统性重构）

### 5.1 新增核心组件

#### 5.1.1 `TradingDayLifecycleManager`
统一管理跨日清理与开盘重建，负责状态机与门禁控制。
- 状态：`BOOTING → READY → DAY_CLEARED → INIT_PENDING → TRADING_ACTIVE`
- 对外接口：
  - `onDayBoundary()`：检测到跨日后立即执行清理。
  - `ensureTradingDayInitialized()`：进入交易时段后执行一次初始化。
  - `isReadyForTrading()`：提供交易门禁状态。

#### 5.1.2 `CacheRegistry`
统一登记所有缓存的清理/重建逻辑。
- 每个缓存注册：
  - `scope`（DAY/SESSION/RUNTIME/EPHEMERAL）
  - `clear()`
  - `init()`（可选）
  - `dependencies`（初始化依赖）

#### 5.1.3 `InitializationPipeline`
封装初始化步骤，支持分阶段、可重试、可记录耗时。
- 例如：
  1) `TradingDayInfo`
  2) `Account/Positions`
  3) `Orders + OrderHoldRegistry`
  4) `DailyLossTracker`
  5) `RiskChecker`（warrant info / unrealized loss）
  6) `MarketDataWarmup`
  7) `MonitorStateReset`
  8) `SeatReacquire`（席位跨日清空后的重新寻标/占位）

### 5.2 子系统分层与职责

#### 5.2.1 MarketDataCacheService
- 负责行情缓存（quoteCache、prevCloseCache、staticInfoCache）。
- 暴露：`clearDayCaches()`、`warmupQuotes(symbols)`。

#### 5.2.2 OrderCacheService
- 包含：OrderCacheManager、OrderAPIManager、OrderStorage、OrderHoldRegistry。
- 暴露：`resetDayCaches()`、`rebuildFromOrders()`。

#### 5.2.3 IndicatorCacheService
- 包含：计算缓存 + 时序缓存。
- 暴露：`clearAll()`。

#### 5.2.4 RiskCacheService
- 包含：DailyLossTracker、UnrealizedLossData、WarrantInfo。
- 暴露：`resetForNewDay()`、`reinitFromOrders()`。

#### 5.2.5 TaskQueueService
- 包含：Buy/Sell/Monitor 任务队列。
- 暴露：`clearAll()`。

#### 5.2.6 MonitorStateService
- 管理 MonitorState 清空与快照释放。
- 暴露：`resetForNewDay()`。

#### 5.2.7 SeatStateResetService
- 负责席位状态跨日统一重置为 `EMPTY`，等待启动门禁通过后重新寻标/占位。

## 6. 跨日与开盘流程（完整重构后的目标流程）

### 6.1 跨日清理流程（Day Boundary）
触发条件：`getHKDateKey(now) != lastState.currentDayKey`

**流程：**
1. `LifecycleManager.onDayBoundary()`
2. `CacheRegistry.clear(scope=DAY|SESSION)`
3. 标记 `dailyInitPending = true`
4. 停止任务消费（任务队列清空，处理器等待）

**必须清理：**
- 账户与持仓缓存
- 订单缓存与本地订单存储
- 指标缓存（计算/时序）
- 延迟验证队列
- 行情缓存（quote/prevClose）
- DailyLossTracker 状态
- 席位状态（重置为 EMPTY）

### 6.2 开盘重建流程（Trading Session Open）
触发条件：**启动门禁通过** 且 `dailyInitPending === true`

**流程：**
1. `LifecycleManager.ensureTradingDayInitialized()`
2. 执行 `InitializationPipeline`
3. 初始化完成后 `dailyInitPending = false`
4. 恢复任务队列与信号消费

**关键重建步骤：**
- 强制获取账户/持仓并同步 positionCache
- 拉取全量订单（force）并重建 OrderHoldRegistry
- 依据全量订单重建 OrderRecorder 本地存储
- 重新计算 DailyLossTracker
- 重新初始化 Warrant 信息与浮亏数据
- 重新 warmup 行情缓存
- 触发席位重新寻标/占位（席位已跨日清空，等待门禁后重建）
- 不执行“必需标的校验”（跨日重建不因临时行情缺失而退出）

## 7. 接口与模块级改造清单（系统性）

### 7.1 必须改造
- `MarketDataClient`：提供显式 `clearDayCaches()` / `warmupQuotes()`。
- `OrderRecorder`：提供 `resetDayCaches()`，清空所有 ordersCache + allOrdersCache。
- `OrderHoldRegistry`：提供 `reset()`。
- `IndicatorCalculationCache`：从模块级 Map 改为实例，并提供 `clear()`。
- `TaskQueue`：新增 `clearAll()`。
- `MonitorState`：新增 `reset()`，明确哪些字段按日清空。

### 7.2 主循环重构
- `mainProgram` 中跨日逻辑仅保留时间检测，将清理与重建交给 LifecycleManager。
- 交易信号与任务处理加入门禁判断：`if (!lifecycle.isReadyForTrading()) return;`（门禁通过标准与启动门禁一致）。

## 8. 可行性与合理性分析（详细）

### 8.1 可行性
- 代码已具备“模块拆分”基础（MarketData/Order/Risk/Async/Monitor）。
- 缓存大多为内存结构，清理代价低，重建成本可控（每日一次）。
- 初始化流程已存在，可抽取为统一 Pipeline，复用性高。

### 8.2 合理性
- 交易系统天然以“交易日”为核心生命周期，按日清理与重建符合金融系统惯例。
- 防止旧日行情/订单/指标污染新日风控与交易逻辑。
- 引入生命周期管理器后，缓存责任清晰，降低运维风险。

### 8.3 风险与应对
- **开盘重建 API 压力**：通过 Pipeline 顺序化与限流机制缓解。
- **清理过度导致空数据交易**：门禁机制保证未完成初始化前禁止交易。
- **跨日时并发任务冲突**：清理前停止任务队列，确保原子性。
- **门禁未通过导致重建过早**：以启动门禁为触发条件，避免在开盘保护期内提前重建。

## 9. 重构实施步骤（分阶段落地）

### 阶段 1：生命周期框架搭建
- 新增 `TradingDayLifecycleManager` + `CacheRegistry` + `InitializationPipeline`。
- 仅接入部分缓存，验证流程可用。

### 阶段 2：缓存显式化
- 将所有隐式缓存改为实例化对象，并注册到 CacheRegistry。
- 删除旧的零散清理逻辑，统一由 LifecycleManager 驱动。

### 阶段 3：主循环重构
- 移除 `mainProgram` 中直接清理逻辑，改为调用 `LifecycleManager`。
- 引入交易门禁控制（与启动门禁一致），确保未初始化时禁止交易。

### 阶段 4：测试与验证
- 模拟跨日与开盘流程，验证缓存清理与重建效果。
- 验证无旧日信号残留与订单缓存污染。

## 10. 验收标准

- 跨日后所有 DAY/SESSION 缓存均清理干净。
- 开盘后完整执行初始化流程，且只执行一次。
- 启动初始化逻辑不受影响。
- 无任何交易任务在初始化未完成前执行。
- 跨日重建不执行必需标的校验，不因临时行情缺失而退出。

---

**结论：**
本方案以“生命周期管理 + 缓存注册表 + 初始化流水线”为核心，保证跨日清理与开盘重建的系统性和完整性，消除补丁式清理与零散缓存带来的风险，满足长期维护与交易安全性要求。
