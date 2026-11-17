import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { context, reddit, settings } from '@devvit/web/server';
import { BridgeError, collect } from '../core.ts';
import { makeSource } from '../source.ts';
import { RedisStore } from './store.ts';

export const app = new Hono();
const store = new RedisStore();
const source = makeSource(reddit);

async function allowedInstallation() {
  const configured = await settings.get<string>('installationSubreddit');
  return !!configured?.trim() && configured.trim().toLowerCase() === context.subredditName?.toLowerCase();
}
async function requireModerator() {
  if (!context.userId || !await allowedInstallation()) throw new BridgeError('INSTALLATION_NOT_CONFIGURED');
  const user = await reddit.getUserById(context.userId);
  const permissions = await user?.getModPermissionsForSubreddit(context.subredditName);
  if (!permissions?.includes('all')) throw new BridgeError('FULL_MODERATOR_REQUIRED');
}
const errorCode = (error: unknown) => error instanceof BridgeError ? error.message : 'SOURCE_OR_STORAGE_ERROR';
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
    return c.json(toast(`Pending IDs: ${status.pending}; tracked: ${status.trackedForRecheck}; baseline: ${!!status.checkpoint}. Sending blocked in this build.`));
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
// No delivery endpoint, no token settings, no external endpoint, no post triggers.
// HTTP permission is also absent. Enabling collection cannot enable Telegram.
