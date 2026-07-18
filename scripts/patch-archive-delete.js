#!/usr/bin/env node
/**
 * patch-archive-delete.js — Add "Delete" button to archived conversations list.
 *
 * Two-layer patch:
 *   1. app-main chunk: inject "delete-conversation" route into the message router
 *   2. data-controls chunk: inject a red "Delete" button next to "Unarchive"
 *
 * The delete button calls the app-server "thread/delete" protocol via the
 * message router, which permanently removes the thread (DB + rollout file).
 *
 * Requires @cometix/codex CLI with thread/delete support.
 */
const fs = require("fs");
const path = require("path");
const acorn = require("acorn");
const { locateBundles, relPath, SRC_DIR } = require("./patch-util");

// ─── Layer 1: app-main route injection ──────────────────────────

function patchAppMain(bundles) {
  let patched = 0;
  for (const bundle of bundles) {
    const code = fs.readFileSync(bundle.path, "utf-8");

    if (code.includes("delete-conversation")) {
      console.log(`  [ok] ${relPath(bundle.path)}: route already patched`);
      continue;
    }

    // Dynamically find the unarchive-conversation route and extract:
    //   1. The quote style (" or `)
    //   2. The wrapper function name (i9, XE, YE, etc.)
    //   3. The manager variable name (e for app server manager)
    //   4. The conversationId param variable name (t, etc.)
    // Old pattern: "unarchive-conversation":XE(async(e,{conversationId:t})=>{await e.unarchiveConversation(t)})
    // New pattern: "unarchive-conversation":i9(async(e,{conversationId:t,restorePinnedPosition:n})=>{await e.unarchiveConversation(t,n)})
    const routeRe = /(["`])unarchive-conversation\1:(\w+)\(async\((\w+),\{conversationId:(\w+)[^}]*\}\)=>\{\s*await \3\.unarchiveConversation\(\4[^)]*\)\s*\}\)/;
    const routeMatch = code.match(routeRe);
    if (!routeMatch) {
      console.log(`  [!] ${relPath(bundle.path)}: unarchive-conversation route not found`);
      continue;
    }

    const q = routeMatch[1]; // quote style
    const wrapperFn = routeMatch[2]; // e.g. XE
    const mgrVar = routeMatch[3]; // e.g. e (the app server manager)
    const cidVar = routeMatch[4]; // e.g. t (conversationId param)
    const anchorEnd = routeMatch.index + routeMatch[0].length;

    const inject = `,${q}delete-conversation${q}:${wrapperFn}(async(${mgrVar},{conversationId:${cidVar}})=>{await ${mgrVar}.sendRequest(${q}thread/delete${q},{threadId:${cidVar}})})`;
    const newCode = code.slice(0, anchorEnd) + inject + code.slice(anchorEnd);
    fs.writeFileSync(bundle.path, newCode);
    console.log(`  [ok] ${relPath(bundle.path)}: injected delete-conversation route (wrapper=${wrapperFn})`);
    patched++;
  }
  return patched;
}

// ─── Layer 2: Force-enable upstream built-in delete button ────────
//
// Upstream now has a Zt component with showDeleteButton prop, gated by
// a feature flag comparison like: showDeleteButton:X===ne
// Replace with showDeleteButton:!0 to force-enable for all users.

function patchDataControls(bundles) {
  let patched = 0;
  for (const bundle of bundles) {
    const code = fs.readFileSync(bundle.path, "utf-8");

    if (/showDeleteButton\s*:\s*!0/.test(code)) {
      console.log(`  [ALREADY_PATCHED] ${relPath(bundle.path)}: showDeleteButton already !0`);
      continue;
    }

    const re = /showDeleteButton\s*:\s*(\w+)\s*===?\s*(\w+)/g;
    const matches = [...code.matchAll(re)];
    if (matches.length === 0) {
      console.log(`  [ABSENT] ${relPath(bundle.path)}: no feature-gated showDeleteButton found`);
      continue;
    }

    let newCode = code;
    for (const m of matches) {
      console.log(`  * ${relPath(bundle.path)}: showDeleteButton:${m[1]}===${m[2]} -> !0`);
      newCode = newCode.slice(0, m.index) + 'showDeleteButton:!0' + newCode.slice(m.index + m[0].length);
    }

    fs.writeFileSync(bundle.path, newCode);
    console.log(`  [ok] ${relPath(bundle.path)}: delete button force-enabled (${matches.length} gate(s))`);
    patched++;
  }
  return patched;
}

// ─── Legacy Layer 2: data-controls delete button AST injection ─────
// (kept for reference; not used since upstream now has built-in delete)

function patchDataControlsLegacy(bundles) {
  let patched = 0;
  for (const bundle of bundles) {
    const code = fs.readFileSync(bundle.path, "utf-8");

    if (code.includes("delete-conversation")) {
      console.log(`  [ok] ${relPath(bundle.path)}: delete button already patched`);
      continue;
    }

    let ast;
    try {
      ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: "module" });
    } catch (e) {
      console.log(`  [!] ${relPath(bundle.path)}: parse failed: ${e.message}`);
      continue;
    }

    // ── Step 1: Extract import variable names via AST ImportDeclarations ──

    let msgFnName = null;
    let btnComponent = null;
    let jsxFactory = null; // import from jsx-runtime (factory function, NOT the runtime)

    for (const node of ast.body) {
      if (node.type !== "ImportDeclaration") continue;
      const src = node.source.value;
      const specs = node.specifiers.filter((s) => s.type === "ImportSpecifier");

      if (src.includes("app-server-manager-signals") && specs.length >= 2) {
        // Second specifier is the messaging function (sendRequest wrapper).
        msgFnName = specs[1].local.name;
      }
      if (src.includes("button-") && specs.length >= 1) {
        btnComponent = specs[0].local.name;
      }
      if (src.includes("jsx-runtime") && specs.length >= 1) {
        jsxFactory = specs[0].local.name;
      }
    }

    const ROW_CLASS =
      "flex w-full items-center justify-between gap-3 px-4 py-3 hover:bg-token-list-hover-background";

    let threadVar = null;
    let hostIdVar = null;
    let queryClientVar = null;
    let contentVar = null;
    let unarchiveBtnVar = null;
    let childrenArrayStart = -1;
    let childrenArrayEnd = -1;

    // Recursive AST walker.
    function walk(node, visitors) {
      if (!node || typeof node !== "object") return;
      if (node.type) {
        for (const v of visitors) v(node);
      }
      for (const key of Object.keys(node)) {
        if (key === "type" || key === "start" || key === "end") continue;
        const val = node[key];
        if (Array.isArray(val)) val.forEach((n) => walk(n, visitors));
        else if (val && typeof val === "object" && val.type) walk(val, visitors);
      }
    }

    // Resolve the actual jsx runtime instance: `var E = r()` where r is jsxFactory.
    // The import is a factory function; calling it returns the runtime with .jsx/.jsxs.
    let jsxRuntime = null;
    if (jsxFactory) {
      walk(ast, [
        (node) => {
          if (
            node.type === "VariableDeclarator" &&
            node.id?.type === "Identifier" &&
            node.init?.type === "CallExpression" &&
            node.init.callee?.type === "Identifier" &&
            node.init.callee.name === jsxFactory &&
            node.init.arguments.length === 0
          ) {
            jsxRuntime = node.id.name;
          }
        },
      ]);
    }

    // Find the FunctionDeclaration containing the ROW_CLASS literal.
    let rowFunc = null;
    walk(ast, [
      (node) => {
        if (node.type !== "FunctionDeclaration") return;
        const slice = code.slice(node.start, node.end);
        if (slice.includes(ROW_CLASS)) rowFunc = node;
      },
    ]);

    if (!rowFunc) {
      console.log(`  [!] ${relPath(bundle.path)}: row function not found`);
      continue;
    }

    // Inside the row function, find:
    //   a) ObjectPattern destructuring with key "archivedThread" → threadVar, hostIdVar
    //   b) MemberExpression .cancelQueries() → queryClientVar
    //   c) CallExpression jsxs("div", {className: ROW_CLASS, children: [X, Y]}) → contentVar, unarchiveBtnVar
    walk(rowFunc, [
      (node) => {
        // (a) ObjectPattern: {archivedThread:X, conversationId:Y, hostId:Z, ...} = e
        if (node.type === "ObjectPattern") {
          for (const prop of node.properties) {
            if (prop.type !== "Property" || prop.key?.type !== "Identifier") continue;
            if (prop.key.name === "archivedThread" && prop.value?.type === "Identifier") {
              threadVar = prop.value.name;
            }
            if (prop.key.name === "hostId" && prop.value?.type === "Identifier") {
              hostIdVar = prop.value.name;
            }
          }
        }

        // (b) MemberExpression: X.cancelQueries(...)
        if (
          node.type === "CallExpression" &&
          node.callee?.type === "MemberExpression" &&
          node.callee.property?.name === "cancelQueries" &&
          node.callee.object?.type === "Identifier"
        ) {
          queryClientVar = node.callee.object.name;
        }

        // (c) jsxs("div", {className: ROW_CLASS, children: [X, Y]})
        if (
          node.type === "CallExpression" &&
          node.arguments?.length >= 2 &&
          node.arguments[1]?.type === "ObjectExpression"
        ) {
          const props = node.arguments[1].properties;
          const clsProp = props?.find(
            (p) =>
              p.key?.name === "className" &&
              p.value?.type === "TemplateLiteral" &&
              p.value.quasis?.[0]?.value?.raw === ROW_CLASS,
          );
          if (!clsProp) return;
          const childProp = props?.find(
            (p) => p.key?.name === "children" && p.value?.type === "ArrayExpression",
          );
          if (!childProp || childProp.value.elements.length !== 2) return;
          const [el0, el1] = childProp.value.elements;
          if (el0?.type === "Identifier") contentVar = el0.name;
          if (el1?.type === "Identifier") unarchiveBtnVar = el1.name;
          childrenArrayStart = childProp.value.start;
          childrenArrayEnd = childProp.value.end;
        }
      },
    ]);

    // ── Step 3: Validate all variables resolved ──

    if (
      !msgFnName || !btnComponent || !jsxRuntime ||
      !threadVar || !hostIdVar || !queryClientVar ||
      !contentVar || !unarchiveBtnVar || childrenArrayStart < 0
    ) {
      console.log(`  [!] ${relPath(bundle.path)}: could not resolve all variables`);
      console.log(
        `      msgFn=${msgFnName} btn=${btnComponent} jsx=${jsxRuntime}` +
        ` thread=${threadVar} host=${hostIdVar} qc=${queryClientVar}` +
        ` content=${contentVar} unarchiveBtn=${unarchiveBtnVar}`,
      );
      continue;
    }

    // ── Step 4: Build delete button and splice into children array ──

    const deleteBtn = [
      `(0,${jsxRuntime}.jsx)(${btnComponent},{`,
        `className:\`shrink-0\`,`,
        `color:\`secondary\`,`,
        `size:\`toolbar\`,`,
        `style:{color:\`#ef4444\`},`,
        `onClick:async()=>{`,
          `if(!confirm(\`Permanently delete this conversation?\`))return;`,
          `try{`,
            `${queryClientVar}.setQueryData([\`archived-threads\`,${hostIdVar}],`,
              `(${queryClientVar}.getQueryData([\`archived-threads\`,${hostIdVar}])??[])`,
              `.filter(e=>e.id!==${threadVar}.id));`,
            `await ${msgFnName}(\`delete-conversation\`,{conversationId:${threadVar}.id})`,
          `}catch(e){`,
            `${queryClientVar}.invalidateQueries({queryKey:[\`archived-threads\`,${hostIdVar}]})`,
          `}`,
        `},`,
        `children:\`Delete\``,
      `})`,
    ].join("");

    // Replace [contentVar, unarchiveBtnVar] with [contentVar, deleteBtn, unarchiveBtnVar]
    const newArray = `[${contentVar},${deleteBtn},${unarchiveBtnVar}]`;
    const newCode = code.slice(0, childrenArrayStart) + newArray + code.slice(childrenArrayEnd);

    fs.writeFileSync(bundle.path, newCode);
    console.log(
      `  [ok] ${relPath(bundle.path)}: injected delete button` +
      ` (thread=${threadVar} host=${hostIdVar} qc=${queryClientVar} btn=${btnComponent})`,
    );
    patched++;
  }
  return patched;
}

// ─── Check-only variants (read-only) ─────────────────────────────

function patchAppMainCheck(bundles) {
  const routeRe = /(["`])unarchive-conversation\1:(\w+)\(async\((\w+),\{conversationId:(\w+)[^}]*\}\)=>\{\s*await \3\.unarchiveConversation\(\4[^)]*\)\s*\}\)/;
  for (const bundle of bundles) {
    const code = fs.readFileSync(bundle.path, "utf-8");
    if (code.includes("delete-conversation")) {
      console.log(`    [ALREADY_PATCHED] ${relPath(bundle.path)}: route already exists`);
      continue;
    }
    const routeMatch = code.match(routeRe);
    if (!routeMatch) {
      console.log(`    [ABSENT] ${relPath(bundle.path)}: unarchive-conversation route pattern not found`);
      continue;
    }
    console.log(`    [PATCHABLE] ${relPath(bundle.path)}: can inject delete-conversation route (wrapper=${routeMatch[2]})`);
  }
}

function patchDataControlsCheck(bundles) {
  for (const bundle of bundles) {
    const code = fs.readFileSync(bundle.path, "utf-8");
    // Upstream now has a Zt component with showDeleteButton prop gated by feature flag.
    // Check if already force-enabled
    if (/showDeleteButton\s*:\s*!0/.test(code)) {
      console.log(`    [ALREADY_PATCHED] ${relPath(bundle.path)}: showDeleteButton already !0`);
      continue;
    }
    // Check if the gate exists: showDeleteButton:X===ne (some feature flag comparison)
    const gateMatch = code.match(/showDeleteButton\s*:\s*(\w+)\s*===?\s*(\w+)/);
    if (gateMatch) {
      console.log(`    [PATCHABLE] ${relPath(bundle.path)}: showDeleteButton:${gateMatch[1]}===${gateMatch[2]} -> !0`);
    } else if (code.includes("showDeleteButton")) {
      console.log(`    [ABSENT] ${relPath(bundle.path)}: showDeleteButton found but pattern unrecognized`);
    } else {
      console.log(`    [ABSENT] ${relPath(bundle.path)}: no showDeleteButton prop found`);
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) =>
    ["mac-arm64", "mac-x64", "win"].includes(a),
  );

  console.log("  [layer 1] message-router: delete-conversation route");
  // The route definitions moved from app-main-*.js to shared chunks in newer upstream.
  // Search all webview/assets JS files for the unarchive-conversation route pattern.
  const routeRe = /(["`])unarchive-conversation\1:(\w+)\(async\((\w+),\{conversationId:(\w+)[^}]*\}\)=>\{\s*await \3\.unarchiveConversation\(\4[^)]*\)\s*\}\)/;
  const routerBundles = [];
  const platforms = platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"].filter(p => fs.existsSync(path.join(SRC_DIR, p, "_asar", "webview", "assets")));
  for (const plat of platforms) {
    const assetsDir = path.join(SRC_DIR, plat, "_asar", "webview", "assets");
    if (!fs.existsSync(assetsDir)) continue;
    for (const f of fs.readdirSync(assetsDir)) {
      if (!f.endsWith(".js")) continue;
      const fp = path.join(assetsDir, f);
      try {
        const code = fs.readFileSync(fp, "utf-8");
        if (code.includes("unarchive-conversation") && routeRe.test(code)) {
          routerBundles.push({ platform: plat, path: fp });
        }
      } catch {}
    }
  }
  if (routerBundles.length === 0) {
    console.log("    [ABSENT] No bundle contains unarchive-conversation route definition");
  } else {
    const routePatched = isCheck ? patchAppMainCheck(routerBundles) : patchAppMain(routerBundles);
  }

  console.log("  [layer 2] data-controls: delete button");
  const dataControlsBundles = locateBundles({
    dir: "assets",
    pattern: /^data-controls-.*\.js$/,
    ...(platform ? { platform } : {}),
  });
  if (dataControlsBundles.length === 0) {
    console.log("    [ABSENT] No data-controls bundle found");
  } else {
    const btnPatched = isCheck ? patchDataControlsCheck(dataControlsBundles) : patchDataControls(dataControlsBundles);
  }
}

main();
