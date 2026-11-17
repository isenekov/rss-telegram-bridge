import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileJournal } from '../scripts/telegram-state.ts';
import { deliverOnce, SMOKE_MESSAGE, TelegramClient, type Fetcher, type Target } from '../src/telegram.ts';

const TOKEN = '123456789:FAKE_UNIT_TEST_TOKEN_NOT_A_REAL_SECRET';
const TARGET: Target = { botId: 123456789, botUsername: 'unit_test_bot', chatId: -1001234567890, title: 'Unit test channel' };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const sent = () => response({ ok: true, result: { message_id: 42, chat: { id: TARGET.chatId } } });
async function stateTest(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'glr-telegram-test-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('Telegram preflight accepts channels, ordinary groups and supergroups', async () => {
  const destinations = [
    { type: 'channel', id: TARGET.chatId, address: '@test_channel', member: { status: 'administrator', can_post_messages: true } },
    { type: 'group', id: -1234, address: '-1234', member: { status: 'member' } },
    { type: 'supergroup', id: TARGET.chatId, address: String(TARGET.chatId), member: { status: 'administrator' } },
  ];
  for (const { type, id, address, member } of destinations) {
    const calls: string[] = [];
    const fetcher: Fetcher = async (url, init) => {
      const method = url.slice(url.lastIndexOf('/') + 1);
      calls.push(method);
      assert.equal(init.redirect, 'error');
      assert.ok(init.signal);
      if (method === 'getMe') return response({ ok: true, result: { id: TARGET.botId, is_bot: true, username: TARGET.botUsername } });
      if (method === 'getChat') return response({ ok: true, result: { id, type, title: TARGET.title } });
      assert.equal(method, 'getChatMember');
      assert.deepEqual(JSON.parse(String(init.body)), { chat_id: id, user_id: TARGET.botId });
      return response({ ok: true, result: { ...member, user: { id: TARGET.botId } } });
    };
    assert.deepEqual(await new TelegramClient(TOKEN, fetcher).resolveChat(address), { ...TARGET, chatId: id });
    assert.deepEqual(calls, ['getMe', 'getChat', 'getChatMember']);
  }
});
test('Telegram preflight rejects private chats, mismatched IDs and missing posting rights', async () => {
  const cases = [
    { type: 'private', id: 1234, member: {}, error: /TARGET_MUST_BE_GROUP_OR_CHANNEL/ },
    { type: 'channel', id: TARGET.chatId - 1, member: {}, error: /CHAT_ID_MISMATCH/ },
    { type: 'channel', id: TARGET.chatId, member: { status: 'administrator', can_post_messages: false }, error: /BOT_CANNOT_POST/ },
    { type: 'supergroup', id: TARGET.chatId, member: { status: 'restricted', is_member: true, can_send_messages: false }, error: /BOT_CANNOT_POST/ },
    { type: 'group', id: TARGET.chatId, member: { status: 'left' }, error: /BOT_CANNOT_POST/ },
  ];
  for (const { type, id, member, error } of cases) {
    const api = new TelegramClient(TOKEN, async url => {
      if (url.endsWith('/getMe')) return response({ ok: true, result: { id: TARGET.botId, is_bot: true, username: TARGET.botUsername } });
      if (url.endsWith('/getChat')) return response({ ok: true, result: { id, type, title: TARGET.title } });
      assert.ok(url.endsWith('/getChatMember'));
      return response({ ok: true, result: { ...member, user: { id: TARGET.botId } } });
    });
    await assert.rejects(api.resolveChat(String(TARGET.chatId)), error);
  }
});
test('Telegram smoke message uses the resolved channel and disables link previews and sound', async () => {
  let calls = 0;
  const api = new TelegramClient(TOKEN, async (url, init) => {
    calls++; assert.equal(url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
    assert.deepEqual(JSON.parse(String(init.body)), { chat_id: TARGET.chatId, text: SMOKE_MESSAGE,
      parse_mode: 'HTML', link_preview_options: { is_disabled: true }, disable_notification: true });
    return sent();
  });
  assert.deepEqual(await api.send(TARGET, SMOKE_MESSAGE), { kind: 'sent', messageId: 42 });
  assert.equal(calls, 1); assert.ok(SMOKE_MESSAGE.includes('ТЕСТ'));
  assert.ok(!SMOKE_MESSAGE.includes('reddit.com')); // No Reddit content/export.
});
test('Telegram explicit 4xx errors are rejected without in-request retries', async () => {
  for (const code of [400, 401, 403, 429]) {
    let calls = 0;
    const api = new TelegramClient(TOKEN, async () => {
      calls++; return response({ ok: false, error_code: code, description: TOKEN, parameters: { retry_after: 120 } }, code);
    });
    const result = await api.send(TARGET, SMOKE_MESSAGE);
    assert.deepEqual(result, { kind: 'rejected', code, retryAfter: 120 });
    assert.equal(calls, 1); assert.ok(!JSON.stringify(result).includes(TOKEN));
  }
});
test('Telegram retries a lost edit receipt safely and matches the original destination and message', async () => {
  const client = new TelegramClient(TOKEN, async (url, init) => {
    assert.ok(url.endsWith('/editMessageText'));
    assert.deepEqual(JSON.parse(String(init.body)), {
      chat_id: TARGET.chatId, message_id: 42, text: 'Исходная публикация недоступна.', parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
    return response({ ok: false, error_code: 400, description: 'Bad Request: message is not modified: the text is unchanged' }, 400);
  });
  assert.deepEqual(await client.edit(TARGET, 42, 'Исходная публикация недоступна.'), { kind: 'edited' });
});
test('Telegram timeouts, malformed replies, redirects and 5xx are unknown and do not leak errors', async () => {
  const cases: Fetcher[] = [
    async () => { throw new Error(`Timeout https://api.telegram.org/bot${TOKEN}/sendMessage`); },
    async () => new Response('not JSON'),
    async () => new Response(null, { status: 302, headers: { location: 'https://example.invalid' } }),
    async () => response({ ok: false, error_code: 500 }, 500),
    async () => response({ ok: true, result: { message_id: 42, chat: { id: TARGET.chatId } } }, 500),
    async () => response({ ok: true, result: { message_id: 42, chat: { id: TARGET.chatId - 1 } } }),
    async () => response({ ok: true, result: { message_id: 0, chat: { id: TARGET.chatId } } }),
  ];
  for (const fetcher of cases) assert.deepEqual(await new TelegramClient(TOKEN, fetcher).send(TARGET, SMOKE_MESSAGE), { kind: 'unknown' });
});
test('Telegram validates inputs and sanitizes preflight errors before any send', async () => {
  let calls = 0;
  const fetcher: Fetcher = async () => { calls++; throw new Error(TOKEN); };
  assert.throws(() => new TelegramClient('bad/token', fetcher), /INVALID_BOT_TOKEN/);
  const api = new TelegramClient(TOKEN, fetcher);
  await assert.rejects(api.resolveChat('https://example.invalid'), /INVALID_CHAT_ADDRESS/);
  assert.equal(calls, 0);
  await assert.rejects(api.resolveChat('@test_channel'), error => {
    assert.equal((error as Error).message, 'PREFLIGHT_FAILED'); assert.ok(!String(error).includes(TOKEN)); return true;
  });
});
test('durable Telegram journal suppresses a repeat across new instances and stores no credentials', async () => stateTest(async root => {
  let calls = 0;
  const send = async () => { calls++; return { kind: 'sent' as const, messageId: 42 }; };
  const journal = new FileJournal(root, TARGET);
  assert.deepEqual(await deliverOnce(journal, send), { kind: 'sent', messageId: 42 });
  assert.deepEqual(await deliverOnce(new FileJournal(root, TARGET), send), { kind: 'already_sent', messageId: 42 });
  assert.equal(calls, 1);
  const raw = await readFile(join(journal.directory, 'state.json'), 'utf8');
  for (const sensitive of [TOKEN, String(TARGET.chatId), TARGET.title, SMOKE_MESSAGE]) assert.ok(!raw.includes(sensitive));
  assert.equal((await stat(join(journal.directory, 'state.json'))).mode & 0o777, 0o600);
}));
test('concurrent Telegram smoke attempts have one sender', async () => stateTest(async root => {
  let calls = 0;
  const send = async () => { calls++; return { kind: 'sent' as const, messageId: 42 }; };
  const results = await Promise.all(Array.from({ length: 8 }, () => deliverOnce(new FileJournal(root, TARGET), send)));
  assert.equal(calls, 1); assert.equal(results.filter(r => r.kind === 'sent').length, 1);
}));
test('ambiguous Telegram delivery blocks retries after restart', async () => stateTest(async root => {
  let calls = 0;
  const send = async () => { calls++; throw new Error('Connection reset'); };
  assert.deepEqual(await deliverOnce(new FileJournal(root, TARGET), send), { kind: 'unknown' });
  assert.deepEqual(await deliverOnce(new FileJournal(root, TARGET), send), { kind: 'blocked' });
  assert.equal(calls, 1);
}));
test('crash after reservation cannot cause a resend', async () => stateTest(async root => {
  assert.equal((await new FileJournal(root, TARGET).begin()).kind, 'reserved');
  const result = await deliverOnce(new FileJournal(root, TARGET), async () => { throw new Error('Must not send'); });
  assert.deepEqual(result, { kind: 'blocked' });
}));
test('failed receipt persistence preserves the intent and blocks a second send', async () => stateTest(async root => {
  const journal = new FileJournal(root, TARGET);
  const result = await deliverOnce({ begin: () => journal.begin(), finish: async () => { throw new Error('Disk failure'); } },
    async () => ({ kind: 'sent', messageId: 42 }));
  assert.deepEqual(result, { kind: 'sent_unrecorded', messageId: 42 });
  assert.deepEqual(await new FileJournal(root, TARGET).begin(), { kind: 'blocked' });
}));
test('a confirmed Telegram rejection permits a later manual retry after retry_after', async () => stateTest(async root => {
  let now = 1_800_000_000_000; let calls = 0;
  const journal = () => new FileJournal(root, TARGET, () => now);
  const send = async () => { calls++; return calls === 1
    ? { kind: 'rejected' as const, code: 429, retryAfter: 120 }
    : { kind: 'sent' as const, messageId: 42 }; };
  assert.equal((await deliverOnce(journal(), send)).kind, 'rejected');
  now += 70_000; assert.equal((await deliverOnce(journal(), send)).kind, 'cooldown');
  assert.equal(calls, 1);
  now += 60_000; assert.equal((await deliverOnce(journal(), send)).kind, 'sent');
  assert.equal((await deliverOnce(journal(), send)).kind, 'already_sent'); assert.equal(calls, 2);
}));
test('corrupt or unwritable Telegram state prevents sending', async () => stateTest(async root => {
  const journal = new FileJournal(root, TARGET); await journal.begin();
  await writeFile(join(journal.directory, 'state.json'), 'broken');
  let calls = 0;
  const send = async () => { calls++; return { kind: 'sent' as const, messageId: 42 }; };
  await assert.rejects(deliverOnce(new FileJournal(root, TARGET), send), /INVALID_TEST_STATE/);
  const file = join(root, 'not-a-directory'); await writeFile(file, 'x');
  await assert.rejects(deliverOnce(new FileJournal(file, TARGET), send));
  assert.equal(calls, 0); assert.ok((await readdir(root)).length > 0);
}));
