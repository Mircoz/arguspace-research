/**
 * Run: npx tsx src/build-population.ts /path/to/ucs-satellite-database.csv
 *
 * Builds the target object list for historical research:
 *  - GEO belt: fetched live from CelesTrak (public, no auth)
 *  - High-value LEO: filtered from a local UCS Satellite Database export
 *    (download the CSV yourself from https://www.ucsusa.org/resources/satellite-database
 *    — no stable public API endpoint to fetch it automatically, and the site
 *    may require accepting terms before download)
 *
 * Output: output/population.json — deduped list of {norad_id, name, source}
 */
import { writeFileSync, readFileSync } from "node:fs";
import { fetchTleGroup } from "./lib/tle-fetch.js";

interface PopulationEntry {
  norad_id: number;
  name: string;
  source: "geo_celestrak" | "leo_high_value_ucs";
  category?: string;
}

/** Minimal RFC 4180-ish CSV line parser — handles quoted fields containing commas. */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

/** Parses the UCS Satellite Database CSV, filtering to LEO objects with military/government users. */
function parseUcsHighValueLeo(csvPath: string): PopulationEntry[] {
  const raw = readFileSync(csvPath, "utf-8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const idx = {
    name: header.indexOf("Name of Satellite, Alternate Names"),
    users: header.indexOf("Users"),
    orbitClass: header.indexOf("Class of Orbit"),
    country: header.indexOf("Country of Operator/Owner"),
    norad: header.indexOf("NORAD Number"),
  };

  const missing = Object.entries(idx).filter(([, v]) => v === -1);
  if (missing.length > 0) {
    throw new Error(
      `UCS CSV missing expected columns: ${missing.map(([k]) => k).join(", ")}. ` +
        `Column headers may have changed — check the file against README.md.`
    );
  }

  const entries: PopulationEntry[] = [];
  for (const line of lines.slice(1)) {
    const fields = parseCsvLine(line);
    const orbitClass = (fields[idx.orbitClass] ?? "").trim().toUpperCase();
    const users = (fields[idx.users] ?? "").trim();
    const noradStr = (fields[idx.norad] ?? "").trim();

    if (orbitClass !== "LEO") continue;
    if (!/military|government/i.test(users)) continue;

    const noradId = parseInt(noradStr, 10);
    if (!Number.isFinite(noradId)) continue;

    entries.push({
      norad_id: noradId,
      name: (fields[idx.name] ?? `NORAD ${noradId}`).trim(),
      source: "leo_high_value_ucs",
      category: `${users} · ${(fields[idx.country] ?? "").trim()}`,
    });
  }
  return entries;
}

async function buildGeoPopulation(): Promise<PopulationEntry[]> {
  const records = await fetchTleGroup("geo");
  return records.map((r) => ({
    norad_id: r.noradId,
    name: r.name,
    source: "geo_celestrak" as const,
  }));
}

async function main() {
  const ucsPath = process.argv[2];
  if (!ucsPath) {
    console.error("Usage: npx tsx src/build-population.ts /path/to/ucs-satellite-database.csv");
    process.exit(1);
  }

  console.log("Fetching GEO belt from CelesTrak...");
  const geo = await buildGeoPopulation();
  console.log(`  ${geo.length} GEO objects.`);

  console.log("Parsing UCS Satellite Database for high-value LEO...");
  const leo = parseUcsHighValueLeo(ucsPath);
  console.log(`  ${leo.length} military/government LEO objects.`);

  const byNorad = new Map<number, PopulationEntry>();
  for (const e of [...geo, ...leo]) {
    if (!byNorad.has(e.norad_id)) byNorad.set(e.norad_id, e);
  }

  const population = [...byNorad.values()].sort((a, b) => a.norad_id - b.norad_id);
  writeFileSync("output/population.json", JSON.stringify(population, null, 2));

  console.log(`\nTotal population: ${population.length} unique objects.`);
  console.log("Written to output/population.json");
}

main().catch((err) => {
  console.error("Population build failed:", err);
  process.exit(1);
});
