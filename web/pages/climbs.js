import { fetchClimbs, fetchAllClimbNames, fetchClimbGroups, fetchRegions, fetchHeatmap, saveSegment, deleteSegment } from '../utils/api.js';import { fmtDate, fmtDistance, fmtElevation, fmtGrade, fmtSpeed, climbKey } from '../utils/format.js';
import { attachFullscreen } from '../utils/fullscreen.js';
import { baseLayer } from '../utils/mapTiles.js';

let allClimbs = [];
let allNames = {};
let allGroups = {};
let allRegions = {};
let regionsLoading = false;

// Column sorting state: key = column, dir = 'asc' | 'desc'.
let sortState = { key: 'date', dir: 'desc' };
// Difficulty metric shown in the single Difficulty column.
let difficultyMetric = 'fiets';
// Validation filter: 'all' | 'validated' | 'unvalidated'.
let validationFilter = 'all';

export async function renderClimbs() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div id="climbs-view">
      <h4 class="mb-3">All climbs</h4>
      <div class="card mb-3">
        <div class="card-body">
          <div class="row g-2 align-items-end">
            <div class="col-md-4">
              <label class="form-label small text-muted">Search</label>
              <input type="text" id="climb-search" class="form-control form-control-sm" placeholder="Name, place, category…">
            </div>
            <div class="col-md-3">
              <label class="form-label small text-muted">Difficulty metric</label>
              <select id="difficulty-metric" class="form-select form-select-sm">
                <option value="fiets" selected>Difficulty (FIETS)</option>
                <option value="cotacol">Cotacol points (profile)</option>
              </select>
            </div>
            <div class="col-md-2">
              <label class="form-label small text-muted">Validation</label>
              <select id="validation-filter" class="form-select form-select-sm">
                <option value="all" selected>All</option>
                <option value="validated">Validated ✓</option>
                <option value="unvalidated">Not validated</option>
              </select>
            </div>
            <div class="col-md-3">
              <label class="form-label small text-muted">Group by</label>
              <select id="climb-group" class="form-select form-select-sm">
                <option value="none">None</option>
                <option value="region">Region</option>
              </select>
            </div>
            <div class="col-md-2">
              <label class="form-label small text-muted">View</label>
              <div class="btn-group w-100" role="group">
                <button type="button" class="btn btn-sm btn-outline-secondary active" id="view-list-btn">List</button>
                <button type="button" class="btn btn-sm btn-outline-secondary" id="view-map-btn">Map</button>
                <button type="button" class="btn btn-sm btn-outline-secondary" id="view-heat-btn">Heat</button>
              </div>
            </div>
          </div>
          <div class="small text-muted mt-2">Click a column header to sort; click again to reverse.</div>
          <div class="row g-2 align-items-end mt-1 d-none" id="heat-controls">
            <div class="col-md-3">
              <label class="form-label small text-muted">Basemap</label>
              <select id="heat-basemap" class="form-select form-select-sm">
                <option value="esri">ESRI gray</option>
                <option value="topo">OpenTopoMap</option>
              </select>
            </div>
          </div>
          <div id="climbs-region-loading" class="small text-muted mt-2 d-none">Loading regions…</div>
        </div>
      </div>
      <div class="table-responsive" id="climbs-table-wrap">
        <table class="table table-sm table-striped">
          <thead>
            <tr id="climbs-head-row">
              <th data-sort="name" title="Click to sort">Name</th>
              <th data-sort="region" title="Click to sort">Region</th>
              <th data-sort="date" title="Click to sort">Lastly climbed</th>
              <th data-sort="category" title="Click to sort">Category</th>
              <th data-sort="length" title="Click to sort">Length</th>
              <th data-sort="ascent" title="Click to sort">Ascent</th>
              <th data-sort="avggrade" title="Click to sort">Avg grade</th>
              <th data-sort="steepest" title="Click to sort">Steepest 100m</th>
              <th data-sort="difficulty" title="Click to sort" id="difficulty-head">Difficulty</th>
              <th data-sort="times" title="Click to sort">Done</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody id="climbs-list-body"></tbody>
        </table>
      </div>
      <div id="climbs-map-wrap" class="d-none">
        <div class="card mb-3">
          <div class="card-header fw-semibold">Climbs map</div>
          <div class="card-body p-0">
            <div id="climbs-map" style="height: 70vh; border-radius: .375rem;"></div>
          </div>
        </div>
        <p class="small text-muted">Showing climb start points. Marker color = category. Click for details.</p>
      </div>
      <div id="climbs-heat-wrap" class="d-none">
        <div class="card mb-3">
          <div class="card-header fw-semibold">Ride heatmap</div>
          <div class="card-body p-0">
            <div id="climbs-heat" style="height: 70vh; border-radius: .375rem;"></div>
          </div>
        </div>
        <p class="small text-muted">Roads you have ridden most, by GPS pass frequency. Brighter = more passages.</p>
      </div>
      <p id="no-climbs" class="text-muted d-none">No climbs found.</p>
    </div>
    <div class="modal fade" id="modifySegmentModal" tabindex="-1" aria-hidden="true">
      <div class="modal-dialog modal-sm">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">Modify segment</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
          </div>
          <div class="modal-body">
            <form id="modify-segment-form">
              <input type="hidden" id="modify-activity-id">
              <input type="hidden" id="modify-old-start">
              <input type="hidden" id="modify-old-end">
              <div class="mb-2">
                <label class="form-label small">Start distance (m)</label>
                <input type="number" step="0.1" class="form-control form-control-sm" id="modify-start" required>
              </div>
              <div class="mb-2">
                <label class="form-label small">End distance (m)</label>
                <input type="number" step="0.1" class="form-control form-control-sm" id="modify-end" required>
              </div>
            </form>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-sm btn-outline-secondary" data-bs-dismiss="modal">Cancel</button>
            <button type="button" class="btn btn-sm btn-primary" id="modify-save-btn">Save</button>
          </div>
        </div>
      </div>
    </div>
  `;

  const [climbsData, names, groups] = await Promise.all([fetchClimbs(), fetchAllClimbNames(), fetchClimbGroups()]);
  allNames = names || {};
  allGroups = groups || {};
  allClimbs = flattenClimbs(climbsData.activities || []);
  renderList();
  loadRegionsOnce().catch(err => console.error('Failed to load regions', err));

  const listBody = document.getElementById('climbs-list-body');
  listBody.addEventListener('click', onCountryToggle);
  listBody.addEventListener('click', onRegionToggle);
  document.getElementById('climb-search').addEventListener('input', renderList);
  document.getElementById('climb-group').addEventListener('change', onGroupChange);
  document.getElementById('difficulty-metric').addEventListener('change', e => {
    difficultyMetric = e.target.value;
    renderList();
  });
  document.getElementById('validation-filter').addEventListener('change', e => {
    validationFilter = e.target.value;
    renderList();
  });
  document.getElementById('climbs-head-row').addEventListener('click', e => {
    const th = e.target.closest('th[data-sort]');
    if (!th) return;
    const key = th.dataset.sort;
    if (sortState.key === key) {
      sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
    } else {
      sortState.key = key;
      sortState.dir = key === 'name' || key === 'region' || key === 'category' ? 'asc' : 'desc';
    }
    renderList();
  });
  document.getElementById('view-list-btn').addEventListener('click', () => setView('list'));
  document.getElementById('view-map-btn').addEventListener('click', () => setView('map'));
  document.getElementById('view-heat-btn').addEventListener('click', () => setView('heat'));
  document.getElementById('heat-basemap').addEventListener('change', e => {
    heatBasemap = e.target.value;
    if (heatMap) applyHeatBasemap();
  });
  setupModifySegmentModal();
}

let climbsMap = null;
let climbsMapLayer = null;

const CATEGORY_MARKER_COLORS = {
  'HC': '#dc3545', 'Cat 1': '#fd7e14', 'Cat 2': '#ffc107',
  'Cat 3': '#20c997', 'Cat 4': '#198754', 'Uncategorized': '#adb5bd',
};

function setView(view) {
  const listWrap = document.getElementById('climbs-table-wrap');
  const mapWrap = document.getElementById('climbs-map-wrap');
  const heatWrap = document.getElementById('climbs-heat-wrap');
  const heatControls = document.getElementById('heat-controls');
  const listBtn = document.getElementById('view-list-btn');
  const mapBtn = document.getElementById('view-map-btn');
  const heatBtn = document.getElementById('view-heat-btn');
  listWrap.classList.toggle('d-none', view !== 'list');
  mapWrap.classList.toggle('d-none', view !== 'map');
  heatWrap.classList.toggle('d-none', view !== 'heat');
  heatControls.classList.toggle('d-none', view !== 'heat');
  listBtn.classList.toggle('active', view === 'list');
  mapBtn.classList.toggle('active', view === 'map');
  heatBtn.classList.toggle('active', view === 'heat');
  if (view === 'map') renderClimbsMap();
  if (view === 'heat') renderHeatmap();
  if (view === 'map') attachFullscreen(document.getElementById('climbs-map')?.closest('.card'), document.getElementById('climbs-map'), {
    onResize: () => { if (climbsMap) climbsMap.invalidateSize(); }
  });
  if (view === 'heat') attachFullscreen(document.getElementById('climbs-heat')?.closest('.card'), document.getElementById('climbs-heat'), {
    onResize: () => { if (heatMap) heatMap.invalidateSize(); }
  });
  if (view === 'list' && climbsMap) climbsMap.invalidateSize();
}

let heatMap = null;
let heatLayer = null;
let heatLoading = false;
let heatBaseLayer = null;
let heatRefLayer = null;
let heatBasemap = 'esri';
let heatTracks = null;
let heatBounds = null;

// Heat map color palettes (color-hex.com/palette/55783 shape):
// red->yellow on gray basemaps, blue->cyan on OpenTopoMap so the traces
// contrast with the terrain's warm browns/greens.
const HEAT_COLORS = ['#e93e3a', '#ed683c', '#f3903f', '#fdc70c', '#fff33b'];
const HEAT_COLORS_TOPO = ['#023fa5', '#2a6fd6', '#4a9be8', '#7ec8f0', '#b8e8f7'];

function applyHeatBasemap() {
  const dark = document.documentElement.getAttribute('data-bs-theme') === 'dark';
  if (heatBaseLayer) heatMap.removeLayer(heatBaseLayer);
  if (heatRefLayer) { heatMap.removeLayer(heatRefLayer); heatRefLayer = null; }
  if (heatBasemap === 'topo') {
    heatBaseLayer = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17,
      attribution: '&copy; OpenTopoMap (CC-BY-SA)'
    }).addTo(heatMap);
  } else {
    heatBaseLayer = null;
    baseLayer('gray', { center: [46, 6] }).then(l => { if (heatBaseLayer === null) { heatBaseLayer = l; l.addTo(heatMap); } });
    heatRefLayer = L.tileLayer(dark
      ? 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}'
      : 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19
    }).addTo(heatMap);
  }
  // Palette follows the basemap; redraw already-loaded tracks.
  if (heatLayer && heatTracks) {
    heatMap.removeLayer(heatLayer);
    heatLayer = null;
    drawHeatTracks();
  }
}

function drawHeatTracks() {
  const group = L.layerGroup();
  const canvasRenderer = L.canvas({ padding: 0.2 });
  const palette = heatBasemap === 'topo' ? HEAT_COLORS_TOPO : HEAT_COLORS;
  let rendered = 0;
  for (const tr of heatTracks) {
    if (!tr || tr.length < 2) continue;
    const latlngs = tr.map(p => [p[0], p[1]]);
    L.polyline(latlngs, {
      color: palette[rendered % palette.length],
      weight: 1.5, opacity: 0.25, renderer: canvasRenderer,
    }).addTo(group);
    rendered++;
  }
  group.addTo(heatMap);
  heatLayer = group;
}

async function renderHeatmap() {
  const div = document.getElementById('climbs-heat');
  if (!heatMap) {
    heatMap = L.map(div);
    applyHeatBasemap();
  }
  heatMap.invalidateSize();

  if (heatLayer) return;   // already loaded
  if (heatLoading) return;
  heatLoading = true;
  div.insertAdjacentHTML('afterbegin',
    '<div id="heat-loading" class="position-absolute top-50 start-50 translate-middle z-3 text-bg-secondary px-3 py-2 rounded">Loading heatmap…</div>');
  try {
    const data = await fetchHeatmap();
    heatTracks = data.tracks || [];
    const bounds = L.latLngBounds();
    for (const tr of heatTracks) {
      if (!tr || tr.length < 2) continue;
      bounds.extend(tr.map(p => [p[0], p[1]]));
    }
    drawHeatTracks();
    if (!bounds.isValid()) return;
    // Render at low zoom first (all lines), then let the user zoom in:
    // at city zoom opacity per line is enough to see hot spots.
    heatBounds = bounds;
    heatMap.fitBounds(bounds, { padding: [30, 30] });
  } catch (err) {
    console.error('heatmap failed', err);
  } finally {
    heatLoading = false;
    const loadingEl = document.getElementById('heat-loading');
    if (loadingEl) loadingEl.remove();
  }
}

function renderClimbsMap() {
  const div = document.getElementById('climbs-map');
  if (!climbsMap) {
    climbsMap = L.map(div);
    baseLayer('osm', { center: [46, 6] }).then(l => l.addTo(climbsMap));
    climbsMapLayer = L.layerGroup().addTo(climbsMap);
  }
  climbsMap.invalidateSize();
  climbsMapLayer.clearLayers();

  const withCoords = allClimbs.filter(c => c.start_lat != null && c.start_lon != null);
  const bounds = [];
  for (const c of withCoords) {
    const color = CATEGORY_MARKER_COLORS[c.category] || CATEGORY_MARKER_COLORS['Uncategorized'];
    const marker = L.circleMarker([c.start_lat, c.start_lon], {
      radius: 7, color: '#fff', weight: 1.5, fillColor: color, fillOpacity: 0.95,
    });
    marker.bindPopup(`
      <strong>${c.name ? escapeHtmlClimbs(c.name) : 'Unnamed climb'}</strong><br>
      <span class="badge bg-secondary">${c.category || 'Uncategorized'}</span>
      ${fmtElevation(c.elevation_gain_m)} · ${fmtDistance(c.length_m / 1000)} · ${fmtGrade(c.avg_grade_percent)}<br>
      Done ${c.groupSize} time${c.groupSize === 1 ? '' : 's'}<br>
      <a href="#climb/${c.key}">View climb</a>
    `);
    marker.addTo(climbsMapLayer);
    bounds.push([c.start_lat, c.start_lon]);
  }
  if (bounds.length) climbsMap.fitBounds(bounds, { padding: [30, 30] });
}

function escapeHtmlClimbs(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

async function onGroupChange() {
  const group = document.getElementById('climb-group').value;
  if (group === 'region' && Object.keys(allRegions).length === 0 && !regionsLoading) {
    regionsLoading = true;
    const loader = document.getElementById('climbs-region-loading');
    if (loader) loader.classList.remove('d-none');
    try {
      await loadRegionsOnce();
    } catch (err) {
      console.error('Failed to load regions', err);
    } finally {
      regionsLoading = false;
      if (loader) loader.classList.add('d-none');
    }
  } else {
    renderList();
  }
}

async function loadRegionsOnce() {
  // Regions load in the background on page entry so the Region column
  // is filled from the start; /api/regions returns instantly from the
  // cache. If some climbs have no region yet the server geocodes in
  // the background and we re-fetch when it finishes.
  if (regionsLoading) return;
  regionsLoading = true;
  const loader = document.getElementById('climbs-region-loading');
  if (loader && Object.keys(allRegions).length === 0) loader.classList.remove('d-none');
  try {
    const data = await fetchRegions();
    allRegions = data || {};
    allClimbs = allClimbs.map(c => ({ ...c, region: allRegions[c.key] || 'Unknown' }));
    renderList();
    if (data && data.warming) {
      await pollRegionsWarm();
    }
  } finally {
    regionsLoading = false;
    if (loader) loader.classList.add('d-none');
  }
}

async function pollRegionsWarm() {
  // Poll the background geocode; when done, refetch regions and re-render.
  while (true) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    let status = null;
    try {
      status = await fetchRegionsStatus();
    } catch (err) {
      console.warn('region status fetch failed', err);
    }
    if (!status || !status.running) break;
  }
  const data = await fetchRegions();
  allRegions = data || {};
  allClimbs = allClimbs.map(c => ({ ...c, region: allRegions[c.key] || 'Unknown' }));
  renderList();
}

function flattenClimbs(activities) {
  const keyToOccurrence = {};
  for (const act of activities) {
    for (const c of act.climbs || []) {
      const key = climbKey(act.activity_id, c.start_distance_m, c.end_distance_m);
      keyToOccurrence[key] = { ...c, key, startTime: act.start_time, activityId: act.activity_id, activityName: act.name };
    }
  }

  const groups = allGroups.groups || {};
  const keyToGroup = allGroups.key_to_group || {};
  const groupIds = new Set(Object.values(keyToGroup));
  const seenGroupIds = new Set();
  const list = [];

  function makeGroup(groupKeys) {
    const occurrences = groupKeys
      .map(k => keyToOccurrence[k])
      .filter(o => o != null);
    if (occurrences.length === 0) return null;
    const sorted = occurrences.slice().sort((a, b) => new Date(b.startTime || 0) - new Date(a.startTime || 0));
    // Prefer a validated occurrence as representative: its name and segment
    // bounds are the canonical, user-confirmed ones.
    const rep = sorted.find(o => o.validated_climb_id) || sorted[0];
    const nameEntry = allNames[rep.key];
    return {
      ...rep,
      key: rep.key,
      name: rep.validated_name || nameEntry?.name || null,
      lastClimbed: sorted[0].startTime,
      groupSize: groupKeys.length,
      region: allRegions[rep.key] || '—',
    };
  }

  for (const key of Object.keys(keyToOccurrence)) {
    const groupId = keyToGroup[key];
    if (groupId) {
      if (seenGroupIds.has(groupId)) continue;
      seenGroupIds.add(groupId);
      const group = makeGroup(groups[groupId] || [key]);
      if (group) list.push(group);
    } else {
      const group = makeGroup([key]);
      if (group) list.push(group);
    }
  }

  return list;
}

// Category rank for sorting: HC first, then Cat 1..4, uncategorized last.
const CATEGORY_RANK = { 'HC': 0, 'Cat 1': 1, 'Cat 2': 2, 'Cat 3': 3, 'Cat 4': 4, 'Uncategorized': 5 };

function sortValue(c, key) {
  switch (key) {
    case 'name': return (c.name || '').toLowerCase();
    case 'region': return (c.region || '').toLowerCase();
    case 'category': return CATEGORY_RANK[c.category] != null ? CATEGORY_RANK[c.category] : 6;
    case 'date': return new Date(c.lastClimbed || 0).getTime();
    case 'length': return c.length_m || 0;
    case 'ascent': return c.elevation_gain_m || 0;
    case 'avggrade': return c.avg_grade_percent || 0;
    case 'steepest': return c.steepest_100m_grade || 0;
    case 'difficulty': return difficultyOf(c) || 0;
    case 'times': return c.groupSize || 1;
    default: return 0;
  }
}

function difficultyOf(c) {
  if (difficultyMetric === 'cotacol') return c.cotacol_points != null ? c.cotacol_points : 0;
  return fietsList(c) != null ? fietsList(c) : 0;
}

function sortClimbs(list) {
  const { key, dir } = sortState;
  const mul = dir === 'asc' ? 1 : -1;
  return list.slice().sort((a, b) => {
    const va = sortValue(a, key), vb = sortValue(b, key);
    if (va < vb) return -1 * mul;
    if (va > vb) return 1 * mul;
    return 0;
  });
}

function updateSortIndicators() {
  for (const th of document.querySelectorAll('#climbs-head-row th[data-sort]')) {
    th.classList.toggle('sort-active', th.dataset.sort === sortState.key);
    const arrow = th.querySelector('.sort-arrow');
    if (arrow) arrow.remove();
    if (th.dataset.sort === sortState.key) {
      th.insertAdjacentHTML('beforeend',
        ` <span class="sort-arrow">${sortState.dir === 'asc' ? '↑' : '↓'}</span>`);
    }
  }
  const dh = document.getElementById('difficulty-head');
  if (dh) dh.title = difficultyMetric === 'cotacol'
    ? 'Cotacol points (profile-based, Climbfinder-style)'
    : 'Difficulty score (list version: no summit-altitude bonus)';
}

function renderList() {
  const term = (document.getElementById('climb-search').value || '').toLowerCase();
  const group = document.getElementById('climb-group').value;
  updateSortIndicators();

  let filtered = allClimbs.filter(c => {
    const text = `${c.name || ''} ${c.category || ''} ${c.region || ''}`.toLowerCase();
    if (term && !text.includes(term)) return false;
    if (validationFilter === 'validated' && !c.validated_climb_id) return false;
    if (validationFilter === 'unvalidated' && c.validated_climb_id) return false;
    return true;
  });

  const tbody = document.getElementById('climbs-list-body');
  const noClimbs = document.getElementById('no-climbs');
  tbody.innerHTML = '';

  if (filtered.length === 0) {
    noClimbs.classList.remove('d-none');
    return;
  }
  noClimbs.classList.add('d-none');

  if (group === 'region') {
    const grouped = {};
    for (const c of filtered) {
      const region = c.region || 'Unknown';
      if (!grouped[region]) grouped[region] = [];
      grouped[region].push(c);
    }
    const sortedRegions = Object.keys(grouped).sort((a, b) => {
      const countryA = regionToCountry(a);
      const countryB = regionToCountry(b);
      const userCountry = getUserCountry();
      if (countryA === userCountry && countryB !== userCountry) return -1;
      if (countryB === userCountry && countryA !== userCountry) return 1;
      if (countryA !== countryB) return countryA.localeCompare(countryB);
      return a.localeCompare(b);
    });

    let currentCountry = null;
    for (const region of sortedRegions) {
      const country = regionToCountry(region);
      if (country !== currentCountry) {
        const countryId = 'country-' + country.toLowerCase().replace(/[^a-z0-9]/g, '-');
        const countryHeading = document.createElement('tr');
        countryHeading.className = 'country-toggle table-primary';
        countryHeading.dataset.country = countryId;
        countryHeading.style.cursor = 'pointer';
        countryHeading.innerHTML = `<td colspan="11" class="fw-bold">
          <span class="me-2">▼</span>${escapeHtml(country)}
        </td>`;
        tbody.appendChild(countryHeading);
        currentCountry = country;
      }
      const rows = sortClimbs(grouped[region]);
      const regionId = 'region-' + region.toLowerCase().replace(/[^a-z0-9]/g, '-');
      const countryClass = 'country-' + currentCountry.toLowerCase().replace(/[^a-z0-9]/g, '-');
      const heading = document.createElement('tr');
      heading.className = 'region-toggle';
      heading.classList.add(countryClass);
      heading.dataset.region = regionId;
      heading.style.cursor = 'pointer';
      heading.innerHTML = `<td colspan="11" class="table-secondary fw-semibold ps-4">
        <span class="me-2">▼</span>${escapeHtml(region)} <span class="text-muted fw-normal">(${rows.length})</span>
      </td>`;
      tbody.appendChild(heading);
      for (const c of rows) {
        const row = buildClimbRow(c);
        row.classList.add(regionId, countryClass);
        tbody.appendChild(row);
      }
    }
  } else {
    const rows = sortClimbs(filtered);
    for (const c of rows) tbody.appendChild(buildClimbRow(c));
  }
}

function onCountryToggle(e) {
  const row = e.target.closest('.country-toggle');
  if (!row) return;
  const countryId = row.dataset.country;
  const expanded = !row.classList.contains('collapsed');
  row.classList.toggle('collapsed', expanded);
  const icon = row.querySelector('span');
  if (icon) icon.textContent = expanded ? '▶' : '▼';
  const groupRows = row.parentElement.querySelectorAll('.' + countryId);
  for (const r of groupRows) {
    r.classList.toggle('d-none', expanded);
  }
}

function onRegionToggle(e) {
  const row = e.target.closest('.region-toggle');
  if (!row) return;
  const regionId = row.dataset.region;
  const expanded = !row.classList.contains('collapsed');
  row.classList.toggle('collapsed', expanded);
  const icon = row.querySelector('span');
  if (icon) icon.textContent = expanded ? '▶' : '▼';
  const groupRows = row.parentElement.querySelectorAll('.' + regionId);
  for (const r of groupRows) {
    r.classList.toggle('d-none', expanded);
  }
}

// Difficulty score (list variant, based on the FIETS index): H²/(D×10)
// without the summit bonus, since the climbs list has no per-climb
// summit altitude. Same scale as the full score on the detail page.
function fietsList(c) {
  const H = c.elevation_gain_m || 0, D = c.length_m || 0;
  if (H <= 0 || D <= 0) return null;
  return H * H / (D * 10);
}

function difficultyCell(c) {
  if (difficultyMetric === 'cotacol') {
    return c.cotacol_points != null ? Math.round(c.cotacol_points) : '—';
  }
  return fietsList(c) != null ? fietsList(c).toFixed(1) : '—';
}

function buildClimbRow(c) {
  const row = document.createElement('tr');
  row.innerHTML = `
    <td><a href="#climb/${c.key}" class="text-decoration-none">${c.name ? escapeHtml(c.name) : '<span class="text-muted">Unnamed segment</span>'}</a>${c.validated_climb_id ? ' <span class="badge bg-success rounded-pill" title="Validated climb">✓</span>' : ''}</td>
    <td>${escapeHtml(c.region || '—')}</td>
    <td><a href="#activity/${c.activityId}" class="text-decoration-none">${fmtDate(c.startTime)}</a></td>
    <td><span class="badge bg-secondary category-badge">${c.category}</span></td>
    <td>${fmtDistance(c.length_m / 1000)}</td>
    <td>${fmtElevation(c.elevation_gain_m)}</td>
    <td>${fmtGrade(c.avg_grade_percent)}</td>
    <td>${c.steepest_100m_grade != null ? fmtGrade(c.steepest_100m_grade) : '—'}</td>
    <td>${difficultyCell(c)}</td>
    <td>${c.groupSize || 1}</td>
    <td>
      <button class="btn btn-sm btn-link py-0 modify-segment-btn" data-activity-id="${c.activityId}" data-start="${c.start_distance_m}" data-end="${c.end_distance_m}" title="Modify segment">✎</button>
      <button class="btn btn-sm btn-link py-0 text-danger delete-segment-btn" data-activity-id="${c.activityId}" data-start="${c.start_distance_m}" data-end="${c.end_distance_m}" title="Delete segment">×</button>
    </td>
  `;
  return row;
}

function setupModifySegmentModal() {
  const tbody = document.getElementById('climbs-list-body');
  const modalEl = document.getElementById('modifySegmentModal');
  if (!modalEl || !tbody) return;
  const modal = new window.bootstrap.Modal(modalEl);

  tbody.addEventListener('click', e => {
    const modifyBtn = e.target.closest('.modify-segment-btn');
    const deleteBtn = e.target.closest('.delete-segment-btn');
    if (modifyBtn) {
      document.getElementById('modify-activity-id').value = modifyBtn.dataset.activityId;
      document.getElementById('modify-old-start').value = modifyBtn.dataset.start;
      document.getElementById('modify-old-end').value = modifyBtn.dataset.end;
      document.getElementById('modify-start').value = modifyBtn.dataset.start;
      document.getElementById('modify-end').value = modifyBtn.dataset.end;
      modal.show();
    } else if (deleteBtn) {
      if (!confirm('Delete this segment?')) return;
      const activityId = deleteBtn.dataset.activityId;
      const start = parseFloat(deleteBtn.dataset.start);
      const end = parseFloat(deleteBtn.dataset.end);
      deleteSegment(activityId, start, end).then(() => window.location.reload()).catch(err => {
        console.error('Failed to delete segment', err);
        alert('Could not delete segment');
      });
    }
  });

  document.getElementById('modify-save-btn').addEventListener('click', async () => {
    const activityId = document.getElementById('modify-activity-id').value;
    const oldStart = parseFloat(document.getElementById('modify-old-start').value);
    const oldEnd = parseFloat(document.getElementById('modify-old-end').value);
    const start = parseFloat(document.getElementById('modify-start').value);
    const end = parseFloat(document.getElementById('modify-end').value);
    if (Number.isNaN(start) || Number.isNaN(end) || start >= end) {
      alert('Invalid distance range');
      return;
    }
    try {
      await saveSegment(activityId, start, end, oldStart, oldEnd);
      modal.hide();
      window.location.reload();
    } catch (err) {
      console.error('Failed to modify segment', err);
      alert('Could not save segment');
    }
  });
}

function regionToCountry(region) {
  if (!region || region === 'Unknown') return 'ZZZ';
  // Known French regions
  const france = new Set([
    'Auvergne-Rhône-Alpes', 'Bourgogne-Franche-Comté', 'Bretagne', 'Centre-Val de Loire',
    'Grand Est', 'Hauts-de-France', 'Île-de-France', 'Normandie', 'Nouvelle-Aquitaine',
    'Occitanie', 'Pays de la Loire', 'Provence-Alpes-Côte d\'Azur', 'Corse',
    'France métropolitaine',
  ]);
  if (france.has(region)) return 'France';
  if (region === 'Luxembourg') return 'Luxembourg';
  if (region === 'Namur') return 'Belgium';
  return region;
}

function getUserCountry() {
  // Could be replaced with profile-based detection later.
  return 'France';
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
