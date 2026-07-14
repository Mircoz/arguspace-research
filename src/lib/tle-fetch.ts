/**
 * TLE ingestion from CelesTrak (https://celestrak.org).
 * No authentication required — good for an MVP. Space-Track.org has a larger,
 * more authoritative catalog but requires a free account; swap the base URL
 * and add basic-auth login there once this pipeline is validated.
 */

const CELESTRAK_BASE = "https://celestrak.org/NORAD/elements/gp.php";

export interface ParsedTle {
  noradId: number;
  name: string;
  line1: string;
  line2: string;
  epoch: Date;
  meanMotion: number; // revolutions/day
  eccentricity: number;
  inclinationDeg: number;
}

/** Parses a TLE epoch (YYDDD.DDDDDDDD, columns 19-32 of line 1) into a Date. */
function parseTleEpoch(line1: string): Date {
  const yy = parseInt(line1.substring(18, 20), 10);
  const dayOfYear = parseFloat(line1.substring(20, 32));
  const year = yy < 57 ? 2000 + yy : 1900 + yy; // TLE epoch convention (57 = Sputnik era cutoff)

  const jan1 = new Date(Date.UTC(year, 0, 1));
  const ms = (dayOfYear - 1) * 86400 * 1000;
  return new Date(jan1.getTime() + ms);
}

function parseTleTriplet(nameLine: string, line1: string, line2: string): ParsedTle {
  const noradId = parseInt(line1.substring(2, 7), 10);
  const inclinationDeg = parseFloat(line2.substring(8, 16));
  const eccStr = line2.substring(26, 33); // implied leading "0."
  const eccentricity = parseFloat(`0.${eccStr}`);
  const meanMotion = parseFloat(line2.substring(52, 63));

  return {
    noradId,
    name: nameLine.trim(),
    line1: line1.trim(),
    line2: line2.trim(),
    epoch: parseTleEpoch(line1),
    meanMotion,
    eccentricity,
    inclinationDeg,
  };
}

/** Splits a CelesTrak 3-line-per-object TLE text blob into parsed records. */
export function parseTleText(raw: string): ParsedTle[] {
  const lines = raw.split("\n").map((l) => l.trimEnd()).filter((l) => l.length > 0);
  const records: ParsedTle[] = [];

  for (let i = 0; i + 2 < lines.length + 1; i += 3) {
    const nameLine = lines[i];
    const line1 = lines[i + 1];
    const line2 = lines[i + 2];
    if (!nameLine || !line1?.startsWith("1 ") || !line2?.startsWith("2 ")) continue;
    records.push(parseTleTriplet(nameLine, line1, line2));
  }
  return records;
}

/** Fetches an entire CelesTrak group (e.g. "active", "gpz-plus", "military"). */
export async function fetchTleGroup(group: string): Promise<ParsedTle[]> {
  const url = `${CELESTRAK_BASE}?GROUP=${encodeURIComponent(group)}&FORMAT=tle`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CelesTrak group fetch failed (${res.status}): ${group}`);
  return parseTleText(await res.text());
}

/**
 * Fetches TLEs for specific NORAD catalog numbers (e.g. your watchlist).
 * CelesTrak's CATNR endpoint takes one ID per request, so we go sequential
 * with a small delay to stay well within their fair-use expectations.
 */
export async function fetchTleByNoradIds(noradIds: number[], delayMs = 300): Promise<ParsedTle[]> {
  const results: ParsedTle[] = [];
  for (const id of noradIds) {
    const url = `${CELESTRAK_BASE}?CATNR=${id}&FORMAT=tle`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`Skipping NORAD ${id}: fetch failed (${res.status})`);
      continue;
    }
    const parsed = parseTleText(await res.text());
    results.push(...parsed);
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }
  return results;
}
