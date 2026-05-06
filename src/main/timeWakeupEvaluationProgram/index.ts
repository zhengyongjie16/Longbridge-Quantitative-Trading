/**
 * timeWakeupEvaluationProgram 模块
 *
 * 核心职责：执行一次权威时间语义评估，更新交易门禁、生命周期、末日保护，并返回下一次系统级时间唤醒计划。
 */
import { DOOMSDAY, TIME } from '../../constants/index.js';
import { isWithinDoomsdayClearanceTakeoverWindow } from '../../core/doomsdayProtection/utils.js';
import { logger } from '../../utils/logger/index.js';
import {
  getHKDateKey,
  getRequiredHKDateKey,
  isInContinuousHKSession,
  isWithinAfternoonOpenProtection,
  isWithinMorningOpenWindow,
  resolveHKDayStartUtcMs,
} from '../../utils/time/index.js';
import { planNextTimeWakeup } from '../timeWakeupPlanner/index.js';
import type { TradingCalendarSnapshot } from '../../types/tradingCalendar.js';
import type { TimeWakeupCandidate } from '../timeWakeupPlanner/types.js';
import type { TimeWakeupEvaluationContext, TimeWakeupEvaluationResult } from './types.js';

const takeoverStateByLastState = new WeakMap<TimeWakeupEvaluationContext['lastState'], boolean>();

/**
 * 取消所有 monitor 的普通延迟验证信号。
 *
 * @param monitorContexts 监控上下文集合
 * @returns 取消的信号总数
 */
function cancelAllDelayedSignals(
  monitorContexts: TimeWakeupEvaluationContext['monitorContexts'],
): number {
  let totalCancelled = 0;
  for (const [monitorSymbol, monitorContext] of monitorContexts) {
    const pendingCount = monitorContext.delayedSignalVerifier.getPendingCount();
    if (pendingCount <= 0) {
      continue;
    }

    monitorContext.delayedSignalVerifier.cancelAllForSymbol(monitorSymbol);
    totalCancelled += pendingCount;
  }

  return totalCancelled;
}

function createEvaluationResult(
  currentTime: Date,
  candidates: ReadonlyArray<TimeWakeupCandidate>,
): TimeWakeupEvaluationResult {
  return {
    plan: planNextTimeWakeup({
      nowMs: currentTime.getTime(),
      candidates,
    }),
  };
}

function pushFutureCandidate(
  candidates: TimeWakeupCandidate[],
  source: TimeWakeupCandidate['source'],
  atMs: number | null,
  nowMs: number,
): void {
  if (atMs === null || atMs <= nowMs) {
    return;
  }

  candidates.push({ source, atMs });
}

function resolveDayBoundaryMs(date: Date, minuteOfDay: number): number | null {
  const dayStartMs = resolveHKDayStartUtcMs(getRequiredHKDateKey(date));
  if (dayStartMs === null) {
    return null;
  }

  return dayStartMs + minuteOfDay * TIME.MILLISECONDS_PER_MINUTE;
}

function resolveNextHKDayBoundaryMs(date: Date): number | null {
  const dayStartMs = resolveHKDayStartUtcMs(getRequiredHKDateKey(date));
  if (dayStartMs === null) {
    return null;
  }

  return dayStartMs + TIME.MILLISECONDS_PER_DAY;
}

function resolveDoomsdayWindowEntryMs(date: Date, isHalfDay: boolean): ReadonlyArray<number> {
  const closeMinuteOfDay = isHalfDay ? 12 * 60 : 16 * 60;
  const buyCutoffMs = resolveDayBoundaryMs(
    date,
    closeMinuteOfDay - DOOMSDAY.BUY_CUTOFF_MINUTES_BEFORE_CLOSE,
  );
  const clearanceTakeoverMs = resolveDayBoundaryMs(
    date,
    closeMinuteOfDay - DOOMSDAY.CLEARANCE_TAKEOVER_MINUTES_BEFORE_CLOSE,
  );

  return [buyCutoffMs, clearanceTakeoverMs].filter((candidateMs) => candidateMs !== null);
}

function resolveTradingGateEdgeMs(date: Date, isHalfDay: boolean): number | null {
  const nowMs = date.getTime();
  const morningOpenMs = resolveDayBoundaryMs(date, 9 * 60 + 30);
  const morningCloseMs = resolveDayBoundaryMs(date, 12 * 60);
  const afternoonOpenMs = resolveDayBoundaryMs(date, 13 * 60);
  const closeMs = resolveDayBoundaryMs(date, isHalfDay ? 12 * 60 : 16 * 60);
  if (
    morningOpenMs === null ||
    morningCloseMs === null ||
    afternoonOpenMs === null ||
    closeMs === null
  ) {
    return null;
  }

  if (nowMs < morningOpenMs) {
    return morningOpenMs;
  }

  if (nowMs < morningCloseMs) {
    return morningCloseMs;
  }

  if (!isHalfDay && nowMs < afternoonOpenMs) {
    return afternoonOpenMs;
  }

  if (!isHalfDay && nowMs < closeMs) {
    return closeMs;
  }

  return null;
}

function resolveMarketCloseMs(date: Date, isHalfDay: boolean): number | null {
  const closeMs = resolveDayBoundaryMs(date, isHalfDay ? 12 * 60 : 16 * 60);
  if (closeMs === null || closeMs <= date.getTime()) {
    return null;
  }

  return closeMs;
}

function resolveOpenProtectionEdgeMs(
  date: Date,
  isHalfDay: boolean,
  openProtection: TimeWakeupEvaluationContext['tradingConfig']['global']['openProtection'],
): number | null {
  const candidates: number[] = [];
  if (openProtection.morning.enabled && openProtection.morning.minutes !== null) {
    const morningEndMs = resolveDayBoundaryMs(date, 9 * 60 + 30 + openProtection.morning.minutes);
    if (morningEndMs !== null && date.getTime() < morningEndMs) {
      candidates.push(morningEndMs);
    }
  }

  if (!isHalfDay && openProtection.afternoon.enabled && openProtection.afternoon.minutes !== null) {
    const afternoonEndMs = resolveDayBoundaryMs(date, 13 * 60 + openProtection.afternoon.minutes);
    if (afternoonEndMs !== null && date.getTime() < afternoonEndMs) {
      candidates.push(afternoonEndMs);
    }
  }

  return candidates.length === 0 ? null : Math.min(...candidates);
}

function resolveNextTradingDayOpenMs(
  fromMs: number,
  calendarSnapshot: TimeWakeupEvaluationContext['lastState']['tradingCalendarSnapshot'],
): number | null {
  const snapshot: TradingCalendarSnapshot = calendarSnapshot ?? new Map();
  const dayStartMs = resolveHKDayStartUtcMs(getRequiredHKDateKey(new Date(fromMs)));
  if (dayStartMs === null) {
    return null;
  }

  for (let dayOffset = 0; dayOffset <= 7; dayOffset += 1) {
    const dayMs = dayStartMs + dayOffset * TIME.MILLISECONDS_PER_DAY;
    const dayKey = getRequiredHKDateKey(new Date(dayMs));
    const dayInfo = snapshot.get(dayKey);
    if (dayInfo === undefined) {
      return null;
    }

    const openMs = dayMs + (9 * 60 + 30) * TIME.MILLISECONDS_PER_MINUTE;
    if (dayInfo.isTradingDay && openMs > fromMs) {
      return openMs;
    }
  }

  return null;
}

/**
 * 执行单次权威时间唤醒评估。
 *
 * @param context 时间唤醒评估上下文，包含所有必要依赖
 * @returns 下一次系统级时间唤醒计划
 */
export async function timeWakeupEvaluationProgram({
  marketDataClient,
  trader,
  lastState,
  doomsdayProtection,
  tradingConfig,
  monitorContexts,
  tradingGateEventRuntime,
  quoteSubscriptionRuntime,
  dayLifecycleManager,
  now,
}: TimeWakeupEvaluationContext): Promise<TimeWakeupEvaluationResult> {
  const currentTime = now?.() ?? new Date(Date.now());
  const currentMs = currentTime.getTime();
  const previousCanTrade = lastState.canTrade;
  const previousTakeoverActive = takeoverStateByLastState.get(lastState) ?? false;
  const candidates: TimeWakeupCandidate[] = [];
  pushFutureCandidate(
    candidates,
    'HK_DAY_BOUNDARY',
    resolveNextHKDayBoundaryMs(currentTime),
    currentMs,
  );

  const currentDayKey = getHKDateKey(currentTime) ?? '';
  const cachedTradingDayInfo =
    lastState.cachedTradingDayInfo?.dateKey === currentDayKey
      ? lastState.cachedTradingDayInfo.info
      : null;
  let isTradingDayToday: boolean | null = cachedTradingDayInfo?.isTradingDay ?? true;
  let isHalfDayToday = cachedTradingDayInfo?.isHalfDay ?? false;
  if (!cachedTradingDayInfo) {
    const tradingDayInfo = await marketDataClient.isTradingDay(currentTime);
    isTradingDayToday = tradingDayInfo.isTradingDay;
    isHalfDayToday = tradingDayInfo.isHalfDay;
    lastState.cachedTradingDayInfo = {
      dateKey: currentDayKey,
      info: tradingDayInfo,
    };

    if (tradingDayInfo.isTradingDay) {
      logger.info(`今天是${isHalfDayToday ? '半日交易日' : '交易日'}`);
    } else {
      logger.info('今天不是交易日');
    }
  }

  if (isTradingDayToday) {
    pushFutureCandidate(
      candidates,
      'TRADING_GATE_EDGE',
      resolveTradingGateEdgeMs(currentTime, isHalfDayToday),
      currentMs,
    );

    pushFutureCandidate(
      candidates,
      'MARKET_CLOSE_EDGE',
      resolveMarketCloseMs(currentTime, isHalfDayToday),
      currentMs,
    );

    pushFutureCandidate(
      candidates,
      'OPEN_PROTECTION_EDGE',
      resolveOpenProtectionEdgeMs(currentTime, isHalfDayToday, tradingConfig.global.openProtection),
      currentMs,
    );

    if (tradingConfig.global.doomsdayProtection) {
      for (const windowEntryMs of resolveDoomsdayWindowEntryMs(currentTime, isHalfDayToday)) {
        pushFutureCandidate(candidates, 'DOOMSDAY_WINDOW_ENTRY', windowEntryMs, currentMs);
      }
    }
  }

  const canTradeNow = isTradingDayToday && isInContinuousHKSession(currentTime, isHalfDayToday);
  if (lastState.canTrade !== false && !isTradingDayToday) {
    logger.info('今天不是交易日，暂停实时监控。');
  }

  if (lastState.canTrade !== canTradeNow) {
    if (canTradeNow) {
      logger.info(`进入连续交易时段${isHalfDayToday ? '（半日交易）' : ''}，开始正常交易。`);
    } else if (isTradingDayToday) {
      logger.info('当前为竞价或非连续交易时段，连续交易门禁关闭。');
      const totalCancelled = cancelAllDelayedSignals(monitorContexts);
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
      isWithinMorningOpenWindow(currentTime, morning.minutes);
    const afternoonActive =
      !isHalfDayToday &&
      afternoon.enabled &&
      afternoon.minutes !== null &&
      isWithinAfternoonOpenProtection(currentTime, afternoon.minutes);
    const openProtectionActive = morningActive || afternoonActive;
    const anyProtectionEnabled =
      (morning.enabled && morning.minutes !== null) ||
      (!isHalfDayToday && afternoon.enabled && afternoon.minutes !== null);
    if (anyProtectionEnabled && lastState.openProtectionActive !== openProtectionActive) {
      if (openProtectionActive) {
        logger.info(
          morningActive
            ? `[开盘保护] 早盘开盘后 ${String(morning.minutes)} 分钟内暂停信号生成`
            : `[开盘保护] 午盘开盘后 ${String(afternoon.minutes)} 分钟内暂停信号生成`,
        );
      } else if (lastState.openProtectionActive !== null) {
        logger.info('[开盘保护] 保护期结束，恢复信号生成');
      }
    }

    lastState.openProtectionActive = openProtectionActive;
  } else {
    lastState.openProtectionActive = false;
  }

  const lifecycleResult = await dayLifecycleManager.tick(currentTime, {
    dayKey: currentDayKey,
    canTradeNow,
    isTradingDay: isTradingDayToday,
  });
  pushFutureCandidate(candidates, 'LIFECYCLE_RETRY', lifecycleResult.nextRetryAtMs, currentMs);
  if (lifecycleResult.pendingOpenRebuild) {
    pushFutureCandidate(
      candidates,
      'LIFECYCLE_RETRY',
      resolveNextTradingDayOpenMs(currentMs, lastState.tradingCalendarSnapshot),
      currentMs,
    );
  }

  const nextCanTrade = lastState.canTrade;
  if (previousCanTrade !== nextCanTrade) {
    tradingGateEventRuntime.emitGateStateChanged({
      previousCanTrade,
      nextCanTrade,
      timestampMs: currentTime.getTime(),
    });
  }

  const doomsdayTakeoverActive =
    tradingConfig.global.doomsdayProtection &&
    isWithinDoomsdayClearanceTakeoverWindow(currentTime, isHalfDayToday);
  if (!previousTakeoverActive && doomsdayTakeoverActive) {
    const totalCancelled = cancelAllDelayedSignals(monitorContexts);
    if (totalCancelled > 0) {
      logger.info(`[清仓接管] 已清理 ${totalCancelled} 个普通待验证信号`);
    }
  }

  takeoverStateByLastState.set(lastState, doomsdayTakeoverActive);

  if (!lastState.isTradingEnabled) {
    return createEvaluationResult(currentTime, candidates);
  }

  if (!isTradingDayToday) {
    return createEvaluationResult(currentTime, candidates);
  }

  const tradeActionEnabled = canTradeNow;
  const positions = lastState.cachedPositions;

  if (tradeActionEnabled && tradingConfig.global.doomsdayProtection) {
    const cancelResult = await doomsdayProtection.cancelPendingBuyOrders({
      currentTime,
      isHalfDay: isHalfDayToday,
      monitorConfigs: tradingConfig.monitors,
      monitorContexts,
      trader,
    });
    if (cancelResult.executed && cancelResult.cancelRequestAcceptedCount > 0) {
      logger.info(
        `[末日保护程序] 买入截止窗口已提交撤单请求，共 ${cancelResult.cancelRequestAcceptedCount} 个买入订单，终态以后续 WS 为准`,
      );
    }

    const clearanceResult = await doomsdayProtection.executeClearance({
      currentTime,
      isHalfDay: isHalfDayToday,
      positions,
      monitorConfigs: tradingConfig.monitors,
      monitorContexts,
      trader,
      marketDataClient,
      lastState,
      onPositionsCommitted: () => quoteSubscriptionRuntime.reconcilePositionHoldFromCurrentTruth(),
    });
    pushFutureCandidate(candidates, 'DOOMSDAY_RETRY', clearanceResult.nextRetryAtMs, currentMs);
    if (clearanceResult.executed || clearanceResult.nextRetryAtMs !== null) {
      return createEvaluationResult(currentTime, candidates);
    }
  }

  return createEvaluationResult(currentTime, candidates);
}
