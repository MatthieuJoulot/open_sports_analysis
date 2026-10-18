import { fetchStats, fetchProfile, fetchHeatmap } from '../utils/api.js';
import { attachFullscreen } from '../utils/fullscreen.js';
import { fmtDate, fmtDuration, fmtDistance, fmtElevation, fmtHr, fmtSpeed, fmtPace, climbKey } from '../utils/format.js';
import { sportMeta } from '../utils/sports.js';

let statsData = null;
let period = 'year';   // 'year' | '12m' | 'all' | 'custom'
let customFrom = null; // 'YYYY-MM-DD' when period === 'custom'
let customTo = null;
let sport = 'cycling';  // default view = the original cycling page

// Cycling scope keeps the original "Rides" vocabulary; other scopes are
// sport-neutral ("Activities").
function unitLabel() {
  return sport === 'cycling' ? 'Rides' : 'Activities';
}
let monthlyChart = null;
let categoriesChart = null;
let weatherChart = null;
let yoyChart = null;
let vo2Chart = null;

function monthKey(dateStr) {
  return dateStr ? dateStr.slice(0, 7) : '';
}

function addMonths(iso, n) {
  const [y, m] = iso.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

function monthsBetween(startIso, endIso) {
  const out = [];
  let cur = startIso;
  let guard = 0;
  while (cur <= endIso && guard++ < 600) {
    out.push(cur);
    cur = addMonths(cur, 1);
  }
  return out;
}

function periodRange(now, first = null) {
  const year = now.slice(0, 4);
  if (period === 'year') {
    return { start: `${year}-01`, end: `${year}-12`, label: year };
  }
  if (period === '12m') {
    return { start: addMonths(now, -11), end: now, label: `last 12 months` };
  }
  if (period === 'custom') {
    // Open-ended custom ranges fall back to the data's own bounds for the
    // missing side, so chart aggregation always has both months.
    const start = customFrom ? customFrom.slice(0, 7) : first;
    const end = customTo ? customTo.slice(0, 7) : now;
    if (!start) return { start: null, end: null, label: 'custom' };
    return { start, end, label: `${customFrom || '…'} → ${customTo || '…'}` };
  }
  return { start: null, end: null, label: 'all time' };
}

function previousRange(now) {
  if (period === 'year') {
    // Year-over-year with a partial current year would compare a few
    // months against a full previous year; truncate the previous
    // year at the same month so both windows cover the same span.
    const y = Number(now.slice(0, 4));
    const m = now.slice(5, 7);
    return { start: `${y - 1}-01`, end: `${y - 1}-${m}` };
  }
  if (period === '12m') {
    return { start: addMonths(now, -23), end: addMonths(now, -12) };
  }
  return null;
}

function inMonth(dateStr, range) {
  if (!range || !range.start) return true;
  const mk = monthKey(dateStr);
  return mk >= range.start && mk <= range.end;
}

// Backend date bounds for the selected period. The own VO2max estimates
// (best efforts, climb efforts) are computed server-side, so the payload
// must be re-requested whenever the period changes.
function periodBounds() {
  const acts = statsData?.activities || [];
  const now = acts.length ? acts[acts.length - 1].start_time.slice(0, 10) : null;
  const first = acts.length ? acts[0].start_time.slice(0, 10) : null;
  if (period === 'year') {
    // Latest known activity's year when we have data, else calendar year.
    const y = now ? now.slice(0, 4) : String(new Date().getFullYear());
    return [`${y}-01-01`, null];   // open-ended: new activities sync too
  }
  if (period === '12m') {
    const mk = now ? now.slice(0, 7) : new Date().toISOString().slice(0, 7);
    const [yy, mm] = mk.split('-').map(Number);
    const d = new Date(Date.UTC(yy, mm - 12, 1));
    return [d.toISOString().slice(0, 10), null];
  }
  if (period === 'custom') {
    return [customFrom || first, customTo || now];
  }
  return [null, null];
}

async function refetchStats() {
  try {
    statsData = await fetchStats(sport, ...periodBounds());
  } catch (err) {
    return;   // keep the previous payload on a failed refetch
  }
}

// Collapsible sections: remember open/closed state per section id.
const collapsedSections = new Set();

function sectionCard(id, title, bodyHtml) {
  const collapsed = collapsedSections.has(id);
  return `
    <div class="card mb-3" id="sec-${id}">
      <div class="card-header fw-semibold d-flex align-items-center stats-section-toggle" data-section="${id}" role="button">
        <span>${title}</span>
        <span class="ms-auto small text-muted">${collapsed ? '＋' : '−'}</span>
      </div>
      <div class="card-body ${collapsed ? 'd-none' : ''}">${bodyHtml}</div>
    </div>`;
}

function bindSectionToggles(root) {
  (root || document).querySelectorAll('.stats-section-toggle').forEach(h => {
    h.addEventListener('click', () => {
      const id = h.dataset.section;
      const body = h.parentElement.querySelector('.card-body');
      const nowCollapsed = collapsedSections.has(id);
      if (nowCollapsed) collapsedSections.delete(id);
      else collapsedSections.add(id);
      body.classList.toggle('d-none', !nowCollapsed);
      h.querySelector('span:last-child').textContent = nowCollapsed ? '−' : '＋';
      // Chart.js needs a resize nudge when its container reappears.
      if (!nowCollapsed) {
        for (const c of body.querySelectorAll('canvas')) {
          const ch = window.Chart && window.Chart.getChart(c);
          if (ch) ch.resize();
        }
      }
    });
  });
}

export async function renderStatistics(scope) {
  // Optional scope from the sidebar (#statistics/<sport>): null/undefined
  // keeps the current selection, '' or a sport name sets it.
  if (scope !== undefined) sport = scope || null;
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="container py-3">
      <h4 class="mb-3">Statistics</h4>
      <div id="stats-error" class="alert alert-warning d-none"></div>
      <div id="stats-loading" class="text-muted">Loading statistics…</div>
      <div id="stats-content" class="d-none">
        <div class="d-flex align-items-center gap-2 mb-2 flex-wrap">
          <div class="btn-group" role="group" id="stats-period">
            <button class="btn btn-sm btn-outline-primary" data-period="year">This year</button>
            <button class="btn btn-sm btn-outline-primary" data-period="12m">Last 12 months</button>
            <button class="btn btn-sm btn-outline-primary" data-period="all">All time</button>
            <button class="btn btn-sm btn-outline-primary" data-period="custom">Custom</button>
          </div>
          <div id="stats-custom-dates" class="d-flex gap-2 align-items-center d-none">
            <input type="date" id="stats-custom-from" class="form-control form-control-sm w-auto">
            <span class="small text-muted">→</span>
            <input type="date" id="stats-custom-to" class="form-control form-control-sm w-auto">
          </div>
        </div>
        <div class="d-flex gap-2 flex-wrap mb-3" id="stats-sport-chips">
          ${['all', 'cycling', 'running', 'hiking'].map(s => {
            const meta = s === 'all' ? { icon: '🌐', label: 'All' } : sportMeta(s);
            const on = sport === null ? s === 'all' : s === sport;
            return `<button class="btn btn-sm ${on ? 'btn-primary' : 'btn-outline-secondary'} sport-chip" data-sport="${s}">${meta.icon} ${meta.label}</button>`;
          }).join('')}
        </div>
        <div id="stats-summary"></div>
        <div id="stats-athlete" class="mb-3"></div>
        <div id="stats-records"></div>
        <div id="stats-profile"></div>
        <div id="stats-charts"></div>
        <div id="stats-climbs"></div>
        <div id="stats-training"></div>
      </div>
    </div>
  `;

  try {
    statsData = await fetchStats(sport, ...periodBounds());
  } catch (err) {
    document.getElementById('stats-loading').classList.add('d-none');
    const errEl = document.getElementById('stats-error');
    errEl.textContent = 'Could not load statistics. Is the server running?';
    errEl.classList.remove('d-none');
    return;
  }
  document.getElementById('stats-loading').classList.add('d-none');
  document.getElementById('stats-content').classList.remove('d-none');

  document.querySelectorAll('#stats-period button').forEach(btn => {
    btn.addEventListener('click', async () => {
      const p = btn.dataset.period;
      if (p === period) return;
      period = p;
      document.getElementById('stats-custom-dates').classList.toggle('d-none', period !== 'custom');
      await refetchStats();
      renderAll();
    });
  });
  document.getElementById('stats-custom-from').addEventListener('change', async e => {
    customFrom = e.target.value || null;
    if (period === 'custom') { await refetchStats(); renderAll(); }
  });
  document.getElementById('stats-custom-to').addEventListener('change', async e => {
    customTo = e.target.value || null;
    if (period === 'custom') { await refetchStats(); renderAll(); }
  });
  document.getElementById('stats-sport-chips').addEventListener('click', async (e) => {
    const chip = e.target.closest('.sport-chip');
    if (!chip) return;
    const val = chip.dataset.sport;
    const next = val === 'all' ? null : val;
    if (next === sport) return;
    sport = next;
    document.querySelectorAll('#stats-sport-chips .sport-chip').forEach(c => {
      const on = c.dataset.sport === (sport === null ? 'all' : sport);
      c.className = `btn btn-sm ${on ? 'btn-primary' : 'btn-outline-secondary'} sport-chip`;
    });
    document.getElementById('stats-content').classList.add('d-none');
    document.getElementById('stats-loading').classList.remove('d-none');
    try {
      statsData = await fetchStats(sport, ...periodBounds());
    } catch (err) {
      document.getElementById('stats-loading').classList.add('d-none');
      const errEl = document.getElementById('stats-error');
      errEl.textContent = 'Could not load statistics.';
      errEl.classList.remove('d-none');
      return;
    }
    document.getElementById('stats-loading').classList.add('d-none');
    document.getElementById('stats-content').classList.remove('d-none');
    renderAll();
  });
  renderAll();
}

function renderAll() {
  document.querySelectorAll('#stats-period button').forEach(btn => {
    btn.classList.toggle('btn-primary', btn.dataset.period === period);
    btn.classList.toggle('btn-outline-primary', btn.dataset.period !== period);
  });
  document.getElementById('stats-custom-dates').classList.toggle('d-none', period !== 'custom');
  renderSummary();
  renderAthlete();
  // Records & best efforts mix sports in the Overall scope (cycling
  // climbs next to running PRs with no way to compare them); sport
  // chips give the per-sport record pages.
  if (sport === null) {
    document.getElementById('stats-records').innerHTML = '';
  } else {
    renderRecords();
  }
  // Climb profile + climbing records are cycling-only sections; the
  // Overall page mixes sports, so they stay off it entirely.
  if (sport === 'cycling') {
    renderProfileHtml();
    mountProfileChart();
  } else {
    document.getElementById('stats-profile').innerHTML = '';
  }
  renderCharts();
  const climbsEl = document.getElementById('stats-climbs');
  if (sport === 'cycling') {
    renderClimbs();
  } else if (climbsEl) {
    climbsEl.innerHTML = '';
  }
  renderTrainingSections();
  attachFullscreenToStats();
}

// Fullscreen for every stats chart. Charts whose card body carries
// controls (axis selects, regression toggles, year checkboxes) float the
// whole card body so the options stay usable in fullscreen; plain charts
// float just their sized wrapper.
function attachFullscreenToStats() {
  const ids = ['stats-profile-chart', 'stats-monthly-chart',
    'stats-categories-chart', 'stats-weather-chart', 'stats-yoy-chart', 'stats-hr-pace-chart',
    'stats-grade-hr-chart'];
  for (const id of ids) {
    const canvas = document.getElementById(id);
    if (!canvas || !canvas.parentElement) continue;
    const card = canvas.closest('.card');
    if (card && card.querySelector('.card-header')) {
      const body = card.querySelector('.card-body');
      // Controls live in the card body next to the chart (weather, yoy,
      // hr-pace): float the body. For charts alone, the sized wrapper is
      // enough and keeps the overlay purely chart.
      const controlHost = body && body.querySelector('select, input[type="checkbox"]');
      attachFullscreen(card, controlHost ? body : canvas.parentElement);
    } else {
      // Categories chart: no card header — put the button on its h6 heading.
      const head = canvas.previousElementSibling;
      if (head) attachFullscreen(null, canvas.parentElement, { headerEl: head });
    }
  }
}

let profileChart = null;

// Climbing profile: how hard you can climb vs how long the effort lasts.
// Each point is one climb: x = duration, y = VAM (vertical metres per hour).
// The fitted curve VAM = V0 + K/T^b on the robust per-band envelope is the
// climbing equivalent of a power-duration curve. The lower envelope
// (steady-pace floor) completes the picture: Climbfinder-style, your rides
// live between "what you can do" and "what you normally do".
function renderProfile() {
  renderProfileHtml();
  mountProfileChart();
}

function renderProfileHtml() {
  const el = document.getElementById('stats-profile');
  el.innerHTML = sectionCard('profile', 'Climbing profile — VAM vs duration', `
        <p class="text-muted small mb-2">
          Every climb you have done (≥50 m ascent, ≥2 min) as a dot: how fast you
          climbed vertically (VAM) against how long it took. The red curve is your
          <strong>envelope</strong> — the VAM you can reach on a best effort — and the
          grey curve your <strong>steady pace</strong> floor. Like a power curve, but
          for climbing. Compare periods with the buttons above the chart.
        </p>
        <div style="height: 320px"><canvas id="stats-profile-chart"></canvas></div>`);
  bindSectionToggles(el);
}

function mountProfileChart() {
  const occ = statsData.climb_occurrences || [];
  const pts = [];
  for (const o of occ) {
    const T = o.elapsed_time_s, v = o.vam, H = o.elevation_gain_m, D = o.length_m;
    if (!T || !v || !H || !D) continue;
    if (T < 120 || T > 3 * 3600 || H < 50 || D < 500) continue;
    pts.push({ t: T / 60, vam: v, name: o.validated_name || o.key, when: o.start_time || '' });
  }
  pts.sort((a, b) => (a.when < b.when ? -1 : 1));

  if (pts.length < 3) return;

  const BANDS = [
    { lo: 2, hi: 5 }, { lo: 5, hi: 10 }, { lo: 10, hi: 20 },
    { lo: 20, hi: 40 }, { lo: 40, hi: 90 }, { lo: 90, hi: 240 },
  ];

  const pctile = (vs, p) => {
    const s = [...vs].sort((a, b) => a - b);
    const k = (s.length - 1) * p, f = Math.floor(k);
    return s[f] + (s[Math.min(f + 1, s.length - 1)] - s[f]) * (k - f);
  };

  // Envelope: 90th percentile VAM per duration band — robust to one freak
  // climb, tracks fitness better than a raw max. Steady floor: 25th pctile.
  const bandPts = (list, p) => {
    const out = [];
    for (const b of BANDS) {
      const inBand = list.filter(q => q.t >= b.lo && q.t < b.hi);
      if (inBand.length >= 2) out.push({ t: (b.lo + b.hi) / 2, vam: pctile(inBand.map(q => q.vam), p) });
    }
    return out;
  };

  // Critical-power style fit: VAM = V0 + K/T^b. Flattens to a nonzero
  // sustainable VAM instead of decaying to 0. Grid search over the exponent
  // b, V0 and K solved by linear regression per b; needs V0 > 0, K > 0.
  const fitCp = (data) => {
    if (data.length < 3) return null;
    const n = data.length;
    let bestSse = null, bestCp = null;
    for (let b100 = 30; b100 <= 400; b100 += 2) {
      const bExp = b100 / 100;
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (const p of data) {
        const x = Math.pow(p.t, -bExp), y = p.vam;
        sx += x; sy += y; sxx += x * x; sxy += x * y;
      }
      const den = n * sxx - sx * sx;
      if (den <= 1e-12) continue;
      const K = (n * sxy - sx * sy) / den;
      const V0 = (sy - K * sx) / n;
      if (K <= 0 || V0 <= 0) continue;
      let sse = 0;
      for (const p of data) {
        const e = p.vam - (V0 + K * Math.pow(p.t, -bExp));
        sse += e * e;
      }
      if (bestSse == null || sse < bestSse) { bestSse = sse; bestCp = { V0, K, b: bExp }; }
    }
    return bestCp;
  };

  const scope = period === 'all' ? pts : pts.filter(p => inMonth(p.when, periodRange(monthKey(statsData.activities[statsData.activities.length - 1].start_time))));
  const env = fitCp(bandPts(scope, 0.9));
  const floor = fitCp(bandPts(scope, 0.25));
  // Trend: envelope fit on the chronologically first vs last third of the
  // scoped history — shows whether your capability improved or declined.
  let trendUp = null, trendDown = null, trendPct = null;
  if (scope.length >= 12) {
    const third = Math.floor(scope.length / 3);
    const early = fitCp(bandPts(scope.slice(0, third), 0.9));
    const late = fitCp(bandPts(scope.slice(-third), 0.9));
    if (early && late && early.V0 > 0) {
      trendUp = late; trendDown = early;
      trendPct = ((late.V0 - early.V0) / early.V0) * 100;
    }
  }

  const curveData = (fit, tMin, tMax, nPts = 60) => {
    const out = [];
    if (!fit) return out;
    for (let i = 0; i <= nPts; i++) {
      const t = tMin * Math.pow(tMax / tMin, i / nPts);
      out.push({ x: t, y: fit.V0 + fit.K / Math.pow(t, fit.b) });
    }
    return out;
  };
  const tMin = Math.max(2, Math.min(...pts.map(p => p.t)));
  const tMax = Math.max(...pts.map(p => p.t));

  const ctx = document.getElementById('stats-profile-chart').getContext('2d');
  if (profileChart) profileChart.destroy();
  const scatter = (color, data, label, extra = {}) => ({
    type: 'scatter', label, data,
    backgroundColor: color, pointRadius: 4, pointHoverRadius: 6, ...extra
  });

  const trendLabel = trendUp
    ? `Recent form (sustainable VAM ${trendPct >= 0 ? '+' : ''}${trendPct.toFixed(0)}% vs early years)`
    : null;

  // Alternating background bands so the duration bands are readable.
  // Drawn in a beforeDraw plugin: afterBuildTicks fires too early and the
  // chart render wipes anything drawn there.
  const bandBackground = {
    id: 'bandBackground',
    beforeDraw(chart) {
      const { ctx: ctx2, chartArea, scales: { x } } = chart;
      if (!chartArea) return;
      // Theme-aware band tints: lighten on dark themes, darken on light ones.
      const dark = document.documentElement.getAttribute('data-bs-theme') === 'dark';
      const tints = dark
        ? ['rgba(255, 255, 255, 0.10)', 'rgba(255, 255, 255, 0.04)']
        : ['rgba(0, 0, 0, 0.10)', 'rgba(0, 0, 0, 0.04)'];
      ctx2.save();
      let bandIndex = 0;
      for (const b of BANDS) {
        const x1 = Math.max(x.getPixelForValue(b.lo), chartArea.left);
        const x2 = Math.min(x.getPixelForValue(Math.min(b.hi, x.max)), chartArea.right);
        if (x2 <= chartArea.left) continue;
        ctx2.fillStyle = tints[bandIndex % 2];
        ctx2.fillRect(x1, chartArea.top, x2 - x1, chartArea.bottom - chartArea.top);
        bandIndex++;
      }
      ctx2.restore();
    }
  };

  profileChart = new window.Chart(ctx, {
    type: 'scatter',
    data: {
      datasets: [
        ...(env ? [{
          type: 'line', label: `Envelope — best effort (sustainable ≈ ${Math.round(env.V0)} m/h)`,
          data: curveData(env, tMin, tMax),
          borderColor: 'rgba(220, 53, 69, 0.9)', backgroundColor: 'transparent',
          pointRadius: 0, borderWidth: 2, tension: 0
        }] : []),
        ...(floor ? [{
          type: 'line', label: 'Steady-pace floor',
          data: curveData(floor, tMin, tMax),
          borderColor: 'rgba(108, 117, 125, 0.8)', backgroundColor: 'transparent',
          borderDash: [6, 4], pointRadius: 0, borderWidth: 1.5, tension: 0
        }] : []),
        ...(trendUp ? [{
          type: 'line', label: trendLabel,
          data: curveData(trendUp, tMin, tMax),
          borderColor: trendPct >= 0 ? 'rgba(25, 135, 84, 0.9)' : 'rgba(255, 193, 7, 0.9)',
          backgroundColor: 'transparent', borderDash: [2, 3], pointRadius: 0, borderWidth: 1.5, tension: 0
        }] : []),
        scatter('rgba(13, 110, 253, 0.45)', pts.map(p => ({ x: p.t, y: p.vam })), 'All climbs'),
        ...(scope.length && scope.length < pts.length ? [scatter('rgba(13, 110, 253, 0.9)', scope.map(p => ({ x: p.t, y: p.vam })), 'Selected period', { pointRadius: 5 })] : []),
      ].filter(Boolean),
    },
    plugins: [bandBackground],
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: false },
      plugins: {
        legend: { labels: { boxWidth: 12, usePointStyle: false } },
        tooltip: {
          callbacks: {
            label: (c) => {
              const m = Math.round(c.parsed.x);
              const h = Math.floor(m / 60);
              const label = h ? `${h}h${String(m % 60).padStart(2, '0')}m` : `${m}m`;
              return `${c.dataset.label}: ${label} at ${Math.round(c.parsed.y)} m/h`;
            }
          }
        }
      },
      scales: {
        x: {
          type: 'logarithmic', min: 2,
          title: { display: true, text: 'Climb duration (minutes, log scale)' },
          ticks: { callback: (v) => ([2, 5, 10, 20, 60, 120, 240].includes(+v) ? v : null) }
        },
        y: {
          title: { display: true, text: 'VAM (vertical m/hour)' },
          beginAtZero: true
        },
      }
    }
  });
}

function delta(current, previous) {
  if (previous == null || previous === 0) return null;
  const pct = ((current - previous) / previous) * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(0)}%`;
}

// Athlete resume card (Overall scope only): profile stats, all-time
// totals, per-sport breakdown and the year-to-date line. Used to sit in
// the sidebar; moved here so the sidebar stays a slim navigator.
let profileCache = null;

async function renderAthlete() {
  const holder = document.getElementById('stats-athlete');
  if (!holder) return;
  if (sport !== null) { holder.innerHTML = ''; return; }
  if (!profileCache) {
    try {
      profileCache = await fetchProfile();
    } catch (e) {
      profileCache = { athlete: {}, all_time: {}, ytd: {}, per_sport: {} };
    }
  }
  const athlete = profileCache.athlete || {};
  const all = profileCache.all_time || {};
  const ytd = profileCache.ytd || {};
  const perSport = profileCache.per_sport || {};

  const rawName = athlete.email ? athlete.email.split('@')[0] : 'Athlete';
  const displayName = rawName
    .replace(/[._]/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  const profileStats = [
    { label: 'Age', value: athlete.age ? athlete.age + ' yrs' : '-' },
    { label: 'Country', value: athlete.country || '-' },
    { label: 'Weight', value: athlete.weight_kg ? athlete.weight_kg + ' kg' : '-' },
    { label: 'Height', value: athlete.height_cm ? athlete.height_cm + ' cm' : '-' },
    { label: 'VO₂max', value: athlete.vo2max ? athlete.vo2max : '-' },
    { label: 'LTHR', value: athlete.lactate_threshold_hr ? Math.round(athlete.lactate_threshold_hr) + ' bpm' : '-' },
  ];
  const profileStatsHtml = profileStats.map(s => `
    <div class="col-6 col-md-2">
      <div class="border rounded p-2 text-center">
        <div class="stat-value" style="font-size:.95rem;">${s.value}</div>
        <div class="stat-label" style="font-size:.6rem;">${s.label}</div>
      </div>
    </div>
  `).join('');

  const totals = [
    { label: 'Activities', value: all.rides || 0 },
    { label: 'Distance', value: fmtDistance(all.distance_km) },
    { label: 'Moving time', value: fmtDuration(all.moving_time_s) },
    { label: 'Ascent', value: fmtElevation(all.ascent_m) },
    { label: 'Climbs', value: all.climbs || 0 },
  ];
  const totalsHtml = totals.map(s => `
    <li class="list-group-item d-flex justify-content-between"><span>${s.label}</span><strong>${s.value}</strong></li>
  `).join('');

  const perSportHtml = Object.entries(perSport).map(([s, d]) => {
    const meta = sportMeta(s);
    return `<li class="list-group-item d-flex justify-content-between"><span>${meta.icon} ${meta.label}</span><strong>${d.activities} · ${fmtDistance(d.distance_km)}</strong></li>`;
  }).join('');

  holder.innerHTML = `
    <div class="card">
      <div class="card-body pb-2">
        <div class="d-flex align-items-center gap-2 mb-2">
          <div class="rounded-circle bg-secondary text-white d-inline-flex align-items-center justify-content-center flex-shrink-0" style="width:48px;height:48px;font-size:1.2rem;font-weight:600;">${displayName.charAt(0).toUpperCase()}</div>
          <h5 class="mb-0">${displayName}</h5>
        </div>
        <div class="row g-2">${profileStatsHtml}</div>
      </div>
      <div class="row g-0">
        <div class="col-md-6">
          <ul class="list-group list-group-flush small mb-0">${totalsHtml}</ul>
        </div>
        <div class="col-md-6">
          <ul class="list-group list-group-flush small mb-0">${perSportHtml}</ul>
        </div>
      </div>
      <div class="card-footer small text-muted">
        This year: ${ytd.rides || 0} activities · ${fmtDistance(ytd.distance_km)} · ${fmtElevation(ytd.ascent_m)}
      </div>
    </div>`;
}

function renderSummary() {
  const acts = statsData.activities;
  const now = monthKey(acts.length ? acts[acts.length - 1].start_time : '');
  const first = monthKey(acts.length ? acts[0].start_time : '');
  const range = periodRange(now, first);
  const prev = previousRange(now);

  const inPeriod = acts.filter(a => inMonth(a.start_time, range));
  const inPrev = prev ? acts.filter(a => inMonth(a.start_time, prev)) : [];
  const total = (list, key) => list.reduce((s, a) => s + (a[key] || 0), 0);

  // Cycling scope keeps the original "Rides" vocabulary; other scopes are
  // sport-neutral ("Activities").
  const unitNoun = unitLabel();

  const tiles = [
    { label: unitNoun, value: inPeriod.length, prev: inPrev.length },
    { label: 'Distance', value: fmtDistance(total(inPeriod, 'distance')), prev: prev ? total(inPrev, 'distance') : null, raw: total(inPeriod, 'distance'), rawPrev: prev ? total(inPrev, 'distance') : null },
    { label: 'Elevation', value: fmtElevation(total(inPeriod, 'ascent')), raw: total(inPeriod, 'ascent'), rawPrev: prev ? total(inPrev, 'ascent') : null },
    { label: 'Time', value: fmtDuration(total(inPeriod, 'moving_time')), raw: total(inPeriod, 'moving_time'), rawPrev: prev ? total(inPrev, 'moving_time') : null },
    { label: 'Calories', value: Math.round(total(inPeriod, 'calories')).toLocaleString(), raw: total(inPeriod, 'calories'), rawPrev: prev ? total(inPrev, 'calories') : null },
  ];

  let biggest = null;
  for (const a of inPeriod) {
    if (!biggest || (a.distance || 0) > (biggest.distance || 0)) biggest = a;
  }

  // Week (ISO yyyy-Www) with the most climb elevation in the period.
  const weekOf = t => {
    const d = new Date(t);
    const day = (d.getUTCDay() + 6) % 7;   // Monday = 0
    d.setUTCDate(d.getUTCDate() - day);
    const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    const week1 = new Date(Date.UTC(jan4.getUTCFullYear(), 0, 4 - ((jan4.getUTCDay() + 6) % 7)));
    const w = Math.floor((d - week1) / (7 * 24 * 3600 * 1000)) + 1;
    return `${d.getUTCFullYear()}-W${String(w).padStart(2, '0')}`;
  };
  const climbWeeks = {};
  for (const o of statsData.climb_occurrences) {
    if (!inMonth(o.start_time, range)) continue;
    const wk = weekOf(o.start_time);
    climbWeeks[wk] = (climbWeeks[wk] || 0) + (o.elevation_gain_m || 0);
  }
  const bestClimbWeek = Object.entries(climbWeeks).sort((a, b) => b[1] - a[1])[0];
  const avgDistance = inPeriod.length ? total(inPeriod, 'distance') / inPeriod.length : 0;
  const avgDistancePrev = inPrev.length ? total(inPrev, 'distance') / inPrev.length : null;

  const tiles2 = [
    { label: sport === 'cycling' ? 'Avg ride distance' : 'Avg distance per activity', value: fmtDistance(avgDistance), raw: avgDistance || null, rawPrev: avgDistancePrev },
    bestClimbWeek ? { label: `Biggest climb week (${bestClimbWeek[0]})`, value: fmtElevation(bestClimbWeek[1]) } : null,
  ].filter(Boolean);

  document.getElementById('stats-summary').innerHTML = `
    <div class="row g-2 mb-3">
      ${tiles.map(t => `
        <div class="col-6 col-md-4 col-lg-2">
          <div class="card text-center p-2 h-100">
            <div class="stat-value">${t.value}</div>
            <div class="stat-label">${t.label}</div>
            ${t.rawPrev != null && t.raw != null ? `<div class="small ${delta(t.raw, t.rawPrev)?.startsWith('+') ? 'text-success' : 'text-danger'}">${delta(t.raw, t.rawPrev) || ''} vs prev.</div>` : ''}
          </div>
        </div>`).join('')}
    </div>
    <div class="row g-2 mb-2">
      ${tiles2.map(t => `
        <div class="col-6 col-md-4 col-lg-3">
          <div class="card text-center p-2 h-100">
            <div class="stat-value">${t.value}</div>
            <div class="stat-label">${t.label}</div>
          </div>
        </div>`).join('')}
    </div>
    ${biggest ? `
    <div class="row g-2 mb-3">
      <div class="col-12">
        <div class="card p-2">
          <span class="small text-muted">Longest ${sport === 'cycling' ? 'ride' : 'activity'}:</span>
          <a href="#activity/${biggest.activity_id}" class="fw-semibold">${escapeHtml(biggest.name || `Unnamed ${sport === 'cycling' ? 'ride' : 'activity'}`)}</a>
          <span class="small text-muted">${fmtDate(biggest.start_time)} · ${fmtDistance(biggest.distance)} · ${fmtElevation(biggest.ascent)}</span>
        </div>
      </div>
    </div>` : ''}
  `;
}

function renderRecords() {
  const acts = statsData.activities;
  const now = monthKey(acts.length ? acts[acts.length - 1].start_time : '');
  const first = monthKey(acts.length ? acts[0].start_time : '');
  const range = periodRange(now, first);
  const inPeriod = acts.filter(a => inMonth(a.start_time, range));

  const best = (fn) => inPeriod.reduce((acc, a) => {
    const v = fn(a);
    if (v == null) return acc;
    if (!acc || v > acc.v) return { a, v };
    return acc;
  }, null);

  const longest = best(a => a.distance);
  // Biggest ascent = the single biggest climb segment in the period
  // (not the ride's total elevation gain). Filter out noise segments:
  // anything under 50 m of gain is usually GPS wobble.
  const biggestAscentOcc = statsData.climb_occurrences
    .filter(o => inMonth(o.start_time, range) && (o.elevation_gain_m || 0) >= 50)
    .sort((a, b) => b.elevation_gain_m - a.elevation_gain_m)[0] || null;
  const maxHr = best(a => a.max_hr);
  // Biggest climbing day: ascent summed over every ride of the same
  // calendar date (a double day can beat any single ride).
  const byDay = {};
  for (const a of inPeriod) {
    const d = (a.start_time || '').slice(0, 10);
    if (!d) continue;
    byDay[d] = (byDay[d] || 0) + (a.ascent || 0);
  }
  const bestDayEntry = Object.entries(byDay).sort((a, b) => b[1] - a[1])[0];
  const climbing = bestDayEntry
    ? { a: inPeriod.find(a => (a.start_time || '').slice(0, 10) === bestDayEntry[0]), v: bestDayEntry[1] }
    : null;
  const climbsPerRide = {};
  for (const o of statsData.climb_occurrences) {
    if (inMonth(o.start_time, range)) climbsPerRide[o.activity_id] = (climbsPerRide[o.activity_id] || 0) + 1;
  }
  const mostClimbsEntry = Object.entries(climbsPerRide).sort((a, b) => b[1] - a[1])[0];
  const mostClimbs = mostClimbsEntry
    ? { a: inPeriod.find(a => a.activity_id === mostClimbsEntry[0]), v: mostClimbsEntry[1] }
    : null;

  const climbs = statsData.climb_occurrences.filter(o => inMonth(o.start_time, range));
  // Best VAM only over real climbs: VAM is meaningless on tiny or flat
  // segments (the gain/elapsed ratio explodes on 15 m noise segments and
  // dilutes on segments that include flat run-outs).
  const vamCandidates = climbs.filter(o =>
    o.vam && (o.elevation_gain_m || 0) >= 50 && (o.length_m || 0) >= 500);
  const sortedVam = vamCandidates.slice().sort((a, b) => b.vam - a.vam);
  const bestVam = sortedVam.length ? { o: sortedVam[0], v: sortedVam[0].vam } : null;

  const cyclingSelected = sport === null || sport === 'cycling';
  const paceSport = sport === 'running' || sport === 'hiking';
  // Best pace = fastest speed (lowest min/km): max avg_speed, shown as pace.
  // The biggest climb segment is cycling data; other sports have none.
  const fastest = best(a => {
    if (paceSport) return (a.distance >= 5 && a.avg_speed) ? a.avg_speed : null;
    return (a.distance >= 20 && a.avg_speed) ? a.avg_speed : null;
  });
  const rows = [
    longest && { label: sport === 'cycling' ? 'Longest ride' : 'Longest activity', a: longest.a, text: fmtDistance(longest.v) },
    cyclingSelected && biggestAscentOcc && {
      label: 'Biggest ascent',
      a: { activity_id: biggestAscentOcc.activity_id },
      text: `${fmtElevation(biggestAscentOcc.elevation_gain_m)} · ${escapeHtml(biggestAscentOcc.validated_name || biggestAscentOcc.category || 'Unnamed climb')}`,
      climbKey: climbKey(biggestAscentOcc.activity_id, biggestAscentOcc.start_distance_m, biggestAscentOcc.end_distance_m),
    },
    climbing && { label: cyclingSelected ? 'Biggest climbing day' : 'Biggest ascent day', a: climbing.a, text: fmtElevation(climbing.v) },
    fastest && {
      label: paceSport ? 'Best avg pace (5 km+)' : 'Fastest avg speed (20 km+)',
      a: fastest.a,
      text: paceSport ? fmtPace(fastest.v) : fmtSpeed(fastest.v),
    },
    maxHr && { label: 'Max heart rate', a: maxHr.a, text: fmtHr(maxHr.v) },
    cyclingSelected && bestVam && { label: 'Best VAM climb', a: { activity_id: bestVam.o.activity_id }, text: `${Math.round(bestVam.o.vam)} m/h · ${escapeHtml(bestVam.o.validated_name || bestVam.o.category || 'Unnamed')}`, climbKey: climbKey(bestVam.o.activity_id, bestVam.o.start_distance_m, bestVam.o.end_distance_m) },
    cyclingSelected && mostClimbs && { label: sport === 'cycling' ? 'Most climbs in one ride' : 'Most climbs in one activity', a: mostClimbs.a, text: `${mostClimbs.v}` },
  ].filter(Boolean);
  document.getElementById('stats-records').innerHTML = rows.length ? `
    ${sectionCard('records', `Personal records — ${escapeHtml(range.label)}`, `
        <table class="table table-sm mb-0">
          <tbody>
            ${rows.map(r => `
              <tr>
                <td class="text-muted ps-3">${r.label}</td>
                <td class="fw-semibold">${r.text}</td>
                <td class="text-end pe-3">${r.a.start_time ? fmtDate(r.a.start_time) : ''} ${r.climbKey ? `<a href="#climb/${r.climbKey}" class="ms-2 small">view</a>` : (r.a.activity_id ? `<a href="#activity/${r.a.activity_id}" class="ms-2 small">view</a>` : '')}</td>
              </tr>`).join('')}
          </tbody>
        </table>`)}
    ${renderBestEfforts(inPeriod)}
  ` : '';
  bindSectionToggles(document.getElementById('stats-records'));
}

function renderBestEfforts(inPeriod) {
  const efforts = statsData.best_efforts || {};
  const labels = { 8047: '5 mile', 10000: '10K', 16093: '10 mile', 20000: '20K', 30000: '30K', 40000: '40K', 50000: '50K', 80000: '80K', 80467: '50 mile', 90000: '90K', 100000: '100K',
                   1000: '1K', 1609: '1 mile', 5000: '5K', 21097: 'Half marathon', 42195: 'Marathon' };
  const usesPace = sport === 'running' || sport === 'hiking';
  // Per distance, best time among rides in the period.
  const byId = {};
  for (const a of inPeriod) byId[a.activity_id] = a;
  const best = {};
  for (const [aid, eff] of Object.entries(efforts)) {
    const act = byId[aid];
    if (!act) continue;
    for (const [dM, t] of Object.entries(eff)) {
      const d = Number(dM);
      if (!best[d] || t < best[d].t) best[d] = { t, act };
    }
  }
  const dists = Object.keys(best).map(Number).sort((a, b) => a - b);
  const rowsEff = dists.filter(d => best[d]).map(d => `
    <tr>
      <td class="ps-3">${labels[d] || (d === 1609 ? '1 mile' : (d / 1000).toFixed(d < 10000 ? 1 : 0) + 'K')}</td>
      <td class="fw-semibold">${fmtDuration(best[d].t)}</td>
      <td>${usesPace ? fmtPace(d / best[d].t * 3.6) : fmtSpeed(d / best[d].t * 3.6)}</td>
      <td class="text-end pe-3">${fmtDate(best[d].act.start_time)} <a href="#activity/${best[d].act.activity_id}" class="ms-2 small">view</a></td>
    </tr>`);
  if (!rowsEff.length) return '';
  const periodLabel = periodRange(monthKey(statsData.activities.length ? statsData.activities[statsData.activities.length - 1].start_time : ''),
    monthKey(statsData.activities.length ? statsData.activities[0].start_time : '')).label;
  return sectionCard('best-efforts', `Best efforts — ${escapeHtml(periodLabel)}`, `
        <table class="table table-sm mb-0">
          <thead><tr><th>Distance</th><th>Time</th><th>Avg ${usesPace ? 'pace' : 'speed'}</th><th class="text-end pe-3">Date</th></tr></thead>
          <tbody>${rowsEff.join('')}</tbody>
        </table>`);
}

function renderCharts() {
  const acts = statsData.activities;
  const now = monthKey(acts.length ? acts[acts.length - 1].start_time : '');
  const first = monthKey(acts.length ? acts[0].start_time : '');
  const range = periodRange(now, first);
  const isAllTime = period === 'all';

  // Aggregate per month over the selected period (or all data for 'all').
  const scope = isAllTime ? { start: monthKey(acts[0].start_time), end: now } : range;
  const months = monthsBetween(scope.start, scope.end);
  const perMonth = {};
  for (const m of months) perMonth[m] = { distance: 0, ascent: 0, count: 0, time: 0, calories: 0, hr: [], speed: [], cadence: [] };
  for (const a of acts) {
    const m = monthKey(a.start_time);
    if (!perMonth[m]) continue;
    perMonth[m].distance += a.distance || 0;
    perMonth[m].ascent += a.ascent || 0;
    perMonth[m].count += 1;
    perMonth[m].time += a.moving_time || 0;
    perMonth[m].calories += a.calories || 0;
    if (a.avg_hr) perMonth[m].hr.push(a.avg_hr);
    if (a.avg_speed) perMonth[m].speed.push(a.avg_speed);
    if (a.avg_cadence) perMonth[m].cadence.push(a.avg_cadence);
  }

  // For all time, charts average per calendar month (Jan..Dec) across
  // years, so adding more years never widens the chart.
  const CAL_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let labels, distKm, ascentM, rideCounts;
  if (isAllTime) {
    const years = new Set(months.map(m => m.slice(0, 4)));
    const nYears = Math.max(1, years.size);
    const byCal = {};
    for (const m of months) {
      const cm = m.slice(5, 7);
      byCal[cm] = byCal[cm] || { dist: 0, asc: 0, count: 0 };
      byCal[cm].count += perMonth[m].count;
      byCal[cm].dist += perMonth[m].distance;
      byCal[cm].asc += perMonth[m].ascent;
    }
    labels = CAL_MONTHS;
    distKm = CAL_MONTHS.map((_, i) => {
      const e = byCal[String(i + 1).padStart(2, '0')];
      return e ? e.dist / nYears : 0;
    });
    ascentM = CAL_MONTHS.map((_, i) => {
      const e = byCal[String(i + 1).padStart(2, '0')];
      return e ? e.asc / nYears : 0;
    });
    rideCounts = CAL_MONTHS.map((_, i) => {
      const e = byCal[String(i + 1).padStart(2, '0')];
      return e ? e.count / nYears : 0;
    });
  } else {
    labels = months;
    distKm = months.map(m => perMonth[m].distance);
    ascentM = months.map(m => perMonth[m].ascent);
    rideCounts = months.map(m => perMonth[m].count);
  }

  const monthlyTitle = isAllTime ? 'Average distance &amp; elevation per calendar month' : 'Distance &amp; elevation per month';
  const unitWord = sport === 'cycling' ? 'rides' : 'activities';

  document.getElementById('stats-charts').innerHTML = `
    ${sectionCard('monthly', monthlyTitle, `
        <div style="height: 280px; position: relative;"><canvas id="stats-monthly-chart"></canvas></div>`)}
    ${sectionCard('calendar', 'Activity calendar', `
        <div id="calendar-heatmap" class="overflow-x-auto"></div>
        <p class="small text-muted mb-0 mt-2" id="calendar-note">Hover a day for details.</p>`)}
    <div id="stats-gps-heat"></div>
    <div id="stats-hr-pace"></div>
    <div id="stats-grade-hr"></div>
    <div id="stats-vo2"></div>
    <div id="stats-extras"></div>
    <div id="stats-weather"></div>
    <div id="stats-yoy"></div>
  `;
  bindSectionToggles(document.getElementById('stats-charts'));

  renderExtras(acts, range);
  renderCalendar(acts);
  renderGpsHeatmap();
  renderGradeHr();
  renderHrPace(acts);
  renderVo2();
  // Weather correlation is a single-sport analysis; on the Overall page
  // the dots would mix incomparable sports. Foot sports have no
  // meaningful temperature × altitude speed model either.
  const weatherHolder = document.getElementById('stats-weather');
  if (sport === null || isPaceSport()) weatherHolder.innerHTML = '';
  else renderWeather(acts);
  renderYoY(acts);

  // Monthly distance + elevation bars, with the activity count as a
  // line on its own right axis (merged: the count alone carried little).
  if (monthlyChart) monthlyChart.destroy();
  monthlyChart = new window.Chart(document.getElementById('stats-monthly-chart').getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Distance (km)',
          data: distKm,
          backgroundColor: 'rgba(13, 110, 253, 0.7)',
          yAxisID: 'yDist',
          order: 3,
        },
        {
          label: 'Elevation (m)',
          data: ascentM,
          backgroundColor: 'rgba(25, 135, 84, 0.55)',
          yAxisID: 'yElev',
          order: 3,
        },
        {
          label: unitLabel(),
          data: rideCounts.map(v => Number.isFinite(v) ? v : 0),
          type: 'line',
          borderColor: 'rgba(111, 66, 193, 0.9)',
          backgroundColor: 'rgba(111, 66, 193, 0.9)',
          borderWidth: 2,
          pointRadius: 2,
          tension: 0.3,
          yAxisID: 'yCount',
          order: 1,
        },
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: true, labels: { boxWidth: 12 } } },
      scales: {
        x: { stacked: false, ticks: { maxRotation: 45 } },
        yDist: { position: 'left', title: { display: true, text: 'Distance (km)' } },
        yElev: { position: 'right', title: { display: true, text: 'Elevation (m)' }, grid: { drawOnChartArea: false } },
        yCount: { position: 'right', title: { display: true, text: unitLabel() }, grid: { drawOnChartArea: false }, ticks: { precision: 0 } },
      }
    }
  });

  // HR zone donut + HR/pace trend card removed (redundant with the
  // per-activity data elsewhere on the page).
}

// Normalized HR and training load moved to the Training page (fitness
// trends live there); normHrOf is shared via this export.
export function normHrOf(a, norm) {
  if (!a.avg_hr) return null;
  let correction = 0;
  for (const p of norm.predictors) {
    let v;
    if (p === 'climb_intensity') {
      if (!a.distance || a.ascent == null) return null;
      v = a.ascent / a.distance;
    } else if (p === 'temp_dev') {
      if (a.avg_temperature == null) continue;   // no correction possible
      v = a.avg_temperature - 20;
    } else if (p === 'altitude_km') {
      if (a.avg_altitude == null) continue;       // no correction possible
      v = a.avg_altitude / 1000;
    } else {
      return null;
    }
    correction += norm.coef[p] * (v - norm.means[p]);
  }
  return a.avg_hr - correction;
}

function renderExtras(acts, range) {
  document.getElementById('stats-extras').innerHTML = '';
}

function renderClimbs() {
  const occs = statsData.climb_occurrences;
  const acts = statsData.activities;
  const now = monthKey(acts.length ? acts[acts.length - 1].start_time : '');
  const first = monthKey(acts.length ? acts[0].start_time : '');
  const range = periodRange(now, first);
  const inPeriod = occs.filter(o => inMonth(o.start_time, range));

  const totalGain = inPeriod.reduce((s, o) => s + (o.elevation_gain_m || 0), 0);

  const catOrder = ['HC', 'Cat 1', 'Cat 2', 'Cat 3', 'Cat 4'];
  const catColors = { 'HC': '#dc3545', 'Cat 1': '#fd7e14', 'Cat 2': '#ffc107', 'Cat 3': '#20c997', 'Cat 4': '#198754', 'Uncategorized': '#adb5bd' };
  const catCounts = {};
  for (const o of inPeriod) catCounts[o.category] = (catCounts[o.category] || 0) + 1;

  // Hardest = highest category then avg grade
  const rank = c => { const i = catOrder.indexOf(c); return i === -1 ? 99 : i; };
  const hardest = inPeriod.reduce((acc, o) => {
    if (!acc) return o;
    if (rank(o.category) < rank(acc.category)) return o;
    if (rank(o.category) === rank(acc.category) && (o.avg_grade_percent || 0) > (acc.avg_grade_percent || 0)) return o;
    return acc;
  }, null);

  // Favorite = most repeated group
  const groupCount = {};
  for (const o of inPeriod) {
    if (!o.group_id) continue;
    groupCount[o.group_id] = (groupCount[o.group_id] || 0) + 1;
  }
  const favGroup = Object.entries(groupCount).sort((a, b) => b[1] - a[1])[0];
  const favOcc = favGroup ? inPeriod.find(o => o.group_id === favGroup[0] && o.validated_name) || inPeriod.find(o => o.group_id === favGroup[0]) : null;

  // Hardest 10: category first (HC hardest), then average grade, then length.
  const hardness = o => {
    const r = rank(o.category);
    const catScore = r === 99 ? -60 : -r * 10;
    return catScore + (o.avg_grade_percent || 0) + (o.length_m || 0) / 100000;
  };
  const hardest10 = inPeriod
    .slice()
    .sort((a, b) => hardness(b) - hardness(a))
    .slice(0, 10);

  document.getElementById('stats-climbs').innerHTML = sectionCard('climbs', `Climbs — ${escapeHtml(range.label)}`, `
        <div class="row g-2 mb-3">
          <div class="col-6 col-md-3"><div class="card text-center p-2"><div class="stat-value">${inPeriod.length}</div><div class="stat-label">Climbs</div></div></div>
          <div class="col-6 col-md-3"><div class="card text-center p-2"><div class="stat-value">${fmtElevation(totalGain)}</div><div class="stat-label">Elevation in climbs</div></div></div>
          <div class="col-6 col-md-3"><div class="card text-center p-2"><div class="stat-value">${hardest ? (hardest.category === 'Uncategorized' ? fmtGradeShort(hardest.avg_grade_percent) : hardest.category) : '—'}</div><div class="stat-label">Hardest climb</div></div></div>
          <div class="col-6 col-md-3"><div class="card text-center p-2"><div class="stat-value">${favOcc ? escapeHtml(favOcc.validated_name || (favOcc.category !== 'Uncategorized' ? favOcc.category : 'Unnamed')) : '—'}</div><div class="stat-label">Most repeated (${favGroup ? favGroup[1] : 0}×)</div></div></div>
        </div>
        <div class="row g-2">
          <div class="col-lg-5">
            <h6 class="small text-muted text-uppercase">Category distribution</h6>
            <div style="height: 200px; position: relative;"><canvas id="stats-categories-chart"></canvas></div>
          </div>
          <div class="col-lg-7">
            <h6 class="small text-muted text-uppercase">Hardest 10 climbs</h6>
            <div class="table-responsive">
              <table class="table table-sm mb-0">
                <thead><tr><th>Climb</th><th>Category</th><th class="text-end">Avg grade</th><th class="text-end">Length</th><th class="text-end">Gain</th></tr></thead>
                <tbody>
                  ${hardest10.map(o => `
                    <tr>
                      <td><a href="#climb/${climbKey(o.activity_id, o.start_distance_m, o.end_distance_m)}" class="text-decoration-none">${escapeHtml(o.validated_name || o.category || 'Unnamed')}</a></td>
                      <td><span class="badge bg-secondary">${o.category || '—'}</span></td>
                      <td class="text-end">${fmtGradeShort(o.avg_grade_percent)}</td>
                      <td class="text-end">${(o.length_m / 1000).toFixed(1)} km</td>
                      <td class="text-end">${fmtElevation(o.elevation_gain_m)}</td>
                    </tr>`).join('') || '<tr><td colspan="5" class="text-muted">No climbs in this period.</td></tr>'}
                </tbody>
              </table>
            </div>
          </div>
        </div>`);
  bindSectionToggles(document.getElementById('stats-climbs'));

  if (categoriesChart) categoriesChart.destroy();
  categoriesChart = new window.Chart(document.getElementById('stats-categories-chart').getContext('2d'), {
    type: 'bar',
    data: {
      labels: [...catOrder, 'Uncategorized'].filter(c => catCounts[c]),
      datasets: [{ label: 'Climbs', data: [...catOrder, 'Uncategorized'].filter(c => catCounts[c]).map(c => catCounts[c]), backgroundColor: [...catOrder, 'Uncategorized'].filter(c => catCounts[c]).map(c => catColors[c]) }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { x: { beginAtZero: true, ticks: { precision: 0 } } }
    }
  });
}

// Weather correlation: performance vs conditions, one dot per activity.
// Foot sports use pace (min/km) instead of speed.
function renderWeather(acts) {
  const holder = document.getElementById('stats-weather');
  holder.innerHTML = sectionCard('weather', 'Weather correlation', `
        <div class="row g-2 mb-2">
          <div class="col-6 col-md-3">
            <label class="form-label small text-muted">Y axis</label>
            <select id="stats-weather-y" class="form-select form-select-sm">
              <option value="eff" selected>${isPaceSport() ? 'Pace / HR (efficiency)' : 'Speed / HR (efficiency)'}</option>
              <option value="speed">${isPaceSport() ? 'Pace' : 'Speed'}</option>
              <option value="hr">Heart rate</option>
            </select>
          </div>
          <div class="col-6 col-md-3">
            <label class="form-label small text-muted">X axis</label>
            <select id="stats-weather-x" class="form-select form-select-sm">
              <option value="tempAlt" selected>Temperature × altitude</option>
              <option value="temp">Temperature</option>
              <option value="alt">Altitude</option>
            </select>
          </div>
          <div class="col-6 col-md-3 d-flex align-items-end">
            <div class="form-check">
              <input class="form-check-input" type="checkbox" id="stats-weather-regression">
              <label class="form-check-label small" for="stats-weather-regression">Regression line + R²</label>
            </div>
          </div>
        </div>
        <div style="height: 280px; position: relative;"><canvas id="stats-weather-chart"></canvas></div>
        <p class="small text-muted mb-0 mt-2" id="stats-weather-note"></p>`);
  bindSectionToggles(holder);

  const canvas = document.getElementById('stats-weather-chart');
  const note = document.getElementById('stats-weather-note');
  const ySel = document.getElementById('stats-weather-y');
  const xSel = document.getElementById('stats-weather-x');
  const regCheck = document.getElementById('stats-weather-regression');

  const draw = () => {
    const yMode = ySel.value;
    const xMode = xSel.value;
    const showReg = regCheck.checked;
    const foot = isPaceSport();
    const paceOf = v => (v && v > 0) ? 3600 / v : null;   // km/h → min/km

    const yDefs = foot ? {
      eff:   { value: a => paceOf(a.avg_speed) / a.avg_hr, needs: ['avg_speed', 'avg_hr'], title: 'Pace / HR (min/km per bpm)', fmt: v => v.toFixed(3) },
      speed: { value: a => paceOf(a.avg_speed), needs: ['avg_speed'], title: 'Average pace (min/km)', fmt: v => v.toFixed(2) },
      hr:    { value: a => a.avg_hr, needs: ['avg_hr'], title: 'Average heart rate (bpm)', fmt: v => String(Math.round(v)) },
    } : {
      eff:   { value: a => a.avg_speed / a.avg_hr, needs: ['avg_speed', 'avg_hr'], title: 'Speed / HR (km/h per bpm)', fmt: v => v.toFixed(3) },
      speed: { value: a => a.avg_speed, needs: ['avg_speed'], title: 'Average speed (km/h)', fmt: v => v.toFixed(1) },
      hr:    { value: a => a.avg_hr, needs: ['avg_hr'], title: 'Average heart rate (bpm)', fmt: v => String(Math.round(v)) },
    };
    const xDefs = {
      tempAlt: { value: a => a.avg_temperature * a.avg_altitude, needs: ['avg_temperature', 'avg_altitude'], title: 'Temperature × altitude (°C·m)' },
      temp:    { value: a => a.avg_temperature, needs: ['avg_temperature'], title: 'Average temperature (°C)' },
      alt:     { value: a => a.avg_altitude, needs: ['avg_altitude'], title: 'Average altitude (m)' },
    };
    const Y = yDefs[yMode], X = xDefs[xMode];

    const relevant = acts.filter(a =>
      [...Y.needs, ...X.needs].every(f => a[f] != null));

    if (!relevant.length) {
      if (weatherChart) { weatherChart.destroy(); weatherChart = null; }
      note.textContent = 'No activities with the selected sensors.';
      return;
    }

    relevant.sort((a, b) => X.value(a) - X.value(b));
    const xs = relevant.map(a => X.value(a));
    const ys = relevant.map(a => Y.value(a));

    if (weatherChart) weatherChart.destroy();
    const datasets = [{
      label: 'Activities',
      data: relevant.map((a, i) => ({ x: xs[i], y: ys[i] })),
      backgroundColor: 'rgba(13, 110, 253, 0.6)',
      pointRadius: 4,
    }];
    if (showReg && relevant.length >= 2) {
      const n = relevant.length;
      const mx = xs.reduce((s, v) => s + v, 0) / n;
      const my = ys.reduce((s, v) => s + v, 0) / n;
      let sxy = 0, sxx = 0, syy = 0;
      for (let i = 0; i < n; i++) {
        sxy += (xs[i] - mx) * (ys[i] - my);
        sxx += (xs[i] - mx) ** 2;
        syy += (ys[i] - my) ** 2;
      }
      if (sxx > 0) {
        const slope = sxy / sxx;
        const intercept = my - slope * mx;
        const xMin = Math.min(...xs), xMax = Math.max(...xs);
        const r = (sxx && syy) ? sxy / Math.sqrt(sxx * syy) : null;
        datasets.push({
          label: r != null ? `Regression (R² ${(r * r).toFixed(2)})` : 'Regression',
          data: [{ x: xMin, y: slope * xMin + intercept }, { x: xMax, y: slope * xMax + intercept }],
          type: 'line',
          borderColor: '#6c757d',
          borderWidth: 3,
          pointRadius: 0,
          fill: false,
        });
      }
    }
    weatherChart = new window.Chart(canvas, {
      type: 'scatter',
      data: { datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => {
                const a = relevant[ctx.dataIndex];
                const parts = [];
                if (a.avg_temperature != null) parts.push(`${a.avg_temperature}°C`);
                if (a.avg_altitude != null) parts.push(`${Math.round(a.avg_altitude)}m`);
                parts.push(`${Y.fmt(Y.value(a))} ${yMode === 'eff' ? (foot ? 'min/km/bpm' : 'km/h/bpm') : yMode === 'speed' ? (foot ? 'min/km' : 'km/h') : 'bpm'}`);
                parts.push(fmtDate(a.start_time));
                return parts.join(' · ');
              },
            },
          },
        },
        scales: {
          x: { title: { display: true, text: X.title } },
          y: { title: { display: true, text: Y.title }, beginAtZero: false },
        },
      },
    });

    const n = relevant.length;
    const mx = xs.reduce((s, v) => s + v, 0) / n;
    const my = ys.reduce((s, v) => s + v, 0) / n;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i] - mx) * (ys[i] - my);
      dx += (xs[i] - mx) ** 2;
      dy += (ys[i] - my) ** 2;
    }
    const r = (dx && dy) ? num / Math.sqrt(dx * dy) : null;
    note.textContent = `${n} ${sport === 'cycling' ? 'rides' : 'activities'} with the selected sensors` +
      (r != null ? ` · correlation r = ${r.toFixed(2)}` : '');
  };

  ySel.addEventListener('change', draw);
  xSel.addEventListener('change', draw);
  regCheck.addEventListener('change', draw);
  draw();
}

function isPaceSport() {
  return sport === 'running' || sport === 'hiking';
}

// Activity calendar: GitHub-style year grid. Single-sport scopes use the
// green intensity scale; the all-sports scope colors by dominant sport.
// GPS heatmap: sampled tracks of the scope's sports on a leaflet map,
// one thin translucent polyline per activity (overlaps accumulate
// alpha — same drawing as the cycling Ride heatmap). Shown for every
// scope; the all-sports scope merges all enabled sports.
const HEAT_COLORS = ['#2c7fb8', '#7fbc41', '#de77ae', '#fdbb84', '#b2182b', '#66c2a5'];
let gpsHeatState = null;   // { map, layer, key } for the current scope

async function renderGpsHeatmap() {
  const holder = document.getElementById('stats-gps-heat');
  if (!holder) return;
  const sports = sport === null
    ? ['cycling', 'running', 'hiking'].filter(s => statsData.activities.some(a => a.sport === s))
    : [sport];
  if (!sports.length) { holder.innerHTML = ''; return; }
  const key = sports.join('+');

  holder.innerHTML = sectionCard('gps-heat', 'GPS heatmap — ' + (sports.length > 1 ? 'all sports' : sports[0]), `
        <div id="gps-heat-map" style="height: 420px; border-radius: .375rem;"></div>
        <p class="small text-muted mb-0 mt-2" id="gps-heat-note">Roads and paths you have covered most, by GPS pass frequency. Brighter = more passages.</p>`);
  bindSectionToggles(holder);

  const div = document.getElementById('gps-heat-map');
  const state = { map: null, layer: null };
  gpsHeatState = { key, state };
  try {
    const perSport = await Promise.all(sports.map(s => fetchHeatmap(s)));
    if (gpsHeatState?.key !== key) return;   // scope changed meanwhile
    const tracks = perSport.flatMap(d => d.tracks || []);

    const dark = document.documentElement.getAttribute('data-bs-theme') === 'dark';
    const map = L.map(div, { attributionControl: false });
    L.tileLayer(dark
      ? 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'
      : 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
    }).addTo(map);
    const group = L.layerGroup();
    const renderer = L.canvas({ padding: 0.2 });
    let i = 0;
    const bounds = L.latLngBounds();
    // Per-track clustered view for far zooms: at world zoom thin 1-px
    // lines are invisible, so summarize each track as a pin instead.
    // Level 1 (world): pin per coarse country grid cell (~500 km).
    // Level 2 (country→region): pin per ~50 km cell. Close zoom: the
    // actual tracks. Pins click-zoom to their cell.
    const tracksData = [];
    for (const tr of tracks) {
      if (!tr || tr.length < 2) continue;
      const latlngs = tr.map(p => [p[0], p[1]]);
      bounds.extend(latlngs);
      tracksData.push(latlngs);
    }
    const cellKey = (lat, lon, size) => `${Math.floor(lat / size)}:${Math.floor(lon / size)}`;
    // Cluster tracks by their start point's grid cell; each pin keeps the
    // union bounds of its member tracks so clicking zooms to where the
    // tracks actually are (a floor(mean) cell can land on empty space).
    const clusterAt = size => {
      const cells = {};
      tracksData.forEach((ll, ti) => {
        const k = cellKey(ll[0][0], ll[0][1], size);
        cells[k] = cells[k] || { lat: 0, lon: 0, n: 0, bounds: L.latLngBounds() };
        cells[k].lat += ll[0][0]; cells[k].lon += ll[0][1]; cells[k].n++;
        for (const p of ll) cells[k].bounds.extend(p);
      });
      return Object.entries(cells).map(([k, c]) => ({
        lat: c.lat / c.n, lon: c.lon / c.n, n: c.n,
        cell: c.bounds.pad(0.05),
        key: k, size,
      }));
    };
    const countryPins = clusterAt(5);      // ~550 km cells
    const regionPins = clusterAt(0.5);    // ~55 km cells
    const pinLayer = L.layerGroup();
    const pinIcon = (n, big) => L.divIcon({
      className: 'gps-pin',
      html: `<div style="width:${big ? 26 : 20}px;height:${big ? 26 : 20}px;border-radius:50%;background:rgba(220,53,69,${big ? 0.92 : 0.8});color:#fff;display:flex;align-items:center;justify-content:center;font-size:${big ? 12 : 10}px;font-weight:700;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);">${n}</div>`,
      iconSize: [big ? 26 : 20, big ? 26 : 20],
      iconAnchor: [big ? 13 : 10, big ? 13 : 10],
    });
    const pin = (c, big) => {
      const m = L.marker([c.lat, c.lon], { icon: pinIcon(c.n, big) });
      m.on('click', () => {
        // Zoom into the cluster's real bounds — at least one level past
        // the current pin layer so tracks or finer pins appear.
        map.fitBounds(c.cell, { maxZoom: 13 });
      });
      m.bindTooltip(`${c.n} track${c.n === 1 ? '' : 's'} — click to zoom in`);
      return m;
    };
    for (const c of countryPins) pin(c, true).addTo(pinLayer);
    const regionLayer = L.layerGroup();
    for (const c of regionPins) pin(c, false).addTo(regionLayer);
    for (const ll of tracksData) {
      L.polyline(ll, {
        color: HEAT_COLORS[i++ % HEAT_COLORS.length],
        weight: 1.5, opacity: 0.25, renderer,
      }).addTo(group);
    }
    // Track layer visible from z11 (city scale); pins take over below,
    // region pins from z6 (country clusters above that).
    const TRACK_Z = 11, REGION_Z = 6;
    const syncLayers = () => {
      const z = map.getZoom();
      if (z >= TRACK_Z) {
        if (map.hasLayer(pinLayer)) map.removeLayer(pinLayer);
        if (map.hasLayer(regionLayer)) map.removeLayer(regionLayer);
        if (!map.hasLayer(group)) map.addLayer(group);
      } else if (z >= REGION_Z) {
        if (map.hasLayer(pinLayer)) map.removeLayer(pinLayer);
        if (!map.hasLayer(regionLayer)) map.addLayer(regionLayer);
        if (map.hasLayer(group)) map.removeLayer(group);
      } else {
        if (!map.hasLayer(pinLayer)) map.addLayer(pinLayer);
        if (map.hasLayer(regionLayer)) map.removeLayer(regionLayer);
        if (map.hasLayer(group)) map.removeLayer(group);
      }
    };
    map.on('zoomend', syncLayers);
    syncLayers();
    state.map = map;
    state.layer = group;
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30] });
    const note = document.getElementById('gps-heat-note');
    if (note) {
      const nCountries = countryPins.length;
      note.textContent = `${tracksData.length} tracks · ${nCountries} area${nCountries === 1 ? '' : 's'} plotted. Zoom in or click a pin to drill into regions and tracks.`;
    }
    // Fullscreen floats the map's sized wrapper so the card header stays.
    attachFullscreen(holder.querySelector('.card'), div);
  } catch (err) {
    holder.innerHTML = '';
  }
}

function renderCalendar(acts) {
  const el = document.getElementById('calendar-heatmap');
  const note = document.getElementById('calendar-note');
  if (!el) return;
  const isAll = sport === null;

  // Distance + moving time + per-sport time per day.
  const byDay = {};
  for (const a of acts) {
    const day = a.start_time.slice(0, 10);
    if (!byDay[day]) byDay[day] = { km: 0, time: 0, sports: {} };
    byDay[day].km += (a.distance || 0);
    byDay[day].time += (a.moving_time || 0);
    const s = a.sport || 'cycling';
    const cell = byDay[day].sports[s] = byDay[day].sports[s] || { km: 0, time: 0 };
    cell.km += (a.distance || 0);
    cell.time += (a.moving_time || 0);
  }
  const days = Object.keys(byDay).sort();
  if (!days.length) { el.innerHTML = '<p class="text-muted mb-0">No activities.</p>'; return; }

  const SPORT_COLORS = { cycling: '#0d6efd', running: '#fd7e14', hiking: '#198754' };
  const sportColor = s => SPORT_COLORS[s] || '#adb5bd';
  const sportIcon = s => s === 'cycling' ? '🚴' : s === 'running' ? '🏃' : s === 'hiking' ? '🥾' : '🏅';
  // Dominant sport by TIME, not distance: a long hike with a short bike
  // commute reads as a hiking day, whatever the kilometres say.
  const daySport = day => Object.entries(byDay[day].sports).sort((a, b) => b[1].time - a[1].time)[0]?.[0];
  const isDark = document.documentElement.getAttribute('data-bs-theme') === 'dark';
  const greenColors = isDark
    ? ['#0e4429', '#006d32', '#26a641', '#39d353']
    : ['#c6e6c4', '#74c476', '#238b45', '#00441b'];
  const hexToRgba = (hex, alpha) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(2)})`;
  };

  const first = new Date(days[0] + 'T00:00:00Z');
  const last = new Date(days[days.length - 1] + 'T00:00:00Z');
  const start = new Date(first);
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  const end = new Date(last);
  end.setUTCDate(end.getUTCDate() + (6 - (end.getUTCDay() + 6) % 7));

  const ridden = days.map(d => byDay[d].km).sort((a, b) => a - b);
  const q = p => ridden[Math.min(ridden.length - 1, Math.floor(p * (ridden.length - 1)))];
  const thresholds = [q(0.25), q(0.5), q(0.75), q(1)].map(v => v || 0);

  const years = [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const y = d.getUTCFullYear();
    if (!years.length || years[years.length - 1].year !== y) years.push({ year: y, weeks: [] });
    const yr = years[years.length - 1];
    const monday = new Date(d);
    monday.setUTCDate(monday.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    let wk = yr.weeks.find(w => w.t === monday.getTime());
    if (!wk) { wk = { t: monday.getTime(), days: new Array(7).fill(null) }; yr.weeks.push(wk); }
    const day = d.toISOString().slice(0, 10);
    wk.days[(d.getUTCDay() + 6) % 7] = { day, km: byDay[day] ? byDay[day].km : 0 };
  }

  const cellSize = 13, gap = 2;
  const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const yearRows = years.map(yr => {
    const grid = [[], [], [], [], [], [], []];
    yr.weeks.forEach(w => {
      for (let di = 0; di < 7; di++) {
        const cell = w.days[di];
        if (!cell) { grid[di].push(`<td class="cal-empty" style="width:${cellSize}px;height:${cellSize}px;"></td>`); continue; }
        const lvl = cell.km > 0 ? Math.min(4, 1 + thresholds.filter(t => cell.km > t).length) : 0;
        const info = byDay[cell.day];
        // Multi-sport day: linear-gradient hard stops split the square
        // by each sport's share of the day's time (dominant by time).
        let bg;
        if (isAll && info && Object.keys(info.sports).length > 1) {
          const entries = Object.entries(info.sports).sort((a, b) => b[1].time - a[1].time);
          const total = entries.reduce((s, [, v]) => s + v.time, 0) || 1;
          let acc = 0;
          const stops = entries.map(([s, v]) => {
            const from = (acc / total) * 100; acc += v.time;
            const to = (acc / total) * 100;
            const c = hexToRgba(sportColor(s), 0.35 + 0.65 * lvl / 4);
            return `${c} ${from.toFixed(1)}%, ${c} ${to.toFixed(1)}%`;
          });
          bg = `linear-gradient(90deg, ${stops.join(', ')})`;
        } else if (isAll) {
          bg = cell.km > 0 ? hexToRgba(sportColor(daySport(cell.day)), 0.35 + 0.65 * lvl / 4) : 'var(--bs-secondary-bg)';
        } else {
          bg = lvl > 0 ? greenColors[lvl - 1] : 'var(--bs-secondary-bg)';
        }
        const tipParts = info
          ? Object.entries(info.sports).sort((a, b) => b[1].time - a[1].time)
            .map(([s, v]) => `${sportIcon(s)} ${v.km.toFixed(1)} km · ${fmtDuration(v.time)}`)
          : [];
        const tip = tipParts.length
          ? `${cell.day}: ${tipParts.join(' + ')}`
          : `${cell.day}: no activity`;
        grid[di].push(`<td class="cal-cell" data-day="${cell.day}" data-km="${cell.km}" style="width:${cellSize}px;height:${cellSize}px;background:${bg};border:1px solid var(--bs-border-color);border-radius:2px;" title="${tip}"></td>`);
      }
    });
    const rows = grid.map((r, di) => `<tr><td class="cal-day-letter">${DAY_LETTERS[di]}</td>${r.join('')}</tr>`).join('');
    return `
      <div class="d-flex align-items-start mb-2 cal-year-row" data-year="${yr.year}">
        <span class="small text-muted me-2" style="width:3rem;flex:none;">${yr.year}</span>
        <table class="cal-table m-0"><tbody>${rows}</tbody></table>
      </div>`;
  }).join('');

  // Year checkboxes: only ticked years show their row. Latest by default.
  const latest = String(years[years.length - 1].year);
  el.innerHTML = `
    <div class="d-flex flex-wrap gap-3 mb-2" id="cal-year-toggles">
      ${years.map(yr => `
        <div class="form-check form-check-inline mb-0">
          <input class="form-check-input cal-year-cb" type="checkbox" data-year="${yr.year}" id="cal-year-${yr.year}" ${String(yr.year) === latest ? 'checked' : ''}>
          <label class="form-check-label small" for="cal-year-${yr.year}">${yr.year}</label>
        </div>`).join('')}
    </div>
    ${yearRows}
    <div class="d-flex justify-content-end align-items-center mt-1 gap-2">
      ${isAll
        ? Object.entries(SPORT_COLORS).map(([s, c]) => `<span class="small text-muted"><span style="width:11px;height:11px;display:inline-block;margin:0 2px;border-radius:2px;background:${c};vertical-align:middle;"></span>${s}</span>`).join('')
        : `<span class="small text-muted me-1">Less</span>` +
          greenColors.map(c =>
            `<span style="width:11px;height:11px;display:inline-block;margin:0 1px;border-radius:2px;background:${c};border:1px solid var(--bs-border-color);vertical-align:middle;"></span>`
          ).join('') + `<span class="small text-muted ms-1">More</span>`}
    </div>
    <style>
      .cal-table { border-collapse: separate; border-spacing: ${gap}px; table-layout: fixed; }
      .cal-table td { padding: 0; }
      .cal-day-letter { width: 10px !important; font-size: 9px; color: var(--bs-secondary-color); text-align: left; vertical-align: middle; }
      .cal-cell:hover { outline: 2px solid #0d6efd; }
    </style>`;

  const applyVisibility = () => {
    el.querySelectorAll('.cal-year-cb').forEach(cb => {
      const row = el.querySelector(`.cal-year-row[data-year="${cb.dataset.year}"]`);
      if (row) row.classList.toggle('d-none', !cb.checked);
    });
  };
  el.querySelectorAll('.cal-year-cb').forEach(cb => {
    cb.addEventListener('change', applyVisibility);
  });
  applyVisibility();

  if (note) note.textContent = 'Hover a day for details.';
}

// HR vs pace scatter (running only): aerobic cost of pace. Each run is a
// dot (avg pace vs avg HR), color-coded by year, with an optional
// least-squares regression line per year (toggled with checkboxes).
let hrPaceChart = null;
let gradeHrChart = null;
let hrPaceRuns = null;
// Distinct color per year for up to 50+ years: golden-angle hue steps
// maximize perceived separation, with lightness/saturation variation so
// even wrap-around hues stay distinguishable.
function yearColorAt(index) {
  const hue = (index * 137.508) % 360;   // golden angle
  const light = 38 + (index % 3) * 12;   // 38/50/62%
  const sat = 68 + (index % 4) * 7;      // 68..89%
  return `hsl(${hue.toFixed(1)}, ${sat}%, ${light}%)`;
}
function yearColors(years) {
  const map = {};
  years.forEach((y, i) => { map[y] = yearColorAt(i); });
  return map;
}

// HR vs speed by road grade (cycling). Server-side buckets each ride's
// records into rolling 500 m windows; each window's mean speed and HR
// (moving samples only) becomes one dot, colored by grade bucket.
function renderGradeHr() {
  const holder = document.getElementById('stats-grade-hr');
  if (!holder) return;
  const buckets = statsData.grade_hr || [];
  if (sport !== 'cycling' || !buckets.length) {
    if (gradeHrChart) { gradeHrChart.destroy(); gradeHrChart = null; }
    holder.innerHTML = '';
    return;
  }
  // Period filter via the point's activity date.
  const acts = statsData.activities;
  const now = monthKey(acts.length ? acts[acts.length - 1].start_time : '');
  const first = monthKey(acts.length ? acts[0].start_time : '');
  const range = periodRange(now, first);
  const all = buckets.flatMap(b => b.points.map(p => ({ ...p, bucket: b.label })));
  const inRange = all.filter(p => inMonth(p.date, range));
  if (inRange.length < 10) {
    if (gradeHrChart) { gradeHrChart.destroy(); gradeHrChart = null; }
    holder.innerHTML = '';
    return;
  }

  const BUCKET_COLORS = {
    '0-2%': '#6c757d', '2-4%': '#0d6efd', '4-6%': '#fd7e14',
    '6-8%': '#dc3545', '8%+': '#6f42c1',
  };
  const labels = buckets.map(b => b.label);

  holder.innerHTML = sectionCard('grade-hr', 'Heart rate vs speed by grade', `
        <p class="text-muted small mb-2">
          One dot = one 500 m window of a ride (mean speed vs mean HR while
          moving). Color = the window's road grade. Dots low-right for a
          color = cheaper riding at that steepness.
        </p>
        <div class="d-flex flex-wrap align-items-center gap-3 mb-2">
          <div class="form-check form-check-inline mb-0">
            <input class="form-check-input" type="checkbox" id="grade-hr-show-points" checked>
            <label class="form-check-label small" for="grade-hr-show-points">Points</label>
          </div>
          <div class="form-check form-check-inline mb-0">
            <input class="form-check-input" type="checkbox" id="grade-hr-show-regression" checked>
            <label class="form-check-label small" for="grade-hr-show-regression">Regression</label>
          </div>
          <div class="d-flex flex-wrap gap-3" id="grade-hr-buckets">
          ${labels.map(l => `
            <div class="form-check form-check-inline mb-0">
              <input class="form-check-input grade-hr-bucket" type="checkbox" data-bucket="${l}" id="grade-hr-bucket-${l}" checked>
              <label class="form-check-label small" for="grade-hr-bucket-${l}">
                <span style="color:${BUCKET_COLORS[l]};font-weight:600;">■</span> ${l}
              </label>
            </div>`).join('')}
          </div>
        </div>
        <div style="height: 320px; position: relative;"><canvas id="stats-grade-hr-chart"></canvas></div>
        <p class="small text-muted mb-0 mt-2" id="grade-hr-note"></p>`);
  bindSectionToggles(holder);

  const draw = () => {
    const showPoints = document.getElementById('grade-hr-show-points').checked;
    const showReg = document.getElementById('grade-hr-show-regression').checked;
    const active = new Set(
      [...document.querySelectorAll('.grade-hr-bucket')]
        .filter(cb => cb.checked)
        .map(cb => cb.dataset.bucket));
    const datasets = [];
    for (const l of labels) {
      if (!active.has(l)) continue;
      const pts = inRange.filter(p => p.bucket === l).map(p => ({ x: p.speed, y: p.hr }));
      if (showPoints) {
        datasets.push({
          label: l,
          data: pts,
          backgroundColor: BUCKET_COLORS[l],
          pointRadius: 2,
          order: 2,
        });
      }
      if (showReg) {
        // Least-squares line per bucket, drawn across its speed range.
        const n = pts.length;
        if (n >= 5) {
          const mx = pts.reduce((s, p) => s + p.x, 0) / n;
          const my = pts.reduce((s, p) => s + p.y, 0) / n;
          let sxy = 0, sxx = 0;
          for (const p of pts) {
            sxy += (p.x - mx) * (p.y - my);
            sxx += (p.x - mx) ** 2;
          }
          if (sxx > 0) {
            const slope = sxy / sxx;
            const xMin = Math.min(...pts.map(p => p.x));
            const xMax = Math.max(...pts.map(p => p.x));
            datasets.push({
              type: 'line',
              label: l,
              data: [{ x: xMin, y: my + slope * (xMin - mx) },
                     { x: xMax, y: my + slope * (xMax - mx) }],
              borderColor: BUCKET_COLORS[l],
              borderWidth: 2,
              pointRadius: 0,
              order: 1,
              parsing: false,
            });
          }
        }
      }
    }
    // Fixed axis window: spanning all ACTIVE buckets' data, computed
    // before points/regression are filtered out, so ticking/unticking
    // points or regression never rescales the view. Bucket changes
    // recompute it (as they should).
    const activePts = labels.filter(l => active.has(l))
      .flatMap(l => inRange.filter(p => p.bucket === l));
    const xMin0 = Math.min(...activePts.map(p => p.speed));
    const xMax0 = Math.max(...activePts.map(p => p.speed));
    const yMin0 = Math.min(...activePts.map(p => p.hr));
    const yMax0 = Math.max(...activePts.map(p => p.hr));
    const padX = (xMax0 - xMin0) * 0.02;
    const padY = (yMax0 - yMin0) * 0.05;

    if (gradeHrChart) gradeHrChart.destroy();
    gradeHrChart = new window.Chart(document.getElementById('stats-grade-hr-chart').getContext('2d'), {
      type: 'scatter',
      data: { datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: false,
        parsing: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => ctx.dataset.type === 'line'
                ? ctx.dataset.label
                : `${ctx.dataset.label} · ${ctx.parsed.x.toFixed(1)} km/h · ${Math.round(ctx.parsed.y)} bpm`,
            },
          },
        },
        scales: {
          x: {
            type: 'linear', title: { display: true, text: 'Speed (km/h)' },
            min: xMin0 - padX, max: xMax0 + padX,
          },
          y: {
            title: { display: true, text: 'Heart rate (bpm)' }, beginAtZero: false,
            min: yMin0 - padY, max: yMax0 + padY,
          },
        },
      },
    });
    const n = datasets.filter(d => d.type !== 'line').reduce((s, d) => s + d.data.length, 0);
    const regNote = [];
    for (const d of datasets) {
      if (d.type !== 'line') continue;
      const [a, b2] = d.data;
      const slope = (b2.y - a.y) / (b2.x - a.x) || 0;
      regNote.push(`${d.label}: ${slope >= 0 ? '+' : ''}${slope.toFixed(1)} bpm per km/h`);
    }
    const note = document.getElementById('grade-hr-note');
    note.textContent = `${n} windows plotted` + (regNote.length ? ' · ' + regNote.join(' · ') : '');
  };
  document.querySelectorAll('.grade-hr-bucket').forEach(cb => {
    cb.addEventListener('change', draw);
  });
  document.getElementById('grade-hr-show-points').addEventListener('change', draw);
  document.getElementById('grade-hr-show-regression').addEventListener('change', draw);
  draw();
}

function renderHrPace(acts) {
  const holder = document.getElementById('stats-hr-pace');
  if (!holder) return;
  if (sport !== 'running') {
    holder.innerHTML = '';
    return;
  }
  // Elapsed-based pace: breaks/walk stops count, like Strava race times.
  // Garmin's avg_speed ignores them, which flatters interval-heavy runs.
  const paceOf = a => {
    if (!a || !a.distance || !a.elapsed_time) return null;
    return (a.elapsed_time / 60) / a.distance;   // min/km incl. breaks
  };
  // Very slow "runs" (walk breaks, GPS pauses) skew the regression —
  // anything slower than 12 min/km is not aerobic running data. Sub-2
  // min/km is GPS glitch (faster than any human), dropped the same way.
  hrPaceRuns = acts
    .map(a => ({ a, pace: paceOf(a), hr: a.avg_hr, year: (a.start_time || '').slice(0, 4) }))
    .filter(r => r.pace != null && r.hr != null && r.a.distance >= 3 && r.pace >= 2 && r.pace <= 12);

  if (hrPaceRuns.length < 5) {
    holder.innerHTML = '';
    return;
  }

  const years = [...new Set(hrPaceRuns.map(r => r.year))].sort();
  const yearColor = yearColors(years);

  holder.innerHTML = sectionCard('hr-pace', 'Heart rate vs pace — aerobic cost', `
        <div class="d-flex flex-wrap align-items-center gap-3 mb-2">
          <div class="form-check form-check-inline mb-0">
            <input class="form-check-input" type="checkbox" id="hr-pace-show-points" checked>
            <label class="form-check-label small" for="hr-pace-show-points">Points</label>
          </div>
          <div class="form-check form-check-inline mb-0">
            <input class="form-check-input" type="checkbox" id="hr-pace-show-regression" checked>
            <label class="form-check-label small" for="hr-pace-show-regression">Regression</label>
          </div>
          <div class="d-flex flex-wrap gap-3" id="hr-pace-years">
            ${years.map(y => `
              <div class="form-check form-check-inline mb-0">
                <input class="form-check-input hr-pace-year" type="checkbox" data-year="${y}" id="hr-pace-year-${y}" checked>
                <label class="form-check-label small" for="hr-pace-year-${y}">
                  <span style="color:${yearColor[y]};">■</span> ${y}
                </label>
              </div>`).join('')}
          </div>
        </div>
        <div style="height: 300px; position: relative;"><canvas id="stats-hr-pace-chart"></canvas></div>
        <p class="small text-muted mb-0 mt-2" id="stats-hr-pace-note"></p>`);
  bindSectionToggles(holder);
  // Float the whole card body: the checkboxes and year toggles above the
  // chart are the chart's legend/options and must stay visible in
  // fullscreen.
  attachFullscreen(holder.querySelector('.card'), holder.querySelector('.card-body'));

  const draw = () => {
    const showPoints = document.getElementById('hr-pace-show-points').checked;
    const showReg = document.getElementById('hr-pace-show-regression').checked;
    const activeYears = new Set(
      // The controls can live outside `holder` while the card body is
      // floated in fullscreen — query the whole document instead.
      [...document.querySelectorAll('.hr-pace-year')]
        .filter(cb => cb.checked)
        .map(cb => cb.dataset.year));
    const datasets = [];
    if (showPoints) {
      for (const y of years) {
        if (!activeYears.has(y)) continue;
        datasets.push({
          label: y,
          data: hrPaceRuns.filter(r => r.year === y).map(r => ({ x: r.pace, y: r.hr })),
          backgroundColor: yearColor[y],
          pointRadius: 4,
          order: 2,
        });
      }
    }
    // Per-year regression lines for the ticked years.
    if (showReg) {
      for (const y of years) {
        if (!activeYears.has(y)) continue;
        const pts = hrPaceRuns.filter(r => r.year === y);
        if (pts.length < 5) continue;
        const n = pts.length;
        const xs = pts.map(p => p.pace);
        const ys = pts.map(p => p.hr);
        const mx = xs.reduce((s, v) => s + v, 0) / n;
        const my = ys.reduce((s, v) => s + v, 0) / n;
        let sxy = 0, sxx = 0, syy = 0;
        for (let i = 0; i < n; i++) {
          sxy += (xs[i] - mx) * (ys[i] - my);
          sxx += (xs[i] - mx) ** 2;
          syy += (ys[i] - my) ** 2;
        }
        if (sxx <= 0) continue;
        const slope = sxy / sxx;
        const intercept = my - slope * mx;
        const r = (sxx && syy) ? sxy / Math.sqrt(sxx * syy) : null;
        const xMin = Math.min(...xs), xMax = Math.max(...xs);
        datasets.push({
          label: `${y} fit (R² ${r != null ? (r * r).toFixed(2) : '—'})`,
          data: [{ x: xMin, y: slope * xMin + intercept }, { x: xMax, y: slope * xMax + intercept }],
          type: 'line',
          borderColor: yearColor[y],
          borderWidth: 3,
          pointRadius: 0,
          fill: false,
          order: 1,
        });
      }
    }

    const paceTick = v => `${Math.floor(v)}:${String(Math.round((v % 1) * 60)).padStart(2, '0')}`;
    if (hrPaceChart) hrPaceChart.destroy();
    hrPaceChart = new window.Chart(document.getElementById('stats-hr-pace-chart').getContext('2d'), {
      type: 'scatter',
      data: { datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => {
                if (ctx.dataset.type === 'line') return ctx.dataset.label;
                // Datasets are filtered per year: look the run up by its
                // year dataset and point index within that year.
                const yearRuns = hrPaceRuns.filter(r => r.year === ctx.dataset.label);
                const run = yearRuns[ctx.dataIndex];
                if (!run) return ctx.dataset.label;
                return `${paceTick(run.pace)} min/km · ${Math.round(run.hr)} bpm · ${run.a.name || ''} (${run.year})`;
              },
            },
          },
        },
        scales: {
          x: { title: { display: true, text: 'Pace incl. breaks (min/km)' }, ticks: { callback: paceTick } },
          y: { title: { display: true, text: 'Average heart rate (bpm)' }, beginAtZero: false },
        },
      }
    });

    const note = document.getElementById('stats-hr-pace-note');
    const parts = [`${hrPaceRuns.length} runs (3 km+, 2–12 min/km incl. breaks)`];
    for (const y of activeYears) {
      const pts = hrPaceRuns.filter(r => r.year === y);
      if (pts.length < 5) continue;
      const n = pts.length;
      const mx = pts.reduce((s, p) => s + p.pace, 0) / n;
      const my = pts.reduce((s, p) => s + p.hr, 0) / n;
      let sxy = 0, sxx = 0;
      for (const p of pts) {
        sxy += (p.pace - mx) * (p.hr - my);
        sxx += (p.pace - mx) ** 2;
      }
      if (sxx > 0) parts.push(`${y}: HR ≈ ${Math.round(sxy / sxx)} bpm per min/km`);
    }
    note.textContent = parts.join(' · ');
  };

  document.querySelectorAll('.hr-pace-year').forEach(cb => {
    cb.addEventListener('change', draw);
  });
  document.getElementById('hr-pace-show-points').addEventListener('change', draw);
  document.getElementById('hr-pace-show-regression').addEventListener('change', draw);
  draw();
}

// VO2 max card: our own performance-based estimates per sport (running
// VDOT, cycling climb physics) plus Garmin's estimate trend, both scoped
// to the selected period. Meaningless for hiking, skipped there; each
// tile only shows for the sports in scope.
function renderVo2() {
  const holder = document.getElementById('stats-vo2');
  if (!holder) return;
  if (sport === 'hiking') {
    holder.innerHTML = '';
    if (vo2Chart) { vo2Chart.destroy(); vo2Chart = null; }
    return;
  }
  const acts = statsData.activities;
  const now = monthKey(acts.length ? acts[acts.length - 1].start_time : '');
  const first = monthKey(acts.length ? acts[0].start_time : '');
  const range = periodRange(now, first);
  // Garmin only estimates VO2 from running activities (the DB has no
  // cycling VO2); the cycling scope must not show the running line.
  const garminScope = sport === 'cycling' ? [] : (statsData.vo2_history || []);
  const hist = garminScope
    .filter(h => inMonth(h.date, range))
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const est = statsData.vo2_estimates || {};

  // Own-estimate tiles only for sports in the current scope.
  const showRunning = sport === 'running' || sport === null;
  const showCycling = sport === 'cycling' || sport === null;

  if (!hist.length && !(showRunning && est.running) && !(showCycling && est.cycling)) {
    holder.innerHTML = '';
    return;
  }

  const estTile = (key, icon, name, color) => {
    const e = est[key];
    if (!e) return '';
    const rows = key === 'running'
      ? (e.per_distance || []).map(p => `<tr><td class="ps-3 text-muted">${p.distance_m >= 1000 ? (p.distance_m / 1000) + ' km' : p.distance_m + ' m'}</td><td>${fmtDuration(p.time_s)}</td><td class="fw-semibold">${p.vo2max.toFixed(1)}</td></tr>`).join('')
      : (e.per_climb || []).map(c => `<tr><td class="ps-3 text-muted">${escapeHtml(c.name)}</td><td>${c.elapsed_time_s >= 60 ? Math.round(c.elapsed_time_s / 60) + ' min' : Math.round(c.elapsed_time_s) + ' s'} · ${c.w_per_kg.toFixed(2)} W/kg</td><td class="fw-semibold">${(10.8 * c.w_per_kg + 7).toFixed(1)}</td></tr>`).join('');
    return `
      <div class="col-12 col-lg-6">
        <div class="card h-100">
          <div class="card-header d-flex justify-content-between align-items-center">
            <span class="fw-semibold">${icon} Own estimate — ${name}</span>
            <span class="fs-4 fw-bold" style="color:${color};">${e.vo2max.toFixed(1)}</span>
          </div>
          <div class="card-body py-2 px-0">
            ${rows ? `
            <table class="table table-sm mb-0">
              <thead><tr><th class="ps-3">${key === 'running' ? 'Distance' : 'Climb'}</th><th>${key === 'running' ? 'Best time' : 'Effort'}</th><th>VO₂max implied</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>` : ''}
            <p class="small text-muted mb-0 px-3 mt-2">${e.method}</p>
            ${key === 'cycling' ? `<p class="small text-muted px-3 mb-0 mt-1">Assumes ${e.rider_mass_kg} kg rider + 10 kg bike, CdA 0.32 — treat as ±15% range.</p>` : ''}
          </div>
        </div>
      </div>`;
  };

  const chartBlock = hist.length > 1 ? `
    <div class="d-flex align-items-center gap-2 mb-1 flex-wrap">
      <label for="vo2-range" class="small text-muted mb-0">Window: <span id="vo2-range-label">all</span></label>
      <input type="range" id="vo2-range" min="1" max="${hist.length}" value="${hist.length}" step="1" class="form-range" style="width: 220px;">
    </div>
    <div style="height: 280px; position: relative;"><canvas id="stats-vo2-chart"></canvas></div>
    <p class="small text-muted mb-0 mt-2" id="stats-vo2-note"></p>` : (hist.length ? `
    <div style="height: 280px; position: relative;"><canvas id="stats-vo2-chart"></canvas></div>
    <p class="small text-muted mb-0 mt-2" id="stats-vo2-note"></p>` : '');

  const tilesRow = (showRunning && est.running) || (showCycling && est.cycling) ? `
        <div class="row g-2 mb-2">
          ${showRunning ? estTile('running', '🏃', 'running (VDOT)', '#fd7e14') : ''}
          ${showCycling ? estTile('cycling', '🚴', 'cycling (climb physics)', '#0d6efd') : ''}
        </div>` : '';

  holder.innerHTML = sectionCard('vo2', 'VO₂ max', `${tilesRow}${chartBlock}`);
  bindSectionToggles(holder);
  if (hist.length) {
    // Fullscreen floats the card body so the estimate tiles stay visible
    // above the chart.
    const chartCanvas = document.getElementById('stats-vo2-chart');
    attachFullscreen(chartCanvas.closest('.card'), chartCanvas.closest('.card-body'));
  }
  if (!hist.length) return;

  // Running and cycling estimates live on different scales — split when
  // both sports are present so the line does not zig-zag between them.
  const sports = [...new Set(hist.map(h => h.sport || 'other'))];
  const sportColor = { running: '#fd7e14', cycling: '#0d6efd', hiking: '#198754' };

  const draw = (windowSize) => {
    // Sliding window: the last `windowSize` points (slider), default all.
    const view = windowSize >= hist.length ? hist : hist.slice(-windowSize);
    const labels = view.map(h => h.date.slice(0, 10));
    const datasets = sports.map(s => {
      return {
        label: s,
        data: view.map(h => (h.sport || 'other') === s ? h.vo2 : null),
        backgroundColor: sportColor[s] || '#6f42c1',
        borderColor: sportColor[s] || '#6f42c1',
        pointRadius: 3,
        borderWidth: 2,
        tension: 0.25,
        spanGaps: false,
      };
    });

    if (vo2Chart) vo2Chart.destroy();
    vo2Chart = new window.Chart(document.getElementById('stats-vo2-chart').getContext('2d'), {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'nearest', intersect: false },
        plugins: {
          legend: { display: sports.length > 1, labels: { boxWidth: 12 } },
          tooltip: {
            callbacks: {
              label: c => `${c.dataset.label}: ${c.parsed.y.toFixed(1)} ml/kg/min`,
            },
          },
        },
        scales: {
          x: { ticks: { maxRotation: 45, autoSkip: true, maxTicksLimit: 12 } },
          y: {
            title: { display: true, text: 'VO₂ max (ml/kg/min)' },
            beginAtZero: false,
            suggestedMin: Math.min(...view.map(h => h.vo2)) - 2,
            suggestedMax: Math.max(...view.map(h => h.vo2)) + 2,
          },
        },
      }
    });

    const firstEst = view[0], lastEst = view[view.length - 1];
    const diff = lastEst.vo2 - firstEst.vo2;
    const best = Math.max(...view.map(h => h.vo2));
    const note = document.getElementById('stats-vo2-note');
    note.textContent = `Garmin estimates: ${view.length} points · current ${lastEst.vo2.toFixed(1)} · best ${best.toFixed(1)} · ${diff >= 0 ? '+' : ''}${diff.toFixed(1)} since ${firstEst.date.slice(0, 10)}`;
    const rangeLabel = document.getElementById('vo2-range-label');
    if (rangeLabel) {
      rangeLabel.textContent = windowSize >= hist.length
        ? `all ${hist.length} points`
        : `last ${windowSize} points`;
    }
  };

  const slider = document.getElementById('vo2-range');
  if (slider) {
    slider.addEventListener('input', () => draw(parseInt(slider.value, 10) || hist.length));
  }
  draw(hist.length);
}


// Year over year: monthly distance per calendar year, ticked via
// checkboxes. In all time this is the comparison view; shorter periods
// still show every year for reference. On the Overall page each year's
// bar stacks per sport and the tooltip breaks the month down by sport.
let yoySelected = null;   // Set of ticked years; null = auto (last two)
function renderYoY(acts) {
  const holder = document.getElementById('stats-yoy');
  const years = [...new Set(acts.map(a => a.start_time.slice(0, 4)))].sort();
  if (years.length < 2) {
    if (yoyChart) { yoyChart.destroy(); yoyChart = null; }
    holder.innerHTML = '';
    return;
  }
  if (yoySelected === null) yoySelected = new Set(years.slice(-2));
  // Drop ticks for years that disappeared (sport switch).
  yoySelected = new Set([...yoySelected].filter(y => years.includes(y)));
  if (!yoySelected.size) yoySelected = new Set(years.slice(-2));

  // Stable per-year colors: keyed by the year's position in the full
  // list, so adding/removing years never recolors existing bars.
  const yearColor = yearColors(years);
  const isAll = sport === null;
  const SPORT_COLORS = { cycling: '#0d6efd', running: '#fd7e14', hiking: '#198754' };
  const sportColor = s => SPORT_COLORS[s] || '#adb5bd';
  const sportIcon = s => s === 'cycling' ? '🚴' : s === 'running' ? '🏃' : s === 'hiking' ? '🥾' : '🏅';
  const sportsPresent = [...new Set(acts.map(a => a.sport || 'cycling'))].sort();

  // perYearSport[y][month][sport] = km, for the tooltip breakdown.
  const perYearSport = {};
  for (const a of acts) {
    const y = a.start_time.slice(0, 4);
    const m = parseInt(a.start_time.slice(5, 7), 10) - 1;
    const s = a.sport || 'cycling';
    perYearSport[y] = perYearSport[y] || Array.from({ length: 12 }, () => ({}));
    perYearSport[y][m][s] = (perYearSport[y][m][s] || 0) + (a.distance || 0);
  }

  holder.innerHTML = sectionCard('yoy', 'Year over year — distance', `
          ${years.map(y => `
            <div class="form-check form-check-inline mb-0">
              <input class="form-check-input yoy-year" type="checkbox" data-year="${y}" id="yoy-year-${y}" ${yoySelected.has(y) ? 'checked' : ''}>
              <label class="form-check-label small" for="yoy-year-${y}"><span style="color:${yearColor[y]};">■</span> ${y}</label>
            </div>`).join('')}
        </div>
        <div style="height: 280px; position: relative;"><canvas id="stats-yoy-chart"></canvas></div>
        ${isAll ? '<p class="small text-muted mb-0 mt-2">Bars stack per sport · hover a month for the per-sport breakdown.</p>' : ''}`);
  bindSectionToggles(holder);

  const draw = () => {
    const active = years.filter(y => yoySelected.has(y));
    const labels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const datasets = [];
    if (isAll) {
      // One stacked dataset per (year, sport) pair, sports of the same
      // year grouped side by side and stacked per sport.
      active.forEach(y => {
        for (const s of sportsPresent) {
          const monthly = new Array(12).fill(0);
          let any = false;
          for (const a of acts) {
            if (a.start_time.slice(0, 4) !== y || (a.sport || 'cycling') !== s) continue;
            monthly[parseInt(a.start_time.slice(5, 7), 10) - 1] += a.distance || 0;
            any = true;
          }
          if (!any) continue;
          datasets.push({
            label: `${y} · ${sportIcon(s)} ${s}`,
            data: monthly.map(v => +v.toFixed(1)),
            backgroundColor: sportColor(s),
            borderColor: sportColor(s),
            stack: y,
          });
        }
      });
    } else {
      active.forEach(y => {
        const monthly = new Array(12).fill(0);
        for (const a of acts) {
          if (a.start_time.slice(0, 4) !== y) continue;
          monthly[parseInt(a.start_time.slice(5, 7), 10) - 1] += a.distance || 0;
        }
        datasets.push({
          label: y, data: monthly.map(v => +v.toFixed(1)),
          backgroundColor: yearColor[y], borderColor: yearColor[y],
        });
      });
    }
    if (yoyChart) yoyChart.destroy();
    yoyChart = new window.Chart(document.getElementById('stats-yoy-chart').getContext('2d'), {
      type: 'bar',
      data: { labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'top',
            labels: { boxWidth: 12 },
            // Overall page: one legend entry per sport, not per (year,sport).
            labels: isAll
              ? { boxWidth: 12, generateLabels: () => sportsPresent.map(s => ({ text: `${sportIcon(s)} ${s}`, fillStyle: sportColor(s), strokeStyle: sportColor(s) })) }
              : { boxWidth: 12 },
          },
          tooltip: {
            callbacks: {
              label: c => {
                const base = `${c.dataset.label}: ${c.parsed.y.toFixed(1)} km`;
                if (!isAll) return base;
                // Per-sport breakdown for the hovered month+year.
                const y = c.dataset.stack;
                const detail = Object.entries(perYearSport[y]?.[c.dataIndex] || {})
                  .sort((a, b) => b[1] - a[1])
                  .map(([s, km]) => `${sportIcon(s)} ${km.toFixed(1)} km`);
                return detail.length ? `${y} — ${detail.join(' · ')}` : base;
              },
            },
          },
        },
        scales: { x: { stacked: isAll }, y: { beginAtZero: true, title: { display: true, text: 'Distance (km)' }, stacked: isAll } },
      }
    });
  };
  document.querySelectorAll('.yoy-year').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) yoySelected.add(cb.dataset.year);
      else yoySelected.delete(cb.dataset.year);
      draw();
    });
  });
  draw();
}

function fmtGradeShort(p) {
  if (p == null) return '—';
  return `${p.toFixed(1)}%`;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Training sections (merged from the former Training page): streaks,
// fitness & freshness, training load, normalized HR, goals. They share
// the same statsData fetch and follow the selected sport scope.
// ---------------------------------------------------------------------------

let fitnessChart = null;
let loadChart = null;

function renderTrainingSections() {
  const holder = document.getElementById('stats-training');
  if (!holder) return;
  const allActs = statsData.activities;
  if (!allActs || !allActs.length) { holder.innerHTML = ''; return; }

  // The stats payload carries the full history (year-over-year, records
  // need it); the training sections are period views — streaks, fitness,
  // load, normHR and goals all follow the selected period.
  const now = monthKey(allActs[allActs.length - 1].start_time);
  const first = monthKey(allActs[0].start_time);
  const range = periodRange(now, first);
  const acts = allActs.filter(a => inMonth(a.start_time, range));
  if (!acts.length) { holder.innerHTML = ''; return; }

  const norm = statsData.hr_normalization;
  // Normalized HR and goals are single-sport views; off the Overall
  // page where mixed sports make the numbers meaningless.
  const showNorm = sport !== null && norm && norm.predictors && norm.predictors.length;
  const withNorm = showNorm
    ? acts.map(a => ({ a, v: normHrOf(a, norm) })).filter(r => r.v != null)
    : [];

  holder.innerHTML = `
    ${sectionCard('training-streaks', 'Streaks', `<div id="streak-body"></div>`)}
    ${sectionCard('training-fitness', 'Fitness &amp; freshness', `
        <div style="height: 340px;"><canvas id="fitness-chart"></canvas></div>
        <p class="small text-muted mb-0 mt-2" id="fitness-note"></p>`)}
    ${sectionCard('training-load', `Training load`, `
        <div id="training-load-body"></div>`)}
    ${withNorm.length >= 10 ? sectionCard('training-normhr', 'Normalized HR — fitness trend', `
        <div style="height: 280px; position: relative;"><canvas id="norm-chart"></canvas></div>
        <div class="small text-muted mt-1" id="norm-note"></div>`) : ''}
    ${sport !== null ? sectionCard('training-goals', 'Goals', `<div id="goals-body"></div>`) : ''}
  `;
  bindSectionToggles(holder);

  renderStreaks(acts);
  renderFitness(acts);
  renderTrainingLoad(acts);
  if (withNorm.length >= 10) renderNormHr(withNorm, norm);
  if (sport !== null) renderGoals(acts);
  attachFullscreen(document.getElementById('fitness-chart')?.closest('.card'), document.getElementById('fitness-chart')?.parentElement);
  if (document.getElementById('norm-chart')) {
    attachFullscreen(document.getElementById('norm-chart').closest('.card'), document.getElementById('norm-chart').parentElement);
  }
}

function isoWeekKey(t) {
  const d = new Date(t);
  const day = (d.getUTCDay() + 6) % 7;   // Monday = 0
  d.setUTCDate(d.getUTCDate() - day);
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week1 = new Date(jan4);
  week1.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
  const w = 1 + Math.floor((d - week1) / (7 * 864e5));
  return `${d.getUTCFullYear()}-W${String(w).padStart(2, '0')}`;
}

function prevWeekKey(key) {
  const [y, w] = key.split('-W').map(Number);
  if (w > 1) return `${y}-W${String(w - 1).padStart(2, '0')}`;
  const jan4 = new Date(Date.UTC(y - 1, 0, 4));
  const week1 = new Date(jan4);
  week1.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
  const dec28 = new Date(Date.UTC(y - 1, 11, 28));
  const wLast = 1 + Math.floor((dec28 - week1) / (7 * 864e5));
  return `${y - 1}-W${String(wLast).padStart(2, '0')}`;
}

function nextWeekKey(key) {
  const [y, w] = key.split('-W').map(Number);
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const week1 = new Date(jan4);
  week1.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
  const dec28 = new Date(Date.UTC(y, 11, 28));
  const wLast = 1 + Math.floor((dec28 - week1) / (7 * 864e5));
  if (w < wLast) return `${y}-W${String(w + 1).padStart(2, '0')}`;
  return `${y + 1}-W01`;
}

function streakStats(list) {
  const weeks = new Set(list.map(a => isoWeekKey(a.start_time)));
  const sortedWeeks = [...weeks].sort();
  let current = 0;
  if (sortedWeeks.length) {
    let cursor = sortedWeeks[sortedWeeks.length - 1];
    current = 1;
    while (weeks.has(prevWeekKey(cursor))) {
      cursor = prevWeekKey(cursor);
      current++;
    }
  }
  let longest = 0;
  let run = 0;
  let prev = null;
  for (const w of sortedWeeks) {
    run = (prev && nextWeekKey(prev) === w) ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = w;
  }
  const first = list.length ? list[0].start_time.slice(0, 10) : null;
  const totalWeeks = first ? Math.max(1, Math.round((Date.now() - new Date(first)) / (7 * 864e5))) : 0;
  return { current, longest, active: weeks.size, totalWeeks };
}

function renderStreaks(acts) {
  const el = document.getElementById('streak-body');
  if (!el) return;
  const sportsPresent = [...new Set(acts.map(a => a.sport || 'cycling'))].sort();

  const card = (label, icon, st) => `
    <div class="col-6 col-lg-3">
      <div class="border rounded p-2">
        <div class="small fw-semibold mb-1">${icon} ${label}</div>
        <div class="d-flex justify-content-between small"><span class="text-muted">Current</span><strong>${st.current}</strong></div>
        <div class="d-flex justify-content-between small"><span class="text-muted">Longest</span><strong>${st.longest}</strong></div>
        <div class="d-flex justify-content-between small"><span class="text-muted">Active wks</span><strong>${st.active}${st.totalWeeks ? ' / ' + st.totalWeeks : ''}</strong></div>
      </div>
    </div>`;

  if (sport !== null) {
    const st = streakStats(acts);
    el.innerHTML = `
      <div class="row text-center g-3">
        <div class="col-4">
          <div class="border rounded p-2">
            <div class="stat-value">${st.current}</div>
            <div class="stat-label">Current streak (weeks)</div>
          </div>
        </div>
        <div class="col-4">
          <div class="border rounded p-2">
            <div class="stat-value">${st.longest}</div>
            <div class="stat-label">Longest streak (weeks)</div>
          </div>
        </div>
        <div class="col-4">
          <div class="border rounded p-2">
            <div class="stat-value">${st.active}</div>
            <div class="stat-label">Active weeks</div>
          </div>
        </div>
      </div>
      <p class="small text-muted mb-0 mt-2">A week counts if it has at least one ${sportMeta(sport).label.toLowerCase()}. Streak continues while you keep it up every week.</p>
    `;
    return;
  }

  const all = streakStats(acts);
  const perSport = sportsPresent.map(s => ({ sport: s, stats: streakStats(acts.filter(a => (a.sport || 'cycling') === s)) }));
  el.innerHTML = `
    <div class="row g-3">
      ${card('All sports', '🌐', all)}
      ${perSport.map(({ sport: s, stats }) => card(sportMeta(s).label, sportMeta(s).icon, stats)).join('')}
    </div>
    <p class="small text-muted mb-0 mt-2">A week counts if it has at least one activity of that sport. Streak continues while you keep it up every week.</p>
  `;
}

function renderFitness(acts) {
  const canvas = document.getElementById('fitness-chart');
  const note = document.getElementById('fitness-note');
  if (!canvas) return;
  const withLoad = acts.filter(a => a.training_load != null);

  if (!withLoad.length) {
    note.textContent = 'No training load data available.';
    return;
  }

  // Daily load: sum training_load on the day of the activity.
  const byDay = {};
  for (const a of withLoad) {
    const day = a.start_time.slice(0, 10);
    byDay[day] = (byDay[day] || 0) + a.training_load;
  }
  const days = Object.keys(byDay).sort();

  const first = new Date(days[0] + 'T00:00:00Z');
  const last = new Date(days[days.length - 1] + 'T00:00:00Z');
  const series = [];
  for (let d = new Date(first); d <= last; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    series.push({ day: key, load: byDay[key] || 0 });
  }

  // CTL: 42-day exponential moving average (fitness).
  // ATL: 7-day EMA (fatigue). TSB = CTL - ATL (form).
  const CTL_TC = 42, ATL_TC = 7;
  let ctl = null, atl = null;
  const ctlSeries = [], atlSeries = [], tsbSeries = [], labels = [];
  for (const p of series) {
    const kC = 1 - Math.exp(-1 / CTL_TC);
    const kA = 1 - Math.exp(-1 / ATL_TC);
    ctl = ctl == null ? p.load : ctl + kC * (p.load - ctl);
    atl = atl == null ? p.load : atl + kA * (p.load - atl);
    ctlSeries.push(+ctl.toFixed(1));
    atlSeries.push(+atl.toFixed(1));
    tsbSeries.push(+(ctl - atl).toFixed(1));
    labels.push(p.day.slice(5));
  }

  if (fitnessChart) fitnessChart.destroy();
  fitnessChart = new window.Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Fitness (Chronic Training Load, 42-day avg)', data: ctlSeries, borderColor: '#0d6efd', borderWidth: 2, pointRadius: 0, tension: 0.2 },
        { label: 'Fatigue (Acute Training Load, 7-day avg)', data: atlSeries, borderColor: '#dc3545', borderWidth: 2, pointRadius: 0, tension: 0.2 },
        { label: 'Form (Training Stress Balance = Fitness − Fatigue)', data: tsbSeries, borderColor: '#198754', borderWidth: 2, pointRadius: 0, tension: 0.2 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'top' } },
      scales: { x: { ticks: { maxTicksLimit: 12, maxRotation: 45 } } },
    }
  });

  const pct = Math.round(100 * withLoad.length / Math.max(1, acts.length));
  note.textContent = `Fitness = 42-day average of daily training load (long-term capacity). Fatigue = 7-day average (short-term tiredness). Form = Fitness − Fatigue: positive means rested, negative means carrying fatigue. Based on ${withLoad.length} of ${acts.length} activities (${pct}%) — older devices did not record training load.`;
}

function renderTrainingLoad(acts) {
  const body = document.getElementById('training-load-body');
  if (!body) return;
  const loadActs = acts.filter(a => a.training_load != null).slice()
    .sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
  if (loadActs.length < 3) {
    body.innerHTML = '<p class="text-muted mb-0">No training load data available.</p>';
    return;
  }
  body.innerHTML = '<div style="height: 240px; position: relative;"><canvas id="training-load-chart"></canvas></div>';
  if (loadChart) loadChart.destroy();
  loadChart = new window.Chart(document.getElementById('training-load-chart').getContext('2d'), {
    type: 'line',
    data: {
      labels: loadActs.map(a => a.start_time.slice(0, 10)),
      datasets: [{
        label: 'Training load',
        data: loadActs.map(a => a.training_load),
        borderColor: '#fd7e14',
        backgroundColor: 'rgba(253, 126, 20, 0.2)',
        borderWidth: 2,
        pointRadius: 1,
        fill: true,
        tension: 0.2,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { title: items => loadActs[items[0].dataIndex] ? loadActs[items[0].dataIndex].name || loadActs[items[0].dataIndex].start_time.slice(0, 10) : '' } }
      },
      scales: {
        x: { ticks: { maxTicksLimit: 12, maxRotation: 45 } },
        y: { title: { display: true, text: 'Load' }, beginAtZero: true },
      }
    }
  });
}

// Normalized HR: subtract the fitted effect of climb intensity,
// temperature and altitude so activities are comparable as if all
// done under the same conditions. Scatter + 90-day moving average.
let normChart = null;

function renderNormHr(withNorm, norm) {
  const canvas = document.getElementById('norm-chart');
  const note = document.getElementById('norm-note');
  if (!canvas) return;
  const sorted = withNorm.slice().sort((x, y) => (x.a.start_time || '').localeCompare(y.a.start_time || ''));
  const times = sorted.map(r => new Date(r.a.start_time).getTime());
  const normVals = sorted.map(r => r.v);

  const DAY = 86400000;
  const movAvg = normVals.map((_, i) => {
    let sum = 0, cnt = 0;
    for (let j = i; j >= 0 && times[i] - times[j] <= 90 * DAY; j--) {
      sum += normVals[j];
      cnt++;
    }
    return sum / cnt;
  });

  const predLabels = { climb_intensity: 'climb intensity (m/km)', temp_dev: 'temperature (°C from 20)', altitude_km: 'altitude (km)' };
  const coefs = norm.predictors.map(p => `${predLabels[p]}: ${norm.coef[p] > 0 ? '+' : ''}${norm.coef[p]}`).join(' · ');
  note.textContent =
    `Fitted on ${norm.n} activities (R²=${norm.r2}, ±${norm.std_err} bpm). Effects removed: ${coefs}. Each activity is shown as if done at your typical conditions; the line is a 90-day moving average.`;

  if (normChart) normChart.destroy();
  normChart = new window.Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      datasets: [
        {
          label: 'Normalized HR',
          data: sorted.map((r, i) => ({ x: times[i], y: r.v })),
          borderColor: 'transparent',
          pointRadius: 2,
          pointBackgroundColor: 'rgba(220, 53, 69, 0.45)',
          pointBorderWidth: 0,
          order: 2,
        },
        {
          label: '90-day average',
          data: movAvg.map((v, i) => ({ x: times[i], y: v })),
          borderColor: '#198754',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.25,
          fill: false,
          order: 1,
        },
        {
          label: 'Raw avg HR',
          data: sorted.map(r => ({ x: new Date(r.a.start_time).getTime(), y: r.a.avg_hr })),
          borderColor: 'rgba(108, 117, 125, 0.5)',
          borderWidth: 1,
          pointRadius: 0,
          tension: 0.25,
          order: 3,
        },
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      interaction: { mode: 'nearest', intersect: false },
      plugins: {
        legend: { display: true, labels: { boxWidth: 12, usePointStyle: true } },
        tooltip: {
          callbacks: {
            title: items => sorted[items[0].dataIndex] ? sorted[items[0].dataIndex].a.start_time.slice(0, 10) : '',
            label: i => `${i.dataset.label}: ${i.parsed.y.toFixed(1)} bpm`,
          }
        }
      },
      scales: {
        x: { type: 'linear', title: { display: true, text: 'Date' }, ticks: { maxTicksLimit: 10, callback: v => new Date(v).toISOString().slice(0, 7) } },
        y: { title: { display: true, text: 'HR (bpm)' }, beginAtZero: false },
      }
    }
  });
}

function renderGoals(acts) {
  const el = document.getElementById('goals-body');
  if (!el) return;
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;

  const inYear = acts.filter(a => a.start_time.slice(0, 4) == year);
  const yDist = inYear.reduce((s, a) => s + (a.distance || 0), 0);
  const yElev = inYear.reduce((s, a) => s + (a.ascent || 0), 0);
  const inMonth = acts.filter(a => a.start_time.startsWith(`${year}-${String(month).padStart(2, '0')}`));
  const mDist = inMonth.reduce((s, a) => s + (a.distance || 0), 0);
  const mElev = inMonth.reduce((s, a) => s + (a.ascent || 0), 0);

  const goals = JSON.parse(localStorage.getItem('trainingGoals') || '{}');
  el.innerHTML = `
    <div class="row g-3 mb-3">
      ${goalBar('Monthly distance', mDist, goals.monthDistance, 'km')}
      ${goalBar('Monthly elevation', mElev, goals.monthElevation, 'm')}
      ${goalBar('Yearly distance', yDist, goals.yearDistance, 'km')}
      ${goalBar('Yearly elevation', yElev, goals.yearElevation, 'm')}
    </div>
    <div class="row g-2">
      <div class="col-6 col-md-3">
        <label class="form-label small text-muted">Month distance goal (km)</label>
        <input type="number" min="0" class="form-control form-control-sm" id="goal-month-distance" value="${goals.monthDistance || ''}">
      </div>
      <div class="col-6 col-md-3">
        <label class="form-label small text-muted">Month elevation goal (m)</label>
        <input type="number" min="0" class="form-control form-control-sm" id="goal-month-elevation" value="${goals.monthElevation || ''}">
      </div>
      <div class="col-6 col-md-3">
        <label class="form-label small text-muted">Year distance goal (km)</label>
        <input type="number" min="0" class="form-control form-control-sm" id="goal-year-distance" value="${goals.yearDistance || ''}">
      </div>
      <div class="col-6 col-md-3">
        <label class="form-label small text-muted">Year elevation goal (m)</label>
        <input type="number" min="0" class="form-control form-control-sm" id="goal-year-elevation" value="${goals.yearElevation || ''}">
      </div>
    </div>
  `;
  const save = () => {
    const g = {
      monthDistance: +document.getElementById('goal-month-distance').value || null,
      monthElevation: +document.getElementById('goal-month-elevation').value || null,
      yearDistance: +document.getElementById('goal-year-distance').value || null,
      yearElevation: +document.getElementById('goal-year-elevation').value || null,
    };
    localStorage.setItem('trainingGoals', JSON.stringify(g));
    renderGoals(acts);
  };
  for (const id of ['goal-month-distance', 'goal-month-elevation', 'goal-year-distance', 'goal-year-elevation']) {
    document.getElementById(id).addEventListener('change', save);
  }
}

function goalBar(label, value, goal, unit) {
  if (!goal) return `
    <div class="col-6">
      <div class="border rounded p-2 text-center">
        <div class="stat-value">${Math.round(value).toLocaleString()} ${unit}</div>
        <div class="stat-label">${label} — set a goal →</div>
      </div>
    </div>`;
  const pct = Math.min(100, Math.round(100 * value / goal));
  const done = value >= goal;
  return `
    <div class="col-6">
      <div class="border rounded p-2">
        <div class="d-flex justify-content-between">
          <span class="small">${label}</span>
          <span class="small fw-semibold">${Math.round(value).toLocaleString()} / ${goal.toLocaleString()} ${unit}</span>
        </div>
        <div class="progress mt-1" style="height: 8px;">
          <div class="progress-bar ${done ? 'bg-success' : 'bg-primary'}" style="width: ${pct}%"></div>
        </div>
      </div>
    </div>`;
}
