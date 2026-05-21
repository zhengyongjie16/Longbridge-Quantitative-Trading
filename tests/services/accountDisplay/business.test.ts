/**
 * accountDisplay 业务测试
 *
 * 覆盖：账户概览与持仓展示日志格式。
 */
import { describe, expect, it, mock } from 'bun:test';

const infoLogs: string[] = [];

mock.module('../../../src/utils/logger/index.js', () => ({
  logger: {
    debug: () => {},
    info: (message: string) => {
      infoLogs.push(message);
    },
    warn: () => {},
    error: () => {},
  },
}));

import { displayAccountAndPositions } from '../../../src/services/accountDisplay/index.js';
import type { DisplayAccountAndPositionsParams } from '../../../src/services/accountDisplay/types.js';
import type { LastState } from '../../../src/types/state.js';

const lastState = {
  canTrade: true,
  isHalfDay: false,
  openProtectionActive: false,
  currentDayKey: null,
  lifecycleState: 'ACTIVE',
  pendingOpenRebuild: false,
  targetTradingDayKey: null,
  isTradingEnabled: true,
  cachedAccount: {
    currency: 'HKD',
    totalCash: 1234.5,
    netAssets: 2344.5,
    positionValue: 1111.1,
    cashInfos: [],
    buyPower: 9999,
  },
  cachedPositions: [
    {
      symbol: '700.HK',
      symbolName: 'Tencent',
      accountChannel: 'live',
      quantity: 100,
      availableQuantity: 80,
      currency: 'HKD',
      costPrice: 12.34,
      market: 'HK',
    },
  ],
  positionCache: {
    update: () => {},
    get: () => null,
  },
  cachedTradingDayInfo: null,
  monitorStates: new Map(),
  allTradingSymbols: new Set<string>(),
} satisfies LastState;

describe('accountDisplay business flow', () => {
  it('formats account channel and numeric fields in display output', () => {
    infoLogs.length = 0;
    const params = {
      lastState,
      quotesMap: new Map([
        [
          '700.HK',
          {
            symbol: '700.HK',
            name: 'Tencent',
            price: 40.125,
            prevClose: 39.5,
            timestamp: Date.now(),
          },
        ],
      ]),
    } satisfies DisplayAccountAndPositionsParams;

    displayAccountAndPositions(params);

    const output = infoLogs.join('\n');

    expect(output).toContain('账户概览 [HKD] 余额=1234.50');
    expect(output).toContain('[实盘交易]');
    expect(output).toContain('Tencent(700.HK)');
    expect(output).toContain('持仓=100.00');
    expect(output).toContain('可用=80.00');
    expect(output).toContain('现价=40.125');
    expect(output).toContain('市值=4012.50');
    expect(output).toContain('仓位=171.15%');
  });
});
