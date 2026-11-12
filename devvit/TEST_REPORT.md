# Validation of the read-only stage

## Completed locally

- Node.js 24.22.1; Devvit CLI and SDK 0.15.3; locked npm dependencies.
- `npm run verify`: 22 tests passed, no failures.
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

This log alone does not establish repeated-run deduplication, persistence after
restart, complete source coverage, or permission for the proposed use/export.
The evidence was supplied by the operator, not independently collected from
their authenticated Reddit session.

## Remaining checks

| Check | Status / next step |
| --- | --- |
| Repeated-run deduplication and checkpoint read-back | Repeat manual read after at least 70 seconds; expect bootstrap false and no repeated pending IDs |
| Discovery of a new source post | Observe an eligible post created after bootstrap; it should be added once |
| Live Redis persistence after restart | Restart playtest and repeat the manual read without resetting Redis |
| Five-minute scheduler execution on Reddit | Observe after enabling read-only polling |
| Guaranteed deletion detection | Not claimed; periodic checks are best effort |
| Reddit approval of this use and external transfer | Not requested or obtained |
| Telegram delivery and recovery | Not implemented/enabled in this review build |

GitHub Actions runs the same offline checks with read-only repository permissions
and no secrets. Source access, app registration, review submission and delivery
must not be inferred from a green CI result.
