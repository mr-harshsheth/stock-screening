// ---------------------------------------------------------------------------
// Stock Screener front end.
//
// This page never runs Python itself - it only reads the JSON files that
// GitHub Actions writes back into this repo (data/*.json) and, when you
// click a button, asks the GitHub API to start a workflow run.
// ---------------------------------------------------------------------------

const MANUAL_WORKFLOW_FILE = "manual-analysis.yml";
const LS_KEYS = {
  owner: "ss_gh_owner",
  repo: "ss_gh_repo",
  branch: "ss_gh_branch",
  token: "ss_gh_token",
};

const POLL_INTERVAL_MS = 15000;
const POLL_MAX_ATTEMPTS = 20; // ~5 minutes

let resultsSortKey = null;
let resultsSortAsc = true;

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

async function dispatchWorkflow(inputs) {
  const setup = getSetup();
  if (!setup.owner || !setup.repo || !setup.token) {
    throw new Error("Fill in the Setup box first (owner, repo, token).");
  }

  const url = `https://api.github.com/repos/${setup.owner}/${setup.repo}/actions/workflows/${MANUAL_WORKFLOW_FILE}/dispatches`;
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

async function loadResults() {
  try {
    const results = await fetchJson("data/results.json");
    renderResults(results);
    return results;
  } catch (err) {
    console.error(err);
    return null;
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

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderWatchlist(watchlist) {
  const tbody = document.querySelector("#watchlist-table tbody");
  tbody.innerHTML = "";
  watchlist.forEach((entry) => {
    const tr = document.createElement("tr");

    const nameTd = document.createElement("td");
    nameTd.textContent = entry.name;
    tr.appendChild(nameTd);

    const tickerTd = document.createElement("td");
    tickerTd.textContent = entry.ticker;
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

function renderResults(payload) {
  const results = (payload && payload.results) || [];
  const failed = (payload && payload.failed) || [];
  const unresolved = (payload && payload.unresolved) || [];

  const sorted = sortResults(results);

  const tbody = document.querySelector("#results-table tbody");
  tbody.innerHTML = "";
  sorted.forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.ticker}</td>
      <td>${r.name}</td>
      <td>${r.close}</td>
      <td>${r.sma20}</td>
      <td>${r.pct_above_ma}%</td>
      <td>${r.rsi14}</td>
      <td class="${r.signal ? "signal-yes" : "signal-no"}">${r.signal ? "YES" : "no"}</td>
    `;
    tbody.appendChild(tr);
  });

  const lastAnalyzed = document.getElementById("last-analyzed");
  if (payload && payload.generated_at) {
    lastAnalyzed.textContent = `Last analyzed: ${payload.generated_at} (${payload.run_type || "unknown"} run)`;
  } else {
    lastAnalyzed.textContent = "No analysis has been run yet.";
  }

  const failedBox = document.getElementById("failed-box");
  const failedList = document.getElementById("failed-list");
  if (failed.length) {
    failedList.textContent = failed.map((f) => f.ticker).join(", ");
    failedBox.hidden = false;
  } else {
    failedBox.hidden = true;
  }

  const unresolvedBox = document.getElementById("unresolved-box");
  const unresolvedList = document.getElementById("unresolved-list");
  if (unresolved.length) {
    unresolvedList.textContent = unresolved.join(", ");
    unresolvedBox.hidden = false;
  } else {
    unresolvedBox.hidden = true;
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

function sortResults(results) {
  if (!resultsSortKey) return results;
  const copy = results.slice();
  copy.sort((a, b) => {
    const av = a[resultsSortKey];
    const bv = b[resultsSortKey];
    if (typeof av === "string") {
      return resultsSortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
    }
    return resultsSortAsc ? av - bv : bv - av;
  });
  return copy;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function addToWatchlist() {
  const textarea = document.getElementById("add-entries");
  const value = textarea.value.trim();
  const statusEl = document.getElementById("add-status");

  if (!value) {
    statusEl.textContent = "Type at least one name or ticker first.";
    return;
  }

  const btn = document.getElementById("add-btn");
  btn.disabled = true;
  statusEl.textContent = "Triggering workflow...";

  try {
    await dispatchWorkflow({ add_entries: value });
    statusEl.textContent = "Triggered - check back in ~1 minute. Refreshing...";
    textarea.value = "";
    pollForUpdate();
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function removeTicker(ticker) {
  if (!confirm(`Remove ${ticker} from the watchlist?`)) return;

  try {
    await dispatchWorkflow({ remove_tickers: ticker });
    alert(`Triggered removal of ${ticker} - check back in ~1 minute.`);
    pollForUpdate();
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
    await dispatchWorkflow({});
    statusEl.textContent = "Triggered - check back in ~1 minute. Auto-refreshing...";
    pollForUpdate(statusEl);
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function pollForUpdate(statusEl) {
  const before = await loadResults();
  const beforeTimestamp = before && before.generated_at;

  let attempts = 0;
  const interval = setInterval(async () => {
    attempts += 1;
    const latest = await loadResults();
    await loadWatchlist();
    await loadHistory();

    const changed = latest && latest.generated_at !== beforeTimestamp;
    if (changed) {
      clearInterval(interval);
      if (statusEl) statusEl.textContent = "Updated!";
    } else if (attempts >= POLL_MAX_ATTEMPTS) {
      clearInterval(interval);
      if (statusEl) statusEl.textContent = "Still not updated - check the Actions tab on GitHub.";
    }
  }, POLL_INTERVAL_MS);
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

  document.getElementById("save-setup").addEventListener("click", saveSetup);
  document.getElementById("add-btn").addEventListener("click", addToWatchlist);
  document.getElementById("analyze-btn").addEventListener("click", analyzeNow);

  document.querySelectorAll("#results-table thead th[data-key]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.key;
      if (resultsSortKey === key) {
        resultsSortAsc = !resultsSortAsc;
      } else {
        resultsSortKey = key;
        resultsSortAsc = true;
      }
      loadResults();
    });
  });

  loadWatchlist();
  loadResults();
  loadHistory();
}

document.addEventListener("DOMContentLoaded", init);
