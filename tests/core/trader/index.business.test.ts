/**
 * trader 门面业务测试
 *
 * 功能：
 * - 锁定 Trader 门面不再暴露旧轮询入口
 */
import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { StockPositionsResponse } from 'longbridge';
import {
  createAccountBalance,
  createStockPositionsResponse,
} from '../../../mock/factories/tradeFactory.js';
import { createTradeContextMock } from '../../../mock/longbridge/tradeContextMock.js';
import { createAccountService } from '../../../src/core/trader/accountService.js';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';
import type { TraderDeps } from '../../../src/core/trader/types.js';
import type { Trader } from '../../../src/types/services.js';
import {
  createDailyLossTrackerDouble,
  createMarketDataClientDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createSymbolRegistryDouble,
  createTradeContextDouble,
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

function createEmptyStockPositionsResponse(): StockPositionsResponse {
  return {
    channels: [],
    toJSON(): object {
      return {
        channels: [],
      };
    },
  };
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

  it('createTrader 的公开 getAccountSnapshot 在空账户时透传契约失败', async () => {
    const createTrader = await loadCreateTraderWithStubbedTradeContext('trader-empty-account', {
      new(): object {
        return {
          accountBalance: async () => [],
          stockPositions: async () => createEmptyStockPositionsResponse(),
        };
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

    let caught: unknown = null;
    try {
      await trader.getAccountSnapshot();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toContain(
      'TradeContext.accountBalance returned no primary account',
    );
  });

  it('createTrader 的公开 getAccountSnapshot 支持透传 retryConfig 并保持 attempts 为 1', async () => {
    const tradeCtx = createTradeContextMock();
    tradeCtx.seedAccountBalances([createAccountBalance(100000)]);
    tradeCtx.setFailureRule('accountBalance', {
      failAtCalls: [1],
      maxFailures: 1,
      errorMessage: 'temporary account error',
    });
    const createTrader = await loadCreateTraderWithStubbedTradeContext('trader-account-retry', {
      new(): object {
        return createTradeContextDouble(tradeCtx);
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

    let caught: unknown = null;
    try {
      await trader.getAccountSnapshot({
        retryConfig: {
          retries: 0,
          delayMs: 0,
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      name: 'ExternalApiRequestError',
      attempts: 1,
      operation: 'TradeContext.accountBalance',
    });
    expect(tradeCtx.getCalls('accountBalance')).toHaveLength(1);
  });

  it('createTrader 的公开 getStockPositions 支持透传 symbols 与 retryConfig', async () => {
    const tradeCtx = createTradeContextMock();
    tradeCtx.seedStockPositions(
      createStockPositionsResponse({
        symbol: '700.HK',
        quantity: 100,
        availableQuantity: 80,
      }),
    );

    tradeCtx.setFailureRule('stockPositions', {
      failAtCalls: [1],
      maxFailures: 1,
      errorMessage: 'temporary positions error',
    });
    const createTrader = await loadCreateTraderWithStubbedTradeContext('trader-positions-retry', {
      new(): object {
        return createTradeContextDouble(tradeCtx);
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

    let caught: unknown = null;
    try {
      await trader.getStockPositions({
        symbols: ['700.HK'],
        retryConfig: {
          retries: 0,
          delayMs: 0,
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      name: 'ExternalApiRequestError',
      attempts: 1,
      operation: 'TradeContext.stockPositions',
    });
    expect(tradeCtx.getCalls('stockPositions')).toHaveLength(1);
    expect(tradeCtx.getCalls('stockPositions')[0]?.args[0]).toEqual(['700.HK']);
  });
});

describe('account service contract boundary', () => {
  it('getAccountSnapshot 在 accountBalance 返回空数组时拒绝为无账户快照', async () => {
    const tradeCtx = createTradeContextMock();
    tradeCtx.seedAccountBalances([]);

    const accountService = createAccountService({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: {
        throttle: async () => {},
      },
    });

    let caught: unknown = null;
    try {
      await accountService.getAccountSnapshot();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toContain(
      'TradeContext.accountBalance returned no primary account',
    );
  });

  it('getStockPositions 在 stockPositions 返回空 channels 时保留权威空持仓事实', async () => {
    const tradeCtx = createTradeContextMock();
    tradeCtx.seedAccountBalances([createAccountBalance(100000)]);
    tradeCtx.seedStockPositions(createEmptyStockPositionsResponse());

    const accountService = createAccountService({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: {
        throttle: async () => {},
      },
    });

    const positions = await accountService.getStockPositions();
    expect(positions).toEqual([]);
  });

  it('getAccountSnapshot 在显式禁用重试时只尝试一次', async () => {
    const tradeCtx = createTradeContextMock();
    tradeCtx.seedAccountBalances([createAccountBalance(100000)]);
    tradeCtx.setFailureRule('accountBalance', {
      failAtCalls: [1],
      maxFailures: 1,
      errorMessage: 'temporary account error',
    });

    const accountService = createAccountService({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: {
        throttle: async () => {},
      },
    });

    let caught: unknown = null;
    try {
      await accountService.getAccountSnapshot({
        retryConfig: {
          retries: 0,
          delayMs: 0,
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      name: 'ExternalApiRequestError',
      attempts: 1,
      operation: 'TradeContext.accountBalance',
    });
    expect(tradeCtx.getCalls('accountBalance')).toHaveLength(1);
  });

  it('getStockPositions 支持对象参数同时透传 symbols 与 retryConfig', async () => {
    const tradeCtx = createTradeContextMock();
    tradeCtx.seedStockPositions(
      createStockPositionsResponse({
        symbol: '700.HK',
        quantity: 100,
        availableQuantity: 80,
      }),
    );

    tradeCtx.setFailureRule('stockPositions', {
      failAtCalls: [1],
      maxFailures: 1,
      errorMessage: 'temporary positions error',
    });

    const accountService = createAccountService({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: {
        throttle: async () => {},
      },
    });

    let caught: unknown = null;
    try {
      await accountService.getStockPositions({
        symbols: ['700.HK'],
        retryConfig: {
          retries: 0,
          delayMs: 0,
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      name: 'ExternalApiRequestError',
      attempts: 1,
      operation: 'TradeContext.stockPositions',
    });
    expect(tradeCtx.getCalls('stockPositions')).toHaveLength(1);
    expect(tradeCtx.getCalls('stockPositions')[0]?.args[0]).toEqual(['700.HK']);
  });

  it('getAccountSnapshot 在存在主账户时返回快照', async () => {
    const tradeCtx = createTradeContextMock();
    tradeCtx.seedAccountBalances([createAccountBalance(100000)]);
    tradeCtx.seedStockPositions(
      createStockPositionsResponse({
        symbol: '700.HK',
        quantity: 100,
        availableQuantity: 80,
      }),
    );

    const accountService = createAccountService({
      ctx: createTradeContextDouble(tradeCtx),
      rateLimiter: {
        throttle: async () => {},
      },
    });

    const snapshot = await accountService.getAccountSnapshot();
    expect(snapshot).toMatchObject({
      currency: 'HKD',
      totalCash: 100000,
      netAssets: 100000,
      positionValue: 0,
      buyPower: 100000,
    });
  });
});
