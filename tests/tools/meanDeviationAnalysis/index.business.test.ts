/**
 * meanDeviationAnalysis 入口业务测试
 *
 * 覆盖：
 * - 校验入口读取命令行参数、完成 OAuth 提示并抓取最近 N 个交易日
 * - 校验入口层输出终端表格而不是提前终止
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const dotenvConfigCalls: unknown[] = [];
const authCalls: Array<{
  readonly env: NodeJS.ProcessEnv;
  readonly onOpenUrl?: (url: string) => void;
}> = [];
const quoteContextNewCalls: unknown[] = [];
const candlestickCalls: Array<ReadonlyArray<unknown>> = [];
const historyCandlestickCalls: Array<ReadonlyArray<unknown>> = [];
const logCalls: string[] = [];
const errorCalls: Array<ReadonlyArray<unknown>> = [];
const processExitCalls: Array<string | number | null | undefined> = [];

const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalProcessExit = process.exit;
const originalArgv = [...process.argv];

function registerDotenvMock(): void {
  void mock.module('dotenv', () => ({
    default: {
      config: (options: unknown) => {
        dotenvConfigCalls.push(options);
      },
    },
  }));
}

async function registerLongbridgeMock(params?: {
  readonly dailyCandles?: ReadonlyArray<{ readonly timestamp: Date }>;
}): Promise<void> {
  const actualLongbridge = await import('longbridge');
  const quoteContext = {
    candlesticks: async (...args: ReadonlyArray<unknown>) => {
      candlestickCalls.push(args);
      return (
        params?.dailyCandles ?? [
          { timestamp: new Date('2026-06-21T16:00:00.000Z') },
          { timestamp: new Date('2026-06-22T16:00:00.000Z') },
        ]
      );
    },
    historyCandlesticksByDate: async (...args: ReadonlyArray<unknown>) => {
      historyCandlestickCalls.push(args);
      const startDate = String(args[4]);
      if (startDate === '2026-06-22') {
        return [
          {
            close: { toNumber: () => 10 },
            volume: 100,
            timestamp: new Date('2026-06-22T01:30:00.000Z'),
          },
          {
            close: { toNumber: () => 11 },
            volume: 200,
            timestamp: new Date('2026-06-22T01:31:00.000Z'),
          },
        ];
      }

      return [
        {
          close: { toNumber: () => 10 },
          volume: 100,
          timestamp: new Date('2026-06-23T01:30:00.000Z'),
        },
        {
          close: { toNumber: () => 9 },
          volume: 200,
          timestamp: new Date('2026-06-23T01:31:00.000Z'),
        },
      ];
    },
  };

  void mock.module('longbridge', () => ({
    ...actualLongbridge,
    AdjustType: {
      NoAdjust: 'NoAdjust',
    },
    Period: {
      Day: 'Day',
      Min_1: 'Min_1',
    },
    QuoteContext: {
      new: (config: unknown) => {
        quoteContextNewCalls.push(config);
        return quoteContext;
      },
    },
    TradeSessions: {
      Intraday: 'Intraday',
    },
  }));
}

function registerAuthMock(): void {
  void mock.module('../../../src/config/auth/index.js', () => ({
    createSdkConfigFromAuth: async (params: {
      readonly env: NodeJS.ProcessEnv;
      readonly onOpenUrl?: (url: string) => void;
    }) => {
      authCalls.push(params);
      params.onOpenUrl?.('https://example.test/oauth');
      return { kind: 'sdk-config' };
    },
  }));
}

async function importToolModule(label: string): Promise<void> {
  await import(
    `../../../tools/meanDeviationAnalysis/index.js?mean-deviation-analysis-index-test-${label}-${Date.now()}`
  );
}

beforeEach(() => {
  dotenvConfigCalls.length = 0;
  authCalls.length = 0;
  quoteContextNewCalls.length = 0;
  candlestickCalls.length = 0;
  historyCandlestickCalls.length = 0;
  logCalls.length = 0;
  errorCalls.length = 0;
  processExitCalls.length = 0;
  console.log = ((...args: ReadonlyArray<unknown>) => {
    logCalls.push(args.map(String).join(' '));
  }) as typeof console.log;

  console.error = ((...args: ReadonlyArray<unknown>) => {
    errorCalls.push(args);
  }) as typeof console.error;

  process.exit = (code?: string | number | null) => {
    processExitCalls.push(code);
    throw new Error(`process.exit:${String(code)}`);
  };
  process.argv = ['bun', 'meanDeviationAnalysis', '--symbol', '981.HK', '--days', '2'];
});

afterEach(() => {
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
  process.exit = originalProcessExit;
  process.argv = [...originalArgv];
  if (typeof mock.restore === 'function') {
    mock.restore();
  }
});

describe('meanDeviationAnalysis index entry flow', () => {
  it('uses argv options, loads recent trading days, and prints the metrics table', async () => {
    registerDotenvMock();
    await registerLongbridgeMock();
    registerAuthMock();

    await importToolModule('success');

    expect(dotenvConfigCalls).toEqual([{ path: '.env.local' }]);
    expect(authCalls).toHaveLength(1);
    expect(authCalls[0]?.env).toBe(process.env);
    expect(quoteContextNewCalls).toEqual([{ kind: 'sdk-config' }]);
    expect(candlestickCalls).toEqual([['981.HK', 'Day', 2, 'NoAdjust', 'Intraday']]);
    expect(historyCandlestickCalls.map((args) => args.map(String))).toEqual([
      ['981.HK', 'Min_1', 'NoAdjust', '2026-06-22', '2026-06-22', 'Intraday'],
      ['981.HK', 'Min_1', 'NoAdjust', '2026-06-23', '2026-06-23', 'Intraday'],
    ]);

    expect(logCalls).toEqual(
      expect.arrayContaining([
        '开始分析标的: 981.HK',
        '最近交易日数量: 2',
        '请在浏览器中完成 Longbridge OAuth 授权：https://example.test/oauth',
      ]),
    );
    expect(logCalls.some((line) => line.includes('向上最大偏离'))).toBeTrue();
    expect(
      logCalls.some(
        (line) =>
          line.includes('2026-06-22') &&
          line.includes('3.1250%') &&
          line.includes('11.0000') &&
          line.includes('10.6667') &&
          line.includes('09:31') &&
          line.includes('0.0000%') &&
          line.includes('10.0000') &&
          line.includes('09:30') &&
          line.includes('1.5625%'),
      ),
    ).toBeTrue();

    expect(
      logCalls.some(
        (line) =>
          line.includes('2026-06-23') &&
          line.includes('0.0000%') &&
          line.includes('10.0000') &&
          line.includes('09:30') &&
          line.includes('-3.5714%') &&
          line.includes('9.0000') &&
          line.includes('9.3333') &&
          line.includes('09:31') &&
          line.includes('1.7857%'),
      ),
    ).toBeTrue();
    expect(logCalls.some((line) => line.includes('向上当前价'))).toBeTrue();
    expect(logCalls.some((line) => line.includes('向下均价'))).toBeTrue();
    expect(logCalls.some((line) => line.includes('分钟数'))).toBeFalse();
    expect(errorCalls).toHaveLength(0);
    expect(processExitCalls).toHaveLength(0);
  });

  it('fails fast when no recent trading days are returned', async () => {
    registerDotenvMock();
    await registerLongbridgeMock({ dailyCandles: [] });
    registerAuthMock();

    let importError: unknown = null;
    try {
      await importToolModule('empty-trading-days');
    } catch (error: unknown) {
      importError = error;
    }

    expect(importError).toBeInstanceOf(Error);
    if (!(importError instanceof Error)) {
      throw new Error('预期入口导入失败');
    }

    expect(importError.message).toBe('process.exit:1');

    expect(historyCandlestickCalls).toHaveLength(0);
    expect(errorCalls).toHaveLength(1);
    expect(String(errorCalls[0]?.[1])).toContain('标的 981.HK 未获得最近交易日数据');
    expect(processExitCalls).toEqual([1]);
  });
});
