# Reddit / r/GamingLeaksAndRumours — optional integration

This is separate from IGN / Eurogamer. The existing RSS workflow, RSS feeds,
`main.py`, `config.yaml` and `posted.json` are unchanged.

## Reddit API requirement (November 2026)

Reddit requires explicit approval for external Data API access. Reddit stopped
accepting *new* public Data API access requests on October 31, 2026. Merely
creating an OAuth client ID and secret does not grant permission. Only use this
workflow with an already approved Reddit Data API application.

Official sources:
- https://support.reddithelp.com/hc/en-us/articles/54353370049684-Changelog-October-8-2026
- https://support.reddithelp.com/hc/en-us/articles/16471395473812-Moderation-Bots-Tooling
- https://developers.reddit.com/docs/guides/faq

Existing approved clients must follow Reddit's 2027 migration requirements.

## Configure GitHub Actions secrets (do not paste credentials into chat)

Go to repository > Settings > Secrets and variables > Actions > New repository secret.

Add:
- `REDDIT_CLIENT_ID`: client ID for an **already approved** OAuth application.
- `REDDIT_CLIENT_SECRET`: OAuth client secret for that application.
- `REDDIT_USER_AGENT`: honest, descriptive user agent, such as
  `linux:isenekov-reddit-telegram:v1.0 (by /u/YOUR_REDDIT_USERNAME)`.

The existing `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are used for
publishing and do not need to be changed.

## Safe testing

Actions > **Reddit API to Telegram (setup and manual run)** > Run workflow.

1. `self-test` (default): tests message formatting with a synthetic post.
   Does **not** access Reddit, send Telegram messages or change history.
2. `probe`: uses Reddit OAuth to read the latest 100 posts (up to 5 titles
   printed). Does **not** send Telegram messages or change history.
   This is the required check for real API access.
3. `publish`: first run initializes `reddit_posted.json` with current
   post IDs and sends **nothing**; subsequent manual runs send up to 10
   new posts from the last 2 hours.

The `publish` workflow commits hashed post IDs to GitHub **before**
contacting Telegram, and retries Git pushes after fetching/rebasing on current
`main`. It will not send if the history can't be safely saved.

No automatic schedule is enabled until OAuth `probe` and a manual
end-to-end run are successful. This prevents noisy failures when approval
or secrets are missing.

## Caveats

- At-most-once delivery is preferred over automatic retries: if Telegram fails
  after IDs were reserved, a post may be omitted instead of sent twice.
- Posts from other subreddits are not collected.
- Only post titles and Reddit permalinks are sent; only hashed IDs and
  creation timestamps are retained in GitHub, with a 48-hour rolling window.
- Follow Reddit's rules on removed/deleted content. Publishing a title in an
  external Telegram channel may require a deletion/removal procedure.
- This workflow does not bypass Reddit authentication, permissions or rate limits.
