/**
 * meanDeviationAnalysis 纯函数业务测试
 *
 * 覆盖：
 * - 校验命令行参数解析的默认值与自定义值
 * - 校验单日均值偏离统计口径
 * - 校验终端表格渲染包含核心表头与数值
 */
import { describe, expect, it } from 'bun:test';

import {
  computeDailyDeviationMetrics,
  parseAnalysisOptions,
  renderMetricsTable,
} from '../../../tools/meanDeviationAnalysis/utils.js';

describe('meanDeviationAnalysis utils', () => {
  it('parses default days and custom symbol from argv', () => {
    expect(parseAnalysisOptions(['bun', 'meanDeviationAnalysis', '--symbol', '981.HK'])).toEqual({
      symbol: '981.HK',
      days: 20,
    });

    expect(
      parseAnalysisOptions(['bun', 'meanDeviationAnalysis', '--symbol', '700.HK', '--days', '10']),
    ).toEqual({
      symbol: '700.HK',
      days: 10,
    });
  });

  it('fails fast for invalid argv options', () => {
    expect(() => parseAnalysisOptions(['bun', 'meanDeviationAnalysis'])).toThrow(
      '必须通过 --symbol 指定标的',
    );

    expect(() => parseAnalysisOptions(['bun', 'meanDeviationAnalysis', '--symbol', ''])).toThrow(
      '必须通过 --symbol 指定标的',
    );

    expect(() =>
      parseAnalysisOptions(['bun', 'meanDeviationAnalysis', '--symbol', '981.HK', '--days', '0']),
    ).toThrow('--days 必须为正整数，当前值: 0');

    expect(() =>
      parseAnalysisOptions(['bun', 'meanDeviationAnalysis', '--symbol', '981.HK', '--days', 'abc']),
    ).toThrow('--days 必须为正整数，当前值: abc');

    expect(() =>
      parseAnalysisOptions(['bun', 'meanDeviationAnalysis', '--symbol', '981.HK', '--unknown']),
    ).toThrow('不支持的参数: --unknown');
  });

  it('computes each minute deviation from its own cumulative VWAP', () => {
    const metrics = computeDailyDeviationMetrics({
      tradeDate: '2026-06-22',
      minuteCandles: [
        { close: 10, volume: 100, timestamp: new Date('2026-06-22T01:30:00.000Z') },
        { close: 12, volume: 300, timestamp: new Date('2026-06-22T01:31:00.000Z') },
        { close: 9, volume: 100, timestamp: new Date('2026-06-22T01:32:00.000Z') },
      ],
    });

    expect(metrics.tradeDate).toBe('2026-06-22');
    expect(metrics.maxUpDeviation.deviationPct).toBeCloseTo(4.3478, 4);
    expect(metrics.maxUpDeviation.currentPrice).toBe(12);
    expect(metrics.maxUpDeviation.averagePrice).toBe(11.5);
    expect(metrics.maxUpDeviation.klineTime).toBe('09:31');
    expect(metrics.maxDownDeviation.deviationPct).toBeCloseTo(-18.1818, 4);
    expect(metrics.maxDownDeviation.currentPrice).toBe(9);
    expect(metrics.maxDownDeviation.averagePrice).toBe(11);
    expect(metrics.maxDownDeviation.klineTime).toBe('09:32');
    expect(metrics.averageDeviationPct).toBeCloseTo(7.5099, 4);
  });

  it('returns zero deviations for a single minute', () => {
    expect(
      computeDailyDeviationMetrics({
        tradeDate: '2026-06-22',
        minuteCandles: [
          {
            close: 23_579.62,
            volume: 732_511_838,
            timestamp: new Date('2026-06-22T01:30:00.000Z'),
          },
        ],
      }),
    ).toEqual({
      tradeDate: '2026-06-22',
      maxUpDeviation: {
        deviationPct: 0,
        currentPrice: 23_579.62,
        averagePrice: 23_579.62,
        klineTime: '09:30',
      },
      maxDownDeviation: {
        deviationPct: 0,
        currentPrice: 23_579.62,
        averagePrice: 23_579.62,
        klineTime: '09:30',
      },
      averageDeviationPct: 0,
    });
  });

  it('keeps the earliest candle when the same up extreme deviation repeats', () => {
    const metrics = computeDailyDeviationMetrics({
      tradeDate: '2026-06-22',
      minuteCandles: [
        { close: 1, volume: 100, timestamp: new Date('2026-06-22T01:30:00.000Z') },
        { close: 5, volume: 100, timestamp: new Date('2026-06-22T01:31:00.000Z') },
        { close: 7.5, volume: 100, timestamp: new Date('2026-06-22T01:32:00.000Z') },
      ],
    });

    expect(metrics.maxUpDeviation).toEqual({
      deviationPct: 66.66666666666666,
      currentPrice: 5,
      averagePrice: 3,
      klineTime: '09:31',
    });
    expect(metrics.maxDownDeviation.klineTime).toBe('09:30');
  });

  it('keeps the earliest candle when the same down extreme deviation repeats', () => {
    const metrics = computeDailyDeviationMetrics({
      tradeDate: '2026-06-22',
      minuteCandles: [
        { close: 12, volume: 100, timestamp: new Date('2026-06-22T01:30:00.000Z') },
        { close: 4, volume: 100, timestamp: new Date('2026-06-22T01:31:00.000Z') },
        { close: 2, volume: 400, timestamp: new Date('2026-06-22T01:32:00.000Z') },
      ],
    });

    expect(metrics.maxDownDeviation).toEqual({
      deviationPct: -50,
      currentPrice: 4,
      averagePrice: 8,
      klineTime: '09:31',
    });
    expect(metrics.maxUpDeviation.klineTime).toBe('09:30');
  });

  it('fails fast when minute candles are not sorted by time', () => {
    expect(() =>
      computeDailyDeviationMetrics({
        tradeDate: '2026-06-22',
        minuteCandles: [
          { close: 10, volume: 100, timestamp: new Date('2026-06-22T01:31:00.000Z') },
          { close: 11, volume: 100, timestamp: new Date('2026-06-22T01:30:00.000Z') },
        ],
      }),
    ).toThrow('交易日 2026-06-22 分钟 K 线时间必须按升序排列');
  });

  it('fails fast for empty or invalid minute prices', () => {
    expect(() =>
      computeDailyDeviationMetrics({
        tradeDate: '2026-06-22',
        minuteCandles: [],
      }),
    ).toThrow('交易日 2026-06-22 未获得有效分钟数据');

    for (const close of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        computeDailyDeviationMetrics({
          tradeDate: '2026-06-22',
          minuteCandles: [{ close, volume: 100, timestamp: new Date('2026-06-22T01:30:00.000Z') }],
        }),
      ).toThrow('交易日 2026-06-22 包含无效分钟收盘价');
    }

    for (const volume of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        computeDailyDeviationMetrics({
          tradeDate: '2026-06-22',
          minuteCandles: [
            {
              close: 23_579.62,
              volume,
              timestamp: new Date('2026-06-22T01:30:00.000Z'),
            },
          ],
        }),
      ).toThrow('交易日 2026-06-22 包含无效分钟成交量');
    }

    expect(() =>
      computeDailyDeviationMetrics({
        tradeDate: '2026-06-22',
        minuteCandles: [
          {
            close: 23_579.62,
            volume: 100,
            timestamp: new Date(Number.NaN),
          },
        ],
      }),
    ).toThrow('交易日 2026-06-22 包含无效分钟 K 线时间');
  });

  it('renders extreme prices and times without the minute count column', () => {
    const table = renderMetricsTable({
      symbol: '981.HK',
      metrics: [
        {
          tradeDate: '2026-06-22',
          maxUpDeviation: {
            deviationPct: 3.1089,
            currentPrice: 98.25,
            averagePrice: 95.2875,
            klineTime: '10:18',
          },
          maxDownDeviation: {
            deviationPct: -3.1357,
            currentPrice: 91.75,
            averagePrice: 94.7182,
            klineTime: '14:27',
          },
          averageDeviationPct: 1.0411,
        },
      ],
    });

    expect(table).toContain('标的: 981.HK');
    expect(table).toContain('交易日');
    expect(table).toContain('向上最大偏离');
    expect(table).toContain('向上当前价');
    expect(table).toContain('向上均价');
    expect(table).toContain('向上时间');
    expect(table).toContain('向下最大偏离');
    expect(table).toContain('向下当前价');
    expect(table).toContain('向下均价');
    expect(table).toContain('向下时间');
    expect(table).toContain('平均偏离幅度');
    expect(table).toContain('2026-06-22');
    expect(table).toContain('3.1089%');
    expect(table).toContain('98.2500');
    expect(table).toContain('95.2875');
    expect(table).toContain('10:18');
    expect(table).toContain('-3.1357%');
    expect(table).toContain('91.7500');
    expect(table).toContain('94.7182');
    expect(table).toContain('14:27');
    expect(table).toContain('1.0411%');
    expect(table).not.toContain('分钟数');
    expect(table).not.toContain('331');

    const lines = table.split('\n');
    const headerCells = (lines[2] ?? '')
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    const dataCells = (lines[4] ?? '')
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());

    expect(headerCells).toEqual([
      '交易日',
      '向上最大偏离',
      '向上当前价',
      '向上均价',
      '向上时间',
      '向下最大偏离',
      '向下当前价',
      '向下均价',
      '向下时间',
      '平均偏离幅度',
    ]);

    expect(dataCells).toEqual([
      '2026-06-22',
      '3.1089%',
      '98.2500',
      '95.2875',
      '10:18',
      '-3.1357%',
      '91.7500',
      '94.7182',
      '14:27',
      '1.0411%',
    ]);
  });
});
