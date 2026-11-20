import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkControlledInstanceRustMigration } from "./check-controlled-instance-rust-migration.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inventory = JSON.parse(fs.readFileSync(
  path.join(root, "controlled-instance-rs/docs/migration-inventory.json"),
  "utf8",
));
const report = checkControlledInstanceRustMigration({ root });
const familiesBySource = new Map(inventory.families.map((family) => [family.source, family]));
const modulesByVerification = new Map();

for (const source of Object.values(report.coverage)) {
  const family = familiesBySource.get(source);
  if (!family) throw new Error(`Migration family is missing for ${source}`);
  const modules = modulesByVerification.get(family.verification) ?? [];
  modules.push(source);
  modulesByVerification.set(family.verification, modules);
}

const verificationOrder = [
  "unit-and-contract-tested",
  "unit-and-contract-tested-differential-partial",
  "unit-tested-platform-runtime-unverified",
  "unit-tested-behavior-gap",
  "compatibility-surface-only",
];
const compatibilityModules = modulesByVerification.get("compatibility-surface-only")?.length ?? 0;
const migrationModules = report.businessModules - compatibilityModules;
const rows = verificationOrder.map((verification) => {
  const modules = modulesByVerification.get(verification)?.length ?? 0;
  const families = inventory.families.filter((family) => family.verification === verification).length;
  return {
    verification,
    families,
    modules,
    share: verification === "compatibility-surface-only" ? null : modules / migrationModules,
  };
});
const behaviorGaps = inventory.families
  .filter((family) => family.verification === "unit-tested-behavior-gap")
  .flatMap((family) => family.limitations.map((limitation) => ({ source: family.source, limitation })));

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({
    discoveredModules: report.discoveredModules,
    businessModules: report.businessModules,
    compatibilityModules,
    migrationModules,
    families: report.families,
    rows,
    behaviorGaps,
  }, null, 2));
  process.exit(0);
}

console.log("# Controlled Instance Rust Migration Progress\n");
console.log(`- Import closure: ${report.discoveredModules} modules`);
console.log(`- Migration denominator: ${report.businessModules} business modules - ${compatibilityModules} compatibility-surface modules = ${migrationModules}`);
console.log(`- Families: ${report.families}`);
console.log(`- Fully accepted families: 0; every migration family still lists at least one pending limitation.\n`);
console.log("| Verification evidence | Families | Modules | Share of migration denominator |");
console.log("|---|---:|---:|---:|");
for (const row of rows) {
  const share = row.share === null ? "excluded" : `${(row.share * 100).toFixed(1)}%`;
  console.log(`| ${row.verification} | ${row.families} | ${row.modules} | ${share} |`);
}
if (behaviorGaps.length) {
  console.log("\n## Named behavior gaps\n");
  for (const gap of behaviorGaps) console.log(`- ${gap.source}: ${gap.limitation}`);
}
