/**
 * 风控缓存域（CacheDomain: risk）
 *
 * 午夜清理：
 * - 重置风控检查冷却（signalProcessor.resetRiskCheckCooldown）
 * - 重置日内亏损追踪器（dailyLossTracker.resetAll）
 * - 清除跨日模式的清仓冷却键（保留分钟模式的冷却）
 * - 清空各监控标的的浮亏数据和牛熊证风险信息缓存
 *
 * 开盘重建：
 * - 风控数据在统一 rebuildTradingDayState 中按当日数据重建，此处为空操作
 */
import { logger } from '../../../utils/logger/index.js';
import type { MonitorContext } from '../../../types/state.js';
import { buildCooldownKey } from '../../../services/liquidationCooldown/utils.js';
import type { CacheDomain, LifecycleContext } from '../types.js';
import type { RiskDomainDeps } from './types.js';

function clearRiskCaches(monitorContexts: ReadonlyMap<string, MonitorContext>): number {
  let count = 0;
  for (const monitorContext of monitorContexts.values()) {
    monitorContext.riskChecker.clearUnrealizedLossData();
    monitorContext.riskChecker.clearLongWarrantInfo();
    monitorContext.riskChecker.clearShortWarrantInfo();
    count += 1;
  }
  return count;
}

function collectMidnightEligibleCooldownKeys(
  monitorContexts: ReadonlyMap<string, MonitorContext>,
): Set<string> {
  const keysToClear = new Set<string>();
  for (const monitorContext of monitorContexts.values()) {
    const cfg = monitorContext.config.liquidationCooldown;
    if (!cfg || cfg.mode === 'minutes') {
      continue;
    }
    const monitorSymbol = monitorContext.config.monitorSymbol;
    keysToClear.add(buildCooldownKey(monitorSymbol, 'LONG'));
    keysToClear.add(buildCooldownKey(monitorSymbol, 'SHORT'));
  }
  return keysToClear;
}

function runMidnightRiskClear(
  deps: RiskDomainDeps,
  ctx: LifecycleContext,
): void {
  const {
    signalProcessor,
    dailyLossTracker,
    monitorContexts,
    liquidationCooldownTracker,
  } = deps;

  signalProcessor.resetRiskCheckCooldown();
  dailyLossTracker.resetAll(ctx.now);
  const keysToClear = collectMidnightEligibleCooldownKeys(monitorContexts);
  liquidationCooldownTracker.clearMidnightEligible({ keysToClear });
  const monitorCount = clearRiskCaches(monitorContexts);
  logger.info(`[Lifecycle][risk] 午夜清理完成: monitors=${monitorCount}`);
}

export function createRiskDomain(deps: RiskDomainDeps): CacheDomain {
  return {
    midnightClear(ctx): void {
      runMidnightRiskClear(deps, ctx);
    },
    openRebuild(): void {
      // 风控数据在统一 rebuildTradingDayState 中按当日数据重建
    },
  };
}
