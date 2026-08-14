import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildInstanceDetailPath,
  openInstanceDetailWindow,
  parseInstanceDetailRoute,
} from "../src/apps/control-plane/instance-detail/instanceDetailWindow.ts";

test("builds and parses one encoded instance detail path segment", () => {
  const path = buildInstanceDetailPath("instance name+#");
  assert.equal(path, "/instance-detail/instance%20name%2B%23");
  assert.deepEqual(parseInstanceDetailRoute({ pathname: path, search: "", hash: "" }), { instanceId: "instance name+#" });
});

test("rejects malformed or ambiguous instance detail routes", () => {
  for (const location of [
    { pathname: "/instance-detail/", search: "", hash: "" },
    { pathname: "/instance-detail/a/b", search: "", hash: "" },
    { pathname: "/instance-detail/%E0%A4%A", search: "", hash: "" },
    { pathname: "/instance-detail/a", search: "?target=b", hash: "" },
    { pathname: "/instance-detail/a", search: "", hash: "#b" },
  ]) assert.equal(parseInstanceDetailRoute(location), undefined);
});

test("desktop IPC rejection becomes a visible structured failure", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {
    location: { origin: "http://localhost:18081" },
    taskHandoffDesktop: { openInstanceDetailWindow: async () => { throw new Error("missing handler"); } },
  };
  try {
    assert.deepEqual(await openInstanceDetailWindow("instance-a"), {
      ok: false,
      action: "error",
      code: "desktop-ipc-failed",
      instanceId: "instance-a",
    });
  } finally {
    globalThis.window = previousWindow;
  }
});

test("collapsed instance switcher forwards open-window to the workbench", () => {
  const source = readFileSync(new URL("../src/apps/control-plane/instance-list/InstanceList.vue", import.meta.url), "utf8");
  const collapsedSwitcher = source.match(/<InstanceList[\s\S]*?\/>/)?.[0] || "";
  assert.match(collapsedSwitcher, /@open-window="\(instance\) => \$emit\('openWindow', instance\)"/);
});

test("instance detail uses the compact pop-out action only in the main workbench", () => {
  const source = readFileSync(new URL("../src/apps/control-plane/instance-detail/InstanceDetail.vue", import.meta.url), "utf8");
  assert.match(source, /<TooltipProvider v-if="!standalone" :delay-duration="120">[\s\S]*?<Button variant="outline" size="icon-sm" :aria-label="t\('instances\.window\.openInNewWindow'\)"/);
});
