import { fetchClimbMatches, fetchAllClimbNames, fetchActivityRecords, saveClimbName, validateClimb, fetchValidatedClimbs, fetchStats } from '../utils/api.js';
import { openSegmentEditor } from '../components/segmentEditor.js?v=2';
import { attachFullscreen } from '../utils/fullscreen.js';
import { renderSegmentAnalysis } from '../components/segmentAnalysis.js';
import { fmtDate, fmtDuration, fmtDistance, fmtElevation, fmtGrade, fmtSpeed, fmtHr, climbKey, pyRound } from '../utils/format.js';
import { baseLayer } from '../utils/mapTiles.js';

let currentSegment = [];
let currentStartDistanceM = 0;
let selectedBinSizeM = null;

const BIN_SIZES = [200, 500, 1000];


const METRICS = {
  elapsed_time_s: { label: 'Time', axis: 'Time', format: fmtDuration, lowerIsBetter: true, value: m => m.elapsed_time_s },
  avg_speed: { label: 'Avg speed', axis: 'Speed', format: fmtSpeed, lowerIsBetter: false, value: m => m.avg_speed },
  vam: { label: 'VAM', axis: 'VAM (m/h)', format: v => `${Math.round(v)} m/h`, lowerIsBetter: false, value: m => m.vam },
  avg_power: { label: 'Power', axis: 'Power (W/kg)', format: v => `${v.toFixed(2)} W/kg`, lowerIsBetter: false, value: m => m.est_power_w_per_kg || (m.avg_power && m.avg_power / 70) || (m.est_power_w ? m.est_power_w / 70 : null) },
  avg_hr: { label: 'Avg HR', axis: 'Heart rate (bpm)', format: fmtHr, lowerIsBetter: true, value: m => m.avg_hr },
  speed_hr: { label: 'Speed / HR', axis: 'Speed / HR (km/h/bpm)', format: v => `${v.toFixed(2)} km/h/bpm`, lowerIsBetter: false, value: m => m.avg_hr ? m.avg_speed / m.avg_hr : null },
  inv_time_hr: { label: '1 / (Time · HR)', axis: '1 / (s·bpm)', format: v => v < 0.01 || v > 10000 ? v.toExponential(2) : v.toFixed(4), lowerIsBetter: false, value: m => (m.elapsed_time_s && m.avg_hr) ? 1 / (m.elapsed_time_s * m.avg_hr) : null },
  vam_hr: { label: 'VAM / HR', axis: 'VAM / HR (m/h/bpm)', format: v => `${v.toFixed(1)} m/h/bpm`, lowerIsBetter: false, value: m => m.avg_hr ? m.vam / m.avg_hr : null },
};

export async function renderClimb(key) {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div id="climb-view">
      <div class="d-flex align-items-center gap-2 mt-2 mb-3">
        <h3 id="climb-title" class="mb-0">Climb</h3>
        <button id="edit-climb-name-btn" class="btn btn-sm btn-link py-0" title="Edit name">✎</button>
        <button id="validate-climb-btn" class="btn btn-sm btn-outline-success" title="Validate as canonical named climb">✓ Validate</button>
        <span id="climb-validated-badge" class="badge bg-success d-none" title="Validated">✓ Validated</span>
      </div>
      <div id="climb-stats" class="row g-2 mb-3"></div>

      <div class="card mb-3">
        <div class="card-header fw-semibold d-flex justify-content-between align-items-center">
          <span>Segment</span>
          <button id="modify-segment-btn" class="btn btn-sm btn-outline-primary">Modify segment</button>
        </div>
        <div class="card-body p-2">
          <div id="climb-map" style="height: 300px;"></div>
        </div>
      </div>

      <div class="card mb-3">
        <div class="card-header fw-semibold">Elevation profile</div>
        <div class="card-body p-2">
          <div style="height: 240px; position: relative;">
            <canvas id="climb-elevation-chart"></canvas>
          </div>
          <div class="mt-2 d-flex align-items-center gap-2">
            <label for="zone-bin" class="small text-muted mb-0">Bin size</label>
            <input type="range" id="zone-bin" min="0" max="2" step="1" value="0" class="form-range" style="width: 200px;">
            <span id="zone-bin-value" class="small text-muted">200 m</span>
          </div>
        </div>
      </div>

      <div class="card mb-3">
        <div class="card-header fw-semibold">Detailed analysis</div>
        <div class="card-body p-2">
          <div id="climb-segment-analysis"></div>
        </div>
      </div>

      <div class="card mb-3">
        <div class="card-header fw-semibold d-flex justify-content-between align-items-center flex-wrap gap-2">
          <span>Performance history</span>
          <div class="d-flex align-items-center gap-3">
            <div class="form-check form-check-inline mb-0">
              <input class="form-check-input" type="checkbox" id="perf-regression">
              <label class="form-check-label small" for="perf-regression">Regression line + R²</label>
            </div>
            <select id="perf-metric" class="form-select form-select-sm w-auto">
              <option value="elapsed_time_s">Time</option>
              <option value="avg_speed">Avg speed</option>
              <option value="vam">VAM</option>
              <option value="avg_power">Power/kg (est.)</option>
              <option value="avg_hr">Avg HR</option>
              <option value="speed_hr">Speed / HR</option>
              <option value="inv_time_hr">1 / (Time · HR)</option>
              <option value="vam_hr">VAM / HR</option>
            </select>
          </div>
        </div>
        <div class="card-body p-2">
          <div style="height: 260px; position: relative;">
            <canvas id="climb-perf-chart"></canvas>
          </div>
          <p id="perf-regression-info" class="small text-muted mb-0 mt-2"></p>
        </div>
      </div>

      <h5 class="mb-2">All performances</h5>
      <div class="table-responsive">
        <table class="table table-sm table-striped">
          <thead>
            <tr><th>Date</th><th>Ride</th><th>Time</th><th>Δ PR</th><th>VAM</th><th>W/kg (est.)</th><th>Avg HR</th><th>Avg speed</th></tr>
          </thead>
          <tbody id="climb-perf-body"></tbody>
        </table>
      </div>
      <p id="no-perfs" class="text-muted d-none">No performances found.</p>
    </div>
  `;

  const [matches, names] = await Promise.all([fetchClimbMatches(key), fetchAllClimbNames()]);
  const members = matches.members || [];
  const nameEntry = names[key];
  const validatedName = members.find(m => m.validated_name)?.validated_name || null;
  const title = document.getElementById('climb-title');
  title.textContent = validatedName || nameEntry?.name || `Climb on ${members[0] ? fmtDate(members[0].start_time) : 'unknown ride'}`;

  // Altitude stat needs the segment records, so render details first.
  await renderSegmentDetails(members);
  renderStats(members, matches.count);   // async: fills in the prediction
  setupModifySegmentButton(members);
  setupClimbNameEdit(key, nameEntry);
  await setupClimbValidate(key, nameEntry, members);
  renderPerfChart(members);
  renderPerformances(members);
  attachFullscreen(document.getElementById('climb-map')?.closest('.card'), document.getElementById('climb-map'), {
    onResize: (el) => { if (el._climbMap) el._climbMap.invalidateSize(); }
  });
  attachFullscreen(document.getElementById('climb-elevation-chart')?.closest('.card'), document.getElementById('climb-elevation-chart')?.closest('.card-body'));
  attachFullscreen(document.getElementById('climb-segment-analysis')?.closest('.card'), document.getElementById('climb-segment-analysis'));
  attachFullscreen(document.getElementById('climb-perf-chart')?.closest('.card'), document.getElementById('climb-perf-chart')?.closest('.card'), { floatCard: true });

  const metricSelect = document.getElementById('perf-metric');
  if (metricSelect) {
    metricSelect.addEventListener('change', () => renderPerfChart(members));
  }
  const regressionCheck = document.getElementById('perf-regression');
  if (regressionCheck) {
    regressionCheck.addEventListener('change', () => renderPerfChart(members));
  }

  const binSlider = document.getElementById('zone-bin');
  const binValue = document.getElementById('zone-bin-value');
  if (binSlider) {
    binSlider.addEventListener('input', () => {
      selectedBinSizeM = BIN_SIZES[parseInt(binSlider.value)];
      if (binValue) binValue.textContent = `${selectedBinSizeM} m`;
      if (currentSegment.length) renderSegmentElevation(currentSegment, currentStartDistanceM);
    });
  }
}

function renderSegmentDetails(members) {
  const mapContainer = document.getElementById('climb-map');
  if (!mapContainer || members.length === 0) return Promise.resolve();

  const rep = members[members.length - 1];
  // Full record fields: the per-bin analysis needs speed/HR/timestamp
  // (and power/cadence when present) on top of distance/altitude.
  return fetchActivityRecords(rep.activity_id, 'distance,altitude,position_lat,position_long,hr,speed,timestamp,cadence,power', 3000)
    .then(records => {
      currentSegment = records.filter(r =>
        r.distance >= rep.start_distance_m && r.distance <= rep.end_distance_m
      );
      currentStartDistanceM = rep.start_distance_m;
      renderSegmentMap(mapContainer, currentSegment);
      renderSegmentElevation(currentSegment, currentStartDistanceM);
      // Detailed analysis inline, directly on the climb page. The current
      // (latest) attempt's bins show as blue dots so the chosen metric is
      // visible right away; other attempts load as grey dots, with
      // avg/best toggles across all attempts.
      renderSegmentAnalysis(document.getElementById('climb-segment-analysis'), {
        climb: {
          activity_id: rep.activity_id,
          start_distance_m: rep.start_distance_m,
          end_distance_m: rep.end_distance_m,
          start_time: rep.start_time,
          elapsed_time_s: rep.elapsed_time_s,
        },
        records,
        fetchMatches: fetchClimbMatches,
        fetchRecords: fetchActivityRecords,
        showCurrent: true,
      });
    })
    .catch(err => {
      console.error('Failed to load segment details', err);
      mapContainer.innerHTML = '<p class="text-muted small mb-0">Could not load segment details.</p>';
    });
}

function setupClimbNameEdit(key, nameEntry) {
  const btn = document.getElementById('edit-climb-name-btn');
  const title = document.getElementById('climb-title');
  if (!btn || !title) return;
  btn.addEventListener('click', () => {
    const current = nameEntry?.name || title.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'form-control form-control-sm';
    input.value = current === 'Climb' || current.startsWith('Climb on') ? '' : current;
    input.style.maxWidth = '400px';
    const save = async () => {
      const newName = input.value.trim();
      const cancel = () => {
        input.remove();
        saveBtn.remove();
        title.classList.remove('d-none');
        btn.classList.remove('d-none');
      };
      if (!newName) { cancel(); return; }
      const parts = key.split(':');
      const activityId = parts[0];
      const start = parseFloat(parts[1]);
      const end = parseFloat(parts[2]);
      try {
        await saveClimbName(activityId, start, end, newName);
        // Update the title element itself — it stays in the DOM, only
        // hidden during the edit, so the new name shows immediately.
        title.textContent = newName;
        nameEntry = { ...(nameEntry || {}), name: newName };
        cancel();
      } catch (err) {
        console.error('Failed to save climb name', err);
        alert('Could not save name');
      }
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { input.remove(); saveBtn.remove(); title.classList.remove('d-none'); btn.classList.remove('d-none'); } });
    input.addEventListener('blur', () => { setTimeout(() => { if (!document.body.contains(input)) return; input.remove(); saveBtn.remove(); title.classList.remove('d-none'); btn.classList.remove('d-none'); }, 150); });
    title.classList.add('d-none');
    title.after(input);
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-sm btn-primary';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('mousedown', e => e.preventDefault());   // keep input focus so blur doesn't race the click
    saveBtn.addEventListener('click', save);
    input.after(saveBtn);
    input.focus();
    input.select();
    btn.classList.add('d-none');
  });
}

async function setupClimbValidate(key, nameEntry, members) {
  const btn = document.getElementById('validate-climb-btn');
  const badge = document.getElementById('climb-validated-badge');
  if (!btn || !badge) return;
  if (members.length === 0) { btn.classList.add('d-none'); return; }

  const parts = key.split(':');
  const activityId = parts[0];
  const start = parseFloat(parts[1]);
  const end = parseFloat(parts[2]);

  // Already validated? Match against the registry by geometry.
  try {
    const validated = await fetchValidatedClimbs();
    const rep = members[members.length - 1];
    const isMatch = v =>
      typeof v.start_lat === 'number' &&
      Math.abs(v.start_lat - rep.start_lat) < 0.005 && Math.abs(v.start_lon - rep.start_lon) < 0.005 &&
      Math.abs(v.end_lat - rep.end_lat) < 0.005 && Math.abs(v.end_lon - rep.end_lon) < 0.005;
    if (validated.some(isMatch)) {
      btn.classList.add('d-none');
      badge.classList.remove('d-none');
      return;
    }
  } catch (e) { /* registry fetch failed; keep the button */ }

  btn.addEventListener('click', async () => {
    const title = document.getElementById('climb-title');
    let current = (nameEntry && nameEntry.name) || title.textContent.trim();
    if (!current || current === 'Climb' || current.startsWith('Climb on')) current = '';
    let name = current;
    if (!name) {
      name = prompt('Give this climb a name to validate it:');
      if (!name || !name.trim()) return;
      name = name.trim();
    }
    btn.disabled = true;
    btn.textContent = 'Validating…';
    try {
      await validateClimb(activityId, start, end, name);
      btn.classList.add('d-none');
      badge.classList.remove('d-none');
    } catch (err) {
      alert(err.message || 'Validation failed');
      btn.disabled = false;
      btn.textContent = '✓ Validate';
    }
  });
}


function setupModifySegmentButton(members) {
  const btn = document.getElementById('modify-segment-btn');
  if (!btn || members.length === 0) return;
  const rep = members[members.length - 1];
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const records = await fetchActivityRecords(rep.activity_id, 'distance,altitude,position_lat,position_long', 3000);
      const saved = await openSegmentEditor({
        activityId: rep.activity_id,
        records,
        startDistanceM: rep.start_distance_m,
        endDistanceM: rep.end_distance_m,
        onSave: null,
      });
      // Cancelled: the editor resolves to null — nothing was saved.
      if (!saved) return;
      // Navigate to the new segment key (same activity, new start/end) so the
      // page reflects the modified segment instead of the stale one.
      const newKey = climbKey(rep.activity_id, saved.start_distance_m, saved.end_distance_m);
      if (newKey !== keyOf(members, rep)) {
        window.location.hash = `#climb/${newKey}`;
      } else {
        window.location.reload();
      }
    } catch (err) {
      console.error('Failed to open segment editor', err);
      alert('Could not open segment editor: ' + (err?.message || err));
    } finally {
      btn.disabled = false;
    }
  });
}

function keyOf(members, rep) {
  return climbKey(rep.activity_id, rep.start_distance_m, rep.end_distance_m);
}

function renderSegmentMap(container, segment) {
  const points = segment.filter(r => r.position_lat && r.position_long).map(r => [r.position_lat, r.position_long]);
  if (points.length < 2) return;

  const map = L.map(container);
  container._climbMap = map;
  baseLayer('osm', { center: points[0] }).then(l => l.addTo(map));
  L.polyline(points, { color: '#dc3545', weight: 5, opacity: 0.9 }).addTo(map);
  L.circleMarker(points[0], { radius: 7, color: '#ffffff', fillColor: '#198754', fillOpacity: 1, weight: 2 }).addTo(map).bindPopup('Start');
  L.circleMarker(points[points.length - 1], { radius: 7, color: '#ffffff', fillColor: '#dc3545', fillOpacity: 1, weight: 2 }).addTo(map).bindPopup('Finish');
  map.fitBounds(points, { padding: [20, 20] });
}

// --- Time prediction ---------------------------------------------------
// Predicts how long a climb would take based on the rider's own history:
// a power-law fit of elapsed time against ascent and length over every
// quality climb occurrence (the /api/stats dataset), computed at most
// once per session.
//
//   ln(T) = a + b·ln(H) + c·ln(D)
//
// Fitted on the user's real climbs with R² ≈ 0.92 — a personal
// equivalent of Climbfinder's generic predictions.
let timeModelPromise = null;

function fitTimeModel(occurrences) {
  const X = [], Y = [];
  for (const o of occurrences) {
    const H = o.elevation_gain_m, D = o.length_m, T = o.elapsed_time_s;
    if (!H || !D || !T || H < 30 || D < 300 || T < 60 || T > 7200) continue;
    X.push([1, Math.log(H), Math.log(D)]);
    Y.push(Math.log(T));
  }
  if (X.length < 20) return null;
  const n = 3;
  const A = [[0,0,0],[0,0,0],[0,0,0]], B = [0,0,0];
  for (let k = 0; k < X.length; k++) {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) A[i][j] += X[k][i] * X[k][j];
      B[i] += X[k][i] * Y[k];
    }
  }
  // Gauss-Jordan with partial pivoting.
  const M = A.map((row, i) => row.concat([B[i]]));
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const pv = M[col][col];
    if (Math.abs(pv) < 1e-12) return null;
    for (let j = 0; j <= n; j++) M[col][j] /= pv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      for (let j = 0; j <= n; j++) M[r][j] -= f * M[col][j];
    }
  }
  const [a, b, c] = M.map(row => row[n]);
  return { predict: (H, D) => Math.exp(a) * Math.pow(H, b) * Math.pow(D, c), n: X.length };
}

async function getTimeModel() {
  if (!timeModelPromise) {
    timeModelPromise = fetchStats()
      .then(d => fitTimeModel(d.climb_occurrences || []))
      .catch(() => null);
  }
  return timeModelPromise;
}

// Difficulty score (based on the FIETS index from the Dutch cycling
// magazine Fiets): rewards steep, sustained climbing and adds a bonus
// for high summits.
//   score = H² / (D×10) + max(0, (T−1000)/1000)
// with H = ascent (m), D = length (m), T = summit altitude (m).
// Tourmalet ≈ 10.4, Mauna Kea (world's hardest) ≈ 28.9, small hill ≈ 0.5.
function fietsScore(ascentM, lengthM, summitAltM) {
  if (!ascentM || !lengthM || ascentM <= 0 || lengthM <= 0) return null;
  const base = (ascentM * ascentM) / (lengthM * 10);
  const bonus = Math.max(0, (summitAltM - 1000) / 1000);
  return base + bonus;
}

// Profile-based difficulty (Cotacol method, as used by Climbfinder):
// the climb is cut into sections and each section scores
//   dI = 0.001 · s² · dL
// with s = local gradient (%) and dL = section length (m). Because
// effort grows with the square of the gradient, a steep wall inside
// an otherwise easy climb adds a lot of points — unlike the FIETS-style
// score which only sees totals. Summed over the whole profile it is the
// total effort to reach the top. A metre climbed at 10% = 1.0 point,
// at 5% = 0.5 points, at 1% = 0.1 points.
function cotacolScore(segment) {
  if (!segment || segment.length < 2) return null;
  const pts = segment
    .filter(r => r.altitude != null && r.distance != null)
    .sort((a, b) => a.distance - b.distance);
  if (pts.length < 2) return null;

  // Resample the profile at fixed 100 m stations (like the Encyclopedia
  // Cotacol): consecutive GPS records are a few metres apart and their
  // altitude jitter would explode through the squared gradient.
  const SECTION = 100;
  const d0 = pts[0].distance;
  const d1 = pts[pts.length - 1].distance;
  const nStations = Math.floor((d1 - d0) / SECTION);
  if (nStations < 1) return null;
  const altitudeAt = (d) => {
    let lo = null, hi = null;
    for (const r of pts) {
      if (r.distance <= d) lo = r;
      if (r.distance >= d && hi == null) hi = r;
    }
    if (lo && hi) {
      if (lo === hi) return lo.altitude;
      const t = (d - lo.distance) / Math.max(1e-6, hi.distance - lo.distance);
      return lo.altitude + (hi.altitude - lo.altitude) * t;
    }
    return lo ? lo.altitude : hi ? hi.altitude : null;
  };
  // Collect station altitudes, then smooth with a 3-station centred
  // median: barometric jitter of a couple of metres per station would
  // otherwise explode through the squared gradient term.
  const raw = [];
  for (let i = 0; i <= nStations; i++) {
    const a = altitudeAt(d0 + i * SECTION);
    raw.push(a);
  }
  const smoothed = raw.map((_, i) => {
    const w = raw.slice(Math.max(0, i - 1), i + 2).filter(v => v != null).sort((x, y) => x - y);
    return w.length ? w[Math.floor((w.length - 1) / 2)] : null;
  });
  let total = 0;
  for (let i = 0; i < nStations; i++) {
    const a = smoothed[i], b = smoothed[i + 1];
    if (a == null || b == null) continue;
    const grade = ((b - a) / SECTION) * 100;
    if (grade > 0) total += 0.001 * grade * grade * SECTION;
  }
  if (nStations * SECTION < 100) return null;
  return total;
}

function gradeColor(grade) {
  if (grade < -1) return '#0d6efd';      // blue downhill
  if (grade < 1) return '#2ecc71';       // bright green flat
  if (grade < 3) return '#f7d794';       // pale yellow
  if (grade < 6) return '#ffc107';       // gold
  if (grade < 9) return '#fd7e14';       // orange
  if (grade < 12) return '#dc3545';      // red
  if (grade < 20) return '#6f42c1';      // purple
  return '#000000';                      // black
}

function interpolateAltitude(segment, distanceM) {
  for (let i = 0; i < segment.length - 1; i++) {
    const a = segment[i], b = segment[i + 1];
    if (a.altitude == null || b.altitude == null) continue;
    if (distanceM >= a.distance && distanceM <= b.distance) {
      if (b.distance === a.distance) return a.altitude;
      const t = (distanceM - a.distance) / (b.distance - a.distance);
      return a.altitude + t * (b.altitude - a.altitude);
    }
  }
  const rec = segment.find(r => r.altitude != null && r.distance >= distanceM);
  if (rec) return rec.altitude;
  for (let i = segment.length - 1; i >= 0; i--) {
    if (segment[i].altitude != null) return segment[i].altitude;
  }
  return null;
}

function renderSegmentElevation(segment, startDistanceM) {
  const canvas = document.getElementById('climb-elevation-chart');
  if (!canvas || segment.length < 2) return;

  const totalM = Math.max(...segment.map(r => r.distance)) - startDistanceM;
  if (selectedBinSizeM == null) {
    if (totalM < 1000) selectedBinSizeM = 200;
    else if (totalM < 2000) selectedBinSizeM = 500;
    else selectedBinSizeM = 1000;
  }
  const binSizeM = selectedBinSizeM;
  const binSlider = document.getElementById('zone-bin');
  const binValue = document.getElementById('zone-bin-value');
  if (binSlider) {
    binSlider.value = BIN_SIZES.indexOf(binSizeM);
  }
  if (binValue) binValue.textContent = `${binSizeM} m`;

  const buckets = [];
  let k = 0;
  while (k * binSizeM < totalM) {
    const bucketStart = startDistanceM + k * binSizeM;
    const bucketEnd = Math.min(startDistanceM + (k + 1) * binSizeM, startDistanceM + totalM);
    let startIdx = -1;
    let endIdx = -1;
    for (let i = 0; i < segment.length; i++) {
      const r = segment[i];
      if (r.altitude == null) continue;
      if (r.distance >= bucketStart && r.distance <= bucketEnd) {
        if (startIdx === -1) startIdx = i;
        endIdx = i;
      }
    }
    if (startIdx !== -1) {
      const startAlt = segment[startIdx].altitude;
      const endAlt = segment[endIdx].altitude;
      const length = bucketEnd - bucketStart;
      const gain = endAlt - startAlt;
      const grade = length > 0 ? (gain / length) * 100 : 0;
      buckets.push({
        km: k + 1,
        startIdx,
        endIdx,
        startDistKm: (bucketStart - startDistanceM) / 1000,
        endDistKm: (bucketEnd - startDistanceM) / 1000,
        grade,
        length,
      });
    }
    k++;
  }

  let points = segment.filter(r => r.altitude != null).map(r => ({
    x: (r.distance - startDistanceM) / 1000,
    y: r.altitude,
  }));

  const boundaryDists = new Set();
  for (const b of buckets) {
    boundaryDists.add(b.startDistKm);
    boundaryDists.add(b.endDistKm);
  }
  for (const distKm of boundaryDists) {
    const alt = interpolateAltitude(segment, startDistanceM + distKm * 1000);
    if (alt != null) points.push({ x: distKm, y: alt });
  }
  points.sort((a, b) => a.x - b.x);
  const deduped = [];
  for (const p of points) {
    const last = deduped[deduped.length - 1];
    if (last && Math.abs(p.x - last.x) < 1e-6) continue;
    deduped.push(p);
  }
  points = deduped;

  const totalKm = totalM / 1000;
  const binSizeKm = binSizeM / 1000;

  if (window.climbElevationChart) window.climbElevationChart.destroy();
  const ctx = canvas.getContext('2d');
  window.climbElevationChart = new window.Chart(ctx, {
    type: 'line',
    data: {
      datasets: [{
        label: 'Elevation (m)',
        data: points,
        borderWidth: 3,
        pointRadius: 0,
        fill: {
          target: 'origin',
        },
        backgroundColor: 'rgba(13, 110, 253, 0.10)',
        tension: 0,
        segment: {
          borderColor: ctx => {
            const midX = (ctx.p0.parsed.x + ctx.p1.parsed.x) / 2;
            const bucket = buckets.find(b => midX >= b.startDistKm && midX <= b.endDistKm);
            return bucket ? gradeColor(bucket.grade) : '#0d6efd';
          }
        }
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      // Space between the lowest curve point and the x-axis so the grade
      // labels painted under the curve never clip against the axis.
      layout: { padding: { bottom: 28 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: items => `km ${items[0].parsed.x.toFixed(2)}`,
            label: item => {
              const midX = item.parsed.x;
              const b = (buckets || []).find(bb => midX >= bb.startDistKm && midX <= bb.endDistKm);
              const gradeLine = b ? ` · grade ${b.grade.toFixed(1)}%` : '';
              return `${item.raw.y.toFixed(0)} m${gradeLine}`;
            }
          }
        },
        segmentZones: { buckets, segment, startDistanceM }
      },
      scales: {
        x: {
          type: 'linear',
          min: 0,
          max: totalKm,
          title: { display: true, text: 'Distance (km)' },
          ticks: { stepSize: binSizeKm, autoSkip: false, maxRotation: 45, minRotation: 30 }
        },
        y: { title: { display: true, text: 'Elevation (m)' } }
      }
    },
    plugins: [{
      id: 'segmentZones',
      beforeDatasetsDraw(chart, args, options) {
        const { ctx, scales: { x, y }, chartArea } = chart;
        const buckets = options.buckets || [];
        const segment = options.segment || [];
        const startDistanceM = options.startDistanceM || 0;
        ctx.save();
        for (const b of buckets) {
          if (b.length <= 0 || b.startIdx < 0) continue;
          const bucketStartM = startDistanceM + b.startDistKm * 1000;
          const bucketEndM = startDistanceM + b.endDistKm * 1000;
          const inside = segment.filter(r => r.altitude != null && r.distance >= bucketStartM && r.distance <= bucketEndM);
          if (inside.length < 1) continue;

          const pts = [];
          const startY = interpolateAltitude(segment, bucketStartM);
          if (startY != null) pts.push({ distKm: b.startDistKm, alt: startY });
          for (const r of inside) {
            pts.push({ distKm: (r.distance - startDistanceM) / 1000, alt: r.altitude });
          }
          const endY = interpolateAltitude(segment, bucketEndM);
          if (endY != null) pts.push({ distKm: b.endDistKm, alt: endY });
          if (pts.length < 2) continue;

          const baseColor = gradeColor(b.grade);
          const r = parseInt(baseColor.slice(1, 3), 16);
          const g = parseInt(baseColor.slice(3, 5), 16);
          const bl = parseInt(baseColor.slice(5, 7), 16);
          ctx.fillStyle = `rgba(${r}, ${g}, ${bl}, 0.5)`;
          ctx.beginPath();
          const startX = x.getPixelForValue(b.startDistKm) - 0.5;
          const endX = x.getPixelForValue(b.endDistKm) + 0.5;
          ctx.moveTo(startX, chartArea.bottom);
          ctx.lineTo(startX, y.getPixelForValue(pts[0].alt));
          for (let i = 1; i < pts.length; i++) {
            ctx.lineTo(x.getPixelForValue(pts[i].distKm), y.getPixelForValue(pts[i].alt));
          }
          ctx.lineTo(endX, chartArea.bottom);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
      },
      afterDatasetsDraw(chart, args, options) {
        const { ctx, scales: { x, y }, chartArea } = chart;
        const buckets = options.buckets || [];
        const segment = options.segment || [];
        const startDistanceM = options.startDistanceM || 0;
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (const b of buckets) {
          if (b.startIdx === b.endIdx || b.startIdx < 0) continue;
          const startX = x.getPixelForValue(b.startDistKm);
          const endX = x.getPixelForValue(b.endDistKm);
          const zoneWidth = endX - startX;
          if (zoneWidth < 28) continue;
          const fontSize = Math.max(8, Math.min(12, Math.floor(zoneWidth / 5)));
          ctx.font = `bold ${fontSize}px system-ui, -apple-system, sans-serif`;
          let sumAlt = 0;
          let count = 0;
          for (let i = b.startIdx; i <= b.endIdx; i++) {
            const rec = segment[i];
            if (rec && rec.altitude != null) { sumAlt += rec.altitude; count++; }
          }
          if (count === 0) continue;
          const midX = (startX + endX) / 2;
          const curveY = y.getPixelForValue(sumAlt / count);
          // Place the label below the curve, clamped into the reserved
          // gap under the chart so it never clips into the x-axis.
          const midY = Math.min((curveY + chartArea.bottom) / 2, chartArea.bottom - 12);
          // Contrast-aware text color: white text on dark zone fills,
          // dark text on light ones, so grades stay readable on every
          // grade color in both themes.
          const zone = gradeColor(b.grade);
          const rr = parseInt(zone.slice(1, 3), 16);
          const gg = parseInt(zone.slice(3, 5), 16);
          const bb = parseInt(zone.slice(5, 7), 16);
          const lum = (0.299 * rr + 0.587 * gg + 0.114 * bb) / 255;
          ctx.fillStyle = lum < 0.55 ? '#ffffff' : '#212529';
          ctx.fillText(`${b.grade.toFixed(1)}%`, midX, midY);
        }
        ctx.restore();
      }
    }]
  });
}

async function renderStats(members, count) {
  const container = document.getElementById('climb-stats');
  if (members.length === 0) {
    container.innerHTML = '';
    return;
  }
  const latest = members[members.length - 1];
  const bestTime = members.filter(m => m.elapsed_time_s).sort((a, b) => a.elapsed_time_s - b.elapsed_time_s)[0];
  const bestVam = members.filter(m => m.vam).sort((a, b) => b.vam - a.vam)[0];
  const bestPower = members.map(m => {
    const wkg = m.est_power_w_per_kg
      || (m.avg_power && m.avg_power / 70)
      || (m.est_power_w && m.est_power_w / 70)
      || null;
    return { ...m, _wkg: wkg != null ? +wkg.toFixed(2) : null };
  }).filter(m => m._wkg != null).sort((a, b) => b._wkg - a._wkg)[0];

  // Start/end altitude: interpolated on the latest occurrence's records
  // (climbs.json stores distances, not altitudes).
  let altFromTo = null;
  const seg = currentSegment;
  if (seg && seg.length && latest) {
    const altAt = (distM) => {
      const sorted = seg.filter(r => r.altitude != null);
      if (!sorted.length) return null;
      let lo = null, hi = null;
      for (const r of sorted) {
        if (r.distance <= distM) lo = r;
        if (r.distance >= distM && hi == null) hi = r;
      }
      if (lo && hi && lo !== hi) {
        const t = (distM - lo.distance) / Math.max(1e-6, hi.distance - lo.distance);
        return Math.round(lo.altitude + (hi.altitude - lo.altitude) * t);
      }
      return lo ? Math.round(lo.altitude) : (hi ? Math.round(hi.altitude) : null);
    };
    const a1 = altAt(latest.start_distance_m);
    const a2 = altAt(latest.end_distance_m);
    if (a1 != null && a2 != null) altFromTo = `${fmtElevation(a1)} → ${fmtElevation(a2)}`;
  }

  // Difficulty score, from the same altitudes.
  const fiets = (function () {
    if (!altFromTo) return null;
    const seg2 = currentSegment;
    if (!seg2.length) return null;
    const topAlt = (function () {
      let top = null;
      for (const r of seg2) if (r.altitude != null && (top == null || r.altitude > top)) top = r.altitude;
      return top;
    })();
    return fietsScore(latest.elevation_gain_m, latest.length_m, topAlt);
  })();

  // Profile-based difficulty (Cotacol/Climbfinder): needs the full segment
  // records, not just totals.
  const cotacol = currentSegment && currentSegment.length ? cotacolScore(currentSegment) : null;

  const stats = [
    { label: 'Times done', value: count || members.length },
    { label: 'Length', value: fmtDistance(latest.length_m / 1000) },
    { label: 'Ascent', value: fmtElevation(latest.elevation_gain_m) },
    { label: 'Altitude', value: altFromTo || '-' },
    { label: 'Avg grade', value: fmtGrade(latest.avg_grade_percent) },
    { label: 'Difficulty', value: fiets != null ? fiets.toFixed(1) : '-', title: 'FIETS-based score from totals (ascent, length, summit)' },
    { label: 'Profile difficulty', value: cotacol != null ? cotacol.toFixed(0) + ' pts' : '-', title: 'Cotacol score (Climbfinder-style): sum of 0.001·grade²·length per section — steep sections weigh exponentially' },
    { label: 'Best time', value: bestTime ? fmtDuration(bestTime.elapsed_time_s) : '-' },
    { label: 'Predicted time', value: '…', id: 'stat-predicted' },
    { label: 'Best VAM', value: bestVam ? Math.round(bestVam.vam) + ' m/h' : '-' },
    { label: 'Best power/kg (est.)', value: bestPower ? `${bestPower._wkg.toFixed(2)} W/kg` : '-', title: 'Estimated from speed, gradient and body weight (no power meter needed)' },
  ];

  container.innerHTML = stats.map(s => `
    <div class="col-6 col-md-3">
      <div class="card text-center p-2" ${s.title ? `title="${s.title}"` : ''}>
        <div class="stat-value" ${s.id ? `id="${s.id}"` : ''}>${s.value}</div>
        <div class="stat-label">${s.label}</div>
      </div>
    </div>
  `).join('');

  // Fill the time prediction once the personal model is fitted.
  try {
    const model = await getTimeModel();
    const el = document.getElementById('stat-predicted');
    if (el && model) {
      const t = model.predict(latest.elevation_gain_m, latest.length_m);
      if (t && isFinite(t)) {
        let txt = fmtDuration(t);
        // Compare with the PR when there is one.
        if (bestTime) {
          const d = (t - bestTime.elapsed_time_s) / bestTime.elapsed_time_s * 100;
          txt += ` <span class="small ${d >= 0 ? 'text-success' : 'text-danger'}" title="Prediction vs your best time">(${d >= 0 ? '+' : ''}${d.toFixed(0)}% vs PR)</span>`;
        }
        el.innerHTML = txt;
        el.title = `Fit on ${model.n} of your climbs: T = a · H^b · D^c`;
      } else {
        el.textContent = '-';
      }
    } else if (el) {
      el.textContent = '-';
    }
  } catch (err) { /* prediction is optional */ }
}

function renderPerformances(members) {
  const tbody = document.getElementById('climb-perf-body');
  const noPerfs = document.getElementById('no-perfs');
  tbody.innerHTML = '';

  if (members.length === 0) {
    noPerfs.classList.remove('d-none');
    return;
  }
  noPerfs.classList.add('d-none');

  // Personal best on elapsed time, for the PR delta column.
  const timed = members.filter(m => m.elapsed_time_s != null);
  const bestTime = timed.length ? Math.min(...timed.map(m => m.elapsed_time_s)) : null;
  const fmtDelta = secs => {
    if (secs >= 3600) return `${Math.floor(secs / 3600)}h ${String(Math.floor(secs % 3600 / 60)).padStart(2, '0')}m ${String(Math.floor(secs % 60)).padStart(2, '0')}s`;
    if (secs >= 60) return `${Math.floor(secs / 60)}m ${String(Math.floor(secs % 60)).padStart(2, '0')}s`;
    return `${Math.round(secs)}s`;
  };

  // Newest first, like the activity feed.
  const ordered = members.slice().reverse();

  for (const m of ordered) {
    let deltaCell = '-';
    if (bestTime != null && m.elapsed_time_s != null) {
      const d = m.elapsed_time_s - bestTime;
      if (d > 0) deltaCell = `<span class="text-danger">+${fmtDelta(d)}</span>`;
      else if (d === 0) deltaCell = `<span class="text-success fw-bold">PR</span>`;
      else deltaCell = `<span class="text-success">-${fmtDelta(-d)}</span>`;
    }
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${fmtDate(m.start_time)}</td>
      <td><a href="#activity/${m.activity_id}" class="text-decoration-none">${escapeHtml(m.activity_name || 'Ride')}</a></td>
      <td>${m.elapsed_time_s ? fmtDuration(m.elapsed_time_s) : '-'}</td>
      <td>${deltaCell}</td>
      <td>${m.vam ? Math.round(m.vam) + ' m/h' : '-'}</td>
      <td>${(() => {
        const wkg = m.est_power_w_per_kg || (m.avg_power && m.avg_power / 70) || (m.est_power_w && m.est_power_w / 70);
        return wkg ? `${wkg.toFixed(2)} W/kg` : '-';
      })()}</td>
      <td>${fmtHr(m.avg_hr)}</td>
      <td>${fmtSpeed(m.avg_speed)}</td>
    `;
    tbody.appendChild(row);
  }
}

function renderPerfChart(members) {
  const canvas = document.getElementById('climb-perf-chart');
  if (!canvas || members.length === 0) return;

  const metric = document.getElementById('perf-metric').value;
  const meta = METRICS[metric];
  const validMembers = members.filter(m => {
    const v = meta.value(m);
    return v != null && !isNaN(v) && isFinite(v);
  });

  const ranked = validMembers.slice().sort((a, b) => meta.lowerIsBetter ? meta.value(a) - meta.value(b) : meta.value(b) - meta.value(a));
  const medalKeys = new Set(ranked.slice(0, 3).map(m => climbKey(m.activity_id, m.start_distance_m, m.end_distance_m)));

  const labels = members.map(m => fmtDate(m.start_time));
  const data = members.map(m => meta.value(m));
  const colors = members.map(m => {
    const key = climbKey(m.activity_id, m.start_distance_m, m.end_distance_m);
    if (!medalKeys.has(key)) return '#0d6efd';
    const pos = ranked.findIndex(r => r.activity_id === m.activity_id && pyRound(r.start_distance_m) === pyRound(m.start_distance_m));
    if (pos === 0) return '#ffd700';
    if (pos === 1) return '#c0c0c0';
    return '#cd7f32';
  });

  const showRegression = document.getElementById('perf-regression')?.checked;
  const regression = showRegression ? computeRegression(data) : null;
  const info = document.getElementById('perf-regression-info');
  if (info) {
    if (regression) {
      const a = -regression.slope;
      const aText = Math.abs(a) < 0.001 || Math.abs(a) > 10000 ? a.toExponential(3) : a.toFixed(4);
      if (metric === 'elapsed_time_s') {
        // Express the time trend in minutes per attempt, easier to read
        // than seconds per attempt.
        const aMin = a / 60;
        const bMin = regression.intercept / 60;
        const aMinText = Math.abs(aMin) < 0.001 || Math.abs(aMin) > 10000 ? aMin.toExponential(3) : aMin.toFixed(3);
        info.textContent = `R² = ${regression.r2.toFixed(3)} | time = ${aMinText >= 0 ? '-' : '+'}${Math.abs(aMinText)} min/attempt, ${(bMin / 60 >= 1 ? (bMin / 60).toFixed(1) + ' h' : bMin.toFixed(1) + ' min')} at attempt 0`;
      } else {
        info.textContent = `R² = ${regression.r2.toFixed(3)} | y = -${aText}·x + ${regression.intercept.toFixed(4)}`;
      }
    } else {
      info.textContent = '';
    }
  }

  const datasets = [];
  if (regression) {
    const dark = document.documentElement.getAttribute('data-bs-theme') === 'dark';
    datasets.push({
      label: `Regression (R² ${regression.r2.toFixed(2)})`,
      data: regression.predicted,
      type: 'line',
      borderColor: dark ? '#adb5bd' : '#343a40',
      borderWidth: 3,
      pointRadius: 0,
      fill: false,
    });
  }
  datasets.push({
    label: meta.label,
    data,
    pointBackgroundColor: colors,
    pointBorderColor: colors,
    pointRadius: 6,
    showLine: false,
  });

  const xScale = { title: { display: true, text: 'Date' }, ticks: { maxRotation: 45, minRotation: 30 } };
  if (validMembers.length === 1) {
    const idx = members.indexOf(validMembers[0]);
    xScale.min = idx - 0.5;
    xScale.max = idx + 0.5;
    xScale.offset = true;
  }

  const yScale = { title: { display: true, text: meta.axis } };
  if (metric === 'elapsed_time_s') {
    yScale.ticks = { callback: v => fmtDuration(v) };   // h:mm:ss instead of raw seconds
    yScale.type = 'linear';
  }

  if (window.climbPerfChart) window.climbPerfChart.destroy();
  const ctx = canvas.getContext('2d');
  window.climbPerfChart = new window.Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: items => items[0].label,
            label: item => `${meta.label}: ${meta.format(item.raw)}`
          }
        }
      },
      scales: {
        x: xScale,
        y: yScale
      }
    }
  });
}

function computeRegression(values) {
  const pairs = values.map((y, x) => ({ x, y })).filter(p => p.y != null && !isNaN(p.y));
  const n = pairs.length;
  if (n < 2) return null;
  const sumX = pairs.reduce((s, p) => s + p.x, 0);
  const sumY = pairs.reduce((s, p) => s + p.y, 0);
  const sumXY = pairs.reduce((s, p) => s + p.x * p.y, 0);
  const sumX2 = pairs.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  const predicted = values.map((_, x) => slope * x + intercept);
  const meanY = sumY / n;
  const ssRes = pairs.reduce((s, p) => s + Math.pow(p.y - predicted[p.x], 2), 0);
  const ssTot = pairs.reduce((s, p) => s + Math.pow(p.y - meanY, 2), 0);
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  return { slope, intercept, r2, predicted };
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
