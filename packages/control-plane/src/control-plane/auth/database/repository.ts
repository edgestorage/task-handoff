// Compatibility for v0.0.28: user-access imports keep working while the
// database repository contract is owned by control-plane/persistence.
export * from "../../persistence/database/repository.ts";
