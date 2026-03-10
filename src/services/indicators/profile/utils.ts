import { VERIFICATION_FIXED_INDICATORS } from '../../../constants/index.js';
import {
  parseIndicatorPeriod,
  validateEmaPeriod,
  validatePsyPeriod,
  validateRsiPeriod,
} from '../../../utils/indicatorHelpers/index.js';
import type {
  DisplayIndicatorItem,
  ProfileIndicator,
  VerificationIndicator,
} from '../../../types/state.js';
import type { IndicatorCollector } from './types.js';

/**
 * 解析单个指标名称并标准化为 ProfileIndicator。默认行为：无效或不受支持的名称返回 null。
 *
 * @param indicatorName 原始指标名称
 * @returns 合法指标返回标准化结果，否则返回 null
 */
export function parseProfileIndicator(indicatorName: string): ProfileIndicator | null {
  switch (indicatorName) {
    case 'MFI':
    case 'K':
    case 'D':
    case 'J':
    case 'MACD':
    case 'DIF':
    case 'DEA':
    case 'ADX': {
      return indicatorName;
    }

    default: {
      break;
    }
  }

  if (indicatorName.startsWith('RSI:')) {
    const period = parseIndicatorPeriod({ indicatorName, prefix: 'RSI:' });

    if (period !== null && validateRsiPeriod(period)) {
      return `RSI:${period}`;
    }

    return null;
  }

  if (indicatorName.startsWith('EMA:')) {
    const period = parseIndicatorPeriod({ indicatorName, prefix: 'EMA:' });

    if (period !== null && validateEmaPeriod(period)) {
      return `EMA:${period}`;
    }

    return null;
  }

  if (indicatorName.startsWith('PSY:')) {
    const period = parseIndicatorPeriod({ indicatorName, prefix: 'PSY:' });

    if (period !== null && validatePsyPeriod(period)) {
      return `PSY:${period}`;
    }

    return null;
  }

  return null;
}

/**
 * 判断指标是否属于延迟验证支持集。默认行为：固定支持集优先，其余仅允许 EMA:n 与 PSY:n。
 *
 * @param indicator 标准化后的画像指标
 * @returns 属于延迟验证支持集时返回 true
 */
export function isSupportedVerificationIndicator(
  indicator: ProfileIndicator,
): indicator is VerificationIndicator {
  if (VERIFICATION_FIXED_INDICATORS.has(indicator)) {
    return true;
  }

  return indicator.startsWith('EMA:') || indicator.startsWith('PSY:');
}

/**
 * 将周期集合转换为升序只读数组。默认行为：输出去重后的排序结果。
 *
 * @param periods 周期集合
 * @returns 升序数组
 */
export function toSortedPeriods(periods: ReadonlySet<number>): ReadonlyArray<number> {
  return [...periods].sort((left, right) => left - right);
}

/**
 * 根据收集结果生成展示计划。默认行为：固定以价格、涨跌幅开头，并按既定家族顺序追加指标。
 *
 * @param collector 指标收集器
 * @returns 展示计划（固定顺序）
 */
export function buildDisplayPlan(
  collector: IndicatorCollector,
): ReadonlyArray<DisplayIndicatorItem> {
  const displayPlan: DisplayIndicatorItem[] = ['price', 'changePercent'];
  const emaPeriods = toSortedPeriods(collector.requiredPeriods.ema);
  for (const period of emaPeriods) {
    displayPlan.push(`EMA:${period}`);
  }

  const rsiPeriods = toSortedPeriods(collector.requiredPeriods.rsi);
  for (const period of rsiPeriods) {
    displayPlan.push(`RSI:${period}`);
  }

  if (collector.requiredFamilies.mfi) {
    displayPlan.push('MFI');
  }

  const psyPeriods = toSortedPeriods(collector.requiredPeriods.psy);
  for (const period of psyPeriods) {
    displayPlan.push(`PSY:${period}`);
  }

  if (collector.requiredFamilies.kdj) {
    displayPlan.push('K', 'D', 'J');
  }

  if (collector.requiredFamilies.adx) {
    displayPlan.push('ADX');
  }

  if (collector.requiredFamilies.macd) {
    displayPlan.push('MACD', 'DIF', 'DEA');
  }

  return displayPlan;
}
