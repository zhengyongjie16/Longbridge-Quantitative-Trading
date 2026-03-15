# TradeContext

## Setup

```typescript
TradeContext.new(config: Config): Promise<TradeContext>
```

## Order push subscription

```typescript
ctx.setOnOrderChanged(
  callback: (err: null | Error, event: PushOrderChanged) => void,
): void

await ctx.subscribe(topics: Array<TopicType>): Promise<void>
await ctx.unsubscribe(topics: Array<TopicType>): Promise<void>
```

## Order operations

```typescript
await ctx.submitOrder(opts: SubmitOrderOptions): Promise<SubmitOrderResponse>

await ctx.cancelOrder(orderId: string): Promise<void>

await ctx.replaceOrder(opts: ReplaceOrderOptions): Promise<undefined>
```

### SubmitOrderOptions

See `reference/types/trade-types.md#submitorderoptions` for the full field list.

### ReplaceOrderOptions

See `reference/types/trade-types.md#replaceorderoptions` for the full field list.

## Order queries

```typescript
await ctx.todayOrders(opts?: GetTodayOrdersOptions): Promise<Order[]>
await ctx.historyOrders(opts?: GetHistoryOrdersOptions): Promise<Order[]>
await ctx.orderDetail(orderId: string): Promise<OrderDetail>
```

### GetTodayOrdersOptions

See `reference/types/trade-types.md#gettodayordersoptions` for the full field list.

### GetHistoryOrdersOptions

See `reference/types/trade-types.md#gethistoryordersoptions` for the full field list.

## Execution queries

```typescript
await ctx.todayExecutions(opts?: GetTodayExecutionsOptions): Promise<Execution[]>
await ctx.historyExecutions(opts?: GetHistoryExecutionsOptions): Promise<Execution[]>
```

### GetTodayExecutionsOptions

See `reference/types/trade-types.md#gettodayexecutionsoptions` for the full field list.

### GetHistoryExecutionsOptions

See `reference/types/trade-types.md#gethistoryexecutionsoptions` for the full field list.

## Account / cash / positions / margin / purchase estimation

```typescript
await ctx.accountBalance(currency?: string): Promise<AccountBalance[]>
await ctx.cashFlow(opts: GetCashFlowOptions): Promise<CashFlow[]>
await ctx.fundPositions(symbols?: string[]): Promise<FundPositionsResponse>
await ctx.stockPositions(symbols?: string[]): Promise<StockPositionsResponse>
await ctx.marginRatio(symbol: string): Promise<MarginRatio>
await ctx.estimateMaxPurchaseQuantity(
  opts: EstimateMaxPurchaseQuantityOptions,
): Promise<EstimateMaxPurchaseQuantityResponse>
```

### GetCashFlowOptions

See `reference/types/trade-types.md#getcashflowoptions` for the full field list.

### EstimateMaxPurchaseQuantityOptions

See `reference/types/trade-types.md#estimatemaxpurchasequantityoptions` for the full field list.
