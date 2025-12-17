// 基础风险管理模块：检查最大单日亏损与单标的最大持仓金额
import { TRADING_CONFIG } from "./config/config.trading.js";
import { SignalType, isBuyAction } from "./signalTypes.js";
import { normalizeHKSymbol, decimalToNumber } from "./utils.js";
import { logger } from "./logger.js";

export class RiskChecker {
  constructor({
    maxDailyLoss,
    maxPositionNotional,
    maxUnrealizedLossPerSymbol,
  } = {}) {
    this.maxDailyLoss = maxDailyLoss ?? TRADING_CONFIG.maxDailyLoss;
    this.maxPositionNotional =
      maxPositionNotional ?? TRADING_CONFIG.maxPositionNotional;
    this.maxUnrealizedLossPerSymbol =
      maxUnrealizedLossPerSymbol ?? TRADING_CONFIG.maxUnrealizedLossPerSymbol;

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

    // 浮亏监控数据缓存（用于实时监控）
    // 格式：{ symbol: { r1: number, n1: number, lastUpdateTime: number } }
    this.unrealizedLossData = new Map();
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
   * @param {number} longCurrentPrice 做多标的的当前市价（用于计算做多标的持仓浮亏）
   * @param {number} shortCurrentPrice 做空标的的当前市价（用于计算做空标的持仓浮亏）
   */
  checkBeforeOrder(
    account,
    positions,
    signal,
    orderNotional,
    currentPrice = null,
    longCurrentPrice = null,
    shortCurrentPrice = null
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

    // 当日浮亏超过 maxDailyLoss 时，停止开新仓（仅对买入操作检查）
    // 分别计算做多标的和做空标的的持仓浮亏，并分别进行拦截检查
    if (isBuy) {
      // 获取做多和做空标的的符号
      const longSymbol = TRADING_CONFIG.longSymbol
        ? normalizeHKSymbol(TRADING_CONFIG.longSymbol)
        : null;
      const shortSymbol = TRADING_CONFIG.shortSymbol
        ? normalizeHKSymbol(TRADING_CONFIG.shortSymbol)
        : null;

      // 判断当前信号是做多还是做空
      const isBuyCall = signal.action === SignalType.BUYCALL;
      const isBuyPut = signal.action === SignalType.BUYPUT;

      // 计算做多标的持仓浮亏
      let longUnrealizedPnL = 0;
      if (longSymbol) {
        const longPosition = Array.isArray(positions)
          ? positions.find((pos) => {
              const posSymbol = normalizeHKSymbol(pos.symbol);
              return posSymbol === longSymbol;
            })
          : null;

        if (longPosition) {
          const quantity = Number(longPosition.quantity) || 0;
          const costPrice = Number(longPosition.costPrice) || 0;
          const currentPrice =
            Number.isFinite(longCurrentPrice) && longCurrentPrice > 0
              ? longCurrentPrice
              : costPrice; // 如果没有当前价格，使用成本价（此时浮亏为0）

          if (
            Number.isFinite(quantity) &&
            quantity > 0 &&
            Number.isFinite(costPrice) &&
            costPrice > 0 &&
            Number.isFinite(currentPrice) &&
            currentPrice > 0
          ) {
            // 做多标的持仓浮亏 = 持仓数量 × (当前价格 - 成本价)
            longUnrealizedPnL = quantity * (currentPrice - costPrice);
          }
        }
      }

      // 计算做空标的持仓浮亏
      let shortUnrealizedPnL = 0;
      if (shortSymbol) {
        const shortPosition = Array.isArray(positions)
          ? positions.find((pos) => {
              const posSymbol = normalizeHKSymbol(pos.symbol);
              return posSymbol === shortSymbol;
            })
          : null;

        if (shortPosition) {
          const quantity = Number(shortPosition.quantity) || 0;
          const costPrice = Number(shortPosition.costPrice) || 0;
          const currentPrice =
            Number.isFinite(shortCurrentPrice) && shortCurrentPrice > 0
              ? shortCurrentPrice
              : costPrice; // 如果没有当前价格，使用成本价（此时浮亏为0）

          if (
            Number.isFinite(quantity) &&
            quantity > 0 &&
            Number.isFinite(costPrice) &&
            costPrice > 0 &&
            Number.isFinite(currentPrice) &&
            currentPrice > 0
          ) {
            // 做空标的持仓浮亏 = 持仓数量 × (当前价格 - 成本价)
            shortUnrealizedPnL = quantity * (currentPrice - costPrice);
          }
        }
      }

      // 记录浮亏计算详情（仅在DEBUG模式下）
      if (process.env.DEBUG === "true") {
        logger.info(
          `[风险检查调试] 做多标的持仓浮亏=${longUnrealizedPnL.toFixed(
            2
          )} HKD，做空标的持仓浮亏=${shortUnrealizedPnL.toFixed(
            2
          )} HKD，最大允许亏损=${this.maxDailyLoss} HKD`
        );
      }

      // 检查做多标的买入：若做多标的持仓浮亏超过最大限制应拦截做多标的买入
      if (isBuyCall) {
        // 如果做多标的持仓浮亏计算结果不是有限数字，拒绝买入操作（安全策略）
        if (!Number.isFinite(longUnrealizedPnL)) {
          logger.error(
            `[风险检查错误] 做多标的持仓浮亏计算结果无效：${longUnrealizedPnL}`
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
              2
            )} HKD 已超过单标的最大浮亏限制 ${
              this.maxDailyLoss
            } HKD，禁止买入做多标的`,
          };
        }
      }

      // 检查做空标的买入：若做空标的持仓浮亏超过最大限制应拦截做空标的买入
      if (isBuyPut) {
        // 如果做空标的持仓浮亏计算结果不是有限数字，拒绝买入操作（安全策略）
        if (!Number.isFinite(shortUnrealizedPnL)) {
          logger.error(
            `[风险检查错误] 做空标的持仓浮亏计算结果无效：${shortUnrealizedPnL}`
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
              2
            )} HKD 已超过单标的最大浮亏限制 ${
              this.maxDailyLoss
            } HKD，禁止买入做空标的`,
          };
        }
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

  /**
   * 初始化或刷新标的的浮亏监控数据（在程序启动时或买入/卖出操作后调用）
   * @param {Object} orderRecorder OrderRecorder实例
   * @param {string} symbol 标的代码
   * @param {boolean} isLongSymbol 是否为做多标的
   * @param {boolean} forceRefresh 是否强制刷新订单数据，默认false（使用缓存）。保护性清仓后应设为true
   * @returns {Promise<{r1: number, n1: number}|null>} 返回R1（成本市值）和N1（剩余数量），如果计算失败返回null
   */
  async refreshUnrealizedLossData(
    orderRecorder,
    symbol,
    isLongSymbol,
    forceRefresh = false
  ) {
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
        `[浮亏监控] 未提供 OrderRecorder 实例，无法刷新标的 ${symbol} 的浮亏数据`
      );
      return null;
    }

    try {
      const normalizedSymbol = normalizeHKSymbol(symbol);
      // 根据参数决定是否强制刷新：保护性清仓后需要强制刷新，启动时可以使用缓存
      const { buyOrders, sellOrders } =
        await orderRecorder.getAllOrdersForValueCalculation(
          symbol,
          forceRefresh
        );

      // 计算全部买入订单的市值和数量
      let totalBuyNotional = 0;
      let totalBuyQuantity = 0;
      for (const order of buyOrders) {
        const price = Number(order.executedPrice) || 0;
        const quantity = Number(order.executedQuantity) || 0;
        if (
          Number.isFinite(price) &&
          price > 0 &&
          Number.isFinite(quantity) &&
          quantity > 0
        ) {
          totalBuyNotional += price * quantity;
          totalBuyQuantity += quantity;
        }
      }

      // 计算全部卖出订单的市值和数量
      let totalSellNotional = 0;
      let totalSellQuantity = 0;
      for (const order of sellOrders) {
        const price = Number(order.executedPrice) || 0;
        const quantity = Number(order.executedQuantity) || 0;
        if (
          Number.isFinite(price) &&
          price > 0 &&
          Number.isFinite(quantity) &&
          quantity > 0
        ) {
          totalSellNotional += price * quantity;
          totalSellQuantity += quantity;
        }
      }

      // 计算R1（成本市值，允许为负值）和N1（剩余数量）
      const r1 = totalBuyNotional - totalSellNotional;
      const n1 = totalBuyQuantity - totalSellQuantity;

      // 更新缓存
      this.unrealizedLossData.set(normalizedSymbol, {
        r1,
        n1,
        lastUpdateTime: Date.now(),
      });

      const positionType = isLongSymbol ? "做多标的" : "做空标的";
      logger.info(
        `[浮亏监控] ${positionType} ${normalizedSymbol}: R1(成本市值)=${r1.toFixed(
          2
        )} HKD, N1(剩余数量)=${n1}`
      );

      return { r1, n1 };
    } catch (error) {
      logger.error(
        `[浮亏监控] 刷新标的 ${symbol} 的浮亏数据失败`,
        error.message || error
      );
      return null;
    }
  }

  /**
   * 检查标的的浮亏是否超过阈值，如果超过则返回清仓信号
   * @param {string} symbol 标的代码
   * @param {number} currentPrice 当前价格
   * @param {boolean} isLongSymbol 是否为做多标的
   * @returns {{shouldLiquidate: boolean, reason?: string, quantity?: number}} 返回是否需要清仓
   */
  checkUnrealizedLoss(symbol, currentPrice, isLongSymbol) {
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
      // 如果没有缓存数据，说明可能还没有初始化，不执行清仓
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
      const positionType = isLongSymbol ? "做多标的" : "做空标的";
      const reason = `[保护性清仓] ${positionType} ${normalizedSymbol} 浮亏=${unrealizedLoss.toFixed(
        2
      )} HKD 超过阈值 ${this.maxUnrealizedLossPerSymbol} HKD (R1=${r1.toFixed(
        2
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

  /**
   * 更新标的的浮亏监控数据（在买入或卖出操作后调用）
   * @param {string} symbol 标的代码
   * @param {boolean} isLongSymbol 是否为做多标的
   * @param {boolean} isBuy 是否为买入操作（true=买入，false=卖出）
   * @param {number} executedPrice 成交价
   * @param {number} executedQuantity 成交数量
   */
  updateUnrealizedLossDataAfterTrade(
    symbol,
    isLongSymbol,
    isBuy,
    executedPrice,
    executedQuantity
  ) {
    // 如果未启用浮亏保护，跳过
    if (
      !this.maxUnrealizedLossPerSymbol ||
      !Number.isFinite(this.maxUnrealizedLossPerSymbol) ||
      this.maxUnrealizedLossPerSymbol <= 0
    ) {
      return;
    }

    const normalizedSymbol = normalizeHKSymbol(symbol);
    const price = Number(executedPrice) || 0;
    const quantity = Number(executedQuantity) || 0;

    // 验证数据有效性
    if (
      !Number.isFinite(price) ||
      price <= 0 ||
      !Number.isFinite(quantity) ||
      quantity <= 0
    ) {
      return;
    }

    // 获取当前的浮亏数据
    const lossData = this.unrealizedLossData.get(normalizedSymbol);
    if (!lossData) {
      // 如果没有缓存数据，需要重新初始化（这种情况不应该发生，但为了安全起见）
      logger.warn(
        `[浮亏监控] 标的 ${normalizedSymbol} 没有浮亏数据，无法更新，请先调用 refreshUnrealizedLossData`
      );
      return;
    }

    let { r1, n1 } = lossData;

    if (isBuy) {
      // 买入操作：将买入订单的市值加入到R1中，将买入的数量加入至N1
      const buyNotional = price * quantity;
      r1 = r1 + buyNotional;
      n1 = n1 + quantity;
    } else {
      // 卖出操作
      if (quantity >= n1) {
        // 如果卖出订单的数量大于或等于N1，视为全部卖出，清空市值和数量记录
        r1 = 0;
        n1 = 0;
      } else {
        // 如果卖出订单的数量小于N1，用R1减去该卖出订单的市值，用N1减去该卖出订单的数量
        const sellNotional = price * quantity;
        r1 = r1 - sellNotional; // 注意：成本市值允许为负值
        n1 = n1 - quantity;
      }
    }

    // 更新缓存
    this.unrealizedLossData.set(normalizedSymbol, {
      r1,
      n1,
      lastUpdateTime: Date.now(),
    });

    const positionType = isLongSymbol ? "做多标的" : "做空标的";
    const actionType = isBuy ? "买入" : "卖出";
    logger.info(
      `[浮亏监控] ${positionType} ${normalizedSymbol} ${actionType}后更新: R1=${r1.toFixed(
        2
      )} HKD, N1=${n1}`
    );
  }
}
