import { SignalType } from "../utils/constants.js";
import { evaluateSignalConfig } from "../utils/signalConfigParser.js";

/**
 * 恒生指数多指标策略：
 * - 监控 RSI6、RSI12、MFI、KDJ
 * - 基于可配置的信号条件生成清仓信号和开仓信号
 *
 * 信号配置格式：(条件1,条件2,...)/N|(条件A)|(条件B,条件C)/M
 * - 括号内是条件列表，逗号分隔
 * - /N：括号内条件需满足 N 项，不设则全部满足
 * - |：分隔不同条件组（最多3个），满足任一组即可
 * - 支持指标：RSI6, RSI12, MFI, D (KDJ.D), J (KDJ.J)
 *
 * 默认策略逻辑（所有信号条件组满足其一即可）：
 *
 * 1. 买入做多标的（BUYCALL）- 延迟验证：
 *    (RSI6<20,MFI<15,D<20,J<-1)/3|(J<-20)
 *
 * 2. 卖出做多标的（SELLCALL）- 立即执行：
 *    (RSI6>80,MFI>85,D>79,J>100)/3|(J>110)
 *
 * 3. 买入做空标的（BUYPUT）- 延迟验证：
 *    (RSI6>80,MFI>85,D>80,J>100)/3|(J>120)
 *
 * 4. 卖出做空标的（SELLPUT）- 立即执行：
 *    (RSI6<20,MFI<15,D<22,J<0)/3|(J<-15)
 */
export class HangSengMultiIndicatorStrategy {
  constructor({
    signalConfig = null,
    verificationConfig = {
      delaySeconds: 60,
      indicators: ["K", "MACD"],
    },
  } = {}) {
    // 信号配置（包含 buycall, sellcall, buyput, sellput 四个信号的配置）
    this.signalConfig = signalConfig || {};

    // 延迟验证配置
    this.verificationConfig = verificationConfig || {
      delaySeconds: 60,
      indicators: ["K", "MACD"],
    };
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
    const triggerTime = new Date(
      now.getTime() + this.verificationConfig.delaySeconds * 1000
    );

    // 如果目标时间已经过去，说明计算有误，返回null
    if (triggerTime <= now) {
      return null;
    }

    return triggerTime;
  }

  /**
   * 根据信号类型获取对应的信号配置
   * @private
   * @param {string} signalType 信号类型
   * @returns {Object|null} 信号配置对象 {conditionGroups}
   */
  _getSignalConfigForType(signalType) {
    switch (signalType) {
      case SignalType.BUYCALL:
        return this.signalConfig.buycall;
      case SignalType.SELLCALL:
        return this.signalConfig.sellcall;
      case SignalType.BUYPUT:
        return this.signalConfig.buyput;
      case SignalType.SELLPUT:
        return this.signalConfig.sellput;
      default:
        return null;
    }
  }

  /**
   * 从指标状态中提取指定指标的值
   * @private
   * @param {Object} state 指标状态对象 {kdj, macd, ema}
   * @param {string} indicatorName 指标名称 (K, D, J, MACD, DIF, DEA, EMA:n)
   * @returns {number|null} 指标值，如果无效则返回 null
   */
  _getIndicatorValue(state, indicatorName) {
    const { kdj, macd, ema } = state;

    // 处理 EMA:n 格式（例如 EMA:5, EMA:10）
    if (indicatorName.startsWith("EMA:")) {
      const periodStr = indicatorName.substring(4); // 提取周期部分
      const period = parseInt(periodStr, 10);

      // 验证周期是否有效
      if (!Number.isFinite(period) || period < 1 || period > 250) {
        return null;
      }

      // 从 ema 对象中提取对应周期的值
      return ema && this._isValidNumber(ema[period]) ? ema[period] : null;
    }

    switch (indicatorName) {
      case "K":
        return kdj && this._isValidNumber(kdj.k) ? kdj.k : null;
      case "D":
        return kdj && this._isValidNumber(kdj.d) ? kdj.d : null;
      case "J":
        return kdj && this._isValidNumber(kdj.j) ? kdj.j : null;
      case "MACD":
        return macd && this._isValidNumber(macd.macd) ? macd.macd : null;
      case "DIF":
        return macd && this._isValidNumber(macd.dif) ? macd.dif : null;
      case "DEA":
        return macd && this._isValidNumber(macd.dea) ? macd.dea : null;
      default:
        return null;
    }
  }

  /**
   * 构建指标状态的显示字符串（用于日志）
   * @private
   * @param {Object} state 指标状态对象
   * @returns {string} 指标状态显示字符串
   */
  _buildIndicatorDisplayString(state) {
    const { rsi6, rsi12, mfi, kdj } = state;
    const parts = [];

    if (this._isValidNumber(rsi6)) {
      parts.push(`RSI6(${rsi6.toFixed(1)})`);
    }
    if (this._isValidNumber(rsi12)) {
      parts.push(`RSI12(${rsi12.toFixed(1)})`);
    }
    if (this._isValidNumber(mfi)) {
      parts.push(`MFI(${mfi.toFixed(1)})`);
    }
    if (kdj) {
      const kdjParts = [];
      if (this._isValidNumber(kdj.k)) {
        kdjParts.push(`K=${kdj.k.toFixed(2)}`);
      }
      if (this._isValidNumber(kdj.d)) {
        kdjParts.push(`D=${kdj.d.toFixed(1)}`);
      }
      if (this._isValidNumber(kdj.j)) {
        kdjParts.push(`J=${kdj.j.toFixed(2)}`);
      }
      if (kdjParts.length > 0) {
        parts.push(`KDJ(${kdjParts.join(",")})`);
      }
    }

    return parts.join("、");
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

    // 获取该信号类型的配置
    const signalConfig = this._getSignalConfigForType(action);
    if (!signalConfig) {
      return null;
    }

    // 使用配置评估信号条件
    const evalResult = evaluateSignalConfig(state, signalConfig);

    // 如果没有触发任何条件组，返回 null
    if (!evalResult.triggered) {
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
        let decimals = 2; // 默认 2 位小数
        if (["MACD", "DIF", "DEA"].includes(name)) {
          decimals = 4; // MACD 相关指标使用 4 位小数
        } else if (name.startsWith("EMA:")) {
          decimals = 3; // EMA 使用 3 位小数（类似于价格）
        }
        return `${name}1=${value.toFixed(decimals)}`;
      })
      .join(" ");

    // 构建指标状态显示字符串
    const indicatorDisplayStr = this._buildIndicatorDisplayString(state);

    return {
      symbol,
      action,
      triggerTime,
      indicators1, // 记录触发时的所有配置指标值
      verificationHistory: [], // 该信号专用的验证历史记录（每秒记录一次）
      reason: `${reasonPrefix}：${
        evalResult.reason
      }，${indicatorDisplayStr}，${indicators1Str}，将在 ${triggerTime.toLocaleString(
        "zh-CN",
        {
          timeZone: "Asia/Hong_Kong",
          hour12: false,
        }
      )} 进行验证`,
    };
  }

  /**
   * 生成立即执行的卖出信号
   * @private
   * @param {Object} state 监控标的的指标状态
   * @param {Object} position 持仓信息 {symbol, costPrice, quantity, availableQuantity}
   * @param {string} action 信号类型
   * @returns {Object|null} 立即执行的信号对象
   */
  _generateImmediateSignal(state, position, action) {
    // 检查是否有可卖出的持仓
    if (
      !position?.symbol ||
      !Number.isFinite(position.availableQuantity) ||
      position.availableQuantity <= 0
    ) {
      return null;
    }

    // 获取该信号类型的配置
    const signalConfig = this._getSignalConfigForType(action);
    if (!signalConfig) {
      return null;
    }

    // 使用配置评估信号条件
    const evalResult = evaluateSignalConfig(state, signalConfig);

    // 如果没有触发任何条件组，返回 null
    if (!evalResult.triggered) {
      return null;
    }

    // 构建指标状态显示字符串
    const indicatorDisplayStr = this._buildIndicatorDisplayString(state);

    // 生成卖出信号，成本价判断和卖出数量计算在卖出策略中进行
    return {
      symbol: position.symbol,
      action: action,
      reason: `${evalResult.reason}，${indicatorDisplayStr}`,
      signalTriggerTime: new Date(),
    };
  }

  /**
   * 生成基于持仓成本价的清仓信号和延迟验证的开仓信号
   * @param {Object} state 监控标的的指标状态 {rsi6, rsi12, mfi, kdj, price, macd}
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

    // 1. 买入做多标的（延迟验证策略）
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
    // 注意：卖出信号生成时无需判断成本价，成本价判断在卖出策略中进行
    const sellLongSignal = this._generateImmediateSignal(
      state,
      longPosition,
      SignalType.SELLCALL
    );
    if (sellLongSignal) {
      immediateSignals.push(sellLongSignal);
    }

    // 3. 买入做空标的（延迟验证策略）
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
    // 注意：卖出信号生成时无需判断成本价，成本价判断在卖出策略中进行
    const sellShortSignal = this._generateImmediateSignal(
      state,
      shortPosition,
      SignalType.SELLPUT
    );
    if (sellShortSignal) {
      immediateSignals.push(sellShortSignal);
    }

    return { immediateSignals, delayedSignals };
  }
}
