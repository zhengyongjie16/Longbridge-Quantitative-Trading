---
name: longbridge-openapi-documentation
description: 当用户需要你阅读和检查api文档，以及根据api文档编写代码，适用这个skill
---

# Longbridge OpenAPI Documentation

Longbridge OpenAPI provides programmatic quote trading interfaces for investors with research and development capabilities and assists them to build trading or quote strategy analysis tools based on their own investment strategies. The functions fall into the following categories:

- **Trading** - Create, amend, cancel orders, query today's/past orders and transaction details, etc.
- **Quotes** - Real-time quotes, acquisition of historical quotes, etc.
- **Portfolio** - Real-time query of the account assets, positions, funds
- **Real-time subscription** - Provides real-time quotes and push notifications for order status changes

## Interface Type

Longbridge provides diversified access methods such as HTTP / WebSockets interfaces for accessing the underlying services and SDK (Python / C++, etc.) encapsulated in the upper layer, allowing flexible choices.

## How to Enable OpenAPI

1. Log in to the [Longbridge App](https://longbridge.com/download) to complete the account opening process;

2. Log in to the [longbridge.com](https://longbridge.com) and enter the developer platform, complete the developer verification (OpenAPI permission application), and obtain a token.

## Quote Coverage

<table>
    <thead>
    <tr>
        <th>Market</th>
        <th>Symbol</th>
    </tr>
    </thead>
    <tr>
        <td width="160" rowspan="2">HK Market</td>
        <td>Securities (including equities, ETFs, Warrants, CBBCs)</td>
    </tr>
    <tr>
        <td>Hang Seng Index</td>
    </tr>
    <tr>
        <td rowspan="3">US Market</td>
        <td>Securities (including stocks, ETFs)</td>
    </tr>
    <tr>
        <td>Nasdsaq Index</td>
    </tr>
    <tr>
        <td>OPRA Options</td>
    </tr>
    <tr>
        <td rowspan="2">CN Market</td>
        <td>Securities (including stocks, ETFs)</td>
    </tr>
    <tr>
        <td>Index</td>
    </tr>
</table>

## Trading

Supported trading functions include:

| Market    | Stock and ETF | Warrant & CBBC | Options |
| --------- | ------------- | -------------- | ------- |
| HK Market | ✓             | ✓              |         |
| US Market | ✓             | ✓              | ✓       |

## Rate Limit {#rate-limit}

| Category  | Limitation                                                                                                                                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quote API | <ul><li>One account can only create one long link and subscribe to a maximum of 500 symbols at the same time</li><li>No more than 10 calls in a 1-second interval and the number of concurrent requests should not exceed 5</li></ul> |
| Trade API | <ul><li>No more than 30 calls in a 30-second interval, and the interval between two calls should not be less than 0.02 seconds</li></ul>                                                                                              |

:::success

The [OpenAPI SDK](https://open.longbridge.com/sdk) has done effective frequency control internally:

- Quote: The methods under `QuoteContext` will be actively controlled by the SDK according to the server's rate limit. When the request is too fast, the SDK will automatically delay the request. Therefore, you do not need to implement the frequency control details separately.
- Trade: The methods under `TradeContext` are not limited by the SDK. Due to the special nature of the trading order placement scenario, this is left to the user to handle.

:::

## Pricing {#pricing}

Longbridge does not charge any additional fees for activating or using interface services. You only need to open a Longbridge Integrated A/C and get OpenAPI service permissions to use it for free. For actual transaction fees, please contact the brokerage firm where you have opened your securities account.

## Other

The OpenAPI services are provided by Longbridge and the applicable affiliates (subject to the agreement).
openapi-trade.longportapp.com

## SDK

- [Introduction](./reference/docs.md)

## Docs

- [llm](./reference/docs/llm.md)
- [Refresh Token](./reference/docs/refresh-token-api.md)
- [Get Socket OTP (One time password)](./reference/docs/socket-token-api.md)
- [Getting Started](./reference/docs/getting-started.md)
- [Overview](./reference/docs/how-to-access-api.md)
- [Error Codes](./reference/docs/error-codes.md)

## Socket

- [Control commands](./reference/docs/socket/control-command.md)
- [Endpoints](./reference/docs/socket/hosts.md)
- [Subscribe Real-Time Market Data](./reference/docs/socket/subscribe_quote.md)
- [Access differences between WebSocket and TCP](./reference/docs/socket/diff_ws_tcp.md)
- [Subscribe Real-Time Trading Data](./reference/docs/socket/subscribe_trade.md)
- [Data Commands](./reference/docs/socket/biz-command.md)

## Protocol

- [Parse Header of Packet](./reference/docs/socket/protocol/header.md)
- [Parse Request Packet](./reference/docs/socket/protocol/request.md)
- [Parse Response Packet](./reference/docs/socket/protocol/response.md)
- [Parse Handshake](./reference/docs/socket/protocol/handshake.md)
- [Communication Model](./reference/docs/socket/protocol/connect.md)
- [Parse Push Packet](./reference/docs/socket/protocol/push.md)
- [Protocol Overview](./reference/docs/socket/protocol/overview.md)

## Qa

- [Quote Releated](./reference/docs/qa/broker.md)
- [General](./reference/docs/qa/general.md)
- [Trade](./reference/docs/qa/trade.md)

## Trade

- [Definition](./reference/docs/trade/trade-definition.md)
- [Overview](./reference/docs/trade/trade-overview.md)
- [Trade Push](./reference/docs/trade/trade-push.md)

## Execution

- [Get History Executions](./reference/docs/trade/execution/history_executions.md)
- [Get Today Executions](./reference/docs/trade/execution/today_executions.md)

## Asset

- [Get Margin Ratio](./reference/docs/trade/asset/margin_ratio.md)
- [Get Fund Positions](./reference/docs/trade/asset/fund.md)
- [Get Account Balance](./reference/docs/trade/asset/account.md)
- [Get Cash Flow](./reference/docs/trade/asset/cashflow.md)
- [Get Stock Positions](./reference/docs/trade/asset/stock.md)

## Order

- [Withdraw Order](./reference/docs/trade/order/withdraw.md)
- [Order Details](./reference/docs/trade/order/order_detail.md)
- [Estimate Maximum Purchase Quantity](./reference/docs/trade/order/estimate_available_buy_limit.md)
- [Submit Order](./reference/docs/trade/order/submit.md)
- [Get History Order](./reference/docs/trade/order/history_orders.md)
- [Replace Order](./reference/docs/trade/order/replace.md)
- [Get Today Order](./reference/docs/trade/order/today_orders.md)

## Quote

- [Definition](./reference/docs/quote/objects.md)
- [Overview](./reference/docs/quote/overview.md)

## Pull

- [Option Chain Expiry Date List](./reference/docs/quote/pull/optionchain-date.md)
- [Current Market Temperature](./reference/docs/quote/pull/market_temperature.md)
- [Basic Information of Securities](./reference/docs/quote/pull/static.md)
- [Historical Market Temperature](./reference/docs/quote/pull/history_market_temperature.md)
- [Real-time Quotes of Warrant](./reference/docs/quote/pull/warrant-quote.md)
- [Real-time Quotes Of Securities](./reference/docs/quote/pull/quote.md)
- [Broker IDs](./reference/docs/quote/pull/broker-ids.md)
- [Security Depth](./reference/docs/quote/pull/depth.md)
- [Calculate Indexes Of Securities](./reference/docs/quote/pull/calc-index.md)
- [Warrant Filter](./reference/docs/quote/pull/warrant-filter.md)
- [Warrant Issuer IDs](./reference/docs/quote/pull/issuer.md)
- [Security Trades](./reference/docs/quote/pull/trade.md)
- [Security Capital Flow Intraday](./reference/docs/quote/pull/capital-flow-intraday.md)
- [Trading Session of The Day](./reference/docs/quote/pull/trade-session.md)
- [Security Candlesticks](./reference/docs/quote/pull/candlestick.md)
- [Security Brokers](./reference/docs/quote/pull/brokers.md)
- [Option Chain By Date](./reference/docs/quote/pull/optionchain-date-strike.md)
- [Market Trading Days](./reference/docs/quote/pull/trade-day.md)
- [Security Capital Distribution](./reference/docs/quote/pull/capital-distribution.md)
- [Real-time Quotes of Option](./reference/docs/quote/pull/option-quote.md)
- [Security Intraday](./reference/docs/quote/pull/intraday.md)
- [Security History Candlesticks](./reference/docs/quote/pull/history-candlestick.md)

## Individual

- [Create Watchlist Group](./reference/docs/quote/individual/watchlist_create_group.md)
- [Update Watchlist Group](./reference/docs/quote/individual/watchlist_update_group.md)
- [Delete Watchlist Group](./reference/docs/quote/individual/watchlist_delete_group.md)
- [Watchlist Group](./reference/docs/quote/individual/watchlist_groups.md)

## Subscribe

- [Subscription Information](./reference/docs/quote/subscribe/subscription.md)
- [Subscribe Quote](./reference/docs/quote/subscribe/subscribe.md)
- [Unsubscribe Quote](./reference/docs/quote/subscribe/unsubscribe.md)

## Security

- [Retrieve the List of Securities](./reference/docs/quote/security/security_list.md)

## Push

- [Push Real-time Quote](./reference/docs/quote/push/quote.md)
- [Push Real-time Brokers](./reference/docs/quote/push/broker.md)
- [Push Real-time Depth](./reference/docs/quote/push/depth.md)
- [Push Real-time Trades](./reference/docs/quote/push/trade.md)
