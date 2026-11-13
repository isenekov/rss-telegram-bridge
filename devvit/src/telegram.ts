/** Telegram transport prepared for a future reviewed integration.
 * Not imported by the deployed Devvit server. No automatic retries.
 */
export const SMOKE_ID = 'telegram-smoke-v1';
export const SMOKE_MESSAGE = '<b>ТЕСТ — проверка отправки в Telegram</b>\nhttps://github.com/isenekov/rss-telegram-bridge';
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
type Json = Record<string, unknown>;
export class TelegramError extends Error {
  constructor(code: string) { super(code); this.name = 'TelegramError'; }
}
const object = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const positiveId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const channelId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) < 0;

export type ApiReply =
  | { kind: 'ok'; result: unknown }
  | { kind: 'rejected'; code: number; retryAfter?: number }
  | { kind: 'unknown' };
export type Target = { botId: number; botUsername: string; chatId: number; title: string };

export class TelegramClient {
  #token: string;
  #fetcher: Fetcher;
  constructor(token: string, fetcher: Fetcher = fetch) {
    if (!/^[1-9][0-9]{4,19}:[A-Za-z0-9_-]{20,128}$/.test(token)) throw new TelegramError('INVALID_BOT_TOKEN');
    this.#token = token;
    this.#fetcher = fetcher;
  }
  async #call(method: 'getMe' | 'getChat' | 'getChatMember' | 'sendMessage', body: Json): Promise<ApiReply> {
    try {
      const response = await this.#fetcher(`https://api.telegram.org/bot${this.#token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15_000),
      });
      const data: unknown = await response.json();
      if (!object(data)) return { kind: 'unknown' };
      if (response.ok && data.ok === true) return { kind: 'ok', result: data.result };
      // Only explicit 4xx Bot API failures are definite non-delivery. Proxy
      // errors, 5xx, timeouts and malformed responses are ambiguous.
      if (data.ok === false && Number.isInteger(data.error_code) &&
          (data.error_code as number) >= 400 && (data.error_code as number) < 500 &&
          (response.status === 200 || response.status === data.error_code)) {
        const retryAfter = object(data.parameters) && positiveId(data.parameters.retry_after)
          ? data.parameters.retry_after : undefined;
        return { kind: 'rejected', code: data.error_code as number, ...(retryAfter ? { retryAfter } : {}) };
      }
    } catch { /* Never expose a fetch exception: its URL can contain the token. */ }
    return { kind: 'unknown' };
  }
  async #read(method: 'getMe' | 'getChat' | 'getChatMember', body: Json): Promise<Json> {
    const reply = await this.#call(method, body);
    if (reply.kind === 'rejected') throw new TelegramError(`PREFLIGHT_REJECTED_${reply.code}`);
    if (reply.kind !== 'ok' || !object(reply.result)) throw new TelegramError('PREFLIGHT_FAILED');
    return reply.result;
  }
  async resolveChannel(chat: string): Promise<Target> {
    if (!/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(chat) && !/^-[1-9][0-9]{4,19}$/.test(chat)) {
      throw new TelegramError('INVALID_CHANNEL');
    }
    const bot = await this.#read('getMe', {});
    if (!positiveId(bot.id) || bot.is_bot !== true || typeof bot.username !== 'string') throw new TelegramError('INVALID_BOT_RESPONSE');
    const channel = await this.#read('getChat', { chat_id: chat });
    if (!channelId(channel.id) || channel.type !== 'channel' || typeof channel.title !== 'string') {
      throw new TelegramError('TARGET_MUST_BE_CHANNEL');
    }
    if (chat.startsWith('-') && String(channel.id) !== chat) throw new TelegramError('CHANNEL_ID_MISMATCH');
    // Canonical numeric ID prevents a username change from redirecting the send.
    const member = await this.#read('getChatMember', { chat_id: channel.id, user_id: bot.id });
    if (!object(member.user) || member.user.id !== bot.id ||
        !(member.status === 'creator' || member.status === 'administrator' && member.can_post_messages === true)) {
      throw new TelegramError('BOT_CANNOT_POST');
    }
    return { botId: bot.id, botUsername: bot.username, chatId: channel.id, title: channel.title };
  }
  async send(target: Target, html: string): Promise<SendOutcome> {
    if (!channelId(target.chatId) || !positiveId(target.botId) || !html || html.length > 4096) {
      throw new TelegramError('INVALID_MESSAGE');
    }
    const reply = await this.#call('sendMessage', {
      chat_id: target.chatId, text: html, parse_mode: 'HTML',
      link_preview_options: { is_disabled: true }, disable_notification: true,
    });
    if (reply.kind !== 'ok') return reply;
    const r = reply.result;
    if (!object(r) || !positiveId(r.message_id) || !object(r.chat) || r.chat.id !== target.chatId) {
      return { kind: 'unknown' };
    }
    return { kind: 'sent', messageId: r.message_id };
  }
}

export type SendOutcome =
  | { kind: 'sent'; messageId: number }
  | { kind: 'rejected'; code: number; retryAfter?: number }
  | { kind: 'unknown' };
export type Reservation = { kind: 'reserved'; attempt: string };
export type DeliveryResult = SendOutcome
  | { kind: 'already_sent'; messageId: number }
  | { kind: 'blocked' | 'busy' | 'cooldown' }
  | { kind: 'sent_unrecorded'; messageId: number }
  | { kind: 'state_unrecorded' };
export interface DeliveryJournal {
  begin(): Promise<Reservation | Exclude<DeliveryResult, SendOutcome | { kind: 'sent_unrecorded'; messageId: number } | { kind: 'state_unrecorded' }>>;
  finish(attempt: string, outcome: SendOutcome): Promise<void>;
}

/** Durable intent precedes the irreversible request. An unknown outcome never
 * becomes automatically eligible for retry. This is not an exactly-once API.
 */
export async function deliverOnce(journal: DeliveryJournal, send: () => Promise<SendOutcome>): Promise<DeliveryResult> {
  const reservation = await journal.begin();
  if (reservation.kind !== 'reserved') return reservation;
  let outcome: SendOutcome;
  try { outcome = await send(); } catch { outcome = { kind: 'unknown' }; }
  try { await journal.finish(reservation.attempt, outcome); }
  catch { return outcome.kind === 'sent' ? { kind: 'sent_unrecorded', messageId: outcome.messageId } : { kind: 'state_unrecorded' }; }
  return outcome;
}
