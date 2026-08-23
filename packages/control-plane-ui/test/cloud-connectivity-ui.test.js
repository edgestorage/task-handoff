import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("cloud connectivity settings are visible only with settings management permission", () => {
  const settings = read("src/apps/control-plane/settings/SettingsModal.vue");
  assert.match(settings, /permissionIds\.includes\("settings:manage"\)/);
  assert.match(settings, /!manageSettings && settingsSection\.value === "cloud-connectivity"/);
  assert.match(settings, /setSettingsSection\("nodes"\)/);
});

test("cloud binding challenge stays in component memory and mutations use the existing settings API", () => {
  const component = read("src/apps/control-plane/settings/CloudConnectivitySettingsSection.vue");
  const queries = read("src/api/queries.ts");
  assert.match(component, /const challenge = ref<CloudBindingChallenge>/);
  assert.match(component, /window\.open\(challenge\.value\.authorizationUrl/);
  assert.match(component, /navigator\.clipboard\?\.writeText\(challenge\.value\.challengeCode\)/);
  assert.doesNotMatch(component, /localStorage|sessionStorage|setQueryData/);
  assert.match(queries, /postApiData<CloudBindingChallenge>\("cloud-connectivity\/challenges", \{\}\)/);
  assert.match(queries, /postApiData<CloudConnectivity>\("cloud-connectivity\/remote-access"/);
  assert.match(queries, /postApiData<CloudConnectivity>\("cloud-connectivity\/disconnect"/);
});

test("cloud settings explain background ownership and expose structured non-color states", () => {
  const component = read("src/apps/control-plane/settings/CloudConnectivitySettingsSection.vue");
  const english = read("src/i18n/locales/en-US/settings.ts");
  const chinese = read("src/i18n/locales/zh-CN/settings.ts");
  assert.match(component, /settings\.cloud\.backgroundNote/);
  assert.match(component, /role="status"/);
  assert.match(component, /role="alert"/);
  assert.match(component, /state\.status === 'clone-conflict'/);
  assert.match(english, /Closing this page, signing out of the local UI/);
  assert.match(chinese, /关闭此页面、退出本地 UI/);
  assert.doesNotMatch(component, /font-size:(?:[0-9]|1[01])px/);
});
