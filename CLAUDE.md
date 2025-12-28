# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在此代码库中工作时提供指导。

## 系统概述

这是一个 LongBridge 港股自动化量化交易系统。它通过技术指标监控目标资产（如恒生指数），并在牛熊证上执行双向交易。

**核心设计模式**：多指标组合策略，开仓信号采用 60 秒延迟验证，平仓信号立即执行。

## 核心架构

```
主循环 (index.js) → 每秒执行一次，协调所有模块
  ├─ 行情监控 (marketMonitor.js) - 价格和指标变化监控
  ├─ 浮亏监控 (unrealizedLossMonitor.js) - 实时浮亏检查
  ├─ 行情数据 (quoteClient.js) - 获取实时行情和K线
  ├─ 指标计算 (indicators.js) - 使用 technicalindicators 库
  ├─ 信号生成 (strategy.js) - 生成立即和延迟信号
  ├─ 信号验证 (signalVerification.js) - 延迟信号验证
  ├─ 信号处理 (signalProcessor.js) - 风险检查和卖出数量计算
  ├─ 末日保护 (doomsdayProtection.js) - 收盘前保护机制
  ├─ 风险控制 (risk.js) - 牛熊证和浮亏风险检查
  ├─ 订单执行 (trader.js) - 提交和监控订单
  ├─ 订单记录 (orderRecorder.js) - 历史订单跟踪
  └─ 辅助模块
      ├─ tradingTime.js - 交易时段和时区工具
      ├─ accountDisplay.js - 账户和持仓显示
      ├─ objectPool.js - 内存优化（对象池）
      ├─ indicatorHelpers.js - 指标辅助函数
      ├─ logger.js - 基于 pino 的高性能日志系统
      ├─ signalConfigParser.js - 信号配置解析器
      └─ helpers.js - 工具函数
```

## 文档导航

- **[README.md](./README.md)** - 项目完整使用文档（用户指南）
- **[docs/TECHNICAL_INDICATORS.md](./docs/TECHNICAL_INDICATORS.md)** - RSI、KDJ、MACD、MFI 计算原理和使用方法

## 运行系统

```bash
# 安装依赖
npm install

# 配置环境变量（复制 .env.example 为 .env 并填写）
cp .env.example .env

# 启动交易系统
npm start
```

## 模块职责

### index.js（主入口 - 已重构）

**路径**：`D:\Code\longBrige-automation-program\src\index.js`

**重构说明**：原文件从 2314 行缩减到 742 行（减少 68%），所有业务逻辑已模块化。

- **主循环**：`runOnce()` 每秒执行一次，作为模块协调器
- **职责**：
  - 初始化所有模块实例（MarketMonitor, DoomsdayProtection, UnrealizedLossMonitor 等）
  - 协调各模块间的数据流和调用顺序
  - 管理 `lastState` 对象（待验证信号、缓存数据、上次指标值）
  - 获取行情数据和 K 线数据
  - 调用各模块执行具体业务逻辑
- **核心流程**：
  1. 检查交易时段（调用 tradingTime 模块）
  2. 监控价格和指标变化（MarketMonitor）
  3. 检查浮亏并执行保护性清仓（UnrealizedLossMonitor）
  4. 生成和验证交易信号（Strategy + SignalVerificationManager）
  5. 应用风险检查（SignalProcessor）
  6. 执行末日保护程序（DoomsdayProtection）
  7. 提交订单并更新状态（Trader + OrderRecorder）

### marketMonitor.js（行情监控）

**路径**：`D:\Code\longBrige-automation-program\src\core\marketMonitor.js`

- **类**：`MarketMonitor`
- **职责**：监控价格变化和技术指标变化，并格式化显示
- **核心方法**：
  - `monitorPriceChanges()` - 监控做多/做空标的价格变化
  - `monitorIndicatorChanges()` - 监控监控标的的技术指标变化
- **变化检测**：
  - 价格变化阈值：0.0001
  - 指标变化阈值：RSI/MFI/KDJ 为 0.1，MACD 为 0.0001，EMA 为 0.0001
- **显示内容**：价格、涨跌幅、EMA、RSI、MFI、KDJ、MACD 等所有技术指标

### doomsdayProtection.js（末日保护）

**路径**：`D:\Code\longBrige-automation-program\src\core\doomsdayProtection.js`

- **类**：`DoomsdayProtection`
- **职责**：收盘前的风险控制
- **核心方法**：
  - `shouldRejectBuy()` - 判断是否应拒绝买入（收盘前 15 分钟）
  - `shouldClearPositions()` - 判断是否应自动清仓（收盘前 5 分钟）
  - `generateClearanceSignals()` - 生成清仓信号
- **时间规则**：
  - 正常交易日：15:45-16:00 拒绝买入，15:55-15:59 自动清仓
  - 半日交易日：11:45-12:00 拒绝买入，11:55-11:59 自动清仓

### unrealizedLossMonitor.js（浮亏监控）

**路径**：`D:\Code\longBrige-automation-program\src\core\unrealizedLossMonitor.js`

- **类**：`UnrealizedLossMonitor`
- **职责**：实时监控单标的浮亏，触发阈值时执行保护性清仓
- **核心方法**：
  - `checkAndLiquidate()` - 检查并执行保护性清仓
  - `monitorUnrealizedLoss()` - 监控做多/做空标的浮亏
- **清仓流程**：
  1. 检查浮亏是否超过阈值
  2. 创建市价单清仓信号（`useMarketOrder: true`）
  3. 执行清仓订单
  4. 刷新订单记录和浮亏数据

### signalVerification.js（信号验证）

**路径**：`D:\Code\longBrige-automation-program\src\core\signalVerification.js`

- **类**：`SignalVerificationManager`
- **依赖**：使用 `indicatorHelpers.js` 中的 `getIndicatorValue` 函数统一提取指标值
- **职责**：管理延迟信号的验证流程
- **核心方法**：
  - `addDelayedSignals()` - 添加延迟信号到待验证列表
  - `recordVerificationHistory()` - 记录验证历史（每秒调用）
  - `verifyPendingSignals()` - 验证到期的待验证信号
- **验证逻辑**：
  - 买入做多（BUYCALL）：所有配置指标的第二个值都要大于第一个值
  - 买入做空（BUYPUT）：所有配置指标的第二个值都要小于第一个值
- **验证窗口**：触发时间前后 ±5 秒内记录指标值
- **使用对象池**：使用 `verificationEntryPool` 和 `signalObjectPool` 优化内存分配
- **支持的验证指标**：K、D、J、MACD、DIF、DEA、EMA:n

### signalProcessor.js（信号处理）

**路径**：`D:\Code\longBrige-automation-program\src\core\signalProcessor.js`

- **类**：`SignalProcessor`
- **职责**：信号过滤、风险检查、卖出数量计算
- **核心方法**：
  - `processSellSignals()` - 处理卖出信号的成本价判断和数量计算
  - `applyRiskChecks()` - 应用所有风险检查
- **买入检查顺序**：
  1. 交易频率限制
  2. 买入价格限制（防止追高）
  3. 末日保护程序（收盘前 15 分钟拒绝买入）
  4. 牛熊证风险检查
  5. 基础风险检查（浮亏和持仓市值限制）
- **卖出数量计算**：
  - 当 currentPrice > costPrice：立即清空所有持仓
  - 当 currentPrice ≤ costPrice：仅卖出 buyPrice < currentPrice 的历史订单
  - 如果没有符合条件的订单：信号设为 HOLD

### tradingTime.js（交易时段工具）

**路径**：`D:\Code\longBrige-automation-program\src\utils\tradingTime.js`

- **职责**：提供交易时段判断和时区转换功能
- **核心函数**：
  - `getHKTime(date)` - UTC 时间转换为香港时区（UTC+8）
  - `isInContinuousHKSession(date, isHalfDay)` - 判断是否在连续交易时段
  - `isBeforeClose15Minutes(date, isHalfDay)` - 判断是否在收盘前 15 分钟
  - `isBeforeClose5Minutes(date, isHalfDay)` - 判断是否在收盘前 5 分钟
  - `hasChanged(current, last, threshold)` - 检查数值是否变化超过阈值
- **交易时段**：
  - 正常日：09:30-12:00 和 13:00-16:00
  - 半日：仅 09:30-12:00

### accountDisplay.js（账户显示）

**路径**：`D:\Code\longBrige-automation-program\src\utils\accountDisplay.js`

- **职责**：格式化显示账户和持仓信息
- **核心函数**：
  - `displayAccountAndPositions()` - 显示账户快照和持仓详情
- **显示内容**：
  - 账户：余额、市值、持仓市值
  - 持仓：标的名称、持仓数量、可用数量、现价/成本价、市值、仓位百分比

### strategy.js（信号生成）

**路径**：`D:\Code\longBrige-automation-program\src\core\strategy.js`

- **类**：`HangSengMultiIndicatorStrategy`
- **依赖**：使用 `indicatorHelpers.js` 中的 `getIndicatorValue` 函数统一提取指标值
- **生成两类信号**：
  1. **立即信号**（卖出/平仓）：条件满足时立即执行
  2. **延迟信号**（买入/开仓）：等待验证时间进行趋势确认
- **信号配置**：所有交易信号条件**完全可配置**，通过环境变量设置（`SIGNAL_BUYCALL`, `SIGNAL_SELLCALL`, `SIGNAL_BUYPUT`, `SIGNAL_SELLPUT`）
- **配置格式**：`(条件1,条件2,...)/N|(条件A)|(条件B,条件C)/M`
  - 括号内是条件列表，逗号分隔
  - `/N`：括号内条件需满足 N 项，不设则全部满足
  - `|`：分隔不同条件组（最多 3 个），满足任一组即可
  - **支持指标**：
    - `RSI:n`：任意周期 RSI（n 范围 1-100），如 `RSI:6<20`、`RSI:12>80`
    - `MFI`：资金流量指标
    - `D`：KDJ 的 D 值
    - `J`：KDJ 的 J 值
  - 支持运算符：`<` 和 `>`
- **信号类型**：
  - `BUYCALL`（买入做多 - 延迟验证）：使用 `SIGNAL_BUYCALL` 配置
  - `SELLCALL`（卖出做多 - 立即执行）：使用 `SIGNAL_SELLCALL` 配置
  - `BUYPUT`（买入做空 - 延迟验证）：使用 `SIGNAL_BUYPUT` 配置
  - `SELLPUT`（卖出做空 - 立即执行）：使用 `SIGNAL_SELLPUT` 配置
- **默认配置示例**（仅供参考，实际需在 `.env` 中配置）：
  - BUYCALL: `(RSI:6<20,MFI<15,D<20,J<-1)/3|(J<-20)`
  - SELLCALL: `(RSI:6>80,MFI>85,D>79,J>100)/3|(J>110)`
  - BUYPUT: `(RSI:6>80,MFI>85,D>80,J>100)/3|(J>120)`
  - SELLPUT: `(RSI:6<20,MFI<15,D<22,J<0)/3|(J<-15)`
- **注意**：所有信号配置都是必需项，未配置或格式无效将导致程序启动失败
- **动态指标周期**：
  - 系统自动从配置中提取所有 RSI 周期（`extractRSIPeriods`）
  - 系统自动从配置中提取所有 EMA 周期（`EMA:n` 格式）
  - 根据提取的周期列表计算相应指标值
  - 例如配置 `RSI:6` 和 `RSI:12`，会同时计算 RSI6 和 RSI12
  - 例如配置 `EMA:5` 和 `EMA:10`，会同时计算 EMA5 和 EMA10

### trader.js（订单执行）

**路径**：`D:\Code\longBrige-automation-program\src\core\trader.js`

- **类**：`Trader`
- **核心方法**：
  - `executeSignals()`：根据过滤后的信号提交订单
  - `monitorAndManageOrders()`：监控未成交买入订单，市场价下跌时降低委托价
  - `_submitTargetOrder()`：根据目标金额计算数量并提交 ELO 订单
- **交易频率限制**：同方向买入时间间隔可配置（`BUY_INTERVAL_SECONDS`，范围 10-600 秒，默认 60 秒）
- **订单类型**：所有订单使用 `ELO`（增强限价单），保护性清仓使用 `MO`（市价单）
- **买单监控**：买入信号执行后自动启用，所有订单成交后停止
- **Trade API 频率限制**：
  - 使用 `TradeAPIRateLimiter` 类限制 API 调用频率
  - 限制规则：30 秒内不超过 30 次调用，两次调用间隔不少于 0.02 秒
  - 所有 Trade API 调用（`accountBalance`, `stockPositions`, `todayOrders`, `submitOrder`, `replaceOrder`, `cancelOrder`）都会经过频率限制器
- **订单监控缓存机制**：
  - `getPendingOrders()` 方法使用 2 秒缓存（`_pendingOrdersCacheTTL = 2000ms`）
  - 缓存键包含 symbols 参数，确保不同 symbols 组合使用不同的缓存
  - 订单提交、修改、撤销成功后自动清除缓存

### risk.js（风险控制）

**路径**：`D:\Code\longBrige-automation-program\src\core\risk.js`

- **类**：`RiskChecker`
- **交易前检查**（仅针对买入信号）：
  1. **牛熊证风险**：牛证距离回收价 > 0.5%，熊证 < -0.5%
  2. **单日亏损限制**：整体浮亏必须 > `-MAX_DAILY_LOSS`
  3. **持仓市值限制**：单标的市值必须 ≤ `MAX_POSITION_NOTIONAL`
- **风险检查为门控**：检查失败则阻止信号执行，但允许卖出操作
- **整体浮亏计算详情**（用于 `maxDailyLoss` 限制）：
  - 持仓市值 ≈ 净资产 − 现金余额
  - 持仓成本 = Σ(quantity × costPrice)
  - 浮亏 = 持仓市值 − 持仓成本（负数表示浮亏，正数表示浮盈）
- **单标的浮亏保护（`maxUnrealizedLossPerSymbol`）**：
  - 通过 `unrealizedLossData: Map(symbol → { r1, n1, lastUpdateTime })` 维护：
    - R1（开仓成本）= 所有未平仓买入订单的市值总和（每个订单市值 = 成交价 × 成交数量）
    - N1（持仓数量）= 所有未平仓买入订单的成交数量总和
  - 初始化：`refreshUnrealizedLossData(orderRecorder, symbol, isLong)`：
    - 直接从 `orderRecorder._longBuyOrders/_shortBuyOrders` 读取已过滤的订单列表
    - 计算 R1/N1 并写入 `unrealizedLossData`
    - **注意**：调用前需确保订单记录已刷新（程序启动时先调用 `refreshOrders`，交易后已通过 `recordLocalBuy/recordLocalSell` 更新）
  - 实时检查：`checkUnrealizedLoss(symbol, currentPrice, isLong)`：
    - 使用缓存的 R1、N1 与当前价格计算 R2 和浮亏：`unrealizedLoss = currentPrice * N1 − R1`
    - 当 `unrealizedLoss < -maxUnrealizedLossPerSymbol` 时返回 `shouldLiquidate=true` 和清仓数量（N1）
  - 交易后更新：
    - 买入/卖出后，`index.js` 先调用 `recordLocalBuy/recordLocalSell` 更新订单列表
    - 然后调用 `refreshUnrealizedLossData` 从已更新的订单列表重新计算 R1/N1（不调用 API）
    - **注意**：`refreshUnrealizedLossData` 方法直接从 `orderRecorder._longBuyOrders/_shortBuyOrders` 读取已过滤的订单列表计算，而不是从全部买入/卖出订单计算
- **保护性清仓流程（UnrealizedLossMonitor 模块执行）**：
  - 在价格变化时调用 `checkUnrealizedLoss` 判断是否需要保护性清仓
  - 若需要清仓：
    - 构造市价清仓信号（`useMarketOrder: true`，动作为 `SELLCALL` 或 `SELLPUT`）
    - 交给 `trader.executeSignals` 执行市价单
    - 清仓完成后调用 `orderRecorder.refreshOrders(..., forceRefresh=true)` 强制刷新订单记录（从 API 获取最新状态）
    - 然后调用 `refreshUnrealizedLossData` 从刷新后的订单列表重新计算 R1 与 N1

### orderRecorder.js（历史订单跟踪）

**路径**：`D:\Code\longBrige-automation-program\src\core\orderRecorder.js`

- **类**：`OrderRecorder`
- **用途**：跟踪已成交买入订单，用于智能清仓决策，同时为浮亏监控提供原始订单数据（R1/N1）
- **过滤逻辑**（从旧到新累积过滤算法）：
  1. **M0**：在最新卖出时间之后成交的买入订单
  2. **从旧到新过滤**：将卖出订单按成交时间从旧到新排序（D1 是最旧的，D2 次之，D3 是最新的）：
     - 对每个卖出订单（从 D1 到 D3）：
       a) 获取所有成交时间 < 该卖出订单时间的买入订单
       b) 计算这些买入订单的总数量
       c) 如果卖出数量 >= 买入总数量，则这些买入订单全部被卖出，无需记录
       d) 否则，从这些买入订单中过滤出成交价 >= 卖出价的订单
       e) 合并过滤结果和时间范围内的订单，继续处理下一个卖出订单
  3. **最终记录** = M0 + 过滤后的买入订单
- **业务含义**：
  - M0：最新买入，还未经历卖出
  - 过滤后的订单：历史高价买入且未被完全卖出的订单（价格高于对应卖出价或数量超出）
- **智能清仓**：当 currentPrice ≤ costPrice 时，仅卖出 buyPrice < currentPrice 的订单（盈利部分）
- **historyOrders 调用与缓存**：
  - historyOrders 通过 `fetchOrdersFromAPI(symbol)` 间接调用：
    - 标准化 symbol → 调用 `ctx.historyOrders({ symbol, endAt: new Date() })`
    - 只设置截止时间为当前时间，不设置开始时间，获取完整历史订单
    - 过滤出已成交买入/卖出单并转换为简化结构
    - 更新内部缓存：`_ordersCache.set(normalizedSymbol, { buyOrders, sellOrders, allOrders, fetchTime })`
    - `allOrders` 保存原始订单数据（包括未成交订单），用于启动时提取未成交订单
  - `_isCacheValid(normalizedSymbol, maxAgeMs=5*60*1000)`：
    - 使用 `fetchTime` 判断缓存是否在 5 分钟有效期内（默认 5 分钟）
  - `_fetchAndConvertOrders(symbol, forceRefresh=false)`：
    - 当 `forceRefresh=false` 且缓存有效 → 返回缓存
    - 否则 → 调用 `fetchOrdersFromAPI(symbol)` 刷新缓存并返回
- **程序启动时的重试机制**：
  - `fetchOrdersFromAPIWithRetry(symbol, maxRetries=30)`：
    - 程序启动时调用，每 10 秒重试一次，最多重试 30 次（约 5 分钟）
    - 成功后调用 `enableSymbol()` 确保标的可交易
    - 所有重试都失败后调用 `disableSymbol()` 禁用该标的的交易
- **标的禁用机制**：
  - `_disabledSymbols`：Set 类型，记录因订单获取失败而被禁用的标的
  - `isSymbolDisabled(symbol)`：检查标的是否被禁用
  - `disableSymbol(symbol)`：禁用标的交易
  - `enableSymbol(symbol)`：启用标的交易
  - 禁用的标的在信号执行时会被跳过（SignalProcessor 模块检查）
- **未成交订单提取**：
  - `getPendingOrdersFromCache(symbols)`：从缓存的原始订单中提取未成交订单
  - 用于启动时避免重复调用 todayOrders API
- **运行时本地更新（避免频繁 historyOrders 调用）**：
  - `recordLocalBuy` / `recordLocalSell`：
    - 在交易执行后由 `index.js` 调用，仅更新内存中的买入记录，不触发 API 调用
  - 交易后刷新浮亏数据：
    - 调用 `riskChecker.refreshUnrealizedLossData()` 从已更新的订单列表重新计算 R1/N1（不调用 API）
    - **注意**：`refreshUnrealizedLossData` 方法直接从 `_longBuyOrders/_shortBuyOrders` 读取已过滤的订单列表计算，而不是从全部买入/卖出订单计算

### indicators.js（技术指标计算）

**路径**：`D:\Code\longBrige-automation-program\src\services\indicators.js`

- **实现方式**：使用 `technicalindicators` 库优化指标计算，性能提升约 2.9 倍
- **RSI**：使用 RSI.calculate（Wilder's Smoothing，平滑系数 = 1/period），计算周期支持动态配置（默认 RSI6、RSI12）
- **MFI**：使用 MFI.calculate（资金流量指标，周期 14），结合价格和成交量的超买超卖指标
- **KDJ**：使用 EMA(period=5) 实现平滑系数 1/3，包含 K、D、J 值
- **MACD**：使用 MACD.calculate（EMA 计算方式），DIF（EMA12-EMA26）、DEA（DIF 的 EMA9）、MACD 柱（DIF-DEA）×2
- **EMA**：支持动态周期 EMA 计算（从配置中提取所有 EMA:n 周期）
- **函数**：`buildIndicatorSnapshot()` 返回包含所有指标的统一对象

### objectPool.js（对象池模块）

**路径**：`D:\Code\longBrige-automation-program\src\utils\objectPool.js`

- **类**：`ObjectPool`（通用对象池）
- **用途**：减少频繁的对象创建和垃圾回收，提升内存效率
- **导出的对象池**：
  - `verificationEntryPool`：验证历史条目对象池（最大 50 个），用于 `signalVerification.js` 记录每秒指标值
  - `positionObjectPool`：持仓数据对象池（最大 10 个），用于 `accountDisplay.js` 格式化持仓信息
  - `signalObjectPool`：信号对象池（最大 20 个），用于 `strategy.js` 和 `signalVerification.js` 复用信号对象
- **核心方法**：
  - `acquire()`：从池中获取对象
  - `release(obj)`：将对象归还到池中（自动重置对象状态）
  - `releaseAll(objects)`：批量释放对象数组
- **设计特点**：
  - 使用工厂函数创建对象
  - 使用重置函数清空对象状态（避免内存泄漏）
  - 池满时自动丢弃对象，让 GC 回收

### indicatorHelpers.js（指标辅助函数）

**路径**：`D:\Code\longBrige-automation-program\src\utils\indicatorHelpers.js`

- **用途**：从指标状态对象中提取指定指标的值，供策略模块和信号验证模块使用
- **核心函数**：
  - `getIndicatorValue(state, indicatorName)`：从指标状态中提取指定指标的值
  - `isValidNumber(value)`：检查值是否为有效的有限数字
- **支持的指标**：
  - K、D、J（KDJ 指标）
  - MACD、DIF、DEA（MACD 指标）
  - EMA:n（任意周期的 EMA 指标，如 EMA:5, EMA:10）
- **设计目的**：统一指标值提取逻辑，避免在 strategy.js 和 signalVerification.js 中重复实现

### quoteClient.js（行情数据）

**路径**：`D:\Code\longBrige-automation-program\src\services\quoteClient.js`

- **类**：`MarketDataClient`
- **缓存机制**：
  - 行情数据：1 秒 TTL（避免同一循环内重复 API 调用）
  - 交易日信息：24 小时 TTL（按需查询当日是否为交易日）
- **核心方法**：
  - `getLatestQuote(symbol)`：获取单个标的实时行情（带缓存和静态信息）
  - `getQuotes(symbols)`：获取多个标的实时行情
  - `getCandlesticks(symbol, period, count)`：获取 K 线数据（默认 200 根，1 分钟周期）
  - `isTradingDay(date)`：检查指定日期是否为交易日
  - `checkWarrantInfo(symbol)`：检查标的是否为牛熊证并获取回收价

## 辅助模块和工具

### logger.js（基于 pino 的高性能日志系统）

**路径**：`D:\Code\longBrige-automation-program\src\utils\logger.js`

- **实现**：基于 pino 的多流日志系统
- **设计特点**：
  - **双流输出**：同时输出到控制台和文件
  - **按日期分割**：使用 `DateRotatingStream` 自动按日期分割日志文件
  - **多目录存储**：
    - `logs/system/`：系统日志（所有日志级别）
    - `logs/debug/`：调试日志（仅 DEBUG 级别，启用 `DEBUG=true` 时）
  - **自定义格式化**：
    - 控制台输出：带颜色高亮
    - 文件输出：纯文本格式，自动移除 ANSI 颜色代码
  - **超时保护**：写入操作带有 drain 超时保护（3-5 秒）
- **日志级别**：
  - DEBUG (20)、INFO (30)、WARN (40)、ERROR (50)
  - 控制台：WARN 和 ERROR 输出到 stderr，其他输出到 stdout
- **进程清理**：
  - 支持同步清理（`cleanupSync`）和异步清理（`cleanupAsync`）
  - 自动监听进程信号（SIGINT、SIGTERM、beforeExit）
  - 处理未捕获异常和 Promise 拒绝
- **API**：`logger.info()`, `logger.warn()`, `logger.error()`, `logger.debug(extra)`

### utils.js（工具函数）

**路径**：`D:\Code\longBrige-automation-program\src\utils\helpers.js`

- **normalizeHKSymbol()**：标准化港股代码（添加 `.HK` 后缀）
- **decimalToNumber()**：转换 LongPort API 的 Decimal 对象为数字
- **toBeijingTimeIso()** / **toBeijingTimeLog()**：UTC 到北京时间转换

### signalConfigParser.js（信号配置解析器）

**路径**：`D:\Code\longBrige-automation-program\src\utils\signalConfigParser.js`

- **用途**：解析和验证信号配置字符串，支持动态 RSI 和 EMA 周期
- **核心函数**：
  - `parseSignalConfig(configStr)`：解析信号配置字符串
  - `validateSignalConfig(configStr)`：验证配置格式并返回详细信息
  - `evaluateCondition(state, condition)`：评估单个条件是否满足
  - `evaluateConditionGroup(state, conditionGroup)`：评估条件组
  - `evaluateSignalConfig(state, signalConfig)`：评估完整信号配置
  - `formatSignalConfig(signalConfig)`：格式化配置为可读字符串
  - `extractRSIPeriods(signalConfig)`：从配置中提取所有 RSI 周期
  - `extractEMAPeriods(signalConfig)`：从配置中提取所有 EMA 周期
- **配置格式**：
  - 标准格式：`(条件1,条件2,...)/N|(条件A)|(条件B,条件C)/M`
  - RSI 动态周期：`RSI:n<threshold` 或 `RSI:n>threshold`（n 为 1-100）
  - EMA 动态周期：`EMA:n<threshold` 或 `EMA:n>threshold`（n 为 1-250）
  - 固定指标：`MFI`、`D` (KDJ.D)、`J` (KDJ.J)、`K` (KDJ.K)、`MACD`、`DIF`、`DEA`
- **支持指标**：
  - `RSI:n`：任意周期 RSI（n 范围 1-100）
  - `MFI`：资金流量指标
  - `D`：KDJ 的 D 值
  - `J`：KDJ 的 J 值
  - `K`：KDJ 的 K 值
  - `MACD`：MACD 柱状值
  - `DIF`：MACD DIF 值
  - `DEA`：MACD DEA 值
  - `EMA:n`：任意周期 EMA（n 范围 1-250）
- **验证特性**：
  - 检查括号匹配
  - 检查条件数量与 minSatisfied 范围
  - 检查指标是否支持
  - 返回详细的错误信息（指出具体问题位置）

### signalTypes.js（信号类型定义）

**路径**：`D:\Code\longBrige-automation-program\src\utils\constants.js`

- 定义所有交易信号类型：`BUYCALL`, `SELLCALL`, `BUYPUT`, `SELLPUT`, `HOLD`

### 分析工具

#### findWarrant.js（牛熊证搜索工具）

**路径**：`D:\Code\longBrige-automation-program\src\tools\findWarrant.js`

- **用途**：搜索符合条件的牛熊证
- **运行**：`npm run find-warrant`
- **功能**：根据标的、到期日、回收价等条件筛选牛熊证

#### indicatorAnalysis.js（指标分析工具）

**路径**：`D:\Code\longBrige-automation-program\src\tools\indicatorAnalysis.js`

- **用途**：分析历史数据的技术指标表现
- **功能**：回测指标策略效果

### Windows 启动脚本

#### start.bat

**路径**：`D:\Code\longBrige-automation-program\start.bat`

- **用途**：Windows 快捷启动脚本
- **功能**：
  1. 验证 Node.js 是否安装
  2. 检查 `.env` 文件是否存在
  3. 执行 `npm start`
- **使用**：双击 `start.bat` 即可启动系统

## 关键数据流

### 信号处理流程（3 个阶段）

```
1. 生成阶段 (strategy.generateCloseSignals)
   ├─ 立即信号（卖出）：条件满足时立即执行
   │  ├─ SELLCALL: (4指标满足3个以上) 或 J>110
   │  └─ SELLPUT: (4指标满足3个以上) 或 J<-15
   └─ 延迟信号（买入）：添加到待验证列表，记录 indicators1（所有配置的验证指标初始值）
      ├─ BUYCALL: (4指标满足3个以上) 或 J<-20
      └─ BUYPUT: (4指标满足3个以上) 或 J>120
   注意：成本价和VWAP检查不在信号生成阶段，而在执行策略中处理

2. 验证阶段（延迟时间后在 runOnce 中）
   ├─ 延迟时间可配置（VERIFICATION_DELAY_SECONDS，默认 60 秒，设为 0 则不延迟验证）
   ├─ 验证指标可配置（VERIFICATION_INDICATORS，可选 K、D、J、MACD、DIF、DEA，默认 J,MACD）
   ├─ 每秒记录当前配置的所有验证指标值到信号的验证历史中（SignalVerificationManager 模块）
   │  ├─ 条件：triggerTime ± 5秒窗口内（仅在此窗口内记录）
   │  ├─ 去重：避免在同一秒内重复记录（精确到秒）
   │  ├─ 限制：只保留 triggerTime ± 5秒窗口内的历史数据
   │  └─ 每个信号有独立的 verificationHistory 数组
   ├─ 对每个超过 triggerTime 的待验证信号：
   │  ├─ 获取 indicators1（触发时已记录的所有配置指标初始值）
   │  ├─ 从验证历史中获取 indicators2（所有配置指标的第二个值）：
   │  │  ├─ 优先：精确匹配目标时间（triggerTime）
   │  │  └─ 备选：距离目标时间最近的值（误差≤5秒）
   │  ├─ BUYCALL验证：所有配置指标的第二个值都要大于第一个值（例如：J2>J1 且 MACD2>MACD1）→ 通过
   │  ├─ BUYPUT验证：所有配置指标的第二个值都要小于第一个值（例如：J2<J1 且 MACD2<MACD1）→ 通过
   │  └─ 验证通过 → 移至执行列表
   └─ 清理：从待验证列表中移除已处理的信号，并清空其验证历史

3. 执行阶段 (index.js + trader.executeSignals)
   ├─ 买入操作检查顺序（SignalProcessor 模块）：
   │  1. 交易频率限制检查（若不通过直接拒绝，不进行后续检查）
   │  2. 买入前价格检查（若当前标的价格 > 订单记录里最新订单的成交价则拒绝买入）
   │  3. 末日保护程序检查（收盘前15分钟拒绝买入）
   │  4. 牛熊证风险检查（使用监控标的的价格计算距离回收价百分比）
   │  5. 基础风险检查（浮亏限制和持仓市值限制）
   ├─ 对所有信号：
   │  ├─ 实时获取账户和持仓数据（买入操作必须获取最新数据）
   │  └─ 应用对应的风险检查规则
   ├─ 卖出信号成本价判断与数量计算（SignalProcessor 模块）：
   │  ├─ 使用 calculateSellQuantity() 函数统一处理做多和做空标的
   │  ├─ 如果 currentPrice > costPrice（做多）或 currentPrice < costPrice（做空）：卖出全部持仓
   │  ├─ 否则（未盈利状态）：
   │  │  ├─ 从 orderRecorder 获取 buyPrice < currentPrice 的历史订单
   │  │  ├─ 如果有符合订单：卖出这些订单的总数量（智能清仓）
   │  │  └─ 如果无符合订单：信号设为 HOLD（持有，不卖出）
   │  └─ 卖出数量不能超过可用持仓数量
   ├─ 根据目标金额计算买入数量（trader.js:1015-1083）
   ├─ 提交 ELO 订单（trader.js:1119-1207）
   ├─ 订单成交后本地更新订单记录（index.js 主循环调用）：
   │  ├─ 买入成交后：调用 orderRecorder.recordLocalBuy() 本地追加记录
   │  ├─ 卖出成交后：调用 orderRecorder.recordLocalSell() 本地更新记录
   │  └─ 刷新浮亏数据：调用 riskChecker.refreshUnrealizedLossData()
   └─ 启用订单监控（买入操作）
```

### 状态管理模式

**持久状态**（在 `lastState` 中跨循环迭代维护）：

- `pendingDelayedSignals[]`：等待 60 秒验证的信号
- `cachedAccount`：上次账户快照（交易后更新）
- `cachedPositions[]`：上次持仓快照（交易后更新）
- `monitorValues`：最新指标值
- `longPrice`、`shortPrice`：上次价格（用于变化检测）
- `signal`：上次信号键（用于变化检测）
- `canTrade`：交易时段状态
- `isHalfDay`：半日交易标志

**临时状态**（每次循环重置）：

- `hasChange`：本次迭代数据是否变化
- `finalSignals[]`：本次迭代要执行的信号
- `account`、`positions`：用于风险检查的新快照

### 初始化序列（main 函数）

```
1. 验证所有配置（标的存在、是否有效港股）
2. 初始化组件：
   ├─ Strategy（带指标阈值）
   ├─ Trader（延迟 TradeContext 初始化）
   ├─ OrderRecorder（链接到 Trader）
   └─ RiskChecker（带亏损/持仓限制）
3. 显示初始账户和持仓信息（`displayAccountAndPositions`，并缓存 account/positions）
4. 使用 historyOrders 初始化订单与浮亏数据（做多 + 做空，带重试机制）：
   ├─ `orderRecorder.fetchOrdersFromAPIWithRetry(longSymbol/shortSymbol)` → 从 API 获取历史订单（带重试，失败则禁用标的）
   ├─ `orderRecorder.refreshOrders(symbol, isLong, false)` → 从缓存计算当前仍需记录的买入订单（仅对未被禁用的标的执行）
   └─ `riskChecker.refreshUnrealizedLossData(orderRecorder, symbol, isLong, false)` → 从缓存读取全部买/卖单并计算 R1/N1（仅对未被禁用的标的执行）
5. 检查待处理买入订单 → 如有则启用订单监控
6. 启动无限循环（`runOnce` 每秒执行）
```

## 重要模式和注意事项

### 标的代码规范化

所有标的代码使用 `normalizeHKSymbol()` 规范化为包含 `.HK` 后缀。这对以下场景至关重要：

- Map 键（待处理订单、上次买入时间）
- API 调用（有些接受带/不带后缀）
- 相等性比较

### Decimal 到数字的转换

LongPort API 返回 `Decimal` 对象。计算前务必使用 `decimalToNumber()` 转换：

```javascript
const price = decimalToNumber(quote.lastDone);
```

### 时区处理

- **系统内部使用 UTC**
- **港股交易时间**（UTC+8）：正常交易日 09:30-12:00 和 13:00-16:00，半日交易日仅 09:30-12:00
- **日志显示北京时间**（UTC+8），通过 `toBeijingTimeIso()` 和 `toBeijingTimeLog()` 转换
- **API 时间戳**为 UTC，仅在显示时转换

### 按方向的频率限制

- `_lastBuyTime` map 的键为：`"LONG"` | `"SHORT"`（不是标的代码）
- BUYCALL 更新 "LONG" 键 → 60 秒内阻止下一个 BUYCALL
- BUYPUT 更新 "SHORT" 键 → 60 秒内阻止下一个 BUYPUT
- SELLCALL/SELLPUT 绕过频率检查

### 数量计算

```javascript
// 买入：确保数量符合每手股数
const qty = Math.floor(targetNotional / price / lotSize) * lotSize;

// 卖出：使用可用持仓数量（向下取整到每手的倍数）
const sellQty = clearAll ? availableQty : Math.min(calculateQty, availableQty);
```

### 订单监控行为

- 仅监控买入订单（不监控卖出订单）
- 在买入信号执行后调用 `enableBuyOrderMonitoring()` 时启动监控
- 所有买入订单成交后停止监控
- 价格优化：如果当前价格 < 订单价格，则向下修改订单

### 牛熊证风险检查

- 仅应用于买入信号（risk.js:508-609）
- **回收价计算**（使用监控标的的实时价格，而非牛熊证本身的价格）：
  - 牛证：距离回收价百分比 = (监控标的当前价 - 回收价) / 回收价 × 100%
  - 熊证：距离回收价百分比 = (监控标的当前价 - 回收价) / 回收价 × 100%（结果为负数）
- **风险阈值**：
  - 牛证（BUYCALL）：距离回收价必须 > 0.5%
  - 熊证（BUYPUT）：距离回收价必须 < -0.5%（即 > 0.5%的反向）
- **额外保护**：
  - 监控标的价格必须 > 1，否则拒绝买入（防止使用错误价格）
  - 监控标的价格异常小可能是获取到了牛熊证本身的价格而非标的指数价格
- 如信号中未提供监控标的价格，自动从行情数据获取（优先使用实时行情价格，其次使用 K 线收盘价）

### 收盘前保护机制

- **收盘前 15 分钟拒绝买入**（DoomsdayProtection 模块）：
  - 正常交易日：15:45-16:00
  - 半日交易日：11:45-12:00
  - 所有买入信号在此时段内被拦截，卖出信号不受影响
- **收盘前 5 分钟自动清仓**（DoomsdayProtection 模块）：
  - 正常交易日：15:55-15:59
  - 半日交易日：11:55-11:59
  - 为所有持仓生成 SELLCALL 或 SELLPUT 信号（忽略其他条件）
  - 由 `DOOMSDAY_PROTECTION` 环境变量控制（默认 true）

## 关键技术约束

1. **无卖空操作**：本系统买入牛熊证，不是卖空标的股票
2. **交易时段强制执行**：基于系统时间（非行情时间）的严格检查
3. **成本基础跟踪至关重要**：OrderRecorder 维护详细历史用于智能清仓逻辑
4. **仅监控标的生成信号**：做多/做空标的仅为执行目标（不计算其指标）
5. **1 分钟 K 线粒度**：200 根 K 线 = 约 200 分钟 = 约 3 小时历史
6. **必须使用 ELO 订单类型**：所有订单必须使用增强限价单并指定价格
7. **买入操作数据要求**：买入时必须实时获取最新账户和持仓数据以确保浮亏计算准确（SignalProcessor 模块实现）
8. **卖出操作灵活性**：卖出时可使用缓存数据（卖出操作不检查浮亏限制）
9. **HOLD 信号机制**：当卖出条件触发但成本价判断失败时，信号设为 HOLD（持有）而非拒绝（SignalProcessor 模块实现）
10. **订单监控仅针对买入**：只监控买入订单的价格变化，卖出订单不监控（trader.js:426-543）

## 调试技巧

### 追踪信号流

1. 检查 `strategy.js`（`D:\Code\longBrige-automation-program\src\core\strategy.js`）日志查看信号生成（立即 vs 延迟）
2. 对于延迟信号，检查 lastState 中的 `pendingDelayedSignals`（等待 60 秒）
3. 验证验证历史在触发时间点包含配置的验证指标值（默认 D 和 DIF）
4. 检查 `risk.js`（`D:\Code\longBrige-automation-program\src\core\risk.js`）日志了解信号被过滤的原因（牛熊证风险、单日亏损、持仓限制）
5. 检查 `trader.js`（`D:\Code\longBrige-automation-program\src\core\trader.js`）日志查看频率限制或订单提交错误

### 验证指标计算

在 `.env` 中启用 `DEBUG=true` 查看每秒记录的详细指标值：

- RSI6、MFI、KDJ(K,D,J)、MACD(DIF,DEA,MACD)

### 检查订单记录

每次交易后，`orderRecorder.refreshOrders()`（`D:\Code\longBrige-automation-program\src\core\orderRecorder.js`）记录过滤过程：

- 今日总买入订单数
- 今日总卖出订单数
- 过滤掉多少订单
- 最终记录数量

### 监控未成交订单

Trader 日志显示：

- 买入订单监控何时启动/停止
- 订单价格何时被修改（价格优化）
- 所有订单何时成交

### 日志文件位置

- **交易记录**：`D:\Code\longBrige-automation-program\logs\trades\YYYY-MM-DD.json`
- **控制台日志**：实时显示，由 `logger.js`（`D:\Code\longBrige-automation-program\src\utils\logger.js`）管理

## 配置要求

所有配置必须在 `.env` 文件中设置（参见 `.env.example`）：

**配置文件位置**：

- 环境变量：`D:\Code\longBrige-automation-program\.env`
- 配置示例：`D:\Code\longBrige-automation-program\.env.example`
- API 配置：`D:\Code\longBrige-automation-program\src\config\config.js`
- 交易配置：`D:\Code\longBrige-automation-program\src\config\config.trading.js`
- 配置验证：`D:\Code\longBrige-automation-program\src\config\config.validator.js`

**必需配置**：

- LongPort API 凭证（APP_KEY、APP_SECRET、ACCESS_TOKEN）
- 交易标的（MONITOR_SYMBOL、LONG_SYMBOL、SHORT_SYMBOL）
- 交易金额（TARGET_NOTIONAL、LONG_LOT_SIZE、SHORT_LOT_SIZE）
- 风险限制（MAX_POSITION_NOTIONAL、MAX_DAILY_LOSS）
- **信号配置**（SIGNAL_BUYCALL、SIGNAL_SELLCALL、SIGNAL_BUYPUT、SIGNAL_SELLPUT）

**可选配置**：

- DOOMSDAY_PROTECTION（默认：true）
- DEBUG（默认：false）
- MAX_UNREALIZED_LOSS_PER_SYMBOL（单标的浮亏保护阈值，默认：0，关闭保护）
- VERIFICATION_DELAY_SECONDS（延迟验证时间间隔，范围 0-120 秒，未设置时默认 60，设为 0 表示不延迟验证）
- VERIFICATION_INDICATORS（延迟验证指标列表，可选值：K, D, J, MACD, DIF, DEA，逗号分隔，留空或不设置表示不延迟验证，推荐 D,DIF）
- BUY_INTERVAL_SECONDS（同方向买入时间间隔，范围 10-600 秒，默认 60 秒，用于限制同一方向的买入频率）

如果任何必需配置缺失或无效，启动将失败（config.validator.js 检查所有设置）。

## 常见开发任务

修改本系统时：

1. **添加新指标**：更新 `indicators.js`（`D:\Code\longBrige-automation-program\src\services\indicators.js`），利用 `technicalindicators` 库添加新指标，然后修改 `buildIndicatorSnapshot()` 和 `signalConfigParser.js` 中的指标支持列表
2. **修改信号逻辑**：
   - 直接编辑 `.env` 文件中的信号配置（`SIGNAL_BUYCALL`, `SIGNAL_SELLCALL`, `SIGNAL_BUYPUT`, `SIGNAL_SELLPUT`），无需修改代码
   - 配置格式：`(RSI:n<20,MFI<15,D<20,J<-1)/3|(J<-20)`
   - 支持动态 RSI 周期：`RSI:n`（n 范围 1-100）
3. **添加/修改信号配置规则**：编辑 `signalConfigParser.js`（`D:\Code\longBrige-automation-program\src\utils\signalConfigParser.js`），修改 `SUPPORTED_INDICATORS` 数组添加新指标
4. **调整风险控制**：修改 `risk.js`（`D:\Code\longBrige-automation-program\src\core\risk.js`）检查，始终仅对买入信号进行门控（允许卖出）
5. **订单类型变更**：更新 `trader.js`（`D:\Code\longBrige-automation-program\src\core\trader.js`）\_submitTargetOrder()，确保订单类型被 LongPort API 支持
6. **修改配置参数**：编辑 `.env` 文件或 `config.trading.js`（`D:\Code\longBrige-automation-program\src\config\config.trading.js`）
7. **测试**：使用模拟交易账户（在 LongPort API 设置中配置）

## 架构原则

本代码库遵循以下模式：

- **关注点分离**：每个模块单一职责
- **故障安全设计**：多重风险检查门控高风险操作（买入）
- **状态最小化**：仅必要状态跨迭代持久化
- **缓存策略**：1 秒行情缓存，24 小时交易日缓存
- **对象池复用**：verificationEntryPool 和 positionObjectPool 减少 GC 压力
- **异步日志队列**：logger.js 使用异步队列批量处理，避免阻塞主循环
- **防御性编程**：广泛的验证和错误处理
- **日志透明度**：详细日志解释每个决策

## 快速文件导航

**核心模块**：

- [主入口](./src/index.js)
- [交易策略](./src/core/strategy.js)
- [订单执行](./src/core/trader.js)
- [风险控制](./src/core/risk.js)
- [订单记录](./src/core/orderRecorder.js)
- [技术指标](./src/services/indicators.js)
- [行情客户端](./src/services/quoteClient.js)

**辅助模块**：

- [对象池](./src/utils/objectPool.js)
- [指标辅助函数](./src/utils/indicatorHelpers.js)
- [日志系统](./src/utils/logger.js)
- [信号配置解析](./src/utils/signalConfigParser.js)
- [工具函数](./src/utils/helpers.js)
- [信号类型](./src/utils/constants.js)
- [交易时段](./src/utils/tradingTime.js)
- [账户显示](./src/utils/accountDisplay.js)

**配置文件**：

- [API 配置](./src/config/config.js)
- [交易配置](./src/config/config.trading.js)
- [配置验证](./src/config/config.validator.js)
- 环境变量：[`.env`](./.env)（需手动创建）
- 配置示例：[`.env.example`](./.env.example)

**分析工具**：

- [牛熊证搜索](./src/tools/findWarrant.js)
- [指标分析](./src/tools/indicatorAnalysis.js)

**日志文件**：

- 交易记录：`logs/trades/YYYY-MM-DD.json`

**启动脚本**：

- Windows 启动：[`start.bat`](./start.bat)
