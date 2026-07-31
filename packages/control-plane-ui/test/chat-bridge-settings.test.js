import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startSavedChatBridge } from "../src/apps/control-plane/settings/chatBridgeToggle.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("a failed chat bridge start refreshes the successfully persisted config", async () => {
  const calls = [];

  await assert.rejects(startSavedChatBridge({
    persist: async () => {
      calls.push("persist");
      return true;
    },
    start: async () => {
      calls.push("start");
      throw new Error("start failed");
    },
    refresh: async () => { calls.push("refresh"); },
  }), /start failed/);

  assert.deepEqual(calls, ["persist", "start", "refresh"]);
});

test("a refresh failure does not hide the chat bridge start error", async () => {
  await assert.rejects(startSavedChatBridge({
    persist: async () => true,
    start: async () => { throw new Error("start failed"); },
    refresh: async () => { throw new Error("refresh failed"); },
  }), /start failed/);
});

test("a deferred chat bridge refresh syncs the form from the PATCH response", () => {
  const source = fs.readFileSync(path.join(root, "src/apps/control-plane/settings/useChatBridgeSettings.ts"), "utf8");

  assert.match(source, /const updated = await updateChatBridge/);
  assert.match(source, /syncChatForm\(updated\);\s*if \(refreshAfterSave\) await refresh\(\);/);
  assert.doesNotMatch(source, /if \(refreshAfterSave\) await refresh\(\);\s*syncChatForm\(\);/);
});
