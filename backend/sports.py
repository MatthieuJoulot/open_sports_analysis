"""Sport registry: the sports Open Sports handles, with per-sport metadata.

Climb/segment detection stays cycling-only (Strava categories, VAM, W/kg
make no sense for foot travel). Other sports are listed in the feed and
fully visible in activity details, statistics and training, with zero
climb data.

A `sports` list in config.json selects which sports are enabled; the
default is all three main ones.

Garmin records both `hiking` and `walking` activities; they are grouped
as one sport ("Hiking") via ALIASES, so the DB never needs rewriting.
"""

# Display metadata per sport. `pace` decides whether speed is shown as
# km/h or min/km. `efforts` are the best-effort distances (metres).
SPORTS = {
    "cycling": {
        "label": "Cycling",
        "icon": "🚴",
        "pace": False,
        "efforts": [8047, 10000, 16093, 20000, 30000, 40000, 50000, 80000, 80467, 90000, 100000],
        "climbs": True,
    },
    "running": {
        "label": "Running",
        "icon": "🏃",
        "pace": True,
        "efforts": [1000, 1609, 5000, 10000, 21097, 42195],
        "climbs": False,
    },
    "hiking": {
        "label": "Hiking",
        "icon": "🥾",
        "pace": True,
        "efforts": [],
        "climbs": False,
    },
    "rowing": {
        "label": "Rowing",
        "icon": "🚣",
        "pace": False,
        "efforts": [500, 1000, 2000, 5000, 10000],
        "climbs": False,
    },
}

# Garmin DB sport names grouped under a single app-level sport.
ALIASES = {"walking": "hiking"}

DEFAULT_ENABLED = ["cycling", "running", "hiking", "rowing"]


def canon(sport):
    """Map a Garmin sport name to its canonical app-level sport."""
    return ALIASES.get(sport, sport)


def enabled_sports(cfg):
    """Enabled sport names from config, falling back to the defaults."""
    raw = (cfg.get("sports") if isinstance(cfg, dict) else None) or DEFAULT_ENABLED
    names = [canon(s) for s in raw if canon(s) in SPORTS]
    # Deduplicate, keep order.
    return list(dict.fromkeys(names)) or list(DEFAULT_ENABLED)


def db_names(sports):
    """Expand canonical sport names to every Garmin DB name they cover
    (aliases included), for SQL `sport IN (...)` filters."""
    out = []
    for s in sports:
        out.append(s)
        out.extend(alias for alias, target in ALIASES.items() if target == s)
    return out


def sport_meta(sport):
    """Metadata for a sport name, defaulting to a generic entry."""
    sport = canon(sport)
    return SPORTS.get(sport, {"label": (sport or "Activity").replace("_", " ").title(),
                              "icon": "🏅", "pace": False, "efforts": [], "climbs": False})


def has_climbs(sport):
    return bool(sport_meta(sport).get("climbs"))


def uses_pace(sport):
    return bool(sport_meta(sport).get("pace"))


def sport_placeholder(sport):
    return {"cycling": "cyclisme"}.get(canon(sport))
