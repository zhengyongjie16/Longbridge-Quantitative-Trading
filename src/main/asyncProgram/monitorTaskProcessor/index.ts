import { logger } from '../../../utils/logger/index.js';
import { formatError } from '../../../utils/helpers/index.js';
import { positionObjectPool, signalObjectPool } from '../../../utils/objectPool/index.js';
import { isSeatReady, isSeatVersionMatch } from '../../../services/autoSymbolManager/utils.js';
import { WARRANT_LIQUIDATION_ORDER_TYPE } from '../../../constants/index.js';
import { getPositions } from '../../processMonitor/utils.js';

import type { Quote, RawOrderFromAPI, Signal, Position } from '../../../types/index.js';
import type { MonitorTask } from '../monitorTaskQueue/types.js';
import type {
  AutoSymbolSwitchDistanceTaskData,
  AutoSymbolTickTaskData,
  LiquidationDistanceCheckTaskData,
  MonitorTaskData,
  MonitorTaskProcessor,
  MonitorTaskProcessorDeps,
  MonitorTaskStatus,
  MonitorTaskType,
  MonitorTaskContext,
  SeatRefreshTaskData,
  SeatSnapshot,
  UnrealizedLossCheckTaskData,
} from './types.js';

type RefreshHelpers = Readonly<{
  ensureAllOrders: (
    monitorSymbol: string,
    orderRecorder: MonitorTaskContext['orderRecorder'],
  ) => Promise<ReadonlyArray<RawOrderFromAPI>>;
  refreshAccountCaches: () => Promise<void>;
}>;

export function createMonitorTaskProcessor(
  deps: MonitorTaskProcessorDeps,
): MonitorTaskProcessor {
  const {
    monitorTaskQueue,
    refreshGate,
    getMonitorContext,
    clearQueuesForDirection,
    marketDataClient,
    trader,
    lastState,
    tradingConfig,
    onProcessed,
  } = deps;

  let running = false;
  let immediateHandle: ReturnType<typeof setImmediate> | null = null;

  function getContextOrSkip(monitorSymbol: string): MonitorTaskContext | null {
    const context = getMonitorContext(monitorSymbol);
    if (!context) {
      logger.warn(`[MonitorTaskProcessor] 未找到监控上下文: ${monitorSymbol}`);
      return null;
    }
    return context;
  }

  function isSeatSnapshotValid(
    monitorSymbol: string,
    direction: 'LONG' | 'SHORT',
    snapshot: SeatSnapshot,
    context: MonitorTaskContext | null,
  ): boolean {
    if (!context) {
      return false;
    }
    const seatState = context.symbolRegistry.getSeatState(monitorSymbol, direction);
    const currentVersion = context.symbolRegistry.getSeatVersion(monitorSymbol, direction);
    if (!isSeatVersionMatch(snapshot.seatVersion, currentVersion)) {
      return false;
    }
    return seatState.symbol === snapshot.symbol;
  }

  async function validateSeatSnapshotsAfterRefresh(
    monitorSymbol: string,
    context: MonitorTaskContext,
    longSnapshot: SeatSnapshot,
    shortSnapshot: SeatSnapshot,
  ): Promise<Readonly<{ longValid: boolean; shortValid: boolean }> | null> {
    const hasLongSnapshot = isSeatSnapshotValid(monitorSymbol, 'LONG', longSnapshot, context);
    const hasShortSnapshot = isSeatSnapshotValid(monitorSymbol, 'SHORT', shortSnapshot, context);
    if (!hasLongSnapshot && !hasShortSnapshot) {
      return null;
    }

    await refreshGate.waitForFresh();

    const longValid = isSeatSnapshotValid(monitorSymbol, 'LONG', longSnapshot, context);
    const shortValid = isSeatSnapshotValid(monitorSymbol, 'SHORT', shortSnapshot, context);
    if (!longValid && !shortValid) {
      return null;
    }

    return { longValid, shortValid };
  }

  function markSeatAsEmpty(
    monitorSymbol: string,
    direction: 'LONG' | 'SHORT',
    reason: string,
    context: MonitorTaskContext | null,
  ): void {
    if (!context) {
      return;
    }

    context.riskChecker.clearWarrantInfo(direction === 'LONG');
    const nextVersion = context.symbolRegistry.bumpSeatVersion(monitorSymbol, direction);
    const nextState = {
      symbol: null,
      status: 'EMPTY',
      lastSwitchAt: Date.now(),
      lastSearchAt: null,
    } as const;
    context.symbolRegistry.updateSeatState(monitorSymbol, direction, nextState);
    clearQueuesForDirection(monitorSymbol, direction);
    logger.error(`[自动换标] ${monitorSymbol} ${direction} 换标失败（v${nextVersion}）：${reason}`);
  }

  function createRefreshHelpers(): RefreshHelpers {
    const cachedAllOrdersByMonitor = new Map<string, ReadonlyArray<RawOrderFromAPI>>();
    let cachedAccountSnapshot: typeof lastState.cachedAccount | null | undefined;
    let cachedPositionsSnapshot: ReadonlyArray<Position> | null | undefined;

    async function ensureAllOrders(
      monitorSymbol: string,
      orderRecorder: MonitorTaskContext['orderRecorder'],
    ): Promise<ReadonlyArray<RawOrderFromAPI>> {
      const cached = cachedAllOrdersByMonitor.get(monitorSymbol);
      if (cached) {
        return cached;
      }
      const allOrders = await orderRecorder.fetchAllOrdersFromAPI(true);
      cachedAllOrdersByMonitor.set(monitorSymbol, allOrders);
      return allOrders;
    }

    async function refreshAccountCaches(): Promise<void> {
      if (cachedAccountSnapshot === undefined) {
        cachedAccountSnapshot = await trader.getAccountSnapshot();
        if (cachedAccountSnapshot) {
          lastState.cachedAccount = cachedAccountSnapshot;
        }
      }
      if (cachedPositionsSnapshot === undefined) {
        cachedPositionsSnapshot = await trader.getStockPositions();
        if (cachedPositionsSnapshot) {
          lastState.cachedPositions = [...cachedPositionsSnapshot];
          lastState.positionCache.update(cachedPositionsSnapshot);
        }
      }
    }

    return {
      ensureAllOrders,
      refreshAccountCaches,
    };
  }

  async function handleAutoSymbolTick(
    task: MonitorTask<MonitorTaskType, MonitorTaskData>,
  ): Promise<MonitorTaskStatus> {
    const data = task.data as AutoSymbolTickTaskData;
    const context = getContextOrSkip(data.monitorSymbol);
    if (!context) {
      return 'skipped';
    }

    const isSnapshotValid = isSeatSnapshotValid(
      data.monitorSymbol,
      data.direction,
      { seatVersion: data.seatVersion, symbol: data.symbol },
      context,
    );
    if (!isSnapshotValid) {
      return 'skipped';
    }

    await context.autoSymbolManager.maybeSearchOnTick({
      direction: data.direction,
      currentTime: new Date(data.currentTimeMs),
      canTradeNow: data.canTradeNow,
    });

    return 'processed';
  }

  async function handleAutoSymbolSwitchDistance(
    task: MonitorTask<MonitorTaskType, MonitorTaskData>,
  ): Promise<MonitorTaskStatus> {
    const data = task.data as AutoSymbolSwitchDistanceTaskData;
    const context = getContextOrSkip(data.monitorSymbol);
    if (!context) {
      return 'skipped';
    }

    const snapshotValidity = await validateSeatSnapshotsAfterRefresh(
      data.monitorSymbol,
      context,
      data.seatSnapshots.long,
      data.seatSnapshots.short,
    );
    if (!snapshotValidity) {
      return 'skipped';
    }

    const longSeat = context.symbolRegistry.getSeatState(data.monitorSymbol, 'LONG');
    const shortSeat = context.symbolRegistry.getSeatState(data.monitorSymbol, 'SHORT');
    const isLongReady = snapshotValidity.longValid && isSeatReady(longSeat);
    const isShortReady = snapshotValidity.shortValid && isSeatReady(shortSeat);
    const pendingSymbols: string[] = [];
    if (isLongReady) {
      pendingSymbols.push(longSeat.symbol);
    }
    if (isShortReady && shortSeat.symbol !== longSeat.symbol) {
      pendingSymbols.push(shortSeat.symbol);
    }

    const pendingOrders = pendingSymbols.length > 0
      ? await trader.getPendingOrders(pendingSymbols)
      : [];

    if (isLongReady) {
      await context.autoSymbolManager.maybeSwitchOnDistance({
        direction: 'LONG',
        monitorPrice: data.monitorPrice,
        quotesMap: data.quotesMap,
        positions: lastState.cachedPositions,
        pendingOrders,
      });
    }
    if (isShortReady) {
      await context.autoSymbolManager.maybeSwitchOnDistance({
        direction: 'SHORT',
        monitorPrice: data.monitorPrice,
        quotesMap: data.quotesMap,
        positions: lastState.cachedPositions,
        pendingOrders,
      });
    }

    return 'processed';
  }

  async function handleSeatRefresh(
    task: MonitorTask<MonitorTaskType, MonitorTaskData>,
    helpers: RefreshHelpers,
  ): Promise<MonitorTaskStatus> {
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
    context.riskChecker.clearWarrantInfo(isLong);

    const allOrders = await helpers.ensureAllOrders(data.monitorSymbol, context.orderRecorder);
    context.dailyLossTracker.recalculateFromAllOrders(allOrders, tradingConfig.monitors, new Date());
    await context.orderRecorder.refreshOrdersFromAllOrders(
      data.nextSymbol,
      isLong,
      allOrders,
      data.quote,
    );

    await helpers.refreshAccountCaches();

    const dailyLossOffset = context.dailyLossTracker.getLossOffset(
      data.monitorSymbol,
      isLong,
    );
    await context.riskChecker.refreshUnrealizedLossData(
      context.orderRecorder,
      data.nextSymbol,
      isLong,
      data.quote,
      dailyLossOffset,
    );

    const warrantRefreshResult = await context.riskChecker.refreshWarrantInfoForSymbol(
      marketDataClient,
      data.nextSymbol,
      isLong,
      data.symbolName,
    );
    if (warrantRefreshResult.status === 'error') {
      markSeatAsEmpty(data.monitorSymbol, data.direction, `获取牛熊证信息失败：${warrantRefreshResult.reason}`, context);
      return 'processed';
    }
    if (warrantRefreshResult.status === 'skipped') {
      markSeatAsEmpty(data.monitorSymbol, data.direction, '未提供行情客户端，无法刷新牛熊证信息', context);
      return 'processed';
    }
    if (warrantRefreshResult.status === 'notWarrant') {
      logger.warn(
        `[自动换标] ${data.monitorSymbol} ${data.direction} 标的 ${data.nextSymbol} 不是牛熊证`,
      );
    }

    if (data.previousSymbol && data.previousSymbol !== data.nextSymbol) {
      const previousQuote = data.quotesMap.get(data.previousSymbol) ?? null;
      const existingSeat = context.symbolRegistry.resolveSeatBySymbol(data.previousSymbol);
      if (!existingSeat) {
        context.orderRecorder.clearBuyOrders(
          data.previousSymbol,
          isLong,
          previousQuote,
        );
        context.orderRecorder.clearOrdersCacheForSymbol(data.previousSymbol);
      }
    }

    return 'processed';
  }

  async function handleLiquidationDistanceCheck(
    task: MonitorTask<MonitorTaskType, MonitorTaskData>,
  ): Promise<MonitorTaskStatus> {
    const data = task.data as LiquidationDistanceCheckTaskData;
    const context = getContextOrSkip(data.monitorSymbol);
    if (!context) {
      return 'skipped';
    }

    const snapshotValidity = await validateSeatSnapshotsAfterRefresh(
      data.monitorSymbol,
      context,
      { seatVersion: data.long.seatVersion, symbol: data.long.symbol },
      { seatVersion: data.short.seatVersion, symbol: data.short.symbol },
    );
    if (!snapshotValidity) {
      return 'skipped';
    }

    const longSeat = context.symbolRegistry.getSeatState(data.monitorSymbol, 'LONG');
    const shortSeat = context.symbolRegistry.getSeatState(data.monitorSymbol, 'SHORT');
    const isLongReady = snapshotValidity.longValid && isSeatReady(longSeat);
    const isShortReady = snapshotValidity.shortValid && isSeatReady(shortSeat);
    const longSymbol = isLongReady ? longSeat.symbol : '';
    const shortSymbol = isShortReady ? shortSeat.symbol : '';
    const { riskChecker } = context;

    const { longPosition, shortPosition } = getPositions(
      lastState.positionCache,
      longSymbol,
      shortSymbol,
    );

    try {
      const liquidationTasks: Array<{
        signal: Signal;
        isLongSymbol: boolean;
        quote: Quote | null;
      }> = [];

      function tryCreateLiquidationSignal(
        symbol: string,
        symbolName: string | null,
        isLongSymbol: boolean,
        position: Position | null,
        quote: Quote | null,
        seatVersion: number,
      ): {
        signal: Signal;
        isLongSymbol: boolean;
        quote: Quote | null;
      } | null {
        if (!symbol) {
          return null;
        }
        const availableQuantity = position?.availableQuantity ?? 0;
        if (!Number.isFinite(availableQuantity) || availableQuantity <= 0) {
          return null;
        }

        const liquidationResult = riskChecker.checkWarrantDistanceLiquidation(
          symbol,
          isLongSymbol,
          data.monitorPrice,
        );
        if (!liquidationResult.shouldLiquidate) {
          return null;
        }

        const signal = signalObjectPool.acquire() as Signal;
        signal.symbol = symbol;
        signal.symbolName = symbolName;
        signal.action = isLongSymbol ? 'SELLCALL' : 'SELLPUT';
        signal.reason = liquidationResult.reason ?? '牛熊证距回收价触发清仓';
        signal.price = quote?.price ?? null;
        signal.lotSize = quote?.lotSize ?? null;
        signal.quantity = availableQuantity;
        signal.triggerTime = new Date();
        signal.orderTypeOverride = WARRANT_LIQUIDATION_ORDER_TYPE;
        signal.isProtectiveLiquidation = false;
        signal.seatVersion = seatVersion;

        return { signal, isLongSymbol, quote };
      }

      if (isLongReady) {
        const longTask = tryCreateLiquidationSignal(
          longSymbol,
          data.long.symbolName ?? context.longSymbolName ?? null,
          true,
          longPosition,
          data.long.quote,
          data.long.seatVersion,
        );
        if (longTask) {
          liquidationTasks.push(longTask);
        }
      }

      if (isShortReady) {
        const shortTask = tryCreateLiquidationSignal(
          shortSymbol,
          data.short.symbolName ?? context.shortSymbolName ?? null,
          false,
          shortPosition,
          data.short.quote,
          data.short.seatVersion,
        );
        if (shortTask) {
          liquidationTasks.push(shortTask);
        }
      }

      if (liquidationTasks.length > 0) {
        try {
          await trader.executeSignals(liquidationTasks.map(({ signal }) => signal));
          for (const taskItem of liquidationTasks) {
            context.orderRecorder.clearBuyOrders(
              taskItem.signal.symbol,
              taskItem.isLongSymbol,
              taskItem.quote,
            );
            const dailyLossOffset = context.dailyLossTracker.getLossOffset(
              data.monitorSymbol,
              taskItem.isLongSymbol,
            );
            await context.riskChecker.refreshUnrealizedLossData(
              context.orderRecorder,
              taskItem.signal.symbol,
              taskItem.isLongSymbol,
              taskItem.quote,
              dailyLossOffset,
            );
          }
        } catch (err) {
          logger.error(`[牛熊证距回收价清仓失败] ${formatError(err)}`);
        } finally {
          for (const taskItem of liquidationTasks) {
            signalObjectPool.release(taskItem.signal);
          }
        }
      }
    } finally {
      if (longPosition) {
        positionObjectPool.release(longPosition);
      }
      if (shortPosition) {
        positionObjectPool.release(shortPosition);
      }
    }

    return 'processed';
  }

  async function handleUnrealizedLossCheck(
    task: MonitorTask<MonitorTaskType, MonitorTaskData>,
  ): Promise<MonitorTaskStatus> {
    const data = task.data as UnrealizedLossCheckTaskData;
    const context = getContextOrSkip(data.monitorSymbol);
    if (!context) {
      return 'skipped';
    }

    const snapshotValidity = await validateSeatSnapshotsAfterRefresh(
      data.monitorSymbol,
      context,
      { seatVersion: data.long.seatVersion, symbol: data.long.symbol },
      { seatVersion: data.short.seatVersion, symbol: data.short.symbol },
    );
    if (!snapshotValidity) {
      return 'skipped';
    }

    const longSeat = context.symbolRegistry.getSeatState(data.monitorSymbol, 'LONG');
    const shortSeat = context.symbolRegistry.getSeatState(data.monitorSymbol, 'SHORT');

    const isLongReady = snapshotValidity.longValid && isSeatReady(longSeat);
    const isShortReady = snapshotValidity.shortValid && isSeatReady(shortSeat);
    const longSymbol = isLongReady ? longSeat.symbol : '';
    const shortSymbol = isShortReady ? shortSeat.symbol : '';
    const longQuote = isLongReady ? data.long.quote : null;
    const shortQuote = isShortReady ? data.short.quote : null;

    if (!longSymbol && !shortSymbol) {
      return 'skipped';
    }

    await context.unrealizedLossMonitor.monitorUnrealizedLoss({
      longQuote,
      shortQuote,
      longSymbol,
      shortSymbol,
      monitorSymbol: data.monitorSymbol,
      riskChecker: context.riskChecker,
      trader,
      orderRecorder: context.orderRecorder,
      dailyLossTracker: context.dailyLossTracker,
    });

    return 'processed';
  }

  async function processTask(
    task: MonitorTask<MonitorTaskType, MonitorTaskData>,
    helpers: RefreshHelpers,
  ): Promise<MonitorTaskStatus> {
    switch (task.type) {
      case 'AUTO_SYMBOL_TICK':
        return handleAutoSymbolTick(task);
      case 'AUTO_SYMBOL_SWITCH_DISTANCE':
        return handleAutoSymbolSwitchDistance(task);
      case 'SEAT_REFRESH':
        return handleSeatRefresh(task, helpers);
      case 'LIQUIDATION_DISTANCE_CHECK':
        return handleLiquidationDistanceCheck(task);
      case 'UNREALIZED_LOSS_CHECK':
        return handleUnrealizedLossCheck(task);
      default:
        return 'skipped';
    }
  }

  async function processQueue(): Promise<void> {
    const helpers = createRefreshHelpers();
    while (!monitorTaskQueue.isEmpty()) {
      const task = monitorTaskQueue.pop();
      if (!task) {
        break;
      }
      let status: MonitorTaskStatus = 'processed';
      try {
        status = await processTask(task, helpers);
      } catch (err) {
        status = 'failed';
        logger.error('[MonitorTaskProcessor] 处理任务失败', formatError(err));
      } finally {
        onProcessed?.(task, status);
      }
    }
  }

  function scheduleNextProcess(): void {
    if (!running) {
      return;
    }
    if (monitorTaskQueue.isEmpty()) {
      immediateHandle = null;
      return;
    }

    function handleProcessError(err: unknown): void {
      logger.error('[MonitorTaskProcessor] 处理队列时发生错误', formatError(err));
    }

    function handleProcessFinished(): void {
      scheduleNextProcess();
    }

    function handleImmediate(): void {
      if (!running) {
        return;
      }
      if (monitorTaskQueue.isEmpty()) {
        immediateHandle = null;
        return;
      }
      processQueue()
        .catch(handleProcessError)
        .finally(handleProcessFinished);
    }

    immediateHandle = setImmediate(handleImmediate);
  }

  function start(): void {
    if (running) {
      logger.warn('[MonitorTaskProcessor] 处理器已在运行中');
      return;
    }
    running = true;

    function handleTaskAdded(): void {
      if (running && immediateHandle === null) {
        scheduleNextProcess();
      }
    }

    monitorTaskQueue.onTaskAdded(handleTaskAdded);

    scheduleNextProcess();
  }

  function stop(): void {
    running = false;
    if (immediateHandle) {
      clearImmediate(immediateHandle);
      immediateHandle = null;
    }
  }

  return {
    start,
    stop,
  };
}
