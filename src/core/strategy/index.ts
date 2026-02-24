/**
 * 多指标交易策略模块
 *
 * 功能：
 * - 基于 RSI、KDJ、MACD、MFI 等技术指标生成交易信号
 * - 支持可配置的信号条件格式
 * - 根据信号验证配置决定是否延迟验证（买入和卖出）
 *
 * 信号类型：
 * - BUYCALL：买入做多标的（是否延迟验证取决于配置）
 * - SELLCALL：卖出做多标的（是否延迟验证取决于配置）
 * - BUYPUT：买入做空标的（是否延迟验证取决于配置）
 * - SELLPUT：卖出做空标的（是否延迟验证取决于配置）
 * - HOLD：持有（不执行交易）
 *
 * 配置格式：(条件1,条件2,...)/N|(条件A)|(条件B,条件C)/M
 * - 括号内是条件列表，逗号分隔
 * - /N：括号内条件需满足 N 项
 * - |：分隔不同条件组，满足任一组即可
 */
import { logger } from '../../utils/logger/index.js';
import { evaluateSignalConfig } from '../../utils/helpers/signalConfigParser.js';
import { isBuyAction, isSellAction } from '../../utils/helpers/index.js';
import { signalObjectPool, indicatorRecordPool } from '../../utils/objectPool/index.js';
import { getIndicatorValue } from '../../utils/helpers/indicatorHelpers.js';
import { TIME } from '../../constants/index.js';
import type { Signal, SignalType } from '../../types/signal.js';
import type { IndicatorSnapshot } from '../../types/quote.js';
import type { VerificationConfig, SignalConfigSet } from '../../types/config.js';
import type { SignalConfig } from '../../types/signalConfig.js';
import type { OrderRecorder } from '../../types/services.js';
import type {
  StrategyConfig,
  SignalGenerationResult,
  HangSengMultiIndicatorStrategy,
  SignalTypeCategory,
  SignalWithCategory,
} from './types.js';
import {
  needsDelayedVerification,
  validateBasicIndicators,
  validateAllIndicators,
  buildIndicatorDisplayString,
  pushSignalToCorrectArray,
} from './utils.js';

/**
 * 创建恒生多指标策略
 * @param config - 包含 signalConfig 和 verificationConfig 的策略配置对象
 * @returns HangSengMultiIndicatorStrategy 实例
 */
export const createHangSengMultiIndicatorStrategy = ({
  signalConfig = null,
  verificationConfig = {
    buy: { delaySeconds: 60, indicators: ['K', 'MACD'] },
    sell: { delaySeconds: 60, indicators: ['K', 'MACD'] },
  },
}: Partial<StrategyConfig> = {}): HangSengMultiIndicatorStrategy => {
  const finalSignalConfig: SignalConfigSet = signalConfig ?? {
    buycall: null,
    sellcall: null,
    buyput: null,
    sellput: null,
  };

  const finalVerificationConfig: VerificationConfig = verificationConfig;

  const signalTypeMap: Record<string, SignalTypeCategory> = {
    BUYCALL: needsDelayedVerification(finalVerificationConfig.buy) ? 'delayed' : 'immediate',
    SELLCALL: needsDelayedVerification(finalVerificationConfig.sell) ? 'delayed' : 'immediate',
    BUYPUT: needsDelayedVerification(finalVerificationConfig.buy) ? 'delayed' : 'immediate',
    SELLPUT: needsDelayedVerification(finalVerificationConfig.sell) ? 'delayed' : 'immediate',
  };

  /**
   * 计算延迟验证触发时间
   * @param isBuySignal true=买入信号，false=卖出信号
   * @returns 触发时间，null 表示无需延迟验证
   */
  const calculateVerificationTime = (isBuySignal: boolean): Date | null => {
    const config = isBuySignal ? finalVerificationConfig.buy : finalVerificationConfig.sell;

    // 如果延迟时间为 0 或指标列表为空，则不进行延迟验证
    if (!config.delaySeconds || !config.indicators?.length) {
      return null;
    }

    // 使用 Date.now() 获取时间戳，只创建一个 Date 对象（triggerTime）
    const nowTimestamp = Date.now();
    const triggerTimestamp = nowTimestamp + config.delaySeconds * TIME.MILLISECONDS_PER_SECOND;

    // 防御性检查：如果目标时间已经过去（配置错误或负数延迟），返回null
    if (triggerTimestamp <= nowTimestamp) {
      return null;
    }

    return new Date(triggerTimestamp);
  };

  /**
   * 获取信号类型对应的配置
   * @param signalType 信号类型（BUYCALL/SELLCALL/BUYPUT/SELLPUT）
   * @returns 对应的 SignalConfig，无配置时返回 null
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
   * 生成交易信号
   *
   * 流程：验证指标 → 检查卖出条件 → 评估信号配置 → 创建信号对象
   *
   * @param state 当前指标快照
   * @param symbol 标的代码
   * @param action 信号类型
   * @param reasonPrefix 信号原因前缀
   * @param orderRecorder 订单记录器
   * @param isLongSymbol 是否为做多标的
   * @returns 带分类的信号，null 表示不生成信号
   */
  const generateSignal = (
    state: IndicatorSnapshot,
    symbol: string,
    action: string,
    reasonPrefix: string,
    orderRecorder: OrderRecorder | null,
    isLongSymbol: boolean,
  ): SignalWithCategory | null => {
    // 验证所有必要的指标值是否有效
    if (!validateAllIndicators(state)) {
      logger.debug(`[策略] ${symbol} ${action} 指标未通过校验，不生成信号`);
      return null;
    }

    // 对于卖出信号，先检查订单记录中是否有买入订单记录
    // 如果有买入订单记录，进入验证阶段；如果没有，不生成卖出信号
    if (isSellAction(action as SignalType)) {
      if (!orderRecorder) {
        logger.debug(`[策略] ${symbol} ${action} 订单记录不可用，不生成卖出信号`);
        return null;
      }
      const buyOrders = orderRecorder.getBuyOrdersForSymbol(symbol, isLongSymbol);
      if (buyOrders.length === 0) {
        return null;
      }
      // 有买入订单记录，继续后续流程
    }

    // 获取该信号类型的配置
    const signalConfigForAction = getSignalConfigForType(action);
    if (!signalConfigForAction) {
      logger.debug(`[策略] ${symbol} ${action} 无该信号类型配置，不生成信号`);
      return null;
    }

    // 使用配置评估信号条件
    const evalResult = evaluateSignalConfig(state, signalConfigForAction);

    // 如果没有触发任何条件组，返回 null
    if (!evalResult.triggered) {
      return null;
    }

    // 判断是买入还是卖出信号
    const isBuySignal = isBuyAction(action as SignalType);
    const currentVerificationConfig = isBuySignal
      ? finalVerificationConfig.buy
      : finalVerificationConfig.sell;

    // 根据预计算的信号类型映射判断是立即信号还是延迟信号
    const isImmediate = signalTypeMap[action] === 'immediate';

    if (isImmediate) {
      // 生成立即执行信号（不需要延迟验证）
      const indicatorDisplayStr = buildIndicatorDisplayString(state);

      // 从对象池获取信号对象
      const signal = signalObjectPool.acquire() as Signal;
      signal.symbol = symbol;
      signal.action = action as SignalType;
      signal.triggerTime = new Date(); // 立即信号的触发时间为当前时间
      signal.indicators1 = null;
      signal.verificationHistory = null;
      signal.reason = `${reasonPrefix}（立即执行）：${evalResult.reason}，${indicatorDisplayStr}`;

      return { signal, isImmediate: true };
    }

    // 生成延迟验证信号
    const triggerTime = calculateVerificationTime(isBuySignal);
    if (!triggerTime) {
      // 理论上不会发生，因为 isImmediate 已经处理了这种情况
      return null;
    }

    // 记录当前配置的所有指标的初始值（indicators1）
    // 从对象池获取 indicators1 对象，减少内存分配
    const indicators1 = indicatorRecordPool.acquire();
    const indicatorsList = currentVerificationConfig.indicators ?? [];
    for (const indicatorName of indicatorsList) {
      const value = getIndicatorValue(state, indicatorName);
      if (value === null) {
        logger.debug(
          `[策略] ${symbol} ${action} 延迟验证指标 ${indicatorName} 值无效，不生成延迟信号`,
        );
        indicatorRecordPool.release(indicators1);
        return null;
      }
      indicators1[indicatorName] = value;
    }

    // 构建指标值的显示字符串（用于日志）
    const indicators1Str = Object.entries(indicators1)
      .map(([name, value]) => `${name}1=${value.toFixed(3)}`)
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
    }，${indicatorDisplayStr}，${indicators1Str}，将在 ${triggerTime.toLocaleString('zh-CN', {
      timeZone: 'Asia/Hong_Kong',
      hour12: false,
    })} 进行验证`;

    return { signal, isImmediate: false };
  };

  return {
    /**
     * 生成交易信号
     *
     * 依次评估做多/做空标的的买入和卖出条件，生成立即或延迟验证信号。
     * 卖出信号需要订单记录中存在对应买入订单才会生成。
     *
     * @param state 当前指标快照，为 null 时不生成任何信号
     * @param longSymbol 做多标的代码
     * @param shortSymbol 做空标的代码
     * @param orderRecorder 订单记录器
     * @returns 立即信号列表和延迟信号列表
     */
    generateCloseSignals: (
      state: IndicatorSnapshot | null,
      longSymbol: string,
      shortSymbol: string,
      orderRecorder: OrderRecorder,
    ): SignalGenerationResult => {
      const immediateSignals: Signal[] = [];
      const delayedSignals: Signal[] = [];

      if (!state) {
        logger.debug('[策略] 无指标快照，不生成任何信号');
        return { immediateSignals, delayedSignals };
      }

      // 验证所有必要的指标值是否有效
      if (!validateBasicIndicators(state)) {
        logger.debug('[策略] 基础指标未通过，不生成信号');
        return { immediateSignals, delayedSignals };
      }

      // 1. 买入做多标的
      if (longSymbol) {
        const buyLongResult = generateSignal(
          state,
          longSymbol,
          'BUYCALL',
          '买入做多信号',
          orderRecorder,
          true,
        );
        pushSignalToCorrectArray(buyLongResult, immediateSignals, delayedSignals);
      }

      // 2. 卖出做多标的
      // 注意：卖出信号生成时不做智能平仓判断，卖出数量由 signalProcessor 统一计算
      // 注意：检查订单记录以确定是否有持仓（在 generateSignal 中检查）
      if (longSymbol) {
        const sellLongResult = generateSignal(
          state,
          longSymbol,
          'SELLCALL',
          '卖出做多信号',
          orderRecorder,
          true,
        );
        pushSignalToCorrectArray(sellLongResult, immediateSignals, delayedSignals);
      }

      // 3. 买入做空标的
      if (shortSymbol) {
        const buyShortResult = generateSignal(
          state,
          shortSymbol,
          'BUYPUT',
          '买入做空信号',
          orderRecorder,
          false,
        );
        pushSignalToCorrectArray(buyShortResult, immediateSignals, delayedSignals);
      }

      // 4. 卖出做空标的
      if (shortSymbol) {
        const sellShortResult = generateSignal(
          state,
          shortSymbol,
          'SELLPUT',
          '卖出做空信号',
          orderRecorder,
          false,
        );
        pushSignalToCorrectArray(sellShortResult, immediateSignals, delayedSignals);
      }

      return { immediateSignals, delayedSignals };
    },
  };
};
