# git commits dashboard

Compact, zero-framework HTML/CSS/JS dashboard for viewing recent commits across any mix of GitHub orgs, user accounts, and individual `owner/repo` repositories. Fetches directly in the browser via GitHub GraphQL and caches results in `localStorage`.

## Setup

### Option A: Configure in the UI

Click the top-left target badge (e.g. `nais ▾`), click **Configure**, or press `s`:
- **Targets**: comma/newline-separated orgs, users, or specific repos (e.g. `nais, sechmann, navikt/naisdevice`).
- **Branch scope**: **Default branch** (`main`/`master`) or **All branches** (scans active branches and dedupes by commit SHA).
- **GitHub Token**: click **Create read-only token on GitHub ↗** to create a fine-grained personal access token, then paste it (stored in a browser cookie + `localStorage`). The link pre-selects the permissions below and, when all targets share one owner, that resource owner.

[Create a read-only PAT](https://github.com/settings/personal-access-tokens/new?name=git-dash&description=Read-only+commit+dashboard&expires_in=30&contents=read&pull_requests=read) with:
- **Contents: Read-only** — commit history, branches, and commit statistics.
- **Pull requests: Read-only** — associated pull request details.
- **Metadata: Read-only** — included automatically; no organization-level permissions needed.

Choose the **Resource owner** and **Only select repositories** to limit access to the repositories you need. The link defaults to a 30-day expiration. Organizations may require approval or restrict PAT access.

A fine-grained PAT grants private repository access under only one resource owner; it cannot cover private repos across multiple owners, and outside-collaborator access has limitations. Public repositories remain readable. Narrow your targets if needed rather than granting the broad read/write `repo` scope of a classic PAT. See [GitHub's PAT documentation](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) for current limitations.

### Option B: Local config file (gitignored)

Create `config.local.js` using the read-only PAT above:

```js
window.NAIS_DASH_CONFIG = {
  targets: "nais",
  branchMode: "default",
  token: "github_pat_REPLACE_WITH_YOUR_READ_ONLY_TOKEN",
};
```

Keep this file private. It is gitignored, but any web server serving the dashboard can also serve this file; never deploy it with a real token.

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
