import { logger } from "../logger.js";
import { TRADING_CONFIG } from "./config.trading.js";
import { createConfig } from "./config.js";
import { MarketDataClient } from "../quoteClient.js";

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
 * 验证标的是否有效
 * @param {MarketDataClient} marketDataClient 行情客户端
 * @param {string} symbol 标的代码
 * @param {string} symbolLabel 标的标签（用于显示）
 * @returns {Promise<{valid: boolean, name: string|null, error: string|null}>}
 */
async function validateSymbol(marketDataClient, symbol, symbolLabel) {
  try {
    // 获取标的信息
    const quote = await marketDataClient.getLatestQuote(symbol);

    if (!quote) {
      return {
        valid: false,
        name: null,
        error: `${symbolLabel} ${symbol} 无法获取行情数据，可能不是有效的标的代码`,
      };
    }

    // 检查是否有名称（至少有一个名称字段）
    const name =
      quote.name ??
      quote.staticInfo?.nameHk ??
      quote.staticInfo?.nameCn ??
      quote.staticInfo?.nameEn;

    if (!name) {
      return {
        valid: false,
        name: null,
        error: `${symbolLabel} ${symbol} 缺少名称信息，可能不是有效的标的`,
      };
    }

    // 检查是否有价格
    if (!Number.isFinite(quote.price) || quote.price <= 0) {
      return {
        valid: false,
        name,
        error: `${symbolLabel} ${name}(${symbol}) 价格无效（price=${quote.price}），可能未在正常交易`,
      };
    }

    // 检查 staticInfo 中的交易状态（如果有）
    if (quote.staticInfo) {
      // 一些标的可能有 status 或 tradingStatus 字段
      const status = quote.staticInfo.status ?? quote.staticInfo.tradingStatus;

      // 如果有状态字段且不是正常状态，发出警告（但不阻止）
      if (status && typeof status === "string") {
        const normalStatuses = ["NORMAL", "TRADING", "ACTIVE", "OPEN"];
        const isNormal = normalStatuses.some((s) =>
          status.toUpperCase().includes(s)
        );

        if (!isNormal) {
          logger.warn(
            `${symbolLabel} ${name}(${symbol}) 交易状态为 ${status}，请确认是否可以正常交易`
          );
        }
      }
    }

    return {
      valid: true,
      name,
      error: null,
    };
  } catch (err) {
    return {
      valid: false,
      name: null,
      error: `${symbolLabel} ${symbol} 验证失败: ${err?.message ?? err}`,
    };
  }
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
 * @returns {Promise<{monitorName: string, longName: string, shortName: string, marketDataClient: MarketDataClient}>} 返回标的的中文名称和行情客户端实例
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

  // 验证标的有效性（创建 MarketDataClient 实例用于验证和后续使用）
  logger.info("验证标的有效性...");
  const config = createConfig();
  const marketDataClient = new MarketDataClient(config);

  const symbolValidations = await Promise.all([
    validateSymbol(marketDataClient, TRADING_CONFIG.monitorSymbol, "监控标的"),
    validateSymbol(marketDataClient, TRADING_CONFIG.longSymbol, "做多标的"),
    validateSymbol(marketDataClient, TRADING_CONFIG.shortSymbol, "做空标的"),
  ]);

  const [monitorResult, longResult, shortResult] = symbolValidations;

  const symbolErrors = [];
  if (!monitorResult.valid) {
    symbolErrors.push(monitorResult.error);
  }
  if (!longResult.valid) {
    symbolErrors.push(longResult.error);
  }
  if (!shortResult.valid) {
    symbolErrors.push(shortResult.error);
  }

  if (symbolErrors.length > 0) {
    logger.error("标的验证失败！");
    logger.error("=".repeat(60));
    logger.error("发现以下标的问题：");
    symbolErrors.forEach((error, index) => {
      logger.error(`  ${index + 1}. ${error}`);
    });
    logger.error("=".repeat(60));
    logger.error("");
    logger.error("请检查 .env 文件中的标的代码配置，确保：");
    logger.error("  1. 标的代码正确且存在");
    logger.error("  2. 标的正在正常交易");
    logger.error("  3. API 有权限访问该标的行情");
    logger.error("");

    throw new ConfigValidationError(
      `标的验证失败：发现 ${symbolErrors.length} 个问题`,
      []
    );
  }

  logger.info("配置验证通过，当前配置如下：");

  // 使用中文名称（代码）格式显示
  const formatSymbol = (result, symbol) => {
    if (result.valid && result.name) {
      return `${result.name}(${symbol})`;
    }
    return symbol;
  };

  logger.info(
    `监控标的: ${formatSymbol(monitorResult, TRADING_CONFIG.monitorSymbol)}`
  );
  logger.info(
    `做多标的: ${formatSymbol(longResult, TRADING_CONFIG.longSymbol)}`
  );
  logger.info(
    `做空标的: ${formatSymbol(shortResult, TRADING_CONFIG.shortSymbol)}`
  );
  logger.info(`目标买入金额: ${TRADING_CONFIG.targetNotional} HKD`);
  logger.info(`最大持仓市值: ${TRADING_CONFIG.maxPositionNotional} HKD`);
  logger.info(`单日最大亏损: ${TRADING_CONFIG.maxDailyLoss} HKD`);
  logger.info(
    `是否收盘前清仓: ${TRADING_CONFIG.clearPositionsBeforeClose ? "是" : "否"}`
  );
  logger.info("");

  // 返回标的名称和行情客户端实例供后续使用
  return {
    monitorName: monitorResult.name ?? TRADING_CONFIG.monitorSymbol,
    longName: longResult.name ?? TRADING_CONFIG.longSymbol,
    shortName: shortResult.name ?? TRADING_CONFIG.shortSymbol,
    marketDataClient, // 返回已创建的实例，避免重复创建
  };
}
