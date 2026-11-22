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

test("creation claims are atomic and only the first desktop can create the page", () => {
  const service = new BrowserControlService();
  const first = registerSource(service, { publisherRef: "renderer-a" });
  const second = registerSource(service, { publisherRef: "renderer-b", hostLabel: "MacBook B" });
  syncSource(service, first, []);
  syncSource(service, second, []);

  const creation = service.requestCreation("session_one", "https://example.com/created");
  assert.equal(creation.candidates.length, 2);
  const claimed = service.claimCreation(first.sourceRef, creation.creationRef, creation.revision);
  assert.equal(claimed.state, "claimed");
  assert.equal(errorCode(() => service.claimCreation(second.sourceRef, creation.creationRef, creation.revision)), "BROWSER_CREATION_CONFLICT");
});

test("creation waits for a state transition without polling and returns the approved tab", async () => {
  const service = new BrowserControlService();
  const source = registerSource(service);
  syncSource(service, source, []);
  const creation = service.requestCreation("session_one", "https://example.com/created");
  const waiting = service.waitForCreation("session_one", creation.creationRef, 5_000);
  await new Promise((resolve) => setTimeout(resolve, 10));
  service.claimCreation(source.sourceRef, creation.creationRef, creation.revision);
  const claimed = service.getCreation("session_one", creation.creationRef);
  service.markCreationCreating(source.sourceRef, creation.creationRef);
  syncSource(service, source, [page(source, "browser_tab_created")]);
  service.completeCreation(source.sourceRef, creation.creationRef, "browser_tab_created");

  assert.equal(claimed.state, "claimed");
  assert.equal(EMBEDDED_BROWSER_CREATION_WAIT_MS, 10_000);
  assert.equal((await waiting).state, "ready");
  assert.equal((await waiting).tabRef, "browser_tab_created");
});

test("a pending creation remains pending when the CDP request wait expires", async () => {
  const service = new BrowserControlService();
  const source = registerSource(service);
  syncSource(service, source, []);
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

  syncSource(service, replacement, [page(replacement, "browser_tab_one")]);
  assert.equal(service.attachTab("session_one", "browser_tab_one").generation, replacement.generation);
});

test("declining every candidate closes the creation request", () => {
  const service = new BrowserControlService();
  const first = registerSource(service, { publisherRef: "renderer-a" });
  const second = registerSource(service, { publisherRef: "renderer-b" });
  syncSource(service, first, []);
  syncSource(service, second, []);
  const creation = service.requestCreation("session_one", "https://example.com/created");

  const afterFirst = service.declineCreation(first.sourceRef, creation.creationRef, creation.revision);
  assert.equal(afterFirst.state, "pending");
  const afterSecond = service.declineCreation(second.sourceRef, creation.creationRef, afterFirst.revision);
  assert.equal(afterSecond.state, "declined");
});
