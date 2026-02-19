/**
 * decimal 契约测试
 *
 * 功能：
 * - 验证 Decimal Mock 契约与转换/比较行为。
 */
import { describe, expect, it } from 'bun:test';
import { Decimal } from 'longport';
import { decimalEquals, decimalToNumberSafe, toMockDecimal } from '../../mock/longport/decimal.js';

describe('Decimal mock contract', () => {
  it('preserves longport Decimal precision semantics', () => {
    const left = toMockDecimal('0.1');
    const right = toMockDecimal('0.2');
    const result = left.add(right);

    expect(result.toString()).toBe('0.3');
    expect(decimalEquals(result, new Decimal('0.3'))).toBe(true);
  });

  it('supports deterministic conversion back to number', () => {
    const value = toMockDecimal('123.456');
    expect(decimalToNumberSafe(value)).toBeCloseTo(123.456, 6);
  });
});
