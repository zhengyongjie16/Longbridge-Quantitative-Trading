import type { Decimal } from 'longport';

/**
 * Decimal 输入类型。
 * 类型用途：统一描述数值工具函数可接受的输入。
 * 数据来源：内部计算值、配置值、SDK Decimal 或字符串数字。
 * 使用范围：numeric 工具函数入参。
 */
export type DecimalInput = Decimal | number | string;

/**
 * 按名义金额换算数量的输入参数。
 * 类型用途：用于统一处理 notional/price/lotSize 的整手换算。
 * 数据来源：交易配置、实时行情、席位手数。
 * 使用范围：订单执行与自动换标买入数量换算。
 */
export type LotQuantityInput = {
  readonly notional: DecimalInput;
  readonly price: DecimalInput;
  readonly lotSize: DecimalInput;
};
