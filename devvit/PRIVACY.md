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
post is unavailable, the app records that status, retains the message mapping and
hash, and preserves the delivered Telegram message's title and link. Ordinary
unsent records and records redacted by older versions
have a 30-day retention target while the collector runs. Unconfirmed reservations
are retained for investigation and duplicate prevention. Polling has limited
visibility into removals, so the operator also handles removal requests.

The operator is [u/MaleficentWay4341](https://www.reddit.com/user/MaleficentWay4341/).
For questions about this notice or requests to remove content or data, contact
the operator through [r/gfar34_dev modmail](https://www.reddit.com/message/compose/?to=r%2Fgfar34_dev).
Include the public post or Telegram message link needed to identify the item.
Use the same contact for support.
