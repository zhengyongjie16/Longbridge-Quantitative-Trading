import { QuoteContext, Config, TradeSessions } from "longport";

let config = Config.fromEnv();
QuoteContext.new(config)
  .then((ctx) => ctx.intraday("HSI.HK", TradeSessions.Intraday))
  .then((resp) => {
    for (let obj of resp) {
      console.log(obj.toString());
    }
  });
