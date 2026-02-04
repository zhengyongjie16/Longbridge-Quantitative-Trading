/**
 * Trade API 频率限制器
 *
 * 职责：
 * - 控制 Trade API 调用频率，防止触发 Longbridge API 限流
 * - 支持并发调用（内部锁机制串行化请求）
 *
 * 限流规则：
 * - 30秒内最多 30 次调用
 * - 两次调用间隔不少于 20ms（实际使用 30ms 确保安全）
 */
import { logger } from '../../utils/logger/index.js';
import type { RateLimiter } from '../../types/index.js';
import type { RateLimiterDeps, RateLimiterConfig } from './types.js';

/** 频率限制缓冲时间（毫秒），用于时间窗口边界的安全余量 */
const RATE_LIMIT_BUFFER_MS = 100;

/** 两次调用最小间隔（API 要求 20ms，加 10ms 缓冲） */
const MIN_CALL_INTERVAL_MS = 30;

const DEFAULT_CONFIG: RateLimiterConfig = {
  maxCalls: 30,
  windowMs: 30000,
};

/**
 * 创建频率限制器
 * @param deps 依赖配置
 * @returns RateLimiter 接口实例
 */
export const createRateLimiter = (deps: RateLimiterDeps = {}): RateLimiter => {
  const config = deps.config ?? DEFAULT_CONFIG;
  const maxCalls = config.maxCalls;
  const windowMs = config.windowMs;

  // 闭包捕获的私有状态
  let callTimestamps: number[] = [];
  let throttlePromise: Promise<void> | null = null;

  /**
   * 节流：在调用 API 前检查频率限制
   * 超限时自动等待，支持并发调用（内部锁串行化）
   */
  const throttle = async (): Promise<void> => {
    // 如果有正在执行的 throttle，等待它完成
    while (throttlePromise) {
      await throttlePromise;
    }

    // 设置并发锁
    let releaseLock: () => void = () => {};
    throttlePromise = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    try {
      let now = Date.now();

      // 1. 检查最小调用间隔（两次调用间隔不少于0.02秒）
      const lastCallTime = callTimestamps.at(-1);
      if (lastCallTime) {
        const timeSinceLastCall = now - lastCallTime;
        if (timeSinceLastCall < MIN_CALL_INTERVAL_MS) {
          const waitTime = MIN_CALL_INTERVAL_MS - timeSinceLastCall;
          await new Promise((resolve) => setTimeout(resolve, waitTime));
          now = Date.now(); // 更新当前时间
        }
      }

      // 2. 清理超出时间窗口的调用记录
      callTimestamps = callTimestamps.filter(
        (timestamp) => now - timestamp < windowMs,
      );

      // 3. 如果已达到最大调用次数，等待最早的调用过期
      if (callTimestamps.length >= maxCalls) {
        const oldestCall = callTimestamps[0];
        if (!oldestCall) {
          // 这种情况不应该发生，但为了类型安全还是检查一下
          throw new Error('[频率限制] 调用时间戳数组异常');
        }
        const waitTime = windowMs - (now - oldestCall) + RATE_LIMIT_BUFFER_MS;
        logger.warn(
          `[频率限制] Trade API 调用频率达到上限 (${maxCalls}次/${windowMs}ms)，等待 ${waitTime}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, waitTime));

        const nowAfterWait = Date.now();
        callTimestamps = callTimestamps.filter(
          (timestamp) => nowAfterWait - timestamp < windowMs,
        );
      }

      // 4. 记录本次调用时间
      callTimestamps.push(Date.now());
    } finally {
      // 释放并发锁
      throttlePromise = null;
      releaseLock();
    }
  };

  return {
    throttle,
  };
};
