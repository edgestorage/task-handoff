import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createControlPlaneI18nForTest } from "../src/i18n/testing.ts";

const sourceStep = fs.readFileSync(new URL("../src/apps/control-plane/new-instance/SourceStep.vue", import.meta.url), "utf8");
const newInstanceModal = fs.readFileSync(new URL("../src/apps/control-plane/NewInstanceModal.vue", import.meta.url), "utf8");

test("new instance defaults to local folders and shows them before repositories", () => {
  const localFolderChoice = sourceStep.indexOf("@click=\"$emit('select-source-mode', 'local-folder')\"");
  const repositoryChoice = sourceStep.indexOf("@click=\"$emit('select-source-mode', 'project')\"");

  assert.notEqual(localFolderChoice, -1);
  assert.notEqual(repositoryChoice, -1);
  assert.ok(localFolderChoice < repositoryChoice);
  assert.match(newInstanceModal, /const sourceDraft = reactive<SourceDraft>\(\{\s*mode: "local-folder" as SourceMode,/);
});

test("new instances leave automatic agent config imports unchecked by default", () => {
  assert.match(newInstanceModal, /const instanceDraft = reactive<InstanceDraft>\(\{\s*name: "",\s*autoImportAgentConfigs: false,/);
  assert.match(newInstanceModal, /instanceDraft\.autoImportAgentConfigs = false;/);
});

test("new instance source names the local folder field as a project folder with a workspace hint", () => {
  assert.match(sourceStep, /t\("instances\.create\.projectFolder"\)/);
  assert.match(sourceStep, /:aria-label="t\('instances\.create\.projectFolder'\)"/);
  assert.match(sourceStep, /t\("instances\.create\.projectFolderHint"\)/);
  assert.doesNotMatch(sourceStep, /instances\.create\.nodeFolder/);

  const zh = createControlPlaneI18nForTest("zh-CN").global;
  const en = createControlPlaneI18nForTest("en-US").global;
  assert.equal(zh.t("instances.create.projectFolder"), "项目文件夹");
  assert.match(zh.t("instances.create.projectFolderHint"), /工作区|容器/);
  assert.equal(en.t("instances.create.projectFolder"), "Project folder");
  assert.match(en.t("instances.create.projectFolderHint"), /workspace/);
});
