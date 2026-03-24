/**
 * 买入节流模块
 *
 * 职责：
 * - 维护买入频率限制运行态（lastBuyTime）
 * - 提供 canTradeNow / recordBuyAttempt / resetBuyThrottle
 * - 记录“买入尝试”时点，确保频率检查通过后立即占用窗口
 */
import { TIME } from '../../../constants/index.js';
import { isBuyAction } from '../../../utils/helpers/index.js';
import { isSellAction } from '../../../utils/display/index.js';
import type { MonitorConfig } from '../../../types/config.js';
import type { SignalType } from '../../../types/signal.js';
import type { BuyThrottle } from './types.js';
import { buildBuyTimeKey } from './utils.js';

/**
 * 创建买入节流器。
 *
 * @returns 买入节流器实例
 */
export function createBuyThrottle(): BuyThrottle {
  const lastBuyTime = new Map<string, number>();

  /**
   * 检查买入频率限制（卖出不限制）。
   *
   * @param signalAction 信号动作
   * @param monitorConfig 监控配置
   * @returns 频率检查结果
   */
  function canTradeNow(signalAction: SignalType, monitorConfig?: MonitorConfig | null) {
    if (isSellAction(signalAction)) {
      return { canTrade: true };
    }

    const direction: 'LONG' | 'SHORT' = signalAction === 'BUYCALL' ? 'LONG' : 'SHORT';
    const buyIntervalSeconds = monitorConfig?.buyIntervalSeconds ?? 60;
    const timeKey = buildBuyTimeKey(signalAction, monitorConfig);
    const lastTime = lastBuyTime.get(timeKey);
    if (!lastTime) {
      return { canTrade: true };
    }

    const now = Date.now();
    const timeDiff = now - lastTime;
    const intervalMs = buyIntervalSeconds * TIME.MILLISECONDS_PER_SECOND;
    if (timeDiff >= intervalMs) {
      return { canTrade: true };
    }

    const waitSeconds = Math.ceil((intervalMs - timeDiff) / TIME.MILLISECONDS_PER_SECOND);
    return {
      canTrade: false,
      waitSeconds,
      direction,
      reason: `需等待 ${waitSeconds} 秒`,
    };
  }

  /**
   * 记录买入时间（用于频率限制）。
   *
   * @param signalAction 信号动作
   * @param monitorConfig 监控配置
   * @returns 无返回值
   */
  function recordBuyAttempt(signalAction: SignalType, monitorConfig?: MonitorConfig | null): void {
    if (isBuyAction(signalAction)) {
      lastBuyTime.set(buildBuyTimeKey(signalAction, monitorConfig), Date.now());
    }
  }

  /**
   * 清空买入节流状态。
   *
   * @returns 无返回值
   */
  function resetBuyThrottle(): void {
    lastBuyTime.clear();
  }

  return {
    canTradeNow,
    resetBuyThrottle,
    recordBuyAttempt,
  };
}
