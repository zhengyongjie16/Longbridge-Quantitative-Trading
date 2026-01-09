import {
  Config,
  TradeContext,
  OrderStatus,
  OrderSide,
  Market,
} from "longport";
import dotenv from "dotenv";

// 加载环境变量（从 .env.local 文件）
dotenv.config({ path: ".env.local" });

let config = Config.fromEnv();
TradeContext.new(config)
  .then((ctx) =>
    ctx.todayOrders({
      symbol: "64042.HK",
      status: [OrderStatus.Filled, OrderStatus.New],
      side: OrderSide.Buy,
      market: Market.HK,
    })
  )
  .then((resp) => {
    for (let obj of resp) {
      console.log(obj.toString());
    }
  });