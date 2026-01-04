/**
 * 风险控制模块
 *
 * 功能：
 * - 实施买入前的风险检查
 * - 监控单日和单标的浮亏
 * - 检查牛熊证距离回收价的安全性
 *
 * 风险检查类型：
 * 1. 牛熊证风险：牛证距离回收价 > 0.5%，熊证 < -0.5%
 * 2. 单日亏损限制：整体浮亏必须 > -MAX_DAILY_LOSS
 * 3. 持仓市值限制：单标的市值必须 ≤ MAX_POSITION_NOTIONAL
 * 4. 单标的安全边际：监控标的价格必须 > 1
 *
 * 浮亏监控：
 * - 实时计算持仓浮亏
 * - 超过阈值时触发保护性清仓
 * - 使用 R1（开仓成本）和 N1（持仓数量）计算
 */

import { TRADING_CONFIG } from '../../config/config.trading.js';
import { normalizeHKSymbol, decimalToNumber, isDefined, isBuyAction } from '../../utils/helpers.js';
import { logger } from '../../utils/logger.js';
import type { Position, Signal, AccountSnapshot } from '../../types/index.js';
import type { MarketDataClient } from '../../services/quoteClient/index.js';
import type { OrderRecorder } from '../orderRecorder/index.js';
import type {
  WarrantType,
  WarrantInfo,
  RiskCheckResult,
  UnrealizedLossData,
  UnrealizedLossCheckResult,
  RiskCheckerOptions,
} from './type.js';

// ============ 风险检查常量定义 ============

/** 牛证最低距离回收价百分比（低于此值停止买入牛证） */
const BULL_WARRANT_MIN_DISTANCE_PERCENT = 0.5;

/** 熊证最高距离回收价百分比（高于此值停止买入熊证） */
const BEAR_WARRANT_MAX_DISTANCE_PERCENT = -0.5;

/** 监控标的价格最小有效值（低于此值认为价格异常） */
const MIN_MONITOR_PRICE_THRESHOLD = 1;

/** 默认价格小数位数 */
const DEFAULT_PRICE_DECIMALS = 3;

/** 默认百分比小数位数 */
const DEFAULT_PERCENT_DECIMALS = 2;

export class RiskChecker {
  maxDailyLoss: number;
  maxPositionNotional: number | null;
  maxUnrealizedLossPerSymbol: number | null;
  longWarrantInfo: WarrantInfo | null;
  shortWarrantInfo: WarrantInfo | null;
  unrealizedLossData: Map<string, UnrealizedLossData>;

  constructor({
    maxDailyLoss,
    maxPositionNotional,
    maxUnrealizedLossPerSymbol,
  }: RiskCheckerOptions = {}) {
    this.maxDailyLoss = maxDailyLoss ?? TRADING_CONFIG.maxDailyLoss ?? 0;
    this.maxPositionNotional =
      maxPositionNotional ?? TRADING_CONFIG.maxPositionNotional;
    this.maxUnrealizedLossPerSymbol =
      maxUnrealizedLossPerSymbol ?? TRADING_CONFIG.maxUnrealizedLossPerSymbol;

    // 验证 maxDailyLoss 的有效性
    if (!Number.isFinite(this.maxDailyLoss) || this.maxDailyLoss < 0) {
      logger.warn(
        `[风险检查警告] maxDailyLoss 配置无效（${this.maxDailyLoss}），将使用默认值 0（禁止任何浮亏）`,
      );
      this.maxDailyLoss = 0;
    }

    // 牛熊证信息缓存
    this.longWarrantInfo = null; // 做多标的的牛熊证信息
    this.shortWarrantInfo = null; // 做空标的的牛熊证信息

    // 浮亏监控数据缓存（用于实时监控）
    // 格式：{ symbol: { r1: number, n1: number, lastUpdateTime: number } }
    this.unrealizedLossData = new Map();
  }

  /**
   * 初始化牛熊证信息（在程序启动时调用）
   * @param marketDataClient MarketDataClient实例
   * @param longSymbol 做多标的代码
   * @param shortSymbol 做空标的代码
   */
  async initializeWarrantInfo(
    marketDataClient: MarketDataClient,
    longSymbol: string,
    shortSymbol: string,
  ): Promise<void> {
    if (!marketDataClient) {
      logger.warn('[风险检查] 未提供 marketDataClient，跳过牛熊证信息初始化');
      return;
    }

    // 初始化做多标的
    if (longSymbol) {
      try {
        const warrantInfo = await this._checkWarrantType(
          marketDataClient,
          longSymbol,
          'CALL',
        );
        this.longWarrantInfo = warrantInfo;

        if (warrantInfo.isWarrant) {
          let warrantTypeName: string;
          if (warrantInfo.warrantType === 'BULL') {
            warrantTypeName = '牛证';
          } else if (warrantInfo.warrantType === 'BEAR') {
            warrantTypeName = '熊证';
          } else {
            warrantTypeName = '轮证';
          }
          logger.info(
            `[风险检查] 做多标的 ${longSymbol} 是${warrantTypeName}，回收价=${warrantInfo.callPrice?.toFixed(3) ?? '未知'}`,
          );
        } else {
          logger.info(`[风险检查] 做多标的 ${longSymbol} 不是牛熊证`);
        }
      } catch (err) {
        logger.warn(
          '[风险检查] 检查做多标的牛熊证信息时出错：',
          (err as Error)?.message ?? String(err),
        );
        this.longWarrantInfo = { isWarrant: false };
      }
    }

    // 初始化做空标的
    if (shortSymbol) {
      try {
        const warrantInfo = await this._checkWarrantType(
          marketDataClient,
          shortSymbol,
          'PUT',
        );
        this.shortWarrantInfo = warrantInfo;

        if (warrantInfo.isWarrant) {
          let warrantTypeName: string;
          if (warrantInfo.warrantType === 'BULL') {
            warrantTypeName = '牛证';
          } else if (warrantInfo.warrantType === 'BEAR') {
            warrantTypeName = '熊证';
          } else {
            warrantTypeName = '轮证';
          }
          logger.info(
            `[风险检查] 做空标的 ${shortSymbol} 是${warrantTypeName}，回收价=${warrantInfo.callPrice?.toFixed(3) ?? '未知'}`,
          );
        } else {
          logger.info(`[风险检查] 做空标的 ${shortSymbol} 不是牛熊证`);
        }
      } catch (err) {
        logger.warn(
          '[风险检查] 检查做空标的牛熊证信息时出错：',
          (err as Error)?.message ?? String(err),
        );
        this.shortWarrantInfo = { isWarrant: false };
      }
    }
  }

  /**
   * 检查标的是否为牛熊证并获取回收价
   * @private
   * @param marketDataClient MarketDataClient实例
   * @param symbol 标的代码
   * @param expectedType 期望的类型：'CALL'（做多标的期望牛证）和 'PUT'（做空标的期望熊证）
   * @returns { isWarrant: boolean, warrantType: string, callPrice: number, category: string }
   */
  private async _checkWarrantType(
    marketDataClient: MarketDataClient,
    symbol: string,
    expectedType: 'CALL' | 'PUT',
  ): Promise<WarrantInfo> {
    const normalizedSymbol = normalizeHKSymbol(symbol);
    const ctx = await marketDataClient._getContext();

    // 使用 warrantQuote API 获取牛熊证信息
    const warrantQuotes = await ctx.warrantQuote([normalizedSymbol]);
    const warrantQuote =
      Array.isArray(warrantQuotes) && warrantQuotes.length > 0
        ? warrantQuotes[0]
        : null;

    if (!warrantQuote) {
      return { isWarrant: false };
    }

    // 从 warrantQuote 中获取 category 字段判断牛熊证类型
    // 注意：category 是 WarrantType 枚举（数字类型），不是字符串
    // WarrantType: Call=1, Put=2, Bull=3, Bear=4, Inline=5
    const category = (warrantQuote as unknown as Record<string, unknown>)['category'];
    let warrantType: WarrantType | null = null;

    // 判断牛证：category 可能是数字 3（枚举值）或字符串 "Bull"
    if (category === 3 || category === 'Bull' || category === 'BULL') {
      warrantType = 'BULL';
    }
    // 判断熊证：category 可能是数字 4（枚举值）或字符串 "Bear"
    else if (category === 4 || category === 'Bear' || category === 'BEAR') {
      warrantType = 'BEAR';
    } else {
      // 不是牛熊证（可能是 Call=1, Put=2, Inline=5 或其他类型）
      return { isWarrant: false, category: category as number | string };
    }

    // 获取回收价（call_price 字段）
    const callPriceRaw =
      (warrantQuote as unknown as Record<string, unknown>)['call_price'] ??
      (warrantQuote as unknown as Record<string, unknown>)['callPrice'] ??
      null;

    // 转换 Decimal 类型为 number（LongPort API 返回的价格字段可能是 Decimal 类型）
    let callPrice: number | null = null;
    if (isDefined(callPriceRaw)) {
      // 如果是 Decimal 对象，使用 decimalToNumber 转换；否则直接使用 Number 转换
      if (typeof callPriceRaw === 'object' && callPriceRaw !== null && 'toString' in callPriceRaw) {
        callPrice = decimalToNumber((callPriceRaw as { toString: () => string }).toString());
      } else {
        callPrice = Number(callPriceRaw);
      }
    }

    // 验证：做多标的应该是牛证，做空标的应该是熊证
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

    return {
      isWarrant: true,
      warrantType,
      callPrice,
      category: category as number | string,
      symbol: normalizedSymbol,
    };
  }

  /**
   * 检查订单前的风险
   * @param account 账户快照
   * @param positions 持仓列表
   * @param signal 信号对象
   * @param orderNotional 计划下单金额（HKD）
   * @param currentPrice 标的当前市价
   * @param longCurrentPrice 做多标的的当前市价
   * @param shortCurrentPrice 做空标的的当前市价
   */
  checkBeforeOrder(
    account: AccountSnapshot | null,
    positions: Position[] | null,
    signal: Signal | null,
    orderNotional: number,
    currentPrice: number | null = null,
    longCurrentPrice: number | null = null,
    shortCurrentPrice: number | null = null,
  ): RiskCheckResult {
    // HOLD 信号不需要检查
    if (!signal || signal.action === 'HOLD') {
      return { allowed: true };
    }

    // 判断是否为买入操作
    const isBuy = isBuyAction(signal.action);

    // 对于买入操作，账户数据是必需的（用于浮亏检查）
    if (isBuy && !account) {
      return {
        allowed: false,
        reason: '账户数据不可用，无法进行风险检查，禁止买入操作',
      };
    }

    // 对于卖出操作，如果没有账户数据，允许继续（卖出操作不检查浮亏）
    if (!account) {
      return { allowed: true };
    }

    const { netAssets, totalCash } = account;

    // 验证账户数据有效性
    if (!Number.isFinite(netAssets) || !Number.isFinite(totalCash)) {
      // 对于买入操作，账户数据无效必须拒绝
      if (isBuy) {
        return {
          allowed: false,
          reason: `账户数据无效（netAssets=${netAssets}, totalCash=${totalCash}），无法进行风险检查，禁止买入操作`,
        };
      }
      // 对于卖出操作，账户数据无效时允许继续（卖出操作不检查浮亏）
      return { allowed: true };
    }

    // 当日浮亏超过 maxDailyLoss 时，停止开新仓（仅对买入操作检查）
    // 使用缓存的浮亏数据（从开仓成本计算），而不是使用持仓的平摊成本
    if (isBuy) {
      // 获取做多和做空标的的符号
      const longSymbol = TRADING_CONFIG.longSymbol
        ? normalizeHKSymbol(TRADING_CONFIG.longSymbol)
        : null;
      const shortSymbol = TRADING_CONFIG.shortSymbol
        ? normalizeHKSymbol(TRADING_CONFIG.shortSymbol)
        : null;

      // 判断当前信号是做多还是做空
      const isBuyCall = signal.action === 'BUYCALL';
      const isBuyPut = signal.action === 'BUYPUT';

      // 检查做多标的买入：从缓存获取浮亏数据
      if (isBuyCall && longSymbol) {
        const lossData = this.unrealizedLossData.get(longSymbol);

        if (lossData && lossData.n1 > 0) {
          const { r1, n1 } = lossData;
          const checkPrice = longCurrentPrice;

          // 验证当前价格有效性
          if (checkPrice !== null && Number.isFinite(checkPrice) && checkPrice > 0) {
            // 计算当前持仓市值R2和浮亏X
            const r2 = checkPrice * n1;
            const longUnrealizedPnL = r2 - r1;

            // 记录浮亏计算详情（仅在DEBUG模式下）
            if (process.env['DEBUG'] === 'true') {
              logger.debug(
                `[风险检查调试] 做多标的浮亏检查: R1(开仓成本)=${r1.toFixed(
                  2,
                )}, R2(当前市值)=${r2.toFixed(
                  2,
                )}, 浮亏=${longUnrealizedPnL.toFixed(2)} HKD，最大允许亏损=${
                  this.maxDailyLoss
                } HKD`,
              );
            }

            // 如果浮亏计算结果不是有限数字，拒绝买入操作（安全策略）
            if (!Number.isFinite(longUnrealizedPnL)) {
              logger.error(
                `[风险检查错误] 做多标的持仓浮亏计算结果无效：${longUnrealizedPnL}`,
              );
              return {
                allowed: false,
                reason: `做多标的持仓浮亏计算结果无效（${longUnrealizedPnL}），无法进行风险检查，禁止买入做多标的`,
              };
            }

            // 检查做多标的持仓浮亏是否超过最大允许亏损
            if (longUnrealizedPnL <= -this.maxDailyLoss) {
              return {
                allowed: false,
                reason: `做多标的持仓浮亏约 ${longUnrealizedPnL.toFixed(
                  2,
                )} HKD 已超过单日最大亏损限制 ${
                  this.maxDailyLoss
                } HKD，禁止买入做多标的（R1=${r1.toFixed(2)}, R2=${r2.toFixed(
                  2,
                )}, N1=${n1}）`,
              };
            }
          }
        }
      }

      // 检查做空标的买入：从缓存获取浮亏数据
      if (isBuyPut && shortSymbol) {
        const lossData = this.unrealizedLossData.get(shortSymbol);

        if (lossData && lossData.n1 > 0) {
          const { r1, n1 } = lossData;
          const checkPrice = shortCurrentPrice;

          // 验证当前价格有效性
          if (checkPrice !== null && Number.isFinite(checkPrice) && checkPrice > 0) {
            // 计算当前持仓市值R2和浮亏X
            const r2 = checkPrice * n1;
            const shortUnrealizedPnL = r2 - r1;

            // 记录浮亏计算详情（仅在DEBUG模式下）
            if (process.env['DEBUG'] === 'true') {
              logger.debug(
                `[风险检查调试] 做空标的浮亏检查: R1(开仓成本)=${r1.toFixed(
                  2,
                )}, R2(当前市值)=${r2.toFixed(
                  2,
                )}, 浮亏=${shortUnrealizedPnL.toFixed(2)} HKD，最大允许亏损=${
                  this.maxDailyLoss
                } HKD`,
              );
            }

            // 如果浮亏计算结果不是有限数字，拒绝买入操作（安全策略）
            if (!Number.isFinite(shortUnrealizedPnL)) {
              logger.error(
                `[风险检查错误] 做空标的持仓浮亏计算结果无效：${shortUnrealizedPnL}`,
              );
              return {
                allowed: false,
                reason: `做空标的持仓浮亏计算结果无效（${shortUnrealizedPnL}），无法进行风险检查，禁止买入做空标的`,
              };
            }

            // 检查做空标的持仓浮亏是否超过最大允许亏损
            if (shortUnrealizedPnL <= -this.maxDailyLoss) {
              return {
                allowed: false,
                reason: `做空标的持仓浮亏约 ${shortUnrealizedPnL.toFixed(
                  2,
                )} HKD 已超过单日最大亏损限制 ${
                  this.maxDailyLoss
                } HKD，禁止买入做空标的（R1=${r1.toFixed(2)}, R2=${r2.toFixed(
                  2,
                )}, N1=${n1}）`,
              };
            }
          }
        }
      }
    }

    // 检查单标的最大持仓市值限制（适用于所有买入和卖出操作）
    if (
      signal.action === 'BUYCALL' ||
      signal.action === 'SELLCALL' ||
      signal.action === 'BUYPUT' ||
      signal.action === 'SELLPUT'
    ) {
      const positionCheckResult = this._checkPositionNotionalLimit(
        signal,
        positions,
        orderNotional,
        currentPrice,
      );
      if (!positionCheckResult.allowed) {
        return positionCheckResult;
      }
    }

    return { allowed: true };
  }

  /**
   * 检查单标的最大持仓市值限制
   * @private
   */
  private _checkPositionNotionalLimit(
    signal: Signal,
    positions: Position[] | null,
    orderNotional: number,
    currentPrice: number | null,
  ): RiskCheckResult {
    // 验证下单金额有效性
    if (!Number.isFinite(orderNotional) || orderNotional < 0) {
      return {
        allowed: false,
        reason: `计划下单金额无效：${orderNotional}`,
      };
    }

    // 检查下单金额是否超过限制（无持仓时）
    if (this.maxPositionNotional !== null && orderNotional > this.maxPositionNotional) {
      return {
        allowed: false,
        reason: `本次计划下单金额 ${orderNotional.toFixed(
          2,
        )} HKD 超过单标的最大持仓市值限制 ${this.maxPositionNotional} HKD`,
      };
    }

    const symbol = signal.symbol;
    const pos = positions?.find((p) => {
      const posSymbol = normalizeHKSymbol(p.symbol);
      const sigSymbol = normalizeHKSymbol(symbol);
      return posSymbol === sigSymbol;
    });

    // 如果没有持仓，直接通过（下单金额已在上面检查）
    if (!pos?.quantity || pos.quantity <= 0) {
      return { allowed: true };
    }

    // 检查有持仓时的市值限制
    return this._checkPositionWithExistingHoldings(
      pos,
      orderNotional,
      currentPrice,
    );
  }

  /**
   * 检查有持仓时的市值限制
   * @private
   */
  private _checkPositionWithExistingHoldings(
    pos: Position,
    orderNotional: number,
    currentPrice: number | null,
  ): RiskCheckResult {
    // 验证持仓数量有效性
    const posQuantity = Number(pos.quantity) || 0;
    if (!Number.isFinite(posQuantity) || posQuantity <= 0) {
      // 持仓数量无效，只检查下单金额
      if (this.maxPositionNotional !== null && orderNotional > this.maxPositionNotional) {
        return {
          allowed: false,
          reason: `本次计划下单金额 ${orderNotional.toFixed(
            2,
          )} HKD 超过单标的最大持仓市值限制 ${this.maxPositionNotional} HKD`,
        };
      }
      return { allowed: true };
    }

    // 若已有持仓应以成本价计算当前持仓市值（用户要求）
    // 优先使用成本价，如果没有成本价则使用当前市价
    const price = pos.costPrice ?? currentPrice ?? 0;

    // 验证价格有效性
    if (!Number.isFinite(price) || price <= 0) {
      // 价格无效，只检查下单金额
      if (this.maxPositionNotional !== null && orderNotional > this.maxPositionNotional) {
        return {
          allowed: false,
          reason: `本次计划下单金额 ${orderNotional.toFixed(
            2,
          )} HKD 超过单标的最大持仓市值限制 ${this.maxPositionNotional} HKD`,
        };
      }
      return { allowed: true };
    }

    const currentNotional = posQuantity * price;

    // 如果是买入或做空操作，需要加上本次计划下单金额
    const totalNotional = currentNotional + orderNotional;

    if (!Number.isFinite(totalNotional)) {
      return {
        allowed: false,
        reason: `持仓市值计算错误：数量=${posQuantity} × 价格=${price}`,
      };
    }

    if (this.maxPositionNotional !== null && totalNotional > this.maxPositionNotional) {
      return {
        allowed: false,
        reason: `该标的当前持仓市值约 ${currentNotional.toFixed(
          2,
        )} HKD（数量=${posQuantity} × 价格=${price.toFixed(
          3,
        )}），加上本次计划下单 ${orderNotional.toFixed(
          2,
        )} HKD 将超过单标的最大持仓市值限制 ${this.maxPositionNotional} HKD`,
      };
    }

    return { allowed: true };
  }

  /**
   * 检查牛熊证距离回收价的风险（仅在买入前检查）
   * @param symbol 标的代码（牛熊证代码）
   * @param signalType 信号类型（'BUYCALL' 或 'BUYPUT'）
   * @param monitorCurrentPrice 监控标的的当前价格（用于计算距离回收价的百分比）
   * @returns {allowed: boolean, reason?: string, warrantInfo?: Object}
   */
  checkWarrantRisk(
    symbol: string,
    signalType: string,
    monitorCurrentPrice: number,
  ): RiskCheckResult {
    // 确定是做多还是做空标的
    const isLong = signalType === 'BUYCALL';
    const warrantInfo = isLong ? this.longWarrantInfo : this.shortWarrantInfo;

    // 如果没有初始化过牛熊证信息，或者不是牛熊证，允许交易
    if (!warrantInfo?.isWarrant) {
      return { allowed: true };
    }

    // 验证回收价是否有效
    if (!Number.isFinite(warrantInfo.callPrice) || !warrantInfo.callPrice || warrantInfo.callPrice <= 0) {
      logger.warn(
        `[风险检查] ${symbol} 的回收价无效（${warrantInfo.callPrice}），允许交易`,
      );
      return { allowed: true };
    }

    // 验证监控标的的当前价格是否有效
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
    // 如果价格异常小，可能获取到了错误的价格（如牛熊证本身的价格），拒绝买入
    if (monitorCurrentPrice < MIN_MONITOR_PRICE_THRESHOLD) {
      logger.warn(
        `[风险检查] 监控标的价格异常小（${monitorCurrentPrice}），可能获取到了错误的价格（如牛熊证本身的价格），拒绝买入以确保安全`,
      );
      return {
        allowed: false, // 拒绝买入，确保安全
        reason: `监控标的价格异常（${monitorCurrentPrice}），无法进行牛熊证风险检查，拒绝买入`,
      };
    }

    const callPrice = warrantInfo.callPrice;
    const warrantType = warrantInfo.warrantType!;

    // 计算距离回收价的百分比
    // 使用监控标的的当前价格与牛熊证的回收价进行计算
    // 牛证：(监控标的当前价 - 回收价) / 回收价 * 100
    // 熊证：(监控标的当前价 - 回收价) / 回收价 * 100 （结果为负数）
    const distancePercent =
      ((monitorCurrentPrice - callPrice) / callPrice) * 100;

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
  }

  /**
   * 初始化或刷新标的的浮亏监控数据（在程序启动时或买入/卖出操作后调用）
   *
   * 计算方式（开仓成本）：
   * - R1 = 所有未平仓买入订单的市值总和（每个订单市值 = 成交价 × 成交数量）
   * - N1 = 所有未平仓买入订单的成交数量总和
   *
   * 注意：
   * - 程序启动时：调用方需要先调用 orderRecorder.refreshOrders() 刷新订单记录
   * - 交易后：调用方已通过 recordLocalBuy/recordLocalSell 更新了订单记录
   * - 本方法仅从 orderRecorder 中已有的订单列表计算 R1 和 N1，不会重复调用 API
   *
   * @param orderRecorder OrderRecorder实例
   * @param symbol 标的代码
   * @param isLongSymbol 是否为做多标的
   * @returns 返回R1（开仓成本）和N1（持仓数量），如果计算失败返回null
   */
  async refreshUnrealizedLossData(
    orderRecorder: OrderRecorder,
    symbol: string,
    isLongSymbol: boolean,
  ): Promise<{ r1: number; n1: number } | null> {
    // 如果未启用浮亏保护，跳过
    if (
      !this.maxUnrealizedLossPerSymbol ||
      !Number.isFinite(this.maxUnrealizedLossPerSymbol) ||
      this.maxUnrealizedLossPerSymbol <= 0
    ) {
      return null;
    }

    if (!orderRecorder) {
      logger.warn(
        `[浮亏监控] 未提供 OrderRecorder 实例，无法刷新标的 ${symbol} 的浮亏数据`,
      );
      return null;
    }

    try {
      const normalizedSymbol = normalizeHKSymbol(symbol);

      // 直接从 orderRecorder 中已有的订单列表计算开仓成本
      // 调用方需要确保订单记录已经是最新的：
      // - 程序启动时：先调用 orderRecorder.refreshOrders()
      // - 交易后：已通过 recordLocalBuy/recordLocalSell 更新
      const buyOrders = isLongSymbol
        ? orderRecorder._longBuyOrders.filter(
          (o) => o.symbol === normalizedSymbol,
        )
        : orderRecorder._shortBuyOrders.filter(
          (o) => o.symbol === normalizedSymbol,
        );

      // 计算R1（开仓成本）= 所有未平仓买入订单的市值总和
      // 计算N1（持仓数量）= 所有未平仓买入订单的成交数量总和
      let r1 = 0;
      let n1 = 0;
      for (const order of buyOrders) {
        const price = Number(order.executedPrice) || 0;
        const quantity = Number(order.executedQuantity) || 0;
        if (
          Number.isFinite(price) &&
          price > 0 &&
          Number.isFinite(quantity) &&
          quantity > 0
        ) {
          r1 += price * quantity;
          n1 += quantity;
        }
      }

      // 更新缓存
      this.unrealizedLossData.set(normalizedSymbol, {
        r1,
        n1,
        lastUpdateTime: Date.now(),
      });

      const positionType = isLongSymbol ? '做多标的' : '做空标的';
      logger.info(
        `[浮亏监控] ${positionType} ${normalizedSymbol}: R1(开仓成本)=${r1.toFixed(
          2,
        )} HKD, N1(持仓数量)=${n1}, 未平仓订单数=${buyOrders.length}`,
      );

      return { r1, n1 };
    } catch (error) {
      logger.error(
        `[浮亏监控] 刷新标的 ${symbol} 的浮亏数据失败`,
        (error as Error).message || String(error),
      );
      return null;
    }
  }

  /**
   * 检查标的的浮亏是否超过阈值，如果超过则返回清仓信号
   * @param symbol 标的代码
   * @param currentPrice 当前价格
   * @param isLongSymbol 是否为做多标的
   * @returns 返回是否需要清仓
   */
  checkUnrealizedLoss(
    symbol: string,
    currentPrice: number,
    isLongSymbol: boolean,
  ): UnrealizedLossCheckResult {
    // 如果未启用浮亏保护，跳过
    if (
      !this.maxUnrealizedLossPerSymbol ||
      !Number.isFinite(this.maxUnrealizedLossPerSymbol) ||
      this.maxUnrealizedLossPerSymbol <= 0
    ) {
      return { shouldLiquidate: false };
    }

    const normalizedSymbol = normalizeHKSymbol(symbol);

    // 验证当前价格有效性
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      return { shouldLiquidate: false };
    }

    // 获取缓存的浮亏数据
    const lossData = this.unrealizedLossData.get(normalizedSymbol);
    if (!lossData) {
      // 如果没有缓存数据，说明可能还没有初始化
      // 这种情况可能发生在：
      // 1. 程序启动时订单获取失败导致标的被禁用
      // 2. 浮亏监控数据尚未刷新
      logger.warn(
        `[浮亏监控] ${normalizedSymbol} 浮亏数据未初始化，跳过检查（可能是订单获取失败或数据尚未刷新）`,
      );
      return { shouldLiquidate: false };
    }

    const { r1, n1 } = lossData;

    // 如果剩余数量为0或负数，无需清仓
    if (!Number.isFinite(n1) || n1 <= 0) {
      return { shouldLiquidate: false };
    }

    // 计算当前持仓市值R2
    const r2 = currentPrice * n1;

    // 计算浮亏 = R2 - R1
    const unrealizedLoss = r2 - r1;

    // 检查浮亏是否超过阈值（浮亏为负数表示亏损）
    if (unrealizedLoss < -this.maxUnrealizedLossPerSymbol) {
      const positionType = isLongSymbol ? '做多标的' : '做空标的';
      const reason = `[保护性清仓] ${positionType} ${normalizedSymbol} 浮亏=${unrealizedLoss.toFixed(
        2,
      )} HKD 超过阈值 ${this.maxUnrealizedLossPerSymbol} HKD (R1=${r1.toFixed(
        2,
      )}, R2=${r2.toFixed(2)}, N1=${n1})，执行保护性清仓`;

      logger.warn(reason);

      return {
        shouldLiquidate: true,
        reason,
        quantity: n1, // 返回剩余数量，用于清仓
      };
    }

    return { shouldLiquidate: false };
  }
}
