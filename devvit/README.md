# GLR Channel Bridge — read-only review build

This app is being developed for an operator who wants notifications about new
public posts in r/GamingLeaksAndRumours in an existing Telegram channel. It is
installed **only in the operator's own test subreddit**. The operator is not a
moderator of the source subreddit. This is not a moderation tool and requests
only the user-scoped Reddit capability.

**This build cannot send anything to Telegram.** It has no delivery endpoint,
Telegram credentials, or enabled HTTP capability. Source access and the proposed
external transfer must be assessed by Reddit before a delivery build is enabled.
App registration and working SDK methods do not establish policy approval.

## Implemented functionality

- Explicit `reddit.getNewPosts({ subredditName: "GamingLeaksAndRumours" })`,
  bounded to 500 results with 100-result pages.
- First successful read establishes a baseline; historical IDs are not pending.
- Redis metadata records, atomic checkpoint/index updates, a fenced 60-second
  lease, overlap scans and persistent deduplication across process restarts.
- A Devvit Scheduler task runs every five minutes. It returns without reading
  unless `installationSubreddit` matches this installation and `pollingEnabled`
  is explicitly enabled. Manual source reads work with polling disabled.
- Ten due availability checks per run, targeting one hour between checks. Under
  load, checks take longer. Explicit removal flags mean unavailable; API errors
  mean unknown and retry with backoff. No `onPostDelete` subscription is used.
- A tested message formatter for a future stage: title and original permalink
  only. It is not connected to any external sender.

## Setup and operation

Use Node.js 24.18+ in Codespaces or another supported cloud environment. Run
`npm ci` then `npm run verify`. Follow [the setup guide](../REDDIT_SETUP.md) to
sign in personally using `npm run auth`, select your registered app name, and
playtest in a subreddit you own. No secret or OAuth code belongs in Git or chat.

After installation, the developer sets `installationSubreddit` via
`npx devvit settings set installationSubreddit`. A moderator with full
permissions in that test subreddit uses its **GLR: read source now (no sending)**
menu. Repeat the read after at least one minute, then again after new source
posts appear. **GLR: collector status** reports pending ID counts. Only the
operator's configured installation may read; other installations return disabled.

Enable `pollingEnabled` in installation settings only after the manual source
probe is successful and the proposed access is permitted. Turn it off to pause
collection. There is no setting that enables Telegram delivery in this version.

## Stored data and limits

Redis contains Reddit post IDs, creation/discovery/check timestamps, pending or
baseline states, availability and retry counters. Titles and permalinks exist
transiently during a read but are not stored or logged. Authors, bodies, media,
comments, profiles and user credentials are not collected. The SDK may transport
additional public fields; the adapter immediately projects only the listed fields.

Unsent metadata has a 30-day retention target, pruned in batches of 100 per
successful poll. Pausing collection also pauses pruning; uninstalling or a
separate operator purge is needed if storage must be cleared while paused.
The schema reserves a `sent` state and Telegram message ID for future removal
tracking; this build never creates those records. Their behavior is tested using
synthetic data only. Previously delivered mappings would be retained until the
external content is removed, not automatically discarded after 30 days.

The scan watermark is committed with all newly observed metadata. A failed
commit or source read does not advance it. A full 500-post window that does not
reach the prior boundary raises `SCAN_WINDOW_GAP` and preserves the checkpoint.
An operator must investigate and extend the bounded catch-up strategy; do not
delete the checkpoint to suppress the error. A ten-minute overlap handles short
listing delays, but cannot guarantee discovery of posts made visible much later.

Availability checks are **best effort**, not guaranteed deletion detection. A
public API response might not distinguish deletion from other access changes.
This design does not claim to satisfy Reddit's deletion obligations by itself.
The future delivery stage needs an approved removal procedure and live tests.

## Fetch Domains

**Current build:** HTTP is explicitly disabled; no external domain is requested.

**Proposed delivery build:** `api.telegram.org` would be the sole domain, for the
existing bot's `sendMessage`, `deleteMessage` and, where necessary,
`editMessageText`. The planned payload is only a post title and its original
Reddit permalink. The bot token would be a Devvit encrypted global secret entered
by the operator; existing GitHub Secrets and RSS delivery would remain unchanged.
Global domain allowlisting does not approve this use case or grant content rights.

## Review and support

[REVIEW_REQUEST.md](REVIEW_REQUEST.md) describes the exact proposed use and open
questions. [PRIVACY.md](PRIVACY.md) and [TERMS.md](TERMS.md) are draft app documents
for operator review before submission. Do not describe this build as an approved
or functioning Telegram bridge.

Report functional issues at
https://github.com/isenekov/rss-telegram-bridge/issues without including secrets.
Content-removal requests can identify the public Reddit URL; avoid including
private or unnecessary personal information in a public issue.
