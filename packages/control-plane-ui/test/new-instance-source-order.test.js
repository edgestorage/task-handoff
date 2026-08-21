import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const sourceStep = fs.readFileSync(new URL("../src/apps/control-plane/new-instance/SourceStep.vue", import.meta.url), "utf8");

test("new instance workspace choices show local folders before repositories", () => {
  const localFolderChoice = sourceStep.indexOf("@click=\"$emit('select-source-mode', 'local-folder')\"");
  const repositoryChoice = sourceStep.indexOf("@click=\"$emit('select-source-mode', 'project')\"");

  assert.notEqual(localFolderChoice, -1);
  assert.notEqual(repositoryChoice, -1);
  assert.ok(localFolderChoice < repositoryChoice);
});
