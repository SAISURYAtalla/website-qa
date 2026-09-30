/**
 * types.ts — Shared TypeScript interfaces for the QA platform.
 *
 * Every page that gets scraped produces a PageQAResult object which is
 * the single source of truth fed into the Excel report generator.
 */

// ─── Scrape API response shapes ──────────────────────────────────────────────

export interface OlostepPageMetadata {
  status_code: number;
  title?: string;
  description?: string;
  language?: string;
  url?: string;
}

export interface OlostepScrapeResult {
  id: string;
  object: string;
  result: {
    markdown_content?: string;
    markdown_hosted_url?: string;
    html_content?: string;
    html_hosted_url?: string;
    screenshot_url?: string;
    json_content?: string;
    page_metadata?: OlostepPageMetadata;
  };
}

// ─── Maps API response shapes ────────────────────────────────────────────────

export interface OlostepMapResult {
  id: string;
  object: string;
  urls: string[];
  cursor?: string;
}

// ─── Batch API response shapes ───────────────────────────────────────────────

export interface OlostepBatchItem {
  url: string;
  status: "success" | "failed";
  retrieve_id?: string;
  error?: { code: string; message: string };
}

export interface OlostepBatchResult {
  id: string;
  object: string;
  status: "in_progress" | "completed";
  items_total?: number;
  items_completed?: number;
}

// ─── AI analysis fields (populated only when --ai flag is used) ──────────────

export interface AIAnalysis {
  ui_score: number;
  ui_issues: string;
  content_score: number;
  content_issues: string;
  is_vibecoded: boolean;
  missing_images: boolean;
  overall_verdict: "pass" | "warning" | "fail";
}

// ─── Broken link record ──────────────────────────────────────────────────────

export interface BrokenLink {
  sourceUrl: string;
  targetUrl: string;
  statusCode: number | null;
  error?: string;
}

// ─── The main per-page QA result ─────────────────────────────────────────────

export interface PageQAResult {
  url: string;

  // HTTP health
  statusCode: number;
  statusCategory: "ok" | "redirect" | "client_error" | "server_error" | "unknown";

  // Soft error detection (HTTP 200 but content says 404/error)
  isSoftError: boolean;
  softErrorReason: string;

  // SEO / metadata
  title: string;
  metaDescription: string;
  hasH1: boolean;
  headingStructure: string;
  canonicalUrl: string;
  ogImage: string;

  // Content
  wordCount: number;
  contentPreview: string;

  // Assets
  screenshotUrl: string;
  imageCount: number;

  // Interactive functionality detection
  hasInteractiveElements: boolean;
  interactiveType: string;

  // Links
  internalLinks: string[];
  externalLinks: string[];
  internalLinksCount: number;
  externalLinksCount: number;

  // Broken links discovered on this page (filled after link-check phase)
  brokenLinksOnPage: BrokenLink[];
  brokenLinksCount: number;

  // AI analysis (only when --ai is passed)
  ai?: AIAnalysis;

  // Timing
  scrapeTimeMs: number;
}

// ─── CLI options ─────────────────────────────────────────────────────────────

export interface CLIOptions {
  url: string;
  ai: boolean;
  skipLinkCheck: boolean;
  output: string;
  concurrency: number;
  maxPages: number;
}
