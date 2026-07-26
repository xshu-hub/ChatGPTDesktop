#!/usr/bin/env node
/**
 * patch-all-gates.js — Unlock ALL remaining gated features
 *
 * Combines P0-P3 into a single patch:
 *
 * P0: Force-enable ALL known Statsig gates used in desktop feature
 *     dispatch (BCu), hotkey window (Jdu), and dictation
 *     (21+ features total)
 * P1: Flip hardcoded disabled: localBackend:!1→!0, visualizeLive:!1→!0
 *     Remove authMethod gate from general-settings
 * P2: Remove authMethod gate from plugins-page
 * P3: Voice/dictation Statsig gates (included in P0 batch)
 *
 * Target: webview/assets/*.js
 */
const fs = require("fs");
const path = require("path");
const { reportPatchStatus, SRC_DIR, relPath } = require("./patch-util");

// ── Gate IDs to force-enable globally ────────────────────────────
const GATE_IDS = [
  // BCu function (desktop features dispatch)
  "2425897452", // ambientSuggestions
  "1304276663", // appshotsEnabled
  "2484414311",
  "188145323",  // cuaPIP
  "3079718369", // sparkle disableSparkleAutodownload
  "4263582812", // sparkle useInternalUpdateCdn
  "637432221",  // sites
  "1834314516", // linksDefaultInAppBrowser
  "1397824675", // unifiedBrowserSkill
  "2212532336", // multiBrowserTabs
  "2791276931", // recordAndReplay
  "2171042036", // control
  "2957382457", // dil
  "459748632",  // multiWindow
  "4167858931", // openAIMcpFormElicitations
  "3264431617", // processManager (BCu + Jdu)
  "2380644311", // prewarmAvatarOverlay (BCu + Jdu)
  "1256703444", // webMcp
  "1529702798", // deepResearch
  "1840974662", // visualize
  // Jdu function (hotkey / voice / dictation)
  "1244621283", // isGlobalDictationEnabled
  "1372061905", // isHotkeyWindowEnabled
  "4100906017", // isVoiceInputEnabled
  // Extra: voice control
  "2833409405", // voice related
];

const BCU_MARKER = "electron-desktop-features-changed";

function main() {
  const args = process.argv.slice(2);
  const platform = args.find((a) =>
    ["mac-arm64", "mac-x64", "win"].includes(a),
  );

  const platforms = platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"].filter((p) =>
        fs.existsSync(path.join(SRC_DIR, p, "_asar", "webview", "assets")),
      );

  let totalGatesPatched = 0;
  let totalHardcodedPatched = 0;
  let totalUiPatched = 0;

  for (const plat of platforms) {
    const assetsDir = path.join(SRC_DIR, plat, "_asar", "webview", "assets");
    if (!fs.existsSync(assetsDir)) continue;

    // ── P0+P3: Global gate replacement in app-initial ──────────
    for (const f of fs.readdirSync(assetsDir)) {
      if (!f.startsWith("app-initial-") || !f.endsWith(".js")) continue;
      const fp = path.join(assetsDir, f);
      let source = fs.readFileSync(fp, "utf-8");

      if (source.includes("/*allgates-patched*/")) {
        console.log(`  [${plat}] ${f}: already patched`);
        continue;
      }

      let changed = false;
      let gatesInFile = 0;
      let hardcodedInFile = 0;

      // Replace all Rh(`GATE_ID`) with !0/*rh-ID*/
      for (const gateId of GATE_IDS) {
        const pattern = `Rh(\`${gateId}\`)`;
        if (source.includes(pattern)) {
          source = source.replaceAll(pattern, `!0/*rh-${gateId}*/`);
          gatesInFile++;
          changed = true;
        }
      }

      // Flip hardcoded disabled features (only in BCu context but safe globally)
      if (source.includes("localBackend:!1")) {
        source = source.replace("localBackend:!1", "localBackend:!0/*rh-hc*/");
        hardcodedInFile++;
        changed = true;
      }
      if (source.includes("visualizeLive:!1")) {
        source = source.replace("visualizeLive:!1", "visualizeLive:!0/*rh-hc*/");
        hardcodedInFile++;
        changed = true;
      }

      if (changed) {
        source = source.replace(
          BCU_MARKER,
          BCU_MARKER + "/*allgates-patched*/",
        );
        fs.writeFileSync(fp, source, "utf-8");
        totalGatesPatched += gatesInFile;
        totalHardcodedPatched += hardcodedInFile;
        console.log(
          `  [${plat}] ${f}: ${gatesInFile} gates + ${hardcodedInFile} hardcoded`,
        );
      }
    }

    // ── P1: General settings page ───────────────────────────────
    for (const f of fs.readdirSync(assetsDir)) {
      if (!f.startsWith("general-settings-") || !f.endsWith(".js")) continue;
      const fp = path.join(assetsDir, f);
      let source = fs.readFileSync(fp, "utf-8");

      if (source.includes("/*nogate-settings*/")) continue;

      // In general-settings: check patterns like `.ChatGPT!==`chatgpt``
      // and `=== \`chatgpt\`` that gate UI sections
      let changed = false;

      // Pattern: .ChatGPT!==`chatgpt` (blocks chatgpt-only UI sections)
      if (source.includes(".ChatGPT!==`chatgpt`")) {
        source = source.replaceAll(".ChatGPT!==`chatgpt`", "/*nogate-settings*/");
        changed = true;
      }

      if (changed) {
        fs.writeFileSync(fp, source, "utf-8");
        totalUiPatched++;
        console.log(`  [${plat}] ${f}: settings gate removed`);
      }
    }

    // ── P2: Plugin management page ──────────────────────────────
    for (const f of fs.readdirSync(assetsDir)) {
      if (!f.startsWith("plugins-page-") || !f.endsWith(".js")) continue;
      const fp = path.join(assetsDir, f);
      let source = fs.readFileSync(fp, "utf-8");

      if (source.includes("/*nogate-plugins*/")) continue;

      // Find `X === \`chatgpt\`` gates
      const matches = source.match(/(\w{2,3})===`chatgpt`/g);
      if (matches) {
        let changed = false;
        for (const m of matches) {
          const varName = m.replace("===`chatgpt`", "");
          const re = new RegExp(varName + "===`chatgpt`", "g");
          if (source.match(re)) {
            // Don't patch auth method = chatgpt (needed for actual API calls)
            // Only patch the UI visibility gates
            const occurrences = source.match(new RegExp(varName + "===`chatgpt`", "g"));
            if (occurrences && occurrences.length <= 3) {
              // Few occurrences → likely UI gate, safe to patch
              source = source.replace(re, "/*nogate-plugins*/!0");
              changed = true;
            }
          }
        }
        if (changed) {
          fs.writeFileSync(fp, source, "utf-8");
          totalUiPatched++;
          console.log(`  [${plat}] ${f}: plugin page gate removed`);
        }
      }
    }
  }

  // ── Report ─────────────────────────────────────────────────────
  const total = totalGatesPatched + totalHardcodedPatched + totalUiPatched;
  const parts = [];
  if (totalGatesPatched > 0)
    parts.push(`${totalGatesPatched} Statsig gates force-enabled`);
  if (totalHardcodedPatched > 0)
    parts.push(`${totalHardcodedPatched} hardcoded features flipped`);
  if (totalUiPatched > 0)
    parts.push(`${totalUiPatched} UI authMethod gates removed`);

  if (total > 0) {
    console.log(`\n  [ok] ${parts.join("; ")}`);
    reportPatchStatus("APPLIED", parts.join("; "));
  } else {
    console.log("\n  already in desired state");
    reportPatchStatus("ALREADY_PATCHED", "all gates already enabled");
  }
}

main();
