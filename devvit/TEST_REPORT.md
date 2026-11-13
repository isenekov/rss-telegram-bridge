# Validation of the read-only stage

## Completed locally

- Node.js 24.22.1; Devvit CLI and SDK 0.15.3; locked npm dependencies.
- `npm run verify`: 35 tests passed, no failures (22 collector + 13 Telegram tests).
- Official SDK JSON Schema validation passed.
- TypeScript check passed against the installed SDK, including Reddit and Redis
  method signatures and the server adapter.
- CommonJS server bundle built successfully with esbuild.
- `devvit login --help` confirms support for `--copy-paste` without localhost.
- Dependency follow-up on 2026-11-13: `npm audit` reports zero vulnerabilities
  after scoped CLI overrides (`isomorphic-git` 1.38.6, `inquirer` 9.3.8).
  The CLI and SDK versions remain 0.15.3; all 22 tests and the build still pass.
  The exact locked esbuild/protobufjs install scripts were reviewed and declared
  in `allowScripts`. Deprecated-package warnings elsewhere in the CLI may remain.
- Git diff confirmed no edits to `main.py`, `config.yaml`, `posted.json`,
  `reddit_bridge.py`, `requirements.txt`, `rss-bridge.yml` or the RSS test workflow.

The tests use synthetic posts and an in-memory transactional-store contract.
They cover first-run baselining, repeat and concurrent runs, delayed visibility,
pagination bounds, source and storage failures, a lost commit response, invalid
state, lease loss, execution budget, retention, best-effort availability checks,
and title/link formatting. They do not prove deployed Redis behavior.

## Owner-reported playtest evidence — 2026-11-13 (Moscow)

The operator completed CLI authentication as `u/MaleficentWay4341`, listed the
registered app `gfar34`, and supplied the playtest URL for
[r/gfar34_dev](https://www.reddit.com/r/gfar34_dev/?playtest=gfar34).
Their Codespaces run of `npm run verify` passed all 22 tests and built the server;
their clean install reported zero dependency vulnerabilities.

The first manual read produced the following operator-supplied log:

```json
{"event":"manual_read","status":"ok","bootstrap":true,"fetched":500,"added":0,"duplicates":0,"checked":0,"unavailable":0,"unknown":0,"pruned":100,"telegramSent":0}
```

This is evidence of a successful live read of the configured foreign source and
completion of the bootstrap commit/prune calls without a reported error. The
500 results match the bounded scan limit; no historical posts were queued.
`pruned: 100` is the per-run retention batch: metadata whose post creation time
is at least 30 days old is removed from the app's Redis, not from Reddit. A later
read skips pruned historical IDs using the checkpoint. Therefore a repeated
500-result listing need not report 500 duplicates.

The operator then supplied a second manual-read log:

```json
{"event":"manual_read","status":"ok","bootstrap":false,"fetched":500,"added":0,"duplicates":400,"checked":0,"unavailable":0,"unknown":0,"pruned":100,"telegramSent":0}
```

The second read loaded the saved checkpoint and recognized 400 stored IDs.
Historical entries removed by retention were not re-queued (`added: 0`), and
another retention batch of 100 was removed. This verifies checkpoint/record
read-back and deduplication for the observed baseline across consecutive live
reads. It does not yet test queuing a genuinely new eligible post exactly once.

After receiving the playtest-restart instructions, the operator supplied a third
manual-read log:

```json
{"event":"manual_read","status":"ok","bootstrap":false,"fetched":500,"added":0,"duplicates":300,"checked":0,"unavailable":0,"unknown":0,"pruned":100,"telegramSent":0}
```

The checkpoint remained readable and 300 baseline records were recognized,
consistent with the two preceding 100-record retention batches. The third run
also added zero posts and pruned 100 old records. The operator did not include
the requested version line or restart transcript, so a version upgrade or a new
playtest session is not independently established by this JSON alone.

All three reads had `added: 0`: live queuing of a new eligible source post and
subsequent deduplication of that pending ID remain untested. The next manual
test must observe an ordinary, available, non-NSFW, non-stickied source post
created after bootstrap, read it once, then read again after at least 70 seconds.
Expect a positive added count once; if no further eligible posts appeared, the
next read should have `added: 0`. Keep polling disabled during this manual test.

These logs do not establish persistence across an app version upgrade, recovery
after a Reddit server failure, complete source coverage, or permission for the
proposed use/export. Stopping the CLI alone leaves the
installed version running; a new session is not proof of a server crash/restart.
See [the playtest lifecycle](https://developers.reddit.com/docs/guides/tools/playtest).
The evidence was supplied by the operator, not independently collected from their
authenticated Reddit session.

## Manual Telegram diagnostic — prepared, live send pending

On 2026-11-13 the operator asked to proceed with Telegram without waiting for a
new source post. A separate `npm run telegram:test` command was implemented. It
sends only a fixed synthetic heading and repository URL; no Reddit content is
read or exported. The Telegram transport is not imported into the Devvit server.

All 35 tests, schema validation, TypeScript and the unchanged server build pass.
Telegram tests inject a fake HTTP client and make no real Bot API calls. They
cover target/permission validation, request formatting, explicit 4xx rejection,
429 cooldown, timeout/5xx/malformed/redirect ambiguity, concurrent attempts,
durable receipts across instances, crash after reservation, lost receipt writes,
and invalid or unwritable state. The terminal preview and hidden-input behavior
were checked with a deliberately invalid dummy token; it was not echoed and was
rejected before any network request. No operator credential was used.

The built Devvit server contains no smoke-test text, diagnostic event or Telegram
Bot API URL. Its HTTP permission remains disabled and polling defaults to off.
RSS files/workflows and `posted.json` remain unchanged. Real Telegram delivery is
not yet verified; the owner must run the interactive command in their Codespace.
This test will not by itself verify the later Devvit-to-Telegram HTTP path or
the Reddit export permission. See [TELEGRAM_TEST.md](TELEGRAM_TEST.md).

## Remaining live checks

| Check | Status / next step |
| --- | --- |
| Discovery and deduplication of a new source post | Observe an eligible post created after bootstrap, then repeat; the same ID should be added once |
| Live Redis persistence across playtest sessions/versions | Record the playtest version, restart playtest, and read again without resetting Redis; expect bootstrap false |
| Recovery after server/storage failures on Reddit | Not fault-injected live; covered only by local contract tests |
| Five-minute scheduler execution on Reddit | Observe after enabling read-only polling |
| Guaranteed deletion detection | Not claimed; periodic checks are best effort |
| Reddit approval of this use and external transfer | Not requested or obtained |
| Telegram-only synthetic delivery | Implemented outside Devvit; owner enters credentials in Codespaces and verifies receipt |
| Reddit → Telegram delivery and recovery | Not connected/enabled in the deployed review build |

GitHub Actions runs the same offline checks with read-only repository permissions
and no secrets. Source access, app registration, review submission and delivery
must not be inferred from a green CI result.
