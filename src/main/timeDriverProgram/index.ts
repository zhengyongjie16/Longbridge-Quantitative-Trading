/**
 * timeDriverProgram 模块
 *
 * 核心职责：
 * - 判断交易日和交易时段，控制程序运行状态
 * - 驱动交易日生命周期状态机（dayLifecycleManager.tick），统一维护 isTradingEnabled 与交易日快照
 * - 在交易门禁状态变化时发布 gate event，供非周期自动寻标 owner 消费
 * - 执行末日保护（买入截止窗口撤单和清仓接管窗口清仓）
 * - 驱动时间语义维护：周期换标 tick
 *
 * 明确不负责：
 * - 读取 monitor candlestick 并推进普通指标
 * - 普通 immediate / delayed signal 生成
 */
import { logger } from '../../utils/logger/index.js';
import { processMonitor } from '../processMonitor/index.js';
import type { MonitorRuntimeContext } from '../processMonitor/types.js';
import type { TimeDriverProgramContext } from './types.js';
import { formatError } from '../../utils/error/index.js';
import { formatSymbolDisplay } from '../../utils/display/index.js';
import {
  getHKDateKey,
  isInContinuousHKSession,
  isWithinAfternoonOpenProtection,
  isWithinMorningOpenProtection,
} from '../../utils/time/index.js';
import { isWithinDoomsdayClearanceTakeoverWindow } from '../../core/doomsdayProtection/utils.js';

const takeoverStateByLastState = new WeakMap<TimeDriverProgramContext['lastState'], boolean>();

/**
 * 取消所有 monitor 的普通延迟验证信号。
 *
 * @param monitorContexts 监控上下文集合
 * @returns 取消的信号总数
 */
function cancelAllDelayedSignals(
  monitorContexts: TimeDriverProgramContext['monitorContexts'],
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

/**
 * 时间驱动主程序。
 *
 * @param context 时间驱动上下文，包含所有必要依赖
 */
export async function timeDriverProgram({
  marketDataClient,
  trader,
  lastState,
  doomsdayProtection,
  tradingConfig,
  monitorContexts,
  monitorTaskQueue,
  tradingGateEventRuntime,
  quoteSubscriptionRuntime,
  dayLifecycleManager,
}: TimeDriverProgramContext): Promise<void> {
  const currentTime = new Date(Date.now());
  const previousCanTrade = lastState.canTrade;
  const previousTakeoverActive = takeoverStateByLastState.get(lastState) ?? false;

  const currentDayKey = getHKDateKey(currentTime);
  let isTradingDayToday: boolean | null = lastState.cachedTradingDayInfo?.isTradingDay ?? true;
  let isHalfDayToday = lastState.cachedTradingDayInfo?.isHalfDay ?? false;
  if (!lastState.cachedTradingDayInfo) {
    try {
      const tradingDayInfo = await marketDataClient.isTradingDay(currentTime);
      isTradingDayToday = tradingDayInfo.isTradingDay;
      isHalfDayToday = tradingDayInfo.isHalfDay;
      lastState.cachedTradingDayInfo = {
        isTradingDay: isTradingDayToday,
        isHalfDay: isHalfDayToday,
      };

      if (tradingDayInfo.isTradingDay) {
        logger.info(`今天是${isHalfDayToday ? '半日交易日' : '交易日'}`);
      } else {
        logger.info('今天不是交易日');
      }
    } catch (err) {
      isTradingDayToday = null;
      isHalfDayToday = false;
      logger.warn('无法获取交易日信息，进入保护性暂停（交易日状态未知）', formatError(err));
    }
  }

  const canTradeNow =
    isTradingDayToday === true && isInContinuousHKSession(currentTime, isHalfDayToday);
  if (lastState.canTrade !== false && isTradingDayToday === false) {
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
      isWithinMorningOpenProtection(currentTime, morning.minutes);
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

  await dayLifecycleManager.tick(currentTime, {
    dayKey: currentDayKey,
    canTradeNow,
    isTradingDay: isTradingDayToday,
  });

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
    return;
  }

  if (isTradingDayToday !== true) {
    return;
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
    if (clearanceResult.executed) {
      return;
    }
  }

  const runtimeContext: MonitorRuntimeContext = {
    monitorTaskQueue,
  };

  for (const [monitorSymbol, monitorContext] of monitorContexts) {
    try {
      processMonitor({
        context: runtimeContext,
        monitorContext,
        currentTime,
      });
    } catch (error) {
      logger.error(
        `处理监控标的 ${formatSymbolDisplay(monitorSymbol, monitorContext.monitorSymbolName)} 失败`,
        formatError(error),
      );
    }
  }
}
