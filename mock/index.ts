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
