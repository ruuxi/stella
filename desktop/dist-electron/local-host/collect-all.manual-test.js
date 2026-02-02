#!/usr/bin/env bun
/**
 * Manual Test Script for All User Signal Collection
 *
 * Run with: bun electron/local-host/collect-all.manual-test.ts
 *
 * This will collect:
 * 1. Browser history (visits, domains, content)
 * 2. Dev projects (git repos with recent activity)
 * 3. Shell history (command frequency, project paths, tools used)
 * 4. Apps (running + recently used with executable paths)
 */
import path from "path";
import os from "os";
import { collectAllUserSignals, formatAllSignalsForSynthesis } from "./collect-all.js";
const formatTimestamp = (ts) => {
    const now = Date.now();
    const diffMs = now - ts;
    const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
    if (diffDays === 0)
        return "today";
    if (diffDays === 1)
        return "yesterday";
    if (diffDays < 7)
        return `${diffDays}d ago`;
    if (diffDays < 30)
        return `${Math.floor(diffDays / 7)}w ago`;
    return `${Math.floor(diffDays / 30)}mo ago`;
};
/**
 * Estimate token count for text
 * Uses multiple heuristics and returns the average:
 * 1. ~4 characters per token (common for English)
 * 2. ~0.75 tokens per word (accounts for subword tokenization)
 * 3. Byte-pair estimation (chars/3.5 for mixed content)
 */
const estimateTokens = (text) => {
    const chars = text.length;
    const words = text.split(/\s+/).filter(w => w.length > 0).length;
    // Method 1: Character-based (~4 chars per token)
    const charBased = Math.ceil(chars / 4);
    // Method 2: Word-based (~1.3 tokens per word for English)
    const wordBased = Math.ceil(words * 1.3);
    // Method 3: Mixed content (URLs, paths, code = more tokens per char)
    // Use ~3.5 chars per token for technical content
    const technicalBased = Math.ceil(chars / 3.5);
    // Average the methods, weighted toward technical since this is dev data
    const estimated = Math.ceil((charBased + wordBased + technicalBased * 2) / 4);
    return {
        tokens: estimated,
        breakdown: `chars=${chars}, words=${words}, est=${estimated}`,
    };
};
const main = async () => {
    console.log("╔════════════════════════════════════════════════════════════╗");
    console.log("║        User Signal Collection - Manual Test                ║");
    console.log("╚════════════════════════════════════════════════════════════╝\n");
    console.log("Platform:", process.platform);
    console.log("Home:", os.homedir());
    // Use a temp directory for testing
    const testHome = path.join(os.tmpdir(), `stellar-test-${Date.now()}`);
    console.log("Test home:", testHome);
    console.log("\n" + "─".repeat(60) + "\n");
    console.log("🔍 Collecting all user signals...\n");
    const startTime = Date.now();
    const data = await collectAllUserSignals(testHome);
    const elapsed = Date.now() - startTime;
    console.log(`⏱️  Collection took ${elapsed}ms\n`);
    console.log("═".repeat(60) + "\n");
    // ---------------------------------------------------------------------------
    // Browser Data
    // ---------------------------------------------------------------------------
    console.log("🌐 BROWSER DATA");
    console.log("─".repeat(40));
    if (!data.browser.browser) {
        console.log("   ❌ No browser history found");
    }
    else {
        console.log(`   Browser: ${data.browser.browser.toUpperCase()}`);
        console.log(`   Recent domains: ${data.browser.recentDomains.length}`);
        console.log(`   All-time domains: ${data.browser.allTimeDomains.length}`);
        if (data.browser.recentDomains.length > 0) {
            console.log("\n   Top 10 Recent:");
            data.browser.recentDomains.slice(0, 10).forEach((d, i) => {
                console.log(`     ${String(i + 1).padStart(2)}. ${d.domain.padEnd(30)} (${d.visits})`);
            });
        }
    }
    console.log("\n" + "═".repeat(60) + "\n");
    // ---------------------------------------------------------------------------
    // Dev Projects
    // ---------------------------------------------------------------------------
    console.log("📁 DEV PROJECTS");
    console.log("─".repeat(40));
    if (data.devProjects.length === 0) {
        console.log("   ❌ No active projects found");
    }
    else {
        console.log(`   Found ${data.devProjects.length} active projects\n`);
        data.devProjects.slice(0, 15).forEach((p, i) => {
            const recency = formatTimestamp(p.lastActivity);
            console.log(`   ${String(i + 1).padStart(2)}. ${p.name.padEnd(25)} (${recency})`);
            console.log(`       ${p.path}`);
        });
        if (data.devProjects.length > 15) {
            console.log(`\n   ... and ${data.devProjects.length - 15} more`);
        }
    }
    console.log("\n" + "═".repeat(60) + "\n");
    // ---------------------------------------------------------------------------
    // Shell History
    // ---------------------------------------------------------------------------
    console.log("💻 SHELL HISTORY");
    console.log("─".repeat(40));
    if (data.shell.toolsUsed.length > 0) {
        console.log("\n   Dev Tools Used:");
        console.log(`   ${data.shell.toolsUsed.join(", ")}`);
    }
    if (data.shell.topCommands.length > 0) {
        console.log("\n   Top 15 Commands:");
        data.shell.topCommands.slice(0, 15).forEach((c, i) => {
            const bar = "█".repeat(Math.min(20, Math.ceil(c.count / 50)));
            console.log(`   ${String(i + 1).padStart(2)}. ${c.command.padEnd(15)} ${String(c.count).padStart(5)} ${bar}`);
        });
    }
    if (data.shell.projectPaths.length > 0) {
        console.log("\n   Working Directories (from cd commands):");
        data.shell.projectPaths.slice(0, 10).forEach((p, i) => {
            console.log(`   ${String(i + 1).padStart(2)}. ${p}`);
        });
        if (data.shell.projectPaths.length > 10) {
            console.log(`\n   ... and ${data.shell.projectPaths.length - 10} more`);
        }
    }
    console.log("\n" + "═".repeat(60) + "\n");
    // ---------------------------------------------------------------------------
    // Apps
    // ---------------------------------------------------------------------------
    console.log("📱 APPS (with executable paths)");
    console.log("─".repeat(40));
    const runningApps = data.apps.filter(a => a.source === "running");
    const recentApps = data.apps.filter(a => a.source === "recent");
    if (runningApps.length > 0) {
        console.log(`\n   Currently Running (${runningApps.length}):`);
        runningApps.slice(0, 15).forEach((a, i) => {
            console.log(`   ${String(i + 1).padStart(2)}. ${a.name}`);
            if (a.executablePath) {
                console.log(`       → ${a.executablePath}`);
            }
        });
        if (runningApps.length > 15) {
            console.log(`\n   ... and ${runningApps.length - 15} more running`);
        }
    }
    if (recentApps.length > 0) {
        console.log(`\n   Recently Used (${recentApps.length}):`);
        recentApps.slice(0, 10).forEach((a, i) => {
            const recency = a.lastUsed ? formatTimestamp(a.lastUsed) : "";
            console.log(`   ${String(i + 1).padStart(2)}. ${a.name} ${recency ? `(${recency})` : ""}`);
            if (a.executablePath) {
                console.log(`       → ${a.executablePath}`);
            }
        });
    }
    if (runningApps.length === 0 && recentApps.length === 0) {
        console.log("   ❌ No apps discovered");
    }
    console.log("\n" + "═".repeat(60) + "\n");
    // ---------------------------------------------------------------------------
    // Formatted Output (for LLM)
    // ---------------------------------------------------------------------------
    console.log("📄 FORMATTED OUTPUT (for LLM synthesis)");
    console.log("─".repeat(40) + "\n");
    const formatted = formatAllSignalsForSynthesis(data);
    console.log(formatted);
    console.log("\n" + "═".repeat(60) + "\n");
    // ---------------------------------------------------------------------------
    // Summary
    // ---------------------------------------------------------------------------
    const tokenEst = estimateTokens(formatted);
    console.log("📊 SUMMARY");
    console.log("─".repeat(40));
    console.log(`   Browser:         ${data.browser.browser || "none"}`);
    console.log(`   Recent domains:  ${data.browser.recentDomains.length}`);
    console.log(`   Dev projects:    ${data.devProjects.length}`);
    console.log(`   Shell commands:  ${data.shell.topCommands.length}`);
    console.log(`   Tools used:      ${data.shell.toolsUsed.length}`);
    console.log(`   Running apps:    ${runningApps.length}`);
    console.log(`   Recent apps:     ${recentApps.length}`);
    console.log(`   Formatted size:  ${formatted.length} characters`);
    console.log(`   Est. tokens:     ~${tokenEst.tokens} tokens`);
    console.log(`   Token breakdown: ${tokenEst.breakdown}`);
    console.log(`   Collection time: ${elapsed}ms`);
    // Cleanup temp directory
    try {
        const { promises: fs } = await import("fs");
        await fs.rm(testHome, { recursive: true, force: true });
        console.log(`\n🧹 Cleaned up temp directory`);
    }
    catch {
        // Ignore cleanup errors
    }
    console.log("\n✅ Test complete!\n");
};
main().catch((error) => {
    console.error("❌ Error:", error);
    process.exit(1);
});
