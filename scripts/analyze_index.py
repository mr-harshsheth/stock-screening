"""
Run the same weekly SMA20/RSI14 screener as analyze.py, but across an entire
market index instead of the personal watchlist:
  --index us      -> S&P 500 + Nasdaq-100 (deduplicated, ~550 tickers)
  --index canada  -> S&P/TSX Composite (~250 tickers)

Results are written to their own files (results_<index>.json,
history_<index>.json) so an index scan never touches data/watchlist.json or
the personal results/history.

A full run can take 15-30+ minutes given the number of tickers and Yahoo
Finance's rate limits - that's expected, not a bug.

Usage:
  python scripts/analyze_index.py --index us
  python scripts/analyze_index.py --index canada
"""

import argparse
import json
import sys
import time
from datetime import datetime, timezone

from analyze import DATA_DIR, analyze_ticker
from index_constituents import (
    get_nasdaq100_constituents,
    get_sp500_constituents,
    get_tsx_constituents,
)

REQUEST_DELAY_SECONDS = 0.3  # be polite to Yahoo Finance across hundreds of requests


def load_constituents(index: str) -> list:
    if index == "us":
        entries = get_sp500_constituents() + get_nasdaq100_constituents()
    elif index == "canada":
        entries = get_tsx_constituents()
    else:
        raise ValueError(f"unknown index '{index}'")

    # S&P 500 and Nasdaq-100 overlap heavily - de-duplicate by ticker.
    seen = set()
    deduped = []
    for entry in entries:
        if entry["ticker"] in seen:
            continue
        seen.add(entry["ticker"])
        deduped.append(entry)
    return deduped


def run_index_analysis(index: str) -> dict:
    constituents = load_constituents(index)
    print(f"[analyze_index] {index}: {len(constituents)} unique tickers to analyze")

    results = []
    failed = []

    for i, entry in enumerate(constituents):
        try:
            results.append(analyze_ticker(entry))
        except Exception as exc:  # noqa: BLE001 - one bad ticker must not kill the run
            print(f"[analyze_index] FAILED {entry['ticker']}: {exc}", file=sys.stderr)
            failed.append(
                {"ticker": entry["ticker"], "name": entry.get("name", entry["ticker"]), "error": str(exc)}
            )
        if i < len(constituents) - 1:
            time.sleep(REQUEST_DELAY_SECONDS)

    generated_at = datetime.now(timezone.utc).isoformat()
    run_type = f"{index}_index"

    payload = {
        "run_type": run_type,
        "generated_at": generated_at,
        "results": results,
        "failed": failed,
    }

    results_path = DATA_DIR / f"results_{index}.json"
    with open(results_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
        f.write("\n")

    history_entry = {
        "run_type": run_type,
        "generated_at": generated_at,
        "total": len(constituents),
        "signaled": [r["ticker"] for r in results if r["signal"]],
        "no_signal_count": len([r for r in results if not r["signal"]]),
        "failed": [f["ticker"] for f in failed],
    }

    history_path = DATA_DIR / f"history_{index}.json"
    history = []
    if history_path.exists():
        with open(history_path, "r", encoding="utf-8") as f:
            try:
                history = json.load(f)
            except json.JSONDecodeError:
                history = []
    history.append(history_entry)
    with open(history_path, "w", encoding="utf-8") as f:
        json.dump(history, f, indent=2)
        f.write("\n")

    print(
        f"[analyze_index] {index} done: {len(results)} analyzed, "
        f"{len(history_entry['signaled'])} signaled, {len(failed)} failed"
    )
    return payload


def main():
    parser = argparse.ArgumentParser(description="Run the screener across a full market index.")
    parser.add_argument("--index", choices=["us", "canada"], required=True)
    args = parser.parse_args()
    run_index_analysis(args.index)


if __name__ == "__main__":
    main()
