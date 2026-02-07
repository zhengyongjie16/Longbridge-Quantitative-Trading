/**
 * DelayedSignalVerifier 实现
 *
 * 使用 setTimeout 自行计时进行延迟验证
 *
 * 验证逻辑：
 * - BUYCALL/SELLPUT：T0、T0+5s、T0+10s 的值都 > 初始值（上涨趋势）
 * - BUYPUT/SELLCALL：T0、T0+5s、T0+10s 的值都 < 初始值（下跌趋势）
 * - 所有配置的验证指标在所有 3 个时间点都必须满足条件
 *
 * 时间计算：
 * - triggerTime = signal.triggerTime（由 strategy 设置）
 * - verifyTime = triggerTime + READY_DELAY_SECONDS
 * - 验证时查询 IndicatorCache 获取 T0、T0+5s、T0+10s 的数据
 * - 时间容忍度为 ±5秒
 */
import { logger } from '../../../utils/logger/index.js';
import { signalObjectPool } from '../../../utils/objectPool/index.js';
import { formatSymbolDisplay, isBuyAction } from '../../../utils/helpers/index.js';
import { TIME, VERIFICATION, ACTION_DESCRIPTIONS } from '../../../constants/index.js';
import type { Signal } from '../../../types/index.js';
import type {
  DelayedSignalVerifier,
  DelayedSignalVerifierDeps,
  PendingSignalEntry,
  VerifiedCallback,
  RejectedCallback,
} from './types.js';
import { generateSignalId, extractInitialIndicators, performVerification } from './utils.js';

/**
 * 创建延迟信号验证器
 */
export function createDelayedSignalVerifier(
  deps: DelayedSignalVerifierDeps,
): DelayedSignalVerifier {
  const { indicatorCache, verificationConfig } = deps;

  // 待验证信号 Map（signalId -> entry）
  const pendingSignals = new Map<string, PendingSignalEntry>();

  // 回调函数列表
  const verifiedCallbacks: VerifiedCallback[] = [];
  const rejectedCallbacks: RejectedCallback[] = [];

  /**
   * 执行验证的内部函数
   */
  function executeVerification(signalId: string): void {
    const entry = pendingSignals.get(signalId);
    if (!entry) {
      return;
    }

    // 从待验证列表中移除
    pendingSignals.delete(signalId);

    const { signal, monitorSymbol } = entry;

    // 判断是买入还是卖出信号
    const isBuySignal = isBuyAction(signal.action);
    const currentConfig = isBuySignal ? verificationConfig.buy : verificationConfig.sell;

    // 执行验证
    const result = performVerification(indicatorCache, entry, currentConfig);
    const actionDesc = ACTION_DESCRIPTIONS[signal.action];

    if (result.passed) {
      logger.info(`[延迟验证通过] ${formatSymbolDisplay(signal.symbol, signal.symbolName ?? null)} ${actionDesc} | ${result.reason}`);

      // 通知所有验证通过的回调
      // 注意：验证通过的信号由买入/卖出处理器在消费任务后释放
      for (const callback of verifiedCallbacks) {
        try {
          callback(signal, monitorSymbol);
        } catch (err) {
          logger.error('[延迟验证] 执行 onVerified 回调时发生错误', err);
        }
      }
    } else {
      logger.info(`[延迟验证失败] ${formatSymbolDisplay(signal.symbol, signal.symbolName ?? null)} ${actionDesc} | ${result.reason}`);

      // 通知所有验证拒绝的回调
      for (const callback of rejectedCallbacks) {
        try {
          callback(signal, monitorSymbol, result.reason);
        } catch (err) {
          logger.error('[延迟验证] 执行 onRejected 回调时发生错误', err);
        }
      }

      // 验证失败的信号在此处释放回对象池
      signalObjectPool.release(signal);
    }
  }

  return {
    addSignal(signal: Signal, monitorSymbol: string): void {
      // 验证 triggerTime
      const symbolDisplay = formatSymbolDisplay(signal.symbol, signal.symbolName ?? null);
      if (!signal.triggerTime) {
        logger.warn(`[延迟验证] ${symbolDisplay} 缺少 triggerTime，无法添加到验证队列`);
        // 拒绝添加时释放信号对象
        signalObjectPool.release(signal);
        return;
      }

      const signalId = generateSignalId(signal);

      // 检查是否已存在（重复信号不添加，释放后返回）
      if (pendingSignals.has(signalId)) {
        logger.debug(`[延迟验证] ${symbolDisplay} 信号已存在于验证队列中，跳过添加`);
        // 重复信号释放回对象池
        signalObjectPool.release(signal);
        return;
      }

      // 判断是买入还是卖出信号
      const isBuySignal = isBuyAction(signal.action);
      const currentConfig = isBuySignal ? verificationConfig.buy : verificationConfig.sell;

      // 安全检查：指标配置
      if (!currentConfig.indicators || currentConfig.indicators.length === 0) {
        logger.warn(`[延迟验证] ${symbolDisplay} 验证指标配置为空，无法添加到验证队列`);
        // 拒绝添加时释放信号对象
        signalObjectPool.release(signal);
        return;
      }

      // 提取初始指标值
      const initialIndicators = extractInitialIndicators(signal, currentConfig.indicators);
      if (!initialIndicators) {
        logger.warn(`[延迟验证] ${symbolDisplay} 无法提取有效的初始指标值，无法添加到验证队列`);
        // 拒绝添加时释放信号对象
        signalObjectPool.release(signal);
        return;
      }

      const triggerTime = signal.triggerTime.getTime();
      const verifyTime = triggerTime + VERIFICATION.READY_DELAY_SECONDS * TIME.MILLISECONDS_PER_SECOND;
      const delayMs = Math.max(0, verifyTime - Date.now());

      // 创建定时器
      const timerId = setTimeout(() => {
        executeVerification(signalId);
      }, delayMs);

      // 添加到待验证列表
      const entry: PendingSignalEntry = {
        signal,
        monitorSymbol,
        triggerTime,
        verifyTime,
        initialIndicators,
        timerId,
      };
      pendingSignals.set(signalId, entry);
    },

    cancelAllForSymbol(monitorSymbol: string): void {
      const entriesToRemove: Array<{ signalId: string; signal: Signal }> = [];

      for (const [signalId, entry] of pendingSignals) {
        if (entry.monitorSymbol === monitorSymbol) {
          clearTimeout(entry.timerId);
          entriesToRemove.push({ signalId, signal: entry.signal });
        }
      }

      for (const { signalId, signal } of entriesToRemove) {
        pendingSignals.delete(signalId);
        // 取消时释放信号对象回对象池
        signalObjectPool.release(signal);
      }

      if (entriesToRemove.length > 0) {
        logger.debug(`[延迟验证] 已取消 ${monitorSymbol} 的 ${entriesToRemove.length} 个待验证信号`);
      }
    },

    cancelAllForDirection(monitorSymbol: string, direction: 'LONG' | 'SHORT'): number {
      const entriesToRemove: Array<{ signalId: string; signal: Signal }> = [];

      for (const [signalId, entry] of pendingSignals) {
        if (entry.monitorSymbol !== monitorSymbol) {
          continue;
        }
        const action = entry.signal.action;
        const isLongSignal = action === 'BUYCALL' || action === 'SELLCALL';
        const signalDirection = isLongSignal ? 'LONG' : 'SHORT';
        if (signalDirection !== direction) {
          continue;
        }
        clearTimeout(entry.timerId);
        entriesToRemove.push({ signalId, signal: entry.signal });
      }

      for (const { signalId, signal } of entriesToRemove) {
        pendingSignals.delete(signalId);
        signalObjectPool.release(signal);
      }

      if (entriesToRemove.length > 0) {
        logger.debug(
          `[延迟验证] 已取消 ${monitorSymbol} ${direction} 的 ${entriesToRemove.length} 个待验证信号`,
        );
      }

      return entriesToRemove.length;
    },

    getPendingCount(): number {
      return pendingSignals.size;
    },

    onVerified(callback: VerifiedCallback): void {
      verifiedCallbacks.push(callback);
    },

    onRejected(callback: RejectedCallback): void {
      rejectedCallbacks.push(callback);
    },

    destroy(): void {
      // 清除所有定时器并释放所有待验证的信号对象
      for (const entry of pendingSignals.values()) {
        clearTimeout(entry.timerId);
        signalObjectPool.release(entry.signal);
      }
      pendingSignals.clear();

      // 清空回调列表
      verifiedCallbacks.length = 0;
      rejectedCallbacks.length = 0;

      logger.debug('[延迟验证] 验证器已销毁');
    },
  };
}
