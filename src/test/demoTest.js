import  {Config, QuoteContext, Period, AdjustType, TradeSessions} from "longport"

let config = Config.fromEnv()
QuoteContext.new(config)
  .then((ctx) => ctx.candlesticks("HSI.HK", Period.Min_1, 200, AdjustType.NoAdjust, TradeSessions.Intraday))
  .then((resp) => {
    for (let obj of resp) {
      console.log(obj.toString());
    }
  })