# GLR Channel Bridge

GLR Channel Bridge is an app for the operator of the GLAR Telegram channel. It
reads new public posts in r/GamingLeaksAndRumours and can notify GLAR with the
post title and a link to the original. It runs in the operator's private
r/gfar34_dev installation. The operator does not moderate the source community.
The app uses Devvit's user scope for public reads.

This version is a candidate for Reddit review. Scheduled collection and
delivery start disabled. The operator completes the review and verifies
Telegram access before enabling delivery. [Review and setup](../REDDIT_SETUP.md).

## Collection and delivery

- The collector runs every five minutes and uses
  `reddit.getNewPosts({ subredditName: "GamingLeaksAndRumours" })` with a limit
  of 500 results. The first successful read establishes a baseline.
- On the first enabled delivery run, the app verifies the bot and destination
  and records a new start time for automatic delivery.
  The delivery job runs every five minutes, two minutes after the collector's
  scheduled start, and sends at most two messages per run.
- The app checks each post again before sending. Each message contains the
  escaped title and a Reddit permalink, with link previews disabled.
- Redis reserves the post ID before the Telegram request and records the
  Telegram message ID on success. A definite rejection permits a later retry.
  An unconfirmed send keeps its reservation for operator investigation.
- The app checks previously sent posts periodically. For changes, it edits the
  original Telegram message. A confirmed unavailable original results in the
  text “Исходная публикация недоступна.” The message stays in the channel. Failed
  removal edits pause new sends and retry. A network or permission failure
  during a Reddit lookup schedules another check.
- The target interval for each sent post is one hour. Each invocation checks
  up to ten posts and stops starting requests when its time budget expires.
  Actual intervals depend on the backlog and service availability. Missing
  source signals can prevent detection. The operator handles removal requests
  using the message mapping and the support contact below.

## Setup and operation

Use Node.js 24.18+ in Codespaces. Run `npm ci` and `npm run verify`. Authenticate
with `npm run auth` and use the app's configured private subreddit. Follow the
[launch instructions](../REDDIT_SETUP.md#5-проверка-devvit-и-отправка-в-telegram)
for the version review, installation and settings.

A full moderator in the configured installation can use these subreddit menus.

- **GLR: read source now (no sending)** collects IDs and displays counts.
- **GLR: collector status** shows the queue, tracked messages and unconfirmed
  reservations.
- **GLR: verify Telegram connection** checks the configured bot, chat and
  posting permission.
- **GLR: queue 5 latest posts for Telegram (once)** selects the five most
  recent eligible public posts and queues them after delivery has started.
  The next scheduled runs send up to two per run using the same delivery
  history. Earlier receipts and unconfirmed reservations suppress duplicate
  sends, and each original is checked again before its message is sent.

The developer enters the bot token and numeric chat ID as Devvit secrets.
To pause new sends, turn off **Send new posts to Telegram**. Keep the installation
and bot credentials available so the app can continue updating sent messages.
The app binds its delivery history to the original bot and chat. Changing that
destination requires handling the existing messages first.

There is also a [manual Codespaces test](TELEGRAM_TEST.md) for a fixed synthetic
message. It exercises the Telegram bot independently of the Devvit installation.

## Stored data and limits

Redis stores Reddit post IDs, timestamps, availability and delivery state. For
posts sent to Telegram it keeps the message ID and a hash of the rendered
message to detect edits. The hash is removed when the title and link are taken
out of the message. Titles, links, author identities and bodies are not stored
in Redis. Operational error messages can include a post ID and a Telegram
message ID so the operator can locate a particular delivery.

Ordinary unsent records and redacted records are pruned in bounded batches after
a 30-day retention target while the collector runs. Sent mappings and unconfirmed
reservations survive that cleanup. Unconfirmed sends need a manual check in the
channel. The app keeps their reservations to avoid repeated delivery.
The one-time selection expires after 30 days and a flag records that it was
requested. Eligible posts still pending have a 30-day retention target from
the request.

The collector saves the checkpoint with the queued IDs. The 10-minute overlap
covers short listing delays. If 500 results fail to reach the prior checkpoint,
it reports `SCAN_WINDOW_GAP` without advancing the checkpoint.

## Fetch Domains

`api.telegram.org` is used for `getMe`, `getChat` and `getChatMember` to confirm
access, `sendMessage` to deliver a title and link, and `editMessageText` to update
the same message or remove its Reddit content. The bot credentials are entered
by the developer. Telegram processes message text and the destination chat ID.

## Terms, privacy and support

[Terms](TERMS.md) · [Privacy](PRIVACY.md) · [Version review notes](REVIEW_REQUEST.md)

For support and removal requests, contact the operator through
[r/gfar34_dev modmail](https://www.reddit.com/message/compose/?to=r%2Fgfar34_dev).
Include a relevant public Reddit post or Telegram message link.
