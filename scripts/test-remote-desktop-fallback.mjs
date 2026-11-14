#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rustRoot = path.join(root, "remote-desktop-rs");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const steps = [
  ["protocol typecheck", pnpm, ["--filter", "@task-handoff/protocol", "build"], root],
  ["runtime-shared typecheck", pnpm, ["--filter", "@task-handoff/runtime-shared", "build"], root],
  ["node-agent typecheck", pnpm, ["--filter", "@task-handoff/node-agent", "build"], root],
  ["control-plane typecheck", pnpm, ["--filter", "@task-handoff/control-plane", "build"], root],
  ["fallback proxy and relay tests", process.execPath, [
    "--import",
    "./test/setup-isolated-runtime.mjs",
    "--test",
    "--test-timeout=30000",
    "test/desktop-ws-backpressure.test.js",
    "test/remote-desktop-fallback-chain.test.js",
    "packages/control-plane/test/remote-desktop-relay-binary.test.ts",
    "packages/control-plane/test/remote-desktop-relay-channel.test.ts",
  ], root],
  ["component fallback unit tests", "cargo", ["test", "-p", "desktop-streaming", "--lib", "fallback"], rustRoot],
  ["synthetic component end-to-end", "cargo", ["test", "-p", "desktop-streaming", "--test", "fallback_chain"], rustRoot],
  ["mobile fallback controller", pnpm, [
    "--filter",
    "@task-handoff/mobile",
    "exec",
    "jest",
    "--runInBand",
    "__tests__/remote-desktop-startup-test.ts",
    "__tests__/remote-desktop-decode-queue-test.ts",
  ], root],
  ["mobile typecheck", pnpm, ["--filter", "@task-handoff/mobile", "typecheck"], root],
  ["control-plane-ui typecheck", pnpm, ["--filter", "@task-handoff/control-plane-ui", "typecheck"], root],
];

for (const [name, command, args, cwd] of steps) {
  process.stdout.write(`\n[remote-desktop fallback] ${name}\n`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

process.stdout.write("\n[remote-desktop fallback] all checks passed\n");
