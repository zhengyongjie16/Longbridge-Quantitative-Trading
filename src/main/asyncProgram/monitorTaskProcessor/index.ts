/**
 * 监控任务处理器模块
 *
 * 功能：
 * - 消费 MonitorTaskQueue 中的监控任务
 * - 使用 setImmediate 异步执行，不阻塞主循环
 * - 处理多种监控任务类型（自动换标、席位刷新、清仓检查等）
 *
 * 支持的任务类型：
 * - AUTO_SYMBOL_TICK：自动寻标（席位为空时触发）
 * - AUTO_SYMBOL_SWITCH_DISTANCE：距离触发换标检查
 * - SEAT_REFRESH：席位刷新（换标后刷新订单记录、浮亏数据）
 * - LIQUIDATION_DISTANCE_CHECK：牛熊证距回收价清仓检查
 * - UNREALIZED_LOSS_CHECK：浮亏清仓检查
 *
 * 席位快照验证：
 * - 任务携带创建时的席位快照（版本号+标的）
 * - 处理前验证快照是否与当前席位一致
 * - 防止换标后执行旧席位的任务
 */
import { logger } from '../../../utils/logger/index.js';
import { ORDER_QUOTE_RETRY } from '../../../constants/index.js';
import { createQueueRunner } from './queueRunner.js';
import { createRefreshHelpers } from './helpers/refreshHelpers.js';
import { createAutoSymbolHandlers } from './handlers/autoSymbol.js';
import { createSeatRefreshHandler } from './handlers/seatRefresh.js';
import { createLiquidationDistanceHandler } from './handlers/liquidationDistance.js';
import { createUnrealizedLossHandler } from './handlers/unrealizedLoss.js';
import type { MonitorTask } from '../monitorTaskQueue/types.js';
import { formatError } from '../../../utils/error/index.js';
import type {
  MonitorTaskContext,
  MonitorTaskDataMap,
  MonitorTaskProcessor,
  MonitorTaskProcessorDeps,
  MonitorTaskRetryRequest,
  MonitorTaskStatus,
  RefreshHelpers,
} from './types.js';

/**
 * 兜底的穷尽性断言，防止新增任务类型后遗漏分派逻辑。
 *
 * 一旦出现未覆盖类型，立即抛错并暴露实现缺口。
 */
function assertNeverTask(_task: never): never {
  throw new Error('[MonitorTaskProcessor] 存在未处理的任务分派分支');
}

/**
 * 创建监控任务处理器。
 * 消费 MonitorTaskQueue 中的任务，使用 setImmediate 异步执行；依赖 getMonitorContext、refreshGate 等完成席位校验与刷新。
 *
 * @param deps 依赖注入，包含 monitorTaskQueue、refreshGate、getMonitorContext、各 handler 依赖等
 * @returns 实现 start/stop/stopAndDrain/restart 的处理器实例
 */
export function createMonitorTaskProcessor(deps: MonitorTaskProcessorDeps): MonitorTaskProcessor {
  const {
    monitorTaskQueue,
    refreshGate,
    getMonitorContext,
    clearMonitorDirectionQueues,
    trader,
    marketDataClient,
    lastState,
    tradingConfig,
    scheduleRetry,
    clearRetry,
    getCanProcessTask,
    onProcessed,
  } = deps;

  type RetryRegistryEntry = {
    handle: ReturnType<typeof setTimeout>;
  };

  const schedule =
    scheduleRetry ??
    ((callback: () => void, delayMs: number) => {
      return setTimeout(callback, delayMs);
    });
  const clear =
    clearRetry ??
    ((handle: ReturnType<typeof setTimeout>) => {
      clearTimeout(handle);
    });
  const retryRegistry = new Map<string, RetryRegistryEntry>();
  let lifecycleActive = true;

  function clearRetryEntry(retryKey: string): void {
    const retryEntry = retryRegistry.get(retryKey);
    if (!retryEntry) {
      return;
    }

    clear(retryEntry.handle);
    retryRegistry.delete(retryKey);
  }

  function clearAllRetryEntries(): void {
    for (const retryKey of retryRegistry.keys()) {
      clearRetryEntry(retryKey);
    }
  }

  function scheduleTaskRetry(retryRequest: MonitorTaskRetryRequest): void {
    if (!lifecycleActive || retryRegistry.has(retryRequest.retryKey)) {
      return;
    }

    const handle = schedule(() => {
      const retryEntry = retryRegistry.get(retryRequest.retryKey);
      if (!retryEntry || !lifecycleActive) {
        return;
      }

      retryRegistry.delete(retryRequest.retryKey);
      monitorTaskQueue.scheduleLatest(retryRequest.task);
    }, ORDER_QUOTE_RETRY.INTERVAL_MS);
    retryRegistry.set(retryRequest.retryKey, { handle });
  }

  /** 根据 monitorSymbol 获取监控上下文，未找到时打日志并返回 null */
  function getContextOrSkip(monitorSymbol: string): MonitorTaskContext | null {
    const context = getMonitorContext(monitorSymbol);
    if (!context) {
      logger.warn(`[MonitorTaskProcessor] 未找到监控上下文: ${monitorSymbol}`);
      return null;
    }

    return context;
  }
  const { handleAutoSymbolTick, handleAutoSymbolSwitchDistance } = createAutoSymbolHandlers({
    getContextOrSkip,
    refreshGate,
    lastState,
    ...(getCanProcessTask ? { getCanProcessTask } : {}),
  });
  const handleSeatRefresh = createSeatRefreshHandler({
    getContextOrSkip,
    clearMonitorDirectionQueues,
    tradingConfig,
    marketDataClient,
  });
  const handleLiquidationDistanceCheck = createLiquidationDistanceHandler({
    getContextOrSkip,
    refreshGate,
    marketDataClient,
    lastState,
    trader,
    ...(getCanProcessTask ? { getCanProcessTask } : {}),
  });
  const handleUnrealizedLossCheck = createUnrealizedLossHandler({
    getContextOrSkip,
    refreshGate,
    marketDataClient,
    trader,
    ...(getCanProcessTask ? { getCanProcessTask } : {}),
  });
  async function processTask(
    task: MonitorTask<MonitorTaskDataMap>,
    helpers: RefreshHelpers,
  ): Promise<{
    readonly status: MonitorTaskStatus;
    readonly retryRequest: MonitorTaskRetryRequest | null;
  }> {
    switch (task.type) {
      case 'AUTO_SYMBOL_TICK': {
        return { status: await handleAutoSymbolTick(task), retryRequest: null };
      }

      case 'AUTO_SYMBOL_SWITCH_DISTANCE': {
        return { status: await handleAutoSymbolSwitchDistance(task), retryRequest: null };
      }

      case 'SEAT_REFRESH': {
        return { status: await handleSeatRefresh(task, helpers), retryRequest: null };
      }

      case 'LIQUIDATION_DISTANCE_CHECK': {
        return handleLiquidationDistanceCheck(task);
      }

      case 'UNREALIZED_LOSS_CHECK': {
        return handleUnrealizedLossCheck(task);
      }

      default: {
        return assertNeverTask(task);
      }
    }
  }

  /** 循环消费监控任务队列直至为空，每项经 processTask 分派处理，门禁或上下文缺失时跳过并通知 onProcessed */
  async function processQueue(): Promise<void> {
    const helpers = createRefreshHelpers({ trader, lastState });
    while (!monitorTaskQueue.isEmpty()) {
      const task = monitorTaskQueue.pop();
      if (!task) {
        break;
      }

      if (getCanProcessTask && !getCanProcessTask()) {
        logger.debug(
          `[MonitorTaskProcessor] 任务跳过：生命周期门禁关闭 type=${task.type} monitor=${task.monitorSymbol} dedupe=${task.dedupeKey}`,
        );
        onProcessed?.(task, 'skipped');
        continue;
      }

      const result = await processTask(task, helpers).catch((err: unknown) => {
        logger.error('[MonitorTaskProcessor] 处理任务失败', formatError(err));
        return {
          status: 'failed' as const,
          retryRequest: null,
        };
      });
      if (result.retryRequest) {
        scheduleTaskRetry(result.retryRequest);
      } else if (
        task.type === 'LIQUIDATION_DISTANCE_CHECK' ||
        task.type === 'UNREALIZED_LOSS_CHECK'
      ) {
        clearRetryEntry(`${task.monitorSymbol}:${task.type}`);
      }

      onProcessed?.(task, result.status);
    }
  }
  const queueRunner = createQueueRunner({
    monitorTaskQueue,
    processQueue,
    onQueueError: (err) => {
      logger.error('[MonitorTaskProcessor] 处理队列时发生错误', formatError(err));
    },
    onAlreadyRunning: () => {
      logger.warn('[MonitorTaskProcessor] 处理器已在运行中');
    },
  });
  return {
    start: () => {
      lifecycleActive = true;
      queueRunner.start();
    },
    stop: () => {
      lifecycleActive = false;
      clearAllRetryEntries();
      queueRunner.stop();
    },
    stopAndDrain: async () => {
      lifecycleActive = false;
      clearAllRetryEntries();
      await queueRunner.stopAndDrain();
    },
    restart: () => {
      lifecycleActive = false;
      clearAllRetryEntries();
      queueRunner.restart();
      lifecycleActive = true;
    },
  };
}
