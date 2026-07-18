#!/usr/bin/env node
/**
 * Post-build patch: Force-enable Fast mode (speed selector + request tier)
 *
 * Gate 1 (UI selector): authMethod comparison that controls speed selector visibility.
 * Gate 2 (request tier): same isServiceTierAllowed check controls which service tier
 *                        is sent with API requests. Both gates share the same code.
 *
 * AST match: find BinaryExpression X.authMethod !== "chatgpt" or === "chatgpt"
 * inside functions referencing "fast_mode". Replace !== with !1, === with !0.
 *
 * Target: any webview chunk containing both authMethod and fast_mode
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { reportPatchStatus,  locateBundles, relPath, SRC_DIR } = require("./patch-util");

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node);
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object" && item.type) walk(item, visitor);
      }
    } else if (child && typeof child === "object" && child.type) {
      walk(child, visitor);
    }
  }
}

function collectPatches(ast, source) {
  const patches = [];

  walk(ast, (node) => {
    // Match function bodies containing both authMethod and fast_mode
    const isFn =
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression";
    if (!isFn) return;

    const fnSrc = source.slice(node.start, node.end);
    if (!fnSrc.includes("authMethod") || !fnSrc.includes("fast_mode")) return;

    // Inside this function, find authMethod comparisons:
    //   Old: X.authMethod !== `chatgpt`  → replace with !1 (never blocks non-chatgpt)
    //   New: X.authMethod === `chatgpt`  → replace with !0 (always considered chatgpt)
    walk(node, (child) => {
      if (child.type !== "BinaryExpression") return;
      if (child.operator !== "!==" && child.operator !== "===") return;

      const childSrc = source.slice(child.start, child.end);
      if (!childSrc.includes("authMethod") || !childSrc.includes("chatgpt"))
        return;

      if (childSrc === "!1" || childSrc === "!0") return;

      // Avoid duplicate patches at same offset
      if (patches.some((p) => p.start === child.start)) return;

      // !== "chatgpt" → !1 (always false = never block)
      // === "chatgpt" → !0 (always true = always allow)
      const replacement = child.operator === "!==" ? "!1" : "!0";

      patches.push({
        id: "fast_mode_auth_gate",
        start: child.start,
        end: child.end,
        replacement,
        original: childSrc,
      });
    });
  });

  return patches;
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) =>
    ["mac-arm64", "mac-x64", "win"].includes(a),
  );

  const platforms = platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"].filter((p) =>
        fs.existsSync(path.join(SRC_DIR, p, "_asar", "webview", "assets")),
      );

  const targets = [];
  for (const plat of platforms) {
    const assetsDir = path.join(SRC_DIR, plat, "_asar", "webview", "assets");
    if (!fs.existsSync(assetsDir)) continue;
    for (const f of fs.readdirSync(assetsDir)) {
      if (!f.endsWith(".js")) continue;
      const fp = path.join(assetsDir, f);
      const src = fs.readFileSync(fp, "utf-8");
      if (src.includes("authMethod") && src.includes("fast_mode")) {
        targets.push({ platform: plat, path: fp });
      }
    }
  }

  if (targets.length === 0) {
    console.log("  [skip] No chunk contains fast_mode gate logic");
    return;
  }

  let totalPatched = 0;

  for (const bundle of targets) {
    const source = fs.readFileSync(bundle.path, "utf-8");

    const t0 = Date.now();
    let ast;
    try {
      ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    } catch {
      continue;
    }

    const patches = collectPatches(ast, source);

    if (patches.length === 0) continue;

    console.log(
      `  [${bundle.platform}] ${relPath(bundle.path)} (parse ${Date.now() - t0}ms)`,
    );

    if (isCheck) {
      for (const p of patches) {
        console.log(`    [?] offset ${p.start}: ${p.original} -> ${p.replacement}`);
      }
      continue;
    }

    patches.sort((a, b) => b.start - a.start);

    let code = source;
    for (const p of patches) {
      console.log(`    * ${p.original} -> ${p.replacement}`);
      code = code.slice(0, p.start) + p.replacement + code.slice(p.end);
    }

    fs.writeFileSync(bundle.path, code, "utf-8");
    totalPatched += patches.length;
  }

  if (totalPatched > 0) {
    console.log(`  [ok] ${totalPatched} auth gate(s) removed`);
    reportPatchStatus("APPLIED", `${totalPatched} authMethod comparison(s) removed (controls speed selector UI + request service tier via isServiceTierAllowed)`);
  } else {
    console.log("  [ALREADY_PATCHED] fast_mode auth gates already patched or absent");
    reportPatchStatus("ALREADY_PATCHED", "no authMethod gate found (speed selector + request tier already unrestricted)");
  }
}

main();
