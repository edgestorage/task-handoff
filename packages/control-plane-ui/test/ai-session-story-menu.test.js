import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { aiSessionStoryTarget, storyTargetNodeLabel } from "../src/components/ai-session/storyTarget.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Story assignment menu displays the node name with an id fallback", () => {
  const target = aiSessionStoryTarget(
    { id: "instance-1", nodeId: "node-1", node: { name: "开发节点" } },
    { id: "session-1", storyId: null },
  );

  assert.equal(storyTargetNodeLabel(target, "node-1"), "开发节点");
  assert.equal(storyTargetNodeLabel(undefined, "node-1"), "node-1");

  const menu = fs.readFileSync(path.join(root, "src/components/ai-session/AiSessionCardContextMenu.vue"), "utf8");
  assert.match(menu, /storyTargetNodeLabel\(storyTarget, story\.ownerNodeId\)/);
});
