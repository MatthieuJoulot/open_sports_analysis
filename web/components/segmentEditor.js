import { saveSegment } from '../utils/api.js';
import { baseLayer } from '../utils/mapTiles.js';

export function openSegmentEditor({ activityId, records, startDistanceM, endDistanceM, onSave }) {
  return new Promise((resolve) => {
    const existing = document.getElementById('segment-editor-modal');
    if (existing) existing.remove();

    const modalEl = document.createElement('div');
    modalEl.id = 'segment-editor-modal';
    modalEl.className = 'modal fade';
    modalEl.setAttribute('tabindex', '-1');
    modalEl.innerHTML = `
      <div class="modal-dialog modal-xl">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">Modify segment</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
          </div>
          <div class="modal-body">
            <div class="row g-2">
              <div class="col-md-8">
                <div id="segment-editor-map" style="height: 400px;"></div>
              </div>
              <div class="col-md-4">
                <div id="segment-editor-chart-wrap" style="height: 400px; position: relative;">
                  <canvas id="segment-editor-chart"></canvas>
                  <p id="segment-editor-no-chart" class="text-muted small mb-0 d-none">No elevation data.</p>
                </div>
              </div>
            </div>
            <div class="row g-2 mt-2 align-items-end">
              <div class="col-5">
                <label class="form-label small mb-0">Start distance (m)</label>
                <input type="number" step="0.1" class="form-control form-control-sm" id="segment-editor-start">
              </div>
              <div class="col-5">
                <label class="form-label small mb-0">End distance (m)</label>
                <input type="number" step="0.1" class="form-control form-control-sm" id="segment-editor-end">
              </div>
              <div class="col-2">
                <button class="btn btn-sm btn-outline-secondary w-100" id="segment-editor-reset">Reset</button>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-sm btn-outline-secondary" data-bs-dismiss="modal">Cancel</button>
            <button type="button" class="btn btn-sm btn-primary" id="segment-editor-save">Save</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modalEl);

    const modal = new window.bootstrap.Modal(modalEl);
    modal.show();

    modalEl.addEventListener('hidden.bs.modal', () => {
      modalEl.remove();
      resolve(editorState && editorState.savedSegment ? editorState.savedSegment : null);
    });

    let editorState = null;
    try {
      const { map, chart, state } = initMap({ activityId, records, startDistanceM, endDistanceM, onSave });
      editorState = state;
      modalEl.addEventListener('shown.bs.modal', () => {
        if (!map || !state) return;
        map.invalidateSize();
        if (state.segmentPolyline && state.segmentPolyline.getLatLngs().length > 0) {
          map.fitBounds(state.segmentPolyline.getBounds(), { padding: [80, 80] });
        } else if (state.fallbackBounds) {
          map.fitBounds(state.fallbackBounds, { padding: [30, 30] });
        }
        state.visibleRoute = getVisibleRoute(state.route, map);
        updateChartData(state, chart);
        if (chart) chart.resize();
      }, { once: true });
    } catch (err) {
      console.error('Segment editor initMap failed', err);
      throw err;
    }
  });
}

function initMap({ activityId, records, startDistanceM, endDistanceM, onSave }) {
  const mapContainer = document.getElementById('segment-editor-map');
  const map = L.map(mapContainer);
  baseLayer().then(l => l.addTo(map));

  const route = records.filter(r => r.position_lat != null && r.position_long != null);
  const points = route.map(r => [r.position_lat, r.position_long]);

  if (points.length < 2) {
    mapContainer.innerHTML = '<p class="text-muted small mb-0 p-2">No route data available.</p>';
    return;
  }

  const routePolyline = L.polyline(points, { color: '#adb5bd', weight: 4, opacity: 0.7 }).addTo(map);

  routePolyline.on('mousemove', e => {
    const snapped = findNearestByLatLon(route, e.latlng.lat, e.latlng.lng);
    if (snapped && state.hoverMarker) {
      state.hoverMarker.setLatLng([snapped.position_lat, snapped.position_long]);
      state.hoverMarker.setStyle({ opacity: 1, fillOpacity: 1 });
    }
    if (state.chart && state.visibleRoute) {
      const snappedVisible = findNearestByLatLon(state.visibleRoute, e.latlng.lat, e.latlng.lng);
      const idx = state.visibleRoute.indexOf(snappedVisible);
      if (idx >= 0) {
        state.chart.hoverIndex = idx;
        state.chart.update('none');
      }
    }
  });

  routePolyline.on('mouseout', () => {
    if (state.hoverMarker) state.hoverMarker.setStyle({ opacity: 0, fillOpacity: 0 });
    if (state.chart) {
      state.chart.hoverIndex = null;
      state.chart.update('none');
    }
  });

  const state = {
    startDistanceM,
    endDistanceM,
    originalStartDistanceM: startDistanceM,
    originalEndDistanceM: endDistanceM,
    route,
    startPoint: findNearestPoint(route, startDistanceM),
    endPoint: findNearestPoint(route, endDistanceM),
  };

  const segmentPoints = route
    .filter(r => r.distance >= state.startDistanceM && r.distance <= state.endDistanceM)
    .map(r => [r.position_lat, r.position_long]);
  const segmentPolyline = L.polyline(segmentPoints, { color: '#dc3545', weight: 6, opacity: 0.9 }).addTo(map);
  state.segmentPolyline = segmentPolyline;
  state.fallbackBounds = points;
  state.visibleRoute = route;

  const originalSegmentPoints = route
    .filter(r => r.distance >= state.originalStartDistanceM && r.distance <= state.originalEndDistanceM)
    .map(r => [r.position_lat, r.position_long]);
  L.polyline(originalSegmentPoints, { color: '#fd7e14', weight: 4, opacity: 0.6, dashArray: '6,6' }).addTo(map);

  const chart = renderElevationChart(state.visibleRoute, state);
  state.chart = chart;

  map.on('moveend', () => {
    state.visibleRoute = getVisibleRoute(route, map);
    updateChartData(state, chart);
  });

  const hoverMarker = L.circleMarker([state.startPoint.position_lat, state.startPoint.position_long], {
    radius: 6, color: '#ffffff', weight: 2, fillColor: '#0dcaf0', fillOpacity: 1, opacity: 1
  }).addTo(map).bindPopup('Hover');
  hoverMarker.setStyle({ opacity: 0, fillOpacity: 0 });
  state.hoverMarker = hoverMarker;

  const startMarker = createMarker(state.startPoint, '#198754', 'Start', map);
  const endMarker = createMarker(state.endPoint, '#dc3545', 'End', map);

  startMarker.on('dragend', () => {
    const snapped = findNearestByLatLon(route, startMarker.getLatLng().lat, startMarker.getLatLng().lng);
    state.startPoint = snapped;
    state.startDistanceM = snapped.distance;
    startMarker.setLatLng([snapped.position_lat, snapped.position_long]);
    updateSegment(state, segmentPolyline, startMarker, endMarker);
  });

  endMarker.on('dragend', () => {
    const snapped = findNearestByLatLon(route, endMarker.getLatLng().lat, endMarker.getLatLng().lng);
    state.endPoint = snapped;
    state.endDistanceM = snapped.distance;
    endMarker.setLatLng([snapped.position_lat, snapped.position_long]);
    updateSegment(state, segmentPolyline, startMarker, endMarker);
  });

  map.on('click', e => {
    const clicked = e.latlng;
    const startLL = startMarker.getLatLng();
    const endLL = endMarker.getLatLng();
    const dStart = haversine(clicked.lat, clicked.lng, startLL.lat, startLL.lng);
    const dEnd = haversine(clicked.lat, clicked.lng, endLL.lat, endLL.lng);
    const target = dStart < dEnd ? startMarker : endMarker;
    const snapped = findNearestByLatLon(route, clicked.lat, clicked.lng);
    target.setLatLng([snapped.position_lat, snapped.position_long]);
    if (target === startMarker) {
      state.startPoint = snapped;
      state.startDistanceM = snapped.distance;
    } else {
      state.endPoint = snapped;
      state.endDistanceM = snapped.distance;
    }
    updateSegment(state, segmentPolyline, startMarker, endMarker);
  });

  updateInputs(state);

  const startInput = document.getElementById('segment-editor-start');
  const endInput = document.getElementById('segment-editor-end');

  const applyInput = () => {
    const s = parseFloat(startInput.value);
    const e = parseFloat(endInput.value);
    if (Number.isNaN(s) || Number.isNaN(e)) return;
    state.startDistanceM = s;
    state.endDistanceM = e;
    state.startPoint = findNearestPoint(route, s);
    state.endPoint = findNearestPoint(route, e);
    startMarker.setLatLng([state.startPoint.position_lat, state.startPoint.position_long]);
    endMarker.setLatLng([state.endPoint.position_lat, state.endPoint.position_long]);
    updateSegment(state, segmentPolyline, startMarker, endMarker);
  };

  startInput.addEventListener('change', applyInput);
  endInput.addEventListener('change', applyInput);

  document.getElementById('segment-editor-reset').addEventListener('click', () => {
    state.startDistanceM = state.originalStartDistanceM;
    state.endDistanceM = state.originalEndDistanceM;
    state.startPoint = findNearestPoint(route, state.startDistanceM);
    state.endPoint = findNearestPoint(route, state.endDistanceM);
    startMarker.setLatLng([state.startPoint.position_lat, state.startPoint.position_long]);
    endMarker.setLatLng([state.endPoint.position_lat, state.endPoint.position_long]);
    updateSegment(state, segmentPolyline, startMarker, endMarker);
  });

  document.getElementById('segment-editor-save').addEventListener('click', async () => {
    const saveBtn = document.getElementById('segment-editor-save');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      const start = Math.min(state.startDistanceM, state.endDistanceM);
      const end = Math.max(state.startDistanceM, state.endDistanceM);
      const saved = await saveSegment(activityId, start, end, state.originalStartDistanceM, state.originalEndDistanceM);
      state.savedSegment = saved;
      if (onSave) onSave(saved);
      const modalEl = document.getElementById('segment-editor-modal');
      if (modalEl) window.bootstrap.Modal.getInstance(modalEl).hide();
    } catch (err) {
      console.error('Failed to save segment', err);
      alert('Could not save segment. Is the server running?');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }
  });

  return { map, chart, state };
}

function createMarker(point, color, label, map) {
  const icon = L.divIcon({
    className: 'segment-editor-marker',
    iconSize: [16, 16],
    iconAnchor: [8, 8],
    html: `<div style="width:16px;height:16px;background:${color};border:2px solid #fff;border-radius:50%;box-shadow:0 1px 3px rgba(0,0,0,0.5);"></div>`
  });
  return L.marker([point.position_lat, point.position_long], { icon, draggable: true }).addTo(map).bindPopup(label);
}

function findNearestByLatLon(route, lat, lon) {
  let best = null;
  let bestDist = Infinity;
  for (const r of route) {
    const d = haversine(lat, lon, r.position_lat, r.position_long);
    if (d < bestDist) {
      bestDist = d;
      best = r;
    }
  }
  return best;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function updateSegment(state, segmentPolyline, startMarker, endMarker) {
  const min = Math.min(state.startDistanceM, state.endDistanceM);
  const max = Math.max(state.startDistanceM, state.endDistanceM);
  const points = state.route
    .filter(r => r.distance >= min && r.distance <= max)
    .map(r => [r.position_lat, r.position_long]);
  segmentPolyline.setLatLngs(points);
  updateChartData(state, state.chart);
  updateInputs(state);
}

function updateChartData(state, chart) {
  if (!chart) return;
  const visible = state.visibleRoute || state.route;
  const min = Math.min(state.startDistanceM, state.endDistanceM);
  const max = Math.max(state.startDistanceM, state.endDistanceM);
  const inSegment = visible.map(r => r.distance >= min && r.distance <= max);
  chart.data.labels = visible.map(r => (r.distance / 1000).toFixed(1));
  chart.data.datasets[0].data = visible.map(r => r.altitude);
  chart.data.datasets[0].segment = {
    borderColor: ctx => inSegment[ctx.p0DataIndex] || inSegment[ctx.p1DataIndex] ? '#dc3545' : '#0d6efd'
  };
  chart.update('none');
}

function getVisibleRoute(route, map) {
  if (!map) return route;
  const bounds = map.getBounds();
  if (!bounds) return route;
  const visible = route.filter(r => bounds.contains([r.position_lat, r.position_long]));
  return visible.length > 1 ? visible : route;
}

function renderElevationChart(route, state) {
  const canvas = document.getElementById('segment-editor-chart');
  const noChart = document.getElementById('segment-editor-no-chart');
  console.log('renderElevationChart', { routeLength: route.length, hasAltitude: route.some(r => r.altitude != null), first: route[0] });
  if (!canvas) return null;
  if (!route.some(r => r.altitude != null)) {
    console.warn('No altitude data available for segment editor chart');
    if (noChart) noChart.classList.remove('d-none');
    return null;
  }

  const labels = route.map(r => (r.distance / 1000).toFixed(1));
  const data = route.map(r => r.altitude);
  const min = Math.min(state.startDistanceM, state.endDistanceM);
  const max = Math.max(state.startDistanceM, state.endDistanceM);
  const inSegment = route.map(r => r.distance >= min && r.distance <= max);

  return new window.Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Elevation',
        data,
        borderWidth: 2,
        pointRadius: 0,
        fill: true,
        backgroundColor: 'rgba(13, 110, 253, 0.1)',
        tension: 0.1,
        segment: {
          borderColor: ctx => inSegment[ctx.p0DataIndex] || inSegment[ctx.p1DataIndex] ? '#dc3545' : '#0d6efd'
        }
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: items => `km ${items[0].label}`,
            label: item => `${item.raw} m`
          }
        },
        verticalHoverLine: {}
      },
      scales: {
        x: { ticks: { maxTicksLimit: 6 } },
        y: { title: { display: true, text: 'Elevation (m)' } }
      },
      onHover: (e, elements) => {
        if (!state.chart) return;
        if (elements && elements.length) {
          state.chart.hoverIndex = elements[0].index;
          const r = state.visibleRoute[elements[0].index];
          if (r && state.hoverMarker) {
            state.hoverMarker.setLatLng([r.position_lat, r.position_long]);
            state.hoverMarker.setStyle({ opacity: 1, fillOpacity: 1 });
          }
        } else {
          state.chart.hoverIndex = null;
          if (state.hoverMarker) state.hoverMarker.setStyle({ opacity: 0, fillOpacity: 0 });
        }
      }
    },
    plugins: [{
      id: 'verticalHoverLine',
      afterDraw(chart) {
        const idx = chart.hoverIndex;
        if (idx == null) return;
        const { ctx, scales: { x, y }, chartArea } = chart;
        const px = x.getPixelForValue(idx);
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(px, chartArea.top);
        ctx.lineTo(px, chartArea.bottom);
        ctx.strokeStyle = '#0dcaf0';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.restore();
      }
    }]
  });
}

function findNearestPoint(route, distanceM) {
  let best = null;
  let bestDiff = Infinity;
  for (const r of route) {
    const diff = Math.abs(r.distance - distanceM);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = r;
    }
  }
  return best;
}

function updateInputs(state) {
  const startInput = document.getElementById('segment-editor-start');
  const endInput = document.getElementById('segment-editor-end');
  if (startInput) startInput.value = state.startDistanceM.toFixed(1);
  if (endInput) endInput.value = state.endDistanceM.toFixed(1);
}
