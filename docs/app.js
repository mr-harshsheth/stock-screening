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

// Per-region table config. "main" is the personal watchlist; "canada" and
// "us" are the full-index scans (which only show rows that signaled, with
// no Signal column since every row shown is already a "yes").
const REGIONS = {
  main: {
    resultsPath: "data/results.json",
    tableId: "results-table",
    lastAnalyzedId: "last-analyzed",
    failedBoxId: "failed-box",
    failedListId: "failed-list",
    unresolvedBoxId: "unresolved-box",
    unresolvedListId: "unresolved-list",
    signalOnly: false,
    showSignalColumn: true,
  },
  canada: {
    resultsPath: "data/results_canada.json",
    tableId: "results-canada-table",
    lastAnalyzedId: "last-analyzed-canada",
    failedBoxId: "canada-failed-box",
    failedListId: "canada-failed-list",
    signalOnly: true,
    showSignalColumn: false,
  },
  us: {
    resultsPath: "data/results_us.json",
    tableId: "results-us-table",
    lastAnalyzedId: "last-analyzed-us",
    failedBoxId: "us-failed-box",
    failedListId: "us-failed-list",
    signalOnly: true,
    showSignalColumn: false,
  },
};

const sortStates = {
  main: { key: null, asc: true },
  canada: { key: null, asc: true },
  us: { key: null, asc: true },
};

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

function renderResultsInto(region, payload) {
  lastPayload[region] = payload;
  const config = REGIONS[region];

  const allResults = (payload && payload.results) || [];
  const failed = (payload && payload.failed) || [];
  const unresolved = (payload && payload.unresolved) || [];

  const shown = config.signalOnly ? allResults.filter((r) => r.signal) : allResults;
  const sorted = sortResults(shown, sortStates[region]);

  const tbody = document.querySelector(`#${config.tableId} tbody`);
  tbody.innerHTML = "";
  sorted.forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${tickerLinkHtml(r.ticker, r.name)}</td>
      <td>${escapeHtml(r.name)}</td>
      <td>${r.close}</td>
      <td>${r.sma20}</td>
      <td>${r.pct_above_ma}%</td>
      <td>${r.rsi14}</td>
      ${config.showSignalColumn ? `<td class="${r.signal ? "signal-yes" : "signal-no"}">${r.signal ? "YES" : "no"}</td>` : ""}
    `;
    tbody.appendChild(tr);
  });

  const lastAnalyzed = document.getElementById(config.lastAnalyzedId);
  if (payload && payload.generated_at) {
    const countText = config.signalOnly
      ? `${allResults.length} scanned, ${shown.length} signaled`
      : `${allResults.length} tickers`;
    lastAnalyzed.textContent = `Last analyzed: ${payload.generated_at} (${payload.run_type || "unknown"} run, ${countText})`;
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
        <td>${(h.signaled || []).join(", ") || "-"}</td>
        <td>${h.no_signal_count}</td>
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
        interval: "D",
        timezone: "Etc/UTC",
        theme: "light",
        style: "1",
        locale: "en",
        toolbar_bg: "#f8f9fb",
        enable_publishing: false,
        allow_symbol_change: false,
        container_id: "tv-chart-container",
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

function wireSortHandlers(region) {
  const config = REGIONS[region];
  document.querySelectorAll(`#${config.tableId} thead th[data-key]`).forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.key;
      const state = sortStates[region];
      if (state.key === key) {
        state.asc = !state.asc;
      } else {
        state.key = key;
        state.asc = true;
      }
      if (lastPayload[region]) renderResultsInto(region, lastPayload[region]);
    });
  });
}

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

  wireSortHandlers("main");
  wireSortHandlers("canada");
  wireSortHandlers("us");

  loadWatchlist();
  loadHistory();
  loadTickerDirectory();
  loadRegionResults("main");
  loadRegionResults("canada");
  loadRegionResults("us");
}

document.addEventListener("DOMContentLoaded", init);
