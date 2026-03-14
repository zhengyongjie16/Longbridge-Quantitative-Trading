---
name: longbridge-nodejs-sdk
description: 当用户请求查询或对照 Longbridge OpenAPI Node.js SDK 官方文档时触发。
---

# Longbridge OpenAPI SDK for Node.js

- NPM package: `longbridge`
- Official documentation: https://longbridge.github.io/openapi/nodejs/index.html

## Quickstart

```bash
bun install longbridge
```

```ts
import { OAuth, Config, QuoteContext } from 'longbridge';

const oauth = await OAuth.build('your-client-id', (_, url) => {
  console.log('Open this URL in your browser:', url);
});

const config = Config.fromOAuth(oauth);
const quoteContext = await QuoteContext.new(config);
const quotes = await quoteContext.quote(['700.HK']);
console.log(quotes[0]);
```

## Documentation Map

- [Authentication / Config / OAuth / ExtraConfigParams](./reference/config.md)
- [HttpClient](./reference/http-client.md)
- [QuoteContext](./reference/quote-context.md)
- [TradeContext](./reference/trade-context.md)
- [Decimal / NaiveDate / NaiveDatetime / Time](./reference/decimal.md)
- [Enumerations](./reference/enums.md)
- [Quote Types](./reference/types/quote-types.md)
- [Trade Types](./reference/types/trade-types.md)

## Authentication

Longbridge OpenAPI supports:

1. OAuth 2.0 (recommended)
2. Legacy API Key (environment variables)

See [reference/config.md](./reference/config.md) for official setup details.

## Quote API (Get basic information of securities)

```ts
import { OAuth, Config, QuoteContext } from 'longbridge';

const oauth = await OAuth.build('your-client-id', (_, url) => console.log(url));
const config = Config.fromOAuth(oauth);
const ctx = await QuoteContext.new(config);
const quotes = await ctx.quote(['700.HK']);
console.log(quotes);
```

## Quote API (Subscribe quotes)

```ts
import { OAuth, Config, QuoteContext, SubType } from 'longbridge';

const oauth = await OAuth.build('your-client-id', (_, url) => console.log(url));
const config = Config.fromOAuth(oauth);
const ctx = await QuoteContext.new(config);

ctx.setOnQuote((err, event) => {
  if (err) {
    console.error(err);
    return;
  }
  console.log(event.symbol, event.data);
});

await ctx.subscribe(['700.HK'], [SubType.Quote]);
```

## Trade API (Submit order)

```ts
import {
  OAuth,
  Config,
  TradeContext,
  Decimal,
  OrderType,
  OrderSide,
  TimeInForceType,
} from 'longbridge';

const oauth = await OAuth.build('your-client-id', (_, url) => console.log(url));
const config = Config.fromOAuth(oauth);
const ctx = await TradeContext.new(config);

const result = await ctx.submitOrder({
  symbol: '700.HK',
  orderType: OrderType.LO,
  side: OrderSide.Buy,
  timeInForce: TimeInForceType.Day,
  submittedQuantity: new Decimal('100'),
  submittedPrice: new Decimal('300'),
});

console.log(result.orderId);
```

## Official Examples

Official homepage examples (`examples/nodejs/`):

- `account_asset.js`
- `http_client.js`
- `subscribe_candlesticks.js`
- `subscribe_quote.js`
- `submit_order.js`
- `today_orders.js`

## Troubleshooting

Official troubleshooting notes:

- On Windows, `setx` requires opening a new terminal; use `set` for the current `cmd.exe` session.
- Push events require the Node process to keep running.
- For SDK debugging logs, set `LONGBRIDGE_LOG_PATH`.

## License

Longbridge OpenAPI Node.js SDK is licensed under either:

- Apache License, Version 2.0
- MIT license

at your option.
