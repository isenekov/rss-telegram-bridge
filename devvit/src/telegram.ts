/** Telegram Bot API transport. Requests never retry internally. */
export const SMOKE_ID = 'telegram-smoke-v1';
export const SMOKE_MESSAGE = '<b>ТЕСТ — проверка отправки в Telegram</b>\nhttps://github.com/isenekov/rss-telegram-bridge';
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
type Json = Record<string, unknown>;
export class TelegramError extends Error {
  constructor(code: string) { super(code); this.name = 'TelegramError'; }
}
const object = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const positiveId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const negativeChatId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) < 0;
type ChatType = 'channel' | 'group' | 'supergroup';

function canPost(chatType: ChatType, member: Json): boolean {
  if (member.status === 'creator') return true;
  if (chatType === 'channel') {
    return member.status === 'administrator' && member.can_post_messages === true;
  }
  if (member.status === 'restricted') {
    return member.is_member === true && member.can_send_messages === true;
  }
  return member.status === 'administrator' || member.status === 'member';
}

export type ApiReply =
  | { kind: 'ok'; result: unknown }
  | { kind: 'rejected'; code: number; retryAfter?: number; unchanged?: true }
  | { kind: 'unknown' };
export type Target = { botId: number; botUsername: string; chatId: number; title: string };
export type TelegramDestination = { chatId: number; botId: number };
type Method = 'getMe' | 'getChat' | 'getChatMember' | 'sendMessage' | 'editMessageText';

export class TelegramClient {
  #token: string;
  #fetcher: Fetcher;
  #timeoutMs: number;
  readonly botId: number;
  constructor(token: string, fetcher: Fetcher = fetch, timeoutMs = 15_000) {
    if (!/^[1-9][0-9]{4,19}:[A-Za-z0-9_-]{20,128}$/.test(token)) throw new TelegramError('INVALID_BOT_TOKEN');
    const botId = Number(token.slice(0, token.indexOf(':')));
    if (!positiveId(botId)) throw new TelegramError('INVALID_BOT_TOKEN');
    this.#token = token;
    this.#fetcher = fetcher;
    this.#timeoutMs = timeoutMs;
    this.botId = botId;
  }
  async #call(method: Method, body: Json): Promise<ApiReply> {
    try {
      const response = await this.#fetcher(`https://api.telegram.org/bot${this.#token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(this.#timeoutMs),
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
        const unchanged = method === 'editMessageText' && data.error_code === 400 &&
          typeof data.description === 'string' && /^Bad Request: message is not modified(?:[:.]|$)/i.test(data.description);
        return { kind: 'rejected', code: data.error_code as number,
          ...(retryAfter ? { retryAfter } : {}), ...(unchanged ? { unchanged: true } : {}) };
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
  async resolveChat(chat: string): Promise<Target> {
    const numericId = /^-[1-9][0-9]*$/.test(chat) && negativeChatId(Number(chat));
    if (!numericId && !/^@[A-Za-z0-9_]{1,32}$/.test(chat)) {
      throw new TelegramError('INVALID_CHAT_ADDRESS');
    }
    const bot = await this.#read('getMe', {});
    if (bot.id !== this.botId || bot.is_bot !== true || typeof bot.username !== 'string') throw new TelegramError('INVALID_BOT_RESPONSE');
    const { id, type, title } = await this.#read('getChat', { chat_id: chat });
    if (type !== 'channel' && type !== 'group' && type !== 'supergroup') {
      throw new TelegramError('TARGET_MUST_BE_GROUP_OR_CHANNEL');
    }
    if (!negativeChatId(id) || typeof title !== 'string') {
      throw new TelegramError('INVALID_CHAT_RESPONSE');
    }
    if (numericId && String(id) !== chat) throw new TelegramError('CHAT_ID_MISMATCH');
    // Canonical numeric ID prevents a username change from redirecting the send.
    const member = await this.#read('getChatMember', { chat_id: id, user_id: bot.id });
    if (!object(member.user) || member.user.id !== bot.id || !canPost(type, member)) {
      throw new TelegramError('BOT_CANNOT_POST');
    }
    return { botId: bot.id, botUsername: bot.username, chatId: id, title };
  }
  async send(target: TelegramDestination, html: string): Promise<SendOutcome> {
    if (!negativeChatId(target.chatId) || target.botId !== this.botId || !html || html.length > 4096) {
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
  async edit(target: TelegramDestination, messageId: number, html: string): Promise<EditOutcome> {
    if (!negativeChatId(target.chatId) || target.botId !== this.botId || !positiveId(messageId) || !html || html.length > 4096) {
      throw new TelegramError('INVALID_MESSAGE');
    }
    const reply = await this.#call('editMessageText', {
      chat_id: target.chatId, message_id: messageId, text: html, parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
    if (reply.kind === 'rejected') return reply.unchanged ? { kind: 'edited' } : reply;
    if (reply.kind !== 'ok' || !object(reply.result)) return { kind: 'unknown' };
    const r = reply.result;
    return r.message_id === messageId && object(r.chat) && r.chat.id === target.chatId
      ? { kind: 'edited' } : { kind: 'unknown' };
  }
}

export type SendOutcome =
  | { kind: 'sent'; messageId: number }
  | { kind: 'rejected'; code: number; retryAfter?: number }
  | { kind: 'unknown' };
export type EditOutcome = { kind: 'edited' } | Exclude<SendOutcome, { kind: 'sent' }>;
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
