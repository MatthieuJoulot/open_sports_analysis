import { fetchProfile, startFetch, startAnalyze, fetchSyncStatus, fetchConfig } from '../utils/api.js';
import { SPORTS } from '../utils/sports.js';

let profileData = null;

export async function renderSidebar(activeSection = 'feed') {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  if (!profileData) {
    try {
      profileData = await fetchProfile();
    } catch (e) {
      profileData = { athlete: {}, all_time: {} };
    }
  }

  // Which sports get a sidebar section: the enabled list from config
  // (cycling first regardless, it owns the climb sections).
  let enabledSports;
  try {
    const cfg = await fetchConfig();
    enabledSports = (cfg.values?.sports || []).filter(s => SPORTS[s]);
  } catch (e) {
    enabledSports = Object.keys(SPORTS);
  }
  if (!enabledSports.length) enabledSports = Object.keys(SPORTS);
  const sportSections = ['cycling', ...enabledSports.filter(s => s !== 'cycling')];

  const athlete = profileData.athlete || {};

  const rawName = athlete.email ? athlete.email.split('@')[0] : 'Athlete';
  const displayName = rawName
    .replace(/[._]/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  // Compact athlete line: avatar + name only. The full resume (profile
  // stats, all-time totals, per-sport breakdown, YTD) lives on the
  // Overall statistics page.
  sidebar.innerHTML = `
    <div class="sidebar-sticky">
      <div class="card mb-3">
        <div class="card-body d-flex align-items-center gap-2 py-2">
          <div class="rounded-circle bg-secondary text-white d-inline-flex align-items-center justify-content-center flex-shrink-0" style="width:36px;height:36px;font-size:.9rem;font-weight:600;">
            ${displayName.charAt(0).toUpperCase()}
          </div>
          <h6 class="mb-0 text-truncate">${displayName}</h6>
        </div>
      </div>

      <button id="fetch-btn" class="btn btn-primary w-100 mb-2">
        <span id="fetch-btn-label">⬇ Fetch new activities</span>
      </button>
      <button id="analyze-btn" class="btn btn-outline-primary w-100 mb-3">
        <span id="analyze-btn-label">📊 Analyze activities</span>
      </button>

      <div class="list-group">
        <a href="#feed" class="list-group-item list-group-item-action fw-semibold ${activeSection === 'feed' ? 'active' : ''}">Activity feed</a>

        <a class="list-group-item list-group-item-action d-flex justify-content-between align-items-center ${activeSection.startsWith('overall') || activeSection === 'wiki-' ? 'active' : ''}"
           data-bs-toggle="collapse" href="#nav-overall" role="button"
           aria-expanded="${activeSection.startsWith('overall') || activeSection === 'wiki-' ? 'true' : 'false'}" aria-controls="nav-overall">
          🌐 Overall
          <span class="chevron">›</span>
        </a>
        <div class="collapse ${activeSection.startsWith('overall') || activeSection === 'wiki-' ? 'show' : ''}" id="nav-overall">
          <div class="list-group-item border-0 px-4 py-1">
            <a href="#statistics/" class="d-block py-1 text-decoration-none ${activeSection === 'overall-statistics' ? 'fw-semibold' : ''}">Statistics</a>
            <a href="#wiki" class="d-block py-1 text-decoration-none ${activeSection === 'wiki-' ? 'fw-semibold' : ''}">Wiki</a>
          </div>
        </div>

        ${sportSections.map(s => {
          const meta = SPORTS[s];
          const active = activeSection.startsWith(s) || activeSection === `wiki-${s}` || (s === 'cycling' && ['climbs', 'explore'].includes(activeSection));
          const expanded = active ? 'show' : '';
          const aria = active ? 'true' : 'false';
          const links = [
            `<a href="#feed/${s}" class="d-block py-1 text-decoration-none ${activeSection === `${s}-feed` ? 'fw-semibold' : ''}">Activity feed</a>`,
            ...(s === 'cycling' ? [
              `<a href="#climbs" class="d-block py-1 text-decoration-none ${activeSection === 'climbs' ? 'fw-semibold' : ''}">Climbs</a>`,
              `<a href="#explore" class="d-block py-1 text-decoration-none ${activeSection === 'explore' ? 'fw-semibold' : ''}">Explore climbs</a>`,
            ] : []),
            `<a href="#statistics/${s}" class="d-block py-1 text-decoration-none ${activeSection === `${s}-statistics` ? 'fw-semibold' : ''}">Statistics</a>`,
            `<a href="#wiki/${s}" class="d-block py-1 text-decoration-none ${activeSection === `wiki-${s}` ? 'fw-semibold' : ''}">Wiki</a>`,
          ].join('');
          return `
        <a class="list-group-item list-group-item-action d-flex justify-content-between align-items-center ${active ? 'active' : ''}"
           data-bs-toggle="collapse" href="#nav-${s}" role="button"
           aria-expanded="${aria}" aria-controls="nav-${s}">
          ${meta.icon} ${meta.label}
          <span class="chevron">›</span>
        </a>
        <div class="collapse ${expanded}" id="nav-${s}">
          <div class="list-group-item border-0 px-4 py-1">
            ${links}
          </div>
        </div>`;
        }).join('')}

        <a href="#parameters" class="list-group-item list-group-item-action ${activeSection === 'parameters' ? 'active' : ''}">⚙️ Parameters</a>
      </div>
    </div>
  `;

  // Chevron rotation on section expand/collapse.
  sidebar.querySelectorAll('[data-bs-toggle="collapse"]').forEach(toggle => {
    const target = document.querySelector(toggle.getAttribute('href'));
    if (!target) return;
    target.addEventListener('shown.bs.collapse', () => toggle.setAttribute('aria-expanded', 'true'));
    target.addEventListener('hidden.bs.collapse', () => toggle.setAttribute('aria-expanded', 'false'));
  });

  document.getElementById('fetch-btn').addEventListener('click', e => onJobClick(e, 'fetch'));
  document.getElementById('analyze-btn').addEventListener('click', e => onJobClick(e, 'analyze'));
}

let syncing = false;

const PHASE_LABELS = {
  starting: 'Starting…',
  garmindb: 'Downloading from Garmin Connect…',
  analysis: 'Detecting climbs…',
  groups: 'Grouping climbs…',
  done: 'Done',
  failed: 'Failed',
};

const JOB_LABELS = {
  fetch: { running: 'Fetching…', idle: '⬇ Fetch new activities', done: 'Fetch done' },
  analyze: { running: 'Analyzing…', idle: '📊 Analyze activities', done: 'Analysis done' },
};

async function onJobClick(e, kind) {
  const btn = e.currentTarget;
  const label = btn.querySelector('span');
  if (!btn || syncing) return;

  syncing = true;
  document.getElementById('fetch-btn').disabled = true;
  document.getElementById('analyze-btn').disabled = true;
  label.innerHTML = `<span class="spinner-border spinner-border-sm me-2" role="status"></span>${JOB_LABELS[kind].running}`;

  try {
    const started = kind === 'fetch' ? await startFetch() : await startAnalyze();
    if (!started.ok) throw new Error(started.error || 'Failed to start');
    await pollJobUntilDone(kind, label);
  } catch (e2) {
    showSyncToast(e2.message || 'Failed', 'danger');
  } finally {
    syncing = false;
    const fetchBtn = document.getElementById('fetch-btn');
    const analyzeBtn = document.getElementById('analyze-btn');
    if (fetchBtn) {
      fetchBtn.disabled = false;
      fetchBtn.querySelector('span').textContent = JOB_LABELS.fetch.idle;
    }
    if (analyzeBtn) {
      analyzeBtn.disabled = false;
      analyzeBtn.querySelector('span').textContent = JOB_LABELS.analyze.idle;
    }
  }
}

async function pollJobUntilDone(kind, label) {
  while (true) {
    await new Promise(r => setTimeout(r, 3000));
    let status;
    try {
      status = await fetchSyncStatus();
    } catch (e) {
      showSyncToast('Lost connection to server', 'danger');
      return;
    }
    if (status.running) {
      const phase = PHASE_LABELS[status.phase] || JOB_LABELS[kind].running;
      label.innerHTML = `<span class="spinner-border spinner-border-sm me-2" role="status"></span>${phase}`;
      continue;
    }
    if (status.result && status.result.ok) {
      const r = status.result;
      if (kind === 'fetch') {
        showSyncToast('New activities downloaded and imported. Run Analyze to process them.', 'success');
      } else {
        const parts = [];
        parts.push(r.new_activities > 0 ? `${r.new_activities} new activit${r.new_activities > 1 ? 'ies' : 'y'}` : 'no new activities');
        if (r.new_climbs > 0) parts.push(`${r.new_climbs} new climb${r.new_climbs > 1 ? 's' : ''}`);
        showSyncToast(parts.join(', '), 'success');
        profileData = null;
        await renderSidebar(location.hash.replace('#', '') || 'feed');
      }
    } else {
      showSyncToast((status.result && status.result.error) || status.error || 'Failed', 'danger');
    }
    return;
  }
}

function showSyncToast(message, variant) {
  let container = document.getElementById('sync-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'sync-toast-container';
    container.className = 'toast-container position-fixed top-0 end-0 p-3';
    container.style.zIndex = '1090';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast align-items-center text-bg-${variant} border-0`;
  toast.setAttribute('role', 'alert');
  toast.innerHTML = `
    <div class="d-flex">
      <div class="toast-body">${message}</div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
    </div>
  `;
  container.appendChild(toast);
  const bsToast = new bootstrap.Toast(toast, { delay: 5000 });
  bsToast.show();
  toast.addEventListener('hidden.bs.toast', () => toast.remove());
}

export function hideSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (sidebar) sidebar.classList.add('d-none');
}

export function showSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (sidebar) sidebar.classList.remove('d-none');
}
