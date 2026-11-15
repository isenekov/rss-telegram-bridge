# Devvit version review

This branch prepares the Telegram version of `gfar34` for review. The standard
Devvit review starts with `npx devvit publish`. The default submission is
unlisted. Set the Terms and Privacy links in the app's developer settings before
submitting an HTTP Fetch build. [Reddit launch guide](https://developers.reddit.com/docs/guides/launch/launch-guide)
and [HTTP Fetch documentation](https://developers.reddit.com/docs/capabilities/http-fetch).

## Description for the reviewer

The developer, `u/MaleficentWay4341`, runs the app in private r/gfar34_dev.
The app uses user-scoped Devvit access to fetch the public new-post listing for
r/GamingLeaksAndRumours. The developer does not moderate the source community.
A single operator-controlled Telegram channel, GLAR, is the intended destination.

The app sends a public post title and original permalink. It checks the source
post immediately before delivery. Redis saves post IDs, delivery reservations,
timestamps and the Telegram message mapping. Telegram link previews are disabled.
The moderator can request one batch of the latest five eligible posts after
activating delivery. It uses the same destination, duplicate protection,
source checks and limit of five messages per run as automatic delivery.
The app edits its previously sent messages when the source title or link changes
or a source lookup indicates that the post is unavailable. A message for an
unavailable post keeps its existing place in the channel and displays a neutral
notice instead of the source title and URL.

The app checks known posts periodically from its own installation. It relies on
the source lookup and removal flags returned through Devvit. This mechanism can
miss removals, and the operator handles requests and failed edits separately.
A failed redaction pauses new sends. The app uses `api.telegram.org` for bot
access, sending and editing. Both collection and delivery are off by default.

The owner verified live public listing access and duplicate detection on Reddit,
and live receipt of a synthetic Telegram message from Codespaces. The delivery
candidate's new paths have been exercised with simulated Reddit, Redis and
Telegram responses. [Test report](TEST_REPORT.md).

## Before submitting

- Confirm the description of GLAR, its audience and any commercial use.
- Add the published [Terms](TERMS.md) and [Privacy notice](PRIVACY.md) links in
  [Developer Settings](https://developers.reddit.com/apps/gfar34/developer-settings).
  Both documents list the test subreddit's modmail as the operator contact.
- Confirm any permissions needed from the source community or content owners.
  Describe the separate installation and the periodic removal checks in the
  submission so the reviewer can assess both.

[Devvit review, content permissions and removals](https://developers.reddit.com/docs/devvit_rules)
· [Developer Terms](https://redditinc.com/policies/developer-terms)
· [Telegram text editing](https://core.telegram.org/bots/api#editmessagetext)

The Reddit reviewer may ask for a different access or removal process. If Reddit
directs this use case outside Devvit, follow its guidance for the
[API access request](https://support.reddithelp.com/hc/en-us/requests/new?tf_42139884615700=api_request_type_developer_clone&ticket_form_id=14868593862164).
