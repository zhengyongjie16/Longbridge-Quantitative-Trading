/**
 * MonitorTickUseCase
 *
 * 职责：
 * - 作为单 monitor tick 的应用层入口
 * - 将 trading-day gate policy 翻译为 processMonitor 所需的 runtime flags
 */
import { processMonitor } from '../../main/processMonitor/index.js';
import type { MonitorTickParams, MonitorTickUseCaseDeps } from './types.js';

/**
 * 创建单 monitor tick 用例。
 *
 * @param deps monitor tick 依赖
 * @returns execute()，供 mainProgram 在并发遍历 monitor 时调用
 */
export function createMonitorTickUseCase(deps: MonitorTickUseCaseDeps): {
  execute: (params: MonitorTickParams) => Promise<void>;
} {
  const { mainContext } = deps;

  async function execute(params: MonitorTickParams): Promise<void> {
    const { monitorContext, quotesMap, gatePolicy } = params;
    await processMonitor(
      {
        context: mainContext,
        monitorContext,
        runtimeFlags: {
          currentTime: gatePolicy.currentTime,
          isHalfDay: gatePolicy.isHalfDay,
          canTradeNow: gatePolicy.continuousSessionGateOpen,
          openProtectionActive: gatePolicy.openProtectionActive,
          isTradingEnabled: gatePolicy.executionGateOpen,
        },
      },
      quotesMap,
    );
  }

  return {
    execute,
  };
}
