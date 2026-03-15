# Enumerations

## Quote / market / calendar

### AdjustType

| Value | Member          | Description    |
| ----- | --------------- | -------------- |
| 0     | `NoAdjust`      | Actual         |
| 1     | `ForwardAdjust` | Adjust forward |

### DerivativeType

| Value | Member    | Description      |
| ----- | --------- | ---------------- |
| 0     | `Option`  | US stock options |
| 1     | `Warrant` | HK warrants      |

### Granularity

| Value | Member    | Description |
| ----- | --------- | ----------- |
| 0     | `Unknown` | Unknown     |
| 1     | `Daily`   | Daily       |
| 2     | `Weekly`  | Weekly      |
| 3     | `Monthly` | Monthly     |

### Language

| Value | Member  | Description |
| ----- | ------- | ----------- |
| 0     | `ZH_CN` | zh-CN       |
| 1     | `ZH_HK` | zh-HK       |
| 2     | `EN`    | en          |

### Market

| Value | Member    | Description   |
| ----- | --------- | ------------- |
| 0     | `Unknown` | Unknown       |
| 1     | `US`      | US market     |
| 2     | `HK`      | HK market     |
| 3     | `CN`      | CN market     |
| 4     | `SG`      | SG market     |
| 5     | `Crypto`  | Crypto market |

### OptionDirection

| Value | Member    | Description |
| ----- | --------- | ----------- |
| 0     | `Unknown` | Unknown     |
| 1     | `Put`     | Put         |
| 2     | `Call`    | Call        |

### OptionType

| Value | Member     | Description |
| ----- | ---------- | ----------- |
| 0     | `Unknown`  | Unknown     |
| 1     | `American` | American    |
| 2     | `Europe`   | Europe      |

### Period

| Value | Member    | Description        |
| ----- | --------- | ------------------ |
| 0     | `Unknown` | Unknown            |
| 1     | `Min_1`   | One Minute         |
| 2     | `Min_2`   | Two Minutes        |
| 3     | `Min_3`   | Three Minutes      |
| 4     | `Min_5`   | Five Minutes       |
| 5     | `Min_10`  | Ten Minutes        |
| 6     | `Min_15`  | Fifteen Minutes    |
| 7     | `Min_20`  | Twenty Minutes     |
| 8     | `Min_30`  | Thirty Minutes     |
| 9     | `Min_45`  | Forty-Five Minutes |
| 10    | `Min_60`  | One Hour           |
| 11    | `Min_120` | Two Hours          |
| 12    | `Min_180` | Three Hours        |
| 13    | `Min_240` | Four Hours         |
| 14    | `Day`     | Daily              |
| 15    | `Week`    | Weekly             |
| 16    | `Month`   | Monthly            |
| 17    | `Quarter` | Quarterly          |
| 18    | `Year`    | Yearly             |

### PushCandlestickMode

| Value | Member      | Description    |
| ----- | ----------- | -------------- |
| 0     | `Realtime`  | Realtime mode  |
| 1     | `Confirmed` | Confirmed mode |

### SecuritiesUpdateMode

| Value | Member    | Description        |
| ----- | --------- | ------------------ |
| 0     | `Add`     | Add securities     |
| 1     | `Remove`  | Remove securities  |
| 2     | `Replace` | Replace securities |

### SecurityBoard

| Value | Member             | Description                                |
| ----- | ------------------ | ------------------------------------------ |
| 0     | `Unknown`          | Unknown                                    |
| 1     | `USMain`           | US Main Board                              |
| 2     | `USPink`           | US Pink Board                              |
| 3     | `USDJI`            | Dow Jones Industrial Average               |
| 4     | `USNSDQ`           | Nasdsaq Index                              |
| 5     | `USSector`         | US Industry Board                          |
| 6     | `USOption`         | US Option                                  |
| 7     | `USOptionS`        | US Sepecial Option                         |
| 8     | `HKEquity`         | Hong Kong Equity Securities                |
| 9     | `HKPreIPO`         | HK PreIPO Security                         |
| 10    | `HKWarrant`        | HK Warrant                                 |
| 11    | `HKHS`             | Hang Seng Index                            |
| 12    | `HKSector`         | HK Industry Board                          |
| 13    | `SHMainConnect`    | SH Main Board(Connect)                     |
| 14    | `SHMainNonConnect` | SH Main Board(Non Connect)                 |
| 15    | `SHSTAR`           | SH Science and Technology Innovation Board |
| 16    | `CNIX`             | CN Index                                   |
| 17    | `CNSector`         | CN Industry Board                          |
| 18    | `SZMainConnect`    | SZ Main Board(Connect)                     |
| 19    | `SZMainNonConnect` | SZ Main Board(Non Connect)                 |
| 20    | `SZGEMConnect`     | SZ Gem Board(Connect)                      |
| 21    | `SZGEMNonConnect`  | SZ Gem Board(Non Connect)                  |
| 22    | `SGMain`           | SG Main Board                              |
| 23    | `STI`              | Singapore Straits Index                    |
| 24    | `SGSector`         | SG Industry Board                          |
| 25    | `SPXIndex`         | S&P 500 Index                              |
| 26    | `VIXIndex`         | CBOE Volatility Index                      |

### SecurityListCategory

| Value | Member      | Description |
| ----- | ----------- | ----------- |
| 0     | `Overnight` | Overnight   |

### SortOrderType

| Value | Member       | Description |
| ----- | ------------ | ----------- |
| 0     | `Ascending`  | Ascending   |
| 1     | `Descending` | Descending  |

### SubType

| Value | Member    | Description |
| ----- | --------- | ----------- |
| 0     | `Quote`   | Quote       |
| 1     | `Depth`   | Depth       |
| 2     | `Brokers` | Brokers     |
| 3     | `Trade`   | Trade       |

### TradeDirection

| Value | Member    | Description |
| ----- | --------- | ----------- |
| 0     | `Neutral` | Neutral     |
| 1     | `Down`    | Down        |
| 2     | `Up`      | Up          |

### TradeSession

| Value | Member      | Description |
| ----- | ----------- | ----------- |
| 0     | `Intraday`  | Intraday    |
| 1     | `Pre`       | Pre-Market  |
| 2     | `Post`      | Post-Market |
| 3     | `Overnight` | Overnight   |

### TradeSessions

| Value | Member     | Description |
| ----- | ---------- | ----------- |
| 0     | `Intraday` | Intraday    |
| 1     | `All`      | All         |

### TradeStatus

| Value | Member               | Description         |
| ----- | -------------------- | ------------------- |
| 0     | `Normal`             | Normal              |
| 1     | `Halted`             | Suspension          |
| 2     | `Delisted`           | Delisted            |
| 3     | `Fuse`               | Fuse                |
| 4     | `PrepareList`        | Prepare List        |
| 5     | `CodeMoved`          | Code Moved          |
| 6     | `ToBeOpened`         | To Be Opened        |
| 7     | `SplitStockHalts`    | Split Stock Halts   |
| 8     | `Expired`            | Expired             |
| 9     | `WarrantPrepareList` | Warrant To BeListed |
| 10    | `Suspend`            | Warrant To BeListed |

### WarrantSortBy

| Value | Member                | Description                        |
| ----- | --------------------- | ---------------------------------- |
| 0     | `LastDone`            | Last done                          |
| 1     | `ChangeRate`          | Change rate                        |
| 2     | `ChangeValue`         | Change value                       |
| 3     | `Volume`              | Volume                             |
| 4     | `Turnover`            | Turnover                           |
| 5     | `ExpiryDate`          | Expiry date                        |
| 6     | `StrikePrice`         | Strike price                       |
| 7     | `UpperStrikePrice`    | Upper strike price                 |
| 8     | `LowerStrikePrice`    | Lower strike price                 |
| 9     | `OutstandingQuantity` | Outstanding quantity               |
| 10    | `OutstandingRatio`    | Outstanding ratio                  |
| 11    | `Premium`             | Premium                            |
| 12    | `ItmOtm`              | In/out of the bound                |
| 13    | `ImpliedVolatility`   | Implied volatility                 |
| 14    | `Delta`               | Greek value delta                  |
| 15    | `CallPrice`           | Call price                         |
| 16    | `ToCallPrice`         | Price interval from the call price |
| 17    | `EffectiveLeverage`   | Effective leverage                 |
| 18    | `LeverageRatio`       | Leverage ratio                     |
| 19    | `ConversionRatio`     | Conversion ratio                   |
| 20    | `BalancePoint`        | Breakeven point                    |
| 21    | `Status`              | Status                             |

### WarrantStatus

| Value | Member        | Description  |
| ----- | ------------- | ------------ |
| 0     | `Suspend`     | Suspend      |
| 1     | `PrepareList` | Prepare List |
| 2     | `Normal`      | Normal       |

### WarrantType

| Value | Member    | Description |
| ----- | --------- | ----------- |
| 0     | `Unknown` | Unknown     |
| 1     | `Call`    | Call        |
| 2     | `Put`     | Put         |
| 3     | `Bull`    | Bull        |
| 4     | `Bear`    | Bear        |
| 5     | `Inline`  | Inline      |

## Trade / order / account

### BalanceType

| Value | Member    | Description |
| ----- | --------- | ----------- |
| 0     | `Unknown` | Unknown     |
| 1     | `Cash`    | Cash        |
| 2     | `Stock`   | Stock       |
| 3     | `Fund`    | Fund        |

### CashFlowDirection

| Value | Member    | Description |
| ----- | --------- | ----------- |
| 0     | `Unknown` | Unknown     |
| 1     | `Out`     | Out         |
| 2     | `In`      | In          |

### ChargeCategoryCode

| Value | Member    | Description |
| ----- | --------- | ----------- |
| 0     | `Unknown` | Unknown     |
| 1     | `Broker`  | Broker      |
| 2     | `Third`   | Third       |

### CommissionFreeStatus

| Value | Member       | Description                             |
| ----- | ------------ | --------------------------------------- |
| 0     | `Unknown`    | Unknown                                 |
| 1     | `None`       | None                                    |
| 2     | `Calculated` | Commission-free amount to be calculated |
| 3     | `Pending`    | Pending commission-free                 |
| 4     | `Ready`      | Commission-free applied                 |

### DeductionStatus

| Value | Member    | Description                      |
| ----- | --------- | -------------------------------- |
| 0     | `Unknown` | Unknown                          |
| 1     | `None`    | Pending Settlement               |
| 2     | `NoData`  | Settled with no data             |
| 3     | `Pending` | Settled and pending distribution |
| 4     | `Done`    | Settled and distributed          |

### OrderSide

| Value | Member    | Description |
| ----- | --------- | ----------- |
| 0     | `Unknown` | Unknown     |
| 1     | `Buy`     | Buy         |
| 2     | `Sell`    | Sell        |

### OrderStatus

| Value | Member                 | Description                      |
| ----- | ---------------------- | -------------------------------- |
| 0     | `Unknown`              | Unknown                          |
| 1     | `NotReported`          | Not reported                     |
| 2     | `ReplacedNotReported`  | Not reported (Replaced Order)    |
| 3     | `ProtectedNotReported` | Not reported (Protected Order)   |
| 4     | `VarietiesNotReported` | Not reported (Conditional Order) |
| 5     | `Filled`               | Filled                           |
| 6     | `WaitToNew`            | Wait To New                      |
| 7     | `New`                  | New                              |
| 8     | `WaitToReplace`        | Wait To Replace                  |
| 9     | `PendingReplace`       | Pending Replace                  |
| 10    | `Replaced`             | Replaced                         |
| 11    | `PartialFilled`        | Partial Filled                   |
| 12    | `WaitToCancel`         | Wait To Cancel                   |
| 13    | `PendingCancel`        | Pending Cancel                   |
| 14    | `Rejected`             | Rejected                         |
| 15    | `Canceled`             | Canceled                         |
| 16    | `Expired`              | Expired                          |
| 17    | `PartialWithdrawal`    | Partial Withdrawal               |

### OrderTag

| Value | Member         | Description               |
| ----- | -------------- | ------------------------- |
| 0     | `Unknown`      | Unknown                   |
| 1     | `Normal`       | Normal Order              |
| 2     | `LongTerm`     | Long term Order           |
| 3     | `Grey`         | Grey Order                |
| 4     | `MarginCall`   | Force Selling             |
| 5     | `Offline`      | OTC                       |
| 6     | `Creditor`     | Option Exercise Long      |
| 7     | `Debtor`       | Option Exercise Short     |
| 8     | `NonExercise`  | Wavier Of Option Exercise |
| 9     | `AllocatedSub` | Trade Allocation          |

### OrderType

| Value | Member    | Description                                   |
| ----- | --------- | --------------------------------------------- |
| 0     | `Unknown` | Unknown                                       |
| 1     | `LO`      | Limit Order                                   |
| 2     | `ELO`     | Enhanced Limit Order                          |
| 3     | `MO`      | Market Order                                  |
| 4     | `AO`      | At-auction Order                              |
| 5     | `ALO`     | At-auction Limit Order                        |
| 6     | `ODD`     | Odd Lots                                      |
| 7     | `LIT`     | Limit If Touched                              |
| 8     | `MIT`     | Market If Touched                             |
| 9     | `TSLPAMT` | Trailing Limit If Touched (Trailing Amount)   |
| 10    | `TSLPPCT` | Trailing Limit If Touched (Trailing Percent)  |
| 11    | `TSMAMT`  | Trailing Market If Touched (Trailing Amount)  |
| 12    | `TSMPCT`  | Trailing Market If Touched (Trailing Percent) |
| 13    | `SLO`     | Special Limit Order                           |

### OutsideRTH

| Value | Member      | Description               |
| ----- | ----------- | ------------------------- |
| 0     | `Unknown`   | Unknown                   |
| 1     | `RTHOnly`   | Regular trading hour only |
| 2     | `AnyTime`   | Any time                  |
| 3     | `Overnight` | Overnight                 |

### TimeInForceType

| Value | Member            | Description             |
| ----- | ----------------- | ----------------------- |
| 0     | `Unknown`         | Unknown                 |
| 1     | `Day`             | Day Order               |
| 2     | `GoodTilCanceled` | Good Til Canceled Order |
| 3     | `GoodTilDate`     | Good Til Date Order     |

### TopicType

| Value | Member    | Description                    |
| ----- | --------- | ------------------------------ |
| 0     | `Private` | Private notification for trade |

### TriggerStatus

| Value | Member     | Description |
| ----- | ---------- | ----------- |
| 0     | `Unknown`  | Unknown     |
| 1     | `Deactive` | Deactive    |
| 2     | `Active`   | Active      |
| 3     | `Released` | Released    |

## Calculated indexes

### CalcIndex

| Value | Member                  | Description                        |
| ----- | ----------------------- | ---------------------------------- |
| 0     | `LastDone`              | Latest price                       |
| 1     | `ChangeValue`           | Change value                       |
| 2     | `ChangeRate`            | Change rate                        |
| 3     | `Volume`                | Volume                             |
| 4     | `Turnover`              | Turnover                           |
| 5     | `YtdChangeRate`         | Year-to-date change ratio          |
| 6     | `TurnoverRate`          | Turnover rate                      |
| 7     | `TotalMarketValue`      | Total market value                 |
| 8     | `CapitalFlow`           | Capital flow                       |
| 9     | `Amplitude`             | Amplitude                          |
| 10    | `VolumeRatio`           | Volume ratio                       |
| 11    | `PeTtmRatio`            | PE (TTM)                           |
| 12    | `PbRatio`               | PB                                 |
| 13    | `DividendRatioTtm`      | Dividend ratio (TTM)               |
| 14    | `FiveDayChangeRate`     | Five days change ratio             |
| 15    | `TenDayChangeRate`      | Ten days change ratio              |
| 16    | `HalfYearChangeRate`    | Half year change ratio             |
| 17    | `FiveMinutesChangeRate` | Five minutes change ratio          |
| 18    | `ExpiryDate`            | Expiry date                        |
| 19    | `StrikePrice`           | Strike price                       |
| 20    | `UpperStrikePrice`      | Upper bound price                  |
| 21    | `LowerStrikePrice`      | Lower bound price                  |
| 22    | `OutstandingQty`        | Outstanding quantity               |
| 23    | `OutstandingRatio`      | Outstanding ratio                  |
| 24    | `Premium`               | Premium                            |
| 25    | `ItmOtm`                | In/out of the bound                |
| 26    | `ImpliedVolatility`     | Implied volatility                 |
| 27    | `WarrantDelta`          | Warrant delta                      |
| 28    | `CallPrice`             | Call price                         |
| 29    | `ToCallPrice`           | Price interval from the call price |
| 30    | `EffectiveLeverage`     | Effective leverage                 |
| 31    | `LeverageRatio`         | Leverage ratio                     |
| 32    | `ConversionRatio`       | Conversion ratio                   |
| 33    | `BalancePoint`          | Breakeven point                    |
| 34    | `OpenInterest`          | Open interest                      |
| 35    | `Delta`                 | Delta                              |
| 36    | `Gamma`                 | Gamma                              |
| 37    | `Theta`                 | Theta                              |
| 38    | `Vega`                  | Vega                               |
| 39    | `Rho`                   | Rho                                |

## Warrant filters

### FilterWarrantExpiryDate

| Value | Member         | Description            |
| ----- | -------------- | ---------------------- |
| 0     | `LT_3`         | Less than 3 months     |
| 1     | `Between_3_6`  | 3 - 6 months           |
| 2     | `Between_6_12` | 6 - 12 months          |
| 3     | `GT_12`        | Greater than 12 months |

### FilterWarrantInOutBoundsType

| Value | Member | Description |
| ----- | ------ | ----------- |
| 0     | `In`   | In bounds   |
| 1     | `Out`  | Out bounds  |

## Audit note

- This file keeps official enum names, numeric values, and comments as documented.
- Some official descriptions include unusual spellings or wording (for example `USNSDQ` comment `Nasdsaq Index`, `USOptionS` comment `US Sepecial Option`, and `TradeStatus.Suspend` sharing `Warrant To BeListed`); these are preserved verbatim without local normalization.
