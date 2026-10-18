import { fetchClimbs } from '../utils/api.js';
import { fmtDate, fmtTime, fmtDuration, fmtDistance, fmtElevation, fmtSpeedOrPace, fmtHr } from '../utils/format.js';
import { sportMeta, hasClimbs, SPORTS } from '../utils/sports.js';
import { baseLayer } from '../utils/mapTiles.js';

let allActivities = [];
let sportFilter = 'all';

export async function renderHome(scope) {
  // Optional scope from the sidebar (#feed/<sport>): null/undefined keeps
  // the current filter, '' = all, or a sport name.
  if (scope !== undefined) sportFilter = scope || 'all';
  const app = document.getElementById('app');
  app.innerHTML = `
    <div id="home-view">
      <div class="d-flex justify-content-between align-items-center mb-3">
        <h4 class="mb-0">Activity feed</h4>
      </div>
      <div class="card mb-3">
        <div class="card-body">
          <div class="row g-2 align-items-end">
            <div class="col-md-4">
              <label class="form-label small text-muted">Search</label>
              <input type="text" id="search" class="form-control form-control-sm" placeholder="Name, place…">
            </div>
            <div class="col-md-3">
              <label class="form-label small text-muted">From</label>
              <input type="date" id="date-from" class="form-control form-control-sm">
            </div>
            <div class="col-md-3">
              <label class="form-label small text-muted">To</label>
              <input type="date" id="date-to" class="form-control form-control-sm">
            </div>
            <div class="col-md-2">
              <select id="sort" class="form-select form-select-sm">
                <option value="date-desc">Newest</option>
                <option value="date-asc">Oldest</option>
                <option value="distance-desc">Longest</option>
                <option value="ascent-desc">Most ascent</option>
                <option value="climbs-desc">Most climbs</option>
              </select>
            </div>
            <div class="col-6 col-md-2">
              <label class="form-label small text-muted">Min km</label>
              <input type="number" min="0" step="1" id="dist-min" class="form-control form-control-sm" placeholder="—">
            </div>
            <div class="col-6 col-md-2">
              <label class="form-label small text-muted">Max km</label>
              <input type="number" min="0" step="1" id="dist-max" class="form-control form-control-sm" placeholder="—">
            </div>
          </div>
          <div class="form-check form-switch mt-2">
            <input class="form-check-input" type="checkbox" id="has-climbs-only">
            <label class="form-check-label small" for="has-climbs-only">Only rides with climbs</label>
          </div>
          <div class="mt-2 d-flex gap-2 flex-wrap" id="sport-chips"></div>
        </div>
      </div>
      <div id="activity-feed"></div>
    </div>
  `;

  const climbsData = await fetchClimbs();
  allActivities = climbsData.activities || [];

  if (allActivities.length === 0) {
    renderSetupCard();
    return;
  }

  updateList();

  // Sport filter chips: All + one per sport present in the data.
  const sportsPresent = [...new Set(allActivities.map(a => a.sport || 'cycling'))];
  const chipsEl = document.getElementById('sport-chips');
  chipsEl.innerHTML = ['all', ...sportsPresent].map(s => {
    const meta = s === 'all' ? { icon: '🌐', label: 'All' } : sportMeta(s);
    const active = sportFilter === s;
    return `<button class="btn btn-sm ${active ? 'btn-primary' : 'btn-outline-secondary'} sport-chip" data-sport="${s}">${meta.icon} ${meta.label}</button>`;
  }).join('');
  chipsEl.querySelectorAll('.sport-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      sportFilter = chip.dataset.sport;
      chipsEl.querySelectorAll('.sport-chip').forEach(c => {
        const on = c.dataset.sport === sportFilter;
        c.className = `btn btn-sm ${on ? 'btn-primary' : 'btn-outline-secondary'} sport-chip`;
      });
      updateList();
    });
  });

  document.getElementById('search').addEventListener('input', () => updateList());
  document.getElementById('date-from').addEventListener('change', () => updateList());
  document.getElementById('date-to').addEventListener('change', () => updateList());
  document.getElementById('sort').addEventListener('change', () => updateList());
  document.getElementById('has-climbs-only').addEventListener('change', () => updateList());
  document.getElementById('dist-min').addEventListener('input', () => updateList());
  document.getElementById('dist-max').addEventListener('input', () => updateList());
}

function renderSetupCard() {
  const feed = document.getElementById('activity-feed');
  feed.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'card text-center mx-auto mt-5';
  card.style.maxWidth = '480px';
  card.innerHTML = `
    <div class="card-body p-4">
      <h5 class="card-title mb-2">No activities yet</h5>
      <p class="card-text text-muted">
        Point the app at your GarminDB data, or sync new activities if it is already configured.
      </p>
      <a href="#parameters" class="btn btn-primary">Configure</a>
    </div>
  `;
  feed.appendChild(card);
}

function updateList() {
  const term = document.getElementById('search').value.toLowerCase();
  const dateFrom = document.getElementById('date-from').value;
  const dateTo = document.getElementById('date-to').value;
  const sort = document.getElementById('sort').value;
  const climbsOnly = document.getElementById('has-climbs-only').checked;
  const distMin = parseFloat(document.getElementById('dist-min').value);
  const distMax = parseFloat(document.getElementById('dist-max').value);

  let filtered = allActivities.filter(a => {
    const text = `${a.name || ''} ${a.start_time || ''}`.toLowerCase();
    if (term && !text.includes(term)) return false;
    if (sportFilter !== 'all' && (a.sport || 'cycling') !== sportFilter) return false;
    if (climbsOnly && (a.climb_count || 0) === 0) return false;
    const km = a.distance_km || 0;
    if (Number.isFinite(distMin) && km < distMin) return false;
    if (Number.isFinite(distMax) && km > distMax) return false;
    if (dateFrom || dateTo) {
      const d = a.start_time ? new Date(a.start_time) : null;
      if (!d) return false;
      const day = d.toISOString().split('T')[0];
      if (dateFrom && day < dateFrom) return false;
      if (dateTo && day > dateTo) return false;
    }
    return true;
  });

  filtered.sort((a, b) => {
    if (sort === 'date-desc') return new Date(b.start_time) - new Date(a.start_time);
    if (sort === 'date-asc') return new Date(a.start_time) - new Date(b.start_time);
    if (sort === 'distance-desc') return (b.distance_km || 0) - (a.distance_km || 0);
    if (sort === 'ascent-desc') return (b.ascent_m || 0) - (a.ascent_m || 0);
    if (sort === 'climbs-desc') return (b.climb_count || 0) - (a.climb_count || 0);
    return 0;
  });

  renderFeed(filtered);
}

function renderFeed(activities) {
  const feed = document.getElementById('activity-feed');
  feed.innerHTML = '';

  if (activities.length === 0) {
    feed.innerHTML = '<div class="alert alert-light">No activities match.</div>';
    return;
  }

  for (const act of activities) {
    const card = document.createElement('div');
    card.className = 'card mb-3 activity-card';
    const date = fmtDate(act.start_time);
    const time = fmtTime(act.start_time);
    const meta = sportMeta(act.sport || 'cycling');
    const paceSport = act.sport || 'cycling';
    const j = act.journal;
    const photoHtml = j && j.first_photo ? `
      <div class="col-md-3 position-relative">
        <a href="#activity/${act.activity_id}" class="d-block">
          <img src="/api/media/${j.first_photo}" class="rounded border w-100" style="height:140px;object-fit:cover;" alt="Photo">
          ${j.photo_count > 1 ? `<span class="badge bg-dark position-absolute bottom-0 end-0 m-1">+${j.photo_count - 1}</span>` : ''}
        </a>
      </div>` : '';
    card.innerHTML = `
      <div class="card-header d-flex justify-content-between align-items-center">
        <a href="#activity/${act.activity_id}" class="text-decoration-none fw-semibold stretched-link-target">${meta.icon} ${act.name || meta.label}</a>
        <small class="text-muted">${date} · ${time}${j && j.has_note ? ' · 📝' : ''}</small>
      </div>
      <div class="card-body">
        <div class="row g-3">
          <div class="col-md-4">
            <div class="mini-map rounded border bg-light" id="map-${act.activity_id}" data-id="${act.activity_id}" data-lat="${act.start_lat || ''}" data-lon="${act.start_lon || ''}" style="height:140px;"></div>
          </div>
          <div class="col-md-${j && j.first_photo ? 5 : 8}">
            <div class="row g-2 mb-2">
              <div class="col-4"><div class="stat-value">${fmtDistance(act.distance_km)}</div><div class="stat-label">Distance</div></div>
              <div class="col-4"><div class="stat-value">${fmtDuration(act.moving_time_s)}</div><div class="stat-label">Moving time</div></div>
              <div class="col-4"><div class="stat-value">${fmtElevation(act.ascent_m)}</div><div class="stat-label">Ascent</div></div>
              <div class="col-4"><div class="stat-value">${fmtHr(act.avg_hr)}</div><div class="stat-label">Avg HR</div></div>
              <div class="col-4"><div class="stat-value">${fmtSpeedOrPace(paceSport, act.avg_speed)}</div><div class="stat-label">${hasClimbs(paceSport) ? 'Avg speed' : 'Avg pace'}</div></div>
              ${hasClimbs(paceSport) ? `<div class="col-4"><div class="stat-value">${act.climb_count || 0}</div><div class="stat-label">Climbs</div></div>` : ''}
            </div>
            <a href="#activity/${act.activity_id}" class="btn btn-sm btn-primary">Open ${hasClimbs(paceSport) ? 'ride' : 'activity'}</a>
            <button class="btn btn-sm btn-outline-secondary ms-2 download-btn" data-id="${act.activity_id}">Download FIT</button>
          </div>
          ${photoHtml}
        </div>
      </div>
    `;
    feed.appendChild(card);
  }

  initMiniMaps();
  initDownloadButtons();
}

function initMiniMaps() {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        const el = entry.target;
        observer.unobserve(el);
        loadMiniMap(el);
      }
    }
  }, { rootMargin: '100px' });

  document.querySelectorAll('.mini-map').forEach(el => observer.observe(el));
}

async function loadMiniMap(el) {
  const id = el.dataset.id;
  const fallbackLat = parseFloat(el.dataset.lat);
  const fallbackLon = parseFloat(el.dataset.lon);

  const map = L.map(el, {
    zoomControl: false,
    attributionControl: false,
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    boxZoom: false,
    keyboard: false
  });
  if (fallbackLat && fallbackLon) {
    map.setView([fallbackLat, fallbackLon], 12);
  } else {
    map.setView([20, 0], 2);
  }
  baseLayer().then(l => l.addTo(map));

  try {
    const res = await fetch(`/api/activity/${id}/polyline`);
    if (!res.ok) return;
    const points = await res.json();
    if (points && points.length > 1) {
      L.polyline(points, { color: '#0d6efd', weight: 2.5, opacity: 0.9 }).addTo(map);
      L.circleMarker(points[0], { radius: 7, color: '#ffffff', fillColor: '#198754', fillOpacity: 1, weight: 2, opacity: 1 }).addTo(map);
      L.circleMarker(points[points.length - 1], { radius: 7, color: '#ffffff', fillColor: '#dc3545', fillOpacity: 1, weight: 2, opacity: 1 }).addTo(map);
      map.fitBounds(points, { padding: [14, 14], maxZoom: 14 });
    } else if (fallbackLat && fallbackLon) {
      L.circleMarker([fallbackLat, fallbackLon], { radius: 4, color: '#0d6efd', fillOpacity: 0.9 }).addTo(map);
    }
  } catch (e) {
    if (fallbackLat && fallbackLon) {
      L.circleMarker([fallbackLat, fallbackLon], { radius: 4, color: '#0d6efd', fillOpacity: 0.9 }).addTo(map);
    }
  }
}

function initDownloadButtons() {
  document.getElementById('activity-feed').addEventListener('click', (e) => {
    const btn = e.target.closest('.download-btn');
    if (!btn) return;
    const id = btn.dataset.id;
    window.location.href = `/api/activity/${id}/download/fit`;
  });
}
