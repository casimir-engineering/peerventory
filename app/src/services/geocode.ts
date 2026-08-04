/**
 * Place search (Photon) + a local memory of recently used places for
 * offline reverse-lookup by proximity.
 */

export interface PlaceHit {
  label: string;
  lat: number;
  lon: number;
}

const PLACES_KEY = 'places:v1';
const PLACES_CAP = 200;
const SEARCH_TIMEOUT_MS = 5000;

/** Photon search. Returns [] on any failure (offline, timeout, bad payload). */
export async function searchPlaces(query: string): Promise<PlaceHit[]> {
  const q = query.trim();
  if (!q) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
  try {
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lang=en`;
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return [];
    const body = (await res.json()) as { features?: unknown[] };
    if (!Array.isArray(body.features)) return [];
    const hits: PlaceHit[] = [];
    const seen = new Set<string>();
    for (const f of body.features) {
      const feature = f as {
        properties?: { name?: unknown; city?: unknown; state?: unknown; country?: unknown };
        geometry?: { coordinates?: unknown };
      };
      const p = feature.properties ?? {};
      const coords = feature.geometry?.coordinates;
      if (!Array.isArray(coords) || typeof coords[0] !== 'number' || typeof coords[1] !== 'number') continue;
      const parts = [p.name, typeof p.city === 'string' && p.city ? p.city : p.state, p.country]
        .filter((s): s is string => typeof s === 'string' && s.length > 0);
      if (parts.length === 0) continue;
      const label = parts.join(', ');
      if (seen.has(label)) continue;
      seen.add(label);
      hits.push({ label, lon: coords[0], lat: coords[1] });
    }
    return hits;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

interface SavedPlace {
  label: string;
  lat: number;
  lon: number;
}

function readPlaces(): SavedPlace[] {
  try {
    const raw = localStorage.getItem(PLACES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is SavedPlace =>
        typeof p === 'object' && p !== null &&
        typeof (p as SavedPlace).label === 'string' &&
        typeof (p as SavedPlace).lat === 'number' &&
        typeof (p as SavedPlace).lon === 'number',
    );
  } catch {
    return [];
  }
}

function writePlaces(places: SavedPlace[]): void {
  try {
    localStorage.setItem(PLACES_KEY, JSON.stringify(places.slice(0, PLACES_CAP)));
  } catch {
    // storage full/unavailable: place memory is best-effort
  }
}

/** Save a used place (most recent first). Re-saving the same label updates its coords. */
export function rememberPlace(label: string, lat: number, lon: number): void {
  const trimmedLabel = label.trim();
  if (!trimmedLabel) return;
  const rest = readPlaces().filter((p) => p.label !== trimmedLabel);
  writePlaces([{ label: trimmedLabel, lat, lon }, ...rest]);
}

const EARTH_RADIUS_M = 6371000;

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

/** Label of the closest remembered place within maxMeters, else null. */
export function nearestPlaceLabel(lat: number, lon: number, maxMeters = 250): string | null {
  let best: string | null = null;
  let bestDist = maxMeters;
  for (const p of readPlaces()) {
    const d = haversineMeters(lat, lon, p.lat, p.lon);
    if (d <= bestDist) {
      bestDist = d;
      best = p.label;
    }
  }
  return best;
}
