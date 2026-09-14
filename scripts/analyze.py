"""
Weekly stock screener.

Fetches weekly OHLC data for every ticker in docs/data/watchlist.json,
computes SMA20 and Wilder's RSI14 on the weekly close, and flags a "signal"
when the latest completed weekly candle satisfies the threshold conditions
below.

Writes:
  - docs/data/results.json   (overwritten each run: latest snapshot)
  - docs/data/history.json   (appended each run: one entry per run)

Usage:
  python scripts/analyze.py --run-type manual
  python scripts/analyze.py --run-type scheduled
"""

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import yfinance as yf

# ---------------------------------------------------------------------------
# Tunable constants - edit these to change signal behavior.
# ---------------------------------------------------------------------------
MA_PERIOD = 20
RSI_PERIOD = 14
RSI_UPPER_THRESHOLD = 60
MA_DISTANCE_THRESHOLD_PCT = 2.0  # close must be this % above SMA20

WEEKS_OF_HISTORY = 90  # weeks of data to pull so both indicators are warmed up
MAX_RETRIES = 3
RETRY_BACKOFF_SECONDS = 5

REPO_ROOT = Path(__file__).resolve().parent.parent
# Data files live under docs/ (not repo root) so GitHub Pages - configured to
# serve from /docs - can publish them for the front end to fetch directly.
DATA_DIR = REPO_ROOT / "docs" / "data"
WATCHLIST_PATH = DATA_DIR / "watchlist.json"
RESULTS_PATH = DATA_DIR / "results.json"
HISTORY_PATH = DATA_DIR / "history.json"
UNRESOLVED_PATH = DATA_DIR / "unresolved.json"


def load_unresolved() -> list:
    """Picks up names resolve_tickers.py couldn't match, written earlier in the same run."""
    if not UNRESOLVED_PATH.exists():
        return []
    with open(UNRESOLVED_PATH, "r", encoding="utf-8") as f:
        try:
            return json.load(f)
        except json.JSONDecodeError:
            return []


def load_watchlist() -> list:
    if not WATCHLIST_PATH.exists():
        return []
    with open(WATCHLIST_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def compute_rsi(close: pd.Series, period: int = RSI_PERIOD) -> pd.Series:
    """Wilder's RSI using Wilder smoothing (equivalent to an EMA with alpha=1/period)."""
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)

    avg_gain = gain.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()

    rs = avg_gain / avg_loss
    rsi = 100 - (100 / (1 + rs))
    # When avg_loss is 0 the RS ratio is infinite -> RSI should be 100.
    rsi = rsi.where(avg_loss != 0, 100.0)
    return rsi


def fetch_weekly_history(ticker: str) -> pd.DataFrame:
    """Fetch weekly OHLC data for a ticker, with basic retry on failure."""
    last_error = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            df = yf.Ticker(ticker).history(
                period=f"{WEEKS_OF_HISTORY}wk",
                interval="1wk",
                auto_adjust=True,
            )
            if df is None or df.empty:
                raise ValueError("no data returned")
            return df
        except Exception as exc:  # noqa: BLE001 - we want to retry on anything and report it
            last_error = exc
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_BACKOFF_SECONDS * attempt)
    raise RuntimeError(f"failed to fetch data for {ticker}: {last_error}")


def drop_incomplete_week(df: pd.DataFrame) -> pd.DataFrame:
    """
    yfinance weekly bars are indexed by the first trading day of the week
    (Monday). If today falls inside that same week, the last bar only
    reflects however many days have traded so far - not a completed weekly
    candle. Since "Analyze Now" can be clicked any day, drop that bar so the
    signal is always computed on the latest *finished* week (matching the
    scheduled Friday-after-close run).
    """
    last_bar_start = pd.Timestamp(df.index[-1])
    if last_bar_start.tzinfo is not None:
        last_bar_start = last_bar_start.tz_convert("UTC").tz_localize(None)

    week_end_date = (last_bar_start + pd.Timedelta(days=4)).date()  # Friday of that week
    today_utc = datetime.now(timezone.utc).date()

    if today_utc < week_end_date:
        return df.iloc[:-1]
    return df


def analyze_ticker(entry: dict) -> dict:
    """Run the indicator/signal computation for a single watchlist entry."""
    ticker = entry["ticker"]
    name = entry.get("name", ticker)

    df = fetch_weekly_history(ticker)
    df = drop_incomplete_week(df)

    if len(df) < max(MA_PERIOD, RSI_PERIOD) + 1:
        raise RuntimeError(
            f"not enough weekly history for {ticker} ({len(df)} weeks, need at least "
            f"{max(MA_PERIOD, RSI_PERIOD) + 1})"
        )

    close = df["Close"]
    sma20 = close.rolling(window=MA_PERIOD).mean()
    rsi14 = compute_rsi(close, RSI_PERIOD)

    latest_close = float(close.iloc[-1])
    latest_sma = float(sma20.iloc[-1])
    latest_rsi = float(rsi14.iloc[-1])

    if pd.isna(latest_sma) or pd.isna(latest_rsi):
        raise RuntimeError(f"indicators not warmed up yet for {ticker}")

    pct_above_ma = ((latest_close - latest_sma) / latest_sma) * 100

    signal = (
        latest_close > latest_sma * (1 + MA_DISTANCE_THRESHOLD_PCT / 100)
        and latest_rsi > RSI_UPPER_THRESHOLD
    )

    latest_date = df.index[-1]
    if hasattr(latest_date, "isoformat"):
        latest_date = latest_date.date().isoformat()
    else:
        latest_date = str(latest_date)

    return {
        "name": name,
        "ticker": ticker,
        "week_of": latest_date,
        "close": round(latest_close, 2),
        "sma20": round(latest_sma, 2),
        "pct_above_ma": round(pct_above_ma, 2),
        "rsi14": round(latest_rsi, 2),
        "signal": bool(signal),
    }


def run_analysis(run_type: str) -> dict:
    watchlist = load_watchlist()

    results = []
    failed = []

    for entry in watchlist:
        ticker = entry.get("ticker", "?")
        try:
            results.append(analyze_ticker(entry))
        except Exception as exc:  # noqa: BLE001 - one bad ticker must not kill the run
            print(f"[analyze] FAILED {ticker}: {exc}", file=sys.stderr)
            failed.append({"ticker": ticker, "name": entry.get("name", ticker), "error": str(exc)})

    generated_at = datetime.now(timezone.utc).isoformat()
    unresolved = load_unresolved()

    payload = {
        "run_type": run_type,
        "generated_at": generated_at,
        "results": results,
        "failed": failed,
        "unresolved": unresolved,
    }

    RESULTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(RESULTS_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
        f.write("\n")

    history_entry = {
        "run_type": run_type,
        "generated_at": generated_at,
        "total": len(watchlist),
        "signaled": [r["ticker"] for r in results if r["signal"]],
        "no_signal_count": len([r for r in results if not r["signal"]]),
        "failed": [f["ticker"] for f in failed],
        "unresolved": unresolved,
    }

    history = []
    if HISTORY_PATH.exists():
        with open(HISTORY_PATH, "r", encoding="utf-8") as f:
            try:
                history = json.load(f)
            except json.JSONDecodeError:
                history = []
    history.append(history_entry)
    with open(HISTORY_PATH, "w", encoding="utf-8") as f:
        json.dump(history, f, indent=2)
        f.write("\n")

    print(
        f"[analyze] done: {len(results)} analyzed, "
        f"{len(history_entry['signaled'])} signaled, {len(failed)} failed"
    )
    return payload


def main():
    parser = argparse.ArgumentParser(description="Run the weekly stock screener.")
    parser.add_argument(
        "--run-type",
        choices=["scheduled", "manual"],
        default="manual",
        help="Label stored in results.json/history.json and used in the email subject.",
    )
    args = parser.parse_args()
    run_analysis(args.run_type)


if __name__ == "__main__":
    main()
