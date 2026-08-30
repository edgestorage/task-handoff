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

test("chat bridge settings use the shared directory, portal menu, and dialog patterns", () => {
  const source = fs.readFileSync(path.join(root, "src/apps/control-plane/settings/ChatBridgeSettingsSection.vue"), "utf8");

  assert.match(source, /class="chat-toolbar"/);
  assert.match(source, /data-chat-bridge-row/);
  assert.match(source, /<DropdownMenu>/);
  assert.match(source, /<Dialog :open="editorOpen"/);
  assert.match(source, /<AlertDialog :open="Boolean\(pendingDelete\)"/);
  assert.match(source, /@click="confirmDelete\(deleteCandidate\)"/);
  assert.match(source, /const deleteCandidate = ref<ChatBridgeConfig>/);
  assert.match(source, /chatDraftDirty\.value/);
  assert.doesNotMatch(source, /chat-settings-grid/);
  assert.doesNotMatch(source, /chatBridgeSuccess/);
  assert.doesNotMatch(source, /font-size:\s*11px/);
});

test("directory start never persists another bridge's selected draft", () => {
  const source = fs.readFileSync(path.join(root, "src/apps/control-plane/settings/useChatBridgeSettings.ts"), "utf8");

  assert.match(source, /async function toggleChatBridge\(bridge: ChatBridgeConfig, persistDraft = false\)/);
  assert.match(source, /persist: persistDraft \? \(\) => persistSelectedChatBridge\(false\) : async \(\) => true/);
  assert.match(source, /return bridge \? toggleChatBridge\(bridge, true\)/);
});

test("chat bridge mutations use global delayed loading and result toasts", () => {
  const source = fs.readFileSync(path.join(root, "src/apps/control-plane/settings/useChatBridgeSettings.ts"), "utf8");

  assert.match(source, /showDelayedControlPlaneLoadingToast/);
  assert.match(source, /showControlPlaneToast\(t\("settings\.chatBridge\.saved"[\s\S]*?"success"\)/);
  assert.doesNotMatch(source, /const chatBridgeSuccess/);
});
