/**
 * 交易记录类型：用于描述日志文件中的单笔订单数据。
 * 数据来源：`logs/trades/*.json`。
 * 使用范围：仅 `tools/calculateTradingFees` 工具内部。
 */
export type Trade = {
  readonly orderId: string;
  readonly symbol: string;
  readonly action: string;
  readonly side: string;
  readonly quantity: string;
  readonly price: string;
  readonly orderType: string;
  readonly status: string;
};

/**
 * 港股费用档位类型：用于描述按成交金额计费的费率与上下限。
 * 数据来源：工具内置费率配置。
 * 使用范围：仅 `tools/calculateTradingFees` 工具内部。
 */
export type TieredFeeRate = {
  readonly rate: number;
  readonly min: number;
  readonly max?: number;
};

/**
 * 港股费用配置类型：用于描述订单费用计算所需的全部费率。
 * 数据来源：工具内置费率配置。
 * 使用范围：仅 `tools/calculateTradingFees` 工具内部。
 */
export type HKFeeRates = {
  readonly platformFee: number;
  readonly stampDuty: number;
  readonly clearingFee: TieredFeeRate;
  readonly transactionFee: TieredFeeRate;
  readonly transactionLevy: TieredFeeRate;
  readonly fstbLevy: TieredFeeRate;
};

/**
 * 单笔订单费用明细类型：用于输出每笔订单的各项费用和总费用。
 * 数据来源：由费用计算函数实时计算。
 * 使用范围：仅 `tools/calculateTradingFees` 工具内部。
 */
export type OrderFees = {
  readonly platformFee: number;
  readonly stampDuty: number;
  readonly clearingFee: number;
  readonly transactionFee: number;
  readonly transactionLevy: number;
  readonly fstbLevy: number;
  readonly total: number;
};

/**
 * 费用累计结果类型：用于聚合全量订单费用统计。
 * 数据来源：逐笔订单计算结果聚合。
 * 使用范围：仅 `tools/calculateTradingFees` 工具内部。
 */
export type FeeSummary = {
  readonly totalPlatformFee: number;
  readonly totalStampDuty: number;
  readonly totalClearingFee: number;
  readonly totalTransactionFee: number;
  readonly totalTransactionLevy: number;
  readonly totalFstbLevy: number;
  readonly totalFees: number;
};
