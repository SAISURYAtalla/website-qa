# Olostep Website QA Platform

An automated QA platform that dogfoods [Olostep](https://www.olostep.com) APIs to monitor, audit, and quality-check every page on `www.olostep.com`. Outputs a detailed Excel spreadsheet with status codes, SEO metadata, content analysis, broken links, screenshots, and optional AI-powered quality scoring — all powered entirely by Olostep's own infrastructure.

---

## Table of Contents

- [Architecture](#architecture)
- [How It Works — End-to-End Flow](#how-it-works--end-to-end-flow)
- [Olostep APIs Used](#olostep-apis-used)
- [Project Structure](#project-structure)
- [Setup](#setup)
- [Usage](#usage)
- [CLI Options](#cli-options)
- [Output](#output)
- [Report Sheets Explained](#report-sheets-explained)
- [Two Modes of Operation](#two-modes-of-operation)
- [Credit Cost Estimation](#credit-cost-estimation)
- [Module Documentation](#module-documentation)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    OLOSTEP WEBSITE QA PLATFORM                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────────┐ │
│  │ Phase 1  │───▶│ Phase 2  │───▶│ Phase 3  │───▶│   Phase 4    │ │
│  │ DISCOVER │    │ SCRAPE   │    │ LINKS    │    │   REPORT     │ │
│  │          │    │          │    │          │    │              │ │
│  │ Maps API │    │Scrape API│    │Link Check│    │   ExcelJS    │ │
│  │ /v1/maps │    │/v1/scrape│    │(internal │    │              │ │
│  │          │    │          │    │+external)│    │  .xlsx file  │ │
│  └──────────┘    └──────────┘    └──────────┘    └──────────────┘ │
│       │               │               │               │           │
│       ▼               ▼               ▼               ▼           │
│   All URLs      Per-page data:   Broken link      Multi-sheet     │
│   on site       - Status code    inventory        Excel report    │
│                 - HTML content                    with colors     │
│                 - Markdown                        and hyperlinks  │
│                 - Screenshot                                      │
│                 - SEO metadata                                    │
│                 - AI analysis*                                    │
│                                                                     │
│  * AI analysis only when --ai flag is passed                       │
└─────────────────────────────────────────────────────────────────────┘
```

---

## How It Works — End-to-End Flow

### Phase 1: URL Discovery (Maps API)

```
POST https://api.olostep.com/v1/maps
Body: { "url": "https://www.olostep.com" }
```

- Calls the Olostep Maps API to enumerate **every URL** on the target website
- Discovers pages from sitemaps, internal links, and backlinks
- Handles cursor-based pagination for large sites (100k+ URLs per batch)
- Filters results to only the target domain
- Deduplicates and sorts the URL list
- Saves the full URL list to `discovered-urls.txt` in the output directory

### Phase 2: Page Scraping (Scrape API)

```
POST https://api.olostep.com/v1/scrapes
Body: {
  "url_to_scrape": "<each URL>",
  "formats": ["markdown", "html", "screenshot"]
}
```

For each discovered URL, calls the Olostep Scrape API to collect:

| Data Point | Source | Used For |
|-----------|--------|----------|
| `page_metadata.status_code` | Scrape response | HTTP health check |
| `page_metadata.title` | Scrape response | SEO audit |
| `html_content` | Scrape response | Link extraction, heading analysis, meta tags |
| `markdown_content` | Scrape response | Word count, content preview |
| `screenshot_hosted_url` | Scrape response | Visual reference in report |

**HTML analysis** (via Cheerio) extracts:
- Title tag
- Meta description (`<meta name="description">` and OG)
- H1 presence and full heading hierarchy (H1 > H2 > H3...)
- Canonical URL
- OG image
- All internal links (same domain)
- All external links (different domains)
- Image count

**Concurrency control**: Uses `p-limit` to run up to 5 parallel scrapes (configurable). Includes a 200ms delay between requests to avoid API burst.

**Retry logic**: If a scrape times out (common with screenshot on heavy pages), automatically retries without the screenshot format.

### Phase 2b: AI Analysis (Optional — `--ai` flag)

When `--ai` is passed, the scrape call includes an `llm_extract` parameter:

```json
{
  "url_to_scrape": "<URL>",
  "formats": ["markdown", "html", "screenshot", "json"],
  "llm_extract": {
    "schema": {
      "type": "object",
      "properties": {
        "ui_score": { "type": "number", "description": "1-10 UI quality rating" },
        "ui_issues": { "type": "string", "description": "Visual problems found" },
        "content_score": { "type": "number", "description": "1-10 content quality" },
        "content_issues": { "type": "string", "description": "Content problems" },
        "is_vibecoded": { "type": "boolean", "description": "Auto-generated look?" },
        "missing_images": { "type": "boolean", "description": "Broken images?" },
        "overall_verdict": { "type": "string", "description": "pass/warning/fail" }
      }
    }
  }
}
```

This piggybacks on the same scrape call — Olostep's built-in LLM analyzes the page content and returns structured quality scores. **No external API key needed.**

### Phase 3: Link Checking

Two-part link validation:

1. **Internal links**: Compare every discovered internal link against the set of successfully scraped URLs. If a link target wasn't found in our crawl results, it's flagged as broken.

2. **External links**: For each unique external URL found across all pages, make a lightweight scrape call to verify it returns a 200 status code. URLs returning 4xx/5xx are flagged.

Broken links are mapped back to their source pages.

### Phase 4: Report Generation

Generates a multi-sheet Excel workbook using ExcelJS:

- **Color-coded rows**: Green (2xx), Yellow (3xx), Red (4xx/5xx)
- **Clickable hyperlinks**: URLs and screenshot links are clickable
- **Auto-filters**: Column headers have dropdown filters for sorting
- **Conditional formatting**: Status-based coloring throughout

---

## Olostep APIs Used

| API | Endpoint | What It Does | Cost |
|-----|----------|-------------|------|
| **Maps** | `POST /v1/maps` | Discover all URLs on a website | 1 credit + 1 per extra 1000 URLs |
| **Scrape** | `POST /v1/scrapes` | Get page content, metadata, screenshots | 1 credit per page |
| **Scrape + LLM** | `POST /v1/scrapes` (with `llm_extract`) | AI quality analysis | ~2 credits per page |

---

## Project Structure

```
website-qa/
├── .env                    # OLOSTEP_API_KEY
├── package.json            # Dependencies and npm scripts
├── tsconfig.json           # TypeScript configuration
├── README.md               # This file
├── src/
│   ├── index.ts            # CLI entry point — orchestrates all 4 phases
│   ├── config.ts           # Loads .env, exports API config constants
│   ├── types.ts            # All TypeScript interfaces
│   ├── discovery.ts        # Phase 1: Maps API URL discovery
│   ├── scraper.ts          # Phase 2: Scrape API page analysis
│   ├── link-checker.ts     # Phase 3: Broken link detection
│   └── report.ts           # Phase 4: Excel report generation
└── reports/
    └── run-YYYY-MM-DD_HH-MM-SS/  # Timestamped output per run
        ├── discovered-urls.txt     # All URLs found by Maps API
        ├── raw-results.json        # Full JSON results (for debugging)
        └── qa-report-*.xlsx        # The Excel QA report
```

---

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Create .env (already done if you cloned this repo)
echo "OLOSTEP_API_KEY=your_api_key_here" > .env
```

---

## Usage

```bash
# Default run — full factual report of every page
npm run qa

# With AI quality analysis
npm run qa:ai

# Quick run — skip external link checking (saves credits)
npm run qa:quick

# Custom options
npx tsx src/index.ts --url https://www.olostep.com --max-pages 50 --concurrency 10
```

---

## CLI Options

| Flag | Default | Description |
|------|---------|-------------|
| `--url <url>` | `https://www.olostep.com` | Target website to QA |
| `--ai` | `false` | Enable AI quality analysis via Olostep LLM extraction |
| `--skip-link-check` | `false` | Skip external link validation (saves credits) |
| `--output <name>` | `run-<timestamp>` | Custom output directory name |
| `--concurrency <n>` | `5` | Max parallel scrape requests |
| `--max-pages <n>` | `0` (unlimited) | Limit number of pages to scrape |

---

## Output

Each run creates a timestamped directory inside `reports/`:

```
reports/run-2026-09-28_22-12-07/
├── discovered-urls.txt          # 580 URLs found
├── raw-results.json             # Full machine-readable results
└── qa-report-2026-09-28_22-13-12.xlsx  # Human-readable Excel report
```

---

## Report Sheets Explained

### Sheet 1: Summary
High-level dashboard with:
- Total pages scanned
- HTTP status distribution (2xx, 3xx, 4xx, 5xx)
- Broken link count
- Empty/thin page count
- Missing H1 and meta description counts
- If `--ai`: average UI/content scores, pass/warn/fail counts, vibecoded page count

### Sheet 2: All Pages
One row per page with every QA data point:
- URL (clickable hyperlink)
- Status code + category
- Title, meta description
- H1 presence, heading hierarchy
- Canonical URL
- Word count, content preview
- Screenshot link (clickable)
- Image count
- Internal/external link counts
- Broken link count
- Scrape time

Sorted by severity (errors first, then redirects, then OK). Color-coded green/yellow/red.

### Sheet 3: Broken Links
Every broken link found:
- Source page URL
- Broken target URL
- Status code (if available)
- Error description

### Sheet 4: Empty & Thin Pages
Pages with fewer than 50 words (likely broken, placeholder, or app-shell pages):
- URL, status code, word count
- Title, H1 presence
- Content preview
- Screenshot

### Sheet 5: AI Analysis (only with `--ai`)
Pages sorted by lowest UI score:
- UI score (1-10), UI issues description
- Content score (1-10), content issues description
- Vibecoded flag
- Missing images flag
- Overall verdict (PASS/WARNING/FAIL)
- Screenshot link

---

## Two Modes of Operation

### Default Mode (no `--ai`)
```bash
npx tsx src/index.ts
```
Pure factual report. Every page is scraped for content, metadata, and screenshots. Links are validated. No AI inference runs. **Lower credit cost.**

### AI Mode (`--ai`)
```bash
npx tsx src/index.ts --ai
```
Everything in default mode **plus** Olostep's built-in LLM analyzes each page for:
- **UI quality**: Layout, spacing, typography, responsiveness
- **Content quality**: Completeness, grammar, placeholder detection
- **Vibecoded detection**: Does it look auto-generated?
- **Missing images**: Broken image placeholders
- **Overall verdict**: pass / warning / fail

Uses `llm_extract` on the Scrape API — **no external API keys needed**.

---

## Credit Cost Estimation

Assuming ~580 pages on `www.olostep.com`:

| Mode | Phase | Credits |
|------|-------|---------|
| **Default** | Maps API | ~1 |
| | Scrape (580 pages) | ~580 |
| | External link check (~200 unique) | ~200 |
| | **Total** | **~780** |
| **AI Mode** | Maps API | ~1 |
| | Scrape + LLM (580 pages) | ~1,160 |
| | External link check (~200 unique) | ~200 |
| | **Total** | **~1,360** |
| **Quick** (`--skip-link-check`) | Maps + Scrape only | **~580** |

---

## Module Documentation

### `config.ts`
Loads `OLOSTEP_API_KEY` from `.env`, exports the `config` object with API base URL, default concurrency, polling intervals, and report directory paths. Also exports `apiHeaders()` helper for authenticated API calls.

### `types.ts`
Defines all TypeScript interfaces:
- `PageQAResult` — the main per-page result object (26 fields)
- `AIAnalysis` — AI quality scores and verdicts
- `BrokenLink` — broken link record with source/target
- `CLIOptions` — parsed CLI arguments
- `OlostepScrapeResult`, `OlostepMapResult`, `OlostepBatchResult` — API response shapes

### `discovery.ts`
- `discoverUrls(siteUrl)` — calls Maps API with cursor pagination
- `cleanAndFilterUrls(urls, baseDomain)` — filters to target domain, removes fragments, deduplicates

### `scraper.ts`
- `scrapeUrl(url, enableAi)` — scrapes one URL, parses HTML with Cheerio, returns `PageQAResult`
- `scrapeUrlLite(url, enableAi)` — retry variant without screenshot (for timeout recovery)
- `scrapeAllUrls(urls, enableAi, concurrency)` — orchestrates parallel scraping with p-limit
- `analyzeHtml(html, pageUrl)` — extracts SEO metadata, headings, links from HTML
- `LLM_EXTRACT_SCHEMA` — the JSON schema sent to Olostep's LLM for AI quality analysis

### `link-checker.ts`
- `checkLinks(results, concurrency)` — validates internal links against scraped URL set, checks external links via lightweight scrapes, maps broken links back to source pages

### `report.ts`
- `generateReport(results, outputDir, aiEnabled)` — builds the full Excel workbook
- `buildSummarySheet()` — aggregate stats dashboard
- `buildAllPagesSheet()` — detailed per-page rows with color coding
- `buildBrokenLinksSheet()` — broken link inventory
- `buildThinPagesSheet()` — pages with < 50 words
- `buildAIAnalysisSheet()` — AI quality scores (only with `--ai`)

### `index.ts`
CLI entry point using `commander`. Parses flags, runs all 4 phases in sequence, saves intermediate outputs (URLs list, raw JSON), and prints a summary banner.
