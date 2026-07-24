import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workbench = fs.readFileSync(new URL("../src/apps/control-plane/ControlPlaneWorkbench.vue", import.meta.url), "utf8");

test("the update indicator keeps details in a tooltip", () => {
  assert.match(workbench, /<TooltipProvider v-if="serverUpdateAvailable" :delay-duration="120">/);
  assert.match(workbench, /<TooltipTrigger as-child>[\s\S]*<span>Update<\/span>[\s\S]*<\/TooltipTrigger>/);
  assert.match(workbench, /<TooltipContent side="bottom" :side-offset="8">Update available · \{\{ serverUpdateVersion \}\}<\/TooltipContent>/);
  assert.doesNotMatch(workbench, /<span>Update available · \{\{ serverUpdateVersion \}\}<\/span>/);
});
