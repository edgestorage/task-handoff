import assert from "node:assert/strict";
import test from "node:test";
import {
  EMBEDDED_BROWSER_CREATION_WAIT_MS,
  EMBEDDED_BROWSER_MAIN_PAGE_POOL_CAPABILITIES,
  EMBEDDED_BROWSER_RENDERER_WEBVIEW_CAPABILITIES,
  type EmbeddedBrowserPage,
  type EmbeddedBrowserPageHost,
  type EmbeddedBrowserPageHostCapabilities,
  type EmbeddedBrowserSource,
} from "@task-handoff/protocol/embedded-browser-control";
import { BrowserControlError, BrowserControlService } from "../src/web/browser-control.ts";
import { embeddedBrowserTabsOpenParamsForPeer } from "../src/web/browser-control-tab-compat.ts";

test("browser control advertises target CDP support", () => {
  assert.equal(new BrowserControlService().capabilities().targetCdp, true);
});

type RegistrationOptions = {
  panelId?: string;
  ownerRef?: string;
  publisherRef?: string;
  hostLabel?: string;
  pageHost?: EmbeddedBrowserPageHost;
  pageHostCapabilities?: EmbeddedBrowserPageHostCapabilities;
};

function registration(options: RegistrationOptions = {}) {
  const pageHost = options.pageHost || "renderer-webview";
  return {
    panelId: options.panelId || "control_plane_one",
    ownerRef: options.ownerRef || "user_one",
    displayName: "Desktop A",
    hostLabel: options.hostLabel || "MacBook A",
    publisherRef: options.publisherRef || "renderer-a",
    rendererHostBinding: pageHost === "renderer-webview" ? "renderer-host-a" : undefined,
    pageHost,
    pageHostCapabilities: options.pageHostCapabilities
      || (pageHost === "renderer-webview"
        ? { ...EMBEDDED_BROWSER_RENDERER_WEBVIEW_CAPABILITIES }
        : { ...EMBEDDED_BROWSER_MAIN_PAGE_POOL_CAPABILITIES }),
  };
}

function page(source: EmbeddedBrowserSource, tabRef: string): EmbeddedBrowserPage {
  return {
    sourceRef: source.sourceRef,
    generation: source.generation,
    tabRef,
    instanceId: "instance_one",
    pageHost: source.pageHost,
    pageHostCapabilities: source.pageHostCapabilities,
    title: tabRef,
    url: `https://example.com/${tabRef}`,
    state: "ready",
    revision: 1,
  };
}

function syncSource(service: BrowserControlService, source: EmbeddedBrowserSource, pages: EmbeddedBrowserPage[]) {
  service.commitSnapshot({
    sourceRef: source.sourceRef,
    generation: source.generation,
    sourceRevision: 1,
    registryEpoch: service.registryEpochValue(),
    snapshotRef: `snapshot-${source.generation}`,
    chunkIndex: 0,
    chunkCount: 1,
    complete: true,
    pages,
  });
  assert.equal(service.syncSourceIfCurrent(
    source.sourceRef,
    source.generation,
    service.registryEpochValue(),
    service.registryRevisionValue(),
  ), true);
}

function registerSource(service: BrowserControlService, options: RegistrationOptions = {}) {
  return service.registerSource(registration(options));
}

function errorCode(run: () => unknown) {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof BrowserControlError);
    return error.code;
  }
  assert.fail("Expected the browser control operation to fail.");
}

function recordingDispatcher() {
  const calls: Array<{
    creationRef: string;
    sourceRef: string;
    generation: number;
    requesterSessionRef: string;
  }> = [];
  return {
    calls,
    dispatcher: async (
      creation: { creationRef: string },
      target: { sourceRef: string; generation: number; requesterSessionRef: string },
    ) => {
      calls.push({
        creationRef: creation.creationRef,
        sourceRef: target.sourceRef,
        generation: target.generation,
        requesterSessionRef: target.requesterSessionRef,
      });
    },
  };
}

test("instance access is required before any AI Session can receive a CDP token", () => {
  const service = new BrowserControlService();
  assert.deepEqual(service.access(), { active: false, revision: 0 });
  assert.equal(errorCode(() => service.issueCdpToken("session_one")), "BROWSER_AUTHORIZATION_REQUIRED");

  const granted = service.grantInstanceAccess();
  assert.equal(granted.active, true);
  const first = service.issueCdpToken("session_one");
  const second = service.issueCdpToken("session_two");
  assert.equal(service.validateCdpToken(first.token), "session_one");
  assert.equal(service.validateCdpToken(second.token), "session_two");
});

test("an AI Session can request instance access and wait for the approval center", async () => {
  const service = new BrowserControlService();
  const states: string[] = [];
  service.subscribe((event) => {
    if (event.type === "browser.access.request.changed") states.push(String(event.payload.state));
  });
  const request = service.requestInstanceAccess("session_one");
  assert.ok(request);
  assert.equal(service.access().pendingRequest?.requestRef, request.requestRef);
  assert.equal(errorCode(() => service.issueCdpToken("session_one")), "BROWSER_AUTHORIZATION_REQUIRED");

  const waiting = service.waitForAccessDecision(request.requestRef, 1_000);
  const granted = service.grantInstanceAccess({ requestRef: request.requestRef, expectedRevision: request.revision });
  assert.equal(granted.active, true);
  assert.equal((await waiting).status, "granted");
  assert.equal(service.access().pendingRequest, undefined);
  assert.equal(service.validateCdpToken(service.issueCdpToken("session_one").token), "session_one");
  assert.deepEqual(states, ["pending", "approved"]);
});

test("denying an access request wakes the waiting tool call", async () => {
  const service = new BrowserControlService();
  const request = service.requestInstanceAccess("session_one");
  assert.ok(request);

  const waiting = service.waitForAccessDecision(request.requestRef, 1_000);
  service.denyInstanceAccessRequest(request.requestRef, request.revision);
  const decision = await waiting;
  assert.equal(decision.status, "denied");
  assert.equal(service.access().active, false);
  assert.equal(service.access().pendingRequest, undefined);
});

test("revoking instance access cancels a pending access request", async () => {
  const service = new BrowserControlService();
  const request = service.requestInstanceAccess("session_one");
  assert.ok(request);
  assert.equal(service.revokeInstanceAccess(), 0);
  assert.equal(service.access().pendingRequest, undefined);
  assert.equal((await service.waitForAccessDecision(request.requestRef, 0)).status, "expired");
});

test("an access approval must match the pending request revision", () => {
  const service = new BrowserControlService();
  const request = service.requestInstanceAccess("session_one");
  assert.ok(request);
  assert.equal(errorCode(() => service.grantInstanceAccess({ requestRef: request.requestRef, expectedRevision: request.revision + 1 })), "BROWSER_ACCESS_REQUEST_STALE");
  assert.equal(errorCode(() => service.grantInstanceAccess({ requestRef: "breq_missing" })), "BROWSER_ACCESS_REQUEST_STALE");
  assert.equal(service.access().active, false);
  assert.equal(service.access().pendingRequest?.requestRef, request.requestRef);
});

test("closing one AI Session leaves instance access and other session tokens intact", () => {
  const service = new BrowserControlService();
  service.grantInstanceAccess();
  const first = service.issueCdpToken("session_one");
  const second = service.issueCdpToken("session_two");

  assert.equal(service.cleanupSession("session_one"), 0);
  assert.equal(service.validateCdpToken(first.token), undefined);
  assert.equal(service.validateCdpToken(second.token), "session_two");
  assert.equal(service.access().active, true);
  assert.equal(service.sessionHasCdpTokens("session_one"), false);
  assert.equal(service.sessionHasCdpTokens("session_two"), true);
});

test("instance revocation removes every CDP token and writer lease", () => {
  const service = new BrowserControlService();
  const source = registerSource(service, { pageHost: "main-page-pool" });
  syncSource(service, source, [page(source, "browser_tab_one")]);
  service.grantInstanceAccess();
  const issued = service.issueCdpToken("session_one");
  const lease = service.attachTab("session_one", "browser_tab_one");

  assert.equal(service.revokeInstanceAccess(), 1);
  assert.equal(service.validateCdpToken(issued.token), undefined);
  assert.equal(errorCode(() => service.leaseCommandTarget("session_one", lease.leaseRef)), "BROWSER_LEASE_STALE");
  assert.equal(service.access().active, false);
});

test("allPages returns the complete instance registry while listPages remains paginated", () => {
  const service = new BrowserControlService();
  const source = registerSource(service, { pageHost: "main-page-pool" });
  const pages = Array.from({ length: 75 }, (_, index) => page(source, `browser_tab_${String(index).padStart(3, "0")}`));
  syncSource(service, source, pages);

  const paged = service.listPages();
  assert.equal(paged.items.length, 50);
  assert.ok(paged.cursor);
  assert.deepEqual(service.allPages(), pages);
});

test("a single creation candidate is bound and dispatched without an approval", async () => {
  const service = new BrowserControlService();
  const source = registerSource(service);
  syncSource(service, source, []);
  const recorder = recordingDispatcher();
  service.setCreationDispatcher(recorder.dispatcher);

  const creation = service.requestCreation("session_one", "https://example.com/created");
  assert.equal(creation.state, "creating");
  assert.equal(service.defaultCreationContext()?.sourceRef, source.sourceRef);
  assert.equal(service.creationContextRevisionValue(), 1);
  assert.deepEqual(recorder.calls, [{ creationRef: creation.creationRef, sourceRef: source.sourceRef, generation: source.generation, requesterSessionRef: "session_one" }]);

  const waiting = service.waitForCreation("session_one", creation.creationRef, 5_000);
  syncSource(service, source, [page(source, "browser_tab_created")]);
  service.completeCreation(source.sourceRef, creation.creationRef, "browser_tab_created");

  assert.equal(EMBEDDED_BROWSER_CREATION_WAIT_MS, 10_000);
  assert.equal((await waiting).state, "ready");
  assert.equal((await waiting).tabRef, "browser_tab_created");
});

test("multiple creation candidates stay pending until a panel claims itself", () => {
  const service = new BrowserControlService();
  const first = registerSource(service, { publisherRef: "renderer-a", panelId: "panel_a", ownerRef: "user_a" });
  const second = registerSource(service, { publisherRef: "renderer-b", panelId: "panel_b", ownerRef: "user_b", hostLabel: "MacBook B" });
  syncSource(service, first, []);
  syncSource(service, second, []);
  const recorder = recordingDispatcher();
  service.setCreationDispatcher(recorder.dispatcher);

  const creation = service.requestCreation("session_one", "https://example.com/created");
  assert.equal(creation.state, "pending");
  assert.equal(creation.candidates.length, 2);
  assert.equal(service.defaultCreationContext(), undefined);
  assert.deepEqual(recorder.calls, []);

  const snapshot = service.creationContextSnapshot(first.sourceRef);
  assert.equal(snapshot.revision, 0);
  assert.equal(snapshot.pendingCreation?.creationRef, creation.creationRef);
  assert.deepEqual(
    snapshot.panels.map((panel) => [panel.sourceRef, panel.isDefault, panel.canClaim]).sort(),
    [[first.sourceRef, false, true], [second.sourceRef, false, false]].sort(),
  );

  const claimed = service.claimDefaultContext({
    sourceRef: first.sourceRef,
    expectedRevision: snapshot.revision,
    panelId: "panel_a",
    ownerRef: "user_a",
  });
  assert.equal(claimed.browserContextId, first.sourceRef);
  assert.equal(claimed.revision, 1);
  assert.equal(service.getCreation("session_one", creation.creationRef).state, "creating");
  assert.deepEqual(recorder.calls, [{ creationRef: creation.creationRef, sourceRef: first.sourceRef, generation: first.generation, requesterSessionRef: "session_one" }]);

  service.claimDefaultContext({ sourceRef: second.sourceRef, expectedRevision: 1, panelId: "panel_b", ownerRef: "user_b" });
  assert.equal(service.getCreation("session_one", creation.creationRef).state, "creating");
  assert.equal(recorder.calls.length, 1);
  assert.equal(service.defaultCreationContext()?.sourceRef, second.sourceRef);
});

test("a panel cannot claim another panel's source", () => {
  const service = new BrowserControlService();
  const source = registerSource(service, { panelId: "panel_a", ownerRef: "user_a" });
  syncSource(service, source, []);

  assert.equal(errorCode(() => service.claimDefaultContext({
    sourceRef: source.sourceRef,
    expectedRevision: 0,
    panelId: "panel_b",
    ownerRef: "user_b",
  })), "BROWSER_CREATION_CONTEXT_NOT_OWNED");
});

test("concurrent claims are atomic and stale revisions conflict", () => {
  const service = new BrowserControlService();
  const first = registerSource(service, { publisherRef: "renderer-a", panelId: "panel_a", ownerRef: "user_a" });
  const second = registerSource(service, { publisherRef: "renderer-b", panelId: "panel_b", ownerRef: "user_b" });
  syncSource(service, first, []);
  syncSource(service, second, []);

  const initial = service.creationContextRevisionValue();
  service.claimDefaultContext({ sourceRef: first.sourceRef, expectedRevision: initial, panelId: "panel_a", ownerRef: "user_a" });
  assert.equal(errorCode(() => service.claimDefaultContext({
    sourceRef: second.sourceRef,
    expectedRevision: initial,
    panelId: "panel_b",
    ownerRef: "user_b",
  })), "BROWSER_DEFAULT_CONTEXT_CONFLICT");
  assert.equal(service.defaultCreationContext()?.sourceRef, first.sourceRef);
});

test("taking over the default keeps the previous panel pages and lease", () => {
  const service = new BrowserControlService();
  const first = registerSource(service, { pageHost: "main-page-pool", publisherRef: "pool-a", panelId: "panel_a", ownerRef: "user_a" });
  const second = registerSource(service, { pageHost: "main-page-pool", publisherRef: "pool-b", panelId: "panel_b", ownerRef: "user_b" });
  syncSource(service, first, [page(first, "browser_tab_a")]);
  syncSource(service, second, []);
  service.grantInstanceAccess();
  const lease = service.attachTab("session_one", "browser_tab_a");

  service.claimDefaultContext({ sourceRef: first.sourceRef, expectedRevision: 0, panelId: "panel_a", ownerRef: "user_a" });
  const takeover = service.claimDefaultContext({ sourceRef: second.sourceRef, expectedRevision: 1, panelId: "panel_b", ownerRef: "user_b" });

  assert.equal(takeover.revision, 2);
  assert.equal(service.defaultCreationContext()?.sourceRef, second.sourceRef);
  assert.deepEqual(service.allPages().map((entry) => entry.tabRef), ["browser_tab_a"]);
  assert.equal(service.leaseCommandTarget("session_one", lease.leaseRef).page.tabRef, "browser_tab_a");
});

test("an offline default fails creation instead of switching panels", () => {
  const service = new BrowserControlService();
  const first = registerSource(service, { pageHost: "main-page-pool", publisherRef: "pool-a", panelId: "panel_a", ownerRef: "user_a" });
  const second = registerSource(service, { pageHost: "main-page-pool", publisherRef: "pool-b", panelId: "panel_b", ownerRef: "user_b" });
  syncSource(service, first, []);
  syncSource(service, second, []);
  service.claimDefaultContext({ sourceRef: first.sourceRef, expectedRevision: 0, panelId: "panel_a", ownerRef: "user_a" });
  service.disconnectSource(first.sourceRef, first.generation);

  assert.deepEqual(service.browserContexts(), {
    browserContextIds: [second.sourceRef],
    defaultBrowserContextId: first.sourceRef,
  });
  assert.equal(errorCode(() => service.requestCreation("session_one", "https://example.com/created")), "BROWSER_CREATION_CONTEXT_UNAVAILABLE");
  assert.equal(service.defaultCreationContext()?.sourceRef, first.sourceRef);
});

test("explicit browser contexts must match the selected default", () => {
  const service = new BrowserControlService();
  const first = registerSource(service, { publisherRef: "renderer-a", panelId: "panel_a", ownerRef: "user_a" });
  const second = registerSource(service, { publisherRef: "renderer-b", panelId: "panel_b", ownerRef: "user_b", hostLabel: "MacBook B" });
  syncSource(service, first, []);
  syncSource(service, second, []);
  service.setCreationDispatcher(recordingDispatcher().dispatcher);
  service.claimDefaultContext({ sourceRef: first.sourceRef, expectedRevision: 0, panelId: "panel_a", ownerRef: "user_a" });

  assert.equal(errorCode(() => service.requestCreation("session_one", "https://example.com/created", undefined, {
    browserContextId: second.sourceRef,
  })), "BROWSER_CREATION_CONTEXT_NOT_SELECTED");
  assert.equal(service.requestCreation("session_one", "https://example.com/created", undefined, {
    browserContextId: first.sourceRef,
  }).state, "creating");
});

test("a single candidate can be selected explicitly and no candidate fails creation", () => {
  const service = new BrowserControlService();
  const pendingSource = registerSource(service, { publisherRef: "renderer-pending" });
  assert.equal(errorCode(() => service.requestCreation("session_one", "https://example.com/created")), "BROWSER_CREATION_NO_CANDIDATE");

  syncSource(service, pendingSource, []);
  service.setCreationDispatcher(recordingDispatcher().dispatcher);
  const creation = service.requestCreation("session_one", "https://example.com/created", undefined, {
    browserContextId: pendingSource.sourceRef,
  });
  assert.equal(creation.state, "creating");
  assert.equal(service.defaultCreationContext()?.sourceRef, pendingSource.sourceRef);
});

test("a pending creation remains pending when the CDP request wait expires", async () => {
  const service = new BrowserControlService();
  const first = registerSource(service, { publisherRef: "renderer-a" });
  const second = registerSource(service, { publisherRef: "renderer-b", hostLabel: "MacBook B" });
  syncSource(service, first, []);
  syncSource(service, second, []);
  const creation = service.requestCreation("session_one", "https://example.com/created");

  const view = await service.waitForCreation("session_one", creation.creationRef, 10);
  assert.equal(view.state, "pending");
  assert.equal(service.getCreation("session_one", creation.creationRef).state, "pending");
});

test("one tab accepts one writer while different tabs can be controlled in parallel", () => {
  const service = new BrowserControlService();
  const source = registerSource(service, { pageHost: "main-page-pool" });
  syncSource(service, source, [page(source, "browser_tab_one"), page(source, "browser_tab_two")]);
  service.grantInstanceAccess();

  const first = service.attachTab("session_one", "browser_tab_one");
  assert.equal(service.attachTab("session_one", "browser_tab_one").leaseRef, first.leaseRef);
  assert.equal(errorCode(() => service.attachTab("session_two", "browser_tab_one")), "BROWSER_TARGET_BUSY");
  assert.ok(service.attachTab("session_two", "browser_tab_two"));
});

test("source reconnects advance generation, remove old pages, and fence old leases", () => {
  const service = new BrowserControlService();
  const first = registerSource(service, { pageHost: "main-page-pool" });
  syncSource(service, first, [page(first, "browser_tab_one")]);
  service.grantInstanceAccess();
  const lease = service.attachTab("session_one", "browser_tab_one");

  const replacement = registerSource(service, { pageHost: "main-page-pool" });
  assert.equal(replacement.sourceRef, first.sourceRef);
  assert.equal(replacement.generation, first.generation + 1);
  assert.deepEqual(service.allPages(), []);
  assert.equal(errorCode(() => service.leaseCommandTarget("session_one", lease.leaseRef)), "BROWSER_LEASE_STALE");
  assert.equal(errorCode(() => service.attachTab("session_one", "browser_tab_one")), "BROWSER_TAB_NOT_FOUND");

  syncSource(service, replacement, [page(replacement, "browser_tab_one")]);
  assert.equal(service.attachTab("session_one", "browser_tab_one").generation, replacement.generation);
});

test("instance access revocation clears the default context and active creation", async () => {
  const service = new BrowserControlService();
  const first = registerSource(service, { pageHost: "main-page-pool", publisherRef: "pool-a", panelId: "panel_a", ownerRef: "user_a" });
  const second = registerSource(service, { pageHost: "main-page-pool", publisherRef: "pool-b", panelId: "panel_b", ownerRef: "user_b" });
  syncSource(service, first, []);
  syncSource(service, second, []);
  service.claimDefaultContext({ sourceRef: first.sourceRef, expectedRevision: 0, panelId: "panel_a", ownerRef: "user_a" });
  const creation = service.requestCreation("session_one", "https://example.com/created");
  service.grantInstanceAccess();
  const token = service.issueCdpToken("session_one");

  service.revokeInstanceAccess();

  assert.equal(service.defaultCreationContext(), undefined);
  assert.equal(service.creationContextSnapshot().defaultContext, undefined);
  assert.equal(service.validateCdpToken(token.token), undefined);
  assert.equal((await service.waitForCreation("session_one", creation.creationRef, 10)).state, "failed");
});

test("browser context and target projections reuse sourceRef and tabRef", () => {
  const service = new BrowserControlService();
  const first = registerSource(service, { pageHost: "main-page-pool", publisherRef: "pool-a", panelId: "panel_a", ownerRef: "user_a" });
  const second = registerSource(service, { pageHost: "main-page-pool", publisherRef: "pool-b", panelId: "panel_b", ownerRef: "user_b" });
  syncSource(service, first, [page(first, "browser_tab_a")]);
  syncSource(service, second, [page(second, "browser_tab_b")]);
  service.grantInstanceAccess();
  service.attachTab("session_one", "browser_tab_a");

  assert.deepEqual(service.browserContexts(), {
    browserContextIds: [first.sourceRef, second.sourceRef].sort(),
  });
  service.claimDefaultContext({ sourceRef: second.sourceRef, expectedRevision: 0, panelId: "panel_b", ownerRef: "user_b" });
  assert.deepEqual(service.browserContexts(), {
    browserContextIds: [first.sourceRef, second.sourceRef].sort(),
    defaultBrowserContextId: second.sourceRef,
  });

  const targets = service.targetInfos(new Set(["browser_tab_a"]));
  assert.deepEqual(targets.targetInfos.map((target) => [
    target.targetId,
    target.browserContextId,
    target.attached,
  ]), [
    ["browser_tab_a", first.sourceRef, true],
    ["browser_tab_b", second.sourceRef, false],
  ]);
  assert.equal(service.targetInfo("browser_tab_b").targetInfo.browserContextId, second.sourceRef);
});

test("tabs.open keeps the legacy wire shape for a pre-origin desktop", () => {
  const params = {
    creationRef: "bcr_one",
    sourceRef: "bsr_one",
    generation: 2,
    url: "https://example.com/",
    requesterSessionRef: "session_one",
  };
  assert.equal("requesterSessionRef" in embeddedBrowserTabsOpenParamsForPeer(params, "2026-11-22"), false);
  assert.equal(
    embeddedBrowserTabsOpenParamsForPeer(params, "2026-11-23").requesterSessionRef,
    "session_one",
  );
});
