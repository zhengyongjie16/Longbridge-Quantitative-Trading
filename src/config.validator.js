import { logger } from "./logger.js";
import { TRADING_CONFIG } from "./config.trading.js";
import { createConfig } from "./config.js";

/**
 * 配置验证错误类
 */
export class ConfigValidationError extends Error {
  constructor(message, missingFields = []) {
    super(message);
    this.name = "ConfigValidationError";
    this.missingFields = missingFields;
  }
}

/**
 * 验证 LongPort API 配置
 * @returns {Promise<{valid: boolean, errors: string[]}>}
 */
async function validateLongPortConfig() {
  const errors = [];

  const appKey = process.env.LONGPORT_APP_KEY;
  const appSecret = process.env.LONGPORT_APP_SECRET;
  const accessToken = process.env.LONGPORT_ACCESS_TOKEN;

  if (!appKey || appKey.trim() === "" || appKey === "your_app_key_here") {
    errors.push("LONGPORT_APP_KEY 未配置或使用默认值");
  }

  if (
    !appSecret ||
    appSecret.trim() === "" ||
    appSecret === "your_app_secret_here"
  ) {
    errors.push("LONGPORT_APP_SECRET 未配置或使用默认值");
  }

  if (
    !accessToken ||
    accessToken.trim() === "" ||
    accessToken === "your_access_token_here"
  ) {
    errors.push("LONGPORT_ACCESS_TOKEN 未配置或使用默认值");
  }

  // 如果基本配置存在，尝试创建配置对象验证
  if (errors.length === 0) {
    try {
      const config = createConfig();
      // 尝试访问配置属性来验证配置是否有效
      if (!config) {
        errors.push("LongPort 配置对象创建失败");
      }
    } catch (err) {
      errors.push(`LongPort 配置验证失败: ${err?.message ?? err}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * 验证交易配置
 * @returns {{valid: boolean, errors: string[], missingFields: string[]}}
 */
function validateTradingConfig() {
  const errors = [];
  const missingFields = [];

  // 验证监控标的
  if (
    !TRADING_CONFIG.monitorSymbol ||
    (typeof TRADING_CONFIG.monitorSymbol === "string" &&
      TRADING_CONFIG.monitorSymbol.trim() === "")
  ) {
    errors.push("MONITOR_SYMBOL 未配置");
    missingFields.push("MONITOR_SYMBOL");
  }

  // 验证做多标的
  if (
    !TRADING_CONFIG.longSymbol ||
    (typeof TRADING_CONFIG.longSymbol === "string" &&
      TRADING_CONFIG.longSymbol.trim() === "")
  ) {
    errors.push("LONG_SYMBOL 未配置");
    missingFields.push("LONG_SYMBOL");
  }

  // 验证做空标的
  if (
    !TRADING_CONFIG.shortSymbol ||
    (typeof TRADING_CONFIG.shortSymbol === "string" &&
      TRADING_CONFIG.shortSymbol.trim() === "")
  ) {
    errors.push("SHORT_SYMBOL 未配置");
    missingFields.push("SHORT_SYMBOL");
  }

  // 验证目标买入金额
  if (
    !Number.isFinite(TRADING_CONFIG.targetNotional) ||
    TRADING_CONFIG.targetNotional <= 0
  ) {
    errors.push("TARGET_NOTIONAL 未配置或无效（必须为正数）");
    missingFields.push("TARGET_NOTIONAL");
  }

  // 验证最小买卖单位
  if (
    !Number.isFinite(TRADING_CONFIG.longLotSize) ||
    TRADING_CONFIG.longLotSize <= 0
  ) {
    errors.push("LONG_LOT_SIZE 未配置或无效（必须为正数）");
    missingFields.push("LONG_LOT_SIZE");
  }

  if (
    !Number.isFinite(TRADING_CONFIG.shortLotSize) ||
    TRADING_CONFIG.shortLotSize <= 0
  ) {
    errors.push("SHORT_LOT_SIZE 未配置或无效（必须为正数）");
    missingFields.push("SHORT_LOT_SIZE");
  }

  // 验证风险管理配置
  if (
    !Number.isFinite(TRADING_CONFIG.maxPositionNotional) ||
    TRADING_CONFIG.maxPositionNotional <= 0
  ) {
    errors.push("MAX_POSITION_NOTIONAL 未配置或无效（必须为正数）");
    missingFields.push("MAX_POSITION_NOTIONAL");
  }

  if (
    !Number.isFinite(TRADING_CONFIG.maxDailyLoss) ||
    TRADING_CONFIG.maxDailyLoss < 0
  ) {
    errors.push("MAX_DAILY_LOSS 未配置或无效（必须为非负数）");
    missingFields.push("MAX_DAILY_LOSS");
  }

  // clearPositionsBeforeClose 是布尔值，不需要验证（默认值在 .env 文件中设置为 true）

  return {
    valid: errors.length === 0,
    errors,
    missingFields,
  };
}

/**
 * 验证所有配置
 * @returns {Promise<void>}
 * @throws {ConfigValidationError} 如果配置验证失败
 */
export async function validateAllConfig() {
  logger.info("开始验证配置...");

  const longPortResult = await validateLongPortConfig();
  const tradingResult = validateTradingConfig();

  const allErrors = [...longPortResult.errors, ...tradingResult.errors];
  const allMissingFields = [...tradingResult.missingFields];

  if (allErrors.length > 0) {
    logger.error("配置验证失败！");
    logger.error("=".repeat(60));
    logger.error("发现以下配置问题：");
    allErrors.forEach((error, index) => {
      logger.error(`  ${index + 1}. ${error}`);
    });
    logger.error("=".repeat(60));
    logger.error("");
    logger.error("请检查 .env 文件，确保所有必需的配置项都已正确设置。");
    logger.error("参考 .env.example 文件或 ENV_SETUP.md 文档了解配置说明。");
    logger.error("");

    throw new ConfigValidationError(
      `配置验证失败：发现 ${allErrors.length} 个问题`,
      allMissingFields
    );
  }

  logger.info("配置验证通过！");
  logger.info("");
  logger.info("配置摘要：");
  logger.info(`  监控标的: ${TRADING_CONFIG.monitorSymbol}`);
  logger.info(`  做多标的: ${TRADING_CONFIG.longSymbol}`);
  logger.info(`  做空标的: ${TRADING_CONFIG.shortSymbol}`);
  logger.info(`  目标买入金额: ${TRADING_CONFIG.targetNotional} HKD`);
  logger.info(`  最大持仓市值: ${TRADING_CONFIG.maxPositionNotional} HKD`);
  logger.info(`  单日最大亏损: ${TRADING_CONFIG.maxDailyLoss} HKD`);
  logger.info(
    `  收盘前清仓: ${TRADING_CONFIG.clearPositionsBeforeClose ? "是" : "否"}`
  );
  logger.info("");
}
