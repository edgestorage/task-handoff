import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("node settings separates paired control planes from active connections", () => {
  const panel = fs.readFileSync(path.join(root, "src/apps/control-plane/settings/NodeDetailPanel.vue"), "utf8");
  const modal = fs.readFileSync(path.join(root, "src/apps/control-plane/settings/SettingsModal.vue"), "utf8");
  const diagnostics = fs.readFileSync(path.join(root, "src/apps/control-plane/settings/NodeConnectionDiagnostics.vue"), "utf8");
  const queries = fs.readFileSync(path.join(root, "src/api/queries.ts"), "utf8");
  const zh = fs.readFileSync(path.join(root, "src/i18n/locales/zh-CN/settings.ts"), "utf8");
  const en = fs.readFileSync(path.join(root, "src/i18n/locales/en-US/settings.ts"), "utf8");

  assert.match(panel, /resources\.controlPlanePairings/);
  assert.match(panel, /resources\.controlPlaneConnections/);
  assert.match(panel, /connection\.status === 'connected'/);
  assert.match(panel, /node-connection-status-trigger/);
  assert.match(panel, /<NodeConnectionDiagnostics :diagnostics="connection"/);
  assert.match(diagnostics, /props\.diagnostics\?\.status === "connected"/);
  assert.match(diagnostics, /settings\.nodeDetail\.connectionWaitingFirstSample/);
  assert.match(diagnostics, /common\.status\.unavailable/);
  assert.match(panel, /@update:open="refreshConnectionDiagnostics"/);
  assert.match(panel, /:diagnostics="selectedNode\.connectionDiagnostics"/);
  assert.match(panel, /@update:open="refreshNodeConnectionDiagnostics"/);
  assert.match(modal, /:diagnostics="target\.connectionDiagnostics"/);
  assert.match(modal, /@update:open="refreshNodeConnectionDiagnostics"/);
  assert.match(diagnostics, /diagnostics\?\.pingRttMs/);
  assert.match(diagnostics, /diagnostics\?\.pingRttP95Ms/);
  assert.match(diagnostics, /diagnostics\?\.consecutiveReconnects/);
  assert.match(diagnostics, /retryCountdown\(diagnostics\?\.nextRetryAt\)/);
  assert.doesNotMatch(panel, /remote\.current \?[^\n]*remote\.active/);
  assert.match(queries, /control-plane-pairings/);
  assert.match(queries, /control-plane-connections/);
  assert.match(zh, /inventory: "清单", remote: "连接"/);
  assert.match(en, /inventory: "Inventory", remote: "Connections"/);
});
