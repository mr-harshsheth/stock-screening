"""
Send an email summarizing the latest analysis run in data/results.json.

Credentials come from environment variables (set as GitHub Actions secrets,
never committed):
  SMTP_USER       - full email address used to log in (e.g. Gmail address)
  SMTP_PASS       - app password (NOT your normal account password)
  NOTIFY_EMAIL_TO - where to send the report (can be the same address)

Optional:
  SMTP_HOST (default smtp.gmail.com)
  SMTP_PORT (default 587)

Usage:
  python scripts/notify.py
"""

import argparse
import json
import os
import smtplib
from email.mime.text import MIMEText
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_RESULTS_PATH = REPO_ROOT / "docs" / "data" / "results.json"

SMTP_HOST = os.environ.get("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))

RUN_TYPE_LABELS = {
    "scheduled": "Scheduled Friday",
    "manual": "Manual",
    "canada_index": "Canada Index (S&P/TSX Composite)",
    "us_index": "US Index (S&P 500 + Nasdaq-100)",
}

CATEGORY_ORDER = ["Strongest Buy", "Strong Buy", "Buy"]


def load_results(path: Path) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def build_email_body(payload: dict) -> str:
    results = payload.get("results", [])
    failed = payload.get("failed", [])
    unresolved = payload.get("unresolved", [])

    no_category_count = len([r for r in results if not r.get("category")])

    lines = []
    lines.append(f"Run type: {payload.get('run_type')}")
    lines.append(f"Generated at (UTC): {payload.get('generated_at')}")
    lines.append("")

    any_categorized = False
    for category in CATEGORY_ORDER:
        matches = [r for r in results if r.get("category") == category]
        if not matches:
            continue
        any_categorized = True
        lines.append(f"{category.upper()} ({len(matches)}):")
        for r in matches:
            lines.append(
                f"  {r['ticker']:8s} close={r['close']:<10} sma20={r['sma20']:<10} "
                f"%above_ma={r['pct_above_ma']:<7} rsi14={r['rsi14']:<7} vol_ratio={r['volume_ratio']}x"
            )
        lines.append("")

    if not any_categorized:
        lines.append("No stocks matched Strongest Buy / Strong Buy / Buy this run.")
        lines.append("")

    lines.append(f"No category: {no_category_count} ticker(s)")
    lines.append(f"Failed to fetch: {len(failed)} ticker(s)")
    if failed:
        for f_entry in failed:
            lines.append(f"  {f_entry['ticker']}: {f_entry['error']}")

    if unresolved:
        lines.append("")
        lines.append(f"Unresolved watchlist entries ({len(unresolved)}) - check spelling:")
        for u in unresolved:
            lines.append(f"  {u}")

    return "\n".join(lines)


def send_email(subject: str, body: str) -> None:
    smtp_user = os.environ["SMTP_USER"]
    smtp_pass = os.environ["SMTP_PASS"]
    to_addr = os.environ["NOTIFY_EMAIL_TO"]

    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = subject
    msg["From"] = smtp_user
    msg["To"] = to_addr

    with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
        server.starttls()
        server.login(smtp_user, smtp_pass)
        server.sendmail(smtp_user, [to_addr], msg.as_string())


def main():
    parser = argparse.ArgumentParser(description="Email a summary of the latest analysis run.")
    parser.add_argument(
        "--results-path",
        default=str(DEFAULT_RESULTS_PATH),
        help="Which results JSON file to summarize (defaults to the personal watchlist's results.json).",
    )
    args = parser.parse_args()

    payload = load_results(Path(args.results_path))
    run_type = payload.get("run_type", "unknown")
    run_label = RUN_TYPE_LABELS.get(run_type, run_type)

    categorized_count = len([r for r in payload.get("results", []) if r.get("category")])
    subject = f"[Stock Screener] {run_label} run - {categorized_count} categorized"
    body = build_email_body(payload)

    send_email(subject, body)
    print("[notify] email sent")


if __name__ == "__main__":
    main()
