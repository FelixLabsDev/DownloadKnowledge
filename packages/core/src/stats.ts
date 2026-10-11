import { and, isNull, sql } from 'drizzle-orm';
import { deckPath, loadDecks, subtree } from './decks';
import { DAY_MS, ROLLOVER_HOUR, State, studyDayStart } from './scheduler';
import { cards, reviewLog } from './schema';
import type { Ctx } from './store';

/** A review card whose interval has reached this many days counts as mature. */
export const MATURE_DAYS = 21;
export const FORECAST_DAYS = 31;
export const ACTIVITY_DAYS = 371; // 53 weeks
export const RETENTION_WEEKS = 12;

export interface DeckBreakdown {
  deckId: string;
  path: string;
  new: number;
  learning: number;
  young: number;
  mature: number;
  suspended: number;
}

export interface Stats {
  /** Start of the current study day, ms. Day `i` of a series starts at `today + i * DAY_MS`. */
  today: number;
  reviewsToday: number;
  /** Cards due today or overdue (learning and review; not new). */
  dueToday: number;
  streak: { current: number; longest: number };
  /** Cards coming due per day: index 0 is today (including overdue), then the next 30 days. */
  forecast: number[];
  /** Reviews per study day, oldest first, ending today. */
  activity: number[];
  /** Per week, oldest first: reviews of review-state cards, and how many were recalled (not "Again"). */
  retention: { weekStart: number; reviews: number; recalled: number }[];
  /** Average desired retention across decks that hold cards, for the reference line. */
  desiredRetention: number;
  /** One row per top-level deck, covering everything beneath it. */
  decks: DeckBreakdown[];
  totalCards: number;
  totalReviews: number;
}

/** Everything the dashboard shows, computed from this device's cards and review log. */
export async function computeStats(ctx: Ctx): Promise<Stats> {
  const tx = ctx.tx;
  const today = studyDayStart(ctx.now, ctx.tzOffsetMinutes);
  // Subtracting this makes integer division by DAY_MS yield study-day numbers.
  const shift = ROLLOVER_HOUR * 3_600_000 + ctx.tzOffsetMinutes * 60_000;
  const todayIndex = Math.floor((ctx.now - shift) / DAY_MS);
  const live = isNull(reviewLog.deletedAt);

  const perDay = await tx
    .select({
      day: sql<number>`CAST((${reviewLog.reviewedAt} - ${shift}) / ${DAY_MS} AS INTEGER)`.as('day'),
      n: sql<number>`count(*)`,
      graded: sql<number>`sum(json_extract(${reviewLog.stateBefore}, '$.state') = ${State.Review})`,
      recalled: sql<number>`sum(json_extract(${reviewLog.stateBefore}, '$.state') = ${State.Review} AND ${reviewLog.rating} > 1)`,
    })
    .from(reviewLog)
    .where(live)
    .groupBy(sql`day`);
  const byDay = new Map(perDay.map((r) => [Number(r.day), r]));

  const activity: number[] = [];
  for (let i = ACTIVITY_DAYS - 1; i >= 0; i--) activity.push(Number(byDay.get(todayIndex - i)?.n ?? 0));

  // Streaks. A day without reviews breaks one, but today not being done yet does not.
  const days = [...byDay.keys()].sort((a, b) => a - b);
  let longest = 0;
  let run = 0;
  let prev: number | null = null;
  for (const d of days) {
    run = prev !== null && d === prev + 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = d;
  }
  let current = 0;
  for (let d = byDay.has(todayIndex) ? todayIndex : todayIndex - 1; byDay.has(d); d--) current++;

  const retention: Stats['retention'] = [];
  for (let w = RETENTION_WEEKS - 1; w >= 0; w--) {
    const end = todayIndex - w * 7;
    let reviews = 0;
    let recalled = 0;
    for (let d = end - 6; d <= end; d++) {
      reviews += Number(byDay.get(d)?.graded ?? 0);
      recalled += Number(byDay.get(d)?.recalled ?? 0);
    }
    retention.push({ weekStart: today - (w * 7 + 6) * DAY_MS, reviews, recalled });
  }

  const liveCard = isNull(cards.deletedAt);
  const due = await tx
    .select({
      day: sql<number>`CASE WHEN ${cards.due} < ${today} THEN 0 ELSE CAST((${cards.due} - ${today}) / ${DAY_MS} AS INTEGER) END`.as('day'),
      n: sql<number>`count(*)`,
    })
    .from(cards)
    .where(and(liveCard, sql`${cards.suspended} = 0 AND ${cards.state} != ${State.New} AND ${cards.due} < ${today + FORECAST_DAYS * DAY_MS}`))
    .groupBy(sql`day`);
  const forecast = new Array<number>(FORECAST_DAYS).fill(0);
  for (const r of due) forecast[Math.min(FORECAST_DAYS - 1, Math.max(0, Number(r.day)))]! += Number(r.n);

  const index = await loadDecks(tx);
  const perDeck = await tx
    .select({
      deckId: cards.deckId,
      suspended: sql<number>`sum(${cards.suspended} = 1)`,
      new: sql<number>`sum(${cards.suspended} = 0 AND ${cards.state} = ${State.New})`,
      learning: sql<number>`sum(${cards.suspended} = 0 AND ${cards.state} IN (${State.Learning}, ${State.Relearning}))`,
      young: sql<number>`sum(${cards.suspended} = 0 AND ${cards.state} = ${State.Review} AND ${cards.scheduledDays} < ${MATURE_DAYS})`,
      mature: sql<number>`sum(${cards.suspended} = 0 AND ${cards.state} = ${State.Review} AND ${cards.scheduledDays} >= ${MATURE_DAYS})`,
    })
    .from(cards)
    .where(liveCard)
    .groupBy(cards.deckId);
  const own = new Map(perDeck.map((r) => [r.deckId, r]));

  const decks: DeckBreakdown[] = [];
  let weighted = 0;
  let weight = 0;
  for (const top of index.children.get(null) ?? []) {
    const row: DeckBreakdown = { deckId: top.id, path: deckPath(index, top.id), new: 0, learning: 0, young: 0, mature: 0, suspended: 0 };
    for (const d of subtree(index, top.id)) {
      const o = own.get(d.id);
      if (!o) continue;
      const n = { new: Number(o.new), learning: Number(o.learning), young: Number(o.young), mature: Number(o.mature), suspended: Number(o.suspended) };
      for (const k of ['new', 'learning', 'young', 'mature', 'suspended'] as const) row[k] += n[k];
      const count = n.new + n.learning + n.young + n.mature;
      weighted += d.desiredRetention * count;
      weight += count;
    }
    decks.push(row);
  }

  return {
    today,
    reviewsToday: activity.at(-1) ?? 0,
    dueToday: forecast[0] ?? 0,
    streak: { current, longest },
    forecast,
    activity,
    retention,
    desiredRetention: weight ? weighted / weight : 0.9,
    decks,
    totalCards: decks.reduce((s, d) => s + d.new + d.learning + d.young + d.mature + d.suspended, 0),
    totalReviews: perDay.reduce((s, r) => s + Number(r.n), 0),
  };
}
