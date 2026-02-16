import { expect } from 'bun:test';

export function expectNoDuplicateIds(ids: ReadonlyArray<string>): void {
  expect(new Set(ids).size).toBe(ids.length);
}

export function expectMonotonicNonDecreasing(values: ReadonlyArray<number>): void {
  for (let i = 1; i < values.length; i += 1) {
    const prev = values[i - 1];
    const current = values[i];
    expect(current).toBeGreaterThanOrEqual(prev ?? Number.NEGATIVE_INFINITY);
  }
}

export function expectInvariant(condition: boolean, message: string): void {
  expect(condition, message).toBe(true);
}
