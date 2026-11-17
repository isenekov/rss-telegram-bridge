import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { context, reddit, settings } from '@devvit/web/server';
import { BridgeError, collect } from '../core.ts';
import { queueLatestFive, runDelivery } from '../delivery.ts';
import { makeSource } from '../source.ts';
import { TelegramClient, TelegramError } from '../telegram.ts';
import { RedisStore } from './store.ts';

export const app = new Hono();
const store = new RedisStore();
const source = makeSource(reddit);

async function allowedInstallation() {
  const configured = await settings.get<string>('installationSubreddit');
  return !!configured?.trim() && configured.trim().toLowerCase() === context.subredditName?.toLowerCase();
}
async function deliveryEnabled() {
  return await settings.get<boolean>('pollingEnabled') === true &&
    await settings.get<boolean>('telegramDeliveryEnabled') === true;
}
async function requireModerator() {
  if (!context.userId || !await allowedInstallation()) throw new BridgeError('INSTALLATION_NOT_CONFIGURED');
  const user = await reddit.getUserById(context.userId);
  const permissions = await user?.getModPermissionsForSubreddit(context.subredditName);
  if (!permissions?.includes('all')) throw new BridgeError('FULL_MODERATOR_REQUIRED');
}
const errorCode = (error: unknown) => error instanceof BridgeError || error instanceof TelegramError
  ? error.message : 'SOURCE_OR_STORAGE_ERROR';
const toast = (text: string) => ({ showToast: { text } });
app.onError((error, c) => {
  const code = errorCode(error);
  console.error(JSON.stringify({ event: 'request_failed', code }));
  return c.json({ status: 'error', code }, 500);
});

app.post('/internal/menu/read', async c => {
  try {
    await requireModerator();
    const report = await collect(store, source, randomUUID());
    console.log(JSON.stringify({ event: 'manual_read', ...report }));
    return c.json(toast(report.status === 'busy' ? 'Another read is running. Retry in one minute.' :
      `Read ${report.fetched}; new IDs ${report.added}; duplicates ${report.duplicates}. Telegram: 0.`));
  } catch (error) {
    const code = errorCode(error);
    console.error(JSON.stringify({ event: 'read_failed', code }));
    return c.json(toast(`Read stopped: ${code}. No Telegram messages sent.`));
  }
});
app.post('/internal/menu/status', async c => {
  try {
    await requireModerator();
    const status = await store.counts();
    return c.json(toast(`Pending IDs: ${status.pending}; baseline: ${!!status.checkpoint}; Telegram tracked: ${status.telegramTracked}; unconfirmed: ${status.telegramReserved}.`));
  } catch (error) { return c.json(toast(errorCode(error))); }
});
app.post('/internal/scheduler/read', async c => {
  if (!await allowedInstallation() || await settings.get<boolean>('pollingEnabled') !== true) {
    return c.json({ status: 'disabled' });
  }
  try {
    const report = await collect(store, source, randomUUID());
    console.log(JSON.stringify({ event: 'scheduled_read', ...report }));
    return c.json({ status: report.status });
  } catch (error) {
    const code = errorCode(error);
    console.error(JSON.stringify({ event: 'read_failed', code }));
    return c.json({ status: 'error', code }, 500);
  }
});

async function telegramSettings() {
  const [token, rawChatId] = await Promise.all([
    settings.get<string>('TELEGRAM_BOT_TOKEN'), settings.get<string>('TELEGRAM_CHAT_ID'),
  ]);
  const address = rawChatId?.trim() ?? '';
  const chatId = Number(address);
  if (!/^-[1-9][0-9]*$/.test(address) || !Number.isSafeInteger(chatId)) {
    throw new BridgeError('TELEGRAM_CHAT_ID_REQUIRED');
  }
  const client = new TelegramClient(token?.trim() ?? '', fetch, 6000);
  return { client, destination: { chatId, botId: client.botId } };
}

app.post('/internal/menu/verify-telegram', async c => {
  try {
    await requireModerator();
    const { client, destination } = await telegramSettings();
    await client.resolveChat(String(destination.chatId));
    return c.json(toast('Telegram bot and chat permissions verified.'));
  } catch (error) { return c.json(toast(`Verification stopped: ${errorCode(error)}.`)); }
});

app.post('/internal/menu/queue-latest-five', async c => {
  try {
    await requireModerator();
    if (!await deliveryEnabled()) throw new BridgeError('TELEGRAM_DELIVERY_DISABLED');
    const report = await queueLatestFive(store, source, randomUUID());
    console.log(JSON.stringify({ event: 'telegram_latest_five', ...report }));
    if (report.status === 'busy') return c.json(toast('Another task is running. Retry in one minute.'));
    if (report.status === 'already-requested') return c.json(toast('The one-time batch was already requested.'));
    return c.json(toast(`${report.queued} of ${report.selected} selected posts queued for Telegram.`));
  } catch (error) {
    const code = errorCode(error);
    console.error(JSON.stringify({ event: 'telegram_latest_five_failed', code }));
    return c.json(toast(`Latest-five request stopped: ${code}.`));
  }
});

app.post('/internal/scheduler/telegram', async c => {
  if (!await allowedInstallation()) return c.json({ status: 'disabled' });
  const enabled = await deliveryEnabled();
  if (!enabled && !await store.activation()) return c.json({ status: 'disabled' });
  try {
    const { client, destination } = await telegramSettings();
    const report = await runDelivery(store, source, client, destination, enabled, randomUUID());
    console.log(JSON.stringify({ event: 'telegram_delivery', ...report }));
    return c.json({ status: report.status });
  } catch (error) {
    const code = errorCode(error);
    console.error(JSON.stringify({ event: 'telegram_delivery_failed', code }));
    return c.json({ status: 'error', code }, 500);
  }
});
