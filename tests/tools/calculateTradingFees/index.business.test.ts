/**
 * calculateTradingFees 入口业务测试
 *
 * 覆盖：
 * - 校验工具读取默认交易日志路径并输出费用明细与汇总
 * - 防止入口层在读取持久化交易日志后跳过主输出流程
 */
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const readFileCalls: Array<ReadonlyArray<unknown>> = [];
const logCalls: string[] = [];

const originalConsoleLog = console.log;

function registerReadFileMock(fileContents: string): void {
  void mock.module('node:fs', () => ({
    readFileSync: (...args: ReadonlyArray<unknown>) => {
      readFileCalls.push(args);
      return fileContents;
    },
  }));
}

async function importToolModule(label: string): Promise<void> {
  await import(
    `../../../tools/calculateTradingFees/index.js?calculate-trading-fees-index-test-${label}-${Date.now()}`
  );
}

beforeEach(() => {
  readFileCalls.length = 0;
  logCalls.length = 0;
  console.log = ((...args: ReadonlyArray<unknown>) => {
    logCalls.push(args.map(String).join(' '));
  }) as typeof console.log;
});

afterEach(() => {
  console.log = originalConsoleLog;
  if (typeof mock.restore === 'function') {
    mock.restore();
  }
});

describe('calculateTradingFees index entry flow', () => {
  it('reads the default trade log file and prints fee details plus summary', async () => {
    registerReadFileMock(
      JSON.stringify([
        {
          orderId: 'order-1234567890',
          symbol: 'HK.12345',
          action: 'BUY',
          side: 'LONG',
          quantity: '200',
          price: '0.123',
          orderType: 'LO',
          status: 'FILLED',
        },
      ]),
    );

    await importToolModule('success');

    expect(readFileCalls).toEqual([
      [path.join(process.cwd(), 'logs', 'trades', '2026-01-21.json'), 'utf8'],
    ]);
    expect(logCalls.some((line) => line.includes('总订单数：1'))).toBeTrue();
    expect(
      logCalls.some((line) => line.includes('订单ID | 标的 | 数量 | 价格 | 交易金额')),
    ).toBeTrue();
    expect(logCalls.some((line) => line.includes('order-1234...'))).toBeTrue();
    expect(logCalls.some((line) => line.includes('总费用：'))).toBeTrue();
  });
});
