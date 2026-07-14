/**
 * Minimal Space-Track.org client for historical TLE research.
 *
 * Space-Track (not CelesTrak) is required for historical data — CelesTrak only
 * serves the current catalog. Sign up free at https://www.space-track.org.
 *
 * Rate limits (per Space-Track's documented policy): 30 requests/minute,
 * 300 requests/hour. This client enforces both, sequentially, with no
 * concurrency — going slower than the limit is always safe, going over risks
 * account suspension.
 */
import "dotenv/config";

const BASE_URL = "https://www.space-track.org";
const MIN_INTERVAL_MS = 2100; // ~28-29 req/min, safety margin under the 30/min cap
const HOUR_MS = 60 * 60 * 1000;
const MAX_PER_HOUR = 290; // safety margin under the 300/hour cap

let lastRequestAt = 0;
const requestTimestamps: number[] = [];

async function throttle() {
  const now = Date.now();

  // Per-minute pacing
  const sinceLast = now - lastRequestAt;
  if (sinceLast < MIN_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS - sinceLast));
  }

  // Per-hour budget — prune old timestamps, wait out the window if at cap
  const cutoff = Date.now() - HOUR_MS;
  while (requestTimestamps.length && requestTimestamps[0] < cutoff) requestTimestamps.shift();
  if (requestTimestamps.length >= MAX_PER_HOUR) {
    const waitMs = requestTimestamps[0] + HOUR_MS - Date.now() + 1000;
    console.log(`Hourly Space-Track rate limit reached, waiting ${Math.ceil(waitMs / 60000)} min...`);
    await new Promise((r) => setTimeout(r, waitMs));
  }

  lastRequestAt = Date.now();
  requestTimestamps.push(lastRequestAt);
}

export class SpaceTrackClient {
  private cookie: string | null = null;

  constructor(
    private identity = process.env.SPACETRACK_IDENTITY,
    private password = process.env.SPACETRACK_PASSWORD
  ) {
    if (!identity || !password) {
      throw new Error(
        "Missing SPACETRACK_IDENTITY / SPACETRACK_PASSWORD. Free account: https://www.space-track.org"
      );
    }
  }

  async login(): Promise<void> {
    await throttle();
    const res = await fetch(`${BASE_URL}/ajaxauth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ identity: this.identity!, password: this.password! }),
    });
    if (!res.ok) throw new Error(`Space-Track login failed: ${res.status}`);
    const setCookie = res.headers.get("set-cookie");
    if (!setCookie) throw new Error("Space-Track login did not return a session cookie");
    this.cookie = setCookie;
  }

  /**
   * Fetches historical TLEs for a batch of NORAD IDs within a date range.
   * Batches multiple IDs into one request (comma-delimited) per Space-Track's
   * own guidance to minimize request count.
   */
  async gpHistory(noradIds: number[], startDate: string, endDate: string): Promise<string> {
    if (!this.cookie) throw new Error("Not logged in — call login() first");
    await throttle();

    const idList = noradIds.join(",");
    const url =
      `${BASE_URL}/basicspacedata/query/class/gp_history/NORAD_CAT_ID/${idList}` +
      `/EPOCH/${startDate}--${endDate}/orderby/NORAD_CAT_ID,EPOCH/format/tle`;

    const res = await fetch(url, { headers: { Cookie: this.cookie } });
    if (!res.ok) throw new Error(`gp_history query failed (${res.status}) for batch [${idList.slice(0, 40)}...]`);
    return res.text();
  }

  async logout(): Promise<void> {
    if (!this.cookie) return;
    await fetch(`${BASE_URL}/ajaxauth/logout`, { headers: { Cookie: this.cookie } });
  }
}
