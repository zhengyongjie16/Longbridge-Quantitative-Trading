/**
 * 信号配置解析模块
 *
 * 功能：
 * - 解析信号配置字符串
 * - 评估条件是否满足
 * - 提取配置中的 RSI 周期
 *
 * 配置格式：(RSI:6<20,MFI<15,D<20,J<-1)/3|(J<-20)
 * - 括号内是条件列表，逗号分隔
 * - /N：括号内条件需满足 N 项，不设则全部满足
 * - |：分隔不同条件组（最多3个），满足任一组即可
 * - 支持指标：RSI:n (n为1-100), MFI, D (KDJ.D), J (KDJ.J)
 * - 支持运算符：< 和 >
 *
 * 核心函数：
 * - parseSignalConfig()：解析配置字符串
 * - validateSignalConfig()：验证配置格式
 * - evaluateCondition()：评估单个条件
 * - evaluateSignalConfig()：评估完整配置
 * - extractRSIPeriods()：提取 RSI 周期列表
 */

// 支持的固定指标列表（不包括 RSI，因为 RSI 支持动态周期）
const SUPPORTED_INDICATORS = ["MFI", "D", "J"];

/**
 * 解析单个条件
 * @param {string} conditionStr 条件字符串，如 "RSI:6<20" 或 "J<-1"
 * @returns {{indicator: string, period?: number, operator: string, threshold: number}|null} 解析结果
 */
function parseCondition(conditionStr) {
  // 去除空白
  const trimmed = conditionStr.trim();
  if (!trimmed) return null;

  // 匹配指标、运算符和阈值（支持负数）
  // 格式1：RSI:n<threshold (RSI 带周期)
  // 格式2：INDICATOR<threshold (其他固定指标)
  const rsiMatch = trimmed.match(/^RSI:(\d+)\s*([<>])\s*(-?\d+(?:\.\d+)?)$/);

  if (rsiMatch) {
    // RSI:n 格式
    const [, periodStr, operator, thresholdStr] = rsiMatch;
    const period = parseInt(periodStr, 10);
    const threshold = parseFloat(thresholdStr);

    // 验证周期范围（1-100）
    if (!Number.isFinite(period) || period < 1 || period > 100) {
      return null;
    }

    // 验证阈值是否为有效数字
    if (!Number.isFinite(threshold)) {
      return null;
    }

    return {
      indicator: "RSI",
      period,
      operator,
      threshold,
    };
  }

  // 尝试匹配其他固定指标格式
  const match = trimmed.match(/^([A-Z]+)\s*([<>])\s*(-?\d+(?:\.\d+)?)$/);

  if (!match) {
    return null;
  }

  const [, indicator, operator, thresholdStr] = match;
  const threshold = parseFloat(thresholdStr);

  // 验证指标是否支持
  if (!SUPPORTED_INDICATORS.includes(indicator)) {
    return null;
  }

  // 验证阈值是否为有效数字
  if (!Number.isFinite(threshold)) {
    return null;
  }

  return {
    indicator,
    operator,
    threshold,
  };
}

/**
 * 解析条件组
 * @param {string} groupStr 条件组字符串，如 "(RSI6<20,MFI<15,D<20,J<-1)/3" 或 "(J<-20)"
 * @returns {{conditions: Array, minSatisfied: number}|null} 解析结果
 */
function parseConditionGroup(groupStr) {
  // 去除空白
  const trimmed = groupStr.trim();
  if (!trimmed) return null;

  // 匹配格式：(条件列表)/N 或 (条件列表)
  // 条件列表可以不带括号（单个条件时）
  let conditionsStr;
  let minSatisfied = null;

  // 尝试匹配带括号的格式
  const bracketMatch = trimmed.match(/^\(([^)]+)\)(?:\/(\d+))?$/);

  if (bracketMatch) {
    conditionsStr = bracketMatch[1];
    minSatisfied = bracketMatch[2] ? parseInt(bracketMatch[2], 10) : null;
  } else {
    // 不带括号的单个条件（兼容简单格式）
    conditionsStr = trimmed;
  }

  // 解析条件列表
  const conditionStrs = conditionsStr.split(",");
  const conditions = [];

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
  if (minSatisfied === null) {
    minSatisfied = conditions.length;
  }

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
 * @param {string} configStr 配置字符串，如 "(RSI6<20,MFI<15,D<20,J<-1)/3|(J<-20)"
 * @returns {{conditionGroups: Array}|null} 解析结果
 */
export function parseSignalConfig(configStr) {
  if (!configStr || typeof configStr !== "string") {
    return null;
  }

  // 去除空白
  const trimmed = configStr.trim();
  if (!trimmed) {
    return null;
  }

  // 按 | 分隔条件组
  const groupStrs = trimmed.split("|");

  // 最多支持3个条件组
  if (groupStrs.length > 3) {
    console.warn(`[信号配置警告] 条件组数量超过3个，将只使用前3个`);
  }

  const conditionGroups = [];

  for (let i = 0; i < Math.min(groupStrs.length, 3); i++) {
    const group = parseConditionGroup(groupStrs[i]);
    if (!group) {
      // 如果有任何一个条件组解析失败，返回 null
      return null;
    }
    conditionGroups.push(group);
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
 * 验证信号配置格式
 * @param {string} configStr 配置字符串
 * @returns {{valid: boolean, error: string|null, config: Object|null}} 验证结果
 */
export function validateSignalConfig(configStr) {
  if (!configStr || typeof configStr !== "string") {
    return {
      valid: false,
      error: "配置不能为空",
      config: null,
    };
  }

  const trimmed = configStr.trim();
  if (!trimmed) {
    return {
      valid: false,
      error: "配置不能为空",
      config: null,
    };
  }

  // 基本格式检查
  const groupStrs = trimmed.split("|");

  if (groupStrs.length > 3) {
    return {
      valid: false,
      error: `条件组数量超过3个（当前: ${groupStrs.length}）`,
      config: null,
    };
  }

  // 验证每个条件组
  for (let i = 0; i < groupStrs.length; i++) {
    const groupStr = groupStrs[i].trim();

    // 检查括号匹配
    const openCount = (groupStr.match(/\(/g) || []).length;
    const closeCount = (groupStr.match(/\)/g) || []).length;

    if (openCount !== closeCount) {
      return {
        valid: false,
        error: `条件组 ${i + 1} 括号不匹配`,
        config: null,
      };
    }

    // 检查是否有有效的条件
    const bracketMatch = groupStr.match(/^\(([^)]+)\)(?:\/(\d+))?$/);
    let conditionsStr;
    let minSatisfied = null;

    if (bracketMatch) {
      conditionsStr = bracketMatch[1];
      if (bracketMatch[2]) {
        minSatisfied = parseInt(bracketMatch[2], 10);
      }
    } else {
      // 尝试解析不带括号的单个条件
      conditionsStr = groupStr;
    }

    const conditionStrs = conditionsStr.split(",");

    for (let j = 0; j < conditionStrs.length; j++) {
      const condStr = conditionStrs[j].trim();

      if (!condStr) {
        return {
          valid: false,
          error: `条件组 ${i + 1} 的第 ${j + 1} 个条件为空`,
          config: null,
        };
      }

      const condition = parseCondition(condStr);
      if (!condition) {
        return {
          valid: false,
          error: `条件组 ${i + 1} 的第 ${
            j + 1
          } 个条件 "${condStr}" 格式无效。支持的指标: RSI:n (n为1-100), ${SUPPORTED_INDICATORS.join(
            ", "
          )}`,
          config: null,
        };
      }
    }

    // 验证 minSatisfied
    if (minSatisfied !== null) {
      if (minSatisfied < 1) {
        return {
          valid: false,
          error: `条件组 ${i + 1} 的最小满足数量必须 >= 1`,
          config: null,
        };
      }
      if (minSatisfied > conditionStrs.length) {
        return {
          valid: false,
          error: `条件组 ${i + 1} 的最小满足数量 ${minSatisfied} 超过条件数量 ${
            conditionStrs.length
          }`,
          config: null,
        };
      }
    }
  }

  // 解析配置
  const config = parseSignalConfig(trimmed);
  if (!config) {
    return {
      valid: false,
      error: "配置解析失败",
      config: null,
    };
  }

  return {
    valid: true,
    error: null,
    config,
  };
}

/**
 * 根据指标状态评估条件
 * @param {Object} state 指标状态 {rsi: {6: value, 12: value, ...}, mfi, kdj: {d, j}}
 * @param {Object} condition 条件 {indicator, period?, operator, threshold}
 * @returns {boolean} 条件是否满足
 */
export function evaluateCondition(state, condition) {
  const { indicator, period, operator, threshold } = condition;

  // 获取指标值
  let value;
  switch (indicator) {
    case "RSI":
      // RSI:n 格式，从 state.rsi[period] 获取值
      if (!period || !state.rsi || !state.rsi[period]) {
        return false;
      }
      value = state.rsi[period];
      break;
    case "MFI":
      value = state.mfi;
      break;
    case "D":
      value = state.kdj?.d;
      break;
    case "J":
      value = state.kdj?.j;
      break;
    default:
      return false;
  }

  // 验证值是否有效
  if (!Number.isFinite(value)) {
    return false;
  }

  // 根据运算符比较
  if (operator === "<") {
    return value < threshold;
  } else if (operator === ">") {
    return value > threshold;
  }

  return false;
}

/**
 * 根据指标状态评估条件组
 * @param {Object} state 指标状态
 * @param {Object} conditionGroup 条件组 {conditions, minSatisfied}
 * @returns {{satisfied: boolean, count: number}} 评估结果
 */
export function evaluateConditionGroup(state, conditionGroup) {
  const { conditions, minSatisfied } = conditionGroup;

  let count = 0;
  for (const condition of conditions) {
    if (evaluateCondition(state, condition)) {
      count++;
    }
  }

  return {
    satisfied: count >= minSatisfied,
    count,
  };
}

/**
 * 根据指标状态评估完整的信号配置
 * @param {Object} state 指标状态
 * @param {Object} signalConfig 信号配置 {conditionGroups}
 * @returns {{triggered: boolean, satisfiedGroupIndex: number, satisfiedCount: number, reason: string}} 评估结果
 */
export function evaluateSignalConfig(state, signalConfig) {
  if (!signalConfig || !signalConfig.conditionGroups) {
    return {
      triggered: false,
      satisfiedGroupIndex: -1,
      satisfiedCount: 0,
      reason: "无效的信号配置",
    };
  }

  const { conditionGroups } = signalConfig;

  for (let i = 0; i < conditionGroups.length; i++) {
    const group = conditionGroups[i];
    const result = evaluateConditionGroup(state, group);

    if (result.satisfied) {
      // 生成原因说明
      const conditionDescs = group.conditions
        .map((c) => `${c.indicator}${c.operator}${c.threshold}`)
        .join(",");

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
    reason: "未满足任何条件组",
  };
}

/**
 * 格式化信号配置为可读字符串
 * @param {Object} signalConfig 信号配置
 * @returns {string} 格式化字符串
 */
export function formatSignalConfig(signalConfig) {
  if (!signalConfig || !signalConfig.conditionGroups) {
    return "(无效配置)";
  }

  const groups = signalConfig.conditionGroups.map((group) => {
    const conditions = group.conditions
      .map((c) => {
        // 如果是 RSI 指标，格式化为 RSI:n
        if (c.indicator === "RSI" && c.period) {
          return `RSI:${c.period}${c.operator}${c.threshold}`;
        }
        return `${c.indicator}${c.operator}${c.threshold}`;
      })
      .join(",");

    if (group.conditions.length === 1) {
      return `(${conditions})`;
    }

    if (group.minSatisfied === group.conditions.length) {
      return `(${conditions})`;
    }

    return `(${conditions})/${group.minSatisfied}`;
  });

  return groups.join("|");
}

/**
 * 从信号配置中提取所有 RSI 周期
 * @param {Object} signalConfig 信号配置对象 {buycall, sellcall, buyput, sellput}
 * @returns {Array<number>} RSI 周期数组（去重后排序）
 */
export function extractRSIPeriods(signalConfig) {
  if (!signalConfig) {
    return [];
  }

  const periods = new Set();

  // 遍历所有信号类型的配置
  const configs = [
    signalConfig.buycall,
    signalConfig.sellcall,
    signalConfig.buyput,
    signalConfig.sellput,
  ];

  for (const config of configs) {
    if (!config || !config.conditionGroups) {
      continue;
    }

    // 遍历所有条件组
    for (const group of config.conditionGroups) {
      if (!group.conditions) {
        continue;
      }

      // 遍历所有条件
      for (const condition of group.conditions) {
        // 如果是 RSI 指标且有周期，添加到集合中
        if (condition.indicator === "RSI" && condition.period) {
          periods.add(condition.period);
        }
      }
    }
  }

  // 转为数组并排序
  return Array.from(periods).sort((a, b) => a - b);
}

// 导出支持的指标列表供验证使用
export { SUPPORTED_INDICATORS };
