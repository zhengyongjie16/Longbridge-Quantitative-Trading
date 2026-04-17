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
  it('rechecks the interval when the scheduler wakes early', async () => {
    const originalNow = performance.now;
    const originalSetTimeout = globalThis.setTimeout;
    let currentTimeMs = 1_000;
    let waitCount = 0;

    Object.defineProperty(performance, 'now', {
      configurable: true,
      value: () => currentTimeMs,
    });

    globalThis.setTimeout = ((callback: () => void, delayMs?: number) => {
      waitCount += 1;
      currentTimeMs += waitCount === 1 ? 25 : (delayMs ?? 0);
      const handle = originalSetTimeout(() => {}, 0);
      callback();
      return handle;
    }) as typeof setTimeout;

    try {
      const limiter = createRateLimiter({
        config: {
          maxCalls: 30,
          windowMs: 30_000,
        },
      });

      await limiter.throttle();
      const firstCallTimeMs = currentTimeMs;
      await limiter.throttle();

      expect(currentTimeMs - firstCallTimeMs).toBeGreaterThanOrEqual(API.MIN_CALL_INTERVAL_MS);
    } finally {
      Object.defineProperty(performance, 'now', {
        configurable: true,
        value: originalNow,
      });
      globalThis.setTimeout = originalSetTimeout;
    }
  });

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
