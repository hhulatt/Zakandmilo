# Build spec — Rainbet affiliate wager leaderboard site

A complete rebuild guide for a one-page site that advertises a Rainbet affiliate
code and runs a recurring cash wager leaderboard off Rainbet's affiliate API.

This document is written to be handed to a fresh Claude Code session. It records
the API's real behaviour, the design decisions and the traps, so a rebuild does
not have to rediscover them. Anything marked **VERIFIED** was confirmed by
running it, not assumed.

---

## 1. Collect these inputs first

Do not start building until you have all of these. Several change the data model,
so guessing them means rework.

| Input | Example | Notes |
| --- | --- | --- |
| Rainbet API key | `T7xY…` (secret) | Never commit it. Goes in a repo Secret. |
| Affiliate code | `ZAKANDMILO` | Shown on the page and in the referral link. |
| Prize pool + split | `$2500` as `[1000,500,300,200,150,100,80,70,60,40]` | Must sum to the pool. Length = number of paid places. |
| Cycle start day | `13` | `1` = calendar months. Anything else = offset cycles. |
| Timezone | `Europe/London` | Drives reset instant, countdown and cron. |
| Socials | Kick / Instagram / TikTok handles | Per person and joint. |
| Domain | `zakandmilo.com` | Affects canonical + `og:url`. |
| Repo + visibility | `owner/repo`, private | Private rules out free GitHub Pages — see §11. |

**Ask about prize split and timezone explicitly.** Both are business decisions
with no safe default.

---

## 2. The Rainbet API — verified behaviour

```
GET https://services.rainbet.com/v1/external/affiliates
      ?start_at=YYYY-MM-DD
      &end_at=YYYY-MM-DD
      &key=<API KEY>
```

Auth is the `key` query parameter. There is no header auth.

**Response:**

```json
{
  "affiliates": [
    { "username": "someplayer", "id": "5AAF…", "wagered_amount": "416.9225" }
  ],
  "cache_updated_at": "2026-09-02 00:28:41"
}
```

**Behaviour confirmed by probing (VERIFIED):**

- Rows arrive **already sorted** by `wagered_amount` descending. Sort anyway —
  do not rely on it for correctness.
- `wagered_amount` is a **string** with 4 decimal places. Parse to number, round
  to 2 for display.
- Both dates are **inclusive**.
- `limit` and `sort` parameters are **ignored**. Any row cap is your own job.
- There is **no pagination**. One request returns the whole period.
- Errors are HTTP 400 with a JSON body:
  - `{"error":"er_invalid_date_format"}` — missing/malformed dates
  - `{"error":"er_invalid_key"}` — bad key
- `cache_updated_at` is server-side cache time, not request time. It is a useful
  sanity check on the real date — see the clock trap in §13.
- Periods before the affiliate relationship began return `{"affiliates":[]}`,
  **not** an error. Empty is a legitimate answer, so handle it as data.

**The docs page is unreadable to tooling.** `https://services.rainbet.com/external-documentation/`
sits behind a Cloudflare browser check and returns 403 to WebFetch and a JS
challenge to curl. Probe the endpoint directly instead — that is how everything
above was established.

---

## 3. The constraint that drives the architecture

**The API key must never reach a browser.** The endpoint takes the key as a query
parameter, so any client-side fetch would publish it to every visitor.

Therefore the site never calls the API. Instead:

```
scheduled job (has the key)
   -> calls Rainbet API
   -> masks usernames, computes ranks/prizes
   -> writes data/leaderboard.json
   -> commits it to the repo
   -> host sees the push and redeploys
   -> browser reads the static JSON
```

This also means the site keeps working if the API is down, and costs nothing to
serve.

---

## 4. Repo layout

```
index.html                        one page, no framework, no build step
assets/style.css                  design system + components
assets/app.js                     countdown, rendering, search, history
scripts/fetch-leaderboard.mjs     the only thing that touches the API
data/leaderboard.json             current cycle snapshot (generated, committed)
data/history/<start-date>.json    one archived snapshot per closed cycle
data/history/index.json           list of closed cycles, newest first
.github/workflows/leaderboard.yml scheduled refresh
netlify.toml                      host config (publish dir + headers)
```

No dependencies. No `package.json`. Node 20+ for the script (global `fetch`),
plain ES modules in the browser.

---

## 5. The cycle date model

A cycle runs **from day N of one month to day (N-1) of the next**. For N=13:
13 Aug → 12 Sep, then 13 Sep → 12 Oct.

**Why end on the 12th and not the 13th:** consecutive cycles must tile the
timeline with no gap and no overlap. If a cycle both starts and ends on the 13th,
that day belongs to two cycles.

**Why this is free of month-length bugs:** for any start day N in 2…29, the end
day N-1 lands in 1…28 and therefore exists in every month, including February in
a non-leap year. Never compute the end as "last day of month" or "start minus one
day across a month boundary" — both reintroduce the edge cases this avoids.

The formula has two boundaries, both **VERIFIED**:
- `N = 30` or `31` produces an end day of 29 or 30, which does not exist in
  February (`2027-02-29` in a non-leap year). Do not use a start day above 29.
- `N = 1` produces day 0 — the invalid string `2026-09-00`. See below.

Core functions (mirrored in the fetch script and `app.js`):

```js
const CYCLE_START_DAY = 13;
const pad = (n) => String(n).padStart(2, '0');
const previousMonth = (y, m) => (m === 1 ? { year: y - 1, month: 12 } : { year: y, month: m - 1 });
const nextMonth     = (y, m) => (m === 12 ? { year: y + 1, month: 1 } : { year: y, month: m + 1 });

function cycleStartingIn(year, month) {
  const end = nextMonth(year, month);
  const start = `${year}-${pad(month)}-${pad(CYCLE_START_DAY)}`;
  return { id: start, start, end: `${end.year}-${pad(end.month)}-${pad(CYCLE_START_DAY - 1)}` };
}

function cycleContaining({ year, month, day }) {
  if (day < CYCLE_START_DAY) {
    const prev = previousMonth(year, month);
    return cycleStartingIn(prev.year, prev.month);
  }
  return cycleStartingIn(year, month);
}
```

A cycle's `id` is its start date (`2026-08-13`), which sorts lexicographically
and doubles as the archive filename.

**`CYCLE_START_DAY = 1` does not give calendar months — it emits the invalid date
`YYYY-MM-00`** and the API rejects it with `er_invalid_date_format`. Calendar
months are a genuinely different shape: the period is the 1st to the month's true
last day, within a single month. Special-case it rather than bending this
formula.

---

## 6. Timezone handling

The reset instant is midnight **in the configured zone**, not UTC. Both the
script and the browser need this, and it must survive DST.

```js
/** How far the zone is from UTC at a specific instant, in ms. */
function zoneOffsetMs(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant);
  const f = {};
  for (const p of parts) f[p.type] = p.value;
  const asUtc = Date.UTC(+f.year, +f.month - 1, +f.day, +f.hour % 24, +f.minute, +f.second);
  return asUtc - instant.getTime();
}

/** UTC timestamp for a wall-clock midnight in that zone. */
function zonedMidnight(year, month, day, timeZone) {
  const naive = Date.UTC(year, month - 1, day);
  let ts = naive;
  for (let i = 0; i < 2; i++) ts = naive - zoneOffsetMs(new Date(ts), timeZone);
  return ts;
}
```

Two passes are required: the first uses the wrong side of a DST shift, the second
corrects it. `+f.hour % 24` handles formatters that render midnight as `24`.

**VERIFIED** for Europe/London: BST resets resolve to 23:00 UTC the previous day,
GMT resets to 00:00 UTC, across seven cases spanning both shifts.

---

## 7. Username privacy, and search that still works

Two requirements in tension: hide players' identities, but let a player find
their own row.

**Masking** happens in the script, before anything is written to disk, so full
usernames never enter the repo or the page:

```js
function maskUsername(name) {
  const chars = [...name];
  if (chars.length <= 2) return `${chars[0] ?? '*'}**`;
  if (chars.length <= 5) return `${chars[0]}${'*'.repeat(chars.length - 2)}${chars.at(-1)}`;
  return `${chars.slice(0, 2).join('')}${'*'.repeat(chars.length - 4)}${chars.slice(-2).join('')}`;
}
// "mrwilliams" -> "mr******ms"
```

Use `[...name]` not `name.split('')` so non-BMP characters in usernames are not
split into broken halves.

**Search** ships a truncated hash instead of the name. The browser hashes what
the player types and compares:

```js
// script (Node)
createHash('sha256').update(name.trim().toLowerCase()).digest('hex').slice(0, 16)

// browser — must produce the identical string
const bytes = new TextEncoder().encode(query.trim().toLowerCase());
const digest = await crypto.subtle.digest('SHA-256', bytes);
[...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
```

Lowercasing on both sides makes search case-insensitive. `crypto.subtle` requires
a **secure context** — HTTPS or localhost — so the page must be served, not opened
as `file://`.

Ship **every** player in `entries`, not just the visible rows, or players outside
the display cut-off cannot find themselves. Render the top N with a "show all"
toggle, and auto-expand when a search match sits below the cut.

---

## 8. Data contract

`data/leaderboard.json`, written by the script and read by the page:

```json
{
  "cycle": "2026-08-13",
  "periodStart": "2026-08-13",
  "periodEnd": "2026-09-12",
  "cycleStartDay": 13,
  "timezone": "Europe/London",
  "prizePool": 2500,
  "prizes": [1000, 500, 300, 200, 150, 100, 80, 70, 60, 40],
  "boardSize": 25,
  "totalWagered": 92258.89,
  "playerCount": 33,
  "cacheUpdatedAt": "2026-09-02 00:28:41",
  "updatedAt": "2026-09-02T00:31:12.004Z",
  "entries": [
    { "rank": 1, "masked": "Ar**********34", "hash": "a1b2c3d4e5f60718", "wagered": 60180.07, "prize": 1000 }
  ]
}
```

The page renders the prize table, the board and the search copy from `prizes`, so
changing the split in one place updates all three.

`data/history/index.json` is `{ "cycles": [{ "id", "start", "end" }] }`, newest
first. Archives are the same shape as the current snapshot.

---

## 9. Archiving closed cycles

On each run, after writing the current cycle, compute the previous cycle and
archive it **if it is not already archived**. Closed totals are final, so an
existing archive is never refetched — that also makes past winners immune to
later API changes.

Skip writing an archive when the period returns zero players, so an empty file
never suppresses a later real one.

Then rebuild `data/history/index.json` by listing the directory. Do not append —
regenerating from disk keeps the index consistent if a file is added or removed
by hand.

---

## 10. Front-end behaviour

- **Countdown** ticks each second to the next reset. On reaching zero it
  re-targets the following cycle and re-fetches the board, so a rollover needs no
  page reload.
- **Period label** is the real date range ("13 Aug – 12 Sep 2026"). A month name
  would be actively misleading for offset cycles.
- **Podium** for the top three, with rank 2 / 1 / 3 visual ordering via CSS
  `order`, so first place sits centre.
- **Previous winners** sits directly beneath the live board: champion card, then
  the full paid list. The whole section stays hidden until at least one cycle has
  closed — never render an empty table.
- **Cache-bust** every data fetch (`?v=${Date.now()}` plus `cache: 'no-store'`).
- **Escape all rendered strings.** Usernames come from an external API and land in
  `innerHTML`.

**Design system** (blue/red, dark, gamified):

```
--blue #2f6bff   --blue-lit #5b91ff   --red #ff2d55   --red-lit #ff5c7a
--gold #ffc93c   --bg #05070f         --panel #0c1224  --text #eaf0ff
--muted #8fa0c9  fonts: Chakra Petch (display) + Inter (body)
```

Fixed blurred colour blooms behind the page, gradient-clipped hero numerals, and
a gold accent reserved exclusively for prize money.

---

## 11. Hosting

**GitHub Pages does not work for a private repo on a free plan.** Enabling it
fails with `Resource not accessible by integration`, and `actions/configure-pages`
with `enablement: true` cannot work around it. Either make the repo public or use
another host.

**Netlify free tier supports private repos.** Connect the repo in the Netlify UI —
this needs an interactive OAuth login, so the user must do it. Settings come from
`netlify.toml`; the production branch must be set to the branch being pushed.

```toml
[build]
  publish = "."
  command = ""

[[headers]]
  for = "/data/*"
  [headers.values]
    Cache-Control = "public, max-age=0, must-revalidate"
```

The no-cache header on `/data/*` is essential: without it the refreshed board is
served stale from CDN cache and the whole pipeline looks broken.

Netlify redeploys automatically on push, including the bot's data commits — which
is what closes the automation loop.

---

## 12. Scheduled refresh

```yaml
on:
  schedule:
    - cron: '2 0 * * *'   # 00:02 UTC — local midnight in winter
    - cron: '2 23 * * *'  # 23:02 UTC — local midnight in summer
  workflow_dispatch:

permissions:
  contents: write

jobs:
  refresh:
    runs-on: ubuntu-latest
    env:
      RAINBET_API_KEY: ${{ secrets.RAINBET_API_KEY }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - name: Check the API key is present
        run: |
          if [ -z "$RAINBET_API_KEY" ]; then
            echo "::error::RAINBET_API_KEY secret is not set."
            exit 1
          fi
      - name: Fetch latest wager totals
        run: node scripts/fetch-leaderboard.mjs
      - name: Commit refreshed data
        run: |
          if [ -z "$(git status --porcelain data)" ]; then
            echo "No leaderboard changes."; exit 0
          fi
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add data
          git commit -m "chore: refresh leaderboard data"
          git push origin HEAD:${{ github.ref_name }}
```

**Cron is always UTC.** For a zone with DST, schedule both candidate times; one
lands on local midnight and the other is a harmless extra refresh, because the
script is idempotent and the commit step no-ops when nothing changed.

Add the key under **Settings → Secrets and variables → Actions** as
`RAINBET_API_KEY`. Fail loudly if it is missing — a silent skip produces a site
that quietly stops updating.

---

## 13. Traps that cost real time

1. **Scheduled workflows only run on the repository's default branch.** Building
   on a feature branch means the cron never fires. Check which branch is default.
2. **`env` in a step-level `if:` is not visible.** `if: env.FOO != ''` only sees
   workflow- or job-level `env`, so define the secret at job level.
3. **Do not trust the sandbox clock.** It can be weeks behind real time. Use the
   API's `cache_updated_at` to sanity-check the date before concluding anything
   about which cycle is current.
4. **Empty API responses are meaningful.** Before concluding "no data", probe
   adjacent ranges: if `1–31 Aug` equals `13–31 Aug` exactly, data genuinely
   starts on the 13th rather than the query being wrong.
5. **The bot pushes to the same branch you do.** Expect rebase conflicts on
   `data/*`. Resolve by **regenerating** the files, never by hand-merging
   generated JSON.
6. **`crypto.subtle` is undefined on `file://`.** Test over a local HTTP server.
7. **Chromium needs the proxy passed explicitly** in sandboxes; and a domain whose
   TLS certificate is still provisioning cannot be driven headlessly at all.
   Verify by diffing served bytes against the locally tested copy instead.
8. **A new custom domain serves the host's default certificate** for a while.
   Confirm the certificate's CN before telling anyone the site is shareable.

---

## 14. Verification checklist

Do not report success without these:

- [ ] **Cycle boundaries** — table-test `cycleContaining` across: the day before a
      rollover, the rollover day itself, year boundaries (Dec→Jan), February in a
      non-leap and a leap year. Then assert N consecutive cycles tile with no gaps
      or overlaps.
- [ ] **DST** — assert each reset lands on local midnight in both summer and
      winter.
- [ ] **Search** — a known username matches with different casing; an unknown one
      reports a clean miss.
- [ ] **Mobile** — at 390px wide, assert `scrollWidth - innerWidth === 0` and that
      the prize column's right edge is inside the viewport.
- [ ] **Empty state** — with no archives, the winners section is hidden, not an
      empty table. Stage a synthetic archive to confirm the populated state too,
      then remove it.
- [ ] **Live deploy** — fetch the deployed page and JSON; confirm the `/data/*`
      cache header; diff served assets against the local copies.
- [ ] **Automation loop** — trigger the workflow manually and confirm it produces
      a real data commit authored by `github-actions[bot]`.

---

## 15. Adapting to a different creator

Everything creator-specific is contained in:

- `PRIZES` and `CYCLE_START_DAY` in `scripts/fetch-leaderboard.mjs`
- `CYCLE_START_DAY` in `assets/app.js` — **must match the script**
- `TZ` in both files
- Affiliate code, referral URL, social links and copy in `index.html`
- Canonical and `og:url` in `index.html`
- Colour tokens at the top of `assets/style.css`
- The cron pair in the workflow, if the timezone changes

Keep `CYCLE_START_DAY` and `TZ` in sync across the two files — they are the only
duplicated constants, and divergence produces a countdown that disagrees with the
data.
