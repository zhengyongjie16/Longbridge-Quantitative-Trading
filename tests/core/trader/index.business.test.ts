/**
 * trader 门面业务测试
 *
 * 功能：
 * - 锁定 Trader 门面不再暴露旧轮询入口
 */
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';
import type { TraderDeps } from '../../../src/core/trader/types.js';
import type { Trader } from '../../../src/types/services.js';
import {
  createDailyLossTrackerDouble,
  createMarketDataClientDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createSymbolRegistryDouble,
} from '../../helpers/testDoubles.js';

type TraderModuleShape = {
  readonly createTrader: (deps: TraderDeps) => Promise<Trader>;
};

async function loadCreateTraderWithStubbedTradeContext(
  suffix: string,
): Promise<TraderModuleShape['createTrader']> {
  const actualLongbridge = await import('longbridge');
  const StubTradeContext = {
    new(): Promise<object> {
      return Promise.resolve({});
    },
  };

  void mock.module('longbridge', () => ({
    ...actualLongbridge,
    TradeContext: StubTradeContext,
  }));

  const traderModulePath = `../../../src/core/trader/index.js?legacy-worker-removal-${suffix}`;
  const traderModuleUnknown: unknown = await import(traderModulePath);
  const traderModule = traderModuleUnknown as TraderModuleShape;
  return traderModule.createTrader;
}

afterEach(() => {
  if (typeof mock.restore === 'function') {
    mock.restore();
  }
});

describe('trader facade business flow', () => {
  it('createTrader 不再暴露旧的订单监控轮询入口', async () => {
    const createTrader = await loadCreateTraderWithStubbedTradeContext('trader');

    const trader = await createTrader({
      config: {} as never,
      tradingConfig: createTradingConfig(),
      marketDataClient: createMarketDataClientDouble(),
      symbolRegistry: createSymbolRegistryDouble(),
      dailyLossTracker: createDailyLossTrackerDouble(),
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      postTradeConsistencyRuntime: {
        recordSettlementRefreshNeed: () => {},
      },
      isExecutionAllowed: () => true,
    });

    expect('monitorAndManageOrders' in trader).toBe(false);
  });
});
