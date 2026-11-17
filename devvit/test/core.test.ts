import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCheckpoint, assertRecord, BridgeError, collect, LEASE_MS, MAX_SCAN, messageFor, RETENTION_MS, SOURCE, type Checkpoint, type Post, type RecordState, type Source, type Store } from '../src/core.ts';
import { makeSource, type SdkPost } from '../src/source.ts';

const START = 1_794_500_000_000;
function post(id = 'abc', createdAt = START - 1000, changes: Partial<Post> = {}): Post {
  return { id: `t3_${id}`, createdAt, title: 'Game <Alpha> & beta', subredditName: SOURCE,
    permalink: `/r/${SOURCE}/comments/${id}/title/`, unavailable: false, nsfw: false, stickied: false, ...changes };
}
class MemoryStore implements Store {
  data = new Map<string, RecordState>();
  cursor: Checkpoint | undefined;
  lease = { token: '', expires: 0 };
  now = START;
  failCommit = false;
  async claim(token: string, now: number) {
    if (this.lease.expires > now) return false;
    this.lease = { token, expires: now + LEASE_MS }; return true;
  }
  async checkpoint() { return this.cursor && structuredClone(this.cursor); }
  async records(ids: string[]) { return ids.map(id => { const v = this.data.get(id); return v && structuredClone(v); }); }
  async commit(token: string, records: RecordState[], checkpoint?: Checkpoint) {
    if (token !== this.lease.token || this.now >= this.lease.expires) throw new BridgeError('LEASE_LOST');
    if (this.failCommit) throw new Error('Injected storage failure');
    records.forEach(assertRecord); if (checkpoint) assertCheckpoint(checkpoint);
    for (const r of records) this.data.set(r.id, structuredClone(r));
    if (checkpoint) this.cursor = structuredClone(checkpoint);
  }
  async due(now: number, limit: number) {
    return [...this.data.values()].filter(r => r.stage !== 'baseline' && r.nextCheckAt <= now)
      .sort((a, b) => a.nextCheckAt - b.nextCheckAt).slice(0, limit).map(r => r.id);
  }
  async prune(token: string, before: number) {
    if (token !== this.lease.token) throw new BridgeError('LEASE_LOST');
    const ids = [...this.data.values()].filter(r => r.stage !== 'sent' && r.createdAt <= before).slice(0, 100).map(r => r.id);
    ids.forEach(id => this.data.delete(id)); return ids.length;
  }
}
function harness() {
  const db = new MemoryStore(); let posts = [post()]; let sequence = 0;
  const source: Source = { latest: async () => structuredClone(posts),
    byId: async id => { const p = posts.find(p => p.id === id); if (!p) throw new Error('API unavailable'); return p; } };
  return { db, source, set: (p: Post[]) => { posts = p; }, run: () => collect(db, source, `run-${++sequence}`, () => db.now),
    advance: (ms = 300_000) => { db.now += ms; } };
}
test('bootstrap records metadata without queuing historical posts', async () => {
  const h = harness(); const r = await h.run();
  assert.equal(r.bootstrap, true); assert.equal(r.added, 0); assert.equal(r.telegramSent, 0);
  assert.equal(h.db.data.get('t3_abc')?.stage, 'baseline');
  const saved = JSON.stringify([...h.db.data.values()]);
  for (const text of ['title', 'permalink', 'author', 'Game', 'token']) assert.ok(!saved.includes(text));
});
test('new IDs are queued once across repeated runs', async () => {
  const h = harness(); await h.run(); h.advance(); h.set([post('new', START + 1000), post()]);
  assert.equal((await h.run()).added, 1); h.advance(); assert.equal((await h.run()).added, 0);
  assert.equal(h.db.data.size, 2); assert.equal(h.db.data.get('t3_new')?.stage, 'pending');
});
test('repeated IDs inside one response are deduplicated', async () => {
  const h = harness(); await h.run(); h.advance(); h.set([post('new', START + 1000), post('new', START + 1000), post()]);
  assert.equal((await h.run()).added, 1);
});
test('old, sticky, removed and NSFW posts are not queued', async () => {
  const h = harness(); await h.run(); h.advance();
  h.set([post('old', START - 5000), post('sticky', START + 1000, { stickied: true }),
    post('nsfw', START + 1000, { nsfw: true }), post('removed', START + 1000, { unavailable: true }), post()]);
  assert.equal((await h.run()).added, 0);
});
test('overlap discovers a late-visible publication', async () => {
  const h = harness(); await h.run(); h.advance(); await h.run(); h.advance();
  h.set([post('late', START + 100_000), post()]); assert.equal((await h.run()).added, 1);
});
test('concurrent polls have one writer', async () => {
  const h = harness(); const r = await Promise.all([h.run(), h.run()]);
  assert.deepEqual(r.map(x => x.status).sort(), ['busy', 'ok']);
});
test('failed source read preserves the checkpoint and recovers', async () => {
  const h = harness(); await h.run(); const cursor = structuredClone(h.db.cursor); h.advance();
  const good = h.source.latest; h.source.latest = async () => { throw new Error('Network failure'); };
  await assert.rejects(h.run()); assert.deepEqual(h.db.cursor, cursor);
  h.source.latest = good; h.advance(); h.set([post('new', START + 1000), post()]); assert.equal((await h.run()).added, 1);
});
test('failed atomic commit cannot lose pending work', async () => {
  const h = harness(); await h.run(); const cursor = structuredClone(h.db.cursor);
  h.advance(); h.set([post('new', START + 1000), post()]); h.db.failCommit = true;
  await assert.rejects(h.run()); assert.deepEqual(h.db.cursor, cursor); assert.equal(h.db.data.size, 1);
  h.db.failCommit = false; h.advance(); assert.equal((await h.run()).added, 1);
});
test('response lost after commit remains idempotent on restart', async () => {
  const h = harness(); await h.run(); h.advance(); h.set([post('new', START + 1000), post()]);
  const commit = h.db.commit.bind(h.db);
  h.db.commit = async (...args) => { await commit(...args); throw new Error('Response lost'); };
  await assert.rejects(h.run()); h.db.commit = commit; h.advance();
  assert.equal((await h.run()).added, 0); assert.equal(h.db.data.size, 2);
});
test('full listing without reaching checkpoint stops instead of silently dropping posts', async () => {
  const h = harness(); await h.run(); h.advance(); const cursor = structuredClone(h.db.cursor);
  h.set(Array.from({ length: MAX_SCAN }, (_, i) => post(`p${i}`, START + 1000 + i)));
  await assert.rejects(h.run(), /SCAN_WINDOW_GAP/); assert.deepEqual(h.db.cursor, cursor);
});
test('full paginated listing reaching checkpoint is accepted', async () => {
  const h = harness(); await h.run(); h.advance();
  h.set([...Array.from({ length: MAX_SCAN - 1 }, (_, i) => post(`p${i}`, START + 1000 + i)), post()]);
  assert.equal((await h.run()).added, MAX_SCAN - 1);
});
test('corrupt checkpoint and records fail closed', async () => {
  const h = harness(); await h.run(); h.advance(); h.db.cursor!.version = 2 as 1;
  await assert.rejects(h.run(), /INVALID_CHECKPOINT/);
  assert.throws(() => assertRecord({ id: 't3_bad' }), /INVALID_RECORD/);
});
test('wrong source, ID, unsafe URL and invalid timestamps are rejected', async () => {
  for (const changes of [{ subredditName: 'unrelated' }, { permalink: 'https://evil.invalid' },
    { id: 't3_another' }, { createdAt: START + 120_000 }]) {
    const h = harness(); h.set([post('abc', START - 1000, changes)]);
    await assert.rejects(h.run(), /INVALID_SOURCE_RESPONSE/);
  }
});
test('empty bootstrap cannot count as verified source access', async () => {
  const h = harness(); h.set([]); await assert.rejects(h.run(), /EMPTY_LISTING/); assert.equal(h.db.cursor, undefined);
});
test('empty response after bootstrap preserves the catch-up checkpoint', async () => {
  const h = harness(); await h.run(); const cursor = structuredClone(h.db.cursor);
  h.advance(); h.set([]); await assert.rejects(h.run(), /EMPTY_LISTING/); assert.deepEqual(h.db.cursor, cursor);
});
test('slow read does not write after the execution budget', async () => {
  const h = harness(); h.source.latest = async () => { h.advance(21_000); return [post()]; };
  await assert.rejects(h.run(), /RUN_BUDGET_EXCEEDED/); assert.equal(h.db.cursor, undefined);
});
test('expired or stolen lease fences a stale writer', async () => {
  const h = harness(); h.source.latest = async () => { h.db.lease.token = 'another'; return [post()]; };
  await assert.rejects(h.run(), /LEASE_LOST/); assert.equal(h.db.cursor, undefined);
});
test('periodic recheck detects explicit unavailability without a source trigger', async () => {
  const h = harness(); await h.run(); h.advance(); h.set([post('new', START + 1000), post()]); await h.run();
  h.advance(3_600_000); h.set([post('new', START + 1000, { unavailable: true }), post()]);
  assert.equal((await h.run()).unavailable, 1); assert.equal(h.db.data.get('t3_new')?.availability, 'unavailable');
});
test('network or permission errors mean unknown, with exponential retry', async () => {
  const h = harness(); await h.run(); h.advance(); h.set([post('new', START + 1000), post()]); await h.run();
  h.advance(3_600_000); h.source.byId = async () => { throw new Error('timeout 403 404'); };
  assert.equal((await h.run()).unknown, 1); assert.equal(h.db.data.get('t3_new')?.availability, 'unknown');
  assert.equal(h.db.data.get('t3_new')?.nextCheckAt, h.db.now + 300_000);
  h.advance(); await h.run(); assert.equal(h.db.data.get('t3_new')?.nextCheckAt, h.db.now + 600_000);
});
test('sent metadata survives retention and is included in availability checks', async () => {
  const h = harness(); await h.run(); h.advance(); h.set([post('new', START + 1000), post()]); await h.run();
  const record = h.db.data.get('t3_new')!; record.stage = 'sent'; record.messageId = 42;
  h.advance(RETENTION_MS + 1000); h.set([post('new', START + 1000, { unavailable: true }), post()]);
  const r = await h.run(); assert.equal(r.unavailable, 1); assert.equal(r.pruned, 1);
  assert.equal(h.db.data.get('t3_new')?.messageId, 42);
});
test('SDK reader explicitly names the foreign source and bounds pagination', async () => {
  let options: unknown;
  const sample: SdkPost = { ...post(), createdAt: new Date(START - 1000), removed: false, spam: false };
  const reader = makeSource({ getNewPosts: o => { options = o; return { all: async () => [sample] }; }, getPostById: async () => sample });
  assert.equal((await reader.latest())[0]?.id, 't3_abc');
  assert.deepEqual(options, { subredditName: SOURCE, limit: 500, pageSize: 100 });
  await assert.rejects(reader.byId('invalid id'), /INVALID_POST_ID/);
});
test('message draft contains only escaped title and original permalink', () => {
  assert.equal(messageFor(post()), `<b>Game &lt;Alpha&gt; &amp; beta</b>\nhttps://www.reddit.com/r/${SOURCE}/comments/abc/title/`);
  assert.throws(() => messageFor(post('abc', START, { unavailable: true })), /UNSAFE_MESSAGE/);
});
