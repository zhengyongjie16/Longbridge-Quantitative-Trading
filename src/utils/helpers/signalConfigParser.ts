/**
 * 信号配置解析模块
 *
 * 功能：
 * - 解析信号配置字符串
 * - 评估条件是否满足
 * - 提取配置中的 RSI/PSY 周期
 *
 * 配置格式：(RSI:6<20,MFI<15,D<20,J<-1)/3|(J<-20)
 * - 括号内是条件列表，逗号分隔
 * - /N：括号内条件需满足 N 项，不设则全部满足
 * - |：分隔不同条件组（最多3个），满足任一组即可
 * - 支持指标：RSI:n (n为1-100), PSY:n (n为1-100), MFI, K, D, J
 * - 支持运算符：< 和 >
 *
 * 核心函数：
 * - parseSignalConfig()：解析配置字符串
 * - evaluateCondition()：评估单个条件
 * - evaluateSignalConfig()：评估完整配置
 * - extractRSIPeriods()：提取 RSI 周期列表
 * - extractPsyPeriods()：提取 PSY 周期列表
 */
import { validateRsiPeriod, validatePsyPeriod } from './indicatorHelpers.js';
import type {
  Condition,
  ConditionGroup,
  SignalConfig,
} from '../../types/signalConfig.js';
import type { SignalConfigSet } from '../../types/config.js';
import type {
  IndicatorState,
  ParsedCondition,
  ParsedConditionGroup,
  EvaluationResult,
  ConditionGroupResult,
} from './types.js';

// 支持的固定指标列表（不包括 RSI/PSY，因为它们支持动态周期）
const SUPPORTED_INDICATORS = ['MFI', 'K', 'D', 'J'] as const;

/**
 * 解析单个条件
 * @param conditionStr 条件字符串，如 "RSI:6<20" 或 "J<-1"
 * @returns 解析结果
 */
function parseCondition(conditionStr: string): ParsedCondition | null {
  // 去除空白
  const trimmed = conditionStr.trim();
  if (!trimmed) return null;

  // 匹配指标、运算符和阈值（支持负数）
  // 格式1：RSI:n<threshold (RSI 带周期)
  // 格式2：PSY:n<threshold (PSY 带周期)
  // 格式3：INDICATOR<threshold (其他固定指标)
  const rsiRegex = /^RSI:(\d+)\s*([<>])\s*(-?\d+(?:\.\d+)?)$/;
  const rsiMatch = rsiRegex.exec(trimmed);

  if (rsiMatch) {
    // RSI:n 格式
    const [, periodStr, operator, thresholdStr] = rsiMatch;

    // 验证正则捕获组存在
    if (!periodStr || !operator || !thresholdStr) {
      return null;
    }

    const period = Number.parseInt(periodStr, 10);
    const threshold = Number.parseFloat(thresholdStr);

    // 验证周期范围（1-100）
    if (!validateRsiPeriod(period)) {
      return null;
    }

    // 验证阈值是否为有效数字
    if (!Number.isFinite(threshold)) {
      return null;
    }

    return {
      indicator: 'RSI',
      period,
      operator: operator as '<' | '>',
      threshold,
    };
  }

  // 尝试匹配 PSY:n 格式
  const psyRegex = /^PSY:(\d+)\s*([<>])\s*(-?\d+(?:\.\d+)?)$/;
  const psyMatch = psyRegex.exec(trimmed);

  if (psyMatch) {
    // PSY:n 格式
    const [, periodStr, operator, thresholdStr] = psyMatch;

    // 验证正则捕获组存在
    if (!periodStr || !operator || !thresholdStr) {
      return null;
    }

    const period = Number.parseInt(periodStr, 10);
    const threshold = Number.parseFloat(thresholdStr);

    // 验证周期范围（1-100）和阈值有效性
    if (!validatePsyPeriod(period) || !Number.isFinite(threshold)) {
      return null;
    }

    return {
      indicator: 'PSY',
      period,
      operator: operator as '<' | '>',
      threshold,
    };
  }

  // 尝试匹配其他固定指标格式
  const matchRegex = /^([A-Z]+)\s*([<>])\s*(-?\d+(?:\.\d+)?)$/;
  const match = matchRegex.exec(trimmed);

  if (!match) {
    return null;
  }

  const [, indicator, operator, thresholdStr] = match;

  // 验证正则捕获组存在
  if (!indicator || !operator || !thresholdStr) {
    return null;
  }

  const threshold = Number.parseFloat(thresholdStr);

  // 验证指标是否支持
  if (!SUPPORTED_INDICATORS.includes(indicator as (typeof SUPPORTED_INDICATORS)[number])) {
    return null;
  }

  // 验证阈值是否为有效数字
  if (!Number.isFinite(threshold)) {
    return null;
  }

  return {
    indicator,
    operator: operator as '<' | '>',
    threshold,
  };
}

/**
 * 解析条件组
 * @param groupStr 条件组字符串，如 "(RSI:6<20,MFI<15,D<20,J<-1)/3" 或 "(J<-20)"
 * @returns 解析结果
 */
function parseConditionGroup(groupStr: string): ParsedConditionGroup | null {
  // 去除空白
  const trimmed = groupStr.trim();
  if (!trimmed) return null;

  // 匹配格式：(条件列表)/N 或 (条件列表)
  // 条件列表可以不带括号（单个条件时）
  let conditionsStr: string;
  let minSatisfied: number | null = null;

  // 尝试匹配带括号的格式
  const bracketRegex = /^\(([^)]+)\)(?:\/(\d+))?$/;
  const bracketMatch = bracketRegex.exec(trimmed);

  if (bracketMatch) {
    const capturedConditions = bracketMatch[1];
    if (!capturedConditions) {
      return null;
    }
    conditionsStr = capturedConditions;
    const minSatisfiedStr = bracketMatch[2];
    minSatisfied = minSatisfiedStr ? Number.parseInt(minSatisfiedStr, 10) : null;
  } else {
    // 不带括号的单个条件（兼容简单格式）
    conditionsStr = trimmed;
  }

  // 解析条件列表
  const conditionStrs = conditionsStr.split(',');
  const conditions: ParsedCondition[] = [];

  for (const condStr of conditionStrs) {
    const condition = parseCondition(condStr);
    if (!condition) {
      // 如果有任何一个条件解析失败，整个条件组无效
      return null;
    }
    conditions.push(condition);
  }

  // 如果没有有效条件，返回 null
  if (conditions.length === 0) {
    return null;
  }

  // 如果未指定 minSatisfied，默认为全部满足
  minSatisfied ??= conditions.length;

  // 验证 minSatisfied 的范围
  if (minSatisfied < 1 || minSatisfied > conditions.length) {
    // 如果超出范围，调整为有效值
    minSatisfied = Math.max(1, Math.min(minSatisfied, conditions.length));
  }

  return {
    conditions,
    minSatisfied,
  };
}

/**
 * 解析完整的信号配置
 * @param configStr 配置字符串，如 "(RSI:6<20,MFI<15,D<20,J<-1)/3|(J<-20)"
 * @returns 解析结果
 */
export function parseSignalConfig(configStr: string | null | undefined): SignalConfig | null {
  if (!configStr || typeof configStr !== 'string') {
    return null;
  }

  // 去除空白
  const trimmed = configStr.trim();
  if (!trimmed) {
    return null;
  }

  // 按 | 分隔条件组
  const groupStrs = trimmed.split('|');

  // 最多支持3个条件组（不输出警告）
  const conditionGroups: ConditionGroup[] = [];

  for (let i = 0; i < Math.min(groupStrs.length, 3); i++) {
    const groupStr = groupStrs[i];
    if (!groupStr) {
      continue;
    }
    const group = parseConditionGroup(groupStr);
    if (!group) {
      // 如果有任何一个条件组解析失败，返回 null
      return null;
    }
    // 转换为 ConditionGroup 格式
    conditionGroups.push({
      conditions: group.conditions.map((c) => ({
        indicator: c.period ? `${c.indicator}:${c.period}` : c.indicator,
        operator: c.operator,
        threshold: c.threshold,
      })),
      requiredCount: group.minSatisfied,
    });
  }

  // 如果没有有效的条件组，返回 null
  if (conditionGroups.length === 0) {
    return null;
  }

  return {
    conditionGroups,
  };
}

/**
 * 根据指标状态评估条件
 * @param state 指标状态 {rsi: {6: value, 12: value, ...}, psy: {6: value, 12: value, ...}, mfi, kdj: {k, d, j}}
 * @param condition 条件 {indicator, operator, threshold}
 * @returns 条件是否满足
 */
function evaluateCondition(state: IndicatorState, condition: Condition): boolean {
  const { indicator, operator, threshold } = condition;

  // 解析指标名称（可能包含周期，如 RSI:6, PSY:12）
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
    case 'RSI':
      // RSI:n 格式，从 state.rsi[period] 获取值
      if (!period || state.rsi?.[period] === undefined) {
        return false;
      }
      value = state.rsi[period];
      break;
    case 'PSY':
      // PSY:n 格式，从 state.psy[period] 获取值
      if (!period || state.psy?.[period] === undefined) {
        return false;
      }
      value = state.psy[period];
      break;
    case 'MFI':
      value = state.mfi ?? undefined;
      break;
    case 'K':
      value = state.kdj?.k;
      break;
    case 'D':
      value = state.kdj?.d;
      break;
    case 'J':
      value = state.kdj?.j;
      break;
    default:
      return false;
  }

  // 验证值是否有效
  if (value === undefined || !Number.isFinite(value)) {
    return false;
  }

  // 根据运算符比较
  if (operator === '<') {
    return value < threshold;
  } else if (operator === '>') {
    return value > threshold;
  }

  return false;
}

/**
 * 根据指标状态评估条件组
 * @param state 指标状态
 * @param conditionGroup 条件组 {conditions, requiredCount}
 * @returns 评估结果
 */
function evaluateConditionGroup(state: IndicatorState, conditionGroup: ConditionGroup): ConditionGroupResult {
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

/**
 * 根据指标状态评估完整的信号配置
 * @param state 指标状态
 * @param signalConfig 信号配置 {conditionGroups}
 * @returns 评估结果
 */
export function evaluateSignalConfig(state: IndicatorState, signalConfig: SignalConfig | null): EvaluationResult {
  if (!signalConfig?.conditionGroups) {
    return {
      triggered: false,
      satisfiedGroupIndex: -1,
      satisfiedCount: 0,
      reason: '无效的信号配置',
    };
  }

  const { conditionGroups } = signalConfig;

  for (let i = 0; i < conditionGroups.length; i++) {
    const group = conditionGroups[i];
    if (!group) {
      continue;
    }
    const result = evaluateConditionGroup(state, group);

    if (result.satisfied) {
      // 生成原因说明
      const conditionDescs = group.conditions
        .map((c) => `${c.indicator}${c.operator}${c.threshold}`)
        .join(',');

      const reason =
        group.conditions.length === 1
          ? `满足条件${i + 1}：${conditionDescs}`
          : `满足条件${i + 1}：(${conditionDescs}) 中${result.count}/${
            group.conditions.length
          }项满足`;

      return {
        triggered: true,
        satisfiedGroupIndex: i,
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
 * 格式化信号配置为可读字符串
 * @param signalConfig 信号配置
 * @returns 格式化字符串
 */
export function formatSignalConfig(signalConfig: SignalConfig | null): string {
  if (!signalConfig?.conditionGroups) {
    return '(无效配置)';
  }

  const groups = signalConfig.conditionGroups.map((group) => {
    const conditions = group.conditions
      .map((c) => `${c.indicator}${c.operator}${c.threshold}`)
      .join(',');

    if (group.conditions.length === 1) {
      return `(${conditions})`;
    }

    const minSatisfied = group.requiredCount ?? group.conditions.length;
    if (minSatisfied === group.conditions.length) {
      return `(${conditions})`;
    }

    return `(${conditions})/${minSatisfied}`;
  });

  return groups.join('|');
}

function extractIndicatorPeriods(
  signalConfig: SignalConfigSet | null,
  prefix: 'RSI:' | 'PSY:',
  isValidPeriod: (period: number) => boolean,
): number[] {
  if (!signalConfig) return [];
  const periods = new Set<number>();
  const configs = [signalConfig.buycall, signalConfig.sellcall, signalConfig.buyput, signalConfig.sellput];

  for (const config of configs) {
    if (!config?.conditionGroups) continue;
    for (const group of config.conditionGroups) {
      if (!group.conditions) continue;
      for (const condition of group.conditions) {
        if (!condition.indicator.startsWith(prefix)) continue;
        const periodStr = condition.indicator.split(':')[1];
        if (!periodStr) continue;
        const period = Number.parseInt(periodStr, 10);
        if (isValidPeriod(period)) periods.add(period);
      }
    }
  }
  return Array.from(periods).sort((a, b) => a - b);
}

/** 从信号配置中提取所有 RSI 周期（去重后排序） */
export function extractRSIPeriods(signalConfig: SignalConfigSet | null): number[] {
  return extractIndicatorPeriods(signalConfig, 'RSI:', (p) => Number.isFinite(p));
}

/** 从信号配置中提取所有 PSY 周期（去重后排序） */
export function extractPsyPeriods(signalConfig: SignalConfigSet | null): number[] {
  return extractIndicatorPeriods(signalConfig, 'PSY:', validatePsyPeriod);
}
