# GLR Channel Bridge privacy notice

The app reads public posts from r/GamingLeaksAndRumours through Devvit in the
operator's private test installation. It uses public titles and original
permalinks to notify readers of the operator's GLAR Telegram channel.

Redis stores post IDs, timestamps, availability, delivery status and, for
sent posts, the Telegram message ID and a hash of the rendered message. Titles,
permalinks, post bodies, comments, images and author identities are not stored
in Redis. Logs use counts, short error codes and, when troubleshooting requires
them, reference IDs. Telegram receives the message text, original public link
and configured chat ID. The operator's bot token is a Devvit secret.

The app keeps sent mappings so it can locate and update messages. When the source
post is unavailable, it replaces its title and link with a neutral notice and
drops the hash of the original message. Ordinary unsent and redacted records
have a 30-day retention target while the collector runs. Unconfirmed reservations
are retained for investigation and duplicate prevention. Polling has limited
visibility into removals, so the operator also handles removal requests.

For support or removal of content, provide the public post URL at
https://github.com/isenekov/rss-telegram-bridge/issues. Use the operator's private
support contact for sensitive requests. The operator will verify and supply that
contact before launch.
