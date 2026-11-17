import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  APPLE_TIMESTAMP_ERROR,
  appleTimestampAddresses,
  runWithAppleTimestampFallback,
} from "../scripts/run-macos-desktop-release.mjs";

const command = ["pnpm", "exec", "electron-builder", "--mac", "--arm64", "--x64"];

test("desktop workflow signs macOS builds through the Apple timestamp fallback", () => {
  const workflow = fs.readFileSync(new URL("../.github/workflows/desktop-release.yml", import.meta.url), "utf8");
  const buildJob = /^  build:\n([\s\S]*?)(?=^  [a-zA-Z0-9-]+:)/m.exec(workflow)?.[1];
  assert.ok(buildJob, "desktop build job must exist");
  assert.match(buildJob, /Check out release helper/);
  assert.match(buildJob, /sparse-checkout: scripts\/run-macos-desktop-release\.mjs/);
  assert.match(workflow, /sparse-checkout: scripts\/run-macos-desktop-release\.mjs/);
  assert.match(workflow, /run: node \.release-helper\/scripts\/run-macos-desktop-release\.mjs -- pnpm exec electron-builder --\$\{\{ matrix\.target \}\}/);
});

test("macOS release build succeeds without resolving or retrying", async () => {
  const calls = [];
  const code = await runWithAppleTimestampFallback(command, {
    run: async (args) => {
      calls.push(args);
      return { code: 0, output: "notarization successful" };
    },
    resolve: async () => assert.fail("unexpected timestamp resolution"),
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, [command]);
});

test("only missing Apple timestamp failures retry through an IPv4 endpoint", async () => {
  const calls = [];
  const code = await runWithAppleTimestampFallback(command, {
    run: async (args) => {
      calls.push(args);
      return calls.length === 1
        ? { code: 1, output: `${APPLE_TIMESTAMP_ERROR}.` }
        : { code: 0, output: "notarization successful" };
    },
    resolve: async () => ["17.157.80.35"],
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, [command, [...command, "--config.mac.timestamp=http://17.157.80.35/ts01"]]);
});

test("signing errors unrelated to Apple timestamps do not retry", async () => {
  const calls = [];
  const code = await runWithAppleTimestampFallback(command, {
    run: async (args) => {
      calls.push(args);
      return { code: 7, output: "Developer ID identity is missing" };
    },
    resolve: async () => assert.fail("unexpected timestamp resolution"),
  });
  assert.equal(code, 7);
  assert.deepEqual(calls, [command]);
});

test("timestamp retries accept only bounded trusted Apple IPv4 addresses", async () => {
  const addresses = await appleTimestampAddresses(async () => [
    "17.157.80.35",
    "17.157.80.35",
    "127.0.0.1",
    "not-an-address",
    "17.253.1.1",
    "17.253.1.2",
    "17.253.1.3",
  ]);
  assert.deepEqual(addresses, ["17.157.80.35", "17.253.1.1", "17.253.1.2"]);
});

test("later signing failures are returned without accepting the build", async () => {
  let attempts = 0;
  const code = await runWithAppleTimestampFallback(command, {
    run: async () => {
      attempts += 1;
      return attempts === 1
        ? { code: 1, output: APPLE_TIMESTAMP_ERROR }
        : { code: 9, output: "Notarization rejected" };
    },
    resolve: async () => ["17.157.80.35"],
  });
  assert.equal(code, 9);
  assert.equal(attempts, 2);
});

test("resolver failures preserve the original signing failure", async () => {
  const code = await runWithAppleTimestampFallback(command, {
    run: async () => ({ code: 3, output: APPLE_TIMESTAMP_ERROR }),
    resolve: async () => {
      throw new Error("DNS unavailable");
    },
  });
  assert.equal(code, 3);
});
