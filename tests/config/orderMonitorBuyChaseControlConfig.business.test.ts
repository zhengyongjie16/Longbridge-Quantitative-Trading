/**
 * order monitor 买单追高控制配置测试
 *
 * 功能：
 * - 验证 ALLOW_BUY_ORDER_TRACKING_ABOVE_INITIAL_PRICE 的解析行为。
 */
import { describe, expect, it } from 'bun:test';
import { createMultiMonitorTradingConfig } from '../../src/config/config.trading.js';

function createBaseEnv(overrides: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  return {
    MONITOR_SYMBOL_1: 'HSI.HK',
    ...overrides,
  };
}

describe('order monitor buy chase control config', () => {
  it('parses ALLOW_BUY_ORDER_TRACKING_ABOVE_INITIAL_PRICE with expected defaults', () => {
    const defaultConfig = createMultiMonitorTradingConfig({
      env: createBaseEnv(),
    });
    expect(defaultConfig.global.allowBuyOrderTrackingAboveInitialPrice).toBe(true);

    const enabledConfig = createMultiMonitorTradingConfig({
      env: createBaseEnv({
        ALLOW_BUY_ORDER_TRACKING_ABOVE_INITIAL_PRICE: 'true',
      }),
    });
    expect(enabledConfig.global.allowBuyOrderTrackingAboveInitialPrice).toBe(true);

    const disabledConfig = createMultiMonitorTradingConfig({
      env: createBaseEnv({
        ALLOW_BUY_ORDER_TRACKING_ABOVE_INITIAL_PRICE: 'false',
      }),
    });
    expect(disabledConfig.global.allowBuyOrderTrackingAboveInitialPrice).toBe(false);
  });
});
