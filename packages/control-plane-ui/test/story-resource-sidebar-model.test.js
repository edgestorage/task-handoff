import assert from "node:assert/strict";
import test from "node:test";
import { computed, effectScope, nextTick, ref } from "vue";
import {
  activeStoryResourceKey,
  closeStoryResourceTarget,
  instanceAppResourceRefs,
  parseStoryResourceKey,
  repositoryResource,
  storyBrowserSessionSelection,
  storyResourceKey,
  upsertAiSessionRepositoryResource,
} from "../src/apps/control-plane/story/storyResources.ts";
import { normalizeStoryResourceSidebarWidth, useStoryResourceSidebar } from "../src/apps/control-plane/story/useStoryResourceSidebar.ts";
import { storyResourceSidebarKeyboardWidth, storyResourceSidebarMaxWidth, storyResourceSidebarMode, storyResourceSidebarProportionalWidth } from "../src/apps/control-plane/story/storyResourceLayout.ts";

function instance(id, sessions = []) {
  return { id, apps: { sessions }, aiSessions: { sessions: [] } };
}

function localStorageWindow() {
  const values = new Map();
  return {
    values,
    window: { localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) } },
  };
}

test("resource identity follows the authoritative owner for each resource kind", () => {
  const firstApp = { kind: "app-session", instanceId: "instance-a", sessionId: "same" };
  const secondApp = { ...firstApp, instanceId: "instance-b" };
  assert.notEqual(storyResourceKey(firstApp), storyResourceKey(secondApp));
  assert.deepEqual(parseStoryResourceKey(storyResourceKey(firstApp)), firstApp);

  const firstRepository = repositoryResource("ai-a", "instance-a", "ai-session", "repo", "files");
  const secondRepository = repositoryResource("ai-b", "instance-a", "ai-session", "repo", "files");
  assert.notEqual(storyResourceKey(firstRepository), storyResourceKey(secondRepository));

  const firstWorktree = repositoryResource("ai-a", "instance-a", "ai-session", "repo", "files", undefined, "worktree-a");
  const secondWorktree = repositoryResource("ai-a", "instance-a", "ai-session", "repo", "files", undefined, "worktree-b");
  assert.notEqual(storyResourceKey(firstRepository), storyResourceKey(firstWorktree));
  assert.notEqual(storyResourceKey(firstWorktree), storyResourceKey(secondWorktree));
  assert.deepEqual(parseStoryResourceKey(storyResourceKey(firstRepository)), firstRepository);
  assert.deepEqual(parseStoryResourceKey(storyResourceKey(firstWorktree)), firstWorktree);
  assert.deepEqual(parseStoryResourceKey(JSON.stringify(["ai-a", "instance-a", "repository", "ai-session", "repo", "files"])), firstRepository);

  const firstBrowser = { kind: "embedded-browser", aiSessionId: "ai-a", instanceId: "instance-a", browserTabId: "same" };
  const secondBrowser = { ...firstBrowser, aiSessionId: "ai-b" };
  assert.notEqual(storyResourceKey(firstBrowser), storyResourceKey(secondBrowser));
  assert.deepEqual(parseStoryResourceKey(storyResourceKey(firstBrowser)), firstBrowser);
  assert.equal(parseStoryResourceKey("not-json"), undefined);
});
test("App resources project every authoritative session from only the current AI Session instance", () => {
  const instances = [
    instance("instance-a", [{ id: "a" }, { id: "shared" }]),
    instance("instance-b", [{ id: "b" }, { id: "shared" }]),
  ];
  assert.deepEqual(instanceAppResourceRefs("instance-a", instances), [
    { kind: "app-session", instanceId: "instance-a", sessionId: "a" },
    { kind: "app-session", instanceId: "instance-a", sessionId: "shared" },
  ]);
  assert.deepEqual(instanceAppResourceRefs("instance-b", instances), [
    { kind: "app-session", instanceId: "instance-b", sessionId: "b" },
    { kind: "app-session", instanceId: "instance-b", sessionId: "shared" },
  ]);
  assert.deepEqual(instanceAppResourceRefs("", instances), []);
});

test("repository pages coexist while file navigation updates one AI Session Files tab", () => {
  const files = repositoryResource("ai-a", "instance-a", "ai-session", "ai-a", "files", "first.ts");
  const review = repositoryResource("ai-a", "instance-a", "ai-session", "ai-a", "changes-review");
  const worktrees = repositoryResource("ai-a", "instance-a", "ai-session", "ai-a", "worktrees");
  let resources = upsertAiSessionRepositoryResource([], files);
  resources = upsertAiSessionRepositoryResource(resources, review);
  resources = upsertAiSessionRepositoryResource(resources, worktrees);
  resources = upsertAiSessionRepositoryResource(resources, repositoryResource("ai-a", "instance-a", "ai-session", "ai-a", "files", "second.ts"));
  assert.equal(resources.length, 3);
  assert.equal(resources[0].filePath, "second.ts");
  assert.equal(resources[0].fileRequestId, 2);
});

test("one AI Session keeps a separate repository tab per worktree", () => {
  const workspaceFiles = repositoryResource("ai-a", "instance-a", "ai-session", "ai-a", "files");
  const worktreeFiles = repositoryResource("ai-a", "instance-a", "ai-session", "ai-a", "files", "second.ts", "worktree-a");
  let resources = upsertAiSessionRepositoryResource([], workspaceFiles);
  resources = upsertAiSessionRepositoryResource(resources, worktreeFiles);
  assert.equal(resources.length, 2);
  resources = upsertAiSessionRepositoryResource(resources, repositoryResource("ai-a", "instance-a", "ai-session", "ai-a", "files", "workspace.ts"));
  assert.equal(resources.length, 2);
  assert.equal(resources[0].filePath, "workspace.ts");
  assert.equal(resources[1].filePath, "second.ts");
  assert.equal(resources[1].cwdFolderId, "worktree-a");
});

test("worktree tabs stay independent across selection and close", async () => {
  const storage = localStorageWindow();
  globalThis.window = storage.window;
  const scope = effectScope();
  const sidebar = scope.run(() => useStoryResourceSidebar({
    aiSessionId: computed(() => "ai-a"),
    instanceId: computed(() => "instance-a"),
    instances: computed(() => [instance("instance-a")]),
  }));
  assert.ok(sidebar);
  const workspaceFiles = repositoryResource("ai-a", "instance-a", "ai-session", "ai-a", "files");
  const worktreeFiles = repositoryResource("ai-a", "instance-a", "ai-session", "ai-a", "files", undefined, "worktree-a");
  sidebar.openRepository(workspaceFiles);
  sidebar.openRepository(worktreeFiles);
  await nextTick();
  assert.deepEqual(sidebar.resources.value.map(storyResourceKey), [storyResourceKey(workspaceFiles), storyResourceKey(worktreeFiles)]);
  assert.equal(sidebar.activeKey.value, storyResourceKey(worktreeFiles));

  sidebar.removeRepository(worktreeFiles);
  await nextTick();
  assert.deepEqual(sidebar.resources.value.map(storyResourceKey), [storyResourceKey(workspaceFiles)]);
  assert.equal(sidebar.activeKey.value, storyResourceKey(workspaceFiles));
  scope.stop();
  delete globalThis.window;
});

test("active selection falls back only within the current AI Session resource list", () => {
  const first = repositoryResource("ai-a", "instance-a", "ai-session", "ai-a", "files");
  const second = repositoryResource("ai-a", "instance-a", "ai-session", "ai-a", "worktrees");
  assert.equal(activeStoryResourceKey(storyResourceKey(second), [first, second]), storyResourceKey(second));
  assert.equal(activeStoryResourceKey(storyResourceKey({ kind: "app-session", instanceId: "instance-b", sessionId: "app" }), [first, second]), storyResourceKey(first));
  assert.equal(activeStoryResourceKey("", []), "");
});

test("sidebar width preferences are sanitized", () => {
  assert.equal(normalizeStoryResourceSidebarWidth("bad"), 420);
  assert.equal(normalizeStoryResourceSidebarWidth(100), 320);
  assert.equal(normalizeStoryResourceSidebarWidth(900), 900);
  assert.equal(normalizeStoryResourceSidebarWidth(512), 512);
});

test("sidebar layout switches by container width and keyboard resize stays bounded", () => {
  assert.equal(storyResourceSidebarMode(1200), "inline");
  assert.equal(storyResourceSidebarMode(919), "overlay");
  assert.equal(storyResourceSidebarMode(0), "inline");
  assert.equal(storyResourceSidebarMaxWidth(1400), 880);
  assert.equal(storyResourceSidebarMaxWidth(1000), 480);
  assert.equal(storyResourceSidebarMaxWidth(700), 320);
  assert.equal(storyResourceSidebarKeyboardWidth(420, "ArrowLeft", 880), 444);
  assert.equal(storyResourceSidebarKeyboardWidth(420, "ArrowRight", 880), 396);
  assert.equal(storyResourceSidebarKeyboardWidth(870, "ArrowLeft", 880), 880);
  assert.equal(storyResourceSidebarKeyboardWidth(320, "ArrowRight", 880), 320);
  assert.equal(storyResourceSidebarKeyboardWidth(420, "Enter", 720), 420);
});

test("an open sidebar follows container width proportionally within layout bounds", () => {
  assert.equal(storyResourceSidebarProportionalWidth(420, 1200, 1400), 580);
  assert.equal(storyResourceSidebarProportionalWidth(420, 1200, 1000), 320);
  assert.equal(storyResourceSidebarProportionalWidth(600, 1000, 1400), 880);
  assert.equal(storyResourceSidebarProportionalWidth(420, 1200, 700), 320);
  assert.equal(storyResourceSidebarProportionalWidth(512, 0, 1200), 512);
});

test("controller shares instance Apps while isolating non-App and expanded state by AI Session", async () => {
  const storage = localStorageWindow();
  globalThis.window = storage.window;
  const aiSessionId = ref("ai-a");
  const instanceId = ref("instance-a");
  const appSessions = [{ id: "app-a" }, { id: "app-b" }];
  const instances = ref([instance("instance-a", appSessions), instance("instance-b", [{ id: "app-c" }])]);
  const scope = effectScope();
  const sidebar = scope.run(() => useStoryResourceSidebar({
    aiSessionId: computed(() => aiSessionId.value),
    instanceId: computed(() => instanceId.value),
    instances: computed(() => instances.value),
  }));
  assert.ok(sidebar);

  sidebar.openRepository(repositoryResource("ai-a", "instance-a", "ai-session", "ai-a", "files"));
  sidebar.visible.value = true;
  sidebar.width.value = 536;
  assert.deepEqual(sidebar.resources.value.map((resource) => resource.kind === "app-session" ? resource.sessionId : resource.aiSessionId), ["app-a", "app-b", "ai-a"]);

  instanceId.value = "instance-b";
  await nextTick();
  assert.deepEqual(sidebar.resources.value.map((resource) => resource.sessionId), ["app-c"]);
  assert.equal(sidebar.visible.value, false);
  assert.equal(sidebar.width.value, 536);

  instanceId.value = "instance-a";
  await nextTick();
  assert.equal(sidebar.visible.value, true);
  assert.deepEqual(sidebar.resources.value.map((resource) => resource.kind === "app-session" ? resource.sessionId : resource.page), ["app-a", "app-b", "files"]);

  aiSessionId.value = "ai-b";
  await nextTick();
  assert.deepEqual(sidebar.resources.value.map((resource) => resource.sessionId), ["app-a", "app-b"]);
  assert.equal(sidebar.visible.value, false);
  assert.equal(sidebar.width.value, 536);
  sidebar.visible.value = true;
  sidebar.openRepository(repositoryResource("ai-b", "instance-a", "ai-session", "ai-b", "worktrees"));

  aiSessionId.value = "ai-a";
  await nextTick();
  assert.deepEqual(sidebar.resources.value.map((resource) => resource.kind === "app-session" ? resource.sessionId : resource.page), ["app-a", "app-b", "files"]);
  assert.equal(sidebar.visible.value, true);

  aiSessionId.value = "ai-c";
  instanceId.value = "instance-b";
  await nextTick();
  assert.deepEqual(sidebar.resources.value.map((resource) => resource.sessionId), ["app-c"]);
  assert.equal(sidebar.visible.value, false);

  scope.stop();
  delete globalThis.window;
});

test("authoritative App removal updates every same-instance AI Session without removing repository tabs", async () => {
  const storage = localStorageWindow();
  globalThis.window = storage.window;
  const aiSessionId = ref("ai-a");
  const instanceId = ref("instance-a");
  const instances = ref([instance("instance-a", [{ id: "app-a" }, { id: "app-b" }])]);
  const scope = effectScope();
  const sidebar = scope.run(() => useStoryResourceSidebar({
    aiSessionId: computed(() => aiSessionId.value),
    instanceId: computed(() => instanceId.value),
    instances: computed(() => instances.value),
  }));
  assert.ok(sidebar);
  sidebar.openRepository(repositoryResource("ai-a", "instance-a", "ai-session", "ai-a", "changes-review"));

  instances.value = [instance("instance-a", [{ id: "app-b" }])];
  await nextTick();
  assert.deepEqual(sidebar.resources.value.map((resource) => [resource.kind, resource.sessionId]), [
    ["app-session", "app-b"],
    ["repository", "ai-a"],
  ]);

  aiSessionId.value = "ai-b";
  await nextTick();
  assert.deepEqual(sidebar.resources.value.map((resource) => [resource.kind, resource.sessionId]), [["app-session", "app-b"]]);
  scope.stop();
  delete globalThis.window;
});

test("App focus waits for the authoritative session projection", async () => {
  const storage = localStorageWindow();
  globalThis.window = storage.window;
  const instances = ref([instance("instance-a", [{ id: "app-a" }])]);
  const scope = effectScope();
  const sidebar = scope.run(() => useStoryResourceSidebar({
    aiSessionId: computed(() => "ai-a"),
    instanceId: computed(() => "instance-a"),
    instances: computed(() => instances.value),
  }));
  assert.ok(sidebar);

  sidebar.focusApp("instance-a", "app-b");
  assert.equal(sidebar.visible.value, true);
  assert.equal(sidebar.activeKey.value, storyResourceKey({ kind: "app-session", instanceId: "instance-a", sessionId: "app-a" }));

  instances.value = [instance("instance-a", [{ id: "app-a" }, { id: "app-b" }])];
  await nextTick();
  assert.equal(sidebar.activeKey.value, storyResourceKey({ kind: "app-session", instanceId: "instance-a", sessionId: "app-b" }));

  scope.stop();
  delete globalThis.window;
});

test("only explicit App close routes to the owning instance runtime", async () => {
  const calls = [];
  const actions = {
    stopAppSession: async (instanceId, sessionId) => calls.push(["stop", instanceId, sessionId]),
    closeRepository: (resource) => calls.push(["close-repository", resource.instanceId, resource.sessionId, resource.page]),
    closeEmbeddedBrowser: (resource) => calls.push(["close-browser", resource.instanceId, resource.browserTabId]),
  };
  await closeStoryResourceTarget({ kind: "app-session", instanceId: "instance-b", sessionId: "same" }, actions);
  await closeStoryResourceTarget(repositoryResource("ai-a", "instance-a", "ai-session", "same", "worktrees"), actions);
  await closeStoryResourceTarget({ kind: "embedded-browser", aiSessionId: "ai-a", instanceId: "instance-a", browserTabId: "browser-a" }, actions);
  assert.deepEqual(calls, [
    ["stop", "instance-b", "same"],
    ["close-repository", "instance-a", "same", "worktrees"],
    ["close-browser", "instance-a", "browser-a"],
  ]);
});

test("browser resources survive AI Session switches and remain session scoped", async () => {
  const storage = localStorageWindow();
  globalThis.window = storage.window;
  const aiSessionId = ref("ai-a");
  const instanceId = ref("instance-a");
  const instances = ref([instance("instance-a")]);
  const scope = effectScope();
  const sidebar = scope.run(() => useStoryResourceSidebar({
    aiSessionId: computed(() => aiSessionId.value),
    instanceId: computed(() => instanceId.value),
    instances: computed(() => instances.value),
  }));
  assert.ok(sidebar);
  sidebar.openBrowser("instance-a", "https://example.com");
  const browser = sidebar.resources.value.find((resource) => resource.kind === "embedded-browser");
  assert.ok(browser);
  assert.equal(browser.initialUrl, "https://example.com");
  assert.equal(sidebar.visible.value, true);

  aiSessionId.value = "ai-b";
  await nextTick();
  assert.equal(sidebar.resources.value.some((resource) => resource.kind === "embedded-browser"), false);
  assert.equal(sidebar.allBrowserResources.value.length, 1);

  aiSessionId.value = "ai-a";
  await nextTick();
  assert.equal(sidebar.resources.value.some((resource) => resource.kind === "embedded-browser"), true);
  sidebar.removeBrowser(browser);
  assert.equal(sidebar.allBrowserResources.value.length, 0);
  scope.stop();
  delete globalThis.window;
});

test("Story browser page moves adopt the live page host and leave the source blank", async () => {
  const storage = localStorageWindow();
  globalThis.window = storage.window;
  const scope = effectScope();
  const sidebar = scope.run(() => useStoryResourceSidebar({
    aiSessionId: computed(() => "ai-a"),
    instanceId: computed(() => "instance-a"),
    instances: computed(() => [instance("instance-a")]),
  }));
  assert.ok(sidebar);
  sidebar.openBrowser("instance-a", "https://example.com/a");
  sidebar.openBrowser("instance-a", "https://example.com/b");
  await nextTick();
  const resources = sidebar.allBrowserResources.value;
  assert.equal(resources.length, 2);
  const target = resources.find((resource) => resource.initialUrl === "https://example.com/a");
  const source = resources.find((resource) => resource.initialUrl === "https://example.com/b");
  assert.ok(target && source);
  const targetKey = storyResourceKey(target);
  const sourceKey = storyResourceKey(source);
  const movedPageKey = sidebar.browserPageKeyOf(source);

  assert.equal(sidebar.moveBrowserPage(targetKey, movedPageKey), true);
  await nextTick();

  const nextTarget = sidebar.allBrowserResources.value.find((resource) => storyResourceKey(resource) === targetKey);
  const nextSource = sidebar.allBrowserResources.value.find((resource) => storyResourceKey(resource) === sourceKey);
  assert.ok(nextTarget && nextSource);
  assert.equal(sidebar.browserPageKeyOf(nextTarget), movedPageKey);
  assert.equal(nextTarget.initialUrl, "https://example.com/b");
  assert.notEqual(sidebar.browserPageKeyOf(nextSource), movedPageKey);
  assert.match(sidebar.browserPageKeyOf(nextSource), /^story-browser-page:/);
  assert.equal(nextSource.initialUrl, undefined);
  assert.equal(nextSource.currentUrl, undefined);
  assert.deepEqual(
    sidebar.browserPageSurfaces.value["instance-a"]?.map((page) => page.key).sort(),
    [sidebar.browserPageKeyOf(nextTarget), sidebar.browserPageKeyOf(nextSource)].sort(),
  );

  const adoptedPageKey = "embedded-browser-page:from-instance";
  assert.equal(sidebar.adoptBrowserPage(storyResourceKey(nextTarget), adoptedPageKey, {
    title: "Instance page",
    currentUrl: "https://example.com/instance",
    status: "ready",
  }), true);
  sidebar.blankBrowserPageResource(nextSource);
  await nextTick();
  const adopted = sidebar.allBrowserResources.value.find((resource) => storyResourceKey(resource) === targetKey);
  assert.equal(sidebar.browserPageKeyOf(adopted), adoptedPageKey);
  assert.equal(adopted.title, "Instance page");
  assert.equal(adopted.currentUrl, "https://example.com/instance");
  scope.stop();
  delete globalThis.window;
});

test("a page opened by another AI Session lands in that Session without switching the current view", async () => {
  const storage = localStorageWindow();
  globalThis.window = storage.window;
  const aiSessionId = ref("ai-a");
  const scope = effectScope();
  const sidebar = scope.run(() => useStoryResourceSidebar({
    aiSessionId: computed(() => aiSessionId.value),
    instanceId: computed(() => "instance-a"),
    instances: computed(() => [instance("instance-a")]),
  }));
  assert.ok(sidebar);
  sidebar.openBrowserForAiSession("instance-a", "ai-a", "https://example.com/current");
  const current = sidebar.resources.value.find((resource) => resource.kind === "embedded-browser");
  assert.ok(current);
  const currentKey = sidebar.activeKey.value;

  sidebar.openBrowserForAiSession("instance-a", "ai-b", "https://example.com/background", {
    title: "Background",
    creationRef: "bcr_background",
  });
  assert.equal(sidebar.activeKey.value, currentKey);
  assert.equal(sidebar.resources.value.some((resource) => resource.kind === "embedded-browser" && resource.aiSessionId === "ai-b"), false);
  const background = sidebar.allBrowserResources.value.find((resource) => resource.aiSessionId === "ai-b");
  assert.ok(background);
  assert.equal(background.initialUrl, "https://example.com/background");
  assert.equal(background.creationRef, "bcr_background");

  aiSessionId.value = "ai-b";
  await nextTick();
  assert.equal(sidebar.resources.value.some((resource) => resource.aiSessionId === "ai-b" && resource.kind === "embedded-browser"), true);
  assert.equal(sidebar.activeKey.value, storyResourceKey(background));
  scope.stop();
  delete globalThis.window;
});

test("activating a page from another AI Session resolves that Session's Story owner", () => {
  const resource = {
    kind: "embedded-browser",
    aiSessionId: "ai-b",
    instanceId: "instance-a",
    browserTabId: "browser-b",
  };
  const instances = [{
    id: "instance-a",
    nodeId: "node-a",
    aiSessions: { sessions: [
      { id: "ai-a", storyId: "story-a" },
      { id: "ai-b", storyId: "story-b" },
    ] },
  }];

  assert.deepEqual(storyBrowserSessionSelection(resource, instances), {
    kind: "session",
    ownerNodeId: "node-a",
    storyId: "story-b",
    instanceId: "instance-a",
    sessionId: "ai-b",
  });
  assert.equal(storyBrowserSessionSelection({ ...resource, aiSessionId: "missing" }, instances), undefined);
  assert.equal(storyBrowserSessionSelection(resource, [{
    id: "instance-a",
    nodeId: "node-a",
    aiSessions: { sessions: [{ id: "ai-b" }] },
  }]), undefined);
});

test("a cross-session page becomes selectable after activation moves the Story context", async () => {
  const storage = localStorageWindow();
  globalThis.window = storage.window;
  const aiSessionId = ref("ai-a");
  const scope = effectScope();
  const sidebar = scope.run(() => useStoryResourceSidebar({
    aiSessionId: computed(() => aiSessionId.value),
    instanceId: computed(() => "instance-a"),
    instances: computed(() => [instance("instance-a")]),
  }));
  assert.ok(sidebar);
  sidebar.openBrowser("instance-a", "https://example.com/a");
  const first = sidebar.allBrowserResources.value.find((resource) => resource.initialUrl === "https://example.com/a");
  assert.ok(first);

  aiSessionId.value = "ai-b";
  await nextTick();
  sidebar.openBrowser("instance-a", "https://example.com/b");
  const second = sidebar.allBrowserResources.value.find((resource) => resource.initialUrl === "https://example.com/b");
  assert.ok(second);

  aiSessionId.value = "ai-a";
  await nextTick();
  const selection = storyBrowserSessionSelection(second, [{
    id: "instance-a",
    nodeId: "node-a",
    aiSessions: { sessions: [{ id: "ai-b", storyId: "story-b" }] },
  }]);
  assert.ok(selection);
  aiSessionId.value = selection.sessionId;
  await nextTick();
  sidebar.select(second);
  await nextTick();
  assert.equal(sidebar.activeKey.value, storyResourceKey(second));
  assert.notEqual(sidebar.activeKey.value, storyResourceKey(first));
  scope.stop();
  delete globalThis.window;
});

test("remote desktop is one session-scoped tab, repeated open focuses it and close only removes presentation", async () => {
  const storage = localStorageWindow();
  globalThis.window = storage.window;
  const scope = effectScope(), sessionId = ref("ai-a");
  const sidebar = scope.run(() => useStoryResourceSidebar({
    aiSessionId: computed(() => sessionId.value),
    instanceId: computed(() => "instance-a"),
    instances: computed(() => [instance("instance-a")]),
  }));
  const first = { kind: "remote-desktop", instanceId: "instance-a", aiSessionId: "ai-a" };
  assert.deepEqual(parseStoryResourceKey(storyResourceKey(first)), first);
  sidebar.openRemoteDesktop("instance-a", "ai-a");
  sidebar.openRemoteDesktop("instance-a", "ai-a");
  await nextTick();
  assert.deepEqual(sidebar.resources.value, [first]);
  assert.equal(sidebar.activeKey.value, storyResourceKey(first));
  assert.equal(sidebar.visible.value, true);
  sessionId.value = "ai-b";
  await nextTick();
  assert.deepEqual(sidebar.resources.value, []);
  sidebar.openRemoteDesktop("instance-b", "ai-b");
  sidebar.openRemoteDesktop("instance-a", "ai-a");
  assert.deepEqual(sidebar.resources.value, []);
  sidebar.openRemoteDesktop("instance-a", "ai-b");
  await nextTick();
  assert.equal(sidebar.resources.value[0].aiSessionId, "ai-b");
  const calls = [];
  await closeStoryResourceTarget(sidebar.resources.value[0], {
    stopAppSession: () => assert.fail("closing a desktop tab must not stop an app"),
    closeRemoteDesktop: resource => { calls.push(resource.aiSessionId); sidebar.removeRemoteDesktop(resource); },
  });
  await nextTick();
  assert.deepEqual(calls, ["ai-b"]);
  assert.deepEqual(sidebar.resources.value, []);
  sessionId.value = "ai-a";
  await nextTick();
  assert.deepEqual(sidebar.resources.value, [first]);
  sidebar.visible.value = false;
  await nextTick();
  assert.deepEqual(sidebar.resources.value, [first]);
  assert.equal(sidebar.allRemoteDesktopResources.value.length, 1);
  scope.stop();
  delete globalThis.window;
});
