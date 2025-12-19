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

- [Introduction](https://open.longbridge.com/docs.md)

## Docs

- [llm](https://open.longbridge.com/docs/llm.md)
- [Refresh Token](https://open.longbridge.com/docs/refresh-token-api.md)
- [Get Socket OTP (One time password)](https://open.longbridge.com/docs/socket-token-api.md)
- [Getting Started](https://open.longbridge.com/docs/getting-started.md)
- [Overview](https://open.longbridge.com/docs/how-to-access-api.md)
- [Error Codes](https://open.longbridge.com/docs/error-codes.md)

## Socket

- [Control commands](https://open.longbridge.com/docs/socket/control-command.md)
- [Endpoints](https://open.longbridge.com/docs/socket/hosts.md)
- [Subscribe Real-Time Market Data](https://open.longbridge.com/docs/socket/subscribe_quote.md)
- [Access differences between WebSocket and TCP](https://open.longbridge.com/docs/socket/diff_ws_tcp.md)
- [Subscribe Real-Time Trading Data](https://open.longbridge.com/docs/socket/subscribe_trade.md)
- [Data Commands](https://open.longbridge.com/docs/socket/biz-command.md)

## Protocol

- [Parse Header of Packet](https://open.longbridge.com/docs/socket/protocol/header.md)
- [Parse Request Packet](https://open.longbridge.com/docs/socket/protocol/request.md)
- [Parse Response Packet](https://open.longbridge.com/docs/socket/protocol/response.md)
- [Parse Handshake](https://open.longbridge.com/docs/socket/protocol/handshake.md)
- [Communication Model](https://open.longbridge.com/docs/socket/protocol/connect.md)
- [Parse Push Packet](https://open.longbridge.com/docs/socket/protocol/push.md)
- [Protocol Overview](https://open.longbridge.com/docs/socket/protocol/overview.md)

## Qa

- [Quote Releated](https://open.longbridge.com/docs/qa/broker.md)
- [General](https://open.longbridge.com/docs/qa/general.md)
- [Trade](https://open.longbridge.com/docs/qa/trade.md)

## Trade

- [Definition](https://open.longbridge.com/docs/trade/trade-definition.md)
- [Overview](https://open.longbridge.com/docs/trade/trade-overview.md)
- [Trade Push](https://open.longbridge.com/docs/trade/trade-push.md)

## Execution

- [Get History Executions](https://open.longbridge.com/docs/trade/execution/history_executions.md)
- [Get Today Executions](https://open.longbridge.com/docs/trade/execution/today_executions.md)

## Asset

- [Get Margin Ratio](https://open.longbridge.com/docs/trade/asset/margin_ratio.md)
- [Get Fund Positions](https://open.longbridge.com/docs/trade/asset/fund.md)
- [Get Account Balance](https://open.longbridge.com/docs/trade/asset/account.md)
- [Get Cash Flow](https://open.longbridge.com/docs/trade/asset/cashflow.md)
- [Get Stock Positions](https://open.longbridge.com/docs/trade/asset/stock.md)

## Order

- [Withdraw Order](https://open.longbridge.com/docs/trade/order/withdraw.md)
- [Order Details](https://open.longbridge.com/docs/trade/order/order_detail.md)
- [Estimate Maximum Purchase Quantity](https://open.longbridge.com/docs/trade/order/estimate_available_buy_limit.md)
- [Submit Order](https://open.longbridge.com/docs/trade/order/submit.md)
- [Get History Order](https://open.longbridge.com/docs/trade/order/history_orders.md)
- [Replace Order](https://open.longbridge.com/docs/trade/order/replace.md)
- [Get Today Order](https://open.longbridge.com/docs/trade/order/today_orders.md)

## Quote

- [Definition](https://open.longbridge.com/docs/quote/objects.md)
- [Overview](https://open.longbridge.com/docs/quote/overview.md)

## Pull

- [Option Chain Expiry Date List](https://open.longbridge.com/docs/quote/pull/optionchain-date.md)
- [Current Market Temperature](https://open.longbridge.com/docs/quote/pull/market_temperature.md)
- [Basic Information of Securities](https://open.longbridge.com/docs/quote/pull/static.md)
- [Historical Market Temperature](https://open.longbridge.com/docs/quote/pull/history_market_temperature.md)
- [Real-time Quotes of Warrant](https://open.longbridge.com/docs/quote/pull/warrant-quote.md)
- [Real-time Quotes Of Securities](https://open.longbridge.com/docs/quote/pull/quote.md)
- [Broker IDs](https://open.longbridge.com/docs/quote/pull/broker-ids.md)
- [Security Depth](https://open.longbridge.com/docs/quote/pull/depth.md)
- [Calculate Indexes Of Securities](https://open.longbridge.com/docs/quote/pull/calc-index.md)
- [Warrant Filter](https://open.longbridge.com/docs/quote/pull/warrant-filter.md)
- [Warrant Issuer IDs](https://open.longbridge.com/docs/quote/pull/issuer.md)
- [Security Trades](https://open.longbridge.com/docs/quote/pull/trade.md)
- [Security Capital Flow Intraday](https://open.longbridge.com/docs/quote/pull/capital-flow-intraday.md)
- [Trading Session of The Day](https://open.longbridge.com/docs/quote/pull/trade-session.md)
- [Security Candlesticks](https://open.longbridge.com/docs/quote/pull/candlestick.md)
- [Security Brokers](https://open.longbridge.com/docs/quote/pull/brokers.md)
- [Option Chain By Date](https://open.longbridge.com/docs/quote/pull/optionchain-date-strike.md)
- [Market Trading Days](https://open.longbridge.com/docs/quote/pull/trade-day.md)
- [Security Capital Distribution](https://open.longbridge.com/docs/quote/pull/capital-distribution.md)
- [Real-time Quotes of Option](https://open.longbridge.com/docs/quote/pull/option-quote.md)
- [Security Intraday](https://open.longbridge.com/docs/quote/pull/intraday.md)
- [Security History Candlesticks](https://open.longbridge.com/docs/quote/pull/history-candlestick.md)

## Individual

- [Create Watchlist Group](https://open.longbridge.com/docs/quote/individual/watchlist_create_group.md)
- [Update Watchlist Group](https://open.longbridge.com/docs/quote/individual/watchlist_update_group.md)
- [Delete Watchlist Group](https://open.longbridge.com/docs/quote/individual/watchlist_delete_group.md)
- [Watchlist Group](https://open.longbridge.com/docs/quote/individual/watchlist_groups.md)

## Subscribe

- [Subscription Information](https://open.longbridge.com/docs/quote/subscribe/subscription.md)
- [Subscribe Quote](https://open.longbridge.com/docs/quote/subscribe/subscribe.md)
- [Unsubscribe Quote](https://open.longbridge.com/docs/quote/subscribe/unsubscribe.md)

## Security

- [Retrieve the List of Securities](https://open.longbridge.com/docs/quote/security/security_list.md)

## Push

- [Push Real-time Quote](https://open.longbridge.com/docs/quote/push/quote.md)
- [Push Real-time Brokers](https://open.longbridge.com/docs/quote/push/broker.md)
- [Push Real-time Depth](https://open.longbridge.com/docs/quote/push/depth.md)
- [Push Real-time Trades](https://open.longbridge.com/docs/quote/push/trade.md)
