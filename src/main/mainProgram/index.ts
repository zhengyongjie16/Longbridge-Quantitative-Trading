/**
 * @module mainProgram
 * @description 主程序模块 - 每秒执行一次的核心循环
 *
 * 核心职责：
 * - 判断交易日和交易时段，控制程序运行状态
 * - 执行末日保护（收盘前撤单和清仓）
 * - 批量获取行情数据，协调所有监控标的的并发处理
 * - 管理订单监控和缓存刷新（账户、持仓、浮亏）
 *
 * 执行流程：
 * 1. 交易日/时段判断 → 2. 末日保护检查 → 3. 批量获取行情
 * → 4. 并发处理监控标的 → 5. 订单监控与缓存刷新
 */
import { logger } from '../../utils/logger/index.js';
import { formatError, formatSymbolDisplay } from '../../utils/helpers/index.js';
import {
  getHKDateKey,
  isInContinuousHKSession,
  isWithinMorningOpenProtection,
  isWithinAfternoonOpenProtection,
} from '../../utils/helpers/tradingTime.js';
import { collectRuntimeQuoteSymbols, diffQuoteSymbols } from '../../utils/helpers/quoteHelpers.js';
import { processMonitor } from '../processMonitor/index.js';

import type { MainProgramContext } from './types.js';

/**
 * 主程序 - 每秒执行一次的核心循环
 *
 * 职责：
 * 1. 判断交易日和交易时段
 * 2. 执行末日保护检查
 * 3. 批量获取行情数据
 * 4. 并发处理所有监控标的
 * 5. 执行订单监控和缓存刷新
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
      logger.warn(
        '无法获取交易日信息，进入保护性暂停（按非交易日处理）',
        formatError(err),
      );
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
        morning.minutes != null &&
        isWithinMorningOpenProtection(currentTime, morning.minutes);

      const afternoonActive =
        !isHalfDayToday &&
        afternoon.enabled &&
        afternoon.minutes != null &&
        isWithinAfternoonOpenProtection(currentTime, afternoon.minutes);

      openProtectionActive = morningActive || afternoonActive;

      const anyProtectionEnabled =
        (morning.enabled && morning.minutes != null) ||
        (!isHalfDayToday && afternoon.enabled && afternoon.minutes != null);

      if (anyProtectionEnabled && lastState.openProtectionActive !== openProtectionActive) {
        if (openProtectionActive) {
          if (morningActive) {
            logger.info(`[开盘保护] 早盘开盘后 ${morning.minutes} 分钟内暂停信号生成`);
          } else {
            logger.info(`[开盘保护] 午盘开盘后 ${afternoon.minutes} 分钟内暂停信号生成`);
          }
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

  if (!lastState.isTradingEnabled) {
    return;
  }

  if (isStrictMode && (!isTradingDayToday || !canTradeNow)) {
    return;
  }

  // 使用 lifecycle tick 后的最新持仓缓存
  const positions = lastState.cachedPositions ?? [];

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

    if (cancelResult.executed && cancelResult.cancelledCount > 0) {
      logger.info(`[末日保护程序] 收盘前15分钟撤单完成，共撤销 ${cancelResult.cancelledCount} 个买入订单`);
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

  const removableSymbols = removed.filter(
    (symbol) => lastState.positionCache.get(symbol) == null,
  );

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
    runtimeGateMode,
    dayLifecycleManager,
  };

  // 并发处理所有监控标的（使用预先获取的行情数据）
  const monitorTasks: Promise<void>[] = [];
  for (const [monitorSymbol, monitorContext] of monitorContexts) {
    monitorTasks.push(
      processMonitor({
        context: mainContext,
        monitorContext,
        runtimeFlags: {
          currentTime,
          isHalfDay: isHalfDayToday,
          canTradeNow,
          openProtectionActive,
          isTradingEnabled: lastState.isTradingEnabled,
        },
      }, quotesMap).catch((err: unknown) => {
        logger.error(`处理监控标的 ${formatSymbolDisplay(monitorSymbol, monitorContext.monitorSymbolName)} 失败`, formatError(err));
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
