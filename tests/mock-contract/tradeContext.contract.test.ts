/**
 * tradeContext 契约测试
 *
 * 功能：
 * - 围绕 tradeContext.contract.test.ts 场景验证 tests/mock-contract 相关业务行为与边界条件。
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderStatus, OrderType, TimeInForceType, TopicType } from 'longport';
import { createTradeContextMock } from '../../mock/longport/tradeContextMock.js';
import { toMockDecimal } from '../../mock/longport/decimal.js';
import {
  createAccountBalance,
  createExecution,
  createOrder,
  createPushOrderChanged,
  createStockPositionsResponse,
} from '../../mock/factories/tradeFactory.js';

describe('TradeContext mock contract', () => {
  it('implements required trade APIs and exposes deterministic state transitions', async () => {
    const tradeCtx = createTradeContextMock();
    tradeCtx.seedTodayOrders([
      createOrder({
        orderId: 'INIT-001',
        symbol: '700.HK',
        side: OrderSide.Buy,
        status: OrderStatus.New,
        orderType: OrderType.ELO,
        quantity: 100,
      }),
    ]);
    tradeCtx.seedHistoryOrders([
      createOrder({
        orderId: 'HIST-001',
        symbol: '700.HK',
        side: OrderSide.Sell,
        status: OrderStatus.Filled,
        orderType: OrderType.ELO,
        quantity: 100,
        executedQuantity: 100,
        executedPrice: 320,
      }),
    ]);
    tradeCtx.seedTodayExecutions([
      createExecution('HIST-001', '700.HK', 100, 320),
    ]);
    tradeCtx.seedAccountBalances([
      createAccountBalance(100000),
    ]);
    tradeCtx.seedStockPositions(
      createStockPositionsResponse({
        symbol: '700.HK',
        quantity: 100,
        availableQuantity: 80,
      }),
    );

    const submitResp = await tradeCtx.submitOrder({
      symbol: '700.HK',
      side: OrderSide.Buy,
      orderType: OrderType.ELO,
      timeInForce: TimeInForceType.Day,
      submittedQuantity: toMockDecimal(100),
      submittedPrice: toMockDecimal(320),
    });

    await tradeCtx.replaceOrder({
      orderId: submitResp.orderId,
      quantity: toMockDecimal(200),
      price: toMockDecimal(319),
    });
    await tradeCtx.cancelOrder(submitResp.orderId);

    const todayOrders = await tradeCtx.todayOrders();
    const historyOrders = await tradeCtx.historyOrders();
    const executions = await tradeCtx.todayExecutions();
    const balances = await tradeCtx.accountBalance('HKD');
    const positions = await tradeCtx.stockPositions(['700.HK']);

    expect(todayOrders.some((order) => order.orderId === submitResp.orderId)).toBe(true);
    expect(historyOrders).toHaveLength(1);
    expect(executions).toHaveLength(1);
    expect(balances).toHaveLength(1);
    expect(positions.channels[0]?.positions).toHaveLength(1);
  });

  it('supports order changed push callbacks and topic subscription', async () => {
    const tradeCtx = createTradeContextMock();
    const received: string[] = [];

    tradeCtx.setOnOrderChanged((_err, event) => {
      received.push(`${event.orderId}:${String(event.status)}`);
    });

    await tradeCtx.subscribe([TopicType.Private]);
    tradeCtx.emitOrderChanged(
      createPushOrderChanged({
        orderId: 'WS-001',
        symbol: '700.HK',
        status: OrderStatus.PartialFilled,
      }),
      { sequence: 2 },
    );
    tradeCtx.emitOrderChanged(
      createPushOrderChanged({
        orderId: 'WS-001',
        symbol: '700.HK',
        status: OrderStatus.Filled,
      }),
      { sequence: 1 },
    );

    expect(tradeCtx.flushAllEvents()).toBe(2);
    expect(new Set(received)).toEqual(
      new Set([
        `WS-001:${String(OrderStatus.Filled)}`,
        `WS-001:${String(OrderStatus.PartialFilled)}`,
      ]),
    );

    await tradeCtx.unsubscribe([TopicType.Private]);
    expect(tradeCtx.getSubscribedTopics().size).toBe(0);
  });

  it('supports failure injection and call logs for trade APIs', async () => {
    const tradeCtx = createTradeContextMock();
    tradeCtx.setFailureRule('submitOrder', {
      failAtCalls: [1],
      errorMessage: 'submit failed by rule',
    });

    expect(async () => {
      await tradeCtx.submitOrder({
        symbol: '700.HK',
        side: OrderSide.Buy,
        orderType: OrderType.ELO,
        timeInForce: TimeInForceType.Day,
        submittedQuantity: toMockDecimal(100),
        submittedPrice: toMockDecimal(320),
      });
    }).toThrow('submit failed by rule');

    const logs = tradeCtx.getCalls('submitOrder');
    expect(logs).toHaveLength(1);
    expect(logs[0]?.error?.message).toContain('submit failed by rule');
  });
});
