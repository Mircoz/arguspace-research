/**
 * Scalable coarse screening for the historical proximity scan.
 *
 * Naive all-pairs comparison is O(n² × days) — with ~2,000 objects over 5
 * years that's billions of comparisons, intractable. Two domain-specific
 * shortcuts make this tractable, at the cost of being deliberately
 * incomplete (documented explicitly — this is a scope limitation, not a bug):
 *
 *  - GEO belt: objects sit at ~fixed longitude. Sorting by longitude and
 *    comparing each object only to its k nearest neighbors catches the
 *    same class of events as the documented cases (Luch/Olymp, Shijian-21
 *    were all neighbor-in-longitude approaches) at O(n log n) per day.
 *  - High-value LEO: the set is small (low hundreds), but orbital planes
 *    vary widely. Pre-filtering to pairs with similar altitude band before
 *    the expensive per-day check cuts the comparison count substantially —
 *    two objects with very different perigee/apogee can never be close.
 *
 * GEO×LEO cross-comparison is skipped entirely (out of scope — different
 * physical regime, would need a different method) and documented as such
 * in README.md.
 */

export interface DailyPosition {
  norad_id: number;
  day: string; // YYYY-MM-DD
  lat: number;
  lng: number;
  altKm: number;
}

export interface OrbitBand {
  norad_id: number;
  perigeeKm: number;
  apogeeKm: number;
}

export interface ScreenedPair {
  norad_id_a: number;
  norad_id_b: number;
  day: string;
  approxDistanceKm: number;
}

const GEO_NEIGHBOR_K = 5;
const GEO_LNG_FLAG_DEG = 2; // flag pairs within this many degrees of longitude
const LEO_ALT_BAND_KM = 200; // only compare LEO pairs with similar altitude band
const LEO_FLAG_DISTANCE_KM = 500; // coarse daily distance worth a fine-grained look

/** Great-circle-ish approx distance in km between two lat/lng points (haversine). */
function approxSurfaceDistanceKm(a: DailyPosition, b: DailyPosition): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** GEO screening: sort by longitude per day, compare each object to its k nearest neighbors only. */
export function screenGeoByDay(positions: DailyPosition[]): ScreenedPair[] {
  const byDay = new Map<string, DailyPosition[]>();
  for (const p of positions) {
    if (!byDay.has(p.day)) byDay.set(p.day, []);
    byDay.get(p.day)!.push(p);
  }

  const flagged: ScreenedPair[] = [];
  for (const [day, dayPositions] of byDay) {
    const sorted = [...dayPositions].sort((a, b) => a.lng - b.lng);
    for (let i = 0; i < sorted.length; i++) {
      for (let k = 1; k <= GEO_NEIGHBOR_K && i + k < sorted.length; k++) {
        const a = sorted[i];
        const b = sorted[i + k];
        const lngDiff = Math.abs(a.lng - b.lng);
        if (lngDiff > GEO_LNG_FLAG_DEG) break; // sorted, so neighbors only get farther
        flagged.push({
          norad_id_a: Math.min(a.norad_id, b.norad_id),
          norad_id_b: Math.max(a.norad_id, b.norad_id),
          day,
          approxDistanceKm: approxSurfaceDistanceKm(a, b),
        });
      }
    }
  }
  return flagged;
}

/** LEO screening: pre-filter to similar-altitude pairs, then check daily distance. */
export function screenLeoByDay(positions: DailyPosition[], bands: OrbitBand[]): ScreenedPair[] {
  const bandByNorad = new Map(bands.map((b) => [b.norad_id, b]));
  const noradIds = [...new Set(positions.map((p) => p.norad_id))];

  const candidatePairs: [number, number][] = [];
  for (let i = 0; i < noradIds.length; i++) {
    for (let j = i + 1; j < noradIds.length; j++) {
      const a = bandByNorad.get(noradIds[i]);
      const b = bandByNorad.get(noradIds[j]);
      if (!a || !b) continue;
      const altDiff = Math.abs((a.perigeeKm + a.apogeeKm) / 2 - (b.perigeeKm + b.apogeeKm) / 2);
      if (altDiff <= LEO_ALT_BAND_KM) candidatePairs.push([noradIds[i], noradIds[j]]);
    }
  }

  const byDay = new Map<string, Map<number, DailyPosition>>();
  for (const p of positions) {
    if (!byDay.has(p.day)) byDay.set(p.day, new Map());
    byDay.get(p.day)!.set(p.norad_id, p);
  }

  const flagged: ScreenedPair[] = [];
  for (const [day, posByNorad] of byDay) {
    for (const [idA, idB] of candidatePairs) {
      const a = posByNorad.get(idA);
      const b = posByNorad.get(idB);
      if (!a || !b) continue;
      const dist = approxSurfaceDistanceKm(a, b);
      if (dist <= LEO_FLAG_DISTANCE_KM) {
        flagged.push({ norad_id_a: idA, norad_id_b: idB, day, approxDistanceKm: dist });
      }
    }
  }
  return flagged;
}
