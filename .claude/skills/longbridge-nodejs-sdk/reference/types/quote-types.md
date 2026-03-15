# Quote Types

## Core quote snapshots

### SecurityQuote

- `symbol: string`
- `lastDone: Decimal`
- `prevClose: Decimal`
- `open: Decimal`
- `high: Decimal`
- `low: Decimal`
- `timestamp: Date`
- `volume: number`
- `turnover: Decimal`
- `tradeStatus: TradeStatus`
- `preMarketQuote: PrePostQuote`
- `postMarketQuote: PrePostQuote`
- `overnightQuote: PrePostQuote`

### SecurityStaticInfo

- `symbol: string`
- `nameCn: string`
- `nameEn: string`
- `nameHk: string`
- `exchange: string`
- `currency: string`
- `lotSize: number`
- `totalShares: number`
- `circulatingShares: number`
- `hkShares: number`
- `eps: Decimal`
- `epsTtm: Decimal`
- `bps: Decimal`
- `dividendYield: Decimal`
- `stockDerivatives: Array<DerivativeType>`
- `board: SecurityBoard`

### RealtimeQuote

- `symbol: string`
- `lastDone: Decimal`
- `open: Decimal`
- `high: Decimal`
- `low: Decimal`
- `timestamp: Date`
- `volume: number`
- `turnover: Decimal`
- `tradeStatus: TradeStatus`

### PrePostQuote

- `lastDone: Decimal`
- `timestamp: Date`
- `volume: number`
- `turnover: Decimal`
- `high: Decimal`
- `low: Decimal`
- `prevClose: Decimal`

## Order book and broker-related types

### SecurityDepth

- `asks: Array<Depth>`
- `bids: Array<Depth>`

### Depth

- `position: number`
- `price: Decimal`
- `volume: number`
- `orderNum: number`

### SecurityBrokers

- `askBrokers: Array<Brokers>`
- `bidBrokers: Array<Brokers>`

### Brokers

- `position: number`
- `brokerIds: Array<number>`

### ParticipantInfo

- `brokerIds: Array<number>`
- `nameCn: string`
- `nameEn: string`
- `nameHk: string`

## Trades / intraday / candlestick

### Trade

- `price: Decimal`
- `volume: number`
- `timestamp: Date`
- `tradeType: string`
- `direction: TradeDirection`
- `tradeSession: TradeSession`

### IntradayLine

- `price: Decimal`
- `timestamp: Date`
- `volume: number`
- `turnover: Decimal`
- `avgPrice: Decimal`

### Candlestick

- `close: Decimal`
- `open: Decimal`
- `low: Decimal`
- `high: Decimal`
- `volume: number`
- `turnover: Decimal`
- `timestamp: Date`
- `tradeSession: TradeSession`

### Subscription

- `symbol: string`
- `subTypes: Array<SubType>`
- `candlesticks: Array<Period>`

## Option and warrant-related types

### OptionQuote

- `symbol: string`
- `lastDone: Decimal`
- `prevClose: Decimal`
- `open: Decimal`
- `high: Decimal`
- `low: Decimal`
- `timestamp: Date`
- `volume: number`
- `turnover: Decimal`
- `tradeStatus: TradeStatus`
- `impliedVolatility: Decimal`
- `openInterest: number`
- `expiryDate: NaiveDate`
- `strikePrice: Decimal`
- `contractMultiplier: Decimal`
- `contractType: OptionType`
- `contractSize: Decimal`
- `direction: OptionDirection`
- `historicalVolatility: Decimal`
- `underlyingSymbol: string`

### StrikePriceInfo

- `price: Decimal`
- `callSymbol: string`
- `putSymbol: string`
- `standard: boolean`

### WarrantQuote

- `symbol: string`
- `lastDone: Decimal`
- `prevClose: Decimal`
- `open: Decimal`
- `high: Decimal`
- `low: Decimal`
- `timestamp: Date`
- `volume: number`
- `turnover: Decimal`
- `tradeStatus: TradeStatus`
- `impliedVolatility: Decimal`
- `expiryDate: NaiveDate`
- `lastTradeDate: NaiveDate`
- `outstandingRatio: Decimal`
- `outstandingQuantity: number`
- `conversionRatio: Decimal`
- `category: WarrantType`
- `strikePrice: Decimal`
- `upperStrikePrice: Decimal`
- `lowerStrikePrice: Decimal`
- `callPrice: Decimal`
- `underlyingSymbol: string`

### WarrantInfo

- `symbol: string`
- `warrantType: WarrantType`
- `name: string`
- `lastDone: Decimal`
- `changeRate: Decimal`
- `changeValue: Decimal`
- `volume: number`
- `turnover: Decimal`
- `expiryDate: NaiveDate`
- `strikePrice: Decimal`
- `upperStrikePrice: Decimal`
- `lowerStrikePrice: Decimal`
- `outstandingQty: number`
- `outstandingRatio: Decimal`
- `premium: Decimal`
- `itmOtm: Decimal`
- `impliedVolatility: Decimal`
- `delta: Decimal`
- `callPrice: Decimal`
- `toCallPrice: Decimal`
- `effectiveLeverage: Decimal`
- `leverageRatio: Decimal`
- `conversionRatio: Decimal`
- `balancePoint: Decimal`
- `status: WarrantStatus`

### IssuerInfo

- `issuerId: number`
- `nameCn: string`
- `nameEn: string`
- `nameHk: string`

## Trading calendar and sessions

### MarketTradingDays

- `tradingDays: Array<NaiveDate>`
- `halfTradingDays: Array<NaiveDate>`

### MarketTradingSession

- `market: Market`
- `tradeSessions: Array<TradingSessionInfo>`

### TradingSessionInfo

- `beginTime: Time`
- `endTime: Time`
- `tradeSession: TradeSession`

## Capital flow and calculated indexes

### CapitalFlowLine

- `inflow: Decimal`
- `timestamp: Date`

### CapitalDistribution

- `large: Decimal`
- `medium: Decimal`
- `small: Decimal`

### CapitalDistributionResponse

- `timestamp: Date`
- `capitalIn: CapitalDistribution`
- `capitalOut: CapitalDistribution`

### SecurityCalcIndex

- `symbol: string`
- `lastDone: Decimal`
- `changeValue: Decimal`
- `changeRate: Decimal`
- `volume: number`
- `turnover: Decimal`
- `ytdChangeRate: Decimal`
- `turnoverRate: Decimal`
- `totalMarketValue: Decimal`
- `capitalFlow: Decimal`
- `amplitude: Decimal`
- `volumeRatio: Decimal`
- `peTtmRatio: Decimal`
- `pbRatio: Decimal`
- `dividendRatioTtm: Decimal`
- `fiveDayChangeRate: Decimal`
- `tenDayChangeRate: Decimal`
- `halfYearChangeRate: Decimal`
- `fiveMinutesChangeRate: Decimal`
- `expiryDate: NaiveDate`
- `strikePrice: Decimal`
- `upperStrikePrice: Decimal`
- `lowerStrikePrice: Decimal`
- `outstandingQty: number`
- `outstandingRatio: Decimal`
- `premium: Decimal`
- `itmOtm: Decimal`
- `impliedVolatility: Decimal`
- `warrantDelta: Decimal`
- `callPrice: Decimal`
- `toCallPrice: Decimal`
- `effectiveLeverage: Decimal`
- `leverageRatio: Decimal`
- `conversionRatio: Decimal`
- `balancePoint: Decimal`
- `openInterest: number`
- `delta: Decimal`
- `gamma: Decimal`
- `theta: Decimal`
- `vega: Decimal`
- `rho: Decimal`

### MarketTemperature

- `temperature: number`
- `description: string`
- `valuation: number`
- `sentiment: number`
- `timestamp: Date`

### HistoryMarketTemperatureResponse

- `granularity: Granularity`
- `records: Array<MarketTemperature>`

## Watchlist-related types

### WatchlistGroup

- `id: number`
- `name: string`
- `securities: Array<WatchlistSecurity>`

### WatchlistSecurity

- `symbol: string`
- `market: Market`
- `name: string`
- `watchedPrice: Decimal`
- `watchedAt: Date`

### CreateWatchlistGroup

- `name: string`
- `securities?: Array<string>`

### DeleteWatchlistGroup

- `id: number`
- `purge: boolean`

### UpdateWatchlistGroup

- `id: number`
- `name?: string`
- `securities?: Array<string>`
- `mode: SecuritiesUpdateMode`

## Additional quote-side utility types

### Security

- `symbol: string`
- `nameCn: string`
- `nameEn: string`
- `nameHk: string`

### QuotePackageDetail

- `key: string`
- `name: string`
- `description: string`
- `startAt: Date`
- `endAt: Date`

## Push events

### PushQuote

- `lastDone: Decimal`
- `open: Decimal`
- `high: Decimal`
- `low: Decimal`
- `timestamp: Date`
- `volume: number`
- `turnover: Decimal`
- `tradeStatus: TradeStatus`
- `tradeSession: TradeSession`
- `currentVolume: number`
- `currentTurnover: Decimal`

### PushQuoteEvent

- `symbol: string`
- `data: PushQuote`

### PushDepth

- `asks: Array<Depth>`
- `bids: Array<Depth>`

### PushDepthEvent

- `symbol: string`
- `data: PushDepth`

### PushBrokers

- `askBrokers: Array<Brokers>`
- `bidBrokers: Array<Brokers>`

### PushBrokersEvent

- `symbol: string`
- `data: PushBrokers`

### PushTrades

- `trades: Array<Trade>`

### PushTradesEvent

- `symbol: string`
- `data: PushTrades`

### PushCandlestick

- `period: Period`
- `candlestick: Candlestick`
- `isConfirmed: boolean`

### PushCandlestickEvent

- `symbol: string`
- `data: PushCandlestick`
