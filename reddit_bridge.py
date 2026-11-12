#!/usr/bin/env python3
"""Optional, approval-gated Reddit Data API to Telegram bridge.

Separate from the IGN/Eurogamer bridge. Requires an approved Reddit OAuth app.
Run --probe before enabling --prepare / --publish in GitHub Actions.
"""

import argparse
import hashlib
import html
import json
import os
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

SUBREDDIT = "GamingLeaksAndRumours"
STATE_PATH = Path(__file__).with_name("reddit_posted.json")
QUEUE_PATH = Path(os.getenv("RUNNER_TEMP") or tempfile.gettempdir()) / "reddit_delivery_queue.json"
MAX_AGE_SECONDS = 2 * 3600
MAX_POSTS_PER_RUN = 10
HISTORY_SECONDS = 48 * 3600


def oauth_headers(client):
    client_id = os.getenv("REDDIT_CLIENT_ID", "").strip()
    client_secret = os.getenv("REDDIT_CLIENT_SECRET", "").strip()
    user_agent = os.getenv("REDDIT_USER_AGENT", "").strip()
    if not all((client_id, client_secret, user_agent)):
        raise RuntimeError(
            "Missing Reddit OAuth credentials. Configure REDDIT_CLIENT_ID, "
            "REDDIT_CLIENT_SECRET and REDDIT_USER_AGENT in GitHub Actions secrets. "
            "An already-approved Reddit Data API app is required."
        )
    response = client.post(
        "https://www.reddit.com/api/v1/access_token",
        auth=(client_id, client_secret),
        headers={"User-Agent": user_agent, "Accept": "application/json"},
        data={"grant_type": "client_credentials"},
    )
    if response.status_code != 200:
        raise RuntimeError(
            f"Reddit OAuth token request failed (HTTP {response.status_code}). "
            "An approved API app is required; new public API access requests "
            "closed on October 31, 2026."
        )
    token = response.json().get("access_token")
    if not token:
        raise RuntimeError("Reddit OAuth returned no access token.")
    return {
        "Authorization": f"Bearer {token}",
        "User-Agent": user_agent,
        "Accept": "application/json",
    }


def get_new_posts():
    with httpx.Client(timeout=25, follow_redirects=False) as client:
        headers = oauth_headers(client)
        response = client.get(
            f"https://oauth.reddit.com/r/{SUBREDDIT}/new",
            headers=headers,
            params={"limit": 100, "raw_json": 1},
        )
        if response.status_code != 200:
            raise RuntimeError(
                f"Reddit listing request failed (HTTP {response.status_code}). "
                "Verify that this OAuth app has approved Data API read access."
            )
        payload = response.json()
    children = payload.get("data", {}).get("children", [])
    if not isinstance(children, list):
        raise RuntimeError("Unexpected Reddit listing response.")

    posts = []
    for child in children:
        data = child.get("data", {}) if isinstance(child, dict) else {}
        if not isinstance(data, dict):
            continue
        if data.get("stickied") or data.get("removed_by_category") or data.get("spam"):
            continue
        name = str(data.get("name") or "")
        title = str(data.get("title") or "").strip()
        permalink = str(data.get("permalink") or "")
        try:
            created = float(data.get("created_utc", 0))
        except (ValueError, TypeError):
            continue
        if not name.startswith("t3_") or not title or not permalink.startswith(
            f"/r/{SUBREDDIT}/"
        ):
            continue
        posts.append({
            "id": hashlib.sha256(name.encode("utf-8")).hexdigest()[:24],
            "title": title,
            "url": "https://www.reddit.com" + permalink,
            "created": created,
        })
    return posts


def load_state():
    if not STATE_PATH.exists():
        return None
    try:
        state = json.loads(STATE_PATH.read_text(encoding="utf-8"))
        if not isinstance(state, dict) or not isinstance(state.get("seen"), dict):
            raise ValueError("Unexpected history format")
        return state
    except (OSError, ValueError) as exc:
        raise RuntimeError(f"Reddit history is invalid; refusing to repost: {exc}") from exc


def save_state(state):
    temp = STATE_PATH.with_suffix(".json.tmp")
    temp.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(STATE_PATH)


def message_for(post):
    title = html.escape(post["title"][:900])
    link = html.escape(post["url"], quote=True)
    return (
        "<b>RUMOR | Reddit</b>\n\n"
        f"<b>{title}</b>\n\n"
        f'🔗 <a href="{link}">Читать в r/{SUBREDDIT}</a>'
    )


def prepare():
    posts = get_new_posts()
    now = time.time()
    existing = load_state()
    state = existing if existing is not None else {"version": 1, "seen": {}}
    seen = state["seen"]
    # Keep only recent hashed post IDs, not post text or author information.
    seen = {key: val for key, val in seen.items()
            if isinstance(val, (int, float)) and now - val < HISTORY_SECONDS}
    bootstrap = existing is None
    eligible = [
        post for post in posts
        if 0 <= now - post["created"] <= MAX_AGE_SECONDS and post["id"] not in seen
    ]
    eligible.sort(key=lambda p: p["created"])
    selected = [] if bootstrap else eligible[:MAX_POSTS_PER_RUN]

    # Reserve IDs BEFORE any Telegram call, protecting against duplicate sends
    # when GitHub fails to save history. The workflow must push this file first.
    for post in (posts if bootstrap else selected):
        if now - post["created"] < HISTORY_SECONDS:
            seen[post["id"]] = post["created"]
    state = {"version": 1, "seen": seen}
    save_state(state)
    queue = [message_for(post) for post in selected]
    QUEUE_PATH.write_text(json.dumps(queue, ensure_ascii=False), encoding="utf-8")
    print(f"Reddit API OK. Subreddit: r/{SUBREDDIT}; fetched: {len(posts)}")
    print(f"First run / bootstrap: {bootstrap}; reserved: {len(queue)}")
    if bootstrap:
        print("Existing posts marked as seen. No historical posts will be sent.")


def publish():
    if not QUEUE_PATH.exists():
        raise RuntimeError("Reddit delivery queue missing; sending blocked.")
    queue = json.loads(QUEUE_PATH.read_text(encoding="utf-8"))
    if not isinstance(queue, list) or any(not isinstance(m, str) for m in queue):
        raise RuntimeError("Invalid Reddit delivery queue; sending blocked.")
    QUEUE_PATH.unlink()
    # Reuse existing Telegram sender but do not modify IGN or Eurogamer history.
    from main import send_message
    sent = 0
    failed = 0
    with httpx.Client(timeout=30) as client:
        for message in queue:
            if send_message(client, message):
                sent += 1
                time.sleep(1.1)
            else:
                failed += 1
    print(f"Reddit delivery: reserved={len(queue)}, delivered={sent}, failed={failed}")
    if failed:
        raise RuntimeError("Telegram did not confirm some Reddit posts; "
                           "automatic retries are disabled to avoid duplicates.")


def probe():
    posts = get_new_posts()
    print(f"Approved Reddit API access verified; r/{SUBREDDIT}: {len(posts)} posts fetched.")
    for post in posts[:5]:
        print(f"- {post['title'][:120]} | {post['url']}")
    print("No Telegram messages sent; no history changed.")


def self_test():
    sample = {"id": "abc", "title": "Rumour: <Game> & news",
              "url": "https://www.reddit.com/r/GamingLeaksAndRumours/comments/abc/",
              "created": 1}
    rendered = message_for(sample)
    assert "&lt;Game&gt;" in rendered and "&amp;" in rendered
    assert "RUMOR | Reddit" in rendered
    assert rendered.count("https://") == 1
    print("Reddit bridge self-test: PASS. No API call, no Telegram message.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Reddit API to Telegram, approval required")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--self-test", action="store_true")
    group.add_argument("--probe", action="store_true")
    group.add_argument("--prepare", action="store_true")
    group.add_argument("--publish", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
    elif args.probe:
        probe()
    elif args.prepare:
        prepare()
    else:
        publish()
