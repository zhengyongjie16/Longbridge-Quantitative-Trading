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
import { processMonitor } from '../processMonitor/index.js';
import type { MainProgramContext } from './types.js';
import { formatSymbolDisplay } from '../../utils/display/index.js';
import { formatError } from '../../utils/error/index.js';
import {
  getHKDateKey,
  isInContinuousHKSession,
  isWithinAfternoonOpenProtection,
  isWithinMorningOpenProtection,
} from '../../utils/time/index.js';

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
}: MainProgramContext): Promise<void> {
  // 判断是否在交易时段（使用当前系统时间）
  const currentTime = new Date();
  const isStrictMode = runtimeGateMode === 'strict';

  // dailyLossTracker 日切重置由 lifecycle riskDomain.midnightClear 统一驱动，此处不再重复
  const currentDayKey = getHKDateKey(currentTime);
  let isTradingDayToday = lastState.cachedTradingDayInfo?.isTradingDay ?? true;
  let isHalfDayToday = lastState.cachedTradingDayInfo?.isHalfDay ?? false;
  if (!lastState.cachedTradingDayInfo && isStrictMode) {
    try {
      const tradingDayInfo = await marketDataClient.isTradingDay(currentTime);
      isTradingDayToday = tradingDayInfo.isTradingDay;
      isHalfDayToday = tradingDayInfo.isHalfDay;
      lastState.cachedTradingDayInfo = {
        isTradingDay: isTradingDayToday,
        isHalfDay: isHalfDayToday,
      };

      if (isTradingDayToday) {
        const dayType = isHalfDayToday ? '半日交易日' : '交易日';
        logger.info(`今天是${dayType}`);
      } else {
        logger.info('今天不是交易日');
      }
    } catch (err) {
      isTradingDayToday = false;
      isHalfDayToday = false;
      logger.warn('无法获取交易日信息，进入保护性暂停（按非交易日处理）', formatError(err));
    }
  }

  let canTradeNow = true;
  let openProtectionActive = false;
  if (isStrictMode) {
    if (isTradingDayToday) {
      canTradeNow = isInContinuousHKSession(currentTime, isHalfDayToday);
    } else {
      canTradeNow = false;
      if (lastState.canTrade !== false) {
        logger.info('今天不是交易日，暂停实时监控。');
      }
    }

    if (lastState.canTrade !== canTradeNow) {
      if (canTradeNow) {
        const sessionType = isHalfDayToday ? '（半日交易）' : '';
        logger.info(`进入连续交易时段${sessionType}，开始正常交易。`);
      } else if (isTradingDayToday) {
        logger.info('当前为竞价或非连续交易时段，暂停实时监控。');
        let totalCancelled = 0;
        for (const [monitorSymbol, monitorContext] of monitorContexts) {
          const pendingCount = monitorContext.delayedSignalVerifier.getPendingCount();
          if (pendingCount > 0) {
            monitorContext.delayedSignalVerifier.cancelAllForSymbol(monitorSymbol);
            totalCancelled += pendingCount;
          }
        }

        if (totalCancelled > 0) {
          logger.info(`[交易时段结束] 已清理 ${totalCancelled} 个待验证信号`);
        }
      }
    }

    lastState.canTrade = canTradeNow;
    lastState.isHalfDay = isHalfDayToday;
    if (canTradeNow) {
      const { morning, afternoon } = tradingConfig.global.openProtection;
      const morningActive =
        morning.enabled &&
        morning.minutes !== null &&
        isWithinMorningOpenProtection(currentTime, morning.minutes);
      const afternoonActive =
        !isHalfDayToday &&
        afternoon.enabled &&
        afternoon.minutes !== null &&
        isWithinAfternoonOpenProtection(currentTime, afternoon.minutes);
      openProtectionActive = morningActive || afternoonActive;
      const anyProtectionEnabled =
        (morning.enabled && morning.minutes !== null) ||
        (!isHalfDayToday && afternoon.enabled && afternoon.minutes !== null);
      if (anyProtectionEnabled && lastState.openProtectionActive !== openProtectionActive) {
        if (openProtectionActive) {
          const message = morningActive
            ? `[开盘保护] 早盘开盘后 ${morning.minutes} 分钟内暂停信号生成`
            : `[开盘保护] 午盘开盘后 ${afternoon.minutes ?? ''} 分钟内暂停信号生成`;
          logger.info(message);
        } else if (lastState.openProtectionActive !== null) {
          logger.info('[开盘保护] 保护期结束，恢复信号生成');
        }
      }

      lastState.openProtectionActive = openProtectionActive;
    } else {
      lastState.openProtectionActive = false;
    }
  } else {
    if (lastState.canTrade !== true) {
      logger.info('[运行模式] 已跳过交易时段检查');
    }

    lastState.canTrade = true;
    lastState.isHalfDay = isHalfDayToday;
    lastState.openProtectionActive = false;
  }

  await dayLifecycleManager.tick(currentTime, {
    dayKey: currentDayKey,
    canTradeNow,
    isTradingDay: isTradingDayToday,
  });

  // 冷却过期扫描与分段切换：即使 canTradeNow=false 也必须执行，防止分段边界漂移
  await lossOffsetLifecycleCoordinator.sync(currentTime.getTime());

  if (!lastState.isTradingEnabled) {
    return;
  }

  if (isStrictMode && (!isTradingDayToday || !canTradeNow)) {
    return;
  }

  // 使用 lifecycle tick 后的最新持仓缓存
  const positions = lastState.cachedPositions;

  // 末日保护检查（全局性，在所有监控标的处理之前）
  if (tradingConfig.global.doomsdayProtection) {
    // 收盘前15分钟：撤销所有未成交的买入订单
    const cancelResult = await doomsdayProtection.cancelPendingBuyOrders({
      currentTime,
      isHalfDay: isHalfDayToday,
      monitorConfigs: tradingConfig.monitors,
      monitorContexts,
      trader,
    });
    if (cancelResult.executed && cancelResult.cancelRequestAcceptedCount > 0) {
      logger.info(
        `[末日保护程序] 收盘前15分钟已提交撤单请求，共 ${cancelResult.cancelRequestAcceptedCount} 个买入订单，终态以后续 WS 为准`,
      );
    }

    // 收盘前5分钟：自动清仓所有持仓
    const clearanceResult = await doomsdayProtection.executeClearance({
      currentTime,
      isHalfDay: isHalfDayToday,
      positions,
      monitorConfigs: tradingConfig.monitors,
      monitorContexts,
      trader,
      marketDataClient,
      lastState,
    });
    if (clearanceResult.executed) {
      // 末日保护已执行清仓，跳过本次循环的监控标的处理
      return;
    }
  }

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

  // 并发处理所有监控标的（使用预先获取的行情数据）
  const monitorTasks: Promise<void>[] = [];
  for (const [monitorSymbol, monitorContext] of monitorContexts) {
    monitorTasks.push(
      processMonitor(
        {
          context: mainContext,
          monitorContext,
          runtimeFlags: {
            currentTime,
            isHalfDay: isHalfDayToday,
            canTradeNow,
            openProtectionActive,
            isTradingEnabled: lastState.isTradingEnabled,
          },
        },
        quotesMap,
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
  if (canTradeNow && lastState.allTradingSymbols.size > 0) {
    orderMonitorWorker.schedule(quotesMap);
    postTradeRefresher.enqueue({
      pending: trader.getAndClearPendingRefreshSymbols(),
      quotesMap,
    });
  }
}
