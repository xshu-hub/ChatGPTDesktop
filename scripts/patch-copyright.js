/**
 * Post-build patch: Update copyright text
 *
 * Uses AST to locate `setAboutPanelOptions({ copyright: "(c) OpenAI" })`
 * and replace the copyright string with a custom value.
 *
 * Usage:
 *   node scripts/patch-copyright.js [platform]   # Apply patch (unix/win/omit=both)
 *   node scripts/patch-copyright.js --check       # Dry-run: report matches
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { locateBundles, relPath } = require("./patch-util");

// ──────────────────────────────────────────────
//  Config
// ──────────────────────────────────────────────

const OLD_COPYRIGHT = "\u00A9 OpenAI"; // (c) OpenAI
const NEW_COPYRIGHT = "\u00A9 OpenAI \u00B7 Cometix Space"; // (c) OpenAI . Cometix Space
const OLD_HTML = '<div class="copyright">\u00A9 OpenAI</div>';
const NEW_HTML = '<div class="copyright">\u00A9 OpenAI \u00B7 Cometix Space</div>';

// ──────────────────────────────────────────────
//  AST walker
// ──────────────────────────────────────────────

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  visitor(node);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item.type === "string") walk(item, visitor);
      }
    } else if (child && typeof child.type === "string") {
      walk(child, visitor);
    }
  }
}

// ──────────────────────────────────────────────
//  Patch rule
// ──────────────────────────────────────────────

function collectPatches(ast, source) {
  const patches = [];
  walk(ast, (node) => {
    if (node.type !== "Property") return;
    const keyName =
      node.key.type === "Identifier"
        ? node.key.name
        : node.key.type === "Literal"
          ? node.key.value
          : null;
    if (keyName !== "copyright") return;

    const val = node.value;

    // Case 1: Literal string  copyright: "..."
    if (val.type === "Literal" && val.value === OLD_COPYRIGHT) {
      patches.push({
        start: val.start,
        end: val.end,
        replacement: JSON.stringify(NEW_COPYRIGHT),
        original: source.slice(val.start, val.end),
      });
      return;
    }

    // Case 2: Template literal  copyright: `...`  (no expressions, single quasi)
    if (
      val.type === "TemplateLiteral" &&
      val.expressions.length === 0 &&
      val.quasis.length === 1 &&
      val.quasis[0].value.cooked === OLD_COPYRIGHT
    ) {
      patches.push({
        start: val.start,
        end: val.end,
        replacement: "`" + NEW_COPYRIGHT + "`",
        original: source.slice(val.start, val.end),
      });
      return;
    }
  });
  return patches;
}

// ──────────────────────────────────────────────
//  Main
// ──────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win"].includes(a));

  const bundles = locateBundles({
    dir: "build",
    pattern: /^main(-[^.]+)?\.js$/,
    platform,
  });

  if (bundles.length === 0) {
    console.error("[x] No main bundle found");
    process.exit(1);
  }

  for (const bundle of bundles) {
    console.log(`\n-- [${bundle.platform}] ${relPath(bundle.path)}`);
    const source = fs.readFileSync(bundle.path, "utf-8");
    console.log(`   size: ${(source.length / 1024 / 1024).toFixed(1)} MB`);

    // Strategy 1: AST-based — find Property {copyright: "© OpenAI"}
    const t0 = Date.now();
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    console.log(`   parse: ${Date.now() - t0}ms`);

    const patches = collectPatches(ast, source);

    // Strategy 2: String-based — find HTML template <div class="copyright">© OpenAI</div>
    // (upstream changed from JS object to HTML template in newer versions)
    const htmlIdx = source.indexOf(OLD_HTML);
    const alreadyHtmlPatched = source.includes(NEW_HTML);
    const hasHtmlCopyright = htmlIdx !== -1 && !alreadyHtmlPatched;

    if (patches.length === 0 && !hasHtmlCopyright) {
      if (source.includes(NEW_COPYRIGHT) || alreadyHtmlPatched) {
        console.log("   [ALREADY_PATCHED] Copyright already updated");
      } else {
        console.log("   [ABSENT] No copyright text matched (neither JS object nor HTML template)");
      }
      continue;
    }

    if (isCheck) {
      if (patches.length > 0) {
        console.log(`   [PATCHABLE-AST] ${patches.length} JS object match(es):`);
        for (const p of patches) {
          console.log(`     > offset ${p.start}: ${p.original} -> ${p.replacement}`);
        }
      }
      if (hasHtmlCopyright) {
        console.log(`   [PATCHABLE-HTML] offset ${htmlIdx}: <div class="copyright">...</div>`);
      }
      continue;
    }

    let code = source;

    // Apply AST patches
    patches.sort((a, b) => b.start - a.start);
    for (const p of patches) {
      console.log(`   * [AST] offset ${p.start}: ${p.original} -> ${p.replacement}`);
      code = code.slice(0, p.start) + p.replacement + code.slice(p.end);
    }

    // Apply HTML template patch
    if (hasHtmlCopyright) {
      const idx = code.indexOf(OLD_HTML);
      if (idx !== -1) {
        code = code.slice(0, idx) + NEW_HTML + code.slice(idx + OLD_HTML.length);
        console.log(`   * [HTML] offset ${idx}: replaced copyright in HTML template`);
      }
    }

    fs.writeFileSync(bundle.path, code, "utf-8");
    const total = patches.length + (hasHtmlCopyright ? 1 : 0);
    console.log(`   [ok] Copyright updated: ${total} replacements`);
  }
}

main();
