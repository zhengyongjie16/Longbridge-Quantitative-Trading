# QuoteContext

## Creation

### QuoteContext.new

```ts
QuoteContext.new(config: Config): Promise<QuoteContext>
```

Create a quote context from `Config`.

## Context metadata

### memberId

```ts
memberId(): number
```

Returns member ID.

### quoteLevel

```ts
quoteLevel(): string
```

Returns quote level.

### quotePackageDetails

```ts
quotePackageDetails(): Array<QuotePackageDetail>
```

Returns quote package details.

## Callbacks

### setOnQuote

```ts
setOnQuote(callback: (err: null | Error, event: PushQuoteEvent) => void): void
```

Register quote push callback.

### setOnDepth

```ts
setOnDepth(callback: (err: null | Error, event: PushDepthEvent) => void): void
```

Register depth push callback.

### setOnBrokers

```ts
setOnBrokers(callback: (err: null | Error, event: PushBrokersEvent) => void): void
```

Register brokers push callback.

### setOnTrades

```ts
setOnTrades(callback: (err: null | Error, event: PushTradesEvent) => void): void
```

Register trades push callback.

### setOnCandlestick

```ts
setOnCandlestick(callback: (err: null | Error, event: PushCandlestickEvent) => void): void
```

Register candlestick push callback.

## Subscription

### subscribe

```ts
subscribe(symbols: Array<string>, subTypes: Array<SubType>): Promise<void>
```

Subscribe symbols by sub-types.

### unsubscribe

```ts
unsubscribe(symbols: Array<string>, subTypes: Array<SubType>): Promise<void>
```

Unsubscribe symbols by sub-types.

### subscribeCandlesticks

```ts
subscribeCandlesticks(symbol: string, period: Period, tradeSessions: TradeSessions): Promise<Array<Candlestick>>
```

Subscribe security candlesticks.

### unsubscribeCandlesticks

```ts
unsubscribeCandlesticks(symbol: string, period: Period): Promise<void>
```

Unsubscribe security candlesticks.

### subscriptions

```ts
subscriptions(): Promise<Array<Subscription>>
```

Get current subscription information.

## Basic quote data

### staticInfo

```ts
staticInfo(symbols: Array<string>): Promise<Array<SecurityStaticInfo>>
```

Get basic security information.

### quote

```ts
quote(symbols: Array<string>): Promise<Array<SecurityQuote>>
```

Get securities quote.

### depth

```ts
depth(symbol: string): Promise<SecurityDepth>
```

Get security depth.

### brokers

```ts
brokers(symbol: string): Promise<SecurityBrokers>
```

Get security brokers.

### participants

```ts
participants(): Promise<Array<ParticipantInfo>>
```

Get participant information.

### trades

```ts
trades(symbol: string, count: number): Promise<Array<Trade>>
```

Get security trades.

### intraday

```ts
intraday(symbol: string, tradeSessions: TradeSessions): Promise<Array<IntradayLine>>
```

Get security intraday data.

### securityList

```ts
securityList(market: Market, category?: SecurityListCategory | undefined | null): Promise<Array<Security>>
```

Get security list.

Typing note: the installed `longbridge` package declares `category` as `SecurityListCategory | undefined | null`. Use `SecurityListCategory.Overnight` for the overnight list.

## K-line

### candlesticks

```ts
candlesticks(symbol: string, period: Period, count: number, adjustType: AdjustType, tradeSessions: TradeSessions): Promise<Array<Candlestick>>
```

Get security candlesticks.

### historyCandlesticksByOffset

```ts
historyCandlesticksByOffset(
  symbol: string,
  period: Period,
  adjustType: AdjustType,
  forward: boolean,
  datetime: NaiveDatetime,
  count: number,
  tradeSessions: TradeSessions,
): Promise<Array<Candlestick>>
```

Get historical candlesticks by offset.

### historyCandlesticksByDate

```ts
historyCandlesticksByDate(
  symbol: string,
  period: Period,
  adjustType: AdjustType,
  start: NaiveDate,
  end: NaiveDate,
  tradeSessions: TradeSessions,
): Promise<Array<Candlestick>>
```

Get historical candlesticks by date.

## Options

### optionQuote

```ts
optionQuote(symbols: Array<string>): Promise<Array<OptionQuote>>
```

Get option quote.

### optionChainExpiryDateList

```ts
optionChainExpiryDateList(symbol: string): Promise<Array<NaiveDate>>
```

Get option chain expiry date list.

### optionChainInfoByDate

```ts
optionChainInfoByDate(symbol: string, expiryDate: NaiveDate): Promise<Array<StrikePriceInfo>>
```

Get option chain info by date.

## Warrants

### warrantQuote

```ts
warrantQuote(symbols: Array<string>): Promise<Array<WarrantQuote>>
```

Get warrant quote.

### warrantIssuers

```ts
warrantIssuers(): Promise<Array<IssuerInfo>>
```

Get warrant issuers.

### warrantList

```ts
warrantList(
  symbol: string,
  sortBy: WarrantSortBy,
  sortOrder: SortOrderType,
  warrantType?: WarrantType[],
  issuer?: number[],
  expiryDate?: FilterWarrantExpiryDate[],
  priceType?: FilterWarrantInOutBoundsType[],
  status?: WarrantStatus[],
): Promise<Array<WarrantInfo>>
```

Query warrant list.

## Trading days & sessions

### tradingSession

```ts
tradingSession(): Promise<Array<MarketTradingSession>>
```

Get trading session of the day.

### tradingDays

```ts
tradingDays(market: Market, begin: NaiveDate, end: NaiveDate): Promise<MarketTradingDays>
```

Get market trading days in a date range.

## Capital flow & calc index

### capitalFlow

```ts
capitalFlow(symbol: string): Promise<Array<CapitalFlowLine>>
```

Get capital flow intraday.

### capitalDistribution

```ts
capitalDistribution(symbol: string): Promise<CapitalDistributionResponse>
```

Get capital distribution.

### calcIndexes

```ts
calcIndexes(symbols: Array<string>, indexes: Array<CalcIndex>): Promise<Array<SecurityCalcIndex>>
```

Get calc indexes.

## Market temperature

### marketTemperature

```ts
marketTemperature(market: Market): Promise<MarketTemperature>
```

Get current market temperature.

### historyMarketTemperature

```ts
historyMarketTemperature(market: Market, startDate: NaiveDate, end: NaiveDate): Promise<HistoryMarketTemperatureResponse>
```

Get historical market temperature.

## Watchlist

### watchlist

```ts
watchlist(): Promise<Array<WatchlistGroup>>
```

Get watchlist groups.

### createWatchlistGroup

```ts
createWatchlistGroup(req: CreateWatchlistGroup): Promise<number>
```

Create watchlist group and return group ID.

### deleteWatchlistGroup

```ts
deleteWatchlistGroup(req: DeleteWatchlistGroup): Promise<void>
```

Delete watchlist group.

### updateWatchlistGroup

```ts
updateWatchlistGroup(req: UpdateWatchlistGroup): Promise<void>
```

Update watchlist group.

## Realtime endpoints

Reference examples show `realtime*` APIs are used after corresponding subscriptions.

### realtimeQuote

```ts
realtimeQuote(symbols: Array<string>): Promise<Array<RealtimeQuote>>
```

Get realtime quote.

### realtimeDepth

```ts
realtimeDepth(symbol: string): Promise<SecurityDepth>
```

Get realtime depth.

### realtimeBrokers

```ts
realtimeBrokers(symbol: string): Promise<SecurityBrokers>
```

Get realtime brokers.

### realtimeTrades

```ts
realtimeTrades(symbol: string, count: number): Promise<Array<Trade>>
```

Get realtime trades.

### realtimeCandlesticks

```ts
realtimeCandlesticks(symbol: string, period: Period, count: number): Promise<Array<Candlestick>>
```

Get realtime candlesticks.
