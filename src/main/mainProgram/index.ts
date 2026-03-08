/**
 * 主程序模块（每秒执行一次的核心循环）
 *
 * 核心职责：
 * - 判断交易日和交易时段，控制程序运行状态
 * - 驱动交易日生命周期状态机（dayLifecycleManager.tick），统一维护 isTradingEnabled 与交易日快照
 * - 执行末日保护（收盘前撤单和清仓）
 * - 批量获取行情数据，协调所有监控标的的并发处理
 * - 管理订单监控和缓存刷新（账户、持仓、浮亏）
 *
 * 执行流程：
 * 1. 交易日/时段判断 → 2. 调用 dayLifecycleManager.tick 驱动生命周期 → 3. 同步冷却/亏损分段（lossOffsetLifecycleCoordinator.sync）
 * → 4. 末日保护检查 → 5. 批量获取行情
 * → 6. 并发处理监控标的 → 7. 订单监控与缓存刷新
 */
import { logger } from '../../utils/logger/index.js';
import { collectRuntimeQuoteSymbols, diffQuoteSymbols } from '../utils.js';
import type { MainProgramContext } from './types.js';
import { formatSymbolDisplay } from '../../utils/display/index.js';
import { formatError } from '../../utils/error/index.js';
import { createGatePolicyResolver } from '../../app/tradingDay/gatePolicyResolver.js';
import { createTradingDayTickUseCase } from '../../app/tradingDay/tradingDayTickUseCase.js';
import { createMonitorTickUseCase } from '../../app/tradingDay/monitorTickUseCase.js';
import {
  getHKDateKey,
  isInContinuousHKSession,
  isWithinAfternoonOpenProtection,
  isWithinMorningOpenProtection,
} from '../../utils/tradingTime/index.js';

/**
 * 主程序 - 每秒执行一次的核心循环
 *
 * 职责：
 * 1. 判断交易日和交易时段，并驱动 dayLifecycleManager.tick 更新 lifecycleState / isTradingEnabled
 * 2. 调用 lossOffsetLifecycleCoordinator.sync 维护买入冷却相关的亏损分段（即使非交易时段也照常推进）
 * 3. 在生命周期与门禁允许的前提下执行末日保护检查
 * 4. 批量获取行情数据
 * 5. 并发处理所有监控标的
 * 6. 执行订单监控和缓存刷新
 *
 * @param context 主程序上下文，包含所有必要的依赖
 */
export async function mainProgram({
  marketDataClient,
  trader,
  lastState,
  marketMonitor,
  doomsdayProtection,
  signalProcessor,
  tradingConfig,
  dailyLossTracker,
  monitorContexts,
  symbolRegistry,
  indicatorCache,
  buyTaskQueue,
  sellTaskQueue,
  monitorTaskQueue,
  orderMonitorWorker,
  postTradeRefresher,
  lossOffsetLifecycleCoordinator,
  runtimeGateMode,
  dayLifecycleManager,
  systemRuntimeStateStore,
}: MainProgramContext): Promise<void> {
  const gatePolicyResolver = createGatePolicyResolver({
    marketDataClient,
    lastState,
    tradingConfig,
    monitorContexts,
    runtimeGateMode,
    logger,
    getHKDateKey,
    isInContinuousHKSession,
    isWithinMorningOpenProtection,
    isWithinAfternoonOpenProtection,
    ...(systemRuntimeStateStore ? { systemRuntimeStateStore } : {}),
  });
  const tradingDayTickUseCase = createTradingDayTickUseCase({
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
  });
  const tickResult = await tradingDayTickUseCase.execute();
  if (!tickResult.shouldProcessMainFlow) {
    return;
  }

  const { gatePolicy, positions } = tickResult;

  // 收集所有需要获取行情的标的，一次性批量获取（减少 API 调用次数）
  const orderHoldSymbols = trader.getOrderHoldSymbols();
  const desiredSymbols = collectRuntimeQuoteSymbols(
    tradingConfig.monitors,
    symbolRegistry,
    positions,
    orderHoldSymbols,
  );
  const { added, removed } = diffQuoteSymbols(lastState.allTradingSymbols, desiredSymbols);
  if (added.length > 0) {
    await marketDataClient.subscribeSymbols(added);
  }

  const removableSymbols = removed.filter((symbol) => lastState.positionCache.get(symbol) === null);
  if (removableSymbols.length > 0) {
    await marketDataClient.unsubscribeSymbols(removableSymbols);
  }

  const nextSymbols = new Set(lastState.allTradingSymbols);
  for (const symbol of added) {
    nextSymbols.add(symbol);
  }

  for (const symbol of removableSymbols) {
    nextSymbols.delete(symbol);
  }

  lastState.allTradingSymbols = nextSymbols;
  const quotesMap = await marketDataClient.getQuotes(nextSymbols);
  const mainContext: MainProgramContext = {
    marketDataClient,
    trader,
    lastState,
    marketMonitor,
    doomsdayProtection,
    signalProcessor,
    tradingConfig,
    dailyLossTracker,
    monitorContexts,
    symbolRegistry,
    indicatorCache,
    buyTaskQueue,
    sellTaskQueue,
    monitorTaskQueue,
    orderMonitorWorker,
    postTradeRefresher,
    lossOffsetLifecycleCoordinator,
    runtimeGateMode,
    dayLifecycleManager,
  };
  const monitorTickUseCase = createMonitorTickUseCase({
    mainContext,
  });

  // 并发处理所有监控标的（使用预先获取的行情数据）
  const monitorTasks: Promise<void>[] = [];
  for (const [monitorSymbol, monitorContext] of monitorContexts) {
    monitorTasks.push(
      monitorTickUseCase.execute(
        {
          monitorContext,
          quotesMap,
          gatePolicy,
        },
      ).catch((err: unknown) => {
        logger.error(
          `处理监控标的 ${formatSymbolDisplay(monitorSymbol, monitorContext.monitorSymbolName)} 失败`,
          formatError(err),
        );
      }),
    );
  }

  await Promise.allSettled(monitorTasks);

  // 全局操作：订单监控（在所有监控标的处理完成后）
  // 使用已维护的 allTradingSymbols
  if (gatePolicy.continuousSessionGateOpen && lastState.allTradingSymbols.size > 0) {
    orderMonitorWorker.schedule(quotesMap);
    postTradeRefresher.enqueue({
      pending: trader.getAndClearPendingRefreshSymbols(),
      quotesMap,
    });
  }
}
