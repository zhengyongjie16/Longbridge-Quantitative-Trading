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

import { logger } from '../../utils/logger.js';

export class RateLimiter {
  private readonly maxCalls: number;
  private readonly windowMs: number;
  private callTimestamps: number[];
  private _throttlePromise: Promise<void> | null;

  constructor(maxCalls: number = 30, windowMs: number = 30000) {
    this.maxCalls = maxCalls;
    this.windowMs = windowMs;
    this.callTimestamps = [];
    this._throttlePromise = null; // 并发锁：防止多个并发请求导致超限
  }

  /**
   * 在调用 Trade API 前进行频率控制
   * 如果超过频率限制，会自动等待
   * 支持并发调用（通过内部锁机制确保不会超限）
   */
  async throttle(): Promise<void> {
    // 如果有正在执行的 throttle，等待它完成
    while (this._throttlePromise) {
      await this._throttlePromise;
    }

    // 设置并发锁
    let releaseLock: () => void = () => {}; // 初始化为空函数，避免非空断言
    this._throttlePromise = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    try {
      const now = Date.now();

      // 清理超出时间窗口的调用记录
      this.callTimestamps = this.callTimestamps.filter(
        (timestamp) => now - timestamp < this.windowMs,
      );

      // 如果已达到最大调用次数，等待最早的调用过期
      if (this.callTimestamps.length >= this.maxCalls) {
        const oldestCall = this.callTimestamps[0];
        if (!oldestCall) {
          // 这种情况不应该发生，但为了类型安全还是检查一下
          throw new Error('[频率限制] 调用时间戳数组异常');
        }
        const waitTime = this.windowMs - (now - oldestCall) + 100; // 额外等待100ms作为缓冲
        logger.warn(
          `[频率限制] Trade API 调用频率达到上限 (${this.maxCalls}次/${this.windowMs}ms)，等待 ${waitTime}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, waitTime));

        const nowAfterWait = Date.now();
        this.callTimestamps = this.callTimestamps.filter(
          (timestamp) => nowAfterWait - timestamp < this.windowMs,
        );
      }

      // 记录本次调用时间
      this.callTimestamps.push(Date.now());
    } finally {
      // 释放并发锁
      this._throttlePromise = null;
      releaseLock();
    }
  }
}
