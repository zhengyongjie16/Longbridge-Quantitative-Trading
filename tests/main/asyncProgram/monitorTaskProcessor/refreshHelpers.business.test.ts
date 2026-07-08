/**
 * refreshHelpers 业务测试
 *
 * 覆盖：
 * - 校验连续席位刷新各自获取最新全量订单事实
 * - 校验账户、持仓与订阅投影不会跨动态队列任务复用陈旧快照
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderStatus, OrderType } from 'longbridge';

import { createRefreshHelpers } from '../../../../src/main/asyncProgram/monitorTaskProcessor/helpers/refreshHelpers.js';
import {
  createAccountSnapshotDouble,
  createOrderRecorderDouble,
  createPositionDouble,
  createTraderDouble,
} from '../../../helpers/testDoubles.js';
import { createLastState } from '../utils.js';

describe('refreshHelpers business flow', () => {
  it('fetches a fresh all-orders snapshot for each seat refresh', async () => {
    let fetchAllOrdersCalls = 0;
    const orderRecorder = createOrderRecorderDouble({
      fetchAllOrdersFromAPI: async () => {
        fetchAllOrdersCalls += 1;
        return [
          {
            orderId: `ORDER-${fetchAllOrdersCalls}`,
            symbol: 'BULL.HK',
            stockName: 'BULL',
            side: OrderSide.Buy,
            status: OrderStatus.Filled,
            orderType: OrderType.LO,
            price: '1',
            quantity: '100',
            executedPrice: '1',
            executedQuantity: '100',
            submittedAt: new Date('2026-06-11T01:00:00.000Z'),
            updatedAt: new Date('2026-06-11T01:00:01.000Z'),
            remark: '',
          },
        ];
      },
    });
    const helpers = createRefreshHelpers({
      trader: createTraderDouble({ orderRecorder }),
      lastState: createLastState(),
    });

    const firstSnapshot = await helpers.ensureAllOrders();
    const secondSnapshot = await helpers.ensureAllOrders();

    expect(fetchAllOrdersCalls).toBe(2);
    expect(firstSnapshot[0]?.orderId).toBe('ORDER-1');
    expect(secondSnapshot[0]?.orderId).toBe('ORDER-2');
  });

  it('refreshes account and position truth for each seat refresh', async () => {
    let accountCalls = 0;
    let positionCalls = 0;
    let reconcileCalls = 0;
    const lastState = createLastState();
    const helpers = createRefreshHelpers({
      trader: createTraderDouble({
        getAccountSnapshot: async () => {
          accountCalls += 1;
          return createAccountSnapshotDouble(accountCalls * 10_000);
        },
        getStockPositions: async () => {
          positionCalls += 1;
          return [
            createPositionDouble({
              symbol: 'BULL.HK',
              quantity: positionCalls * 100,
              availableQuantity: positionCalls * 100,
            }),
          ];
        },
      }),
      lastState,
      quoteSubscriptionRuntime: {
        reconcilePositionHoldFromCurrentTruth: async () => {
          reconcileCalls += 1;
        },
      },
    });

    await helpers.refreshAccountCaches();
    await helpers.refreshAccountCaches();

    expect(accountCalls).toBe(2);
    expect(positionCalls).toBe(2);
    expect(reconcileCalls).toBe(2);
    expect(lastState.cachedAccount?.buyPower).toBe(20_000);
    expect(lastState.cachedPositions[0]?.quantity).toBe(200);
    expect(lastState.positionCache.get('BULL.HK')?.quantity).toBe(200);
  });
});
