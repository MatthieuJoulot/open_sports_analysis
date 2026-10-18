#!/usr/bin/env python3
"""Tiny static + API server for the climb analyzer."""
import datetime
import json
import math
import os
import re
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import uuid
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import analyze_climbs
import activity_store
import climb_groups
import config
import osm_lookup
import regions
import basemap_regions
import segment_store
import statistics
import sports as sports_registry
import validated_store
import journal
import climb_database

ROOT = Path(__file__).parent.parent / "web"
CLIMBS_JSON = Path(__file__).parent.parent / "climbs.json"
DB_PATH = config.ACTIVITIES_DB
APP_ROOT = Path(__file__).parent.parent


def _connect_db():
    """Open the activities DB; returns None when the app is not configured."""
    if not DB_PATH or not DB_PATH.exists():
        return None
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        # Local dev server: never let the browser cache modules or data,
        # so code changes show up on a plain reload.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    # Paces upstream tile fetches (Esri rate-limits bursts with useless
    # "map data not available" placeholder tiles).
    TILE_FETCH_SEM = threading.Semaphore(4)

    def do_GET(self):
        import time as _t
        import datetime; print(datetime.datetime.now().strftime('%H:%M:%S.%f')[:-3], 'GET', self.path, 'conn=', self.connection.fileno() if self.connection else None, flush=True)
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        if path.startswith("/tiles/"):
            self._serve_tile(path)
            return
        if path == "/api/map-config":
            self._send_json(json.dumps(get_map_config()))
            return
        if path.startswith("/api/basemap/"):
            self._serve_basemap(path)
            return
        if path == "/api/sync/status":
            self._send_json(json.dumps(get_sync_status()))
            return
        if path == "/api/climbs":
            self._send_json(json.dumps(get_climbs_with_overrides()))
            return
        if path == "/api/profile":
            self._send_json(json.dumps(get_profile()))
            return
        if path == "/api/climb-names":
            self._send_json(json.dumps(get_all_climb_names()))
            return
        if path == "/api/climb-groups":
            self._send_json(json.dumps(get_climb_groups()))
            return
        if path == "/api/stats":
            query = parse_qs(urlparse(self.path).query)
            sport = (query.get("sport", [None])[0] or "").strip() or None
            sport = sports_registry.canon(sport) if sport else None
            from_date = (query.get("from", [None])[0] or "").strip() or None
            to_date = (query.get("to", [None])[0] or "").strip() or None
            self._send_json(json.dumps(statistics.get_stats(
                _connect_db, sport=sport, from_date=from_date, to_date=to_date)))
            return
        if path.startswith("/api/activity/") and path.endswith("/journal"):
            activity_id = path.split("/")[-2]
            self._send_json(json.dumps(journal.get_entry(activity_id)))
            return
        if path.startswith("/api/media/"):
            filename = path.split("/")[-1]
            if not re.fullmatch(r"[A-Za-z0-9_.-]+", filename):
                self.send_error(400, "Bad filename")
                return
            media = journal.media_dir_path()
            f = media / filename if media else None
            if not f or not f.is_file():
                self.send_error(404, "Not found")
                return
            ctype = {
                ".jpeg": "image/jpeg", ".jpg": "image/jpeg",
                ".png": "image/png", ".webp": "image/webp",
                ".heic": "image/heic",
            }.get(f.suffix.lower(), "application/octet-stream")
            data = f.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "max-age=3600")
            self.end_headers()
            self.wfile.write(data)
            return
        if path == "/api/heatmap":
            query = parse_qs(urlparse(self.path).query)
            sport = (query.get("sport", ["cycling"])[0] or "cycling").strip()
            self._send_json(json.dumps(get_heatmap(sport)))
            return
        if path == "/api/climb-db":
            data = climb_database.get_database()
            # Attach climbed status (fast: proximity against climbs.json).
            for c in data["climbs"]:
                c["climbed"] = climb_database.match_climbed(c["lat"], c["lon"])
            self._send_json(json.dumps(data))
            return
        if path.startswith("/api/climb-db/") and path.endswith("/enrich"):
            cid = path.split("/")[-2]
            rich = climb_database.enrich_climb(cid)
            self._send_json(json.dumps(rich if rich is not None else {"error": "no geometry found"}))
            return
        if path == "/api/validated-climbs":
            self._send_json(json.dumps(validated_store.get_validated_list()))
            return
        if path == "/api/history/scan/status":
            self._send_json(json.dumps(get_history_status()))
            return
        if path == "/api/history/download/status":
            self._send_json(json.dumps(get_sync_status()))
            return
        if path == "/api/config":
            self._send_json(json.dumps(get_config_status()))
            return
        if path == "/api/regions":
            # Serve from the cache only (fast); if some activities lack a
            # region, start a background geocode and tell the client.
            missing = len(regions._missing_activity_coords())
            if missing:
                start_region_warm()
            result = get_regions()
            result["warming"] = _region_warm_state["running"] or missing > 0
            result["missing"] = missing
            self._send_json(json.dumps(result))
            return
        if path == "/api/regions/status":
            self._send_json(json.dumps(get_regions_status()))
            return
        if path.startswith("/api/climb/") and path.endswith("/matches"):
            key = path.split("/")[-2]
            self._send_json(json.dumps(get_climb_matches(key)))
            return
        if path.startswith("/api/activity/") and path.endswith("/replace-candidates"):
            activity_id = path.split("/")[-2]
            query = parse_qs(urlparse(self.path).query)
            start = float(query.get("start", [0])[0])
            end = float(query.get("end", [0])[0])
            self._send_json(json.dumps(get_replace_candidates(activity_id, start, end)))
            return
        if path.startswith("/api/activity/") and path.endswith("/track"):
            activity_id = path.split("/")[-2]
            self._send_json(json.dumps(get_track(activity_id)))
            return
        if path.startswith("/api/activity/") and path.endswith("/flyover"):
            activity_id = path.split("/")[-2]
            self._send_json(json.dumps(get_flyover_track(activity_id)))
            return
        if path.startswith("/api/activity/") and path.endswith("/flyover-pois"):
            activity_id = path.split("/")[-2]
            self._send_json(json.dumps(get_flyover_pois(activity_id)))
            return
        if path.startswith("/api/flyover-render/"):
            parts = [p for p in path.split("/") if p]
            if len(parts) == 3 and parts[2] == "new" and self.command == "POST":
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length) or b"{}")
                render_id = flyover_render_start(
                    body.get("activity_id"),
                    seconds=int(body.get("seconds", 60)),
                    width=int(body.get("width", 1280)),
                    height=int(body.get("height", 800)))
                prune_render_jobs(keep_id=render_id)
                self._send_json(json.dumps({"id": render_id}))
                return
            render_id = parts[2]
            action = parts[3] if len(parts) > 3 else ""
            if action == "video":
                job = RENDER_JOBS.get(render_id)
                out = job["dir"] / "out.mp4" if job else None
                if not job or job["status"] != "done" or not out or not out.exists():
                    self._send_json_status(json.dumps({"error": "not ready"}), 404)
                    return
                data = out.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "video/mp4")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Content-Disposition",
                                 f'attachment; filename="flyover_{render_id}.mp4"')
                self.end_headers()
                self.wfile.write(data)
                return
            result = flyover_render_status(render_id)
            self._send_json(json.dumps(result))
            return
        if path.startswith("/api/activity/") and path.endswith("/details"):
            activity_id = path.split("/")[-2]
            conn = _connect_db()
            if conn is not None:
                basemap_regions.check_activity_region(conn, activity_id)
                conn.close()
            self._send_json(json.dumps(get_activity_details(activity_id)))
            return
        if path.startswith("/api/activity/") and path.endswith("/records"):
            activity_id = path.split("/")[-2]
            fields = query.get("fields", [""])[0]
            limit = query.get("limit", [None])[0]
            self._send_json(json.dumps(get_activity_records(activity_id, fields, limit)))
            return
        if path.startswith("/api/activity/") and path.endswith("/download/fit"):
            activity_id = path.split("/")[-3]
            self._serve_fit_file(activity_id)
            return
        if path.startswith("/api/activity/") and path.endswith("/polyline"):
            activity_id = path.split("/")[-2]
            self._send_json(json.dumps(get_polyline(activity_id)))
            return
        if path.startswith("/api/activity/") and path.endswith("/climb-names"):
            activity_id = path.split("/")[-2]
            suggest = query.get("suggest", ["false"])[0].lower() == "true"
            self._send_json(json.dumps(get_climb_names(activity_id, suggest)))
            return
        return super().do_GET()

    def do_DELETE(self):
        self.do_POST()

    def _handle_photo_upload(self, activity_id):
        """Parse a multipart/form-data upload and store one photo."""
        ctype = self.headers.get("Content-Type", "")
        m = re.search(r'boundary=(?:"([^"]+)"|([^;]+))', ctype)
        if "multipart/form-data" not in ctype or not m:
            self.send_error(400, "Expected multipart/form-data")
            return
        boundary = (m.group(1) or m.group(2)).strip().encode("utf-8")
        length = int(self.headers.get("Content-Length", 0))
        if length > journal.MAX_PHOTO_BYTES + 64 * 1024:
            self.send_error(413, "File too large")
            return
        body = self.rfile.read(length)

        # Minimal multipart parse: split on boundary, keep parts with files.
        delim = b"--" + boundary
        parts = body.split(delim)
        for part in parts:
            if b"filename=" not in part[:2048]:
                continue
            header_blob, _, file_data = part.partition(b"\r\n\r\n")
            file_data = file_data.rsplit(b"\r\n", 1)[0]
            fm = re.search(rb'filename="([^"]+)"', header_blob)
            if not fm:
                continue
            original = fm.group(1).decode("utf-8", "replace")
            ext = journal.sanitize_extension(original)
            if ext is None:
                self.send_error(400, f"Unsupported file type: {original}")
                return
            if not file_data:
                self.send_error(400, "Empty file")
                return
            media = journal.media_dir_path()
            if media is None:
                self.send_error(400, "Media directory not configured")
                return
            filename = journal.new_media_filename(activity_id, ext)
            dest = media / filename
            dest.write_bytes(file_data)
            # HEIC can't be rendered by most browsers; convert to JPEG
            # with macOS's built-in sips so every browser shows it.
            if ext == ".heic":
                jpeg_path = dest.with_suffix(".jpeg")
                try:
                    subprocess.run(
                        ["sips", "-s", "format", "jpeg", str(dest),
                         "--out", str(jpeg_path)],
                        check=True, capture_output=True, timeout=30)
                    dest.unlink(missing_ok=True)
                    filename = jpeg_path.name
                except Exception:
                    filename = None   # conversion failed: reject
            if filename is None:
                self.send_error(422, "HEIC conversion failed")
                return
            entry = journal.add_photo(activity_id, filename)
            self._send_json(json.dumps({"photo": entry}))
            return
        self.send_error(400, "No file part found")

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path.startswith("/api/flyover-render/"):
            parts = [p for p in path.split("/") if p]
            if len(parts) == 3 and parts[2] == "new":
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length) or b"{}")
                render_id = flyover_render_start(
                    body.get("activity_id"),
                    seconds=int(body.get("seconds", 60)),
                    width=int(body.get("width", 1280)),
                    height=int(body.get("height", 800)))
                prune_render_jobs(keep_id=render_id)
                self._send_json(json.dumps({"id": render_id}))
                return
            self._send_json_status(json.dumps({"error": "bad render action"}), 404)
            return

        if path.startswith("/api/activity/") and path.endswith("/journal"):
            activity_id = path.split("/")[-2]
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            try:
                payload = json.loads(body.decode("utf-8"))
            except Exception as exc:
                self.send_error(400, f"Invalid JSON: {exc}")
                return
            note = journal.save_note(activity_id, payload.get("note", ""))
            self._send_json(json.dumps({"note": note}))
            return

        if path.startswith("/api/activity/") and path.endswith("/photos"):
            activity_id = path.split("/")[-2]
            self._handle_photo_upload(activity_id)
            return

        if path.startswith("/api/activity/") and "/photos/" in path:
            # DELETE /api/activity/<id>/photos/<filename>
            activity_id = path.split("/")[3]
            filename = path.split("/")[-1]
            if not re.fullmatch(r"[A-Za-z0-9_.-]+", filename):
                self.send_error(400, "Bad filename")
                return
            ok = journal.delete_photo(activity_id, filename)
            if not ok:
                self.send_error(404, "Photo not found")
                return
            self._send_json(json.dumps({"ok": True}))
            return

        if path.startswith("/api/activity/") and path.endswith("/climb-name"):
            activity_id = path.split("/")[-2]
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length).decode("utf-8")
            try:
                payload = json.loads(body)
                name = payload.get("name", "").strip()
                start = payload.get("start_distance_m")
                end = payload.get("end_distance_m")
                if name and start is not None and end is not None:
                    entry = save_climb_name(activity_id, start, end, name)
                    self._send_json(json.dumps(entry))
                    return
                else:
                    self.send_error(400, "Missing name, start_distance_m or end_distance_m")
                    return
            except Exception as exc:
                self.send_error(400, f"Invalid JSON: {exc}")
                return

        if path.startswith("/api/activity/") and path.endswith("/identify-segments"):
            activity_id = path.split("/")[-2]
            candidates = _get_candidate_segments(activity_id)
            self._send_json(json.dumps(candidates))
            return

        if path.startswith("/api/activity/") and path.endswith("/segment"):
            activity_id = path.split("/")[-2]
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length).decode("utf-8")
            try:
                payload = json.loads(body)
            except Exception as exc:
                self.send_error(400, f"Invalid JSON: {exc}")
                return
            start = payload.get("start_distance_m")
            end = payload.get("end_distance_m")
            if start is None or end is None:
                # Replacement by GPS: map the replacement segment's GPS
                # endpoints onto this activity's track.
                start_gps = payload.get("start_lat")
                end_gps = payload.get("end_lat")
                if start_gps is None or end_gps is None:
                    self.send_error(400, "Missing start_distance_m or end_distance_m")
                    return
                points = get_track(activity_id)
                start = _distance_at_gps(points, payload.get("start_lat"), payload.get("start_lon"))
                end = _distance_at_gps(points, payload.get("end_lat"), payload.get("end_lon"))
                if start is None or end is None or end <= start:
                    self.send_error(400, "Replacement endpoints not found on this activity's track")
                    return
            segment = _compute_segment(activity_id, start, end)
            if not segment:
                self.send_error(400, "Could not compute segment for range")
                return
            old_start = payload.get("old_start_distance_m")
            old_end = payload.get("old_end_distance_m")
            if old_start is not None and old_end is not None:
                segment_store.edit_segment(activity_id, old_start, old_end, segment)
            else:
                segment_store.add_segment(activity_id, segment)
            try:
                _recompute_after_segment_change(activity_id)
            except Exception as exc:
                # Do not fail the request if downstream recomputation has issues.
                print("recompute warning:", exc)
            self._send_json(json.dumps(segment))
            return

        if path.startswith("/api/activity/") and path.endswith("/segment/delete"):
            activity_id = path.split("/")[-3]
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length).decode("utf-8")
            try:
                payload = json.loads(body)
            except Exception as exc:
                self.send_error(400, f"Invalid JSON: {exc}")
                return
            start = payload.get("start_distance_m")
            end = payload.get("end_distance_m")
            if start is None or end is None:
                self.send_error(400, "Missing start_distance_m or end_distance_m")
                return
            segment_store.delete_segment(activity_id, start, end)
            try:
                _recompute_after_segment_change(activity_id)
            except Exception as exc:
                print("recompute warning:", exc)
            self._send_json(json.dumps({"deleted": True}))
            return

        if path == "/api/sync/fetch":
            started = start_job("fetch")
            self._send_json(json.dumps(started))
            return

        if path == "/api/sync/analyze":
            started = start_job("analyze")
            self._send_json(json.dumps(started))
            return

        if path.startswith("/api/activity/") and path.endswith("/validate"):
            activity_id = path.split("/")[-2]
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length).decode("utf-8")
            try:
                payload = json.loads(body)
            except Exception as exc:
                self.send_error(400, f"Invalid JSON: {exc}")
                return
            start = payload.get("start_distance_m")
            end = payload.get("end_distance_m")
            name = payload.get("name")
            if start is None or end is None:
                self.send_error(400, "Missing start_distance_m or end_distance_m")
                return
            if not name or not str(name).strip():
                self.send_error(400, "A validated climb requires a name")
                return
            try:
                entry = validate_climb_request(activity_id, start, end, str(name).strip())
            except ValueError as exc:
                self.send_error(400, str(exc))
                return
            self._send_json(json.dumps(entry))
            return

        if path.startswith("/api/validated-climbs/") and path.endswith("/delete"):
            climb_id = path.split("/")[-2]
            removed = validated_store.delete_validated(climb_id)
            if not removed:
                self.send_error(404, "Validated climb not found")
                return
            self._send_json(json.dumps({"deleted": True}))
            return

        if path == "/api/config":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length).decode("utf-8")
            try:
                payload = json.loads(body)
            except Exception as exc:
                self.send_error(400, f"Invalid JSON: {exc}")
                return
            if not isinstance(payload, dict):
                self.send_error(400, "Expected a JSON object")
                return
            try:
                config.save_config(payload)
            except Exception as exc:
                self.send_error(400, f"Could not save config: {exc}")
                return
            basemap_regions.refresh_theme_bounds()
            basemap_regions.invalidate_region_config_cache()
            self._send_json(json.dumps(get_config_status()))
            return

        if path == "/api/history/scan":
            started = scan_history()
            self._send_json(json.dumps(started))
            return

        if path == "/api/history/download":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length).decode("utf-8")
            try:
                payload = json.loads(body)
            except Exception as exc:
                self.send_error(400, f"Invalid JSON: {exc}")
                return
            count = payload.get("count")
            if not count or not str(count).isdigit():
                self.send_error(400, "Missing or invalid count")
                return
            started = start_history_download(int(count))
            self._send_json(json.dumps(started))
            return

        if path == "/api/import-files":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length).decode("utf-8")
            try:
                payload = json.loads(body)
            except Exception as exc:
                self.send_error(400, f"Invalid JSON: {exc}")
                return
            if not isinstance(payload, dict):
                self.send_error(400, "Expected a JSON object")
                return
            result = import_files(payload)
            if "error" in result:
                self.send_error(400, result["error"])
                return
            self._send_json(json.dumps(result))
            return

        if path.startswith("/api/activity/") and path.endswith("/delete"):
            activity_id = path.split("/")[-2]
            if not activity_id.isdigit():
                self.send_error(400, "Invalid activity id")
                return
            summary = activity_store.delete_activity_locally(activity_id)
            activity_store.remove_activity_from_analysis(activity_id)
            try:
                groups, mapping = climb_groups.build_groups(get_climbs_with_overrides(), validated_store.get_validated_list())
                climb_groups.save_groups(groups, mapping)
                summary["groups"] = len(groups)
            except Exception as exc:
                print("group rebuild after delete warning:", exc)
            self._send_json(json.dumps(summary))
            return

        self.send_error(404, "Not found")

    def _send_json(self, body):
        data = body.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_json_status(self, body, status):
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # --- Tile cache proxy ------------------------------------------------
    # The flyover renders (live page and headless video) hammer the Esri
    # imagery + terrarium DEM tile servers. This proxy caches every tile
    # on disk so repeat renders are local-only: dramatically faster
    # headless renders and a much snappier live page.

    def _serve_basemap(self, path):
        """Serve a configured PMTiles basemap with HTTP range support
        (the pmtiles client reads chunks, never the whole file).

        Path forms: /api/basemap/<light|dark> (theme files from config)
        or /api/basemap/region/<name> (auto-extracted regions)."""
        parts = [p for p in path.split("/") if p]
        # parts: api, basemap, [region,] <which>
        if len(parts) == 4 and parts[2] == "region":
            which = parts[3]
            f = basemap_regions.region_path(which)
            if not f.is_file():
                self.send_error(404, f"region basemap not found: {which}")
                return
        else:
            which = parts[-1]           # 'light' or 'dark'
            f = _basemap_file(which)
            if not f:
                self.send_error(404, f"no {which} basemap configured")
                return
        size = f.stat().st_size
        rng = self.headers.get("Range")
        if rng:
            m = re.match(r"bytes=(\d+)-(\d*)", rng)
            if not m:
                self.send_error(416, "bad range")
                return
            start = int(m.group(1))
            end = int(m.group(2)) if m.group(2) else size - 1
            if start >= size:
                self.send_error(416, "range out of bounds")
                return
            end = min(end, size - 1)
            length = end - start + 1
            self.send_response(206)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            length = size
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "max-age=86400")
        self.end_headers()
        with open(f, "rb") as fh:
            if rng:
                fh.seek(int(re.match(r"bytes=(\d+)-", rng).group(1)))
            remaining = length
            while remaining > 0:
                chunk = fh.read(min(65536, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    break
                remaining -= len(chunk)

    def _serve_tile(self, path):
        # /tiles/<source>/<z>/<a>/<b> where a/b order differs by source:
        # esri URLs are built with maplibre's {z}/{y}/{x} and terrarium
        # with {z}/{x}/{y}, so each upstream gets its own parse order.
        parts = [p for p in path.split("/") if p]  # tiles, src, z, a, b
        src, z, a, b = parts[1], parts[2], parts[3], parts[4].split(".")[0]
        if src == "esri":
            y, x = a, b
        else:
            x, y = a, b
        UPSTREAMS = {
            "esri": ("https://server.arcgisonline.com/ArcGIS/rest/services/"
                     "World_Imagery/MapServer/tile/{z}/{y}/{x}", "image/jpeg"),
            "terrarium": ("https://s3.amazonaws.com/elevation-tiles-prod/"
                          "terrarium/{z}/{x}/{y}.png", "image/png"),
        }
        if src not in UPSTREAMS:
            self.send_error(404, "unknown tile source")
            return
        url_tpl, ctype = UPSTREAMS[src]
        url = url_tpl.format(z=z, x=x, y=y)
        cache_dir = APP_ROOT / "cache" / "tiles" / src / z / x
        cache_file = cache_dir / f"{y}"
        if cache_file.exists():
            data = cache_file.read_bytes()
        else:
            data = self._fetch_tile(url, src)
            if data is None:
                self.send_error(502, "tile fetch failed")
                return
            try:
                cache_dir.mkdir(parents=True, exist_ok=True)
                cache_file.write_bytes(data)
            except Exception:
                pass
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "max-age=604800")
        self.end_headers()
        self.wfile.write(data)

    @staticmethod
    def _fetch_tile(url, src):
        """Fetch a tile upstream, retrying once. Returns None on failure.

        Esri answers rate-limit bursts with a solid-colour "map data not
        available" JPEG instead of an error, so single-colour images are
        rejected (and retried) — otherwise the placeholder would get
        cached and poison every future render. A semaphore paces the
        upstream requests so bursts from the map renderer don't trip the
        rate limit in the first place.
        """
        import urllib.request
        with Handler.TILE_FETCH_SEM:
            for attempt in range(3):
                try:
                    req = urllib.request.Request(url, headers={"User-Agent": "open-sports-analysis/1.0"})
                    with urllib.request.urlopen(req, timeout=15) as resp:
                        data = resp.read()
                    if src == "esri":
                        import io
                        try:
                            from PIL import Image
                            im = Image.open(io.BytesIO(data)).convert("RGB")
                            if len(im.getcolors(65536) or []) <= 2:
                                raise ValueError("placeholder tile")
                        except ValueError:
                            time.sleep(2.0 * (attempt + 1))
                            continue
                        except Exception:
                            pass  # PIL missing or weird tile: accept as-is
                    return data
                except Exception:
                    if attempt == 2:
                        return None
                    time.sleep(1.0)
        return None

    def _serve_fit_file(self, activity_id):
        fit_path = config.FIT_DIR / f"{activity_id}_ACTIVITY.fit"
        if not fit_path.exists():
            self.send_error(404, "FIT file not found")
            return
        data = fit_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Disposition", f'attachment; filename="{activity_id}_ACTIVITY.fit"')
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):
        pass  # quiet


HEATMAP_MAX_POINTS = 220      # per-ride decimation cap for the polyline


def get_heatmap(sport="cycling"):
    """Sampled GPS tracks of every activity of one sport, one polyline
    per activity.

    Cached per sport in cache/heatmap-<sport>.json, invalidated when the
    number of activities of that sport changes. The client draws each
    track as a thin low-opacity line; overlapping rides accumulate
    alpha, so frequently-ridden roads glow — a path-following heat
    effect (no blur blobs, no off-road dots).
    """
    conn = _connect_db()
    if conn is None:
        return {"tracks": [], "generated_at": 0}
    sport = sports_registry.canon(sport)
    db_sports = sports_registry.db_names([sport])
    placeholders = ",".join("?" for _ in db_sports)
    cache_path = APP_ROOT / "cache" / f"heatmap-{sport}.json"
    try:
        n_activities = conn.execute(
            f"SELECT COUNT(*) FROM activities WHERE sport IN ({placeholders})",
            tuple(db_sports),
        ).fetchone()[0]
    except Exception:
        n_activities = 0

    try:
        cache = json.loads(cache_path.read_text(encoding="utf-8"))
    except Exception:
        cache = {}
    if cache.get("activities") == n_activities:
        return {
            "tracks": cache.get("tracks", []),
            "generated_at": cache.get("generated_at", 0),
        }

    rows = conn.execute(
        f"""
        SELECT r.activity_id, r.position_lat, r.position_long
        FROM activity_records r
        JOIN activities a ON a.activity_id = r.activity_id
        WHERE r.position_lat IS NOT NULL AND r.position_long IS NOT NULL
          AND a.sport IN ({placeholders})
        ORDER BY r.activity_id, r.record
        """,
        tuple(db_sports),
    ).fetchall()

    tracks = []
    cur_id = None
    pts = []
    for r in rows:
        if r["activity_id"] != cur_id:
            if len(pts) > 1:
                tracks.append(_decimate_track(pts))
            cur_id = r["activity_id"]
            pts = []
        pts.append((r["position_lat"], r["position_long"]))
    if len(pts) > 1:
        tracks.append(_decimate_track(pts))

    payload = {
        "activities": n_activities,
        "generated_at": time.time(),
        "tracks": tracks,
    }
    try:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(
            json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass
    return {"tracks": tracks, "generated_at": payload["generated_at"]}


def _decimate_track(pts):
    """Stride-sample a track down to HEATMAP_MAX_POINTS, keeping both ends."""
    step = max(1, math.ceil(len(pts) / HEATMAP_MAX_POINTS))
    out = [[round(la, 5), round(lo, 5)] for la, lo in pts[::step]]
    last = pts[-1]
    if step > 1 and (len(out) == 0 or out[-1] != [round(last[0], 5), round(last[1], 5)]):
        out.append([round(last[0], 5), round(last[1], 5)])
    return out


FLYOVER_CACHE = APP_ROOT / "cache"
FLYOVER_STEP_M = 15.0          # resample the track at fixed spacing


POI_CACHE = APP_ROOT / "cache"
POI_CORRIDOR_M = 3000.0
RENDER_DIR = Path(tempfile.gettempdir()) / "flyover_renders"
RENDER_FPS = 24


def get_flyover_pois(activity_id):
    """Points of interest along a ride for the 3D flyover.

    Cities/towns/villages near the route (one Overpass query, cached) and
    the ride's validated-climb summits. Returns {cities: [...],
    summits: [{name, lat, lon, alt, startM, endM}]}.
    """
    cache_file = POI_CACHE / f"flyover_pois_{activity_id}.json"
    # Cache is invalidated when climbs or validated names change on disk,
    # so newly validated climbs show up without deleting the cache by hand.
    # Schema version: bump when the payload shape changes (e.g. alt added).
    try:
        data = json.loads(cache_file.read_text(encoding="utf-8"))
        if (data.get("summits") or [{}])[0].get("alt") is not None:
            cache_mtime = cache_file.stat().st_mtime
            source_mtime = max(
                CLIMBS_JSON.stat().st_mtime,
                (APP_ROOT / "validated_climbs.json").stat().st_mtime,
                (APP_ROOT / "climb_segments.json").stat().st_mtime,
            )
            if cache_mtime >= source_mtime:
                return data
    except Exception:
        pass

    conn = _connect_db()
    rows = []
    if conn is not None:
        rows = conn.execute(
            """
            SELECT position_lat, position_long, altitude FROM activity_records
            WHERE activity_id = ? AND position_lat IS NOT NULL
              AND position_long IS NOT NULL
            ORDER BY record
            """,
            (activity_id,),
        ).fetchall()
    if not rows:
        return {"cities": [], "summits": []}

    lats = [r["position_lat"] for r in rows]
    lons = [r["position_long"] for r in rows]
    # Pad the bbox by the corridor margin so places just outside the
    # route's bounding box (e.g. the arrival city) are still found.
    pad = POI_CORRIDOR_M / 111320.0
    lat_min, lat_max = min(lats) - pad, max(lats) + pad
    lon_min, lon_max = min(lons) - pad / math.cos(min(lats) * math.pi / 180), max(lons) + pad / math.cos(min(lats) * math.pi / 180)

    q = f"""
    [out:json][timeout:60];
    node["place"~"^(city|town|village|hamlet)$"]["name"]({lat_min},{lon_min},{lat_max},{lon_max});
    out 300;
    """
    result = osm_lookup._overpass(q)

    def _close_to_track(lat, lon):
        # Corridor check: sample every ~20th GPS point (fast enough).
        for r in rows[::20]:
            dx = (r["position_long"] - lon) * math.cos(lat * math.pi / 180)
            dy = r["position_lat"] - lat
            if math.hypot(dx, dy) * 111320 <= POI_CORRIDOR_M:
                return True
        return False

    cities = []
    for el in result.get("elements", []):
        lat, lon = el.get("lat"), el.get("lon")
        if lat is None or lon is None:
            continue
        if not _close_to_track(lat, lon):
            continue
        name = el.get("tags", {}).get("name")
        place = el.get("tags", {}).get("place")
        if not name:
            continue
        cities.append({"name": name, "kind": place, "lat": lat, "lon": lon})

    # Summits: validated climbs from climbs.json with coordinates.
    summits = []
    try:
        data = json.loads(CLIMBS_JSON.read_text(encoding="utf-8"))
    except Exception:
        data = {"activities": []}
    validated = validated_store.get_validated_list()
    for act in data.get("activities", []):
        if str(act.get("activity_id")) != str(activity_id):
            continue
        for c in segment_store.apply_overrides(activity_id, act.get("climbs", [])):
            name = None
            for v in validated:
                if climb_groups.climbs_match(v, c):
                    name = v["name"]
                    break
            if not name or c.get("end_lat") is None:
                continue
            summits.append({
                "name": name,
                "lat": c["end_lat"], "lon": c["end_lon"],
                "startM": c.get("start_distance_m"),
                "endM": c.get("end_distance_m"),
            })
        break

    # Only the start and end city labels are shown in the flyover: pick
    # the place nearest to the first and to the last GPS point.
    def nearest_place(lat, lon):
        best, best_d = None, None
        for c in cities:
            dx = (c["lon"] - lon) * math.cos(lat * math.pi / 180)
            dy = c["lat"] - lat
            d = math.hypot(dx, dy) * 111320
            if best_d is None or d < best_d:
                best, best_d = c, d
        return best

    start_place = nearest_place(rows[0]["position_lat"], rows[0]["position_long"])
    end_place = nearest_place(rows[-1]["position_lat"], rows[-1]["position_long"])
    kept = []
    seen_names = set()
    for place, where in ((start_place, "start"), (end_place, "end")):
        if place and place["name"] not in seen_names:
            c = dict(place)
            c["where"] = where
            kept.append(c)
            seen_names.add(place["name"])
    # Strip " depuis X" / " from X" / " - X" from summit labels: show the
    # col name only. Altitudes come from the track's altitude channel
    # (max inside the climb, nearest point for cities) — more reliable
    # than terrain queries at render time.
    def alt_near(lat, lon):
        best, best_d = None, None
        for r in rows[::5]:
            if r["altitude"] is None:
                continue
            dx = (r["position_long"] - lon) * math.cos(lat * math.pi / 180)
            dy = r["position_lat"] - lat
            d = math.hypot(dx, dy) * 111320
            if best_d is None or d < best_d:
                best, best_d = r["altitude"], d
        return round(best) if best is not None else None

    for sm in summits:
        sm["name"] = re.split(r"\s+depuis\s+|\s+from\s+|\s+-\s+", sm["name"], maxsplit=1)[0].strip()
        sm["alt"] = alt_near(sm["lat"], sm["lon"])
    for c in kept:
        c["alt"] = alt_near(c["lat"], c["lon"])

    payload = {"cities": kept, "summits": summits}
    try:
        POI_CACHE.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(
            json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass
    return payload


# --- Flyover offline video render -------------------------------------
# Rendering is fully server-side: serve.py spawns headless Chrome
# (playwright, channel="chrome"), which loads web/render/flyover_frame.html,
# walks the camera frame by frame and assembles an MP4 with ffmpeg. The
# user clicks "Download video", gets a job id and polls until done —
# nothing to watch, tab can be closed, video is always smooth 24 fps.

RENDER_JOBS = {}  # render_id -> {dir, status, frame, total, video, error, born}
RENDER_TTL = 3600


def flyover_render_start(activity_id, seconds=60, width=1280, height=800):
    render_id = uuid.uuid4().hex[:12]
    RENDER_JOBS[render_id] = {
        "id": render_id, "activity_id": activity_id,
        "dir": RENDER_DIR / render_id,
        "status": "starting", "frame": 0, "total": 0,
        "video": None, "error": None, "born": time.time(),
    }

    def run():
        job = RENDER_JOBS[render_id]
        try:
            import render_flyover
            video = render_flyover.render_flyover_video(
                render_id, activity_id, port=config.PORT,
                width=width, height=height, seconds=seconds)
            if video is None:
                # Pull the detailed error from the status file.
                try:
                    err = json.loads((job["dir"] / "status.json").read_text()).get("error")
                except Exception:
                    err = "render failed"
                job["status"] = "error"
                job["error"] = err
            else:
                job["status"] = "done"
                job["video"] = f"/api/flyover-render/{render_id}/video"
        except Exception as e:
            job["status"] = "error"
            job["error"] = str(e)

    t = threading.Thread(target=run, daemon=True)
    t.start()
    return render_id


def flyover_render_status(render_id):
    job = RENDER_JOBS.get(render_id)
    if not job:
        return {"error": "unknown render"}
    # Live from the renderer's status file if the job is running.
    try:
        sf = job["dir"] / "status.json"
        if sf.exists():
            s = json.loads(sf.read_text())
            job["status"] = s.get("state", job["status"])
            job["frame"] = s.get("frame", job["frame"])
            job["total"] = s.get("total", job["total"])
            if s.get("error"):
                job["error"] = s["error"]
    except Exception:
        pass
    return {
        "status": job["status"], "frame": job.get("frame", 0),
        "total": job.get("total", 0), "video": job["video"],
        "error": job["error"],
    }


def prune_render_jobs(keep_id=None):
    now = time.time()
    for rid in list(RENDER_JOBS):
        if rid == keep_id or now - RENDER_JOBS[rid]["born"] <= RENDER_TTL:
            continue
        try:
            import shutil
            shutil.rmtree(RENDER_JOBS[rid]["dir"], ignore_errors=True)
        except Exception:
            pass
        del RENDER_JOBS[rid]


def get_flyover_track(activity_id):
    """GPS+altitude track resampled at a fixed ground spacing, cached.

    Fixed spacing (not fixed point count) matters for the flyover: the
    camera advances a constant number of metres per frame, so evenly
    spaced points give it a constant, smooth motion no matter how fast
    the ride was (records are ~1s apart, i.e. 5 m apart at 18 km/h and
    14 m at 50 km/h).
    """
    cache_file = FLYOVER_CACHE / f"flyover_{activity_id}.json"
    try:
        payload = json.loads(cache_file.read_text(encoding="utf-8"))
        if payload.get("step_m") == FLYOVER_STEP_M:
            return payload
    except Exception:
        pass
    conn = _connect_db()
    if conn is None:
        return {"points": []}
    rows = conn.execute(
        """
        SELECT position_lat, position_long, altitude, timestamp
        FROM activity_records
        WHERE activity_id = ? AND position_lat IS NOT NULL
          AND position_long IS NOT NULL
        ORDER BY record
        """,
        (activity_id,),
    ).fetchall()

    # Cumulative distance over raw records.
    R = 6371000.0
    D2R = math.pi / 180.0
    cum = [0.0]
    prev = None
    for r in rows:
        if prev is not None:
            la1, lo1 = prev
            la2, lo2 = r["position_lat"], r["position_long"]
            dy = (la2 - la1) * D2R
            dx = (lo2 - lo1) * D2R * math.cos((la1 + la2) / 2 * D2R)
            cum.append(cum[-1] + math.hypot(dy, dx) * R)
        else:
            cum.append(0.0)
        prev = (r["position_lat"], r["position_long"])
    total = cum[-1]

    # Resample: walk the target distances, interpolating between records.
    n_out = int(total / FLYOVER_STEP_M) + 1
    points = []
    j = 0
    for k in range(n_out):
        target = k * FLYOVER_STEP_M
        while j < len(rows) - 2 and cum[j + 1] < target:
            j += 1
        seg = (cum[j + 1] - cum[j]) or 1.0
        f = max(0.0, min(1.0, (target - cum[j]) / seg))
        r0, r1 = rows[j], rows[j + 1]
        lat = r0["position_lat"] + (r1["position_lat"] - r0["position_lat"]) * f
        lon = r0["position_long"] + (r1["position_long"] - r0["position_long"]) * f
        a0, a1 = r0["altitude"], r1["altitude"]
        alt = None
        if a0 is not None and a1 is not None:
            alt = round(a0 + (a1 - a0) * f, 1)
        elif a0 is not None:
            alt = round(a0, 1)
        t0 = r0["timestamp"]
        ts = t0 if f < 0.5 else (r1["timestamp"] or t0)
        points.append([lat, lon, alt, ts])
    if len(points) < 2:
        r = rows[-1]
        alt = r["altitude"]
        points.append([r["position_lat"], r["position_long"],
                       round(alt, 1) if alt is not None else None,
                       r["timestamp"]])
    payload = {"step_m": FLYOVER_STEP_M, "points": points}
    try:
        FLYOVER_CACHE.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(
            json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass
        pass
    return payload


def get_track(activity_id):
    conn = _connect_db()
    if conn is None:
        return []
    cur = conn.cursor()
    rows = cur.execute(
        """
        SELECT distance, altitude, position_lat, position_long
        FROM activity_records
        WHERE activity_id = ? AND altitude IS NOT NULL AND distance IS NOT NULL
        ORDER BY record
        """,
        (activity_id,),
    ).fetchall()

    points = [
        {
            "d": round(r["distance"] * 1000, 1),
            "a": round(r["altitude"], 1),
            "lat": r["position_lat"],
            "lon": r["position_long"],
        }
        for r in rows
    ]

    return points


def _compute_segment(activity_id, start_m, end_m):
    points = get_track(activity_id)
    return analyze_climbs.compute_segment(points, start_m, end_m)


def _distance_at_gps(points, lat, lon):
    """Distance along the activity track at the given GPS position.

    Returns the track distance (m) of the record nearest to (lat, lon),
    or None when the track has no GPS data.
    """
    if lat is None or lon is None:
        return None
    best = None
    best_d2 = None
    for p in points:
        if p.get("lat") is None or p.get("lon") is None:
            continue
        d2 = (p["lat"] - lat) ** 2 + (p["lon"] - lon) ** 2
        if best_d2 is None or d2 < best_d2:
            best_d2 = d2
            best = p
    return best["d"] if best is not None else None


def get_replace_candidates(activity_id, start_m, end_m):
    """Segments that could replace the climb at (start_m, end_m) in this
    activity: every other segment in the dataset, scored by geometric
    similarity (GPS start/end proximity). Suggestions first, then the
    full list with name / validated status for sorting and filtering in
    the picker UI.
    """
    target = None
    for c in _find_activity_climbs(str(activity_id)):
        if abs(c["start_distance_m"] - start_m) < 1 and abs(c["end_distance_m"] - end_m) < 1:
            target = c
            break
    if target is None:
        return {"ok": False, "error": "climb not found"}

    def similarity(c):
        # 0 = same start/end points, grows with GPS distance (meters).
        try:
            sd = climb_groups._haversine(c["start_lat"], c["start_lon"],
                                         target["start_lat"], target["start_lon"])
            ed = climb_groups._haversine(c["end_lat"], c["end_lon"],
                                         target["end_lat"], target["end_lon"])
        except (KeyError, TypeError):
            return None
        if sd is None or ed is None:
            return None
        return sd + ed

    def overlap_penalty(c):
        # Segments from the same activity that overlap the target are
        # usually siblings/parts of the target itself, not replacements.
        if str(c.get("activity_id")) != str(activity_id):
            return 0
        cstart, cend = c["start_distance_m"], c["end_distance_m"]
        if cstart >= end_m or cend <= start_m:
            return 0
        return 1

    candidates = []
    for act in get_climbs_with_overrides().get("activities", []):
        for c in act.get("climbs", []):
            if (str(act["activity_id"]) == str(activity_id)
                    and abs(c["start_distance_m"] - start_m) < 1
                    and abs(c["end_distance_m"] - end_m) < 1):
                continue
            sim = similarity(c)
            if sim is None:
                continue
            candidates.append({
                "activity_id": act["activity_id"],
                "activity_name": act.get("name"),
                "start_time": act.get("start_time"),
                "start_distance_m": c["start_distance_m"],
                "end_distance_m": c["end_distance_m"],
                "start_lat": c["start_lat"],
                "start_lon": c["start_lon"],
                "end_lat": c["end_lat"],
                "end_lon": c["end_lon"],
                "length_m": c["length_m"],
                "elevation_gain_m": c["elevation_gain_m"],
                "avg_grade_percent": c["avg_grade_percent"],
                "name": c.get("validated_name") or c.get("name"),
                "validated": bool(c.get("validated_climb_id")),
                "similarity_m": round(sim, 1),
                "_overlap": overlap_penalty(c),
            })

    # Also the validated climbs themselves (they may have no matching
    # occurrence in any ride's detected list, e.g. different end points).
    seen_geo = {(round(c["start_lat"], 4), round(c["start_lon"], 4),
                round(c["end_lat"], 4), round(c["end_lon"], 4)) for c in candidates}
    for v in validated_store.get_validated_list():
        geo = (round(v["start_lat"], 4), round(v["start_lon"], 4),
               round(v["end_lat"], 4), round(v["end_lon"], 4))
        if geo in seen_geo:
            continue
        sim = similarity(v)
        if sim is None:
            continue
        candidates.append({
            "activity_id": v.get("source_activity_id"),
            "activity_name": None,
            "start_time": None,
            "start_distance_m": v.get("source_start_distance_m"),
            "end_distance_m": v.get("source_end_distance_m"),
            "start_lat": v["start_lat"],
            "start_lon": v["start_lon"],
            "end_lat": v["end_lat"],
            "end_lon": v["end_lon"],
            "length_m": v["length_m"],
            "elevation_gain_m": v["elevation_gain_m"],
            "avg_grade_percent": v.get("avg_grade_percent"),
            "name": v["name"],
            "validated": True,
            "similarity_m": round(sim, 1),
            "_overlap": 0,
        })

    # Suggestions: most similar, non-overlapping, closest in length.
    def suggestion_score(c):
        length_ratio = 0
        if c["length_m"] and target["length_m"]:
            length_ratio = abs(c["length_m"] - target["length_m"]) / max(c["length_m"], target["length_m"])
        return c["similarity_m"] + length_ratio * 1000 + c["_overlap"] * 100000
    suggestions = sorted(candidates, key=suggestion_score)[:3]
    for c in candidates:
        c.pop("_overlap", None)
    suggestions = [c["name"] or f"Climb in {c['activity_name'] or c['activity_id']}" for c in suggestions]

    return {"ok": True, "target": {
                "start_distance_m": start_m,
                "end_distance_m": end_m,
                "length_m": target["length_m"],
                "elevation_gain_m": target["elevation_gain_m"]},
            "candidates": candidates,
            "suggestions": suggestions}


def _recompute_after_segment_change(activity_id):
    # Name refresh can hit Overpass (slow, occasionally hangs on big bboxes).
    # Never block the segment save on it: run it in the background.
    threading.Thread(
        target=_refresh_names_and_groups,
        args=(activity_id,),
        daemon=True,
    ).start()
    # Group rebuild is local and fast; keep it synchronous so the UI that
    # reloads right after saving sees consistent groups.
    try:
        groups, mapping = climb_groups.build_groups(get_climbs_with_overrides(), validated_store.get_validated_list())
        climb_groups.save_groups(groups, mapping)
    except Exception as exc:
        print("group rebuild warning:", exc)


def _refresh_names_and_groups(activity_id):
    try:
        climbs = _find_activity_climbs(activity_id)
        osm_lookup.refresh_names_for_activity(activity_id, climbs)
    except Exception as exc:
        print("name refresh warning:", exc)


def _get_candidate_segments(activity_id):
    points = get_track(activity_id)
    if len(points) < 2:
        return []
    existing = _find_activity_climbs(activity_id)
    candidates = analyze_climbs.propose_candidates(
        [p["d"] for p in points],
        [p["a"] for p in points],
        [p["lat"] for p in points],
        [p["lon"] for p in points],
        existing_segments=existing,
    )
    return candidates


def get_polyline(activity_id, max_points=60):
    conn = _connect_db()
    if conn is None:
        return []
    cur = conn.cursor()
    rows = cur.execute(
        """
        SELECT position_lat, position_long
        FROM activity_records
        WHERE activity_id = ? AND position_lat IS NOT NULL AND position_long IS NOT NULL
        ORDER BY record
        """,
        (activity_id,),
    ).fetchall()

    if len(rows) == 0:
        return []

    if len(rows) <= max_points:
        return [[r["position_lat"], r["position_long"]] for r in rows]

    step = len(rows) / max_points
    result = []
    for i in range(max_points):
        idx = min(int(i * step), len(rows) - 1)
        result.append([rows[idx]["position_lat"], rows[idx]["position_long"]])
    if result[-1] != [rows[-1]["position_lat"], rows[-1]["position_long"]]:
        result.append([rows[-1]["position_lat"], rows[-1]["position_long"]])
    return result


RECORD_FIELDS = {
    "distance",
    "altitude",
    "hr",
    "speed",
    "cadence",
    "timestamp",
    "position_lat",
    "position_long",
}


def _parse_time_to_seconds(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        parts = value.split(":")
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    return None


def _row_to_dict(row):
    return {key: row[key] for key in row.keys()}


def _convert_time_fields(row):
    for key in row.keys():
        if key in ("start_time", "stop_time"):
            continue
        if key.endswith("_time") and row[key] is not None:
            row[key] = _parse_time_to_seconds(row[key])
    return row


PERSONAL_INFO_JSON = config.PERSONAL_INFO_JSON


def _load_climbs():
    try:
        return json.loads(CLIMBS_JSON.read_text(encoding="utf-8"))
    except Exception:
        return {"activities": []}


def get_climbs_with_overrides():
    data = _load_climbs()
    validated = validated_store.get_validated_list()
    activity_ids = [act.get("activity_id") for act in data.get("activities", [])]
    journal_badges = journal.feed_badges(activity_ids)
    for act in data.get("activities", []):
        activity_id = act.get("activity_id")
        auto_climbs = act.get("climbs", [])
        climbs = segment_store.apply_overrides(activity_id, auto_climbs)
        _apply_validated_names(climbs, validated)
        act["climbs"] = climbs
        act["journal"] = journal_badges.get(str(activity_id))
    return data


def _apply_validated_names(climbs, validated):
    """Attach validated names to matching climbs in place.

    A validated name wins over any OSM/manual name: validation is the
    strongest signal. The climb key records which validated entry matched.
    """
    if not validated:
        return
    for c in climbs:
        for v in validated:
            if climb_groups.climbs_match(v, c):
                c["validated_name"] = v["name"]
                c["validated_climb_id"] = v["climb_id"]
                break


def _find_activity_climbs(activity_id):
    data = _load_climbs()
    for act in data.get("activities", []):
        if act.get("activity_id") == activity_id:
            auto_climbs = act.get("climbs", [])
            return segment_store.apply_overrides(activity_id, auto_climbs)
    return []


def get_climb_names(activity_id, suggest=True):
    climbs = _find_activity_climbs(activity_id)
    return osm_lookup.get_names(activity_id, climbs, suggest=suggest)


def get_all_climb_names():
    return osm_lookup.load_climb_names()


def get_climb_groups():
    return climb_groups.ensure_groups()


def get_regions():
    return regions.get_climb_regions()


_region_warm_state = {"running": False, "last_done": None}


def _region_warm_worker():
    """Geocode any missing activity regions in the background so the API
    never blocks on Nominatim (1 req/s makes a cold cache take minutes)."""
    try:
        regions.warm_activity_regions()
        _region_warm_state["last_done"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    except Exception as exc:
        print("region warm warning:", exc)
    finally:
        _region_warm_state["running"] = False


def start_region_warm():
    if _region_warm_state["running"]:
        return
    _region_warm_state["running"] = True
    threading.Thread(target=_region_warm_worker, daemon=True).start()


def get_regions_status():
    return dict(_region_warm_state)


def _parse_timestamp(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        try:
            return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except Exception:
            return None
    return None


# --- Stop trimming --------------------------------------------------------
# A pause inside a climb should not count as climb time: elapsed time and
# VAM are computed over MOVING time only. Shared implementation in
# moving.py (thresholds: speed < 3 km/h for more than 10 s).
import moving as moving_time


# --- Estimated power (no power meter) -----------------------------------
# Physics model, same idea as Climbfinder: per 100 m section,
#   W = (Crr·m·g·cosθ + m·g·sinθ + ½·ρ·CdA·v²) · v / (1 − drivetrain loss)
# with θ from the section gradient, v the section speed. Climbs only;
# flat/downhill sections are skipped (no braking/wind model).
_RIDER_WEIGHT_CACHE = {"value": None, "ts": 0}

def _rider_weight_kg():
    """Total mass (rider + bike) from Garmin personal info, cached 1 h."""
    import time as _time
    now = _time.time()
    if _RIDER_WEIGHT_CACHE["value"] is not None and now - _RIDER_WEIGHT_CACHE["ts"] < 3600:
        return _RIDER_WEIGHT_CACHE["value"]
    w = None
    try:
        bio = _load_personal_info().get("biometricProfile", {}) or {}
        grams = bio.get("weight")
        if grams:
            w = round(grams / 1000, 1)   # rider only
    except Exception:
        w = None
    if not w:
        _RIDER_WEIGHT_CACHE["value"] = None
        return None
    total = w + 10.0                     # + bike+kits ~10 kg
    _RIDER_WEIGHT_CACHE.update({"value": total, "ts": now})
    return total


def _estimate_climb_power(rows, activity_id, cur):
    """Average watts for the uphill sections of a climb attempt.

    Rows: distance (km), altitude (m), speed (m/s), timestamp.
    Falls back to distance/timestamp when speed is missing.
    Returns (avg_watts, w_per_kg) or (None, None).
    """
    mass = _rider_weight_kg()
    if not mass:
        return None, None
    pts = []
    for r in rows:
        d_km, alt, v, ts = r["distance"], r["altitude"], r["speed"], r["timestamp"]
        if d_km is None or alt is None or ts is None:
            continue
        # activity_records.speed is km/h; physics needs m/s.
        v_ms = (v / 3.6) if (v is not None and v > 1.8) else None
        pts.append({"d": d_km * 1000, "a": alt, "v": v_ms,
                    "t": _parse_timestamp(ts)})
    if len(pts) < 4:
        return None, None
    pts.sort(key=lambda p: p["d"])

    # Records are ~2-5 m apart: too fine for per-section work. Walk the
    # profile at ~100 m steps, using the first record past each station.
    stations = []
    d0, d1 = pts[0]["d"], pts[-1]["d"]
    n_sections = int((d1 - d0) // 100)
    j = 0
    for s in range(n_sections + 1):
        target = d0 + s * 100
        while j + 1 < len(pts) and pts[j + 1]["d"] <= target:
            j += 1
        stations.append(pts[min(j, len(pts) - 1)])
    pts = stations

    CRR = 0.005          # rolling resistance, asphalt
    CDA = 0.32           # aero drag m², hoods position
    DRIVETRAIN = 0.975   # 2.5% drivetrain loss
    G = 9.81

    watts_sum = 0.0
    secs_sum = 0.0
    for i in range(1, len(pts)):
        a, b = pts[i - 1], pts[i]
        dL = b["d"] - a["d"]
        if dL < 20 or dL > 400:         # gappy data
            continue
        dt = b["t"] - a["t"] if a["t"] is not None and b["t"] is not None else None
        if not dt or dt <= 0:
            continue
        v = b["v"] or (dL / dt)
        if v < 0.5:
            continue
        grade = (b["a"] - a["a"]) / dL
        if grade < 0.015:                # skip flat/descent: no brake model
            continue
        theta = math.atan(grade)
        # Air density from mid-section altitude (barometric, ~1.225 at sea level).
        alt_mid = (a["a"] + b["a"]) / 2
        rho = 1.225 * math.exp(-alt_mid / 8500)
        f_grav = mass * G * math.sin(theta)
        f_roll = mass * G * CRR * math.cos(theta)
        f_air = 0.5 * rho * CDA * v * v
        w = (f_grav + f_roll + f_air) * v / DRIVETRAIN
        if 0 < w < 2000:
            watts_sum += w * dt
            secs_sum += dt
    if secs_sum < 30:                     # less than half a minute of climbing
        return None, None
    avg_w = watts_sum / secs_sum
    rider_kg = mass - 10.0
    return round(avg_w, 1), round(avg_w / rider_kg, 2) if rider_kg else None


def _compute_climb_performance(activity_id, start_m, end_m):
    conn = _connect_db()
    if conn is None:
        return {}
    cur = conn.cursor()

    # Detect available columns to avoid errors on older DB schemas.
    available_cols = {c["name"] for c in cur.execute("SELECT name FROM pragma_table_info('activity_records')")}
    has_power = "power" in available_cols

    power_sql = ", power" if has_power else ""
    rows = cur.execute(
        f"""
        SELECT distance, altitude, hr, speed, timestamp{power_sql}
        FROM activity_records
        WHERE activity_id = ? AND distance >= ? AND distance <= ?
        ORDER BY record
        """,
        (activity_id, start_m / 1000.0, end_m / 1000.0),
    ).fetchall()
    if not rows:
        return {}

    # Moving time: raw elapsed minus stops (speed < 3 km/h for more
    # than 10 s). Pauses inside the climb should not inflate the time,
    # VAM or the PR ranking.
    moving, raw_elapsed = moving_time.moving_seconds(rows)
    elapsed = moving

    hr_values = [r["hr"] for r in rows if r["hr"] is not None]
    speed_values = [r["speed"] for r in rows if r["speed"] is not None]
    altitudes = [r["altitude"] for r in rows if r["altitude"] is not None]
    power_values = [r["power"] for r in rows if has_power and r["power"] is not None]

    gain = (max(altitudes) - min(altitudes)) if altitudes else None
    vam = (gain / elapsed * 3600) if gain and elapsed and elapsed > 0 else None

    # Estimated power when no power meter data exists.
    est_w = est_wkg = None
    if not power_values:
        try:
            est_w, est_wkg = _estimate_climb_power(rows, activity_id, cur)
        except Exception:
            est_w = est_wkg = None

    return {
        "elapsed_time_s": elapsed,
        "raw_elapsed_time_s": raw_elapsed,
        "avg_hr": sum(hr_values) / len(hr_values) if hr_values else None,
        "avg_speed": sum(speed_values) / len(speed_values) if speed_values else None,
        "avg_power": sum(power_values) / len(power_values) if power_values else None,
        "est_power_w": est_w,
        "est_power_w_per_kg": est_wkg,
        "gain_m": gain,
        "vam": vam,
    }


# Memoized climb-matches: get_climb_matches recomputes per-member
# performance (records + estimated power) for every member of the group,
# which is expensive on big groups (hundreds of attempts, several seconds).
# Results are cached per key and invalidated whenever climbs.json, the
# segment edits or the validated registry change (mtime-based).
_MATCHES_CACHE = {"mtime": {}, "data": {}}


def _matches_cache_stamp():
    stamps = {}
    for p in (CLIMBS_JSON,
              Path(__file__).parent.parent / "climb_segments.json",
              Path(__file__).parent.parent / "validated_climbs.json"):
        try:
            stamps[p.name] = p.stat().st_mtime
        except OSError:
            stamps[p.name] = None
    return stamps


def get_climb_matches(key):
    stamps = _matches_cache_stamp()
    entry = _MATCHES_CACHE["data"].get(key)
    if entry is not None and _MATCHES_CACHE["mtime"].get(key) == stamps:
        return entry

    groups = climb_groups.ensure_groups()
    group_id = groups.get("key_to_group", {}).get(key)
    member_keys = []
    if group_id:
        member_keys = groups.get("groups", {}).get(group_id, [])
    if not member_keys:
        member_keys = [key]

    # Build reverse lookup from climbs.json by key, applying user edits so
    # modified/added segments are what the climb page actually shows.
    data = _load_climbs()
    validated = validated_store.get_validated_list()
    climbs_by_key = {}
    for act in data.get("activities", []):
        activity_id = act.get("activity_id")
        for c in segment_store.apply_overrides(activity_id, act.get("climbs", [])):
            k = f"{activity_id}:{int(round(c['start_distance_m']))}:{int(round(c['end_distance_m']))}"
            climbs_by_key[k] = {**c, "activity_id": activity_id, "activity_name": act.get("name"), "start_time": act.get("start_time")}

    results = []
    for k in member_keys:
        c = climbs_by_key.get(k)
        if not c:
            continue
        _apply_validated_names([c], validated)
        perf = _compute_climb_performance(c["activity_id"], c["start_distance_m"], c["end_distance_m"])
        results.append({**c, **perf})
    results.sort(key=lambda x: x.get("start_time") or "")
    payload = {"group_id": group_id, "count": len(results), "members": results}
    _MATCHES_CACHE["data"][key] = payload
    _MATCHES_CACHE["mtime"][key] = stamps
    return payload


def validate_climb_request(activity_id, start_distance_m, end_distance_m, name):
    """Validate the climb at the given range as a canonical named segment."""
    climbs = _find_activity_climbs(activity_id)
    climb = validated_store.find_climb(climbs, start_distance_m, end_distance_m)
    if climb is None:
        raise ValueError("No climb found at the given range in this activity")
    return validated_store.validate_climb(activity_id, climb, name)


def save_climb_name(activity_id, start_distance_m, end_distance_m, name):
    climbs = _find_activity_climbs(activity_id)
    climb = osm_lookup.find_climb(activity_id, climbs, start_distance_m, end_distance_m)
    if climb is None:
        # Build a minimal climb stub from stored record coordinates if missing.
        climb = {"start_distance_m": start_distance_m, "end_distance_m": end_distance_m}
    return osm_lookup.set_manual_name(activity_id, climb, name)


def _load_personal_info():
    try:
        return json.loads(PERSONAL_INFO_JSON.read_text(encoding="utf-8"))
    except Exception:
        return {}


def get_activity_details(activity_id):
    conn = _connect_db()
    if conn is None:
        return {"error": "not configured: set the activities database in Parameters"}
    cur = conn.cursor()

    activity = cur.execute(
        "SELECT * FROM activities WHERE activity_id = ?", (activity_id,)
    ).fetchone()
    if activity is None:
        return {"error": "activity not found"}

    activity = _row_to_dict(activity)
    activity = _convert_time_fields(activity)

    hr_stats = cur.execute(
        "SELECT AVG(hr) AS avg_hr, MAX(hr) AS max_hr FROM activity_records WHERE activity_id = ?",
        (activity_id,),
    ).fetchone()

    sensor_cols = cur.execute(
        "SELECT name FROM pragma_table_info('activity_records')"
    ).fetchall()
    sensor_cols = {c["name"] for c in sensor_cols}

    counts = cur.execute(
        """
        SELECT
            SUM(CASE WHEN hr IS NOT NULL THEN 1 ELSE 0 END) AS hr_n,
            SUM(CASE WHEN cadence IS NOT NULL THEN 1 ELSE 0 END) AS cadence_n,
            SUM(CASE WHEN speed IS NOT NULL THEN 1 ELSE 0 END) AS speed_n,
            SUM(CASE WHEN altitude IS NOT NULL THEN 1 ELSE 0 END) AS altitude_n,
            SUM(CASE WHEN temperature IS NOT NULL THEN 1 ELSE 0 END) AS temperature_n
        FROM activity_records
        WHERE activity_id = ?
        """,
        (activity_id,),
    ).fetchone()

    power_n = 0
    if "power" in sensor_cols:
        power_n = cur.execute(
            "SELECT COUNT(*) FROM activity_records WHERE activity_id = ? AND power IS NOT NULL",
            (activity_id,),
        ).fetchone()[0]

    laps = []
    try:
        lap_rows = cur.execute(
            "SELECT * FROM activity_laps WHERE activity_id = ? ORDER BY lap",
            (activity_id,),
        ).fetchall()
        for lap in lap_rows:
            lap_dict = _convert_time_fields(_row_to_dict(lap))
            laps.append(lap_dict)
    except Exception:
        pass

    climbs_data = _load_climbs()
    activity_climbs = []
    for act in climbs_data.get("activities", []):
        if act.get("activity_id") == activity_id:
            activity_climbs = act.get("climbs", [])
            break
    activity_climbs = segment_store.apply_overrides(activity_id, activity_climbs)
    _apply_validated_names(activity_climbs, validated_store.get_validated_list())

    devices = []
    try:
        garmin_db = config.GARMIN_DB
        gconn = sqlite3.connect(str(garmin_db))
        gconn.row_factory = sqlite3.Row
        gcur = gconn.cursor()
        serial_rows = cur.execute(
            "SELECT device_serial_number FROM activities_devices WHERE activity_id = ?",
            (activity_id,),
        ).fetchall()
        serials = [r["device_serial_number"] for r in serial_rows]
        if serials:
            placeholders = ",".join("?" * len(serials))
            for drow in gcur.execute(
                f"""SELECT serial_number, device_type, manufacturer, product FROM devices
                    WHERE serial_number IN ({placeholders})
                    AND device_type NOT IN ('invalid', 'accelerometer', 'barometer', 'bluetooth_low_energy_chipset', 'sensor_hub', 'wrist_heart_rate', 'gps')""",
                serials,
            ):
                devices.append({
                    "serial": drow["serial_number"],
                    "type": drow["device_type"],
                    "manufacturer": drow["manufacturer"],
                    "product": drow["product"],
                })
    except Exception:
        pass

    return {
        "activity": activity,
        "avg_hr": round(hr_stats["avg_hr"], 1) if hr_stats["avg_hr"] else None,
        "max_hr": hr_stats["max_hr"],
        "sensors": {
            "has_hr": bool(counts["hr_n"]),
            "has_power": bool(power_n),
            "has_cadence": bool(counts["cadence_n"]),
            "has_speed": bool(counts["speed_n"]),
            "has_altitude": bool(counts["altitude_n"]),
            "has_temperature": bool(counts["temperature_n"]),
        },
        "laps": laps,
        "climbs": activity_climbs,
        "devices": devices,
    }


def get_activity_records(activity_id, fields_param, limit_param):
    conn = _connect_db()
    if conn is None:
        return []
    cur = conn.cursor()

    available = {
        c["name"] for c in cur.execute("SELECT name FROM pragma_table_info('activity_records')").fetchall()
    }

    default_fields = ["distance", "altitude", "hr", "speed", "timestamp"]
    if fields_param:
        requested = [f.strip() for f in fields_param.split(",")]
    else:
        requested = default_fields

    fields = [f for f in requested if f in available]
    if not fields:
        fields = default_fields

    # Always include record for ordering; it is not returned.
    select_sql = ", ".join(fields)
    rows = cur.execute(
        f"SELECT {select_sql} FROM activity_records WHERE activity_id = ? ORDER BY record",
        (activity_id,),
    ).fetchall()

    limit = None
    if limit_param is not None:
        try:
            limit = int(limit_param)
        except ValueError:
            limit = None

    n = len(rows)
    if limit and n > limit:
        step = math.ceil(n / limit)
        selected = [rows[i] for i in range(0, n, step)]
        if selected[-1] is not rows[-1]:
            selected.append(rows[-1])
    else:
        selected = rows

    result = []
    for r in selected:
        point = {}
        for f in fields:
            v = r[f]
            if f == "distance" and v is not None:
                v = round(v * 1000, 2)
            point[f] = v
        result.append(point)

    return result


IMPORTABLE_FILES = {
    "cols": ("cols.json", list),
    "segments": ("climb_segments.json", dict),
    "names": ("climb_names.json", dict),
    "validated": ("validated_climbs.json", dict),
}


def import_files(payload):
    """Copy user data files (cols, segments, names, validated climbs) from
    another install into this one. Only files given in the payload are
    imported; existing files here are overwritten after validation."""
    results = {}
    imported_any = False
    for key, (filename, expected_type) in IMPORTABLE_FILES.items():
        source = payload.get(key)
        if not source:
            continue
        src_path = Path(source).expanduser()
        if not src_path.is_absolute():
            return {"error": f"{key}: path must be absolute"}
        if not src_path.exists():
            return {"error": f"{key}: file not found ({src_path})"}
        try:
            data = json.loads(src_path.read_text(encoding="utf-8"))
        except Exception as exc:
            return {"error": f"{key}: not valid JSON ({exc})"}
        if expected_type is list and not isinstance(data, list):
            return {"error": f"{key}: expected a JSON list"}
        if expected_type is dict and not isinstance(data, dict):
            return {"error": f"{key}: expected a JSON object"}
        dest = Path(__file__).parent.parent / filename
        dest.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        if isinstance(data, list):
            count = len(data)
        elif isinstance(data, dict):
            count = len(data)
        else:
            count = 0
        results[key] = {"from": str(src_path), "entries": count}
        imported_any = True
    if not imported_any:
        return {"error": "no files given"}
    # Segment overrides and validated names apply immediately; groups may
    # change, rebuild them so the UI is consistent.
    try:
        groups, mapping = climb_groups.build_groups(get_climbs_with_overrides(), validated_store.get_validated_list())
        climb_groups.save_groups(groups, mapping)
        results["groups"] = len(groups)
    except Exception as exc:
        results["groups_warning"] = str(exc)
    return {"imported": results}


def _basemap_file(which):
    """Configured PMTiles basemap file for 'light'/'dark', or None."""
    key = f"basemap_{which}"
    raw = config.current_config().get(key) or ""
    if not raw:
        return None
    p = Path(raw).expanduser()
    if not p.is_absolute():
        p = (APP_ROOT / p).resolve()
    return p if p.is_file() else None


def _queue_missing_basemap_regions():
    """After a fetch/analyze, find activities whose GPS falls outside
    every local basemap region and queue those areas for extraction.
    Clustered by 4-degree cells so one region covers many activities."""
    conn = _connect_db()
    if conn is None:
        return
    try:
        rows = conn.execute(
            """
            SELECT a.activity_id,
                   MIN(r.position_lat) AS s, MAX(r.position_lat) AS n,
                   MIN(r.position_long) AS w, MAX(r.position_long) AS e
            FROM activities a
            JOIN activity_records r ON r.activity_id = a.activity_id
            WHERE r.position_lat IS NOT NULL AND r.position_long IS NOT NULL
            GROUP BY a.activity_id
            """
        ).fetchall()
    except Exception:
        conn.close()
        return
    conn.close()
    # Group activities by coarse cell, then check each cell's centroid.
    cells = {}
    for row in rows:
        if row["n"] is None or row["e"] is None:
            continue
        key = (math.floor(row["n"] / 4), math.floor(row["e"] / 4))
        b = cells.setdefault(key, [180, 90, -180, -90])
        b[0] = min(b[0], row["w"]); b[1] = min(b[1], row["s"])
        b[2] = max(b[2], row["e"]); b[3] = max(b[3], row["n"])
    for b in cells.values():
        w, s, e, n = b
        lat, lon = (s + n) / 2, (w + e) / 2
        if basemap_regions.covering_region(lat, lon) is None:
            basemap_regions.ensure_region(lat, lon, bounds=[w, s, e, n])


def get_map_config():
    """Tells the frontend whether local PMTiles basemaps are available:
    per-theme files and auto-extracted regions (with their bboxes)."""
    data = basemap_regions.list_regions()
    return {
        "local": {
            "light": bool(_basemap_file("light")),
            "dark": bool(_basemap_file("dark")),
        },
        "regions": data["regions"],
    }


def get_config_status():
    """Current config for the parameters page, plus data availability checks."""
    values = config.current_config()
    return {
        "values": values,
        "config_file": str(config.CONFIG_JSON),
        "config_file_exists": config.CONFIG_JSON.exists(),
        "paths": {
            "activities_db_exists": bool(config.ACTIVITIES_DB and config.ACTIVITIES_DB.exists()),
            "garmin_db_exists": bool(config.GARMIN_DB and config.GARMIN_DB.exists()),
            "fit_dir_exists": bool(config.FIT_DIR and config.FIT_DIR.is_dir()),
            "garmindb_cli_exists": bool(config.GARMINDB_CLI and config.GARMINDB_CLI.exists()),
        },
    }


def get_profile():
    conn = _connect_db()
    if conn is None:
        return {
            "athlete": {}, "devices": [],
            "all_time": {"rides": 0, "distance_km": 0, "moving_time_s": 0, "ascent_m": 0, "descent_m": 0, "climbs": 0},
            "ytd": {"rides": 0, "distance_km": 0, "ascent_m": 0},
            "last_30_days": {"rides": 0, "distance_km": 0, "ascent_m": 0},
            "per_sport": {},
        }
    cur = conn.cursor()

    enabled = sports_registry.enabled_sports({"sports": config.SPORTS})
    db_sports = sports_registry.db_names(enabled)
    placeholders = ",".join("?" for _ in db_sports)

    # All-time totals over every enabled sport.
    row = cur.execute(
        f"""
        SELECT COUNT(*) AS n,
               SUM(distance) AS distance_km,
               SUM(ascent) AS ascent_m,
               SUM(descent) AS descent_m
        FROM activities
        WHERE sport IN ({placeholders})
        """,
        tuple(db_sports),
    ).fetchone()

    moving_seconds = 0
    for r in cur.execute(
        f"SELECT moving_time FROM activities WHERE sport IN ({placeholders}) AND moving_time IS NOT NULL",
        tuple(db_sports),
    ):
        moving_seconds += _parse_time_to_seconds(r["moving_time"]) or 0

    # Climbs total (climbs.json only ever contains cycling).
    climbs_data = _load_climbs()
    climb_count = sum(a.get("climb_count", 0) for a in climbs_data.get("activities", []))

    # Per-sport all-time breakdown for the sidebar (aliases grouped).
    per_sport = {}
    for srow in cur.execute(
        f"""
        SELECT sport,
               COUNT(*) AS n,
               SUM(distance) AS distance_km,
               SUM(ascent) AS ascent_m
        FROM activities
        WHERE sport IN ({placeholders})
        GROUP BY sport
        """,
        tuple(db_sports),
    ):
        key = sports_registry.canon(srow["sport"])
        agg = per_sport.setdefault(key, {"activities": 0, "distance_km": 0, "ascent_m": 0})
        agg["activities"] += srow["n"] or 0
        agg["distance_km"] += srow["distance_km"] or 0
        agg["ascent_m"] += srow["ascent_m"] or 0
    for agg in per_sport.values():
        agg["distance_km"] = round(agg["distance_km"], 1)
        agg["ascent_m"] = round(agg["ascent_m"])

    # Time-window summaries
    now = datetime.datetime.now(datetime.timezone.utc)
    ytd_start = datetime.datetime(now.year, 1, 1, tzinfo=datetime.timezone.utc)
    last30_start = now - datetime.timedelta(days=30)

    def window_stats(start):
        r = cur.execute(
            f"""
            SELECT COUNT(*) AS n,
                   SUM(distance) AS distance_km,
                   SUM(ascent) AS ascent_m
            FROM activities
            WHERE sport IN ({placeholders}) AND start_time >= ?
            """,
            (*db_sports, start.strftime("%Y-%m-%d %H:%M:%S")),
        ).fetchone()
        return {
            "rides": r["n"] or 0,
            "distance_km": round(r["distance_km"], 1) if r["distance_km"] else 0,
            "ascent_m": round(r["ascent_m"]) if r["ascent_m"] else 0,
        }

    personal = _load_personal_info()
    user_info = personal.get("userInfo", {})
    bio = personal.get("biometricProfile", {})

    devices = []
    try:
        garmin_db = config.GARMIN_DB
        gconn = sqlite3.connect(str(garmin_db))
        gconn.row_factory = sqlite3.Row
        gcur = gconn.cursor()
        for drow in gcur.execute(
            """
            SELECT d.serial_number, d.device_type, d.manufacturer, d.product,
                   di.software_version
            FROM devices d
            LEFT JOIN device_info di ON d.serial_number = di.serial_number
            WHERE d.device_type NOT IN ('invalid', 'accelerometer', 'barometer', 'bluetooth_low_energy_chipset', 'sensor_hub', 'wrist_heart_rate')
            GROUP BY d.serial_number
            ORDER BY di.timestamp DESC
            LIMIT 10
            """
        ):
            devices.append({
                "serial": drow["serial_number"],
                "type": drow["device_type"],
                "manufacturer": drow["manufacturer"],
                "product": drow["product"],
                "software_version": drow["software_version"],
            })
    except Exception:
        pass

    return {
        "athlete": {
            "email": user_info.get("email"),
            "age": user_info.get("age"),
            "gender": user_info.get("genderType"),
            "country": user_info.get("countryCode"),
            "weight_kg": round(bio.get("weight", 0) / 1000, 1) if bio.get("weight") else None,
            "height_cm": round(bio.get("height", 0), 1) if bio.get("height") else None,
            "vo2max": bio.get("vo2Max"),
            "lactate_threshold_hr": bio.get("lactateThresholdHeartRate"),
        },
        "devices": devices,
        "all_time": {
            "rides": row["n"] or 0,
            "distance_km": round(row["distance_km"], 1) if row["distance_km"] else 0,
            "moving_time_s": moving_seconds,
            "ascent_m": round(row["ascent_m"]) if row["ascent_m"] else 0,
            "descent_m": round(row["descent_m"]) if row["descent_m"] else 0,
            "climbs": climb_count,
        },
        "ytd": window_stats(ytd_start),
        "last_30_days": window_stats(last30_start),
        "per_sport": per_sport,
    }


# Cap on a garmindb_cli fetch job. A full --latest pass normally takes a
# few minutes; a stuck Garmin Connect session hangs forever, so the job
# is killed after this many seconds.
FETCH_TIMEOUT_S = 45 * 60

_sync_state = {
    "running": False,
    "started_at": None,
    "finished_at": None,
    "phase": None,
    "last_log": [],
    "result": None,
    "error": None,
}
_sync_lock = threading.Lock()


def _sync_log(phase, message):
    with _sync_lock:
        _sync_state["phase"] = phase
        _sync_state["last_log"] = (_sync_state["last_log"] + [message])[-30:]


def get_sync_status():
    with _sync_lock:
        return dict(_sync_state)


def start_job(kind):
    """Start a background job: "fetch" (GarminDB download+import) or
    "analyze" (climb analysis + grouping). Only one job runs at a time."""
    if kind not in ("fetch", "analyze"):
        return {"ok": False, "error": f"unknown job kind: {kind}"}
    with _sync_lock:
        if _sync_state["running"]:
            return {"ok": True, "already_running": True, "status": dict(_sync_state)}
        _sync_state.update({
            "running": True,
            "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "finished_at": None,
            "phase": "starting",
            "kind": kind,
            "last_log": [],
            "result": None,
            "error": None,
        })

    thread = threading.Thread(target=_run_job_worker, args=(kind,), daemon=True)
    thread.start()
    return {"ok": True, "started": True}


def _run_job_worker(kind):
    try:
        if kind == "fetch":
            result = run_fetch()
        else:
            result = run_analyze()
        with _sync_lock:
            _sync_state["running"] = False
            _sync_state["finished_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            _sync_state["result"] = result
            _sync_state["phase"] = "done" if result.get("ok") else "failed"
    except Exception as exc:
        traceback.print_exc()
        with _sync_lock:
            _sync_state["running"] = False
            _sync_state["finished_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            _sync_state["error"] = str(exc)
            _sync_state["phase"] = "failed"


# --- History scan / bulk download -------------------------------------------

_HISTORY_STATE = {
    "scanning": False,
    "scan_result": None,
    "scan_error": None,
    "scan_finished_at": None,
}


def _garmindb_interpreter():
    """Python interpreter of the configured GarminDB venv, or None."""
    if not config.GARMINDB_CLI or not config.GARMINDB_CLI.exists():
        return None
    venv_python = config.GARMINDB_CLI.parent / "python"
    return str(venv_python) if venv_python.exists() else sys.executable


def _run_scan_once():
    """Run the scan script, return its result dict or None on failure.
    Sets _HISTORY_STATE['scan_error'] on failure."""
    interp = _garmindb_interpreter()
    if not interp:
        _HISTORY_STATE["scan_error"] = "garmindb_cli not configured: cannot scan"
        return None
    try:
        proc = subprocess.run(
            [interp, str(Path(__file__).parent / "scan_garmin_history.py")],
            capture_output=True, text=True, timeout=120,
        )
        if proc.returncode != 0:
            _HISTORY_STATE["scan_error"] = (proc.stderr or proc.stdout or "scan failed")[-500:]
            return None
        data = json.loads(proc.stdout.strip().split("\n")[-1])
        if "error" in data:
            _HISTORY_STATE["scan_error"] = data["error"]
            return None
        return data
    except Exception as exc:
        _HISTORY_STATE["scan_error"] = str(exc)
        return None


def scan_history():
    """List the Garmin Connect activity history (no download) in background."""
    if _HISTORY_STATE["scanning"]:
        return {"ok": True, "already_running": True}
    if not _garmindb_interpreter():
        return {"ok": False, "error": "garmindb_cli not configured: cannot scan"}
    _HISTORY_STATE.update({"scanning": True, "scan_error": None})

    def worker():
        data = _run_scan_once()
        _HISTORY_STATE["scanning"] = False
        if data is not None:
            _HISTORY_STATE["scan_result"] = data
        _HISTORY_STATE["scan_finished_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()

    threading.Thread(target=worker, daemon=True).start()
    return {"ok": True, "started": True}


def get_history_status():
    return dict(_HISTORY_STATE)


GARMINDB_CONFIG_FILE = Path.home() / ".GarminDb" / "GarminConnectConfig.json"


def start_history_download(count):
    """Download `count` more activities in the background.

    GarminDB walks the most recent `download_all_activities` activities and
    skips files already on disk. Setting the cap to (local + count) makes it
    walk only `count` activities beyond what is already downloaded. Requires
    a scan first (provides the local count); falls back to counting files in
    the GarminDB activities directory.
    """
    with _sync_lock:
        if _sync_state["running"]:
            return {"ok": True, "already_running": True, "status": dict(_sync_state)}
        if not config.GARMINDB_CLI or not config.GARMINDB_CLI.exists():
            return {"ok": False, "error": "garmindb_cli not configured"}

        try:
            gc_config = json.loads(GARMINDB_CONFIG_FILE.read_text(encoding="utf-8"))
        except Exception as exc:
            return {"ok": False, "error": f"could not read {GARMINDB_CONFIG_FILE}: {exc}"}

        scan = _HISTORY_STATE.get("scan_result") or {}
        local = scan.get("local")
        if not local:
            # No fresh scan result: run one synchronously (it takes seconds).
            _HISTORY_STATE["scanning"] = True
            result = _run_scan_once()
            _HISTORY_STATE["scanning"] = False
            _HISTORY_STATE["scan_finished_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            if result is None:
                return {"ok": False, "error": _HISTORY_STATE.get("scan_error") or "scan failed"}
            _HISTORY_STATE["scan_result"] = result
            local = result.get("local", 0)

        gc_config.setdefault("data", {})["download_all_activities"] = int(local) + int(count)
        GARMINDB_CONFIG_FILE.write_text(
            json.dumps(gc_config, indent=4, ensure_ascii=False), encoding="utf-8"
        )

        _sync_state.update({
            "running": True,
            "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "finished_at": None,
            "phase": "history-download",
            "kind": "history-download",
            "last_log": [f"bulk download: +{count} activities"],
            "result": None,
            "error": None,
        })

    def worker():
        try:
            # Chunked bulk download: full GarminDB walk (no --latest), then
            # the analysis pass over whatever is new in the DB. The walk is
            # longer than a --latest fetch, so it gets a bigger timeout.
            result = run_fetch(latest=False, timeout_s=FETCH_TIMEOUT_S * 4)
            if result.get("ok"):
                result = run_analyze()
            with _sync_lock:
                _sync_state["running"] = False
                _sync_state["finished_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
                _sync_state["result"] = result
                _sync_state["phase"] = "done" if result.get("ok") else "failed"
        except Exception as exc:
            traceback.print_exc()
            with _sync_lock:
                _sync_state["running"] = False
                _sync_state["finished_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
                _sync_state["error"] = str(exc)
                _sync_state["phase"] = "failed"

    threading.Thread(target=worker, daemon=True).start()
    return {"ok": True, "started": True}


def run_fetch(latest=None, timeout_s=None):
    """Download + import new activities via GarminDB (no analysis).

    Runs in a background thread started by start_job("fetch"). GarminDB keeps
    its own download state, but re-checks every activity against Garmin
    Connect, so a full pass takes minutes even when nothing is new.

    Hard timeout (default FETCH_TIMEOUT_S): garmindb_cli can hang forever
    on a stuck Garmin Connect session — its output pipe never closes and
    the reading loop never sees EOF. On timeout the whole child process
    group is killed so the job state can't wedge in "running" forever.
    """
    if latest is None:
        latest = config.SYNC_LATEST
    if timeout_s is None:
        timeout_s = FETCH_TIMEOUT_S
    if not config.GARMINDB_CLI or not Path(config.GARMINDB_CLI).exists():
        return {"ok": False, "error": f"garmindb_cli not found: {config.GARMINDB_CLI or '(not configured)'}"}

    cli = Path(config.GARMINDB_CLI)
    # Use the interpreter next to the CLI when it lives inside a venv.
    venv_python = cli.parent / "python"
    interpreter = str(venv_python) if venv_python.exists() else sys.executable
    cmd = [interpreter, str(cli), "--download", "--import", "--activities", "--analyze"]
    if latest:
        # Only fetch the most recent activities (config:
        # download_latest_activities in GarminConnectConfig.json) instead
        # of walking the entire history every fetch.
        cmd.append("--latest")
    _sync_log("garmindb", "running " + " ".join(cmd))
    print("fetch: running", " ".join(cmd), flush=True)
    # New session: garmindb_cli spawns worker processes that inherit the
    # stdout pipe; killing only the direct child leaves them (and the
    # open pipe) behind, which is what wedged the job before.
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, start_new_session=True)
    timed_out = False

    def _reader():
        nonlocal tail
        for line in proc.stdout:
            print("fetch: garmindb:", line.rstrip(), flush=True)
            tail.append(line)
            tail = tail[-20:]

    tail = []
    reader = threading.Thread(target=_reader, daemon=True)
    reader.start()
    try:
        proc.wait(timeout=timeout_s)
    except subprocess.TimeoutExpired:
        timed_out = True
        print(f"fetch: garmindb timed out after {timeout_s}s, killing process group", flush=True)
        _sync_log("failed", f"garmindb download timed out after {int(timeout_s / 60)} min")
        try:
            os.killpg(proc.pid, signal.SIGKILL)   # kill the whole session
        except (ProcessLookupError, PermissionError):
            proc.kill()
        proc.wait(timeout=10)
    reader.join(timeout=10)
    if timed_out:
        detail = "".join(tail)[-2000:]
        return {"ok": False, "error": "garmindb download timed out", "detail": detail}
    if proc.returncode != 0:
        detail = "".join(tail)[-2000:]
        print("fetch: garmindb failed:", detail, flush=True)
        _sync_log("failed", "garmindb download/import failed")
        return {"ok": False, "error": "garmindb download/import failed", "detail": detail}
    _sync_log("done", "garmindb download/import done")
    print("fetch: garmindb done", flush=True)
    return {"ok": True}


def run_analyze():
    """Incremental climb analysis + group rebuild over existing DB contents.

    Runs in a background thread started by start_job("analyze"). Only rides
    not analyzed before are processed; works without garmindb_cli.
    """
    if not config.ACTIVITIES_DB or not config.ACTIVITIES_DB.exists():
        return {"ok": False, "error": f"activities_db not found: {config.ACTIVITIES_DB}"}

    # Snapshot previously analyzed activities before re-analyzing.
    prev_data = _load_climbs()
    old_ids = {a.get("activity_id") for a in prev_data.get("activities", [])}
    old_climb_count = sum(a.get("climb_count", 0) for a in prev_data.get("activities", []))

    # Incremental climb analysis then rebuild groups.
    _sync_log("analysis", "detecting climbs")
    analyze_climbs.main()
    _sync_log("groups", "grouping climbs")
    groups, mapping = climb_groups.build_groups(get_climbs_with_overrides(), validated_store.get_validated_list())
    climb_groups.save_groups(groups, mapping)

    new_data = _load_climbs()
    new_ids = {a.get("activity_id") for a in new_data.get("activities", [])}
    new_climb_count = sum(a.get("climb_count", 0) for a in new_data.get("activities", []))

    # Queue basemap extracts for any area not covered locally yet.
    _queue_missing_basemap_regions()

    _sync_log("done", "analysis complete")
    return {
        "ok": True,
        "new_activities": len(new_ids - old_ids),
        "total_activities": new_data.get("activity_count", len(new_ids)),
        "new_climbs": new_climb_count - old_climb_count,
        "total_climbs": new_climb_count,
        "groups": len(groups),
    }


if __name__ == "__main__":
    basemap_regions.refresh_theme_bounds()
    port = config.PORT
    print(f"Serving at http://127.0.0.1:{port}/")
    from http.server import ThreadingHTTPServer
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
