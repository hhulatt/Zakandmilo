# Zak & Milo — $2,500 Monthly Rainbet Wager Leaderboard

One-page site advertising the Zak & Milo Rainbet affiliate code (`ZAKANDMILO`) and the
$2,500 monthly wager competition. Static HTML/CSS/JS — no build step, no framework.

## How it works

`scripts/fetch-leaderboard.mjs` calls Rainbet's affiliate API for the current calendar
month, masks every username, and writes `data/leaderboard.json`. The page reads that
static file, so **the API key is never exposed to a browser**. A scheduled GitHub Action
re-runs the script every midnight UK time and commits the refreshed snapshot, which the
host picks up and redeploys.

| Piece | File |
| --- | --- |
| Page | `index.html`, `assets/style.css`, `assets/app.js` |
| Data fetcher | `scripts/fetch-leaderboard.mjs` |
| Current board | `data/leaderboard.json` |
| Closed months | `data/history/YYYY-MM.json`, `data/history/index.json` |
| Data refresh | `.github/workflows/leaderboard.yml` |
| Host config | `netlify.toml` |

## Hosting

Live at **https://zakandmilo.com** (Netlify DNS, apex and `www` both pointed at
Netlify's load balancers).

The repo is private, so the site is served by **Netlify** (free tier, supports
private repos) rather than GitHub Pages, which needs a public repo on a free
GitHub plan. GitHub Actions only produces the data; Netlify only serves it.

```
midnight cron -> Action fetches Rainbet API -> commits data/leaderboard.json
              -> Netlify sees the push -> redeploys the site
```

## Setup

1. **Add the API key.** Repo -> Settings -> Secrets and variables -> Actions ->
   New repository secret, named `RAINBET_API_KEY`. The refresh workflow fails
   loudly without it.
2. **Connect Netlify.** netlify.com -> Add new site -> Import an existing project
   -> GitHub -> `hhulatt/Zakandmilo`. Settings come from `netlify.toml`, so leave
   the build command empty and the publish directory as `.`. Set the production
   branch to `claude/zakandmilo-rainbet-site-aq6zil`.
3. Trigger a first data pull from the Actions tab -> Refresh leaderboard -> Run
   workflow. Netlify redeploys on the resulting commit.

## Competition rules encoded here

- **Prize pool:** $2,500 across the top 10, defined by `PRIZES` in the fetch script.
  `[1000, 500, 300, 200, 150, 100, 80, 70, 60, 40]`
- **Period:** one calendar month, resetting at midnight `Europe/London` on the 1st.
  The on-page countdown targets the same instant and handles BST/GMT.
- Changing `PRIZES` updates the leaderboard, the prize breakdown, and the search
  result copy together — the page renders all three from the JSON.

## Username privacy

Usernames are masked to first two and last two characters (`mrwilliams` → `mr******ms`)
before anything is written to disk, so full handles never reach the repo or the page.

Search still works: each row ships a truncated SHA-256 of the lowercased username, and
the browser hashes what the player types to find their own row. A player can confirm
their own position without the site revealing anyone else's identity.

## Local development

```bash
RAINBET_API_KEY=... node scripts/fetch-leaderboard.mjs   # refresh data
python3 -m http.server 8765                              # then open localhost:8765
```

Search needs a secure context (`localhost` or HTTPS) because it uses `crypto.subtle`.

## Update frequency

The workflow runs at `00:02` and `23:02` UTC so that one of the two lands on UK midnight
year-round in both GMT and BST; the other run is a harmless extra refresh. To refresh more
often, add another `cron` entry to `.github/workflows/leaderboard.yml` — the script is
idempotent and only commits when the numbers actually move.
