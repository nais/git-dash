const CFG = window.NAIS_DASH_CONFIG || {};
const DEFAULT_TARGETS = String(
  Array.isArray(CFG.targets) ? CFG.targets.join(", ") : CFG.targets || CFG.org || "nais"
);
const DEFAULT_BRANCH_MODE = CFG.branchMode === "all" ? "all" : "default";
const CACHE_TTL_MS = (Number(CFG.cacheTtlMinutes) || 15) * 60_000;
const AUTO_REFRESH_MS = CFG.autoRefreshSeconds === 0
  ? 0
  : Math.max(15, Number(CFG.autoRefreshSeconds) || 60) * 1000;
const FETCH_OVERLAP_MS = 5 * 60_000;

const TOKEN_COOKIE_KEY = "nais_dash_gh_token";
const TOKEN_STORAGE_KEY = "nais_dash_gh_token";
const SETTINGS_STORAGE_KEY = "git_dash_settings_v1";
const CACHE_PREFIX = "git_dash_cache_v3_";

const els = {
  sourceBtn: document.getElementById("source-btn"),
  sourceLabel: document.getElementById("source-label"),
  scopePill: document.getElementById("scope-pill"),
  metaSummary: document.getElementById("meta-summary"),
  searchInput: document.getElementById("search-input"),
  clearSearch: document.getElementById("clear-search"),
  groupSelect: document.getElementById("group-select"),
  sortSelect: document.getElementById("sort-select"),
  daysSelect: document.getElementById("days-select"),
  hideBots: document.getElementById("hide-bots"),
  onlyPrs: document.getElementById("only-prs"),
  collapseBtn: document.getElementById("collapse-btn"),
  refreshBtn: document.getElementById("refresh-btn"),
  settingsBtn: document.getElementById("settings-btn"),
  settingsDialog: document.getElementById("settings-dialog"),
  settingsForm: document.getElementById("settings-form"),
  targetsInput: document.getElementById("targets-input"),
  tokenInput: document.getElementById("token-input"),
  createTokenLink: document.getElementById("create-token-link"),
  clearTokenBtn: document.getElementById("clear-token-btn"),
  dialogClose: document.getElementById("dialog-close"),
  fetchStatus: document.getElementById("fetch-status"),
  statusBanner: document.getElementById("status-banner"),
  tbody: document.getElementById("commits-tbody"),
  table: document.getElementById("commits-table"),
  emptyState: document.getElementById("empty-state"),
};

const state = {
  dataset: null,
  isFetching: false,
  autoRefreshTimer: null,
  autoRefreshFailures: 0,
  nextRefreshAt: 0,
  targetsRaw: DEFAULT_TARGETS,
  branchMode: DEFAULT_BRANCH_MODE, // "default" | "all"
  query: "",
  groupBy: "day",
  sortBy: "date-desc",
  days: 7,
  hideBots: true,
  onlyPrs: false,
  collapsedGroups: new Set(),
};

/* ---------- Target Parsing ---------- */
function parseTargets(raw) {
  const parts = String(raw || "")
    .split(/[\s,;]+/)
    .map((s) =>
      s
        .trim()
        .replace(/^https?:\/\/github\.com\//i, "")
        .replace(/^@/, "")
        .replace(/\/+$/, "")
    )
    .filter(Boolean);

  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const segs = p.split("/").filter(Boolean);
    if (segs.length === 1) {
      const key = `account:${segs[0].toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ kind: "account", login: segs[0], raw: segs[0] });
      }
    } else if (segs.length >= 2) {
      const key = `repo:${segs[0].toLowerCase()}/${segs[1].toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ kind: "repo", owner: segs[0], name: segs[1], raw: `${segs[0]}/${segs[1]}` });
      }
    }
  }
  return out;
}

function canonicalTargetsString(raw) {
  return parseTargets(raw)
    .map((t) => t.raw)
    .join(", ");
}

function cacheKeyFor(targetsRaw, branchMode) {
  const slug = parseTargets(targetsRaw)
    .map((t) => t.raw.toLowerCase())
    .sort()
    .join("|");
  return `${CACHE_PREFIX}${branchMode}_${slug}`;
}

function formatTargetsBadge(targetsRaw) {
  const list = parseTargets(targetsRaw);
  if (!list.length) return "configure";
  if (list.length === 1) return list[0].raw;
  if (list.length === 2) return `${list[0].raw}, ${list[1].raw}`;
  return `${list[0].raw} +${list.length - 1}`;
}

/* ---------- Settings Persistence ---------- */
function loadSavedSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed.targets) state.targetsRaw = parsed.targets;
    if (parsed.branchMode === "all" || parsed.branchMode === "default") {
      state.branchMode = parsed.branchMode;
    }
  } catch {
    /* ignore */
  }
}

function saveSettings() {
  try {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        targets: state.targetsRaw,
        branchMode: state.branchMode,
      })
    );
  } catch {
    /* ignore */
  }
}

/* ---------- Token Cookie + Storage ---------- */
function getCookie(name) {
  const prefix = `${name}=`;
  for (const part of document.cookie.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      return decodeURIComponent(trimmed.slice(prefix.length));
    }
  }
  return "";
}

function setCookie(name, value, maxAgeDays = 365) {
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAgeDays * 86400}; SameSite=Lax${secure}`;
}

function deleteCookie(name) {
  document.cookie = `${name}=; path=/; max-age=0; SameSite=Lax`;
}

function getToken() {
  const hashParams = new URLSearchParams(location.hash.replace(/^#/, ""));
  if (hashParams.get("token")) {
    const t = hashParams.get("token").trim();
    saveToken(t);
    hashParams.delete("token");
    const newHash = hashParams.toString();
    history.replaceState(null, "", location.pathname + location.search + (newHash ? `#${newHash}` : ""));
    return t;
  }

  const fromCookie = getCookie(TOKEN_COOKIE_KEY);
  if (fromCookie) return fromCookie;

  const fromStorage = localStorage.getItem(TOKEN_STORAGE_KEY) || "";
  if (fromStorage) {
    setCookie(TOKEN_COOKIE_KEY, fromStorage);
    return fromStorage;
  }

  const fromConfig = (CFG.token || "").trim();
  if (fromConfig) {
    saveToken(fromConfig);
    return fromConfig;
  }

  return "";
}

function saveToken(token) {
  const clean = token.trim();
  if (!clean) return;
  setCookie(TOKEN_COOKIE_KEY, clean);
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, clean);
  } catch {
    /* ignore */
  }
  updateSettingsBtnIndicator();
}

function clearToken() {
  deleteCookie(TOKEN_COOKIE_KEY);
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  updateSettingsBtnIndicator();
}

function updateSettingsBtnIndicator() {
  const hasToken = Boolean(getCookie(TOKEN_COOKIE_KEY) || localStorage.getItem(TOKEN_STORAGE_KEY) || CFG.token);
  els.settingsBtn.textContent = hasToken ? "Configure ✓" : "Configure";
  els.settingsBtn.classList.toggle("has-token", hasToken);
}

/* ---------- Cache (localStorage) ---------- */
function loadCachedDataset(targetsRaw = state.targetsRaw, branchMode = state.branchMode) {
  try {
    const raw = localStorage.getItem(cacheKeyFor(targetsRaw, branchMode));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.commits)) {
      return prepareDataset(parsed);
    }
  } catch {
    /* ignore */
  }
  return null;
}

function saveCachedDataset(ds) {
  const key = cacheKeyFor(state.targetsRaw, state.branchMode);
  const stripCommit = ({ _ts, _searchBlob, ...rest }) => rest;
  try {
    localStorage.setItem(key, JSON.stringify({ ...ds, commits: ds.commits.map(stripCommit) }));
  } catch {
    try {
      // Evict older git_dash caches first, or trim bodies
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith("git_dash_cache_") || k.startsWith("nais_dash_commits_")) {
          if (k !== key) localStorage.removeItem(k);
        }
      }
      const slim = {
        ...ds,
        commits: ds.commits.map(({ _ts, _searchBlob, body, ...rest }) => rest),
      };
      localStorage.setItem(key, JSON.stringify(slim));
    } catch {
      /* ignore */
    }
  }
}

/* ---------- URL state sync ---------- */
function readUrlState() {
  const p = new URLSearchParams(location.search);
  if (p.has("targets") || p.has("org")) {
    state.targetsRaw = canonicalTargetsString(p.get("targets") || p.get("org") || DEFAULT_TARGETS);
  }
  if (p.has("branches")) {
    state.branchMode = p.get("branches") === "all" ? "all" : "default";
  }
  if (p.has("q")) state.query = p.get("q") || "";
  if (p.has("group")) state.groupBy = p.get("group") || "day";
  if (p.has("sort")) state.sortBy = p.get("sort") || "date-desc";
  if (p.has("days")) state.days = Number(p.get("days")) || 7;
  if (p.has("nobots")) state.hideBots = p.get("nobots") !== "0";
  if (p.has("prs")) state.onlyPrs = p.get("prs") === "1";

  els.searchInput.value = state.query;
  els.clearSearch.classList.toggle("hidden", !state.query);
  els.groupSelect.value = state.groupBy;
  els.sortSelect.value = state.sortBy;
  if ([...els.daysSelect.options].some((o) => Number(o.value) === state.days)) {
    els.daysSelect.value = String(state.days);
  }
  els.hideBots.checked = state.hideBots;
  els.onlyPrs.checked = state.onlyPrs;
}

function writeUrlState() {
  const p = new URLSearchParams();
  const canonDefault = canonicalTargetsString(DEFAULT_TARGETS);
  const canonCurrent = canonicalTargetsString(state.targetsRaw);
  if (canonCurrent && canonCurrent !== canonDefault) p.set("targets", canonCurrent);
  if (state.branchMode !== DEFAULT_BRANCH_MODE) p.set("branches", state.branchMode);
  if (state.query) p.set("q", state.query);
  if (state.groupBy !== "day") p.set("group", state.groupBy);
  if (state.sortBy !== "date-desc") p.set("sort", state.sortBy);
  if (state.days !== 7) p.set("days", String(state.days));
  if (!state.hideBots) p.set("nobots", "0");
  if (state.onlyPrs) p.set("prs", "1");
  const qs = p.toString();
  history.replaceState(null, "", (qs ? `?${qs}` : location.pathname) + location.hash);
}

/* ---------- Formatting helpers ---------- */
function esc(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const dtfShort = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const dtfDay = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
});

function fmtTime(iso) {
  return dtfShort.format(new Date(iso));
}

function fmtRelative(iso) {
  const diffSec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const m = Math.floor(diffSec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function dayKey(iso) {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/* ---------- Filtering & Sorting ---------- */
function parseSearchTokens(raw) {
  const tokens = raw.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return tokens.map((t) => {
    const idx = t.indexOf(":");
    if (idx > 0) return { key: t.slice(0, idx), val: t.slice(idx + 1) };
    return { key: null, val: t };
  });
}

function matchesCommit(c, parsedTokens, cutoffMs) {
  if (cutoffMs && c._ts < cutoffMs) return false;
  if (state.hideBots && c.isBot) return false;
  if (state.onlyPrs && (!c.prs || c.prs.length === 0)) return false;

  for (const { key, val } of parsedTokens) {
    if (!val) continue;
    if (key === "repo" || key === "r") {
      const full = `${c.owner || ""}/${c.repo}`.toLowerCase();
      if (!full.includes(val) && !c.repo.toLowerCase().includes(val)) return false;
    } else if (key === "owner" || key === "org") {
      if (!(c.owner || "").toLowerCase().includes(val)) return false;
    } else if (key === "branch" || key === "b") {
      const branches = (c.branches || [c.branch || ""]).join(" ").toLowerCase();
      if (!branches.includes(val)) return false;
    } else if (key === "author" || key === "a" || key === "user") {
      if (!`${c.authorLogin} ${c.authorName}`.toLowerCase().includes(val)) return false;
    } else if (key === "pr") {
      const prNums = (c.prs || []).map((p) => String(p.number));
      if (!prNums.some((n) => n.includes(val.replace(/^#/, "")))) return false;
    } else if (key === "sha") {
      if (!c.oid.toLowerCase().startsWith(val)) return false;
    } else if (key === "is") {
      if (val === "bot" && !c.isBot) return false;
      if (val === "human" && c.isBot) return false;
      if (val === "pr" && (!c.prs || !c.prs.length)) return false;
    } else if (!c._searchBlob.includes(val)) {
      return false;
    }
  }
  return true;
}

function sortCommits(list, sortBy) {
  const arr = list.slice();
  switch (sortBy) {
    case "date-asc":
      arr.sort((a, b) => a._ts - b._ts);
      break;
    case "repo-asc":
      arr.sort(
        (a, b) =>
          (a.fullRepo || a.repo).localeCompare(b.fullRepo || b.repo) || b._ts - a._ts
      );
      break;
    case "author-asc":
      arr.sort(
        (a, b) =>
          (a.authorLogin || a.authorName).localeCompare(b.authorLogin || b.authorName) || b._ts - a._ts
      );
      break;
    case "churn-desc":
      arr.sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions) || b._ts - a._ts);
      break;
    case "files-desc":
      arr.sort((a, b) => b.changedFiles - a.changedFiles || b._ts - a._ts);
      break;
    case "date-desc":
    default:
      arr.sort((a, b) => b._ts - a._ts);
      break;
  }
  return arr;
}

function groupCommits(sorted, groupBy, multiOwner) {
  if (groupBy === "none") {
    return [{ id: "__all__", label: "", commits: sorted }];
  }

  const map = new Map();
  for (const c of sorted) {
    let id,
      label,
      url = "";
    if (groupBy === "repo") {
      const rKey = c.fullRepo || c.repo;
      id = `repo:${rKey}`;
      label = multiOwner && c.owner ? `${c.owner}/${c.repo}` : c.repo;
      url = c.repoUrl;
    } else if (groupBy === "author") {
      const who = c.authorLogin || c.authorName || "unknown";
      id = `author:${who.toLowerCase()}`;
      label = c.authorLogin ? `${c.authorLogin} (${c.authorName})` : c.authorName;
      url = c.authorUrl || "";
    } else if (groupBy === "day") {
      const dk = dayKey(c.date);
      id = `day:${dk}`;
      label = `${dtfDay.format(new Date(c.date))} · ${dk}`;
    }

    let g = map.get(id);
    if (!g) {
      g = { id, label, url, commits: [], add: 0, del: 0, latestTs: 0 };
      map.set(id, g);
    }
    g.commits.push(c);
    g.add += c.additions || 0;
    g.del += c.deletions || 0;
    if (c._ts > g.latestTs) g.latestTs = c._ts;
  }

  const groups = [...map.values()];
  if (groupBy === "repo") {
    if (state.sortBy === "repo-asc") groups.sort((a, b) => a.label.localeCompare(b.label));
    else if (state.sortBy === "churn-desc") groups.sort((a, b) => b.add + b.del - (a.add + a.del));
    else groups.sort((a, b) => b.commits.length - a.commits.length || b.latestTs - a.latestTs);
  } else if (groupBy === "author") {
    if (state.sortBy === "author-asc") groups.sort((a, b) => a.label.localeCompare(b.label));
    else groups.sort((a, b) => b.commits.length - a.commits.length || b.latestTs - a.latestTs);
  } else if (groupBy === "day") {
    groups.sort((a, b) =>
      state.sortBy === "date-asc" ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id)
    );
  }
  return groups;
}

/* ---------- Rendering ---------- */
function prepareDataset(ds) {
  if (!ds || !Array.isArray(ds.commits)) return null;
  for (const c of ds.commits) {
    c._ts = Date.parse(c.date);
    if (!c.fullRepo) c.fullRepo = c.owner ? `${c.owner}/${c.repo}` : c.repo;
    const prText = (c.prs || []).map((p) => `#${p.number} ${p.title || ""}`).join(" ");
    const branchText = (c.branches || [c.branch || ""]).join(" ");
    c._searchBlob =
      `${c.fullRepo} ${branchText} ${c.authorLogin} ${c.authorName} ${c.shortOid} ${c.oid} ${c.headline} ${c.body || ""} ${prText}`.toLowerCase();
  }
  return ds;
}

function renderRow(c, multiOwner) {
  const authorDisplay = c.authorLogin || c.authorName;
  const authorTitle =
    c.authorLogin && c.authorName && c.authorLogin !== c.authorName
      ? `${c.authorName} (@${c.authorLogin})`
      : authorDisplay;

  const authorHtml = c.authorUrl
    ? `<a href="${esc(c.authorUrl)}" target="_blank" rel="noopener" title="${esc(authorTitle)}">${esc(authorDisplay)}</a>`
    : `<span title="${esc(authorTitle)}">${esc(authorDisplay)}</span>`;

  const avatarHtml = c.avatarUrl
    ? `<img class="avatar" src="${esc(c.avatarUrl)}" alt="" loading="lazy" />`
    : "";

  const botHtml = c.isBot ? `<span class="bot-tag">bot</span>` : "";
  const privHtml = c.isPrivate ? `<span class="priv-tag" title="Private repository">priv</span>` : "";

  const branches = c.branches && c.branches.length ? c.branches : c.branch ? [c.branch] : [];
  const defaultBranch = c.defaultBranch || "main";
  let branchHtml = "";
  if (state.branchMode === "all" && branches.length) {
    const shown = branches.includes(defaultBranch) ? defaultBranch : branches[0];
    const extra = branches.length > 1 ? ` +${branches.length - 1}` : "";
    branchHtml = `<span class="branch-tag" title="Branches: ${esc(branches.join(", "))}">${esc(shown)}${extra}</span>`;
  }

  const prHtml =
    c.prs && c.prs.length
      ? c.prs
          .map(
            (p) =>
              `<a class="pr-link" href="${esc(p.url)}" target="_blank" rel="noopener" title="${esc(p.title || `PR #${p.number}`)}">#${p.number}</a>`
          )
          .join("")
      : "";

  const fullMsg = c.body ? `${c.headline}\n\n${c.body}` : c.headline;
  const bodyHint = c.body ? `<span class="msg-body-hint" title="${esc(fullMsg)}">…</span>` : "";

  const statHtml =
    c.additions || c.deletions || c.changedFiles
      ? `<span class="add">+${c.additions}</span><span class="del">-${c.deletions}</span>${
          c.changedFiles ? `<span class="files">${c.changedFiles}f</span>` : ""
        }`
      : `<span class="files">—</span>`;

  const filterAuthorVal = c.authorLogin || c.authorName;
  const filterRepoVal = multiOwner && c.owner ? `${c.owner}/${c.repo}` : c.repo;
  const repoLabelHtml =
    multiOwner && c.owner
      ? `<span class="owner-prefix">${esc(c.owner)}/</span>${esc(c.repo)}`
      : esc(c.repo);

  return `<tr class="commit-row">
    <td class="cell-time" title="${esc(c.date)} (${fmtRelative(c.date)})">${esc(fmtTime(c.date))}</td>
    <td class="cell-repo">
      <a href="${esc(c.repoUrl)}" target="_blank" rel="noopener" title="${esc(c.fullRepo)} (${esc(branches.join(", ") || defaultBranch)})">${repoLabelHtml}</a>${privHtml}<button class="filter-chip" type="button" data-filter="repo:${esc(filterRepoVal)}" title="Filter to repo:${esc(filterRepoVal)}">⌖</button>
    </td>
    <td class="cell-author">
      <span class="author-wrap">${avatarHtml}${authorHtml}${botHtml}</span><button class="filter-chip" type="button" data-filter="author:${esc(filterAuthorVal)}" title="Filter to author:${esc(filterAuthorVal)}">⌖</button>
    </td>
    <td class="cell-sha"><a href="${esc(c.url)}" target="_blank" rel="noopener" title="${esc(c.oid)}">${esc(c.shortOid)}</a></td>
    <td class="cell-pr">${prHtml}</td>
    <td class="cell-msg" title="${esc(fullMsg)}">${branchHtml}<a class="msg-link" href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.headline)}</a>${bodyHint}</td>
    <td class="cell-stat">${statHtml}</td>
  </tr>`;
}

function render() {
  writeUrlState();
  updateSettingsBtnIndicator();

  const badgeText = formatTargetsBadge(state.targetsRaw);
  els.sourceLabel.textContent = badgeText;
  els.sourceBtn.title = `Targets: ${canonicalTargetsString(state.targetsRaw) || "none"} — click to configure ( s )`;
  els.scopePill.classList.toggle("hidden", state.branchMode !== "all");
  document.title = `${badgeText} · commits`;

  const ds = state.dataset;
  if (!ds) {
    els.tbody.innerHTML = "";
    els.table.classList.add("hidden");
    els.emptyState.classList.remove("hidden");
    els.metaSummary.textContent = state.isFetching ? "fetching…" : "no data";
    els.emptyState.innerHTML = state.isFetching
      ? `<p>Fetching commits for <strong>${esc(canonicalTargetsString(state.targetsRaw))}</strong>…</p>`
      : `<p><strong>Configure targets &amp; GitHub token to fetch commits.</strong></p>
         <p>Click <strong>Configure</strong> above (or press <code>s</code>) to pick orgs, users, or <code>owner/repo</code> targets and create a read-only personal access token.</p>`;
    return;
  }

  const allOwners = new Set(ds.commits.map((c) => (c.owner || "").toLowerCase()).filter(Boolean));
  const multiOwner = allOwners.size > 1;

  const cutoffMs = state.days ? Date.now() - state.days * 86400_000 : 0;
  const tokens = parseSearchTokens(state.query);

  const filtered = ds.commits.filter((c) => matchesCommit(c, tokens, cutoffMs));
  const sorted = sortCommits(filtered, state.sortBy);
  const groups = groupCommits(sorted, state.groupBy, multiOwner);

  const uniqueRepos = new Set(filtered.map((c) => c.fullRepo || c.repo)).size;
  const uniqueAuthors = new Set(filtered.map((c) => c.authorLogin || c.authorName)).size;
  const totalAdd = filtered.reduce((s, c) => s + (c.additions || 0), 0);
  const totalDel = filtered.reduce((s, c) => s + (c.deletions || 0), 0);
  const genLabel = ds.generatedAt ? ` · cached ${fmtRelative(ds.generatedAt)}` : "";

  els.metaSummary.innerHTML = `${filtered.length}/${ds.commits.length} commits · ${uniqueRepos} repos · ${uniqueAuthors} authors · <span class="add">+${totalAdd}</span> <span class="del">-${totalDel}</span>${esc(genLabel)}`;

  els.collapseBtn.classList.toggle("hidden", state.groupBy === "none" || groups.length === 0);
  if (state.groupBy !== "none" && groups.length > 0) {
    const allCollapsed = groups.every((g) => state.collapsedGroups.has(g.id));
    els.collapseBtn.textContent = allCollapsed ? "Expand all" : "Collapse all";
  }

  if (sorted.length === 0) {
    els.tbody.innerHTML = "";
    els.table.classList.add("hidden");
    els.emptyState.classList.remove("hidden");
    els.emptyState.innerHTML = `<p>No commits match current filters.</p>`;
    return;
  }

  els.table.classList.remove("hidden");
  els.emptyState.classList.add("hidden");

  const htmlParts = [];
  for (const g of groups) {
    if (state.groupBy !== "none") {
      const collapsed = state.collapsedGroups.has(g.id);
      const caret = collapsed ? "▶" : "▼";
      const labelHtml = g.url
        ? `<a href="${esc(g.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${esc(g.label)}</a>`
        : esc(g.label);
      const groupAuthors = new Set(g.commits.map((c) => c.authorLogin || c.authorName)).size;
      const groupRepos = new Set(g.commits.map((c) => c.fullRepo || c.repo)).size;
      const extraMeta =
        state.groupBy === "repo"
          ? `${groupAuthors} author${groupAuthors === 1 ? "" : "s"}`
          : state.groupBy === "author"
          ? `${groupRepos} repo${groupRepos === 1 ? "" : "s"}`
          : `${groupRepos} repos · ${groupAuthors} authors`;

      htmlParts.push(`<tr class="group-row" data-group-id="${esc(g.id)}">
        <td colspan="7">
          <div class="group-hdr">
            <span class="group-left">
              <span class="caret">${caret}</span>
              <span>${labelHtml}</span>
              <span class="pill">${g.commits.length}</span>
            </span>
            <span class="group-meta">
              <span>${esc(extraMeta)}</span>
              <span><span class="add">+${g.add}</span> <span class="del">-${g.del}</span></span>
            </span>
          </div>
        </td>
      </tr>`);

      if (collapsed) continue;
    }

    for (const c of g.commits) {
      htmlParts.push(renderRow(c, multiOwner));
    }
  }

  els.tbody.innerHTML = htmlParts.join("");
}

/* ---------- Live Browser Fetch via GitHub GraphQL ---------- */
const GQL_OWNER_REPOS_QUERY = `
query($login: String!, $cursor: String) {
  repositoryOwner(login: $login) {
    login
    repositories(first: 100, after: $cursor, orderBy: {field: PUSHED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name
        url
        pushedAt
        isPrivate
        owner { login }
        defaultBranchRef { name target { oid } }
      }
    }
  }
}`;

const GQL_SINGLE_REPO_META = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    name
    url
    pushedAt
    isPrivate
    owner { login }
    defaultBranchRef { name target { oid } }
  }
}`;

const COMMIT_FIELDS = `
  oid
  abbreviatedOid
  messageHeadline
  messageBody
  committedDate
  url
  additions
  deletions
  changedFilesIfAvailable
  author {
    name
    email
    avatarUrl(size: 40)
    user { login url }
  }
  associatedPullRequests(first: 2) {
    nodes { number title url state }
  }
`;

const GQL_DEFAULT_BRANCH_COMMITS = `
query($owner: String!, $repo: String!, $cursor: String, $since: GitTimestamp!, $pageSize: Int!) {
  repository(owner: $owner, name: $repo) {
    defaultBranchRef {
      name
      target {
        ... on Commit {
          history(first: $pageSize, after: $cursor, since: $since) {
            pageInfo { hasNextPage endCursor }
            nodes { ${COMMIT_FIELDS} }
          }
        }
      }
    }
  }
}`;

const GQL_ALL_BRANCHES_LIST = `
query($owner: String!, $repo: String!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    refs(refPrefix: "refs/heads/", first: 50, after: $cursor, orderBy: {field: TAG_COMMIT_DATE, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name
        target {
          ... on Commit {
            oid
            committedDate
          }
        }
      }
    }
  }
}`;

const GQL_REF_COMMITS = `
query($owner: String!, $repo: String!, $ref: String!, $cursor: String, $since: GitTimestamp!, $pageSize: Int!) {
  repository(owner: $owner, name: $repo) {
    ref(qualifiedName: $ref) {
      name
      target {
        ... on Commit {
          history(first: $pageSize, after: $cursor, since: $since) {
            pageInfo { hasNextPage endCursor }
            nodes { ${COMMIT_FIELDS} }
          }
        }
      }
    }
  }
}`;

function isBotAuthor(login, name, email) {
  const s = `${login} ${name} ${email}`.toLowerCase();
  if (login.endsWith("[bot]") || s.includes("[bot]")) return true;
  return [
    "dependabot",
    "renovate",
    "github-actions",
    "nais-bot",
    "snyk-bot",
    "semantic-release-bot",
    "codecov",
  ].some((m) => s.includes(m));
}

function normalizeGqlCommit(repo, branch, c) {
  const owner = repo.owner?.login || "";
  const author = c.author || {};
  const user = author.user || {};
  const login = user.login || "";
  const authorName = author.name || login || "unknown";
  const authorEmail = author.email || "";
  const prs = [];
  const seen = new Set();

  for (const pr of c.associatedPullRequests?.nodes || []) {
    if (pr && !seen.has(pr.number)) {
      seen.add(pr.number);
      prs.push({ number: pr.number, title: pr.title || "", url: pr.url, state: pr.state || "" });
    }
  }
  const headline = c.messageHeadline || "";
  if (!prs.length) {
    const re = /(?:\(#(\d+)\)|Merge pull request #(\d+))/g;
    let m;
    while ((m = re.exec(headline))) {
      const num = Number(m[1] || m[2]);
      if (!seen.has(num)) {
        seen.add(num);
        prs.push({ number: num, title: "", url: `${repo.url}/pull/${num}`, state: "" });
      }
    }
  }

  const defaultBranch = repo.defaultBranchRef?.name || "main";

  return {
    oid: c.oid,
    shortOid: c.abbreviatedOid || c.oid.slice(0, 7),
    owner,
    repo: repo.name,
    fullRepo: owner ? `${owner}/${repo.name}` : repo.name,
    repoUrl: repo.url,
    isPrivate: Boolean(repo.isPrivate),
    defaultBranch,
    branch,
    branches: [branch],
    headline,
    body: (c.messageBody || "").trim(),
    date: c.committedDate,
    url: c.url,
    additions: c.additions || 0,
    deletions: c.deletions || 0,
    changedFiles: c.changedFilesIfAvailable || 0,
    authorLogin: login,
    authorName,
    authorUrl: user.url || (login ? `https://github.com/${login}` : ""),
    avatarUrl: author.avatarUrl || "",
    isBot: isBotAuthor(login, authorName, authorEmail),
    prs,
  };
}

async function gqlRequest(token, query, variables, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    if ([502, 503, 504].includes(res.status) && attempt + 1 < retries) {
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
      continue;
    }
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`HTTP ${res.status}`);
    }
    if (!res.ok) {
      throw new Error(json?.message || `HTTP ${res.status}`);
    }
    if (json.errors?.length) {
      throw new Error(json.errors.map((e) => e.message).join("; "));
    }
    return json.data;
  }
}

async function fetchRepoDefaultBranch(token, repo, sinceIso) {
  const owner = repo.owner.login;
  const branch = repo.defaultBranchRef?.name || "main";
  const out = [];
  let cursor = null;
  let pageSize = 50;

  while (true) {
    let res;
    try {
      res = await gqlRequest(
        token,
        GQL_DEFAULT_BRANCH_COMMITS,
        { owner, repo: repo.name, cursor, since: sinceIso, pageSize },
        2
      );
    } catch (err) {
      if (pageSize > 15) {
        pageSize = 15;
        continue;
      }
      throw err;
    }
    const hist = res?.repository?.defaultBranchRef?.target?.history;
    if (!hist) break;
    for (const c of hist.nodes || []) {
      if (c) out.push(normalizeGqlCommit(repo, branch, c));
    }
    if (!hist.pageInfo?.hasNextPage || !hist.pageInfo.endCursor) break;
    cursor = hist.pageInfo.endCursor;
  }
  return out;
}

async function fetchActiveBranches(token, repo, sinceIso) {
  const owner = repo.owner.login;
  const activeBranches = [];
  let bCursor = null;
  let stopBranches = false;

  while (!stopBranches) {
    const data = await gqlRequest(token, GQL_ALL_BRANCHES_LIST, {
      owner,
      repo: repo.name,
      cursor: bCursor,
    });
    const refs = data?.repository?.refs;
    if (!refs) break;
    for (const node of refs.nodes || []) {
      if (!node) continue;
      const tipDate = node.target?.committedDate;
      if (tipDate && tipDate < sinceIso) {
        stopBranches = true;
        break;
      }
      activeBranches.push({ name: node.name, oid: node.target?.oid });
    }
    if (!refs.pageInfo?.hasNextPage || !refs.pageInfo.endCursor) break;
    bCursor = refs.pageInfo.endCursor;
  }

  return activeBranches;
}

async function fetchRepoAllBranches(token, repo, sinceIso, branches) {
  const owner = repo.owner.login;
  const activeBranches = branches.map((b) => b.name);
  // Dedupe commits across branches by oid while tracking all branch names
  const byOid = new Map();
  const defaultBranch = repo.defaultBranchRef?.name || "main";
  // Order default branch first so it appears primary
  activeBranches.sort((a, b) => (a === defaultBranch ? -1 : b === defaultBranch ? 1 : 0));

  for (const branchName of activeBranches) {
    let cursor = null;
    let pageSize = 50;
    while (true) {
      let res;
      try {
        res = await gqlRequest(
          token,
          GQL_REF_COMMITS,
          {
            owner,
            repo: repo.name,
            ref: `refs/heads/${branchName}`,
            cursor,
            since: sinceIso,
            pageSize,
          },
          2
        );
      } catch (err) {
        if (pageSize > 15) {
          pageSize = 15;
          continue;
        }
        throw err;
      }
      const hist = res?.repository?.ref?.target?.history;
      if (!hist) break;
      for (const c of hist.nodes || []) {
        if (!c) continue;
        const existing = byOid.get(c.oid);
        if (existing) {
          if (!existing.branches.includes(branchName)) {
            existing.branches.push(branchName);
          }
        } else {
          byOid.set(c.oid, normalizeGqlCommit(repo, branchName, c));
        }
      }
      if (!hist.pageInfo?.hasNextPage || !hist.pageInfo.endCursor) break;
      cursor = hist.pageInfo.endCursor;
    }
  }

  return [...byOid.values()];
}

async function fetchLiveFromGitHub(token, targets, branchMode, days, onProgress, previous = null) {
  const now = new Date();
  const sinceIso = new Date(now.getTime() - days * 86400_000).toISOString();
  const canReuse = previous && !previous.isPublicFallback &&
    previous.branchMode === branchMode &&
    canonicalTargetsString(previous.targets?.join(",")).toLowerCase() ===
      canonicalTargetsString(targets.map((t) => t.raw).join(",")).toLowerCase() &&
    Date.parse(previous.since) <= Date.parse(sinceIso);
  const fullSyncAge = now.getTime() - Date.parse(previous?.fullSyncedAt);
  const lastSuccess = Date.parse(previous?.generatedAt);
  const incremental = canReuse && fullSyncAge >= 0 && fullSyncAge < CACHE_TTL_MS &&
    Number.isFinite(lastSuccess) && lastSuccess <= now.getTime();
  const changesSince = incremental
    ? new Date(Math.max(Date.parse(sinceIso), lastSuccess - FETCH_OVERLAP_MS)).toISOString()
    : sinceIso;
  const commitsByRepo = new Map();
  const repoSnapshots = incremental ? { ...previous.repoSnapshots } : {};
  if (incremental) {
    for (const commit of previous.commits) {
      if (Date.parse(commit.date) < Date.parse(sinceIso)) continue;
      const key = commit.fullRepo.toLowerCase();
      if (!commitsByRepo.has(key)) commitsByRepo.set(key, []);
      commitsByRepo.get(key).push(commit);
    }
  }
  const repoMap = new Map();
  let reposScanned = 0;

  for (const target of targets) {
    if (target.kind === "account") {
      onProgress?.(`Listing ${incremental ? "recently pushed" : "active"} repos for ${target.login}…`);
      let cursor = null;
      let stopEarly = false;
      while (!stopEarly) {
        const data = await gqlRequest(token, GQL_OWNER_REPOS_QUERY, {
          login: target.login,
          cursor,
        });
        const ownerNode = data?.repositoryOwner;
        if (!ownerNode) throw new Error(`Account/org '${target.login}' not found`);
        const reposConn = ownerNode.repositories;
        for (const repo of reposConn.nodes || []) {
          if (!repo) continue;
          reposScanned++;
          if (repo.pushedAt && repo.pushedAt < changesSince) {
            stopEarly = true;
            break;
          }
          if (repo.defaultBranchRef || branchMode === "all") {
            const key = `${repo.owner.login}/${repo.name}`.toLowerCase();
            repoMap.set(key, repo);
          }
        }
        if (!reposConn.pageInfo?.hasNextPage) break;
        cursor = reposConn.pageInfo.endCursor;
      }
    } else if (target.kind === "repo") {
      onProgress?.(`Checking ${target.raw}…`);
      const data = await gqlRequest(token, GQL_SINGLE_REPO_META, {
        owner: target.owner,
        name: target.name,
      });
      const repo = data?.repository;
      if (!repo) throw new Error(`Repository '${target.raw}' not found or inaccessible`);
      reposScanned++;
      if (!repo.pushedAt || repo.pushedAt >= changesSince) {
        const key = `${repo.owner.login}/${repo.name}`.toLowerCase();
        repoMap.set(key, repo);
      }
    }
  }

  const candidateRepos = [...repoMap.values()];
  let nextIdx = 0;
  let done = 0;
  let reused = 0;

  async function worker() {
    while (nextIdx < candidateRepos.length) {
      const repo = candidateRepos[nextIdx++];
      const key = `${repo.owner.login}/${repo.name}`.toLowerCase();
      const branches = branchMode === "all"
        ? await fetchActiveBranches(token, repo, sinceIso)
        : [{ name: repo.defaultBranchRef?.name, oid: repo.defaultBranchRef?.target?.oid }];
      const metadata = JSON.stringify([repo.url, repo.isPrivate, repo.defaultBranchRef?.name]);
      const branchNames = JSON.stringify(branches.map((b) => b.name).sort());
      const fingerprint = JSON.stringify([
        metadata,
        branches.map((b) => [b.name, b.oid]).sort((a, b) => a[0].localeCompare(b[0])),
      ]);
      const snapshot = incremental ? previous.repoSnapshots?.[key] : null;
      const unchanged = branches.every((b) => b.oid) && snapshot?.fingerprint === fingerprint;
      if (unchanged) {
        reused++;
      } else {
        // New repos, renamed default branches, and added/deleted branches need full history.
        const recentOnly = snapshot?.metadata === metadata && snapshot?.branchNames === branchNames;
        const historySince = recentOnly ? changesSince : sinceIso;
        let repoCommits = branchMode === "all"
          ? await fetchRepoAllBranches(token, repo, historySince, branches)
          : await fetchRepoDefaultBranch(token, repo, historySince);
        if (recentOnly) {
          const byOid = new Map((commitsByRepo.get(key) || []).map((c) => [c.oid, c]));
          for (const commit of repoCommits) {
            const existing = byOid.get(commit.oid);
            byOid.set(commit.oid, {
              ...commit,
              branches: [...new Set([...(existing?.branches || []), ...commit.branches])],
            });
          }
          repoCommits = [...byOid.values()];
        }
        commitsByRepo.set(key, repoCommits.filter((c) => Date.parse(c.date) >= Date.parse(sinceIso)));
        repoSnapshots[key] = { fingerprint, metadata, branchNames };
      }
      done++;
      onProgress?.(
        `${incremental ? "Recent changes" : "Full reconciliation"}: ${done}/${candidateRepos.length} repos (${reused} unchanged)…`
      );
    }
  }

  // Let all in-flight workers settle before allowing another refresh after a failure.
  const results = await Promise.allSettled(Array.from({ length: Math.min(6, candidateRepos.length) }, worker));
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;

  const commits = [...commitsByRepo.values()].flat();
  const activeRepos = new Set(commits.map((c) => c.fullRepo.toLowerCase()));
  commits.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  return {
    targets: targets.map((t) => t.raw),
    branchMode,
    since: sinceIso,
    generatedAt: now.toISOString(),
    fullSyncedAt: incremental ? previous.fullSyncedAt : now.toISOString(),
    days,
    reposScanned,
    activeRepoCount: activeRepos.size,
    repoSnapshots,
    commits,
  };
}

/* ---------- Unauthenticated Public Fallback (REST) ---------- */
async function fetchPublicPreview(targets, days, onProgress) {
  const sinceMs = Date.now() - days * 86400_000;
  const sinceIso = new Date(sinceMs).toISOString();
  const repoMap = new Map();

  for (const t of targets) {
    if (t.kind === "account") {
      onProgress?.(`Public preview: listing ${t.login} repos…`);
      // Use /users/{login}/repos (works for both users and orgs in GitHub REST)
      const res = await fetch(
        `https://api.github.com/users/${encodeURIComponent(t.login)}/repos?sort=pushed&direction=desc&per_page=100`
      );
      if (!res.ok) {
        throw new Error(`GitHub REST HTTP ${res.status} for '${t.login}' (set a GitHub token)`);
      }
      const repos = await res.json();
      for (const r of repos) {
        if (r.pushed_at && Date.parse(r.pushed_at) >= sinceMs) {
          repoMap.set(r.full_name.toLowerCase(), r);
        }
      }
    } else if (t.kind === "repo") {
      const res = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(t.owner)}/${encodeURIComponent(t.name)}`
      );
      if (!res.ok) {
        throw new Error(`GitHub REST HTTP ${res.status} for '${t.raw}'`);
      }
      const r = await res.json();
      if (!r.pushed_at || Date.parse(r.pushed_at) >= sinceMs) {
        repoMap.set(r.full_name.toLowerCase(), r);
      }
    }
  }

  const active = [...repoMap.values()];
  const commits = [];
  let idx = 0;

  async function worker() {
    while (idx < active.length) {
      const repo = active[idx++];
      onProgress?.(`Public preview: ${repo.full_name} (${idx}/${active.length})…`);
      const cRes = await fetch(
        `https://api.github.com/repos/${repo.full_name}/commits?since=${encodeURIComponent(sinceIso)}&per_page=100`
      );
      if (!cRes.ok) continue;
      const list = await cRes.json();
      if (!Array.isArray(list)) continue;
      const owner = repo.owner?.login || "";
      const defaultBranch = repo.default_branch || "main";
      for (const item of list) {
        const msg = item.commit?.message || "";
        const [headline, ...rest] = msg.split("\n");
        const login = item.author?.login || "";
        const authorName = item.commit?.author?.name || login || "unknown";
        const authorEmail = item.commit?.author?.email || "";
        const prs = [];
        const re = /(?:\(#(\d+)\)|Merge pull request #(\d+))/g;
        let m;
        while ((m = re.exec(headline))) {
          const num = Number(m[1] || m[2]);
          prs.push({ number: num, title: "", url: `${repo.html_url}/pull/${num}`, state: "" });
        }
        commits.push({
          oid: item.sha,
          shortOid: item.sha.slice(0, 7),
          owner,
          repo: repo.name,
          fullRepo: repo.full_name,
          repoUrl: repo.html_url,
          isPrivate: Boolean(repo.private),
          defaultBranch,
          branch: defaultBranch,
          branches: [defaultBranch],
          headline,
          body: rest.join("\n").trim(),
          date: item.commit?.committer?.date || item.commit?.author?.date,
          url: item.html_url,
          additions: 0,
          deletions: 0,
          changedFiles: 0,
          authorLogin: login,
          authorName,
          authorUrl: item.author?.html_url || "",
          avatarUrl: item.author?.avatar_url ? `${item.author.avatar_url}&s=40` : "",
          isBot: isBotAuthor(login, authorName, authorEmail),
          prs,
        });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(6, active.length) }, worker));
  commits.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));

  return {
    targets: targets.map((t) => t.raw),
    branchMode: "default",
    since: sinceIso,
    generatedAt: new Date().toISOString(),
    days,
    reposScanned: active.length,
    activeRepoCount: active.length,
    isPublicFallback: true,
    commits,
  };
}

function showBanner(msg) {
  if (!msg) {
    els.statusBanner.classList.add("hidden");
    els.statusBanner.textContent = "";
    return;
  }
  els.statusBanner.textContent = msg;
  els.statusBanner.classList.remove("hidden");
}

/* ---------- Automatic refresh (authenticated, visible tabs only) ---------- */
function scheduleAutoRefresh() {
  clearTimeout(state.autoRefreshTimer);
  state.autoRefreshTimer = null;
  if (!AUTO_REFRESH_MS || document.hidden || !navigator.onLine || !getToken() ||
      !parseTargets(state.targetsRaw).length) return;
  if (!state.nextRefreshAt) state.nextRefreshAt = Date.now() + AUTO_REFRESH_MS;
  state.autoRefreshTimer = setTimeout(() => {
    if (document.hidden || !navigator.onLine) return;
    if (state.isFetching || els.settingsDialog.open) {
      state.nextRefreshAt = Date.now() + AUTO_REFRESH_MS;
      scheduleAutoRefresh();
      return;
    }
    refreshCommits();
  }, Math.max(0, state.nextRefreshAt - Date.now()));
}

async function refreshCommits({ statusCb } = {}) {
  if (state.isFetching) return false;
  const targets = parseTargets(state.targetsRaw);
  if (!targets.length) {
    openSettingsDialog("Enter at least one org, user, or owner/repo.");
    return false;
  }

  const token = getToken();
  state.isFetching = true;
  clearTimeout(state.autoRefreshTimer);
  let succeeded = false;
  els.refreshBtn.disabled = true;
  els.refreshBtn.textContent = "Fetching…";
  render();

  try {
    const fetchDays = Math.max(state.days, 7);
    if (token) {
      const ds = await fetchLiveFromGitHub(token, targets, state.branchMode, fetchDays, (msg) => {
        showBanner(msg);
        statusCb?.(msg);
      }, state.dataset || loadCachedDataset());
      state.dataset = prepareDataset(ds);
      saveCachedDataset(ds);
      showBanner("");
    } else {
      const preview = await fetchPublicPreview(targets, fetchDays, (msg) => {
        showBanner(msg);
        statusCb?.(msg);
      });
      state.dataset = prepareDataset(preview);
      saveCachedDataset(preview);
      showBanner(
        "Showing unauthenticated public REST preview (default branch only, no ± stats or private repos). Click Configure to create a read-only personal access token."
      );
    }
    succeeded = true;
    return true;
  } catch (err) {
    const msg = `Fetch failed: ${err.message}`;
    showBanner(msg);
    statusCb?.(msg);
    return false;
  } finally {
    state.isFetching = false;
    els.refreshBtn.disabled = false;
    els.refreshBtn.textContent = "↻ Refresh";
    state.autoRefreshFailures = succeeded ? 0 : state.autoRefreshFailures + 1;
    const delay = Math.min(
      AUTO_REFRESH_MS * 2 ** Math.min(state.autoRefreshFailures, 5),
      Math.max(AUTO_REFRESH_MS, 15 * 60_000)
    );
    state.nextRefreshAt = Date.now() + delay;
    scheduleAutoRefresh();
    render();
  }
}

function updateCreateTokenLink() {
  const url = new URL("https://github.com/settings/personal-access-tokens/new");
  url.search = new URLSearchParams({
    name: "git-dash",
    description: "Read-only commit dashboard",
    expires_in: "30",
    contents: "read",
    pull_requests: "read",
  }).toString();
  const owners = new Map(
    parseTargets(els.targetsInput.value).map((t) => {
      const owner = t.kind === "repo" ? t.owner : t.login;
      return [owner.toLowerCase(), owner];
    })
  );
  if (owners.size === 1) url.searchParams.set("target_name", owners.values().next().value);
  els.createTokenLink.href = url.toString();
}

function openSettingsDialog(hint = "") {
  els.targetsInput.value = canonicalTargetsString(state.targetsRaw);
  updateCreateTokenLink();
  const radios = els.settingsForm.querySelectorAll('input[name="branch-mode"]');
  for (const r of radios) r.checked = r.value === state.branchMode;
  els.tokenInput.value = getToken();
  els.fetchStatus.textContent = hint;
  els.settingsDialog.showModal();
  els.targetsInput.focus();
}

/* ---------- Event Listeners ---------- */
function bindEvents() {
  document.addEventListener("visibilitychange", scheduleAutoRefresh);
  window.addEventListener("online", scheduleAutoRefresh);
  window.addEventListener("offline", scheduleAutoRefresh);

  els.searchInput.addEventListener("input", () => {
    state.query = els.searchInput.value;
    els.clearSearch.classList.toggle("hidden", !state.query);
    render();
  });

  els.clearSearch.addEventListener("click", () => {
    state.query = "";
    els.searchInput.value = "";
    els.clearSearch.classList.add("hidden");
    els.searchInput.focus();
    render();
  });

  els.groupSelect.addEventListener("change", () => {
    state.groupBy = els.groupSelect.value;
    state.collapsedGroups.clear();
    render();
  });

  els.sortSelect.addEventListener("change", () => {
    state.sortBy = els.sortSelect.value;
    render();
  });

  els.daysSelect.addEventListener("change", async () => {
    const newDays = Number(els.daysSelect.value) || 7;
    state.days = newDays;
    if (!state.dataset || newDays > (state.dataset.days || 7)) {
      await refreshCommits();
    } else {
      render();
    }
  });

  els.hideBots.addEventListener("change", () => {
    state.hideBots = els.hideBots.checked;
    render();
  });

  els.onlyPrs.addEventListener("change", () => {
    state.onlyPrs = els.onlyPrs.checked;
    render();
  });

  els.collapseBtn.addEventListener("click", () => {
    const groupRows = [...els.tbody.querySelectorAll(".group-row")];
    const ids = groupRows.map((r) => r.dataset.groupId);
    const allCollapsed = ids.every((id) => state.collapsedGroups.has(id));
    if (allCollapsed) state.collapsedGroups.clear();
    else for (const id of ids) state.collapsedGroups.add(id);
    render();
  });

  els.refreshBtn.addEventListener("click", () => {
    refreshCommits();
  });

  els.sourceBtn.addEventListener("click", () => openSettingsDialog());
  els.settingsBtn.addEventListener("click", () => openSettingsDialog());
  els.targetsInput.addEventListener("input", updateCreateTokenLink);
  els.dialogClose.addEventListener("click", () => els.settingsDialog.close());

  els.tbody.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-filter]");
    if (chip) {
      e.preventDefault();
      e.stopPropagation();
      const token = chip.dataset.filter;
      const cur = state.query.trim();
      state.query = cur.includes(token) ? cur : `${cur} ${token}`.trim();
      els.searchInput.value = state.query;
      els.clearSearch.classList.toggle("hidden", !state.query);
      render();
      return;
    }

    const groupRow = e.target.closest(".group-row");
    if (groupRow && !e.target.closest("a")) {
      const id = groupRow.dataset.groupId;
      if (state.collapsedGroups.has(id)) state.collapsedGroups.delete(id);
      else state.collapsedGroups.add(id);
      render();
    }
  });

  document.querySelectorAll("th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const col = th.dataset.sort;
      if (col === "date") state.sortBy = state.sortBy === "date-desc" ? "date-asc" : "date-desc";
      else if (col === "repo") state.sortBy = "repo-asc";
      else if (col === "author") state.sortBy = "author-asc";
      else if (col === "churn") state.sortBy = state.sortBy === "churn-desc" ? "files-desc" : "churn-desc";
      els.sortSelect.value = state.sortBy;
      render();
    });
  });

  window.addEventListener("keydown", (e) => {
    const inInput = ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName);
    if (e.key === "/" && !inInput && !els.settingsDialog.open) {
      e.preventDefault();
      els.searchInput.focus();
      els.searchInput.select();
    } else if (e.key === "r" && !inInput && !e.metaKey && !e.ctrlKey && !els.settingsDialog.open) {
      e.preventDefault();
      refreshCommits();
    } else if (e.key === "s" && !inInput && !e.metaKey && !e.ctrlKey && !els.settingsDialog.open) {
      e.preventDefault();
      openSettingsDialog();
    } else if (e.key === "Escape" && document.activeElement === els.searchInput) {
      if (state.query) {
        state.query = "";
        els.searchInput.value = "";
        els.clearSearch.classList.add("hidden");
        render();
      } else {
        els.searchInput.blur();
      }
    }
  });

  els.clearTokenBtn.addEventListener("click", () => {
    clearToken();
    els.tokenInput.value = "";
    els.fetchStatus.textContent = "Cleared saved GitHub token.";
  });

  els.settingsForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (state.isFetching) {
      els.fetchStatus.textContent = "A fetch is in progress. Try saving again when it finishes.";
      return;
    }
    const newTargets = canonicalTargetsString(els.targetsInput.value);
    if (!newTargets) {
      els.fetchStatus.textContent = "Enter at least one org, user, or owner/repo.";
      return;
    }

    const selectedBranchMode =
      els.settingsForm.querySelector('input[name="branch-mode"]:checked')?.value === "all"
        ? "all"
        : "default";

    const tokenVal = els.tokenInput.value.trim();
    if (tokenVal) saveToken(tokenVal);

    const changed =
      newTargets !== canonicalTargetsString(state.targetsRaw) ||
      selectedBranchMode !== state.branchMode;

    state.targetsRaw = newTargets;
    state.branchMode = selectedBranchMode;
    state.collapsedGroups.clear();
    saveSettings();

    // Load cached dataset for this target+branchMode immediately if available
    const existingCache = loadCachedDataset(newTargets, selectedBranchMode);
    if (existingCache && !changed) {
      state.dataset = existingCache;
    } else {
      state.dataset = existingCache || null;
    }
    render();

    const ok = await refreshCommits({
      statusCb: (msg) => {
        els.fetchStatus.textContent = msg;
      },
    });
    if (ok) els.settingsDialog.close();
  });
}

/* ---------- Bootstrap ---------- */
async function init() {
  loadSavedSettings();
  readUrlState();
  bindEvents();

  const token = getToken();
  const cached = loadCachedDataset();

  if (cached) {
    state.dataset = cached;
    render();

    const ageMs = cached.generatedAt ? Date.now() - Date.parse(cached.generatedAt) : Infinity;
    const needsWiderWindow = state.days > (cached.days || 7);
    const refreshAfter = token && AUTO_REFRESH_MS ? Math.min(AUTO_REFRESH_MS, CACHE_TTL_MS) : CACHE_TTL_MS;
    if (ageMs > refreshAfter || needsWiderWindow || (token && cached.isPublicFallback)) {
      await refreshCommits();
    }
    return;
  }

  await refreshCommits();
}

init().finally(scheduleAutoRefresh);
