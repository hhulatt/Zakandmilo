/* Zak & Milo — monthly Rainbet wager leaderboard.
   Data is a static JSON snapshot refreshed by a scheduled job; nothing here
   touches the Rainbet API directly, so the affiliate key never reaches a browser. */
(() => {
  'use strict';

  const TZ = 'Europe/London';
  const DATA_URL = 'data/leaderboard.json';
  const HISTORY_INDEX_URL = 'data/history/index.json';

  const $ = (id) => document.getElementById(id);

  const money = new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  });
  const moneyExact = new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2,
  });

  /* ---------- Timezone helpers ---------------------------------------- */

  /** How far the given zone is from UTC at a specific instant, in ms. */
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

  /** UTC timestamp for a wall-clock midnight in the leaderboard's timezone. */
  function zonedMidnight(year, month, day) {
    const naive = Date.UTC(year, month - 1, day);
    let ts = naive;
    // Two passes settle the DST edge cases around the shift itself.
    for (let i = 0; i < 2; i++) ts = naive - zoneOffsetMs(new Date(ts), TZ);
    return ts;
  }

  /** Today's calendar date in the leaderboard's timezone. */
  function zonedToday() {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const get = (t) => Number(parts.find((p) => p.type === t).value);
    return { year: get('year'), month: get('month'), day: get('day') };
  }

  /** Midnight on the 1st of next month — when the board wipes and pays out. */
  function nextResetTs() {
    const { year, month } = zonedToday();
    return month === 12 ? zonedMidnight(year + 1, 1, 1) : zonedMidnight(year, month + 1, 1);
  }

  function monthLabel(monthId) {
    const [y, m] = monthId.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, 1))
      .toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }

  /* ---------- Countdown ------------------------------------------------ */

  const cd = { d: $('cd-days'), h: $('cd-hours'), m: $('cd-mins'), s: $('cd-secs') };
  let resetTs = nextResetTs();

  function tickCountdown() {
    let remaining = resetTs - Date.now();
    if (remaining <= 0) {
      // Month just rolled over: re-target and pull the fresh board.
      resetTs = nextResetTs();
      remaining = Math.max(0, resetTs - Date.now());
      loadBoard();
    }
    const total = Math.floor(remaining / 1000);
    const pad = (n) => String(n).padStart(2, '0');
    cd.d.textContent = pad(Math.floor(total / 86400));
    cd.h.textContent = pad(Math.floor(total / 3600) % 24);
    cd.m.textContent = pad(Math.floor(total / 60) % 60);
    cd.s.textContent = pad(total % 60);
  }

  tickCountdown();
  setInterval(tickCountdown, 1000);

  /* ---------- Rendering ------------------------------------------------ */

  const MEDALS = ['🥇', '🥈', '🥉'];
  let board = null;
  let showingAll = false;

  function renderPodium(entries) {
    const host = $('podium');
    const top = entries.slice(0, 3);
    if (!top.length) { host.innerHTML = ''; return; }
    host.innerHTML = top.map((e) => `
      <article class="pod pod--${e.rank}">
        <div class="pod__medal">${MEDALS[e.rank - 1]}</div>
        <p class="pod__rank">Rank ${e.rank}</p>
        <p class="pod__name">${escapeHtml(e.masked)}</p>
        <p class="pod__wagered">Wagered <strong>${moneyExact.format(e.wagered)}</strong></p>
        <span class="pod__prize">${money.format(e.prize)}</span>
      </article>`).join('');
  }

  function renderRows(entries) {
    const tbody = $('lb-body');
    if (!entries.length) {
      tbody.innerHTML = `<tr class="lb__empty"><td colspan="4">
        No wagers recorded yet this month — be the first on the board.</td></tr>`;
      return;
    }
    const visible = showingAll ? entries : entries.slice(0, board.boardSize || 25);
    const rows = visible.map((e) => `
      <tr data-hash="${e.hash}" class="${e.prize > 0 ? 'is-top' : ''}">
        <td><span class="lb__rank">${e.rank}</span></td>
        <td class="lb__name">${escapeHtml(e.masked)}</td>
        <td class="num">${moneyExact.format(e.wagered)}</td>
        <td class="num ${e.prize > 0 ? 'lb__prize' : 'lb__prize--none'}">${e.prize > 0 ? money.format(e.prize) : '—'}</td>
      </tr>`).join('');

    const hidden = entries.length - visible.length;
    const toggle = (hidden > 0 || showingAll)
      ? `<tr class="lb__empty"><td colspan="4">
           <button class="btn btn--ghost btn--sm" id="toggle-all" type="button">
             ${showingAll ? 'Show top ' + (board.boardSize || 25) : 'Show all ' + entries.length + ' players'}
           </button></td></tr>`
      : '';

    tbody.innerHTML = rows + toggle;
    const btn = $('toggle-all');
    if (btn) btn.addEventListener('click', () => { showingAll = !showingAll; renderRows(entries); });
  }

  function renderPrizes(prizes) {
    $('prize-grid').innerHTML = prizes.map((amount, i) => `
      <li class="prize prize--${i + 1}">
        <span class="prize__rank">${ordinal(i + 1)}</span>
        <span class="prize__amt">${money.format(amount)}</span>
      </li>`).join('');
  }

  function renderBoard(data) {
    board = data;
    $('period-label').textContent = monthLabel(data.month);
    $('stat-players').textContent = data.playerCount.toLocaleString('en-GB');
    $('stat-wagered').textContent = money.format(data.totalWagered);
    $('updated-at').textContent = new Date(data.updatedAt)
      .toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: TZ }) + ' UK';
    renderPodium(data.entries);
    renderRows(data.entries);
    renderPrizes(data.prizes);
  }

  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function loadBoard() {
    try {
      const res = await fetch(`${DATA_URL}?v=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      renderBoard(await res.json());
    } catch (err) {
      console.error('Could not load leaderboard', err);
      $('lb-body').innerHTML = `<tr class="lb__empty"><td colspan="4">
        Leaderboard is temporarily unavailable. Please refresh in a moment.</td></tr>`;
    }
  }

  /* ---------- Search --------------------------------------------------- */

  /* Rows ship with a hash of the username rather than the username itself, so a
     player can prove which row is theirs without the board exposing anyone else. */
  async function hashUsername(name) {
    const bytes = new TextEncoder().encode(name.trim().toLowerCase());
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  }

  const searchResult = $('search-result');

  function setResult(message, state) {
    searchResult.textContent = message;
    searchResult.className = `search__result${state ? ' search__result--' + state : ''}`;
  }

  async function runSearch() {
    const query = $('search-input').value.trim();
    document.querySelectorAll('tr.is-you').forEach((tr) => tr.classList.remove('is-you'));

    if (!query) { setResult('Enter your Rainbet username to find your position.', null); return; }
    if (!board) { setResult('Leaderboard is still loading — try again in a second.', 'miss'); return; }
    if (!window.crypto?.subtle) {
      setResult('Search needs a secure (https) connection.', 'miss');
      return;
    }

    const hash = await hashUsername(query);
    const match = board.entries.find((e) => e.hash === hash);

    if (!match) {
      setResult(`No wagers found for "${query}" this month. Make sure you signed up with code ZAKANDMILO and that the spelling matches exactly.`, 'miss');
      return;
    }

    // Reveal the whole board if their row sits below the default cut-off.
    if (match.rank > (board.boardSize || 25) && !showingAll) {
      showingAll = true;
      renderRows(board.entries);
    }

    const prize = match.prize > 0
      ? ` You're in the money for ${money.format(match.prize)}.`
      : ` ${money.format(0)} so far — the top 10 get paid, keep climbing.`;
    setResult(`${query} — rank #${match.rank} with ${moneyExact.format(match.wagered)} wagered.${prize}`, 'hit');

    const row = document.querySelector(`tr[data-hash="${hash}"]`);
    if (row) {
      row.classList.add('is-you');
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  $('search-btn').addEventListener('click', runSearch);
  $('search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); runSearch(); }
  });

  /* ---------- Copy code ------------------------------------------------ */

  const copyBtn = $('copy-code');
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(copyBtn.dataset.code);
      copyBtn.textContent = 'Copied!';
    } catch {
      copyBtn.textContent = 'Press Ctrl+C';
    }
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
  });

  /* ---------- Previous months ------------------------------------------ */

  async function loadHistory() {
    let months = [];
    try {
      const res = await fetch(HISTORY_INDEX_URL, { cache: 'no-store' });
      if (!res.ok) return;
      months = (await res.json()).months || [];
    } catch { return; }
    if (!months.length) return;

    const section = $('history');
    const select = $('history-select');
    select.innerHTML = months
      .map((m) => `<option value="${m}">${monthLabel(m)}</option>`).join('');
    section.hidden = false;

    async function showMonth(monthId) {
      const body = $('history-body');
      body.innerHTML = `<tr class="lb__empty"><td colspan="4">Loading…</td></tr>`;
      try {
        const res = await fetch(`data/history/${monthId}.json`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const past = await res.json();
        const winners = past.entries.filter((e) => e.prize > 0);
        body.innerHTML = winners.length
          ? winners.map((e) => `
              <tr class="is-top">
                <td><span class="lb__rank">${e.rank}</span></td>
                <td class="lb__name">${escapeHtml(e.masked)}</td>
                <td class="num">${moneyExact.format(e.wagered)}</td>
                <td class="num lb__prize">${money.format(e.prize)}</td>
              </tr>`).join('')
          : `<tr class="lb__empty"><td colspan="4">No winners recorded for this month.</td></tr>`;
      } catch {
        body.innerHTML = `<tr class="lb__empty"><td colspan="4">Could not load this month.</td></tr>`;
      }
    }

    select.addEventListener('change', () => showMonth(select.value));
    showMonth(months[0]);
  }

  loadBoard();
  loadHistory();
})();
