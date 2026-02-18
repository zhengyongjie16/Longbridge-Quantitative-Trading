/**
 * Mock 运行时入口
 *
 * 功能：
 * - 统一组装事件总线、行情/交易上下文、场景时钟与任务调度器
 */
import { createQuoteContextMock, type QuoteContextMock } from './longport/quoteContextMock.js';
import { createTradeContextMock, type TradeContextMock } from './longport/tradeContextMock.js';
import { createLongportEventBus, type LongportEventBus } from './longport/eventBus.js';
import { createScenarioClock, type ScenarioClock } from './scenario/clock.js';
import { createScenarioScheduler, type ScenarioScheduler } from './scenario/scheduler.js';

export type MockRuntime = {
  readonly eventBus: LongportEventBus;
  readonly quote: QuoteContextMock;
  readonly trade: TradeContextMock;
  readonly clock: ScenarioClock;
  readonly scheduler: ScenarioScheduler;
};

/**
 * 创建统一的 Mock 运行时容器。
 *
 * 通过共享同一时钟实例与事件总线，保证行情、交易与调度的时间语义一致，
 * 便于在集成测试中复现跨模块交互顺序。
 */
export function createMockRuntime(initialMs: number = Date.now()): MockRuntime {
  const clock = createScenarioClock(initialMs);
  const eventBus = createLongportEventBus(() => clock.now());
  const quote = createQuoteContextMock({
    eventBus,
    now: () => clock.now(),
  });
  const trade = createTradeContextMock({
    eventBus,
    now: () => clock.now(),
  });
  const scheduler = createScenarioScheduler(clock);

  return {
    eventBus,
    quote,
    trade,
    clock,
    scheduler,
  };
}
