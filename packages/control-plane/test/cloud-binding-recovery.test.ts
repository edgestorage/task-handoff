import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CloudAccountSessionService } from "../src/control-plane/cloud-connectivity/account-session.ts";
import { CloudConnectivityBackgroundRuntime } from "../src/control-plane/cloud-connectivity/coordinator-runtime.ts";
import { CloudConnectivityService } from "../src/control-plane/cloud-connectivity/service.ts";
import { controlPlaneErrorPayload } from "../src/control-plane/http/server.ts";
import { ControlPlaneIdentityService } from "../src/control-plane/identity/service.ts";

for (const status of ["unbound", "pending-claim"] as const) {
  test(`${status}: a lost credential returns recovery guidance and sign-in works after remote unbinding`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-binding-recovery-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const serviceOrigin = "https://cloud.example.test";
    const identity = new ControlPlaneIdentityService(path.join(root, "identity.json"), () => "control_plane_recovery");
    identity.init();
    const state = new CloudConnectivityService({ statePath: path.join(root, "binding.json"), identity, serviceOrigin });
    state.init();
    if (status === "pending-claim") state.createChallenge();
    const accountSession = new CloudAccountSessionService({ statePath: path.join(root, "account.json"), serviceOrigin });
    accountSession.init();
    let remoteBindingExists = true;
    const registrations: any[] = [];
    const authorizationUrl = `${serviceOrigin}/authorize/control-plane?request=request_recovery`;

    class CoordinatorSocket extends EventEmitter {
      static OPEN = 1;
      readyState = CoordinatorSocket.OPEN;
      constructor() {
        super();
        queueMicrotask(() => this.emit("open"));
      }
      send(raw: string) {
        const message = JSON.parse(raw);
        if (message.type === "register") {
          registrations.push(message);
          // Compatibility for v0.0.46: Coordinator registration rejects via
          // the WebSocket close frame, without a structured RPC response.
          if (remoteBindingExists) return this.close(1008, "BACKGROUND_CREDENTIAL_REQUIRED");
          return this.receive({ type: "registered", controlPlaneId: "cp_cloud_recovery", reportedControlPlaneId: identity.publicIdentity().controlPlaneId, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() });
        }
        if (message.type === "request") {
          assert.equal(message.operation, "create-control-plane-request");
          this.receive({ type: "response", requestId: message.requestId, data: {
            requestId: "request_recovery", scope: message.payload.scope,
            authorizationUrl, expiresAt: new Date(Date.now() + 60_000).toISOString(),
          } });
        }
      }
      receive(message: unknown) { queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify(message)))); }
      close(code = 1000, reason = "") {
        this.readyState = 3;
        queueMicrotask(() => this.emit("close", code, Buffer.from(reason)));
      }
    }

    const runtime = new CloudConnectivityBackgroundRuntime({
      state, accountSession, identity, webSocket: CoordinatorSocket as any,
      coordinatorOrigins: ["https://alternate.example.test"],
    });
    try {
      for (const scope of ["account:sign-in", "control-plane:bind"] as const) {
        await assert.rejects(runtime.beginAccountRequest({ scope }), (error) => {
          const payload = controlPlaneErrorPayload(error);
          assert.equal(payload.statusCode, 409);
          assert.equal(payload.code, "CLOUD_REMOTE_BINDING_EXISTS");
          assert.equal(payload.retryable, false);
          assert.match(payload.message, /cloud platform.*disconnect or unbind.*sign in again/i);
          return true;
        });
        assert.equal(accountSession.snapshot().pendingRequest, undefined);
        assert.equal(state.snapshot().status, status);
      }
      assert.equal(registrations.length, 2, "a binding rejection must not fail over or cool down the origin");
      for (const message of registrations) {
        assert.equal(message.backgroundCredential, undefined);
        assert.equal(message.registration.reportedControlPlaneId, identity.publicIdentity().controlPlaneId);
      }

      remoteBindingExists = false;
      const request = await runtime.beginAccountRequest({ scope: "account:sign-in" });
      assert.equal(request.authorizationUrl, authorizationUrl);
      assert.equal(accountSession.snapshot().pendingRequest?.authorizationUrl, authorizationUrl);
      assert.equal(state.snapshot().hasBackgroundCredential, false);
      assert.equal(registrations.length, 3, "remote unbinding allows the next login without a process restart");
    } finally {
      await runtime.stop();
    }
  });
}
