#!/usr/bin/env node

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { DEFAULT_MARKET_CATALOG_PUBLIC_KEY } = require("../apps/desktop-shell/src/config.cjs");

const outIndex = process.argv.indexOf("--out");
const target = outIndex >= 0 && process.argv[outIndex + 1]
  ? path.resolve(process.argv[outIndex + 1])
  : path.join(root, "build", "market-catalog-public-key.txt");
const override = process.env.TASK_HANDOFF_MARKET_CATALOG_PUBLIC_KEY?.trim();

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, `${override || DEFAULT_MARKET_CATALOG_PUBLIC_KEY}\n`, "utf8");
console.log(`desktop market catalog public key written to ${target}`);
