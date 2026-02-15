/**
 * 牛熊证风险检查模块
 *
 * 检查牛熊证距离回收价的安全性：
 * - 初始化时获取牛熊证回收价
 * - 买入前计算距离回收价百分比
 * - 牛证低于 配置阈值 或熊证高于 配置阈值 时拒绝买入
 * - 牛熊证当前价格过低时拒绝买入
 */
import { logger } from '../../utils/logger/index.js';
import { decimalToNumber, isDefined, formatError, formatSymbolDisplay } from '../../utils/helpers/index.js';
import type { SignalType } from '../../types/signal.js';
import type {
  MarketDataClient,
  WarrantType,
  RiskCheckResult,
  WarrantDistanceInfo,
  WarrantDistanceLiquidationResult,
  WarrantRefreshResult,
} from '../../types/services.js';
import type { WarrantInfo, WarrantQuote, WarrantRiskChecker, WarrantRiskCheckerDeps } from './types.js';
import {
  BULL_WARRANT_MIN_DISTANCE_PERCENT,
  BEAR_WARRANT_MAX_DISTANCE_PERCENT,
  BULL_WARRANT_LIQUIDATION_DISTANCE_PERCENT,
  BEAR_WARRANT_LIQUIDATION_DISTANCE_PERCENT,
  MIN_MONITOR_PRICE_THRESHOLD,
  MIN_WARRANT_PRICE_THRESHOLD,
  DEFAULT_PRICE_DECIMALS,
  DEFAULT_PERCENT_DECIMALS,
} from '../../constants/index.js';

const WARRANT_TYPE_NAMES: Record<string, string> = {
  BULL: '牛证',
  BEAR: '熊证',
};

function getWarrantTypeName(warrantType: WarrantType): string {
  return WARRANT_TYPE_NAMES[String(warrantType)] ?? '轮证';
}

/** 解析 API 返回的 category 字段为牛熊证类型 */
function parseWarrantType(category: unknown): WarrantType | null {
  // 判断牛证：category 可能是数字 3（枚举值）或字符串 "Bull"
  if (category === 3 || category === 'Bull' || category === 'BULL') {
    return 'BULL';
  }
  // 判断熊证：category 可能是数字 4（枚举值）或字符串 "Bear"
  if (category === 4 || category === 'Bear' || category === 'BEAR') {
    return 'BEAR';
  }
  return null;
}

/** 从 SDK 响应中提取回收价 */
function extractCallPrice(warrantQuote: WarrantQuote): number | null {
  const callPriceDecimal = warrantQuote.callPrice;

  if (!isDefined(callPriceDecimal)) {
    return null;
  }

  // SDK 返回 Decimal 类型，使用 decimalToNumber 转换
  return decimalToNumber(callPriceDecimal);
}

/** 验证牛熊证类型：做多应为牛证，做空应为熊证 */
function validateWarrantType(
  symbol: string,
  warrantType: WarrantType,
  expectedType: 'CALL' | 'PUT',
): void {
  const isExpectedType =
    (expectedType === 'CALL' && warrantType === 'BULL') ||
    (expectedType === 'PUT' && warrantType === 'BEAR');

  if (!isExpectedType) {
    logger.warn(
      `[风险检查警告] ${symbol} 的牛熊证类型不符合预期：期望${
        expectedType === 'CALL' ? '牛证' : '熊证'
      }，实际是${warrantType === 'BULL' ? '牛证' : '熊证'}`,
    );
  }
}

/** 验证回收价有效性，无效时拒绝买入 */
function validateCallPrice(
  symbol: string,
  callPrice: number | null | undefined,
): RiskCheckResult | null {
  if (!Number.isFinite(callPrice) || !callPrice || callPrice <= 0) {
    logger.warn(
      `[风险检查] ${symbol} 的回收价无效（${callPrice}），拒绝买入`,
    );
    return {
      allowed: false,
      reason: `回收价无效（${callPrice}），无法进行牛熊证风险检查，拒绝买入`,
    };
  }
  return null;
}

/** 验证监控标的价格有效性，防止使用错误的价格 */
function validateMonitorPrice(monitorCurrentPrice: number): RiskCheckResult | null {
  if (!Number.isFinite(monitorCurrentPrice) || monitorCurrentPrice <= 0) {
    logger.warn(
      `[风险检查] 监控标的的当前价格无效（${monitorCurrentPrice}），无法检查牛熊证风险`,
    );
    return {
      allowed: false,
      reason: `监控标的价格无效（${monitorCurrentPrice}），无法进行牛熊证风险检查`,
    };
  }

  // 额外验证：监控标的价格应该远大于牛熊证价格（通常>1000）
  if (monitorCurrentPrice < MIN_MONITOR_PRICE_THRESHOLD) {
    logger.warn(
      `[风险检查] 监控标的价格异常小（${monitorCurrentPrice}），可能获取到了错误的价格（如牛熊证本身的价格），拒绝买入以确保安全`,
    );
    return {
      allowed: false,
      reason: `监控标的价格异常（${monitorCurrentPrice}），无法进行牛熊证风险检查，拒绝买入`,
    };
  }

  return null;
}

/** 验证牛熊证当前价格有效性并检查最低价阈值 */
function validateWarrantCurrentPrice(
  symbol: string,
  warrantCurrentPrice: number | null,
): RiskCheckResult | null {
  if (warrantCurrentPrice === null || !Number.isFinite(warrantCurrentPrice)) {
    logger.warn(
      `[风险检查] ${symbol} 的牛熊证当前价格无效（${warrantCurrentPrice}），无法进行牛熊证风险检查`,
    );
    return {
      allowed: false,
      reason: `牛熊证当前价格无效（${warrantCurrentPrice}），无法进行风险检查，拒绝买入`,
    };
  }

  if (warrantCurrentPrice <= MIN_WARRANT_PRICE_THRESHOLD) {
    return {
      allowed: false,
      reason: `牛熊证当前价格 ${warrantCurrentPrice.toFixed(
        DEFAULT_PRICE_DECIMALS,
      )} 低于或等于 ${MIN_WARRANT_PRICE_THRESHOLD.toFixed(
        DEFAULT_PRICE_DECIMALS,
      )}，拒绝买入`,
    };
  }

  return null;
}

/** 计算距离回收价的百分比：(当前价 - 回收价) / 回收价 * 100 */
function calculateDistancePercent(
  monitorCurrentPrice: number,
  callPrice: number,
): number {
  return ((monitorCurrentPrice - callPrice) / callPrice) * 100;
}

/** 检查距离回收价是否在安全范围内 */
function checkDistanceThreshold(
  warrantType: WarrantType,
  distancePercent: number,
  callPrice: number,
  monitorCurrentPrice: number,
): RiskCheckResult {
  // 牛证：当距离回收价百分比低于阈值时停止买入
  if (warrantType === 'BULL') {
    if (distancePercent < BULL_WARRANT_MIN_DISTANCE_PERCENT) {
      return {
        allowed: false,
        reason: `牛证距离回收价百分比为 ${distancePercent.toFixed(
          DEFAULT_PERCENT_DECIMALS,
        )}%，低于${BULL_WARRANT_MIN_DISTANCE_PERCENT}%阈值，停止买入（回收价=${callPrice.toFixed(
          DEFAULT_PRICE_DECIMALS,
        )}，监控标的当前价=${monitorCurrentPrice.toFixed(DEFAULT_PRICE_DECIMALS)}）`,
        warrantInfo: {
          isWarrant: true,
          warrantType,
          distanceToStrikePercent: distancePercent,
        },
      };
    }
  }

  // 熊证：当距离回收价百分比高于阈值时停止买入
  if (warrantType === 'BEAR') {
    if (distancePercent > BEAR_WARRANT_MAX_DISTANCE_PERCENT) {
      return {
        allowed: false,
        reason: `熊证距离回收价百分比为 ${distancePercent.toFixed(
          DEFAULT_PERCENT_DECIMALS,
        )}%，高于${BEAR_WARRANT_MAX_DISTANCE_PERCENT}%阈值，停止买入（回收价=${callPrice.toFixed(
          DEFAULT_PRICE_DECIMALS,
        )}，监控标的当前价=${monitorCurrentPrice.toFixed(DEFAULT_PRICE_DECIMALS)}）`,
        warrantInfo: {
          isWarrant: true,
          warrantType,
          distanceToStrikePercent: distancePercent,
        },
      };
    }
  }

  // 风险检查通过
  const warrantTypeName = warrantType === 'BULL' ? '牛证' : '熊证';
  return {
    allowed: true,
    reason: `${warrantTypeName}距离回收价百分比为 ${distancePercent.toFixed(DEFAULT_PERCENT_DECIMALS)}%，在安全范围内`,
    warrantInfo: {
      isWarrant: true,
      warrantType,
      distanceToStrikePercent: distancePercent,
    },
  };
}

/** 构建距回收价清仓判定结果 */
function buildDistanceLiquidationResult(
  warrantType: WarrantType,
  distancePercent: number,
  callPrice: number,
  monitorCurrentPrice: number,
): WarrantDistanceLiquidationResult {
  const isBull = warrantType === 'BULL';
  const threshold = isBull
    ? BULL_WARRANT_LIQUIDATION_DISTANCE_PERCENT
    : BEAR_WARRANT_LIQUIDATION_DISTANCE_PERCENT;
  const shouldLiquidate = isBull
    ? distancePercent <= threshold
    : distancePercent >= threshold;

  const compareText = isBull ? '低于或等于' : '高于或等于';
  const prefix = isBull ? '牛证' : '熊证';
  const distanceText = distancePercent.toFixed(DEFAULT_PERCENT_DECIMALS);
  const callPriceText = callPrice.toFixed(DEFAULT_PRICE_DECIMALS);
  const monitorPriceText = monitorCurrentPrice.toFixed(DEFAULT_PRICE_DECIMALS);

  const reason = shouldLiquidate
    ? `${prefix}距离回收价百分比为 ${distanceText}%，${compareText}${threshold}%阈值，触发清仓（回收价=${callPriceText}，监控标的当前价=${monitorPriceText}）`
    : `${prefix}距离回收价百分比为 ${distanceText}%，未触发清仓阈值（回收价=${callPriceText}，监控标的当前价=${monitorPriceText}）`;

  return {
    shouldLiquidate,
    warrantType,
    distancePercent,
    reason,
  };
}

/** 构建距回收价信息（用于实时展示） */
function buildWarrantDistanceInfo(
  warrantInfo: WarrantInfo | null,
  monitorCurrentPrice: number | null,
): WarrantDistanceInfo | null {
  if (!warrantInfo?.isWarrant) {
    return null;
  }

  const callPrice = warrantInfo.callPrice;
  if (callPrice === null || !Number.isFinite(callPrice) || callPrice <= 0) {
    return {
      warrantType: warrantInfo.warrantType,
      distanceToStrikePercent: null,
    };
  }

  if (
    monitorCurrentPrice === null ||
    !Number.isFinite(monitorCurrentPrice) ||
    monitorCurrentPrice <= 0
  ) {
    return {
      warrantType: warrantInfo.warrantType,
      distanceToStrikePercent: null,
    };
  }

  const distancePercent = calculateDistancePercent(monitorCurrentPrice, callPrice);
  return {
    warrantType: warrantInfo.warrantType,
    distanceToStrikePercent: distancePercent,
  };
}

/** 调用 API 检查标的是否为牛熊证并获取回收价 */
async function checkWarrantType(
  marketDataClient: MarketDataClient,
  symbol: string,
  expectedType: 'CALL' | 'PUT',
): Promise<WarrantInfo> {
  const ctx = await marketDataClient._getContext();

  // 使用 warrantQuote API 获取牛熊证信息
  const warrantQuotesRaw = await ctx.warrantQuote([symbol]);
  // warrantQuote API 返回 SDK 定义的结构，这里只取第一个元素并在信任边界处做结构性断言
  const warrantQuote = (Array.isArray(warrantQuotesRaw)
    ? warrantQuotesRaw[0] ?? null
    : null) as WarrantQuote | null;

  if (!warrantQuote) {
    return { isWarrant: false };
  }

  // 从 SDK 获取 category（已经是 WarrantType 枚举）
  const category = warrantQuote.category;
  const warrantType = parseWarrantType(category);

  if (!warrantType) {
    return { isWarrant: false };
  }

  // 从 SDK 获取回收价
  const callPrice = extractCallPrice(warrantQuote);

  // 验证：做多标的应该是牛证，做空标的应该是熊证
  validateWarrantType(symbol, warrantType, expectedType);

  return {
    isWarrant: true,
    warrantType,
    callPrice,
    // SDK 的 category 可能是数字枚举或字符串枚举，这里统一视为 number|string 以便日志与调试使用
    category: category as number | string,
    symbol,
  };
}

/** 创建牛熊证风险检查器 */
export function createWarrantRiskChecker(
  _deps: WarrantRiskCheckerDeps = {},
): WarrantRiskChecker {
  // 闭包捕获的私有状态
  let longWarrantInfo: WarrantInfo | null = null;
  let shortWarrantInfo: WarrantInfo | null = null;

  /** 初始化单个标的的牛熊证信息并缓存 */
  async function initializeSymbolWarrantInfo(
    marketDataClient: MarketDataClient,
    symbol: string,
    expectedType: 'CALL' | 'PUT',
    isLong: boolean,
    symbolName: string | null = null,
  ): Promise<WarrantRefreshResult> {
    const symbolDisplay = formatSymbolDisplay(symbol, symbolName);
    try {
      const warrantInfo = await checkWarrantType(
        marketDataClient,
        symbol,
        expectedType,
      );

      if (isLong) {
        longWarrantInfo = warrantInfo;
      } else {
        shortWarrantInfo = warrantInfo;
      }

      if (warrantInfo.isWarrant) {
        const warrantTypeName = getWarrantTypeName(warrantInfo.warrantType);
        logger.info(
          `[风险检查] ${isLong ? '做多' : '做空'}标的 ${symbolDisplay} 是${warrantTypeName}，回收价=${warrantInfo.callPrice?.toFixed(3) ?? '未知'}`,
        );
        return { status: 'ok', isWarrant: true };
      } else {
        logger.info(`[风险检查] ${isLong ? '做多' : '做空'}标的 ${symbolDisplay} 不是牛熊证`);
        return { status: 'notWarrant', isWarrant: false };
      }
    } catch (err) {
      const errorMessage = formatError(err);
      logger.warn(
        `[风险检查] 检查${isLong ? '做多' : '做空'}标的 ${symbolDisplay} 牛熊证信息时出错：`,
        errorMessage,
      );
      if (isLong) {
        longWarrantInfo = { isWarrant: false };
      } else {
        shortWarrantInfo = { isWarrant: false };
      }
      return { status: 'error', isWarrant: false, reason: errorMessage };
    }
  }

  /** 检查牛熊证距离回收价的风险 */
  function checkRisk(
    symbol: string,
    signalType: SignalType,
    monitorCurrentPrice: number,
    warrantCurrentPrice: number | null,
  ): RiskCheckResult {
    // 确定是做多还是做空标的
    const isLong = signalType === 'BUYCALL';
    const warrantInfo = isLong ? longWarrantInfo : shortWarrantInfo;

    // 如果没有初始化过牛熊证信息，或者不是牛熊证，允许交易
    if (!warrantInfo?.isWarrant) {
      return { allowed: true };
    }

    // 验证回收价是否有效
    const callPriceValidation = validateCallPrice(symbol, warrantInfo.callPrice);
    if (callPriceValidation) {
      return callPriceValidation;
    }

    // 验证监控标的的当前价格是否有效
    const priceValidation = validateMonitorPrice(monitorCurrentPrice);
    if (priceValidation) {
      return priceValidation;
    }

    const warrantPriceValidation = validateWarrantCurrentPrice(
      symbol,
      warrantCurrentPrice,
    );
    if (warrantPriceValidation) {
      return warrantPriceValidation;
    }

    // 此处 callPrice 已通过验证，不为 null/undefined
    const callPrice = warrantInfo.callPrice;
    if (callPrice === null) {
      return {
        allowed: false,
        reason: `回收价无效（${callPrice}），无法进行牛熊证风险检查，拒绝买入`,
      };
    }

    const { warrantType } = warrantInfo;

    // 计算距离回收价的百分比
    const distancePercent = calculateDistancePercent(monitorCurrentPrice, callPrice);

    // 检查风险阈值
    return checkDistanceThreshold(
      warrantType,
      distancePercent,
      callPrice,
      monitorCurrentPrice,
    );
  }

  /** 检查牛熊证距回收价是否触发清仓 */
  function checkWarrantDistanceLiquidation(
    symbol: string,
    isLongSymbol: boolean,
    monitorCurrentPrice: number,
  ): WarrantDistanceLiquidationResult {
    const warrantInfo = isLongSymbol ? longWarrantInfo : shortWarrantInfo;

    if (!warrantInfo?.isWarrant) {
      return { shouldLiquidate: false };
    }

    const callPriceValidation = validateCallPrice(symbol, warrantInfo.callPrice);
    if (callPriceValidation) {
      return {
        shouldLiquidate: false,
        warrantType: warrantInfo.warrantType,
        distancePercent: null,
        reason: `回收价无效（${warrantInfo.callPrice}），无法进行距回收价清仓判断`,
      };
    }

    const monitorPriceValidation = validateMonitorPrice(monitorCurrentPrice);
    if (monitorPriceValidation) {
      return {
        shouldLiquidate: false,
        warrantType: warrantInfo.warrantType,
        distancePercent: null,
        reason: `监控标的价格无效（${monitorCurrentPrice}），无法进行距回收价清仓判断`,
      };
    }

    const callPrice = warrantInfo.callPrice;
    if (callPrice === null) {
      return {
        shouldLiquidate: false,
        warrantType: warrantInfo.warrantType,
        distancePercent: null,
        reason: `回收价无效（${callPrice}），无法进行距回收价清仓判断`,
      };
    }

    const distancePercent = calculateDistancePercent(monitorCurrentPrice, callPrice);

    return buildDistanceLiquidationResult(
      warrantInfo.warrantType,
      distancePercent,
      callPrice,
      monitorCurrentPrice,
    );
  }

  function getWarrantDistanceInfo(
    isLongSymbol: boolean,
    seatSymbol: string,
    monitorCurrentPrice: number | null,
  ): WarrantDistanceInfo | null {
    if (!seatSymbol) {
      return null;
    }
    const warrantInfo = isLongSymbol ? longWarrantInfo : shortWarrantInfo;
    if (!warrantInfo?.isWarrant) {
      return null;
    }
    if (warrantInfo.symbol !== seatSymbol) {
      logger.debug(
        `[风险检查调试] 距回收价信息标的校验失败: 席位=${seatSymbol}, 缓存=${warrantInfo.symbol}`,
      );
      return null;
    }
    return buildWarrantDistanceInfo(warrantInfo, monitorCurrentPrice);
  }

  function clearLongWarrantInfo(): void {
    longWarrantInfo = null;
  }

  function clearShortWarrantInfo(): void {
    shortWarrantInfo = null;
  }

  function setWarrantInfoFromCallPrice(
    symbol: string,
    callPrice: number,
    isLongSymbol: boolean,
    symbolName: string | null = null,
  ): WarrantRefreshResult {
    if (
      callPrice == null ||
      !Number.isFinite(callPrice) ||
      callPrice <= 0
    ) {
      return {
        status: 'error',
        isWarrant: false,
        reason: `回收价无效（${callPrice}），无法设置牛熊证信息`,
      };
    }

    const warrantType = isLongSymbol ? 'BULL' : 'BEAR';
    const category = isLongSymbol ? 3 : 4;

    const warrantInfo: WarrantInfo = {
      isWarrant: true,
      warrantType,
      callPrice,
      category,
      symbol,
    };

    if (isLongSymbol) {
      longWarrantInfo = warrantInfo;
    } else {
      shortWarrantInfo = warrantInfo;
    }

    const warrantTypeName = getWarrantTypeName(warrantType);
    const symbolDisplay = formatSymbolDisplay(symbol, symbolName);
    logger.info(
      `[风险检查] ${isLongSymbol ? '做多' : '做空'}标的 ${symbolDisplay} 从透传回收价设置${warrantTypeName}信息，回收价=${callPrice.toFixed(3)}`,
    );

    return { status: 'ok', isWarrant: true };
  }

  async function refreshWarrantInfoForSymbol(
    marketDataClient: MarketDataClient,
    symbol: string,
    isLongSymbol: boolean,
    symbolName: string | null = null,
  ): Promise<WarrantRefreshResult> {
    if (!marketDataClient) {
      logger.warn('[风险检查] 未提供 marketDataClient，跳过牛熊证信息刷新');
      return { status: 'skipped', isWarrant: false };
    }

    const expectedType = isLongSymbol ? 'CALL' : 'PUT';
    return initializeSymbolWarrantInfo(
      marketDataClient,
      symbol,
      expectedType,
      isLongSymbol,
      symbolName,
    );
  }

  return {
    setWarrantInfoFromCallPrice,
    refreshWarrantInfoForSymbol,
    checkRisk,
    checkWarrantDistanceLiquidation,
    getWarrantDistanceInfo,
    clearLongWarrantInfo,
    clearShortWarrantInfo,
  };
}
