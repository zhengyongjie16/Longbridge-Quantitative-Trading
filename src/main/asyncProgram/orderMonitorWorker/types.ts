import type { Quote } from '../../../types/index.js';

export type OrderMonitorWorkerDeps = Readonly<{
  readonly monitorAndManageOrders: (quotesMap: ReadonlyMap<string, Quote | null>) => Promise<void>;
}>;

export type OrderMonitorWorker = Readonly<{
  schedule: (quotesMap: ReadonlyMap<string, Quote | null>) => void;
  stop: () => void;
}>;
