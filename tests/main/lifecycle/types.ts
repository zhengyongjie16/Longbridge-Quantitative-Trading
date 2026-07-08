import type { RawOrderFromAPI } from '../../../src/types/services.js';

/**
 * 保护性清仓订单测试参数。
 * 类型用途：描述 createProtectiveOrder 测试工厂需要的最小订单字段。
 * 数据来源：由 tests/main/lifecycle/loadTradingDayRuntimeSnapshot.test.ts 构造。
 * 使用范围：tests/main/lifecycle 下相关测试。
 */
export type ProtectiveOrderParams = Readonly<{
  readonly orderId: string;
  readonly status: RawOrderFromAPI['status'];
  readonly price: number;
  readonly quantity: number;
  readonly executedPrice: number;
  readonly executedQuantity: number;
  readonly updatedAtMs: number;
}>;

/**
 * 生命周期运行时顺序断言的方法名。
 * 类型用途：约束 signalRuntimeDomain 测试中记录的 runtime 方法调用集合。
 * 数据来源：由 tests/main/lifecycle/cacheDomains/signalRuntimeDomain.test.ts 内部测试桩记录。
 * 使用范围：tests/main/lifecycle 下相关测试。
 */
export type OrderedMethod = 'stopAndDrain' | 'restart' | 'start' | 'clearPending';
