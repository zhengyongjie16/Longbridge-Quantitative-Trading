/**
 * app 延迟验证分流接线模块
 *
 * 职责：
 * - 为每个 DelayedSignalVerifier 注册通过回调
 * - 校验生命周期门禁、席位版本与当前席位标的
 * - 将验证通过的信号分流到买入或卖出任务队列
 */
import {
  describeSignalSeatValidationFailure,
  validateSignalSeat,
} from '../services/autoSymbolManager/utils.js';
import { formatSymbolDisplay, isSellAction } from '../utils/display/index.js';
import type { RegisterDelayedSignalHandlersParams } from './types.js';

/**
 * 注册所有监控标的的延迟验证通过回调。
 *
 * @param params 注册回调所需的共享状态、任务队列与信号释放函数
 * @returns 无返回值
 */
export function registerDelayedSignalHandlers(params: RegisterDelayedSignalHandlersParams): void {
  const { monitorContexts, lastState, buyTaskQueue, sellTaskQueue, logger, releaseSignal } = params;

  for (const [monitorSymbol, monitorContext] of monitorContexts) {
    monitorContext.delayedSignalVerifier.onVerified((signal, signalMonitorSymbol) => {
      const context = monitorContexts.get(signalMonitorSymbol);
      if (!context) {
        logger.warn(
          `[延迟验证通过] 未找到监控上下文，丢弃信号: ${formatSymbolDisplay(signal.symbol, signal.symbolName ?? null)} ${signal.action}`,
        );
        releaseSignal(signal);
        return;
      }

      const signalLabel = `${formatSymbolDisplay(signal.symbol, signal.symbolName ?? null)} ${signal.action}`;
      const discardSignal = (prefix: string): void => {
        logger.debug(`${prefix}: ${signalLabel}`);
        releaseSignal(signal);
      };

      if (!lastState.isTradingEnabled) {
        discardSignal('[延迟验证通过] 生命周期门禁关闭，丢弃信号');
        return;
      }

      const seatValidation = validateSignalSeat({
        monitorSymbol: signalMonitorSymbol,
        signal,
        symbolRegistry: context.symbolRegistry,
      });
      if (!seatValidation.valid) {
        discardSignal(
          `[延迟验证通过] ${describeSignalSeatValidationFailure(seatValidation)}，丢弃信号`,
        );
        return;
      }

      logger.debug(`[延迟验证通过] 信号推入任务队列: ${signalLabel}`);

      if (isSellAction(signal.action)) {
        sellTaskQueue.push({
          type: 'VERIFIED_SELL',
          data: signal,
          monitorSymbol: signalMonitorSymbol,
        });
        return;
      }

      buyTaskQueue.push({
        type: 'VERIFIED_BUY',
        data: signal,
        monitorSymbol: signalMonitorSymbol,
      });
    });

    logger.debug(
      `[DelayedSignalVerifier] 监控标的 ${formatSymbolDisplay(monitorSymbol, monitorContext.monitorSymbolName)} 的验证器已初始化`,
    );
  }
}
