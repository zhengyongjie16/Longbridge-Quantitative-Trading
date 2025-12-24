---
id: push_broker
title: Push Real-time Brokers
slug: broker
sidebar_position: 3
---

Real-time brokers data push of the subscribed security.


## SDK

| Language | Link |
|---|---|
| Python | [longport.openapi.quote._quote_context](https://longportapp.github.io/openapi/python/reference_all/#longport.openapi.quote._quote_context) |
| Rust | [longport::<SDKLinks module="quote" klass="QuoteContext" method="set_on_brokers" go="OnBrokers" />::quote#_quote_context](https://longportapp.github.io/openapi/rust/longport/<SDKLinks module="quote" klass="QuoteContext" method="set_on_brokers" go="OnBrokers" />/struct.quote.html#method._quote_context) |
| Go | [quote.set_on_brokers](https://pkg.go.dev/github.com/longportapp/openapi-go/<SDKLinks module="quote" klass="QuoteContext" method="set_on_brokers" go="OnBrokers" />#quote.set_on_brokers) |
| Node.js | [quote#QuoteContext](https://longportapp.github.io/openapi/nodejs/classes/quote.html#quotecontext) |
| Java | [quote.getQuoteContext](https://longportapp.github.io/openapi/java/com/longport/<SDKLinks module="quote" klass="QuoteContext" method="set_on_brokers" go="OnBrokers" />/quote.html#OnBrokers) |

:::info

[Business Command](../../socket/protocol/push): `103`

:::

## Data Format

### Properties

| Name         | Type     | Description                           |
|--------------|----------|---------------------------------------|
| symbol       | string   | Security code, for example: `AAPL.US` |
| sequence     | int64    | Sequence number                       |
| ask_brokers  | object[] | Ask brokers                           |
| ∟ position   | int32    | Position                              |
| ∟ broker_ids | int32[]  | [Broker ID](../pull/broker-ids)       |
| bid_brokers  | object[] | Bid brokers                           |
| ∟ position   | int32    | Position                              |
| ∟ broker_ids | int32[]  | [Broker ID](../pull/broker-ids)       |

### Protobuf

```protobuf
message PushBrokers {
  string symbol = 1;
  int64 sequence = 2;
  repeated Brokers ask_brokers = 3;
  repeated Brokers bid_brokers = 4;
}

message Brokers {
  int32 position = 1;
  repeated int32 broker_ids = 2;
}
```

### Example

```python
# Push Real-time Brokers
# https://open.longbridge.com/docs/quote/push/push-brokers
# To subscribe quotes data, please check whether "Developers" - "Quote authority" is correct.
# https://open.longbridge.com/account
#
# - HK Market - BMP basic quotation is unable to subscribe with WebSocket as it has no real-time quote push.
# - US Market - LV1 Nasdaq Basic (Only OpenAPI).
#
# Before running, please visit the "Developers" to ensure that the account has the correct quotes authority.
# If you do not have the quotes authority, you can enter "Me - My Quotes - Store" to purchase the authority through the "Longbridge" mobile app.
from time import sleep
from longport.openapi import QuoteContext, Config, SubType, PushBrokers

def on_brokers(symbol: str, event: PushBrokers):
    print(symbol, event)

config = Config.from_env()
ctx = QuoteContext(config)
ctx.set_on_brokers(on_brokers)

ctx.subscribe(["700.HK", "AAPL.US"], [SubType.Brokers])
sleep(30)
```

### JSON Example

```json
{
  "symbol": "700.HK",
  "sequence": 160808750000000,
  "ask_brokers": [
    {
      "position": 1,
      "broker_ids": [7358, 9057, 9028, 7364]
    },
    {
      "position": 2,
      "broker_ids": [6968, 3448, 3348, 1049, 4973, 6997, 3448, 5465, 6997]
    }
  ],
  "bid_brokers": [
    {
      "position": 1,
      "broker_ids": [6996, 5465, 8026, 8304, 4978]
    },
    {
      "position": 2,
      "broker_ids": [7358, 9057, 9028, 7364]
    }
  ]
}
```
