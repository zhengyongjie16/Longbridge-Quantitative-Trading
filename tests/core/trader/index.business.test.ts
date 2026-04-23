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
  tradeContextFactory: { readonly new: () => object },
): Promise<TraderModuleShape['createTrader']> {
  const actualLongbridge = await import('longbridge');

  void mock.module('longbridge', () => ({
    ...actualLongbridge,
    TradeContext: tradeContextFactory,
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
    const createTrader = await loadCreateTraderWithStubbedTradeContext('trader', {
      new(): object {
        return {};
      },
    });

    const trader = await createTrader({
      config: {},
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

  it('createTrader 在 TradeContext.new 同步抛错时保持 rejected promise 语义', async () => {
    const createTrader = await loadCreateTraderWithStubbedTradeContext('trader-sync-throw', {
      new(): object {
        throw new Error('trade context init failed');
      },
    });

    let caught: unknown = null;
    try {
      await createTrader({
        config: {},
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
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('trade context init failed');
  });
});
