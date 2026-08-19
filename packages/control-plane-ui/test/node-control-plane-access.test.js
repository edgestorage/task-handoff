import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("node settings separates paired control planes from active connections", () => {
  const panel = fs.readFileSync(path.join(root, "src/apps/control-plane/settings/NodeDetailPanel.vue"), "utf8");
  const queries = fs.readFileSync(path.join(root, "src/api/queries.ts"), "utf8");

  assert.match(panel, /resources\.controlPlanePairings/);
  assert.match(panel, /resources\.controlPlaneConnections/);
  assert.match(panel, /connection\.status === 'connected'/);
  assert.match(panel, /node-connection-status-trigger/);
  assert.match(panel, /connection\.pingRttMs/);
  assert.match(panel, /connection\.pingRttP95Ms/);
  assert.match(panel, /connection\.consecutiveReconnects/);
  assert.match(panel, /connectionRetryCountdown\(connection\.nextRetryAt\)/);
  assert.match(panel, /@update:open="refreshConnectionDiagnostics"/);
  assert.doesNotMatch(panel, /remote\.current \?[^\n]*remote\.active/);
  assert.match(queries, /control-plane-pairings/);
  assert.match(queries, /control-plane-connections/);
});
