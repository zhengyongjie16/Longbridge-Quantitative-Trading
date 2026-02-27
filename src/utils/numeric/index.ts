import { Decimal } from 'longport';
import type { DecimalInput, LotQuantityInput } from './types.js';

/**
 * 将 DecimalInput 转换为 Decimal。
 *
 * @param value 输入值（Decimal、number、string）
 * @returns Decimal 实例
 */
export function toDecimalValue(value: DecimalInput): Decimal {
  if (value instanceof Decimal) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Invalid number for Decimal conversion: ${value}`);
    }
    return new Decimal(value.toString());
  }
  return new Decimal(value);
}

/**
 * 严格将 unknown 转换为 Decimal；不合法输入返回 null。
 *
 * @param value 未知输入
 * @returns 合法时返回 Decimal，否则返回 null
 */
export function toDecimalStrict(value: unknown): Decimal | null {
  if (value instanceof Decimal) {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return null;
    }
    return new Decimal(value.toString());
  }

  if (typeof value === 'string') {
    const text = value.trim();
    if (text.length === 0) {
      return null;
    }
    try {
      return new Decimal(text);
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * 判断 DecimalInput 是否为正数。
 *
 * @param value 输入值
 * @returns 大于 0 时返回 true
 */
export function isPositiveDecimal(value: DecimalInput): boolean {
  return toDecimalValue(value).greaterThan(Decimal.ZERO());
}

/**
 * 判断 DecimalInput 是否为非负数。
 *
 * @param value 输入值
 * @returns 大于等于 0 时返回 true
 */
export function isNonNegativeDecimal(value: DecimalInput): boolean {
  return toDecimalValue(value).greaterThanOrEqualTo(Decimal.ZERO());
}

/**
 * Decimal 加法。
 *
 * @param left 左操作数
 * @param right 右操作数
 * @returns 相加结果
 */
export function decimalAdd(left: DecimalInput, right: DecimalInput): Decimal {
  return toDecimalValue(left).add(toDecimalValue(right));
}

/**
 * Decimal 减法。
 *
 * @param left 左操作数
 * @param right 右操作数
 * @returns 相减结果
 */
export function decimalSub(left: DecimalInput, right: DecimalInput): Decimal {
  return toDecimalValue(left).sub(toDecimalValue(right));
}

/**
 * Decimal 乘法。
 *
 * @param left 左操作数
 * @param right 右操作数
 * @returns 相乘结果
 */
export function decimalMul(left: DecimalInput, right: DecimalInput): Decimal {
  return toDecimalValue(left).mul(toDecimalValue(right));
}

/**
 * Decimal 除法。
 *
 * @param left 左操作数
 * @param right 右操作数
 * @returns 相除结果
 */
export function decimalDiv(left: DecimalInput, right: DecimalInput): Decimal {
  return toDecimalValue(left).div(toDecimalValue(right));
}

/**
 * Decimal 取绝对值。
 *
 * @param value 输入值
 * @returns 绝对值
 */
export function decimalAbs(value: DecimalInput): Decimal {
  return toDecimalValue(value).abs();
}

/**
 * Decimal 取负。
 *
 * @param value 输入值
 * @returns 取负结果
 */
export function decimalNeg(value: DecimalInput): Decimal {
  return toDecimalValue(value).neg();
}

/**
 * Decimal 向下取整。
 *
 * @param value 输入值
 * @returns floor 结果
 */
export function decimalFloor(value: DecimalInput): Decimal {
  return toDecimalValue(value).floor();
}

/**
 * Decimal 比较：小于。
 *
 * @param left 左值
 * @param right 右值
 * @returns left < right
 */
export function decimalLt(left: DecimalInput, right: DecimalInput): boolean {
  return toDecimalValue(left).comparedTo(toDecimalValue(right)) < 0;
}

/**
 * Decimal 比较：小于等于。
 *
 * @param left 左值
 * @param right 右值
 * @returns left <= right
 */
export function decimalLte(left: DecimalInput, right: DecimalInput): boolean {
  return toDecimalValue(left).comparedTo(toDecimalValue(right)) <= 0;
}

/**
 * Decimal 比较：大于。
 *
 * @param left 左值
 * @param right 右值
 * @returns left > right
 */
export function decimalGt(left: DecimalInput, right: DecimalInput): boolean {
  return toDecimalValue(left).comparedTo(toDecimalValue(right)) > 0;
}

/**
 * Decimal 比较：大于等于。
 *
 * @param left 左值
 * @param right 右值
 * @returns left >= right
 */
export function decimalGte(left: DecimalInput, right: DecimalInput): boolean {
  return toDecimalValue(left).comparedTo(toDecimalValue(right)) >= 0;
}

/**
 * Decimal 比较：相等。
 *
 * @param left 左值
 * @param right 右值
 * @returns left == right
 */
export function decimalEq(left: DecimalInput, right: DecimalInput): boolean {
  return toDecimalValue(left).comparedTo(toDecimalValue(right)) === 0;
}

/**
 * 判断数量是否满足整手约束。
 *
 * @param quantity 数量
 * @param lotSize 每手股数
 * @returns quantity 是否为 lotSize 的整数倍
 */
export function isLotMultiple(quantity: DecimalInput, lotSize: DecimalInput): boolean {
  const lotSizeDecimal = toDecimalValue(lotSize);
  if (!lotSizeDecimal.greaterThan(Decimal.ZERO())) {
    return false;
  }
  return toDecimalValue(quantity).rem(lotSizeDecimal).isZero();
}

/**
 * 将数量按整手向下取整。
 *
 * @param quantity 原始数量
 * @param lotSize 每手股数
 * @returns 向下对齐后的数量；lotSize 非法时返回 null
 */
export function floorQuantityToLotSize(quantity: DecimalInput, lotSize: DecimalInput): Decimal | null {
  const quantityDecimal = toDecimalValue(quantity);
  const lotSizeDecimal = toDecimalValue(lotSize);

  if (
    !quantityDecimal.greaterThan(Decimal.ZERO()) ||
    !lotSizeDecimal.greaterThan(Decimal.ZERO())
  ) {
    return null;
  }

  const alignedLots = quantityDecimal.div(lotSizeDecimal).floor();
  return alignedLots.mul(lotSizeDecimal);
}

/**
 * 按名义金额计算整手买入数量。
 *
 * @param input 包含 notional、price、lotSize
 * @returns 对齐后的数量；参数无效或不足一手时返回 null
 */
export function calculateLotQuantityByNotional(input: LotQuantityInput): Decimal | null {
  const notionalDecimal = toDecimalValue(input.notional);
  const priceDecimal = toDecimalValue(input.price);
  const lotSizeDecimal = toDecimalValue(input.lotSize);

  if (
    !notionalDecimal.greaterThan(Decimal.ZERO()) ||
    !priceDecimal.greaterThan(Decimal.ZERO()) ||
    !lotSizeDecimal.greaterThan(Decimal.ZERO())
  ) {
    return null;
  }

  const rawQuantity = notionalDecimal.div(priceDecimal).floor();
  const alignedQuantity = floorQuantityToLotSize(rawQuantity, lotSizeDecimal);
  if (!alignedQuantity) {
    return null;
  }
  if (alignedQuantity.lessThan(lotSizeDecimal)) {
    return null;
  }

  return alignedQuantity;
}

/**
 * 将 DecimalInput 转换为 number（用于现有 number 类型边界输出）。
 *
 * @param value 输入值
 * @returns number 值
 */
export function decimalToNumberValue(value: DecimalInput): number {
  return toDecimalValue(value).toNumber();
}

/**
 * 格式化 DecimalInput 为固定小数字符串（仅展示用途）。
 *
 * @param value 输入值
 * @param digits 小数位数
 * @returns 固定小数字符串
 */
export function formatDecimal(value: DecimalInput, digits: number): string {
  const safeDigits = Number.isInteger(digits) && digits >= 0 ? digits : 2;
  return toDecimalValue(value).roundDp(safeDigits).toNumber().toFixed(safeDigits);
}
