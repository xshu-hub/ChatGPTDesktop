/**
 * Shared utilities for patch scripts.
 * Provides multi-platform bundle location and common helpers.
 */
const fs = require("fs");
const path = require("path");

const SRC_DIR = path.join(__dirname, "..", "src");
const PROJECT_ROOT = path.join(__dirname, "..");

/**
 * Locate bundles matching a filename pattern across platform directories.
 *
 * @param {object} opts
 * @param {"build"|"assets"} opts.dir - Subdirectory type:
 *   "build"  -> src/{plat}/.vite/build/
 *   "assets" -> src/{plat}/webview/assets/
 * @param {RegExp} opts.pattern - Filename regex (e.g. /^index-.*\.js$/)
 * @param {string} [opts.platform] - Restrict to a single platform
 * @returns {Array<{platform: string, path: string}>}
 */
function locateBundles({ dir, pattern, platform }) {
  const dirMap = {
    build: (plat) => path.join(SRC_DIR, plat, "_asar", ".vite", "build"),
    assets: (plat) => path.join(SRC_DIR, plat, "_asar", "webview", "assets"),
  };

  // Legacy fallback paths (flat src/ without _asar subdirs)
  const legacyMap = {
    build: path.join(SRC_DIR, ".vite", "build"),
    assets: path.join(SRC_DIR, "webview", "assets"),
  };

  const getDir = dirMap[dir];
  if (!getDir) throw new Error(`Unknown dir type: ${dir}`);

  const ALL_PLATFORMS = ["mac-arm64", "mac-x64", "win"];
  const platforms = platform
    ? [platform]
    : ALL_PLATFORMS.filter((p) => fs.existsSync(getDir(p)));

  // Legacy fallback
  if (platforms.length === 0) {
    const fallback = legacyMap[dir];
    if (fallback && fs.existsSync(fallback)) {
      const files = fs.readdirSync(fallback).filter((f) => pattern.test(f));
      if (files.length > 0) {
        // For build dir, prefer hashed file over plain
        const target =
          files.length > 1 ? files.find((f) => f !== "main.js") || files[0] : files[0];
        return [{ platform: "legacy", path: path.join(fallback, target) }];
      }
    }
    return [];
  }

  const results = [];
  for (const plat of platforms) {
    const d = getDir(plat);
    if (!fs.existsSync(d)) continue;

    const files = fs.readdirSync(d).filter((f) => pattern.test(f));
    if (files.length === 0) {
      console.warn(`  [!] ${plat}: no match for ${pattern}`);
      continue;
    }

    // For build dir with multiple matches, prefer hashed variant
    const target =
      files.length > 1 ? files.find((f) => f !== "main.js") || files[0] : files[0];

    results.push({ platform: plat, path: path.join(d, target) });
  }

  return results;
}

/**
 * Return path relative to project root.
 */
function relPath(absPath) {
  return path.relative(PROJECT_ROOT, absPath);
}

/**
 * Compute SHA256 hash of a file for integrity verification.
 * Used to guarantee --check mode has zero side effects.
 */
function fileHash(filePath) {
  const crypto = require("crypto");
  const fs = require("fs");
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

/**
 * Dry-run guard: verify a file's hash hasn't changed after a read-only operation.
 * Returns true if the file is unchanged.
 */
function verifyUnchanged(filePath, originalHash) {
  const current = fileHash(filePath);
  if (current !== originalHash) {
    console.error(`  [CORRUPTION] ${filePath} was modified during check-only operation!`);
    console.error(`    expected: ${originalHash}`);
    console.error(`    actual:   ${current}`);
    return false;
  }
  return true;
}

/**
 * Unified patch status protocol.
 * Each patch script MUST output exactly one line matching:
 *   PATCH_RESULT: STATUS [details]
 * where STATUS is one of: APPLIED, ALREADY_PATCHED, NOT_APPLICABLE, ABSENT, FAILED
 */
const PATCH_STATUSES = ["APPLIED", "ALREADY_PATCHED", "NOT_APPLICABLE", "ABSENT", "FAILED"];

function reportPatchStatus(status, details = "") {
  if (!PATCH_STATUSES.includes(status)) throw new Error(`Invalid patch status: ${status}`);
  const line = `PATCH_RESULT: ${status}${details ? " " + details : ""}`;
  console.log(line);
  return line;
}

module.exports = { locateBundles, relPath, SRC_DIR, PROJECT_ROOT, fileHash, verifyUnchanged, PATCH_STATUSES, reportPatchStatus };
