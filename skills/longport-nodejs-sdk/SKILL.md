# LongPort OpenAPI SDK for Node.js

NPM 包名：`longport`

```
bun install longport
```

LongPort OpenAPI 为具有研发能力的投资者提供程序化行情交易接口，帮助基于自身投资策略构建交易或行情策略分析工具。

**功能分类：**
- **Trading（交易）** - 创建、修改、取消订单，查询今日/历史订单和成交明细
- **Quotes（行情）** - 实时行情、历史行情获取
- **Portfolio（投资组合）** - 实时查询账户资产、持仓、资金
- **Real-time subscription（实时订阅）** - 实时行情推送和订单状态变更推送

---

## SDK 参考文档

### 配置

- [Config 类、环境变量、ConfigParams](./reference/config.md)

### 核心上下文

- [QuoteContext - 行情上下文](./reference/quote-context.md) — 订阅/报价/盘口/K线/期权/轮证/交易日/资金流/指标/自选股/实时数据
- [TradeContext - 交易上下文](./reference/trade-context.md) — 提交/撤单/改单/订单查询/成交查询/资产查询

### 工具类

- [Decimal 类与日期类型](./reference/decimal.md) — 高精度数值运算、NaiveDate、NaiveDatetime

### 枚举

- [全部枚举类型定义](./reference/enums.md) — SubType, OrderType, OrderSide, OrderStatus, Market, Period 等 32 个枚举

### 数据类型（返回结果）

- [行情数据类型与推送事件](./reference/types/quote-types.md) — SecurityQuote, Candlestick, Trade, SecurityDepth, PushQuoteEvent 等
- [交易数据类型](./reference/types/trade-types.md) — Order, Execution, AccountBalance, StockPosition, PushOrderChanged 等

---

## 频率限制

| 类型 | 限制 |
|------|------|
| 行情 API | 单账户最多 1 条长连接，最多同时订阅 500 个标的；1 秒内不超过 10 次调用，并发请求不超过 5 |
| 交易 API | 30 秒内不超过 30 次调用，两次调用间隔不小于 0.02 秒 |

**SDK 内置频率控制：**
- **行情**：`QuoteContext` 下的方法由 SDK 自动控制频率，超速时自动延迟
- **交易**：`TradeContext` 下的方法不由 SDK 限制，需用户自行控制

---

## 行情覆盖范围

| 市场 | 标的 |
|------|------|
| 港股 | 股票、ETF、轮证、牛熊证、恒生指数 |
| 美股 | 股票、ETF、纳斯达克指数、OPRA 期权 |
| A 股 | 股票、ETF、指数 |

**交易支持：**

| 市场 | 股票/ETF | 轮证/牛熊证 | 期权 |
|------|---------|------------|------|
| 港股 | ✓ | ✓ | - |
| 美股 | ✓ | ✓ | ✓ |

---

## 代码示例

### 获取证券报价

```typescript
import { Config, QuoteContext } from "longport";

const config = Config.fromEnv();
const ctx = await QuoteContext.new(config);
const quotes = await ctx.quote(["700.HK", "AAPL.US"]);
for (const q of quotes) {
  console.log(`${q.symbol}: ${q.lastDone.toString()}`);
}
```

### 订阅实时行情

```typescript
import { Config, QuoteContext, SubType } from "longport";

const config = Config.fromEnv();
const ctx = await QuoteContext.new(config);

ctx.setOnQuote((_, event) => {
  console.log(`${event.symbol}: ${event.data.lastDone.toString()}`);
});

await ctx.subscribe(["700.HK", "AAPL.US"], [SubType.Quote]);
```

### 提交限价买单

```typescript
import {
  Config, TradeContext, Decimal,
  OrderSide, TimeInForceType, OrderType,
} from "longport";

const config = Config.fromEnv();
const ctx = await TradeContext.new(config);
const resp = await ctx.submitOrder({
  symbol: "700.HK",
  orderType: OrderType.LO,
  side: OrderSide.Buy,
  timeInForce: TimeInForceType.Day,
  submittedPrice: new Decimal("300"),
  submittedQuantity: new Decimal("200"),
});
console.log(`Order ID: ${resp.orderId}`);
```

### 监听订单状态变更

```typescript
import { Config, TradeContext, TopicType } from "longport";

const config = Config.fromEnv();
const ctx = await TradeContext.new(config);

ctx.setOnOrderChanged((_, event) => {
  console.log(`Order ${event.orderId}: ${event.status}`);
});

await ctx.subscribe([TopicType.Private]);
```

### 查询股票持仓

```typescript
import { Config, TradeContext } from "longport";

const config = Config.fromEnv();
const ctx = await TradeContext.new(config);
const resp = await ctx.stockPositions();
for (const channel of resp.channels) {
  for (const pos of channel.positions) {
    console.log(`${pos.symbol}: qty=${pos.quantity.toString()}, available=${pos.availableQuantity.toString()}`);
  }
}
```

### 获取 K 线数据

```typescript
import { Config, QuoteContext, Period, AdjustType, TradeSessions } from "longport";

const config = Config.fromEnv();
const ctx = await QuoteContext.new(config);
const candles = await ctx.candlesticks("700.HK", Period.Day, 10, AdjustType.NoAdjust, TradeSessions.Intraday);
for (const c of candles) {
  console.log(`${c.timestamp}: O=${c.open} H=${c.high} L=${c.low} C=${c.close} V=${c.volume}`);
}
```

### 筛选轮证

```typescript
import { Config, QuoteContext, WarrantSortBy, SortOrderType, WarrantType } from "longport";

const config = Config.fromEnv();
const ctx = await QuoteContext.new(config);
const warrants = await ctx.warrantList(
  "700.HK",
  WarrantSortBy.LastDone,
  SortOrderType.Descending,
  [WarrantType.Bull, WarrantType.Bear],
);
for (const w of warrants) {
  console.log(`${w.symbol} ${w.name}: ${w.lastDone} callPrice=${w.callPrice}`);
}
```

### 查询今日订单

```typescript
import { Config, TradeContext, OrderStatus, Market } from "longport";

const config = Config.fromEnv();
const ctx = await TradeContext.new(config);
const orders = await ctx.todayOrders({
  market: Market.HK,
  status: [OrderStatus.Filled, OrderStatus.New, OrderStatus.PartialFilled],
});
for (const o of orders) {
  console.log(`${o.orderId}: ${o.symbol} ${o.side} ${o.status} qty=${o.quantity} filled=${o.executedQuantity}`);
}
```

### 撤销订单

```typescript
import { Config, TradeContext } from "longport";

const config = Config.fromEnv();
const ctx = await TradeContext.new(config);
await ctx.cancelOrder("709043056541253632");
```

### 获取账户余额

```typescript
import { Config, TradeContext } from "longport";

const config = Config.fromEnv();
const ctx = await TradeContext.new(config);
const balances = await ctx.accountBalance();
for (const b of balances) {
  console.log(`${b.currency}: cash=${b.totalCash} netAssets=${b.netAssets} buyPower=${b.buyPower}`);
}
```

---

## 导入参考

SDK 所有可导入的类型完整列表：

```typescript
import {
  // 核心类
  Config, QuoteContext, TradeContext, Decimal, NaiveDate, NaiveDatetime,

  // 枚举
  SubType, OrderType, OrderSide, OrderStatus, TimeInForceType,
  Market, Period, AdjustType, TopicType, TradeSessions, TradeSession,
  TradeDirection, TradeStatus, OutsideRTH, Language, PushCandlestickMode,
  WarrantType, WarrantSortBy, SortOrderType, WarrantStatus,
  FilterWarrantExpiryDate, FilterWarrantInOutBoundsType,
  SecurityListCategory, OrderTag, TriggerStatus, BalanceType,
  CashFlowDirection, DerivativeType, SecurityBoard,
  CommissionFreeStatus, DeductionStatus, CalcIndex,

  // 行情数据类
  SecurityQuote, SecurityStaticInfo, OptionQuote, WarrantQuote,
  SecurityDepth, Depth, SecurityBrokers, Brokers,
  ParticipantInfo, Trade, IntradayLine, Candlestick,
  StrikePriceInfo, IssuerInfo, WarrantInfo,
  MarketTradingSession, TradingSessionInfo, MarketTradingDays,
  CapitalFlowLine, CapitalDistribution, CapitalDistributionResponse,
  SecurityCalcIndex, WatchlistGroup, Security,
  Subscription, RealtimeQuote, PrePostQuote,
  MarketTemperature, HistoryMarketTemperatureResponse,
  QuotePackageDetail,

  // 推送事件类
  PushQuoteEvent, PushQuote,
  PushDepthEvent, PushDepth,
  PushBrokersEvent, PushBrokers,
  PushTradesEvent, PushTrades,
  PushCandlestickEvent, PushCandlestick,
  PushOrderChanged,

  // 交易数据类
  Order, OrderDetail, OrderHistoryDetail, OrderChargeDetail,
  Execution, SubmitOrderResponse,
  AccountBalance, CashInfo, FrozenTransactionFee,
  CashFlow,
  StockPositionsResponse, StockPositionChannel, StockPosition,
  FundPositionsResponse, FundPositionChannel, FundPosition,
  MarginRatio,
  EstimateMaxPurchaseQuantityResponse,

  // 请求参数接口
  SubmitOrderOptions, ReplaceOrderOptions,
  GetTodayOrdersOptions, GetHistoryOrdersOptions,
  GetTodayExecutionsOptions, GetHistoryExecutionsOptions,
  GetCashFlowOptions, EstimateMaxPurchaseQuantityOptions,
  CreateWatchlistGroup, DeleteWatchlistGroup, UpdateWatchlistGroup,
  ConfigParams,
} from "longport";
```
