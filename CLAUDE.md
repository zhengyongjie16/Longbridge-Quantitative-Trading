# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在此代码库中工作时提供指导。

## 系统概述

这是一个 LongBridge 港股自动化量化交易系统。它通过技术指标监控目标资产（如恒生指数），并在牛熊证上执行双向交易。

**核心设计模式**：多指标组合策略，开仓信号采用 60 秒延迟验证，平仓信号立即执行。

## 核心架构

```
主循环 (index.js) → 每秒执行一次
  ├─ 行情数据 (QuoteClient)
  ├─ 指标计算 (indicators.js)
  ├─ 信号生成 (strategy.js)
  ├─ 风险验证 (risk.js)
  ├─ 订单执行 (trader.js)
  └─ 订单记录 (orderRecorder.js)
```

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
- **主循环**：`runOnce()` 每秒执行一次
- **交易时段检查**：验证港股交易时间（09:30-12:00, 13:00-16:00）
- **状态管理**：维护 `lastState` 对象，在循环迭代间保持：
  - 待验证的延迟信号（等待 60 秒验证）
  - 缓存的账户/持仓数据
  - 上次指标值（用于变化检测）
- **收盘前清仓逻辑**：在收盘前 5 分钟自动清空所有持仓

### strategy.js（信号生成）
- **类**：`HangSengMultiIndicatorStrategy`
- **生成两类信号**：
  1. **立即信号**（卖出/平仓）：条件满足时立即执行
  2. **延迟信号**（买入/开仓）：等待 60 秒进行趋势确认
- **多指标逻辑**：要求 4 个指标（RSI6、RSI12、KDJ.D、KDJ.J）中至少 3 个满足阈值
- **信号类型及触发条件**（所有信号采用条件1或条件2的"或"关系）：
  - `BUYCALL`（买入做多 - 延迟验证）：
    - 条件1：4指标满足3个以上 且 监控标的价格 < VWAP
    - 条件2：J < -20
    - 验证：J2 > J1 且 MACD2 > MACD1
  - `SELLCALL`（卖出做多 - 立即执行）：
    - 条件1：4指标满足3个以上 且 做多标的价格 > 持仓成本价
    - 条件2：J > 110
  - `BUYPUT`（买入做空 - 延迟验证）：
    - 条件1：4指标满足3个以上 且 监控标的价格 > VWAP
    - 条件2：J > 120
    - 验证：J2 < J1 且 MACD2 < MACD1
  - `SELLPUT`（卖出做空 - 立即执行）：
    - 条件1：4指标满足3个以上 且 做空标的价格 > 持仓成本价
    - 条件2：J < -15

### trader.js（订单执行）
- **类**：`Trader`
- **核心方法**：
  - `executeSignals()`：根据过滤后的信号提交订单
  - `monitorAndManageOrders()`：监控未成交买入订单，市场价下跌时降低委托价
  - `_submitTargetOrder()`：根据目标金额计算数量并提交 ELO 订单
- **交易频率限制**：同方向 60 秒内不能重复买入
- **订单类型**：所有订单使用 `ELO`（增强限价单）
- **买单监控**：买入信号执行后自动启用，所有订单成交后停止

### risk.js（风险控制）
- **类**：`RiskChecker`
- **交易前检查**（仅针对买入信号）：
  1. **牛熊证风险**：牛证距离回收价 >0.5%，熊证 <-0.5%
  2. **单日亏损限制**：浮亏必须 > -MAX_DAILY_LOSS
  3. **持仓市值限制**：单标的市值必须 ≤ MAX_POSITION_NOTIONAL
- **风险检查为门控**：检查失败则阻止信号执行，但允许卖出操作

### orderRecorder.js（历史订单跟踪）
- **类**：`OrderRecorder`
- **用途**：跟踪已成交买入订单，用于智能清仓决策
- **过滤逻辑**（累积过滤算法）：
  1. **M0**：在最新卖出时间之后成交的买入订单
  2. **MN**：从所有买入订单开始，依次用每个卖出订单过滤（时间<卖出时间 且 价格≥卖出价），形成累积过滤链：
     - D3（最新卖出）→ 从所有买入订单过滤 → M1
     - D2 → 从 M1 过滤 → M2
     - D1（最旧卖出）→ 从 M2 过滤 → MN
  3. **最终记录** = M0 + MN
- **业务含义**：
  - M0：最新买入，还未经历卖出
  - MN：历史高价买入且一直未能卖出的订单（价格高于所有历史卖出价）
- **智能清仓**：当 currentPrice ≤ costPrice 时，仅卖出 buyPrice < currentPrice 的订单（盈利部分）

### indicators.js（技术指标计算）
- **RSI**：指数移动平均法（周期 6 和 12）
- **KDJ**：随机指标，包含 K、D、J 值
- **VWAP**：成交量加权平均价
- **MACD**：DIF（EMA12-EMA26）、DEA（DIF 的 EMA9）、MACD 柱（DIF-DEA）×2
- **函数**：`buildIndicatorSnapshot()` 返回包含所有指标的统一对象

### quoteClient.js（行情数据）
- **类**：`QuoteClient`
- **缓存机制**：
  - 行情数据：1 秒 TTL（避免同一循环内重复 API 调用）
  - 交易日信息：24 小时 TTL（启动时预加载当月和次月）
- **核心方法**：
  - `getRealtimeQuotes()`：获取实时行情（带缓存）
  - `getCandles()`：获取 K 线数据（默认 200 根，1 分钟周期）
  - `isMarketDay()`：检查今天是否为交易日

## 关键数据流

### 信号处理流程（3 个阶段）

```
1. 生成阶段 (strategy.generateCloseSignals)
   ├─ 立即信号（卖出）：条件满足时立即执行
   │  ├─ SELLCALL: (4指标满足3个+ 且 价格>成本价) 或 J>110
   │  └─ SELLPUT: (4指标满足3个+ 且 价格>成本价) 或 J<-15
   └─ 延迟信号（买入）：添加到待验证列表，记录 J1, MACD1
      ├─ BUYCALL: (4指标满足3个+ 且 价格<VWAP) 或 J<-20
      └─ BUYPUT: (4指标满足3个+ 且 价格>VWAP) 或 J>120

2. 验证阶段（60秒后在 runOnce 中）
   ├─ 每秒记录当前 J 和 MACD 值到信号的验证历史中
   ├─ 对每个超过 triggerTime 的待验证信号：
   │  ├─ 获取 J1, MACD1（触发时已记录）
   │  ├─ 从验证历史中获取 J2, MACD2：
   │  │  ├─ 优先：精确匹配目标时间（triggerTime）
   │  │  └─ 备选：距离目标时间最近的值（误差≤5秒）
   │  ├─ BUYCALL验证：J2 > J1 且 MACD2 > MACD1 → 通过
   │  ├─ BUYPUT验证：J2 < J1 且 MACD2 < MACD1 → 通过
   │  └─ 验证通过 → 移至执行列表
   └─ 清理：从待验证列表中移除已处理的信号

3. 执行阶段 (trader.executeSignals)
   ├─ 应用风险检查（仅买入信号）
   ├─ 应用频率限制（同方向买入间隔60秒）
   ├─ 根据目标金额计算数量（买入）
   ├─ 提交 ELO 订单
   ├─ 订单成交后刷新历史记录
   └─ 启用订单监控（买入）
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
2. 预加载当月和次月的交易日信息
3. 初始化组件：
   ├─ Strategy（带指标阈值）
   ├─ Trader（延迟 TradeContext 初始化）
   ├─ OrderRecorder（链接到 Trader）
   └─ RiskChecker（带亏损/持仓限制）
4. 显示初始账户和持仓信息
5. 刷新历史订单记录（做多 + 做空）
6. 检查待处理买入订单 → 如有则启用监控
7. 启动无限循环（runOnce 每秒执行）
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
const qty = Math.floor((targetNotional / price) / lotSize) * lotSize;

// 卖出：使用可用持仓数量（向下取整到每手的倍数）
const sellQty = clearAll ? availableQty : Math.min(calculateQty, availableQty);
```

### 订单监控行为

- 仅监控买入订单（不监控卖出订单）
- 在买入信号执行后调用 `enableBuyOrderMonitoring()` 时启动监控
- 所有买入订单成交后停止监控
- 价格优化：如果当前价格 < 订单价格，则向下修改订单

### 牛熊证风险检查

- 仅应用于买入信号
- 牛证（BUYCALL）：距离回收价必须 > 0.5%
- 熊证（BUYPUT）：距离回收价必须 < -0.5%
- 如信号中未提供标的价格，自动获取

### 收盘前自动清仓

- 收盘前 5 分钟触发（正常日 15:55-15:59，半日 11:55-11:59）
- 为所有持仓生成卖出信号（忽略其他条件）
- 使用 `clearAll: true` 标志确保完全清仓
- 由 `CLEAR_POSITIONS_BEFORE_CLOSE` 环境变量控制

## 关键技术约束

1. **无卖空操作**：本系统买入牛熊证，不是卖空标的股票
2. **交易时段强制执行**：基于系统时间（非行情时间）的严格检查
3. **成本基础跟踪至关重要**：OrderRecorder 维护详细历史用于智能清仓逻辑
4. **仅监控标的生成信号**：做多/做空标的仅为执行目标（不计算其指标）
5. **1 分钟 K 线粒度**：200 根 K 线 = 约 200 分钟 = 约 3 小时历史
6. **必须使用 ELO 订单类型**：所有订单必须使用增强限价单并指定价格

## 调试技巧

### 追踪信号流

1. 检查 `strategy.js` 日志查看信号生成（立即 vs 延迟）
2. 对于延迟信号，检查 lastState 中的 `pendingDelayedSignals`（等待 60 秒）
3. 验证验证历史在触发时间点包含 J/MACD 值
4. 检查 risk.js 日志了解信号被过滤的原因（牛熊证风险、单日亏损、持仓限制）
5. 检查 trader.js 日志查看频率限制或订单提交错误

### 验证指标计算

在 `.env` 中启用 `DEBUG=true` 查看每秒记录的详细指标值：
- RSI6、RSI12、VWAP、KDJ(K,D,J)、MACD(DIF,DEA,MACD)

### 检查订单记录

每次交易后，`orderRecorder.refreshOrders()` 记录过滤过程：
- 今日总买入订单数
- 今日总卖出订单数
- 过滤掉多少订单
- 最终记录数量

### 监控未成交订单

Trader 日志显示：
- 买入订单监控何时启动/停止
- 订单价格何时被修改（价格优化）
- 所有订单何时成交

## 配置要求

所有配置必须在 `.env` 文件中设置（参见 `.env.example`）：

**必需配置**：
- LongPort API 凭证（APP_KEY、APP_SECRET、ACCESS_TOKEN）
- 交易标的（MONITOR_SYMBOL、LONG_SYMBOL、SHORT_SYMBOL）
- 交易金额（TARGET_NOTIONAL、LONG_LOT_SIZE、SHORT_LOT_SIZE）
- 风险限制（MAX_POSITION_NOTIONAL、MAX_DAILY_LOSS）

**可选配置**：
- CLEAR_POSITIONS_BEFORE_CLOSE（默认：true）
- DEBUG（默认：false）

如果任何必需配置缺失或无效，启动将失败（config.validator.js 检查所有设置）。

## 常见开发任务

修改本系统时：

1. **添加新指标**：更新 `indicators.js` 和 `buildIndicatorSnapshot()`，然后修改策略阈值
2. **修改信号逻辑**：编辑 `strategy.js` 条件，确保延迟信号仍记录 J1/MACD1
3. **调整风险控制**：修改 `risk.js` 检查，始终仅对买入信号进行门控（允许卖出）
4. **订单类型变更**：更新 `trader.js` _submitTargetOrder()，确保订单类型被 LongPort API 支持
5. **测试**：使用模拟交易账户（在 LongPort API 设置中配置）

## 架构原则

本代码库遵循以下模式：
- **关注点分离**：每个模块单一职责
- **故障安全设计**：多重风险检查门控高风险操作（买入）
- **状态最小化**：仅必要状态跨迭代持久化
- **缓存策略**：1 秒行情缓存，24 小时交易日缓存
- **防御性编程**：广泛的验证和错误处理
- **日志透明度**：详细日志解释每个决策
