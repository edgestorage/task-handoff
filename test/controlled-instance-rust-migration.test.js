const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("controlled-instance Rust migration gate covers the complete Node business import closure", async () => {
  const { checkControlledInstanceRustMigration } = await import("../scripts/check-controlled-instance-rust-migration.mjs");
  const report = checkControlledInstanceRustMigration({ root });
  assert.equal(report.inventoryVersion, 1);
  assert.equal(report.entrypoints, 4);
  assert.ok(report.discoveredModules > 150, `expected a complete closure, found ${report.discoveredModules} modules`);
  assert.ok(report.businessModules >= report.discoveredModules - 1);
  assert.deepEqual(report.exceptions, ["packages/controlled-instance/src/opencode-story-plugin.ts"]);
  assert.equal(Object.keys(report.coverage).length, report.businessModules);
});

test("controlled-instance Rust migration gate rejects uncovered business modules", async () => {
  const { checkControlledInstanceRustMigration } = await import("../scripts/check-controlled-instance-rust-migration.mjs");
  assert.throws(
    () => checkControlledInstanceRustMigration({
      root,
      inventory: {
        schemaVersion: 1,
        entrypoints: ["apps/controlled-instance-image/src/cli.ts"],
        exceptions: [],
        adapters: [],
        families: [],
      },
    }),
    /must match exactly one Rust ownership family/,
  );
});
