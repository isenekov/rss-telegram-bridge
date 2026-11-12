# Validation of the read-only stage

## Completed locally

- Node.js 24.22.1; Devvit CLI and SDK 0.15.3; locked npm dependencies.
- `npm run verify`: 22 tests passed, no failures.
- Official SDK JSON Schema validation passed.
- TypeScript check passed against the installed SDK, including Reddit and Redis
  method signatures and the server adapter.
- CommonJS server bundle built successfully with esbuild.
- `devvit login --help` confirms support for `--copy-paste` without localhost.
- Git diff confirmed no edits to `main.py`, `config.yaml`, `posted.json`,
  `reddit_bridge.py`, `requirements.txt`, `rss-bridge.yml` or the RSS test workflow.

The tests use synthetic posts and an in-memory transactional-store contract.
They cover first-run baselining, repeat and concurrent runs, delayed visibility,
pagination bounds, source and storage failures, a lost commit response, invalid
state, lease loss, execution budget, retention, best-effort availability checks,
and title/link formatting. They do not prove deployed Redis behavior.

## Not yet verified

| Check | Status / next step |
| --- | --- |
| Developer login and existing app identity | Owner enters OAuth code in their terminal |
| Installation in owner's test subreddit | Requires that account and subreddit name |
| Live cross-community `getNewPosts` access | Manual playtest after authorized access |
| Live Redis transactions and restart persistence | Repeat the manual read during playtest |
| Five-minute scheduler execution on Reddit | Observe after enabling read-only polling |
| Guaranteed deletion detection | Not claimed; periodic checks are best effort |
| Reddit approval of this use and external transfer | Not requested or obtained |
| Telegram delivery and recovery | Not implemented/enabled in this review build |

GitHub Actions runs the same offline checks with read-only repository permissions
and no secrets. Source access, app registration, review submission and delivery
must not be inferred from a green CI result.
