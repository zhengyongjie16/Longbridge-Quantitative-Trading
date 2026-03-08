/**
 * TradingDayTickUseCase
 *
 * 职责：
 * - 固化主循环单次 tick 的高层时序：lifecycle inputs -> lifecycle tick -> final gate snapshot -> 冷却同步 -> doomsday
 * - 对 mainProgram 暴露单一结果，减少主循环对细碎门禁状态的直接感知
 */
import type { TradingDayTickResult, TradingDayTickUseCaseDeps } from './types.js';

/**
 * 创建 trading-day tick 用例。
 *
 * @param deps trading-day tick 依赖
 * @returns execute()，单次主循环先执行该用例，再消费最终 gate 进入行情与 monitor 分支
 */
export function createTradingDayTickUseCase(deps: TradingDayTickUseCaseDeps): {
  execute: () => Promise<TradingDayTickResult>;
} {
  const {
    gatePolicyResolver,
    lastState,
    marketDataClient,
    tradingConfig,
    monitorContexts,
    trader,
    doomsdayProtection,
    lossOffsetLifecycleCoordinator,
    dayLifecycleManager,
    logger,
  } = deps;

  async function execute(): Promise<TradingDayTickResult> {
    const currentTime = new Date();
    const runtimeInputs = await gatePolicyResolver.resolveLifecycleInputs(currentTime);

    await dayLifecycleManager.tick(currentTime, {
      dayKey: runtimeInputs.dayKey,
      canTradeNow: runtimeInputs.canTradeNow,
      isTradingDay: runtimeInputs.isTradingDay,
    });

    const gatePolicy = gatePolicyResolver.resolveFinalPolicy({
      runtimeInputs,
      lifecycleState: lastState.lifecycleState,
      isTradingEnabled: lastState.isTradingEnabled,
    });

    await lossOffsetLifecycleCoordinator.sync(currentTime.getTime());

    const positions = lastState.cachedPositions;
    if (!gatePolicy.executionGateOpen) {
      return {
        gatePolicy,
        positions,
        shouldProcessMainFlow: false,
      };
    }

    if (!gatePolicy.continuousSessionGateOpen) {
      return {
        gatePolicy,
        positions,
        shouldProcessMainFlow: false,
      };
    }

    if (tradingConfig.global.doomsdayProtection) {
      const cancelResult = await doomsdayProtection.cancelPendingBuyOrders({
        currentTime,
        isHalfDay: gatePolicy.isHalfDay,
        monitorConfigs: tradingConfig.monitors,
        monitorContexts,
        trader,
      });
      if (cancelResult.executed && cancelResult.cancelledCount > 0) {
        logger.info(
          `[末日保护程序] 收盘前15分钟撤单完成，共撤销 ${cancelResult.cancelledCount} 个买入订单`,
        );
      }

      const clearanceResult = await doomsdayProtection.executeClearance({
        currentTime,
        isHalfDay: gatePolicy.isHalfDay,
        positions,
        monitorConfigs: tradingConfig.monitors,
        monitorContexts,
        trader,
        marketDataClient,
        lastState,
      });
      if (clearanceResult.executed) {
        return {
          gatePolicy,
          positions,
          shouldProcessMainFlow: false,
        };
      }
    }

    return {
      gatePolicy,
      positions,
      shouldProcessMainFlow: true,
    };
  }

  return {
    execute,
  };
}
