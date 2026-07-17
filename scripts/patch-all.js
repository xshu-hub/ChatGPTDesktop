#!/usr/bin/env node
/**
 * Run all patch scripts in sequence.
 *
 * Usage:
 *   node scripts/patch-all.js              # Patch both platforms
 *   node scripts/patch-all.js unix         # Patch unix only
 *   node scripts/patch-all.js win          # Patch win only
 *   node scripts/patch-all.js --check      # Dry-run all
 */
const { execFileSync } = require("child_process");
const path = require("path");

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
];

function main() {
  const args = process.argv.slice(2);
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win", "unix"].includes(a));
  const extra = args.filter((a) => a.startsWith("--"));
  const passArgs = [...(platform ? [platform] : []), ...extra];
  const isCheck = extra.includes("--check");

  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (const script of PATCHES) {
    const scriptPath = path.join(__dirname, script);
    const label = script.replace(".js", "");
    console.log(`\n== ${label} ==`);

    try {
      execFileSync("node", [scriptPath, ...passArgs], { stdio: "inherit" });
      succeeded++;
    } catch (e) {
      // A script exiting with code 1 may just mean "no targets" — don't treat as fatal
      if (e.status === 1) {
        console.error(`  [!] ${label}: no matching targets or check-only mode (exit 1)`);
        skipped++;
      } else {
        console.error(`[x] ${label} failed (exit ${e.status})`);
        failed++;
      }
    }
  }

  const total = PATCHES.length;
  console.log(`\n== Patch Summary: ${succeeded} applied, ${skipped} skipped, ${failed} failed (${total} total) ==`);
  if (isCheck) {
    console.log("   [check] Read-only mode — no files were modified.");
    console.log("   Review PATCHABLE/ALREADY_PATCHED/ABSENT above for each script.");
  }
  if (failed > 0) process.exit(1);
}

main();
