/**
 * rateLimiter 业务测试
 *
 * 功能：
 * - 验证限流器相关场景意图、边界条件与业务期望。
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
    const startedAt = performance.now();
    const schedulerToleranceMs = 2;

    await Promise.all([
      limiter.throttle().then(() => {
        checkpoints.push(performance.now());
      }),
      limiter.throttle().then(() => {
        checkpoints.push(performance.now());
      }),
      limiter.throttle().then(() => {
        checkpoints.push(performance.now());
      }),
    ]);

    const elapsed = performance.now() - startedAt;
    checkpoints.sort((a, b) => a - b);

    expect(checkpoints).toHaveLength(3);
    expect(
      checkpoints[1]! - checkpoints[0]! + schedulerToleranceMs >= API.MIN_CALL_INTERVAL_MS,
    ).toBe(true);

    expect(
      checkpoints[2]! - checkpoints[1]! + schedulerToleranceMs >= API.MIN_CALL_INTERVAL_MS,
    ).toBe(true);
    expect(elapsed + schedulerToleranceMs >= API.MIN_CALL_INTERVAL_MS * 2).toBe(true);
  });
});
