# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在此代码库中工作时提供指导。

## 系统概述

这是一个 LongBridge 港股自动化量化交易系统。它通过技术指标监控目标资产（如恒生指数），并在牛熊证上执行双向交易。

**核心设计模式**：多指标组合策略，开仓信号采用 60 秒延迟验证，平仓信号立即执行。

## 核心架构

```
主循环 (index.js) → 每秒执行一次
  ├─ 行情数据 (QuoteClient)
  ├─ 指标计算 (indicators.js) - 使用 technicalindicators 库
  ├─ 信号生成 (strategy.js)
  ├─ 风险验证 (risk.js)
  ├─ 订单执行 (trader.js)
  ├─ 订单记录 (orderRecorder.js)
  └─ 对象池 (objectPool.js) - 内存优化
```

## 文档导航

- **[业务逻辑完整说明](./BUSINESS_LOGIC.md)** ⭐ - 核心业务逻辑权威参考（必读）
- **[技术指标说明](./TECHNICAL_INDICATORS.md)** - RSI、KDJ、MACD、MFI 计算原理和使用方法
- **[项目结构说明](./PROJECT_STRUCTURE.md)** - 目录结构和模块组织
- **[代码审查记录](./CODE_REVIEW.md)** - 代码检查结果和潜在问题
- **[LongBridge API 参考](./LONGBRIDGE_API.md)** - LongBridge OpenAPI 完整使用指南

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

### index.js（主入口）

**路径**：`D:\Code\LongBrigeAutomationProgram\src\index.js`

- **主循环**：`runOnce()` 每秒执行一次
- **交易时段检查**：验证港股交易时间（09:30-12:00, 13:00-16:00）
- **状态管理**：维护 `lastState` 对象，在循环迭代间保持：
  - 待验证的延迟信号（等待 60 秒验证）
  - 缓存的账户/持仓数据
  - 上次指标值（用于变化检测）
- **收盘前保护机制**：
  - 收盘前 15 分钟拒绝买入（正常日 15:45-16:00，半日 11:45-12:00）
  - 收盘前 5 分钟自动清仓（正常日 15:55-15:59，半日 11:55-11:59）
- **成本价判断与卖出策略**（index.js:1329-1458）：
  - 当 currentPrice > costPrice 时：立即清空所有持仓
  - 当 currentPrice ≤ costPrice 时：仅卖出 buyPrice < currentPrice 的历史订单（智能清仓）
  - 如果没有符合条件的订单，信号被设为 HOLD（持有）

**关键函数**：

- `isInContinuousHKSession()` - 交易时段验证
- `isBeforeClose15Minutes()` / `isBeforeClose5Minutes()` - 收盘前检查
- `getHKTime()` - UTC 到香港时区转换

### strategy.js（信号生成）

**路径**：`D:\Code\LongBrigeAutomationProgram\src\core\strategy.js`

- **类**：`HangSengMultiIndicatorStrategy`
- **生成两类信号**：
  1. **立即信号**（卖出/平仓）：条件满足时立即执行
  2. **延迟信号**（买入/开仓）：等待 60 秒进行趋势确认
- **多指标逻辑**：要求 4 个指标（RSI6、MFI、KDJ.D、KDJ.J）中至少 3 个满足阈值
- **信号类型及触发条件**（所有信号采用条件 1 或条件 2 的"或"关系）：
  - `BUYCALL`（买入做多 - 延迟验证）：
    - 条件 1：RSI6<20, MFI<15, KDJ.D<20, KDJ.J<-1 四个指标满足 3 个以上
    - 条件 2：J < -20
    - 验证：J2 > J1 且 MACD2 > MACD1
  - `SELLCALL`（卖出做多 - 立即执行）：
    - 条件 1：RSI6>80, MFI>85, KDJ.D>79, KDJ.J>100 四个指标满足 3 个以上
    - 条件 2：J > 110
    - 注意：成本价判断在卖出策略中进行，信号生成时不检查
  - `BUYPUT`（买入做空 - 延迟验证）：
    - 条件 1：RSI6>80, MFI>85, KDJ.D>80, KDJ.J>100 四个指标满足 3 个以上
    - 条件 2：J > 120
    - 验证：J2 < J1 且 MACD2 < MACD1
  - `SELLPUT`（卖出做空 - 立即执行）：
    - 条件 1：RSI6<20, MFI<15, KDJ.D<22, KDJ.J<0 四个指标满足 3 个以上
    - 条件 2：J < -15
    - 注意：成本价判断在卖出策略中进行，信号生成时不检查

### trader.js（订单执行）

**路径**：`D:\Code\LongBrigeAutomationProgram\src\core\trader.js`

- **类**：`Trader`
- **核心方法**：
  - `executeSignals()`：根据过滤后的信号提交订单
  - `monitorAndManageOrders()`：监控未成交买入订单，市场价下跌时降低委托价
  - `_submitTargetOrder()`：根据目标金额计算数量并提交 ELO 订单
- **交易频率限制**：同方向 60 秒内不能重复买入
- **订单类型**：所有订单使用 `ELO`（增强限价单）
- **买单监控**：买入信号执行后自动启用，所有订单成交后停止

### risk.js（风险控制）

**路径**：`D:\Code\LongBrigeAutomationProgram\src\core\risk.js`

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
    - 然后调用 `refreshUnrealizedLossData` 从订单列表重新计算 R1/N1（不调用 API）
- **保护性清仓流程（index.js 中使用）**：
  - 在价格变化时调用 `checkUnrealizedLoss` 判断是否需要保护性清仓（index.js:427-504）
  - 若需要清仓：
    - 构造市价清仓信号（`useMarketOrder: true`，动作为 `SELLCALL` 或 `SELLPUT`）
    - 交给 `trader.executeSignals` 执行市价单
    - 清仓完成后调用 `orderRecorder.refreshOrders(..., forceRefresh=true)` 强制刷新订单记录
    - 然后调用 `refreshUnrealizedLossData` 重新计算 R1 与 N1

### orderRecorder.js（历史订单跟踪）

**路径**：`D:\Code\LongBrigeAutomationProgram\src\core\orderRecorder.js`

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
- **todayOrders 调用与缓存**：
  - todayOrders 只通过 `fetchOrdersFromAPI(symbol)` 间接调用：
    - 标准化 symbol → 调用 `ctx.todayOrders({ symbol })`
    - 过滤出已成交买入/卖出单并转换为简化结构
    - 更新内部缓存：`_ordersCache.set(normalizedSymbol, { buyOrders, sellOrders, fetchTime })`
  - `_isCacheValid(normalizedSymbol, maxAgeMs=5*60*1000)`：
    - 使用 `fetchTime` 判断缓存是否在 5 分钟有效期内
  - `_fetchAndConvertOrders(symbol, forceRefresh=false)`：
    - 当 `forceRefresh=false` 且缓存有效 → 返回缓存
    - 否则 → 调用 `fetchOrdersFromAPI(symbol)` 刷新缓存并返回
- **运行时本地更新（避免频繁 todayOrders 调用）**：
  - `recordLocalBuy` / `recordLocalSell`：
    - 在交易执行后由 `index.js` 调用，仅更新内存中的买入记录，不触发 API 调用
  - 交易后刷新浮亏数据：
    - 调用 `riskChecker.refreshUnrealizedLossData()` 从订单列表重新计算 R1/N1（不调用 API）

### indicators.js（技术指标计算）

**路径**：`D:\Code\LongBrigeAutomationProgram\src\services\indicators.js`

- **实现方式**：使用 `technicalindicators` 库优化指标计算，性能提升约 2.9 倍
- **RSI**：使用 RSI.calculate（Wilder's Smoothing，平滑系数 = 1/period），计算周期 6
- **MFI**：使用 MFI.calculate（资金流量指标，周期 14），结合价格和成交量的超买超卖指标
- **KDJ**：使用 EMA(period=5) 实现平滑系数 1/3，包含 K、D、J 值
- **MACD**：使用 MACD.calculate（EMA 计算方式），DIF（EMA12-EMA26）、DEA（DIF 的 EMA9）、MACD 柱（DIF-DEA）×2
- **函数**：`buildIndicatorSnapshot()` 返回包含所有指标的统一对象

### objectPool.js（对象池模块）

**路径**：`D:\Code\LongBrigeAutomationProgram\src\utils\objectPool.js`

- **类**：`ObjectPool`（通用对象池）
- **用途**：减少频繁的对象创建和垃圾回收，提升内存效率
- **实例化对象池**：
  - `verificationEntryPool`：验证历史条目对象池（最大 50 个）
  - `positionObjectPool`：持仓数据对象池（最大 10 个）
- **核心方法**：
  - `acquire()`：从池中获取对象
  - `release(obj)`：将对象归还到池中
  - `releaseAll(objects)`：批量释放对象数组

### quoteClient.js（行情数据）

**路径**：`D:\Code\LongBrigeAutomationProgram\src\services\quoteClient.js`

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

### logger.js（异步日志系统）

**路径**：`D:\Code\LongBrigeAutomationProgram\src\utils\logger.js`

- **类**：`AsyncLogQueue`
- **设计**：非阻塞日志队列（最大 1000 条）
- **批处理**：每批 20 条日志
- **异步执行**：使用 `setImmediate()` 避免阻塞主循环
- **同步刷新**：进程退出时同步刷新所有待处理日志
- **方法**：`logger.info()`, `logger.warn()`, `logger.error()`, `logger.debug()`
- **时间显示**：自动添加北京时间（UTC+8）前缀

### utils.js（工具函数）

**路径**：`D:\Code\LongBrigeAutomationProgram\src\utils\helpers.js`

- **normalizeHKSymbol()**：标准化港股代码（添加 `.HK` 后缀）
- **decimalToNumber()**：转换 LongPort API 的 Decimal 对象为数字
- **toBeijingTimeIso()** / **toBeijingTimeLog()**：UTC 到北京时间转换

### signalTypes.js（信号类型定义）

**路径**：`D:\Code\LongBrigeAutomationProgram\src\utils\constants.js`

- 定义所有交易信号类型：`BUYCALL`, `SELLCALL`, `BUYPUT`, `SELLPUT`, `HOLD`

### 分析工具

#### findWarrant.js（牛熊证搜索工具）

**路径**：`D:\Code\LongBrigeAutomationProgram\src\tools\findWarrant.js`

- **用途**：搜索符合条件的牛熊证
- **运行**：`npm run find-warrant`
- **功能**：根据标的、到期日、回收价等条件筛选牛熊证

#### indicatorAnalysis.js（指标分析工具）

**路径**：`D:\Code\LongBrigeAutomationProgram\src\tools\indicatorAnalysis.js`

- **用途**：分析历史数据的技术指标表现
- **功能**：回测指标策略效果

### Windows 启动脚本

#### start.bat

**路径**：`D:\Code\LongBrigeAutomationProgram\start.bat`

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
   ├─ 验证指标可配置（VERIFICATION_INDICATORS，可选 K、D、J、MACD、DIF、DEA，默认 K,MACD）
   ├─ 每秒记录当前配置的所有验证指标值到信号的验证历史中（index.js:610-690）
   │  ├─ 条件：triggerTime ± 5秒窗口内（仅在此窗口内记录）
   │  ├─ 去重：避免在同一秒内重复记录（精确到秒）
   │  ├─ 限制：只保留 triggerTime ± 5秒窗口内的历史数据
   │  └─ 每个信号有独立的 verificationHistory 数组
   ├─ 对每个超过 triggerTime 的待验证信号：
   │  ├─ 获取 indicators1（触发时已记录的所有配置指标初始值）
   │  ├─ 从验证历史中获取 indicators2（所有配置指标的第二个值）：
   │  │  ├─ 优先：精确匹配目标时间（triggerTime）
   │  │  └─ 备选：距离目标时间最近的值（误差≤5秒）
   │  ├─ BUYCALL验证：所有配置指标的第二个值都要大于第一个值 → 通过
   │  ├─ BUYPUT验证：所有配置指标的第二个值都要小于第一个值 → 通过
   │  └─ 验证通过 → 移至执行列表
   └─ 清理：从待验证列表中移除已处理的信号，并清空其验证历史

3. 执行阶段 (index.js + trader.executeSignals)
   ├─ 买入操作检查顺序（index.js:1352-1506）：
   │  1. 交易频率限制检查（若不通过直接拒绝，不进行后续检查）
   │  2. 末日保护程序检查（收盘前15分钟拒绝买入）
   │  3. 牛熊证风险检查（使用监控标的的价格计算距离回收价百分比）
   │  4. 基础风险检查（浮亏限制和持仓市值限制）
   ├─ 对所有信号：
   │  ├─ 实时获取账户和持仓数据（买入操作必须获取最新数据）
   │  └─ 应用对应的风险检查规则
   ├─ 卖出信号成本价判断与数量计算（index.js:1557-1680）：
   │  ├─ 使用 calculateSellQuantity() 函数统一处理做多和做空标的
   │  ├─ 如果 currentPrice > costPrice（做多）或 currentPrice < costPrice（做空）：卖出全部持仓
   │  ├─ 否则（未盈利状态）：
   │  │  ├─ 从 orderRecorder 获取 buyPrice < currentPrice 的历史订单
   │  │  ├─ 如果有符合订单：卖出这些订单的总数量（智能清仓）
   │  │  └─ 如果无符合订单：信号设为 HOLD（持有，不卖出）
   │  └─ 卖出数量不能超过可用持仓数量
   ├─ 根据目标金额计算买入数量（trader.js:1015-1083）
   ├─ 提交 ELO 订单（trader.js:1119-1207）
   ├─ 订单成交后本地更新订单记录（index.js:1696-1749）：
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
4. 使用 todayOrders 初始化订单与浮亏数据（做多 + 做空）：
   ├─ `orderRecorder.fetchOrdersFromAPI(longSymbol/shortSymbol)` → 从 API 获取当日订单并更新 5 分钟缓存
   ├─ `orderRecorder.refreshOrders(symbol, isLong, false)` → 从缓存计算当前仍需记录的买入订单（用于智能清仓）
   └─ `riskChecker.refreshUnrealizedLossData(orderRecorder, symbol, isLong, false)` → 从缓存读取全部买/卖单并计算 R1/N1
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
- **港股交易时间**（UTC+8）：09:30-12:00, 13:00-16:00
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

- **收盘前 15 分钟拒绝买入**（index.js:1123-1144）：
  - 正常交易日：15:45-16:00
  - 半日交易日：11:45-12:00
  - 所有买入信号在此时段内被拦截，卖出信号不受影响
- **收盘前 5 分钟自动清仓**（index.js:976-1063）：
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
7. **买入操作数据要求**：买入时必须实时获取最新账户和持仓数据以确保浮亏计算准确（index.js:1196-1251）
8. **卖出操作灵活性**：卖出时可使用缓存数据（卖出操作不检查浮亏限制）
9. **HOLD 信号机制**：当卖出条件触发但成本价判断失败时，信号设为 HOLD（持有）而非拒绝（index.js:1371-1453）
10. **订单监控仅针对买入**：只监控买入订单的价格变化，卖出订单不监控（trader.js:426-543）

## 调试技巧

### 追踪信号流

1. 检查 `strategy.js`（`D:\Code\LongBrigeAutomationProgram\src\core\strategy.js`）日志查看信号生成（立即 vs 延迟）
2. 对于延迟信号，检查 lastState 中的 `pendingDelayedSignals`（等待 60 秒）
3. 验证验证历史在触发时间点包含 J/MACD 值
4. 检查 `risk.js`（`D:\Code\LongBrigeAutomationProgram\src\core\risk.js`）日志了解信号被过滤的原因（牛熊证风险、单日亏损、持仓限制）
5. 检查 `trader.js`（`D:\Code\LongBrigeAutomationProgram\src\core\trader.js`）日志查看频率限制或订单提交错误

### 验证指标计算

在 `.env` 中启用 `DEBUG=true` 查看每秒记录的详细指标值：

- RSI6、MFI、KDJ(K,D,J)、MACD(DIF,DEA,MACD)

### 检查订单记录

每次交易后，`orderRecorder.refreshOrders()`（`D:\Code\LongBrigeAutomationProgram\src\core\orderRecorder.js`）记录过滤过程：

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

- **交易记录**：`D:\Code\LongBrigeAutomationProgram\logs\trades\YYYY-MM-DD.json`
- **控制台日志**：实时显示，由 `logger.js`（`D:\Code\LongBrigeAutomationProgram\src\utils\logger.js`）管理

## 配置要求

所有配置必须在 `.env` 文件中设置（参见 `.env.example`）：

**配置文件位置**：

- 环境变量：`D:\Code\LongBrigeAutomationProgram\.env`
- 配置示例：`D:\Code\LongBrigeAutomationProgram\.env.example`
- API 配置：`D:\Code\LongBrigeAutomationProgram\src\config\config.js`
- 交易配置：`D:\Code\LongBrigeAutomationProgram\src\config\config.trading.js`
- 配置验证：`D:\Code\LongBrigeAutomationProgram\src\config\config.validator.js`

**必需配置**：

- LongPort API 凭证（APP_KEY、APP_SECRET、ACCESS_TOKEN）
- 交易标的（MONITOR_SYMBOL、LONG_SYMBOL、SHORT_SYMBOL）
- 交易金额（TARGET_NOTIONAL、LONG_LOT_SIZE、SHORT_LOT_SIZE）
- 风险限制（MAX_POSITION_NOTIONAL、MAX_DAILY_LOSS）

**可选配置**：

- DOOMSDAY_PROTECTION（默认：true）
- DEBUG（默认：false）
- MAX_UNREALIZED_LOSS_PER_SYMBOL（单标的浮亏保护阈值，默认：0，关闭保护）
- VERIFICATION_DELAY_SECONDS（延迟验证时间间隔，范围 0-120 秒，未设置时默认 60，设为 0 表示不延迟验证）
- VERIFICATION_INDICATORS（延迟验证指标列表，可选值：K, D, J, MACD, DIF, DEA，逗号分隔，留空或不设置表示不延迟验证，默认 K,MACD）

如果任何必需配置缺失或无效，启动将失败（config.validator.js 检查所有设置）。

## 常见开发任务

修改本系统时：

1. **添加新指标**：更新 `indicators.js`（`D:\Code\LongBrigeAutomationProgram\src\services\indicators.js`），利用 `technicalindicators` 库添加新指标，然后修改 `buildIndicatorSnapshot()` 和策略阈值
2. **修改信号逻辑**：编辑 `strategy.js`（`D:\Code\LongBrigeAutomationProgram\src\core\strategy.js`）条件，确保延迟信号仍记录 J1/MACD1
3. **调整风险控制**：修改 `risk.js`（`D:\Code\LongBrigeAutomationProgram\src\core\risk.js`）检查，始终仅对买入信号进行门控（允许卖出）
4. **订单类型变更**：更新 `trader.js`（`D:\Code\LongBrigeAutomationProgram\src\core\trader.js`）\_submitTargetOrder()，确保订单类型被 LongPort API 支持
5. **修改配置参数**：编辑 `.env` 文件或 `config.trading.js`（`D:\Code\LongBrigeAutomationProgram\src\config\config.trading.js`）
6. **测试**：使用模拟交易账户（在 LongPort API 设置中配置）

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

- 主入口：`D:\Code\LongBrigeAutomationProgram\src\index.js`
- 交易策略：`D:\Code\LongBrigeAutomationProgram\src\core\strategy.js`
- 订单执行：`D:\Code\LongBrigeAutomationProgram\src\core\trader.js`
- 风险控制：`D:\Code\LongBrigeAutomationProgram\src\core\risk.js`
- 订单记录：`D:\Code\LongBrigeAutomationProgram\src\core\orderRecorder.js`
- 技术指标：`D:\Code\LongBrigeAutomationProgram\src\services\indicators.js`
- 行情客户端：`D:\Code\LongBrigeAutomationProgram\src\services\quoteClient.js`

**辅助模块**：

- 对象池：`D:\Code\LongBrigeAutomationProgram\src\utils\objectPool.js`
- 日志系统：`D:\Code\LongBrigeAutomationProgram\src\utils\logger.js`
- 工具函数：`D:\Code\LongBrigeAutomationProgram\src\utils\helpers.js`
- 信号类型：`D:\Code\LongBrigeAutomationProgram\src\utils\constants.js`

**配置文件**：

- API 配置：`D:\Code\LongBrigeAutomationProgram\src\config\config.js`
- 交易配置：`D:\Code\LongBrigeAutomationProgram\src\config\config.trading.js`
- 配置验证：`D:\Code\LongBrigeAutomationProgram\src\config\config.validator.js`
- 环境变量：`D:\Code\LongBrigeAutomationProgram\.env`（需手动创建）
- 配置示例：`D:\Code\LongBrigeAutomationProgram\.env.example`

**分析工具**：

- 牛熊证搜索：`D:\Code\LongBrigeAutomationProgram\src\tools\findWarrant.js`
- 指标分析：`D:\Code\LongBrigeAutomationProgram\src\tools\indicatorAnalysis.js`

**日志文件**：

- 交易记录：`D:\Code\LongBrigeAutomationProgram\logs\trades\YYYY-MM-DD.json`

**启动脚本**：

- Windows 启动：`D:\Code\LongBrigeAutomationProgram\start.bat`
