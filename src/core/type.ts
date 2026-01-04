/**
 * 核心模块类型定义
 *
 * 包含被 core 模块中各个子模块共用的类型
 * 被多个模块共用的类型应定义在 src/types/index.ts 中
 */

import { OrderSide, OrderStatus } from 'longport';

/**
 * 待处理订单接口
 * 注意：此类型不使用 readonly，因为需要在运行时修改
 */
export interface PendingOrder {
  orderId: string;
  symbol: string;
  side: (typeof OrderSide)[keyof typeof OrderSide];
  submittedPrice: number;
  quantity: number;
  executedQuantity: number;
  status: (typeof OrderStatus)[keyof typeof OrderStatus];
  orderType: unknown;
  _rawOrder?: unknown;
}
