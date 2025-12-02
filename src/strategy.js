/**
 * 恒生指数多指标策略：
 * - 监控 RSI6、RSI12、KDJ、成交均价（VWAP）
 * - 基于持仓成本价和指标条件生成清仓信号
 */
export class HangSengMultiIndicatorStrategy {
  constructor({
    sell = {
      rsi6: 80,
      rsi12: 80,
      d: 80,
      j: 100,
    },
    buy = {
      rsi6: 20,
      rsi12: 20,
      d: 20,
      j: 0,
    },
  } = {}) {
    this.sellThreshold = sell;
    this.buyThreshold = buy;
  }

  /**
   * 生成基于持仓成本价的清仓信号
   * @param {Object} state 监控标的的指标状态
   * @param {Object} longPosition 做多标的的持仓信息 {symbol, costPrice, quantity, availableQuantity}
   * @param {number} longCurrentPrice 做多标的的当前价格
   * @param {Object} shortPosition 做空标的的持仓信息 {symbol, costPrice, quantity, availableQuantity}
   * @param {number} shortCurrentPrice 做空标的的当前价格
   * @returns {Array} 清仓信号数组
   */
  generateCloseSignals(state, longPosition, longCurrentPrice, shortPosition, shortCurrentPrice) {
    const signals = [];
    
    if (!state) {
      return signals;
    }

    const { rsi6, rsi12, kdj } = state;
    if (
      [rsi6, rsi12, kdj?.d, kdj?.j].some(
        (value) => value === null || Number.isNaN(value)
      )
    ) {
      return signals;
    }

    // 检查是否满足清仓做多标的的条件
    // 条件：RSI6 > 80, RSI12 > 80, KDJ.D > 80, KDJ.J > 100 四个指标中满足三个以上
    // 且当前做多标的价格 > 做多标的持仓成本价
    if (longPosition && longPosition.availableQuantity > 0 && Number.isFinite(longCurrentPrice) && Number.isFinite(longPosition.costPrice)) {
      const sellConds = [
        rsi6 > this.sellThreshold.rsi6,
        rsi12 > this.sellThreshold.rsi12,
        kdj.d > this.sellThreshold.d,
        kdj.j > this.sellThreshold.j,
      ];
      const sellCount = sellConds.filter(Boolean).length;
      
      if (sellCount >= 3 && longCurrentPrice > longPosition.costPrice) {
        signals.push({
          symbol: longPosition.symbol,
          action: "SELL",
          reason: `做多标的当前价格(${longCurrentPrice.toFixed(3)}) > 持仓成本价(${longPosition.costPrice.toFixed(3)}) 且 RSI6/12(${rsi6.toFixed(1)}/${rsi12.toFixed(1)})、KDJ(D=${kdj.d.toFixed(1)},J=${kdj.j.toFixed(1)}) 中至少 3 项触发清仓条件`,
        });
      }
    }

    // 检查是否满足清仓做空标的的条件
    // 条件：RSI6 < 20, RSI12 < 20, KDJ.D < 20, KDJ.J < 0 四个指标中满足三个以上
    // 且当前做空标的价格 > 做空标的持仓成本价
    if (shortPosition && shortPosition.availableQuantity > 0 && Number.isFinite(shortCurrentPrice) && Number.isFinite(shortPosition.costPrice)) {
      const buyConds = [
        rsi6 < this.buyThreshold.rsi6,
        rsi12 < this.buyThreshold.rsi12,
        kdj.d < this.buyThreshold.d,
        kdj.j < this.buyThreshold.j,
      ];
      const buyCount = buyConds.filter(Boolean).length;
      
      if (buyCount >= 3 && shortCurrentPrice > shortPosition.costPrice) {
        signals.push({
          symbol: shortPosition.symbol,
          action: "BUY", // 做空持仓需要买入平仓
          reason: `做空标的当前价格(${shortCurrentPrice.toFixed(3)}) > 持仓成本价(${shortPosition.costPrice.toFixed(3)}) 且 RSI6/12(${rsi6.toFixed(1)}/${rsi12.toFixed(1)})、KDJ(D=${kdj.d.toFixed(1)},J=${kdj.j.toFixed(1)}) 中至少 3 项触发清仓条件`,
        });
      }
    }

    return signals;
  }

  /**
   * 生成信号（保留原有方法以兼容，但新策略主要使用 generateCloseSignals）
   * @deprecated 新策略使用 generateCloseSignals 方法
   */
  generateSignal(state) {
    // 保留原有逻辑，但新策略不再使用此方法
    return null;
  }
}

