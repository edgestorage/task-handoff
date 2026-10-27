import assert from "node:assert/strict";
import test from "node:test";
import { TrustedDeviceSessionRegistry } from "../src/control-plane/device-trust/trusted-device-sessions.ts";

function recordingSession() {
  const reasons: string[] = [];
  return {
    reasons,
    close(reason: string) { reasons.push(reason); },
  };
}

test("a pin close after an active read prevents a late session registration", async () => {
  const registry = new TrustedDeviceSessionRegistry();
  const claim = registry.beginClaim();
  const session = recordingSession();

  await registry.closePin("devpin_one", 2, "device-trust-revoked");
  const unregister = registry.register("devpin_one", 1, claim, session);

  assert.equal(unregister, undefined);
  assert.deepEqual(session.reasons, []);
  assert.ok(registry.register("devpin_one", 3, registry.beginClaim(), session));
});

test("role-catalog invalidation blocks every claim taken before it", async () => {
  const registry = new TrustedDeviceSessionRegistry();
  const staleClaim = registry.beginClaim();
  const liveSession = recordingSession();
  const unregister = registry.register("devpin_live", 1, registry.beginClaim(), liveSession);
  assert.ok(unregister);

  await registry.closeAll("local-role-catalog-changed");
  assert.deepEqual(liveSession.reasons, ["local-role-catalog-changed"]);
  assert.equal(registry.register("devpin_late", 1, staleClaim, recordingSession()), undefined);
  assert.ok(registry.register("devpin_late", 1, registry.beginClaim(), recordingSession()));
});

test("closing one precise pin leaves another pin session alive", async () => {
  const registry = new TrustedDeviceSessionRegistry();
  const first = recordingSession();
  const second = recordingSession();
  registry.register("devpin_first", 1, registry.beginClaim(), first);
  registry.register("devpin_second", 1, registry.beginClaim(), second);

  await registry.closePin("devpin_first", 2, "device-trust-revoked");
  assert.deepEqual(first.reasons, ["device-trust-revoked"]);
  assert.deepEqual(second.reasons, []);
});
