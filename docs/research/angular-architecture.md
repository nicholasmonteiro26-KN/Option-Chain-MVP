# Option Chain: Angular Architecture Research

**Scope:** desktop web only (web.tradesmartonline.in), Ionic + Angular.
**Status:** research and recommendation. The tech team must confirm the items in section 0.
**Date:** 2026-10-29

---

## 0. Version baseline and decisions that need the tech team

### Ecosystem facts as of October 2026 (verified)

| Item | Fact | Source |
|---|---|---|
| Angular | v22 shipped June 2026. Components that don't declare a strategy now default to **OnPush**. Signal Forms are stable. | [cmarix](https://www.cmarix.com/blog/latest-angular-version/), [Ionic 9 blog](https://ionic.io/blog/?p=6843) |
| Zoneless | Stable since v20.2. New apps are zoneless by default since v21 (Zone.js is no longer included). | [Angular in Depth: 20.2](https://angularindepth.com/article/ng-news-25-34-angular-20-2/), [InfoWorld](https://www.infoworld.com/article/4050950/zoneless-angular-arrives-in-angular-20-2.html), [pkgpulse](https://www.pkgpulse.com/guides/angular-21-zoneless-zone-js-performance-2026) |
| Ionic | **Ionic 9** shipped 19 Aug 2026 (latest patch 9.0.7). It supports Angular 18–22 and is zoneless by default. `@ionic/angular/standalone` imports move to `@ionic/angular`. Ionic 8 does **not** support Angular 22, because Angular 22 needs TypeScript 6. | [Ionic blog](https://ionic.io/blog/?p=6843), [Ionic 9 upgrade guide](https://ionicframework.com/docs/updating/9-0), [Ionic zoneless docs](https://ionicframework.com/docs/angular/zoneless), [versio.io EOL](https://www.versio.io/de/product-release-end-of-life-eol-ionic-ionic-framework.html), [Ionic support policy](https://ionicframework.com/docs/intro/support) |
| Unit test runner | Vitest has been the Angular CLI default for new projects since v21. Karma is still selectable, and a `refactor-jasmine-vitest` schematic exists. | [angular.dev migrating to Vitest](https://angular.dev/guide/testing/migrating-to-vitest), [Angular in Depth](https://angularindepth.com/article/ng-news-25-43-vitest-angulars-new-testing-framework/) |
| AG Grid | v36.1 (Aug 2026). Requires Angular 20 or later and TypeScript 5.8.3 or later. Community is MIT. Enterprise needs a commercial EULA with per-developer, perpetual licences that include one year of updates. Without a key, Enterprise shows a watermark. | [AG Grid community vs enterprise](https://www.ag-grid.com/javascript-data-grid/community-vs-enterprise.md), [licensing](https://www.ag-grid.com/react-grid/licensing/), [compatibility](https://ag-grid.com/angular-data-grid/compatibility/), [changelog](https://www.ag-grid.com/changelog.md) |
| NgRx | v20 ships a mature SignalStore, with `withEntities` in `@ngrx/signals/entities`. I could not confirm v21 or v22 release notes. | [NgRx v20 announcement](https://dev.to/ngrx/announcing-ngrx-v20-the-power-of-events-enhanced-dx-and-a-mature-signalstore-2fdm) |

The brief said to assume Ionic 8, but **Ionic 9 + Angular 21/22 is the current stable pair**. This design runs on Ionic 8 + Angular 20/21 or on Ionic 9 + Angular 22 without changes. It uses only standalone components, signals and `@for`, and nothing in it depends on Zone.js.

### Decisions the tech team must make

1. **Angular and Ionic versions in the existing web app, and whether it runs on Zone.js.** If it uses Zone.js, the feed must run outside NgZone (see §2.3). Zoneless is the better target but is not required.
2. **Existing state library.** If the app already uses NgRx Store, we use NgRx SignalStore for this feature. Otherwise we use a plain signal service. Both are shown in §2.
3. **Existing socket service.** Does the app already have a single Kambala `NorenWS` connection shared with watchlist, orders and positions? If yes, the option chain must **share** that connection through a ref-counted subscription registry (§3.4) and must not open a second socket. The broker may also limit sockets per session.
4. **Analytics library packaging.** Is the IV/Greeks/MaxPain/PCR/GEX library an internal npm package or source in this repo? This decides how the worker imports it.
5. **Preferences backend.** Does an endpoint exist for user settings? If not, use localStorage for v1 (§5).
6. **Test stack.** Is the app on Karma/Jasmine, Jest, or Vitest? Section 6 recommends Vitest.
7. **AG Grid.** Does the company already own AG Grid Enterprise licences? This changes the cost side of §1, but not the recommendation.

---

## 1. Grid choice

### What we are rendering

* Rows are strikes: 4 to 64, or "All". "All" for NIFTY weekly can be 150 or more strikes.
* Columns are up to 20 calls + 1 strike + up to 20 puts, so about 41.
* Worst case is about 150 × 41 ≈ **6,000 cells**. That is a small DOM. The hard part is not volume. It is:
  * a **frozen centre column**, the strike, with scrolling content on both sides that mirror each other;
  * an inserted **spot separator row** that moves between strikes;
  * **flash-on-change** for hundreds of cells per second;
  * **OI bar-in-cell** visuals, a **Σ footer**, and **hover action buttons** per row per side;
  * **presets**: whole column sets swap instantly.

### Options compared

| Criterion | Custom `<table>`/CSS grid (+ optional CDK virtual scroll) | AG Grid Community (MIT) | AG Grid Enterprise | Others (PrimeNG Table, TanStack Table, Handsontable, Kendo/Syncfusion) |
|---|---|---|---|---|
| Licence and cost | Free | Free (MIT) | About $1k per developer per year-equivalent, perpetual licence + 1 year of updates. Watermark without a key. | PrimeNG MIT. TanStack MIT (headless). Handsontable, Kendo and Syncfusion are commercial. |
| Centre-frozen strike column | Easy: `position: sticky` on the middle column with `left` and `right` offsets, or a three-pane layout | **Not native.** Pinning is left or right only. Workarounds are two synchronised grids or pinning the strike left and changing the layout. | Same limitation | PrimeNG: frozen columns left or right only. TanStack: anything you build. |
| Spot separator row | Ordinary `@if` row between strikes | Needs a fake row object or `isFullWidthRow`. Position changes reorder the rowData. | Same | Varies |
| Cell flash | Our own directive using the Web Animations API (§2.5) | Built in: `enableCellChangeFlash` / `flashCells()`, Community | Same | PrimeNG: none built in |
| CSV export | About 40 lines of our code, because we control the column model | `exportDataAsCsv()`, Community | + Excel export (Enterprise) | Varies |
| Column chooser and reorder UI | Our own (CDK drag-drop list) | Column drag in the header is Community. The **Columns tool panel is Enterprise.** | Built in | Varies |
| Throughput | Optimal with fine-grained signals: only changed cells touch the DOM | Very good with `applyTransactionAsync` and `getRowId`, and batching built in | Same | PrimeNG struggles with high-frequency updates. TanStack is fine because it is headless. |
| Bundle size | About 0 kB extra (+ CDK if virtual scroll) | Large (about 300 kB+ minified, tree-shakable by modules) | Larger | Medium |
| Look and feel | Exactly the TradeSmart design | Theme API, but it always feels like a spreadsheet unless heavily customised | Same | PrimeNG themes |
| Learning and maintenance | We own the code (about 1.5–2k LOC) | Big API, version churn (v31 → v36 had several breaking changes) | Same | — |

### Recommendation: custom component (native `<table>` + sticky CSS), with CDK virtual scroll only for "All"

Reasons:

1. **The layout is the product.** A mirrored two-sided chain with a centre strike, a moving spot line and per-side hover actions is not a generic data grid. AG Grid cannot pin a column in the centre. Every alternative (two grids with synchronised scroll, or full-width fake rows) costs more than writing the table.
2. **6k cells do not need a virtualising grid engine.** Up to 64 strikes (about 2.6k cells), render everything. Virtualisation adds scroll jank with sticky headers and breaks Ctrl+F and screen readers for little gain.
3. **Flash and live updates are where a custom component wins.** With per-row signals (§2), a tick for one token re-renders only that token's row cells. That is the same minimal DOM work AG Grid's transaction API achieves, without the adapter layer.
4. **No licence or audit exposure**, and none of the Enterprise-only gaps: the tool panel for the Custom column chooser and Excel export are both Enterprise.
5. AG Grid Community stays the **fallback** if the team wants a generic grid elsewhere in the app. If chosen, use `getRowId: p => p.data.strike`, `applyTransactionAsync`, `asyncTransactionWaitMillis: 100`, and `enableCellChangeFlash` per column. Accept a strike pinned **left** instead of centre, or use two grids.

**When "All" is selected (more than about 80 rows):** wrap the body in `cdk-virtual-scroll-viewport` with `FixedSizeVirtualScrollStrategy` (row height 28 px). Render the separator row as a **row of the same height** inside the virtualised list, so the fixed size stays valid. Sticky `<thead>` does not work inside the viewport. Put the header in a separate table above, with an identical `<colgroup>`, and sync `scrollLeft`. An alternative for "All" is to keep a full render (150 × 41 is still fine on desktop) and measure first. **Suggested rule: ship without virtualisation. Add CDK only if profiling on a mid-range laptop shows more than 8 ms per frame during flush.**

### Component sketch

```html
<!-- option-chain-table.component.html -->
<div class="oc-scroll" #scroller>
  <table class="oc" [style.--call-cols]="callCols().length" [style.--put-cols]="putCols().length">
    <colgroup>
      @for (c of callCols(); track c.id) { <col [style.width.px]="c.width" /> }
      <col class="strike-col" />
      @for (c of putCols(); track c.id) { <col [style.width.px]="c.width" /> }
    </colgroup>
    <thead>
      <tr>
        @for (c of callCols(); track c.id) { <th [class]="c.align">{{ c.label }}</th> }
        <th class="strike sticky-centre">Strike</th>
        @for (c of putCols(); track c.id) { <th [class]="c.align">{{ c.label }}</th> }
      </tr>
    </thead>
    <tbody>
      @for (row of rows(); track row.strike) {
        @if (row.strike === separatorAfter()) {
          <tr class="spot-sep"><td [attr.colspan]="totalCols()">
            <span class="spot-pill">{{ spot() | number:'1.2-2' }}</span></td></tr>
        }
        <tr oc-row [row]="row" [callCols]="callCols()" [putCols]="putCols()"
            [class.itm-call]="row.strike < spot()" [class.itm-put]="row.strike > spot()"></tr>
      }
    </tbody>
    <tfoot>
      <tr oc-sum-row [totals]="totals()" [callCols]="callCols()" [putCols]="putCols()"></tr>
    </tfoot>
  </table>
</div>
```

```scss
.oc-scroll { overflow: auto; max-height: calc(100vh - var(--oc-top)); contain: strict; }
.oc { border-collapse: separate; border-spacing: 0; font-variant-numeric: tabular-nums; table-layout: fixed; }
.oc thead th { position: sticky; top: 0; z-index: 2; }
.oc tfoot td { position: sticky; bottom: 0; z-index: 2; }
/* centre strike: sticky to both edges so it stays visible during horizontal scroll */
.oc .sticky-centre { position: sticky; left: calc(50% - 40px); right: calc(50% - 40px); z-index: 3; }
.oc tr { height: 28px; }
.oc td.oi { background: linear-gradient(to left, var(--oi-bar) var(--pct), transparent var(--pct)); }
.oc tr .actions { visibility: hidden; }
.oc tr:hover .actions, .oc tr:focus-within .actions { visibility: visible; } /* keyboard-reachable too */
```

The OI bar is a CSS custom property (`[style.--pct.%]="oiPct"`), so updating it is only a style write: no extra DOM and no layout.

---

## 2. Change detection and state

### 2.1 Principles

* **Signals for view state, RxJS only at the edges.** RxJS handles the socket stream, reconnect timers and debouncing. Signals hold everything the template reads. Bridge the two with a manual buffer flush, not `toSignal` on the raw tick stream. That would trigger change detection per tick.
* **Zoneless** (`provideZonelessChangeDetection()`, the default in v21+, and the Ionic 9 default). Signal writes schedule change detection automatically, and socket `onmessage` triggers nothing by itself.
* **OnPush everywhere.** This is the default in v22. Declare it explicitly for older versions.
* **`@for (...; track row.strike)` / `track col.id`.** Never track `$index` for rows, because the strike window shifts.
* **Fine-grained rows:** one `WritableSignal<RowVM>` per strike. A tick on one token updates one signal, and only that row's embedded view is checked. Under zoneless + OnPush, Angular checks only views whose signals changed.

### 2.2 Store shape (normalised by token)

```ts
// data-access/models.ts
export type Token = string;                    // Kambala 'tk', e.g. "43567"
export interface Quote {                       // raw touchline, numbers parsed
  tk: Token; lp: number; pc: number; v: number; o: number; h: number; l: number; c: number;
  ap: number; oi: number; poi: number; bp1: number; sp1: number; bq1: number; sq1: number;
  ft: number; recvTs: number;                  // recvTs = performance.now() on arrival
}
export interface Analytics { iv: number; delta: number; gamma: number; theta: number; vega: number; }
export interface ChainMeta {                   // instrument master for one expiry
  underlying: string; expiry: string; lotSize: number;
  strikes: number[];                           // sorted asc
  byStrike: Record<number, { ce: Token; pe: Token }>;
}
export interface Aggregates { pcr: number; maxPain: number; gex: number; atmIv: number;
  totalCallOi: number; totalPutOi: number; computedAt: number; }

export interface OptionChainState {
  underlying: string;
  expiry: string | null;
  expiries: string[];
  strikeCount: 4 | 6 | 8 | 16 | 32 | 40 | 64 | 'all';
  meta: ChainMeta | null;
  spot: number;                                 // underlying LTP
  quotes: Map<Token, Quote>;                    // NOT read by templates directly
  analytics: Map<Token, Analytics>;
  aggregates: Aggregates | null;
  feed: 'connecting' | 'live' | 'stale' | 'reconnecting' | 'closed';
}
```

### 2.3 Flow: socket → tick buffer → store → worker → view model

```
Kambala WS (onmessage, outside Angular CD)
   │  JSON.parse, t==='tf'|'tk'
   ▼
TickBuffer  (Map<token, Partial<Quote>>; merges partials, last write wins per field)
   │  flush on requestAnimationFrame, capped at UI_HZ (default 4 Hz = 250 ms; configurable)
   ▼
ChainStore.applyTicks(batch)
   ├─ merge into quotes Map (mutable, no copies)
   ├─ for each affected strike → rowSignal.set(buildRowVM(...))   ← only changed rows re-render
   ├─ spot.set(...) if underlying token in batch
   └─ markDirtyForAnalytics()
   ▼
AnalyticsBridge (throttle 1000 ms, skip if a job in flight)
   │  postMessage(Float64Array columns, transferable)
   ▼
Web Worker: IV solver, Greeks, MaxPain, PCR, GEX
   │  postMessage(result typed arrays, transferable)
   ▼
ChainStore.applyAnalytics(result) → analytics Map + aggregates signal → affected rowSignals
   ▼
computed(): rows(), totals(), separatorAfter(), headerStats()  → template
```

Why cap the UI at about 4 Hz instead of 60 Hz: traders cannot read a number changing 60 times a second. Flashes need about 300–500 ms to be perceptible, and a 250 ms flush halves CPU on low-end laptops. rAF alignment still matters, so that the flush lands just before paint and never mid-frame. Make `UI_HZ` a constant. Product can tune it.

If the host app still uses **Zone.js**, create the socket inside `ngZone.runOutsideAngular(() => new WebSocket(url))`. Signal writes in `flush()` still schedule change detection correctly. Since v18, the hybrid scheduler reacts to signals even outside the zone.

### 2.4 Store implementation

**Option A: plain signal service (recommended unless the app already uses NgRx).**

```ts
// data-access/option-chain.store.ts
@Injectable()   // provided at the feature route, so it is destroyed when the user leaves the screen
export class OptionChainStore {
  private readonly quotes = new Map<Token, Quote>();
  private readonly analytics = new Map<Token, Analytics>();
  private readonly rowSignals = new Map<number, WritableSignal<RowVM>>();

  readonly meta = signal<ChainMeta | null>(null);
  readonly spot = signal(0);
  readonly strikeCount = signal<StrikeCount>(16);
  readonly aggregates = signal<Aggregates | null>(null);
  readonly feed = signal<FeedState>('connecting');
  private readonly rowsVersion = signal(0);   // bumps only when the strike *set* changes

  /** Strikes visible for current spot & strikeCount (ATM-centred). */
  readonly visibleStrikes = computed(() => {
    const m = this.meta(); if (!m) return [];
    const n = this.strikeCount(); const s = this.atmStrike();
    if (n === 'all') return m.strikes;
    const i = m.strikes.indexOf(s);
    return m.strikes.slice(Math.max(0, i - n / 2), i + n / 2 + 1);
  });
  // ATM recomputes only when spot crosses a strike boundary → equal fn suppresses churn
  readonly atmStrike = computed(() => nearest(this.meta()?.strikes ?? [], this.spot()), { equal: (a, b) => a === b });

  readonly rows = computed(() => { this.rowsVersion(); return this.visibleStrikes().map(k => this.rowSig(k)); });
  readonly separatorAfter = computed(() => lastStrikeBelow(this.visibleStrikes(), this.spot()));

  applyTicks(batch: Map<Token, Partial<Quote>>, tokenToStrike: Map<Token, number>, spotToken: Token) {
    const touched = new Set<number>();
    for (const [tk, patch] of batch) {
      const prev = this.quotes.get(tk);
      this.quotes.set(tk, prev ? Object.assign(prev, patch) : (patch as Quote));
      if (tk === spotToken && patch.lp != null) this.spot.set(patch.lp);
      const k = tokenToStrike.get(tk); if (k != null) touched.add(k);
    }
    for (const k of touched) this.rowSig(k).set(this.buildRow(k));   // new object → row view re-checks
  }

  applyAnalytics(r: AnalyticsResult) { /* fill analytics Map, aggregates.set(r.agg), touch rows */ }
  private rowSig(k: number) { let s = this.rowSignals.get(k); if (!s) this.rowSignals.set(k, s = signal(this.buildRow(k))); return s; }
  private buildRow(k: number): RowVM { /* join quotes + analytics + prev values for flash direction */ }
}
```

The template reads `row()` inside an `oc-row` component (`input.required<Signal<RowVM>>()`), so a row's view depends only on its own signal.

**Option B: NgRx SignalStore**, if the app already uses NgRx. Use `signalStore(withState(...), withEntities<Quote>(), withComputed(...), withMethods(...))`. Caveat: `withEntities` stores entities immutably, so `updateEntities` on every flush creates new arrays and maps. That is fine at 4 Hz × about 300 tokens but not at 60 Hz. Keep **per-row signals** as above for the hot path, and put only meta, prefs, aggregates and feed status in SignalStore. **Avoid classic NgRx Store (actions/reducers) for ticks.** Dispatching an action per tick, or even per flush, plus selector memoisation across 300 entities is pure overhead here.

### 2.5 Flash animation without change detection

Do not drive the flash through bound classes and `setTimeout`. That causes a second change detection pass per cell. Use a directive that compares values in an `effect` and calls the Web Animations API, which is compositor-friendly:

```ts
@Directive({ selector: '[ocFlash]' })
export class FlashDirective {
  readonly ocFlash = input.required<number | undefined>();
  private el = inject(ElementRef<HTMLElement>).nativeElement;
  private prev: number | undefined;
  private reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  constructor() {
    effect(() => {
      const v = this.ocFlash();
      if (this.prev !== undefined && v !== undefined && v !== this.prev) {
        const up = v > this.prev;
        this.el.animate(
          [{ backgroundColor: up ? 'var(--flash-up)' : 'var(--flash-down)' }, { backgroundColor: 'transparent' }],
          { duration: this.reduced ? 1 : 600, easing: 'ease-out' });
      }
      this.prev = v;
    });
  }
}
```

Use it as `<td [ocFlash]="r.ce.lp">`. Flash only price, OI and volume columns, which are configurable per column definition (`flash: true`). Text colour (green or red relative to the previous close) is a static class, not an animation.

---

## 3. WebSocket service design (Kambala NorenWS)

The protocol comes from the Kambala API document in this repo (`Kambala API Doc (2).md`, "WebSocket API"):

| Purpose | Send | Receive |
|---|---|---|
| Connect | `{t:'c', uid, actid, source:'WEB', susertoken}` | `{t:'ck', s:'Ok'\|'Not_Ok'}` |
| Subscribe touchline | `{t:'t', k:'NFO\|43567#NFO\|43568#NSE\|26000'}` | One `{t:'tk', e, tk, ts, ls, ti, pp, lp, oi, …}` per token (full snapshot) |
| Updates | — | `{t:'tf', e, tk, …partial fields}`. Only `t`, `e` and `tk` are guaranteed. |
| Unsubscribe | `{t:'u', k:'…'}` | `{t:'uk', k}` |
| Heartbeat | `{t:'h'}` | `{t:'hk', ft}` |

All values arrive as **strings**. Parse them once in the merge step. The document notes that an ATO price is sent as `"42949672.95"`. Treat that value as "no price".

### 3.1 Responsibilities

* A single connection per app session, as a root-provided `NorenSocketService`. Feature code never calls `new WebSocket`.
* A ref-counted subscription registry, so that the option chain, watchlist and other screens can share tokens.
* A transport interface, so a **mock feed** can be swapped in for demos, tests and e2e (§6).

```ts
// data-access/feed/transport.ts
export interface FeedTransport {
  connect(): void; close(): void; send(msg: object): void;
  readonly messages$: Observable<NorenMsg>;
  readonly state$: Observable<'open' | 'closed'>;
}
export const FEED_TRANSPORT = new InjectionToken<FeedTransport>('FEED_TRANSPORT');
```

### 3.2 Connect, auth, heartbeat, reconnect

```ts
@Injectable({ providedIn: 'root' })
export class NorenSocketService {
  private t = inject(FEED_TRANSPORT);
  private session = inject(SessionService);          // existing app login: uid, actid, susertoken
  readonly status = signal<'connecting'|'live'|'reconnecting'|'auth-failed'|'closed'>('closed');
  private refCount = new Map<string, number>();        // 'NFO|43567' → n
  private attempt = 0;
  private hbTimer?: number; private lastMsgAt = 0;

  readonly ticks$ = this.t.messages$.pipe(filter(m => m.t === 'tf' || m.t === 'tk'), share());

  start() {
    this.status.set('connecting');
    this.t.state$.subscribe(s => s === 'open' ? this.onOpen() : this.onClose());
    this.t.messages$.subscribe(m => {
      this.lastMsgAt = performance.now();
      if (m.t === 'ck') m.s === 'Ok' ? this.onAuthed() : this.status.set('auth-failed');
    });
    this.t.connect();
  }
  private onOpen() {
    const { uid, actid, token } = this.session.current();
    this.t.send({ t: 'c', uid, actid, source: 'WEB', susertoken: token });
  }
  private onAuthed() {
    this.attempt = 0; this.status.set('live');
    const all = [...this.refCount.keys()];
    for (const chunk of chunks(all, 200)) this.t.send({ t: 't', k: chunk.join('#') }); // resubscribe
    this.startHeartbeat();
  }
  private onClose() {
    clearInterval(this.hbTimer);
    if (this.status() === 'auth-failed') return;             // session expired → app re-login flow
    this.status.set('reconnecting');
    const delay = Math.min(30_000, 500 * 2 ** this.attempt++) * (0.5 + Math.random()); // full jitter
    setTimeout(() => this.t.connect(), delay);
  }
  private startHeartbeat() {
    this.hbTimer = window.setInterval(() => {
      this.t.send({ t: 'h' });
      if (performance.now() - this.lastMsgAt > 15_000) this.t.close();  // dead socket → reconnect
    }, 5_000);
  }
  // pause reconnect loop while offline / tab hidden long; resume on 'online' & 'visibilitychange'
```

Notes:

* Confirm the heartbeat interval with Kambala or TradeSmart backend. The document does not specify one. Start at 5 s for sending, and treat 15 s of silence as dead.
* Background tabs throttle timers to about once a minute. On `visibilitychange → visible`, check `lastMsgAt` immediately and force a reconnect if the connection is stale.
* On `ck: Not_Ok`, do **not** retry in a loop. Emit to the app's session-expired handler.

### 3.3 Subscribe and unsubscribe diffing

When the expiry, strike window or underlying changes, compute the desired token set and diff it against the current one:

```ts
// option-chain feature side
private current = new Set<string>();
syncSubscriptions(desired: Set<string>) {
  const add = [...desired].filter(k => !this.current.has(k));
  const remove = [...this.current].filter(k => !desired.has(k));
  this.socket.subscribe(add);     // ref-count++; sends {t:'t'} only for 0→1 transitions
  this.socket.unsubscribe(remove);// ref-count--; sends {t:'u'} only for 1→0 transitions
  this.current = desired;
}
// effect(() => this.syncSubscriptions(tokensFor(store.meta(), store.visibleStrikes(), bufferStrikes = 4)))
```

* Subscribe to the **visible window plus a buffer** of ±4 strikes, so that ATM drift does not cause churn. Debounce window changes by 300 ms, because the strike window moves with spot.
* Max Pain, PCR and GEX need **all strikes' OI**, not just the visible ones. Choose one of these:
  (a) subscribe to all strikes of the expiry, which is about 2 × 150 tokens and acceptable; or
  (b) get OI for non-visible strikes from a periodic REST snapshot, such as `GetQuotes` per token every 30–60 s, or an option-chain endpoint if TradeSmart has one.
  **Recommend (a) for v1 and measure.** It is the simplest and the most correct. **Ask the backend whether there is a per-session token limit.**
* Batch the `k` lists, for example 200 tokens per message. Ask Kambala for the max message length.

### 3.4 Merging partial updates and stale detection

```ts
// data-access/feed/tick-buffer.ts
const NUM = new Set(['lp','pc','v','o','h','l','c','ap','oi','poi','toi','bp1','sp1','bq1','sq1','ft']);
export class TickBuffer {
  private pending = new Map<Token, Partial<Quote>>();
  private scheduled = false; private lastFlush = 0;
  constructor(private onFlush: (b: Map<Token, Partial<Quote>>) => void, private minIntervalMs = 250) {}
  push(m: Record<string, string>) {
    let p = this.pending.get(m['tk']); if (!p) this.pending.set(m['tk'], p = { tk: m['tk'] });
    for (const k in m) if (NUM.has(k)) { const n = +m[k]; if (Number.isFinite(n) && n !== 42949672.95) (p as any)[k] = n; }
    p.recvTs = performance.now();
    if (!this.scheduled) { this.scheduled = true; requestAnimationFrame(this.tick); }
  }
  private tick = (now: number) => {
    if (now - this.lastFlush < this.minIntervalMs) { requestAnimationFrame(this.tick); return; }
    this.scheduled = false; this.lastFlush = now;
    const b = this.pending; this.pending = new Map(); this.onFlush(b);
  };
}
```

Note that rAF does not fire in hidden tabs. That is desirable, because the buffer just keeps merging. On return, one flush applies the latest state.

**Stale detection:**

* Feed level: `feed = 'stale'` when `status === 'live'` but no `tf` message has arrived for any token for more than 5 s **during market hours**. Use the exchange calendar from the existing app if there is one. Show a banner, and dim prices with a CSS class on the table root. Do not re-render per cell.
* Row level: keep `recvTs` per quote. In the 1 Hz analytics tick, mark a row `stale` if both legs are older than 60 s. Illiquid deep OTM strikes are often legitimately quiet, so this should be a subtle indicator only.
* After a reconnect, the `tk` acknowledgements carry a full snapshot. Apply them without flashing, by passing `suppressFlash` for one flush.

---

## 4. Web Worker for analytics

### 4.1 Setup

`ng generate web-worker features/option-chain/analytics/analytics` creates `analytics.worker.ts` and `tsconfig.worker.json`, and wires `"webWorkerTsConfig"` in `angular.json`. The application builder (esbuild) bundles `new Worker(new URL('./analytics.worker', import.meta.url), { type: 'module' })` automatically. The worker imports the analytics library directly, so the library **must be DOM-free** and must not import from `@angular/*`.

### 4.2 Message protocol (versioned discriminated union)

```ts
// analytics/protocol.ts
export const PROTOCOL_VERSION = 1;
export type ToWorker =
  | { v: 1; type: 'compute'; jobId: number; input: ChainSnapshot }
  | { v: 1; type: 'config'; riskFreeRate: number; dividendYield: number };
export type FromWorker =
  | { v: 1; type: 'result'; jobId: number; out: ChainResult; ms: number }
  | { v: 1; type: 'error'; jobId: number; message: string };

/** Struct-of-arrays: index i = i-th strike; transferable buffers. */
export interface ChainSnapshot {
  spot: number; tYears: number; lotSize: number;
  strikes: Float64Array; ceLtp: Float64Array; peLtp: Float64Array;
  ceOi: Float64Array; peOi: Float64Array;
}
export interface ChainResult {
  ceIv: Float64Array; peIv: Float64Array; ceDelta: Float64Array; peDelta: Float64Array;
  gamma: Float64Array; ceTheta: Float64Array; peTheta: Float64Array; vega: Float64Array;
  agg: { pcr: number; maxPain: number; gex: number; atmIv: number };
}
```

```ts
// analytics/analytics.bridge.ts (main thread)
@Injectable()
export class AnalyticsBridge {
  private worker = new Worker(new URL('./analytics.worker', import.meta.url), { type: 'module' });
  private inFlight = false; private dirty = false; private jobId = 0;
  private store = inject(OptionChainStore);
  constructor() {
    this.worker.onmessage = ({ data }: MessageEvent<FromWorker>) => {
      this.inFlight = false;
      if (data.type === 'result' && data.jobId === this.jobId) this.store.applyAnalytics(data.out);
    };
    const id = setInterval(() => this.maybeRun(), 1000);
    inject(DestroyRef).onDestroy(() => { clearInterval(id); this.worker.terminate(); });
  }
  markDirty() { this.dirty = true; }
  private maybeRun() {
    if (!this.dirty || this.inFlight) return;          // drop, don't queue
    this.dirty = false; this.inFlight = true;
    const input = this.store.snapshotForAnalytics();    // builds fresh Float64Arrays
    const transfer = [input.strikes, input.ceLtp, input.peLtp, input.ceOi, input.peOi].map(a => a.buffer);
    this.worker.postMessage({ v: 1, type: 'compute', jobId: ++this.jobId, input } satisfies ToWorker, transfer);
  }
}
```

### 4.3 Typed arrays vs structured clone, and comlink

* At this size (about 150 strikes × 5 inputs), a structured clone of plain objects costs well under 1 ms. **Transferables are not a performance necessity.** They are recommended anyway because struct-of-arrays is also the natural shape for the vectorised IV solver, and transferring has zero copy cost. Rule: once transferred, the main-thread buffer is detached. Always build a fresh snapshot.
* **SharedArrayBuffer is not worth it.** It needs COOP/COEP headers on web.tradesmartonline.in, which would break third-party embeds such as TradingView, payment and analytics scripts.
* **comlink:** nice ergonomics (`await api.compute(snap)`), about 1.1 kB. But we have one message type, need "drop if busy" semantics, and want explicit transfer lists. **Recommendation: plain `postMessage` with the typed protocol above.** Use comlink only if the worker API grows beyond about 3 methods.
* Add a sync **fallback**: if `typeof Worker === 'undefined'` (SSR and some test environments), run the same library on the main thread.

---

## 5. Persisting user preferences

| | localStorage | Backend (user settings API) |
|---|---|---|
| Effort | Trivial | Needs an endpoint and auth |
| Cross-device / cross-browser | No | Yes |
| Survives cache clear or incognito | No | Yes |
| Latency at screen open | 0 ms (sync) | One request. Needs a cached default anyway. |
| Risk | Quota is irrelevant here (< 2 kB) | Write storms if saved on every drag |

**Recommendation: local-first with optional sync.** Use localStorage now behind a `PreferencesStore` interface. Add the backend when an endpoint exists, keeping localStorage as a read-through cache. If both exist, the latest `updatedAt` wins.

```ts
export interface OptionChainPrefsV1 {
  schema: 1; updatedAt: number;
  defaultPreset: PresetId;                  // 'default' | 'price' | 'greeks' | 'oi' | 'ohlc' | 'stats' | 'straddle' | 'custom'
  strikeCount: StrikeCount;
  custom: { call: ColumnId[]; put: ColumnId[]; mirrorPuts: boolean };   // order matters
  lastUnderlying?: string;
}
const KEY = (uid: string) => `ts.oc.prefs.${uid}`;            // per user: shared desktops exist

@Injectable({ providedIn: 'root' })
export class PrefsService {
  private uid = inject(SessionService).current().uid;
  readonly prefs = signal<OptionChainPrefsV1>(this.load());
  constructor() {
    effect(() => { const p = this.prefs(); queueMicrotask(() => safeSet(KEY(this.uid), JSON.stringify(p))); });
  }
  private load(): OptionChainPrefsV1 {
    try { return migrate(JSON.parse(localStorage.getItem(KEY(this.uid)) ?? 'null')) ?? DEFAULT_PREFS; }
    catch { return DEFAULT_PREFS; }
  }
}
```

* Always validate stored column IDs against the current column registry. Drop unknown IDs, so that a removed column cannot crash the screen.
* Carry a `schema` version, and write a `migrate()` for every bump.
* Debounce backend writes (about 1 s) and never block the UI on them.

---

## 6. Testing strategy

| Layer | Tool | What |
|---|---|---|
| Calc library (pure TS) | **Vitest**, the Angular CLI default for new projects since v21. It also runs standalone without Angular. | IV round-trip (price → IV → price within 1e-6), Greeks against reference values (e.g. Hull textbook tables or py_vollib fixtures), put-call parity, edge cases (expiry day, `t → 0`, deep ITM, zero bid, ATO price sentinel), Max Pain on hand-built chains, PCR and GEX sign conventions. Use property tests with `fast-check` for monotonicity (call delta increases with spot). |
| Data access | Vitest + fake timers | `TickBuffer` merge and number parsing, subscribe diffing and ref-counts, reconnect backoff sequence, resubscribe after reconnect, heartbeat timeout → close, `ck: Not_Ok` → no retry, stale detection. |
| Store | Vitest + `TestBed` (zoneless) | `applyTicks` touches only affected row signals. ATM and window change only on strike crossing. Separator position. |
| Components | Vitest + Angular TestBed or `@testing-library/angular` | Preset switching renders the right columns. Custom preset reorder persists. Flash directive calls `animate` with the up or down colour (spy on `Element.prototype.animate`). Hover actions are keyboard-reachable. CSV export content. |
| Worker | Test the worker's pure `handle(msg)` function directly. Only e2e exercises the real `Worker`. | — |
| E2E and demos | **Playwright** + `MockFeedTransport` | Scripted scenarios: open → snapshot → ticks → spot crosses strike → disconnect → reconnect → resubscribe. Visual snapshots of the table at fixed mock time. |

If the existing app is on Karma/Jasmine, Karma is deprecated. Migrate using the CLI's `refactor-jasmine-vitest` schematic ([guide](https://angular.dev/guide/testing/migrating-to-vitest)). The feature library can use Vitest independently even before the app migrates. Jest is a supported alternative, but Vitest is now the platform default, so do not introduce Jest.

### Mock feed

```ts
// testing/mock-feed.transport.ts: implements FeedTransport, provided via FEED_TRANSPORT
export class MockFeedTransport implements FeedTransport {
  // modes: 'random-walk' (GBM spot, option prices from BS with a smile), 'replay' (recorded NDJSON of real tf frames), 'scripted'
  constructor(private opts: { mode: 'random-walk' | 'replay' | 'scripted'; ticksPerSec?: number; seed?: number }) {}
  // replies {t:'ck',s:'Ok'} to 'c', 'tk' snapshot per token to 't', 'hk' to 'h'; emits partial 'tf' with 1–4 random fields
  // test hooks: dropConnection(), freeze() (stale), jumpSpot(pct), setAuthFail()
}
```

* Seeded randomness (`seed`) gives reproducible demos and visual tests.
* Record real frames in UAT with a dev-only flag that writes NDJSON. Replay them for performance profiling at true market burst rates, including expiry-day 09:15–09:20.
* Enable the mock with a query flag (`?feed=mock`) in non-production builds only.

---

## 7. Folder and module structure

The structure is a feature library dropped into the existing Ionic Angular app. It works as a folder under `src/app/features/` or as an Nx library with the same split.

```
src/app/features/option-chain/
├── feature-shell/
│   ├── option-chain.routes.ts          # lazy route; providers: OptionChainStore, AnalyticsBridge, ChainFeedFacade
│   └── option-chain-page.component.ts  # ion-content host, composes UI, owns effects (subscription sync, prefs)
├── data-access/
│   ├── models.ts                       # Quote, ChainMeta, RowVM, StrikeCount...
│   ├── option-chain.store.ts           # signals store (or SignalStore)
│   ├── chain-feed.facade.ts            # subscription diffing, tick → store wiring
│   ├── instruments.service.ts          # expiries + strike→token map (REST / scrip master)
│   ├── prefs.service.ts                # §5
│   └── feed/
│       ├── transport.ts                # FeedTransport + FEED_TRANSPORT token
│       ├── websocket.transport.ts      # real Kambala transport
│       └── tick-buffer.ts              # §3.4
│   # NorenSocketService lives in app core (shared) if one exists; otherwise in core/realtime/
├── analytics/
│   ├── protocol.ts                     # §4.2 message types
│   ├── analytics.worker.ts             # thin: import lib, handle(msg)
│   ├── analytics.bridge.ts             # main-thread throttle + postMessage
│   └── tsconfig.worker.json (root)     # generated by ng g web-worker
│   # the calc library itself: libs/option-analytics (framework-free TS, own Vitest suite)
├── ui/                                 # presentational, inputs/outputs only, no services
│   ├── chain-table/  (table, oc-row, oc-sum-row, flash.directive, oi-bar)
│   ├── expiry-strip/
│   ├── strike-count-select/
│   ├── header-stats/
│   ├── preset-tabs/
│   ├── column-chooser/                 # CDK drag-drop list for Custom preset
│   └── row-actions/                    # Buy / Sell / add-to-basket (emits; shell calls existing order pad)
├── columns/
│   ├── column-registry.ts              # ColumnDef { id, label, side-agnostic accessor, format, width, flash, align }
│   └── presets.ts                      # Default, Price, Greeks, OI, OHLC, Statistics, Straddle
├── export/csv-export.ts
├── testing/mock-feed.transport.ts
└── index.ts                            # public API: routes only
```

Rules:

* `ui/` never injects stores. `feature-shell` wires them together. This keeps the components easy to test and reusable, for example in a mini-chain on the order pad later.
* `columns/column-registry.ts` is the **single source of truth** for presets, the Custom chooser, CSV headers and Σ totals (each `ColumnDef` declares `sum?: true`). CSV export iterates the active columns × `rows()` and formats with the same formatter as the cell, so the export matches the screen.
* Buy, Sell and add-to-basket **reuse the app's existing order pad and basket services**. The option chain only emits `{ token, side, ltp, lotSize }`.
* The analytics library stays outside the feature (`libs/option-analytics`), so it can be unit-tested and reused on a server, in a backtest or on mobile.
* Use Ionic only for page chrome (`ion-header`, `ion-content`, `ion-segment` for presets, `ion-select` or a popover for strike count). **Do not render the table with `ion-grid` or `ion-item`.** Use plain HTML and CSS for the table, for performance and density. Give `ion-content` `scrollY=false` and let `.oc-scroll` own scrolling, because nested scroll containers break the sticky header.

---

## 8. Summary of recommendations

| Area | Choice | Why |
|---|---|---|
| Grid | Custom `<table>` + sticky CSS. CDK virtual scroll only if profiling demands it for "All". | Centre-pinned strike and spot row don't fit AG Grid. 6k cells is small. No licence. |
| Change detection | Zoneless + OnPush + per-row signals; `@for track strike` | Only changed rows re-render. Matches the Angular 21/22 and Ionic 9 defaults. |
| State | Plain signal service, or NgRx SignalStore for the cold state if NgRx is already used. No action-per-tick NgRx Store. | Lowest overhead on the hot path. |
| Feed | Shared ref-counted `NorenSocketService`, rAF + 250 ms tick buffer, exponential backoff with jitter, resubscribe on `ck` | Correctness under reconnects and partial frames |
| Worker | `ng g web-worker`, typed postMessage protocol, transferable `Float64Array`s, drop-if-busy at 1 Hz, no comlink | Simple, explicit, zero-copy |
| Prefs | localStorage per user with a schema version. Backend sync later. | Ships now, extensible |
| Tests | Vitest (unit, component), Playwright + `MockFeedTransport` (e2e and demos) | Current Angular default. Deterministic feed. |
