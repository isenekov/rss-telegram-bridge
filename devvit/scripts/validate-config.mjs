import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { parseAppConfig } from '@devvit/shared-types/schemas/config-file.v1.js';

const raw = readFileSync('devvit.json', 'utf8');
parseAppConfig(raw, false);
const config = JSON.parse(raw);
assert.deepEqual(config.permissions.http, { enable: true, domains: ['api.telegram.org'] });
assert.equal(config.settings.subreddit.pollingEnabled.defaultValue, false);
assert.equal(config.settings.subreddit.telegramDeliveryEnabled.defaultValue, false);
assert.equal(config.scheduler.tasks['read-new-posts'].cron, '*/5 * * * *');
assert.equal(config.scheduler.tasks['maintain-telegram'].cron, '2-59/5 * * * *');
assert.equal(config.triggers, undefined, 'No triggers from the source subreddit');
assert.equal(config.server.externalEndpoints, undefined);
for (const key of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']) {
  assert.equal(config.settings.global[key].isSecret, true);
  assert.equal(config.settings.global[key].defaultValue, undefined);
}
console.log('Official Devvit schema and delivery defaults: PASS');
