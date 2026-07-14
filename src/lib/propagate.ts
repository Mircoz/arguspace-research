import * as satellite from "satellite.js";

export interface EciState {
  positionKm: { x: number; y: number; z: number };
  velocityKmS: { x: number; y: number; z: number };
}

/** Propagates a TLE to a given date using SGP4, returning ECI position/velocity in km. */
export function propagateAt(line1: string, line2: string, date: Date): EciState | null {
  const satrec = satellite.twoline2satrec(line1, line2);
  const pv = satellite.propagate(satrec, date);

  if (
    !pv.position ||
    !pv.velocity ||
    typeof pv.position === "boolean" ||
    typeof pv.velocity === "boolean"
  ) {
    return null;
  }

  return {
    positionKm: { x: pv.position.x, y: pv.position.y, z: pv.position.z },
    velocityKmS: { x: pv.velocity.x, y: pv.velocity.y, z: pv.velocity.z },
  };
}

/** Euclidean distance in km between two ECI position vectors. */
export function distanceKm(a: EciState["positionKm"], b: EciState["positionKm"]): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Samples the distance between two objects across a time window.
 * Returns the minimum distance found and the timestamp it occurred at —
 * the core building block for proximity/RPO detection.
 */
export function sampleMinDistance(
  line1A: string,
  line2A: string,
  line1B: string,
  line2B: string,
  start: Date,
  end: Date,
  stepMinutes = 10
): { minDistanceKm: number; atTime: Date } | null {
  let best: { minDistanceKm: number; atTime: Date } | null = null;

  for (let t = start.getTime(); t <= end.getTime(); t += stepMinutes * 60 * 1000) {
    const date = new Date(t);
    const stateA = propagateAt(line1A, line2A, date);
    const stateB = propagateAt(line1B, line2B, date);
    if (!stateA || !stateB) continue;

    const d = distanceKm(stateA.positionKm, stateB.positionKm);
    if (!best || d < best.minDistanceKm) best = { minDistanceKm: d, atTime: date };
  }
  return best;
}
