import { validateEmaPeriod, validatePsyPeriod } from '../../utils/indicatorHelpers/index.js';
import {
  DEFAULT_EMA_PERIOD,
  DEFAULT_PSY_PERIOD,
  DEFAULT_RSI_PERIOD,
} from '../../constants/index.js';
import type { VerificationConfig, SignalConfigSet } from '../../types/config.js';

/**
 * 从验证配置中提取 EMA 周期
 * @param verificationConfig 验证配置
 * @returns EMA 周期数组（至少包含默认值 7）
 */
export function extractEmaPeriods(
  verificationConfig: VerificationConfig | null | undefined,
): number[] {
  const emaPeriods: number[] = [];

  if (verificationConfig) {
    // 从买入和卖出配置中提取 EMA 周期
    const allIndicators = [
      ...(verificationConfig.buy.indicators ?? []),
      ...(verificationConfig.sell.indicators ?? []),
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
    emaPeriods.push(DEFAULT_EMA_PERIOD);
  }

  return emaPeriods;
}

/**
 * 从信号配置中提取 RSI 周期
 * @param signalConfig 信号配置
 * @returns RSI 周期数组（至少包含默认值 6）
 */
export function extractRsiPeriodsWithDefault(signalConfig: SignalConfigSet | null): number[] {
  const rsiPeriods = extractIndicatorPeriods(signalConfig, 'RSI:', (period) =>
    Number.isFinite(period),
  );

  // 如果没有配置任何 RSI 周期，使用默认值 6
  if (rsiPeriods.length === 0) {
    rsiPeriods.push(DEFAULT_RSI_PERIOD);
  }

  return rsiPeriods;
}

/**
 * 从信号配置和验证配置中提取 PSY 周期（未配置时使用默认周期）
 * @param signalConfig 信号配置
 * @param verificationConfig 验证配置
 * @returns PSY 周期数组
 */
export function extractPsyPeriods(
  signalConfig: SignalConfigSet | null,
  verificationConfig?: VerificationConfig | null,
): number[] {
  const periods = new Set<number>();

  for (const period of extractIndicatorPeriods(signalConfig, 'PSY:', validatePsyPeriod)) {
    if (validatePsyPeriod(period)) {
      periods.add(period);
    }
  }

  if (verificationConfig) {
    const allIndicators = [
      ...(verificationConfig.buy.indicators ?? []),
      ...(verificationConfig.sell.indicators ?? []),
    ];
    for (const indicator of allIndicators) {
      if (!indicator.startsWith('PSY:')) {
        continue;
      }

      const periodStr = indicator.substring(4);
      const period = Number.parseInt(periodStr, 10);
      if (validatePsyPeriod(period)) {
        periods.add(period);
      }
    }
  }

  if (periods.size === 0 && validatePsyPeriod(DEFAULT_PSY_PERIOD)) {
    periods.add(DEFAULT_PSY_PERIOD);
  }

  return [...periods].sort((a, b) => a - b);
}

/**
 * 从信号配置集中提取指定指标的所有周期（去重后排序）
 * @param signalConfig 信号配置集
 * @param prefix 指标前缀（如 'RSI:' 或 'PSY:'）
 * @param isValidPeriod 周期有效性校验函数
 * @returns 去重排序后的周期数组
 */
function extractIndicatorPeriods(
  signalConfig: SignalConfigSet | null,
  prefix: 'RSI:' | 'PSY:',
  isValidPeriod: (period: number) => boolean,
): number[] {
  if (!signalConfig) {
    return [];
  }
  const periods = new Set<number>();
  const configs = [
    signalConfig.buycall,
    signalConfig.sellcall,
    signalConfig.buyput,
    signalConfig.sellput,
  ];

  for (const config of configs) {
    if (!config?.conditionGroups) {
      continue;
    }
    for (const group of config.conditionGroups) {
      for (const condition of group.conditions) {
        if (!condition.indicator.startsWith(prefix)) {
          continue;
        }
        const periodStr = condition.indicator.split(':')[1];
        if (!periodStr) {
          continue;
        }
        const period = Number.parseInt(periodStr, 10);
        if (isValidPeriod(period)) {
          periods.add(period);
        }
      }
    }
  }
  return [...periods].sort((a, b) => a - b);
}
