# TradeContext - 交易上下文

## 创建与推送

```typescript
const ctx: TradeContext = await TradeContext.new(config);

ctx.setOnOrderChanged((err: Error, event: PushOrderChanged) => void);

await ctx.subscribe(topics: TopicType[]): Promise<void>
// 通常: ctx.subscribe([TopicType.Private])

await ctx.unsubscribe(topics: TopicType[]): Promise<void>
```

## 订单操作

#### submitOrder - 提交订单

```typescript
const resp: SubmitOrderResponse = await ctx.submitOrder(
  opts: SubmitOrderOptions,
): Promise<SubmitOrderResponse>
// 返回: { orderId: string }
```

**SubmitOrderOptions 完整参数：**

```typescript
interface SubmitOrderOptions {
  symbol: string; // 证券代码，如 "700.HK"
  orderType: OrderType; // 订单类型
  side: OrderSide; // 买卖方向
  submittedQuantity: Decimal; // 委托数量
  timeInForce: TimeInForceType; // 订单有效期
  submittedPrice?: Decimal; // 委托价格（限价单必填）
  triggerPrice?: Decimal; // 触发价（LIT/MIT 必填）
  limitOffset?: Decimal; // 限价偏移量（TSLPAMT/TSLPPCT 必填）
  trailingAmount?: Decimal; // 跟踪金额（TSLPAMT/TSMAMT 必填）
  trailingPercent?: Decimal; // 跟踪百分比（TSLPPCT/TSMPCT 必填）
  expireDate?: NaiveDate; // 到期日（GoodTilDate 时必填）
  outsideRth?: OutsideRTH; // 是否允许盘前盘后交易
  limitDepthLevel?: number; // 限价深度层级
  triggerCount?: number; // 触发次数
  monitorPrice?: Decimal; // 监控价格
  remark?: string; // 备注（最大 64 字符）
}
```

#### cancelOrder - 撤单

```typescript
await ctx.cancelOrder(orderId: string): Promise<void>
```

#### replaceOrder - 改单

```typescript
await ctx.replaceOrder(opts: ReplaceOrderOptions): Promise<undefined>
```

**ReplaceOrderOptions 完整参数：**

```typescript
interface ReplaceOrderOptions {
  orderId: string; // 订单 ID
  quantity: Decimal; // 修改后数量
  price?: Decimal; // 修改后价格
  triggerPrice?: Decimal; // 触发价（LIT/MIT 订单必填）
  limitOffset?: Decimal; // 限价偏移量（TSLPAMT/TSLPPCT 必填）
  trailingAmount?: Decimal; // 跟踪金额（TSLPAMT/TSMAMT 必填）
  trailingPercent?: Decimal; // 跟踪百分比（TSLPPCT/TSMPCT 必填）
  limitDepthLevel?: number; // 限价深度层级
  triggerCount?: number; // 触发次数
  monitorPrice?: Decimal; // 监控价格
  remark?: string; // 备注（最大 64 字符）
}
```

## 订单查询

#### todayOrders - 获取今日订单

```typescript
const orders: Order[] = await ctx.todayOrders(opts?: GetTodayOrdersOptions): Promise<Order[]>
```

```typescript
interface GetTodayOrdersOptions {
  symbol?: string;
  status?: OrderStatus[];
  side?: OrderSide;
  market?: Market;
  orderId?: string;
}
```

#### historyOrders - 获取历史订单

```typescript
const orders: Order[] = await ctx.historyOrders(opts?: GetHistoryOrdersOptions): Promise<Order[]>
```

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

#### orderDetail - 获取订单详情

```typescript
const detail: OrderDetail = await ctx.orderDetail(orderId: string): Promise<OrderDetail>
```

## 成交查询

#### todayExecutions - 获取今日成交

```typescript
const executions: Execution[] = await ctx.todayExecutions(opts?: GetTodayExecutionsOptions): Promise<Execution[]>
```

```typescript
interface GetTodayExecutionsOptions {
  symbol?: string;
  orderId?: string;
}
```

#### historyExecutions - 获取历史成交

```typescript
const executions: Execution[] = await ctx.historyExecutions(opts?: GetHistoryExecutionsOptions): Promise<Execution[]>
```

```typescript
interface GetHistoryExecutionsOptions {
  symbol?: string;
  startAt?: Date;
  endAt?: Date;
}
```

## 资产查询

#### accountBalance - 获取账户余额

```typescript
const balances: AccountBalance[] = await ctx.accountBalance(currency?: string): Promise<AccountBalance[]>
```

#### cashFlow - 获取资金流水

```typescript
const flows: CashFlow[] = await ctx.cashFlow(opts: GetCashFlowOptions): Promise<CashFlow[]>
```

```typescript
interface GetCashFlowOptions {
  startAt: Date; // 必填
  endAt: Date; // 必填
  businessType?: BalanceType;
  symbol?: string;
  page?: number;
  size?: number;
}
```

#### fundPositions - 获取基金持仓

```typescript
const resp: FundPositionsResponse = await ctx.fundPositions(symbols?: string[]): Promise<FundPositionsResponse>
// FundPositionsResponse: { channels: FundPositionChannel[] }
```

#### stockPositions - 获取股票持仓

```typescript
const resp: StockPositionsResponse = await ctx.stockPositions(symbols?: string[]): Promise<StockPositionsResponse>
// StockPositionsResponse: { channels: StockPositionChannel[] }
// StockPositionChannel: { accountChannel: string, positions: StockPosition[] }
```

#### marginRatio - 获取保证金比率

```typescript
const ratio: MarginRatio = await ctx.marginRatio(symbol: string): Promise<MarginRatio>
// MarginRatio: { imFactor: Decimal, mmFactor: Decimal, fmFactor: Decimal }
```

#### estimateMaxPurchaseQuantity - 估算最大购买数量

```typescript
const resp: EstimateMaxPurchaseQuantityResponse = await ctx.estimateMaxPurchaseQuantity(
  opts: EstimateMaxPurchaseQuantityOptions,
): Promise<EstimateMaxPurchaseQuantityResponse>
// 返回: { cashMaxQty: Decimal, marginMaxQty: Decimal }
```

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
