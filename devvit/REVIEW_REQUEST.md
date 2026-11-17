# Devvit policy inquiry

Send the subject and message below from `u/MaleficentWay4341` to
[r/Devvit Modmail](https://www.reddit.com/message/compose/?to=r%2FDevvit).
This is a preliminary question for the Devvit team. Their answer will determine
whether to prepare an app version for review or request a different form of
access. See [Devvit Rules](https://developers.reddit.com/docs/devvit_rules) and
[Launch your app](https://developers.reddit.com/docs/guides/launch/launch-guide).

## Subject

Devvit policy question: public post titles and links in Telegram (`gfar34`)

## Message

Hello Devvit team,

I'm developing `gfar34` (Reddit account `u/MaleficentWay4341`) and would like to
confirm whether Devvit supports sending headlines and links for new public posts
in r/GamingLeaksAndRumours to my Telegram channel, GLAR.

My private test installation is in r/gfar34_dev. I don't moderate
r/GamingLeaksAndRumours. The app uses the user-scoped Reddit capability and
`reddit.getNewPosts({ subredditName: "GamingLeaksAndRumours" })`. Manual reads
successfully loaded the public listing and recognized previously saved IDs.
The proposed polling interval is five minutes. Redis holds post IDs and
operational timestamps and state, with a 30-day retention target for unsent
metadata.

Each proposed message would contain the post title and its original Reddit
permalink. I tested receipt of a synthetic message from Codespaces in GLAR on
November 15. The private Devvit build currently reads only and has HTTP Fetch
disabled. The proposed build would call `api.telegram.org` through the existing
Telegram bot. Source code and test evidence are available here.

- Draft implementation: https://github.com/isenekov/rss-telegram-bridge/pull/1
- Test report: https://github.com/isenekov/rss-telegram-bridge/blob/codex/devvit-readonly-20261112/devvit/TEST_REPORT.md

1. Can Devvit approve cross-community reading and Telegram notifications for
   this use? Which app review and permissions are required, including any
   permissions from the source community or authors? If this is outside Devvit's
   supported use cases, which access request should I pursue?
2. What deletion procedure is required? From a separate installation I can
   check known posts periodically, but these checks may miss deletions. Telegram
   generally limits bot deletion to messages under 48 hours old. Would removing
   the title and link by editing an older message be acceptable, and what
   would you require for deleted posts that the API does not flag?

Thank you.

## Details for a formal review

- Whether the destination channel is public or private, its intended audience,
  and whether it carries advertising, sponsorship or other commercial activity.
- Public support/removal contact and finalized Terms/Privacy URLs.
- Any permission already obtained from Reddit, source moderators or authors.

Use the [Reddit Help access request](https://support.reddithelp.com/hc/en-us/requests/new?tf_42139884615700=api_request_type_developer_clone&ticket_form_id=14868593862164)
if Devvit directs this use case to a separate API request. The Devvit launch
guide describes version review through `npx devvit publish`. For an HTTP Fetch
build, supply Terms and Privacy URLs and document the requested domain in the
app README.

## Policy references checked on 2026-11-15 (Moscow)

- [Devvit FAQ](https://developers.reddit.com/docs/guides/faq) distinguishes
  Reddit-hosted apps from external integrations and explains that unsupported
  use cases require an access request. Devvit login is not Data API approval.
- [Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy)
  requires transparent, permitted access. Commercial use requires written
  approval.
- [Devvit Rules](https://developers.reddit.com/docs/devvit_rules) describe app
  review, external-service disclosures, content permissions and deletion duties.
  Their deletion requirements extend to content sent to external services.
- [HTTP Fetch Policy](https://developers.reddit.com/docs/capabilities/server/http-fetch-policy)
  lists `api.telegram.org` globally, but the app still needs an appropriate
  declared capability and an allowed use case. Current HTTP permission is off.
- [Scheduler](https://developers.reddit.com/docs/capabilities/server/scheduler)
  supports recurring cron jobs; the configured interval is `*/5 * * * *`.
- [Telegram Bot API](https://core.telegram.org/bots/api#deletemessage) documents
  the deletion time limit; [editing](https://core.telegram.org/bots/api#editmessagetext)
  is a potential removal fallback requiring live validation and Reddit's acceptance.

