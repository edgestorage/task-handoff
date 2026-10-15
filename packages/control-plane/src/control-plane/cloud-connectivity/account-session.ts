import { z } from "zod";
import { JsonFile } from "../../shared/persistence/store.ts";

// A Control Plane holds one Thandoff account session at a time. The refresh credential
// lives next to (but separate from) the binding credential: signing out of the account
// must not disturb an existing relay binding, and dropping a binding must not sign out.
const CloudAccountSessionStateSchema = z.object({
  version: z.literal(1),
  serviceOrigin: z.string().url(),
  status: z.enum(["signed-out", "pending", "signed-in"]),
  accountId: z.string().optional(),
  email: z.string().optional(),
  deviceSessionId: z.string().optional(),
  refreshCredential: z.string().min(32).optional(),
  sessionExpiresAt: z.string().datetime().optional(),
  pendingRequestId: z.string().optional(),
  pendingAuthorizationUrl: z.string().url().optional(),
  pendingScope: z.string().optional(),
  pendingExpiresAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime(),
}).strip();

export type CloudAccountSessionState = z.infer<typeof CloudAccountSessionStateSchema>;

export class CloudAccountSessionService {
  private readonly state: JsonFile<CloudAccountSessionState>;
  private readonly serviceOrigin: string;
  private readonly clock: () => number;

  constructor(options: { statePath: string; serviceOrigin: string; clock?: () => number }) {
    this.serviceOrigin = new URL(options.serviceOrigin).origin;
    this.clock = options.clock ?? Date.now;
    this.state = new JsonFile<CloudAccountSessionState>(options.statePath, () => ({
      version: 1, serviceOrigin: this.serviceOrigin, status: "signed-out", updatedAt: new Date(this.clock()).toISOString(),
    }), { schema: CloudAccountSessionStateSchema, directoryMode: 0o700, fileMode: 0o600 });
  }

  /**
   * An account session belongs to the cloud that issued it. Switching environments must
   * never leak a session across service origins, so a mismatch is discarded here.
   */
  init() {
    this.state.init();
    const current = this.state.get();
    if (current.serviceOrigin !== this.serviceOrigin) {
      this.state.put({ version: 1, serviceOrigin: this.serviceOrigin, status: "signed-out", updatedAt: new Date(this.clock()).toISOString() });
      return;
    }
    if (current.status !== "signed-out" && current.pendingExpiresAt && Date.parse(current.pendingExpiresAt) <= this.clock()) {
      this.state.put({ ...current, status: current.refreshCredential ? "signed-in" : "signed-out", pendingRequestId: undefined, pendingAuthorizationUrl: undefined, pendingScope: undefined, pendingExpiresAt: undefined, updatedAt: new Date(this.clock()).toISOString() });
    }
  }

  snapshot() {
    const current = this.state.get();
    // A signed-in Control Plane can hold a second in-flight request (binding after
    // sign-in flips the status to "pending"), so the credential — not the status —
    // decides whether the session is signed in.
    const signedIn = Boolean(current.refreshCredential);
    const pending = current.status === "pending" && current.pendingRequestId && current.pendingExpiresAt && Date.parse(current.pendingExpiresAt) > this.clock()
      ? { requestId: current.pendingRequestId, authorizationUrl: current.pendingAuthorizationUrl, scope: current.pendingScope, expiresAt: current.pendingExpiresAt }
      : undefined;
    return {
      signedIn,
      accountId: signedIn ? current.accountId : undefined,
      email: signedIn ? current.email : undefined,
      sessionExpiresAt: signedIn ? current.sessionExpiresAt : undefined,
      pendingRequest: pending,
    };
  }

  refreshCredential() {
    const current = this.state.get();
    return current.refreshCredential;
  }

  /** Full credential set for rotation; never exposed to the browser. */
  credentials() {
    const current = this.state.get();
    if (!current.refreshCredential) return undefined;
    return { accountId: current.accountId, email: current.email, deviceSessionId: current.deviceSessionId, refreshCredential: current.refreshCredential, sessionExpiresAt: current.sessionExpiresAt };
  }

  get origin() { return this.serviceOrigin; }

  pendingRequest() {
    return this.snapshot().pendingRequest;
  }

  beginRequest(input: { requestId: string; authorizationUrl: string; scope: string; expiresAt: string }) {
    const current = this.state.get();
    this.state.put({
      ...current, status: "pending", pendingRequestId: input.requestId, pendingAuthorizationUrl: input.authorizationUrl,
      pendingScope: input.scope, pendingExpiresAt: input.expiresAt, updatedAt: new Date(this.clock()).toISOString(),
    });
    return this.snapshot();
  }

  complete(input: { accountId: string; email?: string; deviceSessionId: string; refreshCredential: string; sessionExpiresAt?: string }, options: { preservePending?: boolean } = {}) {
    const current = this.state.get();
    this.state.put({
      version: 1, serviceOrigin: current.serviceOrigin, status: "signed-in",
      accountId: input.accountId, email: input.email ?? current.email, deviceSessionId: input.deviceSessionId,
      refreshCredential: input.refreshCredential, sessionExpiresAt: input.sessionExpiresAt,
      // Credential rotation must not cancel an unrelated in-flight request (a binding
      // approval waiting while the refresh credential rotates); a delivered credential
      // always resolves the request it answers, so it clears by default.
      ...(options.preservePending ? {
        status: current.status, pendingRequestId: current.pendingRequestId, pendingAuthorizationUrl: current.pendingAuthorizationUrl,
        pendingScope: current.pendingScope, pendingExpiresAt: current.pendingExpiresAt,
      } : {}),
      updatedAt: new Date(this.clock()).toISOString(),
    });
    return this.snapshot();
  }

  /** Records the browser decision so the UI stops showing an in-flight request. */
  resolveRequest(input: { requestId: string; status: "denied" | "expired" | "delivered" }) {
    const current = this.state.get();
    if (current.pendingRequestId !== input.requestId) return this.snapshot();
    const signedIn = Boolean(current.refreshCredential);
    this.state.put({
      ...current, status: signedIn ? "signed-in" : "signed-out",
      pendingRequestId: undefined, pendingAuthorizationUrl: undefined, pendingScope: undefined, pendingExpiresAt: undefined,
      updatedAt: new Date(this.clock()).toISOString(),
    });
    return this.snapshot();
  }

  signOut() {
    const current = this.state.get();
    this.state.put({ version: 1, serviceOrigin: current.serviceOrigin, status: "signed-out", updatedAt: new Date(this.clock()).toISOString() });
    return this.snapshot();
  }

  hasPendingRequest() {
    return Boolean(this.snapshot().pendingRequest);
  }
}
