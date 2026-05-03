/**
 * app 顶层组装入口模块
 *
 * 职责：
 * - 收口 pre-gate / post-gate runtime 创建
 * - 保持启动快照失败回退与开盘重建语义不变
 * - 在唯一装配入口中创建 monitor contexts、async runtime、lifecycle 与 cleanup
 */
import { validateRuntimeSymbolsFromQuotesMap } from '../config/validator/index.js';
import { createBusinessEventProgram } from '../main/businessEventProgram/index.js';
import { createRebuildTradingDayState } from '../main/lifecycle/rebuildTradingDayState.js';
import { timeWakeupEvaluationProgram } from '../main/timeWakeupEvaluationProgram/index.js';
import { createTimeWakeupRuntime } from '../main/timeWakeupRuntime/index.js';
import { applyStartupSnapshotFailureState } from '../main/lifecycle/startupFailureState.js';
import { displayAccountAndPositions } from '../services/accountDisplay/index.js';
import { logger } from '../utils/logger/index.js';
import { formatError } from '../utils/error/index.js';
import { TRADING } from '../constants/index.js';
import { createCleanup } from './shutdown/createCleanup.js';
import { createLifecycleRuntime } from './lifecycle/createLifecycleRuntime.js';
import { createMonitorContexts } from './context/createMonitorContexts.js';
import { registerDelayedSignalHandlers } from './wiring/registerDelayedSignalHandlers.js';
import { loadStartupSnapshot } from './startup/startupSnapshot.js';
import { collectRuntimeValidationSymbols } from './startup/runtimeValidation.js';
import { createAsyncRuntime } from './runtime/createAsyncRuntime.js';
import { createPostGateRuntime } from './runtime/createPostGateRuntime.js';
import { createPreGateRuntime } from './runtime/createPreGateRuntime.js';
import type { AppEnvironmentParams, RunAppDeps } from './types.js';

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    const handleShutdown = (): void => {
      process.off('SIGINT', handleShutdown);
      process.off('SIGTERM', handleShutdown);
      resolve();
    };

    process.once('SIGINT', handleShutdown);
    process.once('SIGTERM', handleShutdown);
  });
}

const DEFAULT_RUN_APP_DEPS: RunAppDeps = {
  createPreGateRuntime,
  createPostGateRuntime,
  loadStartupSnapshot,
  collectRuntimeValidationSymbols,
  createMonitorContexts,
  createRebuildTradingDayState,
  displayAccountAndPositions,
  registerDelayedSignalHandlers,
  createBusinessEventProgram,
  createAsyncRuntime,
  createLifecycleRuntime,
  createCleanup,
  createTimeWakeupRuntime,
  waitForShutdownSignal,
  logger,
  formatError,
  validateRuntimeSymbolsFromQuotesMap,
  applyStartupSnapshotFailureState,
};

/**
 * 构造 app 运行期统一环境快照。
 * 默认行为：以进程环境为基线，允许调用方显式覆盖同名键。
 *
 * @param env 调用方传入的环境变量对象
 * @returns 完整环境变量快照
 */
function buildAppRuntimeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...env,
  };
}

/**
 * 创建 app 主入口。
 *
 * @param deps app 组装链路依赖
 * @returns runApp 函数
 */
export function createRunApp(deps: RunAppDeps): (params: AppEnvironmentParams) => Promise<void> {
  const {
    createPreGateRuntime: buildPreGateRuntime,
    createPostGateRuntime: buildPostGateRuntime,
    loadStartupSnapshot: loadStartupRuntimeSnapshot,
    collectRuntimeValidationSymbols: buildRuntimeValidationCollector,
    createMonitorContexts: buildMonitorContexts,
    createRebuildTradingDayState: buildRebuildTradingDayState,
    displayAccountAndPositions: renderAccountAndPositions,
    registerDelayedSignalHandlers: bindDelayedSignalHandlers,
    createBusinessEventProgram: buildBusinessEventProgram,
    createAsyncRuntime: buildAsyncRuntime,
    createLifecycleRuntime: buildLifecycleRuntime,
    createCleanup: buildCleanup,
    createTimeWakeupRuntime: buildTimeWakeupRuntime,
    waitForShutdownSignal: waitForShutdown,
    logger: appLogger,
    formatError: formatAppError,
    validateRuntimeSymbolsFromQuotesMap: validateRuntimeSymbols,
    applyStartupSnapshotFailureState: applyStartupSnapshotFailure,
  } = deps;

  return async function runApp(params: AppEnvironmentParams): Promise<void> {
    const runtimeEnv = buildAppRuntimeEnv(params.env);

    const preGateRuntime = await buildPreGateRuntime({ env: runtimeEnv });
    const startupNow = new Date();
    const postGateRuntime = await buildPostGateRuntime({
      env: runtimeEnv,
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

    postGateRuntime.postTradeConsistencyRuntime.bindBusinessDeps({
      monitorContexts: postGateRuntime.monitorContexts,
      dailyLossTracker: postGateRuntime.dailyLossTracker,
      liquidationCooldownTracker: postGateRuntime.liquidationCooldownTracker,
      protectiveLiquidationEpisodeTracker: postGateRuntime.protectiveLiquidationEpisodeTracker,
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

    const asyncRuntime = buildAsyncRuntime({
      preGateRuntime,
      postGateRuntime,
    });
    const businessEventProgram = buildBusinessEventProgram({
      marketDataClient: preGateRuntime.marketDataClient,
      monitorContexts: postGateRuntime.monitorContexts,
      lastState: postGateRuntime.lastState,
      tradingConfig: preGateRuntime.tradingConfig,
      buyTaskQueue: postGateRuntime.buyTaskQueue,
      sellTaskQueue: postGateRuntime.sellTaskQueue,
      indicatorCache: postGateRuntime.indicatorCache,
      monitorDisplayRuntime: postGateRuntime.monitorDisplayRuntime,
    });
    const dayLifecycleManager = buildLifecycleRuntime({
      preGateRuntime,
      postGateRuntime,
      asyncRuntime,
      businessEventProgram,
      rebuildTradingDayState,
    });

    bindDelayedSignalHandlers({
      monitorContexts: postGateRuntime.monitorContexts,
      lastState: postGateRuntime.lastState,
      buyTaskQueue: postGateRuntime.buyTaskQueue,
      sellTaskQueue: postGateRuntime.sellTaskQueue,
      logger: appLogger,
      doomsdayProtectionEnabled: preGateRuntime.tradingConfig.global.doomsdayProtection,
    });

    const timeWakeupRuntime = buildTimeWakeupRuntime({
      evaluate: () =>
        timeWakeupEvaluationProgram({
          marketDataClient: preGateRuntime.marketDataClient,
          trader: postGateRuntime.trader,
          lastState: postGateRuntime.lastState,
          doomsdayProtection: postGateRuntime.doomsdayProtection,
          tradingConfig: preGateRuntime.tradingConfig,
          monitorContexts: postGateRuntime.monitorContexts,
          tradingGateEventRuntime: postGateRuntime.tradingGateEventRuntime,
          quoteSubscriptionRuntime: postGateRuntime.quoteSubscriptionRuntime,
          dayLifecycleManager,
        }),
      now: () => new Date(Date.now()),
      scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
      recoveryRetryDelayMs: TRADING.INTERVAL_MS,
      logger: appLogger,
    });

    const cleanup = buildCleanup({
      buyProcessor: asyncRuntime.buyProcessor,
      sellProcessor: asyncRuntime.sellProcessor,
      monitorTaskProcessor: asyncRuntime.monitorTaskProcessor,
      trader: postGateRuntime.trader,
      businessEventProgram,
      tradingRiskEventRuntime: postGateRuntime.tradingRiskEventRuntime,
      monitorQuoteEventRuntime: postGateRuntime.monitorQuoteEventRuntime,
      monitorDisplayRuntime: postGateRuntime.monitorDisplayRuntime,
      tradingQuoteDisplayRuntime: postGateRuntime.tradingQuoteDisplayRuntime,
      switchWakeupRuntime: postGateRuntime.switchWakeupRuntime,
      autoSearchWakeupRuntime: postGateRuntime.autoSearchWakeupRuntime,
      seatActivationDispatcher: postGateRuntime.seatActivationDispatcher,
      seatRuntimeCleanupDispatcher: postGateRuntime.seatRuntimeCleanupDispatcher,
      quoteSubscriptionRuntime: postGateRuntime.quoteSubscriptionRuntime,
      postTradeConsistencyRuntime: postGateRuntime.postTradeConsistencyRuntime,
      periodicSwitchWakeupRuntime: postGateRuntime.periodicSwitchWakeupRuntime,
      timeWakeupRuntime,
      marketDataClient: preGateRuntime.marketDataClient,
      monitorContexts: postGateRuntime.monitorContexts,
      indicatorCache: postGateRuntime.indicatorCache,
      lastState: postGateRuntime.lastState,
    });

    let initialRebuildSucceeded = false;
    if (startupSnapshot.startupRebuildPending) {
      appLogger.warn('启动阶段跳过初次重建，保持静止并等待生命周期重建任务自动恢复');
    } else {
      try {
        await rebuildTradingDayState({
          allOrders: startupSnapshot.allOrders,
          quotesMap: startupSnapshot.quotesMap,
          now: startupSnapshot.now,
        });
        initialRebuildSucceeded = true;
      } catch (err) {
        applyStartupSnapshotFailure(postGateRuntime.lastState, startupSnapshot.now);
        appLogger.error(
          '启动初始重建失败：已阻断交易并切换为开盘重建重试模式',
          formatAppError(err),
        );
      }
    }

    if (initialRebuildSucceeded) {
      postGateRuntime.postTradeConsistencyRuntime.start();
      postGateRuntime.postTradeConsistencyRuntime.completeRebuildBaseline();
      await postGateRuntime.quoteSubscriptionRuntime.reconcileFromCurrentTruth();
      postGateRuntime.tradingQuoteDisplayRuntime.start();
      postGateRuntime.quoteSubscriptionRuntime.start();
      postGateRuntime.seatRuntimeCleanupDispatcher.start();
      postGateRuntime.seatActivationDispatcher.start();
      postGateRuntime.autoSearchWakeupRuntime.start();
      postGateRuntime.periodicSwitchWakeupRuntime.start();
      postGateRuntime.monitorDisplayRuntime.start();
      businessEventProgram.start();
      postGateRuntime.tradingRiskEventRuntime.start();
      postGateRuntime.monitorQuoteEventRuntime.start();
      postGateRuntime.switchWakeupRuntime.start();
      asyncRuntime.monitorTaskProcessor.start();
      asyncRuntime.buyProcessor.start();
      asyncRuntime.sellProcessor.start();
      postGateRuntime.trader.startOrderMonitorRuntime();
    }

    timeWakeupRuntime.start();
    appLogger.info('程序开始运行，在交易时段将进行实时监控和交易（按 Ctrl+C 退出）');
    await waitForShutdown();
    await cleanup.execute();
  };
}

/**
 * 运行应用主入口。
 *
 * @param params 当前环境变量
 * @returns 启动运行时后等待 shutdown；初始化失败或 cleanup 聚合错误会抛出
 */
export const runApp = createRunApp(DEFAULT_RUN_APP_DEPS);
