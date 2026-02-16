/**
 * @module tests/core/trader/rateLimiter.business.test.ts
 * @description 测试模块，围绕 rateLimiter.business.test.ts 场景验证 tests/core/trader 相关业务行为与边界条件。
 */
import { describe, expect, it } from 'bun:test';
import { API } from '../../../src/constants/index.js';
import { createRateLimiter } from '../../../src/core/trader/rateLimiter.js';

describe('rateLimiter business behavior', () => {
  it('serializes concurrent calls and enforces minimum API interval', async () => {
    const limiter = createRateLimiter({
      config: {
        maxCalls: 30,
        windowMs: 30_000,
      },
    });

    const checkpoints: number[] = [];
    const startedAt = Date.now();

    await Promise.all([
      limiter.throttle().then(() => {
        checkpoints.push(Date.now());
      }),
      limiter.throttle().then(() => {
        checkpoints.push(Date.now());
      }),
      limiter.throttle().then(() => {
        checkpoints.push(Date.now());
      }),
    ]);

    const elapsed = Date.now() - startedAt;
    checkpoints.sort((a, b) => a - b);

    expect(checkpoints).toHaveLength(3);
    expect(checkpoints[1]! - checkpoints[0]! >= API.MIN_CALL_INTERVAL_MS).toBe(true);
    expect(checkpoints[2]! - checkpoints[1]! >= API.MIN_CALL_INTERVAL_MS).toBe(true);
    expect(elapsed >= API.MIN_CALL_INTERVAL_MS * 2).toBe(true);
  });
});
