export const OFFICIAL_ACCOUNT_API_PROTOCOL_VERSION = "2026-08-10";
export const CONTROL_PLANE_BINDING_PROTOCOL_VERSION = "2026-08-10";
export const OUTBOUND_CONNECTION_PROTOCOL_VERSION = "2026-08-10";
export const RELAY_FRAMING_PROTOCOL_VERSION = "2026-08-10";

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
