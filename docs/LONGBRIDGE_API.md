# LongBridge OpenAPI 参考文档

本文档提供 LongBridge OpenAPI 的完整参考指南，包括 Node.js SDK 的使用方法、最佳实践和注意事项。

## 目录

- [1. API 认证和初始化](#1-api-认证和初始化)
- [2. 行情接口 (Quote)](#2-行情接口-quote)
- [3. 交易接口 (Trade)](#3-交易接口-trade)
- [4. 账户接口 (Account)](#4-账户接口-account)
- [5. 订单管理 (Orders)](#5-订单管理-orders)
- [6. 持仓管理 (Positions)](#6-持仓管理-positions)
- [7. 最佳实践](#7-最佳实践)
- [8. 常见问题](#8-常见问题)

---

## 1. API 认证和初始化

### 1.1 环境变量配置

LongBridge API 需要以下认证信息：

```bash
# LongBridge API 认证信息
LONGBRIDGE_APP_KEY=your_app_key
LONGBRIDGE_APP_SECRET=your_app_secret
LONGBRIDGE_ACCESS_TOKEN=your_access_token
```

### 1.2 初始化 Config

```javascript
import { Config } from "longport";

const config = Config.fromEnv();
```

**Config 参数说明**：
- `app_key`: 应用标识符
- `app_secret`: 应用密钥
- `access_token`: 访问令牌
- `http_url`: HTTP API 地址（可选）
- `quote_ws_url`: 行情 WebSocket 地址（可选）
- `trade_ws_url`: 交易 WebSocket 地址（可选）

### 1.3 创建上下文对象

LongBridge SDK 提供三种上下文：

```javascript
import { QuoteContext, TradeContext, Config } from "longport";

const config = Config.fromEnv();

// 行情上下文（实时行情、K线、技术指标等）
const quoteCtx = await QuoteContext.new(config);

// 交易上下文（下单、撤单、查询订单等）
const tradeCtx = await TradeContext.new(config);
```

---

## 2. 行情接口 (Quote)

### 2.1 订阅实时行情

```javascript
// 订阅标的实时行情
await quoteCtx.subscribe(
  ["800000.HK", "09988.HK"], // 标的列表
  [SubType.Quote],            // 订阅类型
  true                        // 是否首次推送
);

// 监听实时行情推送
quoteCtx.setOnQuote((symbol, event) => {
  console.log(`${symbol} 最新价: ${event.lastDone}`);
  console.log(`买一价: ${event.bidList[0]?.price}`);
  console.log(`卖一价: ${event.askList[0]?.price}`);
});
```

**订阅类型 (SubType)**：
- `SubType.Quote`: 实时行情（最新价、买卖盘等）
- `SubType.Depth`: 深度行情
- `SubType.Brokers`: 经纪队列
- `SubType.Trade`: 逐笔成交

**Quote 对象字段**：
- `lastDone`: 最新价
- `open`: 开盘价
- `high`: 最高价
- `low`: 最低价
- `timestamp`: 时间戳（秒）
- `volume`: 成交量
- `turnover`: 成交额
- `bidList`: 买盘列表 `[{position, price, volume, orderNum}]`
- `askList`: 卖盘列表 `[{position, price, volume, orderNum}]`

### 2.2 获取静态行情数据

```javascript
// 获取标的静态信息
const staticInfo = await quoteCtx.staticInfo(["800000.HK", "09988.HK"]);

// 获取实时行情快照
const realtimeQuotes = await quoteCtx.quote(["800000.HK", "09988.HK"]);
```

**StaticInfo 字段**：
- `symbol`: 标的代码
- `nameCn`: 中文名称
- `nameEn`: 英文名称
- `nameHk`: 繁体中文名称
- `lotSize`: 每手股数（最小买卖单位）
- `totalShares`: 总股本
- `board`: 板块

### 2.3 获取 K 线数据

```javascript
import { Period, AdjustType } from "longport";

// 获取历史 K 线数据
const candles = await quoteCtx.candlesticks(
  "800000.HK",        // 标的代码
  Period.Day,         // K线周期
  10,                 // 数量
  AdjustType.NoAdjust // 复权类型
);

// 返回数组，每个元素包含：
// {
//   close: Decimal,   // 收盘价
//   open: Decimal,    // 开盘价
//   low: Decimal,     // 最低价
//   high: Decimal,    // 最高价
//   volume: bigint,   // 成交量
//   turnover: Decimal,// 成交额
//   timestamp: bigint // 时间戳
// }
```

**K线周期 (Period)**：
- `Period.Min_1`: 1分钟
- `Period.Min_5`: 5分钟
- `Period.Min_15`: 15分钟
- `Period.Min_30`: 30分钟
- `Period.Min_60`: 60分钟
- `Period.Day`: 日线
- `Period.Week`: 周线
- `Period.Month`: 月线
- `Period.Year`: 年线

**复权类型 (AdjustType)**：
- `AdjustType.NoAdjust`: 不复权
- `AdjustType.ForwardAdjust`: 前复权

### 2.4 获取牛熊证信息

```javascript
// 获取认购认沽牛熊证信息
const warrantQuote = await quoteCtx.warrantQuote(["66700.HK"]);

// 返回对象包含：
// {
//   symbol: string,
//   lastDone: Decimal,      // 最新价
//   changeRate: Decimal,    // 涨跌幅
//   changeVal: Decimal,     // 涨跌额
//   volume: bigint,         // 成交量
//   turnover: Decimal,      // 成交额
//   expiryDate: string,     // 到期日 "YYYY-MM-DD"
//   strikePrice: Decimal,   // 行权价
//   callPrice: Decimal,     // 收回价（牛熊证）
//   category: string,       // 类别：Bull（牛证）/ Bear（熊证）
//   underlyingSymbol: string // 标的代码
// }
```

**牛熊证风险检查关键字段**：
- `callPrice`: 收回价（强制回收价格）
- `category`: "Bull"（牛证）或 "Bear"（熊证）
- 距回收价百分比 = `(lastDone - callPrice) / callPrice * 100`

---

## 3. 交易接口 (Trade)

### 3.1 提交订单

```javascript
import { OrderSide, OrderType, TimeInForceType, Decimal } from "longport";

// 提交买入订单
const response = await tradeCtx.submitOrder({
  symbol: "700.HK",                        // 标的代码
  orderType: OrderType.ELO,                // 订单类型：增强限价单
  side: OrderSide.Buy,                     // 买卖方向：买入
  submittedQuantity: new Decimal(200),     // 数量（股）
  timeInForce: TimeInForceType.Day,        // 有效期：当日有效
  submittedPrice: new Decimal(350.5),      // 价格
  remark: "AutoTrade"                      // 备注（可选）
});

const orderId = response.orderId;
console.log(`订单提交成功，订单ID: ${orderId}`);
```

**订单类型 (OrderType)**：
- `OrderType.LO`: 限价单（Limit Order）
- `OrderType.ELO`: 增强限价单（Enhanced Limit Order）- 港股常用
- `OrderType.MO`: 市价单（Market Order）
- `OrderType.AO`: 竞价单（Auction Order）
- `OrderType.ALO`: 竞价限价单（Auction Limit Order）
- `OrderType.SLO`: 特别限价单（Special Limit Order）

**买卖方向 (OrderSide)**：
- `OrderSide.Buy`: 买入
- `OrderSide.Sell`: 卖出

**有效期类型 (TimeInForceType)**：
- `TimeInForceType.Day`: 当日有效
- `TimeInForceType.GoodTilCanceled`: 撤单前有效
- `TimeInForceType.GoodTilDate`: 指定日期前有效

### 3.2 修改订单

```javascript
// 修改订单价格和数量
await tradeCtx.replaceOrder({
  orderId: "708203190075854848",          // 订单ID
  submittedQuantity: new Decimal(100),    // 新数量
  submittedPrice: new Decimal(351.0)      // 新价格
});
```

**注意事项**：
- 只能修改未完全成交的订单
- 已部分成交的订单，只能修改剩余未成交部分
- 修改后订单ID不变，但可能产生新的订单记录

### 3.3 撤销订单

```javascript
// 撤销订单
await tradeCtx.cancelOrder("708203190075854848");
```

### 3.4 市价单使用场景

市价单（MO）不需要指定价格，以当前市场最优价格立即成交：

```javascript
// 紧急平仓场景（避难程序）
const response = await tradeCtx.submitOrder({
  symbol: "700.HK",
  orderType: OrderType.MO,              // 市价单
  side: OrderSide.Sell,
  submittedQuantity: new Decimal(200),
  timeInForce: TimeInForceType.Day
  // 注意：市价单不需要 submittedPrice 参数
});
```

**市价单适用场景**：
- 保护性清仓（浮亏超过阈值）
- 收盘前强制平仓
- 需要立即成交的紧急情况

---

## 4. 账户接口 (Account)

### 4.1 查询账户余额

```javascript
// 获取账户资金余额
const balances = await tradeCtx.accountBalance();

const primaryBalance = balances[0];
console.log(`币种: ${primaryBalance.currency}`);
console.log(`总现金: ${primaryBalance.totalCash}`);
console.log(`可用现金: ${primaryBalance.availableCash}`);
console.log(`净资产: ${primaryBalance.netAssets}`);
```

**AccountBalance 字段**：
- `currency`: 币种（如 "HKD"）
- `totalCash`: 总现金
- `availableCash`: 可用现金
- `frozenCash`: 冻结现金
- `netAssets`: 净资产
- `maxFinanceAmount`: 最大融资金额
- `withdrawableCash`: 可提现金

### 4.2 计算持仓市值

```javascript
// 从账户余额计算持仓市值
const totalCash = decimalToNumber(primaryBalance.totalCash);
const netAssets = decimalToNumber(primaryBalance.netAssets);
const positionValue = netAssets - totalCash;

console.log(`持仓市值: ${positionValue} HKD`);
```

---

## 5. 订单管理 (Orders)

### 5.1 查询今日订单

```javascript
// 查询所有今日订单
const allOrders = await tradeCtx.todayOrders();

// 查询指定标的的今日订单
const orders = await tradeCtx.todayOrders({ symbol: "700.HK" });

// 查询指定订单ID
const order = await tradeCtx.todayOrders({ orderId: "708203190075854848" });
```

**Order 对象字段**：
- `orderId`: 订单ID
- `symbol`: 标的代码
- `orderType`: 订单类型
- `side`: 买卖方向
- `price`: 委托价格
- `quantity`: 委托数量
- `executedQuantity`: 已成交数量
- `status`: 订单状态
- `submittedAt`: 提交时间
- `updatedAt`: 更新时间
- `triggeredAt`: 触发时间（对于条件单）
- `executedPrice`: 成交均价
- `currency`: 币种
- `remark`: 备注

### 5.2 订单状态

```javascript
import { OrderStatus } from "longport";
```

**OrderStatus 枚举值**：
- `OrderStatus.NotReported`: 待提交
- `OrderStatus.WaitToNew`: 待提交
- `OrderStatus.New`: 已提交（未成交）
- `OrderStatus.PartialFilled`: 部分成交
- `OrderStatus.Filled`: 完全成交
- `OrderStatus.WaitToReplace`: 待修改
- `OrderStatus.PendingReplace`: 修改中
- `OrderStatus.Replaced`: 已修改
- `OrderStatus.PartialWithdrawal`: 部分撤单
- `OrderStatus.WaitToWithdraw`: 待撤单
- `OrderStatus.PendingWithdraw`: 撤单中
- `OrderStatus.Cancelled`: 已撤单
- `OrderStatus.Rejected`: 已拒绝
- `OrderStatus.Expired`: 已过期

### 5.3 过滤未成交订单

```javascript
// 过滤出所有未成交的订单
const pendingStatuses = new Set([
  OrderStatus.New,
  OrderStatus.PartialFilled,
  OrderStatus.WaitToNew,
  OrderStatus.WaitToReplace,
  OrderStatus.PendingReplace
]);

const pendingOrders = allOrders.filter(order =>
  pendingStatuses.has(order.status)
);
```

### 5.4 查询历史订单

```javascript
import { GetHistoryOrdersOptions } from "longport";

// 查询历史订单（最多返回90天内的订单）
const historyOrders = await tradeCtx.historyOrders({
  symbol: "700.HK",                    // 标的代码（可选）
  status: [OrderStatus.Filled],        // 订单状态过滤（可选）
  side: OrderSide.Buy,                 // 买卖方向过滤（可选）
  market: Market.HK,                   // 市场过滤（可选）
  startAt: new Date("2024-01-01"),     // 开始时间（可选）
  endAt: new Date("2024-12-31")        // 结束时间（可选）
});
```

### 5.5 查询今日成交记录

```javascript
// 查询今日成交明细
const executions = await tradeCtx.todayExecutions({ symbol: "700.HK" });

// Execution 对象字段：
// {
//   orderId: string,
//   executionId: string,
//   symbol: string,
//   tradeId: string,
//   tradeDoneAt: Date,        // 成交时间
//   quantity: Decimal,        // 成交数量
//   price: Decimal            // 成交价格
// }
```

---

## 6. 持仓管理 (Positions)

### 6.1 查询持仓

```javascript
// 查询所有持仓
const positionsResp = await tradeCtx.stockPositions();

// 查询指定标的的持仓
const positions = await tradeCtx.stockPositions(["700.HK", "09988.HK"]);
```

**返回结构**：
```javascript
{
  channels: [
    {
      accountChannel: "lb",  // 账户通道
      positions: [
        {
          symbol: "700.HK",
          symbolName: "腾讯控股",
          quantity: Decimal,          // 持仓数量
          availableQuantity: Decimal, // 可用数量（可卖出）
          currency: "HKD",
          costPrice: Decimal,         // 成本价（平摊成本）
          market: Market.HK
        }
      ]
    }
  ]
}
```

**关键字段说明**：
- `quantity`: 总持仓数量（包含不可卖出的部分）
- `availableQuantity`: 可用数量（可立即卖出的数量，T+2 结算后才可用）
- `costPrice`: 平摊成本价（所有买入订单的平均成本）

### 6.2 持仓数据处理

```javascript
// 提取所有持仓
const allPositions = positionsResp.channels.flatMap(channel =>
  (channel.positions ?? []).map(pos => ({
    accountChannel: channel.accountChannel ?? "N/A",
    symbol: pos.symbol,
    symbolName: pos.symbolName,
    quantity: decimalToNumber(pos.quantity),
    availableQuantity: decimalToNumber(pos.availableQuantity),
    costPrice: decimalToNumber(pos.costPrice),
    currency: pos.currency,
    market: pos.market
  }))
);

// 查找特定标的的持仓
const position = allPositions.find(p => p.symbol === "700.HK");
if (position) {
  console.log(`持仓数量: ${position.quantity}`);
  console.log(`可用数量: ${position.availableQuantity}`);
  console.log(`成本价: ${position.costPrice}`);
}
```

---

## 7. 最佳实践

### 7.1 Decimal 类型处理

LongBridge SDK 使用 `Decimal` 类型表示价格和数量，避免浮点数精度问题。

```javascript
import { Decimal } from "longport";

// 创建 Decimal
const price = new Decimal(350.5);
const quantity = new Decimal(100);

// Decimal 转 Number（用于计算和显示）
function decimalToNumber(decimal) {
  if (decimal instanceof Decimal) {
    return Number(decimal.toString());
  }
  return Number(decimal ?? 0);
}

// Number/String 转 Decimal（用于提交订单）
function toDecimal(value) {
  if (value instanceof Decimal) {
    return value;
  }
  if (typeof value === "number" || typeof value === "string") {
    return new Decimal(value);
  }
  return Decimal.ZERO();
}
```

### 7.2 港股代码规范化

港股代码需要添加 `.HK` 后缀：

```javascript
function normalizeHKSymbol(symbol) {
  if (!symbol || typeof symbol !== "string") {
    return symbol;
  }
  const trimmed = symbol.trim().toUpperCase();
  // 如果已经有 .HK 后缀，直接返回
  if (trimmed.endsWith(".HK")) {
    return trimmed;
  }
  // 自动添加 .HK 后缀
  return `${trimmed}.HK`;
}

// 使用示例
const symbol = normalizeHKSymbol("700");    // "700.HK"
const symbol2 = normalizeHKSymbol("09988"); // "09988.HK"
```

### 7.3 错误处理

```javascript
try {
  const response = await tradeCtx.submitOrder({
    symbol: "700.HK",
    orderType: OrderType.ELO,
    side: OrderSide.Buy,
    submittedQuantity: new Decimal(100),
    submittedPrice: new Decimal(350.5),
    timeInForce: TimeInForceType.Day
  });
  console.log(`订单提交成功: ${response.orderId}`);
} catch (error) {
  const errorMessage = error?.message ?? String(error);

  // 检查特定错误类型
  if (errorMessage.includes("does not support short selling")) {
    console.error("该标的不支持做空");
  } else if (errorMessage.includes("insufficient")) {
    console.error("资金不足或持仓不足");
  } else {
    console.error(`订单提交失败: ${errorMessage}`);
  }
}
```

### 7.4 上下文生命周期管理

```javascript
let quoteCtx = null;
let tradeCtx = null;

// 初始化
async function initialize() {
  const config = Config.fromEnv();
  quoteCtx = await QuoteContext.new(config);
  tradeCtx = await TradeContext.new(config);
}

// 清理资源（程序退出时）
async function cleanup() {
  if (quoteCtx) {
    await quoteCtx.close();
    quoteCtx = null;
  }
  if (tradeCtx) {
    await tradeCtx.close();
    tradeCtx = null;
  }
}

// 监听程序退出信号
process.on("SIGINT", async () => {
  console.log("正在关闭连接...");
  await cleanup();
  process.exit(0);
});
```

### 7.5 订单提交前的数量验证

```javascript
// 验证买入数量是否符合最小买卖单位（lotSize）
function validateQuantity(quantity, lotSize) {
  if (!Number.isFinite(quantity) || !Number.isFinite(lotSize)) {
    return false;
  }
  if (lotSize <= 0) {
    return false;
  }
  // 检查数量是否为 lotSize 的整数倍
  return quantity % lotSize === 0 && quantity >= lotSize;
}

// 按 lotSize 向下取整
function roundDownToLotSize(quantity, lotSize) {
  if (!Number.isFinite(quantity) || !Number.isFinite(lotSize) || lotSize <= 0) {
    return 0;
  }
  return Math.floor(quantity / lotSize) * lotSize;
}

// 示例：按目标金额计算买入数量
const targetNotional = 5000; // 目标金额 5000 HKD
const price = 350.5;         // 当前价格
const lotSize = 100;         // 每手 100 股

let rawQuantity = Math.floor(targetNotional / price); // 14 股
let quantity = roundDownToLotSize(rawQuantity, lotSize); // 0 股（不足一手）

// 至少买入一手
if (quantity < lotSize) {
  quantity = lotSize; // 100 股
}

console.log(`实际买入数量: ${quantity} 股 (${quantity / lotSize} 手)`);
```

---

## 8. 常见问题

### 8.1 如何判断是否在交易时段？

港股交易时段：
- 上午盘：09:30 - 12:00
- 下午盘：13:00 - 16:00

```javascript
function isHKTradingTime() {
  const now = new Date();
  const hkTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Hong_Kong" }));
  const hour = hkTime.getHours();
  const minute = hkTime.getMinutes();
  const dayOfWeek = hkTime.getDay();

  // 周末不交易
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return false;
  }

  // 上午盘：09:30 - 12:00
  if (hour === 9 && minute >= 30) return true;
  if (hour >= 10 && hour < 12) return true;

  // 下午盘：13:00 - 16:00
  if (hour >= 13 && hour < 16) return true;

  return false;
}
```

### 8.2 为什么订单提交成功但未成交？

可能原因：
1. **价格问题**：限价单的价格不在当前买卖盘范围内
2. **流动性问题**：标的流动性差，没有对手盘
3. **市场波动**：价格快速变动，委托价格已不在市场价格附近
4. **订单类型**：使用了限价单（LO）而非增强限价单（ELO）

解决方案：
- 使用增强限价单（ELO）提高成交概率
- 紧急情况下使用市价单（MO）确保立即成交
- 实时监控订单状态，必要时修改价格或撤单重下

### 8.3 如何获取标的的最小买卖单位（lotSize）？

```javascript
// 方法1：从静态信息获取
const staticInfo = await quoteCtx.staticInfo(["700.HK"]);
const lotSize = Number(staticInfo[0]?.lotSize ?? 100);

// 方法2：从配置文件读取
// 在 .env 或配置文件中预设常用标的的 lotSize
const LONG_LOT_SIZE = 100;  // 做多标的每手股数
const SHORT_LOT_SIZE = 100; // 做空标的每手股数
```

### 8.4 成本价（costPrice）和开仓成本有什么区别？

- **成本价（costPrice）**：API 返回的平摊成本价，计算公式：
  ```
  costPrice = (所有买入成交额总和 - 所有卖出成交额总和) / 当前持仓数量
  ```

- **开仓成本（R1）**：本系统使用的成本计算方式（基于未平仓订单）：
  ```
  R1 = sum(未平仓买入订单的 price × quantity)
  N1 = sum(未平仓买入订单的 quantity)
  开仓均价 = R1 / N1
  ```

**关键区别**：
- `costPrice` 是 API 提供的平摊成本，包含了所有历史买卖的影响
- `R1` 是基于当前未平仓订单计算的成本，更准确反映当前持仓的真实成本
- 浮亏监控使用 `R1` 而非 `costPrice`

### 8.5 如何处理 T+2 结算？

港股采用 T+2 结算制度，今天买入的股票要在 T+2 日才能卖出。

```javascript
// 从持仓中获取可用数量（可立即卖出的数量）
const positions = await tradeCtx.stockPositions(["700.HK"]);
const position = positions.channels[0]?.positions?.[0];

if (position) {
  const totalQty = decimalToNumber(position.quantity);           // 总持仓
  const availableQty = decimalToNumber(position.availableQuantity); // 可用数量

  console.log(`总持仓: ${totalQty}`);
  console.log(`可卖出: ${availableQty}`);
  console.log(`锁定中: ${totalQty - availableQty} (T+2 未到)`);
}

// 提交卖出订单时，使用 availableQuantity 而非 quantity
```

### 8.6 做空交易是如何实现的？

本系统的"做空"是通过买入**熊证（Bear Warrant）**实现的，不是真正的卖空（Short Selling）。

```javascript
// "买入做空标的"实际上是买入熊证
const signal = {
  symbol: "66700.HK",        // 熊证代码
  action: SignalType.BUYPUT, // 买入做空标的
  price: 0.125
};

// 提交订单时，direction 是 Buy（买入熊证）
await tradeCtx.submitOrder({
  symbol: "66700.HK",
  orderType: OrderType.ELO,
  side: OrderSide.Buy,       // 注意：是买入（Buy），不是卖出
  submittedQuantity: new Decimal(10000),
  submittedPrice: new Decimal(0.125),
  timeInForce: TimeInForceType.Day
});
```

**牛熊证风险**：
- 牛证/熊证有**强制回收机制**（Mandatory Call）
- 当标的价格触及回收价（callPrice），牛熊证会被强制回收，价值归零
- 需要监控距回收价的百分比，及时止损

### 8.7 如何监控订单成交状态？

```javascript
// 方法1：定时轮询订单状态
async function monitorOrder(orderId) {
  const order = await tradeCtx.todayOrders({ orderId });

  if (order.status === OrderStatus.Filled) {
    console.log("订单已完全成交");
    return true;
  } else if (order.status === OrderStatus.PartialFilled) {
    const filledQty = decimalToNumber(order.executedQuantity);
    const totalQty = decimalToNumber(order.quantity);
    console.log(`订单部分成交: ${filledQty}/${totalQty}`);
    return false;
  } else if (order.status === OrderStatus.Cancelled || order.status === OrderStatus.Rejected) {
    console.log(`订单已${order.status === OrderStatus.Cancelled ? "撤销" : "拒绝"}`);
    return true; // 终止监控
  }

  return false; // 继续监控
}

// 方法2：订阅订单推送（需要实现 TradeContext 的回调）
tradeCtx.setOnOrderChanged((order) => {
  console.log(`订单状态变化: ${order.orderId} -> ${order.status}`);
});
```

---

## 参考资源

- **官方文档**: https://open.longbridge.com/docs
- **Node.js SDK**: https://longportapp.github.io/openapi-sdk/nodejs/
- **API 状态页**: https://status.longbridge.com/
- **开发者社区**: https://longbridge.feishu.cn/

---

## 版本历史

- **v1.0.0** (2024-12-19): 初始版本，包含基础 API 使用指南
