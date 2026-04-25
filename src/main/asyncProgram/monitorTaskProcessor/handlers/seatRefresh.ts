/**
 * 席位刷新任务处理
 *
 * 功能：
 * - 作为 seat activation barrier，在 ACTIVATING 阶段完成 quote admission 与风险缓存初始化
 * - 在执行时拉取行情后刷新牛熊证信息并处理旧标的清理
 * - 成功后推进到 ACTIVE，失败则回 EMPTY 并 bump version
 */
import { logger } from '../../../../utils/logger/index.js';
import { isSeatVersionMatch } from '../../../../utils/seat/guards.js';

import type { MultiMonitorTradingConfig } from '../../../../types/config.js';
import type { MarketDataClient } from '../../../../types/services.js';
import type { QuoteSubscriptionRuntime } from '../../../quoteSubscriptionRuntime/types.js';
import type { MonitorTask } from '../../monitorTaskQueue/types.js';
import type {
  MonitorTaskContext,
  MonitorTaskDataMap,
  MonitorTaskStatus,
  RefreshHelpers,
  SeatRefreshTaskData,
} from '../types.js';

function logSeatRefreshSkipped(params: {
  readonly context: MonitorTaskContext;
  readonly data: SeatRefreshTaskData;
  readonly reason: string;
}): void {
  const { context, data, reason } = params;
  const currentSeat = context.symbolRegistry.getSeatState(data.monitorSymbol, data.direction);
  const currentSeatVersion = context.symbolRegistry.getSeatVersion(
    data.monitorSymbol,
    data.direction,
  );
  logger.debug(
    `[SEAT_REFRESH skipped] monitorSymbol=${data.monitorSymbol} direction=${data.direction} taskSeatVersion=${data.seatVersion} currentSeatVersion=${currentSeatVersion} currentStatus=${currentSeat.status} currentSymbol=${currentSeat.symbol ?? 'null'} reason=${reason}`,
  );
}

function logSeatRefreshProcessed(params: {
  readonly data: SeatRefreshTaskData;
  readonly result: 'activated' | 'marked_empty';
  readonly reason?: string;
}): void {
  const { data, result, reason } = params;
  const reasonSuffix = reason ? ` reason=${reason}` : '';
  logger.debug(
    `[SEAT_REFRESH processed] monitorSymbol=${data.monitorSymbol} direction=${data.direction} seatVersion=${data.seatVersion} previousSymbol=${data.previousSymbol ?? 'null'} nextSymbol=${data.nextSymbol} result=${result}${reasonSuffix}`,
  );
}

/**
 * 创建席位刷新任务处理器。
 * 在 seat 进入 ACTIVATING 后执行 admission、订单/风控缓存初始化与旧标的清理；仅当全部成功时才把 seat 推进到 ACTIVE。
 *
 * @param deps 依赖注入，包含 getContextOrSkip、clearMonitorDirectionQueues、tradingConfig、marketDataClient
 * @returns 处理 SEAT_REFRESH 任务的异步函数
 */
export function createSeatRefreshHandler({
  getContextOrSkip,
  clearMonitorDirectionQueues,
  tradingConfig,
  marketDataClient,
  quoteSubscriptionRuntime,
}: {
  readonly getContextOrSkip: (monitorSymbol: string) => MonitorTaskContext | null;
  readonly clearMonitorDirectionQueues: (
    monitorSymbol: string,
    direction: 'LONG' | 'SHORT',
  ) => void;
  readonly tradingConfig: MultiMonitorTradingConfig;
  readonly marketDataClient: MarketDataClient;
  readonly quoteSubscriptionRuntime: Pick<
    QuoteSubscriptionRuntime,
    'retainSymbols' | 'waitForAdmission'
  >;
}): (
  task: MonitorTask<MonitorTaskDataMap, 'SEAT_REFRESH'>,
  helpers: RefreshHelpers,
) => Promise<MonitorTaskStatus> {
  /**
   * 将指定监控标的的方向席位标记为空（刷新失败或数据无效时调用）。
   * 通过 context 更新 symbolRegistry 席位状态与版本，并清理风控缓存与方向队列。
   *
   * @param monitorSymbol 监控标的代码
   * @param direction 多空方向
   * @param reason 标记原因（用于日志）
   * @param context 任务上下文，为 null 时直接返回
   * @returns 无返回值
   */
  function markSeatAsEmpty(
    monitorSymbol: string,
    direction: 'LONG' | 'SHORT',
    reason: string,
    context: MonitorTaskContext | null,
  ): void {
    if (!context) {
      return;
    }

    if (direction === 'LONG') {
      context.riskChecker.clearLongWarrantInfo();
    } else {
      context.riskChecker.clearShortWarrantInfo();
    }

    const currentSeat = context.symbolRegistry.getSeatState(monitorSymbol, direction);
    const nowMs = Date.now();
    const nextState = {
      symbol: null,
      status: 'EMPTY',
      lastSwitchAt: nowMs,
      lastSearchAt: currentSeat.lastSearchAt ?? nowMs,
      lastSeatActivatedAt: null,
      callPrice: null,
      searchFailCountToday: currentSeat.searchFailCountToday,
      frozenTradingDayKey: currentSeat.frozenTradingDayKey,
    } as const;
    const { seatVersion: nextVersion } = context.symbolRegistry.updateSeatStateWithVersionBump(
      monitorSymbol,
      direction,
      nextState,
    );
    clearMonitorDirectionQueues(monitorSymbol, direction);
    logger.error(`[自动换标] ${monitorSymbol} ${direction} 换标失败（v${nextVersion}）：${reason}`);
  }

  /**
   * 校验任务快照与当前席位是否仍一致，并返回当前席位状态。
   * 要求：seatVersion 匹配、状态为 ACTIVATING、symbol 与 nextSymbol 一致。
   *
   * @param context 监控上下文
   * @param data 席位刷新任务数据
   * @returns 快照仍有效时返回当前 seatState，否则返回 null
   */
  function resolveActivatingSeatSnapshot(
    context: MonitorTaskContext,
    data: SeatRefreshTaskData,
  ): ReturnType<MonitorTaskContext['symbolRegistry']['getSeatState']> | null {
    const seatState = context.symbolRegistry.getSeatState(data.monitorSymbol, data.direction);
    const seatVersion = context.symbolRegistry.getSeatVersion(data.monitorSymbol, data.direction);
    if (!isSeatVersionMatch(data.seatVersion, seatVersion)) {
      return null;
    }

    if (seatState.status !== 'ACTIVATING' || seatState.symbol !== data.nextSymbol) {
      return null;
    }

    return seatState;
  }

  return async function handleSeatRefresh(
    task: MonitorTask<MonitorTaskDataMap, 'SEAT_REFRESH'>,
    helpers: RefreshHelpers,
  ): Promise<MonitorTaskStatus> {
    const data: SeatRefreshTaskData = task.data;
    const context = getContextOrSkip(data.monitorSymbol);
    if (!context) {
      return 'skipped';
    }

    const entrySeatState = resolveActivatingSeatSnapshot(context, data);
    if (!entrySeatState) {
      logSeatRefreshSkipped({
        context,
        data,
        reason: 'entry seat snapshot mismatch',
      });
      return 'skipped';
    }

    const isLong = data.direction === 'LONG';
    if (isLong) {
      context.riskChecker.clearLongWarrantInfo();
    } else {
      context.riskChecker.clearShortWarrantInfo();
    }

    const callPriceValid =
      data.callPrice !== null &&
      data.callPrice !== undefined &&
      Number.isFinite(data.callPrice) &&
      data.callPrice > 0;

    if (!callPriceValid) {
      const reason = '未提供有效回收价(callPrice)，无法刷新牛熊证信息';
      markSeatAsEmpty(data.monitorSymbol, data.direction, reason, context);
      logSeatRefreshProcessed({
        data,
        result: 'marked_empty',
        reason,
      });
      return 'processed';
    }

    let releaseSeatRefreshRetain: (() => void) | null = null;
    try {
      const quoteSymbols = [data.nextSymbol];
      if (data.previousSymbol && data.previousSymbol !== data.nextSymbol) {
        quoteSymbols.push(data.previousSymbol);
      }

      releaseSeatRefreshRetain = await quoteSubscriptionRuntime.retainSymbols({
        ownerKey: `${data.monitorSymbol}:${data.direction}:${data.seatVersion}`,
        reason: 'SEAT_REFRESH_WAIT',
        symbols: quoteSymbols,
      });
      await quoteSubscriptionRuntime.waitForAdmission(quoteSymbols);

      const executionQuotes = await marketDataClient.getQuotes(quoteSymbols);
      const nextExecutionQuote = executionQuotes.get(data.nextSymbol) ?? null;

      const allOrders = await helpers.ensureAllOrders(data.monitorSymbol, context.orderRecorder);
      context.dailyLossTracker.recalculateFromAllOrders(
        allOrders,
        tradingConfig.monitors,
        new Date(),
      );

      await (isLong
        ? context.orderRecorder.refreshOrdersFromAllOrdersForLong(
            data.nextSymbol,
            allOrders,
            nextExecutionQuote,
          )
        : context.orderRecorder.refreshOrdersFromAllOrdersForShort(
            data.nextSymbol,
            allOrders,
            nextExecutionQuote,
          ));

      await helpers.refreshAccountCaches();

      const dailyLossOffset = context.dailyLossTracker.getLossOffset(data.monitorSymbol, isLong);
      await context.riskChecker.refreshUnrealizedLossData(
        context.orderRecorder,
        data.nextSymbol,
        isLong,
        nextExecutionQuote,
        dailyLossOffset,
      );

      if (data.previousSymbol && data.previousSymbol !== data.nextSymbol) {
        const previousExecutionQuote = executionQuotes.get(data.previousSymbol) ?? null;
        const existingSeat = context.symbolRegistry.resolveSeatBySymbol(data.previousSymbol);
        if (!existingSeat) {
          context.orderRecorder.clearBuyOrders(data.previousSymbol, isLong, previousExecutionQuote);
          context.orderRecorder.clearOrdersCacheForSymbol(data.previousSymbol);
        }
      }

      const latestSeatState = resolveActivatingSeatSnapshot(context, data);
      if (!latestSeatState) {
        logSeatRefreshSkipped({
          context,
          data,
          reason: 'seat snapshot changed during refresh',
        });
        return 'skipped';
      }

      const warrantRefreshResult = context.riskChecker.setWarrantInfoFromCallPrice(
        data.nextSymbol,
        data.callPrice,
        isLong,
        nextExecutionQuote?.name ?? data.symbolName,
      );
      if (warrantRefreshResult.status === 'error') {
        const reason = `设置牛熊证信息失败：${warrantRefreshResult.reason}`;
        markSeatAsEmpty(data.monitorSymbol, data.direction, reason, context);
        logSeatRefreshProcessed({
          data,
          result: 'marked_empty',
          reason,
        });
        return 'processed';
      }

      context.symbolRegistry.updateSeatState(data.monitorSymbol, data.direction, {
        ...latestSeatState,
        status: 'ACTIVE',
        lastSeatActivatedAt: Date.now(),
        callPrice: data.callPrice,
      });

      logSeatRefreshProcessed({
        data,
        result: 'activated',
      });

      return 'processed';
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      markSeatAsEmpty(data.monitorSymbol, data.direction, reason, context);
      logSeatRefreshProcessed({
        data,
        result: 'marked_empty',
        reason,
      });
      return 'processed';
    } finally {
      releaseSeatRefreshRetain?.();
    }
  };
}
