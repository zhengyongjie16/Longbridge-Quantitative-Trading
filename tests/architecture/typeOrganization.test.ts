/**
 * 类型组织架构测试
 *
 * 覆盖：
 * - 本次专项治理的硬违规文件不再在实现文件中声明命名类型
 * - strategy 契约类型整合到 core/strategy/types.ts
 * - 本次触达的 types.ts 保持纯类型文件
 * - 已确认的内部符号不再作为公共 surface 导出
 */
import path from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'bun:test';

const projectRoot = process.cwd();

async function readProjectFile(relativePath: string): Promise<string> {
  return readFile(path.join(projectRoot, relativePath), 'utf8');
}

async function exists(relativePath: string): Promise<boolean> {
  try {
    await access(path.join(projectRoot, relativePath), fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function getRelevantLines(source: string): string[] {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !line.startsWith('/*') &&
        !line.startsWith('*/') &&
        !line.startsWith('*') &&
        !line.startsWith('//'),
    );
}

function expectNoNamedExport(source: string, symbolName: string): void {
  expect(source).not.toMatch(
    new RegExp(String.raw`export\s+(?:type|interface|function)\s+${symbolName}\b`),
  );
  expect(source).not.toMatch(new RegExp(String.raw`export\s*\{[^}]*\b${symbolName}\b[^}]*\}`));
}

describe('type organization regressions', () => {
  it('keeps named type declarations out of the scoped implementation files', async () => {
    const fileChecks: ReadonlyArray<{
      readonly relativePath: string;
      readonly forbiddenPatterns: ReadonlyArray<RegExp>;
    }> = [
      {
        relativePath: 'src/services/quoteClient/candlestickCache.ts',
        forbiddenPatterns: [
          /\btype\s+CandlestickCacheStore\b/,
          /\btype\s+SeedCandlestickSeriesParams\b/,
          /\btype\s+ApplyCandlestickPushParams\b/,
          /\btype\s+NormalizedCandleValue\b/,
        ],
      },
      {
        relativePath: 'src/services/indicators/runtime/index.ts',
        forbiddenPatterns: [/\btype\s+IndicatorRuntimeState\b/],
      },
      {
        relativePath: 'src/main/asyncProgram/monitorTaskProcessor/index.ts',
        forbiddenPatterns: [/\btype\s+RetryRegistryEntry\b/],
      },
      {
        relativePath: 'src/main/asyncProgram/sellProcessor/index.ts',
        forbiddenPatterns: [/\btype\s+SellRetryState\b/],
      },
      {
        relativePath: 'src/main/tradingRiskEventRuntime/tradingRiskEventRuntime.ts',
        forbiddenPatterns: [/\btype\s+RouteExecutionState\b/],
      },
      {
        relativePath: 'src/main/tradingRiskEventRuntime/types.ts',
        forbiddenPatterns: [/\btype\s+TradingRiskQuoteEvent\s*=\s*QuoteUpdatedEvent\b/],
      },
      {
        relativePath: 'tests/integration/main-loop-latency.integration.test.ts',
        forbiddenPatterns: [
          /\btype\s+DelayedApiMethod\b/,
          /\btype\s+ApiCallEvent\b/,
          /\btype\s+IterationMetric\b/,
          /\btype\s+MultiMonitorSeatEntry\b/,
        ],
      },
      {
        relativePath: 'tests/main/asyncProgram/monitorTaskProcessor/business.test.ts',
        forbiddenPatterns: [
          /\btype\s+MonitorTaskQueueForTest\b/,
          /\btype\s+CreateBusinessProcessorParams\b/,
          /\btype\s+CreateTriggeredLongOnlyLiquidationContextParams\b/,
        ],
      },
      {
        relativePath: 'tests/main/asyncProgram/sellProcessor/business.test.ts',
        forbiddenPatterns: [/\btype\s+CapturedSellParams\b/],
      },
      {
        relativePath: 'tests/main/lifecycle/loadTradingDayRuntimeSnapshot.test.ts',
        forbiddenPatterns: [/\btype\s+ProtectiveOrderParams\b/],
      },
      {
        relativePath: 'tests/core/trader/orderMonitor.business.test.ts',
        forbiddenPatterns: [/\btype\s+ReplaceOrderPayload\b/, /\btype\s+RecordLocalSellCall\b/],
      },
      {
        relativePath: 'tests/integration/main-program-strict.integration.test.ts',
        forbiddenPatterns: [/\btype\s+MainProgramFn\b/],
      },
      {
        relativePath: 'tests/integration/multi-monitor-concurrency.integration.test.ts',
        forbiddenPatterns: [/\btype\s+MainProgramFn\b/],
      },
    ];

    for (const fileCheck of fileChecks) {
      const source = await readProjectFile(fileCheck.relativePath);
      for (const forbiddenPattern of fileCheck.forbiddenPatterns) {
        expect(source).not.toMatch(forbiddenPattern);
      }
    }
  });

  it('stores strategy contracts in core/strategy/types.ts and keeps legacy ports path removed', async () => {
    const strategyTypesSource = await readProjectFile('src/core/strategy/types.ts');

    expect(strategyTypesSource).toMatch(/export\s+interface\s+TradingSignalStrategy\b/);
    expect(strategyTypesSource).toMatch(/export\s+type\s+TradingSignalStrategyFactory\b/);
    expect(await exists('src/core/strategy/ports.ts')).toBe(false);
  });

  it('removes stale STATE_CHECK_RETRY state from orderMonitor types', async () => {
    const orderMonitorTypesSource = await readProjectFile('src/core/trader/orderMonitor/types.ts');

    expect(orderMonitorTypesSource).not.toMatch(/STATE_CHECK_RETRY/);
    expect(orderMonitorTypesSource).not.toMatch(/nextStateCheckAt/);
    expect(orderMonitorTypesSource).not.toMatch(/stateCheckRetryCount/);
    expect(orderMonitorTypesSource).not.toMatch(/stateCheckBlockedUntilAt/);
  });

  it('keeps config module internal helpers non-exported', async () => {
    const tradingUtilsSource = await readProjectFile('src/config/trading/utils.ts');
    const validatorUtilsSource = await readProjectFile('src/config/validator/utils.ts');

    expect(tradingUtilsSource).not.toMatch(
      /export\s+function\s+parseFailFastMinimumNumberConfig\b/,
    );

    expect(validatorUtilsSource).not.toMatch(
      /export\s+function\s+validateCriticalMinimumNumberConfig\b/,
    );
  });

  it('keeps orderMonitor production dependencies free of test-only hooks', async () => {
    const sources = [
      await readProjectFile('src/core/trader/types.ts'),
      await readProjectFile('src/core/trader/orderMonitor/index.ts'),
    ];
    const forbiddenPatterns = [/testHooks/, /setHandleOrderChanged/] as const;

    for (const source of sources) {
      for (const forbiddenPattern of forbiddenPatterns) {
        expect(source).not.toMatch(forbiddenPattern);
      }
    }
  });

  it('keeps routingIndex internal state helpers non-exported', async () => {
    const routingIndexSource = await readProjectFile(
      'src/core/trader/orderMonitor/routingIndex.ts',
    );

    expect(routingIndexSource).not.toMatch(/export\s+function\s+ensureRouteState\b/);
  });

  it('keeps concrete strategy implementation factory non-exported', async () => {
    const strategySource = await readProjectFile('src/core/strategy/index.ts');

    expect(strategySource).not.toMatch(
      /export\s+function\s+createHangSengMultiIndicatorStrategy\b/,
    );
  });

  it('keeps scoped types.ts files free of runtime declarations', async () => {
    const scopedTypeFiles = [
      'src/core/strategy/types.ts',
      'src/services/quoteClient/types.ts',
      'src/services/indicators/runtime/types.ts',
      'src/main/asyncProgram/monitorTaskProcessor/types.ts',
      'src/main/asyncProgram/sellProcessor/types.ts',
      'src/main/tradingRiskEventRuntime/types.ts',
      'tests/integration/types.ts',
      'tests/main/asyncProgram/types.ts',
      'tests/main/lifecycle/types.ts',
      'tests/core/trader/types.ts',
    ] as const;

    for (const relativePath of scopedTypeFiles) {
      const relevantLines = getRelevantLines(await readProjectFile(relativePath));
      expect(
        relevantLines.some(
          (line) => line.startsWith('import ') && !line.startsWith('import type '),
        ),
      ).toBe(false);

      expect(
        relevantLines.some(
          (line) =>
            line.startsWith('const ') ||
            line.startsWith('function ') ||
            line.startsWith('class ') ||
            line.startsWith('enum ') ||
            line.startsWith('export const ') ||
            line.startsWith('export function ') ||
            line.startsWith('export class ') ||
            line.startsWith('export enum '),
        ),
      ).toBe(false);
    }
  });

  it('keeps shared constants and service ports free of confirmed dead public surface', async () => {
    const constantsSource = await readProjectFile('src/constants/index.ts');
    const servicesTypesSource = await readProjectFile('src/types/services.ts');

    expect(constantsSource).not.toMatch(/CALCULATION_TTL_MS/);
    expect(constantsSource).not.toMatch(/CALCULATION_MAX_SIZE/);
    expectNoNamedExport(servicesTypesSource, 'MarketWarrantListItem');
    expectNoNamedExport(servicesTypesSource, 'MarketWarrantListRequest');
    expectNoNamedExport(servicesTypesSource, 'MarketWarrantQuote');
    expectNoNamedExport(servicesTypesSource, 'OrderRecorderPendingSellAndSellable');
  });

  it('keeps shared foundational helper types private when only nested consumers need them', async () => {
    const dataTypesSource = await readProjectFile('src/types/data.ts');
    const quoteTypesSource = await readProjectFile('src/types/quote.ts');

    expect(await exists('src/types/common.ts')).toBe(false);
    expectNoNamedExport(dataTypesSource, 'CandleValue');
    expectNoNamedExport(quoteTypesSource, 'QuoteStaticInfo');
  });

  it('keeps unused startup and runtime gate parsing removed from production surface', async () => {
    const seatTypesSource = await readProjectFile('src/types/seat.ts');

    expect(await exists('src/app/startup/startupModes.ts')).toBe(false);
    expectNoNamedExport(seatTypesSource, 'RunMode');
    expectNoNamedExport(seatTypesSource, 'GateMode');
  });

  it('keeps non-app modules free of confirmed dead public surface', async () => {
    const indicatorRuntimeUtilsSource = await readProjectFile(
      'src/services/indicators/runtime/utils.ts',
    );
    const dailyKlineRuntimeSnapshotSource = await readProjectFile(
      'tools/dailyKlineMonitor/runtimeSnapshot.ts',
    );
    const monitorQuoteTypesSource = await readProjectFile(
      'src/main/monitorQuoteEventRuntime/types.ts',
    );
    const tradingRiskTypesSource = await readProjectFile(
      'src/main/tradingRiskEventRuntime/types.ts',
    );
    const signalRuntimeDomainTypesSource = await readProjectFile(
      'src/main/lifecycle/cacheDomains/types.ts',
    );
    const orderMonitorTypesSource = await readProjectFile('src/core/trader/orderMonitor/types.ts');
    const monitorTaskProcessorTypesSource = await readProjectFile(
      'src/main/asyncProgram/monitorTaskProcessor/types.ts',
    );

    expect(indicatorRuntimeUtilsSource).not.toMatch(/export\s+function\s+logDebug\b/);
    expect(await exists('src/utils/objectPool/index.ts')).toBe(false);
    expect(await exists('src/utils/objectPool/types.ts')).toBe(false);
    expect(dailyKlineRuntimeSnapshotSource).not.toMatch(/utils\/objectPool\/index\.js/);
    expect(monitorQuoteTypesSource).not.toMatch(/export\s+type\s+MonitorQuoteFreshnessStatus\b/);
    expect(monitorQuoteTypesSource).not.toMatch(/export\s+interface\s+SwitchWakeupFreshnessDeps\b/);
    expect(tradingRiskTypesSource).not.toMatch(/export\s+interface\s+TradingRiskConsistencyPort\b/);
    expect(signalRuntimeDomainTypesSource).not.toMatch(
      /export\s+interface\s+SignalRuntimePostTradeConsistencyRuntime\b/,
    );
    expect(orderMonitorTypesSource).not.toMatch(/export\s+type\s+OrderMonitorTimerRegistration\b/);
    expect(orderMonitorTypesSource).not.toMatch(/export\s+type\s+PendingSellDisposition\b/);
    expect(monitorTaskProcessorTypesSource).not.toMatch(
      /export\s+interface\s+MonitorTaskProcessor[\s\S]*?readonly\s+stop:/,
    );
  });
});
