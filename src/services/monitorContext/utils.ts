import {
  parseIndicatorPeriod,
  validateEmaPeriod,
  validatePsyPeriod,
  validateRsiPeriod,
} from '../../utils/indicatorHelpers/index.js';
import { VERIFICATION_FIXED_INDICATORS } from '../../constants/index.js';
import type { SignalConfigSet, VerificationConfig } from '../../types/config.js';
import type {
  DisplayIndicatorItem,
  IndicatorUsageProfile,
  ProfileIndicator,
  StrategyAction,
  VerificationIndicator,
} from '../../types/state.js';

const STRATEGY_ACTIONS: ReadonlyArray<StrategyAction> = [
  'BUYCALL',
  'SELLCALL',
  'BUYPUT',
  'SELLPUT',
];

type IndicatorCollector = {
  readonly requiredFamilies: {
    mfi: boolean;
    kdj: boolean;
    macd: boolean;
    adx: boolean;
  };
  readonly requiredPeriods: {
    readonly rsi: Set<number>;
    readonly ema: Set<number>;
    readonly psy: Set<number>;
  };
};

/**
 * 解析单个指标名称并标准化为 ProfileIndicator。
 * @param indicatorName 原始指标名称
 * @returns 合法指标返回标准化结果，否则返回 null
 */
function parseProfileIndicator(indicatorName: string): ProfileIndicator | null {
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
 * 向目标数组追加唯一指标。
 * @param indicators 目标指标数组
 * @param indicator 待追加指标
 */
function appendUniqueIndicator(indicators: ProfileIndicator[], indicator: ProfileIndicator): void {
  if (!indicators.includes(indicator)) {
    indicators.push(indicator);
  }
}

/**
 * 收集周期指标到全局周期集合。
 * @param indicator 标准化指标名
 * @param collector 指标收集器
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
 * 收集单个指标的全局使用信息（家族开关与周期集合）。
 * @param indicator 标准化指标名
 * @param collector 指标收集器
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
 * 将指标字符串列表编译为 ProfileIndicator 列表并写入收集器。
 * @param sourceIndicators 原始指标字符串列表
 * @param collector 指标收集器
 * @returns 去重后的标准化指标列表（保持配置原始粒度）
 */
function compileIndicatorList(
  sourceIndicators: ReadonlyArray<string>,
  collector: IndicatorCollector,
): ReadonlyArray<ProfileIndicator> {
  const compiledIndicators: ProfileIndicator[] = [];

  for (const indicatorName of sourceIndicators) {
    const parsedIndicator = parseProfileIndicator(indicatorName);
    if (!parsedIndicator) {
      continue;
    }

    collectIndicatorUsage(parsedIndicator, collector);
    appendUniqueIndicator(compiledIndicators, parsedIndicator);
  }

  return compiledIndicators;
}

function isSupportedVerificationIndicator(
  indicator: ProfileIndicator,
): indicator is VerificationIndicator {
  if (VERIFICATION_FIXED_INDICATORS.has(indicator)) {
    return true;
  }

  return indicator.startsWith('EMA:') || indicator.startsWith('PSY:');
}

/**
 * 编译延迟验证指标列表。
 *
 * 重要约束：
 * - 延迟验证仅支持 K/D/J、MACD/DIF/DEA、ADX、EMA:n、PSY:n；
 * - 明确不支持 RSI:n 与 MFI（即便它们可用于信号条件求值与展示）。
 *
 * @param sourceIndicators 原始指标字符串列表（来自 verificationConfig）
 * @param collector 指标收集器
 * @returns 去重后的标准化指标列表（保持配置原始粒度）
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
 * 收集 action 配置中出现的原始指标名称。
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
 * 将周期集合转换为排序后的只读数组。
 * @param periods 周期集合
 * @returns 升序数组
 */
function toSortedPeriods(periods: ReadonlySet<number>): ReadonlyArray<number> {
  return [...periods].sort((a, b) => a - b);
}

/**
 * 根据收集结果生成最终展示计划。
 * @param collector 指标收集器
 * @returns 展示计划（固定顺序）
 */
function buildDisplayPlan(collector: IndicatorCollector): ReadonlyArray<DisplayIndicatorItem> {
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

/**
 * 编译监控标的指标画像。
 *
 * 编译规则：
 * - 指标来源为 signalConfig + verificationConfig；
 * - 命中 K/D/J 任一项时标记 KDJ 家族已启用（用于按需计算与展示）；
 * - 命中 MACD/DIF/DEA 任一项时标记 MACD 家族已启用（用于按需计算与展示）；
 * - RSI/EMA/PSY 周期去重并排序；
 * - 不注入任何默认周期。
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

  const actionSignalIndicators: Record<StrategyAction, ReadonlyArray<ProfileIndicator>> = {
    BUYCALL: [],
    SELLCALL: [],
    BUYPUT: [],
    SELLPUT: [],
  };

  for (const action of STRATEGY_ACTIONS) {
    const actionSourceIndicators = collectActionSourceIndicators(params.signalConfig, action);
    actionSignalIndicators[action] = compileIndicatorList(actionSourceIndicators, collector);
  }

  const buyVerificationIndicators = compileVerificationIndicatorList(
    params.verificationConfig.buy.indicators ?? [],
    collector,
  );
  const sellVerificationIndicators = compileVerificationIndicatorList(
    params.verificationConfig.sell.indicators ?? [],
    collector,
  );

  const requiredPeriods = {
    rsi: toSortedPeriods(collector.requiredPeriods.rsi),
    ema: toSortedPeriods(collector.requiredPeriods.ema),
    psy: toSortedPeriods(collector.requiredPeriods.psy),
  };

  return {
    requiredFamilies: {
      mfi: collector.requiredFamilies.mfi,
      kdj: collector.requiredFamilies.kdj,
      macd: collector.requiredFamilies.macd,
      adx: collector.requiredFamilies.adx,
    },
    requiredPeriods,
    actionSignalIndicators,
    verificationIndicatorsBySide: {
      buy: buyVerificationIndicators,
      sell: sellVerificationIndicators,
    },
    displayPlan: buildDisplayPlan(collector),
  };
}
