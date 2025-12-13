import {
  Config,
  Period,
  AdjustType,
  TradeSessions,
  NaiveDate,
  QuoteContext,
} from "longport";

let config = Config.fromEnv();

const startNaiveDate = new NaiveDate(2025, 12, 11);
const endNaiveDate = new NaiveDate(2025, 12, 12);

QuoteContext.new(config)
  .then((ctx) =>
    ctx.historyCandlesticksByDate(
      "54806.HK",
      Period.Min_1,
      AdjustType.NoAdjust,
      startNaiveDate,
      endNaiveDate,
      TradeSessions.All
    )
  )
  .then((resp) => {
    for (let obj of resp) {
      console.log(obj.toString());
    }
  });
