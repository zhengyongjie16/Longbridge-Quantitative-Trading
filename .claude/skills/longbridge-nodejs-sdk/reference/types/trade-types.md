# 交易数据类型

## Order - 订单

| 属性               | 类型              | 说明           |
| ------------------ | ----------------- | -------------- |
| `orderId`          | `string`          | 订单 ID        |
| `status`           | `OrderStatus`     | 订单状态       |
| `stockName`        | `string`          | 股票名称       |
| `quantity`         | `Decimal`         | 委托数量       |
| `executedQuantity` | `Decimal`         | 已成交数量     |
| `price`            | `Decimal`         | 委托价格       |
| `executedPrice`    | `Decimal`         | 成交均价       |
| `submittedAt`      | `Date`            | 委托时间       |
| `side`             | `OrderSide`       | 买卖方向       |
| `symbol`           | `string`          | 证券代码       |
| `orderType`        | `OrderType`       | 订单类型       |
| `lastDone`         | `Decimal`         | 最近成交价     |
| `triggerPrice`     | `Decimal`         | 触发价         |
| `msg`              | `string`          | 拒绝原因/备注  |
| `tag`              | `OrderTag`        | 订单标签       |
| `timeInForce`      | `TimeInForceType` | 有效期类型     |
| `expireDate`       | `NaiveDate`       | 到期日         |
| `updatedAt`        | `Date`            | 最后更新时间   |
| `triggerAt`        | `Date`            | 条件单触发时间 |
| `trailingAmount`   | `Decimal`         | 跟踪金额       |
| `trailingPercent`  | `Decimal`         | 跟踪百分比     |
| `limitOffset`      | `Decimal`         | 限价偏移量     |
| `triggerStatus`    | `TriggerStatus`   | 条件单触发状态 |
| `currency`         | `string`          | 币种           |
| `outsideRth`       | `OutsideRTH`      | 盘前盘后设置   |
| `limitDepthLevel`  | `number`          | 限价深度层级   |
| `triggerCount`     | `number`          | 触发次数       |
| `monitorPrice`     | `Decimal`         | 监控价格       |
| `remark`           | `string`          | 备注           |

## OrderDetail - 订单详情（扩展 Order）

除包含 Order 所有属性外，还包含：

| 属性                       | 类型                   | 说明         |
| -------------------------- | ---------------------- | ------------ |
| `freeStatus`               | `CommissionFreeStatus` | 免佣状态     |
| `freeAmount`               | `Decimal`              | 免佣金额     |
| `freeCurrency`             | `string`               | 免佣币种     |
| `deductionsStatus`         | `DeductionStatus`      | 扣费状态     |
| `deductionsAmount`         | `Decimal`              | 扣费金额     |
| `deductionsCurrency`       | `string`               | 扣费币种     |
| `platformDeductedStatus`   | `DeductionStatus`      | 平台扣费状态 |
| `platformDeductedAmount`   | `Decimal`              | 平台扣费金额 |
| `platformDeductedCurrency` | `string`               | 平台扣费币种 |
| `history`                  | `OrderHistoryDetail[]` | 订单历史详情 |
| `chargeDetail`             | `OrderChargeDetail`    | 订单费用详情 |

## Execution - 成交记录

| 属性          | 类型      | 说明     |
| ------------- | --------- | -------- |
| `orderId`     | `string`  | 订单 ID  |
| `tradeId`     | `string`  | 成交 ID  |
| `symbol`      | `string`  | 证券代码 |
| `tradeDoneAt` | `Date`    | 成交时间 |
| `quantity`    | `Decimal` | 成交数量 |
| `price`       | `Decimal` | 成交价格 |

## AccountBalance - 账户余额

| 属性                     | 类型                     | 说明         |
| ------------------------ | ------------------------ | ------------ |
| `totalCash`              | `Decimal`                | 总现金       |
| `maxFinanceAmount`       | `Decimal`                | 最大融资金额 |
| `remainingFinanceAmount` | `Decimal`                | 剩余融资金额 |
| `riskLevel`              | `number`                 | 风控等级     |
| `marginCall`             | `Decimal`                | 追加保证金   |
| `currency`               | `string`                 | 币种         |
| `cashInfos`              | `CashInfo[]`             | 现金详情     |
| `netAssets`              | `Decimal`                | 净资产       |
| `initMargin`             | `Decimal`                | 初始保证金   |
| `maintenanceMargin`      | `Decimal`                | 维持保证金   |
| `buyPower`               | `Decimal`                | 购买力       |
| `frozenTransactionFees`  | `FrozenTransactionFee[]` | 冻结交易费   |

## StockPosition - 股票持仓

| 属性                | 类型      | 说明           |
| ------------------- | --------- | -------------- |
| `symbol`            | `string`  | 股票代码       |
| `symbolName`        | `string`  | 股票名称       |
| `quantity`          | `Decimal` | 持仓数量       |
| `availableQuantity` | `Decimal` | 可用数量       |
| `currency`          | `string`  | 币种           |
| `costPrice`         | `Decimal` | 成本价         |
| `market`            | `Market`  | 市场           |
| `initQuantity`      | `Decimal` | 开盘前初始持仓 |

## MarginRatio - 保证金比率

| 属性       | 类型      | 说明               |
| ---------- | --------- | ------------------ |
| `imFactor` | `Decimal` | 初始保证金比率     |
| `mmFactor` | `Decimal` | 维持保证金比率     |
| `fmFactor` | `Decimal` | 强制平仓保证金比率 |

## CashFlow - 资金流水

| 属性                  | 类型                | 说明         |
| --------------------- | ------------------- | ------------ |
| `transactionFlowName` | `string`            | 流水名称     |
| `direction`           | `CashFlowDirection` | 流向         |
| `businessType`        | `BalanceType`       | 业务类型     |
| `balance`             | `Decimal`           | 金额         |
| `currency`            | `string`            | 币种         |
| `businessTime`        | `Date`              | 业务时间     |
| `symbol`              | `string`            | 关联证券代码 |
| `description`         | `string`            | 描述         |

## SubmitOrderResponse - 提交订单响应

| 属性      | 类型     | 说明    |
| --------- | -------- | ------- |
| `orderId` | `string` | 订单 ID |

## EstimateMaxPurchaseQuantityResponse - 最大可买数量响应

| 属性           | 类型      | 说明         |
| -------------- | --------- | ------------ |
| `cashMaxQty`   | `Decimal` | 现金可买数量 |
| `marginMaxQty` | `Decimal` | 融资可买数量 |

## StockPositionsResponse - 股票持仓响应

| 属性       | 类型                     | 说明         |
| ---------- | ------------------------ | ------------ |
| `channels` | `StockPositionChannel[]` | 持仓通道列表 |

## StockPositionChannel - 股票持仓通道

| 属性             | 类型              | 说明     |
| ---------------- | ----------------- | -------- |
| `accountChannel` | `string`          | 账户通道 |
| `positions`      | `StockPosition[]` | 持仓列表 |

## FundPositionsResponse - 基金持仓响应

| 属性       | 类型                    | 说明         |
| ---------- | ----------------------- | ------------ |
| `channels` | `FundPositionChannel[]` | 持仓通道列表 |

## FundPositionChannel - 基金持仓通道

| 属性             | 类型             | 说明     |
| ---------------- | ---------------- | -------- |
| `accountChannel` | `string`         | 账户通道 |
| `positions`      | `FundPosition[]` | 持仓列表 |

## PushOrderChanged - 订单变更推送

| 属性                | 类型            | 说明          |
| ------------------- | --------------- | ------------- |
| `side`              | `OrderSide`     | 买卖方向      |
| `stockName`         | `string`        | 股票名称      |
| `submittedQuantity` | `Decimal`       | 委托数量      |
| `symbol`            | `string`        | 证券代码      |
| `orderType`         | `OrderType`     | 订单类型      |
| `submittedPrice`    | `Decimal`       | 委托价格      |
| `executedQuantity`  | `Decimal`       | 已成交数量    |
| `executedPrice`     | `Decimal`       | 成交均价      |
| `orderId`           | `string`        | 订单 ID       |
| `currency`          | `string`        | 币种          |
| `status`            | `OrderStatus`   | 订单状态      |
| `submittedAt`       | `Date`          | 委托时间      |
| `updatedAt`         | `Date`          | 更新时间      |
| `triggerPrice`      | `Decimal`       | 触发价        |
| `msg`               | `string`        | 拒绝原因/备注 |
| `tag`               | `OrderTag`      | 订单标签      |
| `triggerStatus`     | `TriggerStatus` | 触发状态      |
| `triggerAt`         | `Date`          | 触发时间      |
| `trailingAmount`    | `Decimal`       | 跟踪金额      |
| `trailingPercent`   | `Decimal`       | 跟踪百分比    |
| `limitOffset`       | `Decimal`       | 限价偏移量    |
| `accountNo`         | `string`        | 账户号        |
| `lastShare`         | `Decimal`       | 最近成交股数  |
| `lastPrice`         | `Decimal`       | 最近成交价    |
| `remark`            | `string`        | 备注          |
