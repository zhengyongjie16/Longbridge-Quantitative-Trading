/**
 * Trade API 频率限制器
 *
 * 功能：
 * - 控制 Trade API 调用频率，防止超过 Longbridge API 限制
 * - 支持并发调用（通过内部锁机制确保不会超限）
 *
 * API 限制：
 * - 30秒内不超过30次调用
 * - 两次调用间隔不少于0.02秒
 */

import { logger } from '../../utils/logger/index.js';
import type { RateLimiter, RateLimiterDeps, RateLimiterConfig } from './types.js';

// 常量定义
/**
 * 频率限制缓冲时间（毫秒）
 * 当 API 调用频率达到上限时，计算等待时间时额外添加的缓冲时间
 * 确保在时间窗口边界处不会因为时间计算误差导致超限
 */
const RATE_LIMIT_BUFFER_MS = 100;

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
   * 在调用 Trade API 前进行频率控制
   * 如果超过频率限制，会自动等待
   * 支持并发调用（通过内部锁机制确保不会超限）
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
      const now = Date.now();

      // 清理超出时间窗口的调用记录
      callTimestamps = callTimestamps.filter(
        (timestamp) => now - timestamp < windowMs,
      );

      // 如果已达到最大调用次数，等待最早的调用过期
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

      // 记录本次调用时间
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
