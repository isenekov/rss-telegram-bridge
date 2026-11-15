import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRecord, BridgeError, RECHECK_MS, SOURCE, type Post, type RecordState, type Source } from '../src/core.ts';
import type { Activation, DeliveryStore } from '../src/delivery.ts';
import { sendFiveLatest } from '../src/manual.ts';
import type { SendOutcome, TelegramDestination } from '../src/telegram.ts';

const NOW = 1_794_500_000_000;
const TARGET: TelegramDestination = { botId: 123456789, chatId: -1001234567890 };

function harness() {
  let now = NOW;
  let activation: Activation | undefined = { ...TARGET, startedAt: NOW - 5_000 };
  const records = new Map<string, RecordState>();
  const posts = Array.from({ length: 7 }, (_, i): Post => {
    const id = `p${i}`;
    return {
      id: `t3_${id}`, subredditName: SOURCE, title: `Game ${i}`,
      permalink: `/r/${SOURCE}/comments/${id}/title/`,
      createdAt: NOW - (i + 1) * 60_000, unavailable: false, nsfw: false, stickied: false,
    };
  });
  const sent: string[] = [];
  let sends = 0;
  let response: SendOutcome = { kind: 'sent', messageId: 100 };
  const store: DeliveryStore = {
    claim: async () => true,
    records: async ids => ids.map(id => records.get(id) && structuredClone(records.get(id))),
    commit: async (_token, changes) => { changes.forEach(assertRecord); for (const r of changes) records.set(r.id, structuredClone(r)); },
    activation: async () => activation,
    activate: async (_token, value) => { activation = value; },
    pendingAfter: async () => [],
    postedDue: async () => [],
    hasPendingRemovals: async () => false,
  };
  const source: Source = {
    latest: async () => [...posts],
    byId: async id => {
      const p = posts.find(p => p.id === id);
      if (!p) throw new BridgeError('POST_NOT_FOUND');
      return p;
    },
  };
  const telegram = {
    resolveChat: async () => ({ ...TARGET, title: 'GLAR', botUsername: 'test_bot' }),
    send: async (_target: TelegramDestination, html: string): Promise<SendOutcome> => {
      sends++;
      assert.ok([...records.values()].some(r => r.stage === 'reserved'));
      sent.push(html);
      return response.kind === 'sent' ? { kind: 'sent', messageId: 100 + sends } : response;
    },
  };
  const run = () => sendFiveLatest(store, source, telegram, TARGET, 'manual-token', () => now);
  return { run, posts, records, sent, get sends() { return sends; },
    setResponse: (x: SendOutcome) => { response = x; },
    setActivation: (x?: Activation) => { activation = x; },
    advance: () => { now += 120_000; },
  };
}

test('manual send chooses exactly five newest eligible posts, including preactivation', async () => {
  const h = harness();
  h.posts[0]!.stickied = true;
  const result = await h.run();
  assert.deepEqual({ status: result.status, selected: result.selected, sent: result.sent }, { status: 'ok', selected: 5, sent: 5 });
  assert.equal(h.records.get('t3_p1')?.stage, 'sent');
  assert.equal(h.records.get('t3_p5')?.stage, 'sent');
  assert.equal(h.records.has('t3_p6'), false);
  assert.equal(h.sent.length, 5);
  h.advance();
  assert.equal((await h.run()).sent, 0);
  assert.equal(h.sent.length, 5, 'never resend already tracked messages');
});

test('uncertain send remains reserved and cannot be repeated', async () => {
  const h = harness();
  h.setResponse({ kind: 'unknown' });
  const first = await h.run();
  assert.equal(first.sent, 0);
  assert.equal(first.needsAttention?.code, 'TELEGRAM_SEND_UNCONFIRMED');
  assert.equal(h.records.get('t3_p0')?.stage, 'reserved');
  h.advance();
  h.setResponse({ kind: 'sent', messageId: 200 });
  const second = await h.run();
  assert.equal(second.skipped, 1);
  assert.equal(second.sent, 4);
  assert.equal(h.sends, 5, 'the uncertain first post must not be resent');
});

test('definite rejection remains retryable only after cooldown', async () => {
  const h = harness();
  h.setResponse({ kind: 'rejected', code: 429, retryAfter: 120 });
  const result = await h.run();
  assert.equal(result.needsAttention?.code, 'TELEGRAM_SEND_429');
  assert.equal(h.records.get('t3_p0')?.stage, 'baseline');
  assert.ok(h.records.get('t3_p0')?.retryDeliveryAt);
  h.setResponse({ kind: 'sent', messageId: 200 });
  assert.equal((await h.run()).sent, 4);
  assert.equal(h.sends, 5);
  h.advance();
  assert.equal((await h.run()).sent, 1);
});

test('manual action refuses sending without active verified installation', async () => {
  const h = harness();
  h.setActivation(undefined);
  await assert.rejects(h.run(), /TELEGRAM_NOT_ACTIVATED/);
  assert.equal(h.sends, 0);
});

test('manual action rejects changes to the linked destination', async () => {
  const h = harness();
  h.setActivation({ ...TARGET, chatId: -1009876543210, startedAt: NOW - 5_000 });
  await assert.rejects(h.run(), /TELEGRAM_DESTINATION_CHANGED/);
  assert.equal(h.sends, 0);
});
