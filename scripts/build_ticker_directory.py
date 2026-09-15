"""
Build a static directory of well-known US/Canadian tickers for the page's
autocomplete box. Covers S&P 500 + Nasdaq-100 (tagged "US") and the
S&P/TSX Composite (tagged "Canada") - the same universes analyze_index.py
scans. Kept as one small static JSON file so the front end can offer
instant suggestions with zero network calls and no CORS issues (Yahoo
Finance's own search endpoint doesn't allow direct browser requests).

Usage:
  python scripts/build_ticker_directory.py
"""

import json

from analyze import DATA_DIR
from index_constituents import (
    get_nasdaq100_constituents,
    get_sp500_constituents,
    get_tsx_constituents,
)

OUTPUT_PATH_NAME = "known_tickers.json"


def build_directory() -> list:
    entries = []
    seen = set()

    for entry in get_sp500_constituents() + get_nasdaq100_constituents():
        if entry["ticker"] in seen:
            continue
        seen.add(entry["ticker"])
        entries.append({"name": entry["name"], "ticker": entry["ticker"], "market": "US"})

    for entry in get_tsx_constituents():
        if entry["ticker"] in seen:
            continue
        seen.add(entry["ticker"])
        entries.append({"name": entry["name"], "ticker": entry["ticker"], "market": "Canada"})

    entries.sort(key=lambda e: e["name"].lower())
    return entries


def main():
    directory = build_directory()
    output_path = DATA_DIR / OUTPUT_PATH_NAME
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(directory, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"[build_ticker_directory] wrote {len(directory)} entries to {output_path}")


if __name__ == "__main__":
    main()
