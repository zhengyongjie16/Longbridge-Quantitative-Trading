import type { MultiMonitorTradingConfig } from '../../types/config.js';
import type { IndicatorSnapshot } from '../../types/quote.js';
import type { MonitorContext, LastState } from '../../types/state.js';
import type { MarketDataClient } from '../../types/services.js';
import type { SignalSeatInfo } from '../processMonitor/types.js';
import type { IndicatorCache } from '../asyncProgram/indicatorCache/types.js';
import type { BuyTaskType, SellTaskType, TaskQueue } from '../asyncProgram/tradeTaskQueue/types.js';

/**
 * K 线业务程序行为契约。
 * 类型用途：统一普通 K 线业务 owner 的启停能力。
 * 数据来源：由 createBusinessEventProgram 创建。
 * 使用范围：app 装配、lifecycle、cleanup 使用。
 */
export interface BusinessEventProgram {
  /** 启动 K 线事件监听。 */
  readonly start: () => void;

  /** 停止监听并等待在途业务路由完成。 */
  readonly stopAndDrain: () => Promise<void>;
}

/**
 * 单 monitor 的业务事件路由状态。
 * 类型用途：实现 per-monitor single-flight + latest-only collapse。
 * 数据来源：由 businessEventProgram 在运行期维护。
 * 使用范围：仅 businessEventProgram 模块内部使用。
 */
export type BusinessEventRouteState =
  | {
      inFlight: boolean;
      dirty: false;
    }
  | {
      inFlight: boolean;
      dirty: true;
      pendingObservedAtMs: number;
    };

/**
 * monitor indicator 显示 runtime 最小契约。
 * 类型用途：约束 businessEventProgram 在普通 K 线指标推进后提交显示请求的能力。
 * 数据来源：由 app 层注入 MonitorDisplayRuntime 实例。
 * 使用范围：仅 businessEventProgram 模块使用。
 */
type BusinessEventMonitorDisplayRuntime = Readonly<{
  requestRender: (params: {
    readonly monitorSymbol: string;
    readonly monitorSnapshot: IndicatorSnapshot;
  }) => void;
}>;

/**
 * K 线业务程序依赖。
 * 类型用途：收口普通 K 线业务 owner 所需的共享服务、状态、任务队列与显示 runtime。
 * 数据来源：由 app 顶层装配注入。
 * 使用范围：仅 businessEventProgram 模块使用。
 */
export type BusinessEventProgramDeps = Readonly<{
  marketDataClient: Pick<MarketDataClient, 'getCandlestickSnapshot' | 'onCandlestickUpdated'>;
  monitorContexts: ReadonlyMap<string, MonitorContext>;
  lastState: LastState;
  tradingConfig: MultiMonitorTradingConfig;
  buyTaskQueue: TaskQueue<BuyTaskType>;
  sellTaskQueue: TaskQueue<SellTaskType>;
  indicatorCache: IndicatorCache;
  monitorDisplayRuntime: BusinessEventMonitorDisplayRuntime;
}>;

/**
 * K 线业务事件运行时门禁参数。
 * 类型用途：表达普通 K 线事件链路执行信号流水线时需要的当前时刻与交易门禁快照。
 * 数据来源：由 businessEventProgram 在事件处理时按 lastState 组装。
 * 使用范围：仅 businessEventProgram 信号流水线使用。
 */
type BusinessEventRuntimeFlags = Readonly<{
  currentTime: Date;
  isHalfDay: boolean;
  canTradeNow: boolean;
  openProtectionActive: boolean;

  /** 交易门禁透传：用于区分交易门禁与普通信号门禁的日志语义 */
  isTradingEnabled: boolean;
}>;

/**
 * 指标流水线参数（执行指标计算与最新快照写入时的入参）。
 * 类型用途：封装指标流水线所需的监控标的、监控上下文与 K 线缓存读取端口。
 * 数据来源：由 businessEventProgram 按 K 线事件组装。
 * 使用范围：仅普通 K 线业务事件链路使用。
 */
export type IndicatorPipelineParams = Readonly<{
  monitorSymbol: string;
  monitorContext: MonitorContext;
  mainContext: Readonly<{
    marketDataClient: Pick<MarketDataClient, 'getCandlestickSnapshot'>;
  }>;
}>;

/**
 * 信号流水线参数（执行信号生成、延迟验证入队等时的入参）。
 * 类型用途：封装信号流水线所需的监控标的、上下文、席位信息与指标快照。
 * 数据来源：由 businessEventProgram 从席位投影结果、指标流水线输出等组装。
 * 使用范围：仅普通 K 线业务事件链路使用。
 */
export type SignalPipelineParams = Readonly<{
  monitorSymbol: string;
  monitorContext: MonitorContext;
  mainContext: Pick<
    BusinessEventProgramDeps,
    'lastState' | 'tradingConfig' | 'buyTaskQueue' | 'sellTaskQueue'
  >;
  runtimeFlags: BusinessEventRuntimeFlags;
  seatInfo: SignalSeatInfo;
  monitorSnapshot: IndicatorSnapshot;
}>;
