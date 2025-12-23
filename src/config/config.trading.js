// 统一管理与交易相关的配置，避免在代码中硬编码
// 如需调整标的或金额，只需改这里或对应的环境变量
// 注意：所有配置项都必须从环境变量读取，没有默认值

// 加载环境变量（必须在读取配置之前）
import dotenv from "dotenv";
dotenv.config();

import { parseSignalConfig } from "../utils/signalConfigParser.js";

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

/**
 * 从环境变量读取数组配置（逗号分隔）
 * @param {string} envKey 环境变量键名
 * @param {string[]} allowedValues 允许的值列表（可选）
 * @returns {string[]|null} 配置值数组，如果未设置或无效则返回 null
 */
function getArrayConfig(envKey, allowedValues = null) {
  const value = process.env[envKey];
  if (!value || value.trim() === "") {
    return null;
  }

  // 分割并去除空白
  const items = value.split(",").map(item => item.trim()).filter(item => item !== "");

  if (items.length === 0) {
    return null;
  }

  // 如果指定了允许的值，则验证
  if (allowedValues && allowedValues.length > 0) {
    const invalidItems = items.filter(item => !allowedValues.includes(item));
    if (invalidItems.length > 0) {
      console.warn(`[配置警告] ${envKey} 包含无效值: ${invalidItems.join(", ")}，允许的值: ${allowedValues.join(", ")}`);
      // 过滤掉无效值
      const validItems = items.filter(item => allowedValues.includes(item));
      return validItems.length > 0 ? validItems : null;
    }
  }

  return items;
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

  // 单标的最大浮亏保护（HKD），当单个标的的浮亏超过此值时执行保护性清仓
  // 浮亏计算方式：R1（成本市值）= 全部买入订单市值 - 全部卖出订单市值，R2（当前持仓市值）= 当前价格 × 剩余数量，浮亏 = R2 - R1
  // 当浮亏 < -MAX_UNREALIZED_LOSS_PER_SYMBOL 时，立即执行保护性清仓（使用市价单）
  // 设置为 null 或 0 表示禁用此功能
  maxUnrealizedLossPerSymbol: getNumberConfig(
    "MAX_UNREALIZED_LOSS_PER_SYMBOL",
    0
  ),

  // 末日保护程序：收盘前15分钟拒绝买入，收盘前5分钟清空所有持仓
  // 港股当日收盘时间：下午 16:00
  // 收盘前5分钟：15:55-16:00（仅判断当日收盘，不包括上午收盘）
  // 默认值在 .env 文件中设置为 true
  doomsdayProtection: getBooleanConfig("DOOMSDAY_PROTECTION"),

  // 同方向买入时间间隔（秒），范围 10-600，默认 60 秒
  // 用于限制同一方向（做多或做空）的买入频率，避免短时间内重复买入
  buyIntervalSeconds: (() => {
    const interval = getNumberConfig("BUY_INTERVAL_SECONDS", 0);
    // 如果未设置，默认为 60 秒
    if (interval === null) {
      return 60;
    }
    // 限制范围在 10-600 秒之间
    if (interval < 10) {
      console.warn("[配置警告] BUY_INTERVAL_SECONDS 不能小于 10，已设置为 10");
      return 10;
    }
    if (interval > 600) {
      console.warn("[配置警告] BUY_INTERVAL_SECONDS 不能大于 600，已设置为 600");
      return 600;
    }
    return interval;
  })(),

  // 延迟验证配置
  verificationConfig: {
    // 验证时间间隔（秒），范围 0-120，默认 60 秒
    // 设置为 0 或未设置则不进行延迟验证
    delaySeconds: (() => {
      const delay = getNumberConfig("VERIFICATION_DELAY_SECONDS", 0);
      // 如果未设置，默认为 60 秒
      if (delay === null) {
        return 60;
      }
      // 限制范围在 0-120 秒之间
      if (delay < 0) {
        console.warn("[配置警告] VERIFICATION_DELAY_SECONDS 不能小于 0，已设置为 0");
        return 0;
      }
      if (delay > 120) {
        console.warn("[配置警告] VERIFICATION_DELAY_SECONDS 不能大于 120，已设置为 120");
        return 120;
      }
      return delay;
    })(),

    // 验证指标列表（可选值: K, D, J, MACD, DIF, DEA）
    // 留空或不设置则不进行延迟验证
    indicators: (() => {
      const allowedIndicators = ['K', 'D', 'J', 'MACD', 'DIF', 'DEA'];
      const indicators = getArrayConfig("VERIFICATION_INDICATORS", allowedIndicators);
      // 如果未设置或为空，返回 null 表示不进行延迟验证
      // 注意：这里不设置默认值，让用户明确配置
      if (indicators === null || indicators.length === 0) {
        return null;
      }
      return indicators;
    })(),
  },

  // 信号配置（必需）
  // 格式：(条件1,条件2,...)/N|(条件A)|(条件B,条件C)/M
  // - 括号内是条件列表，逗号分隔
  // - /N：括号内条件需满足 N 项，不设则全部满足
  // - |：分隔不同条件组（最多3个），满足任一组即可
  // - 支持指标：RSI6, RSI12, MFI, D (KDJ.D), J (KDJ.J)
  // - 支持运算符：< 和 >
  signalConfig: {
    // 买入做多信号配置
    buycall: (() => {
      const configStr = getStringConfig("SIGNAL_BUYCALL");
      if (!configStr) {
        return null; // 必需配置，如果未设置返回 null
      }
      const config = parseSignalConfig(configStr);
      if (!config) {
        console.error("[配置错误] SIGNAL_BUYCALL 格式无效");
        return null;
      }
      return config;
    })(),

    // 卖出做多信号配置
    sellcall: (() => {
      const configStr = getStringConfig("SIGNAL_SELLCALL");
      if (!configStr) {
        return null; // 必需配置，如果未设置返回 null
      }
      const config = parseSignalConfig(configStr);
      if (!config) {
        console.error("[配置错误] SIGNAL_SELLCALL 格式无效");
        return null;
      }
      return config;
    })(),

    // 买入做空信号配置
    buyput: (() => {
      const configStr = getStringConfig("SIGNAL_BUYPUT");
      if (!configStr) {
        return null; // 必需配置，如果未设置返回 null
      }
      const config = parseSignalConfig(configStr);
      if (!config) {
        console.error("[配置错误] SIGNAL_BUYPUT 格式无效");
        return null;
      }
      return config;
    })(),

    // 卖出做空信号配置
    sellput: (() => {
      const configStr = getStringConfig("SIGNAL_SELLPUT");
      if (!configStr) {
        return null; // 必需配置，如果未设置返回 null
      }
      const config = parseSignalConfig(configStr);
      if (!config) {
        console.error("[配置错误] SIGNAL_SELLPUT 格式无效");
        return null;
      }
      return config;
    })(),
  },
};
