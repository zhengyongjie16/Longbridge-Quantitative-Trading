import type { MonitorTaskProcessorDeps } from '../../../src/main/asyncProgram/monitorTaskProcessor/types.js';
import type { PeriodicSwitchWakeupRuntime } from '../../../src/main/periodicSwitchWakeupRuntime/types.js';
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
  readonly quoteSubscriptionRuntime?: MonitorTaskProcessorDeps['quoteSubscriptionRuntime'];
  readonly onProcessed?: MonitorTaskProcessorDeps['onProcessed'];
  readonly getCanProcessTask?: MonitorTaskProcessorDeps['getCanProcessTask'];
  readonly getCanTradeNow?: MonitorTaskProcessorDeps['getCanTradeNow'];
  readonly onFatalError?: MonitorTaskProcessorDeps['onFatalError'];
  readonly periodicSwitchWakeupRuntime?: Pick<
    PeriodicSwitchWakeupRuntime,
    'markWaitingEmpty' | 'clearWaitingEmpty' | 'replanRouteAfterTask'
  >;
}>;
