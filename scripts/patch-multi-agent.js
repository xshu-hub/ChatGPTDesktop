#!/usr/bin/env node
/**
 * patch-multi-agent.js — Remove ChatGPT-only gate from multi_agent_v2 config
 *
 * The multi_agent_v2 config parser includes an auth gate:
 *   if(authMethod !== "chatgpt") return;
 * This means API key users get undefined (default: 1 thread), while ChatGPT
 * users get up to 8 concurrent threads per session.
 *
 * This patch removes the early-return guard so ALL auth methods can use
 * multi_agent_v2 with the same max concurrent threads.
 *
 * Strategy (Phase 2 — business-field-based):
 *   1. Locate the chunk: search for max_concurrent_threads + .safeParse(
 *   2. AST: find ANY function containing both "chatgpt" comparison AND
 *           max_concurrent_threads_per_session in its body
 *   3. Inside that function, find the if(X!==`chatgpt`)return; guard
 *   4. Remove the guard, verify postcondition
 *
 * Usage:
 *   node scripts/patch-multi-agent.js [platform]    # Apply
 *   node scripts/patch-multi-agent.js --check        # Dry-run
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { reportPatchStatus, SRC_DIR, relPath } = require("./patch-util");

// ── AST walker ──

function walk(node, visitor, parent) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node, parent);
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object" && item.type) walk(item, visitor, node);
      }
    } else if (child && typeof child === "object" && child.type) {
      walk(child, visitor, node);
    }
  }
}

function getLiteralValue(node) {
  if (!node) return null;
  if (node.type === "Literal") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0 && node.quasis.length === 1)
    return node.quasis[0].value.cooked;
  return null;
}

// ── Patch rule (Phase 2: business-field-based, no hardcoded function name) ──

const BUSINESS_FIELDS = ["multi_agent_v2", "max_concurrent_threads_per_session"];

function collectPatches(ast, source) {
  const patches = [];

  walk(ast, (node) => {
    // Match ANY function (declaration, expression, arrow) whose body contains
    // the business field "max_concurrent_threads_per_session".
    const isFn = node.type === "FunctionDeclaration" ||
                 node.type === "FunctionExpression" ||
                 node.type === "ArrowFunctionExpression";
    if (!isFn) return;

    const fnSrc = source.slice(node.start, node.end);
    if (!fnSrc.includes("max_concurrent_threads_per_session")) return;

    // Inside this function, find the auth guard: if(X!==`chatgpt`)return;
    walk(node, (child) => {
      if (child.type !== "IfStatement") return;
      if (child.alternate) return; // No else clause

      const test = child.test;
      if (test.type !== "BinaryExpression" || test.operator !== "!==") return;
      const leftVal = getLiteralValue(test.left);
      const rightVal = getLiteralValue(test.right);
      if (leftVal !== "chatgpt" && rightVal !== "chatgpt") return;

      // Consequent must be a bare ReturnStatement (no argument)
      const cons = child.consequent;
      if (cons.type !== "ReturnStatement") return;
      if (cons.argument) return; // Must be bare `return;`

      patches.push({
        id: "multi_agent_v2_auth_gate",
        start: child.start,
        end: child.end,
        replacement: "",
        original: source.slice(child.start, child.end),
        fnName: node.id?.name || "(anonymous)",
      });
    });
  });

  return patches;
}

// ── Target location ──

function locateTargets(platform) {
  const platforms = platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"].filter((p) =>
        fs.existsSync(path.join(SRC_DIR, p, "_asar", "webview", "assets"))
      );

  const targets = [];
  for (const plat of platforms) {
    const assetsDir = path.join(SRC_DIR, plat, "_asar", "webview", "assets");
    if (!fs.existsSync(assetsDir)) continue;
    for (const f of fs.readdirSync(assetsDir)) {
      if (!f.endsWith(".js")) continue;
      const fp = path.join(assetsDir, f);
      const src = fs.readFileSync(fp, "utf-8");
      // Business field search: max_concurrent_threads_per_session + .safeParse(
      // These are unique to the multi_agent_v2 config parser function.
      if (BUSINESS_FIELDS.every(field => src.includes(field)) && /\.safeParse\(/.test(src)) {
        targets.push({ platform: plat, path: fp });
      }
    }
  }
  return targets;
}

// ── Postcondition verification ──

function verifyPostcondition(original, modified) {
  // Business fields must be preserved
  for (const field of BUSINESS_FIELDS) {
    if (!modified.includes(field)) return { ok: false, reason: `missing business field: ${field}` };
  }
  // Auth guard should be gone
  if (/if\(\w+!==`chatgpt`\)return;/.test(modified)) {
    return { ok: false, reason: "auth guard still present after patch" };
  }
  // At least one change was made
  if (original === modified) return { ok: false, reason: "no changes made" };
  return { ok: true };
}

// ── Main ──

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win"].includes(a));

  const targets = locateTargets(platform);

  if (targets.length === 0) {
    reportPatchStatus("ABSENT", "no chunk contains max_concurrent_threads_per_session + .safeParse(");
    return;
  }

  let totalApplied = 0;
  let alreadyPatched = 0;
  let absentCount = 0;

  for (const bundle of targets) {
    console.log(`\n-- [${bundle.platform}] ${relPath(bundle.path)}`);
    const source = fs.readFileSync(bundle.path, "utf-8");
    console.log(`   size: ${(source.length / 1024 / 1024).toFixed(1)} MB`);

    // Quick pre-check: does the guard pattern exist?
    if (!/if\(\w+!==`chatgpt`\)return;/.test(source)) {
      console.log("   [ALREADY_PATCHED] auth guard not found in target chunk");
      alreadyPatched++;
      continue;
    }

    const t0 = Date.now();
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    console.log(`   parse: ${Date.now() - t0}ms`);

    const patches = collectPatches(ast, source);

    if (patches.length === 0) {
      console.log("   [ABSENT] target function found but guard pattern did not AST-match");
      absentCount++;
      continue;
    }

    if (isCheck) {
      console.log(`   [PATCHABLE] ${patches.length} guard(s):`);
      for (const p of patches) {
        console.log(`     > fn=${p.fnName} offset ${p.start}: remove \`${p.original}\``);
      }
      totalApplied += patches.length;
      continue;
    }

    // Apply patches (reverse order)
    patches.sort((a, b) => b.start - a.start);
    let code = source;
    for (const p of patches) {
      console.log(`   * fn=${p.fnName} offset ${p.start}: removing \`${p.original}\``);
      let end = p.end;
      while (end < code.length && (code[end] === " " || code[end] === ";" || code[end] === "\n")) end++;
      code = code.slice(0, p.start) + code.slice(end);
    }

    // Postcondition verification
    const verified = verifyPostcondition(source, code);
    if (!verified.ok) {
      reportPatchStatus("FAILED", `postcondition: ${verified.reason}`);
      return;
    }

    fs.writeFileSync(bundle.path, code, "utf-8");
    console.log(`   [ok] ${patches.length} guard(s) removed, postcondition verified`);
    totalApplied += patches.length;
  }

  if (alreadyPatched > 0 && totalApplied === 0 && absentCount === 0) {
    reportPatchStatus("ALREADY_PATCHED", `${alreadyPatched} chunk(s) already in desired state`);
  } else if (totalApplied > 0) {
    reportPatchStatus("APPLIED", `${totalApplied} guard(s) removed`);
  } else if (absentCount > 0 && totalApplied === 0) {
    reportPatchStatus("ABSENT", `${absentCount} chunk(s) had target fields but no guard matched`);
  }
}

main();
