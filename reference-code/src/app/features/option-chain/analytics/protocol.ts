import type { ChainAnalytics, ChainInput } from '@option-analytics/analyze';

/**
 * Main thread -> analytics worker. `chain` is the chain identity (`underlyingKey|expiry.iso`) the input was taken
 * from; the worker echoes it so the bridge can drop a reply that belongs to a chain no longer shown.
 */
export type ToWorker = { v: 1; kind: 'analyze'; id: number; chain: string; input: ChainInput };

/** Analytics worker -> main thread. */
export type FromWorker =
  | { v: 1; kind: 'result'; id: number; chain: string; result: ChainAnalytics }
  | { v: 1; kind: 'error'; id: number; chain: string; message: string };
