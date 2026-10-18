// Central map basemap handling: a local PMTiles vector basemap when one
// is configured (offline, instant), remote raster tiles otherwise, and a
// remote fallback if the local layer does not come up (maplibre source
// loads can be dropped for good when the tab's main thread stalls —
// heavy pages can block the worker IPC handshake).
//
// The backend exposes /api/map-config {local: {light, dark}} and serves
// the configured archive at /api/basemap/<light|dark> with HTTP ranges.
// Vector rendering runs through maplibre-gl, bridged into Leaflet with
// @maplibre/maplibre-gl-leaflet (both loaded in index.html); styles are
// built from @protomaps/basemaps (global `basemaps`).

let mapConfigPromise = null;

async function getMapConfig() {
  if (!mapConfigPromise) {
    mapConfigPromise = fetch('/api/map-config')
      .then(r => r.ok ? r.json() : { local: {} })
      .catch(() => ({ local: {} }));
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

// Maplibre style JSON for the local vector archive. The pmtiles.js
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

function protomapsStyle(flavor) {
  ensurePmtilesProtocol();
  const sourceId = 'pmtiles';
  const palette = window.basemaps[flavor === 'dark' ? 'DARK' : 'LIGHT'];
  const layers = window.basemaps.layers(sourceId, palette, { lang: 'fr' });
  return {
    version: 8,
    glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
    sources: {
      [sourceId]: {
        type: 'vector',
        url: 'pmtiles:///api/basemap/' + (flavor === 'dark' ? 'dark' : 'light'),
      },
    },
    layers,
  };
}

// Vector layer wrapped with a watchdog: if the maplibre source has not
// come up within LOAD_TIMEOUT (a dropped worker handshake never
// recovers, leaving a blank map), swap in the remote raster basemap.
const LOAD_TIMEOUT = 15000;

function vectorLayerWithWatchdog(flavor, remoteKind) {
  const group = L.layerGroup();
  let gl = new L.MaplibreGL({ style: protomapsStyle(flavor), preserveDrawingBuffer: true });
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
 * (muted canvas following the theme). Local PMTiles when configured,
 * remote otherwise. Resolves to a Leaflet layer.
 */
export async function baseLayer(kind = 'osm') {
  const dark = document.documentElement.getAttribute('data-bs-theme') === 'dark';
  const flavor = dark ? 'dark' : 'light';
  const cfg = await getMapConfig();
  if (cfg.local?.[flavor] && window.L?.MaplibreGL && window.maplibregl && window.basemaps) {
    try {
      return vectorLayerWithWatchdog(flavor, kind);
    } catch (e) {
      return remoteLayer(kind);
    }
  }
  return remoteLayer(kind);
}
