import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createControlPlaneI18nForTest } from "../src/i18n/testing.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("node resource lists share a centered semantic empty state", () => {
  const panel = read("src/apps/control-plane/settings/NodeDetailPanel.vue");
  const emptyState = read("src/apps/control-plane/settings/NodeResourceEmptyState.vue");

  assert.equal((panel.match(/<NodeResourceEmptyState v-if=/g) || []).length, 8);
  assert.match(panel, /:icon="History" :message="t\('settings\.nodeDetail\.noUpdateJobs'\)"/);
  assert.match(panel, /:icon="Container" :message="t\('settings\.nodeDetail\.noImages'\)"/);
  assert.match(emptyState, /role="status"/);
  assert.match(emptyState, /min-height:\s*96px/);
  assert.match(emptyState, /justify-items:\s*center/);
  assert.match(emptyState, /text-align:\s*center/);
});

test("node resource empty-state labels do not end with sentence punctuation", () => {
  const keys = ["noRuntimes", "noControlledInstances", "noUpdateJobs", "noLocalFolders", "noImages", "noInstances", "noPairedKeys", "noActiveConnections"];

  for (const locale of ["en-US", "zh-CN"]) {
    const t = createControlPlaneI18nForTest(locale).global.t;
    for (const key of keys) assert.doesNotMatch(t(`settings.nodeDetail.${key}`), /[。.！!？?]$/);
  }
});
