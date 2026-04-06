import type { MonitorTaskProcessorDeps } from '../../../src/main/asyncProgram/monitorTaskProcessor/types.js';
import type { createLastState, createMonitorTaskContext } from './utils.js';
import type { createTraderDouble } from '../../helpers/testDoubles.js';

/**
 * monitorTaskProcessor 业务测试的处理器构造参数。
 * 类型用途：集中描述测试工厂 createBusinessProcessor 的依赖注入输入。
 * 数据来源：由 tests/main/asyncProgram/monitorTaskProcessor/business.test.ts 组装。
 * 使用范围：tests/main/asyncProgram 下相关业务测试。
 */
export type CreateBusinessProcessorParams = Readonly<{
  readonly queue: MonitorTaskProcessorDeps['monitorTaskQueue'];
  readonly context: ReturnType<typeof createMonitorTaskContext>;
  readonly lastState?: ReturnType<typeof createLastState>;
  readonly trader?: ReturnType<typeof createTraderDouble>;
  readonly marketDataClient?: MonitorTaskProcessorDeps['marketDataClient'];
  readonly scheduleRetry?: MonitorTaskProcessorDeps['scheduleRetry'];
  readonly clearRetry?: MonitorTaskProcessorDeps['clearRetry'];
  readonly onProcessed?: MonitorTaskProcessorDeps['onProcessed'];
  readonly getCanProcessTask?: MonitorTaskProcessorDeps['getCanProcessTask'];
  readonly postTradeConsistencyRuntime?: MonitorTaskProcessorDeps['postTradeConsistencyRuntime'];
}>;

/**
 * 长仓单向清仓上下文钩子参数。
 * 类型用途：描述测试中用于观察 clearBuyOrders / lossOffset / refreshUnrealizedLoss 调用的可选回调。
 * 数据来源：由 tests/main/asyncProgram/monitorTaskProcessor/business.test.ts 构造。
 * 使用范围：tests/main/asyncProgram 下相关业务测试。
 */
export type CreateTriggeredLongOnlyLiquidationContextParams = Readonly<{
  readonly onClearBuyOrders?: (isLongSymbol: boolean) => void;
  readonly onGetLossOffset?: (isLongSymbol: boolean) => void;
  readonly onRefreshUnrealizedLoss?: (isLongSymbol: boolean) => void;
}>;
