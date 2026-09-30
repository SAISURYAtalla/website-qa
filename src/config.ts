/**
 * config.ts — Central configuration loaded from .env and CLI options.
 *
 * Reads OLOSTEP_API_KEY from the .env file and exposes constants used
 * across every module (API base URL, default concurrency, etc.).
 */

import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

// ─── Validate required env vars ──────────────────────────────────────────────

const OLOSTEP_API_KEY = process.env.OLOSTEP_API_KEY;
if (!OLOSTEP_API_KEY) {
  console.error("ERROR: OLOSTEP_API_KEY is not set in .env");
  process.exit(1);
}

// ─── Exported constants ──────────────────────────────────────────────────────

export const config = {
  /** Olostep API key */
  apiKey: OLOSTEP_API_KEY,

  /** Olostep API base URL */
  apiBase: "https://api.olostep.com/v1",

  /** Default target website */
  defaultUrl: "https://www.olostep.com",

  /** Max concurrent scrape requests */
  defaultConcurrency: 5,

  /** Default max pages to scrape (0 = unlimited) */
  defaultMaxPages: 0,

  /** Delay between API calls to be respectful (ms) */
  requestDelayMs: 200,

  /** Poll interval when waiting for async operations (ms) */
  pollIntervalMs: 5000,

  /** Timeout for async operations like crawl/batch (ms) — 15 minutes */
  asyncTimeoutMs: 15 * 60 * 1000,

  /** Reports output directory */
  reportsDir: path.resolve(__dirname, "../reports"),
} as const;

// ─── HTTP helper ─────────────────────────────────────────────────────────────

/**
 * Common headers for every Olostep API request.
 */
export function apiHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  };
}
