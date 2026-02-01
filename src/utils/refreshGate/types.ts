export type RefreshGateStatus = Readonly<{
  currentVersion: number;
  staleVersion: number;
}>;

export type RefreshGate = Readonly<{
  markStale: () => number;
  markFresh: (version: number) => void;
  waitForFresh: () => Promise<void>;
  getStatus: () => RefreshGateStatus;
}>;
