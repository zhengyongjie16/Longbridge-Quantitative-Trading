/**
 * 多指标交易策略模块
 *
 * 功能：
 * - 基于 RSI、KDJ、MACD、MFI 等技术指标生成交易信号
 * - 支持可配置的信号条件格式
 * - 生成延迟验证信号（买入和卖出）
 *
 * 信号类型：
 * - BUYCALL：买入做多标的（延迟验证）
 * - SELLCALL：卖出做多标的（延迟验证）
 * - BUYPUT：买入做空标的（延迟验证）
 * - SELLPUT：卖出做空标的（延迟验证）
 *
 * 配置格式：(条件1,条件2,...)/N|(条件A)|(条件B,条件C)/M
 * - 括号内是条件列表，逗号分隔
 * - /N：括号内条件需满足 N 项
 * - |：分隔不同条件组，满足任一组即可
 */

import { evaluateSignalConfig } from '../../utils/signalConfigParser/index.js';
import { signalObjectPool } from '../../utils/objectPool/index.js';
import { getIndicatorValue, isValidNumber } from '../../utils/indicatorHelpers/index.js';
import type {
  Signal,
  IndicatorSnapshot,
  VerificationConfig,
  SignalConfig,
  SignalConfigSet,
  SignalType,
} from '../../types/index.js';
import type { StrategyConfig, SignalGenerationResult, HangSengMultiIndicatorStrategy } from './types.js';

// 常量定义
/**
 * 每秒的毫秒数
 * 用于时间单位转换（秒转毫秒）
 * 在计算延迟信号的触发时间时使用
 */
const MILLISECONDS_PER_SECOND = 1000;

/**
 * 创建恒生多指标策略
 * @param config 策略配置
 * @returns 策略实例
 */
export const createHangSengMultiIndicatorStrategy = ({
  signalConfig = null,
  verificationConfig = {
    buy: { delaySeconds: 60, indicators: ['K', 'MACD'] },
    sell: { delaySeconds: 60, indicators: ['K', 'MACD'] },
  },
}: Partial<StrategyConfig> = {}): HangSengMultiIndicatorStrategy => {
  // 配置通过闭包捕获（不可变）
  const finalSignalConfig: SignalConfigSet = signalConfig || {
    buycall: null,
    sellcall: null,
    buyput: null,
    sellput: null,
  };

  const finalVerificationConfig: VerificationConfig = verificationConfig || {
    buy: { delaySeconds: 60, indicators: ['K', 'MACD'] },
    sell: { delaySeconds: 60, indicators: ['K', 'MACD'] },
  };

  /**
   * 验证指标状态的基本指标（RSI, MFI, KDJ）
   */
  const validateBasicIndicators = (state: IndicatorSnapshot): boolean => {
    const { rsi, mfi, kdj } = state;

    // 检查 rsi 对象是否存在且至少有一个有效的周期值
    let hasValidRsi = false;
    if (rsi && typeof rsi === 'object') {
      for (const period in rsi) {
        if (isValidNumber(rsi[period as unknown as number])) {
          hasValidRsi = true;
          break;
        }
      }
    }

    const kdjData = kdj;

    return (
      hasValidRsi &&
      isValidNumber(mfi) &&
      kdjData !== null &&
      isValidNumber(kdjData.d) &&
      isValidNumber(kdjData.j)
    );
  };

  /**
   * 验证指标状态（包括 MACD 和价格）
   */
  const validateAllIndicators = (state: IndicatorSnapshot): boolean => {
    const { macd, price } = state;
    const macdData = macd as { macd?: number } | null;
    return (
      validateBasicIndicators(state) &&
      macdData !== null &&
      isValidNumber(macdData.macd) &&
      isValidNumber(price)
    );
  };

  /**
   * 计算延迟验证时间
   * @param isBuySignal 是否为买入信号（true=买入，false=卖出）
   */
  const calculateVerificationTime = (isBuySignal: boolean): Date | null => {
    const config = isBuySignal ? finalVerificationConfig.buy : finalVerificationConfig.sell;

    // 如果延迟时间为 0 或指标列表为空，则不进行延迟验证
    if (
      !config.delaySeconds ||
      config.delaySeconds === 0 ||
      !config.indicators ||
      config.indicators.length === 0
    ) {
      return null;
    }

    const now = new Date();
    const triggerTime = new Date(
      now.getTime() + config.delaySeconds * MILLISECONDS_PER_SECOND,
    );

    // 如果目标时间已经过去，说明计算有误，返回null
    if (triggerTime <= now) {
      return null;
    }

    return triggerTime;
  };

  /**
   * 根据信号类型获取对应的信号配置
   */
  const getSignalConfigForType = (signalType: string): SignalConfig | null => {
    switch (signalType) {
      case 'BUYCALL':
        return finalSignalConfig.buycall ?? null;
      case 'SELLCALL':
        return finalSignalConfig.sellcall ?? null;
      case 'BUYPUT':
        return finalSignalConfig.buyput ?? null;
      case 'SELLPUT':
        return finalSignalConfig.sellput ?? null;
      default:
        return null;
    }
  };

  /**
   * 构建指标状态的显示字符串（用于日志）
   */
  const buildIndicatorDisplayString = (state: IndicatorSnapshot): string => {
    const { rsi, mfi, kdj } = state;
    const parts: string[] = [];

    // 遍历所有 RSI 周期值
    if (rsi && typeof rsi === 'object') {
      // 按周期从小到大排序
      const periods = Object.keys(rsi)
        .map((p) => Number.parseInt(p, 10))
        .filter((p) => Number.isFinite(p))
        .sort((a, b) => a - b);
      for (const period of periods) {
        const rsiValue = rsi[period];
        if (isValidNumber(rsiValue)) {
          parts.push(`RSI${period}(${rsiValue.toFixed(3)})`);
        }
      }
    }
    if (isValidNumber(mfi)) {
      parts.push(`MFI(${mfi.toFixed(3)})`);
    }
    if (kdj) {
      const kdjData = kdj;
      const kdjParts: string[] = [];
      if (isValidNumber(kdjData.k)) {
        kdjParts.push(`K=${kdjData.k.toFixed(3)}`);
      }
      if (isValidNumber(kdjData.d)) {
        kdjParts.push(`D=${kdjData.d.toFixed(3)}`);
      }
      if (isValidNumber(kdjData.j)) {
        kdjParts.push(`J=${kdjData.j.toFixed(3)}`);
      }
      if (kdjParts.length > 0) {
        parts.push(`KDJ(${kdjParts.join(',')})`);
      }
    }

    return parts.join('、');
  };

  /**
   * 生成延迟验证信号（买入和卖出信号）
   */
  const generateDelayedSignal = (
    state: IndicatorSnapshot,
    symbol: string,
    action: string,
    reasonPrefix: string,
    orderRecorder: import('../../types/index.js').OrderRecorder | null,
    isLongSymbol: boolean,
  ): Signal | null => {
    // 验证所有必要的指标值是否有效
    if (!validateAllIndicators(state)) {
      return null;
    }

    // 对于卖出信号，先检查订单记录中是否有买入订单记录
    // 如果有买入订单记录，进入延迟验证阶段；如果没有，不进入延迟验证
    if (action === 'SELLCALL' || action === 'SELLPUT') {
      if (!orderRecorder) {
        // 无法获取订单记录，不生成卖出信号
        return null;
      }
      const buyOrders = orderRecorder.getBuyOrdersForSymbol(symbol, isLongSymbol);
      if (!buyOrders || buyOrders.length === 0) {
        // 没有买入订单记录，不生成卖出信号
        return null;
      }
      // 有买入订单记录，继续后续流程（进入延迟验证阶段）
    }

    // 获取该信号类型的配置
    const signalConfig = getSignalConfigForType(action);
    if (!signalConfig) {
      return null;
    }

    // 使用配置评估信号条件
    const evalResult = evaluateSignalConfig(state, signalConfig);

    // 如果没有触发任何条件组，返回 null
    if (!evalResult.triggered) {
      return null;
    }

    // 判断是买入还是卖出信号
    const isBuySignal = action === 'BUYCALL' || action === 'BUYPUT';
    const verificationConfig = isBuySignal ? finalVerificationConfig.buy : finalVerificationConfig.sell;

    const triggerTime = calculateVerificationTime(isBuySignal);
    // 如果不需要延迟验证（triggerTime 为 null），则返回 null
    // 这种情况下，信号应该被当作立即执行的信号处理
    if (!triggerTime) {
      return null;
    }

    // 记录当前配置的所有指标的初始值（indicators1）
    const indicators1: Record<string, number> = {};
    const indicatorsList = verificationConfig.indicators ?? [];
    for (const indicatorName of indicatorsList) {
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
      .join(' ');

    // 构建指标状态显示字符串
    const indicatorDisplayStr = buildIndicatorDisplayString(state);

    // 从对象池获取信号对象
    const signal = signalObjectPool.acquire() as Signal;
    signal.symbol = symbol;
    signal.action = action as SignalType;
    signal.triggerTime = triggerTime;
    signal.indicators1 = indicators1;
    signal.verificationHistory = [];
    signal.reason = `${reasonPrefix}：${
      evalResult.reason
    }，${indicatorDisplayStr}，${indicators1Str}，将在 ${triggerTime.toLocaleString(
      'zh-CN',
      {
        timeZone: 'Asia/Hong_Kong',
        hour12: false,
      },
    )} 进行验证`;

    return signal;
  };

  return {
    generateCloseSignals: (
      state: IndicatorSnapshot | null,
      longSymbol: string,
      shortSymbol: string,
      orderRecorder: import('../../types/index.js').OrderRecorder,
    ): SignalGenerationResult => {
      const immediateSignals: Signal[] = [];
      const delayedSignals: Signal[] = [];

      if (!state) {
        return { immediateSignals, delayedSignals };
      }

      // 验证所有必要的指标值是否有效
      if (!validateBasicIndicators(state)) {
        return { immediateSignals, delayedSignals };
      }

      // 1. 买入做多标的（延迟验证策略）
      if (longSymbol) {
        const delayedBuySignal = generateDelayedSignal(
          state,
          longSymbol,
          'BUYCALL',
          '延迟验证买入做多信号',
          orderRecorder,
          true,
        );
        if (delayedBuySignal) {
          delayedSignals.push(delayedBuySignal);
        }
      }

      // 2. 卖出做多标的的条件（延迟验证策略）
      // 注意：卖出信号生成时无需判断成本价，成本价判断在卖出策略中进行
      // 注意：买入订单记录就是持仓记录，只需检查订单记录即可（在generateDelayedSignal中检查）
      if (longSymbol) {
        const delayedSellLongSignal = generateDelayedSignal(
          state,
          longSymbol,
          'SELLCALL',
          '延迟验证卖出做多信号',
          orderRecorder,
          true,
        );
        if (delayedSellLongSignal) {
          delayedSignals.push(delayedSellLongSignal);
        }
      }

      // 3. 买入做空标的（延迟验证策略）
      if (shortSymbol) {
        const delayedSellSignal = generateDelayedSignal(
          state,
          shortSymbol,
          'BUYPUT',
          '延迟验证买入做空信号',
          orderRecorder,
          false,
        );
        if (delayedSellSignal) {
          delayedSignals.push(delayedSellSignal);
        }
      }

      // 4. 卖出做空标的的条件（延迟验证策略）
      // 注意：卖出信号生成时无需判断成本价，成本价判断在卖出策略中进行
      // 注意：买入订单记录就是持仓记录，只需检查订单记录即可（在generateDelayedSignal中检查）
      if (shortSymbol) {
        const delayedSellShortSignal = generateDelayedSignal(
          state,
          shortSymbol,
          'SELLPUT',
          '延迟验证卖出做空信号',
          orderRecorder,
          false,
        );
        if (delayedSellShortSignal) {
          delayedSignals.push(delayedSellShortSignal);
        }
      }

      return { immediateSignals, delayedSignals };
    },
  };
};
