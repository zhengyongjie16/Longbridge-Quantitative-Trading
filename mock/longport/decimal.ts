/**
 * Decimal 辅助（Mock）
 *
 * 功能：
 * - 统一处理 Mock 场景下的数值到 Decimal 转换与比较
 */
import { Decimal } from 'longport';

export type MockDecimalInput = string | number | Decimal;

export function toMockDecimal(value: MockDecimalInput): Decimal {
  if (value instanceof Decimal) {
    return value;
  }
  return new Decimal(value);
}

export function decimalEquals(left: Decimal, right: Decimal): boolean {
  return left.equals(right);
}

export function decimalToNumberSafe(value: Decimal): number {
  return value.toNumber();
}
