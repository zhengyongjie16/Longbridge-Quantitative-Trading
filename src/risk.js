// 基础风险管理模块：检查最大单日亏损与单标的最大持仓金额
import { TRADING_CONFIG } from "./config.trading.js";

export class RiskChecker {
  constructor({ maxDailyLoss, maxPositionNotional } = {}) {
    this.maxDailyLoss = maxDailyLoss ?? TRADING_CONFIG.maxDailyLoss;
    this.maxPositionNotional =
      maxPositionNotional ?? TRADING_CONFIG.maxPositionNotional;
  }

  /**
   * @param {{totalCash:number, netAssets:number}} account
   * @param {Array<{symbol:string, quantity:number, costPrice:number}>} positions
   * @param {{action:"BUY"|"SELL"|"HOLD", symbol:string}} signal
   * @param {number} orderNotional 计划下单金额（HKD）
   * @param {number} currentPrice 标的当前市价（用于计算持仓市值，如果未提供则使用成本价）
   */
  checkBeforeOrder(account, positions, signal, orderNotional, currentPrice = null) {
    if (!account || !signal || signal.action === "HOLD") {
      return { allowed: true };
    }

    const { netAssets, totalCash } = account;
    
    // 验证账户数据有效性
    if (!Number.isFinite(netAssets) || !Number.isFinite(totalCash)) {
      return {
        allowed: false,
        reason: `账户数据无效，无法进行风险检查`,
      };
    }
    
    // 计算浮亏：持仓市值 = 净资产 - 现金
    // 注意：这里假设 netAssets = totalCash + positionValue
    // 如果持仓有浮亏，positionValue会小于持仓成本，导致netAssets < totalCash + 持仓成本
    const unrealizedPnL = netAssets - totalCash;

    // 简单认为当日浮亏超过 maxDailyLoss 时，停止开新仓
    if (signal.action === "BUY" && Number.isFinite(unrealizedPnL) && unrealizedPnL <= -this.maxDailyLoss) {
      return {
        allowed: false,
        reason: `当前浮亏约 ${unrealizedPnL.toFixed(
          2
        )} 已超过单日最大亏损 ${this.maxDailyLoss}, 禁止继续开新仓`,
      };
    }

    // 检查单标的最大持仓市值限制（适用于买入和做空）
    if (signal.action === "BUY" || signal.action === "SELL") {
      // 验证下单金额有效性
      if (!Number.isFinite(orderNotional) || orderNotional < 0) {
        return {
          allowed: false,
          reason: `计划下单金额无效：${orderNotional}`,
        };
      }
      
      const symbol = signal.symbol;
      const pos = positions?.find((p) => {
        const posSymbol = p.symbol.includes(".") ? p.symbol : `${p.symbol}.HK`;
        const sigSymbol = symbol.includes(".") ? symbol : `${symbol}.HK`;
        return posSymbol === sigSymbol;
      });
      
      if (pos && pos.quantity > 0) {
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
            )} HKD（数量=${posQuantity} × 价格=${price.toFixed(3)}），加上本次计划下单 ${orderNotional.toFixed(
              2
            )} HKD 将超过单标的最大持仓市值限制 ${this.maxPositionNotional} HKD`,
          };
        }
      } else if (orderNotional > this.maxPositionNotional) {
        // 如果没有持仓，检查本次下单金额是否超过限制
        return {
          allowed: false,
          reason: `本次计划下单金额 ${orderNotional.toFixed(
            2
          )} HKD 超过单标的最大持仓市值限制 ${this.maxPositionNotional} HKD`,
        };
      }
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
          reason: `牛证距离回收价百分比为 ${distancePercent.toFixed(2)}%，低于0.5%阈值，停止买入（回收价=${strikePrice?.toFixed(3) ?? "未知"}，相关资产价格=${underlyingPriceActual?.toFixed(3) ?? "未知"}）`,
          warrantInfo: warrantDistance,
        };
      }

      // 熊证：当距离回收价百分比高于-0.5%（即低于0.5%）时停止买入
      if (warrantType === "BEAR" && distancePercent > -0.5) {
        return {
          allowed: false,
          reason: `熊证距离回收价百分比为 ${distancePercent.toFixed(2)}%，高于-0.5%阈值，停止买入（回收价=${strikePrice?.toFixed(3) ?? "未知"}，相关资产价格=${underlyingPriceActual?.toFixed(3) ?? "未知"}）`,
          warrantInfo: warrantDistance,
        };
      }

      // 风险检查通过
      return {
        allowed: true,
        reason: `${warrantType === "BULL" ? "牛证" : "熊证"}距离回收价百分比为 ${distancePercent.toFixed(2)}%，在安全范围内`,
        warrantInfo: warrantDistance,
      };
    } catch (err) {
      // 如果检查出错，默认允许交易（避免误拦截）
      console.warn(
        `[风险检查] 检查牛熊证风险时出错：`,
        err?.message ?? err
      );
      return {
        allowed: true,
        reason: `牛熊证风险检查出错，默认允许交易：${err?.message ?? String(err)}`,
      };
    }
  }
}


