/**
 * 工具函数模块类型定义
 */

/**
 * LongPort Decimal 类型接口
 */
export type DecimalLike = {
  toNumber(): number;
};

/**
 * 时间格式化选项
 */
export type TimeFormatOptions = {
  readonly format?: 'iso' | 'log';
};

/**
 * 行情显示格式化结果
 */
export type QuoteDisplayResult = {
  readonly nameText: string;
  readonly codeText: string;
  readonly priceText: string;
  readonly changeAmountText: string;
  readonly changePercentText: string;
};
