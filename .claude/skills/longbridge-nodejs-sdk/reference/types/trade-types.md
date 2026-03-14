# Trade Types

Official sources:

- https://longbridge.github.io/openapi/nodejs/modules.html
- https://longbridge.github.io/openapi/nodejs/classes/AccountBalance.html
- https://longbridge.github.io/openapi/nodejs/classes/CashFlow.html
- https://longbridge.github.io/openapi/nodejs/classes/CashInfo.html
- https://longbridge.github.io/openapi/nodejs/classes/EstimateMaxPurchaseQuantityResponse.html
- https://longbridge.github.io/openapi/nodejs/classes/Execution.html
- https://longbridge.github.io/openapi/nodejs/classes/FrozenTransactionFee.html
- https://longbridge.github.io/openapi/nodejs/classes/FundPosition.html
- https://longbridge.github.io/openapi/nodejs/classes/FundPositionChannel.html
- https://longbridge.github.io/openapi/nodejs/classes/FundPositionsResponse.html
- https://longbridge.github.io/openapi/nodejs/classes/MarginRatio.html
- https://longbridge.github.io/openapi/nodejs/classes/Order.html
- https://longbridge.github.io/openapi/nodejs/classes/OrderChargeDetail.html
- https://longbridge.github.io/openapi/nodejs/classes/OrderChargeFee.html
- https://longbridge.github.io/openapi/nodejs/classes/OrderChargeItem.html
- https://longbridge.github.io/openapi/nodejs/classes/OrderDetail.html
- https://longbridge.github.io/openapi/nodejs/classes/OrderHistoryDetail.html
- https://longbridge.github.io/openapi/nodejs/classes/PushOrderChanged.html
- https://longbridge.github.io/openapi/nodejs/classes/StockPosition.html
- https://longbridge.github.io/openapi/nodejs/classes/StockPositionChannel.html
- https://longbridge.github.io/openapi/nodejs/classes/StockPositionsResponse.html
- https://longbridge.github.io/openapi/nodejs/classes/SubmitOrderResponse.html
- https://longbridge.github.io/openapi/nodejs/interfaces/SubmitOrderOptions.html
- https://longbridge.github.io/openapi/nodejs/interfaces/ReplaceOrderOptions.html
- https://longbridge.github.io/openapi/nodejs/interfaces/GetTodayOrdersOptions.html
- https://longbridge.github.io/openapi/nodejs/interfaces/GetHistoryOrdersOptions.html
- https://longbridge.github.io/openapi/nodejs/interfaces/GetTodayExecutionsOptions.html
- https://longbridge.github.io/openapi/nodejs/interfaces/GetHistoryExecutionsOptions.html
- https://longbridge.github.io/openapi/nodejs/interfaces/GetCashFlowOptions.html
- https://longbridge.github.io/openapi/nodejs/interfaces/EstimateMaxPurchaseQuantityOptions.html

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

- `symbol: string`
- `orderType: OrderType`
- `side: OrderSide`
- `submittedQuantity: Decimal`
- `timeInForce: TimeInForceType`
- `submittedPrice?: Decimal`
- `triggerPrice?: Decimal`
- `limitOffset?: Decimal`
- `trailingAmount?: Decimal`
- `trailingPercent?: Decimal`
- `expireDate?: NaiveDate`
- `outsideRth?: OutsideRTH`
- `limitDepthLevel?: number`
- `triggerCount?: number`
- `monitorPrice?: Decimal`
- `remark?: string`

### ReplaceOrderOptions

- `orderId: string`
- `quantity: Decimal`
- `price?: Decimal`
- `triggerPrice?: Decimal`
- `limitOffset?: Decimal`
- `trailingAmount?: Decimal`
- `trailingPercent?: Decimal`
- `limitDepthLevel?: number`
- `triggerCount?: number`
- `monitorPrice?: Decimal`
- `remark?: string`

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
