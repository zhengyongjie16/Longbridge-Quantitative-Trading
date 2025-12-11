/**
 * 通用工具函数
 * 包含项目中重复使用的工具函数，避免代码重复
 */

/**
 * 规范化港股代码，自动添加 .HK 后缀（如果还没有）
 * @param {string} symbol 标的代码，例如 "68547" 或 "68547.HK"
 * @returns {string} 规范化后的代码，例如 "68547.HK"
 */
export function normalizeHKSymbol(symbol) {
  if (!symbol || typeof symbol !== "string") {
    return symbol;
  }
  // 如果已经包含 .HK、.US 等后缀，直接返回
  if (symbol.includes(".")) {
    return symbol;
  }
  // 否则添加 .HK 后缀
  return `${symbol}.HK`;
}

/**
 * 将 Decimal 类型转换为数字
 * @param {*} decimalLike Decimal 对象或数字
 * @returns {number} 转换后的数字
 */
export function decimalToNumber(decimalLike) {
  if (decimalLike && typeof decimalLike.toNumber === "function") {
    return decimalLike.toNumber();
  }
  return Number(decimalLike ?? 0);
}

/**
 * 格式化数字，保留指定小数位数
 * @param {number} num 要格式化的数字
 * @param {number} digits 保留的小数位数，默认为 2
 * @returns {string} 格式化后的字符串，如果数字无效则返回 "-"
 */
export function formatNumber(num, digits = 2) {
  return Number.isFinite(num) ? num.toFixed(digits) : String(num ?? "-");
}

/**
 * 格式化账户渠道显示名称
 * @param {string} accountChannel 账户渠道代码
 * @returns {string} 格式化的账户渠道名称
 */
export function formatAccountChannel(accountChannel) {
  if (!accountChannel || typeof accountChannel !== "string") {
    return "未知账户";
  }

  // 将账户渠道代码转换为友好的中文名称
  const channelMap = {
    lb_papertrading: "模拟交易",
    paper_trading: "模拟交易",
    papertrading: "模拟交易",
    real_trading: "实盘交易",
    realtrading: "实盘交易",
    live: "实盘交易",
    demo: "模拟交易",
  };

  // 转换为小写进行匹配
  const lowerChannel = accountChannel.toLowerCase();

  // 如果找到映射，返回中文名称
  if (channelMap[lowerChannel]) {
    return channelMap[lowerChannel];
  }

  // 否则返回原始值
  return accountChannel;
}

/**
 * 格式化标的显示：中文名称(代码.HK)
 * @param {string} symbol 标的代码
 * @param {string} symbolName 标的中文名称（可选）
 * @returns {string} 格式化后的标的显示
 */
export function formatSymbolDisplay(symbol, symbolName = null) {
  if (!symbol) {
    return symbol;
  }
  const normalizedSymbol = normalizeHKSymbol(symbol);
  if (symbolName) {
    return `${symbolName}(${normalizedSymbol})`;
  }
  return normalizedSymbol;
}

/**
 * 根据信号标的获取对应的中文名称
 * @param {string} signalSymbol 信号中的标的代码
 * @param {string} longSymbol 做多标的代码
 * @param {string} shortSymbol 做空标的代码
 * @param {string} longSymbolName 做多标的中文名称
 * @param {string} shortSymbolName 做空标的中文名称
 * @returns {string} 标的中文名称，如果未找到则返回原始代码
 */
export function getSymbolName(
  signalSymbol,
  longSymbol,
  shortSymbol,
  longSymbolName,
  shortSymbolName
) {
  const normalizedSigSymbol = normalizeHKSymbol(signalSymbol);
  const normalizedLongSymbol = normalizeHKSymbol(longSymbol);
  const normalizedShortSymbol = normalizeHKSymbol(shortSymbol);

  if (normalizedSigSymbol === normalizedLongSymbol) {
    return longSymbolName;
  } else if (normalizedSigSymbol === normalizedShortSymbol) {
    return shortSymbolName;
  }
  return signalSymbol;
}

/**
 * 将时间转换为北京时间（UTC+8）的字符串
 * @param {Date|null} date 时间对象，如果为 null 则使用当前时间
 * @param {Object} options 格式选项
 * @param {string} options.format 格式类型：'iso' (YYYY/MM/DD/HH:mm:ss) 或 'log' (YYYY-MM-DD HH:mm:ss.sss)，默认为 'iso'
 * @returns {string} 北京时间的字符串格式
 */
function toBeijingTime(date = null, options = {}) {
  const { format = "iso" } = options;
  const targetDate = date || new Date();
  // 转换为北京时间（UTC+8）
  const beijingOffset = 8 * 60 * 60 * 1000; // 8小时的毫秒数
  const beijingTime = new Date(targetDate.getTime() + beijingOffset);

  // 使用UTC方法获取年月日时分秒，这样得到的就是北京时间
  const year = beijingTime.getUTCFullYear();
  const month = String(beijingTime.getUTCMonth() + 1).padStart(2, "0");
  const day = String(beijingTime.getUTCDate()).padStart(2, "0");
  const hours = String(beijingTime.getUTCHours()).padStart(2, "0");
  const minutes = String(beijingTime.getUTCMinutes()).padStart(2, "0");
  const seconds = String(beijingTime.getUTCSeconds()).padStart(2, "0");

  return format === "log"
    ? // 日志格式：YYYY-MM-DD HH:mm:ss.sss（包含毫秒）
      `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${String(
        beijingTime.getUTCMilliseconds()
      ).padStart(3, "0")}`
    : // ISO 格式：YYYY/MM/DD/HH:mm:ss（不包含毫秒）
      `${year}/${month}/${day}/${hours}:${minutes}:${seconds}`;
}

/**
 * 将时间转换为北京时间（UTC+8）的 ISO 格式字符串
 * 格式：YYYY/MM/DD/HH:mm:ss
 * @param {Date|null} date 时间对象，如果为 null 则使用当前时间
 * @returns {string} 北京时间的字符串格式 YYYY/MM/DD/HH:mm:ss
 */
export function toBeijingTimeIso(date = null) {
  return toBeijingTime(date, { format: "iso" });
}

/**
 * 将时间转换为北京时间（UTC+8）的日志格式字符串
 * 格式：YYYY-MM-DD HH:mm:ss.sss（包含毫秒）
 * @param {Date|null} date 时间对象，如果为 null 则使用当前时间
 * @returns {string} 北京时间的字符串格式 YYYY-MM-DD HH:mm:ss.sss
 */
export function toBeijingTimeLog(date = null) {
  return toBeijingTime(date, { format: "log" });
}
