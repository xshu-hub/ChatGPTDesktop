#!/usr/bin/env node
/**
 * Run all patch scripts in sequence with structured status reporting.
 *
 * Each patch script MUST output exactly one PATCH_RESULT line:
 *   PATCH_RESULT: APPLIED [details]
 *   PATCH_RESULT: ALREADY_PATCHED [details]
 *   PATCH_RESULT: NOT_APPLICABLE [details]
 *   PATCH_RESULT: ABSENT [details]
 *   PATCH_RESULT: FAILED [details]
 *
 * No legacy inference — missing or invalid PATCH_RESULT → FAILED.
 *
 * Exit code: non-zero if any REQUIRED patch is ABSENT, FAILED, or MISSING.
 *
 * Usage:
 *   node scripts/patch-all.js [platform]         # Apply
 *   node scripts/patch-all.js [platform] --check  # Dry-run
 */
const { execFileSync } = require("child_process");
const path = require("path");

const VALID_STATUSES = ["APPLIED", "ALREADY_PATCHED", "NOT_APPLICABLE", "ABSENT", "FAILED"];

// Patches that MUST succeed (ABSENT, FAILED, or MISSING → build fails)
// NOT_APPLICABLE is only allowed for patches with explicit platform guards.
const REQUIRED = new Set([
  "patch-i18n.js",
  "patch-devtools.js",
  "patch-fast-mode.js",
  "patch-plugin-auth.js",
  "patch-updater.js",
  "patch-archive-delete.js",
  "patch-sunset.js",
  "patch-multi-agent.js",
]);

// Patches where NOT_APPLICABLE is a valid outcome on any platform
const ALLOWS_NOT_APPLICABLE = new Set([
  "patch-gpu.js", // only applies to macOS x64
]);

const PATCHES = [
  "patch-i18n.js",
  "patch-copyright.js",
  "patch-devtools.js",
  "patch-fast-mode.js",
  "patch-plugin-auth.js",
  "patch-updater.js",
  "patch-archive-delete.js",
  "patch-sunset.js",
  "patch-gpu.js",
  "patch-multi-agent.js",
];

// Patches that already output native PATCH_RESULT — run directly.
// All others go through _patch-shim.js for PATCH_RESULT generation.
const NATIVE_PATCHES = new Set([
  "patch-fast-mode.js",
  "patch-gpu.js",
  "patch-multi-agent.js",
]);

function parseStatus(output) {
  const lines = output.split("\n");
  const statusLines = lines.filter(l => l.startsWith("PATCH_RESULT:"));
  if (statusLines.length === 0) return null;

  const parts = statusLines[0].slice("PATCH_RESULT:".length).trim().split(/\s+/);
  const status = parts[0];
  if (!VALID_STATUSES.includes(status)) return null;

  return { status, detail: parts.slice(1).join(" ") };
}

function main() {
  const args = process.argv.slice(2);
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win", "unix"].includes(a));
  const extra = args.filter((a) => a.startsWith("--"));
  const passArgs = [...(platform ? [platform] : []), ...extra];
  const isCheck = extra.includes("--check");

  const results = [];
  const errors = [];

  for (const script of PATCHES) {
    const scriptPath = path.join(__dirname, script);
    const label = script.replace(".js", "");
    console.log(`\n== ${label} ==`);

    // Route through shim for legacy patches (no native PATCH_RESULT)
    const useShim = !NATIVE_PATCHES.has(script);
    const execArgs = useShim
      ? [path.join(__dirname, "_patch-shim.js"), scriptPath, ...passArgs]
      : [scriptPath, ...passArgs];

    try {
      const output = execFileSync("node", execArgs, {
        stdio: "pipe",
        encoding: "utf-8",
      });

      const parsed = parseStatus(output);
      if (!parsed) {
        results.push({ script: label, status: "MISSING", detail: "no valid PATCH_RESULT line" });
        if (REQUIRED.has(script)) {
          errors.push(`${label}: MISSING (REQUIRED) — no PATCH_RESULT line in output`);
        }
      } else {
        results.push({ script: label, ...parsed });
        const badStatuses = ["ABSENT", "FAILED", "MISSING"];
        if (badStatuses.includes(parsed.status) && REQUIRED.has(script)) {
          errors.push(`${label}: ${parsed.status} (REQUIRED) — ${parsed.detail}`);
        }
        if (parsed.status === "NOT_APPLICABLE" && REQUIRED.has(script) && !ALLOWS_NOT_APPLICABLE.has(script)) {
          errors.push(`${label}: NOT_APPLICABLE (REQUIRED) — ${parsed.detail} (not in allowlist)`);
        }
      }
    } catch (e) {
      // Non-zero exit: try to parse PATCH_RESULT from combined output
      const output = (e.stdout || "") + "\n" + (e.stderr || "");
      const parsed = parseStatus(output);
      const status = parsed ? parsed.status : "FAILED";
      const detail = parsed ? parsed.detail : (e.stderr || e.message || "").slice(0, 200);

      // If the script crashed without PATCH_RESULT, it's always FAILED
      results.push({ script: label, status: parsed ? status : "FAILED", detail: parsed ? detail : `crash: ${detail}` });

      const badStatuses = ["ABSENT", "FAILED", "MISSING"];
      if (badStatuses.includes(status) && REQUIRED.has(script)) {
        errors.push(`${label}: ${status} (REQUIRED) — ${detail}`);
        if (!parsed) {
          // Override: crashed without PATCH_RESULT is always FAILED regardless of exit code
          results[results.length - 1].status = "FAILED";
        }
      }
      if (parsed && parsed.status === "NOT_APPLICABLE" && REQUIRED.has(script) && !ALLOWS_NOT_APPLICABLE.has(script)) {
        errors.push(`${label}: NOT_APPLICABLE (REQUIRED) — ${parsed.detail}`);
      }
    }
  }

  // Summary
  const counts = {};
  for (const s of [...VALID_STATUSES, "MISSING"]) {
    counts[s] = results.filter(r => r.status === s).length;
  }
  console.log(`\n== Patch Summary: ${counts.APPLIED} APPLIED, ${counts.ALREADY_PATCHED} ALREADY_PATCHED, ${counts.NOT_APPLICABLE} NOT_APPLICABLE, ${counts.ABSENT} ABSENT, ${counts.FAILED} FAILED, ${counts.MISSING} MISSING (${PATCHES.length} total) ==`);
  if (isCheck) {
    console.log("   [check] Read-only mode — no files were modified.");
  }

  for (const r of results) {
    const flag = ["ABSENT", "FAILED", "MISSING"].includes(r.status) ? " ⚠" : "";
    console.log(`   ${r.status.padEnd(18)} ${r.script}${flag}${r.detail ? " — " + r.detail : ""}`);
  }

  if (errors.length > 0) {
    console.error(`\n[x] ${errors.length} patch error(s):`);
    for (const e of errors) console.error(`  [x] ${e}`);
    process.exit(1);
  }
}

main();
