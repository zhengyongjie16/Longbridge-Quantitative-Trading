/**
 * calculateTradingFees 工具测试
 *
 * 覆盖：
 * - 校验交易日志 JSON 边界解析与数值字段校验
 * - 防止费用计算工具接受无效持久化输入
 */
import { describe, expect, it } from 'bun:test';
import { parseTradeNumbers, parseTrades } from '../../../tools/calculateTradingFees/utils.js';

const validTrade = {
  orderId: 'order-1',
  symbol: 'HK.12345',
  action: 'BUY',
  side: 'LONG',
  quantity: '200',
  price: '0.123',
  orderType: 'LO',
  status: 'FILLED',
};

describe('calculateTradingFees utils', () => {
  it('parses valid trade log records from the JSON boundary', () => {
    expect(parseTrades([validTrade])).toEqual([validTrade]);
  });

  it('accepts nullable non-fee fields from persisted trade logs', () => {
    const persistedTrade = {
      ...validTrade,
      symbolName: null,
      monitorSymbol: 'HSI.HK',
      orderType: null,
      error: null,
      reason: null,
      signalTriggerTime: null,
      executedAt: '2026/05/22/10:45:15',
      executedAtMs: 1779417915000,
      timestamp: '2026/05/22/10:45:17',
      isProtectiveClearance: false,
    };

    expect(parseTrades([persistedTrade])).toEqual([persistedTrade]);
  });

  it('fails fast when the trade log root is not an array', () => {
    expect(() => parseTrades({ trade: validTrade })).toThrow('交易日志必须是数组');
  });

  it('fails fast when a trade record is missing required string fields', () => {
    expect(() =>
      parseTrades([
        {
          ...validTrade,
          price: 0.123,
        },
      ]),
    ).toThrow('第 1 条交易记录字段无效：price');
  });

  it('fails fast when optional typed fields have invalid values', () => {
    expect(() =>
      parseTrades([
        {
          ...validTrade,
          orderType: 123,
        },
      ]),
    ).toThrow('第 1 条交易记录字段无效：orderType');
  });

  it('fails fast when quantity or price cannot produce a positive finite amount', () => {
    expect(() =>
      parseTradeNumbers({
        ...validTrade,
        quantity: 'abc',
      }),
    ).toThrow('交易记录 order-1 的 quantity 无效');

    expect(() =>
      parseTradeNumbers({
        ...validTrade,
        price: '0',
      }),
    ).toThrow('交易记录 order-1 的 price 无效');
  });
});
