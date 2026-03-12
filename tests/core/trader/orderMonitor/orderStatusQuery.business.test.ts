/**
 * orderMonitor/orderStatusQuery 业务测试
 *
 * 覆盖：
 * - orderDetail 权威查询对终态、开放态与失败态的映射
 * - Expired、PartialWithdrawal、603001 等关键边界语义
 */
import { describe, expect, it } from 'bun:test';
import { Decimal, OrderSide, OrderType, type OrderDetail, type TradeContext } from 'longbridge';
import { createOrderStatusQuery } from '../../../../src/core/trader/orderMonitor/orderStatusQuery.js';

const OPEN_API_ORDER_STATUS_FILLED = 5;
const OPEN_API_ORDER_STATUS_REJECTED = 14;
const OPEN_API_ORDER_STATUS_CANCELED = 15;
const OPEN_API_ORDER_STATUS_EXPIRED = 16;
const OPEN_API_ORDER_STATUS_PARTIAL_WITHDRAWAL = 17;
const OPEN_API_ORDER_STATUS_PENDING_CANCEL = 12;

function createOrderSnapshot(params: {
  readonly orderId: string;
  readonly status: number;
  readonly executedQuantity?: number;
  readonly executedPrice?: number;
}): OrderDetail {
  const executedQuantity = params.executedQuantity ?? 0;
  const executedPrice = params.executedPrice ?? 0;
  return {
    orderId: params.orderId,
    status: params.status,
    stockName: 'BULL',
    quantity: new Decimal(100),
    executedQuantity: new Decimal(executedQuantity),
    price: new Decimal(1),
    executedPrice: new Decimal(executedPrice),
    submittedAt: new Date('2026-02-25T03:00:00.000Z'),
    side: OrderSide.Buy,
    symbol: 'BULL.HK',
    orderType: OrderType.ELO,
    updatedAt: new Date('2026-02-25T03:00:10.000Z'),
  } as unknown as OrderDetail;
}

function createOrderNotFoundError(orderId: string): Error {
  return new Error(`openapi error: code=603001: Order not found, orderId=${orderId}`);
}

function createQueryContext(params?: {
  readonly orderDetail?: (orderId: string) => Promise<OrderDetail>;
}) {
  const ctx: Pick<TradeContext, 'orderDetail'> = {
    orderDetail:
      params?.orderDetail ??
      (async (orderId: string) => {
        throw createOrderNotFoundError(orderId);
      }),
  };
  const orderStatusQuery = createOrderStatusQuery({
    ctxPromise: Promise.resolve(ctx as unknown as TradeContext),
    rateLimiter: {
      throttle: async () => {},
    },
  });
  return {
    orderStatusQuery,
  };
}

describe('orderStatusQuery business flow', () => {
  it('maps terminal order statuses to terminal state check result', async () => {
    const terminalCases: ReadonlyArray<{
      readonly status: number;
      readonly expectedReason: 'FILLED' | 'CANCELED' | 'REJECTED';
    }> = [
      { status: OPEN_API_ORDER_STATUS_FILLED, expectedReason: 'FILLED' },
      { status: OPEN_API_ORDER_STATUS_CANCELED, expectedReason: 'CANCELED' },
      { status: OPEN_API_ORDER_STATUS_REJECTED, expectedReason: 'REJECTED' },
    ];

    for (const testCase of terminalCases) {
      const orderId = `ORDER-${testCase.status}`;
      const snapshot = createOrderSnapshot({
        orderId,
        status: testCase.status,
        executedQuantity: 100,
        executedPrice: 1.01,
      });
      const { orderStatusQuery } = createQueryContext({
        orderDetail: async (requestedOrderId) => {
          if (requestedOrderId !== orderId) {
            throw createOrderNotFoundError(requestedOrderId);
          }

          return snapshot;
        },
      });

      const result = await orderStatusQuery.checkOrderState(orderId);
      expect(result.kind).toBe('TERMINAL');
      if (result.kind === 'TERMINAL') {
        expect(result.closedReason).toBe(testCase.expectedReason);
      }
    }
  });

  it('maps Expired and PartialWithdrawal to TERMINAL CANCELED', async () => {
    const snapshots = new Map<string, OrderDetail>([
      [
        'ORDER-EXPIRED',
        createOrderSnapshot({
          orderId: 'ORDER-EXPIRED',
          status: OPEN_API_ORDER_STATUS_EXPIRED,
        }),
      ],
      [
        'ORDER-PARTIAL-WITHDRAWAL',
        createOrderSnapshot({
          orderId: 'ORDER-PARTIAL-WITHDRAWAL',
          status: OPEN_API_ORDER_STATUS_PARTIAL_WITHDRAWAL,
          executedQuantity: 20,
          executedPrice: 1.02,
        }),
      ],
    ]);
    const { orderStatusQuery } = createQueryContext({
      orderDetail: async (orderId) => {
        const snapshot = snapshots.get(orderId);
        if (snapshot) {
          return snapshot;
        }

        throw createOrderNotFoundError(orderId);
      },
    });

    const expiredResult = await orderStatusQuery.checkOrderState('ORDER-EXPIRED');
    expect(expiredResult.kind).toBe('TERMINAL');
    if (expiredResult.kind === 'TERMINAL') {
      expect(expiredResult.closedReason).toBe('CANCELED');
    }

    const partialWithdrawalResult = await orderStatusQuery.checkOrderState(
      'ORDER-PARTIAL-WITHDRAWAL',
    );
    expect(partialWithdrawalResult.kind).toBe('TERMINAL');
    if (partialWithdrawalResult.kind === 'TERMINAL') {
      expect(partialWithdrawalResult.closedReason).toBe('CANCELED');
      expect(partialWithdrawalResult.executedQuantity).toBe(20);
    }
  });

  it('maps 603001 to QUERY_FAILED NOT_FOUND', async () => {
    const { orderStatusQuery } = createQueryContext();
    const result = await orderStatusQuery.checkOrderState('ORDER-NOT-EXIST');
    expect(result.kind).toBe('QUERY_FAILED');
    if (result.kind === 'QUERY_FAILED') {
      expect(result.reason).toBe('NOT_FOUND');
      expect(result.errorCode).toBe('603001');
    }
  });

  it('maps non-603001 orderDetail errors to QUERY_FAILED API_ERROR', async () => {
    const { orderStatusQuery } = createQueryContext({
      orderDetail: async () => {
        throw new Error('openapi error: code=500001: unknown upstream error');
      },
    });
    const result = await orderStatusQuery.checkOrderState('ORDER-API-ERROR');
    expect(result.kind).toBe('QUERY_FAILED');
    if (result.kind === 'QUERY_FAILED') {
      expect(result.reason).toBe('API_ERROR');
      expect(result.errorCode).toBe('500001');
    }
  });

  it('keeps pending status as OPEN instead of terminal', async () => {
    const orderId = 'ORDER-PENDING-CANCEL';
    const snapshot = createOrderSnapshot({
      orderId,
      status: OPEN_API_ORDER_STATUS_PENDING_CANCEL,
      executedQuantity: 20,
      executedPrice: 1.01,
    });
    const { orderStatusQuery } = createQueryContext({
      orderDetail: async (requestedOrderId) => {
        if (requestedOrderId !== orderId) {
          throw createOrderNotFoundError(requestedOrderId);
        }

        return snapshot;
      },
    });

    const result = await orderStatusQuery.checkOrderState(orderId);
    expect(result.kind).toBe('OPEN');
    if (result.kind === 'OPEN') {
      expect(result.status).toBe(OPEN_API_ORDER_STATUS_PENDING_CANCEL);
      expect(result.executedQuantity).toBe(20);
    }
  });
});
