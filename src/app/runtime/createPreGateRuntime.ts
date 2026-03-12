/**
 * app pre-gate runtime 工厂模块
 *
 * 职责：
 * - 创建启动门禁前必须完成的共享依赖
 * - 执行配置校验、行情客户端创建与 startup gate 等待
 * - 固定 pre-gate 对象所有权边界
 */
import { AUTO_SYMBOL_WARRANT_LIST_CACHE_TTL_MS, TRADING } from '../../constants/index.js';
import { validateAllConfig } from '../../config/config.validator.js';
import { createSdkConfigFromOAuth, initializeOAuth } from '../../config/auth/index.js';
import { createMultiMonitorTradingConfig } from '../../config/config.trading.js';
import { createStartupGate } from '../../main/startup/gate.js';
import { sleep } from '../../main/utils.js';
import { createWarrantListCache } from '../../services/autoSymbolFinder/utils.js';
import { createMarketDataClient } from '../../services/quoteClient/index.js';
import { createSymbolRegistry } from '../../services/autoSymbolManager/utils.js';
import { logger } from '../../utils/logger/index.js';
import {
  getHKDateKey,
  isInContinuousHKSession,
  isWithinAfternoonOpenProtection,
  isWithinMorningOpenProtection,
} from '../../utils/time/index.js';
import { formatError } from '../../utils/error/index.js';
import { createTradingDayInfoResolver } from '../rebuild.js';
import { resolveGatePolicies, resolveRunMode } from '../startupModes.js';
import type { AppEnvironmentParams, PreGateRuntime } from '../types.js';

/**
 * 创建 pre-gate 阶段运行时对象。
 *
 * @param params 当前环境变量
 * @returns 已完成 startup gate 等待的 pre-gate runtime
 */
export async function createPreGateRuntime(params: AppEnvironmentParams): Promise<PreGateRuntime> {
  const { env } = params;
  const tradingConfig = createMultiMonitorTradingConfig({ env });
  const symbolRegistry = createSymbolRegistry(tradingConfig.monitors);
  const warrantListCache = createWarrantListCache();
  const warrantListCacheConfig = {
    cache: warrantListCache,
    ttlMs: AUTO_SYMBOL_WARRANT_LIST_CACHE_TTL_MS,
    nowMs: () => Date.now(),
  };

  await validateAllConfig({ env, tradingConfig });

  const oauth = await initializeOAuth({
    env,
    onOpenUrl: (url: string) => {
      logger.info(`请在浏览器中完成 Longbridge OAuth 授权：${url}`);
    },
  });
  const config = createSdkConfigFromOAuth({ oauth, env });
  const marketDataClient = await createMarketDataClient({ config });
  const runMode = resolveRunMode(env);
  const gatePolicies = resolveGatePolicies(runMode);
  const resolveTradingDayInfo = createTradingDayInfoResolver({
    marketDataClient,
    getHKDateKey,
    onResolveError: (err: unknown) => {
      logger.warn('无法获取交易日信息，按非交易日处理并等待重试', formatError(err));
    },
  });
  const startupGate = createStartupGate({
    now: () => new Date(),
    sleep,
    resolveTradingDayInfo,
    isInSession: isInContinuousHKSession,
    isInMorningOpenProtection: isWithinMorningOpenProtection,
    isInAfternoonOpenProtection: isWithinAfternoonOpenProtection,
    openProtection: tradingConfig.global.openProtection,
    intervalMs: TRADING.INTERVAL_MS,
    logger,
  });
  const startupTradingDayInfo = await startupGate.wait({ mode: gatePolicies.startupGate });

  return {
    config,
    tradingConfig,
    symbolRegistry,
    warrantListCache,
    warrantListCacheConfig,
    marketDataClient,
    runMode,
    gatePolicies,
    startupTradingDayInfo,
    startupGate,
  };
}
