// 统一管理与交易相关的配置，避免在代码中硬编码
// 如需调整标的或金额，只需改这里或对应的环境变量

/**
 * 安全地将字符串转换为数字，如果无效则返回默认值
 * @param {string|undefined} value 环境变量值
 * @param {number} defaultValue 默认值
 * @param {number} minValue 最小值（可选）
 * @returns {number} 有效的数字
 */
function safeNumber(value, defaultValue, minValue = 0) {
  const num = Number(value ?? defaultValue);
  if (!Number.isFinite(num) || num < minValue) {
    console.warn(`[配置警告] 无效的数值配置 "${value}"，使用默认值 ${defaultValue}`);
    return defaultValue;
  }
  return num;
}

export const TRADING_CONFIG = {
  // 监控标的（用于计算指标和生成交易信号，例如 "HSI.HK"）
  monitorSymbol: process.env.MONITOR_SYMBOL ?? "HSI.HK",

  // 做多标的（不带 .HK 后缀，内部会自动规范为港股）
  // 当监控标的产生 BUY 信号时，买入此标的（做多操作）
  longSymbol: process.env.LONG_SYMBOL ?? "68547",

  // 做空标的（不带 .HK 后缀，内部会自动规范为港股）
  // 当监控标的产生 SELL 信号时，买入此标的（做空操作）
  shortSymbol: process.env.SHORT_SYMBOL ?? "63372",

  // 目标买入金额（HKD），会按 <= 此金额且尽量接近的方式计算股数
  targetNotional: safeNumber(process.env.TARGET_NOTIONAL, 5000, 1),

  // 做多标的的最小买卖单位（每手股数，作为后备值，优先使用从API获取的值）
  longLotSize: safeNumber(process.env.LONG_LOT_SIZE, 100, 1),

  // 做空标的的最小买卖单位（每手股数，作为后备值，优先使用从API获取的值）
  shortLotSize: safeNumber(process.env.SHORT_LOT_SIZE, 100, 1),

  // 单标的最大持仓市值（HKD），不允许超过此金额
  maxPositionNotional: safeNumber(process.env.MAX_POSITION_NOTIONAL, 100000, 1),

  // 单日最大亏损（HKD），超过后禁止继续开新仓
  maxDailyLoss: safeNumber(process.env.MAX_DAILY_LOSS, 30000, 0),

  // 是否在收盘前15分钟清空所有持仓（默认 true）
  // 港股当日收盘时间：下午 16:00
  // 收盘前15分钟：15:45-16:00（仅判断当日收盘，不包括上午收盘）
  clearPositionsBeforeClose: process.env.CLEAR_POSITIONS_BEFORE_CLOSE === "true",
};


