import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRecord, BridgeError, LEASE_MS, RECHECK_MS, SOURCE, type Post, type RecordState, type Source } from '../src/core.ts';
import { runDelivery, type Activation, type DeliveryStore } from '../src/delivery.ts';
import type { EditOutcome, SendOutcome, TelegramDestination } from '../src/telegram.ts';

const START = 1_794_500_000_000;
const DESTINATION = { botId: 123456789, chatId: -1001234567890 };

function harness() {
  let now = START;
  let activation: Activation | undefined;
  let leaseExpires = 0;
  let attempt = 0;
  const records = new Map<string, RecordState>();
  const posts = new Map<string, Post>();
  const calls: { kind: 'send' | 'edit'; html: string; messageId?: number }[] = [];
  const flags = { failSavingReceipt: false, send: { kind: 'sent', messageId: 42 } as SendOutcome,
    edit: { kind: 'edited' } as EditOutcome };
  const store: DeliveryStore = {
    claim: async (_token, start) => {
      if (leaseExpires > start) return false;
      leaseExpires = start + LEASE_MS;
      return true;
    },
    records: async ids => ids.map(id => structuredClone(records.get(id))),
    commit: async (_token, updates) => {
      for (const record of updates) assertRecord(record);
      if (flags.failSavingReceipt && updates.some(r => r.stage === 'sent')) throw new Error('Redis unavailable');
      for (const record of updates) records.set(record.id, structuredClone(record));
    },
    activation: async () => activation,
    activate: async (_token, value) => { activation = value; },
    pendingAfter: async (since, limit) => [...records.values()].filter(r =>
      r.stage === 'pending' && r.availability === 'available' && r.createdAt > since)
      .sort((a, b) => a.createdAt - b.createdAt).slice(0, limit).map(r => r.id),
    postedDue: async (when, limit) => [...records.values()].filter(r =>
      r.stage === 'sent' && r.nextCheckAt <= when).slice(0, limit).map(r => r.id),
    hasPendingRemovals: async () => [...records.values()].some(r => r.stage === 'sent' && r.availability === 'unavailable'),
  };
  const source: Source = {
    latest: async () => [...posts.values()],
    byId: async id => {
      const post = posts.get(id);
      if (!post) throw new BridgeError('POST_NOT_FOUND');
      return post;
    },
  };
  const telegram = {
    resolveChat: async () => ({ ...DESTINATION, title: 'GLR', botUsername: 'test_bot' }),
    send: async (_target: TelegramDestination, html: string): Promise<SendOutcome> => {
      assert.ok([...records.values()].some(record => record.stage === 'reserved'), 'reserve before network write');
      calls.push({ kind: 'send', html });
      return flags.send;
    },
    edit: async (_target: TelegramDestination, messageId: number, html: string): Promise<EditOutcome> => {
      calls.push({ kind: 'edit', html, messageId });
      return flags.edit;
    },
  };
  const addPost = (id: string, createdAt: number) => {
    const post: Post = { id: `t3_${id}`, subredditName: SOURCE, createdAt, title: 'Game <Beta>',
      permalink: `/r/${SOURCE}/comments/${id}/game/`, nsfw: false, unavailable: false, stickied: false };
    posts.set(post.id, post);
    records.set(post.id, { id: post.id, stage: 'pending', availability: 'available', createdAt,
      discoveredAt: now, lastCheckedAt: now, nextCheckAt: now + RECHECK_MS, failures: 0 });
    return post;
  };
  const run = (enabled = true, destination = DESTINATION) =>
    runDelivery(store, source, telegram, destination, enabled, `attempt-${++attempt}`, () => now);
  const advance = (ms = 300_000) => { now += ms; };
  async function freshPost() {
    assert.equal((await run()).status, 'activated');
    advance();
    return addPost('new', START + 1000);
  }
  return { run, advance, addPost, freshPost, source, records, posts, calls, flags };
}

test('delivery is off initially and starts with a fresh cutoff before sending new posts once', async () => {
  const h = harness();
  h.addPost('old', START - 1000);
  assert.equal((await h.run(false)).status, 'off');
  h.advance();
  assert.equal((await h.run()).status, 'activated');
  const next = h.addPost('new', START + 301_000);
  h.advance();
  assert.equal((await h.run()).sent, 1);
  assert.equal(h.records.get(next.id)?.messageId, 42);
  assert.equal(h.records.get('t3_old')?.stage, 'pending');
  h.advance();
  assert.equal((await h.run()).sent, 0);
  assert.deepEqual(h.calls, [{ kind: 'send', html: `<b>Game &lt;Beta&gt;</b>\nhttps://www.reddit.com${next.permalink}` }]);
});

test('uncertain sends and lost receipts leave durable reservations without replay', async () => {
  for (const lostReceipt of [false, true]) {
    const h = harness();
    const post = await h.freshPost();
    h.flags.failSavingReceipt = lostReceipt;
    if (!lostReceipt) h.flags.send = { kind: 'unknown' };
    const first = await h.run();
    assert.equal(first.needsAttention?.code, lostReceipt ? 'TELEGRAM_RECEIPT_UNSAVED' : 'TELEGRAM_SEND_UNCONFIRMED');
    assert.equal(h.records.get(post.id)?.stage, 'reserved');
    h.advance();
    assert.equal((await h.run()).sent, 0);
    assert.equal(h.calls.length, 1);
  }
});

test('Telegram 429 allows a retry only after the requested cooldown', async () => {
  const h = harness();
  const post = await h.freshPost();
  h.flags.send = { kind: 'rejected', code: 429, retryAfter: 600 };
  assert.equal((await h.run()).needsAttention?.code, 'TELEGRAM_SEND_429');
  assert.equal(h.records.get(post.id)?.stage, 'pending');
  h.advance();
  assert.equal((await h.run()).sent, 0);
  assert.equal(h.calls.length, 1);
  h.advance();
  h.flags.send = { kind: 'sent', messageId: 42 };
  assert.equal((await h.run()).sent, 1);
});

test('an inaccessible post is skipped before sending when its collected ID is still pending', async () => {
  const h = harness();
  const post = await h.freshPost();
  h.posts.delete(post.id);
  assert.equal((await h.run()).sent, 0);
  assert.equal(h.records.get(post.id)?.availability, 'unavailable');
  assert.deepEqual(h.calls, []);
});

test('a missing original changes the existing Telegram text even while new sends are paused', async () => {
  const h = harness();
  const post = await h.freshPost();
  await h.run();
  h.advance(RECHECK_MS);
  h.posts.delete(post.id);
  const review = await h.run(false);
  assert.equal(review.redacted, 1);
  assert.deepEqual(h.calls.at(-1), { kind: 'edit', messageId: 42, html: 'Исходная публикация недоступна.' });
  const record = h.records.get(post.id);
  assert.equal(record?.stage, 'redacted');
  assert.equal(record?.fingerprint, undefined);
});

test('a source outage schedules a recheck and a changed title edits the same receipt when it returns', async () => {
  const h = harness();
  const post = await h.freshPost();
  await h.run();
  const read = h.source.byId;
  h.source.byId = async () => { throw new Error('source timeout'); };
  h.advance(RECHECK_MS);
  assert.equal((await h.run(false)).unknown, 1);
  assert.equal(h.calls.length, 1);
  h.source.byId = read;
  post.title = 'New title & fix';
  h.advance();
  assert.equal((await h.run(false)).updated, 1);
  assert.deepEqual(h.calls.at(-1), { kind: 'edit', messageId: 42,
    html: `<b>New title &amp; fix</b>\nhttps://www.reddit.com${post.permalink}` });
});

test('a failed redaction pauses new sends and preserves the mapping to its original destination', async () => {
  const h = harness();
  const post = await h.freshPost();
  await h.run();
  h.posts.delete(post.id);
  h.flags.edit = { kind: 'rejected', code: 403 };
  h.advance(RECHECK_MS);
  assert.equal((await h.run()).needsAttention?.code, 'TELEGRAM_EDIT_403');
  assert.equal(h.records.get(post.id)?.stage, 'sent');
  h.addPost('later', START + 2000);
  h.advance(70_000);
  assert.equal((await h.run()).status, 'removal-pending');
  h.advance();
  await assert.rejects(h.run(true, { ...DESTINATION, chatId: -4 }), /TELEGRAM_DESTINATION_CHANGED/);
  assert.equal(h.calls.length, 2);
});
