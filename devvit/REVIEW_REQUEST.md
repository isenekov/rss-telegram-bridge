# Proposed Reddit review request — not submitted

## Request

Please confirm whether this proposed integration is permitted on Devvit and
what additional approvals or permissions are required before any export.

The app would be installed in a private test subreddit controlled by its
developer, not in r/GamingLeaksAndRumours. The developer is not a moderator of
r/GamingLeaksAndRumours and has not obtained permission to install an app there.
It would read that community's public new-post listing every five minutes using
`reddit.getNewPosts({ subredditName: "GamingLeaksAndRumours" })`. It would not
moderate, post, comment, vote or act on behalf of source-community members.

After approval, the proposed integration would notify one existing Telegram
channel through its existing bot. Each notification would contain only the
public title and a link to the original Reddit post, without author names,
post bodies, comments, images or videos. It would not train models, profile
users, sell datasets or use private Reddit content.

The submitted code currently performs only read-only collection and stores
minimal operational metadata in installation-scoped Redis. It has no enabled
HTTP permission, no Telegram credentials, no delivery route and no export.
Local unit tests use synthetic posts. Live cross-community access has not yet
been verified under the developer's authenticated installation.

## Questions needing a written answer

1. Is cross-community public reading from this test installation permitted for
   this specific purpose? Is a special permission or source-moderator consent
   required, even if `getNewPosts` technically succeeds?
2. Is forwarding titles and permalinks to this external Telegram channel an
   allowed Devvit use case, or must it use a separately approved Data API route?
3. What source-author permissions, notices, opt-outs, attribution and content
   licenses are required for this use? A public post is not assumed to grant
   unrestricted redistribution permission.
4. Would periodic best-effort post checks be acceptable without source-community
   deletion triggers? If not, what deletion mechanism is required?
5. Telegram limits automated deletion to messages under 48 hours old. Would
   replacing older bot messages with a neutral removal notice meet the required
   removal behavior? This is proposed, not yet implemented or validated.
6. Which review path and app visibility should be used, and must the external
   transfer be included in a new app version submitted for review?

## Information the operator must complete before submission

- Registered Devvit app slug and Reddit developer account.
- Name of the operator-owned test subreddit.
- Whether the destination channel is public or private, its intended audience,
  and whether it carries advertising, sponsorship or other commercial activity.
- Public support/removal contact and finalized Terms/Privacy URLs.
- Any permission already obtained from Reddit, source moderators or authors.

Do not include tokens, passwords, GitHub Secrets or OAuth codes in the request.
Do not claim source-community moderation rights or call this a moderation tool.

## Evidence and unresolved points (checked 2026-11-12, Moscow)

- [Devvit FAQ](https://developers.reddit.com/docs/guides/faq) distinguishes
  Reddit-hosted apps from external integrations and explains that unsupported
  use cases require an access request. Devvit login is not Data API approval.
- [Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy)
  requires transparent, permitted access; commercial use requires written
  approval. This app does not request moderator-scoped access.
- [Devvit Rules](https://developers.reddit.com/docs/devvit_rules) describe app
  review, external-service disclosures, content permissions and deletion duties.
  Best-effort monitoring must not be presented as guaranteed compliance.
- [HTTP Fetch Policy](https://developers.reddit.com/docs/capabilities/server/http-fetch-policy)
  lists `api.telegram.org` globally, but the app still needs an appropriate
  declared capability and an allowed use case. Current HTTP permission is off.
- [Scheduler](https://developers.reddit.com/docs/capabilities/server/scheduler)
  supports recurring cron jobs; the configured interval is `*/5 * * * *`.
- [Telegram Bot API](https://core.telegram.org/bots/api#deletemessage) documents
  the deletion time limit; [editing](https://core.telegram.org/bots/api#editmessagetext)
  is a potential removal fallback requiring live validation and Reddit's acceptance.

No public documentation found grants approval to this particular use case.
No review request has been sent, and no approval is claimed.
