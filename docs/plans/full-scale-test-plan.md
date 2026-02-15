# 全规模业务逻辑测试方案

> 目标：基于业务逻辑知识库，构建全链路测试用例，验证程序行为完全符合业务规则。
> 测试框架：bun:test | Mock 数据目录：mock/ | 测试目录：tests/

---

## 一、Mock 基础设施（mock/）

### 1.1 LongPort API Mock（mock/longportMock.ts）

模拟 `QuoteContext` 和 `TradeContext` 的完整接口，支持：

- **可编程响应**：每个方法可预设返回值序列，支持按调用次数返回不同结果
- **调用记录**：记录每次调用的参数和时间戳，用于验证调用顺序和频率
- **错误注入**：支持指定第 N 次调用抛出异常
- **WebSocket 事件模拟**：模拟 `setOnOrderChanged` 回调触发

#### QuoteContext Mock 方法

| 方法 | 模拟行为 |
|------|---------|
| `quote(symbols)` | 返回预设的 SecurityQuote 数组 |
| `candlesticks(symbol, period, count)` | 返回预设的 K 线数据 |
| `warrantList(symbol, sortBy, sortOrder, types)` | 返回预设的轮证列表 |
| `subscribe(symbols, subTypes)` | 记录订阅请求 |
| `unsubscribe(symbols, subTypes)` | 记录取消订阅请求 |
| `setOnQuote(callback)` | 存储回调，供测试手动触发 |
| `tradingDays(market, begin, end)` | 返回预设交易日列表 |

#### TradeContext Mock 方法

| 方法 | 模拟行为 |
|------|---------|
| `submitOrder(options)` | 返回预设 orderId，记录提交参数 |
| `cancelOrder(orderId)` | 记录撤单请求 |
| `replaceOrder(options)` | 记录改单请求 |
| `todayOrders(options)` | 返回预设的当日订单列表 |
| `historyOrders(options)` | 返回预设的历史订单列表 |
| `todayExecutions(options)` | 返回预设的当日成交列表 |
| `accountBalance()` | 返回预设的账户余额 |
| `stockPositions(symbols?)` | 返回预设的持仓信息 |
| `setOnOrderChanged(callback)` | 存储回调，供测试手动触发 |
| `subscribe(topics)` | 记录订阅请求 |

### 1.2 Mock 数据工厂（mock/factories/）

提供标准化的测试数据构造函数：

#### mock/factories/quoteFactory.ts

```typescript
// 构造 SecurityQuote
createMockQuote(overrides?: Partial<SecurityQuote>): SecurityQuote
// 构造 K 线数据
createMockCandlesticks(count: number, basePrice: number): Candlestick[]
// 构造轮证信息
createMockWarrantInfo(overrides?: Partial<WarrantInfo>): WarrantInfo
// 构造轮证列表（牛证/熊证）
createMockWarrantList(type: 'bull' | 'bear', count: number): WarrantInfo[]
```

#### mock/factories/tradeFactory.ts

```typescript
// 构造订单
createMockOrder(overrides?: Partial<Order>): Order
// 构造成交记录
createMockExecution(overrides?: Partial<Execution>): Execution
// 构造账户余额
createMockAccountBalance(overrides?: Partial<AccountBalance>): AccountBalance
// 构造持仓
createMockStockPosition(overrides?: Partial<StockPosition>): StockPosition
// 构造持仓响应
createMockStockPositionsResponse(positions: StockPosition[]): StockPositionsResponse
// 构造订单变更推送事件
createMockPushOrderChanged(overrides?: Partial<PushOrderChanged>): PushOrderChanged
```

#### mock/factories/signalFactory.ts

```typescript
// 构造交易信号
createMockSignal(overrides?: Partial<Signal>): Signal
// 构造指标快照
createMockIndicatorSnapshot(overrides?: Partial<IndicatorSnapshot>): IndicatorSnapshot
// 构造监控上下文
createMockMonitorContext(overrides?: Partial<MonitorContext>): MonitorContext
```

#### mock/factories/configFactory.ts

```typescript
// 构造完整交易配置
createMockTradingConfig(overrides?: Partial<TradingConfig>): TradingConfig
// 构造单监控标的配置
createMockMonitorConfig(overrides?: Partial<MonitorConfig>): MonitorConfig
// 构造信号条件配置
createMockSignalConfig(overrides?: Partial<SignalConfig>): SignalConfig
```

### 1.3 Mock Logger（mock/mockLogger.ts）

```typescript
// 静默 logger，记录所有日志调用供断言
createMockLogger(): { logger: Logger; calls: LogCall[] }
```

### 1.4 Mock 时间控制器（mock/mockTimer.ts）

```typescript
// 可控时间，用于测试延迟验证、冷却期、末日保护等时间相关逻辑
createMockTimer(): {
  now(): number;
  advance(ms: number): void;
  set(timestamp: number): void;
}
```

---

## 二、测试模块划分与用例设计

### 模块总览

| 测试层级 | 目录 | 测试数量(预估) | 说明 |
|---------|------|--------------|------|
| Mock 基础设施 | mock/ | - | API Mock + 数据工厂 |
| 技术指标 | tests/services/indicators/ | ~40 | RSI/KDJ/MACD/MFI/EMA/PSY |
| 信号生成策略 | tests/core/strategy/ | ~30 | 多条件组合信号生成 |
| 订单过滤引擎 | tests/core/orderRecorder/ | ~25 | 过滤算法全场景 |
| 卖出策略 | tests/core/signalProcessor/ | ~20 | 智能平仓/全仓清仓 |
| 风险管控 | tests/core/riskController/ | ~50 | 6 项检查 + 浮亏监控 |
| 延迟验证 | tests/main/asyncProgram/delayedSignalVerifier/ | ~25 | T0/T1/T2 验证 |
| 买入/卖出处理器 | tests/main/asyncProgram/processors/ | ~20 | 队列消费 + 席位校验 |
| 末日保护 | tests/core/doomsdayProtection/ | ~15 | 拒买/撤单/清仓 |
| 订单监控 | tests/main/asyncProgram/orderMonitor/ | ~15 | 价格跟踪/超时处理 |
| 自动寻标/换标 | tests/services/autoSymbol/ | ~35 | 席位管理/寻标/换标状态机 |
| 生命周期管理 | tests/main/lifecycle/ | 已有 | 午夜清理/开盘重建 |
| 全链路集成 | tests/integration/ | ~30 | 端到端业务流程 |
| **合计** | | **~305** | |

---

### 2.1 技术指标计算（tests/services/indicators/）

验证所有技术指标计算的正确性，确保信号生成的数据基础可靠。

#### 2.1.1 RSI 计算（rsi.test.ts）

| 用例 | 输入 | 预期 | 业务关联 |
|------|------|------|---------|
| 标准 RSI 计算（周期14） | 15 根 K 线（含涨跌） | RSI 值在 0-100 之间，与手动计算一致 | 信号条件判断 |
| 全涨 K 线 | 14 根连续上涨 | RSI 接近 100 | 超买信号 |
| 全跌 K 线 | 14 根连续下跌 | RSI 接近 0 | 超卖信号 |
| 数据不足 | 少于周期数的 K 线 | 返回 null | 开盘初期无信号 |
| 自定义周期 | 周期 6/9/12 | 各周期计算正确 | 多周期 RSI 配置 |

#### 2.1.2 KDJ 计算（kdj.test.ts）

| 用例 | 输入 | 预期 | 业务关联 |
|------|------|------|---------|
| 标准 KDJ 计算 | 足够的 K 线数据 | K/D/J 值在合理范围 | 信号条件中的 K/D/J |
| K 值金叉（K 上穿 D） | 构造交叉数据 | K > D 转换点正确 | BUYCALL 条件 |
| K 值死叉（K 下穿 D） | 构造交叉数据 | K < D 转换点正确 | BUYPUT 条件 |
| J 值超买（>100） | 极端上涨数据 | J > 100 | 卖出信号条件 |
| J 值超卖（<0） | 极端下跌数据 | J < 0 | 买入信号条件 |
| 数据不足 | 少于所需 K 线 | 返回 null | 安全处理 |

#### 2.1.3 MACD 计算（macd.test.ts）

| 用例 | 输入 | 预期 | 业务关联 |
|------|------|------|---------|
| 标准 MACD/DIF/DEA | 足够 K 线 | 三值计算正确 | 延迟验证指标 |
| MACD 金叉 | DIF 上穿 DEA | 交叉点正确 | 上涨趋势验证 |
| MACD 死叉 | DIF 下穿 DEA | 交叉点正确 | 下跌趋势验证 |
| 零轴上方/下方 | 不同趋势数据 | DIF/DEA 正负正确 | 趋势强度判断 |

#### 2.1.4 MFI 计算（mfi.test.ts）

| 用例 | 输入 | 预期 | 业务关联 |
|------|------|------|---------|
| 标准 MFI 计算 | 含量价数据的 K 线 | MFI 在 0-100 之间 | 信号条件 |
| 高 MFI（>80） | 持续放量上涨 | MFI > 80 | 超买判断 |
| 低 MFI（<20） | 持续放量下跌 | MFI < 20 | 超卖判断 |

#### 2.1.5 EMA 计算（ema.test.ts）

| 用例 | 输入 | 预期 | 业务关联 |
|------|------|------|---------|
| 标准 EMA（周期可配） | K 线数据 | EMA 值正确 | 延迟验证指标 |
| 短周期 vs 长周期 | 同数据不同周期 | 短周期更敏感 | 趋势判断 |

#### 2.1.6 PSY 计算（psy.test.ts）

| 用例 | 输入 | 预期 | 业务关联 |
|------|------|------|---------|
| 标准 PSY 计算 | K 线数据 | PSY 在 0-100 之间 | 信号条件 |
| 全涨 | 全部上涨 K 线 | PSY = 100 | 极端情况 |
| 全跌 | 全部下跌 K 线 | PSY = 0 | 极端情况 |
| 自定义周期 | 不同周期 | 各周期正确 | 多周期 PSY 配置 |

#### 2.1.7 指标快照构建（buildIndicatorSnapshot.test.ts）

| 用例 | 预期 | 业务关联 |
|------|------|---------|
| 所有指标均有值时构建完整快照 | 快照包含所有指标 | 信号生成输入 |
| 部分指标为 null 时快照仍可构建 | null 指标被跳过 | 开盘初期 |
| K 线数据为空时返回 null | 返回 null | 无数据保护 |

---

### 2.2 信号生成策略（tests/core/strategy/）

验证信号生成逻辑，确保多条件组合和信号分流机制正确。

#### signalGeneration.test.ts

| 用例 | 输入条件 | 预期输出 | 业务规则引用 |
|------|---------|---------|-------------|
| 单组全满足触发 BUYCALL | RSI<30, K<20, MFI<20 全满足 | 生成 BUYCALL 信号 | 组内规则：全部满足 |
| 单组部分满足（配置至少2项）触发 | 3条件满足2项, minMatch=2 | 生成信号 | 组内规则：至少满足若干项 |
| 单组不满足（未达最低条件数） | 3条件满足1项, minMatch=2 | 不生成信号 | 组内规则 |
| 多组任选：第一组不满足，第二组满足 | group1 失败, group2 通过 | 生成信号 | 组间规则：任意一组 |
| 所有组都不满足 | 全部组失败 | HOLD | 无信号 |
| SELLCALL：有做多买入订单时生成 | 有 LONG 买入记录 | 生成 SELLCALL | 卖出信号前置条件 |
| SELLCALL：无做多买入订单时不生成 | 无 LONG 买入记录 | 不生成 SELLCALL | 卖出信号前置条件 |
| BUYPUT 信号生成 | 做空条件满足 | 生成 BUYPUT | 做空方向 |
| SELLPUT：有做空买入订单时生成 | 有 SHORT 买入记录 | 生成 SELLPUT | 卖出信号前置条件 |
| SELLPUT：无做空买入订单时不生成 | 无 SHORT 买入记录 | 不生成 SELLPUT | 卖出信号前置条件 |
| 同时触发多方向信号 | BUYCALL 和 BUYPUT 条件同时满足 | 两个信号均生成 | 方向独立 |
| 阈值为负数的条件判断 | J < -10 | 正确比较 | 阈值可为负数 |
| 指标为 null 时条件不满足 | 指标返回 null | 条件不满足 | 数据不足保护 |

#### signalRouting.test.ts

| 用例 | 输入条件 | 预期输出 | 业务规则引用 |
|------|---------|---------|-------------|
| 立即信号（延迟时间=0）直接入队 | delay=0 | 信号进入买入/卖出队列 | 信号分流 |
| 立即信号（验证指标为空）直接入队 | verifyIndicators=[] | 信号进入队列 | 信号分流 |
| 延迟信号入延迟验证器 | delay=60, indicators=[K,MACD] | 信号进入验证器 | 信号分流 |
| 席位状态非 READY 时信号丢弃 | seat status=SEARCHING | 信号被丢弃 | 席位校验 |
| 信号席位版本不匹配时丢弃 | signal version=1, current=2 | 信号被丢弃 | 版本校验 |
| 信号标的与席位标的不匹配时丢弃 | signal symbol ≠ seat symbol | 信号被丢弃 | 标的校验 |
| 丢弃的信号释放回对象池 | 信号被丢弃 | 信号释放到对象池 | 对象池管理 |
| 行情未就绪时买入信号丢弃 | 席位已占用但无首个行情 | 买入信号丢弃 | 行情未就绪 |
| 行情未就绪时卖出信号可尝试 | 席位已占用但无首个行情 | 卖出信号可执行 | 行情未就绪 |

---

### 2.3 订单过滤引擎（tests/core/orderRecorder/）

验证订单过滤算法的正确性，确保未被完全卖出的买入订单被准确识别。

#### orderFilteringEngine.test.ts

| 用例 | 输入 | 预期 | 业务规则引用 |
|------|------|------|-------------|
| 无卖出订单：所有买入保留 | 3笔买入, 0笔卖出 | 3笔全部保留 | 基本过滤 |
| 单笔卖出完全消除 | buy 100@1.0, sell 100 | 无买入剩余 | 完全消除 |
| 单笔卖出部分消除（低价优先） | buy 100@1.0 + 100@1.2, sell 100 | 1.0消除, 1.2保留 | 低价优先 |
| 多笔卖出按时间顺序处理 | 3笔买入, 2笔卖出按时间序 | 累积过滤正确 | 时间顺序处理 |
| 卖出数量≥买入总量：全部消除 | sell qty ≥ total buy | 全部消除，仅保留间隔订单 | 完全消除 |
| 时间间隔内的买入订单保留 | 两笔卖出之间的买入 | 间隔订单从原始候选获取 | 间隔订单规则 |
| M0 订单无条件保留 | 最新卖出后的买入 | M0 全部保留 | M0 规则 |
| 低价优先整笔消除不拆分 | buy 100@0.9 + 150@1.0, sell 120 | 仅0.9消除(100)，不拆分 | 整笔消除 |
| 同价格按时间排序消除 | 同价不同时间 | 较早的先消除 | 排序规则 |
| 同价格同时间按订单编号字典序 | 同价同时间 | 字典序小的先消除 | 排序规则 |
| 复杂场景：多轮过滤累积效果 | 5笔买入, 3笔卖出 | 每轮累积结果正确 | 累积过滤 |
| 空买入列表 | 无买入 | 空结果 | 边界情况 |
| 间隔订单必须从原始候选获取 | 多轮过滤 | 间隔订单不受上轮影响 | 关键约束 |

#### sellDeductionPolicy.test.ts

| 用例 | 输入 | 预期 | 业务规则引用 |
|------|------|------|-------------|
| 低价优先消除 | 不同价格订单 | 最低价先消除 | 低价优先 |
| 整笔消除不拆分 | 卖出量不精确匹配 | 整笔消除 | 不拆分 |
| 消除后剩余数量正确 | 多笔订单部分卖出 | 剩余订单正确 | 数量一致性 |
| 同价格按时间排序 | 同价不同时间 | 较早先消除 | 排序规则 |
| 同价格同时间按订单编号 | 同价同时间 | 字典序排序 | 排序规则 |

---

### 2.4 卖出策略（tests/core/signalProcessor/）

验证卖出信号处理流程，包括智能平仓和全仓清仓逻辑。

#### sellSignalProcessing.test.ts

| 用例 | 输入条件 | 预期 | 业务规则引用 |
|------|---------|------|-------------|
| 末日保护清仓信号无条件执行 | reason 含"末日保护程序" | 使用全部可用持仓 | 末日保护优先 |
| 智能平仓关闭：直接清仓 | smartClose=false | 使用全部可用持仓 | 智能平仓开关 |
| 智能平仓+整体盈利：卖出全部 | 当前价1.20 > 成本均价1.15 | 卖出全部 | 整体盈利规则 |
| 智能平仓+整体未盈利：仅卖盈利订单 | 当前价1.20 ≤ 成本均价1.25 | 仅卖买入价<1.20的订单 | 部分平仓规则 |
| 智能平仓+无可卖订单：不执行 | 无盈利订单 | shouldHold=true | 保持持仓 |
| 智能平仓+订单记录不可用：不执行 | getCostAveragePrice 返回 null | shouldHold=true | 保持持仓 |
| 防重：排除待成交卖出占用的订单 | 部分订单被占用 | 占用订单被排除 | 防重机制 |
| 截断：取可卖与可用持仓较小值 | 可卖300, 可用200 | 卖出200 | 截断规则 |
| 超出时按买入价从低到高整笔选单 | 需要截断 | 低价优先整笔选单 | 整笔选单 |
| 卖出委托价以执行时行情为准 | 信号有旧价格 | 使用当前行情价 | 委托价规则 |
| 卖出信号不经过风险检查 | 卖出信号 | 无风险检查流程 | 卖出免检 |

---

### 2.5 风险管控（tests/core/riskController/）

验证买入信号的 6 项风险检查和浮亏监控机制。

#### riskCheckPipeline.test.ts

**风险检查冷却（前置）**：

| 用例 | 输入 | 预期 | 业务规则引用 |
|------|------|------|-------------|
| 首次信号通过冷却 | 首个信号 | 通过 | 冷却机制 |
| 10秒内同标的同动作第二信号跳过 | 10秒内第二个 | 跳过 | 10秒冷却 |
| 10秒后信号通过 | 超过10秒 | 通过 | 冷却过期 |
| BUYCALL 和 BUYPUT 共享冷却键 | BUYCALL后BUYPUT | 第二个跳过 | 共享冷却 |
| SELLCALL 和 SELLPUT 共享冷却键 | SELLCALL后SELLPUT | 第二个跳过 | 共享冷却 |
| 不同标的不共享冷却 | 不同标的10秒内 | 均通过 | 标的隔离 |

**检查1：交易频率限制**：

| 用例 | 输入 | 预期 | 业务规则引用 |
|------|------|------|-------------|
| 同方向买入间隔≥60秒通过 | 61秒间隔 | 通过 | 频率限制 |
| 同方向买入间隔<60秒拒绝 | 30秒间隔 | 拒绝 | 频率限制 |
| 不同方向不互相限制 | BUYCALL后立即BUYPUT | 均通过 | 方向独立 |
| 自定义间隔配置 | interval=120s | 90秒拒绝, 121秒通过 | 可配置 |

**检查2：清仓冷却**：

| 用例 | 输入 | 预期 | 业务规则引用 |
|------|------|------|-------------|
| 无清仓记录时通过 | 无清仓历史 | 通过 | 无冷却 |
| 按分钟数冷却期内拒绝 | 5分钟冷却, 3分钟已过 | 拒绝 | 分钟冷却 |
| 按分钟数冷却期后通过 | 5分钟冷却, 6分钟已过 | 通过 | 冷却过期 |
| 半日冷却同半日内拒绝 | 半日模式, 同半日 | 拒绝 | 半日冷却 |
| 半日冷却跨半日通过 | 半日模式, 下半日 | 通过 | 跨半日 |
| 一日冷却同日内拒绝 | 一日模式, 同日 | 拒绝 | 一日冷却 |
| 一日冷却跨日后通过 | 一日模式, 次日 | 通过 | 跨日 |
| 跨日清理半日/一日冷却键 | 午夜清理 | 键被清除 | 跨日清理 |

**检查3：买入价格限制**：

| 用例 | 输入 | 预期 | 业务规则引用 |
|------|------|------|-------------|
| 当前价格≤最新买入价通过 | 当前1.0 ≤ 最新1.2 | 通过 | 防追高 |
| 当前价格>最新买入价拒绝 | 当前1.3 > 最新1.2 | 拒绝 | 防追高 |
| 无历史买入订单时通过 | 无买入历史 | 通过 | 首次买入 |

**检查4：末日保护检查**：

| 用例 | 输入 | 预期 | 业务规则引用 |
|------|------|------|-------------|
| 正常日15:44通过 | 15:44 正常日 | 通过 | 末日保护 |
| 正常日15:45拒绝 | 15:45 正常日 | 拒绝 | 15:45-16:00 |
| 半日11:44通过 | 11:44 半日 | 通过 | 半日末日保护 |
| 半日11:45拒绝 | 11:45 半日 | 拒绝 | 11:45-12:00 |

**检查5：牛熊证风险检查**：

| 用例 | 输入 | 预期 | 业务规则引用 |
|------|------|------|-------------|
| 监控标的价格<1拒绝 | 监控价0.5 | 拒绝 | 异常价格 |
| 牛熊证当前价≤0.015拒绝 | 牛熊证价0.01 | 拒绝 | 过低价格 |
| 牛证距回收价>0.5%通过 | 距离1.0% | 通过 | 牛证安全距离 |
| 牛证距回收价≤0.5%拒绝 | 距离0.3% | 拒绝 | 牛证风险 |
| 熊证距回收价<-0.5%通过 | 距离-1.0% | 通过 | 熊证安全距离 |
| 熊证距回收价≥-0.5%拒绝 | 距离-0.3% | 拒绝 | 熊证风险 |

**检查6：基础风险检查**：

| 用例 | 输入 | 预期 | 业务规则引用 |
|------|------|------|-------------|
| 全部通过 | 浮亏/持仓/现金均正常 | 通过 | 基础风控 |
| 浮亏超限拒绝 | 浮亏 > 单日最大亏损 | 拒绝 | 浮亏限制 |
| 持仓市值超限拒绝 | 持仓市值 > 最大持仓市值 | 拒绝 | 持仓限制 |
| 港币可用现金不足拒绝 | HKD现金 < 买入金额 | 拒绝 | 现金不足 |
| 必须实时调用API | 验证API调用 | API被调用 | 不使用缓存 |

**检查顺序验证**：

| 用例 | 输入 | 预期 | 业务规则引用 |
|------|------|------|-------------|
| 检查1失败时不执行后续 | 频率检查失败 | 仅检查1执行 | 短路逻辑 |
| 检查3失败时1和2已通过 | 价格检查失败 | 1,2通过, 3失败 | 顺序执行 |
| 所有检查通过的完整流程 | 全部通过 | 信号批准 | 完整流程 |

#### unrealizedLossMonitor.test.ts

| 用例 | 输入 | 预期 | 业务规则引用 |
|------|------|------|-------------|
| R1 计算正确 | 3笔买入订单 | R1 = Σ(买入价×买入量) | 开仓成本 |
| N1 计算正确 | 3笔买入订单 | N1 = Σ(买入量) | 持仓数量 |
| R2 计算正确 | 当前价×N1 | R2 正确 | 当前市值 |
| 浮亏=R2-R1（负值为亏损） | R2 < R1 | 负值 | 浮亏计算 |
| 当日已实现亏损偏移使 R1 增大 | 已实现亏损 | adjusted R1 = max(0, base R1 - offset) | 偏移机制 |
| 已实现盈亏偏移公式验证 | 完整交易数据 | 偏移值正确 | 偏移计算 |
| 浮亏触发保护性清仓 | 亏损超阈值 | 触发清仓 | 保护性清仓 |
| 浮亏未触发保护性清仓 | 亏损在阈值内 | 不触发 | 阈值判断 |
| 做多做空浮亏独立 | 做多亏损 | 不影响做空 | 方向独立 |
| 保护性清仓后 R1/N1 归零 | 清仓后 | R1=0, N1=0 | 清仓重置 |

#### warrantRiskChecker.test.ts

| 用例 | 输入 | 预期 | 业务规则引用 |
|------|------|------|-------------|
| 设置回收价信息 | callPrice=20000 | 存储正确 | 回收价管理 |
| 距回收价百分比计算（牛证） | 牛证数据 | 百分比正确 | 距离计算 |
| 距回收价百分比计算（熊证） | 熊证数据 | 百分比正确 | 距离计算 |
| 距回收价触发清仓（牛证≤0.3%） | 距离0.2% | 触发清仓 | 静态模式清仓 |
| 距回收价触发清仓（熊证≥-0.3%） | 距离-0.2% | 触发清仓 | 静态模式清仓 |
| 清仓使用 ELO 订单类型 | 触发清仓 | ELO | 订单类型 |
| 仅可用持仓>0时触发 | 可用持仓=0 | 不触发 | 持仓条件 |

#### dailyLossTracker.test.ts（日内亏损追踪器）

| 用例 | 输入条件 | 预期 | 业务规则引用 |
|------|---------|------|-------------|
| 初始化时亏损为 0 | 新建追踪器 | 已实现亏损=0 | 初始状态 |
| 记录卖出成交后更新已实现盈亏 | 卖出成交 | 已实现盈亏正确更新 | 成交更新 |
| 已实现亏损（负值）时偏移 R1 | 已实现亏损=-500 | R1 增大 | 偏移机制 |
| 已实现盈利（正值）时不调整 R1 | 已实现盈利=200 | R1 不变 | 仅亏损偏移 |
| 启动时从全量订单计算偏移 | 历史订单数据 | 偏移值正确 | 启动计算 |
| 午夜清理重置 | 跨日 | 已实现亏损归零 | 跨日重置 |

#### positionLimitChecker.test.ts（持仓限制检查器）

| 用例 | 输入条件 | 预期 | 业务规则引用 |
|------|---------|------|-------------|
| 持仓市值未超限通过 | 市值 < 最大持仓市值 | allowed=true | 正常通过 |
| 持仓市值超限拒绝 | 市值 > 最大持仓市值 | allowed=false | 超限拒绝 |
| 持仓市值等于上限通过 | 市值 = 最大持仓市值 | allowed=true | 边界条件 |
| 无持仓时通过 | 持仓为空 | allowed=true | 首次买入 |
| 做多做空持仓市值独立计算 | 做多超限做空未超限 | 做多拒绝做空通过 | 方向独立 |

#### unrealizedLossChecker.test.ts（浮亏检查器）

| 用例 | 输入条件 | 预期 | 业务规则引用 |
|------|---------|------|-------------|
| 浮亏未超限通过 | 浮亏 > -单日最大亏损 | allowed=true | 正常通过 |
| 浮亏超限拒绝 | 浮亏 < -单日最大亏损 | allowed=false | 超限拒绝 |
| 浮亏恰好等于负阈值时拒绝 | 浮亏 = -单日最大亏损 | allowed=false | 边界条件（≤） |
| 无浮亏数据时通过 | 浮亏数据为 null | allowed=true | 安全默认 |

---

### 2.6 延迟验证机制（tests/main/asyncProgram/delayedSignalVerifier/）

验证延迟信号的 T0/T1/T2 三点验证逻辑和指标缓存机制。

#### delayedSignalVerifier.test.ts

| 用例 | 输入条件 | 预期 | 业务规则引用 |
|------|---------|------|-------------|
| BUYCALL 验证通过：T0/T1/T2 均高于初始值 | K 初始=30, T0=32, T1=34, T2=36 | 验证通过，推入买入队列 | 上涨趋势 |
| BUYCALL 验证失败：T1 低于初始值 | K 初始=30, T0=32, T1=28, T2=34 | 验证失败，丢弃信号 | 趋势不持续 |
| BUYPUT 验证通过：T0/T1/T2 均低于初始值 | K 初始=70, T0=68, T1=66, T2=64 | 验证通过，推入买入队列 | 下跌趋势 |
| BUYPUT 验证失败：T2 高于初始值 | K 初始=70, T0=68, T1=66, T2=72 | 验证失败，丢弃信号 | 趋势反转 |
| SELLCALL 验证通过：T0/T1/T2 均低于初始值 | 下跌趋势数据 | 验证通过，推入卖出队列 | 下跌趋势 |
| SELLPUT 验证通过：T0/T1/T2 均高于初始值 | 上涨趋势数据 | 验证通过，推入卖出队列 | 上涨趋势 |
| 多指标全部满足才通过 | K 和 MACD 均满足 | 验证通过 | 所有指标 |
| 任一指标不满足则失败 | K 满足但 MACD 不满足 | 验证失败 | 任一失败 |
| 缺少时间点数据则失败 | T1 无数据 | 验证失败 | 数据完整性 |
| 验证在 T2 时刻执行（T0+10秒） | 定时器在 T0+10s 触发 | 验证执行 | 执行时机 |
| 验证失败后信号释放回对象池 | 验证失败 | 信号释放 | 对象池管理 |
| 验证通过后校验席位版本号 | 版本匹配 | 推入队列 | 版本校验 |
| 验证通过但席位版本不匹配 | 版本不匹配 | 丢弃信号 | 版本校验 |

#### indicatorCache.test.ts

| 用例 | 输入 | 预期 | 业务规则引用 |
|------|------|------|-------------|
| 环形缓冲区存储每秒快照 | 连续写入 | 按时间存储 | 缓存机制 |
| 深拷贝存储（独立于对象池） | 写入后修改原对象 | 缓存不受影响 | 数据独立 |
| 时间容忍度 ±5 秒查找 | 查找 T0±3秒 | 找到数据 | 容忍度 |
| 超出容忍度查找失败 | 查找 T0±6秒 | 返回 null | 容忍度边界 |
| 缓存容量=max(买入延迟,卖出延迟)+25秒 | 买入60s,卖出30s | 容量=85 | 容量计算 |
| 退出连续交易时段时清理待验证信号 | 退出交易时段 | 所有待验证信号清理 | 时段清理 |
| 标的切换时清理对应待验证信号 | 标的切换 | 对应方向信号清理 | 换标清理 |

---

### 2.7 买入/卖出处理器（tests/main/asyncProgram/processors/）

验证异步处理器的队列消费、席位校验和订单执行逻辑。

#### buyProcessor.test.ts

| 用例 | 输入条件 | 预期 | 业务规则引用 |
|------|---------|------|-------------|
| 正常买入：席位版本匹配+风险检查通过 | 有效信号 | 提交买入订单 | 正常流程 |
| 席位版本不匹配：丢弃信号 | 版本不匹配 | 信号丢弃 | 版本校验 |
| 标的不一致：丢弃信号 | 标的不匹配 | 信号丢弃 | 标的校验 |
| 风险检查失败：不提交订单 | 风险检查拒绝 | 不提交 | 风险检查 |
| 风险检查使用实时 API 数据 | 买入信号 | API 被调用 | 实时数据 |
| 处理完成后释放信号对象 | 任何结果 | 信号释放 | 对象池 |
| 队列有任务时立即处理 | 队列非空 | 立即消费 | 调度机制 |
| 队列为空时停止调度 | 队列空 | 停止等待 | 调度机制 |
| 新任务触发重新调度 | 新任务入队 | 重新启动 | 调度机制 |

#### sellProcessor.test.ts

| 用例 | 输入条件 | 预期 | 业务规则引用 |
|------|---------|------|-------------|
| 正常卖出：席位版本匹配 | 有效卖出信号 | 提交卖出订单 | 正常流程 |
| 席位版本不匹配：丢弃 | 版本不匹配 | 信号丢弃 | 版本校验 |
| 卖出使用缓存数据（非实时API） | 卖出信号 | 使用缓存 | 数据获取策略 |
| 卖出不经过风险检查 | 卖出信号 | 无风险检查 | 卖出免检 |
| 智能平仓计算卖出数量 | 智能平仓开启 | 按规则计算 | 智能平仓 |
| 全仓清仓使用全部持仓 | 智能平仓关闭 | 全部持仓 | 全仓清仓 |
| 提交卖出时登记待成交卖出 | 卖出提交 | 登记关联买入ID | 防重登记 |

---

### 2.8 末日保护（tests/core/doomsdayProtection/）

验证收盘前的自动保护机制。

#### doomsdayProtection.test.ts

| 用例 | 输入条件 | 预期 | 业务规则引用 |
|------|---------|------|-------------|
| 正常日 15:44 不拒绝买入 | 15:44 正常日 | 不拒绝 | 拒买时段外 |
| 正常日 15:45 拒绝买入 | 15:45 正常日 | 拒绝 | 15:45-16:00 |
| 正常日 16:00 拒绝买入 | 16:00 正常日 | 拒绝 | 边界 |
| 半日 11:44 不拒绝买入 | 11:44 半日 | 不拒绝 | 半日拒买时段外 |
| 半日 11:45 拒绝买入 | 11:45 半日 | 拒绝 | 11:45-12:00 |
| 正常日首次进入 15:45 撤销未成交买入 | 首次进入 | 撤销所有未成交买入 | 首次撤单 |
| 正常日第二次进入 15:46 不重复撤销 | 第二次进入 | 不撤销 | 仅首次 |
| 正常日 15:55 生成清仓信号 | 15:55 正常日 | 生成清仓信号 | 15:55-15:59 |
| 正常日 15:54 不生成清仓信号 | 15:54 正常日 | 不生成 | 清仓时段外 |
| 半日 11:55 生成清仓信号 | 11:55 半日 | 生成清仓信号 | 11:55-11:59 |
| 清仓信号无条件执行 | 清仓信号 | 不受智能平仓影响 | 无条件清仓 |
| 清仓信号清空所有持仓 | 有持仓 | 全部清空 | 全部清仓 |
| 末日保护开关关闭时不执行 | 开关关闭 | 不拒买不清仓 | 可配置 |

---

### 2.9 订单监控（tests/main/asyncProgram/orderMonitor/）

验证订单价格跟踪、超时处理和 WebSocket 事件处理。

#### orderMonitorWorker.test.ts

| 用例 | 输入条件 | 预期 | 业务规则引用 |
|------|---------|------|-------------|
| 价格上涨时调整委托价 | 市场价上涨 | 改单请求发出 | 价格跟踪 |
| 价格下跌时调整委托价 | 市场价下跌 | 改单请求发出 | 价格跟踪 |
| 价格差异<0.001不调整 | 差异0.0005 | 不改单 | 最小差异 |
| 订单状态非未成交/部分成交不调整 | 已成交订单 | 不改单 | 状态条件 |
| 最小更新间隔内不调整 | 间隔过短 | 不改单 | 频率控制 |
| 买入超时自动撤销 | 超过配置时间 | 撤销订单 | 买入超时 |
| 卖出超时撤销后转市价单 | 超过配置时间 | 撤销+市价单重委托 | 卖出超时 |

#### orderEventHandler.test.ts（WebSocket 事件处理）

| 用例 | 输入条件 | 预期 | 业务规则引用 |
|------|---------|------|-------------|
| 完全成交：更新本地订单记录 | 成交事件 | 使用实际成交价更新 | 成交处理 |
| 完全成交：标记待成交卖出为已成交 | 卖出成交 | 移除登记 | 防重更新 |
| 完全成交：标记需刷新数据 | 成交事件 | 标记账户/持仓/浮亏刷新 | 刷新标记 |
| 部分成交：更新待成交卖出已成交数量 | 部分成交 | 更新已成交量 | 部分成交 |
| 撤单：移除待成交卖出登记 | 撤单事件 | 移除登记，状态标记已取消 | 撤单处理 |
| 主循环统一刷新缓存数据 | 刷新标记存在 | 通过刷新门禁刷新 | 统一刷新 |

---

### 2.10 自动寻标/换标（tests/services/autoSymbol/）

验证席位管理、自动寻标筛选和换标状态机。

#### seatStateManager.test.ts

| 用例 | 输入 | 预期 | 业务规则引用 |
|------|------|------|-------------|
| 初始席位状态为 EMPTY | 新建席位 | status=EMPTY | 初始状态 |
| 占位后状态变为 READY | 寻标成功 | status=READY | 占位 |
| 换标时状态变为 SWITCHING | 触发换标 | status=SWITCHING | 换标中 |
| 寻标时状态变为 SEARCHING | 触发寻标 | status=SEARCHING | 寻标中 |
| 清席位递增版本号 | 清席位 | version+1 | 版本递增 |
| 版本号用于阻断旧信号 | 旧版本信号 | 被丢弃 | 版本校验 |

#### autoSearch.test.ts

| 用例 | 输入条件 | 预期 | 业务规则引用 |
|------|---------|------|-------------|
| 仅在允许交易时段内执行 | 非交易时段 | 不执行 | 时段限制 |
| 不在开盘保护窗口内执行 | 开盘保护中 | 不执行 | 开盘保护 |
| 早盘开盘延迟（默认5分钟） | 开盘后3分钟 | 不执行 | 开盘延迟 |
| 有持仓时可跳过开盘延迟 | 有持仓 | 可执行 | 持仓跳过 |
| 同方向10分钟冷却 | 5分钟内再次触发 | 不执行 | 触发冷却 |
| 筛选：交易状态正常 | 停牌标的 | 被过滤 | 筛选规则 |
| 筛选：牛/熊方向匹配 | 方向不匹配 | 被过滤 | 方向匹配 |
| 筛选：到期月份≥下限 | 到期不足 | 被过滤 | 到期限制 |
| 筛选：成交额>0 | 成交额=0 | 被过滤 | 成交额 |
| 阈值：距回收价百分比达标 | 牛证>阈值 | 通过 | 距离阈值 |
| 阈值：分均成交额达标 | 达到门槛 | 通过 | 成交额阈值 |
| 选优：距回收价绝对值更小优先 | 多个候选 | 距离最小的 | 选优规则 |
| 选优：距离相同则分均成交额更高优先 | 距离相同 | 成交额高的 | 选优规则 |
| 仅取最优1个 | 多个候选 | 返回1个 | 单选 |
| 寻标失败：失败计数+1 | 无候选 | 计数增加 | 失败计数 |
| 失败达上限（默认3次）：冻结 | 第3次失败 | 冻结当日 | 冻结机制 |
| 冻结后当日不再寻标 | 已冻结 | 不执行 | 冻结效果 |
| 跨日重置失败计数和冻结标记 | 午夜清理 | 计数归零，冻结清除 | 跨日重置 |
| 寻标成功：占位+订阅行情+清零失败计数 | 成功 | READY+订阅+计数归零 | 成功处理 |
| 启动时推断：有持仓标的优先 | 有持仓 | 使用持仓标的 | 启动推断 |

#### autoSymbolFinder.test.ts（自动寻标筛选器）

| 用例 | 输入条件 | 预期 | 业务规则引用 |
|------|---------|------|-------------|
| findBestWarrant 牛证筛选 | isBull=true | 使用 WarrantType.Bull | 方向匹配 |
| findBestWarrant 熊证筛选 | isBull=false | 使用 WarrantType.Bear | 方向匹配 |
| 过滤：交易状态非正常被排除 | 停牌标的 | 被过滤 | 状态过滤 |
| 过滤：成交额为 0 被排除 | turnover=0 | 被过滤 | 成交额过滤 |
| 过滤：到期月份不足被排除 | 到期不足 expiryMinMonths | 被过滤 | 到期过滤 |
| 阈值：距回收价百分比未达标被排除 | 牛证距离 < minDistancePct | 被过滤 | 距离阈值 |
| 阈值：分均成交额未达标被排除 | 分均成交额 < minTurnoverPerMinute | 被过滤 | 成交额阈值 |
| 选优：距回收价绝对值更小优先 | 多个候选 | 距离最小的被选中 | 选优规则 |
| 选优：距离相同则分均成交额更高优先 | 距离相同 | 成交额高的被选中 | 选优规则 |
| 仅返回最优 1 个 | 多个候选 | 返回 1 个 | 单选 |
| 无候选时返回 null | 全部被过滤 | 返回 null | 无候选 |
| API 异常时返回 null | warrantList 抛异常 | 返回 null 并记录日志 | 容错 |
| buildExpiryDateFilters 构建正确 | expiryMinMonths=3 | 过滤器正确 | 到期日过滤 |
| 分均成交额计算正确 | turnover + tradingMinutes | turnover/tradingMinutes | 分均计算 |
| 轮证列表缓存：TTL 内命中 | 缓存有效 | 不调用 API | 缓存命中 |
| 轮证列表缓存：TTL 过期重新获取 | 缓存过期 | 调用 API | 缓存过期 |
| 轮证列表缓存：请求去重 | 并发请求同一键 | 仅一次 API 调用 | 请求去重 |
| 轮证列表缓存：缓存键包含方向和到期日 | 不同方向 | 不同缓存键 | 缓存键构建 |
| 无缓存配置时直接请求 | cacheConfig=undefined | 直接调用 API | 无缓存 |

#### signalBuilder.test.ts（信号构造与数量计算）

| 用例 | 输入条件 | 预期 | 业务规则引用 |
|------|---------|------|-------------|
| resolveDirectionSymbols LONG | direction='LONG' | isBull=true, buyAction='BUYCALL', sellAction='SELLCALL' | 方向映射 |
| resolveDirectionSymbols SHORT | direction='SHORT' | isBull=false, buyAction='BUYPUT', sellAction='SELLPUT' | 方向映射 |
| calculateBuyQuantityByNotional 正常计算 | notional=10000, price=1.0, lotSize=1000 | 10000 | 数量计算 |
| calculateBuyQuantityByNotional 按 lotSize 向下取整 | notional=10000, price=1.5, lotSize=1000 | 6000（非6666） | 向下取整 |
| calculateBuyQuantityByNotional 不足最小手数返回 null | notional=100, price=1.0, lotSize=1000 | null | 不足最小手 |
| calculateBuyQuantityByNotional 无效 notional | notional=0 或负数 | null | 参数校验 |
| calculateBuyQuantityByNotional 无效 price | price=0 或负数 | null | 参数校验 |
| calculateBuyQuantityByNotional 无效 lotSize | lotSize=0 或负数 | null | 参数校验 |
| buildOrderSignal 使用对象池构造 | 有效参数 | 从对象池获取并填充字段 | 对象池 |
| buildOrderSignal 设置 orderTypeOverride | orderTypeOverride='MO' | signal.orderTypeOverride='MO' | 类型覆盖 |
| buildOrderSignal 无 orderTypeOverride | 不传 | signal.orderTypeOverride=null | 默认值 |
| buildOrderSignal 设置 triggerTime | 构造信号 | triggerTime 为当前时间 | 触发时间 |

#### thresholdResolver.test.ts（阈值解析器）

| 用例 | 输入条件 | 预期 | 业务规则引用 |
|------|---------|------|-------------|
| resolveAutoSearchThresholds LONG | direction='LONG' | 返回牛证阈值配置 | 牛证阈值 |
| resolveAutoSearchThresholds SHORT | direction='SHORT' | 返回熊证阈值配置 | 熊证阈值 |
| 牛证使用 Bull 系列配置 | LONG | minDistancePctBull, minTurnoverPerMinuteBull | 配置映射 |
| 熊证使用 Bear 系列配置 | SHORT | minDistancePctBear, minTurnoverPerMinuteBear | 配置映射 |
| switchDistanceRange 牛证使用 Bull 区间 | LONG | switchDistanceRangeBull | 区间映射 |
| switchDistanceRange 熊证使用 Bear 区间 | SHORT | switchDistanceRangeBear | 区间映射 |
| 阈值为 null 时返回 null | 未配置阈值 | resolveAutoSearchThresholdInput 返回 null | 缺失配置 |
| buildFindBestWarrantInput 构造正确 | 有效参数 | 包含所有必需字段 | 参数构造 |
| 启动时推断：有持仓标的优先 | 有持仓 | 使用持仓标的 | 启动推断 |

#### switchStateMachine.test.ts

| 用例 | 输入条件 | 预期 | 业务规则引用 |
|------|---------|------|-------------|
| 触发条件：监控标的价格显著变化 | 价格变化达阈值 | 检查距回收价 | 触发条件 |
| 越界判定：牛证距回收价≤区间下限 | 距离≤下限 | 触发换标 | 越界判定 |
| 越界判定：牛证距回收价≥区间上限 | 距离≥上限 | 触发换标 | 越界判定 |
| 预寻标候选与旧标的一致：日内抑制 | 候选=旧标的 | 记录抑制，不换标 | 日内抑制 |
| 日内抑制跨日清理 | 次日 | 抑制清除 | 跨日清理 |
| 撤单阶段：撤销旧标的未完成买入挂单 | 有未完成买入 | 撤销 | 撤单范围 |
| 撤单失败：换标失败，席位变 EMPTY | 撤单API失败 | EMPTY | 撤单失败 |
| 持仓判定：可用持仓>0提交移仓卖出 | 可用持仓100 | ELO卖出 | 移仓卖出 |
| 持仓判定：总持仓>0但可用=0等待 | 总100可用0 | 等待下轮 | 等待卖出 |
| 移仓卖出使用 ELO | 移仓卖出 | ELO订单 | 订单类型 |
| 占位：候选存在则 READY | 有候选 | READY | 占位 |
| 回补买入：按卖出资金/目标金额计算 | 卖出资金已知 | 计算买入量 | 回补计算 |
| 回补买入按最小买卖单位向下取整 | 计算结果 | 向下取整 | 取整规则 |
| 回补使用 ELO | 回补买入 | ELO订单 | 订单类型 |
| 换标完成：回收价刷新成功 | 刷新成功 | 换标完成 | 完成定义 |
| 换标失败：回收价刷新失败 | 刷新失败 | 席位EMPTY | 刷新失败 |
| 换标后统一刷新顺序验证 | 换标完成 | 按顺序刷新 | 刷新顺序 |
| 流程推进：一旦进入持续推进 | 进入换标 | 后续循环继续 | 流程推进 |

---

### 2.11 订单管理补充（tests/core/trader/）

验证订单执行、API 频率限制和恢复期处理。

#### orderExecutor.test.ts

| 用例 | 输入条件 | 预期 | 业务规则引用 |
|------|---------|------|-------------|
| 提交 ELO 买入订单 | 买入信号 | submitOrder 调用正确 | 正常买入 |
| 提交 MO 清仓订单 | 清仓信号 | 市价单提交 | 清仓订单 |
| 订单类型覆盖优先于全局配置 | orderTypeOverride=MO | 使用 MO | 类型覆盖 |
| 买入后新增本地订单记录 | 买入成交 | recordLocalBuy 调用 | 本地更新 |
| 卖出后扣减本地订单记录 | 卖出成交 | recordLocalSell 调用 | 本地更新 |
| 保护性清仓后清空订单记录 | 清仓成交 | clearBuyOrders 调用 | 清仓处理 |

#### rateLimiter.test.ts

| 用例 | 输入条件 | 预期 | 业务规则引用 |
|------|---------|------|-------------|
| 30秒内≤30次通过 | 30次调用 | 全部通过 | 频率限制 |
| 30秒内>30次等待 | 第31次调用 | 等待后执行 | 超限等待 |
| 调用间隔≥0.03秒 | 连续调用 | 间隔≥30ms | 最小间隔 |

#### orderRecovery.test.ts（恢复期处理）

| 用例 | 输入条件 | 预期 | 业务规则引用 |
|------|---------|------|-------------|
| 启动时发现未完成卖出订单 | 有未完成卖出 | 分配关联买入ID | 恢复期 |
| 按低价优先整笔分配关联买入ID | 多笔买入 | 低价优先分配 | 分配规则 |
| 恢复后防重机制有效 | 恢复完成 | 智能平仓排除已占用 | 防重有效 |

#### orderHoldRegistry.test.ts（订单保留集管理）

| 用例 | 输入条件 | 预期 | 业务规则引用 |
|------|---------|------|-------------|
| trackOrder 建立双向索引 | orderId + symbol | orderIdToSymbol 和 orderIdsBySymbol 均记录 | 双向索引 |
| trackOrder 重复 orderId 不覆盖 | 同一 orderId 再次调用 | 忽略，不更新 | 幂等性 |
| markOrderFilled 清理索引 | 已追踪的 orderId | 双向索引均移除 | 成交清理 |
| markOrderFilled 标的无剩余订单时移除 holdSymbols | 标的仅一个订单 | holdSymbols 移除该标的 | 自动清理 |
| seedFromOrders 从订单列表初始化 | 含未成交订单的列表 | 仅未成交状态的订单被追踪 | 启动初始化 |
| getHoldSymbols 返回正确集合 | 多个标的有未成交订单 | 返回所有标的 | 查询功能 |
| clear 清空所有数据 | 有追踪数据 | 所有 map/set 清空 | 午夜清理 |

#### accountService.test.ts（账户服务）

| 用例 | 输入条件 | 预期 | 业务规则引用 |
|------|---------|------|-------------|
| getAccountSnapshot 正常返回 | API 返回有效数据 | 正确解析 totalCash/netAssets/positionValue/cashInfos | 数据转换 |
| getAccountSnapshot 空余额返回 null | API 返回空数组 | 返回 null | 空数据处理 |
| getAccountSnapshot 调用 rateLimiter | 任何调用 | rateLimiter.throttle 被调用 | 频率限制 |
| getStockPositions 正常返回 | API 返回持仓 | 正确解析 symbol/quantity/availableQuantity/costPrice | 数据转换 |
| getStockPositions 按标的过滤 | 传入 symbols 数组 | 仅返回指定标的 | 过滤功能 |
| getStockPositions 多 channel 合并 | 多个 accountChannel | 所有 channel 的持仓合并 | 多渠道 |
| Decimal 类型正确转换为 number | API 返回 Decimal 类型 | 转换为 number | 类型转换 |

#### orderCacheManager.test.ts（订单缓存管理）

| 用例 | 输入条件 | 预期 | 业务规则引用 |
|------|---------|------|-------------|
| 首次调用从 API 获取 | 无缓存 | 调用 todayOrders API | 首次获取 |
| TTL 内重复调用使用缓存 | 缓存有效 | 不调用 API，返回缓存 | 缓存命中 |
| TTL 过期后重新获取 | 缓存过期 | 调用 API 刷新 | 缓存过期 |
| forceRefresh 强制刷新 | forceRefresh=true | 忽略缓存，调用 API | 强制刷新 |
| 按标的过滤结果 | symbols=['A.HK','B.HK'] | 仅返回指定标的的订单 | 客户端过滤 |
| 仅返回未成交状态订单 | 含已成交订单 | 已成交订单被过滤 | 状态过滤 |
| symbols 变化时缓存失效 | 先查 A，再查 B | 第二次调用 API | 缓存键变化 |
| clearCache 清除缓存 | 有缓存 | 下次调用重新获取 | 缓存清除 |
| API 返回非数组时返回空 | todayOrders 返回异常 | 返回 [] | 容错处理 |
| rateLimiter 被调用 | 任何 API 调用 | throttle 被调用 | 频率限制 |

#### tradeLogger.test.ts（交易记录）

| 用例 | 输入条件 | 预期 | 业务规则引用 |
|------|---------|------|-------------|
| recordTrade 写入新文件 | 无已有文件 | 创建文件并写入 | 首次记录 |
| recordTrade 追加到已有文件 | 已有记录文件 | 追加到数组末尾 | 追加记录 |
| recordTrade 缺失字段写入 null | 部分字段缺失 | null 填充 | 字段兜底 |
| recordTrade 文件格式错误时重置 | 已有文件内容损坏 | 重置为空数组后写入 | 容错处理 |
| identifyErrorType 识别资金不足 | "insufficient" | isInsufficientFunds=true | 错误分类 |
| identifyErrorType 识别不支持做空 | "short selling" | isShortSellingNotSupported=true | 错误分类 |
| identifyErrorType 识别网络错误 | "timeout" | isNetworkError=true | 错误分类 |
| identifyErrorType 识别频率限制 | "rate limit" | isRateLimited=true | 错误分类 |
| identifyErrorType 中文关键词匹配 | "资金不足" | isInsufficientFunds=true | 中文支持 |
| isValidTradeRecord 校验有效记录 | 完整记录 | 返回 true | 类型守卫 |

### 2.12 配置验证（tests/config/）

#### configValidator.test.ts

| 用例 | 输入条件 | 预期 | 业务规则引用 |
|------|---------|------|-------------|
| LongPort API 凭证完整通过 | 三项凭证均配置 | valid=true | API 凭证 |
| LongPort API 凭证缺失 | APP_KEY 未配置 | valid=false, 错误信息 | 凭证缺失 |
| LongPort API 凭证为占位符 | 值为 your_app_key_here | valid=false | 占位符检测 |
| 监控标的格式正确（ticker.region） | 68711.HK | 通过 | 格式校验 |
| 监控标的格式错误 | 68711（无 .HK） | 错误 | 格式校验 |
| 自动寻标关闭时做多/做空标的必需 | autoSearch=false, 无标的 | 错误 | 必需配置 |
| 自动寻标开启时做多/做空标的可选 | autoSearch=true, 无标的 | 通过 | 可选配置 |
| 目标买入金额必须为正数 | targetNotional=0 | 错误 | 数值校验 |
| 最大持仓市值必须为正数 | maxPositionNotional=-1 | 错误 | 数值校验 |
| 单日最大亏损必须为非负数 | maxDailyLoss=-1 | 错误 | 数值校验 |
| 信号配置为必需项 | buycall 未配置 | 错误 | 必需配置 |
| 清仓冷却分钟数范围 1-120 | minutes=150 | 错误 | 范围校验 |
| 清仓冷却支持 half-day/one-day | mode='half-day' | 通过 | 模式校验 |
| 重复交易标的检测 | 两个监控标的使用同一标的 | 错误 | 重复检测 |
| 订单归属映射冲突检测 | 同一缩写映射到不同监控标的 | 错误 | 冲突检测 |
| 订单归属映射为空时报错 | mapping=[] | 错误 | 必需配置 |
| 自动寻标配置完整性 | 缺少 minDistancePctBull | 错误 | 自动寻标配置 |
| switchDistanceRange min>max 报错 | min=5, max=3 | 错误 | 区间校验 |
| 开盘保护分钟数范围 1-60 | minutes=0 | 错误 | 范围校验 |
| validateRuntimeSymbolsFromQuotesMap 标的存在 | 行情数据有效 | valid=true | 运行时验证 |
| validateRuntimeSymbolsFromQuotesMap 标的不存在 | 行情数据为 null | valid=false | 运行时验证 |
| 交易标的缺少 lotSize 报错 | lotSize=null | 错误 | lotSize 必需 |
| 监控标的缺少 lotSize 不报错 | 监控标的无 lotSize | 通过（仅警告） | 监控标的宽松 |

### 2.13 信号流水线（tests/main/processMonitor/）

#### signalPipeline.test.ts

| 用例 | 输入条件 | 预期 | 业务规则引用 |
|------|---------|------|-------------|
| 开盘保护期间跳过信号生成 | openProtectionActive=true | 直接返回，不调用 generateCloseSignals | 开盘保护 |
| 立即买入信号入 buyTaskQueue | 立即 BUYCALL 信号 | push 到 buyTaskQueue | 买入分流 |
| 立即卖出信号入 sellTaskQueue | 立即 SELLCALL 信号 | push 到 sellTaskQueue | 卖出分流 |
| 延迟信号入 delayedSignalVerifier | 延迟 BUYCALL 信号 | addSignal 到验证器 | 延迟分流 |
| 席位非 READY 时丢弃信号 | seatState=SEARCHING | 信号释放回对象池 | 席位校验 |
| 信号标的与席位标的不匹配时丢弃 | signal.symbol ≠ seatSymbol | 信号释放 | 标的校验 |
| 买入信号行情未就绪时丢弃 | quote=null + 买入信号 | 信号释放 | 行情未就绪 |
| 卖出信号行情未就绪时可尝试 | quote=null + 卖出信号 | 信号不被丢弃 | 卖出可尝试 |
| 无效信号对象（缺少 symbol）丢弃 | signal.symbol=null | 信号释放 | 无效信号 |
| 未知信号类型丢弃 | signal.action='UNKNOWN' | 信号释放 | 类型校验 |
| 交易门禁关闭时信号释放 | isTradingEnabled=false | 信号释放，记录原因 | 交易门禁 |
| 非交易时段信号释放 | canTradeNow=false | 信号释放，记录原因 | 非交易时段 |
| enrichSignal 填充 symbolName | quote 有 name | signal.symbolName 被设置 | 信号丰富 |
| enrichSignal 不覆盖已有 symbolName | signal 已有 symbolName | 保持原值 | 不覆盖 |
| seatVersion 写入信号 | 席位版本=5 | signal.seatVersion=5 | 版本写入 |
| BUYCALL/SELLCALL 使用做多席位 | BUYCALL 信号 | 使用 longSeatState | 方向映射 |
| BUYPUT/SELLPUT 使用做空席位 | BUYPUT 信号 | 使用 shortSeatState | 方向映射 |
| finally 块释放 position 对象 | 任何执行路径 | longPosition/shortPosition 释放 | 对象池 |

---

## 三、全链路集成测试（tests/integration/）

全链路集成测试模拟完整的程序运行流程，验证各模块协同工作的正确性。

### 3.1 买入全链路（buyFlow.integration.test.ts）

| 场景 | 模拟流程 | 验证点 | 业务规则引用 |
|------|---------|--------|-------------|
| 正常买入全链路 | 行情变化→指标计算→信号生成(BUYCALL)→立即信号入队→风险检查通过→提交订单→成交→更新记录 | 1.信号正确生成 2.风险检查6项全通过 3.订单参数正确 4.本地记录更新 | 完整买入流程 |
| 延迟买入全链路 | 行情变化→信号生成→延迟信号入验证器→T0/T1/T2验证通过→入队→风险检查→提交→成交 | 1.信号进入验证器 2.T0+10s后验证 3.趋势持续性确认 4.订单执行 | 延迟验证流程 |
| 买入被风险检查拒绝 | 信号生成→入队→频率限制拒绝 | 1.信号正确生成 2.风险检查拒绝 3.不提交订单 4.信号释放 | 风险拦截 |
| 买入被牛熊证风险拒绝 | 信号生成→入队→距回收价过近拒绝 | 1.牛熊证风险检查拒绝 2.不提交订单 | 牛熊证风控 |
| 买入被现金不足拒绝 | 信号生成→入队→API返回现金不足 | 1.实时API调用 2.现金检查拒绝 | 基础风控 |
| 延迟买入验证失败 | 信号生成→入验证器→T1趋势反转→验证失败 | 1.验证失败 2.信号丢弃释放 3.不入队 | 假信号过滤 |

### 3.2 卖出全链路（sellFlow.integration.test.ts）

| 场景 | 模拟流程 | 验证点 | 业务规则引用 |
|------|---------|--------|-------------|
| 智能平仓-整体盈利全卖 | 持有3笔买入→行情上涨→SELLCALL信号→智能平仓判断整体盈利→卖出全部→成交→更新记录 | 1.成本均价计算正确 2.整体盈利判断 3.全部卖出 4.订单记录扣减 | 智能平仓盈利 |
| 智能平仓-整体未盈利仅卖盈利部分 | 持有3笔买入(不同价)→行情微涨→SELLCALL→仅卖低价盈利订单 | 1.仅盈利订单被卖 2.高价订单保留 3.防重正确 | 智能平仓部分 |
| 智能平仓-无盈利订单保持持仓 | 持有买入→行情下跌→SELLCALL→无盈利订单→不卖出 | 1.shouldHold=true 2.持仓不变 | 保持持仓 |
| 全仓清仓（智能平仓关闭） | 持有买入→SELLCALL→智能平仓关闭→全部卖出 | 1.使用全部可用持仓 2.全部卖出 | 全仓清仓 |
| 卖出后浮亏数据更新 | 卖出成交→浮亏监控数据刷新 | 1.R1更新 2.N1更新 3.浮亏重算 | 浮亏更新 |

### 3.3 保护性清仓全链路（protectiveLiquidation.integration.test.ts）

| 场景 | 模拟流程 | 验证点 | 业务规则引用 |
|------|---------|--------|-------------|
| 浮亏触发保护性清仓 | 持有买入→行情暴跌→浮亏超阈值→生成清仓信号→执行清仓→清空记录→重算浮亏 | 1.浮亏计算正确 2.阈值触发 3.清仓执行 4.记录清空 5.R1/N1归零 | 保护性清仓 |
| 保护性清仓后进入冷却期 | 清仓完成→冷却期内买入信号→被拒绝 | 1.冷却记录 2.买入被拒 | 清仓冷却 |
| 保护性清仓后冷却期过后恢复 | 清仓→等待冷却期→新买入信号→通过 | 1.冷却过期 2.买入通过 | 冷却恢复 |
| 做多清仓不影响做空 | 做多浮亏清仓→做空买入信号 | 1.做空不受影响 2.做空可正常买入 | 方向独立 |

### 3.4 末日保护全链路（doomsdayProtection.integration.test.ts）

| 场景 | 模拟流程 | 验证点 | 业务规则引用 |
|------|---------|--------|-------------|
| 收盘前15分钟拒买+撤单 | 时间推进到15:45→买入信号被拒→未成交买入被撤 | 1.买入拒绝 2.撤单执行 3.仅首次撤单 | 拒买+撤单 |
| 收盘前5分钟自动清仓 | 时间推进到15:55→持有仓位→生成清仓信号→全部清仓 | 1.清仓信号生成 2.无条件执行 3.全部清空 | 自动清仓 |
| 半日市末日保护 | 时间推进到11:45→拒买；11:55→清仓 | 1.半日时间正确 2.拒买+清仓 | 半日保护 |

### 3.5 自动换标全链路（autoSwitch.integration.test.ts）

| 场景 | 模拟流程 | 验证点 | 业务规则引用 |
|------|---------|--------|-------------|
| 正常换标（无持仓） | 距回收价越界→预寻标→候选不同→撤单→无持仓→占位→刷新 | 1.越界触发 2.预寻标 3.新标的占位 4.刷新顺序 | 无持仓换标 |
| 正常换标（有持仓+回补） | 越界→预寻标→撤单→移仓卖出→等待成交→占位→回补买入 | 1.移仓ELO卖出 2.等待成交 3.回补计算 4.回补ELO买入 | 有持仓换标 |
| 换标中旧信号被阻断 | 换标进行中→旧版本信号到达 | 1.版本不匹配 2.信号丢弃 | 版本阻断 |
| 预寻标候选与旧标的一致：日内抑制 | 越界→预寻标→候选=旧标的 | 1.记录抑制 2.不清席位 3.不递增版本 | 日内抑制 |
| 换标失败回退 | 撤单失败 | 1.席位变EMPTY 2.该方向交易阻断 | 换标失败 |
| 轮证列表缓存生效 | 短时间内多次寻标 | 1.仅首次调用API 2.后续使用缓存 | 缓存优化 |
| 轮证列表缓存过期后刷新 | TTL过期后寻标 | 重新调用API | 缓存过期 |
| 并发寻标请求去重 | 同时触发多次寻标 | 仅一次API调用 | 请求去重 |

### 3.6 跨日生命周期全链路（lifecycle.integration.test.ts）

| 场景 | 模拟流程 | 验证点 | 业务规则引用 |
|------|---------|--------|-------------|
| 午夜清理→开盘重建完整流程 | dayKey变化→6域清理→等待开盘→6域重建→恢复交易 | 1.清理顺序正确 2.重建逆序 3.交易门禁 4.状态机转换 | 生命周期 |
| 午夜清理失败重试 | 清理失败→指数退避→重试成功 | 1.重试间隔正确 2.交易保持禁止 3.最终成功 | 失败重试 |
| 开盘重建失败重试 | 重建失败→指数退避→重试成功 | 1.状态OPEN_REBUILD_FAILED 2.重试 3.最终恢复 | 重建重试 |

### 3.7 多监控标的并发（multiMonitor.integration.test.ts）

| 场景 | 模拟流程 | 验证点 | 业务规则引用 |
|------|---------|--------|-------------|
| 两个监控标的独立生成信号 | 标的A和B同时行情变化→各自生成信号 | 1.信号独立 2.不互相干扰 | 多标的独立 |
| 两个标的共享订单记录器 | 标的A买入→标的B买入→各自查询 | 1.通过标的代码区分 2.各自记录正确 | 订单共享 |
| 一方浮亏不影响另一方 | 标的A做多浮亏→标的B做空正常 | 1.浮亏独立 2.风控独立 | 浮亏独立 |
| 并发处理互不阻塞 | 两标的同时处理 | 1.并发执行 2.无竞态 | 并发安全 |

### 3.8 订单记录全链路（orderRecord.integration.test.ts）

| 场景 | 模拟流程 | 验证点 | 业务规则引用 |
|------|---------|--------|-------------|
| 启动时全量订单加载+过滤 | API返回历史+当日订单→按席位标的筛选→应用过滤算法 | 1.去重正确 2.按标的筛选 3.过滤算法正确 | 启动加载 |
| 交易后本地更新（不调API） | 买入成交→本地记录→卖出成交→本地扣减 | 1.不调API 2.本地更新正确 | 本地更新 |
| 保护性清仓后重新计算 | 清仓→清空记录→重算浮亏 | 1.记录清空 2.浮亏归零 | 清仓重算 |
| 待成交卖出追踪完整流程 | 提交卖出→登记→部分成交→更新→完全成交→移除 | 1.登记正确 2.部分更新 3.完全移除 | 防重追踪 |
| 待成交卖出撤单后释放 | 提交卖出→登记→撤单→移除（状态已取消） | 1.撤单移除 2.状态标记 | 撤单释放 |

### 3.9 数据一致性验证（dataConsistency.integration.test.ts）

| 场景 | 模拟流程 | 验证点 | 业务规则引用 |
|------|---------|--------|-------------|
| 订单成交后数据刷新顺序 | 买入成交→刷新账户→刷新持仓→刷新浮亏 | 1.刷新顺序正确 2.门禁同步 | 刷新顺序 |
| 换标后统一刷新验证 | 换标完成→按序刷新6项 | 1.清空牛熊证风险 2.刷新订单 3.刷新账户持仓 4.刷新浮亏 5.刷新回收价 6.清理旧标的 | 换标刷新 |
| 异步处理器等待刷新完成 | 成交事件→刷新中→处理器阻塞→刷新完成→处理器继续 | 1.门禁阻塞 2.版本匹配后继续 | 刷新门禁 |
| 本地订单记录与API数据一致性 | 多次交易后→对比本地记录与API | 1.数量一致 2.价格一致 | 数据一致性 |
| 浮亏数据与持仓数据一致性 | 交易后→浮亏R1/N1与订单记录匹配 | 1.R1正确 2.N1正确 | 数据一致性 |

### 3.10 并发安全验证（concurrency.integration.test.ts）

| 场景 | 模拟流程 | 验证点 | 业务规则引用 |
|------|---------|--------|-------------|
| 多监控标的并发处理无竞态 | 两个标的同时生成信号 | 1.信号独立 2.无数据污染 | 并发安全 |
| 买入/卖出处理器并发消费 | 同时有买入和卖出任务 | 1.并发执行 2.无死锁 | 并发安全 |
| 延迟验证器并发验证 | 多个信号同时到达T2 | 1.并发验证 2.结果正确 | 并发安全 |
| 订单监控并发改价 | 多个订单同时需要改价 | 1.频率限制生效 2.无竞态 | 并发安全 |
| 对象池并发获取释放 | 多个信号同时获取/释放 | 1.无重复对象 2.无泄漏 | 对象池安全 |

### 3.11 API 失败与恢复（apiFailure.integration.test.ts）

| 场景 | 模拟流程 | 验证点 | 业务规则引用 |
|------|---------|--------|-------------|
| 风险检查 API 失败后恢复 | API 失败→买入被拒→API 恢复→买入通过 | 1.失败时拒绝 2.恢复后正常 | API 容错 |
| 订单提交失败不影响后续信号 | 提交失败→下一信号正常处理 | 1.错误隔离 2.后续正常 | 错误隔离 |
| 行情获取失败时跳过指标计算 | 行情 API 失败→无指标→无信号 | 1.安全跳过 2.不崩溃 | 行情容错 |
| 批量获取账户/持仓失败 | API 抛异常→所有买入信号被拒 | 1.buyApiFetchFailed=true 2.卖出不受影响 | API 失败处理 |
| 订单缓存 API 失败返回空 | todayOrders 失败→返回空数组 | 1.不崩溃 2.返回[] | 容错处理 |

---

## 四、执行计划

### 4.1 子代理分工（最终版）

| 子代理 | 负责模块 | 文件数 | 依赖 |
|--------|---------|--------|------|
| Agent-1: Mock 基础设施 | mock/ 全部文件 | 6 | 无 |
| Agent-2: 技术指标 | tests/services/indicators/ | 7 | Agent-1 |
| Agent-3: 信号生成+分流 | tests/core/strategy/ | 2 | Agent-1 |
| Agent-4: 订单过滤+归属解析 | tests/core/orderRecorder/ | 4 | Agent-1 |
| Agent-5: 卖出策略+风险检查流水线 | tests/core/signalProcessor/ | 3 | Agent-1 |
| Agent-6: 风控子模块+清仓冷却 | tests/core/riskController/ + tests/services/liquidationCooldown/ | 8 | Agent-1 |
| Agent-7: 延迟验证+处理器 | tests/main/asyncProgram/delayedSignalVerifier/ + processors/ | 4 | Agent-1 |
| Agent-8: 末日保护+订单监控 | tests/core/doomsdayProtection/ + orderMonitor/ | 3 | Agent-1 |
| Agent-9: 自动寻标/换标（完整） | tests/services/autoSymbol/ + autoSymbolFinder/ + autoSymbolManager/ | 7 | Agent-1 |
| Agent-10: 订单管理（完整） | tests/core/trader/ | 7 | Agent-1 |
| Agent-11: 基础设施+解析层 | tests/utils/ + tests/core/orderRecorder/orderOwnershipParser | 6 | Agent-1 |
| Agent-12: 异步基础设施+启动 | tests/main/asyncProgram/ (队列/处理器/刷新) + startup/ | 6 | Agent-1 |
| Agent-13: 配置验证+信号流水线 | tests/config/ + tests/main/processMonitor/ | 2 | Agent-1 |
| Agent-14: 全链路集成 | tests/integration/ | 11 | Agent-1~13 |

**总计**：66 个测试文件（不含已有的 lifecycle 测试）

### 4.2 执行顺序

```
Phase 1: Agent-1（Mock 基础设施）
    ↓
Phase 2: Agent-2 ~ Agent-13（并行执行，均依赖 Agent-1）
    ↓
Phase 3: Agent-14（全链路集成测试，依赖所有前置）
```

### 4.3 完整目录结构

```
mock/
├── longportMock.ts              # LongPort API Mock
├── mockLogger.ts                # 静默 Logger
├── mockTimer.ts                 # 可控时间
└── factories/
    ├── quoteFactory.ts          # 行情数据工厂
    ├── tradeFactory.ts          # 交易数据工厂
    ├── signalFactory.ts         # 信号数据工厂
    └── configFactory.ts         # 配置数据工厂

tests/
├── config/
│   └── configValidator.test.ts                (新增)
├── utils/
│   ├── refreshGate.test.ts                    (新增)
│   ├── objectPool.test.ts                     (新增)
│   ├── positionCache.test.ts                  (新增)
│   ├── tradingTime.test.ts                    (新增)
│   └── signalConfigParser.test.ts             (新增)
├── services/
│   ├── indicators/
│   │   ├── rsi.test.ts                        (新增)
│   │   ├── kdj.test.ts                        (新增)
│   │   ├── macd.test.ts                       (新增)
│   │   ├── mfi.test.ts                        (新增)
│   │   ├── ema.test.ts                        (新增)
│   │   ├── psy.test.ts                        (新增)
│   │   └── buildIndicatorSnapshot.test.ts     (新增)
│   ├── autoSymbolFinder/
│   │   └── autoSymbolFinder.test.ts           (新增)
│   ├── autoSymbolManager/
│   │   ├── signalBuilder.test.ts              (新增)
│   │   └── thresholdResolver.test.ts          (新增)
│   └── liquidationCooldown/
│       ├── liquidationCooldown.test.ts        (新增)
│       └── tradeLogHydrator.test.ts           (新增)
├── core/
│   ├── strategy/
│   │   ├── signalGeneration.test.ts           (新增)
│   │   └── signalRouting.test.ts              (新增)
│   ├── orderRecorder/
│   │   ├── orderFilteringEngine.test.ts       (新增)
│   │   ├── sellDeductionPolicy.test.ts        (新增)
│   │   ├── orderOwnershipParser.test.ts       (新增)
│   │   ├── costAveragePrice.test.ts           (已有)
│   │   ├── getSellableOrders.test.ts          (已有)
│   │   └── integration.test.ts                (已有)
│   ├── signalProcessor/
│   │   ├── sellSignalProcessing.test.ts       (新增)
│   │   ├── riskCheckPipeline.test.ts          (新增)
│   │   └── resolveSellQuantityBySmartClose.test.ts (已有)
│   ├── riskController/
│   │   ├── unrealizedLossMonitor.test.ts      (新增)
│   │   ├── warrantRiskChecker.test.ts         (新增)
│   │   ├── dailyLossTracker.test.ts           (新增)
│   │   ├── positionLimitChecker.test.ts       (新增)
│   │   └── unrealizedLossChecker.test.ts      (新增)
│   ├── doomsdayProtection/
│   │   └── doomsdayProtection.test.ts         (新增)
│   └── trader/
│       ├── orderExecutor.test.ts              (新增)
│       ├── rateLimiter.test.ts                (新增)
│       ├── orderRecovery.test.ts              (新增)
│       ├── orderHoldRegistry.test.ts          (新增)
│       ├── accountService.test.ts             (新增)
│       ├── orderCacheManager.test.ts          (新增)
│       └── tradeLogger.test.ts                (新增)
├── main/
│   ├── asyncProgram/
│   │   ├── delayedSignalVerifier/
│   │   │   ├── delayedSignalVerifier.test.ts  (新增)
│   │   │   └── indicatorCache.test.ts         (新增)
│   │   ├── processors/
│   │   │   ├── buyProcessor.test.ts           (新增)
│   │   │   └── sellProcessor.test.ts          (新增)
│   │   ├── orderMonitor/
│   │   │   ├── orderMonitorWorker.test.ts     (新增)
│   │   │   └── orderEventHandler.test.ts      (新增)
│   │   ├── tradeTaskQueue.test.ts             (新增)
│   │   ├── monitorTaskQueue.test.ts           (新增)
│   │   ├── monitorTaskProcessor.test.ts       (新增)
│   │   └── postTradeRefresher.test.ts         (新增)
│   ├── processMonitor/
│   │   └── signalPipeline.test.ts             (新增)
│   ├── startup/
│   │   ├── startupGate.test.ts                (新增)
│   │   └── startupSeat.test.ts                (新增)
│   └── lifecycle/                              (已有)
│       └── ...
├── services/
│   └── autoSymbol/
│       ├── seatStateManager.test.ts           (新增)
│       ├── autoSearch.test.ts                 (新增)
│       └── switchStateMachine.test.ts         (新增)
└── integration/
    ├── buyFlow.integration.test.ts            (新增)
    ├── sellFlow.integration.test.ts           (新增)
    ├── protectiveLiquidation.integration.test.ts (新增)
    ├── doomsdayProtection.integration.test.ts (新增)
    ├── autoSwitch.integration.test.ts         (新增)
    ├── lifecycle.integration.test.ts          (新增)
    ├── multiMonitor.integration.test.ts       (新增)
    ├── orderRecord.integration.test.ts        (新增)
    ├── dataConsistency.integration.test.ts    (新增)
    ├── concurrency.integration.test.ts        (新增)
    └── apiFailure.integration.test.ts         (新增)
```

### 4.4 测试运行命令

```bash
# 运行全部测试
bun test

# 运行特定模块
bun test tests/core/riskController/
bun test tests/integration/
bun test tests/services/indicators/

# 运行单个文件
bun test tests/core/strategy/signalGeneration.test.ts
bun test tests/integration/buyFlow.integration.test.ts

# 运行匹配模式的测试
bun test --test-name-pattern "风险检查"
bun test --test-name-pattern "integration"
```

### 4.5 关键约束与注意事项

1. **Mock 隔离**：每个测试文件使用 `mock.module` 隔离 logger，API Mock 通过依赖注入传入

2. **无外部依赖**：所有测试不依赖真实 API，完全使用 Mock 数据

3. **对象池验证**：涉及信号对象的测试需验证对象释放回池（使用 spy 或计数器）

4. **时间可控**：所有时间相关测试使用 Mock Timer，不依赖真实时间

5. **席位版本校验**：涉及异步处理的测试需验证版本号校验逻辑

6. **方向独立性**：做多/做空测试需验证互不影响

7. **数据一致性**：交易后需验证订单记录、浮亏数据、账户缓存的一致性更新

8. **并发安全**：多监控标的、异步处理器的测试需验证无竞态条件

9. **错误隔离**：API 失败测试需验证错误不传播到其他模块

10. **刷新门禁**：涉及数据刷新的测试需验证门禁机制正确阻塞和唤醒

11. **源码位置注意**：
    - `riskCheckPipeline` 源码在 `src/core/signalProcessor/`，测试在 `tests/core/signalProcessor/`
    - `signalRouting` 实际逻辑在 `src/main/processMonitor/signalPipeline.ts`

12. **测试数据构造**：优先使用 Mock 工厂函数构造测试数据，确保数据结构一致性

---

## 五、测试覆盖率目标

### 5.1 代码覆盖率目标

| 模块 | 行覆盖率 | 分支覆盖率 | 函数覆盖率 |
|------|---------|-----------|-----------|
| 核心业务逻辑 | ≥90% | ≥85% | ≥90% |
| 风险管控 | ≥95% | ≥90% | ≥95% |
| 订单管理 | ≥90% | ≥85% | ≥90% |
| 自动寻标/换标 | ≥85% | ≥80% | ≥85% |
| 工具函数 | ≥80% | ≥75% | ≥80% |
| 集成测试 | 端到端流程完整性 | 关键路径全覆盖 | 异常场景覆盖 |

### 5.2 业务规则覆盖率

- ✅ 信号生成规则：100%（所有条件组合、阈值边界）
- ✅ 订单过滤算法：100%（所有排序规则、消除策略）
- ✅ 风险检查流水线：100%（6项检查、所有拒绝场景）
- ✅ 智能平仓逻辑：100%（整体盈亏判断、部分平仓）
- ✅ 延迟验证机制：100%（T0/T1/T2、所有指标）
- ✅ 浮亏监控：100%（R1/N1计算、偏移机制）
- ✅ 自动寻标/换标：100%（筛选规则、状态机、失败冻结）
- ✅ 末日保护：100%（拒买、撤单、清仓时段）
- ✅ 生命周期管理：100%（午夜清理、开盘重建、失败重试）

### 5.3 边界条件覆盖

- ✅ 数值边界：0、负数、极大值、极小值
- ✅ 时间边界：开盘、收盘、午休、跨日
- ✅ 状态边界：空持仓、满仓、首次买入、最后卖出
- ✅ 并发边界：多信号同时、多订单同时、资源竞争
- ✅ 异常边界：API失败、数据缺失、格式错误、超时

---

## 六、方案完整性验证总结

### 7.1 与源码的完整对照

经过详细的代码库探索和业务逻辑知识库交叉验证，本方案已覆盖：

**✅ 已覆盖的核心模块（156个源文件）**：
- 所有技术指标计算（RSI/KDJ/MACD/MFI/EMA/PSY）
- 完整的信号生成与分流逻辑
- 订单过滤引擎的所有算法
- 风险检查流水线的6项检查
- 浮亏监控的完整计算链路
- 自动寻标/换标的完整状态机
- 订单管理的所有子模块（执行器/缓存/保留集/账户服务/交易记录）
- 延迟验证的T0/T1/T2机制
- 末日保护的完整流程
- 生命周期管理的午夜清理和开盘重建
- 配置验证器的所有检查项
- 信号流水线的席位校验和队列分发

**✅ 已覆盖的关键业务规则**：
- 信号条件的多组任选、组内部分满足
- 订单过滤的低价优先整笔消除、时间间隔订单
- 智能平仓的整体盈亏判断、部分平仓
- 风险检查的数据源策略（买入实时、卖出缓存）
- 浮亏监控的已实现盈亏偏移机制
- 自动寻标的失败冻结、日内抑制
- 换标的预寻标、撤单范围、移仓回补
- 延迟验证的趋势持续性判断
- 席位版本号的信号阻断机制
- 对象池的获取释放生命周期

**✅ 已覆盖的边界场景**：
- API 批量获取失败时所有买入信号被拒
- 频率检查通过后预占时间槽
- 冷却期内所有信号被拦截时短路优化
- 行情未就绪与席位为空的区别处理
- 轮证列表缓存的TTL和请求去重
- 并发寻标、并发验证、并发改价
- 数据刷新的门禁同步机制
- 跨日清理的缓存域顺序

### 7.2 测试规模统计

| 类型 | 数量 | 说明 |
|------|------|------|
| Mock 基础设施文件 | 6 | API Mock + 4个数据工厂 |
| 单元测试文件 | 55 | 覆盖所有核心模块 |
| 集成测试文件 | 11 | 端到端业务流程 |
| 测试用例总数 | ~690 | 详细的业务场景验证 |
| 源码文件覆盖率 | 100% | 156个源文件全部覆盖 |

### 7.3 方案优势

1. **系统性**：按模块分层，从单元到集成，逐层验证
2. **完整性**：覆盖所有源码模块，无遗漏
3. **业务导向**：每个用例都关联业务规则引用
4. **可执行性**：明确的子代理分工和执行顺序
5. **可维护性**：清晰的目录结构和命名规范
6. **边界覆盖**：充分考虑边界条件和异常场景
7. **并发安全**：验证多监控标的和异步处理的并发安全性
8. **数据一致性**：验证交易后的数据刷新和一致性

### 7.4 实施建议

**阶段1：Mock基础设施（1-2天）**
- 优先实现 LongPort API Mock（可编程响应、调用记录、错误注入）
- 实现4个数据工厂（quote/trade/signal/config）
- 实现 Mock Logger 和 Mock Timer

**阶段2：核心模块单元测试（并行，5-7天）**
- Agent-2~Agent-13 并行执行
- 优先级：风险管控 > 订单管理 > 信号生成 > 其他
- 每个 Agent 独立完成后立即提交，不等待其他 Agent

**阶段3：集成测试（3-4天）**
- 依赖所有单元测试完成
- 优先实现关键路径：买入全链路、卖出全链路
- 再实现异常场景：API失败、并发安全、数据一致性

**阶段4：覆盖率验证与补充（1-2天）**
- 运行覆盖率工具
- 补充遗漏的边界条件
- 修复失败的测试用例

**总计：10-15天完成全部测试**

### 7.5 质量保证

1. **代码审查**：每个测试文件完成后进行代码审查
2. **持续集成**：集成到 CI/CD 流程，每次提交自动运行
3. **覆盖率监控**：设置覆盖率门槛，低于目标值时阻止合并
4. **定期维护**：业务逻辑变更时同步更新测试用例
5. **文档同步**：测试用例作为业务逻辑的可执行文档

---

## 七、附录

### 8.1 关键术语对照表

| 中文术语 | 英文术语 | 说明 |
|---------|---------|------|
| 监控标的 | Monitor Symbol | 生成信号的标的（如恒指） |
| 交易标的 | Trading Symbol | 执行交易的标的（牛熊证） |
| 席位 | Seat | 每个方向的当前交易标的槽位 |
| 席位版本号 | Seat Version | 换标时递增，用于阻断旧信号 |
| 成本均价 | Cost Average Price | 加权平均买入价（智能平仓用） |
| 开仓成本 R1 | Opening Cost R1 | 成本总和（浮亏监控用） |
| 持仓量 N1 | Position Quantity N1 | 未平仓订单总量 |
| 浮亏 | Unrealized Loss | R2 - R1 |
| 智能平仓 | Smart Close | 仅卖盈利部分 |
| 保护性清仓 | Protective Liquidation | 浮亏超限紧急清仓 |
| 末日保护 | Doomsday Protection | 收盘前自动保护 |
| 延迟验证 | Delayed Verification | T0/T1/T2趋势验证 |
| 风险检查冷却 | Risk Check Cooldown | 10秒内同标的同动作限流 |
| 清仓冷却 | Liquidation Cooldown | 保护性清仓后买入禁止期 |
| 行情未就绪 | Quote Not Ready | 席位已占但无首个行情 |
| 日内抑制 | Intraday Suppression | 同标的候选当日停止换标 |
| 刷新门禁 | Refresh Gate | 确保异步处理器等待刷新完成 |

### 8.2 测试数据示例

详见各 Mock 工厂函数的实现，提供标准化的测试数据构造。

### 8.3 常见问题

**Q: 为什么 riskCheckPipeline 测试放在 signalProcessor/ 而不是 riskController/?**
A: 因为源码位于 `src/core/signalProcessor/riskCheckPipeline.ts`，测试文件应与源码目录对应。

**Q: 如何验证对象池的正确释放？**
A: 使用 spy 监控 `signalObjectPool.release()` 调用，或在测试前后对比对象池大小。

**Q: 如何模拟时间推进？**
A: 使用 Mock Timer 的 `advance(ms)` 方法，不依赖真实时间流逝。

**Q: 如何测试并发场景？**
A: 使用 `Promise.all()` 同时触发多个操作，验证结果的独立性和数据一致性。

**Q: 如何验证 API 调用次数？**
A: Mock API 记录所有调用，测试结束后断言调用次数和参数。

---

## 结语

本测试方案经过系统性分析，覆盖了港股量化交易系统的所有核心业务逻辑和边界场景。通过 **690+ 测试用例**、**66 个测试文件**、**14 个子代理并行执行**，确保系统行为完全符合业务规则。

方案特点：
- ✅ **完整性**：100% 源码覆盖，无遗漏模块
- ✅ **系统性**：分层测试，从单元到集成
- ✅ **可执行性**：明确分工，清晰顺序
- ✅ **业务导向**：每个用例关联业务规则
- ✅ **质量保证**：覆盖率目标，持续集成

建议按照执行计划分阶段实施，预计 **10-15 天**完成全部测试开发。

| 子代理 | 负责模块 | 文件数 | 依赖 |
|--------|---------|--------|------|
| Agent-1: Mock 基础设施 | mock/ 全部文件 | 6 | 无 |
| Agent-2: 技术指标 | tests/services/indicators/ | 7 | Agent-1 |
| Agent-3: 信号生成+分流 | tests/core/strategy/ | 2 | Agent-1 |
| Agent-4: 订单过滤+卖出策略 | tests/core/orderRecorder/ + tests/core/signalProcessor/ | 3 | Agent-1 |
| Agent-5: 风险管控 | tests/core/riskController/ | 3 | Agent-1 |
| Agent-6: 延迟验证+处理器 | tests/main/asyncProgram/ | 4 | Agent-1 |
| Agent-7: 末日保护+订单监控 | tests/core/doomsdayProtection/ + tests/main/asyncProgram/orderMonitor/ | 3 | Agent-1 |
| Agent-8: 自动寻标/换标 | tests/services/autoSymbol/ | 3 | Agent-1 |
| Agent-9: 订单管理 | tests/core/trader/ | 3 | Agent-1 |
| Agent-10: 全链路集成 | tests/integration/ | 8 | Agent-1~9 |

### 4.2 执行顺序

```
Phase 1: Agent-1（Mock 基础设施）
    ↓
Phase 2: Agent-2 ~ Agent-9（并行执行，均依赖 Agent-1）
    ↓
Phase 3: Agent-10（全链路集成测试，依赖所有前置）
```

### 4.3 目录结构预览

```
mock/
├── longportMock.ts              # LongPort API Mock
├── mockLogger.ts                # 静默 Logger
├── mockTimer.ts                 # 可控时间
└── factories/
    ├── quoteFactory.ts          # 行情数据工厂
    ├── tradeFactory.ts          # 交易数据工厂
    ├── signalFactory.ts         # 信号数据工厂
    └── configFactory.ts         # 配置数据工厂

tests/
├── services/
│   └── indicators/
│       ├── rsi.test.ts
│       ├── kdj.test.ts
│       ├── macd.test.ts
│       ├── mfi.test.ts
│       ├── ema.test.ts
│       ├── psy.test.ts
│       └── buildIndicatorSnapshot.test.ts
├── core/
│   ├── strategy/
│   │   ├── signalGeneration.test.ts
│   │   └── signalRouting.test.ts
│   ├── orderRecorder/
│   │   ├── orderFilteringEngine.test.ts
│   │   ├── sellDeductionPolicy.test.ts
│   │   ├── costAveragePrice.test.ts      (已有)
│   │   ├── getSellableOrders.test.ts      (已有)
│   │   └── integration.test.ts            (已有)
│   ├── signalProcessor/
│   │   ├── sellSignalProcessing.test.ts
│   │   └── resolveSellQuantityBySmartClose.test.ts (已有)
│   ├── riskController/
│   │   ├── riskCheckPipeline.test.ts
│   │   ├── unrealizedLossMonitor.test.ts
│   │   └── warrantRiskChecker.test.ts
│   ├── doomsdayProtection/
│   │   └── doomsdayProtection.test.ts
│   └── trader/
│       ├── orderExecutor.test.ts
│       ├── rateLimiter.test.ts
│       └── orderRecovery.test.ts
├── main/
│   ├── asyncProgram/
│   │   ├── delayedSignalVerifier/
│   │   │   ├── delayedSignalVerifier.test.ts
│   │   │   └── indicatorCache.test.ts
│   │   ├── processors/
│   │   │   ├── buyProcessor.test.ts
│   │   │   └── sellProcessor.test.ts
│   │   └── orderMonitor/
│   │       ├── orderMonitorWorker.test.ts
│   │       └── orderEventHandler.test.ts
│   └── lifecycle/                          (已有)
│       └── ...
└── integration/
    ├── buyFlow.integration.test.ts
    ├── sellFlow.integration.test.ts
    ├── protectiveLiquidation.integration.test.ts
    ├── doomsdayProtection.integration.test.ts
    ├── autoSwitch.integration.test.ts
    ├── lifecycle.integration.test.ts
    ├── multiMonitor.integration.test.ts
    └── orderRecord.integration.test.ts
```

### 4.4 测试运行命令

```bash
# 运行全部测试
bun test

# 运行特定模块
bun test tests/core/riskController/
bun test tests/integration/

# 运行单个文件
bun test tests/core/strategy/signalGeneration.test.ts
```

### 4.5 关键约束

1. **Mock 隔离**：每个测试文件使用 `mock.module` 隔离 logger，API Mock 通过依赖注入传入
2. **无外部依赖**：所有测试不依赖真实 API，完全使用 Mock 数据
3. **对象池验证**：涉及信号对象的测试需验证对象释放回池
4. **时间可控**：所有时间相关测试使用 Mock Timer，不依赖真实时间
6. **方向独立**：做多/做空测试需验证互不影响
7. **数据一致性**：交易后需验证订单记录、浮亏数据、账户缓存的一致性更新
8. **并发安全**：多监控标的、异步处理器的测试需验证无竞态条件
9. **错误隔离**：API 失败测试需验证错误不传播到其他模块
10. **刷新门禁**：涉及数据刷新的测试需验证门禁机制正确阻塞和唤醒
11. **源码位置注意**：
    - `riskCheckPipeline` 源码在 `src/core/signalProcessor/`，测试在 `tests/core/signalProcessor/`
    - `signalRouting` 实际逻辑在 `src/main/processMonitor/signalPipeline.ts`
12. **测试数据构造**：优先使用 Mock 工厂函数构造测试数据，确保数据结构一致性

---

