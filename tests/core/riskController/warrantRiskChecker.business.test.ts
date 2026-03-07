/**
 * warrantRiskChecker 业务测试
 *
 * 功能：
 * - 验证牛熊证距离阈值、回收价与清算边界的场景意图与业务期望。
 */
import { describe, expect, it } from 'bun:test';
import {
  BEAR_WARRANT_LIQUIDATION_DISTANCE_PERCENT,
  BEAR_WARRANT_MAX_DISTANCE_PERCENT,
  BULL_WARRANT_LIQUIDATION_DISTANCE_PERCENT,
  BULL_WARRANT_MIN_DISTANCE_PERCENT,
  MIN_MONITOR_PRICE_THRESHOLD,
} from '../../../src/constants/index.js';
import { createWarrantRiskChecker } from '../../../src/core/riskController/warrantRiskChecker.js';

describe('warrantRiskChecker business boundaries', () => {
  it('accepts and rejects bull distance exactly at threshold boundaries', () => {
    const checker = createWarrantRiskChecker();
    checker.setWarrantInfoFromCallPrice('BULL.HK', 20000, true, 'BULL.HK');

    const passMonitorPrice = 20000 * (1 + BULL_WARRANT_MIN_DISTANCE_PERCENT / 100);
    const failMonitorPrice = passMonitorPrice - 0.01;

    const pass = checker.checkRisk('BULL.HK', 'BUYCALL', passMonitorPrice);
    const fail = checker.checkRisk('BULL.HK', 'BUYCALL', failMonitorPrice);

    expect(pass.allowed).toBe(true);
    expect(fail.allowed).toBe(false);
    expect(fail.reason).toContain('牛证距离回收价百分比');
  });

  it('accepts and rejects bear distance exactly at threshold boundaries', () => {
    const checker = createWarrantRiskChecker();
    checker.setWarrantInfoFromCallPrice('BEAR.HK', 20000, false, 'BEAR.HK');

    const passMonitorPrice = 20000 * (1 + BEAR_WARRANT_MAX_DISTANCE_PERCENT / 100);
    const failMonitorPrice = passMonitorPrice + 0.01;

    const pass = checker.checkRisk('BEAR.HK', 'BUYPUT', passMonitorPrice);
    const fail = checker.checkRisk('BEAR.HK', 'BUYPUT', failMonitorPrice);

    expect(pass.allowed).toBe(true);
    expect(fail.allowed).toBe(false);
    expect(fail.reason).toContain('熊证距离回收价百分比');
  });

  it('rejects invalid monitor price', () => {
    const checker = createWarrantRiskChecker();
    checker.setWarrantInfoFromCallPrice('BULL.HK', 20000, true, 'BULL.HK');

    const invalidMonitor = checker.checkRisk(
      'BULL.HK',
      'BUYCALL',
      MIN_MONITOR_PRICE_THRESHOLD - 0.01,
    );

    expect(invalidMonitor.allowed).toBe(false);
    expect(invalidMonitor.reason).toContain('监控标的价格异常');
  });

  it('triggers liquidation around bull/bear liquidation thresholds', () => {
    const checker = createWarrantRiskChecker();
    checker.setWarrantInfoFromCallPrice('BULL.HK', 20000, true, 'BULL.HK');
    checker.setWarrantInfoFromCallPrice('BEAR.HK', 20000, false, 'BEAR.HK');

    const bullTriggerPrice = 20000 * (1 + BULL_WARRANT_LIQUIDATION_DISTANCE_PERCENT / 100);
    const bearTriggerPrice = 20000 * (1 + BEAR_WARRANT_LIQUIDATION_DISTANCE_PERCENT / 100);

    const bullResult = checker.checkWarrantDistanceLiquidation('BULL.HK', true, bullTriggerPrice);
    const bearResult = checker.checkWarrantDistanceLiquidation('BEAR.HK', false, bearTriggerPrice);

    expect(bullResult.shouldLiquidate).toBe(true);
    expect(bearResult.shouldLiquidate).toBe(true);
  });

  it('keeps precise distance judgment without pre-rounding prices before threshold comparison', () => {
    const checker = createWarrantRiskChecker();
    checker.setWarrantInfoFromCallPrice('PRECISION-BULL.HK', 100.774702, true, 'PRECISION-BULL.HK');

    const result = checker.checkRisk('PRECISION-BULL.HK', 'BUYCALL', 101.12749074212671);

    expect(result.allowed).toBe(true);
  });
});
