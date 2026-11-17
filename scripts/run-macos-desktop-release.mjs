#!/usr/bin/env node

import { spawn } from "node:child_process";
import { resolve4 } from "node:dns/promises";
import { isIPv4 } from "node:net";

export const APPLE_TIMESTAMP_ERROR = "A timestamp was expected but was not found";

function appendOutput(output, chunk) {
  const next = output + chunk;
  return next.length > 1_000_000 ? next.slice(-1_000_000) : next;
}

export function runLogged(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { stdio: ["inherit", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output = appendOutput(output, chunk.toString());
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output = appendOutput(output, chunk.toString());
      process.stderr.write(chunk);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) reject(new Error(`Build terminated by signal ${signal}.`));
      else resolve({ code: code ?? 1, output });
    });
  });
}

export async function appleTimestampAddresses(resolve = resolve4) {
  const addresses = await resolve("timestamp.apple.com");
  return addresses.filter((address) => {
    if (!isIPv4(address)) return false;
    const [first, second] = address.split(".").map(Number);
    return first === 17 && second >= 0 && second <= 255;
  }).filter((address, index, all) => all.indexOf(address) === index).slice(0, 3);
}

export async function runWithAppleTimestampFallback(command, options = {}) {
  const run = options.run ?? runLogged;
  const resolve = options.resolve ?? appleTimestampAddresses;
  const initial = await run(command);
  if (initial.code === 0 || !initial.output.includes(APPLE_TIMESTAMP_ERROR)) return initial.code;

  let addresses;
  try {
    addresses = await resolve();
  } catch (error) {
    console.error(`Cannot resolve Apple's timestamp IPv4 path: ${error instanceof Error ? error.message : String(error)}`);
    return initial.code;
  }
  if (addresses.length === 0) return initial.code;

  let result = initial;
  for (const address of addresses) {
    console.error(`Retrying secure Apple timestamp through resolved IPv4 address ${address}`);
    result = await run([...command, `--config.mac.timestamp=http://${address}/ts01`]);
    if (result.code === 0 || !result.output.includes(APPLE_TIMESTAMP_ERROR)) return result.code;
  }
  return result.code;
}

async function main() {
  const command = process.argv.slice(2);
  if (command[0] === "--") command.shift();
  if (command.length === 0) {
    console.error("Usage: node scripts/run-macos-desktop-release.mjs -- <command> [args...]");
    process.exitCode = 1;
    return;
  }
  process.exitCode = await runWithAppleTimestampFallback(command);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
