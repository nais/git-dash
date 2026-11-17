# git commits dashboard

Compact, zero-framework HTML/CSS/JS dashboard for viewing recent commits across any mix of GitHub orgs, user accounts, and individual `owner/repo` repositories. Fetches directly in the browser via GitHub GraphQL and caches results in `localStorage`.

## Setup

### Option A: Configure in the UI

Click the top-left target badge (e.g. `nais ▾`), click **Configure**, or press `s`:
- **Targets**: comma/newline-separated orgs, users, or specific repos (e.g. `nais, sechmann, navikt/naisdevice`).
- **Branch scope**: **Default branch** (`main`/`master`) or **All branches** (scans active branches and dedupes by commit SHA).
- **GitHub Token**: paste output of `gh auth token` (stored in a browser cookie + `localStorage`).

### Option B: Local config file (gitignored)

```bash
printf 'window.NAIS_DASH_CONFIG = { targets: "nais", branchMode: "default", token: "%s" };\n' "$(gh auth token)" > config.local.js
```

## Run

```bash
python3 -m http.server 8000
```

## Shortcuts & URL / Search Qualifiers

- `/` — focus filter (`Esc` clears)
- `r` — refresh commits from GitHub
- `s` — open target / branch / token configuration
- URL params: `?targets=nais,sechmann&branches=all&days=7`
- Filter qualifiers: `repo:cli`, `owner:nais`, `branch:feat`, `author:vegar`, `pr:123`, `sha:a1b2c3`, `is:bot`, `is:human`, `is:pr`
