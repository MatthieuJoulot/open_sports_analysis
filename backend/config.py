"""Central configuration: config.json + environment overrides.

Most users only need `health_data_dir` (the GarminDB data directory,
e.g. ~/HealthData): the database and file paths are derived from it.
Each derived path can still be set explicitly to override the default
layout.
"""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
CONFIG_JSON = ROOT / "config.json"

DEFAULTS = {
    "health_data_dir": "",
    "activities_db": "",
    "garmin_db": "",
    "fit_dir": "",
    "personal_info_json": "",
    "garmindb_cli": "",
    "media_dir": "",
    "port": 8080,
    "sync_latest": True,
    "sports": ["cycling", "running", "hiking", "rowing"],
}

# Preferred env var prefix is OPEN_SPORTS_ANALYSIS_*; the legacy
# CLIMB_ANALYZER_* names still work (checked second) so existing setups
# keep running after the project rename.
ENV_VARS = {
    "health_data_dir": ["OPEN_SPORTS_ANALYSIS_HEALTH_DATA_DIR", "CLIMB_ANALYZER_HEALTH_DATA_DIR"],
    "activities_db": ["OPEN_SPORTS_ANALYSIS_ACTIVITIES_DB", "CLIMB_ANALYZER_ACTIVITIES_DB"],
    "garmin_db": ["OPEN_SPORTS_ANALYSIS_GARMIN_DB", "CLIMB_ANALYZER_GARMIN_DB"],
    "fit_dir": ["OPEN_SPORTS_ANALYSIS_FIT_DIR", "CLIMB_ANALYZER_FIT_DIR"],
    "personal_info_json": ["OPEN_SPORTS_ANALYSIS_PERSONAL_INFO", "CLIMB_ANALYZER_PERSONAL_INFO"],
    "garmindb_cli": ["OPEN_SPORTS_ANALYSIS_GARMINDB_CLI", "CLIMB_ANALYZER_GARMINDB_CLI"],
    "media_dir": ["OPEN_SPORTS_ANALYSIS_MEDIA_DIR", "CLIMB_ANALYZER_MEDIA_DIR"],
    "port": ["OPEN_SPORTS_ANALYSIS_PORT", "CLIMB_ANALYZER_PORT"],
}


def _expand(path):
    return Path(path).expanduser().resolve() if path else None


def _load():
    values = dict(DEFAULTS)
    if CONFIG_JSON.exists():
        try:
            values.update(json.loads(CONFIG_JSON.read_text(encoding="utf-8")))
        except Exception as exc:
            print(f"Warning: could not parse {CONFIG_JSON}: {exc}")
    for key, envs in ENV_VARS.items():
        for env in (envs if isinstance(envs, list) else [envs]):
            if os.environ.get(env):
                values[key] = os.environ[env]
                break
    return values


def _resolve(cfg):
    """Return effective (resolved) paths, deriving from health_data_dir."""
    base = _expand(cfg["health_data_dir"])
    derived = {
        "activities_db": base / "DBs" / "garmin_activities.db" if base else None,
        "garmin_db": base / "DBs" / "garmin.db" if base else None,
        "fit_dir": base / "FitFiles" / "Activities" if base else None,
        "personal_info_json": base / "FitFiles" / "personal-information.json" if base else None,
    }
    # Explicit settings override the derived defaults.
    for key in derived:
        if cfg.get(key):
            derived[key] = _expand(cfg[key])
    return derived


_cfg = _load()
_paths = _resolve(_cfg)


def _resolve_garmindb_cli(raw):
    """Explicit path from config, else auto-detect garmindb_cli.py in the
    same environment as the running interpreter (conda env bin dir)."""
    if raw:
        return Path(raw).expanduser()
    candidate = Path(sys.executable).parent / "garmindb_cli.py"
    return candidate if candidate.exists() else None


ACTIVITIES_DB = _paths["activities_db"]
GARMIN_DB = _paths["garmin_db"]
FIT_DIR = _paths["fit_dir"]
PERSONAL_INFO_JSON = _paths["personal_info_json"]
GARMINDB_CLI = _resolve_garmindb_cli(_cfg["garmindb_cli"])
PORT = int(_cfg["port"])
SYNC_LATEST = bool(_cfg["sync_latest"])
SPORTS = [s for s in (list(_cfg["sports"]) if _cfg["sports"] else []) if isinstance(s, str)]


def current_config():
    """Config values as shown in the UI (raw strings, unexpanded)."""
    return {key: _cfg[key] for key in DEFAULTS}


def save_config(values):
    """Write a subset of config keys to config.json and reload."""
    allowed = set(DEFAULTS) - {"port"}  # port changes need a server restart
    updates = {k: v for k, v in values.items() if k in allowed}
    existing = {}
    if CONFIG_JSON.exists():
        try:
            existing = json.loads(CONFIG_JSON.read_text(encoding="utf-8"))
        except Exception:
            existing = {}
    existing.update(updates)
    CONFIG_JSON.write_text(json.dumps(existing, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    global _cfg, _paths, ACTIVITIES_DB, GARMIN_DB, FIT_DIR, PERSONAL_INFO_JSON, GARMINDB_CLI, SYNC_LATEST, SPORTS
    _cfg = _load()
    _paths = _resolve(_cfg)
    ACTIVITIES_DB = _paths["activities_db"]
    GARMIN_DB = _paths["garmin_db"]
    FIT_DIR = _paths["fit_dir"]
    PERSONAL_INFO_JSON = _paths["personal_info_json"]
    GARMINDB_CLI = _resolve_garmindb_cli(_cfg["garmindb_cli"])
    SYNC_LATEST = bool(_cfg["sync_latest"])
    SPORTS = [s for s in (list(_cfg["sports"]) if _cfg["sports"] else []) if isinstance(s, str)]
