"""
Resolve free-typed company names / tickers into confirmed ticker symbols and
merge them into data/watchlist.json.

Input is a single string (comma and/or newline separated), e.g.:
    "Apple, MSFT, Tesla\nNvidia"

For each entry we hit the Yahoo Finance search endpoint (the same one
yfinance and the Yahoo website use) and take the top equity/ETF match.
Anything that comes back empty is reported as "unresolved" so the caller can
fix a typo, rather than being silently dropped.

Usage:
  python scripts/resolve_tickers.py --input "Apple, MSFT, Tesla, Nvidia"
"""

import argparse
import json
import time
from pathlib import Path

import requests

MAX_RETRIES = 3
RETRY_BACKOFF_SECONDS = 5
SEARCH_URL = "https://query2.finance.yahoo.com/v1/finance/search"
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; stock-screener/1.0)"}
ACCEPTED_QUOTE_TYPES = {"EQUITY", "ETF"}

REPO_ROOT = Path(__file__).resolve().parent.parent
# Data files live under docs/ (not repo root) so GitHub Pages - configured to
# serve from /docs - can publish them for the front end to fetch directly.
DATA_DIR = REPO_ROOT / "docs" / "data"
WATCHLIST_PATH = DATA_DIR / "watchlist.json"
UNRESOLVED_PATH = DATA_DIR / "unresolved.json"


def split_input(raw: str) -> list:
    """Split on commas and/or newlines, trim whitespace, drop empties."""
    pieces = []
    for line in raw.replace(",", "\n").splitlines():
        entry = line.strip()
        if entry:
            pieces.append(entry)
    return pieces


def yahoo_search(query: str) -> list:
    """Query the Yahoo Finance search endpoint, with retry on rate limits/errors."""
    last_error = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = requests.get(
                SEARCH_URL,
                params={"q": query, "quotesCount": 5, "newsCount": 0},
                headers=HEADERS,
                timeout=10,
            )
            resp.raise_for_status()
            data = resp.json()
            return data.get("quotes", [])
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_BACKOFF_SECONDS * attempt)
    raise RuntimeError(f"search failed for '{query}': {last_error}")


def resolve_one(query: str) -> dict:
    """Return {'ticker', 'name'} on success, or None if nothing usable was found."""
    quotes = yahoo_search(query)
    candidates = [q for q in quotes if q.get("quoteType") in ACCEPTED_QUOTE_TYPES]
    if not candidates:
        return None
    top = candidates[0]
    symbol = top.get("symbol")
    if not symbol:
        return None
    name = top.get("longname") or top.get("shortname") or query
    return {"ticker": symbol, "name": name}


def load_watchlist() -> list:
    if not WATCHLIST_PATH.exists():
        return []
    with open(WATCHLIST_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def save_watchlist(watchlist: list) -> None:
    WATCHLIST_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(WATCHLIST_PATH, "w", encoding="utf-8") as f:
        json.dump(watchlist, f, indent=2)
        f.write("\n")


def save_unresolved(unresolved: list) -> None:
    """Always (re)write this file, even empty, so a clean run clears stale entries."""
    UNRESOLVED_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(UNRESOLVED_PATH, "w", encoding="utf-8") as f:
        json.dump(unresolved, f, indent=2)
        f.write("\n")


def add_entries(raw_input: str) -> dict:
    entries = split_input(raw_input)
    watchlist = load_watchlist()
    existing_tickers = {e["ticker"].upper() for e in watchlist}

    added = []
    already_present = []
    unresolved = []

    for entry in entries:
        try:
            match = resolve_one(entry)
        except Exception as exc:  # noqa: BLE001 - one bad lookup must not kill the batch
            print(f"[resolve] ERROR resolving '{entry}': {exc}")
            unresolved.append(entry)
            continue

        if match is None:
            print(f"[resolve] UNRESOLVED: '{entry}' - no equity/ETF match found")
            unresolved.append(entry)
            continue

        ticker = match["ticker"].upper()
        if ticker in existing_tickers:
            already_present.append(ticker)
            print(f"[resolve] '{entry}' -> {ticker} (already in watchlist)")
            continue

        watchlist.append({"name": match["name"], "ticker": ticker})
        existing_tickers.add(ticker)
        added.append(ticker)
        print(f"[resolve] '{entry}' -> {ticker} ({match['name']}) - added")

    save_watchlist(watchlist)
    save_unresolved(unresolved)

    summary = {
        "added": added,
        "already_present": already_present,
        "unresolved": unresolved,
    }
    print(f"[resolve] summary: {json.dumps(summary)}")
    return summary


def main():
    parser = argparse.ArgumentParser(description="Resolve names/tickers into the watchlist.")
    parser.add_argument(
        "--input",
        required=True,
        help="Comma and/or newline separated company names or tickers.",
    )
    args = parser.parse_args()
    add_entries(args.input)


if __name__ == "__main__":
    main()
