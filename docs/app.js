// ---------------------------------------------------------------------------
// Stock Screener front end.
//
// This page never runs Python itself - it only reads the JSON files that
// GitHub Actions writes back into this repo (data/*.json) and, when you
// click a button, asks the GitHub API to start a workflow run.
// ---------------------------------------------------------------------------

const MANUAL_WORKFLOW_FILE = "manual-analysis.yml";
const INDEX_WORKFLOW_FILE = "index-analysis.yml";

const LS_KEYS = {
  owner: "ss_gh_owner",
  repo: "ss_gh_repo",
  branch: "ss_gh_branch",
  token: "ss_gh_token",
};

const POLL_INTERVAL_MS = 15000;
const POLL_MAX_ATTEMPTS = 20; // ~5 minutes - personal watchlist runs are quick

const INDEX_POLL_INTERVAL_MS = 20000;
const INDEX_POLL_MAX_ATTEMPTS = 90; // ~30 minutes - full index scans are slow

const MAX_SUGGESTIONS = 8;

// A ticker is assigned to at most one of these, highest first. Anything not
// matching any category is excluded from the results shown on the page.
const CATEGORY_ORDER = ["Strongest Buy", "Strong Buy", "Buy"];
const CATEGORY_CLASS = {
  "Strongest Buy": "cat-strongest",
  "Strong Buy": "cat-strong",
  Buy: "cat-buy",
};

// Per-region config. "main" is the personal watchlist; "canada" and "us"
// are the full-index scans. Each renders its results as three category
// groups (Strongest Buy / Strong Buy / Buy) inside its "groupsId" container.
const REGIONS = {
  main: {
    resultsPath: "data/results.json",
    groupsId: "results-groups",
    lastAnalyzedId: "last-analyzed",
    failedBoxId: "failed-box",
    failedListId: "failed-list",
    unresolvedBoxId: "unresolved-box",
    unresolvedListId: "unresolved-list",
  },
  canada: {
    resultsPath: "data/results_canada.json",
    groupsId: "results-canada-groups",
    lastAnalyzedId: "last-analyzed-canada",
    failedBoxId: "canada-failed-box",
    failedListId: "canada-failed-list",
  },
  us: {
    resultsPath: "data/results_us.json",
    groupsId: "results-us-groups",
    lastAnalyzedId: "last-analyzed-us",
    failedBoxId: "us-failed-box",
    failedListId: "us-failed-list",
  },
};

// sortStates[region][category] = { key, asc } - each category table sorts independently.
const sortStates = {};
for (const region of Object.keys(REGIONS)) {
  sortStates[region] = {};
  for (const category of CATEGORY_ORDER) {
    sortStates[region][category] = { key: "pct_above_ma", asc: false };
  }
}

const lastPayload = { main: null, canada: null, us: null };

// ---------------------------------------------------------------------------
// Setup / localStorage
// ---------------------------------------------------------------------------

function getSetup() {
  return {
    owner: localStorage.getItem(LS_KEYS.owner) || "",
    repo: localStorage.getItem(LS_KEYS.repo) || "",
    branch: localStorage.getItem(LS_KEYS.branch) || "main",
    token: localStorage.getItem(LS_KEYS.token) || "",
  };
}

function saveSetup() {
  const owner = document.getElementById("gh-owner").value.trim();
  const repo = document.getElementById("gh-repo").value.trim();
  const branch = document.getElementById("gh-branch").value.trim() || "main";
  const token = document.getElementById("gh-token").value.trim();

  localStorage.setItem(LS_KEYS.owner, owner);
  localStorage.setItem(LS_KEYS.repo, repo);
  localStorage.setItem(LS_KEYS.branch, branch);
  if (token) {
    localStorage.setItem(LS_KEYS.token, token);
  }

  document.getElementById("setup-status").textContent = "Saved.";
  setTimeout(() => (document.getElementById("setup-status").textContent = ""), 2000);
}

function populateSetupForm() {
  const setup = getSetup();
  document.getElementById("gh-owner").value = setup.owner;
  document.getElementById("gh-repo").value = setup.repo;
  document.getElementById("gh-branch").value = setup.branch;
  document.getElementById("gh-token").value = setup.token;

  // If not configured yet, show the box automatically so it's not missed.
  if (!setup.owner || !setup.repo || !setup.token) {
    document.getElementById("setup-body").hidden = false;
  }
}

// ---------------------------------------------------------------------------
// GitHub API
// ---------------------------------------------------------------------------

async function dispatchWorkflow(workflowFile, inputs) {
  const setup = getSetup();
  if (!setup.owner || !setup.repo || !setup.token) {
    throw new Error("Fill in the Setup box first (owner, repo, token).");
  }

  const url = `https://api.github.com/repos/${setup.owner}/${setup.repo}/actions/workflows/${workflowFile}/dispatches`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${setup.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ref: setup.branch,
      inputs: inputs,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    if (resp.status === 401) {
      throw new Error("GitHub rejected the token (401). Check it's valid and has repo+workflow scopes.");
    }
    if (resp.status === 404) {
      throw new Error("Workflow or repo not found (404). Check owner/repo names and that the workflow file exists on the default branch.");
    }
    throw new Error(`GitHub API error ${resp.status}: ${text}`);
  }
}

// ---------------------------------------------------------------------------
// Data loading (relative fetches - works as-is on GitHub Pages)
// ---------------------------------------------------------------------------

async function fetchJson(path) {
  // Cache-bust so we don't get a stale copy right after a workflow updates it.
  const resp = await fetch(`${path}?t=${Date.now()}`, { cache: "no-store" });
  if (!resp.ok) {
    throw new Error(`Failed to load ${path}: ${resp.status}`);
  }
  return resp.json();
}

async function loadWatchlist() {
  try {
    const watchlist = await fetchJson("data/watchlist.json");
    renderWatchlist(watchlist);
  } catch (err) {
    console.error(err);
  }
}

async function loadHistory() {
  try {
    const history = await fetchJson("data/history.json");
    renderHistory(history);
  } catch (err) {
    console.error(err);
  }
}

async function loadRegionResults(region) {
  const config = REGIONS[region];
  try {
    const payload = await fetchJson(config.resultsPath);
    renderResultsInto(region, payload);
    return payload;
  } catch (err) {
    console.error(err);
    return null;
  }
}

let tickerDirectory = [];

async function loadTickerDirectory() {
  try {
    tickerDirectory = await fetchJson("data/known_tickers.json");
  } catch (err) {
    console.error("Could not load ticker directory for autocomplete:", err);
    tickerDirectory = [];
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function tickerLinkHtml(ticker, name) {
  return `<a href="#" class="ticker-link" data-ticker="${escapeHtml(ticker)}" data-name="${escapeHtml(name)}">${escapeHtml(ticker)}</a>`;
}

function renderWatchlist(watchlist) {
  const tbody = document.querySelector("#watchlist-table tbody");
  tbody.innerHTML = "";
  watchlist.forEach((entry) => {
    const tr = document.createElement("tr");

    const nameTd = document.createElement("td");
    nameTd.textContent = entry.name;
    tr.appendChild(nameTd);

    const tickerTd = document.createElement("td");
    tickerTd.innerHTML = tickerLinkHtml(entry.ticker, entry.name);
    tr.appendChild(tickerTd);

    const actionTd = document.createElement("td");
    const removeBtn = document.createElement("button");
    removeBtn.textContent = "Remove";
    removeBtn.className = "remove-btn";
    removeBtn.addEventListener("click", () => removeTicker(entry.ticker));
    actionTd.appendChild(removeBtn);
    tr.appendChild(actionTd);

    tbody.appendChild(tr);
  });
}

function sortResults(results, sortState) {
  if (!sortState.key) return results;
  const copy = results.slice();
  copy.sort((a, b) => {
    const av = a[sortState.key];
    const bv = b[sortState.key];
    if (typeof av === "string") {
      return sortState.asc ? av.localeCompare(bv) : bv.localeCompare(av);
    }
    return sortState.asc ? av - bv : bv - av;
  });
  return copy;
}

function buildCategoryTable(region, category, rows) {
  const table = document.createElement("table");
  table.className = "category-table";
  table.innerHTML = `
    <thead>
      <tr>
        <th data-key="ticker">Ticker</th>
        <th data-key="name">Name</th>
        <th data-key="close">Close</th>
        <th data-key="sma20">SMA20</th>
        <th data-key="pct_above_ma">% above MA</th>
        <th data-key="rsi14">RSI14</th>
        <th data-key="volume_ratio">Vol vs 20w avg</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;

  const tbody = table.querySelector("tbody");
  rows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${tickerLinkHtml(r.ticker, r.name)}</td>
      <td>${escapeHtml(r.name)}</td>
      <td>${r.close}</td>
      <td>${r.sma20}</td>
      <td>${r.pct_above_ma}%</td>
      <td>${r.rsi14}</td>
      <td>${r.volume_ratio}x</td>
    `;
    tbody.appendChild(tr);
  });

  table.querySelectorAll("th[data-key]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.key;
      const state = sortStates[region][category];
      if (state.key === key) {
        state.asc = !state.asc;
      } else {
        state.key = key;
        state.asc = true;
      }
      if (lastPayload[region]) renderResultsInto(region, lastPayload[region]);
    });
  });

  return table;
}

function renderResultsInto(region, payload) {
  lastPayload[region] = payload;
  const config = REGIONS[region];

  const allResults = (payload && payload.results) || [];
  const failed = (payload && payload.failed) || [];
  const unresolved = (payload && payload.unresolved) || [];

  const groupsEl = document.getElementById(config.groupsId);
  groupsEl.innerHTML = "";

  let totalCategorized = 0;
  CATEGORY_ORDER.forEach((category) => {
    const matches = allResults.filter((r) => r.category === category);
    totalCategorized += matches.length;
    const sorted = sortResults(matches, sortStates[region][category]);

    const section = document.createElement("div");
    section.className = "category-group";

    const heading = document.createElement("h3");
    heading.className = `category-heading ${CATEGORY_CLASS[category]}`;
    heading.textContent = `${category} (${matches.length})`;
    section.appendChild(heading);

    if (matches.length) {
      section.appendChild(buildCategoryTable(region, category, sorted));
    } else {
      const p = document.createElement("p");
      p.className = "hint category-empty";
      p.textContent = "No stocks currently in this category.";
      section.appendChild(p);
    }

    groupsEl.appendChild(section);
  });

  const lastAnalyzed = document.getElementById(config.lastAnalyzedId);
  if (payload && payload.generated_at) {
    lastAnalyzed.textContent = `Last analyzed: ${payload.generated_at} (${payload.run_type || "unknown"} run, ${allResults.length} scanned, ${totalCategorized} categorized)`;
  } else {
    lastAnalyzed.textContent = "No analysis has been run yet.";
  }

  const failedBox = document.getElementById(config.failedBoxId);
  const failedList = document.getElementById(config.failedListId);
  if (failed.length) {
    failedList.textContent = failed.map((f) => f.ticker).join(", ");
    failedBox.hidden = false;
  } else {
    failedBox.hidden = true;
  }

  if (config.unresolvedBoxId) {
    const unresolvedBox = document.getElementById(config.unresolvedBoxId);
    const unresolvedList = document.getElementById(config.unresolvedListId);
    if (unresolved.length) {
      unresolvedList.textContent = unresolved.join(", ");
      unresolvedBox.hidden = false;
    } else {
      unresolvedBox.hidden = true;
    }
  }
}

function renderHistory(history) {
  const tbody = document.querySelector("#history-table tbody");
  tbody.innerHTML = "";
  history
    .slice()
    .reverse()
    .forEach((h) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${h.generated_at}</td>
        <td>${h.run_type}</td>
        <td>${h.total}</td>
        <td>${(h.strongest_buy || []).join(", ") || "-"}</td>
        <td>${(h.strong_buy || []).join(", ") || "-"}</td>
        <td>${(h.buy || []).join(", ") || "-"}</td>
        <td>${h.no_category_count}</td>
        <td>${(h.failed || []).join(", ") || "-"}</td>
        <td>${(h.unresolved || []).join(", ") || "-"}</td>
      `;
      tbody.appendChild(tr);
    });
}

// ---------------------------------------------------------------------------
// Chart modal (TradingView widget, loaded lazily on first use)
// ---------------------------------------------------------------------------

let tvScriptPromise = null;

function loadTradingViewScript() {
  if (window.TradingView) return Promise.resolve();
  if (tvScriptPromise) return tvScriptPromise;

  tvScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/tv.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Could not load the TradingView chart library."));
    document.head.appendChild(script);
  });
  return tvScriptPromise;
}

function toTradingViewSymbol(ticker) {
  if (ticker.endsWith(".TO")) {
    return `TSX:${ticker.slice(0, -3)}`;
  }
  return ticker;
}

function openChart(ticker, name) {
  const modal = document.getElementById("chart-modal");
  const title = document.getElementById("chart-modal-title");
  const container = document.getElementById("tv-chart-container");

  title.textContent = name ? `${name} (${ticker})` : ticker;
  container.innerHTML = "";
  modal.hidden = false;

  loadTradingViewScript()
    .then(() => {
      container.innerHTML = "";
      new window.TradingView.widget({
        autosize: true,
        symbol: toTradingViewSymbol(ticker),
        // Weekly by default since that's the timeframe our SMA20/RSI14/
        // category logic is computed on - you can still switch it in the
        // widget's own toolbar.
        interval: "W",
        timezone: "Etc/UTC",
        theme: "light",
        style: "1",
        locale: "en",
        toolbar_bg: "#f8f9fb",
        enable_publishing: false,
        allow_symbol_change: false,
        container_id: "tv-chart-container",
        studies: ["MASimple@tv-basicstudies", "RSI@tv-basicstudies", "Volume@tv-basicstudies"],
        studies_overrides: {
          "moving average.length": 20,
          "relative strength index.length": 14,
        },
      });
    })
    .catch((err) => {
      container.innerHTML = `<p class="hint warn">${escapeHtml(err.message)}</p>`;
    });
}

function closeChart() {
  document.getElementById("chart-modal").hidden = true;
  document.getElementById("tv-chart-container").innerHTML = "";
}

// ---------------------------------------------------------------------------
// Autocomplete + watchlist "chips"
// ---------------------------------------------------------------------------

let pendingChips = [];
let currentSuggestions = [];
let activeSuggestionIndex = -1;

function renderChips() {
  const row = document.getElementById("pending-chips");
  row.innerHTML = "";
  pendingChips.forEach((chip, i) => {
    const span = document.createElement("span");
    span.className = "chip";
    span.innerHTML = `${escapeHtml(chip.label)} <button type="button" aria-label="Remove">&times;</button>`;
    span.querySelector("button").addEventListener("click", () => {
      pendingChips.splice(i, 1);
      renderChips();
    });
    row.appendChild(span);
  });
}

function addChip(chip) {
  const exists = pendingChips.some((c) => c.value.toLowerCase() === chip.value.toLowerCase());
  if (!exists) {
    pendingChips.push(chip);
    renderChips();
  }
}

function hideSuggestions() {
  document.getElementById("stock-suggestions").hidden = true;
  currentSuggestions = [];
  activeSuggestionIndex = -1;
}

function renderSuggestions(matches) {
  currentSuggestions = matches;
  activeSuggestionIndex = -1;
  const ul = document.getElementById("stock-suggestions");
  ul.innerHTML = "";

  if (!matches.length) {
    ul.hidden = true;
    return;
  }

  matches.forEach((entry, i) => {
    const li = document.createElement("li");
    li.innerHTML = `${escapeHtml(entry.name)} <span class="suggestion-ticker">${escapeHtml(entry.ticker)}</span> <span class="suggestion-market">${entry.market}</span>`;
    li.addEventListener("mousedown", (e) => {
      e.preventDefault(); // keep focus in the input so typing can continue
      selectSuggestion(entry);
    });
    ul.appendChild(li);
  });
  ul.hidden = false;
}

function selectSuggestion(entry) {
  addChip({ label: `${entry.name} (${entry.ticker})`, value: entry.ticker });
  const input = document.getElementById("stock-search");
  input.value = "";
  hideSuggestions();
  input.focus();
}

function updateActiveSuggestion() {
  document.querySelectorAll("#stock-suggestions li").forEach((li, i) => {
    li.classList.toggle("active", i === activeSuggestionIndex);
  });
}

function onSearchInput(e) {
  const query = e.target.value.trim().toLowerCase();
  if (!query) {
    hideSuggestions();
    return;
  }

  const scored = [];
  for (const entry of tickerDirectory) {
    const ticker = entry.ticker.toLowerCase();
    const name = entry.name.toLowerCase();
    let score;
    if (ticker === query) score = 0;
    else if (ticker.startsWith(query)) score = 1;
    else if (name.startsWith(query)) score = 2;
    else if (name.includes(query) || ticker.includes(query)) score = 3;
    else continue;
    scored.push({ entry, score });
  }
  scored.sort((a, b) => a.score - b.score || a.entry.name.localeCompare(b.entry.name));
  renderSuggestions(scored.slice(0, MAX_SUGGESTIONS).map((s) => s.entry));
}

function onSearchKeydown(e) {
  if (e.key === "ArrowDown") {
    if (!currentSuggestions.length) return;
    e.preventDefault();
    activeSuggestionIndex = (activeSuggestionIndex + 1) % currentSuggestions.length;
    updateActiveSuggestion();
  } else if (e.key === "ArrowUp") {
    if (!currentSuggestions.length) return;
    e.preventDefault();
    activeSuggestionIndex = (activeSuggestionIndex - 1 + currentSuggestions.length) % currentSuggestions.length;
    updateActiveSuggestion();
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (activeSuggestionIndex >= 0 && currentSuggestions[activeSuggestionIndex]) {
      selectSuggestion(currentSuggestions[activeSuggestionIndex]);
    } else {
      const value = e.target.value.trim();
      if (value) {
        addChip({ label: value, value: value });
        e.target.value = "";
        hideSuggestions();
      }
    }
  } else if (e.key === "Escape") {
    hideSuggestions();
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function addToWatchlist() {
  const statusEl = document.getElementById("add-status");

  if (pendingChips.length === 0) {
    statusEl.textContent = "Add at least one stock first.";
    return;
  }

  const value = pendingChips.map((c) => c.value).join(", ");
  const btn = document.getElementById("add-btn");
  btn.disabled = true;
  statusEl.textContent = "Triggering workflow...";

  try {
    await dispatchWorkflow(MANUAL_WORKFLOW_FILE, { add_entries: value });
    statusEl.textContent = "Triggered - check back in ~1 minute. Refreshing...";
    pendingChips = [];
    renderChips();
    pollForRegionUpdate("main", statusEl, POLL_INTERVAL_MS, POLL_MAX_ATTEMPTS, { alsoLoadWatchlist: true, alsoLoadHistory: true });
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function removeTicker(ticker) {
  if (!confirm(`Remove ${ticker} from the watchlist?`)) return;

  try {
    await dispatchWorkflow(MANUAL_WORKFLOW_FILE, { remove_tickers: ticker });
    alert(`Triggered removal of ${ticker} - check back in ~1 minute.`);
    pollForRegionUpdate("main", null, POLL_INTERVAL_MS, POLL_MAX_ATTEMPTS, { alsoLoadWatchlist: true, alsoLoadHistory: true });
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

async function analyzeNow() {
  const statusEl = document.getElementById("analyze-status");
  const btn = document.getElementById("analyze-btn");
  btn.disabled = true;
  statusEl.textContent = "Triggering workflow...";

  try {
    await dispatchWorkflow(MANUAL_WORKFLOW_FILE, {});
    statusEl.textContent = "Triggered - check back in ~1 minute. Auto-refreshing...";
    pollForRegionUpdate("main", statusEl, POLL_INTERVAL_MS, POLL_MAX_ATTEMPTS, { alsoLoadWatchlist: true, alsoLoadHistory: true });
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function analyzeIndex(region, indexInput) {
  const statusEl = document.getElementById(`analyze-${region}-status`);
  const btn = document.getElementById(`analyze-${region}-btn`);
  btn.disabled = true;
  statusEl.textContent = "Triggering workflow...";

  try {
    await dispatchWorkflow(INDEX_WORKFLOW_FILE, { index: indexInput });
    statusEl.textContent = "Triggered - this can take 15-30 minutes. Auto-refreshing...";
    document.getElementById(`${region}-body`).hidden = false;
    pollForRegionUpdate(region, statusEl, INDEX_POLL_INTERVAL_MS, INDEX_POLL_MAX_ATTEMPTS, {});
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function pollForRegionUpdate(region, statusEl, intervalMs, maxAttempts, extra) {
  const before = await loadRegionResults(region);
  const beforeTimestamp = before && before.generated_at;

  let attempts = 0;
  const interval = setInterval(async () => {
    attempts += 1;
    const latest = await loadRegionResults(region);
    if (extra && extra.alsoLoadWatchlist) await loadWatchlist();
    if (extra && extra.alsoLoadHistory) await loadHistory();

    const changed = latest && latest.generated_at !== beforeTimestamp;
    if (changed) {
      clearInterval(interval);
      if (statusEl) statusEl.textContent = "Updated!";
    } else if (attempts >= maxAttempts) {
      clearInterval(interval);
      if (statusEl) statusEl.textContent = "Still not updated - check the Actions tab on GitHub.";
    }
  }, intervalMs);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function init() {
  populateSetupForm();

  document.getElementById("toggle-setup").addEventListener("click", () => {
    const body = document.getElementById("setup-body");
    body.hidden = !body.hidden;
  });

  document.getElementById("toggle-history").addEventListener("click", () => {
    const body = document.getElementById("history-body");
    body.hidden = !body.hidden;
  });

  document.getElementById("toggle-canada").addEventListener("click", () => {
    const body = document.getElementById("canada-body");
    body.hidden = !body.hidden;
  });

  document.getElementById("toggle-us").addEventListener("click", () => {
    const body = document.getElementById("us-body");
    body.hidden = !body.hidden;
  });

  document.getElementById("save-setup").addEventListener("click", saveSetup);
  document.getElementById("add-btn").addEventListener("click", addToWatchlist);
  document.getElementById("analyze-btn").addEventListener("click", analyzeNow);
  document.getElementById("analyze-canada-btn").addEventListener("click", () => analyzeIndex("canada", "canada"));
  document.getElementById("analyze-us-btn").addEventListener("click", () => analyzeIndex("us", "us"));

  // Autocomplete
  document.getElementById("stock-search").addEventListener("input", onSearchInput);
  document.getElementById("stock-search").addEventListener("keydown", onSearchKeydown);
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".autocomplete-wrap")) hideSuggestions();
  });

  // Chart modal
  document.getElementById("chart-modal-close").addEventListener("click", closeChart);
  document.getElementById("chart-modal").addEventListener("click", (e) => {
    if (e.target.id === "chart-modal") closeChart();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.getElementById("chart-modal").hidden) closeChart();
  });
  document.addEventListener("click", (e) => {
    const link = e.target.closest(".ticker-link");
    if (link) {
      e.preventDefault();
      openChart(link.dataset.ticker, link.dataset.name);
    }
  });

  loadWatchlist();
  loadHistory();
  loadTickerDirectory();
  loadRegionResults("main");
  loadRegionResults("canada");
  loadRegionResults("us");
}

document.addEventListener("DOMContentLoaded", init);
