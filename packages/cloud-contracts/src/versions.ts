export const OFFICIAL_ACCOUNT_API_PROTOCOL_VERSION = "2026-08-10";
export const CONTROL_PLANE_BINDING_PROTOCOL_VERSION = "2026-08-10";
export const CONTROL_PLANE_REGISTRATION_PROTOCOL_VERSION = "2026-10-18";
export const OUTBOUND_CONNECTION_PROTOCOL_VERSION = "2026-08-10";
export const RELAY_FRAMING_PROTOCOL_VERSION = "2026-08-10";

// Relay allocation leases are the one contractual value that spans both services:
// the Coordinator stamps it onto every attach capability, and the Relay refuses an
// attach whose remaining lease exceeds its own ceiling. If the ceiling falls below
// the issued lease the Relay rejects every allocation, so the two stay in this module.
export const RELAY_ALLOCATION_LEASE_MS = 10 * 60_000;
export const RELAY_MAX_ATTACH_LEASE_MS = 15 * 60_000;

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
export const RELAY_DEFAULT_MAX_CANDIDATES = 3;
export const RELAY_MAX_CANDIDATES = 5;
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
  ControlPlaneAccess: "task-handoff:control-plane-access",
});
