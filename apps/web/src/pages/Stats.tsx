import { DAY_MS, type DeckBreakdown, type Stats } from '@dk/core';
import { Flame, Table2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Card, EmptyState, PageHeader } from '@/components/ui';
import { api, useLive, useSyncStatus } from '@/db/client';
import { cn, formatBytes } from '@/lib/utils';

// Shared chart plumbing --------------------------------------------------------

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

interface Tip {
  x: number;
  y: number;
  body: ReactNode;
}

function Tooltip({ tip, width }: { tip: Tip | null; width: number }) {
  if (!tip) return null;
  const left = Math.min(Math.max(tip.x, 70), Math.max(70, width - 70));
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border bg-card px-2.5 py-1.5 text-xs shadow-md"
      style={{ left, top: tip.y - 8 }}
    >
      {tip.body}
    </div>
  );
}

const fmtDay = (ms: number, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }) =>
  new Date(ms + 12 * 3_600_000).toLocaleDateString(undefined, opts);
const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

function niceMax(v: number): number {
  if (v <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 4, 5, 10]) if (m * pow >= v) return m * pow;
  return 10 * pow;
}

/** A panel with a title, an optional table view of the same data, and the chart. */
function Panel({ title, subtitle, table, children, className }: { title: string; subtitle?: string; table?: ReactNode; children: ReactNode; className?: string }) {
  const [showTable, setShowTable] = useState(false);
  return (
    <Card className={cn('p-4 md:p-5', className)}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-medium">{title}</h2>
          {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
        </div>
        {table && (
          <Button size="sm" variant={showTable ? 'secondary' : 'ghost'} aria-pressed={showTable} onClick={() => setShowTable(!showTable)}>
            <Table2 /> Table
          </Button>
        )}
      </div>
      {showTable ? <div className="max-h-72 overflow-auto text-sm">{table}</div> : children}
    </Card>
  );
}

function DataTable({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <table className="w-full">
      <thead>
        <tr className="border-b text-left text-xs text-muted-foreground">
          {head.map((h, i) => <th key={h} className={cn('py-1.5 font-medium', i > 0 && 'text-right')}>{h}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-b last:border-b-0">
            {r.map((c, j) => <td key={j} className={cn('py-1.5', j > 0 && 'text-right tabular-nums')}>{typeof c === 'number' ? c.toLocaleString() : c}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Tiles ------------------------------------------------------------------------

function Tile({ label, value, note, hero, icon }: { label: string; value: string; note?: string; hero?: boolean; icon?: ReactNode }) {
  return (
    <Card className="p-4">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className={cn('mt-1 flex items-center gap-2 font-semibold tracking-tight', hero ? 'text-5xl' : 'text-3xl')} data-testid={`tile-${label.toLowerCase().replace(/\W+/g, '-')}`}>
        {icon}
        {value}
      </div>
      {note && <div className="mt-1 text-xs text-muted-foreground">{note}</div>}
    </Card>
  );
}

// Due forecast -------------------------------------------------------------------

function Forecast({ s }: { s: Stats }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<(Tip & { i: number }) | null>(null);
  const H = 200;
  const m = { l: 34, r: 6, t: 10, b: 24 };
  const iw = Math.max(0, width - m.l - m.r);
  const ih = H - m.t - m.b;
  const max = niceMax(Math.max(...s.forecast));
  const band = iw / s.forecast.length;
  const bw = Math.max(2, Math.min(24, band - 2));
  const y = (v: number) => m.t + ih - (v / max) * ih;
  const total = s.forecast.reduce((a, b) => a + b, 0);

  return (
    <Panel
      title="Due forecast"
      subtitle={`${plural(total, 'review')} coming due in the next 30 days. Today includes anything overdue.`}
      table={<DataTable head={['Day', 'Cards due']} rows={s.forecast.map((n, i) => [i === 0 ? 'Today' : fmtDay(s.today + i * DAY_MS), n])} />}
    >
      <div ref={ref} className="relative" onPointerLeave={() => setTip(null)}>
        {width > 0 && (
          <svg width={width} height={H} role="img" aria-label="Bar chart of cards due per day for the next 30 days">
            {[0, max / 2, max].map((t) => (
              <g key={t}>
                <line x1={m.l} x2={width - m.r} y1={y(t)} y2={y(t)} stroke="var(--viz-grid)" />
                <text x={m.l - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[11px] tabular-nums">{t}</text>
              </g>
            ))}
            {s.forecast.map((n, i) => {
              const x = m.l + i * band + (band - bw) / 2;
              const h = (n / max) * ih;
              const r = Math.min(4, bw / 2, h);
              return (
                <g key={i}>
                  {n > 0 && (
                    <path
                      d={`M${x},${y(0)} v${-(h - r)} a${r},${r} 0 0 1 ${r},${-r} h${bw - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${h - r} z`}
                      fill="var(--viz-1)"
                      opacity={tip && tip.i !== i ? 0.45 : 1}
                    />
                  )}
                  {/* The hit target is the whole column, not just the bar. */}
                  <rect
                    x={m.l + i * band}
                    y={m.t}
                    width={band}
                    height={ih}
                    fill="transparent"
                    onPointerMove={() => setTip({ i, x: x + bw / 2, y: y(n), body: <><b>{plural(n, 'card')}</b> · {i === 0 ? 'Today' : fmtDay(s.today + i * DAY_MS)}</> })}
                  />
                  {i % 7 === 0 && (
                    <text x={x + bw / 2} y={H - 6} textAnchor={i === 0 ? 'start' : 'middle'} dx={i === 0 ? -bw / 2 : 0} className="fill-muted-foreground text-[11px]">
                      {i === 0 ? 'Today' : fmtDay(s.today + i * DAY_MS, { day: 'numeric', month: 'short' })}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        )}
        <Tooltip tip={tip} width={width} />
      </div>
    </Panel>
  );
}

// Retention over time ---------------------------------------------------------------

function Retention({ s }: { s: Stats }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const H = 200;
  const m = { l: 40, r: 48, t: 12, b: 24 };
  const iw = Math.max(0, width - m.l - m.r);
  const ih = H - m.t - m.b;
  const pts = s.retention.map((w, i) => ({ ...w, i, rate: w.reviews ? w.recalled / w.reviews : null }));
  const known = pts.filter((p) => p.rate !== null) as (typeof pts[number] & { rate: number })[];
  const lo = Math.min(0.7, Math.floor(Math.min(s.desiredRetention, ...known.map((p) => p.rate)) * 10) / 10);
  const x = (i: number) => m.l + (pts.length > 1 ? (i / (pts.length - 1)) * iw : iw / 2);
  const y = (v: number) => m.t + ih - ((v - lo) / (1 - lo)) * ih;
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  // Break the line across weeks with no reviews instead of inventing values for them.
  const segments: (typeof known)[] = [];
  for (const p of known) {
    const last = segments.at(-1);
    if (last && last.at(-1)!.i === p.i - 1) last.push(p);
    else segments.push([p]);
  }
  const end = known.at(-1);
  const h = hover === null ? null : pts[hover]!;

  return (
    <Panel
      title="Retention"
      subtitle="Share of reviews you recalled, per week. Only cards already in review count."
      table={<DataTable head={['Week starting', 'Reviews', 'Recalled', 'Retention']} rows={pts.map((p) => [fmtDay(p.weekStart, { day: 'numeric', month: 'short' }), p.reviews, p.recalled, p.rate === null ? 'n/a' : pct(p.rate)])} />}
    >
      {known.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">Retention appears once cards you have learned come back for review.</p>
      ) : (
        <div
          ref={ref}
          className="relative"
          onPointerLeave={() => setHover(null)}
          onPointerMove={(e) => {
            const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
            setHover(Math.max(0, Math.min(pts.length - 1, Math.round(((px - m.l) / (iw || 1)) * (pts.length - 1)))));
          }}
        >
          {width > 0 && (
            <svg width={width} height={H} role="img" aria-label="Line chart of weekly retention over the last 12 weeks">
              {[lo, (lo + 1) / 2, 1].map((t) => (
                <g key={t}>
                  <line x1={m.l} x2={width - m.r} y1={y(t)} y2={y(t)} stroke="var(--viz-grid)" />
                  <text x={m.l - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[11px] tabular-nums">{pct(t)}</text>
                </g>
              ))}
              <line x1={m.l} x2={width - m.r} y1={y(s.desiredRetention)} y2={y(s.desiredRetention)} stroke="var(--muted-foreground)" strokeWidth={1} />
              <text x={width - m.r + 6} y={y(s.desiredRetention)} dy="0.32em" className="fill-muted-foreground text-[11px]">Target</text>
              {h && <line x1={x(h.i)} x2={x(h.i)} y1={m.t} y2={m.t + ih} stroke="var(--muted-foreground)" strokeWidth={1} />}
              {segments.map((seg) => (
                <polyline key={seg[0]!.i} points={seg.map((p) => `${x(p.i)},${y(p.rate)}`).join(' ')} fill="none" stroke="var(--viz-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              ))}
              {known.map((p) => (
                <circle key={p.i} cx={x(p.i)} cy={y(p.rate)} r={hover === p.i ? 5 : 4} fill="var(--viz-1)" stroke="var(--card)" strokeWidth={2} />
              ))}
              {end && Math.abs(y(end.rate) - y(s.desiredRetention)) > 12 && end.i === pts.length - 1 && (
                <text x={x(end.i) + 8} y={y(end.rate)} dy="0.32em" className="fill-foreground text-xs font-medium">{pct(end.rate)}</text>
              )}
              {pts.map((p) => p.i % 3 === 0 && (
                <text key={p.i} x={x(p.i)} y={H - 6} textAnchor={p.i === 0 ? 'start' : 'middle'} className="fill-muted-foreground text-[11px]">
                  {fmtDay(p.weekStart, { day: 'numeric', month: 'short' })}
                </text>
              ))}
            </svg>
          )}
          <Tooltip
            width={width}
            tip={h && { x: x(h.i), y: h.rate === null ? m.t + ih / 2 : y(h.rate), body: <><b>{h.rate === null ? 'No reviews' : pct(h.rate)}</b> · week of {fmtDay(h.weekStart, { day: 'numeric', month: 'short' })}{h.rate !== null && <> · {h.recalled}/{h.reviews}</>}</> }}
          />
        </div>
      )}
    </Panel>
  );
}

// Activity heatmap ----------------------------------------------------------------

function Heatmap({ s }: { s: Stats }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const CELL = 12;
  const GAP = 3;
  const top = 16;
  const left = 28;
  const n = s.activity.length;
  const max = Math.max(...s.activity);
  const cells: { i: number; col: number; row: number; count: number; day: number }[] = [];
  const months: { col: number; label: string }[] = [];
  let col = 0;
  for (let i = 0; i < n; i++) {
    const day = s.today - (n - 1 - i) * DAY_MS;
    const date = new Date(day + 12 * 3_600_000);
    const row = (date.getDay() + 6) % 7; // Monday first
    if (row === 0 && i > 0) col++;
    if (date.getDate() <= 7 && row === 0) months.push({ col, label: date.toLocaleDateString(undefined, { month: 'short' }) });
    cells.push({ i, col, row, count: s.activity[i]!, day });
  }
  const width = left + (col + 1) * (CELL + GAP);
  const height = top + 7 * (CELL + GAP);
  const level = (c: number) => (c === 0 ? 0 : Math.max(1, Math.ceil((c / max) * 4)));
  const activeDays = s.activity.filter((c) => c > 0).length;

  // Newest weeks are on the right; start scrolled there on a narrow screen.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = scroller.current.scrollWidth;
  }, []);

  return (
    <Panel
      title="Review activity"
      subtitle={`${plural(s.totalReviews, 'review')} on ${plural(activeDays, 'day')} in the last year. Longest streak: ${plural(s.streak.longest, 'day')}.`}
      table={<DataTable head={['Day', 'Reviews']} rows={cells.filter((c) => c.count > 0).reverse().map((c) => [fmtDay(c.day), c.count])} />}
    >
      <div className="relative" onPointerLeave={() => setTip(null)}>
        <div ref={scroller} className="overflow-x-auto pb-1">
          <svg width={width} height={height} role="img" aria-label="Heatmap of reviews per day over the last year" className="ml-auto block">
            {months.map((mo) => <text key={mo.col} x={left + mo.col * (CELL + GAP)} y={10} className="fill-muted-foreground text-[10px]">{mo.label}</text>)}
            {['Mon', 'Wed', 'Fri'].map((d, k) => <text key={d} x={0} y={top + (k * 2) * (CELL + GAP) + CELL - 2} className="fill-muted-foreground text-[10px]">{d}</text>)}
            {cells.map((c) => (
              <rect
                key={c.i}
                x={left + c.col * (CELL + GAP)}
                y={top + c.row * (CELL + GAP)}
                width={CELL}
                height={CELL}
                rx={2.5}
                fill={`var(--viz-seq-${level(c.count)})`}
                onPointerMove={(e) => {
                  const box = scroller.current!.getBoundingClientRect();
                  const r = e.currentTarget.getBoundingClientRect();
                  setTip({ x: r.left - box.left + CELL / 2, y: r.top - box.top, body: <><b>{plural(c.count, 'review')}</b> · {fmtDay(c.day)}</> });
                }}
              />
            ))}
          </svg>
        </div>
        <Tooltip tip={tip} width={scroller.current?.clientWidth ?? 0} />
        <div className="mt-2 flex items-center justify-end gap-1.5 text-xs text-muted-foreground">
          Less
          {[0, 1, 2, 3, 4].map((l) => <span key={l} className="size-3 rounded-[3px]" style={{ background: `var(--viz-seq-${l})` }} />)}
          More
        </div>
      </div>
    </Panel>
  );
}

// Cards by state, per deck -----------------------------------------------------------

const STATES = [
  { key: 'new', label: 'New', color: 'var(--viz-1)' },
  { key: 'learning', label: 'Learning', color: 'var(--viz-2)' },
  { key: 'young', label: 'Young', color: 'var(--viz-3)' },
  { key: 'mature', label: 'Mature', color: 'var(--viz-4)' },
  { key: 'suspended', label: 'Suspended', color: 'var(--viz-5)' },
] as const;

function DeckStates({ s }: { s: Stats }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<(Tip & { key: string }) | null>(null);
  const sum = (d: DeckBreakdown) => STATES.reduce((a, st) => a + d[st.key], 0);
  const decks = s.decks.filter((d) => sum(d) > 0).sort((a, b) => sum(b) - sum(a));
  const max = Math.max(1, ...decks.map(sum));
  const totals = STATES.map((st) => decks.reduce((a, d) => a + d[st.key], 0));
  const valueW = 52;

  return (
    <Panel
      title="Cards by state"
      subtitle={`${plural(s.totalCards, 'card')}. Mature means the interval has reached 21 days. Each deck includes its sub-decks.`}
      table={<DataTable head={['Deck', ...STATES.map((st) => st.label), 'Total']} rows={decks.map((d) => [d.path, ...STATES.map((st) => d[st.key]), sum(d)])} />}
    >
      <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Legend">
        {STATES.map((st, i) => (
          <li key={st.key} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-[3px]" style={{ background: st.color }} />
            {st.label}
            <span className="tabular-nums text-muted-foreground">{totals[i]!.toLocaleString()}</span>
          </li>
        ))}
      </ul>
      <div ref={ref} className="relative flex flex-col gap-3" onPointerLeave={() => setTip(null)}>
        {decks.map((d, row) => {
          const barW = Math.max(0, width - valueW) * (sum(d) / max);
          let x = 0;
          return (
            <div key={d.deckId}>
              <div className="mb-1 truncate text-sm">{d.path}</div>
              <div className="flex items-center gap-2">
                <svg width={Math.max(0, width - valueW)} height={16} role="img" aria-label={`${d.path}: ${STATES.map((st) => `${d[st.key]} ${st.label.toLowerCase()}`).join(', ')}`}>
                  {STATES.map((st) => {
                    const w = (d[st.key] / sum(d)) * barW;
                    const seg = { x, w };
                    x += w;
                    if (d[st.key] === 0) return null;
                    const id = `${d.deckId}-${st.key}`;
                    return (
                      <rect
                        key={st.key}
                        x={seg.x}
                        y={0}
                        // The 2px gap between segments is the separator; no outlines.
                        width={Math.max(1, seg.w - 2)}
                        height={16}
                        rx={3}
                        fill={st.color}
                        opacity={tip && tip.key !== id ? 0.45 : 1}
                        onPointerMove={() => setTip({ key: id, x: seg.x + seg.w / 2, y: (ref.current?.children[row] as HTMLElement).offsetTop + 22, body: <><b>{plural(d[st.key], 'card')}</b> · {st.label} · {d.path}</> })}
                      />
                    );
                  })}
                </svg>
                <span className="w-11 text-right text-xs tabular-nums text-muted-foreground">{sum(d).toLocaleString()}</span>
              </div>
            </div>
          );
        })}
        <Tooltip tip={tip} width={width} />
      </div>
    </Panel>
  );
}

// Storage ----------------------------------------------------------------------------

interface ServerStorage {
  dbBytes: number;
  mediaBytes: number;
  mediaFiles: number;
  diskFreeBytes: number | null;
}

function Storage() {
  const local = useLive(() => api.storageInfo(), []);
  const sync = useSyncStatus();
  const [server, setServer] = useState<ServerStorage | null>(null);
  useEffect(() => {
    if (sync.phase !== 'idle') return;
    fetch('/api/storage').then(async (r) => setServer(r.ok ? await r.json() : null), () => setServer(null));
  }, [sync.phase, sync.lastSyncedAt]);
  const l = local.data;
  const Line = ({ label, value }: { label: string; value: string }) => (
    <div className="flex justify-between gap-4 border-b py-1.5 text-sm last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
  return (
    <Card className="p-4 md:p-5">
      <h2 className="mb-3 font-medium">Storage</h2>
      <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
        <div>
          <h3 className="mb-1 text-sm font-medium">This device</h3>
          {l && (
            <>
              <Line label="Cards and history" value={formatBytes(l.dbBytes)} />
              <Line label={`Media (${plural(l.mediaFiles, 'file')})`} value={formatBytes(l.mediaBytes)} />
              <Line label="Allowed by the browser" value={formatBytes(l.quota)} />
            </>
          )}
        </div>
        <div>
          <h3 className="mb-1 text-sm font-medium">Server</h3>
          {server ? (
            <>
              <Line label="Cards and history" value={formatBytes(server.dbBytes)} />
              <Line label={`Media (${plural(server.mediaFiles, 'file')})`} value={formatBytes(server.mediaBytes)} />
              <Line label="Free disk space" value={formatBytes(server.diskFreeBytes)} />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{sync.phase === 'signed-out' ? 'Sign in under Settings to see the server.' : 'The server cannot be reached right now.'}</p>
          )}
        </div>
      </div>
    </Card>
  );
}

// Page ---------------------------------------------------------------------------------

export function StatsPage() {
  const stats = useLive(() => api.stats(), []);
  const s = stats.data;
  if (!s) return <PageHeader title="Stats" />;
  const recent = s.retention.slice(-4).reduce((a, w) => ({ reviews: a.reviews + w.reviews, recalled: a.recalled + w.recalled }), { reviews: 0, recalled: 0 });

  return (
    <>
      <PageHeader title="Stats" />
      {s.totalCards === 0 ? (
        <EmptyState title="Nothing to show yet">Add some cards and review them; your forecast, retention and activity will appear here.</EmptyState>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile hero label="Due today" value={s.dueToday.toLocaleString()} note="Reviews and learning cards; new cards are extra" />
            <Tile label="Reviewed today" value={s.reviewsToday.toLocaleString()} />
            <Tile label="Streak" value={plural(s.streak.current, 'day')} icon={s.streak.current > 0 ? <Flame className="size-6 text-rate-hard" aria-hidden /> : undefined} note={`Longest: ${plural(s.streak.longest, 'day')}`} />
            <Tile label="Retention" value={recent.reviews ? `${Math.round((recent.recalled / recent.reviews) * 100)}%` : 'n/a'} note={`Last 4 weeks · target ${Math.round(s.desiredRetention * 100)}%`} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Forecast s={s} />
            <Retention s={s} />
          </div>
          <Heatmap s={s} />
          <DeckStates s={s} />
          <Storage />
        </div>
      )}
    </>
  );
}
