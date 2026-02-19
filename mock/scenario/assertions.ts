/**
 * 场景断言工具
 *
 * 功能：
 * - 封装测试中常用的不变量与序列性质断言
 */
import { expect } from 'bun:test';

/** 断言 id 列表无重复，用于订单/成交等序列。 */
export function expectNoDuplicateIds(ids: ReadonlyArray<string>): void {
  expect(new Set(ids).size).toBe(ids.length);
}

/** 断言数值序列单调非降，用于时间戳或序号序列。 */
export function expectMonotonicNonDecreasing(values: ReadonlyArray<number>): void {
  for (let i = 1; i < values.length; i += 1) {
    const prev = values[i - 1];
    const current = values[i];
    expect(current).toBeGreaterThanOrEqual(prev ?? Number.NEGATIVE_INFINITY);
  }
}

/** 断言条件为 true，失败时输出 message；用于不变量检查。 */
export function expectInvariant(condition: boolean, message: string): void {
  expect(condition, message).toBe(true);
}
