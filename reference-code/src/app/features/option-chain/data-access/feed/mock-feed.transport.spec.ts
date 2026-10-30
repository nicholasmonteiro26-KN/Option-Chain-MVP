import { MockFeedTransport } from './mock-feed.transport';

function lcg(seed = 1) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}

function setup(opts: { seedFn?: (k: string) => Record<string, string> | null } = {}) {
  const pending: { cb: () => void; ms: number; cancelled: boolean }[] = [];
  const scheduler = (cb: () => void, ms: number) => {
    const h = { cb, ms, cancelled: false };
    pending.push(h);
    return () => { h.cancelled = true; };
  };
  const fire = (ms: number) => {
    const due = pending.filter((p) => p.ms === ms && !p.cancelled);
    due.forEach((p) => { pending.splice(pending.indexOf(p), 1); p.cb(); });
  };
  const t = new MockFeedTransport({
    seed: opts.seedFn ?? (() => ({ lp: '100.00', ti: '0.05', ls: '75', v: '1000', oi: '5000' })),
    random: lcg(7),
    scheduler,
  });
  const msgs: Record<string, string>[] = [];
  t.messages.subscribe((m) => msgs.push(m as Record<string, string>));
  return { t, msgs, fire, pending };
}

describe('MockFeedTransport with a market tick hook', () => {
  it('acks with the seed as-is and emits the hook\'s messages on each tick instead of the generic walk', async () => {
    const pending: { cb: () => void; ms: number }[] = [];
    let spot = 100;
    const hook = vi.fn((keys: readonly string[], random: () => number) => {
      spot += 1;
      return keys.map((k) => ({ t: 'tf', e: k.split('|')[0]!, tk: k.split('|')[1]!, lp: spot.toFixed(2), r: String(random() < 2) }));
    });
    const t = new MockFeedTransport({
      seed: () => ({ lp: spot.toFixed(2), c: '99.00' }),
      marketTick: hook,
      random: lcg(3),
      scheduler: (cb, ms) => { pending.push({ cb, ms }); return () => undefined; },
    });
    const msgs: Record<string, string>[] = [];
    t.messages.subscribe((m) => msgs.push(m as Record<string, string>));
    await t.connect();
    t.subscribe(['NSE|26000']);
    expect(msgs).toEqual([{ lp: '100.00', c: '99.00', t: 'tk', e: 'NSE', tk: '26000' }]);
    pending.shift()!.cb();
    expect(hook).toHaveBeenCalledWith(['NSE|26000'], expect.any(Function));
    expect(msgs[1]).toEqual({ t: 'tf', e: 'NSE', tk: '26000', lp: '101.00', r: 'true' });
    t.drop();
    pending.find((p) => p.ms === 1000)!.cb();
    expect(msgs[2]).toMatchObject({ t: 'tk', lp: '101.00' }); // re-ack reflects the market's current state
  });
});

describe('MockFeedTransport.close', () => {
  it('cancels the tick loop and any pending reopen, and reports closed', async () => {
    const pending: { cb: () => void; ms: number; cancelled: boolean }[] = [];
    const t = new MockFeedTransport({
      seed: () => ({ lp: '100.00' }),
      scheduler: (cb, ms) => { const h = { cb, ms, cancelled: false }; pending.push(h); return () => { h.cancelled = true; }; },
    });
    const msgs: object[] = [];
    t.messages.subscribe((m) => msgs.push(m));
    await t.connect();
    t.subscribe(['NSE|26000']);
    t.drop();
    t.close();
    expect(t.status()).toBe('closed');
    expect(pending.every((p) => p.cancelled)).toBe(true);
    pending.forEach((p) => p.cb()); // even a timer that fires late does nothing
    expect(t.status()).toBe('closed');
    expect(msgs).toHaveLength(1); // only the initial ack
  });
});

describe('MockFeedTransport', () => {
  it('connect resolves immediately and status is open', async () => {
    const { t } = setup();
    await t.connect();
    expect(t.status()).toBe('open');
  });

  it('emits a tk ack from seed(key) for each new key only', async () => {
    const { t, msgs } = setup();
    await t.connect();
    t.subscribe(['NFO|1', 'BFO|2']);
    expect(msgs.map((m) => [m['t'], m['e'], m['tk'], m['lp']])).toEqual([
      ['tk', 'NFO', '1', '100.00'], ['tk', 'BFO', '2', '100.00'],
    ]);
    t.subscribe(['NFO|1']);
    expect(msgs.length).toBe(2);
  });

  it('emits no ack when seed returns null', async () => {
    const { t, msgs } = setup({ seedFn: () => null });
    await t.connect();
    t.subscribe(['NFO|1']);
    expect(msgs.length).toBe(0);
  });

  it('ticks at the configured rate (default 20 Hz = 50 ms) and emits tf for subscribed keys', async () => {
    const { t, msgs, fire, pending } = setup();
    await t.connect();
    t.subscribe(['NFO|1']);
    expect(pending.some((p) => p.ms === 50)).toBe(true);
    msgs.length = 0;
    for (let i = 0; i < 10; i++) fire(50);
    expect(msgs.length).toBe(10);
    expect(msgs.every((m) => m['t'] === 'tf' && m['e'] === 'NFO' && m['tk'] === '1')).toBe(true);
  });

  it('emits partial tf: sometimes lp only, sometimes with v and oi, and lp changes', async () => {
    const { t, msgs, fire } = setup();
    await t.connect();
    t.subscribe(['NFO|1']);
    msgs.length = 0;
    for (let i = 0; i < 200; i++) fire(50);
    const keysOf = (m: object) => Object.keys(m).filter((k) => !['t', 'e', 'tk'].includes(k)).sort().join(',');
    const shapes = new Set(msgs.map(keysOf));
    expect(shapes.has('lp')).toBe(true);
    expect([...shapes].some((s) => s.includes('v'))).toBe(true);
    expect([...shapes].some((s) => s.includes('oi'))).toBe(true);
    const lps = new Set(msgs.map((m) => m['lp']));
    expect(lps.size).toBeGreaterThan(5);
    expect(msgs.every((m) => Number(m['lp']) > 0)).toBe(true);
  });

  it('emits nothing when there are no subscriptions or after full unsubscribe', async () => {
    const { t, msgs, fire } = setup();
    await t.connect();
    fire(50);
    t.subscribe(['NFO|1']);
    t.unsubscribe(['NFO|1']);
    msgs.length = 0;
    fire(50); fire(50);
    expect(msgs.length).toBe(0);
  });

  it('ref-counts: key stays active until all subscribers unsubscribe', async () => {
    const { t, msgs, fire } = setup();
    await t.connect();
    t.subscribe(['NFO|1']);
    t.subscribe(['NFO|1']);
    t.unsubscribe(['NFO|1']);
    msgs.length = 0;
    fire(50);
    expect(msgs.length).toBe(1);
  });

  it('drop() sets reconnecting, goes quiet, then returns to open after 1 s and re-acks', async () => {
    const { t, msgs, fire } = setup();
    await t.connect();
    t.subscribe(['NFO|1']);
    msgs.length = 0;
    t.drop();
    expect(t.status()).toBe('reconnecting');
    fire(50);
    expect(msgs.length).toBe(0);
    fire(1000);
    expect(t.status()).toBe('open');
    expect(msgs.map((m) => m['t'])).toEqual(['tk']);
    msgs.length = 0;
    fire(50);
    expect(msgs.length).toBe(1);
    expect(msgs[0]!['t']).toBe('tf');
  });

  it('re-ack after drop() carries the drifted lp/v/oi, not the original seed', async () => {
    const { t, msgs, fire } = setup();
    await t.connect();
    t.subscribe(['NFO|1']);
    msgs.length = 0;
    for (let i = 0; i < 60; i++) fire(50);
    const lastLp = [...msgs].reverse().find((m) => m['lp'])!['lp'];
    const lastV = [...msgs].reverse().find((m) => m['v'])!['v'];
    const lastOi = [...msgs].reverse().find((m) => m['oi'])!['oi'];
    expect(lastLp).not.toBe('100.00');
    msgs.length = 0;
    t.drop();
    fire(1000);
    expect(msgs[0]!['t']).toBe('tk');
    expect(msgs[0]!['lp']).toBe(lastLp);
    expect(msgs[0]!['v']).toBe(lastV);
    expect(msgs[0]!['oi']).toBe(lastOi);
  });

  it('logs t/u wire messages for keys going 0 -> 1 and 1 -> 0 while open', async () => {
    const { t } = setup();
    await t.connect();
    t.subscribe(['NFO|1', 'NFO|2']);
    t.subscribe(['NFO|1']);
    t.unsubscribe(['NFO|1']);
    t.unsubscribe(['NFO|1', 'NFO|2']);
    expect(t.sent).toEqual([{ t: 't', k: 'NFO|1#NFO|2' }, { t: 'u', k: 'NFO|1#NFO|2' }]);
    expect(t.subscribedKeys()).toEqual([]);
  });

  it('subscriptionLimit: keys beyond the limit are not acked and limitReached reports the limit', async () => {
    const pending: (() => void)[] = [];
    const t = new MockFeedTransport({
      seed: () => ({ lp: '1' }), subscriptionLimit: 2,
      scheduler: (cb) => { pending.push(cb); return () => undefined; },
    });
    const msgs: Record<string, string>[] = [];
    t.messages.subscribe((m) => msgs.push(m as Record<string, string>));
    await t.connect();
    expect(t.limitReached()).toBeNull();
    t.subscribe(['NFO|1', 'NFO|2', 'NFO|3']);
    expect(msgs.map((m) => m['tk'])).toEqual(['1', '2']);
    expect(t.subscribedKeys()).toEqual(['NFO|1', 'NFO|2']);
    expect(t.limitReached()).toBe(2);
    t.unsubscribe(['NFO|1']);
    t.subscribe(['NFO|3']);
    expect(t.subscribedKeys()).toEqual(['NFO|2', 'NFO|3']);
  });

  it('limitReportDelayMs reports the limit later via the scheduler; expireSession sets session-expired', async () => {
    const pending: { cb: () => void; ms: number }[] = [];
    const t = new MockFeedTransport({
      seed: () => ({ lp: '1' }), subscriptionLimit: 1, limitReportDelayMs: 7,
      scheduler: (cb, ms) => { pending.push({ cb, ms }); return () => undefined; },
    });
    await t.connect();
    t.subscribe(['NFO|1', 'NFO|2', 'NFO|3']);
    expect(t.limitReached()).toBeNull();
    const report = pending.filter((p) => p.ms === 7);
    expect(report).toHaveLength(1);
    report[0]!.cb();
    expect(t.limitReached()).toBe(1);
    t.expireSession();
    expect(t.status()).toBe('session-expired');
  });
});
