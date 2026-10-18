import { fetchActivityDetails, fetchActivityRecords, fetchClimbNames, saveClimbName, identifySegments, saveSegment, validateClimb, deleteActivity, fetchClimbMatches, fetchJournal, saveJournalNote, uploadJournalPhoto, deleteJournalPhoto } from '../utils/api.js';
import { openSegmentEditor } from '../components/segmentEditor.js?v=2';
import { openSegmentAnalysis } from '../components/segmentAnalysis.js';
import { openSegmentPicker } from '../components/segmentPicker.js';
import { attachFullscreen } from '../utils/fullscreen.js';
import { loadRiderWeightKg, estimateClimbWkg } from '../utils/estPower.js';
import { fmtDate, fmtTime, fmtDuration, fmtDistance, fmtElevation, fmtGrade, fmtSpeed, fmtSpeedOrPace, fmtHr, climbKey } from '../utils/format.js';
import { sportMeta, hasClimbs as sportHasClimbs, usesPace } from '../utils/sports.js';

let elevationChart = null;
let graphsChart = null;
let graphsChartRendered = false;
const selectedMeasures = new Set();
let map = null;
let climbNameMap = {};
let currentActivityId = null;

export async function renderActivity(activityId) {
  currentActivityId = activityId;
  const app = document.getElementById('app');
  app.innerHTML = `
    <div id="activity-view">
      <div id="activity-header" class="mb-3"></div>

      <div class="card mb-3 activity-section" id="journal-card">
        <button class="card-header btn btn-link text-decoration-none w-100 text-start fw-semibold collapsed" data-bs-toggle="collapse" data-bs-target="#section-journal" id="journal-toggle" aria-expanded="false">
          <span class="chevron me-2"></span>Journal
        </button>
        <div class="collapse" id="section-journal">
          <div class="card-body">
            <textarea id="journal-note" class="form-control" rows="3" placeholder="How was this activity?"></textarea>
            <button id="journal-save-btn" class="btn btn-sm btn-outline-primary mt-2">Save note</button>
            <span id="journal-saved-msg" class="small text-success ms-2 d-none">Saved ✓</span>
            <div id="journal-photos" class="row g-2 mt-2"></div>
            <div class="d-flex gap-2 mt-2 align-items-center">
              <label class="btn btn-sm btn-outline-secondary mb-0" for="journal-photo-input">Add photos</label>
              <input type="file" id="journal-photo-input" accept="image/jpeg,image/png,image/webp,image/heic" multiple class="d-none">
              <span id="journal-upload-msg" class="small text-muted"></span>
            </div>
          </div>
        </div>
      </div>

      <div class="card mb-3 activity-section">
        <div class="card-header fw-semibold">Map</div>
        <div class="collapse show" id="section-map">
          <div class="card-body p-2"><div id="map"></div></div>
        </div>
      </div>

      <div class="card mb-3 activity-section" id="hr-zones-card" style="display:none;">
        <button class="card-header btn btn-link text-decoration-none w-100 text-start fw-semibold collapsed" data-bs-toggle="collapse" data-bs-target="#section-hr-zones" aria-expanded="false">
          <span class="chevron me-2"></span>Heart rate zones
        </button>
        <div class="collapse" id="section-hr-zones">
          <div class="card-body">
            <div id="hr-zones-body"></div>
          </div>
        </div>
      </div>

      <div class="card mb-3 activity-section">
        <div class="card-header fw-semibold">Elevation profile</div>
        <div class="collapse show" id="section-elevation">
          <div class="card-body p-2"><canvas id="elevation-chart"></canvas></div>
        </div>
      </div>

      <div class="card mb-3 activity-section">
        <button class="card-header btn btn-link text-decoration-none w-100 text-start fw-semibold collapsed" data-bs-toggle="collapse" data-bs-target="#section-climbs" aria-expanded="false">
          <span class="chevron me-2"></span>Detected climbs
        </button>
        <div class="collapse" id="section-climbs">
          <div class="card-body">
            <button id="identify-segments-btn" class="btn btn-sm btn-outline-primary mb-2">Identify segments</button>
            <div id="climbs-loading" class="small text-muted mb-2 d-none">Looking up names from OpenStreetMap…</div>
            <div class="table-responsive">
              <table class="table table-sm table-striped">
                <thead><tr><th>#</th><th>Name</th><th>Category</th><th>Start (km)</th><th>Length (km)</th><th>Elev. gain</th><th>Avg grade</th><th>Steepest 100m</th><th>VAM</th><th>W/kg</th><th>Δ PR</th></tr></thead>
                <tbody id="climbs-body"></tbody>
              </table>
            </div>
            <p id="no-climbs" class="text-muted d-none">No sustained climbs found.</p>
            <div id="candidate-segments" class="d-none"></div>
            <p class="small text-muted mt-2 mb-0">Names from OpenStreetMap contributors · ODbL</p>
          </div>
        </div>
      </div>

      <div class="card mb-3 activity-section" id="graphs-card">
        <button class="card-header btn btn-link text-decoration-none w-100 text-start fw-semibold collapsed" data-bs-toggle="collapse" data-bs-target="#section-graphs" aria-expanded="false">
          <span class="chevron me-2"></span>Graphs
        </button>
        <div class="collapse" id="section-graphs">
          <div class="card-body p-2">
            <div id="graphs-measures" class="d-flex align-items-center flex-wrap gap-3 mb-2"></div>
            <div style="height: 320px; position: relative;">
              <canvas id="graphs-chart"></canvas>
            </div>
          </div>
        </div>
      </div>

      <div class="card mb-3 activity-section">
        <button class="card-header btn btn-link text-decoration-none w-100 text-start fw-semibold collapsed" data-bs-toggle="collapse" data-bs-target="#section-laps" aria-expanded="false">
          <span class="chevron me-2"></span>Laps
        </button>
        <div class="collapse" id="section-laps">
          <div class="card-body">
            <div class="table-responsive">
              <table class="table table-sm table-striped">
                <thead><tr><th>#</th><th>Distance</th><th>Moving time</th><th>Avg speed</th><th>Ascent</th><th>Avg HR</th></tr></thead>
                <tbody id="laps-body"></tbody>
              </table>
            </div>
            <p id="no-laps" class="text-muted d-none">No lap data available.</p>
          </div>
        </div>
      </div>
    </div>
  `;

  const details = await fetchActivityDetails(activityId);
  const records = await fetchActivityRecords(activityId, 'distance,altitude,hr,speed,timestamp,position_lat,position_long,cadence,power,temperature', 3000);
  const riderKg = await loadRiderWeightKg();
  const sport = details.activity?.sport || 'cycling';

  renderHeader(details, activityId, sport, records);
  renderHrZones(details.activity || {}, sport);
  setupDeleteActivity(activityId, details.activity);
  // Laps + graphs read speed as pace for foot sports.
  const isPace = usesPace(sport);
  const lapsHead = document.querySelector('#section-laps thead th:nth-child(4)');
  if (lapsHead) lapsHead.textContent = isPace ? 'Avg pace' : 'Avg speed';
  const climbsCard = document.querySelector('#section-climbs')?.closest('.card');
  if (climbsCard && !sportHasClimbs(sport)) {
    // Climb detection is cycling-only; hide the section for other sports.
    climbsCard.classList.add('d-none');
  }
  const elevationCard = document.getElementById('section-elevation')?.closest('.card');
  if (elevationCard && !sportHasClimbs(sport)) {
    // Elevation profile is climb analysis; noise for foot sports.
    elevationCard.classList.add('d-none');
  }
  renderClimbsTable(activityId, details.climbs || [], records, riderKg);
  setupJournal(activityId);
  renderLapsTable(details.laps || [], isPace);
  renderMap(records, details.climbs || [], sport);
  if (sportHasClimbs(sport)) renderElevationChart(records, details.climbs || []);
  renderGraphsChartDeferred(records, details.sensors || {}, sport);
  attachFullscreen(document.getElementById('section-map')?.closest('.card'), document.getElementById('map'), {
    onResize: () => { if (map) { map.invalidateSize(); } }
  });
  attachFullscreen(document.getElementById('section-elevation')?.closest('.card'), document.getElementById('section-elevation')?.querySelector('.card-body'));
  attachFullscreen(document.getElementById('section-graphs')?.closest('.card'), document.getElementById('section-graphs')?.querySelector('.card-body'));
  setupClimbNameLoading(activityId);
  setupIdentifySegments(activityId);
}

function renderHeader(details, activityId, sport = 'cycling', records = []) {
  const act = details.activity;
  const meta = sportMeta(sport);
  const speedLabel = meta.pace ? 'pace' : 'speed';
  const header = document.getElementById('activity-header');
  const deviceBadges = (details.devices || []).map(d => {
    const label = [d.manufacturer, d.product && d.product !== 'invalid' ? d.product : null, d.type]
      .filter(Boolean).join(' · ') || d.serial;
    return `<span class="badge bg-light text-dark border me-1">${label}</span>`;
  }).join('');

  // Tile set: core tiles always; sensor-dependent tiles only when the
  // activity actually carries the data (no "3127 m" temperature sentinel,
  // no "-" placeholders). Cadence reads ×2 for foot sports (one-foot
  // records in GarminDB, Garmin Connect shows steps/min).
  const tile = (value, label) =>
    `<div class="col-6 col-md-3"><div class="card text-center p-2"><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div></div>`;
  const tiles = [
    tile(fmtDistance(act.distance), 'Distance'),
    tile(fmtDuration(act.moving_time), 'Moving time'),
    act.elapsed_time != null ? tile(fmtDuration(act.elapsed_time), 'Elapsed time') : '',
    act.ascent != null ? tile(fmtElevation(act.ascent), 'Ascent') : '',
    act.descent != null ? tile(fmtElevation(act.descent), 'Descent') : '',
    act.avg_speed != null ? tile(fmtSpeedOrPace(sport, act.avg_speed), `Avg ${speedLabel}`) : '',
    act.max_speed != null ? tile(fmtSpeedOrPace(sport, act.max_speed), `Max ${speedLabel}`) : '',
    details.avg_hr != null ? tile(fmtHr(details.avg_hr), 'Avg HR') : '',
    details.max_hr != null ? tile(fmtHr(details.max_hr), 'Max HR') : '',
    act.calories ? tile(Math.round(act.calories).toLocaleString(), 'Calories') : '',
    act.avg_cadence != null ? tile(Math.round(usesPace(sport) ? act.avg_cadence * 2 : act.avg_cadence) + (usesPace(sport) ? ' spm' : ' rpm'), 'Avg cadence') : '',
  ];
  // Average temperature from records (the activities table's column is
  // mostly the 127 sentinel).
  const temps = records.map(r => r.temperature).filter(t => t != null && t > -50 && t < 60);
  if (temps.length) {
    const avgT = temps.reduce((s, v) => s + v, 0) / temps.length;
    tiles.push(tile(`${avgT.toFixed(0)}°C`, 'Avg temperature'));
  }

  header.innerHTML = `
    <div class="d-flex justify-content-between align-items-start">
      <div>
        <h3>${meta.icon} ${act.name || meta.label}</h3>
        <p class="text-muted mb-2">${fmtDate(act.start_time)} · ${fmtTime(act.start_time)}</p>
        ${deviceBadges ? `<div class="mb-3">${deviceBadges}</div>` : ''}
      </div>
      <div class="d-flex gap-2">
        <a href="#flyover/${activityId}" class="btn btn-sm btn-outline-primary" id="flyover-btn" title="3D flyover of this activity">▶ Flyover</a>
        <button id="delete-activity-btn" class="btn btn-sm btn-outline-danger" title="Delete this activity locally">Delete</button>
      </div>
    </div>
    <div class="row g-2">
      ${tiles.join('')}
    </div>
  `;
}

// HR zone distribution: time in each of the 5 device zones (Garmin
// method: % of max HR). Rows show the zone's bpm range, time and share;
// a horizontal stacked bar gives the at-a-glance split.
const HR_ZONE_COLORS = ['#adb5bd', '#0d6efd', '#20c997', '#ffc107', '#dc3545'];
function renderHrZones(act, sport) {
  const card = document.getElementById('hr-zones-card');
  const body = document.getElementById('hr-zones-body');
  if (!card || !body) return;
  const zoneTimes = [act.hrz_1_time, act.hrz_2_time, act.hrz_3_time, act.hrz_4_time, act.hrz_5_time]
    .map(v => (typeof v === 'number' ? v : null));
  if (!zoneTimes.some(v => v != null && v > 0)) return;   // no zone data
  const bounds = [act.hrz_1_hr, act.hrz_2_hr, act.hrz_3_hr, act.hrz_4_hr, act.hrz_5_hr];
  const total = zoneTimes.reduce((s, v) => s + (v || 0), 0) || 1;

  const rows = zoneTimes.map((t, i) => {
    // hrz_N_hr is zone N's upper bound; zone N's floor is zone N-1's
    // upper bound (zone 1 starts at 0).
    const upper = bounds[i] != null ? bounds[i] : null;
    const lower = i > 0 ? bounds[i - 1] : null;
    let range = `Zone ${i + 1}`;
    if (i === 0 && upper != null) range = `< ${Math.round(upper)}`;
    else if (upper != null && lower != null) range = `${Math.round(lower)}–${Math.round(upper)}`;
    else if (upper == null && lower != null) range = `${Math.round(lower)}+`;
    const pct = ((t || 0) / total) * 100;
    return { t: t || 0, range, pct };
  });

  body.innerHTML = `
    <div class="d-flex mb-2" style="height: 14px; border-radius: 4px; overflow: hidden;">
      ${rows.map((r, i) => r.t > 0 ? `<div title="Zone ${i + 1}: ${fmtDuration(r.t)}" style="flex:${r.t};background:${HR_ZONE_COLORS[i]};"></div>` : '').join('')}
    </div>
    <div class="table-responsive">
      <table class="table table-sm mb-0">
        <thead><tr><th>Zone</th><th>HR range (bpm)</th><th>Time</th><th class="text-end">Share</th></tr></thead>
        <tbody>
          ${rows.map((r, i) => `
            <tr>
              <td><span style="color:${HR_ZONE_COLORS[i]};">■</span> Zone ${i + 1}</td>
              <td>${r.range}</td>
              <td>${fmtDuration(r.t)}</td>
              <td class="text-end">${r.pct.toFixed(0)}%</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  card.style.display = '';
}

function setupDeleteActivity(activityId, act) {
  const btn = document.getElementById('delete-activity-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const label = act?.name || 'this activity';
    const ok = confirm(`Delete "${label}" locally?\n\nRemoves it from the analyzer, GarminDB and downloaded files. The activity stays on Garmin Connect, but syncs will not re-import it.`);
    if (!ok) return;
    btn.disabled = true;
    btn.textContent = 'Deleting…';
    try {
      await deleteActivity(activityId);
      window.location.hash = '#feed';
      window.location.reload();
    } catch (err) {
      alert(err.message || 'Delete failed');
      btn.disabled = false;
      btn.textContent = 'Delete';
    }
  });
}

async function setupJournal(activityId) {
  const noteEl = document.getElementById('journal-note');
  const saveBtn = document.getElementById('journal-save-btn');
  const savedMsg = document.getElementById('journal-saved-msg');
  const photosEl = document.getElementById('journal-photos');
  const input = document.getElementById('journal-photo-input');
  const uploadMsg = document.getElementById('journal-upload-msg');
  if (!noteEl) return;

  let entry;
  try {
    entry = await fetchJournal(activityId);
  } catch (err) {
    uploadMsg.textContent = 'Journal unavailable.';
    return;
  }
  noteEl.value = entry.note || '';

  // Empty journal starts collapsed (nothing to read); with a note or
  // photos it opens right away.
  if (entry.note || (entry.photos || []).length) {
    const collapseEl = document.getElementById('section-journal');
    const toggle = document.getElementById('journal-toggle');
    if (collapseEl) {
      collapseEl.classList.add('show');
      toggle?.classList.remove('collapsed');
      toggle?.setAttribute('aria-expanded', 'true');
    }
  }

  const renderPhotos = photos => {
    photosEl.innerHTML = (photos || []).map(p => `
      <div class="col-6 col-md-3 position-relative journal-photo-item" data-file="${p.file}">
        <img src="/api/media/${p.file}" class="img-fluid rounded w-100 journal-photo-img" style="height: 120px; object-fit: cover; cursor: pointer;" alt="Photo">
        <button class="btn btn-sm btn-danger position-absolute top-0 end-0 m-1 journal-photo-del" title="Delete photo">×</button>
      </div>
    `).join('');
  };
  renderPhotos(entry.photos);

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      await saveJournalNote(activityId, noteEl.value);
      savedMsg.classList.remove('d-none');
      setTimeout(() => savedMsg.classList.add('d-none'), 2000);
    } catch (err) {
      alert('Could not save note: ' + (err?.message || err));
    } finally {
      saveBtn.disabled = false;
    }
  });

  input.addEventListener('change', async () => {
    const files = [...input.files];
    input.value = '';
    if (!files.length) return;
    for (const f of files) {
      uploadMsg.textContent = `Uploading ${f.name}…`;
      try {
        const r = await uploadJournalPhoto(activityId, f);
        // Re-render from the server list:
        const fresh = await fetchJournal(activityId);
        renderPhotos(fresh.photos);
        uploadMsg.textContent = '';
      } catch (err) {
        uploadMsg.textContent = err?.message || 'Upload failed';
      }
    }
  });

  photosEl.addEventListener('click', async e => {
    const del = e.target.closest('.journal-photo-del');
    if (del) {
      const file = del.closest('.journal-photo-item').dataset.file;
      try {
        await deleteJournalPhoto(activityId, file);
        const fresh = await fetchJournal(activityId);
        renderPhotos(fresh.photos);
      } catch (err) {
        alert('Could not delete photo: ' + (err?.message || err));
      }
      return;
    }
    const img = e.target.closest('.journal-photo-img');
    if (img) {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:2000;display:flex;align-items:center;justify-content:center;cursor:zoom-out;';
      overlay.innerHTML = `<img src="${img.src}" style="max-width:95vw;max-height:95vh;border-radius:.5rem;">`;
      overlay.addEventListener('click', () => overlay.remove());
      document.body.appendChild(overlay);
    }
  });
}

function renderClimbsTable(activityId, climbs, records, riderKg) {
  const tbody = document.getElementById('climbs-body');
  const noClimbs = document.getElementById('no-climbs');
  tbody.innerHTML = '';

  if (!climbs || climbs.length === 0) {
    noClimbs.classList.remove('d-none');
    return;
  }
  noClimbs.classList.add('d-none');

  for (let i = 0; i < climbs.length; i++) {
    const c = climbs[i];
    const vam = computeVam(c, records);
    const wkg = estimateClimbWkg(c, records.filter(r => r.distance >= c.start_distance_m && r.distance <= c.end_distance_m), riderKg);
    const key = climbKey(activityId, c.start_distance_m, c.end_distance_m);
    const row = document.createElement('tr');
    row.dataset.climbKey = key;
    row.dataset.startDistance = c.start_distance_m;
    row.dataset.endDistance = c.end_distance_m;
    row.innerHTML = `
      <td>${i + 1}</td>
      <td class="climb-name-cell">
        <a href="#climb/${key}" class="climb-name-link text-decoration-none text-body-secondary">Unnamed segment</a>
        <button class="btn btn-sm btn-link py-0 climb-edit-btn" title="Edit name">✎</button>
        <button class="btn btn-sm btn-link py-0 climb-modify-btn" title="Modify segment on map">🗺</button>
        <button class="btn btn-sm btn-link py-0 climb-analysis-btn" title="Detailed analysis">📊</button>
        <button class="btn btn-sm btn-link py-0 climb-replace-btn" title="Replace with another segment">🔁</button>
        <button class="btn btn-sm btn-link py-0 climb-validate-btn text-success" title="Validate as canonical named climb">✓</button>
      </td>
      <td><span class="badge bg-secondary category-badge">${c.category}</span></td>
      <td>${(c.start_distance_m / 1000).toFixed(1)}</td>
      <td>${(c.length_m / 1000).toFixed(1)}</td>
      <td>${fmtElevation(c.elevation_gain_m)}</td>
      <td>${fmtGrade(c.avg_grade_percent)}</td>
      <td>${c.steepest_100m_grade != null ? fmtGrade(c.steepest_100m_grade) : '-'}</td>
      <td>${vam ? Math.round(vam) + ' m/h' : '-'}</td>
      <td>${wkg != null ? `${wkg.toFixed(2)} W/kg` : '-'}</td>
      <td class="climb-pr-cell">…</td>
    `;
    if (c.validated_climb_id) {
      row.dataset.validatedName = c.validated_name;
      const cell = row.querySelector('.climb-name-cell');
      const link = cell.querySelector('.climb-name-link');
      link.textContent = c.validated_name;
      link.className = 'climb-name-link text-decoration-none fw-semibold';
      const vbtn = cell.querySelector('.climb-validate-btn');
      vbtn.outerHTML = `<span class="badge bg-success ms-1" title="Validated">✓</span>`;
    }
    tbody.appendChild(row);
  }

  tbody.addEventListener('click', handleClimbNameEditClick);
  tbody.addEventListener('click', e => handleClimbModifyClick(e, records));
  tbody.addEventListener('click', handleClimbValidateClick);
  tbody.addEventListener('click', e => handleClimbAnalysisClick(e, records));
  tbody.addEventListener('click', e => handleClimbReplaceClick(e, activityId, climbs));
  renderClimbPrDeltas(activityId, climbs, records);
}

async function handleClimbModifyClick(e, records) {
  const btn = e.target.closest('.climb-modify-btn');
  if (!btn) return;
  const row = btn.closest('tr');
  if (!row) return;
  const activityId = row.dataset.climbKey.split(':')[0];
  const start = parseFloat(row.dataset.startDistance);
  const end = parseFloat(row.dataset.endDistance);
  btn.disabled = true;
  try {
    await openSegmentEditor({
      activityId,
      records,
      startDistanceM: start,
      endDistanceM: end,
      onSave: () => window.location.reload(),
    });
  } catch (err) {
    console.error('Failed to open segment editor', err);
    alert('Could not open segment editor: ' + (err?.message || err));
  } finally {
    btn.disabled = false;
  }
}

function handleClimbReplaceClick(e, activityId, climbs) {
  const btn = e.target.closest('.climb-replace-btn');
  if (!btn) return;
  const row = btn.closest('tr');
  if (!row) return;
  const start = parseFloat(row.dataset.startDistance);
  const end = parseFloat(row.dataset.endDistance);
  const climb = climbs.find(c => Math.abs(c.start_distance_m - start) < 1 && Math.abs(c.end_distance_m - end) < 1);
  if (!climb) return;
  openSegmentPicker({
    activityId,
    climb,
    onReplaced: () => window.location.reload(),
  });
}

function handleClimbAnalysisClick(e, records) {
  const btn = e.target.closest('.climb-analysis-btn');
  if (!btn) return;
  const row = btn.closest('tr');
  if (!row) return;
  const activityId = row.dataset.climbKey.split(':')[0];
  const start = parseFloat(row.dataset.startDistance);
  const end = parseFloat(row.dataset.endDistance);
  const name = row.querySelector('.climb-name-link')?.textContent?.trim() || 'Unnamed segment';
  const climb = {
    activity_id: activityId,
    start_distance_m: start,
    end_distance_m: end,
    name: name === 'Unnamed segment' ? null : name,
  };
  openSegmentAnalysis({
    climb,
    records,
    activityName: null,
    fetchMatches: fetchClimbMatches,
    fetchRecords: fetchActivityRecords,
  });
}

function setupClimbNameLoading(activityId) {
  const collapse = document.getElementById('section-climbs');
  if (!collapse) return;
  const spinner = document.getElementById('climbs-loading');
  const load = async () => {
    if (spinner) {
      spinner.classList.remove('d-none');
      spinner.textContent = 'Looking up names from OpenStreetMap…';
    }
    try {
      const names = await fetchClimbNames(activityId, true);
      climbNameMap = names;
      updateClimbNameCells(names);
    } catch (err) {
      console.error('Failed to load climb names', err);
    } finally {
      if (spinner) spinner.classList.add('d-none');
    }
  };
  collapse.addEventListener('shown.bs.collapse', load, { once: true });
  if (collapse.classList.contains('show')) {
    load();
  }
}

function setupIdentifySegments(activityId) {
  const btn = document.getElementById('identify-segments-btn');
  const container = document.getElementById('candidate-segments');
  if (!btn || !container) return;

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Looking for segments…';
    try {
      const candidates = await identifySegments(activityId);
      renderCandidates(activityId, candidates);
    } catch (err) {
      console.error('Failed to identify segments', err);
      alert('Could not identify segments. Is the server running?');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Identify segments';
    }
  });
}

function renderCandidates(activityId, candidates) {
  const container = document.getElementById('candidate-segments');
  container.classList.remove('d-none');
  if (!candidates || candidates.length === 0) {
    container.innerHTML = '<p class="text-muted small mb-0">No additional segments found nearby.</p>';
    return;
  }

  const rows = candidates.map((c, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${c.category}</td>
      <td>${(c.start_distance_m / 1000).toFixed(1)}</td>
      <td>${(c.length_m / 1000).toFixed(2)}</td>
      <td>${fmtElevation(c.elevation_gain_m)}</td>
      <td>${fmtGrade(c.avg_grade_percent)}</td>
      <td>${c.steepest_100m_grade != null ? fmtGrade(c.steepest_100m_grade) : '-'}</td>
      <td><button class="btn btn-sm btn-primary add-candidate-btn" data-start="${c.start_distance_m}" data-end="${c.end_distance_m}">Add</button></td>
    </tr>
  `).join('');

  container.innerHTML = `
    <h6 class="mt-3">Candidate segments nearby</h6>
    <div class="table-responsive">
      <table class="table table-sm table-striped">
        <thead><tr><th>#</th><th>Category</th><th>Start (km)</th><th>Length (km)</th><th>Elev. gain</th><th>Avg grade</th><th>Steepest 100m</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="card card-body p-2 mt-2">
      <div class="row g-2 align-items-end">
        <div class="col-4">
          <label class="form-label small mb-0">Start distance (m)</label>
          <input type="number" step="0.1" class="form-control form-control-sm" id="manual-start">
        </div>
        <div class="col-4">
          <label class="form-label small mb-0">End distance (m)</label>
          <input type="number" step="0.1" class="form-control form-control-sm" id="manual-end">
        </div>
        <div class="col-4">
          <button class="btn btn-sm btn-success w-100" id="manual-add-btn">Add manual segment</button>
        </div>
      </div>
    </div>
  `;

  container.querySelectorAll('.add-candidate-btn').forEach(button => {
    button.addEventListener('click', async () => {
      const start = parseFloat(button.dataset.start);
      const end = parseFloat(button.dataset.end);
      button.disabled = true;
      button.textContent = 'Saving…';
      try {
        await saveSegment(activityId, start, end);
        window.location.reload();
      } catch (err) {
        console.error('Failed to add segment', err);
        alert('Could not add segment. Is the server running?');
        button.disabled = false;
        button.textContent = 'Add';
      }
    });
  });

  const manualBtn = document.getElementById('manual-add-btn');
  if (manualBtn) {
    manualBtn.addEventListener('click', async () => {
      const start = parseFloat(document.getElementById('manual-start').value);
      const end = parseFloat(document.getElementById('manual-end').value);
      if (Number.isNaN(start) || Number.isNaN(end) || start >= end) {
        alert('Enter a valid start and end distance');
        return;
      }
      manualBtn.disabled = true;
      manualBtn.textContent = 'Saving…';
      try {
        await saveSegment(activityId, start, end);
        window.location.reload();
      } catch (err) {
        console.error('Failed to add manual segment', err);
        alert('Could not add segment. Is the server running?');
        manualBtn.disabled = false;
        manualBtn.textContent = 'Add manual segment';
      }
    });
  }
}

function updateClimbNameCells(names) {
  const tbody = document.getElementById('climbs-body');
  if (!tbody) return;
  for (const row of tbody.querySelectorAll('tr')) {
    if (row.querySelector('.climb-name-input')) continue;
    // Validated names win over OSM/manual suggestions; never overwrite them.
    if (row.dataset.validatedName) continue;
    const key = row.dataset.climbKey;
    const entry = names[key];
    const link = row.querySelector('.climb-name-link');
    if (!link) continue;
    if (entry && entry.name) {
      link.textContent = entry.name;
      const badgeClass = entry.source === 'manual' ? 'text-primary' : 'fw-semibold';
      link.className = `climb-name-link text-decoration-none ${badgeClass}`;
    } else {
      link.textContent = 'Unnamed segment';
      link.className = 'climb-name-link text-decoration-none text-body-secondary';
    }
    // keep edit/modify buttons after update
    const cell = link.closest('.climb-name-cell');
    if (cell && !cell.querySelector('.climb-edit-btn')) {
      cell.insertAdjacentHTML('beforeend', ' <button class="btn btn-sm btn-link py-0 climb-edit-btn" title="Edit name">✎</button> <button class="btn btn-sm btn-link py-0 climb-modify-btn" title="Modify segment on map">🗺</button> <button class="btn btn-sm btn-link py-0 climb-validate-btn text-success" title="Validate as canonical named climb">✓</button>');
    }
  }
}

function handleClimbValidateClick(e) {
  const btn = e.target.closest('.climb-validate-btn');
  if (!btn) return;
  const row = btn.closest('tr');
  if (!row) return;
  const activityId = row.dataset.climbKey.split(':')[0];
  const start = parseFloat(row.dataset.startDistance);
  const end = parseFloat(row.dataset.endDistance);
  const link = row.querySelector('.climb-name-link');
  let current = link && link.textContent.trim() !== 'Unnamed segment' ? link.textContent.trim() : '';
  if (current === 'Unnamed segment') current = '';

  const doValidate = async (name) => {
    btn.disabled = true;
    try {
      await validateClimb(activityId, start, end, name);
      const cell = row.querySelector('.climb-name-cell');
      const link2 = cell.querySelector('.climb-name-link');
      link2.textContent = name;
      link2.className = 'climb-name-link text-decoration-none fw-semibold';
      btn.outerHTML = '<span class="badge bg-success ms-1" title="Validated">✓</span>';
    } catch (err) {
      alert(err.message || 'Validation failed');
      btn.disabled = false;
    }
  };

  if (!current) {
    const name = prompt('Give this climb a name to validate it:');
    if (!name || !name.trim()) return;
    doValidate(name.trim());
  } else {
    doValidate(current);
  }
}

function handleClimbNameEditClick(e) {
  const btn = e.target.closest('.climb-edit-btn');
  if (!btn) return;
  const row = btn.closest('tr');
  if (!row) return;
  const link = row.querySelector('.climb-name-link');
  const current = link && link.textContent.trim() !== 'Unnamed segment' ? link.textContent.trim() : '';
  const start = parseFloat(row.dataset.startDistance);
  const end = parseFloat(row.dataset.endDistance);
  const activityId = row.dataset.climbKey.split(':')[0];
  const key = row.dataset.climbKey;

  const cell = row.querySelector('.climb-name-cell');
  cell.innerHTML = `
    <div class="input-group input-group-sm">
      <input type="text" class="form-control climb-name-input" value="${current.replace(/"/g, '&quot;')}" placeholder="Climb name">
      <button class="btn btn-primary climb-save-btn" type="button">Save</button>
      <button class="btn btn-outline-secondary climb-cancel-btn" type="button">Cancel</button>
    </div>
  `;
  const input = cell.querySelector('.climb-name-input');
  input.focus();
  input.select();

  const save = async () => {
    const name = input.value.trim();
    if (!name) return;
    try {
      const entry = await saveClimbName(activityId, start, end, name);
      climbNameMap[key] = entry;
      cell.innerHTML = `<a href="#climb/${key}" class="climb-name-link text-decoration-none text-primary">${escapeHtml(entry.name)}</a> <button class="btn btn-sm btn-link py-0 climb-edit-btn" title="Edit name">✎</button> <button class="btn btn-sm btn-link py-0 climb-modify-btn" title="Modify segment on map">🗺</button>`;
    } catch (err) {
      console.error('Failed to save climb name', err);
      alert('Could not save name. Is the server running?');
    }
  };

  const cancel = () => {
    const display = current ? escapeHtml(current) : '<span class="text-muted">Unnamed segment</span>';
    const cls = current ? 'text-primary' : 'text-muted';
    cell.innerHTML = `<a href="#climb/${key}" class="climb-name-link text-decoration-none ${cls}">${display}</a> <button class="btn btn-sm btn-link py-0 climb-edit-btn" title="Edit name">✎</button> <button class="btn btn-sm btn-link py-0 climb-modify-btn" title="Modify segment on map">🗺</button>`;
  };

  cell.querySelector('.climb-save-btn').addEventListener('click', save);
  cell.querySelector('.climb-cancel-btn').addEventListener('click', cancel);
  input.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') save();
    if (ev.key === 'Escape') cancel();
  });
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function computeVam(climb, records) {
  const start = records.find(p => p.distance >= climb.start_distance_m && p.timestamp);
  const end = [...records].reverse().find(p => p.distance <= climb.end_distance_m && p.timestamp);
  if (!start || !end || !start.timestamp || !end.timestamp) return null;
  const seconds = (new Date(end.timestamp) - new Date(start.timestamp)) / 1000;
  if (seconds <= 0) return null;
  return (climb.elevation_gain_m / seconds) * 3600;
}

function computeElapsed(climb, records) {
  const start = records.find(p => p.distance >= climb.start_distance_m && p.timestamp);
  const end = [...records].reverse().find(p => p.distance <= climb.end_distance_m && p.timestamp);
  if (!start || !end || !start.timestamp || !end.timestamp) return null;
  const seconds = (new Date(end.timestamp) - new Date(start.timestamp)) / 1000;
  return seconds > 0 ? seconds : null;
}

// PR delta per climb row: elapsed time vs the best attempt of the same
// climb group. One matches fetch per climb (small, cached server-side).
async function renderClimbPrDeltas(activityId, climbs, records) {
  const tbody = document.getElementById('climbs-body');
  const results = await Promise.all(climbs.map(async c => {
    const key = climbKey(activityId, c.start_distance_m, c.end_distance_m);
    let best = null;
    try {
      const m = await fetchClimbMatches(key);
      const times = (m.members || [])
        .filter(x => x.elapsed_time_s != null)
        .map(x => x.elapsed_time_s);
      if (times.length) best = Math.min(...times);
    } catch (err) { /* leave cell as '-' */ }
    return { key, best };
  }));
  const bestByKey = {};
  for (const r of results) bestByKey[r.key] = r.best;

  const fmtDelta = secs => {
    if (secs >= 3600) return `${Math.floor(secs / 3600)}h ${String(Math.floor(secs % 3600 / 60)).padStart(2, '0')}m ${String(Math.floor(secs % 60)).padStart(2, '0')}s`;
    if (secs >= 60) return `${Math.floor(secs / 60)}m ${String(Math.floor(secs % 60)).padStart(2, '0')}s`;
    return `${Math.round(secs)}s`;
  };

  for (const row of tbody.querySelectorAll('tr')) {
    const cell = row.querySelector('.climb-pr-cell');
    if (!cell) continue;
    const key = row.dataset.climbKey;
    const c = climbs.find(x => climbKey(activityId, x.start_distance_m, x.end_distance_m) === key);
    if (!c) continue;
    const elapsed = computeElapsed(c, records);
    const best = bestByKey[key];
    if (elapsed == null || best == null) continue;
    const d = elapsed - best;
    if (d > 0) cell.innerHTML = `<span class="text-danger">+${fmtDelta(d)}</span>`;
    else if (d === 0) cell.innerHTML = `<span class="text-success fw-bold">PR</span>`;
    else cell.innerHTML = `<span class="text-success">-${fmtDelta(-d)}</span>`;
  }
}

function renderLapsTable(laps, isPace = false) {
  const tbody = document.getElementById('laps-body');
  const noLaps = document.getElementById('no-laps');
  tbody.innerHTML = '';

  if (!laps || laps.length === 0) {
    noLaps.classList.remove('d-none');
    return;
  }
  noLaps.classList.add('d-none');

  for (const lap of laps) {
    let avgSpeed = lap.avg_speed;
    if (avgSpeed == null && lap.distance != null && lap.moving_time != null) {
      // garmindb leaves avg_speed null on many laps; derive it from
      // distance / moving time. moving_time arrives as seconds (number),
      // or occasionally as an hh:mm:ss string.
      let seconds = null;
      if (typeof lap.moving_time === 'number') {
        seconds = lap.moving_time;
      } else {
        const parts = String(lap.moving_time).split(':');
        if (parts.length === 3) {
          seconds = (parseInt(parts[0], 10) || 0) * 3600
            + (parseInt(parts[1], 10) || 0) * 60
            + (parseFloat(parts[2]) || 0);
        }
      }
      if (seconds > 0) avgSpeed = lap.distance / (seconds / 3600);
    }
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${lap.lap + 1}</td>
      <td>${fmtDistance(lap.distance)}</td>
      <td>${fmtDuration(lap.moving_time)}</td>
      <td>${isPace ? fmtSpeedOrPace('running', avgSpeed) : fmtSpeed(avgSpeed)}</td>
      <td>${fmtElevation(lap.ascent)}</td>
      <td>${fmtHr(lap.avg_hr)}</td>
    `;
    tbody.appendChild(row);
  }
}

function renderMap(records, climbs, sport = 'cycling') {
  if (!map) {
    map = L.map('map');
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
  }

  map.eachLayer(layer => {
    if (layer instanceof L.Polyline || layer instanceof L.Marker) {
      map.removeLayer(layer);
    }
  });

  const located = records.filter(p => p.position_lat && p.position_long);
  const routePoints = located.map(p => [p.position_lat, p.position_long]);
  if (routePoints.length === 0) return;

  // Speed-coloured trace: the route is cut at every speed-bucket change
  // (each segment starts with the previous point so segments connect),
  // drawn over a black casing polyline so the trace reads clearly
  // against any map background. Speed = current record speed when
  // present, else derived from distance delta over time delta.
  const speeds = new Array(located.length).fill(null);
  for (let i = 0; i < located.length; i++) {
    if (located[i].speed != null) { speeds[i] = located[i].speed; continue; }
    if (i > 0 && located[i].timestamp && located[i - 1].timestamp) {
      const dt = (new Date(located[i].timestamp) - new Date(located[i - 1].timestamp)) / 1000;
      const dd = (located[i].distance - located[i - 1].distance) / 1000;
      speeds[i] = (dt > 0 && dd >= 0) ? dd / dt * 3600 : null;
    }
  }
  const validSpeeds = speeds.filter(v => v != null && isFinite(v));
  // Relative buckets when speeds exist; otherwise fall back to a plain
  // grey trace (some activities carry no speed at all).
  let speedColor = null;
  if (validSpeeds.length > 10) {
    const sorted = [...validSpeeds].sort((a, b) => a - b);
    const q = p => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
    const BUCKETS = [
      { max: q(0.20), color: '#3182bd' },  // slow — deep blue
      { max: q(0.40), color: '#9ecae1' },
      { max: q(0.60), color: '#ffffbf' },  // average — pale yellow
      { max: q(0.80), color: '#fdae61' },
      { max: Infinity, color: '#d73027' }, // fast — red
    ];
    speedColor = v => BUCKETS.find(b => v <= b.max)?.color || '#d73027';
  }

  // Black casing under the whole route, then the coloured segments.
  L.polyline(routePoints, { color: '#000000', weight: 7, opacity: 0.9 }).addTo(map);
  if (speedColor) {
    for (let i = 1; i < located.length; i++) {
      const v0 = speeds[i - 1] ?? speeds[i];
      const v1 = speeds[i] ?? speeds[i - 1];
      const v = v0 ?? v1;
      if (v == null) continue;
      L.polyline([routePoints[i - 1], routePoints[i]], {
        color: speedColor(v), weight: 4, opacity: 0.95,
      }).addTo(map);
    }
  } else {
    L.polyline(routePoints, { color: '#6c757d', weight: 4, opacity: 0.7 }).addTo(map);
  }
  L.circleMarker(routePoints[0], { radius: 7, color: '#198754', fillColor: '#198754', fillOpacity: 1, weight: 2 }).addTo(map).bindPopup('Start');
  L.circleMarker(routePoints[routePoints.length - 1], { radius: 7, color: '#dc3545', fillColor: '#dc3545', fillOpacity: 1, weight: 2 }).addTo(map).bindPopup('Finish');

  // Speed legend under the map.
  const legend = L.control({ position: 'bottomright' });
  legend.onAdd = () => {
    const div = L.DomUtil.create('div', 'speed-legend');
    const isPace = usesPace(sport);
    div.innerHTML = speedColor
      ? `<div class="d-flex align-items-center gap-1 small">${['slow', '', '', '', 'fast'].map((t, i) =>
          `<span style="width:18px;height:8px;display:inline-block;background:${['#3182bd', '#9ecae1', '#ffffbf', '#fdae61', '#d73027'][i]};border:1px solid rgba(0,0,0,.3);"></span>`).join('')}${isPace ? ' pace' : ' speed'}</div>`
      : '';
    return div;
  };
  if (speedColor) legend.addTo(map);

  map.fitBounds(routePoints, { padding: [20, 20] });
}

function renderElevationChart(records, climbs) {
  if (elevationChart) elevationChart.destroy();
  const ctx = document.getElementById('elevation-chart').getContext('2d');

  const labels = records.map(p => (p.distance / 1000).toFixed(1));
  const data = records.map(p => p.altitude);

  const inClimb = new Array(records.length).fill(false);
  for (const c of climbs) {
    for (let i = 0; i < records.length; i++) {
      if (records[i].distance >= c.start_distance_m && records[i].distance <= c.end_distance_m) {
        inClimb[i] = true;
      }
    }
  }

  function nearestIndex(targetDistance) {
    let bestIdx = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < records.length; i++) {
      const diff = Math.abs(records[i].distance - targetDistance);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  const climbLabels = climbs.map((c, idx) => {
    const startIdx = nearestIndex(c.start_distance_m);
    const endIdx = nearestIndex(c.end_distance_m);
    const midIdx = nearestIndex((c.start_distance_m + c.end_distance_m) / 2);
    return { idx, startIdx, endIdx, dataIndex: midIdx, altitude: records[midIdx]?.altitude ?? 0, midDistance: (c.start_distance_m + c.end_distance_m) / 2, climb: c };
  });

  // Stagger labels that are close horizontally.
  climbLabels.sort((a, b) => a.midDistance - b.midDistance);
  let prevMid = -Infinity;
  let offset = 0;
  const offsetStep = 16;
  const proximityM = 400;
  for (const item of climbLabels) {
    if (item.midDistance - prevMid < proximityM) {
      offset += offsetStep;
    } else {
      offset = 0;
    }
    item.vOffset = offset;
    prevMid = item.midDistance;
  }
  climbLabels.sort((a, b) => a.idx - b.idx);

  elevationChart = new window.Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Elevation (m)',
        data,
        borderWidth: 2,
        pointRadius: 0,
        fill: true,
        backgroundColor: 'rgba(13, 110, 253, 0.1)',
        tension: 0.1,
        segment: {
          borderColor: ctx => inClimb[ctx.p0DataIndex] || inClimb[ctx.p1DataIndex] ? '#dc3545' : '#0d6efd'
        }
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { title: items => `km ${items[0].label}` } },
        climbNumbers: { labels: climbLabels }
      },
      scales: {
        x: { title: { display: true, text: 'Distance (km)' }, ticks: { maxTicksLimit: 10 } },
        y: { title: { display: true, text: 'Elevation (m)' }, suggestedMax: Math.max(...data) * 1.25 }
      }
    },
    plugins: [{
      id: 'climbNumbers',
      afterDatasetsDraw(chart, args, options) {
        const { ctx, scales: { x, y } } = chart;
        ctx.save();
        const radius = 9;
        for (const item of options.labels || []) {
          const px = (x.getPixelForValue(item.startIdx) + x.getPixelForValue(item.endIdx)) / 2;
          const py = y.getPixelForValue(item.altitude) - radius - 10 - (item.vOffset || 0);

          ctx.beginPath();
          ctx.arc(px, py, radius, 0, 2 * Math.PI);
          const dark = document.documentElement.getAttribute('data-bs-theme') === 'dark';
          ctx.fillStyle = dark ? '#212529' : 'white';
          ctx.fill();
          ctx.strokeStyle = '#842029';
          ctx.lineWidth = 1.5;
          ctx.stroke();

          ctx.font = 'bold 10px system-ui, -apple-system, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = dark ? '#ea9aa5' : '#842029';
          ctx.fillText(item.idx + 1, px, py + 0.5);
        }
        ctx.restore();
      }
    }]
  });

  attachClimbTooltip(elevationChart, climbLabels);
}

function getOrCreateClimbTooltip() {
  let tip = document.getElementById('climb-tooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'climb-tooltip';
    tip.className = 'card border-0 shadow-sm p-2 small';
    tip.style.position = 'absolute';
    tip.style.display = 'none';
    tip.style.pointerEvents = 'none';
    tip.style.zIndex = '1000';
    tip.style.background = 'var(--bs-body-bg)';
    document.body.appendChild(tip);
  }
  return tip;
}

function formatClimbTooltip(item) {
  const c = item.climb;
  const key = climbKey(currentActivityId || '', c.start_distance_m, c.end_distance_m);
  const entry = climbNameMap[key];
  const name = entry?.name || `Climb ${item.idx + 1}`;
  return `
    <div class="fw-semibold">${escapeHtml(name)}</div>
    <div class="text-muted">${fmtElevation(c.elevation_gain_m)} · ${(c.length_m / 1000).toFixed(1)} km</div>
  `;
}

function attachClimbTooltip(chart, labels) {
  const canvas = chart.canvas;
  const tip = getOrCreateClimbTooltip();

  canvas.addEventListener('mousemove', evt => {
    const rect = canvas.getBoundingClientRect();
    const mx = evt.clientX - rect.left;
    const my = evt.clientY - rect.top;
    const x = chart.scales.x;
    const y = chart.scales.y;

    let hovered = null;
    let hoveredDist = Infinity;
    for (const item of labels) {
      const px = (x.getPixelForValue(item.startIdx) + x.getPixelForValue(item.endIdx)) / 2;
      const py = y.getPixelForValue(item.altitude) - 9 - 10 - (item.vOffset || 0);
      const dist = Math.hypot(mx - px, my - py);
      if (dist <= 12 && dist < hoveredDist) {
        hovered = item;
        hoveredDist = dist;
      }
    }

    if (hovered) {
      tip.innerHTML = formatClimbTooltip(hovered);
      tip.style.display = 'block';
      tip.style.left = `${evt.pageX + 12}px`;
      tip.style.top = `${evt.pageY - 12}px`;
      canvas.style.cursor = 'pointer';
    } else {
      tip.style.display = 'none';
      canvas.style.cursor = 'default';
    }
  });

  canvas.addEventListener('mouseleave', () => {
    tip.style.display = 'none';
    canvas.style.cursor = 'default';
  });
}

const GRAPH_MEASURES = {
  hr: { label: 'HR', color: '#dc3545', field: 'hr', axis: 'yHr', axisTitle: 'Heart rate (bpm)', has: s => s.has_hr },
  speed: { label: 'Speed', color: '#0d6efd', field: 'speed', axis: 'ySpeed', axisTitle: 'Speed (km/h)', has: s => s.has_speed },
  altitude: { label: 'Altitude', color: '#198754', field: 'altitude', axis: 'yAlt', axisTitle: 'Altitude (m)', has: s => s.has_altitude !== false },
  temperature: { label: 'Temperature', color: '#fd7e14', field: 'temperature', axis: 'yTemp', axisTitle: 'Temperature (°C)', has: s => s.has_temperature },
  power: { label: 'Power', color: '#6f42c1', field: 'power', axis: 'yPower', axisTitle: 'Power (W)', has: s => s.has_power },
  cadence: { label: 'Cadence', color: '#20c997', field: 'cadence', axis: 'yCad', axisTitle: 'Cadence (rpm)', has: s => s.has_cadence },
};

// Seconds per km -> m:ss pace label.
function paceTick(v) {
  if (v == null || !isFinite(v) || v <= 0) return '';
  const m = Math.floor(v / 60);
  const s = Math.round(v % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function renderGraphsChartDeferred(records, sensors, sport = 'cycling') {
  graphsChartRendered = false;
  const card = document.getElementById('graphs-card');
  if (!card) return;
  card.classList.remove('d-none');
  // Foot sports: cadence records one-foot steps (GarminDB convention),
  // Garmin Connect shows steps/min = 2 x; speed reads as pace (min/km).
  const measures = { ...GRAPH_MEASURES };
  if (usesPace(sport)) {
    // Pace plausibility clamp: GPS speed near 0 (indoor glitches,
    // pause wobble) would turn into absurd min/km values and squash
    // the whole chart. Running keeps anything up to 15 min/km,
    // hiking up to 60 min/km — the rest is not locomotion data.
    const paceMaxMinPerKm = sport === 'hiking' ? 60 : 15;
    measures.cadence = {
      ...measures.cadence,
      label: 'Step rate',
      axisTitle: 'Step rate (spm)',
      transform: v => (v != null ? v * 2 : null),
    };
    measures.speed = {
      ...measures.speed,
      label: 'Pace',
      axisTitle: 'Pace (min/km)',
      // Speed (km/h) -> pace (s/km); inverted axis so up = faster.
      transform: v => {
        if (!v || v <= 0) return null;
        const pace = 3600 / v;
        return pace <= paceMaxMinPerKm * 60 ? pace : null;
      },
      invert: true,
      tickFormat: paceTick,
    };
  }
  const collapse = document.getElementById('section-graphs');
  collapse.addEventListener('shown.bs.collapse', () => {
    if (!graphsChartRendered) renderGraphsChart(records, sensors, measures);
  }, { once: true });
}

function renderGraphsChart(records, sensors, measures = GRAPH_MEASURES) {
  if (graphsChart) graphsChart.destroy();
  const ctx = document.getElementById('graphs-chart').getContext('2d');
  const container = document.getElementById('graphs-measures');
  container.innerHTML = '';

  // Which measures this activity actually has data for.
  const available = Object.entries(measures).filter(([, m]) => {
    try { return m.has(sensors); } catch { return false; }
  });
  // Defaults only on first render; after that the user's ticks stick.
  if (selectedMeasures.size === 0) {
    if (available.some(([id]) => id === 'hr')) selectedMeasures.add('hr');
    if (available.some(([id]) => id === 'speed')) selectedMeasures.add('speed');
  }

  const labels = records.map(p => (p.distance / 1000).toFixed(1));

  for (const [id, m] of available) {
    const wrap = document.createElement('div');
    wrap.className = 'form-check mb-0';
    wrap.innerHTML = `
      <input class="form-check-input" type="checkbox" id="graph-measure-${id}" ${selectedMeasures.has(id) ? 'checked' : ''}>
      <label class="form-check-label small" for="graph-measure-${id}"><span style="color:${m.color};">■</span> ${m.label}</label>`;
    container.appendChild(wrap);
    wrap.querySelector('input').addEventListener('change', e => {
      if (e.target.checked) selectedMeasures.add(id); else selectedMeasures.delete(id);
      renderGraphsChart(records, sensors, measures);
    });
  }

  const scales = {
    x: { title: { display: true, text: 'Distance (km)' }, ticks: { maxTicksLimit: 10 } }
  };
  const datasets = [];
  let axisCount = 0;
  for (const [id, m] of available) {
    if (!selectedMeasures.has(id)) continue;
    const data = records.map(p => (m.transform ? m.transform(p[m.field]) : p[m.field]));
    datasets.push({
      label: m.axisTitle,
      data,
      borderColor: m.color,
      backgroundColor: m.color,
      borderWidth: 1.5,
      pointRadius: 0,
      fill: false,
      tension: 0.1,
      yAxisID: m.axis,
      spanGaps: true,
    });
    // Alternate axes left/right; grid only from the first axis so the
    // background stays readable with several measures shown.
    scales[m.axis] = {
      position: axisCount % 2 === 0 ? 'left' : 'right',
      title: { display: true, text: m.axisTitle, color: m.color },
      ticks: m.tickFormat
        ? { color: m.color, callback: m.tickFormat }
        : { color: m.color },
      reverse: !!m.invert,
      grid: { drawOnChartArea: axisCount === 0 },
    };
    axisCount++;
  }

  graphsChart = new window.Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: items => `km ${items[0].label}`,
            label: item => {
              const ds = graphsChart.getDatasetMeta(item.datasetIndex);
              const m = Object.values(measures).find(x => x.axis === ds.yAxisID);
              const v = item.parsed.y;
              if (m && m.tickFormat) return `${m.label}: ${m.tickFormat(v)} /km`;
              return `${m ? m.label : ''}: ${v != null ? v.toFixed(1) : '-'}`;
            },
          }
        }
      },
      scales
    }
  });
  graphsChartRendered = true;
}
