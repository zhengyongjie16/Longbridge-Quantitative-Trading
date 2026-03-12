# QuoteContext - 行情上下文

## 创建与基础信息

```typescript
const ctx: QuoteContext = await QuoteContext.new(config);
const memberId: number = ctx.memberId();
const level: string = ctx.quoteLevel();
const details: QuotePackageDetail[] = ctx.quotePackageDetails();
```

## 实时推送回调

```typescript
ctx.setOnQuote((err: Error, event: PushQuoteEvent) => void);
ctx.setOnDepth((err: Error, event: PushDepthEvent) => void);
ctx.setOnBrokers((err: Error, event: PushBrokersEvent) => void);
ctx.setOnTrades((err: Error, event: PushTradesEvent) => void);
ctx.setOnCandlestick((err: Error, event: PushCandlestickEvent) => void);
```

## 订阅管理

#### subscribe - 订阅行情

```typescript
await ctx.subscribe(
  symbols: string[],        // 证券代码列表，如 ["700.HK", "AAPL.US"]
  subTypes: SubType[],      // 订阅类型列表
): Promise<void>
```

#### unsubscribe - 取消订阅

```typescript
await ctx.unsubscribe(
  symbols: string[],
  subTypes: SubType[],
): Promise<void>
```

#### subscribeCandlesticks - 订阅 K 线

```typescript
const candlesticks: Candlestick[] = await ctx.subscribeCandlesticks(
  symbol: string,
  period: Period,
  tradeSessions: TradeSessions,
): Promise<Candlestick[]>
```

#### unsubscribeCandlesticks - 取消订阅 K 线

```typescript
await ctx.unsubscribeCandlesticks(
  symbol: string,
  period: Period,
): Promise<void>
```

#### subscriptions - 获取订阅信息

```typescript
const subs: Subscription[] = await ctx.subscriptions(): Promise<Subscription[]>
// Subscription: { symbol: string, subTypes: SubType[], candlesticks: Period[] }
```

## 证券基础信息

#### staticInfo - 获取证券基础信息

```typescript
const info: SecurityStaticInfo[] = await ctx.staticInfo(
  symbols: string[],
): Promise<SecurityStaticInfo[]>
```

#### quote - 获取证券实时报价

```typescript
const quotes: SecurityQuote[] = await ctx.quote(
  symbols: string[],
): Promise<SecurityQuote[]>
```

#### optionQuote - 获取期权报价

```typescript
const quotes: OptionQuote[] = await ctx.optionQuote(
  symbols: string[],         // 如 ["AAPL230317P160000.US"]
): Promise<OptionQuote[]>
```

#### warrantQuote - 获取轮证报价

```typescript
const quotes: WarrantQuote[] = await ctx.warrantQuote(
  symbols: string[],         // 如 ["21125.HK"]
): Promise<WarrantQuote[]>
```

## 盘口与经纪商

#### depth - 获取盘口深度

```typescript
const depth: SecurityDepth = await ctx.depth(
  symbol: string,
): Promise<SecurityDepth>
// SecurityDepth: { asks: Depth[], bids: Depth[] }
// Depth: { position: number, price: Decimal, volume: number, orderNum: number }
```

#### brokers - 获取经纪商分布

```typescript
const brokers: SecurityBrokers = await ctx.brokers(
  symbol: string,
): Promise<SecurityBrokers>
// SecurityBrokers: { askBrokers: Brokers[], bidBrokers: Brokers[] }
```

#### participants - 获取券商席位 ID

```typescript
const participants: ParticipantInfo[] = await ctx.participants(): Promise<ParticipantInfo[]>
// ParticipantInfo: { brokerIds: number[], nameCn: string, nameEn: string, nameHk: string }
```

## 成交与分时

#### trades - 获取逐笔成交

```typescript
const trades: Trade[] = await ctx.trades(
  symbol: string,
  count: number,
): Promise<Trade[]>
```

#### intraday - 获取分时数据

```typescript
const lines: IntradayLine[] = await ctx.intraday(
  symbol: string,
  tradeSessions: TradeSessions,
): Promise<IntradayLine[]>
```

## K 线数据

#### candlesticks - 获取 K 线数据

```typescript
const candles: Candlestick[] = await ctx.candlesticks(
  symbol: string,
  period: Period,
  count: number,
  adjustType: AdjustType,
  tradeSessions: TradeSessions,
): Promise<Candlestick[]>
```

#### historyCandlesticksByOffset - 按偏移获取历史 K 线

```typescript
const candles: Candlestick[] = await ctx.historyCandlesticksByOffset(
  symbol: string,
  period: Period,
  adjustType: AdjustType,
  forward: boolean,          // 是否向前查询
  datetime: NaiveDatetime,
  count: number,
  tradeSessions: TradeSessions,
): Promise<Candlestick[]>
```

#### historyCandlesticksByDate - 按日期获取历史 K 线

```typescript
const candles: Candlestick[] = await ctx.historyCandlesticksByDate(
  symbol: string,
  period: Period,
  adjustType: AdjustType,
  start: NaiveDate,
  end: NaiveDate,
  tradeSessions: TradeSessions,
): Promise<Candlestick[]>
```

## 期权链

#### optionChainExpiryDateList - 获取期权到期日列表

```typescript
const dates: NaiveDate[] = await ctx.optionChainExpiryDateList(
  symbol: string,            // 如 "AAPL.US"
): Promise<NaiveDate[]>
```

#### optionChainInfoByDate - 按日期获取期权链信息

```typescript
const strikes: StrikePriceInfo[] = await ctx.optionChainInfoByDate(
  symbol: string,
  expiryDate: NaiveDate,
): Promise<StrikePriceInfo[]>
```

## 轮证筛选

#### warrantIssuers - 获取轮证发行商列表

```typescript
const issuers: IssuerInfo[] = await ctx.warrantIssuers(): Promise<IssuerInfo[]>
// IssuerInfo: { id: number, nameCn: string, nameEn: string, nameHk: string }
```

#### warrantList - 筛选轮证列表

```typescript
const warrants: WarrantInfo[] = await ctx.warrantList(
  symbol: string,                     // 标的代码，如 "700.HK"
  sortBy: WarrantSortBy,
  sortOrder: SortOrderType,
  warrantType?: WarrantType[],        // 可选 - 轮证类型
  issuer?: number[],                  // 可选 - 发行商 ID
  expiryDate?: FilterWarrantExpiryDate[],
  priceType?: FilterWarrantInOutBoundsType[],
  status?: WarrantStatus[],
): Promise<WarrantInfo[]>
```

## 交易日与时段

#### tradingSession - 获取当日交易时段

```typescript
const sessions: MarketTradingSession[] = await ctx.tradingSession(): Promise<MarketTradingSession[]>
// MarketTradingSession: { market: Market, tradeSessions: TradingSessionInfo[] }
```

#### tradingDays - 获取交易日列表

```typescript
const days: MarketTradingDays = await ctx.tradingDays(
  market: Market,
  begin: NaiveDate,
  end: NaiveDate,
): Promise<MarketTradingDays>
// MarketTradingDays: { tradingDays: NaiveDate[], halfTradingDays: NaiveDate[] }
```

## 资金流向

#### capitalFlow - 获取当日资金流入

```typescript
const flows: CapitalFlowLine[] = await ctx.capitalFlow(
  symbol: string,
): Promise<CapitalFlowLine[]>
// CapitalFlowLine: { inflow: Decimal, timestamp: Date }
```

#### capitalDistribution - 获取资金分布

```typescript
const dist: CapitalDistributionResponse = await ctx.capitalDistribution(
  symbol: string,
): Promise<CapitalDistributionResponse>
// CapitalDistributionResponse: { timestamp: Date, capitalIn: CapitalDistribution, capitalOut: CapitalDistribution }
```

## 计算指标

#### calcIndexes - 计算证券指标

```typescript
const indexes: SecurityCalcIndex[] = await ctx.calcIndexes(
  symbols: string[],
  indexes: CalcIndex[],
): Promise<SecurityCalcIndex[]>
```

## 自选股

#### watchlist - 获取自选股分组

```typescript
const groups: WatchlistGroup[] = await ctx.watchlist(): Promise<WatchlistGroup[]>
```

#### createWatchlistGroup - 创建自选股分组

```typescript
const groupId: number = await ctx.createWatchlistGroup(
  req: CreateWatchlistGroup,   // { name: string, securities?: string[] }
): Promise<number>
```

#### deleteWatchlistGroup - 删除自选股分组

```typescript
await ctx.deleteWatchlistGroup(
  req: DeleteWatchlistGroup,   // { id: number, purge?: boolean }
): Promise<void>
```

#### updateWatchlistGroup - 更新自选股分组

```typescript
await ctx.updateWatchlistGroup(
  req: UpdateWatchlistGroup,   // { id: number, name?: string, securities?: string[], mode?: SecuritiesUpdateMode }
): Promise<void>
```

## 证券列表

#### securityList - 获取证券列表

```typescript
const securities: Security[] = await ctx.securityList(
  market: Market,
  category?: SecurityListCategory,
): Promise<Security[]>
// Security: { symbol: string, nameCn: string, nameEn: string, nameHk: string }
```

## 市场温度

#### marketTemperature - 获取当前市场温度

```typescript
const temp: MarketTemperature = await ctx.marketTemperature(
  market: Market,
): Promise<MarketTemperature>
```

#### historyMarketTemperature - 获取历史市场温度

```typescript
const resp: HistoryMarketTemperatureResponse = await ctx.historyMarketTemperature(
  market: Market,
  startDate: NaiveDate,
  end: NaiveDate,
): Promise<HistoryMarketTemperatureResponse>
```

## 实时数据（需先订阅）

#### realtimeQuote - 获取实时报价

```typescript
const quotes: RealtimeQuote[] = await ctx.realtimeQuote(
  symbols: string[],
): Promise<RealtimeQuote[]>
// 需先 subscribe SubType.Quote
```

#### realtimeDepth - 获取实时盘口

```typescript
const depth: SecurityDepth = await ctx.realtimeDepth(
  symbol: string,
): Promise<SecurityDepth>
// 需先 subscribe SubType.Depth
```

#### realtimeBrokers - 获取实时经纪商

```typescript
const brokers: SecurityBrokers = await ctx.realtimeBrokers(
  symbol: string,
): Promise<SecurityBrokers>
// 需先 subscribe SubType.Brokers
```

#### realtimeTrades - 获取实时逐笔成交

```typescript
const trades: Trade[] = await ctx.realtimeTrades(
  symbol: string,
  count: number,
): Promise<Trade[]>
// 需先 subscribe SubType.Trade
```

#### realtimeCandlesticks - 获取实时 K 线

```typescript
const candles: Candlestick[] = await ctx.realtimeCandlesticks(
  symbol: string,
  period: Period,
  count: number,
): Promise<Candlestick[]>
// 需先 subscribeCandlesticks
```
