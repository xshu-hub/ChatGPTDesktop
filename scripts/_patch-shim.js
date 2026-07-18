#!/usr/bin/env node
/**
 * Patch shim: wraps a legacy patch script and appends a PATCH_RESULT line.
 *
 * The target script is expected to stdout log messages and exit:
 *   0 = success (APPLIED or ALREADY_PATCHED)
 *   1 = no targets (ABSENT on critical scripts, ALREADY_PATCHED otherwise)
 *   2+ = error (FAILED)
 *
 * This shim reads the target's output and generates a valid PATCH_RESULT.
 */
const { execFileSync } = require("child_process");
const path = require("path");

const targetScript = process.argv[2];
if (!targetScript) {
  console.error("Usage: node _patch-shim.js <target-script> [args...]");
  process.exit(2);
}

const targetArgs = process.argv.slice(3);

try {
  const output = execFileSync("node", [targetScript, ...targetArgs], {
    stdio: "pipe",
    encoding: "utf-8",
  });
  process.stdout.write(output);

  // Determine status from output patterns
  if (/\[ABSENT\]/i.test(output)) {
    console.log("PATCH_RESULT: ABSENT target not found");
  } else if (/\[ALREADY_PATCHED\]/i.test(output)) {
    console.log("PATCH_RESULT: ALREADY_PATCHED already in desired state");
  } else if (/\[NOT_APPLICABLE\]/i.test(output) || /\[SKIP\]/i.test(output)) {
    console.log("PATCH_RESULT: NOT_APPLICABLE platform not applicable");
  } else {
    // Default: script exited 0 with modifications
    console.log("PATCH_RESULT: APPLIED shim: exit 0");
  }
} catch (e) {
  const output = (e.stdout || "") + "\n" + (e.stderr || "");
  process.stdout.write(output);

  if (/\[ABSENT\]/i.test(output)) {
    console.log("PATCH_RESULT: ABSENT target not found");
  } else if (/\[ALREADY_PATCHED\]/i.test(output)) {
    console.log("PATCH_RESULT: ALREADY_PATCHED already in desired state");
  } else if (/\[NOT_APPLICABLE\]/i.test(output) || /\[SKIP\]/i.test(output)) {
    console.log("PATCH_RESULT: NOT_APPLICABLE platform not applicable");
  } else {
    console.log("PATCH_RESULT: FAILED shim: exit " + (e.status || "non-zero"));
  }

  // Propagate exit code so patch-all can track failures
  process.exit(e.status || 2);
}
