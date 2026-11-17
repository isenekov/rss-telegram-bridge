import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRecord, BridgeError, LEASE_MS, RECHECK_MS, SOURCE, type Post, type RecordState, type Source } from '../src/core.ts';
import { queueLatestFive, runDelivery, type Activation, type DeliveryStore } from '../src/delivery.ts';
import type { EditOutcome, SendOutcome, TelegramDestination } from '../src/telegram.ts';

const START = 1_794_500_000_000;
const DESTINATION = { botId: 123456789, chatId: -1001234567890 };

function harness() {
  let now = START;
  let activation: Activation | undefined;
  let leaseExpires = 0;
  let attempt = 0;
  let requestedIds: string[] | undefined;
  const records = new Map<string, RecordState>();
  const posts = new Map<string, Post>();
  const calls: { kind: 'send' | 'edit'; html: string; messageId?: number }[] = [];
  const flags = { failSavingReceipt: false, loseQueueResponse: false, send: { kind: 'sent', messageId: 42 } as SendOutcome,
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
    requestedLatestFive: async () => requestedIds,
    commitLatestFive: async (token, updates, batch) => {
      await store.commit(token, updates);
      requestedIds = [...batch.ids];
      if (flags.loseQueueResponse) throw new Error('Redis response lost');
    },
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
  const requestLatestFive = () => queueLatestFive(store, source, `attempt-${++attempt}`, () => now);
  const advance = (ms = 300_000) => { now += ms; };
  async function freshPost() {
    assert.equal((await run()).status, 'activated');
    advance();
    return addPost('new', START + 1000);
  }
  return { run, requestLatestFive, advance, addPost, freshPost, source, records, posts, calls, flags };
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

test('a one-time request sends five eligible posts in one run even if they predate activation', async () => {
  const h = harness();
  assert.equal((await h.run()).status, 'activated');
  h.advance();
  for (const number of [5, 1, 6, 3, 2, 4]) {
    const post = h.addPost(`old${number}`, START - 10_000 + number);
    h.records.get(post.id)!.stage = 'baseline';
  }
  h.records.delete('t3_old4');
  h.addPost('sticky', START - 1000).stickied = true;
  h.addPost('removed', START - 999).unavailable = true;
  h.addPost('nsfw', START - 998).nsfw = true;
  assert.deepEqual(await h.requestLatestFive(), { status: 'queued', selected: 5, queued: 5 });
  assert.deepEqual(await h.requestLatestFive(), { status: 'busy' });
  h.advance();
  assert.equal((await h.run(false)).sent, 0);
  assert.equal(h.calls.length, 0);
  h.advance();
  const delivery = await h.run();
  assert.equal(delivery.sent, 5);
  assert.equal(delivery.latestFiveSent, 5);
  assert.deepEqual(h.calls.map(call => call.html.split('/comments/')[1]?.split('/')[0]),
    ['old2', 'old3', 'old4', 'old5', 'old6']);
  h.advance();
  assert.deepEqual(await h.requestLatestFive(), { status: 'already-requested' });
  h.addPost('fresh', START + 1000);
  h.advance();
  const report = await h.run();
  assert.equal(report.sent, 1);
  assert.equal(report.latestFiveSent, 0);
  assert.match(h.calls.at(-1)!.html, /\/comments\/fresh\//);
});

test('the five-post batch shares both receipts and unconfirmed reservations with automatic delivery', async () => {
  const h = harness();
  const sent = await h.freshPost();
  assert.equal((await h.run()).sent, 1);
  h.advance();
  const reserved = h.addPost('unconfirmed', START + 2000);
  h.flags.send = { kind: 'unknown' };
  assert.equal((await h.run()).needsAttention?.code, 'TELEGRAM_SEND_UNCONFIRMED');
  h.advance();
  for (const number of [1, 2, 3, 4]) h.addPost(`old${number}`, START - 10_000 + number);
  assert.deepEqual(await h.requestLatestFive(), { status: 'queued', selected: 5, queued: 3 });
  assert.equal(h.records.get(sent.id)?.stage, 'sent');
  assert.equal(h.records.get(reserved.id)?.stage, 'reserved');
  h.flags.send = { kind: 'sent', messageId: 43 };
  h.advance();
  assert.equal((await h.run()).sent, 3);
  h.advance();
  assert.equal((await h.run()).sent, 0);
  assert.deepEqual(h.calls.map(call => call.html.split('/comments/')[1]?.split('/')[0]),
    ['new', 'unconfirmed', 'old2', 'old3', 'old4']);
});

test('an incomplete listing leaves the one-time request available and a lost commit response cannot repeat it', async () => {
  const h = harness();
  assert.equal((await h.run()).status, 'activated');
  h.advance();
  for (const number of [1, 2, 3, 4]) h.addPost(`old${number}`, START - 10_000 + number);
  await assert.rejects(h.requestLatestFive(), /FEWER_THAN_FIVE_ELIGIBLE_POSTS/);
  h.advance();
  h.addPost('old5', START - 9995);
  h.flags.loseQueueResponse = true;
  await assert.rejects(h.requestLatestFive(), /Redis response lost/);
  h.advance();
  h.addPost('old6', START - 9994);
  assert.deepEqual(await h.requestLatestFive(), { status: 'already-requested' });
  h.advance();
  assert.equal((await h.run()).sent, 5);
  assert.equal(h.records.get('t3_old6')?.latestFiveRequestedAt, undefined);
});

test('ordinary delivery leaves the sixth eligible post for the next run', async () => {
  const h = harness();
  assert.equal((await h.run()).status, 'activated');
  h.advance();
  for (const number of [1, 2, 3, 4, 5, 6]) h.addPost(`new${number}`, START + number);
  assert.equal((await h.run()).sent, 5);
  assert.equal(h.records.get('t3_new6')?.stage, 'pending');
  h.advance();
  assert.equal((await h.run()).sent, 1);
  assert.equal(h.records.get('t3_new6')?.stage, 'sent');
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

test('a missing original preserves the Telegram message and its receipt while new sends are paused', async () => {
  const h = harness();
  const post = await h.freshPost();
  await h.run();
  const originalMessage = structuredClone(h.calls);
  const originalReceipt = structuredClone(h.records.get(post.id)!);
  h.advance(RECHECK_MS);
  h.posts.delete(post.id);
  const review = await h.run(false);
  assert.equal(review.redacted, 0);
  assert.equal(review.updated, 0);
  assert.deepEqual(h.calls, originalMessage);
  const record = h.records.get(post.id);
  assert.equal(record?.stage, 'sent');
  assert.equal(record?.availability, 'unavailable');
  assert.equal(record?.messageId, originalReceipt.messageId);
  assert.equal(record?.fingerprint, originalReceipt.fingerprint);
  h.advance(RECHECK_MS);
  await h.run(false);
  assert.deepEqual(h.calls, originalMessage);
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

test('removed posts and older unavailable receipts allow new sends with duplicate protection', async () => {
  for (const alreadyUnavailable of [false, true]) {
    const h = harness();
    const post = await h.freshPost();
    await h.run();
    const previous = h.records.get(post.id)!;
    if (alreadyUnavailable) previous.availability = 'unavailable';
    post.unavailable = true;
    h.flags.edit = { kind: 'rejected', code: 403 };
    h.addPost('later', START + 2000);
    h.advance(RECHECK_MS);
    const report = await h.run();
    assert.equal(report.status, 'ok');
    assert.equal(report.sent, 1);
    assert.equal(report.redacted, 0);
    assert.equal(report.needsAttention, undefined);
    assert.equal(h.records.get(post.id)?.stage, 'sent');
    assert.equal(h.records.get(post.id)?.fingerprint, previous.fingerprint);
    assert.equal(h.calls.length, 2);
    assert.ok(h.calls.every(call => call.kind === 'send'));
    h.advance(RECHECK_MS);
    assert.equal((await h.run()).sent, 0);
    assert.equal(h.calls.length, 2);
    h.advance();
    await assert.rejects(h.run(true, { ...DESTINATION, chatId: -4 }), /TELEGRAM_DESTINATION_CHANGED/);
  }
});

test('unavailable receipts are checked again and old redacted messages stay untouched', async () => {
  const h = harness();
  const post = await h.freshPost();
  await h.run();
  h.records.get(post.id)!.availability = 'unavailable';
  post.title = 'Visible again';
  h.advance(RECHECK_MS);
  assert.equal((await h.run(false)).updated, 1);
  assert.equal(h.records.get(post.id)?.availability, 'available');
  const redacted = h.addPost('legacy', START + 2000);
  const oldRecord = h.records.get(redacted.id)!;
  oldRecord.stage = 'redacted';
  oldRecord.messageId = 99;
  h.advance(RECHECK_MS);
  const review = await h.run();
  assert.equal(review.sent, 0);
  assert.equal(review.updated, 0);
  assert.equal(h.records.get(redacted.id)?.stage, 'redacted');
  assert.equal(h.calls.length, 2);
});
