/**
 * discovery.ts — Phase 1: Discover every URL on the target website.
 *
 * Uses the Olostep Maps API (POST /v1/maps) to enumerate all pages.
 * Handles cursor-based pagination for sites with > 100k URLs.
 *
 * ┌──────────┐     POST /v1/maps      ┌──────────────┐
 * │  CLI     │ ─────────────────────▶ │  Olostep API │
 * │  entry   │ ◀───────────────────── │  (Maps)      │
 * └──────────┘    { urls[], cursor? }  └──────────────┘
 *       │                                    │
 *       │  if cursor exists, paginate ───────┘
 *       ▼
 *  Complete URL list
 */

import { config, apiHeaders } from "./config";

/**
 * Discover all URLs on a website using the Olostep Maps API.
 *
 * @param siteUrl - The root URL to map (e.g. "https://www.olostep.com")
 * @returns Array of all discovered URLs
 */
export async function discoverUrls(siteUrl: string): Promise<string[]> {
  console.log(`\n🗺️  Phase 1: Discovering all URLs on ${siteUrl}...`);

  const allUrls: string[] = [];
  let cursor: string | undefined = undefined;
  let pageNum = 0;

  do {
    pageNum++;
    const body: Record<string, unknown> = { url: siteUrl };
    if (cursor) body.cursor = cursor;

    console.log(`   Fetching URL batch #${pageNum}${cursor ? ` (cursor: ${cursor.slice(0, 20)}...)` : ""}...`);

    const res = await fetch(`${config.apiBase}/maps`, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Maps API failed (${res.status}): ${errText}`);
    }

    const data = await res.json() as { urls?: string[]; cursor?: string };
    const urls = data.urls || [];
    allUrls.push(...urls);
    cursor = data.cursor;

    console.log(`   ✓ Received ${urls.length} URLs (total so far: ${allUrls.length})`);
  } while (cursor);

  // Deduplicate and sort
  const unique = [...new Set(allUrls)].sort();
  console.log(`   ✅ Discovery complete: ${unique.length} unique URLs found\n`);

  return unique;
}

/**
 * Filter URLs to only include pages from the target domain.
 * Removes query params, anchors, and non-http(s) URLs.
 */
export function cleanAndFilterUrls(urls: string[], baseDomain: string): string[] {
  const domainHost = new URL(baseDomain).hostname;

  return urls
    .filter((url) => {
      try {
        const parsed = new URL(url);
        return (
          (parsed.protocol === "http:" || parsed.protocol === "https:") &&
          parsed.hostname === domainHost
        );
      } catch {
        return false;
      }
    })
    .map((url) => {
      // Strip fragments but keep query params (some pages are query-based)
      const parsed = new URL(url);
      parsed.hash = "";
      return parsed.toString();
    })
    .filter((url, index, self) => self.indexOf(url) === index)
    .sort();
}
