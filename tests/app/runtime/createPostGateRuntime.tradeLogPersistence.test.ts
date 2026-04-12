/**
 * createPostGateRuntime 交易日志持久化测试
 *
 * 功能：
 * - 验证订单状态事件可落盘为 trade log
 * - 验证落盘结构可被 tradeLogHydrator 读取并恢复冷却边界
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { TRADING } from '../../../src/constants/index.js';
import { createTradingConfig, createMonitorConfig } from '../../../mock/factories/configFactory.js';
import { createLiquidationCooldownTracker } from '../../../src/services/liquidationCooldown/index.js';
import { createTradeLogHydrator } from '../../../src/services/liquidationCooldown/tradeLogHydrator.js';
import { buildTradeLogPath } from '../../../src/utils/trading/tradeLogPath.js';
import { persistTradeRecordFromOrderStateChangedEvent } from '../../../src/app/runtime/createPostGateRuntime.js';
import type { OrderStateChangedEvent } from '../../../src/types/services.js';

const TEST_LOG_ROOT_DIR = path.join(process.cwd(), 'tests', 'logs', 'post-gate-runtime');

function createTestEnv(): NodeJS.ProcessEnv {
  return {
    APP_RUNTIME_PROFILE: 'test',
    APP_LOG_ROOT_DIR: TEST_LOG_ROOT_DIR,
  };
}

describe('createPostGateRuntime trade log persistence', () => {
  beforeEach(() => {
    fs.rmSync(TEST_LOG_ROOT_DIR, { recursive: true, force: true });
  });

  it('persists FILLED buy order state event into daily trade log', () => {
    const executedTimeMs = Date.parse('2026-03-13T09:35:00+08:00');
    const event: OrderStateChangedEvent = {
      orderId: 'BUY-001',
      symbol: 'BULL.HK',
      side: 'BUY',
      source: 'WS',
      status: 'FILLED',
      monitorSymbol: 'HSI.HK',
      isLongSymbol: true,
      isProtectiveLiquidation: false,
      executedPrice: 1.23,
      executedQuantity: 100,
      executedTimeMs,
    };

    persistTradeRecordFromOrderStateChangedEvent({
      env: createTestEnv(),
      event,
    });

    const logFile = buildTradeLogPath(TEST_LOG_ROOT_DIR, new Date(executedTimeMs));
    expect(fs.existsSync(logFile)).toBe(true);

    const records = JSON.parse(fs.readFileSync(logFile, 'utf8')) as ReadonlyArray<{
      readonly action: string | null;
      readonly side: string | null;
      readonly status: string | null;
      readonly reason: string | null;
      readonly executedAtMs: number | null;
      readonly isProtectiveClearance: boolean | null;
    }>;

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      action: 'BUYCALL',
      side: 'BUY',
      status: 'FILLED',
      reason: null,
      executedAtMs: executedTimeMs,
      isProtectiveClearance: false,
    });
  });

  it('writes protective liquidation completion records compatible with tradeLogHydrator', () => {
    const executedTimeMs = Date.parse('2026-03-13T10:00:00+08:00');
    const event: OrderStateChangedEvent = {
      orderId: 'PL-001',
      symbol: 'BULL.HK',
      side: 'SELL',
      source: 'WS',
      status: 'FILLED',
      monitorSymbol: 'HSI.HK',
      isLongSymbol: true,
      isProtectiveLiquidation: true,
      executedPrice: 1.01,
      executedQuantity: 200,
      executedTimeMs,
    };

    persistTradeRecordFromOrderStateChangedEvent({
      env: createTestEnv(),
      event,
    });

    const tradingConfig = createTradingConfig({
      monitors: [
        createMonitorConfig({
          monitorSymbol: 'HSI.HK',
          liquidationTriggerLimit: 1,
          liquidationCooldown: {
            mode: 'minutes',
            minutes: 5,
          },
        }),
      ],
    });
    const tracker = createLiquidationCooldownTracker({
      nowMs: () => executedTimeMs + 60_000,
    });
    const hydrator = createTradeLogHydrator({
      readFileSync: fs.readFileSync,
      existsSync: fs.existsSync,
      resolveLogRootDir: () => TEST_LOG_ROOT_DIR,
      nowMs: () => executedTimeMs + 60_000,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      tradingConfig,
      liquidationCooldownTracker: tracker,
    });

    const boundaries = hydrator.hydrate();

    expect(boundaries.get('HSI.HK:LONG')).toBe(executedTimeMs);
    expect(
      tracker.getRemainingMs({
        symbol: 'HSI.HK',
        direction: 'LONG',
        cooldownConfig: {
          mode: 'minutes',
          minutes: 5,
        },
        currentTimeMs: executedTimeMs + 60_000,
      }),
    ).toBe(240_000);

    const logFile = buildTradeLogPath(TEST_LOG_ROOT_DIR, new Date(executedTimeMs));
    const records = JSON.parse(fs.readFileSync(logFile, 'utf8')) as ReadonlyArray<{
      readonly reason: string | null;
      readonly action: string | null;
    }>;
    expect(records[0]).toMatchObject({
      reason: TRADING.PROTECTIVE_LIQUIDATION_COMPLETED_REASON,
      action: 'SELLCALL',
    });
  });
});
