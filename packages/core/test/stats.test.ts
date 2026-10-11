import { describe, expect, it } from 'vitest';
import { BASIC_ID, DAY_MS } from '../src';
import { T0, testCollection } from './helpers';

async function fixture() {
  const t = await testCollection();
  const lang = await t.col.createDeck({ name: 'Languages' });
  const es = await t.col.createDeck({ name: 'Spanish', parentId: lang.id });
  const bio = await t.col.createDeck({ name: 'Biology' });
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) ids.push((await t.col.addNote({ noteTypeId: BASIC_ID, deckId: es.id, fields: [`es${i}`, 'x'] })).cards[0]!.id);
  ids.push((await t.col.addNote({ noteTypeId: BASIC_ID, deckId: bio.id, fields: ['bio', 'x'] })).cards[0]!.id);
  return { ...t, ids, lang, es, bio };
}

describe('dashboard statistics', () => {
  it('is all zeroes for an empty collection', async () => {
    const { col } = await testCollection();
    const s = await col.stats();
    expect(s).toMatchObject({ reviewsToday: 0, dueToday: 0, streak: { current: 0, longest: 0 }, decks: [], totalCards: 0, totalReviews: 0 });
    expect(s.forecast).toHaveLength(31);
    expect(s.activity).toHaveLength(371);
    expect(s.retention).toHaveLength(12);
    expect(s.today).toBe(T0 - 8 * 3_600_000); // 04:00 that day
  });

  it('breaks cards down by state per top-level deck, sub-decks included', async () => {
    const { col, clock, ids } = await fixture();
    await col.answerCard(ids[0]!, 3, 0); // learning
    await col.answerCard(ids[1]!, 4, 0); // young review
    await col.setSuspended([ids[2]!], true);
    let mature = await col.answerCard(ids[4]!, 4, 0);
    for (let i = 0; i < 3; i++) {
      clock.now = mature.due;
      mature = await col.answerCard(ids[4]!, 4, 0);
    }
    expect(mature.scheduledDays).toBeGreaterThanOrEqual(21);
    const s = await col.stats();
    expect(s.decks).toEqual([
      { deckId: expect.any(String), path: 'Biology', new: 0, learning: 0, young: 0, mature: 1, suspended: 0 },
      { deckId: expect.any(String), path: 'Languages', new: 1, learning: 1, young: 1, mature: 0, suspended: 1 },
    ]);
    expect(s.totalCards).toBe(5);
  });

  it('forecasts when cards come due, with overdue cards counted today', async () => {
    const { col, clock, ids } = await fixture();
    const a = await col.answerCard(ids[0]!, 4, 0);
    const days = Math.floor((a.due - (T0 - 8 * 3_600_000)) / DAY_MS);
    let s = await col.stats();
    expect(s.forecast[days]).toBe(1);
    expect(s.forecast.reduce((x, y) => x + y, 0)).toBe(1); // New cards are not forecast.
    expect(s.dueToday).toBe(0);

    clock.now = a.due + 3 * DAY_MS; // Now it is overdue.
    s = await col.stats();
    expect(s.forecast[0]).toBe(1);
    expect(s.dueToday).toBe(1);
    await col.setSuspended([ids[0]!], true);
    expect((await col.stats()).dueToday).toBe(0);
  });

  it('counts activity per study day and tracks streaks', async () => {
    const { col, clock, ids } = await fixture();
    const reviewOn = async (day: number, n = 1) => {
      clock.now = T0 + day * DAY_MS;
      for (let i = 0; i < n; i++) await col.answerCard(ids[i]!, 3, 0);
    };
    await reviewOn(0, 2);
    await reviewOn(1);
    await reviewOn(2, 3);
    // Day 3 skipped.
    await reviewOn(4);
    await reviewOn(5);

    let s = await col.stats();
    expect(s.activity.slice(-6)).toEqual([2, 1, 3, 0, 1, 1]);
    expect(s.reviewsToday).toBe(1);
    expect(s.streak).toEqual({ current: 2, longest: 3 });
    expect(s.totalReviews).toBe(8);

    // Next morning, before studying: yesterday's streak still stands.
    clock.now = T0 + 6 * DAY_MS;
    s = await col.stats();
    expect(s.reviewsToday).toBe(0);
    expect(s.streak.current).toBe(2);
    // A whole day missed: it is gone.
    clock.now = T0 + 7 * DAY_MS;
    expect((await col.stats()).streak.current).toBe(0);
  });

  it('puts a 03:00 review on the previous study day', async () => {
    const { col, clock, ids } = await fixture();
    clock.now = T0 + DAY_MS - 9 * 3_600_000; // 03:00 the next calendar day
    await col.answerCard(ids[0]!, 3, 0);
    clock.now = T0 + DAY_MS; // noon
    expect((await col.stats()).activity.slice(-2)).toEqual([1, 0]);
  });

  it('measures retention on review-state cards only, and ignores undone reviews', async () => {
    const { col, clock, ids } = await fixture();
    const cards = [];
    for (const id of ids.slice(0, 4)) cards.push(await col.answerCard(id, 4, 0)); // New → review: not counted.
    clock.now = Math.max(...cards.map((c) => c.due));
    await col.answerCard(ids[0]!, 3, 0);
    await col.answerCard(ids[1]!, 2, 0);
    await col.answerCard(ids[2]!, 4, 0);
    await col.answerCard(ids[3]!, 1, 0);
    let week = (await col.stats()).retention.at(-1)!;
    expect(week).toMatchObject({ reviews: 4, recalled: 3 });
    await col.undoLastReview();
    week = (await col.stats()).retention.at(-1)!;
    expect(week).toMatchObject({ reviews: 3, recalled: 3 });
  });

  it('averages desired retention over decks by card count', async () => {
    const { col, es, bio } = await fixture();
    await col.updateDeck(es.id, { desiredRetention: 0.8 });
    await col.updateDeck(bio.id, { desiredRetention: 0.95 });
    expect((await col.stats()).desiredRetention).toBeCloseTo((0.8 * 4 + 0.95) / 5, 5);
  });
});
