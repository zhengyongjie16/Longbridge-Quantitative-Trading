/**
 * 监控任务处理器模块
 *
 * 功能：
 * - 消费 MonitorTaskQueue 中的监控任务
 * - 使用 setImmediate 异步执行，不阻塞队列调度
 * - 处理自动寻标与席位刷新任务
 *
 * 支持的任务类型：
 * - AUTO_SYMBOL_TICK：自动寻标与周期换标检查
 * - SEAT_REFRESH：席位刷新（换标后刷新订单记录、浮亏数据）
 *
 * 席位快照验证：
 * - 任务携带创建时的席位快照（版本号、标的和必要的激活基线）
 * - 处理前验证快照是否与当前席位一致
 * - 防止换标后执行旧席位的任务
 */
import { logger } from '../../../utils/logger/index.js';
import { API } from '../../../constants/index.js';
import { createQueueRunner } from './queueRunner.js';
import { createRefreshHelpers } from './helpers/refreshHelpers.js';
import { createAutoSymbolHandlers } from './handlers/autoSymbol.js';
import { createSeatRefreshHandler } from './handlers/seatRefresh.js';
import type { MonitorTask } from '../monitorTaskQueue/types.js';
import { formatError } from '../../../utils/error/index.js';
import { isExternalApiRequestError } from '../../../utils/apiFailure/index.js';
import type { PeriodicSwitchRouteBaseline } from '../../periodicSwitchWakeupRuntime/types.js';
import type {
  MonitorTaskContext,
  MonitorTaskDataMap,
  MonitorTaskProcessor,
  MonitorTaskProcessorDeps,
  MonitorTaskStatus,
  RefreshHelpers,
  SeatRefreshRetryTimer,
} from './types.js';

/**
 * 兜底的穷尽性断言，防止新增任务类型后遗漏分派逻辑。
 *
 * 一旦出现未覆盖类型，立即抛错并暴露实现缺口。
 */
function assertNeverTask(_task: never): never {
  throw new Error('[MonitorTaskProcessor] 存在未处理的任务分派分支');
}

function buildPeriodicBaseline(
  task: MonitorTask<MonitorTaskDataMap, 'AUTO_SYMBOL_TICK'>,
): PeriodicSwitchRouteBaseline {
  const data = task.data;
  return {
    monitorSymbol: data.monitorSymbol,
    direction: data.direction,
    symbol: data.symbol,
    seatVersion: data.seatVersion,
    lastSeatActivatedAt: data.lastSeatActivatedAt,
  };
}

/**
 * 创建监控任务处理器。
 * 消费 MonitorTaskQueue 中的任务，使用 setImmediate 异步执行；依赖 getMonitorContext 与各 handler 完成席位校验与刷新。
 *
 * @param deps 依赖注入，包含 monitorTaskQueue、getMonitorContext、各 handler 依赖等
 * @returns 实现 start/stopAndDrain/restart 的处理器实例
 */
export function createMonitorTaskProcessor(deps: MonitorTaskProcessorDeps): MonitorTaskProcessor {
  const {
    monitorTaskQueue,
    getMonitorContext,
    trader,
    marketDataClient,
    quoteSubscriptionRuntime,
    switchWakeupRuntime,
    periodicSwitchWakeupRuntime,
    lastState,
    tradingConfig,
    getCanProcessTask,
    getCanTradeNow,
    onFatalError,
    onProcessed,
  } = deps;

  /** 根据 monitorSymbol 获取监控上下文，未找到时打日志并返回 null */
  function getContextOrSkip(monitorSymbol: string): MonitorTaskContext | null {
    const context = getMonitorContext(monitorSymbol);
    if (!context) {
      logger.warn(`[MonitorTaskProcessor] 未找到监控上下文: ${monitorSymbol}`);
      return null;
    }

    return context;
  }
  const { handleAutoSymbolTick } = createAutoSymbolHandlers({
    getContextOrSkip,
    switchWakeupRuntime,
    periodicSwitchWakeupRuntime,
    getCanTradeNow,
  });
  const handleSeatRefresh = createSeatRefreshHandler({
    getContextOrSkip,
    tradingConfig,
    marketDataClient,
    quoteSubscriptionRuntime,
  });
  const seatRefreshRetryTimers = new Map<string, SeatRefreshRetryTimer>();

  function handoffPeriodicTaskOutcome(
    task: MonitorTask<MonitorTaskDataMap>,
    status: MonitorTaskStatus,
  ): void {
    if (task.type !== 'AUTO_SYMBOL_TICK' || status === 'processed') {
      return;
    }

    const baseline = buildPeriodicBaseline(task);
    periodicSwitchWakeupRuntime.replanRouteAfterTask({
      ...baseline,
      taskTimeMs: task.data.currentTimeMs,
      status,
    });
  }

  /**
   * 为 SEAT_REFRESH 外部 API 失败安排一次延迟重试。
   * 为什么：席位刷新是任务性恢复链路，可由 owner 有界重试；但外部 API 故障不能在同一队列轮次内立即打回，避免瞬时故障被同步放大。
   */
  function retrySeatRefreshOnce(task: MonitorTask<MonitorTaskDataMap>): boolean {
    if (task.type !== 'SEAT_REFRESH') {
      return false;
    }

    const apiRetryAttempt = task.data.apiRetryAttempt ?? 0;
    if (apiRetryAttempt >= 1) {
      return false;
    }

    const pendingTimer = seatRefreshRetryTimers.get(task.dedupeKey);
    if (
      pendingTimer?.direction === task.data.direction &&
      pendingTimer.seatVersion === task.data.seatVersion &&
      pendingTimer.nextSymbol === task.data.nextSymbol
    ) {
      return true;
    }

    if (pendingTimer !== undefined) {
      clearTimeout(pendingTimer.handle);
      seatRefreshRetryTimers.delete(task.dedupeKey);
    }

    const retryTimer = setTimeout(() => {
      seatRefreshRetryTimers.delete(task.dedupeKey);
      const context = getMonitorContext(task.monitorSymbol);
      const currentSeat = context?.symbolRegistry.getSeatState(
        task.data.monitorSymbol,
        task.data.direction,
      );
      const currentSeatVersion = context?.symbolRegistry.getSeatVersion(
        task.data.monitorSymbol,
        task.data.direction,
      );
      if (
        currentSeat === undefined ||
        currentSeatVersion !== task.data.seatVersion ||
        currentSeat.symbol !== task.data.nextSymbol ||
        currentSeat.status !== 'ACTIVATING'
      ) {
        return;
      }

      monitorTaskQueue.scheduleLatest({
        type: 'SEAT_REFRESH',
        dedupeKey: task.dedupeKey,
        monitorSymbol: task.monitorSymbol,
        data: {
          ...task.data,
          apiRetryAttempt: apiRetryAttempt + 1,
        },
      });
    }, API.DEFAULT_RETRY_DELAY_MS);

    seatRefreshRetryTimers.set(task.dedupeKey, {
      handle: retryTimer,
      direction: task.data.direction,
      seatVersion: task.data.seatVersion,
      nextSymbol: task.data.nextSymbol,
    });
    return true;
  }

  function finalizeExhaustedSeatRefresh(task: MonitorTask<MonitorTaskDataMap>): void {
    if (task.type !== 'SEAT_REFRESH') {
      return;
    }

    const context = getMonitorContext(task.monitorSymbol);
    const currentSeat = context?.symbolRegistry.getSeatState(
      task.data.monitorSymbol,
      task.data.direction,
    );
    const currentSeatVersion = context?.symbolRegistry.getSeatVersion(
      task.data.monitorSymbol,
      task.data.direction,
    );
    if (
      context === null ||
      currentSeat === undefined ||
      currentSeatVersion !== task.data.seatVersion ||
      currentSeat.symbol !== task.data.nextSymbol ||
      currentSeat.status !== 'ACTIVATING'
    ) {
      return;
    }

    const nowMs = Date.now();
    context.symbolRegistry.updateSeatStateWithVersionBump(
      task.data.monitorSymbol,
      task.data.direction,
      {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: nowMs,
        lastSearchAt: currentSeat.lastSearchAt ?? nowMs,
        lastSeatActivatedAt: null,
        callPrice: null,
        searchFailCountToday: currentSeat.searchFailCountToday,
        frozenTradingDayKey: currentSeat.frozenTradingDayKey,
      },
    );
  }

  /** 清理尚未触发的 SEAT_REFRESH 延迟重试，保证 stop/restart 后没有隐藏 timer。 */
  function clearSeatRefreshRetryTimers(): void {
    for (const retryTimer of seatRefreshRetryTimers.values()) {
      clearTimeout(retryTimer.handle);
    }

    seatRefreshRetryTimers.clear();
  }

  async function processTask(
    task: MonitorTask<MonitorTaskDataMap>,
    helpers: RefreshHelpers,
  ): Promise<MonitorTaskStatus> {
    switch (task.type) {
      case 'AUTO_SYMBOL_TICK': {
        return handleAutoSymbolTick(task);
      }

      case 'SEAT_REFRESH': {
        return handleSeatRefresh(task, helpers);
      }

      default: {
        return assertNeverTask(task);
      }
    }
  }

  /** 循环消费监控任务队列直至为空；生命周期门禁关闭时跳过，处理结果按实际 status 通知 owner 与 onProcessed。 */
  async function processQueue(): Promise<void> {
    const helpers = createRefreshHelpers({ trader, lastState, quoteSubscriptionRuntime });
    while (!monitorTaskQueue.isEmpty()) {
      const task = monitorTaskQueue.pop();
      if (!task) {
        break;
      }

      if (getCanProcessTask && !getCanProcessTask()) {
        logger.debug(
          `[MonitorTaskProcessor] 任务跳过：生命周期门禁关闭 type=${task.type} monitor=${task.monitorSymbol} dedupe=${task.dedupeKey}`,
        );
        handoffPeriodicTaskOutcome(task, 'skipped');
        onProcessed?.(task, 'skipped');
        continue;
      }

      const status = await processTask(task, helpers).catch((err: unknown) => {
        if (!isExternalApiRequestError(err)) {
          throw err;
        }

        logger.error(
          `[MonitorTaskProcessor] 处理任务失败 type=${task.type} monitor=${task.monitorSymbol} dedupe=${task.dedupeKey}`,
          formatError(err),
        );
        const retryScheduled = retrySeatRefreshOnce(task);
        if (!retryScheduled) {
          finalizeExhaustedSeatRefresh(task);
        }

        return 'failed' as const;
      });

      if (status === 'processed' || status === 'skipped') {
        const retryTimer = seatRefreshRetryTimers.get(task.dedupeKey);
        if (retryTimer !== undefined) {
          clearTimeout(retryTimer.handle);
          seatRefreshRetryTimers.delete(task.dedupeKey);
        }
      }

      handoffPeriodicTaskOutcome(task, status);
      onProcessed?.(task, status);
    }
  }
  const queueRunner = createQueueRunner({
    monitorTaskQueue,
    processQueue,
    onQueueError: (err) => {
      logger.error('[MonitorTaskProcessor] 处理队列时发生错误', formatError(err));
      onFatalError?.(err);
    },
    onAlreadyRunning: () => {
      logger.warn('[MonitorTaskProcessor] 处理器已在运行中');
    },
  });
  return {
    start: () => {
      queueRunner.start();
    },
    stopAndDrain: async () => {
      clearSeatRefreshRetryTimers();
      await queueRunner.stopAndDrain();
      clearSeatRefreshRetryTimers();
    },
    restart: () => {
      clearSeatRefreshRetryTimers();
      queueRunner.restart();
    },
  };
}
