/**
 * 监控上下文模块独享的工具函数
 */

import {
  extractRSIPeriods,
  extractPsyPeriods as extractPsyPeriodsFromSignalConfig,
} from '../../utils/helpers/signalConfigParser.js';
import { validateEmaPeriod } from '../../utils/helpers/indicatorHelpers.js';
import type { VerificationConfig, SignalConfigSet } from '../../types/index.js';

/**
 * 从验证配置中提取 EMA 周期
 * @param verificationConfig 验证配置
 * @returns EMA 周期数组（至少包含默认值 7）
 */
export function extractEmaPeriods(verificationConfig: VerificationConfig | null | undefined): number[] {
  const emaPeriods: number[] = [];

  if (verificationConfig) {
    // 从买入和卖出配置中提取 EMA 周期
    const allIndicators = [
      ...(verificationConfig.buy.indicators || []),
      ...(verificationConfig.sell.indicators || []),
    ];

    for (const indicator of allIndicators) {
      if (indicator.startsWith('EMA:')) {
        const periodStr = indicator.substring(4);
        const period = Number.parseInt(periodStr, 10);

        if (validateEmaPeriod(period) && !emaPeriods.includes(period)) {
          emaPeriods.push(period);
        }
      }
    }
  }

  // 如果没有配置任何 EMA 周期，使用默认值 7
  if (emaPeriods.length === 0) {
    emaPeriods.push(7);
  }

  return emaPeriods;
}

/**
 * 从信号配置中提取 RSI 周期
 * @param signalConfig 信号配置
 * @returns RSI 周期数组（至少包含默认值 6）
 */
export function extractRsiPeriodsWithDefault(signalConfig: SignalConfigSet | null): number[] {
  const rsiPeriods = extractRSIPeriods(signalConfig);

  // 如果没有配置任何 RSI 周期，使用默认值 6
  if (rsiPeriods.length === 0) {
    rsiPeriods.push(6);
  }

  return rsiPeriods;
}

/**
 * 从信号配置中提取 PSY 周期（不设置默认周期）
 * @param signalConfig 信号配置
 * @returns PSY 周期数组
 */
export function extractPsyPeriods(signalConfig: SignalConfigSet | null): number[] {
  return extractPsyPeriodsFromSignalConfig(signalConfig);
}
