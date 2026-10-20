#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const require = createRequire(import.meta.url);
const { configuredCloudEnvironmentVariables } = require("../shared/cloud-environments.cjs");

export function writeCloudEnvironmentModule(filePath, environment = process.env) {
  const configured = configuredCloudEnvironmentVariables(environment);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `"use strict";\nmodule.exports = Object.freeze(${JSON.stringify(configured, null, 2)});\n`);
  return configured;
}

const isEntrypoint = Boolean(process.argv[1])
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  const { values } = parseArgs({
    options: {
      out: { type: "string", short: "o" },
    },
  });
  if (!values.out) {
    throw new Error("--out <path> is required.");
  }
  writeCloudEnvironmentModule(path.resolve(values.out));
}
