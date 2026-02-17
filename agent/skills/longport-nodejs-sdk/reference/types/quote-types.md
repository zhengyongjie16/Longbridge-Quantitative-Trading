# 行情数据类型与推送事件

## SecurityQuote - 证券报价

| 属性 | 类型 | 说明 |
|------|------|------|
| `symbol` | `string` | 证券代码 |
| `lastDone` | `Decimal` | 最新价 |
| `prevClose` | `Decimal` | 昨收价 |
| `open` | `Decimal` | 开盘价 |
| `high` | `Decimal` | 最高价 |
| `low` | `Decimal` | 最低价 |
| `timestamp` | `Date` | 最新价时间 |
| `volume` | `number` | 成交量 |
| `turnover` | `Decimal` | 成交额 |
| `tradeStatus` | `TradeStatus` | 交易状态 |
| `preMarketQuote` | `PrePostQuote` | 美股盘前报价 |
| `postMarketQuote` | `PrePostQuote` | 美股盘后报价 |
| `overnightQuote` | `PrePostQuote` | 美股夜盘报价 |

## SecurityStaticInfo - 证券基础信息

| 属性 | 类型 | 说明 |
|------|------|------|
| `symbol` | `string` | 证券代码 |
| `nameCn` | `string` | 中文名称 |
| `nameEn` | `string` | 英文名称 |
| `nameHk` | `string` | 繁体中文名称 |
| `exchange` | `string` | 所属交易所 |
| `currency` | `string` | 交易货币 |
| `lotSize` | `number` | 每手股数 |
| `totalShares` | `number` | 总股本 |
| `circulatingShares` | `number` | 流通股本 |
| `hkShares` | `number` | 港股股数（仅港股） |
| `eps` | `Decimal` | 每股收益 |
| `epsTtm` | `Decimal` | 每股收益(TTM) |
| `bps` | `Decimal` | 每股净资产 |
| `dividendYield` | `Decimal` | 股息率 |
| `stockDerivatives` | `DerivativeType[]` | 支持的衍生品类型 |
| `board` | `SecurityBoard` | 板块 |

## WarrantQuote - 轮证报价

| 属性 | 类型 | 说明 |
|------|------|------|
| `symbol` | `string` | 证券代码 |
| `lastDone` | `Decimal` | 最新价 |
| `prevClose` | `Decimal` | 昨收价 |
| `open` | `Decimal` | 开盘价 |
| `high` | `Decimal` | 最高价 |
| `low` | `Decimal` | 最低价 |
| `timestamp` | `Date` | 最新价时间 |
| `volume` | `number` | 成交量 |
| `turnover` | `Decimal` | 成交额 |
| `tradeStatus` | `TradeStatus` | 交易状态 |
| `impliedVolatility` | `Decimal` | 引伸波幅 |
| `expiryDate` | `NaiveDate` | 到期日 |
| `lastTradeDate` | `NaiveDate` | 最后交易日 |
| `outstandingRatio` | `Decimal` | 街货比 |
| `outstandingQuantity` | `number` | 街货量 |
| `conversionRatio` | `Decimal` | 换股比率 |
| `category` | `WarrantType` | 轮证类型 |
| `strikePrice` | `Decimal` | 行权价 |
| `upperStrikePrice` | `Decimal` | 上限价 |
| `lowerStrikePrice` | `Decimal` | 下限价 |
| `callPrice` | `Decimal` | 收回价 |
| `underlyingSymbol` | `string` | 标的证券代码 |

## WarrantInfo - 轮证信息（warrantList 返回）

| 属性 | 类型 | 说明 |
|------|------|------|
| `symbol` | `string` | 证券代码 |
| `warrantType` | `WarrantType` | 轮证类型 |
| `name` | `string` | 名称 |
| `lastDone` | `Decimal` | 最新价 |
| `changeRate` | `Decimal` | 涨跌幅 |
| `changeValue` | `Decimal` | 涨跌额 |
| `volume` | `number` | 成交量 |
| `turnover` | `Decimal` | 成交额 |
| `expiryDate` | `NaiveDate` | 到期日 |
| `strikePrice` | `Decimal` | 行权价 |
| `upperStrikePrice` | `Decimal` | 上限价 |
| `lowerStrikePrice` | `Decimal` | 下限价 |
| `outstandingQty` | `number` | 街货量 |
| `outstandingRatio` | `Decimal` | 街货比 |
| `premium` | `Decimal` | 溢价 |
| `itmOtm` | `Decimal` | 价内/价外 |
| `impliedVolatility` | `Decimal` | 引伸波幅 |
| `delta` | `Decimal` | Delta |
| `callPrice` | `Decimal` | 收回价 |
| `toCallPrice` | `Decimal` | 距收回价 |
| `effectiveLeverage` | `Decimal` | 有效杠杆 |
| `leverageRatio` | `Decimal` | 杠杆比率 |
| `conversionRatio` | `Decimal` | 换股比率 |
| `balancePoint` | `Decimal` | 打和点 |
| `status` | `WarrantStatus` | 状态 |

## Candlestick - K 线数据

| 属性 | 类型 | 说明 |
|------|------|------|
| `close` | `Decimal` | 收盘价 |
| `open` | `Decimal` | 开盘价 |
| `low` | `Decimal` | 最低价 |
| `high` | `Decimal` | 最高价 |
| `volume` | `number` | 成交量 |
| `turnover` | `Decimal` | 成交额 |
| `timestamp` | `Date` | 时间戳 |
| `tradeSession` | `TradeSession` | 交易时段 |

## Trade - 逐笔成交

| 属性 | 类型 | 说明 |
|------|------|------|
| `price` | `Decimal` | 成交价 |
| `volume` | `number` | 成交量 |
| `timestamp` | `Date` | 成交时间 |
| `tradeType` | `string` | 成交类型 |
| `direction` | `TradeDirection` | 成交方向 |
| `tradeSession` | `TradeSession` | 交易时段 |

## IntradayLine - 分时数据

| 属性 | 类型 | 说明 |
|------|------|------|
| `price` | `Decimal` | 分钟收盘价 |
| `timestamp` | `Date` | 分钟开始时间 |
| `volume` | `number` | 成交量 |
| `turnover` | `Decimal` | 成交额 |
| `avgPrice` | `Decimal` | 均价 |

## SecurityDepth - 盘口深度

| 属性 | 类型 | 说明 |
|------|------|------|
| `asks` | `Depth[]` | 卖盘 |
| `bids` | `Depth[]` | 买盘 |

**Depth 属性：** `position: number, price: Decimal, volume: number, orderNum: number`

## SecurityBrokers - 经纪商分布

| 属性 | 类型 | 说明 |
|------|------|------|
| `askBrokers` | `Brokers[]` | 卖方经纪商 |
| `bidBrokers` | `Brokers[]` | 买方经纪商 |

## RealtimeQuote - 实时报价

| 属性 | 类型 | 说明 |
|------|------|------|
| `symbol` | `string` | 证券代码 |
| `lastDone` | `Decimal` | 最新价 |
| `open` | `Decimal` | 开盘价 |
| `high` | `Decimal` | 最高价 |
| `low` | `Decimal` | 最低价 |
| `timestamp` | `Date` | 时间 |
| `volume` | `number` | 成交量 |
| `turnover` | `Decimal` | 成交额 |
| `tradeStatus` | `TradeStatus` | 交易状态 |

## Subscription - 订阅信息

| 属性 | 类型 | 说明 |
|------|------|------|
| `symbol` | `string` | 证券代码 |
| `subTypes` | `SubType[]` | 订阅类型 |
| `candlesticks` | `Period[]` | 订阅的 K 线周期 |

## MarketTradingDays - 市场交易日

| 属性 | 类型 | 说明 |
|------|------|------|
| `tradingDays` | `NaiveDate[]` | 交易日列表 |
| `halfTradingDays` | `NaiveDate[]` | 半日交易日列表 |

## MarketTradingSession - 市场交易时段

| 属性 | 类型 | 说明 |
|------|------|------|
| `market` | `Market` | 市场 |
| `tradeSessions` | `TradingSessionInfo[]` | 交易时段列表 |

## CapitalFlowLine - 资金流入线

| 属性 | 类型 | 说明 |
|------|------|------|
| `inflow` | `Decimal` | 流入金额 |
| `timestamp` | `Date` | 时间 |

## CapitalDistributionResponse - 资金分布响应

| 属性 | 类型 | 说明 |
|------|------|------|
| `timestamp` | `Date` | 时间 |
| `capitalIn` | `CapitalDistribution` | 流入资金分布 |
| `capitalOut` | `CapitalDistribution` | 流出资金分布 |

## ParticipantInfo - 券商席位

| 属性 | 类型 | 说明 |
|------|------|------|
| `brokerIds` | `number[]` | 券商 ID 列表 |
| `nameCn` | `string` | 中文名称 |
| `nameEn` | `string` | 英文名称 |
| `nameHk` | `string` | 繁体中文名称 |

## IssuerInfo - 轮证发行商

| 属性 | 类型 | 说明 |
|------|------|------|
| `id` | `number` | 发行商 ID |
| `nameCn` | `string` | 中文名称 |
| `nameEn` | `string` | 英文名称 |
| `nameHk` | `string` | 繁体中文名称 |

## Security - 证券基本信息

| 属性 | 类型 | 说明 |
|------|------|------|
| `symbol` | `string` | 证券代码 |
| `nameCn` | `string` | 中文名称 |
| `nameEn` | `string` | 英文名称 |
| `nameHk` | `string` | 繁体中文名称 |

## PrePostQuote - 盘前/盘后报价

| 属性 | 类型 | 说明 |
|------|------|------|
| `lastDone` | `Decimal` | 最新价 |
| `timestamp` | `Date` | 时间 |
| `volume` | `number` | 成交量 |
| `turnover` | `Decimal` | 成交额 |
| `high` | `Decimal` | 最高价 |
| `low` | `Decimal` | 最低价 |
| `prevClose` | `Decimal` | 昨收价 |

---

## 推送事件类型

### PushQuoteEvent / PushQuote

PushQuoteEvent: `{ symbol: string, data: PushQuote }`

| 属性 | 类型 | 说明 |
|------|------|------|
| `lastDone` | `Decimal` | 最新价 |
| `open` | `Decimal` | 开盘价 |
| `high` | `Decimal` | 最高价 |
| `low` | `Decimal` | 最低价 |
| `timestamp` | `Date` | 时间 |
| `volume` | `number` | 成交量 |
| `turnover` | `Decimal` | 成交额 |
| `tradeStatus` | `TradeStatus` | 交易状态 |
| `tradeSession` | `TradeSession` | 交易时段 |
| `currentVolume` | `number` | 本次推送增量成交量 |
| `currentTurnover` | `Decimal` | 本次推送增量成交额 |

### PushDepthEvent

`{ symbol: string, data: PushDepth }`

### PushBrokersEvent

`{ symbol: string, data: PushBrokers }`

### PushTradesEvent

`{ symbol: string, data: PushTrades }`

### PushCandlestickEvent

`{ symbol: string, data: PushCandlestick }`
