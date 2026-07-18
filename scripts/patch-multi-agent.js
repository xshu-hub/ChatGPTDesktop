#!/usr/bin/env node
/**
 * patch-multi-agent.js — Remove ChatGPT-only gate from multi_agent_v2 config
 *
 * The ZO() function parses config to extract max_concurrent_threads_per_session.
 * It includes an auth gate: if(authMethod !== "chatgpt") return;
 * This means API key users get undefined (default: 1 thread), while ChatGPT
 * users get up to 8 concurrent threads per session.
 *
 * This patch removes the early-return guard so ALL auth methods can use
 * multi_agent_v2 with the same max concurrent threads.
 *
 * AST match: find function ZO, locate the IfStatement with early return,
 *            remove the entire if statement.
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
  if (
    node.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  )
    return node.quasis[0].value.cooked;
  return null;
}

// ── Patch rule ──

function collectPatches(ast, source) {
  const patches = [];

  walk(ast, (node) => {
    // Find FunctionDeclaration named ZO
    if (node.type !== "FunctionDeclaration") return;
    if (node.id?.name !== "ZO") return;

    // Find the early-return if-statement: if(e!==`chatgpt`)return;
    const body = node.body;
    if (!body || body.type !== "BlockStatement") return;

    for (const stmt of body.body) {
      if (stmt.type !== "IfStatement") continue;
      if (stmt.alternate) continue; // Must be a bare if with no else

      const test = stmt.test;
      if (test.type !== "BinaryExpression" || test.operator !== "!==") return;
      if (getLiteralValue(test.right) !== "chatgpt" && getLiteralValue(test.left) !== "chatgpt") continue;

      // Check consequent is a ReturnStatement with no argument
      const cons = stmt.consequent;
      if (cons.type !== "ReturnStatement") continue;
      if (cons.argument) continue; // Must be bare return; not return <expr>

      // Also check the function body (the if statement's parent) to confirm
      // this is inside ZO function
      const funcSrc = source.slice(node.start, node.end);
      if (!funcSrc.includes("multi_agent_v2") && !funcSrc.includes("max_concurrent_threads")) continue;

      patches.push({
        id: "multi_agent_v2_auth_gate",
        start: stmt.start,
        end: stmt.end,
        // Replace with empty string (remove the guard entirely)
        replacement: "",
        original: source.slice(stmt.start, stmt.end),
      });
    }
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
      // ZO function: X.safeParse(t).data.features.multi_agent_v2.max_concurrent_threads_per_session
      // The schema variable name (QO, $O, etc.) differs per platform due to minification.
      // "max_concurrent_threads_per_session" and ".safeParse(t)" are both unique to this function.
      if (src.includes('max_concurrent_threads_per_session') && /\.safeParse\(/.test(src)) {
        targets.push({ platform: plat, path: fp });
      }
    }
  }
  return targets;
}

// ── Main ──

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win"].includes(a));

  const targets = locateTargets(platform);

  if (targets.length === 0) {
    console.log("[ABSENT] No chunk contains multi_agent_v2 + ZO function");
    return;
  }

  for (const bundle of targets) {
    console.log(`\n-- [${bundle.platform}] ${relPath(bundle.path)}`);
    const source = fs.readFileSync(bundle.path, "utf-8");
    console.log(`   size: ${(source.length / 1024 / 1024).toFixed(1)} MB`);

    // Quick check: does the guard still exist?
    // Pattern: if(X!==`chatgpt`)return; (the auth gate inside ZO)
    // Guard pattern: if(X!==`chatgpt`)return; anywhere in the file
    if (!/if\(\w+!==`chatgpt`\)return;/.test(source) &&
        source.includes('max_concurrent_threads_per_session')) {
      console.log("   [ALREADY_PATCHED] ZO auth gate already removed");
      continue;
    }

    const t0 = Date.now();
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    console.log(`   parse: ${Date.now() - t0}ms`);

    const patches = collectPatches(ast, source);

    if (patches.length === 0) {
      console.log("   [ABSENT] ZO function found but guard pattern did not match");
      continue;
    }

    if (isCheck) {
      console.log(`   [PATCHABLE] ${patches.length} match(es):`);
      for (const p of patches) {
        console.log(`     > offset ${p.start}: remove \`${p.original}\``);
      }
      continue;
    }

    patches.sort((a, b) => b.start - a.start);

    let code = source;
    for (const p of patches) {
      console.log(`   * offset ${p.start}: removing auth gate \`${p.original}\``);
      // Remove the guard: delete from start to end (including trailing whitespace/semicolons)
      let end = p.end;
      while (end < code.length && (code[end] === " " || code[end] === ";" || code[end] === "\n")) end++;
      code = code.slice(0, p.start) + code.slice(end);
    }

    fs.writeFileSync(bundle.path, code, "utf-8");
    console.log(`   [ok] ZO multi_agent_v2 auth gate removed: ${patches.length} guard(s)`);
  }
}

main();
