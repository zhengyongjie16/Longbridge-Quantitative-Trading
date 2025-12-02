import { SignalType } from "./signalTypes.js";

/**
 * 恒生指数多指标策略：
 * - 监控 RSI6、RSI12、KDJ、成交均价（VWAP）
 * - 基于持仓成本价和指标条件生成清仓信号和开仓信号
 * 
 * 策略逻辑：
 * 1. 买入做多标的（BUYCALL）：RSI6<20, RSI12<20, KDJ.D<20, KDJ.J<0 满足3个以上，且监控标的价格<VWAP
 * 2. 卖出做多标的（SELLCALL）：RSI6>80, RSI12>80, KDJ.D>80, KDJ.J>100 满足3个以上，且做多标的价格>持仓成本价，立即清空所有做多标的持仓
 * 3. 买入做空标的（BUYPUT）：RSI6>80, RSI12>80, KDJ.D>80, KDJ.J>100 满足3个以上，且监控标的价格>VWAP
 * 4. 卖出做空标的（SELLPUT）：RSI6<20, RSI12<20, KDJ.D<20, KDJ.J<0 满足3个以上，且做空标的价格>持仓成本价，立即清空所有做空标的持仓（注意不是卖空）
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
   * 生成基于持仓成本价的清仓信号和开仓信号
   * @param {Object} state 监控标的的指标状态 {rsi6, rsi12, kdj, vwap, price}
   * @param {Object} longPosition 做多标的的持仓信息 {symbol, costPrice, quantity, availableQuantity}
   * @param {number} longCurrentPrice 做多标的的当前价格
   * @param {Object} shortPosition 做空标的的持仓信息 {symbol, costPrice, quantity, availableQuantity}
   * @param {number} shortCurrentPrice 做空标的的当前价格
   * @param {string} longSymbol 做多标的的代码
   * @param {string} shortSymbol 做空标的的代码
   * @returns {Array} 交易信号数组（包含清仓和开仓信号）
   */
  generateCloseSignals(
    state,
    longPosition,
    longCurrentPrice,
    shortPosition,
    shortCurrentPrice,
    longSymbol,
    shortSymbol
  ) {
    const signals = [];
    
    if (!state) {
      return signals;
    }

    const { rsi6, rsi12, kdj, vwap, price: monitorPrice } = state;
    if (
      [rsi6, rsi12, kdj?.d, kdj?.j].some(
        (value) => value === null || Number.isNaN(value)
      )
    ) {
      return signals;
    }

    // 计算指标条件
    const sellConds = [
      rsi6 > this.sellThreshold.rsi6,
      rsi12 > this.sellThreshold.rsi12,
      kdj.d > this.sellThreshold.d,
      kdj.j > this.sellThreshold.j,
    ];
    const sellCount = sellConds.filter(Boolean).length;

    const buyConds = [
      rsi6 < this.buyThreshold.rsi6,
      rsi12 < this.buyThreshold.rsi12,
      kdj.d < this.buyThreshold.d,
      kdj.j < this.buyThreshold.j,
    ];
    const buyCount = buyConds.filter(Boolean).length;

    // 1. 买入做多标的的条件
    // 条件：RSI6 < 20, RSI12 < 20, KDJ.D < 20, KDJ.J < 0 四个指标中满足三个以上
    // 且当前监控标的价格 < 监控标的VWAP
    // 注意：不检查是否已有持仓，持仓市值限制由风险控制模块处理
    if (
      buyCount >= 3 &&
      Number.isFinite(monitorPrice) &&
      Number.isFinite(vwap) &&
      monitorPrice < vwap &&
      longSymbol
    ) {
      signals.push({
        symbol: longSymbol,
        action: SignalType.BUYCALL, // 买入做多标的（做多操作）
        reason: `监控标的 RSI6/12(${rsi6.toFixed(1)}/${rsi12.toFixed(1)})、KDJ(D=${kdj.d.toFixed(1)},J=${kdj.j.toFixed(1)}) 中至少 3 项满足买入条件，且监控标的价格(${monitorPrice.toFixed(3)}) < VWAP(${vwap.toFixed(3)})，买入做多标的`,
      });
    }

    // 2. 卖出做多标的的条件
    // 条件：RSI6 > 80, RSI12 > 80, KDJ.D > 80, KDJ.J > 100 四个指标中满足三个以上
    // 且当前做多标的价格 > 做多标的持仓成本价
    // 立即清空所有做多标的持仓
    const canSellLong = longPosition?.symbol && 
        Number.isFinite(longPosition.availableQuantity) && 
        longPosition.availableQuantity > 0 && 
        Number.isFinite(longCurrentPrice) && 
        longCurrentPrice > 0 &&
        Number.isFinite(longPosition.costPrice) && 
        longPosition.costPrice > 0;
    
    if (canSellLong && sellCount >= 3 && longCurrentPrice > longPosition.costPrice) {
      // 清仓做多标的
      signals.push({
        symbol: longPosition.symbol,
        action: SignalType.SELLCALL,
        reason: `做多标的当前价格(${longCurrentPrice.toFixed(3)}) > 持仓成本价(${longPosition.costPrice.toFixed(3)}) 且 RSI6/12(${rsi6.toFixed(1)}/${rsi12.toFixed(1)})、KDJ(D=${kdj.d.toFixed(1)},J=${kdj.j.toFixed(1)}) 中至少 3 项触发清仓条件，立即清空所有做多标的持仓`,
      });
    }

    // 3. 买入做空标的的条件
    // 条件：RSI6 > 80, RSI12 > 80, KDJ.D > 80, KDJ.J > 100 四个指标中满足三个以上
    // 且当前监控标的价格 > 监控标的VWAP
    // 注意：不检查是否已有持仓，持仓市值限制由风险控制模块处理
    if (
      sellCount >= 3 &&
      Number.isFinite(monitorPrice) &&
      Number.isFinite(vwap) &&
      monitorPrice > vwap &&
      shortSymbol
    ) {
      signals.push({
        symbol: shortSymbol,
        action: SignalType.BUYPUT, // 买入做空标的（做空操作）
        reason: `监控标的 RSI6/12(${rsi6.toFixed(1)}/${rsi12.toFixed(1)})、KDJ(D=${kdj.d.toFixed(1)},J=${kdj.j.toFixed(1)}) 中至少 3 项满足买入条件，且监控标的价格(${monitorPrice.toFixed(3)}) > VWAP(${vwap.toFixed(3)})，买入做空标的`,
      });
    }

    // 4. 卖出做空标的的条件
    // 条件：RSI6 < 20, RSI12 < 20, KDJ.D < 20, KDJ.J < 0 四个指标中满足三个以上
    // 且当前做空标的价格 > 做空标的持仓成本价
    // 立即清空所有做空标的持仓（注意不是卖空）
    const canSellShort = shortPosition?.symbol && 
        Number.isFinite(shortPosition.availableQuantity) && 
        shortPosition.availableQuantity > 0 && 
        Number.isFinite(shortCurrentPrice) && 
        shortCurrentPrice > 0 &&
        Number.isFinite(shortPosition.costPrice) && 
        shortPosition.costPrice > 0;
    
    if (canSellShort && buyCount >= 3 && shortCurrentPrice > shortPosition.costPrice) {
      // 清仓做空标的（卖出平仓，不是卖空）
      signals.push({
        symbol: shortPosition.symbol,
        action: SignalType.SELLPUT, // 卖出做空标的（平空仓）
        reason: `做空标的当前价格(${shortCurrentPrice.toFixed(3)}) > 持仓成本价(${shortPosition.costPrice.toFixed(3)}) 且 RSI6/12(${rsi6.toFixed(1)}/${rsi12.toFixed(1)})、KDJ(D=${kdj.d.toFixed(1)},J=${kdj.j.toFixed(1)}) 中至少 3 项触发清仓条件，立即清空所有做空标的持仓`,
      });
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

