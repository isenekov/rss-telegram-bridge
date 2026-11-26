import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { parseAppConfig } from '@devvit/shared-types/schemas/config-file.v1.js';

const raw = readFileSync('devvit.json', 'utf8');
parseAppConfig(raw, false);
const config = JSON.parse(raw);
assert.equal(config.permissions.http.enable, false, 'Pre-review build must not enable external HTTP');
assert.deepEqual(config.permissions.http.domains, []);
assert.equal(config.settings.subreddit.pollingEnabled.defaultValue, false);
assert.equal(config.scheduler.tasks['read-new-posts'].cron, '*/5 * * * *');
assert.equal(config.triggers, undefined, 'No triggers from the source subreddit');
assert.equal(config.server.externalEndpoints, undefined);
assert.equal(config.settings.global.TELEGRAM_BOT_TOKEN, undefined);
console.log('Official Devvit schema and pre-review safety checks: PASS');
