import { SignalType } from "./signalTypes.js";

/**
 * 恒生指数多指标策略：
 * - 监控 RSI6、RSI12、KDJ、成交均价（VWAP）
 * - 基于持仓成本价和指标条件生成清仓信号和开仓信号
 *
 * 策略逻辑：
 * 1. 买入做多标的（BUYCALL）：RSI6<20, RSI12<20, KDJ.D<20, KDJ.J<-1 满足3个以上，且监控标的价格<VWAP
 * 2. 卖出做多标的（SELLCALL）：RSI6>80, RSI12>80, KDJ.D>80, KDJ.J>100 满足3个以上，且做多标的价格>持仓成本价，立即清空所有做多标的持仓
 * 3. 买入做空标的（BUYPUT）：RSI6>80, RSI12>80, KDJ.D>80, KDJ.J>100 满足3个以上，且监控标的价格>VWAP
 * 4. 卖出做空标的（SELLPUT）：RSI6<20, RSI12<20, KDJ.D<20, KDJ.J<0 满足3个以上，且做空标的价格>持仓成本价，立即清空所有做空标的持仓（注意不是卖空）
 */
export class HangSengMultiIndicatorStrategy {
  constructor({
    buycall = {
      rsi6: 20,
      rsi12: 20,
      d: 20,
      j: -1,
    },
    sellcall = {
      rsi6: 80,
      rsi12: 80,
      d: 80,
      j: 100,
    },
    buyput = {
      rsi6: 80,
      rsi12: 80,
      d: 80,
      j: 100,
    },
    sellput = {
      rsi6: 20,
      rsi12: 20,
      d: 20,
      j: 0,
    },
  } = {}) {
    // 为每个信号类型单独配置阈值
    this.buycallThreshold = buycall;
    this.sellcallThreshold = sellcall;
    this.buyputThreshold = buyput;
    this.sellputThreshold = sellput;
  }

  /**
   * 计算60秒后的验证时间
   * @private
   * @returns {Date|null} 60秒后的时间，如果计算失败返回null
   */
  _calculateVerificationTime() {
    const now = new Date();
    const triggerTime = new Date(now.getTime() + 60 * 1000); // 加60秒

    // 如果目标时间已经过去，说明计算有误，返回null
    if (triggerTime <= now) {
      return null;
    }

    return triggerTime;
  }

  /**
   * 根据信号类型获取对应的阈值配置
   * @private
   * @param {string} signalType 信号类型
   * @returns {Object|null} 阈值配置对象 {rsi6, rsi12, d, j}
   */
  _getThresholdForSignal(signalType) {
    switch (signalType) {
      case SignalType.BUYCALL:
        return this.buycallThreshold;
      case SignalType.SELLCALL:
        return this.sellcallThreshold;
      case SignalType.BUYPUT:
        return this.buyputThreshold;
      case SignalType.SELLPUT:
        return this.sellputThreshold;
      default:
        return null;
    }
  }

  /**
   * 计算指定信号类型的指标条件满足数量
   * @private
   * @param {Object} state 监控标的的指标状态 {rsi6, rsi12, kdj}
   * @param {string} signalType 信号类型
   * @returns {number} 满足条件的数量（0-4）
   */
  _calculateConditionCount(state, signalType) {
    const { rsi6, rsi12, kdj } = state;
    const threshold = this._getThresholdForSignal(signalType);

    if (!threshold) {
      return 0;
    }

    // 根据信号类型判断是大于还是小于阈值
    const isBuySignal =
      signalType === SignalType.BUYCALL || signalType === SignalType.SELLPUT;

    const conditions = [
      isBuySignal ? rsi6 < threshold.rsi6 : rsi6 > threshold.rsi6,
      isBuySignal ? rsi12 < threshold.rsi12 : rsi12 > threshold.rsi12,
      isBuySignal ? kdj.d < threshold.d : kdj.d > threshold.d,
      isBuySignal ? kdj.j < threshold.j : kdj.j > threshold.j,
    ];

    return conditions.filter(Boolean).length;
  }

  /**
   * 生成延迟验证信号（统一方法）
   * @private
   * @param {Object} state 监控标的的指标状态
   * @param {string} symbol 标的代码
   * @param {string} action 信号类型
   * @param {string} reasonPrefix 原因前缀
   * @returns {Object|null} 延迟验证信号对象
   */
  _generateDelayedSignal(state, symbol, action, reasonPrefix) {
    const { rsi6, rsi12, kdj, vwap, price: monitorPrice, macd } = state;

    // 计算该信号类型满足条件的数量
    const satisfiedCount = this._calculateConditionCount(state, action);

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

    // 验证KDJ和MACD值是否有效
    if (!kdj || !Number.isFinite(kdj.j)) {
      return null;
    }

    if (!macd || !Number.isFinite(macd.macd)) {
      return null;
    }

    const triggerTime = this._calculateVerificationTime();
    if (!triggerTime) {
      return null;
    }

    // 记录当前的J值和MACD值（J1和MACD1）
    const j1 = kdj.j;
    const macd1 = macd.macd;

    const priceComparison = action === SignalType.BUYCALL ? "<" : ">";
    return {
      symbol,
      action,
      triggerTime,
      j1, // 记录触发时的J值
      macd1, // 记录触发时的MACD值
      verificationHistory: [], // 该信号专用的验证历史记录（每秒记录一次）
      reason: `${reasonPrefix}：监控标的 RSI6/12(${rsi6.toFixed(
        1
      )}/${rsi12.toFixed(1)})、KDJ(D=${kdj.d.toFixed(1)},J=${kdj.j.toFixed(
        2
      )}) 中 ${satisfiedCount} 项满足条件，且监控标的价格(${monitorPrice.toFixed(
        3
      )}) ${priceComparison} VWAP(${vwap.toFixed(3)})，J1=${j1.toFixed(
        2
      )} MACD1=${macd1.toFixed(4)}，将在 ${triggerTime.toLocaleString("zh-CN", {
        timeZone: "Asia/Hong_Kong",
        hour12: false,
      })} 进行验证`,
      originalState: {
        rsi6,
        rsi12,
        kdj,
        vwap,
        price: monitorPrice,
        macd,
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

    // 1. 买入做多标的（延迟验证策略）
    // 条件：RSI6 < 20, RSI12 < 20, KDJ.D < 20, KDJ.J < -1 四个指标中满足三个以上
    // 且当前监控标的价格 < 监控标的VWAP
    if (longSymbol) {
      const delayedBuySignal = this._generateDelayedSignal(
        state,
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
    const canSellLong =
      longPosition?.symbol &&
      Number.isFinite(longPosition.availableQuantity) &&
      longPosition.availableQuantity > 0 &&
      Number.isFinite(longCurrentPrice) &&
      longCurrentPrice > 0 &&
      Number.isFinite(longPosition.costPrice) &&
      longPosition.costPrice > 0;

    const sellcallCount = this._calculateConditionCount(
      state,
      SignalType.SELLCALL
    );
    if (
      canSellLong &&
      sellcallCount >= 3 &&
      longCurrentPrice > longPosition.costPrice
    ) {
      // 清仓做多标的
      immediateSignals.push({
        symbol: longPosition.symbol,
        action: SignalType.SELLCALL,
        reason: `做多标的当前价格(${longCurrentPrice.toFixed(
          3
        )}) > 持仓成本价(${longPosition.costPrice.toFixed(
          3
        )}) 且 RSI6/12(${rsi6.toFixed(1)}/${rsi12.toFixed(
          1
        )})、KDJ(D=${kdj.d.toFixed(1)},J=${kdj.j.toFixed(
          1
        )}) 中至少 3 项触发清仓条件，立即清空所有做多标的持仓`,
        signalTriggerTime: new Date(), // 立即执行信号的触发时间
      });
    }

    // 3. 买入做空标的（延迟验证策略）
    // 条件：RSI6 > 80, RSI12 > 80, KDJ.D > 80, KDJ.J > 100 四个指标中满足三个以上
    // 且当前监控标的价格 > 监控标的VWAP
    if (shortSymbol) {
      const delayedSellSignal = this._generateDelayedSignal(
        state,
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
    const canSellShort =
      shortPosition?.symbol &&
      Number.isFinite(shortPosition.availableQuantity) &&
      shortPosition.availableQuantity > 0 &&
      Number.isFinite(shortCurrentPrice) &&
      shortCurrentPrice > 0 &&
      Number.isFinite(shortPosition.costPrice) &&
      shortPosition.costPrice > 0;

    const sellputCount = this._calculateConditionCount(
      state,
      SignalType.SELLPUT
    );
    if (
      canSellShort &&
      sellputCount >= 3 &&
      shortCurrentPrice > shortPosition.costPrice
    ) {
      // 清仓做空标的（卖出平仓，不是卖空）
      immediateSignals.push({
        symbol: shortPosition.symbol,
        action: SignalType.SELLPUT, // 卖出做空标的（平空仓）
        reason: `做空标的当前价格(${shortCurrentPrice.toFixed(
          3
        )}) > 持仓成本价(${shortPosition.costPrice.toFixed(
          3
        )}) 且 RSI6/12(${rsi6.toFixed(1)}/${rsi12.toFixed(
          1
        )})、KDJ(D=${kdj.d.toFixed(1)},J=${kdj.j.toFixed(
          1
        )}) 中至少 3 项触发清仓条件，立即清空所有做空标的持仓`,
        signalTriggerTime: new Date(), // 立即执行信号的触发时间
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
