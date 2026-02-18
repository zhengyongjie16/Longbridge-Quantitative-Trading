/**
 * Decimal 辅助（Mock）
 *
 * 功能：
 * - 统一处理 Mock 场景下的数值到 Decimal 转换与比较
 */
import { Decimal } from 'longport';

export type MockDecimalInput = string | number | Decimal;

/**
 * 将字符串、数字或 Decimal 统一转换为 Decimal 实例。
 * 若已是 Decimal 则直接返回，避免重复构造。
 * @param value 待转换的数值，支持 string、number 或 Decimal
 * @returns 对应的 Decimal 实例
 */
export function toMockDecimal(value: MockDecimalInput): Decimal {
  if (value instanceof Decimal) {
    return value;
  }
  return new Decimal(value);
}

/**
 * 比较两个 Decimal 是否相等。
 * @param left 左操作数
 * @param right 右操作数
 * @returns 相等返回 true，否则返回 false
 */
export function decimalEquals(left: Decimal, right: Decimal): boolean {
  return left.equals(right);
}

/**
 * 将 Decimal 安全转换为 JavaScript number。
 * 注意：超出 number 精度范围的值可能丢失精度。
 * @param value 待转换的 Decimal 实例
 * @returns 对应的 number 值
 */
export function decimalToNumberSafe(value: Decimal): number {
  return value.toNumber();
}
