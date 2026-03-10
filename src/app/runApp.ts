/**
 * app 顶层组装入口模块
 *
 * 职责：
 * - 收口 pre-gate / post-gate runtime 创建
 * - 保持启动快照失败回退与开盘重建语义不变
 * - 在唯一装配入口中创建 monitor contexts、async runtime、lifecycle 与 cleanup
 */
import { validateRuntimeSymbolsFromQuotesMap } from '../config/config.validator.js';
import { createRebuildTradingDayState } from '../main/lifecycle/rebuildTradingDayState.js';
import { mainProgram } from '../main/mainProgram/index.js';
import { applyStartupSnapshotFailureState } from '../main/lifecycle/startupFailureState.js';
import { sleep } from '../main/utils.js';
import { displayAccountAndPositions } from '../services/accountDisplay/index.js';
import { logger } from '../utils/logger/index.js';
import { signalObjectPool } from '../utils/objectPool/index.js';
import { formatError } from '../utils/error/index.js';
import { getShushCow } from '../utils/asciiArt/shushCow.js';
import { TRADING } from '../constants/index.js';
import { createCleanup } from './createCleanup.js';
import { createLifecycleRuntime } from './createLifecycleRuntime.js';
import { createMonitorContexts } from './createMonitorContexts.js';
import { registerDelayedSignalHandlers } from './registerDelayedSignalHandlers.js';
import { loadStartupSnapshot } from './startupSnapshot.js';
import { collectRuntimeValidationSymbols } from './runtimeValidation.js';
import { createAsyncRuntime } from './runtime/createAsyncRuntime.js';
import { createPostGateRuntime } from './runtime/createPostGateRuntime.js';
import { createPreGateRuntime } from './runtime/createPreGateRuntime.js';
import type { AppEnvironmentParams, RunAppDeps } from './types.js';

const DEFAULT_RUN_APP_DEPS: RunAppDeps = {
  getShushCow,
  createPreGateRuntime,
  createPostGateRuntime,
  loadStartupSnapshot,
  collectRuntimeValidationSymbols,
  createMonitorContexts,
  createRebuildTradingDayState,
  displayAccountAndPositions,
  registerDelayedSignalHandlers,
  createAsyncRuntime,
  createLifecycleRuntime,
  createCleanup,
  mainProgram,
  sleep,
  logger,
  formatError,
  validateRuntimeSymbolsFromQuotesMap,
  applyStartupSnapshotFailureState,
};

/**
 * 创建 app 主入口。
 *
 * @param deps app 组装链路依赖；生产环境使用默认依赖，测试可注入受控替身
 * @returns runApp 函数
 */
export function createRunApp(deps: RunAppDeps): (params: AppEnvironmentParams) => Promise<void> {
  const {
    getShushCow: runShushCow,
    createPreGateRuntime: buildPreGateRuntime,
    createPostGateRuntime: buildPostGateRuntime,
    loadStartupSnapshot: loadStartupRuntimeSnapshot,
    collectRuntimeValidationSymbols: buildRuntimeValidationCollector,
    createMonitorContexts: buildMonitorContexts,
    createRebuildTradingDayState: buildRebuildTradingDayState,
    displayAccountAndPositions: renderAccountAndPositions,
    registerDelayedSignalHandlers: bindDelayedSignalHandlers,
    createAsyncRuntime: buildAsyncRuntime,
    createLifecycleRuntime: buildLifecycleRuntime,
    createCleanup: buildCleanup,
    mainProgram: runMainProgram,
    sleep: waitForNextTick,
    logger: appLogger,
    formatError: formatAppError,
    validateRuntimeSymbolsFromQuotesMap: validateRuntimeSymbols,
    applyStartupSnapshotFailureState: applyStartupSnapshotFailure,
  } = deps;

  return async function runApp(params: AppEnvironmentParams): Promise<void> {
    const { env } = params;
    runShushCow();

    const preGateRuntime = await buildPreGateRuntime({ env });
    const startupNow = new Date();
    const postGateRuntime = await buildPostGateRuntime({
      env,
      preGateRuntime,
      now: startupNow,
    });
    const startupSnapshot = await loadStartupRuntimeSnapshot({
      now: startupNow,
      lastState: postGateRuntime.lastState,
      loadTradingDayRuntimeSnapshot: postGateRuntime.loadTradingDayRuntimeSnapshot,
      applyStartupSnapshotFailureState: applyStartupSnapshotFailure,
      logger: appLogger,
      formatError: formatAppError,
    });
    const runtimeValidationCollector = buildRuntimeValidationCollector({
      tradingConfig: preGateRuntime.tradingConfig,
      symbolRegistry: preGateRuntime.symbolRegistry,
      positions: postGateRuntime.lastState.cachedPositions,
    });
    const runtimeValidationResult = validateRuntimeSymbols({
      inputs: runtimeValidationCollector.runtimeValidationInputs,
      quotesMap: startupSnapshot.quotesMap,
    });

    if (startupSnapshot.startupRebuildPending) {
      appLogger.warn('启动快照失败，跳过运行时标的验证，等待生命周期重建恢复');
    } else {
      if (runtimeValidationResult.warnings.length > 0) {
        appLogger.warn('标的验证出现警告：');
        for (const [index, warning] of runtimeValidationResult.warnings.entries()) {
          appLogger.warn(`${index + 1}. ${warning}`);
        }
      }

      if (!runtimeValidationResult.valid) {
        appLogger.error('标的验证失败！');
        appLogger.error('='.repeat(60));
        for (const [index, error] of runtimeValidationResult.errors.entries()) {
          appLogger.error(`${index + 1}. ${error}`);
        }

        appLogger.error('='.repeat(60));
        const startupAbortError = new Error('运行时标的验证失败，启动已中止');
        startupAbortError.name = 'AppStartupAbortError';
        throw startupAbortError;
      }
    }

    buildMonitorContexts({
      preGateRuntime,
      postGateRuntime,
      quotesMap: startupSnapshot.quotesMap,
    });

    const rebuildTradingDayState = buildRebuildTradingDayState({
      marketDataClient: preGateRuntime.marketDataClient,
      trader: postGateRuntime.trader,
      lastState: postGateRuntime.lastState,
      symbolRegistry: preGateRuntime.symbolRegistry,
      monitorContexts: postGateRuntime.monitorContexts,
      dailyLossTracker: postGateRuntime.dailyLossTracker,
      displayAccountAndPositions: renderAccountAndPositions,
    });

    if (startupSnapshot.startupRebuildPending) {
      appLogger.warn('启动阶段跳过初次重建，后续由生命周期重建任务自动恢复');
    } else {
      await rebuildTradingDayState({
        allOrders: startupSnapshot.allOrders,
        quotesMap: startupSnapshot.quotesMap,
        now: startupSnapshot.now,
      });
      postGateRuntime.refreshGate.markFresh(postGateRuntime.refreshGate.getStatus().staleVersion);
    }

    bindDelayedSignalHandlers({
      monitorContexts: postGateRuntime.monitorContexts,
      lastState: postGateRuntime.lastState,
      buyTaskQueue: postGateRuntime.buyTaskQueue,
      sellTaskQueue: postGateRuntime.sellTaskQueue,
      logger: appLogger,
      releaseSignal: (signal) => {
        signalObjectPool.release(signal);
      },
    });

    const asyncRuntime = buildAsyncRuntime({
      preGateRuntime,
      postGateRuntime,
    });
    const dayLifecycleManager = buildLifecycleRuntime({
      preGateRuntime,
      postGateRuntime,
      asyncRuntime,
      rebuildTradingDayState,
    });

    asyncRuntime.monitorTaskProcessor.start();
    asyncRuntime.buyProcessor.start();
    asyncRuntime.sellProcessor.start();
    asyncRuntime.orderMonitorWorker.start();
    asyncRuntime.postTradeRefresher.start();

    const cleanup = buildCleanup({
      buyProcessor: asyncRuntime.buyProcessor,
      sellProcessor: asyncRuntime.sellProcessor,
      monitorTaskProcessor: asyncRuntime.monitorTaskProcessor,
      orderMonitorWorker: asyncRuntime.orderMonitorWorker,
      postTradeRefresher: asyncRuntime.postTradeRefresher,
      marketDataClient: preGateRuntime.marketDataClient,
      monitorContexts: postGateRuntime.monitorContexts,
      indicatorCache: postGateRuntime.indicatorCache,
      lastState: postGateRuntime.lastState,
    });
    cleanup.registerExitHandlers();

    appLogger.info('程序开始运行，在交易时段将进行实时监控和交易（按 Ctrl+C 退出）');
    for (;;) {
      try {
        await runMainProgram({
          marketDataClient: preGateRuntime.marketDataClient,
          trader: postGateRuntime.trader,
          lastState: postGateRuntime.lastState,
          marketMonitor: postGateRuntime.marketMonitor,
          doomsdayProtection: postGateRuntime.doomsdayProtection,
          signalProcessor: postGateRuntime.signalProcessor,
          tradingConfig: preGateRuntime.tradingConfig,
          dailyLossTracker: postGateRuntime.dailyLossTracker,
          monitorContexts: postGateRuntime.monitorContexts,
          symbolRegistry: preGateRuntime.symbolRegistry,
          indicatorCache: postGateRuntime.indicatorCache,
          buyTaskQueue: postGateRuntime.buyTaskQueue,
          sellTaskQueue: postGateRuntime.sellTaskQueue,
          monitorTaskQueue: postGateRuntime.monitorTaskQueue,
          orderMonitorWorker: asyncRuntime.orderMonitorWorker,
          postTradeRefresher: asyncRuntime.postTradeRefresher,
          lossOffsetLifecycleCoordinator: postGateRuntime.lossOffsetLifecycleCoordinator,
          runtimeGateMode: preGateRuntime.gatePolicies.runtimeGate,
          dayLifecycleManager,
        });
      } catch (err) {
        appLogger.error('本次执行失败', formatAppError(err));
      }

      await waitForNextTick(TRADING.INTERVAL_MS);
    }
  };
}

/**
 * 运行应用主入口。
 *
 * @param params 当前环境变量
 * @returns 永不返回；除初始化失败外会持续驱动主循环
 */
export const runApp = createRunApp(DEFAULT_RUN_APP_DEPS);
