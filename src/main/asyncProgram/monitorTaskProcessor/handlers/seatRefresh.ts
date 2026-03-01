/**
 * 席位刷新任务处理
 *
 * 功能：
 * - 换标后刷新订单记录与风险缓存
 * - 刷新牛熊证信息并处理旧标的清理
 * - 刷新顺序保持原子性，避免缓存污染
 */
import { logger } from '../../../../utils/logger/index.js';
import { isSeatReady, isSeatVersionMatch } from '../../../../services/autoSymbolManager/utils.js';

import type { MultiMonitorTradingConfig } from '../../../../types/config.js';
import type { MonitorTask } from '../../monitorTaskQueue/types.js';
import type {
  MonitorTaskContext,
  MonitorTaskData,
  MonitorTaskStatus,
  MonitorTaskType,
  RefreshHelpers,
  SeatRefreshTaskData,
} from '../types.js';

/**
 * 创建席位刷新任务处理器。
 * 换标后刷新订单记录、日内亏损与浮亏数据，设置牛熊证信息并清理旧标的缓存；保证刷新顺序原子性，避免缓存污染。
 *
 * @param deps 依赖注入，包含 getContextOrSkip、clearMonitorDirectionQueues、tradingConfig
 * @returns 处理 SEAT_REFRESH 任务的异步函数
 */
export function createSeatRefreshHandler({
  getContextOrSkip,
  clearMonitorDirectionQueues,
  tradingConfig,
}: {
  readonly getContextOrSkip: (monitorSymbol: string) => MonitorTaskContext | null;
  readonly clearMonitorDirectionQueues: (
    monitorSymbol: string,
    direction: 'LONG' | 'SHORT',
  ) => void;
  readonly tradingConfig: MultiMonitorTradingConfig;
}): (
  task: MonitorTask<MonitorTaskType, MonitorTaskData>,
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
    const nextVersion = context.symbolRegistry.bumpSeatVersion(monitorSymbol, direction);
    const nextState = {
      symbol: null,
      status: 'EMPTY',
      lastSwitchAt: Date.now(),
      lastSearchAt: null,
      lastSeatReadyAt: null,
      callPrice: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    } as const;
    context.symbolRegistry.updateSeatState(monitorSymbol, direction, nextState);
    clearMonitorDirectionQueues(monitorSymbol, direction);
    logger.error(`[自动换标] ${monitorSymbol} ${direction} 换标失败（v${nextVersion}）：${reason}`);
  }

  return async function handleSeatRefresh(
    task: MonitorTask<MonitorTaskType, MonitorTaskData>,
    helpers: RefreshHelpers,
  ): Promise<MonitorTaskStatus> {
    // handler 由 SEAT_REFRESH 类型分派，data 语义上必为 SeatRefreshTaskData
    const data = task.data as SeatRefreshTaskData;
    const context = getContextOrSkip(data.monitorSymbol);
    if (!context) {
      return 'skipped';
    }

    const seatState = context.symbolRegistry.getSeatState(data.monitorSymbol, data.direction);
    const seatVersion = context.symbolRegistry.getSeatVersion(data.monitorSymbol, data.direction);
    if (!isSeatVersionMatch(data.seatVersion, seatVersion)) {
      return 'skipped';
    }

    if (!isSeatReady(seatState) || seatState.symbol !== data.nextSymbol) {
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
      markSeatAsEmpty(
        data.monitorSymbol,
        data.direction,
        '未提供有效回收价(callPrice)，无法刷新牛熊证信息',
        context,
      );
      return 'processed';
    }

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
          data.quote,
        )
      : context.orderRecorder.refreshOrdersFromAllOrdersForShort(
          data.nextSymbol,
          allOrders,
          data.quote,
        ));

    await helpers.refreshAccountCaches();

    const dailyLossOffset = context.dailyLossTracker.getLossOffset(data.monitorSymbol, isLong);
    await context.riskChecker.refreshUnrealizedLossData(
      context.orderRecorder,
      data.nextSymbol,
      isLong,
      data.quote,
      dailyLossOffset,
    );

    const warrantRefreshResult = context.riskChecker.setWarrantInfoFromCallPrice(
      data.nextSymbol,
      data.callPrice,
      isLong,
      data.symbolName,
    );
    if (warrantRefreshResult.status === 'error') {
      markSeatAsEmpty(
        data.monitorSymbol,
        data.direction,
        `设置牛熊证信息失败：${warrantRefreshResult.reason}`,
        context,
      );
      return 'processed';
    }

    if (data.previousSymbol && data.previousSymbol !== data.nextSymbol) {
      const previousQuote = data.quotesMap.get(data.previousSymbol) ?? null;
      const existingSeat = context.symbolRegistry.resolveSeatBySymbol(data.previousSymbol);
      if (!existingSeat) {
        context.orderRecorder.clearBuyOrders(data.previousSymbol, isLong, previousQuote);
        context.orderRecorder.clearOrdersCacheForSymbol(data.previousSymbol);
      }
    }

    return 'processed';
  };
}
