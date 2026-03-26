import { isValidNumber, parseIndicatorPeriod } from '../../utils/indicatorHelpers/index.js';
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
 * 判断某个条件引用的指标键在当前快照中是否具备"可评估的有效数值"。
 * 默认行为：不解析阈值与运算符，仅判断该条件是否可能为 true（有值才可能）。
 *
 * @param params 入参（快照 + 条件指标键）
 * @returns 该条件指标具备有效值时返回 true，否则 false
 */
function readSignalIndicatorValue(state: IndicatorState, indicatorKey: string): number | null {
  if (indicatorKey === 'MFI') {
    return isValidNumber(state.mfi) ? state.mfi : null;
  }

  if (indicatorKey === 'K') {
    return state.kdj && isValidNumber(state.kdj.k) ? state.kdj.k : null;
  }

  if (indicatorKey === 'D') {
    return state.kdj && isValidNumber(state.kdj.d) ? state.kdj.d : null;
  }

  if (indicatorKey === 'J') {
    return state.kdj && isValidNumber(state.kdj.j) ? state.kdj.j : null;
  }

  const rsiPeriod = parseIndicatorPeriod({ indicatorName: indicatorKey, prefix: 'RSI:' });
  if (rsiPeriod !== null) {
    const rsiValue = state.rsi?.[rsiPeriod];
    return isValidNumber(rsiValue) ? rsiValue : null;
  }

  const psyPeriod = parseIndicatorPeriod({ indicatorName: indicatorKey, prefix: 'PSY:' });
  if (psyPeriod !== null) {
    const psyValue = state.psy?.[psyPeriod];
    return isValidNumber(psyValue) ? psyValue : null;
  }

  return null;
}

function isConditionIndicatorValueAvailable(params: {
  readonly state: IndicatorSnapshot;
  readonly indicatorKey: string;
}): boolean {
  const { state, indicatorKey } = params;
  return readSignalIndicatorValue(state, indicatorKey) !== null;
}

/**
 * 校验 action 所需的指标值是否齐全且有效。
 *
 * 重要语义：
 * - 本函数不改变 N-of-M（/N）配置的求值口径。
 * - 当某些条件引用的指标缺失时，仅代表该条件必不满足，不应直接阻断整条 action 信号生成。
 *
 * 默认行为：只做"可评估性"门禁——若当前快照不足以评估任何一个条件组（即所有组都不可能满足 requiredCount），返回 false；否则返回 true 并交由 evaluateSignalConfig 做唯一求值。
 *
 * @param params 校验参数（快照 + action 的信号配置）
 * @returns 至少存在一个"可能满足"的条件组时返回 true，否则 false
 */
export function validateIndicatorsForAction(params: {
  readonly state: IndicatorSnapshot;
  readonly signalConfig: SignalConfig;
}): boolean {
  const { state, signalConfig } = params;
  const conditionGroups = signalConfig.conditionGroups;
  if (conditionGroups.length === 0) {
    return false;
  }

  for (const group of conditionGroups) {
    const minSatisfied = group.requiredCount ?? group.conditions.length;
    if (minSatisfied <= 0) {
      return true;
    }

    let availableCount = 0;
    for (const condition of group.conditions) {
      if (
        isConditionIndicatorValueAvailable({
          state,
          indicatorKey: condition.indicator,
        })
      ) {
        availableCount++;
      }
    }

    if (availableCount >= minSatisfied) {
      return true;
    }
  }

  return false;
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
 * 按周期升序格式化周期指标记录。
 * @param label 指标标签前缀（如 RSI、PSY）
 * @param record 周期指标记录
 * @returns 已格式化的指标片段列表
 */
function formatPeriodIndicatorSegments(
  label: 'RSI' | 'PSY',
  record: Readonly<Record<number, number>> | null,
): ReadonlyArray<string> {
  if (!record || typeof record !== 'object') {
    return [];
  }

  const periods = Object.keys(record)
    .map((key) => Number.parseInt(key, 10))
    .filter((period) => Number.isFinite(period))
    .sort((a, b) => a - b);

  const segments: string[] = [];
  for (const period of periods) {
    const value = record[period];
    if (isValidNumber(value)) {
      segments.push(`${label}${period}(${value.toFixed(3)})`);
    }
  }

  return segments;
}

/**
 * 构建指标状态显示字符串（用于日志记录）。
 * 默认行为：按 RSI、MFI、KDJ 顺序拼接有效值，无有效值时返回空字符串。
 *
 * @param state 当前指标快照
 * @returns 格式化的指标值字符串（如 "RSI14(0.123)、MFI(0.456)、KDJ(...)"）
 */
export function buildIndicatorDisplayString(state: IndicatorSnapshot): string {
  const { rsi, psy, mfi, kdj, adx } = state;
  const parts = [...formatPeriodIndicatorSegments('RSI', rsi)];

  if (isValidNumber(mfi)) {
    parts.push(`MFI(${mfi.toFixed(3)})`);
  }

  parts.push(...formatPeriodIndicatorSegments('PSY', psy));

  const kdjStr = formatKdjSegment(kdj);
  if (kdjStr) {
    parts.push(kdjStr);
  }

  if (isValidNumber(adx)) {
    parts.push(`ADX(${adx.toFixed(3)})`);
  }

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
  const value = readSignalIndicatorValue(state, indicator);
  if (value === null) {
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
