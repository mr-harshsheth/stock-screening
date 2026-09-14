# Stock Screener

A serverless stock screener: a static page hosted on **GitHub Pages** plus a
Python analysis script run by **GitHub Actions**. No server to manage.

- The page displays your watchlist and the latest results, and can ask
  GitHub Actions to add stocks or run a fresh analysis.
- GitHub Actions fetches weekly price data from Yahoo Finance (`yfinance`),
  computes indicators, checks for signals, commits the results back into the
  repo as JSON, and emails you.

## Repo structure

```
stock-screener/
├── docs/                     # GitHub Pages serves from here
│   ├── index.html             # main page: watchlist, Analyze Now, results table
│   ├── style.css
│   ├── app.js                  # fetches docs/data/*.json, renders tables, calls GitHub API
│   ├── CNAME                    # only if you attach a custom domain (see below)
│   └── data/
│       ├── watchlist.json         # list of {name, ticker} entries
│       ├── results.json            # latest analysis results
│       ├── history.json             # log of past runs
│       └── unresolved.json           # scratch file used between resolve/analyze steps
├── scripts/
│   ├── analyze.py               # main analysis logic (fetch, indicators, signals)
│   ├── resolve_tickers.py        # turns typed company names into tickers
│   └── notify.py                  # email sending
├── .github/workflows/
│   ├── weekly-analysis.yml         # cron: Fridays after close
│   └── manual-analysis.yml          # workflow_dispatch: on-demand run + watchlist updates
├── requirements.txt
└── README.md
```

**Why is `data/` inside `docs/` instead of at the repo root?** GitHub Pages,
when configured to serve from the `/docs` folder, only publishes files
*inside* `docs/`. Anything outside it (like a top-level `data/` folder) isn't
reachable from the published site at all. Keeping `docs/data/*.json` means
`app.js` can fetch it with a plain relative path (`fetch("data/results.json")`)
and it "just works" on GitHub Pages with no extra configuration.

## How it fits together

```
Browser (GitHub Pages site)
   │  "Add to Watchlist" / "Analyze Now" buttons
   │  → POST https://api.github.com/repos/{owner}/{repo}/actions/workflows/manual-analysis.yml/dispatches
   │    (uses a GitHub Personal Access Token entered once, saved in localStorage)
   ▼
GitHub Actions workflow (scheduled OR dispatched)
   │  1. resolve_tickers.py: resolve any newly typed names -> tickers, update docs/data/watchlist.json
   │  2. analyze.py: fetch weekly data via yfinance, compute SMA20 + RSI14, check signal
   │  3. Writes docs/data/results.json (latest) and appends docs/data/history.json
   │  4. notify.py: emails you the results
   │  5. Commits the updated JSON files back to the repo
   ▼
GitHub Pages site reflects the new docs/data/results.json on next page load/refresh
```

---

## Setup

### 1. Create the repo and enable GitHub Pages

1. Create a new GitHub repository (public or private - private repos on a
   paid plan also support Pages; free plans need a public repo for Pages).
2. Push this project to it:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<your-repo>.git
   git push -u origin main
   ```
3. In the repo, go to **Settings → Pages**.
4. Under **Build and deployment → Source**, choose **Deploy from a branch**.
5. Branch: `main`, Folder: **`/docs`**. Save.
6. After a minute, your site will be live at
   `https://<your-username>.github.io/<your-repo>/`.

### 2. Attach a custom domain (optional)

1. In **Settings → Pages**, under **Custom domain**, enter your domain
   (e.g. `screener.yourdomain.com`) and save. GitHub will create/verify a
   `docs/CNAME` file in your repo automatically - or you can create it
   yourself with just the domain name as its contents:
   ```
   screener.yourdomain.com
   ```
2. At your DNS provider, add either:
   - A **CNAME record**: `screener` → `<your-username>.github.io` (for a
     subdomain), or
   - **A records** pointing your apex domain to GitHub Pages' IPs
     (185.199.108.153, 185.199.109.153, 185.199.110.153, 185.199.111.153) if
     you're using the bare domain.
3. Wait for DNS to propagate (can take minutes to hours), then in
   **Settings → Pages** check "Enforce HTTPS" once GitHub shows the
   certificate is ready.

### 3. Add SMTP secrets

1. Go to **Settings → Secrets and variables → Actions → New repository
   secret** and add three secrets:
   - `SMTP_USER` - your full email address (e.g. `you@gmail.com`)
   - `SMTP_PASS` - an **app password** (see step 4 below, not your normal
     password)
   - `NOTIFY_EMAIL_TO` - where the report should be sent (can be the same
     address)
2. `notify.py` reads these via `os.environ` - they're never written to the
   repo.

### 4. Generate a Gmail App Password

App Passwords require 2-Step Verification to be enabled on the Google
account.

1. Enable 2-Step Verification: <https://myaccount.google.com/signinoptions/two-step-verification>
2. Go to <https://myaccount.google.com/apppasswords>
3. Create a new app password (name it e.g. "stock screener"), copy the
   16-character password it gives you.
4. Use that as `SMTP_PASS` in the secret above. Using any other SMTP
   provider works too - just set `SMTP_HOST/SMTP_PORT` env vars in the
   workflow if not using Gmail's `smtp.gmail.com:587`.

### 5. Generate a GitHub Personal Access Token (for the webpage's buttons)

The webpage needs a token to call the GitHub API and trigger workflow runs.
This is a personal tool, so the token is entered once in the browser and
saved to `localStorage` - it never touches the repo or any server.

1. Go to <https://github.com/settings/tokens?type=beta> (fine-grained token)
   or the classic token page: <https://github.com/settings/tokens>
2. **Fine-grained token (recommended):**
   - Repository access: only this repository.
   - Permissions: **Actions: Read and write**, **Contents: Read and write**.
3. **Classic token (simpler, broader):**
   - Scopes: `repo` and `workflow`.
4. Generate, copy the token immediately (you won't see it again), and paste
   it into the page's **Setup** box along with your GitHub username and repo
   name. Click Save.

Treat this token like a password - anyone with it and your repo name could
trigger workflow runs or push commits with the scopes you granted.

### 6. GitHub Actions cron timing (UTC, no DST)

`weekly-analysis.yml` runs on:
```yaml
schedule:
  - cron: "0 21 * * 5"   # Friday, 21:00 UTC
```
GitHub Actions cron schedules are **always UTC** and do **not** shift for
daylight saving. 21:00 UTC on a Friday is:

- **5:00 PM US Eastern (EDT)** - mid-March to early November
- **4:00 PM US Eastern (EST)** - early November to mid-March

US markets close at 4:00 PM ET, so this schedule runs about an hour after
close during EDT and right at close during EST. If you want it pinned to an
exact local close time year-round, you'd need two cron lines (one for each
part of the year) or a small time-zone-aware check at the top of the
workflow - not done here to keep things simple, since GitHub Action runners
can also start a few minutes late.

Also note: `weekly-analysis.yml` has `workflow_dispatch: {}` too, so you can
manually trigger *that exact* workflow from the Actions tab for testing
without waiting for Friday.

### 7. End-to-end test

1. Open your Pages URL. Expand **Setup**, fill in your GitHub username, repo
   name, and token, click **Save**.
2. Type a couple of names into **Add stocks**, e.g. `Nvidia, Netflix`, click
   **Add to Watchlist**.
3. Go to your repo's **Actions** tab - you should see "Manual Analysis /
   Watchlist Update" running. It resolves the names, adds them to the
   watchlist, runs the analysis, emails you, and commits the results.
4. After it finishes (~30-60s), refresh the page (or wait for the
   auto-refresh) - the watchlist and results tables should show the new
   data, and you should have an email in your inbox.
5. Click **Analyze Now** to trigger a fresh run on demand at any time.
6. Try adding a deliberately misspelled name (e.g. `Aplpe`) - it should show
   up under "Could not resolve" on the page and in the email instead of
   silently vanishing.

---

## Testing `analyze.py` locally (before deploying anything)

You don't need GitHub Actions to check the indicator math and signal logic
- run it on your own machine first:

```bash
git clone https://github.com/<your-username>/<your-repo>.git
cd <your-repo>
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt

python scripts/analyze.py --run-type manual
```

This will:
- Read `docs/data/watchlist.json` (the seeded AAPL/MSFT/GOOGL/AMZN/TSLA list).
- Fetch weekly data for each from Yahoo Finance.
- Print a one-line summary (`X analyzed, Y signaled, Z failed`) to the
  terminal.
- Overwrite `docs/data/results.json` and append to `docs/data/history.json`
  locally, so you can open `docs/data/results.json` and inspect the exact
  close/SMA20/RSI14/signal numbers per ticker.

To test the email step too (optional, still local):
```bash
export SMTP_USER=you@gmail.com
export SMTP_PASS=xxxxxxxxxxxxxxxx   # the app password from step 4
export NOTIFY_EMAIL_TO=you@gmail.com
python scripts/notify.py
```

To test name resolution locally:
```bash
python scripts/resolve_tickers.py --input "Apple, MSFT, Tesla, Nvidia, Aplpe"
```
Check `docs/data/watchlist.json` for the new entries and
`docs/data/unresolved.json` for anything it couldn't match (in this example,
`Aplpe`).

If you want to sanity-check the RSI/SMA math against a chart, compare the
`close`, `sma20`, and `rsi14` values in `docs/data/results.json` against the
weekly chart for that ticker on Yahoo Finance or TradingView for the same
week (`week_of` field).

**Careful:** running `analyze.py` locally overwrites your local
`docs/data/results.json`/`history.json`. Don't commit/push those test runs
unless you want them to become the "official" latest results - `git status`
before committing, or just `git checkout -- docs/data/` to discard the test
output when you're done.

---

## Signal logic

Defined as constants at the top of `scripts/analyze.py`:

```python
MA_PERIOD = 20
RSI_PERIOD = 14
RSI_UPPER_THRESHOLD = 60
MA_DISTANCE_THRESHOLD_PCT = 2.0   # close must be this % above SMA20
```

A stock signals when, on the latest completed weekly candle:

```
close > SMA20 * (1 + MA_DISTANCE_THRESHOLD_PCT / 100)
AND
RSI14 > RSI_UPPER_THRESHOLD
```

RSI14 uses proper Wilder smoothing (an EMA with `alpha = 1/14`), not a
simple moving average of gains/losses.

## Troubleshooting

- **Buttons do nothing / 401 error**: token missing, expired, or wrong
  scopes. Regenerate per step 5.
- **404 error from the API**: check the GitHub username/repo name in Setup,
  and confirm `manual-analysis.yml` exists on the `main` branch.
- **Workflow runs but nothing changes on the page**: GitHub Pages can take
  up to a minute to pick up a new commit; the page also cache-busts its
  fetches, so a manual refresh should show it even if auto-refresh timed out.
- **No email arrives**: check the workflow run's "Send email notification"
  step logs in the Actions tab; it's set to not fail the whole run, so
  results still get committed even if SMTP is misconfigured.
- **A ticker keeps failing to fetch**: Yahoo Finance rate-limits aggressively
  under load; `analyze.py` retries each ticker a few times with backoff, but
  a very large watchlist (100+) run back-to-back with other runs may still
  see occasional failures - they're reported in the email/results and will
  usually succeed on the next run.
