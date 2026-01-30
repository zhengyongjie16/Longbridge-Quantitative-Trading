# 启动初始化流程图

本文档描述程序启动时的初始化流程，依据 `src/index.ts` 的实际执行顺序整理。

```
启动初始化流程（树状）
├─ 阶段1：配置与行情客户端
│  ├─ 加载 .env.local
│  ├─ 解析交易配置
│  ├─ 创建 symbolRegistry
│  ├─ validateAllConfig（静态配置校验，不触发行情订阅）
│  │  ├─ 失败 → 输出错误并退出
│  │  └─ 成功 → 创建基础客户端
│  ├─ createConfig
│  ├─ createMarketDataClient（仅创建 QuoteContext，不订阅）
│  └─ 解析运行模式与门禁策略（RUN_MODE → startup/runtime gate）
├─ 阶段2：启动门禁（交易时段）
│  ├─ createStartupGate
│  ├─ dev 模式 → 跳过交易日/交易时段/开盘保护检查
│  └─ prod 模式 → 循环检查
│     ├─ 交易日？
│     ├─ 连续交易时段？
│     ├─ 开盘保护期？
│     └─ 通过后返回 tradingDayInfo
├─ 阶段3：交易器与基础状态
│  ├─ 创建 liquidationCooldownTracker
│  ├─ createTrader
│  ├─ 初始化 lastState（positionCache/monitorStates/cachedTradingDayInfo）
│  ├─ refreshAccountAndPositions（仅缓存账户与持仓）
│  └─ 账户/持仓有效?
│     ├─ 否 → 退出
│     └─ 是 → 拉取全量订单（history + today）
├─ 阶段4：席位准备（自动寻标入口）
│  ├─ resolveSeatSnapshot（配置/持仓/历史订单 → 初始席位占位）
│  ├─ 写入席位状态（READY/EMPTY）
│  ├─ waitForSeatsReady（仅自动寻标开启的席位）
│  │  ├─ 开盘延迟未到 → 跳过
│  │  ├─ findBestWarrant（warrantList）
│  │  ├─ 成功 → 席位 READY
│  │  └─ 失败 → 席位 EMPTY，等待重试
│  └─ 产出 seatSymbols（席位标的快照）
├─ 阶段5：冷却恢复与核心模块
│  ├─ tradeLogHydrator.hydrate（基于 seatSymbols 恢复清仓冷却）
│  ├─ 初始化核心模块（市场监控 / 末日保护 / 信号处理）
│  └─ 初始化异步架构（指标缓存 / 买卖队列）
├─ 阶段6：行情订阅与运行期标的校验
│  ├─ collectRuntimeQuoteSymbols（监控标的 + 席位标的 + 持仓标的）
│  ├─ subscribeSymbols（统一订阅运行期标的）
│  ├─ 批量获取行情 initQuotesMap
│  ├─ 运行期标的验证（监控+席位必需，持仓为警告）
│  └─ 输出账户/持仓（使用 initQuotesMap 展示名称）
├─ 阶段7：监控上下文与初始化数据
│  ├─ 创建 monitorContext（riskChecker/strategy/autoSymbolManager/延迟验证器）
│  ├─ 初始化牛熊证信息（refreshWarrantInfo）
│  ├─ 初始化订单记录（refreshOrdersFromAllOrders）
│  └─ 初始化浮亏监控数据（refreshUnrealizedLossData）
└─ 阶段8：进入运行
   ├─ 注册延迟验证回调（验证通过→入买/卖队列）
   ├─ 启动 buyProcessor / sellProcessor
   ├─ 注册 cleanup 退出清理
   └─ mainProgram 每秒循环（runtimeGateMode 控制运行期门禁）
```

## 模块/函数释义（按启动顺序）

### 阶段1：配置与行情客户端
- `createMultiMonitorTradingConfig`：从环境变量解析交易配置，生成多监控标的配置集合（标的、风险、信号、延迟验证等）。
- `symbolRegistry`（由 `createSymbolRegistry` 创建）：席位注册表，维护每个监控标的的 LONG/SHORT 席位状态与版本号，用于席位切换与信号一致性校验。
- `validateAllConfig`：静态配置校验（凭证、格式、参数范围），不触发行情订阅。
- `createConfig`：创建 LongPort `Config`，包含 HTTP/行情/交易 WebSocket 端点与凭证。
- `createMarketDataClient`：行情客户端，创建 QuoteContext 与本地缓存；不自动订阅，需显式 `subscribeSymbols`。
- `resolveRunMode` / `resolveGatePolicies`：解析 `RUN_MODE` 并返回启动/运行期门禁策略（strict/skip）。

### 阶段2：启动门禁（交易时段）
- `createStartupGate`：启动门禁控制器；dev 模式直接放行，prod 模式循环检查交易日、连续交易时段与开盘保护期。
- `startupGate.wait`：阻塞等待门禁通过，返回 `tradingDayInfo`（是否交易日/是否半日）。

### 阶段3：交易器与基础状态
- `createLiquidationCooldownTracker`：清仓冷却追踪器，记录保护性清仓时间并计算剩余冷却。
- `createTrader`：交易门面（账户、订单缓存、订单记录、订单监控、订单执行的统一入口），初始化 WebSocket 订单监控并恢复追踪。
- `lastState`：运行期缓存容器，保存账户/持仓、交易日信息、监控标的状态、已订阅标的集合等。
- `refreshAccountAndPositions`：启动时拉取账户与持仓并写入缓存，缓存存在时不重复调用 API。
- `fetchAllOrdersFromAPI`：启动时拉取全量订单，供席位占位与订单记录初始化使用。

### 阶段4：席位准备（自动寻标入口）
- `prepareSeatsOnStartup`：统一席位初始化入口；先根据配置/持仓/历史订单占位，再对 EMPTY 席位执行自动寻标。
- `resolveSeatSnapshot`：从历史订单提取候选标的，结合持仓判断席位初始占位。
- `findBestWarrant`：自动寻标核心函数，基于监控标的、价格/成交额阈值与到期月份筛选最优牛熊证。
- `seatSymbols`：席位就绪后的快照，用于冷却恢复与后续初始化。

### 阶段5：冷却恢复与核心模块
- `tradeLogHydrator.hydrate`：读取当日成交日志，按席位方向恢复保护性清仓冷却。
- `createMarketMonitor`：行情监控器，监控做多/做空标的价格变化与监控标的指标变化并输出日志。
- `createDoomsdayProtection`：末日保护模块，收盘前撤单/清仓，避免隔夜风险。
- `createSignalProcessor`：信号处理器，统一卖出数量计算与买入风险检查流程。
- `createIndicatorCache`：指标环形缓存，按秒保存指标快照供延迟验证查询。
- `createBuyTaskQueue` / `createSellTaskQueue`：买/卖任务 FIFO 队列，带任务入队触发回调。

### 阶段6：行情订阅与运行期标的校验
- `collectRuntimeQuoteSymbols`：收集运行期订阅标的集合（监控标的 + 席位标的 + 持仓标的）。
- `subscribeSymbols`：行情客户端动态订阅标的并填充初始行情缓存。
- `getQuotes`：从行情缓存批量读取行情数据，用于初始化 `initQuotesMap`。
- `validateRuntimeSymbolsFromQuotesMap`：运行期标的校验（监控+席位为必需，持仓为警告）。
- `displayAccountAndPositions`：根据 `initQuotesMap` 输出账户与持仓（含名称与价格）。

### 阶段7：监控上下文与初始化数据
- `createMonitorContext`：为每个监控标的创建独立上下文，绑定策略、风控、浮亏监控、延迟验证器与席位信息。
- `createAutoSymbolManager`：自动寻标/换标管理器，运行期根据阈值寻标与换标，维护席位状态与版本。
- `createRiskChecker`：风险控制门面，包含牛熊证距离检查、持仓市值限制与浮亏检查。
- `createHangSengMultiIndicatorStrategy`：多指标策略，生成买卖信号并决定是否进入延迟验证。
- `createUnrealizedLossMonitor`：浮亏监控器，超阈值时触发保护性清仓并刷新订单记录。
- `createDelayedSignalVerifier`：延迟验证器，按 T0/T0+5s/T0+10s 指标趋势验证信号。
- `refreshWarrantInfoForSymbol`：刷新席位牛熊证信息（回收价、类型等），用于风险检查与距离计算。
- `refreshOrdersFromAllOrders`：从全量订单中过滤单标的订单，初始化本地订单记录。
- `refreshUnrealizedLossData`：基于订单记录计算 R1/N1，初始化浮亏数据基线。

### 阶段8：进入运行
- `delayedSignalVerifier.onVerified/onRejected`：延迟验证回调入口，通过则推入队列，失败则记录原因并释放信号。
- `createBuyProcessor`：买入处理器，消费买入队列并执行风险检查与下单。
- `createSellProcessor`：卖出处理器，优先处理卖出信号并直接计算卖出数量。
- `createCleanup`：退出清理，停止处理器、销毁验证器、清理缓存与快照。
- `mainProgram`：每秒主循环，包含运行期门禁、末日保护、行情批量获取、监控标的处理与订单监控。

说明：
- 交易标的唯一来源为席位；配置仅在自动寻标关闭时写入席位，运行期不再直接使用配置标的。
- 启动门禁确保仅在交易日且处于连续交易时段、且已过开盘保护期时继续初始化；dev 模式跳过启动与运行期门禁。
- validateAllConfig 仅做静态配置校验；运行期标的校验基于 initQuotesMap 执行，必需标的失败会退出。
- marketDataClient 创建时不订阅；统一在席位就绪后订阅运行期标的集合。
- 席位未就绪时阻塞等待，自动寻标成功后再进入后续初始化。
- 运行期订阅标的集合包含监控标的、席位标的与持仓标的。
- 全量订单用于持仓归属与订单记录初始化，不作为配置兜底来源。
- 运行期自动寻标：交易时段内且席位为空时按冷却周期触发，与监控标的价格变化无关；换标检查仅在监控标的价格变化时执行。
