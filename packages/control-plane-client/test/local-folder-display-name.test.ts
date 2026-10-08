import assert from "node:assert/strict";
import test from "node:test";
import { ControlPlaneNodeLocalFolderSchema, controlPlaneLocalFolderDisplayName, resolveLocalizedDisplayName } from "../src/resources.ts";

const TS = "2026-10-02T00:00:00.000Z";

function folder(overrides: Record<string, unknown> = {}) {
  return {
    id: "folder_0000000000001",
    nodeId: "nod_0000000000001",
    name: "Assistant",
    path: "/home/agent/builtin-projects/assistant",
    localizedNames: { "en-US": "Assistant", "zh-CN": "助理" },
    labels: {},
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

test("node local folder schema keeps the node-agent derived origin and localized names", () => {
  const parsed = ControlPlaneNodeLocalFolderSchema.parse(folder({ origin: "builtin" }));
  assert.equal(parsed.origin, "builtin");
  assert.equal(parsed.localizedNames?.["zh-CN"], "助理");
  assert.equal(ControlPlaneNodeLocalFolderSchema.parse(folder()).origin, undefined);
});

test("display names resolve exact locale, then language, then the canonical name", () => {
  assert.equal(controlPlaneLocalFolderDisplayName(folder(), "zh-CN"), "助理");
  assert.equal(controlPlaneLocalFolderDisplayName(folder(), "zh-Hans-CN"), "Assistant");
  assert.equal(controlPlaneLocalFolderDisplayName(folder(), "en"), "Assistant");
  assert.equal(controlPlaneLocalFolderDisplayName(folder(), "fr-FR"), "Assistant");
  assert.equal(controlPlaneLocalFolderDisplayName(folder({ localizedNames: undefined }), "zh-CN"), "Assistant");
});

test("operator folders fall back to the canonical name and then the path basename", () => {
  assert.equal(controlPlaneLocalFolderDisplayName({ name: "Workspace", path: "/home/agent/workspace" }, "zh-CN"), "Workspace");
  assert.equal(controlPlaneLocalFolderDisplayName({ name: "  ", path: "/home/agent/workspace/" }), "workspace");
});

test("localized name lookup ignores absent entries and locales", () => {
  assert.equal(resolveLocalizedDisplayName(undefined, "zh-CN"), undefined);
  assert.equal(resolveLocalizedDisplayName({ "zh-CN": "助理" }, undefined), undefined);
});
