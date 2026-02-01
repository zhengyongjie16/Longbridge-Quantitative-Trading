import { logger } from '../../../utils/logger/index.js';
import { formatError } from '../../../utils/helpers/index.js';

import type { Quote } from '../../../types/index.js';
import type { OrderMonitorWorker, OrderMonitorWorkerDeps } from './types.js';

export function createOrderMonitorWorker(deps: OrderMonitorWorkerDeps): OrderMonitorWorker {
  const { monitorAndManageOrders } = deps;

  let running = true;
  let inFlight = false;
  let latestQuotes: ReadonlyMap<string, Quote | null> | null = null;

  async function run(): Promise<void> {
    if (!running || inFlight || !latestQuotes) {
      return;
    }

    const quotes = latestQuotes;
    latestQuotes = null;
    inFlight = true;

    try {
      await monitorAndManageOrders(quotes);
    } catch (err) {
      logger.warn('[OrderMonitorWorker] 订单监控失败', formatError(err));
    } finally {
      inFlight = false;
      if (running && latestQuotes) {
        void run();
      }
    }
  }

  function schedule(quotesMap: ReadonlyMap<string, Quote | null>): void {
    if (!running) {
      return;
    }
    latestQuotes = quotesMap;
    if (!inFlight) {
      void run();
    }
  }

  function stop(): void {
    running = false;
    latestQuotes = null;
  }

  return {
    schedule,
    stop,
  };
}
