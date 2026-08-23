// Authentication now has one user-account authority. This module remains the
// Stable server import path for the single user-account authentication authority.
export {
  CONTROL_PLANE_SESSION_COOKIE,
  ControlPlaneAuth,
  ControlPlaneAuthModeSchema,
  type ControlPlaneAuthMode,
  type ControlPlaneAuthOptions,
} from "./runtime-service.ts";
