---
id: quote_subscription
title: Subscription Information
slug: subscription
sidebar_position: 3
---

This API is used to obtain the subscription information.


## SDK

| Language | Link |
|---|---|
| Python | [longport.openapi.quote._quote_context](https://longportapp.github.io/openapi/python/reference_all/#longport.openapi.quote._quote_context) |
| Rust | [longport::<SDKLinks module="quote" klass="QuoteContext" method="subscriptions" />::quote#_quote_context](https://longportapp.github.io/openapi/rust/longport/<SDKLinks module="quote" klass="QuoteContext" method="subscriptions" />/struct.quote.html#method._quote_context) |
| Go | [quote.subscriptions](https://pkg.go.dev/github.com/longportapp/openapi-go/<SDKLinks module="quote" klass="QuoteContext" method="subscriptions" />#quote.subscriptions) |
| Node.js | [quote#QuoteContext](https://longportapp.github.io/openapi/nodejs/classes/quote.html#quotecontext) |

:::info

[Business Command](../../socket/biz-command): `5`

:::

## Request

### Protobuf

```protobuf
message SubscriptionRequest {
}
```

### Request Example

```python
from longport.openapi import QuoteContext, Config, SubType
config = Config.from_env()
ctx = QuoteContext(config)

ctx.subscribe(["700.HK", "AAPL.US"], [SubType.Quote])
resp = ctx.subscriptions()
print(resp)
```

## Response

### Response Properties

| Name       | Type     | Description                                                                       |
| ---------- | -------- | --------------------------------------------------------------------------------- |
| sub_list   | object[] | Subscribed data                                                                   |
| ∟ symbol   | string   | Security code                                                                     |
| ∟ sub_type | []int32  | Subscription type, see [SubType](../objects#subtype---quote-type-of-subscription) |

### Protobuf

```protobuf
message SubscriptionResponse {
  repeated SubTypeList sub_list = 1;
}

message SubTypeList {
  string symbol = 1;
  repeated SubType sub_type = 2;
}
```

### Response JSON Example

```json
{
  "sub_list": [
    {
      "symbol": "700.HK",
      "sub_type": [1, 2, 3]
    },
    {
      "symbol": "AAPL.US",
      "sub_type": [2]
    }
  ]
}
```

## Error Code

| Protocol Error Code | Business Error Code | Description        | Troubleshooting Suggestions                                   |
| ------------------- | ------------------- | ------------------ | ------------------------------------------------------------- |
| 3                   | 301600              | Invalid request    | Invalid request parameters or unpacking request failed        |
| 3                   | 301606              | Request rate limit | Reduce the frequency of requests                              |
| 7                   | 301602              | Server error       | Please try again or contact a technician to resolve the issue |
