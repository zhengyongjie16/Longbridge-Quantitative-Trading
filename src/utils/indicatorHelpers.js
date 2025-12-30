/**
 * 指标辅助函数模块
 *
 * 功能：
 * - 从指标状态对象中提取指定指标的值
 * - 供策略模块和信号验证模块使用
 *
 * 支持的指标：
 * - K、D、J（KDJ 指标）
 * - MACD、DIF、DEA（MACD 指标）
 * - EMA:n（任意周期的 EMA 指标）
 *
 * 核心函数：
 * - getIndicatorValue()：提取指标值
 * - isValidNumber()：检查数值有效性
 */

/**
 * 从指标状态中提取指定指标的值
 * @param {Object} state 指标状态对象 {kdj, macd, ema}
 * @param {string} indicatorName 指标名称 (K, D, J, MACD, DIF, DEA, EMA:n)
 * @returns {number|null} 指标值，如果无效则返回 null
 */
export function getIndicatorValue(state, indicatorName) {
  if (!state) return null;

  const { kdj, macd, ema } = state;

  // 处理 EMA:n 格式（例如 EMA:5, EMA:10）
  if (indicatorName.startsWith("EMA:")) {
    const periodStr = indicatorName.substring(4); // 提取周期部分
    const period = parseInt(periodStr, 10);

    // 验证周期是否有效
    if (!validateEmaPeriod(period)) {
      return null;
    }

    // 从 ema 对象中提取对应周期的值
    return ema && Number.isFinite(ema[period]) ? ema[period] : null;
  }

  switch (indicatorName) {
    case "K":
      return kdj && Number.isFinite(kdj.k) ? kdj.k : null;
    case "D":
      return kdj && Number.isFinite(kdj.d) ? kdj.d : null;
    case "J":
      return kdj && Number.isFinite(kdj.j) ? kdj.j : null;
    case "MACD":
      return macd && Number.isFinite(macd.macd) ? macd.macd : null;
    case "DIF":
      return macd && Number.isFinite(macd.dif) ? macd.dif : null;
    case "DEA":
      return macd && Number.isFinite(macd.dea) ? macd.dea : null;
    default:
      return null;
  }
}

/**
 * 检查值是否为有效的有限数字
 * @param {*} value 待检查的值
 * @returns {boolean} 如果值为有效的有限数字返回 true，否则返回 false
 */
export function isValidNumber(value) {
  return value != null && Number.isFinite(value);
}

/**
 * 检查值是否为有效的正数
 * @param {*} value 待检查的值
 * @returns {boolean} 如果值为有效的正数返回 true，否则返回 false
 */
export function isValidPositiveNumber(value) {
  return Number.isFinite(value) && value > 0;
}

/**
 * 验证数值是否在指定范围内
 * @param {*} value 待验证的值
 * @param {number} min 最小值（包含）
 * @param {number} max 最大值（包含）
 * @returns {boolean} 如果值在范围内返回 true，否则返回 false
 */
export function validateNumberInRange(value, min, max) {
  return Number.isFinite(value) && value >= min && value <= max;
}

/**
 * 验证 EMA 周期是否有效（1-250）
 * @param {*} period EMA 周期
 * @returns {boolean} 如果周期有效返回 true，否则返回 false
 */
export function validateEmaPeriod(period) {
  return Number.isFinite(period) && period >= 1 && period <= 250;
}

/**
 * 验证 RSI 周期是否有效（1-100）
 * @param {*} period RSI 周期
 * @returns {boolean} 如果周期有效返回 true，否则返回 false
 */
export function validateRsiPeriod(period) {
  return Number.isFinite(period) && period >= 1 && period <= 100;
}

/**
 * 验证百分比值是否有效（0-100）
 * @param {*} value 百分比值
 * @returns {boolean} 如果值在 0-100 范围内返回 true，否则返回 false
 */
export function validatePercentage(value) {
  return Number.isFinite(value) && value >= 0 && value <= 100;
}
