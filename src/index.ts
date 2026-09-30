/**
 * index.ts — Main CLI entry point for the Olostep Website QA Platform.
 *
 * Orchestrates the complete QA pipeline:
 *
 *   Phase 1: DISCOVER  → Maps API to find every URL on the site
 *   Phase 2: SCRAPE    → Scrape each URL for content, metadata, screenshots
 *   Phase 3: LINKS     → Check all discovered links for broken references
 *   Phase 4: REPORT    → Generate a detailed Excel spreadsheet
 *
 * Usage:
 *   npx tsx src/index.ts                              # Default run
 *   npx tsx src/index.ts --ai                         # With AI quality analysis
 *   npx tsx src/index.ts --url https://example.com    # Target a different site
 *   npx tsx src/index.ts --skip-link-check            # Skip external link checking
 *   npx tsx src/index.ts --concurrency 10             # More parallel requests
 *   npx tsx src/index.ts --max-pages 50               # Limit pages to scrape
 */

import { Command } from "commander";
import * as path from "path";
import * as fs from "fs";
import { config } from "./config";
import { discoverUrls, cleanAndFilterUrls } from "./discovery";
import { scrapeAllUrls } from "./scraper";
import { checkLinks } from "./link-checker";
import { generateReport } from "./report";
import type { CLIOptions, PageQAResult } from "./types";

// ─── CLI Setup ───────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("olostep-qa")
  .description("Automated QA platform for websites — powered by Olostep APIs")
  .version("1.0.0")
  .option("--url <url>", "Target website URL to QA", config.defaultUrl)
  .option("--ai", "Enable AI quality analysis via Olostep LLM extraction", false)
  .option("--skip-link-check", "Skip external link validation (saves credits)", false)
  .option("--output <name>", "Output directory name inside reports/", "")
  .option("--concurrency <number>", "Max parallel scrape requests", String(config.defaultConcurrency))
  .option("--max-pages <number>", "Max pages to scrape (0 = unlimited)", "0");

program.parse(process.argv);

const opts = program.opts();
const cliOptions: CLIOptions = {
  url: opts.url,
  ai: opts.ai,
  skipLinkCheck: opts.skipLinkCheck,
  output: opts.output,
  concurrency: parseInt(opts.concurrency, 10) || config.defaultConcurrency,
  maxPages: parseInt(opts.maxPages, 10) || 0,
};

// ─── Main Pipeline ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startTime = Date.now();

  printBanner(cliOptions);

  // Create timestamped output directory
  const timestamp = formatTimestamp();
  const outputDirName = cliOptions.output || `run-${timestamp}`;
  const outputDir = path.resolve(config.reportsDir, outputDirName);
  fs.mkdirSync(outputDir, { recursive: true });

  // ── Phase 1: Discover URLs ─────────────────────────────────────────────
  const allUrls = await discoverUrls(cliOptions.url);
  const filteredUrls = cleanAndFilterUrls(allUrls, cliOptions.url);

  console.log(`   Filtered to ${filteredUrls.length} URLs on ${new URL(cliOptions.url).hostname}`);

  const urlsFile = path.join(outputDir, "discovered-urls.txt");
  fs.writeFileSync(urlsFile, filteredUrls.join("\n"), "utf-8");
  console.log(`   Saved URL list to ${urlsFile}`);

  // Apply max pages limit
  let urlsToScrape = filteredUrls;
  if (cliOptions.maxPages > 0 && filteredUrls.length > cliOptions.maxPages) {
    urlsToScrape = filteredUrls.slice(0, cliOptions.maxPages);
    console.log(`   ⚠ Limited to ${cliOptions.maxPages} pages (${filteredUrls.length} total discovered)`);
  }

  // ── Phase 2: Scrape All URLs ───────────────────────────────────────────
  const results = await scrapeAllUrls(urlsToScrape, cliOptions.ai, cliOptions.concurrency);

  // ── Phase 3: Check Links ───────────────────────────────────────────────
  if (!cliOptions.skipLinkCheck) {
    await checkLinks(results, filteredUrls, cliOptions.concurrency);
  } else {
    console.log(`\n🔗 Phase 3: Link checking SKIPPED (--skip-link-check)\n`);
  }

  // Save raw results AFTER link checking so broken link data is included
  const jsonFile = path.join(outputDir, "raw-results.json");
  fs.writeFileSync(
    jsonFile,
    JSON.stringify(
      results.map((r) => ({
        ...r,
        // Replace arrays with counts to keep JSON manageable
        internalLinks: r.internalLinksCount,
        externalLinks: r.externalLinksCount,
        // Keep broken links as full objects
        brokenLinksOnPage: r.brokenLinksOnPage,
      })),
      null,
      2
    ),
    "utf-8"
  );
  console.log(`   Saved raw results to ${jsonFile}`);

  // ── Phase 4: Generate Report ───────────────────────────────────────────
  const reportPath = await generateReport(results, outputDir, cliOptions.ai);

  // ── Summary ────────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  printSummary(results, reportPath, elapsed);
}

// ─── Display Helpers ─────────────────────────────────────────────────────────

function printBanner(opts: CLIOptions): void {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║           🔍  OLOSTEP WEBSITE QA PLATFORM  🔍               ║
║                                                              ║
╠══════════════════════════════════════════════════════════════╣
║  Target:       ${padRight(opts.url, 43)}║
║  AI Analysis:  ${padRight(opts.ai ? "ENABLED (llm_extract)" : "DISABLED", 43)}║
║  Link Check:   ${padRight(opts.skipLinkCheck ? "SKIPPED" : "ENABLED", 43)}║
║  Concurrency:  ${padRight(String(opts.concurrency), 43)}║
║  Max Pages:    ${padRight(opts.maxPages > 0 ? String(opts.maxPages) : "Unlimited", 43)}║
╚══════════════════════════════════════════════════════════════╝
`);
}

function printSummary(
  results: PageQAResult[],
  reportPath: string,
  elapsed: string
): void {
  const healthy = results.filter((r) => r.statusCategory === "ok" && !r.isSoftError).length;
  const softErrors = results.filter((r) => r.isSoftError).length;
  const httpErrors = results.filter(
    (r) => r.statusCategory === "client_error" || r.statusCategory === "server_error"
  ).length;
  const broken = results.reduce((s, r) => s + r.brokenLinksCount, 0);
  const interactive = results.filter((r) => r.hasInteractiveElements).length;

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                     📋 QA RUN COMPLETE                      ║
╠══════════════════════════════════════════════════════════════╣
║  Pages scanned:      ${padRight(String(results.length), 38)}║
║  Healthy (2xx):      ${padRight(String(healthy), 38)}║
║  Soft Errors:        ${padRight(String(softErrors), 38)}║
║  HTTP Errors:        ${padRight(String(httpErrors), 38)}║
║  Broken links:       ${padRight(String(broken), 38)}║
║  Interactive pages:  ${padRight(String(interactive), 38)}║
║  Time elapsed:       ${padRight(elapsed + "s", 38)}║
║                                                              ║
║  Report: ${padRight(reportPath, 50)}║
╚══════════════════════════════════════════════════════════════╝
`);
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : str + " ".repeat(len - str.length);
}

function formatTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

// ─── Execute ─────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error("\n💥 Fatal error:", err);
  process.exit(1);
});
