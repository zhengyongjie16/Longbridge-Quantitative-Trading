/**
 * 订单关闭原因。
 * 类型用途：统一表示订单终态关闭语义，供撤单结果、订单监控与定向对账共享。
 * 数据来源：撤单 API 返回、WebSocket 终态事件、定向对账结果。
 * 使用范围：Trader、OrderMonitor、清仓冷却日志恢复等跨模块场景；全项目可引用。
 */
export type OrderClosedReason = 'FILLED' | 'CANCELED' | 'REJECTED' | 'NOT_FOUND';

/**
 * 撤单结果（语义化 outcome）。
 * 类型用途：替代 boolean 语义，区分确认撤销、已关闭、可重试失败与未知失败。
 * 数据来源：OrderMonitor.cancelOrder / cancelOrderWithOutcome 返回值。
 * 使用范围：Trader、OrderMonitor、订单执行与恢复链路；全项目可引用。
 */
export type CancelOrderOutcome =
  | {
      readonly kind: 'CANCEL_CONFIRMED';
      readonly closedReason: 'CANCELED' | 'REJECTED';
      readonly source: 'API' | 'WS';
      readonly relatedBuyOrderIds: ReadonlyArray<string> | null;
    }
  | {
      readonly kind: 'ALREADY_CLOSED';
      readonly closedReason: OrderClosedReason;
      readonly source: 'API_ERROR';
      readonly relatedBuyOrderIds: ReadonlyArray<string> | null;
    }
  | {
      readonly kind: 'RETRYABLE_FAILURE';
      readonly errorCode: string | null;
      readonly message: string;
    }
  | {
      readonly kind: 'UNKNOWN_FAILURE';
      readonly errorCode: string | null;
      readonly message: string;
    };

/**
 * 交易记录。
 * 类型用途：用于交易日志持久化（JSON 文件），描述单条成交或订单状态变更。
 * 数据来源：由 TradeLogger、OrderMonitor 等根据订单与信号构造。
 * 使用范围：Trader 内部日志、清仓冷却日志恢复与日志分析；全项目可引用。
 */
export type TradeRecord = {
  readonly orderId: string | null;

  /** 交易标的代码（如 55131.HK） */
  readonly symbol: string | null;

  /** 交易标的名称（如 阿里摩通六甲牛G） */
  readonly symbolName: string | null;

  /** 监控标的代码（如 HSI.HK） */
  readonly monitorSymbol: string | null;

  /** 信号动作（BUYCALL/SELLCALL/BUYPUT/SELLPUT） */
  readonly action: string | null;

  /** 订单方向（BUY/SELL） */
  readonly side: string | null;

  /** 成交数量 */
  readonly quantity: string | null;

  /** 成交价格 */
  readonly price: string | null;

  /** 订单类型（可为空） */
  readonly orderType: string | null;

  /** 订单状态（成交日志仅记录 FILLED） */
  readonly status: string | null;

  /** 错误信息（成交日志默认 null） */
  readonly error: string | null;

  /** 信号原因 */
  readonly reason: string | null;

  /** 信号触发时间（香港时间字符串） */
  readonly signalTriggerTime: string | null;

  /** 成交时间（香港时间字符串） */
  readonly executedAt: string | null;

  /** 成交时间（毫秒时间戳） */
  readonly executedAtMs: number | null;

  /** 日志记录时间（香港时间字符串） */
  readonly timestamp: string | null;

  /** 是否为保护性清仓（浮亏超阈值触发） */
  readonly isProtectiveClearance: boolean | null;
};
