# Privacy notice — draft for operator review

This notice describes the read-only GLR Channel Bridge prototype. The operator
must review and finalize it before submitting the app for approval. The app is
not yet an active Telegram integration.

The app reads public post metadata from r/GamingLeaksAndRumours through Devvit.
It stores post identifiers, timestamps, processing states, availability and
retry counters in Redis scoped to the operator's test installation. Titles and
permalinks are transient and are not saved in Redis or logs. It does not save
authors, post bodies, comments, media, profiles or user credentials.

No Reddit content is transferred to Telegram by this version. Logging is limited
to aggregate counts and fixed operational error codes. Repository CI uses
synthetic data and has no Reddit or Telegram secrets.

Unsent metadata is pruned after a 30-day target in bounded batches while the
collector is running. Pausing collection pauses this maintenance; operators
must arrange a purge if needed. Minimal message mappings would need a separate
retention policy if delivery is approved in a future version.

The proposed later version would disclose a public post's title and permalink
to Telegram and channel readers. That transfer is not enabled and requires
approval, appropriate content permissions and an accepted removal process.
No promise is made that periodic checks detect all source deletions.

Support: https://github.com/isenekov/rss-telegram-bridge/issues. Use only the
public post URL and minimum necessary information in a public issue. The operator
must add a private contact before accepting requests containing personal data.
