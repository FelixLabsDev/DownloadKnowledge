import { BASIC_ID, DAY_MS, decks, outbox, reviewLog, State, type PushRequest, type SyncTransport } from '@dk/core';
import { describe, expect, it } from 'vitest';
import { makeClient, makeServer, serverVersion, snapshot } from './harness';

/** Two clients and a server, with one deck holding one note already synced everywhere. */
async function world() {
  const server = await makeServer();
  const a = await makeClient();
  const b = await makeClient();
  const deck = await a.col.createDeck({ name: 'Shared' });
  const { note, cards } = await a.col.addNote({ noteTypeId: BASIC_ID, deckId: deck.id, fields: ['q', 'a'] });
  await a.col.sync(server.transport);
  await b.col.sync(server.transport);
  return { server, a, b, deck, note, card: cards[0]! };
}

async function expectConverged(...cols: { col: Parameters<typeof snapshot>[0] }[]) {
  const first = await snapshot(cols[0]!.col);
  for (const c of cols.slice(1)) expect(await snapshot(c.col)).toEqual(first);
}

describe('sync', () => {
  it('carries changes from one device to another, both ways', async () => {
    const { server, a, b, deck } = await world();
    expect((await b.col.deckTree()).map((n) => n.path)).toEqual(['Shared']);
    expect((await b.col.searchCards('')).total).toBe(1);

    b.clock.now += 1000;
    await b.col.addNote({ noteTypeId: BASIC_ID, deckId: deck.id, fields: ['from b', 'x'] });
    expect(await b.col.pendingCount()).toBe(2);
    await b.col.sync(server.transport);
    expect(await b.col.pendingCount()).toBe(0);
    await a.col.sync(server.transport);
    expect((await a.col.searchCards('from')).total).toBe(1);
    await expectConverged(a, b, server);
  });

  it('a sync with nothing to do changes nothing', async () => {
    const { server, a } = await world();
    const before = await serverVersion(server.col);
    expect(await a.col.sync(server.transport)).toEqual({ pushed: 0, pulled: 0 });
    expect(await serverVersion(server.col)).toBe(before);
  });

  it('survives a lost push response: the retry is a no-op on the server', async () => {
    const { server, a, b, deck } = await world();
    a.clock.now += 1000;
    await a.col.updateDeck(deck.id, { name: 'Renamed' });

    let dropped = 0;
    const lossy: SyncTransport = {
      ...server.transport,
      push: async (body) => {
        await server.transport.push(body); // The server applies it…
        dropped++;
        throw new Error('connection reset'); // …but the client never hears back.
      },
    };
    await expect(a.col.sync(lossy)).rejects.toThrow('connection reset');
    expect(dropped).toBe(1);
    expect(await a.col.pendingCount()).toBe(1); // Still queued.
    const afterFirst = await serverVersion(server.col);

    await a.col.sync(server.transport); // Retry.
    expect(await a.col.pendingCount()).toBe(0);
    expect(await serverVersion(server.col)).toBe(afterFirst); // Nothing was applied twice.
    await b.col.sync(server.transport);
    expect((await b.col.deckTree())[0]!.path).toBe('Renamed');
    await expectConverged(a, b, server);
  });

  it('ignores a duplicate send', async () => {
    const { server, a, deck } = await world();
    a.clock.now += 1000;
    await a.col.updateDeck(deck.id, { name: 'Once' });
    let body: PushRequest | undefined;
    await a.col.sync({ ...server.transport, push: (b) => ((body = b), server.transport.push(b)) });
    const version = await serverVersion(server.col);
    expect(await server.transport.push(body!)).toEqual({ applied: 0, ignored: 1 });
    expect(await server.transport.push(body!)).toEqual({ applied: 0, ignored: 1 });
    expect(await serverVersion(server.col)).toBe(version);
  });

  it('accepts batches out of order: an older edit arriving late does not win', async () => {
    const { server, a, b, deck } = await world();
    const captured: PushRequest[] = [];
    const capture: SyncTransport = { ...server.transport, push: async (body) => (captured.push(body), { applied: 0, ignored: 0 }) };

    a.clock.now += 1000;
    await a.col.updateDeck(deck.id, { name: 'First edit' });
    await a.col.sync(capture);
    a.clock.now += 1000;
    await a.col.updateDeck(deck.id, { name: 'Second edit' });
    await a.col.sync(capture);

    // Deliver newest first.
    expect((await server.transport.push(captured[1]!)).applied).toBe(1);
    expect((await server.transport.push(captured[0]!)).applied).toBe(0);
    await b.col.sync(server.transport);
    expect((await b.col.deckTree())[0]!.path).toBe('Second edit');
  });

  it.each([
    ['the earlier editor syncs first', ['a', 'b']],
    ['the later editor syncs first', ['b', 'a']],
  ] as const)('interleaved edits to one row: the later edit wins when %s', async (_name, order) => {
    const { server, a, b, deck } = await world();
    a.clock.now += 1000;
    b.clock.now += 2000;
    await a.col.updateDeck(deck.id, { name: 'From A (earlier)' });
    await b.col.updateDeck(deck.id, { name: 'From B (later)' });
    const who = { a, b };
    for (const name of order) await who[name].col.sync(server.transport);
    for (const name of order) await who[name].col.sync(server.transport);
    expect((await a.col.deckTree())[0]!.path).toBe('From B (later)');
    await expectConverged(a, b, server);
  });

  it('breaks an exact timestamp tie on device id, the same way everywhere', async () => {
    const { server, a, b, deck } = await world();
    a.clock.now += 5000;
    b.clock.now += 5000;
    await a.col.updateDeck(deck.id, { name: 'A' });
    await b.col.updateDeck(deck.id, { name: 'B' });
    await a.col.sync(server.transport);
    await b.col.sync(server.transport);
    await a.col.sync(server.transport);
    const winner = a.col.deviceId > b.col.deviceId ? 'A' : 'B';
    expect((await a.col.deckTree())[0]!.path).toBe(winner);
    await expectConverged(a, b, server);
  });

  it('delete versus edit: whichever happened later wins', async () => {
    // Edit after delete: the row comes back.
    let w = await world();
    w.a.clock.now += 1000;
    w.b.clock.now += 2000;
    await w.a.col.deleteDeck(w.deck.id);
    await w.b.col.updateDeck(w.deck.id, { name: 'Edited later' });
    for (const c of [w.a, w.b, w.a]) await c.col.sync(w.server.transport);
    expect((await w.a.col.deckTree()).map((n) => n.path)).toEqual(['Edited later']);
    await expectConverged(w.a, w.b, w.server);

    // Delete after edit: it stays deleted.
    w = await world();
    w.a.clock.now += 2000;
    w.b.clock.now += 1000;
    await w.a.col.deleteDeck(w.deck.id);
    await w.b.col.updateDeck(w.deck.id, { name: 'Edited earlier' });
    for (const c of [w.b, w.a, w.b]) await c.col.sync(w.server.transport);
    expect(await w.b.col.deckTree()).toEqual([]);
    await expectConverged(w.a, w.b, w.server);
  });

  it('a client offline for a long time catches up, in several batches each way', async () => {
    const { server, a, b, deck } = await world();
    // B goes offline and keeps working; A carries on and syncs.
    for (let i = 0; i < 260; i++) {
      a.clock.now += 1000;
      await a.col.addNote({ noteTypeId: BASIC_ID, deckId: deck.id, fields: [`a${i}`, 'x'] });
    }
    await a.col.sync(server.transport);
    b.clock.now += 40 * DAY_MS;
    for (let i = 0; i < 130; i++) {
      b.clock.now += 1000;
      await b.col.addNote({ noteTypeId: BASIC_ID, deckId: deck.id, fields: [`b${i}`, 'x'] });
    }
    let pushes = 0;
    let pulls = 0;
    const counting: SyncTransport = {
      push: (body) => (pushes++, server.transport.push(body)),
      pull: (since, limit) => (pulls++, server.transport.pull(since, limit)),
    };
    const result = await b.col.sync(counting);
    expect(result.pushed).toBe(260); // 130 notes and their cards
    expect(pushes).toBeGreaterThan(1);
    expect(pulls).toBeGreaterThan(1);
    await a.col.sync(server.transport);
    expect((await a.col.searchCards('')).total).toBe(391);
    expect((await b.col.searchCards('')).total).toBe(391);
    await expectConverged(a, b, server);
  }, 60_000);

  it('a pull interrupted halfway resumes where it stopped', async () => {
    const { server, a, b, deck } = await world();
    for (let i = 0; i < 300; i++) {
      a.clock.now += 1000;
      await a.col.addNote({ noteTypeId: BASIC_ID, deckId: deck.id, fields: [`n${i}`, 'x'] });
    }
    await a.col.sync(server.transport);

    let page = 0;
    const sinceSeen: number[] = [];
    const breaking: SyncTransport = {
      ...server.transport,
      pull: async (since, limit) => {
        sinceSeen.push(since);
        if (++page === 2) throw new Error('network down');
        return server.transport.pull(since, limit);
      },
    };
    await expect(b.col.sync(breaking)).rejects.toThrow('network down');
    const partial = (await b.col.searchCards('')).total;
    expect(partial).toBeGreaterThan(1);
    expect(partial).toBeLessThan(301);

    await b.col.sync(breaking);
    // The retry started from the first page's cursor, not from the beginning.
    expect(sinceSeen[2]).toBe(sinceSeen[1]);
    expect(sinceSeen[2]).toBeGreaterThan(sinceSeen[0]!);
    expect((await b.col.searchCards('')).total).toBe(301);
    await expectConverged(a, b, server);
  }, 60_000);

  it('a row edited again while its push is in flight stays queued', async () => {
    const { server, a, b, deck } = await world();
    a.clock.now += 1000;
    await a.col.updateDeck(deck.id, { name: 'One' });
    let edited = false;
    const racing: SyncTransport = {
      ...server.transport,
      push: async (body) => {
        const res = await server.transport.push(body);
        if (!edited) {
          edited = true;
          a.clock.now += 1000;
          await a.col.updateDeck(deck.id, { name: 'Two' }); // The user keeps editing mid-request.
        }
        return res;
      },
    };
    await a.col.sync(racing);
    expect(await a.col.pendingCount()).toBe(0);
    await b.col.sync(server.transport);
    expect((await b.col.deckTree())[0]!.path).toBe('Two');
    await expectConverged(a, b, server);
  });

  it('keeps both review-log entries when two offline devices review the same card', async () => {
    const { server, a, b, card } = await world();
    a.clock.now += 1000;
    b.clock.now += 2000;
    await a.col.answerCard(card.id, 1, 500);
    const later = await b.col.answerCard(card.id, 4, 500);
    for (const c of [a, b, a]) await c.col.sync(server.transport);

    for (const c of [a, b, server]) {
      const log = (await c.col.db.select().from(reviewLog)).filter((l) => l.cardId === card.id);
      expect(log.map((l) => l.rating).sort()).toEqual([1, 4]);
    }
    // Accepted limitation: the card's schedule is the later review's, not a replay of both.
    const onA = (await a.col.searchCards('')).rows[0]!.card;
    expect(onA.state).toBe(State.Review);
    expect(onA.due).toBe(later.due);
    await expectConverged(a, b, server);
  });

  it('an undone review is undone everywhere', async () => {
    const { server, a, b, card } = await world();
    a.clock.now += 1000;
    await a.col.answerCard(card.id, 4, 500);
    await a.col.sync(server.transport);
    await b.col.sync(server.transport);
    a.clock.now += 1000;
    await a.col.undoLastReview();
    await a.col.sync(server.transport);
    await b.col.sync(server.transport);
    const log = await b.col.db.select().from(reviewLog);
    expect(log).toHaveLength(1);
    expect(log[0]!.deletedAt).not.toBeNull();
    expect((await b.col.searchCards('')).rows[0]!.card.state).toBe(State.New);
    // The daily allowance on B is restored too.
    expect((await b.col.deckTree())[0]!.due.new).toBe(1);
    await expectConverged(a, b, server);
  });

  it('review-log rows are never overwritten by a resend with different content', async () => {
    const { server, a, card } = await world();
    a.clock.now += 1000;
    await a.col.answerCard(card.id, 3, 500);
    let body: PushRequest | undefined;
    await a.col.sync({ ...server.transport, push: (b) => ((body = b), server.transport.push(b)) });
    const entry = body!.changes.find((c) => c.table === 'review_log')!;
    const tampered = { ...entry, row: { ...entry.row, rating: 1, modifiedAt: entry.row.modifiedAt + 99_999 } };
    expect((await server.transport.push({ deviceId: 'x', changes: [tampered] })).applied).toBe(0);
    expect((await server.col.db.select().from(reviewLog))[0]!.rating).toBe(3);
  });

  it('purges long-deleted rows on every device, and does not let a stale device resurrect them', async () => {
    const { server, a, b, deck } = await world();
    a.clock.now += 1000;
    await a.col.deleteDeck(deck.id);
    await a.col.sync(server.transport);

    // B is offline, and edits the deck it does not know was deleted. 31 days pass.
    b.clock.now += 31 * DAY_MS;
    await b.col.updateDeck(deck.id, { name: 'Back from the dead' });
    const purged = await server.col.purgeDeleted(a.clock.now + 30 * DAY_MS + 1);
    expect(purged).toBe(3); // deck, note, card

    await a.col.sync(server.transport);
    expect(await a.col.db.select().from(decks)).toEqual([]);

    await b.col.sync(server.transport);
    expect(await server.col.db.select().from(decks)).toEqual([]);
    expect(await b.col.db.select().from(decks)).toEqual([]);
    expect(await b.col.db.select().from(outbox)).toEqual([]);
    await expectConverged(a, b, server);
  });

  it('three devices making unrelated changes offline all converge', async () => {
    const { server, a, b, deck } = await world();
    const c = await makeClient();
    await c.col.sync(server.transport);
    a.clock.now += 1000;
    b.clock.now += 2000;
    c.clock.now += 3000;
    await a.col.addNote({ noteTypeId: BASIC_ID, deckId: deck.id, fields: ['a', 'x'], tags: ['one'] });
    await b.col.createDeck({ name: 'B deck', parentId: deck.id });
    await c.col.updateDeck(deck.id, { newPerDay: 5 });
    for (const x of [a, b, c, a, b, c]) await x.col.sync(server.transport);
    expect((await c.col.deckTree()).map((n) => n.path)).toEqual(['Shared', 'Shared::B deck']);
    expect((await a.col.getDeck(deck.id)).newPerDay).toBe(5);
    await expectConverged(a, b, c, server);
  });

  it('two fresh devices do not duplicate the built-in note types', async () => {
    const server = await makeServer();
    const a = await makeClient();
    const b = await makeClient();
    await a.col.sync(server.transport);
    await b.col.sync(server.transport);
    await a.col.sync(server.transport);
    expect((await a.col.listNoteTypes()).map((t) => t.name)).toEqual(['Basic', 'Basic (and reversed card)', 'Cloze']);
    await expectConverged(a, b, server);
  });

  it('rejects malformed pushes without applying anything', async () => {
    const { server, a, deck } = await world();
    const before = await serverVersion(server.col);
    const good = { table: 'decks', row: { ...(await a.col.getDeck(deck.id)), name: 'Sneaky', modifiedAt: 9e15 } };
    for (const changes of [
      [good, { table: 'sessions', row: { id: 'x', modifiedAt: 1 } }],
      [good, { table: 'decks', row: { id: 'x' } }],
      [good, { table: 'decks', row: { id: 'x', modifiedAt: 1, modifiedBy: 'd' } }],
    ]) {
      await expect(server.transport.push({ deviceId: 'x', changes } as never)).rejects.toThrow(/400/);
    }
    // The valid first change of each batch was rolled back with the rest.
    expect(await serverVersion(server.col)).toBe(before);
    expect((await server.col.getDeck(deck.id)).name).toBe('Shared');
  });
});
