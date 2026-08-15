#!/usr/bin/env node
/**
 * Pulls the Rainbet affiliate wager totals for the current month, masks the
 * usernames, and writes the static JSON the site reads.
 *
 * Endpoint: GET /v1/external/affiliates?start_at=YYYY-MM-DD&end_at=YYYY-MM-DD&key=...
 * Response: { affiliates: [{ username, id, wagered_amount }], cache_updated_at }
 * The API already returns rows sorted by wagered_amount descending.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile, access, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINT = 'https://services.rainbet.com/v1/external/affiliates';
const TZ = 'Europe/London';
const PRIZES = [1000, 500, 300, 200, 150, 100, 80, 70, 60, 40];
/** Rows rendered before the "show all" toggle. Every player is still shipped so search can find them. */
const BOARD_SIZE = 25;

const KEY = process.env.RAINBET_API_KEY;
if (!KEY) {
  console.error('RAINBET_API_KEY is not set.');
  process.exit(1);
}

/** Today's date in the leaderboard timezone, as { year, month, day }. */
function todayInTz() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

const pad = (n) => String(n).padStart(2, '0');

/** Inclusive first/last calendar day of the given month. */
function monthRange(year, month) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    id: `${year}-${pad(month)}`,
    start: `${year}-${pad(month)}-01`,
    end: `${year}-${pad(month)}-${pad(lastDay)}`,
  };
}

function previousMonth(year, month) {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

/**
 * Masks the middle of a username so players can still recognise their own row
 * without the board publishing anyone's full handle.
 */
function maskUsername(name) {
  const chars = [...name];
  if (chars.length <= 2) return `${chars[0] ?? '*'}**`;
  if (chars.length <= 5) return `${chars[0]}${'*'.repeat(chars.length - 2)}${chars.at(-1)}`;
  return `${chars.slice(0, 2).join('')}${'*'.repeat(chars.length - 4)}${chars.slice(-2).join('')}`;
}

/** Search token: the site hashes what the player types and compares locally. */
function searchHash(name) {
  return createHash('sha256').update(name.trim().toLowerCase()).digest('hex').slice(0, 16);
}

async function fetchMonth({ start, end }) {
  const url = `${ENDPOINT}?start_at=${start}&end_at=${end}&key=${encodeURIComponent(KEY)}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const body = await res.text();
  if (!res.ok) throw new Error(`Rainbet API ${res.status}: ${body.slice(0, 200)}`);

  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`Rainbet API returned non-JSON: ${body.slice(0, 200)}`);
  }
  if (!Array.isArray(json.affiliates)) throw new Error(`Unexpected payload: ${body.slice(0, 200)}`);
  return json;
}

function buildBoard(payload, range) {
  const rows = payload.affiliates
    .map((a) => ({ username: String(a.username ?? ''), wagered: Number(a.wagered_amount) }))
    .filter((a) => a.username && Number.isFinite(a.wagered) && a.wagered > 0)
    .sort((a, b) => b.wagered - a.wagered);

  const entries = rows.map((row, i) => ({
    rank: i + 1,
    masked: maskUsername(row.username),
    hash: searchHash(row.username),
    wagered: Number(row.wagered.toFixed(2)),
    prize: PRIZES[i] ?? 0,
  }));

  return {
    month: range.id,
    periodStart: range.start,
    periodEnd: range.end,
    timezone: TZ,
    prizePool: PRIZES.reduce((a, b) => a + b, 0),
    prizes: PRIZES,
    boardSize: BOARD_SIZE,
    totalWagered: Number(rows.reduce((sum, r) => sum + r.wagered, 0).toFixed(2)),
    playerCount: rows.length,
    cacheUpdatedAt: payload.cache_updated_at ?? null,
    updatedAt: new Date().toISOString(),
    entries,
  };
}

const exists = (p) => access(p).then(() => true, () => false);

async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`wrote ${path}`);
}

const { year, month } = todayInTz();
const current = monthRange(year, month);
const board = buildBoard(await fetchMonth(current), current);
await writeJson(join(ROOT, 'data', 'leaderboard.json'), board);
console.log(`${board.month}: ${board.playerCount} players, $${board.totalWagered} wagered`);

// Archive the month that just closed so the site can show previous winners.
const prev = previousMonth(year, month);
const prevRange = monthRange(prev.year, prev.month);
const archivePath = join(ROOT, 'data', 'history', `${prevRange.id}.json`);
if (await exists(archivePath)) {
  console.log(`${prevRange.id} already archived`);
} else {
  try {
    const previousBoard = buildBoard(await fetchMonth(prevRange), prevRange);
    if (previousBoard.playerCount > 0) {
      await writeJson(archivePath, previousBoard);
    } else {
      console.log(`${prevRange.id} has no wagers, skipping archive`);
    }
  } catch (err) {
    console.warn(`could not archive ${prevRange.id}: ${err.message}`);
  }
}

// Index of archived months, newest first, so the site can list past winners.
const historyDir = join(ROOT, 'data', 'history');
const archived = (await readdir(historyDir))
  .filter((f) => /^\d{4}-\d{2}\.json$/.test(f))
  .map((f) => f.replace('.json', ''))
  .sort()
  .reverse();
await writeJson(join(historyDir, 'index.json'), { months: archived });
