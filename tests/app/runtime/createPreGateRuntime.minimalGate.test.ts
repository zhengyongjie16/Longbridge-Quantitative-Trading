/**
 * createPreGateRuntime 最小启动门禁测试
 *
 * 功能：验证启动阶段只初始化可靠交易日状态，不因非交易日或交易日接口异常阻断 pre-gate runtime 创建。
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import type { AppEnvironmentParams, PreGateRuntime } from '../../../src/app/types.js';

let createPreGateRuntimeImportIndex = 0;
let isTradingDayCalls = 0;
let shouldFailTradingDayResolve = false;

type CreatePreGateRuntimeFunction = (params: AppEnvironmentParams) => Promise<PreGateRuntime>;

type CreatePreGateRuntimeModuleShape = {
  readonly createPreGateRuntime: CreatePreGateRuntimeFunction;
};

function installPreGateRuntimeMocks(): void {
  void mock.module('../../../src/config/validator/index.js', () => ({
    validateAllConfig: async () => {},
  }));

  void mock.module('../../../src/config/auth/index.js', () => ({
    createSdkConfigFromAuth: async () => ({}),
  }));

  void mock.module('../../../src/services/quoteClient/index.js', () => ({
    createMarketDataClient: async () => ({
      isTradingDay: async () => {
        isTradingDayCalls += 1;
        if (shouldFailTradingDayResolve) {
          throw new Error('trading day service unavailable');
        }

        return { isTradingDay: false, isHalfDay: false };
      },
    }),
  }));
}

async function loadCreatePreGateRuntime(): Promise<CreatePreGateRuntimeFunction> {
  createPreGateRuntimeImportIndex += 1;
  installPreGateRuntimeMocks();
  const loadedModule = (await import(
    `../../../src/app/runtime/createPreGateRuntime.js?minimal-gate-test=${createPreGateRuntimeImportIndex}`
  )) as CreatePreGateRuntimeModuleShape;
  return loadedModule.createPreGateRuntime;
}

describe('app createPreGateRuntime minimal startup gate', () => {
  beforeEach(() => {
    isTradingDayCalls = 0;
    shouldFailTradingDayResolve = false;
  });

  afterEach(() => {
    if (typeof mock.restore === 'function') {
      mock.restore();
    }
  });

  it('returns pre-gate runtime even when current day is not a trading day', async () => {
    const createPreGateRuntime = await loadCreatePreGateRuntime();
    const runtime = await createPreGateRuntime({
      env: { MONITOR_SYMBOL_1: 'HSI.HK', LONG_SYMBOL_1: 'BULL.HK', SHORT_SYMBOL_1: 'BEAR.HK' },
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
    const createPreGateRuntime = await loadCreatePreGateRuntime();
    const runtime = await createPreGateRuntime({
      env: { MONITOR_SYMBOL_1: 'HSI.HK', LONG_SYMBOL_1: 'BULL.HK', SHORT_SYMBOL_1: 'BEAR.HK' },
    });

    expect(runtime.startupTradingDayInfo).toBeNull();
    expect(isTradingDayCalls).toBe(1);
  });
});
