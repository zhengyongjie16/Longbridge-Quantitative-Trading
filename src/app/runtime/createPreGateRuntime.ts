/**
 * app pre-gate runtime 工厂模块
 *
 * 职责：
 * - 创建 app 启动阶段必须完成的共享依赖
 * - 执行配置校验、行情客户端创建与启动交易日状态初始化
 * - 固定 pre-gate 对象所有权边界
 */
import { AUTO_SYMBOL_WARRANT_LIST_CACHE_TTL_MS } from '../../constants/index.js';
import { validateAllConfig } from '../../config/validator/index.js';
import { createSdkConfigFromAuth } from '../../config/auth/index.js';
import { createMultiMonitorTradingConfig } from '../../config/trading/index.js';
import { createWarrantListCache } from '../../services/autoSymbolFinder/utils.js';
import { createMarketDataClient } from '../../services/quoteClient/index.js';
import { createSymbolRegistry } from '../../services/autoSymbolManager/utils.js';
import { logger } from '../../utils/logger/index.js';
import { getHKDateKey, getRequiredHKDateKey } from '../../utils/time/index.js';
import { formatError } from '../../utils/error/index.js';
import { isExternalApiRequestError } from '../../utils/apiFailure/index.js';
import { createTradingDayInfoResolver } from '../lifecycle/rebuild.js';
import type { CreatePreGateRuntimeDeps } from './types.js';
import type { AppEnvironmentParams, PreGateRuntime } from '../types.js';

const DEFAULT_CREATE_PRE_GATE_RUNTIME_DEPS: CreatePreGateRuntimeDeps = {
  createSdkConfigFromAuth,
  createMarketDataClient,
};

/**
 * 创建 pre-gate runtime 工厂。
 *
 * @param deps pre-gate 创建链路中的可注入依赖
 * @returns pre-gate runtime 创建函数
 */
export function createPreGateRuntimeFactory(
  deps: CreatePreGateRuntimeDeps,
): (params: AppEnvironmentParams) => Promise<PreGateRuntime> {
  const {
    createSdkConfigFromAuth: buildSdkConfigFromAuth,
    createMarketDataClient: buildMarketDataClient,
  } = deps;

  return async function createPreGateRuntime(
    params: AppEnvironmentParams,
  ): Promise<PreGateRuntime> {
    const { env } = params;
    const tradingConfig = createMultiMonitorTradingConfig({ env });
    await validateAllConfig({ env, tradingConfig });

    const symbolRegistry = createSymbolRegistry(tradingConfig.monitors);
    const warrantListCache = createWarrantListCache();
    const warrantListCacheConfig = {
      cache: warrantListCache,
      ttlMs: AUTO_SYMBOL_WARRANT_LIST_CACHE_TTL_MS,
      nowMs: () => Date.now(),
    };

    const config = await buildSdkConfigFromAuth({
      env,
      onOpenUrl: (url: string) => {
        logger.info(`请在浏览器中完成 Longbridge OAuth 授权：${url}`);
      },
    });
    const marketDataClient = await buildMarketDataClient({ config });
    const resolveTradingDayInfo = createTradingDayInfoResolver({
      marketDataClient,
      getHKDateKey,
      onResolveError: (err: unknown) => {
        logger.warn('启动交易日信息解析失败，运行期将继续解析', formatError(err));
      },
    });
    const startupTime = new Date();
    const startupDateKey = getRequiredHKDateKey(startupTime);
    let startupTradingDayInfo: PreGateRuntime['startupTradingDayInfo'];
    try {
      startupTradingDayInfo = {
        dateKey: startupDateKey,
        info: await resolveTradingDayInfo(startupTime),
      };
    } catch (error) {
      if (!isExternalApiRequestError(error)) {
        throw error;
      }

      startupTradingDayInfo = null;
    }

    return {
      config,
      tradingConfig,
      symbolRegistry,
      warrantListCache,
      warrantListCacheConfig,
      marketDataClient,
      startupTradingDayInfo,
    };
  };
}

export const createPreGateRuntime = createPreGateRuntimeFactory(
  DEFAULT_CREATE_PRE_GATE_RUNTIME_DEPS,
);
