"""
Fetch current constituent lists for major market indices from Wikipedia.

Neither yfinance nor a free Yahoo Finance endpoint exposes index membership
directly, so we scrape the tables Wikipedia maintains for each index. Ticker
symbols are normalized to the format Yahoo Finance expects:
  - share-class dots become dashes ("BRK.B" -> "BRK-B")
  - Toronto Stock Exchange listings get a ".TO" suffix appended
"""

import io

import pandas as pd
import requests

HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; stock-screener/1.0)"}

SP500_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
NASDAQ100_URL = "https://en.wikipedia.org/wiki/List_of_NASDAQ-100_companies"
TSX_URL = "https://en.wikipedia.org/wiki/S%26P/TSX_Composite_Index"


def _fetch_tables(url: str) -> list:
    resp = requests.get(url, headers=HEADERS, timeout=20)
    resp.raise_for_status()
    # Wikipedia serves UTF-8; without this, requests sometimes guesses the
    # wrong encoding from headers and mangles non-ASCII characters (e.g. the
    # en-dash in "Brown-Forman") into replacement characters.
    resp.encoding = "utf-8"
    return pd.read_html(io.StringIO(resp.text))


def _to_yahoo_symbol(raw: str) -> str:
    return raw.strip().replace(".", "-")


def _rows_to_entries(df: pd.DataFrame, ticker_col: str, name_col: str, suffix: str = "") -> list:
    """Drop rows with a missing ticker/name (Wikipedia tables occasionally have a
    malformed cell or a blank trailing row) and normalize the rest."""
    clean = df.dropna(subset=[ticker_col, name_col])
    entries = []
    for _, row in clean.iterrows():
        ticker = str(row[ticker_col]).strip()
        name = str(row[name_col]).strip()
        if not ticker or ticker.lower() == "nan" or not name or name.lower() == "nan":
            continue
        entries.append({"name": name, "ticker": f"{_to_yahoo_symbol(ticker)}{suffix}"})
    return entries


def get_sp500_constituents() -> list:
    """Returns [{'name', 'ticker'}, ...] for the current S&P 500."""
    tables = _fetch_tables(SP500_URL)
    for df in tables:
        cols = {str(c).strip() for c in df.columns}
        if "Symbol" in cols and "Security" in cols:
            return _rows_to_entries(df, "Symbol", "Security")
    raise RuntimeError("Could not find the S&P 500 constituents table on Wikipedia")


def get_nasdaq100_constituents() -> list:
    """Returns [{'name', 'ticker'}, ...] for the current Nasdaq-100."""
    tables = _fetch_tables(NASDAQ100_URL)
    for df in tables:
        cols = {str(c).strip() for c in df.columns}
        if "Ticker" in cols and "Company" in cols:
            return _rows_to_entries(df, "Ticker", "Company")
    raise RuntimeError("Could not find the Nasdaq-100 components table on Wikipedia")


def get_tsx_constituents() -> list:
    """Returns [{'name', 'ticker'}, ...] for the current S&P/TSX Composite."""
    tables = _fetch_tables(TSX_URL)
    for df in tables:
        cols = {str(c).strip() for c in df.columns}
        if "Ticker" in cols and "Company" in cols:
            return _rows_to_entries(df, "Ticker", "Company", suffix=".TO")
    raise RuntimeError("Could not find the S&P/TSX Composite components table on Wikipedia")
