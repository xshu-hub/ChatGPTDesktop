#!/usr/bin/env node
/**
 * validate-release-artifacts.js — Verify all expected release artifacts exist.
 *
 * Exit codes:
 *   0 = all artifacts present and valid
 *   1 = missing or invalid artifacts
 *
 * Generates: release-manifest.json, SHA256SUMS
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const EXPECTED = [
  // macOS
  { pattern: /Codex-mac-arm64-.*\.dmg$/, platform: "macOS arm64", type: "dmg" },
  { pattern: /Codex-mac-x64-.*\.dmg$/, platform: "macOS x64", type: "dmg" },
  // Windows
  { pattern: /Codex-win-x64-.*\.zip$/, platform: "Windows x64", type: "zip" },
  // Linux x64
  { pattern: /codex_.*_amd64\.deb$/, platform: "Linux x64", type: "deb" },
  { pattern: /codex-.*-1\.x86_64\.rpm$/, platform: "Linux x64", type: "rpm" },
  { pattern: /Codex-linux-x64-.*\.zip$/, platform: "Linux x64", type: "zip" },
  // Linux arm64
  { pattern: /codex_.*_arm64\.deb$/, platform: "Linux arm64", type: "deb" },
  { pattern: /codex-.*-1\.arm64\.rpm$/, platform: "Linux arm64", type: "rpm" },
  { pattern: /Codex-linux-arm64-.*\.zip$/, platform: "Linux arm64", type: "zip" },
];

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function main() {
  const artifactsDir = process.argv[2] || "artifacts";
  if (!fs.existsSync(artifactsDir)) {
    console.error(`[FAIL] Artifacts directory not found: ${artifactsDir}`);
    process.exit(1);
  }

  // Collect all files recursively
  const files = [];
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(p);
    }
  }
  walk(artifactsDir);

  if (files.length === 0) {
    console.error(`[FAIL] No files found in ${artifactsDir}`);
    process.exit(1);
  }

  // Match each expected artifact
  const manifest = { artifacts: {}, errors: [] };
  const checksums = [];

  for (const expected of EXPECTED) {
    const matches = files.filter(f => expected.pattern.test(path.basename(f)));

    if (matches.length === 0) {
      manifest.errors.push(`MISSING: ${expected.platform} ${expected.type}`);
      continue;
    }
    if (matches.length > 1) {
      manifest.errors.push(`DUPLICATE: ${expected.platform} ${expected.type} — ${matches.map(path.basename).join(", ")}`);
      continue;
    }

    const f = matches[0];
    const stat = fs.statSync(f);
    if (stat.size === 0) {
      manifest.errors.push(`EMPTY: ${expected.platform} ${expected.type} — ${path.basename(f)}`);
      continue;
    }

    const hash = sha256(f);
    const key = `${expected.platform} ${expected.type}`;
    manifest.artifacts[key] = { file: path.basename(f), size: stat.size, sha256: hash };
    checksums.push(`${hash}  ${path.basename(f)}`);
  }

  // Check for unexpected files
  const matched = new Set(Object.values(manifest.artifacts).map(a => a.file));
  const unexpected = files.filter(f => {
    const bn = path.basename(f);
    return !matched.has(bn) && !bn.endsWith(".json") && bn !== "SHA256SUMS";
  });
  if (unexpected.length > 0) {
    manifest.warnings = [`${unexpected.length} unexpected file(s): ${unexpected.map(path.basename).join(", ")}`];
  }

  // Write outputs
  fs.writeFileSync("release-manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  fs.writeFileSync("SHA256SUMS", checksums.join("\n") + "\n");

  console.log(JSON.stringify(manifest, null, 2));

  if (manifest.errors.length > 0) {
    console.error(`\n[FAIL] ${manifest.errors.length} artifact error(s):`);
    for (const e of manifest.errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  console.log(`\n[ok] All ${Object.keys(manifest.artifacts).length} artifacts validated, SHA256SUMS generated`);
}

main();
