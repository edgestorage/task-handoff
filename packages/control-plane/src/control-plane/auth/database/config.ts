// Compatibility for v0.0.28: retain the auth-scoped import names while the
// database lifecycle is now owned by control-plane/persistence.
export {
  ControlPlaneDatabaseConfigSchema as ControlPlaneUserDatabaseConfigSchema,
  resolveControlPlaneDatabaseConfig as resolveControlPlaneUserDatabaseConfig,
  type ControlPlaneDatabaseConfig as ControlPlaneUserDatabaseConfig,
  type ControlPlaneDatabaseConfigInput as ControlPlaneUserDatabaseConfigInput,
} from "../../persistence/database/config.ts";
