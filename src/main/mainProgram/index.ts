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
  isInContinuousHKSession,
  isWithinMorningOpenProtection,
} from '../../utils/helpers/tradingTime.js';
import { displayAccountAndPositions } from '../../utils/helpers/accountDisplay.js';
import { collectRuntimeQuoteSymbols, diffQuoteSymbols } from '../../utils/helpers/quoteHelpers.js';
import { isSeatReady } from '../../services/autoSymbolManager/utils.js';
import { processMonitor } from '../processMonitor/index.js';

import type { MainProgramContext } from './types.js';
import type { MonitorContext } from '../../types/index.js';

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
  runtimeGateMode,
}: MainProgramContext): Promise<void> {
  // 使用缓存的账户和持仓信息（仅在交易后更新）
  const positions = lastState.cachedPositions ?? [];

  // 判断是否在交易时段（使用当前系统时间）
  const currentTime = new Date();
  dailyLossTracker.resetIfNewDay(currentTime);

  let isTradingDayToday = lastState.cachedTradingDayInfo?.isTradingDay ?? true;
  let isHalfDayToday = lastState.cachedTradingDayInfo?.isHalfDay ?? false;

  if (!lastState.cachedTradingDayInfo && runtimeGateMode === 'strict') {
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
      logger.warn(
        '无法获取交易日信息，将根据时间判断是否在交易时段',
        formatError(err),
      );
    }
  }

  let canTradeNow = true;
  let openProtectionActive = false;

  if (runtimeGateMode === 'strict') {
    if (!isTradingDayToday) {
      if (lastState.canTrade !== false) {
        logger.info('今天不是交易日，暂停实时监控。');
        lastState.canTrade = false;
      }
      return;
    }

    canTradeNow = isInContinuousHKSession(currentTime, isHalfDayToday);

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
      lastState.canTrade = canTradeNow;
      lastState.isHalfDay = isHalfDayToday;
    }

    if (!canTradeNow) {
      return;
    }

    const openProtectionConfig = tradingConfig.global.openProtection;
    openProtectionActive =
      openProtectionConfig.enabled &&
      openProtectionConfig.minutes != null &&
      isWithinMorningOpenProtection(currentTime, openProtectionConfig.minutes);

    if (
      openProtectionConfig.enabled &&
      openProtectionConfig.minutes != null &&
      lastState.openProtectionActive !== openProtectionActive
    ) {
      if (openProtectionActive) {
        logger.info(
          `[开盘保护] 早盘开盘后 ${openProtectionConfig.minutes} 分钟内暂停信号生成`,
        );
      } else if (lastState.openProtectionActive !== null) {
        logger.info('[开盘保护] 保护期结束，恢复信号生成');
      }
    }
    lastState.openProtectionActive = openProtectionActive;
  } else {
    if (lastState.canTrade !== true) {
      logger.info('[运行模式] 已跳过交易时段检查');
    }
    lastState.canTrade = true;
    lastState.isHalfDay = isHalfDayToday;
    lastState.openProtectionActive = false;
  }

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
  // getQuotes 接口已支持 Iterable，无需 Array.from() 转换
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
    runtimeGateMode,
  };

  // 并发处理所有监控标的（使用预先获取的行情数据）
  // 使用 for...of 直接迭代 Map，避免 Array.from() 创建中间数组
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
    // 复用前面批量获取的行情数据进行订单监控（quotesMap 已包含所有交易标的的行情）
    await trader.monitorAndManageOrders(quotesMap).catch((err: unknown) => {
      logger.warn('订单监控失败', formatError(err));
    });

    // 订单成交后刷新缓存数据（由 WebSocket 推送触发，在此处统一处理）
    // 相比订单提交后立即刷新，此时本地订单记录已经更新，数据更准确
    // 注意：刷新后的缓存仅用于日志显示，不用于风险检查
    // 买入检查时会从API获取最新数据，确保风险检查使用最新账户和持仓信息
    const pendingRefreshSymbols = trader.getAndClearPendingRefreshSymbols();
    if (pendingRefreshSymbols.length > 0) {
      // 检查是否需要刷新账户和持仓
      const needRefreshAccount = pendingRefreshSymbols.some((r) => r.refreshAccount);
      const needRefreshPositions = pendingRefreshSymbols.some((r) => r.refreshPositions);

      // 刷新账户和持仓缓存（仅用于日志显示）
      if (needRefreshAccount || needRefreshPositions) {
        try {
          const [freshAccount, freshPositions] = await Promise.all([
            needRefreshAccount ? trader.getAccountSnapshot() : Promise.resolve(null),
            needRefreshPositions ? trader.getStockPositions() : Promise.resolve(null),
          ]);

          if (freshAccount !== null) {
            lastState.cachedAccount = freshAccount;
            logger.debug('[缓存刷新] 订单成交后刷新账户缓存');
          }

          if (Array.isArray(freshPositions)) {
            lastState.cachedPositions = freshPositions;
            lastState.positionCache.update(freshPositions);
            logger.debug('[缓存刷新] 订单成交后刷新持仓缓存');
          }
        } catch (err) {
          logger.warn('[缓存刷新] 订单成交后刷新缓存失败', formatError(err));
        }
      }

      // 刷新浮亏数据（预先构建 symbol -> MonitorContext 索引）
      const monitorContextBySymbol = new Map<string, MonitorContext>();
      for (const ctx of monitorContexts.values()) {
        const monitorSymbol = ctx.config.monitorSymbol;
        const longSeat = ctx.symbolRegistry.getSeatState(monitorSymbol, 'LONG');
        const shortSeat = ctx.symbolRegistry.getSeatState(monitorSymbol, 'SHORT');
        if (isSeatReady(longSeat) && !monitorContextBySymbol.has(longSeat.symbol)) {
          monitorContextBySymbol.set(longSeat.symbol, ctx);
        }
        if (isSeatReady(shortSeat) && !monitorContextBySymbol.has(shortSeat.symbol)) {
          monitorContextBySymbol.set(shortSeat.symbol, ctx);
        }
      }
      for (const { symbol, isLongSymbol } of pendingRefreshSymbols) {
        const monitorContext = monitorContextBySymbol.get(symbol);
        if (monitorContext && (monitorContext.config.maxUnrealizedLossPerSymbol ?? 0) > 0) {
          const quote = quotesMap.get(symbol) ?? null;
          const symbolName = isLongSymbol ? monitorContext.longSymbolName : monitorContext.shortSymbolName;
          const dailyLossOffset = monitorContext.dailyLossTracker.getLossOffset(
            monitorContext.config.monitorSymbol,
            isLongSymbol,
          );
          await monitorContext.riskChecker
            .refreshUnrealizedLossData(
              monitorContext.orderRecorder,
              symbol,
              isLongSymbol,
              quote,
              dailyLossOffset,
            )
            .catch((err: unknown) => {
              logger.warn(`[浮亏监控] 订单成交后刷新浮亏数据失败: ${formatSymbolDisplay(symbol, symbolName)}`, formatError(err));
            });
        }
      }

      // 订单成交后显示账户和持仓信息（此时缓存已刷新，直接使用缓存）
      await displayAccountAndPositions({ lastState, quotesMap });
    }
  }
}
