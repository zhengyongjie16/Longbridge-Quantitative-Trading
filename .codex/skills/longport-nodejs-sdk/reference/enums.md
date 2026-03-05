# 枚举类型完整定义

## SubType - 订阅类型

| 值  | 名称              | 说明       |
| --- | ----------------- | ---------- |
| 0   | `SubType.Quote`   | 实时报价   |
| 1   | `SubType.Depth`   | 盘口深度   |
| 2   | `SubType.Brokers` | 经纪商分布 |
| 3   | `SubType.Trade`   | 逐笔成交   |

## OrderType - 订单类型

| 值  | 名称                | 说明                                                         |
| --- | ------------------- | ------------------------------------------------------------ |
| 0   | `OrderType.Unknown` | 未知                                                         |
| 1   | `OrderType.LO`      | 限价单 (Limit Order)                                         |
| 2   | `OrderType.ELO`     | 增强限价单 (Enhanced Limit Order)                            |
| 3   | `OrderType.MO`      | 市价单 (Market Order)                                        |
| 4   | `OrderType.AO`      | 竞价单 (At-auction Order)                                    |
| 5   | `OrderType.ALO`     | 竞价限价单 (At-auction Limit Order)                          |
| 6   | `OrderType.ODD`     | 碎股单 (Odd Lots)                                            |
| 7   | `OrderType.LIT`     | 触价限价单 (Limit If Touched)                                |
| 8   | `OrderType.MIT`     | 触价市价单 (Market If Touched)                               |
| 9   | `OrderType.TSLPAMT` | 跟踪止损限价单-金额 (Trailing Limit If Touched - Amount)     |
| 10  | `OrderType.TSLPPCT` | 跟踪止损限价单-百分比 (Trailing Limit If Touched - Percent)  |
| 11  | `OrderType.TSMAMT`  | 跟踪止损市价单-金额 (Trailing Market If Touched - Amount)    |
| 12  | `OrderType.TSMPCT`  | 跟踪止损市价单-百分比 (Trailing Market If Touched - Percent) |
| 13  | `OrderType.SLO`     | 特殊限价单 (Special Limit Order)                             |

## OrderSide - 买卖方向

| 值  | 名称                | 说明 |
| --- | ------------------- | ---- |
| 0   | `OrderSide.Unknown` | 未知 |
| 1   | `OrderSide.Buy`     | 买入 |
| 2   | `OrderSide.Sell`    | 卖出 |

## OrderStatus - 订单状态

| 值  | 名称                               | 说明               |
| --- | ---------------------------------- | ------------------ |
| 0   | `OrderStatus.Unknown`              | 未知               |
| 1   | `OrderStatus.NotReported`          | 待提交             |
| 2   | `OrderStatus.ReplacedNotReported`  | 待提交（改单）     |
| 3   | `OrderStatus.ProtectedNotReported` | 待提交（保护订单） |
| 4   | `OrderStatus.VarietiesNotReported` | 待提交（条件订单） |
| 5   | `OrderStatus.Filled`               | 已成交             |
| 6   | `OrderStatus.WaitToNew`            | 等待新订单         |
| 7   | `OrderStatus.New`                  | 新订单             |
| 8   | `OrderStatus.WaitToReplace`        | 等待改单           |
| 9   | `OrderStatus.PendingReplace`       | 改单待确认         |
| 10  | `OrderStatus.Replaced`             | 已改单             |
| 11  | `OrderStatus.PartialFilled`        | 部分成交           |
| 12  | `OrderStatus.WaitToCancel`         | 等待撤单           |
| 13  | `OrderStatus.PendingCancel`        | 撤单待确认         |
| 14  | `OrderStatus.Rejected`             | 已拒绝             |
| 15  | `OrderStatus.Canceled`             | 已撤单             |
| 16  | `OrderStatus.Expired`              | 已过期             |
| 17  | `OrderStatus.PartialWithdrawal`    | 部分撤单           |

## TimeInForceType - 订单有效期

| 值  | 名称                              | 说明               |
| --- | --------------------------------- | ------------------ |
| 0   | `TimeInForceType.Unknown`         | 未知               |
| 1   | `TimeInForceType.Day`             | 当日有效           |
| 2   | `TimeInForceType.GoodTilCanceled` | 撤单前有效 (GTC)   |
| 3   | `TimeInForceType.GoodTilDate`     | 到期日前有效 (GTD) |

## Market - 市场

| 值  | 名称             | 说明         |
| --- | ---------------- | ------------ |
| 0   | `Market.Unknown` | 未知         |
| 1   | `Market.US`      | 美股市场     |
| 2   | `Market.HK`      | 港股市场     |
| 3   | `Market.CN`      | A 股市场     |
| 4   | `Market.SG`      | 新加坡市场   |
| 5   | `Market.Crypto`  | 加密货币市场 |

## Period - K 线周期

| 值  | 名称             | 说明    |
| --- | ---------------- | ------- |
| 0   | `Period.Unknown` | 未知    |
| 1   | `Period.Min_1`   | 1 分钟  |
| 2   | `Period.Min_2`   | 2 分钟  |
| 3   | `Period.Min_3`   | 3 分钟  |
| 4   | `Period.Min_5`   | 5 分钟  |
| 5   | `Period.Min_10`  | 10 分钟 |
| 6   | `Period.Min_15`  | 15 分钟 |
| 7   | `Period.Min_20`  | 20 分钟 |
| 8   | `Period.Min_30`  | 30 分钟 |
| 9   | `Period.Min_45`  | 45 分钟 |
| 10  | `Period.Min_60`  | 1 小时  |
| 11  | `Period.Min_120` | 2 小时  |
| 12  | `Period.Min_180` | 3 小时  |
| 13  | `Period.Min_240` | 4 小时  |
| 14  | `Period.Day`     | 日 K    |
| 15  | `Period.Week`    | 周 K    |
| 16  | `Period.Month`   | 月 K    |
| 17  | `Period.Quarter` | 季 K    |
| 18  | `Period.Year`    | 年 K    |

## AdjustType - 复权类型

| 值  | 名称                       | 说明   |
| --- | -------------------------- | ------ |
| 0   | `AdjustType.NoAdjust`      | 不复权 |
| 1   | `AdjustType.ForwardAdjust` | 前复权 |

## TopicType - 交易推送主题

| 值  | 名称                | 说明         |
| --- | ------------------- | ------------ |
| 0   | `TopicType.Private` | 私有交易通知 |

## TradeSessions - 交易时段（查询参数）

| 值  | 名称                     | 说明     |
| --- | ------------------------ | -------- |
| 0   | `TradeSessions.Intraday` | 仅盘中   |
| 1   | `TradeSessions.All`      | 所有时段 |

## TradeSession - 交易时段（数据属性）

| 值  | 名称                     | 说明 |
| --- | ------------------------ | ---- |
| 0   | `TradeSession.Intraday`  | 盘中 |
| 1   | `TradeSession.Pre`       | 盘前 |
| 2   | `TradeSession.Post`      | 盘后 |
| 3   | `TradeSession.Overnight` | 夜盘 |

## TradeDirection - 成交方向

| 值  | 名称                     | 说明 |
| --- | ------------------------ | ---- |
| 0   | `TradeDirection.Neutral` | 中性 |
| 1   | `TradeDirection.Down`    | 下跌 |
| 2   | `TradeDirection.Up`      | 上涨 |

## TradeStatus - 交易状态

| 值  | 名称                             | 说明       |
| --- | -------------------------------- | ---------- |
| 0   | `TradeStatus.Normal`             | 正常       |
| 1   | `TradeStatus.Halted`             | 停牌       |
| 2   | `TradeStatus.Delisted`           | 退市       |
| 3   | `TradeStatus.Fuse`               | 熔断       |
| 4   | `TradeStatus.PrepareList`        | 待上市     |
| 5   | `TradeStatus.CodeMoved`          | 代码变更   |
| 6   | `TradeStatus.ToBeOpened`         | 待开盘     |
| 7   | `TradeStatus.SplitStockHalts`    | 拆合股停牌 |
| 8   | `TradeStatus.Expired`            | 已过期     |
| 9   | `TradeStatus.WarrantPrepareList` | 轮证待上市 |
| 10  | `TradeStatus.Suspend`            | 停牌中     |

## OutsideRTH - 盘前盘后交易

| 值  | 名称                   | 说明           |
| --- | ---------------------- | -------------- |
| 0   | `OutsideRTH.Unknown`   | 未知           |
| 1   | `OutsideRTH.RTHOnly`   | 仅正常交易时段 |
| 2   | `OutsideRTH.AnyTime`   | 任何时段       |
| 3   | `OutsideRTH.Overnight` | 夜盘           |

## Language - 语言

| 值  | 名称             | 说明     |
| --- | ---------------- | -------- |
| 0   | `Language.ZH_CN` | 简体中文 |
| 1   | `Language.ZH_HK` | 繁体中文 |
| 2   | `Language.EN`    | 英语     |

## PushCandlestickMode - K 线推送模式

| 值  | 名称                            | 说明     |
| --- | ------------------------------- | -------- |
| 0   | `PushCandlestickMode.Realtime`  | 实时模式 |
| 1   | `PushCandlestickMode.Confirmed` | 确认模式 |

## WarrantType - 轮证类型

| 值  | 名称                  | 说明   |
| --- | --------------------- | ------ |
| 0   | `WarrantType.Unknown` | 未知   |
| 1   | `WarrantType.Call`    | 认购证 |
| 2   | `WarrantType.Put`     | 认沽证 |
| 3   | `WarrantType.Bull`    | 牛证   |
| 4   | `WarrantType.Bear`    | 熊证   |
| 5   | `WarrantType.Inline`  | 界内证 |

## WarrantSortBy - 轮证排序

| 值  | 名称                                | 说明      |
| --- | ----------------------------------- | --------- |
| 0   | `WarrantSortBy.LastDone`            | 最新价    |
| 1   | `WarrantSortBy.ChangeRate`          | 涨跌幅    |
| 2   | `WarrantSortBy.ChangeValue`         | 涨跌额    |
| 3   | `WarrantSortBy.Volume`              | 成交量    |
| 4   | `WarrantSortBy.Turnover`            | 成交额    |
| 5   | `WarrantSortBy.ExpiryDate`          | 到期日    |
| 6   | `WarrantSortBy.StrikePrice`         | 行权价    |
| 7   | `WarrantSortBy.UpperStrikePrice`    | 上限价    |
| 8   | `WarrantSortBy.LowerStrikePrice`    | 下限价    |
| 9   | `WarrantSortBy.OutstandingQuantity` | 街货量    |
| 10  | `WarrantSortBy.OutstandingRatio`    | 街货比    |
| 11  | `WarrantSortBy.Premium`             | 溢价      |
| 12  | `WarrantSortBy.ItmOtm`              | 价内/价外 |
| 13  | `WarrantSortBy.ImpliedVolatility`   | 引伸波幅  |
| 14  | `WarrantSortBy.Delta`               | Delta     |
| 15  | `WarrantSortBy.CallPrice`           | 收回价    |
| 16  | `WarrantSortBy.ToCallPrice`         | 距收回价  |
| 17  | `WarrantSortBy.EffectiveLeverage`   | 有效杠杆  |
| 18  | `WarrantSortBy.LeverageRatio`       | 杠杆比率  |
| 19  | `WarrantSortBy.ConversionRatio`     | 换股比率  |
| 20  | `WarrantSortBy.BalancePoint`        | 打和点    |
| 21  | `WarrantSortBy.Status`              | 状态      |

## SortOrderType - 排序方向

| 值  | 名称                       | 说明 |
| --- | -------------------------- | ---- |
| 0   | `SortOrderType.Ascending`  | 升序 |
| 1   | `SortOrderType.Descending` | 降序 |

## WarrantStatus - 轮证状态

| 值  | 名称                        | 说明   |
| --- | --------------------------- | ------ |
| 0   | `WarrantStatus.Suspend`     | 停牌   |
| 1   | `WarrantStatus.PrepareList` | 待上市 |
| 2   | `WarrantStatus.Normal`      | 正常   |

## FilterWarrantExpiryDate - 轮证到期日筛选

| 值  | 名称                                   | 说明        |
| --- | -------------------------------------- | ----------- |
| 0   | `FilterWarrantExpiryDate.LT_3`         | 3 个月内    |
| 1   | `FilterWarrantExpiryDate.Between_3_6`  | 3-6 个月    |
| 2   | `FilterWarrantExpiryDate.Between_6_12` | 6-12 个月   |
| 3   | `FilterWarrantExpiryDate.GT_12`        | 12 个月以上 |

## FilterWarrantInOutBoundsType - 价内价外筛选

| 值  | 名称                               | 说明 |
| --- | ---------------------------------- | ---- |
| 0   | `FilterWarrantInOutBoundsType.In`  | 价内 |
| 1   | `FilterWarrantInOutBoundsType.Out` | 价外 |

## SecurityListCategory - 证券列表分类

| 值  | 名称                             | 说明     |
| --- | -------------------------------- | -------- |
| 0   | `SecurityListCategory.Overnight` | 夜盘证券 |

## OrderTag - 订单标签

| 值  | 名称                    | 说明         |
| --- | ----------------------- | ------------ |
| 0   | `OrderTag.Unknown`      | 未知         |
| 1   | `OrderTag.Normal`       | 普通订单     |
| 2   | `OrderTag.LongTerm`     | 长期订单     |
| 3   | `OrderTag.Grey`         | 暗盘订单     |
| 4   | `OrderTag.MarginCall`   | 强制平仓     |
| 5   | `OrderTag.Offline`      | 柜台         |
| 6   | `OrderTag.Creditor`     | 期权行权多头 |
| 7   | `OrderTag.Debtor`       | 期权行权空头 |
| 8   | `OrderTag.NonExercise`  | 期权豁免行权 |
| 9   | `OrderTag.AllocatedSub` | 交易配售     |

## TriggerStatus - 条件单触发状态

| 值  | 名称                     | 说明   |
| --- | ------------------------ | ------ |
| 0   | `TriggerStatus.Unknown`  | 未知   |
| 1   | `TriggerStatus.Deactive` | 未激活 |
| 2   | `TriggerStatus.Active`   | 已激活 |
| 3   | `TriggerStatus.Released` | 已触发 |

## BalanceType - 资金类型

| 值  | 名称                  | 说明 |
| --- | --------------------- | ---- |
| 0   | `BalanceType.Unknown` | 未知 |
| 1   | `BalanceType.Cash`    | 现金 |
| 2   | `BalanceType.Stock`   | 股票 |
| 3   | `BalanceType.Fund`    | 基金 |

## CashFlowDirection - 资金流向

| 值  | 名称                        | 说明 |
| --- | --------------------------- | ---- |
| 0   | `CashFlowDirection.Unknown` | 未知 |
| 1   | `CashFlowDirection.Out`     | 流出 |
| 2   | `CashFlowDirection.In`      | 流入 |

## DerivativeType - 衍生品类型

| 值  | 名称                     | 说明     |
| --- | ------------------------ | -------- |
| 0   | `DerivativeType.Option`  | 美股期权 |
| 1   | `DerivativeType.Warrant` | 港股轮证 |

## SecurityBoard - 证券板块

| 值  | 名称                             | 说明                   |
| --- | -------------------------------- | ---------------------- |
| 0   | `SecurityBoard.Unknown`          | 未知                   |
| 1   | `SecurityBoard.USMain`           | 美国主板               |
| 2   | `SecurityBoard.USPink`           | 美国粉单               |
| 3   | `SecurityBoard.USDJI`            | 道琼斯指数             |
| 4   | `SecurityBoard.USNSDQ`           | 纳斯达克指数           |
| 5   | `SecurityBoard.USSector`         | 美国行业板块           |
| 6   | `SecurityBoard.USOption`         | 美股期权               |
| 7   | `SecurityBoard.USOptionS`        | 美股特殊期权           |
| 8   | `SecurityBoard.HKEquity`         | 港股主板               |
| 9   | `SecurityBoard.HKPreIPO`         | 港股暗盘               |
| 10  | `SecurityBoard.HKWarrant`        | 港股轮证               |
| 11  | `SecurityBoard.HKHS`             | 恒生指数               |
| 12  | `SecurityBoard.HKSector`         | 港股行业板块           |
| 13  | `SecurityBoard.SHMainConnect`    | 沪市主板(互联互通)     |
| 14  | `SecurityBoard.SHMainNonConnect` | 沪市主板(非互联互通)   |
| 15  | `SecurityBoard.SHSTAR`           | 沪市科创板             |
| 16  | `SecurityBoard.CNIX`             | A 股指数               |
| 17  | `SecurityBoard.CNSector`         | A 股行业板块           |
| 18  | `SecurityBoard.SZMainConnect`    | 深市主板(互联互通)     |
| 19  | `SecurityBoard.SZMainNonConnect` | 深市主板(非互联互通)   |
| 20  | `SecurityBoard.SZGEMConnect`     | 深市创业板(互联互通)   |
| 21  | `SecurityBoard.SZGEMNonConnect`  | 深市创业板(非互联互通) |
| 22  | `SecurityBoard.SGMain`           | 新加坡主板             |
| 23  | `SecurityBoard.STI`              | 海峡时报指数           |
| 24  | `SecurityBoard.SGSector`         | 新加坡行业板块         |
| 25  | `SecurityBoard.SPXIndex`         | 标普500指数            |
| 26  | `SecurityBoard.VIXIndex`         | VIX 波动率指数         |

## CommissionFreeStatus - 免佣状态

| 值  | 名称                              | 说明   |
| --- | --------------------------------- | ------ |
| 0   | `CommissionFreeStatus.Unknown`    | 未知   |
| 1   | `CommissionFreeStatus.None`       | 无     |
| 2   | `CommissionFreeStatus.Calculated` | 待计算 |
| 3   | `CommissionFreeStatus.Pending`    | 待结算 |
| 4   | `CommissionFreeStatus.Ready`      | 已生效 |

## DeductionStatus - 扣费状态

| 值  | 名称                      | 说明         |
| --- | ------------------------- | ------------ |
| 0   | `DeductionStatus.Unknown` | 未知         |
| 1   | `DeductionStatus.None`    | 待结算       |
| 2   | `DeductionStatus.NoData`  | 已结算无数据 |
| 3   | `DeductionStatus.Pending` | 已结算待分配 |
| 4   | `DeductionStatus.Done`    | 已结算已分配 |

## CalcIndex - 计算指标

| 值  | 名称                              | 说明           |
| --- | --------------------------------- | -------------- |
| 0   | `CalcIndex.LastDone`              | 最新价         |
| 1   | `CalcIndex.ChangeValue`           | 涨跌额         |
| 2   | `CalcIndex.ChangeRate`            | 涨跌幅         |
| 3   | `CalcIndex.Volume`                | 成交量         |
| 4   | `CalcIndex.Turnover`              | 成交额         |
| 5   | `CalcIndex.YtdChangeRate`         | 年初至今涨跌幅 |
| 6   | `CalcIndex.TurnoverRate`          | 换手率         |
| 7   | `CalcIndex.TotalMarketValue`      | 总市值         |
| 8   | `CalcIndex.CapitalFlow`           | 资金流向       |
| 9   | `CalcIndex.Amplitude`             | 振幅           |
| 10  | `CalcIndex.VolumeRatio`           | 量比           |
| 11  | `CalcIndex.PeTtmRatio`            | 市盈率(TTM)    |
| 12  | `CalcIndex.PbRatio`               | 市净率         |
| 13  | `CalcIndex.DividendRatioTtm`      | 股息率(TTM)    |
| 14  | `CalcIndex.FiveDayChangeRate`     | 5 日涨跌幅     |
| 15  | `CalcIndex.TenDayChangeRate`      | 10 日涨跌幅    |
| 16  | `CalcIndex.HalfYearChangeRate`    | 半年涨跌幅     |
| 17  | `CalcIndex.FiveMinutesChangeRate` | 5 分钟涨跌幅   |
| 18  | `CalcIndex.ExpiryDate`            | 到期日         |
| 19  | `CalcIndex.StrikePrice`           | 行权价         |
| 20  | `CalcIndex.UpperStrikePrice`      | 上限价         |
| 21  | `CalcIndex.LowerStrikePrice`      | 下限价         |
| 22  | `CalcIndex.OutstandingQty`        | 街货量         |
| 23  | `CalcIndex.OutstandingRatio`      | 街货比         |
| 24  | `CalcIndex.Premium`               | 溢价           |
| 25  | `CalcIndex.ItmOtm`                | 价内/价外      |
| 26  | `CalcIndex.ImpliedVolatility`     | 引伸波幅       |
| 27  | `CalcIndex.WarrantDelta`          | 轮证 Delta     |
| 28  | `CalcIndex.CallPrice`             | 收回价         |
| 29  | `CalcIndex.ToCallPrice`           | 距收回价       |
| 30  | `CalcIndex.EffectiveLeverage`     | 有效杠杆       |
| 31  | `CalcIndex.LeverageRatio`         | 杠杆比率       |
| 32  | `CalcIndex.ConversionRatio`       | 换股比率       |
| 33  | `CalcIndex.BalancePoint`          | 打和点         |
| 34  | `CalcIndex.OpenInterest`          | 未平仓数       |
| 35  | `CalcIndex.Delta`                 | Delta          |
| 36  | `CalcIndex.Gamma`                 | Gamma          |
| 37  | `CalcIndex.Theta`                 | Theta          |
| 38  | `CalcIndex.Vega`                  | Vega           |
| 39  | `CalcIndex.Rho`                   | Rho            |
