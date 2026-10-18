import { fetchConfig, saveConfig, importFiles, scanHistory, fetchHistoryScanStatus, downloadHistory, fetchHistoryDownloadStatus } from '../utils/api.js';
import { SPORTS } from '../utils/sports.js';

export async function renderParameters() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div id="parameters-view" class="mx-auto" style="max-width: 720px;">
      <h4 class="mb-3">Parameters</h4>

      <div class="card mb-3">
        <div class="card-header fw-semibold">Configuration</div>
        <div class="card-body">
          <p class="small text-muted">
            Saved to <code id="config-file-path"></code>. You can also edit this file directly and restart the server.
          </p>
          <form id="config-form">
            <div class="mb-3">
              <label class="form-label" for="cfg-health_data_dir">HealthData directory (GarminDB data)</label>
              <input class="form-control form-control-sm text-muted" id="cfg-health_data_dir" placeholder="/path/to/HealthData">
              <div class="form-text">The database and file paths are derived from it (DBs/ and FitFiles/ inside).</div>
            </div>
            <div class="mb-3">
              <label class="form-label" for="cfg-garmindb_cli">GarminDB CLI (optional)</label>
              <input class="form-control form-control-sm text-muted" id="cfg-garmindb_cli" placeholder="/path/to/garmindb_cli.py">
              <div class="form-text path-status" data-path="garmindb_cli_exists"></div>
            </div>
            <div class="form-check form-switch mb-3">
              <input class="form-check-input" type="checkbox" id="cfg-sync_latest">
              <label class="form-check-label" for="cfg-sync_latest">Fast fetch (only fetch the latest activities; untick to walk the whole history)</label>
            </div>

            <div class="mb-3">
              <label class="form-label">Sports shown in the app</label>
              <div class="d-flex flex-wrap gap-3" id="cfg-sports">
                ${Object.entries(SPORTS).map(([key, meta]) => `
                  <div class="form-check mb-0">
                    <input class="form-check-input cfg-sport" type="checkbox" value="${key}" id="cfg-sport-${key}">
                    <label class="form-check-label" for="cfg-sport-${key}">${meta.icon} ${meta.label}</label>
                  </div>`).join('')}
              </div>
              <div class="form-text">Unticked sports stay in the database but are hidden from the sidebar, feed and statistics.</div>
            </div>

            <div class="mb-3">
              <label class="form-label">Offline basemaps (PMTiles)</label>
              <div class="row g-2">
                <div class="col-md-6">
                  <label class="form-label small" for="cfg-basemap_light">Light theme</label>
                  <input class="form-control form-control-sm text-muted" id="cfg-basemap_light" placeholder="e.g. cache/basemap-light.pmtiles">
                </div>
                <div class="col-md-6">
                  <label class="form-label small" for="cfg-basemap_dark">Dark theme</label>
                  <input class="form-control form-control-sm text-muted" id="cfg-basemap_dark" placeholder="e.g. cache/basemap-dark.pmtiles">
                </div>
              </div>
              <div class="form-text">Maps load from these files first (instant, offline) and fall back to online tiles when a file is missing or a tile is out of range. Build extracts at <a href="https://protomaps.com/docs/build" target="_blank" rel="noopener">protomaps.com</a> or grab a country extract from <a href="https://data.source.coop/protomaps/openstreetmap/tiles/" target="_blank" rel="noopener">protomaps tiles</a>.</div>
            </div>

            <a class="small text-decoration-none" data-bs-toggle="collapse" href="#advanced-paths" role="button">Advanced paths</a>
            <div class="collapse mt-2" id="advanced-paths">
              <p class="small text-muted mb-2">Set these only if your layout differs from the standard GarminDB structure.</p>
              <div class="mb-3">
                <label class="form-label small" for="cfg-activities_db">Activities database (SQLite)</label>
                <input class="form-control form-control-sm text-muted" id="cfg-activities_db" placeholder="derived from HealthData directory">
                <div class="form-text path-status" data-path="activities_db_exists"></div>
              </div>
              <div class="mb-3">
                <label class="form-label small" for="cfg-garmin_db">Garmin database (SQLite)</label>
                <input class="form-control form-control-sm text-muted" id="cfg-garmin_db" placeholder="derived from HealthData directory">
                <div class="form-text path-status" data-path="garmin_db_exists"></div>
              </div>
              <div class="mb-3">
                <label class="form-label small" for="cfg-fit_dir">FIT files directory</label>
                <input class="form-control form-control-sm text-muted" id="cfg-fit_dir" placeholder="derived from HealthData directory">
                <div class="form-text path-status" data-path="fit_dir_exists"></div>
              </div>
              <div class="mb-3">
                <label class="form-label small" for="cfg-personal_info_json">Personal info JSON</label>
                <input class="form-control form-control-sm text-muted" id="cfg-personal_info_json" placeholder="derived from HealthData directory">
              </div>
            </div>

            <div class="mt-3">
              <button type="submit" class="btn btn-primary btn-sm" id="config-save-btn">Save configuration</button>
              <span id="config-saved-msg" class="text-success small ms-2 d-none">Saved ✓ — restart the server if you changed paths or the CLI.</span>
            </div>
          </form>
        </div>
      </div>

      <div class="card mb-3">
        <div class="card-header fw-semibold">Download history</div>
        <div class="card-body">
          <p class="small text-muted mb-2">
            The initial setup only downloads the 1000 most recent activities.
            Scan your Garmin Connect account to see what else is available, then download it in chunks.
          </p>
          <button class="btn btn-sm btn-outline-primary" id="history-scan-btn">Scan Garmin Connect</button>
          <span id="history-scan-status" class="small ms-2 text-muted"></span>
          <div id="history-scan-result" class="mt-2 d-none">
            <div id="history-summary" class="small mb-2"></div>
            <div id="history-chunks" class="d-flex flex-wrap gap-2"></div>
            <div id="history-download-status" class="small mt-2"></div>
          </div>
        </div>
      </div>

      <div class="card mb-3">
        <div class="card-header fw-semibold">Climb databases (cycling)</div>
        <div class="card-body">
          <p class="small text-muted mb-2">
            Copy a curated cols list, your segment edits, climb names, or validated climbs from another installation.
            These feed the cycling climb features; give the path of the source file (e.g. <code>/path/to/other/install/cols.json</code>); it is copied here, the source is untouched.
          </p>
          <form id="import-form">
            <div class="row g-2">
              <div class="col-md-6">
                <label class="form-label small">Cols list (cols.json)</label>
                <input class="form-control form-control-sm text-muted" id="imp-cols" placeholder="/path/to/cols.json">
              </div>
              <div class="col-md-6">
                <label class="form-label small">Segment edits (climb_segments.json)</label>
                <input class="form-control form-control-sm text-muted" id="imp-segments" placeholder="/path/to/climb_segments.json">
              </div>
              <div class="col-md-6">
                <label class="form-label small">Climb names (climb_names.json)</label>
                <input class="form-control form-control-sm text-muted" id="imp-names" placeholder="/path/to/climb_names.json">
              </div>
              <div class="col-md-6">
                <label class="form-label small">Validated climbs (validated_climbs.json)</label>
                <input class="form-control form-control-sm text-muted" id="imp-validated" placeholder="/path/to/validated_climbs.json">
              </div>
            </div>
            <button type="submit" class="btn btn-sm btn-outline-primary mt-3" id="import-btn">Import</button>
            <span id="import-result" class="small ms-2"></span>
          </form>
        </div>
      </div>

      <p class="small text-muted">Server port is configured in <code id="config-port-hint"></code>; changing it requires a server restart.</p>
    </div>
  `;

  const status = await fetchConfig();
  fillForm(status);

  document.getElementById('config-file-path').textContent = status.config_file || 'config.json';
  document.getElementById('config-port-hint').textContent = status.config_file || 'config.json';

  document.getElementById('config-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('config-save-btn');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const payload = {
        health_data_dir: document.getElementById('cfg-health_data_dir').value.trim(),
        garmindb_cli: document.getElementById('cfg-garmindb_cli').value.trim(),
        sync_latest: document.getElementById('cfg-sync_latest').checked,
        sports: [...document.querySelectorAll('.cfg-sport:checked')].map(cb => cb.value),
        basemap_light: document.getElementById('cfg-basemap_light').value.trim(),
        basemap_dark: document.getElementById('cfg-basemap_dark').value.trim(),
      };
      for (const f of ['activities_db', 'garmin_db', 'fit_dir', 'personal_info_json']) {
        payload[f] = document.getElementById('cfg-' + f).value.trim();
      }
      const updated = await saveConfig(payload);
      document.getElementById('config-saved-msg').classList.remove('d-none');
      fillForm(updated);
    } catch (err) {
      alert(err.message || 'Could not save configuration');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save configuration';
    }
  });
  document.getElementById('import-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('import-btn');
    const result = document.getElementById('import-result');
    const payload = {};
    for (const [key, id] of [['cols', 'imp-cols'], ['segments', 'imp-segments'], ['names', 'imp-names'], ['validated', 'imp-validated']]) {
      const v = document.getElementById(id).value.trim();
      if (v) payload[key] = v;
    }
    if (Object.keys(payload).length === 0) {
      result.textContent = 'Nothing to import — fill at least one path.';
      result.className = 'small ms-2 text-warning';
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Importing…';
    result.textContent = '';
    try {
      const res = await importFiles(payload);
      const parts = Object.entries(res.imported || {})
        .filter(([k]) => k !== 'groups' && !k.endsWith('_warning'))
        .map(([k, v]) => `${k}: ${v.entries} entries`);
      result.textContent = 'Imported — ' + parts.join(', ') + '. Reload pages to see the changes.';
      result.className = 'small ms-2 text-success';
    } catch (err) {
      result.textContent = err.message || 'Import failed';
      result.className = 'small ms-2 text-danger';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Import';
    }
  });

  setupHistorySection();
}

function setupHistorySection() {
  const scanBtn = document.getElementById('history-scan-btn');
  const scanStatus = document.getElementById('history-scan-status');
  const scanResult = document.getElementById('history-scan-result');
  if (!scanBtn) return;

  scanBtn.addEventListener('click', async () => {
    scanBtn.disabled = true;
    scanStatus.textContent = 'Scanning…';
    try {
      await scanHistory();
      pollScan(scanBtn, scanStatus, scanResult);
    } catch (err) {
      scanStatus.textContent = err.message || 'Scan failed';
      scanBtn.disabled = false;
    }
  });

  // Show a previous scan if one exists.
  fetchHistoryScanStatus().then(state => {
    if (state.scanning) {
      scanBtn.disabled = true;
      pollScan(scanBtn, scanStatus, scanResult);
    } else if (state.scan_result) {
      renderScan(state.scan_result, scanResult);
    }
  }).catch(() => {});

  // Show a download in progress or a recently finished one the user may
  // not have seen (e.g. they were on another page while it ran).
  fetchHistoryDownloadStatus().then(state => {
    if (state.running && state.kind === 'history-download') {
      const fakeBtn = document.createElement('button');
      fakeBtn.disabled = true;
      watchDownload(fakeBtn);
    } else if (state.finished_at && state.result && state.result.ok && state.kind === 'history-download') {
      const ageMs = Date.now() - new Date(state.finished_at).getTime();
      if (ageMs < 1000 * 60 * 30) {
        const r = state.result;
        const status = document.getElementById('history-download-status');
        status.dataset.doneMessage = `Download complete — ${r.new_activities || 0} new activities analyzed, ${r.new_climbs || 0} new climb(s).`;
        status.textContent = status.dataset.doneMessage;
        status.className = 'small mt-2 text-success fw-semibold';
      }
    }
  }).catch(() => {});
}

function pollScan(scanBtn, scanStatus, scanResult) {
  const timer = setInterval(async () => {
    try {
      const state = await fetchHistoryScanStatus();
      if (state.scanning) return;
      clearInterval(timer);
      scanBtn.disabled = false;
      if (state.scan_error) {
        scanStatus.textContent = 'Scan failed: ' + state.scan_error;
        scanStatus.className = 'small ms-2 text-danger';
      } else if (state.scan_result) {
        scanStatus.textContent = '';
        renderScan(state.scan_result, scanResult);
      }
    } catch (e) { /* keep polling */ }
  }, 1000);
}

function renderScan(result, container) {
  container.classList.remove('d-none');
  const missing = result.missing || 0;
  if (missing === 0) {
    document.getElementById('history-summary').textContent =
      `All ${result.total} activities are downloaded (oldest: ${result.oldest || '?'}). Nothing to fetch.`;
    document.getElementById('history-chunks').innerHTML = '';
    return;
  }
  const byYear = result.missing_by_year || {};
  const oldestYear = Object.keys(byYear).sort()[0];
  document.getElementById('history-summary').textContent =
    `${result.total} activities on Garmin Connect (${result.oldest || '?'} → today) · ${result.local} already downloaded · ${missing} missing.`;

  const chunks = document.getElementById('history-chunks');
  chunks.innerHTML = '';

  // Chunk buttons: next 10 (quick test), next 500, and per-oldest-year groups.
  const next10 = document.createElement('button');
  next10.className = 'btn btn-sm btn-outline-primary';
  next10.textContent = 'Download next 10';
  next10.addEventListener('click', () => startDownload(10, next10));
  chunks.appendChild(next10);

  const next500 = document.createElement('button');
  next500.className = 'btn btn-sm btn-outline-primary';
  next500.textContent = 'Download next 500';
  next500.addEventListener('click', () => startDownload(500, next500));
  chunks.appendChild(next500);

  let cumulative = 0;
  const years = Object.keys(byYear).sort(); // oldest first
  for (const year of years) {
    cumulative += byYear[year];
    if (cumulative === 0) continue;
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm btn-outline-secondary';
    btn.textContent = `Download through ${year} (+${cumulative})`;
    btn.addEventListener('click', () => startDownload(cumulative, btn));
    chunks.appendChild(btn);
    if (cumulative >= missing) break;
  }

  const all = document.createElement('button');
  all.className = 'btn btn-sm btn-outline-danger';
  all.textContent = `Download everything (${missing})`;
  all.addEventListener('click', () => startDownload(missing, all));
  chunks.appendChild(all);
}

function startDownload(count, btn) {
  const status = document.getElementById('history-download-status');
  btn.disabled = true;
  status.textContent = 'Download started…';
  status.className = 'small mt-2 text-muted';
  downloadHistory(count).then(() => {
    watchDownload(btn);
  }).catch(err => {
    status.textContent = err.message || 'Failed to start download';
    status.className = 'small mt-2 text-danger';
    btn.disabled = false;
  });
}

function watchDownload(btn) {
  const status = document.getElementById('history-download-status');
  const timer = setInterval(async () => {
    try {
      const state = await fetchHistoryDownloadStatus();
      if (state.running) {
        status.textContent = 'Downloading… ' + (state.last_log ? state.last_log[state.last_log.length - 1] : '');
        status.className = 'small mt-2 text-muted';
        return;
      }
      clearInterval(timer);
      if (btn) btn.disabled = false;
      if (state.error) {
        status.textContent = 'Download failed: ' + state.error;
        status.className = 'small mt-2 text-danger';
      } else {
        const r = state.result || {};
        status.dataset.doneMessage = `Download complete — ${r.new_activities || 0} new activities analyzed, ${r.new_climbs || 0} new climb(s).`;
        status.textContent = status.dataset.doneMessage;
        status.className = 'small mt-2 text-success fw-semibold';
        autoRescan();
      }
    } catch (e) { /* keep polling */ }
  }, 2000);
}

function autoRescan() {
  const scanBtn = document.getElementById('history-scan-btn');
  const scanStatus = document.getElementById('history-scan-status');
  const scanResult = document.getElementById('history-scan-result');
  scanBtn.disabled = true;
  scanHistory().then(() => {
    const timer = setInterval(async () => {
      try {
        const state = await fetchHistoryScanStatus();
        if (state.scanning) return;
        clearInterval(timer);
        scanBtn.disabled = false;
        if (state.scan_result) {
          renderScan(state.scan_result, scanResult);
          // Keep the green completion message visible across re-renders.
          const status = document.getElementById('history-download-status');
          if (status && status.dataset.doneMessage && !state.scanning) {
            status.textContent = status.dataset.doneMessage;
            status.className = 'small mt-2 text-success fw-semibold';
          }
        }
      } catch (e) { /* keep polling */ }
    }, 1000);
  }).catch(() => { scanBtn.disabled = false; });
}

function fillForm(status) {
  const values = status.values || {};
  document.getElementById('cfg-health_data_dir').value = values.health_data_dir || '';
  document.getElementById('cfg-garmindb_cli').value = values.garmindb_cli || '';
  document.getElementById('cfg-sync_latest').checked = values.sync_latest !== false;
  const enabledSports = Array.isArray(values.sports) ? values.sports : Object.keys(SPORTS);
  for (const cb of document.querySelectorAll('.cfg-sport')) {
    cb.checked = enabledSports.includes(cb.value);
  }
  document.getElementById('cfg-basemap_light').value = values.basemap_light || '';
  document.getElementById('cfg-basemap_dark').value = values.basemap_dark || '';
  for (const f of ['activities_db', 'garmin_db', 'fit_dir', 'personal_info_json']) {
    document.getElementById('cfg-' + f).value = values[f] || '';
  }
  applyPathStatus(status);
}

function applyPathStatus(status) {
  for (const el of document.querySelectorAll('.path-status')) {
    const key = el.dataset.path;
    if (key in (status.paths || {})) {
      el.textContent = status.paths[key] ? '✓ found' : '⚠ not found';
      el.className = 'form-text path-status ' + (status.paths[key] ? 'text-success' : 'text-warning');
    }
  }
}
