#!/usr/bin/env node
/**
 * Run all patch scripts in sequence with structured status reporting.
 *
 * Each patch outputs a line: PATCH_RESULT: STATUS [details]
 * This script parses those lines and produces a summary.
 *
 * Exit code: non-zero if any REQUIRED patch is ABSENT or FAILED.
 *
 * Usage:
 *   node scripts/patch-all.js [platform]         # Apply
 *   node scripts/patch-all.js [platform] --check  # Dry-run
 */
const { execFileSync } = require("child_process");
const path = require("path");

// Patches that MUST succeed (ABSENT or FAILED → build fails)
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

// All patches including optional ones
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

/**
 * Infer patch status from legacy output when PATCH_RESULT line is absent.
 */
function inferStatus(output) {
  if (/\[ABSENT\]/i.test(output)) return { status: "ABSENT", detail: "target pattern not found in source" };
  if (/\[ALREADY_PATCHED\]/i.test(output)) return { status: "ALREADY_PATCHED", detail: "already in desired state" };
  if (/\[SKIP\]/i.test(output)) return { status: "NOT_APPLICABLE", detail: "platform not applicable" };
  if (/\[PATCHABLE\]/i.test(output)) {
    const n = (output.match(/PATCHABLE/g) || []).length;
    return { status: "APPLIED", detail: `${n} location(s) patchable` };
  }
  if (/\[ok\]/i.test(output) || /replacement/i.test(output) || /injected/i.test(output)) {
    return { status: "APPLIED", detail: "legacy: ok/replacement/injected" };
  }
  if (/no match|not found|0 match/i.test(output)) return { status: "ALREADY_PATCHED", detail: "no matches (already patched or removed)" };
  return { status: "APPLIED", detail: "legacy: exit 0 (no status indicators)" };
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

    try {
      const output = execFileSync("node", [scriptPath, ...passArgs], {
        stdio: "pipe",
        encoding: "utf-8",
      });

      // Parse PATCH_RESULT line
      const statusLine = output.split("\n").find(l => l.startsWith("PATCH_RESULT:"));
      if (statusLine) {
        const parts = statusLine.slice("PATCH_RESULT:".length).trim().split(/\s+/);
        const status = parts[0];
        const detail = parts.slice(1).join(" ");
        results.push({ script: label, status, detail });
      } else {
        // Smart inference from output patterns
        const inferred = inferStatus(output);
        results.push({ script: label, status: inferred.status, detail: inferred.detail });
      }
    } catch (e) {
      // Child process failed (non-zero exit)
      const output = (e.stdout || "") + "\n" + (e.stderr || "");
      const statusLine = output.split("\n").find(l => l.startsWith("PATCH_RESULT:"));
      if (statusLine) {
        const parts = statusLine.slice("PATCH_RESULT:".length).trim().split(/\s+/);
        const status = parts[0];
        const detail = parts.slice(1).join(" ");
        results.push({ script: label, status, detail });
        if (status === "ABSENT" || status === "FAILED") {
          if (REQUIRED.has(script)) {
            errors.push(`${label}: ${status} (REQUIRED) — ${detail}`);
          }
        }
      } else {
        const errOutput = (e.stdout || "") + "\n" + (e.stderr || "");
        const inferred = inferStatus(errOutput);
        // If inference found ABSENT or a clear status, use it; otherwise FAILED
        const status = (inferred.status === "ABSENT") ? "ABSENT" : "FAILED";
        const detail = (inferred.status === "ABSENT") ? inferred.detail : (e.stderr || e.message || "").slice(0, 200);
        results.push({ script: label, status, detail });
        if ((status === "ABSENT" || status === "FAILED") && REQUIRED.has(script)) {
          errors.push(`${label}: ${status} (REQUIRED) — ${detail}`);
        }
      }
    }
  }

  // Summary
  const counts = {};
  for (const s of ["APPLIED", "ALREADY_PATCHED", "NOT_APPLICABLE", "ABSENT", "FAILED"]) {
    counts[s] = results.filter(r => r.status === s).length;
  }
  console.log(`\n== Patch Summary: ${counts.APPLIED} APPLIED, ${counts.ALREADY_PATCHED} ALREADY_PATCHED, ${counts.NOT_APPLICABLE} NOT_APPLICABLE, ${counts.ABSENT} ABSENT, ${counts.FAILED} FAILED (${PATCHES.length} total) ==`);
  if (isCheck) {
    console.log("   [check] Read-only mode — no files were modified.");
  }

  // Print per-patch detail
  for (const r of results) {
    const flag = r.status === "ABSENT" || r.status === "FAILED" ? " ⚠" : "";
    console.log(`   ${r.status.padEnd(18)} ${r.script}${flag}${r.detail ? " — " + r.detail : ""}`);
  }

  if (errors.length > 0) {
    console.error(`\n[x] ${errors.length} REQUIRED patch(es) failed:`);
    for (const e of errors) console.error(`  [x] ${e}`);
    process.exit(1);
  }
}

main();
