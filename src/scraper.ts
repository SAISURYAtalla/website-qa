/**
 * scraper.ts — Phase 2: Scrape every discovered URL.
 *
 * Uses the Olostep Scrape API (POST /v1/scrapes) to fetch:
 *   - markdown content   (for word count, content preview)
 *   - html content       (for link extraction, SEO analysis)
 *   - screenshot         (hosted URL for visual reference)
 *   - page_metadata      (status_code, title)
 *
 * When the --ai flag is active, the scrape also includes an `llm_extract`
 * parameter that asks Olostep's built-in LLM to assess UI and content quality.
 *
 * Concurrency is managed via p-limit to avoid overwhelming the API.
 *
 * ┌────────────┐                          ┌──────────────┐
 * │  For each  │   POST /v1/scrapes       │  Olostep API │
 * │  URL       │ ────────────────────────▶│  (Scrape)    │
 * │  (5 conc.) │ ◀────────────────────────│              │
 * └────────────┘   { markdown, html,      └──────────────┘
 *                    screenshot, meta,
 *                    json (if --ai) }
 */

import { config, apiHeaders } from "./config";
import type { PageQAResult, AIAnalysis, OlostepScrapeResult } from "./types";
import * as cheerio from "cheerio";

// ─── LLM extraction schema for AI mode ──────────────────────────────────────

const LLM_EXTRACT_SCHEMA = {
  schema: {
    type: "object",
    properties: {
      ui_score: {
        type: "number",
        description:
          "Rate the visual/UI quality of this page from 1 (terrible) to 10 (excellent). Consider layout, spacing, typography, color consistency, responsiveness, and overall polish. A score of 1-3 means ugly/vibecoded/broken. 4-6 means acceptable but needs work. 7-10 means polished.",
      },
      ui_issues: {
        type: "string",
        description:
          "Describe any visual/UI problems: broken layouts, overlapping elements, inconsistent styling, poor spacing, missing images, unpolished vibecoded look, generic template feel, bad color choices, poor typography. Say 'None' if no issues.",
      },
      content_score: {
        type: "number",
        description:
          "Rate the content quality from 1 (empty/placeholder) to 10 (excellent). Consider completeness, clarity, grammar, usefulness, and whether it looks like real production content vs placeholder/lorem ipsum.",
      },
      content_issues: {
        type: "string",
        description:
          "Describe any content problems: placeholder text, lorem ipsum, thin/empty content, broken formatting, missing information, duplicate content, grammatical errors. Say 'None' if no issues.",
      },
      is_vibecoded: {
        type: "boolean",
        description:
          "Does this page look auto-generated, template-default, or 'vibecoded' with no human polish? true = looks unfinished/generic/AI-generated-template, false = looks intentionally designed with care.",
      },
      missing_images: {
        type: "boolean",
        description:
          "Are there any broken image placeholders, missing images, or image loading errors visible on the page?",
      },
      overall_verdict: {
        type: "string",
        description:
          "Overall QA verdict: 'pass' (page looks good), 'warning' (minor issues that should be reviewed), or 'fail' (significant problems that need fixing urgently).",
      },
    },
    required: [
      "ui_score",
      "ui_issues",
      "content_score",
      "content_issues",
      "is_vibecoded",
      "missing_images",
      "overall_verdict",
    ],
  },
};

// ─── Soft 404 detection patterns ─────────────────────────────────────────────

const SOFT_404_TITLE_PATTERNS = [
  /\b404\b/i,
  /page\s*not\s*found/i,
  /not\s*found/i,
  /does\s*n.?t\s*exist/i,
  /no\s*longer\s*available/i,
  /page\s*(has\s*been\s*)?(moved|removed|deleted)/i,
  /we\s*couldn.?t\s*find/i,
  /nothing\s*here/i,
  /oops/i,
];

const SOFT_404_CONTENT_PATTERNS = [
  /\b404\b.*\b(error|page|not found)\b/i,
  /page\s*(you\s*(were\s*)?)?looking\s*for.*not\s*(be\s*)?found/i,
  /this\s*page\s*(doesn.?t|does\s*not)\s*exist/i,
  /page\s*not\s*found/i,
  /the\s*requested\s*(page|url|resource)\s*(was\s*)?not\s*found/i,
  /we\s*couldn.?t\s*find\s*(the|this)\s*page/i,
  /nothing\s*(was\s*)?found\s*at\s*this/i,
  /this\s*page\s*(has\s*been\s*)?(moved|removed|deleted)/i,
  /no\s*longer\s*(available|exists)/i,
];

// Content patterns that should NOT trigger soft-404 (articles about 404s etc.)
const SOFT_404_FALSE_POSITIVE_PATTERNS = [
  /how\s*to\s*(fix|handle|avoid|resolve)\s*404/i,
  /what\s*is\s*(a\s*)?404/i,
  /http\s*status\s*(code\s*)?404/i,
  /status\s*code/i,
  /error\s*(handling|codes|types)/i,
  /bypass|scraping|scraper|crawler|agent/i,
];

function detectSoftError(
  title: string,
  markdownContent: string,
  wordCount: number
): { isSoftError: boolean; reason: string } {
  // Empty pages with 200 are soft errors
  if (wordCount === 0) {
    return { isSoftError: true, reason: "Empty page (0 words, no content returned)" };
  }

  // Very thin page with no title is suspicious
  if (wordCount < 10 && !title) {
    return { isSoftError: true, reason: "Nearly empty page (< 10 words, no title)" };
  }

  const titleLower = title.toLowerCase();
  const contentSlice = markdownContent.slice(0, 2000).toLowerCase();

  // Check if this is an article ABOUT errors (not an actual error page)
  for (const fp of SOFT_404_FALSE_POSITIVE_PATTERNS) {
    if (fp.test(titleLower) || fp.test(contentSlice)) {
      return { isSoftError: false, reason: "" };
    }
  }

  // Check title for soft-404 patterns
  for (const pattern of SOFT_404_TITLE_PATTERNS) {
    if (pattern.test(titleLower)) {
      return { isSoftError: true, reason: `Title matches soft-404 pattern: "${title}"` };
    }
  }

  // Check content (first 2000 chars) for soft-404 patterns
  for (const pattern of SOFT_404_CONTENT_PATTERNS) {
    if (pattern.test(contentSlice)) {
      const match = contentSlice.match(pattern);
      return { isSoftError: true, reason: `Content contains: "${match?.[0]}"` };
    }
  }

  return { isSoftError: false, reason: "" };
}

// ─── Interactive element detection ───────────────────────────────────────────

function detectInteractiveElements(
  $: cheerio.CheerioAPI,
  url: string,
  title: string
): { hasInteractive: boolean; interactiveType: string } {
  const types: string[] = [];

  // Forms
  const forms = $("form").length;
  if (forms > 0) types.push(`${forms} form(s)`);

  // Input fields (outside forms too)
  const inputs = $("input:not([type=hidden])").length;
  const textareas = $("textarea").length;
  const selects = $("select").length;
  if (inputs + textareas + selects > 0) {
    types.push(`${inputs + textareas + selects} input field(s)`);
  }

  // Buttons (not in nav) — need higher threshold to avoid flagging nav buttons
  const buttons = $("button, [role=button], input[type=submit], input[type=button]").length;
  if (buttons > 5) types.push(`${buttons} button(s)`);

  // Iframes (embedded apps, maps, videos)
  const iframes = $("iframe").length;
  if (iframes > 0) types.push(`${iframes} iframe(s)`);

  // URL-based detection for known interactive pages
  const urlLower = url.toLowerCase();
  const titleLower = title.toLowerCase();

  const toolPatterns: Record<string, RegExp> = {
    "playground/demo": /playground|demo/,
    "dashboard/app": /dashboard|app\b/,
    "login/auth": /login|signin|sign-in|signup|sign-up|auth/,
    "tracker/monitor": /tracker|monitor/,
    "checker/validator": /checker|validator|audit/,
    "generator/builder": /generator|builder|creator/,
    "extractor/scraper": /extractor|scraper/,
    "search/filter": /\/search|\/filter/,
    "calculator/converter": /calculator|converter/,
    "contact/form": /contact|apply|request/,
  };

  for (const [label, pattern] of Object.entries(toolPatterns)) {
    if (pattern.test(urlLower) || pattern.test(titleLower)) {
      if (!types.includes(label)) types.push(label);
    }
  }

  return {
    hasInteractive: types.length > 0,
    interactiveType: types.join(", ") || "",
  };
}

// ─── Parse HTML to extract SEO and link data ─────────────────────────────────

function analyzeHtml(
  html: string,
  pageUrl: string
): {
  title: string;
  metaDescription: string;
  hasH1: boolean;
  headingStructure: string;
  canonicalUrl: string;
  ogImage: string;
  imageCount: number;
  internalLinks: string[];
  externalLinks: string[];
  hasInteractiveElements: boolean;
  interactiveType: string;
} {
  const $ = cheerio.load(html);
  const pageHost = new URL(pageUrl).hostname;

  // Title
  const title = $("title").first().text().trim() || "";

  // Meta description
  const metaDescription =
    $('meta[name="description"]').attr("content")?.trim() ||
    $('meta[property="og:description"]').attr("content")?.trim() ||
    "";

  // Headings
  const h1s = $("h1")
    .map((_, el) => $(el).text().trim())
    .get();
  const hasH1 = h1s.length > 0;

  const headingTags = ["h1", "h2", "h3", "h4", "h5", "h6"];
  const headingCounts = headingTags.map(
    (tag) => `${tag.toUpperCase()}:${$(tag).length}`
  );
  const headingStructure = hasH1
    ? headingCounts.filter((h) => !h.endsWith(":0")).join(" > ")
    : "Missing H1 | " + headingCounts.filter((h) => !h.endsWith(":0")).join(" > ");

  // Canonical
  const canonicalUrl = $('link[rel="canonical"]').attr("href") || "";

  // OG image
  const ogImage = $('meta[property="og:image"]').attr("content") || "";

  // Images
  const imageCount = $("img").length;

  // Interactive elements
  const { hasInteractive, interactiveType } = detectInteractiveElements($, pageUrl, title);

  // Links — normalize: strip query params and fragments for internal links
  const internalLinks: string[] = [];
  const externalLinks: string[] = [];

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    // Skip javascript:, mailto:, tel:, etc
    if (/^(javascript|mailto|tel|data|blob):/i.test(href)) return;

    try {
      const resolved = new URL(href, pageUrl);
      if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return;

      if (resolved.hostname === pageHost) {
        // For internal links: strip query params and fragments to normalize
        resolved.hash = "";
        resolved.search = "";
        const cleanUrl = resolved.toString();
        if (!internalLinks.includes(cleanUrl)) internalLinks.push(cleanUrl);
      } else {
        // For external links: strip fragments only, keep query (they might matter)
        resolved.hash = "";
        const cleanUrl = resolved.toString();
        if (!externalLinks.includes(cleanUrl)) externalLinks.push(cleanUrl);
      }
    } catch {
      // Malformed URL — skip
    }
  });

  return {
    title,
    metaDescription,
    hasH1,
    headingStructure,
    canonicalUrl,
    ogImage,
    imageCount,
    internalLinks,
    externalLinks,
    hasInteractiveElements: hasInteractive,
    interactiveType,
  };
}

// ─── Categorize HTTP status codes ────────────────────────────────────────────

function categorizeStatus(
  code: number
): "ok" | "redirect" | "client_error" | "server_error" | "unknown" {
  if (code >= 200 && code < 300) return "ok";
  if (code >= 300 && code < 400) return "redirect";
  if (code >= 400 && code < 500) return "client_error";
  if (code >= 500 && code < 600) return "server_error";
  return "unknown";
}

// ─── Scrape a single URL ─────────────────────────────────────────────────────

export async function scrapeUrl(
  url: string,
  enableAi: boolean
): Promise<PageQAResult> {
  const startTime = Date.now();

  const formats = ["markdown", "html", "screenshot"];
  if (enableAi) formats.push("json");

  const body: Record<string, unknown> = {
    url_to_scrape: url,
    formats,
  };

  if (enableAi) {
    body.llm_extract = LLM_EXTRACT_SCHEMA;
  }

  const res = await fetch(`${config.apiBase}/scrapes`, {
    method: "POST",
    headers: apiHeaders(),
    body: JSON.stringify(body),
  });

  const elapsed = Date.now() - startTime;

  if (!res.ok) {
    const errText = await res.text();
    console.warn(`   ⚠ Scrape failed for ${url} (${res.status}): ${errText.slice(0, 200)}`);
    return createFailedResult(url, res.status, elapsed);
  }

  const data = (await res.json()) as OlostepScrapeResult;
  const result = data.result || {};
  const meta = result.page_metadata;
  const statusCode = meta?.status_code || res.status;
  const htmlContent = result.html_content || "";
  const markdownContent = result.markdown_content || "";

  // Analyze HTML
  const htmlAnalysis = htmlContent
    ? analyzeHtml(htmlContent, url)
    : {
        title: meta?.title || "",
        metaDescription: meta?.description || "",
        hasH1: false,
        headingStructure: "No HTML returned",
        canonicalUrl: "",
        ogImage: "",
        imageCount: 0,
        internalLinks: [],
        externalLinks: [],
        hasInteractiveElements: false,
        interactiveType: "",
      };

  // Word count from markdown
  const words = markdownContent
    .replace(/[#*\[\]()_`>|-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);

  // Screenshot URL
  const screenshotUrl = (result as any).screenshot_hosted_url || "";

  // Soft error detection
  const title = htmlAnalysis.title || meta?.title || "";
  const softError = detectSoftError(title, markdownContent, words.length);

  // Parse AI analysis if present
  let ai: AIAnalysis | undefined;
  if (enableAi && result.json_content) {
    try {
      const parsed = JSON.parse(result.json_content);
      ai = {
        ui_score: Number(parsed.ui_score) || 0,
        ui_issues: String(parsed.ui_issues || "Unknown"),
        content_score: Number(parsed.content_score) || 0,
        content_issues: String(parsed.content_issues || "Unknown"),
        is_vibecoded: Boolean(parsed.is_vibecoded),
        missing_images: Boolean(parsed.missing_images),
        overall_verdict: (parsed.overall_verdict as "pass" | "warning" | "fail") || "warning",
      };
    } catch {
      // JSON parse failed — AI analysis not available
    }
  }

  return {
    url,
    statusCode,
    statusCategory: categorizeStatus(statusCode),
    isSoftError: softError.isSoftError,
    softErrorReason: softError.reason,
    title,
    metaDescription: htmlAnalysis.metaDescription,
    hasH1: htmlAnalysis.hasH1,
    headingStructure: htmlAnalysis.headingStructure,
    canonicalUrl: htmlAnalysis.canonicalUrl,
    ogImage: htmlAnalysis.ogImage,
    wordCount: words.length,
    contentPreview: markdownContent.slice(0, 300).replace(/\n/g, " ").trim(),
    screenshotUrl: screenshotUrl,
    imageCount: htmlAnalysis.imageCount,
    hasInteractiveElements: htmlAnalysis.hasInteractiveElements,
    interactiveType: htmlAnalysis.interactiveType,
    internalLinks: htmlAnalysis.internalLinks,
    externalLinks: htmlAnalysis.externalLinks,
    internalLinksCount: htmlAnalysis.internalLinks.length,
    externalLinksCount: htmlAnalysis.externalLinks.length,
    brokenLinksOnPage: [],
    brokenLinksCount: 0,
    ai,
    scrapeTimeMs: elapsed,
  };
}

function createFailedResult(url: string, statusCode: number, elapsed: number): PageQAResult {
  return {
    url,
    statusCode,
    statusCategory: categorizeStatus(statusCode),
    isSoftError: true,
    softErrorReason: `Scrape API returned ${statusCode}`,
    title: "",
    metaDescription: "",
    hasH1: false,
    headingStructure: "Failed to scrape",
    canonicalUrl: "",
    ogImage: "",
    wordCount: 0,
    contentPreview: "SCRAPE FAILED",
    screenshotUrl: "",
    imageCount: 0,
    hasInteractiveElements: false,
    interactiveType: "",
    internalLinks: [],
    externalLinks: [],
    internalLinksCount: 0,
    externalLinksCount: 0,
    brokenLinksOnPage: [],
    brokenLinksCount: 0,
    scrapeTimeMs: elapsed,
  };
}

// ─── Lite scrape (no screenshot — used for retry on timeout) ─────────────────

async function scrapeUrlLite(
  url: string,
  enableAi: boolean
): Promise<PageQAResult> {
  const startTime = Date.now();

  const formats = ["markdown", "html"];
  if (enableAi) formats.push("json");

  const body: Record<string, unknown> = {
    url_to_scrape: url,
    formats,
  };

  if (enableAi) {
    body.llm_extract = LLM_EXTRACT_SCHEMA;
  }

  const res = await fetch(`${config.apiBase}/scrapes`, {
    method: "POST",
    headers: apiHeaders(),
    body: JSON.stringify(body),
  });

  const elapsed = Date.now() - startTime;

  if (!res.ok) {
    return createFailedResult(url, res.status, elapsed);
  }

  const data = (await res.json()) as OlostepScrapeResult;
  const result = data.result || {};
  const meta = result.page_metadata;
  const statusCode = meta?.status_code || res.status;
  const htmlContent = result.html_content || "";
  const markdownContent = result.markdown_content || "";

  const htmlAnalysis = htmlContent
    ? analyzeHtml(htmlContent, url)
    : {
        title: meta?.title || "",
        metaDescription: meta?.description || "",
        hasH1: false,
        headingStructure: "No HTML returned",
        canonicalUrl: "",
        ogImage: "",
        imageCount: 0,
        internalLinks: [],
        externalLinks: [],
        hasInteractiveElements: false,
        interactiveType: "",
      };

  const words = markdownContent
    .replace(/[#*\[\]()_`>|-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);

  const title = htmlAnalysis.title || meta?.title || "";
  const softError = detectSoftError(title, markdownContent, words.length);

  let ai: AIAnalysis | undefined;
  if (enableAi && result.json_content) {
    try {
      const parsed = JSON.parse(result.json_content);
      ai = {
        ui_score: Number(parsed.ui_score) || 0,
        ui_issues: String(parsed.ui_issues || "Unknown"),
        content_score: Number(parsed.content_score) || 0,
        content_issues: String(parsed.content_issues || "Unknown"),
        is_vibecoded: Boolean(parsed.is_vibecoded),
        missing_images: Boolean(parsed.missing_images),
        overall_verdict: (parsed.overall_verdict as "pass" | "warning" | "fail") || "warning",
      };
    } catch {}
  }

  return {
    url,
    statusCode,
    statusCategory: categorizeStatus(statusCode),
    isSoftError: softError.isSoftError,
    softErrorReason: softError.reason,
    title,
    metaDescription: htmlAnalysis.metaDescription,
    hasH1: htmlAnalysis.hasH1,
    headingStructure: htmlAnalysis.headingStructure,
    canonicalUrl: htmlAnalysis.canonicalUrl,
    ogImage: htmlAnalysis.ogImage,
    wordCount: words.length,
    contentPreview: markdownContent.slice(0, 300).replace(/\n/g, " ").trim(),
    screenshotUrl: "(screenshot skipped - retry)",
    imageCount: htmlAnalysis.imageCount,
    hasInteractiveElements: htmlAnalysis.hasInteractiveElements,
    interactiveType: htmlAnalysis.interactiveType,
    internalLinks: htmlAnalysis.internalLinks,
    externalLinks: htmlAnalysis.externalLinks,
    internalLinksCount: htmlAnalysis.internalLinks.length,
    externalLinksCount: htmlAnalysis.externalLinks.length,
    brokenLinksOnPage: [],
    brokenLinksCount: 0,
    ai,
    scrapeTimeMs: elapsed,
  };
}

// ─── Scrape all URLs with concurrency control ────────────────────────────────

export async function scrapeAllUrls(
  urls: string[],
  enableAi: boolean,
  concurrency: number
): Promise<PageQAResult[]> {
  const pLimitModule = await import("p-limit");
  const pLimit = pLimitModule.default;
  const limit = pLimit(concurrency);

  console.log(
    `\n🔍 Phase 2: Scraping ${urls.length} URLs (concurrency: ${concurrency}, AI: ${enableAi ? "ON" : "OFF"})...\n`
  );

  const results: PageQAResult[] = [];
  let completed = 0;

  const tasks = urls.map((url) =>
    limit(async () => {
      await sleep(config.requestDelayMs);

      try {
        const result = await scrapeUrl(url, enableAi);
        completed++;

        const statusEmoji =
          result.isSoftError
            ? "🟡"
            : result.statusCategory === "ok"
            ? "✅"
            : result.statusCategory === "redirect"
            ? "↪️"
            : "❌";
        const softTag = result.isSoftError ? " [SOFT ERROR]" : "";
        console.log(
          `   ${statusEmoji} [${completed}/${urls.length}] ${result.statusCode} ${truncate(url, 70)} (${result.scrapeTimeMs}ms)${softTag}`
        );

        // Retry on timeout/failure without screenshot
        if (result.statusCode >= 500 || result.contentPreview === "SCRAPE FAILED") {
          console.log(`   🔄 Retrying ${truncate(url, 60)} without screenshot...`);
          await sleep(1000);
          const retry = await scrapeUrlLite(url, enableAi);
          if (retry.statusCategory === "ok" || retry.wordCount > 0) {
            console.log(`   ✅ Retry succeeded for ${truncate(url, 60)} (${retry.scrapeTimeMs}ms)`);
            results.push(retry);
            return retry;
          }
        }

        results.push(result);
        return result;
      } catch (err) {
        completed++;
        console.error(`   ❌ [${completed}/${urls.length}] Error scraping ${url}: ${err}`);
        const failed = createFailedResult(url, 0, 0);
        results.push(failed);
        return failed;
      }
    })
  );

  await Promise.all(tasks);

  const softErrors = results.filter((r) => r.isSoftError).length;
  console.log(
    `\n   ✅ Scraping complete: ${results.length} pages processed` +
      (softErrors > 0 ? ` (${softErrors} soft errors detected)` : "") +
      `\n`
  );
  return results;
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen - 3) + "..." : str;
}
