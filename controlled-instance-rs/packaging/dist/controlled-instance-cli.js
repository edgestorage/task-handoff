#!/usr/bin/env node
"use strict";

// Compatibility adapter for launcher ABI 1. The controlled instance runtime is
// the platform-specific Rust binary selected below; this file owns no product
// state or business behavior.
const { spawn } = require("node:child_process");
const { constants } = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const executableName = `controlled-instance-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;
const releaseRoot = path.resolve(__dirname, "..");
const executable = path.join(releaseRoot, "bin", executableName);

if (!fs.existsSync(executable)) {
  process.stderr.write(`Controlled instance runtime binary is missing: bin/${executableName}\n`);
  process.exit(1);
}

if (process.platform !== "win32" && typeof process.execve === "function") {
  try {
    process.execve(executable, [executable, ...process.argv.slice(2)], process.env);
  } catch (error) {
    process.stderr.write(`Controlled instance runtime failed to start: ${error.message}\n`);
    process.exit(1);
  }
}

const child = spawn(executable, process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
  windowsHide: true,
});

const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
for (const signal of forwardedSignals) {
  try {
    process.on(signal, () => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    });
  } catch {
    // Some signals are unavailable on Windows.
  }
}

child.once("error", (error) => {
  process.stderr.write(`Controlled instance runtime failed to start: ${error.message}\n`);
  process.exit(1);
});

child.once("exit", (code, signal) => {
  if (code !== null) process.exit(code);
  process.exit(signal ? 128 + (constants.signals[signal] || 0) : 1);
});
