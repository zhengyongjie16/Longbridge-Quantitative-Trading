import { getIndicatorValue } from '../../../utils/helpers/indicatorHelpers.js';
import { TIME, VERIFICATION } from '../../../constants/index.js';
import type { Signal } from '../../../types/signal.js';
import type { SingleVerificationConfig } from '../../../types/config.js';
import type { IndicatorCache, IndicatorCacheEntry } from '../indicatorCache/types.js';
import type { PendingSignalEntry, VerificationResult } from './types.js';

/**
 * 生成信号的唯一 ID
 * @param signal 信号对象
 * @returns 格式为 "symbol:action:triggerTime" 的唯一标识
 */
export const generateSignalId = (signal: Signal): string => {
  const triggerTime = signal.triggerTime?.getTime() ?? 0;
  return `${signal.symbol}:${signal.action}:${triggerTime}`;
};

/**
 * 提取信号的初始指标值
 * @param signal 信号对象
 * @param indicatorNames 需要提取的指标名称列表
 * @returns 指标名称到值的映射，若任一指标无效则返回 null
 */
export const extractInitialIndicators = (
  signal: Signal,
  indicatorNames: ReadonlyArray<string>,
): Record<string, number> | null => {
  const indicators1 = signal.indicators1;
  if (!indicators1 || typeof indicators1 !== 'object') {
    return null;
  }

  const result: Record<string, number> = {};
  for (const name of indicatorNames) {
    const value = indicators1[name];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return null;
    }
    result[name] = value;
  }
  return result;
};

/**
 * 验证单个时间点的指标值
 *
 * 检查该时间点的所有指标是否满足趋势条件：
 * - 上涨趋势：当前值 > 初始值
 * - 下跌趋势：当前值 < 初始值
 *
 * @param entry 指标缓存条目，为 null 时视为不通过
 * @param initialIndicators 信号触发时的初始指标名到值的映射
 * @param indicatorNames 待校验的指标名称列表
 * @param isUptrend 是否为上涨趋势（true 则要求当前值 > 初始值）
 * @returns 校验结果，含 passed、details、failedIndicators
 */
const verifyTimePoint = (
  entry: IndicatorCacheEntry | null,
  initialIndicators: Readonly<Record<string, number>>,
  indicatorNames: ReadonlyArray<string>,
  isUptrend: boolean,
): Readonly<{ passed: boolean; details: ReadonlyArray<string>; failedIndicators: ReadonlyArray<string> }> => {
  if (!entry) {
    return { passed: false, details: ['无法获取指标数据'], failedIndicators: [] };
  }

  const details: string[] = [];
  const failedIndicators: string[] = [];
  let allPassed = true;

  for (const name of indicatorNames) {
    const initialValue = initialIndicators[name];
    const currentValueRaw = getIndicatorValue(entry.snapshot, name);

    if (
      initialValue === undefined ||
      currentValueRaw === null ||
      !Number.isFinite(currentValueRaw)
    ) {
      details.push(`${name}: 无效值`);
      failedIndicators.push(name);
      allPassed = false;
      continue;
    }

    const currentValue = currentValueRaw;
    const passed = isUptrend ? currentValue > initialValue : currentValue < initialValue;

    // 根据趋势方向和验证结果确定比较符号
    let symbol: string;
    if (passed) {
      symbol = isUptrend ? '>' : '<';
    } else {
      symbol = isUptrend ? '<=' : '>=';
    }

    details.push(`${name}=${currentValue.toFixed(3)}${symbol}${initialValue.toFixed(3)}`);

    if (!passed) {
      failedIndicators.push(name);
      allPassed = false;
    }
  }

  return { passed: allPassed, details, failedIndicators };
};

/**
 * 执行完整的验证流程
 *
 * 验证逻辑：
 * - 从 IndicatorCache 获取 T0、T0+5s、T0+10s 三个时间点的数据
 * - 所有时间点的所有配置指标都必须满足趋势条件才算通过
 * - 时间容忍度为 ±5 秒
 *
 * @param indicatorCache 指标缓存
 * @param entry 待验证信号条目
 * @param verificationConfig 验证配置
 * @returns 验证结果
 */
export const performVerification = (
  indicatorCache: IndicatorCache,
  entry: PendingSignalEntry,
  verificationConfig: SingleVerificationConfig,
): VerificationResult => {
  const { signal, monitorSymbol, triggerTime, initialIndicators } = entry;
  const indicatorNames = verificationConfig.indicators;

  // 安全检查：指标配置
  if (!indicatorNames || indicatorNames.length === 0) {
    return { passed: false, reason: '验证指标配置为空' };
  }

  // 判断趋势方向
  const isUptrend = signal.action === 'BUYCALL' || signal.action === 'SELLPUT';

  // 定义3个目标时间点
  const toleranceMs = VERIFICATION.TIME_TOLERANCE_MS;
  const t0 = triggerTime;
  const t1 = triggerTime + VERIFICATION.TIME_OFFSET_1_SECONDS * TIME.MILLISECONDS_PER_SECOND;
  const t2 = triggerTime + VERIFICATION.TIME_OFFSET_2_SECONDS * TIME.MILLISECONDS_PER_SECOND;

  // 从 IndicatorCache 获取3个时间点的数据
  const entry0 = indicatorCache.getAt(monitorSymbol, t0, toleranceMs);
  const entry1 = indicatorCache.getAt(monitorSymbol, t1, toleranceMs);
  const entry2 = indicatorCache.getAt(monitorSymbol, t2, toleranceMs);

  // 检查是否所有时间点都有数据
  if (!entry0 || !entry1 || !entry2) {
    const missing: string[] = [];
    if (!entry0) missing.push('T0');
    if (!entry1) missing.push('T0+5s');
    if (!entry2) missing.push('T0+10s');
    return { passed: false, reason: `缺少时间点数据: ${missing.join(', ')}` };
  }

  // 验证3个时间点
  const result0 = verifyTimePoint(entry0, initialIndicators, indicatorNames, isUptrend);
  const result1 = verifyTimePoint(entry1, initialIndicators, indicatorNames, isUptrend);
  const result2 = verifyTimePoint(entry2, initialIndicators, indicatorNames, isUptrend);

  // 收集所有失败的指标
  const allFailedIndicators = new Set<string>([
    ...result0.failedIndicators,
    ...result1.failedIndicators,
    ...result2.failedIndicators,
  ]);

  // 计算时间差
  const timeDiff0 = Math.abs(entry0.timestamp - t0) / TIME.MILLISECONDS_PER_SECOND;
  const timeDiff1 = Math.abs(entry1.timestamp - t1) / TIME.MILLISECONDS_PER_SECOND;
  const timeDiff2 = Math.abs(entry2.timestamp - t2) / TIME.MILLISECONDS_PER_SECOND;

  // 构建详细信息
  const detailParts = [
    `T0: ${result0.details.join(' ')}`,
    `T0+5s: ${result1.details.join(' ')}`,
    `T0+10s: ${result2.details.join(' ')}`,
    `时间差T0=${timeDiff0.toFixed(1)}s T0+5s=${timeDiff1.toFixed(1)}s T0+10s=${timeDiff2.toFixed(1)}s`,
  ];

  const passed = result0.passed && result1.passed && result2.passed;

  if (!passed && allFailedIndicators.size > 0) {
    detailParts.push(`[失败指标: ${Array.from(allFailedIndicators).join(', ')}]`);
  }

  return {
    passed,
    reason: detailParts.join(' | '),
    failedIndicators: Array.from(allFailedIndicators),
  };
};
