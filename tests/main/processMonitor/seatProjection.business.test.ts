/**
 * seatProjection 业务测试
 *
 * 功能：
 * - 验证普通信号链路席位投影只读取 SymbolRegistry，不清理运行态。
 */
import { describe, expect, it } from 'bun:test';
import { resolveSignalSeatInfo } from '../../../src/main/processMonitor/seatProjection.js';
import { createBuyTaskQueue } from '../../../src/main/asyncProgram/tradeTaskQueue/index.js';
import type { MonitorContext } from '../../../src/types/state.js';
import {
  createDelayedSignalVerifierDouble,
  createRiskCheckerDouble,
  createSignalDouble,
  createSymbolRegistryDouble,
} from '../../helpers/testDoubles.js';

describe('seatProjection business flow', () => {
  it('投影最新席位身份但不清理旧方向运行态', () => {
    const monitorSymbol = 'HSI.HK';
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol,
      longSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        callPrice: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: 'BEAR.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        callPrice: 19_000,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 3,
      shortVersion: 4,
    });
    let clearLongCalls = 0;
    let delayedCancelCalls = 0;
    const buyTaskQueue = createBuyTaskQueue();
    buyTaskQueue.push({
      type: 'IMMEDIATE_BUY',
      monitorSymbol,
      data: createSignalDouble('BUYCALL', 'BULL.HK'),
    });

    const monitorContext = {
      riskChecker: createRiskCheckerDouble({
        clearLongWarrantInfo: () => {
          clearLongCalls += 1;
        },
      }),
      delayedSignalVerifier: createDelayedSignalVerifierDouble({
        cancelAllForDirection: () => {
          delayedCancelCalls += 1;
          return 1;
        },
      }),
      symbolRegistry,
      seatState: {
        long: {
          symbol: 'BULL.HK',
          status: 'ACTIVE',
          lastSwitchAt: null,
          lastSearchAt: null,
          lastSeatActivatedAt: null,
          callPrice: 20_000,
          searchFailCountToday: 0,
          frozenTradingDayKey: null,
        },
        short: symbolRegistry.getSeatState(monitorSymbol, 'SHORT'),
      },
      seatVersion: { long: 1, short: 1 },
    } as unknown as MonitorContext;

    const seatInfo = resolveSignalSeatInfo({
      monitorSymbol,
      monitorContext,
    });

    expect(seatInfo.longSeatState.status).toBe('EMPTY');
    expect(seatInfo.shortSeatState.status).toBe('ACTIVE');
    expect(seatInfo.longSeatVersion).toBe(3);
    expect(seatInfo.shortSeatVersion).toBe(4);
    expect(seatInfo.shortSymbol).toBe('BEAR.HK');
    expect(monitorContext.seatState.long.status).toBe('EMPTY');
    expect(monitorContext.seatVersion.long).toBe(3);
    expect(clearLongCalls).toBe(0);
    expect(delayedCancelCalls).toBe(0);
    expect(buyTaskQueue.pop()?.data.action).toBe('BUYCALL');
  });
});
