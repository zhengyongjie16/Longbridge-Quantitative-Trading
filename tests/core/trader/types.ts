/**
 * replaceOrder 调用载荷的最小结构。
 * 类型用途：在 orderMonitor 业务测试中收窄 replaceOrder payload，提取可序列化价格字段。
 * 数据来源：由 tradeContext mock 的 replaceOrder 调用记录产生。
 * 使用范围：tests/core/trader/orderMonitor.business.test.ts。
 */
export type ReplaceOrderPayload = Readonly<{
  readonly price: Readonly<{
    readonly toString: () => string;
  }>;
}>;

/**
 * 本地卖单记录调用的最小参数结构。
 * 类型用途：在 orderMonitor 业务测试中断言 relatedBuyOrderIds 归属。
 * 数据来源：由 orderRecorderDouble.recordLocalSellOrder 调用记录产生。
 * 使用范围：tests/core/trader/orderMonitor.business.test.ts。
 */
export type RecordLocalSellCall = Readonly<{
  readonly relatedBuyOrderIds: ReadonlyArray<string> | null;
}>;
