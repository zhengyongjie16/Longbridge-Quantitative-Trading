/**
 * 多指标交易策略模块
 *
 * 功能：
 * - 基于 RSI、KDJ、MACD、MFI 等技术指标生成交易信号
 * - 支持可配置的信号条件格式
 * - 生成两类信号：立即信号（卖出）和延迟信号（买入）
 *
 * 信号类型：
 * - BUYCALL：买入做多标的（延迟验证）
 * - SELLCALL：卖出做多标的（立即执行）
 * - BUYPUT：买入做空标的（延迟验证）
 * - SELLPUT：卖出做空标的（立即执行）
 *
 * 配置格式：(条件1,条件2,...)/N|(条件A)|(条件B,条件C)/M
 * - 括号内是条件列表，逗号分隔
 * - /N：括号内条件需满足 N 项
 * - |：分隔不同条件组，满足任一组即可
 */

import { SignalType } from "../utils/constants.js";
import { evaluateSignalConfig } from "../utils/signalConfigParser.js";
import { signalObjectPool } from "../utils/objectPool.js";
import { getIndicatorValue, isValidNumber } from "../utils/indicatorHelpers.js";

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
   * 验证指标状态的基本指标（RSI, MFI, KDJ）
   * @private
   * @param {Object} state 指标状态对象
   * @returns {boolean} 如果所有基本指标有效返回 true，否则返回 false
   */
  _validateBasicIndicators(state) {
    const { rsi, mfi, kdj } = state;

    // 检查 rsi 对象是否存在且至少有一个有效的周期值
    let hasValidRsi = false;
    if (rsi && typeof rsi === 'object') {
      for (const period in rsi) {
        if (isValidNumber(rsi[period])) {
          hasValidRsi = true;
          break;
        }
      }
    }

    return (
      hasValidRsi &&
      isValidNumber(mfi) &&
      kdj &&
      isValidNumber(kdj.d) &&
      isValidNumber(kdj.j)
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
      isValidNumber(macd.macd) &&
      isValidNumber(price)
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
   * 构建指标状态的显示字符串（用于日志）
   * @private
   * @param {Object} state 指标状态对象
   * @returns {string} 指标状态显示字符串
   */
  _buildIndicatorDisplayString(state) {
    const { rsi, mfi, kdj } = state;
    const parts = [];

    // 遍历所有 RSI 周期值
    if (rsi && typeof rsi === 'object') {
      // 按周期从小到大排序
      const periods = Object.keys(rsi).map(p => parseInt(p, 10)).filter(p => Number.isFinite(p)).sort((a, b) => a - b);
      for (const period of periods) {
        if (isValidNumber(rsi[period])) {
          parts.push(`RSI${period}(${rsi[period].toFixed(3)})`);
        }
      }
    }
    if (isValidNumber(mfi)) {
      parts.push(`MFI(${mfi.toFixed(3)})`);
    }
    if (kdj) {
      const kdjParts = [];
      if (isValidNumber(kdj.k)) {
        kdjParts.push(`K=${kdj.k.toFixed(3)}`);
      }
      if (isValidNumber(kdj.d)) {
        kdjParts.push(`D=${kdj.d.toFixed(3)}`);
      }
      if (isValidNumber(kdj.j)) {
        kdjParts.push(`J=${kdj.j.toFixed(3)}`);
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
      const value = getIndicatorValue(state, indicatorName);
      if (value === null) {
        // 如果任何配置的指标值无效，则无法生成延迟验证信号
        return null;
      }
      indicators1[indicatorName] = value;
    }

    // 构建指标值的显示字符串（用于日志）
    const indicators1Str = Object.entries(indicators1)
      .map(([name, value]) => {
        // 统一使用 3 位小数
        const decimals = 3;
        return `${name}1=${value.toFixed(decimals)}`;
      })
      .join(" ");

    // 构建指标状态显示字符串
    const indicatorDisplayStr = this._buildIndicatorDisplayString(state);

    // 从对象池获取信号对象
    const signal = signalObjectPool.acquire();
    signal.symbol = symbol;
    signal.action = action;
    signal.triggerTime = triggerTime;
    signal.indicators1 = indicators1;
    signal.verificationHistory = [];
    signal.reason = `${reasonPrefix}：${
      evalResult.reason
    }，${indicatorDisplayStr}，${indicators1Str}，将在 ${triggerTime.toLocaleString(
      "zh-CN",
      {
        timeZone: "Asia/Hong_Kong",
        hour12: false,
      }
    )} 进行验证`;

    return signal;
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

    // 从对象池获取信号对象
    const signal = signalObjectPool.acquire();
    signal.symbol = position.symbol;
    signal.action = action;
    signal.reason = `${evalResult.reason}，${indicatorDisplayStr}`;
    signal.signalTriggerTime = new Date();

    return signal;
  }

  /**
   * 生成基于持仓成本价的清仓信号和延迟验证的开仓信号
   * @param {Object} state 监控标的的指标状态 {rsi: {6: value, 12: value, ...}, mfi, kdj, price, macd, ema: {5: value, 7: value, ...}}
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
