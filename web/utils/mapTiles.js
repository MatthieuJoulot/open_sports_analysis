// Central map basemap handling: a local PMTiles vector basemap when one
// is configured (offline, instant), remote raster tiles otherwise, and a
// remote fallback if the local layer does not come up (maplibre source
// loads can be dropped for good when the tab's main thread stalls —
// heavy pages can block the worker IPC handshake).
//
// The backend exposes /api/map-config with per-theme files and
// auto-extracted regions (each with its bbox). It serves archives at
// /api/basemap/<light|dark> and /api/basemap/region/<name> with HTTP
// ranges. Vector rendering runs through maplibre-gl, bridged into
// Leaflet with @maplibre/maplibre-gl-leaflet (both loaded in
// index.html); styles come from @protomaps/basemaps (global `basemaps`).

let mapConfigPromise = null;

async function getMapConfig() {
  if (!mapConfigPromise) {
    mapConfigPromise = fetch('/api/map-config')
      .then(r => r.ok ? r.json() : { local: {}, regions: [] })
      .catch(() => ({ local: {}, regions: [] }));
  }
  return mapConfigPromise;
}

export function invalidateMapConfig() {
  mapConfigPromise = null;
}

// Remote fallbacks. 'gray' = the muted ArcGIS canvas basemap used by
// heatmap/climbs pages; 'osm' = the colour street map elsewhere.
const REMOTE = {
  osm: {
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: { attribution: '&copy; OpenStreetMap contributors', maxZoom: 19 },
  },
  grayLight: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    options: { maxZoom: 19 },
  },
  grayDark: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    options: { maxZoom: 19 },
  },
};

function remoteLayer(kind) {
  const dark = document.documentElement.getAttribute('data-bs-theme') === 'dark';
  const def = kind === 'gray' ? (dark ? REMOTE.grayDark : REMOTE.grayLight) : REMOTE.osm;
  return L.tileLayer(def.url, def.options);
}

// Maplibre style JSON for a local vector archive. The pmtiles.js
// Protocol bridges z/x/y tile and TileJSON requests to HTTP ranges
// against the backend endpoint. MapLibre requires plain ArrayBuffers
// where tilev4 hands back Uint8Arrays, hence the re-wrap.
let protocolRegistered = false;
function ensurePmtilesProtocol() {
  if (protocolRegistered) return;
  const p = window.pmtiles;
  if (p?.Protocol && window.maplibregl) {
    const protocol = new p.Protocol();
    window.maplibregl.addProtocol('pmtiles', async (params, abort) => {
      const res = await protocol.tilev4(params, abort);
      if (res?.data instanceof Uint8Array) {
        return { ...res, data: res.data.buffer.slice(res.data.byteOffset, res.data.byteOffset + res.data.byteLength) };
      }
      return res;
    });
  }
  protocolRegistered = true;
}

function protomapsStyle(url) {
  ensurePmtilesProtocol();
  const sourceId = 'pmtiles';
  const dark = document.documentElement.getAttribute('data-bs-theme') === 'dark';
  const palette = window.basemaps[dark ? 'DARK' : 'LIGHT'];
  const layers = window.basemaps.layers(sourceId, palette, { lang: 'fr' });
  return {
    version: 8,
    glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
    sources: {
      [sourceId]: {
        type: 'vector',
        url: 'pmtiles://' + url,
      },
    },
    layers,
  };
}

// Local archive URL to use for a map centered/bounded at `opts`:
// a region extract covering the center if one exists, else the theme
// file, else null (no local basemap available for this view).
function localUrlFor(cfg, opts) {
  const dark = document.documentElement.getAttribute('data-bs-theme') === 'dark';
  const flavor = dark ? 'dark' : 'light';
  if (opts?.center) {
    const [lat, lon] = opts.center;
    const region = (cfg.regions || []).find(r => {
      const [w, s, e, n] = r.bbox;
      return lon >= w && lon <= e && lat >= s && lat <= n && (r.size_bytes || 0) > 0;
    });
    if (region) return '/api/basemap/region/' + encodeURIComponent(region.region);
  }
  if (cfg.local?.[flavor]) return '/api/basemap/' + flavor;
  return null;
}

// Vector layer wrapped with a watchdog: if the maplibre source has not
// come up within LOAD_TIMEOUT (a dropped worker handshake never
// recovers, leaving a blank map), swap in the remote raster basemap.
const LOAD_TIMEOUT = 15000;

function vectorLayerWithWatchdog(url, remoteKind) {
  const group = L.layerGroup();
  let gl = new L.MaplibreGL({ style: protomapsStyle(url), preserveDrawingBuffer: true });
  group.addLayer(gl);
  const timer = setTimeout(() => {
    const map = gl._map;
    const glMap = gl._glMap;
    const dead = !glMap || (glMap.isStyleLoaded && !glMap.isStyleLoaded() && !glMap.getSource('pmtiles'))
      || (glMap.isSourceLoaded && !glMap.isSourceLoaded('pmtiles'));
    if (dead && map) {
      group.removeLayer(gl);
      gl = null;
      group.addLayer(remoteLayer(remoteKind));
    }
  }, LOAD_TIMEOUT);
  // Success: clear the watchdog once the source is loaded.
  const checkLoaded = setInterval(() => {
    const glMap = gl && gl._glMap;
    if (glMap && (glMap.isStyleLoaded() || glMap.isSourceLoaded('pmtiles'))) {
      clearTimeout(timer);
      clearInterval(checkLoaded);
    }
    if (!gl) clearInterval(checkLoaded);
  }, 1000);
  return group;
}

/**
 * Basemap for a Leaflet map. kind: 'osm' (colour streets) or 'gray'
 * (muted canvas following the theme). opts: {center: [lat, lon]} —
 * picks the local archive whose region covers that point. Local
 * PMTiles when available, remote otherwise. Resolves to a Leaflet layer.
 */
export async function baseLayer(kind = 'osm', opts = {}) {
  const dark = document.documentElement.getAttribute('data-bs-theme') === 'dark';
  const flavor = dark ? 'dark' : 'light';
  const cfg = await getMapConfig();
  const localUrl = localUrlFor(cfg, opts);
  if (localUrl && window.L?.MaplibreGL && window.maplibregl && window.basemaps) {
    try {
      return vectorLayerWithWatchdog(localUrl, kind);
    } catch (e) {
      return remoteLayer(kind);
    }
  }
  return remoteLayer(kind);
}
