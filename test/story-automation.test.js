const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createNodeAgentApp } = require("../packages/control-plane/src/node-agent.ts");

test("Node Agent owns Story Automation lifecycle and rejects dangling Action updates", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-story-automation-routes-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-story-automation-workspace-"));
  const app = await createNodeAgentApp({ dataDir, logger: false, token: "agent-secret", nodeId: "node_story_automation" });
  t.after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  const headers = { authorization: "Bearer agent-secret" };
  const instance = await app.inject({ method: "POST", url: "/api/node-agent/instances", headers, payload: {
    id: "instance_story_automation", name: "Story worker", runtimeId: "runtime_local_host", source: { type: "local-folder", path: workspace },
  } });
  assert.equal(instance.statusCode, 201, instance.body);

  const storyResponse = await app.inject({ method: "POST", url: "/api/node-agent/stories", headers, payload: {
    title: "Release", actions: [{ title: "Deploy", promptTemplate: "Deploy {{literal}}", targetInstanceId: "instance_story_automation" }],
  } });
  assert.equal(storyResponse.statusCode, 201, storyResponse.body);
  const story = storyResponse.json().data;
  const action = story.actions[0];
  const contentWrite = await app.inject({
    method: "PUT",
    url: `/api/node-agent/stories/${story.id}/content/file?storyPath=missing.txt&title=Missing`,
    headers: { ...headers, "content-type": "application/octet-stream" },
    payload: Buffer.from("temporary"),
  });
  assert.equal(contentWrite.statusCode, 200, contentWrite.body);
  fs.rmSync(path.join(dataDir, "stories", story.id, "missing.txt"));
  const missingContent = await app.inject({
    method: "GET",
    url: `/api/node-agent/stories/${story.id}/content/file?storyPath=missing.txt`,
    headers,
  });
  assert.equal(missingContent.statusCode, 404, missingContent.body);
  assert.equal(missingContent.json().error.code, "STORY_CONTENT_NOT_FOUND");
  const combined = await app.inject({ method: "POST", url: `/api/node-agent/stories/${story.id}/automations/with-action`, headers, payload: {
    action: { id: "action_combined", title: "Verify", promptTemplate: "Verify release", targetInstanceId: "instance_story_automation" },
    automation: { schedule: { scheduleKind: "interval", intervalMs: 120_000 }, enabled: false, policy: { maxConcurrentRuns: 1, whenBusy: "skip" } },
  } });
  assert.equal(combined.statusCode, 201, combined.body);
  assert.equal(combined.json().data.automation.actionId, "action_combined");
  assert.equal((await app.inject({ method: "GET", url: `/api/node-agent/stories/${story.id}`, headers })).json().data.actions.length, 2);
  await app.inject({ method: "DELETE", url: `/api/node-agent/stories/${story.id}/automations/${combined.json().data.automation.id}`, headers });
  const created = await app.inject({ method: "POST", url: `/api/node-agent/stories/${story.id}/automations`, headers, payload: {
    storyId: story.id,
    actionId: action.id,
    schedule: { scheduleKind: "interval", intervalMs: 60_000 },
    enabled: true,
    policy: { maxConcurrentRuns: 1, whenBusy: "queue" },
  } });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().data.effectiveStatus, "scheduled");
  const automationId = created.json().data.automation.id;

  const archived = await app.inject({ method: "POST", url: `/api/node-agent/stories/${story.id}/archive`, headers });
  assert.equal(archived.statusCode, 200);
  const blocked = await app.inject({ method: "GET", url: `/api/node-agent/stories/${story.id}/automations/${automationId}`, headers });
  assert.equal(blocked.json().data.effectiveStatus, "blocked");
  assert.equal(blocked.json().data.blockedReason.code, "STORY_ARCHIVED");
  await app.inject({ method: "POST", url: `/api/node-agent/stories/${story.id}/restore`, headers });

  const dangling = await app.inject({ method: "PATCH", url: `/api/node-agent/stories/${story.id}`, headers, payload: { actions: [] } });
  assert.equal(dangling.statusCode, 409);
  assert.equal(dangling.json().error.code, "STORY_ACTION_AUTOMATION_IN_USE");
  assert.deepEqual(dangling.json().error.details.automationIds, [automationId]);

  const removed = await app.inject({ method: "DELETE", url: `/api/node-agent/stories/${story.id}/automations/${automationId}`, headers });
  assert.deepEqual(removed.json().data, { deleted: true });
  const updated = await app.inject({ method: "PATCH", url: `/api/node-agent/stories/${story.id}`, headers, payload: { actions: [] } });
  assert.equal(updated.statusCode, 200, updated.body);
});
