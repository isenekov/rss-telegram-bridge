#!/usr/bin/env python3
"""RSS to Telegram Bridge: fresh articles, shared limits and deduplication."""

import calendar
import hashlib
import html
import json
import os
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import feedparser
import httpx
import yaml
from dotenv import load_dotenv

load_dotenv()
BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")
BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "config.yaml"
POSTED_PATH = BASE_DIR / "posted.json"
STATE_VERSION = 2


def clean_html(value):
    text = re.sub(r"<[^>]*>", " ", str(value or ""))
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def truncate(value, limit):
    if len(value) <= limit:
        return value
    if limit < 4:
        return value[:limit]
    return value[:limit - 3].rsplit(" ", 1)[0] + "..."


def normalize_link(link):
    try:
        parts = urlsplit((link or "").strip())
        host = (parts.hostname or "").lower().removeprefix("www.")
        if not host:
            return ""
        path = (parts.path or "/").rstrip("/").lower() or "/"
        if path.endswith("/amp"):
            path = path[:-4] or "/"
        # Drop tracking/query parameters and fragments for article deduplication.
        return urlunsplit(("https", host, path, "", ""))
    except ValueError:
        return ""


def article_keys(entry, source):
    link = normalize_link(entry.get("link", ""))
    title = clean_html(entry.get("title", "")).casefold()
    keys = set()
    if link:
        keys.add("url:" + hashlib.sha256(link.encode()).hexdigest()[:24])
    if title:
        normalized_title = re.sub(r"\s+", " ", title)
        keys.add("title:" + source.casefold() + ":" +
                 hashlib.sha256(normalized_title.encode()).hexdigest()[:24])

    # Compatibility with old posted.json: legacy IDs may be RSS GUIDs.
    legacy_id = entry.get("id") or entry.get("link", "")
    if legacy_id:
        keys.add(hashlib.sha256(str(legacy_id).encode()).hexdigest()[:16])
    return keys


def load_state():
    if not POSTED_PATH.exists():
        return set(), False
    try:
        with POSTED_PATH.open(encoding="utf-8") as handle:
            state = json.load(handle)
        if not isinstance(state, dict):
            raise ValueError("posted.json must contain an object")
        return set(state.get("posted", [])), state.get("state_version", 0) >= STATE_VERSION
    except (OSError, ValueError, TypeError) as exc:
        # Fail closed: never resend a whole feed if the history is corrupt.
        raise RuntimeError(f"Cannot load posted.json safely: {exc}") from exc


def save_state(posted):
    payload = {
        "posted": sorted(posted),
        "state_version": STATE_VERSION,
        "updated": datetime.now(timezone.utc).isoformat(),
    }
    temp_path = POSTED_PATH.with_suffix(".json.tmp")
    with temp_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=False)
    temp_path.replace(POSTED_PATH)


def entry_date(entry):
    for field in ("published_parsed", "updated_parsed", "created_parsed"):
        parsed = entry.get(field)
        if parsed:
            try:
                return datetime.fromtimestamp(calendar.timegm(parsed), timezone.utc)
            except (TypeError, ValueError, OverflowError):
                pass
    return None


def category_for(entry, feed):
    category = str(feed.get("category", "ARTICLE")).upper()
    if category == "AUTO":
        tags = " ".join(
            str(tag.get("term", "")) for tag in entry.get("tags", [])
        ).casefold()
        if "review" in tags:
            return "REVIEW"
        if "video" in tags:
            return "VIDEO"
        if "news" in tags:
            return "NEWS"
        return "ARTICLE"
    return category if category in {"NEWS", "REVIEW", "VIDEO", "ARTICLE"} else "ARTICLE"


def fetch_entries(url):
    try:
        with httpx.Client(timeout=30, follow_redirects=True, headers={
            "User-Agent": "Mozilla/5.0 (compatible; RSS-Telegram-Bridge/2.0)",
            "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
        }) as client:
            response = client.get(url)
            response.raise_for_status()
        parsed = feedparser.parse(response.content)
        if parsed.bozo and not parsed.entries:
            print(f"⚠️ RSS parsing failed: {parsed.bozo_exception}")
        return parsed.entries
    except (httpx.HTTPError, ValueError) as exc:
        print(f"❌ RSS request failed for {url}: {exc}")
        return []


def render_message(item, settings):
    entry = item["entry"]
    source = html.escape(item["source"])
    category = html.escape(item["category"])
    title = html.escape(clean_html(entry.get("title", "Untitled")))
    url = html.escape(entry.get("link", ""), quote=True)
    lines = [f"<b>{category} | {source}</b>", f"<b>{title}</b>"]

    if settings.get("include_summary", True):
        summary = clean_html(entry.get("summary") or entry.get("description"))
        if summary:
            summary = truncate(summary, int(settings.get("summary_max_length", 280)))
            lines.append(html.escape(summary))

    if url:
        lines.append(f'🔗 <a href="{url}">Читать на {source}</a>')
    return "\n\n".join(lines)


def send_message(client, message):
    if not BOT_TOKEN or not CHAT_ID:
        raise RuntimeError("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID")
    endpoint = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    payload = {
        "chat_id": CHAT_ID,
        "text": message,
        "parse_mode": "HTML",
        "disable_web_page_preview": False,
    }
    for attempt in range(3):
        try:
            response = client.post(endpoint, json=payload)
            if response.status_code == 200 and response.json().get("ok"):
                return True
            if response.status_code == 429 and attempt < 2:
                wait = response.json().get("parameters", {}).get("retry_after", 2)
                time.sleep(min(max(float(wait), 1.0), 30.0))
                continue
            print(f"❌ Telegram API error: {response.status_code} - {response.text[:500]}")
            return False
        except (httpx.HTTPError, ValueError) as exc:
            print(f"❌ Telegram request failed: {exc}")
            if attempt < 2:
                time.sleep(2)
    return False


def process_feeds():
    print(f"🚀 Starting RSS to Telegram Bridge - {datetime.now(timezone.utc).isoformat()}")
    if not BOT_TOKEN or not CHAT_ID:
        raise RuntimeError("Missing Telegram secrets")

    with CONFIG_PATH.open(encoding="utf-8") as handle:
        config = yaml.safe_load(handle) or {}
    settings = config.get("settings") or {}
    max_per_run = max(0, int(settings.get("max_articles_per_run", 40)))
    age_hours = max(0, float(settings.get("max_article_age_hours", 2)))
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=age_hours)

    posted, initialized = load_state()
    original_count = len(posted)
    candidates = []
    all_keys = set()
    fetched_count = 0
    for index, feed in enumerate(config.get("feeds") or []):
        if not feed.get("enabled", True) or not feed.get("url"):
            continue
        name = str(feed.get("name", "RSS"))
        source = str(feed.get("source") or ("Eurogamer" if "eurogamer" in feed["url"] else "IGN"))
        print(f"\n📡 Fetching: {name}")
        entries = fetch_entries(feed["url"])
        fetched_count += len(entries)
        print(f"   Found {len(entries)} entries")

        for entry in entries:
            keys = article_keys(entry, source)
            if not keys:
                continue
            all_keys.update(keys)
            date = entry_date(entry)
            if date is None or not (cutoff <= date <= now + timedelta(minutes=10)):
                continue
            category = category_for(entry, feed)
            priority = {"REVIEW": 0, "VIDEO": 1, "NEWS": 2, "ARTICLE": 3}[category]
            candidates.append({
                "entry": entry, "source": source, "category": category,
                "date": date, "keys": keys, "priority": priority,
                "feed_order": index,
            })

    if not initialized:
        # First version-2 run: remember all visible items without replaying them.
        posted.update(all_keys)
        save_state(posted)
        print(f"\n🛡️ Initialized deduplicated history: {len(all_keys)} keys, "
              f"{fetched_count} RSS entries scanned. No old articles reposted.")
        return

    # Prefer the specific feed's label when entries overlap with general feeds.
    candidates.sort(key=lambda x: (x["priority"], x["feed_order"], -x["date"].timestamp()))
    unique = []
    seen = set()
    for item in candidates:
        if item["keys"] & seen:
            continue
        seen.update(item["keys"])
        unique.append(item)

    new_items = [item for item in unique if not (item["keys"] & posted)]
    # Most recent 40 across every source, then send those chronologically.
    new_items.sort(key=lambda x: x["date"], reverse=True)
    selected = sorted(new_items[:max_per_run], key=lambda x: x["date"])

    sent = 0
    with httpx.Client(timeout=30) as client:
        for item in selected:
            message = render_message(item, settings)
            if send_message(client, message):
                posted.update(item["keys"])
                sent += 1
                print(f"   ✅ Posted [{item['source']} / {item['category']}]: "
                      f"{clean_html(item['entry'].get('title', ''))[:70]}")
                # Telegram limits message frequency per channel.
                time.sleep(1.1)
            else:
                print(f"   ❌ Failed [{item['source']}]: "
                      f"{clean_html(item['entry'].get('title', ''))[:70]}")

    if len(posted) != original_count:
        save_state(posted)

    print("\n📊 Summary:")
    print(f"   RSS entries scanned: {fetched_count}")
    print(f"   Fresh unique articles: {len(new_items)}")
    print(f"   Articles posted this run: {sent} (limit: {max_per_run} total)")
    print(f"   Total tracked keys: {len(posted)}")
    print("✅ Done!")


if __name__ == "__main__":
    process_feeds()
