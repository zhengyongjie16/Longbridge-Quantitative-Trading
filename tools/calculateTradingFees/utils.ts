import type { FeeSummary, HKFeeRates, OrderFees, Trade, TieredFeeRate } from './types.js';

/**
 * 根据分档费率计算费用。默认行为：按 `min` 下限兜底，若设置 `max` 则应用上限。
 *
 * @param tradeAmount 成交金额
 * @param tieredRate 分档费率配置
 * @returns 计算后的费用金额
 */
function calculateTieredFee(tradeAmount: number, tieredRate: TieredFeeRate): number {
  const rawFee = tradeAmount * tieredRate.rate;
  const feeWithMin = Math.max(tieredRate.min, rawFee);
  if (tieredRate.max === undefined) {
    return feeWithMin;
  }
  return Math.min(tieredRate.max, feeWithMin);
}

/**
 * 计算单笔订单费用。默认行为：按牛熊证费率计算（印花税固定取配置值）。
 *
 * @param quantity 成交数量
 * @param price 成交价格
 * @param feeRates 港股费率配置
 * @returns 单笔订单费用明细
 */
export function calculateOrderFees(
  quantity: number,
  price: number,
  feeRates: HKFeeRates,
): OrderFees {
  const tradeAmount = quantity * price;
  const clearingFee = calculateTieredFee(tradeAmount, feeRates.clearingFee);
  const transactionFee = calculateTieredFee(tradeAmount, feeRates.transactionFee);
  const transactionLevy = calculateTieredFee(tradeAmount, feeRates.transactionLevy);
  const fstbLevy = calculateTieredFee(tradeAmount, feeRates.fstbLevy);
  const total =
    feeRates.platformFee +
    feeRates.stampDuty +
    clearingFee +
    transactionFee +
    transactionLevy +
    fstbLevy;

  return {
    platformFee: feeRates.platformFee,
    stampDuty: feeRates.stampDuty,
    clearingFee,
    transactionFee,
    transactionLevy,
    fstbLevy,
    total,
  };
}

/**
 * 从交易记录中提取数量与价格。默认行为：无法解析时返回 `NaN`。
 *
 * @param trade 单笔交易记录
 * @returns 解析后的数量与价格
 */
export function parseTradeNumbers(trade: Trade): {
  readonly quantity: number;
  readonly price: number;
} {
  return {
    quantity: Number.parseInt(trade.quantity, 10),
    price: Number.parseFloat(trade.price),
  };
}

/**
 * 创建空费用汇总对象。默认行为：所有累计值初始化为 0。
 *
 * @returns 空汇总对象
 */
export function createEmptySummary(): FeeSummary {
  return {
    totalPlatformFee: 0,
    totalStampDuty: 0,
    totalClearingFee: 0,
    totalTransactionFee: 0,
    totalTransactionLevy: 0,
    totalFstbLevy: 0,
    totalFees: 0,
  };
}

/**
 * 将单笔费用累加到汇总结果中。默认行为：返回新对象，不修改原汇总。
 *
 * @param summary 当前汇总结果
 * @param fees 单笔费用明细
 * @returns 累加后的新汇总结果
 */
export function accumulateFees(summary: FeeSummary, fees: OrderFees): FeeSummary {
  return {
    totalPlatformFee: summary.totalPlatformFee + fees.platformFee,
    totalStampDuty: summary.totalStampDuty + fees.stampDuty,
    totalClearingFee: summary.totalClearingFee + fees.clearingFee,
    totalTransactionFee: summary.totalTransactionFee + fees.transactionFee,
    totalTransactionLevy: summary.totalTransactionLevy + fees.transactionLevy,
    totalFstbLevy: summary.totalFstbLevy + fees.fstbLevy,
    totalFees: summary.totalFees + fees.total,
  };
}

/**
 * 生成订单标的的短展示文本。默认行为：长度超限时截断并追加省略号。
 *
 * @param symbol 标的代码
 * @param maxLength 最大长度，默认 20
 * @returns 截断后的标的文本
 */
export function toShortSymbol(symbol: string, maxLength: number = 20): string {
  if (symbol.length <= maxLength) {
    return symbol;
  }
  const preserveLength = Math.max(1, maxLength - 3);
  return `${symbol.substring(0, preserveLength)}...`;
}
