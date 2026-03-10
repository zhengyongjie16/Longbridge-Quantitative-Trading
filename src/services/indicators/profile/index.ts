/**
 * indicators/profile 指标画像编译模块
 *
 * 职责：
 * - 从 signalConfig 与 verificationConfig 编译指标画像
 * - 统一收集家族开关、周期集合与展示计划
 * - 约束延迟验证支持集，避免运行时处理不支持的指标
 */
import { STRATEGY_ACTIONS } from '../../../constants/index.js';
import { parseIndicatorPeriod } from '../../../utils/indicatorHelpers/index.js';
import type { SignalConfigSet, VerificationConfig } from '../../../types/config.js';
import type {
  IndicatorUsageProfile,
  ProfileIndicator,
  SignalIndicator,
  StrategyAction,
  VerificationIndicator,
} from '../../../types/state.js';
import type { IndicatorCollector } from './types.js';
import {
  buildDisplayPlan,
  isSupportedSignalIndicator,
  isSupportedVerificationIndicator,
  parseProfileIndicator,
  toSortedPeriods,
} from './utils.js';

/**
 * 向目标数组追加唯一指标，避免同一 action 或验证列表重复记录。
 *
 * @param indicators 目标指标数组
 * @param indicator 待追加指标
 * @returns void
 */
function appendUniqueIndicator<T extends ProfileIndicator | SignalIndicator>(
  indicators: T[],
  indicator: T,
): void {
  if (!indicators.includes(indicator)) {
    indicators.push(indicator);
  }
}

/**
 * 将周期型指标写入全局周期集合，供后续运行时按需计算。
 *
 * @param indicator 标准化指标名
 * @param collector 指标收集器
 * @returns void
 */
function collectPeriodIfNeeded(indicator: ProfileIndicator, collector: IndicatorCollector): void {
  if (indicator.startsWith('RSI:')) {
    const period = parseIndicatorPeriod({ indicatorName: indicator, prefix: 'RSI:' });

    if (period !== null) {
      collector.requiredPeriods.rsi.add(period);
    }

    return;
  }

  if (indicator.startsWith('EMA:')) {
    const period = parseIndicatorPeriod({ indicatorName: indicator, prefix: 'EMA:' });

    if (period !== null) {
      collector.requiredPeriods.ema.add(period);
    }

    return;
  }

  if (indicator.startsWith('PSY:')) {
    const period = parseIndicatorPeriod({ indicatorName: indicator, prefix: 'PSY:' });

    if (period !== null) {
      collector.requiredPeriods.psy.add(period);
    }
  }
}

/**
 * 收集单个指标的家族与周期需求，保证 profile 中的运行时需求完整。
 *
 * @param indicator 标准化指标名
 * @param collector 指标收集器
 * @returns void
 */
function collectIndicatorUsage(indicator: ProfileIndicator, collector: IndicatorCollector): void {
  if (indicator === 'K' || indicator === 'D' || indicator === 'J') {
    collector.requiredFamilies.kdj = true;
    return;
  }

  if (indicator === 'MACD' || indicator === 'DIF' || indicator === 'DEA') {
    collector.requiredFamilies.macd = true;
    return;
  }

  if (indicator === 'MFI') {
    collector.requiredFamilies.mfi = true;
    return;
  }

  if (indicator === 'ADX') {
    collector.requiredFamilies.adx = true;
    return;
  }

  collectPeriodIfNeeded(indicator, collector);
}

/**
 * 将原始指标列表编译为信号条件支持的指标列表，同时累计运行时所需的家族与周期集合。
 *
 * @param sourceIndicators 原始指标字符串列表
 * @param collector 指标收集器
 * @returns 去重后的标准化指标列表
 */
function compileSignalIndicatorList(
  sourceIndicators: ReadonlyArray<string>,
  collector: IndicatorCollector,
): ReadonlyArray<SignalIndicator> {
  const compiledIndicators: SignalIndicator[] = [];

  for (const indicatorName of sourceIndicators) {
    const parsedIndicator = parseProfileIndicator(indicatorName);
    if (!parsedIndicator) {
      continue;
    }

    if (!isSupportedSignalIndicator(parsedIndicator)) {
      throw new Error(`[配置错误] 信号条件不支持指标: ${indicatorName}`);
    }

    collectIndicatorUsage(parsedIndicator, collector);
    appendUniqueIndicator(compiledIndicators, parsedIndicator);
  }

  return compiledIndicators;
}

/**
 * 编译延迟验证指标列表，并严格限制到验证器支持的指标集合。
 *
 * @param sourceIndicators 原始验证指标字符串列表
 * @param collector 指标收集器
 * @returns 去重后的验证指标列表
 */
function compileVerificationIndicatorList(
  sourceIndicators: ReadonlyArray<string>,
  collector: IndicatorCollector,
): ReadonlyArray<VerificationIndicator> {
  const compiledIndicators: VerificationIndicator[] = [];

  for (const indicatorName of sourceIndicators) {
    const parsedIndicator = parseProfileIndicator(indicatorName);
    if (!parsedIndicator) {
      throw new Error(`[配置错误] 延迟验证指标无效: ${indicatorName}`);
    }

    if (!isSupportedVerificationIndicator(parsedIndicator)) {
      throw new Error(`[配置错误] 延迟验证不支持指标: ${indicatorName}`);
    }

    collectIndicatorUsage(parsedIndicator, collector);
    appendUniqueIndicator(compiledIndicators, parsedIndicator);
  }

  return compiledIndicators;
}

/**
 * 收集某个 action 配置中出现的原始指标名称，用于后续编译。
 *
 * @param signalConfig 信号配置
 * @param action 策略动作
 * @returns 原始指标名称列表
 */
function collectActionSourceIndicators(
  signalConfig: SignalConfigSet,
  action: StrategyAction,
): ReadonlyArray<string> {
  let actionConfig: SignalConfigSet['buycall'];
  if (action === 'BUYCALL') {
    actionConfig = signalConfig.buycall;
  } else if (action === 'SELLCALL') {
    actionConfig = signalConfig.sellcall;
  } else if (action === 'BUYPUT') {
    actionConfig = signalConfig.buyput;
  } else {
    actionConfig = signalConfig.sellput;
  }

  if (!actionConfig?.conditionGroups) {
    return [];
  }

  const indicators: string[] = [];
  for (const group of actionConfig.conditionGroups) {
    for (const condition of group.conditions) {
      indicators.push(condition.indicator);
    }
  }

  return indicators;
}

/**
 * 编译监控标的指标画像，统一输出运行时按需计算与展示所需的完整 profile。
 *
 * @param params 编译入参（信号配置 + 延迟验证配置）
 * @returns 监控标的指标画像
 */
export function compileIndicatorUsageProfile(params: {
  readonly signalConfig: SignalConfigSet;
  readonly verificationConfig: VerificationConfig;
}): IndicatorUsageProfile {
  const collector: IndicatorCollector = {
    requiredFamilies: {
      mfi: false,
      kdj: false,
      macd: false,
      adx: false,
    },
    requiredPeriods: {
      rsi: new Set<number>(),
      ema: new Set<number>(),
      psy: new Set<number>(),
    },
  };

  const actionSignalIndicators: Record<StrategyAction, ReadonlyArray<SignalIndicator>> = {
    BUYCALL: [],
    SELLCALL: [],
    BUYPUT: [],
    SELLPUT: [],
  };

  for (const action of STRATEGY_ACTIONS) {
    const actionSourceIndicators = collectActionSourceIndicators(params.signalConfig, action);
    actionSignalIndicators[action] = compileSignalIndicatorList(actionSourceIndicators, collector);
  }

  const buyVerificationIndicators = compileVerificationIndicatorList(
    params.verificationConfig.buy.indicators ?? [],
    collector,
  );
  const sellVerificationIndicators = compileVerificationIndicatorList(
    params.verificationConfig.sell.indicators ?? [],
    collector,
  );

  return {
    requiredFamilies: {
      mfi: collector.requiredFamilies.mfi,
      kdj: collector.requiredFamilies.kdj,
      macd: collector.requiredFamilies.macd,
      adx: collector.requiredFamilies.adx,
    },
    requiredPeriods: {
      rsi: toSortedPeriods(collector.requiredPeriods.rsi),
      ema: toSortedPeriods(collector.requiredPeriods.ema),
      psy: toSortedPeriods(collector.requiredPeriods.psy),
    },
    actionSignalIndicators,
    verificationIndicatorsBySide: {
      buy: buyVerificationIndicators,
      sell: sellVerificationIndicators,
    },
    displayPlan: buildDisplayPlan(collector),
  };
}
