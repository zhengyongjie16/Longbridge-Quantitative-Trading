/**
 * 信号处理模块
 *
 * 功能：
 * - 对生成的信号进行过滤和风险检查
 * - 计算卖出信号的数量和清仓策略
 * - 实施交易频率限制
 *
 * 买入检查顺序：
 * 1. 交易频率限制（同方向买入时间间隔）
 * 2. 买入价格限制（防止追高）
 * 3. 末日保护程序（收盘前 15 分钟拒绝买入）
 * 4. 牛熊证风险检查
 * 5. 基础风险检查（浮亏和持仓限制）
 *
 * 卖出策略：
 * - currentPrice > costPrice：清空所有持仓
 * - currentPrice ≤ costPrice：仅卖出盈利部分订单
 * - 无符合条件订单：信号设为 HOLD
 */

import { logger } from '../../utils/logger.js';
import { normalizeHKSymbol, getSymbolName, getDirectionName } from '../../utils/helpers.js';
import { TRADING_CONFIG } from '../../config/config.trading.js';
import type { Quote, Position, Signal } from '../../types/index.js';
import type { OrderRecorder } from '../orderRecorder/index.js';
import type { RiskCheckContext, SellQuantityResult, SignalProcessor, SignalProcessorDeps } from './type.js';

/**
 * 计算卖出信号的数量和原因
 * 统一处理做多和做空标的的卖出逻辑
 *
 * 卖出策略规则：
 * 1. 如果当前价格 > 持仓成本价：立即清仓所有持仓
 * 2. 如果当前价格 <= 持仓成本价：仅卖出买入价低于当前价的历史订单（盈利部分）
 * 3. 如果没有符合条件的订单或数据无效：跳过此信号（shouldHold=true）
 *
 * @param position - 持仓对象，包含：
 *   - costPrice: number 持仓成本价
 *   - availableQuantity: number 可用持仓数量
 * @param quote - 行情对象，包含：
 *   - price: number 当前价格
 * @param orderRecorder - 订单记录器实例，用于查询历史买入订单
 * @param direction - 方向标识，'LONG' 表示做多标的，'SHORT' 表示做空标的
 * @param originalReason - 原始信号的原因描述
 * @returns 计算结果对象，包含：
 *   - quantity: number|null 建议卖出的数量，null 表示不卖出
 *   - shouldHold: boolean true 表示应跳过此信号，false 表示应执行卖出
 *   - reason: string 执行或跳过的原因描述
 */
export function calculateSellQuantity(
  position: Position | null,
  quote: Quote | null,
  orderRecorder: OrderRecorder | null,
  direction: 'LONG' | 'SHORT',
  originalReason: string,
): SellQuantityResult {
  // 验证输入参数
  if (
    !position ||
    !Number.isFinite(position.costPrice) ||
    position.costPrice === null ||
    position.costPrice <= 0 ||
    !Number.isFinite(position.availableQuantity) ||
    position.availableQuantity === null ||
    position.availableQuantity <= 0 ||
    !quote ||
    !Number.isFinite(quote.price) ||
    quote.price === null ||
    quote.price <= 0
  ) {
    return {
      quantity: null,
      shouldHold: true,
      reason: `${originalReason || ''}，持仓或行情数据无效`,
    };
  }

  const currentPrice = quote.price;
  const costPrice = position.costPrice;
  const directionName = getDirectionName(direction === 'LONG');

  // 当前价格高于持仓成本价，立即清仓所有持仓
  if (currentPrice > costPrice) {
    return {
      quantity: position.availableQuantity,
      shouldHold: false,
      reason: `${originalReason || ''}，当前价格${currentPrice.toFixed(
        3,
      )}>成本价${costPrice.toFixed(3)}，立即清空所有${directionName}持仓`,
    };
  }

  // 当前价格没有高于持仓成本价，检查历史买入订单
  if (!orderRecorder) {
    return {
      quantity: null,
      shouldHold: true,
      reason: `${
        originalReason || ''
      }，但${directionName}价格${currentPrice.toFixed(
        3,
      )}未高于成本价${costPrice.toFixed(3)}，且无法获取订单记录`,
    };
  }

  // 根据方向获取符合条件的买入订单
  const buyOrdersBelowPrice = orderRecorder.getBuyOrdersBelowPrice(
    currentPrice,
    direction,
  );

  if (!buyOrdersBelowPrice || buyOrdersBelowPrice.length === 0) {
    // 没有符合条件的订单，跳过此信号
    return {
      quantity: null,
      shouldHold: true,
      reason: `${
        originalReason || ''
      }，但${directionName}价格${currentPrice.toFixed(
        3,
      )}未高于成本价${costPrice.toFixed(3)}，且没有买入价低于当前价的历史订单`,
    };
  }

  let totalQuantity =
    orderRecorder.calculateTotalQuantity(buyOrdersBelowPrice);

  // 卖出数量不能超过可用持仓数量
  if (totalQuantity > position.availableQuantity) {
    totalQuantity = position.availableQuantity;
  }

  if (totalQuantity > 0) {
    // 有符合条件的订单，卖出这些订单
    return {
      quantity: totalQuantity,
      shouldHold: false,
      reason: `${
        originalReason || ''
      }，但${directionName}价格${currentPrice.toFixed(
        3,
      )}未高于成本价${costPrice.toFixed(
        3,
      )}，卖出历史买入订单中买入价低于当前价的订单，共 ${totalQuantity} 股`,
    };
  } else {
    // 总数量为0，跳过此信号
    return {
      quantity: null,
      shouldHold: true,
      reason: `${
        originalReason || ''
      }，但${directionName}价格${currentPrice.toFixed(
        3,
      )}未高于成本价${costPrice.toFixed(3)}，且没有买入价低于当前价的历史订单`,
    };
  }
}

/**
 * 创建信号处理器
 * @param _deps 依赖注入（当前为空）
 * @returns SignalProcessor 接口实例
 */
export const createSignalProcessor = (_deps: SignalProcessorDeps = {}): SignalProcessor => {
  /**
   * 处理卖出信号的成本价判断和数量计算
   */
  const processSellSignals = (
    signals: Signal[],
    longPosition: Position | null,
    shortPosition: Position | null,
    longQuote: Quote | null,
    shortQuote: Quote | null,
    orderRecorder: OrderRecorder,
  ): Signal[] => {
    for (const sig of signals) {
      // 只处理卖出信号（SELLCALL 和 SELLPUT），跳过买入信号
      if (sig.action !== 'SELLCALL' && sig.action !== 'SELLPUT') {
        continue;
      }

      // 根据信号类型确定对应的持仓和行情
      const isLongSignal = sig.action === 'SELLCALL';
      const position = isLongSignal ? longPosition : shortPosition;
      const quote = isLongSignal ? longQuote : shortQuote;
      const direction: 'LONG' | 'SHORT' = isLongSignal ? 'LONG' : 'SHORT';
      const signalName = isLongSignal ? 'SELLCALL' : 'SELLPUT';

      // 检查是否是末日保护程序的清仓信号（无条件清仓，不受成本价判断影响）
      const isDoomsdaySignal =
        sig.reason?.includes('末日保护程序');

      // 添加调试日志
      if (!position) {
        logger.warn(
          `[卖出信号处理] ${signalName}: ${direction === 'LONG' ? '做多' : '做空'}标的持仓对象为null，无法计算卖出数量`,
        );
      }
      if (!quote) {
        logger.warn(
          `[卖出信号处理] ${signalName}: ${direction === 'LONG' ? '做多' : '做空'}标的行情数据为null，无法计算卖出数量`,
        );
      }
      if (position && quote && position.costPrice !== null && quote.price !== null) {
        logger.info(
          `[卖出信号处理] ${signalName}: 持仓成本价=${position.costPrice.toFixed(
            3,
          )}, 当前价格=${quote.price.toFixed(3)}, 可用数量=${
            position.availableQuantity
          }`,
        );
      }

      if (isDoomsdaySignal) {
        // 末日保护程序：无条件清仓，使用全部可用数量
        if (position && position.availableQuantity !== null && position.availableQuantity > 0) {
          sig.quantity = position.availableQuantity;
          logger.info(
            `[卖出信号处理] ${signalName}(末日保护): 无条件清仓，卖出数量=${sig.quantity}`,
          );
        } else {
          logger.warn(
            `[卖出信号处理] ${signalName}(末日保护): 持仓对象无效，无法清仓`,
          );
          sig.action = 'HOLD';
          sig.reason = `${sig.reason}，但持仓对象无效`;
        }
      } else {
        // 正常卖出信号：进行成本价判断
        const result = calculateSellQuantity(
          position,
          quote,
          orderRecorder,
          direction,
          sig.reason || '',
        );
        if (result.shouldHold) {
          logger.info(`[卖出信号处理] ${signalName}被跳过: ${result.reason}`);
          sig.action = 'HOLD';
          sig.reason = result.reason;
        } else {
          logger.info(
            `[卖出信号处理] ${signalName}通过: 卖出数量=${result.quantity}, 原因=${result.reason}`,
          );
          sig.quantity = result.quantity;
          sig.reason = result.reason;
        }
      }
    }

    return signals;
  };

  /**
   * 应用风险检查到信号列表
   */
  const applyRiskChecks = async (signals: Signal[], context: RiskCheckContext): Promise<Signal[]> => {
    const {
      trader,
      riskChecker,
      orderRecorder,
      longQuote,
      shortQuote,
      monitorQuote,
      monitorSnapshot,
      longSymbol,
      shortSymbol,
      longSymbolName,
      shortSymbolName,
      account,
      positions,
      lastState,
      currentTime,
      isHalfDay,
      doomsdayProtection,
    } = context;

    const normalizedLongSymbol = normalizeHKSymbol(longSymbol);
    const normalizedShortSymbol = normalizeHKSymbol(shortSymbol);

    const finalSignals: Signal[] = [];

    for (const sig of signals) {
      const normalizedSigSymbol = sig.symbol;
      const sigName = getSymbolName(
        sig.symbol,
        longSymbol,
        shortSymbol,
        longSymbolName,
        shortSymbolName,
      );

      // 获取标的的当前价格用于计算持仓市值
      let currentPrice: number | null = null;
      if (normalizedSigSymbol === normalizedLongSymbol && longQuote) {
        currentPrice = longQuote.price;
      } else if (normalizedSigSymbol === normalizedShortSymbol && shortQuote) {
        currentPrice = shortQuote.price;
      }

      // 检查是否是买入操作
      const isBuyActionCheck =
        sig.action === 'BUYCALL' || sig.action === 'BUYPUT';

      if (isBuyActionCheck) {
        // 买入操作检查顺序：
        // 1. 交易频率限制
        // 2. 买入价格限制
        // 3. 末日保护程序
        // 4. 牛熊证风险
        // 5. 基础风险检查

        // 1. 检查交易频率限制
        const tradeCheck = trader._canTradeNow(sig.action);
        if (!tradeCheck.canTrade) {
          const direction =
            sig.action === 'BUYCALL' ? '做多标的' : '做空标的';
          logger.warn(
            `[交易频率限制] ${direction} 在${TRADING_CONFIG.buyIntervalSeconds}秒内已买入过，需等待 ${tradeCheck.waitSeconds ?? 0} 秒后才能再次买入：${sigName}(${normalizedSigSymbol}) ${sig.action}`,
          );
          continue;
        }

        // 2. 买入价格限制
        const isLongBuyAction = sig.action === 'BUYCALL';
        const latestBuyPrice = orderRecorder.getLatestBuyOrderPrice(
          normalizedSigSymbol,
          isLongBuyAction,
        );

        if (latestBuyPrice !== null && currentPrice !== null) {
          if (currentPrice > latestBuyPrice) {
            const direction = isLongBuyAction ? '做多标的' : '做空标的';
            logger.warn(
              `[买入价格限制] ${direction} 当前价格 ${currentPrice.toFixed(
                3,
              )} 高于最新买入订单价格 ${latestBuyPrice.toFixed(
                3,
              )}，拒绝买入：${sigName}(${normalizedSigSymbol}) ${sig.action}`,
            );
            continue;
          } else {
            const direction = isLongBuyAction ? '做多标的' : '做空标的';
            logger.info(
              `[买入价格限制] ${direction} 当前价格 ${currentPrice.toFixed(
                3,
              )} 低于或等于最新买入订单价格 ${latestBuyPrice.toFixed(
                3,
              )}，允许买入：${sigName}(${normalizedSigSymbol}) ${sig.action}`,
            );
          }
        }

        // 3. 末日保护程序：收盘前15分钟拒绝买入
        if (
          TRADING_CONFIG.doomsdayProtection &&
          doomsdayProtection.shouldRejectBuy(currentTime, isHalfDay)
        ) {
          const closeTimeRange = isHalfDay ? '11:45-12:00' : '15:45-16:00';
          logger.warn(
            `[末日保护程序] 收盘前15分钟内拒绝买入：${sigName}(${normalizedSigSymbol}) ${sig.action} - 当前时间在${closeTimeRange}范围内`,
          );
          continue;
        }

        // 4. 检查牛熊证风险
        const monitorCurrentPrice =
          monitorQuote?.price ?? monitorSnapshot?.price ?? null;

        const warrantRiskResult = riskChecker.checkWarrantRisk(
          sig.symbol,
          sig.action,
          monitorCurrentPrice ?? 0,
        );

        if (!warrantRiskResult.allowed) {
          logger.warn(
            `[牛熊证风险拦截] 信号被牛熊证风险控制拦截：${sigName}(${normalizedSigSymbol}) ${sig.action} - ${warrantRiskResult.reason}`,
          );
          continue;
        } else if (warrantRiskResult.warrantInfo?.isWarrant) {
          const warrantType =
            warrantRiskResult.warrantInfo.warrantType === 'BULL'
              ? '牛证'
              : '熊证';
          const distancePercent =
            warrantRiskResult.warrantInfo.distanceToStrikePercent;
          logger.info(
            `[牛熊证风险检查] ${
              sig.symbol
            } 为${warrantType}，距离回收价百分比：${
              distancePercent?.toFixed(2) ?? '未知'
            }%，风险检查通过`,
          );
        }
      }

      // 5. 基础风险检查（买入操作需要实时数据，卖出操作可用缓存）
      let accountForRiskCheck = account;
      let positionsForRiskCheck = positions;

      // 对于买入操作，总是实时获取最新数据
      if (
        isBuyActionCheck ||
        !accountForRiskCheck ||
        !positionsForRiskCheck ||
        positionsForRiskCheck.length === 0
      ) {
        try {
          // 并行获取账户信息和持仓信息，减少等待时间
          const [freshAccount, freshPositions] = await Promise.all([
            trader.getAccountSnapshot().catch((err) => {
              logger.warn(
                '风险检查前获取账户信息失败',
                (err as Error)?.message ?? String(err),
              );
              return null;
            }),
            trader.getStockPositions().catch((err) => {
              logger.warn(
                '风险检查前获取持仓信息失败',
                (err as Error)?.message ?? String(err),
              );
              return [];
            }),
          ]);

          if (freshAccount) {
            accountForRiskCheck = freshAccount;
            lastState.cachedAccount = freshAccount;
          } else if (isBuyActionCheck) {
            logger.warn(
              '[风险检查] 买入操作前无法获取最新账户信息，风险检查将拒绝该操作',
            );
            // 买入操作无法获取账户信息，跳过此信号，继续处理下一个信号
            continue;
          }

          if (Array.isArray(freshPositions)) {
            if (isBuyActionCheck || freshPositions.length > 0) {
              positionsForRiskCheck = freshPositions;
              lastState.cachedPositions = freshPositions;
            }
          } else if (isBuyActionCheck) {
            positionsForRiskCheck = [];
            lastState.cachedPositions = [];
          }
        } catch (err) {
          logger.warn(
            '风险检查前获取账户和持仓信息失败',
            (err as Error)?.message ?? String(err),
          );
        }
      }

      // 基础风险检查
      const orderNotional = TRADING_CONFIG.targetNotional ?? 0;
      const longCurrentPrice = longQuote?.price ?? null;
      const shortCurrentPrice = shortQuote?.price ?? null;
      const riskResult = riskChecker.checkBeforeOrder(
        accountForRiskCheck,
        positionsForRiskCheck,
        sig,
        orderNotional,
        currentPrice,
        longCurrentPrice,
        shortCurrentPrice,
      );

      if (riskResult.allowed) {
        finalSignals.push(sig);
      } else {
        logger.warn(
          `[风险拦截] 信号被风险控制拦截：${sigName}(${normalizedSigSymbol}) ${sig.action} - ${riskResult.reason}`,
        );
      }
    }

    return finalSignals;
  };

  return {
    processSellSignals,
    applyRiskChecks,
  };
};

// 导出类型
export type { SignalProcessor } from './type.js';
