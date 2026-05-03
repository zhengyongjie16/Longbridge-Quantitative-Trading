/**
 * createPreGateRuntime 最小启动门禁测试
 *
 * 功能：验证启动阶段只初始化可靠交易日状态，不因非交易日或交易日接口异常阻断 pre-gate runtime 创建。
 */
import { beforeEach, describe, expect, it } from 'bun:test';

import type { AppEnvironmentParams, PreGateRuntime } from '../../../src/app/types.js';
import { createPreGateRuntimeFactory } from '../../../src/app/runtime/createPreGateRuntime.js';
import { createMarketDataClientDouble, createSdkConfigDouble } from '../../helpers/testDoubles.js';

let isTradingDayCalls = 0;
let shouldFailTradingDayResolve = false;

type CreatePreGateRuntimeFunction = (params: AppEnvironmentParams) => Promise<PreGateRuntime>;

function createPreGateRuntimeForTest(): CreatePreGateRuntimeFunction {
  return createPreGateRuntimeFactory({
    createSdkConfigFromAuth: async () => createSdkConfigDouble(),
    createMarketDataClient: async () =>
      createMarketDataClientDouble({
        isTradingDay: async () => {
          isTradingDayCalls += 1;
          if (shouldFailTradingDayResolve) {
            throw new Error('trading day service unavailable');
          }

          return { isTradingDay: false, isHalfDay: false };
        },
      }),
  });
}

describe('app createPreGateRuntime minimal startup gate', () => {
  beforeEach(() => {
    isTradingDayCalls = 0;
    shouldFailTradingDayResolve = false;
  });

  it('returns pre-gate runtime even when current day is not a trading day', async () => {
    const createPreGateRuntime = createPreGateRuntimeForTest();
    const runtime = await createPreGateRuntime({
      env: {
        MONITOR_SYMBOL_1: 'HSI.HK',
        LONG_SYMBOL_1: 'BULL.HK',
        SHORT_SYMBOL_1: 'BEAR.HK',
        ORDER_OWNERSHIP_MAPPING_1: 'HSI',
        SIGNAL_BUYCALL_1: '(RSI:6<25,MFI<20,D<25,J<0)/3|(J<-20)',
        SIGNAL_SELLCALL_1: '(RSI:6>75,MFI>80,D>75,J>100)/3|(J>110)',
        SIGNAL_BUYPUT_1: '(RSI:6>75,MFI>80,D>75,J>100)/3|(J>120)',
        SIGNAL_SELLPUT_1: '(RSI:6<25,MFI<20,D<25,J<0)/3|(J<-15)',
        LONGBRIDGE_AUTH_MODE: 'apikey',
        LONGBRIDGE_APP_KEY: 'app-key',
        LONGBRIDGE_APP_SECRET: 'app-secret',
        LONGBRIDGE_ACCESS_TOKEN: 'access-token',
      },
    });

    expect(runtime.startupTradingDayInfo?.info).toEqual({
      isTradingDay: false,
      isHalfDay: false,
    });
    expect(runtime.startupTradingDayInfo?.dateKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(isTradingDayCalls).toBe(1);
  });

  it('keeps startup trading day unknown when trading day resolution fails', async () => {
    shouldFailTradingDayResolve = true;
    const createPreGateRuntime = createPreGateRuntimeForTest();
    const runtime = await createPreGateRuntime({
      env: {
        MONITOR_SYMBOL_1: 'HSI.HK',
        LONG_SYMBOL_1: 'BULL.HK',
        SHORT_SYMBOL_1: 'BEAR.HK',
        ORDER_OWNERSHIP_MAPPING_1: 'HSI',
        SIGNAL_BUYCALL_1: '(RSI:6<25,MFI<20,D<25,J<0)/3|(J<-20)',
        SIGNAL_SELLCALL_1: '(RSI:6>75,MFI>80,D>75,J>100)/3|(J>110)',
        SIGNAL_BUYPUT_1: '(RSI:6>75,MFI>80,D>75,J>100)/3|(J>120)',
        SIGNAL_SELLPUT_1: '(RSI:6<25,MFI<20,D<25,J<0)/3|(J<-15)',
        LONGBRIDGE_AUTH_MODE: 'apikey',
        LONGBRIDGE_APP_KEY: 'app-key',
        LONGBRIDGE_APP_SECRET: 'app-secret',
        LONGBRIDGE_ACCESS_TOKEN: 'access-token',
      },
    });

    expect(runtime.startupTradingDayInfo).toBeNull();
    expect(isTradingDayCalls).toBe(1);
  });
});
