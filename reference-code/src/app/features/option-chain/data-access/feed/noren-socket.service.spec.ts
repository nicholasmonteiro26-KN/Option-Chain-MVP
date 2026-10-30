import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NorenSocketService, NOREN_RANDOM, WEB_SOCKET_FACTORY } from './noren-socket.service';
import { NOREN_SESSION_CONFIG, NorenSessionConfig } from '../kambala/kambala.types';

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(public url: string) { FakeSocket.instances.push(this); }
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close() { this.closed = true; this.readyState = 3; this.onclose?.({}); }
  open() { this.readyState = 1; this.onopen?.({}); }
  receive(obj: object) { this.onmessage?.({ data: JSON.stringify(obj) }); }
  drop() { this.readyState = 3; this.onclose?.({}); }
  get tMsgs() { return this.sent.filter((m) => m['t'] === 't'); }
}

const last = () => FakeSocket.instances[FakeSocket.instances.length - 1]!;

describe('NorenSocketService', () => {
  let rand = 0.5;
  let cfg: NorenSessionConfig;

  function make(extra: Partial<NorenSessionConfig> = {}) {
    cfg = { url: 'wss://feed', uid: 'U1', actid: 'A1', susertoken: 'TOK', ...extra };
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: NOREN_SESSION_CONFIG, useValue: () => cfg },
        { provide: WEB_SOCKET_FACTORY, useValue: (url: string) => new FakeSocket(url) },
        { provide: NOREN_RANDOM, useValue: () => rand },
      ],
    });
    return TestBed.inject(NorenSocketService);
  }

  /** connect + open + ck OK */
  async function connected(svc: NorenSocketService) {
    const p = svc.connect();
    last().open();
    last().receive({ t: 'ck', uid: 'U1', s: 'OK' });
    await p;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    rand = 0.5;
  });
  afterEach(() => vi.useRealTimers());

  it('legacy session (susertoken): sends the t:"c" connect message on open and goes open on ck OK (any case)', async () => {
    const svc = make();
    expect(svc.status()).toBe('closed');
    const p = svc.connect();
    expect(svc.status()).toBe('connecting');
    expect(last().url).toBe('wss://feed');
    last().open();
    expect(last().sent[0]).toEqual({ t: 'c', uid: 'U1', actid: 'A1', source: 'WEB', susertoken: 'TOK' });
    expect(svc.status()).toBe('connecting');
    last().receive({ t: 'ck', uid: 'U1', s: 'Ok' });
    await p;
    expect(svc.status()).toBe('open');
  });

  it('sends the session config source on connect when set (API logins use API)', async () => {
    const svc = make({ source: 'API' });
    const p = svc.connect();
    last().open();
    expect(last().sent[0]).toEqual({ t: 'c', uid: 'U1', actid: 'A1', source: 'API', susertoken: 'TOK' });
    last().receive({ t: 'ck', uid: 'U1', s: 'Ok' });
    await p;
  });

  // ---- v2 OAuth session (accessToken): t:"a" connect, t:"ak" ack ----

  it('v2 session: sends {t:"a", uid, actid, source:"API", accesstoken} on open and goes open on ak OK (any case)', async () => {
    const svc = make({ susertoken: undefined, accessToken: 'FAKE_ACCESS' });
    const p = svc.connect();
    last().open();
    expect(last().sent[0]).toEqual({ t: 'a', uid: 'U1', actid: 'A1', source: 'API', accesstoken: 'FAKE_ACCESS' });
    expect(last().sent[0]).not.toHaveProperty('susertoken');
    expect(svc.status()).toBe('connecting');
    last().receive({ t: 'ak', uid: 'U1', s: 'ok' });
    await p;
    expect(svc.status()).toBe('open');
  });

  it('v2 session: ak OK subscribes held keys and starts the 30 s heartbeat', async () => {
    const svc = make({ susertoken: undefined, accessToken: 'FAKE_ACCESS' });
    svc.subscribe(['NFO|1']);
    const p = svc.connect();
    last().open();
    last().receive({ t: 'ak', s: 'OK' });
    await p;
    expect(last().tMsgs).toEqual([{ t: 't', k: 'NFO|1' }]);
    vi.advanceTimersByTime(30_000);
    expect(last().sent.filter((m) => m['t'] === 'h')).toHaveLength(1);
  });

  it('v2 session: ak Not_Ok goes session-expired, rejects connect and does not reconnect', async () => {
    const svc = make({ susertoken: undefined, accessToken: 'FAKE_ACCESS' });
    const p = svc.connect();
    last().open();
    last().receive({ t: 'ak', s: 'Not_Ok' });
    await expect(p).rejects.toThrow(/ak Not_Ok/);
    expect(svc.status()).toBe('session-expired');
    const n = FakeSocket.instances.length;
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances.length).toBe(n);
  });

  it('v2 session: an explicit source on the config wins', async () => {
    const svc = make({ susertoken: undefined, accessToken: 'FAKE_ACCESS', source: 'WEB' });
    const p = svc.connect();
    last().open();
    expect(last().sent[0]).toMatchObject({ t: 'a', source: 'WEB' });
    last().receive({ t: 'ak', s: 'OK' });
    await p;
  });

  it('reads the session config on every connect, so a token refreshed after re-login is used', async () => {
    const svc = make();
    const p = svc.connect();
    last().open();
    last().receive({ t: 'ck', uid: 'U1', s: 'Not_Ok' });
    await expect(p).rejects.toThrow();
    expect(svc.status()).toBe('session-expired');
    cfg = { ...cfg, susertoken: 'FRESH' }; // the shell refreshes the session after re-login
    const again = svc.connect();
    last().open();
    expect(last().sent[0]).toMatchObject({ t: 'c', susertoken: 'FRESH' });
    last().receive({ t: 'ck', uid: 'U1', s: 'OK' });
    await again;
    expect(svc.status()).toBe('open');
  });

  it('subscribe sends one joined t message; duplicate subscribe sends nothing (ref-count)', async () => {
    const svc = make();
    await connected(svc);
    svc.subscribe(['NFO|1', 'NFO|2']);
    expect(last().tMsgs).toEqual([{ t: 't', k: 'NFO|1#NFO|2' }]);
    svc.subscribe(['NFO|1']);
    expect(last().tMsgs.length).toBe(1);
    svc.subscribe(['NFO|1', 'NFO|3']);
    expect(last().tMsgs[1]).toEqual({ t: 't', k: 'NFO|3' });
  });

  it('unsubscribe sends u only when the count reaches zero', async () => {
    const svc = make();
    await connected(svc);
    svc.subscribe(['NFO|1', 'NFO|2']);
    svc.subscribe(['NFO|1']);
    svc.unsubscribe(['NFO|1', 'NFO|2']);
    const us = () => last().sent.filter((m) => m['t'] === 'u');
    expect(us()).toEqual([{ t: 'u', k: 'NFO|2' }]);
    svc.unsubscribe(['NFO|1']);
    expect(us()[1]).toEqual({ t: 'u', k: 'NFO|1' });
    svc.unsubscribe(['NFO|1']);
    expect(us().length).toBe(2);
  });

  it('reconnects after 1000, 2000, 4000 ms (jitter 0) then re-sends t for both keys', async () => {
    const svc = make();
    await connected(svc);
    svc.subscribe(['NFO|1', 'NFO|2']);

    for (const delay of [1000, 2000, 4000]) {
      const n = FakeSocket.instances.length;
      last().drop();
      expect(svc.status()).toBe('reconnecting');
      vi.advanceTimersByTime(delay - 1);
      expect(FakeSocket.instances.length).toBe(n);
      vi.advanceTimersByTime(1);
      expect(FakeSocket.instances.length).toBe(n + 1);
      last().open(); // opened but never acked: backoff keeps growing
    }

    last().receive({ t: 'ck', s: 'OK' });
    expect(svc.status()).toBe('open');
    expect(last().tMsgs).toEqual([{ t: 't', k: 'NFO|1#NFO|2' }]);
  });

  it('does not re-send keys that were unsubscribed before the reconnect', async () => {
    const svc = make();
    await connected(svc);
    svc.subscribe(['NFO|1', 'NFO|2']);
    svc.unsubscribe(['NFO|1']);
    last().drop();
    vi.advanceTimersByTime(1000);
    last().open();
    last().receive({ t: 'ck', s: 'OK' });
    expect(last().tMsgs).toEqual([{ t: 't', k: 'NFO|2' }]);
  });

  it('keeps jitter within +/-20% (random 0 -> 0.8x, random 1 -> 1.2x)', async () => {
    for (const [r, expected] of [[0, 800], [1, 1200]] as const) {
      TestBed.resetTestingModule();
      FakeSocket.instances = [];
      rand = r;
      const svc = make();
      await connected(svc);
      const n = FakeSocket.instances.length;
      last().drop();
      vi.advanceTimersByTime(expected - 1);
      expect(FakeSocket.instances.length).toBe(n);
      vi.advanceTimersByTime(1);
      expect(FakeSocket.instances.length).toBe(n + 1);
    }
  });

  it('caps the backoff at 30000 ms', async () => {
    const svc = make();
    await connected(svc);
    const delays = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
    for (const d of delays) {
      const n = FakeSocket.instances.length;
      last().drop();
      vi.advanceTimersByTime(d - 1);
      expect(FakeSocket.instances.length).toBe(n);
      vi.advanceTimersByTime(1);
      expect(FakeSocket.instances.length).toBe(n + 1);
      last().open();
    }
  });

  it('resets the backoff after a successful ck', async () => {
    const svc = make();
    await connected(svc);
    for (const d of [1000, 2000]) {
      last().drop();
      vi.advanceTimersByTime(d);
      last().open();
    }
    last().receive({ t: 'ck', s: 'OK' });
    const n = FakeSocket.instances.length;
    last().drop();
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.instances.length).toBe(n + 1);
  });

  it('ck Not_Ok sets session-expired, closes, never reconnects, and rejects connect()', async () => {
    const svc = make();
    const p = svc.connect();
    const assertion = expect(p).rejects.toBeDefined();
    const sock = last();
    sock.open();
    sock.receive({ t: 'ck', s: 'Not_Ok' });
    await assertion;
    expect(svc.status()).toBe('session-expired');
    expect(sock.closed).toBe(true);
    const n = FakeSocket.instances.length;
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.instances.length).toBe(n);
    expect(svc.status()).toBe('session-expired');
  });

  it('sends {t:"h"} every 30 s while open and stops after close', async () => {
    const svc = make();
    await connected(svc);
    const hs = () => last().sent.filter((m) => m['t'] === 'h').length;
    vi.advanceTimersByTime(29_999);
    expect(hs()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(hs()).toBe(1);
    vi.advanceTimersByTime(30_000);
    expect(hs()).toBe(2);
    const sock = last();
    sock.drop();
    vi.advanceTimersByTime(25_000);
    expect(sock.sent.filter((m) => m['t'] === 'h').length).toBe(2);
  });

  it('honours a configured heartbeat interval', async () => {
    const svc = make({ heartbeatMs: 5000 });
    await connected(svc);
    vi.advanceTimersByTime(10_000);
    expect(last().sent.filter((m) => m['t'] === 'h').length).toBe(2);
  });

  it('does not send t before ck; sends once after ck', () => {
    const svc = make();
    void svc.connect();
    last().open();
    svc.subscribe(['NFO|1']);
    expect(last().tMsgs.length).toBe(0);
    last().receive({ t: 'ck', s: 'OK' });
    expect(last().tMsgs).toEqual([{ t: 't', k: 'NFO|1' }]);
  });

  it('emits parsed incoming messages on messages', async () => {
    const svc = make();
    const got: object[] = [];
    svc.messages.subscribe((m) => got.push(m));
    await connected(svc);
    last().receive({ t: 'tk', e: 'NFO', tk: '1', lp: '5' });
    expect(got).toContainEqual({ t: 'tk', e: 'NFO', tk: '1', lp: '5' });
  });

  it('send() writes JSON to the open socket', async () => {
    const svc = make();
    await connected(svc);
    svc.send({ t: 'foo' });
    expect(last().sent).toContainEqual({ t: 'foo' });
  });

  it('double connect() while connecting creates one socket and both promises resolve on ck', async () => {
    const svc = make();
    const p1 = svc.connect();
    const p2 = svc.connect();
    expect(FakeSocket.instances.length).toBe(1);
    last().open();
    last().receive({ t: 'ck', s: 'OK' });
    await Promise.all([p1, p2]);
    expect(svc.status()).toBe('open');
  });

  it('connect() while reconnecting cancels the retry timer, closes the old socket, keeps one live socket', async () => {
    const svc = make();
    await connected(svc);
    const first = last();
    first.drop();
    expect(svc.status()).toBe('reconnecting');
    const p = svc.connect();
    expect(FakeSocket.instances.length).toBe(2);
    const second = last();
    vi.advanceTimersByTime(60_000); // the old retry timer must not fire
    expect(FakeSocket.instances.length).toBe(2);
    second.open();
    second.receive({ t: 'ck', s: 'OK' });
    await p;
    expect(svc.status()).toBe('open');
    expect(FakeSocket.instances.filter((s) => s.readyState !== 3).length).toBe(1);
  });

  it('connect() while a reconnect socket is opening closes that socket', () => {
    const svc = make();
    void svc.connect().catch(() => undefined);
    last().open();
    last().drop();
    vi.advanceTimersByTime(1000); // retry opens socket #2 (status reconnecting)
    const retry = last();
    void svc.connect();
    expect(retry.closed).toBe(true);
    expect(FakeSocket.instances.length).toBe(3);
    expect(FakeSocket.instances.filter((s) => s.readyState !== 3).length).toBe(1);
  });

  it('close() rejects a pending connect()', async () => {
    const svc = make();
    const p = svc.connect();
    const assertion = expect(p).rejects.toThrow('Feed closed');
    svc.close();
    await assertion;
    expect(svc.status()).toBe('closed');
  });
});
