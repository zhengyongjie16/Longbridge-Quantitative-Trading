import { logger } from '../../../utils/logger/index.js';
import type { MonitorContext } from '../../../types/index.js';
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
    name: 'risk',
    midnightClear(ctx): void {
      runMidnightRiskClear(deps, ctx);
    },
    openRebuild(): void {
      // 风控数据在统一 rebuildTradingDayState 中按当日数据重建
    },
  };
}
