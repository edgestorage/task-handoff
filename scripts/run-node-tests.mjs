#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";

const patterns = [
  "test/*.test.*",
  "apps/*/test/*.test.*",
  "packages/protocol/test/*.test.*",
  "packages/*/*.test.*",
];
const shard = process.env.TASK_HANDOFF_TEST_SHARD;
const extraArgs = process.argv.slice(2);
if (extraArgs[0] === "--") extraArgs.shift();
const args = [
  "--import",
  "./test/setup-isolated-runtime.mjs",
  "--test",
  "--test-timeout=30000",
];

if (shard) {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(shard);
  if (!match) throw new Error(`TASK_HANDOFF_TEST_SHARD must be <index>/<total>, got ${shard}`);
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (index > total) throw new Error(`TASK_HANDOFF_TEST_SHARD index ${index} exceeds total ${total}`);
  args.push(`--test-shard=${shard}`);
}

const files = [...new Set(patterns.flatMap((pattern) => globSync(pattern)))].sort();
if (!files.length) throw new Error("No Node test files matched the configured patterns.");
args.push(...extraArgs);
args.push(...files);

const result = spawnSync(process.execPath, args, { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
