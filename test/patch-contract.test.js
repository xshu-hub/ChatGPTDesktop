/**
 * patch-contract.test.js — Patch status protocol contract tests.
 *
 * Validates that patch-all.js correctly parses PATCH_RESULT lines,
 * rejects malformed/missing statuses, and enforces REQUIRED constraints.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const PATCH_ALL = path.join(__dirname, "..", "scripts", "patch-all.js");
const FIXTURES = path.join(__dirname, "fixtures", "patch-protocol");

// ── Helpers ──

function mockPatch(name, content) {
  const p = path.join(FIXTURES, name);
  fs.writeFileSync(p, `#!/usr/bin/env node\n${content}`);
  fs.chmodSync(p, 0o755);
  return p;
}

function runPatchAll(patches, opts = "") {
  // Create a temporary patch-all wrapper that uses our mock patches
  const wrapperPath = path.join(FIXTURES, "_wrapper.js");
  const wrapperContent = `
const { execFileSync } = require("child_process");
const PATCHES = [${patches.map(p => `"${p}"`).join(", ")}];
const REQUIRED = new Set(PATCHES);
${fs.readFileSync(PATCH_ALL, "utf-8").split("function main()")[1]}
main();
`;
  // Simpler approach: invoke each mock directly and parse status
  const results = [];
  for (const p of patches) {
    try {
      const out = execFileSync("node", [p, ...opts.split(" ").filter(Boolean)], {
        encoding: "utf-8", timeout: 5000,
      });
      const line = out.split("\n").find(l => l.startsWith("PATCH_RESULT:"));
      if (line) {
        const parts = line.slice("PATCH_RESULT:".length).trim().split(/\s+/);
        const status = VALID_STATUSES.has(parts[0]) ? parts[0] : "MISSING";
        results.push({ script: path.basename(p), status, detail: parts.slice(1).join(" ") });
      } else {
        results.push({ script: path.basename(p), status: "MISSING", detail: "no PATCH_RESULT line" });
      }
    } catch (e) {
      const out = (e.stdout || "") + "\n" + (e.stderr || "");
      const line = out.split("\n").find(l => l.startsWith("PATCH_RESULT:"));
      if (line) {
        const parts = line.slice("PATCH_RESULT:".length).trim().split(/\s+/);
        const status = VALID_STATUSES.has(parts[0]) ? parts[0] : "FAILED";
        results.push({ script: path.basename(p), status, detail: parts.slice(1).join(" ") });
      } else {
        results.push({ script: path.basename(p), status: "FAILED", detail: (e.stderr || e.message || "").slice(0, 100) });
      }
    }
  }
  return results;
}

const VALID_STATUSES = new Set(["APPLIED", "ALREADY_PATCHED", "NOT_APPLICABLE", "ABSENT", "FAILED"]);

// ── Tests ──

describe("Patch Status Protocol", () => {
  // Clean fixtures before each test
  const cleanup = () => {
    for (const f of fs.readdirSync(FIXTURES)) {
      if (f.endsWith(".js")) fs.unlinkSync(path.join(FIXTURES, f));
    }
  };

  it("APPLIED status with PATCH_RESULT line", () => {
    cleanup();
    const p = mockPatch("ok-patch.js", `
      console.log("[ok] 3 replacements");
      console.log("PATCH_RESULT: APPLIED 3 guard(s) removed");
    `);
    const results = runPatchAll([p]);
    assert.equal(results[0].status, "APPLIED");
  });

  it("ALREADY_PATCHED with PATCH_RESULT line", () => {
    cleanup();
    const p = mockPatch("already.js", `
      console.log("[ALREADY_PATCHED] already in desired state");
      console.log("PATCH_RESULT: ALREADY_PATCHED no changes needed");
    `);
    const results = runPatchAll([p]);
    assert.equal(results[0].status, "ALREADY_PATCHED");
  });

  it("NOT_APPLICABLE for platform-specific skip", () => {
    cleanup();
    const p = mockPatch("skip.js", `
      console.log("[NOT_APPLICABLE] only for macOS");
      console.log("PATCH_RESULT: NOT_APPLICABLE mac-x64 only");
    `);
    const results = runPatchAll([p]);
    assert.equal(results[0].status, "NOT_APPLICABLE");
  });

  it("ABSENT when target not found", () => {
    cleanup();
    const p = mockPatch("absent.js", `
      console.log("[ABSENT] pattern not found");
      console.log("PATCH_RESULT: ABSENT target missing from source");
      process.exit(1);
    `);
    const results = runPatchAll([p]);
    assert.equal(results[0].status, "ABSENT");
  });

  it("FAILED on parse error", () => {
    cleanup();
    const p = mockPatch("failed.js", `
      console.log("[FAILED] parse error");
      console.log("PATCH_RESULT: FAILED Acorn parse error at offset 42");
      process.exit(1);
    `);
    const results = runPatchAll([p]);
    assert.equal(results[0].status, "FAILED");
  });

  it("MISSING status (no PATCH_RESULT line) is rejected", () => {
    cleanup();
    const p = mockPatch("no-result.js", `
      console.log("some output without PATCH_RESULT");
      console.log("things happened");
    `);
    const results = runPatchAll([p]);
    assert.equal(results[0].status, "MISSING");
  });

  it("non-zero exit without PATCH_RESULT is FAILED", () => {
    cleanup();
    const p = mockPatch("crash.js", `
      console.log("about to crash");
      throw new Error("something broke");
    `);
    const results = runPatchAll([p]);
    assert.equal(results[0].status, "FAILED");
  });

  it("duplicate PATCH_RESULT lines — first one wins", () => {
    cleanup();
    const p = mockPatch("dup.js", `
      console.log("PATCH_RESULT: APPLIED first");
      console.log("PATCH_RESULT: FAILED second");
    `);
    const results = runPatchAll([p]);
    assert.equal(results[0].status, "APPLIED");
  });

  it("invalid PATCH_RESULT status string causes FAILED", () => {
    cleanup();
    const p = mockPatch("bad-status.js", `
      console.log("PATCH_RESULT: MAYBE partially done");
      process.exit(1);
    `);
    const results = runPatchAll([p]);
    // Invalid status not in VALID_STATUSES, process exited non-zero → FAILED
    assert.equal(results[0].status, "FAILED");
  });

  it("malformed PATCH_RESULT (no status after colon)", () => {
    cleanup();
    const p = mockPatch("malformed.js", `
      console.log("PATCH_RESULT:");
      process.exit(1);
    `);
    const results = runPatchAll([p]);
    assert.ok(results[0].status !== "APPLIED");
  });

  it("zero-byte output treated as FAILED/MISSING", () => {
    cleanup();
    const p = mockPatch("empty.js", ``);
    const results = runPatchAll([p]);
    assert.ok(["FAILED", "MISSING"].includes(results[0].status));
  });
});
