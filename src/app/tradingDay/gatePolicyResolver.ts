/**
 * GatePolicyResolver
 *
 * 职责：
 * - 作为主循环交易日/时段/开盘保护判定的单一 owner
 * - 统一维护 lastState 上与运行时门禁相关的缓存与日志语义
 * - 在离开连续交易时段时执行延迟验证清理收口
 */
import { formatError } from '../../utils/error/index.js';
import type {
  GatePolicyResolver,
  GatePolicyResolverDeps,
  ResolvedGatePolicy,
  TradingDayRuntimeInputs,
} from './types.js';

function clearPendingDelayedSignals(params: {
  readonly monitorContexts: GatePolicyResolverDeps['monitorContexts'];
  readonly logger: Pick<GatePolicyResolverDeps['logger'], 'info'>;
}): void {
  const { monitorContexts, logger } = params;
  let totalCancelled = 0;
  for (const [monitorSymbol, monitorContext] of monitorContexts) {
    const pendingCount = monitorContext.delayedSignalVerifier.getPendingCount();
    if (pendingCount <= 0) {
      continue;
    }

    monitorContext.delayedSignalVerifier.cancelAllForSymbol(monitorSymbol);
    totalCancelled += pendingCount;
  }

  if (totalCancelled > 0) {
    logger.info(`[交易时段结束] 已清理 ${totalCancelled} 个待验证信号`);
  }
}

function resolveOpenProtectionActive(params: {
  readonly currentTime: Date;
  readonly isHalfDay: boolean;
  readonly tradingConfig: GatePolicyResolverDeps['tradingConfig'];
  readonly isWithinMorningOpenProtection: GatePolicyResolverDeps['isWithinMorningOpenProtection'];
  readonly isWithinAfternoonOpenProtection: GatePolicyResolverDeps['isWithinAfternoonOpenProtection'];
}): boolean {
  const {
    currentTime,
    isHalfDay,
    tradingConfig,
    isWithinMorningOpenProtection,
    isWithinAfternoonOpenProtection,
  } = params;
  const { morning, afternoon } = tradingConfig.global.openProtection;
  const morningActive =
    morning.enabled &&
    morning.minutes !== null &&
    isWithinMorningOpenProtection(currentTime, morning.minutes);
  const afternoonActive =
    !isHalfDay &&
    afternoon.enabled &&
    afternoon.minutes !== null &&
    isWithinAfternoonOpenProtection(currentTime, afternoon.minutes);
  return morningActive || afternoonActive;
}

function buildResolvedGatePolicy(params: {
  readonly runtimeInputs: TradingDayRuntimeInputs;
  readonly runtimeGateMode: GatePolicyResolverDeps['runtimeGateMode'];
  readonly lifecycleState: ResolvedGatePolicy['lifecycleState'];
  readonly isTradingEnabled: boolean;
}): ResolvedGatePolicy {
  const { runtimeInputs, runtimeGateMode, lifecycleState, isTradingEnabled } = params;
  return {
    currentTime: runtimeInputs.currentTime,
    runtimeGateMode,
    dayKey: runtimeInputs.dayKey,
    isTradingDay: runtimeInputs.isTradingDay,
    isHalfDay: runtimeInputs.isHalfDay,
    canTradeNow: runtimeInputs.canTradeNow,
    openProtectionActive: runtimeInputs.openProtectionActive,
    executionGateOpen: isTradingEnabled,
    continuousSessionGateOpen: runtimeInputs.canTradeNow,
    signalGenerationGateOpen:
      isTradingEnabled && runtimeInputs.canTradeNow && !runtimeInputs.openProtectionActive,
    lifecycleState,
  };
}

/**
 * 创建门禁解析器。
 *
 * @param deps 门禁解析依赖
 * @returns GatePolicyResolver
 */
export function createGatePolicyResolver(deps: GatePolicyResolverDeps): GatePolicyResolver {
  const {
    marketDataClient,
    lastState,
    tradingConfig,
    monitorContexts,
    runtimeGateMode,
    logger,
    getHKDateKey,
    isInContinuousHKSession,
    isWithinMorningOpenProtection,
    isWithinAfternoonOpenProtection,
    systemRuntimeStateStore,
  } = deps;

  async function resolveLifecycleInputs(currentTime: Date): Promise<TradingDayRuntimeInputs> {
    const isStrictMode = runtimeGateMode === 'strict';
    const dayKey = getHKDateKey(currentTime);
    let isTradingDay = lastState.cachedTradingDayInfo?.isTradingDay ?? true;
    let isHalfDay = lastState.cachedTradingDayInfo?.isHalfDay ?? false;

    if (!lastState.cachedTradingDayInfo && isStrictMode) {
      try {
        const tradingDayInfo = await marketDataClient.isTradingDay(currentTime);
        isTradingDay = tradingDayInfo.isTradingDay;
        isHalfDay = tradingDayInfo.isHalfDay;
        lastState.cachedTradingDayInfo = tradingDayInfo;

        if (isTradingDay) {
          logger.info(`今天是${isHalfDay ? '半日交易日' : '交易日'}`);
        } else {
          logger.info('今天不是交易日');
        }
      } catch (error) {
        isTradingDay = false;
        isHalfDay = false;
        logger.warn('无法获取交易日信息，进入保护性暂停（按非交易日处理）', formatError(error));
      }
    }

    if (!isStrictMode) {
      return {
        currentTime,
        dayKey,
        isTradingDay,
        isHalfDay,
        canTradeNow: true,
        openProtectionActive: false,
      };
    }

    const canTradeNow = isTradingDay
      ? isInContinuousHKSession(currentTime, isHalfDay)
      : false;
    if (!canTradeNow) {
      return {
        currentTime,
        dayKey,
        isTradingDay,
        isHalfDay,
        canTradeNow,
        openProtectionActive: false,
      };
    }

    const openProtectionActive = resolveOpenProtectionActive({
      currentTime,
      isHalfDay,
      tradingConfig,
      isWithinMorningOpenProtection,
      isWithinAfternoonOpenProtection,
    });
    return {
      currentTime,
      dayKey,
      isTradingDay,
      isHalfDay,
      canTradeNow,
      openProtectionActive,
    };
  }

  function resolveFinalPolicy(params: {
    readonly runtimeInputs: TradingDayRuntimeInputs;
    readonly lifecycleState: ResolvedGatePolicy['lifecycleState'];
    readonly isTradingEnabled: boolean;
  }): ResolvedGatePolicy {
    const { runtimeInputs, lifecycleState, isTradingEnabled } = params;
    const resolvedGatePolicy = buildResolvedGatePolicy({
      runtimeInputs,
      runtimeGateMode,
      lifecycleState,
      isTradingEnabled,
    });

    if (runtimeGateMode === 'strict') {
      if (!resolvedGatePolicy.isTradingDay && lastState.canTrade !== false) {
        logger.info('今天不是交易日，暂停实时监控。');
      }

      if (lastState.canTrade !== resolvedGatePolicy.canTradeNow) {
        if (resolvedGatePolicy.canTradeNow) {
          logger.info(
            `进入连续交易时段${resolvedGatePolicy.isHalfDay ? '（半日交易）' : ''}，开始正常交易。`,
          );
        } else if (resolvedGatePolicy.isTradingDay) {
          logger.info('当前为竞价或非连续交易时段，暂停实时监控。');
          clearPendingDelayedSignals({
            monitorContexts,
            logger,
          });
        }
      }

      const { morning, afternoon } = tradingConfig.global.openProtection;
      const anyProtectionEnabled =
        (morning.enabled && morning.minutes !== null) ||
        (!resolvedGatePolicy.isHalfDay && afternoon.enabled && afternoon.minutes !== null);
      if (
        anyProtectionEnabled &&
        lastState.openProtectionActive !== resolvedGatePolicy.openProtectionActive
      ) {
        if (resolvedGatePolicy.openProtectionActive) {
          const protectionMessage = isWithinMorningOpenProtection(
            runtimeInputs.currentTime,
            morning.minutes ?? 0,
          )
            ? `[开盘保护] 早盘开盘后 ${morning.minutes} 分钟内暂停信号生成`
            : `[开盘保护] 午盘开盘后 ${afternoon.minutes ?? ''} 分钟内暂停信号生成`;
          logger.info(protectionMessage);
        } else if (lastState.openProtectionActive !== null) {
          logger.info('[开盘保护] 保护期结束，恢复信号生成');
        }
      }
    } else if (lastState.canTrade !== true) {
      logger.info('[运行模式] 已跳过交易时段检查');
    }

    lastState.canTrade = resolvedGatePolicy.canTradeNow;
    lastState.isHalfDay = resolvedGatePolicy.isHalfDay;
    lastState.openProtectionActive = resolvedGatePolicy.openProtectionActive;
    systemRuntimeStateStore?.setGatePolicySnapshot(resolvedGatePolicy);
    return resolvedGatePolicy;
  }

  return {
    resolveLifecycleInputs,
    resolveFinalPolicy,
  };
}
