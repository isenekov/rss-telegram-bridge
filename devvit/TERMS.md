# App terms — draft for operator review

GLR Channel Bridge is an experimental read-only Devvit collector installed in
its operator's own test subreddit. It is independent of Reddit and Telegram
and does not claim endorsement by either service.

Only the configured installation's authorized moderator can run manual reads.
Scheduled collection is off by default. This build does not publish messages
or modify Reddit posts, comments, votes or moderation settings.

Use must remain within the permissions granted by Reddit and content owners.
The operator must not bypass API restrictions or treat access to public posts
as blanket redistribution permission. Any future Telegram delivery requires
review of its purpose, destination, disclosures and removal behavior first.

The prototype may stop when API access fails, storage is inconsistent or its
bounded reading window cannot reach the last checkpoint. It does not guarantee
continuous service, complete discovery or detection of every deletion.

The operator can disable scheduled collection in installation settings and
uninstall the app. See [PRIVACY.md](PRIVACY.md) for retention limitations.

Support and reports: https://github.com/isenekov/rss-telegram-bridge/issues.
These draft terms must be completed and reviewed by the operator before launch.
