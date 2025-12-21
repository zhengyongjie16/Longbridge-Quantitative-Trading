import { SignalType } from "../utils/constants.js";

/**
 * 恒生指数多指标策略：
 * - 监控 RSI6、MFI、KDJ、MACD
 * - 基于持仓成本价和指标条件生成清仓信号和开仓信号
 *
 * 策略逻辑（所有信号条件1或条件2满足其一即可）：
 *
 * 1. 买入做多标的（BUYCALL）- 延迟验证：
 *    条件1：RSI6<20, MFI<15, KDJ.D<20, KDJ.J<-1 四个指标满足3个以上（无需检查均价）
 *    条件2：J<-20（无需检查均价）
 *
 * 2. 卖出做多标的（SELLCALL）- 立即执行：
 *    条件1：RSI6>80, MFI>85, KDJ.D>79, KDJ.J>100 四个指标满足3个以上
 *    条件2：KDJ.J>110
 *    注意：卖出信号生成时无需判断成本价，成本价判断在卖出策略中进行
 *
 * 3. 买入做空标的（BUYPUT）- 延迟验证：
 *    条件1：RSI6>80, MFI>85, KDJ.D>80, KDJ.J>100 四个指标满足3个以上（无需检查均价）
 *    条件2：J>120
 *
 * 4. 卖出做空标的（SELLPUT）- 立即执行：
 *    条件1：RSI6<20, MFI<15, KDJ.D<22, KDJ.J<0 四个指标满足3个以上
 *    条件2：KDJ.J<-15（无需检查均价）
 *    注意：卖出信号生成时无需判断成本价，成本价判断在卖出策略中进行
 */
export class HangSengMultiIndicatorStrategy {
  constructor({
    buycall = {
      rsi6: 20,
      mfi: 15,
      d: 20,
      j: -1,
    },
    sellcall = {
      rsi6: 80,
      mfi: 85,
      d: 79, // KDJ.D>79（注意：不是80）
      j: 100,
    },
    buyput = {
      rsi6: 80,
      mfi: 85,
      d: 80,
      j: 100,
    },
    sellput = {
      rsi6: 20,
      mfi: 15,
      d: 22, // KDJ.D<22（注意：不是20）
      j: 0,
    },
    verificationConfig = {
      delaySeconds: 60,
      indicators: ['K', 'MACD'],
    },
  } = {}) {
    // 为每个信号类型单独配置阈值
    this.buycallThreshold = buycall;
    this.sellcallThreshold = sellcall;
    this.buyputThreshold = buyput;
    this.sellputThreshold = sellput;

    // 延迟验证配置
    this.verificationConfig = verificationConfig || { delaySeconds: 60, indicators: ['K', 'MACD'] };
  }

  /**
   * 检查值是否为有效的有限数字
   * @private
   * @param {*} value 待检查的值
   * @returns {boolean} 如果值为有效的有限数字返回 true，否则返回 false
   */
  _isValidNumber(value) {
    return value !== null && value !== undefined && Number.isFinite(value);
  }

  /**
   * 验证指标状态的基本指标（RSI6, MFI, KDJ）
   * @private
   * @param {Object} state 指标状态对象
   * @returns {boolean} 如果所有基本指标有效返回 true，否则返回 false
   */
  _validateBasicIndicators(state) {
    const { rsi6, mfi, kdj } = state;
    return (
      this._isValidNumber(rsi6) &&
      this._isValidNumber(mfi) &&
      kdj &&
      this._isValidNumber(kdj.d) &&
      this._isValidNumber(kdj.j)
    );
  }

  /**
   * 验证指标状态（包括 MACD 和价格）
   * @private
   * @param {Object} state 指标状态对象
   * @returns {boolean} 如果所有指标有效返回 true，否则返回 false
   */
  _validateAllIndicators(state) {
    const { macd, price } = state;
    return (
      this._validateBasicIndicators(state) &&
      macd &&
      this._isValidNumber(macd.macd) &&
      this._isValidNumber(price)
    );
  }

  /**
   * 计算延迟验证时间
   * @private
   * @returns {Date|null} 延迟验证时间，如果不需要延迟验证则返回 null
   */
  _calculateVerificationTime() {
    // 如果延迟时间为 0 或指标列表为空，则不进行延迟验证
    if (
      !this.verificationConfig.delaySeconds ||
      this.verificationConfig.delaySeconds === 0 ||
      !this.verificationConfig.indicators ||
      this.verificationConfig.indicators.length === 0
    ) {
      return null;
    }

    const now = new Date();
    const triggerTime = new Date(now.getTime() + this.verificationConfig.delaySeconds * 1000);

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
   * @returns {Object|null} 阈值配置对象 {rsi6, mfi, d, j}
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
   * 从指标状态中提取指定指标的值
   * @private
   * @param {Object} state 指标状态对象 {kdj, macd}
   * @param {string} indicatorName 指标名称 (K, D, J, MACD, DIF, DEA)
   * @returns {number|null} 指标值，如果无效则返回 null
   */
  _getIndicatorValue(state, indicatorName) {
    const { kdj, macd } = state;

    switch (indicatorName) {
      case 'K':
        return kdj && this._isValidNumber(kdj.k) ? kdj.k : null;
      case 'D':
        return kdj && this._isValidNumber(kdj.d) ? kdj.d : null;
      case 'J':
        return kdj && this._isValidNumber(kdj.j) ? kdj.j : null;
      case 'MACD':
        return macd && this._isValidNumber(macd.macd) ? macd.macd : null;
      case 'DIF':
        return macd && this._isValidNumber(macd.dif) ? macd.dif : null;
      case 'DEA':
        return macd && this._isValidNumber(macd.dea) ? macd.dea : null;
      default:
        return null;
    }
  }

  /**
   * 计算指定信号类型的指标条件满足数量
   * @private
   * @param {Object} state 监控标的的指标状态 {rsi6, mfi, kdj}
   * @param {string} signalType 信号类型
   * @returns {number} 满足条件的数量（0-4）
   */
  _calculateConditionCount(state, signalType) {
    const { rsi6, mfi, kdj } = state;
    const threshold = this._getThresholdForSignal(signalType);

    if (!threshold || !this._validateBasicIndicators(state)) {
      return 0;
    }

    // 根据信号类型判断是使用小于阈值还是大于阈值比较
    // BUYCALL（买入做多）：RSI6<20, MFI<15, KDJ.D<20, KDJ.J<-1 → 使用小于比较
    // SELLPUT（卖出做空）：RSI6<20, MFI<15, KDJ.D<22, KDJ.J<0 → 使用小于比较
    // SELLCALL（卖出做多）：RSI6>80, MFI>85, KDJ.D>79, KDJ.J>100 → 使用大于比较
    // BUYPUT（买入做空）：RSI6>80, MFI>85, KDJ.D>80, KDJ.J>100 → 使用大于比较
    const useLessThanComparison =
      signalType === SignalType.BUYCALL || signalType === SignalType.SELLPUT;

    const conditions = [
      useLessThanComparison ? rsi6 < threshold.rsi6 : rsi6 > threshold.rsi6,
      useLessThanComparison ? mfi < threshold.mfi : mfi > threshold.mfi,
      useLessThanComparison ? kdj.d < threshold.d : kdj.d > threshold.d,
      useLessThanComparison ? kdj.j < threshold.j : kdj.j > threshold.j,
    ];

    return conditions.filter(Boolean).length;
  }

  /**
   * 生成延迟验证信号（买入信号）
   * @private
   * @param {Object} state 监控标的的指标状态
   * @param {string} symbol 标的代码
   * @param {string} action 信号类型
   * @param {string} reasonPrefix 原因前缀
   * @returns {Object|null} 延迟验证信号对象
   */
  _generateDelayedSignal(state, symbol, action, reasonPrefix) {
    // 验证所有必要的指标值是否有效
    if (!this._validateAllIndicators(state)) {
      return null;
    }

    const { rsi6, mfi, kdj, macd } = state;

    // 判断是否满足条件（条件1 或 条件2）
    let condition1Met = false;
    let condition2Met = false;
    let conditionReason = "";

    // 计算该信号类型满足条件的数量
    const satisfiedCount = this._calculateConditionCount(state, action);

    if (action === SignalType.BUYCALL) {
      // 买入做多：
      // 条件1：四个指标满足3个以上（无需检查均价）
      condition1Met = satisfiedCount >= 3;
      // 条件2：J<-20（无需检查均价）
      condition2Met = kdj.j < -20;

      if (condition1Met) {
        conditionReason = `满足条件1：${satisfiedCount}项指标满足`;
      } else if (condition2Met) {
        conditionReason = `满足条件2：J值${kdj.j.toFixed(2)}<-20`;
      }
    } else if (action === SignalType.BUYPUT) {
      // 买入做空：
      // 条件1：四个指标满足3个以上（无需检查均价）
      condition1Met = satisfiedCount >= 3;
      // 条件2：J>120
      condition2Met = kdj.j > 120;

      if (condition1Met) {
        conditionReason = `满足条件1：${satisfiedCount}项指标满足`;
      } else if (condition2Met) {
        conditionReason = `满足条件2：J值${kdj.j.toFixed(2)}>120`;
      }
    }

    // 必须满足条件1或条件2其中之一
    if (!condition1Met && !condition2Met) {
      return null;
    }

    const triggerTime = this._calculateVerificationTime();
    // 如果不需要延迟验证（triggerTime 为 null），则返回 null
    // 这种情况下，买入信号应该被当作立即执行的信号处理
    if (!triggerTime) {
      return null;
    }

    // 记录当前配置的所有指标的初始值（indicators1）
    const indicators1 = {};
    for (const indicatorName of this.verificationConfig.indicators) {
      const value = this._getIndicatorValue(state, indicatorName);
      if (value === null) {
        // 如果任何配置的指标值无效，则无法生成延迟验证信号
        return null;
      }
      indicators1[indicatorName] = value;
    }

    // 构建指标值的显示字符串（用于日志）
    const indicators1Str = Object.entries(indicators1)
      .map(([name, value]) => {
        // 根据指标类型选择合适的小数位数
        const decimals = ['MACD', 'DIF', 'DEA'].includes(name) ? 4 : 2;
        return `${name}1=${value.toFixed(decimals)}`;
      })
      .join(' ');

    return {
      symbol,
      action,
      triggerTime,
      indicators1, // 记录触发时的所有配置指标值
      verificationHistory: [], // 该信号专用的验证历史记录（每秒记录一次）
      reason: `${reasonPrefix}：${conditionReason}，RSI6(${rsi6.toFixed(
        1
      )})、MFI(${mfi?.toFixed(1) ?? "-"})、KDJ(K=${kdj.k.toFixed(
        2
      )},D=${kdj.d.toFixed(1)},J=${kdj.j.toFixed(2)})，${indicators1Str}，将在 ${triggerTime.toLocaleString("zh-CN", {
        timeZone: "Asia/Hong_Kong",
        hour12: false,
      })} 进行验证`,
    };
  }

  /**
   * 生成基于持仓成本价的清仓信号和延迟验证的开仓信号
   * @param {Object} state 监控标的的指标状态 {rsi6, mfi, kdj, price, macd}
   * @param {Object} longPosition 做多标的的持仓信息 {symbol, costPrice, quantity, availableQuantity}
   * @param {Object} shortPosition 做空标的的持仓信息 {symbol, costPrice, quantity, availableQuantity}
   * @param {string} longSymbol 做多标的的代码
   * @param {string} shortSymbol 做空标的的代码
   * @returns {Object} 包含立即执行信号和延迟验证信号的对象
   *   - immediateSignals: 立即执行的信号数组（清仓信号）
   *   - delayedSignals: 延迟验证的信号数组（开仓信号）
   */
  generateCloseSignals(
    state,
    longPosition,
    shortPosition,
    longSymbol,
    shortSymbol
  ) {
    const immediateSignals = [];
    const delayedSignals = [];

    if (!state) {
      return { immediateSignals, delayedSignals };
    }

    // 验证所有必要的指标值是否有效
    if (!this._validateBasicIndicators(state)) {
      return { immediateSignals, delayedSignals };
    }

    const { rsi6, mfi, kdj } = state;

    // 1. 买入做多标的（延迟验证策略）
    // 条件1：RSI6<20, MFI<15, KDJ.D<20, KDJ.J<-1 四个指标满足3个以上（无需检查均价）
    // 条件2：J<-20（无需检查均价）
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
    // 条件1：RSI6>80, MFI>85, KDJ.D>79, KDJ.J>100 四个指标满足3个以上
    // 条件2：KDJ.J>110
    // 注意：卖出信号生成时无需判断成本价，成本价判断在卖出策略中进行
    const canSellLong =
      longPosition?.symbol &&
      Number.isFinite(longPosition.availableQuantity) &&
      longPosition.availableQuantity > 0;

    if (canSellLong) {
      const sellcallCount = this._calculateConditionCount(
        state,
        SignalType.SELLCALL
      );
      const jValue = kdj?.j;

      // 条件1：四个指标满足3个以上（无需检查成本价）
      const condition1Met = sellcallCount >= 3;
      // 条件2：J>110
      const condition2Met = Number.isFinite(jValue) && jValue > 110;

      const shouldSellLong = condition1Met || condition2Met;

      if (shouldSellLong) {
        // 构建原因说明
        let reason = "";
        if (condition1Met) {
          reason = `满足条件1：RSI6(${rsi6.toFixed(1)})、MFI(${
            mfi?.toFixed(1) ?? "-"
          })、KDJ(D=${kdj.d.toFixed(1)},J=${kdj.j.toFixed(
            1
          )}) 中${sellcallCount}项满足条件`;
        } else if (condition2Met) {
          reason = `满足条件2：J值${kdj.j.toFixed(1)}>110`;
        }

        // 生成卖出信号，成本价判断和卖出数量计算在卖出策略中进行
        immediateSignals.push({
          symbol: longPosition.symbol,
          action: SignalType.SELLCALL,
          reason: reason,
          signalTriggerTime: new Date(),
        });
      }
    }

    // 3. 买入做空标的（延迟验证策略）
    // 条件1：RSI6>80, MFI>85, KDJ.D>80, KDJ.J>100 四个指标满足3个以上（无需检查均价）
    // 条件2：J>120
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
    // 条件1：RSI6<20, MFI<15, KDJ.D<22, KDJ.J<0 四个指标满足3个以上
    // 条件2：KDJ.J<-15（无需检查均价）
    // 注意：卖出信号生成时无需判断成本价，成本价判断在卖出策略中进行
    const canSellShort =
      shortPosition?.symbol &&
      Number.isFinite(shortPosition.availableQuantity) &&
      shortPosition.availableQuantity > 0;

    if (canSellShort) {
      const sellputCount = this._calculateConditionCount(
        state,
        SignalType.SELLPUT
      );
      const jValueShort = kdj?.j;

      // 条件1：四个指标满足3个以上（无需检查成本价）
      const condition1Short = sellputCount >= 3;
      // 条件2：J<-15
      const condition2Short = Number.isFinite(jValueShort) && jValueShort < -15;

      const shouldSellShort = condition1Short || condition2Short;

      if (shouldSellShort) {
        // 构建原因说明
        let reason = "";
        if (condition1Short) {
          reason = `满足条件1：RSI6(${rsi6.toFixed(1)})、MFI(${
            mfi?.toFixed(1) ?? "-"
          })、KDJ(D=${kdj.d.toFixed(1)},J=${kdj.j.toFixed(
            1
          )}) 中${sellputCount}项满足条件`;
        } else if (condition2Short) {
          reason = `满足条件2：J值${kdj.j.toFixed(1)}<-15`;
        }

        // 生成卖出信号，成本价判断和卖出数量计算在卖出策略中进行
        immediateSignals.push({
          symbol: shortPosition.symbol,
          action: SignalType.SELLPUT,
          reason: reason,
          signalTriggerTime: new Date(),
        });
      }
    }

    return { immediateSignals, delayedSignals };
  }
}
