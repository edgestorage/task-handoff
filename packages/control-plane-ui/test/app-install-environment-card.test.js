import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("install environment groups policy, runtime, and effective sources in one panel", () => {
  const card = read("src/apps/control-plane/instance-settings/AppInstallEnvironmentCard.vue");

  assert.match(card, /class="install-environment-panel"/);
  assert.match(card, /class="install-environment-row"[\s\S]*installSourceProfileDescription/);
  assert.match(card, /class="install-environment-row install-environment-runtime"/);
  assert.match(card, /class="install-environment-effective"/);
  assert.match(card, /:aria-label="t\('instances\.settings\.installSourceProfile'\)"/);
  assert.doesNotMatch(card, /install-environment-(?:grid|node-title|control)/);
});

test("connection tests only target saved sources and discard stale results", () => {
  const card = read("src/apps/control-plane/instance-settings/AppInstallEnvironmentCard.vue");

  assert.match(card, /watch\(\[profile, custom\][\s\S]*?checks\.value = undefined/);
  assert.match(card, /:disabled="busy \|\| !environment \|\| changed"/);
  assert.match(card, /installSourcesTestNeedsSave/);
  assert.match(card, /checkLabel\(check\.id\)/);
});

test("toolchain preparation is only offered when the instance lacks Node.js", () => {
  const card = read("src/apps/control-plane/instance-settings/AppInstallEnvironmentCard.vue");

  assert.match(card, /nodeStatus\.value\?\.state === "missing"/);
  assert.match(card, /&& !nodeStatus\.value\.reason/);
  assert.match(card, /v-if="canPrepareToolchain"/);
  assert.doesNotMatch(card, /v-if="nodeToolchainSupported"/);
});

test("install environment copy is localized and keeps text at least 12px", () => {
  const card = read("src/apps/control-plane/instance-settings/AppInstallEnvironmentCard.vue");
  const english = read("src/i18n/locales/en-US/instances.ts");
  const chinese = read("src/i18n/locales/zh-CN/instances.ts");
  const keys = [
    "installSourceCustomEndpoints",
    "installSourceCustomEndpointsDescription",
    "installSourcesChanged",
    "installSourcesTestNeedsSave",
    "nodejsLabel",
    "npmLabel",
  ];

  for (const key of keys) {
    assert.match(english, new RegExp(`${key}:`));
    assert.match(chinese, new RegExp(`${key}:`));
  }
  for (const match of card.matchAll(/font-size:\s*(\d+)px/g)) {
    assert.ok(Number(match[1]) >= 12, `font-size ${match[1]}px is below the 12px UI minimum`);
  }
});

test("install environment typography matches instance settings headings and rows", () => {
  const card = read("src/apps/control-plane/instance-settings/AppInstallEnvironmentCard.vue");

  assert.match(card, /\.install-environment-heading h3\s*\{[^}]*font-size: 14px;[^}]*font-weight: 600;/);
  assert.match(card, /\.install-environment-heading p\s*\{[^}]*font-size: 13px;/);
  assert.match(card, /\.install-environment-runtime-title strong,[\s\S]*?font-size: 13px; font-weight: 500;/);
});
