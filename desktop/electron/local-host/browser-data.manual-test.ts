#!/usr/bin/env bun
/**
 * Manual Test Script for Browser Data Collection
 *
 * Run with: bun electron/local-host/browser-data.manual-test.ts
 *
 * This will:
 * 1. Detect your browser (Chrome → Edge → Brave)
 * 2. Copy the history database
 * 3. Run queries
 * 4. Print the results
 */

import path from "path";
import os from "os";
import { collectBrowserData, formatBrowserDataForSynthesis } from "./browser-data.js";

const main = async () => {
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║        Browser Data Collection - Manual Test               ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  console.log("Platform:", process.platform);
  console.log("Home:", os.homedir());

  // Use a temp directory for testing
  const testHome = path.join(os.tmpdir(), `stella-test-${Date.now()}`);
  console.log("Test home:", testHome);
  console.log("\n" + "─".repeat(60) + "\n");

  console.log("🔍 Searching for browser history...\n");

  const startTime = Date.now();
  const data = await collectBrowserData(testHome);
  const elapsed = Date.now() - startTime;

  console.log(`⏱️  Collection took ${elapsed}ms\n`);
  console.log("─".repeat(60) + "\n");

  if (!data.browser) {
    console.log("❌ No browser history found!");
    console.log("\nPossible reasons:");
    console.log("  - No Chrome/Edge/Brave installed");
    console.log("  - Browser history is empty");
    console.log("  - Permission denied to read history file");
    process.exit(1);
  }

  console.log(`✅ Found browser: ${data.browser.toUpperCase()}\n`);

  // Cluster domains
  console.log("📊 Cluster Domains (session-based groupings):");
  if (data.clusterDomains.length === 0) {
    console.log("   (none found - clusters table may not exist in your browser version)");
  } else {
    data.clusterDomains.slice(0, 15).forEach((d, i) => {
      console.log(`   ${i + 1}. ${d}`);
    });
    if (data.clusterDomains.length > 15) {
      console.log(`   ... and ${data.clusterDomains.length - 15} more`);
    }
  }

  console.log("\n" + "─".repeat(60) + "\n");

  // Recent domains
  console.log("📈 Most Active Domains (last 7 days):");
  if (data.recentDomains.length === 0) {
    console.log("   (none found)");
  } else {
    data.recentDomains.slice(0, 20).forEach((d, i) => {
      const bar = "█".repeat(Math.min(30, Math.ceil(d.visits / 10)));
      console.log(`   ${String(i + 1).padStart(2)}. ${d.domain.padEnd(35)} ${String(d.visits).padStart(5)} ${bar}`);
    });
    if (data.recentDomains.length > 20) {
      console.log(`   ... and ${data.recentDomains.length - 20} more`);
    }
  }

  console.log("\n" + "─".repeat(60) + "\n");

  // Domain details
  console.log("📝 Content Details (titles from interesting domains):");
  const domainCount = Object.keys(data.domainDetails).length;
  if (domainCount === 0) {
    console.log("   (no matching content found)");
  } else {
    for (const [domain, titles] of Object.entries(data.domainDetails)) {
      console.log(`\n   🔹 ${domain} (${titles.length} entries)`);
      titles.slice(0, 5).forEach((t) => {
        const truncatedTitle = t.title.length > 60 ? t.title.slice(0, 57) + "..." : t.title;
        console.log(`      - ${truncatedTitle} (${t.visitCount} visits)`);
      });
      if (titles.length > 5) {
        console.log(`      ... and ${titles.length - 5} more`);
      }
    }
  }

  console.log("\n" + "═".repeat(60) + "\n");

  // Formatted output (what gets sent to LLM)
  console.log("📄 Formatted Output (for LLM synthesis):\n");
  const formatted = formatBrowserDataForSynthesis(data);
  console.log(formatted);

  console.log("\n" + "═".repeat(60) + "\n");

  // Summary
  console.log("📊 Summary:");
  console.log(`   Browser:         ${data.browser}`);
  console.log(`   Cluster domains: ${data.clusterDomains.length}`);
  console.log(`   Recent domains:  ${data.recentDomains.length}`);
  console.log(`   Domain details:  ${domainCount} domains with ${Object.values(data.domainDetails).flat().length} entries`);
  console.log(`   Formatted size:  ${formatted.length} characters`);

  // Cleanup temp directory
  try {
    const { promises: fs } = await import("fs");
    await fs.rm(testHome, { recursive: true, force: true });
    console.log(`\n🧹 Cleaned up temp directory`);
  } catch {
    // Ignore cleanup errors
  }

  console.log("\n✅ Test complete!\n");
};

main().catch((error) => {
  console.error("❌ Error:", error);
  process.exit(1);
});
