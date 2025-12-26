/**
 * 信号处理模块
 * 负责信号过滤、风险检查、卖出数量计算等逻辑
 */

import { logger } from "../utils/logger.js";
import { normalizeHKSymbol, getSymbolName } from "../utils/helpers.js";
import { SignalType } from "../utils/constants.js";
import { TRADING_CONFIG } from "../config/config.trading.js";

/**
 * 计算卖出信号的数量和原因（统一处理做多和做空标的的卖出逻辑）
 * @param {Object} position 持仓对象（包含 costPrice 和 availableQuantity）
 * @param {Object} quote 行情对象（包含 price）
 * @param {Object} orderRecorder 订单记录器实例
 * @param {string} direction 方向：'LONG'（做多）或 'SHORT'（做空）
 * @param {string} originalReason 原始信号原因
 * @returns {{quantity: number|null, shouldHold: boolean, reason: string}} 返回卖出数量和原因，shouldHold为true表示应跳过此信号
 */
export function calculateSellQuantity(
  position,
  quote,
  orderRecorder,
  direction,
  originalReason
) {
  // 验证输入参数
  if (
    !position ||
    !Number.isFinite(position.costPrice) ||
    position.costPrice <= 0 ||
    !Number.isFinite(position.availableQuantity) ||
    position.availableQuantity <= 0 ||
    !quote ||
    !Number.isFinite(quote.price) ||
    quote.price <= 0
  ) {
    return {
      quantity: null,
      shouldHold: true,
      reason: `${originalReason || ""}，持仓或行情数据无效`,
    };
  }

  const currentPrice = quote.price;
  const costPrice = position.costPrice;
  const directionName = direction === "LONG" ? "做多标的" : "做空标的";

  // 当前价格高于持仓成本价，立即清仓所有持仓
  if (currentPrice > costPrice) {
    return {
      quantity: position.availableQuantity,
      shouldHold: false,
      reason: `${originalReason || ""}，当前价格${currentPrice.toFixed(
        3
      )}>成本价${costPrice.toFixed(3)}，立即清空所有${directionName}持仓`,
    };
  }

  // 当前价格没有高于持仓成本价，检查历史买入订单
  if (!orderRecorder) {
    return {
      quantity: null,
      shouldHold: true,
      reason: `${
        originalReason || ""
      }，但${directionName}价格${currentPrice.toFixed(
        3
      )}未高于成本价${costPrice.toFixed(3)}，且无法获取订单记录`,
    };
  }

  // 根据方向获取符合条件的买入订单
  const getBuyOrdersBelowPrice =
    direction === "LONG"
      ? orderRecorder.getLongBuyOrdersBelowPrice.bind(orderRecorder)
      : orderRecorder.getShortBuyOrdersBelowPrice.bind(orderRecorder);

  const buyOrdersBelowPrice = getBuyOrdersBelowPrice(currentPrice);

  if (!buyOrdersBelowPrice || buyOrdersBelowPrice.length === 0) {
    // 没有符合条件的订单，跳过此信号
    return {
      quantity: null,
      shouldHold: true,
      reason: `${
        originalReason || ""
      }，但${directionName}价格${currentPrice.toFixed(
        3
      )}未高于成本价${costPrice.toFixed(3)}，且没有买入价低于当前价的历史订单`,
    };
  }

  const totalQuantity =
    orderRecorder.calculateTotalQuantity(buyOrdersBelowPrice);

  if (totalQuantity > 0) {
    // 有符合条件的订单，卖出这些订单
    return {
      quantity: totalQuantity,
      shouldHold: false,
      reason: `${
        originalReason || ""
      }，但${directionName}价格${currentPrice.toFixed(
        3
      )}未高于成本价${costPrice.toFixed(
        3
      )}，卖出历史买入订单中买入价低于当前价的订单，共 ${totalQuantity} 股`,
    };
  } else {
    // 总数量为0，跳过此信号
    return {
      quantity: null,
      shouldHold: true,
      reason: `${
        originalReason || ""
      }，但${directionName}价格${currentPrice.toFixed(
        3
      )}未高于成本价${costPrice.toFixed(3)}，且没有买入价低于当前价的历史订单`,
    };
  }
}

/**
 * 信号处理器类
 * 处理信号的过滤、风险检查、数量计算等逻辑
 */
export class SignalProcessor {
  constructor() {
    // 信号处理器不维护状态，所有状态由外部管理
  }

  /**
   * 处理卖出信号的成本价判断和数量计算
   * @param {Array} signals 信号列表
   * @param {Object} longPosition 做多标的持仓
   * @param {Object} shortPosition 做空标的持仓
   * @param {Object} longQuote 做多标的行情
   * @param {Object} shortQuote 做空标的行情
   * @param {Object} orderRecorder 订单记录器
   * @returns {Array} 处理后的信号列表
   */
  processSellSignals(
    signals,
    longPosition,
    shortPosition,
    longQuote,
    shortQuote,
    orderRecorder
  ) {
    for (const sig of signals) {
      // 检查是否是末日保护程序的清仓信号（无条件清仓，不受成本价判断影响）
      const isDoomsdaySignal =
        sig.reason && sig.reason.includes("末日保护程序");

      if (sig.action === SignalType.SELLCALL) {
        // 卖出做多标的：判断成本价并计算卖出数量
        // 添加调试日志
        if (!longPosition) {
          logger.warn(
            `[卖出信号处理] SELLCALL: 做多标的持仓对象为null，无法计算卖出数量`
          );
        }
        if (!longQuote) {
          logger.warn(
            `[卖出信号处理] SELLCALL: 做多标的行情数据为null，无法计算卖出数量`
          );
        }
        if (longPosition && longQuote) {
          logger.info(
            `[卖出信号处理] SELLCALL: 持仓成本价=${longPosition.costPrice.toFixed(
              3
            )}, 当前价格=${longQuote.price.toFixed(3)}, 可用数量=${
              longPosition.availableQuantity
            }`
          );
        }

        if (isDoomsdaySignal) {
          // 末日保护程序：无条件清仓，使用全部可用数量
          if (longPosition && longPosition.availableQuantity > 0) {
            sig.quantity = longPosition.availableQuantity;
            logger.info(
              `[卖出信号处理] SELLCALL(末日保护): 无条件清仓，卖出数量=${sig.quantity}`
            );
          } else {
            logger.warn(
              `[卖出信号处理] SELLCALL(末日保护): 持仓对象无效，无法清仓`
            );
            sig.action = SignalType.HOLD;
            sig.reason = `${sig.reason}，但持仓对象无效`;
          }
        } else {
          // 正常卖出信号：进行成本价判断
          const result = calculateSellQuantity(
            longPosition,
            longQuote,
            orderRecorder,
            "LONG",
            sig.reason
          );
          if (result.shouldHold) {
            logger.info(`[卖出信号处理] SELLCALL被跳过: ${result.reason}`);
            sig.action = SignalType.HOLD;
            sig.reason = result.reason;
          } else {
            logger.info(
              `[卖出信号处理] SELLCALL通过: 卖出数量=${result.quantity}, 原因=${result.reason}`
            );
            sig.quantity = result.quantity;
            sig.reason = result.reason;
          }
        }
      } else if (sig.action === SignalType.SELLPUT) {
        // 卖出做空标的：判断成本价并计算卖出数量
        // 添加调试日志
        if (!shortPosition) {
          logger.warn(
            `[卖出信号处理] SELLPUT: 做空标的持仓对象为null，无法计算卖出数量`
          );
        }
        if (!shortQuote) {
          logger.warn(
            `[卖出信号处理] SELLPUT: 做空标的行情数据为null，无法计算卖出数量`
          );
        }
        if (shortPosition && shortQuote) {
          logger.info(
            `[卖出信号处理] SELLPUT: 持仓成本价=${shortPosition.costPrice.toFixed(
              3
            )}, 当前价格=${shortQuote.price.toFixed(3)}, 可用数量=${
              shortPosition.availableQuantity
            }`
          );
        }

        if (isDoomsdaySignal) {
          // 末日保护程序：无条件清仓，使用全部可用数量
          if (shortPosition && shortPosition.availableQuantity > 0) {
            sig.quantity = shortPosition.availableQuantity;
            logger.info(
              `[卖出信号处理] SELLPUT(末日保护): 无条件清仓，卖出数量=${sig.quantity}`
            );
          } else {
            logger.warn(
              `[卖出信号处理] SELLPUT(末日保护): 持仓对象无效，无法清仓`
            );
            sig.action = SignalType.HOLD;
            sig.reason = `${sig.reason}，但持仓对象无效`;
          }
        } else {
          // 正常卖出信号：进行成本价判断
          const result = calculateSellQuantity(
            shortPosition,
            shortQuote,
            orderRecorder,
            "SHORT",
            sig.reason
          );
          if (result.shouldHold) {
            logger.info(`[卖出信号处理] SELLPUT被跳过: ${result.reason}`);
            sig.action = SignalType.HOLD;
            sig.reason = result.reason;
          } else {
            logger.info(
              `[卖出信号处理] SELLPUT通过: 卖出数量=${result.quantity}, 原因=${result.reason}`
            );
            sig.quantity = result.quantity;
            sig.reason = result.reason;
          }
        }
      }
    }

    return signals;
  }

  /**
   * 应用风险检查到信号列表
   * @param {Array} signals 信号列表
   * @param {Object} context 上下文对象（包含所有需要的参数）
   * @returns {Promise<Array>} 通过风险检查的信号列表
   */
  async applyRiskChecks(signals, context) {
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

    const finalSignals = [];

    for (const sig of signals) {
      const normalizedSigSymbol = sig.symbol;
      const sigName = getSymbolName(
        sig.symbol,
        longSymbol,
        shortSymbol,
        longSymbolName,
        shortSymbolName
      );

      // 0. 检查标的是否因订单获取失败而被禁用交易
      if (orderRecorder.isSymbolDisabled(normalizedSigSymbol)) {
        logger.warn(
          `[交易禁用] 标的 ${normalizedSigSymbol} 因订单获取失败已被禁用交易，跳过信号：${sigName} ${sig.action}`
        );
        continue;
      }

      // 获取标的的当前价格用于计算持仓市值
      let currentPrice = null;
      if (normalizedSigSymbol === normalizedLongSymbol && longQuote) {
        currentPrice = longQuote.price;
      } else if (normalizedSigSymbol === normalizedShortSymbol && shortQuote) {
        currentPrice = shortQuote.price;
      }

      // 检查是否是买入操作
      const isBuyAction =
        sig.action === SignalType.BUYCALL || sig.action === SignalType.BUYPUT;

      if (isBuyAction) {
        // 买入操作检查顺序：
        // 1. 交易频率限制
        // 2. 买入价格限制
        // 3. 末日保护程序
        // 4. 牛熊证风险
        // 5. 基础风险检查

        // 1. 检查交易频率限制
        if (!trader._canTradeNow(sig.action)) {
          const direction =
            sig.action === SignalType.BUYCALL ? "做多标的" : "做空标的";
          const directionKey =
            sig.action === SignalType.BUYCALL ? "LONG" : "SHORT";
          const lastTime = trader._lastBuyTime.get(directionKey);
          const intervalMs = TRADING_CONFIG.buyIntervalSeconds * 1000;
          const waitSeconds = lastTime
            ? Math.ceil((intervalMs - (Date.now() - lastTime)) / 1000)
            : 0;
          logger.warn(
            `[交易频率限制] ${direction} 在${TRADING_CONFIG.buyIntervalSeconds}秒内已买入过，需等待 ${waitSeconds} 秒后才能再次买入：${sigName}(${normalizedSigSymbol}) ${sig.action}`
          );
          continue;
        }

        // 2. 买入价格限制
        const isLongBuyAction = sig.action === SignalType.BUYCALL;
        const latestBuyPrice = orderRecorder.getLatestBuyOrderPrice(
          normalizedSigSymbol,
          isLongBuyAction
        );

        if (latestBuyPrice !== null && currentPrice !== null) {
          if (currentPrice > latestBuyPrice) {
            const direction = isLongBuyAction ? "做多标的" : "做空标的";
            logger.warn(
              `[买入价格限制] ${direction} 当前价格 ${currentPrice.toFixed(
                3
              )} 高于最新买入订单价格 ${latestBuyPrice.toFixed(
                3
              )}，拒绝买入：${sigName}(${normalizedSigSymbol}) ${sig.action}`
            );
            continue;
          } else {
            const direction = isLongBuyAction ? "做多标的" : "做空标的";
            logger.info(
              `[买入价格限制] ${direction} 当前价格 ${currentPrice.toFixed(
                3
              )} 低于或等于最新买入订单价格 ${latestBuyPrice.toFixed(
                3
              )}，允许买入：${sigName}(${normalizedSigSymbol}) ${sig.action}`
            );
          }
        }

        // 3. 末日保护程序：收盘前15分钟拒绝买入
        if (
          TRADING_CONFIG.doomsdayProtection &&
          doomsdayProtection.shouldRejectBuy(currentTime, isHalfDay)
        ) {
          const closeTimeRange = isHalfDay ? "11:45-12:00" : "15:45-16:00";
          logger.warn(
            `[末日保护程序] 收盘前15分钟内拒绝买入：${sigName}(${normalizedSigSymbol}) ${sig.action} - 当前时间在${closeTimeRange}范围内`
          );
          continue;
        }

        // 4. 检查牛熊证风险
        const monitorCurrentPrice =
          monitorQuote?.price ?? monitorSnapshot?.price ?? null;

        const warrantRiskResult = riskChecker.checkWarrantRisk(
          sig.symbol,
          sig.action,
          monitorCurrentPrice
        );

        if (!warrantRiskResult.allowed) {
          logger.warn(
            `[牛熊证风险拦截] 信号被牛熊证风险控制拦截：${sigName}(${normalizedSigSymbol}) ${sig.action} - ${warrantRiskResult.reason}`
          );
          continue;
        } else if (warrantRiskResult.warrantInfo?.isWarrant) {
          const warrantType =
            warrantRiskResult.warrantInfo.warrantType === "BULL"
              ? "牛证"
              : "熊证";
          const distancePercent =
            warrantRiskResult.warrantInfo.distanceToStrikePercent;
          logger.info(
            `[牛熊证风险检查] ${
              sig.symbol
            } 为${warrantType}，距离回收价百分比：${
              distancePercent?.toFixed(2) ?? "未知"
            }%，风险检查通过`
          );
        }
      }

      // 5. 基础风险检查（买入操作需要实时数据，卖出操作可用缓存）
      let accountForRiskCheck = account;
      let positionsForRiskCheck = positions;

      // 对于买入操作，总是实时获取最新数据
      if (
        isBuyAction ||
        !accountForRiskCheck ||
        !positionsForRiskCheck ||
        positionsForRiskCheck.length === 0
      ) {
        try {
          const freshAccount = await trader
            .getAccountSnapshot()
            .catch((err) => {
              logger.warn("风险检查前获取账户信息失败", err?.message ?? err);
              return null;
            });
          const freshPositions = await trader
            .getStockPositions()
            .catch((err) => {
              logger.warn("风险检查前获取持仓信息失败", err?.message ?? err);
              return [];
            });

          if (freshAccount) {
            accountForRiskCheck = freshAccount;
            lastState.cachedAccount = freshAccount;
          } else if (isBuyAction) {
            logger.warn(
              "[风险检查] 买入操作前无法获取最新账户信息，风险检查将拒绝该操作"
            );
          }

          if (Array.isArray(freshPositions)) {
            if (isBuyAction || freshPositions.length > 0) {
              positionsForRiskCheck = freshPositions;
              lastState.cachedPositions = freshPositions;
            }
          } else if (isBuyAction) {
            positionsForRiskCheck = [];
            lastState.cachedPositions = [];
          }
        } catch (err) {
          logger.warn("风险检查前获取账户和持仓信息失败", err?.message ?? err);
        }
      }

      // 基础风险检查
      const orderNotional = TRADING_CONFIG.targetNotional;
      const longCurrentPrice = longQuote?.price ?? null;
      const shortCurrentPrice = shortQuote?.price ?? null;
      const riskResult = riskChecker.checkBeforeOrder(
        accountForRiskCheck,
        positionsForRiskCheck,
        sig,
        orderNotional,
        currentPrice,
        longCurrentPrice,
        shortCurrentPrice
      );

      if (riskResult.allowed) {
        finalSignals.push(sig);
      } else {
        logger.warn(
          `[风险拦截] 信号被风险控制拦截：${sigName}(${normalizedSigSymbol}) ${sig.action} - ${riskResult.reason}`
        );
      }
    }

    return finalSignals;
  }
}
