# Trade Types

## Order domain

### Order

- `orderId: string`
- `status: OrderStatus`
- `stockName: string`
- `quantity: Decimal`
- `executedQuantity: Decimal`
- `price: Decimal`
- `executedPrice: Decimal`
- `submittedAt: Date`
- `side: OrderSide`
- `symbol: string`
- `orderType: OrderType`
- `lastDone: Decimal`
- `triggerPrice: Decimal`
- `msg: string`
- `tag: OrderTag`
- `timeInForce: TimeInForceType`
- `expireDate: NaiveDate`
- `updatedAt: Date`
- `triggerAt: Date`
- `trailingAmount: Decimal`
- `trailingPercent: Decimal`
- `limitOffset: Decimal`
- `triggerStatus: TriggerStatus`
- `currency: string`
- `outsideRth: OutsideRTH`
- `limitDepthLevel: number`
- `triggerCount: number`
- `monitorPrice: Decimal`
- `remark: string`

### OrderDetail

- `orderId: string`
- `status: OrderStatus`
- `stockName: string`
- `quantity: Decimal`
- `executedQuantity: Decimal`
- `price: Decimal`
- `executedPrice: Decimal`
- `submittedAt: Date`
- `side: OrderSide`
- `symbol: string`
- `orderType: OrderType`
- `lastDone: Decimal`
- `triggerPrice: Decimal`
- `msg: string`
- `tag: OrderTag`
- `timeInForce: TimeInForceType`
- `expireDate: NaiveDate`
- `updatedAt: Date`
- `triggerAt: Date`
- `trailingAmount: Decimal`
- `trailingPercent: Decimal`
- `limitOffset: Decimal`
- `triggerStatus: TriggerStatus`
- `currency: string`
- `outsideRth: OutsideRTH`
- `limitDepthLevel: number`
- `triggerCount: number`
- `monitorPrice: Decimal`
- `remark: string`
- `freeStatus: CommissionFreeStatus`
- `freeAmount: Decimal`
- `freeCurrency: string`
- `deductionsStatus: DeductionStatus`
- `deductionsAmount: Decimal`
- `deductionsCurrency: string`
- `platformDeductedStatus: DeductionStatus`
- `platformDeductedAmount: Decimal`
- `platformDeductedCurrency: string`
- `history: OrderHistoryDetail[]`
- `chargeDetail: OrderChargeDetail`

### OrderHistoryDetail

- `price: Decimal`
- `quantity: Decimal`
- `status: OrderStatus`
- `msg: string`
- `time: Date`

### SubmitOrderResponse

- `orderId: string`

### OrderChargeDetail

- `totalAmount: Decimal`
- `currency: string`
- `items: OrderChargeItem[]`

### OrderChargeFee

- `code: string`
- `name: string`
- `amount: Decimal`
- `currency: string`

### OrderChargeItem

- `code: ChargeCategoryCode`
- `name: string`
- `fees: OrderChargeFee[]`

## Execution domain

### Execution

- `orderId: string`
- `tradeId: string`
- `symbol: string`
- `tradeDoneAt: Date`
- `quantity: Decimal`
- `price: Decimal`

## Account and cash domain

### AccountBalance

- `totalCash: Decimal`
- `maxFinanceAmount: Decimal`
- `remainingFinanceAmount: Decimal`
- `riskLevel: number`
- `marginCall: Decimal`
- `currency: string`
- `cashInfos: CashInfo[]`
- `netAssets: Decimal`
- `initMargin: Decimal`
- `maintenanceMargin: Decimal`
- `buyPower: Decimal`
- `frozenTransactionFees: FrozenTransactionFee[]`

### CashInfo

- `withdrawCash: Decimal`
- `availableCash: Decimal`
- `frozenCash: Decimal`
- `settlingCash: Decimal`
- `currency: string`

### FrozenTransactionFee

- `currency: string`
- `frozenTransactionFee: Decimal`

### CashFlow

- `transactionFlowName: string`
- `direction: CashFlowDirection`
- `businessType: BalanceType`
- `balance: Decimal`
- `currency: string`
- `businessTime: Date`
- `symbol: string`
- `description: string`

## Position and margin domain

### StockPosition

- `symbol: string`
- `symbolName: string`
- `quantity: Decimal`
- `availableQuantity: Decimal`
- `currency: string`
- `costPrice: Decimal`
- `market: Market`
- `initQuantity: Decimal`

### StockPositionChannel

- `accountChannel: string`
- `positions: StockPosition[]`

### StockPositionsResponse

- `channels: StockPositionChannel[]`

### FundPosition

- `symbol: string`
- `currentNetAssetValue: Decimal`
- `netAssetValueDay: Date`
- `symbolName: string`
- `currency: string`
- `costNetAssetValue: Decimal`
- `holdingUnits: Decimal`

### FundPositionChannel

- `accountChannel: string`
- `positions: FundPosition[]`

### FundPositionsResponse

- `channels: FundPositionChannel[]`

### MarginRatio

- `imFactor: Decimal`
- `mmFactor: Decimal`
- `fmFactor: Decimal`

### EstimateMaxPurchaseQuantityResponse

- `cashMaxQty: Decimal`
- `marginMaxQty: Decimal`

## Push event

### PushOrderChanged

- `side: OrderSide`
- `stockName: string`
- `submittedQuantity: Decimal`
- `symbol: string`
- `orderType: OrderType`
- `submittedPrice: Decimal`
- `executedQuantity: Decimal`
- `executedPrice: Decimal`
- `orderId: string`
- `currency: string`
- `status: OrderStatus`
- `submittedAt: Date`
- `updatedAt: Date`
- `triggerPrice: Decimal`
- `msg: string`
- `tag: OrderTag`
- `triggerStatus: TriggerStatus`
- `triggerAt: Date`
- `trailingAmount: Decimal`
- `trailingPercent: Decimal`
- `limitOffset: Decimal`
- `accountNo: string`
- `lastShare: Decimal`
- `lastPrice: Decimal`
- `remark: string`

## Trade option interfaces

### SubmitOrderOptions

Always required:

- `symbol: string`
- `orderType: OrderType`
- `side: OrderSide`
- `submittedQuantity: Decimal`
- `timeInForce: TimeInForceType`

Usually optional:

- `submittedPrice?: Decimal`
- `outsideRth?: OutsideRTH`
- `limitDepthLevel?: number`
- `triggerCount?: number`
- `monitorPrice?: Decimal`
- `remark?: string`

Conditionally required:

- `triggerPrice?: Decimal` — required for `LIT` / `MIT`
- `limitOffset?: Decimal` — required for `TSLPAMT` / `TSLPPCT`
- `trailingAmount?: Decimal` — required for `TSLPAMT` / `TSMAMT`
- `trailingPercent?: Decimal` — required for `TSLPPCT` / `TSMPCT`
- `expireDate?: NaiveDate` — required when `timeInForce` is `GoodTilDate`

### ReplaceOrderOptions

Always required:

- `orderId: string`
- `quantity: Decimal`

Usually optional:

- `price?: Decimal`
- `limitDepthLevel?: number`
- `triggerCount?: number`
- `monitorPrice?: Decimal`
- `remark?: string`

Conditionally required:

- `triggerPrice?: Decimal` — required for `LIT` / `MIT`
- `limitOffset?: Decimal` — required for `TSLPAMT` / `TSLPPCT`
- `trailingAmount?: Decimal` — required for `TSLPAMT` / `TSMAMT`
- `trailingPercent?: Decimal` — required for `TSLPPCT` / `TSMPCT`

### GetTodayOrdersOptions

- `symbol?: string`
- `status?: OrderStatus[]`
- `side?: OrderSide`
- `market?: Market`
- `orderId?: string`

### GetHistoryOrdersOptions

- `symbol?: string`
- `status?: OrderStatus[]`
- `side?: OrderSide`
- `market?: Market`
- `startAt?: Date`
- `endAt?: Date`

### GetTodayExecutionsOptions

- `symbol?: string`
- `orderId?: string`

### GetHistoryExecutionsOptions

- `symbol?: string`
- `startAt?: Date`
- `endAt?: Date`

### GetCashFlowOptions

- `startAt: Date`
- `endAt: Date`
- `businessType?: BalanceType`
- `symbol?: string`
- `page?: number`
- `size?: number`

### EstimateMaxPurchaseQuantityOptions

- `symbol: string`
- `orderType: OrderType`
- `side: OrderSide`
- `price?: Decimal`
- `currency?: string`
- `orderId?: string`
- `fractionalShares: boolean`

## High-scrutiny symbol checklist

Canonical headings for high-scrutiny symbols (single-heading policy):

- [OrderChargeDetail](#orderchargedetail)
- [OrderChargeFee](#orderchargefee)
- [OrderChargeItem](#orderchargeitem)
- [OrderHistoryDetail](#orderhistorydetail)
- [CashInfo](#cashinfo)
- [FrozenTransactionFee](#frozentransactionfee)
- [FundPosition](#fundposition)
- [PushOrderChanged](#pushorderchanged)
