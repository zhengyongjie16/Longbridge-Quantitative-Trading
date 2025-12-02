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
    const unrealizedPnL = netAssets - totalCash;

    // 简单认为当日浮亏超过 maxDailyLoss 时，停止开新仓
    if (signal.action === "BUY" && unrealizedPnL <= -this.maxDailyLoss) {
      return {
        allowed: false,
        reason: `当前浮亏约 ${unrealizedPnL.toFixed(
          2
        )} 已超过单日最大亏损 ${this.maxDailyLoss}, 禁止继续开新仓`,
      };
    }

    // 检查单标的最大持仓市值限制（适用于买入和做空）
    if (signal.action === "BUY" || signal.action === "SELL") {
      const symbol = signal.symbol;
      const pos = positions?.find((p) => {
        const posSymbol = p.symbol.includes(".") ? p.symbol : `${p.symbol}.HK`;
        const sigSymbol = symbol.includes(".") ? symbol : `${symbol}.HK`;
        return posSymbol === sigSymbol;
      });
      
      if (pos && pos.quantity > 0) {
        // 使用当前市价计算持仓市值，如果没有提供则使用成本价
        const price = currentPrice ?? pos.costPrice ?? 0;
        const currentNotional = pos.quantity * price;
        
        // 如果是买入或做空操作，需要加上本次计划下单金额
        const totalNotional = currentNotional + orderNotional;
        
        if (totalNotional > this.maxPositionNotional) {
          return {
            allowed: false,
            reason: `该标的当前持仓市值约 ${currentNotional.toFixed(
              2
            )} HKD（数量=${pos.quantity} × 价格=${price.toFixed(3)}），加上本次计划下单 ${orderNotional.toFixed(
              2
            )} HKD 将超过单标的最大持仓市值限制 ${this.maxPositionNotional} HKD`,
          };
        }
      } else {
        // 如果没有持仓，检查本次下单金额是否超过限制
        if (orderNotional > this.maxPositionNotional) {
          return {
            allowed: false,
            reason: `本次计划下单金额 ${orderNotional.toFixed(
              2
            )} HKD 超过单标的最大持仓市值限制 ${this.maxPositionNotional} HKD`,
          };
        }
      }
    }

    return { allowed: true };
  }
}


