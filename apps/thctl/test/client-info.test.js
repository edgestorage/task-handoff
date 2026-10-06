import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { THCTL_VERSION, cliClientInfo, installedCliVersion } from "../src/client-info.ts";

const packageVersion = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
).version;

test("thctl reports the installed CLI version instead of TASK_HANDOFF_VERSION", () => {
  const previous = process.env.TASK_HANDOFF_VERSION;
  process.env.TASK_HANDOFF_VERSION = "9.9.9";
  try {
    assert.equal(installedCliVersion(), packageVersion);
    assert.equal(THCTL_VERSION, packageVersion);
    assert.equal(cliClientInfo().version, packageVersion);
  } finally {
    if (previous === undefined) delete process.env.TASK_HANDOFF_VERSION;
    else process.env.TASK_HANDOFF_VERSION = previous;
  }
});
