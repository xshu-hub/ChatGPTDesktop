#!/usr/bin/env node
/**
 * sync-upstream.js — Extract full upstream Codex resources
 *
 * Output structure per platform:
 *   src/{platform}/
 *     _asar/              Extracted app.asar content (patch target)
 *     app.asar.unpacked/  Native modules (kept as-is from upstream)
 *     codex|codex.exe     CLI binary (will be replaced by @cometix/codex)
 *     rg|rg.exe           ripgrep binary (kept from upstream)
 *     plugins/            Bundled plugins
 *     native/             Platform native modules
 *     ...                 All other upstream resources
 *
 * Usage:
 *   node scripts/sync-upstream.js [--force] [--skip-mac] [--skip-win]
 */

const https = require("https");
const tls = require("tls");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// TLS certs for MS delivery CDN
const certsDir = path.join(__dirname, "certs");
const extraCAs = [...tls.rootCertificates];
for (const f of ["ms-root-ca.pem", "ms-update-ca.pem"]) {
  const p = path.join(certsDir, f);
  if (fs.existsSync(p)) extraCAs.push(fs.readFileSync(p, "utf-8"));
}
https.globalAgent.options.ca = extraCAs;

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(PROJECT_ROOT, "src");
const TEMP_DIR = path.join(require("os").tmpdir(), "codex-sync");
const VERSION_FILE = path.join(__dirname, ".versions.json");

const APPCAST_ARM64 = "https://persistent.oaistatic.com/codex-app-prod/appcast.xml";
const APPCAST_X64 = "https://persistent.oaistatic.com/codex-app-prod/appcast-x64.xml";

const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const CHECK_ONLY = args.includes("--check-only");
const SKIP_MAC = args.includes("--skip-mac");
const SKIP_WIN = args.includes("--skip-win");

// ─── Helpers ────────────────────────────────────────────────────

function httpGet(url) {
  const mod = url.startsWith("https") ? https : http;
  return new Promise((resolve, reject) => {
    mod.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return httpGet(res.headers.location).then(resolve, reject);
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    }).on("error", reject);
  });
}

function curlDownload(url, dest, label) {
  console.log(`  [dl] ${label}`);
  execSync(`curl -L --retry 3 --retry-delay 2 -o "${dest}" "${url}"`, { stdio: "inherit" });
}

function extractArchive(archive, dest) {
  if (process.platform === "darwin" && archive.endsWith(".zip")) {
    // ditto preserves macOS symlinks + resource forks (required for .app)
    execSync(`ditto -xk "${archive}" "${dest}"`);
  } else {
    // 7zz for Windows MSIX and Linux (symlinks don't matter — only ASAR content used)
    for (const bin of ["7zz", "7z"]) {
      try {
        execSync(`${bin} x -y -o"${dest}" "${archive}"`, { stdio: "pipe" });
        return;
      } catch {
        if (fs.readdirSync(dest).length > 0) return;
      }
    }
    // Fallback: use Python3 zipfile (available in most environments)
    try {
      execSync(`python3 -c "
import zipfile, sys
z = zipfile.ZipFile(sys.argv[1])
z.extractall(sys.argv[2])
print(f'Extracted {len(z.namelist())} files')
" "${archive}" "${dest}"`, { stdio: "pipe" });
      return;
    } catch (e) {
      // Fallback: use unzip if available
      try {
        execSync(`unzip -o "${archive}" -d "${dest}"`, { stdio: "pipe" });
        return;
      } catch {}
    }
    throw new Error(`Failed to extract ${archive}`);
  }
}

function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return full;
    if (e.isDirectory()) { const r = findFile(full, name); if (r) return r; }
  }
  return null;
}

function copyRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) { count += copyRecursive(s, d); }
    else if (e.isSymbolicLink()) { /* skip */ }
    else { fs.copyFileSync(s, d); count++; }
  }
  return count;
}

function clearDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
}

function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(path.join(dir, e.name));
    else n++;
  }
  return n;
}

// ─── Version detection ──────────────────────────────────────────

async function getAppcastVersion(url) {
  const { XMLParser } = require("fast-xml-parser");
  const res = await httpGet(url);
  if (res.status !== 200) throw new Error(`Appcast fetch failed: ${res.status}`);
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true });
  const parsed = parser.parse(res.body.toString());
  const items = parsed.rss?.channel?.item;
  const latest = Array.isArray(items) ? items[0] : items;
  let enc = latest.enclosure;
  if (Array.isArray(enc)) enc = enc[0];
  return {
    version: latest.shortVersionString || latest.title,
    build: String(latest.version || ""),
    url: enc?.["@_url"] || "",
  };
}

async function getWindowsVersion() {
  const msstore = require("./fetch-msstore");
  const cookie = await msstore.getCookie();
  const info = await msstore.getAppInfo("9plm9xgg6vks", "US");
  if (!info.categoryId) throw new Error("No CategoryID");
  const pkgs = await msstore.getFileList(cookie, info.categoryId, "Retail");
  if (pkgs.length === 0) throw new Error("No packages");

  // Filter for x64 packages only. MS Store may return arm64 packages first.
  const x64Pkgs = pkgs.filter(p => p.name.includes("_x64__"));
  if (x64Pkgs.length === 0) {
    console.error("   [!] No x64 package found among:", pkgs.map(p => p.name).join(", "));
    throw new Error("No x64 Windows package available");
  }
  if (x64Pkgs.length < pkgs.length) {
    console.log(`   [filter] Selected x64 from ${pkgs.length} packages (skipped ${pkgs.length - x64Pkgs.length} non-x64)`);
  }

  const pkg = x64Pkgs[0];
  console.log(`   [selected] ${pkg.name} (${(Number(pkg.size) / 1048576).toFixed(1)} MB)`);
  const url = await msstore.getDownloadUrl(pkg.updateID, pkg.revisionNumber, "Retail", pkg.digest);
  const verMatch = pkg.name.match(/_(\d+\.\d+\.\d+(?:\.\d+)?)_/);
  return { version: verMatch?.[1] || "unknown", url, packageName: pkg.name };
}

// ─── Extract macOS ──────────────────────────────────────────────

async function syncMac(variant, appcastUrl, destDir) {
  const label = `macOS-${variant}`;
  console.log(`\n-- ${label}`);

  const info = await getAppcastVersion(appcastUrl);
  console.log(`   version: ${info.version} (build ${info.build})`);

  const zipPath = path.join(TEMP_DIR, `Codex-${variant}-${info.version}.zip`);
  const extractDir = path.join(TEMP_DIR, `${variant}-extract`);

  if (FORCE && fs.existsSync(zipPath)) {
    console.log(`   [force] Removing cached ${zipPath}`);
    fs.unlinkSync(zipPath);
  }
  if (!fs.existsSync(zipPath)) {
    curlDownload(info.url, zipPath, label);
  } else {
    console.log(`   [cache] ${zipPath}`);
  }

  console.log("   [unzip]");
  clearDir(extractDir);
  extractArchive(zipPath, extractDir);

  const resourcesDir = findResourcesDir(extractDir);
  if (!resourcesDir) throw new Error(`${label}: Resources directory not found`);

  assembleOutput(resourcesDir, destDir, label);
  return info;
}

// ─── Extract Windows ────────────────────────────────────────────

async function syncWin(destDir) {
  console.log("\n-- Windows");

  const info = await getWindowsVersion();
  console.log(`   version: ${info.version}`);

  const msixPath = path.join(TEMP_DIR, info.packageName || `codex-win-${info.version}.msix`);
  const extractDir = path.join(TEMP_DIR, "win-extract");

  if (FORCE && fs.existsSync(msixPath)) {
    console.log(`   [force] Removing cached ${msixPath}`);
    fs.unlinkSync(msixPath);
  }
  if (!fs.existsSync(msixPath)) {
    curlDownload(info.url, msixPath, "Windows MSIX");
  } else {
    console.log(`   [cache] ${msixPath}`);
  }

  console.log("   [unzip]");
  clearDir(extractDir);
  extractArchive(msixPath, extractDir);

  const resourcesDir = path.join(extractDir, "app", "resources");
  if (!fs.existsSync(resourcesDir)) {
    const alt = findFile(extractDir, "app.asar");
    throw new Error(`Windows: resources dir not found${alt ? `, app.asar at ${alt}` : ""}`);
  }

  assembleOutput(resourcesDir, destDir, "Windows");
  return info;
}

// ─── Assemble output ────────────────────────────────────────────

function assembleOutput(resourcesDir, destDir, label) {
  const asarPath = path.join(resourcesDir, "app.asar");
  if (!fs.existsSync(asarPath)) throw new Error(`${label}: app.asar not found`);

  console.log(`   [assemble] -> ${path.relative(PROJECT_ROOT, destDir)}/`);
  clearDir(destDir);

  // 1. Extract app.asar → _asar/ (for patching)
  const asarDest = path.join(destDir, "_asar");
  console.log("   [asar extract] -> _asar/");
  try {
    execSync(`npx asar extract "${asarPath}" "${asarDest}"`, { stdio: "pipe" });
  } catch (e) {
    // On Windows, deeply-nested symlinks in node_modules/ can exceed MAX_PATH.
    // These files are not needed (prepare-src.js skips node_modules/).
    // Policy: tolerate ONLY if ALL errors are ENOENT from within node_modules.
    // 0 ENOENT, non-node_modules errors, or unparseable output → hard failure.

    const allOutput = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n");
    // @electron/asar error format:
    //   Error: Unable to extract some files:\n\nError: ENOENT: ...\nError: ENOENT: ...
    const allErrors = allOutput.match(/Error:\s*[^\n]+/g) || [];

    if (allErrors.length === 0) {
      throw new Error(`${label}: ASAR extraction failed (unparseable). Full output:\n${allOutput.slice(0, 500)}`);
    }

    // Three-category classification:
    const wrapperErrors = allErrors.filter(l => /Unable to extract some files/i.test(l));
    const enoentErrors = allErrors.filter(l => /ENOENT/i.test(l));
    const otherErrors = allErrors.filter(l => !wrapperErrors.includes(l) && !enoentErrors.includes(l));

    // Fail on genuine non-ENOENT errors (not the ASAR wrapper)
    if (otherErrors.length > 0) {
      throw new Error(`${label}: ASAR extraction had ${otherErrors.length} unexpected error(s):\n${otherErrors.join("\n")}`);
    }

    // Must have at least one ENOENT
    if (enoentErrors.length === 0) {
      throw new Error(`${label}: ASAR extraction failed with 0 ENOENT errors. Errors: ${allErrors.length}\n${allErrors.slice(0, 3).join("\n")}`);
    }

    // All ENOENT must be in node_modules
    const enoentInNodeModules = enoentErrors.filter(l => /node_modules/.test(l));
    const enoentOutside = enoentErrors.filter(l => !/node_modules/.test(l));
    if (enoentOutside.length > 0) {
      throw new Error(`${label}: ASAR extraction had ${enoentOutside.length} ENOENT outside node_modules:\n${enoentOutside.join("\n")}`);
    }

    // Tolerated: >=1 ENOENT, all within node_modules
    // Verify critical FILES (not just directories) exist
    const asarPkg = path.join(asarDest, "package.json");
    const mainEntry = (() => {
      try { const p = JSON.parse(fs.readFileSync(asarPkg, "utf-8")); return path.join(asarDest, p.main || ""); } catch { return null; }
    })();
    const webviewIndex = path.join(asarDest, "webview", "index.html");
    const buildDir = path.join(asarDest, ".vite", "build");
    const assetsDir = path.join(asarDest, "webview", "assets");

    const critical = [
      { path: asarPkg, label: "package.json" },
      { path: mainEntry, label: "main entry" },
      { path: webviewIndex, label: "webview/index.html" },
    ];
    const missing = critical.filter(c => !c.path || !fs.existsSync(c.path));
    if (missing.length > 0) {
      throw new Error(`${label}: ASAR extraction missing critical files: ${missing.map(c => c.label).join(", ")}`);
    }
    // Verify build and assets directories are non-empty
    for (const d of [{ path: buildDir, label: ".vite/build" }, { path: assetsDir, label: "webview/assets" }]) {
      if (!fs.existsSync(d.path) || fs.readdirSync(d.path).length === 0) {
        throw new Error(`${label}: ASAR extraction missing or empty: ${d.label}`);
      }
    }

    console.warn(`   [warn] ASAR extraction tolerated ${enoentInNodeModules.length} node_modules ENOENT (MAX_PATH) — ${critical.length + 2} critical paths verified`);
  }

  // 2. Copy app.asar.unpacked/ as-is (native modules)
  const unpackedSrc = path.join(resourcesDir, "app.asar.unpacked");
  if (fs.existsSync(unpackedSrc)) {
    const n = copyRecursive(unpackedSrc, path.join(destDir, "app.asar.unpacked"));
    console.log(`   [copy] app.asar.unpacked/ (${n} files)`);
  }

  // 3. Copy all other resources (binaries, plugins, native, etc.)
  let extraCount = 0;
  for (const e of fs.readdirSync(resourcesDir, { withFileTypes: true })) {
    if (e.name === "app.asar" || e.name === "app.asar.unpacked") continue;
    if (e.name.endsWith(".lproj")) continue;
    const s = path.join(resourcesDir, e.name);
    const d = path.join(destDir, e.name);
    if (e.isDirectory()) { extraCount += copyRecursive(s, d); }
    else if (!e.isSymbolicLink()) { fs.copyFileSync(s, d); extraCount++; }
  }
  console.log(`   [copy] ${extraCount} extra resource files`);

  const total = countFiles(destDir);
  console.log(`   [ok] ${total} files total`);
}

function findResourcesDir(extractDir) {
  const appDir = findFile(extractDir, "app.asar");
  return appDir ? path.dirname(appDir) : null;
}

// ─── Version state ──────────────────────────────────────────────

function loadVersions() {
  try { return JSON.parse(fs.readFileSync(VERSION_FILE, "utf-8")); } catch { return {}; }
}
function saveVersions(v) {
  fs.writeFileSync(VERSION_FILE, JSON.stringify(v, null, 2) + "\n");
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  console.log("== Codex upstream sync ==\n");
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  const results = {};

  // Detect versions
  if (!SKIP_MAC) {
    try {
      const arm64Info = await getAppcastVersion(APPCAST_ARM64);
      console.log(`\n   mac-arm64: ${arm64Info.version} (build ${arm64Info.build})`);
      results["mac-arm64"] = arm64Info;
    } catch (e) { console.error(`   [x] mac-arm64 check: ${e.message}`); }

    try {
      const x64Info = await getAppcastVersion(APPCAST_X64);
      console.log(`   mac-x64:   ${x64Info.version} (build ${x64Info.build})`);
      results["mac-x64"] = x64Info;
    } catch (e) { console.error(`   [x] mac-x64 check: ${e.message}`); }
  }

  if (!SKIP_WIN) {
    try {
      const winInfo = await getWindowsVersion();
      console.log(`   win:       ${winInfo.version}`);
      results.win = winInfo;
    } catch (e) { console.error(`   [x] win check: ${e.message}`); }
  }

  if (CHECK_ONLY) {
    console.log("\n== Check only, skipping download ==");
    return;
  }

  // Download and extract — errors are FATAL (no partial builds)
  if (!SKIP_MAC && results["mac-arm64"]) {
    results["mac-arm64"] = await syncMac("arm64", APPCAST_ARM64, path.join(SRC_DIR, "mac-arm64"));
  }
  if (!SKIP_MAC && results["mac-x64"]) {
    results["mac-x64"] = await syncMac("x64", APPCAST_X64, path.join(SRC_DIR, "mac-x64"));
  }
  if (!SKIP_WIN && results.win) {
    results.win = await syncWin(path.join(SRC_DIR, "win"));
  }

  const saved = loadVersions();
  for (const [key, info] of Object.entries(results)) {
    saved[key] = { version: info.version, build: info.build || "", checkedAt: new Date().toISOString() };
  }
  saveVersions(saved);

  console.log("\n== Done ==");
  for (const [key, info] of Object.entries(results)) {
    console.log(`   ${key}: ${info.version}`);
  }
}

main().catch((e) => { console.error(`\n[x] ${e.message}`); process.exit(1); });
