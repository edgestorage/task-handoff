#!/usr/bin/env node
/**
 * Guards the two copies of the cloud contracts against silent drift.
 *
 * `ee/cloud-platform/packages/contracts` is the host copy (the cloud platform
 * consumes it directly); `packages/cloud-contracts` is the consumer copy used by
 * this repository's Control Plane/mobile side. The copies deliberately differ in
 * import extensions (`.js` host, `.ts` consumer) and in host/consumer-only server
 * schemas, so this check compares the wire vocabulary instead of raw bytes:
 *
 *  - every export name in the consumer copy MUST exist in the host copy, so a
 *    wire schema the cloud does not know can neither be shipped nor parsed;
 *  - `versions.ts` (protocol versions, audiences, lease constants) and
 *    `relay-frame.ts` (the framing both sides parse) MUST be identical after
 *    comment/import-extension normalization;
 *  - `relay.ts` keeps one deliberate consumer-only exception: the TTY snapshot
 *    envelope describes E2E content the cloud is forbidden from parsing.
 *
 * The lock records the expected export names per side plus the version/framing
 * hashes, so each repository's CI (which only checks out its own copy) can verify
 * its side, while a local checkout with both copies also cross-checks them.
 *
 * Usage: `node scripts/check-cloud-contracts-sync.mjs [--write]`
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = path.join(root, "scripts", "cloud-contracts-sync.lock.json");
const write = process.argv.includes("--write");

const firstExisting = (candidates) => candidates.find((candidate) => existsSync(candidate));
const hostDir = firstExisting([
  path.join(root, "ee", "cloud-platform", "packages", "contracts", "src"),
  path.join(root, "packages", "contracts", "src"),
]);
const consumerDir = firstExisting([
  path.join(root, "packages", "cloud-contracts", "src"),
  path.join(root, "..", "..", "packages", "cloud-contracts", "src"),
]);
if (!hostDir && !consumerDir) {
  console.error("cloud-contracts sync: neither copy found; check the repository layout.");
  process.exit(1);
}

const sharedFiles = ["account", "binding", "client", "common", "device-auth", "e2e", "index", "mobile", "mobile-client", "node-relay", "relay", "relay-frame", "relay-session", "versions"];
const consumerOnly = { "relay.ts": ["RelayTtySnapshotEnvelopeSchema", "RelayTtySnapshotEnvelope"] };

const exportNames = (source) => [...source.matchAll(/^export (?:const|function|class|type|interface|enum)\s+(\w+)/gm)].map((match) => match[1]).sort();
const normalize = (source) => source
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("//"))
  .map((line) => line.replace(/\.ts"/g, '.js"').replace(/\s+/g, " ").trim())
  .filter(Boolean)
  .join("\n");
const hash = (text) => createHash("sha256").update(text).digest("hex");

const readSide = (dir) => {
  const sources = {};
  if (dir) for (const file of sharedFiles) if (existsSync(path.join(dir, `${file}.ts`))) sources[file] = readFileSync(path.join(dir, `${file}.ts`), "utf8");
  return sources;
};
const host = readSide(hostDir);
const consumer = readSide(consumerDir);
if (!Object.keys(host).length && !Object.keys(consumer).length) {
  console.error("cloud-contracts sync: no shared contract files found.");
  process.exit(1);
}

const failures = [];
if (host.versions && consumer.versions && normalize(host.versions) !== normalize(consumer.versions)) failures.push("versions.ts: the two copies differ after normalization (protocol constants and audiences must stay identical)");
if (host["relay-frame"] && consumer["relay-frame"] && normalize(host["relay-frame"]) !== normalize(consumer["relay-frame"])) failures.push("relay-frame.ts: the two copies differ after normalization (both sides parse this framing)");
if (host["device-auth"] && consumer["device-auth"] && normalize(host["device-auth"]) !== normalize(consumer["device-auth"])) failures.push("device-auth.ts: the two copies differ after normalization (canonical device authentication inputs must stay identical)");
if (host.relay && consumer.relay) {
  const allowed = new Set(consumerOnly["relay.ts"]);
  const hostNames = new Set(exportNames(host.relay));
  const missing = exportNames(consumer.relay).filter((name) => !hostNames.has(name) && !allowed.has(name));
  if (missing.length) failures.push(`relay.ts: consumer exports missing from the host copy: ${missing.join(", ")}`);
}

const current = {
  sharedFiles,
  versions: hash(normalize(host.versions ?? consumer.versions ?? "")),
  relayFrame: hash(normalize(host["relay-frame"] ?? consumer["relay-frame"] ?? "")),
  deviceAuth: hash(normalize(host["device-auth"] ?? consumer["device-auth"] ?? "")),
  exports: {
    host: hostDir ? Object.fromEntries(Object.entries(host).map(([file, source]) => [file, exportNames(source)])) : undefined,
    consumer: consumerDir ? Object.fromEntries(Object.entries(consumer).map(([file, source]) => [file, exportNames(source)])) : undefined,
  },
};

const differences = (left, right) => {
  const leftSet = new Set(left); const rightSet = new Set(right);
  return [...leftSet].filter((name) => !rightSet.has(name)).map((name) => `+${name}`).concat([...rightSet].filter((name) => !leftSet.has(name)).map((name) => `-${name}`));
};

if (write) {
  writeFileSync(lockPath, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`cloud-contracts sync: lock updated (versions ${current.versions.slice(0, 12)}…, framing ${current.relayFrame.slice(0, 12)}…).`);
} else if (!existsSync(lockPath)) {
  failures.push("cloud-contracts sync lock is missing; run with --write from a checkout that has both copies.");
} else {
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  if (lock.versions !== current.versions) failures.push(`versions.ts drifted from the locked vocabulary (expected ${String(lock.versions).slice(0, 12)}…, computed ${current.versions.slice(0, 12)}…)`);
  if (lock.relayFrame !== current.relayFrame) failures.push(`relay-frame.ts drifted from the locked framing (expected ${String(lock.relayFrame).slice(0, 12)}…, computed ${current.relayFrame.slice(0, 12)}…)`);
  if (lock.deviceAuth !== current.deviceAuth) failures.push(`device-auth.ts drifted from the locked canonical input (expected ${String(lock.deviceAuth).slice(0, 12)}…, computed ${current.deviceAuth.slice(0, 12)}…)`);
  for (const side of ["host", "consumer"]) {
    if (!current.exports[side]) continue;
    if (!lock.exports?.[side]) { failures.push(`the lock has no recorded ${side} exports; run with --write from a checkout that has both copies.`); continue; }
    for (const [file, names] of Object.entries(current.exports[side])) {
      const changed = differences(names, lock.exports[side][file] ?? []);
      if (changed.length) failures.push(`${side} ${file}.ts export surface changed: ${changed.join(", ")}`);
    }
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`cloud-contracts sync: ${failure}`);
  process.exit(1);
}
console.log("cloud-contracts sync check passed (shared wire vocabulary consistent).");
