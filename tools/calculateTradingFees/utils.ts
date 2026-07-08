import type { FeeSummary, HKFeeRates, OrderFees, Trade, TieredFeeRate } from './types.js';

const TRADE_STRING_FIELDS = [
  'orderId',
  'symbol',
  'action',
  'side',
  'quantity',
  'price',
  'status',
] as const;

const TRADE_OPTIONAL_STRING_OR_NULL_FIELDS = ['orderType'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function findInvalidTradeFields(value: unknown): ReadonlyArray<string> {
  if (!isRecord(value)) {
    return ['record'];
  }

  const invalidRequiredFields = TRADE_STRING_FIELDS.filter(
    (field) => typeof value[field] !== 'string',
  );
  const invalidOptionalFields = TRADE_OPTIONAL_STRING_OR_NULL_FIELDS.filter((field) => {
    if (!Object.hasOwn(value, field)) {
      return false;
    }

    const fieldValue = value[field];
    return fieldValue !== null && typeof fieldValue !== 'string';
  });

  return [...invalidRequiredFields, ...invalidOptionalFields];
}

function parsePositiveFiniteNumber(
  value: string,
  fieldName: 'quantity' | 'price',
  orderId: string,
): number {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  throw new Error(`交易记录 ${orderId} 的 ${fieldName} 无效：${value}`);
}

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
 * 校验并解析交易日志 JSON 根对象。交易日志来自文件边界，字段缺失或类型错误必须 fail-fast。
 *
 * @param raw 从 JSON.parse 得到的未知交易日志内容
 * @returns 校验后的交易记录数组
 */
export function parseTrades(raw: unknown): ReadonlyArray<Trade> {
  if (!Array.isArray(raw)) {
    throw new TypeError('交易日志必须是数组');
  }

  return raw.map((record, index) => {
    const invalidFields = findInvalidTradeFields(record);
    if (invalidFields.length > 0) {
      throw new Error(`第 ${index + 1} 条交易记录字段无效：${invalidFields.join(', ')}`);
    }

    // 外部 JSON 边界已通过字段 schema 校验，此处收窄为内部 Trade。
    return record as Trade;
  });
}

/**
 * 从交易记录中提取数量与价格。交易金额必须由正有限数构成，否则立即失败。
 *
 * @param trade 单笔交易记录
 * @returns 解析后的数量与价格
 */
export function parseTradeNumbers(trade: Trade): {
  readonly quantity: number;
  readonly price: number;
} {
  return {
    quantity: parsePositiveFiniteNumber(trade.quantity, 'quantity', trade.orderId),
    price: parsePositiveFiniteNumber(trade.price, 'price', trade.orderId),
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
