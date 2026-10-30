import { InjectionToken, Signal } from '@angular/core';
import { Observable } from 'rxjs';

export type FeedStatus = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'session-expired';

/**
 * Market-data transport. Keys are feed keys `"EXCH|token"` (e.g. `"NFO|43651"`).
 * Subscriptions are ref-counted: `t` is sent only for keys going 0 -> 1, `u` only for 1 -> 0.
 */
export interface FeedTransport {
  connect(): Promise<void>;
  /** Closes the connection for good (the page is going away): no more messages or reconnects. */
  close(): void;
  send(msg: object): void;
  subscribe(keys: string[]): void;
  unsubscribe(keys: string[]): void;
  readonly messages: Observable<object>;
  readonly status: Signal<FeedStatus>;
  /** The server's subscription limit once it has rejected keys beyond it; null until then. */
  readonly limitReached: Signal<number | null>;
}

export const FEED_TRANSPORT = new InjectionToken<FeedTransport>('FEED_TRANSPORT');
