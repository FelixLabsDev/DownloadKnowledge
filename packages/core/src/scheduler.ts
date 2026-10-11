import { createEmptyCard, fsrs, generatorParameters, type Card as FsrsCard, type FSRS, type Grade } from 'ts-fsrs';
import type { CardSched } from './schema';

export const DAY_MS = 86_400_000;
/** The study day rolls over at 04:00 local time. */
export const ROLLOVER_HOUR = 4;
/** Learning cards due within this window are shown rather than making the user wait. */
export const LEARN_AHEAD_MS = 20 * 60_000;

export const State = { New: 0, Learning: 1, Review: 2, Relearning: 3 } as const;
/** 1 Again, 2 Hard, 3 Good, 4 Easy. */
export type Rating = 1 | 2 | 3 | 4;

export interface SchedulerOptions {
  /** Desired retention, 0–1. */
  retention: number;
  /** Spread review intervals slightly so cards added together do not stay clumped. Off in tests. */
  fuzz: boolean;
}

const instances = new Map<string, FSRS>();
function scheduler(o: SchedulerOptions): FSRS {
  const key = `${o.retention}|${o.fuzz}`;
  let f = instances.get(key);
  if (!f) {
    f = fsrs(generatorParameters({ request_retention: o.retention, enable_fuzz: o.fuzz }));
    instances.set(key, f);
  }
  return f;
}

function toFsrs(c: CardSched): FsrsCard {
  return {
    due: new Date(c.due),
    stability: c.stability,
    difficulty: c.difficulty,
    elapsed_days: c.elapsedDays,
    scheduled_days: c.scheduledDays,
    learning_steps: c.learningSteps,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state,
    last_review: c.lastReview === null ? undefined : new Date(c.lastReview),
  };
}

function fromFsrs(c: FsrsCard): CardSched {
  return {
    due: c.due.getTime(),
    stability: c.stability,
    difficulty: c.difficulty,
    elapsedDays: c.elapsed_days,
    scheduledDays: c.scheduled_days,
    learningSteps: c.learning_steps,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state,
    lastReview: c.last_review ? c.last_review.getTime() : null,
  };
}

/** Scheduling state of a card that has never been reviewed. */
export function newCardSched(now: number): CardSched {
  return fromFsrs(createEmptyCard(new Date(now)));
}

/** Extracts just the scheduling fields from a card row. */
export function schedOf(c: CardSched): CardSched {
  return {
    due: c.due,
    stability: c.stability,
    difficulty: c.difficulty,
    elapsedDays: c.elapsedDays,
    scheduledDays: c.scheduledDays,
    learningSteps: c.learningSteps,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state,
    lastReview: c.lastReview,
  };
}

/** The card's state after answering with `rating` at `now`. */
export function schedule(card: CardSched, rating: Rating, now: number, opts: SchedulerOptions): CardSched {
  return fromFsrs(scheduler(opts).next(toFsrs(card), new Date(now), rating as Grade).card);
}

/** When the card would next be due for each possible rating. */
export function previewDue(card: CardSched, now: number, opts: SchedulerOptions): Record<Rating, number> {
  const out = {} as Record<Rating, number>;
  for (const r of [1, 2, 3, 4] as const) out[r] = schedule(card, r, now, { ...opts, fuzz: false }).due;
  return out;
}

/** Estimated probability of recalling the card at `now`, 0–1. Zero for cards never reviewed. */
export function retrievability(card: CardSched, now: number): number {
  if (card.state === State.New || card.stability <= 0) return 0;
  return scheduler({ retention: 0.9, fuzz: false }).get_retrievability(toFsrs(card), new Date(now), false);
}

/**
 * Start (ms since epoch) of the study day containing `now`.
 * `tzOffsetMinutes` is `Date#getTimezoneOffset()`: minutes to add to local time to get UTC.
 */
export function studyDayStart(now: number, tzOffsetMinutes: number): number {
  const shift = ROLLOVER_HOUR * 3_600_000 + tzOffsetMinutes * 60_000;
  return Math.floor((now - shift) / DAY_MS) * DAY_MS + shift;
}
