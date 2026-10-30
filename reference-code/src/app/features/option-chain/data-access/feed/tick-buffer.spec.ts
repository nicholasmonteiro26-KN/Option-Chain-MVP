import { defaultFrameScheduler, FLUSH_INTERVAL_MS, HIDDEN_FLUSH_DELAY_MS, TickBuffer } from './tick-buffer';

describe('TickBuffer', () => {
  it('merges partial tf without clearing missing fields', () => {
    const b = new TickBuffer(() => 1000);
    b.push({ t: 'tk', e: 'NFO', tk: '1', lp: '100', oi: '5000', bp1: '99.9' });
    b.push({ t: 'tf', e: 'NFO', tk: '1', lp: '101' });
    const out = b.drain().get('NFO|1')!;
    expect(out.ltp).toBe(101);
    expect(out.oi).toBe(5000);
    expect(out.bid).toBe(99.9);
    expect(out.token).toBe('NFO|1');
  });

  it('collapses two tf for the same key into one entry with the latest values', () => {
    const b = new TickBuffer();
    b.push({ t: 'tf', e: 'NFO', tk: '1', lp: '100', v: '10' });
    b.push({ t: 'tf', e: 'NFO', tk: '1', lp: '102' });
    const d = b.drain();
    expect(d.size).toBe(1);
    expect(d.get('NFO|1')!.ltp).toBe(102);
    expect(d.get('NFO|1')!.volume).toBe(10);
  });

  it('keeps the same token on different exchanges separate', () => {
    const b = new TickBuffer();
    b.push({ t: 'tf', e: 'NFO', tk: '1', lp: '1' });
    b.push({ t: 'tf', e: 'BFO', tk: '1', lp: '2' });
    const d = b.drain();
    expect(d.get('NFO|1')!.ltp).toBe(1);
    expect(d.get('BFO|1')!.ltp).toBe(2);
  });

  it('leaves absent fields absent (not undefined, not 0)', () => {
    const b = new TickBuffer();
    b.push({ t: 'tf', e: 'NFO', tk: '1', lp: '101' });
    const out = b.drain().get('NFO|1')!;
    expect(Object.keys(out).sort()).toEqual(['lastTickMs', 'ltp', 'token']);
  });

  it('maps every touchline field', () => {
    const b = new TickBuffer(() => 777);
    b.push({
      t: 'tk', e: 'NFO', tk: '9', lp: '1.5', bp1: '1.4', sp1: '1.6', bq1: '10', sq1: '20', v: '300',
      oi: '400', poi: '350', c: '1.2', o: '1.1', h: '1.7', l: '1.0', ls: '75', ti: '0.05',
    });
    expect(b.drain().get('NFO|9')).toEqual({
      token: 'NFO|9', ltp: 1.5, bid: 1.4, ask: 1.6, bidQty: 10, askQty: 20, volume: 300,
      oi: 400, prevOi: 350, prevClose: 1.2, open: 1.1, high: 1.7, low: 1.0, lotSize: 75,
      tickSize: 0.05, lastTickMs: 777,
    });
  });

  it('skips unparseable values', () => {
    const b = new TickBuffer();
    b.push({ t: 'tf', e: 'NFO', tk: '1', lp: 'abc', oi: '', v: '5' });
    const out = b.drain().get('NFO|1')!;
    expect('ltp' in out).toBe(false);
    expect('oi' in out).toBe(false);
    expect(out.volume).toBe(5);
  });

  it('stamps lastTickMs from the injected clock on every message', () => {
    let now = 100;
    const b = new TickBuffer(() => now);
    b.push({ t: 'tf', e: 'NFO', tk: '1', lp: '1' });
    now = 250;
    b.push({ t: 'tf', e: 'NFO', tk: '1', lp: '2' });
    expect(b.drain().get('NFO|1')!.lastTickMs).toBe(250);
  });

  it('drain clears the buffer', () => {
    const b = new TickBuffer();
    b.push({ t: 'tf', e: 'NFO', tk: '1', lp: '1' });
    expect(b.drain().size).toBe(1);
    expect(b.drain().size).toBe(0);
  });

  it('ignores messages that are not tk/tf', () => {
    const b = new TickBuffer();
    b.push({ t: 'ck', s: 'OK' });
    b.push({ t: 'hk' });
    b.push({ t: 'df', e: 'NFO', tk: '1', lp: '5' });
    expect(b.drain().size).toBe(0);
  });

  describe('flushOnAnimationFrame', () => {
    /** Fake clock + a frame queue: `frame(t)` advances the clock to t and runs the frames queued so far. */
    function setup(intervalMs?: number) {
      let now = 1000;
      let frames: (() => void)[] = [];
      const b = intervalMs === undefined
        ? new TickBuffer(() => now, (fn) => { frames.push(fn); })
        : new TickBuffer(() => now, (fn) => { frames.push(fn); }, intervalMs);
      const cb = vi.fn();
      b.flushOnAnimationFrame(cb);
      const frame = (t: number) => {
        now = t;
        const run = frames;
        frames = [];
        run.forEach((f) => f());
      };
      return { b, cb, frame, queued: () => frames.length };
    }

    it('throttles to FLUSH_INTERVAL_MS = 250 (≈ 4 flushes/s)', () => {
      expect(FLUSH_INTERVAL_MS).toBe(250);
    });

    it('schedules one frame per burst and delivers the merged batch', () => {
      const { b, cb, frame, queued } = setup();
      b.push({ t: 'tf', e: 'NFO', tk: '1', lp: '1' });
      b.push({ t: 'tf', e: 'NFO', tk: '1', lp: '2' });
      b.push({ t: 'tf', e: 'NFO', tk: '2', lp: '3' });
      expect(queued()).toBe(1);
      frame(1016);
      expect(cb).toHaveBeenCalledTimes(1);
      const batch = cb.mock.calls[0]![0] as Map<string, { ltp: number }>;
      expect(batch.size).toBe(2);
      expect(batch.get('NFO|1')!.ltp).toBe(2);
    });

    it('20 pushes within 250 ms flush once, then again on the first frame >= 250 ms later', () => {
      const { b, cb, frame } = setup();
      b.push({ t: 'tf', e: 'NFO', tk: '0', lp: '0' });
      frame(1000); // first flush at t=1000
      expect(cb).toHaveBeenCalledTimes(1);
      for (let i = 1; i <= 20; i++) {
        b.push({ t: 'tf', e: 'NFO', tk: String(i % 5), lp: String(i) });
        frame(1000 + i * 12); // frames up to t=1240: all too soon
      }
      expect(cb).toHaveBeenCalledTimes(1);
      frame(1249);
      expect(cb).toHaveBeenCalledTimes(1);
      frame(1250);
      expect(cb).toHaveBeenCalledTimes(2);
      const batch = cb.mock.calls[1]![0] as Map<string, { ltp: number }>;
      expect(batch.size).toBe(5); // merged per key
      expect(batch.get('NFO|0')!.ltp).toBe(20);
    });

    it('flushes at most once per 250 ms under a continuous 20 Hz stream', () => {
      const { b, cb, frame } = setup();
      for (let t = 1000; t < 3000; t += 16) {
        if ((t - 1000) % 48 === 0) b.push({ t: 'tf', e: 'NFO', tk: '1', lp: String(t) });
        frame(t);
      }
      // 2 s of frames: one flush per 250 ms window (at ~1000, 1256, 1512, ...): 8 flushes.
      expect(cb.mock.calls.length).toBe(8);
    });

    it('a quiet period lets the next push flush on its first frame', () => {
      const { b, cb, frame } = setup();
      b.push({ t: 'tf', e: 'NFO', tk: '1', lp: '1' });
      frame(1000);
      b.push({ t: 'tf', e: 'NFO', tk: '1', lp: '2' });
      frame(5000);
      expect(cb).toHaveBeenCalledTimes(2);
    });

    it('stops scheduling frames once nothing is pending', () => {
      const { b, frame, queued } = setup();
      b.push({ t: 'tf', e: 'NFO', tk: '1', lp: '1' });
      frame(1000);
      expect(queued()).toBe(0);
    });

    it('interval 0 delivers on every frame', () => {
      const { b, cb, frame } = setup(0);
      b.push({ t: 'tf', e: 'NFO', tk: '1', lp: '1' });
      frame(1000);
      b.push({ t: 'tf', e: 'NFO', tk: '1', lp: '2' });
      frame(1000);
      expect(cb).toHaveBeenCalledTimes(2);
    });

    it('does not schedule for ignored messages', () => {
      const { b, queued } = setup();
      b.push({ t: 'hk' });
      expect(queued()).toBe(0);
    });

    it('stops delivering after the returned disposer is called', () => {
      const frames: (() => void)[] = [];
      const b = new TickBuffer(() => 1, (fn) => { frames.push(fn); });
      const cb = vi.fn();
      const dispose = b.flushOnAnimationFrame(cb);
      b.push({ t: 'tf', e: 'NFO', tk: '1', lp: '1' });
      dispose();
      frames[0]?.();
      expect(cb).not.toHaveBeenCalled();
    });
  });
});

describe('defaultFrameScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses a 250 ms timer, not requestAnimationFrame, while the document is hidden', () => {
    vi.useFakeTimers();
    const raf = vi.fn();
    vi.stubGlobal('requestAnimationFrame', raf);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    const fn = vi.fn();
    defaultFrameScheduler(fn);
    expect(raf).not.toHaveBeenCalled();
    vi.advanceTimersByTime(HIDDEN_FLUSH_DELAY_MS - 1);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('uses requestAnimationFrame while visible', () => {
    const raf = vi.fn();
    vi.stubGlobal('requestAnimationFrame', raf);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    defaultFrameScheduler(() => undefined);
    expect(raf).toHaveBeenCalledTimes(1);
  });

  it('a hidden tab without rAF still flushes ticks into the callback (default TickBuffer)', () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', undefined);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    const b = new TickBuffer(() => 0);
    const got: string[] = [];
    b.flushOnAnimationFrame((batch) => got.push(...batch.keys()));
    b.push({ t: 'tk', e: 'NSE', tk: '26000', lp: '24010' });
    vi.advanceTimersByTime(HIDDEN_FLUSH_DELAY_MS);
    expect(got).toEqual(['NSE|26000']);
  });
});
