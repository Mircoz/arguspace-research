/**
 * Run: npx tsx src/push-candidates.ts
 * Pushes output/candidate-events.json into Supabase's
 * research_candidates table, so they're visible for review (e.g. from a
 * dashboard extension) rather than only sitting in a local file.
 */
import { readFileSync } from "node:fs";
import { supabase } from "./lib/supabase-client.js";

interface Candidate {
  norad_id_a: number;
  norad_id_b: number;
  day: string;
  approxDistanceKm: number;
}

async function main() {
  const raw = JSON.parse(readFileSync("output/candidate-events.json", "utf-8")) as {
    geo: Candidate[];
    leo: Candidate[];
  };

  const rows = [
    ...raw.geo.map((c) => ({ ...c, population_source: "geo" })),
    ...raw.leo.map((c) => ({ ...c, population_source: "leo" })),
  ].map((c) => ({
    norad_id_a: c.norad_id_a,
    norad_id_b: c.norad_id_b,
    day: c.day,
    approx_distance_km: c.approxDistanceKm,
    population_source: c.population_source,
  }));

  if (rows.length === 0) {
    console.log("No candidates to push.");
    return;
  }

  // Chunk inserts to keep individual requests reasonable
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const { error } = await supabase.from("research_candidates").insert(slice);
    if (error) throw new Error(`Insert failed at offset ${i}: ${error.message}`);
    console.log(`  Pushed ${i + slice.length}/${rows.length}`);
  }

  console.log(`Done. ${rows.length} candidates pushed for review.`);
}

main().catch((err) => {
  console.error("Push failed:", err);
  process.exit(1);
});
