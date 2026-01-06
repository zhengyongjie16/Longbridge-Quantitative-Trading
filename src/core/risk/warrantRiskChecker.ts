/**
 * 牛熊证风险检查模块
 *
 * 功能：
 * - 检查标的是否为牛熊证
 * - 获取牛熊证回收价信息
 * - 计算距离回收价的百分比
 * - 判断是否超过风险阈值
 */

import { logger } from '../../utils/logger.js';
import { normalizeHKSymbol, decimalToNumber, isDefined } from '../../utils/helpers.js';
import type { MarketDataClient } from '../../services/quoteClient/index.js';
import type { WarrantType, WarrantInfo, RiskCheckResult, WarrantQuote, WarrantRiskChecker, WarrantRiskCheckerDeps } from './type.js';
import {
  BULL_WARRANT_MIN_DISTANCE_PERCENT,
  BEAR_WARRANT_MAX_DISTANCE_PERCENT,
  MIN_MONITOR_PRICE_THRESHOLD,
  DEFAULT_PRICE_DECIMALS,
  DEFAULT_PERCENT_DECIMALS,
} from './constants.js';

/**
 * 创建牛熊证风险检查器
 * @param _deps 依赖注入（当前为空）
 * @returns WarrantRiskChecker 接口实例
 */
export const createWarrantRiskChecker = (_deps: WarrantRiskCheckerDeps = {}): WarrantRiskChecker => {
  // 闭包捕获的私有状态
  let longWarrantInfo: WarrantInfo | null = null;
  let shortWarrantInfo: WarrantInfo | null = null;

  /**
   * 获取牛熊证类型名称
   */
  const getWarrantTypeName = (warrantType: WarrantType | undefined): string => {
    if (warrantType === 'BULL') {
      return '牛证';
    } else if (warrantType === 'BEAR') {
      return '熊证';
    } else {
      return '轮证';
    }
  };

  /**
   * 解析牛熊证类型
   */
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

  /**
   * 提取回收价
   */
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

  /**
   * 验证牛熊证类型是否符合预期
   */
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

  /**
   * 检查标的是否为牛熊证并获取回收价
   */
  const checkWarrantType = async (
    marketDataClient: MarketDataClient,
    symbol: string,
    expectedType: 'CALL' | 'PUT',
  ): Promise<WarrantInfo> => {
    const normalizedSymbol = normalizeHKSymbol(symbol);
    const ctx = await marketDataClient._getContext();

    // 使用 warrantQuote API 获取牛熊证信息
    const warrantQuotesRaw = await ctx.warrantQuote([normalizedSymbol]);
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
      return {
        isWarrant: false,
        ...(category !== undefined && { category }),
      };
    }

    // 获取回收价
    const callPrice = extractCallPrice(warrantQuote);

    // 验证：做多标的应该是牛证，做空标的应该是熊证
    validateWarrantType(symbol, warrantType, expectedType);

    return {
      isWarrant: true,
      warrantType,
      callPrice,
      ...(category !== undefined && { category }),
      symbol: normalizedSymbol,
    };
  };

  /**
   * 初始化单个标的的牛熊证信息
   */
  const initializeSymbolWarrantInfo = async (
    marketDataClient: MarketDataClient,
    symbol: string,
    expectedType: 'CALL' | 'PUT',
    isLong: boolean,
  ): Promise<void> => {
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
          `[风险检查] ${isLong ? '做多' : '做空'}标的 ${symbol} 是${warrantTypeName}，回收价=${warrantInfo.callPrice?.toFixed(3) ?? '未知'}`,
        );
      } else {
        logger.info(`[风险检查] ${isLong ? '做多' : '做空'}标的 ${symbol} 不是牛熊证`);
      }
    } catch (err) {
      logger.warn(
        `[风险检查] 检查${isLong ? '做多' : '做空'}标的牛熊证信息时出错：`,
        (err as Error)?.message ?? String(err),
      );
      if (isLong) {
        longWarrantInfo = { isWarrant: false };
      } else {
        shortWarrantInfo = { isWarrant: false };
      }
    }
  };

  /**
   * 验证回收价有效性
   */
  const validateCallPrice = (
    symbol: string,
    callPrice: number | null | undefined,
  ): RiskCheckResult | null => {
    if (!Number.isFinite(callPrice) || !callPrice || callPrice <= 0) {
      logger.warn(
        `[风险检查] ${symbol} 的回收价无效（${callPrice}），允许交易`,
      );
      return { allowed: true };
    }
    return null;
  };

  /**
   * 验证监控标的价格有效性
   */
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

  /**
   * 计算距离回收价的百分比
   */
  const calculateDistancePercent = (
    monitorCurrentPrice: number,
    callPrice: number,
  ): number => {
    return ((monitorCurrentPrice - callPrice) / callPrice) * 100;
  };

  /**
   * 检查距离回收价是否超过阈值
   */
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

  /**
   * 初始化牛熊证信息（在程序启动时调用）
   */
  const initialize = async (
    marketDataClient: MarketDataClient,
    longSymbol: string,
    shortSymbol: string,
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
      );
    }

    // 初始化做空标的
    if (shortSymbol) {
      await initializeSymbolWarrantInfo(
        marketDataClient,
        shortSymbol,
        'PUT',
        false,
      );
    }
  };

  /**
   * 检查牛熊证距离回收价的风险（仅在买入前检查）
   */
  const checkRisk = (
    symbol: string,
    signalType: string,
    monitorCurrentPrice: number,
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

    // 此处 callPrice 和 warrantType 已通过验证，不为 null/undefined
    const callPrice = warrantInfo.callPrice;
    const warrantType = warrantInfo.warrantType;

    if (!callPrice || !warrantType) {
      return { allowed: true };
    }

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

  return {
    initialize,
    checkRisk,
  };
};
