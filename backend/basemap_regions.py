"""Basemap region management: extracts PMTiles archives on demand.

When an activity is fetched whose GPS track lies outside every existing
local basemap, the region it belongs to is queued for extraction: the
region's bbox is the padded bounding box of all activities in that area,
and `pmtiles extract` pulls just those bytes from the public protomaps
planet archive. One download per region (France, Scotland, ...), then
every activity there renders locally.

The registry lives in cache/basemap-regions.json; the archives in
cache/basemap-<region>.pmtiles. All state is regenerable: deleting the
files simply re-triggers extracts.
"""

import json
import math
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path

APP_ROOT = Path(__file__).parent.parent
REGIONS_FILE = APP_ROOT / "cache" / "basemap-regions.json"
PLANET_URL = "https://data.source.coop/protomaps/openstreetmap/v4.pmtiles"
MAX_ZOOM = 12          # extract detail; higher zooms overzoom from here
BBOX_PAD_DEG = 0.15    # margin around track bounds (~15 km)

# Anchors only used to name regions; the bbox is the real coverage.
CANONICAL_REGIONS = [
    ("france", ( -5.5, 41.0,  9.8, 51.3)),
    ("uk",     ( -8.0, 49.8,  2.0, 61.0)),
    ("spain",  ( -9.5, 35.8,  4.5, 43.8)),
    ("italy",  (  6.5, 36.5, 18.7, 47.0)),
    ("germany", ( 5.8, 47.2, 15.2, 55.1)),
    ("alps",   (  5.8, 44.0, 16.0, 48.5)),
]

_lock = threading.Lock()
_queue = []
_current = None       # {"region": ..., "started": ts}
_status = {}          # region -> {status, error, started, finished, size}
_theme_bounds = None  # bbox of the config's basemap_light file, if any


def _parse_pmtiles_bounds(path):
    """bbox [w, s, e, n] of a PMTiles file via the pmtiles CLI."""
    try:
        res = subprocess.run(["pmtiles", "show", str(path)],
                              capture_output=True, text=True, timeout=30)
        m = re.search(r"bounds: \(long: *([-\d.]+), lat: *([-\d.]+)\)"
                      r" \(long: *([-\d.]+), lat: *([-\d.]+)\)", res.stdout)
        if m:
            return [float(m.group(1)), float(m.group(2)),
                    float(m.group(3)), float(m.group(4))]
    except Exception:
        pass
    return None


def refresh_theme_bounds():
    """Coverage of the theme basemap file, so activities inside it do
    not trigger a redundant region extract."""
    global _theme_bounds
    try:
        from config import current_config
        raw = (current_config().get("basemap_light") or "")
        if not raw:
            _theme_bounds = None
            return
        p = Path(raw).expanduser()
        if not p.is_absolute():
            p = (APP_ROOT / p).resolve()
        _theme_bounds = _parse_pmtiles_bounds(p) if p.is_file() else None
    except Exception:
        _theme_bounds = None


def invalidate_region_config_cache():
    """No-op placeholder so config saves can notify cleanly; state is
    read fresh from disk each time anyway."""
    return None


def _load():
    try:
        return json.loads(REGIONS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {"regions": []}


def _save(data):
    REGIONS_FILE.parent.mkdir(parents=True, exist_ok=True)
    REGIONS_FILE.write_text(
        json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def region_path(name):
    safe = re.sub(r"[^a-z0-9-]", "", name.lower())
    return APP_ROOT / "cache" / f"basemap-{safe}.pmtiles"


def list_regions():
    """Regions with an extract present, plus live job status."""
    data = _load()
    out = []
    for r in data.get("regions", []):
        p = region_path(r["region"])
        st = dict(_status.get(r["region"], {}))
        if p.is_file() and r.get("generated_at") and "status" not in st:
            st["status"] = "done"
        out.append({
            "region": r["region"],
            "bbox": r["bbox"],
            "file": str(p),
            "size_bytes": p.stat().st_size if p.is_file() else 0,
            "generated_at": r.get("generated_at"),
            **{k: v for k, v in st.items() if k != "file"},
        })
    current = dict(_current) if _current else None
    return {"regions": out, "current": current,
            "queued": list(_queue), "planet_url": PLANET_URL}


def covering_region(lat, lon):
    """Name of the local region containing this point, or None.
    The theme file's coverage counts too."""
    if _theme_bounds:
        w, s, e, n = _theme_bounds
        if w <= lon <= e and s <= lat <= n:
            return "__theme__"
    for r in _load().get("regions", []):
        w, s, e, n = r["bbox"]
        if w <= lon <= e and s <= lat <= n:
            p = region_path(r["region"])
            if p.is_file():
                return r["region"]
    return None


def _canonical_name(lon, lat):
    for name, (w, s, e, n) in CANONICAL_REGIONS:
        if w <= lon <= e and s <= lat <= n:
            return name
    return None


def ensure_region(lat, lon, bounds=None, name=None):
    """Make sure a region covering (lat, lon) exists — either found in
    the registry, or computed from `bounds` (track bbox as [w,s,e,n]
    lons/lats) and queued for extraction. Returns the region name if
    the request was accepted or already satisfied."""
    with _lock:
        have = covering_region(lat, lon)
        if have:
            return have
        # Already queued or extracting with coverage that includes
        # this point: nothing new to do (unless that region failed, in
        # which case a retry is welcome).
        for r in _load().get("regions", []):
            w, s, e, n = r["bbox"]
            if w <= lon <= e and s <= lat <= n:
                if _status.get(r["region"], {}).get("status") != "failed":
                    return r["region"]
    if bounds is None and name is None:
        name = _canonical_name(lon, lat)
        if name is None:
            return None
    if bounds is not None:
        # Region = padded bounding box of the requesting activity
        # cluster. Small areas extract fast (~tens of MB); later
        # activities inside the padded box reuse it for free.
        w, s, e, n = bounds
        w = max(-179.9, w - BBOX_PAD_DEG)
        s = max(-89.9, s - BBOX_PAD_DEG)
        e = min(179.9, e + BBOX_PAD_DEG)
        n = min(89.9, n + BBOX_PAD_DEG)
        name = f"r{abs(round(w * 2)):03d}{abs(round(s * 2)):03d}-{abs(round(e * 2)):03d}{abs(round(n * 2)):03d}"
    else:
        mapping = dict(CANONICAL_REGIONS)
        if name not in mapping:
            return None
        w, s, e, n = mapping[name]
    # Register + queue.
    with _lock:
        data = _load()
        for r in data["regions"]:
            if r["region"] == name:
                break
        else:
            data.setdefault("regions", []).append(
                {"region": name, "bbox": [w, s, e, n], "generated_at": None})
            _save(data)
        if name not in _queue and (_current or {}).get("region") != name:
            _queue.append(name)
            _status[name] = {"status": "queued"}
    _kick_worker()
    return name


def _kick_worker():
    threading.Thread(target=_worker, daemon=True).start()


def _worker():
    global _current
    with _lock:
        if _current is not None:
            return
        if not _queue:
            return
        name = _queue.pop(0)
        _current = {"region": name, "started": time.time()}
    try:
        while True:
            name = _current["region"]
            data = _load()
            region = next((r for r in data["regions"] if r["region"] == name), None)
            if region is None:
                break
            w, s, e, n = region["bbox"]
            out = region_path(name)
            tmp = out.with_suffix(".pmtiles.part")
            if not shutil.which("pmtiles"):
                _status[name] = {"status": "failed",
                                 "error": "pmtiles CLI not installed (brew install pmtiles)"}
                break
            _status[name] = {"status": "extracting", "started": time.time()}
            bbox = f"{w},{s},{e},{n}"
            try:
                res = subprocess.run(
                    ["pmtiles", "extract", PLANET_URL, str(tmp),
                     f"--bbox={bbox}", f"--maxzoom={MAX_ZOOM}"],
                    capture_output=True, text=True, timeout=60 * 60 * 2)
                if res.returncode != 0 or not tmp.is_file():
                    _status[name] = {"status": "failed",
                                     "error": (res.stderr or res.stdout or "extract failed")[:300]}
                    tmp.unlink(missing_ok=True)
                    break
                tmp.replace(out)
                region["generated_at"] = time.time()
                _save(data)
                _status[name] = {"status": "done",
                                 "finished": time.time(),
                                 "size": out.stat().st_size}
            except Exception as exc:
                tmp.unlink(missing_ok=True)
                _status[name] = {"status": "failed", "error": str(exc)[:300]}
                break
            with _lock:
                if not _queue:
                    _current = None
                    return
                nxt = _queue.pop(0)
                _current = {"region": nxt, "started": time.time()}
    finally:
        with _lock:
            if _current and _current.get("region") == name:
                _current = None


def check_activity_region(conn, activity_id):
    """Called when activity details are served: if the activity's GPS
    lies outside local coverage, queue its region. Best-effort; never
    raises."""
    try:
        row = conn.execute(
            """
            SELECT MIN(position_lat) AS s, MAX(position_lat) AS n,
                   MIN(position_long) AS w, MAX(position_long) AS e
            FROM activity_records
            WHERE activity_id = ? AND position_lat IS NOT NULL
              AND position_long IS NOT NULL
            """,
            (activity_id,),
        ).fetchone()
        if row is None or row["n"] is None or row["e"] is None:
            return None
        lat = (row["s"] + row["n"]) / 2
        lon = (row["w"] + row["e"]) / 2
        if not (math.isfinite(lat) and math.isfinite(lon)):
            return None
        # Antimeridian wraps cannot come from a single activity track
        # in practice; clamp to keep bboxes sane.
        w = max(-179.9, min(179.9, row["w"]))
        e = max(-179.9, min(179.9, row["e"]))
        return ensure_region(lat, lon, bounds=[w, row["s"], e, row["n"]])
    except Exception:
        return None
