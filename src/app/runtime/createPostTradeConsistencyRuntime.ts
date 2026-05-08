/**
 * 成交后一致性运行时工厂模块
 *
 * 职责：
 * - 统一拥有成交后 freshness gate 与账户/持仓刷新内核
 * - 在运行时未启动前先收口 stale 需求，启动后再消费积压刷新
 * - 统一执行成交后的关键业务收尾：保护性清仓完成判定、daily loss episode 推进、liquidation cooldown 推进与 R1/N1 刷新
 * - 暴露 lifecycle 可调用的 baseline 推进、停止排空与跨日清理能力
 */
import { API } from '../../constants/index.js';
import type { ProtectiveLiquidationDirection } from '../../core/trader/protectiveLiquidationEpisodeTracker/types.js';
import type { AccountSnapshot, Position } from '../../types/account.js';
import type { MonitorContext } from '../../types/state.js';
import type {
  PostTradeConsistencyFreshReachedEvent,
  PostTradeConsistencyRefreshNeed,
  Trader,
} from '../../types/services.js';
import { formatError } from '../../utils/error/index.js';
import { isExternalApiRequestError } from '../../utils/apiFailure/index.js';
import { logger } from '../../utils/logger/index.js';
import { createRefreshGate } from '../../utils/refreshGate/index.js';
import { isSeatActive } from '../../utils/seat/guards.js';
import type {
  PostTradeConsistencyRuntime,
  PostTradeConsistencyRuntimeBusinessDeps,
  PostTradeConsistencyRuntimeDeps,
  PostTradeConsistencyRuntimeStatus,
} from '../types.js';

/**
 * 合并两次成交后刷新需求。
 *
 * @param current 当前积压的刷新需求
 * @param incoming 新进入的刷新需求
 * @returns 合并后的刷新需求
 */
function mergeRefreshNeed(
  current: PostTradeConsistencyRefreshNeed,
  incoming: PostTradeConsistencyRefreshNeed,
): PostTradeConsistencyRefreshNeed {
  return {
    refreshAccount: current.refreshAccount || incoming.refreshAccount,
    refreshPositions: current.refreshPositions || incoming.refreshPositions,
  };
}

/**
 * 创建空的刷新需求初始值。
 *
 * @returns 不要求刷新账户也不要求刷新持仓的空需求
 */
function createEmptyRefreshNeed(): PostTradeConsistencyRefreshNeed {
  return {
    refreshAccount: false,
    refreshPositions: false,
  };
}

/**
 * 判断当前是否还存在待处理刷新需求。
 *
 * @param need 待判断的刷新需求
 * @returns 只要账户或持仓任一维度需要刷新即返回 true
 */
function hasRefreshNeed(need: PostTradeConsistencyRefreshNeed): boolean {
  return need.refreshAccount || need.refreshPositions;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(formatError(error));
}

/**
 * 选取需要保留的刷新版本。
 *
 * 在刷新失败且期间又收到更新 stale 版本时，必须保留更大的版本号，
 * 避免把更新版本回退成旧批次版本。
 *
 * @param currentPendingVersion 当前已积压的版本号
 * @param fallbackVersion 本批次至少要保留的版本号
 * @returns 下一次重试应追上的目标版本
 */
function mergePendingVersion(
  currentPendingVersion: number | null,
  fallbackVersion: number,
): number {
  if (currentPendingVersion === null) {
    return fallbackVersion;
  }

  return Math.max(currentPendingVersion, fallbackVersion);
}

/**
 * 解析指定方向当前可归属的席位标的。
 *
 * @param monitorContext 监控上下文
 * @param direction 保护性清仓方向
 * @returns 当前激活席位的标的代码；若席位未激活则返回 null
 */
function resolveDirectionSeatSymbol(
  monitorContext: MonitorContext,
  direction: ProtectiveLiquidationDirection,
): string | null {
  const seatState = monitorContext.symbolRegistry.getSeatState(
    monitorContext.config.monitorSymbol,
    direction,
  );
  if (!isSeatActive(seatState)) {
    return null;
  }

  return seatState.symbol;
}

/**
 * 判断指定交易标的在最新持仓缓存下是否已空仓。
 *
 * @param symbol 需要判定的原始保护性清仓标的
 * @param getQuantityBySymbol 从 positionCache 读取数量的函数
 * @returns 对应标的无持仓或数量小于等于 0 时返回 true
 */
function isSymbolFlatByPositionCache(
  symbol: string,
  getQuantityBySymbol: (symbol: string) => { quantity: number } | null,
): boolean {
  const position = getQuantityBySymbol(symbol);
  if (position === null) {
    return true;
  }

  return position.quantity <= 0;
}

/**
 * 记录交易标的归属，并在检测到重复归属时立即失败。
 *
 * @param attributedContexts 当前已记录的 symbol -> monitorContext 映射
 * @param symbol 待归属的交易标的
 * @param monitorContext 当前 monitorContext
 * @param direction 当前席位方向
 */
function registerAttributedSeatSymbolOrThrow(
  attributedContexts: Map<string, MonitorContext>,
  symbol: string,
  monitorContext: MonitorContext,
  direction: 'LONG' | 'SHORT',
): void {
  const existingContext = attributedContexts.get(symbol);
  if (existingContext !== undefined) {
    throw new Error(
      `[PostTradeConsistencyRuntime] 标的重复归属: ${symbol} 同时归属 ${existingContext.config.monitorSymbol} 与 ${monitorContext.config.monitorSymbol}:${direction}`,
    );
  }

  attributedContexts.set(symbol, monitorContext);
}

/**
 * 构建“交易标的 -> MonitorContext”的归属映射。
 *
 * 仅收集当前激活席位，确保成交后 R1/N1 刷新只触达仍可归属的 symbol。
 *
 * @param monitorContexts 全量监控上下文
 * @returns 可归属 symbol 到 monitorContext 的映射
 */
function buildMonitorContextBySeatSymbol(
  monitorContexts: ReadonlyMap<string, MonitorContext>,
): ReadonlyMap<string, MonitorContext> {
  const attributedContexts = new Map<string, MonitorContext>();

  for (const monitorContext of monitorContexts.values()) {
    const monitorSymbol = monitorContext.config.monitorSymbol;
    const longSeatState = monitorContext.symbolRegistry.getSeatState(monitorSymbol, 'LONG');
    const shortSeatState = monitorContext.symbolRegistry.getSeatState(monitorSymbol, 'SHORT');

    if (isSeatActive(longSeatState)) {
      registerAttributedSeatSymbolOrThrow(
        attributedContexts,
        longSeatState.symbol,
        monitorContext,
        'LONG',
      );
    }

    if (isSeatActive(shortSeatState)) {
      registerAttributedSeatSymbolOrThrow(
        attributedContexts,
        shortSeatState.symbol,
        monitorContext,
        'SHORT',
      );
    }
  }

  return attributedContexts;
}

/**
 * 推进所有满足条件的保护性清仓事件。
 *
 * 业务顺序必须保持为：先基于最新 positionCache 判定事件完成，再推进 daily loss episode 与 cooldown。
 *
 * @param trader Trader 实例，用于判定是否仍有未完成保护性卖单
 * @param businessDeps 已绑定的业务协作者
 * @param getQuantityBySymbol 从最新 positionCache 读取数量的函数
 */
function settleProtectiveLiquidationEpisodes(
  trader: Trader,
  businessDeps: PostTradeConsistencyRuntimeBusinessDeps,
  getQuantityBySymbol: (symbol: string) => { quantity: number } | null,
): void {
  for (const episode of businessDeps.protectiveLiquidationEpisodeTracker.getInProgressEpisodes()) {
    const monitorContext = businessDeps.monitorContexts.get(episode.monitorSymbol);
    if (monitorContext === undefined) {
      continue;
    }

    const isDirectionFlat = isSymbolFlatByPositionCache(episode.symbol, getQuantityBySymbol);
    const hasPendingProtectiveOrders = trader.hasPendingProtectiveLiquidationOrders(
      episode.monitorSymbol,
      episode.direction,
    );
    const completedEvent = businessDeps.protectiveLiquidationEpisodeTracker.completeIfEligible({
      monitorSymbol: episode.monitorSymbol,
      direction: episode.direction,
      isDirectionFlat,
      hasPendingProtectiveOrders,
    });
    if (completedEvent === null) {
      continue;
    }

    businessDeps.dailyLossTracker.startNewProtectionEpisode({
      monitorSymbol: completedEvent.monitorSymbol,
      direction: completedEvent.direction,
      boundaryExecutedTimeMs: completedEvent.boundaryExecutedTimeMs,
    });

    businessDeps.liquidationCooldownTracker.recordLiquidationTrigger({
      symbol: completedEvent.monitorSymbol,
      direction: completedEvent.direction,
      executedTimeMs: completedEvent.boundaryExecutedTimeMs,
      triggerLimit: monitorContext.config.liquidationTriggerLimit,
      cooldownConfig: monitorContext.config.liquidationCooldown,
    });
  }
}

/**
 * 刷新所有可归属 symbol 的浮亏缓存。
 *
 * 仅对当前仍能归属到激活席位的 symbol 刷新 R1/N1，避免把已脱离席位归属的旧 symbol 带入本轮一致性恢复。
 *
 * @param monitorContexts 全量监控上下文
 * @returns 是否全部刷新成功
 */
async function refreshAttributedUnrealizedLossData(
  monitorContexts: ReadonlyMap<string, MonitorContext>,
): Promise<boolean> {
  const attributedContexts = buildMonitorContextBySeatSymbol(monitorContexts);
  let refreshOk = true;

  for (const [symbol, monitorContext] of attributedContexts) {
    const isLongSymbol = resolveDirectionSeatSymbol(monitorContext, 'LONG') === symbol;
    const dailyLossOffset = monitorContext.dailyLossTracker.getLossOffset(
      monitorContext.config.monitorSymbol,
      isLongSymbol,
    );

    try {
      const refreshResult = await monitorContext.riskChecker.refreshUnrealizedLossData(
        monitorContext.orderRecorder,
        symbol,
        isLongSymbol,
        null,
        dailyLossOffset,
      );
      if (refreshResult === null) {
        throw new TypeError(`[PostTradeConsistencyRuntime] 浮亏缓存刷新返回 null: ${symbol}`);
      }
    } catch (error) {
      if (!isExternalApiRequestError(error)) {
        throw error;
      }

      refreshOk = false;
      logger.warn(`[PostTradeConsistencyRuntime] 刷新浮亏缓存失败: ${symbol}`, formatError(error));
    }
  }

  return refreshOk;
}

/**
 * 执行账户/持仓刷新成功后的业务收尾。
 *
 * @param trader Trader 实例
 * @param lastState 运行时状态，用于读取最新持仓缓存
 * @param businessDeps 已绑定的业务协作者
 * @returns 所有后置业务都成功时返回 true
 */
async function runPostRefreshBusinessFlow(
  trader: Trader,
  lastState: PostTradeConsistencyRuntimeDeps['lastState'],
  businessDeps: PostTradeConsistencyRuntimeBusinessDeps,
): Promise<boolean> {
  settleProtectiveLiquidationEpisodes(trader, businessDeps, (symbol) =>
    lastState.positionCache.get(symbol),
  );

  return refreshAttributedUnrealizedLossData(businessDeps.monitorContexts);
}

/**
 * 创建成交后一致性运行时。
 *
 * @param deps 外部依赖注入，仅包含 trader 访问器与 lastState
 * @returns 成交后一致性运行时实例
 */
export function createPostTradeConsistencyRuntime(
  deps: PostTradeConsistencyRuntimeDeps,
): PostTradeConsistencyRuntime {
  const { getTrader, lastState } = deps;
  const refreshGate = createRefreshGate();

  let businessDeps: PostTradeConsistencyRuntimeBusinessDeps | null = null;
  let started = false;
  let inFlight = false;
  let pendingNeed = createEmptyRefreshNeed();
  let pendingVersion: number | null = null;
  let immediateHandle: ReturnType<typeof setImmediate> | null = null;
  let retryHandle: ReturnType<typeof setTimeout> | null = null;
  let drainResolve: (() => void) | null = null;
  let fatalError: Error | null = null;
  const fatalRejectors = new Set<(error: Error) => void>();
  const freshReachedListeners = new Set<(event: PostTradeConsistencyFreshReachedEvent) => void>();

  /**
   * 获取已绑定的业务依赖；缺失时立即失败。
   *
   * 该运行时一旦启动，就必须能完整执行成交后业务收尾，禁止静默降级为仅刷新账户/持仓。
   */
  function getBusinessDepsOrThrow(): PostTradeConsistencyRuntimeBusinessDeps {
    if (businessDeps === null) {
      throw new Error('[postTradeConsistencyRuntime] businessDeps 尚未绑定，禁止启动');
    }

    return businessDeps;
  }

  function recordFatalError(error: unknown): Error {
    if (fatalError !== null) {
      return fatalError;
    }

    fatalError = toError(error);
    for (const reject of fatalRejectors) {
      reject(fatalError);
    }

    fatalRejectors.clear();
    return fatalError;
  }

  /**
   * 通过 setImmediate 调度下一次刷新。
   *
   * 只要进入立即执行通道，就取消失败重试定时器，优先处理最新积压。
   */
  function scheduleRun(): void {
    if (!started || inFlight || immediateHandle !== null || !hasRefreshNeed(pendingNeed)) {
      return;
    }

    if (retryHandle !== null) {
      clearTimeout(retryHandle);
      retryHandle = null;
    }

    immediateHandle = setImmediate(() => {
      immediateHandle = null;
      void runRefresh().catch((error: unknown) => {
        const fatal = recordFatalError(error);
        logger.error('[PostTradeConsistencyRuntime] 刷新调度发生未处理错误', {
          error: formatError(fatal),
        });
      });
    });
  }

  /**
   * 在刷新失败后按固定退避时间重试。
   */
  function scheduleRetry(): void {
    if (!started || inFlight || retryHandle !== null || !hasRefreshNeed(pendingNeed)) {
      return;
    }

    retryHandle = setTimeout(() => {
      retryHandle = null;
      scheduleRun();
    }, API.DEFAULT_RETRY_DELAY_MS);
  }

  /**
   * 执行一次成交后刷新。
   *
   * 固定顺序：账户/持仓刷新 -> positionCache.update -> 保护性清仓完成判定与冷却推进 -> R1/N1 刷新 -> markFresh。
   * 外部失败保留 pending 版本并进入重试；程序内部契约/不变量错误则立即 fail-fast。
   */
  async function runRefresh(): Promise<void> {
    if (!started || inFlight || !hasRefreshNeed(pendingNeed)) {
      return;
    }

    const need = pendingNeed;
    const targetVersion = pendingVersion ?? refreshGate.getStatus().staleVersion;
    pendingNeed = createEmptyRefreshNeed();
    pendingVersion = null;
    inFlight = true;
    let refreshOk = false;
    let fatalInvariantDetected = false;

    try {
      const resolvedBusinessDeps = getBusinessDepsOrThrow();
      const trader = getTrader();
      const [accountSnapshot, positions]: readonly [
        AccountSnapshot | null,
        ReadonlyArray<Position> | null,
      ] = await Promise.all([
        need.refreshAccount ? trader.getAccountSnapshot() : Promise.resolve(null),
        need.refreshPositions ? trader.getStockPositions() : Promise.resolve(null),
      ]);

      if (accountSnapshot !== null) {
        lastState.cachedAccount = accountSnapshot;
      }

      if (positions !== null) {
        lastState.cachedPositions = positions;
        lastState.positionCache.update(positions);
        await deps.onPositionsCommitted?.();
      }

      refreshOk = await runPostRefreshBusinessFlow(trader, lastState, resolvedBusinessDeps);
    } catch (error) {
      if (!isExternalApiRequestError(error)) {
        fatalInvariantDetected = true;
        recordFatalError(error);
        started = false;
        pendingNeed = createEmptyRefreshNeed();
        pendingVersion = null;
        refreshGate.abortWaiting('FATAL_INVARIANT');
        logger.error('[PostTradeConsistencyRuntime] 检测到不可恢复的一致性错误，停止运行时', {
          error: formatError(error),
        });
        throw error;
      }

      logger.warn('[PostTradeConsistencyRuntime] 刷新失败，准备重试', formatError(error));
    } finally {
      if (fatalInvariantDetected) {
        // fatal invariant 已在 catch 中升级为异常，这里只负责阻止重试与版本回滚。
      } else if (refreshOk) {
        refreshGate.markFresh(targetVersion);
        emitFreshReached('REFRESH');
      } else {
        pendingNeed = mergeRefreshNeed(need, pendingNeed);
        pendingVersion = mergePendingVersion(pendingVersion, targetVersion);
      }

      inFlight = false;
      const resolveDrain = drainResolve;
      drainResolve = null;
      resolveDrain?.();

      if (!fatalInvariantDetected && hasRefreshNeed(pendingNeed)) {
        if (refreshOk) {
          scheduleRun();
        } else {
          scheduleRetry();
        }
      }
    }
  }

  /**
   * 广播 fresh reached 事件。
   *
   * @param trigger 当前 fresh 推进来源
   */
  function emitFreshReached(trigger: PostTradeConsistencyFreshReachedEvent['trigger']): void {
    const { currentVersion, staleVersion } = refreshGate.getStatus();
    const event: PostTradeConsistencyFreshReachedEvent = {
      currentVersion,
      staleVersion,
      trigger,
    };

    for (const listener of freshReachedListeners) {
      listener(event);
    }
  }

  /**
   * 绑定 monitor contexts 与风险协作者。
   *
   * 运行时先于 monitor contexts 创建，因此业务依赖需要在顶层装配完成后显式绑定。
   * 重复绑定视为用最新依赖替换旧依赖。
   *
   * @param deps 业务依赖集合
   */
  function bindBusinessDeps(runtimeBusinessDeps: PostTradeConsistencyRuntimeBusinessDeps): void {
    buildMonitorContextBySeatSymbol(runtimeBusinessDeps.monitorContexts);
    businessDeps = runtimeBusinessDeps;
  }

  /**
   * 记录一次成交后的刷新需求。
   *
   * 每次记录都会推进 staleVersion；若运行时已经启动，则会尽快消费当前积压需求。
   *
   * @param need 本次成交产生的刷新意图
   */
  function recordSettlementRefreshNeed(need: PostTradeConsistencyRefreshNeed): void {
    if (!hasRefreshNeed(need)) {
      return;
    }

    pendingNeed = mergeRefreshNeed(pendingNeed, need);
    pendingVersion = refreshGate.markStale();
    if (started) {
      scheduleRun();
    }
  }

  /**
   * 读取运行时当前状态。
   *
   * @returns 启动态与 freshness 版本号快照
   */
  function getStatus(): PostTradeConsistencyRuntimeStatus {
    const gateStatus = refreshGate.getStatus();

    return {
      started,
      currentVersion: gateStatus.currentVersion,
      staleVersion: gateStatus.staleVersion,
    };
  }

  /**
   * 等待当前 freshness 恢复。
   *
   * @returns 当 currentVersion 追上 staleVersion 时 resolve
   */
  function waitForFresh(): Promise<void> {
    return refreshGate.waitForFresh();
  }

  /**
   * 订阅 freshness 追平事件。
   *
   * @param listener 监听器
   * @returns 取消订阅函数
   */
  function onFreshReached(
    listener: (event: PostTradeConsistencyFreshReachedEvent) => void,
  ): () => void {
    freshReachedListeners.add(listener);
    return () => {
      freshReachedListeners.delete(listener);
    };
  }

  function drainFatalError(): Promise<never> {
    if (fatalError !== null) {
      return Promise.reject(fatalError);
    }

    return new Promise<never>((_, reject) => {
      fatalRejectors.add(reject);
    });
  }

  /**
   * 终止当前 freshness 等待轮次。
   *
   * stopAndDrain / 午夜清理前需要先打断等待方，避免继续等待本轮不再推进的 freshness。
   */
  function abortWaiting(): void {
    refreshGate.abortWaiting('STOP_AND_DRAIN');
  }

  /**
   * 清除上一轮生命周期留下的 abort 状态。
   *
   * 开盘重建会重新建立 freshness 基线，因此必须先恢复可等待状态。
   */
  function resetAbort(): void {
    refreshGate.resetAbort();
  }

  /**
   * 启动运行时并尝试消费启动前积压的刷新需求。
   */
  function start(): void {
    if (started) {
      return;
    }

    getBusinessDepsOrThrow();
    started = true;
    scheduleRun();
  }

  /**
   * 停止运行时并等待当前在途刷新完成。
   *
   * 已积压但尚未执行的需求不会被清除，供后续重新 start 时继续消费。
   * 若最后一次刷新以 fatal 程序错误结束，则在排空时重新抛出该错误。
   *
   * @returns 在没有在途刷新后 resolve；fatal 刷新错误会在此处抛出
   */
  async function stopAndDrain(): Promise<void> {
    started = false;
    if (immediateHandle !== null) {
      clearImmediate(immediateHandle);
      immediateHandle = null;
    }

    if (retryHandle !== null) {
      clearTimeout(retryHandle);
      retryHandle = null;
    }

    if (inFlight) {
      await new Promise<void>((resolve) => {
        drainResolve = resolve;
      });
    }

    if (fatalError !== null) {
      throw fatalError;
    }
  }

  /**
   * 执行跨日清理。
   *
   * 当前日内未消费的刷新需求会被丢弃，freshness 版本推进交由后续 baseline 处理。
   */
  function midnightClear(): void {
    started = false;
    if (immediateHandle !== null) {
      clearImmediate(immediateHandle);
      immediateHandle = null;
    }

    if (retryHandle !== null) {
      clearTimeout(retryHandle);
      retryHandle = null;
    }

    pendingNeed = createEmptyRefreshNeed();
    pendingVersion = null;
  }

  /**
   * 在重建链路确认无积压、无在途时补齐 freshness 基线。
   *
   * 若仍存在 pending 或 in-flight，则不得提前推进 fresh，避免向等待方暴露伪 fresh 状态。
   */
  function completeRebuildBaseline(): void {
    if (inFlight || hasRefreshNeed(pendingNeed)) {
      return;
    }

    const { staleVersion } = refreshGate.getStatus();
    refreshGate.markFresh(staleVersion);
    emitFreshReached('REBUILD_BASELINE');
  }

  return {
    bindBusinessDeps,
    recordSettlementRefreshNeed,
    getStatus,
    waitForFresh,
    onFreshReached,
    drainFatalError,
    abortWaiting,
    resetAbort,
    start,
    stopAndDrain,
    midnightClear,
    completeRebuildBaseline,
  };
}
