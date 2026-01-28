/**
 * 牛熊证风险检查模块
 *
 * 检查牛熊证距离回收价的安全性：
 * - 初始化时获取牛熊证回收价
 * - 买入前计算距离回收价百分比
 * - 牛证低于 0.5% 或熊证高于 -0.5% 时拒绝买入
 * - 牛熊证当前价格过低时拒绝买入
 */

import { logger } from '../../utils/logger/index.js';
import { decimalToNumber, isDefined, formatError, formatSymbolDisplay } from '../../utils/helpers/index.js';
import type {
  MarketDataClient,
  WarrantType,
  RiskCheckResult,
  SignalType,
  WarrantDistanceInfo,
} from '../../types/index.js';
import type { WarrantInfo, WarrantQuote, WarrantRiskChecker, WarrantRiskCheckerDeps } from './types.js';
import {
  BULL_WARRANT_MIN_DISTANCE_PERCENT,
  BEAR_WARRANT_MAX_DISTANCE_PERCENT,
  MIN_MONITOR_PRICE_THRESHOLD,
  MIN_WARRANT_PRICE_THRESHOLD,
  DEFAULT_PRICE_DECIMALS,
  DEFAULT_PERCENT_DECIMALS,
} from '../../constants/index.js';

/** 创建牛熊证风险检查器 */
export const createWarrantRiskChecker = (_deps: WarrantRiskCheckerDeps = {}): WarrantRiskChecker => {
  // 闭包捕获的私有状态
  let longWarrantInfo: WarrantInfo | null = null;
  let shortWarrantInfo: WarrantInfo | null = null;

  /** 获取牛熊证类型的中文名称 */
  const getWarrantTypeName = (warrantType: WarrantType): string => {
    if (warrantType === 'BULL') {
      return '牛证';
    } else if (warrantType === 'BEAR') {
      return '熊证';
    } else {
      return '轮证';
    }
  };

  /** 解析 API 返回的 category 字段为牛熊证类型 */
  const parseWarrantType = (category: unknown): WarrantType | null => {
    // 判断牛证：category 可能是数字 3（枚举值）或字符串 "Bull"
    if (category === 3 || category === 'Bull' || category === 'BULL') {
      return 'BULL';
    }
    // 判断熊证：category 可能是数字 4（枚举值）或字符串 "Bear"
    else if (category === 4 || category === 'Bear' || category === 'BEAR') {
      return 'BEAR';
    }
    return null;
  };

  /** 从 API 响应中提取回收价（支持 Decimal 对象） */
  const extractCallPrice = (warrantQuote: WarrantQuote): number | null => {
    const callPriceRaw = warrantQuote.call_price ?? warrantQuote.callPrice ?? null;

    if (!isDefined(callPriceRaw)) {
      return null;
    }

    // 如果是 Decimal 对象，使用 decimalToNumber 转换；否则直接使用 Number 转换
    if (typeof callPriceRaw === 'object' && callPriceRaw !== null && 'toString' in callPriceRaw) {
      return decimalToNumber((callPriceRaw as { toString: () => string }).toString());
    }
    return Number(callPriceRaw);
  };

  /** 验证牛熊证类型：做多应为牛证，做空应为熊证 */
  const validateWarrantType = (
    symbol: string,
    warrantType: WarrantType,
    expectedType: 'CALL' | 'PUT',
  ): void => {
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
  };

  /** 调用 API 检查标的是否为牛熊证并获取回收价 */
  const checkWarrantType = async (
    marketDataClient: MarketDataClient,
    symbol: string,
    expectedType: 'CALL' | 'PUT',
  ): Promise<WarrantInfo> => {
    const ctx = await marketDataClient._getContext();

    // 使用 warrantQuote API 获取牛熊证信息
    const warrantQuotesRaw = await ctx.warrantQuote([symbol]);
    const warrantQuote = (Array.isArray(warrantQuotesRaw) && warrantQuotesRaw.length > 0
      ? warrantQuotesRaw[0]
      : null) as WarrantQuote | null;

    if (!warrantQuote) {
      return { isWarrant: false };
    }

    // 从 warrantQuote 中获取 category 字段判断牛熊证类型
    const category = warrantQuote.category;
    const warrantType = parseWarrantType(category);

    if (!warrantType) {
      return { isWarrant: false };
    }

    // 获取回收价
    const callPrice = extractCallPrice(warrantQuote);

    // 验证：做多标的应该是牛证，做空标的应该是熊证
    validateWarrantType(symbol, warrantType, expectedType);

    return {
      isWarrant: true,
      warrantType,
      callPrice,
      category: category as number | string,
      symbol,
    };
  };

  /** 初始化单个标的的牛熊证信息并缓存 */
  const initializeSymbolWarrantInfo = async (
    marketDataClient: MarketDataClient,
    symbol: string,
    expectedType: 'CALL' | 'PUT',
    isLong: boolean,
    symbolName: string | null = null,
  ): Promise<void> => {
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
      } else {
        logger.info(`[风险检查] ${isLong ? '做多' : '做空'}标的 ${symbolDisplay} 不是牛熊证`);
      }
    } catch (err) {
      logger.warn(
        `[风险检查] 检查${isLong ? '做多' : '做空'}标的 ${symbolDisplay} 牛熊证信息时出错：`,
        formatError(err),
      );
      if (isLong) {
        longWarrantInfo = { isWarrant: false };
      } else {
        shortWarrantInfo = { isWarrant: false };
      }
    }
  };

  /** 验证回收价有效性，无效时拒绝买入 */
  const validateCallPrice = (
    symbol: string,
    callPrice: number | null | undefined,
  ): RiskCheckResult | null => {
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
  };

  /** 验证监控标的价格有效性，防止使用错误的价格 */
  const validateMonitorPrice = (monitorCurrentPrice: number): RiskCheckResult | null => {
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
  };

  /** 验证牛熊证当前价格有效性并检查最低价阈值 */
  const validateWarrantCurrentPrice = (
    symbol: string,
    warrantCurrentPrice: number | null,
  ): RiskCheckResult | null => {
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
  };

  /** 计算距离回收价的百分比：(当前价 - 回收价) / 回收价 * 100 */
  const calculateDistancePercent = (
    monitorCurrentPrice: number,
    callPrice: number,
  ): number => {
    return ((monitorCurrentPrice - callPrice) / callPrice) * 100;
  };

  /** 构建距离回收价信息（用于实时展示；此函数仅计算，不直接输出日志） */
  const buildWarrantDistanceInfo = (
    warrantInfo: WarrantInfo | null,
    monitorCurrentPrice: number | null,
  ): WarrantDistanceInfo | null => {
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
  };

  /** 检查距离回收价是否在安全范围内 */
  const checkDistanceThreshold = (
    warrantType: WarrantType,
    distancePercent: number,
    callPrice: number,
    monitorCurrentPrice: number,
  ): RiskCheckResult => {
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
    return {
      allowed: true,
      reason: `${
        warrantType === 'BULL' ? '牛证' : '熊证'
      }距离回收价百分比为 ${distancePercent.toFixed(DEFAULT_PERCENT_DECIMALS)}%，在安全范围内`,
      warrantInfo: {
        isWarrant: true,
        warrantType,
        distanceToStrikePercent: distancePercent,
      },
    };
  };

  /** 初始化做多/做空标的的牛熊证信息 */
  const initialize = async (
    marketDataClient: MarketDataClient,
    longSymbol: string,
    shortSymbol: string,
    longSymbolName: string | null = null,
    shortSymbolName: string | null = null,
  ): Promise<void> => {
    if (!marketDataClient) {
      logger.warn('[风险检查] 未提供 marketDataClient，跳过牛熊证信息初始化');
      return;
    }

    // 初始化做多标的
    if (longSymbol) {
      await initializeSymbolWarrantInfo(
        marketDataClient,
        longSymbol,
        'CALL',
        true,
        longSymbolName,
      );
    }

    // 初始化做空标的
    if (shortSymbol) {
      await initializeSymbolWarrantInfo(
        marketDataClient,
        shortSymbol,
        'PUT',
        false,
        shortSymbolName,
      );
    }
  };

  /** 检查牛熊证距离回收价的风险 */
  const checkRisk = (
    symbol: string,
    signalType: SignalType,
    monitorCurrentPrice: number,
    warrantCurrentPrice: number | null,
  ): RiskCheckResult => {
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
  };

  const getWarrantDistanceInfo = (
    isLongSymbol: boolean,
    monitorCurrentPrice: number | null,
  ): WarrantDistanceInfo | null => {
    const warrantInfo = isLongSymbol ? longWarrantInfo : shortWarrantInfo;
    return buildWarrantDistanceInfo(warrantInfo, monitorCurrentPrice);
  };

  return {
    initialize,
    checkRisk,
    getWarrantDistanceInfo,
  };
};
