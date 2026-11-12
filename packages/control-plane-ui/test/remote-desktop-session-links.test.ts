import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSessionRemoteDesktopLinks,
  removeSessionRemoteDesktopLink,
  rememberSessionRemoteDesktopLink,
  sanitizeSessionRemoteDesktopTarget,
  sessionRemoteDesktopLinkFor,
  sessionRemoteDesktopLinkKey,
  touchSessionRemoteDesktopLink,
} from "../src/apps/control-plane/instance-detail/sessionRemoteDesktopLinks.ts";

function fakeStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

test("session remote desktop keys isolate instance and session ids", () => {
  assert.notEqual(sessionRemoteDesktopLinkKey("instance-1", "session-1"), sessionRemoteDesktopLinkKey("instance-2", "session-1"));
  assert.notEqual(sessionRemoteDesktopLinkKey("instance-1", "session-1"), sessionRemoteDesktopLinkKey("instance-1", "session-2"));
});

test("remote desktop targets accept partial persisted selections and sanitize bounds", () => {
  assert.deepEqual(sanitizeSessionRemoteDesktopTarget({ kind: "display", title: "Entire desktop" }), {
    kind: "display",
    title: "Entire desktop",
    subtitle: null,
    width: 0,
    height: 0,
  });
  const target = sanitizeSessionRemoteDesktopTarget({
    kind: "window",
    sourceRef: "source-1",
    title: "  Chrome  ",
    subtitle: "  Desktop  ",
    width: 1099,
    height: 837,
  });
  assert.deepEqual(target, {
    kind: "window",
    sourceRef: "source-1",
    title: "Chrome",
    subtitle: "Desktop",
    width: 1099,
    height: 837,
  });
});

test("session link parser drops invalid records and preserves timestamps", () => {
  const parsed = parseSessionRemoteDesktopLinks(JSON.stringify({
    version: 1,
    bySession: {
      valid: {
        target: { kind: "display", title: "Desktop", width: 1920, height: 1080 },
        openedAt: 10,
        lastUsedAt: 20,
      },
      missingOpenedAt: { target: { kind: "display", title: "Desktop" } },
      invalidTarget: { target: null, openedAt: 10 },
    },
  }));
  assert.deepEqual(parsed.bySession, {
    valid: {
      target: { kind: "display", title: "Desktop", subtitle: null, width: 1920, height: 1080 },
      openedAt: 10,
      lastUsedAt: 20,
    },
  });
  assert.deepEqual(parseSessionRemoteDesktopLinks("{\"version\":2}").bySession, {});
});

test("session link lifecycle keeps openedAt and updates lastUsedAt", () => {
  const instanceId = `links-${Date.now()}`;
  const sessionId = "session-a";
  const storage = fakeStorage();
  rememberSessionRemoteDesktopLink({
    instanceId,
    sessionId,
    storage,
    at: 100,
    target: { kind: "display", title: "Desktop", subtitle: null, width: 1920, height: 1080 },
  });
  assert.equal(sessionRemoteDesktopLinkFor(instanceId, sessionId)?.openedAt, 100);
  assert.equal(sessionRemoteDesktopLinkFor(instanceId, sessionId)?.lastUsedAt, 100);
  touchSessionRemoteDesktopLink(instanceId, sessionId, 200);
  assert.equal(sessionRemoteDesktopLinkFor(instanceId, sessionId)?.openedAt, 100);
  assert.equal(sessionRemoteDesktopLinkFor(instanceId, sessionId)?.lastUsedAt, 200);
  removeSessionRemoteDesktopLink(instanceId, sessionId);
  assert.equal(sessionRemoteDesktopLinkFor(instanceId, sessionId), undefined);
});
