import { Config, TradeContext, OrderStatus, OrderSide, Market } from "longport";

let config = Config.fromEnv();
TradeContext.new(config)
  .then((ctx) =>
    ctx.todayOrders({
      symbol: "53086.HK",
      status: [OrderStatus.Filled, OrderStatus.New],
      market: Market.HK,
    })
  )
  .then((resp) => {
    for (let obj of resp) {
      console.log(obj.toString());
    }
  });
