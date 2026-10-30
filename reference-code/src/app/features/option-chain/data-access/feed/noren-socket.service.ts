import { DestroyRef, inject, Injectable, InjectionToken, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { KambalaError, NOREN_SESSION_CONFIG, NorenSessionConfig } from '../kambala/kambala.types';
import { FeedStatus, FeedTransport } from './transport';

/** Minimal WebSocket surface used by the service (the browser WebSocket satisfies it). */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onopen: ((ev: any) => void) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onmessage: ((ev: any) => void) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onclose: ((ev: any) => void) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onerror: ((ev: any) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export const WEB_SOCKET_FACTORY = new InjectionToken<WebSocketFactory>('WEB_SOCKET_FACTORY', {
  providedIn: 'root',
  factory: () => (url: string) => new WebSocket(url),
});

/** Source of randomness for reconnect jitter (injectable for deterministic tests). */
export const NOREN_RANDOM = new InjectionToken<() => number>('NOREN_RANDOM', {
  providedIn: 'root',
  factory: () => Math.random,
});

/**
 * The connect message for this session shape: v2 OAuth (accessToken) or legacy Noren (susertoken). See
 * NorenSessionConfig.
 */
export function connectMessage(c: NorenSessionConfig): Record<string, string> {
  if (c.accessToken) {
    return { t: 'a', uid: c.uid, actid: c.actid, source: c.source ?? 'API', accesstoken: c.accessToken };
  }
  return { t: 'c', uid: c.uid, actid: c.actid, source: c.source ?? 'WEB', susertoken: c.susertoken ?? '' };
}

const DEFAULT_HEARTBEAT_MS = 30_000;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const JITTER = 0.2;
const WS_OPEN = 1;

@Injectable({ providedIn: 'root' })
export class NorenSocketService implements FeedTransport {
  // INTEGRATION: provided by TradeSmart auth/session service (a getter, read on every connect). Its shape picks the
  // connect message: `accessToken` set -> v2 OAuth {t:'a', uid, actid, source:'API', accesstoken}, ack t:'ak';
  // `susertoken` only -> legacy Noren {t:'c', uid, actid, source:'WEB', susertoken}, ack t:'ck' (TradeSmart's web
  // session may still use this one).
  private readonly sessionConfig: () => NorenSessionConfig = inject(NOREN_SESSION_CONFIG);
  /** The session config of the current connection, read when it was opened. */
  private config: NorenSessionConfig = { url: '', uid: '', actid: '', susertoken: '' };
  private readonly factory = inject(WEB_SOCKET_FACTORY);
  private readonly random = inject(NOREN_RANDOM);

  private readonly _status = signal<FeedStatus>('closed');
  readonly status = this._status.asReadonly();
  // INTEGRATION: map Kambala's subscription-limit error once known
  readonly limitReached = signal<number | null>(null).asReadonly();

  private readonly _messages = new Subject<object>();
  readonly messages = this._messages.asObservable();

  private socket: WebSocketLike | null = null;
  private readonly refCounts = new Map<string, number>();
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private intentionalClose = false;
  private sessionExpired = false;
  private connectPromise: Promise<void> | null = null;
  private pendingConnect: { resolve: () => void; reject: (e: unknown) => void } | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.close());
  }

  connect(): Promise<void> {
    if (this._status() === 'open') return Promise.resolve();
    if (this._status() === 'connecting' && this.connectPromise) return this.connectPromise;
    // Closed, session-expired or reconnecting: drop any pending retry and stale socket first.
    this.clearTimers();
    this.detachSocket();
    if (!this.connectPromise) {
      this.connectPromise = new Promise<void>((resolve, reject) => {
        this.pendingConnect = { resolve, reject };
      });
    }
    this.intentionalClose = false;
    this.sessionExpired = false;
    this.open('connecting');
    return this.connectPromise;
  }

  private detachSocket(): void {
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onopen = s.onmessage = s.onclose = s.onerror = null;
      s.close();
    }
  }

  close(): void {
    this.intentionalClose = true;
    this.clearTimers();
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onclose = null;
      s.close();
    }
    this.settleConnect(new Error('Feed closed'));
    if (this._status() !== 'session-expired') this._status.set('closed');
  }

  send(msg: object): void {
    if (this.socket && this.socket.readyState === WS_OPEN) {
      this.socket.send(JSON.stringify(msg));
    }
  }

  subscribe(keys: string[]): void {
    const fresh: string[] = [];
    for (const key of new Set(keys)) {
      const n = this.refCounts.get(key) ?? 0;
      this.refCounts.set(key, n + 1);
      if (n === 0) fresh.push(key);
    }
    if (fresh.length > 0 && this._status() === 'open') this.send({ t: 't', k: fresh.join('#') });
  }

  unsubscribe(keys: string[]): void {
    const gone: string[] = [];
    for (const key of new Set(keys)) {
      const n = this.refCounts.get(key);
      if (n === undefined) continue;
      if (n <= 1) {
        this.refCounts.delete(key);
        gone.push(key);
      } else {
        this.refCounts.set(key, n - 1);
      }
    }
    if (gone.length > 0 && this._status() === 'open') this.send({ t: 'u', k: gone.join('#') });
  }

  private open(status: FeedStatus): void {
    this._status.set(status);
    this.config = this.sessionConfig(); // a refreshed token (after re-login) is used from this connect on
    const socket = this.factory(this.config.url);
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      socket.send(JSON.stringify(connectMessage(this.config)));
    };
    socket.onmessage = (ev: { data: unknown }) => {
      if (this.socket !== socket) return;
      let msg: unknown;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (typeof msg !== 'object' || msg === null) return;
      this.handle(msg as Record<string, unknown>);
      this._messages.next(msg);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.onSocketClosed();
    };
    socket.onerror = () => {
      // A close event always follows; reconnection is handled there.
    };
  }

  private handle(msg: Record<string, unknown>): void {
    const t = msg['t'];
    if (t !== 'ak' && t !== 'ck') return; // connect ack: v2 (ak) or legacy (ck)
    const s = String(msg['s'] ?? '').toLowerCase();
    if (s === 'ok') {
      this.attempt = 0;
      this._status.set('open');
      this.startHeartbeat();
      if (this.refCounts.size > 0) this.send({ t: 't', k: [...this.refCounts.keys()].join('#') });
      this.settleConnect();
    } else {
      this.sessionExpired = true;
      this._status.set('session-expired');
      this.clearTimers();
      this.settleConnect(new KambalaError(`WebSocket session rejected (${String(t)} Not_Ok)`));
      const sock = this.socket;
      this.socket = null;
      if (sock) {
        sock.onclose = null;
        sock.close();
      }
    }
  }

  private onSocketClosed(): void {
    this.stopHeartbeat();
    if (this.intentionalClose || this.sessionExpired) return;
    this._status.set('reconnecting');
    const base = Math.min(BASE_BACKOFF_MS * 2 ** this.attempt, MAX_BACKOFF_MS);
    const jitter = (this.random() * 2 - 1) * JITTER;
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open('reconnecting');
    }, base * (1 + jitter));
  }

  private settleConnect(err?: Error): void {
    const p = this.pendingConnect;
    this.pendingConnect = null;
    this.connectPromise = null;
    if (!p) return;
    if (err) p.reject(err);
    else p.resolve();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const ms = this.config.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.heartbeatTimer = setInterval(() => this.send({ t: 'h' }), ms);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private clearTimers(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}

