/**
 * link-checker.ts — Phase 3: Validate links found across all pages.
 *
 * After scraping, we have a list of internal and external links from every
 * page. This module:
 *   1. For internal links: checks against the full discovered URL set +
 *      scraped URL set. Normalizes URLs by stripping query params and
 *      trailing slashes before comparing.
 *   2. For external links: checks UNIQUE external URLs via Olostep Scrape
 *      API, but only flags genuine 4xx/5xx responses (NOT API timeouts or
 *      scrape infrastructure errors which are false positives).
 *   3. Maps broken links back to the source pages that reference them.
 *
 * ┌──────────────────┐
 * │ All PageQAResults│
 * │ .internalLinks   │──▶ Compare against discovered + scraped (normalized)
 * │ .externalLinks   │──▶ Check unique targets via Scrape API
 * └──────────────────┘
 *          │
 *          ▼
 *  Broken links mapped back to source pages
 */

import { config, apiHeaders } from "./config";
import type { PageQAResult, BrokenLink } from "./types";

// ─── URL normalization ───────────────────────────────────────────────────────

/**
 * Normalize a URL for comparison: strip trailing slash, query params, fragments.
 */
function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    let normalized = parsed.toString();
    // Remove trailing slash (but keep root "/" as "/")
    if (normalized.endsWith("/") && parsed.pathname !== "/") {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  } catch {
    return url.replace(/[?#].*$/, "").replace(/\/+$/, "") || url;
  }
}

// ─── Known safe external domains (skip checking) ────────────────────────────

const SAFE_EXTERNAL_DOMAINS = new Set([
  "github.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "www.linkedin.com",
  "youtube.com",
  "www.youtube.com",
  "google.com",
  "www.google.com",
  "facebook.com",
  "www.facebook.com",
  "instagram.com",
  "www.instagram.com",
  "npmjs.com",
  "www.npmjs.com",
  "pypi.org",
  "cdn.prod.website-files.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "www.googletagmanager.com",
  "analytics.google.com",
  "www.google-analytics.com",
  "cdn.jsdelivr.net",
  "unpkg.com",
  "cdnjs.cloudflare.com",
  "olostep-storage.s3.us-east-1.amazonaws.com",
  "olostep-screenshots.s3.us-east-1.amazonaws.com",
  "calendly.com",
  "slack.com",
  "olostep-users.slack.com",
  "docs.olostep.com",
  "ghost.olostep.com",
  "api.olostep.com",
  "mcp.olostep.com",
  "reddit.com",
  "www.reddit.com",
  "medium.com",
  "producthunt.com",
  "www.producthunt.com",
  "stripe.com",
  "en.wikipedia.org",
  "webflow.com",
  "assets-global.website-files.com",
]);

function isSafeDomain(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return SAFE_EXTERNAL_DOMAINS.has(host) || host.endsWith(".googleapis.com");
  } catch {
    return false;
  }
}

/**
 * Check all links discovered during scraping and identify broken ones.
 */
export async function checkLinks(
  results: PageQAResult[],
  allDiscovered: string[],
  concurrency: number
): Promise<void> {
  console.log(`\n🔗 Phase 3: Checking links for broken references...\n`);

  // Build a normalized set of all known internal URLs
  const knownInternalUrls = new Set<string>();

  for (const url of allDiscovered) {
    knownInternalUrls.add(normalizeUrl(url));
  }
  for (const r of results) {
    knownInternalUrls.add(normalizeUrl(r.url));
  }

  console.log(`   Known internal URLs (normalized): ${knownInternalUrls.size}`);

  // Track pages that returned errors (these ARE broken)
  const errorPages = new Set<string>();
  for (const r of results) {
    if (r.statusCategory === "client_error" || r.statusCategory === "server_error" || r.isSoftError) {
      errorPages.add(normalizeUrl(r.url));
    }
  }

  // Collect broken internal links and external links to check
  const externalLinksMap = new Map<string, Set<string>>();
  const internalBroken: BrokenLink[] = [];
  const seenInternalBroken = new Set<string>(); // dedup: sourceUrl|targetUrl

  for (const page of results) {
    for (const link of page.internalLinks) {
      const norm = normalizeUrl(link);
      const dedupKey = `${page.url}|${norm}`;
      if (seenInternalBroken.has(dedupKey)) continue;

      // Case 1: Link points to a known error page
      if (errorPages.has(norm)) {
        const errorPage = results.find((r) => normalizeUrl(r.url) === norm);
        seenInternalBroken.add(dedupKey);
        internalBroken.push({
          sourceUrl: page.url,
          targetUrl: link,
          statusCode: errorPage?.statusCode ?? null,
          error: errorPage?.isSoftError
            ? `Soft error: ${errorPage.softErrorReason}`
            : `Page returned ${errorPage?.statusCode || "error"}`,
        });
        continue;
      }

      // Case 2: Link target is not in any known URL set
      if (!knownInternalUrls.has(norm)) {
        seenInternalBroken.add(dedupKey);
        internalBroken.push({
          sourceUrl: page.url,
          targetUrl: link,
          statusCode: null,
          error: "URL not found in site map",
        });
      }
    }

    // Collect external links (deduplicate by target URL)
    for (const link of page.externalLinks) {
      // Skip safe/known-good domains
      if (isSafeDomain(link)) continue;

      if (!externalLinksMap.has(link)) {
        externalLinksMap.set(link, new Set());
      }
      externalLinksMap.get(link)!.add(page.url);
    }
  }

  // Deduplicate internal broken by unique target URL
  const uniqueInternalTargets = new Set(internalBroken.map((b) => normalizeUrl(b.targetUrl)));
  console.log(`   Internal broken links: ${internalBroken.length} references to ${uniqueInternalTargets.size} unique URLs`);
  console.log(`   Unique external links to check (excluding safe domains): ${externalLinksMap.size}`);

  // Check external links via lightweight scrape
  const externalBroken: BrokenLink[] = [];
  const externalUrls = [...externalLinksMap.keys()];

  if (externalUrls.length > 0) {
    const pLimitModule = await import("p-limit");
    const pLimit = pLimitModule.default;
    const limit = pLimit(concurrency);

    let checked = 0;
    let broken = 0;

    const tasks = externalUrls.map((targetUrl) =>
      limit(async () => {
        await sleep(config.requestDelayMs);
        checked++;

        try {
          const res = await fetch(`${config.apiBase}/scrapes`, {
            method: "POST",
            headers: apiHeaders(),
            body: JSON.stringify({
              url_to_scrape: targetUrl,
              formats: ["markdown"],
            }),
          });

          if (!res.ok) {
            // Only flag as broken if it's a genuine page error (4xx),
            // NOT if the Scrape API itself had issues (5xx, timeouts)
            let apiErrorBody: any = {};
            try { apiErrorBody = await res.json(); } catch {}

            const errorType = apiErrorBody?.error?.type || "";
            const errorCode = apiErrorBody?.error?.code || "";

            // Scrape API infrastructure errors are NOT broken links
            if (
              res.status >= 500 ||
              errorType === "request_timeout" ||
              errorCode === "scrape_poll_timeout" ||
              errorType === "internal_error"
            ) {
              // Skip — this is an API-side issue, not a broken link
              return;
            }

            // Genuine client errors from the target page
            const sources = externalLinksMap.get(targetUrl)!;
            for (const src of sources) {
              externalBroken.push({
                sourceUrl: src,
                targetUrl,
                statusCode: res.status,
                error: `HTTP ${res.status}`,
              });
            }
            broken++;
            return;
          }

          const data = (await res.json()) as any;
          const statusCode = data?.result?.page_metadata?.status_code;

          // Only flag genuine page-level errors
          if (statusCode && statusCode >= 400) {
            const sources = externalLinksMap.get(targetUrl)!;
            for (const src of sources) {
              externalBroken.push({
                sourceUrl: src,
                targetUrl,
                statusCode,
                error: `Target returned HTTP ${statusCode}`,
              });
            }
            broken++;
          }

          if (checked % 50 === 0) {
            console.log(`   Checked ${checked}/${externalUrls.length} external links (${broken} broken so far)...`);
          }
        } catch (err) {
          // Network errors from our side — skip, not a broken link
        }
      })
    );

    await Promise.all(tasks);
    console.log(`   Checked ${checked}/${externalUrls.length} external links — ${broken} broken`);
  }

  // Merge all broken links back into PageQAResults
  const allBroken = [...internalBroken, ...externalBroken];

  for (const brokenLink of allBroken) {
    const page = results.find((r) => r.url === brokenLink.sourceUrl);
    if (page) {
      page.brokenLinksOnPage.push(brokenLink);
      page.brokenLinksCount = page.brokenLinksOnPage.length;
    }
  }

  console.log(
    `\n   ✅ Link check complete: ${allBroken.length} broken links found` +
      ` (${internalBroken.length} internal, ${externalBroken.length} external)\n`
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
