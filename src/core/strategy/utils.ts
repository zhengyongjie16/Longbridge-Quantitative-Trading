import { isValidNumber } from '../../utils/indicatorHelpers/index.js';
import { decimalGt, decimalLt } from '../../utils/numeric/index.js';
import type { IndicatorSnapshot } from '../../types/quote.js';
import type { Signal } from '../../types/signal.js';
import type { SingleVerificationConfig } from '../../types/config.js';
import type { Condition, ConditionGroup, SignalConfig } from '../../types/signalConfig.js';
import type { ConditionGroupResult, EvaluationResult, SignalWithCategory } from './types.js';
import type { IndicatorState } from '../../utils/indicatorHelpers/types.js';

/**
 * 判断是否需要延迟验证。
 * 默认行为：delaySeconds > 0 且 indicators 非空时视为需要延迟验证，否则立即执行。
 *
 * @param config 验证配置（含 delaySeconds、indicators）
 * @returns true 需要延迟验证，false 立即执行
 */
export function needsDelayedVerification(config: SingleVerificationConfig): boolean {
  return config.delaySeconds > 0 && (config.indicators?.length ?? 0) > 0;
}

/**
 * 判断 RSI 对象是否包含至少一个有效数值（内部辅助）。
 * 默认行为：rsi 为 null、非对象或所有周期值均无效时返回 false。
 *
 * @param rsi 指标快照中的 rsi 字段（可为 null 或各周期 RSI 对象）
 * @returns true 表示存在至少一个有效 RSI 值，否则为 false
 */
function hasValidRsiValue(rsi: IndicatorSnapshot['rsi']): boolean {
  return (
    rsi !== null && typeof rsi === 'object' && Object.values(rsi).some((v) => isValidNumber(v))
  );
}

/**
 * 验证基本指标有效性（RSI、MFI、KDJ）。
 * 默认行为：任一指标缺失或非有限数则返回 false。
 *
 * @param state 当前指标快照
 * @returns true 所有基本指标有效，否则为 false
 */
export function validateBasicIndicators(state: IndicatorSnapshot): boolean {
  const { rsi, mfi, kdj } = state;
  return (
    hasValidRsiValue(rsi) &&
    isValidNumber(mfi) &&
    kdj !== null &&
    isValidNumber(kdj.d) &&
    isValidNumber(kdj.j)
  );
}

/**
 * 验证所有指标有效性（基本指标 + MACD + 价格）。
 * 默认行为：在 validateBasicIndicators 通过前提下，MACD 或 price 无效则返回 false。
 *
 * @param state 当前指标快照
 * @returns true 所有指标有效，否则为 false
 */
export function validateAllIndicators(state: IndicatorSnapshot): boolean {
  const { macd, price } = state;
  return (
    validateBasicIndicators(state) &&
    macd !== null &&
    isValidNumber(macd.macd) &&
    isValidNumber(price)
  );
}

/**
 * 根据指标状态评估完整信号配置，满足任一组即触发。默认行为：signalConfig 为空或无效时返回 triggered=false、reason 为「无效的信号配置」。
 *
 * @param state 指标状态（ema、rsi、psy、mfi、kdj 等）
 * @param signalConfig 信号配置（conditionGroups）
 * @returns 评估结果（triggered、satisfiedGroupIndex、satisfiedCount、reason）
 */
export function evaluateSignalConfig(
  state: IndicatorState,
  signalConfig: SignalConfig | null,
): EvaluationResult {
  if (!signalConfig?.conditionGroups) {
    return {
      triggered: false,
      satisfiedGroupIndex: -1,
      satisfiedCount: 0,
      reason: '无效的信号配置',
    };
  }

  const { conditionGroups } = signalConfig;
  for (const [index, group] of conditionGroups.entries()) {
    const result = evaluateConditionGroup(state, group);

    if (result.satisfied) {
      const conditionDescs = group.conditions
        .map((condition) => `${condition.indicator}${condition.operator}${condition.threshold}`)
        .join(',');
      const reason =
        group.conditions.length === 1
          ? `满足条件${index + 1}：${conditionDescs}`
          : `满足条件${index + 1}：(${conditionDescs}) 中${result.count}/${group.conditions.length}项满足`;

      return {
        triggered: true,
        satisfiedGroupIndex: index,
        satisfiedCount: result.count,
        reason,
      };
    }
  }

  return {
    triggered: false,
    satisfiedGroupIndex: -1,
    satisfiedCount: 0,
    reason: '未满足任何条件组',
  };
}

/**
 * 格式化 KDJ 指标为显示字符串（内部辅助，用于日志与诊断）。
 * 默认行为：kdj 为 null 或 K/D/J 均无有效值时返回空字符串。
 *
 * @param kdj 指标快照中的 kdj 字段，可为 null
 * @returns 格式化字符串，如 "KDJ(K=0.123,D=0.456,J=0.789)"；无有效值时返回空字符串
 */
function formatKdjSegment(kdj: IndicatorSnapshot['kdj']): string {
  if (kdj === null) return '';
  const kdjParts: string[] = [];
  if (isValidNumber(kdj.k)) kdjParts.push(`K=${kdj.k.toFixed(3)}`);
  if (isValidNumber(kdj.d)) kdjParts.push(`D=${kdj.d.toFixed(3)}`);
  if (isValidNumber(kdj.j)) kdjParts.push(`J=${kdj.j.toFixed(3)}`);
  return kdjParts.length > 0 ? `KDJ(${kdjParts.join(',')})` : '';
}

/**
 * 构建指标状态显示字符串（用于日志记录）。
 * 默认行为：按 RSI、MFI、KDJ 顺序拼接有效值，无有效值时返回空字符串。
 *
 * @param state 当前指标快照
 * @returns 格式化的指标值字符串（如 "RSI14(0.123)、MFI(0.456)、KDJ(...)"）
 */
export function buildIndicatorDisplayString(state: IndicatorSnapshot): string {
  const { rsi, mfi, kdj } = state;
  const parts: string[] = [];

  if (rsi && typeof rsi === 'object') {
    const periods = Object.keys(rsi)
      .map((p) => Number.parseInt(p, 10))
      .filter((p) => Number.isFinite(p))
      .sort((a, b) => a - b);
    for (const period of periods) {
      const rsiValue = rsi[period];
      if (isValidNumber(rsiValue)) {
        parts.push(`RSI${period}(${rsiValue.toFixed(3)})`);
      }
    }
  }
  if (isValidNumber(mfi)) {
    parts.push(`MFI(${mfi.toFixed(3)})`);
  }
  const kdjStr = formatKdjSegment(kdj);
  if (kdjStr) parts.push(kdjStr);

  return parts.join('、');
}

/**
 * 将信号按类型分流到对应数组：isImmediate 为 true 时推入立即数组，否则推入延迟数组。
 * result 为 null 时不修改任何数组。
 *
 * @param result 带分类标记的信号，为 null 时不做任何操作
 * @param immediateSignals 立即执行信号数组（会被原地修改）
 * @param delayedSignals 延迟验证信号数组（会被原地修改）
 * @returns 无返回值
 */
export function pushSignalToCorrectArray(
  result: SignalWithCategory | null,
  immediateSignals: Signal[],
  delayedSignals: Signal[],
): void {
  if (result === null) return;
  if (result.isImmediate) {
    immediateSignals.push(result.signal);
  } else {
    delayedSignals.push(result.signal);
  }
}

/**
 * 根据指标状态评估条件。
 * @param state 指标状态 {rsi/psy/mfi/kdj}
 * @param condition 条件 {indicator, operator, threshold}
 * @returns 条件是否满足
 */
function evaluateCondition(state: IndicatorState, condition: Condition): boolean {
  const { indicator, operator, threshold } = condition;
  let indicatorName = indicator;
  let period: number | undefined;

  if (indicator.includes(':')) {
    const parts = indicator.split(':');
    const namePart = parts[0];
    const periodPart = parts[1];
    if (namePart && periodPart) {
      indicatorName = namePart;
      period = Number.parseInt(periodPart, 10);
    }
  }

  let value: number | undefined;
  switch (indicatorName) {
    case 'RSI': {
      if (!period || state.rsi?.[period] === undefined) {
        return false;
      }
      value = state.rsi[period];
      break;
    }
    case 'PSY': {
      if (!period || state.psy?.[period] === undefined) {
        return false;
      }
      value = state.psy[period];
      break;
    }
    case 'MFI': {
      value = state.mfi ?? undefined;
      break;
    }
    case 'K': {
      value = state.kdj?.k;
      break;
    }
    case 'D': {
      value = state.kdj?.d;
      break;
    }
    case 'J': {
      value = state.kdj?.j;
      break;
    }
    default: {
      return false;
    }
  }

  if (value === undefined || !Number.isFinite(value)) {
    return false;
  }

  switch (operator) {
    case '<': {
      return decimalLt(value, threshold);
    }
    case '>': {
      return decimalGt(value, threshold);
    }
    default: {
      return false;
    }
  }
}

/**
 * 根据指标状态评估条件组。
 * @param state 指标状态
 * @param conditionGroup 条件组 {conditions, requiredCount}
 * @returns 评估结果
 */
function evaluateConditionGroup(
  state: IndicatorState,
  conditionGroup: ConditionGroup,
): ConditionGroupResult {
  const { conditions, requiredCount } = conditionGroup;

  let count = 0;
  for (const condition of conditions) {
    if (evaluateCondition(state, condition)) {
      count++;
    }
  }

  const minSatisfied = requiredCount ?? conditions.length;
  return {
    satisfied: count >= minSatisfied,
    count,
  };
}
