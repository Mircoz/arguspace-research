/**
 * Runs via GitHub Actions workflow_dispatch on this repo (see
 * .github/workflows/backfill.yml) — this repo is public specifically so the
 * job can run for hours on unlimited free Actions minutes, no local
 * execution or private-repo minute budget involved.
 *
 * Can also be run manually: npx tsx src/backfill.ts
 *
 * Requires output/population.json (run build-population.ts first)
 * and SPACETRACK_IDENTITY / SPACETRACK_PASSWORD as repo secrets (or in
 * .env for a manual run).
 *
 * Resumable within a single run: progress is checkpointed after every
 * batch, so a transient failure partway through doesn't waste completed
 * work — the loop below just skips already-completed batch/window pairs.
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { SpaceTrackClient } from "./spacetrack-client.js";
import { parseTleText, type ParsedTle } from "./lib/tle-fetch.js";
import { propagateAt } from "./lib/propagate.js";
import { screenGeoByDay, screenLeoByDay, type DailyPosition, type OrbitBand } from "./screening.js";

const BATCH_SIZE = 40; // NORAD IDs per Space-Track request — larger batch = fewer requests = faster run
const WINDOW_MONTHS = 6; // date-range chunk per request, keeps individual responses manageable
const YEARS_BACK = 5;
const MANEUVER_MEAN_MOTION_THRESHOLD = 0.001;
const MANEUVER_INCLINATION_THRESHOLD_DEG = 0.02;

const OUT_DIR = "output";
const POPULATION_PATH = `${OUT_DIR}/population.json`;
const CHECKPOINT_PATH = `${OUT_DIR}/checkpoint.json`;
const MANEUVERS_PATH = `${OUT_DIR}/maneuvers.jsonl`;
const DAILY_POSITIONS_PATH = `${OUT_DIR}/daily-positions.jsonl`;
const CANDIDATES_PATH = `${OUT_DIR}/candidate-events.json`;

interface PopulationEntry {
  norad_id: number;
  name: string;
  source: "geo_celestrak" | "leo_high_value_ucs";
}

interface Checkpoint {
  completedBatchWindows: string[]; // "batchIndex:windowIndex"
}

function loadCheckpoint(): Checkpoint {
  if (!existsSync(CHECKPOINT_PATH)) return { completedBatchWindows: [] };
  return JSON.parse(readFileSync(CHECKPOINT_PATH, "utf-8"));
}

function saveCheckpoint(cp: Checkpoint) {
  writeFileSync(CHECKPOINT_PATH, JSON.stringify(cp, null, 2));
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function dateWindows(years: number, months: number): [string, string][] {
  const windows: [string, string][] = [];
  const end = new Date();
  let cursor = new Date(end);
  cursor.setMonth(cursor.getMonth() - years * 12);

  while (cursor < end) {
    const windowEnd = new Date(cursor);
    windowEnd.setMonth(windowEnd.getMonth() + months);
    const clampedEnd = windowEnd > end ? end : windowEnd;
    windows.push([fmt(cursor), fmt(clampedEnd)]);
    cursor = clampedEnd;
  }
  return windows;
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Detects maneuver candidates from a chronologically-sorted TLE sequence for one object. */
function detectManeuvers(noradId: number, tles: ParsedTle[]) {
  const sorted = [...tles].sort((a, b) => a.epoch.getTime() - b.epoch.getTime());
  const events: { norad_id: number; detected_at: string; method: string; delta: number }[] = [];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    const mmDelta = curr.meanMotion - prev.meanMotion;
    const incDelta = curr.inclinationDeg - prev.inclinationDeg;

    if (Math.abs(mmDelta) > MANEUVER_MEAN_MOTION_THRESHOLD) {
      events.push({ norad_id: noradId, detected_at: curr.epoch.toISOString(), method: "mean_motion_delta", delta: mmDelta });
    }
    if (Math.abs(incDelta) > MANEUVER_INCLINATION_THRESHOLD_DEG) {
      events.push({ norad_id: noradId, detected_at: curr.epoch.toISOString(), method: "inclination_jump", delta: incDelta });
    }
  }
  return events;
}

/** Builds one position per UTC day per object, using the last known TLE as of each day. */
function buildDailyPositions(noradId: number, tles: ParsedTle[]): DailyPosition[] {
  const sorted = [...tles].sort((a, b) => a.epoch.getTime() - b.epoch.getTime());
  if (sorted.length === 0) return [];

  const positions: DailyPosition[] = [];
  const start = sorted[0].epoch;
  const end = sorted[sorted.length - 1].epoch;

  let tleIdx = 0;
  for (let t = new Date(start); t <= end; t.setUTCDate(t.getUTCDate() + 1)) {
    while (tleIdx + 1 < sorted.length && sorted[tleIdx + 1].epoch <= t) tleIdx++;
    const tle = sorted[tleIdx];
    const state = propagateAt(tle.line1, tle.line2, t);
    if (!state) continue;

    const r = Math.sqrt(state.positionKm.x ** 2 + state.positionKm.y ** 2 + state.positionKm.z ** 2);
    // Crude lat/lng proxy for screening purposes only — not used for the
    // fine-grained refinement, which re-propagates from real TLEs.
    const lng = (Math.atan2(state.positionKm.y, state.positionKm.x) * 180) / Math.PI;
    const lat = (Math.asin(state.positionKm.z / r) * 180) / Math.PI;

    positions.push({ norad_id: noradId, day: fmt(t), lat, lng, altKm: r - 6371 });
  }
  return positions;
}

async function main() {
  if (!existsSync(POPULATION_PATH)) {
    console.error(`Missing ${POPULATION_PATH} — run build-population.ts first.`);
    process.exit(1);
  }
  const population: PopulationEntry[] = JSON.parse(readFileSync(POPULATION_PATH, "utf-8"));
  const batches = chunk(population, BATCH_SIZE);
  const windows = dateWindows(YEARS_BACK, WINDOW_MONTHS);
  const checkpoint = loadCheckpoint();

  console.log(`Population: ${population.length} objects, ${batches.length} batches × ${windows.length} windows`);
  console.log(`Already completed: ${checkpoint.completedBatchWindows.length} batch-windows`);

  const client = new SpaceTrackClient();
  await client.login();

  const orbitBands: OrbitBand[] = [];
  const allDailyPositions: DailyPosition[] = [];

  try {
    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      const noradIds = batch.map((e) => e.norad_id);

      for (let w = 0; w < windows.length; w++) {
        const key = `${b}:${w}`;
        if (checkpoint.completedBatchWindows.includes(key)) continue;

        const [start, end] = windows[w];
        console.log(`Batch ${b + 1}/${batches.length}, window ${w + 1}/${windows.length} (${start}..${end})...`);

        const raw = await client.gpHistory(noradIds, start, end);
        const parsed = parseTleText(raw);

        const byNorad = new Map<number, ParsedTle[]>();
        for (const p of parsed) {
          if (!byNorad.has(p.noradId)) byNorad.set(p.noradId, []);
          byNorad.get(p.noradId)!.push(p);
        }

        for (const [noradId, tles] of byNorad) {
          const maneuvers = detectManeuvers(noradId, tles);
          for (const m of maneuvers) appendFileSync(MANEUVERS_PATH, JSON.stringify(m) + "\n");

          const daily = buildDailyPositions(noradId, tles);
          for (const d of daily) appendFileSync(DAILY_POSITIONS_PATH, JSON.stringify(d) + "\n");
          allDailyPositions.push(...daily);

          if (tles.length > 0) {
            const last = tles[tles.length - 1];
            const meanMotionRadPerMin = (last.meanMotion * 2 * Math.PI) / 1440;
            const semiMajorAxisKm = Math.cbrt(398600.4418 / meanMotionRadPerMin ** 2);
            const perigeeKm = semiMajorAxisKm * (1 - last.eccentricity) - 6371;
            const apogeeKm = semiMajorAxisKm * (1 + last.eccentricity) - 6371;
            orbitBands.push({ norad_id: noradId, perigeeKm, apogeeKm });
          }
        }

        checkpoint.completedBatchWindows.push(key);
        saveCheckpoint(checkpoint);
      }
    }
  } finally {
    await client.logout();
  }

  console.log("\nDownload complete. Running coarse screening...");

  const geoPop = new Set(population.filter((p) => p.source === "geo_celestrak").map((p) => p.norad_id));
  const geoPositions = allDailyPositions.filter((p) => geoPop.has(p.norad_id));
  const leoPositions = allDailyPositions.filter((p) => !geoPop.has(p.norad_id));

  const geoCandidates = screenGeoByDay(geoPositions);
  const leoCandidates = screenLeoByDay(leoPositions, orbitBands);

  console.log(`GEO candidates: ${geoCandidates.length}, LEO candidates: ${leoCandidates.length}`);
  console.log(
    "These are COARSE, approximate candidates from daily sampling — not confirmed events. " +
      "Next step: fine-grained refinement per candidate (see README.md)."
  );

  writeFileSync(
    CANDIDATES_PATH,
    JSON.stringify({ generated_at: new Date().toISOString(), geo: geoCandidates, leo: leoCandidates }, null, 2)
  );
  console.log(`Written to ${CANDIDATES_PATH}`);
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  console.error("Progress was checkpointed — re-run the same command to resume.");
  process.exit(1);
});
