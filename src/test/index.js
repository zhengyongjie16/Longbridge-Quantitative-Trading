import { OrderStatus, Config, TradeContext, Market, OrderSide } from "longport";

let config = Config.fromEnv();
TradeContext.new(config)
  .then((ctx) =>
    ctx.todayOrders({
      symbol: "69650.HK",
      status: [OrderStatus.Filled],
      side: OrderSide.Buy,
      market: Market.HK,
    })
  )
  .then((resp) => {
    for (let obj of resp) {
      console.log(obj.toJSON());
    }
  });
