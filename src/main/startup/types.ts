import type { Logger } from '../../utils/logger/types.js';
import type { GateMode } from '../../types/seat.js';
import type { TradingDayInfo } from '../../types/services.js';

/**
 * 启动门禁的依赖注入对象（创建 StartupGate 时的参数）。
 * 类型用途：createStartupGate() 的入参，提供时间、交易日解析、时段判断、开盘保护、轮询间隔、日志等。
 * 数据来源：由 app pre-gate runtime 装配链路组装并传入 createStartupGate。
 * 使用范围：仅启动流程内部使用。
 */
export type StartupGateDeps = {
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  readonly resolveTradingDayInfo: (currentTime: Date) => Promise<TradingDayInfo>;
  readonly isInSession: (currentTime: Date, isHalfDay: boolean) => boolean;
  readonly isInMorningOpenProtection: (currentTime: Date, minutes: number) => boolean;
  readonly isInAfternoonOpenProtection: (currentTime: Date, minutes: number) => boolean;
  readonly openProtection: {
    readonly morning: {
      readonly enabled: boolean;
      readonly minutes: number | null;
    };
    readonly afternoon: {
      readonly enabled: boolean;
      readonly minutes: number | null;
    };
  };
  readonly intervalMs: number;
  readonly logger: Logger;
};

/**
 * 启动门禁接口（行为契约）。
 * 类型用途：启动时阻塞等待交易条件满足（wait），由 createStartupGate() 返回。
 * 数据来源：createStartupGate(StartupGateDeps) 返回；wait 内部依赖 TradingDayInfo 等。
 * 使用范围：仅 app pre-gate runtime 装配链路调用，内部使用。
 */
export interface StartupGate {
  wait: (params: { readonly mode: GateMode }) => Promise<TradingDayInfo>;
}

/**
 * 启动门禁内部状态（轮询结果状态）。
 * 类型用途：门禁内部用于日志与轮询判断，表示当前未开市原因或已就绪。
 * 数据来源：由 StartupGate 实现根据当前时间与配置计算得出。
 * 使用范围：仅启动门禁模块内部使用。
 */
export type StartupGateState = 'notTradingDay' | 'outOfSession' | 'openProtection' | 'ready' | null;
