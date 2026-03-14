# TradeContext

Official signature sources (唯一签名事实源):

- https://longbridge.github.io/openapi/nodejs/modules.html
- https://longbridge.github.io/openapi/nodejs/classes/TradeContext.html
- https://longbridge.github.io/openapi/nodejs/interfaces/SubmitOrderOptions.html
- https://longbridge.github.io/openapi/nodejs/interfaces/ReplaceOrderOptions.html
- https://longbridge.github.io/openapi/nodejs/interfaces/GetTodayOrdersOptions.html
- https://longbridge.github.io/openapi/nodejs/interfaces/GetHistoryOrdersOptions.html
- https://longbridge.github.io/openapi/nodejs/interfaces/GetTodayExecutionsOptions.html
- https://longbridge.github.io/openapi/nodejs/interfaces/GetHistoryExecutionsOptions.html
- https://longbridge.github.io/openapi/nodejs/interfaces/GetCashFlowOptions.html
- https://longbridge.github.io/openapi/nodejs/interfaces/EstimateMaxPurchaseQuantityOptions.html

## Setup

```typescript
TradeContext.new(config: Config): Promise<TradeContext>
```

## Order push subscription

```typescript
ctx.setOnOrderChanged(
  callback: (err: Error, event: PushOrderChanged) => void,
): void

await ctx.subscribe(topics: Private[]): Promise<void>
await ctx.unsubscribe(topics: Private[]): Promise<void>
```

## Order operations

```typescript
await ctx.submitOrder(opts: SubmitOrderOptions): Promise<SubmitOrderResponse>

await ctx.cancelOrder(orderId: string): Promise<void>

await ctx.replaceOrder(opts: ReplaceOrderOptions): Promise<undefined>
```

### SubmitOrderOptions

```typescript
interface SubmitOrderOptions {
  symbol: string;
  orderType: OrderType;
  side: OrderSide;
  submittedQuantity: Decimal;
  timeInForce: TimeInForceType;
  submittedPrice?: Decimal;
  triggerPrice?: Decimal;
  limitOffset?: Decimal;
  trailingAmount?: Decimal;
  trailingPercent?: Decimal;
  expireDate?: NaiveDate;
  outsideRth?: OutsideRTH;
  limitDepthLevel?: number;
  triggerCount?: number;
  monitorPrice?: Decimal;
  remark?: string;
}
```

### ReplaceOrderOptions

```typescript
interface ReplaceOrderOptions {
  orderId: string;
  quantity: Decimal;
  price?: Decimal;
  triggerPrice?: Decimal;
  limitOffset?: Decimal;
  trailingAmount?: Decimal;
  trailingPercent?: Decimal;
  limitDepthLevel?: number;
  triggerCount?: number;
  monitorPrice?: Decimal;
  remark?: string;
}
```

## Order queries

```typescript
await ctx.todayOrders(opts?: GetTodayOrdersOptions): Promise<Order[]>
await ctx.historyOrders(opts?: GetHistoryOrdersOptions): Promise<Order[]>
await ctx.orderDetail(orderId: string): Promise<OrderDetail>
```

### GetTodayOrdersOptions

```typescript
interface GetTodayOrdersOptions {
  symbol?: string;
  status?: OrderStatus[];
  side?: OrderSide;
  market?: Market;
  orderId?: string;
}
```

### GetHistoryOrdersOptions

```typescript
interface GetHistoryOrdersOptions {
  symbol?: string;
  status?: OrderStatus[];
  side?: OrderSide;
  market?: Market;
  startAt?: Date;
  endAt?: Date;
}
```

## Execution queries

```typescript
await ctx.todayExecutions(opts?: GetTodayExecutionsOptions): Promise<Execution[]>
await ctx.historyExecutions(opts?: GetHistoryExecutionsOptions): Promise<Execution[]>
```

### GetTodayExecutionsOptions

```typescript
interface GetTodayExecutionsOptions {
  symbol?: string;
  orderId?: string;
}
```

### GetHistoryExecutionsOptions

```typescript
interface GetHistoryExecutionsOptions {
  symbol?: string;
  startAt?: Date;
  endAt?: Date;
}
```

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

```typescript
interface GetCashFlowOptions {
  startAt: Date;
  endAt: Date;
  businessType?: BalanceType;
  symbol?: string;
  page?: number;
  size?: number;
}
```

### EstimateMaxPurchaseQuantityOptions

```typescript
interface EstimateMaxPurchaseQuantityOptions {
  symbol: string;
  orderType: OrderType;
  side: OrderSide;
  price?: Decimal;
  currency?: string;
  orderId?: string;
  fractionalShares: boolean;
}
```
