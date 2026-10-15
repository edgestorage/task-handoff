export const OFFICIAL_ACCOUNT_API_PROTOCOL_VERSION = "2026-08-10";
export const CONTROL_PLANE_BINDING_PROTOCOL_VERSION = "2026-08-10";
export const OUTBOUND_CONNECTION_PROTOCOL_VERSION = "2026-08-10";
export const RELAY_FRAMING_PROTOCOL_VERSION = "2026-08-10";

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
  RelayRevocation: "task-handoff:relay-revocation",
  ControlPlaneAccess: "task-handoff:control-plane-access",
});
