/**
 * dailyIndicatorAnalysis 入口业务测试
 *
 * 覆盖：
 * - 校验工具使用命令行标的、完成 OAuth 打开提示并请求分钟 K 线
 * - 校验当外部行情边界返回空结果时入口层按预期终止输出
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const dotenvConfigCalls: unknown[] = [];
const authCalls: Array<{
  readonly env: NodeJS.ProcessEnv;
  readonly onOpenUrl?: (url: string) => void;
}> = [];
const quoteContextNewCalls: unknown[] = [];
const candlestickCalls: Array<ReadonlyArray<unknown>> = [];
const logCalls: string[] = [];
const errorCalls: Array<ReadonlyArray<unknown>> = [];

const originalConsoleLog = console.log;
const originalConsoleError = console.error;
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

async function registerLongbridgeMock(): Promise<void> {
  const actualLongbridge = await import('longbridge');
  const quoteContext = {
    candlesticks: async (...args: ReadonlyArray<unknown>) => {
      candlestickCalls.push(args);
      return [];
    },
  };

  void mock.module('longbridge', () => ({
    ...actualLongbridge,
    AdjustType: {
      NoAdjust: 'NoAdjust',
    },
    Period: {
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
    `../../../tools/dailyIndicatorAnalysis/index.js?daily-indicator-analysis-index-test-${label}-${Date.now()}`
  );
}

beforeEach(() => {
  dotenvConfigCalls.length = 0;
  authCalls.length = 0;
  quoteContextNewCalls.length = 0;
  candlestickCalls.length = 0;
  logCalls.length = 0;
  errorCalls.length = 0;
  console.log = ((...args: ReadonlyArray<unknown>) => {
    logCalls.push(args.map(String).join(' '));
  }) as typeof console.log;

  console.error = ((...args: ReadonlyArray<unknown>) => {
    errorCalls.push(args);
  }) as typeof console.error;
  process.argv = ['bun', 'dailyIndicatorAnalysis', 'HSCEI.HK'];
});

afterEach(() => {
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
  process.argv = [...originalArgv];
  if (typeof mock.restore === 'function') {
    mock.restore();
  }
});

describe('dailyIndicatorAnalysis index entry flow', () => {
  it('uses the argv symbol, announces OAuth URL, and stops cleanly on empty minute candles', async () => {
    registerDotenvMock();
    await registerLongbridgeMock();
    registerAuthMock();

    await importToolModule('empty-candles');

    expect(dotenvConfigCalls).toEqual([{ path: '.env.local' }]);
    expect(authCalls).toHaveLength(1);
    expect(authCalls[0]?.env).toBe(process.env);
    expect(quoteContextNewCalls).toEqual([{ kind: 'sdk-config' }]);
    expect(candlestickCalls).toEqual([['HSCEI.HK', 'Min_1', 1000, 'NoAdjust', 'Intraday']]);
    expect(logCalls).toEqual(
      expect.arrayContaining([
        '查询标的: HSCEI.HK',
        '正在获取数据...',
        '请在浏览器中完成 Longbridge OAuth 授权：https://example.test/oauth',
        '未获取到分钟 K 线数据',
      ]),
    );
    expect(errorCalls).toHaveLength(0);
  });
});
