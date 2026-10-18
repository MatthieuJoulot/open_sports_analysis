// Shared sport metadata for the frontend, mirroring backend/sports.py.

export const SPORTS = {
  cycling: { label: 'Cycling', icon: '🚴', pace: false, climbs: true },
  running: { label: 'Running', icon: '🏃', pace: true, climbs: false },
  hiking: { label: 'Hiking', icon: '🥾', pace: true, climbs: false },
  rowing: { label: 'Rowing', icon: '🚣', pace: false, climbs: false },
};

// Garmin DB names grouped under one app-level sport.
export const ALIASES = { walking: 'hiking' };

export function canon(sport) {
  return ALIASES[sport] || sport;
}

export function sportMeta(sport) {
  const s = SPORTS[canon(sport)];
  if (s) return s;
  return {
    label: (canon(sport) || 'Activity').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    icon: '🏅', pace: false, climbs: false,
  };
}

export function usesPace(sport) {
  return !!sportMeta(sport).pace;
}

export function hasClimbs(sport) {
  return !!sportMeta(sport).climbs;
}
