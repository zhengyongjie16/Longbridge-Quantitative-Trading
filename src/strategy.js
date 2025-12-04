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
      rsi6: 79.5,
      rsi12: 80,
      d: 80,
      j: 100,
    },
    buy = {
      rsi6: 20,
      rsi12: 20,
      d: 20,
      j: -1,
    },
  } = {}) {
    this.sellThreshold = sell;
    this.buyThreshold = buy;
  }

  /**
   * 计算下下分钟的开始时间
   * @private
   * @returns {Date|null} 下下分钟的开始时间，如果计算失败返回null
   */
  _calculateNextNextMinute() {
    const now = new Date();
    const triggerTime = new Date(now);
    triggerTime.setMinutes(triggerTime.getMinutes() + 2); // 加2分钟
    triggerTime.setSeconds(0);
    triggerTime.setMilliseconds(0);
    
    // 如果目标时间已经过去，说明计算有误，返回null
    if (triggerTime <= now) {
      return null;
    }
    
    return triggerTime;
  }

  /**
   * 生成延迟验证信号（统一方法）
   * @private
   * @param {Object} state 监控标的的指标状态
   * @param {Array} conditions 指标条件数组
   * @param {number} satisfiedCount 满足条件的数量
   * @param {string} symbol 标的代码
   * @param {string} action 信号类型
   * @param {string} reasonPrefix 原因前缀
   * @returns {Object|null} 延迟验证信号对象
   */
  _generateDelayedSignal(state, conditions, satisfiedCount, symbol, action, reasonPrefix) {
    const { rsi6, rsi12, kdj, vwap, price: monitorPrice } = state;
    
    if (satisfiedCount < 3) {
      return null;
    }
    
    if (!Number.isFinite(monitorPrice) || !Number.isFinite(vwap)) {
      return null;
    }
    
    // 根据信号类型判断价格条件
    const priceConditionMet = 
      (action === SignalType.BUYCALL && monitorPrice < vwap) ||
      (action === SignalType.BUYPUT && monitorPrice > vwap);
    
    if (!priceConditionMet) {
      return null;
    }
    
    const triggerTime = this._calculateNextNextMinute();
    if (!triggerTime) {
      return null;
    }
    
    const priceComparison = action === SignalType.BUYCALL ? "<" : ">";
    return {
      symbol,
      action,
      triggerTime,
      reason: `${reasonPrefix}：监控标的 RSI6/12(${rsi6.toFixed(1)}/${rsi12.toFixed(1)})、KDJ(D=${kdj.d.toFixed(1)},J=${kdj.j.toFixed(1)}) 中 ${satisfiedCount} 项满足条件，且监控标的价格(${monitorPrice.toFixed(3)}) ${priceComparison} VWAP(${vwap.toFixed(3)})，将在 ${triggerTime.toLocaleString("zh-CN", { timeZone: "Asia/Hong_Kong", hour12: false })} 进行验证`,
      originalState: {
        rsi6,
        rsi12,
        kdj,
        vwap,
        price: monitorPrice,
      },
    };
  }

  /**
   * 生成基于持仓成本价的清仓信号和延迟验证的开仓信号
   * @param {Object} state 监控标的的指标状态 {rsi6, rsi12, kdj, vwap, price}
   * @param {Object} longPosition 做多标的的持仓信息 {symbol, costPrice, quantity, availableQuantity}
   * @param {number} longCurrentPrice 做多标的的当前价格
   * @param {Object} shortPosition 做空标的的持仓信息 {symbol, costPrice, quantity, availableQuantity}
   * @param {number} shortCurrentPrice 做空标的的当前价格
   * @param {string} longSymbol 做多标的的代码
   * @param {string} shortSymbol 做空标的的代码
   * @returns {Object} 包含立即执行信号和延迟验证信号的对象
   *   - immediateSignals: 立即执行的信号数组（清仓信号）
   *   - delayedSignals: 延迟验证的信号数组（开仓信号）
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
    const immediateSignals = [];
    const delayedSignals = [];
    
    if (!state) {
      return { immediateSignals, delayedSignals };
    }

    const { rsi6, rsi12, kdj } = state;
    if (
      [rsi6, rsi12, kdj?.d, kdj?.j].some(
        (value) => value === null || Number.isNaN(value)
      )
    ) {
      return { immediateSignals, delayedSignals };
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

    // 1. 买入做多标的（延迟验证策略）
    // 条件：RSI6 < 20, RSI12 < 20, KDJ.D < 20, KDJ.J < -1 四个指标中满足三个以上
    // 且当前监控标的价格 < 监控标的VWAP
    if (longSymbol) {
      const delayedBuySignal = this._generateDelayedSignal(
        state,
        buyConds,
        buyCount,
        longSymbol,
        SignalType.BUYCALL,
        "延迟验证买入做多信号"
      );
      if (delayedBuySignal) {
        delayedSignals.push(delayedBuySignal);
      }
    }

    // 2. 卖出做多标的的条件（立即执行）
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
      immediateSignals.push({
        symbol: longPosition.symbol,
        action: SignalType.SELLCALL,
        reason: `做多标的当前价格(${longCurrentPrice.toFixed(3)}) > 持仓成本价(${longPosition.costPrice.toFixed(3)}) 且 RSI6/12(${rsi6.toFixed(1)}/${rsi12.toFixed(1)})、KDJ(D=${kdj.d.toFixed(1)},J=${kdj.j.toFixed(1)}) 中至少 3 项触发清仓条件，立即清空所有做多标的持仓`,
      });
    }

    // 3. 买入做空标的（延迟验证策略）
    // 条件：RSI6 > 80, RSI12 > 80, KDJ.D > 80, KDJ.J > 100 四个指标中满足三个以上
    // 且当前监控标的价格 > 监控标的VWAP
    if (shortSymbol) {
      const delayedSellSignal = this._generateDelayedSignal(
        state,
        sellConds,
        sellCount,
        shortSymbol,
        SignalType.BUYPUT,
        "延迟验证买入做空信号"
      );
      if (delayedSellSignal) {
        delayedSignals.push(delayedSellSignal);
      }
    }

    // 4. 卖出做空标的的条件（立即执行）
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
      immediateSignals.push({
        symbol: shortPosition.symbol,
        action: SignalType.SELLPUT, // 卖出做空标的（平空仓）
        reason: `做空标的当前价格(${shortCurrentPrice.toFixed(3)}) > 持仓成本价(${shortPosition.costPrice.toFixed(3)}) 且 RSI6/12(${rsi6.toFixed(1)}/${rsi12.toFixed(1)})、KDJ(D=${kdj.d.toFixed(1)},J=${kdj.j.toFixed(1)}) 中至少 3 项触发清仓条件，立即清空所有做空标的持仓`,
      });
    }

    return { immediateSignals, delayedSignals };
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

