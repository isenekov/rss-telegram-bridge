/** Read-only collection stage. No Telegram calls or credentials belong here. */
export const SOURCE = 'GamingLeaksAndRumours';
export const MAX_SCAN = 500;
export const OVERLAP_MS = 10 * 60_000;
export const RETENTION_MS = 30 * 24 * 60 * 60_000;
export const LEASE_MS = 60_000;
export const RECHECK_MS = 60 * 60_000;

export type Post = {
  id: string;
  subredditName: string;
  title: string;
  permalink: string;
  createdAt: number;
  unavailable: boolean;
  nsfw: boolean;
  stickied: boolean;
};
export type RecordState = {
  id: string;
  createdAt: number;
  discoveredAt: number;
  stage: 'baseline' | 'pending' | 'sent';
  availability: 'available' | 'unavailable' | 'unknown';
  lastCheckedAt: number;
  nextCheckAt: number;
  failures: number;
  // Reserved for the future, reviewed delivery stage. Never store titles/bodies.
  messageId?: number;
};
export type Checkpoint = {
  version: 1;
  source: typeof SOURCE;
  startedAt: number;
  scannedAt: number;
};
export interface Store {
  claim(token: string, now: number): Promise<boolean>;
  checkpoint(): Promise<Checkpoint | undefined>;
  records(ids: string[]): Promise<(RecordState | undefined)[]>;
  commit(token: string, records: RecordState[], checkpoint?: Checkpoint): Promise<void>;
  due(now: number, limit: number): Promise<string[]>;
  prune(token: string, before: number): Promise<number>;
}
export interface Source {
  latest(): Promise<Post[]>;
  byId(id: string): Promise<Post>;
}
export class BridgeError extends Error {
  constructor(code: string) { super(code); this.name = 'BridgeError'; }
}
export function assertCheckpoint(value: unknown): asserts value is Checkpoint {
  const c = value as Checkpoint;
  if (!c || c.version !== 1 || c.source !== SOURCE ||
      !Number.isFinite(c.startedAt) || !Number.isFinite(c.scannedAt) ||
      c.startedAt <= 0 || c.scannedAt < c.startedAt) {
    throw new BridgeError('INVALID_CHECKPOINT');
  }
}
export function assertRecord(value: unknown): asserts value is RecordState {
  const r = value as RecordState;
  if (!r || !/^t3_[a-z0-9]+$/.test(r.id) ||
      !['baseline', 'pending', 'sent'].includes(r.stage) ||
      !['available', 'unavailable', 'unknown'].includes(r.availability) ||
      ![r.createdAt, r.discoveredAt, r.lastCheckedAt, r.nextCheckAt, r.failures].every(Number.isFinite) ||
      r.createdAt <= 0 || r.failures < 0 || !Number.isInteger(r.failures) ||
      (r.stage === 'sent' && (!Number.isSafeInteger(r.messageId) || r.messageId! <= 0))) {
    throw new BridgeError('INVALID_RECORD');
  }
}
export function validPost(p: Post, now: number): boolean {
  return /^t3_[a-z0-9]+$/.test(p.id) &&
    p.subredditName.toLowerCase() === SOURCE.toLowerCase() &&
    Number.isFinite(p.createdAt) && p.createdAt > 0 && p.createdAt <= now + 60_000 &&
    p.permalink.startsWith(`/r/${SOURCE}/comments/`) &&
    p.permalink.split('/')[4] === p.id.slice(3) &&
    p.title.trim().length > 0;
}
export function sourceUnavailable(p: Post): boolean {
  return p.unavailable || p.nsfw;
}
export type ReadReport = {
  status: 'ok' | 'busy';
  bootstrap: boolean;
  fetched: number;
  added: number;
  duplicates: number;
  checked: number;
  unavailable: number;
  unknown: number;
  pruned: number;
  telegramSent: 0;
};

/**
 * One bounded poll. Writes records and scan watermark together atomically.
 * A 10-minute overlap covers delayed listing visibility; IDs deduplicate it.
 * A full 500-item window without reaching the cursor fails closed.
 */
export async function collect(
  store: Store, source: Source, token: string, clock: () => number = Date.now,
): Promise<ReadReport> {
  const started = clock();
  const report: ReadReport = {
    status: 'ok', bootstrap: false, fetched: 0, added: 0, duplicates: 0,
    checked: 0, unavailable: 0, unknown: 0, pruned: 0, telegramSent: 0,
  };
  if (!await store.claim(token, started)) return { ...report, status: 'busy' };
  const withinBudget = () => {
    if (clock() - started > 20_000) throw new BridgeError('RUN_BUDGET_EXCEEDED');
  };
  const checkpoint = await store.checkpoint();
  if (checkpoint) assertCheckpoint(checkpoint);
  if (checkpoint && checkpoint.scannedAt > started) throw new BridgeError('CLOCK_MOVED_BACKWARDS');

  // Recheck first: a source-listing outage must not starve availability checks.
  for (const id of await store.due(started, 10)) {
    withinBudget();
    const [record] = await store.records([id]);
    if (!record) throw new BridgeError('MISSING_INDEXED_RECORD');
    assertRecord(record);
    const update = { ...record, lastCheckedAt: clock() };
    try {
      const post = await source.byId(id);
      // An SDK/network exception is NOT proof of a deleted Reddit post.
      if (post.id !== id || post.subredditName.toLowerCase() !== SOURCE.toLowerCase()) {
        throw new BridgeError('UNEXPECTED_POST');
      }
      update.availability = sourceUnavailable(post) ? 'unavailable' : 'available';
      update.failures = 0;
      update.nextCheckAt = clock() + RECHECK_MS;
      if (update.availability === 'unavailable') report.unavailable++;
    } catch {
      update.availability = 'unknown';
      update.failures++;
      update.nextCheckAt = clock() + Math.min(RECHECK_MS, 300_000 * 2 ** Math.min(update.failures - 1, 4));
      report.unknown++;
    }
    await store.commit(token, [update]);
    report.checked++;
  }
  withinBudget();
  const posts = await source.latest();
  withinBudget();
  if (posts.length > MAX_SCAN) throw new BridgeError('UNBOUNDED_SOURCE_RESPONSE');
  report.fetched = posts.length;
  // An empty listing from this active source must not erase the catch-up window.
  if (!posts.length) throw new BridgeError('EMPTY_LISTING');
  if (posts.some(p => !validPost(p, started))) throw new BridgeError('INVALID_SOURCE_RESPONSE');
  const cutoff = checkpoint ? Math.max(checkpoint.startedAt, checkpoint.scannedAt - OVERLAP_MS) : started;
  if (checkpoint && posts.length === MAX_SCAN && Math.min(...posts.map(p => p.createdAt)) > cutoff) {
    throw new BridgeError('SCAN_WINDOW_GAP');
  }
  report.bootstrap = !checkpoint;
  const unique = [...new Map(posts.map(p => [p.id, p])).values()];
  const old = await store.records(unique.map(p => p.id));
  const records: RecordState[] = [];
  for (let i = 0; i < unique.length; i++) {
    const post = unique[i]!;
    if (old[i]) { assertRecord(old[i]); report.duplicates++; continue; }
    if (checkpoint && post.createdAt < cutoff) continue;
    const eligible = !!checkpoint && post.createdAt > checkpoint.startedAt &&
      !sourceUnavailable(post) && !post.stickied;
    records.push({
      id: post.id, createdAt: post.createdAt, discoveredAt: started,
      stage: eligible ? 'pending' : 'baseline',
      availability: sourceUnavailable(post) ? 'unavailable' : 'available',
      lastCheckedAt: started, nextCheckAt: started + RECHECK_MS, failures: 0,
    });
    if (eligible) report.added++;
  }
  withinBudget();
  await store.commit(token, records, {
    version: 1, source: SOURCE, startedAt: checkpoint?.startedAt ?? started, scannedAt: started,
  });
  report.pruned = await store.prune(token, started - RETENTION_MS);
  return report;
}

export function messageFor(post: Post): string {
  if (!validPost(post, Date.now()) || sourceUnavailable(post)) throw new BridgeError('UNSAFE_MESSAGE');
  const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const url = `https://www.reddit.com${post.permalink}`;
  // Only a title and original permalink. No body, author, media, or summaries.
  return `<b>${escape([...post.title].slice(0, 300).join(''))}</b>\n${escape(url)}`;
}
