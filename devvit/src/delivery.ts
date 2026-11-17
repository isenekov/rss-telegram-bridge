import { createHash } from 'node:crypto';
import {
  assertRecord, BridgeError, MAX_SCAN, messageFor, RECHECK_MS, SOURCE, sourceUnavailable, validPost,
  type Post, type RecordState, type Source, type Store,
} from './core.ts';
import { deliverOnce, type TelegramClient, type TelegramDestination } from './telegram.ts';

const MAX_SENDS = 5;
const MAX_REVIEWS = 10;
const LATEST_POST_COUNT = 5;
const REQUEST_BUDGET_MS = 18_000;
const fingerprint = (html: string) => createHash('sha256').update(html).digest('hex');

export type Activation = TelegramDestination & { startedAt: number };
export type LatestFive = { ids: string[]; requestedAt: number };
export interface DeliveryStore extends Pick<Store, 'claim' | 'records' | 'commit'> {
  activation(): Promise<Activation | undefined>;
  activate(token: string, value: Activation): Promise<void>;
  pendingAfter(startedAt: number, limit: number): Promise<string[]>;
  postedDue(now: number, limit: number): Promise<string[]>;
  hasPendingRemovals(): Promise<boolean>;
  requestedLatestFive(): Promise<string[] | undefined>;
  commitLatestFive(token: string, records: RecordState[], batch: LatestFive): Promise<void>;
}
type Transport = Pick<TelegramClient, 'send' | 'edit' | 'resolveChat'>;
type PostStatus = { kind: 'visible'; post: Post } | { kind: 'unavailable' } | { kind: 'unknown' };

export function assertActivation(value: unknown): asserts value is Activation {
  const activation = value as Activation;
  if (!activation || !Number.isSafeInteger(activation.startedAt) || activation.startedAt <= 0 ||
      !Number.isSafeInteger(activation.chatId) || activation.chatId >= 0 ||
      !Number.isSafeInteger(activation.botId) || activation.botId <= 0) {
    throw new BridgeError('INVALID_TELEGRAM_ACTIVATION');
  }
}

export function assertLatestFiveIds(ids: unknown): asserts ids is string[] {
  if (!Array.isArray(ids) || ids.length !== LATEST_POST_COUNT || new Set(ids).size !== LATEST_POST_COUNT ||
      ids.some(id => typeof id !== 'string' || !/^t3_[a-z0-9]+$/.test(id))) {
    throw new BridgeError('INVALID_LATEST_FIVE_IDS');
  }
}

type LatestFiveReport = { status: 'busy' } | { status: 'already-requested' } |
  { status: 'queued'; selected: number; queued: number };

export async function queueLatestFive(
  store: DeliveryStore, source: Source, token: string, clock: () => number = Date.now,
): Promise<LatestFiveReport> {
  const started = clock();
  if (!await store.claim(token, started)) return { status: 'busy' };
  if (await store.requestedLatestFive() !== undefined) return { status: 'already-requested' };
  if (!await store.activation()) throw new BridgeError('TELEGRAM_NOT_ACTIVATED');

  const posts = await source.latest();
  if (posts.length > MAX_SCAN || posts.some(post => !validPost(post, started))) {
    throw new BridgeError('INVALID_SOURCE_RESPONSE');
  }
  const eligible = posts.filter(post => !sourceUnavailable(post) && !post.stickied);
  const latest = [...new Map(eligible.map(post => [post.id, post])).values()]
    .sort((a, b) => b.createdAt - a.createdAt).slice(0, LATEST_POST_COUNT).reverse();
  if (latest.length < LATEST_POST_COUNT) throw new BridgeError('FEWER_THAN_FIVE_ELIGIBLE_POSTS');
  const ids = latest.map(post => post.id);
  const existing = await store.records(ids);
  const requestedAt = clock();
  if (requestedAt - started >= REQUEST_BUDGET_MS) throw new BridgeError('RUN_BUDGET_EXCEEDED');

  const records: RecordState[] = [];
  latest.forEach((post, index) => {
    const previous = existing[index];
    if (previous && previous.stage !== 'baseline' && previous.stage !== 'pending') return;
    records.push({
      ...previous, id: post.id, createdAt: post.createdAt, discoveredAt: previous?.discoveredAt ?? requestedAt,
      stage: 'pending', availability: 'available', lastCheckedAt: requestedAt,
      nextCheckAt: requestedAt + RECHECK_MS, failures: 0, latestFiveRequestedAt: requestedAt,
    });
  });
  await store.commitLatestFive(token, records, { ids, requestedAt });
  return { status: 'queued', selected: ids.length, queued: records.length };
}

async function lookup(source: Source, id: string, now: number): Promise<PostStatus> {
  try {
    const post = await source.byId(id);
    if (post.id !== id || post.subredditName.toLowerCase() !== SOURCE.toLowerCase()) return { kind: 'unknown' };
    if (sourceUnavailable(post)) return { kind: 'unavailable' };
    return validPost(post, now) ? { kind: 'visible', post } : { kind: 'unknown' };
  } catch (error) {
    if (error instanceof BridgeError && error.message === 'POST_NOT_FOUND') return { kind: 'unavailable' };
    return { kind: 'unknown' };
  }
}

function retryReview(record: RecordState, now: number, retryAfter = 0) {
  const failures = record.failures + 1;
  const delay = Math.min(RECHECK_MS, 300_000 * 2 ** Math.min(failures - 1, 4));
  return { ...record, failures, nextCheckAt: now + Math.max(delay, retryAfter * 1000) };
}

export type DeliveryReport = {
  status: 'ok' | 'busy' | 'off' | 'activated' | 'removal-pending';
  sent: number;
  latestFiveSent: number;
  rechecked: number;
  updated: number;
  redacted: number;
  unknown: number;
  needsAttention?: { postId: string; code: string; messageId?: number };
};

export async function runDelivery(
  store: DeliveryStore, source: Source, telegram: Transport, destination: TelegramDestination,
  enabled: boolean, token: string, clock: () => number = Date.now,
): Promise<DeliveryReport> {
  const started = clock();
  const report: DeliveryReport = {
    status: 'ok', sent: 0, latestFiveSent: 0, rechecked: 0, updated: 0, redacted: 0, unknown: 0,
  };
  if (!await store.claim(token, started)) return { ...report, status: 'busy' };
  const activation = await store.activation();
  if (!activation) {
    if (!enabled) return { ...report, status: 'off' };
    const target = await telegram.resolveChat(String(destination.chatId));
    if (target.chatId !== destination.chatId || target.botId !== destination.botId) throw new BridgeError('TELEGRAM_DESTINATION_MISMATCH');
    await store.activate(token, { ...destination, startedAt: clock() });
    return { ...report, status: 'activated' };
  }
  if (activation.chatId !== destination.chatId || activation.botId !== destination.botId) {
    throw new BridgeError('TELEGRAM_DESTINATION_CHANGED');
  }

  const timeLeft = () => clock() - started < REQUEST_BUDGET_MS;
  const posted = await store.records(await store.postedDue(started, MAX_REVIEWS));
  for (const record of posted) {
    if (!timeLeft()) break;
    assertRecord(record);
    if (record.stage !== 'sent') throw new BridgeError('INVALID_POSTED_INDEX');
    const current = record.availability === 'unavailable'
      ? { kind: 'unavailable' as const } : await lookup(source, record.id, clock());
    const now = clock();
    report.rechecked++;
    if (current.kind === 'unknown') {
      report.unknown++;
      await store.commit(token, [retryReview({ ...record, availability: 'unknown', lastCheckedAt: now }, now)]);
      continue;
    }
    // Preserve the original Telegram message when its Reddit source disappears.
    // Do not redact the message or remove its title and link.
    if (current.kind === 'unavailable') {
      await store.commit(token, [{ ...record, availability: 'unavailable',
        lastCheckedAt: now, nextCheckAt: now + RECHECK_MS, failures: 0 }]);
      continue;
    }
    const html = messageFor(current.post, now);
    const hash = fingerprint(html);
    const updated: RecordState = { ...record, availability: 'available',
      lastCheckedAt: now, nextCheckAt: now + RECHECK_MS, failures: 0 };
    if (hash !== record.fingerprint) {
      if (!timeLeft()) break;
      const outcome = await telegram.edit(destination, record.messageId!, html);
      if (outcome.kind !== 'edited') {
        const code = outcome.kind === 'rejected' ? `TELEGRAM_EDIT_${outcome.code}` : 'TELEGRAM_EDIT_UNKNOWN';
        await store.commit(token, [retryReview({ ...updated, failures: record.failures }, clock(),
          outcome.kind === 'rejected' ? outcome.retryAfter : undefined)]);
        report.needsAttention = { postId: record.id, code, messageId: record.messageId };
        return report;
      }
      updated.fingerprint = hash;
      report.updated++;
    }
    await store.commit(token, [updated]);
  }

  if (!enabled || !timeLeft()) return report;
  if (await store.hasPendingRemovals()) return { ...report, status: 'removal-pending' };
  const requestedIds = await store.requestedLatestFive() ?? [];
  const requested = (await store.records(requestedIds)).filter(record =>
    record?.stage === 'pending' && record.availability === 'available');
  const ordinaryIds = await store.pendingAfter(activation.startedAt, MAX_SENDS);
  const ordinary = await store.records(ordinaryIds.filter(id => !requestedIds.includes(id)));
  const pending = [...requested, ...ordinary].slice(0, MAX_SENDS);
  for (const record of pending) {
    if (!timeLeft()) break;
    assertRecord(record);
    if (record.stage !== 'pending' ||
        (record.createdAt <= activation.startedAt && !requestedIds.includes(record.id))) {
      throw new BridgeError('INVALID_PENDING_INDEX');
    }
    if ((record.retryDeliveryAt ?? 0) > clock()) break;
    const current = await lookup(source, record.id, clock());
    const now = clock();
    if (current.kind !== 'visible' || current.post.stickied) {
      const availability = current.kind === 'unknown' ? 'unknown' : 'unavailable';
      await store.commit(token, [{ ...record, availability, lastCheckedAt: now, nextCheckAt: now + 300_000 }]);
      continue;
    }
    if (!timeLeft()) break;
    const html = messageFor(current.post, now);
    const reserved: RecordState = { ...record, stage: 'reserved', lastCheckedAt: now };
    const result = await deliverOnce({
      begin: async () => {
        await store.commit(token, [reserved]);
        return { kind: 'reserved', attempt: token };
      },
      finish: async (_attempt, outcome) => {
        if (outcome.kind === 'unknown') return;
        if (outcome.kind === 'rejected') {
          await store.commit(token, [{ ...record, retryDeliveryAt: clock() + Math.max(60, outcome.retryAfter ?? 0) * 1000 }]);
          return;
        }
        const sent: RecordState = { ...reserved, stage: 'sent', messageId: outcome.messageId,
          fingerprint: fingerprint(html), nextCheckAt: clock() + RECHECK_MS };
        delete sent.retryDeliveryAt;
        await store.commit(token, [sent]);
      },
    }, () => telegram.send(destination, html));
    if (result.kind === 'sent') {
      report.sent++;
      if (requestedIds.includes(record.id)) report.latestFiveSent++;
      continue;
    }
    if (result.kind === 'rejected') {
      report.needsAttention = { postId: record.id, code: `TELEGRAM_SEND_${result.code}` };
    } else if (result.kind === 'sent_unrecorded') {
      report.needsAttention = { postId: record.id, code: 'TELEGRAM_RECEIPT_UNSAVED', messageId: result.messageId };
    } else {
      report.needsAttention = { postId: record.id, code: 'TELEGRAM_SEND_UNCONFIRMED' };
    }
    break;
  }
  return report;
}
