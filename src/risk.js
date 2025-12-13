// 基础风险管理模块：检查最大单日亏损与单标的最大持仓金额
import { TRADING_CONFIG } from "./config/config.trading.js";
import { SignalType, isBuyAction } from "./signalTypes.js";
import { normalizeHKSymbol, decimalToNumber } from "./utils.js";
import { logger } from "./logger.js";

export class RiskChecker {
  constructor({ maxDailyLoss, maxPositionNotional } = {}) {
    this.maxDailyLoss = maxDailyLoss ?? TRADING_CONFIG.maxDailyLoss;
    this.maxPositionNotional =
      maxPositionNotional ?? TRADING_CONFIG.maxPositionNotional;

    // 验证 maxDailyLoss 的有效性
    if (!Number.isFinite(this.maxDailyLoss) || this.maxDailyLoss < 0) {
      logger.warn(
        `[风险检查警告] maxDailyLoss 配置无效（${this.maxDailyLoss}），将使用默认值 0（禁止任何浮亏）`
      );
      this.maxDailyLoss = 0;
    }

    // 牛熊证信息缓存
    this.longWarrantInfo = null; // 做多标的的牛熊证信息
    this.shortWarrantInfo = null; // 做空标的的牛熊证信息
  }

  /**
   * 初始化牛熊证信息（在程序启动时调用）
   * @param {Object} marketDataClient MarketDataClient实例
   * @param {string} longSymbol 做多标的代码
   * @param {string} shortSymbol 做空标的代码
   */
  async initializeWarrantInfo(marketDataClient, longSymbol, shortSymbol) {
    if (!marketDataClient) {
      logger.warn("[风险检查] 未提供 marketDataClient，跳过牛熊证信息初始化");
      return;
    }

    // 初始化做多标的
    if (longSymbol) {
      try {
        const warrantInfo = await this._checkWarrantType(
          marketDataClient,
          longSymbol,
          "CALL"
        );
        this.longWarrantInfo = warrantInfo;

        if (warrantInfo.isWarrant) {
          logger.info(
            `[风险检查] 做多标的 ${longSymbol} 是${
              warrantInfo.warrantType === "BULL"
                ? "牛证"
                : warrantInfo.warrantType === "BEAR"
                ? "熊证"
                : "轮证"
            }，回收价=${warrantInfo.callPrice?.toFixed(3) ?? "未知"}`
          );
        } else {
          logger.info(`[风险检查] 做多标的 ${longSymbol} 不是牛熊证`);
        }
      } catch (err) {
        logger.warn(
          `[风险检查] 检查做多标的牛熊证信息时出错：`,
          err?.message ?? err
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
          "PUT"
        );
        this.shortWarrantInfo = warrantInfo;

        if (warrantInfo.isWarrant) {
          logger.info(
            `[风险检查] 做空标的 ${shortSymbol} 是${
              warrantInfo.warrantType === "BULL"
                ? "牛证"
                : warrantInfo.warrantType === "BEAR"
                ? "熊证"
                : "轮证"
            }，回收价=${warrantInfo.callPrice?.toFixed(3) ?? "未知"}`
          );
        } else {
          logger.info(`[风险检查] 做空标的 ${shortSymbol} 不是牛熊证`);
        }
      } catch (err) {
        logger.warn(
          `[风险检查] 检查做空标的牛熊证信息时出错：`,
          err?.message ?? err
        );
        this.shortWarrantInfo = { isWarrant: false };
      }
    }
  }

  /**
   * 检查标的是否为牛熊证并获取回收价
   * @private
   * @param {Object} marketDataClient MarketDataClient实例
   * @param {string} symbol 标的代码
   * @param {string} expectedType 期望的类型：'CALL'（做多标的期望牛证）或 'PUT'（做空标的期望熊证）
   * @returns {Promise<Object>} { isWarrant: boolean, warrantType: string, callPrice: number, category: string }
   */
  async _checkWarrantType(marketDataClient, symbol, expectedType) {
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
    const category = warrantQuote.category;
    let warrantType = null;

    // 判断牛证：category 可能是数字 3（枚举值）或字符串 "Bull"
    if (category === 3 || category === "Bull" || category === "BULL") {
      warrantType = "BULL";
    }
    // 判断熊证：category 可能是数字 4（枚举值）或字符串 "Bear"
    else if (category === 4 || category === "Bear" || category === "BEAR") {
      warrantType = "BEAR";
    } else {
      // 不是牛熊证（可能是 Call=1, Put=2, Inline=5 或其他类型）
      return { isWarrant: false, category };
    }

    // 获取回收价（call_price 字段）
    const callPriceRaw =
      warrantQuote.call_price ?? warrantQuote.callPrice ?? null;

    // 转换 Decimal 类型为 number（LongPort API 返回的价格字段可能是 Decimal 类型）
    let callPrice = null;
    if (callPriceRaw !== null && callPriceRaw !== undefined) {
      // 如果是 Decimal 对象，使用 decimalToNumber 转换；否则直接使用 Number 转换
      if (typeof callPriceRaw === "object" && "toString" in callPriceRaw) {
        callPrice = decimalToNumber(callPriceRaw);
      } else {
        callPrice = Number(callPriceRaw);
      }
    }

    // 验证：做多标的应该是牛证，做空标的应该是熊证
    const isExpectedType =
      (expectedType === "CALL" && warrantType === "BULL") ||
      (expectedType === "PUT" && warrantType === "BEAR");

    if (!isExpectedType) {
      logger.warn(
        `[风险检查警告] ${symbol} 的牛熊证类型不符合预期：期望${
          expectedType === "CALL" ? "牛证" : "熊证"
        }，实际是${warrantType === "BULL" ? "牛证" : "熊证"}`
      );
    }

    return {
      isWarrant: true,
      warrantType,
      callPrice,
      category,
      symbol: normalizedSymbol,
    };
  }

  /**
   * @param {{totalCash:number, netAssets:number}} account
   * @param {Array<{symbol:string, quantity:number, costPrice:number}>} positions
   * @param {{action:string, symbol:string}} signal 信号对象，action 可以是 BUYCALL, SELLCALL, BUYPUT, SELLPUT, HOLD
   * @param {number} orderNotional 计划下单金额（HKD）
   * @param {number} currentPrice 标的当前市价（用于计算持仓市值，如果未提供则使用成本价）
   */
  checkBeforeOrder(
    account,
    positions,
    signal,
    orderNotional,
    currentPrice = null
  ) {
    // HOLD 信号不需要检查
    if (!signal || signal.action === SignalType.HOLD) {
      return { allowed: true };
    }

    // 判断是否为买入操作
    const isBuy = isBuyAction(signal.action);

    // 对于买入操作，账户数据是必需的（用于浮亏检查）
    if (isBuy && !account) {
      return {
        allowed: false,
        reason: `账户数据不可用，无法进行风险检查，禁止买入操作`,
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

    // 计算浮亏：浮亏 = 持仓市值 - 持仓成本
    // 持仓市值 = 净资产 - 现金
    // 持仓成本 = 所有持仓的 quantity * costPrice 之和
    const positionMarketValue = netAssets - totalCash;

    // 计算总持仓成本
    let totalCost = 0;
    if (Array.isArray(positions) && positions.length > 0) {
      for (const pos of positions) {
        const quantity = Number(pos.quantity) || 0;
        const costPrice = Number(pos.costPrice) || 0;
        if (
          Number.isFinite(quantity) &&
          quantity > 0 &&
          Number.isFinite(costPrice) &&
          costPrice > 0
        ) {
          totalCost += quantity * costPrice;
        }
      }
    }

    // 浮亏 = 持仓市值 - 持仓成本（负数表示浮亏，正数表示浮盈）
    const unrealizedPnL = positionMarketValue - totalCost;

    // 当日浮亏超过 maxDailyLoss 时，停止开新仓（仅对买入操作检查）
    if (isBuy) {
      // 记录浮亏计算详情（仅在DEBUG模式下）
      if (process.env.DEBUG === "true") {
        logger.info(
          `[风险检查调试] 浮亏计算：持仓市值=${positionMarketValue.toFixed(
            2
          )} HKD，持仓成本=${totalCost.toFixed(
            2
          )} HKD，浮亏=${unrealizedPnL.toFixed(2)} HKD，最大允许亏损=${
            this.maxDailyLoss
          } HKD`
        );
      }

      // 如果浮亏计算结果不是有限数字，拒绝买入操作（安全策略）
      if (!Number.isFinite(unrealizedPnL)) {
        // 记录详细的错误信息以便调试
        logger.error(
          `[风险检查错误] 浮亏计算结果无效：持仓市值=${positionMarketValue}, 持仓成本=${totalCost}, 浮亏=${unrealizedPnL}, netAssets=${netAssets}, totalCash=${totalCash}`
        );
        return {
          allowed: false,
          reason: `浮亏计算结果无效（持仓市值=${positionMarketValue}, 持仓成本=${totalCost}, 浮亏=${unrealizedPnL}），无法进行风险检查，禁止买入操作`,
        };
      }

      // 检查浮亏是否超过最大允许亏损
      if (unrealizedPnL <= -this.maxDailyLoss) {
        return {
          allowed: false,
          reason: `当前浮亏约 ${unrealizedPnL.toFixed(
            2
          )} HKD（持仓市值=${positionMarketValue.toFixed(
            2
          )} HKD，持仓成本=${totalCost.toFixed(2)} HKD）已超过单日最大亏损 ${
            this.maxDailyLoss
          } HKD，禁止继续开新仓`,
        };
      }
    }

    // 检查单标的最大持仓市值限制（适用于所有买入和卖出操作）
    if (
      signal.action === SignalType.BUYCALL ||
      signal.action === SignalType.SELLCALL ||
      signal.action === SignalType.BUYPUT ||
      signal.action === SignalType.SELLPUT
    ) {
      const positionCheckResult = this._checkPositionNotionalLimit(
        signal,
        positions,
        orderNotional,
        currentPrice
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
  _checkPositionNotionalLimit(signal, positions, orderNotional, currentPrice) {
    // 验证下单金额有效性
    if (!Number.isFinite(orderNotional) || orderNotional < 0) {
      return {
        allowed: false,
        reason: `计划下单金额无效：${orderNotional}`,
      };
    }

    // 检查下单金额是否超过限制（无持仓时）
    if (orderNotional > this.maxPositionNotional) {
      return {
        allowed: false,
        reason: `本次计划下单金额 ${orderNotional.toFixed(
          2
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
      currentPrice
    );
  }

  /**
   * 检查有持仓时的市值限制
   * @private
   */
  _checkPositionWithExistingHoldings(pos, orderNotional, currentPrice) {
    // 验证持仓数量有效性
    const posQuantity = Number(pos.quantity) || 0;
    if (!Number.isFinite(posQuantity) || posQuantity <= 0) {
      // 持仓数量无效，只检查下单金额
      if (orderNotional > this.maxPositionNotional) {
        return {
          allowed: false,
          reason: `本次计划下单金额 ${orderNotional.toFixed(
            2
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
      if (orderNotional > this.maxPositionNotional) {
        return {
          allowed: false,
          reason: `本次计划下单金额 ${orderNotional.toFixed(
            2
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

    if (totalNotional > this.maxPositionNotional) {
      return {
        allowed: false,
        reason: `该标的当前持仓市值约 ${currentNotional.toFixed(
          2
        )} HKD（数量=${posQuantity} × 价格=${price.toFixed(
          3
        )}），加上本次计划下单 ${orderNotional.toFixed(
          2
        )} HKD 将超过单标的最大持仓市值限制 ${this.maxPositionNotional} HKD`,
      };
    }

    return { allowed: true };
  }

  /**
   * 检查牛熊证距离回收价的风险（仅在买入前检查）
   * @param {string} symbol 标的代码（牛熊证代码）
   * @param {string} signalType 信号类型（SignalType.BUYCALL 或 SignalType.BUYPUT）
   * @param {number} monitorCurrentPrice 监控标的的当前价格（用于计算距离回收价的百分比）
   * @returns {{allowed: boolean, reason?: string, warrantInfo?: Object}}
   */
  checkWarrantRisk(symbol, signalType, monitorCurrentPrice) {
    // 确定是做多还是做空标的
    const isLong = signalType === SignalType.BUYCALL;
    const warrantInfo = isLong ? this.longWarrantInfo : this.shortWarrantInfo;

    // 如果没有初始化过牛熊证信息，或者不是牛熊证，允许交易
    if (!warrantInfo || !warrantInfo.isWarrant) {
      return { allowed: true };
    }

    // 验证回收价是否有效
    if (!Number.isFinite(warrantInfo.callPrice) || warrantInfo.callPrice <= 0) {
      logger.warn(
        `[风险检查] ${symbol} 的回收价无效（${warrantInfo.callPrice}），允许交易`
      );
      return { allowed: true };
    }

    // 验证监控标的的当前价格是否有效
    if (!Number.isFinite(monitorCurrentPrice) || monitorCurrentPrice <= 0) {
      logger.warn(
        `[风险检查] 监控标的的当前价格无效（${monitorCurrentPrice}），无法检查牛熊证风险`
      );
      return {
        allowed: false,
        reason: `监控标的价格无效（${monitorCurrentPrice}），无法进行牛熊证风险检查`,
      };
    }

    // 额外验证：监控标的价格应该远大于牛熊证价格（通常>1000）
    // 如果价格异常小（<1），可能是获取到了错误的价格（如牛熊证本身的价格），拒绝买入
    if (monitorCurrentPrice < 1) {
      logger.warn(
        `[风险检查] 监控标的价格异常小（${monitorCurrentPrice}），可能获取到了错误的价格（如牛熊证本身的价格），拒绝买入以确保安全`
      );
      return {
        allowed: false, // 拒绝买入，确保安全
        reason: `监控标的价格异常（${monitorCurrentPrice}），无法进行牛熊证风险检查，拒绝买入`,
      };
    }

    const callPrice = warrantInfo.callPrice;
    const warrantType = warrantInfo.warrantType;

    // 计算距离回收价的百分比
    // 使用监控标的的当前价格与牛熊证的回收价进行计算
    // 牛证：(监控标的当前价 - 回收价) / 回收价 * 100
    // 熊证：(监控标的当前价 - 回收价) / 回收价 * 100 （结果为负数）
    const distancePercent =
      ((monitorCurrentPrice - callPrice) / callPrice) * 100;

    // 牛证：当距离回收价百分比低于0.5%时停止买入
    if (warrantType === "BULL") {
      if (distancePercent < 0.5) {
        return {
          allowed: false,
          reason: `牛证距离回收价百分比为 ${distancePercent.toFixed(
            2
          )}%，低于0.5%阈值，停止买入（回收价=${callPrice.toFixed(
            3
          )}，监控标的当前价=${monitorCurrentPrice.toFixed(3)}）`,
          warrantInfo: {
            isWarrant: true,
            warrantType,
            distanceToStrikePercent: distancePercent,
          },
        };
      }
    }

    // 熊证：当距离回收价百分比高于-0.5%时停止买入
    if (warrantType === "BEAR") {
      if (distancePercent > -0.5) {
        return {
          allowed: false,
          reason: `熊证距离回收价百分比为 ${distancePercent.toFixed(
            2
          )}%，高于-0.5%阈值，停止买入（回收价=${callPrice.toFixed(
            3
          )}，监控标的当前价=${monitorCurrentPrice.toFixed(3)}）`,
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
        warrantType === "BULL" ? "牛证" : "熊证"
      }距离回收价百分比为 ${distancePercent.toFixed(2)}%，在安全范围内`,
      warrantInfo: {
        isWarrant: true,
        warrantType,
        distanceToStrikePercent: distancePercent,
      },
    };
  }
}
