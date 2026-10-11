import { describe, expect, it } from 'vitest';
import { DAY_MS, newCardSched, previewDue, retrievability, schedule, State, studyDayStart } from '../src';
import { T0 } from './helpers';

const opts = { retention: 0.9, fuzz: false };

describe('scheduler wrapper', () => {
  it('starts cards as new and due immediately', () => {
    const c = newCardSched(T0);
    expect(c.state).toBe(State.New);
    expect(c.due).toBe(T0);
    expect(c.lastReview).toBeNull();
  });

  it('puts a new card into learning on Good and graduates it on the next Good', () => {
    const first = schedule(newCardSched(T0), 3, T0, opts);
    expect(first.state).toBe(State.Learning);
    expect(first.due - T0).toBeLessThan(DAY_MS);
    expect(first.reps).toBe(1);
    expect(first.lastReview).toBe(T0);

    const second = schedule(first, 3, first.due, opts);
    expect(second.state).toBe(State.Review);
    expect(second.due - first.due).toBeGreaterThanOrEqual(DAY_MS);
  });

  it('sends Easy straight to review', () => {
    const c = schedule(newCardSched(T0), 4, T0, opts);
    expect(c.state).toBe(State.Review);
    expect(c.scheduledDays).toBeGreaterThan(1);
  });

  it('grows intervals with successive successful reviews', () => {
    let c = schedule(newCardSched(T0), 4, T0, opts);
    const intervals: number[] = [];
    for (let i = 0; i < 5; i++) {
      const at = c.due;
      c = schedule(c, 3, at, opts);
      intervals.push(c.due - at);
    }
    for (let i = 1; i < intervals.length; i++) expect(intervals[i]).toBeGreaterThan(intervals[i - 1]!);
  });

  it('records a lapse and relearns when a review card is failed', () => {
    const review = schedule(newCardSched(T0), 4, T0, opts);
    const failed = schedule(review, 1, review.due, opts);
    expect(failed.state).toBe(State.Relearning);
    expect(failed.lapses).toBe(1);
    expect(failed.due - review.due).toBeLessThan(DAY_MS);
  });

  it('orders the previewed due dates Again ≤ Hard ≤ Good ≤ Easy', () => {
    const review = schedule(newCardSched(T0), 4, T0, opts);
    const p = previewDue(review, review.due, opts);
    expect(p[1]).toBeLessThanOrEqual(p[2]);
    expect(p[2]).toBeLessThanOrEqual(p[3]);
    expect(p[3]).toBeLessThanOrEqual(p[4]);
  });

  it('schedules shorter intervals for higher desired retention', () => {
    const review = schedule(newCardSched(T0), 4, T0, opts);
    const relaxed = schedule(review, 3, review.due, { retention: 0.8, fuzz: false });
    const strict = schedule(review, 3, review.due, { retention: 0.95, fuzz: false });
    expect(strict.due).toBeLessThan(relaxed.due);
  });

  it('estimates recall near the desired retention when a card comes due', () => {
    const review = schedule(newCardSched(T0), 4, T0, opts);
    expect(retrievability(review, T0)).toBeCloseTo(1, 2);
    expect(retrievability(review, review.due)).toBeGreaterThan(0.85);
    expect(retrievability(review, review.due)).toBeLessThan(0.95);
    expect(retrievability(newCardSched(T0), T0)).toBe(0);
  });
});

describe('study day', () => {
  const utc = (h: number, m = 0) => Date.UTC(2026, 0, 5, h, m);

  it('rolls over at 04:00 local time', () => {
    expect(studyDayStart(utc(12), 0)).toBe(utc(4));
    expect(studyDayStart(utc(4), 0)).toBe(utc(4));
    expect(studyDayStart(utc(3, 59), 0)).toBe(utc(4) - DAY_MS);
  });

  it('honours the timezone offset', () => {
    // UTC+2 (offset -120): 04:00 local is 02:00 UTC.
    expect(studyDayStart(utc(2), -120)).toBe(utc(2));
    expect(studyDayStart(utc(1, 59), -120)).toBe(utc(2) - DAY_MS);
    // UTC-5 (offset 300): 04:00 local is 09:00 UTC.
    expect(studyDayStart(utc(8, 59), 300)).toBe(utc(9) - DAY_MS);
    expect(studyDayStart(utc(9), 300)).toBe(utc(9));
  });
});
