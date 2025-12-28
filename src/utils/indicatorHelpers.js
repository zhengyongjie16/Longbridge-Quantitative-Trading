/**
 * 指标辅助函数模块
 * 从指标状态中提取指定指标的值，供策略和信号验证模块使用
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
    if (!Number.isFinite(period) || period < 1 || period > 250) {
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
