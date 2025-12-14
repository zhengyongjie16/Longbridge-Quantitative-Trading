// 统一管理与交易相关的配置，避免在代码中硬编码
// 如需调整标的或金额，只需改这里或对应的环境变量
// 注意：所有配置项都必须从环境变量读取，没有默认值

/**
 * 从环境变量读取字符串配置
 * @param {string} envKey 环境变量键名
 * @returns {string|null} 配置值，如果未设置则返回 null
 */
function getStringConfig(envKey) {
  const value = process.env[envKey];
  if (
    !value ||
    value.trim() === "" ||
    value === `your_${envKey.toLowerCase()}_here`
  ) {
    return null;
  }
  return value.trim();
}

/**
 * 从环境变量读取数字配置
 * @param {string} envKey 环境变量键名
 * @param {number} minValue 最小值（可选）
 * @returns {number|null} 配置值，如果未设置或无效则返回 null
 */
function getNumberConfig(envKey, minValue = 0) {
  const value = process.env[envKey];
  if (!value || value.trim() === "") {
    return null;
  }
  const num = Number(value);
  if (!Number.isFinite(num) || num < minValue) {
    return null;
  }
  return num;
}

/**
 * 从环境变量读取布尔配置
 * @param {string} envKey 环境变量键名
 * @returns {boolean} 配置值，默认为 false
 */
function getBooleanConfig(envKey) {
  return process.env[envKey] === "true";
}

export const TRADING_CONFIG = {
  // 监控标的（用于计算指标和生成交易信号，例如 "HSI.HK"）
  monitorSymbol: getStringConfig("MONITOR_SYMBOL"),

  // 做多标的（不带 .HK 后缀，内部会自动规范为港股）
  // 当监控标的产生 BUY 信号时，买入此标的（做多操作）
  longSymbol: getStringConfig("LONG_SYMBOL"),

  // 做空标的（不带 .HK 后缀，内部会自动规范为港股）
  // 当监控标的产生 SELL 信号时，买入此标的（做空操作）
  shortSymbol: getStringConfig("SHORT_SYMBOL"),

  // 目标买入金额（HKD），会按 <= 此金额且尽量接近的方式计算股数
  targetNotional: getNumberConfig("TARGET_NOTIONAL", 1),

  // 做多标的的最小买卖单位（每手股数，作为后备值，优先使用从API获取的值）
  longLotSize: getNumberConfig("LONG_LOT_SIZE", 1),

  // 做空标的的最小买卖单位（每手股数，作为后备值，优先使用从API获取的值）
  shortLotSize: getNumberConfig("SHORT_LOT_SIZE", 1),

  // 单标的最大持仓市值（HKD），不允许超过此金额
  maxPositionNotional: getNumberConfig("MAX_POSITION_NOTIONAL", 1),

  // 单日最大亏损（HKD），超过后禁止继续开新仓
  maxDailyLoss: getNumberConfig("MAX_DAILY_LOSS", 0),

  // 末日保护程序：收盘前15分钟拒绝买入，收盘前5分钟清空所有持仓
  // 港股当日收盘时间：下午 16:00
  // 收盘前5分钟：15:55-16:00（仅判断当日收盘，不包括上午收盘）
  // 默认值在 .env 文件中设置为 true
  doomsdayProtection: getBooleanConfig("DOOMSDAY_PROTECTION"),
};
