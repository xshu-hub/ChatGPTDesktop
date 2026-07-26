#!/usr/bin/env node
/**
 * patch-ultra-fast.js — Force-enable Ultrafast tier + request-tier auth
 *
 * Two independent issues after patch-fast-mode.js:
 *
 * 1. FWi function (request-tier): has its own `!== "chatgpt"` guard
 *    that patch-fast-mode.js misses because it uses `MWi()` instead
 *    of `authMethod` property.  Without this, non-ChatGPT users can see
 *    the slider but their selected tier is ignored in API requests.
 *
 * 2. Ker function (tier-options builder): only includes tiers from the
 *    server's model config.  Ultrafast may be absent server-side.
 *    This patch forces Ultrafast into the slider as the top option.
 *
 * Target: webview assets JS chunks containing "fast_mode"
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { reportPatchStatus, SRC_DIR, relPath } = require("./patch-util");

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  visitor(node);
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) if (item && typeof item === "object") walk(item, visitor);
    } else if (child && typeof child === "object") {
      walk(child, visitor);
    }
  }
}

function applyPatches(source, apply) {
  // Sort descending to apply from end to start (stable offsets)
  const patches = apply.sort((a, b) => b.start - a.start);
  let code = source;
  for (const p of patches) {
    code = code.slice(0, p.start) + p.text + code.slice(p.end);
  }
  return code;
}

function main() {
  const args = process.argv.slice(2);
  const wasPlatform = args.find((a) =>
    ["mac-arm64", "mac-x64", "win"].includes(a),
  );

  const platforms = wasPlatform
    ? [wasPlatform]
    : ["mac-arm64", "mac-x64", "win"].filter((p) =>
        fs.existsSync(path.join(SRC_DIR, p, "_asar", "webview", "assets")),
      );

  let totalFwiPatches = 0;
  let totalKerPatches = 0;

  for (const plat of platforms) {
    const assetsDir = path.join(SRC_DIR, plat, "_asar", "webview", "assets");
    if (!fs.existsSync(assetsDir)) continue;

    for (const f of fs.readdirSync(assetsDir)) {
      if (!f.endsWith(".js")) continue;
      const fp = path.join(assetsDir, f);
      const original = fs.readFileSync(fp, "utf-8");
      if (!original.includes("fast_mode")) continue;

      // Avoid double-patching
      if (original.includes("/*ultra-fast-fwi*/") && original.includes("/*ultra-fast-tier*/")) {
        continue;
      }

      let source = original;

      // ── Patch A: FWi function ──────────────────────────────────
      // Find function bodies containing: fast_mode, featureRequirements,
      // AND a `!== `chatgpt`` guard — but NOT `authMethod`
      try {
        const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
        const fwiPatches = [];

        walk(ast, (node) => {
          const isFn =
            node.type === "FunctionDeclaration" ||
            node.type === "FunctionExpression" ||
            node.type === "ArrowFunctionExpression";
          if (!isFn || !node.body) return;

          const fnSrc = source.slice(node.start, node.end);
          if (!fnSrc.includes("fast_mode")) return;
          if (!fnSrc.includes("featureRequirements")) return;
          if (!fnSrc.includes("!==`chatgpt")) return;

          // Found the FWi function.  Find the guard inside it.
          walk(node, (child) => {
            if (child.type !== "IfStatement") return;
            if (child.consequent?.type !== "ReturnStatement") return;
            const retArg = child.consequent.argument;
            if (!retArg) return;
            const retSrc = source.slice(retArg.start, retArg.end);
            if (retSrc !== "!1" && retSrc !== "false") return;

            const test = child.test;
            if (test.type !== "BinaryExpression") return;
            if (test.operator !== "!==") return;
            const testSrc = source.slice(test.start, test.end);
            if (!testSrc.includes("chatgpt")) return;

            if (testSrc.includes("/*ultra-fast-fwi*/")) return;

            // Replace condition X!==`chatgpt` → !1
            //  if(X!==`chatgpt`)return!1  →  if(!1)return!1
            fwiPatches.push({
              start: test.start,
              end: test.end,
              text: "!1/*ultra-fast-fwi*/",
            });
          });
        });

        if (fwiPatches.length > 0) {
          source = applyPatches(source, fwiPatches);
          totalFwiPatches += fwiPatches.length;
          console.log(
            `  [${plat}] ${relPath(fp)} — FWi guard(s): ${fwiPatches.length}`,
          );
        }
      } catch (e) {
        console.log(`  [!] ${plat} ${f}: FWi AST parse error: ${e.message.slice(0, 80)}`);
      }

      // ── Patch B: Ker function — inject Ultrafast tier ──────────
      // The Ker function builds: [atr, ...(e?.serviceTiers??[]).map(e => ({...}))]
      // We inject Ultrafast before the final `]` by wrapping the result.
      if (!source.includes("/*ultra-fast-tier*/")) {
        try {
          const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
          const kerPatches = [];

          walk(ast, (node) => {
            const isFn =
              node.type === "FunctionDeclaration" ||
              node.type === "FunctionExpression" ||
              node.type === "ArrowFunctionExpression";
            if (!isFn || !node.body || node.body.type !== "BlockStatement") return;

            const fnSrc = source.slice(node.start, node.end);
            if (!fnSrc.includes("serviceTiers")) return;

            // Find the return statement whose argument is an ArrayExpression
            walk(node, (child) => {
              if (child.type !== "ReturnStatement") return;
              const arg = child.argument;
              if (!arg) return;
              const argSrc = source.slice(arg.start, arg.end);
              if (!argSrc.includes("serviceTiers")) return;
              if (!argSrc.includes(".map(")) return;
              if (argSrc.includes("/*ultra-fast-tier*/")) return;

              // Extract function names used in the .map() callback
              // Pattern: {description:Wer(e),iconKind:Ver(e.id,e.name),label:Uer(e),tier:e,value:e.id}
              const mapCtx = source.slice(arg.start, arg.end);
              const descFn = (mapCtx.match(/\{description:(\w+)\(e\)/) || [])[1];
              const iconFn = (mapCtx.match(/iconKind:(\w+)\(/) || [])[1];
              const labelFn = (mapCtx.match(/label:(\w+)\(e\)/) || [])[1];

              if (!descFn || !labelFn) return;

              // Build the Ultrafast tier entry
              const ufEntry =
                ",{description:" +
                descFn +
                '({id:"ultrafast",name:"Ultrafast"}),' +
                "iconKind:" +
                (iconFn
                  ? iconFn + '("ultrafast","Ultrafast")'
                  : '"ultrafast"') +
                ",label:" +
                labelFn +
                '({id:"ultrafast",name:"Ultrafast"}),' +
                'tier:{id:"ultrafast",name:"Ultrafast"},' +
                'value:"ultrafast"}/*ultra-fast-tier*/';

              // Insert before the closing `]` of the array expression
              // The arg ends with `]` — find it
              const closeBracket = arg.end - 1; // last char of array expression

              // We need to handle: `return[...stuff...]`
              // Insert before `]`
              kerPatches.push({
                start: closeBracket,
                end: closeBracket,
                text: ufEntry,
              });
            });
          });

          if (kerPatches.length > 0) {
            source = applyPatches(source, kerPatches);
            totalKerPatches += kerPatches.length;
            console.log(
              `  [${plat}] ${relPath(fp)} — Ultrafast tier injected: ${kerPatches.length}`,
            );
          }
        } catch (e) {
          console.log(`  [!] ${plat} ${f}: Ker AST parse error: ${e.message.slice(0, 80)}`);
        }
      }

      // ── Write ──────────────────────────────────────────────────
      if (source !== original) {
        fs.writeFileSync(fp, source, "utf-8");
      }
    }
  }

  const totalPatched = totalFwiPatches + totalKerPatches;

  if (totalPatched > 0) {
    const parts = [];
    if (totalFwiPatches > 0) parts.push(`${totalFwiPatches} FWi request-tier gate(s) removed`);
    if (totalKerPatches > 0) parts.push(`${totalKerPatches} Ultrafast tier(s) injected`);
    console.log(`\n  [ok] ${totalPatched} total change(s): ${parts.join("; ")}`);
    reportPatchStatus("APPLIED", parts.join("; "));
  } else {
    console.log("\n  already in desired state");
    reportPatchStatus("ALREADY_PATCHED", "FWi gate + Ultrafast tier already applied");
  }
}

main();
