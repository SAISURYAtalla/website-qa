/**
 * report.ts — Phase 4: Generate the Excel QA report.
 *
 * Builds a multi-sheet Excel workbook with:
 *
 *   Sheet 1: "Summary"         — Aggregate stats, pass/warn/fail counts
 *   Sheet 2: "All Pages"       — One row per page, every QA field
 *   Sheet 3: "Soft Errors"     — Pages returning 200 but showing error content
 *   Sheet 4: "Broken Links"    — Every broken link with source and target
 *   Sheet 5: "Empty/Thin"      — Pages with low word count (< 50 words)
 *   Sheet 6: "Interactive"     — Pages with forms/tools that need manual testing
 *   Sheet 7: "AI Analysis"     — (only with --ai) Sorted by score with verdicts
 *
 * Color coding:
 *   Green  — 2xx status, pass verdict
 *   Yellow — 3xx status, warning verdict, soft errors
 *   Red    — 4xx/5xx status, fail verdict
 *   Orange — Soft errors (200 but broken content)
 */

import ExcelJS from "exceljs";
import * as path from "path";
import * as fs from "fs";
import type { PageQAResult, BrokenLink } from "./types";

// ─── Color constants ─────────────────────────────────────────────────────────

const COLORS = {
  green: "FF27AE60",
  yellow: "FFF39C12",
  orange: "FFE67E22",
  red: "FFE74C3C",
  lightGreen: "FFE8F8E8",
  lightYellow: "FFFFF8E1",
  lightOrange: "FFFDEBD0",
  lightRed: "FFFDE8E8",
  lightBlue: "FFEAF2F8",
  lightPurple: "FFF4ECF7",
  headerBg: "FF2C3E50",
  headerFont: "FFFFFFFF",
  gray: "FF95A5A6",
};

// ─── Main export function ────────────────────────────────────────────────────

export async function generateReport(
  results: PageQAResult[],
  outputDir: string,
  aiEnabled: boolean
): Promise<string> {
  console.log(`\n📊 Phase 4: Generating Excel report...\n`);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Olostep Website QA";
  workbook.created = new Date();

  buildSummarySheet(workbook, results, aiEnabled);
  buildAllPagesSheet(workbook, results);
  buildSoftErrorsSheet(workbook, results);
  buildBrokenLinksSheet(workbook, results);
  buildThinPagesSheet(workbook, results);
  buildInteractiveSheet(workbook, results);

  if (aiEnabled) {
    buildAIAnalysisSheet(workbook, results);
  }

  fs.mkdirSync(outputDir, { recursive: true });

  const filename = `qa-report-${formatTimestamp()}.xlsx`;
  const filepath = path.join(outputDir, filename);

  await workbook.xlsx.writeFile(filepath);
  console.log(`   ✅ Report saved: ${filepath}\n`);

  return filepath;
}

// ─── Sheet 1: Summary ────────────────────────────────────────────────────────

function buildSummarySheet(
  workbook: ExcelJS.Workbook,
  results: PageQAResult[],
  aiEnabled: boolean
): void {
  const sheet = workbook.addWorksheet("Summary", {
    properties: { tabColor: { argb: COLORS.green } },
  });

  // Title
  sheet.mergeCells("A1:D1");
  const titleCell = sheet.getCell("A1");
  titleCell.value = "Olostep Website QA Report";
  titleCell.font = { size: 18, bold: true, color: { argb: COLORS.headerBg } };
  titleCell.alignment = { horizontal: "center" };

  sheet.mergeCells("A2:D2");
  const dateCell = sheet.getCell("A2");
  dateCell.value = `Generated: ${new Date().toISOString()}`;
  dateCell.font = { size: 11, italic: true, color: { argb: COLORS.gray } };
  dateCell.alignment = { horizontal: "center" };

  sheet.mergeCells("A3:D3");
  const modeCell = sheet.getCell("A3");
  modeCell.value = `Mode: ${aiEnabled ? "Full QA with AI Analysis" : "Factual Report (no AI)"}`;
  modeCell.font = { size: 11, color: { argb: COLORS.gray } };
  modeCell.alignment = { horizontal: "center" };

  // Stats
  const ok = results.filter((r) => r.statusCategory === "ok" && !r.isSoftError).length;
  const softErrors = results.filter((r) => r.isSoftError).length;
  const redirects = results.filter((r) => r.statusCategory === "redirect").length;
  const clientErrors = results.filter((r) => r.statusCategory === "client_error").length;
  const serverErrors = results.filter((r) => r.statusCategory === "server_error").length;
  const totalBroken = results.reduce((sum, r) => sum + r.brokenLinksCount, 0);
  const emptyPages = results.filter((r) => r.wordCount < 50 && r.statusCategory === "ok").length;
  const missingH1 = results.filter((r) => !r.hasH1 && r.statusCategory === "ok" && !r.isSoftError).length;
  const missingMeta = results.filter(
    (r) => !r.metaDescription && r.statusCategory === "ok" && !r.isSoftError
  ).length;
  const interactive = results.filter((r) => r.hasInteractiveElements).length;

  const stats: (string | number)[][] = [
    ["Metric", "Count", "Percentage", "Status"],
    ["Total Pages Scanned", results.length, "100%", "—"],
    ["", "", "", ""],
    ["HTTP STATUS", "", "", ""],
    ["✅ Healthy (2xx, no soft errors)", ok, pct(ok, results.length), "Good"],
    ["🟡 Soft Errors (200 but broken content)", softErrors, pct(softErrors, results.length), softErrors > 0 ? "Fix" : "Good"],
    ["↪️ Redirects (3xx)", redirects, pct(redirects, results.length), redirects > 0 ? "Review" : "Good"],
    ["❌ Client Errors (4xx)", clientErrors, pct(clientErrors, results.length), clientErrors > 0 ? "Fix" : "Good"],
    ["💥 Server Errors (5xx)", serverErrors, pct(serverErrors, results.length), serverErrors > 0 ? "Critical" : "Good"],
    ["", "", "", ""],
    ["CONTENT QUALITY", "", "", ""],
    ["📄 Empty/Thin Pages (<50 words)", emptyPages, pct(emptyPages, results.length), emptyPages > 0 ? "Review" : "Good"],
    ["🏷️ Missing H1 Tag", missingH1, pct(missingH1, results.length), missingH1 > 0 ? "Review" : "Good"],
    ["📝 Missing Meta Description", missingMeta, pct(missingMeta, results.length), missingMeta > 0 ? "Review" : "Good"],
    ["", "", "", ""],
    ["LINKS", "", "", ""],
    ["🔗 Broken Links (total references)", totalBroken, "—", totalBroken > 0 ? "Fix" : "Good"],
    ["", "", "", ""],
    ["FUNCTIONALITY", "", "", ""],
    ["🛠️ Interactive Pages (need manual QA)", interactive, pct(interactive, results.length), "Review"],
  ];

  if (aiEnabled) {
    const aiResults = results.filter((r) => r.ai);
    const aiPass = aiResults.filter((r) => r.ai?.overall_verdict === "pass").length;
    const aiWarn = aiResults.filter((r) => r.ai?.overall_verdict === "warning").length;
    const aiFail = aiResults.filter((r) => r.ai?.overall_verdict === "fail").length;
    const vibecoded = aiResults.filter((r) => r.ai?.is_vibecoded).length;
    const avgUi = aiResults.length > 0
      ? (aiResults.reduce((s, r) => s + (r.ai?.ui_score || 0), 0) / aiResults.length).toFixed(1)
      : "N/A";
    const avgContent = aiResults.length > 0
      ? (aiResults.reduce((s, r) => s + (r.ai?.content_score || 0), 0) / aiResults.length).toFixed(1)
      : "N/A";

    stats.push(
      ["", "", "", ""],
      ["AI ANALYSIS", "", "", ""],
      ["🤖 AI Pass", aiPass, pct(aiPass, aiResults.length), "Good"],
      ["⚠️ AI Warning", aiWarn, pct(aiWarn, aiResults.length), aiWarn > 0 ? "Review" : "Good"],
      ["🚨 AI Fail", aiFail, pct(aiFail, aiResults.length), aiFail > 0 ? "Fix" : "Good"],
      ["🎨 Avg UI Score", avgUi as string, "/10", "—"],
      ["📖 Avg Content Score", avgContent as string, "/10", "—"],
      ["🤖 Vibecoded Pages", vibecoded, pct(vibecoded, aiResults.length), vibecoded > 0 ? "Review" : "Good"],
    );
  }

  let row = 5;
  for (const stat of stats) {
    const excelRow = sheet.getRow(row);
    stat.forEach((val, col) => {
      excelRow.getCell(col + 1).value = val as string | number;
    });

    if (row === 5) {
      styleHeaderRow(excelRow, 4);
    } else if (typeof stat[3] === "string") {
      const statusCell = excelRow.getCell(4);
      if (stat[3] === "Fix" || stat[3] === "Critical") {
        statusCell.font = { bold: true, color: { argb: COLORS.red } };
      } else if (stat[3] === "Review") {
        statusCell.font = { bold: true, color: { argb: COLORS.yellow } };
      } else if (stat[3] === "Good") {
        statusCell.font = { color: { argb: COLORS.green } };
      }
    }
    row++;
  }

  sheet.columns = [
    { width: 42 },
    { width: 15 },
    { width: 15 },
    { width: 12 },
  ];
}

// ─── Sheet 2: All Pages ──────────────────────────────────────────────────────

function buildAllPagesSheet(workbook: ExcelJS.Workbook, results: PageQAResult[]): void {
  const sheet = workbook.addWorksheet("All Pages", {
    properties: { tabColor: { argb: COLORS.headerBg } },
  });

  const columns = [
    { header: "URL", key: "url", width: 55 },
    { header: "Status Code", key: "statusCode", width: 14 },
    { header: "Status", key: "statusCategory", width: 14 },
    { header: "Soft Error?", key: "softError", width: 14 },
    { header: "Title", key: "title", width: 40 },
    { header: "Meta Description", key: "metaDescription", width: 45 },
    { header: "Has H1?", key: "hasH1", width: 10 },
    { header: "Heading Structure", key: "headingStructure", width: 30 },
    { header: "Word Count", key: "wordCount", width: 13 },
    { header: "Content Preview", key: "contentPreview", width: 60 },
    { header: "Screenshot", key: "screenshotUrl", width: 55 },
    { header: "Interactive?", key: "interactive", width: 30 },
    { header: "Internal Links", key: "internalLinksCount", width: 15 },
    { header: "External Links", key: "externalLinksCount", width: 15 },
    { header: "Broken Links", key: "brokenLinksCount", width: 14 },
    { header: "Scrape Time (ms)", key: "scrapeTimeMs", width: 16 },
  ];

  sheet.columns = columns;
  styleHeaderRow(sheet.getRow(1), columns.length);

  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: columns.length },
  };

  // Sort: soft errors & real errors first, then by URL
  const sorted = [...results].sort((a, b) => {
    const priority = (r: PageQAResult): number => {
      if (r.statusCategory === "server_error") return 0;
      if (r.statusCategory === "client_error") return 1;
      if (r.isSoftError) return 2;
      if (r.statusCategory === "redirect") return 3;
      return 4;
    };
    const pa = priority(a);
    const pb = priority(b);
    if (pa !== pb) return pa - pb;
    return a.url.localeCompare(b.url);
  });

  for (const page of sorted) {
    const row = sheet.addRow({
      url: page.url,
      statusCode: page.statusCode,
      statusCategory: page.statusCategory.toUpperCase(),
      softError: page.isSoftError ? `YES: ${page.softErrorReason.slice(0, 50)}` : "No",
      title: page.title,
      metaDescription: page.metaDescription,
      hasH1: page.hasH1 ? "Yes" : "No",
      headingStructure: page.headingStructure,
      wordCount: page.wordCount,
      contentPreview: page.contentPreview,
      screenshotUrl: page.screenshotUrl,
      interactive: page.hasInteractiveElements ? page.interactiveType : "",
      internalLinksCount: page.internalLinksCount,
      externalLinksCount: page.externalLinksCount,
      brokenLinksCount: page.brokenLinksCount,
      scrapeTimeMs: page.scrapeTimeMs,
    });

    // Color-code based on status
    const bgColor = page.isSoftError
      ? COLORS.lightOrange
      : page.statusCategory === "ok"
      ? COLORS.lightGreen
      : page.statusCategory === "redirect"
      ? COLORS.lightYellow
      : COLORS.lightRed;

    row.eachCell((cell) => {
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: bgColor },
      };
    });

    // Clickable URL
    const urlCell = row.getCell(1);
    urlCell.value = { text: page.url, hyperlink: page.url } as ExcelJS.CellHyperlinkValue;
    urlCell.font = { color: { argb: "FF2980B9" }, underline: true };

    // Clickable screenshot
    if (page.screenshotUrl && !page.screenshotUrl.startsWith("(")) {
      const ssCell = row.getCell(11);
      ssCell.value = { text: "View Screenshot", hyperlink: page.screenshotUrl } as ExcelJS.CellHyperlinkValue;
      ssCell.font = { color: { argb: "FF2980B9" }, underline: true };
    }
  }
}

// ─── Sheet 3: Soft Errors ────────────────────────────────────────────────────

function buildSoftErrorsSheet(workbook: ExcelJS.Workbook, results: PageQAResult[]): void {
  const sheet = workbook.addWorksheet("Soft Errors", {
    properties: { tabColor: { argb: COLORS.orange } },
  });

  sheet.columns = [
    { header: "URL", key: "url", width: 55 },
    { header: "HTTP Status", key: "statusCode", width: 14 },
    { header: "Reason", key: "reason", width: 55 },
    { header: "Title", key: "title", width: 40 },
    { header: "Word Count", key: "wordCount", width: 13 },
    { header: "Content Preview", key: "contentPreview", width: 60 },
    { header: "Screenshot", key: "screenshotUrl", width: 50 },
  ];

  styleHeaderRow(sheet.getRow(1), 7);

  const softErrors = results
    .filter((r) => r.isSoftError)
    .sort((a, b) => a.wordCount - b.wordCount);

  for (const page of softErrors) {
    const row = sheet.addRow({
      url: page.url,
      statusCode: page.statusCode,
      reason: page.softErrorReason,
      title: page.title || "(no title)",
      wordCount: page.wordCount,
      contentPreview: page.contentPreview || "(empty)",
      screenshotUrl: page.screenshotUrl,
    });

    row.eachCell((cell) => {
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: COLORS.lightOrange },
      };
    });

    const urlCell = row.getCell(1);
    urlCell.value = { text: page.url, hyperlink: page.url } as ExcelJS.CellHyperlinkValue;
    urlCell.font = { color: { argb: "FF2980B9" }, underline: true };
  }

  if (softErrors.length === 0) {
    const row = sheet.addRow({
      url: "No soft errors found! All 200 pages have real content. 🎉",
    });
    row.getCell(1).font = { bold: true, color: { argb: COLORS.green } };
  }
}

// ─── Sheet 4: Broken Links ───────────────────────────────────────────────────

function buildBrokenLinksSheet(workbook: ExcelJS.Workbook, results: PageQAResult[]): void {
  const sheet = workbook.addWorksheet("Broken Links", {
    properties: { tabColor: { argb: COLORS.red } },
  });

  sheet.columns = [
    { header: "Source Page", key: "sourceUrl", width: 55 },
    { header: "Broken Link", key: "targetUrl", width: 55 },
    { header: "Status Code", key: "statusCode", width: 14 },
    { header: "Error", key: "error", width: 40 },
  ];

  styleHeaderRow(sheet.getRow(1), 4);

  // Collect and deduplicate broken links
  const allBroken: BrokenLink[] = [];
  const seen = new Set<string>();
  for (const page of results) {
    for (const link of page.brokenLinksOnPage) {
      const key = `${link.sourceUrl}|${link.targetUrl}`;
      if (seen.has(key)) continue;
      seen.add(key);
      allBroken.push(link);
    }
  }

  for (const link of allBroken) {
    const row = sheet.addRow({
      sourceUrl: link.sourceUrl,
      targetUrl: link.targetUrl,
      statusCode: link.statusCode ?? "N/A",
      error: link.error || "",
    });

    row.eachCell((cell) => {
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: COLORS.lightRed },
      };
    });
  }

  if (allBroken.length === 0) {
    const row = sheet.addRow({
      sourceUrl: "No broken links found! 🎉",
    });
    row.getCell(1).font = { bold: true, color: { argb: COLORS.green } };
  }
}

// ─── Sheet 5: Empty/Thin Pages ───────────────────────────────────────────────

function buildThinPagesSheet(workbook: ExcelJS.Workbook, results: PageQAResult[]): void {
  const sheet = workbook.addWorksheet("Empty & Thin Pages", {
    properties: { tabColor: { argb: COLORS.yellow } },
  });

  sheet.columns = [
    { header: "URL", key: "url", width: 55 },
    { header: "Status Code", key: "statusCode", width: 14 },
    { header: "Word Count", key: "wordCount", width: 14 },
    { header: "Title", key: "title", width: 40 },
    { header: "Has H1?", key: "hasH1", width: 10 },
    { header: "Content Preview", key: "contentPreview", width: 60 },
    { header: "Screenshot", key: "screenshotUrl", width: 50 },
  ];

  styleHeaderRow(sheet.getRow(1), 7);

  // Thin pages that aren't already flagged as soft errors
  const thin = results
    .filter((r) => r.wordCount < 50 && r.statusCategory === "ok" && !r.isSoftError)
    .sort((a, b) => a.wordCount - b.wordCount);

  for (const page of thin) {
    const row = sheet.addRow({
      url: page.url,
      statusCode: page.statusCode,
      wordCount: page.wordCount,
      title: page.title,
      hasH1: page.hasH1 ? "Yes" : "No",
      contentPreview: page.contentPreview || "(empty)",
      screenshotUrl: page.screenshotUrl,
    });

    row.eachCell((cell) => {
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: COLORS.lightYellow },
      };
    });

    const urlCell = row.getCell(1);
    urlCell.value = { text: page.url, hyperlink: page.url } as ExcelJS.CellHyperlinkValue;
    urlCell.font = { color: { argb: "FF2980B9" }, underline: true };
  }

  if (thin.length === 0) {
    const row = sheet.addRow({
      url: "No thin pages found (that aren't already flagged as soft errors)! 🎉",
    });
    row.getCell(1).font = { bold: true, color: { argb: COLORS.green } };
  }
}

// ─── Sheet 6: Interactive Pages ──────────────────────────────────────────────

function buildInteractiveSheet(workbook: ExcelJS.Workbook, results: PageQAResult[]): void {
  const sheet = workbook.addWorksheet("Interactive Pages", {
    properties: { tabColor: { argb: "FF3498DB" } },
  });

  sheet.columns = [
    { header: "URL", key: "url", width: 55 },
    { header: "Interactive Elements", key: "interactiveType", width: 45 },
    { header: "Title", key: "title", width: 45 },
    { header: "Status", key: "statusCode", width: 12 },
    { header: "Soft Error?", key: "softError", width: 14 },
    { header: "Screenshot", key: "screenshotUrl", width: 50 },
    { header: "Manual QA Notes", key: "notes", width: 40 },
  ];

  styleHeaderRow(sheet.getRow(1), 7);

  const interactive = results
    .filter((r) => r.hasInteractiveElements)
    .sort((a, b) => a.url.localeCompare(b.url));

  for (const page of interactive) {
    const row = sheet.addRow({
      url: page.url,
      interactiveType: page.interactiveType,
      title: page.title,
      statusCode: page.statusCode,
      softError: page.isSoftError ? "YES" : "No",
      screenshotUrl: page.screenshotUrl,
      notes: "", // Empty column for manual QA notes
    });

    const bgColor = page.isSoftError ? COLORS.lightOrange : COLORS.lightBlue;
    row.eachCell((cell) => {
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: bgColor },
      };
    });

    const urlCell = row.getCell(1);
    urlCell.value = { text: page.url, hyperlink: page.url } as ExcelJS.CellHyperlinkValue;
    urlCell.font = { color: { argb: "FF2980B9" }, underline: true };
  }
}

// ─── Sheet 7: AI Analysis (only with --ai) ──────────────────────────────────

function buildAIAnalysisSheet(workbook: ExcelJS.Workbook, results: PageQAResult[]): void {
  const sheet = workbook.addWorksheet("AI Analysis", {
    properties: { tabColor: { argb: "FF9B59B6" } },
  });

  sheet.columns = [
    { header: "URL", key: "url", width: 55 },
    { header: "UI Score", key: "uiScore", width: 12 },
    { header: "UI Issues", key: "uiIssues", width: 50 },
    { header: "Content Score", key: "contentScore", width: 15 },
    { header: "Content Issues", key: "contentIssues", width: 50 },
    { header: "Vibecoded?", key: "isVibecoded", width: 13 },
    { header: "Missing Images?", key: "missingImages", width: 16 },
    { header: "Verdict", key: "verdict", width: 12 },
    { header: "Screenshot", key: "screenshotUrl", width: 50 },
  ];

  styleHeaderRow(sheet.getRow(1), 9);

  // Sort by worst first: fail → warning → pass, then by lowest UI score
  const withAi = results
    .filter((r) => r.ai)
    .sort((a, b) => {
      const verdictOrder: Record<string, number> = { fail: 0, warning: 1, pass: 2 };
      const va = verdictOrder[a.ai?.overall_verdict || "pass"] ?? 2;
      const vb = verdictOrder[b.ai?.overall_verdict || "pass"] ?? 2;
      if (va !== vb) return va - vb;
      return (a.ai?.ui_score || 0) - (b.ai?.ui_score || 0);
    });

  for (const page of withAi) {
    const ai = page.ai!;
    const row = sheet.addRow({
      url: page.url,
      uiScore: ai.ui_score,
      uiIssues: ai.ui_issues,
      contentScore: ai.content_score,
      contentIssues: ai.content_issues,
      isVibecoded: ai.is_vibecoded ? "Yes ⚠️" : "No",
      missingImages: ai.missing_images ? "Yes ⚠️" : "No",
      verdict: ai.overall_verdict.toUpperCase(),
      screenshotUrl: page.screenshotUrl,
    });

    const bgColor =
      ai.overall_verdict === "pass"
        ? COLORS.lightGreen
        : ai.overall_verdict === "warning"
        ? COLORS.lightYellow
        : COLORS.lightRed;

    row.eachCell((cell) => {
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: bgColor },
      };
    });

    const urlCell = row.getCell(1);
    urlCell.value = { text: page.url, hyperlink: page.url } as ExcelJS.CellHyperlinkValue;
    urlCell.font = { color: { argb: "FF2980B9" }, underline: true };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function styleHeaderRow(row: ExcelJS.Row, numCols: number): void {
  for (let i = 1; i <= numCols; i++) {
    const cell = row.getCell(i);
    cell.font = { bold: true, color: { argb: COLORS.headerFont }, size: 11 };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: COLORS.headerBg },
    };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = {
      bottom: { style: "thin", color: { argb: COLORS.gray } },
    };
  }
  row.height = 24;
}

function pct(count: number, total: number): string {
  if (total === 0) return "0%";
  return `${((count / total) * 100).toFixed(1)}%`;
}

function formatTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}
