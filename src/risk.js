// 基础风险管理模块：检查最大单日亏损与单标的最大持仓金额
import { TRADING_CONFIG } from "./config/config.trading.js";
import { SignalType, isBuyAction } from "./signalTypes.js";
import { normalizeHKSymbol } from "./utils.js";

export class RiskChecker {
  constructor({ maxDailyLoss, maxPositionNotional } = {}) {
    this.maxDailyLoss = maxDailyLoss ?? TRADING_CONFIG.maxDailyLoss;
    this.maxPositionNotional =
      maxPositionNotional ?? TRADING_CONFIG.maxPositionNotional;

    // 验证 maxDailyLoss 的有效性
    if (!Number.isFinite(this.maxDailyLoss) || this.maxDailyLoss < 0) {
      console.warn(
        `[风险检查警告] maxDailyLoss 配置无效（${this.maxDailyLoss}），将使用默认值 0（禁止任何浮亏）`
      );
      this.maxDailyLoss = 0;
    }
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
        console.log(
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
        console.error(
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

    // 使用当前市价计算持仓市值，如果没有提供则使用成本价
    const price = currentPrice ?? pos.costPrice ?? 0;

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
   * @param {string} symbol 标的代码
   * @param {Object} marketDataClient MarketDataClient实例，用于获取牛熊证信息
   * @param {number} underlyingPrice 相关资产的最新价格（可选，如果不提供会尝试自动获取）
   * @returns {Promise<{allowed: boolean, reason?: string, warrantInfo?: Object}>}
   */
  async checkWarrantRisk(symbol, marketDataClient, underlyingPrice = null) {
    if (!marketDataClient || !symbol) {
      // 如果无法检查，默认允许交易（保守策略）
      return { allowed: true };
    }

    try {
      const warrantDistance = await marketDataClient.getWarrantDistanceToStrike(
        symbol,
        underlyingPrice
      );

      // 如果不是牛熊证，直接允许交易
      if (!warrantDistance.isWarrant) {
        return { allowed: true };
      }

      // 如果无法获取距离回收价的百分比，默认允许交易（避免误拦截）
      if (warrantDistance.distanceToStrikePercent === null) {
        return {
          allowed: true,
          reason: `无法获取牛熊证距离回收价的百分比，允许交易`,
          warrantInfo: warrantDistance,
        };
      }

      const distancePercent = warrantDistance.distanceToStrikePercent;
      const warrantType = warrantDistance.warrantType;
      const strikePrice = warrantDistance.strikePrice;
      const underlyingPriceActual = warrantDistance.underlyingPrice;

      // 牛证：当距离回收价百分比低于0.5%时停止买入
      if (warrantType === "BULL" && distancePercent < 0.5) {
        return {
          allowed: false,
          reason: `牛证距离回收价百分比为 ${distancePercent.toFixed(
            2
          )}%，低于0.5%阈值，停止买入（回收价=${
            strikePrice?.toFixed(3) ?? "未知"
          }，相关资产价格=${underlyingPriceActual?.toFixed(3) ?? "未知"}）`,
          warrantInfo: warrantDistance,
        };
      }

      // 熊证：当距离回收价百分比高于-0.5%（即低于0.5%）时停止买入
      if (warrantType === "BEAR" && distancePercent > -0.5) {
        return {
          allowed: false,
          reason: `熊证距离回收价百分比为 ${distancePercent.toFixed(
            2
          )}%，高于-0.5%阈值，停止买入（回收价=${
            strikePrice?.toFixed(3) ?? "未知"
          }，相关资产价格=${underlyingPriceActual?.toFixed(3) ?? "未知"}）`,
          warrantInfo: warrantDistance,
        };
      }

      // 风险检查通过
      return {
        allowed: true,
        reason: `${
          warrantType === "BULL" ? "牛证" : "熊证"
        }距离回收价百分比为 ${distancePercent.toFixed(2)}%，在安全范围内`,
        warrantInfo: warrantDistance,
      };
    } catch (err) {
      // 如果检查出错，默认允许交易（避免误拦截）
      console.warn(`[风险检查] 检查牛熊证风险时出错：`, err?.message ?? err);
      return {
        allowed: true,
        reason: `牛熊证风险检查出错，默认允许交易：${
          err?.message ?? String(err)
        }`,
      };
    }
  }
}
