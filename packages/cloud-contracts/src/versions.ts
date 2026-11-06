export const OFFICIAL_ACCOUNT_API_PROTOCOL_VERSION = "2026-08-10";
export const MOBILE_REFRESH_RECOVERY_PROTOCOL_VERSION = "2026-10-30";
export const CONTROL_PLANE_BINDING_PROTOCOL_VERSION = "2026-08-10";
export const CONTROL_PLANE_REGISTRATION_PROTOCOL_VERSION = "2026-10-25";
export const OUTBOUND_CONNECTION_PROTOCOL_VERSION = "2026-10-25";
export const RELAY_FRAMING_PROTOCOL_VERSION = "2026-10-25";
export const RELAY_SESSION_PROTOCOL_VERSION = "2026-10-25";
export const NODE_RELAY_CONTROL_PROTOCOL_VERSION = "2026-11-01";

// Relay allocation leases are the one contractual value that spans both services:
// the Coordinator stamps it onto every attach capability, and the Relay refuses an
// attach whose remaining lease exceeds its own ceiling. If the ceiling falls below
// the issued lease the Relay rejects every allocation, so the two stay in this module.
export const RELAY_ALLOCATION_LEASE_MS = 10 * 60_000;
export const RELAY_MAX_ATTACH_LEASE_MS = 15 * 60_000;

// Session grants extend the channel independently of the short initial attach
// capability. These are Coordinator defaults, not wire lifetime ceilings; clients
// schedule from the signed grant and Relay retains state through its expiresAt.
export const RELAY_SESSION_GRANT_TTL_MS = 60 * 60_000;
// Compatibility for mobile-v0.0.12 / runtime v0.0.49: strict old readers accept
// neither the policy field nor grants lasting longer than fifteen minutes.
export const RELAY_SESSION_LEGACY_GRANT_TTL_MS = 15 * 60_000;
export const RELAY_SESSION_LEGACY_REFRESH_INTERVAL_MS = 10 * 60_000;
export const RELAY_SESSION_POLICY_CAPABILITY = "relay-session-policy-v1";
export const RELAY_SESSION_MIN_GRANT_TTL_MS = 60_000;
export const RELAY_SESSION_REFRESH_INTERVAL_MS = 20 * 60_000;
export const RELAY_SESSION_RENEWAL_LEAD_MS = 5_000;
export const RELAY_SESSION_MAX_E2E_AGE_MS = 60 * 60_000;
export const RELAY_SESSION_PROOF_WINDOW_MS = 30_000;
// Historical signed revocations persisted by cloud v0.1.15 cannot be re-signed
// during reads. Accept their original lifetime; new producers retain revocations
// through the actual expiry of every revoked grant.
export const RELAY_REVOCATION_MIN_VALIDITY_MS = 15 * 60_000;
export const RELAY_SESSION_RESUME_CAPABILITY = "relay-session-resume-v1";
export const RELAY_SESSION_REQUIRED_CAPABILITIES = Object.freeze([RELAY_SESSION_RESUME_CAPABILITY] as const);
export const RELAY_SESSION_NOT_READY_CODE = "RELAY_SESSION_RESUME_NOT_READY";

// Node relay channels are long-lived: a node agent holds one channel per claiming
// Control Plane instead of rotating short tickets, so the default lease is half a
// day and the global ceiling is a day. The Coordinator stamps the issued lease and
// the Relay refuses anything above its own ceiling, exactly like the access pair.
export const RELAY_NODE_ALLOCATION_LEASE_MS = 12 * 60 * 60_000;
export const RELAY_MAX_NODE_ATTACH_LEASE_MS = 24 * 60 * 60_000;

// A selection is a short-lived invitation to evaluate several Relays and confirm
// exactly one winner. It only has to outlive a client's probe budget, and every
// second it stays open is another second of unredeemed attach capabilities.
export const RELAY_SELECTION_TTL_MS = 15_000;
export const RELAY_DEFAULT_MAX_CANDIDATES = 10;
export const RELAY_MAX_CANDIDATES = 10;
// Older control-plane link hints are still returned so a client can down-weight
// them, but they are never silently refreshed or hidden.
export const RELAY_CP_HINT_FRESHNESS_MS = 90_000;

export const OfficialAudience = Object.freeze({
  AccountApi: "task-handoff:official-account-api",
  Binding: "task-handoff:control-plane-binding",
  CoordinatorControl: "task-handoff:coordinator-control",
  RelayAllocation: "task-handoff:relay-allocation",
  RelayClientAttach: "task-handoff:relay-client-attach",
  RelayControlPlaneAttach: "task-handoff:relay-control-plane-attach",
  RelayNodeAgentAttach: "task-handoff:relay-node-agent-attach",
  RelayNodeClaimGrant: "task-handoff:relay-node-claim-grant",
  RelayRevocation: "task-handoff:relay-revocation",
  RelayRevocationSync: "task-handoff:relay-revocation-sync",
  RelaySessionGrant: "task-handoff:relay-session-grant",
  RelaySessionTranscript: "task-handoff:relay-session-transcript",
  ControlPlaneAccess: "task-handoff:control-plane-access",
});

export const RelaySessionAudience = Object.freeze({
  Grant: "task-handoff:relay-session-grant",
  Transcript: "task-handoff:relay-session-transcript",
  RevocationSync: "task-handoff:relay-revocation-sync",
});
