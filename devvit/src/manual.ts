/** Manual, moderator-only one-shot delivery for the five newest eligible source posts.
 * Unlike scheduled delivery, this explicitly bypasses the activation date.
 * All sends use the same durable records / removal tracking as the scheduled bot.
 */
import { createHash } from 'node:crypto';
import {
  assertRecord, BridgeError, messageFor, RECHECK_MS, sourceUnavailable, validPost,
  type Post, type RecordState, type Source,
} from './core.ts';
import { type DeliveryStore } from './delivery.ts';
import { type TelegramClient, type TelegramDestination } from './telegram.ts';

type Transport = Pick<TelegramClient, 'send' | 'resolveChat'>;
export type ManualReport = {
  status: 'ok' | 'busy'; selected: number; sent: number; skipped: number;
  needsAttention?: { postId: string; code: string; messageId?: number };
};

export async function sendFiveLatest(
  store: DeliveryStore,
  source: Source,
  telegram: Transport,
  destination: TelegramDestination,
  token: string,
  clock: () => number = Date.now,
): Promise<ManualReport> {
  const started = clock();
  const report: ManualReport = { status: 'ok', selected: 0, sent: 0, skipped: 0 };
  if (!await store.claim(token, started)) return { ...report, status: 'busy' };

  const activation = await store.activation();
  if (!activation) throw new BridgeError('TELEGRAM_NOT_ACTIVATED');
  if (activation.chatId !== destination.chatId || activation.botId !== destination.botId) {
    throw new BridgeError('TELEGRAM_DESTINATION_CHANGED');
  }
  const target = await telegram.resolveChat(String(destination.chatId));
  if (target.chatId !== destination.chatId || target.botId !== destination.botId) {
    throw new BridgeError('TELEGRAM_DESTINATION_MISMATCH');
  }

  const latest = await source.latest();
  // The source listing may contain stickied/removed/NSFW entries.
  const posts = latest.filter(p =>
    validPost(p, started) && !sourceUnavailable(p) && !p.stickied,
  ).sort((a, b) => b.createdAt - a.createdAt).slice(0, 5);
  report.selected = posts.length;
  const old = await store.records(posts.map(p => p.id));

  for (let i = 0; i < posts.length; i++) {
    if (clock() - started > 45_000) break;
    const candidate = posts[i]!;
    const existing = old[i];
    if (existing) assertRecord(existing);
    // A previously sent/redacted/unconfirmed message must never be resent.
    if (existing && ['sent', 'redacted', 'reserved'].includes(existing.stage)) {
      report.skipped++;
      continue;
    }
    if (existing?.retryDeliveryAt && existing.retryDeliveryAt > clock()) {
      report.skipped++;
      continue;
    }

    let current: Post;
    try {
      current = await source.byId(candidate.id);
    } catch {
      report.skipped++;
      continue;
    }
    if (current.id !== candidate.id || !validPost(current, clock()) ||
        sourceUnavailable(current) || current.stickied) {
      report.skipped++;
      continue;
    }

    const now = clock();
    const html = messageFor(current, now);
    const original: RecordState = existing ?? {
      id: current.id, createdAt: current.createdAt, discoveredAt: now,
      stage: 'baseline', availability: 'available', lastCheckedAt: now,
      nextCheckAt: now + RECHECK_MS, failures: 0,
    };
    const reserved: RecordState = {
      ...original, stage: 'reserved', availability: 'available', lastCheckedAt: now,
    };
    // Reserve BEFORE the external request: an uncertain outcome never auto-retries.
    await store.commit(token, [reserved]);
    let outcome: Awaited<ReturnType<Transport['send']>>;
    try { outcome = await telegram.send(destination, html); }
    catch { outcome = { kind: 'unknown' }; }

    if (outcome.kind === 'sent') {
      const sent: RecordState = {
        ...reserved, stage: 'sent', messageId: outcome.messageId,
        fingerprint: createHash('sha256').update(html).digest('hex'),
        nextCheckAt: clock() + RECHECK_MS,
      };
      delete sent.retryDeliveryAt;
      try {
        await store.commit(token, [sent]);
      } catch {
        report.needsAttention = {
          postId: current.id, code: 'TELEGRAM_RECEIPT_UNSAVED', messageId: outcome.messageId,
        };
        break;
      }
      report.sent++;
      continue;
    }
    if (outcome.kind === 'rejected') {
      const retry: RecordState = { ...original,
        retryDeliveryAt: clock() + Math.max(60, outcome.retryAfter ?? 0) * 1000,
      };
      await store.commit(token, [retry]);
      report.needsAttention = { postId: current.id, code: `TELEGRAM_SEND_${outcome.code}` };
      break;
    }
    report.needsAttention = { postId: current.id, code: 'TELEGRAM_SEND_UNCONFIRMED' };
    break;
  }
  return report;
}
