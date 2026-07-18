/**
 * Post-build patch: Disable appSunset forced-update gate
 *
 * Codex uses a Statsig gate to control version sunsetting.
 * When the gate returns true, a full-screen "Update Required" overlay blocks the UI.
 *
 * AST match: find functions containing the sunset i18n key "appSunset",
 * then locate gate checker calls identifier(`numericString`) within them,
 * and replace with !1 (false).
 *
 * Usage:
 *   node scripts/patch-sunset.js [platform]   # Apply patch (unix/win/omit=both)
 *   node scripts/patch-sunset.js --check      # Dry-run: report matches
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { reportPatchStatus,  locateBundles, relPath, SRC_DIR } = require("./patch-util");

// ──────────────────────────────────────────────
//  AST walker
// ──────────────────────────────────────────────

function walk(node, visitor, parent) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node, parent);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object" && item.type) {
          walk(item, visitor, node);
        }
      }
    } else if (child && typeof child === "object" && child.type) {
      walk(child, visitor, node);
    }
  }
}

// ──────────────────────────────────────────────
//  Patch rule
// ──────────────────────────────────────────────

// The sunset gate ID (Statsig hash of the sunset feature name)
const SUNSET_GATE_ID = "2929582856";
// Sunset UI i18n markers (for broader detection of sunset-related code)
const SUNSET_MARKERS = ["appSunset", "app.sunset", "sunset"];

function getLiteralValue(node) {
  if (!node) return null;
  if (node.type === "Literal") return node.value;
  if (
    node.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  )
    return node.quasis[0].value.cooked;
  return null;
}

function collectPatches(ast, source) {
  const allPatches = [];

  walk(ast, (node) => {
    // Match gate calls directly: Identifier("2929582856") → !1
    // This catches the sunset gate regardless of which function or chunk it lives in.
    if (node.type !== "CallExpression") return;
    if (node.callee?.type !== "Identifier") return;
    if (node.arguments?.length !== 1) return;

    const argVal = getLiteralValue(node.arguments[0]);
    if (argVal !== SUNSET_GATE_ID) return;

    const callSrc = source.slice(node.start, node.end);
    if (callSrc === "!1") return;

    if (!allPatches.some((x) => x.start === node.start)) {
      allPatches.push({
        start: node.start,
        end: node.end,
        replacement: "!1",
        original: callSrc,
      });
    }
  });

  return allPatches;
}

// ──────────────────────────────────────────────
//  Main
// ──────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win"].includes(a));

  // Search ALL webview/assets JS files (not just index-*.js).
  // The sunset gate migrated to shared chunks in newer upstream versions.
  const targets = [];
  const platforms = platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"].filter((p) =>
        fs.existsSync(path.join(SRC_DIR, p, "_asar", "webview", "assets"))
      );

  for (const plat of platforms) {
    const assetsDir = path.join(SRC_DIR, plat, "_asar", "webview", "assets");
    if (!fs.existsSync(assetsDir)) continue;
    for (const f of fs.readdirSync(assetsDir)) {
      if (!f.endsWith(".js")) continue;
      const fp = path.join(assetsDir, f);
      const src = fs.readFileSync(fp, "utf-8");
      if (src.includes(SUNSET_GATE_ID)) {
        targets.push({ platform: plat, path: fp });
      }
    }
  }

  if (targets.length === 0) {
    console.log("[ABSENT] Sunset gate " + SUNSET_GATE_ID + " not found in any webview chunk");
    return;
  }

  for (const bundle of targets) {
    console.log(`\n-- [${bundle.platform}] ${relPath(bundle.path)}`);
    const source = fs.readFileSync(bundle.path, "utf-8");
    console.log(`   size: ${(source.length / 1024 / 1024).toFixed(1)} MB`);

    const t0 = Date.now();
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    console.log(`   parse: ${Date.now() - t0}ms`);

    const patches = collectPatches(ast, source);

    if (patches.length === 0) {
      if (source.includes("!1") && !source.includes(SUNSET_GATE_ID + '"') && !source.includes(SUNSET_GATE_ID + "`")) {
        console.log("   [ALREADY_PATCHED] Sunset gate already disabled");
      } else {
        console.log("   [ABSENT] Gate ID found but AST pattern did not match");
      }
      continue;
    }

    if (isCheck) {
      console.log(`   [PATCHABLE] ${patches.length} match(es):`);
      for (const p of patches) {
        console.log(`     > offset ${p.start}: ${p.original} -> ${p.replacement}`);
      }
      continue;
    }

    patches.sort((a, b) => b.start - a.start);

    let code = source;
    for (const p of patches) {
      console.log(`   * offset ${p.start}: ${p.original} -> ${p.replacement}`);
      code = code.slice(0, p.start) + p.replacement + code.slice(p.end);
    }

    fs.writeFileSync(bundle.path, code, "utf-8");
    console.log(`   [ok] Sunset gate disabled: ${patches.length} gate calls -> !1`);
  }
}

main();
